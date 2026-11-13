/**
 * Thread mount: the glue that puts the thread log (thread-log.mjs) and the one-writer lease forward behind the Worker,
 * so worker.mjs gains only a few marked lines. Nothing here decides a thread or a lease: MIRROR does (one internal
 * POST per step), the thread log's Worker half reads bodies and talks to R2.
 *
 * - `threadFetchRefused(request, url, origin)`: the vault's fetch-site rule for `/_thread/` and `/_mirror/lease`, judged
 *   BEFORE the session is read; the Worker answers a refused request exactly as it answers a signed-out one.
 * - `createThreadMount()`: one per isolate. `handle(...)` answers every `/_thread/` path and `POST /_mirror/lease` for a
 *   signed-in owner on a seeded world. One import at a time in this isolate: a second answers 503 IMPORT_BUSY with
 *   `retry-after: 1` before any bucket read (an import reads and parses a whole rescue index, up to 4 MiB). The slot
 *   has its own deadline (`importHoldMs`), so a cancelled import cannot hold it for the life of the isolate.
 *
 * The two internal bodies (the whole contract with MIRROR's routes):
 *   POST /_mirror/thread   `{ op, input }`, or `{ op, input, home }` on the one import call that commits, where
 *                          `home = { rescue, clientId, base, reconciliation, verifiedAt }`.
 *   POST /_mirror/lease    `{ input, ownerApproved }`; `ownerApproved` is written here, always; the browser's field of
 *                          that name never survives.
 * Every refusal is a RETURNED Response; nothing here throws, and nothing here deletes a bucket key.
 */
import { createR2PartStore, handleThreadRequest, sha256Hex, threadLimits } from './thread-log.mjs'
import { verifiedAtMs } from './world-home.mjs'
import { WORKER_ONLY_FIELDS, descriptorOnly, holderWord } from './world-holder.mjs' // HOME hook: the Worker's word about a copy (job 4: a move's descriptor; review: MIRROR's words to the Worker alone)
import { aumlokClass3Binding } from './aumlok.mjs' // HOLDER hook: the exact action HEAD's approval is bound to (read only)

/** The name this Worker gives her world's objects (never the seedId). */
export const THREAD_MOUNT_WORLD = 'node-main-v1'
export const THREAD_MOUNT_LIMITS = Object.freeze({
  leaseBodyBytes: 1024,
  // MIRROR's lease route reads at most 1 KiB: the forwarded `{ input, ownerApproved }` must fit it, measured as sent.
  mirrorLeaseBodyBytes: 1024,
  leaseReplyBytes: 65536,
  // A `range` answer carries up to 2 PIECE (4 MiB) as base64: about 5.6 MiB of JSON.
  mirrorReplyBytes: 8 * 1024 * 1024,
  manifestBytes: 65536,
  indexBytes: 4 * 1024 * 1024,
})
// `importHoldMs`: the import slot's own deadline. A request the runtime cancels (a reload, a closed tab) never runs its
// `finally`, so the slot is busy only while its holder's hold is live; longer than an honest import (its body read is
// 120 s at most, the index read 10 s, then a few MIRROR steps of 30 s at most each). An import still running past it
// may be joined by one more, never by many.
// job 3: `headMs`, the deadline of the one read-only question to HEAD about an approval (a move's repeat).
export const THREAD_MOUNT_DEADLINES = Object.freeze({ mirrorMs: 30000, leaseIdleMs: 10000, leaseTotalMs: 10000, r2Ms: 10000, importHoldMs: 300000, headMs: 10000 })

const LEASE_ROUTE = '/_mirror/lease'
const THREAD_ROUTE = '/_mirror/thread'
const APPROVED_ACTIONS = new Set(['take', 'forget']) // HOME hook: a move (and a reserve) asks in its own flow below
const HEX32 = /^[0-9a-f]{32}$/
const HEX64 = /^[0-9a-f]{64}$/
const LATE = Symbol('late')
const UNAVAILABLE = Object.freeze({ unavailable: true })
const STORAGE_UNAVAILABLE = Object.freeze({ status: 503, body: Object.freeze({ ok: false, code: 'THREAD_STORAGE_UNAVAILABLE' }) })

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const reply = (value, status, extra = {}) => Response.json(value, { status, headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...extra } })
const refuse = (status, code, fields = {}, extra = {}) => reply({ ok: false, code, ...fields }, status, extra)
const parseJson = bytes => {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) } catch { return undefined }
}
const bucketUsable = bucket => isObject(bucket) && ['get', 'head', 'put'].every(name => typeof bucket[name] === 'function')

/** The paths this mount answers. */
export const isThreadMountRoute = url => url.pathname.startsWith('/_thread/') || url.pathname === LEASE_ROUTE

/**
 * The vault's fetch-site rule, for this mount's paths: a write needs her own Origin and `sec-fetch-site: same-origin`;
 * a read needs `same-origin`, or `none` with `sec-fetch-mode: navigate`. True means refuse, before the session is read.
 * @param {Request} request @param {URL} url @param {string|null} origin
 */
