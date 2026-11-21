/** The managed voice's one duration and admission policy (the VoiceBridge, voice-bridge.mjs and voice-bridge-do.mjs).
 *
 * Every number here is a RESERVATION of possible call time, taken in full before the provider is asked for a
 * conversation. When a call ends (any end path), its reservation is trimmed to what it used, from the mint to its end
 * (voice-bridge-do.mjs endSlot). A minted call nobody ever claimed keeps its reservation (the provider may have run it
 * where the edge cannot see). These are admission ceilings for one owner, not a measurement of what the provider bills.
 * Day and month raised.
 * 2026-11-18. Eleven call starts that failed had each kept a whole call's
 * reservation and spent the day with no word spoken, so her voice refused to start. The day has no ceiling of its own
 * any more (it equals the month's), and the month is a backstop against a runaway only (200 hours).
 * 2026-11-18, later the same day (the cost of calls is now watched at the provider):
 * Her side no longer limits call time at all. The two counters stay (the status still shows what was reserved), and
 * their ceiling is more seconds than a month can hold: two calls at once for every second of a 31-day month
 * (2 x 31 x 86,400 = 5,356,800). No real call time can reach it. What a call costs is the owner's to watch at the
 * provider. One call still lasts at most `seconds` (the provider's own saved setting), and two may be live at once.
 */

export const VOICE_SESSION_LIMITS = Object.freeze({
  /** One call: the most a single managed conversation may last (the approved provider setting). */
  seconds: 1200,
  /** The shortest saved provider duration the edge accepts (the browser validates the same range). */
  minSeconds: 60,
  /** One UTC day, all calls together: no ceiling that can be reached. */
  daySeconds: 5356800,
  /** One UTC calendar month, all calls together: no ceiling that can be reached: every second of a 31-day month, twice. */
  monthSeconds: 5356800,
  /** Silence before the provider ends the call (provider-side setting; recorded here so there is one source). More than
   * three minutes with nothing said by either side ends the call there; her turn then carries on in her thread. */
  silenceSeconds: 180,
  /** Conversations live at once. It was 2 ("the owner has at most two tabs talking"). 2026-11-18: after five restarts of
   * the edge in one day the owner's orb answered that her voice was already open in another window with nothing open,
   * and the limit was lifted. A press of his orb is now refused as busy only when sixteen
   * calls are held or in flight at once, which no one owner reaches; a start that never connected lapses in a minute
   * and a call the edge lost is let go at the next start (voice-bridge-do.mjs releaseLostSlots). */
  liveConversations: 16,
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
