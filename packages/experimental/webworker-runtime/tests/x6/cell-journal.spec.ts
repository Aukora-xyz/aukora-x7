/**
 * Her cells become visible to her (BODY-MAP D1, D3), in the runtime only.
 *  - every pinned cell is a row: its pin, size, fuel grant, ops, and what THIS session's host saw when it loaded it
 *    (`verified` only after admitCell accepted the fetched bytes; `failed` with a closed reason; else `not-loaded`);
 *  - every call to a pinned cell leaves one journal line (digests of the exact request and answer bytes, never the bytes),
 *    totals never cut, the newest 32 lines, and a running root that two readers of one session read alike;
 *  - a journal that throws or cannot hash changes no answer, byte for byte;
 *  - `x6_self_state` shows `cellCount`, `cells` (cut after the shadow's mismatches and before organs) and `cellJournal`;
 *  - `x6_cell {"action":"journal"}` reads it, as a read everywhere reads are classified.
 * Local only: real pinned cell bytes from apps/web/public/cells, Node worker_threads for her cell worker, the e4 fixture's
 * reserved `.invalid` origin. No network.
 */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { Worker } from 'node:worker_threads'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { classifyActionIrreversibility } from '../../src/x6/ball-loader.ts'
import { classifyToolMutation } from '../../src/x6/capability-index.ts'
import {
  CELL_JOURNAL_LINES, CELL_JOURNAL_ROOT_0, CELL_JOURNAL_SEED, cellCallStatus, cellLoadFailure, createCellJournal,
  type CellCallRecord, type CellJournal, type CellJournalLine, type CellJournalRead, type CellRow,
} from '../../src/x6/cell-journal.ts'
import { cellFactsOf, projectSelfState, SELF_STATE_RESULT_BYTES, type SelfStateRegistry } from '../../src/x6/self-state.ts'
import { voiceVerdict } from '../../src/x6/voice-read-only.ts'
import * as wasmCells from '../../src/x6/wasm-cells.ts'
import { CELL_BROWSER_FUEL_CAP, CELL_PINS, cellCanonicalJson, createCellHost, organCellHost,
  type CellHost, type CellPin, type CellWorker } from '../../src/x6/wasm-cells.ts'
import { FakeSocket, mountE4 } from './e4-fixture.ts'

type J = Record<string, unknown>
const CELLS = new URL('../../../../../apps/web/public/cells/', import.meta.url)
const ORIGIN = 'https://lane-e4-fixture.invalid'
const sha = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex')

const served = (override: Record<string, Uint8Array | number> = {}): typeof fetch => async (input: RequestInfo | URL) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
  const name = url.pathname.replace(/^\/cells\//, '').replace(/\.wasm$/, '')
  if (url.origin !== ORIGIN || !url.pathname.startsWith('/cells/')) return new Response('no', { status: 404 })
  const replaced = override[name]
  if (typeof replaced === 'number') return new Response('gone', { status: replaced })
  const bytes = replaced ?? new Uint8Array(await readFile(new URL(`${name}.wasm`, CELLS)))
  return new Response(Uint8Array.from(bytes), { headers: { 'content-type': 'application/wasm' } })
}

const hosts = new Set<CellHost>()
const workers = new Set<Worker>()
const nodeCellWorker = (source: string): CellWorker => {
  const worker = new Worker(`
    const { parentPort } = require('node:worker_threads');
    globalThis.postMessage = value => parentPort.postMessage(value);
    parentPort.on('message', data => globalThis.onmessage({ data }));
    ${source}
  `, { eval: true, execArgv: [] })
  workers.add(worker)
  return {
    listen(onMessage, onFailure) { worker.on('message', onMessage); worker.on('error', onFailure); worker.on('messageerror', onFailure) },
    postMessage: (message) => { worker.postMessage(message) },
    async terminate() { await worker.terminate(); worker.removeAllListeners(); workers.delete(worker) },
  }
}
/** A host on a Node worker with a fixed clock (every `ms` is 0). */
const testHost = (deps: Partial<Parameters<typeof createCellHost>[0]> = {}): CellHost => {
  const host = createCellHost({ origin: ORIGIN, fetchImpl: served(), createWorker: nodeCellWorker, now: () => 0, ...deps })
  hosts.add(host)
  return host
}
afterEach(async () => {
  FakeSocket.instances.length = 0
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  try { await Promise.all([...hosts].map(host => host.dispose())) }
  finally {
    hosts.clear()
    await Promise.all([...workers].map(worker => worker.terminate()))
    workers.clear()
  }
})

