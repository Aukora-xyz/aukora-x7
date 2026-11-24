/**
 * Split-body co-simulation and mid-run organ handover (`x6_cell` action `"hive"`, docs/auma/menger-hive.md).
 *
 * For each requested wiring (`"menger"`, `"plain"`, or `"both"`), the 80-site detuned wave body (160 words mod 65,521)
 * is split across TWO hosts:
 *   - Browser (`wasm-cells.ts`): holds the 136-word `bodyState` (20 shared corners + 4 local organs' 48 private sites),
 *     runs `hive.boundary` -> 7 boundary words `msgToEdge`, and runs `hive.step_body` with the edge's 7 outgoing
 *     boundary words `msgOut`.
 *   - Edge (`POST /_host/cell-run`): executes `hive.step_organ` UNBATCHED once per tick (`0 .. ticks-1`) for the active
 *     edge organ (`edgeOrgan` on `0 .. cut-1`; at `cut`, `edgeOrgan`'s 24 words rejoin `bodyState` in the browser while
 *     `handoverOrgan`'s 24 words move to the edge for `cut .. ticks-1`).
 *
 * At EVERY tick, the reassembled 160-word split-body state and its WebCrypto `stateSha256` are compared against the
 * single-host `hive.step_monolith` Wasm execution and the independent TypeScript wave oracle. Any lying, tampered, or
 * replayed edge answer is refused immediately on the first differing tick with closed code `HIVE_SPLIT_MISMATCH` (`ok: false`).
 *
 * Honesty & zero privacy claims (`BLANKET.md`, `KNOWLEDGE-CALCULUS.md`, `ORGANISM-WIRING.md`):
 *   - `privacyClaim: false`: under the detuned wave law, 8 ticks of the 20 shared corner readings determine all 160
 *     state words (`blindDimsAt8: 0`, solved from `cornerReadings` and `inputs` alone with `state` omitted); at 4 ticks
 *     (`blindDimsAt4: 80`), a constructive reachable twin differs on organ 0's private site while producing all 80
 *     identical corner readings (verified through `hive.step_monolith`).
 *   - Local step bookkeeping vs lying-edge detection: `tick` is a local step counter (`hive.step_organ` answers carry
 *     neither `tick` nor `seq`, so `tick` alone is UNSUPPORTED as rewind detection); tampered or replayed edge answers
 *     are caught and refused immediately (`HIVE_SPLIT_MISMATCH`) by the per-tick monolith & digest comparison.
 *   - Plain parity & undetuned reach: with detuning off, the reach from corner 0 is `20` (`menger`) and `80` (`plain`)
 *     for these two particular constructions; with detuning on, as the cell runs, both reach `160`, and no claim is made
 *     about the cause.
 *   - Real organism wiring caveat (`organismWiring`): symmetric 20-corner Menger and Plain wire all 10 organ pairs;
 *     Auma's real five-organ law (`mind`, `loop`, `aperture`, `ledger`, `checks`) cuts `mind-ledger` and `mind-checks`,
 *     leaving 16 live shared values and 4 sealed corners, with `loop` as the real organ worth moving to the edge.
 *   - `statelessHttpEchoWordsPerCall: 24` is reported transparently alongside the 7-in / 7-out algebraic boundary rank,
 *     because `/_host/cell-run` is a stateless Worker route with zero server storage.
 * @module x6/menger-run
 */
import { CELL_PINS, cellCanonicalJson, type CellHost } from './wasm-cells.ts'
import {
  analyzeMengerWiring,
  joinMengerState,
  MENGER_FIELD,
  MENGER_HORIZON_TICKS,
  MENGER_TABLE_SHA256,
  MENGER_WIRINGS_DOC,
  MENGER_WIRINGS_SHA256,
  mengerObserve,
  splitMengerState,
  stepMengerWaveOracle,
  type MengerWiringName,
} from './menger-observe.ts'

