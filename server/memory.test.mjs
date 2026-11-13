/** Source-only regressions: all memory, DAG, receipt, and persistence operations use synthetic VFS bytes. */
import assert from 'node:assert/strict'
import * as crypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const DAG = '/dsh/home/auma/memory/dag'
const HEAD = DAG + '/HEAD.json'
const STORE = '/dsh/home/auma/memory-store.v2.json'
const RECEIPTS = '/dsh/home/auma/seed/receipts.v3.jsonl'
const SOURCES = ['/dsh/home/auma/seed/CONTEXT.md', '/dsh/home/auma/seed/WISH.md', '/dsh/home/auma/seed/ledger.jsonl',
  '/dsh/home/auma/NORTH-STAR.md', '/dsh/home/auma/NORTH-STAR-X6.md', '/dsh/home/auma/NORTH-STAR-X5.md']
const code = name => readFileSync(new URL('../mirror/home/auma/seed/organs/' + name + '.js', import.meta.url), 'utf8')
const domainSource = code('auma-memory-domain'), seedSource = code('seed-memory')
const canonical = value => value === null || typeof value !== 'object' ? JSON.stringify(value)
  : Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']'
    : '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}'
const digest = value => crypto.createHash('sha256').update(canonical(value)).digest('hex')
const ioError = code => Object.assign(new Error(code), { code })

function fixture() {
  const files = new Map(), events = [], tools = new Map()
  const fault = { write: null, writeAfter: null, rename: null, renameAfter: null, read: null, receipt: null, flush: null }
  const fs = {
    existsSync: file => files.has(file) || [...files.keys()].some(key => key.startsWith(file + '/')),
    mkdirSync() {},
    readFileSync(file) {
      if (fault.read?.(file)) throw ioError('EACCES')
      if (!files.has(file)) throw ioError('ENOENT')
      return files.get(file)
    },
    statSync(file) { return { isFile: () => true, size: Buffer.byteLength(fs.readFileSync(file)), mtimeMs: 1 } },
    lstatSync(file) { return { isSymbolicLink: () => false, isDirectory: () => !files.has(file) && fs.existsSync(file), isFile: () => files.has(file) } },
    readdirSync(dir) { return [...new Set([...files.keys()].filter(file => file.startsWith(dir + '/')).map(file => file.slice(dir.length + 1).split('/')[0]))] },
    writeFileSync(file, body) {
      events.push(['write', file])
      if (fault.write?.(file)) throw ioError('EIO')
      files.set(file, String(body))
      if (fault.writeAfter?.(file)) throw ioError('EIO_AFTER_WRITE')
    },
    renameSync(from, to) {
      events.push(['rename', to])
      if (fault.rename?.(to)) throw ioError('EIO')
      assert.ok(files.has(from)); files.set(to, files.get(from)); files.delete(from)
      if (fault.renameAfter?.(to)) throw ioError('EIO_AFTER_RENAME')
    },
    unlinkSync(file) { events.push(['unlink', file]); files.delete(file) },
  }
  const ctx = { fs, tools: { register(name, tool) { tools.set(name, tool); return () => {} } },
    snapshots: { persistenceState: () => ({ writable: true }), async flush() { events.push(['flush']); if (fault.flush) throw ioError('FLUSH_FAILED'); return { localSaved: true } } },
    organs: { async call(name, args) {
      assert.equal(name, 'seed-receipts'); events.push(['receipt', args.data.nodeId])
      if (fault.receipt === 'throw') throw ioError('RECEIPT_FAILED')
      if (fault.receipt === 'reject') return { ok: false, error: 'RECEIPT_REJECTED' }
      const rows = (files.get(RECEIPTS) || '').split('\n').filter(Boolean).map(JSON.parse)
      const body = { schema: 'aukora.receipt.v3', seq: rows.length + 1, at: '2026-11-09T00:00:00.000Z',
        prevHash: rows.at(-1)?.leafHash || '0'.repeat(64), kind: args.kind, data: args.data }
      const receipt = { ...body, leafHash: crypto.createHash('sha256').update('\0' + canonical(body)).digest('hex') }
      files.set(RECEIPTS, [...rows, receipt].map(row => JSON.stringify(row)).join('\n') + '\n')
      if (fault.receipt === 'throw-after') throw ioError('RECEIPT_ACK_LOST')
      return { ok: true, receipt }
    } },
  }
  function load(source) {
    const module = { exports: {} }
    new Function('module', 'require', 'Buffer', source)(module, name => {
      if (name === 'fs') return fs
      if (name === 'crypto') return crypto
      if (name === 'path') return path
      throw new Error('Unapproved synthetic dependency: ' + name)
    }, Buffer)
    return module.exports
  }
  const domain = load(domainSource), seed = load(seedSource)
  domain.setup(ctx)
  const run = args => domain.run(args, ctx)
  const dag = args => tools.get('auma_memory_dag').execute(args)
  const node = body => { const row = { ...body, id: digest(body) }; files.set(DAG + '/' + row.id + '.json', JSON.stringify(row)); return row }
  const head = (rows, count = rows.length) => files.set(HEAD, JSON.stringify({ heads: rows.map(row => row.id), count }))
  return { files, events, fault, ctx, run, dag, seed, node, head }
}