export function threadFetchRefused(request, url, origin) {
  if (!isThreadMountRoute(url)) return false
  const site = request.headers.get('sec-fetch-site')
  if (['GET', 'HEAD'].includes(request.method)) return site !== 'same-origin' && !(site === 'none' && request.headers.get('sec-fetch-mode') === 'navigate')
  return origin !== url.origin || site !== 'same-origin'
}

/**
 * Drain a stream with a hard byte limit while reading, an idle and a total deadline. Answers `{ bytes }` or `{ fault }`
 * ('large', 'stall', 'error', 'broken'); every fault cancels the stream. Never throws.
 */
async function readCapped(stream, { limit, idleMs, totalMs }) {
  if (!stream) return { bytes: new Uint8Array(0) }
  let reader
  try { reader = stream.getReader() } catch { return { fault: 'broken' } }
  const cancel = () => { try { void reader.cancel().catch(() => {}) } catch { /* released */ } }
  const chunks = []
  let size = 0
  const started = Date.now()
  let lastByte = started
  for (;;) {
    const left = Math.min(totalMs - (Date.now() - started), idleMs - (Date.now() - lastByte))
    if (left <= 0) { cancel(); return { fault: 'stall' } }
    let timer
    const stalled = new Promise(resolve => { timer = setTimeout(() => resolve(LATE), left) })
    let step
    try { step = await Promise.race([reader.read(), stalled]) } catch { clearTimeout(timer); cancel(); return { fault: 'error' } }
    clearTimeout(timer)
    if (step === LATE) { cancel(); return { fault: 'stall' } }
    if (step.done) break
    const value = step.value
    const chunk = value instanceof Uint8Array ? value : ArrayBuffer.isView(value) ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
      : value instanceof ArrayBuffer ? new Uint8Array(value) : null
    if (!chunk) { cancel(); return { fault: 'broken' } }
    if (chunk.byteLength > limit - size) { cancel(); return { fault: 'large' } }
    if (chunk.byteLength === 0) continue
    chunks.push(chunk)
    size += chunk.byteLength
    lastByte = Date.now()
  }
  const bytes = new Uint8Array(size)
  let at = 0
  for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.byteLength }
  return { bytes }
}

/** A stored R2 object's whole body, at exactly its recorded size and at most `limit`. */
async function readObject(found, limit, ms) {
  if (!Number.isSafeInteger(found?.size) || found.size < 0 || found.size > limit) {
    try { void found?.body?.cancel?.().catch(() => {}) } catch { /* nothing to cancel */ }
    return { fault: 'large' }
  }
  const read = await readCapped(found.body, { limit: found.size, idleMs: ms, totalMs: ms })
  if (read.fault) return read
  return read.bytes.byteLength === found.size ? read : { fault: 'short' }
}

/**
 * VERIFIED rescues in the vault: `get(id)` answers `{ index, verifiedAt }` only when `manifest.json` exists and the
 * SHA-256 of `pending.json` (read under 4 MiB) equals the manifest's `indexSha`; null when absent or not that index;
 * `{ unavailable: true }` when a body could not be read whole. The thread log races the whole call with its R2 deadline.
 */
function vaultRescues(bucket, world, deadlines) {
  return Object.freeze({
    async get(id) {
      if (typeof id !== 'string' || !HEX32.test(id)) return null
      const base = `w/${world}/rescue/${id}`
      const manifestFound = await bucket.get(`${base}/manifest.json`)
      if (!manifestFound) return null
      const manifestRead = await readObject(manifestFound, THREAD_MOUNT_LIMITS.manifestBytes, deadlines.r2Ms)
      if (manifestRead.fault) return UNAVAILABLE
      const manifest = parseJson(manifestRead.bytes)
      if (!isObject(manifest) || manifest.verified !== true || typeof manifest.indexSha !== 'string' || !HEX64.test(manifest.indexSha)) return null
      const pending = await bucket.get(`${base}/pending.json`)
      if (!pending) return null
      const read = await readObject(pending, THREAD_MOUNT_LIMITS.indexBytes, deadlines.r2Ms)
      if (read.fault) return UNAVAILABLE
      if (await sha256Hex(read.bytes) !== manifest.indexSha) return null
      const index = parseJson(read.bytes)
      if (!isObject(index)) return null
      // MIRROR's thread route takes a `home` only with a readable verifiedAt (world-home.mjs
      // validHomeInput); a manifest without one is not a verified rescue here, so no import ever carries `null`.
      if (typeof manifest.verifiedAt !== 'string' || verifiedAtMs(manifest.verifiedAt) === null) return null
      return { index, verifiedAt: manifest.verifiedAt }
    },
  })
}

/**
 * ONE internal POST to MIRROR, with the internal mark and this world's seed (as the vault's budget call). Answers
 * `{ status, body }`; a failed, late, oversized or unreadable answer is `{ status: 503, body: THREAD_STORAGE_UNAVAILABLE }`.
 */
