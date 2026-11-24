/** Offline token ordering regressions: ephemeral keys, real approval verification, transactional memory only. */
import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import test from 'node:test'
import { isoCBOR } from '@simplewebauthn/server/helpers'
import { schnorr } from '@noble/curves/secp256k1.js'
import { bech32 } from '@scure/base'
import { aumlokClass3Binding, AUMLOK_STORAGE_KEY, createAumlokStore } from '../deploy/cloudflare/src/aumlok.mjs'
import { handleCloudBroker } from '../deploy/cloudflare/src/cloud-brokers.mjs'
import { X61HeadDurableObject, bootstrapPackage, digest, manifestId } from '../deploy/cloudflare/src/head-do.mjs'
import { handleMessagesRequest, MESSAGES_STORAGE_KEY } from '../deploy/cloudflare/src/messages-store.mjs'

const ORIGIN = 'https://preflight.example.invalid'
const SEND = '/aukora-messages/send'
const message = (requestId = 'send-1') => ({ conversationId: 'auma-pearl', content: 'Synthetic hello 👋', requestId })
const hash = value => createHash('sha256').update(value).digest()

function memoryStorage() {
  let rows = new Map(), queue = Promise.resolve()
  const storage = {
    onPut: null, failCommit: null, retry: null, writes: [],
    snapshot: () => structuredClone(rows),
    transaction(operation) {
      const run = queue.then(async () => {
        const attempt = async () => {
          const next = structuredClone(rows), writes = new Set()
          const result = await operation({
            get: async key => structuredClone(next.get(key)),
            put: async (key, value) => {
              storage.writes.push(key)
              writes.add(key)
              if (storage.onPut) await storage.onPut(key, value)
              next.set(key, structuredClone(value))
            },
            list: async ({ prefix = '', limit = Infinity } = {}) => new Map([...next].filter(([key]) => key.startsWith(prefix)).slice(0, limit)),
          })
          return { next, result, writes }
        }
        let attempted = await attempt()
        if (storage.retry && attempted.writes.has(storage.retry)) { storage.retry = null; attempted = await attempt() }
        const { next, result, writes } = attempted
        if (storage.failCommit && writes.has(storage.failCommit)) throw new Error('Synthetic transaction commit failure')
        rows = next
        return result
      })
      queue = run.catch(() => undefined)
      return run
    },
  }
  return storage
}