/** The exact request bytes the host sends: the cell ABI's canonical JSON of `{ abi, input, op, seq }`. */
const requestSha = (op: string, input: unknown, seq: number): string => sha(cellCanonicalJson({ abi: 1, input, op, seq }))
/** Recompute the root over lines given oldest first, from the seed, independently of the journal. */
const rootOver = (lines: readonly CellJournalLine[]): string =>
  lines.reduce((root, line) => sha(`${root}${cellCanonicalJson(line)}`), sha(CELL_JOURNAL_SEED))

const call = (overrides: Partial<CellCallRecord> = {}): CellCallRecord => ({
  cell: 'nostr-core', op: 'nostr.ping', pin: CELL_PINS['nostr-core']!.sha256, request: new Uint8Array([1, 2, 3]), answer: '{"abi":1}',
  code: null, fuelUsed: 10, ms: 3.4, caller: 'x6_cell', ...overrides,
})

/** Tiny hand-built modules for the load reasons (header, type, optional import, memory). */
const wasm = (...sections: number[][]): Uint8Array => new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, ...sections.flat()])
const TYPE_SECTION = [0x01, 0x04, 0x01, 0x60, 0x00, 0x00]
const IMPORT_SECTION = [0x02, 0x07, 0x01, 0x01, 0x6d, 0x01, 0x66, 0x00, 0x00]
const WITH_IMPORT = wasm(TYPE_SECTION, IMPORT_SECTION, [0x05, 0x04, 0x01, 0x01, 0x01, 0x01])
const OVER_CAP = wasm([0x05, 0x05, 0x01, 0x01, 0x01, 0x88, 0x27]) // max 5000 pages > 4096
const pinOf = (bytes: Uint8Array): CellPin => ({ sha256: sha(bytes), bytes: bytes.byteLength, fuel: 1000, ops: ['x.run'] })

