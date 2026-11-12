/**
 * Aukora X6.1 Lane E3: the in-worker `node:test` harness. Registration (`test`, `describe`, hooks) queues work on one
 * module-level root suite; {@link drainTests} runs that queue deterministically (sequentially, in registration order),
 * reports Node spec-reporter lines through a caller-supplied sink, and answers the summary counts. `node --test` in the
 * worker shell (src/shell/process/node-runner.ts) resets the harness per invocation, loads each file, drains and exits
 * 0 iff at least one test ran and none failed.
 *
 * Honest limits: tests run in the host worker's own realm and event loop (no per-file process isolation); a per-test
 * `timeout` fails a test whose promise has not settled in time, but a synchronous infinite loop cannot be pre-empted.
 * `only`, `mock`, `snapshot`, `plan` and the programmatic `run()` are not provided.
 */

/** Options accepted by `test()` / `describe()` (the Node subset the worker honours). */
export interface TestOptions {
  readonly skip?: boolean | string
  readonly todo?: boolean | string
  readonly only?: boolean
  readonly timeout?: number
  readonly concurrency?: unknown
  readonly signal?: AbortSignal
}

/** A test body: promise-, sync- or callback-style (`(t, done)`). */
export type TestFn = (t: TestContext, done?: (error?: unknown) => void) => unknown
/** A hook body. */
export type HookFn = (t: TestContext | SuiteContext, done?: (error?: unknown) => void) => unknown

/** Summary counts, the same names `node --test` prints. */
export interface TestSummary {
  tests: number
  suites: number
  pass: number
  fail: number
  cancelled: number
  skipped: number
  todo: number
  duration_ms: number
}

interface Hook { readonly fn: HookFn; readonly timeout: number }
interface HookSet { before: Hook[]; after: Hook[]; beforeEach: Hook[]; afterEach: Hook[] }

interface SuiteNode extends HookSet {
  readonly kind: 'suite'
  readonly name: string
  readonly options: TestOptions
  readonly children: Array<SuiteNode | TestNode>
  build?: Promise<unknown>
  buildError?: unknown
}

interface TestNode {
  readonly kind: 'test'
  readonly name: string
  readonly options: TestOptions
  readonly fn: TestFn | undefined
}

/** The `SuiteContext` handed to a `describe` body. */
export interface SuiteContext { readonly name: string; readonly signal: AbortSignal }

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now())

class TestTimeoutError extends Error {
  readonly code = 'ERR_TEST_FAILURE'
  readonly failureType = 'testTimeoutFailure'
  constructor(ms: number) { super(`test timed out after ${String(ms)}ms`); this.name = 'Error' }
}

function newSuite(name: string, options: TestOptions = {}): SuiteNode {
  return { kind: 'suite', name, options, children: [], before: [], after: [], beforeEach: [], afterEach: [] }
}

function normalizeArgs<F>(args: unknown[], fallbackName: string): { name: string; options: TestOptions; fn: F | undefined } {
  let name = fallbackName
  let options: TestOptions = {}
  let fn: F | undefined
  for (const arg of args) {
    if (typeof arg === 'string') name = arg
    else if (typeof arg === 'function') fn = arg as F
    else if (arg !== null && typeof arg === 'object') options = arg as TestOptions
  }
  if (name === fallbackName && fn !== undefined && typeof (fn as { name?: unknown }).name === 'string' && (fn as { name: string }).name) {
    name = (fn as { name: string }).name
  }
  return { name, options, fn }
}

function validTimeout(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : Infinity
}

