/**
 * Bounded owner-gate login lockout and single-use WebSocket ticket store.
 * Fails closed on lockout window, capacity exhaustion, ticket expiry, origin mismatch, or replay.
 */

export const GATE_LOCKOUT_DEFAULTS = Object.freeze({
  maxFailures: 5,
  windowMs: 60_000,
  lockoutMs: 300_000,
  maxSubjects: 1024,
  ticketTtlMs: 30_000,
  maxTickets: 512,
})

const SUBJECT_RE = /^[A-Za-z0-9_.:@-]{1,160}$/
const TICKET_RE = /^[A-Za-z0-9_-]{24,128}$/

function unsignedSafeInt(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0)
}

function randomBase64Url(byteLength = 32) {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength))
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

export function createGateLockoutStore(options = {}, initialSubjects = []) {
  const config = Object.freeze({ ...GATE_LOCKOUT_DEFAULTS, ...options })
  const subjects = new Map()
  if (!Array.isArray(initialSubjects) || initialSubjects.length > config.maxSubjects) throw new Error('GATE_STORAGE_INVALID')
  for (const item of initialSubjects) {
    if (!Array.isArray(item) || item.length !== 2) throw new Error('GATE_STORAGE_INVALID')
    const [key, entry] = item
    if (typeof key !== 'string' || !SUBJECT_RE.test(key) || subjects.has(key)
      || !entry || !Array.isArray(entry.failedAt) || entry.failedAt.length > config.maxFailures
      || !entry.failedAt.every(unsignedSafeInt) || !unsignedSafeInt(entry.lockedUntil)) throw new Error('GATE_STORAGE_INVALID')
    subjects.set(key, { failedAt: [...entry.failedAt], lockedUntil: entry.lockedUntil })
  }
  const tickets = new Map()

  function pruneSubjects(now) {
    for (const [key, entry] of subjects) {
      const recent = entry.failedAt.filter(ts => now - ts < config.windowMs)
      if (recent.length === 0 && entry.lockedUntil <= now) {
        subjects.delete(key)
      } else {
        entry.failedAt = recent
      }
    }
  }

  function pruneTickets(now) {
    for (const [id, ticket] of tickets) {
      if (ticket.expiresAt <= now) tickets.delete(id)
    }
  }

  function assertSubject(subject) {
    if (typeof subject !== 'string' || !SUBJECT_RE.test(subject)) {
      throw Object.assign(new Error('GATE_SUBJECT_INVALID'), { code: 'GATE_SUBJECT_INVALID', status: 400 })
    }
    return subject
  }

  return Object.freeze({
    snapshotSubjects() {
      return [...subjects].map(([key, entry]) => [key, { failedAt: [...entry.failedAt], lockedUntil: entry.lockedUntil }])
    },
    checkSubject(subject, now = Date.now()) {
      if (!unsignedSafeInt(now)) throw Object.assign(new Error('GATE_CLOCK_INVALID'), { code: 'GATE_CLOCK_INVALID', status: 500 })
      const key = assertSubject(subject)
      pruneSubjects(now)
      const entry = subjects.get(key)
      if (entry && entry.lockedUntil > now) {
        return Object.freeze({
          ok: false,
          code: 'GATE_LOCKOUT_ACTIVE',
          status: 429,
          retryAfterMs: entry.lockedUntil - now,
          failures: entry.failedAt.length,
        })
      }
      return Object.freeze({ ok: true, failures: entry?.failedAt.length ?? 0 })
    },

    recordFailure(subject, now = Date.now()) {
      if (!unsignedSafeInt(now)) throw Object.assign(new Error('GATE_CLOCK_INVALID'), { code: 'GATE_CLOCK_INVALID', status: 500 })
      const key = assertSubject(subject)
      pruneSubjects(now)
      let entry = subjects.get(key)
      if (!entry) {
        if (subjects.size >= config.maxSubjects) {
          return Object.freeze({ ok: false, code: 'GATE_LOCKOUT_CAPACITY', status: 507 })
        }
        entry = { failedAt: [], lockedUntil: 0 }
        subjects.set(key, entry)
      }
      if (entry.lockedUntil > now) return this.checkSubject(key, now)
      entry.failedAt.push(now)
      if (entry.failedAt.length > config.maxFailures) entry.failedAt.splice(0, entry.failedAt.length - config.maxFailures)
      if (entry.failedAt.length >= config.maxFailures) {
        entry.lockedUntil = Math.max(entry.lockedUntil, now + config.lockoutMs)
        return Object.freeze({
          ok: false,
          code: 'GATE_LOCKOUT_ACTIVE',
          status: 429,
          retryAfterMs: entry.lockedUntil - now,
          failures: entry.failedAt.length,
        })
      }
      return Object.freeze({ ok: true, failures: entry.failedAt.length, remainingAttempts: config.maxFailures - entry.failedAt.length })
    },

    recordSuccess(subject) {
      if (typeof subject === 'string' && SUBJECT_RE.test(subject)) subjects.delete(subject)
    },

    issueWsTicket({ subject, origin, now = Date.now() } = {}) {
      if (!unsignedSafeInt(now)) throw Object.assign(new Error('GATE_CLOCK_INVALID'), { code: 'GATE_CLOCK_INVALID', status: 500 })
      const key = assertSubject(subject)
      if (typeof origin !== 'string' || origin.length < 8 || origin.length > 256) {
        throw Object.assign(new Error('WS_TICKET_ORIGIN_INVALID'), { code: 'WS_TICKET_ORIGIN_INVALID', status: 400 })
      }
      const gate = this.checkSubject(key, now)
      if (!gate.ok) return gate
      pruneTickets(now)
      if (tickets.size >= config.maxTickets) {
        return Object.freeze({ ok: false, code: 'WS_TICKET_CAPACITY', status: 507 })
      }
      const ticket = randomBase64Url(32)
      const expiresAt = now + config.ticketTtlMs
      tickets.set(ticket, { subject: key, origin, issuedAt: now, expiresAt })
      return Object.freeze({ ok: true, ticket, expiresAt })
    },

    consumeWsTicket({ ticket, origin, subject = null, now = Date.now() } = {}) {
      if (!unsignedSafeInt(now)) throw Object.assign(new Error('GATE_CLOCK_INVALID'), { code: 'GATE_CLOCK_INVALID', status: 500 })
      pruneTickets(now)
      if (typeof ticket !== 'string' || !TICKET_RE.test(ticket)) {
        return Object.freeze({ ok: false, code: 'WS_TICKET_INVALID', status: 403 })
      }
      const stored = tickets.get(ticket)
      tickets.delete(ticket)
      if (!stored || stored.expiresAt <= now) {
        return Object.freeze({ ok: false, code: 'WS_TICKET_EXPIRED_OR_USED', status: 403 })
      }
      if (stored.origin !== origin || (subject !== null && stored.subject !== subject)) {
        return Object.freeze({ ok: false, code: 'WS_TICKET_BINDING_MISMATCH', status: 403 })
      }
      const gate = this.checkSubject(stored.subject, now)
      if (!gate.ok) return gate
      return Object.freeze({ ok: true, subject: stored.subject, origin: stored.origin })
    },
  })
}


/** Persist every decision atomically; isolate restarts never reset failure history. */
export function createDurableGateLockoutStore(storage, options = {}) {
  let queue = Promise.resolve()
  const run = (operation, subject, now = Date.now()) => {
    const pending = queue.then(() => storage.transaction(async tx => {
      const stored = await tx.get('gate-lockout:v1')
      const gate = createGateLockoutStore({ maxSubjects: 256, ...options }, stored === undefined ? [] : stored)
      let result
      if (operation === 'success') {
        result = gate.checkSubject(subject, now)
        // A concurrent successful verification cannot clear an already active lock.
        if (result.ok) { gate.recordSuccess(subject); result = { ok: true } }
      } else result = operation === 'check' ? gate.checkSubject(subject, now) : gate.recordFailure(subject, now)
      await tx.put('gate-lockout:v1', gate.snapshotSubjects())
      return result
    }))
    queue = pending.catch(() => undefined)
    return pending
  }
  return Object.freeze({
    checkSubject: (subject, now) => run('check', subject, now),
    recordFailure: (subject, now) => run('failure', subject, now),
    recordSuccess: (subject, now) => run('success', subject, now),
  })
}
