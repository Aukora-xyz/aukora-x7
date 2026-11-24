/**
 * An import must not make her app's save wait long. MIRROR answers one request at a time, so the
 * rule is structural: no single internal `/_mirror/thread` import call does more than THREAD_IMPORT_STEP (1,024 new
 * piece hashes, an open end under one piece, a body under 3 MiB), and a longer journal goes in steps. Here the REAL
 * Worker half (handleThreadRequest) drives the REAL MirrorDO over in-memory storage; R2 is a fixture that answers any
 * piece (MIRROR only ever sees piece hashes). A journal of 2,050 full pieces is imported while her app's save arrives
 * during the first step: the save is answered after at most ONE import step.
 * Node timings are not Durable Object timings: this test asserts ORDER and BOUNDS, never time.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { MirrorDO, mirrorDigest } from '../mirror-do.mjs'
import { THREAD_PROTOCOL, handleThreadRequest, threadIdForPath } from '../thread-log.mjs'

const SEED = 'a'.repeat(64)
const LINEAGE = '11111111-1111-4111-8111-111111111111'
const PATH = '/dsh/home/auma/session/messages.jsonl'
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const PIECE = THREAD_PROTOCOL.piece
const FULL = 2 * 1024 + 2
const shaHex = value => createHash('sha256').update(value).digest('hex')

function createStorage(initial) {
  const data = new Map(initial)
  let tail = Promise.resolve()
  let held = null // `holdGet(key)` holds the next get of `key` inside a transaction until `release()`
  const listOf = (read, { prefix = '', start, startAfter, limit = Infinity } = {}) => {
    const out = new Map()
    for (const key of read.keys().filter(key => key.startsWith(prefix) && (start === undefined || key >= start) && (startAfter === undefined || key > startAfter)).sort()) {
      if (out.size >= limit) break
      out.set(key, read.get(key))
    }
    return out
  }
  const direct = { keys: () => [...data.keys()], get: key => structuredClone(data.get(key)) }
  return {
    data,
    holdGet(key) {
      let release, reached
      const gate = new Promise(resolve => { release = resolve })
      const arrived = new Promise(resolve => { reached = resolve })
      held = { key, gate, reached }
      return { release, arrived }
    },
    get: async key => direct.get(key),
    put: async (key, value) => { data.set(key, structuredClone(value)) },
    delete: async key => data.delete(key),
    list: async options => listOf(direct, options),
    transaction(fn) {
      const run = tail.then(async () => {
        const writes = new Map(), deletes = new Set()
        const read = {
          keys: () => [...new Set([...data.keys(), ...writes.keys()])].filter(key => !deletes.has(key) || writes.has(key)),
          get: key => (writes.has(key) ? structuredClone(writes.get(key)) : deletes.has(key) ? undefined : structuredClone(data.get(key))),
        }
        const view = {
          get: async key => {
            if (held && held.key === key) { const { gate, reached } = held; held = null; reached(); await gate }
            return read.get(key)
          },
          put: async (key, value) => { deletes.delete(key); writes.set(key, structuredClone(value)) },
          delete: async key => { const had = read.get(key) !== undefined; writes.delete(key); deletes.add(key); return had },
          list: async options => listOf(read, options),
        }
        const result = await fn(view)
        for (const key of deletes) if (!writes.has(key)) data.delete(key)
        for (const [key, value] of writes) data.set(key, value)
        return result
      })
      tail = run.catch(() => {})
      return run
    },
  }
}

/** R2 fixture: any piece answers lines of 'a' that end in a newline (only the open end and line ends are read). */
const anyPiece = {
  head: async () => ({ size: PIECE }),
  put: async () => ({ size: PIECE, written: false }),
  get: async (_sha, { length }) => { const bytes = new Uint8Array(length).fill(0x61); if (length) bytes[length - 1] = 10; return bytes },
}

