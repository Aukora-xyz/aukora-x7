/**
 * One in-flight call shared by concurrent requests in one isolate, safe on Workers.
 *
 * Work a request starts lives and dies with that request: when its client goes away (a reload, a closed tab, an aborted
 * fetch) the runtime cancels it, and a promise it left in an isolate-level slot never settles. Every later request that
 * waited on that slot would then wait forever, on every route behind it, until the isolate is replaced.
 *
 * The rule here: NOBODY WAITS ON ANOTHER REQUEST'S CALL WITHOUT A DEADLINE OF THEIR OWN.
 *   - A caller that finds no call in flight for its key starts one and awaits it. That is its own request's work: this
 *     helper puts NO deadline on it (how long `run` may take is `run`'s business and its request's).
 *   - A caller that finds one in flight gives it `waitMs` on its own timer, up to `maxWaits` times. It is answered by the
 *     newest call for its key that settles after it arrived (the call it watched, a call that replaced that one, or an
 *     older call that one replaced): that is all sharing ever meant.
 *   - When a wait ends with no such answer: if the slot now holds a different call (somebody took over), it watches that
 *     one for its next wait. If the slot still holds the call it watched for that whole `waitMs`: after its FIRST wait it
 *     takes the slot over and starts ONE call, which later callers share; after any later wait it gives that same call
 *     its next wait (a call that replaced the one it arrived on is given time to answer the callers already waiting,
 *     instead of being replaced by each of them in turn).
 *   - A caller that has used `maxWaits` waits and still has no answer starts nothing: it throws SHARED_CALL_BUSY (status
 *     503, retryable). Nobody ever runs outside the slot (a call whose row was evicted is the one exception, see the
 *     table).
 *
 * What that bounds, and what it does not:
 *   - Waiting on calls a caller did not start: at most `maxWaits` x `waitMs` PER call() (given that its own timers run),
 *     then an answer, its own call, or SHARED_CALL_BUSY. A request that makes two shared calls can wait twice that. A
 *     waiter is woken by the call it watches or by its own timer only: an answer another call for its key produced
 *     meanwhile reaches it when its timer fires, so up to `waitMs` after that answer existed.
 *   - New calls while calls keep failing to settle: at most ONE per `waitMs` per key, however many callers wait and
 *     whatever `maxWaits` is, because a call is only ever replaced by a caller that watched that same call for a whole
 *     `waitMs` (while the key's row is in the table: see eviction below).
 *   - What the callers that arrived before a takeover get: if the call that took over settles within their remaining
 *     waits (up to `maxWaits` - 1 more), its outcome, with no further call started by any of them. A caller that arrives
 *     AFTER that takeover may itself replace the new call after its own first wait (one per `waitMs`, as above).
 *   - NOT bounded here: how long a started call runs, and how many abandoned calls are still outstanding in the runtime.
 *   - NOT promised: an answer. Only the first caller to have watched a dead call for a whole first wait replaces it; if
 *     that caller's own call is abandoned too, and the next one's, everybody else is refused SHARED_CALL_BUSY for as
 *     long as that chain lasts (bounded and retryable, never a hang).
 *   - A slow call (slower than `waitMs`) is treated like an abandoned one by a caller on its first wait: it is replaced,
 *     and if it does settle later its answer still serves the callers that were waiting when it did, unless a NEWER call
 *     for the key has settled already (below).
 *
 * Every started call gets a strictly increasing `seq` (per instance), passed to `run({ seq })`: a caller that publishes
 * results somewhere (a cache) orders them by `seq`, never by a clock. A slot is cleared only by the call that still
 * holds it, so a late finish of a replaced call can never evict a newer call. The outcome kept for waiters is ordered
 * by `seq` too: once a call for a key has settled, no older call's outcome is kept for that key, and a waiter is given
 * the kept (newest) outcome before the one of the call it watched. So no waiter is handed an answer older than one that
 * had settled before it arrived. What a waiter CAN still be handed is the late outcome (an error too) of a replaced
 * call that settles while the call that replaced it is still running: that is "the newest call for its key that settles
 * after it arrived" (newest of those that have settled, by `seq`).
 *
 * The table (per key: the call in flight, the last outcome while somebody still waits for it, and the count of those
 * waiters) is bounded by `capacity`; when full the oldest key goes, whatever it holds. Losing a row that way ends that
 * key's sharing for the callers already there: the evicted call runs on outside the table, and EACH of its waiters (when
 * its first wait ends), or a new arrival for that key, may start one call (never more calls than callers, never a hang;
 * a waiter past its first wait keeps watching the evicted call until it settles or its waits run out; such a waiter may
 * also be refused SHARED_CALL_BUSY although a call for its key settled, or be handed the outcome of the call it watched
 * although a newer one settled during its wait). An outcome is dropped when the last caller waiting for its key
 * leaves; a waiter whose own request is cancelled never leaves, so its key's row and last outcome then stay until the
 * table evicts them. Sharing is an optimisation only: every answer is the outcome of a `run` that some request executed, and `run`
 * must therefore be safe to execute more than once.
 */