function mirrorPoster({ env, seedId, signal, deadlines }) {
  return async (path, payload, replyLimit) => {
    if (!env.MIRROR || typeof seedId !== 'string') return STORAGE_UNAVAILABLE
    // A cancelled request dispatches NOTHING more. Checked before EVERY internal call (the manifest,
    // each step of an import, its commit, the lease calls): an import whose page went away while it waited on R2 must never
    // commit afterwards, nor renew a lease that ran out meanwhile.
    if (signal?.aborted) return STORAGE_UNAVAILABLE
    const controller = new AbortController()
    const onAbort = () => controller.abort()
    signal?.addEventListener?.('abort', onAbort, { once: true })
    // An abort that lands between the check above and the registration never fires the listener: handle it here.
    if (signal?.aborted) {
      signal.removeEventListener?.('abort', onAbort)
      return STORAGE_UNAVAILABLE
    }
    let timer
    const late = new Promise(resolve => { timer = setTimeout(() => { controller.abort(); resolve(LATE) }, deadlines.mirrorMs) })
    const work = (async () => {
      const response = await env.MIRROR.get(env.MIRROR.idFromName(THREAD_MOUNT_WORLD)).fetch(new Request('https://x61.internal' + path, {
        method: 'POST', signal: controller.signal,
        headers: { 'content-type': 'application/json', 'x-x6-internal-authorized': '1', 'x-x6-bootstrap-seed': seedId },
        body: JSON.stringify(payload) }))
      const read = await readCapped(response.body, { limit: replyLimit, idleMs: deadlines.mirrorMs, totalMs: deadlines.mirrorMs })
      if (read.fault) return null
      const body = parseJson(read.bytes)
      return Number.isInteger(response.status) && isObject(body) ? { status: response.status, body } : null
    })().catch(() => null)
    try {
      const answer = await Promise.race([work, late])
      return answer === LATE || answer === null ? STORAGE_UNAVAILABLE : answer
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', onAbort)
    }
  }
}

/** The owner's passkey over this exact body: no approval header is false with no HEAD call; a failed check is false. */
async function ownerApproval(request, body, authorize, now) {
  if (!request.headers.get('x-x6-class3-approval') || typeof authorize !== 'function') return false
  try {
    const approval = await authorize(body)
    return Number.isFinite(approval?.expiresAt) && approval.expiresAt > now()
  } catch { return false }
}

// ── job 3: an approval's outcome is never guessed. ──────────────────────────────────────────────────────
// HEAD's own refusals (the Worker's edgeClass3 throws them with HEAD's status): the approval was NOT spent by this ask.
const DEFINITE_REFUSALS = new Set([400, 403, 404, 409, 429])
/**
 * MUST 3: the passkey over this exact body, in three outcomes: `approved` (HEAD consumed it now, for this body), `refused`
 * (no header, or HEAD clearly said no: nothing was spent by this ask) or `uncertain` (HEAD's answer was lost, late,
 * malformed or any other failure: it may have been spent).
 */
async function approvalOutcome(request, body, authorize, now) {
  if (!request.headers.get('x-x6-class3-approval') || typeof authorize !== 'function') return 'refused'
  try {
    const approval = await authorize(body)
    return Number.isFinite(approval?.expiresAt) && approval.expiresAt > now() ? 'approved' : 'uncertain'
  } catch (error) {
    return DEFINITE_REFUSALS.has(error?.status) && typeof error?.code === 'string' ? 'refused' : 'uncertain'
  }
}

const INSPECTED = new Set(['consumed', 'unconsumed', 'other', 'none', 'forgotten', 'unknown'])
/**
 * MUST 3: ONE read-only question to HEAD (`POST /_head/class3-inspect`, internal only): was THIS approval (the header's
 * bearer) consumed for THIS exact body? `consumed`, `unconsumed`, `other` (it approves another action), `none` (HEAD can
 * show it was never consumed), `forgotten` (job 4 review: HEAD answered and holds no live record of it: it may
 * have been used and its history discarded; a repeat can never resolve it) or `unknown` (no HEAD, a late, failed or
 * malformed answer, or HEAD's own read failed: a repeat may resolve it). Never throws.
 */
async function inspectApproval({ env, request, url, body, ms }) {
  const token = request.headers.get('x-x6-class3-approval')
  if (!token || !env?.HEAD) return 'unknown'
  let binding
  try { binding = await aumlokClass3Binding({ audience: url.origin, method: request.method, pathname: url.pathname, body }) } catch { return 'none' }
  const controller = new AbortController()
  let timer
  const late = new Promise(resolve => { timer = setTimeout(() => { controller.abort(); resolve(LATE) }, ms) })
  const work = (async () => {
    const response = await env.HEAD.get(env.HEAD.idFromName(THREAD_MOUNT_WORLD)).fetch(new Request('https://x61.internal/_head/class3-inspect', {
      method: 'POST', signal: controller.signal, headers: { 'content-type': 'application/json', 'x-x6-internal-authorized': '1' },
      body: JSON.stringify({ token, binding }) }))
    const read = await readCapped(response.body, { limit: 4096, idleMs: ms, totalMs: ms })
    const answer = read.fault ? null : parseJson(read.bytes)
    return response.status === 200 && answer?.ok === true && INSPECTED.has(answer.approval) ? answer.approval : 'unknown'
  })().catch(() => 'unknown')
  try {
    const seen = await Promise.race([work, late])
    return seen === LATE ? 'unknown' : seen
  } finally { clearTimeout(timer) }
}

