/** Passkey devices: a second (up to fifth) enrolled passkey for the one owner. Real Worker (production access verifier),
 * HeadDO, MirrorDO and AUMLOK store over in-memory storage; synthetic owner, node and passkey keys; real WebAuthn
 * registration and assertion verification; no network. Every refusal path of the owner boundary has a case here. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { isoCBOR } from '@simplewebauthn/server/helpers'
import { aumlokClass3Binding, aumlokInvitePreimage, aumlokStatusAnswer, AUMLOK_INVITE_DOMAIN, AUMLOK_LIMITS, AUMLOK_NODE_DOMAIN, AUMLOK_SIGNIN_STORAGE_KEY, AUMLOK_STORAGE_KEY, createAumlokStore, verifyAumlokInviteReceipt } from '../aumlok.mjs'
import { X61HeadDurableObject, bootstrapPackage, digest, manifestIdCanon } from '../head-do.mjs'
import { MirrorDO } from '../mirror-do.mjs'
import { createWorker, OWNER_PASSKEY } from '../worker.mjs'
import { PASSKEY_DEVICES_PENDING_KEY, PASSKEY_DEVICE_ADD_ACTION, PASSKEY_DEVICE_CHALLENGE_ADMISSION, admitDeviceChallengeAsk, PASSKEY_DEVICE_CONFIRM_ACTION, PASSKEY_DEVICE_DECLINE_ACTION, PASSKEY_DEVICE_LIMITS,
  PASSKEY_DEVICE_REMOVE_ACTION, PASSKEY_DEVICE_ROUTES, deviceCodeHashes, deviceKeyPhrase, passkeyDeviceDoor, readDevicePending, signinAllowCredentials, signinCredentialFor, signinKeyDeviceCode,
  signinKeyDevices } from '../passkey-devices.mjs'
import { projectAumlokStatus } from '../../../../server/verified-facts.mjs'
import { canonicalJson, headPromotionBinding, HYBRID_ENVELOPE_DOMAIN, HYBRID_ENVELOPE_SCHEMA, HYBRID_SIGNATURE_BACKENDS, hybridSignaturesVerdict, verifyHybridEnvelopeV2 } from '../owner-grant-policy.mjs'
import { createOwnerEnrollmentVerifier, OWNER_ENROLLMENT_DOMAIN, OWNER_ENROLLMENT_MODE, OWNER_ENROLLMENT_SCHEMA } from '../enrollment-approval.mjs'
import { SIGNED_ACTION_SCHEMA } from '../signed-action.mjs'
import { ml_dsa65 } from '@noble/post-quantum/ml-dsa.js'
import { JSDOM } from 'jsdom'

const ORIGIN = 'https://passkey-devices.example.invalid'
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
  storage.snapshot = () => JSON.stringify([...rows].filter(([key]) => key.startsWith('aumlok')).sort())
  return storage
}

function passkeyPair(idBytes = 32) {
  const key = generateKeyPairSync('ec', { namedCurve: 'P-256' }), jwk = key.publicKey.export({ format: 'jwk' })
  const id = randomBytes(idBytes).toString('base64url')
  const publicKeyB64 = Buffer.from(isoCBOR.encode(new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]]))).toString('base64url')
  return { key, id, publicKeyB64 }
}
/** An Ed25519 (COSE alg -8) passkey, the other algorithm this node registers. */
function edPasskeyPair(idBytes = 32) {
  const key = generateKeyPairSync('ed25519'), jwk = key.publicKey.export({ format: 'jwk' })
  const id = randomBytes(idBytes).toString('base64url')
  const publicKeyB64 = Buffer.from(isoCBOR.encode(new Map([[1, 1], [3, -8], [-1, 6], [-2, Buffer.from(jwk.x, 'base64url')]]))).toString('base64url')
  return { key, id, publicKeyB64 }
}

/** A WebAuthn get() answer as a browser sends it. */
function assertionFor(passkey, challenge, { origin = ORIGIN, rpId = RP_ID, flags = 0x05, counter = 0, id = passkey.id, signer = passkey.key, userHandle } = {}) {
  const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge, origin, crossOrigin: false })).toString('base64url')
  const auth = Buffer.alloc(37)
  sha(rpId).copy(auth); auth[32] = flags; auth.writeUInt32BE(counter, 33)
  const signature = sign(signer.privateKey.asymmetricKeyType === 'ed25519' ? null : 'sha256', Buffer.concat([auth, sha(Buffer.from(clientDataJSON, 'base64url'))]), signer.privateKey).toString('base64url')
  return { id, rawId: id, type: 'public-key', clientExtensionResults: {}, response: { clientDataJSON, authenticatorData: auth.toString('base64url'), signature,
    ...(userHandle ? { userHandle } : {}) } }
}

/** A WebAuthn create() answer, attestation format 'none', as a browser sends it. Every field can be bent. */
function registrationFor(passkey, challenge, { origin = ORIGIN, rpId = RP_ID, flags = 0x45, type = 'webauthn.create', fmt = 'none', id = passkey.id, transports = ['internal'] } = {}) {
  const clientDataJSON = Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false })).toString('base64url')
  const idBytes = Buffer.from(id, 'base64url'), head = Buffer.alloc(55)
  sha(rpId).copy(head); head[32] = flags; head.writeUInt16BE(idBytes.length, 53)
  const authData = Buffer.concat([head, idBytes, Buffer.from(passkey.publicKeyB64, 'base64url')])
  const attestationObject = Buffer.from(isoCBOR.encode(new Map([['fmt', fmt], ['attStmt', new Map()], ['authData', authData]]))).toString('base64url')
  return { id, rawId: id, type: 'public-key', clientExtensionResults: {}, response: { clientDataJSON, attestationObject, ...(transports === null ? {} : { transports }) } }
}

/** Her store today: no enrollment fields, no audit, no phrase counters, no devices. */
function liveShapedIdentity(passkey, node, at) {
  return { schema: 'aukora.aumlok.state.v2', generation: 1,
    binding: { aumlokId: 'a'.repeat(64), recoveryCommitment: 'b'.repeat(64), nodePubkeyHex: keyHex(node),
      rootEscrow: { schema: 'aukora.aumlok.escrow.v2', ivB64: Buffer.alloc(12, 1).toString('base64url'), ciphertextB64: Buffer.alloc(48, 2).toString('base64url') },
      credential: { id: passkey.id, counter: 0, publicKeyB64: passkey.publicKeyB64 }, boundAt: at, lastVerifiedAt: at, generation: 1 },
    'pepper.v1': randomBytes(32).toString('base64url'), challenges: [], invites: [], revocations: [], failures: 0, failedAt: [], nextAllowedAt: 0, attempts: [], approvals: [] }
}

async function fixture(t, { cleanup = true, passkey = passkeyPair() } = {}) {
  const at = Date.now(), headStorage = memoryStorage(), mirrorStorage = memoryStorage()
  const owner = generateKeyPairSync('ed25519'), node = generateKeyPairSync('ed25519')
  // The handle her authenticator returns with every assertion (the bind ceremony's user.id).
  const userHandle = randomBytes(32).toString('base64url')
  const identity = liveShapedIdentity(passkey, node, at)
  const env = { PUBLIC_HOST: new URL(ORIGIN).host, OWNER_EMAIL: OWNER, OWNER_PUBLIC_KEY_HEX: keyHex(owner) }
  let network = 0
  const noNetwork = async () => { network++; throw new Error('Network forbidden in passkey devices fixture') }
  const head = new X61HeadDurableObject({ storage: headStorage, getWebSockets: () => [] }, env, { networkFetch: noNetwork })
  const mirror = new MirrorDO({ storage: mirrorStorage })
  const doCalls = []
  env.HEAD = { idFromName: value => value, get: () => ({ fetch: request => (doCalls.push('HEAD ' + new URL(request.url).pathname), head.fetch(request)) }) }
  env.MIRROR = { idFromName: value => value, get: () => ({ fetch: request => (doCalls.push('MIRROR ' + new URL(request.url).pathname), mirror.fetch(request)) }) }
  env.ASSETS = { fetch() { return new Response('Fixture asset') } }
  t.after(() => assert.equal(network, 0))
  // Each named isolate is its own Worker (its own sign-in key and challenge caches), made on first use.
  const workers = {}
  const worker = name => workers[name] ??= createWorker({ networkFetch: noNetwork })
  const jwt = () => {
    const payload = encode({ alg: 'EdDSA', typ: 'JWT' }) + '.' + encode({ iss: 'aukora.x61.owner', aud: env.PUBLIC_HOST, email: OWNER,
      nbf: Math.floor(Date.now() / 1000) - 1, exp: Math.floor(Date.now() / 1000) + 600 })
    return payload + '.' + sign(null, Buffer.from(payload), owner.privateKey).toString('base64url')
  }
  const call = async (path, { method = 'GET', body, cookie, address = '203.0.113.20', headers = {}, isolate = 'A' } = {}) => {
    const response = await worker(isolate).fetch(new Request(new URL(path, ORIGIN), { method,
      headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'cf-connecting-ip': address,
        ...(method === 'POST' ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...headers },
      ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) }), env)
    const text = await response.text()
    let parsed = text
    try { parsed = JSON.parse(text) } catch { /* HTML */ }
    return { response, body: parsed, text }
  }
  const source = 'export const fixture = true;', moduleSha = await digest(source)
  const draft = { version: 'x6.1-ball/v1', epoch: 1, parentBallId: null, authorPeerId: 'fixture-peer',
    entries: { fixture: { id: 'fixture', specifier: `ball:${moduleSha}`, disabled: false, config: {}, previousSpecifiers: [] } },
    modules: { [moduleSha]: { sha256: moduleSha, specifier: `ball:${moduleSha}` } } }
  const seedBall = { ...draft, ballId: await manifestIdCanon(draft) }
  const seed = await bootstrapPackage({ version: 'x61-bootstrap/v1', ball: seedBall, codeBySha: { [moduleSha]: source }, mirror: { entryCount: 0, batchDigests: [] } })
  for (const input of [{ action: 'prepare', package: seed }, { action: 'commit', seedId: seed.seedId }]) {
    const result = await call('/_bootstrap', { method: 'POST', body: input, headers: { 'x-x6-owner-assertion': jwt() } })
    assert.equal(result.response.status, 200, JSON.stringify(result.body))
  }
  await headStorage.put(AUMLOK_STORAGE_KEY, identity)
  const cookieOf = response => (response.headers.get('set-cookie') ?? '').split(';')[0]
  /** Sign in with one enrolled passkey; returns the session cookie. */
  const signIn = async (who = passkey, options = {}) => {
    const issued = await call(OWNER_PASSKEY.challenge, { method: 'POST', body: {}, ...options })
    assert.equal(issued.response.status, 200, JSON.stringify(issued.body))
    const done = await call(OWNER_PASSKEY.signin, { method: 'POST', body: { challengeId: issued.body.challengeId, credential: assertionFor(who, issued.body.publicKey.challenge) }, ...options })
    return { ...done, issued: issued.body, cookie: cookieOf(done.response) }
  }
  let request = 0
  /** Every approval ceremony completed through `approve`, in order: its challenge id and the assertion sent. */
  const approvals = []
  /** A Class 3 approval of one exact POST, made by `who` (the primary or an enrolled device) through the Worker. */
  const approve = async (cookie, pathname, body, who = passkey, handle = userHandle, { keep = false } = {}) => {
    // The store holds eight approvals for five minutes; these tests run many approvals inside one minute, so earlier
    // approvals are let go first, as five minutes passing would (HEAD's clock is the real one). Every approval a test uses
    // is made right before its use. `keep` keeps the earlier approvals, for a test that holds several outstanding at once.
    // (Finished ceremonies are let go too, as before; since job 4 they no longer hold a slot anyway.) A fixture made with
    // `cleanup: false` touches nothing: the reviewer's sequences run on the store exactly as the routes leave it.
    if (cleanup) {
      const held = await headStorage.get(AUMLOK_STORAGE_KEY)
      await headStorage.put(AUMLOK_STORAGE_KEY, { ...held, challenges: held.challenges.filter(record => record.consumedAt === null), ...(keep ? {} : { approvals: [] }) })
    }
    const binding = await aumlokClass3Binding({ audience: ORIGIN, method: 'POST', pathname, body })
    const challenge = await call('/_host/aumlok/challenge', { method: 'POST', cookie, body: { purpose: 'approve', requestId: `approve-${String(++request)}`, binding } })
    assert.equal(challenge.response.status, 200, JSON.stringify(challenge.body))
    const sent = { challengeId: challenge.body.challengeId, credential: assertionFor(who, challenge.body.publicKey.challenge, { userHandle: handle }) }
    const done = await call('/_host/aumlok/approve', { method: 'POST', cookie, body: sent })
    assert.equal(done.response.status, 200, JSON.stringify(done.body))
    approvals.push(sent)
    return { allow: challenge.body.publicKey.allowCredentials, token: done.body.approvalToken }
  }
  const generation = async () => (await headStorage.get(AUMLOK_STORAGE_KEY)).generation
  const codeBody = async (label = 'Work laptop') => ({ action: PASSKEY_DEVICE_ADD_ACTION, label, expiresAt: Date.now() + PASSKEY_DEVICE_LIMITS.codeMs, generation: await generation() })
  /** The owner makes a one-time code (approved by `who`). */
  const makeCode = async (cookie, who = passkey, label = 'Work laptop') => {
    const body = await codeBody(label)
    const { token } = await approve(cookie, PASSKEY_DEVICE_ROUTES.code, body, who)
    const made = await call(PASSKEY_DEVICE_ROUTES.code, { method: 'POST', cookie, body, headers: { 'x-x6-class3-approval': token } })
    assert.equal(made.response.status, 200, JSON.stringify(made.body))
    return made.body
  }
  let ownerSession = null
  /** One primary session the helpers below confirm with when a test names none. */
  const ownerCookie = async () => ownerSession ??= (await signIn()).cookie
  /** Step two: a signed-in ENROLLED passkey (`who`) confirms the joining credential, on the key hash and instance the list names. */
  const confirmDevice = async (cookie, deviceId, who = passkey, { keyHash, instance } = {}) => {
    const list = await call(PASSKEY_DEVICE_ROUTES.list, { cookie })
    assert.equal(list.response.status, 200, JSON.stringify(list.body))
    const body = { action: PASSKEY_DEVICE_CONFIRM_ACTION, deviceId, keyHash: keyHash ?? list.body.joining?.keyHash ?? 'f'.repeat(64),
      instance: instance ?? list.body.joining?.instance ?? 'A'.repeat(43), generation: list.body.generation }
    const { token } = await approve(cookie, PASSKEY_DEVICE_ROUTES.confirm, body, who)
    return call(PASSKEY_DEVICE_ROUTES.confirm, { method: 'POST', cookie, body, headers: { 'x-x6-class3-approval': token } })
  }
  /**
   * The new computer: no session, only the code. Its registration only JOINS (`joined`); unless `confirm` is false, the
   * owner's primary then confirms that exact key (`added`).
   */
  const addDevice = async (code, device = passkeyPair(), bend = {}, options = {}, { confirm = true, cookie, who = passkey } = {}) => {
    const challenge = await call(PASSKEY_DEVICE_ROUTES.addChallenge, { method: 'POST', body: { code }, ...options })
    if (challenge.response.status !== 200) return { challenge, device }
    const joined = await call(PASSKEY_DEVICE_ROUTES.add, { method: 'POST', body: { code, credential: registrationFor(device, challenge.body.publicKey.challenge, bend) }, ...options })
    if (joined.response.status !== 200 || !confirm) return { challenge, joined, device }
    const added = await confirmDevice(cookie ?? await ownerCookie(), joined.body.deviceId, who)
    return { challenge, joined, added, device }
  }
  const ownerCounters = async () => {
    const state = await headStorage.get(AUMLOK_STORAGE_KEY)
    return { failures: state.failures, failedAt: state.failedAt, nextAllowedAt: state.nextAllowedAt, phraseFailures: state.phraseFailures ?? 0,
      headGates: await headStorage.get('gate-lockout:v1') ?? null }
  }
  return { env, head, call, signIn, approve, approvals, makeCode, addDevice, confirmDevice, codeBody, passkey, userHandle, headStorage, ownerCounters, doCalls, cookieOf, generation, seedId: seed.seedId,
    owner, node, seedBall }
}

/** The audit's name for a device credential (aumlok.mjs auditCredential), folded into the outcome as `_D_<16 HEX>`. */
const auditName = id => createHash('sha256').update('aukora.aumlok.audit-credential.v1\0' + id).digest('hex').slice(0, 16).toUpperCase()
/** True when an audit row names a device credential (its outcome ends `_D_<16 HEX>`). */
const namesDevice = record => /_D_[0-9A-F]{16}$/.test(record.outcome)
/**
 * THE BUILD BEFORE DEVICES' AUDIT ROW RULE, verbatim from an earlier commit deploy/cloudflare/src/aumlok.mjs:406-408: exactly these
 * six keys, and an outcome of /^[A-Z0-9_]{1,80}$/. A row this returns false for makes that build refuse the whole store.
 */
const oldBuildReadsAttempt = record => JSON.stringify(Object.keys(record)) === JSON.stringify(['schema', 'sequence', 'at', 'purpose', 'outcome', 'ipHash32'])
  && record.schema === 'aumlok.attempt.v1' && typeof record.outcome === 'string' && /^[A-Z0-9_]{1,80}$/.test(record.outcome)
  && typeof record.purpose === 'string' && /^[a-z-]{1,24}$/.test(record.purpose) && /^[0-9a-f]{8}$/.test(record.ipHash32)

const STATUS_KEYS = ['ok', 'schema', 'phase', 'bound', 'passkeyVerified', 'aumlokId', 'nodePubkeyHex', 'commitmentSha256', 'boundAt', 'lastVerifiedAt',
  'enrollmentCount', 'rotationSeq', 'lastRotationChallengeId', 'pepperSeparated', 'pepperMigrationRequired', 'phraseBlockers', 'keyCommitmentId', 'approvedGrants',
  'authorityAvailable', 'enrollmentAvailable', 'blockers', 'biometricVerified', 'phraseRecoveryAvailable', 'identityIsKey', 'domainIsPointer', 'invite'].sort()

test('a store shaped like hers today (no devices field) loads and behaves exactly as before: sign-in, approval, status, facts', async t => {
  const fx = await fixture(t)
  const signed = await fx.signIn()
  assert.equal(signed.response.status, 200, JSON.stringify(signed.body))
  // The challenge names exactly the one bound credential, as before.
  assert.deepEqual(signed.issued.publicKey.allowCredentials, [{ type: 'public-key', id: fx.passkey.id }])
  const { allow } = await fx.approve(signed.cookie, '/_head/promote', { candidate: 'fixture' })
  assert.deepEqual(allow, [{ type: 'public-key', id: fx.passkey.id }])
  const status = await fx.call('/_host/aumlok/status', { cookie: signed.cookie })
  assert.equal(status.response.status, 200)
  // The public status keeps its exact shape; each approval leaves out only its recordMac (the store's own MAC), and the
  // facts projection, which reads the store in process, still accepts it.
  assert.deepEqual(Object.keys(status.body).sort(), STATUS_KEYS)
  assert.equal(status.body.enrollmentCount, 1)
  assert.deepEqual(Object.keys(status.body.approvedGrants[0]).sort(), ['approvalId', 'approvedAt', 'binding', 'consumedAt', 'expiresAt', 'generation', 'schema'])
  const inProcess = await createAumlokStore(fx.headStorage, { origins: [ORIGIN], ownerPublicKeyHex: fx.env.OWNER_PUBLIC_KEY_HEX }).status()
  assert.equal(projectAumlokStatus(inProcess).phase, 'BOUND')
  assert.equal(inProcess.approvedGrants[0].approvalId, status.body.approvedGrants[0].approvalId)
  // Nothing new was written: no devices field, no private approval fields, no device on the session, no pending record.
  const state = await fx.headStorage.get(AUMLOK_STORAGE_KEY)
  assert.equal(Object.hasOwn(state, 'devices'), false)
  assert.deepEqual(Object.keys(state.binding).sort(), ['aumlokId', 'boundAt', 'credential', 'generation', 'lastVerifiedAt', 'nodePubkeyHex', 'recoveryCommitment', 'rootEscrow'])
  assert.equal(state.generation, 1)
  assert.ok(state.approvals.every(approval => !Object.hasOwn(approval, 'approvedBy') && !Object.hasOwn(approval, 'userHandle')))
  assert.ok((await fx.headStorage.get(AUMLOK_SIGNIN_STORAGE_KEY)).sessions.every(item => Object.keys(item).length === 4))
  assert.equal(await fx.headStorage.get(PASSKEY_DEVICES_PENDING_KEY), undefined)
  // HEAD's signin-key names no devices for her store.
  const store = createAumlokStore(fx.headStorage, { origins: [ORIGIN], ownerPublicKeyHex: fx.env.OWNER_PUBLIC_KEY_HEX })
  assert.equal(Object.hasOwn(await store.complete('signin-key', {}, ORIGIN), 'devices'), false)
  // The devices list reads her store too (primary only, nothing pending).
  const list = await fx.call(PASSKEY_DEVICE_ROUTES.list, { cookie: signed.cookie })
  assert.equal(list.response.status, 200, JSON.stringify(list.body))
  assert.deepEqual([list.body.primary.id, list.body.devices, list.body.pending, list.body.limit], [fx.passkey.id, [], null, 4])
  assert.equal(Object.hasOwn(await fx.headStorage.get(AUMLOK_STORAGE_KEY), 'devices'), false, 'reading the list writes nothing')
})

