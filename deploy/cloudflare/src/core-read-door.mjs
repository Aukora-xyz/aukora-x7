import { hashOwnerHostPass, ownerHostPassReadAllowed } from './owner-mandate.mjs'
import { coreId, projectCoreRecord } from './core-kernel-record.mjs'

const routes = new Map([
  ['/core/record', 'core.record'],
  ['/core/threads', 'core.threads'],
  ['/core/thread-tail', 'core.tail'],
  ['/core/memory', 'core.memory'],
])
const MAX_WINDOW_BYTES = 256 * 1024
const MAX_ROWS = 256
const nat = value => Number.isSafeInteger(value) && value >= 0
const json = (status, body) => Response.json(body, { status, headers: { 'cache-control': 'private, no-store' } })
const denied = () => json(401, { ok: false, code: 'CORE_PASS_REQUIRED' })
const unavailable = () => json(503, { ok: false, code: 'CORE_CHECKPOINT_UNAVAILABLE' })

export const isCoreReadRoute = pathname => routes.has(pathname)

function tailView(source, head) {
  if (source?.complete !== true || !nat(source.from) || source.to !== head.lineEnd ||
      source.from >= source.to || source.to - source.from > MAX_WINDOW_BYTES ||
      !Array.isArray(source.messages) || source.messages.length < 1 ||
      source.messages.length > MAX_ROWS) return null
  // The adapter supplies only displayable conversation turns, not journal lines,
  // tool payloads, hidden records or file bodies. Project those fields again here.
  const messages = []
  const encoder = new TextEncoder()
  let total = 0
  for (const row of source.messages) {
    if ((row?.role !== 'user' && row?.role !== 'assistant') ||
        typeof row.text !== 'string' || row.text.length > MAX_WINDOW_BYTES) return null
    total += encoder.encode(row.text).length
    if (total > MAX_WINDOW_BYTES) return null
    messages.push({ role: row.role, text: row.text })
  }
  return { from: source.from, to: source.to, acknowledgedAt: head.at, messages }
}

function memoryView(rows) {
  if (!Array.isArray(rows) || rows.length > MAX_ROWS) return null
  const out = []
  for (const row of rows) {
    if (!coreId(row?.digest) || !nat(row.at)) return null
    out.push({ digest: row.digest, at: row.at })
  }
  return out
}

/**
 * Unmounted until Auma supplies trusted Worker adapters.
 * readAuthorized must check the hashed grant in authoritative storage before
 * reading content, bind it to this installation and return the subject's current
 * acknowledged record and scoped view from the same snapshot. No fallback to a
 * host-supplied record. An absent/expired/revoked grant reports null.
 * verifyCheckpoint checks a trusted signature over the reconstructed fingerprint
 * (not a signer supplied by the reply); its input is internal, never returned.
 */
export function createCoreReadDoor({ readAuthorized, verifyCheckpoint, now = Date.now } = {}) {
  return async function coreRead(request) {
    const url = new URL(request.url)
    const scope = routes.get(url.pathname)
    if (scope === undefined) return json(404, { ok: false, code: 'NOT_FOUND' })
    if (request.method !== 'GET') return json(405, { ok: false, code: 'METHOD_UNAVAILABLE' })
    const match = /^Bearer ([0-9a-f]{64})$/.exec(request.headers.get('authorization') ?? '')
    if (!match) return denied()
    if (typeof readAuthorized !== 'function' || typeof verifyCheckpoint !== 'function') return unavailable()
    try {
      const at = now()
      const passHash = await hashOwnerHostPass(match[1])
      const snapshot = await readAuthorized({ passHash, scope, now: at })
      if (!ownerHostPassReadAllowed({ record: snapshot?.grant, passHash, scope, now: now() })) return denied()
      const input = [...url.searchParams]
      if (input.length > 0 && (scope !== 'core.tail' || input.length !== 1 ||
          input[0][0] !== 'id' || input[0][1] !== snapshot.grant.terms.threadId)) {
        return json(400, { ok: false, code: 'CORE_QUERY_INVALID' })
      }
      const projected = await projectCoreRecord(snapshot.source)
      if (projected === null || projected.record.threadId !== snapshot.grant.terms.threadId ||
          projected.fingerprint !== snapshot.currentFingerprint ||
          await verifyCheckpoint({ fingerprint: projected.fingerprint,
            attestation: snapshot.attestation }) !== true) return unavailable()
      const { fingerprint, record } = projected
      const { version, bytes, lineEnd, tailSha, at: acknowledgedAt } = record.head
      let data
      if (scope === 'core.record') data = record
      if (scope === 'core.threads') data = [{ id: record.threadId, version, bytes, lineEnd, tailSha, acknowledgedAt }]
      if (scope === 'core.tail') data = tailView(snapshot.tail, record.head)
      if (scope === 'core.memory') data = memoryView(snapshot.memory)
      if (!ownerHostPassReadAllowed({ record: snapshot.grant, passHash, scope, now: now() })) return denied()
      if (data === null || data === undefined) return unavailable()
      return json(200, { ok: true, fingerprint, data })
    } catch {
      return unavailable()
    }
  }
}
