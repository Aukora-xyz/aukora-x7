/**
 * A subagent started on an OpenRouter model leaves her browser body by the same edge door as her
 * main mind. Nothing here is a fake of the path under test: the web bundle's own rows (`llm-pi-ai` provider routes and
 * `subagent-model-selection-settings`, read from packages/bundle/web-app/cordis.patch.yml), the real llm-pi-ai adapter
 * over the browser pi-ai module (webworker-runtime's shim, which the browser build puts in place of
 * `@earendil-works/pi-ai`, module-proxies.ts), the real agent loop, the real spawn backend and this tool. Only `fetch`
 * is scripted: it answers as the provider would and records every request that leaves the page.
 */
import { readFileSync } from 'node:fs'
import yaml from 'js-yaml'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import * as LlmPiAi from '../../../llm/llm-pi-ai/src/index.ts'
import { DEFAULT_MODELS as DEEPSEEK_MODELS } from '../../../llm/llm-deepseek/src/models.ts'
import { PUBLIC_BASE_URL as DEEPSEEK_BASE_URL } from '../../../llm/llm-deepseek/src/config.ts'
import { modelDoorFor } from '../../../experimental/webworker-runtime/src/model-doors.ts'
import { mountLocalActivations } from '../../subagent/tests/local-activation.ts'
import * as tool from '../src/index.ts'
import SubagentModelSelectionConfig from '../src/model-selection-settings.ts'
import { ownContext, testToolSignal, text } from './harness.ts'

// The browser build answers every `@earendil-works/pi-ai` import with this one module (webworker-runtime
// module-proxies.ts: the root and every subpath). The same substitution, at the files llm-pi-ai resolves.
vi.mock('../../../llm/llm-pi-ai/node_modules/@earendil-works/pi-ai/dist/index.js',
  () => import('../../../experimental/webworker-runtime/src/node/external_packages/pi-ai.ts'))
vi.mock('../../../llm/llm-pi-ai/node_modules/@earendil-works/pi-ai/dist/providers/all.js',
  () => import('../../../experimental/webworker-runtime/src/node/external_packages/pi-ai.ts'))
vi.mock('../../../llm/llm-pi-ai/node_modules/@earendil-works/pi-ai/dist/api/openai-completions.lazy.js',
  () => import('../../../experimental/webworker-runtime/src/node/external_packages/pi-ai.ts'))
vi.mock('../../../llm/llm-pi-ai/node_modules/@earendil-works/pi-ai/dist/api/anthropic-messages.lazy.js',
  () => import('../../../experimental/webworker-runtime/src/node/external_packages/pi-ai.ts'))
vi.mock('../../../llm/llm-pi-ai/node_modules/@earendil-works/pi-ai/dist/api/openai-responses.lazy.js',
  () => import('../../../experimental/webworker-runtime/src/node/external_packages/pi-ai.ts'))
vi.mock('../../../llm/llm-pi-ai/node_modules/@earendil-works/pi-ai/dist/utils/overflow.js',
  () => import('../../../experimental/webworker-runtime/src/node/external_packages/pi-ai.ts'))

const ORIGIN = 'https://node.example.invalid'
const OPENROUTER_DOOR = `${ORIGIN}/door/openrouter/v1/chat/completions`
const CHAT_DOOR = `${ORIGIN}/door/anthropic/v1/chat/completions`
const KIMI = 'moonshotai/kimi-k3.1-pro'
const ASTRA = 'openai/gpt-6-astra'

// The bundle's `!!js` expressions are read as their source text; only two plain rows are used.
const js = new yaml.Type('tag:yaml.org,2002:js', { kind: 'scalar', construct: (source: string) => source })
const bundle = yaml.load(readFileSync(new URL('../../../bundle/web-app/cordis.patch.yml', import.meta.url), 'utf8'),
  { schema: yaml.DEFAULT_SCHEMA.extend([js]) }) as unknown[]
function bundleRow(id: string): { config: Record<string, unknown> } {
  // A row is either a top-level patch entry or one of an `insert:` list's entries.
  const rows = bundle.flatMap((entry) => {
    const insert = (entry as { insert?: unknown }).insert
    return Array.isArray(insert) ? insert as unknown[] : [entry]
  })
  const row = rows.find(entry => typeof entry === 'object' && entry !== null && (entry as { id?: unknown }).id === id)
  if (row === undefined || typeof (row as { config?: unknown }).config !== 'object') throw new Error(`bundle row ${id} has no config`)
  return row as { config: Record<string, unknown> }
}

