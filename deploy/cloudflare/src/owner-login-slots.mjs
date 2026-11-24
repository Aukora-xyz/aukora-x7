/**
 * THE OWNER LOGIN'S CHECKS IN FLIGHT. HEAD's login gate bounds the FAILURES it
 * has stored (five, then a 300 s lock), not the signature checks already running: 100 overlapping wrongly signed owner
 * passes from one address all passed the (shared) gate check before any of them came back wrong. This table bounds them in
 * the isolate: per subject (the address's login subject), at most as many signature checks as failures remain before the
 * lock (so never more than the budget). Every other request is answered at once with the lock's 429 shape and a short
 * wait, and costs no check.
 *
 * a slot is TWO things
 * now, kept apart.
 *   - THE LEASE: the request's admission. It ends when the request is done with it (`release`, the caller's `finally`),
 *     when the request is FENCED (its own deadline, `holdMs` after admission, passed before its check and gate call were
 *     done: the caller answers 503 and acts on nothing that arrives later), or lazily at that same deadline (a request the
 *     runtime cancelled, whose `finally` never runs).
 *   - THE CHECK: the signature operation itself, started through `check(start)`. It counts from the moment it starts until
 *     its own promise settles, whatever happened to its lease. WebCrypto cannot be cancelled, so a fenced or expired lease
 *     frees NOTHING while its check still runs.
 * A slot counts against its subject while its lease is live OR its check is running; `take` admits only below the limit.
 * THE BOUND (per isolate, per subject while its row is in the table): signature checks started and not yet settled
 * <= the limit `take` was last given (the failures left before the lock, at most GATE_LOCKOUT_DEFAULTS.maxFailures = 5),
 * however long they run and however many leases expire meanwhile. A check that never settles holds its place for the life
 * of the isolate (or until its row is evicted, below): the bound is never traded for time.
 *
 * shared-call.mjs's rules hold: no request ever waits on another's work here (a refusal is immediate), and there is no
 * isolate-level promise at all: a slot is a plain record. The check's own promise is observed (its settlement clears the
 * record's `running` flag) but nobody waits on it but the request that started it. The table is bounded (`capacity`
 * subjects). When full, the oldest row with NO running check goes (it holds only leases, whose checks have settled); only
 * if every row has a running check does the oldest row go, which can only weaken the bound for that one subject, never
 * refuse a new one. So the bound above can be broken only by `capacity` (1024) other subjects each holding a check that
 * has not settled, at once.
 * This bound is per isolate: two isolates each admit up to the budget (a durable lease would serialise every login of an
 * address through HEAD, which the shared check exists to avoid).
 * @module owner-login-slots
 */

export const OWNER_LOGIN_SLOTS = Object.freeze({ holdMs: 10000, waitMs: 1000, capacity: 1024 })

/**
 * @param {object} [options] `holdMs`: a lease's own deadline; `capacity`: subjects held at most.
 * @returns {Readonly<{ take: (subject: string, limit: number, at: number) => Readonly<{ until: number, check: (start: () => unknown) => Promise<unknown>, release: () => void }> | null, inFlight: (subject: string, at: number) => number, running: (subject: string) => number, size: () => number }>}
 */
export function createLoginSlots({ holdMs = OWNER_LOGIN_SLOTS.holdMs, capacity = OWNER_LOGIN_SLOTS.capacity } = {}) {
  const rows = new Map()
  const tidy = (subject, row) => { if (row.size === 0 && rows.get(subject) === row) rows.delete(subject) }
  const live = (subject, at) => {
    const row = rows.get(subject)
    if (row === undefined) return 0
    for (const slot of row) {
      if (slot.leased && !(slot.until > at)) slot.leased = false
      if (!slot.leased && !slot.running) row.delete(slot)
    }
    tidy(subject, row)
    return row.size
  }
  const evictOne = () => {
    for (const [subject, row] of rows) {
      if (![...row].some(slot => slot.running)) { rows.delete(subject); return }
    }
    rows.delete(rows.keys().next().value)
  }
  return Object.freeze({
    /**
     * One signature check for `subject`, if fewer than `limit` slots count at `at` (live leases and running checks): its
     * handle, or null when the subject already has `limit`, or `limit` is not a positive whole number.
     * `check(start)`: runs `start()` once (the signature check) and returns its promise; the slot counts as running until
     * that promise settles, whatever happens to the lease. `release()`: the lease ends (calling it again does nothing).
     */
    take(subject, limit, at) {
      if (!Number.isSafeInteger(limit) || limit < 1 || !Number.isFinite(at)) return null
      if (live(subject, at) >= limit) return null
      let row = rows.get(subject)
      if (row === undefined) {
        if (rows.size >= capacity) evictOne()
        row = new Set()
        rows.set(subject, row)
      }
      const slot = { until: at + holdMs, leased: true, running: false, started: false }
      row.add(slot)
      const forget = () => { if (!slot.leased && !slot.running) { row.delete(slot); tidy(subject, row) } }
      return Object.freeze({
        until: slot.until,
        check(start) {
          if (slot.started) return Promise.reject(Object.assign(new Error('OWNER_LOGIN_CHECK_STARTED'), { code: 'OWNER_LOGIN_CHECK_STARTED' }))
          slot.started = true
          slot.running = true
          let pending
          try { pending = Promise.resolve(start()) } catch (error) { pending = Promise.reject(error) }
          const settled = () => { slot.running = false; forget() }
          pending.then(settled, settled)
          return pending
        },
        release() { slot.leased = false; forget() },
      })
    },
    inFlight: (subject, at) => live(subject, at),
    running: subject => [...(rows.get(subject) ?? [])].filter(slot => slot.running).length,
    size: () => rows.size,
  })
}
