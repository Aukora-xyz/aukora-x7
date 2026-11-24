/** Isolated whole-store restore rehearsal. Real stores and signature verifiers; no live credentials or I/O.
 * TODO declarations are unimplemented acceptance requirements, not graduation evidence.
 * The external witness/effect ledger counts local non-idempotent publication outcomes;
 * it never grants authority or sends a real external effect. No recovery adapter is mocked.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import { isoCBOR } from '@simplewebauthn/server/helpers'
import { AUMLOK_LIMITS, AUMLOK_STORAGE_KEY, createAumlokStore } from '../aumlok.mjs'
import { bootstrapPackage, createDurableHeadStore, digest, manifestIdCanon } from '../head-do.mjs'
import { canonicalJson, headPromotionBinding } from '../owner-grant-policy.mjs'
import { createOwnerEnrollmentVerifier, OWNER_ENROLLMENT_MODE, OWNER_ENROLLMENT_SCHEMA,
  OWNER_ENROLLMENT_DOMAIN } from '../enrollment-approval.mjs'

const ORIGIN = 'https://restore-rehearsal.example.invalid'
const EMAIL = 'owner@example.invalid'
const NOW = 1794000000000
const hash = value => createHash('sha256').update(value).digest()
const publicHex = key => key.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex')
const ROOT = { sealedRootKeyB64: Buffer.alloc(48, 19).toString('base64url'),
  kdfSaltB64: Buffer.alloc(32, 37).toString('base64url'), kdfIterations: 600000, ivB64: Buffer.alloc(12, 41).toString('base64url') }

function isolatedStorage() {
  let rows = new Map(), tail = Promise.resolve()
  return {
    async snapshot() { await tail; return structuredClone(rows) },
    async restore(snapshot, key) {
      await tail
      if (key === undefined) rows = structuredClone(snapshot)
      else if (snapshot.has(key)) rows.set(key, structuredClone(snapshot.get(key)))
      else rows.delete(key)
    },
    transaction(operation) {
      const result = tail.then(async () => {
        const next = structuredClone(rows)
        const output = await operation({
          get: async key => structuredClone(next.get(key)),
          put: async (key, value) => { next.set(key, structuredClone(value)) },
          delete: async key => next.delete(key),
          list: async ({ prefix = '', limit = Infinity } = {}) => new Map([...next]
            .filter(([key]) => key.startsWith(prefix)).slice(0, limit).map(([key, value]) => [key, structuredClone(value)])),
        })
        rows = next
        return output
      })
      tail = result.catch(() => undefined)
      return result
    },
  }
}

async function fixture(t) {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('Network forbidden in isolated restore rehearsal') })
  const storage = isolatedStorage(), owner = generateKeyPairSync('ed25519'), node = generateKeyPairSync('ed25519')
  const passkey = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }), jwk = passkey.publicKey.export({ format: 'jwk' })
  const credentialId = randomBytes(32).toString('base64url'), nodePubkeyHex = publicHex(node)
  let at = NOW
  let counter = 0, request = 0, identity, head
  const context = () => ({ access: { type: 'owner', email: EMAIL, expires: (NOW + 3600000) / 1000 } })
  const reopen = () => {
    identity = createAumlokStore(storage, { origins: [ORIGIN], now: () => at, ownerPublicKeyHex: publicHex(owner),
      authorizeEnrollment: createOwnerEnrollmentVerifier({ mode: OWNER_ENROLLMENT_MODE, origin: ORIGIN,
        ownerEmail: EMAIL, ownerPublicKeyHex: publicHex(owner), now: () => at }) })
    head = createDurableHeadStore(storage, { now: () => at, allowPasskeyOnlyGovernance: true,
      consumeGovernanceApproval: (tx, token, binding, origin) => identity.consumeApprovalInTransaction(tx, token, binding, origin) })
  }
  reopen()
  const client = (challenge, type) => Buffer.from(JSON.stringify({ type, challenge: challenge.publicKey.challenge,
    origin: ORIGIN, crossOrigin: false })).toString('base64url')
  const registration = challenge => {
    const auth = Buffer.alloc(87)
    hash(new URL(ORIGIN).hostname).copy(auth); auth[32] = 0x45
    auth.writeUInt16BE(32, 53); Buffer.from(credentialId, 'base64url').copy(auth, 55)
    const cose = Buffer.from(isoCBOR.encode(new Map([[1, 2], [3, -7], [-1, 1],
      [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]])))
    return { id: credentialId, rawId: credentialId, type: 'public-key', clientExtensionResults: {}, response: {
      clientDataJSON: client(challenge, 'webauthn.create'), attestationObject: Buffer.from(isoCBOR.encode(new Map([
        ['fmt', 'none'], ['attStmt', new Map()], ['authData', Buffer.concat([auth, cose])],
      ]))).toString('base64url') } }
  }
  const assertion = challenge => {
    const clientDataJSON = client(challenge, 'webauthn.get'), auth = Buffer.alloc(37)
    hash(new URL(ORIGIN).hostname).copy(auth); auth[32] = 5; auth.writeUInt32BE(++counter, 33)
    return { id: credentialId, rawId: credentialId, type: 'public-key', clientExtensionResults: {}, response: {
      clientDataJSON, authenticatorData: auth.toString('base64url'), signature: sign('sha256',
        Buffer.concat([auth, hash(Buffer.from(clientDataJSON, 'base64url'))]), passkey.privateKey).toString('base64url') } }
  }
  const bindInput = () => ({ purpose: 'bind', requestId: `bind-${++request}`, commitmentSha256: 'a'.repeat(64), nodePubkeyHex, ...ROOT })
  const code = 'export const rehearsal = true;', sha = await digest(code)
  const ball = { version: 'x6.1-ball/v1', parentBallId: null, epoch: 167, authorPeerId: 'synthetic-writer',
    entries: { fixture: { id: 'fixture', specifier: `ball:${sha}`, config: {}, disabled: false, previousSpecifiers: [] } },
    modules: { [sha]: { sha256: sha, specifier: `ball:${sha}` } } }
  ball.ballId = await manifestIdCanon(ball)
  const seed = await bootstrapPackage({ version: 'x61-bootstrap/v1', ball, codeBySha: { [sha]: code }, mirror: { entryCount: 0, batchDigests: [] } })
  assert.equal((await head.bootstrapPrepare(seed)).ok, true)
  assert.equal((await head.bootstrapCommit(seed.seedId, { ok: true, phase: 'ready', seedId: seed.seedId,
    ballId: ball.ballId, epoch: ball.epoch, entryCount: 0, nextBatch: 0, batchCount: 0 })).ok, true)
  const started = await identity.challenge(bindInput(), ORIGIN, context())
  const registered = await identity.complete('bind', { challengeId: started.challengeId, credential: registration(started) }, ORIGIN, context())
  const payload = { schema: OWNER_ENROLLMENT_SCHEMA, audience: ORIGIN, intentHash: registered.intentHash,
    nodePubkeyHex, credentialId, expiresAt: registered.expiresAt }
  const enrollmentApproval = canonicalJson({ ...payload, signatureHex: sign(null,
    Buffer.from(OWNER_ENROLLMENT_DOMAIN + canonicalJson(payload)), owner.privateKey).toString('hex') })
  const bound = await identity.complete('bind', { challengeId: registered.challengeId, credential: assertion(registered),
    nodeSignature: sign(null, Buffer.from(registered.nodeProofPreimage), node.privateKey).toString('base64url') }, ORIGIN, { ...context(), enrollmentApproval })
  assert.equal(bound.bound, true, JSON.stringify(bound))
  const next = { ...structuredClone(ball), parentBallId: ball.ballId, epoch: ball.epoch + 1 }
  next.entries['seed-receipts'] = { ...next.entries.fixture, id: 'seed-receipts', config: { rehearsal: true } }
  next.ballId = await manifestIdCanon(next)
  const binding = await headPromotionBinding({ audience: ORIGIN, ball: next, entryId: 'seed-receipts', previous: ball })
  const approve = async () => {
    const challenge = await identity.challenge({ purpose: 'approve', requestId: `approve-${++request}`, binding }, ORIGIN, context())
    const result = await identity.complete('approve', { challengeId: challenge.challengeId, credential: assertion(challenge) }, ORIGIN, context())
    assert.equal(typeof result.approvalToken, 'string', JSON.stringify(result))
    return result.approvalToken
  }
  const token = await approve()
  const lease = (await head.lease({ action: 'acquire', ownerPeerId: next.authorPeerId })).lease
  const input = { ball: next, expectedParentBallId: ball.ballId, expectedEpoch: ball.epoch, writerLease: lease }
  const external = { witness: null, effects: 0 }
  const publish = async (approvalToken = token) => {
    const result = await head.publish(input, { approvalToken, audience: ORIGIN })
    if (result.ok && !result.idempotent) {
      external.effects++
      external.witness = { ballId: next.ballId, epoch: next.epoch }
    }
    return result
  }
  return { ball, next, input, external, approve, publish, reopen, bindInput,
    snapshot: () => storage.snapshot(), restore: (snapshot, key) => storage.restore(snapshot, key),
    setTime: value => { at = value },
    verify: () => identity.verifyApproval(token, binding, ORIGIN),
    get identity() { return identity }, get head() { return head },
    consume: () => identity.consumeApproval(token, binding, ORIGIN), context }
}

// Acceptance inventory: every TODO remains open until production enforces its invariant.
// The isolated reproductions below demonstrate specific gaps, not restore acceptance.
const gaps = [
  ['whole-store rollback', 'Independent surviving-witness admission and owner recovery epoch are not implemented.'],
  ['one-row rollback', 'An independent consumed-approval commitment is required.'],
  ['witness deletion', 'recovery-restore.mjs now brings HEAD and mirror back into an emptied edge without re-genesis (same Pearl, epoch, receipts), but the AUMLOK owner binding is not in a recovery snapshot, so identity still re-geneses.'],
  ['unauthorized re-enrollment', 'Prior enrollment must be independently witnessed when identity storage is unavailable.'],
  ['joint-rollback limit', 'Outside surviving evidence or a new owner-origin authority epoch is required before recovery.'],
  ['signed fork ancestry versus length', 'Real ball-loader signed-checkpoint ancestry adapter coverage is unavailable here.'],
  ['truncated prefix UNDETERMINED', 'Real ball-loader checkpoint-prefix completeness adapter coverage is unavailable here.'],
  ['clock rollback across restart', 'A durable clock high-water admission check is required.'],
  ['cross-node owner-key reuse', 'An independently configured node-identity admission check is required.'],
]
for (const [name, reason] of gaps) test.todo(`whole-store restore, ${name}: ${reason}`)
test.todo('Positive witnessed recovery: production recovery adapter must admit a fresh owner approval with exactly one effect')

test('joint-rollback information limit: bit-identical evidence has identical digest', () => {
  const evidence = { generation: 1, checkpoint: 'synthetic-checkpoint', sequence: 7 }
  const identical = structuredClone(evidence)
  assert.deepEqual(identical, evidence)
  assert.equal(hash(canonicalJson(identical)).toString('hex'), hash(canonicalJson(evidence)).toString('hex'))
  // Byte equality alone carries no observation of an event absent from both inputs.
})

test('positive persisted approval remains single-use across restart', async t => {
  const f = await fixture(t)
  assert.equal((await f.publish()).ok, true)
  f.reopen()
  await assert.rejects(() => f.consume(), { code: 'CLASS3_WEBAUTHN_REQUIRED' })
  assert.equal(f.external.effects, 1)
})

test('positive enrolled identity refuses a second enrollment', async t => {
  const f = await fixture(t)
  f.reopen()
  await assert.rejects(() => f.identity.challenge(f.bindInput(), ORIGIN, f.context()), { code: 'ENROLLMENT_ALREADY_BOUND' })
  assert.equal((await f.identity.status()).bound, true)
})

test('positive HEAD stage refuses a non-parent candidate without changing selection', async t => {
  const f = await fixture(t), candidate = structuredClone(f.input)
  candidate.ball.parentBallId = 'f'.repeat(64)
  candidate.ball.ballId = await manifestIdCanon(candidate.ball)
  assert.equal((await f.head.stage(candidate, { audience: ORIGIN })).code, 'REBASE_REQUIRED')
  assert.equal((await f.head.read()).ball.ballId, f.ball.ballId)
})

test('positive restart accepts a fresh owner assertion with one local publication effect', async t => {
  const f = await fixture(t)
  f.reopen()
  const fresh = await f.approve()
  assert.equal((await f.publish(fresh)).ok, true)
  assert.equal((await f.publish(fresh)).idempotent, true)
  assert.equal(f.external.effects, 1)
  assert.equal(f.external.witness.ballId, f.next.ballId)
})

// These passing observations expose missing defenses. When a defense lands, replace its
// reproduction with the corresponding acceptance assertion and remove that TODO together.
test('whole-store restore gap reproduction (not acceptance): whole-store rollback repeats a publication despite a surviving observer', async t => {
  const f = await fixture(t), before = await f.snapshot()
  assert.equal((await f.publish()).ok, true)
  assert.equal(f.external.effects, 1)
  const survivingWitness = structuredClone(f.external.witness)
  await f.restore(before)
  f.reopen()
  assert.deepEqual(f.external.witness, survivingWitness)
  assert.equal((await f.head.read()).ball.ballId, f.ball.ballId)
  const replay = await f.publish()
  assert.equal(replay.ok, true)
  assert.notEqual(replay.idempotent, true)
  assert.equal(f.external.effects, 2, 'The observer is not a production admission witness')
})

test('whole-store restore gap reproduction (not acceptance): restoring only identity state re-enables consumed approval', async t => {
  const f = await fixture(t), before = await f.snapshot()
  assert.equal((await f.publish()).ok, true)
  await assert.rejects(() => f.verify(), { code: 'CLASS3_WEBAUTHN_REQUIRED' })
  await f.restore(before, AUMLOK_STORAGE_KEY)
  f.reopen()
  assert.equal((await f.head.read()).ball.ballId, f.next.ballId, 'HEAD was not rolled back')
  assert.equal((await f.verify()).ok, true)
  assert.equal((await f.consume()).ok, true)
  assert.equal(f.external.effects, 1, 'This shows approval resurrection, not a second HEAD publication')
})

test('whole-store restore gap reproduction (not acceptance): expired approval becomes valid after clock rollback and restart', async t => {
  const f = await fixture(t)
  f.setTime(NOW + AUMLOK_LIMITS.approvalMs)
  await assert.rejects(() => f.verify(), { code: 'CLASS3_WEBAUTHN_REQUIRED' })
  f.setTime(NOW)
  f.reopen()
  assert.equal((await f.verify()).ok, true, 'No durable clock high-water prevents resurrection')
  assert.equal(f.external.effects, 0)
})
