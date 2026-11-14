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
async function herBody(): Promise<{ ctx: Context; parent: Agent }> {
  const ctx = ownContext(new Context())
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(SubagentModelSelectionConfig, bundleRow('subagent-model-selection-settings').config)
  await ctx.plugin(AgentLoop, { agents: [] })
  // A spawned child is continuable, so her body keeps sessions (here: a throwaway JSONL store, removed after the test).
  await mountLocalActivations(ctx)
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  await ctx.plugin(LlmPiAi, bundleRow('llm-pi-ai').config)
  // Her profile's delegation row (mirror/home/profiles/web/cordis.patch.yml): spawn, with selection and discovery.
  await ctx.plugin(tool, { provider: 'spawn', toolName: 'subagent', modelSelection: true, modelDiscovery: true })
  const parent = await ctx.agentLoop.create(SessionId(`door-parent-${Math.random()}`), { provider: 'openrouter-door', model: KIMI })
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
  return budget.providerRequestReservation(new TextEncoder().encode(sent.text), limits, new URL(sent.url).pathname.slice('/door/openrouter'.length)).requestedModel
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
