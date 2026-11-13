/**
 * One writer for her whole world. The lease lives in MIRROR beside the global revision it guards,
 * so the lease check and the home write share ONE storage transaction.
 *
 * A refusal of a WRITE is only ever 423 (a quiet retry) or 410 (take a new lease): an old open
 * tab locks itself for good on 400/403/404/409/413/507 or on any body with a `conflictCode`
 * field, so no answer of this module ever carries that field. The one named exception is a
 * browser whose slot was retired (mirror-slot-tombstone.mjs): it is answered 409
 * CLIENT_SLOT_RETIRED, again with no `conflictCode`, so an old tab stops sending and keeps its work.
 */
import { SLOT_TOMBSTONE, SLOT_TOMBSTONE_LIMITS, TOMBSTONE_UNAVAILABLE, readTombstone, retiredReply } from './mirror-slot-tombstone.mjs'
import { clientWroteAt } from './world-home.mjs'
import { HOLDER_ACTIONS, HOLDER_INPUT_KEYS, HOLDER_MARK, WORLD_HOLDER, holderAction, holderGate, holderInputValid, holderStatus, noteLeaseRow } from './world-holder.mjs' // HOME hook: her body's record

const LEASE = 'world:v1:lease'
const LEASE_LOG = 'world:v1:lease-log'
const SEEN = 'world:v1:seen'
// The last label each browser held a lease under (`{clientId: {label, at}}`, 256 at most): a card can name a browser that no longer holds it.
const LABELS = 'world:v1:labels'
const HOME_PENDING = 'world:v1:home-pending'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const TAB = /^[A-Za-z0-9_-]{1,64}$/
const LEASE_ID = /^[0-9a-f]{32}$/
// Control, format, line and paragraph separators are not printable.
const UNPRINTABLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u
const ACTIONS = new Set(['status', 'acquire', 'renew', 'ask', 'release', 'take', 'resurrect', 'forget', ...HOLDER_ACTIONS]) // HOME hook: seal, reserve, move
// HOME hook: the requests that act as her body; with a holder row each must carry her installation key's proof.
const GATED = new Set(['acquire', 'renew', 'take', 'release'])
const INPUT_KEYS = new Set(['action', 'clientId', 'tabId', 'label', 'leaseId', 'retiredAt', ...HOLDER_INPUT_KEYS]) // HOME hook: expect, checkpoint, log, accept, copy, key, proof, cut, until

/**
 * Lease timing: a lease lives 90 s past its last renew; a healthy browser renews every 20 s.
 * A lease that has run out is never revived, by a renew or by a write. A committed write (a thread
 * commit, an import step, a leased home save) extends a LIVE lease to at most `writeHoldMs` (30 minutes) after the lease
 * was acquired, so a long import cannot hold her world for ever; past that only the holder's explicit renew (while the
 * lease is still live) keeps it.
 * `checkLease` stages the extension when it passes a write; MIRROR's `/_mirror/thread` keeps it only when
 * the write committed bytes (APPLIED, IMPORTED, RETRACTED, KEPT). A thread write that is then refused, or answered 200
 * with nothing written, rolls back with its own answer, so the lease row stays exactly as it was. One exception, off by
 * default: under WRITER_LEASE=enforce a home save that passes the lease and is then refused as a conflict still commits
 * the extension (its conflict record is kept in the same transaction).
 * The rescue page's Join renews explicitly while it works (rescue-kit.mjs) and itself stops one press at `writeHoldMs`.
 */
export const WORLD_LEASE = Object.freeze({ ttlMs: 90000, renewMs: 20000, writeHoldMs: 1800000 })
/** Fixed bounds for the lease rows. */
export const WORLD_LEASE_LIMITS = Object.freeze({ label: 80, log: 16, seen: 256, seenEveryMs: 60000, prior: 8, labels: 256 })

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const time = value => Number.isSafeInteger(value) && value >= 0
const answer = (status, body) => ({ status, body })
const refusal = (status, code, extra = {}) => answer(status, { ok: false, code, ...extra })

const validLabel = label => typeof label === 'string' && label.isWellFormed() && [...label].length <= WORLD_LEASE_LIMITS.label && !UNPRINTABLE.test(label)
const validHolder = holder => object(holder) && UUID.test(holder.clientId) && TAB.test(holder.tabId) && validLabel(holder.label)
const validAsked = asked => asked === null || (object(asked) && validLabel(asked.label) && time(asked.at))
// The same browser's earlier pages: their lease references answer 410, never "another browser".
const validPrior = prior => prior === undefined || (Array.isArray(prior) && prior.length <= WORLD_LEASE_LIMITS.prior
  && prior.every(ref => object(ref) && typeof ref.leaseId === 'string' && LEASE_ID.test(ref.leaseId) && Number.isSafeInteger(ref.generation) && ref.generation > 0))

