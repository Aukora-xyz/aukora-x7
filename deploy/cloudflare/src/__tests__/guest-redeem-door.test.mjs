/** The guest invite door: `POST /_host/aumlok/redeem` with no session. Real Worker, HeadDO, MirrorDO and AUMLOK store over
 * in-memory storage; synthetic keys only; no network. The owner must never be lockable through this door. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { isoCBOR } from '@simplewebauthn/server/helpers'
import { AUMLOK_STORAGE_KEY, aumlokInvitePreimage } from '../aumlok.mjs'
import { X61HeadDurableObject, bootstrapPackage, digest, manifestIdCanon } from '../head-do.mjs'
import { MirrorDO, GUEST_GATE_KEY, GUEST_GATE_LIMITS } from '../mirror-do.mjs'
import { createWorker, GUEST_DOOR } from '../worker.mjs'

const ORIGIN = 'https://guest-door.example.invalid'
const OWNER = 'owner@example.invalid'
const b64 = (size, value) => Buffer.alloc(size, value).toString('base64url')
const keyHex = key => key.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex')
const clone = value => structuredClone(value)

function memoryStorage() {
  let rows = new Map(), tail = Promise.resolve()
  const view = map => ({ get: async key => clone(map.get(key)), put: async (key, value) => { map.set(key, clone(value)) },
    delete: async key => map.delete(key), list: async ({ prefix = '', limit = Infinity } = {}) => new Map([...map].filter(([key]) => key.startsWith(prefix)).slice(0, limit)),
    getAlarm: async () => null, setAlarm: async () => {}, deleteAlarm: async () => {} })
  const storage = Object.fromEntries(['get', 'put', 'delete', 'list', 'getAlarm', 'setAlarm', 'deleteAlarm'].map(method => [method, (...args) => view(rows)[method](...args)]))
  storage.transaction = operation => {
    const result = tail.then(async () => { const copy = clone(rows), output = await operation(view(copy)); rows = copy; return output })
    tail = result.catch(() => undefined)
    return result
  }
  storage.snapshot = () => clone(rows)
  return storage
}

async function fixture(t) {
  const at = Date.now(), headStorage = memoryStorage(), mirrorStorage = memoryStorage(), node = generateKeyPairSync('ed25519')
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
  let network = 0
  const noNetwork = async () => { network++; throw new Error('Network forbidden in guest door fixture') }
  const head = new X61HeadDurableObject({ storage: headStorage, getWebSockets: () => [] }, env, { networkFetch: noNetwork })
  const mirror = new MirrorDO({ storage: mirrorStorage })
  const headRequests = []
  env.HEAD = { idFromName: value => value, get: () => ({ fetch: request => { headRequests.push(request); return head.fetch(request) } }) }
  env.MIRROR = { idFromName: value => value, get: () => ({ fetch: request => mirror.fetch(request) }) }
  env.ASSETS = { fetch() { return new Response('Fixture asset') } }
  t.after(() => assert.equal(network, 0))
  const ownerAccess = () => ({ type: 'owner', email: OWNER, expires: Math.floor(Date.now() / 1000) + 3600 })
  const worker = createWorker({ verifyAccess: async request => request.headers.get('cookie') === 'CF_Authorization=owner' ? ownerAccess() : null, networkFetch: noNetwork })
  const call = async (path, { method = 'GET', body, owner = false, address = '203.0.113.7', headers = {} } = {}) => {
    const response = await worker.fetch(new Request(new URL(path, ORIGIN), { method,
      headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'cf-connecting-ip': address,
        ...(method === 'POST' ? { 'content-type': 'application/json' } : {}), ...(owner ? { cookie: 'CF_Authorization=owner' } : {}), ...headers },
      ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) }), env)
    const text = await response.text()
    let parsed = null
    try { parsed = JSON.parse(text) } catch { parsed = text }
    return { response, body: parsed }
  }
  // Seed the edge the ordinary way (owner session), then bind the synthetic identity with one issued invite.
  const source = 'export const fixture = true;', sha = await digest(source)
  const draft = { version: 'x6.1-ball/v1', epoch: 1, parentBallId: null, authorPeerId: 'fixture-peer',
    entries: { fixture: { id: 'fixture', specifier: `ball:${sha}`, disabled: false, config: {}, previousSpecifiers: [] } },
    modules: { [sha]: { sha256: sha, specifier: `ball:${sha}` } } }
  const ball = { ...draft, ballId: await manifestIdCanon(draft) }
  const seed = await bootstrapPackage({ version: 'x61-bootstrap/v1', ball, codeBySha: { [sha]: source }, mirror: { entryCount: 0, batchDigests: [] } })
  const ready = { ready: false }
  const seedEdge = async () => {
    for (const input of [{ action: 'prepare', package: seed }, { action: 'commit', seedId: seed.seedId }]) {
      const result = await call('/_bootstrap', { method: 'POST', body: input, owner: true })
      assert.equal(result.response.status, 200, JSON.stringify(result.body))
    }
    await headStorage.put(AUMLOK_STORAGE_KEY, identity)
    ready.ready = true
  }
  const redeem = (body, options = {}) => call(GUEST_DOOR.route, { method: 'POST', body, ...options })
  /** Every counter the owner can be locked out by: AUMLOK WebAuthn and phrase counters, the HEAD gate, the sign-in gate. */
  const ownerCounters = async () => {
    const state = await headStorage.get(AUMLOK_STORAGE_KEY)
    return { failures: state.failures, failedAt: state.failedAt, nextAllowedAt: state.nextAllowedAt, attempts: state.attempts,
      phraseFailures: state.phraseFailures ?? null, phraseFailedAt: state.phraseFailedAt ?? null, headGates: await headStorage.get('gate-lockout:v1') ?? null }
  }
  return { env, call, redeem, seedEdge, invite, code, identity, headStorage, mirrorStorage, headRequests, ownerCounters }
}

