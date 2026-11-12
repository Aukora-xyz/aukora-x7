/** Offline replay-retention integration: real publishMirror, transactional in-memory storage only. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { bootstrapMirror, mirrorDigest, publishMirror } from '../deploy/cloudflare/src/mirror-do.mjs'
import { MIRROR_REPLAY_LIMITS } from '../deploy/cloudflare/src/mirror-replay.mjs'

const RECEIPT = 'mirror:v2:receipt:'
const HEAD = 'mirror:v2:head:'
const FENCE = 'mirror:v2:global-fence'
const LINEAGE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const client = index => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`
const HASH = 'a'.repeat(64)
const entries = [['/dsh/home/replay', { kind: 'dir', mode: 0o755 }]]

// The only fake is storage. Every callback writes to an isolated copy, committed only
// on success, matching Durable Object transaction rollback, including delete failures.
class Storage {
  data = new Map([[FENCE, { lineageId: LINEAGE, revision: 0 }]])
  fail = null
  deleted = []
  async transaction(callback) {
    const working = structuredClone(this.data)
    const tx = {
      get: async key => structuredClone(working.get(key)),
      list: async ({ prefix = '', limit = Infinity } = {}) => new Map([...working].filter(([key]) => key.startsWith(prefix)).sort(([a], [b]) => a.localeCompare(b)).slice(0, limit).map(([key, value]) => [key, structuredClone(value)])),
      put: async (key, value) => {
        if (this.fail?.('put', key)) throw new Error('injected storage failure')
        working.set(key, structuredClone(value))
      },
      delete: async key => {
        this.deleted.push(key)
        if (this.fail?.('delete', key)) throw new Error('injected storage failure')
        return working.delete(key)
      },
    }
    const result = await callback(tx)
    this.data = working
    return result
  }
}

async function envelope(storage, clientId, seq, patch = {}) {
  const batch = { id: `${clientId}:${seq}`, clientId, seq, entries, cloudBase: structuredClone(storage.data.get(FENCE)), ...patch }
  return { v: 2, batch, digest: await mirrorDigest(batch) }
}

function seed(storage, clientId, seq, revision) {
  const receipt = { ok: true, protocol: 'x61-cloud-mirror/v1', lineageId: LINEAGE, revision, id: `${clientId}:${seq}`, clientId, seq, digest: HASH, applied: 1, acknowledgedAt: 1 }
  storage.data.set(RECEIPT + receipt.id, receipt)
  storage.data.set(HEAD + clientId, { seq, digest: HASH })
  storage.data.set(FENCE, { lineageId: LINEAGE, revision })
}

const receipts = storage => [...storage.data].filter(([key]) => key.startsWith(RECEIPT))

test('publication continues beyond the old lifetime ceiling and latest exact retry survives', async () => {
  const storage = new Storage()
  let first, latest
  for (let seq = 1; seq <= MIRROR_REPLAY_LIMITS.receipts + 2; seq += 1) {
    latest = await envelope(storage, client(1), seq)
    first ??= latest
    const result = await publishMirror(storage, latest)
    assert.equal(result.ok, true)
    assert.equal(result.revision, seq)
  }
  assert.equal(receipts(storage).length, MIRROR_REPLAY_LIMITS.perClient)
  assert.equal(storage.data.get(HEAD + client(1)).seq, MIRROR_REPLAY_LIMITS.receipts + 2)
  const beforeRetry = structuredClone(storage.data)
  assert.equal((await publishMirror(storage, latest)).replayed, true)
  assert.deepEqual(storage.data, beforeRetry)
  const expired = await publishMirror(storage, first)
  assert.equal(expired.code, 'MIRROR_REPLAY_EXPIRED')
  assert.equal(expired.ok, false)
  assert.deepEqual(storage.data.get(FENCE), beforeRetry.get(FENCE))
  assert.deepEqual(storage.data.get(HEAD + client(1)), beforeRetry.get(HEAD + client(1)))
  assert.equal(receipts(storage).length, MIRROR_REPLAY_LIMITS.perClient)
})

test('retained exact retry acknowledges its original revision and changed duplicate conflicts', async () => {
  const storage = new Storage()
  const first = await envelope(storage, client(1), 1)
  const original = await publishMirror(storage, first)
  await publishMirror(storage, await envelope(storage, client(1), 2))
  assert.deepEqual(await publishMirror(storage, first), { ...original, replayed: true })
  const conflicting = await envelope(storage, client(1), 1, { entries: [['/dsh/home/forbidden-replay', { kind: 'dir', mode: 0o755 }]] })
  assert.equal((await publishMirror(storage, conflicting)).code, 'MIRROR_REPLAY_CONFLICT')
  assert.equal(storage.data.get(FENCE).revision, 2)
  assert.ok(![...storage.data.values()].some(value => value?.path === '/dsh/home/forbidden-replay'))
})

test('legacy full single-client inventory reduces on publication, never by caller timestamps', async () => {
  const storage = new Storage()
  for (let seq = 1; seq <= MIRROR_REPLAY_LIMITS.receipts; seq += 1) seed(storage, client(1), seq, seq)
  // Timestamp order deliberately opposes commit order. Only revision controls eviction.
  for (const [, receipt] of receipts(storage)) receipt.acknowledgedAt = 100000 - receipt.revision
  const result = await publishMirror(storage, await envelope(storage, client(1), MIRROR_REPLAY_LIMITS.receipts + 1))
  assert.equal(result.ok, true)
  const seqs = receipts(storage).map(([, receipt]) => receipt.seq).sort((a, b) => a - b)
  assert.equal(seqs.length, 64)
  assert.equal(seqs[0], MIRROR_REPLAY_LIMITS.receipts - 62)
})

test('global oldest-revision eviction protects idle client heads and all non-ACK records', async () => {
  const storage = new Storage()
  let revision = 0
  // Oldest receipt is an idle client's latest and must never be evicted.
  seed(storage, client(0), 1, ++revision)
  for (let index = 1; index <= 63; index += 1) {
    for (let seq = 1; seq <= 64; seq += 1) seed(storage, client(index), seq, ++revision)
  }
  for (let seq = 1; seq <= 63; seq += 1) seed(storage, client(64), seq, ++revision)
  assert.equal(revision, 4096)
  const sentinelKeys = ['mirror:bootstrap:v1', 'mirror:v2:conflict:sentinel', 'mirror:v2:conflict-chunk:sentinel:0', 'mirror:v2:chunk:incomplete:0', 'unrelated:receipt-journal']
  for (const key of sentinelKeys) storage.data.set(key, { sentinel: key })
  const priorHeads = new Map([...storage.data].filter(([key]) => key.startsWith(HEAD)))
  assert.equal((await publishMirror(storage, await envelope(storage, client(65), 1))).ok, true)
  assert.equal(receipts(storage).length, 4096)
  assert.ok(storage.data.has(RECEIPT + `${client(0)}:1`))
  assert.ok(!storage.data.has(RECEIPT + `${client(1)}:1`))
  for (const [key, value] of priorHeads) {
    assert.deepEqual(storage.data.get(key), value)
    assert.ok(storage.data.has(RECEIPT + `${key.slice(HEAD.length)}:${value.seq}`))
  }
  for (const key of sentinelKeys) assert.deepEqual(storage.data.get(key), { sentinel: key })
  assert.deepEqual(storage.deleted, [RECEIPT + `${client(1)}:1`])
})

test('expired exact and altered replays with a fresh cloud base never apply again', async () => {
  const storage = new Storage()
  for (let seq = 1; seq <= 65; seq += 1) await publishMirror(storage, await envelope(storage, client(1), seq))
  for (const replacement of [entries, [['/dsh/home/reapplied', { kind: 'dir', mode: 0o700 }]]]) {
    const attempt = await envelope(storage, client(1), 1, { entries: replacement })
    const before = structuredClone(storage.data)
    assert.equal((await publishMirror(storage, attempt)).code, 'MIRROR_REPLAY_EXPIRED')
    assert.deepEqual(storage.data.get(FENCE), before.get(FENCE))
    assert.deepEqual(storage.data.get(HEAD + client(1)), before.get(HEAD + client(1)))
    for (const [key, value] of before) assert.deepEqual(storage.data.get(key), value)
    assert.ok(![...storage.data.values()].some(value => value?.path === '/dsh/home/reapplied'))
  }
})

test('receipt pruning, content, reset, fence and head updates roll back on every late write failure', async () => {
  for (const failure of ['delete', 'fence', 'receipt', 'head']) {
    const storage = new Storage()
    for (let seq = 1; seq <= 64; seq += 1) seed(storage, client(1), seq, seq)
    const before = structuredClone(storage.data)
    const next = await envelope(storage, client(1), 65, { entries: [['/dsh/home/new-file', { kind: 'file', mode: 0o644, b64: 'eA==', mtimeMs: 0 }], ['/dsh/home/deleted', { kind: 'gone' }]] })
    storage.fail = (operation, key) => failure === 'delete' ? operation === 'delete' : operation === 'put' && (failure === 'fence' ? key === FENCE : key.startsWith(failure === 'receipt' ? RECEIPT : HEAD))
    await assert.rejects(publishMirror(storage, next), /injected storage failure/)
    assert.deepEqual(storage.data, before)
    assert.ok(storage.deleted.includes(RECEIPT + `${client(1)}:1`))
    storage.fail = null
    assert.equal((await publishMirror(storage, next)).ok, true)
    assert.equal(receipts(storage).length, 64)
  }
})

test('malformed, incomplete or unfenced replay metadata fails closed without pruning', async () => {
  const mutations = [
    storage => { storage.data.get(RECEIPT + `${client(1)}:1`).revision = 0 },
    storage => { storage.data.get(RECEIPT + `${client(1)}:1`).revision = 3 },
    storage => { storage.data.get(RECEIPT + `${client(1)}:1`).lineageId = client(99) },
    storage => { storage.data.get(RECEIPT + `${client(1)}:1`).digest = 'invalid' },
    storage => { delete storage.data.get(RECEIPT + `${client(1)}:1`).protocol },
    storage => { storage.data.get(RECEIPT + `${client(1)}:1`).ok = false },
    storage => { storage.data.get(RECEIPT + `${client(1)}:1`).acknowledgedAt = NaN },
    storage => { storage.data.get(HEAD + client(1)).digest = 'b'.repeat(64) },
    storage => { storage.data.get(HEAD + client(1)).seq = Number.MAX_SAFE_INTEGER + 1 },
    storage => { storage.data.delete(RECEIPT + `${client(1)}:2`) },
    storage => { storage.data.delete(HEAD + client(1)) },
    storage => { storage.data.get(RECEIPT + `${client(1)}:1`).revision = 2 },
    storage => { storage.data.get(RECEIPT + `${client(1)}:1`).revision = 2; storage.data.get(RECEIPT + `${client(1)}:2`).revision = 1 },
    storage => { storage.data.get(FENCE).revision = 3 },
  ]
  for (const mutate of mutations) {
    const storage = new Storage()
    seed(storage, client(1), 1, 1)
    seed(storage, client(1), 2, 2)
    mutate(storage)
    const before = structuredClone(storage.data)
    await assert.rejects(publishMirror(storage, await envelope(storage, client(1), 3)), { code: 'MIRROR_REPLAY_METADATA_CORRUPT', status: 503 })
    assert.deepEqual(storage.data, before)
    assert.deepEqual(storage.deleted, [])
  }
})

test('over-limit inventories are detected with a sentinel, not truncated and pruned', async () => {
  for (const overflow of ['receipts', 'clients']) {
    const storage = new Storage()
    if (overflow === 'receipts') {
      for (let seq = 1; seq <= 4097; seq += 1) seed(storage, client(1), seq, seq)
    } else {
      for (let index = 1; index <= 257; index += 1) seed(storage, client(index), 1, index)
    }
    const before = structuredClone(storage.data)
    await assert.rejects(publishMirror(storage, await envelope(storage, client(1), overflow === 'receipts' ? 4098 : 2)), { code: 'MIRROR_REPLAY_METADATA_CORRUPT' })
    assert.deepEqual(storage.data, before)
    assert.deepEqual(storage.deleted, [])
  }
})

test('exact retry validates its stored ACK and the complete replay inventory before acknowledging', async () => {
  for (const corrupt of ['ack', 'head', 'unrelated']) {
    const storage = new Storage()
    const attempt = await envelope(storage, client(1), 1)
    await publishMirror(storage, attempt)
    if (corrupt === 'ack') storage.data.get(RECEIPT + attempt.batch.id).applied = 0
    if (corrupt === 'head') storage.data.delete(HEAD + client(1))
    if (corrupt === 'unrelated') storage.data.set(RECEIPT + `${client(2)}:1`, { ok: false, phase: 'receiving' })
    const before = structuredClone(storage.data)
    await assert.rejects(publishMirror(storage, attempt), { code: 'MIRROR_REPLAY_METADATA_CORRUPT', status: 503 })
    assert.deepEqual(storage.data, before)
    assert.deepEqual(storage.deleted, [])
  }
})

test('the 256-client bound remains while established clients continue publishing', async () => {
  const storage = new Storage()
  for (let index = 1; index <= 256; index += 1) seed(storage, client(index), 1, index)
  const before = structuredClone(storage.data)
  await assert.rejects(publishMirror(storage, await envelope(storage, client(257), 1)), { code: 'MIRROR_CLIENT_LIMIT', status: 507 })
  assert.deepEqual(storage.data, before)
  assert.equal((await publishMirror(storage, await envelope(storage, client(1), 2))).ok, true)
  assert.equal([...storage.data.keys()].filter(key => key.startsWith(HEAD)).length, 256)
})

test('revision-one without ACKs requires a matching completed bootstrap before publication', async () => {
  const storage = new Storage()
  const input = { action: 'begin', seedId: HASH, ballId: HASH, epoch: 1, mirror: { batchDigests: [], entryCount: 0 } }
  await bootstrapMirror(storage, input)
  await bootstrapMirror(storage, { action: 'commit', seedId: HASH })
  assert.equal(storage.data.get(FENCE).revision, 1)
  const valid = structuredClone(storage.data)
  for (const corruption of ['missing', 'receiving', 'lineage', 'incomplete']) {
    storage.data = structuredClone(valid)
    if (corruption === 'missing') storage.data.delete('mirror:bootstrap:v1')
    if (corruption === 'receiving') storage.data.get('mirror:bootstrap:v1').phase = 'receiving'
    if (corruption === 'lineage') storage.data.get('mirror:bootstrap:v1').lineageId = client(99)
    if (corruption === 'incomplete') storage.data.get('mirror:bootstrap:v1').expectedEntries = 1
    const before = structuredClone(storage.data)
    await assert.rejects(publishMirror(storage, await envelope(storage, client(1), 1)), { code: 'MIRROR_REPLAY_METADATA_CORRUPT' })
    assert.deepEqual(storage.data, before)
  }
  storage.data = valid
  assert.equal((await publishMirror(storage, await envelope(storage, client(1), 1))).revision, 2)
  assert.deepEqual(storage.data.get('mirror:bootstrap:v1'), valid.get('mirror:bootstrap:v1'))
})