for (const mode of ['write', 'rename']) test('DAG ' + mode + ' failure is partial, preserves stored memory and is visible in verification', async () => {
  const f = fixture()
  if (mode === 'write') f.fault.write = file => file.startsWith(DAG + '/') && file !== HEAD + '.tmp'
  else f.fault.rename = file => file === HEAD
  const result = await f.run({ action: 'remember', fact: 'Synthetic durable memory', key: 'round26' })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'DAG_APPEND_FAILED')
  assert.equal(result.vfsSaved, true)
  assert.equal(result.memorySaved, true)
  assert.equal(result.localSaved, true)
  assert.equal(result.dagSaved, false)
  assert.equal(result.outcome, 'partial')
  assert.equal(JSON.parse(f.files.get(STORE)).facts.length, 1)
  assert.equal(f.events.filter(([event]) => event === 'receipt').length, 0)
  const verification = await f.dag({ action: 'dag_verify' })
  assert.equal(verification.ok, false)
  assert.ok(verification.errors.some(error => error.error === 'DAG_MEMORY_NODE_MISSING'))
  assert.equal(verification.memoryWithoutDag.length, 1)
  assert.equal(f.events.filter(([event, file]) => event === 'unlink' && !file.includes('.tmp')).length, 0)
})

for (const mode of ['reject', 'throw', 'unavailable']) test('receipt ' + mode + ' cannot return successful remember', async () => {
  const f = fixture(); f.fault.receipt = mode
  if (mode === 'unavailable') delete f.ctx.organs
  const result = await f.run({ action: 'remember', fact: 'Synthetic receipt gap' })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'DAG_APPEND_FAILED')
  assert.equal(result.dagAnchor.ok, false)
  assert.equal(result.memorySaved, true)
  assert.equal(result.dagSaved, true)
  assert.equal(result.vfsSaved, true)
  assert.equal(result.localSaved, true)
  assert.equal(result.outcome, 'partial')
  assert.equal(JSON.parse(f.files.get(STORE)).facts.length, 1)
})

test('successful store reports acknowledged memory, DAG and receipt effects', async () => {
  const f = fixture(), result = await f.run({ action: 'remember', fact: 'Synthetic success' })
  assert.equal(result.ok, true)
  assert.equal(result.memorySaved, true)
  assert.equal(result.dagSaved, true)
  assert.equal(result.dagAnchor.ok, true)
  assert.equal(result.localSaved, true)
  assert.equal((await f.dag({ action: 'dag_verify' })).ok, true)
})

test('a flush error never claims local durability after partial DAG failure', async () => {
  const f = fixture(); f.fault.receipt = 'reject'; f.fault.flush = true
  const result = await f.run({ action: 'remember', fact: 'Synthetic unflushed fact' })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'DAG_APPEND_FAILED')
  assert.equal(result.vfsSaved, true)
  assert.equal(result.localSaved, false)
  assert.equal(result.saveError, 'FLUSH_FAILED')
})

