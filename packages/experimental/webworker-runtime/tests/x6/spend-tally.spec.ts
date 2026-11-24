/**
 * `x6_self_state` gains a read-only `spend` section, counted in her worker for this page
 * life from the per-step usage her harness records (`assistant/message` events): per provider and model, the steps,
 * the uncached input, cache read, cache write and output tokens, and `usd` priced from the reference table
 * (src/claude-prices.ts), or null where no usage came back or no price is known. Never a guess.
 */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import SystemPrompt from '../../../../core/system-prompt/src/index.ts'
import ToolRuntime, * as dshTools from '../../../../core/tools/src/index.ts'
import { mountX6BallRuntime } from '../../src/x6/ball-loader.ts'
import { WorkerModuleLoader } from '../../src/module-system/module-loader.ts'
import { MemoryVfs } from '../../src/storage/memory.ts'
import { createSpendTally, projectSelfState, type SelfStateRegistry } from '../../src/x6/self-state.ts'
import { FakeSocket } from './e4-fixture.ts'

afterEach(() => { FakeSocket.instances.length = 0; vi.restoreAllMocks(); vi.unstubAllGlobals() })

const step = (provider: string, model: string, usage?: Record<string, number>, type = 'assistant/message') => ({
  type, seq: 1,
  data: { turn: 1, step: 1, message: { id: 'm', role: 'assistant', content: [], source: { kind: 'model', provider, model } },
    ...usage === undefined ? {} : { usage }, stream: [] },
})
const SESSION = { id: 'e5f6a7b8-typed-thread-0003' }
const close = (value: unknown, expected: number) => { expect(value as number).toBeCloseTo(expected, 9) }

