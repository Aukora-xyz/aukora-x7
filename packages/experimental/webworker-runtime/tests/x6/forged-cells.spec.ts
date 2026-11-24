/**
 * A cell she forges herself survives.
 *  - `forge` compiles and admits through the SAME skillsmith path and admitCell as compile_and_run, and keeps the
 *    admitted bytes, her WAT and a canonical manifest in her home, content-addressed;
 *  - `run_forged` re-reads and re-hashes the bytes BEFORE compiling, admits them again, runs them, journals one line;
 *  - it survives a new runtime mounted over the same file layer (the reload case);
 *  - every cap and closed code; `forged`, `forget`; `x6_self_state` `forgedCells` and its cut order; the write-set
 *    inventory lists the new writer; look-only voice refuses forge and forget; organs never reach forge or runForged.
 * The source is the truth. `run_forged` builds the kept WAT again through the pinned compiler and runs only
 * those fresh bytes, and only when they hash to the kept address; hand-built bytes with fake fuel exports never run.
 * Local only: real pinned cell bytes from apps/web/public/cells, Node worker_threads, the e4 fixture's `.invalid` origin.
 */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { Worker } from 'node:worker_threads'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryVfs } from '../../src/storage/memory.ts'
import { classifyActionIrreversibility, FORGED_CELL_SCHEMA, FORGED_CELLS_DIR, FORGED_CELLS_MAX } from '../../src/x6/ball-loader.ts'
import { classifyToolMutation } from '../../src/x6/capability-index.ts'
import type { CellJournalRead } from '../../src/x6/cell-journal.ts'
import { projectSelfState, SELF_STATE_RESULT_BYTES, type SelfStateRegistry } from '../../src/x6/self-state.ts'
import { voiceVerdict } from '../../src/x6/voice-read-only.ts'
import * as wasmCells from '../../src/x6/wasm-cells.ts'
import {
  admitCell, CELL_PINS, cellCanonicalJson, createCellHost, FORGED_CELL_MAX_WASM_BYTES, FORGED_CELL_MAX_WAT_BYTES, organCellHost,
  SKILL_DEFAULT_FUEL, type CellHost, type CellWorker,
} from '../../src/x6/wasm-cells.ts'
import { classifyWritePath, liveWriteSet, RUNTIME_WRITE_SET } from '../../src/x6/write-set-inventory.ts'
import { FakeSocket, mountE4 } from './e4-fixture.ts'

type J = Record<string, unknown>
const CELLS = new URL('../../../../../apps/web/public/cells/', import.meta.url)
const ORIGIN = 'https://lane-e4-fixture.invalid'
const sha = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex')