test('a journal of 2,050 pieces is imported in steps of at most 1,024 pieces (bodies under 3 MiB), and her app\'s save that arrives during the first step is answered after at most ONE import step', async () => {
  const storage = createStorage([
    ['mirror:bootstrap:v1', { phase: 'ready', seedId: SEED, lineageId: LINEAGE, revision: 1, ballId: 'b'.repeat(64), epoch: 2, batchDigests: ['c'.repeat(64)], nextBatch: 1, entryCount: 1, expectedEntries: 1 }],
    ['mirror:v2:global-fence', { lineageId: LINEAGE, revision: 1 }],
  ])
  const mirror = new MirrorDO({ storage }, {})
  const internal = (path, body) => mirror.fetch(new Request(`https://x61.internal${path}`, { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-x6-internal-authorized': '1', 'x-x6-bootstrap-seed': SEED }, body: typeof body === 'string' ? body : JSON.stringify(body) }))
  const granted = await (await internal('/_mirror/lease', { input: { action: 'acquire', clientId: A, tabId: 'rescue-page', label: 'Rescue page' }, ownerApproved: false })).json()
  assert.equal(granted.ok, true)

  const events = []
  const steps = []
  let save = null
  const herSave = async () => {
    const fence = storage.data.get('mirror:v2:global-fence')
    const batch = { id: `${B}:1`, clientId: B, seq: 1, entries: [['/dsh/home/auma/during.md', { kind: 'file', mode: 0o644, mtimeMs: 1, b64: Buffer.from('saved during an import\n').toString('base64') }]], cloudBase: { lineageId: fence.lineageId, revision: fence.revision } }
    events.push('save:start')
    const response = await internal('/_mirror/delta', { v: 2, batch, digest: await mirrorDigest(batch) })
    events.push('save:end')
    return { status: response.status, body: await response.json() }
  }
  const call = async (op, input, home) => {
    const body = JSON.stringify(home === undefined ? { op, input } : { op, input, home })
    const name = op === 'import' ? `import#${steps.length + 1}` : op
    if (op === 'import') steps.push({ parts: input.parts.length, from: input.from, bodyBytes: Buffer.byteLength(body), home: home !== undefined })
    events.push(`${name}:start`)
    const pending = internal('/_mirror/thread', body)
    // Her app's save arrives while the first import step is in MIRROR.
    if (op === 'import' && steps.length === 1) save = herSave()
    const response = await pending
    const answer = { status: response.status, body: await response.json() }
    events.push(`${name}:end`)
    return answer
  }
  const pieces = Array.from({ length: FULL + 1 }, (_, i) => shaHex(`piece ${i}`))
  const bytes = FULL * PIECE + 1000
  const rescues = { get: async () => ({ verifiedAt: '2026-11-12T11:00:00.000Z',
    index: { v: 1, piece: PIECE, client: { clientId: A, base: { lineageId: LINEAGE, revision: 1 }, reconciliation: null }, rows: [{ key: PATH, type: 'file', bytes, sha256: 'f'.repeat(64), pieces }] } }) }
  const url = new URL('https://her.example.invalid/_thread/import')
  const request = new Request(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-thread-lease': `${granted.lease.leaseId}.${granted.lease.generation}` }, body: JSON.stringify({ path: PATH, rescue: 'e'.repeat(32) }) })
  const response = await handleThreadRequest({ request, url, mirror: { call }, parts: anyPiece, rescues })
  const answer = await response.json()
  assert.equal(response.status, 200, JSON.stringify(answer))
  assert.equal(answer.outcome, 'imported')
  assert.equal(answer.bytes, bytes)

  // The bound: every import step carries at most 1,024 new pieces and a body under 3 MiB; `home` rides only on the last.
  assert.deepEqual(steps.map(step => step.parts), [1024, 1024, 2])
  assert.deepEqual(steps.map(step => step.from), [0, 1024, 2048])
  assert.ok(steps.every(step => step.bodyBytes < 3 * 1024 * 1024), JSON.stringify(steps))
  assert.deepEqual(steps.map(step => step.home), [false, false, true])
  // Her save: answered 200, after at most ONE import step.
  const saved = await save
  assert.equal(saved.status, 200, JSON.stringify(saved.body))
  const from = events.indexOf('save:start'), to = events.indexOf('save:end')
  assert.ok(from >= 0 && to > from)
  const between = events.slice(from, to).filter(event => /^import#\d+:end$/.test(event))
  assert.ok(between.length <= 1, `import steps finished while her save waited: ${between}`)
  assert.ok(to < events.indexOf('import#2:start'), `her save is answered before the second step starts: ${events.join(' ')}`)
})

// The bound is GLOBAL, not per importer. Two importers (two isolates, or two pages, under one
// lease) each send a step to MIRROR, then her app's save arrives: MIRROR admits one thread step at a time and a waiting
// save goes first, so the save waits behind at most ONE import step, however many importers there are.
test('two importers step under one lease while her app saves: the save is answered after ONE import step, before the second importer\'s step', async () => {
  const storage = createStorage([
    ['mirror:bootstrap:v1', { phase: 'ready', seedId: SEED, lineageId: LINEAGE, revision: 1, ballId: 'b'.repeat(64), epoch: 2, batchDigests: ['c'.repeat(64)], nextBatch: 1, entryCount: 1, expectedEntries: 1 }],
    ['mirror:v2:global-fence', { lineageId: LINEAGE, revision: 1 }],
  ])
  const mirror = new MirrorDO({ storage }, {})
  const internal = (path, body) => mirror.fetch(new Request(`https://x61.internal${path}`, { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-x6-internal-authorized': '1', 'x-x6-bootstrap-seed': SEED }, body: JSON.stringify(body) }))
  const granted = await (await internal('/_mirror/lease', { input: { action: 'acquire', clientId: A, tabId: 'rescue-page', label: 'Rescue page' }, ownerApproved: false })).json()
  const lease = { leaseId: granted.lease.leaseId, generation: granted.lease.generation }
  const step = async path => ({ op: 'import', input: { id: await threadIdForPath(path), path, piece: PIECE, from: 0, prefixChain: '0'.repeat(64), parts: [shaHex(path)],
    tail: '', lineEnd: PIECE, sealedLineEnd: PIECE, expect: null, run: { client: A, from: 0 }, lease } })
  const order = []
  const settle = (name, pending) => pending.then(async response => { order.push(name); return { status: response.status, body: await response.json() } })
  // The first importer's step is in MIRROR (its lease read held), the second importer's step is already waiting, THEN her save.
  const { release, arrived } = storage.holdGet('world:v1:lease')
  const first = settle('import 1', internal('/_mirror/thread', await step('/dsh/home/sessions/agent/one/session.v1.jsonl')))
  await arrived
  const second = settle('import 2', internal('/_mirror/thread', await step('/dsh/home/sessions/agent/two/session.v1.jsonl')))
  const batch = { id: `${B}:1`, clientId: B, seq: 1, entries: [['/dsh/home/auma/during.md', { kind: 'file', mode: 0o644, mtimeMs: 1, b64: Buffer.from('saved\n').toString('base64') }]], cloudBase: { lineageId: LINEAGE, revision: 1 } }
  const save = settle('save', internal('/_mirror/delta', { v: 2, batch, digest: await mirrorDigest(batch) }))
  await new Promise(resolve => setTimeout(resolve, 5)) // both are queued behind the held step
  assert.deepEqual(order, [], 'nothing finished while the first step is held')
  release()
  const answers = await Promise.all([first, second, save])
  for (const answer of answers) assert.equal(answer.status, 200, JSON.stringify(answer.body))
  assert.deepEqual(order, ['import 1', 'save', 'import 2'], 'her save went before the second importer\'s step')
})