/**
 * MUST 2a: the public id of the owner session this request arrived on: SHA-256 of a domain and the session's MAC (the
 * envelope the Worker's gate verified; worker.mjs passkeySessionAccess hands it on as `access.session`), 32 hex. None
 * (another kind of access, or a Worker that hands none): null, and then no proof can verify (fail closed).
 * job 4 (R1d): an owner-pass browser that also holds a passkey session gets `access.sessionLookup` from the Worker
 * (worker.mjs, marked hook) instead of an answer: the passkey session is looked up (one HEAD read) ONLY when `wanted`, i.e.
 * when this request's body, already parsed here, carries a `proof` or a `checkpoint` (a holder-aware page acting as her
 * body, or asking the preview, which tells it its `sid`). Every other lease request of that browser costs no HEAD call.
 */
async function sessionPublicId(access, wanted) {
  let session = access?.session
  if (typeof session !== 'string' && wanted && typeof access?.sessionLookup === 'function') {
    // job 4 review (SHOULD): a lookup that could not decide (the sign-in key read busy: the Worker's
    // OWNER_SESSION_PENDING, or a throw) is UNAVAILABLE (503, retry), never "no session" (which reads as "sign in").
    let found
    try { found = await access.sessionLookup() } catch { return UNAVAILABLE }
    if (isObject(found) && found.unavailable) return UNAVAILABLE
    session = found?.session
  }
  if (typeof session !== 'string' || !HEX64.test(session)) return null
  return (await sha256Hex(new TextEncoder().encode(`aukora-x6-session-id/1\0${session}`))).slice(0, 32)
}
// MUST 2a: the requests `sid` joins: the status (always) and these when they carry a proof (job 4: a move too).
const SESSION_PROOF_ACTIONS = new Set(['acquire', 'renew', 'take', 'release', 'seal', 'reserve', 'move'])
const MAY_BE_SPENT = Object.freeze({ approval: 'may be spent', next: 'repeat the same move' })

// ── job 4 (R3): after an approval is consumed, no answer says or implies that the passkey is still
// required, or that nothing was asked. Three endings only: done; outcome unknown (an answer was lost: say it; a repeat of
// the SAME body with the SAME approval resolves it through HEAD's inspection where it can); or 409
// APPROVAL_SPENT_NOTHING_CHANGED with `reason` (MIRROR's code) and a `next` sentence, for every refusal that arrives after
// the consumption. (A move keeps its named endings: MOVE_APPROVAL_SPENT, MOVE_OUTCOME_FORGOTTEN, MOVE_OUTCOME_UNKNOWN.)
const SPENT_BECAUSE = Object.freeze({
  PROOF_REPLAYED: 'another tab of this browser acted first', HOLDER_MOVED: 'her body moved meanwhile', MOVE_RESERVED: 'a move was reserved meanwhile',
  LOG_MOVED: 'her threads changed meanwhile', HOLDER_ELSEWHERE: 'another browser is her body', HOLDER_STATE_UNAVAILABLE: 'her record could not be read',
  MOVE_NEEDS: 'what the move needs changed meanwhile', CHECKPOINT_NOT_VERIFIED: 'the copy is not verified', KEY_PROOF_INVALID: 'the signature ran out',
  LEASE_STATE_UNAVAILABLE: 'the lease could not be read', LOG_MARK_UNAVAILABLE: 'her threads could not be read',
  HOME_PENDING: 'a newer home of hers is waiting', CLIENT_SLOT_RETIRED: 'this browser was retired meanwhile',
})
const spentNothingChanged = code => refuse(409, 'APPROVAL_SPENT_NOTHING_CHANGED', { approval: 'spent', reason: typeof code === 'string' ? code : 'UNKNOWN',
  next: `Your approval was used and nothing changed, because ${SPENT_BECAUSE[code] ?? 'her world changed meanwhile'}. Approve again.` })
// job 4 review (SHOULD): HEAD answered and keeps no live record of this approval (`forgotten`): it may have been
// used, nothing changed by this request, and no repeat can tell more: approve again.
const mayBeSpentNothingChanged = () => refuse(409, 'APPROVAL_SPENT_NOTHING_CHANGED', { approval: 'may be spent', reason: 'APPROVAL_FORGOTTEN',
  next: 'Your approval may have been used and nothing changed, because it is no longer on record. Approve again.' })
/** The one answer of an unapproved request that lets the passkey be asked: MIRROR wants it, and nothing else stands in the way. */
const wantsPasskey = got => got.status === 403 && got.body?.code === 'CLASS3_WEBAUTHN_REQUIRED'

/**
 * `POST /_mirror/lease`: a JSON body of 1 KiB at most, read here with a deadline; `take` and `forget` ask the owner's
 * passkey over that exact body; ONE internal POST `{ input, ownerApproved }`; MIRROR's status and body come back.
 */