test('valid explicit roots and parents alias retain lineage and count mismatch detection', async () => {
  const f = fixture(), root = f.node({ content: 'Synthetic root', parentIds: [] })
  const child = f.node({ content: 'Synthetic alias child', parents: [root.id] })
  f.head([child], 2)
  assert.equal((await f.dag({ action: 'dag_verify' })).ok, true)
  const lineage = await f.dag({ action: 'dag_lineage' })
  assert.equal(lineage.ok, true)
  assert.deepEqual(lineage.chain[0].parentIds, [root.id])
  assert.equal(lineage.nodes, 2)
  f.head([child], 3)
  assert.ok((await f.dag({ action: 'dag_verify' })).errors.some(error => error.error === 'DAG_UNREACHABLE_ORPHANS'))
})

for (const parents of [{}, { parents: null }, { parentIds: 'bad' }, { parentIds: [], parents: ['a'.repeat(64)] }, { parentIds: [], parents: null }, { parents: ['invalid'] }]) {
  test('unreadable parent schema fails both walkers: ' + JSON.stringify(parents), async () => {
    const f = fixture(), root = f.node({ content: 'Synthetic invalid schema', ...parents }); f.head([root])
    const result = await f.dag({ action: 'dag_verify' })
    assert.equal(result.ok, false)
    assert.ok(result.errors.some(error => error.error === 'DAG_SCHEMA_UNREADABLE'))
    const lineage = await f.dag({ action: 'dag_lineage' })
    assert.equal(lineage.ok, false)
    assert.ok(lineage.chain.some(link => link.error === 'DAG_SCHEMA_UNREADABLE'))
  })
}

for (const head of ['{', 'null', '{}', '{"heads":[],"count":-1}', '{"heads":["invalid"],"count":1}']) {
  test('invalid HEAD is not an empty successful DAG: ' + head, async () => {
    const f = fixture(); f.files.set(HEAD, head)
    const verification = await f.dag({ action: 'dag_verify' })
    assert.equal(verification.ok, false)
    assert.equal(verification.error, 'DAG_HEAD_UNREADABLE')
    const result = await f.dag({ action: 'dag_write', fact: 'Synthetic refusal' })
    assert.equal(result.ok, false)
    assert.equal(f.files.get(HEAD), head)
    assert.equal(f.events.filter(([event]) => event === 'write').length, 0)
  })
}

test('unreadable HEAD is distinct from absent HEAD', async () => {
  const f = fixture(); f.head([]); f.fault.read = file => file === HEAD
  assert.equal((await f.dag({ action: 'dag_verify' })).error, 'DAG_HEAD_UNREADABLE')
})

for (const dagParents of [['invalid'], 'invalid', null]) test('explicit invalid DAG parents are rejected, not filtered: ' + JSON.stringify(dagParents), async () => {
  const f = fixture(), result = await f.dag({ action: 'dag_write', fact: 'Synthetic invalid parents', dagParents })
  assert.equal(result.ok, false)
  assert.equal(f.events.filter(([event]) => event === 'write').length, 0)
})

test('a node outside HEAD is reported even if the declared count matches reachable nodes', async () => {
  const f = fixture(), root = f.node({ content: 'Synthetic reachable', parentIds: [] })
  f.node({ content: 'Synthetic orphan', parentIds: [] }); f.head([root])
  assert.ok((await f.dag({ action: 'dag_verify' })).errors.some(error => error.error === 'DAG_UNREACHABLE_ORPHANS'))
})