const served = (): typeof fetch => async (input: RequestInfo | URL) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
  if (url.origin !== ORIGIN || !url.pathname.startsWith('/cells/')) return new Response('no', { status: 404 })
  const name = url.pathname.replace(/^\/cells\//, '').replace(/\.wasm$/, '')
  return new Response(Uint8Array.from(await readFile(new URL(`${name}.wasm`, CELLS))), { headers: { 'content-type': 'application/wasm' } })
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
const testHost = (): CellHost => {
  const host = createCellHost({ origin: ORIGIN, fetchImpl: served(), createWorker: nodeCellWorker, now: () => 0 })
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

/**
 * The worked example for her (docs and handoff): one op that adds two integers. Input `{ a, b }`; answer `{ sum }`.
 * It finds `"a":` and `"b":` in the canonical request, reads each integer, and writes `{"abi":1,"result":{"sum":N},"status":"ok"}`.
 */
const ADDER_WAT = `(module
  (memory (export "memory") 1 2)
  (data (i32.const 2048) "{\\22abi\\22:1,\\22result\\22:{\\22sum\\22:")
  (data (i32.const 1100) "},\\22status\\22:\\22ok\\22}")
  (data (i32.const 1200) "{\\22abi\\22:1,\\22code\\22:\\22INPUT\\22,\\22status\\22:\\22refused\\22}")
  (func (export "mv_abi_version") (result i32) i32.const 1)
  (func (export "mv_alloc") (param i32) (result i32) i32.const 4096)
  (func $find (param $p i32) (param $len i32) (param $key i32) (result i32)
    (local $i i32) (local $end i32)
    (local.set $i (local.get $p))
    (local.set $end (i32.sub (i32.add (local.get $p) (local.get $len)) (i32.const 4)))
    (block $done (loop $scan
      (br_if $done (i32.gt_s (local.get $i) (local.get $end)))
      (if (i32.and
            (i32.and (i32.eq (i32.load8_u (local.get $i)) (i32.const 34)) (i32.eq (i32.load8_u offset=1 (local.get $i)) (local.get $key)))
            (i32.and (i32.eq (i32.load8_u offset=2 (local.get $i)) (i32.const 34)) (i32.eq (i32.load8_u offset=3 (local.get $i)) (i32.const 58))))
        (then (return (i32.add (local.get $i) (i32.const 4)))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    (i32.const -1))
  (func $int (param $i i32) (result i64)
    (local $neg i32) (local $v i64) (local $c i32)
    (if (i32.eq (i32.load8_u (local.get $i)) (i32.const 45))
      (then (local.set $neg (i32.const 1)) (local.set $i (i32.add (local.get $i) (i32.const 1)))))
    (block $done (loop $digits
      (local.set $c (i32.sub (i32.load8_u (local.get $i)) (i32.const 48)))
      (br_if $done (i32.gt_u (local.get $c) (i32.const 9)))
      (local.set $v (i64.add (i64.mul (local.get $v) (i64.const 10)) (i64.extend_i32_u (local.get $c))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $digits)))
    (if (result i64) (local.get $neg) (then (i64.sub (i64.const 0) (local.get $v))) (else (local.get $v))))
  (func $copy (param $dst i32) (param $src i32) (param $n i32)
    (block $done (loop $l
      (br_if $done (i32.eqz (local.get $n)))
      (i32.store8 (local.get $dst) (i32.load8_u (local.get $src)))
      (local.set $dst (i32.add (local.get $dst) (i32.const 1)))
      (local.set $src (i32.add (local.get $src) (i32.const 1)))
      (local.set $n (i32.sub (local.get $n) (i32.const 1)))
      (br $l))))
  (func (export "mv_run") (param $p i32) (param $len i32) (result i64)
    (local $a i32) (local $b i32) (local $u i64) (local $neg i32) (local $q i32) (local $out i32)
    (local.set $a (call $find (local.get $p) (local.get $len) (i32.const 97)))
    (local.set $b (call $find (local.get $p) (local.get $len) (i32.const 98)))
    (if (i32.or (i32.lt_s (local.get $a) (i32.const 0)) (i32.lt_s (local.get $b) (i32.const 0)))
      (then (return (i64.or (i64.shl (i64.const 43) (i64.const 32)) (i64.const 1200)))))
    (local.set $u (i64.add (call $int (local.get $a)) (call $int (local.get $b))))
    (if (i64.lt_s (local.get $u) (i64.const 0))
      (then (local.set $neg (i32.const 1)) (local.set $u (i64.sub (i64.const 0) (local.get $u)))))
    (local.set $q (i32.const 3072))
    (loop $d
      (local.set $q (i32.sub (local.get $q) (i32.const 1)))
      (i32.store8 (local.get $q) (i32.add (i32.const 48) (i32.wrap_i64 (i64.rem_u (local.get $u) (i64.const 10)))))
      (local.set $u (i64.div_u (local.get $u) (i64.const 10)))
      (br_if $d (i64.ne (local.get $u) (i64.const 0))))
    (if (local.get $neg) (then (local.set $q (i32.sub (local.get $q) (i32.const 1))) (i32.store8 (local.get $q) (i32.const 45))))
    (local.set $out (i32.const 2073))
    (call $copy (local.get $out) (local.get $q) (i32.sub (i32.const 3072) (local.get $q)))
    (local.set $out (i32.add (local.get $out) (i32.sub (i32.const 3072) (local.get $q))))
    (call $copy (local.get $out) (i32.const 1100) (i32.const 16))
    (local.set $out (i32.add (local.get $out) (i32.const 16)))
    (i64.or (i64.shl (i64.extend_i32_u (i32.sub (local.get $out) (i32.const 2048))) (i64.const 32)) (i64.const 2048))))`

/** A second, different cell (a constant answer) for name and replace cases. */
const constantWat = (answer: number): string => {
  const payload = `{"abi":1,"result":{"answer":${String(answer)}},"status":"ok"}`
  const packed = (BigInt(payload.length) << 32n) | 1024n
  return `(module
  (memory (export "memory") 1 2)
  (func (export "mv_abi_version") (result i32) i32.const 1)
  (func (export "mv_alloc") (param i32) (result i32) i32.const 4096)
  (data (i32.const 1024) "${payload.replace(/"/gu, '\\22')}")
  (func (export "mv_run") (param i32 i32) (result i64) i64.const ${String(packed)}))`
}

/** Mount her runtime over `vfs` with `host` as this worker's cell host. */
async function mount(host: CellHost, vfs = new MemoryVfs()) {
  vi.spyOn(wasmCells, 'workerCellHost').mockReturnValue(host)
  const m = await mountE4({ vfs, respond: call => call.method === 'GET' && call.path === '/api/build'
    ? Response.json({ ok: true, schema: 'aukora.edge-build.v1', sourceRevision: null }) : null })
  return { m, vfs, cell: m.tool('x6_cell') }
}
const filesUnder = (vfs: MemoryVfs): string[] =>
  vfs.existsSync(FORGED_CELLS_DIR) ? [...vfs.readdirSync(FORGED_CELLS_DIR)].map(String).sort() : []

describe('forge keeps a cell, run_forged runs it again, and it survives a reload', () => {
  it('the documented adder is the WAT this suite runs', async () => {
    const example = new URL('../../../../../docs/auma/cells/adder.wat', import.meta.url)
    expect(await readFile(example, 'utf8')).toBe(`${ADDER_WAT}\n`)
  })

  it('forge then run_forged gives the answer compile_and_run gives, from the same metered bytes', async () => {
    const direct = testHost()
    const compiled = await direct.compileAndRun({ wat: ADDER_WAT, name: 'adder', op: 'add', input: { a: 2, b: 3 } })
    expect(compiled).toMatchObject({ ok: true, cell: 'adder', op: 'add', result: { sum: 5 } })
    const negative = await direct.compileAndRun({ wat: ADDER_WAT, name: 'adder', op: 'add', input: { a: -40, b: 2 } })
    expect(negative).toMatchObject({ ok: true, result: { sum: -38 } })

    const { m, vfs, cell } = await mount(testHost())
    const forged = await cell.execute({ action: 'forge', wat: ADDER_WAT, name: 'adder' }) as J
    expect(forged.ok).toBe(true)
    expect(forged.kept).toBe('new')
    const manifest = forged.cell as J
    expect(Object.keys(manifest)).toEqual(['schema', 'name', 'sha256', 'bytes', 'watSha256', 'memoryPages', 'forgedAt', 'skillsmith'])
    expect(manifest).toMatchObject({ schema: FORGED_CELL_SCHEMA, name: 'adder', sha256: compiled.meteredSha256, watSha256: sha(ADDER_WAT),
      memoryPages: 2, skillsmith: CELL_PINS.skillsmith!.sha256 })
    // The three files, content-addressed; the bytes hash to the name; the manifest is the cell ABI's canonical JSON.
    const id = manifest.sha256 as string
    expect(filesUnder(vfs)).toEqual([`${id}.json`, `${id}.wasm`, `${id}.wat`])
    const bytes = vfs.readFileSync(`${FORGED_CELLS_DIR}/${id}.wasm`) as Uint8Array
    expect(bytes).toBeInstanceOf(Uint8Array)
    expect(sha(bytes)).toBe(id)
    expect(bytes.byteLength).toBe(manifest.bytes)
    expect(vfs.readFileSync(`${FORGED_CELLS_DIR}/${id}.json`, 'utf8')).toBe(cellCanonicalJson(manifest))
    expect(vfs.readFileSync(`${FORGED_CELLS_DIR}/${id}.wat`, 'utf8')).toBe(ADDER_WAT)

    const run = await cell.execute({ action: 'run_forged', cell: 'adder', op: 'add', input: { a: 2, b: 3 } }) as J
    // Built again from the kept WAT, the same answer and the same fuel as compile_and_run.
    expect(run).toEqual({ ok: true, cell: 'adder', op: 'add', result: { sum: 5 }, fuelUsed: compiled.fuelUsed, sha256: id })
    expect(await cell.execute({ action: 'run_forged', cell: id, op: 'add', input: { a: -40, b: 2 } })).toMatchObject({ ok: true, result: { sum: -38 } })
    expect(await cell.execute({ action: 'run_forged', cell: 'adder', op: 'add', input: { a: 1 } })).toMatchObject({ ok: false, code: 'INPUT' })
    // Nothing left her origin for any of it.
    expect(m.calls.filter(call => !call.path.startsWith('/_head/') && call.path !== '/api/build')).toEqual([])
  }, 60_000)

  it('survives a new runtime mounted over the same file layer (the reload), with a new cell host', async () => {
    const first = await mount(testHost())
    const forged = await first.cell.execute({ action: 'forge', wat: ADDER_WAT, name: 'adder' }) as J
    const before = await first.cell.execute({ action: 'run_forged', cell: 'adder', op: 'add', input: { a: 20, b: 22 } }) as J
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    const second = await mount(testHost(), first.vfs)
    const listed = await second.cell.execute({ action: 'forged' }) as J
    expect(listed).toEqual({ ok: true, count: 1, cells: [{ ...(forged.cell as J), source: 'kept' }] })
    const after = await second.cell.execute({ action: 'run_forged', cell: 'adder', op: 'add', input: { a: 20, b: 22 } }) as J
    expect(after).toEqual(before)
    expect(after).toMatchObject({ ok: true, result: { sum: 42 } })
  }, 60_000)

  it('bytes changed on disk are refused before they compile, and so are missing bytes; a consistent swap to a module with an import is refused by admission', async () => {
    const host = testHost()
    const { vfs, cell } = await mount(host)
    const forged = await cell.execute({ action: 'forge', wat: ADDER_WAT, name: 'adder' }) as J
    const id = (forged.cell as J).sha256 as string
    const wasmPath = `${FORGED_CELLS_DIR}/${id}.wasm`
    const kept = Uint8Array.from(vfs.readFileSync(wasmPath) as Uint8Array)
    const flipped = Uint8Array.from(kept)
    flipped[kept.byteLength - 3] = flipped[kept.byteLength - 3]! ^ 1
    vfs.writeFileSync(wasmPath, flipped)
    const compileSpy = vi.spyOn(WebAssembly, 'compile')
    expect(await cell.execute({ action: 'run_forged', cell: 'adder', op: 'add', input: { a: 1, b: 1 } }))
      .toEqual({ ok: false, cell: 'adder', op: 'add', code: 'FORGED_BYTES_CHANGED', fuelUsed: null, sha256: id })
    expect(compileSpy).not.toHaveBeenCalled()
    vfs.unlinkSync(wasmPath)
    expect(await cell.execute({ action: 'run_forged', cell: 'adder', op: 'add', input: { a: 1, b: 1 } })).toMatchObject({ ok: false, code: 'FORGED_BYTES_CHANGED' })
    vfs.writeFileSync(wasmPath, 'not bytes')
    expect(await cell.execute({ action: 'run_forged', cell: 'adder', op: 'add', input: { a: 1, b: 1 } })).toMatchObject({ ok: false, code: 'FORGED_BYTES_CHANGED' })
    expect(compileSpy).not.toHaveBeenCalled()
    vfs.writeFileSync(wasmPath, kept)
    expect(await cell.execute({ action: 'run_forged', cell: 'adder', op: 'add', input: { a: 1, b: 1 } })).toMatchObject({ ok: true, result: { sum: 2 } })

    // Someone rewrites BOTH the bytes and the manifest: a module with one import, under its own hash. forge: there is
    // no kept WAT under that address, so it is refused before anything is built or admitted.
    const withImport = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x04, 0x01, 0x60, 0x00, 0x00,
      0x02, 0x07, 0x01, 0x01, 0x6d, 0x01, 0x66, 0x00, 0x00, 0x05, 0x04, 0x01, 0x01, 0x01, 0x01])
    const swapped = sha(withImport)
    const manifest = { ...(forged.cell as J), sha256: swapped, bytes: withImport.byteLength }
    vfs.writeFileSync(`${FORGED_CELLS_DIR}/${swapped}.wasm`, withImport)
    vfs.writeFileSync(`${FORGED_CELLS_DIR}/${swapped}.json`, cellCanonicalJson(manifest))
    vfs.unlinkSync(`${FORGED_CELLS_DIR}/${id}.json`)
    expect(await cell.execute({ action: 'run_forged', cell: 'adder', op: 'add', input: { a: 1, b: 1 } }))
      .toEqual({ ok: false, cell: 'adder', op: 'add', code: 'FORGED_SOURCE_CHANGED', fuelUsed: null, sha256: swapped })
    expect(compileSpy.mock.calls.some(([source]) => source instanceof Uint8Array && sha(source) === swapped)).toBe(false)
    // Every one of those runs is a journal line under forged:adder, refused or not.
    const read = await cell.execute({ action: 'journal' }) as CellJournalRead
    expect(read.lines.filter(line => line.cell === 'forged:adder').map(line => [line.status, line.pin])).toEqual([
      ['refused', swapped], ['ok', id], ['refused', id], ['refused', id], ['refused', id]])
  }, 60_000)

  it('a WAT that declares an import is refused at forge and nothing is kept', async () => {
    const { vfs, cell } = await mount(testHost())
    const importing = ADDER_WAT.replace('(memory (export "memory") 1 2)', '(import "env" "now" (func $now (result i64)))\n  (memory (export "memory") 1 2)')
    const answer = await cell.execute({ action: 'forge', wat: importing, name: 'clock' }) as J
    expect(answer.ok).toBe(false)
    expect(String(answer.code)).toMatch(/IMPORT/u)
    expect(filesUnder(vfs)).toEqual([])
  }, 60_000)
})

