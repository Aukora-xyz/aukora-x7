/**
 * `x6_self_check`, her inside test in one call.
 *
 * On her mounted runtime (e4 fixture, reserved `.invalid` origin, the real pinned cells on a Node worker): every probe is
 * green on a fixture body whose facts are true, and the whole check writes nothing (write-set recorder under her VFS,
 * the runtime's live recorder, a digest of every byte, no IndexedDB or storage touch) and sends only the listed GETs and
 * status and cell-resume POSTs. Over a made-up body (fake registry): each probe is red when its one fact is false; `only`; an
 * unregistered tool gives `skipped`; a hanging probe gives TIMEOUT and the rest still run; a throw is a fail with its
 * first line; the 60 s call bound; the 8 KiB cap. The built-in list is pinned against a booted runtime; the worked adder
 * is held equal to its doc; the check is classified a read everywhere. Local fixtures only.
 */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { Worker } from 'node:worker_threads'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { classifyActionIrreversibility } from '../../src/x6/ball-loader.ts'
import { MemoryVfs } from '../../src/storage/memory.ts'
import { TOUCH_ID_TIER_REFLEX_DIGEST, TOUCH_ID_TIER_REFLEX_PATH } from '../../src/x6/nucleus-shadow.ts'
import {
  runSelfCheck, SELF_CHECK_ADDER_WAT, SELF_CHECK_BUILTINS, SELF_CHECK_DETAIL_CHARS, SELF_CHECK_PROBES, SELF_CHECK_RESULT_BYTES,
  type SelfCheckDeps, type SelfCheckProbe,
} from '../../src/x6/self-check.ts'
import { voiceVerdict } from '../../src/x6/voice-read-only.ts'
import * as wasmCells from '../../src/x6/wasm-cells.ts'
import { CELL_PINS, createCellHost, type CellHost, type CellWorker } from '../../src/x6/wasm-cells.ts'
import { createWriteSetRecorder, liveWriteSet } from '../../src/x6/write-set-inventory.ts'
import { FakeSocket, mountE4, ORIGIN, type Call } from './e4-fixture.ts'
import { COUNTDOWN_ROM, isaRun, kyberCheck } from './kyber-isa.ts'

type J = Record<string, unknown>
const CELLS = new URL('../../../../../apps/web/public/cells/', import.meta.url)
const REV = '3'.repeat(40)
const COUNTDOWN_ID = '1205ded1b88bba84abc4fd171529b7ae2fc35e1cd8890f68651e745d8e1fcada'
const KYBER_PIN = CELL_PINS['kyber-cpu']?.sha256
const cutState = isaRun({ a: 0, b: 7, halted: 0, pc: 0 }, COUNTDOWN_ROM, 12).state
const HANDOFF_REQUEST = { cell: 'kyber-cpu', input: { checkpoint: {
  check: kyberCheck(COUNTDOWN_ROM, cutState, 64, 12), rom: [...COUNTDOWN_ROM], state: cutState, steps: 64, stepsTaken: 12,
} }, op: 'cpu.resume' }
const SKILL_GETS = ['/cells/kyber/skills/index.json', '/cells/kyber/skills/countdown.json',
  '/cells/kyber/skills/countdown.rom.json', '/cells/kyber/cpu-weights.json']
const PROBE_IDS = ['build', 'tools', 'cells-pinned', 'cell-nucleus', 'cell-kyber', 'cell-journal', 'cell-compile', 'self-state',
  'nucleus-shadow', 'door-cloudflare', 'door-linear', 'exec-list', 'voice', 'capability-index', 'threads',
  'skill-countdown', 'two-hosts', 'pentora-carry', 'cord-status', 'tools-list', 'tools-callable']
/** The cord-status probe's same-origin GETs (the shipped record, its program and the profile). */
const CORD_GETS = ['/cells/kyber/skills/cord-echo.json', '/cells/kyber/skills/cord-echo.program.json', '/cells/cord/fifo24.profile.json']