test('unreadable recall sources retain partial hits and explicit coverage counts', () => {
  const f = fixture(); SOURCES.forEach(file => f.files.set(file, ''))
  f.files.set(SOURCES[0], 'Synthetic needle line\n'); f.fault.read = file => file === SOURCES[1]
  const result = f.seed.run({ action: 'recall', query: 'needle' })
  assert.equal(result.status, 'UNDETERMINED')
  assert.equal(result.unreadableCount, 1)
  assert.equal(result.readableCount, 5)
  assert.equal(result.sourceCount, 6)
  assert.equal(result.scanned, 1)
  assert.equal(result.hits.length, 1)
  assert.equal(result.gaps[0].file, SOURCES[1])
  assert.equal(result.complete, false)
  const stats = f.seed.run({ action: 'stats' })
  assert.equal(stats.unreadableCount, 1)
  assert.equal(stats.status, 'UNDETERMINED')
})

test('an unreadable source does not consume the readable recall match limit', () => {
  const f = fixture(), limit = 3
  SOURCES.forEach(file => f.files.set(file, ''))
  f.files.set(SOURCES[0], 'Synthetic unrelated text\n')
  const matches = Array.from({ length: limit }, (_, index) => JSON.stringify({ kind: 'memory', text: 'Synthetic needle ' + index }))
  f.files.set(SOURCES[2], matches.join('\n') + '\n')
  f.fault.read = file => file === SOURCES[1]
  const before = new Map(f.files)
  const result = f.seed.run({ action: 'recall', query: 'needle', limit })
  assert.equal(result.hits.length, limit)
  assert.deepEqual(result.hits.map(hit => hit.row.text), matches)
  assert.equal(result.scanned, limit + 1)
  assert.equal(result.status, 'UNDETERMINED')
  assert.equal(result.complete, false)
  assert.equal(result.sourceCount, 6)
  assert.equal(result.readableCount, 5)
  assert.equal(result.unreadableCount, 1)
  assert.deepEqual(result.gaps, [{ kind: 'wish', file: SOURCES[1], error: 'SOURCE_UNREADABLE', cause: 'EACCES' }])
  assert.deepEqual(f.files, before)
  assert.deepEqual(f.events, [])
})

test('unreadable empty and readable empty recall remain distinct', () => {
  const f = fixture()
  const missing = f.seed.run({ action: 'recall', query: 'needle' })
  assert.equal(missing.status, 'UNDETERMINED')
  assert.equal(missing.unreadableCount, 6)
  SOURCES.forEach(file => f.files.set(file, ''))
  const empty = f.seed.run({ action: 'recall', query: 'needle' })
  assert.equal(empty.status, 'EMPTY')
  assert.equal(empty.unreadableCount, 0)
  assert.equal(empty.complete, true)
  assert.deepEqual(empty.gaps, [])
})


test('a rejected memory-store write stops DAG and receipt work', async () => {
  const f = fixture(); f.fault.write = file => file.startsWith(STORE + '.tmp-')
  const result = await f.run({ action: 'remember', fact: 'Synthetic rejected store' })
  assert.equal(result.ok, false)
  assert.equal(result.memorySaved, false)
  assert.equal(result.vfsSaved, false)
  assert.equal(result.localSaved, false)
  assert.equal(f.files.has(STORE), false)
  assert.equal(f.events.some(([event, file]) => event === 'receipt' || event === 'write' && file.startsWith(DAG)), false)
})

for (const target of ['node', 'head', 'store']) test('thrown-after-write ' + target + ' reports uncertainty and preserves bytes', async () => {
  const f = fixture()
  if (target === 'node') f.fault.writeAfter = file => file.startsWith(DAG + '/') && file !== HEAD + '.tmp'
  else f.fault.renameAfter = file => file === (target === 'head' ? HEAD : STORE)
  const result = await f.run({ action: 'remember', fact: 'Synthetic uncertain write' })
  assert.equal(result.ok, false)
  assert.equal(result.localSaved, true)
  assert.equal(JSON.parse(f.files.get(STORE)).facts.length, 1)
  if (target === 'store') {
    assert.equal(result.memorySaved, null)
    assert.equal(result.vfsSaved, null)
    assert.deepEqual(result.dagWrites, [])
  } else {
    assert.equal(result.error, 'DAG_APPEND_FAILED')
    assert.equal(result.memorySaved, true)
    assert.equal(result.dagWrites[0][target === 'node' ? 'nodeSaved' : 'headSaved'], null)
    assert.equal([...f.files.keys()].filter(file => /^.*\/[a-f0-9]{64}\.json$/.test(file)).length, 1)
  }
})