// A free row (never held, or released) keeps its generation so the generation only ever grows.
const validRow = row => object(row) && Number.isSafeInteger(row.generation) && row.generation >= 0 && time(row.seenAt) && time(row.expiresAt) && validAsked(row.asked) && validPrior(row.prior)
  && (row.holder === null
    ? row.leaseId === null && row.acquiredAt === null
    : validHolder(row.holder) && typeof row.leaseId === 'string' && LEASE_ID.test(row.leaseId) && time(row.acquiredAt))

const live = (row, now) => Boolean(row?.holder) && row.expiresAt > now
// The edge clock, read when it is needed (after a row was read), never captured before a wait.
// `now` is a clock function or, in a test, a fixed number.
const clockOf = now => (typeof now === 'function' ? now : () => now)
/** The expiry a committed write gives a LIVE lease: `now + ttlMs`, never past `acquiredAt + writeHoldMs`, never earlier than it was. */
const writeExpiry = (row, now) => Math.max(row.expiresAt, Math.min(now + WORLD_LEASE.ttlMs, row.acquiredAt + WORLD_LEASE.writeHoldMs))
const publicHolder = row => ({ label: row.holder.label, since: row.acquiredAt, seenAt: row.seenAt })
const grant = row => ({ ok: true, lease: { leaseId: row.leaseId, generation: row.generation, expiresAt: row.expiresAt } })
const sameLease = (row, ref) => Boolean(row?.holder) && row.generation === ref.generation && row.leaseId === ref.leaseId
const priorLease = (row, ref) => Boolean(row?.holder) && Array.isArray(row.prior) && row.prior.some(old => old.generation === ref.generation && old.leaseId === ref.leaseId)
const validRef = ref => object(ref) && typeof ref.leaseId === 'string' && LEASE_ID.test(ref.leaseId) && Number.isSafeInteger(ref.generation) && ref.generation > 0

function newLeaseId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

async function readLease(tx) {
  const row = await tx.get(LEASE)
  if (row === undefined) return { row: null, corrupt: false }
  return validRow(row) ? { row, corrupt: false } : { row: null, corrupt: true, stored: row } // HOLDER hook: `stored`
}

// ── job 3: the marker is a cache; the holder row is the authority. ─────────────────────────────
/** A lease row ended (its generation kept, as `release` writes it) and marked: what a row an older build wrote becomes. */
const endedAndMarked = (row, at) => ({ leaseId: null, generation: row?.generation ?? 0, holder: null, acquiredAt: null, seenAt: at, expiresAt: at, asked: null, [HOLDER_MARK]: true })

// ── job 4 (R1, R2): the START-UP STATE, and what an unclaimed world pays for it. ─────────────────
// THE BUDGET: a world never claimed pays exactly ONE extra read per MIRROR start (the holder row, bounded by
// `HOLDER_START_LIMITS.readMs`) and nothing per request: lease actions, thread appends, the final lease check, the thread
// index and slot retirement decide from the start-up state, never from a holder lookup of their own.
// Each MIRROR object's storage has one record `{held}`: `true` (a holder row was read, or written here), `false` (none was
// there) or `null` (UNKNOWN: the read failed or ran past its deadline). Every transaction opened on that storage carries the
// record (holderStartUp wraps `storage.transaction`), so the decisions inside a transaction read it with no storage
// operation. While it is unknown, the next lease, thread-write or index request asks the holder row again, inside its
// own transaction and under the same deadline; until one such read succeeds those requests are refused 503
// HOLDER_STATE_UNAVAILABLE (retryable), never served on a guess. While it is `true`, a lease row WITHOUT the marker (a
// build that knew no holder wrote it, after a rollback) is ended and marked by the first request that reads it, as the
// start-up would have done: any lease it names was granted without her key.
// A storage this module never started (a unit test calling leaseAction directly) has no record: the marker alone decides,
// as before job 3.
export const HOLDER_START_LIMITS = Object.freeze({ readMs: 1000 })
const START_FAILED = Symbol('start failed')
const startStates = new WeakMap()
const txStates = new WeakMap()
// job 4 review (SHOULD): set when a started storage's `transaction` could not be wrapped (the assignment threw or
// did not take). From then on a transaction that carries no record is NOT taken as "not held": each deciding transaction
// reads the holder row itself (one bounded read), so a failed wrap costs reads, never her body.
let unwrapped = false

/** `work()` raced with `deadline`; a rejection, a throw or the deadline is START_FAILED. Never rejects. */
function within(work, deadline) {
  let running
  try { running = Promise.resolve(work()) } catch { return Promise.resolve(START_FAILED) }
  return Promise.race([running.then(value => value, () => START_FAILED), deadline])
}
function deadlineOf(ms) {
  let timer
  const promise = new Promise(resolve => { timer = setTimeout(() => resolve(START_FAILED), ms) })
  return { promise, stop: () => clearTimeout(timer) }
}

