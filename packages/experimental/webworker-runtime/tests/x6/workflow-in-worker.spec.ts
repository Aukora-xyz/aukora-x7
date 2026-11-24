/**
 * Her `workflow` tool in the worker host. Her live report: every call failed before her script
 * ran with `web-preview: node:module.stripTypeScriptTypes is not available in the worker host`. These specs run the
 * real workflow engine and the real Node PTC provider with the worker's own `node:module` and `node:vm` modules in
 * place of Node's, so the PTC path fails exactly as it did for her, and the in-process executor the worker host
 * declares (src/x6/workflow-executor.ts) runs through the worker's vm shim. Children come from a scripted in-test
 * subagent provider; no model, network or provider is reached.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { SessionId } from '@deepseek-ai/dsh-session'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import type { SubagentCapabilities, SubagentProvider, SubagentResult, SubagentRun, SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import type { WorkflowResult } from '@deepseek-ai/dsh-workflow'
import PtcWorkflowEngine from '../../../../workflow/workflow-ptc/src/index.ts'
import { fakeParent, mountPtcRuntime } from '../../../../workflow/workflow-ptc/tests/setup.ts'
import {
  declareInProcessWorkflows, describeBudgets, setWorkflowChildGate, SUBAGENT_BUDGET_SENTENCE, SUBAGENT_REASONING_SENTENCE,
  WORKFLOW_BUDGET_SENTENCE, WORKFLOW_EXECUTOR_KEY,
} from '../../src/x6/workflow-executor.ts'
import { FakeSocket, mountE4 } from './e4-fixture.ts'

// The worker's own builtins replace Node's for every module this spec loads (as the worker module proxy table does).
vi.mock('node:module', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('node:module')
  const { stripTypeScriptTypes } = await import('../../src/node/builtin_modules/implemented/module.ts')
  return { ...actual, default: Object.assign({}, actual.default, { stripTypeScriptTypes }), stripTypeScriptTypes }
})
vi.mock('node:vm', async () => {
  const worker = await import('../../src/node/builtin_modules/implemented/vm.ts')
  return { ...worker, default: worker.default }
})

afterEach(() => {
  Reflect.deleteProperty(globalThis, WORKFLOW_EXECUTOR_KEY)
  FakeSocket.instances.length = 0
  vi.restoreAllMocks()
})

const text = (reply: string): SubagentResult => ({ output: [{ type: 'text', text: reply }], stopReason: 'completed' })

class ScriptedProvider implements SubagentProvider {
  readonly capabilities: SubagentCapabilities = { agentOptions: true, agentPreset: false, outputSchema: true, depthLimit: true }
  readonly inheritsParentContext = false
  readonly prompts: string[] = []
  readonly requests: SubagentStartRequest[] = []
  disposed = 0
  constructor(readonly name: string, private readonly reply: (prompt: string) => SubagentResult | Promise<SubagentResult>) {}
  start(request: SubagentStartRequest): Promise<SubagentRun> {
    const prompt = request.prompt.map(block => block.type === 'text' ? block.text : '').join('')
    this.prompts.push(prompt)
    this.requests.push(request)
    const index = this.prompts.length - 1
    return Promise.resolve({
      id: SessionId(`scripted-child-${String(index)}`),
      // Like the real in-process backends, a child settles `aborted` when its start signal fires (disposal fires it).
      result: Promise.race([Promise.resolve(this.reply(prompt)), new Promise<SubagentResult>((resolve) => {
        request.signal.addEventListener('abort', () => { resolve({ output: [], stopReason: 'aborted' }) }, { once: true })
      })]),
      dispose: () => { this.disposed += 1; return Promise.resolve() },
    })
  }
}

async function setup(reply: (prompt: string) => SubagentResult | Promise<SubagentResult> = prompt => text(`answer to ${prompt}`)) {
  const ctx = new Context()
  await ctx.plugin(SessionProjectionRegistry)
  await mountPtcRuntime(ctx, 'danger-full-access', 'per-call')
  provideWorkingDirectoryFixture(ctx)
  await ctx.plugin(SubagentRuntime)
  const provider = new ScriptedProvider('scripted', reply)
  ctx.subagents.registerProvider(provider)
  await ctx.plugin(PtcWorkflowEngine, { provider: 'scripted', maxConcurrentAgents: 4 })
  const parent = await fakeParent(ctx)
  const run = async (script: string): Promise<WorkflowResult> => {
    const handle = ctx.workflowEngine.start({ script, meta: { name: 't', description: 'repo door' }, parent })
    try { return await handle.result } finally { await handle.dispose() }
  }
  return { ctx, provider, run }
}

describe('workflow in the worker host', { timeout: 60_000 }, () => {
  it('red without the host declaration: the PTC path stops on the worker\'s missing type stripper, as in her report', async () => {
    const { run } = await setup()
    const result = await run('return {ok:true}')
    expect(result.stopReason).toBe('error')
    expect(result.error).toContain('node:module.stripTypeScriptTypes is not available in the worker host')
  })

  it('her acceptance: meta {name: "t"} and `return {ok:true}` returns {ok:true}', async () => {
    declareInProcessWorkflows()
    const { ctx, run } = await setup()
    const ptc = vi.spyOn(ctx.ptcRuntime, 'run')
    expect(await run('return {ok:true}')).toEqual({ value: { ok: true }, stopReason: 'completed', agentsStarted: 0 })
    expect(ptc).not.toHaveBeenCalled()
    // The worker's vm shim (no code cache) is what ran the script, not Node's vm.
    const vm = await import('node:vm')
    expect(new vm.Script('1').createCachedData().byteLength).toBe(0)
  })

  it('parallel() over two agents returns both answers, and children are disposed', async () => {
    declareInProcessWorkflows()
    const { run, provider } = await setup()
    const result = await run('const [a, b] = await parallel([() => agent("one"), () => agent("two")]); return { a, b }')
    expect(result).toMatchObject({ stopReason: 'completed', agentsStarted: 2, value: { a: 'answer to one', b: 'answer to two' } })
    expect(provider.disposed).toBe(2)
  })

  it('pipeline() passes stage one\'s result into stage two; phase() and log() are in scope', async () => {
    declareInProcessWorkflows()
    const { run, provider } = await setup()
    const result = await run(`phase('scan'); log('go')
      const out = await pipeline(['x'], (_prev, item) => agent('first ' + item), (prev) => agent('second ' + prev))
      return out`)
    expect(result).toMatchObject({ stopReason: 'completed', value: ['answer to second answer to first x'] })
    expect(provider.prompts).toEqual(['first x', 'second answer to first x'])
  })

  it('a script that throws gets a closed refusal carrying its message, never an exception', async () => {
    declareInProcessWorkflows()
    const { run } = await setup()
    const result = await run('throw new Error("boom from her script")')
    expect(result.stopReason).toBe('error')
    expect(result.error).toMatch(/^WORKFLOW_SCRIPT_FAILED: /)
    expect(result.error).toContain('boom from her script')
  })

  it('a script with type syntax gets WORKFLOW_TS_STRIP_UNAVAILABLE; plain JS is unaffected', async () => {
    declareInProcessWorkflows()
    const { run } = await setup()
    let refusal: unknown
    try { await run('const n: number = 1\nreturn { n }') } catch (error) { refusal = error }
    expect(refusal).toMatchObject({ code: 'WORKFLOW_TS_STRIP_UNAVAILABLE' })
    expect((refusal as Error).message).toMatch(/^WORKFLOW_TS_STRIP_UNAVAILABLE: .*plain JS/)
    expect((await run('const n = 1\nreturn { n }')).value).toEqual({ n: 1 })
  })

  it('an agent() call the host gate refuses is refused inside the workflow, and no child starts', async () => {
    declareInProcessWorkflows()
    setWorkflowChildGate((request) => {
      if (request.prompt.includes('owner')) throw new Error('CLASS3_OWNER_SIGNATURE_REQUIRED: test gate')
    })
    const { run, provider } = await setup()
    const result = await run('return await agent("act as the owner")')
    expect(result.stopReason).toBe('error')
    expect(result.error).toContain('CLASS3_OWNER_SIGNATURE_REQUIRED: test gate')
    expect(provider.prompts).toEqual([])
    expect((await run('return await agent("read a file")')).value).toBe('answer to read a file')
  })

  it('her body installs enforceToolInvocation as the child gate when the ball runtime mounts', async () => {
    declareInProcessWorkflows()
    await mountE4()
    type Gate = (request: Record<string, unknown>) => void
    const host = (globalThis as Record<PropertyKey, unknown>)[WORKFLOW_EXECUTOR_KEY] as { gate?: Gate }
    expect(typeof host.gate).toBe('function')
    expect(() => { host.gate?.({ prompt: 'read a file' }) }).not.toThrow()
    // The same classifier as every other tool: a publishing action is owner-only (never reachable from agent() options).
    expect(() => { host.gate?.({ prompt: 'x', action: 'publish' }) }).toThrow(/CLASS3_OWNER_SIGNATURE_REQUIRED/)
  })

  it('agent({ maxTokens, timeoutMs }) reaches the child\'s model options (the repository door commit 2)', async () => {
    declareInProcessWorkflows()
    const { run, provider } = await setup()
    const result = await run('return await agent("bounded", { maxTokens: 2048, timeoutMs: 60000 })')
    expect(result).toMatchObject({ stopReason: 'completed', value: 'answer to bounded' })
    expect(provider.requests[0]?.agentOptions).toEqual({ maxTokens: 2048 })
    const bad = await run('return await agent("x", { maxTokens: 0 })')
    expect(bad.error).toContain('agent() option "maxTokens" must be a positive whole number')
  })

  it('a child past its timeoutMs is stopped and the call answers the closed code AGENT_TIMEOUT', async () => {
    declareInProcessWorkflows()
    const { run, provider } = await setup(prompt => prompt === 'slow' ? new Promise<SubagentResult>(() => {}) : text('quick'))
    const bare = await run('return await agent("slow", { timeoutMs: 30 })')
    expect(bare.stopReason).toBe('error')
    expect(bare.error).toContain('AGENT_TIMEOUT: agent() "slow" passed its timeoutMs 30')
    expect(provider.disposed).toBe(1)
    const caught = await run('try { await agent("slow", { timeoutMs: 30 }) } catch (error) { return error.code }')
    expect(caught.value).toBe('AGENT_TIMEOUT')
    const items = await run('return await parallel([() => agent("slow", { timeoutMs: 30 }), () => agent("fast")])')
    expect(items.value).toEqual([null, 'quick'])
  })

  it('her body states each new budget option in one sentence and declares max_tokens on subagent and subagent_fork', () => {
    const workflow = { name: 'workflow', description: 'Run a workflow.', parameters: { type: 'object', properties: {} } }
    const subagent = { name: 'subagent', description: 'Start one.', parameters: { type: 'object', properties: { reasoning_effort: { type: 'string' } } } }
    const fork = { name: 'subagent_fork', description: 'Fork one.', parameters: { type: 'object', properties: {} as Record<string, unknown> } }
    for (const definition of [workflow, subagent, fork, workflow, subagent]) describeBudgets(definition)
    expect(workflow.description).toBe(`Run a workflow.${WORKFLOW_BUDGET_SENTENCE}`)
    expect(subagent.description).toBe(`Start one.${SUBAGENT_BUDGET_SENTENCE}${SUBAGENT_REASONING_SENTENCE}`)
    expect(fork.description).toBe(`Fork one.${SUBAGENT_BUDGET_SENTENCE}`)
    expect(fork.parameters.properties.max_tokens).toMatchObject({ type: 'integer' })
    expect(subagent.parameters.properties).toHaveProperty('max_tokens')
  })
})
