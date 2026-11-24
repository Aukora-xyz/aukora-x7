/**
 * Look-only voice (A2, A3, A6 as overridden by R1-R8, R10).
 *
 * "From voice she can look at everything in her system and cannot call a tool that changes things." A voice turn still
 * writes her own turn journal and spends model budget; this file claims nothing more than the sentence above.
 *
 * Pure: no I/O, no clock, no globals. `voiceVerdict` answers one tool call of a look-only session: `undefined` (it may
 * run) or the refusal text the model receives as the tool error. Closed by default: only an exact row of
 * VOICE_SWITCH_TABLE (or a pinned organ row of voice-organ-pins.ts) passes. The table is deep-frozen worker source: it
 * changes only by a repository change through her proposal card and the owner's fingerprint. Nothing a model says, no
 * prompt, HANDOFF, config row or argument (`approved`, `override`, `voiceAuthority`, ...) is read here.
 *
 * Every row says which argument selects the action and where that was read (file:line at an earlier commit). An edge-brokered
 * row is present but switched off (`edgeProven: false`, R3) until an edge test lands proving that exact
 * (tool, action, route, body.action) writes no storage and calls nothing outward.
 */
import { estateRedaction, PRIVATE_ROOT, SESSIONS_ROOT } from './browser-estate.ts'
import { VOICE_ORGAN_PINS, type VoiceOrganPin } from './voice-organ-pins.ts'

/** The fields that prove a session is the voice home ensureVoiceSession creates (genesis-live.js:9-12, 259-266). */
export const VOICE_HOME_TITLE = '[voice] Auma Live'
export const VOICE_HOME_CWD = '/dsh/home/auma'
export const VOICE_HOME_PRESET = 'auma-alien'
/** The first text part of every spoken turn begins with this (genesis-live.js:84-86, 353). It is the worker's "spoken" mark. */
export const SPOKEN_PROVENANCE_PREFIX = '[spoken to Auma Live;'
/** The owner-facing sentence, exact. */
export const VOICE_LOOK_ONLY_CLAIM = 'From voice she can look at everything in her system and cannot call a tool that changes things.'

export const VOICE_LOOK_ONLY_CODE = 'VOICE_LOOK_ONLY'
export const VOICE_PRIVATE_REFUSAL = 'VOICE_LOOK_ONLY: that is in my private folder; I do not open it from voice.'
export const VOICE_ORGAN_CHANGED_REFUSAL = 'VOICE_LOOK_ONLY: that organ changed since it was checked for voice.'
export const VOICE_SPOKEN_ELSEWHERE_REFUSAL = 'VOICE_LOOK_ONLY: this turn was spoken, and I take spoken turns only in my look-only voice thread. '
  + 'Say it in Auma Live, or type it here.'
export const VOICE_LOADING_REFUSAL = 'VOICE_LOOK_ONLY: my voice list is still loading; try again in a moment.'
export const VOICE_RELATIVE_PATH_REFUSAL = 'VOICE_LOOK_ONLY: from voice I open files by their full path, starting with /.'
/** Raw thread logs carry every tool result unfiltered (a typed thread may have read her private folder into one). */
export const VOICE_THREAD_LOGS_REFUSAL = 'VOICE_LOOK_ONLY: from voice I read my threads only through x6_threads, which withholds secrets.'

/** The refusal sentence of A2, exact. */
export function voiceRefusal(tool: string, action?: string | null): string {
  const named = action === undefined || action === null ? tool : `${tool}.${action}`
  return `VOICE_LOOK_ONLY: I can look, I cannot change things from voice yet. (${named} is not on my voice list.)`
}

/** Where a row's read runs. `edge` rows reach the host over HTTP and stay off until E1 proves them. */
export type VoiceWhere = 'local' | 'edge'
/** Who must have registered the tool: her own worker built-ins, or a preset plugin (never an organ or her plugins). */
export type VoiceOrigin = 'builtin' | 'preset'

export interface VoiceValueRow {
  readonly where: VoiceWhere
  /** Edge rows only: true once an edge test for this exact row is on main. */
  readonly edgeProven: boolean
  /** file:line where this value's branch was read. */
  readonly source: string
  /** `github-class-0`: only a plain GET of this repository (`x6_github`). */
  readonly requires?: 'github-class-0'
  /** Argument constraints for this value: the argument must be absent or match the pattern. */
  readonly argPatterns?: Readonly<Record<string, string>>
  /** Arguments that must be present and exactly equal (cordis_inspect_query: platform and method of one provider). */
  readonly argEquals?: Readonly<Record<string, string>>
}

export interface VoicePathRule {
  readonly arg: string
  /** A call without this argument is refused (glob and grep: their default root holds the private folder). */
  readonly required: boolean
  /** Also refuse a directory that CONTAINS the private folder (glob, grep). x6_browser_estate is exempt. */
  readonly refuseContaining: boolean
}

export interface VoiceToolRow {
  readonly origin: VoiceOrigin
  /** The argument that selects the action, or `whole` for a single-purpose tool. */
  readonly selector: string
  /** `boolean` when the selector is a boolean flag (ball_status `includeManifest`). */
  readonly selectorType?: 'string' | 'boolean'
  /** The value voice assumes when the selector is absent; absent means "refused unless given explicitly". */
  readonly absent?: string
  /** Where the selector is read in the executor. */
  readonly selectorSource: string
  /** The allowed selector values (`*` for a whole tool), each with where it runs. */
  readonly values: Readonly<Record<string, VoiceValueRow>>
  readonly paths?: readonly VoicePathRule[]
  /** Pattern arguments (glob `pattern`, grep `include`) that must not be absolute or climb with `..`. */
  readonly patterns?: readonly string[]
}

const BL = 'webworker-runtime/src/x6/ball-loader.ts'
/**
 * GET /_head/promotion-status writes nothing: an unmarked published ancestor is recognised on every read,
 * and its mark is persisted only by a publication (head-do.mjs readStaged and publish).
 */
const PROMOTION_STATUS_MARK = 'a pure read: the published-ancestor mark is persisted only by a publication, never by this read'
const local = (source: string, extra: Partial<VoiceValueRow> = {}): VoiceValueRow => ({ where: 'local', edgeProven: false, source, ...extra })
const edge = (source: string, extra: Partial<VoiceValueRow> = {}): VoiceValueRow => ({ where: 'edge', edgeProven: false, source, ...extra })

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key])
  }
  return value
}

/**
 * The per-tool switch table. Reads only. R2: `x6_repo transcript` and `x6_wish status` are off (both reap
 * a stale turn at the edge). R4: the web is off except `x6_web_eyes` `status` and `search` with an explicit action.
 * `job_output` is left off: its read advances the job's read cursor ("output since the previous read",
 * jobs/tool-jobs/src/index.ts:434), which a later typed read would then miss.
 */
