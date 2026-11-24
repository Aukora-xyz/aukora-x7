import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import { mountWorkingDirectoryFixture } from '../../subagent/tests/working-directory-fixture.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import {
  ToolCallId,
  LlmAdapter,
  ReasoningEffortId,
} from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmResolvedModelInfo,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as tool from '../src/index.ts'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import type { Agent, AgentOptions } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import SubagentModelSelectionConfig from '../src/model-selection-settings.ts'
import { modelSelectionSetupAgent, ownContext, setup, testToolSignal, text } from './harness.ts'

class CatalogAdapter extends LlmAdapter {
  constructor(private readonly empty = false) {
    super()
  }

  override providerInfo(provider: string) {
    return { id: provider, name: `${provider.toUpperCase()} API` }
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    if (this.empty) return Promise.resolve([])
    return Promise.resolve([
      { provider, id: 'fast', name: 'Fast', description: 'Focused work.' },
      { provider, id: 'plain', name: 'Plain' },
    ])
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    if (model === 'plain') return Promise.resolve({ provider, id: model, name: 'Plain' })
    return Promise.resolve({
      provider,
      id: model,
      name: 'Fast',
      description: 'Focused work.',
      reasoning: {
        efforts: [
          { id: ReasoningEffortId('low'), name: 'Low' },
          { id: ReasoningEffortId('high'), name: 'High', description: 'Quality first.' },
        ],
        defaultEffort: ReasoningEffortId('high'),
      },
    })
  }

  stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    return (async function* () { yield { type: 'finish' as const, reason: { kind: 'stop' as const } } })()
  }
}

/** Her Claude route, advertising the five levels as the browser adapter does. */
class ClaudeAdapter extends LlmAdapter {
  override providerInfo(provider: string) {
    return { id: provider, name: 'Anthropic' }
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve([{ provider, id: 'claude-fable-5-2', name: 'Fable 5.2' }])
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: 'Fable 5.2',
      reasoning: {
        // `auto` first and the default, then the five named levels, as the browser adapter lists them.
        efforts: [
          { id: ReasoningEffortId('auto'), name: 'Auto', description: 'the provider\'s own default, as before 2026-11-17' },
          ...['low', 'medium', 'high', 'xhigh', 'max'].map(id => ({ id: ReasoningEffortId(id), name: id === 'xhigh' ? 'X-High' : id.charAt(0).toUpperCase() + id.slice(1) })),
        ],
        defaultEffort: ReasoningEffortId('auto'),
      },
    })
  }

  stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    return (async function* () { yield { type: 'finish' as const, reason: { kind: 'stop' as const } } })()
  }
}

const callingAgents = new WeakMap<Context, Agent>()

/** Every listing ends by saying when its choices were fixed, so an old thread is not read as broken. */
const FOOTER = 'Subagent model choices are fixed when a session starts: a Settings change applies to new sessions only.'
const NO_POLICY_FOOTER = 'This session started without a subagent model list, so only its own model is offered. ' + FOOTER
const listed = (...lines: string[]) => [...lines, FOOTER].join('\n')

async function setupListTool(routes = [
  { provider: 'alpha', model: 'fast' },
  { provider: 'alpha', model: 'plain' },
  { provider: 'beta', model: 'fast' },
  { provider: 'beta', model: 'plain' },
], agentOptions?: AgentOptions) {
  const ctx = ownContext(new Context())
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentModelSelectionConfig, { enabled: true, allowedModels: routes })
  await mountWorkingDirectoryFixture(ctx)
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(tool, { provider: 'unused', modelDiscovery: true })
  const { agent } = await ctx.agents.create({
    sessionId: SessionId('discovery-parent'),
    ...agentOptions === undefined ? {} : { agentOptions },
  })
  callingAgents.set(ctx, agent)
  return ctx
}

async function setupAllowedListTool() {
  return setupListTool([
    { provider: 'alpha', model: 'fast' },
    { provider: 'alpha', model: 'unlisted' },
    { provider: 'missing', model: 'hidden' },
  ])
}