describe('caps, names, already, replace, forget', () => {
  it('names: the pattern and never a pinned name; refused before any compile', async () => {
    const host = testHost()
    const { cell } = await mount(host)
    for (const name of ['', 'Adder', '9lives', 'a'.repeat(33), 'with space', undefined]) {
      expect(await cell.execute({ action: 'forge', wat: ADDER_WAT, name })).toMatchObject({ ok: false, code: 'FORGE_NAME_INVALID' })
    }
    for (const name of ['nucleus', 'skillsmith', 'kyber-cpu']) {
      expect(await cell.execute({ action: 'forge', wat: ADDER_WAT, name })).toMatchObject({ ok: false, code: 'FORGE_NAME_PINNED' })
    }
    expect(await cell.execute({ action: 'forge', wat: `${ADDER_WAT};;${'x'.repeat(FORGED_CELL_MAX_WAT_BYTES)}`, name: 'big' }))
      .toMatchObject({ ok: false, code: 'FORGE_WAT_LIMIT' })
    expect(await cell.execute({ action: 'forge', wat: ADDER_WAT.replace('1 2)', '1 17)'), name: 'wide' }))
      .toMatchObject({ ok: false, code: 'SKILL_MEMORY_LIMIT' })
    expect((await host.journal()).totals.calls).toBe(0)
  })

  it('Wasm over 64 KiB is FORGE_WASM_LIMIT; at 128 kept (was 32) a new one is FORGE_FULL; same bytes are kept already', async () => {
    expect(FORGED_CELLS_MAX).toBe(128)
    const { vfs, cell } = await mount(testHost())
    const blob = 'a'.repeat(FORGED_CELL_MAX_WASM_BYTES + 512)
    const heavy = constantWat(1).replace('(memory (export "memory") 1 2)', `(memory (export "memory") 2 2)\n  (data (i32.const 8192) "${blob}")`)
    expect(await cell.execute({ action: 'forge', wat: heavy, name: 'heavy' })).toMatchObject({ ok: false, code: 'FORGE_WASM_LIMIT' })
    expect(filesUnder(vfs)).toEqual([])

    const first = await cell.execute({ action: 'forge', wat: constantWat(1), name: 'one' }) as J
    expect(first).toMatchObject({ ok: true, kept: 'new' })
    expect(await cell.execute({ action: 'forge', wat: constantWat(1), name: 'one' })).toEqual({ ok: true, kept: 'already', cell: first.cell })
    // Fill the other 31 slots (a slot is any kept entry, even one whose manifest cannot be read).
    for (let i = 1; i < FORGED_CELLS_MAX; i += 1) vfs.writeFileSync(`${FORGED_CELLS_DIR}/${sha(`slot-${String(i)}`)}.wasm`, new Uint8Array([i]))
    expect(await cell.execute({ action: 'forge', wat: constantWat(2), name: 'two' }))
      .toMatchObject({ ok: false, code: 'FORGE_FULL', count: FORGED_CELLS_MAX, max: FORGED_CELLS_MAX })
    const listed = await cell.execute({ action: 'forged' }) as J
    expect(listed.count).toBe(1)
    expect((listed.unreadable as string[]).length).toBe(FORGED_CELLS_MAX - 1)
    // Forget one unreadable entry by its SHA-256, and there is room again.
    const stray = (listed.unreadable as string[])[0]!
    expect(await cell.execute({ action: 'forget', cell: stray })).toEqual({ ok: true, forgot: { name: null, sha256: stray } })
    expect(await cell.execute({ action: 'forge', wat: constantWat(2), name: 'two' })).toMatchObject({ ok: true, kept: 'new' })
  }, 60_000)

  it('a name already used is FORGE_NAME_TAKEN unless replace; forget removes the three files', async () => {
    const { vfs, cell } = await mount(testHost())
    const one = await cell.execute({ action: 'forge', wat: constantWat(1), name: 'answer' }) as J
    const oldSha = (one.cell as J).sha256 as string
    expect(await cell.execute({ action: 'forge', wat: constantWat(2), name: 'answer' }))
      .toMatchObject({ ok: false, code: 'FORGE_NAME_TAKEN', name: 'answer', sha256: oldSha })
    const replaced = await cell.execute({ action: 'forge', wat: constantWat(2), name: 'answer', replace: true }) as J
    expect(replaced).toMatchObject({ ok: true, kept: 'replaced', replaced: oldSha })
    const newSha = (replaced.cell as J).sha256 as string
    expect(filesUnder(vfs)).toEqual([`${newSha}.json`, `${newSha}.wasm`, `${newSha}.wat`])
    expect(await cell.execute({ action: 'run_forged', cell: 'answer' })).toMatchObject({ ok: true, op: 'run', result: { answer: 2 } })
    expect(await cell.execute({ action: 'run_forged', cell: oldSha })).toMatchObject({ ok: false, code: 'FORGED_UNKNOWN' })
    expect(await cell.execute({ action: 'run_forged', cell: 'answer', fuel: 0 })).toMatchObject({ ok: false, code: 'SKILL_FUEL_LIMIT' })
    expect(await cell.execute({ action: 'run_forged', cell: 'answer', fuel: 10_000_001 })).toMatchObject({ ok: false, code: 'SKILL_FUEL_LIMIT' })
    expect(await cell.execute({ action: 'forget', cell: 'answer' })).toEqual({ ok: true, forgot: { name: 'answer', sha256: newSha } })
    expect(filesUnder(vfs)).toEqual([])
    expect(await cell.execute({ action: 'forget', cell: 'answer' })).toMatchObject({ ok: false, code: 'FORGED_UNKNOWN' })
    expect(await cell.execute({ action: 'forged' })).toEqual({ ok: true, count: 0, cells: [] })
  }, 60_000)
})

