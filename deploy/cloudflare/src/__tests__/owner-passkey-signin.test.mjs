/** Owner sign-in with the bound passkey, no Mac step. Real Worker (production access verifier), HeadDO, MirrorDO and
 * AUMLOK store over in-memory storage; synthetic owner, node and passkey keys; real WebAuthn verification; no network. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import { isoCBOR } from '@simplewebauthn/server/helpers'
import { aumlokClass3Binding, AUMLOK_SIGNIN_CHALLENGE_MAX, AUMLOK_SIGNIN_LIMITS, signinChallengeMac, AUMLOK_SIGNIN_STORAGE_KEY, AUMLOK_STORAGE_KEY, createAumlokStore } from '../aumlok.mjs'
import { X61HeadDurableObject, bootstrapPackage, digest, manifestIdCanon } from '../head-do.mjs'
import { MirrorDO } from '../mirror-do.mjs'
import { createWorker, OWNER_PASSKEY } from '../worker.mjs'
import { runInNewContext } from 'node:vm' // ANYBROWSER hook
import { JSDOM } from 'jsdom' // ANYBROWSER hook
import { RESCUE_PAGE } from '../rescue-page.mjs' // ANYBROWSER hook
import { waitFor } from './wait-for.mjs'

const ORIGIN = 'https://passkey-signin.example.invalid'
const OWNER = 'owner@example.invalid'
const clone = value => structuredClone(value)
const keyHex = key => key.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex')
const sha = value => createHash('sha256').update(value).digest()
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url')

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
  return storage
}

function passkeyPair(idBytes = 32) {
  const key = generateKeyPairSync('ec', { namedCurve: 'P-256' }), jwk = key.publicKey.export({ format: 'jwk' })
  const id = randomBytes(idBytes).toString('base64url')
  const publicKeyB64 = Buffer.from(isoCBOR.encode(new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]]))).toString('base64url')
  return { key, id, publicKeyB64 }
}

/** A WebAuthn get() answer as a browser would send it. Every field can be bent to make an attacker's version. */
function assertionFor(passkey, challenge, { origin = ORIGIN, rpId = new URL(ORIGIN).hostname, flags = 0x05, counter = 0, type = 'webauthn.get', id = passkey.id, signer = passkey.key } = {}) {
  const clientDataJSON = Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false })).toString('base64url')
  const auth = Buffer.alloc(37)
  sha(rpId).copy(auth); auth[32] = flags; auth.writeUInt32BE(counter, 33)
  const signature = sign('sha256', Buffer.concat([auth, sha(Buffer.from(clientDataJSON, 'base64url'))]), signer.privateKey).toString('base64url')
  return { id, rawId: id, type: 'public-key', clientExtensionResults: {}, response: { clientDataJSON, authenticatorData: auth.toString('base64url'), signature } }
}

async function fixture(t, { idBytes = 32, shareWaitMs, shareMaxWaits } = {}) {
  const at = Date.now(), headStorage = memoryStorage(), mirrorStorage = memoryStorage()
  const owner = generateKeyPairSync('ed25519'), node = generateKeyPairSync('ed25519'), passkey = passkeyPair(idBytes)
  const identity = { schema: 'aukora.aumlok.state.v2', generation: 1,
    binding: { aumlokId: 'a'.repeat(64), recoveryCommitment: 'b'.repeat(64), nodePubkeyHex: keyHex(node),
      rootEscrow: { schema: 'aukora.aumlok.escrow.v2', ivB64: Buffer.alloc(12, 1).toString('base64url'), ciphertextB64: Buffer.alloc(48, 2).toString('base64url') },
      credential: { id: passkey.id, counter: 0, publicKeyB64: passkey.publicKeyB64 }, boundAt: at, lastVerifiedAt: at, generation: 1 },
    'pepper.v1': randomBytes(32).toString('base64url'), challenges: [], invites: [], revocations: [], failures: 0, failedAt: [], nextAllowedAt: 0, attempts: [], approvals: [] }
  const env = { PUBLIC_HOST: new URL(ORIGIN).host, OWNER_EMAIL: OWNER, OWNER_PUBLIC_KEY_HEX: keyHex(owner) }
  // Authentication must never read signing secrets.
  Object.defineProperty(env, 'OWNER_ED25519_SECRET_KEY', { get() { throw new Error('Authentication must not read signing secrets') } })
  let network = 0
  const noNetwork = async () => { network++; throw new Error('Network forbidden in passkey sign-in fixture') }
  const head = new X61HeadDurableObject({ storage: headStorage, getWebSockets: () => [] }, env, { networkFetch: noNetwork })
  const mirror = new MirrorDO({ storage: mirrorStorage })
  const faults = { signout: false, abandonKeyRead: false, keyRead: null, gateCheck: null, signinCall: null }
  const headPaths = []
  // `abandonKeyRead`: the key read never answers, as when the runtime cancels the request that started it.
  // `keyRead(answer)` / `gateCheck(answer)` / `signinCall(answer)`: the test decides what HEAD's key read / owner-login
  // gate call / sign-in call returns and when; `answer()` is HEAD's real answer, taken at the moment it is called.
  env.HEAD = { idFromName: value => value, get: () => ({ fetch: request => {
    const path = new URL(request.url).pathname
    headPaths.push(path); doCalls.push('HEAD ' + path)
    if (path === '/_host/aumlok/signin-key' && faults.abandonKeyRead) return new Promise(() => {})
    if (path === '/_host/aumlok/signin-key' && faults.keyRead) return faults.keyRead(() => head.fetch(request))
    if (path === '/_head/gate-lockout' && faults.gateCheck) return faults.gateCheck(() => head.fetch(request))
    if (path === '/_host/aumlok/signin' && faults.signinCall) return faults.signinCall(() => head.fetch(request))
    if (path === '/_host/aumlok/signout' && faults.signout) return Response.json({ ok: false, code: 'HEAD_STORAGE_UNAVAILABLE' }, { status: 503 })
    return head.fetch(request)
  } }) }
  const doCalls = []
  env.MIRROR = { idFromName: value => value, get: () => ({ fetch: request => (doCalls.push('MIRROR ' + new URL(request.url).pathname), mirror.fetch(request)) }) }
  env.ASSETS = { fetch() { return new Response('Fixture asset') } }
  t.after(() => assert.equal(network, 0))
  // `frozen`: when set, every reading of the Worker's clock is this one millisecond.
  const clock = { offset: 0, frozen: null }
  const workerNow = () => clock.frozen ?? Date.now() + clock.offset
  // Two Worker isolates over the same Durable Objects, each with its own in-memory caches.
  const workers = { A: createWorker({ networkFetch: noNetwork, now: workerNow, shareWaitMs, shareMaxWaits }), B: createWorker({ networkFetch: noNetwork, now: workerNow, shareWaitMs, shareMaxWaits }) }
  const jwt = () => {
    const payload = encode({ alg: 'EdDSA', typ: 'JWT' }) + '.' + encode({ iss: 'aukora.x61.owner', aud: env.PUBLIC_HOST, email: OWNER,
      nbf: Math.floor(Date.now() / 1000) - 1, exp: Math.floor(Date.now() / 1000) + 600 })
    return payload + '.' + sign(null, Buffer.from(payload), owner.privateKey).toString('base64url')
  }
  const call = async (path, { method = 'GET', body, cookie, address = '203.0.113.20', headers = {}, isolate = 'A' } = {}) => {
    const response = await workers[isolate].fetch(new Request(new URL(path, ORIGIN), { method,
      headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'cf-connecting-ip': address,
        ...(method === 'POST' ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...headers },
      ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) }), env)
    const text = await response.text()
    let parsed = text
    try { parsed = JSON.parse(text) } catch { /* HTML */ }
    return { response, body: parsed }
  }
  const source = 'export const fixture = true;', moduleSha = await digest(source)
  const draft = { version: 'x6.1-ball/v1', epoch: 1, parentBallId: null, authorPeerId: 'fixture-peer',
    entries: { fixture: { id: 'fixture', specifier: `ball:${moduleSha}`, disabled: false, config: {}, previousSpecifiers: [] } },
    modules: { [moduleSha]: { sha256: moduleSha, specifier: `ball:${moduleSha}` } } }
  const seed = await bootstrapPackage({ version: 'x61-bootstrap/v1', ball: { ...draft, ballId: await manifestIdCanon(draft) }, codeBySha: { [moduleSha]: source }, mirror: { entryCount: 0, batchDigests: [] } })
  for (const input of [{ action: 'prepare', package: seed }, { action: 'commit', seedId: seed.seedId }]) {
    const result = await call('/_bootstrap', { method: 'POST', body: input, headers: { 'x-x6-owner-assertion': jwt() } })
    assert.equal(result.response.status, 200, JSON.stringify(result.body))
  }
  await headStorage.put(AUMLOK_STORAGE_KEY, identity)
  const challenge = async (options = {}) => {
    const result = await call(OWNER_PASSKEY.challenge, { method: 'POST', body: {}, ...options })
    assert.equal(result.response.status, 200, JSON.stringify(result.body))
    return result.body
  }
  const signIn = async (issued, assertionOptions = {}, options = {}) =>
    call(OWNER_PASSKEY.signin, { method: 'POST', body: { challengeId: issued.challengeId, credential: assertionFor(passkey, issued.publicKey.challenge, assertionOptions) }, ...options })
  const cookieOf = response => (response.headers.get('set-cookie') ?? '').split(';')[0]
  const ownerCounters = async () => {
    const state = await headStorage.get(AUMLOK_STORAGE_KEY)
    return { failures: state.failures, failedAt: state.failedAt, nextAllowedAt: state.nextAllowedAt, phraseFailures: state.phraseFailures ?? 0,
      phraseFailedAt: state.phraseFailedAt ?? [], approvals: state.approvals, challenges: state.challenges, headGates: await headStorage.get('gate-lockout:v1') ?? null }
  }
  return { env, call, challenge, signIn, cookieOf, passkey, headStorage, ownerCounters, jwt, identity, faults, headPaths, doCalls, clock, noNetwork }
}