export const VOICE_SWITCH_TABLE: Readonly<Record<string, VoiceToolRow>> = deepFreeze({
  // The thread reader (x6/thread-reader.ts), registered in ball-loader.ts through registerBuiltin; it passes only as
  // that worker built-in.
  x6_threads: { origin: 'builtin', selector: 'action', selectorSource: 'x6/thread-reader.ts registerThreadTools (action required, THREAD_ACTIONS)',
    values: { list: local('thread-reader.ts list'), tail: local('thread-reader.ts tail'), search: local('thread-reader.ts search') } },
  x6_capability_index: { origin: 'builtin', selector: 'action', absent: 'snapshot', selectorSource: `${BL}:6236 (lookup when 'lookup', else snapshot)`,
    values: { snapshot: local(`${BL}:6236 capabilityIndex.read()`), lookup: local(`${BL}:6236 capabilityIndex.lookup()`) } },
  x6_browser_estate: { origin: 'builtin', selector: 'whole', selectorSource: `${BL}:6252-6253 (single purpose)`,
    values: { '*': local(`${BL}:6253 inspectBrowserEstate; browser-estate.ts:122-123 root clamp`) },
    paths: [{ arg: 'root', required: false, refuseContaining: false }] },
  ball_status: { origin: 'builtin', selector: 'includeManifest', selectorType: 'boolean', absent: 'false',
    selectorSource: `${BL}:5193 (includeManifest === true → local manifest, else host facts)`,
    values: { true: local(`${BL}:5193 boundedStatus(readStatus())`), false: edge(`${BL}:5201 readX6Facts GET (:927-960)`) } },
  x6_facts: { origin: 'builtin', selector: 'whole', selectorSource: `${BL}:5186-5201`, values: { '*': edge(`${BL}:5201 readX6Facts GET`) } },
  self_facts: { origin: 'builtin', selector: 'whole', selectorSource: `${BL}:5186-5201`, values: { '*': edge(`${BL}:5201 readX6Facts GET`) } },
  x6_host_facts: { origin: 'builtin', selector: 'whole', selectorSource: 'host-facts.ts:193', values: { '*': edge(`host-facts.ts:144 GET; ${PROMOTION_STATUS_MARK}`, { edgeProven: true }) } },
  // One GET /api/build (worker.mjs buildRevision: no durable call, no storage, no secret; proven by
  // deploy/cloudflare/src/__tests__/edge-signin-door.test.mjs "F2: GET /api/build ..."); the rest is memory and VFS reads.
  x6_self_state: { origin: 'builtin', selector: 'whole', selectorSource: 'self-state.ts selfStateToolSpec (single purpose)',
    values: { '*': edge('self-state.ts readEdgeBuild: GET /api/build only', { edgeProven: true }) } },
  // x6_self_check takes no argument that steers a request (`only` picks probes by closed id); its
  // probes run fixed reads: the x6_self_state, x6_cloudflare status, x6_linear status and x6_voice_status requests
  // proven on their rows here, pinned cells and the shipped reflex (same-origin GETs of static files), and fixed
  // compute and compile_and_run calls that keep nothing (self-check.spec.ts proves no write and every request it sends).
  x6_self_check: { origin: 'builtin', selector: 'whole', selectorSource: 'self-check.ts selfCheckToolSpec (single purpose)',
    values: { '*': edge('self-check.ts SELF_CHECK_PROBES: GET /api/build, GET /cells/**, POST /_host/cloudflare|linear status, '
      + 'POST /_host/voice managed_status, POST /_host/repo exec_runs', { edgeProven: true }) } },
  x6_voice_status: { origin: 'builtin', selector: 'whole', selectorSource: `${BL} x6_voice_status (single purpose)`,
    values: { '*': edge(`${BL} POST /_host/voice managed_status; voice-bridge.mjs handleManagedStatus`, { edgeProven: true }) } },
  // Her voice memory's verifier (storage/voice-memory.ts runVoiceMemoryTool), registered in ball-loader.ts.
  // `tail`, `search` and `head` read her home's two chain files; `verify` reads them and makes the one managed_status POST
  // x6_voice_status makes (proven by the same edge test as that row). No action writes; the action is required.
  x6_voice_memory: { origin: 'builtin', selector: 'action',
    selectorSource: 'storage/voice-memory.ts runVoiceMemoryTool (action required, VOICE_MEMORY_ACTIONS)',
    values: { tail: local('voice-memory.ts tail: reads chain.v1.jsonl and words.v1.jsonl'),
      search: local('voice-memory.ts search: reads words.v1.jsonl'), head: local('voice-memory.ts voiceMemoryHead: reads chain.v1.jsonl'),
      verify: edge(`voice-memory.ts verify: reads both files; ${BL} POST /_host/voice managed_status; voice-bridge.mjs handleManagedStatus`,
        { edgeProven: true }) } },
  // Her timeline's one tool (storage/memory-timeline.ts runMemoryTool), registered in ball-loader.ts. Every action
  // reads only her home's timeline and voice files (no request, no write); the action is required, any other refused.
  x6_memory: { origin: 'builtin', selector: 'action',
    selectorSource: 'storage/memory-timeline.ts runMemoryTool (action required, MEMORY_ACTIONS)',
    values: { timeline: local('memory-timeline.ts timeline: reads timeline/ and voice/ chain and words files, 8 MiB each'),
      search: local('memory-timeline.ts search: reads timeline/ and voice/ chain and words files, 8 MiB each'),
      around: local('memory-timeline.ts around: reads timeline/ and voice/ chain and words files, 8 MiB each'),
      head: local('memory-timeline.ts head: reads the ends of timeline/chain.v1.jsonl'),
      verify: local('memory-timeline.ts verify: reads timeline/ and voice/ chain and words files, 8 MiB each') } },
  head_adopt: { origin: 'builtin', selector: 'whole', selectorSource: `${BL}:5216-5217`, values: { '*': edge(`${BL}:5217 describePublishedHead GET /_head/ball`) } },
  x6_repo: { origin: 'builtin', selector: 'action', selectorSource: `${BL}:6302-6305 (required, no default), dispatch :6373-6414`,
    values: {
      selftest: edge(`${BL}:6494 POST /_host/repo`), diagnostics: edge(`${BL}:6494 POST /_host/repo`),
      promotion_status: edge(`${BL}:6398 → :5222 VFS read + GET /_head/promotion-status; ${PROMOTION_STATUS_MARK}`, { edgeProven: true }),
      tree: edge(`${BL}:6494`, { edgeProven: true }), status: edge(`${BL}:6494`, { edgeProven: true }),
      read: edge(`${BL}:6441 draft or :6494`, { edgeProven: true }), bytes: edge(`${BL}:6494`),
      search: edge(`${BL}:6494`, { edgeProven: true }), compare_files: edge(`${BL}:6494`), diff: edge(`${BL}:6494`), state_diff: edge(`${BL}:6422-6494`),
      log: edge(`${BL}:6494`, { edgeProven: true }),
    } },
  x6_github: { origin: 'builtin', selector: 'action', selectorSource: `${BL}:6866-6870 (required)`,
    values: { status: edge(`${BL}:6884 POST /_host/github`, { edgeProven: true }),
      // Job logs are refused from voice: GitHub answers them with a 302 to a second host
      // (cloud-brokers.mjs jobLogs), and a voice turn reaches only the fixed host its row names. A typed thread still reads them.
      api: edge(`${BL}:6884 POST /_host/github`, { requires: 'github-class-0', edgeProven: true,
        argPatterns: { endpoint: '^(?![\\s\\S]*/actions/jobs/[0-9]+/logs)' } }) } },
  x6_cloudflare: { origin: 'builtin', selector: 'action', selectorSource: `${BL}:6904-6907 (required)`,
    values: { status: edge(`${BL}:6926 POST /_host/cloudflare`, { edgeProven: true }), versions: edge(`${BL}:6926 POST /_host/cloudflare`, { edgeProven: true }) } },
  // Her Linear door's reads, each one fixed query to Linear and no storage written (deploy/cloudflare/src/__tests__/
  // linear-door.test.mjs proves it per read). Every write (and every other action) is refused from voice: closed by default.
  x6_linear: { origin: 'builtin', selector: 'action', selectorSource: `${BL} x6_linear (action required)`,
    values: Object.fromEntries(['status', 'teams', 'projects', 'issue', 'issues', 'search', 'comments', 'documents', 'document', 'labels', 'states', 'users']
      .map(action => [action, edge(`${BL} x6_linear POST /_host/linear; linear-door.mjs LINEAR_READS`, { edgeProven: true })])) },
  // x6_exec (exec-tool.ts). `run` and `cancel` are refused from voice (closed by default: no row). `list`, `status`
  // and `artifacts` are GETs of this repository's auma-exec.yml runs at api.github.com and write no storage (proven by
  // deploy/cloudflare/src/__tests__/auma-exec-door.test.mjs "the reads voice may call"). `logs` is a read but stays off from
  // voice, as x6_github job logs do: GitHub answers a log with a 302 to a second host.
  x6_exec: { origin: 'builtin', selector: 'action', selectorSource: 'x6/exec-tool.ts createExecTool (action required, EXEC_TOOL_ACTIONS)',
    values: { list: edge('exec-tool.ts list: POST /_host/repo exec_runs', { edgeProven: true }),
      status: edge('exec-tool.ts status: POST /_host/repo exec_run (run) or exec_runs (label)', { edgeProven: true }),
      artifacts: edge('exec-tool.ts artifacts: POST /_host/repo exec_artifacts', { edgeProven: true }),
      logs: edge('exec-tool.ts logs: POST /_host/repo exec_logs; cloud-brokers.mjs jobLogs follows a 302 to a second host') } },
  // `journal` reads the cell host's in-memory journal (wasm-cells.ts journal()); it calls no cell and writes nothing.
  // ---- CORDECHO block begin ----
  // x6_cell `cord` (cord-run.ts): only `step: "status"` is on this row (argEquals). `start` and `feed` write her home
  // (/dsh/home/cord/) and `feed` may call her edge: refused from voice. `status` fetches the shipped skill files and the
  // pinned cell bytes (same-origin GETs of /cells/**), reads head.json, calls no cell and writes nothing (proven by
  // tests/x6/cord-echo.spec.ts "voice may read status"). The capability index keeps `cord` under write: a value with
  // argEquals reads only for some calls of that action (capability-index.ts classifyToolMutation).
  x6_cell: { origin: 'builtin', selector: 'action', selectorSource: `${BL}:6974-6977 (required)`, values: { list: local(`${BL}:6992 cells.list()`),
    journal: local(`${BL} x6_cell cells.journal()`),
    cord: edge('cord-run.ts createCordShelf status: GET /cells/kyber/skills/**, /cells/cord/**, /cells/cord-echo.wasm; reads head.json',
      { edgeProven: true, argEquals: { step: 'status' } }) } },
  // ---- CORDECHO block end ----
  x6_nostr: { origin: 'builtin', selector: 'action', selectorSource: `${BL}:7203 (defaults to status when absent; voice needs it explicit)`,
    values: { status: edge(`${BL}:7209 POST /_head/transcript nostr_status`, { edgeProven: true }) } },
  x6_web_eyes: { origin: 'builtin', selector: 'action', selectorSource: `${BL}:7022 (INFERRED from url/query when absent; voice needs it explicit)`,
    values: { status: local(`${BL}:7024 returns before any request`), search: edge(`${BL}:7026 POST /_host/web-eyes`) } },
  auma_handoff: { origin: 'builtin', selector: 'action', selectorSource: `${BL}:6821 (defaults to read when absent; voice needs it explicit)`,
    values: { read: local(`${BL}:6823-6829 readHandoffSafe()`) } },
  auma_snapshot: { origin: 'builtin', selector: 'action', selectorSource: `${BL}:6625 (defaults to list when absent; voice needs it explicit)`,
    values: { list: local(`${BL}:6639-6641 listSnapshots()`),
      diff: local(`${BL}:6643-6648 reads one snapshot file`, { argPatterns: { snapshotId: '^[a-f0-9]{64}(?:\\.json)?$' } }) } },
  auma_alien_compose: { origin: 'builtin', selector: 'action', selectorSource: `${BL}:6716 (defaults to status when absent; voice needs it explicit)`,
    values: { status: local(`${BL}:6727-6736`), prompt_list: local(`${BL}:6727-6736`), config_list: local(`${BL}:6766-6772`) } },
  read: { origin: 'preset', selector: 'whole', selectorSource: 'fs/tool-fs/src/read.ts:78-81', values: { '*': local('fs/tool-fs/src/read.ts') },
    paths: [{ arg: 'file_path', required: true, refuseContaining: false }] },
  read_image: { origin: 'preset', selector: 'whole', selectorSource: 'fs/tool-fs/src/read-image.ts:211-215', values: { '*': local('fs/tool-fs/src/read-image.ts') },
    paths: [{ arg: 'file_path', required: true, refuseContaining: false }] },
  glob: { origin: 'preset', selector: 'whole', selectorSource: 'fs/tool-fs-search/src/glob.ts:322-333', values: { '*': local('fs/tool-fs-search/src/glob.ts') },
    paths: [{ arg: 'path', required: true, refuseContaining: true }], patterns: ['pattern'] },
  grep: { origin: 'preset', selector: 'whole', selectorSource: 'fs/tool-fs-search/src/grep.ts:287-293', values: { '*': local('fs/tool-fs-search/src/grep.ts') },
    paths: [{ arg: 'path', required: true, refuseContaining: true }], patterns: ['include'] },
  job_list: { origin: 'preset', selector: 'whole', selectorSource: 'jobs/tool-jobs/src/index.ts:541', values: { '*': local('jobs/tool-jobs/src/index.ts:541') } },
  schedule_list: { origin: 'preset', selector: 'whole', selectorSource: 'schedule/tool-schedule/src/index.ts:394', values: { '*': local('tool-schedule:394') } },
  schedule_view: { origin: 'preset', selector: 'whole', selectorSource: 'schedule/tool-schedule/src/index.ts:417', values: { '*': local('tool-schedule:417') } },
  get_goal: { origin: 'preset', selector: 'whole', selectorSource: 'goal/tool-goal/src/index.ts:196', values: { '*': local('tool-goal:196') } },
  list_agents: { origin: 'preset', selector: 'whole', selectorSource: 'subagent/tool-subagent-control/src/list-agents.ts:82', values: { '*': local('list-agents.ts:82') } },
  list_subagent_models: { origin: 'preset', selector: 'whole', selectorSource: 'subagent/tool-subagent/src/list-models.ts:110', values: { '*': local('list-models.ts:110') } },
  cordis_inspect_list: { origin: 'preset', selector: 'whole', selectorSource: 'extensions/tool-cordis/src/index.ts:23', values: { '*': local('tool-cordis:23') } },
  // Only the four first-party host providers (tool-cordis/src/providers.ts:39-81, registered once per process by host.ts:16-20;
  // the registry rejects a duplicate id). Any other provider (an organ's, a plugin's, a synced page client's) is refused.
  cordis_inspect_query: { origin: 'preset', selector: 'provider', selectorSource: 'extensions/tool-cordis/src/index.ts:42-72 (provider, with platform and method)',
    values: {
      Service: local('tool-cordis/src/providers.ts:41-48', { argEquals: { platform: 'host', method: 'listService' } }),
      Event: local('tool-cordis/src/providers.ts:49-56', { argEquals: { platform: 'host', method: 'listEvents' } }),
      Config: local('tool-cordis/src/providers.ts:57-64', { argEquals: { platform: 'host', method: 'listConfigs' } }),
      Tool: local('tool-cordis/src/providers.ts:65-80', { argEquals: { platform: 'host', method: 'listTools' } }),
    } },
} satisfies Record<string, VoiceToolRow>)