describe('the journal, her self-state, the write set, the classifications', () => {
  it('forge journals its two skillsmith calls; run_forged one line as forged:<name>, pin its sha256, caller x6_cell, after its rebuild\'s two', async () => {
    const { cell } = await mount(testHost())
    const forged = await cell.execute({ action: 'forge', wat: ADDER_WAT, name: 'adder' }) as J
    const id = (forged.cell as J).sha256 as string
    const run = await cell.execute({ action: 'run_forged', cell: 'adder', op: 'add', input: { a: 2, b: 3 } }) as J
    const read = await cell.execute({ action: 'journal' }) as CellJournalRead
    // The run's rebuild is the compiler's own two lines, as forge's are, so the totals count it.
    expect(read.lines.map(line => [line.cell, line.op, line.status, line.caller])).toEqual([
      ['forged:adder', 'add', 'ok', 'x6_cell'], ['skillsmith', 'meter', 'ok', 'x6_cell'], ['skillsmith', 'build', 'ok', 'x6_cell'],
      ['skillsmith', 'meter', 'ok', 'x6_cell'], ['skillsmith', 'build', 'ok', 'x6_cell']])
    expect(read.lines[0]).toMatchObject({ pin: id, fuelUsed: run.fuelUsed,
      inputSha256: sha(cellCanonicalJson({ abi: 1, input: { a: 2, b: 3 }, op: 'add', seq: 1 })) })
    expect(read.totals.byCell).toEqual({ 'forged:adder': 1, skillsmith: 4 })
  }, 60_000)

  it('x6_self_state shows forgedCells after cellJournal, and every write was classified content-addressed', async () => {
    const before = liveWriteSet.snapshot().counters.flagged
    const { cell, m } = await mount(testHost())
    const one = await cell.execute({ action: 'forge', wat: constantWat(1), name: 'one' }) as J
    await new Promise(resolve => setTimeout(resolve, 2))
    const two = await cell.execute({ action: 'forge', wat: constantWat(2), name: 'two' }) as J
    const state = await m.tool('x6_self_state').execute({}) as J
    // `spend` (her model steps by route, this page life) sits between `skills` and `unknown`.
    expect(Object.keys(state).slice(-5)).toEqual(['cellJournal', 'forgedCells', 'skills', 'spend', 'unknown'])
    const row = (kept: J) => { const c = kept.cell as J; return { name: c.name, sha256: c.sha256, bytes: c.bytes } }
    expect(state.forgedCells).toEqual({ count: 2, cells: [row(two), row(one)] })
    expect(new TextEncoder().encode(JSON.stringify(state)).byteLength).toBeLessThanOrEqual(SELF_STATE_RESULT_BYTES)
    const live = liveWriteSet.snapshot()
    expect(live.counters.flagged).toBe(before)
    expect(live.recent.filter(record => record.path.startsWith(`${FORGED_CELLS_DIR}/`)).every(record => record.entryId === 'forged-cell-store'
      && record.class === 'content-addressed')).toBe(true)
  }, 60_000)

  it('cuts forged rows after the cell rows and before any organ row; the count is never cut; a bad shape is read-failed', () => {
    const many = Array.from({ length: 27 }, (_v, n) => ({ cell: `cell-${String(n).padStart(2, '0')}`, sha256: sha(`c${String(n)}`),
      bytes: 100_000, fuel: 300_000_000, ops: Array.from({ length: 12 }, (_w, i) => `cell.operation_${String(i)}`), loaded: 'not-loaded' as const }))
    const forged = Array.from({ length: 32 }, (_v, n) => ({ name: `forged-${String(n).padStart(2, '0')}`, sha256: sha(`f${String(n)}`), bytes: 600 }))
    const organ = (n: number) => ({ id: `organ-${String(n).padStart(3, '0')}`, specifier: `ball:${sha(`o${String(n)}`)}`,
      loaded: { sha256: sha(`o${String(n)}`), bytes: 1000 + n }, state: 'running' })
    const registry = (organs: number, extra: Partial<SelfStateRegistry> = {}): SelfStateRegistry => ({
      sourceRevision: null, bootedAtMs: 1, head: null, organs: Array.from({ length: organs }, (_v, n) => organ(n)), staged: [], tools: [],
      cloudflareDoor: { registered: false, status: null }, cells: many, cellJournal: { calls: 2, rootSha256: 'd'.repeat(64) },
      forgedCells: forged, ...extra })
    const project = (organs: number, extra: Partial<SelfStateRegistry> = {}) => projectSelfState({ registry: registry(organs, extra),
      store: Object.fromEntries(Array.from({ length: organs }, (_v, n) => [organ(n).id, organ(n).loaded.sha256])),
      edge: { sourceRevision: null, reason: 'unreachable' }, organFilter: null })
    const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength
    const rows = (answer: J) => ((answer.forgedCells as J).cells as J[])
    // Few organs: everything fits.
    const small = project(2)
    expect(rows(small)).toHaveLength(32)
    // More organs: cell rows give way first, forged rows stay whole.
    let n = 2
    while ((project(n).cells as J[]).length === 27) n += 1
    const cut1 = project(n)
    expect(rows(cut1)).toHaveLength(32)
    expect(cut1.unknown).toContainEqual({ field: 'cells', reason: 'too-many' })
    // Then forged rows give way (the newest stay), the organs never; the count stays.
    while (rows(project(n)).length === 32) n += 1
    const cut2 = project(n + 3)
    expect(bytes(cut2)).toBeLessThanOrEqual(SELF_STATE_RESULT_BYTES)
    expect(cut2.cells).toEqual([])
    expect(rows(cut2).length).toBeLessThan(32)
    expect(rows(cut2)).toEqual(forged.slice(0, rows(cut2).length))
    expect((cut2.forgedCells as J).count).toBe(32)
    expect((cut2.organs as J[]).length).toBe(n + 3)
    expect(cut2.unknown).toContainEqual({ field: 'forgedCells.cells', reason: 'too-many' })
    expect(cut2.unknown).not.toContainEqual({ field: 'organs', reason: 'too-many' })
    // A bad shape: null with one read-failed row; a registry without the key shows no key.
    const bad = project(1, { forgedCells: [{ name: 'Bad Name', sha256: sha('x'), bytes: 1 }] })
    expect(bad.forgedCells).toBeNull()
    expect(bad.unknown).toContainEqual({ field: 'forgedCells', reason: 'read-failed' })
    expect(project(1, { forgedCells: null }).forgedCells).toBeNull()
    const { forgedCells: _omitted, ...older } = registry(1)
    expect(_omitted).toHaveLength(32)
    const none = projectSelfState({ registry: older, store: { [organ(0).id]: organ(0).loaded.sha256 },
      edge: { sourceRevision: null, reason: 'unreachable' }, organFilter: null })
    expect(Object.keys(none)).not.toContain('forgedCells')
  })

  it('the write-set inventory lists the new writer as content-addressed', () => {
    const entry = RUNTIME_WRITE_SET.find(item => item.id === 'forged-cell-store')
    expect(entry).toMatchObject({ class: 'content-addressed', transitionKinds: [] })
    expect(entry!.writers.map(writer => writer.target)).toEqual(['forgedWasmPath', 'forgedWatPath', 'forgedManifestPath', 'forgedPath'])
    for (const ext of ['wasm', 'wat', 'json']) expect(classifyWritePath(`${FORGED_CELLS_DIR}/${'a'.repeat(64)}.${ext}`)?.id).toBe('forged-cell-store')
    expect(classifyWritePath(`${FORGED_CELLS_DIR}/adder.wasm`)).toBeNull()
    expect(classifyWritePath(`${FORGED_CELLS_DIR}/${'a'.repeat(64)}.js`)).toBeNull()
  })

  it('classifications: forged and run_forged as compute; forge and forget write her home; voice refuses all four but nothing else changed', () => {
    expect(classifyActionIrreversibility({ tool: 'x6_cell', action: 'forged' })).toBe(0)
    expect(classifyActionIrreversibility({ tool: 'x6_cell', action: 'run_forged', cell: 'adder' })).toBe(0)
    expect(classifyActionIrreversibility({ tool: 'x6_cell', action: 'compute' })).toBe(0)
    expect(classifyActionIrreversibility({ tool: 'x6_cell', action: 'forge', name: 'adder', wat: '(module)' })).toBe(1)
    expect(classifyActionIrreversibility({ tool: 'x6_cell', action: 'forget', cell: 'adder' })).toBe(1)
    expect(classifyToolMutation('x6_cell', [{ name: 'action', type: 'string', required: true,
      enum: ['list', 'compute', 'run', 'compile_and_run', 'journal', 'forge', 'run_forged', 'forged', 'forget'] }]))
      .toEqual({ readOnly: false, mutating: true,
        actions: { read: ['forged', 'journal', 'list'], write: ['compile_and_run', 'compute', 'forge', 'forget', 'run', 'run_forged'] } })
    for (const action of ['forge', 'forget', 'run_forged', 'forged']) {
      expect(voiceVerdict({ tool: 'x6_cell', args: { action, cell: 'adder', name: 'adder', wat: '(module)' }, origin: { kind: 'builtin' } })).toContain('VOICE_LOOK_ONLY')
    }
    expect(voiceVerdict({ tool: 'x6_cell', args: { action: 'journal' }, origin: { kind: 'builtin' } })).toBeUndefined()
    expect(voiceVerdict({ tool: 'x6_cell', args: { action: 'list' }, origin: { kind: 'builtin' } })).toBeUndefined()
  })

  it('organs never reach forge or runForged through ctx.wasm', () => {
    const organ = organCellHost(testHost()) as unknown as J
    expect(Object.keys(organ).sort()).toEqual(['cellRows', 'compileAndRun', 'dispose', 'invoke', 'journal', 'journalSummary', 'list'])
    expect('forge' in organ || 'runForged' in organ).toBe(false)
  })
})