async function fixture(t) {
  let networkCalls = 0
  t.mock.method(globalThis, 'fetch', async () => { networkCalls++; throw new Error('External network forbidden') })
  t.after(() => assert.equal(networkCalls, 0))
  const storage = memoryStorage()
  const owner = generateKeyPairSync('ed25519'), node = generateKeyPairSync('ed25519')
  const passkey = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const publicKey = passkey.publicKey.export({ format: 'jwk' }), credentialId = randomBytes(32).toString('base64url')
  const ownerPublicKeyHex = owner.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex')
  const head = new X61HeadDurableObject({ storage, getWebSockets: () => [] }, { PUBLIC_HOST: new URL(ORIGIN).host, OWNER_PUBLIC_KEY_HEX: ownerPublicKeyHex })
  const code = 'export default { synthetic: true }', sha = await digest(code)
  const ball = { version: 'x6.1-ball/v1', parentBallId: null, epoch: 1,
    entries: { fixture: { id: 'fixture', specifier: `ball:${sha}`, config: {}, disabled: false, previousSpecifiers: [] } },
    modules: { [sha]: { sha256: sha, specifier: `ball:${sha}` } } }
  ball.ballId = await manifestId(ball)
  const seed = await bootstrapPackage({ version: 'x61-bootstrap/v1', ball, codeBySha: { [sha]: code }, mirror: { entryCount: 0, batchDigests: [] } })
  assert.equal((await head.store.bootstrapPrepare(seed)).ok, true)
  assert.equal((await head.store.bootstrapCommit(seed.seedId, { ok: true, phase: 'ready', seedId: seed.seedId,
    ballId: ball.ballId, epoch: ball.epoch, entryCount: 0, nextBatch: 0, batchCount: 0 })).ok, true)
  let at = 1794182400000, sequence = 0
  t.mock.method(Date, 'now', () => at)
  // A pre-existing synthetic enrollment is the fixture boundary. Approvals below use real UV signatures and MACs.
  await storage.transaction(tx => tx.put(AUMLOK_STORAGE_KEY, {
    schema: 'aukora.aumlok.state.v2', generation: 1,
    binding: { aumlokId: 'a'.repeat(64), recoveryCommitment: 'b'.repeat(64),
      rootEscrow: { schema: 'aukora.aumlok.escrow.v2', ivB64: randomBytes(12).toString('base64url'), ciphertextB64: randomBytes(48).toString('base64url') },
      nodePubkeyHex: node.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex'),
      credential: { id: credentialId, counter: 0, publicKeyB64: Buffer.from(isoCBOR.encode(new Map([
        [1, 2], [3, -7], [-1, 1], [-2, Buffer.from(publicKey.x, 'base64url')], [-3, Buffer.from(publicKey.y, 'base64url')],
      ]))).toString('base64url') }, boundAt: at, lastVerifiedAt: at, generation: 1 },
    'pepper.v1': randomBytes(32).toString('base64url'), challenges: [], invites: [], revocations: [],
    failures: 0, failedAt: [], nextAllowedAt: 0, attempts: [], approvals: [],
  }))
  // The production constructor captures Date.now; inject the real store with the controlled fixture clock.
  head.aumlokStore = createAumlokStore(storage, { origins: [ORIGIN], ownerPublicKeyHex, now: () => at })
  const issue = async (body, pathname = SEND, overrides = {}) => {
    const binding = { ...await aumlokClass3Binding({ audience: ORIGIN, method: 'POST', pathname, body }), ...overrides }
    const challenge = await head.aumlokStore.challenge({ purpose: 'approve', requestId: `approval-${++sequence}`, binding }, ORIGIN)
    const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: challenge.publicKey.challenge, origin: ORIGIN, crossOrigin: false })).toString('base64url')
    const auth = Buffer.alloc(37)
    hash(new URL(ORIGIN).hostname).copy(auth)
    auth[32] = 5; auth.writeUInt32BE(sequence, 33)
    const signature = sign('sha256', Buffer.concat([auth, hash(Buffer.from(clientDataJSON, 'base64url'))]), passkey.privateKey)
    const result = await head.aumlokStore.complete('approve', { challengeId: challenge.challengeId,
      credential: { id: credentialId, rawId: credentialId, type: 'public-key', clientExtensionResults: {}, response: {
        clientDataJSON, authenticatorData: auth.toString('base64url'), signature: signature.toString('base64url'),
      } } }, ORIGIN)
    assert.equal(result.ok, true, JSON.stringify(result))
    return result
  }
  const request = (body, approval, { pathname = SEND, headers = {}, raw = JSON.stringify(body), method = 'POST' } = {}) => {
    const values = new Headers({ 'x-x6-internal-authorized': '1', 'x-x6-bootstrap-seed': seed.seedId, 'content-type': 'application/json', ...headers })
    if (approval) values.set('x-x6-class3-approval', approval.approvalToken)
    return head.fetch(new Request(ORIGIN + pathname, { method, headers: values, ...(method === 'GET' ? {} : { body: raw }) }))
  }
  return { storage, head, issue, request, setTime: value => { at = value }, now: () => at }
}

async function unchanged(f, body, expected, options = {}) {
  const approval = await f.issue(body), before = f.storage.snapshot()
  const response = await f.request(body, approval, options)
  assert.equal((await response.json()).code, expected)
  assert.deepEqual(f.storage.snapshot(), before, 'A refusal must preserve token and message state')
}

test('Round26 malformed sends and headers refuse without spending or initializing messages', async t => {
  const f = await fixture(t)
  await unchanged(f, { ...message(), content: '' }, 'MESSAGES_SEND_INVALID')
  await unchanged(f, message(), 'MESSAGES_REQUEST_ID_CONFLICT', { headers: { 'idempotency-key': 'other-id' } })
  await unchanged(f, message(), 'MESSAGES_JSON_INVALID', { raw: '{' })
  await unchanged(f, message(), 'MESSAGES_CONTENT_LENGTH_MISMATCH', { headers: { 'content-length': '1' } })
})

test('Round26 unknown conversation refuses without spending or initializing messages', async t => {
  const f = await fixture(t)
  await unchanged(f, { ...message(), conversationId: 'not-found' }, 'MESSAGES_CONVERSATION_NOT_FOUND')
})

test('Round26 request-ID conflicts preserve their approval and the original message', async t => {
  const f = await fixture(t), body = message()
  assert.equal((await f.request(body, await f.issue(body))).status, 200)
  await unchanged(f, { ...body, content: 'different' }, 'MESSAGES_REQUEST_ID_CONFLICT')
})

test('Round26 whitespace and multibyte JSON retain their original byte length', async t => {
  const f = await fixture(t), body = message(), raw = JSON.stringify(body, null, 3) + '\n  '
  const response = await f.request(body, await f.issue(body), { raw, headers: { 'content-length': String(Buffer.byteLength(raw)) } })
  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
  assert.equal(f.storage.snapshot().get(MESSAGES_STORAGE_KEY).turns.length, 1)
})