/**
 * Every tool name known to be refused from voice, recorded so a NEW tool shows up as a snapshot difference a reviewer
 * must read (A7 T7), never silently as allowed. Recording a name here allows nothing: the verdict never reads it.
 */
export const VOICE_REFUSED_TOOLS: readonly string[] = deepFreeze([
  // Her worker built-ins that change things or spend (ball-loader.ts).
  'scion_grow', 'stage_organ_promotion', 'stage_organ_set_promotion', 'stage_organ_remove_promotion', 'stage_head_promotion', 'ball_put', 'pearl_put',
  'tree_patch', 'tree_undo', 'self_apply', 'self_undo', 'x6_consult', 'x6_swarm', 'x6_wish', 'x6_trusted_docs',
  // ---- KYBERSKILL block begin ----
  // Her skills tool: `keep` and `forget` write her home; `check` and `run` call cells; `list` fetches. None from voice.
  'x6_skill',
  // ---- KYBERSKILL block end ----
  // Her own tools. `propose`, `mount` and `unmount` write her home; `qualify` runs cells. None from a look-only
  // voice turn (`list` too, for now: closed by default). A mounted x6t_<name> tool is registered by her runtime but not
  // as a built-in voice row, so it is refused from a look-only turn as well (tool-registry.ts).
  'x6_tools',
  // `say` posts under the owner's name; `read` is an edge call with no voice-edge-reads proof. Her fast voice
  // at level open reads it by its row in VOICE_OPEN_FAST_READS.
  'crew_relay',
  // Her voice scratch space writes her home. A look-only spoken turn may not call it; only her FAST voice's own
  // route lets it through (ball-loader.ts runVoiceTool), confined to its folder by voice-scratch.ts.
  'voice_scratch',
  // Her checkpoint verifier reads her edge's thread routes (checkpoint-verify-tool.ts); no look-only row, so a look-only
  // spoken turn refuses it. Correction: this record said "refused from voice", but her FAST voice at level
  // open ran it, every action, through the name rule (`_verify`). It now runs there only by its explicit row in
  // VOICE_OPEN_FAST_READS: `verify` and `capture`.
  'x6_checkpoint_verify',
  // Preset plugins that change things, spawn, spend, or reach the open web (MAP-2 section 2).
  'write', 'edit', 'apply_patch', 'bash', 'job_kill', 'job_output', 'schedule_create', 'schedule_edit', 'create_goal', 'update_goal',
  'send_message', 'interrupt_agent', 'subagent', 'subagent_fork', 'workflow', 'web_fetch', 'web_search', 'exit_plan_mode',
  'todo_write', 'ask_user_question', 'present', 'skill', 'plugin_manager', 'plugin_market', 'run_code',
  // Session queries return thread events with no secret filter (tool-session-query session_event_read reads one "full
  // unabridged event"); from voice, threads are read only through x6_threads, which withholds secrets.
  'session_search', 'session_event_search', 'session_trace', 'session_event_trace', 'session_event_read',
])

