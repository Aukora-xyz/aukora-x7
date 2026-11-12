/** Job 9 review: the TABLE row for the add-device door's registration verifier, through the real Worker, HeadDO, MirrorDO
 * and AUMLOK store over in-memory storage (no network). The WebAuthn library's registration verifier cannot be made to
 * answer anything but its own result by its inputs (a 'none' attestation checks no signature), so this file loads the
 * modules under test through a module hook that makes `verifyRegistrationResponse` replaceable: the row then decides what
 * the library answers. Every other export of the library is the real one, and nothing outside this test process sees the
 * hook. Expected, as every other row of the table (passkey-devices.test.mjs): only a strict `verified: false` costs the
 * code a miss and uses its challenge (403 AUMLOK_PROOF_INVALID); `verified: true` joins; every other answer, a throw of
 * the library's own verdict included (a throw is never a checked-wrong proof), is 503 AUMLOK_UNAVAILABLE, no miss,
 * nothing written, the challenge kept, and the genuine registration on the same challenge then joins. Job 11's screen
 * column: an answer our screen refuses (a wrong origin, RP id, type or flag; a wrong challenge) never reaches the library
 * (its call count stays 0), costs no miss and keeps the challenge. No answer ever moves an owner budget. */
import { registerHooks } from 'node:module'
import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import { isoCBOR } from '@simplewebauthn/server/helpers'

// ── The hook: '@simplewebauthn/server' resolves to a module that re-exports the real one, with a replaceable verifier. ──
const STUB = 'aukora-test:simplewebauthn-server'
const REAL = import.meta.resolve('@simplewebauthn/server')
registerHooks({
  resolve: (specifier, context, nextResolve) => specifier === '@simplewebauthn/server' || specifier === STUB ? { url: STUB, shortCircuit: true } : nextResolve(specifier, context),
  load: (url, context, nextLoad) => url !== STUB ? nextLoad(url, context) : { format: 'module', shortCircuit: true, source: [
    `import * as real from ${JSON.stringify(REAL)}`,
    `export * from ${JSON.stringify(REAL)}`,
    '/** `answer(real)`: what the library answers; `real()` runs the real verifier. null: the real verifier. */',
    'export const registration = { answer: null, calls: 0 }',
    'export function verifyRegistrationResponse(options) {',
    '  registration.calls++',
    '  const answer = registration.answer',
    '  return answer === null ? real.verifyRegistrationResponse(options) : answer(() => real.verifyRegistrationResponse(options))',
    '}',
  ].join('\n') },
})
const { registration } = await import(STUB)
const { aumlokClass3Binding, AUMLOK_STORAGE_KEY } = await import('../aumlok.mjs')
const { X61HeadDurableObject, bootstrapPackage, digest, manifestIdCanon } = await import('../head-do.mjs')
const { MirrorDO } = await import('../mirror-do.mjs')
const { createWorker, OWNER_PASSKEY } = await import('../worker.mjs')
const { PASSKEY_DEVICES_PENDING_KEY, PASSKEY_DEVICE_ADD_ACTION, PASSKEY_DEVICE_CHALLENGE_ADMISSION, PASSKEY_DEVICE_LIMITS, PASSKEY_DEVICE_ROUTES } = await import('../passkey-devices.mjs')