/** Every transaction opened on `storage` carries its record (a storage whose `transaction` cannot be wrapped keeps none). */
function recordOf(storage) {
  if (storage === null || typeof storage !== 'object') return undefined
  let record = startStates.get(storage)
  if (record) return record
  record = { held: null }
  startStates.set(storage, record)
  const open = storage.transaction
  if (typeof open === 'function') {
    const holderTransaction = function holderTransaction(fn, ...rest) {
      return open.call(storage, typeof fn === 'function' ? tx => { if (tx !== null && typeof tx === 'object') txStates.set(tx, record); return fn(tx) } : fn, ...rest)
    }
    try { storage.transaction = holderTransaction } catch { /* checked below */ }
    // Fail safe, never silent: a wrap that threw or did not take leaves its transactions without a record (see `unwrapped`).
    if (storage.transaction !== holderTransaction) unwrapped = true
  }
  return record
}

/** Inside a transaction a deciding path was handed: its record's answer (heldNow); without one, `false` unless a wrap failed. */
function txHeld(tx) {
  const record = recordOfTx(tx)
  if (record) return heldNow(tx, record)
  return unwrapped ? heldNow(tx, { held: null }) : Promise.resolve(false)
}

/**
 * Inside a transaction: is her world held? `true`/`false` from the record; `null` while it is unknown and this try (one
 * bounded read of the holder row, in this transaction) also failed. No record: `false` (the marker alone decides).
 */
async function heldNow(tx, record) {
  if (!record || record.held !== null) return record?.held ?? false
  const deadline = deadlineOf(HOLDER_START_LIMITS.readMs)
  try {
    const found = await within(() => tx.get(WORLD_HOLDER), deadline.promise)
    if (found === START_FAILED) return null
    record.held = found !== undefined
    return record.held
  } finally { deadline.stop() }
}

/** Mark the lease row as the start-up does: an unmarked readable (or absent) row ends; a malformed object only gains the marker. */
async function markLeaseRow(tx, at) {
  const row = await tx.get(LEASE)
  if (object(row) && row[HOLDER_MARK] === true) return
  if (row === undefined || validRow(row)) await tx.put(LEASE, endedAndMarked(row, at))
  else if (object(row)) await tx.put(LEASE, { ...row, [HOLDER_MARK]: true })
}

/**
 * MIRROR's object start (mirror-do.mjs, one marked hook), before it serves any request: ONE read of the holder row, under
 * a 1 s deadline. With none: nothing more (one `get`, no transaction, no write); the record says `false`. With one: the
 * record says `true`, and in one transaction (same deadline) a lease row that lacks the marker is ended and marked (a
 * malformed row only gains the marker; its own reads still answer 503); if that write fails, the first lease, thread or
 * index request does it. A read that fails or runs late leaves the record UNKNOWN (see the budget above). It never
 * throws and never rejects (MIRROR's request queue waits on it), and it settles within the deadline.
 * @param {object} storage The object's storage.
 * @returns {Promise<void>}
 */
export function holderStartUp(storage) {
  const record = recordOf(storage)
  if (!record) return Promise.resolve()
  record.held = null
  const deadline = deadlineOf(HOLDER_START_LIMITS.readMs)
  return (async () => {
    const found = await within(() => storage.get(WORLD_HOLDER), deadline.promise)
    if (found === START_FAILED) return
    record.held = found !== undefined
    if (record.held) await within(() => storage.transaction(tx => markLeaseRow(tx, Date.now())), deadline.promise)
  })().catch(() => {}).finally(deadline.stop)
}

/** The record of the transaction a function was handed (undefined: none). */
const recordOfTx = tx => (tx !== null && typeof tx === 'object' ? txStates.get(tx) : undefined)
/** R2: her world's start-up state could not be read, and could not be read again now: a retryable refusal. */
const HOLDER_UNKNOWN = Object.freeze({ ok: false, code: 'HOLDER_STATE_UNAVAILABLE', status: 503 })
/** The thread index's refusal while the state is unknown: MIRROR's thread route answers a `threadRollback` with its body. */
const holderUnknownRollback = () => Object.assign(new Error('HOLDER_STATE_UNAVAILABLE'), { threadRollback: { status: 503, body: { ok: false, code: 'HOLDER_STATE_UNAVAILABLE' } } })

/** Note when the edge last saw a client: at most once a minute per client, 256 clients at most. */
async function noteSeen(tx, clientId, now) {
  const stored = await tx.get(SEEN)
  const seen = object(stored) ? { ...stored } : {}
  if (time(seen[clientId]) && now - seen[clientId] < WORLD_LEASE_LIMITS.seenEveryMs && now >= seen[clientId]) return
  seen[clientId] = now
  const kept = Object.entries(seen)
    .filter(([id, at]) => UUID.test(id) && time(at))
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, WORLD_LEASE_LIMITS.seen)
  await tx.put(SEEN, Object.fromEntries(kept))
}

