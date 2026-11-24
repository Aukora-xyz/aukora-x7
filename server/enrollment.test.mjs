/** Offline enrollment/promotion: real signature verification, synthetic keys and transactional memory only.
 * fmt:none exercises registration and signed UV, not hardware attestation or a live Epoch 163 artifact.
 */
import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import test from 'node:test'
import { isoCBOR } from '@simplewebauthn/server/helpers'
import { createWorker, X61HeadDurableObject } from '../deploy/cloudflare/src/worker.mjs'
import { bootstrapPackage, digest, manifestId, manifestIdCanon } from '../deploy/cloudflare/src/head-do.mjs'
import { MirrorDO, bootstrapMirror } from '../deploy/cloudflare/src/mirror-do.mjs'
import { AUMLOK_STORAGE_KEY, createAumlokStore, aumlokRequestAction, aumlokFailureResult } from '../deploy/cloudflare/src/aumlok.mjs'
import { canonicalJson, headPromotionBinding } from '../deploy/cloudflare/src/owner-grant-policy.mjs'
import { createLocalEnrollmentPolicy } from './local-enrollment.mjs'
import { createOwnerEnrollmentVerifier, OWNER_ENROLLMENT_MODE, OWNER_ENROLLMENT_SCHEMA,
  OWNER_ENROLLMENT_DOMAIN, OWNER_ENROLLMENT_HEADER, OWNER_ACCESS_ENROLLMENT_MODE } from '../deploy/cloudflare/src/enrollment-approval.mjs'

const ORIGIN = 'https://round28.example.invalid'
const EMAIL = 'owner@example.invalid'
const hash = value => createHash('sha256').update(value).digest()
const publicHex = key => key.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex')
const ROOT = Object.freeze({ sealedRootKeyB64: Buffer.alloc(48, 19).toString('base64url'),
  kdfSaltB64: Buffer.alloc(32, 37).toString('base64url'), kdfIterations: 600000, ivB64: Buffer.alloc(12, 41).toString('base64url') })

function memoryStorage() {
  let rows = new Map(), queue = Promise.resolve(), onPut = () => {}
  return {
    snapshot: () => structuredClone(rows),
    onPut: callback => { onPut = callback },
    transaction(operation) {
      const run = queue.then(async () => {
        const next = structuredClone(rows)
        const result = await operation({ get: async key => structuredClone(next.get(key)),
          put: async (key, value) => { next.set(key, structuredClone(value)); await onPut(key, value) }, delete: async key => next.delete(key),
          list: async ({ prefix = '', limit = Infinity } = {}) => new Map([...next].filter(([key]) => key.startsWith(prefix)).slice(0, limit)) })
        rows = next
        return result
      })
      queue = run.catch(() => undefined)
      return run
    },
  }
}

function proofFor(intent, owner, change = {}, domain = OWNER_ENROLLMENT_DOMAIN) {
  const payload = { schema: OWNER_ENROLLMENT_SCHEMA, audience: ORIGIN, intentHash: intent.intentHash,
    nodePubkeyHex: intent.nodePubkeyHex, credentialId: intent.credentialId, expiresAt: intent.expiresAt, ...change }
  return canonicalJson({ ...payload, signatureHex: sign(null, Buffer.from(domain + canonicalJson(payload)), owner.privateKey).toString('hex') })
}