interface Sent {
  readonly url: string
  readonly init: RequestInit
  /** The request body exactly as sent. */
  readonly text: string
  readonly body: Record<string, unknown>
}

function sse(chunks: unknown[]): Response {
  const body = `${chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}
const say = (words: string) => sse([{ id: 'answer', choices: [{ delta: { content: words }, finish_reason: 'stop' }] }])
const callTool = (name: string, args: unknown) => sse([{ id: 'call', choices: [{
  delta: { tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name, arguments: JSON.stringify(args) } }] },
  finish_reason: 'tool_calls',
}] }])

/** Record every request that leaves the page; answer by the model it names, as the provider would. */
function provider(answer: (body: Record<string, unknown>, nthForModel: number) => Response): Sent[] {
  const sent: Sent[] = []
  const counts = new Map<string, number>()
  vi.stubGlobal('location', { origin: ORIGIN })
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const text = typeof init.body === 'string' ? init.body : ''
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const body = JSON.parse(text) as Record<string, unknown>
    sent.push({ url, init, text, body })
    const model = String(body.model)
    const nth = (counts.get(model) ?? 0) + 1
    counts.set(model, nth)
    return answer(body, nth)
  }))
  // What the browser body holds for the door routes: the placeholder that asks the edge to add its own key.
  vi.stubEnv('OPENROUTER_API_KEY', 'x5-edge-door')
  vi.stubEnv('ANTHROPIC_API_KEY', 'x5-edge-door')
  return sent
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

/** The web bundle's composition of this path, with her main mind on Kimi through the OpenRouter door. */
async function herBody(
  mind: Record<string, unknown> = { provider: 'openrouter-door', model: KIMI },
  piAi: Record<string, unknown> = bundleRow('llm-pi-ai').config,
): Promise<{ ctx: Context; parent: Agent }> {
  const ctx = ownContext(new Context())
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(SubagentModelSelectionConfig, bundleRow('subagent-model-selection-settings').config)
  await ctx.plugin(AgentLoop, { agents: [] })
  // A spawned child is continuable, so her body keeps sessions (here: a throwaway JSONL store, removed after the test).
  await mountLocalActivations(ctx)
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  await ctx.plugin(LlmPiAi, piAi)
  // Her profile's delegation row (mirror/home/profiles/web/cordis.patch.yml): spawn, with selection and discovery.
  await ctx.plugin(tool, { provider: 'spawn', toolName: 'subagent', modelSelection: true, modelDiscovery: true })
  const parent = await ctx.agentLoop.create(SessionId(`door-parent-${Math.random()}`), mind)
  return { ctx, parent }
}

async function settle(ctx: Context, agent: Agent): Promise<void> {
  do {
    await agent.whenIdle()
  } while (await ctx.subagents.waitForChildren(agent))
}

/** The edge's own request check (deploy/cloudflare/src/provider-budget.mjs), as the door runs it before any key. */
async function edgeAccepts(sent: Sent): Promise<string> {
  const budget = await import(new URL('../../../../deploy/cloudflare/src/provider-budget.mjs', import.meta.url).href) as {
    providerRequestReservation: (bytes: Uint8Array, limits: unknown, path: string) => { requestedModel: string }
  }
  const limits = { windowMs: 60_000, requests: 1000, tokens: 50_000_000, maxOutputTokens: 256_000 }
  const path = new URL(sent.url).pathname.replace(/^\/door\/[^/]+/, '')
  return budget.providerRequestReservation(new TextEncoder().encode(sent.text), limits, path).requestedModel
}

describe('the web bundle\'s subagent model list', () => {
  it('offers, on by default for a new session, every model her main mind can select through an edge door', () => {
    const selection = bundleRow('subagent-model-selection-settings').config as {
      enabled: boolean
      allowedModels: { provider: string; model: string }[]
      edgeDoors: { healthPath: string; routes: { provider: string; door: string }[] }
    }
    const doorRoutes = bundleRow('llm-pi-ai').config.providers as Record<string, { baseURL: string; models: { id: string }[] }>
    // Her main mind: the official DeepSeek route (its shipped catalog) and the composer's door routes, in that order.
    const mainMind = [
      ...DEEPSEEK_MODELS.map(model => ({ provider: 'deepseek-official', model: model.id })),
      ...Object.entries(doorRoutes).flatMap(([provider, route]) => route.models.map(model => ({ provider, model: model.id }))),
    ]
    expect(selection.enabled).toBe(true)
    expect(selection.allowedModels).toEqual(mainMind)
    expect(selection.allowedModels).toEqual(expect.arrayContaining([
      { provider: 'deepseek-official', model: 'deepseek-flash' },
      { provider: 'openrouter-door', model: KIMI },
      { provider: 'openrouter-door', model: ASTRA },
      { provider: 'anthropic-door', model: 'claude-fable-5-2' },
    ]))
    // Each route's door is the one its requests really take (webworker-runtime model-doors.ts), so a door the edge
    // reports without a key marks exactly the routes that would fail.
    const endpoint: Record<string, string> = {
      'deepseek-official': `${DEEPSEEK_BASE_URL}/v1/messages`,
      ...Object.fromEntries(Object.entries(doorRoutes).map(([provider, route]) => [provider, `${route.baseURL}/chat/completions`])),
    }
    expect(selection.edgeDoors.healthPath).toBe('/api/health')
    expect(selection.edgeDoors.routes.map(route => route.provider)).toEqual([...new Set(mainMind.map(route => route.provider))])
    for (const route of selection.edgeDoors.routes) {
      expect(modelDoorFor(endpoint[route.provider]!, ORIGIN), route.provider).toMatch(new RegExp(`^${ORIGIN}/door/${route.door}/`))
    }
  })
})

describe('a subagent on an OpenRouter model (the web bundle, her browser body)', () => {
  it('goes out by her main mind\'s own door: same route, same request shape, no key in the page', async () => {
    const sent = provider((body, nth) => {
      if (body.model === ASTRA) return say('child: done')
      return nth === 1
        ? callTool('subagent', { description: 'ask astra', prompt: 'Say done.', provider: 'openrouter-door', model: ASTRA })
        : say('parent: done')
    })
    const { ctx, parent } = await herBody()
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Ask a subagent on GPT Astra.' }], source: { kind: 'user' } }))
    await settle(ctx, parent)

    const main = sent.filter(request => request.body.model === KIMI)
    const child = sent.filter(request => request.body.model === ASTRA)
    expect(main.length).toBeGreaterThanOrEqual(2)
    expect(child).toHaveLength(1)
    expect(sent.every(request => request.body.model === KIMI || request.body.model === ASTRA)).toBe(true)
    // Same route: the same-origin OpenRouter door, never openrouter.ai itself.
    for (const request of [...main, ...child]) {
      expect(request.url).toBe(OPENROUTER_DOOR)
      expect(request.init.method).toBe('POST')
      expect(request.init.credentials).toBe('same-origin')
      // The key is added only at the edge: the page sends neither the placeholder nor any other credential.
      const headers = new Headers(request.init.headers)
      expect(headers.get('authorization')).toBeNull()
      expect(headers.get('x-api-key')).toBeNull()
      expect(request.text).not.toContain('x5-edge-door')
    }
    // Same request shape: the same top-level fields, the same wire options, accepted by the edge's own check.
    const [first] = main
    const [delegated] = child
    expect(Object.keys(delegated!.body).sort()).toEqual(Object.keys(first!.body).sort())
    expect([delegated!.body.stream, delegated!.body.max_tokens]).toEqual([first!.body.stream, first!.body.max_tokens])
    expect(await edgeAccepts(first!)).toBe(KIMI)
    expect(await edgeAccepts(delegated!)).toBe(ASTRA)
    // The child really ran on Astra, and its answer came home to her main mind by the same door.
    const delegations = parent.session.snapshotEvents().filter(event => event.type === 'tool/call' && event.data.name === 'subagent')
    expect(delegations).toHaveLength(1)
    expect(main.some(request => request.text.includes('child: done'))).toBe(true)
  }, 60_000)

  it('refuses a model outside her list with a sentence she can act on, and nothing leaves the page', async () => {
    const sent = provider(() => say('unused'))
    const { ctx, parent } = await herBody()
    const result = await executeToolFixture(ctx, {
      signal: testToolSignal,
      callId: ToolCallId('outside-the-list'),
      name: 'subagent',
      arguments: { description: 'outside', prompt: 'p', provider: 'openrouter-door', model: 'openai/gpt-4o' },
      agent: parent,
    })
    expect(result.isError).toBe(true)
    expect(text(result)).toBe(
      'Error: child LLM route "openrouter-door/openai/gpt-4o" is not allowed for this Session. '
      + 'Pick one of the routes this session allows (list_subagent_models lists them). '
      + 'Subagent model choices are fixed when a session starts: a Settings change applies to new sessions only.',
    )
    expect(sent).toEqual([])
  })
})

/** A Claude answer on the Messages wire, as the provider streams it. */
function claudeSay(words: string): Response {
  const events = [
    { type: 'message_start', message: { id: 'msg', model: 'claude-fable-5-2', usage: { input_tokens: 5, output_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: words } },
    { type: 'content_block_stop', index: 1 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } },
    { type: 'message_stop' },
  ]
  return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''),
    { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

describe('her main mind on Claude Fable 5.2 (the web bundle, her browser body)', () => {
  const FABLE = 'claude-fable-5-2'
  const MESSAGES_DOOR = `${ORIGIN}/door/anthropic/v1/messages`
  async function edgeAcceptsMessages(sent: Sent): Promise<{ requestedModel: string; outputTokens: number }> {
    const budget = await import(new URL('../../../../deploy/cloudflare/src/provider-budget.mjs', import.meta.url).href) as {
      providerRequestReservation: (bytes: Uint8Array, limits: unknown, path: string) => { requestedModel: string; outputTokens: number }
    }
    const limits = { windowMs: 60_000, requests: 1000, tokens: 50_000_000, maxOutputTokens: 256_000 }
    return budget.providerRequestReservation(new TextEncoder().encode(sent.text), limits, '/v1/messages')
  }
  const turn = async (ctx: Context, parent: Agent, words: string) => {
    parent.followup(createUserMessage({ content: [{ type: 'text', text: words }], source: { kind: 'user' } }))
    await settle(ctx, parent)
  }

  it('sends the chosen level by the Anthropic door as output_config.effort, and a change applies from the next turn', async () => {
    const sent = provider(() => claudeSay('ok'))
    const { ctx, parent } = await herBody({ provider: 'anthropic-door', model: FABLE, reasoningEffort: 'high' })
    await turn(ctx, parent, 'First.')
    expect(sent).toHaveLength(1)
    expect(sent[0]!.url).toBe(MESSAGES_DOOR)
    expect(sent[0]!.init.credentials).toBe('same-origin')
    expect(new Headers(sent[0]!.init.headers).get('authorization')).toBeNull()
    expect(sent[0]!.text).not.toContain('x5-edge-door')
    expect(sent[0]!.body.output_config).toEqual({ effort: 'high' })
    expect(sent[0]!.body.max_tokens).toBeGreaterThanOrEqual(16_000)
    expect(await edgeAcceptsMessages(sent[0]!)).toMatchObject({ requestedModel: FABLE })

    parent.model.select({ provider: 'anthropic-door', model: FABLE, reasoningEffort: 'max' } as never)
    await turn(ctx, parent, 'Second.')
    expect(sent).toHaveLength(2)
    expect(sent[1]!.body.output_config).toEqual({ effort: 'max' })
    expect(sent[1]!.body.max_tokens).toBeGreaterThanOrEqual(64_000)
    // Her own earlier thinking goes back unchanged, with its signature, in a body the edge still accepts.
    expect(sent[1]!.text).toContain('"signature":"sig"')
    expect(await edgeAcceptsMessages(sent[1]!)).toMatchObject({ requestedModel: FABLE })
  }, 60_000)

  it('the per-step usage record her harness keeps carries input, cache read, cache write and output', async () => {
    const cached = () => {
      const events = [
        { type: 'message_start', message: { id: 'msg', model: FABLE, usage: { input_tokens: 120, cache_read_input_tokens: 50_000,
          cache_creation_input_tokens: 3000, output_tokens: 1 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 40 } },
        { type: 'message_stop' },
      ]
      return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''),
        { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }
    provider(cached)
    const { ctx, parent } = await herBody({ provider: 'anthropic-door', model: FABLE })
    const recorded: unknown[] = []
    ctx.on('session/event', (_session, event) => {
      if (event.type === 'assistant/message') recorded.push(event.data.usage)
    })
    await turn(ctx, parent, 'Hello.')
    expect(recorded).toEqual([{ inputTokens: 120, outputTokens: 40, totalTokens: 53_160, cacheReadTokens: 50_000, cacheWriteTokens: 3000 }])
  }, 60_000)

  it('a conversation that names no level runs medium on the Messages wire, with its cache marks', async () => {
    const sent = provider(() => claudeSay('ok'))
    const { ctx, parent } = await herBody({ provider: 'anthropic-door', model: FABLE })
    await turn(ctx, parent, 'Hello.')
    expect(sent).toHaveLength(1)
    expect(sent[0]!.url).toBe(MESSAGES_DOOR)
    expect(sent[0]!.body.output_config).toEqual({ effort: 'medium' })
    expect(sent[0]!.text.split('"cache_control"').length - 1).toBe(2)
    expect(sent[0]!.text).not.toContain('x5-edge-door')
    expect(await edgeAcceptsMessages(sent[0]!)).toMatchObject({ requestedModel: FABLE })
  }, 60_000)
})

/**
 * Her default stays the wire she runs today. `auto`, first and the default,
 * is exactly what ran before the effort build: the chat-compatible wire, the same request bytes as at an earlier commit, no
 * effort field, no thinking replay. The five named levels opt in to the Messages wire; picking `auto` again returns the
 * conversation to the chat wire on its next turn, and a turn never mixes wires.
 */
describe('auto: her default is the wire she ran before', () => {
  const FABLE = 'claude-fable-5-2'
  const MESSAGES_DOOR = `${ORIGIN}/door/anthropic/v1/messages`
  /** Her Anthropic door exactly as the web bundle declared it at an earlier commit, before the effort build. */
  const BEFORE = {
    displayName: 'Anthropic',
    api: 'openai-completions',
    baseURL: 'https://api.anthropic.com/v1',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    compat: { maxTokensField: 'max_tokens', supportsDeveloperRole: false, supportsStore: false, supportsUsageInStreaming: false },
    models: [
      { id: 'claude-opus-5-5', name: 'Opus 5.5', contextWindow: 1000000, maxTokens: 128000, input: ['text'], reasoningEfforts: false },
      { id: 'claude-fable-5-2', name: 'Fable 5.2', contextWindow: 1000000, maxTokens: 128000, input: ['text'], reasoningEfforts: false },
      { id: 'claude-sonnet-5-5', name: 'Sonnet 5.5', contextWindow: 1000000, maxTokens: 128000, input: ['text'], reasoningEfforts: false },
    ],
  }
  const turn = async (ctx: Context, parent: Agent, words: string) => {
    parent.followup(createUserMessage({ content: [{ type: 'text', text: words }], source: { kind: 'user' } }))
    await settle(ctx, parent)
  }
  /** Answer on the wire the request came by: the Messages stream with a signed thinking block, or the chat stream. */
  const byWire = (words: string) => (body: Record<string, unknown>) => body.output_config === undefined ? say(words) : claudeSay(words)

  it('offers auto, low, medium, high, xhigh and max on each of her Claude models, auto first, medium the default', async () => {
    provider(() => say('unused'))
    const { ctx } = await herBody({ provider: 'anthropic-door', model: FABLE })
    for (const model of ['claude-fable-5-2', 'claude-opus-5-5', 'claude-sonnet-5-5']) {
      const info = await ctx.llm.resolveModelInfo('anthropic-door', model)
      expect(info.reasoning?.efforts.map(effort => effort.id)).toEqual(['auto', 'low', 'medium', 'high', 'xhigh', 'max'])
      expect(info.reasoning?.efforts.map(effort => effort.name)).toEqual(['Auto', 'Low', 'Medium', 'High', 'X-High', 'Max'])
      expect(info.reasoning?.efforts[0]?.description).toBe('the older connection: no caching, no usage shown, much costlier on long conversations')
      expect(info.reasoning?.defaultEffort).toBe('medium')
    }
    // Another provider's models are unchanged: still no effort at all.
    expect((await ctx.llm.resolveModelInfo('openrouter-door', KIMI)).reasoning).toBeUndefined()
  }, 60_000)

  it('she reads the six levels and the one she runs at from her own subagent model list', async () => {
    provider(() => say('unused'))
    const { ctx, parent } = await herBody({ provider: 'anthropic-door', model: FABLE })
    const result = await executeToolFixture(ctx, {
      signal: testToolSignal,
      callId: ToolCallId('list-claude-efforts'),
      name: 'list_subagent_models',
      arguments: { provider: 'anthropic-door', model: FABLE },
      agent: parent,
    })
    expect(result.isError).toBe(false)
    expect(text(result)).toContain('Reasoning efforts:\nauto — Auto: the older connection: no caching, no usage shown, much costlier on long conversations\n'
      + 'low — Low\nmedium (default) — Medium\nhigh — High\nxhigh — X-High\nmax — Max\nYou run at: medium (default) — Medium')
  }, 60_000)

  it('an explicit auto sends the same bytes to the same door as before the effort build, for the same conversation', async () => {
    const run = async (piAi: Record<string, unknown>, mind: Record<string, unknown>) => {
      const sent = provider(() => say('ok'))
      const { ctx, parent } = await herBody(mind, piAi)
      await turn(ctx, parent, 'First.')
      await turn(ctx, parent, 'Second.')
      vi.unstubAllGlobals()
      return sent
    }
    const bundle = bundleRow('llm-pi-ai').config as { providers: Record<string, unknown> }
    const before = await run({ providers: { ...bundle.providers, 'anthropic-door': BEFORE } }, { provider: 'anthropic-door', model: FABLE })
    // A conversation that names no level now runs medium (the Messages wire); only an explicit `auto` is the
    // older wire, byte for byte.
    const named = await run(bundle, { provider: 'anthropic-door', model: FABLE, reasoningEffort: 'auto' })
    expect(before).toHaveLength(2)
    for (const now of [named]) {
      expect(now.map(request => request.url)).toEqual(before.map(request => request.url))
      expect(now.map(request => request.text)).toEqual(before.map(request => request.text))
      const headers = (requests: Sent[]) => requests.map(request => Object.fromEntries(new Headers(request.init.headers)))
      expect(headers(now)).toEqual(headers(before))
    }
    expect(before[0]!.url).toBe(CHAT_DOOR)
    expect(before[1]!.text).toContain('First.')
  }, 60_000)

  it('a named level, then auto, then a named level: one wire per turn, and no thinking block reaches the chat wire', async () => {
    const sent = provider(byWire('ok'))
    const { ctx, parent } = await herBody({ provider: 'anthropic-door', model: FABLE, reasoningEffort: 'high' })
    await turn(ctx, parent, 'First.')
    parent.model.select({ provider: 'anthropic-door', model: FABLE, reasoningEffort: 'auto' } as never)
    await turn(ctx, parent, 'Second.')
    parent.model.select({ provider: 'anthropic-door', model: FABLE, reasoningEffort: 'high' } as never)
    await turn(ctx, parent, 'Third.')
    expect(sent.map(request => request.url)).toEqual([MESSAGES_DOOR, CHAT_DOOR, MESSAGES_DOOR])
    expect(sent.map(request => request.body.output_config)).toEqual([{ effort: 'high' }, undefined, { effort: 'high' }])
    // The chat turn carries her earlier words but neither the thinking block nor its signature, and no effort field.
    expect(sent[1]!.text).toContain('First.')
    expect(sent[1]!.text).not.toContain('"signature"')
    expect(sent[1]!.text).not.toContain('thinking')
    expect(await edgeAccepts(sent[1]!)).toBe(FABLE)
    // Back on the Messages wire the body is one the edge accepts there.
    const budget = await import(new URL('../../../../deploy/cloudflare/src/provider-budget.mjs', import.meta.url).href) as {
      providerRequestReservation: (bytes: Uint8Array, limits: unknown, path: string) => { requestedModel: string }
    }
    const limits = { windowMs: 60_000, requests: 1000, tokens: 50_000_000, maxOutputTokens: 256_000 }
    expect(budget.providerRequestReservation(new TextEncoder().encode(sent[2]!.text), limits, '/v1/messages').requestedModel).toBe(FABLE)
  }, 60_000)

  it('refuses a seventh effort for her Claude models before anything leaves the page', async () => {
    for (const reasoningEffort of ['off', 'minimal', 'extreme', 'Auto', 'AUTO']) {
      const sent = provider(() => say('unused'))
      const made: { ctx: Context; parent: Agent } | undefined = await herBody({ provider: 'anthropic-door', model: FABLE, reasoningEffort })
        .catch(() => undefined)
      if (made !== undefined) await turn(made.ctx, made.parent, 'Hello.').catch(() => undefined)
      expect(sent, reasoningEffort).toEqual([])
      vi.unstubAllGlobals()
    }
  }, 60_000)
})