/** Who registered the tool being judged, as the worker knows it. */
export type VoiceToolOrigin =
  | { readonly kind: 'builtin' }
  | { readonly kind: 'preset' }
  | { readonly kind: 'organ'; readonly organId: string; readonly organSha: string | null }

export interface VoiceVerdictInput {
  readonly tool: string
  readonly args: unknown
  readonly origin: VoiceToolOrigin
  /** For x6_github: ball-loader.ts githubApiClass(args). */
  readonly githubClass?: number | null
  /** Tests inject pins; the worker passes none and the shipped VOICE_ORGAN_PINS apply. */
  readonly pins?: readonly VoiceOrganPin[]
}

const plainRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype

const label = (value: unknown): string | null => typeof value === 'string' && /^[A-Za-z0-9_ .:-]{1,40}$/.test(value)
  ? value : typeof value === 'boolean' ? String(value) : null

/**
 * Fold `.` and `..` in an ABSOLUTE path argument. Null when it cannot be resolved honestly: not a string, empty, a NUL,
 * a backslash, `~`, or relative. A relative path is never resolved here: read, glob and grep resolve it against the
 * session's LIVE working folder (fs/tool-fs/src/session-cwd.ts:21-23, session/working-directory/src/index.ts:134-165),
 * which can differ from the header's and can change between this check and the call.
 */
export function resolveVoicePath(path: unknown): string | null {
  if (typeof path !== 'string' || path === '' || path.length > 4096 || /[\0\\]/.test(path) || path.startsWith('~')) return null
  if (!path.startsWith('/')) return null
  const parts: string[] = []
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return '/' + parts.join('/')
}

/** Inside (or equal to) the private folder, or a sensitive file name (browser-estate.ts:42-50). */
function privatePath(resolved: string): boolean {
  return estateRedaction(resolved) !== null
}
/** A directory that holds `root` somewhere below it. */
function contains(resolved: string, root: string): boolean {
  return resolved === '/' || root.startsWith(resolved + '/')
}
/**
 * Her memory organ's stores (mirror/home/balls/85a76ee2...js:5-6, temporary copies :212): `index_sessions` saves thread
 * chunks there verbatim, so from voice they are read only through `recall`, whose answer the fast voice screens.
 */
export const VOICE_MEMORY_STORE_PATHS: readonly string[] = Object.freeze(['/dsh/home/auma/memory-store.v2.json', '/dsh/home/auma/memory-store.json'])
/**
 * Her voice memory's folder (storage/voice-memory.ts VOICE_MEMORY_ROOT): the chain file and the words
 * file. A memory store: from voice it is never opened by `read`, searched by `grep` or listed by `glob` (a search of a
 * folder above it withholds its entries); only `x6_voice_memory` reads it. Its one writer is the page-only route.
 */
export const VOICE_MEMORY_HOME = '/dsh/home/auma/voice'
export const VOICE_MEMORY_HOME_REFUSAL = 'VOICE_LOOK_ONLY: that is my voice memory; I read it only through x6_voice_memory.'
/**
 * Her timeline's folder (storage/memory-timeline.ts TIMELINE_ROOT): it holds the words of every conversation of
 * hers, so from voice it is a memory store too: never opened by `read`, `grep` or `glob`; only `x6_memory` reads it.
 */
export const MEMORY_TIMELINE_HOME = '/dsh/home/auma/timeline'
export const MEMORY_TIMELINE_HOME_REFUSAL = 'VOICE_LOOK_ONLY: that is my timeline; I read it only through x6_memory.'
const timelineHome = (resolved: string): boolean => resolved === MEMORY_TIMELINE_HOME || resolved.startsWith(MEMORY_TIMELINE_HOME + '/')
const voiceMemoryHome = (resolved: string): boolean => resolved === VOICE_MEMORY_HOME || resolved.startsWith(VOICE_MEMORY_HOME + '/')
/** The refusal for a path inside one of her memory folders, or undefined. */
const memoryHomeRefusal = (resolved: string): string | undefined =>
  voiceMemoryHome(resolved) ? VOICE_MEMORY_HOME_REFUSAL : timelineHome(resolved) ? MEMORY_TIMELINE_HOME_REFUSAL : undefined
/** Her raw thread logs: SESSIONS_ROOT itself or anything below it, and the memory stores that copy thread words. */
function threadLogPath(resolved: string): boolean {
  return resolved === SESSIONS_ROOT || resolved.startsWith(SESSIONS_ROOT + '/')
    || VOICE_MEMORY_STORE_PATHS.some(store => resolved === store || resolved.startsWith(store + '.tmp-'))
}

function organVerdict(input: VoiceVerdictInput, tool: string, args: Record<string, unknown>): string | undefined {
  const origin = input.origin
  if (origin.kind !== 'organ') return voiceRefusal(tool)
  const pin = (input.pins ?? VOICE_ORGAN_PINS).find(row => row.tool === tool && row.organId === origin.organId)
  const action = pin && pin.selector !== 'whole' ? args[pin.selector] : undefined
  if (!pin) return voiceRefusal(tool, label(args.action ?? args.mode))
  if (origin.organSha === null || origin.organSha !== pin.sha256) return VOICE_ORGAN_CHANGED_REFUSAL
  if (pin.selector === 'whole') return undefined
  return typeof action === 'string' && pin.allowed.includes(action) ? undefined : voiceRefusal(tool, label(action))
}

/**
 * Judge one tool call of a look-only session. Closed by default.
 * @param input - the tool as the model named it, its arguments, the session folder, and who registered the tool.
 * @returns undefined when it is an exact listed read, else the refusal the model receives.
 */