/** Remember the label a browser holds the lease under; written only when it changes. */
async function noteLabel(tx, holder, now) {
  const stored = await tx.get(LABELS)
  const labels = object(stored) ? { ...stored } : {}
  if (object(labels[holder.clientId]) && labels[holder.clientId].label === holder.label) return
  labels[holder.clientId] = { label: holder.label, at: now }
  const kept = Object.entries(labels)
    .filter(([id, entry]) => UUID.test(id) && object(entry) && validLabel(entry.label) && time(entry.at))
    .sort((a, b) => b[1].at - a[1].at || (a[0] < b[0] ? -1 : 1))
    .slice(0, WORLD_LEASE_LIMITS.labels)
  await tx.put(LABELS, Object.fromEntries(kept))
}

/** The last label this browser held the lease under, or null. */
async function lastLabel(tx, clientId, row) {
  if (row?.holder?.clientId === clientId) return row.holder.label
  const labels = await tx.get(LABELS)
  const entry = object(labels) ? labels[clientId] : undefined
  return object(entry) && validLabel(entry.label) ? entry.label : null
}

function validInput(input) {
  if (!object(input) || Object.keys(input).some(key => !INPUT_KEYS.has(key))) return false
  if (!ACTIONS.has(input.action) || typeof input.clientId !== 'string' || !UUID.test(input.clientId) || typeof input.tabId !== 'string' || !TAB.test(input.tabId) || !validLabel(input.label)) return false
  if (input.leaseId !== undefined && (typeof input.leaseId !== 'string' || !LEASE_ID.test(input.leaseId))) return false
  if (!holderInputValid(input)) return false // HOME hook: the new keys' shapes (world-holder.mjs); none on any other action
  // `forget` names the retired browser (clientId) and the exact retiredAt the owner approved; nothing else carries retiredAt.
  if ((input.action === 'forget') !== (input.retiredAt !== undefined) || (input.retiredAt !== undefined && !time(input.retiredAt))) return false
  return !['renew', 'release'].includes(input.action) || input.leaseId !== undefined
}

async function homeGuard(tx, input, homeFreeze, row) {
  if (homeFreeze !== 'enforce') return null
  const pending = await tx.get(HOME_PENDING)
  if (pending === undefined) return null
  if (object(pending) && pending.clientId === input.clientId) return null
  // For the wave 4 card: the browser that holds her newer home, by the label it last held the lease under, and when it last wrote.
  const pendingClient = object(pending) && typeof pending.clientId === 'string' && UUID.test(pending.clientId) ? pending.clientId : null
  return refusal(423, 'HOME_PENDING', {
    rescue: object(pending) ? pending.rescue ?? null : null, since: object(pending) ? pending.since ?? null : null,
    label: pendingClient ? await lastLabel(tx, pendingClient, row) : null,
    lastWroteAt: pendingClient ? await clientWroteAt(tx, pendingClient) : null,
  })
}

/** A browser whose slot was retired comes back as a READER: its old sequence and base stay recorded for the reconcile step. */
async function resurrect(tx, slot, now) {
  if (!slot) return answer(200, { ok: true, resurrected: false, retired: false })
  const next = slot.state === 'reader' ? slot : { ...slot, state: 'reader', resurrectedAt: now }
  if (next !== slot) await tx.put(SLOT_TOMBSTONE + slot.clientId, next)
  const shown = retiredReply(next, 'lease')
  // Its queued saves are neither applied nor discarded here: they stay in that browser for the catch-up (plan 3.4, wave 5).
  return answer(200, {
    ok: true, resurrected: true, reader: true, state: shown.state, retiredAt: shown.retiredAt, retiredOn: shown.retiredOn,
    slot: shown.slot, wayBack: shown.wayBack, message: shown.message, unsent: { applied: false, keptIn: 'this browser', copyAt: '/rescue' },
  })
}

/** Forgetting a browser for good is the owner's act: his passkey over this exact clientId and retiredAt, and the grace has passed. */
async function forget(tx, input, now, ownerApproved) {
  if (ownerApproved !== true) return refusal(403, 'CLASS3_WEBAUTHN_REQUIRED')
  const slot = await readTombstone(tx, input.clientId)
  if (!slot) return refusal(404, 'SLOT_TOMBSTONE_NOT_FOUND')
  if (slot.corrupt) return refusal(503, TOMBSTONE_UNAVAILABLE.code)
  if (slot.retiredAt !== input.retiredAt) return refusal(409, 'SLOT_TOMBSTONE_CHANGED', { retiredAt: slot.retiredAt })
  if (now - slot.retiredAt < SLOT_TOMBSTONE_LIMITS.graceMs) return refusal(423, 'SLOT_TOMBSTONE_GRACE', { forgettableAt: slot.retiredAt + SLOT_TOMBSTONE_LIMITS.graceMs })
  await tx.delete(SLOT_TOMBSTONE + input.clientId)
  return answer(200, { ok: true, forgotten: true, clientId: input.clientId, retiredAt: slot.retiredAt })
}