describe('the journal, on its own', () => {
  it('root_0 is the SHA-256 of the seed, and each line moves the root by the published rule', async () => {
    expect(CELL_JOURNAL_ROOT_0).toBe(sha(CELL_JOURNAL_SEED))
    const journal = createCellJournal({ canonical: cellCanonicalJson })
    expect(journal.summary()).toEqual({ calls: 0, rootSha256: CELL_JOURNAL_ROOT_0 })
    journal.record(call())
    journal.record(call({ cell: 'seed-judge', op: 'seed.platform', code: 'TRAP', answer: null, fuelUsed: null, caller: 'nucleus-shadow', pin: 'f'.repeat(64) }))
    const read = await journal.read()
    const first: CellJournalLine = { n: 1, cell: 'nostr-core', op: 'nostr.ping', pin: CELL_PINS['nostr-core']!.sha256,
      inputSha256: sha(new Uint8Array([1, 2, 3])), outputSha256: sha('{"abi":1}'), status: 'ok', fuelUsed: 10, ms: 3, caller: 'x6_cell' }
    const second: CellJournalLine = { n: 2, cell: 'seed-judge', op: 'seed.platform', pin: 'f'.repeat(64),
      inputSha256: sha(new Uint8Array([1, 2, 3])), outputSha256: null, status: 'trap', fuelUsed: null, ms: 3, caller: 'nucleus-shadow' }
    expect(read).toEqual({ ok: true, totals: { byCell: { 'nostr-core': 1, 'seed-judge': 1 }, byStatus: { ok: 1, refused: 0, trap: 1, fuel: 0, timeout: 0 },
      calls: 2, lost: 0 }, lines: [second, first], rootSha256: rootOver([first, second]) })
    // Two readers of one session read the same root; the summary agrees once settled.
    expect((await journal.read()).rootSha256).toBe(read.rootSha256)
    expect(journal.summary()).toEqual({ calls: 2, rootSha256: read.rootSha256 })
    // Key order of a line is the brief's: n, cell, op, pin, inputSha256, outputSha256, status, fuelUsed, ms, caller.
    expect(Object.keys(read.lines[0]!)).toEqual(['n', 'cell', 'op', 'pin', 'inputSha256', 'outputSha256', 'status', 'fuelUsed', 'ms', 'caller'])
  })

  it(`keeps the newest ${String(CELL_JOURNAL_LINES)} lines and never cuts the totals or the root`, async () => {
    const journal = createCellJournal({ canonical: cellCanonicalJson })
    const all: CellJournalLine[] = []
    for (let i = 1; i <= 40; i += 1) {
      const record = call({ op: `nostr.op${String(i)}`, ms: i })
      journal.record(record)
      all.push({ n: i, cell: record.cell, op: record.op, pin: record.pin, inputSha256: sha(record.request!),
        outputSha256: sha(record.answer!),
        status: 'ok', fuelUsed: 10, ms: i, caller: 'x6_cell' })
    }
    const read = await journal.read()
    expect(read.totals).toEqual({ byCell: { 'nostr-core': 40 }, byStatus: { ok: 40, refused: 0, trap: 0, fuel: 0, timeout: 0 }, calls: 40, lost: 0 })
    expect(read.lines.map(line => line.n)).toEqual(Array.from({ length: CELL_JOURNAL_LINES }, (_v, i) => 40 - i))
    expect(read.rootSha256).toBe(rootOver(all))
  })

  it('a line that cannot be hashed is lost, counted, and moves nothing else', async () => {
    let fail = false
    const journal = createCellJournal({ canonical: cellCanonicalJson,
      sha256: async (bytes) => { if (fail) throw new Error('no digest'); return sha(bytes) } })
    journal.record(call())
    const before = await journal.read()
    fail = true
    journal.record(call({ op: 'nostr.lost' }))
    const during = await journal.read()
    expect(during.totals).toEqual({ ...before.totals, lost: 1 })
    expect(during.rootSha256).toBe(before.rootSha256)
    fail = false
    journal.record(call({ op: 'nostr.after' }))
    const after = await journal.read()
    // The lost call keeps its number: the next line is n 3, and the gap says one line is missing.
    expect(after.lines.map(line => line.n)).toEqual([3, 1])
    expect(after.totals.calls).toBe(2)
  })

  it('statuses and load reasons are closed', () => {
    expect([null, 'TRAP', 'FUEL', 'TIMEOUT', 'MODULE_HASH', 'REFUSED', 'MALFORMED_RESPONSE'].map(cellCallStatus))
      .toEqual(['ok', 'trap', 'fuel', 'timeout', 'refused', 'refused', 'refused'])
    expect([['MODULE_HASH', false], ['MODULE_BOUND', false], ['MODULE_IMPORTS', false], ['MODULE_MEMORY_IMPORTED', false],
      ['MODULE_MEMORY_LIMIT', false], ['MODULE_MEMORY_UNBOUNDED', false], ['MODULE_UNAVAILABLE', true], [null, true],
      ['ORIGIN_UNAVAILABLE', true], ['MODULE_EXPORTS', false], [null, false]].map(([code, fetching]) => cellLoadFailure(code as string | null, fetching as boolean)))
      .toEqual(['pin-mismatch', 'pin-mismatch', 'imports-present', 'imports-present', 'memory-over-cap', 'memory-over-cap', 'fetch-failed',
        'fetch-failed', 'fetch-failed', 'admission-failed', 'admission-failed'])
  })
})

