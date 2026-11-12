/**
 * Fixture checks for the discovery corpus and the Nostr projection.
 * These rows are not a live Pearl, relay, or MLS session.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { canonicalJson } from '../contract.ts'
import { nip01EventId, projectNostrMicroverse } from '../nostr-microverse.ts'
import { discoveryJsonl, projectDiscoveryCorpus, surpriseScore } from '../prediction.ts'
import type { NostrEventFields, ReceiptHistoryEntry } from '../types.ts'

const PARENT = '11'.repeat(32)
const TARGET = '22'.repeat(32)
const ZEROS = '0'.repeat(64)

function leafHashOf(payload: Record<string, unknown>): string {
  return createHash('sha256').update(Buffer.from([0x00])).update(canonicalJson(payload), 'utf8').digest('hex')
}

function chain(rows: ReadonlyArray<Pick<ReceiptHistoryEntry, 'seq' | 'kind' | 'data'>>): ReceiptHistoryEntry[] {
  let previous = ZEROS
  return rows.map((row, index) => {
    const payload = {
      schema: 'aukora.receipt.v3',
      seq: row.seq,
      at: `2026-11-08T00:00:${String(index).padStart(2, '0')}.000Z`,
      kind: row.kind,
      prevHash: previous,
      data: row.data,
      intact: true,
    }
    const leafHash = leafHashOf(payload)
    const entry = { ...payload, leafHash }
    previous = leafHash
    return entry
  })
}

function base(): ReceiptHistoryEntry[] {
  return chain([
    { seq: 1, kind: 'tree.patch', data: { ballId: PARENT, parentBallId: ZEROS, epoch: 142 } },
    { seq: 2, kind: 'prediction.register', data: { predictionId: 'exact', targetBallId: TARGET, targetEpoch: 143, metric: 'organs', expected: 4 } },
    { seq: 3, kind: 'ball.promote', data: { ballId: TARGET, parentBallId: PARENT, epoch: 143 } },
    { seq: 4, kind: 'prediction.observe', data: { predictionId: 'exact', targetBallId: TARGET, targetEpoch: 143, metric: 'organs', observed: 4 } },
    { seq: 5, kind: 'prediction.register', data: { predictionId: 'off', targetBallId: TARGET, targetEpoch: 143, metric: 'organs', expected: 4 } },
    { seq: 6, kind: 'ball.promote', data: { ballId: TARGET, parentBallId: PARENT, epoch: 143 } },
    { seq: 7, kind: 'prediction.observe', data: { predictionId: 'off', targetBallId: TARGET, targetEpoch: 143, metric: 'organs', observed: 6 } },
  ])
}

test('discovery corpus exports only linked triples and recomputes surprise', () => {
  const corpus = projectDiscoveryCorpus(base())
  assert.equal(corpus.chainIntact, true)
  assert.equal(corpus.leafRecomputed, true)
  assert.equal(corpus.summary.totalTrajectories, 2)
  assert.equal(corpus.summary.zeroSurpriseCount, 1)
  assert.equal(corpus.summary.surpriseCount, 1)
  assert.equal(corpus.summary.meanSurpriseScore, 0.25)
  const exact = corpus.records.find(record => record.predicted === record.observed)
  const off = corpus.records.find(record => record.observed === 6)
  assert.equal(exact?.surpriseScore, 0)
  assert.equal(exact?.exceptionRuleCandidate, false)
  assert.equal(off?.surpriseScore, surpriseScore(4, 6))
  assert.equal(off?.surpriseScore, 0.5)
  assert.equal(off?.exceptionRuleCandidate, true)
  assert.equal(off?.pearlId, TARGET)
  assert.equal(off?.epochBefore, 142)
  assert.equal(off?.epochAfter, 143)
  const lines = discoveryJsonl(corpus).trim().split('\n')
  assert.equal(lines.length, 2)
  assert.deepEqual(JSON.parse(lines[0] ?? '{}').trajectoryId, corpus.records[0]?.trajectoryId)
  const empty = projectDiscoveryCorpus([])
  assert.equal(empty.summary.totalTrajectories, 0)
  assert.equal(empty.summary.meanSurpriseScore, null)
  assert.equal(empty.chainIntact, true)
  assert.equal(discoveryJsonl(empty), '')
})

test('broken, duplicate, incomplete, and out-of-order prediction chains are not successes', () => {
  const rows = base()
  const broken = rows.map((row, index) => index === 3 ? { ...row, prevHash: 'b'.repeat(64) } : row)
  assert.equal(projectDiscoveryCorpus(broken).chainIntact, false)
  assert.equal(projectDiscoveryCorpus(broken).summary.totalTrajectories, 0)
  const last = rows[6]
  if (last === undefined) return
  const dupPayload = {
    schema: 'aukora.receipt.v3',
    seq: 8,
    at: '2026-11-08T00:00:08.000Z',
    kind: last.kind,
    prevHash: last.leafHash,
    data: last.data,
    intact: true,
  }
  const duplicate = [...rows, { ...dupPayload, leafHash: leafHashOf(dupPayload) }]
  const again = projectDiscoveryCorpus(duplicate)
  assert.equal(again.summary.totalTrajectories, 2)
  const incomplete = chain([
    { seq: 1, kind: 'tree.patch', data: { ballId: PARENT, parentBallId: ZEROS, epoch: 142 } },
    { seq: 2, kind: 'prediction.register', data: { predictionId: 'exact', targetBallId: TARGET, targetEpoch: 143, metric: 'organs', expected: 4 } },
    { seq: 3, kind: 'ball.promote', data: { ballId: TARGET, parentBallId: PARENT, epoch: 143 } },
    { seq: 4, kind: 'prediction.observe', data: { predictionId: 'exact', targetBallId: TARGET, targetEpoch: 143, metric: 'organs', observed: 4 } },
    { seq: 5, kind: 'prediction.register', data: { predictionId: 'off', targetBallId: TARGET, targetEpoch: 143, metric: 'organs', expected: 4 } },
    { seq: 6, kind: 'ball.promote', data: { ballId: TARGET, parentBallId: PARENT, epoch: 143 } },
  ])
  assert.equal(projectDiscoveryCorpus(incomplete).records.some(record => record.observed === 6), false)
  const unordered = chain([
    { seq: 1, kind: 'tree.patch', data: { ballId: PARENT, parentBallId: ZEROS, epoch: 142 } },
    { seq: 2, kind: 'ball.promote', data: { ballId: TARGET, parentBallId: PARENT, epoch: 143 } },
    { seq: 3, kind: 'prediction.register', data: { predictionId: 'late', targetBallId: TARGET, targetEpoch: 143, metric: 'organs', expected: 1 } },
    { seq: 4, kind: 'prediction.observe', data: { predictionId: 'late', targetBallId: TARGET, targetEpoch: 143, metric: 'organs', observed: 1 } },
  ])
  assert.equal(projectDiscoveryCorpus(unordered).summary.totalTrajectories, 0)
  const malformed = chain([
    { seq: 1, kind: 'tree.patch', data: { ballId: PARENT, parentBallId: ZEROS, epoch: 142 } },
    { seq: 2, kind: 'prediction.register', data: { predictionId: 'bad', targetBallId: TARGET, targetEpoch: 143, expected: 1 } },
    { seq: 3, kind: 'ball.promote', data: { ballId: TARGET, parentBallId: PARENT, epoch: 143 } },
    { seq: 4, kind: 'prediction.observe', data: { predictionId: 'bad', targetBallId: TARGET, targetEpoch: 143, metric: 'organs', observed: 1 } },
  ])
  assert.equal(projectDiscoveryCorpus(malformed).summary.totalTrajectories, 0)
  const rebound = chain([
    { seq: 1, kind: 'tree.patch', data: { ballId: PARENT, parentBallId: ZEROS, epoch: 142 } },
    { seq: 2, kind: 'prediction.register', data: { predictionId: 'mix', targetBallId: TARGET, targetEpoch: 143, metric: 'organs', expected: 1 } },
    { seq: 3, kind: 'ball.promote', data: { ballId: TARGET, parentBallId: PARENT, epoch: 143 } },
    { seq: 4, kind: 'prediction.observe', data: { predictionId: 'mix', targetBallId: TARGET, targetEpoch: 143, metric: 'other', observed: 1 } },
  ])
  assert.equal(projectDiscoveryCorpus(rebound).summary.totalTrajectories, 0)
})

test('Nostr ids are hashed, signatures are not inferred from hex, and MLS metadata is not encryption', async () => {
  const pubkey = 'ab'.repeat(32)
  const draft: NostrEventFields = {
    id: '11'.repeat(32),
    pubkey,
    created_at: 1_700_000_000,
    kind: 30078,
    tags: [['pearl', TARGET], ['receipt', PARENT], ['mandate', 'mnd-1'], ['trajectory', 'traj-1']],
    content: 'fixture',
    sig: 'cd'.repeat(64),
  }
  const id = await nip01EventId(draft)
  const event = { ...draft, id }
  const local = await projectNostrMicroverse({ event, tier: 'microverse-local', relayEvidence: { delivered: true } })
  assert.equal(local.grammar, 'valid')
  assert.equal(local.idValid, true)
  assert.equal(local.signatureValid, false)
  assert.equal(local.signatureStatus, 'invalid')
  assert.equal(local.deliveryVerified, false)
  assert.equal(local.deliveryStatus, 'local-not-delivery')
  assert.equal(local.pearlId, TARGET)
  assert.equal(local.reasons.includes('local-storage-not-delivery'), true)
  const mismatch = await projectNostrMicroverse({ event: { ...event, id: '22'.repeat(32) }, tier: 'microverse-local' })
  assert.equal(mismatch.idValid, false)
  const badSig = await projectNostrMicroverse({ event: { ...event, sig: 'zz' }, tier: 'microverse-local' })
  assert.equal(badSig.signatureValid, false)
  assert.equal(badSig.signatureStatus, 'malformed-sig')
  const relay = await projectNostrMicroverse({
    event,
    tier: 'macroverse-nip44-dm',
    relayEvidence: { eventId: id, relayUrl: 'wss://relay.example' },
  })
  assert.equal(relay.deliveryVerified, false)
  assert.equal(relay.nip44Verified, false)
  assert.equal(relay.reasons.includes('relay-evidence-not-validated'), true)
  assert.equal(relay.reasons.includes('nip44-verifier-unavailable'), true)
  const forged = await projectNostrMicroverse({
    event,
    tier: 'macroverse-marmot-mls',
    marmot: { groupId: 'g1', epoch: 2, cipherSuite: 'mls-1', memberPubkeys: [pubkey] },
    mlsEncrypted: true,
    forwardSecrecy: true,
    relayEvidence: { encrypted: true },
  })
  assert.equal(forged.marmotMetadata, 'present')
  assert.equal(forged.mlsEncryptionVerified, false)
  assert.equal(forged.mlsForwardSecrecyVerified, false)
  assert.equal(forged.deliveryVerified, false)
  assert.equal(forged.reasons.includes('marmot-metadata-not-mls'), true)
  assert.equal(forged.reasons.includes('forged-mls-flag-ignored'), true)
  const missing = await projectNostrMicroverse({ event, tier: 'macroverse-marmot-mls' })
  assert.equal(missing.marmotMetadata, 'absent')
  const partial = await projectNostrMicroverse({
    event,
    tier: 'macroverse-marmot-mls',
    marmot: { groupId: 'g1', epoch: -0, cipherSuite: 'mls-1', memberPubkeys: [pubkey] },
  })
  assert.equal(partial.marmotMetadata, 'malformed')
  const broken = await projectNostrMicroverse({ event: { id: 'nope' }, tier: 'microverse-local' })
  assert.equal(broken.grammar, 'malformed')
  assert.equal(broken.signatureValid, false)
})