async function fixture(t, { mode = OWNER_ENROLLMENT_MODE, verifiedSession = true, doOptions, jwtClaims = {}, origin = ORIGIN, local = false } = {}) {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('External network forbidden') })
  const owner = generateKeyPairSync('ed25519'), node = generateKeyPairSync('ed25519')
  const passkey = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const jwk = passkey.publicKey.export({ format: 'jwk' })
  const credentialId = randomBytes(32).toString('base64url'), nodePubkeyHex = publicHex(node)
  const storage = memoryStorage()
  const env = { PUBLIC_HOST: new URL(origin).host, OWNER_EMAIL: EMAIL, OWNER_PUBLIC_KEY_HEX: publicHex(owner),
    ...(mode === null ? {} : { AUMLOK_ENROLLMENT_MODE: mode }) }
  const open = options => options === undefined ? new X61HeadDurableObject({ storage, getWebSockets: () => [] }, env)
    : new X61HeadDurableObject({ storage, getWebSockets: () => [] }, env, options)
  let head = open(doOptions)
  env.HEAD = { idFromName: name => name, get: () => ({ fetch: request => head.fetch(request) }) }
  const mirrorStorage = memoryStorage(), mirror = new MirrorDO({ storage: mirrorStorage })
  env.MIRROR = { idFromName: name => name, get: () => ({ fetch: request => mirror.fetch(request) }) }
  const worker = createWorker()
  const localPolicy = local ? createLocalEnrollmentPolicy({ origin, ownerEmail: EMAIL, ownerPublicKeyHex: publicHex(owner),
    ...(mode === null ? {} : { mode }) }, [origin]) : null
  const localStore = local ? createAumlokStore(storage, { origins: [origin], ownerPublicKeyHex: publicHex(owner),
    authorizeEnrollment: localPolicy.authorizeEnrollment }) : null
  const seconds = Math.floor(Date.now() / 1000)
  const jwt = [Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' })).toString('base64url'),
    Buffer.from(JSON.stringify({ iss: 'aukora.x61.owner', aud: env.PUBLIC_HOST, email: EMAIL, nbf: seconds - 1, exp: seconds + 3600, ...jwtClaims })).toString('base64url')]
  jwt.push(sign(null, Buffer.from(jwt.join('.')), owner.privateKey).toString('base64url'))
  const request = async (pathname, body, extraHeaders = {}) => {
    const incoming = new Request(origin + pathname, { method: body === undefined ? 'GET' : 'POST',
      headers: { ...(verifiedSession ? { cookie: 'CF_Authorization=' + jwt.join('.') } : {}),
        origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', ...extraHeaders },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    if (local) {
      try {
        const action = aumlokRequestAction(incoming, [origin]), context = await localPolicy.context(incoming, action)
        const result = action === 'status' ? await localStore.status() : action === 'challenge'
          ? await localStore.challenge(body, origin, context) : await localStore.complete(action, body, origin, context)
        return { status: result.status ?? 200, body: result }
      } catch (error) { const result = aumlokFailureResult(error); return { status: result.status, body: result } }
    }
    const response = await worker.fetch(incoming, env)
    return { status: response.status, body: await response.json() }
  }
  const code = 'export default { synthetic: true }', sha = await digest(code)
  const ball = { version: 'x6.1-ball/v1', parentBallId: null, epoch: 162,
    entries: { fixture: { id: 'fixture', specifier: 'ball:' + sha, config: {}, disabled: false, previousSpecifiers: [] } },
    modules: { [sha]: { sha256: sha, specifier: 'ball:' + sha } } }
  ball.ballId = await manifestId(ball)
  const seed = await bootstrapPackage({ version: 'x61-bootstrap/v1', ball, codeBySha: { [sha]: code }, mirror: { entryCount: 0, batchDigests: [] } })
  await bootstrapMirror(mirrorStorage, { action: 'begin', seedId: seed.seedId, ballId: ball.ballId, epoch: ball.epoch, mirror: seed.mirror })
  await bootstrapMirror(mirrorStorage, { action: 'commit', seedId: seed.seedId })
  await head.store.bootstrapPrepare(seed)
  assert.equal((await head.store.bootstrapCommit(seed.seedId, { ok: true, phase: 'ready', seedId: seed.seedId,
    ballId: ball.ballId, epoch: ball.epoch, entryCount: 0, nextBatch: 0, batchCount: 0 })).ok, true)
  let counter = 0
  const client = (challenge, type) => Buffer.from(JSON.stringify({ type, challenge: challenge.publicKey.challenge, origin, crossOrigin: false })).toString('base64url')
  const registration = challenge => {
    const auth = Buffer.alloc(87)
    hash(new URL(origin).hostname).copy(auth); auth[32] = 0x45
    auth.writeUInt16BE(32, 53); Buffer.from(credentialId, 'base64url').copy(auth, 55)
    const cose = Buffer.from(isoCBOR.encode(new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]])))
    return { id: credentialId, rawId: credentialId, type: 'public-key', clientExtensionResults: {}, response: {
      clientDataJSON: client(challenge, 'webauthn.create'),
      attestationObject: Buffer.from(isoCBOR.encode(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', Buffer.concat([auth, cose])]]))).toString('base64url') } }
  }
  const assertion = (challenge, flags = 5) => {
    const clientDataJSON = client(challenge, 'webauthn.get'), auth = Buffer.alloc(37)
    hash(new URL(origin).hostname).copy(auth); auth[32] = flags; auth.writeUInt32BE(++counter, 33)
    return { id: credentialId, rawId: credentialId, type: 'public-key', clientExtensionResults: {}, response: { clientDataJSON,
      authenticatorData: auth.toString('base64url'), signature: sign('sha256', Buffer.concat([auth, hash(Buffer.from(clientDataJSON, 'base64url'))]), passkey.privateKey).toString('base64url') } }
  }
  const bindInput = requestId => ({ purpose: 'bind', requestId, commitmentSha256: 'a'.repeat(64), nodePubkeyHex, ...ROOT })
  const prepare = async (requestId = 'bind-1') => {
    const started = await request('/_host/aumlok/challenge', bindInput(requestId))
    assert.equal(started.status, 200, JSON.stringify(started.body))
    const registered = await request('/_host/aumlok/bind', { challengeId: started.body.challengeId, credential: registration(started.body) })
    assert.equal(registered.status, 200, JSON.stringify(registered.body))
    const challenge = registered.body
    return { challenge, intent: { ...challenge, origin, nodePubkeyHex, credentialId,
      genesis: true, registrationVerified: true, assertionVerified: true, nodeProofVerified: true },
    input: { challengeId: challenge.challengeId, credential: assertion(challenge),
      nodeSignature: sign(null, Buffer.from(challenge.nodeProofPreimage), node.privateKey).toString('base64url') } }
  }
  const enroll = async () => {
    const prepared = await prepare()
    const result = await request('/_host/aumlok/bind', prepared.input,
      mode === OWNER_ENROLLMENT_MODE ? { [OWNER_ENROLLMENT_HEADER]: proofFor(prepared.intent, owner) } : {})
    assert.equal(result.status, 200, JSON.stringify(result.body)); assert.equal(result.body.bound, true)
    return prepared
  }
  const approve = async (candidate, requestId = 'approval-1', audience = origin) => {
    const binding = await headPromotionBinding({ audience, ball: candidate, entryId: 'seed-receipts', previous: ball })
    const challenge = await request('/_host/aumlok/challenge', { purpose: 'approve', requestId, binding })
    assert.equal(challenge.status, 200, JSON.stringify(challenge.body))
    const result = await request('/_host/aumlok/approve', { challengeId: challenge.body.challengeId, credential: assertion(challenge.body) })
    assert.equal(result.status, 200, JSON.stringify(result.body)); assert.equal(typeof result.body.approvalToken, 'string')
    return result.body
  }
  const candidate = async (previous = ball) => {
    const next = { ...structuredClone(previous), parentBallId: previous.ballId, epoch: previous.epoch + 1, authorPeerId: 'synthetic-writer' }
    next.entries['seed-receipts'] = { ...next.entries.fixture, id: 'seed-receipts', config: { syntheticEpoch: next.epoch } }
    next.ballId = await manifestIdCanon(next)
    return next
  }
  const publication = async next => ({ ball: next, expectedParentBallId: next.parentBallId, expectedEpoch: next.epoch - 1,
    writerLease: (await request('/_head/lease', { action: 'acquire', ownerPeerId: next.authorPeerId })).body.lease })
  return { owner, node, env, storage, ball, request, prepare, bindInput, assertion, enroll, approve, candidate, publication,
    publishDirect: (input, options) => head.store.publish(input, options),
    state: () => storage.snapshot().get(AUMLOK_STORAGE_KEY),
    reopen(options = doOptions) { head = open(options) } }
}

test('Round 28 explicit signature mode on the two-argument edge requires independently signed owner intent', async t => {
  const f = await fixture(t)
  assert.equal((await f.request('/_host/aumlok/status')).body.enrollmentAvailable, true)
  const prepared = await f.prepare()
  const proof = proofFor(prepared.intent, f.owner)
  const result = await f.request('/_host/aumlok/bind', prepared.input, { [OWNER_ENROLLMENT_HEADER]: proof })
  assert.equal(result.status, 200, JSON.stringify(result.body)); assert.equal(result.body.bound, true)
  assert.equal(result.body.enrollmentCount, 1); assert.equal(result.body.enrollmentAvailable, false)
  const enrolled = f.state().enrollments
  assert.equal(enrolled.length, 1)
  assert.equal((await f.request('/_host/aumlok/bind', prepared.input, { [OWNER_ENROLLMENT_HEADER]: proof })).body.idempotent, true)
  assert.deepEqual(f.state().enrollments, enrolled)
  f.reopen()
  assert.equal((await f.request('/_host/aumlok/status')).body.enrollmentAvailable, false)
  assert.equal((await f.request('/_host/aumlok/challenge', f.bindInput('second-bind'))).body.code, 'ENROLLMENT_ALREADY_BOUND')
  assert.deepEqual(f.state().enrollments, enrolled)
})

test('Round 28 unknown host mode remains unavailable despite owner access and proof headers', async t => {
  for (const mode of ['true', 'owner-signature-v2']) {
    const f = await fixture(t, { mode })
    const before = f.storage.snapshot()
    assert.equal((await f.request('/_host/aumlok/status')).body.enrollmentAvailable, false)
    const result = await f.request('/_host/aumlok/challenge', f.bindInput('attempt'), {
      [OWNER_ENROLLMENT_HEADER]: '{"authorized":true}', 'x-x6-enrollment-mode': OWNER_ENROLLMENT_MODE })
    assert.equal(result.body.code, 'AUMLOK_TRUSTED_ENROLLMENT_UNAVAILABLE')
    assert.deepEqual(f.storage.snapshot(), before)
  }
})

test('Round 28 enrollment requires real owner authentication before any ceremony', async t => {
  const f = await fixture(t, { verifiedSession: false }), before = f.storage.snapshot()
  const result = await f.request('/_host/aumlok/challenge', f.bindInput('attempt'), {
    'x-x6-verified-access': JSON.stringify({ type: 'owner', email: EMAIL, expires: Date.now() / 1000 + 3600 }),
    [OWNER_ENROLLMENT_HEADER]: '{"authorized":true}' })
  assert.equal(result.status, 401); assert.deepEqual(f.storage.snapshot(), before)
})

test('Round 28 real registration and UV cannot replace absent, wrong-key or cross-domain owner approval', async t => {
  for (const kind of ['absent', 'node-key', 'access-domain', 'wrong-intent', 'wrong-credential', 'oversize']) {
    const f = await fixture(t), prepared = await f.prepare()
    const proof = kind === 'absent' ? null : kind === 'node-key' ? proofFor(prepared.intent, f.node)
      : kind === 'access-domain' ? proofFor(prepared.intent, f.owner, {}, 'aukora.x61.owner\0')
        : kind === 'wrong-intent' ? proofFor(prepared.intent, f.owner, { intentHash: 'b'.repeat(64) })
          : kind === 'wrong-credential' ? proofFor(prepared.intent, f.owner, { credentialId: 'other-credential' }) : 'x'.repeat(4097)
    const result = await f.request('/_host/aumlok/bind', prepared.input, proof === null ? {} : { [OWNER_ENROLLMENT_HEADER]: proof })
    assert.equal(result.body.code, 'AUMLOK_TRUSTED_ENROLLMENT_REQUIRED', kind)
    assert.equal(f.state().binding, null, kind); assert.equal(f.state().enrollmentCount, 0, kind)
    assert.deepEqual(f.state().enrollments, [], kind)
  }
})

test('Round 28 competing valid owner ceremonies commit exactly one durable enrollment', async t => {
  const f = await fixture(t), first = await f.prepare('first'), second = await f.prepare('second')
  const results = await Promise.all([first, second].map(prepared => f.request('/_host/aumlok/bind', prepared.input,
    { [OWNER_ENROLLMENT_HEADER]: proofFor(prepared.intent, f.owner) })))
  assert.equal(results.filter(result => result.body.bound === true).length, 1)
  assert.equal(results.filter(result => result.body.code === 'AUMLOK_CHALLENGE_BINDING_MISMATCH').length, 1)
  assert.equal(f.state().enrollmentCount, 1); assert.equal(f.state().enrollments.length, 1)
})

test('Round 28 owner access expiring after signature verification rolls back first enrollment', async t => {
  const f = await fixture(t), prepared = await f.prepare()
  let at = Date.now(), verified = false
  const context = { access: { type: 'owner', email: EMAIL, expires: (at + 1000) / 1000 },
    enrollmentApproval: proofFor(prepared.intent, f.owner) }
  const verify = createOwnerEnrollmentVerifier({ mode: OWNER_ENROLLMENT_MODE, origin: ORIGIN,
    ownerEmail: EMAIL, ownerPublicKeyHex: f.env.OWNER_PUBLIC_KEY_HEX, now: () => at })
  const store = createAumlokStore(f.storage, { origins: [ORIGIN], ownerPublicKeyHex: f.env.OWNER_PUBLIC_KEY_HEX,
    now: () => at, authorizeEnrollment: async (intent, transport) => {
      const approval = await verify(intent, transport)
      verified = approval.authorized === true
      at += 1000
      return approval
    } })
  const result = await store.complete('bind', prepared.input, ORIGIN, context)
  assert.equal(verified, true)
  assert.equal(result.code, 'AUMLOK_OWNER_ACCESS_REQUIRED')
  assert.equal(f.state().binding, null); assert.equal(f.state().enrollmentCount, 0)
  assert.deepEqual(f.state().enrollments, [])
})

test('Round 29 two-argument epoch 163 promotion ignores caller Pearl claims and refuses a forged approval', async t => {
  const f = await fixture(t)
  const lease = (await f.request('/_head/lease', { action: 'acquire', ownerPeerId: 'synthetic-writer' })).body.lease
  const ball = { ...structuredClone(f.ball), parentBallId: f.ball.ballId, epoch: 163, authorPeerId: 'synthetic-writer' }
  ball.entries['seed-receipts'] = { ...ball.entries.fixture, id: 'seed-receipts' }
  ball.ballId = await manifestIdCanon(ball)
  const before = f.storage.snapshot()
  const result = await f.request('/_head/ball', { ball, expectedParentBallId: f.ball.ballId, expectedEpoch: 162,
    writerLease: lease, qualifiedForPromotion: true, winnerId: 'baseline', decidedBy: 'caller', qualificationId: ball.ballId, qualification: { approved: true } }, { 'x-x6-class3-approval': 'not-an-approval' })
  assert.equal(result.body.code, 'CLASS3_WEBAUTHN_REQUIRED')
  assert.deepEqual(f.storage.snapshot(), before)
  const capability = (await f.request('/_head/lease')).body
  assert.equal(capability.governancePromotion, true)
  assert.equal(capability.governancePromotionBlocker, undefined)
})

test('Round 28 enrollment verifier rejects malformed, substituted, stale and wrong-domain evidence', async () => {
  const owner = generateKeyPairSync('ed25519'), now = 1000
  const options = { mode: OWNER_ENROLLMENT_MODE, origin: ORIGIN, ownerEmail: EMAIL, ownerPublicKeyHex: publicHex(owner), now: () => now }
  const verify = createOwnerEnrollmentVerifier(options)
  const intent = { intentHash: 'a'.repeat(64), nodePubkeyHex: 'b'.repeat(64), credentialId: 'synthetic-credential',
    origin: ORIGIN, expiresAt: 2000, genesis: true, registrationVerified: true, assertionVerified: true, nodeProofVerified: true }
  const context = { access: { type: 'owner', email: EMAIL, expires: 3 }, enrollmentApproval: proofFor(intent, owner) }
  assert.deepEqual(await verify(intent, context), { authorized: true, intentHash: intent.intentHash })
  for (const change of [{ audience: 'https://other.example.invalid' }, { nodePubkeyHex: 'c'.repeat(64) }, { expiresAt: 1999 },
    { schema: 'aukora.class3.action.v1' }, { credentialId: 'different' }, { intentHash: 'd'.repeat(64) }, { approved: true }]) {
    assert.equal((await verify(intent, { ...context, enrollmentApproval: proofFor(intent, owner, change) })).authorized, false)
  }
  const proof = JSON.parse(context.enrollmentApproval)
  for (const raw of ['', 'null', '[]', JSON.stringify(proof, null, 2), context.enrollmentApproval.replace('{', '{"schema":"duplicate",'),
    canonicalJson({ ...proof, ownerPublicKeyHex: publicHex(owner) }), canonicalJson({ ...proof, signatureHex: proof.signatureHex.toUpperCase() }),
    proofFor(intent, owner, {}, 'aukora.x6.owner-grant.v1\0')]) {
    assert.equal((await verify(intent, { ...context, enrollmentApproval: raw })).authorized, false)
  }
  for (const change of [{ genesis: false }, { assertionVerified: false }, { registrationVerified: false }, { nodeProofVerified: false },
    { nodePubkeyHex: publicHex(owner) }, { expiresAt: now }, { origin: 'https://other.example.invalid' }]) {
    assert.equal((await verify({ ...intent, ...change }, context)).authorized, false)
  }
  for (const access of [null, { type: 'owner', email: EMAIL, expires: 1 }, { type: 'owner', email: 'other@example.invalid', expires: 3 },
    { type: 'browser', email: EMAIL, expires: 3 }]) assert.equal((await verify(intent, { ...context, access })).authorized, false)
  for (const change of [{ mode: null }, { mode: 'unknown' }, { ownerPublicKeyHex: undefined }, { ownerPublicKeyHex: 'invalid' },
    { ownerEmail: undefined }, { origin: 'http://localhost' }, { origin: ORIGIN + '/' }]) assert.equal(createOwnerEnrollmentVerifier({ ...options, ...change }), undefined)
  for (const after of [999, 2000, 3000, NaN]) {
    let calls = 0
    const timed = createOwnerEnrollmentVerifier({ ...options, now: () => ++calls === 1 ? now : after })
    assert.equal((await timed(intent, context)).authorized, false)
  }
  let calls = 0
  const accessExpired = createOwnerEnrollmentVerifier({ ...options, now: () => ++calls === 1 ? 1000 : 1500 })
  assert.equal((await accessExpired(intent, { ...context, access: { ...context.access, expires: 1.5 } })).authorized, false)
})

test('Round 29 default and explicit owner-session genesis bind once without a signature header', async t => {
  for (const mode of [null, OWNER_ACCESS_ENROLLMENT_MODE]) {
    const f = await fixture(t, { mode })
    assert.equal((await f.request('/_host/aumlok/status')).body.enrollmentAvailable, true)
    const prepared = await f.enroll()
    const enrolled = structuredClone(f.state().enrollments)
    assert.equal((await f.request('/_host/aumlok/bind', prepared.input)).body.idempotent, true)
    f.reopen()
    assert.equal((await f.request('/_host/aumlok/status')).body.enrollmentAvailable, false)
    assert.equal((await f.request('/_host/aumlok/challenge', f.bindInput('second'))).body.code, 'ENROLLMENT_ALREADY_BOUND')
    assert.equal(f.state().enrollmentCount, 1); assert.deepEqual(f.state().enrollments, enrolled)
  }
})

test('Round 29 owner-session genesis rejects missing, wrong-owner, expired and spoofed sessions', async t => {
  for (const config of [{ verifiedSession: false }, { jwtClaims: { email: 'other@example.invalid' } }, { jwtClaims: { exp: 1 } },
    { jwtClaims: { aud: 'other.example.invalid' } }, { jwtClaims: { nbf: Date.now() / 1000 + 3600 } }]) {
    const f = await fixture(t, { mode: null, ...config }), before = f.storage.snapshot()
    const result = await f.request('/_host/aumlok/challenge', f.bindInput('attempt'), {
      'x-x6-verified-access': JSON.stringify({ type: 'owner', email: EMAIL, expires: Date.now() / 1000 + 3600 }) })
    assert.equal(result.status, 401); assert.deepEqual(f.storage.snapshot(), before)
  }
})

test('Round 29 genesis preserves UV, node-proof, owner-key separation and explicit enrollment refusal', async t => {
  for (const defect of ['uv', 'node-signature', 'owner-node']) {
    const f = await fixture(t, { mode: null })
    if (defect === 'owner-node') {
      const result = await f.request('/_host/aumlok/challenge', { ...f.bindInput('attempt'), nodePubkeyHex: f.env.OWNER_PUBLIC_KEY_HEX })
      assert.equal(result.body.code, 'NODE_KEY_IS_NOT_OWNER_KEY')
    } else {
      const prepared = await f.prepare()
      if (defect === 'uv') prepared.input.credential = f.assertion(prepared.challenge, 1)
      else prepared.input.nodeSignature = sign(null, Buffer.from(prepared.challenge.nodeProofPreimage), f.owner.privateKey).toString('base64url')
      assert.equal((await f.request('/_host/aumlok/bind', prepared.input)).body.code,
        defect === 'uv' ? 'AUMLOK_PROOF_INVALID' : 'AUMLOK_NODE_PROOF_INVALID')
    }
    assert.equal(f.state().binding, null); assert.equal(f.state().enrollmentCount, 0)
  }
  for (const authorizeEnrollment of [null, undefined]) {
    const f = await fixture(t, { mode: null, doOptions: { authorizeEnrollment } })
    assert.equal((await f.request('/_host/aumlok/status')).body.enrollmentAvailable, false)
    assert.equal((await f.request('/_host/aumlok/challenge', f.bindInput('attempt'))).body.code, 'AUMLOK_TRUSTED_ENROLLMENT_UNAVAILABLE')
  }
})

test('Round 29 concurrent owner-session genesis ceremonies select exactly one credential', async t => {
  const f = await fixture(t, { mode: null }), first = await f.prepare('first'), second = await f.prepare('second')
  const results = await Promise.all([first, second].map(prepared => f.request('/_host/aumlok/bind', prepared.input)))
  assert.equal(results.filter(result => result.body.bound === true).length, 1)
  assert.equal(results.filter(result => result.body.code === 'AUMLOK_CHALLENGE_BINDING_MISMATCH').length, 1)
  assert.equal(f.state().enrollmentCount, 1); assert.equal(f.state().enrollments.length, 1)
})

test('Round 29 real owner JWT and passkey approve a synthetic canonical epoch 163 through the two-argument HTTP path', async t => {
  const f = await fixture(t, { mode: null })
  await f.enroll()
  const ball = await f.candidate(), approval = await f.approve(ball), input = await f.publication(ball)
  assert.equal(ball.epoch, 163); assert.equal(ball.ballId, await manifestIdCanon(ball))
  const capability = (await f.request('/_head/lease')).body
  assert.equal(capability.governancePromotion, true)
  assert.equal(capability.governancePromotionPolicy, 'owner-passkey-canonical-single-entry-v1')
  assert.deepEqual(capability.governancePromotionRequirements, { canonicalManifest: true, unchangedOtherEntries: true, behavioralQualification: false })
  const result = await f.request('/_head/ball', input, { 'x-x6-class3-approval': approval.approvalToken })
  assert.equal(result.status, 200, JSON.stringify(result.body)); assert.equal(result.body.ballId, ball.ballId)
  assert.equal(f.storage.snapshot().get('head'), ball.ballId)
  assert.equal(f.state().approvals.filter(item => item.consumedAt !== null).length, 1)
  assert.equal([...f.storage.snapshot().keys()].some(key => key.startsWith('head:qualification:')), false)
  const after = f.storage.snapshot()
  assert.equal((await f.request('/_head/ball', input)).body.idempotent, true)
  assert.deepEqual(f.storage.snapshot(), after)
  f.reopen()
  const next = await f.candidate(ball)
  const replay = await f.request('/_head/ball', { ...input, ball: next, expectedParentBallId: ball.ballId, expectedEpoch: 163 },
    { 'x-x6-class3-approval': approval.approvalToken })
  assert.equal(replay.body.code, 'CLASS3_WEBAUTHN_REQUIRED'); assert.deepEqual(f.storage.snapshot(), after)
})

test('Round 29 default promotion refuses token, manifest, module, multi-organ and ordinary-change substitutions without spending approval', async t => {
  const f = await fixture(t, { mode: null }); await f.enroll()
  const ball = await f.candidate(), approval = await f.approve(ball), input = await f.publication(ball)
  const headers = { 'x-x6-class3-approval': approval.approvalToken }, before = f.storage.snapshot()
  for (const change of [null, 'forged-token']) {
    const result = await f.request('/_head/ball', { ...input, qualifiedForPromotion: true, winnerId: 'baseline', decidedBy: 'caller' },
      change === null ? {} : { 'x-x6-class3-approval': change })
    assert.equal(result.body.code, 'CLASS3_WEBAUTHN_REQUIRED'); assert.deepEqual(f.storage.snapshot(), before)
  }
  const cases = [
    { code: 'MANIFEST_HASH_MISMATCH', change: next => { next.entries['seed-receipts'].config.changed = true }, rehash: false },
    { code: 'MANIFEST_HASH_MISMATCH', change: next => { next.createdAt = 123 }, rehash: false },
    { code: 'CLASS3_CANONICAL_MANIFEST_REQUIRED', legacy: true },
    { code: 'CLASS3_SINGLE_GOVERNANCE_TRANSITION_REQUIRED', change: next => { next.entries['seed-pearl'] = { ...next.entries.fixture, id: 'seed-pearl' } } },
    { code: 'PEARL_QUALIFICATION_UNVERIFIABLE', change: next => { next.entries.fixture.config = { changed: true } } },
    { code: 'CLASS3_WEBAUTHN_REQUIRED', change: next => { next.entries['seed-receipts'].config.changed = true } },
  ]
  for (const scenario of cases) {
    const next = structuredClone(ball); scenario.change?.(next)
    if (scenario.legacy) next.ballId = await manifestId(next)
    else if (scenario.rehash !== false) next.ballId = await manifestIdCanon(next)
    const result = await f.request('/_head/ball', { ...input, ball: next }, headers)
    assert.equal(result.body.code, scenario.code); assert.deepEqual(f.storage.snapshot(), before)
  }
  const sha = Object.keys(ball.modules)[0]
  assert.equal((await f.request('/_head/ball', { ...input, codeBySha: { [sha]: 'tampered' } }, headers)).body.code, 'MODULE_HASH_MISMATCH')
  assert.deepEqual(f.storage.snapshot(), before)
  assert.equal((await f.request('/_head/ball', input, headers)).body.ok, true)
})

test('Round 29 ordinary Class 1 and explicit qualifier refusals never inherit owner-only admission', async t => {
  const f = await fixture(t, { mode: null }); await f.enroll()
  const ball = await f.candidate(), approval = await f.approve(ball), input = await f.publication(ball)
  const ordinary = structuredClone(ball); delete ordinary.entries['seed-receipts']; ordinary.entries.fixture.config.changed = true
  ordinary.ballId = await manifestIdCanon(ordinary)
  assert.equal((await f.request('/_head/ball', { ...input, ball: ordinary, qualifiedForPromotion: true,
    winnerId: 'candidate', decidedBy: 'retention-passes' })).body.code, 'PEARL_QUALIFICATION_UNVERIFIABLE')
  const before = f.storage.snapshot()
  for (const verifyTransitionQualification of [null, undefined]) {
    f.reopen({ verifyTransitionQualification })
    assert.equal((await f.request('/_head/lease')).body.governancePromotion, false)
    assert.equal((await f.request('/_head/ball', input, { 'x-x6-class3-approval': approval.approvalToken })).body.code, 'PEARL_QUALIFICATION_UNVERIFIABLE')
    assert.deepEqual(f.storage.snapshot(), before)
  }
  let calls = 0
  f.reopen({ verifyTransitionQualification: async () => { calls++; return null } })
  assert.equal((await f.request('/_head/ball', input, { 'x-x6-class3-approval': approval.approvalToken })).body.code, 'PEARL_QUALIFICATION_MISSING')
  assert.equal(calls, 1); assert.deepEqual(f.storage.snapshot(), before)
  f.reopen({ verifyTransitionQualification: async terms => ({ transitionSha256: terms.transitionSha256,
    qualificationId: terms.candidateBallId, expiresAt: Date.now() + 60000 }) })
  const capability = (await f.request('/_head/lease')).body
  assert.equal(capability.governancePromotionPolicy, 'qualified-owner-passkey-v1')
  assert.deepEqual(capability.governancePromotionRequirements, { canonicalManifest: false, unchangedOtherEntries: false, behavioralQualification: true })
  assert.equal((await f.request('/_head/ball', input, { 'x-x6-class3-approval': approval.approvalToken })).body.ok, true)
  assert.ok(f.storage.snapshot().has('head:qualification:' + ball.ballId))
})

test('Round 29 publication rollback restores a real approval after consumption and final-write expiry', async t => {
  let at = Date.now(); t.mock.method(Date, 'now', () => at)
  const f = await fixture(t, { mode: null }); await f.enroll()
  const ball = await f.candidate(), approval = await f.approve(ball), input = await f.publication(ball)
  const headers = { 'x-x6-class3-approval': approval.approvalToken }, before = f.storage.snapshot()
  let spentBeforeWrite = false
  f.storage.onPut((key, value) => {
    if (key === AUMLOK_STORAGE_KEY) spentBeforeWrite = value.approvals.some(item => item.consumedAt !== null)
    if (key === 'head') at = approval.expiresAt
  })
  const result = await f.request('/_head/ball', input, headers)
  assert.equal(spentBeforeWrite, true); assert.equal(result.body.code, 'CLASS3_TRANSITION_EXPIRED')
  assert.deepEqual(f.storage.snapshot(), before)
  f.storage.onPut(() => {})
  assert.equal((await f.request('/_head/lease', { action: 'acquire', ownerPeerId: ball.authorPeerId })).body.ok, true)
  const freshLease = (await f.request('/_head/lease')).body.lease
  const expired = await f.request('/_head/ball', { ...input, writerLease: freshLease }, headers)
  assert.equal(expired.body.code, 'CLASS3_WEBAUTHN_REQUIRED'); assert.equal(f.state().approvals[0].consumedAt, null)
})

test('Round 29 local enrollment requires explicit loopback identity and a cryptographically verified owner JWT', async t => {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('External network forbidden') })
  const origin = 'http://localhost:4610', owner = generateKeyPairSync('ed25519'), seconds = Math.floor(Date.now() / 1000)
  const config = { origin, ownerEmail: EMAIL, ownerPublicKeyHex: publicHex(owner) }
  const policy = createLocalEnrollmentPolicy(config, [origin])
  const jwt = changes => {
    const parts = [Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' })).toString('base64url'),
      Buffer.from(JSON.stringify({ iss: 'aukora.x61.owner', aud: 'localhost:4610', email: EMAIL, nbf: seconds - 1, exp: seconds + 3600, ...changes })).toString('base64url')]
    return [...parts, sign(null, Buffer.from(parts.join('.')), owner.privateKey).toString('base64url')].join('.')
  }
  const request = headers => new Request(origin + '/_host/aumlok/bind', { method: 'POST', headers })
  const intent = { intentHash: 'a'.repeat(64), nodePubkeyHex: 'b'.repeat(64), credentialId: 'synthetic-credential', origin,
    expiresAt: Date.now() + 60000, genesis: true, registrationVerified: true, assertionVerified: true, nodeProofVerified: true }
  const context = await policy.context(request({ cookie: 'CF_Authorization=' + jwt({}) }), 'bind')
  assert.equal(context.access.type, 'owner')
  assert.deepEqual(await policy.authorizeEnrollment(intent, context), { authorized: true, intentHash: intent.intentHash })
  for (const headers of [{ cookie: '__x6_cap=not-owner-identity' }, { 'x-x6-verified-access': JSON.stringify(context.access) },
    { 'x-x6-owner-assertion': jwt({ aud: new URL(ORIGIN).host }) }, { 'x-x6-owner-assertion': jwt({ email: 'other@example.invalid' }) },
    { 'x-x6-owner-assertion': jwt({ exp: seconds }) }, { 'x-x6-owner-assertion': jwt({}), cookie: 'CF_Authorization=' + jwt({ exp: seconds + 1200 }) }]) {
    assert.equal((await policy.context(request(headers), 'bind')).access, null)
  }
  for (const changed of [{ origin: undefined }, { ownerEmail: undefined }, { ownerPublicKeyHex: undefined }, { mode: 'unknown' },
    { origin: 'https://localhost:4610' }, { origin: 'http://other.example.invalid:4610' }, { origin: 'http://127.0.0.1:4610' }]) {
    assert.equal(createLocalEnrollmentPolicy({ ...config, ...changed }, [origin]).authorizeEnrollment, undefined)
  }
})

