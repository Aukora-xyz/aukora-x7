/**
 * `x6_exec`: her hands on a real Linux machine. A thin caller of her exec door at the edge
 * (deploy/cloudflare/src/cloud-brokers.mjs execDoor), which starts `.github/workflows/auma-exec.yml` on a throwaway GitHub
 * runner with no secret and reads, cancels or lists its runs. Nothing here decides what may run: the edge validates the
 * inputs and holds the hour and day bounds; this file only shapes her call and finds her run by its label.
 *
 * Classification: `run` and `cancel` spend runner minutes or stop a run, so they are not reads (and a look-only voice turn
 * refuses them); `status`, `logs`, `list` and `artifacts` are reads. It writes nothing in her home.
 * @module x6/exec-tool
 */

export const EXEC_TOOL_ACTIONS = Object.freeze(['run', 'status', 'logs', 'cancel', 'list', 'artifacts'] as const)
export type ExecToolAction = typeof EXEC_TOOL_ACTIONS[number]
export const EXEC_TOOL_READS: readonly string[] = Object.freeze(['status', 'logs', 'list', 'artifacts'])
/** After a dispatch, how many times and how far apart she looks for the run before answering `pending`. A label she
 * chooses is at most `labelChars` long: `-` and 8 hex are added so that every run's label names that run alone. */
export const EXEC_TOOL_LIMITS = Object.freeze({ polls: 4, pollMs: 2500, answerBytes: 300 * 1024, labelChars: 55 })
export const EXEC_WORKFLOW_FILE = 'auma-exec.yml'

/** The fields each action takes; any other field is refused before anything is sent. */
const FIELDS: Readonly<Record<ExecToolAction, readonly string[]>> = Object.freeze({
  run: ['action', 'command', 'ref', 'timeoutMinutes', 'browser', 'label'],
  status: ['action', 'run', 'label'],
  logs: ['action', 'run', 'job'],
  cancel: ['action', 'run'],
  list: ['action'],
  artifacts: ['action', 'run'],
})

export const EXEC_TOOL_DESCRIPTION =
  'Your hands: run a command on a real Linux machine and watch it. Each run gets a fresh GitHub runner with Node, pnpm, '
  + 'Python 3, git, gh (not signed in), jq and rg, your repository checked out at `ref` (main or one of your auma/ branches) '
  + 'and its dependencies installed. It holds no secret and cannot change GitHub. What a command changes does NOT come back '
  + 'by itself: print a diff, or write files under $ARTIFACTS (kept 3 days), and commit through x6_repo. A run takes one to '
  + 'three minutes to start and at most 30 minutes to run, one at a time per branch; `browser: true` adds headless Chromium. '
  + 'How to call it. `run` { command (bash, at most 4,096 characters, in the repository root), ref? (default main), '
  + 'timeoutMinutes? (1 to 30, default 10), browser?, label? (1 to 55 of A-Z a-z 0-9 . _ -; `-` and 8 hex are added so '
  + 'each run\'s label is its own; one is made if absent) } starts it and answers { run, label, status, url }, or '
  + '{ pending: true, label } when GitHub has not shown it yet: then `status` { label } with that full label finds it. '
  + '`status` { run | label }; `logs` { run, job? } (the newest 252 KiB of a log up to 32 MiB; `earlier` says where the rest is); '
  + '`cancel` { run }; `list` (your newest 20 runs); `artifacts` { run } (names, sizes, expiry; download them on the run\'s page). '
  + 'It runs as an ordinary user without sudo. Bounds: 60 runs an hour and 300 a day, counted by each edge instance in '
  + 'memory, not durably (EXEC_RATE_LIMITED names `retryAt`). Refusals: EXEC_REF_INVALID, '
  + 'EXEC_COMMAND_INVALID, EXEC_TIMEOUT_INVALID, EXEC_BROWSER_INVALID, EXEC_LABEL_INVALID, EXEC_RUN_NOT_FOUND (not a run of '
  + 'yours), EXEC_RUN_NOT_CANCELLABLE (already finished). Your page: docs/auma/exec.md.'

export const EXEC_TOOL_PARAMETERS = Object.freeze({
  action: { type: 'string', required: true, enum: [...EXEC_TOOL_ACTIONS], description: '`run` starts a command; `status`, `logs`, `list`, `artifacts` read; `cancel` stops a run.' },
  command: { type: 'string', description: 'For run: the bash command (bash -eo pipefail -c), at most 4,096 characters.' },
  ref: { type: 'string', description: 'For run: main (default) or auma/sandbox/<slug> or auma/proposal/<slug>.' },
  timeoutMinutes: { type: 'number', description: 'For run: 1 to 30 (default 10).' },
  browser: { type: 'boolean', description: 'For run: true adds headless Chromium for Playwright.' },
  label: { type: 'string', description: 'For run: 1 to 55 of A-Z a-z 0-9 . _ - (`-` and 8 hex are added; made if absent). For status: the full label run answered.' },
  run: { type: 'number', description: 'The run id (from run, status or list).' },
  job: { type: 'number', description: 'For logs: a job id of that run (default its one job).' },
})

type Json = Record<string, unknown>
export interface ExecToolDeps {
  /** One POST of `body` to her edge's /_host/repo; resolves with its JSON answer (an `{ ok: false, code }` on refusal). */
  readonly post: (body: Json) => Promise<Json>
  readonly sleep?: (ms: number) => Promise<void>
  /** 8 lowercase hex characters for a label she did not give. */
  readonly randomHex?: () => string
}