export const MENGER_HIVE_CELL_NAME = 'menger-hive'
export const MENGER_HIVE_EDGE_PATH = '/_host/cell-run'
export const MENGER_HIVE_MAX_TICKS = 128
export const MENGER_HIVE_DEFAULT_TICKS = 24
export const MENGER_HIVE_EDGE_TIMEOUT_MS = 15_000
const ANSWER_MAX_BYTES = 64 * 1024
const CODE = /^[A-Z0-9_]{1,80}$/u
const SHA = /^[a-f0-9]{64}$/u
const ALLOWED_ARGS = new Set(['action', 'ticks', 'cut', 'edgeOrgan', 'handoverOrgan', 'seed', 'wiring'])

export interface MengerOrganismWiringCaveat {
  readonly organs: readonly ['mind', 'loop', 'aperture', 'ledger', 'checks']
  readonly cutPairs: readonly ['mind-ledger', 'mind-checks']
  readonly liveSharedCorners: 16
  readonly sealedCorners: 4
  readonly symmetricModelSharedCorners: 20
  readonly edgeCandidateOrgan: 'loop'
  readonly note: string
}

export const MENGER_ORGANISM_WIRING_CAVEAT: MengerOrganismWiringCaveat = Object.freeze({
  organs: Object.freeze(['mind', 'loop', 'aperture', 'ledger', 'checks'] as const),
  cutPairs: Object.freeze(['mind-ledger', 'mind-checks'] as const),
  liveSharedCorners: 16,
  sealedCorners: 4,
  symmetricModelSharedCorners: 20,
  edgeCandidateOrgan: 'loop',
  note: 'Symmetric Menger and Plain models wire all 10 organ pairs (20 shared corner words); '
    + 'Auma\'s real five-organ law (mind, loop, aperture, ledger, checks) cuts mind-ledger and mind-checks, '
    + 'leaving 16 live shared values and 4 sealed corners, with loop as the real organ worth moving to the edge.',
})

export interface MengerRunDeps {
  readonly origin: string | undefined
  readonly fetchImpl?: typeof fetch
  readonly now?: () => number
}

export interface MengerWordsCrossed {
  readonly handoverOnceWords: number
  readonly boundaryInPerTick: 7
  readonly boundaryOutPerTick: 7
  readonly boundaryTotalPerTick: 14
  readonly statelessHttpEchoWordsPerCall: 24
}

export interface MengerLiveEdgeMetrics {
  readonly edgeCalls: number
  readonly wallMs: number
  readonly ticksPerSecond: number
}

export interface MengerTwinAt4Report {
  readonly verified: boolean
  readonly organ0PrivateSiteValueA: number
  readonly organ0PrivateSiteValueB: number
  readonly identicalCornerReadings: number
}

export interface MengerObservationReport {
  readonly horizonTicks: 8
  readonly blindDimsAt4: number
  readonly blindDimsAt8: number
  readonly knownAt8: {
    readonly verified: boolean
    readonly solvedWithoutState: true
    readonly organ0PrivateSiteValue: number
  }
  readonly twinAt4: MengerTwinAt4Report
}

export interface MengerStepReading {
  /** Local 1-based step counter (bookkeeping only; lying or replayed edge answers are caught by `HIVE_SPLIT_MISMATCH`). */
  readonly tick: number
  readonly organ: number
  readonly corner0: number
  readonly stateSha256: string
}

export interface MengerSplitMismatchDetail {
  readonly wiring: MengerWiringName
  readonly tick: number
  readonly organ: number
  readonly stateEqual: boolean
  readonly digestsEqual: boolean
}