/** Minimal Wasm binary encoding, for a module written by hand (never through the pinned compiler). */
const uleb = (value: number): number[] => {
  const out: number[] = []
  let n = value
  do { let byte = n & 0x7f; n >>>= 7; if (n !== 0) byte |= 0x80; out.push(byte) } while (n !== 0)
  return out
}
const sleb = (value: bigint): number[] => {
  const out: number[] = []
  let v = value
  for (;;) {
    const byte = Number(v & 0x7fn)
    v >>= 7n
    const done = (v === 0n && (byte & 0x40) === 0) || (v === -1n && (byte & 0x40) !== 0)
    out.push(done ? byte : byte | 0x80)
    if (done) return out
  }
}
const vec = (items: number[][]): number[] => [...uleb(items.length), ...items.flat()]
const text = (value: string): number[] => { const b = [...new TextEncoder().encode(value)]; return [...uleb(b.length), ...b] }
const section = (id: number, body: number[]): number[] => [id, ...uleb(body.length), ...body]
const fnBody = (code: number[]): number[] => [...uleb(code.length + 2), 0, ...code, 0x0b]

/**
 * A hand-built module with the metered ABI's exact export set and FAKE fuel exports: `__mv_fuel_set` ignores its grant and
 * `__mv_fuel_remaining` always answers the default grant minus 7, so it "uses" 7 fuel whatever it does. Zero imports, one
 * memory of at most 2 pages: it passes admission. Its `mv_run` answers `{ sum: 999 }` to anything.
 */