async function routeLease({ request, url, post, authorize, now, deadlines, rescues, env, access }) { // HOME hook: rescues (env, access)
  if (request.method !== 'POST') return refuse(405, 'METHOD_UNAVAILABLE')
  if (url.search || url.hash || url.href.endsWith('?')) return refuse(404, 'NOT_FOUND')
  // The neighbours' rules: a JSON body says so (estate, owner grant); an
  // encoding other than identity, a declared length that is not a plain number or not the body's length is 400 (vault).
  const declared = request.headers.get('content-length')
  const encoding = request.headers.get('content-encoding')
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') || '') || (encoding && encoding.trim().toLowerCase() !== 'identity')
    || (declared !== null && !/^\d{1,15}$/.test(declared))) {
    void request.body?.cancel().catch(() => {})
    return refuse(400, 'LEASE_REQUEST_INVALID')
  }
  if (declared !== null && Number(declared) > THREAD_MOUNT_LIMITS.leaseBodyBytes) {
    void request.body?.cancel().catch(() => {})
    return refuse(413, 'LEASE_REQUEST_TOO_LARGE', { limit: THREAD_MOUNT_LIMITS.leaseBodyBytes })
  }
  const read = await readCapped(request.body, { limit: THREAD_MOUNT_LIMITS.leaseBodyBytes, idleMs: deadlines.leaseIdleMs, totalMs: deadlines.leaseTotalMs })
  if (read.fault === 'large') return refuse(413, 'LEASE_REQUEST_TOO_LARGE', { limit: THREAD_MOUNT_LIMITS.leaseBodyBytes })
  if (read.fault === 'stall' || read.fault === 'error') return refuse(408, 'REQUEST_BODY_TIMEOUT')
  if (!read.fault && declared !== null && read.bytes.byteLength !== Number(declared)) return refuse(400, 'LEASE_REQUEST_INVALID')
  const body = read.fault ? undefined : parseJson(read.bytes)
  if (!isObject(body)) return refuse(400, 'LEASE_REQUEST_INVALID')
  // `ownerApproved` is the Worker's word alone: a body that carries the field is forwarded as not approved, without it,
  // and without asking the passkey.
  const carried = Object.hasOwn(body, 'ownerApproved')
  const input = { ...body }
  delete input.ownerApproved
  // HOME hook: the Worker's word (world-holder.mjs): a body naming its field is 400 (a move's descriptor excepted); seal,
  // HOME hook: reserve and the preview read the copy first. The word joins the input, so the size check below is made on
  // HOME hook: the final wrapper.
  const word = await holderWord(body, input, rescues, deadlines.r2Ms) // HOME hook
  if (word.refusal) return refuse(word.refusal.status, word.refusal.code) // HOME hook
  if (word.copy) input.copy = word.copy // HOME hook
  // HOLDER hook (MUST 2a): the session's public id joins the status and every request that carries a proof; the browser
  // HOLDER hook: can never name it (holderWord answered 400 above). Job 4 (R1d): an owner-pass browser's passkey session
  // HOLDER hook: is looked up only for a body with a proof or a checkpoint.
  const sid = await sessionPublicId(access, Object.hasOwn(input, 'proof') || Object.hasOwn(input, 'checkpoint')) // HOLDER hook
  if (sid === UNAVAILABLE) return refuse(503, 'OWNER_SESSION_UNAVAILABLE', {}, { 'retry-after': '1' }) // HOLDER hook (review): as the Worker answers a busy key read
  if (sid && (input.action === 'status' || (Object.hasOwn(input, 'proof') && SESSION_PROOF_ACTIONS.has(input.action)))) input.sid = sid // HOLDER hook
  // What MIRROR reads is the wrapper, not the browser's body: refuse here, before the passkey is asked, when it would not
  // fit (`false` is the longer of the two values).
  if (new TextEncoder().encode(JSON.stringify({ input, ownerApproved: false })).byteLength > THREAD_MOUNT_LIMITS.mirrorLeaseBodyBytes) {
    return refuse(413, 'LEASE_REQUEST_TOO_LARGE', { limit: THREAD_MOUNT_LIMITS.mirrorLeaseBodyBytes })
  }
  // Review (SHOULD): a proof sent with owner access that carries no session (the owner pass: worker.mjs uses an
  // ambient owner JWT before the passkey session) can never verify; the refusal says so (`sid: null`), so the page asks for
  // the passkey sign-in instead of showing "another browser holds her". Only the asker's own session is described.
  const sessionless = !sid && Object.hasOwn(input, 'proof') && SESSION_PROOF_ACTIONS.has(input.action)
  const pass = got => {
    const out = { ...got.body }
    delete out.conflictCode
    for (const field of WORKER_ONLY_FIELDS) delete out[field] // HOLDER hook (review): MIRROR's words to the Worker alone
    if (sessionless && out.code === 'HOLDER_ELSEWHERE') out.sid = null
    return reply(out, got.status)
  }
  const header = request.headers.get('x-x6-class3-approval')
  // HOME hook: a move is first sent unapproved; only MIRROR's 403 CLASS3_WEBAUTHN_REQUIRED, said only while a
  // HOME hook: live reservation names this exact descriptor, lets the passkey be asked (and so consumed). Any other answer
  // HOME hook: (not reserved, already moved, a bad shape) is the answer, and no approval is spent on it.
  if (input.action === 'move') return routeMove({ request, url, body, input, post, authorize, now, deadlines, env, carried, header, pass }) // HOLDER hook
  // HOLDER hook (job 4 R1b, R3): a take with an approval: routeTake.
  if (input.action === 'take' && header && !carried) return routeTake({ request, url, body, input, post, authorize, now, deadlines, env, pass }) // HOLDER hook
  // HOLDER hook: a reserve with an approval: routeReserve.
  if (input.action === 'reserve' && header && !carried) return routeReserve({ request, url, body, input, post, authorize, now, deadlines, env, pass }) // HOLDER hook
  const ownerApproved = !carried && APPROVED_ACTIONS.has(input.action) ? await ownerApproval(request, body, authorize, now) : false
  return pass(await post(LEASE_ROUTE, { input, ownerApproved: ownerApproved === true }, THREAD_MOUNT_LIMITS.leaseReplyBytes))
}