export interface MengerWiringRunReport {
  readonly wiring: MengerWiringName
  /** Local final step count (`ticks`). */
  readonly tick: number
  readonly ticks: number
  readonly cut: number
  readonly edgeOrgan: number
  readonly handoverOrgan: number
  readonly mismatchedTicks: 0
  readonly allDigestsEqual: true
  readonly finalStateSha256: string
  readonly steps: readonly MengerStepReading[]
  readonly wordsCrossed: MengerWordsCrossed
  readonly liveEdge: MengerLiveEdgeMetrics
  readonly observation: MengerObservationReport
}

export interface MengerRunAnswer {
  readonly ok: boolean
  readonly code?: string
  readonly mismatch?: MengerSplitMismatchDetail
  readonly cell: typeof MENGER_HIVE_CELL_NAME
  /** Local step counter at completion or refusal (local bookkeeping only; not an edge-signed sequence number). */
  readonly tick: number
  readonly privacyClaim: false
  readonly organismWiring: MengerOrganismWiringCaveat
  readonly pins: { readonly browser: string | null; readonly edge: string | null }
  readonly tableSha256: string | null
  readonly wiringsSha256: string | null
  readonly plainMatchesMengerOnSplitAndHorizon: boolean | null
  readonly undetunedOneCornerWaveReach: { readonly menger: number; readonly plain: number }
  readonly runs: Readonly<Partial<Record<MengerWiringName, MengerWiringRunReport>>>
}

const encoder = new TextEncoder()
const atNum = (arr: readonly number[], idx: number): number => arr[idx] ?? 0
const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)
const hexOf = (buf: ArrayBuffer): string => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('')
const sha256Bytes = async (bytes: Uint8Array): Promise<string> =>
  hexOf(await globalThis.crypto.subtle.digest('SHA-256', Uint8Array.from(bytes)))

export async function mengerWordsSha256(words: readonly number[]): Promise<string> {
  const bytes = new Uint8Array(words.length * 2)
  words.forEach((w, idx) => {
    bytes[2 * idx] = w & 255
    bytes[2 * idx + 1] = (w >>> 8) & 255
  })
  return sha256Bytes(bytes)
}

/** Deterministic integer stream in `1..65520` from `seed` (Mulberry32). */
function createSeedStream(seed: number): () => number {
  let state = (seed >>> 0) ^ 0x9e3779b9
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let z = Math.imul(state ^ (state >>> 15), 1 | state)
    z = (z + Math.imul(z ^ (z >>> 7), 61 | z)) ^ z
    const u = (z ^ (z >>> 14)) >>> 0
    return (u % (MENGER_FIELD - 1)) + 1
  }
}

