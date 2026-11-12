/**
 * Aukora X5: `node` for the worker shell. Runs a CommonJS script (file, `-e`, `-p`, stdin)
 * in the HOST worker through the active WorkerModuleLoader's `require` (VFS packages and
 * node: shims), with captured console/stdout/stderr and `process.argv`/`exit`. Returned
 * promises and directly injected timers keep the command alive within a 30 s deadline;
 * otherwise it finishes after 500 ms without output. Completion clears only its own
 * timers, not external workers, module/global timers or promise side effects. External
 * async work needs an explicit returned promise. Synchronous work cannot be preempted.
 *
 * Aukora X6.1 Lane E3: an entry script with `import`/`export` (or `import.meta`) is lowered by the same runtime ESM
 * lowering the module loader uses, in strict mode, and its `.mjs` imports lower in the loader. `node --test <file...>`
 * resets the in-worker `node:test` harness, runs each file's body, drains its tests, prints Node's spec-style lines and
 * `ℹ` summary, and exits 0 iff at least one test ran and none failed or was cancelled (else 1; 124 past the deadline).
 */
import { lowerEsmRuntime, requireActiveModuleLoader } from '../../module-system/module-loader.ts'
import { dirname, pathToFileUrl, resolve } from '../../module-system/posix-path.ts'
import { requireActiveVfs } from '../../storage/active.ts'
import { harness } from '../../node/internal_modules/test-harness.ts'

/** Captured command output and status; a cooperative deadline expires with status 124. */
export interface NodeRunResult { exitCode: number; stdout: string; stderr: string }

class ExitSignal { constructor(readonly code: number) {} }