const postLease = (post, input, ownerApproved) => post(LEASE_ROUTE, { input, ownerApproved }, THREAD_MOUNT_LIMITS.leaseReplyBytes)
const headWait = deadlines => deadlines.headMs ?? THREAD_MOUNT_DEADLINES.headMs

/**
 * job 3 + job 4 + job 4 review: a take with an approval header.
 * - EVERY such take is first sent unapproved (one MIRROR call that only reads). Any answer but 403
 *   CLASS3_WEBAUTHN_REQUIRED (another browser is her body, a move is reserved, her row is unreadable, a replayed proof, a
 *   pending home, a retired browser ...) is the answer, and nothing is asked: an approved take would be refused the same.
 *   This is the one cost an unclaimed world pays per request beyond main (a take is the owner's fingerprint action);
 *   R1b ("no preflight when the start-up state says no holder") cannot be met: the Worker cannot see that state.
 * - `bodyProven` on that 403 (MIRROR's word, world-lease.mjs): her body's proof verified with an unused ts. Only then is a
 *   repeat after a lost answer resolved through HEAD's inspection (`consumed`: sent approved, no passkey again; MIRROR uses
 *   the ts, so it lands at most once). Without it (no holder body: a proof is never checked) a used approval is NEVER
 *   re-sent: HEAD's refusal stands, as on main.
 * - R3, after the consumption: done; a MIRROR answer lost (or a replayed ts on a repeat) is 503 TAKE_OUTCOME_UNKNOWN
 *   {approval: "spent", next: "read the status"}; every refusal is 409 APPROVAL_SPENT_NOTHING_CHANGED. The passkey's own
 *   answer lost: 503 TAKE_OUTCOME_UNKNOWN {approval: "may be spent"} ("repeat the same take" with `bodyProven`, else
 *   "approve again"). HEAD keeps no record (`forgotten`): APPROVAL_SPENT_NOTHING_CHANGED {approval: "may be spent"}.
 */
async function routeTake({ request, url, body, input, post, authorize, now, deadlines, env, pass }) {
  const inspect = () => inspectApproval({ env, request, url, body, ms: headWait(deadlines) })
  const landedOrNot = () => refuse(503, 'TAKE_OUTCOME_UNKNOWN', { approval: 'spent', next: 'read the status' })
  const first = await postLease(post, input, false)
  if (first.status >= 400 && !wantsPasskey(first)) {
    // A replayed ts while this very approval was already used for this body: its earlier send may have landed.
    if (first.body?.code === 'PROOF_REPLAYED' && await inspect() === 'consumed') return landedOrNot()
    return pass(first)
  }
  const proven = first.body?.bodyProven === true
  let outcome = await approvalOutcome(request, body, authorize, now)
  if (outcome === 'uncertain') return refuse(503, 'TAKE_OUTCOME_UNKNOWN', { approval: 'may be spent', next: proven ? 'repeat the same take' : 'approve again' })
  let repeat = false
  if (outcome === 'refused' && proven) {
    const seen = await inspect()
    if (seen === 'unknown') return refuse(503, 'TAKE_OUTCOME_UNKNOWN', { approval: 'may be spent', next: 'repeat the same take' })
    if (seen === 'forgotten') return mayBeSpentNothingChanged()
    if (seen === 'consumed') { outcome = 'approved'; repeat = true }
  }
  // HEAD said no (nothing was spent by this ask): MIRROR's unapproved answer stands, as on main.
  if (outcome !== 'approved') return pass(first)
  const got = await postLease(post, input, true)
  if (got.status === 200) return pass(got)
  if (got === STORAGE_UNAVAILABLE || (repeat && got.body?.code === 'PROOF_REPLAYED')) return landedOrNot()
  return spentNothingChanged(got.body?.code)
}