export const SHARED_CALL_WAIT_MS = 2000
/** Waits per call() on calls a caller did not start: with the default `waitMs`, 5 x 2 s = 10 s before SHARED_CALL_BUSY. */
export const SHARED_CALL_MAX_WAITS = 5
export const SHARED_CALL_BUSY = 'SHARED_CALL_BUSY'

const ABANDONED = Symbol('shared call abandoned')
const give = outcome => {
  if ('error' in outcome) throw outcome.error
  return outcome.value
}

export function createSharedCalls({ waitMs = SHARED_CALL_WAIT_MS, maxWaits = SHARED_CALL_MAX_WAITS, capacity = 1024, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  if (!Number.isFinite(waitMs) || waitMs < 0) throw new TypeError('waitMs must be a non-negative number')
  if (!Number.isSafeInteger(maxWaits) || maxWaits < 1) throw new TypeError('maxWaits must be a positive integer')
  if (!Number.isSafeInteger(capacity) || capacity < 1) throw new TypeError('capacity must be a positive integer')
  // key -> { entry: the call holding the slot or null, settled: the last outcome for the key, kept only while a caller
  // waits, waiting: callers now waiting on a call they did not start (in the row, so `capacity` bounds it too),
  // newest: the highest seq that has settled for the key (for a new row: every call started before it) }
  const rows = new Map()
  let seq = 0, order = 0
  const start = (key, run) => {
    let row = rows.get(key)
    if (!row) {
      // Bounded: an abandoned call nobody asks about again would otherwise stay for the life of the isolate. Dropping the
      // oldest row only ends its sharing: its own caller still gets its answer, its waiters may start one extra call.
      if (rows.size >= capacity) rows.delete(rows.keys().next().value)
      rows.set(key, row = { entry: null, settled: null, waiting: 0, newest: seq })
    }
    const entry = { seq: ++seq, promise: null }
    const settle = outcome => {
      const settledAt = ++order
      const now = rows.get(key)
      if (!now) return
      if (now.entry === entry) now.entry = null
      // Kept for the callers still waiting for this key (one watching a call this one replaced, or was replaced by), but
      // never over the outcome of a newer call: a call older than one already settled answers only its own caller.
      const newest = entry.seq > now.newest
      if (newest) now.newest = entry.seq
      if (now.waiting === 0) { if (now.entry === null) rows.delete(key) } else if (newest) now.settled = { order: settledAt, outcome }
    }
    entry.promise = Promise.resolve().then(() => run({ seq: entry.seq })).then(
      value => { settle({ value }); return value },
      error => { settle({ error }); throw error })
    row.entry = entry
    return entry.promise
  }
  const settledWithin = promise => {
    let timer
    const mine = new Promise(resolve => { timer = setTimer(() => resolve(ABANDONED), waitMs) })
    return Promise.race([promise.then(value => ({ value }), error => ({ error })), mine]).finally(() => clearTimer(timer))
  }
  const leave = (key, row) => {
    // `row` is the one this caller joined: if it was evicted meanwhile, the key's present row is not this caller's.
    if (--row.waiting > 0 || rows.get(key) !== row) return
    row.settled = null
    if (row.entry === null) rows.delete(key)
  }
  return Object.freeze({
    /**
     * The outcome of one `run({ seq })` for `key`: this caller's own if none was in flight when it arrived, else one that
     * settled after it arrived, within its own `maxWaits` waits. Throws what that run threw, or SHARED_CALL_BUSY (503).
     */
    async call(key, run) {
      const joined = rows.get(key)
      let watched = joined?.entry ?? null
      if (watched === null) return await start(key, run)
      // Only a call that settles after this point may answer this caller.
      const arrived = order
      let takeOver = false
      joined.waiting++
      try {
        for (let waits = 1; waits <= maxWaits; waits++) {
          const outcome = await settledWithin(watched.promise)
          const row = rows.get(key)
          // The kept outcome first: it is the newest that settled since this caller arrived (the watched call's own, or
          // one of a call that replaced it and settled before it).
          if (row?.settled?.order > arrived) return give(row.settled.outcome)
          if (outcome !== ABANDONED) return give(outcome)
          const current = row?.entry ?? null
          if (current !== null && current !== watched) { watched = current; continue }
          // The watched call had a whole `waitMs` and still holds the slot (or its row was evicted). After this caller's
          // FIRST wait it replaces it; after a later wait it gives the same call its next wait and starts nothing.
          if (waits === 1) { takeOver = true; break }
        }
      } finally { leave(key, joined) }
      if (!takeOver) throw Object.assign(new Error(`The shared call did not settle within ${String(maxWaits)} waits`), { code: SHARED_CALL_BUSY, status: 503 })
      return await start(key, run)
    },
    /** Keys in the table: a call in flight (an abandoned one stays until replaced or evicted), or an outcome kept for a waiter (one whose request was cancelled keeps its row until evicted). */
    size: () => rows.size,
  })
}