test('Round26 concurrent replay consumes one approval once and requires fresh approval for replay', async t => {
  const f = await fixture(t), body = message(), approval = await f.issue(body)
  const responses = await Promise.all([f.request(body, approval), f.request(body, approval)])
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 403])
  const first = await responses.find(response => response.status === 200).json()
  const before = f.storage.snapshot()
  assert.equal((await f.request(body)).status, 403)
  assert.deepEqual(f.storage.snapshot(), before)
  const repeated = await f.request(body, await f.issue(body))
  assert.deepEqual(await repeated.json(), first)
  assert.equal(f.storage.snapshot().get(MESSAGES_STORAGE_KEY).turns.length, 1)
})

test('Round26 a failed message write or commit rolls back both state and approval', async t => {
  for (const failure of ['write', 'commit']) {
    const f = await fixture(t), body = message(), approval = await f.issue(body), before = f.storage.snapshot()
    if (failure === 'write') f.storage.onPut = key => { if (key === MESSAGES_STORAGE_KEY) throw new Error('Synthetic write failure') }
    else f.storage.failCommit = MESSAGES_STORAGE_KEY
    assert.equal((await f.request(body, approval)).status, 503)
    assert.deepEqual(f.storage.snapshot(), before)
    f.storage.onPut = null; f.storage.failCommit = null
    assert.equal((await f.request(body, approval)).status, 200)
  }
})

test('Round26 transaction retry rereads the unspent approval and writes one message', async t => {
  const f = await fixture(t), body = message(), approval = await f.issue(body)
  f.storage.retry = MESSAGES_STORAGE_KEY
  assert.equal((await f.request(body, approval)).status, 200)
  assert.equal(f.storage.snapshot().get(MESSAGES_STORAGE_KEY).turns.length, 1)
  assert.equal(f.storage.snapshot().get(AUMLOK_STORAGE_KEY).attempts.filter(entry => entry.purpose === 'consume-approval').length, 1)
  assert.equal(f.storage.retry, null)
})

test('Round26 an expired or mismatched exact approval cannot mutate state', async t => {
  const f = await fixture(t), body = message()
  for (const [approvedBody, path, overrides] of [
    [{ ...body, content: 'different' }, SEND, {}], [body, '/other-action', {}], [body, SEND, { method: 'PUT' }],
  ]) {
    const mismatched = await f.issue(approvedBody, path, overrides), before = f.storage.snapshot()
    assert.equal((await f.request(body, mismatched)).status, 403)
    assert.deepEqual(f.storage.snapshot(), before)
  }
  const approval = await f.issue(body)
  f.setTime(approval.expiresAt)
  const expired = f.storage.snapshot()
  assert.equal((await f.request(body, approval)).status, 403)
  assert.deepEqual(f.storage.snapshot(), expired)
})

test('Round26 reaching the token deadline during message persistence rolls back consumption', async t => {
  const f = await fixture(t), body = message(), approval = await f.issue(body), before = f.storage.snapshot()
  f.storage.onPut = key => { if (key === MESSAGES_STORAGE_KEY) f.setTime(approval.expiresAt) }
  assert.equal((await f.request(body, approval)).status, 403)
  assert.deepEqual(f.storage.snapshot(), before)
})

test('Round26 reaching the token deadline during its staged spend rolls back before messages', async t => {
  const f = await fixture(t), body = message(), approval = await f.issue(body), before = f.storage.snapshot()
  f.storage.onPut = key => { if (key === AUMLOK_STORAGE_KEY) f.setTime(approval.expiresAt) }
  assert.equal((await f.request(body, approval)).status, 403)
  assert.deepEqual(f.storage.snapshot(), before)
})

test('Round26 corrupt message storage refuses before consuming approval', async t => {
  const f = await fixture(t), body = message(), approval = await f.issue(body)
  await f.storage.transaction(tx => tx.put(MESSAGES_STORAGE_KEY, { corrupt: true }))
  const before = f.storage.snapshot()
  assert.equal((await (await f.request(body, approval)).json()).code, 'MESSAGES_STATE_CORRUPT')
  assert.deepEqual(f.storage.snapshot(), before)
})