test('Round 29 local configured policy completes real registration, UV and node proof without starting a host', async t => {
  for (const origin of ['http://localhost:4610', 'http://127.0.0.1:4610']) {
    const f = await fixture(t, { mode: null, local: true, origin })
    assert.equal((await f.request('/_host/aumlok/status')).body.enrollmentAvailable, true)
    await f.enroll()
    assert.equal(f.state().enrollmentCount, 1)
    assert.equal((await f.request('/_host/aumlok/challenge', f.bindInput('second'))).body.code, 'ENROLLMENT_ALREADY_BOUND')
    assert.equal((await f.request('/_host/aumlok/status')).body.enrollmentAvailable, false)
  }
  const f = await fixture(t, { mode: null, local: true, origin: 'http://localhost:4610', verifiedSession: false })
  assert.equal((await f.request('/_host/aumlok/challenge', f.bindInput('attempt'), {
    cookie: '__x6_cap=synthetic-capability', 'x-x6-verified-access': JSON.stringify({ type: 'owner', email: EMAIL, expires: Date.now() / 1000 + 3600 }) })).body.code,
  'AUMLOK_OWNER_ACCESS_REQUIRED')
  assert.equal(f.state().binding, null); assert.equal(f.state().enrollmentCount, 0)
})

test('Round 29 owner-session policy checks every verified factor and both clocks without signature evidence', async () => {
  const owner = generateKeyPairSync('ed25519'), options = { origin: ORIGIN, ownerEmail: EMAIL, ownerPublicKeyHex: publicHex(owner), now: () => 1000 }
  const intent = { intentHash: 'a'.repeat(64), nodePubkeyHex: 'b'.repeat(64), credentialId: 'synthetic-credential', origin: ORIGIN,
    expiresAt: 2000, genesis: true, registrationVerified: true, assertionVerified: true, nodeProofVerified: true }
  const context = { access: { type: 'owner', email: EMAIL, expires: 3 } }
  const verify = createOwnerEnrollmentVerifier(options)
  assert.deepEqual(await verify(intent, context), { authorized: true, intentHash: intent.intentHash })
  for (const change of [{ genesis: false }, { registrationVerified: false }, { assertionVerified: false }, { nodeProofVerified: false },
    { origin: 'https://other.example.invalid' }, { nodePubkeyHex: publicHex(owner) }, { expiresAt: 1000 }, { intentHash: 'invalid' }]) {
    assert.equal((await verify({ ...intent, ...change }, context)).authorized, false)
  }
  for (const access of [null, { type: 'browser', email: EMAIL, expires: 3 }, { type: 'owner', email: 'other@example.invalid', expires: 3 },
    { type: 'owner', email: EMAIL, expires: 1 }]) assert.equal((await verify(intent, { access })).authorized, false)
  for (const after of [999, 2000, 3000, NaN]) {
    let calls = 0
    const timed = createOwnerEnrollmentVerifier({ ...options, now: () => ++calls === 1 ? 1000 : after })
    assert.equal((await timed(intent, context)).authorized, false)
  }
})

