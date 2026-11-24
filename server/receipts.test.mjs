/** Source-only signer-trust regressions. All keys and organ files are synthetic and held in memory. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as crypto from 'node:crypto'
import path from 'node:path'
import { canonicalJson } from '../deploy/cloudflare/src/owner-grant-policy.mjs'
import { checkpointPolicyView } from '../deploy/cloudflare/src/head-do.mjs'

const ROOT = '/dsh/home/auma/seed'
const RECEIPTS = ROOT + '/receipts.v3.jsonl'
const CHECKPOINTS = ROOT + '/checkpoints.v1.jsonl'
const KEYPAIR = ROOT + '/ed25519-keypair.json'
const PINNED_SYNTHETIC_KEY = 'baf94a77cb28f9575846eec092cfbd9094d4ac2c3af305a7fd8350d41c720c68'
const hex = value => Buffer.from(value).toString('hex')
const hash = value => crypto.createHash('sha256').update(value).digest('hex')
const source = readFileSync(new URL('../mirror/home/auma/seed/organs/seed-receipts.js', import.meta.url), 'utf8')

async function keypair() {
  const key = await crypto.webcrypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])
  return { key, publicKeyHex: hex(await crypto.webcrypto.subtle.exportKey('raw', key.publicKey)),
    privateJwk: await crypto.webcrypto.subtle.exportKey('jwk', key.privateKey),
    publicJwk: await crypto.webcrypto.subtle.exportKey('jwk', key.publicKey) }
}

function fixture({ local, historicalPublicKey } = {}) {
  const files = new Map(), writes = []
  if (local) files.set(KEYPAIR, JSON.stringify(local))
  const fs = {
    existsSync: name => files.has(name),
    readFileSync(name) { if (!files.has(name)) throw new Error('SYNTHETIC_FILE_ABSENT'); return files.get(name) },
    writeFileSync(name, value) { writes.push(name); files.set(name, String(value)) },
    mkdirSync() {},
  }
  const module = { exports: {} }
  const require = name => {
    if (name === 'fs') return fs
    if (name === 'crypto') return crypto
    if (name === 'path') return path
    throw new Error('UNAPPROVED_SYNTHETIC_DEPENDENCY: ' + name)
  }
  // Exercise the source-defined historical-key branch without possessing or reading a historical private key.
  const isolatedSource = historicalPublicKey ? source.replace(PINNED_SYNTHETIC_KEY, historicalPublicKey) : source
  new Function('module', 'require', 'Buffer', isolatedSource)(module, require, Buffer)
  const payload = { schema: 'aukora.receipt.v3', seq: 1, at: '2026-11-09T00:00:00.000Z',
    kind: 'synthetic.test', prevHash: '0'.repeat(64), data: {} }
  const receipt = { ...payload, leafHash: hash(Buffer.concat([Buffer.from([0]), Buffer.from(canonicalJson(payload))])) }
  files.set(RECEIPTS, JSON.stringify(receipt) + '\n')
  const rows = []
  return {
    files, writes, organ: module.exports, receipt, rows,
    async add(signer) {
      const body = { schema: 'aukora.edge-checkpoint.v1', seq: rows.length + 1, at: '2026-11-09T00:00:00.000Z',
        receiptCount: 1, lastReceiptHash: receipt.leafHash, merkleRoot: receipt.leafHash,
        prevCheckpointHash: rows.at(-1)?.checkpointHash ?? null }
      const publicKeyHex = signer.publicKeyHex
      const signatureHex = hex(await crypto.webcrypto.subtle.sign('Ed25519', signer.key.privateKey,
        Buffer.from('aukora.x5.edge-head.v1\0' + canonicalJson(body))))
      const row = { body, publicKeyHex, signatureHex,
        checkpointHash: hash(canonicalJson({ body, publicKeyHex, signatureHex })) }
      rows.push(row)
      files.set(CHECKPOINTS, rows.map(row => JSON.stringify(row)).join('\n') + '\n')
      return row
    },
    verify(input = {}, context = {}) { return module.exports.run({ action: 'verify', ...input }, context) },
  }
}

async function hostPin(signer, validToCheckpoint) {
  const pin = { schema: 'aukora.checkpoint-signer.v1', domain: 'aukora.x5.edge-head.v1', publicKeyHex: signer.publicKeyHex,
    ...(validToCheckpoint === undefined ? {} : { validToCheckpoint }) }
  const policy = await checkpointPolicyView({ CHECKPOINT_SIGNER_PIN: pin })
  let reads = 0
  return { policy, get reads() { return reads }, context: { checkpointPolicy: { async read() { reads++; return structuredClone(policy) } } } }
}

function assertTrust(result, { chainSigned = true, signerStatus = 'unanchored' } = {}) {
  assert.equal(result.ok, true)
  assert.equal(result.chainSigned, chainSigned)
  assert.equal(result.signerStatus, signerStatus)
  assert.equal(result.signerAnchored, signerStatus === 'pinned')
  assert.equal(result.identityAnchored, result.signerAnchored)
  assert.equal(result.verificationScope, result.signerAnchored ? 'anchored-chain' : 'chain-consistency')
  assert.equal(Object.hasOwn(result, 'headCommitment'), false, 'unknown nine-field commitment schema must not be invented')
}

test('local keys and caller expectations establish consistency, not independent signer trust', async () => {
  const signer = await keypair(), f = fixture({ local: signer })
  await f.add(signer)
  assertTrust(await f.verify())
  assertTrust(await f.verify({ expectedPublicKey: signer.publicKeyHex }))
  const callerOnly = fixture()
  await callerOnly.add(signer)
  assertTrust(await callerOnly.verify({ expectedPublicKey: signer.publicKeyHex }))
  assert.deepEqual(f.writes, [])
})

test('no checkpoint means no signed or anchored chain, even with an independently configured pin', async () => {
  const signer = await keypair(), pin = await hostPin(signer)
  for (const local of [undefined, signer]) {
    const f = fixture({ local })
    for (const input of [{}, { expectedPublicKey: signer.publicKeyHex }]) {
      const result = await f.verify(input)
      assertTrust(result, { chainSigned: false })
      assert.equal(result.publicKeyHex, null)
      assert.equal(result.genesisPublicKeyHex, null)
      assert.equal(result.activePublicKeyHex, local?.publicKeyHex ?? null)
      assert.deepEqual(result.signers, [])
      assert.deepEqual(result.keyRotations, [])
      assertTrust(await f.verify(input, pin.context), { chainSigned: false })
    }
    assert.deepEqual(f.writes, [])
  }
})

test('only source-defined historical identities receive historical-sandbox status', async () => {
  assert.equal(source.includes(PINNED_SYNTHETIC_KEY), true)
  const signer = await keypair(), unrelatedLocal = await keypair()
  const f = fixture({ local: unrelatedLocal, historicalPublicKey: signer.publicKeyHex })
  await f.add(signer)
  assertTrust(await f.verify(), { signerStatus: 'historical-sandbox' })
  const pin = await hostPin(signer)
  const pinned = await f.verify({}, pin.context)
  assertTrust(pinned, { signerStatus: 'pinned' })
  assert.equal(pinned.publicKeyHex, signer.publicKeyHex)
  assert.equal(pinned.genesisPublicKeyHex, signer.publicKeyHex)
  assert.equal(pinned.activePublicKeyHex, unrelatedLocal.publicKeyHex)
  assert.deepEqual(pinned.signers, [signer.publicKeyHex])
  assert.deepEqual(pinned.keyRotations, [], 'unsigned local-key changes are not signed rotations')
  const mixed = fixture({ local: unrelatedLocal, historicalPublicKey: signer.publicKeyHex })
  await mixed.add(signer)
  await mixed.add(unrelatedLocal)
  assertTrust(await mixed.verify())
})

test('unknown or absent signers remain refused without independent policy admission', async () => {
  const signer = await keypair(), f = fixture()
  const row = await f.add(signer)
  assert.equal((await f.verify()).stage, 'checkpoint-signer')
  const pin = await hostPin(signer)
  assertTrust(await f.verify({}, pin.context), { signerStatus: 'pinned' })
  const missing = structuredClone(row)
  delete missing.publicKeyHex
  missing.checkpointHash = hash(canonicalJson({ body: missing.body, signatureHex: missing.signatureHex }))
  f.files.set(CHECKPOINTS, JSON.stringify(missing))
  const result = await f.verify({}, pin.context)
  assert.equal(result.ok, false)
  assert.equal(result.stage, 'checkpoint-signer')
  assert.notEqual(result.signerAnchored, true)
  assert.deepEqual(f.writes, [])
})

test('caller policy objects and candidate-writable policy files do not pin a signer', async () => {
  const signer = await keypair(), f = fixture({ local: signer }), pin = await hostPin(signer)
  await f.add(signer)
  for (const filename of ['checkpoint-signer.v1.json', 'checkpoint-signer-policy.v1.json']) {
    f.files.set(ROOT + '/' + filename, JSON.stringify(pin.policy))
  }
  assertTrust(await f.verify({ checkpointSignerPin: signer.publicKeyHex, checkpointSignerPolicy: pin.policy, checkpointPolicy: pin.context.checkpointPolicy }))
  assertTrust(await f.verify({}, { checkpointSignerPin: signer.publicKeyHex }))
  assert.equal(pin.reads, 0)
})

test('an independent legacy pin requires no hybrid countersignature and does not override an explicit key constraint', async () => {
  const signer = await keypair(), wrong = await keypair(), f = fixture(), pin = await hostPin(signer)
  await f.add(signer)
  assertTrust(await f.verify({}, pin.context), { signerStatus: 'pinned' })
  assert.equal(pin.reads, 1)
  assert.equal((await f.verify({ expectedPublicKey: wrong.publicKeyHex }, pin.context)).stage, 'checkpoint-signer')
  assert.deepEqual(f.writes, [])
})

test('each checkpoint must match its own independently configured signer window', async () => {
  const first = await keypair(), second = await keypair(), f = fixture()
  await f.add(first); await f.add(second)
  const policy = await checkpointPolicyView({ CHECKPOINT_SIGNER_POLICY: {
    schema: 'aukora.checkpoint-signer-policy.v1', domain: 'aukora.x5.edge-head.v1',
    ranges: [{ firstSeq: 1, lastSeq: 1, publicKeyHex: first.publicKeyHex }, { firstSeq: 2, lastSeq: 2, publicKeyHex: second.publicKeyHex }],
  } })
  const result = await f.verify({}, { checkpointPolicy: { async read() { return policy } } })
  assertTrust(result, { signerStatus: 'pinned' })
  assert.equal(result.publicKeyHex, second.publicKeyHex)
  assert.equal(result.genesisPublicKeyHex, first.publicKeyHex)
  assert.equal(result.activePublicKeyHex, null)
  assert.deepEqual(result.signers, [first.publicKeyHex, second.publicKeyHex])
  assert.equal(result.keyRotations.length, 1)
  assert.equal(result.keyRotations[0].atCheckpointSeq, 2)
  assert.equal((await f.verify()).ok, false)
  assert.equal((await f.verify({}, (await hostPin(first)).context)).ok, false)
})

test('unavailable, malformed, mismatched and expired pins cannot turn early local consistency into anchored trust', async () => {
  const signer = await keypair(), f = fixture({ local: signer }), pin = await hostPin(signer)
  await f.add(signer); await f.add(signer)
  const wrongKey = await keypair()
  const invalid = [
    null, { ...pin.policy, extra: true },
    { ...pin.policy, ranges: [{ ...pin.policy.ranges[0], firstSeq: 2 }] },
    { ...pin.policy, ranges: [{ ...pin.policy.ranges[0], lastSeq: Number.MAX_SAFE_INTEGER }] },
    { ...pin.policy, ranges: [{ ...pin.policy.ranges[0], publicKeyHex: wrongKey.publicKeyHex }] },
    { ...pin.policy, ranges: [{ ...pin.policy.ranges[0], lastSeq: 1 }] },
  ]
  for (const policy of invalid) assertTrust(await f.verify({}, { checkpointPolicy: { async read() { return policy } } }))
  assertTrust(await f.verify({}, { checkpointPolicy: { async read() { throw new Error('SYNTHETIC_UNAVAILABLE') } } }))
  assert.deepEqual(f.writes, [])
})

test('checkpoint fifteen needs an authenticated finite legacy window and refuses downgrade or expiry', async () => {
  const signer = await keypair(), f = fixture({ local: signer }), pin = await hostPin(signer, 15)
  for (let seq = 1; seq <= 14; seq++) await f.add(signer)
  const before = new Map(f.files)
  const produced = await f.organ.run({ action: 'checkpoint' }, pin.context)
  assert.equal(produced.ok, true)
  assert.equal(produced.checkpoint.body.seq, 15)
  assert.equal(pin.reads, 1, 'mutation preflight and signing use one policy snapshot')
  assert.deepEqual(f.writes, [CHECKPOINTS])
  assert.equal(f.files.get(KEYPAIR), before.get(KEYPAIR))
  assertTrust(await f.verify({}, pin.context), { signerStatus: 'pinned' })
  const after = new Map(f.files)
  assert.equal((await f.organ.run({ action: 'checkpoint' }, pin.context)).error, 'CHECKPOINT_SIGNER_POLICY_EXPIRED')
  assert.deepEqual(f.files, after)
  for (const policy of [null,
    { ...pin.policy, ranges: [{ ...pin.policy.ranges[0], lastSeq: 14 }] },
    { ...pin.policy, ranges: [{ ...pin.policy.ranges[0], lastSeq: 14 },
      { firstSeq: 15, lastSeq: 16, envelope: 'v2', publicKeyHex: signer.publicKeyHex }] },
    { ...pin.policy, ranges: [{ ...pin.policy.ranges[0], lastSeq: 14 },
      { firstSeq: 15, lastSeq: 16, envelope: 'v2', publicKeyHex: signer.publicKeyHex },
      { firstSeq: 17, lastSeq: 18, envelope: 'v1', publicKeyHex: signer.publicKeyHex }] },
  ]) {
    const context = { checkpointPolicy: { async read() { return policy } } }
    const result = await f.verify({}, context)
    assert.equal(result.ok, false)
    assert.equal(result.stage, 'checkpoint-policy')
    assert.notEqual(result.signerAnchored, true)
    assert.equal((await f.organ.run({ action: 'append', kind: 'synthetic.refused', data: {} }, context)).error, 'RECEIPT_CHAIN_INVALID')
    assert.deepEqual(f.files, after)
  }
})

test('invalid signatures, receipt hashes and checkpoint chains never claim pinned trust', async () => {
  const signer = await keypair(), pin = await hostPin(signer)
  for (const mutate of [
    row => { row.signatureHex = '0'.repeat(128) },
    row => { row.body.merkleRoot = 'b'.repeat(64) },
    row => { row.body.prevCheckpointHash = 'c'.repeat(64) },
  ]) {
    const f = fixture({ local: signer }), row = await f.add(signer)
    mutate(row)
    row.checkpointHash = hash(canonicalJson({ body: row.body, publicKeyHex: row.publicKeyHex, signatureHex: row.signatureHex }))
    f.files.set(CHECKPOINTS, JSON.stringify(row))
    const result = await f.verify({}, pin.context)
    assert.equal(result.ok, false)
    assert.notEqual(result.chainSigned, true)
    assert.notEqual(result.signerAnchored, true)
    assert.equal((await f.organ.run({ action: 'append', kind: 'synthetic.refused', data: {} }, pin.context)).error, 'RECEIPT_CHAIN_INVALID')
    assert.deepEqual(f.writes, [])
  }
  const f = fixture({ local: signer })
  await f.add(signer)
  f.files.set(RECEIPTS, JSON.stringify({ ...f.receipt, leafHash: 'b'.repeat(64) }))
  assert.equal((await f.verify({}, pin.context)).stage, 'receipt-chain')
})