/**
 * Answer one lease request from a browser of the owner's session, in ONE transaction.
 * Returns `{ status, body }`; a refusal is an answer, never a thrown status. Storage errors
 * propagate so the transaction rolls back.
 * @param {object} storage Durable Object storage with `transaction`.
 * @param {object} input `{ action, clientId, tabId, label, leaseId?, retiredAt? }`. For `forget`,
 *   clientId names the retired browser to forget and retiredAt is required.
 * @param {{ now: number|(() => number), ownerApproved?: boolean, homeFreeze?: string }} options `now`: the edge clock (read
 *   after the lease row in MIRROR); `ownerApproved` is
 *   true only after the passkey approved this exact request (`take`, `forget`); `homeFreeze` is from
 *   `homeFreezeMode`.
 * @returns {Promise<{status: number, body: object}>}
 */
export async function leaseAction(storage, input, { now: clock, ownerApproved = false, homeFreeze } = {}) {
  const readClock = clockOf(clock)
  if (!validInput(input) || !time(readClock())) return refusal(400, 'LEASE_REQUEST_INVALID')
  const started = startStates.get(storage) // HOLDER hook: this object's start-up state (undefined: never started)
  return storage.transaction(async tx => {
    if (input.action === 'forget') return forget(tx, input, readClock(), ownerApproved)
    if (HOLDER_ACTIONS.has(input.action)) {
      const out = await holderAction(tx, input, { now: readClock, ownerApproved, lease: { key: LEASE, read: () => readLease(tx) } }) // HOME hook
      // HOLDER hook: an object that wrote a holder row (reserve, move) knows from then on that the world is held.
      if (out.status === 200 && input.action !== 'seal') { const record = recordOf(storage); if (record) record.held = true } // HOLDER hook
      return out
    }
    // A retired browser is answered by name before anything else; as a reader it may still ask for the status.
    const slot = await readTombstone(tx, input.clientId)
    if (slot?.corrupt) return refusal(503, TOMBSTONE_UNAVAILABLE.code)
    if (input.action === 'resurrect') return resurrect(tx, slot, readClock())
    if (slot && !(slot.state === 'reader' && input.action === 'status')) {
      const { status, ...body } = retiredReply(slot, 'lease')
      return answer(status, body)
    }
    const read = await readLease(tx)
    if (read.corrupt) return refusal(503, 'LEASE_STATE_UNAVAILABLE')
    let row = read.row // HOLDER hook: replaced by the repair below
    // HOLDER hook (R1a + R2): held = the row's marker, or the start-up state (no storage operation). While that
    // HOLDER hook: state is unknown the holder row is read again here, bounded; still unreadable: 503, retry.
    const held = row?.[HOLDER_MARK] ? true : await heldNow(tx, started) // HOLDER hook
    if (held === null) return refusal(503, 'HOLDER_STATE_UNAVAILABLE') // HOLDER hook
    // Judged on the clock read AFTER the row, never on one captured before a wait.
    const now = readClock()
    // HOLDER hook (MUST 1 scope; job 4): a held world whose lease row lacks the marker (the start-up's
    // HOLDER hook: write failed, or could not read) is marked on its first lease request, as the start-up would: the lease
    // HOLDER hook: an older build granted ends, and the paths that read the stored marker see it again.
    if (held && !row?.[HOLDER_MARK]) { // HOLDER hook
      row = endedAndMarked(row, now) // HOLDER hook
      await tx.put(LEASE, row) // HOLDER hook
    } // HOLDER hook
    // The same browser (clientId) is never "another browser" to itself: a refreshed page, a new tab of it.
    const ownClient = live(row, now) && row.holder.clientId === input.clientId
    const mine = ownClient && row.holder.tabId === input.tabId
    const holder = { clientId: input.clientId, tabId: input.tabId, label: input.label }
    // HOLDER hook: held = the row's marker, or this object's start-up state says so (holderStartUp).
    const marked = held // HOLDER hook
    const keepMark = next => (marked && next[HOLDER_MARK] !== true ? { ...next, [HOLDER_MARK]: true } : next) // HOLDER hook: written back on the next write
    const fresh = () => ({ leaseId: newLeaseId(), generation: (row?.generation ?? 0) + 1, holder, acquiredAt: now, seenAt: now, expiresAt: now + WORLD_LEASE.ttlMs, asked: null,
      ...(marked ? { [HOLDER_MARK]: true } : {}) }) // HOME hook: the marker is never dropped (`marked`)
    // HOME hook: with the marker, the holder row decides who may act (4); without it nothing more is read.
    // HOLDER hook (MUST 2c, MUST 4): a take the passkey has not approved (the Worker's preflight) checks her proof's ts
    // HOLDER hook: but does not use it up; the approved take that follows does.
    const gate = marked && GATED.has(input.action) ? await holderGate(tx, input, now, { advance: input.action !== 'take' || ownerApproved === true }) : null // HOME hook (`marked`, advance)
    if (gate?.refusal) return gate.refusal // HOME hook

    if (input.action === 'status') {
      const base = !row?.holder ? { ok: true, lease: null } : { ok: true, lease: { ...publicHolder(row), live: live(row, now), asked: row.asked } } // HOME hook: today's answer
      return answer(200, await holderStatus(tx, input, base, { marked, now })) // HOME hook: unchanged, no read, with no marker and no checkpoint key
    }
    if (input.action === 'acquire' || input.action === 'take') {
      // HOME hook: her proven body is the one allowed browser; the pending-home guard judges only with no body.
      const guarded = gate?.holder ? null : await homeGuard(tx, input, homeFreeze, row) // HOME hook
      if (guarded) return guarded
    }
    if (input.action === 'acquire') {
      if (mine) {
        const next = keepMark({ ...row, seenAt: now, expiresAt: now + WORLD_LEASE.ttlMs }) // HOLDER hook: keepMark
        await tx.put(LEASE, next)
        await noteSeen(tx, next.holder.clientId, now)
        return answer(200, grant(next))
      }
      if (ownClient) {
        // A new page of the live holder's own browser: a new lease, generation + 1. The old page's reference now answers 410.
        const prior = [...(row.prior ?? []), { leaseId: row.leaseId, generation: row.generation }].slice(-WORLD_LEASE_LIMITS.prior)
        const next = { ...fresh(), prior }
        await tx.put(LEASE, next)
        await noteSeen(tx, next.holder.clientId, now)
        await noteLabel(tx, holder, now)
        return answer(200, grant(next))
      }
      // HOME hook: a live lease of another browser never refuses her proven body (only she can hold one anyway).
      if (live(row, now) && !gate?.holder) return refusal(423, 'WRITER_ELSEWHERE', { holder: publicHolder(row) }) // HOME hook: `&& !gate?.holder`
      const next = fresh()
      await tx.put(LEASE, next)
      await noteSeen(tx, next.holder.clientId, now)
      await noteLabel(tx, holder, now)
      return answer(200, grant(next))
    }
    if (input.action === 'renew') {
      // Only a LIVE lease is renewed. One that ran out is gone (410): the page acquires again,
      // and gets a fresh lease when nobody else took it meanwhile.
      if (!row?.holder || row.leaseId !== input.leaseId || !live(row, now)) return refusal(410, 'WRITER_GONE')
      const next = keepMark({ ...row, seenAt: now, expiresAt: now + WORLD_LEASE.ttlMs }) // HOLDER hook: keepMark
      await tx.put(LEASE, next)
      await noteSeen(tx, next.holder.clientId, now)
      return answer(200, { ...grant(next), asked: next.asked })
    }
    if (input.action === 'ask') {
      if (!live(row, now)) return answer(200, { ok: true, free: true })
      if (ownClient) return answer(200, { ok: true, asked: false })
      await tx.put(LEASE, keepMark({ ...row, asked: { label: input.label, at: now } })) // HOLDER hook: keepMark
      return answer(202, { ok: true, asked: true, holder: publicHolder(row) })
    }
    if (input.action === 'release') {
      if (!row?.holder || row.leaseId !== input.leaseId || row.holder.clientId !== input.clientId) return answer(200, { ok: true, released: false })
      await tx.put(LEASE, { leaseId: null, generation: row.generation, holder: null, acquiredAt: null, seenAt: now, expiresAt: now, asked: null,
        ...(marked ? { [HOLDER_MARK]: true } : {}) }) // HOME hook: the marker is never dropped (`marked`)
      return answer(200, { ok: true, released: true })
    }
    // take: a forced move of the writer, only with the owner's passkey approval of this exact request.
    // HOLDER hook (job 4 review, MUST 1): `bodyProven` (the Worker's word alone, removed before any answer leaves it): her
    // HOLDER hook: body's proof verified with an unused ts, so the Worker may resolve a lost answer of this take once.
    if (ownerApproved !== true) return refusal(403, 'CLASS3_WEBAUTHN_REQUIRED', gate?.holder === true ? { bodyProven: true } : {}) // HOLDER hook
    const next = fresh()
    const stored = await tx.get(LEASE_LOG)
    const log = Array.isArray(stored) ? stored : []
    await tx.put(LEASE_LOG, [...log, { at: now, from: row?.holder ? { ...row.holder } : null, to: { ...holder }, generation: next.generation }].slice(-WORLD_LEASE_LIMITS.log))
    await tx.put(LEASE, next)
    await noteSeen(tx, next.holder.clientId, now)
    await noteLabel(tx, holder, now)
    return answer(200, grant(next))
  })
}