test('a later DAG failure preserves every prior record and node byte', async () => {
  const f = fixture(), first = await f.run({ action: 'remember', fact: 'Synthetic original memory', key: 'original' })
  const originalRecord = JSON.parse(f.files.get(STORE)).facts[0]
  const originalDag = new Map([...f.files].filter(([file]) => file.startsWith(DAG + '/')))
  f.fault.write = file => file.startsWith(DAG + '/')
  const result = await f.run({ action: 'remember', fact: 'Synthetic later memory', key: 'later' })
  assert.equal(result.error, 'DAG_APPEND_FAILED')
  assert.deepEqual(JSON.parse(f.files.get(STORE)).facts[0], originalRecord)
  for (const [file, body] of originalDag) assert.equal(f.files.get(file), body)
  const verification = await f.dag({ action: 'dag_verify' })
  assert.equal(verification.memoryWithoutDag.length, 1)
  assert.equal(verification.memoryWithoutDag.includes(first.entry.memoryId), false)
})

test('repeated tombstone remains idempotent in both store and DAG', async () => {
  const f = fixture(), first = await f.run({ action: 'remember', fact: 'Synthetic deletable memory' })
  const args = { action: 'tombstone', memoryId: first.entry.memoryId }
  assert.equal((await f.run(args)).ok, true)
  const before = new Map(f.files)
  assert.equal((await f.run(args)).ok, true)
  assert.deepEqual(f.files, before)
})

test('explicit DAG roots and matching aliases remain valid; direct writes retain anchor compatibility', async () => {
  const f = fixture(), result = await f.dag({ action: 'dag_write', fact: 'Synthetic explicit root', dagParents: [] })
  assert.equal(result.ok, true)
  assert.equal(result.anchor.ok, true)
  assert.equal(result.dagAnchor.ok, true)
  assert.equal(result.localSaved, true)
  assert.deepEqual(result.node.parentIds, [])
  const alias = f.node({ content: 'Synthetic matching aliases', parentIds: [result.node.id], parents: [result.node.id] })
  f.head([alias], 2)
  assert.equal((await f.dag({ action: 'dag_verify' })).ok, true)
})

for (const value of ['{', '{}']) test('unreadable prior receipt head stops append without pretending an empty ledger: ' + value, async () => {
  const f = fixture(); f.files.set(RECEIPTS, value)
  const result = await f.run({ action: 'remember', fact: 'Synthetic receipt history gap' })
  assert.equal(result.error, 'DAG_APPEND_FAILED')
  assert.equal(result.dagError, 'DAG_RECEIPTS_UNREADABLE')
  assert.equal(result.memorySaved, true)
  assert.equal(result.dagSaved, false)
  assert.equal(f.files.get(RECEIPTS), value)
})

function addSession(f) {
  const header = { type: 'session', version: 4, id: 'round26-session' }
  const event = { seq: 0, time: 1, type: 'user/message', surfaceOp: 'append', data: { id: 'synthetic-message', role: 'user',
    source: { kind: 'user' }, content: [{ type: 'text', text: 'Synthetic distill source' }] } }
  f.files.set('/dsh/home/sessions/synthetic/session.v4.jsonl', JSON.stringify(header) + '\n' + JSON.stringify(event) + '\n')
}

