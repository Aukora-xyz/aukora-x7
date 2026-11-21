/**
 * `x6_self_check`: her inside test in one call. A closed list of read-only probes of her own running
 * body, run one after another, answered as one table.
 *
 * It is an INSTRUMENT: it grants, writes, stages and promotes nothing, and a green row is evidence about THIS session
 * only. Every probe calls a tool's own `execute` through her tool registry, as `POST /__x6__/call-tool` does (the
 * invocation check, then the registered definition), never a private shortcut, so the check exercises what she would.
 * The one exception is named: `nucleus-shadow` asks the shadow consult itself (it is not a tool), on a made-up
 * transition that changes nothing, and never settles it, so her tally stays as it was.
 *
 * Bounds: every probe at most SELF_CHECK_PROBE_MS, except pentora-carry at 20 s (a late probe is a `fail` with `TIMEOUT`),
 * the whole call at most SELF_CHECK_CALL_MS (a probe with no time left is `skipped` with `CALL_DEADLINE`), the answer at most
 * SELF_CHECK_RESULT_BYTES (details cut to SELF_CHECK_DETAIL_CHARS, then shorter if it must). A probe that throws is a
 * `fail` with the first line of its error and never stops the others. A probe that is over (TIMEOUT included) may not call
 * again: each probe has its own context and signal, aborted when it ends. A probe whose tool is not registered in this body
 * is `skipped` with `NOT_REGISTERED`, never a pass. A row's `ok` is true (pass), false (fail) or null (skipped).
 * @module x6/self-check
 */
import { PRIVATE_ROOT } from './browser-estate.ts'
import { TOUCH_ID_TIER_REFLEX_DIGEST } from './nucleus-shadow.ts'
import { nucleusTierReasons } from './nucleus-tier.ts'
import { withholdSecrets } from './secret-shapes.ts'
import { CELL_PINS } from './wasm-cells.ts'

export const SELF_CHECK_SCHEMA = 'aukora.self-check.v1' as const
export const SELF_CHECK_RESULT_BYTES = 8 * 1024
export const SELF_CHECK_DETAIL_CHARS = 160
export const SELF_CHECK_PROBE_MS = 5000
export const SELF_CHECK_CALL_MS = 60_000

/**
 * The built-in tools her runtime registers on main (ball-loader.ts `registerBuiltin`, with the specs it registers from
 * host-facts.ts, self-state.ts, thread-reader.ts and this file). self-check.spec.ts boots her runtime and fails when a
 * built-in is added or removed without this list changing with it.
 */
export const SELF_CHECK_BUILTINS: readonly string[] = Object.freeze([
  'auma_alien_compose', 'auma_handoff', 'auma_snapshot', 'ball_put', 'ball_status', 'crew_relay', 'head_adopt', 'pearl_put',
  'scion_grow', 'self_apply', 'self_facts', 'self_undo', 'stage_head_promotion', 'stage_organ_promotion',
  'stage_organ_remove_promotion', 'stage_organ_set_promotion', 'tree_patch', 'tree_undo', 'voice_scratch', 'x6_browser_estate', 'x6_capability_index', 'x6_cell', 'x6_checkpoint_verify',
  'x6_cloudflare', 'x6_consult', 'x6_exec', 'x6_facts', 'x6_github', 'x6_host_facts', 'x6_linear', 'x6_memory', 'x6_nostr', 'x6_repo',
  'x6_self_check', 'x6_self_state', 'x6_skill', 'x6_swarm', 'x6_threads', 'x6_tools', 'x6_trusted_docs', 'x6_voice_memory',
  'x6_voice_status', 'x6_web_eyes', 'x6_wish',
])

/**
 * The worked adder of docs/auma/cells/adder.wat, byte for byte (self-check.spec.ts holds it equal to that file). docs/ is
 * not served to her page, so the text ships here; `compile_and_run` of it with `{ a: 2, b: 3 }` answers `{ sum: 5 }`.
 */