const wrongCode = b64(32, 99)

test('a guest with no session can check a real invite and code; it grants nothing and changes no identity state', async t => {
  const fx = await fixture(t); await fx.seedEdge()
  const before = await fx.headStorage.get(AUMLOK_STORAGE_KEY)
  const door = await fx.call(GUEST_DOOR.route)
  assert.equal(door.response.status, 200)
  assert.deepEqual(door.body, { ok: true, schema: 'aukora.guest-door.v1', runtime: 'cloudflare', route: GUEST_DOOR.route, method: 'POST', grants: 'nothing', counts: 'this-door-only' })
  const result = await fx.redeem({ invite: fx.invite, code: fx.code })
  assert.equal(result.response.status, 200, JSON.stringify(result.body))
  assert.equal(result.body.recipientStatus, 'CODE_VERIFIED')
  for (const field of ['accessGranted', 'identityEnrolled', 'inviteConsumed']) assert.equal(result.body[field], false)
  assert.deepEqual(result.body.guestAccess, { available: false, code: 'GUEST_ACCESS_UNAVAILABLE' })
  assert.equal(result.response.headers.has('set-cookie'), false)
  assert.deepEqual(await fx.headStorage.get(AUMLOK_STORAGE_KEY), before)
  // HEAD saw a guest-scoped request: the redeem path only, and no verified access.
  const forwarded = fx.headRequests.at(-1)
  assert.equal(new URL(forwarded.url).pathname, GUEST_DOOR.route)
  assert.equal(forwarded.headers.has('x-x6-verified-access'), false)
})