export function voiceVerdict(input: VoiceVerdictInput): string | undefined {
  const tool = typeof input.tool === 'string' ? input.tool.replace(/-/g, '_') : ''
  if (!/^[A-Za-z0-9_]{1,64}$/.test(tool)) return voiceRefusal('tool')
  const args = input.args === undefined ? {} : input.args
  if (!plainRecord(args)) return voiceRefusal(tool)
  if (input.origin.kind === 'organ') return organVerdict(input, tool, args)
  const row = Object.hasOwn(VOICE_SWITCH_TABLE, tool) ? VOICE_SWITCH_TABLE[tool] : undefined
  if (!row) return voiceRefusal(tool, label(args.action))
  if (row.origin !== input.origin.kind) return voiceRefusal(tool, label(args.action))
  let key = '*'
  if (row.selector !== 'whole') {
    const raw = Object.hasOwn(args, row.selector) ? args[row.selector] : undefined
    const value = raw === undefined ? row.absent
      : row.selectorType === 'boolean' ? (typeof raw === 'boolean' ? String(raw) : undefined)
        : (typeof raw === 'string' ? raw : undefined)
    if (value === undefined || !Object.hasOwn(row.values, value)) return voiceRefusal(tool, raw === undefined ? null : label(raw) ?? '?')
    key = value
  }
  const valueRow = row.values[key] as VoiceValueRow
  const action = key === '*' ? null : key
  if (valueRow.where === 'edge' && !valueRow.edgeProven) return voiceRefusal(tool, action)
  if (valueRow.requires === 'github-class-0' && input.githubClass !== 0) return voiceRefusal(tool, action)
  for (const [arg, expected] of Object.entries(valueRow.argEquals ?? {})) {
    if (args[arg] !== expected) return voiceRefusal(tool, action)
  }
  for (const [arg, pattern] of Object.entries(valueRow.argPatterns ?? {})) {
    const value = args[arg]
    if (value !== undefined && (typeof value !== 'string' || !new RegExp(pattern).test(value))) return voiceRefusal(tool, action)
  }
  for (const rule of row.paths ?? []) {
    const value = args[rule.arg]
    if (value === undefined) {
      if (rule.required) return voiceRefusal(tool, action)
      continue
    }
    if (typeof value === 'string' && value !== '' && !value.startsWith('/') && !value.startsWith('~')) return VOICE_RELATIVE_PATH_REFUSAL
    const resolved = resolveVoicePath(value)
    if (resolved === null) return voiceRefusal(tool, action)
    if (privatePath(resolved) || (rule.refuseContaining && contains(resolved, PRIVATE_ROOT))) return VOICE_PRIVATE_REFUSAL
    if (threadLogPath(resolved) || (rule.refuseContaining && contains(resolved, SESSIONS_ROOT))) return VOICE_THREAD_LOGS_REFUSAL
    const memory = memoryHomeRefusal(resolved)
    if (memory !== undefined) return memory
  }
  for (const arg of row.patterns ?? []) {
    const value = args[arg]
    if (value === undefined) continue
    if (typeof value !== 'string' || value.startsWith('/') || value.startsWith('~') || /[\0\\]/.test(value)
      || value.split('/').includes('..')) return voiceRefusal(tool, action)
    if (/(?:^|\/)private(?:\/|$)/.test(value)) return VOICE_PRIVATE_REFUSAL
  }
  return undefined
}

/**
 * Reads that her capability index calls reads but that still change something or open what
 * voice never opens; her FAST voice stays refused them at voice level `open` too. `*` is the whole tool.
 */
export const VOICE_OPEN_STILL_REFUSED: Readonly<Record<string, readonly string[]>> = deepFreeze({
  // Raw thread events with no secret filter: from voice, threads are read only through x6_threads.
  session_search: ['*'], session_event_search: ['*'], session_trace: ['*'], session_event_trace: ['*'], session_event_read: ['*'],
  // Its read advances the job's read cursor (see the switch table's note).
  job_output: ['*'],
  // R2: `status` reaps a stale turn at the edge.
  x6_wish: ['*'],
  // ---- KYBERSKILL field begin ----
  // `check` calls cells.
  x6_skill: ['check'],
  // ---- KYBERSKILL field end ----
  // the voice safety change V1-1: `logs` is a read, but GitHub answers it with a 302 to a second host (cloud-brokers.mjs jobLogs); the
  // lead's ruling of 2026-11-13 (the x6_exec row's note) keeps it off from voice, the fast voice included.
  x6_exec: ['logs'],
})

/**
 * Reads of her fast voice at voice level `open` that no look-only row and no closed action enum names, each
 * written here by exact tool, origin and selector value (never by the shape of a name). A look-only spoken governed turn
 * still refuses all of them (they stay in VOICE_REFUSED_TOOLS). The runtime classifier must still class each call 0.
 */
export interface VoiceOpenFastRead {
  readonly origin: VoiceOrigin
  /** The argument that selects the action, or `whole` for a single-purpose tool. */
  readonly selector: string
  /** The value assumed when the selector is absent (the tool's own default, itself a read). */
  readonly absent?: string
  readonly values: readonly string[]
  /** When set, the call may carry no other argument. */
  readonly onlyArgs?: readonly string[]
  /** When set, per selected value: the only arguments that call may carry (every value of `values` has its list). */
  readonly argsByValue?: Readonly<Record<string, readonly string[]>>
  /**
   * By design (run the countdown and say where it halts): this row's `values` are written, by
   * the CODE of each action, as computes that write nothing in her home, stage nothing and call only pinned or kept
   * zero-import cells or stateless edge computations. Only for such a row do those values run although their verb is in
   * VOICE_FAST_NOT_READS.operations; every other tool keeps that refusal (x6_cell only, held by a test).
   */
  readonly computesWriteNothing?: boolean
  readonly source: string
}
// ---- MENGERHIVE block begin ----
/** The wave run's action word, named once here: the guard in tests/x6/kyber-cpu.spec.ts counts this one block. */
const HIVE_ACTION = 'hive'
// ---- MENGERHIVE block end ----
export const VOICE_OPEN_FAST_READS: Readonly<Record<string, VoiceOpenFastRead>> = deepFreeze({
  // Its action has no closed enum, and its name ends in `_verify`: before the voice safety change the name rule alone let EVERY action
  // through from the fast voice (it was recorded as refused from voice; only a look-only turn refused it). Now exactly
  // its two actions: `verify` (its default) judges her own candidate, `capture` returns the edge's answers verbatim.
  x6_checkpoint_verify: { origin: 'builtin', selector: 'action', absent: 'verify', values: ['verify', 'capture'],
    source: 'checkpoint-verify-tool.ts: GET-only edge reads with her own session, writes nothing; ball-loader.ts classifyActionIrreversibility verifier hook (90040d47): class 0' },
  // `op: "read"` is one GET of /_host/crew-relay (ball-loader.ts crew_relay); `say` posts under the owner's name.
  crew_relay: { origin: 'builtin', selector: 'op', values: ['read'], onlyArgs: ['op', 'after'],
    source: 'ball-loader.ts crew_relay: op read is GET /_host/crew-relay?after=; classifyActionIrreversibility RELAYREAD hook: class 0' },
  // The spoken cell run (): her fast voice may run a cell and say the result. Each action judged from
  // its code in ball-loader.ts x6_cell execute, never its name; each call may carry only the arguments that action reads
  // (so never `promote`, `wat`, `replace`, `step`, `kind` or `type`):
  //  - compute / run: cells.invoke of a PINNED cell (wasm-cells.ts load(cell, CELL_PINS pin), zero imports, fresh fuel);
  //    its only trace is the in-memory cell journal (a session fact, never stored).
  //  - run_forged: runKeptCell READS a kept cell's WAT and bytes and runs only bytes rebuilt by the pinned compiler that
  //    hash to the kept SHA-256 (zero imports); it writes nothing (forge and forget are the writers: no row).
  //  - handoff: cellHandoff, two local runs of the pinned CPU cell and one POST /_host/cell-run, which reads and
  //    writes no storage (the edge's cell module: "a pure computation").
  //  - carry: pentoraCarry, two same-origin GETs of public files and the pinned pentora-codec cell; writes nothing.
  //  - observe: pentoraEpistemicTool, a pure function of its input; no cell host.
  //  - hive: mengerRun, local wave-cell calls and stateless POSTs of /_host/cell-run; writes nothing.
  //  - forged: listForgedCells + forgedSourceState, reads of her kept cells' files; writes nothing. It ran from the fast
  //    voice before this row by her capability index's enum (READ_VERB): kept here so the row takes no read away.
  // Not here, so refused from the fast voice: forge and forget (write /dsh/home), compile_and_run (runs any WAT the model
  // writes), cord start and feed (they write her cord shelf folder; cord status is already a look-only row).
  // The runtime classifier still has to class the exact call 0 (it does for every value here).
  x6_cell: { origin: 'builtin', selector: 'action', computesWriteNothing: true,
    values: ['compute', 'run', 'run_forged', 'handoff', 'carry', 'observe', HIVE_ACTION, 'forged'],
    argsByValue: {
      compute: ['action', 'cell', 'op', 'input'], run: ['action', 'cell', 'op', 'input'],
      run_forged: ['action', 'cell', 'op', 'input', 'fuel'], handoff: ['action', 'cell', 'input', 'cutAt'],
      carry: ['action', 'what', 'drop'], observe: ['action', 'input'],
      hive: ['action', 'ticks', 'cut', 'edgeOrgan', 'handoverOrgan', 'seed', 'wiring'], forged: ['action'],
    },
    source: 'ball-loader.ts x6_cell execute (cells.invoke, runKeptCell, cellHandoff, pentoraCarry, pentoraEpistemicTool, mengerRun); '
      + 'listForgedCells; classifyActionIrreversibility: compute/run/observe by the verb list, forged, run-forged, handoff, carry, '
      + 'observe, hive hooks: class 0' },
  // the voice safety change V1-1: edge values of the look-only table that are not proven (`edgeProven: false`) run from the fast
  // voice only through these rows; each is read from its code. x6_exec `logs` has no row (VOICE_OPEN_STILL_REFUSED).
  //  - x6_repo selftest, diagnostics, bytes, compare_files, diff, state_diff: POST /_host/repo reads (ball-loader.ts
  //    x6_repo, the tool's description: "inspects", "compares", "returns", "read history"); the writers have no row.
  x6_repo: { origin: 'builtin', selector: 'action', values: ['selftest', 'diagnostics', 'bytes', 'compare_files', 'diff', 'state_diff'],
    source: 'ball-loader.ts x6_repo: POST /_host/repo reads; classifyActionIrreversibility: class 0 by the read verbs' },
  //  - head_adopt: describePublishedHead, one GET of /_head/ball; never `force` (no argument at all).
  head_adopt: { origin: 'builtin', selector: 'whole', values: ['*'], onlyArgs: [],
    source: 'ball-loader.ts head_adopt describePublishedHead GET /_head/ball; classifier head-adopt line: class 0 only without force' },
  //  - x6_facts, self_facts, ball_status (host facts): readX6Facts, same-origin GETs with redirect "error", 64 KiB bound.
  x6_facts: { origin: 'builtin', selector: 'whole', values: ['*'], onlyArgs: [], source: 'ball-loader.ts readX6Facts same-origin GETs' },
  self_facts: { origin: 'builtin', selector: 'whole', values: ['*'], onlyArgs: [], source: 'ball-loader.ts readX6Facts same-origin GETs' },
  ball_status: { origin: 'builtin', selector: 'includeManifest', absent: 'false', values: ['false'], onlyArgs: ['includeManifest'],
    source: 'ball-loader.ts ball_status: includeManifest not true is readX6Facts (same-origin GETs)' },
  //  - x6_web_eyes search: POST /_host/web-eyes, a search of the open web (`status` is a local row; `fetch` has no row).
  x6_web_eyes: { origin: 'builtin', selector: 'action', values: ['search'], onlyArgs: ['action', 'query', 'limit'],
    source: 'ball-loader.ts x6_web_eyes search POST /_host/web-eyes' },
  // Review fix: her preset's `web_search` has no row. It takes several `queries`, each a paid provider call from her tab
  // (web-search-deepseek provider.ts), outside the fast voice's budget; `x6_web_eyes` `search` is her web from voice.
} satisfies Record<string, VoiceOpenFastRead>)

