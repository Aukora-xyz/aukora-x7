/**
 * Her Claude conversations compact early. Every preset her browser body can mount (standard, cordis,
 * ptc, minimal) carries compaction-basic `modelPolicies` for the three anthropic-door models at thresholdRatio 0.2 and
 * retainRatio 0.04 (40,000 of the 1,000,000 window; a ratio, so a smaller declared window can never put the tail above
 * the threshold); their declared context window stays 1,000,000 (never a smaller one), no cheaper summary model is
 * set, and the DeepSeek entries are unchanged.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { DEFAULT_SCHEMA, Type, load } from 'js-yaml'
import { describe, expect, it } from 'vitest'
import { resolveCompactSpec, resolveConfig, resolveTargetPolicy } from '../../../compaction/compaction-basic/src/config.ts'
import type { BasicCompactionConfig } from '../../../compaction/compaction-basic/src/types.ts'

type Row = { id?: string; name?: string; config?: unknown }
/** The patch files tag Loader expressions `!!js`; they are kept as plain text here. */
const SCHEMA = DEFAULT_SCHEMA.extend([new Type('tag:yaml.org,2002:js', { kind: 'scalar', construct: (text: string) => text })])
const read = (relative: string): unknown => load(readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8'), { schema: SCHEMA })

/** Every row in a patch tree, groups included. */
function rows(node: unknown, out: Row[] = []): Row[] {
  if (Array.isArray(node)) for (const item of node) rows(item, out)
  else if (node && typeof node === 'object') {
    const row = node as Row
    if (typeof row.id === 'string') out.push(row)
    for (const value of Object.values(node)) rows(value, out)
  }
  return out
}

const PRESETS = ['standard', 'cordis', 'ptc', 'minimal'] as const
const CLAUDE = ['claude-fable-5-2', 'claude-opus-5-5', 'claude-sonnet-5-5'] as const
/** Reserved output -> the verbatim tail on a 1,000,000 window: floor((1,000,000 - reserved) x 0.04). */
const TAILS = [[0, 40_000], [128_000, 34_880]] as const
const DEEPSEEK = [
  { provider: 'deepseek-official', model: 'deepseek-flash', thresholdRatio: 0.35 },
  { provider: 'deepseek-official', model: 'deepseek-v4-pro', thresholdRatio: 0.35 },
]

function compactionConfig(preset: string): BasicCompactionConfig {
  const row = rows(read(`../presets/${preset}.patch.yml`)).find(item => item.id === 'compaction-basic')
  expect(row, `${preset}: compaction-basic row`).toBeDefined()
  const config: BasicCompactionConfig = row?.config ?? {}
  return config
}

function claudeWindows(): Record<string, number> {
  const pi = rows(read('../cordis.patch.yml')).find(item => item.id === 'llm-pi-ai'
    && (item.config as { providers?: Record<string, unknown> } | undefined)?.providers?.['anthropic-door'] !== undefined)
  const models = ((pi?.config as { providers: Record<string, { models: Array<{ id: string; contextWindow: number }> }> })
    .providers['anthropic-door']?.models) ?? []
  return Object.fromEntries(models.map(model => [model.id, model.contextWindow]))
}

describe('Claude conversations compact near 200 thousand tokens in every browser preset', () => {
  it('the declared Claude windows stay 1,000,000', () => {
    expect(claudeWindows()).toEqual({ 'claude-opus-5-5': 1_000_000, 'claude-fable-5-2': 1_000_000, 'claude-sonnet-5-5': 1_000_000 })
  })

  for (const preset of PRESETS) {
    it(`${preset}: the three Claude routes resolve to a 200,000 threshold and a 40,000 tail; DeepSeek is unchanged`, () => {
      const config = compactionConfig(preset)
      const policies = config.modelPolicies ?? []
      expect(policies.filter(policy => policy.provider === 'deepseek-official')).toEqual(DEEPSEEK)
      expect(policies.filter(policy => policy.provider === 'anthropic-door')).toEqual(CLAUDE.map(model => (
        { provider: 'anthropic-door', model, thresholdRatio: 0.2, retainRatio: 0.04 })))
      // No cheaper summary model anywhere: the summary is written by the conversation's own model.
      expect(config.summarizationProvider ?? '').toBe('')
      expect(JSON.stringify(policies)).not.toContain('summarization')
      const resolved = resolveConfig(config)
      const windows = claudeWindows()
      for (const model of CLAUDE) {
        const policy = resolveTargetPolicy(resolved, { provider: 'anthropic-door', model })
        // Reserved output 0 (no cap asked) and 128,000 (the model's whole output) give the same threshold; the tail is
        // 4% of what is left for messages.
        for (const [reserved, tail] of TAILS) {
          const spec = resolveCompactSpec(policy, windows[model]!, reserved)
          expect(spec).toMatchObject({ contextWindow: 1_000_000, thresholdTokens: 200_000, retainTokens: tail,
            summarizationProvider: '', summarizationModel: '' })
        }
      }
      for (const { model } of DEEPSEEK) {
        const spec = resolveCompactSpec(resolveTargetPolicy(resolved, { provider: 'deepseek-official', model }), 1_048_576, 0)
        expect(spec.thresholdTokens).toBe(Math.floor(1_048_576 * 0.35))
        expect(spec.retainTokens).toBe(Math.floor(1_048_576 * 0.16))
      }
      // Any other route keeps the default 0.8.
      expect(resolveTargetPolicy(resolved, { provider: 'openrouter-door', model: 'openai/gpt-6.1-sol' }).thresholdRatio).toBe(0.8)
    })
  }
})

/**
 * Her own mode (`auma-alien`) is mounted from her home patch, which the repo's presets do
 * not reach; its compaction-basic row names only the two DeepSeek routes. So the three Claude routes also carry a
 * built-in policy inside compaction-basic, used only when the mounted configuration names no policy for the exact route.
 */
describe('a preset that names no Claude policy (her home patch) still compacts Claude near 200 thousand tokens', () => {
  /** Her home patch's compaction-basic config as mirrored on 2026-11-17: the two DeepSeek entries, nothing else. */
  const HOME: BasicCompactionConfig = { modelPolicies: DEEPSEEK.map(policy => ({ ...policy })) }

  it('the three Claude routes resolve to a 200,000 threshold and a 40,000 tail with her home patch and with no config', () => {
    for (const config of [HOME, {}]) {
      const resolved = resolveConfig(config)
      for (const model of CLAUDE) {
        const policy = resolveTargetPolicy(resolved, { provider: 'anthropic-door', model })
        for (const [reserved, tail] of TAILS) {
          expect(resolveCompactSpec(policy, 1_000_000, reserved)).toMatchObject({
            contextWindow: 1_000_000, thresholdTokens: 200_000, retainTokens: tail, summarizationProvider: '', summarizationModel: '',
          })
        }
      }
    }
  })

  it('her DeepSeek routes and every other route are untouched', () => {
    const resolved = resolveConfig(HOME)
    for (const { model } of DEEPSEEK) {
      const spec = resolveCompactSpec(resolveTargetPolicy(resolved, { provider: 'deepseek-official', model }), 1_048_576, 0)
      expect(spec.thresholdTokens).toBe(Math.floor(1_048_576 * 0.35))
      expect(spec.retainTokens).toBe(Math.floor(1_048_576 * 0.16))
    }
    expect(resolveTargetPolicy(resolved, { provider: 'openrouter-door', model: 'openai/gpt-6.1-sol' }).thresholdRatio).toBe(0.8)
    // The same model id on another provider, and another model on the same provider, keep the default.
    expect(resolveTargetPolicy(resolved, { provider: 'openrouter-door', model: 'claude-fable-5-2' }).thresholdRatio).toBe(0.8)
    expect(resolveTargetPolicy(resolved, { provider: 'anthropic-door', model: 'claude-haiku-5-5' }).thresholdRatio).toBe(0.8)
  })

  it('an entry she writes for a Claude route wins whole: nothing of the built-in policy leaks into it', () => {
    const resolved = resolveConfig({ modelPolicies: [{ provider: 'anthropic-door', model: 'claude-fable-5-2', thresholdRatio: 0.5 }] })
    const hers = resolveCompactSpec(resolveTargetPolicy(resolved, { provider: 'anthropic-door', model: 'claude-fable-5-2' }), 1_000_000, 0)
    expect(hers.thresholdTokens).toBe(500_000)
    expect(hers.retainTokens).toBe(Math.floor(1_000_000 * 0.16)) // the service default tail, not the built-in 40,000
    // A route she did not name keeps the built-in policy.
    const other = resolveCompactSpec(resolveTargetPolicy(resolved, { provider: 'anthropic-door', model: 'claude-opus-5-5' }), 1_000_000, 0)
    expect(other).toMatchObject({ thresholdTokens: 200_000, retainTokens: 40_000 })
    // A top-level fixed tail in her config does not displace the built-in ratio tail on a route she did not name.
    const fixed = resolveConfig({ retainTokens: 150_000 })
    expect(resolveCompactSpec(resolveTargetPolicy(fixed, { provider: 'anthropic-door', model: 'claude-fable-5-2' }), 1_000_000, 0))
      .toMatchObject({ thresholdTokens: 200_000, retainTokens: 40_000 })
  })

  // Review of the fix: with a fixed 40,000-token tail, a Claude row declared at 200,000 tokens or less resolved to
  // a threshold no higher than the tail, so every step warned once and skipped compaction, and every switch to that
  // model was refused. A ratio tail cannot do that.
  it('never fails a route the service default would serve: smaller declared windows, in her home patch and in each preset', () => {
    const configs: Array<[string, BasicCompactionConfig]> = [['home patch', HOME], ['no config', {}],
      ...PRESETS.map((preset): [string, BasicCompactionConfig] => [preset, compactionConfig(preset)])]
    let served = 0
    for (const [name, config] of configs) {
      const resolved = resolveConfig(config)
      for (const window of [1_000_000, 400_000, 300_000, 250_000, 200_000, 150_000, 100_000]) {
        for (const reserved of [0, 32_000, 64_000, 128_000]) {
          const spec = (model: string) => resolveCompactSpec(
            resolveTargetPolicy(resolved, { provider: 'anthropic-door', model }), window, reserved)
          let fallback: ReturnType<typeof spec>
          // A route with no entry anywhere: the service default. Where even that cannot be served, nothing is claimed.
          try { fallback = spec('claude-haiku-5-5') } catch { continue }
          served += 1
          for (const model of CLAUDE) {
            const claude = spec(model)
            const where = `${name}: ${model} window ${String(window)} reserved ${String(reserved)}`
            expect(claude.thresholdTokens, where).toBeLessThanOrEqual(fallback.thresholdTokens)
            expect(claude.retainTokens, where).toBeLessThan(claude.thresholdTokens)
            expect(claude.retainTokens, where).toBeLessThanOrEqual(fallback.retainTokens)
          }
        }
      }
    }
    expect(served).toBeGreaterThan(100) // the loop really ran: most combinations are servable
  })

  it('a service-wide threshold below the built-in one is kept (the built-in policy never raises a threshold)', () => {
    const resolved = resolveConfig({ thresholdRatio: 0.1, retainTokens: 20_000 })
    const spec = resolveCompactSpec(resolveTargetPolicy(resolved, { provider: 'anthropic-door', model: 'claude-fable-5-2' }), 1_000_000, 0)
    expect(spec).toMatchObject({ thresholdTokens: 100_000, retainTokens: 20_000 })
  })
})
