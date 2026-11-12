/** Late-checkpoint policy outages use only synthetic in-memory logs and ephemeral test signers. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as crypto from 'node:crypto'
import path from 'node:path'

const ROOT = '/dsh/home/auma/seed'
const RECEIPTS = ROOT + '/receipts.v3.jsonl'
const CHECKPOINTS = ROOT + '/checkpoints.v1.jsonl'
const KEYPAIR = ROOT + '/ed25519-keypair.json'
const source = readFileSync(new URL('../mirror/home/auma/seed/organs/seed-receipts.js', import.meta.url), 'utf8')
const canonical = value => value === null || typeof value !== 'object' ? JSON.stringify(value)
  : Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']'
    : '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}'
const hash = value => crypto.createHash('sha256').update(value).digest('hex')
const hex = value => Buffer.from(value).toString('hex')
const jsonl = rows => rows.map(row => JSON.stringify(row)).join('\n') + '\n'
function merkle(leaves) {
  let level = leaves.map(leaf => Buffer.from(leaf, 'hex'))
  while (level.length > 1) {
    const next = []
    for (let i = 0; i < level.length; i += 2) next.push(i + 1 === level.length ? level[i]
      : Buffer.from(hash(Buffer.concat([Buffer.from([1]), level[i], level[i + 1]])), 'hex'))
    level = next
  }
  return hex(level[0])
}

async function fixture(count = 15) {
  const key = await crypto.webcrypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])
  const publicKeyHex = hex(await crypto.webcrypto.subtle.exportKey('raw', key.publicKey))
  const files = new Map(), writes = [], receipts = [], checkpoints = []
  const fs = {
    existsSync: filename => files.has(filename),
    readFileSync(filename) {
      assert.ok([RECEIPTS, CHECKPOINTS, KEYPAIR].includes(filename), 'only synthetic fixture paths may be read')
      if (!files.has(filename)) throw new Error('SYNTHETIC_FILE_ABSENT')
      return files.get(filename)
    },
    writeFileSync(filename, value) { writes.push(filename); files.set(filename, String(value)) },
    mkdirSync() {},
  }
  const module = { exports: {} }
  new Function('module', 'require', 'Buffer', source)(module, name => {
    if (name === 'fs') return fs
    if (name === 'crypto') return crypto
    if (name === 'path') return path
    throw new Error('UNAPPROVED_SYNTHETIC_DEPENDENCY: ' + name)
  }, Buffer)
  async function seal(body) {
    const signatureHex = hex(await crypto.webcrypto.subtle.sign('Ed25519', key.privateKey,
      Buffer.from('aukora.x5.edge-head.v1\0' + canonical(body))))
    return { body, publicKeyHex, signatureHex,
      checkpointHash: hash(canonical({ body, publicKeyHex, signatureHex })) }
  }
  for (let seq = 1; seq <= count; seq++) {
    const payload = { schema: 'aukora.receipt.v3', seq, at: '2026-11-09T00:00:00.000Z',
      kind: 'synthetic.round27', prevHash: receipts.at(-1)?.leafHash ?? '0'.repeat(64), data: {} }
    receipts.push({ ...payload, leafHash: hash(Buffer.concat([Buffer.from([0]), Buffer.from(canonical(payload))])) })
    checkpoints.push(await seal({ schema: 'aukora.edge-checkpoint.v1', seq, at: payload.at,
      receiptCount: seq, lastReceiptHash: receipts.at(-1).leafHash,
      merkleRoot: merkle(receipts.map(row => row.leafHash)), prevCheckpointHash: checkpoints.at(-1)?.checkpointHash ?? null }))
  }
  files.set(RECEIPTS, jsonl(receipts))
  files.set(CHECKPOINTS, jsonl(checkpoints))
  // Verification requires only public metadata. No private signing key is stored in this VFS.
  files.set(KEYPAIR, JSON.stringify({ publicKeyHex }))
  return { files, writes, receipts, checkpoints, publicKeyHex, seal,
    policy: { ok: true, schema: 'aukora.checkpoint-policy.v1',
      ranges: [{ firstSeq: 1, lastSeq: 16, envelope: 'v1', publicKeyHex }] },
    run: (input, checkpointPolicy) => module.exports.run(input, { fs, ...(checkpointPolicy ? { checkpointPolicy } : {}) }),
  }
}

const unavailableReaders = [
  ['missing', () => undefined],
  ['throwing', onRead => ({ async read() { onRead(); throw new Error('SYNTHETIC_POLICY_UNAVAILABLE') } })],
]
function assertUnanchored(result) {
  assert.equal(result.ok, true)
  assert.equal(result.chainSigned, true)
  assert.equal(result.signerAnchored, false)
  assert.equal(result.identityAnchored, false)
  assert.equal(result.signerStatus, 'unanchored')
  assert.equal(result.verificationScope, 'chain-consistency')
  assert.equal(result.checkpointPolicyError, 'CHECKPOINT_SIGNER_POLICY_UNAVAILABLE')
}

test('Round27 policy outages do not block appending after checkpoint fifteen and expose unanchored status', async () => {
  for (const [label, reader] of unavailableReaders) {
    const f = await fixture()
    let reads = 0
    const checkpointPolicy = reader(() => reads++)
    const before = new Map(f.files)
    const verified = await f.run({ action: 'verify' }, checkpointPolicy)
    assertUnanchored(verified)
    assert.equal(verified.checkpointsVerified, 15)
    reads = 0
    const result = await f.run({ action: 'append', kind: 'synthetic.round27.append', data: {} }, checkpointPolicy)
    assertUnanchored(result)
    assert.equal(result.receipt.seq, 16)
    assert.equal(result.totalReceipts, 16)
    assert.equal(result.checkpointReceiptCount, 15)
    assert.equal(reads, label === 'throwing' ? 1 : 0, 'one captured policy read covers append preflight')
    assert.deepEqual(f.writes, [RECEIPTS])
    assert.equal(f.files.get(CHECKPOINTS), before.get(CHECKPOINTS))
    assert.equal(f.files.get(KEYPAIR), before.get(KEYPAIR))
    const after = await f.run({ action: 'verify' }, checkpointPolicy)
    assertUnanchored(after)
    assert.equal(after.receiptsVerified, 16)
    assert.equal(after.checkpointReceiptCount, 15, 'appending does not extend signed checkpoint coverage')
  }
})

test('Round27 policy outages still refuse checkpoint signing at fifteen and sixteen without mutations', async () => {
  for (const count of [14, 15]) for (const [, reader] of unavailableReaders) {
    const f = await fixture(count), before = new Map(f.files)
    const result = await f.run({ action: 'checkpoint' }, reader(() => {}))
    assert.equal(result.ok, false)
    assert.equal(result.error, 'CHECKPOINT_SIGNER_POLICY_UNAVAILABLE')
    assert.equal(result.nextCheckpointSeq, count + 1)
    assert.deepEqual(f.files, before)
    assert.deepEqual(f.writes, [])
  }
})

test('Round27 policy outages cannot bypass late-checkpoint cryptographic or chain failures', async () => {
  const mutations = [
    ['receipt-chain', async f => { f.receipts[14].data = { changed: true }; f.files.set(RECEIPTS, jsonl(f.receipts)) }],
    ['checkpoint-hash', async f => { f.checkpoints[14].checkpointHash = '0'.repeat(64) }],
    ['checkpoint-fields', async f => { f.checkpoints[14].body.receiptCount = 16 }],
    ['checkpoint-chain', async f => { f.checkpoints[14] = await f.seal({ ...f.checkpoints[14].body, prevCheckpointHash: 'b'.repeat(64) }) }],
    ['ed25519-signature', async f => {
      const row = f.checkpoints[14]
      row.signatureHex = '0'.repeat(128)
      row.checkpointHash = hash(canonical({ body: row.body, publicKeyHex: row.publicKeyHex, signatureHex: row.signatureHex }))
    }],
    ['merkle-root', async f => { f.checkpoints[14] = await f.seal({ ...f.checkpoints[14].body, merkleRoot: 'c'.repeat(64) }) }],
  ]
  for (const [, reader] of unavailableReaders) for (const [stage, mutate] of mutations) {
    const f = await fixture()
    await mutate(f)
    f.files.set(CHECKPOINTS, jsonl(f.checkpoints))
    const before = new Map(f.files)
    const result = await f.run({ action: 'append', kind: 'synthetic.refused', data: {} }, reader(() => {}))
    assert.equal(result.ok, false)
    assert.equal(result.error, 'RECEIPT_CHAIN_INVALID')
    assert.equal(result.verification.stage, stage)
    assert.deepEqual(f.files, before)
    assert.deepEqual(f.writes, [])
  }
})

test('Round27 malformed, mismatched, expired and hybrid policies still refuse late-checkpoint append', async () => {
  const f = await fixture(), range = f.policy.ranges[0], before = new Map(f.files)
  for (const [policy, error] of [
    [null, 'CHECKPOINT_SIGNER_POLICY_INVALID'],
    [{ ...f.policy, ranges: [{ ...range, publicKeyHex: 'b'.repeat(64) }] }, 'CHECKPOINT_SIGNER_POLICY_MISMATCH'],
    [{ ...f.policy, ranges: [{ ...range, lastSeq: 14 }] }, 'CHECKPOINT_SIGNER_POLICY_EXPIRED'],
    [{ ...f.policy, ranges: [{ ...range, lastSeq: 14 }, { ...range, firstSeq: 15, envelope: 'v2' }] }, 'CHECKPOINT_HYBRID_SIGNER_UNAVAILABLE'],
  ]) {
    const result = await f.run({ action: 'append', kind: 'synthetic.refused', data: {} }, { read: async () => policy })
    assert.equal(result.ok, false)
    assert.equal(result.error, 'RECEIPT_CHAIN_INVALID')
    assert.equal(result.verification.stage, 'checkpoint-policy')
    assert.equal(result.verification.error, error)
    assert.deepEqual(f.files, before)
    assert.deepEqual(f.writes, [])
  }
})