/** Invoke a body in promise or callback style, bounded by `timeout`. Clears its own timer either way. */
async function invoke(fn: (...a: unknown[]) => unknown, context: unknown, timeout: number): Promise<void> {
  const call = fn.length >= 2
    ? new Promise<void>((resolve, reject) => {
      let settled = false
      const done = (error?: unknown): void => {
        if (settled) return
        settled = true
        if (error !== undefined && error !== null) reject(error instanceof Error ? error : new Error(String(error)))
        else resolve()
      }
      const returned = fn(context, done)
      if (returned !== null && typeof returned === 'object' && typeof (returned as { then?: unknown }).then === 'function') {
        settled = true
        reject(new Error('passed a callback but also returned a Promise'))
      }
    })
    : Promise.resolve().then(() => fn(context))
  if (timeout === Infinity) { await call; return }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { reject(new TestTimeoutError(timeout)) }, timeout)
    })
    await Promise.race([call, deadline])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    const head = error.stack ?? `${error.name}: ${error.message}`
    const extra = (error as { code?: unknown }).code === 'ERR_ASSERTION'
      && !head.includes(String((error as { message?: unknown }).message)) ? `\n${error.message}` : ''
    return head + extra
  }
  try { return `${typeof error === 'string' ? error : JSON.stringify(error)}` } catch { return String(error) }
}

/** Per-test context (`t`). */
export class TestContext {
  readonly name: string
  readonly fullName: string
  readonly signal: AbortSignal
  /** @internal */ readonly controller = new AbortController()
  /** @internal */ readonly diagnostics: string[] = []
  /** @internal */ readonly hooks: HookSet = { before: [], after: [], beforeEach: [], afterEach: [] }
  /** @internal */ outcome: { skip?: string; todo?: string } = {}
  /** @internal */ subtestFailures = 0
  /** @internal */ private chain: Promise<void> = Promise.resolve()
  /** @internal */ private startedBefore = false

  constructor(name: string, fullName: string, private readonly harness: Harness, private readonly depth: number) {
    this.name = name
    this.fullName = fullName
    this.signal = this.controller.signal
  }

  /** Node 22+ `t.assert`: the strict assertion surface, when the harness was given one. */
  get assert(): unknown { return this.harness.assertModule }

  /** Record a diagnostic line, printed under this test's result. */
  diagnostic(message: unknown): void { this.diagnostics.push(String(message)) }

  /** Mark this test skipped (it still runs to completion, as in Node). */
  skip(message?: string): void { this.outcome.skip = message ?? '' }

  /** Mark this test TODO (failures do not count). */
  todo(message?: string): void { this.outcome.todo = message ?? '' }

  before(fn: HookFn, options?: { timeout?: number }): void { this.hooks.before.push({ fn, timeout: validTimeout(options?.timeout) }) }
  after(fn: HookFn, options?: { timeout?: number }): void { this.hooks.after.push({ fn, timeout: validTimeout(options?.timeout) }) }
  beforeEach(fn: HookFn, options?: { timeout?: number }): void {
    this.hooks.beforeEach.push({ fn, timeout: validTimeout(options?.timeout) })
  }
  afterEach(fn: HookFn, options?: { timeout?: number }): void { this.hooks.afterEach.push({ fn, timeout: validTimeout(options?.timeout) }) }

  /** Run a subtest after any earlier subtest of this test; resolves (never rejects) when it finishes, as in Node. */
  test(...args: unknown[]): Promise<void> {
    const { name, options, fn } = normalizeArgs<TestFn>(args, '<anonymous>')
    const node: TestNode = { kind: 'test', name, options, fn }
    const run = this.chain.then(async () => {
      if (!this.startedBefore) {
        this.startedBefore = true
        for (const hook of this.hooks.before) await invoke(hook.fn as (...a: unknown[]) => unknown, this, hook.timeout)
      }
      const passed = await this.harness.runTest(node, this.depth + 1, [], this)
      if (!passed) this.subtestFailures += 1
    }).catch((error: unknown) => {
      this.subtestFailures += 1
      this.harness.reportUncaught(error, `${this.fullName} > ${name}`)
    })
    this.chain = run
    return run
  }

  /** @internal Wait for every subtest started on this context. */
  async settle(): Promise<void> {
    for (;;) {
      const current = this.chain
      await current
      if (current === this.chain) return
    }
  }
}

/** The harness: one root suite, one reporter, one summary per drain. */
export class Harness {
  private root: SuiteNode = newSuite('<root>')
  private current: SuiteNode = this.root
  private draining: Promise<TestSummary> | undefined
  private autoTimer: ReturnType<typeof setTimeout> | undefined
  private driven = false
  private write: (text: string) => void = defaultWrite
  private onFailure: () => void = () => { setProcessExitCode(1) }
  private summary: TestSummary = emptySummary()
  private started: number | undefined
  private failures: Array<{ name: string; error: string }> = []
  /** Assertion surface exposed as `t.assert`; set by the builtin module. */
  assertModule: unknown = undefined

