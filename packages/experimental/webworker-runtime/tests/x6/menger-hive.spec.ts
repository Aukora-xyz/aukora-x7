/**
 * Split-body co-simulation and mid-run organ handover across the real browser cell host (`createCellHost`
 * on a Node worker) and the real Cloudflare Worker `/_host/cell-run` route (`deploy/cloudflare/src/worker.mjs`),
 * verified tick-by-tick against the single-host monolith and the independent TypeScript wave oracle (docs/auma/menger-hive.md).
 *
 * Honesty & zero privacy claims (`BLANKET.md`, `KNOWLEDGE-CALCULUS.md`, `ORGANISM-WIRING.md`):
 *   - Every tick executes a real UNBATCHED `POST /_host/cell-run` (`hive.step_organ`), with `statelessHttpEchoWordsPerCall: 24`
 *     disclosed alongside the 7-in / 7-out rank-factored boundary coupling and the one-time 24-word handover at `cut`.
 *   - `privacyClaim: false`: 8 ticks of 20 shared corner readings have full rank 160 (`blindDimsAt8: 0`) on both `"menger"`
 *     and `"plain"`; 4 ticks leave 80 blind dims (`twinAt4` verified through `menger-hive` on all 80 corner readings).
 *   - Local step bookkeeping vs lying-edge refusal: `tick` is a local step counter, while any tampered or replayed edge
 *     answer is refused immediately on the first differing tick with closed code `HIVE_SPLIT_MISMATCH` (`ok: false`).
 *   - Real organism wiring caveat (`organismWiring`): Auma's five-organ law cuts `mind-ledger` and `mind-checks`, leaving
 *     `16` live shared values and `4` sealed corners (`loop` is the real edge candidate).
 */
import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { Worker } from 'node:worker_threads'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { classifyActionIrreversibility } from '../../src/x6/ball-loader.ts'
import { classifyToolMutation } from '../../src/x6/capability-index.ts'
import {
  MENGER_FIELD,
  MENGER_TABLE_SHA256,
  MENGER_WIRINGS_DOC,
  MENGER_WIRINGS_SHA256,
} from '../../src/x6/menger-observe.ts'
import {
  MENGER_HIVE_CELL_NAME,
  MENGER_ORGANISM_WIRING_CAVEAT,
  mengerRun,
  type MengerRunDeps,
} from '../../src/x6/menger-run.ts'
import { voiceVerdict } from '../../src/x6/voice-read-only.ts'
import {
  admitCell,
  CELL_BROWSER_FUEL_CAP,
  CELL_PINS,
  cellCanonicalJson,
  createCellHost,
  inspectWasmMemory,
  METERED_CELL_EXPORTS,
  type CellHost,
  type CellWorker,
} from '../../src/x6/wasm-cells.ts'

vi.mock('../../../../../apps/web/public/cells/menger-hive.wasm', async () => {
  const { readFile: read } = await import('node:fs/promises')
  return { default: new WebAssembly.Module(await read(new URL('../../../../../apps/web/public/cells/menger-hive.wasm', import.meta.url))) }
})

type J = Record<string, unknown>
const REPO = new URL('../../../../../', import.meta.url)
const CELLS = new URL('apps/web/public/cells/', REPO)
const ORIGIN = 'https://menger-hive.example.invalid'
const PIN = CELL_PINS[MENGER_HIVE_CELL_NAME]!
const OWNER = { type: 'owner', email: 'owner@example.invalid', expires: Math.floor(Date.now() / 1000) + 3600 }
const sha = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex')

// ---------- browser cell host on a Node worker ----------
const served = async (url: URL): Promise<Response> => {
  try { return new Response(new Uint8Array(await readFile(new URL(url.pathname.slice('/cells/'.length), CELLS)))) }
  catch { return new Response('no', { status: 404 }) }
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
    listen(onMessage, onFailure) {
      worker.on('message', onMessage)
      worker.on('error', onFailure)
      worker.on('messageerror', onFailure)
    },
    postMessage: (message) => { worker.postMessage(message) },
    async terminate() {
      await worker.terminate()
      worker.removeAllListeners()
      workers.delete(worker)
    },
  }
}
const browserHost = (pins?: typeof CELL_PINS): CellHost => {
  const fetchImpl: typeof fetch = async (input) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    return served(new URL(href))
  }
  const host = createCellHost({ origin: ORIGIN, fetchImpl, createWorker: nodeCellWorker, now: () => 0, ...(pins ? { pins } : {}) })
  hosts.add(host)
  return host
}
afterEach(async () => {
  vi.restoreAllMocks()
  try { await Promise.all([...hosts].map(host => host.dispose())) }
  finally {
    hosts.clear()
    await Promise.all([...workers].map(worker => worker.terminate()))
    workers.clear()
  }
})