describe('the cell host keeps load states and journals every pinned-cell call', () => {
  it('rows: every pinned cell, sorted, not-loaded until this host verifies it; a refused load says why', async () => {
    const tampered = new Uint8Array(await readFile(new URL('seed-judge.wasm', CELLS)))
    tampered[100] = tampered[100]! ^ 1
    const host = testHost({ fetchImpl: served({ 'seed-judge': tampered, 'gate-judge': 404 }) })
    const rows = host.cellRows()
    expect(rows.map(row => row.cell)).toEqual(Object.keys(CELL_PINS).sort())
    expect(rows).toHaveLength(30)
    expect(rows.every(row => row.loaded === 'not-loaded' && !('failure' in row))).toBe(true)
    expect(await host.invoke('nostr-core', 'nostr.ping')).toMatchObject({ ok: true })
    expect(await host.invoke('seed-judge', 'seed.platform', { platform: 'browser' })).toMatchObject({ ok: false, code: expect.stringMatching(/^MODULE_HASH/) as string })
    expect(await host.invoke('gate-judge', 'gate.step')).toMatchObject({ ok: false, code: 'MODULE_UNAVAILABLE (HTTP 404)' })
    const after = Object.fromEntries(host.cellRows().map(row => [row.cell, row]))
    const nostr = CELL_PINS['nostr-core']!
    expect(after['nostr-core']).toEqual({ cell: 'nostr-core', sha256: nostr.sha256, bytes: nostr.bytes,
      fuel: Math.min(nostr.fuel, CELL_BROWSER_FUEL_CAP), ops: [...nostr.ops!], loaded: 'verified' } satisfies CellRow)
    expect(after['seed-judge']).toMatchObject({ loaded: 'failed', failure: 'pin-mismatch' })
    expect(after['gate-judge']).toMatchObject({ loaded: 'failed', failure: 'fetch-failed' })
    expect(after['aura-focus']).toMatchObject({ loaded: 'not-loaded' })
    expect(after['aura-focus']).not.toHaveProperty('failure')
    // No origin: nothing can be fetched.
    const away = testHost({ origin: undefined })
    await away.invoke('nostr-core', 'nostr.ping')
    expect(away.cellRows().find(row => row.cell === 'nostr-core')).toMatchObject({ loaded: 'failed', failure: 'fetch-failed' })
  })

  it('rows: imports present and memory over the cap are refused by name (hand-built modules under their own pins)', async () => {
    const host = testHost({ pins: { 'with-import': pinOf(WITH_IMPORT), 'over-cap': pinOf(OVER_CAP) },
      fetchImpl: served({ 'with-import': WITH_IMPORT, 'over-cap': OVER_CAP }) })
    expect(await host.invoke('with-import', 'x.run')).toMatchObject({ ok: false, code: 'MODULE_IMPORTS' })
    expect(await host.invoke('over-cap', 'x.run')).toMatchObject({ ok: false, code: expect.stringMatching(/^MODULE_MEMORY_LIMIT/) as string })
    expect(host.cellRows().map(row => [row.cell, row.loaded, row.failure])).toEqual([
      ['over-cap', 'failed', 'memory-over-cap'], ['with-import', 'failed', 'imports-present']])
    // A refused load is a journal line too: no request was sent, so no digests.
    const read = await host.journal()
    expect(read.lines.map(line => [line.cell, line.status, line.inputSha256, line.outputSha256])).toEqual([
      ['over-cap', 'refused', null, null], ['with-import', 'refused', null, null]])
  })

  it('journal: the digests of the exact request bytes sent, the answer received, the caller, and the root', async () => {
    const host = testHost()
    const ping = await host.invoke('nostr-core', 'nostr.ping', {}, 'x6_cell')
    const platform = await host.invoke('seed-judge', 'seed.platform', { platform: 'browser' }, 'nucleus-shadow')
    expect([ping.ok, platform.ok]).toEqual([true, true])
    const read = await host.journal()
    expect(read.totals).toEqual({ byCell: { 'nostr-core': 1, 'seed-judge': 1 }, byStatus: { ok: 2, refused: 0, trap: 0, fuel: 0, timeout: 0 }, calls: 2, lost: 0 })
    const [second, first] = read.lines as [CellJournalLine, CellJournalLine]
    expect(first).toMatchObject({ n: 1, cell: 'nostr-core', op: 'nostr.ping', pin: CELL_PINS['nostr-core']!.sha256,
      inputSha256: requestSha('nostr.ping', {}, 1), status: 'ok', fuelUsed: ping.fuelUsed, ms: 0, caller: 'x6_cell' })
    expect(second).toMatchObject({ n: 2, cell: 'seed-judge', op: 'seed.platform', inputSha256: requestSha('seed.platform', { platform: 'browser' }, 1),
      status: 'ok', fuelUsed: platform.fuelUsed, caller: 'nucleus-shadow' })
    expect(first.outputSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(read.rootSha256).toBe(rootOver([first, second]))
    // Never the input or the answer themselves.
    expect(JSON.stringify(read)).not.toContain('browser')
    expect(JSON.stringify(read)).not.toContain('pong')
    // Another session making the same calls reads the same lines and root (the cells are deterministic).
    const other = testHost()
    await other.invoke('nostr-core', 'nostr.ping', {}, 'x6_cell')
    await other.invoke('seed-judge', 'seed.platform', { platform: 'browser' }, 'nucleus-shadow')
    expect(await other.journal()).toEqual(read)
    // The summary is the settled count and root; the next call moves the root.
    expect(host.journalSummary()).toEqual({ calls: 2, rootSha256: read.rootSha256 })
    await host.invoke('nostr-core', 'nostr.ping')
    const moved = await host.journal()
    expect(moved.rootSha256).not.toBe(read.rootSha256)
    expect(moved.lines[0]).toMatchObject({ n: 3, caller: 'other', inputSha256: requestSha('nostr.ping', {}, 2) })
  })

  it.each(['nucleus-shadow', 'x6_cell'] as const)('organs cannot label calls as %s; answers stay byte-identical', async (caller) => {
    const host = testHost(), direct = testHost()
    const organ = organCellHost(host)
    const answer = await organ.invoke('nostr-core', 'nostr.ping', {}, caller)
    expect(answer).toMatchObject({ ok: true })
    expect(JSON.stringify(answer)).toBe(JSON.stringify(await direct.invoke('nostr-core', 'nostr.ping', {}, caller)))
    const validWat = `(module
      (memory (export "memory") 1 2)
      (func (export "mv_abi_version") (result i32) i32.const 1)
      (func (export "mv_alloc") (param i32) (result i32) i32.const 4096)
      (data (i32.const 1024) "{\\22abi\\22:1,\\22result\\22:{\\22answer\\22:42},\\22seq\\22:1,\\22status\\22:\\22ok\\22}")
      (func (export "mv_run") (param i32 i32) (result i64) i64.const 231928235008))`
    const spec = { wat: validWat, name: 'answer', fuel: 50_000 }
    const compiled = await organ.compileAndRun(spec, caller)
    expect(compiled).toMatchObject({ ok: true, result: { answer: 42 } })
    expect(JSON.stringify(compiled)).toBe(JSON.stringify(await direct.compileAndRun(spec, caller)))
    const read = await host.journal(), plain = await direct.journal()
    expect(read.lines.map(line => [line.cell, line.op, line.caller])).toEqual([
      ['skillsmith', 'meter', 'other'], ['skillsmith', 'build', 'other'], ['nostr-core', 'nostr.ping', 'other'],
    ])
    expect(plain.lines.every(line => line.caller === caller)).toBe(true)
    expect(read.lines).toEqual(plain.lines.map(line => ({ ...line, caller: 'other' })))
    expect(organ.list()).toEqual(host.list())
    expect(organ.cellRows()).toEqual(host.cellRows())
    expect(await organ.journal()).toEqual(read)
    expect(organ.journalSummary()).toEqual(host.journalSummary())
  })

  it('a journal that throws or cannot hash changes no answer, byte for byte', async () => {
    const throwing: CellJournal = { record() { throw new Error('journal down') }, read: () => Promise.reject(new Error('x')), summary: () => { throw new Error('x') } }
    const unhashable = createCellJournal({ canonical: cellCanonicalJson, sha256: () => Promise.reject(new Error('no digest')) })
    const tampered = new Uint8Array(await readFile(new URL('seed-judge.wasm', CELLS)))
    tampered[100] = tampered[100]! ^ 1
    const script = async (host: CellHost): Promise<string[]> => {
      const out: unknown[] = []
      out.push(await host.invoke('nostr-core', 'nostr.ping'))
      out.push(await host.invoke('nostr-core', 'nostr.key_valid', { secret_key: 'zz' }))
      out.push(await host.invoke('seed-judge', 'seed.platform', { platform: 'browser' }))
      out.push(await host.invoke('no-such-cell', 'x.run'))
      out.push(await host.invoke('nostr-core', 'NOT AN OP'))
      out.push(await host.invoke('nostr-core', 'nostr.ping', { big: 1.5 }))
      out.push(await host.invoke('nostr-core', 'ping'))
      return out.map(answer => JSON.stringify(answer))
    }
    const fetchImpl = served({ 'seed-judge': tampered })
    const plain = await script(testHost({ fetchImpl }))
    expect(await script(testHost({ fetchImpl, journal: throwing }))).toEqual(plain)
    const lossy = testHost({ fetchImpl, journal: unhashable })
    expect(await script(lossy)).toEqual(plain)
    expect((await lossy.journal()).totals).toMatchObject({ calls: 0 })
  })
})

describe('x6_self_state shows the cells and the journal summary', () => {
  const rows = (): CellRow[] => [
    { cell: 'seed-judge', sha256: 'b'.repeat(64), bytes: 20, fuel: 5, ops: ['seed.platform'], loaded: 'not-loaded' },
    { cell: 'nostr-core', sha256: 'a'.repeat(64), bytes: 10, fuel: 7, ops: ['nostr.ping', 'nostr.npub_encode'], loaded: 'verified' },
    { cell: 'gate-judge', sha256: 'c'.repeat(64), bytes: null, fuel: 9, ops: ['gate.step'], loaded: 'failed', failure: 'fetch-failed' },
  ]
  const registry = (extra: Partial<SelfStateRegistry> = {}): SelfStateRegistry => ({
    sourceRevision: null, bootedAtMs: 1, head: null, organs: [], staged: [], tools: [], cloudflareDoor: { registered: false, status: null },
    cells: rows(), cellJournal: { calls: 2, rootSha256: 'd'.repeat(64) }, ...extra,
  })
  const project = (extra: Partial<SelfStateRegistry> = {}, organs: SelfStateRegistry['organs'] = []) => projectSelfState({
    registry: registry({ organs, ...extra }), store: Object.fromEntries(organs.map(organ => [organ.id, organ.loaded?.sha256 ?? null])),
    edge: { sourceRevision: null, reason: 'unreachable' }, organFilter: null })

  it('gives sorted rows with fixed keys, a count, the journal summary, and one unknown row per null', () => {
    const answer = project()
    expect(Object.keys(answer)).toEqual(['schema', 'runtime', 'edge', 'head', 'organs', 'staged', 'tools', 'doors', 'cellCount', 'cells', 'cellJournal', 'unknown'])
    expect(JSON.stringify(answer.cells)).toBe(JSON.stringify([
      { cell: 'gate-judge', sha256: 'c'.repeat(64), bytes: null, fuel: 9, ops: ['gate.step'], loaded: 'failed', failure: 'fetch-failed' },
      { cell: 'nostr-core', sha256: 'a'.repeat(64), bytes: 10, fuel: 7, ops: ['nostr.ping', 'nostr.npub_encode'], loaded: 'verified' },
      { cell: 'seed-judge', sha256: 'b'.repeat(64), bytes: 20, fuel: 5, ops: ['seed.platform'], loaded: 'not-loaded' },
    ]))
    expect(answer.cellCount).toBe(3)
    expect(answer.cellJournal).toEqual({ calls: 2, rootSha256: 'd'.repeat(64) })
    expect(answer.unknown).toContainEqual({ field: 'cells[gate-judge].bytes', reason: 'not-recorded' })
    expect(answer.unknown).not.toContainEqual(expect.objectContaining({ field: 'cells' }))
  })

  it('a host that cannot answer, or rows of the wrong shape, are null with read-failed; a verified row cannot carry a failure', () => {
    const failed = project({ ...cellFactsOf(() => { throw new Error('no host') }) })
    expect([failed.cellCount, failed.cells, failed.cellJournal]).toEqual([null, null, null])
    expect(failed.unknown).toEqual(expect.arrayContaining([{ field: 'cellCount', reason: 'read-failed' }, { field: 'cells', reason: 'read-failed' },
      { field: 'cellJournal', reason: 'read-failed' }]))
    const lying = project({ cells: [{ ...rows()[1]!, failure: 'pin-mismatch' }] })
    expect(lying.cells).toBeNull()
    const unclosed = project({ cells: [{ ...rows()[2]!, failure: 'because' as never }] })
    expect(unclosed.cells).toBeNull()
    expect(project({ cellJournal: { calls: 1, rootSha256: 'not a digest' } }).cellJournal).toBeNull()
    // A registry without cell facts (an older loader) shows no cell keys at all.
    const bare: SelfStateRegistry = { sourceRevision: null, bootedAtMs: 1, head: null, organs: [], staged: [], tools: [],
      cloudflareDoor: { registered: false, status: null } }
    const none = projectSelfState({ registry: bare, store: {}, edge: { sourceRevision: null, reason: 'unreachable' }, organFilter: null })
    expect(Object.keys(none)).not.toContain('cells')
    expect(Object.keys(none)).not.toContain('cellJournal')
  })

  it('cuts cell rows before any organ row (cellCount and cellJournal stay whole), and fits 16 KiB', () => {
    const organ = (n: number) => ({ id: `organ-${String(n).padStart(3, '0')}`, specifier: `ball:${sha(`o${String(n)}`)}`,
      loaded: { sha256: sha(`o${String(n)}`), bytes: 1000 + n }, state: 'running' })
    const many: CellRow[] = Array.from({ length: 27 }, (_v, n) => ({ cell: `cell-${String(n).padStart(2, '0')}`, sha256: sha(`c${String(n)}`),
      bytes: 100_000, fuel: 300_000_000, ops: Array.from({ length: 12 }, (_w, i) => `cell.operation_${String(i)}`), loaded: 'not-loaded' }))
    const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength
    // Find the most organs that fit beside all the cell rows, then add a few: the cells give way, the organs do not.
    let fitting = 0
    while (bytes(project({ cells: many }, Array.from({ length: fitting + 1 }, (_v, n) => organ(n)))) <= SELF_STATE_RESULT_BYTES
      && !(project({ cells: many }, Array.from({ length: fitting + 1 }, (_v, n) => organ(n))).unknown as J[]).some(row => row.field === 'cells')) fitting += 1
    const organs = Array.from({ length: fitting + 4 }, (_v, n) => organ(n))
    const answer = project({ cells: many }, organs)
    expect(bytes(answer)).toBeLessThanOrEqual(SELF_STATE_RESULT_BYTES)
    expect((answer.organs as J[]).length).toBe(organs.length)
    expect((answer.cells as J[]).length).toBeLessThan(27)
    expect((answer.cells as J[]).map(row => row.cell)).toEqual(many.map(row => row.cell).slice(0, (answer.cells as J[]).length))
    expect(answer.cellCount).toBe(27)
    expect(answer.cellJournal).toEqual({ calls: 2, rootSha256: 'd'.repeat(64) })
    expect(answer.unknown).toContainEqual({ field: 'cells', reason: 'too-many' })
    expect(answer.unknown).not.toContainEqual({ field: 'organs', reason: 'too-many' })
  })
})

describe('on her mounted runtime', () => {
  it('x6_cell list keeps every load state, including a refused load and the cells not yet loaded', async () => {
    const host = testHost({ fetchImpl: served({ 'seed-judge': 404 }) })
    vi.spyOn(wasmCells, 'workerCellHost').mockReturnValue(host)
    const m = await mountE4()
    const cell = m.tool('x6_cell')
    expect(await cell.execute({ action: 'compute', cell: 'nostr-core', op: 'nostr.ping' })).toMatchObject({ ok: true })
    expect(await cell.execute({ action: 'compute', cell: 'seed-judge', op: 'seed.platform' }))
      .toMatchObject({ ok: false, code: 'MODULE_UNAVAILABLE (HTTP 404)' })
    const listed = await cell.execute({ action: 'list' }) as { ok: boolean; cells: ReturnType<CellHost['list']> }
    expect(listed.ok).toBe(true)
    expect(listed.cells).toHaveLength(30)
    expect(listed.cells.map(row => row.cell).sort()).toEqual(Object.keys(CELL_PINS).sort())
    expect([...listed.cells].sort((a, b) => a.cell < b.cell ? -1 : a.cell > b.cell ? 1 : 0)).toEqual(host.cellRows())
    for (const row of listed.cells) {
      if (row.cell === 'nostr-core') {
        expect(row.loaded).toBe('verified')
        expect(row).not.toHaveProperty('failure')
      } else if (row.cell === 'seed-judge') {
        expect(row).toMatchObject({ loaded: 'failed', failure: 'fetch-failed' })
      } else {
        expect(row.loaded).toBe('not-loaded')
        expect(row).not.toHaveProperty('failure')
      }
    }
  })

  it('x6_cell journal after two calls, and x6_self_state rows for one verified and one not-loaded cell', async () => {
    const host = testHost()
    vi.spyOn(wasmCells, 'workerCellHost').mockReturnValue(host)
    const m = await mountE4({ respond: call => call.method === 'GET' && call.path === '/api/build'
      ? Response.json({ ok: true, schema: 'aukora.edge-build.v1', sourceRevision: null }) : null })
    const cell = m.tool('x6_cell')
    const before = m.calls.length
    expect(await cell.execute({ action: 'compute', cell: 'nostr-core', op: 'nostr.ping' })).toMatchObject({ ok: true })
    expect(await cell.execute({ action: 'compute', cell: 'seed-judge', op: 'seed.platform', input: { platform: 'browser' } })).toMatchObject({ ok: true })
    const read = await cell.execute({ action: 'journal' }) as CellJournalRead
    // Reading the journal sends nothing anywhere.
    expect(m.calls.slice(before)).toEqual([])
    expect(read.totals).toEqual({ byCell: { 'nostr-core': 1, 'seed-judge': 1 }, byStatus: { ok: 2, refused: 0, trap: 0, fuel: 0, timeout: 0 }, calls: 2, lost: 0 })
    expect(read.lines.map(line => [line.n, line.cell, line.op, line.status, line.caller])).toEqual([
      [2, 'seed-judge', 'seed.platform', 'ok', 'x6_cell'], [1, 'nostr-core', 'nostr.ping', 'ok', 'x6_cell']])
    expect(read.rootSha256).toBe(rootOver([...read.lines].reverse()))

    const state = await m.tool('x6_self_state').execute({}) as J
    // Her kept forged cells follow the journal summary (forged-cells.spec.ts).
    expect(Object.keys(state).slice(-6)).toEqual(['cellCount', 'cells', 'cellJournal', 'forgedCells', 'skills', 'unknown'])
    expect(state.forgedCells).toEqual({ count: 0, cells: [] })
    expect(state.cellCount).toBe(30)
    expect(state.cellJournal).toEqual({ calls: 2, rootSha256: read.rootSha256 })
    const byName: Record<string, J> = Object.fromEntries((state.cells as J[]).map(row => [String(row.cell), row]))
    const nostr = CELL_PINS['nostr-core']!, focus = CELL_PINS['aura-focus']!
    expect(byName['nostr-core']).toEqual({ cell: 'nostr-core', sha256: nostr.sha256, bytes: nostr.bytes, fuel: Math.min(nostr.fuel, CELL_BROWSER_FUEL_CAP),
      ops: [...nostr.ops!], loaded: 'verified' })
    expect(byName['aura-focus']).toEqual({ cell: 'aura-focus', sha256: focus.sha256, bytes: focus.bytes, fuel: focus.fuel, ops: [...focus.ops!],
      loaded: 'not-loaded' })
    expect(new TextEncoder().encode(JSON.stringify(state)).byteLength).toBeLessThanOrEqual(SELF_STATE_RESULT_BYTES)
  }, 60_000)

  it('journal is a read wherever x6_cell actions are classified', async () => {
    expect(classifyActionIrreversibility({ tool: 'x6_cell', action: 'journal' })).toBe(0)
    expect(classifyToolMutation('x6_cell', [{ name: 'action', type: 'string', required: true, enum: ['list', 'journal'] }]))
      .toEqual({ readOnly: true, mutating: false, actions: { read: ['journal', 'list'], write: [] } })
    // x6_cell as a whole stays mutating (compute, compile_and_run): the new read changes nothing there.
    expect(classifyToolMutation('x6_cell', [{ name: 'action', type: 'string', required: true,
      enum: ['list', 'compute', 'run', 'compile_and_run', 'journal'] }]))
      .toEqual({ readOnly: false, mutating: true,
        actions: { read: ['journal', 'list'], write: ['compile_and_run', 'compute', 'run'] } })
    expect(voiceVerdict({ tool: 'x6_cell', args: { action: 'journal' }, origin: { kind: 'builtin' } })).toBeUndefined()
    expect(voiceVerdict({ tool: 'x6_cell', args: { action: 'compute', cell: 'nostr-core', op: 'nostr.ping' }, origin: { kind: 'builtin' } })).toContain('VOICE_LOOK_ONLY')
  })
})
