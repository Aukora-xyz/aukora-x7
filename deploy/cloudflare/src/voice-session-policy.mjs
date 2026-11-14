/** The managed voice's one duration and admission policy (the VoiceBridge, voice-bridge.mjs and voice-bridge-do.mjs).
 *
 * Every number here is a RESERVATION of possible call time, taken in full before the provider is asked for a
 * conversation. When a call ends (any end path), its reservation is trimmed to what it used, from the mint to its end
 * (voice-bridge-do.mjs endSlot). A minted call nobody ever claimed keeps its reservation (the provider may have run it
 * where the edge cannot see). These are admission ceilings for one owner, not a measurement of what the provider bills.
 * Day and month raised.
 */

export const VOICE_SESSION_LIMITS = Object.freeze({
  /** One call: the most a single managed conversation may last (the approved provider setting). */
  seconds: 1200,
  /** The shortest saved provider duration the edge accepts (the browser validates the same range). */
  minSeconds: 60,
  /** One UTC day, all calls together. */
  daySeconds: 21600,
  /** One UTC calendar month, all calls together. */
  monthSeconds: 180000,
  /** Silence before the provider ends the call (provider-side setting; recorded here so there is one source). More than
   * three minutes with nothing said by either side ends the call there; her turn then carries on in her thread. */
  silenceSeconds: 180,
  /** Conversations live at once (the owner has at most two tabs talking). */
  liveConversations: 2,
})

/** Time a minted conversation has to be claimed by its tab (`hello`) before its live slot lapses. */
export const VOICE_CONNECT_WINDOW_MS = 60000
/** Time a reservation may wait for the provider's mint before its live slot lapses. */
export const VOICE_MINT_WINDOW_MS = 30000
/** Grace after the mint for the browser to connect: a tab binding never outlives mint + duration + this. */
export const VOICE_CONNECT_GRACE_MS = 30000

/** The UTC day and month a reservation at `at` (ms) counts against. */
export function admissionPeriods(at) {
  const iso = new Date(at).toISOString()
  return { day: iso.slice(0, 10), month: iso.slice(0, 7) }
}

/** An integer number of seconds the edge may reserve and the browser may time (60..1200), or null. */
export function validDurationSeconds(value) {
  return Number.isSafeInteger(value) && value >= VOICE_SESSION_LIMITS.minSeconds && value <= VOICE_SESSION_LIMITS.seconds ? value : null
}