  /** Forget every queued test and counter; the next drain starts clean. */
  reset(options: { write?: (text: string) => void; driven?: boolean; onFailure?: () => void } = {}): void {
    if (this.autoTimer !== undefined) clearTimeout(this.autoTimer)
    this.autoTimer = undefined
    this.root = newSuite('<root>')
    this.current = this.root
    this.draining = undefined
    this.driven = options.driven ?? false
    this.write = options.write ?? defaultWrite
    // `node --test` owns its command's exit status; only an undriven run marks the worker's global process.
    this.onFailure = options.onFailure ?? (() => { setProcessExitCode(1) })
    this.summary = emptySummary()
    this.failures = []
    this.started = undefined
  }

  /** Whether anything is registered and not yet run. */
  hasPending(): boolean { return this.root.children.length > 0 }

  register(node: SuiteNode | TestNode): void {
    this.current.children.push(node)
    // Outside `node --test` (e.g. `node file.mjs`, or a module required by other code), run after the loading turn.
    if (!this.driven && this.autoTimer === undefined && this.draining === undefined) {
      this.autoTimer = setTimeout(() => { this.autoTimer = undefined; void this.drain() }, 0)
    }
  }

  addHook(kind: keyof HookSet, fn: HookFn, options?: { timeout?: number }): void {
    if (typeof fn !== 'function') throw new TypeError('The "fn" argument must be of type function')
    this.current[kind].push({ fn, timeout: validTimeout(options?.timeout) })
  }

  /** `describe()`: register a suite and run its body now, collecting its children (Node builds suites eagerly). */
  describe(args: unknown[], forced: TestOptions = {}): Promise<void> {
    const { name, options, fn } = normalizeArgs<(s: SuiteContext) => unknown>(args, '<anonymous>')
    const suite = newSuite(name, { ...options, ...forced })
    this.register(suite)
    if (fn !== undefined && !suite.options.skip && !suite.options.todo) {
      const parent = this.current
      this.current = suite
      try {
        const built = fn({ name, signal: new AbortController().signal })
        if (built !== null && typeof built === 'object' && typeof (built as { then?: unknown }).then === 'function') {
          suite.build = Promise.resolve(built).catch((error: unknown) => { suite.buildError = error })
        }
      } catch (error) {
        suite.buildError = error
      } finally {
        this.current = parent
      }
    }
    return Promise.resolve()
  }

  /** `test()` / `it()`: register one test. */
  test(args: unknown[], forced: TestOptions = {}): Promise<void> {
    const { name, options, fn } = normalizeArgs<TestFn>(args, '<anonymous>')
    this.register({ kind: 'test', name, options: { ...options, ...forced }, fn })
    return Promise.resolve()
  }

  /**
   * Run everything queued so far; calls while a drain is running share its promise. The queue is detached first, so
   * tests registered during the run wait for the next drain (`node --test` drains until nothing is pending). An
   * undriven harness prints its summary and marks the global exit code itself; a driven one leaves that to
   * {@link finish}.
   * @returns The cumulative counts after this drain.
   */
  drain(): Promise<TestSummary> {
    if (this.autoTimer !== undefined) { clearTimeout(this.autoTimer); this.autoTimer = undefined }
    this.draining ??= this.runQueued().finally(() => { this.draining = undefined })
    return this.draining
  }

  private async runQueued(): Promise<TestSummary> {
    const queued = this.root
    this.root = newSuite('<root>')
    this.current = this.root
    this.started ??= now()
    await this.runSuiteBody(queued, 0, [])
    if (!this.driven) this.finish()
    return this.counts()
  }

  /**
   * Print the summary (failures first, then Node's `ℹ` count lines) and report failure through the configured hook.
   * @returns The final counts.
   */
  finish(): TestSummary {
    this.summary.duration_ms = Math.round((now() - (this.started ?? now())) * 1000) / 1000
    this.started = undefined
    this.printSummary()
    if (this.summary.fail > 0 || this.summary.cancelled > 0) this.onFailure()
    return this.counts()
  }