const ORIGIN = 'https://passkey-devices-table.example.invalid'
const RP_ID = new URL(ORIGIN).hostname
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
function passkeyPair() {
  const key = generateKeyPairSync('ec', { namedCurve: 'P-256' }), jwk = key.publicKey.export({ format: 'jwk' })
  const publicKeyB64 = Buffer.from(isoCBOR.encode(new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]]))).toString('base64url')
  return { key, id: randomBytes(32).toString('base64url'), publicKeyB64 }
}
function assertionFor(passkey, challenge, { userHandle } = {}) {
  const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge, origin: ORIGIN, crossOrigin: false })).toString('base64url')
  const auth = Buffer.alloc(37)
  sha(RP_ID).copy(auth); auth[32] = 0x05
  const signature = sign('sha256', Buffer.concat([auth, sha(Buffer.from(clientDataJSON, 'base64url'))]), passkey.key.privateKey).toString('base64url')
  return { id: passkey.id, rawId: passkey.id, type: 'public-key', clientExtensionResults: {}, response: { clientDataJSON, authenticatorData: auth.toString('base64url'), signature,
    ...(userHandle ? { userHandle } : {}) } }
}
function registrationFor(passkey, challenge) {
  const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge, origin: ORIGIN, crossOrigin: false })).toString('base64url')
  const idBytes = Buffer.from(passkey.id, 'base64url'), head = Buffer.alloc(55)
  sha(RP_ID).copy(head); head[32] = 0x45; head.writeUInt16BE(idBytes.length, 53)
  const authData = Buffer.concat([head, idBytes, Buffer.from(passkey.publicKeyB64, 'base64url')])
  const attestationObject = Buffer.from(isoCBOR.encode(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]))).toString('base64url')
  return { id: passkey.id, rawId: passkey.id, type: 'public-key', clientExtensionResults: {}, response: { clientDataJSON, attestationObject, transports: ['internal'] } }
}