/**
 * Judge one write against the lease inside the caller's OPEN transaction; it never opens one.
 * It decides from the EDGE's lease row read in that transaction, never from anything the writer
 * claims: a lease id with another client's id, an old lease, or any time the writer sends.
 * A refusal is `{ ok:false, code, status }` with status 423 or 410, or the named 409
 * CLIENT_SLOT_RETIRED for a browser whose slot was retired (503 if that row is unreadable).
 * @param {object} tx The caller's open transaction.
 * @param {{leaseId: string, generation: number}|null} ref The writer's lease reference, if any.
 * @param {number|(() => number)} clock The edge clock (a function in MIRROR, read after the lease row; a number in a test).
 * @param {{ mode?: string, clientId?: string|null, slotChecked?: boolean }} options `mode` from `leaseMode`; `clientId` the
 *   writer's id when known (a home save's `batch.clientId`), else null; `slotChecked` true when the caller already read
 *   this writer's tombstone in this transaction (it is not read twice).
 * @returns {Promise<object>}
 */
export async function checkLease(tx, ref, clock, { mode, clientId = null, slotChecked = false } = {}) {
  const writer = typeof clientId === 'string' && UUID.test(clientId) ? clientId : null
  // A caller that has just read this writer's tombstone in the same transaction (publishMirror) says so: read once.
  const slot = slotChecked ? null : await readTombstone(tx, writer)
  if (slot?.corrupt) return { ...TOMBSTONE_UNAVAILABLE }
  if (slot) return retiredReply(slot, 'delta')
  const { row: stored, corrupt } = await readLease(tx)
  if (corrupt) return { ok: false, code: 'WRITER_ELSEWHERE', status: 423 }
  // HOLDER hook: a write is judged on the start-up state too. Unknown (and unreadable again now): 503, retry.
  // HOLDER hook: Held, with a lease row an older build wrote without the marker: that lease ends here (as the start-up
  // HOLDER hook: would have ended it) before it is judged, so the write it names is refused 410 and nothing it sends lands.
  let row = stored // HOLDER hook
  if (!row?.[HOLDER_MARK]) { // HOLDER hook
    const held = await txHeld(tx) // HOLDER hook: no storage operation unless the state is unknown
    if (held === null) return { ...HOLDER_UNKNOWN } // HOLDER hook
    if (held) { row = endedAndMarked(row, clockOf(clock)()); await tx.put(LEASE, row) } // HOLDER hook
  } // HOLDER hook
  // The clock is read HERE, after the lease row was read: a read held past the expiry is judged
  // at the expiry it reached, never at the time the request arrived.
  const now = clockOf(clock)()
  if (validRef(ref)) {
    const matches = sameLease(row, ref)
    if (matches && (writer === null || writer === row.holder.clientId)) {
      // A lease that ran out is never revived by a write: 410, nothing written, nothing renewed.
      if (!live(row, now)) return { ok: false, code: 'WRITER_GONE', status: 410 }
      // A write extends a LIVE lease, never past acquiredAt + writeHoldMs (WORLD_LEASE).
      const expiresAt = writeExpiry(row, now)
      await tx.put(LEASE, { ...row, seenAt: now, expiresAt })
      await noteSeen(tx, row.holder.clientId, now)
      // `heldUntil` is the expiry the lease had BEFORE this write touched it. The extension above is only
      // staged: a committing caller keeps it only when `heldUntil` is still ahead of its last clock read (leaseHeldAt).
      return { ok: true, clientId: row.holder.clientId, leased: true, heldUntil: row.expiresAt }
    }
    // An earlier page of the holder's own browser (it acquired again from a new page): 410, take a new lease.
    if (priorLease(row, ref) && (writer === null || writer === row.holder.clientId)) return { ok: false, code: 'WRITER_GONE', status: 410 }
    // The lease moved to another browser (expired and taken, or taken with his approval), or this is
    // another browser's lease id: refuse with the holder the edge has NOW. Nothing is written.
    if (row?.holder && row.holder.clientId !== writer && (live(row, now) || matches)) return { ok: false, code: 'WRITER_ELSEWHERE', status: 423, holder: publicHolder(row) }
    return { ok: false, code: 'WRITER_GONE', status: 410 }
  }
  if (mode === 'enforce') return { ok: false, code: 'WRITER_REQUIRED', status: 423 }
  // observe: a write with no reference never renews and never notes a client as seen.
  if (!live(row, now) || (writer !== null && writer === row.holder.clientId)) return { ok: true, clientId: writer, leased: false }
  return { ok: false, code: 'WRITER_ELSEWHERE', status: 423, holder: publicHolder(row) }
}

