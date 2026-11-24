/**
 * In-process workflow execution for a host that cannot launch a Node child (the browser worker host). The same
 * {@link WorkflowExecution} VM helpers run in the caller's own realm through `node:vm`; `agent()` starts children
 * directly on `ctx.subagents`, after an optional host gate. A host opts in by installing
 * {@link WORKFLOW_EXECUTOR_KEY} on `globalThis`; nothing installs it on a Node host, which keeps the PTC process path.
 * The VM isolates names, not capabilities, so this executor runs only under the `danger-full-access` file policy,
 * the same rule the PTC path applies to a runtime without confinement. A synchronous infinite loop cannot be preempted.
 * @module @deepseek-ai/dsh-workflow-ptc/in-process
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import type SubagentRuntime from '@deepseek-ai/dsh-subagent'
import type { SubagentActivation } from '@deepseek-ai/dsh-subagent'
import type { WorkflowAgentEndInfo, WorkflowAgentInfo, WorkflowMeta, WorkflowResult, WorkflowRun, WorkflowRunId } from '@deepseek-ai/dsh-workflow'
import { renderThrown } from './realm.ts'
import { WorkflowExecution } from './runtime.ts'
import type { ExecutionObserver } from './runtime.ts'
import type { ChildHandle, ChildPort, ChildResult, ChildStartRequest, WorkerInit } from './types.ts'

/** The `globalThis` key a host sets to select in-process execution (shared by `Symbol.for`, so module copies agree). */
export const WORKFLOW_EXECUTOR_KEY: unique symbol = Symbol.for('@deepseek-ai/dsh-workflow-ptc/executor') as never

/** What a host installs under {@link WORKFLOW_EXECUTOR_KEY}. */
export interface InProcessExecutorHost {
  /** The only executor a host can select; absence means the PTC process path. */
  readonly mode: 'in-process'
  /**
   * Refuse one `agent()` child before it starts, by throwing. The host's own tool gate goes here, so a workflow child
   * meets the same refusal a direct `subagent` call would.
   */
  gate?: (request: ChildStartRequest) => void
}

/**
 * The host-installed in-process executor, if any.
 * @returns The host declaration, or undefined on a host that keeps the PTC process path.
 */
export function inProcessExecutor(): InProcessExecutorHost | undefined {
  const value = (globalThis as Record<PropertyKey, unknown>)[WORKFLOW_EXECUTOR_KEY] as InProcessExecutorHost | undefined
  return value?.mode === 'in-process' ? value : undefined
}

/** Erasable TypeScript-only syntax, consulted only for a body that does not parse as JavaScript. */
const TS_SYNTAX = new RegExp([
  String.raw`(?:^|[\s;{(])(?:interface|type)\s+[A-Za-z_$][\w$]*\s*[={<]`,
  String.raw`[\w$)\]]\s*:\s*(?:string|number|boolean|unknown|any|void|never|object|Record<|Array<|Promise<|[A-Z][\w$]*)(?:\[\])?\s*[,)=;{]`,
  String.raw`\bas\s+(?:const|string|number|unknown|any|[A-Z][\w$]*)\b`,
].join('|'), 'm')

/**
 * Whether a body that failed to parse looks like TypeScript.
 * @param body - The script body.
 * @returns true when type syntax is the likely cause.
 */
export function looksLikeTypeScript(body: string): boolean {
  return TS_SYNTAX.test(body)
}

interface ChildRecord { readonly run: SubagentActivation; disposal?: Promise<void> }

/**
 * Holder-owned in-process workflow. Cancellation aborts every child and settles the run as `cancelled`; script code
 * that keeps running after cancellation can no longer start children.
 */
export class InProcessWorkflowRun implements WorkflowRun {
  readonly result: Promise<WorkflowResult>
  private readonly controller = new AbortController()
  private readonly children = new Set<ChildRecord>()
  private readonly pending = new Set<Promise<unknown>>()
  private readonly liveAgents = new Map<number, WorkflowAgentInfo>()
  private terminal = false
  private cancelReason: string | undefined
  private disposed: Promise<void> | undefined
  private readonly externalAbort: () => void

  constructor(
    private readonly subagents: SubagentRuntime,
    readonly id: WorkflowRunId,
    readonly meta: WorkflowMeta,
    private readonly parent: Agent,
    private readonly init: WorkerInit,
    private readonly provider: string,
    private readonly policy: SandboxExecutionPolicy,
    private readonly cwd: Promise<string>,
    private readonly observer: ExecutionObserver,
    private readonly host: InProcessExecutorHost,
    private readonly onDisposeFailure: (error: unknown) => void,
    private readonly signal?: AbortSignal,
  ) {
    this.externalAbort = () => { this.cancel('workflow signal aborted') }
    if (signal?.aborted) this.externalAbort()
    else signal?.addEventListener('abort', this.externalAbort, { once: true })
    void cwd.catch(() => {})
    this.result = Promise.resolve().then(() => this.drive())
  }

  /**
   * Abort pending and published children; the first reason wins.
   * @param reason - Human-readable cancellation cause.
   */
  cancel(reason = 'workflow cancelled'): void {
    if (this.terminal || this.cancelReason !== undefined) return
    this.cancelReason = reason
    this.controller.abort(reason)
    for (const record of this.children) void this.disposeChild(record)
  }