/** Module syntax that a CommonJS wrapper cannot compile. */
const ESM_SYNTAX = /^\s*(import\s[\s\S]*?from\s|import\s*['"]|export\s)|\bimport\.meta\b/m
/** Whole-invocation deadline for `node --test` (per-test timeouts come from the tests themselves). */
const TEST_DEADLINE_MS = 120_000

const fmt = (values: unknown[]): string => values.map((v) => {
  if (typeof v === 'string') return v
  if (v instanceof Error) return v.stack ?? String(v)
  try { return JSON.stringify(v, null, 2) ?? String(v) } catch { return String(v) }
}).join(' ')

/**
 * Evaluate CommonJS in the host worker with command-owned timers and captured output.
 * @param args - Node-style file, eval or print arguments.
 * @param cwd - Virtual working directory for module resolution.
 * @param stdin - Source used when no file or eval argument is supplied.
 * @returns Output and exit status after completion, explicit exit, failure or the 30 s deadline.
 */
export async function runNodeCommand(args: readonly string[], cwd: string, stdin: string): Promise<NodeRunResult> {
  const host = ((globalThis as unknown as { process?: Record<string, unknown> }).process ?? {}) as Record<string, unknown>
  if (args[0] === '--version' || args[0] === '-v') return { exitCode: 0, stdout: `${String(host.version ?? 'v24.0.0')}\n`, stderr: '' }
  if (args[0] === '--test') return runTestCommand(args.slice(1), cwd)
  let code: string
  let filename: string
  let print = false
  let rest: readonly string[]
  if (args[0] === '-e' || args[0] === '--eval' || args[0] === '-p' || args[0] === '--print') {
    print = args[0] === '-p' || args[0] === '--print'
    code = args[1] ?? ''
    filename = resolve(cwd, '[eval]')
    rest = args.slice(2)
  } else if (args[0] === undefined || args[0] === '-') {
    code = stdin
    filename = resolve(cwd, '[stdin]')
    rest = args.slice(1)
  } else {
    filename = resolve(cwd, args[0])
    try {
      code = requireActiveVfs().readFileSync(filename, 'utf8') as string
    } catch {
      return { exitCode: 1, stdout: '', stderr: `node: cannot find module '${filename}'\n` }
    }
    rest = args.slice(1)
  }
  return runEntry({ code, filename, print, rest, cwd })
}

interface EntryRun {
  readonly code: string
  readonly filename: string
  readonly print: boolean
  readonly rest: readonly string[]
  readonly cwd: string
  /** `node --test`: after the body ran, drain the test queue, then finish as soon as nothing is pending. */
  readonly testMode?: boolean
  /** Shared output sinks across the files of one `node --test` invocation. */
  readonly sink?: { out(t: string): void; err(t: string): void }
}

async function runEntry(entry: EntryRun): Promise<NodeRunResult> {
  const { filename, print, rest, cwd } = entry
  let code = entry.code
  let stdout = ''
  let stderr = ''
  let last = Date.now()
  let exitCode: number | undefined
  let syncPhase = true
  const out = (t: string): void => {
    if (exitCode !== undefined) return
    if (entry.sink) entry.sink.out(t); else stdout += t
    last = Date.now()
  }
  const err = (t: string): void => {
    if (exitCode !== undefined) return
    if (entry.sink) entry.sink.err(t); else stderr += t
    last = Date.now()
  }
  const host = ((globalThis as unknown as { process?: Record<string, unknown> }).process ?? {}) as Record<string, unknown>
  const deadline = entry.testMode ? TEST_DEADLINE_MS : 30_000
  if (code.startsWith('#!')) code = '//' + code
  const line = (sink: (t: string) => void) => (...v: unknown[]): void => { sink(fmt(v) + '\n') }
  const console_ = {
    log: line(out), info: line(out), debug: line(out), dir: line(out), table: line(out),
    warn: line(err), error: line(err), trace: line(err), time() {}, timeEnd() {}, assert() {},
  }
  const proc: Record<string, unknown> = Object.create(host as object) as Record<string, unknown>
  Object.assign(proc, {
    argv: ['/dsh/bin/node', filename, ...rest],
    cwd: () => cwd,
    // Throwing is only safe synchronously; from a timer it would be an uncaught error in the host worker.
    exit: (c?: number) => {
      if (exitCode !== undefined) return
      const code = c ?? (proc.exitCode as number | undefined) ?? 0
      if (syncPhase) throw new ExitSignal(code)
      exitCode = code
    },
    stdout: { write: (t: unknown) => { out(String(t)); return true }, isTTY: false },
    stderr: { write: (t: unknown) => { err(String(t)); return true }, isTTY: false },
    exitCode: undefined,
  })
  const onRejection = (event: PromiseRejectionEvent): void => {
    if (event.reason instanceof ExitSignal) { exitCode = event.reason.code; event.preventDefault() }
  }
  self.addEventListener('unhandledrejection', onRejection)
  const started = Date.now()
  const pendingTimers = new Map<number, ReturnType<typeof setTimeout>>()
  const fail = (error: unknown): void => {
    if (exitCode !== undefined) return
    try {
      if (error instanceof ExitSignal) { exitCode = error.code; return }
      err(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`)
    } catch {
      err('node: command failed; error could not be formatted\n')
    }
    exitCode = 1
  }
  try {
    // ESM entry (an .mjs file, or module syntax anywhere): lower it to the CommonJS wrapper, strict as ESM is.
    const esm = !print && (filename.endsWith('.mjs') || ESM_SYNTAX.test(code))
    const module = { exports: {} as unknown }
    const require = requireActiveModuleLoader().requireFrom(dirname(filename))
    const body = print ? `return (${code}\n)` : esm ? `'use strict';\n${lowerEsmRuntime(code)}` : code
    const meta = {
      url: pathToFileUrl(filename),
      resolve: (specifier: string): string => {
        const resolution = requireActiveModuleLoader().resolve(specifier, dirname(filename))
        return resolution.kind === 'static' ? resolution.specifier : pathToFileUrl(resolution.path)
      },
    }
    // Script timers report their own throws instead of raising them in the host worker.
    const guard = (cb: unknown) => (...a: unknown[]): void => {
      if (exitCode !== undefined || typeof cb !== 'function') return
      try { (cb as (...x: unknown[]) => void)(...a) } catch (error) { fail(error) }
    }
    const schedule = (cb: unknown, ms: number | undefined, repeat: boolean, args: unknown[]) => {
      if (exitCode !== undefined) return undefined
      const invoke = guard(cb)
      const fire = (): void => {
        if (!repeat) pendingTimers.delete(Number(timer))
        invoke(...args)
      }
      const timer = repeat ? setInterval(fire, ms) : setTimeout(fire, ms)
      pendingTimers.set(Number(timer), timer)
      return timer
    }
    const clear = (timer: ReturnType<typeof setTimeout> | number | string | undefined): void => {
      pendingTimers.delete(Number(timer))
      // Timeout and interval handles share the browser timer id pool; immediates use timeouts.
      clearTimeout(timer)
    }
    const timers = {
      setTimeout: (cb: unknown, ms?: number, ...a: unknown[]) => schedule(cb, ms, false, a),
      setInterval: (cb: unknown, ms?: number, ...a: unknown[]) => schedule(cb, ms, true, a),
      setImmediate: (cb: unknown, ...a: unknown[]) => schedule(cb, 0, false, a),
    }
    const fn = new Function(
      'exports', 'require', 'module', '__filename', '__dirname', 'process', 'console',
      'setTimeout', 'setInterval', 'setImmediate', 'clearTimeout', 'clearInterval', 'clearImmediate', '__dsh$meta', body,
    ) as (...a: unknown[]) => unknown
    const evaluated = fn(
      module.exports, require, module, filename, dirname(filename), proc, console_,
      timers.setTimeout, timers.setInterval, timers.setImmediate, clear, clear, clear, meta,
    )
    syncPhase = false
    // `node --test`: the file's tests run after its body, inside this command's lifetime (its timers stay owned).
    const value = entry.testMode ? Promise.resolve(evaluated).then(() => drainAll()) : evaluated
    let pendingResult = true
    void Promise.resolve(value).then(
      (result) => {
        pendingResult = false
        if (!print || exitCode !== undefined) return
        try { out(fmt([result]) + '\n') } catch (error) { fail(error) }
      },
      (error: unknown) => { pendingResult = false; fail(error) },
    )
    while (exitCode === undefined && (pendingResult || pendingTimers.size > 0 || (!entry.testMode && Date.now() - last < 500))) {
      const remaining = deadline - (Date.now() - started)
      if (remaining <= 0) {
        err(`node: timed out after ${String(deadline / 1000)} s; output so far shown\n`)
        exitCode = 124
        break
      }
      await new Promise((r) => { setTimeout(r, Math.min(entry.testMode ? 5 : 100, remaining)) })
    }
  } catch (error) {
    syncPhase = false
    fail(error)
  } finally {
    exitCode ??= (proc.exitCode as number | undefined) ?? 0
    for (const timer of pendingTimers.values()) clearTimeout(timer)
    pendingTimers.clear()
    self.removeEventListener('unhandledrejection', onRejection)
  }
  return { exitCode, stdout, stderr }
}

/** Drain the harness until nothing registered during a drain is left pending. */
async function drainAll(): Promise<void> {
  do { await harness.drain() } while (harness.hasPending())
}

/**
 * `node --test <file...>`: run each named file's tests in the worker and print one summary.
 * @param files - Test files (relative to `cwd`); flags other than `--test-reporter=spec` are refused.
 * @param cwd - Virtual working directory.
 * @returns Exit 0 iff at least one test ran and none failed or was cancelled; 1 otherwise; 124 on the deadline.
 */
async function runTestCommand(files: readonly string[], cwd: string): Promise<NodeRunResult> {
  let stdout = ''
  let stderr = ''
  const named = files.filter(file => file !== '--test-reporter=spec')
  const flag = named.find(file => file.startsWith('-'))
  if (flag !== undefined) return { exitCode: 9, stdout: '', stderr: `node: bad option for --test in the worker: ${flag}\n` }
  if (named.length === 0) {
    return { exitCode: 1, stdout: '', stderr: 'node --test: name the test files explicitly; the worker does not search for them\n' }
  }
  harness.reset({ write: (t) => { stdout += t }, driven: true, onFailure: () => {} })
  let deadlineHit = false
  for (const file of named) {
    const filename = resolve(cwd, file)
    let code: string
    try {
      code = requireActiveVfs().readFileSync(filename, 'utf8') as string
    } catch {
      harness.reportUncaught(new Error(`Could not find '${filename}'`), filename)
      continue
    }
    // Node runs each test file in a fresh process. The closest the shared worker loader gets: re-evaluate every cached
    // module under the file's own directory (its fixtures and helpers), so a rerun sees current files and re-registers.
    try { requireActiveModuleLoader().evict(dirname(filename)) } catch { /* no loader cache to evict */ }
    const sink = { out: (t: string) => { stdout += t }, err: (t: string) => { stderr += t } }
    const result = await runEntry({ code, filename, print: false, rest: [], cwd, testMode: true, sink })
    if (result.exitCode === 124) { deadlineHit = true; break }
    // A file that failed to load or exited non-zero is one failed test, as Node's --test reports a crashed file.
    if (result.exitCode !== 0) harness.reportUncaught(new Error(`${filename} exited with code ${String(result.exitCode)}`), filename)
  }
  const summary = harness.finish()
  harness.reset()
  if (deadlineHit) return { exitCode: 124, stdout, stderr }
  const exitCode = summary.tests > 0 && summary.fail === 0 && summary.cancelled === 0 ? 0 : 1
  return { exitCode, stdout, stderr }
}
