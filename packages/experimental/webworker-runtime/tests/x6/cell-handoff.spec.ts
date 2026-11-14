/**
 * One run, two hosts. Her browser side is the real cell host (createCellHost on a Node worker, the
 * pinned bytes served from apps/web/public/cells); the edge side is the REAL Worker route (deploy/cloudflare/src/
 * worker.mjs, POST /_host/cell-run) running the same file. The bundle hands the Worker that file as a compiled module
 * (wrangler's CompiledWasm rule); the mock below gives the Worker exactly that shape, compiled from exactly that file.
 * Local only: no network, no storage (the Worker's bindings are spies and stay untouched).
 */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { Worker } from 'node:worker_threads'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CELL_RUN_PATH, cellHandoff, type HandoffAnswer } from '../../src/x6/cell-handoff.ts'
import { classifyActionIrreversibility } from '../../src/x6/ball-loader.ts'
import { voiceVerdict } from '../../src/x6/voice-read-only.ts'
import * as wasmCells from '../../src/x6/wasm-cells.ts'
import { CELL_PINS, cellCanonicalJson, createCellHost, type CellHost, type CellWorker } from '../../src/x6/wasm-cells.ts'
import { mountE4, ORIGIN as E4_ORIGIN } from './e4-fixture.ts'
import { COUNTDOWN_ROM, OP, isaRun, word, type KyberRun, type KyberState } from './kyber-isa.ts'

vi.mock('../../../../../apps/web/public/cells/kyber-cpu.wasm', async () => {
  const { readFile: read } = await import('node:fs/promises')
  return { default: new WebAssembly.Module(await read(new URL('../../../../../apps/web/public/cells/kyber-cpu.wasm', import.meta.url))) }
})

const CELLS = new URL('../../../../../apps/web/public/cells/', import.meta.url)
const ORIGIN = 'https://kyber-handoff.example.invalid'
const PIN = CELL_PINS['kyber-cpu']!
const OWNER = { type: 'owner', email: 'owner@example.invalid', expires: Math.floor(Date.now() / 1000) + 3600 }
const sha = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex')

const served = (origin: string): typeof fetch => async (input: RequestInfo | URL): Promise<Response> => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
  if (url.origin !== origin || !url.pathname.startsWith('/cells/')) return new Response('no', { status: 404 })
  return new Response(new Uint8Array(await readFile(new URL(url.pathname.slice('/cells/'.length), CELLS))), { headers: { 'content-type': 'application/wasm' } })
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
const browserHost = (origin = ORIGIN): CellHost => {
  const host = createCellHost({ origin, fetchImpl: served(origin), createWorker: nodeCellWorker, now: () => 0 })
  hosts.add(host)
  return host
}
afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  try { await Promise.all([...hosts].map(host => host.dispose())) }
  finally {
    hosts.clear()
    await Promise.all([...workers].map(worker => worker.terminate()))
    workers.clear()
  }
})

/** The real Worker, its bindings spies; `fetch` is what her page's fetch reaches (the browser adds Origin and fetch metadata). */
async function edge(origin = ORIGIN) {
  const { createWorker } = await import(new URL('../../../../../deploy/cloudflare/src/worker.mjs', import.meta.url).href) as {
    createWorker: (options: { verifyAccess: () => Promise<unknown> }) => { fetch: (request: Request, env: unknown) => Promise<Response> } }
  const touched: string[] = []
  const spy = (name: string): unknown => new Proxy({}, { get(_target, property) { touched.push(`${name}.${String(property)}`); return () => { throw new Error(`${name} called`) } } })
  const env = { PUBLIC_HOST: new URL(origin).host, OWNER_EMAIL: OWNER.email, OWNER_PUBLIC_KEY_HEX: 'e'.repeat(64),
    HEAD: spy('HEAD'), MIRROR: spy('MIRROR'), VOICE_BRIDGE: spy('VOICE_BRIDGE'), ARCHIVE_BUCKET: spy('ARCHIVE_BUCKET'), ASSETS: spy('ASSETS') }
  let access: unknown = OWNER
  const worker = createWorker({ verifyAccess: async () => access })
  const sent: Array<{ url: string; body: Uint8Array }> = []
  const toRequest = (input: RequestInfo | URL, init?: RequestInit): Request => {
    const request = new Request(input, init)
    const headers = new Headers(request.headers)
    headers.set('origin', origin)
    headers.set('sec-fetch-site', 'same-origin')
    return new Request(request, { headers })
  }
  const fetchImpl: typeof fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = toRequest(input, init)
    sent.push({ url: request.url, body: new Uint8Array(await request.clone().arrayBuffer()) })
    return await worker.fetch(request, env)
  }
  return { worker, env, fetchImpl, toRequest, sent, touched, setAccess: (value: unknown) => { access = value } }
}

