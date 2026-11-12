/** Synthetic keys and in-memory organ files only; source reads never access live state or services. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { canonicalJson } from '../deploy/cloudflare/src/owner-grant-policy.mjs'
import { parseCheckpointSignerPin, parseCheckpointSignerPolicy, verifyCheckpointSignerPolicy, projectBuildInfo, projectSourceMetadata, projectAumlokStatus, verifyFactInvites, verifyFactCheckpoints, projectVerifiedFacts } from './verified-facts.mjs'
import { aumlokInvitePreimage, createAumlokStore, AUMLOK_STORAGE_KEY } from '../deploy/cloudflare/src/aumlok.mjs'
import { X61HeadDurableObject, manifestId } from '../deploy/cloudflare/src/head-do.mjs'
import { auraInputsComplete, computeAura, predictionError, staleHeartbeatFacts, validateAuraVector } from './aura-rules.mjs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import * as nodeCrypto from 'node:crypto'
import { ml_dsa65 } from '@noble/post-quantum/ml-dsa.js'
import { readLocalAuraInputs } from './messages-store.mjs'
import { loadOrganUnderTest } from './fixtures/organs/pinned.mjs'
import { assertLiveOrganShape } from './fixtures/organs/live-shape.mjs'

const hex = value => Buffer.from(value).toString('hex')
const digest = async value => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))
async function checkpoint(receipts, previous = null, key = null) {
  key ??= await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])
  const body = { schema: 'aukora.edge-checkpoint.v1', seq: previous ? previous.body.seq + 1 : 1, at: '2026-11-08T00:00:00.000Z', receiptCount: 1,
    lastReceiptHash: receipts[0].leafHash, merkleRoot: receipts[0].leafHash, prevCheckpointHash: previous?.checkpointHash ?? null }
  const publicKeyHex = hex(await crypto.subtle.exportKey('raw', key.publicKey))
  const signatureHex = hex(await crypto.subtle.sign('Ed25519', key.privateKey, new TextEncoder().encode('aukora.x5.edge-head.v1\0' + canonicalJson(body))))
  return { body, publicKeyHex, signatureHex, checkpointHash: await digest(canonicalJson({ body, publicKeyHex, signatureHex })) }
}

async function countersignCheckpointRange(range, key, domain = 'aukora.checkpoint-signer-bridge.v2\0') {
  const { countersignatureHex: _previous, ...entry } = range
  range.countersignatureHex = hex(await crypto.subtle.sign('Ed25519', key.privateKey,
    new TextEncoder().encode(domain + canonicalJson(entry))))
  return range
}

test('checkpoint facts verify signatures and receipt coverage without trusting the signer', async () => {
  const receipts = [{ leafHash: 'a'.repeat(64), kind: 'memory.dag.append' }]
  const row = await checkpoint(receipts)
  const facts = await verifyFactCheckpoints([row], receipts)
  assert.equal(facts.lastCheckpointReceiptCount, 1)
  assert.equal(facts.checkpointSignerTrust, 'unpinned')
  assert.equal(facts.ownerApproval, false)
  assert.deepEqual(facts.receiptsByKind, { 'memory.dag.append': 1 })
  assert.equal(JSON.stringify(facts).includes(row.signatureHex), false)
  for (const change of [r => { r.body.receiptCount = 2 }, r => { r.body.merkleRoot = 'b'.repeat(64) },
    r => { r.signatureHex = '0'.repeat(128) }, r => { r.checkpointHash = '0'.repeat(64) },
    r => { r.body.prevCheckpointHash = '0'.repeat(64) }, r => { r.body.seq = 2 }]) {
    const corrupt = structuredClone(row); change(corrupt)
    await assert.rejects(verifyFactCheckpoints([corrupt], receipts))
  }
  await assert.rejects(verifyFactCheckpoints(Array(257).fill(row), receipts))
  await assert.rejects(verifyFactCheckpoints([row], receipts, () => { throw new Error('cancelled') }), /cancelled/)
  assert.deepEqual(await verifyFactCheckpoints([], receipts), { ...facts, checkpointsTotal: 0, lastCheckpointSeq: null, lastCheckpointReceiptCount: null })
})

test('checkpoint pins parse only bounded public configuration with the checkpoint signing domain', () => {
  const pin = { schema: 'aukora.checkpoint-signer.v1', domain: 'aukora.x5.edge-head.v1', publicKeyHex: 'a'.repeat(64) }
  assert.deepEqual(parseCheckpointSignerPin(undefined), { status: 'absent' })
  for (const value of [pin, JSON.stringify(pin)]) assert.deepEqual(parseCheckpointSignerPin(value), { status: 'configured', publicKeyHex: pin.publicKeyHex })
  for (const value of [null, [], {}, '', '{', ' '.repeat(4097), { ...pin, domain: 'aukora.other.v1' },
    { ...pin, schema: 'aukora.checkpoint-signer.v2' }, { ...pin, publicKeyHex: 'A'.repeat(64) },
    { ...pin, publicKeyHex: 'a'.repeat(62) }, { ...pin, secret: 'NEVER_EMIT_PRIVATE_KEY' }]) {
    assert.deepEqual(parseCheckpointSignerPin(value), { status: 'invalid' })
  }
})

test('only an independently supplied pin matching every verified signer reports pinned', async () => {
  const receipts = [{ leafHash: 'a'.repeat(64), kind: 'memory.dag.append' }]
  const key = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])
  const first = await checkpoint(receipts, null, key), second = await checkpoint(receipts, first, key)
  const pin = { schema: 'aukora.checkpoint-signer.v1', domain: 'aukora.x5.edge-head.v1', publicKeyHex: first.publicKeyHex }
  const read = (rows, checkpointSignerPin = pin) => verifyFactCheckpoints(rows, receipts, () => {}, { checkpointSignerPin })
  assert.equal((await read([first, second])).checkpointSignerTrust, 'pinned')
  assert.equal((await read([first, second], { ...pin, publicKeyHex: 'b'.repeat(64) })).checkpointSignerTrust, 'mismatch')
  assert.equal((await read([first, second], { ...pin, domain: 'unrelated' })).checkpointSignerTrust, 'invalid-pin')
  assert.equal((await read([])).checkpointSignerTrust, 'unpinned')
  const rotated = await checkpoint(receipts, first)
  assert.equal((await read([first, rotated])).checkpointSignerTrust, 'mismatch')
  assert.equal((await read([first, rotated], { ...pin, publicKeyHex: rotated.publicKeyHex })).checkpointSignerTrust, 'mismatch')
  const invalid = { ...first, signatureHex: '0'.repeat(128) }
  await assert.rejects(read([invalid]), /AURA_CHECKPOINT_INVALID/)
  const facts = await read([first])
  assert.equal(facts.ownerApproval, false)
  assert.equal(facts.independentAudit, false)
  assert.equal(JSON.stringify(facts).includes(pin.publicKeyHex), false)
})

test('rotation policy rejects gaps, overlaps, unbounded windows and conflicting trust inputs', async () => {
  const receipts = [{ leafHash: 'a'.repeat(64), kind: 'memory.dag.append' }]
  const oldKey = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])
  const newKey = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])
  const first = await checkpoint(receipts, null, oldKey)
  const second = await checkpoint(receipts, first, newKey)
  const third = await checkpoint(receipts, second, newKey)
  const policy = { schema: 'aukora.checkpoint-signer-policy.v1', domain: 'aukora.x5.edge-head.v1', ranges: [
    { firstSeq: 1, lastSeq: 1, publicKeyHex: first.publicKeyHex },
    { firstSeq: 2, lastSeq: 3, publicKeyHex: second.publicKeyHex },
  ] }
  assert.deepEqual(parseCheckpointSignerPolicy(undefined), { status: 'absent' })
  for (const value of [policy, JSON.stringify(policy)]) assert.deepEqual(parseCheckpointSignerPolicy(value), { status: 'configured', ranges: policy.ranges })
  for (const mutate of [p => { p.ranges[0].firstSeq = 2 }, p => { p.ranges[1].firstSeq = 3 },
    p => { p.ranges[1].firstSeq = 1 }, p => { p.ranges[1].lastSeq = null }, p => { p.ranges[1].lastSeq = Infinity },
    p => { p.ranges[1].lastSeq = 1 }, p => { p.ranges[1].publicKeyHex = 'F'.repeat(64) },
    p => { p.ranges[1].privateKey = 'SYNTHETIC_PRIVATE' }, p => { p.ranges = [] }, p => { p.ranges = Array(257).fill(p.ranges[0]) },
    p => { p.domain = 'unrelated' }, p => { p.schema = 'aukora.checkpoint-signer.v1' }, p => { p.ownerApproval = true }]) {
    const invalid = structuredClone(policy); mutate(invalid)
    assert.deepEqual(parseCheckpointSignerPolicy(invalid), { status: 'invalid' })
  }
  for (const invalid of [null, [], '{', ' '.repeat(65537)]) assert.deepEqual(parseCheckpointSignerPolicy(invalid), { status: 'invalid' })
  const read = (rows, checkpointSignerPolicy = policy, extra = {}) => verifyFactCheckpoints(rows, receipts, () => {}, { checkpointSignerPolicy, ...extra })
  const facts = await read([first, second, third])
  assert.equal(facts.checkpointSignerTrust, 'pinned')
  assert.equal(facts.ownerApproval, false)
  assert.equal(facts.independentAudit, false)
  assert.equal(JSON.stringify(facts).includes(first.publicKeyHex), false)
  assert.equal((await read([])).checkpointSignerTrust, 'unpinned')
  assert.equal((await read([first, second, third], { ...policy, ranges: policy.ranges.slice(0, 1) })).checkpointSignerTrust, 'mismatch')
  const wrongRangeKey = structuredClone(policy); wrongRangeKey.ranges[1].publicKeyHex = first.publicKeyHex
  assert.equal((await read([first, second], wrongRangeKey)).checkpointSignerTrust, 'mismatch')
  const fourth = await checkpoint(receipts, third, newKey)
  assert.equal((await read([first, second, third, fourth])).checkpointSignerTrust, 'mismatch')
  assert.equal((await verifyFactCheckpoints([first, second], receipts)).checkpointSignerTrust, 'unpinned')
  const pin = { schema: 'aukora.checkpoint-signer.v1', domain: 'aukora.x5.edge-head.v1', publicKeyHex: first.publicKeyHex }
  assert.equal((await read([first], policy, { checkpointSignerPin: pin })).checkpointSignerTrust, 'invalid-pin')
  assert.equal((await read([first], {})).checkpointSignerTrust, 'invalid-pin')
  const tampered = structuredClone(second); tampered.signatureHex = '0'.repeat(128)
  await assert.rejects(read([first, tampered]), /AURA_CHECKPOINT_INVALID/)
  const laterOldKey = await checkpoint(receipts, second, oldKey)
  assert.equal((await read([first, second, laterOldKey])).checkpointSignerTrust, 'mismatch')
})

test('independent v2 key windows retain checkpoints 1–14 and require both signatures at checkpoint 15', async () => {
  const receipts = [{ leafHash: 'a'.repeat(64), kind: 'memory.dag.append' }]
  const oldKey = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])
  const newKey = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])
  const pq = ml_dsa65.keygen(new Uint8Array(32).fill(22))
  const rows = []
  for (let seq = 1; seq <= 14; seq++) rows.push(await checkpoint(receipts, rows.at(-1), seq === 1 ? oldKey : newKey))
  const ed25519PublicKeyHex = hex(await crypto.subtle.exportKey('raw', newKey.publicKey))
  const mlDsaPublicKeyHex = hex(pq.publicKey)
  const keyId = value => nodeCrypto.createHash('sha256').update(Buffer.from(value, 'hex')).digest('hex').slice(0, 12)
  const body = { ...rows.at(-1).body, seq: 15, prevCheckpointHash: rows.at(-1).checkpointHash }
  const envelope = { schema: 'aukora.hybrid-envelope.v2', artifact: 'checkpoint', payload: body,
    algManifest: { classical: { alg: 'Ed25519', keyId: keyId(ed25519PublicKeyHex) }, pq: { alg: 'ML-DSA-65', keyId: keyId(mlDsaPublicKeyHex) } } }
  const preimage = new TextEncoder().encode('aukora.hybrid.v2\0' + canonicalJson(envelope))
  envelope.signatures = { ed25519SigHex: hex(await crypto.subtle.sign('Ed25519', newKey.privateKey, preimage)),
    mlDsaSigHex: hex(ml_dsa65.sign(preimage, pq.secretKey, { context: new TextEncoder().encode('aukora.v2') })) }
  const latest = { envelope, checkpointHash: await digest(canonicalJson(envelope)) }
  const policy = { schema: 'aukora.checkpoint-signer.v2', domain: 'aukora.hybrid.v2', ranges: [
    { validFromCheckpoint: 1, validToCheckpoint: 1, envelope: 'v1', publicKeyHex: rows[0].publicKeyHex },
    { validFromCheckpoint: 2, validToCheckpoint: 14, envelope: 'v1', publicKeyHex: ed25519PublicKeyHex },
    { validFromCheckpoint: 15, validToCheckpoint: 16, envelope: 'v2', publicKeyHex: ed25519PublicKeyHex, mlDsaPublicKeyHex },
  ] }
  await countersignCheckpointRange(policy.ranges[2], newKey)
  const read = (input, supplied = policy) => verifyFactCheckpoints(input, receipts, () => {}, { checkpointSignerPolicy: supplied })
  assert.equal(parseCheckpointSignerPolicy(JSON.stringify(policy)).status, 'configured')
  assert.equal((await read([...rows, latest])).checkpointSignerTrust, 'pinned')
  assert.equal((await read([...rows, latest])).lastCheckpointSeq, 15)
  assert.equal((await read([...rows, latest])).ownerApproval, false)
  for (const mutate of [p => { p.ranges[1].validToCheckpoint = 15 }, p => { p.ranges[2].validFromCheckpoint = 14 },
    p => { p.ranges[2].validToCheckpoint = null }, p => { delete p.ranges[2].mlDsaPublicKeyHex },
    p => { p.ranges[2].mlDsaPublicKeyHex = '0'.repeat(3903) }, p => { p.ranges[2].envelope = 'v1' },
    p => { p.ranges[2].ownerApproval = true }, p => { delete p.ranges[2].countersignatureHex },
    p => { p.ranges[2].countersignatureHex = 'f'.repeat(127) }]) {
    const invalid = structuredClone(policy); mutate(invalid)
    assert.equal(parseCheckpointSignerPolicy(invalid).status, 'invalid')
  }
  const v1At15 = await checkpoint(receipts, rows.at(-1), newKey)
  await assert.rejects(read([...rows, v1At15]), { code: 'AURA_CHECKPOINT_INVALID' })
  await assert.rejects(verifyFactCheckpoints([...rows, v1At15], receipts), { code: 'AURA_CHECKPOINT_INVALID' })
  await assert.rejects(verifyFactCheckpoints([...rows, latest], receipts), { code: 'AURA_CHECKPOINT_INVALID' })
  await assert.rejects(read([...rows, latest], { ...policy, ranges: policy.ranges.slice(0, 2) }), { code: 'AURA_CHECKPOINT_INVALID' })
  for (const field of ['ed25519SigHex', 'mlDsaSigHex']) {
    const stripped = structuredClone(latest); delete stripped.envelope.signatures[field]
    await assert.rejects(read([...rows, stripped]), { code: 'HYBRID_SIGNATURE_INCOMPLETE' })
  }
  const wrong = structuredClone(policy); wrong.ranges[2].mlDsaPublicKeyHex = '0'.repeat(3904)
  await countersignCheckpointRange(wrong.ranges[2], newKey)
  await assert.rejects(read([...rows, latest], wrong), { code: 'HYBRID_KEY_MISMATCH' })
  const relabeled = structuredClone(latest); relabeled.envelope.schema = 'aukora.hybrid-envelope.v1'
  await assert.rejects(read([...rows, relabeled]), { code: 'HYBRID_ENVELOPE_INVALID' })

  for (const mutate of [p => { p.ranges[2].publicKeyHex = rows[0].publicKeyHex },
    p => { p.ranges[2].validToCheckpoint = 17 }, p => { p.ranges[2].mlDsaPublicKeyHex = '0'.repeat(3904) },
    p => { p.ranges[2].countersignatureHex = '0'.repeat(128) },
    p => countersignCheckpointRange(p.ranges[2], oldKey),
    p => countersignCheckpointRange(p.ranges[2], newKey, 'aukora.hybrid.v2\0')]) {
    const invalid = structuredClone(policy); await mutate(invalid)
    assert.deepEqual(await verifyCheckpointSignerPolicy(invalid), { status: 'invalid' })
    assert.equal((await read(rows, invalid)).checkpointSignerTrust, 'invalid-pin')
    await assert.rejects(read([...rows, latest], invalid), { code: 'AURA_CHECKPOINT_INVALID' })
    await assert.rejects(read([...rows, v1At15], invalid), { code: 'AURA_CHECKPOINT_INVALID' })
  }
  const replay = structuredClone(policy)
  replay.ranges.push({ ...replay.ranges[2], validFromCheckpoint: 17, validToCheckpoint: 18 })
  assert.equal(parseCheckpointSignerPolicy(replay).status, 'invalid')
  const downgrade = structuredClone(policy)
  downgrade.ranges.push({ validFromCheckpoint: 17, validToCheckpoint: 18, envelope: 'v1', publicKeyHex: ed25519PublicKeyHex })
  assert.equal(parseCheckpointSignerPolicy(downgrade).status, 'invalid')
  await assert.rejects(verifyCheckpointSignerPolicy(policy, () => { throw new Error('cancelled') }), /cancelled/)
})

test('legacy checkpoints after fourteen require an explicit finite independent window and stop at its end', async () => {
  const receipts = [{ leafHash: 'a'.repeat(64), kind: 'memory.dag.append' }]
  const key = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']), rows = []
  for (let seq = 1; seq <= 16; seq++) rows.push(await checkpoint(receipts, rows.at(-1), key))
  const publicKeyHex = rows[0].publicKeyHex
  const pin = { schema: 'aukora.checkpoint-signer.v1', domain: 'aukora.x5.edge-head.v1', publicKeyHex, validToCheckpoint: 15 }
  const legacy = { schema: 'aukora.checkpoint-signer-policy.v1', domain: 'aukora.x5.edge-head.v1',
    ranges: [{ firstSeq: 1, lastSeq: 15, publicKeyHex }] }
  const transition = { schema: 'aukora.checkpoint-signer.v2', domain: 'aukora.hybrid.v2',
    ranges: [{ validFromCheckpoint: 1, validToCheckpoint: 15, envelope: 'v1', publicKeyHex }] }
  assert.equal(parseCheckpointSignerPin(pin).validToCheckpoint, 15)
  for (const validToCheckpoint of [0, -0, -1, null, Infinity, Number.MAX_SAFE_INTEGER]) {
    assert.equal(parseCheckpointSignerPin({ ...pin, validToCheckpoint }).status, 'invalid')
  }
  for (const options of [{ checkpointSignerPin: pin }, { checkpointSignerPolicy: legacy }, { checkpointSignerPolicy: transition }]) {
    const facts = await verifyFactCheckpoints(rows.slice(0, 15), receipts, () => {}, options)
    assert.equal(facts.checkpointSignerTrust, 'pinned')
    assert.equal(facts.lastCheckpointSeq, 15)
    await assert.rejects(verifyFactCheckpoints(rows, receipts, () => {}, options), { code: 'AURA_CHECKPOINT_INVALID' })
  }
  const unboundedPin = { schema: pin.schema, domain: pin.domain, publicKeyHex }
  for (const options of [{}, { checkpointSignerPin: unboundedPin }, { checkpointSignerPolicy: {} },
    { checkpointSignerPin: pin, checkpointSignerPolicy: legacy },
    { checkpointSignerPin: { ...pin, publicKeyHex: 'b'.repeat(64) } }]) {
    await assert.rejects(verifyFactCheckpoints(rows.slice(0, 15), receipts, () => {}, options), { code: 'AURA_CHECKPOINT_INVALID' })
  }
})

test('each hybrid successor binds the outgoing key and its own finite range without replay', async () => {
  const outgoing = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])
  const successor = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])
  const final = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])
  const outgoingHex = hex(await crypto.subtle.exportKey('raw', outgoing.publicKey))
  const successorHex = hex(await crypto.subtle.exportKey('raw', successor.publicKey))
  const finalHex = hex(await crypto.subtle.exportKey('raw', final.publicKey))
  const policy = { schema: 'aukora.checkpoint-signer.v2', domain: 'aukora.hybrid.v2', ranges: [
    { validFromCheckpoint: 1, validToCheckpoint: 14, envelope: 'v1', publicKeyHex: outgoingHex },
    await countersignCheckpointRange({ validFromCheckpoint: 15, validToCheckpoint: 20, envelope: 'v2', publicKeyHex: successorHex, mlDsaPublicKeyHex: 'a'.repeat(3904) }, outgoing),
    await countersignCheckpointRange({ validFromCheckpoint: 21, validToCheckpoint: 25, envelope: 'v2', publicKeyHex: finalHex, mlDsaPublicKeyHex: 'b'.repeat(3904) }, successor),
  ] }
  assert.equal((await verifyCheckpointSignerPolicy(JSON.stringify(policy))).status, 'configured')
  const wrongOutgoing = structuredClone(policy)
  await countersignCheckpointRange(wrongOutgoing.ranges[2], outgoing)
  assert.deepEqual(await verifyCheckpointSignerPolicy(wrongOutgoing), { status: 'invalid' })
  const moved = structuredClone(policy)
  moved.ranges[1].validToCheckpoint = 19
  moved.ranges[2].validFromCheckpoint = 20
  assert.deepEqual(await verifyCheckpointSignerPolicy(moved), { status: 'invalid' })
  const replay = structuredClone(policy)
  replay.ranges[2].countersignatureHex = policy.ranges[1].countersignatureHex
  assert.deepEqual(await verifyCheckpointSignerPolicy(replay), { status: 'invalid' })
})

test('source commit projects only bounded recorded BUILD_INFO metadata, never runtime or owner approval', () => {
  const buildInfo = { schema: 'aukora.build-info.v1', organSourceCommit: 'a'.repeat(40), builtAt: '2026-11-09T00:00:00.000Z',
    candidateOrgans: { 'synthetic-organ': { activeSha256: 'b'.repeat(64), candidateSha256: 'c'.repeat(64), bytes: 1024 } } }
  const expected = { status: 'recorded-build-info', organSourceCommit: buildInfo.organSourceCommit }
  assert.deepEqual(projectBuildInfo(buildInfo), expected)
  assert.deepEqual(projectBuildInfo(JSON.stringify(buildInfo)), expected)
  assert.deepEqual(projectBuildInfo(undefined), { status: 'unavailable', organSourceCommit: null })
  for (const mutate of [b => { b.organSourceCommit = 'a'.repeat(39) }, b => { b.organSourceCommit = null },
    b => { b.organSourceCommit = 'A'.repeat(40) }, b => { b.builtAt = '2026-02-30T00:00:00.000Z' },
    b => { b.schema = 'untrusted' }, b => { b.ownerApproval = true }, b => { b.candidateOrgans['synthetic-organ'].bytes = -1 },
    b => { b.candidateOrgans['synthetic-organ'].activeSha256 = 'secret' }, b => { b.candidateOrgans['../private'] = b.candidateOrgans['synthetic-organ'] }]) {
    const invalid = structuredClone(buildInfo); mutate(invalid)
    assert.deepEqual(projectBuildInfo(invalid), { status: 'invalid', organSourceCommit: null })
  }
  for (const invalid of [null, [], '{', ' '.repeat(65537)]) assert.deepEqual(projectBuildInfo(invalid), { status: 'invalid', organSourceCommit: null })
  assert.deepEqual(projectSourceMetadata(expected), expected)
  for (const invalid of [{ ...expected, privatePayload: 'PRIVATE' }, { ...expected, status: 'verified' },
    { status: 'unavailable', organSourceCommit: 'a'.repeat(40) }, { ...expected, organSourceCommit: 'main' }]) {
    assert.deepEqual(projectSourceMetadata(invalid), { status: 'invalid', organSourceCommit: null })
  }
  const projected = projectVerifiedFacts('cloudflare', { sourceMetadata: expected })
  assert.equal(projected.organSourceCommit, buildInfo.organSourceCommit)
  assert.equal(projected.organSourceEvidence, 'recorded-build-info')
  assert.equal(projected.ownerApproval, false)
  assert.equal(projected.independentAudit, false)
  assert.equal(projected.auraStatus, 'incomplete')
  assert.equal(JSON.stringify(projected).includes('candidateOrgans'), false)
})

const syntheticAumlokStatus = bound => ({ ok: true, schema: 'aukora.aumlok.status.v1', phase: bound ? 'BOUND' : 'UNBOUND',
  bound, passkeyVerified: bound, aumlokId: bound ? 'a'.repeat(64) : null, nodePubkeyHex: bound ? 'b'.repeat(64) : null,
  commitmentSha256: null, boundAt: bound ? 1000 : null, lastVerifiedAt: bound ? 2000 : null,
  enrollmentCount: bound ? 1 : 0, rotationSeq: 0, keyCommitmentId: bound ? 'c'.repeat(64) : null, approvedGrants: [],
  lastRotationChallengeId: null, pepperSeparated: false, pepperMigrationRequired: false, phraseBlockers: [],
  authorityAvailable: bound, enrollmentAvailable: false, blockers: bound ? [] : ['AUMLOK_TRUSTED_ENROLLMENT_UNAVAILABLE'],
  biometricVerified: false, phraseRecoveryAvailable: false, identityIsKey: true, domainIsPointer: true,
  invite: { quotaMonth: '2026-11', issuedThisMonth: 0, limit: 3, revokedCount: 0 } })

test('AUMLOK facts use an explicit trusted status input and never infer binding from mirror claims', () => {
  const bound = syntheticAumlokStatus(true), unbound = syntheticAumlokStatus(false)
  assert.equal(projectAumlokStatus(undefined).phase, 'UNAVAILABLE')
  assert.equal(projectAumlokStatus(unbound).phase, 'UNBOUND')
  assert.equal(projectAumlokStatus(unbound).passkeyVerified, false)
  const input = { aumlok: bound, aumlokStatus: bound, passkeyVerified: true, facts: { aumlokStatus: bound } }
  assert.equal(projectVerifiedFacts('local', input).aumlok.phase, 'UNAVAILABLE')
  const projected = projectVerifiedFacts('local', input, { aumlokStatus: bound })
  assert.equal(projected.aumlok.phase, 'BOUND')
  assert.equal(projected.aumlok.passkeyVerified, true)
  assert.equal(projected.aumlok.biometricVerified, false)
  assert.equal(projected.aumlok.phraseRecoveryAvailable, false)
  assert.equal(projected.ownerApproval, false)
  for (const privateField of ['nodePubkeyHex', 'commitmentSha256', 'aumlokId', 'credential', 'keyCommitmentId', 'approvedGrants',
    'lastRotationChallengeId', 'pepperSeparated', 'pepperMigrationRequired', 'phraseBlockers']) assert.equal(JSON.stringify(projected).includes(privateField), false)
  for (const mutate of [s => { s.phase = 'BOUND'; s.bound = false }, s => { s.passkeyVerified = false },
    s => { s.authorityAvailable = false }, s => { s.nodePubkeyHex = 'unverified' }, s => { s.lastVerifiedAt = 1 },
    s => { s.biometricVerified = true }, s => { s.phraseRecoveryAvailable = true }, s => { s.credential = 'PRIVATE' },
    s => { s.invite.issuedThisMonth = 4 }, s => { s.invite.revokedCount = 129 }, s => { s.invite.quotaMonth = '2026-13' },
    s => { s.blockers = ['PRIVATE DETAILS'] }, s => { s.rotationSeq = -1 }, s => { s.enrollmentCount = 0 },
    s => { s.approvedGrants = [null] }, s => { s.keyCommitmentId = null }, s => { delete s.rotationSeq }]) {
    const invalid = structuredClone(bound); mutate(invalid)
    assert.equal(projectAumlokStatus(invalid).phase, 'UNAVAILABLE')
    assert.equal(projectAumlokStatus(invalid).passkeyVerified, null)
  }
  const inventedIdentity = { ...unbound, nodePubkeyHex: bound.nodePubkeyHex }
  assert.equal(projectAumlokStatus(inventedIdentity).phase, 'UNAVAILABLE')
  const legacy = { ...bound }
  for (const key of ['lastRotationChallengeId', 'pepperSeparated', 'pepperMigrationRequired', 'phraseBlockers']) delete legacy[key]
  assert.equal(projectAumlokStatus(legacy).phase, 'BOUND')
  for (const key of ['enrollmentCount', 'rotationSeq', 'keyCommitmentId', 'approvedGrants']) delete legacy[key]
  assert.equal(projectAumlokStatus(legacy).phase, 'BOUND')
  for (const code of ['AUMLOK_OWNER_KEY_UNAVAILABLE', 'NODE_KEY_IS_NOT_OWNER_KEY']) {
    const unavailableOwner = projectAumlokStatus({ ...bound, authorityAvailable: false, blockers: [code] })
    assert.equal(unavailableOwner.phase, 'BOUND')
    assert.equal(unavailableOwner.authorityAvailable, false)
  }
})

test('AUMLOK facts accept legacy and lifetime invite counts and reject inconsistent totals', () => {
  for (const bound of [false, true]) {
    const legacy = syntheticAumlokStatus(bound)
    const current = structuredClone(legacy)
    current.invite.lifetimeIssuedCount = 0
    assert.deepEqual(projectAumlokStatus(current), projectAumlokStatus(legacy))
    for (const total of [-1, -0, 0.5, 129, NaN, Infinity, '0', null, undefined]) {
      const invalid = structuredClone(current)
      invalid.invite.lifetimeIssuedCount = total
      assert.equal(projectAumlokStatus(invalid).phase, 'UNAVAILABLE')
    }
    for (const mutate of [s => { s.invite.extra = 0 }, s => { delete s.invite.revokedCount },
      s => { delete s.invite.lifetimeIssuedCount; s.invite.unknown = 0 }]) {
      const invalid = structuredClone(current); mutate(invalid)
      assert.equal(projectAumlokStatus(invalid).phase, 'UNAVAILABLE')
    }
  }
  const bound = syntheticAumlokStatus(true)
  bound.invite = { ...bound.invite, issuedThisMonth: 2, revokedCount: 3, lifetimeIssuedCount: 128 }
  assert.equal(projectAumlokStatus(bound).phase, 'BOUND')
  bound.invite.lifetimeIssuedCount = 3
  assert.equal(projectAumlokStatus(bound).phase, 'BOUND', 'Lifetime issuance covers overlapping monthly and revoked counts')
  for (const [issued, revoked, lifetime] of [[2, 3, 2], [3, 0, 2], [0, 3, 2]]) {
    const invalid = structuredClone(bound)
    Object.assign(invalid.invite, { issuedThisMonth: issued, revokedCount: revoked, lifetimeIssuedCount: lifetime })
    assert.equal(projectAumlokStatus(invalid).phase, 'UNAVAILABLE')
  }
  const unbound = syntheticAumlokStatus(false)
  unbound.invite.lifetimeIssuedCount = 1
  assert.equal(projectAumlokStatus(unbound).phase, 'UNAVAILABLE')
})

test('AUMLOK custody status validates complete bounded fields without projecting recovery or rotation authority', () => {
  const bound = syntheticAumlokStatus(true), unbound = syntheticAumlokStatus(false)
  for (const status of [bound, unbound, { ...bound, pepperSeparated: true },
    { ...bound, pepperMigrationRequired: true }, { ...unbound, pepperMigrationRequired: true },
    { ...bound, rotationSeq: 1, lastRotationChallengeId: 'a'.repeat(16) },
    { ...bound, rotationSeq: 1, lastRotationChallengeId: 'Z_'.repeat(64) },
    { ...bound, phraseBlockers: ['AUMLOK_PHRASE_RATE_LIMITED'] },
    { ...bound, phraseBlockers: ['AUMLOK_PHRASE_GUARDIAN_QUORUM_REQUIRED'] }]) {
    assert.deepEqual(projectAumlokStatus(status), projectAumlokStatus(status.bound ? bound : unbound))
    const projected = projectVerifiedFacts('local', {}, { aumlokStatus: status })
    assert.equal(projected.ownerApproval, false)
    assert.equal(projected.aumlok.phraseRecoveryAvailable, false)
    assert.equal(projected.aumlok.biometricVerified, false)
  }
  for (const mutate of [
    ...['lastRotationChallengeId', 'pepperSeparated', 'pepperMigrationRequired', 'phraseBlockers',
      'enrollmentCount', 'rotationSeq', 'keyCommitmentId', 'approvedGrants'].map(key => s => { delete s[key] }),
    s => { s.lastRotationChallengeId = 'a'.repeat(43) },
    s => { s.rotationSeq = 1; s.lastRotationChallengeId = 'a'.repeat(15) },
    s => { s.rotationSeq = 1; s.lastRotationChallengeId = 'a'.repeat(129) },
    s => { s.rotationSeq = 1; s.lastRotationChallengeId = 'private challenge text' },
    s => { s.rotationSeq = 1; s.lastRotationChallengeId = 123 },
    s => { s.pepperSeparated = 'true' }, s => { s.pepperMigrationRequired = 1 },
    s => { s.pepperSeparated = true; s.pepperMigrationRequired = true },
    s => { s.phraseBlockers = null }, s => { s.phraseBlockers = 'AUMLOK_PHRASE_RATE_LIMITED' },
    s => { s.phraseBlockers = ['AUMLOK_PHRASE_UNRECOGNIZED'] }, s => { s.phraseBlockers = [null] },
    s => { s.phraseBlockers = ['AUMLOK_PHRASE_RATE_LIMITED', 'AUMLOK_PHRASE_RATE_LIMITED'] },
    s => { s.phraseBlockers = ['AUMLOK_PHRASE_RATE_LIMITED', 'AUMLOK_PHRASE_GUARDIAN_QUORUM_REQUIRED'] },
    s => { s.phraseBlockers = ['PRIVATE PHRASE'] }, s => { s.pepperProtection = { keyCheck: 'PRIVATE' } },
    s => { s['pepper.v1'] = 'PRIVATE' }, s => { s.futureCustodyField = true },
  ]) {
    const invalid = structuredClone(bound); mutate(invalid)
    assert.deepEqual(projectAumlokStatus(invalid), projectAumlokStatus(undefined))
  }
  for (const invalid of [{ ...unbound, pepperSeparated: true }, { ...unbound, lastRotationChallengeId: 'a'.repeat(43) }]) {
    assert.deepEqual(projectAumlokStatus(invalid), projectAumlokStatus(undefined))
  }
})

test('fresh durable AUMLOK status remains explicitly unbound after the host facts projection', async () => {
  const key = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])
  const ownerPublicKeyHex = hex(await crypto.subtle.exportKey('raw', key.publicKey))
  const storage = { async get(key) { assert.equal(key, AUMLOK_STORAGE_KEY); return undefined },
    async put() { assert.fail('status must not write durable state') }, transaction(operation) { return operation(storage) } }
  for (const options of [{}, { ownerPublicKeyHex }, { ownerPublicKeyHex, authorizeEnrollment: async () => true }]) {
    const store = createAumlokStore(storage, { origins: ['https://synthetic.example'], now: () => Date.parse('2026-11-09T00:00:00Z'), ...options })
    const status = JSON.parse(JSON.stringify(await store.status()))
    assert.equal(status.lastRotationChallengeId, null)
    assert.equal(status.pepperSeparated, false)
    assert.equal(status.pepperMigrationRequired, false)
    assert.deepEqual(status.phraseBlockers, [])
    const projected = projectVerifiedFacts('local', {}, { aumlokStatus: status })
    assert.equal(projected.aumlok.phase, 'UNBOUND')
    assert.equal(projected.aumlok.bound, false)
    assert.equal(projected.aumlok.passkeyVerified, false)
    assert.equal(projected.aumlok.enrollmentAvailable, typeof options.authorizeEnrollment === 'function')
    assert.equal(projected.aumlok.authorityAvailable, typeof options.authorizeEnrollment === 'function')
    assert.equal(projected.ownerApproval, false)
  }
})

test('durable approval metadata is validated but never projected as authorization or key material', () => {
  const bound = syntheticAumlokStatus(true)
  const record = { schema: 'aumlok.approval.v1', approvalId: 'A'.repeat(43), generation: 1,
    approvedAt: 2000, expiresAt: 302000, consumedAt: null, recordMac: 'd'.repeat(64),
    binding: { schema: 'aukora.class3.head-promotion.v1', audience: 'https://synthetic.example', action: 'head.promote',
      ballId: 'e'.repeat(64), epoch: 163, organId: 'seed-pearl', candidateSha256: 'f'.repeat(64) } }
  const read = approval => projectAumlokStatus({ ...bound, approvedGrants: [approval] })
  const projected = read(record)
  assert.equal(projected.phase, 'BOUND')
  assert.equal(JSON.stringify(projected).includes('recordMac'), false)
  assert.equal(read({ ...record, consumedAt: 3000 }).phase, 'BOUND')
  assert.equal(read({ ...record, binding: { schema: 'aukora.class3.action.v1', audience: 'https://synthetic.example',
    method: 'POST', pathname: '/_host/owner-grant', bodySha256: 'e'.repeat(64) } }).phase, 'BOUND')
  for (const organId of ['seed-receipts', 'seed-superagent', 'seed-pearl', 'seed-aura',
    'seed-predict', 'seed-recall', 'seed-memory', 'auma-body-map', 'ordinary-organ', 'dynamic-governance', 'a', 'a'.repeat(41)]) {
    const approval = { ...record, binding: { ...record.binding, organId } }
    assert.deepEqual(read(approval), projected)
    const facts = projectVerifiedFacts('local', {}, { aumlokStatus: { ...bound, approvedGrants: [approval] } })
    assert.equal(facts.aumlok.phase, 'BOUND')
    assert.equal(facts.ownerApproval, false)
    assert.equal(JSON.stringify(facts).includes('approvedGrants'), false)
    assert.equal(JSON.stringify(facts).includes('recordMac'), false)
  }
  for (const organId of [undefined, null, 123, [], {}, '', 'a'.repeat(42), 'Seed-pearl', '-seed', '9seed',
    'seed_pearl', 'seed/pearl', 'seed:pearl', 'private organ details']) {
    assert.deepEqual(read({ ...record, binding: { ...record.binding, organId } }), projectAumlokStatus(undefined))
  }
  for (const mutate of [r => { r.generation = 2 }, r => { r.expiresAt++ }, r => { r.consumedAt = r.expiresAt },
    r => { r.token = 'PRIVATE' }, r => { r.recordMac = null },
    r => { r.binding.audience = 'https://synthetic.example/path' }]) {
    const invalid = structuredClone(record); mutate(invalid)
    assert.equal(read(invalid).phase, 'UNAVAILABLE')
  }
  assert.equal(projectAumlokStatus({ ...bound, approvedGrants: [record, record] }).phase, 'UNAVAILABLE')
})

test('signed invite facts require independent sponsor authority and do not claim revocation, redemption or standing', async () => {
  const key = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])
  const publicKeyHex = hex(await crypto.subtle.exportKey('raw', key.publicKey))
  const body = { schema: 'aukora.invite.v1', inviteId: 'synthetic-invite-0001', sponsorPubkeyHex: publicKeyHex,
    inviteeCommitmentSha256: 'b'.repeat(64), assignedDomainPointer: 'https://synthetic.example', quotaMonth: '2026-11',
    monthlySequence: 1, revoked: false, issuedAt: Date.parse('2026-11-09T00:00:00.000Z'), expiresAt: Date.parse('2026-11-10T00:00:00.000Z') }
  const signed = async value => ({ ...value, signature: Buffer.from(await crypto.subtle.sign('Ed25519', key.privateKey,
    new TextEncoder().encode(aumlokInvitePreimage(value)))).toString('base64url') })
  const row = await signed(body), second = await signed({ ...body, inviteId: 'synthetic-invite-0002', monthlySequence: 2 })
  const options = { trustedSponsorPubkeyHex: publicKeyHex }
  const facts = await verifyFactInvites([row, second], options)
  assert.equal(facts.status, 'signature-verified')
  assert.equal(facts.signaturesVerified, 2)
  assert.equal(facts.sponsorTrust, 'pinned')
  for (const field of ['revocation', 'redemption', 'currentEligibility', 'behavioralStanding']) assert.equal(facts[field], 'unverified')
  assert.equal(facts.ownerApproval, false)
  assert.equal(facts.independentAudit, false)
  assert.equal(JSON.stringify(facts).includes(publicKeyHex), false)
  assert.equal(JSON.stringify(facts).includes(row.inviteeCommitmentSha256), false)
  assert.equal((await verifyFactInvites([row])).sponsorTrust, 'unpinned')
  assert.equal((await verifyFactInvites([row])).status, 'unverified')
  assert.equal((await verifyFactInvites([row], { trustedSponsorPubkeyHex: 'c'.repeat(64) })).sponsorTrust, 'mismatch')
  assert.equal((await verifyFactInvites([row], { trustedSponsorPubkeyHex: 'bad' })).sponsorTrust, 'invalid-pin')
  for (const mutate of [r => { r.inviteeCommitmentSha256 = 'd'.repeat(64) }, r => { r.assignedDomainPointer = 'https://changed.example' },
    r => { r.monthlySequence = 2 }, r => { r.revoked = true }, r => { r.signature = 'A'.repeat(86) },
    r => { r.issuedAt += 1 }, r => { r.ownerApproval = true }]) {
    const invalid = structuredClone(row); mutate(invalid)
    assert.equal((await verifyFactInvites([invalid], options)).status, 'unverified')
  }
  assert.equal((await verifyFactInvites([row, row], options)).signaturesVerified, null)
  const duplicateSlot = await signed({ ...body, inviteId: 'synthetic-invite-0003' })
  assert.equal((await verifyFactInvites([row, duplicateSlot], options)).status, 'unverified')
  assert.equal((await verifyFactInvites([], options)).status, 'not-recorded')
  for (const invalid of [null, Array(129).fill(row)]) {
    const result = await verifyFactInvites(invalid, options)
    assert.equal(result.status, 'unavailable'); assert.equal(result.receiptsTotal, null)
  }
  await assert.rejects(verifyFactInvites([row], { ...options, check: () => { throw new Error('cancelled') } }), /cancelled/)
})

function challengeReceipt(passed = 1, total = 1) {
  const controls = { allPassed: true, knownGoodAccepted: true, knownBadRejected: true, acceptAllRejected: true, rejectAllRejected: true }
  const candidate = { label: 'candidate', passed, passedCases: passed, total, totalCases: total,
    trialOk: true, qualifiedForPromotion: passed === total, graderControls: controls, routeEvidence: { status: 'checked', privateTrace: 'PRIVATE_ROUTE_TRACE' },
    retentionResults: Array.from({ length: total }, (_, index) => ({ id: `case-${index}`, pass: index < passed, privateOutput: 'PRIVATE_CASE_OUTPUT' })) }
  return { kind: 'pearl.challenge', leafHash: 'c'.repeat(64), data: { authorityTier: 'self-attested', realm: 'scion-trial-worker',
    admissionScope: 'behavioral-retention-only', candidateId: 'candidate', qualifiedForPromotion: candidate.qualifiedForPromotion,
    winnerId: 'candidate', candidates: [candidate, { ...candidate, label: 'baseline' }], privatePrompt: 'PRIVATE_TASK_PROMPT' } }
}

test('Survivor projects bounded recorded task outcomes, never ranking or checkpoint trust as admission', async () => {
  const receipt = challengeReceipt(1, 2)
  const facts = await verifyFactCheckpoints([], [receipt])
  assert.deepEqual(facts.taskOutcome, { status: 'self-attested', retentionPassed: 1, retentionTotal: 2,
    qualifiedForPromotion: null, graderControlsPassed: true, routeEvidenceStatus: 'checked' })
  const qualified = await verifyFactCheckpoints([], [challengeReceipt()])
  assert.equal(qualified.taskOutcome.qualifiedForPromotion, null)
  assert.equal(JSON.stringify(qualified).includes('PRIVATE_'), false)
  for (const mutate of [row => { row.data.candidates[0].retentionResults[0].pass = false },
    row => { row.data.candidates[0].graderControls.knownBadRejected = false },
    row => { row.data.candidates[0].routeEvidence.status = 'violated' },
    row => { row.data.candidates[0].retentionResults = Array(257).fill({ id: 'oversized', pass: true }) },
    row => { row.data.candidates[0].totalCases = 0 }, row => { row.data.candidates.push(row.data.candidates[0]) },
    row => { row.data.authorityTier = 'cryptographically-attested' }]) {
    const invalid = challengeReceipt(); mutate(invalid)
    const result = await verifyFactCheckpoints([], [invalid])
    assert.equal(result.taskOutcome.status, 'unverified')
    assert.equal(result.taskOutcome.retentionPassed, null)
  }
})

test('unknown facts never become empty or healthy facts', () => {
  const value = projectVerifiedFacts('local', {})
  assert.equal(value.ok, false); assert.equal(value.receiptsVerified, null)
  assert.equal(value.checkpointsTotal, null); assert.equal(value.wakeUrgency, null)
  assert.equal(value.auraStatus, 'incomplete')
})

const NOW = 1794182400000
const auraInputs = (overrides = {}) => ({ computedAt: NOW, ballId: 'a'.repeat(64), epoch: 157,
  reachableDagNodes: 7, declaredDagNodes: 7, verifiedReceipts: 87, totalReceipts: 87,
  activeOrgans: 20, declaredOrgans: 20, observedSurpriseScores: [], handOffEpochMismatch: false,
  unanchoredPredictions: 0, pendingWakes: 0, lastRollbackAgeEpochs: 10, staleHeartbeatRatio: 0, ...overrides })

test('Survivor series keep verified calibration separate from task, gate, and model authority', async () => {
  const facts = await verifyFactCheckpoints([], [{ kind: 'prediction.observe', leafHash: 'a'.repeat(64),
    data: { observed: 0, expected: 0, taskOutcome: { qualifiedForPromotion: true }, privatePrompt: 'PRIVATE_PROMPT' } }])
  const input = { ...auraInputs({ observedSurpriseScores: [0] }), evidence: { status: 'complete' }, facts,
    gates: { status: 'verified' }, modelAttribution: { evidenceQuality: 'cryptographically-attested', requestedModel: 'PRIVATE_MODEL' } }
  const output = projectVerifiedFacts('local', input)
  assert.equal(output.taskOutcome.status, 'not-recorded')
  assert.equal(output.taskOutcome.retentionPassed, null)
  assert.equal(output.taskOutcome.qualifiedForPromotion, null)
  assert.deepEqual(output.predictionCalibration, { status: 'observed', version: 'receipt-error-v1', samples: 1,
    minSamples: null, receiptErrorMean: 0, receiptErrorLast: 0 })
  assert.deepEqual(output.gates, { status: 'unverified' })
  assert.deepEqual(output.modelAttribution, { evidenceQuality: 'unknown', requestedModel: null, providerReportedModel: null, immutableRevision: null })
  assert.equal(JSON.stringify(output).includes('PRIVATE_'), false)
  assert.equal(projectVerifiedFacts('local', { ...input, observedSurpriseScores: [] }).predictionCalibration.status, 'insufficient-samples')
  const large = projectVerifiedFacts('local', { ...input, observedSurpriseScores: [Number.MAX_VALUE, Number.MAX_VALUE] })
  assert.equal(large.predictionCalibration.receiptErrorMean, Number.MAX_VALUE)
  for (const scores of [[NaN], [Infinity], [-0], [-1], Array(1), Array(4097).fill(0), undefined]) {
    const result = projectVerifiedFacts('local', { ...input, observedSurpriseScores: scores })
    assert.equal(result.predictionCalibration.status, 'unavailable')
    assert.equal(result.predictionCalibration.samples, null)
  }
  for (const trust of ['unpinned', 'pinned', 'mismatch', 'invalid-pin']) {
    assert.equal(projectVerifiedFacts('local', { ...input, facts: { ...facts, checkpointSignerTrust: trust } }).checkpointSignerTrust, trust)
  }
  const injected = projectVerifiedFacts('local', { ...input, facts: { ...facts, checkpointSignerTrust: 'PRIVATE_SIGNER',
    taskOutcome: { ...emptyTaskForTest(), privatePrompt: 'PRIVATE_PROMPT' } } })
  assert.equal(injected.checkpointSignerTrust, 'unpinned')
  assert.equal(JSON.stringify(injected).includes('PRIVATE_'), false)
})

const emptyTaskForTest = () => ({ status: 'unverified', retentionPassed: null, retentionTotal: null,
  qualifiedForPromotion: null, graderControlsPassed: null, routeEvidenceStatus: null })

async function localFactsFixture(t) {
  const root = await fsp.mkdtemp(path.join(await fsp.realpath(os.tmpdir()), 'x61-fact-pin-'))
  t.after(() => fsp.rm(root, { recursive: true, force: true }))
  const write = async (relative, value) => {
    const target = path.join(root, relative)
    await fsp.mkdir(path.dirname(target), { recursive: true })
    await fsp.writeFile(target, typeof value === 'string' ? value : JSON.stringify(value))
  }
  const head = { version: 'x6.1-ball/v1', parentBallId: null, epoch: 1,
    entries: { fixture: { id: 'fixture', specifier: 'fixture:only', disabled: false, config: {}, previousSpecifiers: [] } }, modules: {} }
  head.ballId = await manifestId(head)
  const nodeBody = { content: 'PRIVATE_SYNTHETIC_MEMORY', parentIds: [] }
  const node = { ...nodeBody, id: await digest(canonicalJson(nodeBody)) }
  const body = { schema: 'aukora.receipt.v3', seq: 1, at: new Date(NOW).toISOString(), prevHash: '0'.repeat(64),
    kind: 'memory.dag.append', data: { nodeId: node.id, content: node.content } }
  const receipt = { ...body, leafHash: await digest('\0' + canonicalJson(body)) }
  const row = await checkpoint([receipt])
  const pin = { schema: 'aukora.checkpoint-signer.v1', domain: 'aukora.x5.edge-head.v1', publicKeyHex: row.publicKeyHex }
  await write('balls/HEAD.json', head)
  await write('home/auma/HANDOFF.md', `| epoch | **1** |\n| ballId | \`${head.ballId}\` |\n`)
  await write('home/auma/memory/dag/HEAD.json', { count: 1, heads: [node.id] })
  await write(`home/auma/memory/dag/${node.id}.json`, node)
  await write('home/auma/seed/receipts.v3.jsonl', JSON.stringify(receipt) + '\n')
  await write('home/auma/seed/checkpoints.v1.jsonl', JSON.stringify(row) + '\n')
  await write('home/auma/seed/checkpoint-signer.v1.json', pin)
  await write('home/auma/seed/gates.json', { status: 'verified', privateOutput: 'PRIVATE_GATE_OUTPUT' })
  await write('home/auma/seed/discovery-corpus.v1.jsonl', '')
  await write('home/auma/superagent/state.json', { assignments: [] })
  const options = { mirrorDirectory: root, now: NOW, includeFacts: true, wake: { ok: true, enabled: false, intervalMs: 60000,
    lastWakeAt: null, wakeCount: 0, nextWakeAt: null, consecutiveUnacknowledgedWakes: 0, probePending: false } }
  return { root, write, options, pin, row, receipt }
}

test('local facts use only an explicit pin option and never a mirror self-pin', async t => {
  const { options, pin } = await localFactsFixture(t)
  const unpinned = await readLocalAuraInputs(options)
  assert.equal(unpinned.evidence.status, 'complete', JSON.stringify(unpinned.evidence))
  assert.equal(unpinned.facts.checkpointSignerTrust, 'unpinned')
  const pinned = await readLocalAuraInputs({ ...options, checkpointSignerPin: pin })
  assert.equal(pinned.evidence.status, 'complete', JSON.stringify(pinned.evidence))
  assert.equal(pinned.facts.checkpointSignerTrust, 'pinned')
  const projected = projectVerifiedFacts('local', pinned)
  assert.equal(projected.gates.status, 'unverified')
  assert.equal(JSON.stringify(projected).includes('PRIVATE_'), false)
})

test('local facts forward independently configured rotation policy without adopting candidate policy files', async t => {
  const { write, options, pin, row, receipt } = await localFactsFixture(t)
  const rotated = await checkpoint([receipt], row)
  const policy = { schema: 'aukora.checkpoint-signer-policy.v1', domain: 'aukora.x5.edge-head.v1', ranges: [
    { firstSeq: 1, lastSeq: 1, publicKeyHex: row.publicKeyHex },
    { firstSeq: 2, lastSeq: 2, publicKeyHex: rotated.publicKeyHex },
  ] }
  await write('home/auma/seed/checkpoints.v1.jsonl', [row, rotated].map(value => JSON.stringify(value)).join('\n') + '\n')
  await write('home/auma/seed/checkpoint-signer-policy.v1.json', policy)
  const unpinned = await readLocalAuraInputs(options)
  assert.equal(unpinned.evidence.status, 'complete')
  assert.equal(unpinned.facts.checkpointSignerTrust, 'unpinned')
  const pinned = await readLocalAuraInputs({ ...options, checkpointSignerPolicy: JSON.stringify(policy) })
  assert.equal(pinned.evidence.status, 'complete')
  assert.equal(pinned.facts.checkpointSignerTrust, 'pinned')
  assert.equal(pinned.facts.ownerApproval, false)
  const invalid = await readLocalAuraInputs({ ...options, checkpointSignerPolicy: policy, checkpointSignerPin: pin })
  assert.equal(invalid.facts.checkpointSignerTrust, 'invalid-pin')
  const wrong = structuredClone(policy); wrong.ranges[1].publicKeyHex = row.publicKeyHex
  assert.equal((await readLocalAuraInputs({ ...options, checkpointSignerPolicy: wrong })).facts.checkpointSignerTrust, 'mismatch')
  assert.equal(JSON.stringify(projectVerifiedFacts('local', pinned)).includes(row.publicKeyHex), false)
})

test('a mirror legacy extension cannot authorize checkpoint fifteen without independent host configuration', async t => {
  const { write, options, receipt } = await localFactsFixture(t)
  const key = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']), rows = []
  for (let seq = 1; seq <= 15; seq++) rows.push(await checkpoint([receipt], rows.at(-1), key))
  const policy = { schema: 'aukora.checkpoint-signer-policy.v1', domain: 'aukora.x5.edge-head.v1',
    ranges: [{ firstSeq: 1, lastSeq: 15, publicKeyHex: rows[0].publicKeyHex }] }
  await write('home/auma/seed/checkpoints.v1.jsonl', rows.map(value => JSON.stringify(value)).join('\n') + '\n')
  await write('home/auma/seed/checkpoint-signer-policy.v1.json', policy)
  const untrusted = await readLocalAuraInputs(options)
  assert.equal(untrusted.evidence.status, 'incomplete')
  assert.equal(untrusted.facts, undefined)
  const trusted = await readLocalAuraInputs({ ...options, checkpointSignerPolicy: policy })
  assert.equal(trusted.evidence.status, 'complete')
  assert.equal(trusted.facts.lastCheckpointSeq, 15)
  assert.equal(trusted.facts.checkpointSignerTrust, 'pinned')
})

test('local build metadata stays bounded and optional while verified evidence remains available', async t => {
  const { root, write, options } = await localFactsFixture(t)
  const relative = 'home/auma/seed/BUILD_INFO.json', file = path.join(root, relative)
  const read = async status => {
    const input = await readLocalAuraInputs(options)
    assert.equal(input.evidence.status, 'complete', JSON.stringify(input.evidence))
    assert.equal(input.verifiedReceipts, 1)
    assert.equal(input.facts.checkpointSignerTrust, 'unpinned')
    assert.equal(input.sourceMetadata.status, status)
    return projectVerifiedFacts('local', input)
  }
  assert.equal((await read('unavailable')).organSourceCommit, null)
  const build = { schema: 'aukora.build-info.v1', organSourceCommit: 'd'.repeat(40), builtAt: '2026-11-09T00:00:00.000Z', candidateOrgans: {} }
  await write(relative, build)
  const projected = await read('recorded-build-info')
  assert.equal(projected.organSourceCommit, build.organSourceCommit)
  assert.equal(projected.ownerApproval, false)
  assert.equal(JSON.stringify(projected).includes('candidateOrgans'), false)
  const lstat = fsp.lstat
  let buildStats = 0
  const changed = t.mock.method(fsp, 'lstat', async (target, ...args) => {
    if (target === file && ++buildStats === 3) await fsp.writeFile(file, JSON.stringify({ ...build, organSourceCommit: 'e'.repeat(40) }))
    return lstat(target, ...args)
  })
  try { assert.equal((await read('invalid')).organSourceCommit, null) }
  finally { changed.mock.restore() }
  assert.equal(buildStats, 3, 'The recorded build must survive its final version recheck')
  for (const malformed of ['{', ' '.repeat(65537), Buffer.from([0xff]), { ...build, privatePayload: 'PRIVATE' }]) {
    await fsp.writeFile(file, Buffer.isBuffer(malformed) ? malformed : typeof malformed === 'string' ? malformed : JSON.stringify(malformed))
    assert.equal((await read('invalid')).organSourceCommit, null)
  }
  await fsp.unlink(file)
  await write('synthetic-build.json', build)
  await fsp.symlink(path.join(root, 'synthetic-build.json'), file)
  assert.equal((await read('invalid')).organSourceCommit, null)
  await fsp.unlink(file)
  await fsp.mkdir(file)
  assert.equal((await read('invalid')).organSourceCommit, null)
  const noFacts = await readLocalAuraInputs({ ...options, includeFacts: false })
  assert.equal(Object.hasOwn(noFacts, 'sourceMetadata'), false)
})

test('authenticated HeadDO metadata reads return only selected identity and lease without module bodies', async t => {
  const sha = 'b'.repeat(64)
  const ball = { version: 'x6.1-ball/v1', parentBallId: null, epoch: 1,
    entries: { fixture: { id: 'fixture', specifier: `ball:${sha}`, disabled: false, config: {}, previousSpecifiers: [] } },
    modules: { [sha]: { sha256: sha, specifier: `ball:${sha}` } } }
  ball.ballId = await manifestId(ball)
  const lease = { ownerPeerId: 'synthetic-peer', generation: 1, expiresAt: Date.now() + 60000 }
  const rows = new Map([['head', ball.ballId], ['bootstrap:v1', { phase: 'complete', seedId: 'c'.repeat(64), ballId: ball.ballId, epoch: 1 }],
    [`manifest:${ball.ballId}:count`, 1], [`manifest:${ball.ballId}:0`, JSON.stringify(ball)], ['lease', lease]])
  let reads = 0
  const storage = { async get(key) {
    reads++
    assert.equal(key.startsWith('module:'), false, 'metadata must not read any module body')
    return structuredClone(rows.get(key))
  }, transaction(operation) { return operation(storage) } }
  const head = new X61HeadDurableObject({ storage, getWebSockets: () => [] }, {})
  t.after(() => head.wakeStore.dispose())
  const request = (pathname, options = {}) => head.fetch(new Request('https://synthetic.invalid' + pathname,
    { headers: { 'x-x6-internal-authorized': '1' }, ...options }))
  for (const route of ['/_head/status', '/_head/ball?meta=1']) {
    const before = reads
    assert.equal((await request(route, { headers: {} })).status, 401)
    assert.equal(reads, before, 'authentication precedes storage access')
    const response = await request(route)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.deepEqual(await response.json(), { ok: true, ballId: ball.ballId, epoch: 1, lease,
      governancePromotion: false, governancePromotionBlocker: 'PEARL_QUALIFICATION_UNVERIFIABLE' })
    assert.equal((await request(route, { method: 'POST', body: '{}' })).status, 405)
    assert.equal((await request(route, { headers: { 'x-x6-internal-authorized': '1', 'content-length': '1' } })).status, 400)
  }
  for (const route of ['/_head/status?', '/_head/status?extra=1', '/_head/ball?meta=0', '/_head/ball?meta=1&meta=1', '/_head/ball?meta=1&extra=1']) {
    assert.equal((await request(route)).status, 404)
  }
  rows.set('bootstrap:v1', { phase: 'prepared', seedId: 'c'.repeat(64) })
  assert.equal((await request('/_head/status')).status, 503)
})

function organFixture(name, initial = []) {
  const files = new Map(initial), writes = []
  const fs = {
    existsSync(path) { return files.has(path) },
    readFileSync(path) { if (!files.has(path)) throw Object.assign(new Error('SYNTHETIC_FILE_ABSENT'), { code: 'ENOENT' }); return files.get(path) },
    writeFileSync(path, body) { writes.push(path); files.set(path, String(body)) },
    appendFileSync(path, body) { writes.push(path); files.set(path, (files.get(path) ?? '') + String(body)) },
    mkdirSync() {},
    readdirSync(path) { return [...files.keys()].filter(key => key.startsWith(path + '/') && !key.slice(path.length + 1).includes('/')).map(key => key.slice(path.length + 1)) },
  }
  const module = { exports: {} }
  const source = loadOrganUnderTest(name)
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [NOW])) } static now() { return NOW } }
  const require = specifier => {
    if (specifier === 'node:fs' || specifier === 'fs') return fs
    if (specifier === 'node:crypto' || specifier === 'crypto') return nodeCrypto
    if (specifier === 'path' || specifier === 'node:path') return path
    throw new Error(`Unapproved synthetic dependency: ${specifier}`)
  }
  new Function('module', 'require', 'Buffer', 'Date', source)(module, require, Buffer, Clock)
  return { organ: module.exports, files, writes }
}

async function checkpointOrganFixture() {
  const fixture = organFixture('seed-receipts')
  const key = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])
  const publicKeyHex = hex(await crypto.subtle.exportKey('raw', key.publicKey))
  const receipt = appendSyntheticReceipt(fixture.files, 'memory.synthetic', {})
  const rows = []
  for (let seq = 1; seq <= 14; seq++) rows.push(await checkpoint([receipt], rows.at(-1), key))
  const checkpointPath = SEED + '/checkpoints.v1.jsonl', keyPath = SEED + '/ed25519-keypair.json'
  fixture.files.set(checkpointPath, rows.map(row => JSON.stringify(row)).join('\n') + '\n')
  fixture.files.set(keyPath, JSON.stringify({ publicKeyHex,
    privateJwk: await crypto.subtle.exportKey('jwk', key.privateKey), publicJwk: await crypto.subtle.exportKey('jwk', key.publicKey) }))
  const policy = { schema: 'aukora.checkpoint-signer-policy.v1', domain: 'aukora.x5.edge-head.v1',
    ranges: [{ firstSeq: 1, lastSeq: 15, publicKeyHex }] }
  const verified = await verifyCheckpointSignerPolicy(policy)
  const response = { ok: true, schema: 'aukora.checkpoint-policy.v1', ranges: verified.ranges.map(range => ({ ...range, envelope: 'v1' })) }
  return { ...fixture, key, publicKeyHex, receipt, rows, checkpointPath, keyPath, policy, response }
}

test('checkpoint producer uses a finite authenticated host window and stops without changing history', async () => {
  const fixture = await checkpointOrganFixture()
  const { files, writes, organ, publicKeyHex, response, policy, receipt, rows, checkpointPath, keyPath } = fixture
  files.set(SEED + '/checkpoint-signer.v1.json', JSON.stringify({ schema: 'aukora.checkpoint-signer.v1',
    domain: 'aukora.x5.edge-head.v1', publicKeyHex, validToCheckpoint: 999 }))
  const before = new Map(files)
  const input = { action: 'checkpoint', expectedPublicKey: publicKeyHex,
    checkpointSignerPolicy: { ...response, ranges: [{ ...response.ranges[0], lastSeq: 999 }] } }
  assert.equal((await organ.run(input)).error, 'CHECKPOINT_SIGNER_POLICY_UNAVAILABLE')
  assert.deepEqual(files, before)
  assert.deepEqual(writes, [])
  let policyReads = 0
  const context = { checkpointPolicy: { async read() { policyReads++; return structuredClone(response) } } }
  const result = await organ.run(input, context)
  assert.equal(result.ok, true)
  assert.equal(result.checkpoint.body.seq, 15)
  assert.equal(policyReads, 1)
  assert.deepEqual(writes, [checkpointPath])
  assert.equal(files.get(keyPath), before.get(keyPath))
  assert.equal(files.get(RECEIPTS), before.get(RECEIPTS))
  assert.equal((await verifyFactCheckpoints([...rows, result.checkpoint], [receipt], () => {}, { checkpointSignerPolicy: policy })).checkpointSignerTrust, 'pinned')
  const after = new Map(files)
  assert.equal((await organ.run(input, context)).error, 'CHECKPOINT_SIGNER_POLICY_EXPIRED')
  assert.deepEqual(files, after)
  assert.deepEqual(writes, [checkpointPath])
})

test('unavailable, malformed, mismatched, or hybrid checkpoint policy never writes or replaces a key', async () => {
  const fixture = await checkpointOrganFixture()
  const { organ, files, writes, publicKeyHex, response, keyPath, key } = fixture
  const input = { action: 'checkpoint', expectedPublicKey: publicKeyHex }
  const hybrid = { schema: 'aukora.checkpoint-signer.v2', domain: 'aukora.hybrid.v2', ranges: [
    { validFromCheckpoint: 1, validToCheckpoint: 14, envelope: 'v1', publicKeyHex },
    await countersignCheckpointRange({ validFromCheckpoint: 15, validToCheckpoint: 20, envelope: 'v2', publicKeyHex, mlDsaPublicKeyHex: 'a'.repeat(3904) }, key),
  ] }
  const verified = await verifyCheckpointSignerPolicy(hybrid)
  const hybridResponse = { ok: true, schema: response.schema,
    ranges: verified.ranges.map(({ firstSeq, lastSeq, publicKeyHex, envelope }) => ({ firstSeq, lastSeq, publicKeyHex, envelope })) }
  const cases = [
    [async () => { throw new Error('SYNTHETIC_HOST_UNAVAILABLE') }, 'CHECKPOINT_SIGNER_POLICY_UNAVAILABLE'],
    [async () => ({ ...response, ownerApproval: true }), 'CHECKPOINT_SIGNER_POLICY_INVALID'],
    [async () => ({ ...response, ranges: [{ ...response.ranges[0], lastSeq: Number.MAX_SAFE_INTEGER }] }), 'CHECKPOINT_SIGNER_POLICY_INVALID'],
    [async () => ({ ...response, ranges: [{ ...response.ranges[0], publicKeyHex: 'b'.repeat(64) }] }), 'CHECKPOINT_SIGNER_POLICY_MISMATCH'],
    [async () => hybridResponse, 'CHECKPOINT_HYBRID_SIGNER_UNAVAILABLE'],
    [async () => ({ ...hybridResponse, ranges: [...hybridResponse.ranges, { firstSeq: 21, lastSeq: 22, envelope: 'v1', publicKeyHex }] }), 'CHECKPOINT_SIGNER_POLICY_INVALID'],
  ]
  const before = new Map(files)
  for (const [read, error] of cases) {
    assert.equal((await organ.run(input, { checkpointPolicy: { read } })).error, error)
    assert.deepEqual(files, before)
    assert.deepEqual(writes, [])
  }
  files.delete(keyPath)
  const missingKey = new Map(files)
  assert.equal((await organ.run(input, { checkpointPolicy: { async read() { return response } } })).error, 'SIGNING_KEY_MISSING')
  assert.deepEqual(files, missingKey)
  assert.deepEqual(writes, [])
})

test('coherence multiplies all evidence ratios and the self-contained organ agrees with shared server rules', () => {
  const { organ, writes } = organFixture('seed-aura')
  const cases = [{}, { reachableDagNodes: 3, declaredDagNodes: 4, verifiedReceipts: 1, totalReceipts: 2, activeOrgans: 2, declaredOrgans: 4 },
    { unanchoredPredictions: 1 }, { unanchoredPredictions: 1_000_000 }, { unanchoredPredictions: Number.MAX_SAFE_INTEGER },
    { observedSurpriseScores: [1000, 1, 2, 3, 4, 5] }, { handOffEpochMismatch: true, unanchoredPredictions: 2, pendingWakes: 2, lastRollbackAgeEpochs: 1 },
    { staleHeartbeatRatio: 0.7 }, { observedSurpriseScores: [Number.MAX_VALUE, Number.MAX_VALUE] },
    { activeOrgans: 0 }, { reachableDagNodes: 0 }, { verifiedReceipts: 0 },
    { activeOrgans: 1, declaredOrgans: 20, reachableDagNodes: 1, observedSurpriseScores: [100], staleHeartbeatRatio: 0.8 }]
  for (const overrides of cases) {
    const input = auraInputs(overrides), before = structuredClone(input)
    const expected = computeAura(input)
    assert.equal(validateAuraVector(expected), true)
    assert.equal(auraInputsComplete(input), true)
    assert.equal(organ.auraInputsComplete(input), true)
    assert.deepEqual(organ.computeAura(input), expected)
    assert.deepEqual(input, before)
  }
  assert.equal(computeAura(auraInputs(cases[1])).vector.coherence, 0.75 * 0.5 * 0.5)
  assert.equal(writes.length, 0)
})

test('unanchored prediction debt lowers coherence monotonically and routes isolated debt to verify', () => {
  const { organ, writes } = organFixture('seed-aura')
  let previousCoherence = Infinity
  for (const unanchoredPredictions of [0, 1, 2, 5, 1_000_000, Number.MAX_SAFE_INTEGER]) {
    const input = auraInputs({ unanchoredPredictions, observedSurpriseScores: [0] })
    const aura = computeAura(input)
    assert.equal(auraInputsComplete(input), true)
    assert.equal(organ.auraInputsComplete(input), true)
    assert.deepEqual(organ.computeAura(input), aura)
    assert.equal(validateAuraVector(aura), true)
    assert.equal(aura.vector.coherence, 1 / (1 + 0.2 * unanchoredPredictions))
    assert.ok(aura.vector.coherence < previousCoherence)
    previousCoherence = aura.vector.coherence
    for (const value of Object.values(aura.vector)) assert.ok(Number.isFinite(value) && value >= 0 && value <= 1)
    assert.equal(aura.vector.surprisePressure, 0, 'Missing anchors do not establish inaccurate predictions')
    assert.equal(aura.vector.driftRisk, unanchoredPredictions > 0 ? 0.4 : 0)
    assert.equal(aura.vector.wakeUrgency, unanchoredPredictions > 0 ? 0.4 : 0)
    assert.equal(aura.recommendedFocus, unanchoredPredictions > 0 ? 'verify' : 'rest')
    assert.deepEqual(aura.salience, [{ kind: unanchoredPredictions > 0 ? 'unanchored-claim' : 'clean-state',
      targetId: input.ballId, score: unanchoredPredictions > 0 ? 0.4 : 1,
      code: unanchoredPredictions > 0 ? 'unanchored-predictions' : 'all-signals-clear' }])
  }
  assert.equal(writes.length, 0)
})

test('unanchored prediction debt compounds evidence gaps without replacing calibration or urgency precedence', () => {
  const { organ, writes } = organFixture('seed-aura')
  const ratios = { reachableDagNodes: 3, declaredDagNodes: 4, verifiedReceipts: 1, totalReceipts: 2, activeOrgans: 2, declaredOrgans: 4 }
  const unanchored = computeAura(auraInputs({ ...ratios, unanchoredPredictions: 1 }))
  assert.equal(unanchored.vector.coherence, (0.75 * 0.5 * 0.5) * (1 / 1.2))
  assert.equal(unanchored.recommendedFocus, 'verify')
  assert.deepEqual(organ.computeAura(auraInputs({ ...ratios, unanchoredPredictions: 1 })), unanchored)
  for (const [overrides, focus] of [
    [{ observedSurpriseScores: [10] }, 'verify'],
    [{ observedSurpriseScores: [100] }, 'escalate-to-owner'],
    [{ staleHeartbeatRatio: 0.7 }, 'escalate-to-owner'],
    [{ handOffEpochMismatch: true }, 'escalate-to-owner'],
    [{ pendingWakes: 2, lastRollbackAgeEpochs: 1 }, 'escalate-to-owner'],
  ]) {
    const anchored = computeAura(auraInputs(overrides))
    const debt = computeAura(auraInputs({ ...overrides, unanchoredPredictions: 1 }))
    assert.deepEqual(organ.computeAura(auraInputs(overrides)), anchored)
    assert.deepEqual(organ.computeAura(auraInputs({ ...overrides, unanchoredPredictions: 1 })), debt)
    assert.equal(debt.vector.surprisePressure, anchored.vector.surprisePressure)
    assert.equal(debt.recommendedFocus, focus)
    assert.equal(validateAuraVector(debt), true)
  }
  assert.equal(writes.length, 0)
})

test('unanchored prediction counts require finite nonnegative safe integers', () => {
  const { organ, writes } = organFixture('seed-aura')
  for (const unanchoredPredictions of [undefined, null, '1', true, {}, NaN, Infinity, -Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    const input = auraInputs({ unanchoredPredictions })
    assert.equal(auraInputsComplete(input), false)
    assert.equal(organ.auraInputsComplete(input), false)
    assert.throws(() => computeAura(input), { code: 'AURA_INPUTS_INCOMPLETE' })
    assert.throws(() => organ.computeAura(input), { code: 'AURA_INPUTS_INCOMPLETE' })
  }
  assert.equal(writes.length, 0)
})

test('zero denominators and unavailable signals never become a calm pure Aura', () => {
  const { organ } = organFixture('seed-aura')
  const cases = [{ reachableDagNodes: 0, declaredDagNodes: 0 }, { verifiedReceipts: 0, totalReceipts: 0 }, { activeOrgans: 0, declaredOrgans: 0 },
    { declaredOrgans: undefined }, { reachableDagNodes: NaN }, { verifiedReceipts: Infinity }, { activeOrgans: 21 },
    { observedSurpriseScores: [NaN] }, { observedSurpriseScores: Array(10001).fill(0) }, { observedSurpriseScores: Array(1) },
    { handOffEpochMismatch: 'false' }, { staleHeartbeatRatio: -1 }]
  for (const overrides of cases) {
    const input = auraInputs(overrides)
    assert.equal(auraInputsComplete(input), false)
    assert.equal(organ.auraInputsComplete(input), false)
    assert.throws(() => computeAura(input), { code: 'AURA_INPUTS_INCOMPLETE' })
    assert.throws(() => organ.computeAura(input), { code: 'AURA_INPUTS_INCOMPLETE' })
  }
  for (const overrides of [{ computedAt: NaN }, { ballId: 'invalid' }, { epoch: -1 }]) {
    assert.throws(() => organ.computeAura(auraInputs(overrides)))
    assert.throws(() => computeAura(auraInputs(overrides)))
  }
})

test('verified facts retain known counts while unavailable Aura remains explicitly incomplete', () => {
  const input = { ...auraInputs(), evidence: { status: 'complete' },
    facts: { receiptsByKind: {}, checkpointsTotal: 0, lastCheckpointSeq: null, lastCheckpointReceiptCount: null,
      receiptVerification: 'hash-and-chain', checkpointVerification: 'signature-and-receipt-prefix' },
    aura: { ...computeAura(auraInputs()), status: 'calm' } }
  assert.equal(projectVerifiedFacts('synthetic', input).auraStatus, 'calm')
  for (const change of [{ declaredDagNodes: 0, reachableDagNodes: 0 }, { totalReceipts: 0, verifiedReceipts: 0 },
    { declaredOrgans: 0, activeOrgans: 0 }, { observedSurpriseScores: undefined }, { aura: null }]) {
    const result = projectVerifiedFacts('synthetic', { ...input, ...change })
    assert.equal(result.ok, true)
    assert.equal(result.auraStatus, 'incomplete')
    assert.equal(result.receiptsVerified, change.verifiedReceipts ?? input.verifiedReceipts)
    assert.equal(result.wakeUrgency, null)
    assert.equal(result.ownerApproval, false)
    assert.equal(result.independentAudit, false)
  }
  assert.equal(projectVerifiedFacts('synthetic', { ...input, facts: null }).ok, false)
})

test('server and organ heartbeats agree on report precedence, timestamp parsing, and future-skew rejection', () => {
  const { organ } = organFixture('seed-aura')
  const assignment = { state: 'running', ticketId: 'synthetic-ticket', startedAt: NOW - 240000 }
  const cases = [
    [{ reports: [{ at: NOW - 120001 }, { at: NOW }] }, 0], [{ reportedAt: NOW }, 0],
    [{ reports: [{ at: null }], reportedAt: new Date(NOW).toISOString() }, 0],
    [{ heartbeatAt: NOW, reports: [{ at: NOW - 240000 }] }, 0],
    [{ reports: [{ at: NOW - 120001 }], reportedAt: NOW }, 1], [{ reportedAt: NOW + 300000 }, 0],
    [{ reports: [{ at: NOW + 300001 }] }, null], [{ reportedAt: NOW + 300001 }, null],
    [{ reports: [{ at: 'invalid' }], reportedAt: NOW }, null], [{ heartbeatAt: 'invalid', reportedAt: NOW }, null],
    [{ reportedAt: Infinity }, null], [{ reportedAt: false }, null],
  ]
  for (const [change, ratio] of cases) {
    const assignments = [{ ...assignment, ...change }]
    const expected = ratio === null ? null : { staleHeartbeatRatio: ratio, staleTickets: ratio }
    assert.deepEqual(staleHeartbeatFacts(assignments, NOW), expected)
    assert.deepEqual(organ.staleHeartbeatFacts(assignments, NOW), expected)
  }
  for (const assignments of [undefined, [null], [{ state: 'running' }]]) {
    assert.equal(staleHeartbeatFacts(assignments, NOW), null)
    assert.equal(organ.staleHeartbeatFacts(assignments, NOW), null)
  }
})

test('canonical receipt calibration is relative error, never task success or a legacy clamp', () => {
  const aura = organFixture('seed-aura').organ
  const predict = organFixture('seed-predict').organ
  for (const [expected, observed, error] of [[0, 0, 0], [0, 2, 2], [10, 30, 2], [-4, 2, 1.5], [0.25, 0.5, 0.25], [1, 1000, 999]]) {
    assert.equal(predictionError(expected, observed), error)
    assert.equal(aura.predictionError(expected, observed), error)
    assert.equal(predict.predictionError(expected, observed), error)
  }
  for (const [expected, observed] of [[NaN, 1], [1, Infinity], [-0, 0], [0, -0], [Number.MAX_VALUE, -Number.MAX_VALUE], ['2', 2]]) {
    assert.equal(predictionError(expected, observed), null)
    assert.equal(aura.predictionError(expected, observed), null)
    assert.equal(predict.predictionError(expected, observed), null)
  }
})

const SEED = '/dsh/home/auma/seed'
const HEAD_FILE = '/dsh/home/balls/HEAD.json'
const PREDICTIONS = SEED + '/predict/predictions.jsonl'
const RECEIPTS = SEED + '/receipts.v3.jsonl'
const DAG = '/dsh/home/auma/memory/dag'
const hashText = text => nodeCrypto.createHash('sha256').update(text).digest('hex')

function appendSyntheticReceipt(files, kind, data) {
  const rows = (files.get(RECEIPTS) ?? '').split('\n').filter(Boolean).map(line => JSON.parse(line))
  const body = { schema: 'aukora.receipt.v3', seq: rows.length + 1, at: new Date(NOW).toISOString(),
    prevHash: rows.at(-1)?.leafHash ?? '0'.repeat(64), kind, data }
  const receipt = { ...body, leafHash: nodeCrypto.createHash('sha256').update(Buffer.from([0])).update(canonicalJson(body)).digest('hex') }
  files.set(RECEIPTS, [...rows, receipt].map(row => JSON.stringify(row)).join('\n') + '\n')
  return receipt
}

function auraOrganFixture() {
  const fixture = organFixture('seed-aura')
  const head = { ballId: 'a'.repeat(64), epoch: 157, entries: { enabled: { disabled: false }, disabled: { disabled: true } } }
  const body = { content: 'Synthetic memory', parentIds: [] }, node = { ...body, id: hashText(canonicalJson(body)) }
  fixture.files.set(HEAD_FILE, JSON.stringify(head))
  fixture.files.set('/dsh/home/auma/HANDOFF.md', `| epoch | **57** |\n| ballId | \`${head.ballId}\` |\n`)
  fixture.files.set(DAG + '/HEAD.json', JSON.stringify({ count: 1, heads: [node.id] }))
  fixture.files.set(DAG + '/' + node.id + '.json', JSON.stringify(node))
  fixture.files.set(SEED + '/discovery-corpus.v1.jsonl', '')
  fixture.files.set('/dsh/home/auma/superagent/state.json', JSON.stringify({ assignments: [] }))
  appendSyntheticReceipt(fixture.files, 'memory.dag.append', { nodeId: node.id, content: node.content })
  return { ...fixture, head, node }
}

test('seed-aura dry-run uses real synthetic evidence and incomplete evidence writes no file or receipt', async () => {
  const fixture = auraOrganFixture()
  const result = await fixture.organ.run({ action: 'dry_run', wake: { pendingWakes: 0 } })
  assert.equal(result.ok, true)
  assert.equal(result.aura.vector.coherence, 0.5, 'Disabled declared organs reduce coherence even with a complete DAG')
  assert.deepEqual(result.aura, computeAura({ ...result.inputs, computedAt: NOW, ballId: fixture.head.ballId, epoch: fixture.head.epoch }))
  assert.equal(result.written, false)
  assert.equal(fixture.writes.length, 0)
  const variants = [
    f => f.files.set(HEAD_FILE, JSON.stringify({ ...f.head, entries: {} })),
    f => { f.files.delete(DAG + '/' + f.node.id + '.json'); f.files.set(DAG + '/HEAD.json', JSON.stringify({ count: 0, heads: [] })) },
    f => f.files.set(RECEIPTS, ''),
    f => f.files.delete('/dsh/home/auma/superagent/state.json'),
    f => f.files.set('/dsh/home/auma/superagent/state.json', '{}'),
    f => f.files.set('/dsh/home/auma/superagent/state.json', JSON.stringify({ assignments: [{ state: 'running', reportedAt: NOW + 300001 }] })),
  ]
  for (const mutate of variants) {
    const f = auraOrganFixture(); mutate(f)
    let receiptCalls = 0
    const incomplete = await f.organ.run({ action: 'compute', wake: { pendingWakes: 0 } }, { organs: { call() { receiptCalls += 1; throw new Error('must not write') } } })
    assert.equal(incomplete.status, 'incomplete')
    assert.equal(incomplete.vector, null)
    assert.equal(incomplete.written, false)
    assert.ok(incomplete.gaps.length > 0)
    assert.equal(f.writes.length, 0)
    assert.equal(receiptCalls, 0)
  }
})

test('seed-predict observes canonical error separately from its legacy penalty and never reports task success', async () => {
  const fixture = organFixture('seed-predict')
  fixture.files.set(HEAD_FILE, JSON.stringify({ ballId: 'a'.repeat(64), epoch: 156, entries: {} }))
  const ctx = { organs: { async call(name, args) {
    assert.equal(name, 'seed-receipts')
    return { ok: true, receipt: appendSyntheticReceipt(fixture.files, args.kind, args.data) }
  } } }
  const target = { metric: 'declaredOrgans', expected: 2, targetBallId: 'b'.repeat(64), targetEpoch: 157 }
  const registration = await fixture.organ.run({ action: 'register', ...target, expectedEpoch: 99,
    expectedOrganCount: 99, expectedBallId: 'c'.repeat(64) }, ctx)
  assert.equal(registration.ok, true)
  fixture.files.set(HEAD_FILE, JSON.stringify({ ballId: target.targetBallId, epoch: target.targetEpoch, entries: { a: {}, b: {}, c: {}, d: {} } }))
  appendSyntheticReceipt(fixture.files, 'ball.promote', { ballId: target.targetBallId, epoch: target.targetEpoch })
  const observation = await fixture.organ.run({ action: 'observe', predictionHash: registration.predictionHash }, ctx)
  assert.equal(observation.ok, true)
  assert.equal(observation.receipt_error, 1)
  assert.equal(observation.surpriseScore, 1)
  assert.equal(observation.legacyPenaltyV0, 100)
  assert.equal(observation.calibrationVersion, 'receipt-error-v1')
  assert.equal(Object.hasOwn(observation, 'taskOutcome'), false)
  const rows = fixture.files.get(RECEIPTS).split('\n').filter(Boolean).map(line => JSON.parse(line))
  assert.equal(Object.hasOwn(rows.at(-1).data, 'surpriseScore'), false, 'Receipt readers recompute error from expected and observed')
  const exported = await fixture.organ.run({ action: 'trajectory_export' })
  assert.equal(exported.trajectories[0].receipt_error, 1)
  assert.equal(exported.summary.meanSurpriseScore, 1)
  assert.equal(exported.summary.meanLegacyPenaltyV0, 100)

  // Previous log generations remain readable, but their heuristic cannot enter the canonical mean.
  const legacy = [{ kind: 'prediction.register', predictionHash: 'legacy', expectedEpoch: 99 },
    { kind: 'prediction.observe', predictionHash: 'legacy', surpriseScore: 80, exceptionRuleCandidate: true }]
  fixture.files.set(PREDICTIONS, fixture.files.get(PREDICTIONS) + legacy.map(row => JSON.stringify(row)).join('\n') + '\n')
  const mixed = await fixture.organ.run({ action: 'trajectory_export' })
  assert.equal(mixed.summary.totalTrajectories, 2)
  assert.equal(mixed.summary.calibrationCount, 1)
  assert.equal(mixed.summary.meanSurpriseScore, 1)
  assert.equal(mixed.trajectories[1].receipt_error, null)
  assert.equal(mixed.trajectories[1].surpriseScore, null)
  assert.equal(mixed.trajectories[1].legacyPenaltyV0, 80)
})

test('predicted zero and observed zero indicate calibration only; legacy-only observations have no calibration', async () => {
  const fixture = organFixture('seed-predict')
  fixture.files.set(HEAD_FILE, JSON.stringify({ ballId: 'a'.repeat(64), epoch: 156, entries: {} }))
  const ctx = { organs: { async call(name, args) { return { ok: true, receipt: appendSyntheticReceipt(fixture.files, args.kind, args.data) } } } }
  const target = { metric: 'activeOrgans', expected: 0, targetBallId: 'b'.repeat(64), targetEpoch: 157 }
  const registration = await fixture.organ.run({ action: 'register', ...target }, ctx)
  fixture.files.set(HEAD_FILE, JSON.stringify({ ballId: target.targetBallId, epoch: target.targetEpoch, entries: { stopped: { disabled: true } } }))
  appendSyntheticReceipt(fixture.files, 'ball.promote', { ballId: target.targetBallId, epoch: target.targetEpoch })
  const observation = await fixture.organ.run({ action: 'observe', predictionHash: registration.predictionHash }, ctx)
  assert.equal(observation.receipt_error, 0)
  assert.equal(Object.hasOwn(observation, 'taskOutcome'), false)
  const legacy = await fixture.organ.run({ action: 'register', expectedEpoch: 100 })
  const observedLegacy = await fixture.organ.run({ action: 'observe', predictionHash: legacy.predictionHash })
  assert.equal(observedLegacy.receipt_error, null)
  assert.equal(observedLegacy.surpriseScore, null)
  assert.equal(observedLegacy.legacyPenaltyV0, 50)
})

async function pendingPredictionFixture() {
  const fixture = organFixture('seed-predict')
  fixture.files.set(HEAD_FILE, JSON.stringify({ ballId: 'a'.repeat(64), epoch: 156, entries: {} }))
  const ctx = { organs: { async call(name, args) {
    assert.equal(name, 'seed-receipts')
    return { ok: true, receipt: appendSyntheticReceipt(fixture.files, args.kind, args.data) }
  } } }
  const target = { metric: 'declaredOrgans', expected: 2, targetBallId: 'b'.repeat(64), targetEpoch: 157 }
  const registration = await fixture.organ.run({ action: 'register', ...target }, ctx)
  fixture.files.set(HEAD_FILE, JSON.stringify({ ballId: target.targetBallId, epoch: target.targetEpoch, entries: { a: {}, b: {}, c: {}, d: {} } }))
  appendSyntheticReceipt(fixture.files, 'ball.promote', { ballId: target.targetBallId, epoch: target.targetEpoch })
  return { ...fixture, ctx, target, registration,
    observe: (context = ctx) => fixture.organ.run({ action: 'observe', predictionHash: registration.predictionHash }, context) }
}

test('prediction observation rejects changed log expectations and binds exact receipt registration fields', async () => {
  for (const [field, changed] of [['expected', 4], ['metric', 'epoch'], ['targetEpoch', 58], ['targetBallId', 'c'.repeat(64)]]) {
    const fixture = await pendingPredictionFixture()
    const rows = fixture.files.get(PREDICTIONS).split('\n').filter(Boolean).map(line => JSON.parse(line))
    rows[0][field] = changed
    fixture.files.set(PREDICTIONS, rows.map(row => JSON.stringify(row)).join('\n') + '\n')
    const before = fixture.files.get(RECEIPTS), result = await fixture.observe()
    assert.equal(result.ok, false)
    assert.equal(result.error, 'PREDICTION_REGISTRATION_HASH_MISMATCH')
    assert.equal(fixture.files.get(RECEIPTS), before)
  }
  const mismatch = await pendingPredictionFixture()
  const receipts = mismatch.files.get(RECEIPTS).split('\n').filter(Boolean).map(line => JSON.parse(line))
  mismatch.files.set(RECEIPTS, '')
  for (const row of receipts) appendSyntheticReceipt(mismatch.files, row.kind,
    row.kind === 'prediction.register' ? { ...row.data, expected: 4 } : row.data)
  assert.equal((await mismatch.observe()).error, 'PREDICTION_REGISTER_UNANCHORED', 'Even a valid chain must bind the sealed expected value')
})

test('failed prediction receipt append is unanchored, leaves no observation log, and remains retryable', async () => {
  for (const outcome of ['rejected', 'committed-but-unacknowledged', 'acknowledged-without-commit']) {
    const fixture = await pendingPredictionFixture()
    const before = fixture.files.get(PREDICTIONS)
    const failed = await fixture.observe({ organs: { async call(name, args) {
      if (outcome === 'committed-but-unacknowledged') appendSyntheticReceipt(fixture.files, args.kind, args.data)
      return outcome === 'acknowledged-without-commit' ? { ok: true, receipt: { seq: 3, leafHash: 'f'.repeat(64) } } : { ok: false, error: 'SYNTHETIC_APPEND_FAILED' }
    } } })
    assert.equal(failed.ok, false)
    assert.equal(failed.calibrationStatus, 'unanchored')
    assert.equal(failed.receipt_error, null)
    assert.equal(failed.surpriseScore, null)
    assert.equal(failed.written, false)
    assert.equal(fixture.files.get(PREDICTIONS), before)
    assert.equal((await fixture.organ.run({ action: 'trajectory_export' })).summary.calibrationCount, 0)
    let retryAppends = 0
    const retried = await fixture.observe({ organs: { async call(name, args) { retryAppends += 1; return fixture.ctx.organs.call(name, args) } } })
    assert.equal(retried.ok, true)
    assert.equal(retried.receipt_error, 1)
    assert.equal(retryAppends, outcome === 'committed-but-unacknowledged' ? 0 : 1)
    const receipts = fixture.files.get(RECEIPTS).split('\n').filter(Boolean).map(line => JSON.parse(line))
    assert.equal(receipts.filter(row => row.kind === 'prediction.observe').length, 1)
  }
})

test('prediction export derives error from receipts and excludes missing, corrupt, duplicate, or wrongly ordered observations', async () => {
  const fixture = await pendingPredictionFixture()
  assert.equal((await fixture.observe()).ok, true)
  const originalLog = fixture.files.get(PREDICTIONS), originalReceipts = fixture.files.get(RECEIPTS)
  const logs = originalLog.split('\n').filter(Boolean).map(line => JSON.parse(line))
  Object.assign(logs[1], { observedMetric: 2, receipt_error: 0, surpriseScore: 0 })
  fixture.files.set(PREDICTIONS, logs.map(row => JSON.stringify(row)).join('\n') + '\n')
  assert.equal((await fixture.organ.run({ action: 'trajectory_export' })).trajectories[0].receipt_error, 1)
  const receipts = originalReceipts.split('\n').filter(Boolean).map(line => JSON.parse(line))
  const checkUnavailable = async () => {
    const exported = await fixture.organ.run({ action: 'trajectory_export' })
    assert.equal(exported.summary.calibrationCount, 0)
    assert.equal(exported.summary.meanSurpriseScore, null)
    assert.equal(exported.trajectories[0].calibrationStatus, 'unanchored')
    assert.equal(exported.trajectories[0].receipt_error, null)
  }
  fixture.files.set(RECEIPTS, receipts.slice(0, -1).map(row => JSON.stringify(row)).join('\n') + '\n')
  await checkUnavailable()
  fixture.files.set(RECEIPTS, originalReceipts.replace('"observed":4', '"observed":2'))
  await checkUnavailable()
  fixture.files.set(RECEIPTS, originalReceipts)
  appendSyntheticReceipt(fixture.files, 'prediction.observe', { ...receipts[2].data, observed: 2 })
  await checkUnavailable()
  fixture.files.set(RECEIPTS, '')
  for (const index of [0, 2, 1]) appendSyntheticReceipt(fixture.files, receipts[index].kind, receipts[index].data)
  await checkUnavailable()
  fixture.files.set(RECEIPTS, originalReceipts)
  logs[0].expected = 4
  fixture.files.set(PREDICTIONS, logs.map(row => JSON.stringify(row)).join('\n') + '\n')
  await checkUnavailable()
})

test('reconciliation refuses duplicate observation receipts rather than choosing the favorable error', async () => {
  const fixture = await pendingPredictionFixture()
  const data = { predictionId: fixture.registration.predictionHash, targetBallId: fixture.target.targetBallId,
    targetEpoch: fixture.target.targetEpoch, metric: fixture.target.metric, observed: 4 }
  appendSyntheticReceipt(fixture.files, 'prediction.observe', data)
  appendSyntheticReceipt(fixture.files, 'prediction.observe', { ...data, observed: 2 })
  const before = fixture.files.get(RECEIPTS)
  assert.equal((await fixture.observe()).error, 'PREDICTION_OBSERVATION_CONFLICT')
  assert.equal(fixture.files.get(RECEIPTS), before)
})

test('duplicate local registration rows cannot count one receipt trajectory twice', async () => {
  const fixture = await pendingPredictionFixture()
  await fixture.observe()
  const registeredLine = fixture.files.get(PREDICTIONS).split('\n')[0]
  fixture.files.set(PREDICTIONS, fixture.files.get(PREDICTIONS) + registeredLine + '\n')
  const exported = await fixture.organ.run({ action: 'trajectory_export' })
  assert.equal(exported.trajectories.length, 1)
  assert.equal(exported.summary.calibrationCount, 1)
  assert.equal(exported.summary.meanSurpriseScore, 1)
})

test('identical registration retries reuse verified receipt and local log even after the target is selected', async () => {
  const fixture = await pendingPredictionFixture()
  const log = fixture.files.get(PREDICTIONS), receipts = fixture.files.get(RECEIPTS)
  const repeated = await fixture.organ.run({ action: 'register', ...fixture.target }, { organs: { call() { throw new Error('must reuse existing receipt') } } })
  assert.equal(repeated.ok, true)
  assert.equal(repeated.predictionHash, fixture.registration.predictionHash)
  assert.deepEqual(repeated.receipt, fixture.registration.receipt)
  assert.equal(fixture.files.get(PREDICTIONS), log)
  assert.equal(fixture.files.get(RECEIPTS), receipts)
  assert.equal((await fixture.observe()).receipt_error, 1)
})

test('lost registration acknowledgments are recovered without duplicate receipts or log rows', async () => {
  for (const outcome of ['committed-but-unacknowledged', 'acknowledged-without-commit', 'rejected']) {
    const fixture = organFixture('seed-predict')
    fixture.files.set(HEAD_FILE, JSON.stringify({ ballId: 'a'.repeat(64), epoch: 156, entries: {} }))
    const args = { action: 'register', metric: 'declaredOrgans', expected: 2, targetBallId: 'b'.repeat(64), targetEpoch: 157 }
    const failed = await fixture.organ.run(args, { organs: { async call(name, input) {
      if (outcome === 'committed-but-unacknowledged') appendSyntheticReceipt(fixture.files, input.kind, input.data)
      return outcome === 'acknowledged-without-commit' ? { ok: true, receipt: { seq: 1, leafHash: 'f'.repeat(64) } } : { ok: false, error: 'SYNTHETIC_REGISTER_FAILED' }
    } } })
    assert.equal(failed.ok, false)
    assert.equal(failed.receipt, null)
    const log = fixture.files.get(PREDICTIONS)
    let appends = 0
    const retried = await fixture.organ.run(args, { organs: { async call(name, input) {
      appends += 1
      return { ok: true, receipt: appendSyntheticReceipt(fixture.files, input.kind, input.data) }
    } } })
    assert.equal(retried.ok, true)
    assert.equal(retried.predictionHash, failed.predictionHash)
    assert.equal(appends, outcome === 'committed-but-unacknowledged' ? 0 : 1)
    assert.equal(fixture.files.get(PREDICTIONS), log)
    const rows = fixture.files.get(RECEIPTS).split('\n').filter(Boolean).map(line => JSON.parse(line))
    assert.equal(rows.filter(row => row.kind === 'prediction.register').length, 1)
  }
})

test('ambiguous duplicate registration receipts remain an explicit refusal', async () => {
  const fixture = await pendingPredictionFixture()
  const registered = JSON.parse(fixture.files.get(RECEIPTS).split('\n')[0])
  appendSyntheticReceipt(fixture.files, registered.kind, registered.data)
  const before = fixture.files.get(RECEIPTS), log = fixture.files.get(PREDICTIONS)
  const result = await fixture.organ.run({ action: 'register', ...fixture.target }, fixture.ctx)
  assert.equal(result.ok, false)
  assert.equal(result.error, 'PREDICTION_REGISTRATION_CONFLICT')
  assert.equal(fixture.files.get(RECEIPTS), before)
  assert.equal(fixture.files.get(PREDICTIONS), log)
})

// Structural tripwire over the LIVE mirror organ(s): load contract only, never behaviour (see fixtures/organs/live-shape.mjs).
test('verified-facts: live mirror organs keep their tool-module load contract (structural only)', async () => {
  for (const name of ['seed-predict', 'seed-receipts']) await assertLiveOrganShape(assert, name)
})