test('Round26 signing follows staged consumption and state capacity refuses before either', async t => {
  const f = await fixture(t), body = message()
  await handleMessagesRequest(new Request(ORIGIN + '/aukora-messages/contacts.json'), f.storage, { authorized: true })
  const secretKey = schnorr.utils.randomSecretKey(), pubkey = schnorr.getPublicKey(secretKey)
  await f.storage.transaction(async tx => {
    const state = await tx.get(MESSAGES_STORAGE_KEY)
    state.identity = { version: 'aukora.messages.identity/v1', secretKey: Buffer.from(secretKey).toString('hex'),
      pubkey: Buffer.from(pubkey).toString('hex'), npub: bech32.encodeFromBytes('npub', pubkey) }
    await tx.put(MESSAGES_STORAGE_KEY, state)
  })
  secretKey.fill(0)
  const approval = await f.issue(body)
  let stagedConsumption = false, signingRandomness = 0, trackSigning = true
  const randomValues = globalThis.crypto.getRandomValues.bind(globalThis.crypto)
  // Distinguish Schnorr signing from the library's public-key validation blinding.
  t.mock.method(globalThis.crypto, 'getRandomValues', value => {
    if (trackSigning && new Error().stack.includes('schnorrSign')) {
      assert.equal(stagedConsumption, true, 'Approval must be staged before signing randomness')
      signingRandomness++
    }
    return randomValues(value)
  })
  f.storage.onPut = (key, state) => {
    if (key === AUMLOK_STORAGE_KEY) stagedConsumption = state.approvals.some(value => value.consumedAt !== null)
  }
  const before = f.storage.snapshot()
  assert.equal((await f.request(body)).status, 403)
  assert.deepEqual(f.storage.snapshot(), before)
  assert.equal(signingRandomness, 0)
  const response = await f.request(body, approval)
  assert.equal(response.status, 200)
  const turn = (await response.json()).turn
  assert.equal(turn.signatureStatus, 'signed')
  assert.equal(schnorr.verify(Buffer.from(turn.sig, 'hex'), Buffer.from(turn.id, 'hex'), pubkey), true)
  assert.ok(signingRandomness > 0)
  // Fill only synthetic local storage using its existing trusted local path.
  for (let index = 0; index < 40; index++) {
    const incoming = { ...message(`capacity-${index}`), content: 'x'.repeat(4096) }
    const result = await handleMessagesRequest(new Request(ORIGIN + SEND, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(incoming) }), f.storage, { authorized: true })
    if (result.status === 507) break
    assert.equal(result.status, 200)
  }
  f.storage.onPut = null
  const fullBody = { ...message('capacity-final'), content: 'x'.repeat(4096) }
  trackSigning = false
  const fullApproval = await f.issue(fullBody), full = f.storage.snapshot(), count = signingRandomness
  trackSigning = true
  const refused = await f.request(fullBody, fullApproval)
  assert.equal((await refused.json()).code, 'MESSAGES_STATE_LIMIT')
  assert.equal(signingRandomness, count)
  assert.deepEqual(f.storage.snapshot(), full)
})

test('Round26 unsupported brokers refuse without consumption or external calls', async t => {
  const f = await fixture(t)
  for (const [pathname, body, code] of [
    ['/_host/github', { action: 'api', method: 'POST', endpoint: '/user' }, 'GITHUB_ENDPOINT_REFUSED'],
    ['/_host/github', { action: 'api', method: 'GET', endpoint: '/user', body: {} }, 'GITHUB_API_REFUSED'],
    ['/_host/cloudflare', { action: 'deploy' }, 'CLOUDFLARE_ACTION_UNAVAILABLE'],
  ]) {
    const approval = await f.issue(body, pathname), before = f.storage.snapshot()
    let consumers = 0, network = 0
    const request = new Request(ORIGIN + pathname, { method: 'POST', headers: { origin: ORIGIN,
      'sec-fetch-site': 'same-origin', 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const response = await handleCloudBroker(request, {}, {
      networkFetch: async () => { network++; throw new Error('External network forbidden') },
      authorizeClass3: async input => {
        consumers++
        const binding = await aumlokClass3Binding({ audience: ORIGIN, method: 'POST', pathname, body: input })
        return f.head.aumlokStore.consumeApproval(approval.approvalToken, binding, ORIGIN)
      },
    })
    assert.equal((await response.json()).code, code)
    assert.equal(consumers, 0); assert.equal(network, 0)
    assert.deepEqual(f.storage.snapshot(), before)
  }
})

test('Round26 standalone handler retains its existing trusted local authorization', async () => {
  const storage = memoryStorage(), body = message()
  const request = () => new Request(ORIGIN + SEND, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  assert.equal((await handleMessagesRequest(request(), storage)).status, 401)
  assert.equal((await handleMessagesRequest(request(), storage, { authorized: true })).status, 200)
  assert.equal((await handleMessagesRequest(request(), storage, { authorized: true })).status, 200)
  assert.equal(storage.snapshot().get(MESSAGES_STORAGE_KEY).turns.length, 1)
})