const fakeFuelModule = (): Uint8Array => {
  const payload = [...new TextEncoder().encode('{"abi":1,"result":{"sum":999},"status":"ok"}')]
  const packed = (BigInt(payload.length) << 32n) | 1024n
  return Uint8Array.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    ...section(1, vec([[0x60, 0, 1, 0x7f], [0x60, 1, 0x7f, 1, 0x7f], [0x60, 2, 0x7f, 0x7f, 1, 0x7e], [0x60, 1, 0x7e, 0],
      [0x60, 0, 1, 0x7e]])),
    ...section(3, vec([[0], [1], [2], [3], [4]])),
    ...section(5, vec([[0x01, 1, 2]])),
    ...section(7, vec([[...text('memory'), 2, 0], [...text('mv_abi_version'), 0, 0], [...text('mv_alloc'), 0, 1], [...text('mv_run'), 0, 2],
      [...text('__mv_fuel_set'), 0, 3], [...text('__mv_fuel_remaining'), 0, 4]])),
    ...section(10, vec([fnBody([0x41, 1]), fnBody([0x41, ...sleb(4096n)]), fnBody([0x42, ...sleb(packed)]), fnBody([]),
      fnBody([0x42, ...sleb(BigInt(SKILL_DEFAULT_FUEL - 7))])])),
    ...section(11, vec([[0, 0x41, ...sleb(1024n), 0x0b, ...uleb(payload.length), ...payload]])),
  ])
}

/** A cell host whose execution worker records the key of every call it is asked to run. */
const recordingHost = (): { host: CellHost; keys: string[] } => {
  const keys: string[] = []
  const host = createCellHost({ origin: ORIGIN, fetchImpl: served(), now: () => 0, createWorker: (source) => {
    const inner = nodeCellWorker(source)
    return { ...inner, postMessage: (message) => { keys.push(String((message as J).key)); inner.postMessage(message) } }
  } })
  hosts.add(host)
  return { host, keys }
}
const writeManifest = (vfs: MemoryVfs, file: string, manifest: J): void => {
  vfs.writeFileSync(`${FORGED_CELLS_DIR}/${file}.json`, cellCanonicalJson(manifest))
}
const forgedLines = (read: CellJournalRead, name: string) => read.lines.filter(line => line.cell === `forged:${name}`)
const SKILLSMITH = CELL_PINS.skillsmith!.sha256

