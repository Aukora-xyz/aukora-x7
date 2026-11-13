/**
 * Her cloud records which browser is her body. Rows in MIRROR, beside the lease (world-lease.mjs):
 *   `world:v1:holder`     `{v: 1, generation, body, reservation, done, top, proofTs?}`:
 *                         `body` null before the first claim, else `{clientId, label, key, thumb, checkpoint, sealed, since}`;
 *                         `proofTs` (job 3, MUST 2c) the highest `proof.ts` the edge accepted on a request that issues or
 *                         changes a credential (`acquire`, `renew`, `take`, `release`, `seal`, `reserve` by her body); it never
 *                         falls, also not across a move, so no such proof is ever accepted twice;
 *                         `key` is her body's INSTALLATION KEY (ECDSA P-256, raw, base64url), made non-extractable in that
 *                         browser's own IndexedDB `aukora-x6-install` and in no copy; `thumb` its SHA-256 (hex).
 *                         `reservation` null or `{descriptor, descriptorHash, at, until, lapses}` (a move waiting for the
 *                         passkey; `lapses`: how many reservations before it lapsed unapproved in a row, 0 after a commit);
 *                         `done` the last 16 committed moves `{descriptorHash, generation}`; `top` `{generation, rev}`, the
 *                         highest sealed cut. `generation` only grows; it is 0 exactly while `body` is null.
 *   `world:v1:sealed`     at most 8 `{checkpoint, clientId, label, at, generation, rev}`: copies her body proved to be one cut.
 *   `world:v1:holder-log` at most 16 moves.
 * The lease row carries `onehome: true` once any holder row was written (set in the same transaction), so the paths main
 * already runs (`status`, `acquire`, `take`, the thread index) read the holder row only when it is there.
 *
 * MUST 1 (the body is a key): with a body, every request that acts as her body (`acquire`, `renew`, `take`, `release`,
 * `seal`) and every `status` that wants `you: true` carries `proof: {ts, sig}`, an ECDSA P-256 / SHA-256 signature (IEEE
 * P1363, 64 bytes, base64url) by the body's key over `holderProofMessage(input, ts)`; `ts` within 120 s of the edge clock.
 * job 3: the message names `sid`, the public id of the signed-in session the request arrived on, which
 * the Worker alone sets (thread-mount.mjs); a proof made in another session verifies as no proof. A credential request's
 * `ts` must be greater than the row's `proofTs` (else 409 PROOF_REPLAYED, said only to a request that proved the key).
 * Verified HERE, in MIRROR, inside the lease transaction: the key that must verify it is the holder row's, read in the same
 * transaction, so no second round trip and no key cached across a move. One import and one verify: constant work.
 * MUST 2 (no approval spent on a move that cannot happen): `reserve` judges everything that can refuse and answers the exact
 * DESCRIPTOR the passkey approves; `move` carries that descriptor and commits only the live reservation it names.
 *
 * No answer here names a client id, a key or a lease id, and none carries a `conflictCode`; the one exception is `reserve`,
 * whose descriptor names the reserving browser's OWN clientId and public key (the passkey must cover them).
 */
import { TOMBSTONE_UNAVAILABLE, readTombstone, retiredReply } from './mirror-slot-tombstone.mjs'
import { THREAD_LIMITS, sha256Hex, threadCommit } from './thread-log.mjs'

export const WORLD_HOLDER = 'world:v1:holder'
export const WORLD_SEALED = 'world:v1:sealed'
export const WORLD_HOLDER_LOG = 'world:v1:holder-log'
/**
 * The lease row's marker: present (true) once a holder row was ever written. It is a CACHE: the holder row is the
 * authority. job 3: MIRROR reads the holder row once when its object starts, before it serves a request
 * (world-lease.mjs holderStartUp); with a holder row and a lease row written without the marker (by a build that knew no
 * holder), that lease is ended and the row marked again, and while the object lives `leaseAction` treats the world as held
 * even if the marker were gone. DEPLOY RULE: once she is claimed no build older than the one carrying holderStartUp may be
 * deployed (what an older build gets wrong while it runs: see HANDOFF-3).
 */
export const HOLDER_MARK = 'onehome'
// The same keys as world-home.mjs WORLD_HOME_PENDING and thread-log.mjs WORLD (not imported: world-home.mjs imports this
// module, and thread-log.mjs does not export its key).
const HOME_PENDING = 'world:v1:home-pending'
const THREAD_WORLD = 'thread:v1:world'
export const WORLD_HOLDER_LIMITS = Object.freeze({ label: 48, sealed: 8, log: 16, done: 16, indexPage: 200, reserveMs: 90000, proofSkewMs: 120000,
  reserveWaitMaxMs: 3600000, lapses: 64 })
/** The lease actions this module answers. */
export const HOLDER_ACTIONS = Object.freeze(new Set(['seal', 'reserve', 'move']))
/**
 * The lease input keys this module adds; `copy` and `sid` are the Worker's words and never come from a browser (`copy`
 * only inside a move's descriptor).
 */
export const HOLDER_INPUT_KEYS = Object.freeze(['expect', 'checkpoint', 'log', 'accept', 'copy', 'key', 'proof', 'cut', 'until', 'sid'])
/** The words a move may need, in sorted order. */
export const HOLDER_WORDS = Object.freeze(['not-newest', 'unsealed'])
/** The first line of every proof message (job 3: version 2 names the session). */
export const HOLDER_PROOF_PREFIX = 'aukora-x6-holder-proof/2'
const WORKER_FIELD = 'copy'
/** job 3 (MUST 2a): the Worker's other word, the public id of the session the request arrived on (32 hex). */
export const SESSION_FIELD = 'sid'
/**
 * job 4 review: MIRROR's words to the Worker alone, on a refusal; thread-mount.mjs removes them before any answer
 * reaches a browser. `bodyProven`: an unapproved `take` was refused only for want of the passkey, and its proof verified
 * against her body's key with an unused ts (so an approved repeat of this body can land at most once). `ownReservation`:
 * a reserve was refused MOVE_RESERVED by a live reservation that is the asker's own (same clientId and key).
 */