/** `enforce` only when the deployment says so; otherwise writes are judged in `observe` mode. */
export const leaseMode = env => (env?.WRITER_LEASE === 'enforce' ? 'enforce' : 'observe')
/** `enforce` only when the deployment says so; otherwise the pending home rescue is only recorded. */
export const homeFreezeMode = env => (env?.HOME_FREEZE === 'enforce' ? 'enforce' : 'record')

/** The lease as the thread index shows it: no leaseId, ever. */
export async function leaseSummary(tx, now) {
  const read = await readLease(tx)
  const { corrupt, stored } = read
  let row = read.row // HOLDER hook: replaced by the repair below
  const markedAsStored = corrupt ? object(stored) && stored[HOLDER_MARK] === true : Boolean(row?.[HOLDER_MARK]) // HOLDER hook
  // HOLDER hook: the index's holder line follows the start-up state, not only the stored marker: held, the
  // HOLDER hook: holder row is read (and an unmarked readable row ends, as at start); unknown and unreadable again: the
  // HOLDER hook: whole index request is 503 HOLDER_STATE_UNAVAILABLE (retry), never an answer that hides her body.
  const held = markedAsStored ? true : await txHeld(tx) // HOLDER hook: no storage operation unless unknown
  if (held === null) throw holderUnknownRollback() // HOLDER hook
  if (held && !markedAsStored && !corrupt) { row = endedAndMarked(row, now); await tx.put(LEASE, row) } // HOLDER hook
  noteLeaseRow(tx, held ? { [HOLDER_MARK]: true } : corrupt ? stored : row) // HOME hook: the index reads the holder row only when held (SHOULD 2: also a malformed row; job 4: the start-up state)
  if (corrupt) return { unavailable: true }
  if (!row?.holder) return null
  return { ...publicHolder(row), live: live(row, now), asked: row.asked }
}