/**
 * job 3 + job 4 + review: a reserve with an approval header is first sent unapproved; only its 409
 * MOVE_RESERVED (a live reservation or the back-off) leads on, and an approved reserve is never blocked. Then HEAD's
 * inspection is read FIRST: `consumed` (this approval was already used for this exact body): sent approved again only when
 * the live reservation is the asker's OWN (`ownReservation`, MIRROR's word: a lost answer's renewal, nobody displaced);
 * otherwise 409 APPROVAL_SPENT_NOTHING_CHANGED (a spent override never displaces a later one). `unknown`: 503
 * APPROVAL_OUTCOME_UNKNOWN; `forgotten`: spent-or-not, approve again; `other`: the plain answer (another body's approval).
 * Otherwise the passkey is asked. After the consumption: 200; a lost MIRROR answer is 503 APPROVAL_OUTCOME_UNKNOWN
 * {approval: "spent"}; any refusal is 409 APPROVAL_SPENT_NOTHING_CHANGED. Never a plain MOVE_RESERVED after consumption.
 */
async function routeReserve({ request, url, body, input, post, authorize, now, deadlines, env, pass }) {
  const first = await postLease(post, input, false)
  if (first.status !== 409 || first.body?.code !== 'MOVE_RESERVED') return pass(first)
  const seen = await inspectApproval({ env, request, url, body, ms: headWait(deadlines) })
  if (seen === 'unknown') return refuse(503, 'APPROVAL_OUTCOME_UNKNOWN', { approval: 'may be spent', next: 'reserve again' })
  if (seen === 'forgotten') return mayBeSpentNothingChanged()
  if (seen === 'other') return pass(first)
  if (seen === 'consumed') {
    if (first.body.ownReservation !== true) return spentNothingChanged('MOVE_RESERVED')
  } else {
    const outcome = await approvalOutcome(request, body, authorize, now)
    if (outcome === 'uncertain') return refuse(503, 'APPROVAL_OUTCOME_UNKNOWN', { approval: 'may be spent', next: 'reserve again' })
    if (outcome !== 'approved') return pass(first)
  }
  const got = await postLease(post, input, true)
  if (got === STORAGE_UNAVAILABLE) return refuse(503, 'APPROVAL_OUTCOME_UNKNOWN', { approval: 'spent', next: 'reserve again' })
  return got.status === 200 ? pass(got) : spentNothingChanged(got.body?.code)
}

/**
 * job 3: a move. Sent unapproved first (nothing is asked unless MIRROR answers 403, a live reservation
 * of exactly this descriptor). With an approval header, HEAD is then asked, read-only, whether THIS approval was already
 * consumed for THIS descriptor (a repeat after an answer was lost):
 * - consumed: the commit is sent approved, no passkey again (MIRROR commits only that live reservation, once); if the
 *   reservation lapsed: 409 MOVE_APPROVAL_SPENT {moved: false}.
 * - unconsumed or none: the passkey is asked as usual; `other` (it approves another action): 403, never accepted.
 * - unknown, or the passkey's own answer uncertain: 503 MOVE_OUTCOME_UNKNOWN {approval: "may be spent", next: "repeat the
 *   same move"}; an unapproved request is never forwarded in its place.
 * After the passkey a commit MIRROR did not answer is sent once more; still none: 503 MOVE_OUTCOME_UNKNOWN {approval: "spent"}.
 */
async function routeMove({ request, url, body: sent, input, post, authorize, now, deadlines, env, carried, header, pass }) {
  // job 4: the passkey approves the DESCRIPTOR; a proof the browser sends beside it is not part of it.
  const body = isObject(sent) ? descriptorOnly(sent) : sent
  const first = await post(LEASE_ROUTE, { input, ownerApproved: false }, THREAD_MOUNT_LIMITS.leaseReplyBytes)
  if (carried || !header) return pass(first)
  const lapsed = first.status === 409 && first.body?.code === 'MOVE_NOT_RESERVED'
  if (!lapsed && (first.status !== 403 || first.body?.code !== 'CLASS3_WEBAUTHN_REQUIRED')) return pass(first)
  const seen = await inspectApproval({ env, request, url, body, ms: deadlines.headMs ?? THREAD_MOUNT_DEADLINES.headMs })
  // Nothing moved (MIRROR knows it): if this approval was spent on this descriptor, say so; if HEAD cannot tell (job
  // 4 review: unknown or forgotten), say it may be spent; only when HEAD can tell it was not, MIRROR's answer stands.
  if (lapsed) {
    if (seen === 'consumed') return refuse(409, 'MOVE_APPROVAL_SPENT', { moved: false, next: 'reserve and approve again' })
    if (seen === 'unknown' || seen === 'forgotten') return refuse(409, 'MOVE_NOT_RESERVED', { moved: false, approval: 'may be spent', next: 'reserve and approve again' })
    return pass(first)
  }
  if (seen === 'unknown') return refuse(503, 'MOVE_OUTCOME_UNKNOWN', MAY_BE_SPENT)
  // Live and not moved (MIRROR said 403 for this descriptor), and HEAD keeps no record of the approval: approve again.
  if (seen === 'forgotten') return mayBeSpentNothingChanged()
  if (seen === 'other') return pass(first)
  let approved = seen === 'consumed'
  if (!approved) {
    const outcome = await approvalOutcome(request, body, authorize, now)
    if (outcome === 'uncertain') return refuse(503, 'MOVE_OUTCOME_UNKNOWN', MAY_BE_SPENT)
    approved = outcome === 'approved'
  }
  // A clear refusal: MIRROR judges the unapproved descriptor again (403 while it is reserved, or that it lapsed).
  if (!approved) return pass(await post(LEASE_ROUTE, { input, ownerApproved: false }, THREAD_MOUNT_LIMITS.leaseReplyBytes))
  // HOME hook (review): after the passkey a move's approval is spent. A commit MIRROR did not answer is sent once more
  // HOME hook: (MIRROR commits only the live reservation of this descriptor and answers a repeat `already`, so a second
  // HOME hook: send never moves twice); still no answer: 503 MOVE_OUTCOME_UNKNOWN, never a guessed `moved: false`.
  let answer = await post(LEASE_ROUTE, { input, ownerApproved: true }, THREAD_MOUNT_LIMITS.leaseReplyBytes)
  if (answer === STORAGE_UNAVAILABLE) answer = await post(LEASE_ROUTE, { input, ownerApproved: true }, THREAD_MOUNT_LIMITS.leaseReplyBytes)
  if (answer === STORAGE_UNAVAILABLE) return refuse(503, 'MOVE_OUTCOME_UNKNOWN', { approval: 'spent', next: 'repeat the same move' })
  // job 4: after the passkey only the move's own endings: done, `already`, MOVE_APPROVAL_SPENT (lapsed),
  // MOVE_OUTCOME_FORGOTTEN; MIRROR's 503 (nothing committed; the same approval repeated commits it) is MOVE_OUTCOME_UNKNOWN.
  if (answer.status === 200 || ['MOVE_APPROVAL_SPENT', 'MOVE_OUTCOME_FORGOTTEN'].includes(answer.body?.code)) return pass(answer)
  if (answer.status === 503) return refuse(503, 'MOVE_OUTCOME_UNKNOWN', { approval: 'spent', next: 'repeat the same move' })
  return spentNothingChanged(answer.body?.code)
}