export const WORKER_ONLY_FIELDS = Object.freeze(['bodyProven', 'ownReservation'])
/** The actions whose input may carry `sid`: the status, and every request a proof can be on (job 4: a move too). */
const SESSION_ACTIONS = new Set(['status', 'acquire', 'renew', 'take', 'release', 'seal', 'reserve', 'move'])

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const TAB = /^[A-Za-z0-9_-]{1,64}$/
const HEX32 = /^[0-9a-f]{32}$/
const HEX64 = /^[0-9a-f]{64}$/
const KEY_TEXT = /^[A-Za-z0-9_-]{87}$/ // 65 bytes: 0x04, x, y
const SIG_TEXT = /^[A-Za-z0-9_-]{86}$/ // 64 bytes: r, s
const UNPRINTABLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u
const LATE = Symbol('late')
const encoder = new TextEncoder()

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const time = value => Number.isSafeInteger(value) && value >= 0
const has = (value, key) => Object.hasOwn(value, key)
const keysAre = (value, keys) => Object.keys(value).sort().join(',') === keys
const answer = (status, body) => ({ status, body })
const refusal = (status, code, extra = {}) => answer(status, { ok: false, code, ...extra })
const unavailable = () => refusal(503, 'HOLDER_STATE_UNAVAILABLE')

// ── Bytes and the canonical text. ─────────────────────────────────────────────────────────────────────────────

function fromBase64url(text) {
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4))
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}
const toBase64url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
// Only the one canonical spelling of 65 (key) or 64 (signature) bytes.
const canonicalBytes = (text, rule, size) => {
  if (typeof text !== 'string' || !rule.test(text)) return null
  const bytes = fromBase64url(text)
  return bytes.length === size && toBase64url(bytes) === text ? bytes : null
}
/** A raw uncompressed P-256 public key, in its one base64url spelling. */
export const holderKeyValid = text => canonicalBytes(text, KEY_TEXT, 65)?.[0] === 4

