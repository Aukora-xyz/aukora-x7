/** Offline Round 24 contracts: generated keys, in-memory custody, synthetic DNS/HTTPS and private temporary gate fixtures only.
 * Run: node --test server/verify-contracts.test.mjs
 * C/H labels follow the supplied Round 22 brief. H2/H3 have no separate definitions there;
 * TODO cases record that gap, rather than inventing requirements or claiming full closure.
 * G4 verifies an injected independent enrollment authority, not installed production enrollment.
 * Public fetch tests verify a Node transport; Cloudflare remains unavailable without its own guard.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { runInNewContext } from 'node:vm'
import { createHash, generateKeyPairSync, sign, hkdfSync, createDecipheriv } from 'node:crypto'
import { isoCBOR } from '@simplewebauthn/server/helpers'
import { ml_dsa65 } from '@noble/post-quantum/ml-dsa.js'
import { createAumlokStore, AUMLOK_STORAGE_KEY, AUMLOK_LIMITS, aumlokClass3Binding } from '../deploy/cloudflare/src/aumlok.mjs'
import { canonicalJson, OWNER_GOVERNANCE_ORGANS, classifyHeadTransition, headPromotionBinding, verifyHybridEnvelopeV2, verifySignedOwnerGrant, requireOwnerNodeKeySeparation } from '../deploy/cloudflare/src/owner-grant-policy.mjs'
import { handleCloudBroker, CLOUD_BROKER_LIMITS, publicHttpsTarget } from '../deploy/cloudflare/src/cloud-brokers.mjs'
import { reserveProviderBudget, providerBudgetLimits, providerRequestReservation } from '../deploy/cloudflare/src/provider-budget.mjs'
import { verifyCheckpointSignerPolicy, verifyFactCheckpoints } from './verified-facts.mjs'
import { createPublicHttpsTransport } from './public-https-transport.mjs'
import { createGateAudit } from './gate-audit.mjs'

const ORIGIN = 'https://contracts.example.invalid', NOW = 1794000000000
const digest = value => createHash('sha256').update(value).digest('hex')
const publicHex = key => key.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex')
const root = Object.freeze({ sealedRootKeyB64: Buffer.alloc(48, 19).toString('base64url'), kdfSaltB64: Buffer.alloc(32, 37).toString('base64url'), kdfIterations: 600000, ivB64: Buffer.alloc(12, 41).toString('base64url') })

function storage() {
  let rows = new Map(), queue = Promise.resolve()
  return {
    get: async key => structuredClone(rows.get(key)),
    transaction(operation) {
      const result = queue.then(async () => {
        const next = structuredClone(rows)
        const value = await operation({ get: async key => structuredClone(next.get(key)), put: async (key, value) => { next.set(key, structuredClone(value)) } })
        rows = next
        return value
      })
      queue = result.catch(() => {})
      return result
    },
  }
}

function custody({ approved = true, installed = true, ownerIsNode = false } = {}) {
  const node = generateKeyPairSync('ed25519'), owner = generateKeyPairSync('ed25519'), passkey = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const nodePubkeyHex = publicHex(node.publicKey), ownerPublicKeyHex = ownerIsNode ? nodePubkeyHex : publicHex(owner.publicKey)
  const jwk = passkey.publicKey.export({ format: 'jwk' }), credentialId = Buffer.alloc(32, 23).toString('base64url')
  const cose = Buffer.from(isoCBOR.encode(new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]])))
  const memory = storage(); let at = NOW, counter = 0
  const context = () => ({ access: { type: 'owner', email: 'owner@example.invalid', expires: (at + 3600000) / 1000 }, ip: '203.0.113.7' })
  const store = createAumlokStore(memory, { origins: [ORIGIN], ownerPublicKeyHex, now: () => at,
    ...(installed ? { authorizeEnrollment: async intent => {
      assert.equal(intent.genesis, true); assert.equal(intent.registrationVerified, true)
      assert.equal(intent.assertionVerified, true); assert.equal(intent.nodeProofVerified, true)
      return { authorized: approved, intentHash: intent.intentHash }
    } } : {}),
  })
  const challenge = input => store.challenge(input, ORIGIN, context())
  const complete = (purpose, input) => store.complete(purpose, input, ORIGIN, context())
  const client = (value, type) => Buffer.from(JSON.stringify({ type, challenge: value.publicKey.challenge, origin: ORIGIN, crossOrigin: false })).toString('base64url')
  function registration(value) {
    const auth = Buffer.alloc(87)
    createHash('sha256').update(new URL(ORIGIN).hostname).digest().copy(auth)
    auth[32] = 0x45; auth.writeUInt16BE(32, 53); Buffer.from(credentialId, 'base64url').copy(auth, 55)
    return { id: credentialId, rawId: credentialId, type: 'public-key', clientExtensionResults: {}, response: {
      clientDataJSON: client(value, 'webauthn.create'), attestationObject: Buffer.from(isoCBOR.encode(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', Buffer.concat([auth, cose])]]))).toString('base64url'),
    } }
  }
  function assertion(value, flags = 5, key = passkey.privateKey) {
    const clientDataJSON = client(value, 'webauthn.get'), auth = Buffer.alloc(37)
    createHash('sha256').update(new URL(ORIGIN).hostname).digest().copy(auth)
    auth[32] = flags; auth.writeUInt32BE(++counter, 33)
    return { id: credentialId, rawId: credentialId, type: 'public-key', clientExtensionResults: {}, response: {
      clientDataJSON, authenticatorData: auth.toString('base64url'), signature: sign('sha256', Buffer.concat([auth, createHash('sha256').update(Buffer.from(clientDataJSON, 'base64url')).digest()]), key).toString('base64url'),
    } }
  }
  const nodeSignature = value => sign(null, Buffer.from(value), node.privateKey).toString('base64url')
  const bindInput = { purpose: 'bind', requestId: 'genesis', commitmentSha256: 'a'.repeat(64), nodePubkeyHex, ...root }
  async function bind(flags = 5) {
    const first = await challenge(bindInput)
    const second = await complete('bind', { challengeId: first.challengeId, credential: registration(first) })
    return complete('bind', { challengeId: second.challengeId, credential: assertion(second, flags), nodeSignature: nodeSignature(second.nodeProofPreimage) })
  }
  return { store, challenge, complete, bind, bindInput, registration, assertion, nodeSignature, nodePubkeyHex, ownerPublicKeyHex,
    state: () => memory.get(AUMLOK_STORAGE_KEY), advance: amount => { at += amount }, context }
}

function hybridKeys() {
  const ed = generateKeyPairSync('ed25519'), pq = ml_dsa65.keygen(new Uint8Array(32).fill(23))
  const trustedKeys = { ed25519PublicKeyHex: publicHex(ed.publicKey), mlDsaPublicKeyHex: Buffer.from(pq.publicKey).toString('hex') }
  const envelope = (artifact, payload, domain = 'aukora.hybrid.v2\0') => {
    const value = { schema: 'aukora.hybrid-envelope.v2', artifact, payload, algManifest: {
      classical: { alg: 'Ed25519', keyId: digest(Buffer.from(trustedKeys.ed25519PublicKeyHex, 'hex')).slice(0, 12) },
      pq: { alg: 'ML-DSA-65', keyId: digest(pq.publicKey).slice(0, 12) },
    } }
    const bytes = Buffer.from(domain + canonicalJson(value))
    return { ...value, signatures: { ed25519SigHex: sign(null, bytes, ed.privateKey).toString('hex'), mlDsaSigHex: Buffer.from(ml_dsa65.sign(bytes, pq.secretKey, { context: Buffer.from('aukora.v2') })).toString('hex') } }
  }
  return { ed, trustedKeys, envelope }
}

test('C1 / Contract 2: Worker has no owner signing secret; valid client signatures verify, unsigned grants do not', async () => {
  const source = readFileSync(new URL('../deploy/cloudflare/src/worker.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /OWNER_ED25519_SECRET_KEY|crypto\.subtle\.sign\s*\(/)
  const keys = hybridKeys(), payload = { mandateId: 'contract', ticketId: null, scope: { organs: ['fixture'] }, ballId: 'b'.repeat(64), epoch: 1, expiresAt: NOW + 60000, identity: 'owner@example.invalid' }
  const signed = keys.envelope('owner-grant', payload)
  assert.equal(canonicalJson((await verifySignedOwnerGrant(signed, { trustedKeys: keys.trustedKeys, now: NOW })).binding), canonicalJson(payload))
  await assert.rejects(verifySignedOwnerGrant(payload, { trustedKeys: keys.trustedKeys, now: NOW }))
  for (const field of ['ed25519SigHex', 'mlDsaSigHex']) {
    const value = structuredClone(signed); delete value.signatures[field]
    await assert.rejects(verifySignedOwnerGrant(value, { trustedKeys: keys.trustedKeys, now: NOW }), { code: 'HYBRID_SIGNATURE_INCOMPLETE' })
  }
  await assert.rejects(verifyHybridEnvelopeV2(keys.envelope('owner-grant', payload, 'aukora.hybrid.v1\0'), { artifact: 'owner-grant', trustedKeys: keys.trustedKeys }), { code: 'HYBRID_SIGNATURE_INVALID' })
  for (const mutate of [v => { v.payload.epoch++ }, v => { v.schema = 'aukora.hybrid-envelope.v1' }, v => { v.artifact = 'invite' }, v => { v.algManifest.pq.alg = 'Ed25519' }]) {
    const value = structuredClone(signed); mutate(value)
    await assert.rejects(verifyHybridEnvelopeV2(value, { artifact: 'owner-grant', trustedKeys: keys.trustedKeys }))
  }
})

test('G1 / Contract 1: escrow omits client ciphertext and unpeppered commitment; wrong pepper cannot authenticate it', async () => {
  const fixture = custody(); assert.equal((await fixture.bind()).bound, true)
  const state = await fixture.state(), escrow = state.binding.rootEscrow
  assert.equal(escrow.schema, 'aukora.aumlok.escrow.v3')
  assert.equal(JSON.stringify(state).includes('sealedRootKeyB64'), false)
  assert.equal(JSON.stringify(state).includes(root.sealedRootKeyB64), false)
  assert.equal(JSON.stringify(state).includes(fixture.bindInput.commitmentSha256), false)
  const open = pepper => {
    const key = hkdfSync('sha256', pepper, Buffer.from(escrow.kdfSaltB64, 'base64url'), 'aukora.aumlok.escrow-wrap.v2', 32)
    const ciphertext = Buffer.from(escrow.ciphertextB64, 'base64url'), decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(escrow.ivB64, 'base64url'))
    decipher.setAAD(Buffer.from(escrow.schema + '\0' + fixture.nodePubkeyHex + '\0' + state.binding.recoveryCommitment))
    decipher.setAuthTag(ciphertext.subarray(-16))
    return JSON.parse(Buffer.concat([decipher.update(ciphertext.subarray(0, -16)), decipher.final()]).toString())
  }
  assert.deepEqual(open(Buffer.from(state['pepper.v1'], 'base64url')), root)
  assert.throws(() => open(Buffer.alloc(32)))
  // Pepper resides in the same private state. Theft of the complete state defeats this separation.
})

test('G4: independent enrollment succeeds once with audit; missing authority, missing UV and rejection stay unbound', async () => {
  const fixture = custody(); assert.equal((await fixture.bind()).enrollmentCount, 1)
  const before = (await fixture.state()).enrollments
  assert.equal(before.length, 1); assert.equal(before[0].schema, 'aumlok.enrollment.v1')
  await assert.rejects(fixture.challenge({ ...fixture.bindInput, requestId: 'second' }), { code: 'ENROLLMENT_ALREADY_BOUND' })
  assert.deepEqual((await fixture.state()).enrollments, before)
  const unavailable = custody({ installed: false })
  await assert.rejects(unavailable.bind(), { code: 'AUMLOK_TRUSTED_ENROLLMENT_UNAVAILABLE' })
  for (const [options, flags] of [[{ approved: false }, 5], [{}, 1]]) {
    const rejected = custody(options)
    assert.equal((await rejected.bind(flags)).ok, false)
    assert.equal((await rejected.store.status()).bound, false)
    assert.equal((await rejected.state()).enrollmentCount, 0)
  }
})

test('G5: the node cannot be the enrolled owner authority or authorize an otherwise valid owner grant', async () => {
  const fixture = custody({ ownerIsNode: true })
  await assert.rejects(fixture.bind(), { code: 'NODE_KEY_IS_NOT_OWNER_KEY' })
  const keys = hybridKeys()
  requireOwnerNodeKeySeparation(keys.trustedKeys.ed25519PublicKeyHex, 'b'.repeat(64))
  assert.throws(() => requireOwnerNodeKeySeparation(keys.trustedKeys.ed25519PublicKeyHex, keys.trustedKeys.ed25519PublicKeyHex), { code: 'NODE_KEY_IS_NOT_OWNER_KEY' })
  const payload = { mandateId: 'node-grant', ticketId: null, scope: { organs: ['fixture'] }, ballId: 'b'.repeat(64), epoch: 1, expiresAt: NOW + 60000, identity: 'owner@example.invalid' }
  await assert.rejects(verifySignedOwnerGrant(keys.envelope('owner-grant', payload), { trustedKeys: keys.trustedKeys, nodePublicKeyHex: keys.trustedKeys.ed25519PublicKeyHex, now: NOW }), { code: 'NODE_KEY_IS_NOT_OWNER_KEY' })
})

test('Contract 1: raw secrets are rejected, rotation retains the node and unseal requires a fresh assertion', async () => {
  const fixture = custody()
  for (const input of [{ words: ['not stored'] }, { nested: { phrase: 'not stored' } }, { privateKey: 'not stored' }]) await assert.rejects(fixture.challenge(input), { code: 'CLASS4_RAW_SECRET_FORBIDDEN', status: 400 })
  const first = await fixture.bind(), replacement = { ...root, sealedRootKeyB64: Buffer.alloc(48, 52).toString('base64url') }
  const rotate = await fixture.challenge({ purpose: 'refresh', requestId: 'rotate', commitmentSha256: 'b'.repeat(64), ...replacement })
  const result = await fixture.complete('refresh', { challengeId: rotate.challengeId, credential: fixture.assertion(rotate), nodeSignature: fixture.nodeSignature(rotate.nodeProofPreimage) })
  assert.equal(result.nodePubkeyHex, first.nodePubkeyHex); assert.equal(result.rotationSeq, 1)
  assert.notEqual(result.keyCommitmentId, first.keyCommitmentId)
  const unseal = await fixture.challenge({ purpose: 'unseal', requestId: 'unseal' })
  const input = { challengeId: unseal.challengeId, credential: fixture.assertion(unseal), commitmentSha256: 'b'.repeat(64) }
  assert.deepEqual((await fixture.complete('unseal', input)).sealedRoot, replacement)
  await assert.rejects(fixture.complete('unseal', input), { code: 'AUMLOK_CHALLENGE_USED' })
})

test('Round 25: unseal requires a valid commitment and fresh UV with no passkey-only downgrade', async () => {
  for (const commitment of [{}, { commitmentSha256: 'not-a-digest' }, { commitmentSha256: 'A'.repeat(64) }, { commitmentSha256: 'b'.repeat(64) }]) {
    const fixture = custody(); await fixture.bind()
    const challenge = await fixture.challenge({ purpose: 'unseal', requestId: 'refused-commitment' })
    const before = await fixture.state()
    const proof = { challengeId: challenge.challengeId, credential: fixture.assertion(challenge), ...commitment }
    const refused = await fixture.complete('unseal', proof)
    assert.equal(refused.ok, false)
    assert.equal(refused.code, commitment.commitmentSha256 === 'b'.repeat(64) ? 'AUMLOK_RECOVERY_COMMITMENT_MISMATCH' : 'AUMLOK_COMMITMENT_INVALID')
    assert.equal(Object.hasOwn(refused, 'sealedRoot'), false)
    assert.equal(Object.hasOwn(refused, 'phraseVerified'), false)
    const after = await fixture.state()
    assert.equal(after.failures, 0)
    // Only words checked and wrong are a phrase guess; a malformed or absent commitment is refused, never counted.
    assert.equal(after.phraseFailures, before.phraseFailures + (commitment.commitmentSha256 === 'b'.repeat(64) ? 1 : 0))
    assert.deepEqual(after.binding.rootEscrow, before.binding.rootEscrow)
    // Job 7: wrong words are checked after a good passkey (its counter advances); a malformed or absent commitment is
    // refused before the passkey is read, so the passkey's counter is untouched.
    if (commitment.commitmentSha256 === 'b'.repeat(64)) assert.ok(after.binding.credential.counter > before.binding.credential.counter)
    else assert.deepEqual(after.binding.credential, before.binding.credential)
    await assert.rejects(fixture.complete('unseal', { ...proof, commitmentSha256: 'a'.repeat(64) }), { code: 'AUMLOK_CHALLENGE_USED' })
    fixture.advance(AUMLOK_LIMITS.backoffMs)
    const fresh = await fixture.challenge({ purpose: 'unseal', requestId: 'valid-commitment' })
    const encrypted = await fixture.complete('unseal', { challengeId: fresh.challengeId, credential: fixture.assertion(fresh), commitmentSha256: 'a'.repeat(64) })
    assert.deepEqual(encrypted.sealedRoot, root)
    assert.equal(encrypted.phraseVerified, true)
    assert.equal((await fixture.state()).phraseFailures, after.phraseFailures)
  }
})

test('Contract 1: cumulative failures reach durable hard lockout without persisting raw IP or owner email', async () => {
  const fixture = custody()
  // Job 6, the one rule: malformed attempts are refused and never counted; only proofs checked and wrong are.
  for (let index = 0; index < 10; index++) await assert.rejects(fixture.complete('bind', { challengeId: 'bad' }), { code: 'AUMLOK_REQUEST_INVALID' })
  assert.equal((await fixture.state()).failures, 0)
  for (let index = 0; index < 10; index++) {
    const first = await fixture.challenge({ ...fixture.bindInput, requestId: 'wrong-proof-' + index })
    const second = await fixture.complete('bind', { challengeId: first.challengeId, credential: fixture.registration(first) })
    // Job 11: a missing user verification is screened (never counted); a checked-wrong signature (another key) counts.
    const refused = await fixture.complete('bind', { challengeId: second.challengeId, credential: fixture.assertion(second, 5, generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey),
      nodeSignature: fixture.nodeSignature(second.nodeProofPreimage) })
    assert.equal(refused.code, 'AUMLOK_PROOF_INVALID')
    fixture.advance(3600001)
  }
  await assert.rejects(fixture.bind(), { code: 'AUMLOK_GUARDIAN_QUORUM_REQUIRED' })
  const state = await fixture.state()
  assert.equal(state.failures, 10)
  assert.ok(state.attempts.every(row => row.schema === 'aumlok.attempt.v1' && /^[a-f0-9]{8}$/.test(row.ipHash32)))
  assert.equal(JSON.stringify(state).includes('203.0.113.7'), false)
  assert.equal(JSON.stringify(state).includes('owner@example.invalid'), false)
})

test('G2: server classification detects protected addition, removal, specifier, config and disabled changes', async () => {
  const entry = { id: 'seed-pearl', specifier: 'ball:' + 'a'.repeat(64), config: {}, disabled: false }
  const previous = { entries: { 'seed-pearl': entry } }, candidate = { ballId: 'c'.repeat(64), epoch: 163, entries: structuredClone(previous.entries) }
  assert.equal(classifyHeadTransition(previous, candidate).class, 1)
  candidate.entries.fixture = { ...entry, id: 'fixture' }
  assert.equal(classifyHeadTransition(previous, candidate).class, 1)
  for (const mutate of [b => { delete b.entries['seed-pearl'] }, b => { b.entries['seed-pearl'].disabled = true }, b => { b.entries['seed-pearl'].config = { changed: true } }, b => { b.entries['seed-pearl'].specifier = 'ball:' + 'd'.repeat(64) }]) {
    const changed = structuredClone(candidate); mutate(changed)
    assert.deepEqual(classifyHeadTransition(previous, changed), { class: 3, entryIds: ['seed-pearl'] })
    const binding = await headPromotionBinding({ audience: ORIGIN, ball: changed, entryId: 'seed-pearl' })
    assert.equal(binding.action, 'head.promote'); assert.equal(binding.ballId, candidate.ballId); assert.equal(binding.epoch, 163)
    assert.match(binding.candidateSha256, /^[0-9a-f]{64}$/)
  }
  assert.equal(classifyHeadTransition({ entries: {} }, candidate).class, 3)
})

test('F1: all fifteen fixed governance IDs and versioned IDs retain Class 3 despite caller labels', async () => {
  // Pinned exactly: the first eight and the seven that an earlier commit added. Every one of them is exercised by the loop below.
  assert.deepEqual(OWNER_GOVERNANCE_ORGANS, [
    'seed-receipts', 'seed-superagent', 'seed-pearl', 'seed-aura',
    'seed-predict', 'seed-recall', 'seed-memory', 'auma-body-map',
    'seed-judge', 'gate-judge', 'grant-ledger', 'aumlok-identity', 'aumlok-keys',
    'auma-scion', 'seed-boot',
  ])
  for (const organId of OWNER_GOVERNANCE_ORGANS) for (const entryId of [organId, `${organId}:${'e'.repeat(64)}`]) {
    const entry = { id: entryId, specifier: 'ball:' + 'a'.repeat(64), disabled: false, governance: false, config: { governance: false }, class: 1 }
    const previous = { entries: { [entryId]: entry } }
    const candidate = { ballId: 'c'.repeat(64), epoch: 163, entries: { [entryId]: { ...entry, specifier: 'ball:' + 'd'.repeat(64) } } }
    assert.deepEqual(classifyHeadTransition(null, candidate), { class: 3, entryIds: [entryId] })
    assert.deepEqual(classifyHeadTransition(previous, candidate), { class: 3, entryIds: [entryId] })
    assert.deepEqual(classifyHeadTransition(previous, { ...candidate, entries: {} }), { class: 3, entryIds: [entryId] })
    const binding = await headPromotionBinding({ audience: ORIGIN, ball: candidate, entryId, previous })
    assert.deepEqual(binding, { schema: 'aukora.class3.head-promotion.v1', audience: ORIGIN, action: 'head.promote', ballId: candidate.ballId, epoch: candidate.epoch, organId, candidateSha256: 'd'.repeat(64) })
  }
})

test('F1: dynamic governance declarations protect replacement, removal and declaration-only downgrades', async () => {
  for (const location of ['entry', 'config']) for (const entryId of ['fixture-governance', `fixture-governance:${'e'.repeat(64)}`]) {
    const entry = { id: entryId, specifier: 'ball:' + 'a'.repeat(64), disabled: false, config: {} }
    const declaration = value => location === 'entry' ? value : value.config
    declaration(entry).governance = true
    const previous = { entries: { [entryId]: entry } }
    const unchanged = { ballId: 'c'.repeat(64), epoch: 163, entries: structuredClone(previous.entries) }
    assert.equal(classifyHeadTransition(previous, unchanged).class, 1)
    assert.deepEqual(classifyHeadTransition(null, unchanged), { class: 3, entryIds: [entryId] })
    const ordinary = structuredClone(previous); declaration(ordinary.entries[entryId]).governance = false
    assert.deepEqual(classifyHeadTransition(ordinary, unchanged), { class: 3, entryIds: [entryId] })
    const conflicting = structuredClone(unchanged)
    ;(location === 'entry' ? conflicting.entries[entryId].config : conflicting.entries[entryId]).governance = false
    assert.deepEqual(classifyHeadTransition(ordinary, conflicting), { class: 3, entryIds: [entryId] })
    for (const mutate of [
      e => { e.specifier = 'ball:' + 'd'.repeat(64) }, e => { e.disabled = true }, e => { e.config.changed = true },
      e => { declaration(e).governance = false }, e => { delete declaration(e).governance }, e => { declaration(e).governance = null },
    ]) {
      const candidate = structuredClone(unchanged); mutate(candidate.entries[entryId])
      assert.deepEqual(classifyHeadTransition(previous, candidate), { class: 3, entryIds: [entryId] })
      const binding = await headPromotionBinding({ audience: ORIGIN, ball: candidate, entryId, previous })
      assert.equal(binding.organId, 'fixture-governance')
      assert.equal(binding.candidateSha256, candidate.entries[entryId].specifier.slice(5))
    }
    const removed = { ...unchanged, entries: {} }
    assert.deepEqual(classifyHeadTransition(previous, removed), { class: 3, entryIds: [entryId] })
    const removalBinding = await headPromotionBinding({ audience: ORIGIN, ball: removed, entryId, previous })
    assert.equal(removalBinding.candidateSha256, digest('null'))
    await assert.rejects(headPromotionBinding({ audience: ORIGIN, ball: removed, entryId }), { code: 'CLASS3_ACTION_INVALID' })
    const downgraded = structuredClone(unchanged); declaration(downgraded.entries[entryId]).governance = false
    await assert.rejects(headPromotionBinding({ audience: ORIGIN, ball: downgraded, entryId }), { code: 'CLASS3_ACTION_INVALID' })
  }
})

test('F1: malformed declarations fail closed; absent and false remain ordinary by policy', async () => {
  const base = { id: 'fixture', specifier: 'ball:' + 'a'.repeat(64), disabled: false, config: {} }
  const previous = { entries: { fixture: base } }
  for (const location of ['entry', 'config']) for (const value of [null, 'false', 0, [], {}]) {
    const entry = structuredClone(base); (location === 'entry' ? entry : entry.config).governance = value
    const candidate = { ballId: 'c'.repeat(64), epoch: 163, entries: { fixture: entry } }
    assert.deepEqual(classifyHeadTransition(previous, candidate), { class: 3, entryIds: ['fixture'] })
    assert.deepEqual(classifyHeadTransition(candidate, { ...candidate, entries: { fixture: base } }), { class: 3, entryIds: ['fixture'] })
    assert.equal((await headPromotionBinding({ audience: ORIGIN, ball: candidate, entryId: 'fixture' })).organId, 'fixture')
  }
  for (const entry of [base, { ...base, governance: false, config: { governance: false }, class: 3, previousVersions: [{ governance: true }] }]) {
    const candidate = { ballId: 'c'.repeat(64), epoch: 163, entries: { fixture: entry } }
    assert.deepEqual(classifyHeadTransition(null, candidate), { class: 1, entryIds: [] })
    await assert.rejects(headPromotionBinding({ audience: ORIGIN, ball: candidate, entryId: 'fixture' }), { code: 'CLASS3_ACTION_INVALID' })
  }
})

test('F1: non-ball governance bindings include declarations without changing the seven-field binding', async () => {
  const entry = { id: 'fixture', specifier: './fixture.js', disabled: false, config: {}, governance: true }
  const previous = { entries: { fixture: entry } }
  const candidate = { ballId: 'c'.repeat(64), epoch: 163, entries: { fixture: { ...entry, governance: false } } }
  const binding = await headPromotionBinding({ audience: ORIGIN, ball: candidate, entryId: 'fixture', previous })
  assert.equal(binding.candidateSha256, digest(canonicalJson({ specifier: entry.specifier, disabled: false, config: {}, governance: false })))
  assert.deepEqual(Object.keys(binding).sort(), ['schema', 'audience', 'action', 'ballId', 'epoch', 'organId', 'candidateSha256'].sort())
  assert.equal(binding.schema, 'aukora.class3.head-promotion.v1')
})

test('F1: removing an own constructor entry binds absence, never the inherited prototype function', async () => {
  const previous = { entries: { constructor: { id: 'constructor', specifier: './fixture.js', disabled: false, config: {}, governance: true } } }
  const candidate = { ballId: 'c'.repeat(64), epoch: 163, entries: {} }
  assert.deepEqual(classifyHeadTransition(previous, candidate), { class: 3, entryIds: ['constructor'] })
  const binding = await headPromotionBinding({ audience: ORIGIN, ball: candidate, entryId: 'constructor', previous })
  assert.equal(binding.candidateSha256, digest('null'))
  await assert.rejects(headPromotionBinding({ audience: ORIGIN, ball: candidate, entryId: 'constructor' }), { code: 'CLASS3_ACTION_INVALID' })
})

function superagentFixture(verifyApproval) {
  const files = new Map([['/dsh/home/balls/HEAD.json', JSON.stringify({ ballId: 'b'.repeat(64), epoch: 162 })]])
  const memoryFs = {
    existsSync: path => files.has(path), mkdirSync() {},
    readFileSync(path) { assert.ok(files.has(path), `Unexpected synthetic read: ${path}`); return files.get(path) },
    writeFileSync(path, value) { files.set(path, value) },
    renameSync(from, to) { files.set(to, files.get(from)); files.delete(from) },
  }
  let api
  const ctx = { provide() {}, set(_name, value) { api = value }, get: name => name === 'governance' ? { verifyApproval } : undefined, tools: { register() {} } }
  const source = readFileSync(new URL('../mirror/home/auma/seed/organs/seed-superagent.js', import.meta.url), 'utf8').replace(/^export /gm, '')
  runInNewContext(source + '\napply(ctx)', { ctx, Buffer, process: { getBuiltinModule: name => {
    if (name === 'node:fs') return memoryFs
    if (name === 'node:crypto') return { createHash }
    throw new Error('Unexpected synthetic module')
  } } }, { timeout: 1000 })
  return api
}

test('F1: superagent confirms fixed and dynamic IDs only through exact, live host approval', async () => {
  const expiresAt = Date.now() + 60000
  for (const organId of [...OWNER_GOVERNANCE_ORGANS, 'fixture-governance']) {
    const binding = { schema: 'aukora.class3.head-promotion.v1', audience: ORIGIN, action: 'head.promote', ballId: 'c'.repeat(64), epoch: 163, organId, candidateSha256: 'd'.repeat(64) }
    for (const mode of ['approved', 'denied', 'mismatch', 'expired']) {
      let calls = 0
      const api = superagentFixture(async expected => {
        calls++
        assert.equal(canonicalJson(expected), canonicalJson(binding))
        return { ok: mode !== 'denied', approvalId: 'fixture-approval', binding: mode === 'mismatch' ? { ...binding, epoch: 164 } : binding, expiresAt: mode === 'expired' ? 0 : expiresAt }
      })
      const mandate = api.eval_accept({ title: 'Synthetic promotion', scope: { organ: organId, candidateSha256: binding.candidateSha256, expiresAt } })
      const result = await api.confirm({ mandateId: mandate.mandateId, promotionBinding: binding })
      assert.equal(calls, 1)
      assert.equal(result.ok, mode === 'approved')
      assert.equal(result.confirmed, mode === 'approved')
      if (mode !== 'approved') assert.equal(result.error, 'CLASS3_WEBAUTHN_REQUIRED')
    }
  }
})

test('G2 / C3: approvals bind exact actions, last five minutes from approval, survive status and are single use', async () => {
  const fixture = custody(); await fixture.bind()
  const binding = await aumlokClass3Binding({ audience: ORIGIN, method: 'POST', pathname: '/_head/ball', body: { ballId: 'b'.repeat(64), epoch: 163 } })
  const challenge = await fixture.challenge({ purpose: 'approve', requestId: 'approve', binding })
  fixture.advance(90000)
  const approved = await fixture.complete('approve', { challengeId: challenge.challengeId, credential: fixture.assertion(challenge) })
  assert.equal(approved.ok, true)
  assert.equal(approved.expiresAt, NOW + 90000 + 300000)
  assert.equal((await fixture.store.status()).approvedGrants.length, 1)
  fixture.advance(60000)
  assert.equal((await fixture.store.verifyApproval(approved.approvalToken, binding, ORIGIN)).ok, true)
  await assert.rejects(fixture.store.verifyApproval(approved.approvalToken, { ...binding, requestDigest: 'd'.repeat(64) }, ORIGIN), { code: 'CLASS3_WEBAUTHN_REQUIRED' })
  assert.equal((await fixture.store.consumeApproval(approved.approvalToken, binding, ORIGIN, fixture.context())).ok, true)
  await assert.rejects(fixture.store.verifyApproval(approved.approvalToken, binding, ORIGIN), { code: 'CLASS3_WEBAUTHN_REQUIRED' })
})

test('G3 / Contract 2: outgoing key signs finite successor policy; v1 fallback stops at its explicit endpoint', async () => {
  const old = generateKeyPairSync('ed25519'), keys = hybridKeys(), receipts = [{ leafHash: 'a'.repeat(64), kind: 'fixture' }], rows = []
  for (let seq = 1; seq <= 15; seq++) {
    const body = { schema: 'aukora.edge-checkpoint.v1', seq, at: '2026-11-08T00:00:00.000Z', receiptCount: 1, lastReceiptHash: receipts[0].leafHash, merkleRoot: receipts[0].leafHash, prevCheckpointHash: rows.at(-1)?.checkpointHash ?? null }
    const row = { body, publicKeyHex: publicHex(old.publicKey), signatureHex: sign(null, Buffer.from('aukora.x5.edge-head.v1\0' + canonicalJson(body)), old.privateKey).toString('hex') }
    rows.push({ ...row, checkpointHash: digest(canonicalJson(row)) })
  }
  const pin = { schema: 'aukora.checkpoint-signer.v1', domain: 'aukora.x5.edge-head.v1', publicKeyHex: publicHex(old.publicKey), validToCheckpoint: 15 }
  assert.equal((await verifyFactCheckpoints(rows, receipts, () => {}, { checkpointSignerPin: pin })).checkpointSignerTrust, 'pinned')
  await assert.rejects(verifyFactCheckpoints(rows, receipts, () => {}, { checkpointSignerPin: { ...pin, validToCheckpoint: 14 } }))
  const successor = { validFromCheckpoint: 15, validToCheckpoint: 16, envelope: 'v2', publicKeyHex: keys.trustedKeys.ed25519PublicKeyHex, mlDsaPublicKeyHex: keys.trustedKeys.mlDsaPublicKeyHex }
  const policy = { schema: 'aukora.checkpoint-signer.v2', domain: 'aukora.hybrid.v2', ranges: [
    { validFromCheckpoint: 1, validToCheckpoint: 14, envelope: 'v1', publicKeyHex: publicHex(old.publicKey) },
    { ...successor, countersignatureHex: sign(null, Buffer.from('aukora.checkpoint-signer-bridge.v2\0' + canonicalJson(successor)), old.privateKey).toString('hex') },
  ] }
  assert.equal((await verifyCheckpointSignerPolicy(policy)).status, 'configured')
  const signed = keys.envelope('checkpoint', rows[14].body)
  const hybridRow = { envelope: signed, checkpointHash: digest(canonicalJson(signed)) }
  assert.equal((await verifyFactCheckpoints([...rows.slice(0, 14), hybridRow], receipts, () => {}, { checkpointSignerPolicy: policy })).checkpointSignerTrust, 'pinned')
  await assert.rejects(verifyFactCheckpoints(rows, receipts, () => {}, { checkpointSignerPolicy: policy }))
  for (const mutate of [p => { p.ranges[1].validToCheckpoint++ }, p => { delete p.ranges[1].countersignatureHex }, p => { p.ranges[1].countersignatureHex = '0'.repeat(128) }, p => { p.ranges[1].validFromCheckpoint++ }]) {
    const value = structuredClone(policy); mutate(value)
    assert.equal((await verifyCheckpointSignerPolicy(value)).status, 'invalid')
  }
})

function broker(pathname, input, { env = {}, ...options } = {}, signal) {
  return handleCloudBroker(new Request(ORIGIN + pathname, { method: 'POST', headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' }, body: JSON.stringify(input), signal }), env, {
    networkFetch: () => { throw new Error('Ambient network forbidden') }, ...options,
  })
}

const publicationRequest = (action = 'write') => ({ action, path: 'mirror/home/auma/seed/organs/fixture.js', content: 'export default 1',
  changes: [{ path: 'mirror/home/auma/seed/organs/fixture.js', content: 'export default 1' }],
  expectedHeadSha: 'a'.repeat(40), idempotencyKey: 'fixture-publication-0001', message: 'Publish synthetic source' })
const brokerEnvironment = { GITHUB_TOKEN: 'synthetic-broker-test-credential' }

function publicationReadFixture(url) {
  const prefix = 'https://api.github.com/repos/your_org_x/your-node', sha = 'a'.repeat(40), treeSha = 'c'.repeat(40)
  if (url === prefix + '/commits?sha=main&per_page=10') return Response.json([{ sha, commit: { message: 'Synthetic base' } }])
  if (url === prefix + '/commits/' + sha) return Response.json({ sha, commit: { tree: { sha: treeSha } } })
  assert.equal(url, prefix + '/git/trees/' + treeSha + '?recursive=1')
  const path = publicationRequest().path, parts = path.split('/')
  const tree = parts.slice(0, -1).map((_part, index) => ({ path: parts.slice(0, index + 1).join('/'), mode: '040000', type: 'tree', sha: treeSha }))
  tree.push({ path, mode: '100644', type: 'blob', sha: 'd'.repeat(40) })
  return Response.json({ sha: treeSha, truncated: false, tree })
}

test('C3 / H1: same-origin broker mutation flags cannot replace Class 3 approval', async () => {
  let networkCalls = 0
  for (const [route, input, status, code] of [
    ['repo', publicationRequest(), 403, 'CLASS3_WEBAUTHN_REQUIRED'],
    ['github', { action: 'api', method: 'POST' }, 403, 'GITHUB_ENDPOINT_REFUSED'],
    ['cloudflare', { action: 'deploy' }, 400, 'CLOUDFLARE_ACTION_UNAVAILABLE'],
  ]) {
    const response = await broker('/_host/' + route, { ...input, approved: true, class3Approved: true }, {
      env: brokerEnvironment, networkFetch: () => { networkCalls++; throw new Error('External network forbidden') },
    })
    assert.equal(response.status, status); assert.equal((await response.json()).code, code)
  }
  assert.equal(networkCalls, 0)
  const status = await broker('/_host/cloudflare', { action: 'status' })
  assert.equal(status.status, 200)
})

test('Round 25: refused repository preflight leaves real one-shot passkey approvals unconsumed', async () => {
  for (const [input, options, code] of [
    [{ ...publicationRequest(), path: 'mirror/home/auma/memory/private.md' }, {}, 'REPO_PATH_REFUSED'],
    [{ ...publicationRequest(), content: '-----BEGIN PRIVATE KEY-----' }, {}, 'BROKER_PRIVATE_CONTENT_REFUSED'],
    [publicationRequest(), { approveRepoPublication: null }, 'OWNER_APPROVAL_REQUIRED'],
    [publicationRequest(), { env: {} }, 'GITHUB_BROKER_TOKEN_UNCONFIGURED'],
  ]) {
    const fixture = custody(); await fixture.bind()
    const binding = await aumlokClass3Binding({ audience: ORIGIN, method: 'POST', pathname: '/_host/repo', body: input })
    const challenge = await fixture.challenge({ purpose: 'approve', requestId: crypto.randomUUID(), binding })
    const approved = await fixture.complete('approve', { challengeId: challenge.challengeId, credential: fixture.assertion(challenge) })
    let consumed = 0
    const response = await broker('/_host/repo', input, { env: brokerEnvironment, now: () => NOW,
      authorizeClass3: async received => {
        consumed++
        const expected = await aumlokClass3Binding({ audience: ORIGIN, method: 'POST', pathname: '/_host/repo', body: received })
        return fixture.store.consumeApproval(approved.approvalToken, expected, ORIGIN)
      }, ...options,
    })
    assert.equal((await response.json()).code, code)
    assert.equal(consumed, 0)
    assert.equal((await fixture.store.verifyApproval(approved.approvalToken, binding, ORIGIN)).ok, true)
  }
})

test('Round 25: a consumed result must bind the exact operation, path, bytes, route and audience', async () => {
  const original = publicationRequest()
  const binding = await aumlokClass3Binding({ audience: ORIGIN, method: 'POST', pathname: '/_host/repo', body: original })
  for (const [input, approval] of [
    [original, { ok: true }],
    [original, { ok: true, binding: { ...binding, pathname: '/different' }, expiresAt: NOW + 10000 }],
    [original, { ok: true, binding: { ...binding, audience: 'https://another.example.invalid' }, expiresAt: NOW + 10000 }],
    [original, { ok: true, binding: { ...binding, method: 'PUT' }, expiresAt: NOW + 10000 }],
    [original, { ok: true, binding, expiresAt: NOW }],
    ...[{ action: 'commit' }, { path: 'mirror/home/auma/seed/organs/other.js' }, { content: 'export default 2' },
      { message: 'Different publication' }, { expectedHeadSha: 'c'.repeat(40) }, { idempotencyKey: 'different-request-0001' },
      { consumedApproval: { ok: true, binding, expiresAt: NOW + 10000 }, approved: true }]
      .map(change => [{ ...original, ...change }, { ok: true, binding, expiresAt: NOW + 10000 }]),
  ]) {
    let publicationApprovals = 0, networkCalls = 0
    const response = await broker('/_host/repo', input, { env: brokerEnvironment, now: () => NOW,
      authorizeClass3: async () => approval,
      approveRepoPublication: async terms => { publicationApprovals++; return { approved: true, canonical: terms.canonical } },
      networkFetch: async () => { networkCalls++; throw new Error('Mutation must not reach network') },
    })
    assert.equal((await response.json()).code, 'CLASS3_WEBAUTHN_REQUIRED')
    assert.equal(publicationApprovals, 0)
    assert.equal(networkCalls, 0)
  }
})

test('Round 25: default publication approval consumes real passkey proof but never selects or executes HEAD', async () => {
  const fixture = custody(); await fixture.bind()
  const input = publicationRequest(), binding = await aumlokClass3Binding({ audience: ORIGIN, method: 'POST', pathname: '/_host/repo', body: input })
  const challenge = await fixture.challenge({ purpose: 'approve', requestId: 'repo-default-approval', binding })
  const approved = await fixture.complete('approve', { challengeId: challenge.challengeId, credential: fixture.assertion(challenge) })
  let writes = 0
  const options = { env: brokerEnvironment, now: () => NOW,
    authorizeClass3: async received => fixture.store.consumeApproval(approved.approvalToken,
      await aumlokClass3Binding({ audience: ORIGIN, method: 'POST', pathname: '/_host/repo', body: received }), ORIGIN),
    networkFetch: async (url, init) => {
      if (init.method === 'GET') return publicationReadFixture(url)
      assert.equal(url, 'https://api.github.com/graphql')
      const mutation = JSON.parse(init.body).variables.input
      assert.deepEqual(mutation.fileChanges.additions, [{ path: input.path, contents: Buffer.from(input.content).toString('base64') }])
      assert.equal(mutation.expectedHeadOid, input.expectedHeadSha)
      writes++; return Response.json({ data: { createCommitOnBranch: { commit: { oid: 'b'.repeat(40) } } } })
    },
  }
  const result = await (await broker('/_host/repo', input, options)).json()
  assert.equal(result.ok, true)
  assert.equal(result.mode, 'atomic-main-publication')
  await assert.rejects(fixture.store.verifyApproval(approved.approvalToken, binding, ORIGIN))
  assert.equal((await (await broker('/_host/repo', input, options)).json()).ok, false)
  assert.equal(writes, 1)
})

test('Round 25: expiry during repository reconciliation prevents a later GitHub mutation', async () => {
  for (const expireAtRead of [1, 3]) {
    let at = NOW, reads = 0, writes = 0
    const input = publicationRequest()
    const binding = await aumlokClass3Binding({ audience: ORIGIN, method: 'POST', pathname: '/_host/repo', body: input })
    const response = await broker('/_host/repo', input, { env: brokerEnvironment, now: () => at,
      authorizeClass3: async () => ({ ok: true, binding, expiresAt: NOW + 1000 }),
      networkFetch: async (url, init) => {
        if (init.method !== 'GET') { writes++; throw new Error('Expired approval cannot publish') }
        if (++reads === expireAtRead) at += 1000
        return publicationReadFixture(url)
      },
    })
    assert.equal((await response.json()).code, 'CLASS3_APPROVAL_EXPIRED')
    assert.equal(reads, 3)
    assert.equal(writes, 0)
  }
})

test('H1: request and token reservations are atomic, persistent and never reset on clock rollback', async () => {
  const memory = storage(), limits = providerBudgetLimits({ PROVIDER_BUDGET_WINDOW_MS: '60000', PROVIDER_BUDGET_REQUESTS: '2', PROVIDER_BUDGET_TOKENS: '10000', PROVIDER_MAX_OUTPUT_TOKENS: '128' })
  const input = { model: 'fixture', messages: [{ role: 'user', content: 'Synthetic' }], max_tokens: 20 }
  const reservation = providerRequestReservation(Buffer.from(JSON.stringify(input)), limits, '/v1/chat/completions')
  const results = await Promise.allSettled(Array.from({ length: 3 }, () => reserveProviderBudget(memory, { provider: 'openai', tokens: reservation.tokens }, limits, NOW)))
  assert.equal(results.filter(value => value.status === 'fulfilled').length, 2)
  assert.equal(results.find(value => value.status === 'rejected').reason.code, 'PROVIDER_BUDGET_EXHAUSTED')
  await assert.rejects(reserveProviderBudget(memory, { provider: 'openai', tokens: 0 }, limits, NOW - 1), { code: 'PROVIDER_BUDGET_EXHAUSTED' })
  assert.throws(() => providerRequestReservation(Buffer.from(JSON.stringify({ ...input, max_tokens: 129 })), limits, '/v1/chat/completions'))
  assert.equal((await reserveProviderBudget(memory, { provider: 'openai', tokens: 0 }, limits, NOW + 60000)).ok, true)
})

test('C2: direct ball_put qualification consumption remains covered by scion-growth.spec.ts', { todo: 'This standalone Node suite does not instantiate the worker VFS/qualification lifecycle; run the runtime behavioral suite separately.' }, () => {})
test('H2 / H3: distinct definitions are absent from the supplied briefs', { todo: 'An authoritative mapping is needed before labeling either finding closed.' }, () => {})

function syntheticHttps({ chunks = [Buffer.from('public fixture')], status = 200, headers = { 'content-type': 'text/plain' }, inspect = () => {}, stalled = false } = {}) {
  const calls = [], requests = [], responses = []
  const request = (options, onResponse) => {
    calls.push(options); inspect(options)
    const req = new EventEmitter(); req.destroyed = false
    req.destroy = () => { req.destroyed = true }
    req.end = () => queueMicrotask(() => {
      if (req.destroyed) return
      const response = stalled ? new Readable({ read() {} }) : Readable.from(chunks)
      response.statusCode = status; response.headers = headers; responses.push(response); onResponse(response)
    })
    requests.push(req)
    return req
  }
  return { request, calls, requests, responses }
}

test('web-eyes refuses URL aliases, private names, credentials and all literal IPv4/IPv6 forms before DNS', async () => {
  const targets = ['http://example.com/', 'https://127.0.0.1/', 'https://2130706433/', 'https://0177.0.0.1/', 'https://0x7f000001/', 'https://[::1]/', 'https://[::ffff:127.0.0.1]/', 'https://169.254.169.254/', 'https://node.local/', 'https://node.internal/', 'https://user:pass@example.com/', 'https://example.com:444/', 'https://example.com/#fragment']
  for (const url of targets) assert.throws(() => publicHttpsTarget(url), { code: 'WEB_EYES_URL_REFUSED' }, url)
  assert.equal(publicHttpsTarget('https://EXAMPLE.com./a').href, 'https://example.com/a')
  const response = await broker('/_host/web-eyes', { action: 'fetch', url: 'https://example.com/' })
  assert.equal(response.status, 503); assert.equal((await response.json()).code, 'PUBLIC_NETWORK_GUARD_UNAVAILABLE')
})

test('web-eyes pins one public A record without re-resolving and checks original TLS hostname', async () => {
  let lookups = 0
  const synthetic = syntheticHttps({ inspect: options => {
    assert.equal(options.hostname, '93.184.216.34'); assert.equal(options.servername, 'example.com')
    assert.equal(options.headers.host, 'example.com'); assert.equal(options.agent, false); assert.equal(options.rejectUnauthorized, true)
    assert.equal(options.headers.authorization, undefined); assert.equal(options.headers.cookie, undefined)
    assert.equal(options.checkServerIdentity('93.184.216.34', { subjectaltname: 'DNS:example.com' }), undefined)
    assert.equal(options.checkServerIdentity('example.com', { subjectaltname: 'DNS:wrong.example.com' }).code, 'ERR_TLS_CERT_ALTNAME_INVALID')
    options.lookup('example.com', {}, error => assert.equal(error.code, 'WEB_EYES_SECOND_LOOKUP_REFUSED'))
  } })
  const transport = createPublicHttpsTransport({ request: synthetic.request, lookup: async (_host, options) => {
    assert.equal(options.family, 4); lookups++
    return [{ address: lookups === 1 ? '93.184.216.34' : '127.0.0.1', family: 4 }]
  } })
  const response = await broker('/_host/web-eyes', { action: 'fetch', url: 'https://example.com/' }, { publicHttpsFetch: transport })
  assert.equal(response.status, 200); assert.equal((await response.json()).content, 'public fixture')
  assert.equal(lookups, 1); assert.equal(synthetic.calls.length, 1)
})

test('web-eyes rejects every nonpublic A record, mixed DNS responses and unsupported IPv6 answers', async () => {
  const denied = ['0.1.2.3', '10.0.0.1', '100.64.0.1', '127.0.0.1', '169.254.169.254', '172.31.1.1', '192.0.0.8', '192.0.2.1', '192.88.99.1', '192.168.0.1', '198.18.0.1', '198.51.100.1', '203.0.113.1', '224.0.0.1', '240.0.0.1', '255.255.255.255']
  for (const address of denied) {
    const transport = createPublicHttpsTransport({ request: () => assert.fail('No socket may open'), lookup: async () => [{ address: '93.184.216.34', family: 4 }, { address, family: 4 }] })
    await assert.rejects(transport('https://example.com/'), { code: 'WEB_EYES_ADDRESS_REFUSED' })
  }
  for (const addresses of [[], [{ address: '2606:4700::1111', family: 6 }], [{ address: '::ffff:127.0.0.1', family: 6 }]]) {
    await assert.rejects(createPublicHttpsTransport({ request: () => assert.fail(), lookup: async () => addresses })('https://example.com/'), { code: 'WEB_EYES_ADDRESS_REFUSED' })
  }
})

test('web-eyes rejects redirects and body overflows while closing the request', async () => {
  for (const options of [{ status: 302 }, { chunks: [Buffer.alloc(CLOUD_BROKER_LIMITS.responseBytes), Buffer.from('x')] }, { headers: { 'content-length': String(CLOUD_BROKER_LIMITS.responseBytes + 1) } }]) {
    const synthetic = syntheticHttps(options)
    const transport = createPublicHttpsTransport({ request: synthetic.request, lookup: async () => [{ address: '93.184.216.34', family: 4 }] })
    await assert.rejects(transport('https://example.com/'), { code: options.status ? 'WEB_EYES_REDIRECT_REFUSED' : 'WEB_EYES_BODY_TOO_LARGE' })
    assert.equal(synthetic.requests[0].destroyed, true)
  }
  const boundary = syntheticHttps({ chunks: [Buffer.alloc(CLOUD_BROKER_LIMITS.responseBytes, 120)] })
  const transport = createPublicHttpsTransport({ request: boundary.request, lookup: async () => [{ address: '93.184.216.34', family: 4 }] })
  assert.equal((await (await transport('https://example.com/')).arrayBuffer()).byteLength, CLOUD_BROKER_LIMITS.responseBytes)
})

test('web-eyes deadline includes DNS and slow body; cancellation prevents a late socket', async () => {
  let resolveLookup, calls = 0
  const controller = new AbortController()
  const transport = createPublicHttpsTransport({ lookup: () => new Promise(resolve => { resolveLookup = resolve }), request: () => { calls++; assert.fail('Late DNS cannot start a request') } })
  const pending = transport('https://example.com/', { signal: controller.signal })
  await Promise.resolve(); controller.abort()
  await assert.rejects(pending, { code: 'WEB_EYES_TIMEOUT' })
  resolveLookup([{ address: '93.184.216.34', family: 4 }]); await Promise.resolve(); assert.equal(calls, 0)
  await assert.rejects(createPublicHttpsTransport({ lookup: () => new Promise(() => {}), timeoutMs: 5 })('https://example.com/'), { code: 'WEB_EYES_TIMEOUT' })
  const stalled = syntheticHttps({ stalled: true })
  await assert.rejects(createPublicHttpsTransport({ lookup: async () => [{ address: '93.184.216.34', family: 4 }], request: stalled.request, timeoutMs: 5 })('https://example.com/'), { code: 'WEB_EYES_TIMEOUT' })
  assert.equal(stalled.requests[0].destroyed, true); assert.equal(stalled.responses[0].destroyed, true)
})

test('web-eyes monotonic deadline wins when DNS, headers or end arrive before a delayed timer callback', async () => {
  let elapsed = 0
  const dnsDelayed = createPublicHttpsTransport({ now: () => elapsed,
    lookup: async () => { elapsed = 10000; return [{ address: '93.184.216.34', family: 4 }] },
    request: () => assert.fail('Expired DNS must not launch a socket'),
  })
  await assert.rejects(dnsDelayed('https://example.com/'), { code: 'WEB_EYES_TIMEOUT' })
  for (const stage of ['headers', 'end']) {
    elapsed = 0
    const chunks = (async function* () { yield Buffer.from('early'); if (stage === 'end') elapsed = 10000 })()
    const synthetic = syntheticHttps({ chunks, inspect: () => { if (stage === 'headers') elapsed = 10000 } })
    const transport = createPublicHttpsTransport({ now: () => elapsed, request: synthetic.request,
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    })
    await assert.rejects(transport('https://example.com/'), { code: 'WEB_EYES_TIMEOUT' }, stage)
    assert.equal(synthetic.requests[0].destroyed, true)
    assert.equal(synthetic.responses[0].destroyed, true)
  }
})

test('web-eyes refuses binary, compressed and malformed UTF-8 content', async () => {
  for (const response of [new Response('binary', { headers: { 'content-type': 'application/octet-stream' } }), new Response('compressed', { headers: { 'content-type': 'text/plain', 'content-encoding': 'gzip' } }), new Response(Uint8Array.of(0xff), { headers: { 'content-type': 'text/plain' } })]) {
    const result = await broker('/_host/web-eyes', { action: 'fetch', url: 'https://example.com/' }, { publicHttpsFetch: async () => response })
    assert.equal(result.status, 502)
  }
})

test('Round 25: digest-matching malformed gate JSON refuses projection without changing stored evidence', async t => {
  const temporary = await fsp.mkdtemp(path.join(await fsp.realpath(os.tmpdir()), 'x61-gate-contract-'))
  t.after(() => fsp.rm(temporary, { recursive: true, force: true }))
  const repository = path.join(temporary, 'repository'), directory = path.join(temporary, 'audit')
  await fsp.mkdir(repository, { mode: 0o700 })
  await fsp.mkdir(directory, { mode: 0o700 })
  const bytes = Buffer.from('{"gateId":'), recordFile = path.join(directory, digest(bytes) + '.json')
  const projectionFile = path.join(directory, 'gates.json'), previous = Buffer.from('{"schema":"aukora.gates.v1","gates":[]}\n')
  await fsp.writeFile(recordFile, bytes, { mode: 0o600 })
  await fsp.writeFile(projectionFile, previous, { mode: 0o600 })
  const before = await fsp.stat(projectionFile)
  const audit = createGateAudit({ repository, directory })
  await assert.rejects(audit.project({ sourceCommit: 'a'.repeat(40) }), { code: 'GATE_RECORD_MALFORMED' })
  assert.deepEqual(await fsp.readFile(recordFile), bytes)
  assert.deepEqual(await fsp.readFile(projectionFile), previous)
  assert.deepEqual((await fsp.readdir(directory)).sort(), [path.basename(recordFile), 'gates.json'].sort())
  const after = await fsp.stat(projectionFile)
  assert.equal(after.ino, before.ino)
  assert.equal(after.mtimeMs, before.mtimeMs)
})