// ---------- her real cell host on a Node worker, every fetch it makes recorded ----------
const cellFetches: string[] = []
const served: typeof fetch = async (input, init) => {
  const request = new Request(input, init), url = new URL(request.url)
  cellFetches.push(`${request.method} ${url.pathname}`)
  if (url.origin !== ORIGIN || !url.pathname.startsWith('/cells/')) return new Response('no', { status: 404 })
  return new Response(Uint8Array.from(await readFile(new URL(url.pathname.slice('/cells/'.length), CELLS))),
    { headers: { 'content-type': 'application/wasm' } })
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
const realHost = (): CellHost => {
  const host = createCellHost({ origin: ORIGIN, fetchImpl: served, createWorker: nodeCellWorker })
  hosts.add(host)
  return host
}
afterEach(async () => {
  FakeSocket.instances.length = 0
  cellFetches.length = 0
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  try { await Promise.all([...hosts].map(host => host.dispose())) }
  finally {
    hosts.clear()
    await Promise.all([...workers].map(worker => worker.terminate()))
    workers.clear()
  }
})

/** Her edge, answering exactly the reads the check makes, each as a configured, healthy body would. */
const edge = async (call: Call): Promise<Response | null> => {
  const key = `${call.method} ${call.path}`
  if (call.method === 'GET' && (SKILL_GETS.includes(call.path) || CORD_GETS.includes(call.path))) {
    return new Response(Uint8Array.from(await readFile(new URL(call.path.slice('/cells/'.length), CELLS))))
  }
  if (key === 'GET /api/build') return Response.json({ ok: true, schema: 'aukora.edge-build.v1', sourceRevision: REV })
  if (key === `GET ${TOUCH_ID_TIER_REFLEX_PATH}`) {
    return new Response(Uint8Array.from(await readFile(new URL('reflexes/touch-id-tier.json', CELLS))))
  }
  if (key === 'POST /_host/cloudflare') return Response.json({ ok: true, action: 'status', level: 'open',
    brokerConfigured: true, accountConfigured: true, authKind: 'api-key' })
  if (key === 'POST /_host/linear') return Response.json({ ok: true, action: 'status', level: 'open',
    configured: true, workspace: 'made-up' })
  // x6_exec list, her newest auma-exec.yml runs as the edge's exec door answers them.
  if (key === 'POST /_host/repo') return Response.json({ ok: true, action: 'exec_runs', workflow: 'auma-exec.yml', total: 1, stdout: '', stderr: '',
    runs: [{ id: 42, status: 'completed', conclusion: 'success', created: '2026-11-14T10:00:00Z', runName: 'auma-exec x-1 @ main', label: 'x-1', ref: 'main',
      url: 'https://github.com/your_org_x/your-node/actions/runs/42' }] })
  if (key === 'POST /_host/voice') {
    return Response.json({ switch: 'on', names: { VOICE_MANAGED: 'set' }, keyInUse: 'ELEVENLABS_VOICE_API_KEY',
      resourceKind: 'agent', live: 0,
      failures: [{ door: 'owner', stage: 'mint-401', atMs: 5 }, { door: 'provider', stage: 'jwt-bad', atMs: 9 }] })
  }
  return null
}

/** Digest over every path, kind and byte. */
function digest(vfs: MemoryVfs): string {
  const hash = createHash('sha256')
  const walk = (dir: string): void => {
    for (const name of [...vfs.readdirSync(dir)].map(String).sort()) {
      const path = dir === '/' ? `/${name}` : `${dir}/${name}`
      if (vfs.statSync(path).isDirectory()) { hash.update(`d:${path}\n`); walk(path); continue }
      const data = vfs.readFileSync(path)
      hash.update(`f:${path}:`).update(typeof data === 'string' ? data : Buffer.from(data)).update('\n')
    }
  }
  walk('/')
  return hash.digest('hex')
}
function touchRecorder(name: string, touched: string[]): unknown {
  return new Proxy({}, { get(_target, property) {
    touched.push(`${name}.${String(property)}`)
    return () => { throw new Error(`${name} touched`) }
  } })
}

async function boot() {
  const raw = new MemoryVfs()
  const recorder = createWriteSetRecorder(raw)
  vi.spyOn(wasmCells, 'workerCellHost').mockReturnValue(realHost())
  const edgeCells = realHost()
  const m = await mountE4({ vfs: recorder.vfs as unknown as MemoryVfs, respond: async (call) => {
    if (call.method === 'POST' && call.path === '/_host/cell-run') {
      expect(call.body).toEqual(HANDOFF_REQUEST)
      const answer = await edgeCells.invoke('kyber-cpu', 'cpu.resume', HANDOFF_REQUEST.input, 'x6_cell')
      return Response.json(answer.ok ? { ok: true, pin: answer.sha256, result: answer.result, fuelUsed: answer.fuelUsed } : answer)
    }
    return await edge(call)
  },
  buildIdentity: { sourceRevision: REV, sourceDirty: false, builtAt: null, runtimeArtifactSha256: null } })
  for (let i = 0; i < 20; i += 1) await new Promise(resolve => setTimeout(resolve, 0))
  return { m, raw, recorder }
}

describe('on her mounted runtime', () => {
  it('every probe with something to check is green on a body whose facts are true (tools-callable, with no tool mounted, is '
    + 'skipped and the check is still ok), and the check writes nothing and sends only the listed reads', async () => {
    const { m, raw, recorder } = await boot()
    const shadow = (await m.tool('x6_self_state').execute({}) as J).nucleusShadow
    const before = { writes: recorder.inventory().counters.writes, live: liveWriteSet.snapshot().counters.writes, digest: digest(raw) }
    const fromCall = m.calls.length
    const touched: string[] = []
    vi.stubGlobal('indexedDB', touchRecorder('indexedDB', touched))
    vi.stubGlobal('localStorage', touchRecorder('localStorage', touched))
    vi.stubGlobal('sessionStorage', touchRecorder('sessionStorage', touched))
    const answer = await m.tool('x6_self_check').execute({}) as J
    const rows = answer.rows as Array<{ id: string; ok: boolean | null; ms: number; detail: string }>
    expect(rows.map(row => row.id)).toEqual(PROBE_IDS)
    // A fresh body has no tool of hers mounted, so tools-callable has nothing to check: that row is skipped (never
    // a pass), and the body as a whole is still healthy (review MUST: an empty skip does not make the check cry wolf).
    expect(rows.filter(row => row.ok !== true).map(row => [row.id, row.ok, row.detail]))
      .toEqual([['tools-callable', null, 'no mounted tools: nothing to check']])
    expect(answer).toMatchObject({ schema: 'aukora.self-check.v1', ok: true, build: REV,
      summary: { pass: PROBE_IDS.length - 1, fail: 0, skipped: 1 } })
    const detail = Object.fromEntries(rows.map(row => [row.id, row.detail]))
    expect(detail).toMatchObject({
      'build': `runtime ${REV.slice(0, 12)}, edge ${REV.slice(0, 12)}`,
      'tools': `${String(SELF_CHECK_BUILTINS.length)} of ${String(SELF_CHECK_BUILTINS.length)} built-ins registered `
        + `(${String(SELF_CHECK_BUILTINS.length)} tools in all)`,
      'cells-pinned': `${String(Object.keys(CELL_PINS).length)} cells, ${String(Object.keys(CELL_PINS).length)} pins`,
      'cell-nucleus': 'decision 1, escalate 1, row 3',
      'cell-kyber': 'halted 1, state.a 7, stepsTaken 24',
      'skill-countdown': `16 of 16 cases agree, skill ${COUNTDOWN_ID.slice(0, 12)}`,
      'two-hosts': `same: true, browser ${KYBER_PIN?.slice(0, 12)}, edge ${KYBER_PIN?.slice(0, 12)}`,
      'pentora-carry': '1329 of 1329 recovered, 10 packets dropped',
      'cord-status': 'not started, skill 9aaa33f31231',
      'door-cloudflare': 'level open, configured',
      'door-linear': 'level open, configured',
      'exec-list': '1 runs listed, newest 42 completed/success',
      'tools-list': '0 mounted, 0 proposals',
      'tools-callable': 'no mounted tools: nothing to check',
      'voice': 'switch on, key ELEVENLABS_VOICE_API_KEY, newest failure provider:jwt-bad, '
        + 'runtime level look-only, newest code none',
    })
    expect(detail['cell-journal']).toMatch(/^calls \d+ to \d+ \(\+[2-9]\d*\), root changed$/)
    expect(detail['cell-compile']).toMatch(/^sum 5, compiler fuel \d+$/)
    expect(detail['nucleus-shadow']).toMatch(/^decision 1 \(NO_ENTRY_CHANGED\), escalate 1, \d+ ms$/)
    expect(detail['self-state']).toMatch(/^2 organs, 0 differ from her store, 30 cells, 0 forged, \d+ unknown$/)
    expect(detail['capability-index']).toMatch(new RegExp(`^tools ${String(SELF_CHECK_BUILTINS.length)}, readOnly \\d+, mutating \\d+$`))
    expect(detail.threads).toMatch(/^\d+ threads, \d+ listed$/)
    expect(new TextEncoder().encode(JSON.stringify(answer)).byteLength).toBeLessThanOrEqual(SELF_CHECK_RESULT_BYTES)

    // It writes nothing: her VFS's recorder, the runtime's own live recorder, every byte, no browser storage.
    expect(recorder.inventory().counters.writes).toBe(before.writes)
    expect(liveWriteSet.snapshot().counters.writes).toBe(before.live)
    expect(digest(raw)).toBe(before.digest)
    expect(touched).toEqual([])
    // The shadow consult was asked and never settled: her tally is as it was.
    expect((await m.tool('x6_self_state').execute({}) as J).nucleusShadow).toEqual(shadow)
    // Only these requests leave: the listed GETs, status POSTs and one exact checkpoint sent for a computation.
    const ALLOWED = new Set(['GET /api/build', `GET ${TOUCH_ID_TIER_REFLEX_PATH}`, 'POST /_host/cloudflare {"action":"status"}',
      'POST /_host/linear {"action":"status"}', 'POST /_host/voice {"action":"managed_status"}', 'POST /_host/repo {"action":"exec_runs"}',
      ...SKILL_GETS.map(path => `GET ${path}`), ...CORD_GETS.map(path => `GET ${path}`), `POST /_host/cell-run ${JSON.stringify(HANDOFF_REQUEST)}`])
    const sent = m.calls.slice(fromCall)
      .map(call => call.method === 'GET' ? `GET ${call.path}` : `${call.method} ${call.path} ${JSON.stringify(call.body)}`)
    expect(sent.filter(request => !ALLOWED.has(request))).toEqual([])
    expect([...new Set(sent)].sort()).toEqual([...ALLOWED].sort())
    // One GET /api/build for the whole check (build, self-state and nucleus-shadow share one x6_self_state read), and one
    // for the closing x6_self_state above.
    expect(sent.filter(request => request === 'GET /api/build')).toHaveLength(2)
    expect(sent.filter(request => request.startsWith('POST /_host/cell-run '))).toHaveLength(1)
    for (const path of SKILL_GETS) {
      // The cord-status probe reads the index once more, for the cord-echo record.
      const expected = path === '/cells/kyber/skills/countdown.json' || path === '/cells/kyber/cpu-weights.json'
        || path === '/cells/kyber/skills/index.json' ? 2 : 1
      expect(sent.filter(request => request === `GET ${path}`)).toHaveLength(expected)
    }
    // The cord-echo record and program are read by x6_skill (it lists every shipped skill) and by the cord shelf; the profile once.
    for (const path of CORD_GETS) expect(sent.filter(request => request === `GET ${path}`)).toHaveLength(path.endsWith('.profile.json') ? 1 : 2)
    expect(cellFetches.length).toBeGreaterThan(0)
    expect(cellFetches.filter(request => !/^GET \/cells\/[a-z0-9-]+\.wasm$/.test(request))).toEqual([])
  }, 120_000)

  it('the built-in list is pinned: a built-in added or removed in the runtime fails here until SELF_CHECK_BUILTINS '
    + 'changes with it', async () => {
    vi.spyOn(wasmCells, 'workerCellHost').mockReturnValue(realHost())
    const m = await mountE4({ respond: edge })
    const index = await m.tool('x6_capability_index').execute({ action: 'snapshot' }) as { registeredTools: Array<{ name: string }> }
    expect(index.registeredTools.map(tool => tool.name).sort()).toEqual([...SELF_CHECK_BUILTINS].sort())
    expect(new Set(SELF_CHECK_BUILTINS).size).toBe(SELF_CHECK_BUILTINS.length)
    // The source agrees: every literal name her loader passes to registerBuiltin is on the list.
    const source = await readFile(new URL('../../src/x6/ball-loader.ts', import.meta.url), 'utf8')
    const literal = [...source.matchAll(/registerBuiltin\(\{(?: \/\/[^\n]*)?\s+name: '([a-z0-9_]+)'/g)].map(match => match[1])
    expect(literal.length).toBeGreaterThan(25)
    expect(literal.filter(name => !SELF_CHECK_BUILTINS.includes(name as string))).toEqual([])
  }, 60_000)

  it('is a read everywhere it is classified, and a look-only voice turn may call it as her own built-in only', async () => {
    vi.spyOn(wasmCells, 'workerCellHost').mockReturnValue(realHost())
    const m = await mountE4({ respond: edge })
    expect(await m.tool('x6_capability_index').execute({ action: 'lookup', name: 'x6_self_check' }))
      .toMatchObject({ ok: true, tool: { readOnly: true, mutating: false } })
    expect(classifyActionIrreversibility({ tool: 'x6_self_check' })).toBe(0)
    expect(classifyActionIrreversibility({ tool: 'x6_self_check', only: ['build'] })).toBe(0)
    expect(voiceVerdict({ tool: 'x6_self_check', args: {}, origin: { kind: 'builtin' } })).toBeUndefined()
    expect(voiceVerdict({ tool: 'x6_self_check', args: { only: ['voice'] }, origin: { kind: 'builtin' } })).toBeUndefined()
    expect(voiceVerdict({ tool: 'x6_self_check', args: {}, origin: { kind: 'preset' } })).toContain('VOICE_LOOK_ONLY')
  }, 60_000)
})

describe('her words', () => {
  it('the worked adder is docs/auma/cells/adder.wat byte for byte', async () => {
    expect(await readFile(new URL('../../../../../docs/auma/cells/adder.wat', import.meta.url), 'utf8')).toBe(`${SELF_CHECK_ADDER_WAT}\n`)
  })

  it('every probe has a row in docs/auma/self-check.md, in run order', async () => {
    const doc = await readFile(new URL('../../../../../docs/auma/self-check.md', import.meta.url), 'utf8')
    expect(SELF_CHECK_PROBES.map(probe => probe.id)).toEqual(PROBE_IDS)
    const named = [...doc.matchAll(/^\| `([a-z-]+)` \|/gm)].map(match => match[1])
    expect(named).toEqual(PROBE_IDS)
  })
})

// ---------- a made-up body: every answer a healthy body gives, one fact changed per test ----------
type Answers = Record<string, unknown>
const GREEN: Answers = {
  'x6_self_state': { runtime: { sourceRevision: REV }, edge: { sourceRevision: REV }, head: null,
    organs: [{ id: 'organ-a', matchesStore: false }, { id: 'organ-b', matchesStore: true }], cellCount: 27, cells: [],
    nucleusShadow: { reflex: TOUCH_ID_TIER_REFLEX_DIGEST }, forgedCells: { count: 0, cells: [] }, unknown: [] },
  'x6_cell list': { ok: true, cells: Object.keys(CELL_PINS).map(cell => ({ cell })) },
  'x6_cell compute nucleus': { ok: true, result: { decision: 1, escalate: 1, row: 3, reflex: 'x' } },
  'x6_cell compute kyber-cpu': { ok: true, result: { halted: 1, state: { a: 7, b: 0, halted: 1, pc: 6 }, stepsTaken: 24 } },
  'x6_skill': { ok: true, id: COUNTDOWN_ID, verified: true, cases: { total: 16, agree: 16, differ: [] } },
  'x6_cell handoff': { ok: true, same: true, pins: { browser: KYBER_PIN, edge: KYBER_PIN } },
  'x6_cell carry': { ok: true, exact: true, scalars: 1329, recovered: 1329, dropped: 10 },
  'x6_cell cord': { ok: true, started: true, skill: 'c'.repeat(64), head: 'b'.repeat(64), tick: 1013, generation: 3, kept: 3 },
  'x6_cell compile_and_run': { ok: true, result: { sum: 5 }, compilerFuelUsed: 11_600_000 },
  'x6_cloudflare': { ok: true, level: 'open', brokerConfigured: true, accountConfigured: true },
  'x6_linear': { ok: true, level: 'open', configured: true },
  'x6_exec': { ok: true, action: 'exec_runs', runs: [] },
  // A healthy body with one runnable mounted tool, registered (GREEN_TOOLS) and found by the index (its own lookup
  // answers ok), so tools-callable has something to check; with none it is skipped, never a pass.
  'x6_tools': { ok: true, tier: 'T1', count: 1, mounted: [{ name: 'adder', tool: 'x6t_adder', runnable: true }], proposals: [] },
  'x6_voice_status': { switch: 'off', keyInUse: null, failures: [] },
  'x6_capability_index': { counts: { tools: SELF_CHECK_BUILTINS.length,
    readOnlyTools: 12, mutatingTools: SELF_CHECK_BUILTINS.length - 12 } },
  // A lookup is answered by name; only x6t_adder is indexed, any other name is NO_SUCH_SURFACE.
  'x6_capability_index lookup x6t_adder': { ok: true, kind: 'tool' },
  'x6_threads': { ok: true, total: 3, threads: [{}, {}, {}] },
  'consult': { nucleus: { decision: 1, reasons: ['NO_ENTRY_CHANGED'], escalate: 1,
    reflex: TOUCH_ID_TIER_REFLEX_DIGEST, row: 1 }, facts: [] },
}
const GREEN_TOOLS: readonly string[] = [...SELF_CHECK_BUILTINS, 'x6t_adder']
function body(change: Answers = {}, options: { tools?: readonly string[]; journalGrows?: boolean; limits?: SelfCheckDeps['limits'] } = {}) {
  const answers = { ...GREEN, ...change }
  const calls: string[] = []
  let journal = { calls: 10, root: 1 }
  const value = (key: string): unknown => {
    const answer = answers[key]
    if (answer instanceof Error) throw answer
    return structuredClone(answer)
  }
  const deps: SelfCheckDeps = {
    sourceRevision: REV,
    toolNames: () => options.tools ?? GREEN_TOOLS,
    now: () => Date.now(),
    ...(options.limits ? { limits: options.limits } : {}),
    callTool: (name, args) => {
      const key = name === 'x6_cell'
        ? ['x6_cell', args.action, args.action === 'compute' ? args.cell : undefined].filter(Boolean).join(' ')
        : name === 'x6_capability_index' && args.action === 'lookup' ? `x6_capability_index lookup ${String(args.name)}` : name
      calls.push(key)
      if (key.startsWith('x6_capability_index lookup ') && !Object.hasOwn(answers, key)) {
        return Promise.resolve({ ok: false, code: 'NO_SUCH_SURFACE' })
      }
      if (key === 'x6_cell journal') {
        return Promise.resolve({ ok: true, totals: { calls: journal.calls },
          rootSha256: createHash('sha256').update(String(journal.root)).digest('hex') })
      }
      if (key.startsWith('x6_cell compute') && options.journalGrows !== false) {
        journal = { calls: journal.calls + 1, root: journal.root + 1 }
      }
      return Promise.resolve(value(key))
    },
    consultShadow: () => Promise.resolve(value('consult')),
  }
  return { deps, calls }
}
const rowOf = async (id: string, change: Answers = {}, options: Parameters<typeof body>[1] = {}) => {
  const answer = await runSelfCheck({}, body(change, options).deps)
  return (answer.rows as Array<{ id: string; ok: boolean | null; detail: string }>).find(row => row.id === id)
}

describe('each probe is red when its one fact is false', () => {
  it('a made-up healthy body is green in every row', async () => {
    const answer = await runSelfCheck({}, body().deps)
    expect(answer.summary).toEqual({ pass: PROBE_IDS.length, fail: 0, skipped: 0 })
    expect((answer.rows as J[]).find(row => row.id === 'self-state')?.detail)
      .toBe('2 organs, 1 differ from her store, 27 cells, 0 forged, 0 unknown')
    expect((answer.rows as J[]).find(row => row.id === 'voice')?.detail).toBe('switch off, key none, newest failure none')
  })

  it.each([
    ['build', { x6_self_state: { ...GREEN.x6_self_state as J, edge: { sourceRevision: '4'.repeat(40) } } },
      `DIFFERENT: runtime ${REV.slice(0, 12)}, edge 444444444444`],
    ['build', { x6_self_state: { ...GREEN.x6_self_state as J, edge: { sourceRevision: null },
      unknown: [{ field: 'edge.sourceRevision', reason: 'unreachable' }] } },
    `UNKNOWN: runtime ${REV.slice(0, 12)}, edge unknown (unreachable)`],
    ['cells-pinned', { 'x6_cell list': { ok: true, cells: [{ cell: 'nucleus' }] } },
      `DIFFERENT: 1 cells, ${String(Object.keys(CELL_PINS).length)} pins`],
    ['cell-nucleus', { 'x6_cell compute nucleus': { ok: true, result: { decision: 0, escalate: 0, row: 3 } } },
      'WRONG_ANSWER: decision 0, escalate 0, row 3 (want decision 1, escalate 1, row 3)'],
    ['cell-nucleus', { 'x6_cell compute nucleus': { ok: false, code: 'PIN_MISMATCH' } }, 'REFUSED: PIN_MISMATCH'],
    ['cell-kyber', { 'x6_cell compute kyber-cpu': { ok: true, result: { halted: 1, state: { a: 6 }, stepsTaken: 24 } } },
      'WRONG_ANSWER: halted 1, state.a 6, stepsTaken 24 (want halted 1, state.a 7, stepsTaken 24)'],
    ['skill-countdown', { x6_skill: { ok: false, id: COUNTDOWN_ID, cases: { total: 16, agree: 15, differ: [3] },
      code: 'SKILL_CASES_DIFFER' } }, `WRONG_ANSWER: 15 of 16 cases agree, skill ${COUNTDOWN_ID.slice(0, 12)}`],
    ['two-hosts', { 'x6_cell handoff': { ...GREEN['x6_cell handoff'] as J, same: false } },
      `DIFFERENT: browser ${KYBER_PIN?.slice(0, 12)}, edge ${KYBER_PIN?.slice(0, 12)}`],
    ['two-hosts', { 'x6_cell handoff': { ok: false, same: null, code: 'EDGE_UNREACHABLE' } }, 'EDGE_UNREACHABLE'],
    ['pentora-carry', { 'x6_cell carry': { ...GREEN['x6_cell carry'] as J, exact: false } },
      'WRONG_ANSWER: 1329 of 1329 recovered, 10 packets dropped'],
    ['cord-status', { 'x6_cell cord': { ok: false, code: 'CORD_STORE_INVALID' } }, 'REFUSED: CORD_STORE_INVALID'],
    ['cord-status', { 'x6_cell cord': { ...GREEN['x6_cell cord'] as J, tick: -1 } }, 'WRONG_ANSWER: ANSWER_INVALID'],
    ['cell-compile', { 'x6_cell compile_and_run': { ok: true, result: { sum: 6 } } }, 'WRONG_ANSWER: sum 6 (want 5)'],
    ['cell-compile', { 'x6_cell compile_and_run': { ok: false, code: 'SKILL_COMPILE_FAILED' } }, 'REFUSED: SKILL_COMPILE_FAILED'],
    ['self-state', { x6_self_state: Object.fromEntries(Object.entries(GREEN.x6_self_state as J).filter(([key]) => key !== 'forgedCells')) },
      'ABSENT: forgedCells'],
    ['nucleus-shadow', { consult: { nucleus: { consult: null, reason: 'TIMEOUT' }, facts: [] } }, /^TIMEOUT after \d+ ms$/],
    ['nucleus-shadow', { consult: { nucleus: { decision: 1, escalate: 1, reflex: 'f'.repeat(64) } } },
      'WRONG_REFLEX: consult ffffffffffff'],
    ['nucleus-shadow', { x6_self_state: { ...GREEN.x6_self_state as J, nucleusShadow: { reflex: 'e'.repeat(64) } } },
      'WRONG_REFLEX: tally eeeeeeeeeeee'],
    ['nucleus-shadow', { consult: { nucleus: { decision: 256, escalate: 0, reflex: TOUCH_ID_TIER_REFLEX_DIGEST } } },
      /^WRONG_ANSWER: decision 256 \(T1\)/],
    ['door-cloudflare', { x6_cloudflare: { ok: true, level: 'open', brokerConfigured: false, accountConfigured: true } },
      'NOT_CONFIGURED: level open, missing brokerConfigured'],
    ['door-cloudflare', { x6_cloudflare: { ok: false, code: 'OWNER_ACCESS_REQUIRED' } }, 'READ_FAILED: OWNER_ACCESS_REQUIRED'],
    ['door-linear', { x6_linear: { ok: true, action: 'status', level: 'open', configured: false, missing: 'LINEAR_API_KEY' } },
      'NOT_CONFIGURED: level open, missing LINEAR_API_KEY'],
    ['exec-list', { x6_exec: { ok: false, code: 'OWNER_SESSION_REQUIRED' } }, 'READ_FAILED: OWNER_SESSION_REQUIRED'],
    ['exec-list', { x6_exec: { ok: true, action: 'exec_runs' } }, 'READ_FAILED: ANSWER_INVALID'],
    // Her own tools, read from /dsh/home/tools/ only.
    ['tools-list', { x6_tools: { ok: false, code: 'TOOL_ACTION_INVALID' } }, 'READ_FAILED: TOOL_ACTION_INVALID'],
    ['tools-list', { x6_tools: { ok: true, mounted: [] } }, 'READ_FAILED: ANSWER_INVALID'],
    ['tools-list', { x6_tools: { ok: true, mounted: [], proposals: [], unreadable: ['adder'] } }, 'UNREADABLE: 0 mounted, 0 proposals, 1 unreadable'],
    // The list says mounted and runnable, and the model cannot call it.
    ['tools-callable', { x6_tools: { ok: false, code: 'TOOL_ACTION_INVALID' } }, 'READ_FAILED: TOOL_ACTION_INVALID'],
    ['tools-callable', { x6_tools: { ok: true, mounted: [{ name: 'ghost', tool: 'x6t_ghost', runnable: true }], proposals: [] } },
      'NOT_CALLABLE: x6t_ghost (NOT registered, NOT indexed); 0 of 1 runnable tools callable'],
    ['voice', { x6_voice_status: { switch: 'on', keyInUse: null, failures: [] } }, 'KEY_MISSING: switch on, key none, newest failure none'],
    ['voice', { x6_voice_status: { ok: false, code: 'OWNER_ACCESS_REQUIRED' } }, 'READ_FAILED: OWNER_ACCESS_REQUIRED'],
    ['capability-index', { x6_capability_index: { ok: false, code: 'X' } }, 'READ_FAILED: X'],
    ['threads', { x6_threads: { ok: false, code: 'THREADS_READ_FAILED' } }, 'READ_FAILED: THREADS_READ_FAILED'],
  ] as Array<[string, Answers, string | RegExp]>)('%s fails: %#', async (id, change, detail) => {
    const row = await rowOf(id, change)
    expect(row?.ok).toBe(false)
    if (typeof detail === 'string') expect(row?.detail).toBe(detail)
    else expect(row?.detail).toMatch(detail)
  })

  it('tools: a built-in that is not registered fails the row and names it; its probe is skipped, never passed', async () => {
    const answer = await runSelfCheck({}, body({}, { tools: GREEN_TOOLS.filter(name => name !== 'x6_linear') }).deps)
    const rows = answer.rows as Array<{ id: string; ok: boolean | null; detail: string; ms: number }>
    expect(rows.find(row => row.id === 'tools')).toMatchObject({ ok: false, detail: 'MISSING 1: x6_linear' })
    expect(rows.find(row => row.id === 'door-linear')).toEqual({ id: 'door-linear', ok: null, ms: 0, detail: 'NOT_REGISTERED: x6_linear' })
    expect(answer).toMatchObject({ ok: false, summary: { pass: PROBE_IDS.length - 2, fail: 1, skipped: 1 } })
  })

  it('tools-callable: green only when every runnable mounted tool is both registered and indexed', async () => {
    const adder = { x6_tools: { ok: true, mounted: [{ name: 'adder', tool: 'x6t_adder', runnable: true },
      { name: 'old', tool: 'x6t_old', runnable: false, code: 'TOOL_HANDLER_CHANGED' }], proposals: [] } }
    const withTool = [...SELF_CHECK_BUILTINS, 'x6t_adder']
    expect(await rowOf('tools-callable', adder, { tools: withTool }))
      .toMatchObject({ ok: true, detail: '1 of 1 runnable tools callable, 1 held (not runnable, see tools-list)' })
    // Her failure: the list says mounted, the index says no such surface.
    const unindexed = { ...adder, 'x6_capability_index lookup x6t_adder': { ok: false, code: 'NO_SUCH_SURFACE' } }
    expect(await rowOf('tools-callable', unindexed, { tools: withTool }))
      .toMatchObject({ ok: false, detail: 'NOT_CALLABLE: x6t_adder (registered, NOT indexed); 0 of 1 runnable tools callable, 1 held (not runnable, see tools-list)' })
    expect(await rowOf('tools-callable', adder, { tools: SELF_CHECK_BUILTINS }))
      .toMatchObject({ ok: false, detail: 'NOT_CALLABLE: x6t_adder (NOT registered, indexed); 0 of 1 runnable tools callable, 1 held (not runnable, see tools-list)' })
    const skipped = await runSelfCheck({ only: ['tools-callable'] }, body({}, { tools: SELF_CHECK_BUILTINS.filter(name => name !== 'x6_capability_index') }).deps)
    expect(skipped.rows).toEqual([{ id: 'tools-callable', ok: null, ms: 0, detail: 'NOT_REGISTERED: x6_capability_index' }])
  })

  it('tools-callable: no runnable mounted tool is nothing to check, so the row is skipped (ok null), never a pass', async () => {
    const none = await runSelfCheck({ only: ['tools-callable'] }, body({ x6_tools: { ok: true, mounted: [], proposals: [] } }).deps)
    const brief = (rows: unknown) => (rows as J[]).map(row => [row.id, row.ok, row.detail])
    expect(brief(none.rows)).toEqual([['tools-callable', null, 'no mounted tools: nothing to check']])
    expect(none).toMatchObject({ ok: true, summary: { pass: 0, fail: 0, skipped: 1 } })
    const held = await runSelfCheck({ only: ['tools-callable'] }, body({ x6_tools: { ok: true, proposals: [],
      mounted: [{ name: 'old', tool: 'x6t_old', runnable: false, code: 'TOOL_HANDLER_CHANGED' }] } }).deps)
    expect(brief(held.rows)).toEqual([['tools-callable', null, 'no runnable mounted tools: nothing to check, 1 held (not runnable, see tools-list)']])
    expect(held.summary).toEqual({ pass: 0, fail: 0, skipped: 1 })
    // In a whole run it is counted with the skipped rows, and a body with nothing else wrong is still ok (review MUST).
    const empty = { x6_tools: { ok: true, mounted: [], proposals: [] } }
    const all = await runSelfCheck({}, body(empty).deps)
    expect(all).toMatchObject({ ok: true, summary: { pass: PROBE_IDS.length - 1, fail: 0, skipped: 1 } })
    // A NOT_REGISTERED skip beside it still makes the check not ok, exactly as before.
    const unregistered = await runSelfCheck({ only: ['threads', 'tools-callable'] },
      body(empty, { tools: GREEN_TOOLS.filter(name => name !== 'x6_threads') }).deps)
    expect(unregistered).toMatchObject({ ok: false, summary: { pass: 0, fail: 0, skipped: 2 } })
    expect(brief(unregistered.rows))
      .toEqual([['threads', null, 'NOT_REGISTERED: x6_threads'], ['tools-callable', null, 'no mounted tools: nothing to check']])
    // So does a failed row beside it.
    const failed = await runSelfCheck({}, body({ ...empty, x6_threads: { ok: false, code: 'THREADS_READ_FAILED' } }).deps)
    expect(failed).toMatchObject({ ok: false, summary: { pass: PROBE_IDS.length - 2, fail: 1, skipped: 1 } })
    // A CALL_DEADLINE skip is not an empty skip either: alone, it is not ok.
    const late = await runSelfCheck({ only: ['tools-callable'] }, body(empty, { limits: { callMs: 0 } }).deps)
    expect(brief(late.rows)).toEqual([['tools-callable', null, 'CALL_DEADLINE: the whole check is bounded to 60 s']])
    expect(late).toMatchObject({ ok: false, summary: { pass: 0, fail: 0, skipped: 1 } })
  })

  it('tools-callable: the index answers ok only for the tool looked up, so a wrong name is never indexed', async () => {
    const { deps } = body()
    const signal = new AbortController().signal
    expect(await deps.callTool('x6_capability_index', { action: 'lookup', name: 'x6t_adder' }, signal)).toMatchObject({ ok: true })
    expect(await deps.callTool('x6_capability_index', { action: 'lookup', name: 'x6t_other' }, signal)).toEqual({ ok: false, code: 'NO_SUCH_SURFACE' })
    // A registered, runnable tool that the index does not know is NOT indexed, whatever the snapshot says.
    const other = { x6_tools: { ok: true, mounted: [{ name: 'other', tool: 'x6t_other', runnable: true }], proposals: [] } }
    expect(await rowOf('tools-callable', other, { tools: [...SELF_CHECK_BUILTINS, 'x6t_other'] }))
      .toMatchObject({ ok: false, detail: 'NOT_CALLABLE: x6t_other (registered, NOT indexed); 0 of 1 runnable tools callable' })
  })

  it('cell-journal: calls that leave no journal line fail', async () => {
    expect(await rowOf('cell-journal', {}, { journalGrows: false }))
      .toMatchObject({ ok: false, detail: 'NOT_RECORDED: calls 10 to 10 (+0), root unchanged' })
  })

  it.each([
    ['cell-kyber', 'x6_cell'], ['skill-countdown', 'x6_skill'], ['two-hosts', 'x6_cell'], ['pentora-carry', 'x6_cell'], ['cord-status', 'x6_cell'],
  ])('%s skips an absent tool and reports only the first line when its execute throws', async (id, tool) => {
    const missing = body({}, { tools: SELF_CHECK_BUILTINS.filter(name => name !== tool) })
    const skipped = await runSelfCheck({ only: [id] }, missing.deps)
    expect(skipped.rows).toEqual([{ id, ok: null, ms: 0, detail: `NOT_REGISTERED: ${tool}` }])
    expect(missing.calls).toEqual([])
    const thrown = await runSelfCheck({ only: [id] }, { ...body().deps,
      callTool: () => Promise.reject(new Error('first line\nsecond line')) })
    expect(thrown.rows).toEqual([{ id, ok: false, ms: expect.any(Number), detail: 'THREW: first line' }])
  })

  it('voice: a runtime part is reported, its level and newest code', async () => {
    const row = await rowOf('voice', { x6_voice_status: { switch: 'on', keyInUse: 'ELEVENLABS_API_KEY', failures: [],
      runtime: { level: 'open', codes: [{ code: 'TURN_OK' }, { code: 'MIC_DENIED' }] } } })
    expect(row).toMatchObject({ ok: true,
      detail: 'switch on, key ELEVENLABS_API_KEY, newest failure none, runtime level open, newest code MIC_DENIED' })
  })
})

describe('the runner', () => {
  it('carry gets 20 s while other probes get 5 s; the test override can shorten either', async () => {
    vi.useFakeTimers()
    const deps: SelfCheckDeps = { ...body().deps, callTool: () => new Promise(() => {}) }
    const ordinary = runSelfCheck({ only: ['cell-kyber'] }, deps)
    await vi.advanceTimersByTimeAsync(5000)
    expect((await ordinary).rows).toEqual([
      { id: 'cell-kyber', ok: false, ms: 5000, detail: 'TIMEOUT: no answer within 5000 ms' },
    ])
    let settled = false
    const carry = runSelfCheck({ only: ['pentora-carry'] }, deps).then((answer) => { settled = true; return answer })
    await vi.advanceTimersByTimeAsync(5000)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(15_000)
    expect((await carry).rows).toEqual([
      { id: 'pentora-carry', ok: false, ms: 20_000, detail: 'TIMEOUT: no answer within 20000 ms' },
    ])
    const shortened = runSelfCheck({ only: ['pentora-carry'] }, { ...deps, limits: { probeMs: 50 } })
    await vi.advanceTimersByTimeAsync(50)
    expect((await shortened).rows).toEqual([
      { id: 'pentora-carry', ok: false, ms: 50, detail: 'TIMEOUT: no answer within 50 ms' },
    ])
  })

  it('only runs the named probes, in run order; cell-journal alone makes its own two cell calls; a wrong id is refused', async () => {
    const { deps, calls } = body()
    const answer = await runSelfCheck({ only: ['voice', 'build'] }, deps)
    expect((answer.rows as J[]).map(row => row.id)).toEqual(['build', 'voice'])
    expect(calls).toEqual(['x6_self_state', 'x6_voice_status'])
    const alone = body()
    const journal = await runSelfCheck({ only: ['cell-journal'] }, alone.deps)
    expect(journal.summary).toEqual({ pass: 1, fail: 0, skipped: 0 })
    expect(alone.calls).toEqual(['x6_cell journal', 'x6_cell compute nucleus', 'x6_cell compute kyber-cpu', 'x6_cell journal'])
    // In a whole run cell-nucleus and cell-kyber supply both calls; the journal makes no extra compute.
    const whole = body()
    await runSelfCheck({}, whole.deps)
    expect(whole.calls.filter(call => call.startsWith('x6_cell compute'))).toEqual([
      'x6_cell compute nucleus', 'x6_cell compute kyber-cpu',
    ])
    // The whole run reads x6_self_state once and shares it between build, self-state and nucleus-shadow.
    expect(whole.calls.filter(call => call === 'x6_self_state')).toHaveLength(1)
    for (const only of [[], ['nope'], 'build', [1], [...PROBE_IDS, 'build']]) {
      await expect(runSelfCheck({ only }, body().deps)).rejects.toThrow(/^SELF_CHECK_ONLY_INVALID/)
    }
  })

  it('a probe that hangs is TIMEOUT, one that throws is a fail with its first line, and the rest still run', async () => {
    const probes: SelfCheckProbe[] = [
      { id: 'hangs', what: 'never answers', needs: [], run: () => new Promise(() => {}) },
      { id: 'throws', what: 'throws', needs: [], run: () => Promise.reject(new Error('first line\nsecond line sk-abcdefghijklmnop')) },
      { id: 'after', what: 'answers', needs: [], run: () => Promise.resolve({ ok: true, detail: 'fine' }) },
      { id: 'needs', what: 'needs a tool', needs: ['x6_missing'], run: () => Promise.resolve({ ok: true, detail: 'never' }) },
    ]
    const answer = await runSelfCheck({}, { ...body({}, { limits: { probeMs: 50 } }).deps }, probes)
    expect((answer.rows as J[]).map(row => [row.id, row.ok, row.detail])).toEqual([
      ['hangs', false, 'TIMEOUT: no answer within 50 ms'],
      ['throws', false, 'THREW: first line'],
      ['after', true, 'fine'],
      ['needs', null, 'NOT_REGISTERED: x6_missing'],
    ])
    expect(answer).toMatchObject({ ok: false, summary: { pass: 1, fail: 2, skipped: 1 } })
  })

  it('a probe stopped by TIMEOUT is stopped: it may not call again, under any probe\'s signal or after the answer, '
    + 'and every signal it was given is aborted', async () => {
    const { deps, calls } = body({}, { limits: { probeMs: 50 } })
    const signals: Array<[string, AbortSignal]> = []
    const inner = deps.callTool
    const spied: SelfCheckDeps = { ...deps,
      callTool: (name, args, signal) => { signals.push([name, signal]); return inner(name, args, signal) } }
    const late: Record<string, string> = {}
    let woke!: () => void
    const awake = new Promise<void>((resolve) => { woke = resolve })
    const attempt = async (key: string, run: () => Promise<unknown>): Promise<void> => {
      try { await run(); late[key] = 'answered' } catch (error) { late[key] = error instanceof Error ? error.message : String(error) }
    }
    const probes: SelfCheckProbe[] = [
      { id: 'stalls', what: 'wakes after its bound and tries again', needs: [], async run(context) {
        await context.call('x6_threads', { action: 'list' })
        await new Promise(resolve => setTimeout(resolve, 60))
        await attempt('call', () => context.call('x6_cell', { action: 'list' }))
        await attempt('selfState', () => context.selfState())
        await attempt('consult', () => context.consultShadow({}, {}, {}))
        context.cellCalls += 5
        woke()
        return { ok: true, detail: 'too late' }
      } },
      { id: 'next', what: 'runs while the stalled one wakes', needs: [], async run(context) {
        await awake
        return { ok: true, detail: `cellCalls ${String(context.cellCalls)}` }
      } },
    ]
    const answer = await runSelfCheck({}, spied, probes)
    await awake
    expect((answer.rows as J[]).map(row => [row.id, row.ok, row.detail])).toEqual([
      ['stalls', false, 'TIMEOUT: no answer within 50 ms'],
      ['next', true, 'cellCalls 0'],
    ])
    // Only the call it made inside its bound reached her registry; the late ones were refused before they left.
    expect(calls).toEqual(['x6_threads'])
    expect(Object.keys(late)).toEqual(['call', 'selfState', 'consult'])
    for (const outcome of Object.values(late)) expect(outcome).toMatch(/^TIMEOUT/)
    expect(signals.every(([, signal]) => signal.aborted)).toBe(true)
    // A whole run leaves no signal it handed out (journal read, shared self-state read, each probe) un-aborted.
    const whole = body()
    const handed: AbortSignal[] = []
    await runSelfCheck({}, { ...whole.deps,
      callTool: (name, args, signal) => { handed.push(signal); return whole.deps.callTool(name, args, signal) } })
    expect(handed.length).toBeGreaterThan(10)
    expect(handed.every(signal => signal.aborted)).toBe(true)
  })

  it('the whole call is bounded: a probe with no time left is skipped with CALL_DEADLINE', async () => {
    const probes: SelfCheckProbe[] = [
      { id: 'slow', what: 'takes the time', needs: [], run: () => new Promise(() => {}) },
      { id: 'late', what: 'no time left', needs: [], run: () => Promise.resolve({ ok: true, detail: 'never' }) },
    ]
    const answer = await runSelfCheck({}, body({}, { limits: { probeMs: 5000, callMs: 60 } }).deps, probes)
    expect((answer.rows as J[]).map(row => [row.id, row.ok, String(row.detail)])).toEqual([
      ['slow', false, 'TIMEOUT: no answer within 60 ms'],
      ['late', null, 'CALL_DEADLINE: the whole check is bounded to 60 s'],
    ])
  })

  it('the answer is at most 8 KiB: details are cut to 160 characters, then shorter; secret shapes and her private '
    + 'room never leave', async () => {
    const long = (n: number): SelfCheckProbe => ({ id: `p${String(n)}`, what: 'long', needs: [],
      run: () => Promise.resolve({ ok: true, detail: 'word '.repeat(400) }) })
    const one = await runSelfCheck({}, body().deps, [long(0),
      { id: 'secret', what: 's', needs: [],
        run: () => Promise.resolve({ ok: false, detail: `key ${'a1'.repeat(30)} at /dsh/home/auma/private/x` }) },
      { id: 'secret2', what: 's', needs: [],
        run: () => Promise.resolve({ ok: false, detail: `key nsec1abcdefghij, ${'b2'.repeat(30)}` }) }])
    const rows = one.rows as Array<{ detail: string }>
    expect(rows[0]?.detail.length).toBe(SELF_CHECK_DETAIL_CHARS)
    expect(rows[1]?.detail).toBe('[withheld]')
    expect(rows[2]?.detail).toBe('key [withheld], [withheld]')
    const many = await runSelfCheck({}, body().deps, Array.from({ length: 64 }, (_unused, n) => long(n)))
    expect(new TextEncoder().encode(JSON.stringify(many)).byteLength).toBeLessThanOrEqual(SELF_CHECK_RESULT_BYTES)
    expect(many.summary).toEqual({ pass: 64, fail: 0, skipped: 0 })
    expect((many.rows as unknown[]).length).toBe(64)
  })
})