describe('the source is the truth', () => {
  it('rebuilt bytes with a memory maximum above the cap are refused by admission before any worker call', async () => {
    const { host, keys } = recordingHost()
    const { vfs, cell } = await mount(host)
    const wat = ADDER_WAT.replace('(memory (export "memory") 1 2)', '(memory (export "memory") 1 17)')
    const wrong = sha('wide at the wrong address')
    const manifest = { schema: FORGED_CELL_SCHEMA, name: 'wide', sha256: wrong, bytes: 0,
      watSha256: sha(wat), memoryPages: 17, forgedAt: 1, skillsmith: SKILLSMITH }
    vfs.mkdirSync(FORGED_CELLS_DIR, { recursive: true })
    writeManifest(vfs, wrong, manifest)
    vfs.writeFileSync(`${FORGED_CELLS_DIR}/${wrong}.wat`, wat)
    vfs.writeFileSync(`${FORGED_CELLS_DIR}/${wrong}.wasm`, new Uint8Array())
    const changed = await cell.execute({ action: 'run_forged', cell: wrong, op: 'add', input: { a: 2, b: 3 } }) as J
    expect(changed).toMatchObject({ ok: false, code: 'FORGED_BUILD_CHANGED', sha256: wrong })
    expect(changed.meteredSha256).toMatch(/^[a-f0-9]{64}$/u)
    const id = changed.meteredSha256 as string

    // The pinned compiler supplies the kept bytes; forge itself refuses this memory declaration before building.
    const build = await host.invoke('skillsmith', 'build', { wat, name: 'wide', version: 'v1',
      input_schema: { type: 'object' }, output_schema: { type: 'object' }, fuel: SKILL_DEFAULT_FUEL })
    if (!build.ok) throw new Error(build.code)
    const metered = await host.invoke('skillsmith', 'meter', { bytes: (build.result as J).bytes })
    if (!metered.ok) throw new Error(metered.code)
    const bytes = Uint8Array.from(Buffer.from((metered.result as J).bytes as string, 'base64'))
    expect(sha(bytes)).toBe(id)
    writeManifest(vfs, id, { ...manifest, sha256: id, bytes: bytes.byteLength })
    vfs.writeFileSync(`${FORGED_CELLS_DIR}/${id}.wat`, wat)
    vfs.writeFileSync(`${FORGED_CELLS_DIR}/${id}.wasm`, bytes)

    const before = keys.length
    expect(await cell.execute({ action: 'run_forged', cell: id, op: 'add', input: { a: 2, b: 3 } }))
      .toMatchObject({ ok: false, code: 'MODULE_MEMORY_LIMIT', sha256: id })
    expect(keys.slice(before).filter(key => key.startsWith('wide:'))).toEqual([])
    // Admission refusals are journaled, but no request or answer exists for a cell that never reached the worker.
    const read = await cell.execute({ action: 'journal' }) as CellJournalRead
    expect(forgedLines(read, 'wide').filter(line => line.pin === id)
      .map(line => [line.status, line.inputSha256, line.outputSha256])).toEqual([['refused', null, null]])
  }, 60_000)

  it('a hand-built module with fake fuel exports and a matching hand-written manifest never runs (FORGED_BUILD_CHANGED)', async () => {
    const fake = fakeFuelModule()
    const fakeSha = sha(fake)
    // The bytes pass every admission rule on their own: only the rebuild from source stands between them and a run.
    await expect(admitCell('fake', { sha256: fakeSha, bytes: FORGED_CELL_MAX_WASM_BYTES, fuel: SKILL_DEFAULT_FUEL }, fake, 16)).resolves.toBeDefined()
    const { host, keys } = recordingHost()
    const { vfs, cell } = await mount(host)
    vfs.mkdirSync(FORGED_CELLS_DIR, { recursive: true })
    vfs.writeFileSync(`${FORGED_CELLS_DIR}/${fakeSha}.wasm`, fake)
    vfs.writeFileSync(`${FORGED_CELLS_DIR}/${fakeSha}.wat`, ADDER_WAT)
    writeManifest(vfs, fakeSha, { schema: FORGED_CELL_SCHEMA, name: 'fake', sha256: fakeSha, bytes: fake.byteLength,
      watSha256: sha(ADDER_WAT), memoryPages: 2, forgedAt: 1, skillsmith: SKILLSMITH })
    expect(await cell.execute({ action: 'forged' })).toMatchObject({ ok: true, count: 1, cells: [{ name: 'fake', sha256: fakeSha, source: 'kept' }] })
    const compileSpy = vi.spyOn(WebAssembly, 'compile')
    const answer = await cell.execute({ action: 'run_forged', cell: 'fake', op: 'add', input: { a: 2, b: 3 } }) as J
    expect(answer).toMatchObject({ ok: false, cell: 'fake', op: 'add', code: 'FORGED_BUILD_CHANGED', fuelUsed: null, sha256: fakeSha })
    expect(answer.meteredSha256).not.toBe(fakeSha)
    expect(answer.compilerFuelUsed).toBeGreaterThan(0)
    expect(answer).not.toHaveProperty('result')
    // Never compiled, never sent to the execution worker: no call keyed to it, no request, no answer.
    expect(compileSpy.mock.calls.some(([source]) => source instanceof Uint8Array && sha(source) === fakeSha)).toBe(false)
    expect(keys.filter(key => key.startsWith('fake:'))).toEqual([])
    const read = await cell.execute({ action: 'journal' }) as CellJournalRead
    expect(forgedLines(read, 'fake').map(line => [line.status, line.pin, line.inputSha256, line.outputSha256]))
      .toEqual([['refused', fakeSha, null, null]])
    // The rebuild is journaled as the compiler's own two lines, as forge's are.
    expect(read.lines.slice(1, 3).map(line => [line.cell, line.op, line.caller])).toEqual([['skillsmith', 'meter', 'x6_cell'], ['skillsmith', 'build', 'x6_cell']])
  }, 60_000)

  it('the WAT edited or removed on disk is FORGED_SOURCE_CHANGED before any build; forged marks it changed or missing', async () => {
    const { vfs, cell } = await mount(testHost())
    const forged = await cell.execute({ action: 'forge', wat: ADDER_WAT, name: 'adder' }) as J
    const id = (forged.cell as J).sha256 as string
    const watPath = `${FORGED_CELLS_DIR}/${id}.wat`
    vfs.writeFileSync(watPath, ADDER_WAT.replace('i32.const 4096', 'i32.const 4097'))
    expect((await cell.execute({ action: 'forged' }) as J).cells).toEqual([{ ...(forged.cell as J), source: 'changed' }])
    expect(await cell.execute({ action: 'run_forged', cell: 'adder', op: 'add', input: { a: 2, b: 3 } }))
      .toEqual({ ok: false, cell: 'adder', op: 'add', code: 'FORGED_SOURCE_CHANGED', fuelUsed: null, sha256: id })
    vfs.unlinkSync(watPath)
    expect((await cell.execute({ action: 'forged' }) as J).cells).toEqual([{ ...(forged.cell as J), source: 'missing' }])
    expect(await cell.execute({ action: 'run_forged', cell: 'adder', op: 'add', input: { a: 2, b: 3 } })).toMatchObject({ ok: false, code: 'FORGED_SOURCE_CHANGED' })
    // Neither refusal built anything: the only compiler lines are forge's two.
    const read = await cell.execute({ action: 'journal' }) as CellJournalRead
    expect(read.totals.byCell).toEqual({ 'forged:adder': 2, skillsmith: 2 })
    vfs.writeFileSync(watPath, ADDER_WAT)
    expect(await cell.execute({ action: 'run_forged', cell: 'adder', op: 'add', input: { a: 2, b: 3 } })).toMatchObject({ ok: true, result: { sum: 5 } })
  }, 60_000)

  it('a kept WAT over the byte cap is changed and refused without reading its contents', async () => {
    const { vfs, cell } = await mount(testHost())
    const forged = await cell.execute({ action: 'forge', wat: ADDER_WAT, name: 'adder' }) as J
    const id = (forged.cell as J).sha256 as string
    const watPath = `${FORGED_CELLS_DIR}/${id}.wat`
    const oversized = `${'é'.repeat(FORGED_CELL_MAX_WAT_BYTES / 2)}x`
    expect(new TextEncoder().encode(oversized).byteLength).toBe(FORGED_CELL_MAX_WAT_BYTES + 1)
    vfs.writeFileSync(watPath, oversized)
    const readSpy = vi.spyOn(vfs, 'readFileSync')
    expect((await cell.execute({ action: 'forged' }) as J).cells).toEqual([{ ...(forged.cell as J), source: 'changed' }])
    expect(await cell.execute({ action: 'run_forged', cell: 'adder', op: 'add', input: { a: 2, b: 3 } }))
      .toMatchObject({ ok: false, code: 'FORGED_SOURCE_CHANGED', sha256: id })
    expect(readSpy.mock.calls.filter(([path]) => path === watPath)).toEqual([])
  }, 60_000)

  it('the stored .wasm replaced by other valid metered bytes: the rebuild matches the address, the run still refuses FORGED_BYTES_CHANGED', async () => {
    const { keys, host } = recordingHost()
    const { vfs, cell } = await mount(host)
    const adder = await cell.execute({ action: 'forge', wat: ADDER_WAT, name: 'adder' }) as J
    const other = await cell.execute({ action: 'forge', wat: constantWat(7), name: 'seven' }) as J
    const id = (adder.cell as J).sha256 as string
    const otherBytes = vfs.readFileSync(`${FORGED_CELLS_DIR}/${(other.cell as J).sha256 as string}.wasm`) as Uint8Array
    vfs.writeFileSync(`${FORGED_CELLS_DIR}/${id}.wasm`, otherBytes)
    const before = (await host.journal()).totals.byCell.skillsmith ?? 0
    expect(await cell.execute({ action: 'run_forged', cell: 'adder', op: 'add', input: { a: 2, b: 3 } }))
      .toEqual({ ok: false, cell: 'adder', op: 'add', code: 'FORGED_BYTES_CHANGED', fuelUsed: null, sha256: id })
    const read = await cell.execute({ action: 'journal' }) as CellJournalRead
    // The rebuild ran (two compiler lines), nothing was sent to the cell, and neither the kept nor the fresh bytes ran.
    expect((read.totals.byCell.skillsmith ?? 0) - before).toBe(2)
    expect(forgedLines(read, 'adder').map(line => [line.status, line.inputSha256])).toEqual([['refused', null]])
    expect(keys.filter(key => key.startsWith('adder:') || key.startsWith('seven:'))).toEqual([])
  }, 60_000)

  it('a manifest with an extra key, not canonical, or under another file name is FORGED_MANIFEST_INVALID; nothing runs', async () => {
    const host = testHost()
    const { vfs, cell } = await mount(host)
    const forged = await cell.execute({ action: 'forge', wat: ADDER_WAT, name: 'adder' }) as J
    const manifest = forged.cell as J
    const id = manifest.sha256 as string
    const calls = (await host.journal()).totals.calls
    const invalid = { ok: false, code: 'FORGED_MANIFEST_INVALID' }
    writeManifest(vfs, id, { ...manifest, note: 'extra' })
    expect(await cell.execute({ action: 'run_forged', cell: 'adder', op: 'add', input: { a: 2, b: 3 } })).toMatchObject({ ...invalid, cell: 'adder', sha256: id })
    expect(await cell.execute({ action: 'run_forged', cell: id, op: 'add', input: { a: 2, b: 3 } })).toMatchObject({ ...invalid, cell: id, sha256: id })
    vfs.writeFileSync(`${FORGED_CELLS_DIR}/${id}.json`, JSON.stringify(manifest, null, 1))
    expect(await cell.execute({ action: 'run_forged', cell: 'adder', op: 'add', input: { a: 2, b: 3 } })).toMatchObject(invalid)
    // The right manifest under the wrong file name: its sha256 is not its file's.
    vfs.unlinkSync(`${FORGED_CELLS_DIR}/${id}.json`)
    const elsewhere = sha('elsewhere')
    writeManifest(vfs, elsewhere, manifest)
    expect(await cell.execute({ action: 'run_forged', cell: 'adder', op: 'add', input: { a: 2, b: 3 } })).toMatchObject({ ...invalid, sha256: elsewhere })
    expect(await cell.execute({ action: 'run_forged', cell: elsewhere })).toMatchObject({ ...invalid, sha256: elsewhere })
    expect(await cell.execute({ action: 'run_forged', cell: 'nobody' })).toMatchObject({ ok: false, code: 'FORGED_UNKNOWN' })
    expect((await host.journal()).totals.calls).toBe(calls)
    // Put back, it runs again.
    vfs.unlinkSync(`${FORGED_CELLS_DIR}/${elsewhere}.json`)
    writeManifest(vfs, id, manifest)
    expect(await cell.execute({ action: 'run_forged', cell: 'adder', op: 'add', input: { a: 2, b: 3 } })).toMatchObject({ ok: true, result: { sum: 5 } })
  }, 60_000)

  it('an invalid manifest gives a recovery step that preserves the WAT and forge with replace makes it runnable', async () => {
    const { vfs, cell } = await mount(testHost())
    const forged = await cell.execute({ action: 'forge', wat: ADDER_WAT, name: 'adder' }) as J
    const manifest = forged.cell as J
    const id = manifest.sha256 as string
    const watPath = `${FORGED_CELLS_DIR}/${id}.wat`
    vfs.writeFileSync(`${FORGED_CELLS_DIR}/${id}.json`, JSON.stringify(manifest, null, 2))
    const invalid = await cell.execute({ action: 'run_forged', cell: 'adder', op: 'add', input: { a: 2, b: 3 } }) as J
    expect(invalid).toMatchObject({ ok: false, code: 'FORGED_MANIFEST_INVALID', sha256: id })
    expect(String(invalid.next)).toContain(watPath)
    expect(String(invalid.next)).toContain('replace: true')
    expect(String(invalid.next)).not.toMatch(/forget/iu)
    const kept = vfs.readFileSync(watPath, 'utf8') as string
    expect(kept).toBe(ADDER_WAT)
    expect(await cell.execute({ action: 'forge', wat: kept, name: 'adder', replace: true }))
      .toMatchObject({ ok: true, cell: { name: 'adder', sha256: id } })
    expect(await cell.execute({ action: 'run_forged', cell: 'adder', op: 'add', input: { a: 2, b: 3 } }))
      .toMatchObject({ ok: true, result: { sum: 5 } })
  }, 60_000)

  it('a cell kept under an older compiler pin is FORGED_COMPILER_CHANGED with its next step, and that one forge call recovers it', async () => {
    const host = testHost()
    const { vfs, cell } = await mount(host)
    const forged = await cell.execute({ action: 'forge', wat: ADDER_WAT, name: 'adder' }) as J
    const id = (forged.cell as J).sha256 as string
    const older = 'e'.repeat(64)
    writeManifest(vfs, id, { ...(forged.cell as J), skillsmith: older })
    const calls = (await host.journal()).totals.byCell.skillsmith
    const stale = await cell.execute({ action: 'run_forged', cell: 'adder', op: 'add', input: { a: 2, b: 3 } }) as J
    expect(stale).toMatchObject({ ok: false, cell: 'adder', code: 'FORGED_COMPILER_CHANGED', fuelUsed: null, sha256: id, expected: SKILLSMITH, got: older })
    expect(String(stale.next)).toContain(`${FORGED_CELLS_DIR}/${id}.wat`)
    expect(String(stale.next)).toContain('{ action: "forge", wat: <that text>, name: "adder", replace: true }')
    expect((await host.journal()).totals.byCell.skillsmith).toBe(calls)
    // Without replace, the name is taken; with it, the one call keeps it again under the current pin.
    const kept = vfs.readFileSync(`${FORGED_CELLS_DIR}/${id}.wat`, 'utf8') as string
    expect(await cell.execute({ action: 'forge', wat: kept, name: 'adder' })).toMatchObject({ ok: false, code: 'FORGE_NAME_TAKEN', sha256: id })
    const again = await cell.execute({ action: 'forge', wat: kept, name: 'adder', replace: true }) as J
    expect(again).toMatchObject({ ok: true, kept: 'replaced', replaced: id, cell: { name: 'adder', sha256: id, skillsmith: SKILLSMITH } })
    expect(filesUnder(vfs)).toEqual([`${id}.json`, `${id}.wasm`, `${id}.wat`])
    expect(await cell.execute({ action: 'run_forged', cell: 'adder', op: 'add', input: { a: 2, b: 3 } })).toMatchObject({ ok: true, result: { sum: 5 } })
    // And the same bytes once more, now current, are kept already.
    expect(await cell.execute({ action: 'forge', wat: kept, name: 'adder' })).toMatchObject({ ok: true, kept: 'already' })
  }, 60_000)

  it('the cost: each run builds again, measured for the adder and for a WAT near the 128 KiB cap', async () => {
    const { cell } = await mount(testHost())
    const blob = '\\5a'.repeat(41_000)
    const big = ADDER_WAT.replace('(memory (export "memory") 1 2)', `(memory (export "memory") 1 2)\n  (data (i32.const 8192) "${blob}")`)
    expect(new TextEncoder().encode(big).byteLength).toBeGreaterThan(FORGED_CELL_MAX_WAT_BYTES - 6 * 1024)
    expect(new TextEncoder().encode(big).byteLength).toBeLessThanOrEqual(FORGED_CELL_MAX_WAT_BYTES)
    const measured: J = {}
    for (const [name, wat] of [['adder', ADDER_WAT], ['big', big]] as const) {
      expect(await cell.execute({ action: 'forge', wat, name })).toMatchObject({ ok: true, kept: 'new' })
      await cell.execute({ action: 'run_forged', cell: name, op: 'add', input: { a: 2, b: 3 } })
      const started = performance.now()
      const run = await cell.execute({ action: 'run_forged', cell: name, op: 'add', input: { a: 2, b: 3 } }) as J
      const ms = performance.now() - started
      expect(run).toMatchObject({ ok: true, result: { sum: 5 } })
      // The rebuild's cost is its two compiler lines, just before the run's own line.
      const lines = (await cell.execute({ action: 'journal' }) as CellJournalRead).lines.slice(0, 3)
      expect(lines.map(line => [line.cell, line.op, line.status])).toEqual([[`forged:${name}`, 'add', 'ok'], ['skillsmith', 'meter', 'ok'], ['skillsmith', 'build', 'ok']])
      const compilerFuelUsed = (lines[1]!.fuelUsed ?? 0) + (lines[2]!.fuelUsed ?? 0)
      expect(compilerFuelUsed).toBeGreaterThan(0)
      measured[name] = { watBytes: new TextEncoder().encode(wat).byteLength, compilerFuelUsed, runFuelUsed: run.fuelUsed,
        ms: Math.round(ms) }
    }
    // The numbers go in the handoff.
    process.stderr.write(`forge cost ${JSON.stringify(measured)}\n`)
  }, 120_000)
})