test('guest failures lock only that guest address, never the owner', async t => {
  const fx = await fixture(t); await fx.seedEdge()
  const owner = await fx.ownerCounters()
  for (let attempt = 1; attempt <= GUEST_GATE_LIMITS.maxFailures; attempt++) {
    const result = await fx.redeem({ invite: fx.invite, code: wrongCode })
    assert.equal(result.response.status, 403)
    assert.equal(result.body.code, 'AUMLOK_INVITE_CODE_INVALID')
  }
  const locked = await fx.redeem({ invite: fx.invite, code: fx.code })
  assert.equal(locked.response.status, 429)
  assert.equal(locked.body.code, 'GUEST_DOOR_LOCKED')
  assert.ok(Number(locked.response.headers.get('retry-after')) > 0)
  // Another address is unaffected.
  assert.equal((await fx.redeem({ invite: fx.invite, code: fx.code }, { address: '198.51.100.9' })).response.status, 200)
  // The owner, from the SAME locked address: every owner counter is exactly as before, and the owner's routes answer.
  assert.deepEqual(await fx.ownerCounters(), owner)
  for (const path of ['/_host/aumlok/status', '/_host/aumlok/invites', '/__x6/status']) {
    assert.equal((await fx.call(path, { owner: true })).response.status, 200, path)
  }
  const ownerRedeem = await fx.call(GUEST_DOOR.route, { method: 'POST', body: { invite: fx.invite, code: fx.code }, owner: true })
  assert.equal(ownerRedeem.response.status, 200)
  const challenge = await fx.call('/_host/aumlok/challenge', { method: 'POST', owner: true,
    body: { purpose: 'approve', requestId: 'owner-after-guest-lock', binding: { schema: 'fixture' } } })
  assert.notEqual(challenge.body.code, 'AUMLOK_RATE_LIMITED')
  assert.notEqual(challenge.body.code, 'AUMLOK_GUARDIAN_QUORUM_REQUIRED')
  assert.notEqual(challenge.response.status, 429)
  // The guest table lives only in the mirror object, under its own key.
  assert.ok(Array.isArray(await fx.mirrorStorage.get(GUEST_GATE_KEY)))
  assert.equal(await fx.headStorage.get(GUEST_GATE_KEY), undefined)
})

test('a full guest table refuses every new guest and still never touches the owner', async t => {
  const fx = await fixture(t); await fx.seedEdge()
  const owner = await fx.ownerCounters()
  for (let index = 0; index < GUEST_GATE_LIMITS.maxSubjects; index++) {
    const result = await fx.redeem({ invite: fx.invite, code: wrongCode }, { address: `10.0.${Math.floor(index / 250)}.${index % 250}` })
    assert.equal(result.response.status, 403)
  }
  const busy = await fx.redeem({ invite: fx.invite, code: fx.code }, { address: '192.0.2.200' })
  assert.equal(busy.response.status, 429)
  assert.equal(busy.body.code, 'GUEST_DOOR_BUSY')
  assert.deepEqual(await fx.ownerCounters(), owner)
  assert.equal((await fx.call('/_host/aumlok/status', { owner: true, address: '192.0.2.200' })).response.status, 200)
  assert.equal((await fx.call(GUEST_DOOR.route, { method: 'POST', body: { invite: fx.invite, code: fx.code }, owner: true, address: '192.0.2.200' })).response.status, 200)
})