// ---------- the real Cloudflare Worker `/_host/cell-run` route ----------
async function createEdge() {
  const { createWorker } = await import(new URL('deploy/cloudflare/src/worker.mjs', REPO).href) as {
    createWorker: (options: { verifyAccess: () => Promise<unknown> }) => {
      fetch: (request: Request, env: unknown) => Promise<Response>
    }
  }
  const touched: string[] = []
  const spy = (name: string): unknown => new Proxy({}, {
    get(_target, property) {
      touched.push(`${name}.${String(property)}`)
      return () => { throw new Error(`${name} called`) }
    },
  })
  const env = {
    PUBLIC_HOST: new URL(ORIGIN).host,
    OWNER_EMAIL: OWNER.email,
    OWNER_PUBLIC_KEY_HEX: 'e'.repeat(64),
    HEAD: spy('HEAD'),
    MIRROR: spy('MIRROR'),
    VOICE_BRIDGE: spy('VOICE_BRIDGE'),
    ARCHIVE_BUCKET: spy('ARCHIVE_BUCKET'),
    ASSETS: spy('ASSETS'),
  }
  const worker = createWorker({ verifyAccess: async () => OWNER })
  const sent: J[] = []
  const bodies: number[] = []
  const post = async (body: Uint8Array | string): Promise<Response> => {
    const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body
    bodies.push(bytes.byteLength)
    sent.push(JSON.parse(new TextDecoder().decode(bytes)) as J)
    return await worker.fetch(new Request(`${ORIGIN}/_host/cell-run`, {
      method: 'POST',
      body: Uint8Array.from(bytes),
      headers: { 'content-type': 'application/json', origin: ORIGIN, 'sec-fetch-site': 'same-origin' },
    }), env)
  }
  return { post, sent, bodies, touched }
}
type Edge = Awaited<ReturnType<typeof createEdge>>
type EdgeTamper = { answer?: (body: J) => Promise<J> | J; throwErr?: true }

function depsOf(e: Edge, tamper: EdgeTamper = {}): MengerRunDeps {
  let clock = 100
  const fetchImpl: typeof fetch = async (input, init) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    if (url.pathname.startsWith('/cells/')) return await served(url)
    if (url.pathname !== '/_host/cell-run') return new Response('no', { status: 404 })
    if (tamper.throwErr) throw new Error('network down')
    const raw = new Uint8Array(await request.arrayBuffer())
    clock += 2
    const response = await e.post(raw)
    if (!tamper.answer) return response
    return Response.json(await tamper.answer(await response.json() as J), { status: response.status })
  }
  return { origin: ORIGIN, fetchImpl, now: () => { clock += 1; return clock } }
}

