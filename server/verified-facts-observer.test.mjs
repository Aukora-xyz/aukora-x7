/** Offline Wave5 observer evidence: real HeadDO/MirrorDO with synthetic chains and signing keys. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { canonicalJson } from '../deploy/cloudflare/src/owner-grant-policy.mjs'
import { X61HeadDurableObject, bootstrapPackage, createDurableHeadStore, manifestId } from '../deploy/cloudflare/src/head-do.mjs'
import { MirrorDO, bootstrapMirror, mirrorBootstrapStatus } from '../deploy/cloudflare/src/mirror-do.mjs'

const sha = value => createHash('sha256').update(value).digest('hex')
const now = 1794355200000
const base = '/dsh/home/auma/'
const lines = rows => rows.map(row => JSON.stringify(row)).join('\n') + '\n'

function memoryStorage() {
  const rows = new Map()
  const storage = {
    get: async key => structuredClone(rows.get(key)),
    put: async (key, value) => { rows.set(key, structuredClone(value)) },
    delete: async key => rows.delete(key),
    list: async ({ prefix = '', limit = Infinity } = {}) => new Map([...rows].filter(([key]) => key.startsWith(prefix))
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).slice(0, limit).map(([key, value]) => [key, structuredClone(value)])),
    getAlarm: async () => null,
    setAlarm: async () => {},
    deleteAlarm: async () => {},
    transaction: async operation => operation(storage),
  }
  return storage
}

function receipt(rows, kind, data) {
  const body = { schema: 'aukora.receipt.v3', seq: rows.length + 1, at: new Date(now).toISOString(),
    prevHash: rows.at(-1)?.leafHash ?? '0'.repeat(64), kind, data }
  return { ...body, leafHash: sha('\0' + canonicalJson(body)) }
}

async function fixture(t, { mutate = () => {}, checkpointCount = 1, empty = false } = {}) {
  const draft = { version: 'x6.1-ball/v1', parentBallId: null, epoch: 12,
    entries: { fixture: { id: 'fixture', specifier: 'fixture:only', disabled: false, config: {}, previousSpecifiers: [] } }, modules: {} }
  const ball = { ...draft, ballId: await manifestId(draft) }
  const nodeBody = { content: 'Synthetic Wave5 memory', parentIds: [] }
  const node = { ...nodeBody, id: sha(canonicalJson(nodeBody)) }
  const receipts = []
  if (!empty) {
    receipts.push(receipt(receipts, 'memory.dag.append', { nodeId: node.id, content: node.content }))
    receipts.push(receipt(receipts, 'fixture.observed', { value: 2 }))
    receipts.push(receipt(receipts, 'fixture.observed', { value: 3 }))
  }
  // Independent fixed three-leaf expression exercises domain separation and odd-leaf promotion.
  const root = empty ? sha('') : sha(Buffer.concat([Buffer.from([1]),
    Buffer.from(sha(Buffer.concat([Buffer.from([1]), Buffer.from(receipts[0].leafHash, 'hex'), Buffer.from(receipts[1].leafHash, 'hex')])), 'hex'),
    Buffer.from(receipts[2].leafHash, 'hex')]))
  const key = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])
  const body = { schema: 'aukora.edge-checkpoint.v1', seq: 1, at: new Date(now).toISOString(), receiptCount: empty ? 0 : 1,
    lastReceiptHash: receipts[0]?.leafHash ?? '0'.repeat(64), merkleRoot: receipts[0]?.leafHash ?? sha(''), prevCheckpointHash: null }
  const publicKeyHex = Buffer.from(await crypto.subtle.exportKey('raw', key.publicKey)).toString('hex')
  const signatureHex = Buffer.from(await crypto.subtle.sign('Ed25519', key.privateKey,
    new TextEncoder().encode('aukora.x5.edge-head.v1\0' + canonicalJson(body)))).toString('hex')
  const checkpoint = { body, publicKeyHex, signatureHex, checkpointHash: sha(canonicalJson({ body, publicKeyHex, signatureHex })) }
  const files = new Map([
    ['HANDOFF.md', `| epoch | **${ball.epoch}** |\n| ballId | \`${ball.ballId}\` |\n`],
    ['memory/dag/HEAD.json', JSON.stringify({ heads: empty ? [] : [node.id], count: empty ? 0 : 1 })],
    ['seed/receipts.v3.jsonl', empty ? '' : lines(receipts)],
    ['seed/checkpoints.v1.jsonl', checkpointCount ? lines([checkpoint]) : ''],
    ['seed/discovery-corpus.v1.jsonl', ''],
    ['superagent/state.json', JSON.stringify({ assignments: [] })],
  ])
  if (!empty) files.set(`memory/dag/${node.id}.json`, JSON.stringify(node))
  mutate({ files, receipts, checkpoint })
  const entries = new Map()
  for (const [relative, text] of files) {
    const path = base + relative
    entries.set(path, { kind: 'file', mode: 0o600, mtimeMs: now, b64: Buffer.from(text).toString('base64') })
    for (let dir = path.slice(0, path.lastIndexOf('/')); dir !== '/dsh/home'; dir = dir.slice(0, dir.lastIndexOf('/'))) {
      entries.set(dir, { kind: 'dir', mode: 0o700 })
    }
  }
  const batch = [...entries].sort(([a], [b]) => a < b ? -1 : 1)
  const seed = await bootstrapPackage({ version: 'x61-bootstrap/v1', ball, codeBySha: {},
    mirror: { entryCount: batch.length, batchDigests: [sha(canonicalJson(batch))] } })
  const storage = memoryStorage(), mirrorStorage = memoryStorage(), env = {}
  const mirror = new MirrorDO({ storage: mirrorStorage }, env)
  const head = new X61HeadDurableObject({ storage, getWebSockets: () => [] }, env,
    { networkFetch: async () => { assert.fail('No external network permitted') } })
  env.MIRROR = { idFromName: value => value, get: () => mirror }
  const store = createDurableHeadStore(storage)
  await store.bootstrapPrepare(seed)
  await bootstrapMirror(mirrorStorage, { action: 'begin', ...seed, ballId: ball.ballId, epoch: ball.epoch })
  await bootstrapMirror(mirrorStorage, { action: 'batch', seedId: seed.seedId, index: 0, entries: batch })
  await bootstrapMirror(mirrorStorage, { action: 'commit', seedId: seed.seedId })
  assert.equal((await store.bootstrapCommit(seed.seedId, await mirrorBootstrapStatus(mirrorStorage))).phase, 'complete')
  t.after(async () => { await head.wakeStore.dispose(); await mirror.queue })
  const read = async (suffix = '', extraHeaders = {}) => {
    const response = await head.fetch(new Request('https://x61.internal/__x6/facts' + suffix, { headers: {
      'x-x6-internal-authorized': '1', 'x-x6-bootstrap-seed': seed.seedId, ...extraHeaders,
    } }))
    return { status: response.status, facts: await response.json() }
  }
  return { read, root, checkpoint }
}

test('Wave5 facts expose full verified receipt Merkle root, not the shorter checkpoint root or caller headers', async t => {
  const fx = await fixture(t)
  const { status, facts } = await fx.read('', { 'x-receipt-merkle-root': 'f'.repeat(64), 'x-merkle-root': 'f'.repeat(64) })
  assert.equal(status, 200)
  assert.equal(facts.ok, true)
  assert.equal(facts.receiptTotal, 3)
  assert.equal(facts.receiptsVerified, 3)
  assert.equal(facts.lastCheckpointReceiptCount, 1)
  assert.equal(facts.checkpointSignerTrust, 'unpinned')
  assert.equal(facts.merkleRoot, fx.root)
  assert.equal(facts.receiptMerkleRoot, fx.root)
  assert.notEqual(facts.merkleRoot, fx.checkpoint.body.merkleRoot)
  assert.equal(facts.ownerApproval, false)
  assert.equal(facts.independentAudit, false)
  const injected = await fx.read('?merkleRoot=' + 'f'.repeat(64))
  assert.equal(injected.status, 404)
  assert.equal(Object.hasOwn(injected.facts, 'merkleRoot'), false)
})

test('Wave5 receipt roots need no checkpoint assertion and empty evidence retains incomplete behavior', async t => {
  for (const empty of [false, true]) {
    const fx = await fixture(t, { empty, checkpointCount: 0 })
    const { status, facts } = await fx.read()
    if (empty) {
      assert.equal(status, 503)
      assert.equal(facts.evidenceStatus, 'incomplete')
      assert.equal(facts.merkleRoot, null)
      assert.equal(facts.receiptMerkleRoot, null)
      assert.equal(facts.auraStatus, 'incomplete')
      assert.equal(facts.wakeUrgency, null)
      continue
    }
    assert.equal(status, 200)
    assert.equal(facts.checkpointsTotal, 0)
    assert.equal(facts.merkleRoot, fx.root)
    assert.equal(facts.receiptMerkleRoot, fx.root)
    assert.equal(facts.receiptsVerified, 3)
  }
})

test('Wave5 corrupt receipts, checkpoint signatures, checkpoint roots and missing sources never expose a root', async t => {
  const mutations = [
    ({ files, receipts }) => { receipts[1].data.value = 99; files.set('seed/receipts.v3.jsonl', lines(receipts)) },
    ({ files, receipts }) => { receipts[2].prevHash = 'f'.repeat(64); files.set('seed/receipts.v3.jsonl', lines(receipts)) },
    ({ files, checkpoint }) => { checkpoint.signatureHex = '0'.repeat(128); files.set('seed/checkpoints.v1.jsonl', lines([checkpoint])) },
    ({ files, checkpoint }) => { checkpoint.body.merkleRoot = 'f'.repeat(64); files.set('seed/checkpoints.v1.jsonl', lines([checkpoint])) },
    ({ files }) => { files.delete('superagent/state.json') },
  ]
  for (const mutate of mutations) {
    const fx = await fixture(t, { mutate })
    const { status, facts } = await fx.read('', { 'x-merkle-root': fx.root })
    assert.equal(status, 503)
    assert.equal(facts.ok, false)
    assert.equal(facts.evidenceStatus, 'incomplete')
    assert.equal(facts.merkleRoot, null)
    assert.equal(facts.receiptMerkleRoot, null)
    assert.equal(facts.receiptsVerified, null)
  }
})