test('distill stops dependent DAG/receipt work after a partial multi-fact failure', async () => {
  const f = fixture(); addSession(f)
  let writes = 0
  f.fault.write = file => /^.*\/[a-f0-9]{64}\.json$/.test(file) && ++writes === 2
  const result = await f.run({ action: 'distill', sessionId: 'round26-session', facts: [1, 2, 3].map(n => ({ fact: 'Synthetic distilled fact ' + n })) })
  assert.equal(result.error, 'DAG_APPEND_FAILED')
  assert.equal(result.memorySaved, true)
  assert.equal(result.dagSaved, false)
  assert.equal(result.dagWrites.length, 2)
  assert.equal(result.memoryIds.length, 3)
  assert.equal(result.dagAnchor.pending.length, 1)
  assert.equal(f.events.some(([event]) => event === 'receipt'), false)
  const store = JSON.parse(f.files.get(STORE))
  assert.equal(store.facts.length, 3)
  assert.equal(store.sessionChunks.length, 1)
  assert.equal((await f.dag({ action: 'dag_verify' })).memoryWithoutDag.length, 2)
})

test('malformed receipt acknowledgement is never accepted as a confirmed anchor', async () => {
  const f = fixture(); f.ctx.organs.call = async () => ({ ok: true, receipt: {} })
  const result = await f.run({ action: 'remember', fact: 'Synthetic bad acknowledgement' })
  assert.equal(result.error, 'DAG_APPEND_FAILED')
  assert.equal(result.dagAnchor.error, 'RECEIPT_NOT_ACKNOWLEDGED')
  assert.deepEqual(result.dagAnchor.receipts, [])
})


for (const action of ['tombstone', 'forget']) for (const mode of ['node', 'head', 'receipt']) {
  test('retry ' + action + ' after ' + mode + ' failure retains the incomplete result without duplicate writes', async () => {
    const f = fixture(), first = await f.run({ action: 'remember', fact: 'Synthetic retry target' })
    if (mode === 'node') f.fault.write = file => file.startsWith(DAG + '/')
    if (mode === 'head') f.fault.rename = file => file === HEAD
    if (mode === 'receipt') f.fault.receipt = 'reject'
    const args = { action, memoryId: first.entry.memoryId }
    const failed = await f.run(args)
    assert.equal(failed.error, 'DAG_APPEND_FAILED')
    f.fault.write = null; f.fault.rename = null; f.fault.receipt = null
    const before = new Map(f.files), eventCount = f.events.length
    const retry = await f.run(args)
    assert.equal(retry.ok, false)
    assert.equal(retry.error, 'DAG_APPEND_FAILED')
    assert.equal(retry.memorySaved, true)
    assert.equal(retry.dagSaved, mode === 'receipt')
    assert.deepEqual(retry.memoryIds, failed.memoryIds)
    assert.deepEqual(f.files, before)
    assert.equal(f.events.slice(eventCount).some(([event]) => ['write', 'rename', 'unlink', 'receipt'].includes(event)), false)
  })
}

for (const action of ['tombstone', 'forget']) test('successful ' + action + ' repeat verifies existing receipt without reappending', async () => {
  const f = fixture(), first = await f.run({ action: 'remember', fact: 'Synthetic verified retry target' })
  const args = { action, memoryId: first.entry.memoryId }, initial = await f.run(args)
  assert.equal(initial.ok, true)
  const before = new Map(f.files), eventCount = f.events.length
  const repeat = await f.run(args)
  assert.equal(repeat.ok, true)
  assert.equal(repeat.dagSaved, true)
  assert.equal(repeat.dagAnchor.ok, true)
  assert.equal(repeat.dagAnchor.existing, true)
  assert.deepEqual(repeat.dagAnchor.receipts, initial.dagAnchor.receipts)
  assert.deepEqual(f.files, before)
  assert.equal(f.events.slice(eventCount).some(([event]) => ['write', 'rename', 'unlink', 'receipt'].includes(event)), false)
})

test('receipt written before lost acknowledgement can be confirmed on retry without another append', async () => {
  const f = fixture(), first = await f.run({ action: 'remember', fact: 'Synthetic uncertain receipt target' })
  const args = { action: 'forget', memoryId: first.entry.memoryId }
  f.fault.receipt = 'throw-after'
  assert.equal((await f.run(args)).error, 'DAG_APPEND_FAILED')
  f.fault.receipt = null
  const before = new Map(f.files), eventCount = f.events.length
  const retry = await f.run(args)
  assert.equal(retry.ok, true)
  assert.equal(retry.dagAnchor.existing, true)
  assert.deepEqual(f.files, before)
  assert.equal(f.events.slice(eventCount).some(([event]) => ['write', 'rename', 'unlink', 'receipt'].includes(event)), false)
})