async function readCapped(response: Response): Promise<string | null> {
  const reader = response.body?.getReader()
  if (!reader) return ''
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > ANSWER_MAX_BYTES) {
      await reader.cancel().catch(() => undefined)
      return null
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(size)
  let at = 0
  for (const chunk of chunks) {
    bytes.set(chunk, at)
    at += chunk.byteLength
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
}

interface EdgeOrganCallResult {
  readonly ok: true
  readonly edgePin: string
  readonly msgOut: readonly number[]
  readonly nextOrganState: readonly number[]
  readonly organSha256: string
}

interface EdgeOrganCallFailure {
  readonly ok: false
  readonly code: string
  readonly edgePin: string | null
}

async function callEdgeStepOrgan(
  cells: CellHost,
  deps: MengerRunDeps,
  expectedPin: string,
  input: {
    readonly input: number
    readonly msgIn: readonly number[]
    readonly organ: number
    readonly organState: readonly number[]
    readonly wiring: MengerWiringName
  },
): Promise<EdgeOrganCallResult | EdgeOrganCallFailure> {
  const body = encoder.encode(cellCanonicalJson({
    cell: MENGER_HIVE_CELL_NAME,
    input,
    op: 'hive.step_organ',
  }))
  const now = deps.now ?? (() => globalThis.performance.now())
  const started = now()
  let text: string | null = null
  let answer: unknown = null
  let code: string | null = null
  let response: Response | null = null
  try {
    response = await (deps.fetchImpl ?? globalThis.fetch)(new URL(MENGER_HIVE_EDGE_PATH, deps.origin).href, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      credentials: 'same-origin',
      signal: AbortSignal.timeout(MENGER_HIVE_EDGE_TIMEOUT_MS),
    })
  } catch {
    code = 'EDGE_UNREACHABLE'
  }
  if (response !== null) {
    try {
      text = await readCapped(response)
      if (text === null) code = 'EDGE_ANSWER_TOO_LARGE'
      else answer = JSON.parse(text)
    } catch {
      code = 'EDGE_ANSWER_INVALID'
    }
    if (code === null && !isRecord(answer)) code = 'EDGE_ANSWER_INVALID'
    else if (code === null && isRecord(answer) && answer.ok !== true) {
      code = typeof answer.code === 'string' && CODE.test(answer.code) ? answer.code : 'EDGE_REFUSED'
    } else if (code === null && isRecord(answer)
      && (typeof answer.pin !== 'string' || !SHA.test(answer.pin) || !Object.hasOwn(answer, 'result'))) {
      code = 'EDGE_ANSWER_INVALID'
    }
  }
  const edgePin = isRecord(answer) && typeof answer.pin === 'string' && SHA.test(answer.pin) ? answer.pin : null
  if (code === null && edgePin !== expectedPin) code = 'HIVE_PIN_MISMATCH'
  const fuelUsed = isRecord(answer) && Number.isSafeInteger(answer.fuelUsed) ? (answer.fuelUsed as number) : null
  cells.noteEdgeCall({
    cell: MENGER_HIVE_CELL_NAME,
    op: 'hive.step_organ',
    pin: edgePin ?? 'unanswered',
    request: body,
    answer: text,
    code,
    fuelUsed,
    ms: now() - started,
  })
  if (code !== null || !isRecord(answer) || !isRecord(answer.result) || edgePin === null) {
    return { ok: false, code: code ?? 'EDGE_ANSWER_INVALID', edgePin }
  }
  const res = answer.result
  if (!Array.isArray(res.msgOut) || res.msgOut.length !== 7
    || !Array.isArray(res.nextOrganState) || res.nextOrganState.length !== 24
    || typeof res.organSha256 !== 'string' || !SHA.test(res.organSha256)) {
    return { ok: false, code: 'EDGE_ANSWER_INVALID', edgePin }
  }
  return {
    ok: true,
    edgePin,
    msgOut: res.msgOut as number[],
    nextOrganState: res.nextOrganState as number[],
    organSha256: res.organSha256,
  }
}