/** JSON with every object's keys sorted, no space: the text a proof and a descriptor hash are made over. */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (object(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}

/**
 * THE PROOF MESSAGE (job 3, version 2): `aukora-x6-holder-proof/2\n<ts>\n<sid>\n<canonicalJson(fields)>`, where
 * `sid` is the session's public id (status answers it) and `fields` is the request body as the browser sends it, without
 * `proof` (and without the Worker's `copy` and `sid`). It names the session, the action, clientId, tabId, label and every
 * other field, so a proof made for one request proves nothing for another session, action, tab or body.
 */
export function holderProofMessage(input, ts) {
  const fields = { ...input }
  delete fields.proof
  delete fields[WORKER_FIELD]
  delete fields[SESSION_FIELD]
  return `${HOLDER_PROOF_PREFIX}\n${ts}\n${input[SESSION_FIELD]}\n${canonicalJson(fields)}`
}

const proofShapeValid = proof => object(proof) && keysAre(proof, 'sig,ts') && time(proof.ts) && typeof proof.sig === 'string' && SIG_TEXT.test(proof.sig)
const sidValid = sid => typeof sid === 'string' && HEX32.test(sid)

/**
 * True when `proof` is a signature by `keyText` over this input's message, made within 120 s of `now`, in the session the
 * input names (`sid`, the Worker's word; none: no proof can be valid). Never throws.
 */
export async function holderProofValid(keyText, input, proof, now) {
  if (!proofShapeValid(proof) || !sidValid(input?.[SESSION_FIELD]) || Math.abs(now - proof.ts) > WORLD_HOLDER_LIMITS.proofSkewMs) return false
  const raw = canonicalBytes(keyText, KEY_TEXT, 65)
  const sig = canonicalBytes(proof.sig, SIG_TEXT, 64)
  if (!raw || raw[0] !== 4 || !sig) return false
  try {
    const key = await crypto.subtle.importKey('raw', raw, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
    return await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, sig, encoder.encode(holderProofMessage(input, proof.ts)))
  } catch {
    return false
  }
}

/** The key's thumbprint: SHA-256 of its 65 raw bytes, hex. */
export const holderThumb = keyText => sha256Hex(fromBase64url(keyText))

// ── Shapes. ───────────────────────────────────────────────────────────────────────────────────────────────────

/** 1 to 48 characters, well formed and printable (the lease's own label rule, with the holder's bound). */
export const holderLabelValid = label => typeof label === 'string' && label.isWellFormed() && !UNPRINTABLE.test(label)
  && [...label].length >= 1 && [...label].length <= WORLD_HOLDER_LIMITS.label
const checkpointValid = value => value === null || (typeof value === 'string' && HEX32.test(value))
/** A sorted list of distinct words drawn from HOLDER_WORDS; it may be empty. */
const acceptValid = accept => Array.isArray(accept) && accept.length <= HOLDER_WORDS.length
  && accept.every((word, at) => HOLDER_WORDS.includes(word) && (at === 0 || accept[at - 1] < word))
/** The Worker's word: `{verified, maker}`; an unverified copy has no maker. */
const copyValid = copy => object(copy) && keysAre(copy, 'maker,verified') && typeof copy.verified === 'boolean'
  && (copy.maker === null || (typeof copy.maker === 'string' && UUID.test(copy.maker))) && (copy.verified || copy.maker === null)
// A checkpoint carries the Worker's word; a claim (null) never does.
const wordMatches = input => (input.checkpoint === null ? !has(input, WORKER_FIELD) : copyValid(input.copy))
const cutValid = cut => object(cut) && keysAre(cut, 'rev') && time(cut.rev)
const only = (input, allowed) => HOLDER_INPUT_KEYS.every(key => allowed.includes(key) || !has(input, key))
// The fields `reserve` and `move` share.
const moveFieldsValid = input => Number.isSafeInteger(input.expect) && input.expect >= 0 && typeof input.log === 'string' && HEX64.test(input.log)
  && acceptValid(input.accept) && has(input, 'checkpoint') && checkpointValid(input.checkpoint) && holderKeyValid(input.key)

const DESCRIPTOR_KEYS = 'accept,action,checkpoint,clientId,copy,expect,key,label,log,tabId,until'
/** A move's DESCRIPTOR: exactly the keys `reserve` answers; `copy` is null for a claim, the Worker's word for a copy. */
const descriptorValid = d => object(d) && keysAre(d, DESCRIPTOR_KEYS) && d.action === 'move' && typeof d.clientId === 'string' && UUID.test(d.clientId)
  && typeof d.tabId === 'string' && TAB.test(d.tabId) && holderLabelValid(d.label) && moveFieldsValid(d) && time(d.until)
  && (d.checkpoint === null ? d.copy === null : copyValid(d.copy))

/**
 * The shape rule for the new keys, inside world-lease.mjs `validInput` (which already checked every other key).
 * `status` may carry `checkpoint` (the preview) and `proof`; `acquire`, `renew`, `take`, `release` may carry `proof`;
 * `seal` carries a 32-hex `checkpoint`, `cut` and may carry `proof`; `reserve` carries `expect`, `checkpoint`, `log`,
 * `accept`, `key` and `proof`, every one; `move` is exactly a descriptor. Any other action carries none of them.
 * @param {Record<string, unknown>} input
 */
export function holderInputValid(input) {
  const action = input.action
  if (has(input, 'proof') && !proofShapeValid(input.proof)) return false
  // job 3: `sid` (the Worker's word) only on the status and the requests a proof can be on, and only well formed.
  if (has(input, SESSION_FIELD) && !(SESSION_ACTIONS.has(action) && sidValid(input[SESSION_FIELD]))) return false
  if (['acquire', 'renew', 'take', 'release'].includes(action)) return only(input, ['proof', SESSION_FIELD])
  if (action === 'status') {
    if (!only(input, ['checkpoint', 'copy', 'proof', SESSION_FIELD])) return false
    if (!has(input, 'checkpoint')) return !has(input, WORKER_FIELD)
    return checkpointValid(input.checkpoint) && wordMatches(input)
  }
  if (!HOLDER_ACTIONS.has(action)) return only(input, [])
  if (has(input, 'leaseId') || !holderLabelValid(input.label)) return false
  if (action === 'seal') {
    return only(input, ['checkpoint', 'copy', 'cut', 'proof', SESSION_FIELD]) && typeof input.checkpoint === 'string' && HEX32.test(input.checkpoint)
      && cutValid(input.cut) && wordMatches(input)
  }
  if (action === 'reserve') {
    return only(input, ['expect', 'checkpoint', 'log', 'accept', 'copy', 'key', 'proof', SESSION_FIELD]) && has(input, 'proof') && moveFieldsValid(input) && wordMatches(input)
  }
  // job 4: a move is the descriptor exactly, and may carry the target key's `proof` (then the Worker's `sid`
  // beside it): the proof never joins the descriptor, its hash or the passkey's approval; it only decides `you`.
  if (has(input, SESSION_FIELD) && !has(input, 'proof')) return false
  return descriptorValid(descriptorOnly(input))
}
/** A move's input without the proof and the Worker's `sid`: the descriptor the passkey approves and the reservation names. */
export function descriptorOnly(input) {
  const descriptor = { ...input }
  delete descriptor.proof
  delete descriptor[SESSION_FIELD]
  return descriptor
}

const bodyValid = b => b === null || (object(b) && keysAre(b, 'checkpoint,clientId,key,label,sealed,since,thumb')
  && typeof b.clientId === 'string' && UUID.test(b.clientId) && holderLabelValid(b.label) && holderKeyValid(b.key)
  && typeof b.thumb === 'string' && HEX64.test(b.thumb) && checkpointValid(b.checkpoint) && typeof b.sealed === 'boolean'
  && (b.checkpoint !== null || b.sealed === false) && time(b.since))
const reservationValid = r => r === null || (object(r) && keysAre(r, 'at,descriptor,descriptorHash,lapses,until') && descriptorValid(r.descriptor)
  && typeof r.descriptorHash === 'string' && HEX64.test(r.descriptorHash) && time(r.at) && time(r.until) && r.descriptor.until === r.until
  && Number.isSafeInteger(r.lapses) && r.lapses >= 0 && r.lapses <= WORLD_HOLDER_LIMITS.lapses)
const doneValid = list => Array.isArray(list) && list.length <= WORLD_HOLDER_LIMITS.done
  && list.every(d => object(d) && keysAre(d, 'descriptorHash,generation') && typeof d.descriptorHash === 'string' && HEX64.test(d.descriptorHash)
    && Number.isSafeInteger(d.generation) && d.generation >= 1)
const topValid = t => t === null || (object(t) && keysAre(t, 'generation,rev') && Number.isSafeInteger(t.generation) && t.generation >= 1 && time(t.rev))
// job 3: `proofTs` is absent until the first credential proof is accepted (rows written before it read as before).
const holderRowValid = row => object(row) && (has(row, 'proofTs') ? keysAre(row, 'body,done,generation,proofTs,reservation,top,v') && time(row.proofTs)
  : keysAre(row, 'body,done,generation,reservation,top,v')) && row.v === 1
  && Number.isSafeInteger(row.generation) && row.generation >= 0 && (row.body === null) === (row.generation === 0)
  && bodyValid(row.body) && reservationValid(row.reservation) && doneValid(row.done) && topValid(row.top)
const EMPTY_ROW = Object.freeze({ v: 1, generation: 0, body: null, reservation: null, done: [], top: null })
const sealedEntryValid = entry => object(entry) && keysAre(entry, 'at,checkpoint,clientId,generation,label,rev')
  && typeof entry.checkpoint === 'string' && HEX32.test(entry.checkpoint) && typeof entry.clientId === 'string' && UUID.test(entry.clientId)
  && holderLabelValid(entry.label) && time(entry.at) && Number.isSafeInteger(entry.generation) && entry.generation >= 1 && time(entry.rev)
const sealedRowValid = list => Array.isArray(list) && list.length <= WORLD_HOLDER_LIMITS.sealed && list.every(sealedEntryValid)
  && new Set(list.map(entry => entry.checkpoint)).size === list.length
const logRowValid = list => Array.isArray(list) && list.length <= WORLD_HOLDER_LIMITS.log && list.every(object)
// world-home.mjs validPending, as that module reads the row.
const pendingValid = row => object(row) && typeof row.rescue === 'string' && HEX32.test(row.rescue) && typeof row.clientId === 'string'
  && UUID.test(row.clientId) && time(row.since) && time(row.verifiedAt)

async function readHolder(tx) {
  const row = await tx.get(WORLD_HOLDER)
  if (row === undefined) return { row: null, corrupt: false }
  return holderRowValid(row) ? { row, corrupt: false } : { row: null, corrupt: true }
}

async function readSealed(tx) {
  const list = await tx.get(WORLD_SEALED)
  if (list === undefined) return { list: [], corrupt: false }
  return sealedRowValid(list) ? { list, corrupt: false } : { list: [], corrupt: true }
}

/** The pending home as the needs list reads it: null (no row), `{unreadable: true}`, or `{clientId}`. */
async function readPending(tx) {
  const row = await tx.get(HOME_PENDING)
  if (row === undefined) return null
  return pendingValid(row) ? { clientId: row.clientId } : { unreadable: true }
}

const liveReservation = (row, now) => (row?.reservation && row.reservation.until > now ? row.reservation : null)
/**
 * Review (SHOULD): reserve needs no passkey, so a reservation that lapses unapproved makes the next reserve wait, and the
 * wait doubles with each lapse in a row: none after the first, then 90 s, 180 s, 360 s ... at most 1 h. A commit sets the
 * reservation to null, so the count starts again. Her body's leases are granted in every wait. Null: a reserve may be made.
 */
function reserveBlock(row, at) {
  const r = row?.reservation
  if (!r) return null
  if (r.until > at) return { age: at - r.at }
  const lapses = r.lapses + 1
  const free = r.until + (lapses < 2 ? 0 : Math.min(WORLD_HOLDER_LIMITS.reserveMs * 2 ** (lapses - 2), WORLD_HOLDER_LIMITS.reserveWaitMaxMs))
  return at < free ? { age: at - r.at, wait: free - at } : null
}
/** The holder as a refusal shows it: no client id, no key. */
const publicHolder = row => ({ label: row.body.label, since: row.body.since, generation: row.generation })
const shownHolder = (row, you) => ({ label: row.body.label, generation: row.generation, since: row.body.since, checkpoint: row.body.checkpoint, sealed: row.body.sealed, you })
/** Her body speaking: the body's clientId and a valid proof by its key. The clientId alone grants nothing. */
const proven = async (row, input, now) => Boolean(row?.body) && row.body.clientId === input.clientId && has(input, 'proof')
  && holderProofValid(row.body.key, input, input.proof, now)
/**
 * job 3 (MUST 2c): a credential request's proof, already proven, is used ONCE: its `ts` must be greater than the
 * highest accepted (`proofTs`), else 409 PROOF_REPLAYED {after} (said only to a request that proved the key). With
 * `advance`, the row's `proofTs` becomes this `ts` in this transaction (the caller's open one). Answers `{refusal}` or
 * `{row}` (the row as now staged).
 */
async function spendProof(tx, row, input, advance) {
  if (has(row, 'proofTs') && input.proof.ts <= row.proofTs) return { refusal: refusal(409, 'PROOF_REPLAYED', { after: row.proofTs }) }
  if (!advance) return { row }
  const next = { ...row, proofTs: input.proof.ts }
  await tx.put(WORLD_HOLDER, next)
  return { row: next }
}

/** The newest sealed entry, by (generation, rev), never by the order of seal calls (ties: the later seal). */
const newestSealed = list => list.reduce((best, entry) => (!best || entry.generation > best.generation
  || (entry.generation === best.generation && entry.rev >= best.rev) ? entry : best), null)

/**
 * THE NEEDS LIST, one pure function for `status` and `reserve`: a sorted list drawn from `not-newest`, `unsealed`.
 * @param {{ holder: {clientId: string}|null, sealed: {checkpoint: string, generation: number, rev: number}[],
 *   pending: null|{unreadable: true}|{clientId: string}, checkpoint: string|null, maker: string|null }} facts `maker`: the
 *   copy's own client id for a checkpoint; for a claim the holder's clientId when her body itself asks (proven), null when
 *   another browser asks while a body exists, the caller's clientId when no body exists.
 * @returns {string[]}
 */
export function needsList({ holder, sealed, pending, checkpoint, maker }) {
  const words = []
  const newest = newestSealed(sealed)
  const notNewest = (holder !== null && maker !== holder.clientId)
    || (checkpoint !== null && newest !== null && newest.checkpoint !== checkpoint)
    || (holder === null && pending !== null && (pending.unreadable === true || pending.clientId !== maker))
  if (notNewest) words.push('not-newest')
  if (checkpoint !== null && !sealed.some(entry => entry.checkpoint === checkpoint)) words.push('unsealed')
  return words
}

// ── The log mark. ─────────────────────────────────────────────────────────────────────────────────────────────

/** THE LOG MARK over a list of thread summaries (`{id, bytes, chain, tailSha}`), in id order. */
export async function logMarkOf(threads) {
  const sorted = [...threads].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const text = sorted.map(t => `${t.id}:${t.bytes}:${t.chain}.${t.tailSha}\n`).join('')
  return sha256Hex(encoder.encode(text))
}

const summaryValid = t => object(t) && typeof t.id === 'string' && HEX64.test(t.id) && time(t.bytes)
  && typeof t.chain === 'string' && HEX64.test(t.chain) && typeof t.tailSha === 'string' && HEX64.test(t.tailSha)

/**
 * MUST 5: the most index pages the mark reads. The thread log admits a new thread only while its own count
 * (`thread:v1:world`.threads) stays within THREAD_MAX (thread-log.mjs opAppend/opImport), and that count is exact: so
 * `ceil(max(count, THREAD_LIMITS.threads) / 200) + 1` pages cover every thread the log ever accepted, whatever THREAD_MAX
 * says, and the default's 2,048 even when the count row is unreadable.
 */
export const logMarkPages = threads => Math.ceil(Math.max(time(threads) ? threads : 0, THREAD_LIMITS.threads) / WORLD_HOLDER_LIMITS.indexPage) + 1

/** THE LOG MARK of the threads in this transaction, page by page through the thread log's index op; null if unreadable. */
export async function logMark(tx) {
  const counted = await tx.get(THREAD_WORLD)
  const pages = logMarkPages(object(counted) ? counted.threads : 0)
  const threads = []
  let after = ''
  for (let page = 0; page < pages; page++) {
    const read = await threadCommit(tx, 'index', { after, limit: WORLD_HOLDER_LIMITS.indexPage })
    if (read?.status !== 200 || !Array.isArray(read.body?.threads) || !read.body.threads.every(summaryValid)) return null
    threads.push(...read.body.threads)
    if (read.body.next === null) return logMarkOf(threads)
    if (typeof read.body.next !== 'string' || read.body.next <= after) return null
    after = read.body.next
  }
  return null
}

// ── seal, reserve, move. ──────────────────────────────────────────────────────────────────────────────────────

/** Holder, sealed list and (with no body) the pending row: what `reserve` and the preview judge. */
async function moveState(tx) {
  const holder = await readHolder(tx)
  if (holder.corrupt) return { unavailable: true }
  const sealed = await readSealed(tx)
  if (sealed.corrupt) return { unavailable: true }
  return { row: holder.row, holder: holder.row?.body ?? null, sealed: sealed.list, pending: holder.row?.body ? null : await readPending(tx) }
}

/** For a claim: the holder's id when her body asks, null when another browser asks while a body exists, else the caller. */
const claimMaker = (body, input, self) => (body ? (self ? body.clientId : null) : input.clientId)

/** The lease row set free, its generation kept (as `release` writes it), marked. */
const freeLease = (leased, at) => ({ leaseId: null, generation: leased.row?.generation ?? 0, holder: null, acquiredAt: null, seenAt: at, expiresAt: at, asked: null, [HOLDER_MARK]: true })

async function seal(tx, input, now) {
  if (input.copy.verified !== true) return refusal(409, 'CHECKPOINT_NOT_VERIFIED')
  if (input.copy.maker !== input.clientId) return refusal(409, 'CHECKPOINT_NOT_YOURS')
  const holder = await readHolder(tx)
  if (holder.corrupt) return unavailable()
  if (!holder.row?.body) return refusal(409, 'NO_HOLDER')
  const at = now()
  if (!(await proven(holder.row, input, at))) return refusal(423, 'HOLDER_ELSEWHERE', { holder: publicHolder(holder.row) })
  // job 3 (MUST 2c): a replayed proof is refused here; an accepted seal (new or `already`) uses it up in the same
  // transaction. A refused seal writes nothing.
  const fresh = await spendProof(tx, holder.row, input, false)
  if (fresh.refusal) return fresh.refusal
  const row = holder.row
  const reserved = liveReservation(row, at)
  if (reserved) return refusal(409, 'MOVE_RESERVED', { age: at - reserved.at })
  const sealed = await readSealed(tx)
  if (sealed.corrupt) return unavailable()
  if (sealed.list.some(entry => entry.checkpoint === input.checkpoint)) {
    await spendProof(tx, row, input, true)
    return answer(200, { ok: true, sealed: true, already: true })
  }
  // MUST 3: within this body's generation a seal never goes back to an older cut.
  const top = row.top?.generation === row.generation ? row.top.rev : null
  if (top !== null && input.cut.rev < top) return refusal(409, 'SEAL_OLDER_THAN_NEWEST', { rev: input.cut.rev, newest: top })
  const entry = { checkpoint: input.checkpoint, clientId: input.clientId, label: input.label, at, generation: row.generation, rev: input.cut.rev }
  await tx.put(WORLD_SEALED, [...sealed.list, entry].slice(-WORLD_HOLDER_LIMITS.sealed))
  await tx.put(WORLD_HOLDER, { ...row, top: { generation: row.generation, rev: input.cut.rev }, proofTs: input.proof.ts })
  return answer(200, { ok: true, sealed: true, already: false })
}

/**
 * A browser whose slot was retired (or that reads again) can never take the lease (world-lease.mjs answers it by name
 * first), so it is never named her body: the lease's own named answer, or 503 for a malformed tombstone. Null: none.
 */
async function retiredRefusal(tx, clientId) {
  const slot = await readTombstone(tx, clientId)
  if (!slot) return null
  if (slot.corrupt) return refusal(503, TOMBSTONE_UNAVAILABLE.code)
  const { status, ...body } = retiredReply(slot, 'lease')
  return answer(status, body)
}

/** The descriptor `reserve` answers and the passkey approves, and its hash (SHA-256 of its canonical text). */
const descriptorOf = (input, until) => ({ action: 'move', clientId: input.clientId, tabId: input.tabId, label: input.label, expect: input.expect,
  checkpoint: input.checkpoint, log: input.log, accept: [...input.accept], key: input.key,
  copy: input.checkpoint === null ? null : { verified: input.copy.verified, maker: input.copy.maker }, until })
export const descriptorHash = descriptor => sha256Hex(encoder.encode(canonicalJson(descriptor)))

async function reserve(tx, input, now, lease, ownerApproved) {
  // Review (SHOULD): the edge's clock is in the refusal, so a browser whose clock is off can sign again with it (and
  // the session id its proof must name).
  const asked = now()
  if (!(await holderProofValid(input.key, input, input.proof, asked))) return refusal(403, 'KEY_PROOF_INVALID', { now: asked, sid: input[SESSION_FIELD] ?? null })
  const retired = await retiredRefusal(tx, input.clientId)
  if (retired) return retired
  const state = await moveState(tx)
  if (state.unavailable) return unavailable()
  // job 3 (MUST 2c): a reserve by her body (its own key) is a credential request: its proof is used once.
  const byBody = Boolean(state.holder) && state.holder.clientId === input.clientId && state.holder.key === input.key
  if (byBody) {
    const fresh = await spendProof(tx, state.row, input, false)
    if (fresh.refusal) return fresh.refusal
  }
  const log = await tx.get(WORLD_HOLDER_LOG)
  if (log !== undefined && !logRowValid(log)) return unavailable()
  const leased = await lease.read()
  if (leased.corrupt) return refusal(503, 'LEASE_STATE_UNAVAILABLE')
  const at = now()
  const generation = state.row?.generation ?? 0
  if (input.expect !== generation) return refusal(409, 'HOLDER_MOVED', { generation })
  if (input.checkpoint !== null && input.copy.verified !== true) return refusal(409, 'CHECKPOINT_NOT_VERIFIED')
  const mark = await logMark(tx)
  if (mark === null) return refusal(503, 'LOG_MARK_UNAVAILABLE')
  if (input.log !== mark) return refusal(409, 'LOG_MOVED')
  const maker = input.checkpoint === null ? claimMaker(state.holder, input, byBody) : input.copy.maker
  const needs = needsList({ holder: state.holder, sealed: state.sealed, pending: state.pending, checkpoint: input.checkpoint, maker })
  if (needs.join(',') !== input.accept.join(',')) return refusal(409, 'MOVE_NEEDS', { needs })
  // job 3: a reserve the owner's passkey approved (over this exact body) is never blocked: it replaces a
  // live reservation and ignores the back-off, so his recovery always wins. An unapproved reserve keeps the growing wait.
  // Review: judged LAST, so an unapproved reserve answers MOVE_RESERVED only when everything else passes; the
  // Worker asks the passkey only on that answer (thread-mount.mjs), so no approval is spent on a reserve refused anyway.
  const blocked = ownerApproved === true ? null : reserveBlock(state.row, at)
  if (blocked) {
    // job 4 review (SHOULD): the Worker re-sends a spent override only to renew the asker's OWN live reservation.
    const live = liveReservation(state.row, at)
    const own = Boolean(live) && live.descriptor.clientId === input.clientId && live.descriptor.key === input.key
    return refusal(409, 'MOVE_RESERVED', { ...blocked, ...(own ? { ownReservation: true } : {}) })
  }
  const until = at + WORLD_HOLDER_LIMITS.reserveMs
  const descriptor = descriptorOf(input, until)
  const hash = await descriptorHash(descriptor)
  // Any lease ends now: while the reservation lives no lease is granted, so no thread commit lands and the log cannot move.
  await tx.put(lease.key, freeLease(leased, at))
  // A reservation is still in the row only when it lapsed unapproved (a commit sets it to null): count it. One the owner's
  // approved reserve replaces while it lives did not lapse: its count is kept, not grown.
  const previous = state.row?.reservation
  const lapses = !previous ? 0 : previous.until > at ? previous.lapses : Math.min(previous.lapses + 1, WORLD_HOLDER_LIMITS.lapses)
  await tx.put(WORLD_HOLDER, { ...(state.row ?? EMPTY_ROW), ...(byBody ? { proofTs: input.proof.ts } : {}), reservation: { descriptor, descriptorHash: hash, at, until, lapses } })
  return answer(200, { ok: true, reserved: true, descriptor, descriptorHash: hash, until })
}

async function move(tx, input, now, ownerApproved, lease) {
  const hash = await descriptorHash(descriptorOnly(input)) // job 4: the proof is not part of it
  const holder = await readHolder(tx)
  if (holder.corrupt) return unavailable()
  const row = holder.row
  const at = now()
  const reserved = liveReservation(row, at)
  if (reserved && reserved.descriptorHash === hash) {
    // The Worker asks the passkey only after this answer (thread-mount.mjs routeLease): nothing is spent before it.
    if (ownerApproved !== true) return refusal(403, 'CLASS3_WEBAUTHN_REQUIRED')
    return commit(tx, row, reserved, at, lease, input)
  }
  const done = row?.done.find(entry => entry.descriptorHash === hash)
  if (done) return answer(200, { ok: true, already: true, moved: true, generation: done.generation })
  // job 3: `moved: false` only when the edge KNOWS this descriptor never applied: it can apply only as the
  // move from generation `expect` to `expect + 1`, and the generation only grows. So it did not apply when the generation is
  // still at most `expect`, or when the kept outcomes (the last 16) name another descriptor for `expect + 1`. Otherwise its
  // outcome may have been pushed out of those 16: 409 MOVE_OUTCOME_FORGOTTEN, `moved: "unknown"`, with who holds her now.
  const known = (row?.generation ?? 0) <= input.expect || row.done.some(entry => entry.generation === input.expect + 1)
  if (!known) return refusal(409, 'MOVE_OUTCOME_FORGOTTEN', { moved: 'unknown', holder: publicHolder(row) })
  if (ownerApproved === true) return refusal(409, 'MOVE_APPROVAL_SPENT', { moved: false, next: 'reserve and approve again' })
  return refusal(409, 'MOVE_NOT_RESERVED', { moved: false, next: 'reserve' })
}

/**
 * The one transaction after the passkey: generation, holder row, lease, log. Seals are untouched.
 * job 4: the answer's `you` comes ONLY from an installation proof in this same request that verifies against
 * the new holder row (the descriptor's key, in this request's session): a commit sent without one (or with one that does
 * not verify) answers the holder's public summary with `you` ABSENT. The reservation, not the sender, decides the move (it
 * is the owner's approval of that descriptor); who is told "this is you" is the key's own browser, by its signed status.
 */
async function commit(tx, row, reserved, at, lease, input) {
  const d = reserved.descriptor
  const sealed = await readSealed(tx)
  if (sealed.corrupt) return unavailable()
  const log = await tx.get(WORLD_HOLDER_LOG)
  if (log !== undefined && !logRowValid(log)) return unavailable()
  const leased = await lease.read()
  if (leased.corrupt) return refusal(503, 'LEASE_STATE_UNAVAILABLE')
  const generation = d.expect + 1
  const body = { clientId: d.clientId, label: d.label, key: d.key, thumb: await holderThumb(d.key), checkpoint: d.checkpoint,
    sealed: d.checkpoint !== null && sealed.list.some(entry => entry.checkpoint === d.checkpoint), since: at }
  const next = { v: 1, generation, body, reservation: null,
    done: [...row.done, { descriptorHash: reserved.descriptorHash, generation }].slice(-WORLD_HOLDER_LIMITS.done), top: row.top,
    ...(has(row, 'proofTs') ? { proofTs: row.proofTs } : {}) } // job 3: the highest accepted proof ts never falls
  await tx.put(WORLD_HOLDER, next)
  if (leased.row?.holder || !leased.row?.[HOLDER_MARK]) await tx.put(lease.key, freeLease(leased, at))
  const line = { at, generation, descriptorHash: reserved.descriptorHash,
    from: row.body ? { clientId: row.body.clientId, label: row.body.label, generation: row.generation } : null,
    to: { clientId: d.clientId, tabId: d.tabId, label: d.label, thumb: body.thumb }, checkpoint: d.checkpoint, accept: [...d.accept] }
  await tx.put(WORLD_HOLDER_LOG, [...(log ?? []), line].slice(-WORLD_HOLDER_LIMITS.log))
  const you = has(input, 'proof') && await holderProofValid(d.key, input, input.proof, at) // job 4
  const { you: _unproven, ...shown } = shownHolder(next, true)
  return answer(200, { ok: true, holder: you ? shownHolder(next, true) : shown })
}

/**
 * `seal`, `reserve` and `move`, inside world-lease.mjs `leaseAction`'s transaction (the input already passed `validInput`).
 * @param {object} tx The open transaction.
 * @param {object} input The lease input.
 * @param {{ now: () => number, ownerApproved: boolean, lease: { key: string, read: () => Promise<{row: any, corrupt: boolean}> } }} options
 * @returns {Promise<{status: number, body: object}>}
 */
export async function holderAction(tx, input, { now, ownerApproved, lease }) {
  if (input.action === 'seal') return seal(tx, input, now)
  if (input.action === 'reserve') return reserve(tx, input, now, lease, ownerApproved)
  return move(tx, input, now, ownerApproved, lease)
}

// ── The paths main already runs. ──────────────────────────────────────────────────────────────────────────────

/**
 * world-lease.mjs, for `acquire`, `renew`, `take` and `release`, called ONLY when the lease row carries the marker.
 * Answers `{refusal}`, `{holder: true}` (her body proved its key: the holder is the one allowed browser, MUST 4) or
 * `{holder: false}` (no body: nothing asks for a proof). While a move is reserved no lease is granted (423 MOVE_RESERVED).
 * Without a valid proof from her body: 423 HOLDER_ELSEWHERE, the same answer for any other browser and for a browser that
 * only typed her id. An unreadable holder row (or, for acquire and take, sealed row) is 503.
 * job 3 (MUST 2c): her body's proof is used once: a `ts` not greater than the highest accepted is 409
 * PROOF_REPLAYED; with `advance` (every gated action except a `take` the passkey has not yet approved, which the Worker
 * sends first as a preflight) the highest accepted becomes this `ts`, in this transaction.
 */
export async function holderGate(tx, input, now, { advance = true } = {}) {
  const holder = await readHolder(tx)
  if (holder.corrupt) return { refusal: unavailable() }
  const row = holder.row
  if (!row) return { holder: false }
  const granting = input.action === 'acquire' || input.action === 'take'
  if (granting && row.body && (await readSealed(tx)).corrupt) return { refusal: unavailable() }
  const reserved = liveReservation(row, now)
  if (reserved && granting) return { refusal: refusal(423, 'MOVE_RESERVED', { age: now - reserved.at }) }
  if (!row.body) return { holder: false }
  if (!(await proven(row, input, now))) return { refusal: refusal(423, 'HOLDER_ELSEWHERE', { holder: publicHolder(row) }) }
  const spent = await spendProof(tx, row, input, advance)
  return spent.refusal ? { refusal: spent.refusal } : { holder: true }
}

/**
 * The `status` answer: `base` (world-lease.mjs's answer) unchanged, with no read, while the lease row has no marker and the
 * request carries no `checkpoint`. Otherwise `now` (the edge's clock, for `proof.ts`) and `sid` (job 3: the public
 * id of this request's session, which its proofs name; null when the Worker gave none); with a body: `holder` (`you` only
 * with a valid proof) and `sealed`; with a live reservation: `reserved: {until, age}`. With `checkpoint` (THE PREVIEW): `move: {expect, needs, log}`, `move: {refused}`, or in a reservation or
 * its back-off `move: {refused: 'MOVE_RESERVED', wait?, expect, needs, log}`.
 */
export async function holderStatus(tx, input, base, { marked, now }) {
  const preview = has(input, 'checkpoint')
  if (!marked && !preview) return base
  const holder = await readHolder(tx)
  if (!preview && !holder.corrupt && !holder.row) return base
  const row = holder.row
  const sealed = holder.corrupt ? { list: [], corrupt: false } : await readSealed(tx)
  const broken = holder.corrupt || sealed.corrupt
  const self = !broken && await proven(row, input, now)
  // Review (SHOULD): `now` is the edge's clock, so a browser whose own clock is off signs its proofs with this one.
  // job 3 (MUST 2a): `sid`, the public id of the session this request arrived on, which every proof names.
  let out = { ...base, now, sid: input[SESSION_FIELD] ?? null }
  if (broken) out = { ...out, holder: { unavailable: true } }
  else if (row?.body) {
    out = { ...out, holder: shownHolder(row, self),
      sealed: sealed.list.map(entry => ({ checkpoint: entry.checkpoint, label: entry.label, at: entry.at, generation: entry.generation, rev: entry.rev,
        yours: self && entry.clientId === input.clientId, byHolder: entry.clientId === row.body.clientId })) }
  }
  const reserved = broken ? null : liveReservation(row, now)
  if (reserved) out = { ...out, reserved: { until: reserved.until, age: now - reserved.at } }
  if (!preview) return out
  // A browser that reads again after retirement may still ask the status; the card says first, as `reserve` would, that it
  // cannot be her body.
  const retired = await retiredRefusal(tx, input.clientId)
  if (retired) return { ...out, move: { refused: retired.body.code } }
  if (broken) return { ...out, move: { refused: 'HOLDER_STATE_UNAVAILABLE' } }
  if (input.checkpoint !== null && input.copy.verified !== true) return { ...out, move: { refused: 'CHECKPOINT_NOT_VERIFIED' } }
  const body = row?.body ?? null
  const pending = body ? null : await readPending(tx)
  const mark = await logMark(tx)
  if (mark === null) return { ...out, move: { refused: 'LOG_MARK_UNAVAILABLE' } }
  const maker = input.checkpoint === null ? claimMaker(body, input, self) : input.copy.maker
  const needs = needsList({ holder: body, sealed: sealed.list, pending, checkpoint: input.checkpoint, maker })
  const demand = { expect: row?.generation ?? 0, needs, log: mark }
  // Review: in a reservation or its back-off the preview still names what a reserve must carry, beside the
  // refusal, so the owner's approved reserve (never blocked) can be made right the first time.
  const blocked = reserveBlock(row, now)
  if (blocked) return { ...out, move: { refused: 'MOVE_RESERVED', ...(blocked.wait ? { wait: blocked.wait } : {}), ...demand } }
  return { ...out, move: demand }
}

// SHOULD 1: the thread index reads the lease row (world-lease.mjs leaseSummary) before the home summary in the same
// transaction; the marker it saw decides whether the holder row is read at all.
const leaseMarks = new WeakMap()
/**
 * world-lease.mjs leaseSummary: note the marker of the lease row read in this transaction, as stored: job 3
 * also a row whose fields are invalid tells whether it carries the marker (a marked one still has the holder
 * read; an unmarked one costs main's operations). `undefined`: not known.
 */
export function noteLeaseRow(tx, row) {
  if (object(tx) && row !== undefined) leaseMarks.set(tx, object(row) && row[HOLDER_MARK] === true)
}

/** The thread index's `home.holder`: null with no body (nothing is added), `{label, generation, since}`, or `{unavailable: true}`. */
export async function holderSummary(tx) {
  if (leaseMarks.get(tx) === false) return null
  const holder = await readHolder(tx)
  if (holder.corrupt) return { unavailable: true }
  return holder.row?.body ? { label: holder.row.body.label, generation: holder.row.generation, since: holder.row.body.since } : null
}

/**
 * MUST 4 (mirror-client-slots.mjs): the client ids slot retirement must spare, her body's and a reserved target's; null
 * when the holder row cannot be read (then nothing is retired).
 */
export async function holderSparedIds(tx) {
  const holder = await readHolder(tx)
  if (holder.corrupt) return null
  return [holder.row?.body?.clientId, holder.row?.reservation?.descriptor.clientId].filter(id => typeof id === 'string')
}

// ── The Worker's half. ────────────────────────────────────────────────────────────────────────────────────────

async function readCopy(rescues, id, ms) {
  if (!rescues || typeof rescues.get !== 'function') return { unavailable: true }
  let timer
  const late = new Promise(resolve => { timer = setTimeout(() => resolve(LATE), ms) })
  try {
    const found = await Promise.race([Promise.resolve().then(() => rescues.get(id)), late])
    if (found === LATE || found?.unavailable === true) return { unavailable: true }
    if (!object(found)) return { verified: false, maker: null }
    const maker = found.index?.client?.clientId
    return { verified: true, maker: typeof maker === 'string' && UUID.test(maker) ? maker : null }
  } catch {
    return { unavailable: true }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * The Worker's word (thread-mount.mjs routeLease), before the size check and before the passkey is asked.
 * A browser body naming `sid` (job 3), or the Worker's `copy`, is refused 400; a `move`'s descriptor carries the `copy` `reserve`
 * answered (its hash binds it: a changed word names no reservation). `seal`, `reserve` and a status with a 32-hex
 * `checkpoint` read that copy from the vault (verified only: `rescues.get`, raced with `ms`): unreadable is 503; for `seal`
 * a copy that is not verified is 409 CHECKPOINT_NOT_VERIFIED and one made by another browser 409 CHECKPOINT_NOT_YOURS, so
 * it never reaches MIRROR. Otherwise `copy` is the word to set on the forwarded input. Anything else: `{}` (nothing read).
 * @param {Record<string, unknown>} body The browser's body as parsed.
 * @param {Record<string, unknown>} input The input to forward.
 * @param {{get: (id: string) => Promise<any>}|null} rescues The mount's verified-rescue reader.
 * @param {number} ms The R2 deadline.
 * @returns {Promise<{refusal?: {status: number, code: string}, copy?: {verified: boolean, maker: string|null}}>}
 */
export async function holderWord(body, input, rescues, ms) {
  const action = input.action
  // job 3: `sid` is the Worker's word on every action (a move's descriptor never carries it).
  if (has(body, SESSION_FIELD)) return { refusal: { status: 400, code: 'LEASE_REQUEST_INVALID' } }
  if (action === 'move') return {}
  if (has(body, WORKER_FIELD)) return { refusal: { status: 400, code: 'LEASE_REQUEST_INVALID' } }
  if (action !== 'seal' && action !== 'reserve' && !(action === 'status' && has(input, 'checkpoint'))) return {}
  if (typeof input.checkpoint !== 'string' || !HEX32.test(input.checkpoint)) return {}
  const copy = await readCopy(rescues, input.checkpoint, ms)
  if (copy.unavailable) return { refusal: { status: 503, code: 'CHECKPOINT_UNAVAILABLE' } }
  if (action === 'seal' && !copy.verified) return { refusal: { status: 409, code: 'CHECKPOINT_NOT_VERIFIED' } }
  if (action === 'seal' && copy.maker !== input.clientId) return { refusal: { status: 409, code: 'CHECKPOINT_NOT_YOURS' } }
  return { copy: { verified: copy.verified, maker: copy.maker } }
}