  /**
   * Cancel unfinished work and await child cleanup.
   * @returns One shared completion promise.
   */
  dispose(): Promise<void> {
    this.cancel('workflow disposed')
    this.disposed ??= this.result.then(() => {})
    return this.disposed
  }

  private track<T>(task: Promise<T>): Promise<T> {
    this.pending.add(task)
    void task.then(() => { this.pending.delete(task) }, () => { this.pending.delete(task) })
    return task
  }

  private disposeChild(record: ChildRecord): Promise<void> {
    record.disposal ??= Promise.resolve().then(() => record.run.dispose()).catch(this.onDisposeFailure).finally(() => {
      this.children.delete(record)
    })
    return record.disposal
  }

  private async startChild(request: ChildStartRequest): Promise<ChildHandle> {
    this.controller.signal.throwIfAborted()
    this.host.gate?.(request)
    const run = await this.subagents.startActivation({
      provider: this.provider,
      label: `${this.meta.name} child`,
      delivery: 'caller',
      signal: this.controller.signal,
      request: {
        cwd: await this.cwd,
        prompt: [{ type: 'text', text: request.prompt }],
        parent: this.parent,
        ...request.schema === undefined ? {} : { outputSchema: request.schema },
        ...request.provider === undefined && request.model === undefined && request.maxTokens === undefined ? {} : {
          agentOptions: {
            ...request.provider === undefined ? {} : { provider: request.provider },
            ...request.model === undefined ? {} : { model: request.model },
            ...request.maxTokens === undefined ? {} : { maxTokens: request.maxTokens },
          },
        },
      },
    })
    const record: ChildRecord = { run }
    this.children.add(record)
    if (this.controller.signal.aborted) {
      await this.disposeChild(record)
      throw new Error('workflow child started after cancellation')
    }
    const signal = this.controller.signal
    const aborted = new Promise<never>((_resolve, reject) => {
      signal.addEventListener('abort', () => { reject(new Error(String(signal.reason ?? 'workflow cancelled'))) }, { once: true })
    })
    aborted.catch(() => {})
    const result: Promise<ChildResult> = Promise.race([run.result, aborted]).then(settled => ({
      output: [...settled.output],
      stopReason: settled.stopReason,
      ...settled.structured === undefined ? {} : { structured: settled.structured },
    }))
    result.catch(() => {})
    return { id: run.childId, result, dispose: () => this.disposeChild(record) }
  }

  private cancelled(started: number): WorkflowResult {
    return { value: null, stopReason: 'cancelled', error: `workflow run cancelled: ${this.cancelReason}`, agentsStarted: started }
  }

  private async drive(): Promise<WorkflowResult> {
    let result: WorkflowResult
    let started = 0
    try {
      await this.cwd
      this.controller.signal.throwIfAborted()
      if (this.policy.mode !== 'danger-full-access') {
        throw new Error(`WORKFLOW_UNCONFINED_REFUSED: the in-process workflow executor cannot enforce the ${this.policy.mode} file policy`)
      }
      const observer: ExecutionObserver = {
        phase: (title) => { this.observer.phase(title) },
        log: (message) => { this.observer.log(message) },
        agentStart: (info) => {
          started = Math.max(started, info.seq)
          this.liveAgents.set(info.seq, info)
          this.observer.agentStart(info)
        },
        agentEnd: (info) => { this.endAgent(info) },
      }
      const port: ChildPort = { startAgent: request => this.track(this.startChild(request)) }
      const execution = new WorkflowExecution(this.init.meta, this.init.body, this.init.args, this.init.limits, observer, port)
      const signal = this.controller.signal
      const aborted = new Promise<undefined>((resolve) => {
        signal.addEventListener('abort', () => { resolve(undefined) }, { once: true })
      })
      const settled = await Promise.race([execution.drive(), aborted])
      if (this.cancelReason !== undefined || settled === undefined) result = this.cancelled(settled?.agentsStarted ?? started)
      else if (settled.stopReason === 'error') result = { ...settled, error: `WORKFLOW_SCRIPT_FAILED: ${settled.error ?? 'unknown error'}` }
      else result = settled
    } catch (error: unknown) {
      result = this.cancelReason === undefined
        ? { value: null, stopReason: 'error', error: `WORKFLOW_SCRIPT_FAILED: ${renderThrown(error)}`, agentsStarted: started }
        : this.cancelled(started)
    } finally {
      this.terminal = true
      this.signal?.removeEventListener('abort', this.externalAbort)
      this.controller.abort('workflow settled')
      while (this.pending.size > 0) await Promise.allSettled([...this.pending])
      await Promise.all([...this.children].map(record => this.disposeChild(record)))
      for (const info of this.liveAgents.values()) this.endAgent({ ...info, outcome: 'cancelled' })
    }
    return result
  }

  private endAgent(info: WorkflowAgentEndInfo): void {
    if (!this.liveAgents.delete(info.seq)) return
    this.observer.agentEnd(info)
  }
}
