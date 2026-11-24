/**
 * The worker host has no Node child process, no control pipe and no TypeScript stripper, so the
 * PTC path of `@deepseek-ai/dsh-workflow-ptc` cannot run here (her `workflow` failed on `stripTypeScriptTypes`). The
 * host declares the engine's in-process executor instead (`src/in-process.ts` there): the script runs in this worker
 * through the `node:vm` shim with only the workflow API in scope, and each `agent()` child passes `gate` first. The
 * key is shared by `Symbol.for`, so the image's copy of the engine sees it without a static import.
 */

/** The engine's executor key (`WORKFLOW_EXECUTOR_KEY` in `@deepseek-ai/dsh-workflow-ptc`). */
export const WORKFLOW_EXECUTOR_KEY = Symbol.for('@deepseek-ai/dsh-workflow-ptc/executor')

/** One `agent()` child request, as the engine hands it to the gate. */
export interface WorkflowChildRequest { prompt: string; provider?: string; model?: string; schema?: unknown }

interface ExecutorHost { readonly mode: 'in-process'; gate?: (request: WorkflowChildRequest) => void }

function host(): ExecutorHost {
  const scope = globalThis as Record<PropertyKey, unknown>
  const existing = scope[WORKFLOW_EXECUTOR_KEY] as ExecutorHost | undefined
  if (existing?.mode === 'in-process') return existing
  const created: ExecutorHost = { mode: 'in-process' }
  Object.defineProperty(scope, WORKFLOW_EXECUTOR_KEY, { value: created, configurable: true, enumerable: false, writable: false })
  return created
}

/** Select in-process workflow execution for this worker (idempotent). */
export function declareInProcessWorkflows(): void {
  host()
}

/**
 * Gate every workflow child through the same check a direct `subagent` call meets.
 * @param gate - Throws to refuse a child before it starts.
 */
export function setWorkflowChildGate(gate: (request: WorkflowChildRequest) => void): void {
  host().gate = gate
}

/** the repository door commit 2: the sentence `workflow` gains in her body for the new `agent()` options. */
export const WORKFLOW_BUDGET_SENTENCE = ' In `agent(prompt, opts)`, `opts.maxTokens` caps each model request of that child (a thinking model spends its '
  + 'cap on thinking first, so leave it out unless you have a reason), and `opts.timeoutMs` stops that child past that time with a '
  + 'non-fatal `AGENT_TIMEOUT` error (a `null` item inside `parallel()`/`pipeline()`).'
/** The sentence `subagent` and `subagent_fork` gain with their `max_tokens` parameter. */
export const SUBAGENT_BUDGET_SENTENCE = ' `max_tokens` caps each model request of the child, thinking included (leave it out for the model default; a '
  + 'thinking model spends its cap on thinking first).'
/** The sentence `subagent` gains where it already offers `reasoning_effort`. */
export const SUBAGENT_REASONING_SENTENCE = ' `reasoning_effort` is the child\'s reasoning budget on its model.'

interface BudgetedDefinition { name?: unknown; description?: unknown; parameters?: unknown }

/**
 * State the budget options in the words she reads, and declare `max_tokens` on the delegation tools (the shipped tool
 * reads it when a host declares it). Idempotent: a definition registered again is not extended twice.
 * @param definition - A tool definition on its way to registration.
 */
export function describeBudgets(definition: BudgetedDefinition): void {
  if (typeof definition.description !== 'string') return
  const add = (sentence: string): void => {
    if (!(definition.description as string).includes(sentence)) definition.description = `${definition.description as string}${sentence}`
  }
  if (definition.name === 'workflow') { add(WORKFLOW_BUDGET_SENTENCE); return }
  if (definition.name !== 'subagent' && definition.name !== 'subagent_fork') return
  const parameters = definition.parameters as { properties?: Record<string, unknown> } | undefined
  if (parameters?.properties === undefined) return
  parameters.properties.max_tokens ??= { type: 'integer', description: 'Output cap per model request of the child, thinking included (a positive whole number).' }
  add(SUBAGENT_BUDGET_SENTENCE)
  if (parameters.properties.reasoning_effort !== undefined) add(SUBAGENT_REASONING_SENTENCE)
}
