/**
 * The effort levels her working self may choose on
 * Claude models, lowest first, and each level's output room (`max_tokens`: thinking plus her words, one hard limit).
 *
 * These are the numbers of THE LEVEL TABLE in deploy/cloudflare/src/voice-fast.mjs (`FAST_EFFORT_LEVELS[level].maxTokens`),
 * the house's checked reference for the Claude effort request; a test pins them equal
 * (tests/node/pi-ai-claude-effort.spec.ts), so this is that table read from the browser, not a second one. The browser
 * bundle cannot import the edge module itself (it pulls the edge's budget code with it).
 * A level travels as `output_config: { effort }` on the Messages wire, exactly as the fast voice sends it.
 */
export const CLAUDE_EFFORT_ROOM = Object.freeze({
  low: 4096,
  medium: 8192,
  high: 16000,
  xhigh: 64000,
  max: 64000,
})

/** One Claude effort level. */
export type ClaudeEffort = keyof typeof CLAUDE_EFFORT_ROOM

/** The closed list of levels, lowest first. */
export const CLAUDE_EFFORTS = Object.freeze(Object.keys(CLAUDE_EFFORT_ROOM)) as readonly ClaudeEffort[]

/** Whether a value is one of the five levels (exact spelling; nothing else is ever sent). */
export const isClaudeEffort = (value: unknown): value is ClaudeEffort =>
  typeof value === 'string' && Object.hasOwn(CLAUDE_EFFORT_ROOM, value)