export const SELF_CHECK_ADDER_WAT = `(module
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
${'            (i32.and (i32.eq (i32.load8_u offset=2 (local.get $i)) (i32.const 34)) '
  + '(i32.eq (i32.load8_u offset=3 (local.get $i)) (i32.const 58))))'}
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

/** docs/auma/nucleus.md, worked example: escalate only when both of two facts are true; [1, 1] is row 3. */
export const SELF_CHECK_NUCLEUS_CALL = Object.freeze({ action: 'compute', cell: 'nucleus', op: 'reflex.run',
  input: { input: [1, 1], reflex: { escalate: [1], kind: 'table', outcomes: 2, sizes: [2, 2], table: [0, 0, 0, 1] } } })
/** docs/auma/kyber-cpu.md: countdown from b 7 halts with a 7 after 24 steps. */
export const SELF_CHECK_KYBER_CALL = Object.freeze({ action: 'compute', cell: 'kyber-cpu', op: 'cpu.run',
  input: { rom: [5, 388, 6, 3, 0, 388, 6, 6], state: { a: 0, b: 7, halted: 0, pc: 0 }, steps: 64 } })
export const SELF_CHECK_COMPILE_CALL = Object.freeze({ action: 'compile_and_run', wat: SELF_CHECK_ADDER_WAT, name: 'adder', op: 'add',
  input: { a: 2, b: 3 } })
/** A made-up transition that changes nothing: the tier reflex reads it as NO_ENTRY_CHANGED (decision 1). */
export const SELF_CHECK_SHADOW_HEAD = Object.freeze({ entries: Object.freeze({}) })
export const SELF_CHECK_SHADOW_NO_CHANGE = 1

type Json = Record<string, unknown>
const record = (value: unknown): value is Json => value !== null && typeof value === 'object' && !Array.isArray(value)
const REVISION = /^[0-9a-f]{40,64}$/
const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0

/** One probe's verdict. `skipped` (null) is for a probe that did not run (NOT_REGISTERED, CALL_DEADLINE) or ran and found
 * nothing to check (tools-callable with no runnable mounted tool); otherwise a probe that ran passes or fails. */
export interface SelfCheckVerdict {
  readonly ok: boolean | null
  readonly detail: string
  /** A skip because there was nothing to check (`ok: null` only). It does not stop the check being ok. */
  readonly empty?: true
}
export interface SelfCheckRow {
  readonly id: string
  readonly ok: boolean | null
  readonly ms: number
  readonly detail: string
  /** Internal (never in the answer): this skip had nothing to check. */
  readonly empty?: true
}

/** What a probe may use: tool calls through her registry, the registered names, the shadow consult, shared memos. */
export interface SelfCheckContext {
  /** Call one registered tool's own execute (the call-tool path). */
  call(name: string, args: Json): Promise<unknown>
  /** The tool names registered in this session. */
  toolNames(): readonly string[]
  /** The shadow consult (nucleus-shadow.ts `consult`); never settled here. */
  consultShadow(previous: unknown, candidate: unknown, known: { readonly canonicalManifestMatches?: unknown }): Promise<unknown>
  /** `x6_self_state` read once per run and shared by the probes that need it. */
  selfState(): Promise<unknown>
  /** The clock the rows are timed by. */
  now(): number
  /** The cell journal summary read when the run began (only when `cell-journal` runs), or why it could not be read. */
  journalBefore: { readonly calls: number; readonly rootSha256: string } | { readonly error: string } | null
  /** Calls this run made to pinned cells through `x6_cell` before the journal probe (cell-nucleus and cell-kyber). */
  cellCalls: number
}

export interface SelfCheckProbe {
  readonly id: string
  /** What it compares, in a line (docs/auma/self-check.md lists them). */
  readonly what: string
  /** The tools it calls; one not registered makes the row `skipped` with NOT_REGISTERED. */
  readonly needs: readonly string[]
  /** A longer bound for pentora-carry's two cell runs; absent uses SELF_CHECK_PROBE_MS. */
  readonly boundMs?: number
  run(context: SelfCheckContext): Promise<SelfCheckVerdict>
}

const pass = (detail: string): SelfCheckVerdict => ({ ok: true, detail })
const fail = (detail: string): SelfCheckVerdict => ({ ok: false, detail })
/** A probe that ran and found nothing to check (tools-callable with no runnable mounted tool). */
const skip = (detail: string): SelfCheckVerdict => ({ ok: null, detail, empty: true })
const short = (value: unknown): string => typeof value === 'string' ? value.slice(0, 12) : 'unknown'
/** A refused or failed tool answer, in a few words: its code, else what it was. */
function codeOf(answer: unknown): string {
  if (!record(answer)) return `ANSWER_INVALID (${answer === null ? 'null' : typeof answer})`
  if (typeof answer.code === 'string') return answer.code
  if (typeof answer.error === 'string') return answer.error
  return 'ANSWER_INVALID'
}
const resultOf = (answer: unknown): Json | null => record(answer) && answer.ok === true && record(answer.result) ? answer.result : null
const listOf = (value: unknown): string => Array.isArray(value) ? value.filter(item => typeof item === 'string').join(',') : String(value)

/** The journal summary from an `x6_cell journal` answer, or null when it is not that shape. */
export function journalSummaryOf(answer: unknown): { calls: number; rootSha256: string } | null {
  if (!record(answer) || typeof answer.rootSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(answer.rootSha256)) return null
  const calls = record(answer.totals) ? answer.totals.calls : answer.calls
  return count(calls) ? { calls, rootSha256: answer.rootSha256 } : null
}

async function nucleusExample(context: SelfCheckContext): Promise<SelfCheckVerdict> {
  const answer = await context.call('x6_cell', { ...SELF_CHECK_NUCLEUS_CALL })
  context.cellCalls += 1
  const result = resultOf(answer)
  if (result === null) return fail(`REFUSED: ${codeOf(answer)}`)
  const seen = `decision ${String(result.decision)}, escalate ${String(result.escalate)}, row ${String(result.row)}`
  return result.decision === 1 && result.escalate === 1 && result.row === 3
    ? pass(seen) : fail(`WRONG_ANSWER: ${seen} (want decision 1, escalate 1, row 3)`)
}

/**
 * The probes, in the order they run. LEAD: a probe per new tool goes in the marked place at the end; give it an id, a line, the
 * tools it calls in `needs`, and a run that is TRUE against main, and add its tool to SELF_CHECK_BUILTINS.
 */
export const SELF_CHECK_PROBES: readonly SelfCheckProbe[] = Object.freeze([
  {
    id: 'build', needs: ['x6_self_state'],
    what: 'the revision her runtime was built from equals the revision her edge says it runs (x6_self_state: GET /api/build)',
    async run(context) {
      const state = await context.selfState()
      if (!record(state) || !record(state.runtime) || !record(state.edge)) return fail(`READ_FAILED: ${codeOf(state)}`)
      const runtime = state.runtime.sourceRevision, edge = state.edge.sourceRevision
      const rows: unknown[] = Array.isArray(state.unknown) ? state.unknown : []
      const why = rows.find(row => record(row) && row.field === 'edge.sourceRevision')
      const edgeDetail = typeof edge === 'string' ? short(edge) : `unknown (${record(why) ? String(why.reason) : 'null'})`
      const seen = `runtime ${short(runtime)}, edge ${edgeDetail}`
      if (typeof runtime !== 'string' || typeof edge !== 'string') return fail(`UNKNOWN: ${seen}`)
      return runtime === edge ? pass(seen) : fail(`DIFFERENT: ${seen}`)
    },
  },
  {
    id: 'tools', needs: [],
    what: 'every built-in this repository registers on main (SELF_CHECK_BUILTINS) is registered in this session',
    run(context) {
      const names = new Set(context.toolNames())
      const missing = SELF_CHECK_BUILTINS.filter(name => !names.has(name))
      const present = SELF_CHECK_BUILTINS.length - missing.length
      return Promise.resolve(missing.length === 0
        ? pass(`${String(present)} of ${String(SELF_CHECK_BUILTINS.length)} built-ins registered (${String(names.size)} tools in all)`)
        : fail(`MISSING ${String(missing.length)}: ${missing.join(', ')}`))
    },
  },
  {
    id: 'cells-pinned', needs: ['x6_cell'],
    what: 'x6_cell list names exactly as many cells as CELL_PINS has pins',
    async run(context) {
      const answer = await context.call('x6_cell', { action: 'list' })
      if (!record(answer) || answer.ok !== true || !Array.isArray(answer.cells)) return fail(`READ_FAILED: ${codeOf(answer)}`)
      const pins = Object.keys(CELL_PINS).length
      const seen = `${String(answer.cells.length)} cells, ${String(pins)} pins`
      return answer.cells.length === pins ? pass(seen) : fail(`DIFFERENT: ${seen}`)
    },
  },
  {
    id: 'cell-nucleus', needs: ['x6_cell'],
    what: 'the nucleus cell answers the worked example of docs/auma/nucleus.md: decision 1, escalate 1, row 3',
    run: nucleusExample,
  },
  {
    id: 'cell-kyber', needs: ['x6_cell'],
    what: 'the Kyber CPU countdown answers halted 1, state.a 7 and stepsTaken 24 (docs/auma/kyber-cpu.md)',
    async run(context) {
      const answer = await context.call('x6_cell', { ...SELF_CHECK_KYBER_CALL })
      context.cellCalls += 1
      const result = resultOf(answer)
      if (result === null) return fail(`REFUSED: ${codeOf(answer)}`)
      const a = record(result.state) ? result.state.a : undefined
      const seen = `halted ${String(result.halted)}, state.a ${String(a)}, stepsTaken ${String(result.stepsTaken)}`
      return result.halted === 1 && a === 7 && result.stepsTaken === 24
        ? pass(seen) : fail(`WRONG_ANSWER: ${seen} (want halted 1, state.a 7, stepsTaken 24)`)
    },
  },
  {
    id: 'cell-journal', needs: ['x6_cell'],
    what: 'after two calls to pinned cells in this run the cell journal counts at least 2 more calls and its running root changed',
    async run(context) {
      const before = context.journalBefore
      if (before === null || 'error' in before) return fail(`READ_FAILED: journal before (${before === null ? 'not read' : before.error})`)
      // It always compares across two calls: cell-nucleus and cell-kyber, with missing calls supplied when `only` selects fewer.
      for (const call of [SELF_CHECK_NUCLEUS_CALL, SELF_CHECK_KYBER_CALL].slice(context.cellCalls)) {
        await context.call('x6_cell', { ...call })
      }
      const after = journalSummaryOf(await context.call('x6_cell', { action: 'journal' }))
      if (after === null) return fail('READ_FAILED: journal after')
      const grew = after.calls - before.calls
      const seen = `calls ${String(before.calls)} to ${String(after.calls)} (+${String(grew)}), `
        + `root ${after.rootSha256 === before.rootSha256 ? 'unchanged' : 'changed'}`
      return grew >= 2 && after.rootSha256 !== before.rootSha256 ? pass(seen) : fail(`NOT_RECORDED: ${seen}`)
    },
  },
  {
    id: 'cell-compile', needs: ['x6_cell'],
    what: 'compile_and_run of the worked adder (docs/auma/cells/adder.wat) with a 2, b 3 answers sum 5; nothing is kept',
    async run(context) {
      const answer = await context.call('x6_cell', { ...SELF_CHECK_COMPILE_CALL })
      const result = resultOf(answer)
      if (result === null) return fail(`REFUSED: ${codeOf(answer)}`)
      const fuel = record(answer) && count(answer.compilerFuelUsed) ? `, compiler fuel ${String(answer.compilerFuelUsed)}` : ''
      return result.sum === 5 ? pass(`sum 5${fuel}`) : fail(`WRONG_ANSWER: sum ${String(result.sum)} (want 5)`)
    },
  },
  {
    id: 'self-state', needs: ['x6_self_state'],
    what: 'x6_self_state answers with head, organs, cells, nucleusShadow and forgedCells; '
      + 'organs that differ from her store are counted, not failed',
    async run(context) {
      const state = await context.selfState()
      if (!record(state)) return fail(`READ_FAILED: ${codeOf(state)}`)
      const absent = ['head', 'organs', 'cells', 'nucleusShadow', 'forgedCells'].filter(key => !Object.hasOwn(state, key))
      if (absent.length > 0) return fail(`ABSENT: ${absent.join(', ')}`)
      const organs = Array.isArray(state.organs) ? state.organs : []
      const differ = organs.filter(organ => record(organ) && organ.matchesStore === false).length
      const forged = record(state.forgedCells) && count(state.forgedCells.count) ? String(state.forgedCells.count) : 'unknown'
      const unknown = Array.isArray(state.unknown) ? state.unknown.length : 0
      return pass(`${String(organs.length)} organs, ${String(differ)} differ from her store, `
        + `${count(state.cellCount) ? String(state.cellCount) : 'unknown'} cells, `
        + `${forged} forged, ${String(unknown)} unknown`)
    },
  },
  {
    id: 'nucleus-shadow', needs: ['x6_self_state'],
    what: 'the shadow tally names the pinned Touch ID tier reflex, '
      + 'and a consult on a made-up no-change transition answers NO_ENTRY_CHANGED from that reflex',
    async run(context) {
      const state = await context.selfState()
      const tally = record(state) && record(state.nucleusShadow) ? state.nucleusShadow : null
      if (tally === null) return fail('READ_FAILED: nucleusShadow')
      if (tally.reflex !== TOUCH_ID_TIER_REFLEX_DIGEST) return fail(`WRONG_REFLEX: tally ${short(tally.reflex)}`)
      const started = context.now()
      const consulted = await context.consultShadow(SELF_CHECK_SHADOW_HEAD, SELF_CHECK_SHADOW_HEAD, { canonicalManifestMatches: true })
      const ms = context.now() - started
      const nucleus = record(consulted) && record(consulted.nucleus) ? consulted.nucleus : null
      if (nucleus === null) return fail('ANSWER_INVALID')
      if (nucleus.consult === null) return fail(`${String(nucleus.reason)} after ${String(ms)} ms`)
      if (nucleus.reflex !== TOUCH_ID_TIER_REFLEX_DIGEST) return fail(`WRONG_REFLEX: consult ${short(nucleus.reflex)}`)
      const decision = typeof nucleus.decision === 'number' ? nucleus.decision : -1
      const seen = `decision ${String(decision)} (${nucleusTierReasons(Math.max(0, decision)).join(',')}), `
        + `escalate ${String(nucleus.escalate)}, ${String(ms)} ms`
      return decision === SELF_CHECK_SHADOW_NO_CHANGE ? pass(seen) : fail(`WRONG_ANSWER: ${seen}`)
    },
  },
  {
    id: 'door-cloudflare', needs: ['x6_cloudflare'],
    what: 'x6_cloudflare status answers ok with its level and says the door is configured',
    async run(context) {
      const answer = await context.call('x6_cloudflare', { action: 'status' })
      if (!record(answer) || answer.ok !== true) return fail(`READ_FAILED: ${codeOf(answer)}`)
      const missing = ['brokerConfigured', 'accountConfigured'].filter(key => answer[key] !== true)
      const level = typeof answer.level === 'string' ? answer.level : 'unknown'
      if (missing.length > 0) return fail(`NOT_CONFIGURED: level ${level}, missing ${missing.join(', ')}`)
      return level === 'open' || level === 'guarded' ? pass(`level ${level}, configured`) : fail(`LEVEL_UNKNOWN: ${level}`)
    },
  },
  {
    id: 'door-linear', needs: ['x6_linear'],
    what: 'x6_linear status answers ok with its level and says the door is configured',
    async run(context) {
      const answer = await context.call('x6_linear', { action: 'status' })
      if (!record(answer) || answer.ok !== true) return fail(`READ_FAILED: ${codeOf(answer)}`)
      const level = typeof answer.level === 'string' ? answer.level : 'unknown'
      if (answer.configured !== true) return fail(`NOT_CONFIGURED: level ${level}, missing ${listOf(answer.missing)}`)
      return level === 'open' || level === 'guarded' ? pass(`level ${level}, configured`) : fail(`LEVEL_UNKNOWN: ${level}`)
    },
  },
  {
    // Her hands. A read of her newest auma-exec.yml runs (POST /_host/repo exec_runs); it starts nothing.
    id: 'exec-list', needs: ['x6_exec'],
    what: 'x6_exec list answers ok with her newest runs of auma-exec.yml (a read: nothing is started)',
    async run(context) {
      const answer = await context.call('x6_exec', { action: 'list' })
      if (!record(answer) || answer.ok !== true || !Array.isArray(answer.runs)) return fail(`READ_FAILED: ${codeOf(answer)}`)
      const newest = answer.runs.find(record)
      return pass(`${String(answer.runs.length)} runs listed, newest ${newest === undefined ? 'none'
        : `${String(newest.id)} ${String(newest.status)}${typeof newest.conclusion === 'string' ? `/${newest.conclusion}` : ''}`}`)
    },
  },
  {
    id: 'voice', needs: ['x6_voice_status'],
    what: 'x6_voice_status answers; it fails only when the read fails or the switch is on with no key name in use',
    async run(context) {
      const answer = await context.call('x6_voice_status', {})
      if (!record(answer) || answer.ok === false || (answer.switch !== 'on' && answer.switch !== 'off')) {
        return fail(`READ_FAILED: ${codeOf(answer)}`)
      }
      const failures = Array.isArray(answer.failures) ? answer.failures.filter(record) : []
      const newest = failures.reduce<Json | null>((best, item) =>
        (best === null || Number(item.atMs) > Number(best.atMs) ? item : best), null)
      const parts = [`switch ${answer.switch}`, `key ${typeof answer.keyInUse === 'string' ? answer.keyInUse : 'none'}`,
        `newest failure ${newest === null ? 'none' : `${String(newest.door)}:${String(newest.stage)}`}`]
      if (record(answer.runtime)) {
        const codes: unknown[] = Array.isArray(answer.runtime.codes) ? answer.runtime.codes : []
        const last: unknown = typeof answer.runtime.code === 'string' ? answer.runtime.code : codes.at(-1)
        const code = record(last) ? last.code : last
        const level = typeof answer.runtime.level === 'string' ? answer.runtime.level : 'unknown'
        parts.push(`runtime level ${level}, newest code ${typeof code === 'string' ? code : 'none'}`)
      }
      const seen = parts.join(', ')
      return answer.switch === 'on' && typeof answer.keyInUse !== 'string' ? fail(`KEY_MISSING: ${seen}`) : pass(seen)
    },
  },
  {
    id: 'capability-index', needs: ['x6_capability_index'],
    what: 'x6_capability_index snapshot answers with its counts',
    async run(context) {
      const answer = await context.call('x6_capability_index', { action: 'snapshot' })
      const counts = record(answer) && record(answer.counts) ? answer.counts : null
      if (counts === null || !count(counts.tools)) return fail(`READ_FAILED: ${codeOf(answer)}`)
      return pass(`tools ${String(counts.tools)}, readOnly ${String(counts.readOnlyTools)}, mutating ${String(counts.mutatingTools)}`)
    },
  },
  {
    id: 'threads', needs: ['x6_threads'],
    what: 'x6_threads list answers',
    async run(context) {
      const answer = await context.call('x6_threads', { action: 'list' })
      if (!record(answer) || answer.ok === false || !Array.isArray(answer.threads)) return fail(`READ_FAILED: ${codeOf(answer)}`)
      const total = count(answer.total) ? answer.total : answer.threads.length
      return pass(`${String(total)} threads, ${String(answer.threads.length)} listed`)
    },
  },
  // LEAD: new probes go here, one per new tool (see the note above SELF_CHECK_PROBES).
  {
    id: 'skill-countdown', needs: ['x6_skill'],
    what: 'x6_skill check of countdown answers ok with every recorded case agreeing (docs/auma/skills.md)',
    async run(context) {
      const answer = await context.call('x6_skill', { action: 'check', skill: 'countdown' })
      if (!record(answer) || !record(answer.cases)) return fail(`READ_FAILED: ${codeOf(answer)}`)
      const cases = answer.cases
      const seen = `${String(cases.agree)} of ${String(cases.total)} cases agree, skill ${short(answer.id)}`
      return answer.ok === true && count(cases.total) && cases.total > 0 && cases.agree === cases.total
        && Array.isArray(cases.differ) && cases.differ.length === 0 ? pass(seen) : fail(`WRONG_ANSWER: ${seen}`)
    },
  },
  {
    id: 'two-hosts', needs: ['x6_cell'],
    what: 'the Kyber CPU countdown handed off at step 12 ends the same on both hosts (docs/auma/kyber-cpu.md)',
    async run(context) {
      const answer = await context.call('x6_cell', { action: 'handoff', cell: 'kyber-cpu',
        input: SELF_CHECK_KYBER_CALL.input, cutAt: 12 })
      if (!record(answer)) return fail(`READ_FAILED: ${codeOf(answer)}`)
      if (answer.same === null) return fail(codeOf(answer))
      if (answer.ok !== true || !record(answer.pins)) return fail(`READ_FAILED: ${codeOf(answer)}`)
      const seen = `browser ${short(answer.pins.browser)}, edge ${short(answer.pins.edge)}`
      return answer.same === true ? pass(`same: true, ${seen}`) : fail(`DIFFERENT: ${seen}`)
    },
  },
  {
    id: 'pentora-carry', needs: ['x6_cell'], boundMs: 20_000,
    what: 'PENTORA recovers all 1329 Kyber CPU weights exactly after dropping packets 0..9 (docs/auma/pentora-codec.md)',
    async run(context) {
      const answer = await context.call('x6_cell', { action: 'carry', what: 'kyber-cpu-weights', drop: '0-9' })
      if (!record(answer) || answer.ok !== true) return fail(`REFUSED: ${codeOf(answer)}`)
      const seen = `${String(answer.recovered)} of ${String(answer.scalars)} recovered, ${String(answer.dropped)} packets dropped`
      return answer.exact === true && answer.recovered === 1329 && answer.scalars === 1329 && answer.dropped === 10
        ? pass(seen) : fail(`WRONG_ANSWER: ${seen}`)
    },
  },
  {
    id: 'cord-status', needs: ['x6_cell'],
    what: 'x6_cell cord status reads the head she holds for cord-echo, or says it is not started (docs/auma/cord-echo.md); it writes nothing',
    async run(context) {
      const answer = await context.call('x6_cell', { action: 'cord', step: 'status' })
      if (!record(answer) || answer.ok !== true) return fail(`REFUSED: ${codeOf(answer)}`)
      if (answer.started !== true) return pass(`not started, skill ${short(answer.skill)}`)
      return typeof answer.head === 'string' && count(answer.tick) && count(answer.kept)
        ? pass(`head ${short(answer.head)}, tick ${String(answer.tick)}, ${String(answer.kept)} kept`) : fail(`WRONG_ANSWER: ${codeOf(answer)}`)
    },
  },
  {
    // Her own tools (tool-registry.ts). A read of /dsh/home/tools/ only: it mounts, qualifies and calls nothing.
    id: 'tools-list', needs: ['x6_tools'],
    what: 'x6_tools list answers with her mounted tools and open proposals (a read: nothing is mounted or run)',
    async run(context) {
      const answer = await context.call('x6_tools', { action: 'list' })
      if (!record(answer) || answer.ok !== true || !Array.isArray(answer.mounted) || !Array.isArray(answer.proposals)) return fail(`READ_FAILED: ${codeOf(answer)}`)
      const unreadable = Array.isArray(answer.unreadable) ? answer.unreadable.length : 0
      const line = `${String(answer.mounted.length)} mounted, ${String(answer.proposals.length)} proposals`
      return unreadable > 0 ? fail(`UNREADABLE: ${line}, ${String(unreadable)} unreadable`) : pass(line)
    },
  },
  {
    // The row that would have caught a mounted tool the model could not call after a reload. Reads only:
    // x6_tools list, the registered names, and one capability-index lookup per runnable mounted tool (64 at most).
    id: 'tools-callable', needs: ['x6_tools', 'x6_capability_index'],
    what: 'every tool x6_tools lists as mounted and runnable is registered for the model (x6t_<name>) and found by the capability index',
    async run(context) {
      const answer = await context.call('x6_tools', { action: 'list' })
      if (!record(answer) || answer.ok !== true || !Array.isArray(answer.mounted)) return fail(`READ_FAILED: ${codeOf(answer)}`)
      const rows = answer.mounted.filter(record)
      const runnable = rows.filter(row => row.runnable === true && typeof row.tool === 'string')
      const held = rows.length - runnable.length
      // Nothing runnable is nothing checked: skipped, never a pass (Auma read "0 of 0 runnable tools callable" as green).
      if (runnable.length === 0) {
        return skip(held > 0 ? `no runnable mounted tools: nothing to check, ${String(held)} held (not runnable, see tools-list)`
          : 'no mounted tools: nothing to check')
      }
      const names = new Set(context.toolNames())
      const broken: string[] = []
      for (const row of runnable) {
        const tool = row.tool as string
        const found = await context.call('x6_capability_index', { action: 'lookup', name: tool })
        const indexed = record(found) && found.ok === true
        if (!names.has(tool) || !indexed) broken.push(`${tool} (${names.has(tool) ? 'registered' : 'NOT registered'}, ${indexed ? 'indexed' : 'NOT indexed'})`)
      }
      const line = `${String(runnable.length - broken.length)} of ${String(runnable.length)} runnable tools callable`
        + (held > 0 ? `, ${String(held)} held (not runnable, see tools-list)` : '')
      return broken.length === 0 ? pass(line) : fail(`NOT_CALLABLE: ${broken.join(', ')}; ${line}`)
    },
  },
])

export interface SelfCheckDeps {
  /** The revision baked into the runtime she executes (the answer's `build`). */
  readonly sourceRevision: string | null | undefined
  /** The tool names registered in this session (her registry); throws when it cannot be read. */
  readonly toolNames: () => readonly string[]
  /** Call one registered tool as call-tool does: the invocation check, then its own execute. */
  readonly callTool: (name: string, args: Json, signal: AbortSignal) => Promise<unknown>
  /** Her shadow consult (never settled here). */
  readonly consultShadow: SelfCheckContext['consultShadow']
  readonly now?: () => number
  /** Tests only: shorter bounds. */
  readonly limits?: { readonly probeMs?: number; readonly callMs?: number }
}

/** Free text leaves through the secret-shape filter, never as a path in her private room, and cut. */
export function detailText(value: string, max = SELF_CHECK_DETAIL_CHARS): string {
  const line = value.split(/\r?\n/, 1)[0] ?? ''
  const text = line.includes(PRIVATE_ROOT) || line.includes('/private/') ? '[withheld]' : withholdSecrets(line)
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text
}

/** Validate `only`: absent, or a list of 1 to all known probe ids. */
export function parseOnly(value: unknown, probes: readonly SelfCheckProbe[] = SELF_CHECK_PROBES): Set<string> | null {
  if (value === undefined || value === null) return null
  const known = probes.map(probe => probe.id)
  if (!Array.isArray(value) || value.length === 0 || value.length > known.length
    || value.some(item => typeof item !== 'string' || !known.includes(item))) {
    throw new Error(`SELF_CHECK_ONLY_INVALID: only is a list of probe ids: ${known.join(', ')}`)
  }
  return new Set(value as string[])
}

const bytesOf = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).byteLength
const TIMED_OUT = Symbol('timeout')

/**
 * Run the check. Probes run one after another; each is bounded, and the whole call is bounded.
 * @param args - `{ only?: string[] }`.
 * @param deps - her registry, the shadow consult, a clock.
 * @param probes - the registry (tests may pass another; the tool always runs SELF_CHECK_PROBES).
 */
export async function runSelfCheck(args: unknown, deps: SelfCheckDeps,
  probes: readonly SelfCheckProbe[] = SELF_CHECK_PROBES): Promise<Json> {
  const only = parseOnly(record(args) ? args.only : undefined, probes)
  const now = deps.now ?? Date.now
  const ranAtMs = now()
  const deadline = ranAtMs + (deps.limits?.callMs ?? SELF_CHECK_CALL_MS)
  const selected = probes.filter(probe => only === null || only.has(probe.id))
  let names: readonly string[] | null = null
  const toolNames = (): readonly string[] => { names ??= deps.toolNames(); return names }
  const registered = (name: string): boolean => { try { return toolNames().includes(name) } catch { return false } }
  // The run's own reads (the journal before, the one shared x6_self_state read) carry the run's signal, aborted when the
  // answer is made. Each probe gets its own context and controller (below); nothing is reassigned between probes.
  const runController = new AbortController()
  let selfState: Promise<unknown> | null = null
  let journalBefore: SelfCheckContext['journalBefore'] = null
  let cellCalls = 0
  /**
   * A probe's own context. Once its probe is over (answered, threw, or stopped by TIMEOUT) it is dead: its signal is
   * aborted, and a call it still tries (a tool, the shared read, the shadow consult) is refused with TIMEOUT before it
   * leaves, and a count it still writes is dropped. A tool already running when the bound passed gets the aborted signal;
   * one that ignores it may still finish that one call, but the probe makes no other.
   */
  const contextFor = (controller: AbortController): SelfCheckContext => {
    const alive = (): void => {
      if (controller.signal.aborted) throw new Error('TIMEOUT: this probe is over; it may not call again')
    }
    return {
      call: async (name, callArgs) => { alive(); return await deps.callTool(name, callArgs, controller.signal) },
      toolNames,
      now,
      consultShadow: async (previous, candidate, known) => { alive(); return await deps.consultShadow(previous, candidate, known) },
      selfState: async () => { alive(); return await (selfState ??= deps.callTool('x6_self_state', {}, runController.signal)) },
      journalBefore,
      get cellCalls() { return cellCalls },
      set cellCalls(value: number) { if (!controller.signal.aborted) cellCalls = value },
    }
  }

  const rows: SelfCheckRow[] = []
  try {
    if (selected.some(probe => probe.id === 'cell-journal') && registered('x6_cell')) {
      try {
        journalBefore = journalSummaryOf(await deps.callTool('x6_cell', { action: 'journal' }, runController.signal))
          ?? { error: 'ANSWER_INVALID' }
      } catch (error) { journalBefore = { error: detailText(error instanceof Error ? error.message : String(error), 60) } }
    }
    for (const probe of selected) {
      const started = now()
      const left = deadline - started
      const missing = probe.needs.filter(name => !registered(name))
      if (missing.length > 0) { rows.push({ id: probe.id, ok: null, ms: 0, detail: `NOT_REGISTERED: ${missing.join(', ')}` }); continue }
      if (left <= 0) { rows.push({ id: probe.id, ok: null, ms: 0, detail: 'CALL_DEADLINE: the whole check is bounded to 60 s' }); continue }
      const controller = new AbortController()
      const context = contextFor(controller)
      let timer: ReturnType<typeof setTimeout> | undefined
      let verdict: SelfCheckVerdict
      try {
        const bound = Math.min(deps.limits?.probeMs ?? probe.boundMs ?? SELF_CHECK_PROBE_MS, left)
        const outcome = await Promise.race([
          Promise.resolve().then(() => probe.run(context)),
          new Promise<typeof TIMED_OUT>((resolve) => { timer = setTimeout(() => { resolve(TIMED_OUT) }, bound) }),
        ])
        if (outcome === TIMED_OUT) verdict = fail(`TIMEOUT: no answer within ${String(bound)} ms`)
        else verdict = record(outcome) && [true, false, null].includes(outcome.ok) && typeof outcome.detail === 'string' // Null = skipped
          ? outcome : fail('VERDICT_INVALID')
      } catch (error) {
        verdict = fail(`THREW: ${error instanceof Error ? error.message : String(error)}`)
      } finally {
        clearTimeout(timer)
        controller.abort()
      }
      rows.push({ id: probe.id, ok: verdict.ok, ms: Math.max(0, now() - started), detail: verdict.detail,
        ...(verdict.ok === null && verdict.empty === true ? { empty: true as const } : {}) })
    }
  } finally { runController.abort() }

  const summary = { pass: rows.filter(row => row.ok === true).length, fail: rows.filter(row => row.ok === false).length,
    skipped: rows.filter(row => row.ok === null).length }
  const build = typeof deps.sourceRevision === 'string' && REVISION.test(deps.sourceRevision) ? deps.sourceRevision : null
  // Ok = at least one row, none failed, and each passed or is an empty skip (nothing to check). A
  // NOT_REGISTERED or CALL_DEADLINE skip still keeps it false.
  const allOk = rows.length > 0 && rows.every(row => row.ok === true || (row.ok === null && row.empty === true))
  const answer = (max: number): Json => ({
    schema: SELF_CHECK_SCHEMA, ok: allOk, build, ranAtMs,
    rows: rows.map(row => ({ id: row.id, ok: row.ok, ms: row.ms, detail: detailText(row.detail, max) })), summary,
  })
  for (const max of [SELF_CHECK_DETAIL_CHARS, 80, 40, 16, 0]) {
    const out = answer(max)
    if (bytesOf(out) <= SELF_CHECK_RESULT_BYTES) return out
  }
  // Only a registry far larger than this one could get here: the rows are cut, the summary stays whole.
  const out = answer(0)
  const kept = out.rows as Json[]
  while (kept.length > 0 && bytesOf(out) > SELF_CHECK_RESULT_BYTES) kept.pop()
  return { ...out, rowsCut: rows.length - kept.length }
}

/** The tool's definition, registered by the ball runtime beside `x6_self_state`. */
export function selfCheckToolSpec(deps: () => SelfCheckDeps) {
  return {
    name: 'x6_self_check',
    description: 'Run your own inside check: one call, a table, nothing changed. It runs a closed list of read-only probes of your '
      + 'running body, one after another, each at most 5 s (pentora-carry 20 s), the whole call at most 60 s, '
      + 'and answers `{ ok, build, ranAtMs, rows: '
      + '[{ id, ok, ms, detail }], summary: { pass, fail, skipped } }` (at most 8 KiB). Probes: `build` (your runtime revision equals '
      + 'your edge\'s), `tools` (every built-in is registered), `cells-pinned`, `cell-nucleus` (the worked example of '
      + 'docs/auma/nucleus.md), `cell-kyber` (countdown halts with a 7 in 24 steps), `cell-journal` (two cell calls were journaled), '
      + '`cell-compile` (the worked adder compiles '
      + 'and adds), `self-state`, `nucleus-shadow`, `door-cloudflare`, `door-linear`, `voice`, `capability-index`, `threads`, '
      + '`skill-countdown` (all cases agree), `two-hosts` (handoff agrees), `pentora-carry` (1329 weights recovered exactly), '
      + '`cord-status` (the cord-echo head you hold, read only), `tools-list`, `tools-callable` (every mounted tool of yours is '
      + 'registered for the model and in the capability index). '
      + 'A row\'s `ok` '
      + 'is true (pass), false (fail, `detail` says why: TIMEOUT, NOT_CONFIGURED, WRONG_ANSWER, ...) or null (skipped: NOT_REGISTERED, or nothing to check). The top `ok` is true when every row passed or had nothing to check. '
      + 'Pass `only` (a list of probe ids) to run some. It writes, stages and approves nothing; a green row is evidence about this '
      + 'session only. How to read it: docs/auma/self-check.md.',
    parameters: {
      only: { type: 'json', description: 'Optional list of probe ids to run (default all), e.g. ["build", "door-linear"].' },
    },
    async execute(args: Record<string, unknown> | undefined) {
      return await runSelfCheck(args ?? {}, deps())
    },
  }
}