/**
 * The lease holder's client id (null when free), or `{ corrupt: true }`: slot retirement spares the holder. `marked`: her
 * world has a holder row, so retirement reads it (mirror-client-slots.mjs). job 4 (R1c): held = the marker or the
 * start-up state (no holder lookup: an unclaimed world's retirement reads nothing more than main's); while that state is
 * unknown and unreadable again: `{ corrupt: true }` (nothing is retired).
 */
export async function leaseHolderClientId(tx) {
  const { row, corrupt } = await readLease(tx)
  if (corrupt) return { corrupt: true }
  const held = row?.[HOLDER_MARK] ? true : await txHeld(tx) // HOLDER hook: the start-up state decides
  if (held === null) return { corrupt: true } // HOLDER hook
  return { clientId: row?.holder?.clientId ?? null, ...(held ? { marked: true } : {}) } // HOME hook: `marked`
}

/** Every client the edge saw under a lease, `{ clientId: time }` (bounded at 256). */
export async function seenTimes(tx) {
  const seen = await tx.get(SEEN)
  return object(seen) ? Object.fromEntries(Object.entries(seen).filter(([id, at]) => UUID.test(id) && time(at))) : {}
}

/** When the edge last saw this client, or null. */
export async function clientSeenAt(tx, clientId) {
  const seen = await tx.get(SEEN)
  return object(seen) && typeof clientId === 'string' && UUID.test(clientId) && time(seen[clientId]) ? seen[clientId] : null
}

/**
 * The LAST read of a committing thread transaction: true when the row still names the lease `ref` (nobody
 * took, released or replaced it while the commit awaited). It never judges time: the row read here carries this
 * transaction's own staged extension. The caller judges time AFTER this await with `leaseHeldAt`, on the expiry the lease
 * had before the transaction touched it, and returns with no await after that.
 */
export async function leaseStillNamed(tx, ref) {
  if (!validRef(ref)) return false
  const { row, corrupt } = await readLease(tx)
  // HOLDER hook: in a world held (or not known) at start an unmarked row names no lease (no storage operation).
  if (!corrupt && !row?.[HOLDER_MARK] && (recordOfTx(tx) ? recordOfTx(tx).held !== false : unwrapped && await txHeld(tx) !== false)) return false // HOLDER hook (review: a failed wrap reads)
  return !corrupt && sameLease(row, ref)
}

/**
 * Synchronous, the last check before a committing transaction returns success: the PRE-WRITE expiry
 * (`heldUntil` of checkLease's verdict) is still ahead of the clock read now. Never the row's staged extension.
 */
export const leaseHeldAt = (heldUntil, clock) => time(heldUntil) && heldUntil > clockOf(clock)()

/** False while a live lease exists: HEAD's wake checkpoint yields to her live browser. */
export async function edgeMayWrite(tx, now) {
  const { row, corrupt } = await readLease(tx)
  return !corrupt && !live(row, now)
}