async function verifyFourTickTwinViaCell(
  cells: CellHost,
  wiring: MengerWiringName,
  startState: readonly number[],
  inputs8: readonly number[],
): Promise<{ readonly ok: true; readonly observation: MengerObservationReport } | { readonly ok: false; readonly code: string }> {
  const analysis = analyzeMengerWiring(wiring)
  const readings8: number[][] = []
  let cur = [...startState]
  for (let t = 0; t < 8; t += 1) {
    readings8.push(cur.slice(0, 20))
    const step = await cells.invoke(MENGER_HIVE_CELL_NAME, 'hive.step_monolith', {
      input: atNum(inputs8, t),
      state: cur,
      wiring,
    }, 'x6_cell')
    if (!step.ok || !isRecord(step.result) || !Array.isArray(step.result.nextState)) {
      return { ok: false, code: step.ok ? 'HIVE_LOCAL_INVALID' : step.code }
    }
    cur = step.result.nextState as number[]
  }

  // 1. At T = 8: corners + inputs alone (with `state` OMITTED) determine organ 0's private word:
  const obs8 = mengerObserve({
    wiring,
    inputs: inputs8,
    cornerReadings: readings8,
    targetCoord: 20,
  })
  if (obs8.status !== 'KNOWN' || obs8.value !== atNum(startState, 20) || obs8.blindDims !== 0) {
    return { ok: false, code: 'HIVE_HORIZON_CHECK_FAILED' }
  }

  // 2. At T = 4: construct the reachable blind twin and verify all 80 corner readings through `hive.step_monolith`:
  const inputs4 = inputs8.slice(0, 4)
  const readings4 = readings8.slice(0, 4)
  const obs4 = mengerObserve({
    wiring,
    state: startState,
    inputs: inputs4,
    cornerReadings: readings4,
    targetCoord: 20,
  })
  if (obs4.status !== 'UNOBSERVABLE' || obs4.values.state === obs4.values.twin) {
    return { ok: false, code: 'HIVE_TWIN_CHECK_FAILED' }
  }

  let twinCur = [...obs4.twin]
  let identical = 0
  for (let t = 0; t < 4; t += 1) {
    const refCorners = readings4[t] ?? []
    for (let c = 0; c < 20; c += 1) {
      if (atNum(twinCur, c) === atNum(refCorners, c)) identical += 1
    }
    if (t < 3) {
      const twinStep = await cells.invoke(MENGER_HIVE_CELL_NAME, 'hive.step_monolith', {
        input: atNum(inputs4, t),
        state: twinCur,
        wiring,
      }, 'x6_cell')
      if (!twinStep.ok || !isRecord(twinStep.result) || !Array.isArray(twinStep.result.nextState)) {
        return { ok: false, code: twinStep.ok ? 'HIVE_LOCAL_INVALID' : twinStep.code }
      }
      twinCur = twinStep.result.nextState as number[]
    }
  }
  if (identical !== 80) return { ok: false, code: 'HIVE_TWIN_MISMATCH' }

  return {
    ok: true,
    observation: {
      horizonTicks: MENGER_HORIZON_TICKS,
      blindDimsAt4: analysis.blindDimsAt4,
      blindDimsAt8: analysis.blindDimsAt8,
      knownAt8: {
        verified: true,
        solvedWithoutState: true,
        organ0PrivateSiteValue: obs8.value,
      },
      twinAt4: {
        verified: true,
        organ0PrivateSiteValueA: obs4.values.state,
        organ0PrivateSiteValueB: obs4.values.twin,
        identicalCornerReadings: identical,
      },
    },
  }
}

/**
 * Execute `x6_cell { action: "hive", ticks?, cut?, edgeOrgan?, handoverOrgan?, seed?, wiring? }`.
 */