let counter = 0

function call(ctx: Context, args: unknown, signal = testToolSignal) {
  return executeToolFixture(ctx, {
    signal,
    callId: ToolCallId(`list-models-${++counter}`),
    name: 'list_subagent_models',
    arguments: args,
    ...callingAgents.has(ctx) ? { agent: callingAgents.get(ctx)! } : {},
  })
}

describe('list_subagent_models', () => {
  it('defaults discovery off independently of model selection', async () => {
    const ctx = await setup({ provider: 'mock', modelSelection: true })
    expect(ctx.tools.get('list_subagent_models')).toBeUndefined()
    const schema = ctx.tools.schemas().find(candidate => candidate.name === 'subagent')!
    expect(schema.parameters).toHaveProperty('properties.model')
  })

  it('registers discovery only on its configured owner and removes it on unload', async () => {
    const ctx = await setup({ provider: 'mock', modelSelection: true })
    const sibling = await ctx.plugin(tool, {
      provider: 'mock', toolName: 'other_subagent', modelSelection: true,
    })
    expect(ctx.tools.get('list_subagent_models')).toBeUndefined()
    const discoveryConfig = { provider: 'mock', toolName: 'discovery_subagent', modelDiscovery: true }
    const owner = await ctx.plugin(tool, discoveryConfig)
    const schemas = ctx.tools.schemas()
    expect(schemas.filter(schema => schema.name === 'list_subagent_models')).toHaveLength(1)
    expect(schemas.find(schema => schema.name === 'discovery_subagent')!.parameters)
      .not.toHaveProperty('properties.model')
    await sibling.dispose()
    expect(ctx.tools.get('list_subagent_models')).toBeDefined()
    await owner.dispose()
    expect(ctx.tools.get('list_subagent_models')).toBeUndefined()
    expect(ctx.tools.get('subagent')).toBeDefined()
    const reloaded = await ctx.plugin(tool, discoveryConfig)
    expect(ctx.tools.schemas().filter(schema => schema.name === 'list_subagent_models')).toHaveLength(1)
    await reloaded.dispose()
    expect(ctx.tools.get('list_subagent_models')).toBeUndefined()
  })

  it('rejects a second discovery owner in the same scope without removing the first', async () => {
    const ctx = await setup({ provider: 'mock', modelDiscovery: true })
    const definition = ctx.tools.get('list_subagent_models')
    await expect(ctx.plugin(tool, {
      provider: 'mock', toolName: 'other_subagent', modelDiscovery: true,
    })).rejects.toThrow('already registered')
    expect(ctx.tools.get('list_subagent_models')).toBe(definition)
    expect(ctx.tools.get('subagent')).toBeDefined()
  })

  it('keeps discovery registration and disposal local to each tool scope', async () => {
    const ctx = await setup({ provider: 'mock' })
    const first = await ctx.agents.create({ sessionId: SessionId('first-discovery-owner') })
    const second = await ctx.agents.create({ sessionId: SessionId('second-discovery-owner') })
    const config = { provider: 'mock', modelDiscovery: true }
    const firstOwner = await first.agent.ctx.plugin(tool, config)
    const secondOwner = await second.agent.ctx.plugin(tool, config)
    const firstDefinition = ctx.tools.get('list_subagent_models', first.agent)
    const secondDefinition = ctx.tools.get('list_subagent_models', second.agent)
    expect(firstDefinition).toBeDefined()
    expect(secondDefinition).toBeDefined()
    expect(firstDefinition).not.toBe(secondDefinition)
    expect(ctx.tools.get('list_subagent_models')).toBeUndefined()
    await firstOwner.dispose()
    expect(ctx.tools.get('list_subagent_models', first.agent)).toBeUndefined()
    expect(ctx.tools.get('list_subagent_models', second.agent)).toBe(secondDefinition)
    await secondOwner.dispose()
    expect(ctx.tools.get('list_subagent_models', second.agent)).toBeUndefined()
  })

  it('requires a calling Agent and an effective parent route', async () => {
    const ctx = ownContext(new Context())
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(NativeToolExecutor)
    await ctx.plugin(AgentRegistry)
    await mountWorkingDirectoryFixture(ctx)
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(tool, { provider: 'unused', modelDiscovery: true })
    expect(text(await call(ctx, {}))).toContain('requires a calling agent')
    await ctx.fiber.dispose()

    const parentContext = await setup({ provider: 'mock', withModelSelection: true, hostSelectionEnabled: false })
    const agent = modelSelectionSetupAgent(parentContext)
    const result = await executeToolFixture(parentContext, {
      signal: testToolSignal, callId: ToolCallId('missing-parent-route'),
      name: 'list_subagent_models', arguments: {}, agent,
    })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('without a parent provider and model')
  })

  it('reads the recorded Session allowlist through the delegation plugin', async () => {
    const ctx = await setup({ provider: 'mock', withModelSelection: true })
    ctx.llm.registerAdapter(['alpha', 'secret'], new CatalogAdapter())
    const result = await executeToolFixture(ctx, {
      signal: testToolSignal, callId: ToolCallId('recorded-routes'),
      name: 'list_subagent_models', arguments: {}, agent: modelSelectionSetupAgent(ctx),
    })
    expect(result.isError).toBe(false)
    expect(text(result)).toBe(listed('alpha — ALPHA API'))
  })

  it('stays registered without the LLM service and rejects discovery calls', async () => {
    const parent = await setupListTool()
    const ctx = ownContext(new Context())
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(NativeToolExecutor)
    await ctx.plugin(AgentRegistry)
    await mountWorkingDirectoryFixture(ctx)
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(tool, { provider: 'unused', modelDiscovery: true })
    callingAgents.set(ctx, callingAgents.get(parent)!)
    expect(ctx.tools.get('list_subagent_models')).toBeDefined()
    const result = await call(ctx, {})
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('`llm` service is unavailable')
  })

  it('lists registered providers and follows live registration changes', async () => {
    const ctx = await setupListTool()
    const empty = await call(ctx, {})
    expect(empty.isError).toBe(false)
    expect(text(empty)).toBe(listed('(no LLM providers)'))

    const registration = ctx.llm.registerAdapter(['alpha'], new CatalogAdapter())
    const providers = await call(ctx, {})
    expect(providers.isError).toBe(false)
    expect(text(providers)).toBe(listed('alpha — ALPHA API'))

    registration.replace(['beta'])
    const changed = await call(ctx, {})
    expect(text(changed)).toBe(listed('beta — BETA API'))

    const tools = ctx.tools
    await ctx.fiber.dispose()
    expect(tools.get('list_subagent_models')).toBeUndefined()
  })

  it('lists one provider\'s advertised models without treating the catalog as a whitelist', async () => {
    const ctx = await setupListTool()
    ctx.llm.registerAdapter(['alpha'], new CatalogAdapter())
    const result = await call(ctx, { provider: 'alpha' })
    expect(result.isError).toBe(false)
    expect(text(result)).toBe(listed('alpha/fast — Fast: Focused work.', 'alpha/plain — Plain'))
  })

  it('intersects provider and model discovery with the Session allowlist', async () => {
    const ctx = await setupAllowedListTool()
    ctx.llm.registerAdapter(['alpha', 'beta'], new CatalogAdapter())

    expect(text(await call(ctx, {}))).toBe(listed('alpha — ALPHA API'))
    expect(text(await call(ctx, { provider: 'alpha' }))).toBe(listed('alpha/fast — Fast: Focused work.'))
    expect(text(await call(ctx, { provider: 'alpha', model: 'unlisted' })))
      .toContain('alpha/unlisted — Fast')

    const denied = await call(ctx, { provider: 'alpha', model: 'plain' })
    expect(denied.isError).toBe(true)
    expect(text(denied)).toContain('is not allowed for this Session')
  })

  it('rejects an unauthorized provider before calling its adapter catalog', async () => {
    const ctx = await setupListTool([{ provider: 'alpha', model: 'fast' }])
    const adapter = new CatalogAdapter()
    const listModels = vi.spyOn(adapter, 'listModels')
    ctx.llm.registerAdapter(['alpha', 'secret'], adapter)

    const result = await call(ctx, { provider: 'secret' })

    expect(result.isError).toBe(true)
    expect(text(result)).toContain('provider "secret" is not allowed for this Session')
    expect(listModels).not.toHaveBeenCalled()
  })

  it('returns an empty list when the catalog contains no authorized model', async () => {
    const ctx = await setupListTool([{ provider: 'alpha', model: 'unlisted' }])
    ctx.llm.registerAdapter(['alpha'], new CatalogAdapter())
    const result = await call(ctx, { provider: 'alpha' })
    expect(result.isError).toBe(false)
    expect(text(result)).toBe(listed('(no advertised models for alpha)'))
  })

  it('lists authorized catalog entries without resolving removed or unlisted models', async () => {
    const ctx = await setupListTool([
      { provider: 'alpha', model: 'removed' },
      { provider: 'alpha', model: 'plain' },
    ])
    try {
      const adapter = new CatalogAdapter()
      const resolveModel = vi.spyOn(adapter, 'resolveModel').mockRejectedValue(new Error('lookup unavailable'))
      ctx.llm.registerAdapter(['alpha'], adapter)

      const result = await call(ctx, { provider: 'alpha' })
      expect(result.isError).toBe(false)
      expect(text(result)).toBe(listed('alpha/plain — Plain'))
      expect(resolveModel).not.toHaveBeenCalled()

      const exact = await call(ctx, { provider: 'alpha', model: 'removed' })
      expect(exact.isError).toBe(true)
      expect(text(exact)).toContain('lookup unavailable')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('rejects a failed catalog lookup', async () => {
    const ctx = await setupListTool()
    try {
      const adapter = new CatalogAdapter()
      vi.spyOn(adapter, 'listModels').mockRejectedValue(new Error('catalog unavailable'))
      ctx.llm.registerAdapter(['alpha'], adapter)
      const result = await call(ctx, { provider: 'alpha' })
      expect(result.isError).toBe(true)
      expect(text(result)).toContain('catalog unavailable')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('rejects cancellation after a catalog lookup', async () => {
    const ctx = await setupListTool()
    try {
      const controller = new AbortController()
      const adapter = new CatalogAdapter()
      vi.spyOn(adapter, 'listModels').mockImplementation(async () => {
        controller.abort(new Error('discovery cancelled'))
        return []
      })
      ctx.llm.registerAdapter(['alpha'], adapter)
      const result = await call(ctx, { provider: 'alpha' }, controller.signal)
      expect(result.isError).toBe(true)
      expect(text(result)).toContain('discovery cancelled')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it.each([false, true])('resolves only the current parent model without a Session policy (empty catalog: %s)', async (empty) => {
    const ctx = await setup({
      provider: 'mock',
      withModelSelection: true,
      hostSelectionEnabled: false,
      parentAgentOptions: { provider: 'alpha', model: 'unlisted' },
    })
    const adapter = new CatalogAdapter(empty)
    const listModels = vi.spyOn(adapter, 'listModels')
    ctx.llm.registerAdapter(['alpha'], adapter)
    const result = await executeToolFixture(ctx, {
      signal: testToolSignal, callId: ToolCallId('parent-only-discovery'),
      name: 'list_subagent_models', arguments: { provider: 'alpha' }, agent: modelSelectionSetupAgent(ctx),
    })
    expect(result.isError).toBe(false)
    expect(text(result)).toBe(['alpha/unlisted — Fast: Focused work. (your own model)', NO_POLICY_FOOTER].join('\n'))
    expect(listModels).not.toHaveBeenCalled()
  })

  it('always lists and answers for her own route, even when the Session list leaves it out', async () => {
    // Her main mind runs on a route outside the recorded list (the list names alpha, current-provider and missing only).
    const ctx = await setup({
      provider: 'mock',
      withModelSelection: true,
      parentAgentOptions: { provider: 'gamma', model: 'own-model' },
    })
    const adapter = new CatalogAdapter()
    ctx.llm.registerAdapter(['alpha', 'gamma', 'delta'], adapter)
    const agent = modelSelectionSetupAgent(ctx)
    const ask = (args: unknown) => executeToolFixture(ctx, {
      signal: testToolSignal, callId: ToolCallId(`own-route-${++counter}`),
      name: 'list_subagent_models', arguments: args, agent,
    })

    const providers = await ask({})
    expect(providers.isError).toBe(false)
    expect(text(providers)).toBe(listed('alpha — ALPHA API', 'gamma — GAMMA API (your own model: own-model)'))

    const gamma = await ask({ provider: 'gamma' })
    expect(gamma.isError).toBe(false)
    expect(text(gamma)).toBe(listed('gamma/own-model — Fast: Focused work. (your own model)'))

    const exact = await ask({ provider: 'gamma', model: 'own-model' })
    expect(exact.isError).toBe(false)
    expect(text(exact)).toBe(
      'gamma/own-model — Fast: Focused work. (your own model)\nReasoning efforts:\n'
      + 'low — Low\nhigh (default) — High: Quality first.\nYou run at: high (default) — High',
    )

    // A route in neither her own nor the list is still refused, with the sentence she can act on.
    const otherModel = await ask({ provider: 'gamma', model: 'fast' })
    expect(otherModel.isError).toBe(true)
    expect(text(otherModel)).toContain('child LLM route "gamma/fast" is not allowed for this Session; '
      + 'call list_subagent_models with `provider` for the models it allows')
    const otherProvider = await ask({ provider: 'delta' })
    expect(otherProvider.isError).toBe(true)
    expect(text(otherProvider)).toContain('LLM provider "delta" is not allowed for this Session; '
      + 'call list_subagent_models with no arguments for the providers it allows')
  })

  it('marks her own route in place when the Session list already names it', async () => {
    const ctx = await setupListTool(undefined, { provider: 'alpha', model: 'plain' })
    ctx.llm.registerAdapter(['alpha', 'beta'], new CatalogAdapter())
    expect(text(await call(ctx, {}))).toBe(listed('alpha — ALPHA API (your own model: plain)', 'beta — BETA API'))
    expect(text(await call(ctx, { provider: 'alpha' })))
      .toBe(listed('alpha/fast — Fast: Focused work.', 'alpha/plain — Plain (your own model)'))
    expect(text(await call(ctx, { provider: 'beta' }))).toBe(listed('beta/fast — Fast: Focused work.', 'beta/plain — Plain'))
    expect(text(await call(ctx, { provider: 'alpha', model: 'plain' })))
      .toBe('alpha/plain — Plain (your own model)\nReasoning efforts:\n(no advertised reasoning efforts)')
  })

  it('shows her Claude model six efforts, auto first, and names the one she runs at', async () => {
    const CLAUDE_EFFORTS = 'Reasoning efforts:\nauto (default) — Auto: the provider\'s own default, as before 2026-11-17\n'
      + 'low — Low\nmedium — Medium\nhigh — High\nxhigh — X-High\nmax — Max'
    const chosen = await setupListTool([{ provider: 'anthropic-door', model: 'claude-fable-5-2' }],
      { provider: 'anthropic-door', model: 'claude-fable-5-2', reasoningEffort: ReasoningEffortId('high') })
    chosen.llm.registerAdapter(['anthropic-door'], new ClaudeAdapter())
    expect(text(await call(chosen, { provider: 'anthropic-door', model: 'claude-fable-5-2' }))).toBe(
      `anthropic-door/claude-fable-5-2 — Fable 5.2 (your own model)\n${CLAUDE_EFFORTS}\nYou run at: high — High`)
    const unset = await setupListTool([{ provider: 'anthropic-door', model: 'claude-fable-5-2' }],
      { provider: 'anthropic-door', model: 'claude-fable-5-2' })
    unset.llm.registerAdapter(['anthropic-door'], new ClaudeAdapter())
    expect(text(await call(unset, { provider: 'anthropic-door', model: 'claude-fable-5-2' }))).toBe(
      `anthropic-door/claude-fable-5-2 — Fable 5.2 (your own model)\n${CLAUDE_EFFORTS}\nYou run at: auto (default) — Auto`)
    const auto = await setupListTool([{ provider: 'anthropic-door', model: 'claude-fable-5-2' }],
      { provider: 'anthropic-door', model: 'claude-fable-5-2', reasoningEffort: ReasoningEffortId('auto') })
    auto.llm.registerAdapter(['anthropic-door'], new ClaudeAdapter())
    expect(text(await call(auto, { provider: 'anthropic-door', model: 'claude-fable-5-2' }))).toBe(
      `anthropic-door/claude-fable-5-2 — Fable 5.2 (your own model)\n${CLAUDE_EFFORTS}\nYou run at: auto — Auto`)
    // A model that is not hers lists its efforts and names none as hers.
    const other = await setupListTool([{ provider: 'anthropic-door', model: 'claude-fable-5-2' }])
    other.llm.registerAdapter(['anthropic-door'], new ClaudeAdapter())
    expect(text(await call(other, { provider: 'anthropic-door', model: 'claude-fable-5-2' }))).toBe(
      `anthropic-door/claude-fable-5-2 — Fable 5.2\n${CLAUDE_EFFORTS}`)
  })

  it('inspects exact-model efforts, descriptions, and defaults', async () => {
    const ctx = await setupListTool()
    ctx.llm.registerAdapter(['alpha', 'secret'], new CatalogAdapter())
    const result = await call(ctx, { provider: 'alpha', model: 'fast' })
    expect(result.isError).toBe(false)
    expect(text(result)).toBe(
      'alpha/fast — Fast: Focused work.\nReasoning efforts:\n'
      + 'low — Low\nhigh (default) — High: Quality first.',
    )
  })

  it('renders exact models without reasoning metadata', async () => {
    const ctx = await setupListTool()
    ctx.llm.registerAdapter(['alpha'], new CatalogAdapter())
    const result = await call(ctx, { provider: 'alpha', model: 'plain' })
    expect(result.isError).toBe(false)
    expect(text(result)).toBe('alpha/plain — Plain\nReasoning efforts:\n(no advertised reasoning efforts)')
  })

  it.each([
    { args: { model: 'fast' }, expected: '`model` requires `provider`' },
    { args: { provider: '' }, expected: '`provider` must be non-empty' },
    { args: { provider: 'missing' }, expected: 'is not allowed for this Session' },
  ])('rejects incomplete or unavailable provider requests', async ({ args, expected }) => {
    const ctx = await setupListTool()
    const result = await call(ctx, args)
    expect(result.isError).toBe(true)
    expect(text(result)).toContain(expected)
  })

  it('rejects an empty exact model after resolving the provider', async () => {
    const ctx = await setupListTool()
    ctx.llm.registerAdapter(['alpha'], new CatalogAdapter())
    const result = await call(ctx, { provider: 'alpha', model: '' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('`model` must be non-empty')
  })

  it('reports registered alternatives for an unavailable provider', async () => {
    const ctx = await setupListTool([
      { provider: 'alpha', model: 'fast' },
      { provider: 'missing', model: 'fast' },
    ])
    ctx.llm.registerAdapter(['alpha'], new CatalogAdapter())
    const result = await call(ctx, { provider: 'missing' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('available providers: alpha')
    expect(text(result)).not.toContain('secret')
  })

  it('reports no available provider when the authorized registry intersection is empty', async () => {
    const ctx = await setupListTool([{ provider: 'missing', model: 'fast' }])
    const result = await call(ctx, { provider: 'missing' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('available providers: (none)')
  })
})

describe('list_subagent_models and the keys at the edge', () => {
  const ORIGIN = 'https://node.example.invalid'
  const EDGE_DOORS = {
    healthPath: '/api/health',
    routes: [{ provider: 'alpha', door: 'openrouter' }, { provider: 'beta', door: 'anthropic' }],
  }
  const NO_KEY = ' - unavailable: ALPHA API is switched on but has no key at the edge'

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  /** Her browser body: an edge origin whose `/api/health` answers `answer` (a status, or a body). */
  function edge(answer: unknown) {
    vi.stubGlobal('location', { origin: ORIGIN })
    const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(typeof answer === 'number'
      ? new Response('{}', { status: answer })
      : Response.json(answer)))
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }

  async function setupDoors(adapter = new CatalogAdapter(), agentOptions?: AgentOptions) {
    const ctx = ownContext(new Context())
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(SubagentModelSelectionConfig, {
      enabled: true,
      allowedModels: [
        { provider: 'alpha', model: 'fast' },
        { provider: 'alpha', model: 'plain' },
        { provider: 'beta', model: 'fast' },
      ],
      edgeDoors: EDGE_DOORS,
    })
    await mountWorkingDirectoryFixture(ctx)
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(tool, { provider: 'unused', modelDiscovery: true })
    const { agent } = await ctx.agents.create({
      sessionId: SessionId('door-discovery-parent'),
      ...agentOptions === undefined ? {} : { agentOptions },
    })
    callingAgents.set(ctx, agent)
    ctx.llm.registerAdapter(['alpha', 'beta'], adapter)
    return ctx
  }

  it('marks every route behind a door with no key at the edge, never as usable and never dropped', async () => {
    const fetchMock = edge({ ok: true, capabilities: { providerDoors: { openrouter: false, anthropic: true, deepseek: true } } })
    const adapter = new CatalogAdapter()
    const listModels = vi.spyOn(adapter, 'listModels')
    const ctx = await setupDoors(adapter)

    expect(text(await call(ctx, {}))).toBe(listed(`alpha — ALPHA API${NO_KEY}`, 'beta — BETA API'))
    const alpha = await call(ctx, { provider: 'alpha' })
    expect(alpha.isError).toBe(false)
    expect(text(alpha)).toBe(listed(`alpha/fast${NO_KEY}`, `alpha/plain${NO_KEY}`))
    expect(listModels).not.toHaveBeenCalledWith('alpha')
    expect(text(await call(ctx, { provider: 'beta' }))).toBe(listed('beta/fast — Fast: Focused work.'))
    const exact = await call(ctx, { provider: 'alpha', model: 'plain' })
    expect(text(exact)).toBe(`alpha/plain — Plain${NO_KEY}\nReasoning efforts:\n(no advertised reasoning efforts)`)

    // The edge's own answer, read on this origin with the session cookie, on every listing (a key set a minute ago counts).
    expect(fetchMock).toHaveBeenCalledTimes(4)
    for (const [url, init] of fetchMock.mock.calls) {
      expect(url).toBe(`${ORIGIN}/api/health`)
      expect(init).toMatchObject({ method: 'GET', credentials: 'same-origin', cache: 'no-store' })
    }
  })

  it('tells the same door truth about her own route as about any listed route', async () => {
    edge({ ok: true, capabilities: { providerDoors: { openrouter: false, anthropic: true } } })
    const ctx = await setupDoors(new CatalogAdapter(), { provider: 'alpha', model: 'own-model' })
    expect(text(await call(ctx, {})))
      .toBe(listed(`alpha — ALPHA API (your own model: own-model)${NO_KEY}`, 'beta — BETA API'))
    expect(text(await call(ctx, { provider: 'alpha' })))
      .toBe(listed(`alpha/fast${NO_KEY}`, `alpha/plain${NO_KEY}`, `alpha/own-model (your own model)${NO_KEY}`))
    expect(text(await call(ctx, { provider: 'alpha', model: 'own-model' })))
      .toBe(`alpha/own-model — Fast: Focused work. (your own model)${NO_KEY}\nReasoning efforts:\n`
        + 'low — Low\nhigh (default) — High: Quality first.\nYou run at: high (default) — High')
  })

  it('lists every route as usable once the edge holds the key', async () => {
    edge({ ok: true, capabilities: { providerDoors: { openrouter: true, anthropic: true } } })
    const ctx = await setupDoors()
    expect(text(await call(ctx, {}))).toBe(listed('alpha — ALPHA API', 'beta — BETA API'))
    expect(text(await call(ctx, { provider: 'alpha' }))).toBe(listed('alpha/fast — Fast: Focused work.', 'alpha/plain — Plain'))
  })

  it.each([
    [503, 'Edge key check not run: the edge health answer was HTTP 503.'],
    [{ ok: true, capabilities: {} }, 'Edge key check not run: the edge health answer names no provider doors.'],
    [{ ok: true, capabilities: { providerDoors: { deepseek: false } } }, 'Edge key check not run: the edge does not report the openrouter door.'],
  ])('says so, and claims nothing, when the edge cannot tell (%j)', async (answer, note) => {
    edge(answer)
    const ctx = await setupDoors()
    const result = await call(ctx, { provider: 'alpha' })
    expect(result.isError).toBe(false)
    expect(text(result)).toBe(['alpha/fast — Fast: Focused work.', 'alpha/plain — Plain', note, FOOTER].join('\n'))
  })

  it('says the check did not run in a body with no edge origin, and reads nothing', async () => {
    const fetchMock = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', fetchMock)
    const ctx = await setupDoors()
    expect(text(await call(ctx, {}))).toBe(listed('alpha — ALPHA API', 'beta — BETA API', 'Edge key check not run: this body has no edge origin.'))
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reads nothing for providers with no door', async () => {
    const fetchMock = edge({ ok: true, capabilities: { providerDoors: { openrouter: false } } })
    const ctx = await setupListTool()
    ctx.llm.registerAdapter(['alpha'], new CatalogAdapter())
    expect(text(await call(ctx, { provider: 'alpha' }))).toBe(listed('alpha/fast — Fast: Focused work.', 'alpha/plain — Plain'))
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refuses a door table that names a door the edge could never report', async () => {
    const ctx = ownContext(new Context())
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await expect(ctx.plugin(SubagentModelSelectionConfig, {
      enabled: true,
      allowedModels: [{ provider: 'alpha', model: 'fast' }],
      edgeDoors: { healthPath: '/api/health', routes: [{ provider: 'alpha', door: 'Open Router!' }] },
    })).rejects.toThrow('edge door "Open Router!" for provider "alpha" must be a lowercase door name')
  })

  it('says in both tool descriptions that a Settings change applies to new sessions only', async () => {
    const ctx = await setup({ provider: 'mock', modelSelection: true, modelDiscovery: true })
    const schemas = ctx.tools.schemas()
    expect(schemas.find(schema => schema.name === 'subagent')!.description)
      .toContain('Subagent model choices are fixed when a session starts: a Settings change applies to new sessions only.')
    expect(schemas.find(schema => schema.name === 'list_subagent_models')!.description)
      .toContain('Subagent model choices are fixed when a session starts: a Settings change applies to new sessions only.')
    expect(schemas.find(schema => schema.name === 'list_subagent_models')!.description)
      .toContain('Your own model is always listed and allowed, marked "your own model".')
  })
})