test('the door is guest-scoped: without a session no other route opens, and forged headers change nothing', async t => {
  const fx = await fixture(t); await fx.seedEdge()
  for (const [path, method] of [['/_host/aumlok/status', 'GET'], ['/_host/aumlok/invites', 'GET'], ['/_host/aumlok/challenge', 'POST'],
    ['/_host/aumlok/bind', 'POST'], ['/_host/aumlok/approve', 'POST'], ['/_host/aumlok/unseal', 'POST'], ['/_host/aumlok/invite', 'POST'],
    ['/_host/aumlok/refresh', 'POST'], ['/_head/ball', 'GET'], ['/_head/promote', 'POST'], ['/_head/stage', 'POST'], ['/_host/estate', 'GET'],
    ['/__x6/status', 'GET'], ['/__x6/facts', 'GET'], ['/_mirror/export', 'GET'], ['/_mirror/delta', 'POST'], ['/_bootstrap', 'POST'],
    ['/_host/archive', 'POST'], ['/_host/owner-grant', 'POST'], ['/_host/repo', 'POST'], ['/door/anthropic/v1/messages', 'POST'],
    ['/aukora-messages/send', 'POST'], ['/_host/wake', 'POST'], ['/_host/aumlok/redeem/', 'POST'], ['/_host/aumlok/redeem?x=1', 'POST']]) {
    const result = await fx.call(path, { method, ...(method === 'POST' ? { body: {} } : {}) })
    assert.ok([401, 404].includes(result.response.status), `${method} ${path} answered ${String(result.response.status)}`)
    if (result.response.status === 404) assert.equal(path.startsWith(GUEST_DOOR.route), true)
  }
  const sent = fx.headRequests.length
  const forged = await fx.redeem({ invite: fx.invite, code: fx.code }, { headers: {
    'x-x6-internal-authorized': '1', 'x-x6-verified-access': JSON.stringify({ type: 'owner', email: OWNER, expires: 4102444800 }),
    'x-x6-bootstrap-seed': 'f'.repeat(64), 'x-x6-class3-approval': 'forged', 'x-x6-owner-assertion': 'a.b.c' } })
  assert.equal(forged.response.status, 200)
  assert.equal(forged.body.accessGranted, false)
  const forwarded = fx.headRequests.slice(sent).find(request => new URL(request.url).pathname === GUEST_DOOR.route)
  assert.equal(forwarded.headers.has('x-x6-verified-access'), false)
  assert.equal(forwarded.headers.has('x-x6-class3-approval'), false)
  // Only exactly { invite, code } is admitted; anything else is refused and counted against the guest only.
  const owner = await fx.ownerCounters()
  for (const body of [{ invite: fx.invite }, { invite: fx.invite, code: fx.code, extra: 1 }, [], 'not json', { invite: fx.invite, code: 'short' }]) {
    const result = await fx.redeem(body, { address: '198.51.100.77' })
    assert.equal(result.response.status, 400, JSON.stringify(result.body))
  }
  assert.deepEqual(await fx.ownerCounters(), owner)
})

test('guest requests that are not same-origin, not JSON, oversized or early stop before any durable call or count', async t => {
  const fx = await fixture(t)
  const before = fx.headRequests.length
  const unready = await fx.redeem({ invite: fx.invite, code: fx.code })
  assert.equal(unready.response.status, 503)
  assert.equal(unready.body.code, 'BOOTSTRAP_REQUIRED')
  await fx.seedEdge()
  const gateBefore = await fx.mirrorStorage.get(GUEST_GATE_KEY)
  const sent = fx.headRequests.length
  for (const [options, status] of [
    [{ headers: { origin: 'https://elsewhere.example.invalid' } }, 403],
    [{ headers: { 'sec-fetch-site': 'cross-site' } }, 403],
    [{ headers: { 'content-type': 'text/plain' } }, 400],
    [{ method: 'PUT' }, 405],
  ]) {
    const result = await fx.call(GUEST_DOOR.route, { method: 'POST', body: { invite: fx.invite, code: fx.code }, ...options })
    assert.equal(result.response.status, status, JSON.stringify([options, result.body]))
  }
  assert.equal(await fx.mirrorStorage.get(GUEST_GATE_KEY), gateBefore)
  assert.equal(fx.headRequests.slice(sent).filter(request => new URL(request.url).pathname === GUEST_DOOR.route).length, 0)
  const huge = await fx.redeem({ invite: fx.invite, code: fx.code, pad: 'x'.repeat(GUEST_DOOR.maxBytes) }, { address: '198.51.100.88' })
  assert.equal(huge.response.status, 400)
  assert.ok(before <= fx.headRequests.length)
})

test('S1 #4: thirty simultaneous requests from one address: exactly the limit reach HEAD, the rest are refused', async t => {
  const fx = await fixture(t); await fx.seedEdge()
  const before = fx.headRequests.filter(request => new URL(request.url).pathname === GUEST_DOOR.route).length
  const results = await Promise.all(Array.from({ length: 30 }, () => fx.redeem({ invite: fx.invite, code: wrongCode }, { address: '198.51.100.30' })))
  const reached = fx.headRequests.filter(request => new URL(request.url).pathname === GUEST_DOOR.route).length - before
  assert.equal(reached, GUEST_GATE_LIMITS.maxFailures)
  assert.equal(results.filter(result => result.response.status === 403).length, GUEST_GATE_LIMITS.maxFailures)
  assert.equal(results.filter(result => result.response.status === 429).length, 30 - GUEST_GATE_LIMITS.maxFailures)
})
