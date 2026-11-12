/** Source-only recall regressions. Organ files, callbacks, Ed25519 identities and all writes are synthetic. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as crypto from 'node:crypto'
import path from 'node:path'
import { canonicalJson } from '../deploy/cloudflare/src/owner-grant-policy.mjs'

const ROOT = '/dsh/home/auma/seed'
const RECEIPTS = ROOT + '/receipts.v3.jsonl'
const CHECKPOINTS = ROOT + '/checkpoints.v1.jsonl'
const CORPUS = ROOT + '/discovery-corpus.v1.jsonl'
const DAG = '/dsh/home/auma/memory/dag'
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
const code = name => readFileSync(new URL('../mirror/home/auma/seed/organs/' + name + '.js', import.meta.url), 'utf8')
const recallSource = code('seed-recall'), receiptSource = code('seed-receipts')
const historicalKey = 'baf94a77cb28f9575846eec092cfbd9094d4ac2c3af305a7fd8350d41c720c68'
const jsonl = rows => rows.map(row => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : '')
function signer() {
  const keys = crypto.generateKeyPairSync('ed25519')
  return { ...keys, publicKeyHex: keys.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex') }
}
function merkle(rows) {
  let level = rows.map(row => Buffer.from(row.leafHash, 'hex'))
  if (!level.length) return hash('')
  while (level.length > 1) {
    const next = []
    for (let i = 0; i < level.length; i += 2) next.push(i + 1 < level.length
      ? Buffer.from(hash(Buffer.concat([Buffer.from([1]), level[i], level[i + 1]])), 'hex') : level[i])
    level = next
  }
  return level[0].toString('hex')
}
function fixture({ pin = true, local = false, historical = false } = {}) {
  const key = signer(), files = new Map(), writes = [], calls = [], rows = [], checkpoints = []
  const faults = { read: null }, nodes = []
  const fs = {
    existsSync: name => files.has(name),
    readFileSync(name, encoding) {
      if (faults.read === name) throw new Error('SYNTHETIC_READ_FAILED')
      if (!files.has(name)) throw Object.assign(new Error('SYNTHETIC_ABSENT'), { code: 'ENOENT' })
      const bytes = encoding ? files.get(name) : Buffer.from(files.get(name))
      if (faults.afterRead) faults.afterRead(name)
      return bytes
    },
    writeFileSync(name, data) { writes.push(name); files.set(name, String(data)) },
    mkdirSync() {},
    readdirSync(dir) { return [...files.keys()].filter(name => name.startsWith(dir + '/')).map(name => name.slice(dir.length + 1)) },
  }
  function load(source) {
    const module = { exports: {} }
    new Function('module', 'require', 'Buffer', source)(module, name => {
      if (name === 'fs' || name === 'node:fs') return fs
      if (name === 'path' || name === 'node:path') return path
      if (name === 'crypto' || name === 'node:crypto') return crypto
      throw new Error('UNAPPROVED_SYNTHETIC_DEPENDENCY: ' + name)
    }, Buffer)
    return module.exports
  }
  const receipt = load(historical ? receiptSource.replace(historicalKey, key.publicKeyHex) : receiptSource)
  const recall = load(recallSource)
  const policy = { ok: true, schema: 'aukora.checkpoint-policy.v1', ranges: [
    { firstSeq: 1, lastSeq: 14, envelope: 'v1', publicKeyHex: key.publicKeyHex },
  ] }
  const verifyContext = { fs, ...(pin ? { checkpointPolicy: { async read() { return structuredClone(policy) } } } : {}) }
  const ctx = { organs: { async call(name, args) {
    calls.push([name, args]); assert.equal(name, 'seed-receipts'); assert.deepEqual(args, { action: 'verify' })
    return receipt.run(args, verifyContext)
  } } }
  if (local) files.set(ROOT + '/ed25519-keypair.json', JSON.stringify({ publicKeyHex: key.publicKeyHex }))
  const f = { key, files, writes, calls, rows, checkpoints, nodes, faults, ctx, policy,
    verify: () => receipt.run({ action: 'verify' }, verifyContext),
    run: (action = 'recall', args = {}, context = ctx) => recall.run({ action, ...args }, context),
    append(kind, data) {
      const payload = { schema: 'aukora.receipt.v3', seq: rows.length + 1, at: '2026-11-09T00:00:00.000Z',
        kind, data, prevHash: rows.at(-1)?.leafHash || '0'.repeat(64) }
      const row = { ...payload, leafHash: hash(Buffer.concat([Buffer.from([0]), Buffer.from(canonicalJson(payload))])) }
      rows.push(row); files.set(RECEIPTS, jsonl(rows)); return row
    },
    node(body = {}, anchor = {}) {
      const payload = { kind: 'fact', key: 'synthetic-' + nodes.length, content: 'Synthetic memory retained ' + nodes.length,
        tags: [], parentIds: [], receiptHash: null, ...body }
      const node = { ...payload, id: hash(canonicalJson(payload)) }
      nodes.push(node); files.set(DAG + '/' + node.id + '.json', JSON.stringify(node))
      files.set(DAG + '/HEAD.json', JSON.stringify({ heads: nodes.map(n => n.id), count: nodes.length }))
      if (anchor !== false) f.append('memory.dag.append', { nodeId: node.id, kind: node.kind, parentIds: node.parentIds || node.parents,
        payloadHash: hash(canonicalJson({ kind: node.kind, key: node.key, content: node.content, tags: node.tags })), ...anchor })
      return node
    },
    checkpoint({ count = rows.length, root = merkle(rows.slice(0, count)), signingKey = key, badSignature = false } = {}) {
      const body = { schema: 'aukora.edge-checkpoint.v1', seq: checkpoints.length + 1, receiptCount: count,
        lastReceiptHash: count ? rows[count - 1].leafHash : '0'.repeat(64), merkleRoot: root,
        prevCheckpointHash: checkpoints.at(-1)?.checkpointHash || null }
      const publicKeyHex = signingKey.publicKeyHex
      const signatureHex = badSignature ? '0'.repeat(128) : crypto.sign(null,
        Buffer.from('aukora.x5.edge-head.v1\0' + canonicalJson(body)), signingKey.privateKey).toString('hex')
      const cp = { body, publicKeyHex, signatureHex, checkpointHash: hash(canonicalJson({ body, publicKeyHex, signatureHex })) }
      checkpoints.push(cp); files.set(CHECKPOINTS, jsonl(checkpoints)); return cp
    },
  }
  return f
}
function assertUnverified(brief, reason) {
  assert.equal(brief.ok, true)
  assert.equal(brief.receiptChain.verified, false)
  assert.equal(brief.receiptChain.status, 'unverified')
  if (reason) assert.equal(brief.receiptChain.reason, reason)
  assert.equal(brief.verifiedNodeCount, 0)
  assert.equal(brief.verifiedTrajectoryCount, 0)
  assert.deepEqual(brief.relevantMemories, [])
}

for (const emptyCheckpoint of [false, true]) test('Round26 unsigned consistent receipt log stays unverified, checkpoint file empty=' + emptyCheckpoint, async () => {
  const f = fixture(); const node = f.node()
  if (emptyCheckpoint) f.files.set(CHECKPOINTS, '')
  const before = new Map(f.files)
  const brief = await f.run()
  assertUnverified(brief, 'CHECKPOINT_MISSING')
  assert.equal(brief.receiptChain.intact, true)
  assert.equal(brief.receiptChain.receipts, 1)
  assert.equal(brief.unverifiedMemories[0].text, node.content + ' ')
  assert.deepEqual(f.files, before); assert.deepEqual(f.writes, [])
  assert.equal((await f.run('corpus')).ok, false)
  assert.equal(f.files.has(CORPUS), false)
  const context = await f.run('context')
  assert.equal(context.clean, false); assert.equal(context.unanchoredCount, 1)
  assert.match(f.files.get(ROOT + '/CONTEXT.unverified.md'), /Synthetic memory retained 0/)
  assert.match(f.files.get(ROOT + '/CONTEXT.md'), /not verified/)
  for (const [name, bytes] of before) assert.equal(f.files.get(name), bytes)
})

for (const mode of ['absent', 'throws', 'rejects']) test('Round26 verifier ' + mode + ' preserves readable unverified text', async () => {
  const f = fixture(); f.node(); f.checkpoint()
  if (mode === 'absent') delete f.ctx.organs
  if (mode === 'throws') f.ctx.organs.call = async () => { throw new Error('SYNTHETIC_UNAVAILABLE') }
  if (mode === 'rejects') f.ctx.organs.call = async () => ({ ok: false, stage: 'synthetic-unavailable' })
  const result = await f.run()
  assertUnverified(result, mode === 'rejects' ? 'RECEIPT_VERIFICATION_FAILED' : 'RECEIPT_VERIFIER_UNAVAILABLE')
  assert.equal(result.unverifiedMemories.length, 1); assert.equal(result.receiptChain.receipts, 1)
  assert.deepEqual(f.writes, [])
})

test('Round26 caller trust flags and fabricated verification arguments are not a capability', async () => {
  const f = fixture(); f.node(); f.checkpoint()
  const fabricated = await f.verify()
  assertUnverified(await f.run('recall', { verified: true, signerAnchored: true, receiptVerification: fabricated,
    organs: f.ctx.organs, checkpointPolicy: { read: async () => f.policy } }, {}), 'RECEIPT_VERIFIER_UNAVAILABLE')
})

for (const [change, stage] of [
  ['signature', 'ed25519-signature'], ['root', 'merkle-root'], ['hash', 'checkpoint-hash'], ['signer', 'checkpoint-signer'],
]) test('Round26 checkpoint ' + change + ' tampering cannot admit recall', async () => {
  const f = fixture(); f.node()
  const cp = f.checkpoint({ badSignature: change === 'signature', ...(change === 'root' ? { root: 'f'.repeat(64) } : {}),
    ...(change === 'signer' ? { signingKey: signer() } : {}) })
  if (change === 'hash') { cp.checkpointHash = 'a'.repeat(64); f.files.set(CHECKPOINTS, jsonl([cp])) }
  const result = await f.run()
  assertUnverified(result, 'RECEIPT_VERIFICATION_FAILED'); assert.equal(result.receiptChain.verificationStage, stage)
  assert.equal((await f.run('context')).clean, false); assert.equal((await f.run('corpus')).ok, false)
})

for (const historical of [false, true]) test('Round26 signed ' + (historical ? 'historical' : 'local') + ' identity without independent pin remains untrusted', async () => {
  const f = fixture({ pin: false, local: !historical, historical }); f.node(); f.checkpoint()
  assertUnverified(await f.run(), 'CHECKPOINT_SIGNER_UNTRUSTED')
})

test('Round26 a mismatched independent pin does not upgrade a local signer', async () => {
  const f = fixture({ local: true }); f.node(); f.checkpoint(); f.policy.ranges[0].publicKeyHex = signer().publicKeyHex
  assertUnverified(await f.run(), 'CHECKPOINT_SIGNER_UNTRUSTED')
})

test('Round26 only the checkpoint-covered receipt prefix admits nodes; uncovered suffix prevents clean context and corpus', async () => {
  const f = fixture(), covered = f.node(); f.checkpoint(); const uncovered = f.node()
  const result = await f.run()
  assert.equal(result.receiptChain.verified, false)
  assert.equal(result.receiptChain.reason, 'CHECKPOINT_RECEIPTS_UNCOVERED')
  assert.equal(result.receiptChain.coveredReceipts, 1)
  assert.equal(result.verifiedNodeCount, 1)
  assert.equal(result.relevantMemories[0].id, covered.id)
  assert.equal(result.unverifiedMemories[0].id, uncovered.id)
  assert.equal((await f.run('context')).clean, false); assert.equal((await f.run('corpus')).ok, false)
})

for (const [anchor, reason] of [
  [{ kind: 'other' }, 'APPEND_LEAF_CONTENT_MISMATCH'], [{ content: 'other' }, 'APPEND_LEAF_CONTENT_MISMATCH'],
  [{ summary: 'other' }, 'APPEND_LEAF_CONTENT_MISMATCH'], [{ parentIds: ['a'.repeat(64)] }, 'APPEND_LEAF_PARENTS_MISMATCH'],
  [{ parentIds: null }, 'APPEND_LEAF_PARENTS_MISMATCH'], [{ payloadHash: 'f'.repeat(64) }, 'APPEND_LEAF_PAYLOAD_MISMATCH'],
  [{ id: 'b'.repeat(64) }, 'APPEND_LEAF_ID_MISMATCH'],
]) test('Round26 supplied append field must agree: ' + JSON.stringify(anchor), async () => {
  const f = fixture(); f.node({}, anchor); f.checkpoint()
  const result = await f.run()
  assert.equal(result.receiptChain.verified, true); assert.equal(result.verifiedNodeCount, 0)
  assert.equal(result.unverifiedMemories[0].reason, reason)
  assert.equal((await f.run('context')).clean, false)
})

test('Round26 conflicting node parents aliases cannot agree with the supplied append parents', async () => {
  const f = fixture(); f.node({ parents: ['a'.repeat(64)] }); f.checkpoint()
  assert.equal((await f.run()).unverifiedMemories[0].reason, 'APPEND_LEAF_PARENTS_MISMATCH')
})

for (const file of [RECEIPTS, CHECKPOINTS]) test('Round26 stale callback is rejected for changed exact bytes: ' + path.basename(file), async () => {
  const f = fixture(); f.node(); f.checkpoint(); const old = await f.verify()
  f.files.set(file, ' ' + f.files.get(file)); f.ctx.organs.call = async () => old
  assertUnverified(await f.run(), 'RECEIPT_VERIFICATION_UNBOUND')
})

for (const file of [RECEIPTS, CHECKPOINTS]) test('Round26 changed bytes while verification awaits cannot produce clean context: ' + path.basename(file), async () => {
  const f = fixture(); f.node(); f.checkpoint()
  f.ctx.organs.call = async () => { const proof = await f.verify(); f.files.set(file, ' ' + f.files.get(file)); return proof }
  const result = await f.run('context')
  assert.equal(result.clean, false); assertUnverified(result.brief, 'RECEIPT_SNAPSHOT_CHANGED')
})

test('Round26 old verifier counts without exact log binding are insufficient', async () => {
  const f = fixture(); f.node(); f.checkpoint()
  f.ctx.organs.call = async () => { const result = await f.verify(); delete result.receiptSnapshot; return result }
  assertUnverified(await f.run(), 'RECEIPT_VERIFICATION_UNBOUND')
})

test('Round26 absent logs differ from present empty logs in verifier binding', async () => {
  const f = fixture(); const proof = await f.verify(); f.files.set(RECEIPTS, ''); f.ctx.organs.call = async () => proof
  assertUnverified(await f.run(), 'RECEIPT_VERIFICATION_UNBOUND')
})

for (const invalid of ['{', 'null\n']) test('Round26 unreadable receipt logs are explicit, not verified empty histories: ' + invalid, async () => {
  const f = fixture(); f.node(); f.files.set(RECEIPTS, invalid)
  const result = await f.run(); assertUnverified(result)
  assert.equal(result.receiptChain.intact, false); assert.equal(result.receiptChain.receipts, null)
  assert.equal(result.unverifiedMemories.length, 1); assert.deepEqual(f.calls, [])
})

test('Round26 unavailable checkpoint bytes do not erase memory records', async () => {
  const f = fixture(); f.node(); f.checkpoint(); f.faults.read = CHECKPOINTS
  const result = await f.run(); assertUnverified(result, 'RECEIPT_LOGS_UNREADABLE')
  assert.equal(result.unverifiedMemories.length, 1)
})

test('Round26 independently verified exact coverage yields clean context but never owner consent', async () => {
  const f = fixture(); const node = f.node({ parentIds: undefined, parents: [] }); f.checkpoint()
  const before = new Map(f.files), brief = await f.run()
  assert.equal(brief.receiptChain.verified, true); assert.equal(brief.verifiedNodeCount, 1)
  assert.equal(brief.relevantMemories[0].text, node.content + ' '); assert.deepEqual(brief.unverifiedMemories, [])
  assert.deepEqual(f.writes, []); assert.deepEqual(f.files, before)
  assert.equal((await f.run('context')).clean, true)
  assert.match(f.files.get(ROOT + '/CONTEXT.md'), /not owner approval or proof the content is true/)
  assert.equal((await f.run('corpus')).ok, true)
  for (const [name, bytes] of before) assert.equal(f.files.get(name), bytes)
})

test('Round26 prediction records become verified trajectories only when the observation is independently covered', async () => {
  const f = fixture(); f.node()
  const parentBallId = 'a'.repeat(64), targetBallId = 'b'.repeat(64)
  f.append('seed.bootstrap', { ballId: parentBallId, epoch: 1 })
  f.append('prediction.register', { predictionId: 'synthetic', targetBallId, targetEpoch: 2, metric: 'syntheticMetric', expected: 3 })
  f.append('ball.promote', { ballId: targetBallId, epoch: 2, parentBallId }); f.checkpoint()
  f.append('prediction.observe', { predictionId: 'synthetic', targetBallId, targetEpoch: 2, metric: 'syntheticMetric', observed: 7 })
  const unverified = await f.run()
  assert.equal(unverified.verifiedTrajectoryCount, 0); assert.equal(unverified.unverifiedTrajectories.length, 1)
  assert.equal((await f.run('corpus')).ok, false)
  f.checkpoint()
  const verified = await f.run()
  assert.equal(verified.verifiedTrajectoryCount, 1); assert.equal(verified.unverifiedTrajectories.length, 0)
  assert.equal(verified.highSurpriseLessons[0].surpriseScore, 4 / 3)
  assert.equal((await f.run('corpus')).count, 1)
  assert.equal(JSON.parse(f.files.get(CORPUS)).observeReceiptHash, f.rows.at(-1).leafHash)
})

test('Round26 Pearl unsigned recall case and scar reference agree with the revised gate', () => {
  const source = code('seed-pearl')
  assert.equal(source.includes('recall.anchored-clean'), false)
  assert.equal(source.split('recall.unsigned-not-clean').length - 1, 2)
  assert.match(source, /id: 'recall\.unsigned-not-clean'.*expect: \{ ok: true, clean: false, unanchoredCount: 1 \}/)
})

for (const action of ['recall', 'context', 'corpus']) for (const file of [RECEIPTS, CHECKPOINTS]) {
  test('Round26 final await gap invalidates stale ' + action + ': ' + path.basename(file), async () => {
    const f = fixture(); f.node(); f.checkpoint(); let reads = 0
    f.faults.afterRead = name => {
      if (name === file && ++reads === 3) queueMicrotask(() => f.files.set(file, ' ' + f.files.get(file)))
    }
    const result = await f.run(action)
    if (action === 'corpus') {
      assert.equal(result.ok, false); assert.equal(result.error, 'RECEIPT_SNAPSHOT_CHANGED')
      assert.equal(f.files.has(CORPUS), false)
    } else {
      if (action === 'context') assert.equal(result.clean, false)
      assertUnverified(action === 'context' ? result.brief : result, 'RECEIPT_SNAPSHOT_CHANGED')
    }
  })
}

for (const field of ['checkpointReceiptCount', 'latestCheckpointHash', 'checkpointsVerified']) {
  test('Round26 recall rejects verifier metadata inconsistent with its captured checkpoint: ' + field, async () => {
    const f = fixture(); f.node(); f.checkpoint(); f.node()
    f.ctx.organs.call = async () => {
      const proof = await f.verify()
      proof[field] = field === 'latestCheckpointHash' ? 'f'.repeat(64) : 2
      return proof
    }
    assertUnverified(await f.run(), field === 'checkpointsVerified' ? 'RECEIPT_VERIFICATION_UNBOUND' : 'CHECKPOINT_COVERAGE_INVALID')
  })
}

test('Round26 legacy append fields may be absent but supplied id aliases must still bind the node', async () => {
  const f = fixture(), node = f.node({}, false)
  f.append('memory.dag.append', { id: node.id }); f.checkpoint()
  assert.equal((await f.run('context')).clean, true)
})

function predictionFixture(expected, observed) {
  const f = fixture(); f.node()
  const parentBallId = 'c'.repeat(64), targetBallId = 'd'.repeat(64)
  f.append('seed.bootstrap', { ballId: parentBallId, epoch: 10 })
  f.append('prediction.register', { predictionId: 'arithmetic', targetBallId, targetEpoch: 11, metric: 'syntheticArithmetic', expected })
  f.append('ball.promote', { ballId: targetBallId, epoch: 11, parentBallId })
  f.append('prediction.observe', { predictionId: 'arithmetic', targetBallId, targetEpoch: 11, metric: 'syntheticArithmetic', observed })
  f.checkpoint(); return f
}

for (const [expected, observed] of [[Number.MAX_VALUE, -Number.MAX_VALUE], [-Number.MAX_VALUE, Number.MAX_VALUE]]) {
  test('Round26 nonfinite derived prediction arithmetic is an explicit unavailable gap: ' + expected, async () => {
    const f = predictionFixture(expected, observed), before = new Map(f.files)
    const brief = await f.run()
    assert.equal(brief.receiptChain.verified, true, 'signed records still verify independently of derived arithmetic')
    assert.equal(brief.verifiedTrajectoryCount, 0)
    assert.equal(brief.highSurpriseCount, 0)
    assert.equal(brief.unverifiedTrajectories.length, 1)
    const gap = brief.unverifiedTrajectories[0]
    assert.equal(gap.reason, 'PREDICTION_ARITHMETIC_NONFINITE')
    assert.equal(gap.arithmeticStatus, 'unavailable')
    assert.equal(gap.predicted, expected); assert.equal(gap.observed, observed)
    assert.equal(Object.hasOwn(gap, 'surpriseScore'), false, 'unavailable arithmetic is neither zero nor a serialized null score')
    assert.equal(Object.hasOwn(gap, 'exceptionRuleCandidate'), false)
    assert.deepEqual(f.files, before); assert.deepEqual(f.writes, [])
    const context = await f.run('context')
    assert.equal(context.clean, false)
    assert.match(f.files.get(ROOT + '/CONTEXT.unverified.md'), /PREDICTION_ARITHMETIC_NONFINITE/)
    const corpus = await f.run('corpus')
    assert.equal(corpus.ok, false); assert.equal(corpus.error, 'PREDICTION_ARITHMETIC_NONFINITE')
    assert.equal(corpus.gaps[0].trajectoryId, gap.trajectoryId)
    assert.equal(f.files.has(CORPUS), false)
    for (const [name, bytes] of before) assert.equal(f.files.get(name), bytes)
  })
}

for (const [expected, observed, score] of [[3, 7, 4 / 3], [Number.MAX_VALUE, Number.MAX_VALUE, 0],
  [Number.MAX_VALUE, 0, 1], [-Number.MAX_VALUE, 0, 1], [0, Number.MAX_VALUE, Number.MAX_VALUE]]) {
  test('Round26 finite derived prediction arithmetic preserves the historical score: ' + expected + '/' + observed, async () => {
    const f = predictionFixture(expected, observed), brief = await f.run()
    assert.equal(brief.verifiedTrajectoryCount, 1); assert.equal(brief.unverifiedTrajectories.length, 0)
    assert.equal((await f.run('context')).clean, true)
    assert.equal((await f.run('corpus')).ok, true)
    const row = JSON.parse(f.files.get(CORPUS))
    assert.equal(row.surpriseScore, score); assert.equal(row.exceptionRuleCandidate, score > 0)
    assert.equal(Number.isFinite(row.surpriseScore), true)
  })
}
