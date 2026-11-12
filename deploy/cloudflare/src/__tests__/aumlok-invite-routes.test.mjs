/** Offline Worker -> HeadDO -> AUMLOK routes using synthetic signed state only. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { isoCBOR } from '@simplewebauthn/server/helpers'
import { AUMLOK_STORAGE_KEY, aumlokInvitePreimage } from '../aumlok.mjs'
import { X61HeadDurableObject, bootstrapPackage, digest, manifestIdCanon } from '../head-do.mjs'
import { createWorker } from '../worker.mjs'

const ORIGIN = 'https://invite-routes.example.invalid'
const OWNER = 'owner@example.invalid'
const b64 = (size, value) => Buffer.alloc(size, value).toString('base64url')
const keyHex = key => key.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex')
function memoryStorage() {
  let rows = new Map(), tail = Promise.resolve()
  const view = map => ({ get: async key => structuredClone(map.get(key)), put: async (key, value) => { map.set(key, structuredClone(value)) },
    delete: async key => map.delete(key), list: async ({ prefix = '', limit = Infinity } = {}) => new Map([...map].filter(([key]) => key.startsWith(prefix)).slice(0, limit)),
    getAlarm: async () => null, setAlarm: async () => {}, deleteAlarm: async () => {} })
  const storage = Object.fromEntries(['get', 'put', 'delete', 'list', 'getAlarm', 'setAlarm', 'deleteAlarm'].map(method => [method, (...args) => view(rows)[method](...args)]))
  storage.transaction = operation => {
    const result = tail.then(async () => { const copy = structuredClone(rows), result = await operation(view(copy)); rows = copy; return result })
    tail = result.catch(() => undefined)
    return result
  }
  return storage
}
async function fixture() {
  const at = Date.now(), storage = memoryStorage(), node = generateKeyPairSync('ed25519')
  const passkey = generateKeyPairSync('ec', { namedCurve: 'P-256' }), jwk = passkey.publicKey.export({ format: 'jwk' })
  const code = b64(32, 21), payload = { schema: 'aukora.invite.v1', inviteId: b64(32, 22), sponsorPubkeyHex: keyHex(node),
    inviteeCommitmentSha256: createHash('sha256').update('aukora.invite.invitee.v1\0').update(Buffer.from(code, 'base64url')).digest('hex'),
    assignedDomainPointer: null, quotaMonth: new Date(at).toISOString().slice(0, 7), monthlySequence: 1, revoked: false, issuedAt: at, expiresAt: at + 604800000 }
  const invite = { ...payload, signature: sign(null, Buffer.from(aumlokInvitePreimage(payload)), node.privateKey).toString('base64url') }
  const identity = { schema: 'aukora.aumlok.state.v2', generation: 1,
    binding: { aumlokId: 'a'.repeat(64), recoveryCommitment: 'b'.repeat(64), nodePubkeyHex: keyHex(node),
      rootEscrow: { schema: 'aukora.aumlok.escrow.v2', ivB64: b64(12, 1), ciphertextB64: b64(48, 2) },
      credential: { id: b64(32, 3), counter: 0, publicKeyB64: Buffer.from(isoCBOR.encode(new Map([
        [1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')],
      ]))).toString('base64url') }, boundAt: at, lastVerifiedAt: at, generation: 1 },
    'pepper.v1': b64(32, 4), challenges: [], invites: [invite], revocations: [], failures: 0, failedAt: [], nextAllowedAt: 0, attempts: [], approvals: [] }
  const env = { PUBLIC_HOST: new URL(ORIGIN).host, OWNER_EMAIL: OWNER, OWNER_PUBLIC_KEY_HEX: 'e'.repeat(64),
    ACCESS_TEAM: 'fixture.cloudflareaccess.com', ACCESS_AUD: 'fixture-audience' }
  const noNetwork = async () => { throw new Error('Network forbidden in invite route fixture') }
  const head = new X61HeadDurableObject({ storage, getWebSockets: () => [] }, env, { networkFetch: noNetwork })
  const source = 'export const fixture = true;', sha = await digest(source)
  const draft = { version: 'x6.1-ball/v1', epoch: 1, parentBallId: null, authorPeerId: 'fixture-peer',
    entries: { fixture: { id: 'fixture', specifier: `ball:${sha}`, disabled: false, config: {}, previousSpecifiers: [] } },
    modules: { [sha]: { sha256: sha, specifier: `ball:${sha}` } } }
  const ball = { ...draft, ballId: await manifestIdCanon(draft) }
  const seed = await bootstrapPackage({ version: 'x61-bootstrap/v1', ball, codeBySha: { [sha]: source }, mirror: { entryCount: 0, batchDigests: [] } })
  const mirror = { ok: true, phase: 'ready', seedId: seed.seedId, ballId: ball.ballId, epoch: 1, entryCount: 0, nextBatch: 0, batchCount: 0 }
  assert.equal((await head.store.bootstrapPrepare(seed)).ok, true)
  assert.equal((await head.store.bootstrapCommit(seed.seedId, mirror)).ok, true)
  await storage.put(AUMLOK_STORAGE_KEY, identity)
  const calls = { head: 0, mirror: 0, invites: 0, redeem: 0, status: 0 }
  const store = head.aumlokStore
  head.aumlokStore = { ...store, ...Object.fromEntries(['invites', 'redeem', 'status'].map(method => [method, (...args) => {
    calls[method]++; return store[method](...args)
  }])) }
  env.HEAD = { idFromName: value => value, get: () => ({ fetch: request => { calls.head++; return head.fetch(request) } }) }
  env.MIRROR = { idFromName: value => value, get: () => ({ fetch: async request => {
    calls.mirror++; assert.equal(new URL(request.url).pathname, '/_mirror/bootstrap-status'); return Response.json(mirror)
  } }) }
  let access = { type: 'owner', email: OWNER, expires: Math.floor(at / 1000) + 3600 }
  const worker = createWorker({ verifyAccess: async () => access, networkFetch: noNetwork })
  const request = (action, { method = action === 'redeem' ? 'POST' : 'GET', body, headers = {} } = {}) => new Request(`${ORIGIN}/_host/aumlok/${action}`, {
    method, headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin', ...(method === 'POST' ? { 'content-type': 'application/json' } : {}), ...headers },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  })
  const call = async (action, options) => { const response = await worker.fetch(request(action, options), env); return { response, body: await response.json() } }
  return { storage, identity, invite, code, calls, head, request, call, setAccess: value => { access = value } }
}

test('integration: bodyless GET invites and status return verified receipts and nested lifetime count', async () => {
  const fx = await fixture()
  const listed = await fx.call('invites')
  assert.equal(listed.response.status, 200, JSON.stringify(listed.body))
  assert.deepEqual(listed.body, { ok: true, schema: 'aukora.invite-list.v1', invites: [fx.invite], revocations: [], lifetimeIssuedCount: 1 })
  assert.equal(listed.response.headers.get('cache-control'), 'no-store')
  assert.equal(fx.calls.invites, 1)
  const status = await fx.call('status')
  assert.equal(status.response.status, 200)
  assert.equal(status.body.invite.lifetimeIssuedCount, 1)
  assert.equal(fx.calls.status, 1)
  assert.deepEqual(await fx.storage.get(AUMLOK_STORAGE_KEY), fx.identity)
})

test('integration: authenticated POST redeem verifies possession without granting authority or persisting code', async () => {
  const fx = await fixture()
  fx.setAccess({ type: 'access', email: 'recipient@example.invalid', expires: Date.now() / 1000 + 3600 })
  const result = await fx.call('redeem', { body: { invite: fx.invite, code: fx.code } })
  assert.equal(result.response.status, 200, JSON.stringify(result.body))
  assert.equal(fx.calls.redeem, 1)
  assert.equal(result.body.recipientStatus, 'CODE_VERIFIED')
  for (const field of ['accessGranted', 'identityEnrolled', 'inviteConsumed']) assert.equal(result.body[field], false)
  assert.equal(result.body.freshness, 'LOCAL_DURABLE_STATE_ONLY')
  assert.deepEqual(result.body.guestAccess, { available: false, code: 'GUEST_ACCESS_UNAVAILABLE' })
  assert.equal(result.response.headers.has('set-cookie'), false)
  for (const field of ['approvalToken', 'token', 'credential', 'code']) assert.equal(Object.hasOwn(result.body, field), false)
  assert.deepEqual(await fx.storage.get(AUMLOK_STORAGE_KEY), fx.identity)
})

test('Worker gates: unauthenticated invite reads and malformed guest redemptions stop before durable fanout', async () => {
  const fx = await fixture(); fx.setAccess(null)
  const listed = await fx.call('invites')
  assert.equal(listed.response.status, 401)
  assert.equal(fx.calls.head + fx.calls.mirror, 0)
  // Redemption is the one guest door (guest-redeem-door.test.mjs); a request that is not a same-origin JSON POST stops
  // before any durable call, and its descriptor read touches no durable state.
  for (const [options, status] of [[{ headers: { origin: 'https://elsewhere.example.invalid' }, body: {} }, 403],
    [{ headers: { 'sec-fetch-site': 'cross-site' }, body: {} }, 403], [{ headers: { 'content-type': 'text/plain' }, body: {} }, 400],
    [{ method: 'PUT', body: {} }, 405], [{ method: 'GET' }, 200]]) {
    const result = await fx.call('redeem', options)
    assert.equal(result.response.status, status, JSON.stringify(result.body))
    assert.equal(fx.calls.head + fx.calls.mirror, 0)
  }
})

test('Worker gates: non-owner, mismatched-owner, and expired-owner invite reads stop before fanout', async () => {
  for (const access of [{ type: 'access', email: OWNER, expires: Date.now() / 1000 + 3600 },
    { type: 'owner', email: 'other@example.invalid', expires: Date.now() / 1000 + 3600 },
    { type: 'owner', email: OWNER, expires: 1 }]) {
    const fx = await fixture(); fx.setAccess(access)
    const result = await fx.call('invites')
    assert.equal(result.response.status, 403)
    assert.equal(fx.calls.head + fx.calls.mirror, 0)
  }
})

test('Worker gates: cross-origin and cross-site invite operations stop before fanout', async () => {
  for (const action of ['invites', 'redeem']) for (const headers of [{ origin: 'https://other.example.invalid' }, { 'sec-fetch-site': 'cross-site' }]) {
    const fx = await fixture()
    const result = await fx.call(action, { headers, ...(action === 'redeem' ? { body: {} } : {}) })
    assert.equal(result.response.status, 403)
    assert.equal(fx.calls.head + fx.calls.mirror, 0)
  }
})

test('Worker gates: query, wrong method, and declared GET body stop before fanout', async () => {
  for (const [action, options, status] of [['invites?limit=1', {}, 404], ['redeem?test=1', { method: 'POST', body: {} }, 404],
    ['invites', { method: 'POST', body: {} }, 405], ['redeem', { method: 'GET' }, 405],
    ['invites', { headers: { 'content-length': '1' } }, 400]]) {
    const fx = await fixture(), result = await fx.call(action, options)
    assert.equal(result.response.status, status, JSON.stringify(result.body))
    assert.equal(fx.calls.head + fx.calls.mirror, 0)
  }
})

test('integration: HEAD rejects oversized, malformed, and non-JSON redemption before store dispatch', async () => {
  for (const [options, status] of [[{ body: JSON.stringify({ padding: 'x'.repeat(32769) }) }, 413],
    [{ body: '{' }, 400], [{ body: '{}', headers: { 'content-type': 'text/plain' } }, 400]]) {
    const fx = await fixture(), result = await fx.call('redeem', options)
    assert.equal(result.response.status, status, JSON.stringify(result.body))
    assert.equal(fx.calls.redeem, 0)
    assert.deepEqual(await fx.storage.get(AUMLOK_STORAGE_KEY), fx.identity)
  }
})

test('integration: direct HEAD requests without internal authorization never reach the invite store', async () => {
  const fx = await fixture(), response = await fx.head.fetch(fx.request('invites'))
  assert.equal(response.status, 401)
  assert.equal(fx.calls.invites, 0)
})


test('integration: repeated redemption never emits a session or Class 3 bearer', async () => {
  const fx = await fixture()
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = await fx.call('redeem', { body: { invite: fx.invite, code: fx.code } })
    assert.equal(result.response.status, 200)
    assert.equal(result.response.headers.get('set-cookie'), null)
    assert.deepEqual(result.body.guestAccess, { available: false, code: 'GUEST_ACCESS_UNAVAILABLE' })
    for (const field of ['accessGranted', 'identityEnrolled', 'inviteConsumed']) assert.equal(result.body[field], false)
    for (const field of ['approvalToken', 'token', 'credential', 'code']) assert.equal(Object.hasOwn(result.body, field), false)
    assert.deepEqual(await fx.storage.get(AUMLOK_STORAGE_KEY), fx.identity)
  }
})

test('integration: invalid redemption stays non-authorizing and leaves identity unchanged', async () => {
  const fx = await fixture()
  for (const body of [{ invite: fx.invite, code: 'alpha bravo charlie delta echo foxtrot golf' },
    { invite: fx.invite, code: fx.code, role: 'owner' }, { invite: fx.invite, code: b64(32, 99) }]) {
    const result = await fx.call('redeem', { body })
    assert.ok([400, 403].includes(result.response.status), JSON.stringify(result.body))
    assert.equal(result.response.headers.get('set-cookie'), null)
    assert.equal(Object.hasOwn(result.body, 'approvalToken'), false)
    assert.deepEqual(await fx.storage.get(AUMLOK_STORAGE_KEY), fx.identity)
  }
})