describe('the spend tally', () => {
  it('counts each model\'s steps and tokens, prices Claude from the table, and sorts the rows', () => {
    const tally = createSpendTally(1_763_294_400_000)
    expect(tally.snapshot()).toEqual({ since: 1_763_294_400_000, byModel: [] })
    const used = { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 200_000, cacheWriteTokens: 3000, totalTokens: 204_500 }
    tally.observe(SESSION, step('anthropic-door', 'claude-fable-5-2', used))
    tally.observe(SESSION, step('anthropic-door', 'claude-fable-5-2', { inputTokens: 10, outputTokens: 20, totalTokens: 30 }))
    tally.observe(SESSION, step('anthropic-door', 'claude-opus-5-5', used))
    tally.observe(SESSION, { type: 'assistant/attempt', seq: 2, data: { turn: 1, step: 2, stream: [] } })
    tally.observe(SESSION, { type: 'user/message', seq: 3, data: { content: 'hi' } })
    const snap = tally.snapshot()
    expect(snap.byModel.map(row => [row.provider, row.model, row.steps, row.input, row.cacheRead, row.cacheWrite, row.output])).toEqual([
      ['anthropic-door', 'claude-fable-5-2', 2, 1010, 200_000, 3000, 520],
      ['anthropic-door', 'claude-opus-5-5', 1, 1000, 200_000, 3000, 500],
    ])
    close(snap.byModel[0]?.usd, (1010 * 8 + 200_000 * 0.2 + 3000 * 10 + 520 * 40) / 1e6)
    close(snap.byModel[1]?.usd, (1000 * 4 + 200_000 * 0.2 + 3000 * 5 + 500 * 20) / 1e6)
  })

  it('a call with no usage (the older chat wire logs 0/0/0) or no known price is counted in unpricedCalls; usd is null only when no call was priced; tokens still count', () => {
    const tally = createSpendTally(1)
    tally.observe(SESSION, step('anthropic-door', 'claude-fable-5-2', { inputTokens: 0, outputTokens: 0, totalTokens: 0 }))
    tally.observe(SESSION, step('anthropic-door', 'claude-fable-5-2', { inputTokens: 5, outputTokens: 5, totalTokens: 10 }))
    tally.observe(SESSION, step('anthropic-door', 'claude-sonnet-5-5'))
    tally.observe(SESSION, step('deepseek-official', 'deepseek-flash', { inputTokens: 100, outputTokens: 10, cacheReadTokens: 50, totalTokens: 160 }))
    expect(tally.snapshot().byModel).toEqual([
      { provider: 'anthropic-door', model: 'claude-fable-5-2', steps: 2, compactions: 0, input: 5, cacheRead: 0, cacheWrite: 0, output: 5, usd: (5 * 8 + 5 * 40) / 1e6, unpricedCalls: 1 },
      { provider: 'anthropic-door', model: 'claude-sonnet-5-5', steps: 1, compactions: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, usd: null, unpricedCalls: 1 },
      { provider: 'deepseek-official', model: 'deepseek-flash', steps: 1, compactions: 0, input: 100, cacheRead: 50, cacheWrite: 0, output: 10, usd: null, unpricedCalls: 1 },
    ])
  })

  // Review fix (2026-11-17): a compaction's summary call is a paid model call; its usage is recorded only on the
  // `compaction/summary` event (compaction-basic region.ts commitCompactionBody: provider, model, usage).
  const summary = (provider: string, model: string, usage?: Record<string, number>, llmStreamCall = true) => ({
    type: 'compaction/summary', seq: 9,
    data: { compactionId: 'c1', summary: [], provider, model, shadowedRange: { start: 1, end: 2 }, shadowedSeqs: [1],
      shadowedTokenCount: 10, ...usage === undefined ? {} : { usage }, ...llmStreamCall ? { llmStreamCall: true, rawOutput: [] } : {} },
  })

  it('counts each compaction summary call in its model\'s row, tokens and dollars, apart from the steps', () => {
    const tally = createSpendTally(1)
    tally.observe(SESSION, step('anthropic-door', 'claude-fable-5-2', { inputTokens: 1000, outputTokens: 2000, cacheReadTokens: 200_000, cacheWriteTokens: 8000 }))
    tally.observe(SESSION, summary('anthropic-door', 'claude-fable-5-2', { inputTokens: 100, outputTokens: 20_000, cacheWriteTokens: 574_000 }))
    // A summary written by a template (no model call) costs nothing and is not counted.
    tally.observe(SESSION, summary('anthropic-door', 'claude-fable-5-2', undefined, false))
    const [row] = tally.snapshot().byModel
    expect(row).toMatchObject({ provider: 'anthropic-door', model: 'claude-fable-5-2', steps: 1, compactions: 1,
      input: 1100, cacheRead: 200_000, cacheWrite: 582_000, output: 22_000, unpricedCalls: 0 })
    close(row?.usd, (1000 * 8 + 200_000 * 0.2 + 8000 * 10 + 2000 * 40) / 1e6 + (100 * 8 + 574_000 * 10 + 20_000 * 40) / 1e6)
  })

  it('a call with no usage never hides the dollars of the priced calls of the same model; it is counted apart', () => {
    const tally = createSpendTally(1)
    const used = { inputTokens: 1000, outputTokens: 2000, cacheReadTokens: 200_000, cacheWriteTokens: 8000 }
    tally.observe(SESSION, step('anthropic-door', 'claude-fable-5-2', used))
    tally.observe(SESSION, step('anthropic-door', 'claude-fable-5-2', { inputTokens: 0, outputTokens: 0, totalTokens: 0 }))
    tally.observe(SESSION, step('anthropic-door', 'claude-fable-5-2'))
    tally.observe(SESSION, step('anthropic-door', 'claude-fable-5-2', used))
    const [row] = tally.snapshot().byModel
    expect(row).toMatchObject({ steps: 4, compactions: 0, unpricedCalls: 2 })
    close(row?.usd, 2 * (1000 * 8 + 200_000 * 0.2 + 8000 * 10 + 2000 * 40) / 1e6)
  })

  it('ignores malformed events and never throws', () => {
    const tally = createSpendTally(1)
    for (const event of [null, 1, {}, { type: 'assistant/message' }, { type: 'assistant/message', data: { message: { source: {} } } },
      step('anthropic-door', 'claude-fable-5-2', { inputTokens: -1, outputTokens: 2 }), step('a'.repeat(300), 'm', { inputTokens: 1, outputTokens: 1 })]) {
      expect(() => { tally.observe(SESSION, event) }).not.toThrow()
    }
    expect(tally.snapshot().byModel).toEqual([])
  })
})

