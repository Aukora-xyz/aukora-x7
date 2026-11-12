/**
 * Round 36: the composer pill's routes, as the web bundle patch (packages/bundle/web-app/cordis.patch.yml) declares them,
 * pass this adapter's own schema and strict resolution (what a Models-page write must pass) and serve exactly the ten
 * models the pill names, on the chat wire the edge doors accept.
 */
import { readFileSync } from 'node:fs'
import yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'
import { assertServiceable, Config, resolveProfiles } from '../src/config.ts'

// The bundle's `!!js` expressions are read as their source text; only the pi-ai row matters here.
const js = new yaml.Type('tag:yaml.org,2002:js', { kind: 'scalar', construct: (text: string) => text })
const patch = yaml.load(readFileSync(new URL('../../../bundle/web-app/cordis.patch.yml', import.meta.url), 'utf8'),
  { schema: yaml.DEFAULT_SCHEMA.extend([js]) }) as unknown[]
const row = patch.find((entry): entry is { id: string; config: { providers: unknown } } =>
  typeof entry === 'object' && entry !== null && (entry as { id?: unknown }).id === 'llm-pi-ai')

describe('Round 36 composer routes in the web bundle', () => {
  it('resolve strictly to the ten models the pill names, text-only, non-reasoning, with no streamed usage', () => {
    type Providers = NonNullable<Parameters<typeof resolveProfiles>[0]>
    const providers = Config(structuredClone(row?.config) as Parameters<typeof Config>[0]).providers.get() as Providers
    expect(() => { assertServiceable({ providers }) }).not.toThrow()
    const routes = [...resolveProfiles(providers, 'strict').values()]
    expect(routes.map(route => [route.provider, route.displayName, route.baseURL, route.catalogError, route.modelErrors.size])).toEqual([
      ['anthropic-door', 'Anthropic', 'https://api.anthropic.com/v1', undefined, 0],
      ['openrouter-door', 'OpenRouter', 'https://openrouter.ai/api/v1', undefined, 0],
    ])
    const served = routes.flatMap(route => route.piProvider?.getModels() ?? [])
    expect(served.map(entry => `${entry.id}=${entry.name}`)).toEqual([
      'claude-opus-5-5=Opus 5.5', 'claude-fable-5-2=Fable 5.2', 'claude-sonnet-5-5=Sonnet 5.5',
      'moonshotai/kimi-k3.1-pro=Kimi K3.1 Pro', 'openai/gpt-6.1-sol=GPT-6.1 Sol', 'openai/gpt-6-astra=GPT-6 Astra',
      'meta/muse-spark-1.3=Meta Muse Spark 1.3', 'z-ai/glm-5.3=GLM 5.3', 'google/gemini-4-argon=Gemini 4 Argon', 'x-ai/grok-4.7=Grok 4.7',
    ])
    for (const entry of served) {
      const compat = entry.compat as { supportsUsageInStreaming?: boolean; maxTokensField?: string } | undefined
      expect([entry.api, entry.input, entry.reasoning, compat?.supportsUsageInStreaming, compat?.maxTokensField])
        .toEqual(['openai-completions', ['text'], false, false, 'max_tokens'])
    }
    for (const route of routes) expect(route.configuredMaxTokens.size).toBe(route.provider === 'anthropic-door' ? 3 : 7)
  })
})