/** What a call of the fast voice may be judged by at voice level `open`, besides the look-only table. */
export interface VoiceOpenReadInput extends VoiceVerdictInput {
  /** Her capability index's classification of the registered tool (capability-index.ts classifyToolMutation), or null.
   * `basis` (capability-index.ts classifyReadBasis) says what a whole-tool `readOnly` rests on; absent, it is not trusted. */
  readonly mutation: {
    readonly readOnly: boolean
    readonly actions?: { readonly read: readonly string[]; readonly write: readonly string[] }
    readonly basis?: 'actions' | 'listed' | 'declared' | 'name' | 'none'
  } | null
  /** The parameter names the registered tool declares (summarizeParameters). A model-added `action`, `kind` or `type`
   * the tool does not declare is refused: the runtime classifier reads those words, the tool ignores them. */
  readonly parameterNames: readonly string[]
  /** True only when her tool registry mounted this exact `x6t_` tool as read-only (ball-loader.ts mountedToolsReadOnly). */
  readonly mountedReadOnly?: boolean
  /**
   * The runtime's own invocation classifier for this exact call (ball-loader.ts classifyActionIrreversibility, the one
   * enforceToolInvocation uses: "unknown operations require mutation admission, never read access"), passed in so this
   * pure file imports no runtime. Only class 0 runs.
   */
  readonly runtimeClass: (call: Record<string, unknown>) => number
}

/**
 * Review fix: calls the runtime classifier classes 0 that are not pure reads (they write, stage, run a cell, compute at
 * the edge, fetch, or spend). The fast voice refuses them whatever else says read: by the tool's name (dashes for
 * underscores), or by the operation word the classifier reads (`action ?? kind ?? type`). One exception, by row, never by
 * word: the values of a VOICE_OPEN_FAST_READS row marked `computesWriteNothing` (x6_cell only: the spoken cell run).
 */
export const VOICE_FAST_NOT_READS = deepFreeze({
  tools: ['ball-put', 'pearl-put', 'stage-head-promotion', 'stage-organ-promotion', 'x6-consult', 'x6-swarm'],
  operations: ['compute', 'run', 'compile-and-run', 'run-forged', 'fetch', 'trial', 'draft', 'challenge', 'attest', 'handoff', 'carry',
    HIVE_ACTION, 'observe'],
})
/**
 * The wave action of `x6_cell` posts to her edge once per tick (the wave runner module, `POST /_host/cell-run`,
 * unbatched); from the fast voice a call may ask at most this many ticks (its own default, 24, runs).
 */
export const VOICE_FAST_HIVE_MAX_TICKS = 24
/** The words the runtime classifier reads as the operation (ball-loader.ts classifyActionIrreversibility). */
const OPERATION_KEYS = ['action', 'kind', 'type'] as const

/** How far the fast voice's argument scan reaches: 4 deep, 256 strings. A call past either is refused, never half read. */
export const VOICE_ARG_SCAN_LIMITS = Object.freeze({ depth: 4, strings: 256 })

/** Every string inside `value` (objects and arrays), or null when it holds more than the scan reaches (fail closed). */
function stringsIn(value: unknown, out: string[] = [], depth = 0): string[] | null {
  const deep = typeof value === 'string' || Array.isArray(value) || plainRecord(value)
  if (!deep) return out
  if (depth > VOICE_ARG_SCAN_LIMITS.depth) return null
  if (typeof value === 'string') {
    if (out.length >= VOICE_ARG_SCAN_LIMITS.strings) return null
    out.push(value)
    return out
  }
  for (const item of Array.isArray(value) ? value : Object.values(value)) {
    if (stringsIn(item, out, depth + 1) === null) return null
  }
  return out
}

/**
 * the voice safety change fix 2 (review): a RELATIVE argument string (`private/x`, `./private/x`, `../sessions/x`, or free text such as
 * a search query) as the folder it could reach: joined to her voice home's folder, VOICE_HOME_CWD, with `.` and `..`
 * folded, since her tools resolve a relative path against a working folder this check cannot see. Only `/` separates;
 * a backslash or a long string is text, never a refusal. Judged by folder only (the file-name rule is for absolute paths).
 */