/**
 * One per isolate: holds the one-import-at-a-time slot, `{ holder, until }`. Busy only while `until > now()`; only the
 * request that holds it frees it (a late `finally` of an earlier holder whose hold ran out frees nothing). Across isolates
 * MIRROR admits one thread step at a time and lets a waiting home save go first (mirror-do.mjs threadTurn).
 */
export function createThreadMount({ deadlines, importStep } = {}) {
  const waits = { ...THREAD_MOUNT_DEADLINES, ...deadlines }
  const slot = { holder: null, until: 0 }
  return Object.freeze({
    /**
     * Answer one `/_thread/` or `/_mirror/lease` request for a signed-in caller.
     * @param {{ request: Request, url: URL, env: Record<string, any>, ready: boolean, seedId: string, access: any,
     *   authorize?: (body: unknown) => Promise<any>, now?: () => number, threadDeadlines?: object }} options
     * @returns {Promise<Response>}
     */
    async handle({ request, url, env, ready, seedId, access, authorize, now = Date.now, threadDeadlines }) {
      if (ready !== true) return refuse(503, 'BOOTSTRAP_REQUIRED')
      if (access?.type !== 'owner') return refuse(403, 'OWNER_ACCESS_REQUIRED')
      const post = mirrorPoster({ env, seedId, signal: request.signal, deadlines: waits })
      if (url.pathname === LEASE_ROUTE) return routeLease({ request, url, post, authorize, now, deadlines: waits, rescues: bucketUsable(env.ARCHIVE_BUCKET) ? vaultRescues(env.ARCHIVE_BUCKET, THREAD_MOUNT_WORLD, waits) : null, // HOME hook
        env, access }) // HOLDER hook: HEAD for the approval question; the session (its public id is derived after the body is read)
      const bucket = env.ARCHIVE_BUCKET
      if (!bucketUsable(bucket)) return refuse(503, 'ARCHIVE_UNAVAILABLE')
      const importing = url.pathname === '/_thread/import' && request.method === 'POST'
      const holder = importing ? {} : null
      if (importing) {
        const at = now()
        if (slot.holder !== null && slot.until > at) {
          void request.body?.cancel().catch(() => {})
          return refuse(503, 'IMPORT_BUSY', {}, { 'retry-after': '1' })
        }
        slot.holder = holder
        slot.until = at + waits.importHoldMs
      }
      try {
        return await handleThreadRequest({ request, url,
          mirror: { call: (op, input, home) => post(THREAD_ROUTE, home === undefined ? { op, input } : { op, input, home }, THREAD_MOUNT_LIMITS.mirrorReplyBytes) },
          parts: createR2PartStore(bucket, THREAD_MOUNT_WORLD),
          rescues: vaultRescues(bucket, THREAD_MOUNT_WORLD, waits),
          limits: threadLimits(env),
          approve: card => ownerApproval(request, card, authorize, now),
          // `importStep` (pieces per import step) is a test's knob; the Worker never passes it (THREAD_IMPORT_STEP).
          ...(importStep ? { importStep } : {}),
          ...(threadDeadlines ? { deadlines: threadDeadlines } : {}) })
      } finally {
        if (importing && slot.holder === holder) { slot.holder = null; slot.until = 0 }
      }
    },
  })
}
