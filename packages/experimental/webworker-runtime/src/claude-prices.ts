/**
 * What one step of her working self on Claude costs, in US dollars per million tokens, copied from
 * the provider's reference (claude-api skill 2.1.325, shared/models.md and shared/prompt-caching.md), never from memory:
 *
 * - Fable 5.2: models.md line 78, "$8 / $40 per MTok; cache reads $0.20/MTok - 0.025x; 5-minute cache writes $10".
 * - Opus 5.5: models.md line 83, "$4 / $20 per MTok; cache reads $0.20".
 * - Sonnet 5.5: models.md line 89, "$2 / $10 per MTok, except cache reads at $0.10".
 * - 5-minute cache writes for Opus 5.5 and Sonnet 5.5 (not named per model there): prompt-caching.md line 144, "Cache
 *   writes cost 1.25x for 5-minute TTL", so 4 x 1.25 = 5 and 2 x 1.25 = 2.5.
 *
 * Her Messages wire sends only the 5-minute mark, so no 1-hour write price is used. A model outside this table has no
 * price here: its cost is unknown (null), never a guess.
 */
export interface ClaudePrice {
  /** Uncached input (`input_tokens`), per million. */
  readonly input: number
  /** Output (thinking and words), per million. */
  readonly output: number
  /** Read from the cache (`cache_read_input_tokens`), per million. */
  readonly cacheRead: number
  /** Written to the 5-minute cache (`cache_creation_input_tokens`), per million. */
  readonly cacheWrite: number
}

export const CLAUDE_PRICES: Readonly<Record<string, ClaudePrice>> = Object.freeze({
  'claude-fable-5-2': Object.freeze({ input: 8, output: 40, cacheRead: 0.2, cacheWrite: 10 }),
  'claude-opus-5-5': Object.freeze({ input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 }),
  'claude-sonnet-5-5': Object.freeze({ input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 }),
})

/** One step's token counts, as the Messages wire reports them (`input` is the uncached rest only). */
export interface ClaudeStepTokens {
  readonly input: number
  readonly cacheRead: number
  readonly cacheWrite: number
  readonly output: number
}

/** The price row for a model id, or undefined. */
export function claudePriceOf(model: string): ClaudePrice | undefined {
  return Object.hasOwn(CLAUDE_PRICES, model) ? CLAUDE_PRICES[model] : undefined
}

/** Each part's cost in US dollars, or null for a model outside the table. */
export function claudeStepCost(model: string, tokens: ClaudeStepTokens):
  { input: number; cacheRead: number; cacheWrite: number; output: number; total: number } | null {
  const price = claudePriceOf(model)
  if (price === undefined) return null
  const input = tokens.input * price.input / 1e6
  const cacheRead = tokens.cacheRead * price.cacheRead / 1e6
  const cacheWrite = tokens.cacheWrite * price.cacheWrite / 1e6
  const output = tokens.output * price.output / 1e6
  return { input, cacheRead, cacheWrite, output, total: input + cacheRead + cacheWrite + output }
}

/** One step's cost in US dollars, or null for a model outside the table. */
export function claudeStepUsd(model: string, tokens: ClaudeStepTokens): number | null {
  return claudeStepCost(model, tokens)?.total ?? null
}