function relativeFolder(value: string): string {
  const parts = VOICE_HOME_CWD.split('/').filter(part => part !== '')
  for (const part of value.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return '/' + parts.join('/')
}
const inside = (resolved: string, root: string): boolean => resolved === root || resolved.startsWith(root + '/')

/**
 * One call of her FAST voice at voice level `open`, where a spoken governed turn of hers may call every
 * tool. The fast voice still changes nothing: it may run what the look-only table allows (`refusal` undefined), or, when
 * that table only says "not on my voice list", a call that BOTH (a) is written as a read for that exact call (a look-only
 * row's value, a VOICE_OPEN_FAST_READS row, an `x6t_` tool her registry mounted read-only (rule D2), the selected `action`
 * among a closed enum's read actions, or a whole tool listed or declared read-only; never a tool's name alone, the voice safety change)
 * AND (b) the runtime's invocation classifier classes 0. Never: an organ's tool (their reads may sync or
 * fetch first, voice-organ-pins.ts), a row whose path, pattern, class or argument rule refused it, a name in
 * VOICE_OPEN_STILL_REFUSED, or an argument that reaches her private folder or raw thread logs.
 * @param input - the call, who registered it, and her capability index's classification.
 * @param refusal - voiceVerdict's answer for the same call.
 * @returns undefined when it may run, else the refusal.
 */
export function voiceOpenFastVerdict(input: VoiceOpenReadInput, refusal: string | undefined): string | undefined {
  if (refusal === undefined) return undefined
  const tool = typeof input.tool === 'string' ? input.tool.replace(/-/g, '_') : ''
  const args = input.args === undefined ? {} : input.args
  if (!refusal.startsWith('VOICE_LOOK_ONLY: I can look, I cannot change things from voice yet.') || input.origin.kind === 'organ'
    || !/^[A-Za-z0-9_]{1,64}$/.test(tool) || !plainRecord(args)) return refusal
  const row = Object.hasOwn(VOICE_SWITCH_TABLE, tool) ? VOICE_SWITCH_TABLE[tool] : undefined
  /** The look-only table names this exact selector value as a read (switched off for a look-only turn, but written). */
  let tabled = false
  /** the voice safety change V1-1: the table names it as an edge read that no edge test proved: only an explicit fast row runs it. */
  let unprovenEdge = false
  if (row !== undefined) {
    if (row.paths !== undefined || row.patterns !== undefined || row.origin !== input.origin.kind) return refusal
    // An absent selector is the row's own `absent` value, as voiceVerdict reads it (ball_status: includeManifest false).
    const raw = row.selector === 'whole' ? '*' : Object.hasOwn(args, row.selector) ? args[row.selector] : row.absent
    const key = typeof raw === 'string' ? raw : typeof raw === 'boolean' ? String(raw) : undefined
    const value = key !== undefined && Object.hasOwn(row.values, key) ? row.values[key] : undefined
    const ruled = value !== undefined && (value.argEquals !== undefined || value.argPatterns !== undefined || value.requires !== undefined)
    if (ruled) return refusal
    tabled = value !== undefined && (value.where === 'local' || value.edgeProven)
    unprovenEdge = value !== undefined && !tabled
  }
  const action = typeof args.action === 'string' ? args.action : typeof args.subAction === 'string' ? args.subAction : null
  const still = Object.hasOwn(VOICE_OPEN_STILL_REFUSED, tool) ? VOICE_OPEN_STILL_REFUSED[tool] ?? [] : []
  if (still.includes('*') || (action !== null && still.includes(action))) return refusal
  if (tool === 'x6_github' && input.githubClass !== 0) return refusal
  // the voice safety change fix 1, (a): the read is WRITTEN somewhere for this exact call, never inferred from the tool's name: a
  // look-only row's value, an explicit fast-voice row, an x6t_ tool her registry mounted read-only (rule D2),
  // a closed action enum judged per action, or a whole tool listed or declared read-only.
  const fastRow = Object.hasOwn(VOICE_OPEN_FAST_READS, tool) ? VOICE_OPEN_FAST_READS[tool] : undefined
  const mutation = input.mutation
  // Review fix: the classifier reads `action ?? kind ?? type`; a word the tool does not declare would decide (b) while the
  // tool ignores it (head_adopt {action:"status"}).
  for (const key of OPERATION_KEYS) {
    if (Object.hasOwn(args, key) && !input.parameterNames.includes(key)) return refusal
  }
  let read: boolean
  /** The call is one of an explicit compute row's values (x6_cell): only then may its verb pass VOICE_FAST_NOT_READS. */
  let explicitCompute = false
  if (fastRow !== undefined) {
    const given = fastRow.selector === 'whole' ? '*' : Object.hasOwn(args, fastRow.selector) ? args[fastRow.selector] : fastRow.absent
    // A boolean selector (ball_status includeManifest) is judged by its text, as the look-only table reads it.
    const raw = typeof given === 'boolean' ? String(given) : given
    const allowed = typeof raw === 'string' && fastRow.argsByValue !== undefined
      ? (Object.hasOwn(fastRow.argsByValue, raw) ? fastRow.argsByValue[raw] : []) : fastRow.onlyArgs
    read = fastRow.origin === input.origin.kind && typeof raw === 'string' && fastRow.values.includes(raw)
      && (allowed === undefined || Object.keys(args).every(key => allowed.includes(key)))
    explicitCompute = read && fastRow.computesWriteNothing === true
    if (read && tool === 'x6_cell' && raw === HIVE_ACTION && args.ticks !== undefined
      && !(typeof args.ticks === 'number' && Number.isSafeInteger(args.ticks) && args.ticks >= 1 && args.ticks <= VOICE_FAST_HIVE_MAX_TICKS)) read = false
  } else {
    // An x6t_ name reads only when her tool registry mounted that exact tool read-only: never by its prefix, and no other
    // registrant of such a name passes by a declaration or an enum (the runtime classifier classes every x6t- name 0).
    read = tool.startsWith('x6t_') ? input.mountedReadOnly === true : unprovenEdge ? false : tabled
      || (mutation?.actions !== undefined ? action !== null && mutation.actions.read.includes(action)
        : mutation?.readOnly === true && (mutation.basis === 'listed' || mutation.basis === 'declared'))
  }
  if (!read) return refusal
  const operationWord = args.action ?? args.kind ?? args.type
  const operation = typeof operationWord === 'string' ? operationWord.replace(/_/g, '-').toLowerCase() : ''
  if (VOICE_FAST_NOT_READS.tools.includes(tool.replace(/_/g, '-').toLowerCase())
    || (!explicitCompute && VOICE_FAST_NOT_READS.operations.includes(operation))) {
    return refusal
  }
  // (b): the runtime's own invocation classifier says this exact call is a read (class 0). Anything else, refused.
  if (input.runtimeClass({ ...args, tool }) !== 0) return refusal
  // the voice safety change fix 2: every string; a call the scan cannot read whole is refused. An absolute path by the full rule (as on
  // an earlier commit); a relative string by the folder it reaches from her home only, so free text (a query, a candidate's
  // bytes) is never judged as a file name.
  const strings = stringsIn(args)
  if (strings === null) return refusal
  for (const value of strings) {
    if (value === '') continue
    if (value.startsWith('~')) return refusal
    if (value.startsWith('/')) {
      const resolved = resolveVoicePath(value)
      if (resolved === null) return refusal
      if (privatePath(resolved) || contains(resolved, PRIVATE_ROOT)) return VOICE_PRIVATE_REFUSAL
      if (threadLogPath(resolved) || contains(resolved, SESSIONS_ROOT)) return VOICE_THREAD_LOGS_REFUSAL
      const memory = memoryHomeRefusal(resolved)
      if (memory !== undefined) return memory
      continue
    }
    if (value.includes('\0')) return VOICE_RELATIVE_PATH_REFUSAL
    const folder = relativeFolder(value)
    if (inside(folder, PRIVATE_ROOT)) return VOICE_PRIVATE_REFUSAL
    if (inside(folder, SESSIONS_ROOT) || threadLogPath(folder)) return VOICE_THREAD_LOGS_REFUSAL
    // Strictly below it: a bare word such as a search query "voice" is free text, never the folder itself.
    if (folder.startsWith(VOICE_MEMORY_HOME + '/')) return VOICE_MEMORY_HOME_REFUSAL
    if (folder.startsWith(MEMORY_TIMELINE_HOME + '/')) return MEMORY_TIMELINE_HOME_REFUSAL
  }
  return undefined
}

/**
 * the voice safety change V2-1: would `read` refuse this file, found by `grep` or `glob` under `root`? Their path rule judges only the
 * folder they search; each entry they return is judged here as `read` judges a `file_path`: inside the private folder, a
 * key-like name (browser-estate.ts estateRedaction), her raw thread logs or a memory store. A relative entry (her tools
 * answer paths relative to their working folder) is judged against the searched folder AND her home, withheld if either
 * reaches what voice never opens; an entry that cannot be resolved honestly is withheld.
 */
export function voiceSearchEntryWithheld(entry: string, root: unknown): boolean {
  const bases = [VOICE_HOME_CWD, ...(typeof root === 'string' && root.startsWith('/') ? [root] : [])]
  const candidates = entry.startsWith('/') ? [resolveVoicePath(entry)] : bases.map(base => resolveVoicePath(`${base}/${entry}`))
  return candidates.some(resolved => resolved === null || privatePath(resolved) || threadLogPath(resolved)
    || memoryHomeRefusal(resolved) !== undefined)
}

/**
 * The path arguments of this call (the look-only row's `paths`: read and read_image
 * `file_path`, glob and grep `path`, x6_browser_estate `root`) judged at their REAL location, as `realpath` answers it
 * (symbolic links resolved; voice-scratch.ts refuses links on its own way). A path that does not exist yet is judged as
 * written (voiceVerdict did). Undefined when every real location may be read, else the refusal.
 */
export function voiceRealPathRefusal(tool: string, args: unknown, realpath: (path: string) => string): string | undefined {
  const row = Object.hasOwn(VOICE_SWITCH_TABLE, tool) ? VOICE_SWITCH_TABLE[tool] : undefined
  if (row?.paths === undefined || !plainRecord(args)) return undefined
  for (const rule of row.paths) {
    const resolved = resolveVoicePath(args[rule.arg])
    if (resolved === null) continue
    let real: string | null
    try { real = resolveVoicePath(realpath(resolved)) } catch { continue }
    if (real === null) return voiceRefusal(tool)
    if (privatePath(real) || (rule.refuseContaining && contains(real, PRIVATE_ROOT))) return VOICE_PRIVATE_REFUSAL
    if (threadLogPath(real) || (rule.refuseContaining && contains(real, SESSIONS_ROOT))) return VOICE_THREAD_LOGS_REFUSAL
    const memory = memoryHomeRefusal(real)
    if (memory !== undefined) return memory
  }
  return undefined
}

/** The note a voice search answer carries when entries were withheld (never the names). */
export const voiceSearchWithheldNote = (count: number): string =>
  `[${String(count)} result${count === 1 ? '' : 's'} withheld from voice: private or key-like files]`

/**
 * the voice safety change V2-1: `grep` and `glob` results with every entry `voiceSearchEntryWithheld` judges withheld removed, and how
 * many. Their values as her tools answer them (tool-fs-search grep.ts `{ matches: [{ path, lineNumber, line }] }`, glob.ts
 * `{ root, paths }`), or their rendered text (grep: a path line then `Line N:` rows per file, files apart by a blank line;
 * glob: one path a line). Any other tool, or a shape not known here, is returned as it came (count 0).
 */
export function withholdVoiceSearchEntries(tool: string, args: unknown, out: unknown): { out: unknown; withheld: number } {
  if (tool !== 'grep' && tool !== 'glob') return { out, withheld: 0 }
  const root = plainRecord(args) ? args.path : undefined
  const hidden = (entry: unknown): boolean => typeof entry !== 'string' || voiceSearchEntryWithheld(entry, root)
  if (plainRecord(out) && Array.isArray(out.matches)) {
    const kept = out.matches.filter(match => !(plainRecord(match) ? hidden(match.path) : true))
    return { out: { ...out, matches: kept }, withheld: out.matches.length - kept.length }
  }
  if (plainRecord(out) && Array.isArray(out.paths)) {
    const kept = out.paths.filter(path => !hidden(path))
    return { out: { ...out, paths: kept }, withheld: out.paths.length - kept.length }
  }
  if (typeof out !== 'string') return { out, withheld: 0 }
  if (tool === 'glob') {
    const lines = out.split('\n')
    const kept = lines.filter(line => line.trim() === '' || !hidden(line.trim()))
    return { out: kept.join('\n'), withheld: lines.length - kept.length }
  }
  // grep text: a section whose first line is a file path and whose other lines are `Line N:` rows.
  let withheld = 0
  const sections = out.split('\n\n').filter((section) => {
    const [first, ...rows] = section.split('\n')
    const isFile = first !== undefined && rows.length > 0 && rows.every(row => /^Line \d+: /.test(row))
    if (!isFile || !hidden(first)) return true
    withheld += rows.length
    return false
  })
  return { out: sections.join('\n\n'), withheld }
}

/** One session event as the worker sees it (core/session/src/types.ts:501-508). */
export interface VoiceSessionEvent { readonly type: string; readonly seq: number; readonly data?: unknown }
/** The session's own record: its header (core/session/src/types.ts:95-136) and its event log. */
export interface VoiceHomeRecord {
  readonly sessionId: string
  readonly header: {
    readonly id?: unknown
    readonly cwd?: unknown
    readonly agentPreset?: unknown
    readonly parentSession?: unknown
    readonly origin?: unknown
    readonly delegationDepth?: unknown
    readonly isSeeded?: unknown
  }
  readonly events: readonly VoiceSessionEvent[]
}

/**
 * Prove from the session's own record that it is the voice home ensureVoiceSession made: its header says
 * working folder /dsh/home/auma and preset auma-alien, it is an ordinary top-level session (no parent, not a subagent,
 * not a fork), it carries at least one title event, every title it ever had is "[voice] Auma Live" set by a user
 * rename, and it was so named before any message entered it. A working thread renamed later (genesis-live.js:246-252
 * renames whatever id sits in localStorage) fails the last rule, so it is never made look-only by mistake.
 */
export function voiceHomeProof(record: VoiceHomeRecord): { ok: true } | { ok: false; reason: string } {
  const h = record.header
  if (h.id !== record.sessionId) return { ok: false, reason: 'header-id' }
  if (h.cwd !== VOICE_HOME_CWD) return { ok: false, reason: 'cwd' }
  if (h.agentPreset !== VOICE_HOME_PRESET) return { ok: false, reason: 'preset' }
  if (h.parentSession !== undefined || h.origin !== undefined || (h.delegationDepth !== undefined && h.delegationDepth !== 0)) {
    return { ok: false, reason: 'not-top-level' }
  }
  if (h.isSeeded !== false) return { ok: false, reason: 'forked' }
  let firstTitle: number | null = null
  let firstMessage: number | null = null
  for (const event of record.events) {
    if (event.type === 'session/title') {
      const data = plainRecord(event.data) ? event.data : {}
      const source = plainRecord(data.source) ? data.source : {}
      if (data.title !== VOICE_HOME_TITLE || source.kind !== 'user') return { ok: false, reason: 'title' }
      firstTitle ??= event.seq
    }
    if (event.type === 'user/message') firstMessage ??= event.seq
  }
  if (firstTitle === null) return { ok: false, reason: 'untitled' }
  if (firstMessage !== null && firstMessage < firstTitle) return { ok: false, reason: 'named-after-use' }
  return { ok: true }
}

/**
 * Could this session be a voice home, judged from its immutable header alone (the static half of voiceHomeProof)? A
 * marked session always passes this, so while the marks are not loaded it is the sound over-approximation of "marked".
 * No header (or not an object) counts as "could be": unknown fails closed.
 */
export function couldBeVoiceHome(header: unknown): boolean {
  if (header === null || typeof header !== 'object') return true
  const h = header as Record<string, unknown>
  return h.cwd === VOICE_HOME_CWD && h.agentPreset === VOICE_HOME_PRESET && h.parentSession === undefined
    && h.origin === undefined && (h.delegationDepth === undefined || h.delegationDepth === 0) && h.isSeeded === false
}

/** A user message the page marked as spoken: its source is the user and its first text part is the spoken provenance. */
export function isSpokenUserMessage(message: unknown): boolean {
  if (!plainRecord(message)) return false
  const source = message.source
  if (!plainRecord(source) || source.kind !== 'user' || !Array.isArray(message.content)) return false
  const first = message.content.find(part => plainRecord(part) && part.type === 'text') as Record<string, unknown> | undefined
  return typeof first?.text === 'string' && first.text.startsWith(SPOKEN_PROVENANCE_PREFIX)
}