/** Her store shape, bound to `passkey`; the owner signed in; one add code made by a Class 3 approval. */
async function fixture(t) {
  const at = Date.now(), headStorage = memoryStorage(), mirrorStorage = memoryStorage(), passkey = passkeyPair()
  const owner = generateKeyPairSync('ed25519'), node = generateKeyPairSync('ed25519'), userHandle = randomBytes(32).toString('base64url')
  const env = { PUBLIC_HOST: new URL(ORIGIN).host, OWNER_EMAIL: OWNER, OWNER_PUBLIC_KEY_HEX: keyHex(owner) }
  let network = 0
  const noNetwork = async () => { network++; throw new Error('Network forbidden in the device table fixture') }
  const head = new X61HeadDurableObject({ storage: headStorage, getWebSockets: () => [] }, env, { networkFetch: noNetwork })
  const mirror = new MirrorDO({ storage: mirrorStorage })
  const headPaths = []
  env.HEAD = { idFromName: value => value, get: () => ({ fetch: request => { headPaths.push(new URL(request.url).pathname); return head.fetch(request) } }) }
  env.MIRROR = { idFromName: value => value, get: () => ({ fetch: request => mirror.fetch(request) }) }
  env.ASSETS = { fetch() { return new Response('Fixture asset') } }
  t.after(() => assert.equal(network, 0))
  const worker = createWorker({ networkFetch: noNetwork })
  const call = async (path, { method = 'GET', body, cookie, headers = {} } = {}) => {
    const response = await worker.fetch(new Request(new URL(path, ORIGIN), { method,
      headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'cf-connecting-ip': '203.0.113.30',
        ...(method === 'POST' ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), env)
    const text = await response.text()
    let parsed = text
    try { parsed = JSON.parse(text) } catch { /* HTML */ }
    return { response, body: parsed }
  }
  const jwt = () => {
    const payload = encode({ alg: 'EdDSA', typ: 'JWT' }) + '.' + encode({ iss: 'aukora.x61.owner', aud: env.PUBLIC_HOST, email: OWNER,
      nbf: Math.floor(Date.now() / 1000) - 1, exp: Math.floor(Date.now() / 1000) + 600 })
    return payload + '.' + sign(null, Buffer.from(payload), owner.privateKey).toString('base64url')
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
  await headStorage.put(AUMLOK_STORAGE_KEY, { schema: 'aukora.aumlok.state.v2', generation: 1,
    binding: { aumlokId: 'a'.repeat(64), recoveryCommitment: 'b'.repeat(64), nodePubkeyHex: keyHex(node),
      rootEscrow: { schema: 'aukora.aumlok.escrow.v2', ivB64: Buffer.alloc(12, 1).toString('base64url'), ciphertextB64: Buffer.alloc(48, 2).toString('base64url') },
      credential: { id: passkey.id, counter: 0, publicKeyB64: passkey.publicKeyB64 }, boundAt: at, lastVerifiedAt: at, generation: 1 },
    'pepper.v1': randomBytes(32).toString('base64url'), challenges: [], invites: [], revocations: [], failures: 0, failedAt: [], nextAllowedAt: 0, attempts: [], approvals: [] })
  const issued = await call(OWNER_PASSKEY.challenge, { method: 'POST', body: {} })
  const signed = await call(OWNER_PASSKEY.signin, { method: 'POST', body: { challengeId: issued.body.challengeId, credential: assertionFor(passkey, issued.body.publicKey.challenge) } })
  assert.equal(signed.response.status, 200, JSON.stringify(signed.body))
  const cookie = (signed.response.headers.get('set-cookie') ?? '').split(';')[0]
  const body = { action: PASSKEY_DEVICE_ADD_ACTION, label: 'Work laptop', expiresAt: Date.now() + PASSKEY_DEVICE_LIMITS.codeMs, generation: 1 }
  const binding = await aumlokClass3Binding({ audience: ORIGIN, method: 'POST', pathname: PASSKEY_DEVICE_ROUTES.code, body })
  const ceremony = await call('/_host/aumlok/challenge', { method: 'POST', cookie, body: { purpose: 'approve', requestId: 'device-table-code', binding } })
  assert.equal(ceremony.response.status, 200, JSON.stringify(ceremony.body))
  const approved = await call('/_host/aumlok/approve', { method: 'POST', cookie, body: { challengeId: ceremony.body.challengeId,
    credential: assertionFor(passkey, ceremony.body.publicKey.challenge, { userHandle }) } })
  assert.equal(approved.response.status, 200, JSON.stringify(approved.body))
  const made = await call(PASSKEY_DEVICE_ROUTES.code, { method: 'POST', cookie, body, headers: { 'x-x6-class3-approval': approved.body.approvalToken } })
  assert.equal(made.response.status, 200, JSON.stringify(made.body))
  const ownerBudgets = async () => {
    const state = await headStorage.get(AUMLOK_STORAGE_KEY)
    return { failures: state.failures, failedAt: state.failedAt, nextAllowedAt: state.nextAllowedAt, phraseFailures: state.phraseFailures ?? 0, gate: await headStorage.get('gate-lockout:v1') ?? null }
  }
  const pending = async () => (await headStorage.get(PASSKEY_DEVICES_PENDING_KEY)).pending
  return { call, code: made.body.code, ownerBudgets, pending, headPaths }
}

/** What the library answers, given `real()` (the real verifier on the same request). */
const real = run => run()
const verifiedAs = value => async run => ({ ...await run(), verified: value })
const ROWS = [
  // The table's twelve answers, as the value of the library's `verified` (its result's verdict), and its throws.
  ['verified: true', real, 'joins'],
  ['verified: false', verifiedAs(false), 'counted'],
  ...[['undefined', undefined], ['null', null], ['{}', {}], ['[]', []], ['1', 1], ['0', 0], ['\'\'', ''], ['\'true\'', 'true']]
    .map(([name, value]) => [`verified: ${name}`, verifiedAs(value), 'unavailable']),
  ['a throw', () => { throw new Error('backend down') }, 'unavailable'],
  ['a rejection', () => Promise.reject(new Error('backend down')), 'unavailable'],
  // The whole answer replaced: not the library's result object at all, so no verdict.
  ...[['undefined', undefined], ['null', null], ['{}', {}], ['[]', []], ['1', 1], ['0', 0], ['\'\'', ''], ['\'true\'', 'true'], ['true', true], ['false', false]]
    .map(([name, value]) => [`the whole answer ${name}`, () => value, 'unavailable']),
  // Verified, but the user verification the ceremony required is not reported: the library did not do what it was asked.
  ['verified: true without userVerified', async run => { const answer = await run(); return { ...answer, registrationInfo: { ...answer.registrationInfo, userVerified: false } } }, 'unavailable'],
  // Job 11: one of the library's own verdict throws, after a passing screen, is NOT a verdict (a throw is never a checked-wrong
  // proof): 503, no miss, the challenge kept. (Before job 11 these were counted as a miss.)
  ['the library\'s own verdict message (a wrong challenge), thrown after a passing screen', () => { throw new Error('Unexpected registration response challenge "x", expected "y"') }, 'unavailable'],
  ['the library\'s own verdict code UNEXPECTED_ORIGIN, thrown after a passing screen', () => { throw Object.assign(new Error('Unexpected response origin'), { code: 'UNEXPECTED_ORIGIN' }) }, 'unavailable'],
  ['the library\'s own verdict code UNEXPECTED_RP_ID, thrown after a passing screen', () => { throw Object.assign(new Error('Unexpected RP ID hash'), { code: 'UNEXPECTED_RP_ID' }) }, 'unavailable'],
  ['the library\'s user-verification message, thrown after a passing screen', () => { throw new Error('User verification was required, but user could not be verified') }, 'unavailable'],
]

for (const [name, answer, expected] of ROWS) {
  test(`job 9 TABLE: device add (the door's registration, Worker and HEAD): the verifier answers ${name}`, async t => {
    const fx = await fixture(t)
    const device = passkeyPair()
    const issued = await fx.call(PASSKEY_DEVICE_ROUTES.addChallenge, { method: 'POST', body: { code: fx.code } })
    assert.equal(issued.response.status, 200, JSON.stringify(issued.body))
    const held = await fx.pending(), budgets = await fx.ownerBudgets()
    registration.answer = answer
    let result
    try { result = await fx.call(PASSKEY_DEVICE_ROUTES.add, { method: 'POST', body: { code: fx.code, credential: registrationFor(device, issued.body.publicKey.challenge) } }) } finally { registration.answer = null }
    const after = await fx.pending()
    assert.deepEqual(await fx.ownerBudgets(), budgets, `${name}: no owner budget moves`)
    if (expected === 'joins') {
      assert.deepEqual([result.response.status, result.body.schema], [200, 'aukora.aumlok.device-joining.v1'], JSON.stringify(result.body))
      assert.deepEqual([after.misses, after.challenge], [held.misses, null], 'no miss; the challenge is used')
    } else if (expected === 'counted') {
      assert.deepEqual([result.response.status, result.body.code], [403, 'AUMLOK_PROOF_INVALID'], JSON.stringify(result.body))
      assert.deepEqual([after.misses, after.challenge], [held.misses + 1, null], 'one miss; the challenge is used')
    } else {
      assert.deepEqual([result.response.status, result.body.code], [503, 'AUMLOK_UNAVAILABLE'], `${name}: ${JSON.stringify(result.body)}`)
      assert.deepEqual(after, held, `${name}: nothing written, no miss, the challenge kept`)
      const retry = await fx.call(PASSKEY_DEVICE_ROUTES.add, { method: 'POST', body: { code: fx.code, credential: registrationFor(device, issued.body.publicKey.challenge) } })
      assert.deepEqual([retry.response.status, retry.body.schema], [200, 'aukora.aumlok.device-joining.v1'], `${name}: the genuine registration then joins on the same challenge: ${JSON.stringify(retry.body)}`)
    }
  })
}

// ── Job 11: the SCREEN column of the add door's registration. The answer is refused by our screen before the library is
// asked anything (its call count stays 0): the status and code the add page already knows, no miss, nothing written,
// the challenge kept, every owner budget byte-equal; the genuine registration on the same challenge then joins. ──
const SCREENED = [
  ['a wrong origin', { origin: 'https://elsewhere.example.invalid' }, [403, 'AUMLOK_PROOF_INVALID']],
  ['a look-alike origin', { origin: ORIGIN + '.evil.example' }, [403, 'AUMLOK_PROOF_INVALID']],
  ['a wrong RP id', { rpId: 'elsewhere.example.invalid' }, [403, 'AUMLOK_PROOF_INVALID']],
  ['a get() answer (wrong type)', { type: 'webauthn.get' }, [403, 'AUMLOK_PROOF_INVALID']],
  ['user verification off', { flags: 0x41 }, [403, 'AUMLOK_PROOF_INVALID']],
  ['user presence off', { flags: 0x44 }, [403, 'AUMLOK_PROOF_INVALID']],
  // the reviewer's flags 0x55 (backed up, not backup-eligible); the library threw on it after the screen.
  ['backup state without backup eligibility (0x55)', { flags: 0x55 }, [403, 'AUMLOK_PROOF_INVALID']],
  ['a wrong challenge (another this code never issued)', { challenge: 'X'.repeat(43) }, [409, 'AUMLOK_DEVICE_CHALLENGE_UNKNOWN']],
]
function bentRegistration(passkey, challenge, { origin = ORIGIN, rpId = RP_ID, type = 'webauthn.create', flags = 0x45, challenge: named = challenge } = {}) {
  const clientDataJSON = Buffer.from(JSON.stringify({ type, challenge: named, origin, crossOrigin: false })).toString('base64url')
  const idBytes = Buffer.from(passkey.id, 'base64url'), head = Buffer.alloc(55)
  sha(rpId).copy(head); head[32] = flags; head.writeUInt16BE(idBytes.length, 53)
  const authData = Buffer.concat([head, idBytes, Buffer.from(passkey.publicKeyB64, 'base64url')])
  const attestationObject = Buffer.from(isoCBOR.encode(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]))).toString('base64url')
  return { id: passkey.id, rawId: passkey.id, type: 'public-key', clientExtensionResults: {}, response: { clientDataJSON, attestationObject, transports: ['internal'] } }
}
for (const [name, bend, expected] of SCREENED) {
  test(`job 11 TABLE, screen column: device add (the door's registration, Worker and HEAD): ${name} is refused by the screen, the library never asked, no miss, the challenge kept; the seventh in two seconds is bounded at the edge`, async t => {
    // An injected clock (as job 7's admission test): the window is passed by moving it, never by waiting or racing it.
    const clock = { now: Date.now(), offset: 0 }
    t.mock.method(Date, 'now', () => clock.now + clock.offset)
    const fx = await fixture(t)
    const device = passkeyPair()
    const issued = await fx.call(PASSKEY_DEVICE_ROUTES.addChallenge, { method: 'POST', body: { code: fx.code } })
    assert.equal(issued.response.status, 200, JSON.stringify(issued.body))
    const held = await fx.pending(), budgets = await fx.ownerBudgets()
    registration.calls = 0
    for (let attempt = 0; attempt < 6; attempt++) {
      const result = await fx.call(PASSKEY_DEVICE_ROUTES.add, { method: 'POST', body: { code: fx.code, credential: bentRegistration(device, issued.body.publicKey.challenge, bend) } })
      assert.deepEqual([result.response.status, result.body.code], expected, `attempt ${String(attempt + 1)}: ${JSON.stringify(result.body)}`)
    }
    assert.equal(registration.calls, 0, 'the library was never asked')
    assert.deepEqual(await fx.pending(), held, 'six refusals: no miss, nothing written, the challenge kept')
    assert.deepEqual(await fx.ownerBudgets(), budgets, 'no owner budget moves')
    // Job 11 review: the door's registrations are BOUNDED, never counted. The six went to HEAD; the seventh in the same
    // window is refused at the edge (429, its wait), with no HEAD call, and nothing moves.
    const adds = () => fx.headPaths.filter(path => path === '/_host/aumlok/device-add').length
    assert.equal(adds(), 6)
    const bounded = await fx.call(PASSKEY_DEVICE_ROUTES.add, { method: 'POST', body: { code: fx.code, credential: bentRegistration(device, issued.body.publicKey.challenge, bend) } })
    assert.deepEqual([bounded.response.status, bounded.body.code], [429, 'AUMLOK_DEVICE_ADD_BUSY'], JSON.stringify(bounded.body))
    assert.equal(bounded.response.headers.get('retry-after'), String(bounded.body.retryAfterSeconds))
    assert.equal(adds(), 6, 'the bounded request cost no HEAD call')
    assert.deepEqual(await fx.pending(), held, 'and moved nothing')
    // Once the window has passed, the genuine registration on the same challenge joins.
    clock.offset += PASSKEY_DEVICE_CHALLENGE_ADMISSION.windowMs + 1
    const joined = await fx.call(PASSKEY_DEVICE_ROUTES.add, { method: 'POST', body: { code: fx.code, credential: registrationFor(device, issued.body.publicKey.challenge) } })
    assert.deepEqual([joined.response.status, joined.body.schema], [200, 'aukora.aumlok.device-joining.v1'], JSON.stringify(joined.body))
  })
}