const record = (value: unknown): value is Json => value !== null && typeof value === 'object' && !Array.isArray(value)
const defaultHex = (): string => Array.from(crypto.getRandomValues(new Uint8Array(4)), byte => byte.toString(16).padStart(2, '0')).join('')
const refused = (code: string, extra: Json = {}): Json => ({ ok: false, code, sent: false, ...extra })

/** The runs of an `exec_runs` answer that carry this label, newest first (GitHub lists newest first). */
function runsLabelled(answer: Json, label: string): Json[] {
  const runs = Array.isArray(answer.runs) ? answer.runs.filter(record) : []
  return runs.filter(run => run.label === label)
}

const runAnswer = (run: Json, label: string): Json => ({ ok: true, run: run.id, label, ref: run.ref, status: run.status,
  conclusion: run.conclusion ?? null, url: run.url })

/** Her x6_exec tool over an edge `post`. */
export function createExecTool(deps: ExecToolDeps) {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)))
  const randomHex = deps.randomHex ?? defaultHex

  async function run(args: Json): Promise<Json> {
    // Every dispatched label is new: a label she chose gets `-` and 8 hex, so neither the search below nor her later
    // `status { label }` can answer an earlier run of the same name.
    if (args.label !== undefined && (typeof args.label !== 'string' || args.label === '' || args.label.length > EXEC_TOOL_LIMITS.labelChars)) {
      return refused('EXEC_LABEL_INVALID', { next: `1 to ${String(EXEC_TOOL_LIMITS.labelChars)} of A-Z a-z 0-9 . _ -; \`-\` and 8 hex are added` })
    }
    const label = args.label === undefined ? `x-${randomHex()}` : `${args.label}-${randomHex()}`
    const ref = args.ref === undefined ? 'main' : args.ref
    const inputs: Json = { ref, command: args.command, label }
    if (args.timeoutMinutes !== undefined) inputs.timeout_minutes = typeof args.timeoutMinutes === 'number' ? String(args.timeoutMinutes) : args.timeoutMinutes
    if (args.browser !== undefined) inputs.browser = typeof args.browser === 'boolean' ? String(args.browser) : args.browser
    const dispatched = await deps.post({ action: 'dispatch_workflow', workflow: EXEC_WORKFLOW_FILE, inputs })
    if (dispatched.ok !== true) return { ...dispatched, sent: false }
    for (let poll = 0; poll < EXEC_TOOL_LIMITS.polls; poll += 1) {
      await sleep(EXEC_TOOL_LIMITS.pollMs)
      const listed = await deps.post({ action: 'exec_runs' })
      const found = listed.ok === true ? runsLabelled(listed, label)[0] : undefined
      if (found) return runAnswer(found, label)
    }
    return { ok: true, pending: true, label, ref, next: `GitHub has not shown the run yet: x6_exec status { label: "${label}" } finds it (a run takes one to three minutes to start).` }
  }

  async function status(args: Json): Promise<Json> {
    if (args.run !== undefined && args.label !== undefined) return refused('EXEC_FIELDS_INVALID', { next: 'give run or label, not both' })
    if (args.run !== undefined) return await deps.post({ action: 'exec_run', run: args.run })
    if (typeof args.label !== 'string') return refused('EXEC_FIELDS_INVALID', { next: 'give run or label' })
    const listed = await deps.post({ action: 'exec_runs' })
    if (listed.ok !== true) return listed
    const found = runsLabelled(listed, args.label)[0]
    return found ? runAnswer(found, args.label)
      : { ok: true, pending: true, found: false, label: args.label, next: 'not among your newest 20 runs yet; ask again in a minute' }
  }

  return {
    async execute(args: Json): Promise<Json> {
      const action = args.action
      if (typeof action !== 'string' || !(EXEC_TOOL_ACTIONS as readonly string[]).includes(action)) return refused('EXEC_ACTION_INVALID', { actions: [...EXEC_TOOL_ACTIONS] })
      const unknown = Object.keys(args).filter(key => !FIELDS[action as ExecToolAction].includes(key) && args[key] !== undefined)
      if (unknown.length > 0) return refused('EXEC_FIELD_UNKNOWN', { fields: unknown })
      if (action === 'run') return await run(args)
      if (action === 'status') return await status(args)
      if (action === 'list') return await deps.post({ action: 'exec_runs' })
      if (action === 'logs') return await deps.post({ action: 'exec_logs', run: args.run, ...(args.job !== undefined ? { job: args.job } : {}) })
      if (action === 'cancel') return await deps.post({ action: 'exec_cancel', run: args.run })
      return await deps.post({ action: 'exec_artifacts', run: args.run })
    },
  }
}

/** One POST to /_host/repo on her page's origin, answered as JSON (bounded); a non-JSON answer is a closed code. */
export function execPost(origin: string, fetchImpl: typeof fetch = fetch) {
  return async (body: Json): Promise<Json> => {
    const res = await fetchImpl(new URL('/_host/repo', origin).href, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), credentials: 'same-origin',
    })
    const text = await res.text()
    if (new TextEncoder().encode(text).byteLength > EXEC_TOOL_LIMITS.answerBytes) return { ok: false, code: 'EXEC_ANSWER_TOO_LARGE', status: res.status }
    let answer: unknown
    try { answer = JSON.parse(text) } catch { return { ok: false, code: 'EXEC_ANSWER_NOT_JSON', status: res.status } }
    return record(answer) ? answer : { ok: false, code: 'EXEC_ANSWER_NOT_JSON', status: res.status }
  }
}