for (const action of ['remember', 'distill']) test('' + action + ' reports candidate IDs after uncertain store rename', async () => {
  const f = fixture(); f.fault.renameAfter = file => file === STORE
  if (action === 'distill') addSession(f)
  const result = await f.run(action === 'remember' ? { action, fact: 'Synthetic uncertain candidate' }
    : { action, sessionId: 'round26-session', facts: [{ fact: 'Synthetic candidate one' }, { fact: 'Synthetic candidate two' }] })
  assert.equal(result.ok, false)
  assert.equal(result.memorySaved, null)
  assert.deepEqual(result.memoryIds, JSON.parse(f.files.get(STORE)).facts.map(row => row.memoryId))
  assert.equal(result.memoryIds.length, action === 'remember' ? 1 : 2)
})

for (const mode of ['missing', 'unreadable', 'truncated', 'invalid-json', 'broken-chain', 'wrong-payload']) {
  test('repeat refuses ' + mode + ' persisted receipt evidence without rewriting it', async () => {
    const f = fixture(), first = await f.run({ action: 'remember', fact: 'Synthetic receipt evidence target' })
    const args = { action: 'forget', memoryId: first.entry.memoryId }
    assert.equal((await f.run(args)).ok, true)
    if (mode === 'missing') f.files.delete(RECEIPTS)
    else if (mode === 'unreadable') f.fault.read = file => file === RECEIPTS
    else if (mode === 'truncated') f.files.set(RECEIPTS, f.files.get(RECEIPTS).trimEnd())
    else if (mode === 'invalid-json') f.files.set(RECEIPTS, '{\n')
    else {
      const rows = f.files.get(RECEIPTS).trimEnd().split('\n').map(JSON.parse), last = rows.at(-1)
      if (mode === 'broken-chain') last.prevHash = '0'.repeat(64)
      else last.data.payloadHash = '0'.repeat(64)
      const { leafHash, ...body } = last
      last.leafHash = crypto.createHash('sha256').update('\0' + canonical(body)).digest('hex')
      f.files.set(RECEIPTS, rows.map(row => JSON.stringify(row)).join('\n') + '\n')
    }
    const before = new Map(f.files), eventCount = f.events.length
    const retry = await f.run(args)
    assert.equal(retry.error, 'DAG_APPEND_FAILED')
    assert.equal(retry.ok, false)
    assert.equal(retry.memorySaved, true)
    assert.equal(retry.dagSaved, true)
    assert.deepEqual(f.files, before)
    assert.equal(f.events.slice(eventCount).some(([event]) => ['write', 'rename', 'unlink', 'receipt'].includes(event)), false)
  })
}

test('a reachable node with the same memory ID but different content cannot confirm a repeat', async () => {
  const f = fixture(), first = await f.run({ action: 'remember', fact: 'Synthetic node evidence target' })
  const args = { action: 'tombstone', memoryId: first.entry.memoryId }
  const initial = await f.run(args), nodeId = initial.dagWrites[0].nodeId
  const { id, ...body } = JSON.parse(f.files.get(DAG + '/' + nodeId + '.json'))
  f.files.delete(DAG + '/' + nodeId + '.json')
  const replacement = f.node({ ...body, content: 'Different synthetic content' }); f.head([replacement], 2)
  const before = new Map(f.files), eventCount = f.events.length
  const retry = await f.run(args)
  assert.equal(retry.error, 'DAG_APPEND_FAILED')
  assert.equal(retry.dagError, 'DAG_MEMORY_NODE_MISMATCH')
  assert.deepEqual(f.files, before)
  assert.equal(f.events.slice(eventCount).some(([event]) => ['write', 'rename', 'unlink', 'receipt'].includes(event)), false)
})