test('the owner signs in with the bound passkey and gets a short host-only HttpOnly session; nothing else changes', async t => {
  const fx = await fixture(t)
  const page = await fx.call('/', { headers: { accept: 'text/html', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' } })
  assert.equal(page.response.status, 401)
  assert.match(page.body, /id="passkey-submit"/)
  const before = await fx.ownerCounters()
  const issued = await fx.challenge()
  assert.equal(issued.publicKey.rpId, new URL(ORIGIN).hostname)
  assert.equal(issued.publicKey.userVerification, 'required')
  assert.deepEqual(issued.publicKey.allowCredentials, [{ type: 'public-key', id: fx.passkey.id }])
  // The browser gets the challenge only: never the issuance key or the stored public key the Worker checks with.
  assert.deepEqual(Object.keys(issued).sort(), ['challengeId', 'expiresAt', 'ok', 'publicKey', 'schema'])
  assert.ok(!JSON.stringify(issued).includes(fx.passkey.publicKeyB64))
  const signed = await fx.signIn(issued, { counter: 7 })
  assert.equal(signed.response.status, 200, JSON.stringify(signed.body))
  assert.deepEqual(Object.keys(signed.body).sort(), ['expires', 'ok'])
  const cookie = signed.response.headers.get('set-cookie')
  assert.match(cookie, /^__Host-x61-owner=[A-Za-z0-9_-]{43}\.\d{13}\.1\.[0-9a-f]{64}; HttpOnly; Secure; SameSite=Strict; Path=\/; Max-Age=(\d+)$/)
  assert.ok(Number(/Max-Age=(\d+)/.exec(cookie)[1]) <= AUMLOK_SIGNIN_LIMITS.sessionMs / 1000)
  assert.doesNotMatch(cookie, /Domain=/i)
  for (const path of ['/__x6/status', '/_host/aumlok/status', '/_head/ball']) {
    assert.equal((await fx.call(path, { cookie: fx.cookieOf(signed.response) })).response.status, 200, path)
  }
  // The counter rule is kept; no lockout counter, approval or approval challenge moved; the session is stored hashed.
  assert.equal((await fx.headStorage.get(AUMLOK_STORAGE_KEY)).binding.credential.counter, 7)
  assert.deepEqual(await fx.ownerCounters(), before)
  const stored = JSON.stringify(await fx.headStorage.get(AUMLOK_SIGNIN_STORAGE_KEY))
  assert.ok(!stored.includes(fx.cookieOf(signed.response).split('=')[1]))
})

test('a session is not an approval: Class 3 actions still refuse without their own passkey assertion', async t => {
  const fx = await fixture(t)
  const session = fx.cookieOf((await fx.signIn(await fx.challenge())).response)
  const promote = await fx.call('/_head/promote', { method: 'POST', cookie: session, body: { candidateBallId: 'a'.repeat(64) } })
  assert.equal(promote.response.status, 403)
  assert.equal(promote.body.code, 'CLASS3_WEBAUTHN_REQUIRED')
  assert.deepEqual((await fx.headStorage.get(AUMLOK_STORAGE_KEY)).approvals, [])
})

test('replay, a forged or foreign challenge, a phishing origin, another RP id, no UV, another key or credential are all refused', async t => {
  const fx = await fixture(t)
  const before = await fx.ownerCounters()
  // Spread over addresses so the per-address throttle (tested on its own below) does not answer first.
  let n = 0
  const from = () => ({ address: `203.0.113.${String(++n)}` })
  const challenge = () => fx.challenge(from())
  const used = await challenge(), first = assertionFor(fx.passkey, used.publicKey.challenge)
  assert.equal((await fx.call(OWNER_PASSKEY.signin, { method: 'POST', ...from(), body: { challengeId: used.challengeId, credential: first } })).response.status, 200)
  // Replay the exact same answer (counter 0, as many platform passkeys send): the challenge is single use.
  const replay = await fx.call(OWNER_PASSKEY.signin, { method: 'POST', ...from(), body: { challengeId: used.challengeId, credential: first } })
  assert.equal(replay.response.status, 409); assert.equal(replay.body.code, 'AUMLOK_SIGNIN_CHALLENGE_USED')
  assert.equal(replay.response.headers.has('set-cookie'), false)
  const other = passkeyPair()
  for (const [name, bend, code] of [
    ['phishing origin', { origin: 'https://passkey-signin.example.invalid.evil.example' }, 'AUMLOK_SIGNIN_PROOF_INVALID'],
    ['another RP id', { rpId: 'evil.example' }, 'AUMLOK_SIGNIN_PROOF_INVALID'],
    ['user present, not verified', { flags: 0x01 }, 'AUMLOK_SIGNIN_PROOF_INVALID'],
    ['a create() answer', { type: 'webauthn.create' }, 'AUMLOK_SIGNIN_PROOF_INVALID'],
    ['another key under the bound id', { signer: other.key }, 'AUMLOK_SIGNIN_PROOF_INVALID'],
    ['another credential', { id: other.id, signer: other.key }, 'AUMLOK_SIGNIN_PROOF_INVALID'],
  ]) {
    const result = await fx.signIn(await challenge(), bend, from())
    assert.equal(result.response.status, 403, name)
    assert.equal(result.body.code, code, name)
    assert.equal(result.response.headers.has('set-cookie'), false, name)
  }
  const issued = await challenge()
  const [encoded, tag] = issued.challengeId.split('.')
  const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString())
  for (const [name, challengeId] of [
    ['edited payload, old MAC', Buffer.from(JSON.stringify({ ...payload, expiresAt: payload.expiresAt + 3600000 })).toString('base64url') + '.' + tag],
    ['forged MAC', encoded + '.' + 'f'.repeat(64)], ['no MAC', encoded], ['garbage', 'x.y.z']]) {
    const result = await fx.call(OWNER_PASSKEY.signin, { method: 'POST', ...from(), body: { challengeId, credential: assertionFor(fx.passkey, issued.publicKey.challenge) } })
    assert.equal(result.response.status, 403, name); assert.equal(result.body.code, 'AUMLOK_SIGNIN_CHALLENGE_INVALID', name)
  }
  // The assertion must sign this challenge's own nonce.
  const nonce = await fx.signIn(issued, {}, from())
  assert.equal(nonce.response.status, 200)
  const mismatched = await fx.call(OWNER_PASSKEY.signin, { method: 'POST', ...from(), body: { challengeId: (await challenge()).challengeId, credential: assertionFor(fx.passkey, issued.publicKey.challenge) } })
  assert.equal(mismatched.body.code, 'AUMLOK_SIGNIN_PROOF_INVALID')
  const after = await fx.ownerCounters()
  assert.deepEqual({ ...after, challenges: [] }, { ...before, challenges: [] })
  assert.deepEqual(after.failures, 0)
})

test('a stranger on the owner\'s own network cannot keep him out; his proofs never reach HEAD, his challenges share one read', async t => {
  const fx = await fixture(t)
  const before = await fx.ownerCounters()
  const shared = '198.51.100.66'
  const real = await fx.challenge({ address: shared })
  const other = passkeyPair()
  let mark = fx.headPaths.length
  // Proofs of every bad kind from the owner's address, concurrently: not one reaches HEAD, none is throttled.
  const proofs = await Promise.all([
    ...Array.from({ length: 30 }, () => fx.call(OWNER_PASSKEY.signin, { method: 'POST', address: shared, body: { challengeId: 'x.y', credential: { id: 'x' } } })),
    ...Array.from({ length: 30 }, () => fx.signIn(real, { signer: other.key }, { address: shared })),
  ])
  assert.ok(proofs.every(result => result.response.status === 403), JSON.stringify(proofs.map(result => result.response.status)))
  assert.deepEqual(fx.headPaths.slice(mark), [], 'no proof reached HEAD')
  // Thirty concurrent challenge requests: each must name the current credential, so they read it, sharing one read.
  mark = fx.headPaths.length
  const challenges = await Promise.all(Array.from({ length: 30 }, () => fx.call(OWNER_PASSKEY.challenge, { method: 'POST', body: {}, address: shared })))
  assert.ok(challenges.every(result => result.response.status === 200))
  const reads = fx.headPaths.slice(mark)
  assert.ok(reads.length >= 1 && reads.length <= 2 && reads.every(path => path === '/_host/aumlok/signin-key'), JSON.stringify(reads))
  // The owner, from the same address, right after: in at once.
  mark = fx.headPaths.length
  const owner = await fx.signIn(await fx.challenge({ address: shared }), {}, { address: shared })
  assert.equal(owner.response.status, 200, JSON.stringify(owner.body))
  assert.deepEqual(fx.headPaths.slice(mark), ['/_host/aumlok/signin-key', '/_host/aumlok/signin'])
  const after = await fx.ownerCounters()
  assert.deepEqual({ ...after, challenges: [] }, { ...before, challenges: [] })
  // Owner token sign-in is untouched by all of it.
  assert.equal((await fx.call('/__x6/status', { headers: { 'x-x6-owner-assertion': fx.jwt() } })).response.status, 200)
})

test('sign-out ends the session; tampered, misplaced or downgraded cookies never authenticate', async t => {
  const fx = await fixture(t)
  const session = fx.cookieOf((await fx.signIn(await fx.challenge())).response)
  const token = session.split('=')[1]
  assert.equal((await fx.call('/__x6/status', { cookie: session })).response.status, 200)
  // A tampered token that is certainly different: the last character replaced by one it is not.
  const tampered = token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A')
  assert.notEqual(tampered, token)
  for (const cookie of [`__Host-x61-owner=${tampered}`, `__Host-x61-owner=${token}; __Host-x61-owner=${token}`, `x61-owner=${token}`,
    `CF_Authorization=${token}`, `__Host-x61-owner=${token},x`]) {
    assert.equal((await fx.call('/__x6/status', { cookie })).response.status, 401, cookie)
  }
  // Wrong method, cross-site, no JSON: the door refuses before any durable call.
  for (const [options, status] of [[{ method: 'GET' }, 405], [{ method: 'POST', body: {}, headers: { 'sec-fetch-site': 'cross-site' } }, 403],
    [{ method: 'POST', body: {}, headers: { origin: 'https://evil.example' } }, 403], [{ method: 'POST', body: '{}', headers: { 'content-type': 'text/plain' } }, 400]]) {
    assert.equal((await fx.call(OWNER_PASSKEY.challenge, options)).response.status, status, JSON.stringify(options))
  }
  const out = await fx.call(OWNER_PASSKEY.signout, { method: 'POST', body: {}, cookie: session })
  assert.equal(out.response.status, 200)
  assert.match(out.response.headers.get('set-cookie'), /^__Host-x61-owner=; HttpOnly; Secure; SameSite=Strict; Path=\/; Max-Age=0$/)
  assert.equal((await fx.call('/__x6/status', { cookie: session })).response.status, 401)
})

test('store: sessions expire, a re-bind generation ends them, an expired challenge is refused, and failures write nothing', async () => {
  const storage = memoryStorage(), passkey = passkeyPair(), node = generateKeyPairSync('ed25519'), owner = generateKeyPairSync('ed25519')
  let at = 1794000000000
  await storage.put(AUMLOK_STORAGE_KEY, { schema: 'aukora.aumlok.state.v2', generation: 1,
    binding: { aumlokId: 'a'.repeat(64), recoveryCommitment: 'b'.repeat(64), nodePubkeyHex: keyHex(node),
      rootEscrow: { schema: 'aukora.aumlok.escrow.v2', ivB64: Buffer.alloc(12, 1).toString('base64url'), ciphertextB64: Buffer.alloc(48, 2).toString('base64url') },
      credential: { id: passkey.id, counter: 0, publicKeyB64: passkey.publicKeyB64 }, boundAt: at, lastVerifiedAt: at, generation: 1 },
    'pepper.v1': randomBytes(32).toString('base64url'), challenges: [], invites: [], revocations: [], failures: 0, failedAt: [], nextAllowedAt: 0, attempts: [], approvals: [] })
  const store = createAumlokStore(storage, { origins: [ORIGIN], now: () => at, ownerPublicKeyHex: keyHex(owner) })
  const issued = await store.complete('signin-challenge', {}, ORIGIN)
  at += AUMLOK_SIGNIN_LIMITS.challengeMs
  const snapshot = JSON.stringify([await storage.get(AUMLOK_STORAGE_KEY), await storage.get(AUMLOK_SIGNIN_STORAGE_KEY)])
  await assert.rejects(store.complete('signin', { challengeId: issued.challengeId, credential: assertionFor(passkey, issued.publicKey.challenge) }, ORIGIN), { code: 'AUMLOK_SIGNIN_CHALLENGE_EXPIRED' })
  assert.equal(JSON.stringify([await storage.get(AUMLOK_STORAGE_KEY), await storage.get(AUMLOK_SIGNIN_STORAGE_KEY)]), snapshot)
  await assert.rejects(store.complete('signin-challenge', {}, 'https://evil.example'), { code: 'AUMLOK_ORIGIN_REQUIRED' })
  const fresh = await store.complete('signin-challenge', {}, ORIGIN)
  const { sessionToken } = await store.complete('signin', { challengeId: fresh.challengeId, credential: assertionFor(passkey, fresh.publicKey.challenge) }, ORIGIN)
  assert.equal((await store.complete('session', { token: sessionToken }, ORIGIN)).ok, true)
  at += AUMLOK_SIGNIN_LIMITS.sessionMs
  await assert.rejects(store.complete('session', { token: sessionToken }, ORIGIN), { code: 'AUMLOK_SESSION_INVALID' })
  at -= AUMLOK_SIGNIN_LIMITS.sessionMs - 1000
  assert.equal((await store.complete('session', { token: sessionToken }, ORIGIN)).ok, true)
  const state = await storage.get(AUMLOK_STORAGE_KEY)
  await storage.put(AUMLOK_STORAGE_KEY, { ...state, generation: 2, binding: { ...state.binding, generation: 2 } })
  await assert.rejects(store.complete('session', { token: sessionToken }, ORIGIN), { code: 'AUMLOK_SESSION_INVALID' })
  // A challenge issued under the old generation is no longer accepted either.
  await assert.rejects(store.complete('signin', { challengeId: fresh.challengeId, credential: assertionFor(passkey, fresh.publicKey.challenge) }, ORIGIN), { code: 'AUMLOK_SIGNIN_CHALLENGE_INVALID' })
  // An unbound node issues nothing.
  const empty = memoryStorage()
  await assert.rejects(createAumlokStore(empty, { origins: [ORIGIN], now: () => at }).complete('signin-challenge', {}, ORIGIN), { code: 'AUMLOK_NOT_BOUND' })
})

test('S1 #3: sign-out reports success only when HEAD confirms it; otherwise the cookie stays and a retry works', async t => {
  const fx = await fixture(t)
  const session = fx.cookieOf((await fx.signIn(await fx.challenge())).response)
  fx.faults.signout = true
  const failed = await fx.call(OWNER_PASSKEY.signout, { method: 'POST', body: {}, cookie: session })
  assert.equal(failed.response.status, 503)
  assert.deepEqual(failed.body, { ok: false, code: 'SIGNOUT_UNCONFIRMED', retry: true })
  assert.equal(failed.response.headers.has('set-cookie'), false, 'the cookie is kept for a retry')
  assert.equal((await fx.call('/__x6/status', { cookie: session })).response.status, 200, 'the server session was not ended, and it says so')
  fx.faults.signout = false
  const retried = await fx.call(OWNER_PASSKEY.signout, { method: 'POST', body: {}, cookie: session })
  assert.equal(retried.response.status, 200)
  assert.match(retried.response.headers.get('set-cookie'), /Max-Age=0$/)
  assert.equal((await fx.call('/__x6/status', { cookie: session })).response.status, 401)
})

test('S1 #6: the largest credential id a binding may hold (2,048 characters) still gives a usable challenge', async t => {
  const fx = await fixture(t, { idBytes: 1536 })
  assert.equal(fx.passkey.id.length, 2048)
  const issued = await fx.challenge()
  assert.ok(issued.challengeId.length > 2048, 'longer than the old fixed cap')
  assert.ok(issued.challengeId.length <= AUMLOK_SIGNIN_CHALLENGE_MAX)
  const signed = await fx.signIn(issued)
  assert.equal(signed.response.status, 200, JSON.stringify(signed.body))
  // One character over the derived bound is refused as malformed, not trusted.
  const over = await fx.call(OWNER_PASSKEY.signin, { method: 'POST', body: { challengeId: 'a'.repeat(AUMLOK_SIGNIN_CHALLENGE_MAX + 1), credential: { id: fx.passkey.id } } })
  assert.equal(over.response.status, 403)
})

test('S1 #8: an approval overtaken by a sign-in is refused as stale, uncounted, and a fresh approval then works', async () => {
  const storage = memoryStorage(), passkey = passkeyPair(), node = generateKeyPairSync('ed25519'), owner = generateKeyPairSync('ed25519')
  const at = Date.now()
  await storage.put(AUMLOK_STORAGE_KEY, { schema: 'aukora.aumlok.state.v2', generation: 1,
    binding: { aumlokId: 'a'.repeat(64), recoveryCommitment: 'b'.repeat(64), nodePubkeyHex: keyHex(node),
      rootEscrow: { schema: 'aukora.aumlok.escrow.v2', ivB64: Buffer.alloc(12, 1).toString('base64url'), ciphertextB64: Buffer.alloc(48, 2).toString('base64url') },
      credential: { id: passkey.id, counter: 4, publicKeyB64: passkey.publicKeyB64 }, boundAt: at, lastVerifiedAt: at, generation: 1 },
    'pepper.v1': randomBytes(32).toString('base64url'), challenges: [], invites: [], revocations: [], failures: 0, failedAt: [], nextAllowedAt: 0, attempts: [], approvals: [] })
  const store = createAumlokStore(storage, { origins: [ORIGIN], ownerPublicKeyHex: keyHex(owner) })
  const binding = await aumlokClass3Binding({ audience: ORIGIN, method: 'POST', pathname: '/_head/promote', body: { candidate: 'fixture' } })
  // The owner signs an approval (counter 5) but it has not reached HEAD yet...
  const approval = await store.challenge({ purpose: 'approve', requestId: 'approve-1', binding }, ORIGIN)
  const signedApproval = assertionFor(passkey, approval.publicKey.challenge, { counter: 5 })
  // ...and meanwhile signs in on another tab (counter 6).
  const issued = await store.complete('signin-challenge', {}, ORIGIN)
  assert.equal((await store.complete('signin', { challengeId: issued.challengeId, credential: assertionFor(passkey, issued.publicKey.challenge, { counter: 6 }) }, ORIGIN)).ok, true)
  const before = await storage.get(AUMLOK_STORAGE_KEY)
  const stale = await store.complete('approve', { challengeId: approval.challengeId, credential: signedApproval }, ORIGIN)
  assert.deepEqual([stale.ok, stale.code, stale.status], [false, 'AUMLOK_ASSERTION_STALE', 409])
  const after = await storage.get(AUMLOK_STORAGE_KEY)
  assert.deepEqual([after.failures, after.failedAt, after.nextAllowedAt], [before.failures, before.failedAt, before.nextAllowedAt], 'not counted')
  assert.equal(after.binding.credential.counter, 6, 'the counter rule is kept: nothing moved backwards')
  assert.deepEqual(after.approvals, [])
  // The explicit retry, at once (the stale refusal set no backoff): a fresh challenge and assertion approve.
  const retry = await store.challenge({ purpose: 'approve', requestId: 'approve-3', binding }, ORIGIN)
  const approved = await store.complete('approve', { challengeId: retry.challengeId, credential: assertionFor(passkey, retry.publicKey.challenge, { counter: 7 }) }, ORIGIN)
  assert.equal(typeof approved.approvalToken, 'string')
  // A forged signature that also carries an old counter is still a counted failure.
  const forged = await store.challenge({ purpose: 'approve', requestId: 'approve-4', binding }, ORIGIN)
  const forgedResult = await store.complete('approve', { challengeId: forged.challengeId, credential: assertionFor(passkey, forged.publicKey.challenge, { counter: 3, signer: passkeyPair().key }) }, ORIGIN)
  assert.deepEqual([forgedResult.ok, forgedResult.code], [false, 'AUMLOK_PROOF_INVALID'])
  assert.equal((await storage.get(AUMLOK_STORAGE_KEY)).failures, before.failures + 1)
})

test('F1 #2: the issuance key plus a captured assertion cannot resurrect access (the passkey signs the whole ceremony)', async () => {
  const storage = memoryStorage(), passkey = passkeyPair(), node = generateKeyPairSync('ed25519'), owner = generateKeyPairSync('ed25519')
  let at = 1794000000000
  await storage.put(AUMLOK_STORAGE_KEY, { schema: 'aukora.aumlok.state.v2', generation: 1,
    binding: { aumlokId: 'a'.repeat(64), recoveryCommitment: 'b'.repeat(64), nodePubkeyHex: keyHex(node),
      rootEscrow: { schema: 'aukora.aumlok.escrow.v2', ivB64: Buffer.alloc(12, 1).toString('base64url'), ciphertextB64: Buffer.alloc(48, 2).toString('base64url') },
      credential: { id: passkey.id, counter: 0, publicKeyB64: passkey.publicKeyB64 }, boundAt: at, lastVerifiedAt: at, generation: 1 },
    'pepper.v1': randomBytes(32).toString('base64url'), challenges: [], invites: [], revocations: [], failures: 0, failedAt: [], nextAllowedAt: 0, attempts: [], approvals: [] })
  const store = createAumlokStore(storage, { origins: [ORIGIN], now: () => at, ownerPublicKeyHex: keyHex(owner) })
  // The attacker's position: the issuance key (as if lifted from Worker memory) and one captured assertion (counter 0).
  const { issuanceKeyHex } = await store.complete('signin-key', {}, ORIGIN)
  const issued = await store.complete('signin-challenge', {}, ORIGIN)
  const captured = assertionFor(passkey, issued.publicKey.challenge, { counter: 0 })
  const { sessionToken } = await store.complete('signin', { challengeId: issued.challengeId, credential: captured }, ORIGIN)
  assert.equal((await store.complete('signout', { token: sessionToken }, ORIGIN)).signedOut, true)
  at += AUMLOK_SIGNIN_LIMITS.challengeMs + 1000
  // Probe: re-MAC the SAME nonce with a fresh life under the issuance key, replay the identical assertion.
  const [encoded] = issued.challengeId.split('.')
  const original = JSON.parse(Buffer.from(encoded, 'base64url').toString())
  const reissue = async fields => {
    const payload = { ...original, ...fields }
    const text = JSON.stringify(Object.fromEntries(Object.keys(payload).sort().map(name => [name, payload[name]])))
    return Buffer.from(text).toString('base64url') + '.' + await signinChallengeMac(issuanceKeyHex, text)
  }
  const fresh = await reissue({ issuedAt: at, expiresAt: at + AUMLOK_SIGNIN_LIMITS.challengeMs })
  await assert.rejects(store.complete('signin', { challengeId: fresh, credential: captured }, ORIGIN), { code: 'AUMLOK_SIGNIN_PROOF_INVALID' })
  // The original challenge has expired; a stretched life is not a valid payload at all, whatever its MAC.
  await assert.rejects(store.complete('signin', { challengeId: issued.challengeId, credential: captured }, ORIGIN), { code: 'AUMLOK_SIGNIN_CHALLENGE_EXPIRED' })
  await assert.rejects(store.complete('signin', { challengeId: await reissue({ expiresAt: original.issuedAt + 864e5 }), credential: captured }, ORIGIN), { code: 'AUMLOK_SIGNIN_CHALLENGE_INVALID' })
  await assert.rejects(store.complete('signin', { challengeId: await reissue({ issuedAt: at + 60000, expiresAt: at + 60000 + AUMLOK_SIGNIN_LIMITS.challengeMs }), credential: captured }, ORIGIN), { code: 'AUMLOK_SIGNIN_CHALLENGE_EXPIRED' })
  await assert.rejects(store.complete('signin', { challengeId: await reissue({ extra: 1 }), credential: captured }, ORIGIN), { code: 'AUMLOK_SIGNIN_CHALLENGE_INVALID' })
  // No session was made by any of it.
  assert.equal((await storage.get(AUMLOK_SIGNIN_STORAGE_KEY)).sessions.length, 0)
  // Within its life the same ceremony is single use with a zero counter: the digest, not the counter, holds it.
  const again = await store.complete('signin-challenge', {}, ORIGIN)
  const answer = assertionFor(passkey, again.publicKey.challenge, { counter: 0 })
  assert.equal((await store.complete('signin', { challengeId: again.challengeId, credential: answer }, ORIGIN)).ok, true)
  await assert.rejects(store.complete('signin', { challengeId: again.challengeId, credential: answer }, ORIGIN), { code: 'AUMLOK_SIGNIN_CHALLENGE_USED' })
})

test('F1 #1: anonymous traffic causes no durable work: warm or cold, malformed proofs, fabricated cookies, empty sign-outs', async t => {
  const fx = await fixture(t)
  // Cold isolate: 25 concurrent challenge requests share ONE key fetch (seed status x2 + signin-key).
  fx.doCalls.length = 0
  const cold = await Promise.all(Array.from({ length: 25 }, () => fx.call(OWNER_PASSKEY.challenge, { method: 'POST', body: {} })))
  assert.ok(cold.every(result => result.response.status === 200))
  assert.deepEqual(fx.doCalls.filter(call => !call.includes('bootstrap-status')), ['HEAD /_host/aumlok/signin-key'])
  assert.equal(fx.doCalls.length, 3)
  const real = cold[0].body
  const fakeToken = `${'A'.repeat(43)}.${String(Date.now() + 3600000)}.1.${'0'.repeat(64)}`
  const start = fx.doCalls.length
  await Promise.all([
    // Probe: malformed proofs naming the public credential id, which used to force a key refresh each.
    ...Array.from({ length: 25 }, () => fx.call(OWNER_PASSKEY.signin, { method: 'POST', body: { challengeId: 'x.y', credential: { id: fx.passkey.id } } })),
    ...Array.from({ length: 25 }, () => fx.call(OWNER_PASSKEY.signin, { method: 'POST', body: { challengeId: real.challengeId.slice(0, -1) + (real.challengeId.endsWith('0') ? '1' : '0'), credential: { id: fx.passkey.id } } })),
    // Fabricated session cookies, on an ordinary route and on sign-out; and sign-outs with no cookie at all.
    ...Array.from({ length: 25 }, () => fx.call('/__x6/status', { cookie: `__Host-x61-owner=${fakeToken}` })),
    ...Array.from({ length: 25 }, () => fx.call(OWNER_PASSKEY.signout, { method: 'POST', body: {}, cookie: `__Host-x61-owner=${fakeToken}` })),
    ...Array.from({ length: 25 }, () => fx.call(OWNER_PASSKEY.signout, { method: 'POST', body: {} })),
  ])
  assert.deepEqual(fx.doCalls.slice(start), [], 'not one durable call')
  // A challenge request costs exactly one small read (the seed id is held), never the seed status again.
  const one = fx.doCalls.length
  await fx.call(OWNER_PASSKEY.challenge, { method: 'POST', body: {} })
  assert.deepEqual(fx.doCalls.slice(one), ['HEAD /_host/aumlok/signin-key'])
  // After the 10 s bound, a burst that asks for refreshes still causes exactly one.
  fx.clock.offset = 11000
  const later = fx.doCalls.length
  await Promise.all(Array.from({ length: 25 }, () => fx.call(OWNER_PASSKEY.signin, { method: 'POST', body: { challengeId: 'x.y', credential: { id: fx.passkey.id } } })))
  assert.deepEqual(fx.doCalls.slice(later), ['HEAD /_host/aumlok/signin-key'])
  // The owner is unaffected throughout.
  fx.clock.offset = 0
  assert.equal((await fx.signIn(await fx.challenge())).response.status, 200)
})

test('G2 #1: after a re-bind, in two isolates and with no failed assertion, the old session is refused on the next request and the next challenge names the new credential', async t => {
  const fx = await fixture(t)
  const oldSession = fx.cookieOf((await fx.signIn(await fx.challenge())).response)
  for (const isolate of ['A', 'B']) assert.equal((await fx.call('/__x6/status', { cookie: oldSession, isolate })).response.status, 200, isolate)
  // A re-bind completes elsewhere: generation 2, a new passkey. No request fails on purpose afterwards.
  const fresh = passkeyPair(), state = await fx.headStorage.get(AUMLOK_STORAGE_KEY)
  await fx.headStorage.put(AUMLOK_STORAGE_KEY, { ...state, generation: 2, binding: { ...state.binding, generation: 2,
    credential: { id: fresh.id, counter: 0, publicKeyB64: fresh.publicKeyB64 } } })
  // The very next request with the old session, in either isolate, is refused.
  for (const isolate of ['A', 'B']) assert.equal((await fx.call('/__x6/status', { cookie: oldSession, isolate })).response.status, 401, isolate)
  // The very next challenge, in either isolate, names the new credential and the new generation.
  for (const isolate of ['B', 'A']) {
    const issued = await fx.challenge({ isolate })
    assert.deepEqual(issued.publicKey.allowCredentials, [{ type: 'public-key', id: fresh.id }], isolate)
    assert.equal(JSON.parse(Buffer.from(issued.challengeId.split('.')[0], 'base64url').toString()).generation, 2, isolate)
  }
  // And the new passkey signs in at once, the session working in both isolates.
  const issued = await fx.challenge({ isolate: 'B' })
  const signed = await fx.call(OWNER_PASSKEY.signin, { method: 'POST', isolate: 'B', body: { challengeId: issued.challengeId, credential: assertionFor(fresh, issued.publicKey.challenge) } })
  assert.equal(signed.response.status, 200, JSON.stringify(signed.body))
  for (const isolate of ['A', 'B']) assert.equal((await fx.call('/__x6/status', { cookie: fx.cookieOf(signed.response), isolate })).response.status, 200, isolate)
  // Sign-out in one isolate ends the session in the other on its next request.
  assert.equal((await fx.call(OWNER_PASSKEY.signout, { method: 'POST', body: {}, cookie: fx.cookieOf(signed.response), isolate: 'B' })).response.status, 200)
  assert.equal((await fx.call('/__x6/status', { cookie: fx.cookieOf(signed.response), isolate: 'A' })).response.status, 401)
})

test('H2 #1: sign-out through a stale isolate never claims a revocation HEAD did not make', async t => {
  const fx = await fixture(t)
  // Isolate A warms its caches at generation 1.
  await fx.challenge({ isolate: 'A' })
  // A re-bind (rotation) lands: generation 2, a new passkey; the owner signs in again through isolate B.
  const fresh = passkeyPair(), state = await fx.headStorage.get(AUMLOK_STORAGE_KEY)
  await fx.headStorage.put(AUMLOK_STORAGE_KEY, { ...state, generation: 2, binding: { ...state.binding, generation: 2,
    credential: { id: fresh.id, counter: 0, publicKeyB64: fresh.publicKeyB64 } } })
  const issued = await fx.challenge({ isolate: 'B' })
  const signed = await fx.call(OWNER_PASSKEY.signin, { method: 'POST', isolate: 'B', body: { challengeId: issued.challengeId, credential: assertionFor(fresh, issued.publicKey.challenge) } })
  assert.equal(signed.response.status, 200, JSON.stringify(signed.body))
  const session = fx.cookieOf(signed.response)
  // Sign-out through stale A before it may refresh: it cannot confirm, so it says so and keeps the cookie.
  const marker = fx.headPaths.length
  const early = await fx.call(OWNER_PASSKEY.signout, { method: 'POST', body: {}, cookie: session, isolate: 'A' })
  assert.equal(early.response.status, 503)
  assert.deepEqual(early.body, { ok: false, code: 'SIGNOUT_UNCONFIRMED', retry: true })
  assert.equal(early.response.headers.has('set-cookie'), false)
  assert.equal((await fx.call('/__x6/status', { cookie: session, isolate: 'B' })).response.status, 200, 'the session is truthfully still alive')
  // A moment later A refreshes, recognises the token, and HEAD ends the session: only then is it reported done.
  fx.clock.offset = 2000
  const done = await fx.call(OWNER_PASSKEY.signout, { method: 'POST', body: {}, cookie: session, isolate: 'A' })
  assert.equal(done.response.status, 200, JSON.stringify(done.body))
  assert.match(done.response.headers.get('set-cookie'), /Max-Age=0$/)
  assert.ok(fx.headPaths.slice(marker).includes('/_host/aumlok/signout'), 'HEAD was asked')
  // Replaying the cookie through B: refused. A 200 sign-out always means HEAD ended the session.
  assert.equal((await fx.call('/__x6/status', { cookie: session, isolate: 'B' })).response.status, 401)
  assert.equal((await fx.call('/__x6/status', { cookie: session, isolate: 'A' })).response.status, 401)
})

test('a key read abandoned by its cancelled request never hangs later sessions: the next request takes the read over', async t => {
  const fx = await fixture(t, { shareWaitMs: 40 })
  const signed = await fx.signIn(await fx.challenge())
  assert.equal(signed.response.status, 200, JSON.stringify(signed.body))
  const cookie = fx.cookieOf(signed.response)
  assert.equal((await fx.call('/_host/aumlok/status', { cookie })).response.status, 200)
  // The held key expires; the request that starts the next read is cancelled by the runtime (its read never answers).
  fx.clock.offset += 61000
  fx.faults.abandonKeyRead = true
  const pending = Symbol('pending')
  const readsBefore = countOf(fx, '/_host/aumlok/signin-key')
  const abandoned = fx.call('/_host/aumlok/status', { cookie })
  await waitFor(() => countOf(fx, '/_host/aumlok/signin-key') > readsBefore, 'the abandoned request\'s key read at HEAD')
  fx.faults.abandonKeyRead = false
  const keyReads = () => fx.headPaths.filter(path => path === '/_host/aumlok/signin-key').length
  const before = keyReads()
  // Every later session in this isolate used to wait on that read for ever. Now each gives it its own short time, one of
  // them reads again, and the others share that live read.
  const later = await Promise.race([
    Promise.all([fx.call('/_host/aumlok/status', { cookie }), fx.call('/__x6/status', { cookie }), fx.call('/_head/ball', { cookie })]),
    new Promise(resolve => setTimeout(() => resolve(pending), 30_000)),
  ])
  assert.notEqual(later, pending, 'later sessions still wait on the abandoned read')
  assert.deepEqual(later.map(result => result.response.status), [200, 200, 200])
  assert.equal(keyReads() - before, 1)
  // The key is held again: the next request reads nothing, and the abandoned request is still the only one waiting.
  assert.equal((await fx.call('/_host/aumlok/status', { cookie })).response.status, 200)
  assert.equal(keyReads() - before, 1)
  assert.equal(await Promise.race([abandoned, new Promise(resolve => setImmediate(() => resolve(pending)))]), pending)
  // A challenge (always a fresh read) and the other isolate are unaffected.
  assert.equal((await fx.call(OWNER_PASSKEY.challenge, { method: 'POST', body: {} })).response.status, 200)
  assert.equal((await fx.call('/_host/aumlok/status', { cookie, isolate: 'B' })).response.status, 200)
})

const PENDING = Symbol('pending')
const turn = () => new Promise(resolve => setImmediate(resolve))
/** The promise's outcome, or PENDING after `ms` (the timer is cleared either way: it only ever elapses on a failure). */
const within = (promise, ms = 30_000) => {
  let timer
  return Promise.race([promise, new Promise(resolve => { timer = setTimeout(() => resolve(PENDING), ms) })]).finally(() => clearTimeout(timer))
}
const until = (condition, what) => waitFor(condition, 'never happened: ' + what)
const countOf = (fx, path) => fx.headPaths.filter(seen => seen === path).length

test('equal clock: two key reads start in the same millisecond, the newer answers first; the older, answering later, never replaces it', async t => {
  const fx = await fixture(t, { shareWaitMs: 20 })
  const cookie = fx.cookieOf((await fx.signIn(await fx.challenge())).response)
  assert.equal((await fx.call('/__x6/status', { cookie })).response.status, 200)
  // The held key runs out, and from here every reading of the Worker's clock is the same millisecond.
  fx.clock.offset += 61000
  fx.clock.frozen = Date.now() + fx.clock.offset
  const held = []
  fx.faults.keyRead = () => new Promise(resolve => { held.push(resolve) })
  const older = fx.call('/__x6/status', { cookie })
  await until(() => held.length === 1, 'the older key read')
  fx.faults.keyRead = null
  const before = countOf(fx, '/_host/aumlok/signin-key')
  // The next request gives the older read its own short wait, then reads itself: a newer read, the same millisecond.
  const newer = await within(fx.call('/__x6/status', { cookie }))
  assert.notEqual(newer, PENDING)
  assert.equal(newer.response.status, 200)
  assert.equal(countOf(fx, '/_host/aumlok/signin-key') - before, 1)
  // The older read answers at last, with a refusal (503). Its own request cannot be checked: 503 OWNER_SESSION_UNAVAILABLE,
  // never "signed out"; the held answer stays the newer one.
  held[0](Response.json({ ok: false, code: 'HEAD_STORAGE_UNAVAILABLE' }, { status: 503 }))
  const olderDone = await within(older)
  assert.equal(olderDone.response.status, 503)
  assert.deepEqual(olderDone.body, { ok: false, code: 'OWNER_SESSION_UNAVAILABLE' })
  assert.equal((await fx.call('/__x6/status', { cookie })).response.status, 200, 'an older read replaced the newer answer')
  assert.equal(countOf(fx, '/_host/aumlok/signin-key') - before, 1, 'the newer answer is still held: nothing was read again')
})

test('S1: a key read in flight when a re-bind invalidates the held key never restores the old credential for another minute', async t => {
  const fx = await fixture(t)
  const first = await fx.challenge()
  assert.equal((await fx.signIn(first)).response.status, 200)
  const kept = await fx.challenge() // a challenge the old passkey can still answer
  // A challenge request's key read takes HEAD's answer NOW (generation 1, the old credential) and delivers it later.
  const held = []
  fx.faults.keyRead = answer => { const early = answer(); return new Promise(resolve => { held.push({ early, deliver: () => resolve(early) }) }) }
  const slow = fx.call(OWNER_PASSKEY.challenge, { method: 'POST', body: {} })
  await until(() => held.length === 1, 'the key read in flight')
  fx.faults.keyRead = null
  await held[0].early // HEAD has answered (the fixture's storage finished that read); the Worker has not been told yet
  // A re-bind completes elsewhere: generation 2, a new passkey.
  const fresh = passkeyPair(), state = await fx.headStorage.get(AUMLOK_STORAGE_KEY)
  await fx.headStorage.put(AUMLOK_STORAGE_KEY, { ...state, generation: 2, binding: { ...state.binding, generation: 2,
    credential: { id: fresh.id, counter: 0, publicKeyB64: fresh.publicKeyB64 } } })
  // The old passkey's proof still fits this isolate's held key, so it reaches HEAD, which refuses it: the held key is
  // marked stale.
  const proof = { challengeId: kept.challengeId, credential: assertionFor(fx.passkey, kept.publicKey.challenge) }
  const refused = await fx.call(OWNER_PASSKEY.signin, { method: 'POST', body: proof })
  assert.ok(['AUMLOK_SIGNIN_CHALLENGE_INVALID', 'AUMLOK_SIGNIN_PROOF_INVALID', 'AUMLOK_NOT_BOUND'].includes(refused.body.code), JSON.stringify(refused.body))
  const reached = countOf(fx, '/_host/aumlok/signin'), keyReads = countOf(fx, '/_host/aumlok/signin-key')
  // Only now does the read that started before the re-bind answer, carrying the replaced credential.
  held[0].deliver()
  assert.notEqual(await within(slow), PENDING)
  // The old credential is NOT held again: the same proof makes this isolate read the key afresh (generation 2, the new
  // credential) and is refused here, without reaching HEAD.
  const again = await fx.call(OWNER_PASSKEY.signin, { method: 'POST', body: proof })
  assert.equal(again.response.status, 403, JSON.stringify(again.body))
  assert.equal(countOf(fx, '/_host/aumlok/signin') - reached, 0, 'the replaced credential was held again and its proof reached HEAD')
  assert.equal(countOf(fx, '/_host/aumlok/signin-key') - keyReads, 1)
  // And the new passkey signs in at once.
  const issued = await fx.challenge()
  assert.deepEqual(issued.publicKey.allowCredentials, [{ type: 'public-key', id: fresh.id }])
  const signed = await fx.call(OWNER_PASSKEY.signin, { method: 'POST', body: { challengeId: issued.challengeId, credential: assertionFor(fresh, issued.publicKey.challenge) } })
  assert.equal(signed.response.status, 200, JSON.stringify(signed.body))
  assert.equal((await fx.call('/__x6/status', { cookie: fx.cookieOf(signed.response) })).response.status, 200)
})

/** As `until`, for a step that passes through WebCrypto first (that work finishes off the event loop): `waitFor` already
 * gives such work elapsed time (turns, then 1 ms sleeps), so the two are one wait now. */
const eventually = (condition, what) => waitFor(condition, 'never happened: ' + what)
const SIGNIN_REFUSALS = ['AUMLOK_SIGNIN_CHALLENGE_INVALID', 'AUMLOK_SIGNIN_PROOF_INVALID', 'AUMLOK_NOT_BOUND']
/** A re-bind completed elsewhere: HEAD's store now holds `generation` and a new passkey, which is returned. */
const rebindElsewhere = async (fx, generation) => {
  const fresh = passkeyPair(), state = await fx.headStorage.get(AUMLOK_STORAGE_KEY)
  await fx.headStorage.put(AUMLOK_STORAGE_KEY, { ...state, generation, binding: { ...state.binding, generation,
    credential: { id: fresh.id, counter: 0, publicKeyB64: fresh.publicKeyB64 } } })
  return fresh
}
const proofOf = (passkey, issued) => ({ challengeId: issued.challengeId, credential: assertionFor(passkey, issued.publicKey.challenge) })

test('a sign-in refusal that lands while a REFUSAL is held still stops a key read in flight from restoring the replaced credential', async t => {
  const fx = await fixture(t)
  assert.equal((await fx.signIn(await fx.challenge())).response.status, 200)
  const kept = await fx.challenge(), keptToo = await fx.challenge() // two challenges the old passkey can still answer
  // (1) The old passkey's proof passes this isolate's pre-check (the held key is generation 1); HEAD's answer is slow.
  const signinHeld = []
  fx.faults.signinCall = answer => new Promise(resolve => { signinHeld.push({ answer, resolve }) })
  const slowSignin = fx.call(OWNER_PASSKEY.signin, { method: 'POST', body: proofOf(fx.passkey, kept) })
  await eventually(() => signinHeld.length === 1, 'the sign-in call at HEAD')
  fx.faults.signinCall = null
  // (2) One challenge request's key read answers 503: what this isolate holds is now a REFUSAL.
  fx.faults.keyRead = () => Response.json({ ok: false, code: 'HEAD_STORAGE_UNAVAILABLE' }, { status: 503 })
  assert.equal((await fx.call(OWNER_PASSKEY.challenge, { method: 'POST', body: {} })).response.status, 503)
  // (3) The next challenge request's key read takes HEAD's answer NOW (generation 1) and delivers it later.
  const keyHeld = []
  fx.faults.keyRead = answer => { const early = answer(); return new Promise(resolve => { keyHeld.push({ early, deliver: () => resolve(early) }) }) }
  const slowChallenge = fx.call(OWNER_PASSKEY.challenge, { method: 'POST', body: {} })
  await until(() => keyHeld.length === 1, 'the key read in flight')
  fx.faults.keyRead = null
  await keyHeld[0].early
  // (4) A re-bind completes elsewhere: generation 2, a new passkey.
  const fresh = await rebindElsewhere(fx, 2)
  // (5) HEAD refuses the proof from (1). What is held at this moment is the refusal from (2), not a key.
  signinHeld[0].resolve(await signinHeld[0].answer())
  const refused = await within(slowSignin)
  assert.notEqual(refused, PENDING)
  assert.ok(SIGNIN_REFUSALS.includes(refused.body.code), JSON.stringify(refused.body))
  const reached = countOf(fx, '/_host/aumlok/signin'), keyReads = countOf(fx, '/_host/aumlok/signin-key')
  // (6) Only now does the read from (3) answer, carrying the replaced credential. Its own request is answered with it.
  keyHeld[0].deliver()
  assert.notEqual(await within(slowChallenge), PENDING)
  // It is NOT held: a second proof from the old passkey never reaches HEAD's sign-in. While the refusal from (2) lasts
  // it is answered from that, with no read at all.
  const again = await fx.call(OWNER_PASSKEY.signin, { method: 'POST', body: proofOf(fx.passkey, keptToo) })
  assert.equal(countOf(fx, '/_host/aumlok/signin') - reached, 0, 'the replaced credential was held again and its proof reached HEAD')
  assert.equal(again.response.status, 503, JSON.stringify(again.body))
  assert.equal(countOf(fx, '/_host/aumlok/signin-key') - keyReads, 0)
  // Once that refusal has run out the same proof makes this isolate read the key afresh (generation 2, the new
  // credential) and is refused here, again without reaching HEAD.
  fx.clock.offset += 10001
  const later = await fx.call(OWNER_PASSKEY.signin, { method: 'POST', body: proofOf(fx.passkey, keptToo) })
  assert.equal(later.response.status, 403, JSON.stringify(later.body))
  assert.equal(countOf(fx, '/_host/aumlok/signin') - reached, 0)
  assert.equal(countOf(fx, '/_host/aumlok/signin-key') - keyReads, 1)
  // And the new passkey signs in at once (the Worker's clock back in step with HEAD's, which judges the challenge's age).
  fx.clock.offset -= 10001
  const issued = await fx.challenge()
  assert.deepEqual(issued.publicKey.allowCredentials, [{ type: 'public-key', id: fresh.id }])
  const signed = await fx.call(OWNER_PASSKEY.signin, { method: 'POST', body: proofOf(fresh, issued) })
  assert.equal(signed.response.status, 200, JSON.stringify(signed.body))
})

test('a late sign-in refusal expires only the key it was verified with: a key of a newer generation read meanwhile stays held', async t => {
  const fx = await fixture(t)
  assert.equal((await fx.signIn(await fx.challenge())).response.status, 200)
  const kept = await fx.challenge()
  // The old passkey's proof passes this isolate's pre-check; HEAD's answer to it is slow.
  const signinHeld = []
  fx.faults.signinCall = answer => new Promise(resolve => { signinHeld.push({ answer, resolve }) })
  const slowSignin = fx.call(OWNER_PASSKEY.signin, { method: 'POST', body: proofOf(fx.passkey, kept) })
  await eventually(() => signinHeld.length === 1, 'the sign-in call at HEAD')
  fx.faults.signinCall = null
  // A re-bind completes elsewhere and a challenge request reads the key: generation 2 is what this isolate holds now.
  const fresh = await rebindElsewhere(fx, 2)
  const issued = await fx.challenge()
  assert.deepEqual(issued.publicKey.allowCredentials, [{ type: 'public-key', id: fresh.id }])
  // HEAD's refusal of the old proof arrives after that.
  signinHeld[0].resolve(await signinHeld[0].answer())
  const refused = await within(slowSignin)
  assert.notEqual(refused, PENDING)
  assert.ok(SIGNIN_REFUSALS.includes(refused.body.code), JSON.stringify(refused.body))
  // The generation-2 key is still held and live: a request that only uses the held key (a fabricated generation-2
  // session envelope) reads nothing, and the new passkey signs in with the challenge issued before the refusal.
  const keyReads = countOf(fx, '/_host/aumlok/signin-key')
  const fabricated = `__Host-x61-owner=${'A'.repeat(43)}.${String(Date.now() + 3600000)}.2.${'0'.repeat(64)}`
  assert.equal((await fx.call('/__x6/status', { cookie: fabricated })).response.status, 401)
  assert.equal((await fx.call(OWNER_PASSKEY.signin, { method: 'POST', body: proofOf(fresh, issued) })).response.status, 200)
  assert.equal(countOf(fx, '/_host/aumlok/signin-key') - keyReads, 0, 'the late refusal expired a key of another generation')
})

test('key reads that never answer: a session out of waits is refused at once, reads nothing itself, and the refusal is not held', async t => {
  // Two waits (`shareMaxWaits: 2`): the case below is a session that runs out of them.
  const fx = await fixture(t, { shareWaitMs: 20, shareMaxWaits: 2 })
  const cookie = fx.cookieOf((await fx.signIn(await fx.challenge())).response)
  assert.equal((await fx.call('/__x6/status', { cookie })).response.status, 200)
  fx.clock.offset += 61000
  fx.faults.abandonKeyRead = true
  const before = countOf(fx, '/_host/aumlok/signin-key')
  const abandoned = fx.call('/__x6/status', { cookie })
  await until(() => countOf(fx, '/_host/aumlok/signin-key') - before === 1, 'the abandoned key read')
  // Two more sessions arrive. The first takes the read over after its wait (and hangs on its own read, as its request
  // would); the second has then waited twice on reads it did not start.
  const taker = fx.call('/_host/aumlok/status', { cookie })
  await turn()
  const second = await within(fx.call('/_head/ball', { cookie }))
  assert.notEqual(second, PENDING, 'a session out of waits still waits')
  // Out of waits is not "signed out": 503 OWNER_SESSION_UNAVAILABLE, retry in a second, the cookie untouched.
  assert.equal(second.response.status, 503)
  assert.deepEqual(second.body, { ok: false, code: 'OWNER_SESSION_UNAVAILABLE' })
  assert.equal(second.response.headers.get('retry-after'), '1')
  assert.equal(second.response.headers.has('set-cookie'), false)
  assert.equal(countOf(fx, '/_host/aumlok/signin-key') - before, 2, 'the abandoned read and one replacement: the refused session read nothing')
  // HEAD answers again. The refusal was not held: the next session reads the key (after its own wait) and is served.
  fx.faults.abandonKeyRead = false
  const next = await within(fx.call('/__x6/status', { cookie }))
  assert.notEqual(next, PENDING)
  assert.equal(next.response.status, 200)
  assert.equal(countOf(fx, '/_host/aumlok/signin-key') - before, 3)
  for (const hung of [abandoned, taker]) assert.equal(await within(hung, 0), PENDING)
})

test('an owner login whose gate check never answers does not hang the next login from the same address', async t => {
  const fx = await fixture(t, { shareWaitMs: 20 })
  const login = () => fx.call('/_auth/owner', { method: 'POST', body: fx.jwt(), headers: { 'content-type': 'application/jwt' } })
  // The first login's read-only check never answers, as when the runtime cancels its request. (Released when the test
  // ends, so the Worker's own 60 s deadline timer does not outlive it.)
  let release = null
  fx.faults.gateCheck = () => new Promise(resolve => { release = resolve })
  t.after(() => release?.(Response.json({ ok: false, code: 'FIXTURE_ENDED' }, { status: 503 })))
  const abandoned = login()
  await until(() => release !== null, 'the abandoned gate check')
  fx.faults.gateCheck = null
  const before = countOf(fx, '/_head/gate-lockout')
  const next = await within(login())
  assert.notEqual(next, PENDING, 'the next login still waits on the abandoned check')
  assert.equal(next.response.status, 200, JSON.stringify(next.body))
  assert.match(next.response.headers.get('set-cookie'), /^CF_Authorization=/)
  assert.equal(countOf(fx, '/_head/gate-lockout') - before, 2, 'its own check, then its own success record')
  assert.equal(await within(abandoned, 0), PENDING)
})

const signinNavigation = () => new Request(new URL('/', ORIGIN), { headers: { accept: 'text/html', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' } })
const signinPolicyOf = html => {
  const hash = text => `'sha256-${createHash('sha256').update(text).digest('base64')}'`
  const script = /<script>([\s\S]*)<\/script>/.exec(html)[1], style = /<style>([\s\S]*?)<\/style>/.exec(html)[1]
  return `default-src 'none'; base-uri 'none'; object-src 'none'; script-src ${hash(script)}; style-src ${hash(style)}; connect-src 'self'; form-action 'none'; frame-ancestors 'none'`
}

test('S3: two concurrent first requests for the sign-in page both carry its exact CSP', async t => {
  const fx = await fixture(t)
  // A fresh copy of the Worker module: nothing has computed the page's policy in it yet.
  const worker = (await import('../worker.mjs?first-signin-page-concurrent')).createWorker({ networkFetch: fx.noNetwork })
  const pages = await Promise.all([worker.fetch(signinNavigation(), fx.env), worker.fetch(signinNavigation(), fx.env)])
  for (const page of pages) {
    assert.equal(page.status, 401)
    assert.equal(page.headers.get('content-security-policy'), signinPolicyOf(await page.text()))
  }
})

test('S3: a first sign-in page request whose hashing never finishes does not hang the next one', async t => {
  const fx = await fixture(t)
  const worker = (await import('../worker.mjs?first-signin-page-abandoned')).createWorker({ networkFetch: fx.noNetwork })
  const digest = crypto.subtle.digest.bind(crypto.subtle)
  let hang = true, hung = 0
  t.mock.method(crypto.subtle, 'digest', (...args) => hang ? (hung++, new Promise(() => {})) : digest(...args))
  const abandoned = worker.fetch(signinNavigation(), fx.env)
  await until(() => hung > 0, 'the abandoned hashing')
  hang = false
  const page = await within(worker.fetch(signinNavigation(), fx.env))
  assert.notEqual(page, PENDING, 'the next request waits on the abandoned request\'s policy')
  assert.equal(page.status, 401)
  assert.equal(page.headers.get('content-security-policy'), signinPolicyOf(await page.text()))
  assert.equal(await within(abandoned, 0), PENDING)
})

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const navigation = { accept: 'text/html', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' }
/** The same envelope with another expiry (13 digits): what an expired session cookie looks like. */
const withExpiry = (cookie, expiresAt) => cookie.replace(/\.(\d{13})\./, `.${String(expiresAt)}.`)

test('a signed-in request whose key read is busy is answered 503 OWNER_SESSION_UNAVAILABLE (API and navigation), never "signed out"; no session is still 401', async t => {
  const fx = await fixture(t, { shareWaitMs: 20, shareMaxWaits: 2 })
  const cookie = fx.cookieOf((await fx.signIn(await fx.challenge())).response)
  assert.equal((await fx.call('/__x6/status', { cookie })).response.status, 200)
  fx.clock.offset += 61000 // the held key runs out
  fx.faults.abandonKeyRead = true
  const before = countOf(fx, '/_host/aumlok/signin-key')
  const abandoned = fx.call('/__x6/status', { cookie })
  await until(() => countOf(fx, '/_host/aumlok/signin-key') - before === 1, 'the abandoned key read')
  const taker = fx.call('/_host/aumlok/status', { cookie }) // replaces it after its wait, with another read that never answers
  await turn()
  // Two signed-in requests (an API call and a navigation of the app) run out of waits on reads they did not start.
  const busy = [fx.call('/_head/ball', { cookie }), fx.call('/', { cookie, headers: navigation })].map(request => within(request))
  // Meanwhile, requests with no session are answered exactly as before, without touching the key read.
  const expired = withExpiry(cookie, Date.now() - 1000)
  assert.notEqual(expired, cookie)
  for (const [name, headers] of [['no cookie', {}], ['malformed cookie', { cookie: '__Host-x61-owner=not-an-envelope' }], ['expired envelope', { cookie: expired }]]) {
    const api = await within(fx.call('/__x6/status', { headers }))
    assert.equal(api.response.status, 401, name)
    assert.deepEqual(api.body, { ok: false, code: 'OWNER_ACCESS_REQUIRED' }, name)
    const page = await within(fx.call('/', { headers: { ...navigation, ...headers } }))
    assert.equal(page.response.status, 401, name)
    assert.match(page.body, /id="passkey-submit"/, name)
  }
  for (const done of await Promise.all(busy)) {
    assert.notEqual(done, PENDING)
    assert.equal(done.response.status, 503)
    assert.deepEqual(done.body, { ok: false, code: 'OWNER_SESSION_UNAVAILABLE' })
    assert.equal(done.response.headers.get('retry-after'), '1')
    assert.equal(done.response.headers.get('cache-control'), 'no-store')
    assert.equal(done.response.headers.has('set-cookie'), false, 'the cookie is untouched')
  }
  assert.equal(countOf(fx, '/_host/aumlok/signin-key') - before, 2, 'the abandoned read and one replacement: the busy requests read nothing')
  // HEAD answers again: the same cookie is served, for the API and for the app's page.
  fx.faults.abandonKeyRead = false
  const api = await within(fx.call('/__x6/status', { cookie }))
  assert.notEqual(api, PENDING)
  assert.equal(api.response.status, 200)
  const page = await within(fx.call('/', { cookie, headers: navigation }))
  assert.equal(page.response.status, 200)
  assert.equal(page.body, 'Fixture asset')
  for (const hung of [abandoned, taker]) assert.equal(await within(hung, 0), PENDING)
})

test('an unreadable key (HEAD answers 503) is not "signed out" for a live session, but a key that IS read still refuses a fabricated one', async t => {
  const fx = await fixture(t)
  const cookie = fx.cookieOf((await fx.signIn(await fx.challenge())).response)
  fx.clock.offset += 61000
  fx.faults.keyRead = () => Response.json({ ok: false, code: 'HEAD_STORAGE_UNAVAILABLE' }, { status: 503 })
  const refused = await fx.call('/__x6/status', { cookie })
  assert.equal(refused.response.status, 503)
  assert.deepEqual(refused.body, { ok: false, code: 'OWNER_SESSION_UNAVAILABLE' })
  // A key HEAD refuses with its own answer (not bound: 409) is a known answer: no session, as before.
  fx.clock.offset += 10001
  fx.faults.keyRead = () => Response.json({ ok: false, code: 'AUMLOK_NOT_BOUND' }, { status: 409 })
  assert.equal((await fx.call('/__x6/status', { cookie })).response.status, 401)
  // Readable again: the live session is served, and a fabricated envelope is refused 401 with the held key, reading nothing.
  fx.clock.offset += 10001
  fx.faults.keyRead = null
  assert.equal((await fx.call('/__x6/status', { cookie })).response.status, 200)
  const reads = countOf(fx, '/_host/aumlok/signin-key')
  const fabricated = `__Host-x61-owner=${'A'.repeat(43)}.${String(Date.now() + 3600000)}.1.${'0'.repeat(64)}`
  assert.equal((await fx.call('/__x6/status', { cookie: fabricated })).response.status, 401)
  assert.equal(countOf(fx, '/_host/aumlok/signin-key') - reads, 0)
})

test('a proof that arrives after an invalidation never uses a key read that began before it: it asks once more and is refused here', async t => {
  const fx = await fixture(t)
  assert.equal((await fx.signIn(await fx.challenge())).response.status, 200)
  const kept = await fx.challenge(), keptToo = await fx.challenge() // two challenges the old passkey can still answer
  // (1) The old passkey's proof passes this isolate's pre-check (generation 1 held); HEAD's answer is slow.
  const signinHeld = []
  fx.faults.signinCall = answer => new Promise(resolve => { signinHeld.push({ answer, resolve }) })
  const slowSignin = fx.call(OWNER_PASSKEY.signin, { method: 'POST', body: proofOf(fx.passkey, kept) })
  await eventually(() => signinHeld.length === 1, 'the sign-in call at HEAD')
  fx.faults.signinCall = null
  // (2) A challenge request's key read takes HEAD's answer NOW (generation 1) and delivers it later.
  const keyHeld = []
  fx.faults.keyRead = answer => { const early = answer(); return new Promise(resolve => { keyHeld.push({ early, deliver: () => resolve(early) }) }) }
  const slowChallenge = fx.call(OWNER_PASSKEY.challenge, { method: 'POST', body: {} })
  await until(() => keyHeld.length === 1, 'the key read in flight')
  fx.faults.keyRead = null
  await keyHeld[0].early
  // (3) A re-bind completes elsewhere; (4) HEAD refuses the proof from (1): the invalidation.
  const fresh = await rebindElsewhere(fx, 2)
  signinHeld[0].resolve(await signinHeld[0].answer())
  const refused = await within(slowSignin)
  assert.notEqual(refused, PENDING)
  assert.ok(SIGNIN_REFUSALS.includes(refused.body.code), JSON.stringify(refused.body))
  const reached = countOf(fx, '/_host/aumlok/signin'), keyReads = countOf(fx, '/_host/aumlok/signin-key')
  // (5) A second old proof ARRIVES AFTER the invalidation and shares the read from (2), which began before it.
  const late = fx.call(OWNER_PASSKEY.signin, { method: 'POST', body: proofOf(fx.passkey, keptToo) })
  await sleep(50)
  assert.equal(countOf(fx, '/_host/aumlok/signin-key') - keyReads, 0, 'it shares the read in flight')
  keyHeld[0].deliver() // that read answers only now, with the replaced credential
  const lateDone = await within(late)
  assert.notEqual(lateDone, PENDING)
  assert.equal(countOf(fx, '/_host/aumlok/signin') - reached, 0, 'an answer from before the invalidation decided: the old proof reached HEAD')
  assert.equal(lateDone.response.status, 403, JSON.stringify(lateDone.body))
  assert.equal(countOf(fx, '/_host/aumlok/signin-key') - keyReads, 1, 'exactly one more read')
  assert.notEqual(await within(slowChallenge), PENDING)
  // The new passkey signs in at once.
  const issued = await fx.challenge()
  assert.deepEqual(issued.publicKey.allowCredentials, [{ type: 'public-key', id: fresh.id }])
  assert.equal((await fx.call(OWNER_PASSKEY.signin, { method: 'POST', body: proofOf(fresh, issued) })).response.status, 200)
})

test('a session that arrives after an invalidation and finds only reads from before it asks once more, then is answered 503, never with the old key', async t => {
  const fx = await fixture(t, { shareWaitMs: 400 })
  const cookie = fx.cookieOf((await fx.signIn(await fx.challenge())).response)
  const kept = await fx.challenge()
  const signinHeld = []
  fx.faults.signinCall = answer => new Promise(resolve => { signinHeld.push({ answer, resolve }) })
  const slowSignin = fx.call(OWNER_PASSKEY.signin, { method: 'POST', body: proofOf(fx.passkey, kept) })
  await eventually(() => signinHeld.length === 1, 'the sign-in call at HEAD')
  fx.faults.signinCall = null
  // Two key reads begin before the re-bind (the second replaces the first after its wait); both deliver later.
  fx.clock.offset += 61000
  const keyHeld = []
  fx.faults.keyRead = answer => { const early = answer(); return new Promise(resolve => { keyHeld.push({ early, deliver: () => resolve(early) }) }) }
  const first = fx.call('/__x6/status', { cookie })
  await until(() => keyHeld.length === 1, 'the first key read')
  const second = fx.call('/_host/aumlok/status', { cookie })
  await eventually(() => keyHeld.length === 2, 'the read that replaced it')
  fx.faults.keyRead = null
  await Promise.all(keyHeld.map(held => held.early))
  await rebindElsewhere(fx, 2)
  signinHeld[0].resolve(await signinHeld[0].answer()) // the invalidation
  assert.ok(SIGNIN_REFUSALS.includes((await within(slowSignin)).body.code))
  const keyReads = countOf(fx, '/_host/aumlok/signin-key')
  // A session request arrives after the invalidation: it watches the second read.
  const late = fx.call('/_head/ball', { cookie })
  await sleep(50)
  keyHeld[0].deliver() // the first read answers (generation 1); it is kept for the waiter
  // The waiter's wait ends at ~400 ms: that answer began before the invalidation, so it asks again and watches the second
  // read (its next wait runs to ~800 ms). The second read then answers, from before the invalidation too.
  await sleep(550)
  keyHeld[1].deliver()
  const lateDone = await within(late)
  assert.notEqual(lateDone, PENDING)
  assert.equal(lateDone.response.status, 503, JSON.stringify(lateDone.body))
  assert.deepEqual(lateDone.body, { ok: false, code: 'OWNER_SESSION_UNAVAILABLE' })
  assert.equal(countOf(fx, '/_host/aumlok/signin-key') - keyReads, 0, 'it started no read of its own')
  for (const request of [first, second]) assert.notEqual(await within(request), PENDING)
  // Nothing from before the re-bind is held: the next request reads generation 2, and the old session is refused.
  assert.equal((await fx.call('/__x6/status', { cookie })).response.status, 401)
  assert.equal(countOf(fx, '/_host/aumlok/signin-key') - keyReads, 1)
})

// ANYBROWSER HOOK: /rescue and the sign-in page's landing. The page's one script runs against a small fake browser
// (JSDOM for the markup, a stub window whose `location.replace` is recorded) whose network is the real Worker above.
const rescueNavigation = { accept: 'text/html', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' }
const fromB64url = text => { const bytes = Buffer.from(text, 'base64url'); return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) }

/** Open the sign-in page as served on `served`, run its script as if its address were `pathname`. Nothing fires on a timer. */
async function landingPage(t, fx, { served = '/rescue', pathname = served, cookie = null, requestCookie = cookie, address = '203.0.113.60', name = '' } = {}) {
  const page = await fx.call(served, { headers: rescueNavigation, ...(cookie ? { cookie } : {}) })
  assert.equal(page.response.status, 401)
  const dom = new JSDOM(page.body, { url: ORIGIN + '/' })
  t.after(() => dom.window.close())
  const document = dom.window.document
  const jar = { cookie: requestCookie }, replacements = [], requests = [], timers = new Map()
  let settled = 0, nextTimer = 0
  const win = { name, PublicKeyCredential: function PublicKeyCredential() {}, addEventListener: dom.window.addEventListener.bind(dom.window),
    location: { origin: ORIGIN, pathname, hash: '', replace: destination => replacements.push(destination) }, history: { replaceState() {} } }
  const credentials = { get: async options => {
    const assertion = assertionFor(fx.passkey, Buffer.from(options.publicKey.challenge).toString('base64url'))
    return { id: assertion.id, rawId: fromB64url(assertion.rawId), type: 'public-key', getClientExtensionResults: () => ({}),
      response: { clientDataJSON: fromB64url(assertion.response.clientDataJSON), authenticatorData: fromB64url(assertion.response.authenticatorData),
        signature: fromB64url(assertion.response.signature), userHandle: null } }
  } }
  runInNewContext(document.querySelector('script').textContent, {
    document, window: win, navigator: { credentials }, AbortController, URL, btoa, atob, TextDecoder, Date, performance,
    AbortSignal: { timeout: () => new AbortController().signal },
    setTimeout(callback, delay) { timers.set(++nextTimer, { callback, delay }); return nextTimer },
    clearTimeout(timer) { timers.delete(timer) },
    async fetch(path, options) {
      requests.push(path)
      try {
        const { response, body } = await fx.call(path, { method: options.method, body: options.body, cookie: jar.cookie, address, headers: options.headers })
        const set = response.headers.get('set-cookie')
        if (set) jar.cookie = set.split(';')[0]
        return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: response.status, headers: response.headers })
      } finally { settled++ }
    },
  })
  const pump = (condition, what) => waitFor(condition, what)
  const passkey = async () => {
    await pump(() => settled >= 1, 'the held challenge')
    // The challenge is held once the page has read the answer and set its one refresh timer (nothing else sets a timer
    // before the press): waited for, so the press never comes before it, however slow the machine.
    await pump(() => timers.size > 0, 'the held challenge stored (its refresh timer set)')
    for (let i = 0; i < 20; i++) await turn()
    document.getElementById('passkey-submit').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    await pump(() => replacements.length > 0, 'the landing after the passkey')
  }
  const ownerPass = async token => {
    document.getElementById('owner-token').value = token
    document.getElementById('owner-signin').dispatchEvent(new dom.window.Event('submit', { cancelable: true }))
    await pump(() => replacements.length > 0, 'the landing after the owner pass')
  }
  return { html: page.body, policy: page.response.headers.get('content-security-policy'), jar, replacements, requests, win, passkey, ownerPass, pump, timers }
}

test('ANYBROWSER: signed out on /rescue shows the owner sign-in page itself, byte for byte and with its exact CSP; signed out on `/` too', async t => {
  const fx = await fixture(t)
  const rescue = await fx.call('/rescue', { headers: rescueNavigation })
  const root = await fx.call('/', { headers: rescueNavigation })
  for (const page of [rescue, root]) {
    assert.equal(page.response.status, 401)
    assert.match(page.body, /id="passkey-submit"/)
    assert.equal(page.response.headers.get('content-security-policy'), signinPolicyOf(page.body))
    assert.equal(page.response.headers.has('set-cookie'), false)
  }
  assert.equal(rescue.body, root.body, 'one sign-in page, the same bytes')
  // The script's only landings are the two fixed paths: nothing in it is read from the request.
  const script = /<script>([\s\S]*)<\/script>/.exec(rescue.body)[1]
  assert.deepEqual(script.match(/location\.replace\([^)]*\)/g), Array(3).fill("location.replace(window.location.pathname === '/rescue' ? '/rescue' : '/')"))
  assert.doesNotMatch(script, /location\.(?:assign|href)|location\.replace\((?!window\.location\.pathname === '\/rescue')/)
})

test('ANYBROWSER: a passkey sign-in on /rescue lands on /rescue, and that page is the rescue page; on `/` it still lands on `/`', async t => {
  const fx = await fixture(t)
  const rescue = await landingPage(t, fx, { served: '/rescue' })
  await rescue.passkey()
  assert.deepEqual(rescue.replacements, ['/rescue'])
  assert.match(rescue.jar.cookie, /^__Host-x61-owner=/)
  const page = await fx.call('/rescue', { cookie: rescue.jar.cookie, headers: rescueNavigation })
  assert.equal(page.response.status, 200)
  assert.equal(page.body, RESCUE_PAGE.html)
  assert.match(page.response.headers.get('content-security-policy'), /^default-src 'none'; .*script-src 'sha256-/)
  const root = await landingPage(t, fx, { served: '/', address: '203.0.113.61' })
  await root.passkey()
  assert.deepEqual(root.replacements, ['/'])
})

test('ANYBROWSER: the owner pass on /rescue lands on /rescue; a live session arriving without its cookie reopens /rescue once', async t => {
  const fx = await fixture(t)
  const pass = await landingPage(t, fx, { served: '/rescue', address: '203.0.113.62' })
  await pass.ownerPass(fx.jwt())
  assert.deepEqual(pass.replacements, ['/rescue'])
  assert.match(pass.jar.cookie, /^CF_Authorization=/)
  assert.equal((await fx.call('/rescue', { cookie: pass.jar.cookie, headers: rescueNavigation })).body, RESCUE_PAGE.html)
  // A link from another site: the page itself came without the Strict cookie, its own challenge request carries it.
  const session = fx.cookieOf((await fx.signIn(await fx.challenge())).response)
  // (The page was served signed out; the cookie joins only the page's own requests, as SameSite=Strict does.)
  const reopen = await landingPage(t, fx, { served: '/rescue', requestCookie: session, address: '203.0.113.63' })
  await reopen.pump(() => reopen.replacements.length > 0, 'the reopen')
  assert.deepEqual(reopen.replacements, ['/rescue'])
  assert.equal(reopen.win.name, 'x61-owner-signin-reopen')
})

test('ANYBROWSER: a crafted address never lands anywhere but `/` or `/rescue`, and only the exact /rescue lands on /rescue', async t => {
  const fx = await fixture(t)
  let address = 70
  for (const pathname of ['/rescue/', '//rescue', '/RESCUE', '/rescue%2f..', '/rescue%2F', '/rescue/..', '/x/rescue', '/rescue.html', '/', '/index.html', '/rescue']) {
    const page = await landingPage(t, fx, { served: '/', pathname, address: `203.0.113.${address++}` })
    await page.passkey()
    assert.deepEqual(page.replacements, [pathname === '/rescue' ? '/rescue' : '/'], pathname)
  }
  // The Worker serves the sign-in page only on the app's own paths and on the exact /rescue (a query is never read).
  for (const crafted of ['/rescue/', '/RESCUE', '/rescue%2f..', '/rescue.html']) {
    const { response, body } = await fx.call(crafted, { headers: rescueNavigation })
    assert.equal(response.status, 401, crafted)
    assert.deepEqual(body, { ok: false, code: 'OWNER_ACCESS_REQUIRED' }, crafted)
  }
  const query = await fx.call('/rescue?next=//elsewhere.example.invalid', { headers: rescueNavigation })
  assert.equal(query.response.status, 401)
  assert.doesNotMatch(query.body, /elsewhere/)
})

test('ANYBROWSER: /rescue while the key read is busy is a small page with one link back to /rescue, retry in a second, cookie kept', async t => {
  const fx = await fixture(t, { shareWaitMs: 20, shareMaxWaits: 2 })
  const cookie = fx.cookieOf((await fx.signIn(await fx.challenge())).response)
  assert.equal((await fx.call('/rescue', { cookie, headers: rescueNavigation })).body, RESCUE_PAGE.html)
  fx.clock.offset += 61000 // the held key runs out
  fx.faults.abandonKeyRead = true
  const before = countOf(fx, '/_host/aumlok/signin-key')
  const abandoned = fx.call('/__x6/status', { cookie })
  await until(() => countOf(fx, '/_host/aumlok/signin-key') - before === 1, 'the abandoned key read')
  const taker = fx.call('/_host/aumlok/status', { cookie })
  await turn()
  // A navigation of /rescue and an API call, together, run out of waits on reads they did not start.
  const [busy, api] = await Promise.all([within(fx.call('/rescue', { cookie, headers: rescueNavigation })), within(fx.call('/_head/ball', { cookie }))])
  assert.notEqual(busy, PENDING)
  assert.notEqual(api, PENDING)
  assert.equal(busy.response.status, 503)
  assert.equal(busy.body, RESCUE_PAGE.busyHtml)
  assert.equal(busy.response.headers.get('retry-after'), '1')
  assert.equal(busy.response.headers.get('cache-control'), 'no-store')
  assert.equal(busy.response.headers.has('set-cookie'), false)
  assert.match(busy.response.headers.get('content-security-policy'), /script-src 'none'/)
  assert.deepEqual([...busy.body.matchAll(/href="([^"]*)"/g)].map(match => match[1]), ['/rescue'])
  // The API keeps its JSON 503; HEAD answers again and /rescue is the page.
  assert.deepEqual(api.body, { ok: false, code: 'OWNER_SESSION_UNAVAILABLE' })
  fx.faults.abandonKeyRead = false
  assert.equal((await within(fx.call('/rescue', { cookie, headers: rescueNavigation }))).body, RESCUE_PAGE.html)
  for (const hung of [abandoned, taker]) assert.equal(await within(hung, 0), PENDING)
})