const handoffArgs = (rom: readonly number[], state: KyberState, steps: number, cutAt: number): Record<string, unknown> =>
  ({ action: 'handoff', cell: 'kyber-cpu', input: { rom: [...rom], state, steps }, cutAt })

const DOT_ROM = [260, 6, 0, 3, 260, 6, 101, 7] // the Kyber Kernel evidence's rom.json (as in kyber-cpu.spec.ts)
const NEVER_HALTS = [word(OP.INC0), word(OP.SWAP), word(OP.ADD01), word(OP.SWAP),
  word(OP.XOR01), word(OP.SWAP), word(OP.DEC1), word(OP.SWAP)]

describe('x6_cell handoff: her browser starts it, the edge finishes it, and the end is the same', () => {
  it('every cut from 0 to the full length gives same: true, for countdown, the shipped rom.json and a program that never halts', async () => {
    const cells = browserHost()
    const e = await edge()
    const countdown = JSON.parse(await readFile(new URL('kyber/skills/countdown.rom.json', CELLS), 'utf8')) as { rom: number[] }
    expect(countdown.rom).toEqual([...COUNTDOWN_ROM])
    const programs: Array<[string, readonly number[], KyberState, number]> = [
      ['countdown', countdown.rom, { a: 0, b: 7, halted: 0, pc: 0 }, 64],
      ['countdown', countdown.rom, { a: 0, b: 15, halted: 0, pc: 0 }, 64],
      ['countdown', countdown.rom, { a: 0, b: 0, halted: 0, pc: 0 }, 64],
      ['dot-rom', DOT_ROM, { a: 3, b: 5, halted: 0, pc: 0 }, 48],
      ['dot-rom', DOT_ROM, { a: 9, b: 2, halted: 0, pc: 4 }, 48],
      ['never-halts', NEVER_HALTS, { a: 1, b: 2, halted: 0, pc: 0 }, 40],
      ['never-halts', NEVER_HALTS, { a: 15, b: 0, halted: 0, pc: 3 }, 300],
    ]
    let cuts = 0
    for (const [name, rom, state, steps] of programs) {
      const expected: KyberRun = isaRun(state, rom, steps)
      for (let cutAt = 0; cutAt <= expected.stepsTaken; cutAt += 1) {
        const answer = await cellHandoff(cells, handoffArgs(rom, state, steps, cutAt), { origin: ORIGIN, fetchImpl: e.fetchImpl })
        expect(answer, `${name} cut ${String(cutAt)}`).toMatchObject({ ok: true, cell: 'kyber-cpu', cutAt, local: expected, edge: expected, same: true,
          pins: { browser: PIN.sha256, edge: PIN.sha256 } })
        // The checkpoint's digest is of exactly the bytes sent, and the edge got nothing else.
        type Sent = { cell: string; op: string; input: { checkpoint: { stepsTaken: number; state: KyberState } } }
        const body = JSON.parse(new TextDecoder().decode(e.sent.at(-1)!.body)) as Sent
        expect(Object.keys(body).sort()).toEqual(['cell', 'input', 'op'])
        expect([body.cell, body.op, Object.keys(body.input)]).toEqual(['kyber-cpu', 'cpu.resume', ['checkpoint']])
        expect(body.input.checkpoint.stepsTaken).toBe(cutAt)
        expect(body.input.checkpoint.state).toEqual(isaRun(state, rom, cutAt).state)
        expect(answer.checkpointSha256).toBe(sha(cellCanonicalJson(body.input.checkpoint)))
        cuts += 1
      }
      // Past the end there is nothing to cut.
      expect(await cellHandoff(cells, handoffArgs(rom, state, steps, expected.stepsTaken + 1), { origin: ORIGIN, fetchImpl: e.fetchImpl }))
        .toMatchObject({ ok: false, code: 'HANDOFF_CUT_OUT_OF_RANGE', local: expected, edge: null, same: null })
    }
    const lengths = programs.map(([, rom, state, steps]) => isaRun(state, rom, steps).stepsTaken)
    expect(lengths.filter((_, index) => programs[index]![0] === 'never-halts')).toEqual([40, 300])
    expect(cuts).toBe(lengths.reduce((sum, length) => sum + length + 1, 0))
    expect(cuts).toBeGreaterThan(400)
    expect(e.sent.every(entry => entry.url === `${ORIGIN}${CELL_RUN_PATH}`)).toBe(true)
    expect(e.touched).toEqual([])
  }, 120_000)

  it('journals both local calls as x6_cell and the edge\'s one call as edge, with the edge\'s pin', async () => {
    const cells = browserHost()
    const e = await edge()
    const args = handoffArgs(COUNTDOWN_ROM, { a: 0, b: 7, halted: 0, pc: 0 }, 64, 10)
    const answer = await cellHandoff(cells, args, { origin: ORIGIN, fetchImpl: e.fetchImpl, now: () => 0 })
    expect(answer.same).toBe(true)
    const read = await cells.journal()
    expect(read.lines.map(line => [line.cell, line.op, line.status, line.caller, line.pin])).toEqual([
      ['kyber-cpu', 'cpu.resume', 'ok', 'edge', PIN.sha256],
      ['kyber-cpu', 'cpu.run', 'ok', 'x6_cell', PIN.sha256],
      ['kyber-cpu', 'cpu.run', 'ok', 'x6_cell', PIN.sha256],
    ])
    const edgeLine = read.lines[0]!
    expect(edgeLine.inputSha256).toBe(sha(e.sent[0]!.body))
    expect(edgeLine.fuelUsed).toBeGreaterThan(0)
    // Only noteEdgeCall writes `edge`: a call run here that asks for it is journalled as `other`.
    await cells.invoke('kyber-cpu', 'cpu.step', { rom: [...COUNTDOWN_ROM], state: { a: 0, b: 1, halted: 0, pc: 0 } }, 'edge')
    expect((await cells.journal()).lines[0]).toMatchObject({ op: 'cpu.step', caller: 'other' })
  })

  it('a checkpoint changed in transit is refused by the edge with the cell\'s own refusal: same is null, never a wrong end', async () => {
    const cells = browserHost()
    const e = await edge()
    const tampering: typeof fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const text = new TextDecoder().decode(init!.body as Uint8Array)
      const changed = text.replace(/"check":(\d+)/u, (_all, check: string) => `"check":${String((Number(check) ^ 1) >>> 0)}`)
      expect(changed).not.toBe(text)
      return await e.fetchImpl(input, { ...init, body: changed })
    }
    const args = handoffArgs(COUNTDOWN_ROM, { a: 0, b: 9, halted: 0, pc: 0 }, 64, 5)
    const answer = await cellHandoff(cells, args, { origin: ORIGIN, fetchImpl: tampering })
    expect(answer).toMatchObject({ ok: false, code: 'CHECKPOINT_INVALID', edge: null, same: null, pins: { browser: PIN.sha256, edge: PIN.sha256 } })
    expect((await cells.journal()).lines[0]).toMatchObject({ caller: 'edge', status: 'refused', pin: PIN.sha256 })
  })

  it('an unreachable edge, or one that refuses, gives same: null with a closed code; nothing is retried', async () => {
    const cells = browserHost()
    let calls = 0
    const down = (async () => { calls += 1; throw new TypeError('fetch failed') }) as typeof fetch
    const args = handoffArgs(COUNTDOWN_ROM, { a: 0, b: 3, halted: 0, pc: 0 }, 64, 4)
    const unreachable = await cellHandoff(cells, args, { origin: ORIGIN, fetchImpl: down })
    expect(unreachable).toMatchObject({ ok: false, code: 'EDGE_UNREACHABLE', edge: null, same: null, pins: { browser: PIN.sha256, edge: null } })
    expect(unreachable.local).toEqual(isaRun({ a: 0, b: 3, halted: 0, pc: 0 }, COUNTDOWN_ROM, 64))
    expect(calls).toBe(1)
    expect((await cells.journal()).lines[0]).toMatchObject({ caller: 'edge', status: 'refused', pin: 'unanswered', outputSha256: null })
    const e = await edge()
    e.setAccess({ type: 'access', email: 'guest@example.invalid', expires: OWNER.expires })
    expect(await cellHandoff(cells, args, { origin: ORIGIN, fetchImpl: e.fetchImpl })).toMatchObject({ ok: false, code: 'OWNER_ACCESS_REQUIRED', same: null })
    expect((await cells.journal()).lines[0]).toMatchObject({ caller: 'edge', status: 'refused', pin: 'unanswered' })
    const notJson = (async () => new Response('<html>', { status: 502 })) as typeof fetch
    expect(await cellHandoff(cells, args, { origin: ORIGIN, fetchImpl: notJson })).toMatchObject({ ok: false, code: 'EDGE_ANSWER_INVALID', same: null })
    const huge = (async () => new Response('x'.repeat(70_000))) as typeof fetch
    expect(await cellHandoff(cells, args, { origin: ORIGIN, fetchImpl: huge })).toMatchObject({ ok: false, code: 'EDGE_ANSWER_TOO_LARGE', same: null })
  })

  it('refuses before any cell call: another cell, extra or missing keys, a bad cut, no origin', async () => {
    const cells = browserHost()
    const edgeCalls: unknown[] = []
    const never = (async (...args: unknown[]) => { edgeCalls.push(args); throw new Error('not reached') }) as typeof fetch
    const base = handoffArgs(COUNTDOWN_ROM, { a: 0, b: 3, halted: 0, pc: 0 }, 64, 1)
    const cases: Array<[Record<string, unknown>, string, string | undefined]> = [
      [{ ...base, cell: 'nucleus' }, 'HANDOFF_CELL_REFUSED', ORIGIN],
      [{ ...base, cell: 'aura-focus' }, 'HANDOFF_CELL_REFUSED', ORIGIN],
      [{ ...base, fuel: 1 }, 'HANDOFF_INPUT_INVALID', ORIGIN],
      [{ ...base, input: { rom: [...COUNTDOWN_ROM], state: { a: 0, b: 3, halted: 0, pc: 0 } } }, 'HANDOFF_INPUT_INVALID', ORIGIN],
      [{ ...base, input: { ...(base.input as object), checkpointEvery: 1 } }, 'HANDOFF_INPUT_INVALID', ORIGIN],
      [{ ...base, cutAt: -1 }, 'HANDOFF_CUT_INVALID', ORIGIN],
      [{ ...base, cutAt: 1.5 }, 'HANDOFF_CUT_INVALID', ORIGIN],
      [{ ...base, cutAt: undefined }, 'HANDOFF_CUT_INVALID', ORIGIN],
      [base, 'HANDOFF_ORIGIN_UNAVAILABLE', undefined],
    ]
    for (const [args, code, origin] of cases) {
      expect(await cellHandoff(cells, args, { origin, fetchImpl: never }), code).toMatchObject({ ok: false, code, same: null })
    }
    expect(edgeCalls).toEqual([])
    expect((await cells.journal()).totals.calls).toBe(0)
  })

  it('classification: handoff is a compute (0) like compute, and from a look-only voice turn it is refused exactly as compute is', () => {
    expect(classifyActionIrreversibility({ tool: 'x6_cell', action: 'handoff', cell: 'kyber-cpu' })).toBe(0)
    expect(classifyActionIrreversibility({ tool: 'x6_cell', action: 'compute', cell: 'kyber-cpu' })).toBe(0)
    const voice = (action: string): string | undefined => voiceVerdict({ tool: 'x6_cell', args: { action, cell: 'kyber-cpu' }, origin: { kind: 'builtin' } })
    expect(voice('compute')).toContain('VOICE_LOOK_ONLY')
    expect(voice('handoff')).toContain('VOICE_LOOK_ONLY')
  })

  it('through her real x6_cell tool: one handoff from her runtime reaches only the edge route and answers same: true', async () => {
    const cells = browserHost(E4_ORIGIN)
    const e = await edge(E4_ORIGIN)
    vi.spyOn(wasmCells, 'workerCellHost').mockReturnValue(cells)
    const m = await mountE4({ respond: async (call) => {
      if (call.path === '/api/build' && call.method === 'GET') return Response.json({ ok: true, schema: 'aukora.edge-build.v1', sourceRevision: null })
      if (call.path !== CELL_RUN_PATH) return null
      return await e.worker.fetch(e.toRequest(`${E4_ORIGIN}${CELL_RUN_PATH}`, { method: call.method, headers: { 'content-type': call.headers.get('content-type') ?? '' },
        body: JSON.stringify(call.body) }), e.env)
    } })
    const answer = await m.tool('x6_cell').execute(handoffArgs(COUNTDOWN_ROM, { a: 0, b: 7, halted: 0, pc: 0 }, 64, 12)) as HandoffAnswer
    expect(answer).toMatchObject({ ok: true, cutAt: 12, same: true, pins: { browser: PIN.sha256, edge: PIN.sha256 },
      local: { halted: 1, state: { a: 7, b: 0, halted: 1, pc: 6 }, stepsTaken: 24 } })
    const toEdge = m.calls.filter(call => call.path === CELL_RUN_PATH)
    expect(toEdge.map(call => [call.method, call.credentials, call.headers.get('content-type')])).toEqual([['POST', 'same-origin', 'application/json']])
    expect(e.touched).toEqual([])
  })
})