test('add a device: Class 3 code, registration on the new computer JOINS only, the owner confirms the exact key, then it signs in and approves', async t => {
  const fx = await fixture(t)
  const primary = await fx.signIn()
  const bindingBefore = (await fx.headStorage.get(AUMLOK_STORAGE_KEY)).binding
  const made = await fx.makeCode(primary.cookie)
  assert.match(made.code, /^[A-Za-z0-9_-]{43}$/)
  assert.equal(made.link, `${ORIGIN}/_auth/passkey/add#${made.code}`)
  assert.ok(made.expiresAt - Date.now() <= PASSKEY_DEVICE_LIMITS.codeMs)
  assert.equal(made.sameUserHandle, true)
  // The code is stored only as hashes.
  const pending = await fx.headStorage.get(PASSKEY_DEVICES_PENDING_KEY)
  assert.ok(readDevicePending(pending) !== null)
  assert.ok(!JSON.stringify(pending).includes(made.code) && !JSON.stringify(pending).includes(made.code.slice(0, 11)))
  // The new computer (no cookie) asks for the registration options.
  const device = passkeyPair()
  const issued = await fx.call(PASSKEY_DEVICE_ROUTES.addChallenge, { method: 'POST', body: { code: made.code }, address: '198.51.100.7' })
  assert.equal(issued.response.status, 200, JSON.stringify(issued.body))
  const options = issued.body.publicKey
  assert.equal(options.rp.id, RP_ID)
  assert.equal(options.user.id, fx.userHandle, 'the same user handle as the binding')
  assert.deepEqual(options.excludeCredentials, [{ type: 'public-key', id: fx.passkey.id }], 'a keychain holding the first passkey refuses instead of overwriting it')
  assert.deepEqual(options.authenticatorSelection, { residentKey: 'required', requireResidentKey: true, userVerification: 'required' })
  assert.equal(options.attestation, 'none')
  const joined = await fx.call(PASSKEY_DEVICE_ROUTES.add, { method: 'POST', body: { code: made.code, credential: registrationFor(device, options.challenge) }, address: '198.51.100.7' })
  assert.equal(joined.response.status, 200, JSON.stringify(joined.body))
  assert.equal(joined.response.headers.has('set-cookie'), false, 'joining signs nobody in')
  // STEP ONE ENROLS NOTHING: the new page gets the phrase of its own key; aumlok:v1 holds no device yet.
  const jwk = device.key.publicKey.export({ format: 'jwk' })
  const keyHash = createHash('sha256').update(Buffer.concat([Buffer.of(4), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')])).digest('hex')
  assert.deepEqual([joined.body.schema, joined.body.deviceId, joined.body.label, joined.body.phrase], ['aukora.aumlok.device-joining.v1', device.id, 'Work laptop', deviceKeyPhrase(keyHash)])
  assert.match(joined.body.phrase, /^[0-9]{3} [0-9]{3}$/)
  assert.equal(joined.body.expiresAt - (await fx.headStorage.get(PASSKEY_DEVICES_PENDING_KEY)).pending.joining.registeredAt, PASSKEY_DEVICE_LIMITS.joinMs)
  assert.equal(Object.hasOwn(await fx.headStorage.get(AUMLOK_STORAGE_KEY), 'devices'), false, 'nothing enrolled before the owner confirms')
  // The joining credential cannot sign in (not even offered), and its code is spent (a second registration is refused).
  const early = await fx.call(OWNER_PASSKEY.challenge, { method: 'POST', body: {} })
  assert.deepEqual(early.body.publicKey.allowCredentials.map(item => item.id), [fx.passkey.id])
  const tooEarly = await fx.call(OWNER_PASSKEY.signin, { method: 'POST', body: { challengeId: early.body.challengeId, credential: assertionFor(device, early.body.publicKey.challenge) } })
  assert.deepEqual([tooEarly.response.status, tooEarly.body.code], [403, 'AUMLOK_SIGNIN_PROOF_INVALID'])
  const second = await fx.call(PASSKEY_DEVICE_ROUTES.addChallenge, { method: 'POST', body: { code: made.code } })
  assert.deepEqual([second.response.status, second.body.code], [403, 'AUMLOK_DEVICE_CODE_INVALID'])
  // STEP TWO: the owner's enrolled passkey sees "a new device asks to join", with the same phrase, and confirms that key.
  const list = await fx.call(PASSKEY_DEVICE_ROUTES.list, { cookie: primary.cookie })
  assert.deepEqual(list.body.joining, { id: device.id, label: 'Work laptop', keyHash, instance: list.body.joining.instance, phrase: joined.body.phrase,
    registeredAt: list.body.joining.registeredAt, expiresAt: joined.body.expiresAt })
  assert.match(list.body.joining.instance, /^[A-Za-z0-9_-]{43}$/, 'the joining carries its own instance')
  assert.equal(Object.hasOwn(joined.body, 'instance'), false, 'the new device is not told it')
  assert.equal(list.body.pending, null, 'the used code is no longer waiting')
  const added = await fx.confirmDevice(primary.cookie, device.id)
  assert.equal(added.response.status, 200, JSON.stringify(added.body))
  assert.deepEqual([added.body.deviceId, added.body.label, added.body.deviceCount], [device.id, 'Work laptop', 1])
  const state = await fx.headStorage.get(AUMLOK_STORAGE_KEY)
  // The binding keeps its shape, its credential and its generation; the device sits beside it.
  assert.deepEqual(Object.keys(state.binding).sort(), Object.keys(bindingBefore).sort())
  assert.equal(state.binding.credential.id, fx.passkey.id)
  assert.equal(state.generation, bindingBefore.generation)
  assert.equal(state.enrollmentCount ?? 1, 1)
  assert.deepEqual(state.devices.map(item => [item.credential.id, item.label, item.approvedBy]), [[device.id, 'Work laptop', fx.passkey.id]])
  assert.match(state.devices[0].instance, /^[A-Za-z0-9_-]{43}$/, 'an enrolment instance is minted at the confirm')
  assert.deepEqual(state.attempts.map(item => item.purpose).filter(purpose => purpose.startsWith('device')), ['device-code', 'device-join', 'device-add'])
  assert.deepEqual((await fx.headStorage.get(PASSKEY_DEVICES_PENDING_KEY)).pending, null, 'single use')
  // Round trip: a fresh store reads it back, and the facts projection still accepts the status.
  const reopened = createAumlokStore(fx.headStorage, { origins: [ORIGIN], ownerPublicKeyHex: fx.env.OWNER_PUBLIC_KEY_HEX })
  const status = await reopened.status()
  assert.deepEqual(Object.keys(status).sort(), STATUS_KEYS)
  assert.equal(projectAumlokStatus(status).phase, 'BOUND')
  // The new device signs in, through the other isolate too; the challenge lists both credentials.
  const deviceSignin = await fx.signIn(device, { isolate: 'B' })
  assert.equal(deviceSignin.response.status, 200, JSON.stringify(deviceSignin.body))
  assert.deepEqual(deviceSignin.issued.publicKey.allowCredentials.map(item => item.id), [fx.passkey.id, device.id])
  assert.equal((await fx.call('/_host/aumlok/status', { cookie: deviceSignin.cookie, isolate: 'B' })).response.status, 200)
  const sessions = (await fx.headStorage.get(AUMLOK_SIGNIN_STORAGE_KEY)).sessions
  assert.equal(sessions.at(-1).device, device.id, 'the session names the credential actually used')
  assert.equal(sessions.filter(item => item.device === undefined).length, 1)
  // THE AUDIT NAMES THE CREDENTIAL USED (a fixed-size hash of its id, inside the outcome); every row keeps the old shape.
  const signinRecordOf = (await fx.headStorage.get(AUMLOK_STORAGE_KEY)).attempts.at(-1)
  assert.deepEqual([signinRecordOf.purpose, signinRecordOf.outcome], ['signin-device', `VERIFIED_D_${auditName(device.id)}`])
  assert.ok(oldBuildReadsAttempt(signinRecordOf), JSON.stringify(signinRecordOf))
  // The primary still signs in.
  assert.equal((await fx.signIn()).response.status, 200)
  assert.deepEqual((await fx.headStorage.get(AUMLOK_STORAGE_KEY)).attempts.at(-1).outcome, 'VERIFIED')
  // The device approves a Class 3 action (its own counter moves; the binding's does not).
  const { allow, token } = await fx.approve(deviceSignin.cookie, '/_head/promote', { candidate: 'fixture' }, device)
  assert.deepEqual(allow.map(item => item.id), [fx.passkey.id, device.id])
  assert.equal(typeof token, 'string')
  const approvals = (await fx.headStorage.get(AUMLOK_STORAGE_KEY)).approvals
  assert.equal(approvals.at(-1).approvedBy, device.id)
  assert.equal(approvals.at(-1).approvedInstance, (await fx.headStorage.get(AUMLOK_STORAGE_KEY)).devices[0].instance)
  const approveRecord = (await fx.headStorage.get(AUMLOK_STORAGE_KEY)).attempts.at(-1)
  assert.deepEqual([approveRecord.purpose, approveRecord.outcome], ['complete', `VERIFIED_D_${auditName(device.id)}`])
  assert.ok(oldBuildReadsAttempt(approveRecord), JSON.stringify(approveRecord))
  assert.equal(Object.hasOwn(approvals.at(-1), 'userHandle'), false, 'the handle is kept only for a device-code approval')
  // HEAD's signin-key now names the device's public key.
  const key = await reopened.complete('signin-key', {}, ORIGIN)
  assert.deepEqual(key.devices, [{ id: device.id, publicKeyB64: device.publicKeyB64, transports: ['internal'] }])
  assert.deepEqual(signinAllowCredentials({ credentialId: key.credentialId, devices: signinKeyDevices(key) }).map(item => item.id), [fx.passkey.id, device.id])
})

test('removing a device: needs the primary or a different device, never itself; the primary is not removable; its sessions end', async t => {
  const fx = await fixture(t)
  const primary = await fx.signIn()
  const first = await fx.addDevice((await fx.makeCode(primary.cookie, fx.passkey, 'Phone')).code)
  const second = await fx.addDevice((await fx.makeCode(primary.cookie, fx.passkey, 'Desk')).code)
  assert.equal(first.added.response.status, 200); assert.equal(second.added.response.status, 200)
  const firstSession = await fx.signIn(first.device)
  const removeBody = async deviceId => ({ action: PASSKEY_DEVICE_REMOVE_ACTION, deviceId, generation: await fx.generation() })
  const remove = async (cookie, deviceId, who) => {
    const body = await removeBody(deviceId)
    const { token } = await fx.approve(cookie, PASSKEY_DEVICE_ROUTES.remove, body, who)
    return fx.call(PASSKEY_DEVICE_ROUTES.remove, { method: 'POST', cookie, body, headers: { 'x-x6-class3-approval': token } })
  }
  // No approval at all.
  const bare = await fx.call(PASSKEY_DEVICE_ROUTES.remove, { method: 'POST', cookie: primary.cookie, body: await removeBody(first.device.id) })
  assert.deepEqual([bare.response.status, bare.body.code], [403, 'CLASS3_WEBAUTHN_REQUIRED'])
  // A device cannot remove itself.
  const self = await remove(firstSession.cookie, first.device.id, first.device)
  assert.deepEqual([self.response.status, self.body.code], [403, 'AUMLOK_DEVICE_REMOVE_NEEDS_OTHER_PASSKEY'])
  // An approval for other bytes (another device) does not remove this one.
  const otherBody = await removeBody(second.device.id), { token: otherToken } = await fx.approve(primary.cookie, PASSKEY_DEVICE_ROUTES.remove, otherBody)
  const swapped = await fx.call(PASSKEY_DEVICE_ROUTES.remove, { method: 'POST', cookie: primary.cookie, body: await removeBody(first.device.id), headers: { 'x-x6-class3-approval': otherToken } })
  assert.deepEqual([swapped.response.status, swapped.body.code], [403, 'CLASS3_WEBAUTHN_REQUIRED'])
  // The primary is never removable here, whoever approves.
  const primaryRemoval = await remove(firstSession.cookie, fx.passkey.id, first.device)
  assert.deepEqual([primaryRemoval.response.status, primaryRemoval.body.code], [403, 'AUMLOK_DEVICE_PRIMARY_NOT_REMOVABLE'])
  const unknown = await remove(primary.cookie, passkeyPair().id)
  assert.deepEqual([unknown.response.status, unknown.body.code], [404, 'AUMLOK_DEVICE_NOT_FOUND'])
  assert.equal((await fx.headStorage.get(AUMLOK_STORAGE_KEY)).devices.length, 2, 'nothing removed by a refusal')
  // A DIFFERENT device removes the first one; the first device's session ends on its next request, in every isolate.
  const secondSession = await fx.signIn(second.device)
  const removed = await remove(secondSession.cookie, first.device.id, second.device)
  assert.equal(removed.response.status, 200, JSON.stringify(removed.body))
  assert.equal(removed.body.deviceCount, 1)
  for (const isolate of ['A', 'B']) assert.equal((await fx.call('/_host/aumlok/status', { cookie: firstSession.cookie, isolate })).response.status, 401, isolate)
  assert.equal((await fx.call('/_host/aumlok/status', { cookie: primary.cookie })).response.status, 200, 'the primary session lives on')
  // The removed device can no longer sign in, nor approve.
  const issued = await fx.call(OWNER_PASSKEY.challenge, { method: 'POST', body: {} })
  assert.deepEqual(issued.body.publicKey.allowCredentials.map(item => item.id), [fx.passkey.id, second.device.id])
  const refused = await fx.call(OWNER_PASSKEY.signin, { method: 'POST', body: { challengeId: issued.body.challengeId, credential: assertionFor(first.device, issued.body.publicKey.challenge) } })
  assert.deepEqual([refused.response.status, refused.body.code], [403, 'AUMLOK_SIGNIN_PROOF_INVALID'])
  // The primary removes the second.
  assert.equal((await remove(primary.cookie, second.device.id)).response.status, 200)
  const state = await fx.headStorage.get(AUMLOK_STORAGE_KEY)
  // The last removal leaves no `devices` key at all: the stored shape is the one the build before devices reads.
  assert.equal(Object.hasOwn(state, 'devices'), false)
  assert.ok((await fx.headStorage.get(AUMLOK_SIGNIN_STORAGE_KEY)).sessions.every(item => !Object.hasOwn(item, 'device')), 'no device session is left')
  assert.deepEqual(state.attempts.map(item => item.purpose).filter(purpose => purpose === 'device-remove'), ['device-remove', 'device-remove'])
  assert.equal(state.binding.credential.id, fx.passkey.id)
})

test('the code: unknown codes write nothing; wrong ones burn after five tries; expired, used and stale codes are refused', async t => {
  const fx = await fixture(t)
  const primary = await fx.signIn()
  const counters = await fx.ownerCounters()
  // Malformed codes cost no durable call at all.
  const calls = fx.doCalls.length
  for (const code of ['', 'short', 'x'.repeat(44), '+'.repeat(43), 'A'.repeat(42) + 'B']) {
    const result = await fx.call(PASSKEY_DEVICE_ROUTES.addChallenge, { method: 'POST', body: { code } })
    assert.equal(result.response.status, 403, code); assert.equal(result.body.code, 'AUMLOK_DEVICE_CODE_INVALID', code)
  }
  for (const body of ['{}', '[]', 'null', '{"code":"x","extra":1}', 'not json']) {
    assert.equal((await fx.call(PASSKEY_DEVICE_ROUTES.addChallenge, { method: 'POST', body })).response.status, 400, body)
  }
  assert.equal((await fx.call(PASSKEY_DEVICE_ROUTES.addChallenge, { method: 'GET' })).response.status, 405)
  assert.equal((await fx.call(PASSKEY_DEVICE_ROUTES.addChallenge, { method: 'POST', body: { code: 'A'.repeat(43) }, headers: { 'sec-fetch-site': 'same-site' } })).response.status, 403)
  assert.equal((await fx.call(PASSKEY_DEVICE_ROUTES.add + '?x=1', { method: 'POST', body: {} })).response.status, 404)
  assert.equal(fx.doCalls.length, calls, 'refused in the Worker')
  // With nothing pending, a well-formed code reads one small record and writes nothing.
  const before = fx.headStorage.snapshot()
  const stranger = randomBytes(32).toString('base64url')
  const none = await fx.call(PASSKEY_DEVICE_ROUTES.addChallenge, { method: 'POST', body: { code: stranger } })
  assert.deepEqual([none.response.status, none.body.code], [403, 'AUMLOK_DEVICE_CODE_INVALID'])
  assert.equal(fx.headStorage.snapshot(), before)
  const made = await fx.makeCode(primary.cookie)
  // A stranger's code (another first 66 bits) never touches the pending code: a hundred tries write nothing.
  const pendingBefore = fx.headStorage.snapshot()
  for (let index = 0; index < 100; index++) {
    const result = await fx.call(PASSKEY_DEVICE_ROUTES.addChallenge, { method: 'POST', body: { code: randomBytes(32).toString('base64url') }, address: `192.0.2.${String(index)}` })
    assert.equal(result.body.code, 'AUMLOK_DEVICE_CODE_INVALID')
  }
  assert.equal(fx.headStorage.snapshot(), pendingBefore)
  // The right first 66 bits with a wrong remainder: counted; the fifth burns the code.
  const wrong = made.code.slice(0, 11) + randomBytes(32).toString('base64url').slice(11, 42) + 'A'
  assert.notEqual(wrong, made.code)
  for (let tries = 1; tries <= 4; tries++) {
    const result = await fx.call(PASSKEY_DEVICE_ROUTES.addChallenge, { method: 'POST', body: { code: wrong } })
    assert.deepEqual([result.response.status, result.body.code], [403, 'AUMLOK_DEVICE_CODE_INVALID'])
    assert.equal((await fx.headStorage.get(PASSKEY_DEVICES_PENDING_KEY)).pending.misses, tries)
  }
  const burned = await fx.call(PASSKEY_DEVICE_ROUTES.addChallenge, { method: 'POST', body: { code: wrong } })
  assert.deepEqual([burned.response.status, burned.body.code], [403, 'AUMLOK_DEVICE_CODE_BURNED'])
  const late = await fx.call(PASSKEY_DEVICE_ROUTES.addChallenge, { method: 'POST', body: { code: made.code } })
  assert.deepEqual([late.response.status, late.body.code], [403, 'AUMLOK_DEVICE_CODE_INVALID'], 'a burned code is gone, even the right one')
  // Expired: the code was made eleven minutes ago.
  const old = await fx.makeCode(primary.cookie)
  const record = await fx.headStorage.get(PASSKEY_DEVICES_PENDING_KEY)
  record.pending.issuedAt -= 660000; record.pending.expiresAt -= 660000
  await fx.headStorage.put(PASSKEY_DEVICES_PENDING_KEY, record)
  const expired = await fx.call(PASSKEY_DEVICE_ROUTES.addChallenge, { method: 'POST', body: { code: old.code } })
  assert.deepEqual([expired.response.status, expired.body.code], [409, 'AUMLOK_DEVICE_CODE_EXPIRED'])
  assert.equal((await fx.headStorage.get(PASSKEY_DEVICES_PENDING_KEY)).pending, null)
  // Used: a code adds exactly one device.
  const once = await fx.makeCode(primary.cookie)
  assert.equal((await fx.addDevice(once.code)).added.response.status, 200)
  const again = await fx.addDevice(once.code)
  assert.deepEqual([again.challenge.response.status, again.challenge.body.code], [403, 'AUMLOK_DEVICE_CODE_INVALID'])
  // Issuing a new code replaces the outstanding one.
  const replaced = await fx.makeCode(primary.cookie), current = await fx.makeCode(primary.cookie)
  assert.equal((await fx.addDevice(replaced.code)).challenge.body.code, 'AUMLOK_DEVICE_CODE_INVALID')
  // Stale: a rotation (new identity generation) since the code was made ends it.
  const state = await fx.headStorage.get(AUMLOK_STORAGE_KEY)
  const rotated = { ...state, generation: state.generation + 1, binding: { ...state.binding, generation: state.generation + 1 }, approvals: [], challenges: [] }
  await fx.headStorage.put(AUMLOK_STORAGE_KEY, rotated)
  const stale = await fx.addDevice(current.code)
  assert.deepEqual([stale.challenge.response.status, stale.challenge.body.code], [409, 'AUMLOK_DEVICE_CODE_EXPIRED'])
  // No owner lockout counter or gate moved, whatever the door was sent.
  assert.deepEqual(await fx.ownerCounters(), counters)
})

test('the registration on the new computer is judged by the bind verifier: every bent answer is refused; a bend is screened and never costs a miss (only a strict false would)', async t => {
  // An injected clock (job 7's rule): the edge's two-second window is never raced by a busy machine.
  const clock = { now: Date.now() }
  t.mock.method(Date, 'now', () => clock.now)
  const fx = await fixture(t)
  const primary = await fx.signIn()
  const counters = await fx.ownerCounters()
  const made = await fx.makeCode(primary.cookie)
  const device = passkeyPair()
  const register = async (bend, isolate = 'A') => {
    const issued = await fx.call(PASSKEY_DEVICE_ROUTES.addChallenge, { method: 'POST', body: { code: made.code }, isolate })
    assert.equal(issued.response.status, 200, JSON.stringify(issued.body))
    return fx.call(PASSKEY_DEVICE_ROUTES.add, { method: 'POST', body: { code: made.code, credential: registrationFor(device, issued.body.publicKey.challenge, bend) }, isolate })
  }
  // Without asking for a challenge first: no proof was checked (a missing challenge never counts), nothing written.
  const early = await fx.call(PASSKEY_DEVICE_ROUTES.add, { method: 'POST', body: { code: made.code, credential: registrationFor(device, 'A'.repeat(43)) } })
  assert.deepEqual([early.response.status, early.body.code], [409, 'AUMLOK_DEVICE_CHALLENGE_REQUIRED'])
  assert.equal((await fx.headStorage.get(PASSKEY_DEVICES_PENDING_KEY)).pending.misses, 0)
  // Job 11: a phishing origin, a missing user verification, another RP id, a get() answer are POLICY mismatches, refused by
  // the screen before the library is asked (403, the code the add page knows): no miss, nothing written, the challenge
  // kept (the next ask hands the same live one out again). Before job 11 each cost a miss and the fifth burned the code.
  const first = (await fx.headStorage.get(PASSKEY_DEVICES_PENDING_KEY)).pending
  for (const [name, bend] of [
    ['phishing origin', { origin: 'https://passkey-devices.example.invalid.evil.example' }],
    ['user present, not verified', { flags: 0x41 }],
    ['another RP id', { rpId: 'evil.example' }],
    ['a get() answer', { type: 'webauthn.get' }],
    ['user present, not verified, again', { flags: 0x41 }],
  ]) {
    const result = await register(bend)
    assert.deepEqual([result.response.status, result.body.code], [403, 'AUMLOK_PROOF_INVALID'], name + JSON.stringify(result.body))
    const pending = (await fx.headStorage.get(PASSKEY_DEVICES_PENDING_KEY)).pending
    assert.deepEqual([pending.misses, pending.challenge === null, pending.challengesIssued], [0, false, first.challengesIssued + 1], name)
  }
  // (Job 11 review: those six registration posts filled this isolate's window for the code; the seventh is refused at the
  // edge, 429 with its wait, no HEAD call, nothing moved. The next one is sent through another isolate.)
  const before = (await fx.headStorage.get(PASSKEY_DEVICES_PENDING_KEY)).pending
  const bounded = await fx.call(PASSKEY_DEVICE_ROUTES.add, { method: 'POST', body: { code: made.code, credential: registrationFor(device, before.challenge, { fmt: 'packed' }) } })
  assert.deepEqual([bounded.response.status, bounded.body.code], [429, 'AUMLOK_DEVICE_ADD_BUSY'])
  assert.deepEqual((await fx.headStorage.get(PASSKEY_DEVICES_PENDING_KEY)).pending, before)
  // A well-formed attestation of another format is UNSUPPORTED (400): no miss, and its challenge is kept for a retry.
  const held = (await fx.headStorage.get(PASSKEY_DEVICES_PENDING_KEY)).pending
  const packed = await register({ fmt: 'packed' }, 'B')
  assert.deepEqual([packed.response.status, packed.body.code], [400, 'AUMLOK_ATTESTATION_UNSUPPORTED'])
  const afterPacked = (await fx.headStorage.get(PASSKEY_DEVICES_PENDING_KEY)).pending
  assert.deepEqual([afterPacked.misses, afterPacked.challengesIssued], [0, held.challengesIssued])
  assert.ok(afterPacked.challenge !== null, 'the unsupported answer used no challenge')
  assert.equal(Object.hasOwn(await fx.headStorage.get(AUMLOK_STORAGE_KEY), 'devices'), false, 'nothing was enrolled')
  // A registration naming an ALREADY ENROLLED CREDENTIAL ID (here the primary's own id and key) is refused, never stored
  // twice; it is a GENUINE registration refused by policy, so it takes no miss, and its challenge is used. (Whether an authenticator would overwrite its own key is the browser's business: the page sends
  // every enrolled id in excludeCredentials, asserted in the add test; this case is the server's refusal of the id.)
  const fresh = await fx.makeCode(primary.cookie)
  const issued = await fx.call(PASSKEY_DEVICE_ROUTES.addChallenge, { method: 'POST', body: { code: fresh.code } })
  const twiceId = await fx.call(PASSKEY_DEVICE_ROUTES.add, { method: 'POST', body: { code: fresh.code, credential: registrationFor(fx.passkey, issued.body.publicKey.challenge) } })
  assert.deepEqual([twiceId.response.status, twiceId.body.code], [409, 'AUMLOK_DEVICE_ALREADY_ENROLLED'])
  const afterTwice = (await fx.headStorage.get(PASSKEY_DEVICES_PENDING_KEY)).pending
  assert.deepEqual([afterTwice.misses, afterTwice.challenge], [0, null])
  // THE SAME REGISTRATION ANSWER SENT TWICE: the first joins; the second, byte for byte the same, is refused and
  // changes nothing (the challenge was single use and the code is spent by the first).
  const reissued = await fx.call(PASSKEY_DEVICE_ROUTES.addChallenge, { method: 'POST', body: { code: fresh.code } })
  const answer = { code: fresh.code, credential: registrationFor(device, reissued.body.publicKey.challenge) }
  assert.equal((await fx.call(PASSKEY_DEVICE_ROUTES.add, { method: 'POST', body: answer })).response.status, 200)
  const afterFirst = fx.headStorage.snapshot()
  const replay = await fx.call(PASSKEY_DEVICE_ROUTES.add, { method: 'POST', body: answer })
  assert.deepEqual([replay.response.status, replay.body.code], [403, 'AUMLOK_DEVICE_CODE_INVALID'])
  assert.equal(fx.headStorage.snapshot(), afterFirst, 'the second send wrote nothing')
  // Sent straight to HEAD (past the Worker's gate) it is refused there too, still writing nothing.
  const direct = createAumlokStore(fx.headStorage, { origins: [ORIGIN], ownerPublicKeyHex: fx.env.OWNER_PUBLIC_KEY_HEX })
  await assert.rejects(direct.devices('device-add', answer, ORIGIN, {}), error => error.code === 'AUMLOK_DEVICE_CODE_INVALID')
  assert.equal(fx.headStorage.snapshot(), afterFirst)
  assert.equal((await fx.headStorage.get(PASSKEY_DEVICES_PENDING_KEY)).pending.joining.credential.id, device.id, 'one joining credential, the first')
  const binding = (await fx.headStorage.get(AUMLOK_STORAGE_KEY)).binding
  assert.equal(binding.credential.id, fx.passkey.id)
  assert.deepEqual(await fx.ownerCounters(), counters, 'a failed registration never moves an owner lockout counter')
})

test('owner limits: four devices at most, exact bytes, live generation, sane expiry and label; the owner actions need a session', async t => {
  const fx = await fixture(t)
  const primary = await fx.signIn()
  // Without a session, the owner routes answer nothing.
  for (const [path, method] of [[PASSKEY_DEVICE_ROUTES.list, 'GET'], [PASSKEY_DEVICE_ROUTES.code, 'POST'], [PASSKEY_DEVICE_ROUTES.remove, 'POST']]) {
    const result = await fx.call(path, method === 'POST' ? { method, body: {} } : {})
    assert.equal(result.response.status, 401, path)
  }
  // HEAD itself refuses the owner actions without verified owner access, whoever forwards them.
  const direct = await fx.env.HEAD.get().fetch(new Request(new URL(PASSKEY_DEVICE_ROUTES.list, ORIGIN), {
    headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'x-x6-internal-authorized': '1', 'x-x6-bootstrap-seed': fx.seedId } }))
  // POST is not how the list is read.
  assert.equal((await fx.call(PASSKEY_DEVICE_ROUTES.list, { method: 'POST', cookie: primary.cookie, body: {} })).response.status, 405)
  assert.deepEqual([direct.status, (await direct.json()).code], [403, 'OWNER_ACCESS_REQUIRED'])
  // Each field of the approved body is judged.
  const sendCode = async (body, approvedBody = body) => {
    const { token } = await fx.approve(primary.cookie, PASSKEY_DEVICE_ROUTES.code, approvedBody)
    return fx.call(PASSKEY_DEVICE_ROUTES.code, { method: 'POST', cookie: primary.cookie, body, headers: { 'x-x6-class3-approval': token } })
  }
  const good = await fx.codeBody()
  for (const [name, body, code] of [
    ['stale generation', { ...good, generation: good.generation + 1 }, 'AUMLOK_DEVICE_GENERATION_STALE'],
    ['a day long', { ...good, expiresAt: Date.now() + 86400000 }, 'AUMLOK_DEVICE_EXPIRY_INVALID'],
    ['already over', { ...good, expiresAt: Date.now() }, 'AUMLOK_DEVICE_EXPIRY_INVALID'],
    ['markup label', { ...good, label: '<b>x</b>' }, 'AUMLOK_DEVICE_REQUEST_INVALID'],
    ['long label', { ...good, label: 'x'.repeat(41) }, 'AUMLOK_DEVICE_REQUEST_INVALID'],
    ['extra field', { ...good, note: 'x' }, 'AUMLOK_DEVICE_REQUEST_INVALID'],
    ['wrong action', { ...good, action: PASSKEY_DEVICE_REMOVE_ACTION }, 'AUMLOK_DEVICE_REQUEST_INVALID'],
  ]) {
    const result = await sendCode(body)
    assert.equal(result.body.code, code, name)
  }
  const mismatch = await sendCode(good, { ...good, label: 'Another' })
  assert.deepEqual([mismatch.response.status, mismatch.body.code], [403, 'CLASS3_WEBAUTHN_REQUIRED'], 'the approval binds the exact bytes')
  assert.equal(await fx.headStorage.get(PASSKEY_DEVICES_PENDING_KEY), undefined, 'no refused request made a code')
  // Four devices, then no fifth code.
  for (let index = 0; index < PASSKEY_DEVICE_LIMITS.devices; index++) {
    assert.equal((await fx.addDevice((await fx.makeCode(primary.cookie, fx.passkey, `Device ${String(index)}`)).code)).added.response.status, 200)
  }
  const full = await sendCode(await fx.codeBody())
  assert.deepEqual([full.response.status, full.body.code], [507, 'AUMLOK_DEVICE_CAPACITY'])
  const list = await fx.call(PASSKEY_DEVICE_ROUTES.list, { cookie: primary.cookie })
  assert.equal(list.body.devices.length, 4)
  // The sign-in page only links to the add page (its own script is unchanged and never reads its URL).
  const navigate = { accept: 'text/html', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' }
  const signinPage = await fx.call('/', { headers: navigate })
  assert.equal(signinPage.response.status, 401)
  assert.match(signinPage.body, /<a href="\/_auth\/passkey\/add">/)
  assert.equal((signinPage.body.match(/<script>/g) ?? []).length, 1)
  assert.doesNotMatch(signinPage.body, /device-add-submit/)
  // The add page: static, no session needed, no durable call, one script and one style admitted by hash.
  const calls = fx.doCalls.length
  const page = await fx.call(PASSKEY_DEVICE_ROUTES.add, { headers: navigate })
  assert.equal(page.response.status, 200)
  assert.match(page.body, /id="device-add-submit"/)
  assert.equal(page.response.headers.get('cache-control'), 'no-store')
  assert.equal(page.response.headers.get('referrer-policy'), 'no-referrer')
  const script = /<script>([\s\S]*)<\/script>/.exec(page.body)[1], style = /<style>([\s\S]*)<\/style>/.exec(page.body)[1]
  const hashOf = text => createHash('sha256').update(text).digest('base64')
  assert.equal(page.response.headers.get('content-security-policy'), `default-src 'none'; base-uri 'none'; object-src 'none'; script-src 'sha256-${hashOf(script)}'; style-src 'sha256-${hashOf(style)}'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'`)
  assert.equal(fx.doCalls.length, calls)
  // A script's fetch of the page is not a document request.
  assert.equal((await fx.call(PASSKEY_DEVICE_ROUTES.add, { headers: { accept: 'text/html', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' } })).response.status, 405)
})

test('the Worker view of enrolled keys refuses a malformed device list and finds each credential', () => {
  const key = { credentialId: 'primary-credential-id', publicKeyB64: 'AAAA', devices: [{ id: 'device-credential-1', publicKeyB64: 'BBBB' }] }
  assert.deepEqual(signinCredentialFor(key, 'primary-credential-id'), { id: 'primary-credential-id', publicKeyB64: 'AAAA' })
  assert.deepEqual(signinCredentialFor(key, 'device-credential-1'), { id: 'device-credential-1', publicKeyB64: 'BBBB' })
  assert.equal(signinCredentialFor(key, 'nobody'), null)
  assert.equal(signinCredentialFor(key, undefined), null)
  assert.deepEqual(signinKeyDevices({}), [])
  assert.equal(signinKeyDeviceCode({ deviceCode: 'a'.repeat(64) }), 'a'.repeat(64))
  for (const deviceCode of [undefined, null, '', 'A'.repeat(64), 'a'.repeat(63), 7, {}]) assert.equal(signinKeyDeviceCode({ deviceCode }), null, String(deviceCode))
  assert.equal(signinKeyDeviceCode(null), null)
  for (const devices of [[], 'x', [{ id: 'a' }], [{ id: '+', publicKeyB64: 'AAAA' }], Array.from({ length: 5 }, () => ({ id: 'abcd', publicKeyB64: 'AAAA' }))]) {
    assert.equal(signinKeyDevices({ devices }), null, JSON.stringify(devices))
  }
})

test('a removed device\'s outstanding approvals are revoked in the removal, and enrolling the same id and key again never revives them', async t => {
  const fx = await fixture(t)
  const primary = await fx.signIn()
  const { device, added } = await fx.addDevice((await fx.makeCode(primary.cookie)).code)
  assert.equal(added.response.status, 200, JSON.stringify(added.body))
  const deviceSession = await fx.signIn(device)
  // The primary approves the removal first; then the device approves two actions of its own, all three outstanding at once.
  const removeBody = { action: PASSKEY_DEVICE_REMOVE_ACTION, deviceId: device.id, generation: await fx.generation() }
  const { token: removeToken } = await fx.approve(primary.cookie, PASSKEY_DEVICE_ROUTES.remove, removeBody)
  const codeBody = await fx.codeBody('Spare')
  const { token: codeToken } = await fx.approve(deviceSession.cookie, PASSKEY_DEVICE_ROUTES.code, codeBody, device, undefined, { keep: true })
  const promote = { candidate: 'fixture' }, promoteBinding = await aumlokClass3Binding({ audience: ORIGIN, method: 'POST', pathname: '/_head/promote', body: promote })
  const { token: promoteToken } = await fx.approve(deviceSession.cookie, '/_head/promote', promote, device, undefined, { keep: true })
  const held = (await fx.headStorage.get(AUMLOK_STORAGE_KEY)).approvals
  assert.equal(held.length, 3)
  assert.deepEqual(held.filter(item => item.approvedBy === device.id).length, 2)
  // Control: while the device is enrolled, its promote approval is good (read without spending it).
  const store = createAumlokStore(fx.headStorage, { origins: [ORIGIN], ownerPublicKeyHex: fx.env.OWNER_PUBLIC_KEY_HEX })
  assert.equal((await store.verifyApproval(promoteToken, promoteBinding, ORIGIN)).ok, true)
  const removed = await fx.call(PASSKEY_DEVICE_ROUTES.remove, { method: 'POST', cookie: primary.cookie, body: removeBody, headers: { 'x-x6-class3-approval': removeToken } })
  assert.equal(removed.response.status, 200, JSON.stringify(removed.body))
  // The removal transaction took the device's approvals with it: none is left in the store to be judged later.
  assert.equal((await fx.headStorage.get(AUMLOK_STORAGE_KEY)).approvals.filter(item => item.approvedBy === device.id).length, 0)
  const refusedBoth = async () => {
    // Through the Worker's device-code route, and by the same judge (approvalFor) that /_head/promote's consume uses.
    const spent = await fx.call(PASSKEY_DEVICE_ROUTES.code, { method: 'POST', cookie: primary.cookie, body: codeBody, headers: { 'x-x6-class3-approval': codeToken } })
    assert.deepEqual([spent.response.status, spent.body.code], [403, 'CLASS3_WEBAUTHN_REQUIRED'])
    await assert.rejects(store.verifyApproval(promoteToken, promoteBinding, ORIGIN), error => error.code === 'CLASS3_WEBAUTHN_REQUIRED' && error.status === 403)
  }
  await refusedBoth()
  // THE SAME ID AND THE SAME KEY ENROLLED AGAIN (by a primary-issued code, the reviewer's scenario): a NEW instance.
  const before = (await fx.headStorage.get(AUMLOK_STORAGE_KEY))
  const again = await fx.addDevice((await fx.makeCode(primary.cookie, fx.passkey, 'Spare again')).code, device)
  assert.equal(again.added.response.status, 200, JSON.stringify(again.added.body))
  const reenrolled = (await fx.headStorage.get(AUMLOK_STORAGE_KEY)).devices
  assert.deepEqual(reenrolled.map(item => item.credential.id), [device.id])
  assert.equal(before.devices, undefined)
  // The old approvals stay refused for good, and still no code was made from the old device's approval.
  await refusedBoth()
  assert.equal((await fx.headStorage.get(PASSKEY_DEVICES_PENDING_KEY)).pending, null)
  // The re-enrolled device's NEW approvals work (it is a device like any other).
  const { token: fresh } = await fx.approve((await fx.signIn(device)).cookie, '/_head/promote', promote, device)
  assert.equal((await store.verifyApproval(fresh, promoteBinding, ORIGIN)).ok, true)
})

test('the add door gates strangers in the Worker: a flood of well-formed codes never reaches the owner\'s HEAD door', async t => {
  const fx = await fixture(t)
  const primary = await fx.signIn()
  const doorCalls = () => fx.doCalls.filter(entry => /device-add/.test(entry)).length
  const keyReads = () => fx.doCalls.filter(entry => entry.endsWith('/signin-key')).length
  // Nothing outstanding: a stranger's well-formed codes, from many addresses, cost no HEAD door call.
  const doors = doorCalls(), reads = keyReads(), before = fx.headStorage.snapshot()
  for (let index = 0; index < 50; index++) {
    const result = await fx.call(PASSKEY_DEVICE_ROUTES.addChallenge, { method: 'POST', body: { code: randomBytes(32).toString('base64url') }, address: `192.0.2.${String(index)}` })
    assert.deepEqual([result.response.status, result.body.code], [403, 'AUMLOK_DEVICE_CODE_INVALID'])
  }
  assert.equal(doorCalls(), doors, 'no stranger code was forwarded')
  assert.ok(keyReads() - reads <= 1, 'at most one shared key read per ten seconds')
  assert.equal(fx.headStorage.snapshot(), before)
  // A code outstanding: still none of the stranger's codes is forwarded, and the owner's code still works at once.
  const made = await fx.makeCode(primary.cookie)
  const doorsWithCode = doorCalls(), readsWithCode = keyReads()
  for (let index = 0; index < 50; index++) {
    const result = await fx.call(PASSKEY_DEVICE_ROUTES.add, { method: 'POST', body: { code: randomBytes(32).toString('base64url'), credential: {} }, address: `198.51.100.${String(index)}` })
    assert.deepEqual([result.response.status, result.body.code], [403, 'AUMLOK_DEVICE_CODE_INVALID'])
  }
  assert.equal(doorCalls(), doorsWithCode)
  assert.ok(keyReads() - readsWithCode <= 1)
  assert.equal((await fx.headStorage.get(PASSKEY_DEVICES_PENDING_KEY)).pending.misses, 0)
  assert.equal((await fx.addDevice(made.code)).added.response.status, 200)
  // Another isolate, whose cache never saw the code, finds it with one shared re-read.
  const other = await fx.makeCode(primary.cookie)
  const fromB = await fx.addDevice(other.code, passkeyPair(), {}, { isolate: 'B' })
  assert.equal(fromB.added.response.status, 200, JSON.stringify(fromB.challenge.body))
  // An unreadable pending record names no code, and never stops the owner signing in.
  await fx.headStorage.put(PASSKEY_DEVICES_PENDING_KEY, { schema: 'broken' })
  assert.equal((await fx.signIn()).response.status, 200)
  const refused = await fx.call(PASSKEY_DEVICE_ROUTES.addChallenge, { method: 'POST', body: { code: other.code } })
  assert.deepEqual([refused.response.status, refused.body.code], [403, 'AUMLOK_DEVICE_CODE_INVALID'])
})

test('after the last device goes, expired private approval fields are pruned on the next write: the old shape returns, the audit still names the device', async t => {
  const fx = await fixture(t)
  const primary = await fx.signIn()
  const { device } = await fx.addDevice((await fx.makeCode(primary.cookie)).code)
  const deviceSession = await fx.signIn(device)
  const removeBody = { action: PASSKEY_DEVICE_REMOVE_ACTION, deviceId: device.id, generation: await fx.generation() }
  const { token } = await fx.approve(primary.cookie, PASSKEY_DEVICE_ROUTES.remove, removeBody)
  // A device-code approval by the primary (keeps a userHandle) and an approval by the device (keeps approvedBy), unspent.
  await fx.approve(primary.cookie, PASSKEY_DEVICE_ROUTES.code, await fx.codeBody('Spare'), fx.passkey, undefined, { keep: true })
  await fx.approve(deviceSession.cookie, '/_head/promote', { candidate: 'fixture' }, device, undefined, { keep: true })
  assert.equal((await fx.call(PASSKEY_DEVICE_ROUTES.remove, { method: 'POST', cookie: primary.cookie, body: removeBody, headers: { 'x-x6-class3-approval': token } })).response.status, 200)
  const privateFields = state => state.approvals.filter(item => Object.hasOwn(item, 'approvedBy') || Object.hasOwn(item, 'userHandle')).length
  // The removal revoked the device's own approval at once; the primary's unexpired device-code approval keeps its handle.
  assert.equal(privateFields(await fx.headStorage.get(AUMLOK_STORAGE_KEY)), 1, 'the unexpired primary code approval keeps its field')
  // Six minutes on, one ordinary write (a primary sign-in) prunes them; nothing new remains in either record.
  const later = createAumlokStore(fx.headStorage, { origins: [ORIGIN], ownerPublicKeyHex: fx.env.OWNER_PUBLIC_KEY_HEX, now: () => Date.now() + 360000 })
  const issued = await later.complete('signin-challenge', {}, ORIGIN)
  const signed = await later.complete('signin', { challengeId: issued.challengeId, credential: assertionFor(fx.passkey, issued.publicKey.challenge, { counter: 50 }) }, ORIGIN)
  assert.equal(signed.ok, true)
  const state = await fx.headStorage.get(AUMLOK_STORAGE_KEY)
  assert.equal(privateFields(state), 0)
  assert.equal(Object.hasOwn(state, 'devices'), false)
  // The retained audit still names the device's sign-in and approval, but inside `outcome`: every row is one the build
  // before devices reads (an earlier commit's own rule), so a device that was USED and then removed leaves the store old-readable.
  assert.deepEqual(state.attempts.filter(namesDevice).map(item => item.purpose), ['signin-device', 'complete'])
  for (const record of state.attempts) assert.ok(oldBuildReadsAttempt(record), JSON.stringify(record))
  for (const word of ['"devices"', '"approvedBy"', '"approvedInstance"', '"userHandle"', '"transports"', '"credential":"']) {
    assert.equal(JSON.stringify(state).includes(word), false, word)
  }
  assert.ok((await fx.headStorage.get(AUMLOK_SIGNIN_STORAGE_KEY)).sessions.every(item => !Object.hasOwn(item, 'device')))
})

// ── transports recorded at registration, and the pre-feature shape after them ─────────────────────────────────

test('transports: an added device keeps the ones its registration named; signin-key and the sign-in challenge pass them on', async t => {
  const fx = await fixture(t)
  const primary = await fx.signIn()
  const named = await fx.addDevice((await fx.makeCode(primary.cookie, fx.passkey, 'Phone')).code, passkeyPair(), { transports: ['hybrid', 'internal', 'hybrid'] })
  const silent = await fx.addDevice((await fx.makeCode(primary.cookie, fx.passkey, 'Desk')).code, passkeyPair(), { transports: null })
  const empty = await fx.addDevice((await fx.makeCode(primary.cookie, fx.passkey, 'Key')).code, passkeyPair(), { transports: [] })
  for (const step of [named, silent, empty]) assert.equal(step.added.response.status, 200, JSON.stringify(step.added.body))
  const state = await fx.headStorage.get(AUMLOK_STORAGE_KEY)
  // Distinct names in the order given; none named (or an empty list) stores no field at all.
  assert.deepEqual(state.devices.map(item => item.transports), [['hybrid', 'internal'], undefined, undefined])
  assert.deepEqual(state.devices.map(item => Object.hasOwn(item, 'transports')), [true, false, false])
  // The primary of a store bound before this feature has none, and the binding keeps its exact keys.
  assert.equal(Object.hasOwn(state.binding, 'transports'), false)
  const store = createAumlokStore(fx.headStorage, { origins: [ORIGIN], ownerPublicKeyHex: fx.env.OWNER_PUBLIC_KEY_HEX })
  const key = await store.complete('signin-key', {}, ORIGIN)
  assert.equal(Object.hasOwn(key, 'transports'), false)
  assert.deepEqual(key.devices.map(item => Object.keys(item).sort().join()), ['id,publicKeyB64,transports', 'id,publicKeyB64', 'id,publicKeyB64'])
  // The sign-in challenge the Worker mints lists every credential, each with exactly what was recorded.
  const issued = await fx.call(OWNER_PASSKEY.challenge, { method: 'POST', body: {}, isolate: 'B' })
  assert.equal(issued.response.status, 200, JSON.stringify(issued.body))
  assert.deepEqual(issued.body.publicKey.allowCredentials, [{ type: 'public-key', id: fx.passkey.id },
    { type: 'public-key', id: named.device.id, transports: ['hybrid', 'internal'] }, { type: 'public-key', id: silent.device.id }, { type: 'public-key', id: empty.device.id }])
  // A device with transports still signs in, and its record's MAC covers them: a changed list is refused as corrupt.
  assert.equal((await fx.signIn(named.device)).response.status, 200)
  const held = await fx.headStorage.get(AUMLOK_STORAGE_KEY)
  await fx.headStorage.put(AUMLOK_STORAGE_KEY, { ...held, devices: held.devices.map((item, index) => index === 0 ? { ...item, transports: ['usb'] } : item) })
  await assert.rejects(store.status(), error => error.code === 'AUMLOK_AUDIT_CORRUPT')
  await fx.headStorage.put(AUMLOK_STORAGE_KEY, { ...held, devices: held.devices.map((item, index) => index === 0 ? { ...item, transports: ['carrier-pigeon'] } : item) })
  await assert.rejects(store.status(), error => error.code === 'AUMLOK_STATE_CORRUPT')
  await fx.headStorage.put(AUMLOK_STORAGE_KEY, held)
  assert.equal((await store.status()).bound, true)
})

test('transports in the Worker: a malformed device list is refused, a malformed transports list is dropped and the device kept', () => {
  const device = { id: 'ZGV2aWNlLTE', publicKeyB64: 'BBBB' }
  assert.deepEqual(signinKeyDevices({ devices: [{ ...device, transports: ['internal', 'hybrid', 'internal'] }] }), [{ ...device, transports: ['internal', 'hybrid'] }])
  for (const transports of [[], 'internal', ['carrier-pigeon'], Array.from({ length: 9 }, () => 'usb'), [7], null]) {
    assert.deepEqual(signinKeyDevices({ devices: [{ ...device, transports }] }), [device], JSON.stringify(transports))
  }
  assert.equal(signinKeyDevices({ devices: [{ ...device, transports: ['usb'], extra: 1 }] }), null)
  assert.deepEqual(signinAllowCredentials({ credentialId: 'p', transports: ['internal'], devices: [{ ...device, transports: ['hybrid'] }, { id: 'd2', publicKeyB64: 'CC' }] }),
    [{ type: 'public-key', id: 'p', transports: ['internal'] }, { type: 'public-key', id: device.id, transports: ['hybrid'] }, { type: 'public-key', id: 'd2' }])
  assert.deepEqual(signinAllowCredentials({ credentialId: 'p', transports: null }), [{ type: 'public-key', id: 'p' }])
})

/** A fresh, unbound store bound by the real two-step ceremony; `transports` is what the browser reported at registration. */
async function freshBind(transports) {
  const storage = memoryStorage(), owner = generateKeyPairSync('ed25519'), node = generateKeyPairSync('ed25519'), passkey = passkeyPair()
  const access = { type: 'owner', email: OWNER, expires: Math.floor(Date.now() / 1000) + 3600 }
  const store = createAumlokStore(storage, { origins: [ORIGIN], ownerPublicKeyHex: keyHex(owner),
    authorizeEnrollment: createOwnerEnrollmentVerifier({ mode: OWNER_ENROLLMENT_MODE, origin: ORIGIN, ownerEmail: OWNER, ownerPublicKeyHex: keyHex(owner) }) })
  const root = { sealedRootKeyB64: Buffer.alloc(48, 19).toString('base64url'), kdfSaltB64: Buffer.alloc(32, 37).toString('base64url'),
    kdfIterations: 600000, ivB64: Buffer.alloc(12, 41).toString('base64url') }
  const started = await store.challenge({ purpose: 'bind', requestId: 'bind-1', commitmentSha256: 'a'.repeat(64), nodePubkeyHex: keyHex(node), ...root }, ORIGIN, { access })
  const registered = await store.complete('bind', { challengeId: started.challengeId, credential: registrationFor(passkey, started.publicKey.challenge, { transports }) }, ORIGIN, { access })
  const pending = (await storage.get(AUMLOK_STORAGE_KEY)).challenges.find(record => record.id === registered.challengeId)
  const payload = { schema: OWNER_ENROLLMENT_SCHEMA, audience: ORIGIN, intentHash: registered.intentHash, nodePubkeyHex: keyHex(node), credentialId: passkey.id, expiresAt: registered.expiresAt }
  const enrollmentApproval = canonicalJson({ ...payload, signatureHex: sign(null, Buffer.from(OWNER_ENROLLMENT_DOMAIN + canonicalJson(payload)), owner.privateKey).toString('hex') })
  const bound = await store.complete('bind', { challengeId: registered.challengeId, credential: assertionFor(passkey, registered.publicKey.challenge, { counter: 1 }),
    nodeSignature: sign(null, Buffer.from(registered.nodeProofPreimage), node.privateKey).toString('base64url') }, ORIGIN, { access, enrollmentApproval })
  assert.equal(bound.bound, true, JSON.stringify(bound))
  return { storage, store, passkey, pending }
}

test('bind: a correct node signature checked by an Ed25519 backend that throws is 503 and never counted; a wrong one still counts', async t => {
  const storage = memoryStorage(), owner = generateKeyPairSync('ed25519'), node = generateKeyPairSync('ed25519'), passkey = passkeyPair()
  const access = { type: 'owner', email: OWNER, expires: Math.floor(Date.now() / 1000) + 3600 }
  const store = createAumlokStore(storage, { origins: [ORIGIN], ownerPublicKeyHex: keyHex(owner),
    authorizeEnrollment: createOwnerEnrollmentVerifier({ mode: OWNER_ENROLLMENT_MODE, origin: ORIGIN, ownerEmail: OWNER, ownerPublicKeyHex: keyHex(owner) }) })
  const root = { sealedRootKeyB64: Buffer.alloc(48, 19).toString('base64url'), kdfSaltB64: Buffer.alloc(32, 37).toString('base64url'),
    kdfIterations: 600000, ivB64: Buffer.alloc(12, 41).toString('base64url') }
  const started = await store.challenge({ purpose: 'bind', requestId: 'bind-throw', commitmentSha256: 'a'.repeat(64), nodePubkeyHex: keyHex(node), ...root }, ORIGIN, { access })
  const registered = await store.complete('bind', { challengeId: started.challengeId, credential: registrationFor(passkey, started.publicKey.challenge) }, ORIGIN, { access })
  assert.equal(registered.phase, 'PENDING_ASSERTION', JSON.stringify(registered))
  const budget = async () => { const state = await storage.get(AUMLOK_STORAGE_KEY); return [state.failures, state.failedAt, state.nextAllowedAt, state.binding] }
  const before = await budget()
  const original = crypto.subtle.verify.bind(crypto.subtle)
  const backend = t.mock.method(crypto.subtle, 'verify', (name, ...rest) => {
    if ((typeof name === 'string' ? name : name?.name) === 'Ed25519') throw new Error('Ed25519 backend unavailable')
    return original(name, ...rest)
  })
  const thrown = await store.complete('bind', { challengeId: registered.challengeId, credential: assertionFor(passkey, registered.publicKey.challenge, { counter: 1 }),
    nodeSignature: sign(null, Buffer.from(registered.nodeProofPreimage), node.privateKey).toString('base64url') }, ORIGIN, { access })
  assert.deepEqual([thrown.ok, thrown.code, thrown.status], [false, 'AUMLOK_UNAVAILABLE', 503], JSON.stringify(thrown))
  assert.deepEqual(await budget(), before, 'a backend that throws reached no verdict: nothing counted, nothing bound')
  backend.mock.restore()
  // The same ceremony shape with a well-formed WRONG node signature, checked by a working backend: a verdict, counted.
  const again = await store.challenge({ purpose: 'bind', requestId: 'bind-wrong', commitmentSha256: 'a'.repeat(64), nodePubkeyHex: keyHex(node), ...root }, ORIGIN, { access })
  const second = await store.complete('bind', { challengeId: again.challengeId, credential: registrationFor(passkey, again.publicKey.challenge) }, ORIGIN, { access })
  assert.equal(second.phase, 'PENDING_ASSERTION', JSON.stringify(second))
  const wrong = await store.complete('bind', { challengeId: second.challengeId, credential: assertionFor(passkey, second.publicKey.challenge, { counter: 1 }),
    nodeSignature: sign(null, Buffer.from('other bytes'), node.privateKey).toString('base64url') }, ORIGIN, { access })
  assert.deepEqual([wrong.ok, wrong.code, wrong.status], [false, 'AUMLOK_NODE_PROOF_INVALID', 403], JSON.stringify(wrong))
  assert.equal((await budget())[0], before[0] + 1)
})

test('verifyAumlokInviteReceipt (read by verified-facts) still answers a boolean; a backend that throws reads as not verified', async t => {
  const node = generateKeyPairSync('ed25519'), at = Date.now()
  const receipt = { schema: 'aukora.invite.v1', inviteId: randomBytes(24).toString('base64url'), sponsorPubkeyHex: keyHex(node), inviteeCommitmentSha256: 'd'.repeat(64),
    assignedDomainPointer: null, quotaMonth: new Date(at).toISOString().slice(0, 7), monthlySequence: 1, revoked: false, issuedAt: at, expiresAt: at + 604800000 }
  const signed = { ...receipt, signature: sign(null, Buffer.from(aumlokInvitePreimage(receipt)), node.privateKey).toString('base64url') }
  assert.equal(await verifyAumlokInviteReceipt(signed, keyHex(node)), true)
  const original = crypto.subtle.verify.bind(crypto.subtle)
  t.mock.method(crypto.subtle, 'verify', (name, ...rest) => {
    if ((typeof name === 'string' ? name : name?.name) === 'Ed25519') throw new Error('Ed25519 backend unavailable')
    return original(name, ...rest)
  })
  assert.equal(await verifyAumlokInviteReceipt(signed, keyHex(node)), false)
})

test('transports at bind: carried from the registration step to the binding, returned by signin-key; none named, none stored', async () => {
  const named = await freshBind(['hybrid', 'internal'])
  assert.deepEqual(named.pending.transports, ['hybrid', 'internal'], 'the assertion step carries them')
  const state = await named.storage.get(AUMLOK_STORAGE_KEY)
  assert.deepEqual(state.binding.transports, ['hybrid', 'internal'])
  assert.equal(state.binding.credential.id, named.passkey.id)
  assert.deepEqual(Object.keys(state.binding.credential).sort(), ['counter', 'id', 'publicKeyB64'], 'the credential itself keeps its shape')
  const key = await named.store.complete('signin-key', {}, ORIGIN)
  assert.deepEqual([key.credentialId, key.transports], [named.passkey.id, ['hybrid', 'internal']])
  // A rotation-style rewrite of the binding (a sign-in moves its counter) keeps them.
  const issued = await named.store.complete('signin-challenge', {}, ORIGIN)
  assert.equal((await named.store.complete('signin', { challengeId: issued.challengeId, credential: assertionFor(named.passkey, issued.publicKey.challenge, { counter: 5 }) }, ORIGIN)).ok, true)
  assert.deepEqual((await named.storage.get(AUMLOK_STORAGE_KEY)).binding.transports, ['hybrid', 'internal'])
  // A bind whose browser named none stores the binding in exactly the shape before this feature.
  const silent = await freshBind(null)
  assert.equal(Object.hasOwn(silent.pending, 'transports'), false)
  const plain = await silent.storage.get(AUMLOK_STORAGE_KEY)
  assert.deepEqual(Object.keys(plain.binding).sort(), ['aumlokId', 'boundAt', 'credential', 'generation', 'lastVerifiedAt', 'nodePubkeyHex', 'recoveryCommitment', 'rootEscrow'])
  assert.equal(Object.hasOwn(await silent.store.complete('signin-key', {}, ORIGIN), 'transports'), false)
  // A stored binding or challenge with a bent list is refused as corrupt, never trusted.
  for (const bent of [{ binding: { ...state.binding, transports: [] } }, { binding: { ...state.binding, transports: ['usb', 'usb'] } },
    { binding: { ...state.binding, transports: ['smoke-signal'] } }]) {
    await named.storage.put(AUMLOK_STORAGE_KEY, { ...state, ...bent })
    await assert.rejects(named.store.status(), error => error.code === 'AUMLOK_STATE_CORRUPT', JSON.stringify(bent))
  }
})

test('the pre-feature state shape still round-trips after the rebase and transports: no field appears that the old build refuses', async t => {
  const fx = await fixture(t)
  const before = await fx.headStorage.get(AUMLOK_STORAGE_KEY)
  // Everything a signed-in owner does today, through the Worker: sign-in in both isolates, an approval, status, the
  // devices list, a sign-in page and the add page.
  const signed = await fx.signIn()
  assert.deepEqual(signed.issued.publicKey.allowCredentials, [{ type: 'public-key', id: fx.passkey.id }])
  assert.equal((await fx.signIn(fx.passkey, { isolate: 'B' })).response.status, 200)
  const { token } = await fx.approve(signed.cookie, '/_head/promote', { candidate: 'fixture' })
  assert.equal(typeof token, 'string')
  assert.equal((await fx.call('/_host/aumlok/status', { cookie: signed.cookie })).response.status, 200)
  assert.equal((await fx.call(PASSKEY_DEVICE_ROUTES.list, { cookie: signed.cookie })).response.status, 200)
  const after = await fx.headStorage.get(AUMLOK_STORAGE_KEY)
  // The binding: the same keys, the same credential and generation; nothing about transports or devices anywhere.
  assert.deepEqual(Object.keys(after.binding).sort(), Object.keys(before.binding).sort())
  assert.deepEqual([after.binding.credential.id, after.binding.credential.publicKeyB64, after.generation], [before.binding.credential.id, before.binding.credential.publicKeyB64, before.generation])
  const text = JSON.stringify(after)
  for (const word of ['transports', 'devices', 'approvedBy', 'userHandle']) assert.equal(text.includes(`"${word}"`), false, word)
  assert.ok(after.challenges.every(record => Object.keys(record).length === 24), 'every challenge record keeps its 24 fields')
  // The top-level fields are the old build's own (the store's lazy normalisation of audit, phrase and enrollment
  // counters predates passkey devices).
  assert.deepEqual(Object.keys(after).filter(key => !Object.hasOwn(before, key)).sort(),
    ['audit', 'enrollmentCount', 'enrollments', 'lastRotationChallengeId', 'pepperProtection', 'phraseFailedAt', 'phraseFailures', 'phraseNextAllowedAt'])
  assert.ok((await fx.headStorage.get(AUMLOK_SIGNIN_STORAGE_KEY)).sessions.every(item => Object.keys(item).length === 4))
  assert.equal(await fx.headStorage.get(PASSKEY_DEVICES_PENDING_KEY), undefined)
  // A fresh store reads it back, and HEAD's signin-key names exactly the old fields.
  const store = createAumlokStore(fx.headStorage, { origins: [ORIGIN], ownerPublicKeyHex: fx.env.OWNER_PUBLIC_KEY_HEX })
  assert.deepEqual(Object.keys(await store.complete('signin-key', {}, ORIGIN)).sort(),
    ['credentialId', 'generation', 'issuanceKeyHex', 'ok', 'publicKeyB64', 'rpId', 'schema', 'sessionKeyHex'])
})

test('the add page wears the sign-in look: AUKORA card, one hashed style of Spatial values, no secret words, the link styled on sign-in', async t => {
  const fx = await fixture(t)
  const page = await fx.call(PASSKEY_DEVICE_ROUTES.add, { headers: { accept: 'text/html', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' } })
  assert.equal(page.response.status, 200)
  const dom = new JSDOM(page.body)
  t.after(() => dom.window.close())
  const document = dom.window.document
  assert.equal(document.querySelector('h1').textContent, 'AUKORA')
  assert.equal(document.querySelector('h1').nextElementSibling.textContent, 'Add this device')
  assert.equal(document.querySelector('main').contains(document.getElementById('device-add-submit')), true)
  const styles = document.querySelectorAll('style'), scripts = document.querySelectorAll('script')
  assert.equal(styles.length, 1); assert.equal(scripts.length, 1)
  const css = styles[0].textContent
  const hash = text => `'sha256-${createHash('sha256').update(text).digest('base64')}'`
  assert.equal(page.response.headers.get('content-security-policy'), `default-src 'none'; base-uri 'none'; object-src 'none'; script-src ${hash(scripts[0].textContent)}; style-src ${hash(css)}; connect-src 'self'; form-action 'none'; frame-ancestors 'none'`)
  assert.doesNotMatch(css, /url\(|@import|@font-face|!important|@keyframes|animation/)
  assert.doesNotMatch(css, /(?:^|[\s;{])(?:width|height|max-height):\s*\d+px/m)
  // The sign-in page's own values: blue accent, page, text, secondary text, field, card, white title, primary hover.
  for (const value of ['rgb(150, 180, 255)', 'rgb(11, 13, 24)', 'rgb(232, 234, 237)', 'rgb(184, 188, 196)', 'rgba(8, 9, 16, 0.56)',
    'rgba(255, 255, 255, 0.043)', 'rgb(255, 255, 255)', 'rgb(183, 200, 254)', 'max-width: 26rem', 'border-radius: 28px', 'color-scheme: dark']) assert.ok(css.includes(value), value)
  assert.match(css, /:focus-visible \{ outline: 3px solid rgb\(150, 180, 255\); outline-offset: 3px; \}/)
  // No word a person reads says token or JWT, in the page or any line its script can show.
  const copy = document.body.cloneNode(true)
  for (const node of copy.querySelectorAll('script, style')) node.remove()
  assert.doesNotMatch(document.title + copy.textContent, /token|jwt/i)
  assert.doesNotMatch(scripts[0].textContent.replace(/[A-Za-z]+\.textContent/g, ''), /token|jwt/i)
  // The sign-in page carries the link to it, in the same card, below the passkey button, with its colour in its own style.
  const signin = await fx.call('/', { headers: { accept: 'text/html', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' } })
  const signinDom = new JSDOM(signin.body)
  t.after(() => signinDom.window.close())
  const link = signinDom.window.document.querySelector('#device-add-link a')
  assert.equal(link.getAttribute('href'), PASSKEY_DEVICE_ROUTES.add)
  assert.ok(signinDom.window.document.getElementById('passkey-submit').compareDocumentPosition(link) & signinDom.window.Node.DOCUMENT_POSITION_FOLLOWING)
  assert.match(signinDom.window.document.querySelector('style').textContent, /#device-add-link a \{ color: rgb\(150, 180, 255\);/)
})

// ── the review's three MUSTs, the owner approving the exact key, and expiry at the commit ────────

/** The same signing key under another credential id; `reorder` writes its COSE map in another order (same key bytes). */
function aliasOf(pair, { reorder = false } = {}) {
  const jwk = pair.key.publicKey.export({ format: 'jwk' })
  const entries = [[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]]
  return { key: pair.key, id: randomBytes(32).toString('base64url'),
    publicKeyB64: reorder ? Buffer.from(isoCBOR.encode(new Map(entries.reverse()))).toString('base64url') : pair.publicKeyB64 }
}

test('removing a device ends the code it made, atomically; and a code whose maker is gone never redeems', async t => {
  const fx = await fixture(t)
  const primary = await fx.signIn()
  const { device } = await fx.addDevice((await fx.makeCode(primary.cookie)).code)
  const deviceSession = await fx.signIn(device)
  const removeDevice = async () => {
    const body = { action: PASSKEY_DEVICE_REMOVE_ACTION, deviceId: device.id, generation: await fx.generation() }
    const { token } = await fx.approve(primary.cookie, PASSKEY_DEVICE_ROUTES.remove, body)
    return fx.call(PASSKEY_DEVICE_ROUTES.remove, { method: 'POST', cookie: primary.cookie, body, headers: { 'x-x6-class3-approval': token } })
  }
  // The reviewer's scenario: compromised device D makes a code; the primary removes D; the code must be dead.
  const stolen = await fx.makeCode(deviceSession.cookie, device, 'Thief')
  assert.equal((await fx.headStorage.get(PASSKEY_DEVICES_PENDING_KEY)).pending.approvedBy, device.id)
  const pendingWhileEnrolled = await fx.headStorage.get(PASSKEY_DEVICES_PENDING_KEY)
  assert.equal((await removeDevice()).response.status, 200)
  assert.equal((await fx.headStorage.get(PASSKEY_DEVICES_PENDING_KEY)).pending, null, 'the removal ended the code in its own transaction')
  const thief = passkeyPair()
  const afterRemoval = await fx.addDevice(stolen.code, thief)
  assert.deepEqual([afterRemoval.challenge.response.status, afterRemoval.challenge.body.code], [403, 'AUMLOK_DEVICE_CODE_INVALID'])
  // INDEPENDENTLY of that cancel: were the code record still there (put back here), HEAD refuses it at redemption
  // because its maker is no longer enrolled, and ends it.
  await fx.headStorage.put(PASSKEY_DEVICES_PENDING_KEY, pendingWhileEnrolled)
  const store = createAumlokStore(fx.headStorage, { origins: [ORIGIN], ownerPublicKeyHex: fx.env.OWNER_PUBLIC_KEY_HEX })
  await assert.rejects(store.devices('device-add-challenge', { code: stolen.code }, ORIGIN, {}), error => error.code === 'AUMLOK_DEVICE_CODE_REVOKED' && error.status === 409)
  assert.equal((await fx.headStorage.get(PASSKEY_DEVICES_PENDING_KEY)).pending, null)
  // The same through the Worker (isolate B has not read the sign-in key yet: it reads the restored record's lookup and
  // forwards the code to HEAD, which refuses it).
  await fx.headStorage.put(PASSKEY_DEVICES_PENDING_KEY, pendingWhileEnrolled)
  const viaWorker = await fx.call(PASSKEY_DEVICE_ROUTES.addChallenge, { method: 'POST', body: { code: stolen.code }, isolate: 'B' })
  assert.deepEqual([viaWorker.response.status, viaWorker.body.code], [409, 'AUMLOK_DEVICE_CODE_REVOKED'])
  // A code D made that a registration already USED (a credential waiting to join) is ended by the removal too, and the
  // thief's waiting credential can never be confirmed.
  const { device: device2 } = await fx.addDevice((await fx.makeCode(primary.cookie, fx.passkey, 'Second')).code)
  const session2 = await fx.signIn(device2)
  const used = await fx.addDevice((await fx.makeCode(session2.cookie, device2, 'Thief two')).code, thief, {}, {}, { confirm: false })
  assert.equal(used.joined.response.status, 200, JSON.stringify(used.joined.body))
  const waiting = (await fx.call(PASSKEY_DEVICE_ROUTES.list, { cookie: primary.cookie })).body.joining
  assert.equal(waiting.id, thief.id)
  const body2 = { action: PASSKEY_DEVICE_REMOVE_ACTION, deviceId: device2.id, generation: await fx.generation() }
  const { token: token2 } = await fx.approve(primary.cookie, PASSKEY_DEVICE_ROUTES.remove, body2)
  assert.equal((await fx.call(PASSKEY_DEVICE_ROUTES.remove, { method: 'POST', cookie: primary.cookie, body: body2, headers: { 'x-x6-class3-approval': token2 } })).response.status, 200)
  assert.equal((await fx.call(PASSKEY_DEVICE_ROUTES.list, { cookie: primary.cookie })).body.joining, null)
  const late = await fx.confirmDevice(primary.cookie, thief.id, fx.passkey, { keyHash: waiting.keyHash })
  assert.deepEqual([late.response.status, late.body.code], [404, 'AUMLOK_DEVICE_JOIN_NOT_FOUND'])
  assert.equal(Object.hasOwn(await fx.headStorage.get(AUMLOK_STORAGE_KEY), 'devices'), false, 'the thief never enrolled')
})

test('one key, one credential: the same signing key under another id is refused, in any COSE encoding', async t => {
  const fx = await fixture(t)
  const primary = await fx.signIn()
  const { device: deviceA } = await fx.addDevice((await fx.makeCode(primary.cookie, fx.passkey, 'A')).code)
  const counters = await fx.ownerCounters()
  // The reviewer's scenario: key P enrolled as A, then as B. B is refused at registration, so P can never approve
  // removing A "as B" and keep signing in as B.
  for (const [name, alias] of [['A\'s key, same encoding', aliasOf(deviceA)], ['A\'s key, map reordered', aliasOf(deviceA, { reorder: true })],
    ['the primary\'s key', aliasOf(fx.passkey)], ['the primary\'s key, reordered', aliasOf(fx.passkey, { reorder: true })]]) {
    assert.notEqual(alias.id, deviceA.id)
    const made = await fx.makeCode(primary.cookie, fx.passkey, 'B')
    const tried = await fx.addDevice(made.code, alias, {}, {}, { confirm: false })
    assert.deepEqual([tried.joined.response.status, tried.joined.body.code], [409, 'AUMLOK_DEVICE_KEY_ALREADY_ENROLLED'], name)
    const pending = (await fx.headStorage.get(PASSKEY_DEVICES_PENDING_KEY)).pending
    // A genuine registration refused by policy: no miss; nothing waits.
    assert.deepEqual([pending.joining, pending.misses], [null, 0], name + ': refused, not counted, nothing waits')
  }
  // The alias id is not a credential: it cannot sign in, so it cannot approve anything either.
  const alias = aliasOf(deviceA)
  const issued = await fx.call(OWNER_PASSKEY.challenge, { method: 'POST', body: {} })
  const signin = await fx.call(OWNER_PASSKEY.signin, { method: 'POST', body: { challengeId: issued.body.challengeId, credential: assertionFor(alias, issued.body.publicKey.challenge) } })
  assert.deepEqual([signin.response.status, signin.body.code], [403, 'AUMLOK_SIGNIN_PROOF_INVALID'])
  // So A can only be removed by the primary or a DIFFERENT key; A itself is refused.
  const self = { action: PASSKEY_DEVICE_REMOVE_ACTION, deviceId: deviceA.id, generation: await fx.generation() }
  const deviceSession = await fx.signIn(deviceA)
  const { token } = await fx.approve(deviceSession.cookie, PASSKEY_DEVICE_ROUTES.remove, self, deviceA)
  const refused = await fx.call(PASSKEY_DEVICE_ROUTES.remove, { method: 'POST', cookie: deviceSession.cookie, body: self, headers: { 'x-x6-class3-approval': token } })
  assert.deepEqual([refused.response.status, refused.body.code], [403, 'AUMLOK_DEVICE_REMOVE_NEEDS_OTHER_PASSKEY'])
  assert.deepEqual((await fx.headStorage.get(AUMLOK_STORAGE_KEY)).devices.map(item => item.credential.id), [deviceA.id])
  assert.deepEqual(await fx.ownerCounters(), counters, 'no owner lockout counter moved')
})

test('the owner approves the exact key: an intercepted code, or a key its sender does not hold, enrols nothing without his confirm', async t => {
  const fx = await fixture(t)
  const primary = await fx.signIn()
  const made = await fx.makeCode(primary.cookie)
  // A thief with the intercepted code wins the race with a key it does not even hold (fmt 'none' has no signature):
  // the PUBLIC key of some other passkey, under a fresh id.
  const victimElsewhere = passkeyPair(), keyless = { key: passkeyPair().key, id: randomBytes(32).toString('base64url'), publicKeyB64: victimElsewhere.publicKeyB64 }
  const raced = await fx.addDevice(made.code, keyless, {}, { address: '198.51.100.66' }, { confirm: false })
  assert.equal(raced.joined.response.status, 200, JSON.stringify(raced.joined.body))
  // The owner's own new device arrives second: the code is spent, it is refused with no HEAD door call.
  const mine = await fx.addDevice(made.code, passkeyPair(), {}, {}, { confirm: false })
  assert.deepEqual([mine.challenge.response.status, mine.challenge.body.code], [403, 'AUMLOK_DEVICE_CODE_INVALID'])
  // Waiting is not enrolled: no sign-in, no approval, no device in aumlok:v1.
  assert.equal(Object.hasOwn(await fx.headStorage.get(AUMLOK_STORAGE_KEY), 'devices'), false)
  const issued = await fx.call(OWNER_PASSKEY.challenge, { method: 'POST', body: {} })
  assert.deepEqual(issued.body.publicKey.allowCredentials.map(item => item.id), [fx.passkey.id])
  const binding = await aumlokClass3Binding({ audience: ORIGIN, method: 'POST', pathname: '/_head/promote', body: { candidate: 'fixture' } })
  const challenge = await fx.call('/_host/aumlok/challenge', { method: 'POST', cookie: primary.cookie, body: { purpose: 'approve', requestId: 'joining-approves', binding } })
  assert.deepEqual(challenge.body.publicKey.allowCredentials.map(item => item.id), [fx.passkey.id])
  const approved = await fx.call('/_host/aumlok/approve', { method: 'POST', cookie: primary.cookie,
    body: { challengeId: challenge.body.challengeId, credential: assertionFor(keyless, challenge.body.publicKey.challenge, { id: keyless.id }) } })
  assert.deepEqual([approved.response.status, approved.body.code], [400, 'AUMLOK_PROOF_INVALID'], 'a waiting credential cannot approve')
  // (That refused proof, sent with the owner's own session, counts like any other and sets the one-second backoff.)
  await new Promise(resolve => { setTimeout(resolve, 1100) })
  // The owner sees the phrase of the thief's key, not the one his new device would show, and the confirm binds THAT key.
  const list = (await fx.call(PASSKEY_DEVICE_ROUTES.list, { cookie: primary.cookie })).body
  assert.deepEqual([list.joining.id, list.joining.phrase], [keyless.id, raced.joined.body.phrase])
  assert.equal(list.joining.phrase, deviceKeyPhrase(list.joining.keyHash))
  // No approval at all, or an approval naming another key, confirms nothing.
  const exact = { action: PASSKEY_DEVICE_CONFIRM_ACTION, deviceId: keyless.id, keyHash: list.joining.keyHash, instance: list.joining.instance, generation: list.generation }
  const bare = await fx.call(PASSKEY_DEVICE_ROUTES.confirm, { method: 'POST', cookie: primary.cookie, body: exact })
  assert.deepEqual([bare.response.status, bare.body.code], [403, 'CLASS3_WEBAUTHN_REQUIRED'])
  const otherKey = await fx.confirmDevice(primary.cookie, keyless.id, fx.passkey, { keyHash: 'e'.repeat(64) })
  assert.deepEqual([otherKey.response.status, otherKey.body.code], [404, 'AUMLOK_DEVICE_JOIN_NOT_FOUND'])
  // He declines (his session is enough): the waiting credential is deleted and nothing was ever enrolled.
  const declined = await fx.call(PASSKEY_DEVICE_ROUTES.decline, { method: 'POST', cookie: primary.cookie,
    body: { action: PASSKEY_DEVICE_DECLINE_ACTION, deviceId: keyless.id, instance: list.joining.instance, generation: list.generation } })
  assert.equal(declined.response.status, 200, JSON.stringify(declined.body))
  assert.equal((await fx.headStorage.get(PASSKEY_DEVICES_PENDING_KEY)).pending, null)
  assert.equal((await fx.call(PASSKEY_DEVICE_ROUTES.list, { cookie: primary.cookie })).body.joining, null)
  const noSession = await fx.call(PASSKEY_DEVICE_ROUTES.decline, { method: 'POST', body: { action: PASSKEY_DEVICE_DECLINE_ACTION, deviceId: keyless.id, instance: list.joining.instance, generation: list.generation } })
  assert.equal(noSession.response.status, 401, 'a stranger cannot decline')
  const state = await fx.headStorage.get(AUMLOK_STORAGE_KEY)
  assert.equal(Object.hasOwn(state, 'devices'), false)
  assert.deepEqual(state.attempts.map(item => item.purpose).filter(purpose => purpose.startsWith('device')), ['device-code', 'device-join', 'device-decline'])
  // Nothing about the attempt went into aumlok:v1 but old-readable audit rows and the code approval's handle.
  for (const word of ['"devices"', '"approvedBy"', '"approvedInstance"', '"transports"']) assert.equal(JSON.stringify(state).includes(word), false, word)
  assert.ok(state.attempts.every(item => oldBuildReadsAttempt(item) && !namesDevice(item)))
  // AN ENROLLED DEVICE may confirm as well as the primary; a joining credential expires ten minutes after it registered.
  const { device: enrolled } = await fx.addDevice((await fx.makeCode(primary.cookie, fx.passkey, 'Desk')).code)
  const deviceSession = await fx.signIn(enrolled)
  const next = await fx.addDevice((await fx.makeCode(primary.cookie, fx.passkey, 'Phone')).code, passkeyPair(), {}, {}, { cookie: deviceSession.cookie, who: enrolled })
  assert.equal(next.added.response.status, 200, JSON.stringify(next.added.body))
  assert.equal((await fx.headStorage.get(AUMLOK_STORAGE_KEY)).devices.at(-1).approvedBy, enrolled.id)
  const stale = await fx.addDevice((await fx.makeCode(primary.cookie, fx.passkey, 'Late')).code, passkeyPair(), {}, {}, { confirm: false })
  const record = await fx.headStorage.get(PASSKEY_DEVICES_PENDING_KEY)
  record.pending.joining.registeredAt -= 660000; record.pending.joining.expiresAt -= 660000; record.pending.issuedAt -= 660000; record.pending.expiresAt -= 660000
  await fx.headStorage.put(PASSKEY_DEVICES_PENDING_KEY, record)
  assert.equal((await fx.call(PASSKEY_DEVICE_ROUTES.list, { cookie: primary.cookie })).body.joining, null, 'an expired joining credential is not offered')
  const expired = await fx.confirmDevice(primary.cookie, stale.device.id, fx.passkey, { keyHash: record.pending.joining.keyHash, instance: record.pending.joining.instance })
  assert.deepEqual([expired.response.status, expired.body.code], [404, 'AUMLOK_DEVICE_JOIN_NOT_FOUND'])
})

test('expiry at the commit: a registration or a confirm whose deadline passes during verification commits nothing', async t => {
  const fx = await fixture(t)
  const primary = await fx.signIn()
  const made = await fx.makeCode(primary.cookie)
  const issued = await fx.call(PASSKEY_DEVICE_ROUTES.addChallenge, { method: 'POST', body: { code: made.code } })
  const { challengeExpiresAt } = (await fx.headStorage.get(PASSKEY_DEVICES_PENDING_KEY)).pending
  // The reviewer's probe: the request starts one millisecond before the challenge ends and commits ten seconds after.
  const ticks = [challengeExpiresAt - 1]
  const slow = createAumlokStore(fx.headStorage, { origins: [ORIGIN], ownerPublicKeyHex: fx.env.OWNER_PUBLIC_KEY_HEX, now: () => ticks.shift() ?? challengeExpiresAt + 10000 })
  const device = passkeyPair()
  await assert.rejects(slow.devices('device-add', { code: made.code, credential: registrationFor(device, issued.body.publicKey.challenge) }, ORIGIN, {}),
    error => error.code === 'AUMLOK_DEVICE_CODE_EXPIRED' && error.status === 409)
  assert.equal((await fx.headStorage.get(PASSKEY_DEVICES_PENDING_KEY)).pending, null, 'nothing joined; the code is ended')
  // A clock that goes BACK during verification is refused the same way.
  const again = await fx.makeCode(primary.cookie)
  const reissued = await fx.call(PASSKEY_DEVICE_ROUTES.addChallenge, { method: 'POST', body: { code: again.code } })
  const start = Date.now(), back = [start]
  const backwards = createAumlokStore(fx.headStorage, { origins: [ORIGIN], ownerPublicKeyHex: fx.env.OWNER_PUBLIC_KEY_HEX, now: () => back.shift() ?? start - 60000 })
  await assert.rejects(backwards.devices('device-add', { code: again.code, credential: registrationFor(device, reissued.body.publicKey.challenge) }, ORIGIN, {}),
    error => error.code === 'AUMLOK_DEVICE_CODE_EXPIRED')
  // The confirm: the joining credential's ten minutes end while the approval is being judged.
  const joined = await fx.addDevice((await fx.makeCode(primary.cookie)).code, device, {}, {}, { confirm: false })
  assert.equal(joined.joined.response.status, 200)
  const list = (await fx.call(PASSKEY_DEVICE_ROUTES.list, { cookie: primary.cookie })).body
  const body = { action: PASSKEY_DEVICE_CONFIRM_ACTION, deviceId: device.id, keyHash: list.joining.keyHash, instance: list.joining.instance, generation: list.generation }
  const { token } = await fx.approve(primary.cookie, PASSKEY_DEVICE_ROUTES.confirm, body)
  const record = await fx.headStorage.get(PASSKEY_DEVICES_PENDING_KEY)
  const ends = Date.now() + 3000
  record.pending.joining.expiresAt = ends
  await fx.headStorage.put(PASSKEY_DEVICES_PENDING_KEY, record)
  let calls = 0
  const crossing = createAumlokStore(fx.headStorage, { origins: [ORIGIN], ownerPublicKeyHex: fx.env.OWNER_PUBLIC_KEY_HEX, now: () => (calls++ < 2 ? ends - 2000 : ends + 1000) })
  const before = fx.headStorage.snapshot()
  await assert.rejects(crossing.devices('device-confirm', body, ORIGIN, { approval: token }), error => error.code === 'CLASS3_WEBAUTHN_REQUIRED')
  assert.equal(fx.headStorage.snapshot(), before, 'nothing enrolled, the approval unspent')
})

test('the confirmation phrase: six digits from the key hash, two groups (the same vectors as the Identity spec)', () => {
  assert.deepEqual([deviceKeyPhrase('0'.repeat(64)), deviceKeyPhrase('f'.repeat(64)), deviceKeyPhrase('0001e240' + 'ab'.repeat(28))], ['000 000', '967 295', '123 456'])
  for (const bad of ['', 'F'.repeat(64), 'a'.repeat(63), null]) assert.throws(() => deviceKeyPhrase(bad), TypeError)
})

test('the add page: a passkey that joins shows its phrase and waits; a lost answer is said as unknown, never "nothing was added"', async t => {
  const fx = await fixture(t)
  const navigate = { accept: 'text/html', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' }
  const html = (await fx.call(PASSKEY_DEVICE_ROUTES.add, { headers: navigate })).body
  const code = 'A'.repeat(42) + 'Q'
  /** The page's own script in a DOM, with a browser passkey and the node's two answers played by `answer`. */
  const open = async answer => {
    const dom = new JSDOM(html, { url: `${ORIGIN}${PASSKEY_DEVICE_ROUTES.add}#${code}`, runScripts: 'dangerously', beforeParse(window) {
      window.PublicKeyCredential = function PublicKeyCredential() {}
      const bytes = text => new window.TextEncoder().encode(text).buffer
      Object.defineProperty(window.navigator, 'credentials', { value: { create: async () => ({ id: 'bmV3', rawId: Uint8Array.of(110, 101, 119).buffer, type: 'public-key',
        response: { clientDataJSON: bytes('{}'), attestationObject: bytes('a'), getTransports: () => ['internal'] } }) } })
      window.fetch = async (path, init) => answer(path, JSON.parse(init.body))
    } })
    t.after(() => dom.window.close())
    const document = dom.window.document
    assert.equal(document.getElementById('device-code').value, code, 'the code comes from the fragment')
    assert.equal(dom.window.location.hash, '', 'and leaves the address bar')
    document.getElementById('device-add-submit').click()
    const status = document.getElementById('device-add-status')
    for (let wait = 0; wait < 50 && !/Waiting|lost|did not accept/.test(status.textContent); wait++) await new Promise(resolve => { setTimeout(resolve, 5) })
    return { document, status: status.textContent }
  }
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  const options = { publicKey: { challenge: 'Y2hhbGxlbmdl', rp: { id: RP_ID, name: 'AUKORA' }, user: { id: 'dXNlcg', name: 'AUMLOK identity', displayName: 'x' },
    pubKeyCredParams: [{ type: 'public-key', alg: -7 }], timeout: 120000, attestation: 'none', authenticatorSelection: {}, excludeCredentials: [] } }
  // It joins: the phrase is shown, with the instruction to confirm only on a match.
  const joined = await open(path => path === PASSKEY_DEVICE_ROUTES.addChallenge ? json(options)
    : json({ ok: true, schema: 'aukora.aumlok.device-joining.v1', deviceId: 'bmV3', label: 'Laptop', phrase: '123 456', expiresAt: Date.now() + 600000 }))
  assert.equal(joined.document.getElementById('device-phrase').textContent, '123 456')
  assert.equal(joined.document.getElementById('device-phrase').hidden, false)
  assert.match(joined.status, /^Waiting for your other device to confirm\./)
  assert.match(joined.status, /same phrase/)
  // The answer to the registration is lost (the network fails after the passkey was sent): unknown, never "nothing added".
  const lost = await open(path => { if (path === PASSKEY_DEVICE_ROUTES.addChallenge) return json(options); throw new TypeError('Failed to fetch') })
  assert.match(lost.status, /answer was lost, so this page cannot tell whether the node kept this passkey/)
  assert.doesNotMatch(lost.status, /Nothing was (added|sent)/)
  // A server failure without the node's own words is unknown too; a worded refusal is said as that refusal.
  const failed = await open(path => path === PASSKEY_DEVICE_ROUTES.addChallenge ? json(options) : new Response('upstream', { status: 502 }))
  assert.match(failed.status, /answer was lost/)
  const refused = await open(path => path === PASSKEY_DEVICE_ROUTES.addChallenge ? json(options) : json({ ok: false, code: 'AUMLOK_DEVICE_KEY_ALREADY_ENROLLED' }, 409))
  assert.match(refused.status, /already enrolled for this owner/)
})

// ── Review: the enrolment instance alone, and a new code while a device asks to join ──────────────────────

test('the instance alone: an approval from an EARLIER enrolment of the same id and key, put back in the store, is refused', async t => {
  const fx = await fixture(t)
  const primary = await fx.signIn()
  const { device } = await fx.addDevice((await fx.makeCode(primary.cookie)).code)
  const firstInstance = (await fx.headStorage.get(AUMLOK_STORAGE_KEY)).devices[0].instance
  const deviceSession = await fx.signIn(device)
  const codeBody = await fx.codeBody('Spare')
  const { token: codeToken } = await fx.approve(deviceSession.cookie, PASSKEY_DEVICE_ROUTES.code, codeBody, device)
  const promote = { candidate: 'fixture' }, promoteBinding = await aumlokClass3Binding({ audience: ORIGIN, method: 'POST', pathname: '/_head/promote', body: promote })
  const { token: promoteToken } = await fx.approve(deviceSession.cookie, '/_head/promote', promote, device, undefined, { keep: true })
  // The device's two unspent approvals as the store held them (a copy of the store from before the removal keeps them).
  const earlier = (await fx.headStorage.get(AUMLOK_STORAGE_KEY)).approvals.filter(item => item.approvedBy === device.id)
  assert.deepEqual(earlier.map(item => item.approvedInstance), [firstInstance, firstInstance])
  // Removed by the primary, then the same id and key enrolled again: a new instance.
  const removeBody = { action: PASSKEY_DEVICE_REMOVE_ACTION, deviceId: device.id, generation: await fx.generation() }
  const { token: removeToken } = await fx.approve(primary.cookie, PASSKEY_DEVICE_ROUTES.remove, removeBody)
  assert.equal((await fx.call(PASSKEY_DEVICE_ROUTES.remove, { method: 'POST', cookie: primary.cookie, body: removeBody, headers: { 'x-x6-class3-approval': removeToken } })).response.status, 200)
  const again = await fx.addDevice((await fx.makeCode(primary.cookie, fx.passkey, 'Spare again')).code, device)
  assert.equal(again.added.response.status, 200, JSON.stringify(again.added.body))
  const now = await fx.headStorage.get(AUMLOK_STORAGE_KEY)
  assert.deepEqual(now.devices.map(item => item.credential.id), [device.id])
  assert.notEqual(now.devices[0].instance, firstInstance)
  // The earlier approvals come back into the store (as a restore of that copy would bring them): the removal's own
  // deletion is not what guards them now, only the instance they name.
  await fx.headStorage.put(AUMLOK_STORAGE_KEY, { ...now, approvals: [...now.approvals, ...earlier] })
  const spent = await fx.call(PASSKEY_DEVICE_ROUTES.code, { method: 'POST', cookie: primary.cookie, body: codeBody, headers: { 'x-x6-class3-approval': codeToken } })
  assert.deepEqual([spent.response.status, spent.body.code], [403, 'CLASS3_WEBAUTHN_REQUIRED'], 'through the Worker and HEAD')
  const store = createAumlokStore(fx.headStorage, { origins: [ORIGIN], ownerPublicKeyHex: fx.env.OWNER_PUBLIC_KEY_HEX })
  await assert.rejects(store.verifyApproval(promoteToken, promoteBinding, ORIGIN), error => error.code === 'CLASS3_WEBAUTHN_REQUIRED' && error.status === 403)
  assert.equal((await fx.headStorage.get(PASSKEY_DEVICES_PENDING_KEY)).pending, null, 'no code was made from the earlier enrolment\'s approval')
  // Control: the device's approvals of THIS enrolment are good.
  const { token: fresh } = await fx.approve((await fx.signIn(device)).cookie, '/_head/promote', promote, device)
  assert.equal((await store.verifyApproval(fresh, promoteBinding, ORIGIN)).ok, true)
})

test('a new code while a device asks to join is refused (never a silent replacement); an unused code is still replaced', async t => {
  const fx = await fixture(t)
  const primary = await fx.signIn()
  // An unused code IS replaced by a new one (the portal says so): the first stops working.
  const first = await fx.makeCode(primary.cookie, fx.passkey, 'First')
  const second = await fx.makeCode(primary.cookie, fx.passkey, 'Laptop')
  const stale = await fx.call(PASSKEY_DEVICE_ROUTES.addChallenge, { method: 'POST', body: { code: first.code } })
  assert.deepEqual([stale.response.status, stale.body.code], [403, 'AUMLOK_DEVICE_CODE_INVALID'])
  // The second code's device registers: it asks to join.
  const { joined, device } = await fx.addDevice(second.code, passkeyPair(), {}, {}, { confirm: false })
  assert.equal(joined.response.status, 200, JSON.stringify(joined.body))
  const before = await fx.headStorage.get(PASSKEY_DEVICES_PENDING_KEY)
  // The owner presses Add another device again: his passkey approves the exact body, and the host refuses it.
  const body = await fx.codeBody('Phone')
  const { token } = await fx.approve(primary.cookie, PASSKEY_DEVICE_ROUTES.code, body)
  const refused = await fx.call(PASSKEY_DEVICE_ROUTES.code, { method: 'POST', cookie: primary.cookie, body, headers: { 'x-x6-class3-approval': token } })
  assert.deepEqual([refused.response.status, refused.body.code], [409, 'AUMLOK_DEVICE_JOIN_WAITING'])
  // Nothing moved: the joining device is still there, the same record, and the approval is not spent.
  assert.deepEqual(await fx.headStorage.get(PASSKEY_DEVICES_PENDING_KEY), before)
  const list = (await fx.call(PASSKEY_DEVICE_ROUTES.list, { cookie: primary.cookie })).body
  assert.deepEqual([list.joining?.id, list.joining?.label, list.pending], [device.id, 'Laptop', null])
  assert.equal((await fx.headStorage.get(AUMLOK_STORAGE_KEY)).approvals.find(item => item.binding.pathname === PASSKEY_DEVICE_ROUTES.code)?.consumedAt, null)
  // He confirms it (it is added); then the same kind of code is made again.
  const added = await fx.confirmDevice(primary.cookie, device.id)
  assert.equal(added.response.status, 200, JSON.stringify(added.body))
  assert.equal(typeof (await fx.makeCode(primary.cookie, fx.passkey, 'Phone')).code, 'string')
  // And after a decline, too.
  const next = await fx.addDevice((await fx.makeCode(primary.cookie, fx.passkey, 'Tablet')).code, passkeyPair(), {}, {}, { confirm: false })
  assert.equal(next.joined.response.status, 200, JSON.stringify(next.joined.body))
  const nextInstance = (await fx.call(PASSKEY_DEVICE_ROUTES.list, { cookie: primary.cookie })).body.joining.instance
  const declined = await fx.call(PASSKEY_DEVICE_ROUTES.decline, { method: 'POST', cookie: primary.cookie,
    body: { action: PASSKEY_DEVICE_DECLINE_ACTION, deviceId: next.device.id, instance: nextInstance, generation: await fx.generation() } })
  assert.equal(declined.response.status, 200, JSON.stringify(declined.body))
  assert.equal(typeof (await fx.makeCode(primary.cookie, fx.passkey, 'Tablet')).code, 'string')
})

// ── Review: a confirmation is bound to ONE joining instance; registration deadlines after the writes; a code's
// challenges are reused and bounded; the list keeps polling through a failed read (Identity spec); no recordMac on the route ──

/** The owner makes a code WITHOUT letting earlier approvals go (fixture.approve's `keep`), so an unused one stays held. */
const makeCodeKeeping = async (fx, cookie, label) => {
  const body = await fx.codeBody(label)
  const { token } = await fx.approve(cookie, PASSKEY_DEVICE_ROUTES.code, body, fx.passkey, fx.userHandle, { keep: true })
  const made = await fx.call(PASSKEY_DEVICE_ROUTES.code, { method: 'POST', cookie, body, headers: { 'x-x6-class3-approval': token } })
  assert.equal(made.response.status, 200, JSON.stringify(made.body))
  return made.body
}
/** The outstanding (unspent) approvals of one exact confirm body, as aumlok:v1 holds them. */
const outstandingFor = async (fx, body) => {
  const { bodySha256 } = await aumlokClass3Binding({ audience: ORIGIN, method: 'POST', pathname: PASSKEY_DEVICE_ROUTES.confirm, body })
  return (await fx.headStorage.get(AUMLOK_STORAGE_KEY)).approvals.filter(item => item.binding.bodySha256 === bodySha256 && item.consumedAt === null)
}

for (const variant of ['decline', 'expiry']) {
  test(`MUST: an unused confirmation made for one joining never confirms a later one of the same id and key (after ${variant})`, async t => {
    const fx = await fixture(t)
    const primary = await fx.signIn()
    // Register A (the same id and key come back later).
    const device = passkeyPair()
    const first = await fx.addDevice((await fx.makeCode(primary.cookie)).code, device, {}, {}, { confirm: false })
    assert.equal(first.joined.response.status, 200, JSON.stringify(first.joined.body))
    const list = (await fx.call(PASSKEY_DEVICE_ROUTES.list, { cookie: primary.cookie })).body
    // One owner tab obtains a confirmation approval and does not use it yet.
    const old = { action: PASSKEY_DEVICE_CONFIRM_ACTION, deviceId: device.id, keyHash: list.joining.keyHash, instance: list.joining.instance, generation: list.generation }
    const { token } = await fx.approve(primary.cookie, PASSKEY_DEVICE_ROUTES.confirm, old)
    assert.equal((await outstandingFor(fx, old)).length, 1)
    if (variant === 'decline') {
      // Another tab declines A (200), naming its instance; a decline naming another instance turns nothing away.
      const wrong = await fx.call(PASSKEY_DEVICE_ROUTES.decline, { method: 'POST', cookie: primary.cookie,
        body: { action: PASSKEY_DEVICE_DECLINE_ACTION, deviceId: device.id, instance: 'B'.repeat(42) + 'A', generation: list.generation } })
      assert.deepEqual([wrong.response.status, wrong.body.code], [404, 'AUMLOK_DEVICE_JOIN_NOT_FOUND'])
      const declined = await fx.call(PASSKEY_DEVICE_ROUTES.decline, { method: 'POST', cookie: primary.cookie,
        body: { action: PASSKEY_DEVICE_DECLINE_ACTION, deviceId: device.id, instance: list.joining.instance, generation: list.generation } })
      assert.equal(declined.response.status, 200, JSON.stringify(declined.body))
      // The decline deleted the unused confirmation approval in its own transaction.
      assert.deepEqual(await outstandingFor(fx, old), [])
    } else {
      // A expires (its ten minutes end; the approval is still inside its own five).
      const record = await fx.headStorage.get(PASSKEY_DEVICES_PENDING_KEY)
      for (const key of ['issuedAt', 'expiresAt']) record.pending[key] -= 660000
      for (const key of ['registeredAt', 'expiresAt']) record.pending.joining[key] -= 660000
      await fx.headStorage.put(PASSKEY_DEVICES_PENDING_KEY, record)
    }
    // The old confirmation now fails.
    const gone = await fx.call(PASSKEY_DEVICE_ROUTES.confirm, { method: 'POST', cookie: primary.cookie, body: old, headers: { 'x-x6-class3-approval': token } })
    assert.deepEqual([gone.response.status, gone.body.code], [404, 'AUMLOK_DEVICE_JOIN_NOT_FOUND'])
    // Another code is issued (keeping the held approvals); for the expired joining, its approvals end here.
    const made = await makeCodeKeeping(fx, primary.cookie, 'Again')
    assert.deepEqual(await outstandingFor(fx, old), [], 'no confirmation of the ended joining is left outstanding')
    // The SAME credential id and key register again: a new joining, with a new instance.
    const again = await fx.addDevice(made.code, device, {}, {}, { confirm: false })
    assert.equal(again.joined.response.status, 200, JSON.stringify(again.joined.body))
    const now = (await fx.call(PASSKEY_DEVICE_ROUTES.list, { cookie: primary.cookie })).body.joining
    assert.deepEqual([now.id, now.keyHash], [device.id, list.joining.keyHash])
    assert.notEqual(now.instance, list.joining.instance)
    // THE REVIEWER'S STEP: the delayed old confirmation is submitted. It confirms nothing.
    const late = await fx.call(PASSKEY_DEVICE_ROUTES.confirm, { method: 'POST', cookie: primary.cookie, body: old, headers: { 'x-x6-class3-approval': token } })
    assert.deepEqual([late.response.status, late.body.code], [404, 'AUMLOK_DEVICE_JOIN_NOT_FOUND'])
    // The same approval sent with the NEW instance is refused as well. (The instance alone, with the old approval put
    // back in the store, is the next test.)
    const swapped = await fx.call(PASSKEY_DEVICE_ROUTES.confirm, { method: 'POST', cookie: primary.cookie, body: { ...old, instance: now.instance },
      headers: { 'x-x6-class3-approval': token } })
    assert.deepEqual([swapped.response.status, swapped.body.code], [403, 'CLASS3_WEBAUTHN_REQUIRED'])
    assert.equal(Object.hasOwn(await fx.headStorage.get(AUMLOK_STORAGE_KEY), 'devices'), false, 'nothing was enrolled')
    // Control: the owner confirms THIS joining (its own instance) and it is added.
    const added = await fx.confirmDevice(primary.cookie, device.id)
    assert.equal(added.response.status, 200, JSON.stringify(added.body))
    assert.deepEqual((await fx.headStorage.get(AUMLOK_STORAGE_KEY)).devices.map(item => item.credential.id), [device.id])
  })
}

test('MUST, the instance alone: the old confirmation approval put back after a decline and re-registration still confirms nothing', async t => {
  const fx = await fixture(t)
  const primary = await fx.signIn()
  const device = passkeyPair()
  await fx.addDevice((await fx.makeCode(primary.cookie)).code, device, {}, {}, { confirm: false })
  const list = (await fx.call(PASSKEY_DEVICE_ROUTES.list, { cookie: primary.cookie })).body
  const old = { action: PASSKEY_DEVICE_CONFIRM_ACTION, deviceId: device.id, keyHash: list.joining.keyHash, instance: list.joining.instance, generation: list.generation }
  const { token } = await fx.approve(primary.cookie, PASSKEY_DEVICE_ROUTES.confirm, old)
  const kept = await outstandingFor(fx, old)
  assert.equal(kept.length, 1)
  const declined = await fx.call(PASSKEY_DEVICE_ROUTES.decline, { method: 'POST', cookie: primary.cookie,
    body: { action: PASSKEY_DEVICE_DECLINE_ACTION, deviceId: device.id, instance: list.joining.instance, generation: list.generation } })
  assert.equal(declined.response.status, 200)
  const made = await makeCodeKeeping(fx, primary.cookie, 'Again')
  assert.equal((await fx.addDevice(made.code, device, {}, {}, { confirm: false })).joined.response.status, 200)
  // The decline's deletion undone: the unused approval is back, exactly as it was.
  const held = await fx.headStorage.get(AUMLOK_STORAGE_KEY)
  await fx.headStorage.put(AUMLOK_STORAGE_KEY, { ...held, approvals: [...held.approvals, ...kept] })
  const late = await fx.call(PASSKEY_DEVICE_ROUTES.confirm, { method: 'POST', cookie: primary.cookie, body: old, headers: { 'x-x6-class3-approval': token } })
  assert.deepEqual([late.response.status, late.body.code], [404, 'AUMLOK_DEVICE_JOIN_NOT_FOUND'], 'through the Worker and HEAD')
  assert.equal(Object.hasOwn(await fx.headStorage.get(AUMLOK_STORAGE_KEY), 'devices'), false)
  assert.equal((await outstandingFor(fx, old)).length, 1, 'refused without being spent')
})

test('a joining that ends by its code maker\'s removal takes its outstanding confirm approvals with it; a confirm ends the others', async t => {
  const fx = await fixture(t)
  const primary = await fx.signIn()
  const { device: maker } = await fx.addDevice((await fx.makeCode(primary.cookie)).code)
  const makerSession = await fx.signIn(maker)
  const body = await fx.codeBody('Made by the laptop')
  const { token: codeToken } = await fx.approve(makerSession.cookie, PASSKEY_DEVICE_ROUTES.code, body, maker)
  const made = await fx.call(PASSKEY_DEVICE_ROUTES.code, { method: 'POST', cookie: makerSession.cookie, body, headers: { 'x-x6-class3-approval': codeToken } })
  assert.equal(made.response.status, 200, JSON.stringify(made.body))
  const joiner = passkeyPair()
  assert.equal((await fx.addDevice(made.body.code, joiner, {}, {}, { confirm: false })).joined.response.status, 200)
  const list = (await fx.call(PASSKEY_DEVICE_ROUTES.list, { cookie: primary.cookie })).body
  const confirm = { action: PASSKEY_DEVICE_CONFIRM_ACTION, deviceId: joiner.id, keyHash: list.joining.keyHash, instance: list.joining.instance, generation: list.generation }
  await fx.approve(primary.cookie, PASSKEY_DEVICE_ROUTES.confirm, confirm)
  assert.equal((await outstandingFor(fx, confirm)).length, 1)
  const remove = { action: PASSKEY_DEVICE_REMOVE_ACTION, deviceId: maker.id, generation: list.generation }
  const { token: removeToken } = await fx.approve(primary.cookie, PASSKEY_DEVICE_ROUTES.remove, remove, fx.passkey, fx.userHandle, { keep: true })
  assert.equal((await fx.call(PASSKEY_DEVICE_ROUTES.remove, { method: 'POST', cookie: primary.cookie, body: remove, headers: { 'x-x6-class3-approval': removeToken } })).response.status, 200)
  assert.equal((await fx.headStorage.get(PASSKEY_DEVICES_PENDING_KEY)).pending, null)
  assert.deepEqual(await outstandingFor(fx, confirm), [], 'the removal ended the joining and its confirmation')
  // Two tabs approve the same confirm; one confirms: the other's approval ends with the joining, the used one stays spent.
  const second = await fx.addDevice((await fx.makeCode(primary.cookie)).code, passkeyPair(), {}, {}, { confirm: false })
  const now = (await fx.call(PASSKEY_DEVICE_ROUTES.list, { cookie: primary.cookie })).body
  const both = { action: PASSKEY_DEVICE_CONFIRM_ACTION, deviceId: second.device.id, keyHash: now.joining.keyHash, instance: now.joining.instance, generation: now.generation }
  const { token: tabA } = await fx.approve(primary.cookie, PASSKEY_DEVICE_ROUTES.confirm, both)
  await fx.approve(primary.cookie, PASSKEY_DEVICE_ROUTES.confirm, both, fx.passkey, fx.userHandle, { keep: true })
  assert.equal((await outstandingFor(fx, both)).length, 2)
  assert.equal((await fx.call(PASSKEY_DEVICE_ROUTES.confirm, { method: 'POST', cookie: primary.cookie, body: both, headers: { 'x-x6-class3-approval': tabA } })).response.status, 200)
  assert.deepEqual(await outstandingFor(fx, both), [])
  const { bodySha256 } = await aumlokClass3Binding({ audience: ORIGIN, method: 'POST', pathname: PASSKEY_DEVICE_ROUTES.confirm, body: both })
  assert.equal((await fx.headStorage.get(AUMLOK_STORAGE_KEY)).approvals.filter(item => item.binding.bodySha256 === bodySha256).length, 1, 'the used one stays, spent')
})

test('registration deadlines hold AFTER the awaited writes: time passing, or a clock going back, while they run commits nothing', async t => {
  const fx = await fixture(t)
  const primary = await fx.signIn()
  const device = passkeyPair()
  // The reviewer's probe: the request and the first deadline check run one millisecond before the challenge ends; the
  // write sees ten seconds after it (time() is read at the start, at the commit check, then in write()).
  const made = await fx.makeCode(primary.cookie)
  const issued = await fx.call(PASSKEY_DEVICE_ROUTES.addChallenge, { method: 'POST', body: { code: made.code } })
  const { challengeExpiresAt } = (await fx.headStorage.get(PASSKEY_DEVICES_PENDING_KEY)).pending
  const before = fx.headStorage.snapshot()
  const ticks = [challengeExpiresAt - 1, challengeExpiresAt - 1]
  const late = createAumlokStore(fx.headStorage, { origins: [ORIGIN], ownerPublicKeyHex: fx.env.OWNER_PUBLIC_KEY_HEX, now: () => ticks.shift() ?? challengeExpiresAt + 10000 })
  await assert.rejects(late.devices('device-add', { code: made.code, credential: registrationFor(device, issued.body.publicKey.challenge) }, ORIGIN, {}),
    error => error.code === 'AUMLOK_DEVICE_CODE_EXPIRED' && error.status === 409)
  assert.equal(fx.headStorage.snapshot(), before, 'rolled back: nothing joined, no audit row')
  assert.equal((await fx.call(PASSKEY_DEVICE_ROUTES.list, { cookie: primary.cookie })).body.joining, null, 'the owner\'s list shows nothing joining')
  // The clock goes back only at the write.
  const start = Date.now(), back = [start, start]
  const backwards = createAumlokStore(fx.headStorage, { origins: [ORIGIN], ownerPublicKeyHex: fx.env.OWNER_PUBLIC_KEY_HEX, now: () => back.shift() ?? start - 60000 })
  await assert.rejects(backwards.devices('device-add', { code: made.code, credential: registrationFor(device, issued.body.publicKey.challenge) }, ORIGIN, {}),
    error => error.code === 'AUMLOK_DEVICE_CODE_EXPIRED')
  assert.equal(fx.headStorage.snapshot(), before)
  // Control: on a steady clock the same registration joins.
  const joined = await fx.call(PASSKEY_DEVICE_ROUTES.add, { method: 'POST', body: { code: made.code, credential: registrationFor(device, issued.body.publicKey.challenge) } })
  assert.equal(joined.response.status, 200, JSON.stringify(joined.body))
})

test('a code holder cannot churn the registration challenge: a live one is handed out again, renewals are bounded, the bound is audited once', async t => {
  const fx = await fixture(t)
  const primary = await fx.signIn()
  const made = await fx.makeCode(primary.cookie)
  const firstAskedAt = Date.now()
  const first = await fx.call(PASSKEY_DEVICE_ROUTES.addChallenge, { method: 'POST', body: { code: made.code } })
  assert.equal(first.response.status, 200, JSON.stringify(first.body))
  const afterFirst = fx.headStorage.snapshot(), attempts = (await fx.headStorage.get(AUMLOK_STORAGE_KEY)).attempts.length
  // The reviewer's 25 requests through one isolate: each one ADMITTED goes to HEAD and gets the SAME challenge; past six in
  // two seconds the isolate refuses at once (no answer is kept at the edge, only admission times). Nothing is written.
  const heads = fx.doCalls.length
  let admitted = 1
  for (let index = 0; index < 25; index++) {
    const again = await fx.call(PASSKEY_DEVICE_ROUTES.addChallenge, { method: 'POST', body: { code: made.code }, address: `198.51.100.${String(index)}` })
    if (again.response.status === 200) { admitted++; assert.equal(again.body.publicKey.challenge, first.body.publicKey.challenge) }
    else {
      assert.deepEqual([again.response.status, again.body.code], [429, 'AUMLOK_DEVICE_CHALLENGE_BUSY'])
      assert.equal(again.response.headers.get('retry-after'), String(again.body.retryAfterSeconds))
    }
  }
  assert.equal(fx.doCalls.slice(heads).filter(item => item.startsWith('HEAD')).length, admitted - 1, 'every admitted ask reached HEAD, no other')
  const { perWindow, windowMs } = PASSKEY_DEVICE_CHALLENGE_ADMISSION
  assert.ok(admitted <= perWindow * (1 + Math.floor((Date.now() - firstAskedAt) / windowMs)), String(admitted))
  // Each holder on its own isolate reaches HEAD, and HEAD hands every one the same live challenge.
  for (let index = 0; index < 25; index++) {
    const again = await fx.call(PASSKEY_DEVICE_ROUTES.addChallenge, { method: 'POST', body: { code: made.code }, isolate: `holder-${String(index)}` })
    assert.equal(again.body.publicKey.challenge, first.body.publicKey.challenge)
  }
  assert.equal(fx.headStorage.snapshot(), afterFirst, 'no HEAD write')
  // So the owner's registration, in flight on the first challenge all along, still joins.
  const device = passkeyPair()
  const joined = await fx.call(PASSKEY_DEVICE_ROUTES.add, { method: 'POST', body: { code: made.code, credential: registrationFor(device, first.body.publicKey.challenge) } })
  assert.equal(joined.response.status, 200, JSON.stringify(joined.body))
  const list = (await fx.call(PASSKEY_DEVICE_ROUTES.list, { cookie: primary.cookie })).body
  await fx.call(PASSKEY_DEVICE_ROUTES.decline, { method: 'POST', cookie: primary.cookie,
    body: { action: PASSKEY_DEVICE_DECLINE_ACTION, deviceId: device.id, instance: list.joining.instance, generation: list.generation } })
  // Renewals: only an EXPIRED challenge is replaced (a live one never is), counted; the code gets six in its life.
  // Expiry is made by editing HEAD's record; each ask goes through its own isolate (so the edge's admission bound of
  // job 6 is never what is measured here).
  const code = (await fx.makeCode(primary.cookie)).code
  const nearlyOver = async () => {
    const record = await fx.headStorage.get(PASSKEY_DEVICES_PENDING_KEY)
    if (record.pending.challenge !== null) { record.pending.challengeExpiresAt = Date.now() - 1; await fx.headStorage.put(PASSKEY_DEVICES_PENDING_KEY, record) }
  }
  const seen = new Set()
  for (let issued = 1; issued <= PASSKEY_DEVICE_LIMITS.codeChallenges; issued++) {
    await nearlyOver()
    const renewed = await fx.call(PASSKEY_DEVICE_ROUTES.addChallenge, { method: 'POST', body: { code }, isolate: `renew-${String(issued)}` })
    assert.equal(renewed.response.status, 200, JSON.stringify(renewed.body))
    seen.add(renewed.body.publicKey.challenge)
    assert.equal((await fx.headStorage.get(PASSKEY_DEVICES_PENDING_KEY)).pending.challengesIssued, issued)
  }
  assert.equal(seen.size, PASSKEY_DEVICE_LIMITS.codeChallenges)
  const limitRows = async () => (await fx.headStorage.get(AUMLOK_STORAGE_KEY)).attempts.filter(item => item.purpose === 'device-challenge')
  assert.deepEqual(await limitRows(), [])
  // The request past the bound ends the code, with ONE audit entry; later requests write nothing more.
  await nearlyOver()
  const over = await fx.call(PASSKEY_DEVICE_ROUTES.addChallenge, { method: 'POST', body: { code }, isolate: 'over' })
  assert.deepEqual([over.response.status, over.body.code], [403, 'AUMLOK_DEVICE_CODE_BURNED'])
  assert.equal((await fx.headStorage.get(PASSKEY_DEVICES_PENDING_KEY)).pending, null)
  const rows = await limitRows()
  assert.deepEqual(rows.map(item => item.outcome), ['CHALLENGE_LIMIT'])
  assert.ok(rows.every(oldBuildReadsAttempt), 'the build before devices reads the row')
  const settled = fx.headStorage.snapshot()
  for (let index = 0; index < 5; index++) {
    const after = await fx.call(PASSKEY_DEVICE_ROUTES.addChallenge, { method: 'POST', body: { code } })
    assert.deepEqual([after.response.status, after.body.code], [403, 'AUMLOK_DEVICE_CODE_INVALID'])
  }
  assert.equal(fx.headStorage.snapshot(), settled)
  assert.equal((await limitRows()).length, 1)
  assert.ok((await fx.headStorage.get(AUMLOK_STORAGE_KEY)).attempts.length >= attempts)
})

test('the status route leaves out every approval\'s recordMac (checked on the bytes sent); its readers\' fields and the facts stay', async t => {
  const fx = await fixture(t)
  const primary = await fx.signIn()
  await fx.approve(primary.cookie, '/_head/promote', { candidate: 'fixture' })
  await makeCodeKeeping(fx, primary.cookie, 'Laptop')
  const status = await fx.call('/_host/aumlok/status', { cookie: primary.cookie })
  assert.equal(status.response.status, 200)
  assert.equal(status.text.includes('recordMac'), false, 'not in the serialised answer')
  assert.equal(status.body.approvedGrants.length, 2)
  for (const grant of status.body.approvedGrants) {
    // aumlok-ceremony.ts reads schema, approvalId, binding, approvedAt, expiresAt, consumedAt; sovereignty-cards.ts the
    // same records; host-facts.ts the count.
    assert.deepEqual(Object.keys(grant).sort(), ['approvalId', 'approvedAt', 'binding', 'consumedAt', 'expiresAt', 'generation', 'schema'])
  }
  // In process, the store's status still carries it, and the verified-facts projection (which requires it) accepts it.
  const store = createAumlokStore(fx.headStorage, { origins: [ORIGIN], ownerPublicKeyHex: fx.env.OWNER_PUBLIC_KEY_HEX })
  const inProcess = await store.status()
  assert.ok(inProcess.approvedGrants.every(grant => /^[0-9a-f]{64}$/.test(grant.recordMac)))
  assert.equal(projectAumlokStatus(inProcess).phase, 'BOUND')
  assert.deepEqual(JSON.parse(JSON.stringify(aumlokStatusAnswer(inProcess))), status.body)
})

// ── Job 3 (review): the reused challenge's timeout, a late registration, a live challenge kept ─────

/** Moves the outstanding registration challenge's deadline to `msLeft` from now (negative: already expired). */
const challengeLeft = async (fx, msLeft) => {
  const record = await fx.headStorage.get(PASSKEY_DEVICES_PENDING_KEY)
  record.pending.challengeExpiresAt = Math.min(Date.now() + msLeft, record.pending.expiresAt)
  await fx.headStorage.put(PASSKEY_DEVICES_PENDING_KEY, record)
  return record.pending.challengeExpiresAt
}

test('a challenge handed out again carries its REMAINING life as the browser timeout (40 s left: a 40 s timeout, never 120 s)', async t => {
  const fx = await fixture(t)
  const primary = await fx.signIn()
  const made = await fx.makeCode(primary.cookie)
  const first = await fx.call(PASSKEY_DEVICE_ROUTES.addChallenge, { method: 'POST', body: { code: made.code } })
  assert.equal(first.response.status, 200, JSON.stringify(first.body))
  assert.ok(first.body.publicKey.timeout <= PASSKEY_DEVICE_LIMITS.registrationMs && first.body.publicKey.timeout > PASSKEY_DEVICE_LIMITS.registrationMs - 5000)
  const deadline = await challengeLeft(fx, 40000)
  const before = Date.now()
  // Asked through another isolate (the 80 s were taken off by editing HEAD's record; since job 6 the edge keeps no answer).
  const again = await fx.call(PASSKEY_DEVICE_ROUTES.addChallenge, { method: 'POST', body: { code: made.code }, isolate: 'B' })
  const after = Date.now()
  assert.equal(again.response.status, 200, JSON.stringify(again.body))
  assert.equal(again.body.publicKey.challenge, first.body.publicKey.challenge, 'the same challenge')
  assert.equal(again.body.expiresAt, deadline)
  // HEAD's clock read falls between `before` and `after`: the timeout is exactly deadline minus that read.
  assert.ok(again.body.publicKey.timeout <= deadline - before && again.body.publicKey.timeout >= deadline - after, String(again.body.publicKey.timeout))
  assert.ok(again.body.publicKey.timeout > 39000 && again.body.publicKey.timeout <= 40000)
})

test('a registration that arrives after its challenge expired is refused as out of time, counts no miss and writes nothing; asking again renews', async t => {
  const fx = await fixture(t)
  const primary = await fx.signIn()
  const counters = await fx.ownerCounters()
  const made = await fx.makeCode(primary.cookie)
  const issued = await fx.call(PASSKEY_DEVICE_ROUTES.addChallenge, { method: 'POST', body: { code: made.code } })
  assert.equal(issued.response.status, 200, JSON.stringify(issued.body))
  await challengeLeft(fx, -1)
  const before = fx.headStorage.snapshot()
  const device = passkeyPair()
  // Five late sends (as many as burn a code by misses): each refused as out of time; the code lives, its misses stay 0.
  for (let index = 0; index < PASSKEY_DEVICE_LIMITS.codeMisses; index++) {
    const late = await fx.call(PASSKEY_DEVICE_ROUTES.add, { method: 'POST', body: { code: made.code, credential: registrationFor(device, issued.body.publicKey.challenge) } })
    assert.deepEqual([late.response.status, late.body.code], [409, 'AUMLOK_DEVICE_CHALLENGE_EXPIRED'])
  }
  assert.equal(fx.headStorage.snapshot(), before, 'no miss, no audit row, nothing written')
  assert.equal((await fx.headStorage.get(PASSKEY_DEVICES_PENDING_KEY)).pending.misses, 0)
  // The page asks again after expiry: a renewal (counted toward the bound), and the passkey made on it joins.
  const renewed = await fx.call(PASSKEY_DEVICE_ROUTES.addChallenge, { method: 'POST', body: { code: made.code } })
  assert.equal(renewed.response.status, 200, JSON.stringify(renewed.body))
  assert.notEqual(renewed.body.publicKey.challenge, issued.body.publicKey.challenge)
  assert.equal((await fx.headStorage.get(PASSKEY_DEVICES_PENDING_KEY)).pending.challengesIssued, 2)
  const joined = await fx.call(PASSKEY_DEVICE_ROUTES.add, { method: 'POST', body: { code: made.code, credential: registrationFor(device, renewed.body.publicKey.challenge) } })
  assert.equal(joined.response.status, 200, JSON.stringify(joined.body))
  assert.deepEqual(await fx.ownerCounters(), counters, 'no owner lockout counter moved')
})

test('a live challenge is never replaced, however little of it is left: the owner\'s in-flight registration on it still joins', async t => {
  const fx = await fixture(t)
  const primary = await fx.signIn()
  const made = await fx.makeCode(primary.cookie)
  const first = await fx.call(PASSKEY_DEVICE_ROUTES.addChallenge, { method: 'POST', body: { code: made.code } })
  assert.equal(first.response.status, 200, JSON.stringify(first.body))
  // Five seconds left (well under the 30 s the earlier build replaced at): every holder's request gets the same one.
  // (Each holder asks through its own isolate, so every ask reaches HEAD past the edge's admission bound of job 6.)
  await challengeLeft(fx, 5000)
  const held = fx.headStorage.snapshot()
  for (let index = 0; index < 10; index++) {
    const again = await fx.call(PASSKEY_DEVICE_ROUTES.addChallenge, { method: 'POST', body: { code: made.code }, address: `198.51.100.${String(index)}`, isolate: `B${String(index)}` })
    assert.equal(again.response.status, 200, JSON.stringify(again.body))
    assert.equal(again.body.publicKey.challenge, first.body.publicKey.challenge)
    assert.ok(again.body.publicKey.timeout > 0 && again.body.publicKey.timeout <= 5000)
  }
  assert.equal(fx.headStorage.snapshot(), held, 'nothing written, nothing counted')
  assert.equal((await fx.headStorage.get(PASSKEY_DEVICES_PENDING_KEY)).pending.challengesIssued, 1)
  const device = passkeyPair()
  const joined = await fx.call(PASSKEY_DEVICE_ROUTES.add, { method: 'POST', body: { code: made.code, credential: registrationFor(device, first.body.publicKey.challenge) } })
  assert.equal(joined.response.status, 200, JSON.stringify(joined.body))
})

/**
 * The add page in JSDOM with a stubbed passkey prompt, fetch and MONOTONIC CLOCK: `performance.now()` reads `clock.now`,
 * which only the stubbed fetch moves (by `clock.delay` per request), so the page's elapsed-time arithmetic is exact.
 */
async function addPageHarness(t, fx) {
  const navigate = { accept: 'text/html', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' }
  const html = (await fx.call(PASSKEY_DEVICE_ROUTES.add, { headers: navigate })).body
  const code = 'A'.repeat(42) + 'Q'
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  const options = timeout => ({ publicKey: { challenge: 'Y2hhbGxlbmdl', rp: { id: RP_ID, name: 'AUKORA' }, user: { id: 'dXNlcg', name: 'AUMLOK identity', displayName: 'x' },
    pubKeyCredParams: [{ type: 'public-key', alg: -7 }], timeout, attestation: 'none', authenticatorSelection: {}, excludeCredentials: [] } })
  const open = async (create, answer, clock = { now: 1000, delay: 0 }) => {
    const posted = []
    const dom = new JSDOM(html, { url: `${ORIGIN}${PASSKEY_DEVICE_ROUTES.add}#${code}`, runScripts: 'dangerously', beforeParse(window) {
      window.PublicKeyCredential = function PublicKeyCredential() {}
      Object.defineProperty(window.navigator, 'credentials', { value: { create: init => create(init, window) } })
      Object.defineProperty(window.performance, 'now', { value: () => clock.now })
      window.fetch = async (path, init) => { posted.push(path); clock.now += clock.delay; return answer(path, JSON.parse(init.body)) }
    } })
    t.after(() => dom.window.close())
    dom.window.document.getElementById('device-add-submit').click()
    const status = dom.window.document.getElementById('device-add-status')
    for (let wait = 0; wait < 200 && !/ran out|Waiting|lost|did not accept|No passkey/.test(status.textContent); wait++) await new Promise(resolve => { setTimeout(resolve, 5) })
    return { status: status.textContent, posted }
  }
  return { open, json, options }
}

test('the add page ends the passkey prompt at the challenge deadline and says plainly that nothing was counted; so does a late refusal', async t => {
  const fx = await fixture(t)
  const { open, json, options } = await addPageHarness(t, fx)
  // The prompt is still open when the 60 ms the node gave runs out: the page aborts it and sends nothing.
  let seen = null
  const hanging = (init, window) => { seen = init; return new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new window.DOMException('The operation was aborted.', 'AbortError')))
  }) }
  const aborted = await open(hanging, path => path === PASSKEY_DEVICE_ROUTES.addChallenge ? json(options(60)) : json({ ok: false }, 500))
  assert.equal(seen.publicKey.timeout, 60, 'the browser is told the remaining life')
  assert.equal(seen.signal.aborted, true, 'the prompt was ended at the deadline')
  assert.match(aborted.status, /^This attempt ran out of time, so nothing was counted against the code\./)
  assert.deepEqual(aborted.posted, [PASSKEY_DEVICE_ROUTES.addChallenge], 'no registration was sent')
  // A passkey made in time whose answer reaches the node after the deadline: the node's refusal is said the same way.
  const bytes = text => new TextEncoder().encode(text).buffer
  const made = async () => ({ id: 'bmV3', rawId: Uint8Array.of(110, 101, 119).buffer, type: 'public-key',
    response: { clientDataJSON: bytes('{}'), attestationObject: bytes('a'), getTransports: () => ['internal'] } })
  const refused = await open(made, path => path === PASSKEY_DEVICE_ROUTES.addChallenge ? json(options(60000)) : json({ ok: false, code: 'AUMLOK_DEVICE_CHALLENGE_EXPIRED' }, 409))
  assert.match(refused.status, /ran out of time, so nothing was counted against the code/)
  assert.doesNotMatch(refused.status, /did not accept/)
})

// ── Job 4: capacity is never a credential failure; only outstanding ceremonies hold a slot ──

test('MUST, the reviewer\'s sequence with NO fixture cleanup: add A, add B, then a removal is approved at once; no owner counter moves', async t => {
  const fx = await fixture(t, { cleanup: false })
  const primary = await fx.signIn()
  const counters = await fx.ownerCounters()
  // Add and confirm A, then B: four approval ceremonies, all consumed, all inside one two-minute ceremony life.
  const a = await fx.addDevice((await fx.makeCode(primary.cookie)).code, passkeyPair(), {}, {}, { cookie: primary.cookie })
  assert.equal(a.added.response.status, 200, JSON.stringify(a.added.body))
  const b = await fx.addDevice((await fx.makeCode(primary.cookie, fx.passkey, 'Phone')).code, passkeyPair(), {}, {}, { cookie: primary.cookie })
  assert.equal(b.added.response.status, 200, JSON.stringify(b.added.body))
  const held = await fx.headStorage.get(AUMLOK_STORAGE_KEY)
  assert.equal(held.challenges.length, 4)
  assert.ok(held.challenges.every(record => record.consumedAt !== null), 'four consumed ceremonies sit in the four records')
  // The removal: its approval ceremony is issued straight away (it was AUMLOK_CHALLENGE_CAPACITY five times running before).
  const body = { action: PASSKEY_DEVICE_REMOVE_ACTION, deviceId: a.device.id, generation: await fx.generation() }
  const { token } = await fx.approve(primary.cookie, PASSKEY_DEVICE_ROUTES.remove, body)
  const removed = await fx.call(PASSKEY_DEVICE_ROUTES.remove, { method: 'POST', cookie: primary.cookie, body, headers: { 'x-x6-class3-approval': token } })
  assert.equal(removed.response.status, 200, JSON.stringify(removed.body))
  assert.deepEqual((await fx.headStorage.get(AUMLOK_STORAGE_KEY)).devices.map(device => device.credential.id), [b.device.id])
  assert.deepEqual(await fx.ownerCounters(), counters, 'no failure, no backoff')
  assert.ok((await fx.headStorage.get(AUMLOK_STORAGE_KEY)).attempts.every(record => !record.outcome.includes('CAPACITY') && record.outcome !== 'AUMLOK_RATE_LIMITED'))
  // THE STORED SHAPE IS THE OLD ONE: still at most four challenge records, each with its 24 fields.
  const after = await fx.headStorage.get(AUMLOK_STORAGE_KEY)
  assert.equal(after.challenges.length, 4)
  assert.ok(after.challenges.every(record => Object.keys(record).length === 24))
  // SINGLE USE AS STRICT AS EVER: the ceremony let go for the removal's (the first, A's code) is unknown now; one kept as
  // a replay record is used. Both are refused; under the one rule neither moves any counter or gate: no proof
  // was judged (a used or unknown challenge is never a failed passkey).
  assert.equal(after.challenges.some(record => record.id === fx.approvals[0].challengeId), false)
  const evicted = await fx.call('/_host/aumlok/approve', { method: 'POST', cookie: primary.cookie, body: fx.approvals[0] })
  assert.deepEqual([evicted.response.status, evicted.body.code], [409, 'AUMLOK_CHALLENGE_UNKNOWN'])
  const kept = await fx.call('/_host/aumlok/approve', { method: 'POST', cookie: primary.cookie, body: fx.approvals.at(-1) })
  assert.deepEqual([kept.response.status, kept.body.code], [409, 'AUMLOK_CHALLENGE_USED'])
  assert.deepEqual(await fx.ownerCounters(), counters, 'refused, never counted')
  assert.equal((await fx.headStorage.get(AUMLOK_STORAGE_KEY)).approvals.filter(item => item.consumedAt === null).length, 0, 'no approval was minted by a replay')
})

test('MUST: four OUTSTANDING ceremonies refuse a fifth with its wait (body and Retry-After), never counted; a slot that frees is used at once; a wrong proof still counts', async t => {
  const fx = await fixture(t, { cleanup: false })
  const primary = await fx.signIn()
  const counters = await fx.ownerCounters()
  const open = async index => fx.call('/_host/aumlok/challenge', { method: 'POST', cookie: primary.cookie,
    body: { purpose: 'approve', requestId: `outstanding-${String(index)}`, binding: await aumlokClass3Binding({ audience: ORIGIN, method: 'POST', pathname: '/_head/promote', body: { candidate: index } }) } })
  const outstanding = []
  for (let index = 0; index < 4; index++) {
    const issued = await open(index)
    assert.equal(issued.response.status, 200, JSON.stringify(issued.body))
    outstanding.push(issued.body)
  }
  for (let retry = 0; retry < 5; retry++) {
    const sentAt = Date.now()
    const full = await open(10 + retry)
    const gotAt = Date.now()
    assert.deepEqual([full.response.status, full.body.code], [429, 'AUMLOK_CHALLENGE_CAPACITY'])
    // The wait is to the FIRST outstanding ceremony's expiry, in whole seconds, as HEAD's clock read it during the call.
    const wait = full.body.retryAfterSeconds
    assert.ok(Number.isSafeInteger(wait) && wait >= Math.ceil((outstanding[0].expiresAt - gotAt) / 1000) && wait <= Math.ceil((outstanding[0].expiresAt - sentAt) / 1000), JSON.stringify(full.body))
    assert.equal(full.response.headers.get('retry-after'), String(wait))
  }
  assert.deepEqual(await fx.ownerCounters(), counters, 'five capacity refusals moved no counter and set no backoff')
  // One outstanding ceremony is completed: its slot frees, and the next ceremony is issued and approves straight away.
  const done = await fx.call('/_host/aumlok/approve', { method: 'POST', cookie: primary.cookie,
    body: { challengeId: outstanding[0].challengeId, credential: assertionFor(fx.passkey, outstanding[0].publicKey.challenge) } })
  assert.equal(done.response.status, 200, JSON.stringify(done.body))
  const next = await open(20)
  assert.equal(next.response.status, 200, JSON.stringify(next.body))
  const approved = await fx.call('/_host/aumlok/approve', { method: 'POST', cookie: primary.cookie,
    body: { challengeId: next.body.challengeId, credential: assertionFor(fx.passkey, next.body.publicKey.challenge) } })
  assert.equal(approved.response.status, 200, JSON.stringify(approved.body))
  assert.equal(typeof approved.body.approvalToken, 'string')
  assert.deepEqual(await fx.ownerCounters(), counters)
  // A REAL WRONG PROOF STILL COUNTS: an assertion signed by a key that is not enrolled.
  const wrong = await open(30)
  assert.equal(wrong.response.status, 200, JSON.stringify(wrong.body))
  const forged = await fx.call('/_host/aumlok/approve', { method: 'POST', cookie: primary.cookie,
    body: { challengeId: wrong.body.challengeId, credential: assertionFor(fx.passkey, wrong.body.publicKey.challenge, { signer: passkeyPair().key }) } })
  assert.deepEqual([forged.response.status, forged.body.code], [403, 'AUMLOK_PROOF_INVALID'])
  assert.equal(forged.response.headers.has('retry-after'), false)
  const after = await fx.ownerCounters()
  assert.equal(after.failures, 1)
  assert.equal(after.failedAt.length, 1)
  // ...and at HEAD's own gate on the approve route, exactly once (the same rule decides both).
  assert.equal(after.headGates.length, 1)
  assert.equal(after.headGates[0][1].failedAt.length, 1)
})

test('MUST, on a clock: retries at 1, 3, 7 and 15 s while four ceremonies are outstanding are told the exact wait and never rate-limited; at the first expiry approval works', async t => {
  const fx = await fixture(t, { cleanup: false })
  let clock = Date.now()
  const t0 = clock
  const store = createAumlokStore(fx.headStorage, { origins: [ORIGIN], ownerPublicKeyHex: fx.env.OWNER_PUBLIC_KEY_HEX, now: () => clock })
  const binding = async index => aumlokClass3Binding({ audience: ORIGIN, method: 'POST', pathname: '/_head/promote', body: { candidate: index } })
  for (let index = 0; index < 4; index++) {
    clock = t0 + index * 10
    await store.challenge({ purpose: 'approve', requestId: `clock-${String(index)}`, binding: await binding(index) }, ORIGIN)
  }
  for (const [after, wait] of [[1000, 119], [3000, 117], [7000, 113], [15000, 105], [119999, 1]]) {
    clock = t0 + after
    await assert.rejects(store.challenge({ purpose: 'approve', requestId: `retry-${String(after)}`, binding: await binding(99) }, ORIGIN),
      error => error.code === 'AUMLOK_CHALLENGE_CAPACITY' && error.status === 429 && error.retryAfterSeconds === wait)
  }
  const state = await fx.headStorage.get(AUMLOK_STORAGE_KEY)
  assert.deepEqual([state.failures, state.failedAt, state.nextAllowedAt], [0, [], 0], 'no failure budget spent, no backoff')
  // The moment the first ceremony expires, its slot is free: a new ceremony is issued and its approval is made.
  clock = t0 + 120000
  const issued = await store.challenge({ purpose: 'approve', requestId: 'freed', binding: await binding(99) }, ORIGIN)
  const result = await store.complete('approve', { challengeId: issued.challengeId, credential: assertionFor(fx.passkey, issued.publicKey.challenge) }, ORIGIN)
  assert.equal(typeof result.approvalToken, 'string', JSON.stringify(result))
  const after = await fx.headStorage.get(AUMLOK_STORAGE_KEY)
  assert.deepEqual([after.failures, after.failedAt, after.nextAllowedAt], [0, [], 0])
})

test('a full approval record (eight in five minutes) is a capacity refusal too: its wait is said, no failure is counted, and it clears at the first expiry', async t => {
  const fx = await fixture(t, { cleanup: false })
  let clock = Date.now()
  const t0 = clock
  const store = createAumlokStore(fx.headStorage, { origins: [ORIGIN], ownerPublicKeyHex: fx.env.OWNER_PUBLIC_KEY_HEX, now: () => clock })
  const approveOnce = async index => {
    const issued = await store.challenge({ purpose: 'approve', requestId: `record-${String(index)}`,
      binding: await aumlokClass3Binding({ audience: ORIGIN, method: 'POST', pathname: '/_head/promote', body: { candidate: index } }) }, ORIGIN)
    return store.complete('approve', { challengeId: issued.challengeId, credential: assertionFor(fx.passkey, issued.publicKey.challenge) }, ORIGIN)
  }
  for (let index = 0; index < AUMLOK_LIMITS.approvalRecords; index++) {
    clock = t0 + index * 1000
    assert.equal(typeof (await approveOnce(index)).approvalToken, 'string')
  }
  clock = t0 + 10000
  const full = await approveOnce(100)
  assert.deepEqual([full.ok, full.code, full.status, full.retryAfterSeconds], [false, 'AUMLOK_APPROVAL_CAPACITY', 429, Math.ceil((t0 + AUMLOK_LIMITS.approvalMs - clock) / 1000)])
  const state = await fx.headStorage.get(AUMLOK_STORAGE_KEY)
  assert.deepEqual([state.failures, state.failedAt, state.nextAllowedAt], [0, [], 0])
  assert.equal(state.approvals.length, AUMLOK_LIMITS.approvalRecords)
  // Through the Worker and HEAD: the refusal comes back as a result (not a throw) and still carries Retry-After.
  const primary = await fx.signIn()
  const binding = await aumlokClass3Binding({ audience: ORIGIN, method: 'POST', pathname: '/_head/promote', body: { candidate: 'worker' } })
  const issued = await fx.call('/_host/aumlok/challenge', { method: 'POST', cookie: primary.cookie, body: { purpose: 'approve', requestId: 'record-worker', binding } })
  assert.equal(issued.response.status, 200, JSON.stringify(issued.body))
  const refused = await fx.call('/_host/aumlok/approve', { method: 'POST', cookie: primary.cookie,
    body: { challengeId: issued.body.challengeId, credential: assertionFor(fx.passkey, issued.body.publicKey.challenge) } })
  assert.deepEqual([refused.response.status, refused.body.code], [429, 'AUMLOK_APPROVAL_CAPACITY'])
  assert.ok(Number.isSafeInteger(refused.body.retryAfterSeconds) && refused.body.retryAfterSeconds >= 1, JSON.stringify(refused.body))
  assert.equal(refused.response.headers.get('retry-after'), String(refused.body.retryAfterSeconds))
  assert.equal((await fx.ownerCounters()).failures, 0)
  clock = t0 + AUMLOK_LIMITS.approvalMs
  assert.equal(typeof (await approveOnce(101)).approvalToken, 'string')
})

test('SHOULD: a late answer to an expired challenge is refused BEFORE the renewed one is touched: no miss, and the renewed challenge still joins', async t => {
  const fx = await fixture(t)
  const primary = await fx.signIn()
  const counters = await fx.ownerCounters()
  const made = await fx.makeCode(primary.cookie)
  const device = passkeyPair()
  const first = await fx.call(PASSKEY_DEVICE_ROUTES.addChallenge, { method: 'POST', body: { code: made.code } })
  assert.equal(first.response.status, 200, JSON.stringify(first.body))
  const lateAnswer = { code: made.code, credential: registrationFor(device, first.body.publicKey.challenge) }
  // A expires; B is issued (through another isolate: the expiry is made by editing HEAD's record).
  await challengeLeft(fx, -1)
  const renewed = await fx.call(PASSKEY_DEVICE_ROUTES.addChallenge, { method: 'POST', body: { code: made.code }, isolate: 'B' })
  assert.equal(renewed.response.status, 200, JSON.stringify(renewed.body))
  assert.notEqual(renewed.body.publicKey.challenge, first.body.publicKey.challenge)
  const pending = (await fx.headStorage.get(PASSKEY_DEVICES_PENDING_KEY)).pending
  assert.equal(pending.lapsed.length, 1, 'the lapsed challenge is remembered by its hash')
  assert.equal(JSON.stringify(pending).includes(first.body.publicKey.challenge), false, 'never by its value')
  // A's delayed answer: ran out of time, no miss, nothing written; B is untouched.
  const before = fx.headStorage.snapshot()
  const late = await fx.call(PASSKEY_DEVICE_ROUTES.add, { method: 'POST', body: lateAnswer })
  assert.deepEqual([late.response.status, late.body.code], [409, 'AUMLOK_DEVICE_CHALLENGE_EXPIRED'])
  assert.equal(fx.headStorage.snapshot(), before)
  // An answer naming a challenge this code never issued checked no proof (an unknown challenge never counts): refused,
  // nothing written, B left as it is.
  const stranger = await fx.call(PASSKEY_DEVICE_ROUTES.add, { method: 'POST', body: { code: made.code, credential: registrationFor(device, randomBytes(32).toString('base64url')) } })
  assert.deepEqual([stranger.response.status, stranger.body.code], [409, 'AUMLOK_DEVICE_CHALLENGE_UNKNOWN'])
  assert.equal(fx.headStorage.snapshot(), before)
  const kept = (await fx.headStorage.get(PASSKEY_DEVICES_PENDING_KEY)).pending
  assert.deepEqual([kept.misses, kept.challenge, kept.challengesIssued], [0, pending.challenge, 2])
  // B's answer joins.
  const joined = await fx.call(PASSKEY_DEVICE_ROUTES.add, { method: 'POST', body: { code: made.code, credential: registrationFor(device, renewed.body.publicKey.challenge) } })
  assert.equal(joined.response.status, 200, JSON.stringify(joined.body))
  assert.deepEqual(await fx.ownerCounters(), counters)
  // The pending record with its lapsed list is read strictly: a forged list longer than the renewals is refused.
  const record = await fx.headStorage.get(PASSKEY_DEVICES_PENDING_KEY)
  assert.ok(readDevicePending(record) !== null)
  assert.equal(readDevicePending({ ...record, pending: { ...record.pending, lapsed: ['a'.repeat(64), 'b'.repeat(64)] } }), null)
  assert.equal(readDevicePending({ ...record, pending: { ...record.pending, lapsed: [] } }), null)
})

/** Every value reachable from the edge's shared cache object, with the path to it. */
function walkShared(value, path = 'keys', seen = new Set(), out = []) {
  out.push([path, value])
  if (value === null || (typeof value !== 'object' && typeof value !== 'function') || seen.has(value)) return out
  seen.add(value)
  if (value instanceof Map) {
    for (const [key, item] of value) { walkShared(key, path + '<key>', seen, out); walkShared(item, path + '.get(' + String(key).slice(0, 8) + ')', seen, out) }
    return out
  }
  for (const name of Reflect.ownKeys(value)) walkShared(value[name], path + '.' + String(name), seen, out)
  return out
}
const settledOnly = keys => {
  for (const [path, value] of walkShared(keys)) {
    assert.ok(!(value instanceof Promise), path + ' is a promise')
    assert.ok(!(value instanceof Response) && !(value instanceof Request), path + ' is a Response or Request')
    assert.ok(!(value !== null && (typeof value === 'object' || typeof value === 'function') && typeof value.then === 'function'), path + ' is a thenable')
    assert.ok(typeof value !== 'function', path + ' is a function')
  }
}

test('matching-code challenge asks are ADMITTED, never answered, at the edge: six per two seconds per isolate reach HEAD, the next is refused at once with its wait; every judgement stays in HEAD', async t => {
  // Job 7 review: on an injected clock (mocked before the Worker, HEAD and the store are made), so a busy machine can never
  // fail correct behaviour: the window is passed by moving the clock, never by waiting.
  const clock = { now: Date.now() }
  t.mock.method(Date, 'now', () => clock.now)
  const fx = await fixture(t)
  const primary = await fx.signIn()
  const made = await fx.makeCode(primary.cookie)
  const { perWindow, windowMs } = PASSKEY_DEVICE_CHALLENGE_ADMISSION
  const asks = () => fx.doCalls.filter(item => item === 'HEAD /_host/aumlok/device-add-challenge').length
  const startedAt = Date.now()
  const first = await fx.call(PASSKEY_DEVICE_ROUTES.addChallenge, { method: 'POST', body: { code: made.code } })
  assert.equal(first.response.status, 200, JSON.stringify(first.body))
  for (let index = 1; index < perWindow; index++) {
    const again = await fx.call(PASSKEY_DEVICE_ROUTES.addChallenge, { method: 'POST', body: { code: made.code } })
    assert.equal(again.response.status, 200, JSON.stringify(again.body))
    assert.equal(again.body.publicKey.challenge, first.body.publicKey.challenge, 'HEAD hands the live challenge out again')
  }
  assert.equal(asks(), perWindow, 'every admitted ask reached HEAD')
  const held = fx.headStorage.snapshot()
  const busy = await fx.call(PASSKEY_DEVICE_ROUTES.addChallenge, { method: 'POST', body: { code: made.code } })
  assert.equal(Date.now(), startedAt, 'the six asks and the seventh share one instant of the injected clock')
  assert.deepEqual([busy.response.status, busy.body.code], [429, 'AUMLOK_DEVICE_CHALLENGE_BUSY'])
  assert.ok(Number.isSafeInteger(busy.body.retryAfterSeconds) && busy.body.retryAfterSeconds >= 1 && busy.body.retryAfterSeconds <= Math.ceil(windowMs / 1000))
  assert.equal(busy.response.headers.get('retry-after'), String(busy.body.retryAfterSeconds))
  assert.equal(asks(), perWindow, 'a refused ask costs no HEAD call')
  assert.equal(fx.headStorage.snapshot(), held, 'and writes nothing')
  // The reviewer's case for the old cache: isolate A asked; a registration through ANOTHER isolate uses the challenge up.
  // A's next ask (admitted again once its window passes) goes to HEAD and gets the renewed challenge, never the used one.
  // (Job 11: a bent registration is screened and keeps the challenge, so the challenge is used up here by a GENUINE
  // registration refused by policy: the primary's own, already enrolled credential. Its challenge is used, as before.)
  const bent = await fx.call(PASSKEY_DEVICE_ROUTES.add, { method: 'POST', isolate: 'B',
    body: { code: made.code, credential: registrationFor(fx.passkey, first.body.publicKey.challenge) } })
  assert.deepEqual([bent.response.status, bent.body.code], [409, 'AUMLOK_DEVICE_ALREADY_ENROLLED'])
  // A registration is not a challenge ask: the bound never stops one (A's window is still full here).
  const registering = await fx.call(PASSKEY_DEVICE_ROUTES.add, { method: 'POST',
    body: { code: made.code, credential: registrationFor(passkeyPair(), first.body.publicKey.challenge) } })
  assert.notEqual(registering.response.status, 429)
  clock.now = startedAt + windowMs + 50
  const renewed = await fx.call(PASSKEY_DEVICE_ROUTES.addChallenge, { method: 'POST', body: { code: made.code } })
  assert.equal(renewed.response.status, 200, JSON.stringify(renewed.body))
  assert.notEqual(renewed.body.publicKey.challenge, first.body.publicKey.challenge, 'never the used challenge')
  // An expired challenge is never handed out from the edge: HEAD's record is made to expire, and the very next ask on the
  // same isolate gets a renewed one with its own full life.
  await challengeLeft(fx, -1)
  const afterExpiry = await fx.call(PASSKEY_DEVICE_ROUTES.addChallenge, { method: 'POST', body: { code: made.code } })
  assert.equal(afterExpiry.response.status, 200, JSON.stringify(afterExpiry.body))
  assert.notEqual(afterExpiry.body.publicKey.challenge, renewed.body.publicKey.challenge)
  assert.ok(afterExpiry.body.publicKey.timeout > PASSKEY_DEVICE_LIMITS.registrationMs - 5000)
  // A wrong code (same 66-bit lookup, wrong remainder) has its own admission row and is judged by HEAD as before.
  const wrong = made.code.slice(0, 11) + (made.code[11] === 'A' ? 'B' : 'A') + made.code.slice(12)
  const refusedWrong = await fx.call(PASSKEY_DEVICE_ROUTES.addChallenge, { method: 'POST', body: { code: wrong }, isolate: 'C' })
  assert.deepEqual([refusedWrong.response.status, refusedWrong.body.code], [403, 'AUMLOK_DEVICE_CODE_INVALID'])
  // Concurrent asks on a fresh isolate: exactly six reach HEAD, the rest are refused at once, none waits on another.
  const fresh = (await fx.makeCode(primary.cookie, fx.passkey, 'Tablet')).code
  const before = asks()
  const together = await Promise.all(Array.from({ length: 10 }, () => fx.call(PASSKEY_DEVICE_ROUTES.addChallenge, { method: 'POST', body: { code: fresh }, isolate: 'D' })))
  assert.equal(together.filter(item => item.response.status === 200).length, perWindow)
  assert.ok(together.every(item => item.response.status === 200 || (item.response.status === 429 && item.body.code === 'AUMLOK_DEVICE_CHALLENGE_BUSY')))
  assert.equal(asks() - before, perWindow)
  assert.equal(new Set(together.filter(item => item.response.status === 200).map(item => item.body.publicKey.challenge)).size, 1)
})

test('the admission record is plain data (per code hash, admission times as numbers), bounded, and refuses concurrent excess before any HEAD call', async () => {
  // The rule on a clock.
  const keys = {}, t0 = 1_800_000_000_000, { perWindow, windowMs, codes } = PASSKEY_DEVICE_CHALLENGE_ADMISSION
  for (let index = 0; index < perWindow; index++) assert.deepEqual(admitDeviceChallengeAsk(keys, 'a'.repeat(64), t0 + index), { ok: true })
  assert.deepEqual(admitDeviceChallengeAsk(keys, 'a'.repeat(64), t0 + 10), { ok: false, retryAfterSeconds: 2 })
  assert.deepEqual(admitDeviceChallengeAsk(keys, 'a'.repeat(64), t0 + 1500), { ok: false, retryAfterSeconds: 1 })
  assert.deepEqual(admitDeviceChallengeAsk(keys, 'a'.repeat(64), t0 + windowMs), { ok: true }, 'the oldest left the window')
  // A clock that went back drops the times ahead of it (never a negative wait, never a stuck row).
  assert.deepEqual(admitDeviceChallengeAsk(keys, 'a'.repeat(64), t0 - 60000), { ok: true })
  assert.deepEqual(keys.deviceChallengeAdmissions.get('a'.repeat(64)), [t0 - 60000])
  // Bounded: at most `codes` code hashes, the oldest let go first; every value a number.
  for (let index = 0; index < codes + 3; index++) admitDeviceChallengeAsk(keys, String(index).padStart(64, '0'), t0 - 59000)
  assert.equal(keys.deviceChallengeAdmissions.size, codes)
  assert.ok([...keys.deviceChallengeAdmissions.values()].every(times => Array.isArray(times) && times.length <= perWindow && times.every(time => typeof time === 'number')))
  settledOnly(keys)
  // Job 11 review: registration posts have their own record of the same shape and bound; neither stops the other; no
  // other field of the sign-in cache can be named as a record.
  const own = {}
  for (let index = 0; index < perWindow; index++) assert.deepEqual(admitDeviceChallengeAsk(own, 'b'.repeat(64), t0, 'deviceAddAdmissions'), { ok: true })
  assert.deepEqual(admitDeviceChallengeAsk(own, 'b'.repeat(64), t0 + 10, 'deviceAddAdmissions'), { ok: false, retryAfterSeconds: 2 })
  assert.deepEqual(admitDeviceChallengeAsk(own, 'b'.repeat(64), t0 + 10), { ok: true }, 'challenge asks are not stopped by registration posts')
  assert.throws(() => admitDeviceChallengeAsk(own, 'b'.repeat(64), t0, 'value'), TypeError)
  assert.deepEqual(Object.keys(own).sort(), ['deviceAddAdmissions', 'deviceChallengeAdmissions'])
  settledOnly(own)
  // Through the door with a HEAD held open: concurrent asks beyond the bound are refused while the admitted ones are still
  // in flight (no request waits on another's I/O), and nothing but admission times is ever stored.
  const code = randomBytes(32).toString('base64url')
  const { lookup } = await deviceCodeHashes(code)
  const door = { value: null }, pending = [], forwarded = []
  const forward = async request => {
    forwarded.push(new URL(request.url).pathname)
    await new Promise(resolve => { pending.push(resolve) })
    return Response.json({ ok: true, publicKey: { challenge: 'live-challenge', timeout: 60000 } })
  }
  const deps = { forward, boundedRequest: async request => request, keys: door, keyFor: async () => ({ ok: true, deviceCode: lookup, seedId: 'seed' }) }
  const ask = () => {
    const url = new URL(PASSKEY_DEVICE_ROUTES.addChallenge, ORIGIN)
    return passkeyDeviceDoor(new Request(url, { method: 'POST', body: JSON.stringify({ code }),
      headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' } }), {}, url, ORIGIN, deps)
  }
  const inFlight = Array.from({ length: perWindow }, ask)
  for (let turn = 0; turn < 500 && forwarded.length < perWindow; turn++) await new Promise(resolve => { setTimeout(resolve, 2) })
  assert.equal(forwarded.length, perWindow)
  // (Raced against a timer, so an edge without the bound fails here instead of waiting on the held HEAD forever.)
  const excess = await Promise.race([ask(), new Promise(resolve => { setTimeout(() => resolve(null), 1000) })])
  assert.ok(excess !== null, 'the excess ask was not answered at once')
  assert.equal(excess.status, 429, 'refused while the others are still at HEAD')
  assert.equal(Number(excess.headers.get('retry-after')), (await excess.json()).retryAfterSeconds)
  assert.equal(forwarded.length, perWindow)
  settledOnly(door)
  assert.deepEqual(Object.keys(door).sort(), ['deviceChallengeAdmissions', 'value'])
  while (pending.length) pending.shift()()
  assert.ok((await Promise.all(inFlight)).every(item => item.status === 200))
  settledOnly(door)
  assert.equal(door.deviceChallengeAdmissions.size, 1)
})

test('SHOULD: the add page takes the request\'s own time off the prompt; with nothing left it never opens the prompt and says so', async t => {
  const fx = await fixture(t)
  const { open, json, options } = await addPageHarness(t, fx)
  // The reviewer's case: 40 ms left when HEAD answered, the answer took 100 ms to arrive.
  let created = 0
  const never = async () => { created++; throw new Error('the prompt must not open') }
  const early = await open(never, () => json(options(40)), { now: 1000, delay: 100 })
  assert.equal(created, 0, 'the prompt never opened')
  assert.match(early.status, /^This attempt ran out of time before the passkey prompt could open, so nothing was counted against the code\./)
  assert.deepEqual(early.posted, [PASSKEY_DEVICE_ROUTES.addChallenge])
  // 60 s given, 40 ms spent on the way: the prompt and its timer get 59 960 ms.
  let seen = null
  const hanging = (init, window) => { seen = init; return new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new window.DOMException('The operation was aborted.', 'AbortError')))
  }) }
  const window40 = open(hanging, () => json(options(60000)), { now: 5000, delay: 40 })
  for (let wait = 0; wait < 200 && seen === null; wait++) await new Promise(resolve => { setTimeout(resolve, 5) })
  assert.equal(seen.publicKey.timeout, 59960)
  assert.equal(seen.signal.aborted, false)
  await window40
})

// ── Job 6: ONE RULE for what counts as a failure (proof-failure-rule.mjs), through the Worker and HEAD ──────────────────
/**
 * A fixture on a clock this test moves (Date.now is mocked BEFORE the Worker, HEAD and the AUMLOK store are made, so all
 * three read it), with no cleanup: every store and gate is exactly as the routes leave it.
 */
async function ruleFixture(t, { passkey } = {}) {
  const clock = { now: Date.now() }
  t.mock.method(Date, 'now', () => clock.now)
  const fx = await fixture(t, { cleanup: false, ...(passkey ? { passkey } : {}) })
  const primary = await fx.signIn()
  /** Every failure budget there is: AUMLOK's two (with their backoffs) and HEAD's whole gate table. */
  const budgets = async () => {
    const state = await fx.headStorage.get(AUMLOK_STORAGE_KEY)
    return { failures: state.failures, failedAt: state.failedAt, nextAllowedAt: state.nextAllowedAt, phraseFailures: state.phraseFailures ?? 0,
      phraseFailedAt: state.phraseFailedAt ?? [], phraseNextAllowedAt: state.phraseNextAllowedAt ?? 0, gate: await fx.headStorage.get('gate-lockout:v1') ?? null }
  }
  let request = 0
  const challenge = (body, isolate = 'A') => fx.call('/_host/aumlok/challenge', { method: 'POST', cookie: primary.cookie, isolate, body: { requestId: `rule-${String(++request)}`, ...body } })
  const promoteBinding = async () => aumlokClass3Binding({ audience: ORIGIN, method: 'POST', pathname: '/_head/promote', body: { candidate: ++request } })
  const issue = async () => {
    const issued = await challenge({ purpose: 'approve', binding: await promoteBinding() })
    assert.equal(issued.response.status, 200, JSON.stringify(issued.body))
    return issued.body
  }
  const complete = (body, route = '/_host/aumlok/approve') => fx.call(route, { method: 'POST', cookie: primary.cookie, body })
  /** One valid owner approval, now: it must succeed at once. */
  const approveNow = async (counter = 0) => {
    const issued = await issue()
    const done = await complete({ challengeId: issued.challengeId, credential: assertionFor(fx.passkey, issued.publicKey.challenge, { counter }) })
    assert.equal(done.response.status, 200, JSON.stringify(done.body))
    assert.equal(typeof done.body.approvalToken, 'string')
    return done
  }
  /** An owner-session promotion through the Worker to HEAD (behind HEAD's promotion gate). */
  const promote = (headers = {}, body = {}) => fx.call('/_head/promote', { method: 'POST', cookie: primary.cookie, body, headers })
  /**
   * The owner's hybrid signer for signed actions: her Ed25519 owner key and an ML-DSA-65 key HEAD is configured with.
   * `envelope(overrides)` signs a promote of `{}`; `wrongSignature` signs other bytes (a well-formed signature, checked
   * against the right keys, and wrong); `manifest` replaces the key ids.
   */
  const signer = () => {
    const pq = ml_dsa65.keygen(randomBytes(32))
    fx.env.OWNER_MLDSA_PUBLIC_KEY_HEX = Buffer.from(pq.publicKey).toString('hex')
    const keyId = bytes => createHash('sha256').update(bytes).digest('hex').slice(0, 12)
    const algManifest = { classical: { alg: 'Ed25519', keyId: keyId(Buffer.from(fx.env.OWNER_PUBLIC_KEY_HEX, 'hex')) }, pq: { alg: 'ML-DSA-65', keyId: keyId(pq.publicKey) } }
    let sequence = 0
    const envelope = async ({ manifest = algManifest, wrongSignature = false, ...overrides } = {}) => {
      const payload = { schema: SIGNED_ACTION_SCHEMA, actionId: `rule-action-${String(++sequence)}`, action: 'head.promote', audience: ORIGIN,
        ballId: fx.seedBall.ballId, epoch: fx.seedBall.epoch, expiresAt: clock.now + 60000,
        targetDigest: await digest(canonicalJson({ method: 'POST', pathname: '/_head/promote', body: {} })), ...overrides }
      const preimage = Buffer.from(HYBRID_ENVELOPE_DOMAIN + canonicalJson({ schema: HYBRID_ENVELOPE_SCHEMA, artifact: 'signed-action', payload, algManifest: manifest }))
      const signed = wrongSignature ? Buffer.concat([preimage, Buffer.from('other bytes')]) : preimage
      return { schema: HYBRID_ENVELOPE_SCHEMA, artifact: 'signed-action', payload, algManifest: manifest, signatures: {
        ed25519SigHex: sign(null, signed, fx.owner.privateKey).toString('hex'),
        mlDsaSigHex: Buffer.from(ml_dsa65.sign(signed, pq.secretKey, { context: Buffer.from('aukora.v2') })).toString('hex') } }
    }
    const header = async overrides => ({ 'x-x6-signed-action': JSON.stringify(await envelope(overrides)) })
    return { envelope, header, algManifest }
  }
  /**
   * A VALID governance candidate (job 7 review: the unknown and expired bearer cases reach the approval itself): the seed
   * ball plus one protected organ, staged through the Worker. Returns the candidate and the exact promotion binding the
   * owner's passkey would approve for it.
   */
  const stageCandidate = async ({ stage = true } = {}) => {
    const next = { ...structuredClone(fx.seedBall), parentBallId: fx.seedBall.ballId, epoch: fx.seedBall.epoch + 1 }
    next.entries['seed-receipts'] = { ...next.entries.fixture, id: 'seed-receipts', config: { rule: true } }
    next.ballId = await manifestIdCanon(next)
    const binding = await headPromotionBinding({ audience: ORIGIN, ball: next, entryId: 'seed-receipts', previous: fx.seedBall })
    if (!stage) return { candidate: next, binding }
    const staged = await fx.call('/_head/stage', { method: 'POST', cookie: primary.cookie,
      body: { ball: next, codeBySha: {}, expectedParentBallId: fx.seedBall.ballId, expectedEpoch: fx.seedBall.epoch } })
    assert.equal(staged.response.status, 200, JSON.stringify(staged.body))
    return { candidate: next, binding }
  }
  /**
   * Only the crypto backend named fails (it throws: no verdict); every other use of WebCrypto is untouched. `when` (optional)
   * narrows it to the checks whose signed bytes it accepts (as text), so one check fails while the others still run.
   */
  const failingBackend = (algorithm, when = () => true) => {
    const original = crypto.subtle.verify.bind(crypto.subtle)
    return t.mock.method(crypto.subtle, 'verify', (name, ...rest) => {
      if ((typeof name === 'string' ? name : name?.name) === algorithm && when(Buffer.from(rest[2]).toString())) throw new Error(`${algorithm} backend unavailable`)
      return original(name, ...rest)
    })
  }
  return { t, fx, clock, primary, budgets, challenge, issue, complete, approveNow, promote, signer, stageCandidate, failingBackend }
}

const garbageSignature = () => randomBytes(64).toString('base64url')
const crossOrigin = credential => {
  const data = JSON.parse(Buffer.from(credential.response.clientDataJSON, 'base64url').toString())
  return { ...credential, response: { ...credential.response, clientDataJSON: Buffer.from(JSON.stringify({ ...data, crossOrigin: true })).toString('base64url') } }
}
const swapClientData = (credential, change) => {
  const data = JSON.parse(Buffer.from(credential.response.clientDataJSON, 'base64url').toString())
  return { ...credential, response: { ...credential.response, clientDataJSON: Buffer.from(JSON.stringify(change(data))).toString('base64url') } }
}
/**
 * Counts the signature operations (crypto.subtle.verify of ECDSA or Ed25519); every call still runs for real. `ignore(name,
 * signed text)` names checks that are not this request's proof (the stored records' own re-check on a state load).
 */
const countSignatures = (t, ignore = () => false) => {
  const original = crypto.subtle.verify.bind(crypto.subtle), seen = { count: 0 }
  const mock = t.mock.method(crypto.subtle, 'verify', (name, ...rest) => {
    const algorithm = typeof name === 'string' ? name : name?.name
    if (['ECDSA', 'Ed25519'].includes(algorithm) && !ignore(algorithm, Buffer.from(rest[2]).toString('latin1'))) seen.count++
    return original(name, ...rest)
  })
  return { seen, restore: () => mock.mock.restore() }
}
const ROOT = { sealedRootKeyB64: Buffer.alloc(48, 19).toString('base64url'), kdfSaltB64: Buffer.alloc(32, 37).toString('base64url'), kdfIterations: 600000,
  ivB64: Buffer.alloc(12, 41).toString('base64url') }

/** The assertion bends a malformed signature is combined with (job 7 review): each would be a counted verdict if judged. */
const ASSERTION_BENDS = [
  ['a wrong challenge', passkey => assertionFor(passkey, randomBytes(32).toString('base64url'))],
  ['a wrong origin', (passkey, challenge) => assertionFor(passkey, challenge, { origin: 'https://elsewhere.example.invalid' })],
  // The stored counter is 5 (setup); an assertion at 3 is behind it.
  ['a counter behind the stored one', (passkey, challenge) => assertionFor(passkey, challenge, { counter: 3 }), { setup: async r => { await r.approveNow(5) }, counter: 6 }],
]
const withSignature = (credential, signature) => ({ ...credential, response: { ...credential.response, signature } })
const derInt = bytes => Buffer.concat([Buffer.from([0x02, bytes.length]), bytes])
const derSignature = (r, s) => { const body = Buffer.concat([derInt(r), derInt(s)]); return Buffer.concat([Buffer.from([0x30, body.length]), body]) }
const positive32 = () => Buffer.concat([Buffer.from([0x11]), randomBytes(31)])
/** ES256 signatures that are not strict DER of two positive integers of at most 256 bits. The first two meet every bend. */
const MALFORMED_ES256 = [
  ['the reviewer\'s "AA"', () => 'AA'],
  ['raw r||s (64 bytes, not DER)', () => Buffer.concat([positive32(), positive32()]).toString('base64url')],
  ['DER with a byte left over', () => Buffer.concat([derSignature(positive32(), positive32()), Buffer.from([0])]).toString('base64url')],
  ['DER with a non-minimal integer', () => derSignature(Buffer.concat([Buffer.from([0]), positive32()]), positive32()).toString('base64url')],
  ['DER with a negative integer', () => derSignature(Buffer.concat([Buffer.from([0x80]), randomBytes(31)]), positive32()).toString('base64url')],
  ['DER with an integer over 256 bits', () => derSignature(Buffer.concat([Buffer.from([0x01]), randomBytes(32)]), positive32()).toString('base64url')],
]
/** Ed25519 signatures that are not exactly 64 bytes. */
const MALFORMED_ED25519 = [
  ['the reviewer\'s "AA"', () => 'AA'],
  ['63 bytes', () => randomBytes(63).toString('base64url')],
  ['65 bytes', () => randomBytes(65).toString('base64url')],
  ['a DER signature', () => derSignature(positive32(), positive32()).toString('base64url')],
]

/**
 * EVERY REFUSAL THE APPROVE, SIGN-IN, CHALLENGE AND DEVICE PATHS ANSWER THAT IS NOT A PROOF CHECKED AND WRONG. Each is
 * provoked ten times; the whole gate table and both AUMLOK budgets must stay byte for byte as they were, and the next
 * valid approval must succeed at once (after the stated Retry-After for the two capacity codes).
 * `setup` runs once; `provoke` runs ten times and returns the response; `after` (optional) runs before the valid approval.
 */
const NEVER_COUNTS = [
  { code: 'AUMLOK_CHALLENGE_UNKNOWN', status: 409, provoke: async r => r.complete({ challengeId: randomBytes(32).toString('base64url'),
    credential: assertionFor(r.fx.passkey, randomBytes(32).toString('base64url')) }) },
  { code: 'AUMLOK_CHALLENGE_USED', status: 409, setup: async r => {
    const issued = await r.issue(), body = { challengeId: issued.challengeId, credential: assertionFor(r.fx.passkey, issued.publicKey.challenge) }
    assert.equal((await r.complete(body)).response.status, 200)
    return body
  }, provoke: async (r, body) => r.complete(body) },
  // The reviewer's second sequence (five there, ten here): an owner approval that arrives 100 ms after its ceremony expired.
  { code: 'AUMLOK_CHALLENGE_EXPIRED', status: 409, provoke: async r => {
    const issued = await r.issue()
    r.clock.now = issued.expiresAt + 100
    return r.complete({ challengeId: issued.challengeId, credential: assertionFor(r.fx.passkey, issued.publicKey.challenge) })
  } },
  // An unseal ceremony completed on the approve route (refused before anything is consumed, so the same one each time).
  { code: 'AUMLOK_CHALLENGE_BINDING_MISMATCH', status: 409, setup: async r => {
    const unseal = await r.challenge({ purpose: 'unseal' })
    assert.equal(unseal.response.status, 200, JSON.stringify(unseal.body))
    return unseal.body
  }, provoke: async (r, unseal) => r.complete({ challengeId: unseal.challengeId, credential: assertionFor(r.fx.passkey, unseal.publicKey.challenge) }) },
  { code: 'AUMLOK_REQUEST_INVALID', status: 400, provoke: async r => r.complete({ challengeId: 'not-valid' }) },
  // A malformed credential, and one naming a passkey this ceremony does not know: never looked at by the verifier (400).
  { code: 'AUMLOK_PROOF_INVALID', status: 400, label: 'malformed credential', provoke: async r => {
    const issued = await r.issue()
    return r.complete({ challengeId: issued.challengeId, credential: { id: r.fx.passkey.id } })
  } },
  { code: 'AUMLOK_PROOF_INVALID', status: 400, label: 'a passkey that is not enrolled', provoke: async r => {
    const issued = await r.issue()
    return r.complete({ challengeId: issued.challengeId, credential: assertionFor(passkeyPair(), issued.publicKey.challenge) })
  } },
  // ── Job 11: a POLICY mismatch is refused by the screen before the WebAuthn library is asked: never counted (the
  // reviewer's reproduction first: through Worker and HEAD, after a genuine sign-in, it used to move AUMLOK and the gate) ──
  ...[['the reviewer\'s reproduction: a well-formed assertion for the made-up challenge "X" x 43', passkey => assertionFor(passkey, 'X'.repeat(43))],
    ['a wrong origin (screened)', (passkey, challenge) => assertionFor(passkey, challenge, { origin: 'https://elsewhere.example.invalid' })],
    ['a wrong RP id (screened)', (passkey, challenge) => assertionFor(passkey, challenge, { rpId: 'elsewhere.example.invalid' })],
    ['no user presence (screened)', (passkey, challenge) => assertionFor(passkey, challenge, { flags: 0x04 })],
    ['no user verification (screened)', (passkey, challenge) => assertionFor(passkey, challenge, { flags: 0x01 })]]
    .map(([label, bend]) => ({ code: 'AUMLOK_PROOF_INVALID', status: 403, label, provoke: async r => {
      const issued = await r.issue()
      return r.complete({ challengeId: issued.challengeId, credential: bend(r.fx.passkey, issued.publicKey.challenge) })
    } })),
  { code: 'AUMLOK_CROSS_ORIGIN_PROOF', status: 400, provoke: async r => {
    const issued = await r.issue()
    return r.complete({ challengeId: issued.challengeId, credential: crossOrigin(assertionFor(r.fx.passkey, issued.publicKey.challenge)) })
  } },
  { code: 'AUMLOK_ASSERTION_STALE', status: 409, setup: async r => { await r.approveNow(5) }, provoke: async r => {
    const issued = await r.issue()
    return r.complete({ challengeId: issued.challengeId, credential: assertionFor(r.fx.passkey, issued.publicKey.challenge, { counter: 3 }) })
  }, counter: 6 },
  { code: 'AUMLOK_CONTENT_TYPE_REQUIRED', status: 400, label: 'a missing JSON content type', provoke: async r => r.fx.call('/_host/aumlok/approve', {
    method: 'POST', cookie: r.primary.cookie, body: '{}', headers: { 'content-type': 'text/plain' } }) },
  // These two are refused by the Worker before HEAD (its own codes).
  { code: 'INVALID_JSON', status: 400, label: 'a body that is not JSON', provoke: async r => r.fx.call('/_host/aumlok/approve', {
    method: 'POST', cookie: r.primary.cookie, body: '{not json' }) },
  { code: 'REQUEST_BODY_TOO_LARGE', status: 413, label: 'an oversized body', provoke: async r => r.fx.call('/_host/aumlok/approve', {
    method: 'POST', cookie: r.primary.cookie, body: JSON.stringify({ challengeId: 'x'.repeat(AUMLOK_LIMITS.requestBytes + 10) }) }) },
  { code: 'AUMLOK_APPROVAL_CAPACITY', status: 429, capacity: true, setup: async r => {
    for (let index = 0; index < AUMLOK_LIMITS.approvalRecords; index++) await r.approveNow()
  }, provoke: async r => {
    const issued = await r.issue()
    return r.complete({ challengeId: issued.challengeId, credential: assertionFor(r.fx.passkey, issued.publicKey.challenge) })
  } },
  // The challenge route (not behind HEAD's gate, but it used to move AUMLOK's budget for every refusal).
  { code: 'AUMLOK_CHALLENGE_CAPACITY', status: 429, capacity: true, setup: async r => { for (let index = 0; index < AUMLOK_LIMITS.challenges; index++) await r.issue() },
    provoke: async r => r.challenge({ purpose: 'approve', binding: await aumlokClass3Binding({ audience: ORIGIN, method: 'POST', pathname: '/_head/promote', body: { full: true } }) }) },
  { code: 'AUMLOK_IDEMPOTENCY_CONFLICT', status: 409, setup: async r => {
    const binding = await aumlokClass3Binding({ audience: ORIGIN, method: 'POST', pathname: '/_head/promote', body: { first: true } })
    assert.equal((await r.challenge({ purpose: 'approve', requestId: 'same-request', binding })).response.status, 200)
  }, provoke: async r => r.challenge({ purpose: 'approve', requestId: 'same-request',
    binding: await aumlokClass3Binding({ audience: ORIGIN, method: 'POST', pathname: '/_head/promote', body: { other: true } }) }) },
  { code: 'CLASS3_ACTION_INVALID', status: 400, provoke: async r => r.challenge({ purpose: 'approve',
    binding: await aumlokClass3Binding({ audience: 'https://elsewhere.example.invalid', method: 'POST', pathname: '/_head/promote', body: {} }) }) },
  // An owner action carrying an approval that is not one (unknown bearer): refused by policy, never a failed passkey.
  { code: 'CLASS3_WEBAUTHN_REQUIRED', status: 403, provoke: async r => r.fx.call(PASSKEY_DEVICE_ROUTES.code, { method: 'POST', cookie: r.primary.cookie,
    body: await r.fx.codeBody(), headers: { 'x-x6-class3-approval': randomBytes(32).toString('base64url') } }) },
  // Sign-in: a wrong passkey signature is refused; sign-in has no failure budget, and nothing moves.
  { code: 'AUMLOK_SIGNIN_PROOF_INVALID', status: 403, provoke: async r => {
    const issued = await r.fx.call(OWNER_PASSKEY.challenge, { method: 'POST', body: {} })
    return r.fx.call(OWNER_PASSKEY.signin, { method: 'POST', body: { challengeId: issued.body.challengeId,
      credential: assertionFor(r.fx.passkey, issued.body.publicKey.challenge, { signer: passkeyPair().key }) } })
  } },
  // ── Job 6 review: bytes that do not parse are a MALFORMED request (400), never a proof checked and wrong ──
  { code: 'AUMLOK_PROOF_INVALID', status: 400, label: 'truncated authenticatorData and signature (the reviewer\'s "AA")', provoke: async r => {
    const issued = await r.issue(), credential = assertionFor(r.fx.passkey, issued.publicKey.challenge)
    return r.complete({ challengeId: issued.challengeId, credential: { ...credential, response: { ...credential.response, authenticatorData: 'AA', signature: 'AA' } } })
  } },
  { code: 'AUMLOK_PROOF_INVALID', status: 400, label: 'authenticatorData with bytes left over', provoke: async r => {
    const issued = await r.issue(), credential = assertionFor(r.fx.passkey, issued.publicKey.challenge)
    const longer = Buffer.concat([Buffer.from(credential.response.authenticatorData, 'base64url'), Buffer.from([0])]).toString('base64url')
    return r.complete({ challengeId: issued.challengeId, credential: { ...credential, response: { ...credential.response, authenticatorData: longer } } })
  } },
  { code: 'AUMLOK_PROOF_INVALID', status: 400, label: 'a signature that is not DER', provoke: async r => {
    const issued = await r.issue(), credential = assertionFor(r.fx.passkey, issued.publicKey.challenge)
    return r.complete({ challengeId: issued.challengeId, credential: { ...credential, response: { ...credential.response, signature: 'AA' } } })
  } },
  { code: 'AUMLOK_NODE_PROOF_INVALID', status: 400, label: 'a node signature that is not 64 bytes (refresh)', provoke: async r => {
    const refresh = (await r.challenge({ purpose: 'refresh', commitmentSha256: 'c'.repeat(64), ...ROOT })).body
    return r.complete({ challengeId: refresh.challengeId, credential: assertionFor(r.fx.passkey, refresh.publicKey.challenge), nodeSignature: 'AA' }, '/_host/aumlok/refresh')
  } },
  { code: 'AUMLOK_INVITE_SIGNATURE_INVALID', status: 400, label: 'an invite signature that is not 64 bytes', provoke: async r => {
    const invite = (await r.challenge({ purpose: 'invite', inviteeCommitmentSha256: 'd'.repeat(64), assignedDomainPointer: null })).body
    return r.complete({ challengeId: invite.challengeId, credential: assertionFor(r.fx.passkey, invite.publicKey.challenge), signature: randomBytes(10).toString('base64url') }, '/_host/aumlok/invite')
  } },
  // ── Job 6 review: the promote and ball paths, through the Worker and HEAD's promotion gates ──
  { code: 'CLASS3_WEBAUTHN_REQUIRED', status: 403, label: 'a promotion without an approval', provoke: async r => r.promote() },
  // These two stop before any approval is looked at (no staged candidate; no manifest). The bearer cases that reach the
  // approval itself, on a VALID candidate, are the job 7 rows below.
  { code: 'CANDIDATE_UNKNOWN', status: 404, label: 'a promotion with nothing staged, carrying a bearer', provoke: async r => r.promote({ 'x-x6-class3-approval': randomBytes(32).toString('base64url') }) },
  { code: 'INVALID_MANIFEST', status: 400, label: 'a direct publication (/_head/ball) whose body is no manifest, carrying a bearer', provoke: async r => r.fx.call('/_head/ball', {
    method: 'POST', cookie: r.primary.cookie, body: {}, headers: { 'x-x6-class3-approval': randomBytes(32).toString('base64url') } }) },
  { code: 'SIGNED_ACTION_MALFORMED', status: 400, label: 'a promotion whose signed action is not JSON', provoke: async r => r.promote({ 'x-x6-signed-action': '{not json' }) },
  { code: 'HYBRID_KEY_MISMATCH', status: 403, label: 'a signed promotion naming keys HEAD does not hold', setup: async r => r.signer(), provoke: async (r, s) => r.promote(await s.header({
    manifest: { ...s.algManifest, classical: { alg: 'Ed25519', keyId: '0'.repeat(12) } } })) },
  { code: 'SIGNED_ACTION_EXPIRED', status: 403, label: 'a signed promotion past its expiry', setup: async r => r.signer(), provoke: async (r, s) => r.promote(await s.header({ expiresAt: r.clock.now - 1 })) },
  { code: 'SIGNED_ACTION_AUDIENCE_MISMATCH', status: 403, label: 'a signed promotion for another audience', setup: async r => r.signer(),
    provoke: async (r, s) => r.promote(await s.header({ audience: 'https://elsewhere.example.invalid' })) },
  { code: 'SIGNED_ACTION_TARGET_MISMATCH', status: 403, label: 'a signed promotion of other bytes', setup: async r => r.signer(), provoke: async (r, s) => r.promote(await s.header({ targetDigest: 'f'.repeat(64) })) },
  { code: 'SIGNED_ACTION_STALE_HEAD', status: 409, label: 'a signed promotion of an older head', setup: async r => r.signer(), provoke: async (r, s) => r.promote(await s.header({ ballId: 'f'.repeat(64) })) },
  // ── Job 7 review, MUST 1: a passkey signature that is not what its credential's algorithm signs is MALFORMED (400),
  // refused before the verifier, whatever else is wrong with the assertion (challenge, origin or counter) ──
  ...MALFORMED_ES256.flatMap(([kind, signature], index) => ASSERTION_BENDS.filter(([bend]) => index < 2 || bend === 'a wrong challenge').map(([bend, assertion, extra]) => ({
    code: 'AUMLOK_PROOF_INVALID', status: 400, label: `ES256: ${kind}, with ${bend}`, ...extra, provoke: async r => {
      const issued = await r.issue()
      return r.complete({ challengeId: issued.challengeId, credential: withSignature(assertion(r.fx.passkey, issued.publicKey.challenge), signature()) })
    } }))),
  ...MALFORMED_ED25519.map(([kind, signature]) => ({ code: 'AUMLOK_PROOF_INVALID', status: 400, label: `Ed25519 passkey: ${kind}, with the right challenge`, ed25519: true,
    provoke: async r => {
      const issued = await r.issue()
      return r.complete({ challengeId: issued.challengeId, credential: withSignature(assertionFor(r.fx.passkey, issued.publicKey.challenge), signature()) })
    } })),
  // ── Job 7 review, MUST 2: a crypto backend that THROWS reaches no verdict: 503, never counted. Since job 9 a ceremony
  // that reached no verdict keeps its challenge outstanding, so these rows RETRY THE SAME CHALLENGE ten times (as the
  // owner's retry would); it answers 503 each time, never AUMLOK_CHALLENGE_USED. ──
  { code: 'AUMLOK_UNAVAILABLE', status: 503, label: 'the ECDSA backend throws while a genuine ES256 approval is checked', setup: async r => {
    const issued = await r.issue()
    return { backend: r.failingBackend('ECDSA'), body: { challengeId: issued.challengeId, credential: assertionFor(r.fx.passkey, issued.publicKey.challenge) } }
  }, provoke: async (r, context) => r.complete(context.body), after: async (_r, context) => context.backend.mock.restore() },
  { code: 'AUMLOK_UNAVAILABLE', status: 503, label: 'the Ed25519 backend throws while a genuine Ed25519 approval is checked', ed25519: true, setup: async r => {
    const issued = await r.issue()
    return { backend: r.failingBackend('Ed25519'), body: { challengeId: issued.challengeId, credential: assertionFor(r.fx.passkey, issued.publicKey.challenge) } }
  }, provoke: async (r, context) => r.complete(context.body), after: async (_r, context) => context.backend.mock.restore() },
  // The overtaken-assertion path: the counter is behind, and the signature check that would tell stale from forged throws.
  { code: 'AUMLOK_UNAVAILABLE', status: 503, label: 'the ECDSA backend throws while an overtaken assertion is checked', counter: 6, setup: async r => {
    await r.approveNow(5)
    const issued = await r.issue()
    return { backend: r.failingBackend('ECDSA'), body: { challengeId: issued.challengeId, credential: assertionFor(r.fx.passkey, issued.publicKey.challenge, { counter: 3 }) } }
  }, provoke: async (r, context) => r.complete(context.body), after: async (_r, context) => context.backend.mock.restore() },
  { code: 'HYBRID_VERIFIER_UNAVAILABLE', status: 503, label: 'the Ed25519 backend throws while a genuinely signed promotion is checked',
    setup: async r => ({ s: r.signer(), backend: r.failingBackend('Ed25519') }), provoke: async (r, context) => r.promote(await context.s.header()),
    after: async (_r, context) => context.backend.mock.restore() },
  // ── Job 7 review follow-up: the NODE key's Ed25519 check (refresh, invite, revocation) keeps the same three outcomes. A
  // genuine passkey and a correct node signature, checked by a backend that throws: no verdict, 503, never counted, and
  // the good passkey's reset of the budget is not kept either ──
  { code: 'AUMLOK_UNAVAILABLE', status: 503, label: 'the Ed25519 backend throws while a correct node signature is checked (refresh)', setup: async r => {
    const refresh = (await r.challenge({ purpose: 'refresh', commitmentSha256: 'c'.repeat(64), ...ROOT })).body
    return { backend: r.failingBackend('Ed25519'), body: { challengeId: refresh.challengeId, credential: assertionFor(r.fx.passkey, refresh.publicKey.challenge),
      nodeSignature: sign(null, Buffer.from(refresh.nodeProofPreimage), r.fx.node.privateKey).toString('base64url') } }
  }, provoke: async (r, context) => r.complete(context.body, '/_host/aumlok/refresh'), after: async (_r, context) => context.backend.mock.restore() },
  { code: 'AUMLOK_UNAVAILABLE', status: 503, label: 'the Ed25519 backend throws while a correct invite signature is checked', setup: async r => {
    const invite = (await r.challenge({ purpose: 'invite', inviteeCommitmentSha256: 'd'.repeat(64), assignedDomainPointer: null })).body
    return { backend: r.failingBackend('Ed25519'), body: { challengeId: invite.challengeId, credential: assertionFor(r.fx.passkey, invite.publicKey.challenge),
      signature: sign(null, Buffer.from(invite.signaturePreimage), r.fx.node.privateKey).toString('base64url') } }
  }, provoke: async (r, context) => r.complete(context.body, '/_host/aumlok/invite'), after: async (_r, context) => context.backend.mock.restore() },
  // One real invite is issued first (its stored receipt is re-checked on every load and must still pass); only the check of
  // the revocation's own signature fails.
  { code: 'AUMLOK_UNAVAILABLE', status: 503, label: 'the Ed25519 backend throws while a correct revocation signature is checked', setup: async r => {
    const invite = (await r.challenge({ purpose: 'invite', inviteeCommitmentSha256: 'e'.repeat(64), assignedDomainPointer: null })).body
    const issued = await r.complete({ challengeId: invite.challengeId, credential: assertionFor(r.fx.passkey, invite.publicKey.challenge),
      signature: sign(null, Buffer.from(invite.signaturePreimage), r.fx.node.privateKey).toString('base64url') }, '/_host/aumlok/invite')
    assert.equal(issued.response.status, 200, JSON.stringify(issued.body))
    const revoke = (await r.challenge({ purpose: 'invite', action: 'revoke', inviteId: issued.body.invite.inviteId })).body
    return { backend: r.failingBackend('Ed25519', signed => signed.startsWith('aukora.invite-revocation.v1\n')), body: { challengeId: revoke.challengeId,
      credential: assertionFor(r.fx.passkey, revoke.publicKey.challenge, { counter: 1 }), signature: sign(null, Buffer.from(revoke.signaturePreimage), r.fx.node.privateKey).toString('base64url') } }
  }, provoke: async (r, context) => r.complete(context.body, '/_host/aumlok/invite'), after: async (_r, context) => context.backend.mock.restore() },
  // ── Job 7 review, MUST 3: unseal's commitment and phrase budget are read BEFORE the passkey: nothing moves either way ──
  { code: 'AUMLOK_COMMITMENT_INVALID', status: 400, label: 'unseal with a genuine passkey and no commitment', provoke: async r => {
    const unseal = (await r.challenge({ purpose: 'unseal' })).body
    return r.complete({ challengeId: unseal.challengeId, credential: assertionFor(r.fx.passkey, unseal.publicKey.challenge) }, '/_host/aumlok/unseal')
  } },
  { code: 'AUMLOK_COMMITMENT_INVALID', status: 400, label: 'unseal with a genuine passkey and a malformed commitment (the reviewer\'s sequence)', provoke: async r => {
    const unseal = (await r.challenge({ purpose: 'unseal' })).body
    return r.complete({ challengeId: unseal.challengeId, credential: assertionFor(r.fx.passkey, unseal.publicKey.challenge), commitmentSha256: 'not-a-digest' }, '/_host/aumlok/unseal')
  } },
  { code: 'AUMLOK_PHRASE_RATE_LIMITED', status: 429, label: 'unseal with a genuine passkey while the phrase budget waits', phraseLock: true, setup: async r => {
    const state = await r.fx.headStorage.get(AUMLOK_STORAGE_KEY)
    await r.fx.headStorage.put(AUMLOK_STORAGE_KEY, { ...state, phraseFailures: 1, phraseFailedAt: [r.clock.now - 500], phraseNextAllowedAt: r.clock.now + 3600000 })
  }, provoke: async r => {
    const unseal = (await r.challenge({ purpose: 'unseal' })).body
    return r.complete({ challengeId: unseal.challengeId, credential: assertionFor(r.fx.passkey, unseal.publicKey.challenge), commitmentSha256: 'a'.repeat(64) }, '/_host/aumlok/unseal')
  } },
  // ── Job 7 review, SHOULD: unknown and expired bearers on a VALID candidate reach the approval itself and are refused ──
  { code: 'CLASS3_WEBAUTHN_REQUIRED', status: 403, label: 'a promotion of a valid staged candidate carrying an unknown bearer', setup: async r => { await r.stageCandidate() },
    provoke: async r => r.promote({ 'x-x6-class3-approval': randomBytes(32).toString('base64url') }) },
  { code: 'CLASS3_WEBAUTHN_REQUIRED', status: 403, label: 'a promotion of a valid staged candidate carrying its own approval, expired', setup: async r => {
    const { binding } = await r.stageCandidate()
    const issued = await r.challenge({ purpose: 'approve', binding })
    assert.equal(issued.response.status, 200, JSON.stringify(issued.body))
    const done = await r.complete({ challengeId: issued.body.challengeId, credential: assertionFor(r.fx.passkey, issued.body.publicKey.challenge) })
    assert.equal(done.response.status, 200, JSON.stringify(done.body))
    r.clock.now = done.body.expiresAt + 1000
    return done.body.approvalToken
  }, provoke: async (r, token) => r.promote({ 'x-x6-class3-approval': token }) },
  { code: 'CLASS3_WEBAUTHN_REQUIRED', status: 403, label: 'a direct publication of a valid candidate, under the writer lease, carrying an unknown bearer', setup: async r => {
    const { candidate } = await r.stageCandidate({ stage: false })
    const { lease } = await r.fx.head.store.lease({ action: 'acquire', ownerPeerId: candidate.authorPeerId })
    return { ball: candidate, codeBySha: {}, expectedParentBallId: r.fx.seedBall.ballId, expectedEpoch: r.fx.seedBall.epoch, writerLease: lease }
  }, provoke: async (r, body) => r.fx.call('/_head/ball', { method: 'POST', cookie: r.primary.cookie, body, headers: { 'x-x6-class3-approval': randomBytes(32).toString('base64url') } }) },
]


for (const row of NEVER_COUNTS) {
  test(`never counts: ${row.code} (${String(row.status)}${row.label ? ', ' + row.label : ''}) ten times moves no budget and no gate field; the next valid approval succeeds${row.capacity ? ' after the stated wait' : ' at once'}`, async t => {
    const r = await ruleFixture(t, row.ed25519 ? { passkey: edPasskeyPair() } : {})
    const context = row.setup ? await row.setup(r) : undefined
    const before = await r.budgets()
    let wait = null
    for (let index = 0; index < 10; index++) {
      const answer = await row.provoke(r, context)
      assert.deepEqual([answer.response.status, answer.body.code], [row.status, row.code], `attempt ${String(index + 1)}: ${JSON.stringify(answer.body)}`)
      if (row.capacity) {
        // Its own answer is kept, Retry-After included, on every one of the ten (the gate never replaces it).
        assert.ok(Number.isSafeInteger(answer.body.retryAfterSeconds) && answer.body.retryAfterSeconds >= 1, JSON.stringify(answer.body))
        assert.equal(answer.response.headers.get('retry-after'), String(answer.body.retryAfterSeconds))
        wait = answer.body.retryAfterSeconds
      }
      assert.deepEqual(await r.budgets(), before, `attempt ${String(index + 1)} moved a budget or a gate field`)
    }
    if (row.after) await row.after(r, context)
    if (wait !== null) r.clock.now += wait * 1000
    await r.approveNow(row.counter ?? 0)
  })
}

/** The gate as time alone would leave it: failures older than its window fall away (gate-lockout.mjs pruneSubjects). */
const gateWindowed = (gate, now) => gate === null ? null : gate.map(([key, entry]) => [key, { failedAt: entry.failedAt.filter(at => now - at < 60000), lockedUntil: entry.lockedUntil }])
  .filter(([, entry]) => entry.failedAt.length > 0 || entry.lockedUntil > now)

for (const row of NEVER_COUNTS) {
  test(`never counts on NON-ZERO budgets: ${row.code} (${String(row.status)}${row.label ? ', ' + row.label : ''}) ten times neither raises nor resets any counter`, async t => {
    const r = await ruleFixture(t, row.ed25519 ? { passkey: edPasskeyPair() } : {})
    const context = row.setup ? await row.setup(r) : undefined
    // THE OTHER DIRECTION (job 7 review): budgets that are not zero, so a refusal that RESETS one is seen. AUMLOK's passkey
    // budget at two recent failures (its backoff over), its phrase budget at one (unless the row holds its own phrase
    // lock), and HEAD's gate at two failures on the approval subject and one on the promotion subject, none locked.
    const at = r.clock.now, state = await r.fx.headStorage.get(AUMLOK_STORAGE_KEY)
    await r.fx.headStorage.put(AUMLOK_STORAGE_KEY, { ...state, failures: 2, failedAt: [at - 3000, at - 2000], nextAllowedAt: at,
      ...(row.phraseLock ? {} : { phraseFailures: 1, phraseFailedAt: [at - 5000], phraseNextAllowedAt: at - 4000 }) })
    const approveSubject = `head-gate:${await digest('/_host/aumlok/approve\0' + OWNER)}`, promoteSubject = `head-gate:${await digest('/_head/promote\0' + OWNER)}`
    const others = (await r.fx.headStorage.get('gate-lockout:v1') ?? []).filter(([key]) => key !== approveSubject && key !== promoteSubject)
    await r.fx.headStorage.put('gate-lockout:v1', [...others, [approveSubject, { failedAt: [at - 2000, at - 1000], lockedUntil: 0 }], [promoteSubject, { failedAt: [at - 1500], lockedUntil: 0 }]])
    const before = await r.budgets()
    assert.equal(before.failures, 2)
    let wait = null
    for (let index = 0; index < 10; index++) {
      const answer = await row.provoke(r, context)
      assert.deepEqual([answer.response.status, answer.body.code], [row.status, row.code], `attempt ${String(index + 1)}: ${JSON.stringify(answer.body)}`)
      if (row.capacity) wait = answer.body.retryAfterSeconds
      const { gate, ...counters } = await r.budgets(), { gate: gateBefore, ...countersBefore } = before
      assert.deepEqual(counters, countersBefore, `attempt ${String(index + 1)} raised or reset an AUMLOK counter`)
      // Byte for byte, or as the gate's own one-minute window alone leaves it (the expiry row moves the clock 120 s a try).
      assert.ok(isDeepStrictEqual(gate, gateBefore) || isDeepStrictEqual(gate, gateWindowed(gateBefore, r.clock.now)),
        `attempt ${String(index + 1)} raised or reset a gate field: ${JSON.stringify(gate)}`)
    }
    if (row.after) await row.after(r, context)
    if (wait !== null) r.clock.now += wait * 1000
    await r.approveNow(row.counter ?? 0)
    // The seeded approval subject is the live one: the valid approval cleared exactly it (HEAD's recordSuccess).
    assert.equal((await r.fx.headStorage.get('gate-lockout:v1') ?? []).some(([key]) => key === approveSubject), false)
  })
}

test('counts exactly as before: a wrong passkey signature on approve moves AUMLOK\'s budget and HEAD\'s gate once each; the fifth locks the gate for 300 s', async t => {
  const r = await ruleFixture(t)
  const codes = []
  for (let index = 1; index <= 5; index++) {
    const issued = await r.issue()
    const answer = await r.complete({ challengeId: issued.challengeId, credential: assertionFor(r.fx.passkey, issued.publicKey.challenge, { signer: passkeyPair().key }) })
    codes.push([answer.response.status, answer.body.code])
    const budgets = await r.budgets()
    assert.equal(budgets.failures, index)
    assert.equal(budgets.failedAt.at(-1), r.clock.now)
    assert.equal(budgets.nextAllowedAt, r.clock.now + AUMLOK_LIMITS.backoffMs * 2 ** (index - 1))
    assert.equal(budgets.gate.length, 1)
    assert.equal(budgets.gate[0][1].failedAt.length, index)
    assert.equal(budgets.gate[0][1].lockedUntil, index === 5 ? r.clock.now + 300000 : 0)
    r.clock.now = budgets.nextAllowedAt
  }
  assert.deepEqual(codes, [...Array(4).fill([403, 'AUMLOK_PROOF_INVALID']), [429, 'GATE_LOCKOUT_ACTIVE']])
})

test('counts exactly as before: a wrong node signature (refresh), a wrong invite signature, and wrong recovery words each move AUMLOK\'s own budget by one; HEAD\'s gate is not on those routes', async t => {
  const r = await ruleFixture(t)
  const refresh = (await r.challenge({ purpose: 'refresh', commitmentSha256: 'c'.repeat(64), ...ROOT })).body
  assert.ok(refresh.challengeId, JSON.stringify(refresh))
  const node = await r.complete({ challengeId: refresh.challengeId, credential: assertionFor(r.fx.passkey, refresh.publicKey.challenge), nodeSignature: garbageSignature() }, '/_host/aumlok/refresh')
  assert.deepEqual([node.response.status, node.body.code], [403, 'AUMLOK_NODE_PROOF_INVALID'])
  let budgets = await r.budgets()
  assert.deepEqual([budgets.failures, budgets.phraseFailures, budgets.gate], [1, 0, null])
  r.clock.now = budgets.nextAllowedAt
  const invite = (await r.challenge({ purpose: 'invite', inviteeCommitmentSha256: 'd'.repeat(64), assignedDomainPointer: null })).body
  assert.ok(invite.challengeId, JSON.stringify(invite))
  const signed = await r.complete({ challengeId: invite.challengeId, credential: assertionFor(r.fx.passkey, invite.publicKey.challenge), signature: garbageSignature() }, '/_host/aumlok/invite')
  assert.deepEqual([signed.response.status, signed.body.code], [403, 'AUMLOK_INVITE_SIGNATURE_INVALID'])
  budgets = await r.budgets()
  assert.deepEqual([budgets.failures, budgets.phraseFailures, budgets.gate], [2, 0, null])
  r.clock.now = budgets.nextAllowedAt
  // Wrong words after a GOOD Touch ID: the phrase budget moves; the verified passkey resets the WebAuthn one (as before).
  const unseal = (await r.challenge({ purpose: 'unseal' })).body
  const words = await r.complete({ challengeId: unseal.challengeId, credential: assertionFor(r.fx.passkey, unseal.publicKey.challenge), commitmentSha256: 'e'.repeat(64) }, '/_host/aumlok/unseal')
  assert.deepEqual([words.response.status, words.body.code], [403, 'AUMLOK_RECOVERY_COMMITMENT_MISMATCH'])
  budgets = await r.budgets()
  assert.deepEqual([budgets.failures, budgets.phraseFailures, budgets.phraseFailedAt, budgets.gate], [0, 1, [r.clock.now], null])
  // A commitment that is not one (malformed) checks no words: refused, and since job 6 it moves nothing.
  r.clock.now = budgets.phraseNextAllowedAt
  const malformed = (await r.challenge({ purpose: 'unseal' })).body
  const before = await r.budgets()
  const shape = await r.complete({ challengeId: malformed.challengeId, credential: assertionFor(r.fx.passkey, malformed.publicKey.challenge), commitmentSha256: 'not-a-digest' }, '/_host/aumlok/unseal')
  assert.deepEqual([shape.response.status, shape.body.code], [400, 'AUMLOK_COMMITMENT_INVALID'])
  assert.deepEqual(await r.budgets(), before)
})

test('the screen replaces an earlier rule ("a verifier VERDICT still counts"): a wrong origin, RP id, challenge or type, or no user presence or verification, is refused by the SCREEN: 403, no signature checked, never counted; the owner then approves at once', async t => {
  const r = await ruleFixture(t)
  const before = await r.budgets()
  const bends = [
    ['origin', (passkey, challenge) => assertionFor(passkey, challenge, { origin: 'https://elsewhere.example.invalid' })],
    ['RP id', (passkey, challenge) => assertionFor(passkey, challenge, { rpId: 'elsewhere.example.invalid' })],
    ['challenge', passkey => assertionFor(passkey, randomBytes(32).toString('base64url'))],
    ['the reviewer\'s made-up challenge', passkey => assertionFor(passkey, 'X'.repeat(43))],
    ['type', (passkey, challenge) => swapClientData(assertionFor(passkey, challenge), data => ({ ...data, type: 'webauthn.create' }))],
    ['user presence', (passkey, challenge) => assertionFor(passkey, challenge, { flags: 0x04 })],
    ['user verification', (passkey, challenge) => assertionFor(passkey, challenge, { flags: 0x01 })],
    // the reviewer's flags 0x15 (backed up, not backup-eligible): the library threw on it after the screen
    // (a repeatable 503); now the screen's policy refusal.
    ['backup state without backup eligibility (0x15)', (passkey, challenge) => assertionFor(passkey, challenge, { flags: 0x15 })],
  ]
  for (const [name, bend] of bends) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const issued = await r.issue()
      const signatures = countSignatures(t)
      const answer = await r.complete({ challengeId: issued.challengeId, credential: bend(r.fx.passkey, issued.publicKey.challenge) })
      signatures.restore()
      assert.deepEqual([answer.response.status, answer.body.code], [403, 'AUMLOK_PROOF_INVALID'], `${name}: ${JSON.stringify(answer.body)}`)
      assert.equal(signatures.seen.count, 0, `${name}: no signature checked`)
      assert.deepEqual(await r.budgets(), before, `${name}: never counted`)
    }
  }
  // Sixteen screen refusals later the gate is not locked and no backoff waits: a genuine approval succeeds at once.
  await r.approveNow()
})

test('counted at HEAD\'s promotion gate only: a wrong owner signature on a signed promotion moves the gate by one each, the fifth locks it for 300 s; AUMLOK never moves and approvals still work', async t => {
  const r = await ruleFixture(t), s = r.signer()
  const before = await r.budgets()
  const answers = []
  for (let index = 1; index <= 5; index++) {
    const answer = await r.promote(await s.header({ wrongSignature: true }))
    answers.push([answer.response.status, answer.body.code])
    const budgets = await r.budgets()
    assert.deepEqual({ ...budgets, gate: null }, { ...before, gate: null }, 'AUMLOK\'s budgets never move')
    const counted = budgets.gate.filter(([, entry]) => entry.failedAt.length > 0)
    assert.equal(counted.length, 1)
    // Job 7: the subject the seeded never-counts table writes for promotions is this live one.
    assert.equal(counted[0][0], `head-gate:${await digest('/_head/promote\0' + OWNER)}`)
    assert.equal(counted[0][1].failedAt.length, index)
    assert.equal(counted[0][1].lockedUntil, index === 5 ? r.clock.now + 300000 : 0)
  }
  assert.deepEqual(answers, [...Array(4).fill([403, 'HYBRID_SIGNATURE_INVALID']), [429, 'GATE_LOCKOUT_ACTIVE']])
  await r.approveNow()
})

test('a WELL-FORMED wrong signature still counts, for both algorithms: ES256 (DER) and Ed25519 (64 bytes), each once in AUMLOK and at HEAD\'s gate', async t => {
  for (const [name, passkey, wrongKey] of [['ES256', passkeyPair(), () => passkeyPair().key], ['Ed25519', edPasskeyPair(), () => generateKeyPairSync('ed25519')]]) {
    await t.test(name, async st => {
      const r = await ruleFixture(st, { passkey })
      const issued = await r.issue()
      const answer = await r.complete({ challengeId: issued.challengeId, credential: assertionFor(r.fx.passkey, issued.publicKey.challenge, { signer: wrongKey() }) })
      assert.deepEqual([answer.response.status, answer.body.code], [403, 'AUMLOK_PROOF_INVALID'], JSON.stringify(answer.body))
      const budgets = await r.budgets()
      assert.equal(budgets.failures, 1)
      assert.equal(budgets.gate[0][1].failedAt.length, 1)
      r.clock.now = budgets.nextAllowedAt
      await r.approveNow()
    })
  }
})

test('a hybrid signature check has three outcomes: both verdicts true, a verdict of false (HYBRID_SIGNATURE_INVALID), or a backend that throws (HYBRID_VERIFIER_UNAVAILABLE, 503)', async t => {
  const input = { ed25519PublicKey: new Uint8Array(32), mlDsaPublicKey: new Uint8Array(1952), ed25519Signature: new Uint8Array(64), mlDsaSignature: new Uint8Array(3309), message: new Uint8Array(8) }
  const fails = () => { throw new Error('backend unavailable') }
  const backends = (ed25519, mlDsa65) => ({ ed25519: async () => ed25519(), mlDsa65: () => mlDsa65() })
  assert.equal(await hybridSignaturesVerdict(input, backends(() => true, () => true)), true)
  assert.equal(await hybridSignaturesVerdict(input, backends(() => true, () => false)), false)
  assert.equal(await hybridSignaturesVerdict(input, backends(() => false, fails)), false, 'a false Ed25519 verdict is final; ML-DSA is not asked')
  for (const [name, ed25519, mlDsa65] of [['Ed25519 throws', fails, () => true], ['ML-DSA-65 throws', () => true, fails], ['a backend answers no boolean', () => 'yes', () => true]]) {
    await assert.rejects(hybridSignaturesVerdict(input, backends(ed25519, mlDsa65)), { code: 'HYBRID_VERIFIER_UNAVAILABLE', status: 503 }, name)
  }
  assert.ok(Object.isFrozen(HYBRID_SIGNATURE_BACKENDS))
  // Through the real envelope verifier and the real backends: right, wrong, and the Ed25519 backend throwing.
  const owner = generateKeyPairSync('ed25519'), pq = ml_dsa65.keygen(randomBytes(32))
  const trustedKeys = { ed25519PublicKeyHex: keyHex(owner), mlDsaPublicKeyHex: Buffer.from(pq.publicKey).toString('hex') }
  const keyId = bytes => createHash('sha256').update(bytes).digest('hex').slice(0, 12)
  const algManifest = { classical: { alg: 'Ed25519', keyId: keyId(Buffer.from(trustedKeys.ed25519PublicKeyHex, 'hex')) }, pq: { alg: 'ML-DSA-65', keyId: keyId(pq.publicKey) } }
  const envelopeFor = (payload, bytes) => {
    const preimage = Buffer.from(HYBRID_ENVELOPE_DOMAIN + canonicalJson({ schema: HYBRID_ENVELOPE_SCHEMA, artifact: 'signed-action', payload, algManifest }))
    const signed = bytes ?? preimage
    return { schema: HYBRID_ENVELOPE_SCHEMA, artifact: 'signed-action', payload, algManifest, signatures: { ed25519SigHex: sign(null, signed, owner.privateKey).toString('hex'),
      mlDsaSigHex: Buffer.from(ml_dsa65.sign(signed, pq.secretKey, { context: Buffer.from('aukora.v2') })).toString('hex') } }
  }
  const good = envelopeFor({ action: 'fixture' })
  assert.equal((await verifyHybridEnvelopeV2(good, { artifact: 'signed-action', trustedKeys })).artifact, 'signed-action')
  await assert.rejects(verifyHybridEnvelopeV2(envelopeFor({ action: 'fixture' }, Buffer.from('other bytes')), { artifact: 'signed-action', trustedKeys }), { code: 'HYBRID_SIGNATURE_INVALID', status: 403 })
  const original = crypto.subtle.verify.bind(crypto.subtle)
  t.mock.method(crypto.subtle, 'verify', (name, ...rest) => {
    if ((typeof name === 'string' ? name : name?.name) === 'Ed25519') throw new Error('Ed25519 backend unavailable')
    return original(name, ...rest)
  })
  await assert.rejects(verifyHybridEnvelopeV2(good, { artifact: 'signed-action', trustedKeys }), { code: 'HYBRID_VERIFIER_UNAVAILABLE', status: 503 })
})

test('bind\'s registration step: an attestation object that does not decode, or authData that is short or has bytes left over, is refused as malformed (400) ten times; no budget moves; a good registration then proceeds', async () => {
  const storage = memoryStorage(), node = generateKeyPairSync('ed25519'), passkey = passkeyPair(), owner = generateKeyPairSync('ed25519')
  const access = { type: 'owner', email: OWNER, expires: Math.floor(Date.now() / 1000) + 3600 }
  const store = createAumlokStore(storage, { origins: [ORIGIN], ownerPublicKeyHex: keyHex(owner),
    authorizeEnrollment: createOwnerEnrollmentVerifier({ mode: OWNER_ENROLLMENT_MODE, origin: ORIGIN, ownerEmail: OWNER, ownerPublicKeyHex: keyHex(owner) }) })
  const withAuthData = (credential, bend) => {
    const decoded = isoCBOR.decodeFirst(Buffer.from(credential.response.attestationObject, 'base64url'))
    const attestationObject = Buffer.from(isoCBOR.encode(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', bend(Buffer.from(decoded.get('authData')))]]))).toString('base64url')
    return { ...credential, response: { ...credential.response, attestationObject } }
  }
  const bends = {
    'an attestation object that does not decode': credential => ({ ...credential, response: { ...credential.response, attestationObject: randomBytes(40).toString('base64url') } }),
    'authData of 20 bytes': credential => withAuthData(credential, authData => authData.subarray(0, 20)),
    'authData with bytes left over': credential => withAuthData(credential, authData => Buffer.concat([authData, Buffer.from([0])])),
  }
  let request = 0
  const start = () => store.challenge({ purpose: 'bind', requestId: `bind-${String(++request)}`, commitmentSha256: 'a'.repeat(64), nodePubkeyHex: keyHex(node), ...ROOT }, ORIGIN, { access })
  const counters = async () => { const state = await storage.get(AUMLOK_STORAGE_KEY); return [state.failures, state.failedAt, state.nextAllowedAt] }
  const before = await (async () => { await start(); return counters() })()
  for (const [name, bend] of Object.entries(bends)) {
    for (let index = 0; index < 10; index++) {
      const started = await start()
      const refused = await store.complete('bind', { challengeId: started.challengeId, credential: bend(registrationFor(passkey, started.publicKey.challenge)) }, ORIGIN, { access })
      assert.deepEqual([refused.ok, refused.code, refused.status], [false, 'AUMLOK_PROOF_INVALID', 400], `${name}: ${JSON.stringify(refused)}`)
      assert.deepEqual(await counters(), before, `${name}, attempt ${String(index + 1)}`)
    }
  }
  const started = await start()
  const registered = await store.complete('bind', { challengeId: started.challengeId, credential: registrationFor(passkey, started.publicKey.challenge) }, ORIGIN, { access })
  assert.equal(registered.phase, 'PENDING_ASSERTION', JSON.stringify(registered))
})

test('an error of this node\'s own (no code: here the enrollment verifier throwing) is answered unavailable (503) and never counted as a wrong proof', async () => {
  const storage = memoryStorage(), node = generateKeyPairSync('ed25519'), passkey = passkeyPair(), owner = generateKeyPairSync('ed25519')
  const access = { type: 'owner', email: OWNER, expires: Math.floor(Date.now() / 1000) + 3600 }
  const store = createAumlokStore(storage, { origins: [ORIGIN], ownerPublicKeyHex: keyHex(owner), authorizeEnrollment: async () => { throw new Error('enrollment verifier crashed') } })
  const started = await store.challenge({ purpose: 'bind', requestId: 'bind-1', commitmentSha256: 'a'.repeat(64), nodePubkeyHex: keyHex(node), ...ROOT }, ORIGIN, { access })
  const registered = await store.complete('bind', { challengeId: started.challengeId, credential: registrationFor(passkey, started.publicKey.challenge) }, ORIGIN, { access })
  assert.equal(registered.phase, 'PENDING_ASSERTION', JSON.stringify(registered))
  const before = await storage.get(AUMLOK_STORAGE_KEY)
  const crashed = await store.complete('bind', { challengeId: registered.challengeId, credential: assertionFor(passkey, registered.publicKey.challenge, { counter: 1 }),
    nodeSignature: sign(null, Buffer.from(registered.nodeProofPreimage), node.privateKey).toString('base64url') }, ORIGIN, { access })
  assert.deepEqual([crashed.ok, crashed.code, crashed.status], [false, 'AUMLOK_UNAVAILABLE', 503], JSON.stringify(crashed))
  const after = await storage.get(AUMLOK_STORAGE_KEY)
  assert.deepEqual([after.failures, after.failedAt, after.nextAllowedAt, after.binding], [before.failures, before.failedAt, before.nextAllowedAt, null])
})

test('the reviewer\'s first sequence through Worker and HEAD: four devices added and confirmed (eight approvals), then removal approvals retried at 250-265 s are each told their wait; no gate, no counter; at 300 s the removal is approved', async t => {
  const r = await ruleFixture(t)
  const { fx, primary } = r
  const devices = []
  for (const label of ['One', 'Two', 'Three', 'Four']) {
    const added = await fx.addDevice((await fx.makeCode(primary.cookie, fx.passkey, label)).code, passkeyPair(), {}, {}, { cookie: primary.cookie })
    assert.equal(added.added.response.status, 200, JSON.stringify(added.added.body))
    devices.push(added.device)
  }
  const additionsAt = r.clock.now
  assert.equal((await fx.headStorage.get(AUMLOK_STORAGE_KEY)).approvals.length, AUMLOK_LIMITS.approvalRecords)
  const before = await r.budgets()
  const body = { action: PASSKEY_DEVICE_REMOVE_ACTION, deviceId: devices[0].id, generation: await fx.generation() }
  const binding = await aumlokClass3Binding({ audience: ORIGIN, method: 'POST', pathname: PASSKEY_DEVICE_ROUTES.remove, body })
  const askApproval = async () => {
    const issued = await r.challenge({ purpose: 'approve', binding })
    assert.equal(issued.response.status, 200, JSON.stringify(issued.body))
    return r.complete({ challengeId: issued.body.challengeId, credential: assertionFor(fx.passkey, issued.body.publicKey.challenge, { userHandle: fx.userHandle }) })
  }
  for (const seconds of [250, 251, 253, 257, 265, 280, 299]) {
    r.clock.now = additionsAt + seconds * 1000
    const refused = await askApproval()
    assert.deepEqual([refused.response.status, refused.body.code], [429, 'AUMLOK_APPROVAL_CAPACITY'], `at ${String(seconds)} s: ${JSON.stringify(refused.body)}`)
    assert.equal(refused.body.retryAfterSeconds, 300 - seconds)
    assert.equal(refused.response.headers.get('retry-after'), String(300 - seconds))
    assert.deepEqual(await r.budgets(), before, `at ${String(seconds)} s a budget or the gate moved`)
  }
  r.clock.now = additionsAt + 300000
  const approved = await askApproval()
  assert.equal(approved.response.status, 200, JSON.stringify(approved.body))
  const removed = await fx.call(PASSKEY_DEVICE_ROUTES.remove, { method: 'POST', cookie: primary.cookie, body, headers: { 'x-x6-class3-approval': approved.body.approvalToken } })
  assert.equal(removed.response.status, 200, JSON.stringify(removed.body))
  assert.equal((await fx.headStorage.get(AUMLOK_STORAGE_KEY)).devices.length, 3)
})

test('a ceremony asked for again (the same request) tells the browser only what is LEFT of it, never its whole life', async t => {
  const r = await ruleFixture(t)
  const binding = await aumlokClass3Binding({ audience: ORIGIN, method: 'POST', pathname: '/_head/promote', body: { again: true } })
  const first = await r.challenge({ purpose: 'approve', requestId: 'asked-twice', binding })
  assert.equal(first.body.publicKey.timeout, AUMLOK_LIMITS.challengeMs)
  r.clock.now += 30000
  const again = await r.challenge({ purpose: 'approve', requestId: 'asked-twice', binding })
  assert.deepEqual([again.body.idempotent, again.body.challengeId], [true, first.body.challengeId])
  assert.equal(again.body.publicKey.timeout, AUMLOK_LIMITS.challengeMs - 30000)
  assert.equal(again.body.expiresAt, first.body.expiresAt)
})


// ══ JOB 9: THE TABLE. Every route that checks a proof, through the Worker and HEAD with the real stores, for every answer
// a verifier could give. Expected: only `false` counts (403, the route's wrong-proof code); `true` proceeds; every other
// answer is 503 with every budget byte-equal, and the challenge (where the route has one) still serves the next genuine
// request. The routes are derived from the code: every proofOutcome call site that a request can reach. (Confirm, decline,
// remove and the add code consume Class 3 approvals: they call no verifier themselves; the approval's passkey is the
// approve row.) Job 9 review: the invite redeem row is here; the add-device door's registration verifier has its rows in
// passkey-devices-table.test.mjs, which loads the modules with the WebAuthn library's answer replaceable (a module hook).
const TABLE_ANSWERS = [
  ['true', () => true], ['false', () => false], ['undefined', () => undefined], ['null', () => null], ['{}', () => ({})], ['[]', () => []],
  ['1', () => 1], ['0', () => 0], ['\'\'', () => ''], ['\'true\'', () => 'true'],
  ['a throw', () => { throw new Error('backend down') }], ['a rejection', () => Promise.reject(new Error('backend down'))],
  // ── Job 11, the column "library throw after a passing screen": the WebAuthn library's OWN verdict throws, raised inside
  // the library (its signature step) on an answer our screen let through. Before job 11 proofOutcome branded these
  // `wrong` and counted them; a throw is never a signature checked and wrong, so every one is 503 with every budget
  // byte-equal and the challenge kept. (On the routes that are not WebAuthn they are throws like any other.) ──
  ['the library\'s verdict message, thrown after a passing screen', () => { throw new Error('Unexpected authentication response challenge "x", expected "y"') }],
  ['the library\'s verdict code UNEXPECTED_RP_ID, thrown after a passing screen', () => { throw Object.assign(new Error('Unexpected RP ID hash'), { code: 'UNEXPECTED_RP_ID' }) }],
  ['the library\'s counter message, thrown after a passing screen', () => { throw new Error('Response counter value 3 was lower than expected 5') }],
]
/** crypto.subtle.verify answers `answer()` for the named algorithm when `when(signed text)` holds; everything else is real. */
const injectVerify = (t, algorithm, answer, when = () => true) => {
  const original = crypto.subtle.verify.bind(crypto.subtle)
  return t.mock.method(crypto.subtle, 'verify', (name, ...rest) => {
    if ((typeof name === 'string' ? name : name?.name) === algorithm && when(Buffer.from(rest[2]).toString('latin1'))) return answer()
    return original(name, ...rest)
  })
}
const expectRow = async (r, name, answer, before, { wrongCode, ok, budget }) => {
  const after = await r.budgets()
  if (name === 'false') {
    assert.deepEqual([answer.response.status, answer.body.code], [403, wrongCode], JSON.stringify(answer.body))
    if (budget) assert.notDeepEqual(after, before, 'a strict false counts')
  } else if (name === 'true') ok(answer)
  else {
    assert.deepEqual([answer.response.status, answer.body.code], [503, wrongCode.startsWith('HYBRID') ? 'HYBRID_VERIFIER_UNAVAILABLE' : 'AUMLOK_UNAVAILABLE'], `${name}: ${JSON.stringify(answer.body)}`)
    assert.deepEqual(after, before, `${name}: every budget byte-equal`)
  }
}
const nodeSigned = text => text.startsWith(AUMLOK_NODE_DOMAIN)
const TABLE = [
  { route: 'approve (the passkey assertion, ES256; the reviewer\'s ECDSA undefined, null and {} rows)', algorithm: 'ECDSA', run: async (r, name, answerOf) => {
    const issued = await r.issue(), before = await r.budgets()
    const mock = injectVerify(r.t, 'ECDSA', answerOf)
    const answer = await r.complete({ challengeId: issued.challengeId, credential: assertionFor(r.fx.passkey, issued.publicKey.challenge, { signer: passkeyPair().key }) })
    mock.mock.restore()
    await expectRow(r, name, answer, before, { wrongCode: 'AUMLOK_PROOF_INVALID', budget: true, ok: done => {
      // The verifier said yes, so the store did: the injected `true` is the only one that issues an approval.
      assert.equal(done.response.status, 200, JSON.stringify(done.body)); assert.equal(typeof done.body.approvalToken, 'string') } })
    if (name === 'false') {
      const after = await r.budgets()
      assert.deepEqual([after.failures, after.gate[0][1].failedAt.length], [before.failures + 1, 1])
    }
    if (!['true', 'false'].includes(name)) {
      const retry = await r.complete({ challengeId: issued.challengeId, credential: assertionFor(r.fx.passkey, issued.publicKey.challenge) })
      assert.equal(retry.response.status, 200, `${name}: the same challenge serves the genuine retry: ${JSON.stringify(retry.body)}`)
    }
  } },
  { route: 'approve, the stale-counter re-check (aumlok.mjs, the overtaken assertion)', algorithm: 'ECDSA', counter: true, run: async (r, name, answerOf) => {
    await r.approveNow(5)
    const issued = await r.issue(), before = await r.budgets()
    const mock = injectVerify(r.t, 'ECDSA', answerOf)
    const answer = await r.complete({ challengeId: issued.challengeId, credential: assertionFor(r.fx.passkey, issued.publicKey.challenge, { counter: 3, signer: passkeyPair().key }) })
    mock.mock.restore()
    // true: the re-check says the signature is genuine, so the assertion is stale (409, never counted); false: the counter
    // verdict stands (403, counted).
    await expectRow(r, name, answer, before, { wrongCode: 'AUMLOK_PROOF_INVALID', budget: true, ok: done => {
      assert.deepEqual([done.response.status, done.body.code], [409, 'AUMLOK_ASSERTION_STALE']); } })
    if (name === 'true') assert.deepEqual(await r.budgets(), before)
    if (!['true', 'false'].includes(name)) {
      const retry = await r.complete({ challengeId: issued.challengeId, credential: assertionFor(r.fx.passkey, issued.publicKey.challenge, { counter: 7 }) })
      assert.equal(retry.response.status, 200, JSON.stringify(retry.body))
    }
  } },
  { route: 'sign-in (Worker pre-check and HEAD, ES256)', algorithm: 'ECDSA', run: async (r, name, answerOf) => {
    const issued = await r.fx.call(OWNER_PASSKEY.challenge, { method: 'POST', body: {} }), before = await r.budgets()
    const mock = injectVerify(r.t, 'ECDSA', answerOf)
    const answer = await r.fx.call(OWNER_PASSKEY.signin, { method: 'POST', body: { challengeId: issued.body.challengeId,
      credential: assertionFor(r.fx.passkey, issued.body.publicKey.challenge, { signer: passkeyPair().key }) } })
    mock.mock.restore()
    if (name === 'false') assert.deepEqual([answer.response.status, answer.body.code], [403, 'AUMLOK_SIGNIN_PROOF_INVALID'])
    else if (name === 'true') assert.equal(answer.response.status, 200, JSON.stringify(answer.body))
    else assert.deepEqual([answer.response.status, answer.body.code], [503, 'AUMLOK_UNAVAILABLE'], `${name}: ${JSON.stringify(answer.body)}`)
    assert.deepEqual(await r.budgets(), before, 'sign-in moves no budget')
    if (name !== 'true') {
      const retry = await r.fx.call(OWNER_PASSKEY.signin, { method: 'POST', body: { challengeId: issued.body.challengeId, credential: assertionFor(r.fx.passkey, issued.body.publicKey.challenge) } })
      assert.equal(retry.response.status, 200, JSON.stringify(retry.body))
    }
  } },
  { route: 'owner login (the owner JWT\'s Ed25519 signature: Worker /_auth/owner and HEAD\'s login gate; the reviewer\'s {}, undefined, null and throw rows)', algorithm: 'Ed25519', run: async (r, name, answerOf) => {
    // Job 10 MUST: a well-formed owner JWT, in its window, for this audience and owner, signed by ANOTHER key. Only its
    // signature check is injected; only a strict false may record a login failure, only a strict true may sign in.
    const header = encode({ alg: 'EdDSA', typ: 'JWT' })
    const ownerJwt = key => {
      const at = Math.floor(Date.now() / 1000)
      const input = header + '.' + encode({ iss: 'aukora.x61.owner', aud: r.fx.env.PUBLIC_HOST, email: OWNER, nbf: at - 1, exp: at + 600 })
      return input + '.' + sign(null, Buffer.from(input), key).toString('base64url')
    }
    const login = token => r.fx.call('/_auth/owner', { method: 'POST', body: token, headers: { 'content-type': 'application/jwt' } })
    const before = await r.budgets()
    const mock = injectVerify(r.t, 'Ed25519', answerOf, text => text.startsWith(header + '.'))
    const answer = await login(ownerJwt(generateKeyPairSync('ed25519').privateKey))
    mock.mock.restore()
    const cookie = answer.response.headers.get('set-cookie'), after = await r.budgets()
    const { gate: gateBefore, ...aumlokBefore } = before, { gate: gateAfter, ...aumlokAfter } = after
    assert.deepEqual(aumlokAfter, aumlokBefore, `${name}: no AUMLOK budget moves at the owner login`)
    if (name === 'true') {
      assert.equal(answer.response.status, 200, JSON.stringify(answer.body))
      assert.match(cookie ?? '', /^CF_Authorization=/)
      assert.deepEqual(gateAfter, gateBefore)
    } else if (name === 'false') {
      assert.deepEqual([answer.response.status, answer.body.code, cookie], [401, 'OWNER_ACCESS_REQUIRED', null], JSON.stringify(answer.body))
      const failed = (gateAfter ?? []).filter(([subject]) => !(gateBefore ?? []).some(([known]) => known === subject))
      assert.deepEqual(failed.map(([, entry]) => entry.failedAt.length), [1], 'a strict false records exactly one login failure')
    } else {
      assert.deepEqual([answer.response.status, answer.body.code, cookie], [503, 'OWNER_LOGIN_UNAVAILABLE', null], `${name}: ${JSON.stringify(answer.body)}`)
      assert.deepEqual(gateAfter, gateBefore, `${name}: no login failure recorded`)
      const retry = await login(ownerJwt(r.fx.owner.privateKey))
      assert.equal(retry.response.status, 200, `${name}: the genuine owner JWT then signs in: ${JSON.stringify(retry.body)}`)
    }
  } },
  { route: 'refresh (the node key\'s Ed25519 signature)', algorithm: 'Ed25519', run: async (r, name, answerOf) => {
    const refresh = (await r.challenge({ purpose: 'refresh', commitmentSha256: 'c'.repeat(64), ...ROOT })).body, before = await r.budgets()
    const credential = assertionFor(r.fx.passkey, refresh.publicKey.challenge)
    const mock = injectVerify(r.t, 'Ed25519', answerOf, nodeSigned)
    const answer = await r.complete({ challengeId: refresh.challengeId, credential, nodeSignature: garbageSignature() }, '/_host/aumlok/refresh')
    mock.mock.restore()
    await expectRow(r, name, answer, before, { wrongCode: 'AUMLOK_NODE_PROOF_INVALID', budget: true, ok: done => assert.equal(done.response.status, 200, JSON.stringify(done.body)) })
    if (!['true', 'false'].includes(name)) {
      const retry = await r.complete({ challengeId: refresh.challengeId, credential,
        nodeSignature: sign(null, Buffer.from(refresh.nodeProofPreimage), r.fx.node.privateKey).toString('base64url') }, '/_host/aumlok/refresh')
      assert.equal(retry.response.status, 200, JSON.stringify(retry.body))
    }
  } },
  { route: 'invite (the node key\'s signature over the receipt)', algorithm: 'Ed25519', run: async (r, name, answerOf) => {
    const invite = (await r.challenge({ purpose: 'invite', inviteeCommitmentSha256: 'd'.repeat(64), assignedDomainPointer: null })).body, before = await r.budgets()
    const credential = assertionFor(r.fx.passkey, invite.publicKey.challenge)
    const mock = injectVerify(r.t, 'Ed25519', answerOf, text => text.startsWith(AUMLOK_INVITE_DOMAIN))
    const answer = await r.complete({ challengeId: invite.challengeId, credential, signature: garbageSignature() }, '/_host/aumlok/invite')
    mock.mock.restore()
    await expectRow(r, name, answer, before, { wrongCode: 'AUMLOK_INVITE_SIGNATURE_INVALID', budget: true, ok: done => assert.equal(done.response.status, 200, JSON.stringify(done.body)) })
    if (!['true', 'false'].includes(name)) {
      const retry = await r.complete({ challengeId: invite.challengeId, credential,
        signature: sign(null, Buffer.from(invite.signaturePreimage), r.fx.node.privateKey).toString('base64url') }, '/_host/aumlok/invite')
      assert.equal(retry.response.status, 200, JSON.stringify(retry.body))
    }
  } },
  // ── Job 11 review: the PASSKEY step of refresh, invite and unseal, every answer (the two job 11 columns included: the
  // library's own verdict throws after a passing screen). These routes call the same assertion() as approve; the rows prove
  // it here: only a strict false counts (403 AUMLOK_PROOF_INVALID), anything else is 503 with every budget byte-equal and
  // the challenge kept, and the genuine passkey then completes on the same challenge. ──
  { route: 'refresh, the passkey step (ES256, before the node signature)', algorithm: 'ECDSA', run: async (r, name, answerOf) => {
    const refresh = (await r.challenge({ purpose: 'refresh', commitmentSha256: 'c'.repeat(64), ...ROOT })).body, before = await r.budgets()
    const nodeSignature = sign(null, Buffer.from(refresh.nodeProofPreimage), r.fx.node.privateKey).toString('base64url')
    const mock = injectVerify(r.t, 'ECDSA', answerOf)
    const answer = await r.complete({ challengeId: refresh.challengeId, credential: assertionFor(r.fx.passkey, refresh.publicKey.challenge, { signer: passkeyPair().key }), nodeSignature }, '/_host/aumlok/refresh')
    mock.mock.restore()
    await expectRow(r, name, answer, before, { wrongCode: 'AUMLOK_PROOF_INVALID', budget: true, ok: done => assert.equal(done.response.status, 200, JSON.stringify(done.body)) })
    if (name === 'false') assert.equal((await r.budgets()).failures, before.failures + 1)
    if (!['true', 'false'].includes(name)) {
      const retry = await r.complete({ challengeId: refresh.challengeId, credential: assertionFor(r.fx.passkey, refresh.publicKey.challenge), nodeSignature }, '/_host/aumlok/refresh')
      assert.equal(retry.response.status, 200, `${name}: the same challenge serves the genuine retry: ${JSON.stringify(retry.body)}`)
    }
  } },
  { route: 'invite, the passkey step (ES256, before the node signature over the receipt)', algorithm: 'ECDSA', run: async (r, name, answerOf) => {
    const invite = (await r.challenge({ purpose: 'invite', inviteeCommitmentSha256: 'd'.repeat(64), assignedDomainPointer: null })).body, before = await r.budgets()
    const signature = sign(null, Buffer.from(invite.signaturePreimage), r.fx.node.privateKey).toString('base64url')
    const mock = injectVerify(r.t, 'ECDSA', answerOf)
    const answer = await r.complete({ challengeId: invite.challengeId, credential: assertionFor(r.fx.passkey, invite.publicKey.challenge, { signer: passkeyPair().key }), signature }, '/_host/aumlok/invite')
    mock.mock.restore()
    await expectRow(r, name, answer, before, { wrongCode: 'AUMLOK_PROOF_INVALID', budget: true, ok: done => assert.equal(done.response.status, 200, JSON.stringify(done.body)) })
    if (name === 'false') assert.equal((await r.budgets()).failures, before.failures + 1)
    if (!['true', 'false'].includes(name)) {
      const retry = await r.complete({ challengeId: invite.challengeId, credential: assertionFor(r.fx.passkey, invite.publicKey.challenge), signature }, '/_host/aumlok/invite')
      assert.equal(retry.response.status, 200, `${name}: the same challenge serves the genuine retry: ${JSON.stringify(retry.body)}`)
    }
  } },
  { route: 'unseal, the passkey step (ES256, before the words)', algorithm: 'ECDSA', run: async (r, name, answerOf) => {
    const unseal = (await r.challenge({ purpose: 'unseal' })).body, before = await r.budgets()
    const mock = injectVerify(r.t, 'ECDSA', answerOf)
    const answer = await r.complete({ challengeId: unseal.challengeId, credential: assertionFor(r.fx.passkey, unseal.publicKey.challenge, { signer: passkeyPair().key }), commitmentSha256: 'e'.repeat(64) }, '/_host/aumlok/unseal')
    mock.mock.restore()
    const after = await r.budgets()
    if (name === 'true') {
      // Past the passkey: the words are checked for real, and this fixture holds no real phrase (wrong words, the phrase budget).
      assert.deepEqual([answer.response.status, answer.body.code], [403, 'AUMLOK_RECOVERY_COMMITMENT_MISMATCH'], JSON.stringify(answer.body))
      assert.deepEqual([after.failures, after.phraseFailures], [before.failures, before.phraseFailures + 1])
    } else if (name === 'false') {
      assert.deepEqual([answer.response.status, answer.body.code], [403, 'AUMLOK_PROOF_INVALID'], JSON.stringify(answer.body))
      assert.deepEqual([after.failures, after.phraseFailures], [before.failures + 1, before.phraseFailures], 'a strict false counts the passkey budget, never the words')
    } else {
      assert.deepEqual([answer.response.status, answer.body.code], [503, 'AUMLOK_UNAVAILABLE'], `${name}: ${JSON.stringify(answer.body)}`)
      assert.deepEqual(after, before, `${name}: every budget byte-equal`)
      // The challenge is kept: the genuine passkey on the same challenge reaches the words (wrong here), never AUMLOK_CHALLENGE_USED.
      const retry = await r.complete({ challengeId: unseal.challengeId, credential: assertionFor(r.fx.passkey, unseal.publicKey.challenge), commitmentSha256: 'e'.repeat(64) }, '/_host/aumlok/unseal')
      assert.deepEqual([retry.response.status, retry.body.code], [403, 'AUMLOK_RECOVERY_COMMITMENT_MISMATCH'], JSON.stringify(retry.body))
    }
  } },
  { route: 'revocation (the node key\'s signature over the revocation)', algorithm: 'Ed25519', run: async (r, name, answerOf) => {
    const invite = (await r.challenge({ purpose: 'invite', inviteeCommitmentSha256: 'e'.repeat(64), assignedDomainPointer: null })).body
    const issued = await r.complete({ challengeId: invite.challengeId, credential: assertionFor(r.fx.passkey, invite.publicKey.challenge),
      signature: sign(null, Buffer.from(invite.signaturePreimage), r.fx.node.privateKey).toString('base64url') }, '/_host/aumlok/invite')
    assert.equal(issued.response.status, 200, JSON.stringify(issued.body))
    const revoke = (await r.challenge({ purpose: 'invite', action: 'revoke', inviteId: issued.body.invite.inviteId })).body, before = await r.budgets()
    const credential = assertionFor(r.fx.passkey, revoke.publicKey.challenge, { counter: 1 })
    const mock = injectVerify(r.t, 'Ed25519', answerOf, text => text.startsWith('aukora.invite-revocation.v1\n'))
    const answer = await r.complete({ challengeId: revoke.challengeId, credential, signature: garbageSignature() }, '/_host/aumlok/invite')
    mock.mock.restore()
    // `true` stores a revocation the node never signed; the next state load re-checks it and refuses the store (503), so
    // that row only checks the answer.
    await expectRow(r, name, answer, before, { wrongCode: 'AUMLOK_INVITE_SIGNATURE_INVALID', budget: true, ok: done => assert.equal(done.response.status, 200, JSON.stringify(done.body)) })
    if (!['true', 'false'].includes(name)) {
      const retry = await r.complete({ challengeId: revoke.challengeId, credential,
        signature: sign(null, Buffer.from(revoke.signaturePreimage), r.fx.node.privateKey).toString('base64url') }, '/_host/aumlok/invite')
      assert.equal(retry.response.status, 200, JSON.stringify(retry.body))
    }
  } },
  { route: 'unseal (the recovery commitment, HMAC under the pepper; the reviewer\'s recovery row)', algorithm: 'HMAC', run: async (r, name, answerOf) => {
    const unseal = (await r.challenge({ purpose: 'unseal' })).body, before = await r.budgets()
    const credential = assertionFor(r.fx.passkey, unseal.publicKey.challenge)
    const mock = injectVerify(r.t, 'HMAC', answerOf, text => text.startsWith('aukora.aumlok.recovery.v2\0'))
    const answer = await r.complete({ challengeId: unseal.challengeId, credential, commitmentSha256: 'e'.repeat(64) }, '/_host/aumlok/unseal')
    mock.mock.restore()
    if (name === 'false') {
      assert.deepEqual([answer.response.status, answer.body.code], [403, 'AUMLOK_RECOVERY_COMMITMENT_MISMATCH'])
      assert.equal((await r.budgets()).phraseFailures, before.phraseFailures + 1)
    } else if (name === 'true') {
      // Past the words: this fixture's escrow is a stand-in that does not open (503 ESCROW_CORRUPT), and no budget moved.
      assert.deepEqual([answer.response.status, answer.body.code], [503, 'AUMLOK_ESCROW_CORRUPT'], JSON.stringify(answer.body))
      assert.equal((await r.budgets()).phraseFailures, before.phraseFailures)
    } else {
      assert.deepEqual([answer.response.status, answer.body.code], [503, 'AUMLOK_UNAVAILABLE'], `${name}: ${JSON.stringify(answer.body)}`)
      assert.deepEqual(await r.budgets(), before)
      // The challenge is still outstanding: the same request with a working verifier reaches the words again (and they
      // are wrong here: this fixture holds no real phrase), never AUMLOK_CHALLENGE_USED.
      const retry = await r.complete({ challengeId: unseal.challengeId, credential, commitmentSha256: 'e'.repeat(64) }, '/_host/aumlok/unseal')
      assert.deepEqual([retry.response.status, retry.body.code], [403, 'AUMLOK_RECOVERY_COMMITMENT_MISMATCH'], JSON.stringify(retry.body))
    }
  } },
  { route: 'promote (the owner\'s hybrid signature, Ed25519 half, at HEAD\'s promotion gate)', algorithm: 'Ed25519', run: async (r, name, answerOf) => {
    const s = r.signer()
    // What a genuine signed promotion of `{}` answers here, uninjected (the request is refused later, by HEAD's own rules).
    const genuine = await r.promote(await s.header())
    const before = await r.budgets()
    const mock = injectVerify(r.t, 'Ed25519', answerOf, text => text.startsWith(HYBRID_ENVELOPE_DOMAIN))
    const answer = await r.promote(await s.header())
    mock.mock.restore()
    await expectRow(r, name, answer, before, { wrongCode: 'HYBRID_SIGNATURE_INVALID', budget: true,
      ok: done => assert.deepEqual([done.response.status, done.body.code], [genuine.response.status, genuine.body.code], 'true proceeds exactly as the genuine one') })
    if (name === 'false') assert.equal((await r.budgets()).gate.find(([key]) => key.startsWith('head-gate:'))[1].failedAt.length, 1)
    if (!['true', 'false'].includes(name)) {
      const retry = await r.promote(await s.header())
      assert.deepEqual([retry.response.status, retry.body.code], [genuine.response.status, genuine.body.code])
    }
  } },
  { route: 'invite redeem (the guest door, no session: the bearer code\'s HMAC check at HEAD; it moves no owner budget)', algorithm: 'HMAC', run: async (r, name, answerOf) => {
    // A real invite whose commitment is the hash of a code the invitee holds (aumlok.mjs INVITEE_COMMITMENT_DOMAIN).
    const code = randomBytes(32), commitment = sha(Buffer.concat([Buffer.from('aukora.invite.invitee.v1\0'), code]))
    const invite = (await r.challenge({ purpose: 'invite', inviteeCommitmentSha256: commitment.toString('hex'), assignedDomainPointer: null })).body
    const issued = await r.complete({ challengeId: invite.challengeId, credential: assertionFor(r.fx.passkey, invite.publicKey.challenge),
      signature: sign(null, Buffer.from(invite.signaturePreimage), r.fx.node.privateKey).toString('base64url') }, '/_host/aumlok/invite')
    assert.equal(issued.response.status, 200, JSON.stringify(issued.body))
    const redeem = () => r.fx.call('/_host/aumlok/redeem', { method: 'POST', address: '198.51.100.7', body: { invite: issued.body.invite, code: code.toString('base64url') } })
    const before = await r.budgets()
    // Only the redeem's own check (its data is the commitment of the code sent); every other HMAC is real.
    const mock = injectVerify(r.t, 'HMAC', answerOf, text => text === commitment.toString('latin1'))
    const answer = await redeem()
    mock.mock.restore()
    if (name === 'false') assert.deepEqual([answer.response.status, answer.body.code], [403, 'AUMLOK_INVITE_CODE_INVALID'], JSON.stringify(answer.body))
    else if (name === 'true') assert.deepEqual([answer.response.status, answer.body.recipientStatus], [200, 'CODE_VERIFIED'], JSON.stringify(answer.body))
    else assert.deepEqual([answer.response.status, answer.body.code], [503, 'AUMLOK_UNAVAILABLE'], `${name}: ${JSON.stringify(answer.body)}`)
    // A bearer check: whatever the answer, no owner budget (AUMLOK's or HEAD's gate) moves, not even for a strict false.
    assert.deepEqual(await r.budgets(), before, `${name}: no owner budget moves`)
    if (name !== 'true') {
      const retry = await redeem()
      assert.deepEqual([retry.response.status, retry.body.recipientStatus], [200, 'CODE_VERIFIED'], `${name}: the genuine code then verifies: ${JSON.stringify(retry.body)}`)
    }
  } },
]
for (const row of TABLE) {
  for (const [name, answerOf] of TABLE_ANSWERS) {
    test(`TABLE: ${row.route}: the verifier answers ${name}`, async t => {
      const r = await ruleFixture(t)
      await row.run(r, name, answerOf)
    })
  }
}

test('TABLE: bind (store level, the real store): the assertion (ES256) and the node signature (Ed25519), every answer', async t => {
  for (const [check, algorithm, when, wrongCode] of [['assertion', 'ECDSA', () => true, 'AUMLOK_PROOF_INVALID'], ['node signature', 'Ed25519', nodeSigned, 'AUMLOK_NODE_PROOF_INVALID']]) {
    for (const [name, answerOf] of TABLE_ANSWERS) {
      await t.test(`${check}: ${name}`, async st => {
        const storage = memoryStorage(), owner = generateKeyPairSync('ed25519'), node = generateKeyPairSync('ed25519'), passkey = passkeyPair()
        const access = { type: 'owner', email: OWNER, expires: Math.floor(Date.now() / 1000) + 3600 }
        const store = createAumlokStore(storage, { origins: [ORIGIN], ownerPublicKeyHex: keyHex(owner),
          authorizeEnrollment: createOwnerEnrollmentVerifier({ mode: OWNER_ENROLLMENT_MODE, origin: ORIGIN, ownerEmail: OWNER, ownerPublicKeyHex: keyHex(owner) }) })
        const started = await store.challenge({ purpose: 'bind', requestId: 'bind-table', commitmentSha256: 'a'.repeat(64), nodePubkeyHex: keyHex(node), ...ROOT }, ORIGIN, { access })
        const registered = await store.complete('bind', { challengeId: started.challengeId, credential: registrationFor(passkey, started.publicKey.challenge) }, ORIGIN, { access })
        assert.equal(registered.phase, 'PENDING_ASSERTION', JSON.stringify(registered))
        const payload = { schema: OWNER_ENROLLMENT_SCHEMA, audience: ORIGIN, intentHash: registered.intentHash, nodePubkeyHex: keyHex(node), credentialId: passkey.id, expiresAt: registered.expiresAt }
        const enrollmentApproval = canonicalJson({ ...payload, signatureHex: sign(null, Buffer.from(OWNER_ENROLLMENT_DOMAIN + canonicalJson(payload)), owner.privateKey).toString('hex') })
        const budget = async () => { const state = await storage.get(AUMLOK_STORAGE_KEY); return [state.failures, state.failedAt, state.nextAllowedAt, state.binding] }
        const before = await budget()
        const genuineNode = sign(null, Buffer.from(registered.nodeProofPreimage), node.privateKey).toString('base64url')
        const body = check === 'assertion'
          ? { challengeId: registered.challengeId, credential: assertionFor(passkey, registered.publicKey.challenge, { counter: 1, signer: passkeyPair().key }), nodeSignature: genuineNode }
          : { challengeId: registered.challengeId, credential: assertionFor(passkey, registered.publicKey.challenge, { counter: 1 }), nodeSignature: garbageSignature() }
        const mock = injectVerify(st, algorithm, answerOf, when)
        const answer = await store.complete('bind', body, ORIGIN, { access, enrollmentApproval })
        mock.mock.restore()
        if (name === 'true') assert.equal(answer.bound, true, JSON.stringify(answer))
        else if (name === 'false') {
          assert.deepEqual([answer.code, answer.status], [wrongCode, 403])
          assert.equal((await budget())[0], before[0] + 1)
        } else {
          assert.deepEqual([answer.code, answer.status], ['AUMLOK_UNAVAILABLE', 503], JSON.stringify(answer))
          assert.deepEqual(await budget(), before)
          const retry = await store.complete('bind', { challengeId: registered.challengeId, credential: assertionFor(passkey, registered.publicKey.challenge, { counter: 1 }), nodeSignature: genuineNode },
            ORIGIN, { access, enrollmentApproval })
          assert.equal(retry.bound, true, JSON.stringify(retry))
        }
      })
    }
  }
})

// ══ JOB 11: THE TABLE'S SCREEN COLUMN. Every WebAuthn route, with an answer our screen refuses (a wrong challenge, a wrong
// origin): its status and code, ZERO signature operations (the library is never reached), and EVERY budget (AUMLOK's two
// and HEAD's whole gate table) byte-equal before and after. The reviewer's reproduction is the first approve row. The add
// door's registration has the same columns in passkey-devices-table.test.mjs. ══
const SCREEN_BENDS = [
  ['the reviewer\'s reproduction: a well-formed assertion for the made-up challenge "X" x 43', () => 'X'.repeat(43), {}],
  ['a wrong challenge', () => randomBytes(32).toString('base64url'), {}],
  ['a wrong origin', challenge => challenge, { origin: 'https://elsewhere.example.invalid' }],
]
const SCREEN_TABLE = [
  { route: 'approve (after a genuine owner sign-in)', run: async (r, challengeOf, bend) => {
    const issued = await r.issue()
    const answer = await r.complete({ challengeId: issued.challengeId, credential: assertionFor(r.fx.passkey, challengeOf(issued.publicKey.challenge), bend) })
    return { status: answer.response.status, code: answer.body.code, expected: [403, 'AUMLOK_PROOF_INVALID'] }
  } },
  { route: 'approve, a counter behind the stored one too', setup: async r => { await r.approveNow(5) }, run: async (r, challengeOf, bend) => {
    const issued = await r.issue()
    const answer = await r.complete({ challengeId: issued.challengeId, credential: assertionFor(r.fx.passkey, challengeOf(issued.publicKey.challenge), { ...bend, counter: 3 }) })
    return { status: answer.response.status, code: answer.body.code, expected: [403, 'AUMLOK_PROOF_INVALID'] }
  } },
  { route: 'refresh (the passkey before the node signature)', run: async (r, challengeOf, bend) => {
    const refresh = (await r.challenge({ purpose: 'refresh', commitmentSha256: 'c'.repeat(64), ...ROOT })).body
    const answer = await r.complete({ challengeId: refresh.challengeId, credential: assertionFor(r.fx.passkey, challengeOf(refresh.publicKey.challenge), bend),
      nodeSignature: sign(null, Buffer.from(refresh.nodeProofPreimage), r.fx.node.privateKey).toString('base64url') }, '/_host/aumlok/refresh')
    return { status: answer.response.status, code: answer.body.code, expected: [403, 'AUMLOK_PROOF_INVALID'] }
  } },
  { route: 'invite (the passkey before the node signature over the receipt)', run: async (r, challengeOf, bend) => {
    const invite = (await r.challenge({ purpose: 'invite', inviteeCommitmentSha256: 'd'.repeat(64), assignedDomainPointer: null })).body
    const answer = await r.complete({ challengeId: invite.challengeId, credential: assertionFor(r.fx.passkey, challengeOf(invite.publicKey.challenge), bend),
      signature: sign(null, Buffer.from(invite.signaturePreimage), r.fx.node.privateKey).toString('base64url') }, '/_host/aumlok/invite')
    return { status: answer.response.status, code: answer.body.code, expected: [403, 'AUMLOK_PROOF_INVALID'] }
  } },
  { route: 'invite revocation (the passkey before the node signature over the revocation)', setup: async r => {
    const invite = (await r.challenge({ purpose: 'invite', inviteeCommitmentSha256: 'e'.repeat(64), assignedDomainPointer: null })).body
    const issued = await r.complete({ challengeId: invite.challengeId, credential: assertionFor(r.fx.passkey, invite.publicKey.challenge, { counter: 5 }),
      signature: sign(null, Buffer.from(invite.signaturePreimage), r.fx.node.privateKey).toString('base64url') }, '/_host/aumlok/invite')
    assert.equal(issued.response.status, 200, JSON.stringify(issued.body))
    r.invited = issued.body.invite
  // Every state load re-checks the stored receipt's own node signature (aumlok.mjs inviteReceiptOutcome): not this
  // request's proof, so those (Ed25519 over that receipt's exact preimage) are not counted; every other check is.
  }, ignore: (r, algorithm, text) => algorithm === 'Ed25519' && text === aumlokInvitePreimage(r.invited), run: async (r, challengeOf, bend) => {
    const revoke = (await r.challenge({ purpose: 'invite', action: 'revoke', inviteId: r.invited.inviteId })).body
    const answer = await r.complete({ challengeId: revoke.challengeId, credential: assertionFor(r.fx.passkey, challengeOf(revoke.publicKey.challenge), { ...bend, counter: 6 }),
      signature: sign(null, Buffer.from(revoke.signaturePreimage), r.fx.node.privateKey).toString('base64url') }, '/_host/aumlok/invite')
    return { status: answer.response.status, code: answer.body.code, expected: [403, 'AUMLOK_PROOF_INVALID'] }
  } },
  { route: 'unseal (the passkey before the words)', run: async (r, challengeOf, bend) => {
    const unseal = (await r.challenge({ purpose: 'unseal' })).body
    const answer = await r.complete({ challengeId: unseal.challengeId, credential: assertionFor(r.fx.passkey, challengeOf(unseal.publicKey.challenge), bend), commitmentSha256: 'e'.repeat(64) }, '/_host/aumlok/unseal')
    return { status: answer.response.status, code: answer.body.code, expected: [403, 'AUMLOK_PROOF_INVALID'] }
  } },
  { route: 'sign-in (Worker pre-check, then HEAD)', run: async (r, challengeOf, bend) => {
    const issued = await r.fx.call(OWNER_PASSKEY.challenge, { method: 'POST', body: {} })
    const answer = await r.fx.call(OWNER_PASSKEY.signin, { method: 'POST', body: { challengeId: issued.body.challengeId, credential: assertionFor(r.fx.passkey, challengeOf(issued.body.publicKey.challenge), bend) } })
    return { status: answer.response.status, code: answer.body.code, expected: [403, 'AUMLOK_SIGNIN_PROOF_INVALID'] }
  } },
  { route: 'sign-in (HEAD\'s own check, the store past the Worker)', run: async (r, challengeOf, bend) => {
    const store = createAumlokStore(r.fx.headStorage, { origins: [ORIGIN], ownerPublicKeyHex: r.fx.env.OWNER_PUBLIC_KEY_HEX })
    const issued = await store.complete('signin-challenge', {}, ORIGIN)
    const error = await store.complete('signin', { challengeId: issued.challengeId, credential: assertionFor(r.fx.passkey, challengeOf(issued.publicKey.challenge), bend) }, ORIGIN).then(() => null, caught => caught)
    return { status: error?.status, code: error?.code, expected: [403, 'AUMLOK_SIGNIN_PROOF_INVALID'] }
  } },
]
for (const row of SCREEN_TABLE) {
  for (const [name, challengeOf, bend] of SCREEN_BENDS) {
    test(`TABLE, screen column: ${row.route}: ${name} is refused by the screen, no signature operation, every budget byte-equal`, async t => {
      const r = await ruleFixture(t)
      if (row.setup) await row.setup(r)
      const before = await r.budgets()
      const signatures = countSignatures(t, row.ignore ? (algorithm, text) => row.ignore(r, algorithm, text) : undefined)
      const answer = await row.run(r, challengeOf, bend)
      signatures.restore()
      assert.deepEqual([answer.status, answer.code], answer.expected, JSON.stringify(answer))
      assert.equal(signatures.seen.count, 0, 'the screen refused it: no signature was checked')
      assert.deepEqual(await r.budgets(), before, 'every budget byte-equal')
      // The owner is not slowed or locked by it: the next genuine approval succeeds at once.
      await r.approveNow(row.setup ? 6 : 0)
    })
  }
}
test('TABLE, screen column: bind (store level): the registration step and the assertion step, a wrong challenge and a wrong origin, uncounted', async t => {
  for (const [step, [name, challengeOf, bend]] of ['registration', 'assertion'].flatMap(step => SCREEN_BENDS.map(bendRow => [step, bendRow]))) {
    await t.test(`${step}: ${name}`, async st => {
      const storage = memoryStorage(), owner = generateKeyPairSync('ed25519'), node = generateKeyPairSync('ed25519'), passkey = passkeyPair()
      const access = { type: 'owner', email: OWNER, expires: Math.floor(Date.now() / 1000) + 3600 }
      const store = createAumlokStore(storage, { origins: [ORIGIN], ownerPublicKeyHex: keyHex(owner),
        authorizeEnrollment: createOwnerEnrollmentVerifier({ mode: OWNER_ENROLLMENT_MODE, origin: ORIGIN, ownerEmail: OWNER, ownerPublicKeyHex: keyHex(owner) }) })
      const started = await store.challenge({ purpose: 'bind', requestId: 'bind-screen', commitmentSha256: 'a'.repeat(64), nodePubkeyHex: keyHex(node), ...ROOT }, ORIGIN, { access })
      const budget = async () => { const state = await storage.get(AUMLOK_STORAGE_KEY); return [state.failures, state.failedAt, state.nextAllowedAt, state.phraseFailures ?? 0, state.binding] }
      let answer, before
      const signatures = countSignatures(st)
      if (step === 'registration') {
        before = await budget()
        answer = await store.complete('bind', { challengeId: started.challengeId, credential: registrationFor(passkey, challengeOf(started.publicKey.challenge), bend) }, ORIGIN, { access })
      } else {
        const registered = await store.complete('bind', { challengeId: started.challengeId, credential: registrationFor(passkey, started.publicKey.challenge) }, ORIGIN, { access })
        assert.equal(registered.phase, 'PENDING_ASSERTION', JSON.stringify(registered))
        before = await budget()
        answer = await store.complete('bind', { challengeId: registered.challengeId, credential: assertionFor(passkey, challengeOf(registered.publicKey.challenge), { ...bend, counter: 1 }),
          nodeSignature: sign(null, Buffer.from(registered.nodeProofPreimage), node.privateKey).toString('base64url') }, ORIGIN, { access })
      }
      signatures.restore()
      assert.deepEqual([answer.code, answer.status], ['AUMLOK_PROOF_INVALID', 403], JSON.stringify(answer))
      assert.equal(signatures.seen.count, 0, 'no signature operation')
      assert.deepEqual(await budget(), before, 'every budget byte-equal')
    })
  }
})

test('bind (store level, owner-signature-v1): the owner\'s enrolment signature (Ed25519), every answer; an outage keeps the challenge and the SAME challenge then binds', async t => {
  for (const [name, answerOf] of TABLE_ANSWERS) {
    await t.test(name, async st => {
      const storage = memoryStorage(), owner = generateKeyPairSync('ed25519'), node = generateKeyPairSync('ed25519'), passkey = passkeyPair()
      const access = { type: 'owner', email: OWNER, expires: Math.floor(Date.now() / 1000) + 3600 }
      const store = createAumlokStore(storage, { origins: [ORIGIN], ownerPublicKeyHex: keyHex(owner),
        authorizeEnrollment: createOwnerEnrollmentVerifier({ mode: OWNER_ENROLLMENT_MODE, origin: ORIGIN, ownerEmail: OWNER, ownerPublicKeyHex: keyHex(owner) }) })
      const started = await store.challenge({ purpose: 'bind', requestId: 'bind-enrolment', commitmentSha256: 'a'.repeat(64), nodePubkeyHex: keyHex(node), ...ROOT }, ORIGIN, { access })
      const registered = await store.complete('bind', { challengeId: started.challengeId, credential: registrationFor(passkey, started.publicKey.challenge) }, ORIGIN, { access })
      assert.equal(registered.phase, 'PENDING_ASSERTION', JSON.stringify(registered))
      const payload = { schema: OWNER_ENROLLMENT_SCHEMA, audience: ORIGIN, intentHash: registered.intentHash, nodePubkeyHex: keyHex(node), credentialId: passkey.id, expiresAt: registered.expiresAt }
      const enrollmentApproval = canonicalJson({ ...payload, signatureHex: sign(null, Buffer.from(OWNER_ENROLLMENT_DOMAIN + canonicalJson(payload)), owner.privateKey).toString('hex') })
      const budget = async () => { const state = await storage.get(AUMLOK_STORAGE_KEY); return [state.failures, state.failedAt, state.nextAllowedAt, state.phraseFailures ?? 0, state.binding] }
      const before = await budget()
      const body = () => ({ challengeId: registered.challengeId, credential: assertionFor(passkey, registered.publicKey.challenge, { counter: 1 }),
        nodeSignature: sign(null, Buffer.from(registered.nodeProofPreimage), node.privateKey).toString('base64url') })
      // Only the enrolment signature's check is injected; the passkey and the node signature are checked for real.
      const mock = injectVerify(st, 'Ed25519', answerOf, text => text.startsWith(OWNER_ENROLLMENT_DOMAIN))
      const answer = await store.complete('bind', body(), ORIGIN, { access, enrollmentApproval })
      mock.mock.restore()
      const retry = () => store.complete('bind', body(), ORIGIN, { access, enrollmentApproval })
      if (name === 'true') { assert.equal(answer.bound, true, JSON.stringify(answer)); return }
      assert.deepEqual(await budget(), before, `${name}: the enrolment check moves no budget`)
      if (name === 'false') {
        assert.deepEqual([answer.code, answer.status], ['AUMLOK_TRUSTED_ENROLLMENT_REQUIRED', 403], JSON.stringify(answer))
        await assert.rejects(retry(), { code: 'AUMLOK_CHALLENGE_USED' }, 'a checked-wrong enrolment signature uses up the challenge')
      } else {
        assert.deepEqual([answer.code, answer.status], ['AUMLOK_TRUSTED_ENROLLMENT_UNAVAILABLE', 503], `${name}: ${JSON.stringify(answer)}`)
        const again = await retry()
        assert.equal(again.bound, true, `${name}: the genuine retry on the SAME challenge binds: ${JSON.stringify(again)}`)
      }
    })
  }
})

test('the reviewer\'s reproduction: five registration attempts whose verification fails to run are 503, burn no miss and keep the challenge; the genuine one then joins', async t => {
  const fx = await fixture(t)
  const primary = await fx.signIn()
  const counters = await fx.ownerCounters()
  const made = await fx.makeCode(primary.cookie)
  const device = passkeyPair()
  const issued = await fx.call(PASSKEY_DEVICE_ROUTES.addChallenge, { method: 'POST', body: { code: made.code } })
  assert.equal(issued.response.status, 200, JSON.stringify(issued.body))
  const held = (await fx.headStorage.get(PASSKEY_DEVICES_PENDING_KEY)).pending
  for (const [index, failing] of [() => { throw new Error('digest down') }, () => Promise.reject(new Error('digest down'))].flatMap(item => [item, item, item]).slice(0, 5).entries()) {
    // The client-data hash the verifier needs fails (the reviewer's injection); every other digest still runs.
    const original = crypto.subtle.digest.bind(crypto.subtle)
    let armed = true
    const mock = t.mock.method(crypto.subtle, 'digest', (...args) => {
      if (armed && Buffer.from(args[1]).toString('latin1').includes('"webauthn.create"')) { armed = false; return failing() }
      return original(...args)
    })
    const answer = await fx.call(PASSKEY_DEVICE_ROUTES.add, { method: 'POST', body: { code: made.code, credential: registrationFor(device, issued.body.publicKey.challenge) } })
    mock.mock.restore()
    assert.deepEqual([answer.response.status, answer.body.code], [503, 'AUMLOK_UNAVAILABLE'], `attempt ${String(index + 1)}: ${JSON.stringify(answer.body)}`)
    const pending = (await fx.headStorage.get(PASSKEY_DEVICES_PENDING_KEY)).pending
    assert.deepEqual([pending.misses, pending.challenge, pending.challengesIssued], [0, held.challenge, held.challengesIssued], `attempt ${String(index + 1)}`)
  }
  const joined = await fx.call(PASSKEY_DEVICE_ROUTES.add, { method: 'POST', body: { code: made.code, credential: registrationFor(device, issued.body.publicKey.challenge) } })
  assert.equal(joined.response.status, 200, JSON.stringify(joined.body))
  assert.deepEqual(await fx.ownerCounters(), counters)
})

test('only a WRONG remainder of the code counts; the fifth burns it (the code\'s remainder is checked through proofOutcome)', async t => {
  const fx = await fixture(t)
  const primary = await fx.signIn()
  const made = await fx.makeCode(primary.cookie)
  // The same 66-bit lookup, another remainder: a well-formed wrong code.
  const wrong = made.code.slice(0, 11) + (made.code[11] === 'A' ? 'B' : 'A') + made.code.slice(12)
  const { lookup } = await deviceCodeHashes(made.code)
  if ((await deviceCodeHashes(wrong)).lookup !== lookup) return t.skip('the changed character falls inside the lookup prefix')
  const answers = []
  for (let index = 0; index < 5; index++) answers.push((await fx.call(PASSKEY_DEVICE_ROUTES.addChallenge, { method: 'POST', body: { code: wrong } })).body.code)
  assert.deepEqual(answers, [...Array(4).fill('AUMLOK_DEVICE_CODE_INVALID'), 'AUMLOK_DEVICE_CODE_BURNED'])
  assert.equal((await fx.headStorage.get(PASSKEY_DEVICES_PENDING_KEY)).pending, null)
})

test('after a device joins, only the spent code hint leaves the held key, and a key read begun before cannot republish it (main\'s invalidation)', async () => {
  const code = 'A'.repeat(43), { lookup } = await deviceCodeHashes(code)
  const keys = { value: { ok: true, generation: 1, credentialId: 'p', publicKeyB64: 'K', deviceCode: lookup, until: Date.now() + 60000 }, invalidations: 0 }
  // A key read in flight began here: worker.mjs signinKeyFor publishes it only if `invalidations` is still what it saw.
  const seenByTheRead = keys.invalidations
  const request = new Request(`${ORIGIN}${PASSKEY_DEVICE_ROUTES.add}`, { method: 'POST', headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
    body: JSON.stringify({ code, credential: {} }) })
  // A stand-in HEAD that accepts the registration (the door's own code path after HEAD's answer is what is judged here).
  const answer = await passkeyDeviceDoor(request, {}, new URL(request.url), ORIGIN, {
    forward: async () => Response.json({ ok: true, schema: 'aukora.aumlok.device-joining.v1', deviceId: 'd', label: 'L', phrase: '123 456', expiresAt: Date.now() + 1000 }),
    boundedRequest: async incoming => incoming, keys, keyFor: async () => keys.value, invalidated: () => { keys.invalidations++ } })
  assert.equal(answer.status, 200)
  assert.equal(keys.value.deviceCode, null, 'only the spent hint is taken out')
  assert.deepEqual([keys.value.ok, keys.value.credentialId, keys.value.publicKeyB64, keys.value.generation], [true, 'p', 'K', 1], 'usable sign-in material is kept')
  assert.ok(keys.invalidations > seenByTheRead, 'the read begun before can no longer publish its (spent) hint')
})

test('a code holder with the right prefix and a wrong remainder never expires the owner\'s usable cached key; with key reads failing her status stays 200', async t => {
  const fx = await fixture(t)
  const primary = await fx.signIn()
  const made = await fx.makeCode(primary.cookie)
  const wrong = made.code.slice(0, 11) + (made.code[11] === 'A' ? 'B' : 'A') + made.code.slice(12)
  if ((await deviceCodeHashes(wrong)).lookup !== (await deviceCodeHashes(made.code)).lookup) return t.skip('the changed character falls inside the lookup prefix')
  // The isolate now holds a usable key naming the code (a challenge ask reads it).
  assert.equal((await fx.call(PASSKEY_DEVICE_ROUTES.addChallenge, { method: 'POST', body: { code: made.code } })).response.status, 200)
  assert.equal((await fx.call('/_host/aumlok/status', { cookie: primary.cookie })).response.status, 200)
  // From now on every signin-key read at HEAD fails.
  const headFetch = fx.head.fetch.bind(fx.head)
  t.mock.method(fx.head, 'fetch', request => new URL(request.url).pathname === '/_host/aumlok/signin-key' ? Response.json({ ok: false, code: 'AUMLOK_UNAVAILABLE' }, { status: 503 }) : headFetch(request))
  const refused = await fx.call(PASSKEY_DEVICE_ROUTES.addChallenge, { method: 'POST', body: { code: wrong } })
  assert.deepEqual([refused.response.status, refused.body.code], [403, 'AUMLOK_DEVICE_CODE_INVALID'])
  const status = await fx.call('/_host/aumlok/status', { cookie: primary.cookie })
  assert.equal(status.response.status, 200, JSON.stringify(status.body))
})

test('HEAD\'s own sign-in check (the store, past the Worker) has the same three outcomes: false 403, no verdict 503, true signs in', async t => {
  const fx = await fixture(t)
  const store = createAumlokStore(fx.headStorage, { origins: [ORIGIN], ownerPublicKeyHex: fx.env.OWNER_PUBLIC_KEY_HEX })
  for (const [name, answerOf] of TABLE_ANSWERS) {
    const issued = await store.complete('signin-challenge', {}, ORIGIN)
    const mock = injectVerify(t, 'ECDSA', answerOf)
    const attempt = store.complete('signin', { challengeId: issued.challengeId, credential: assertionFor(fx.passkey, issued.publicKey.challenge, { signer: passkeyPair().key }) }, ORIGIN)
    if (name === 'true') assert.equal(typeof (await attempt).sessionToken, 'string')
    else if (name === 'false') await assert.rejects(attempt, { code: 'AUMLOK_SIGNIN_PROOF_INVALID', status: 403 })
    else await assert.rejects(attempt, { code: 'AUMLOK_UNAVAILABLE', status: 503 }, name)
    mock.mock.restore()
    if (!['true', 'false'].includes(name)) {
      const retry = await store.complete('signin', { challengeId: issued.challengeId, credential: assertionFor(fx.passkey, issued.publicKey.challenge) }, ORIGIN)
      assert.equal(typeof retry.sessionToken, 'string', `${name}: the challenge was not used`)
    }
  }
})

test('the owner\'s sign-in takes what a browser sends: extension results with members, an attachment field; Worker and HEAD sign in, nothing counted', async t => {
  const fx = await fixture(t)
  const counters = await fx.ownerCounters()
  // What the sign-in page sends: the browser's own getClientExtensionResults() (here with members) and, from a toJSON()
  // client, the authenticator attachment. The verifier reads neither.
  for (const extra of [{ clientExtensionResults: { credProps: { rk: true } } }, { clientExtensionResults: { appid: false, largeBlob: { supported: true } }, authenticatorAttachment: 'platform' }, { clientExtensionResults: undefined }]) {
    const issued = await fx.call(OWNER_PASSKEY.challenge, { method: 'POST', body: {} })
    assert.equal(issued.response.status, 200, JSON.stringify(issued.body))
    const credential = { ...assertionFor(fx.passkey, issued.body.publicKey.challenge), ...extra }
    const done = await fx.call(OWNER_PASSKEY.signin, { method: 'POST', body: { challengeId: issued.body.challengeId, credential } })
    assert.equal(done.response.status, 200, `${JSON.stringify(extra)}: ${JSON.stringify(done.body)}`)
    // HEAD's own check, past the Worker, takes it too.
    const store = createAumlokStore(fx.headStorage, { origins: [ORIGIN], ownerPublicKeyHex: fx.env.OWNER_PUBLIC_KEY_HEX })
    const direct = await store.complete('signin-challenge', {}, ORIGIN)
    const signed = await store.complete('signin', { challengeId: direct.challengeId, credential: { ...assertionFor(fx.passkey, direct.publicKey.challenge), ...extra } }, ORIGIN)
    assert.equal(typeof signed.sessionToken, 'string', JSON.stringify(extra))
  }
  // Bytes that are no assertion are still malformed (400) at both, never judged.
  const issued = await fx.call(OWNER_PASSKEY.challenge, { method: 'POST', body: {} })
  const good = assertionFor(fx.passkey, issued.body.publicKey.challenge)
  for (const bent of [{ ...good, clientExtensionResults: [] }, { ...good, rawId: 'x' + good.id }, { ...good, response: { ...good.response, authenticatorData: 'AAAA' } },
    { ...good, response: { ...good.response, clientDataJSON: Buffer.from('{"type":1}').toString('base64url') } }]) {
    const refused = await fx.call(OWNER_PASSKEY.signin, { method: 'POST', body: { challengeId: issued.body.challengeId, credential: bent } })
    assert.deepEqual([refused.response.status, refused.body.code], [400, 'AUMLOK_SIGNIN_INVALID'], JSON.stringify(refused.body))
  }
  assert.deepEqual(await fx.ownerCounters(), counters)
})

test('a ceremony that answered 503 gives its slot to the same owner starting the same purpose over; the fifth try is issued and approves; nobody else\'s ceremony is let go', async t => {
  const r = await ruleFixture(t)
  const before = await r.budgets()
  // A minute of a flaky backend: the approval page starts a NEW ceremony (a new request id) on every press.
  const mock = injectVerify(t, 'ECDSA', () => { throw new Error('backend down') })
  for (let press = 1; press <= 4; press++) {
    const issued = await r.issue()
    const answer = await r.complete({ challengeId: issued.challengeId, credential: assertionFor(r.fx.passkey, issued.publicKey.challenge) })
    assert.deepEqual([answer.response.status, answer.body.code], [503, 'AUMLOK_UNAVAILABLE'], `press ${String(press)}`)
  }
  mock.mock.restore()
  // The fifth press: issued (was 429 AUMLOK_CHALLENGE_CAPACITY), and the backend is back, so it approves.
  const fifth = await r.challenge({ purpose: 'approve', binding: await aumlokClass3Binding({ audience: ORIGIN, method: 'POST', pathname: '/_head/promote', body: { candidate: 'fifth' } }) })
  assert.equal(fifth.response.status, 200, JSON.stringify(fifth.body))
  const done = await r.complete({ challengeId: fifth.body.challengeId, credential: assertionFor(r.fx.passkey, fifth.body.publicKey.challenge) })
  assert.equal(done.response.status, 200, JSON.stringify(done.body))
  assert.deepEqual(await r.budgets(), before, 'no budget moved')
})

test('only a ceremony that answered 503 is let go, only for the same purpose; untouched outstanding ceremonies still refuse a fifth with its wait and still approve', async t => {
  const r2 = await ruleFixture(t)
  const held = []
  for (let index = 0; index < 4; index++) held.push(await r2.issue())
  const full = await r2.challenge({ purpose: 'approve', binding: await aumlokClass3Binding({ audience: ORIGIN, method: 'POST', pathname: '/_head/promote', body: { candidate: 'full' } }) })
  assert.deepEqual([full.response.status, full.body.code], [429, 'AUMLOK_CHALLENGE_CAPACITY'])
  // One of them answers 503: a new ceremony of the same purpose takes THAT slot, and the three others still approve.
  const flaky = injectVerify(t, 'ECDSA', () => undefined)
  const unavailable = await r2.complete({ challengeId: held[1].challengeId, credential: assertionFor(r2.fx.passkey, held[1].publicKey.challenge) })
  flaky.mock.restore()
  assert.equal(unavailable.response.status, 503)
  // Another purpose does not take it (unseal is not what was started over).
  const other = await r2.challenge({ purpose: 'unseal' })
  assert.deepEqual([other.response.status, other.body.code], [429, 'AUMLOK_CHALLENGE_CAPACITY'])
  const again = await r2.challenge({ purpose: 'approve', binding: await aumlokClass3Binding({ audience: ORIGIN, method: 'POST', pathname: '/_head/promote', body: { candidate: 'again' } }) })
  assert.equal(again.response.status, 200, JSON.stringify(again.body))
  const gone = await r2.complete({ challengeId: held[1].challengeId, credential: assertionFor(r2.fx.passkey, held[1].publicKey.challenge) })
  assert.deepEqual([gone.response.status, gone.body.code], [409, 'AUMLOK_CHALLENGE_UNKNOWN'], 'the abandoned one is gone, uncounted')
  for (const [index, issued] of [held[0], held[2], held[3], again.body].entries()) {
    const ok = await r2.complete({ challengeId: issued.challengeId, credential: assertionFor(r2.fx.passkey, issued.publicKey.challenge, { counter: index + 1 }) })
    assert.equal(ok.response.status, 200, `${String(index)}: ${JSON.stringify(ok.body)}`)
  }
})

test('the attestation order at bind\'s registration (the gate\'s host-facts failure): a well-formed attestation of another format, or a well-formed key of another algorithm, is UNSUPPORTED; bytes that are no attestation object are malformed; neither counts', async () => {
  const storage = memoryStorage(), owner = generateKeyPairSync('ed25519'), node = generateKeyPairSync('ed25519'), passkey = passkeyPair()
  const access = { type: 'owner', email: OWNER, expires: Math.floor(Date.now() / 1000) + 3600 }
  const store = createAumlokStore(storage, { origins: [ORIGIN], ownerPublicKeyHex: keyHex(owner),
    authorizeEnrollment: createOwnerEnrollmentVerifier({ mode: OWNER_ENROLLMENT_MODE, origin: ORIGIN, ownerEmail: OWNER, ownerPublicKeyHex: keyHex(owner) }) })
  // An RS256 COSE key (kty 3, alg -257): well-formed, an algorithm this node does not register.
  const rsa = { ...passkey, publicKeyB64: Buffer.from(isoCBOR.encode(new Map([[1, 3], [3, -257], [-1, randomBytes(256)], [-2, Buffer.from([1, 0, 1])]]))).toString('base64url') }
  const withAttestation = (credential, bytes) => ({ ...credential, response: { ...credential.response, attestationObject: Buffer.from(bytes).toString('base64url') } })
  const cases = [
    ['fmt packed (well-formed, not taken)', challenge => registrationFor(passkey, challenge, { fmt: 'packed' }), 'AUMLOK_ATTESTATION_UNSUPPORTED'],
    ['fmt tpm (well-formed, not taken)', challenge => registrationFor(passkey, challenge, { fmt: 'tpm' }), 'AUMLOK_ATTESTATION_UNSUPPORTED'],
    ['an RS256 key under fmt none', challenge => registrationFor(rsa, challenge), 'AUMLOK_ATTESTATION_UNSUPPORTED'],
    ['the ASCII text "attestation" (the old stand-in: a CBOR text string)', challenge => withAttestation(registrationFor(passkey, challenge), Buffer.from('attestation')), 'AUMLOK_PROOF_INVALID'],
    ['three bytes [1, 2, 3]', challenge => withAttestation(registrationFor(passkey, challenge), [1, 2, 3]), 'AUMLOK_PROOF_INVALID'],
    ['fmt none with a statement in it', challenge => withAttestation(registrationFor(passkey, challenge),
      isoCBOR.encode(new Map([['fmt', 'none'], ['attStmt', new Map([['sig', new Uint8Array(8)]])], ['authData', new Uint8Array(37)]]))), 'AUMLOK_PROOF_INVALID'],
  ]
  for (const [index, [name, make, code]] of cases.entries()) {
    const started = await store.challenge({ purpose: 'bind', requestId: `bind-order-${String(index)}`, commitmentSha256: 'a'.repeat(64), nodePubkeyHex: keyHex(node), ...ROOT }, ORIGIN, { access })
    const before = (await storage.get(AUMLOK_STORAGE_KEY)).failures
    const answer = await store.complete('bind', { challengeId: started.challengeId, credential: make(started.publicKey.challenge) }, ORIGIN, { access })
    assert.deepEqual([answer.ok, answer.code, answer.status], [false, code, 400], `${name}: ${JSON.stringify(answer)}`)
    assert.equal((await storage.get(AUMLOK_STORAGE_KEY)).failures, before, `${name}: never counted`)
  }
})