export async function mengerRun(
  cells: CellHost,
  args: Record<string, unknown>,
  deps: MengerRunDeps,
): Promise<MengerRunAnswer> {
  const mengerAnalysis = analyzeMengerWiring('menger')
  const plainAnalysis = analyzeMengerWiring('plain')
  const reachPair = {
    menger: mengerAnalysis.undetunedOneCornerWaveReach,
    plain: plainAnalysis.undetunedOneCornerWaveReach,
  }
  const refused = (code: string, more: Partial<MengerRunAnswer> = {}): MengerRunAnswer => ({
    ok: false,
    code,
    cell: MENGER_HIVE_CELL_NAME,
    tick: 0,
    privacyClaim: false,
    organismWiring: MENGER_ORGANISM_WIRING_CAVEAT,
    pins: { browser: null, edge: null },
    tableSha256: null,
    wiringsSha256: null,
    plainMatchesMengerOnSplitAndHorizon: null,
    undetunedOneCornerWaveReach: reachPair,
    runs: {},
    ...more,
  })

  if (Object.keys(args).some(key => !ALLOWED_ARGS.has(key))) return refused('HIVE_INPUT_INVALID')

  const ticks = args.ticks === undefined ? MENGER_HIVE_DEFAULT_TICKS : args.ticks
  if (typeof ticks !== 'number' || !Number.isSafeInteger(ticks) || ticks < 1 || ticks > MENGER_HIVE_MAX_TICKS) {
    return refused('HIVE_TICKS_INVALID')
  }
  const cut = args.cut === undefined ? Math.floor(ticks / 2) : args.cut
  if (typeof cut !== 'number' || !Number.isSafeInteger(cut) || cut < 0 || cut > ticks) {
    return refused('HIVE_CUT_INVALID')
  }
  const edgeOrgan = args.edgeOrgan === undefined ? 0 : args.edgeOrgan
  if (typeof edgeOrgan !== 'number' || !Number.isSafeInteger(edgeOrgan) || edgeOrgan < 0 || edgeOrgan > 4) {
    return refused('HIVE_ORGAN_INVALID')
  }
  const handoverOrgan = args.handoverOrgan === undefined ? (edgeOrgan === 0 ? 1 : 0) : args.handoverOrgan
  if (typeof handoverOrgan !== 'number' || !Number.isSafeInteger(handoverOrgan) || handoverOrgan < 0 || handoverOrgan > 4) {
    return refused('HIVE_ORGAN_INVALID')
  }
  const seed = args.seed === undefined ? 1 : args.seed
  if (typeof seed !== 'number' || !Number.isSafeInteger(seed) || seed < 0 || seed > 2_147_483_647) {
    return refused('HIVE_SEED_INVALID')
  }
  const wiringArg = args.wiring === undefined ? 'both' : args.wiring
  if (wiringArg !== 'both' && wiringArg !== 'menger' && wiringArg !== 'plain') {
    return refused('HIVE_WIRING_INVALID')
  }
  if (!deps.origin || deps.origin === 'null') return refused('HIVE_ORIGIN_UNAVAILABLE')

  const pin = Object.hasOwn(CELL_PINS, MENGER_HIVE_CELL_NAME) ? CELL_PINS[MENGER_HIVE_CELL_NAME] : undefined
  if (!pin) return refused('HIVE_CELL_REFUSED')

  // Verify local `menger-hive` cell info and embedded wiring digests before stepping:
  const infoCall = await cells.invoke(MENGER_HIVE_CELL_NAME, 'hive.info', {}, 'x6_cell')
  if (!infoCall.ok) return refused(infoCall.code, { pins: { browser: infoCall.sha256, edge: null } })
  const browserPin = infoCall.sha256
  const infoRes = isRecord(infoCall.result) ? infoCall.result : null
  const computedWiringsSha = await sha256Bytes(encoder.encode(cellCanonicalJson(MENGER_WIRINGS_DOC)))
  if (!infoRes
    || infoRes.tableSha256 !== MENGER_TABLE_SHA256
    || infoRes.wiringsSha256 !== MENGER_WIRINGS_SHA256
    || computedWiringsSha !== MENGER_WIRINGS_SHA256) {
    return refused('HIVE_WIRINGS_DIGEST_MISMATCH', { pins: { browser: browserPin, edge: null } })
  }

  const wiringsToRun: readonly MengerWiringName[] = wiringArg === 'both' ? ['menger', 'plain'] : [wiringArg]
  const now = deps.now ?? (() => globalThis.performance.now())
  const runs: Partial<Record<MengerWiringName, MengerWiringRunReport>> = {}
  let observedEdgePin: string | null = null
  let lastTick = 0

  for (const wiring of wiringsToRun) {
    const nextRand = createSeedStream(seed)
    // Drive 16 warmup ticks from zero so tick 0 starts at a genuine reachable state with all 160 words populated:
    let monoState = new Array<number>(160).fill(0)
    for (let w = 0; w < 16; w += 1) {
      monoState = stepMengerWaveOracle(wiring, monoState, nextRand(), true).nextState
    }
    const startState = [...monoState]
    const tickInputs = Array.from({ length: Math.max(ticks, 8) }, () => nextRand())

    const obsCheck = await verifyFourTickTwinViaCell(cells, wiring, startState, tickInputs.slice(0, 8))
    if (!obsCheck.ok) {
      return refused(obsCheck.code, {
        tick: lastTick,
        pins: { browser: browserPin, edge: observedEdgePin },
        tableSha256: MENGER_TABLE_SHA256,
        wiringsSha256: MENGER_WIRINGS_SHA256,
      })
    }

    let activeOrgan = edgeOrgan
    let { organState, bodyState } = splitMengerState(monoState, activeOrgan)
    let handoverOccurred = false
    let finalStateSha256 = await mengerWordsSha256(monoState)
    let edgeWallMs = 0
    let prevRunTick = 0
    const steps: MengerStepReading[] = []

    for (let t = 0; t < ticks; t += 1) {
      if (t === cut && cut > 0 && cut < ticks && handoverOrgan !== activeOrgan) {
        const joinedAtCut = joinMengerState(organState, bodyState, activeOrgan)
        activeOrgan = handoverOrgan
        ;({ organState, bodyState } = splitMengerState(joinedAtCut, activeOrgan))
        handoverOccurred = true
      }

      const u = atNum(tickInputs, t)
      const oracle = stepMengerWaveOracle(wiring, monoState, u, true)

      const monoCall = await cells.invoke(MENGER_HIVE_CELL_NAME, 'hive.step_monolith', {
        input: u,
        state: monoState,
        wiring,
      }, 'x6_cell')
      if (!monoCall.ok || !isRecord(monoCall.result) || !Array.isArray(monoCall.result.nextState) || typeof monoCall.result.stateSha256 !== 'string') {
        return refused(monoCall.ok ? 'HIVE_LOCAL_INVALID' : monoCall.code, {
          tick: prevRunTick,
          pins: { browser: browserPin, edge: observedEdgePin },
          tableSha256: MENGER_TABLE_SHA256,
          wiringsSha256: MENGER_WIRINGS_SHA256,
        })
      }

      const bndCall = await cells.invoke(MENGER_HIVE_CELL_NAME, 'hive.boundary', {
        bodyState,
        edgeOrgan: activeOrgan,
        wiring,
      }, 'x6_cell')
      if (!bndCall.ok || !isRecord(bndCall.result) || !Array.isArray(bndCall.result.msgToEdge)) {
        return refused(bndCall.ok ? 'HIVE_LOCAL_INVALID' : bndCall.code, {
          tick: prevRunTick,
          pins: { browser: browserPin, edge: observedEdgePin },
          tableSha256: MENGER_TABLE_SHA256,
          wiringsSha256: MENGER_WIRINGS_SHA256,
        })
      }

      // Real unbatched edge call for this single tick:
      const t0 = now()
      const edgeStep = await callEdgeStepOrgan(cells, deps, browserPin, {
        input: u,
        msgIn: bndCall.result.msgToEdge as number[],
        organ: activeOrgan,
        organState,
        wiring,
      })
      edgeWallMs += Math.max(0, now() - t0)
      if (!edgeStep.ok) {
        return refused(edgeStep.code, {
          tick: prevRunTick,
          pins: { browser: browserPin, edge: edgeStep.edgePin ?? observedEdgePin },
          tableSha256: MENGER_TABLE_SHA256,
          wiringsSha256: MENGER_WIRINGS_SHA256,
        })
      }
      observedEdgePin = edgeStep.edgePin

      const bodyCall = await cells.invoke(MENGER_HIVE_CELL_NAME, 'hive.step_body', {
        bodyState,
        edgeOrgan: activeOrgan,
        input: u,
        msgFromEdge: edgeStep.msgOut,
        wiring,
      }, 'x6_cell')
      if (!bodyCall.ok || !isRecord(bodyCall.result) || !Array.isArray(bodyCall.result.nextBodyState) || typeof bodyCall.result.bodySha256 !== 'string') {
        return refused(bodyCall.ok ? 'HIVE_LOCAL_INVALID' : bodyCall.code, {
          tick: prevRunTick,
          pins: { browser: browserPin, edge: observedEdgePin },
          tableSha256: MENGER_TABLE_SHA256,
          wiringsSha256: MENGER_WIRINGS_SHA256,
        })
      }

      organState = [...edgeStep.nextOrganState]
      bodyState = [...(bodyCall.result.nextBodyState as number[])]
      const reassembled = joinMengerState(organState, bodyState, activeOrgan)
      const reassembledSha = await mengerWordsSha256(reassembled)
      const organSha = await mengerWordsSha256(organState)
      const bodySha = await mengerWordsSha256(bodyState)

      const monoNext = monoCall.result.nextState as number[]
      const monoSha = monoCall.result.stateSha256
      const stateEqual = reassembled.every((val, idx) => val === atNum(monoNext, idx) && val === atNum(oracle.nextState, idx))
      const digestsEqual = reassembledSha === monoSha
        && organSha === edgeStep.organSha256
        && bodySha === bodyCall.result.bodySha256
      if (!stateEqual || !digestsEqual) {
        return refused('HIVE_SPLIT_MISMATCH', {
          tick: t + 1,
          mismatch: {
            wiring,
            tick: t + 1,
            organ: activeOrgan,
            stateEqual,
            digestsEqual,
          },
          pins: { browser: browserPin, edge: observedEdgePin },
          tableSha256: MENGER_TABLE_SHA256,
          wiringsSha256: MENGER_WIRINGS_SHA256,
        })
      }

      const stepReading: MengerStepReading = {
        tick: t + 1,
        organ: activeOrgan,
        corner0: atNum(reassembled, 0),
        stateSha256: monoSha,
      }
      prevRunTick = stepReading.tick
      lastTick = stepReading.tick
      steps.push(stepReading)

      monoState = monoNext
      finalStateSha256 = monoSha
    }

    const roundedWallMs = Math.round(edgeWallMs * 1000) / 1000
    const ticksPerSecond = edgeWallMs > 0 ? Math.round((ticks / (edgeWallMs / 1000)) * 100) / 100 : ticks * 1000

    runs[wiring] = {
      wiring,
      tick: prevRunTick,
      ticks,
      cut,
      edgeOrgan,
      handoverOrgan,
      mismatchedTicks: 0,
      allDigestsEqual: true,
      finalStateSha256,
      steps,
      wordsCrossed: {
        handoverOnceWords: handoverOccurred ? 24 : 0,
        boundaryInPerTick: 7,
        boundaryOutPerTick: 7,
        boundaryTotalPerTick: 14,
        statelessHttpEchoWordsPerCall: 24,
      },
      liveEdge: {
        edgeCalls: ticks,
        wallMs: roundedWallMs,
        ticksPerSecond,
      },
      observation: obsCheck.observation,
    }
  }

  // Any split/monolith mismatch already returned `HIVE_SPLIT_MISMATCH` (`ok: false`) above, so reaching here holds 0 mismatches.
  const plainMatchesMengerOnSplitAndHorizon =
    mengerAnalysis.horizonTicks === plainAnalysis.horizonTicks
    && mengerAnalysis.blindDimsAt4 === plainAnalysis.blindDimsAt4
    && mengerAnalysis.blindDimsAt8 === plainAnalysis.blindDimsAt8

  return {
    ok: true,
    cell: MENGER_HIVE_CELL_NAME,
    tick: lastTick,
    privacyClaim: false,
    organismWiring: MENGER_ORGANISM_WIRING_CAVEAT,
    pins: { browser: browserPin, edge: observedEdgePin },
    tableSha256: MENGER_TABLE_SHA256,
    wiringsSha256: MENGER_WIRINGS_SHA256,
    plainMatchesMengerOnSplitAndHorizon,
    undetunedOneCornerWaveReach: reachPair,
    runs,
  }
}