describe('menger-hive cell: admission facts, pin parity, and skillsmith rebuild', () => {
  it('zero imports, metered exports, fixed 4-page memory, integer-only WAT, and byte-identical skillsmith rebuild', async () => {
    const bytes = new Uint8Array(await readFile(new URL('menger-hive.wasm', CELLS)))
    expect([bytes.byteLength, sha(bytes)]).toEqual([PIN.bytes, PIN.sha256])
    expect(PIN.ops).toEqual(['hive.info', 'hive.step_monolith', 'hive.boundary', 'hive.step_organ', 'hive.step_body'])
    const module = await admitCell(MENGER_HIVE_CELL_NAME, PIN, bytes)
    expect(WebAssembly.Module.imports(module)).toEqual([])
    expect(WebAssembly.Module.exports(module).map(entry => entry.name).sort()).toEqual([...METERED_CELL_EXPORTS])
    expect(inspectWasmMemory(MENGER_HIVE_CELL_NAME, bytes, 4096)).toMatchObject({ initial: 4, maximum: 4 })

    const wat = await readFile(new URL('menger-hive.wat', CELLS), 'utf8')
    expect(wat).not.toMatch(/\bf(?:32|64)\b/u)
    expect(wat).not.toMatch(/\(import\b/u)
    expect(wat).toMatch(/\(memory \(export "memory"\) 4 4\)/u)

    const wiringsBytes = new Uint8Array(await readFile(new URL('menger/wirings.v1.json', CELLS)))
    expect(sha(wiringsBytes)).toBe(MENGER_WIRINGS_SHA256)
    expect(new TextDecoder().decode(wiringsBytes)).toBe(cellCanonicalJson(MENGER_WIRINGS_DOC))

    const { buildMengerHiveCell } = await import(new URL('server/menger-hive-cell.build.mjs', REPO).href) as {
      buildMengerHiveCell: () => {
        metered: Uint8Array
        maxCallFuel: number
        tableSha256: string
        wiringsSha256: string
        watCurrent: boolean
      }
    }
    const rebuilt = buildMengerHiveCell()
    expect(rebuilt.watCurrent).toBe(true)
    expect(sha(rebuilt.metered)).toBe(PIN.sha256)
    expect(rebuilt.tableSha256).toBe(MENGER_TABLE_SHA256)
    expect(rebuilt.wiringsSha256).toBe(MENGER_WIRINGS_SHA256)
    expect(rebuilt.maxCallFuel).toBeGreaterThan(0)
    expect(rebuilt.maxCallFuel * 2).toBeLessThanOrEqual(PIN.fuel)
    expect(PIN.fuel).toBeLessThanOrEqual(CELL_BROWSER_FUEL_CAP)
  }, 120_000)

  it('x6_cell description names all 30 pinned cells and all six hand-written integer WAT cells including menger-hive', async () => {
    const loader = await readFile(new URL('packages/experimental/webworker-runtime/src/x6/ball-loader.ts', REPO), 'utf8')
    const description = /name: 'x6_cell',\s+description:([\s\S]*?)\n      parameters:/u.exec(loader)?.[1] ?? ''
    const wat = (await readdir(CELLS)).filter(name => name.endsWith('.wat')).map(name => name.slice(0, -'.wat'.length)).sort()
    expect(wat).toEqual(['aura-focus', 'cord-echo', 'kyber-cpu', 'menger-hive', 'nucleus', 'pentora-codec'])
    expect(Object.keys(CELL_PINS)).toHaveLength(30)
    expect(description).toContain('30 pinned cells')
    expect(description).toContain('and six hand-written integer WAT')
    for (const name of wat) expect(description).toContain(`\`${name}\``)
  })
})

describe('split-body co-simulation & mid-run organ handover across browser and real edge route', () => {
  it('runs both menger and plain unbatched (48 live /_host/cell-run calls, handover 0 -> 1, solvedWithoutState, organism caveat)', async () => {
    const cells = browserHost()
    const e = await createEdge()
    const answer = await mengerRun(cells, { action: 'hive' }, depsOf(e))

    expect(answer).toMatchObject({
      ok: true,
      cell: 'menger-hive',
      tick: 24,
      privacyClaim: false,
      organismWiring: MENGER_ORGANISM_WIRING_CAVEAT,
      pins: { browser: PIN.sha256, edge: PIN.sha256 },
      tableSha256: MENGER_TABLE_SHA256,
      wiringsSha256: MENGER_WIRINGS_SHA256,
      plainMatchesMengerOnSplitAndHorizon: true,
      undetunedOneCornerWaveReach: { menger: 20, plain: 80 },
    })
    expect(answer.organismWiring.organs).toEqual(['mind', 'loop', 'aperture', 'ledger', 'checks'])
    expect(answer.organismWiring.cutPairs).toEqual(['mind-ledger', 'mind-checks'])
    expect(answer.organismWiring.liveSharedCorners).toBe(16)
    expect(answer.organismWiring.sealedCorners).toBe(4)
    expect(answer.organismWiring.edgeCandidateOrgan).toBe('loop')

    // Unbatched proof: 24 ticks for "menger" + 24 ticks for "plain" = 48 individual POST /_host/cell-run requests!
    expect(e.sent).toHaveLength(48)
    expect(e.bodies.every(size => size <= 8192)).toBe(true)
    expect(e.touched).toEqual([])

    const mengerReqs = e.sent.slice(0, 24)
    const plainReqs = e.sent.slice(24, 48)
    for (const [label, reqs] of [['menger', mengerReqs], ['plain', plainReqs]] as const) {
      expect(reqs.every(r => r.cell === 'menger-hive' && r.op === 'hive.step_organ')).toBe(true)
      expect(reqs.map(r => (r.input as J).wiring)).toEqual(new Array(24).fill(label))
      expect(reqs.slice(0, 12).map(r => (r.input as J).organ)).toEqual(new Array(12).fill(0))
      expect(reqs.slice(12, 24).map(r => (r.input as J).organ)).toEqual(new Array(12).fill(1))
      for (const req of reqs) {
        const inp = req.input as { msgIn: number[]; organState: number[]; input: number }
        expect(inp.msgIn).toHaveLength(7)
        expect(inp.organState).toHaveLength(24)
        expect(inp.input).toBeGreaterThanOrEqual(1)
        expect(inp.input).toBeLessThan(MENGER_FIELD)
      }
    }

    for (const wiring of ['menger', 'plain'] as const) {
      const report = answer.runs[wiring]!
      expect(report).toMatchObject({
        wiring,
        tick: 24,
        ticks: 24,
        cut: 12,
        edgeOrgan: 0,
        handoverOrgan: 1,
        mismatchedTicks: 0,
        allDigestsEqual: true,
        wordsCrossed: {
          handoverOnceWords: 24,
          boundaryInPerTick: 7,
          boundaryOutPerTick: 7,
          boundaryTotalPerTick: 14,
          statelessHttpEchoWordsPerCall: 24,
        },
        liveEdge: {
          edgeCalls: 24,
        },
        observation: {
          horizonTicks: 8,
          blindDimsAt4: 80,
          blindDimsAt8: 0,
          knownAt8: {
            verified: true,
            solvedWithoutState: true,
          },
          twinAt4: {
            verified: true,
            identicalCornerReadings: 80,
          },
        },
      })
      expect(report.steps).toHaveLength(24)
      expect(report.steps.map(s => s.tick)).toEqual(Array.from({ length: 24 }, (_, idx) => idx + 1))
      expect(report.steps.slice(0, 12).map(s => s.organ)).toEqual(new Array(12).fill(0))
      expect(report.steps.slice(12, 24).map(s => s.organ)).toEqual(new Array(12).fill(1))
      expect(report.finalStateSha256).toMatch(/^[a-f0-9]{64}$/u)
      expect(report.observation.twinAt4.organ0PrivateSiteValueA)
        .not.toBe(report.observation.twinAt4.organ0PrivateSiteValueB)
    }
    expect(answer.runs.menger!.finalStateSha256).not.toBe(answer.runs.plain!.finalStateSha256)

    const journal = await cells.journal()
    // 1 hive.info + 2 * (8 + 3) twin-check monolith calls + 2 * 24 * 4 (monolith, boundary, edge, step_body) = 215 calls:
    expect(journal.totals.byCell['menger-hive']).toBe(215)
    expect(journal.totals.lost).toBe(0)
    const edgeLines = journal.lines.filter(line => line.caller === 'edge')
    expect(edgeLines).toHaveLength(8)
    expect(edgeLines[0]).toMatchObject({ caller: 'edge', cell: 'menger-hive', op: 'hive.step_organ', pin: PIN.sha256 })
  }, 120_000)

  it('supports single-wiring runs, arbitrary organ pairs (2 -> 4), and cut = 0 without handover words', async () => {
    const cells = browserHost()
    const e = await createEdge()

    const single = await mengerRun(cells, {
      action: 'hive',
      wiring: 'menger',
      ticks: 10,
      cut: 5,
      edgeOrgan: 2,
      handoverOrgan: 4,
      seed: 5,
    }, depsOf(e))
    expect(single.ok).toBe(true)
    expect(single.tick).toBe(10)
    expect(Object.keys(single.runs)).toEqual(['menger'])
    expect(single.runs.menger).toMatchObject({
      tick: 10,
      ticks: 10,
      cut: 5,
      edgeOrgan: 2,
      handoverOrgan: 4,
      mismatchedTicks: 0,
      allDigestsEqual: true,
      wordsCrossed: {
        handoverOnceWords: 24,
        boundaryInPerTick: 7,
        boundaryOutPerTick: 7,
        boundaryTotalPerTick: 14,
        statelessHttpEchoWordsPerCall: 24,
      },
      liveEdge: { edgeCalls: 10 },
    })
    expect(e.sent.slice(0, 5).map(r => (r.input as J).organ)).toEqual([2, 2, 2, 2, 2])
    expect(e.sent.slice(5, 10).map(r => (r.input as J).organ)).toEqual([4, 4, 4, 4, 4])

    const noHandover = await mengerRun(cells, {
      action: 'hive',
      wiring: 'plain',
      ticks: 6,
      cut: 0,
      edgeOrgan: 3,
      handoverOrgan: 1,
      seed: 9,
    }, depsOf(e))
    expect(noHandover.ok).toBe(true)
    expect(noHandover.tick).toBe(6)
    expect(noHandover.runs.plain).toMatchObject({
      tick: 6,
      ticks: 6,
      cut: 0,
      mismatchedTicks: 0,
      allDigestsEqual: true,
      wordsCrossed: { handoverOnceWords: 0 },
      liveEdge: { edgeCalls: 6 },
    })
    expect(e.sent.slice(10, 16).map(r => (r.input as J).organ)).toEqual([3, 3, 3, 3, 3, 3])
    expect(e.touched).toEqual([])
  }, 60_000)
})

describe('closed refusals, tamper detection, fuel, voice look-only, and frozen-path fence', () => {
  it('refuses invalid args closed before invoking any edge call, and catches tampered edge state, pin mismatch, unreachable edge, and fuel starvation', async () => {
    const cells = browserHost()
    const e = await createEdge()
    const deps = depsOf(e)

    const badCases: Array<[J, string]> = [
      [{ action: 'hive', extra: 1 }, 'HIVE_INPUT_INVALID'],
      [{ action: 'hive', ticks: 0 }, 'HIVE_TICKS_INVALID'],
      [{ action: 'hive', ticks: 129 }, 'HIVE_TICKS_INVALID'],
      [{ action: 'hive', ticks: 1.5 }, 'HIVE_TICKS_INVALID'],
      [{ action: 'hive', ticks: 8, cut: -1 }, 'HIVE_CUT_INVALID'],
      [{ action: 'hive', ticks: 8, cut: 9 }, 'HIVE_CUT_INVALID'],
      [{ action: 'hive', edgeOrgan: -1 }, 'HIVE_ORGAN_INVALID'],
      [{ action: 'hive', handoverOrgan: 5 }, 'HIVE_ORGAN_INVALID'],
      [{ action: 'hive', seed: -1 }, 'HIVE_SEED_INVALID'],
      [{ action: 'hive', wiring: 'torus' }, 'HIVE_WIRING_INVALID'],
    ]
    for (const [args, code] of badCases) {
      const res = await mengerRun(cells, args, deps)
      expect(res, code).toMatchObject({ ok: false, code, tick: 0, privacyClaim: false })
    }
    expect(await mengerRun(cells, { action: 'hive' }, { ...deps, origin: undefined }))
      .toMatchObject({ ok: false, code: 'HIVE_ORIGIN_UNAVAILABLE', tick: 0, privacyClaim: false })
    expect(e.sent).toHaveLength(0)

    // Both browser and edge refuse malformed cell inputs with identical closed codes:
    const badCellInput = { input: 1, msgIn: [0, 0, 0, 0, 0, 0, 0], organ: 5, organState: new Array(24).fill(0), wiring: 'menger' }
    const hereBad = await cells.invoke(MENGER_HIVE_CELL_NAME, 'hive.step_organ', badCellInput)
    const edgeBadRes = await e.post(JSON.stringify({ cell: 'menger-hive', op: 'hive.step_organ', input: badCellInput }))
    expect(hereBad).toMatchObject({ ok: false, code: 'HIVE_ORGAN_RANGE' })
    expect([edgeBadRes.status, ((await edgeBadRes.json()) as J).code]).toEqual([422, 'HIVE_ORGAN_RANGE'])

    // Edge pin mismatch is caught on the very first tick:
    const wrongPinAnswer = await mengerRun(cells, { action: 'hive', wiring: 'menger', ticks: 4 }, depsOf(e, {
      answer: body => ({ ...body, pin: 'a'.repeat(64) }),
    }))
    expect(wrongPinAnswer).toMatchObject({
      ok: false,
      code: 'HIVE_PIN_MISMATCH',
      pins: { browser: PIN.sha256, edge: 'a'.repeat(64) },
    })

    // Edge unreachable is caught and journaled as 'unanswered':
    const unreachable = await mengerRun(cells, { action: 'hive', wiring: 'menger', ticks: 4 }, depsOf(e, { throwErr: true }))
    expect(unreachable).toMatchObject({ ok: false, code: 'EDGE_UNREACHABLE', privacyClaim: false })
    expect((await cells.journal()).lines[0]).toMatchObject({
      caller: 'edge',
      cell: 'menger-hive',
      op: 'hive.step_organ',
      pin: 'unanswered',
    })

    // Tampered edge organState word is refused immediately on the first differing tick (`HIVE_SPLIT_MISMATCH`, `ok: false`):
    const eTamper = await createEdge()
    const tampered = await mengerRun(cells, { action: 'hive', wiring: 'menger', ticks: 3, cut: 0 }, depsOf(eTamper, {
      answer: (body) => {
        const result = body.result as { msgOut: number[]; nextOrganState: number[]; organSha256: string }
        const nextOrganState = [...result.nextOrganState]
        nextOrganState[0] = (nextOrganState[0]! + 1) % MENGER_FIELD
        return { ...body, result: { ...result, nextOrganState } }
      },
    }))
    expect(tampered).toMatchObject({
      ok: false,
      code: 'HIVE_SPLIT_MISMATCH',
      tick: 1,
      mismatch: { wiring: 'menger', tick: 1, organ: 0, stateEqual: false, digestsEqual: false },
      pins: { browser: PIN.sha256, edge: PIN.sha256 },
      runs: {},
    })
    expect(eTamper.sent).toHaveLength(1)

    // Replayed edge answer (tick 1's valid answer re-sent on tick 2) is refused immediately on tick 2 (`HIVE_SPLIT_MISMATCH`):
    const eReplay = await createEdge()
    let savedTick1Result: unknown = null
    const replayed = await mengerRun(cells, { action: 'hive', wiring: 'menger', ticks: 4, cut: 0 }, depsOf(eReplay, {
      answer: (body) => {
        if (savedTick1Result === null) {
          savedTick1Result = body.result
          return body
        }
        return { ...body, result: savedTick1Result }
      },
    }))
    expect(replayed).toMatchObject({
      ok: false,
      code: 'HIVE_SPLIT_MISMATCH',
      tick: 2,
      mismatch: { wiring: 'menger', tick: 2, organ: 0, stateEqual: false, digestsEqual: false },
      pins: { browser: PIN.sha256, edge: PIN.sha256 },
      runs: {},
    })
    expect(eReplay.sent).toHaveLength(2)

    // Starved browser fuel refuses cleanly with FUEL:
    const starved = browserHost({ ...CELL_PINS, 'menger-hive': { ...PIN, fuel: 5_000 } })
    expect(await mengerRun(starved, { action: 'hive', wiring: 'menger', ticks: 2 }, deps))
      .toMatchObject({ ok: false, code: 'FUEL', privacyClaim: false })
    expect(e.touched).toEqual([])
  }, 60_000)

  it('irreversibility is class 0, voice look-only refuses hive, capability index keeps hive non-read, and frozen-paths close cell + runner', async () => {
    expect(classifyActionIrreversibility({ tool: 'x6_cell', action: 'hive' })).toBe(0)
    expect(voiceVerdict({ tool: 'x6_cell', args: { action: 'hive' }, origin: { kind: 'builtin' } })).toContain('VOICE_LOOK_ONLY')
    const mutation = classifyToolMutation('x6_cell', [
      { name: 'action', type: 'string', required: true, enum: ['list', 'journal', 'cord', 'hive'] },
    ])
    expect(mutation.actions).toEqual({ read: ['journal', 'list'], write: ['cord', 'hive'] })

    const { isFrozenRepoPath, isOpenRepoPath } = await import(new URL('deploy/ci/frozen-paths.mjs', REPO).href) as {
      isFrozenRepoPath: (path: string) => boolean
      isOpenRepoPath: (path: string, status: string) => boolean
    }
    const { isFrozenRepoPath: uiIsFrozen, isOpenRepoPath: uiIsOpen } = await import(
      '../../../../client/ui-layout/src/client/spatial/aumlok/frozen-paths.ts',
    )
    for (const path of [
      'apps/web/public/cells/menger-hive.wasm',
      'apps/web/public/cells/menger-hive.wat',
      'apps/web/public/cells/menger/wirings.v1.json',
      'deploy/cloudflare/src/menger-hive-cell.mjs',
      'deploy/cloudflare/src/kyber-cell.mjs',
      'packages/experimental/webworker-runtime/src/x6/menger-run.ts',
      'packages/experimental/webworker-runtime/src/x6/menger-observe.ts',
    ]) {
      expect(isFrozenRepoPath(path) || !isOpenRepoPath(path, 'modified'), `ci frozen: ${path}`).toBe(true)
      expect(uiIsFrozen(path) || !uiIsOpen(path, 'modified'), `ui frozen: ${path}`).toBe(true)
    }
  })
})