  /** Report a failure that is not one test's own result (a file that did not load, an uncaught rejection). */
  reportUncaught(error: unknown, where: string): void {
    this.summary.tests += 1
    this.summary.fail += 1
    const text = describeError(error)
    this.failures.push({ name: where, error: text })
    this.write(`✖ ${where}\n${indent(text, 2)}\n`)
    if (!this.driven) this.onFailure()
  }

  /** Current counts (live while draining). */
  counts(): TestSummary { return { ...this.summary } }

  private async runSuiteBody(suite: SuiteNode, depth: number, ancestors: SuiteNode[]): Promise<boolean> {
    if (suite.build) await suite.build
    const chain = [...ancestors, suite]
    let ok = true
    let beforeError: unknown
    try {
      for (const hook of suite.before) await invoke(hook.fn as (...a: unknown[]) => unknown, { name: suite.name }, hook.timeout)
    } catch (error) { beforeError = error }
    // Children registered while running (a test calling top-level test()) are appended and still run.
    for (let index = 0; index < suite.children.length; index += 1) {
      const child = suite.children[index]
      if (child === undefined) continue
      if (beforeError !== undefined) { this.cancel(child, depth); ok = false; continue }
      const passed = child.kind === 'suite' ? await this.runSuite(child, depth, chain) : await this.runTest(child, depth, chain)
      ok &&= passed
    }
    try {
      for (const hook of suite.after) await invoke(hook.fn as (...a: unknown[]) => unknown, { name: suite.name }, hook.timeout)
    } catch (error) {
      this.reportUncaught(error, `${suite.name === '<root>' ? 'after hook' : suite.name + ' > after hook'}`)
      ok = false
    }
    if (beforeError !== undefined) {
      this.reportUncaught(beforeError, `${suite.name === '<root>' ? 'before hook' : suite.name + ' > before hook'}`)
      ok = false
    }
    return ok
  }

  private async runSuite(suite: SuiteNode, depth: number, ancestors: SuiteNode[]): Promise<boolean> {
    this.summary.suites += 1
    const pad = '  '.repeat(depth)
    if (suite.options.skip !== undefined && suite.options.skip !== false) {
      this.write(`${pad}﹣ ${suite.name} # SKIP\n`)
      this.summary.skipped += 1
      return true
    }
    this.write(`${pad}▶ ${suite.name}\n`)
    const started = now()
    let ok: boolean
    if (suite.buildError !== undefined) {
      this.reportUncaught(suite.buildError, `${suite.name} (suite body)`)
      ok = false
    } else {
      ok = await this.runSuiteBody(suite, depth + 1, ancestors)
    }
    this.write(`${pad}${ok ? '✔' : '✖'} ${suite.name} (${ms(now() - started)})\n`)
    return ok
  }

  private cancel(node: SuiteNode | TestNode, depth: number): void {
    if (node.kind === 'suite') { for (const child of node.children) this.cancel(child, depth + 1); return }
    this.summary.tests += 1
    this.summary.cancelled += 1
    this.write(`${'  '.repeat(depth)}✖ ${node.name} # cancelled (a before hook failed)\n`)
  }