describe('x6_self_state carries spend, read-only', () => {
  const registry = (spend?: unknown): SelfStateRegistry => ({
    sourceRevision: null, bootedAtMs: 1, head: null, organs: [], staged: [], tools: [], cloudflareDoor: { registered: false, status: null },
    ...spend === undefined ? {} : { spend: spend as never },
  })
  const observe = (reg: SelfStateRegistry) => ({ registry: reg, store: {}, edge: { sourceRevision: null, reason: 'unreachable' as const }, organFilter: null })

  it('shows the tally as given; no key when the loader passes none; null when it is the wrong shape', () => {
    const spend = { since: 5, byModel: [{ provider: 'anthropic-door', model: 'claude-fable-5-2', steps: 1, compactions: 0, input: 1, cacheRead: 2, cacheWrite: 3, output: 4, usd: 0.5, unpricedCalls: 0 }] }
    expect(projectSelfState(observe(registry(spend))).spend).toEqual(spend)
    expect(projectSelfState(observe(registry()))).not.toHaveProperty('spend')
    expect(projectSelfState(observe(registry({ since: 'x', byModel: 3 }))).spend).toBeNull()
  })

  it('her mounted runtime counts the steps her sessions record and shows them in x6_self_state', async () => {
    const context = new Context()
    await context.plugin(SystemPrompt, {})
    await context.plugin(ToolRuntime)
    const vfs = new MemoryVfs()
    vi.stubGlobal('location', { origin: 'https://spend-tally.invalid' })
    vi.stubGlobal('BroadcastChannel', undefined)
    vi.stubGlobal('WebSocket', FakeSocket)
    vi.stubGlobal('__X6_SERVICES__', {})
    vi.stubGlobal('__X6_BALL__', undefined)
    vi.stubGlobal('__X6_BUILD_IDENTITY__', undefined)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'info').mockImplementation(() => {})
    vi.stubGlobal('fetch', async (resource: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(resource, init), url = new URL(request.url)
      if (url.origin !== 'https://spend-tally.invalid') throw new Error('External network is forbidden')
      if (url.pathname === '/_head/ball' && request.method === 'GET') return Response.json({ ok: true, ball: null, codeBySha: {} })
      return Response.json({ ok: false, code: 'NOT_IN_FIXTURE' }, { status: 404 })
    })
    const loader = new WorkerModuleLoader({ vfs, staticModules: { '@deepseek-ai/dsh-tools': () => dshTools } })
    await mountX6BallRuntime(context as never, vfs, loader)
    for (let i = 0; i < 10; i += 1) await new Promise(resolve => setTimeout(resolve, 0))
    const emit = (event: unknown) => { (context as unknown as { emit(...args: unknown[]): void }).emit('session/event', { id: SESSION.id }, event) }
    emit(step('anthropic-door', 'claude-fable-5-2', { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 200_000, cacheWriteTokens: 3000, totalTokens: 204_500 }))
    emit(step('anthropic-door', 'claude-fable-5-2', { inputTokens: 0, outputTokens: 0, totalTokens: 0 }))
    const tools = context.get('tools') as unknown as { get(name: string): { execute(args: unknown, ctx?: unknown): Promise<unknown> } | undefined }
    const answer: unknown = await tools.get('x6_self_state')?.execute({}, { signal: new AbortController().signal })
    const text = typeof answer === 'string' ? answer : JSON.stringify(answer)
    const parsed = JSON.parse(text.slice(text.indexOf('{'))) as { spend?: { since: number; byModel: unknown[] } }
    expect(typeof parsed.spend?.since).toBe('number')
    expect(parsed.spend?.byModel).toEqual([{ provider: 'anthropic-door', model: 'claude-fable-5-2', steps: 2, compactions: 0,
      input: 1000, cacheRead: 200_000, cacheWrite: 3000, output: 500,
      usd: (1000 * 8 + 200_000 * 0.2 + 3000 * 10 + 500 * 40) / 1e6, unpricedCalls: 1 }])
  })
})
