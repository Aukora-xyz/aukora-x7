/**
 * The edge tests' one bounded wait (a helper, not a test file: the step runs `__tests__/*.test.mjs`).
 *
 * What these tests wait for often crosses the libuv thread pool (every WebCrypto digest, sign, verify and key import of
 * the Worker, HEAD, MIRROR and the passkey check), and a busy machine (a CI runner running test files in parallel) can
 * hold one such job longer than hundreds of quick event-loop turns or a fixed number of short sleeps. So the wait is
 * bounded by ELAPSED TIME, not by a count: quick turns first, then 1 ms sleeps that leave the CPU to the pool, and past
 * the limit it FAILS LOUDLY, naming what it waited for, instead of returning as if the condition held.
 *
 * The timer functions and the clock are taken when this module loads, so a test that mocks `setTimeout` (node:test
 * mock timers) or the clock does not stop the wait from moving.
 */
const realSetImmediate = globalThis.setImmediate
const realSetTimeout = globalThis.setTimeout
const realNow = performance.now.bind(performance)

/** The default limit: generous, since it only ever elapses on a failure. */
export const WAIT_LIMIT_MS = 30000
const QUICK_TURNS = 500

/**
 * Resolves as soon as `condition()` holds. Throws an Error naming `what` (and how long it waited) once `limitMs` of
 * elapsed time has passed without it.
 * @param {() => unknown} condition
 * @param {string} what
 * @param {{ limitMs?: number }} [options]
 */
export async function waitFor(condition, what, { limitMs = WAIT_LIMIT_MS } = {}) {
  const started = realNow()
  for (let turn = 0; !condition(); turn++) {
    const waited = realNow() - started
    if (waited > limitMs) throw new Error(`waitFor: still waiting after ${String(Math.round(waited))} ms (${String(turn)} turns) for ${what}`)
    await new Promise(resolve => (turn < QUICK_TURNS ? realSetImmediate(resolve) : realSetTimeout(resolve, 1)))
  }
}