  /** Run one test (top-level, in a suite, or as a subtest) and report it. @returns whether it passed. */
  async runTest(node: TestNode, depth: number, ancestors: SuiteNode[], parent?: TestContext): Promise<boolean> {
    this.summary.tests += 1
    const pad = '  '.repeat(depth)
    const fullName = parent ? `${parent.fullName} > ${node.name}` : node.name
    const skip = node.options.skip
    if (skip !== undefined && skip !== false) {
      this.summary.skipped += 1
      this.write(`${pad}﹣ ${node.name} (0ms) # SKIP${typeof skip === 'string' ? ' ' + skip : ''}\n`)
      return true
    }
    const t = new TestContext(node.name, fullName, this, depth)
    if (node.options.todo !== undefined && node.options.todo !== false) t.todo(typeof node.options.todo === 'string' ? node.options.todo : undefined)
    const started = now()
    let error: unknown
    const parentEach = parent ? [parent.hooks] : []
    const eachSets: HookSet[] = [...ancestors, ...parentEach]
    try {
      for (const set of eachSets) for (const hook of set.beforeEach) await invoke(hook.fn as (...a: unknown[]) => unknown, t, hook.timeout)
      if (node.fn !== undefined) await invoke(node.fn as (...a: unknown[]) => unknown, t, validTimeout(node.options.timeout))
      await t.settle()
    } catch (reason) {
      error = reason ?? new Error('test failed with a nullish reason')
      await t.settle().catch(() => {})
    }
    try {
      for (const set of [...eachSets].reverse()) {
        for (const hook of set.afterEach) await invoke(hook.fn as (...a: unknown[]) => unknown, t, hook.timeout)
      }
      for (const hook of t.hooks.after) await invoke(hook.fn as (...a: unknown[]) => unknown, t, hook.timeout)
    } catch (reason) {
      error ??= reason
    }
    t.controller.abort()
    if (error === undefined && t.subtestFailures > 0) {
      error = new Error(`${String(t.subtestFailures)} subtest${t.subtestFailures === 1 ? '' : 's'} failed`)
    }
    const duration = ms(now() - started)
    const notes = t.diagnostics.map(line => `${pad}  ℹ ${line}\n`).join('')
    if (t.outcome.todo !== undefined) {
      this.summary.todo += 1
      this.write(`${pad}${error === undefined ? '✔' : '✖'} ${node.name} (${duration}) # TODO${t.outcome.todo ? ' ' + t.outcome.todo : ''}\n${notes}`)
      return true
    }
    if (t.outcome.skip !== undefined && error === undefined) {
      this.summary.skipped += 1
      this.write(`${pad}﹣ ${node.name} (${duration}) # SKIP${t.outcome.skip ? ' ' + t.outcome.skip : ''}\n${notes}`)
      return true
    }
    if (error === undefined) {
      this.summary.pass += 1
      this.write(`${pad}✔ ${node.name} (${duration})\n${notes}`)
      return true
    }
    this.summary.fail += 1
    const text = describeError(error)
    this.failures.push({ name: fullName, error: text })
    this.write(`${pad}✖ ${node.name} (${duration})\n${indent(text, depth * 2 + 2)}\n${notes}`)
    return false
  }

  private printSummary(): void {
    const s = this.summary
    let text = ''
    if (this.failures.length > 0) {
      text += '\n✖ failing tests:\n\n'
      for (const failure of this.failures) text += `test: ${failure.name}\n${indent(failure.error, 2)}\n\n`
    }
    text += `ℹ tests ${String(s.tests)}\nℹ suites ${String(s.suites)}\nℹ pass ${String(s.pass)}\nℹ fail ${String(s.fail)}\n`
      + `ℹ cancelled ${String(s.cancelled)}\nℹ skipped ${String(s.skipped)}\nℹ todo ${String(s.todo)}\nℹ duration_ms ${String(s.duration_ms)}\n`
    this.write(text)
  }
}

function emptySummary(): TestSummary {
  return { tests: 0, suites: 0, pass: 0, fail: 0, cancelled: 0, skipped: 0, todo: 0, duration_ms: 0 }
}

function ms(value: number): string { return `${String(Math.round(value * 1000) / 1000)}ms` }

function indent(text: string, by: number): string {
  const pad = ' '.repeat(by)
  return text.split('\n').map(line => pad + line).join('\n')
}

function defaultWrite(text: string): void {
  const out = (globalThis as { process?: { stdout?: { write?: (t: string) => unknown } } }).process?.stdout
  if (typeof out?.write === 'function') { out.write(text); return }
  console.log(text.replace(/\n$/, ''))
}

function setProcessExitCode(code: number): void {
  const proc = (globalThis as { process?: { exitCode?: number } }).process
  if (proc && typeof proc === 'object') {
    try { proc.exitCode = code } catch { /* a frozen or getter-only process keeps its own code */ }
  }
}

/** The one harness the `node:test` builtin and `node --test` share. */
export const harness = new Harness()