test('Round 29 canonical approval refuses author substitution even with a fresh matching alternate-author lease', async t => {
  const f = await fixture(t, { mode: null }); await f.enroll()
  const ball = await f.candidate(), approval = await f.approve(ball), input = await f.publication(ball)
  const headers = { 'x-x6-class3-approval': approval.approvalToken }
  await f.request('/_head/lease', { action: 'release', ...input.writerLease })
  const lease = (await f.request('/_head/lease', { action: 'acquire', ownerPeerId: 'alternate-author' })).body.lease
  const before = f.storage.snapshot(), changed = { ...ball, authorPeerId: 'alternate-author' }
  assert.equal((await f.request('/_head/ball', { ...input, ball: changed, writerLease: lease }, headers)).body.code, 'MANIFEST_HASH_MISMATCH')
  changed.ballId = await manifestIdCanon(changed)
  assert.equal((await f.request('/_head/ball', { ...input, ball: changed, writerLease: lease }, headers)).body.code, 'CLASS3_WEBAUTHN_REQUIRED')
  assert.deepEqual(f.storage.snapshot(), before); assert.equal(f.state().approvals[0].consumedAt, null)
})

test('Round 29 real promotion token refuses a different audience before consuming private state', async t => {
  const f = await fixture(t, { mode: null }); await f.enroll()
  const ball = await f.candidate(), approval = await f.approve(ball), input = await f.publication(ball), before = f.storage.snapshot()
  await assert.rejects(f.publishDirect(input, { approvalToken: approval.approvalToken, audience: 'https://other.example.invalid' }),
    { code: 'AUMLOK_ORIGIN_REQUIRED' })
  assert.deepEqual(f.storage.snapshot(), before)
  assert.equal((await f.request('/_head/ball', input, { 'x-x6-class3-approval': approval.approvalToken })).body.ok, true)
})

test('Round 29 fresh lease retries preserve exact owner approval while stale CAS and leases cannot spend it', async t => {
  let at = Date.now(); t.mock.method(Date, 'now', () => at)
  const f = await fixture(t, { mode: null }); await f.enroll()
  const ball = await f.candidate(), approval = await f.approve(ball), input = await f.publication(ball), headers = { 'x-x6-class3-approval': approval.approvalToken }
  assert.equal((await f.request('/_head/ball', { ...input, expectedEpoch: 161 }, headers)).body.code, 'REBASE_REQUIRED')
  assert.equal(f.state().approvals[0].consumedAt, null)
  at += 31000
  assert.equal((await f.request('/_head/ball', input, headers)).body.code, 'WRITER_LEASE_REQUIRED')
  assert.equal(f.state().approvals[0].consumedAt, null)
  const lease = (await f.request('/_head/lease', { action: 'acquire', ownerPeerId: ball.authorPeerId })).body.lease
  assert.equal((await f.request('/_head/ball', { ...input, writerLease: lease }, headers)).body.ok, true)
  assert.equal(f.storage.snapshot().get('head'), ball.ballId)
})
