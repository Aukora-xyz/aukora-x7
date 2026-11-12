/**
 * NOSTR HEAD ANNOUNCEMENT: one NIP-01 event, signed by her node key, saying "her head is ball B at epoch N, and her
 * receipts chain ends at leaf H". Anyone can fetch it over HTTPS and check the signature with any Nostr tool.
 *
 * What this is NOT: this is not a relay (no REQ, no EVENT intake, no socket), nothing here talks to the Nostr network,
 * and it does not prove the owner approved the epoch (the Nostr key, the checkpoint key and the owner key are three
 * different keys). Kind 30078 is NIP-78 application data (addressable by its `d` tag); NIP-05 only maps a name to a key.
 *
 * Four doors:
 *  - GET /_head/nostr/anchor (owner session, same refusals as the POST): the four facts a publication is checked against,
 *    read by the same code the POST is checked with (`readHeadAnchorFacts`). Signs nothing, writes nothing, consumes no
 *    approval; the page builds the organ's event from them and asks the passkey for exactly that event.
 *  - POST /_head/nostr/anchor (owner session + Class 3 passkey approval bound to the exact body). The page sends the
 *    exact UNSIGNED event the mounted organ `seed-nostr-anchor` builds (checkpointTags). HEAD re-derives everything
 *    itself and refuses on any mismatch, never guesses: head id and epoch against the selected HEAD, pubkey against the
 *    stored node key, the receipts leaf against the last leaf of the chain the mirror has verified, every tag
 *    against the canonical content, created_at within 600 s of the edge clock. Only then is the approval consumed, the
 *    event signed through messages-store.mjs (the node's one signing path), re-verified, and stored as the single key
 *    `nostr:anchor:latest`. Latest only, no history. One fingerprint per publication.
 *  - GET /api/nostr/head and GET /.well-known/nostr.json?name=auma: signed out, read-only, answered by the Worker from
 *    a 60 s in-isolate cache (so a flood costs at most one durable read per isolate per minute while reads settle; while
 *    they do not, at most one new read per `shareWaitMs`: see createNostrReadDoor), shielded per network on cache
 *    misses. Nothing is served before a first publication.
 * Nothing else about her leaves: never the secret key, messages, contacts, receipt rows, organ names or approval ids.
 */
import { canonicalJson } from './owner-grant-policy.mjs'
import { readMessagesIdentityInTransaction, signNodeEventInTransaction, verifyNostrEvent } from './messages-store.mjs'
import { createSharedCalls, SHARED_CALL_BUSY, SHARED_CALL_MAX_WAITS, SHARED_CALL_WAIT_MS } from './shared-call.mjs'

export const NOSTR_ANCHOR_ROUTE = '/_head/nostr/anchor'
/** HEAD-internal read for the Worker's signed-out door; the Worker never forwards a caller to it. */
export const NOSTR_ANCHOR_LATEST_PATH = '/_head/nostr/latest'
export const NOSTR_HEAD_ROUTE = '/api/nostr/head'
export const NOSTR_NIP05_ROUTE = '/.well-known/nostr.json'
export const NOSTR_NIP05_NAME = 'auma'
export const NOSTR_PUBLIC_ROUTES = Object.freeze(new Set([NOSTR_HEAD_ROUTE, NOSTR_NIP05_ROUTE]))
export const NOSTR_ANCHOR_KEY = 'nostr:anchor:latest'
export const NOSTR_ANCHOR_KIND = 30078
export const NOSTR_ANCHOR_SCHEMA = 'aukora.nostr.head.v1'
export const NOSTR_ANCHOR_LIMITS = Object.freeze({
  requestBytes: 4096, storedBytes: 4096, contentBytes: 1024, clockSkewSeconds: 600, cacheMs: 60000, readTimeoutMs: 10000,
  // The mirror's receipts-head answer (no journal bytes in it), bounded as HEAD bounds Aura's (EDGE_AURA_LIMITS.responseBytes).
  receiptsResponseBytes: 128 * 1024,
})

const HEX = /^[0-9a-f]{64}$/
const encoder = new TextEncoder()
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const exactKeys = (value, keys) => isRecord(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
const refuse = (code, status = 400) => { throw Object.assign(new Error(code), { code, status }) }

/** The exact content the organ signs over: these five fields, canonical JSON, nothing else (organ checkpointContent). */
export function anchorContent({ headBallId, epoch, receiptsLeafHash, nodePubkeyHex }) {
  return canonicalJson({ schema: NOSTR_ANCHOR_SCHEMA, headBallId, epoch, receiptsLeafHash, nodePubkeyHex })
}

/** The organ's tag set, in its order (organ checkpointTags). `d` makes it addressable: one live head per pubkey. */
export function anchorTags({ headBallId, epoch, receiptsLeafHash, nodePubkeyHex }) {
  return [['d', 'aukora-head:' + nodePubkeyHex], ['epoch', String(epoch)], ['head', headBallId], ['receipts', receiptsLeafHash], ['schema', NOSTR_ANCHOR_SCHEMA]]
}

/**
 * Check an unsigned (or signed) announcement against itself: kind, pubkey, canonical content, and every tag
 * re-derived from that content. Returns the four bound fields plus created_at, or throws a NOSTR_ANCHOR_* refusal.
 */
export function parseAnchorEvent(event, { signed = false } = {}) {
  const keys = signed ? ['id', 'pubkey', 'created_at', 'kind', 'tags', 'content', 'sig'] : ['pubkey', 'created_at', 'kind', 'tags', 'content']
  if (!exactKeys(event, keys)) refuse('NOSTR_ANCHOR_EVENT_INVALID')
  if (event.kind !== NOSTR_ANCHOR_KIND) refuse('NOSTR_ANCHOR_KIND_INVALID')
  if (typeof event.pubkey !== 'string' || !HEX.test(event.pubkey)) refuse('NOSTR_ANCHOR_EVENT_INVALID')
  if (!Number.isSafeInteger(event.created_at) || event.created_at < 0) refuse('NOSTR_ANCHOR_EVENT_INVALID')
  if (typeof event.content !== 'string' || encoder.encode(event.content).byteLength > NOSTR_ANCHOR_LIMITS.contentBytes) refuse('NOSTR_ANCHOR_EVENT_INVALID')
  let content
  try { content = JSON.parse(event.content) } catch (_error) { refuse('NOSTR_ANCHOR_CONTENT_INVALID') }
  if (!exactKeys(content, ['epoch', 'headBallId', 'nodePubkeyHex', 'receiptsLeafHash', 'schema']) || content.schema !== NOSTR_ANCHOR_SCHEMA
    || !Number.isSafeInteger(content.epoch) || content.epoch < 0 || ![content.headBallId, content.nodePubkeyHex, content.receiptsLeafHash].every(value => typeof value === 'string' && HEX.test(value))) {
    refuse('NOSTR_ANCHOR_CONTENT_INVALID')
  }
  const fields = { headBallId: content.headBallId, epoch: content.epoch, receiptsLeafHash: content.receiptsLeafHash, nodePubkeyHex: content.nodePubkeyHex }
  if (anchorContent(fields) !== event.content) refuse('NOSTR_ANCHOR_CONTENT_NOT_CANONICAL')
  if (fields.nodePubkeyHex !== event.pubkey) refuse('NOSTR_ANCHOR_PUBKEY_MISMATCH', 409)
  if (!Array.isArray(event.tags) || canonicalJson(event.tags) !== canonicalJson(anchorTags(fields))) refuse('NOSTR_ANCHOR_TAGS_MISMATCH', 409)
  return { ...fields, created_at: event.created_at }
}

/**
 * The receipts head as the mirror has verified it, read from the mirror's receipts-head answer (`/_mirror/aura-inputs`
 * with `x-x6-aura-receipts-head: 1`, its NOSTR hook): the chain is checked there from row 1 by the mirror's rule (seq
 * 1..n, prevHash links, leafHash = sha256(0x00 || canonicalJson(row without leafHash))), reading the journal alone under
 * the mirror's 4 MiB / 2048-row budget, so no other Aura file (the 64 KiB HANDOFF.md cap, the DAG, the corpus, the
 * heartbeat) can refuse publishing. The answer carries the last verified leaf and the row count; the journal itself
 * never crosses over.
 * Anything short of complete, matching, verified evidence refuses; it is never repaired or guessed.
 * @param {object} env HEAD's bindings (MIRROR).
 * @param {object} options seedId, head {ballId, epoch} (the page's claim; HEAD checks it against the lease later), nowMs, signal.
 * @returns {Promise<{leafHash: string, rows: number}>} The mirror's verified receipts head.
 */
export async function readMirrorReceiptsHead(env, { seedId, head, nowMs, signal }) {
  const unavailable = () => refuse('NOSTR_ANCHOR_RECEIPTS_UNAVAILABLE', 503)
  if (!env?.MIRROR || typeof seedId !== 'string' || !HEX.test(seedId) || !isRecord(head) || typeof head.ballId !== 'string' || !HEX.test(head.ballId)
    || !Number.isSafeInteger(head.epoch) || head.epoch < 0 || !Number.isSafeInteger(nowMs) || nowMs < 0) unavailable()
  const timeout = AbortSignal.timeout(NOSTR_ANCHOR_LIMITS.readTimeoutMs)
  let response, result
  try {
    response = await env.MIRROR.get(env.MIRROR.idFromName('node-main-v1')).fetch(new Request('https://x61.internal/_mirror/aura-inputs', {
      headers: { 'x-x6-internal-authorized': '1', 'x-x6-bootstrap-seed': seedId, 'x-x6-aura-head': head.ballId,
        'x-x6-aura-epoch': String(head.epoch), 'x-x6-aura-now': String(nowMs), 'x-x6-aura-receipts-head': '1' },
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    }))
    result = JSON.parse(await boundedText(response, NOSTR_ANCHOR_LIMITS.receiptsResponseBytes, 'NOSTR_ANCHOR_RECEIPTS_UNAVAILABLE'))
  } catch (_error) { unavailable() }
  if (!response.ok || result?.ok !== true || result.seedId !== seedId || result.scope !== 'nostr-receipts-head'
    || result.evidence?.status !== 'complete' || result.evidence?.scope !== 'nostr-receipts-head'
    || result.head?.ballId !== head.ballId || result.head?.epoch !== head.epoch
    || typeof result.receiptsLeafHash !== 'string' || !HEX.test(result.receiptsLeafHash)
    || !Number.isSafeInteger(result.receiptRows) || result.receiptRows < 1 || result.receiptRows !== result.verifiedReceipts) unavailable()
  return { leafHash: result.receiptsLeafHash, rows: result.receiptRows }
}

async function boundedText(source, limit, code) {
  const reader = source.body?.getReader()
  let text = '', size = 0
  const decoder = new TextDecoder('utf-8', { fatal: true })
  try {
    if (reader) for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > limit) { void reader.cancel().catch(() => {}); refuse(code, code === 'NOSTR_ANCHOR_REQUEST_LIMIT' ? 413 : 503) }
      text += decoder.decode(chunk.value, { stream: true })
    }
    return text + decoder.decode()
  } catch (error) {
    if (typeof error?.code === 'string' && error.code.startsWith('NOSTR_ANCHOR_')) throw error
    refuse(code, code === 'NOSTR_ANCHOR_REQUEST_LIMIT' ? 400 : 503)
  } finally { reader?.releaseLock() }
}

/** The mirror's verified receipts head, as both doors accept it, or the receipts-unavailable refusal. */
function checkedReceiptsHead(receipts) {
  if (!isRecord(receipts) || typeof receipts.leafHash !== 'string' || !HEX.test(receipts.leafHash) || !Number.isSafeInteger(receipts.rows) || receipts.rows < 1) refuse('NOSTR_ANCHOR_RECEIPTS_UNAVAILABLE', 503)
  return receipts
}

/** The selected head as both doors read it: a ball id and an epoch, or null. */
async function selectedHeadFact(readSelectedHead, tx) {
  const head = await readSelectedHead(tx)
  if (!isRecord(head)) return null
  return { ballId: head.ballId, epoch: head.epoch }
}

/**
 * The four facts a publication is checked against, from the same sources `publishHeadAnchor` checks the page's event
 * with: the selected HEAD (ball id and epoch), the node's stored Nostr key, and the receipts head the mirror has verified
 * for that head. Read only: it signs nothing, writes nothing and consumes no approval. The values can move on before a
 * publication arrives (a promotion, a new receipt); the POST checks them again and refuses on any difference.
 * @param {object} options storage (transactional), readSelectedHead(tx) -> {ballId, epoch}|null, and
 *   readReceiptsHead({ballId, epoch}) -> the mirror's verified {leafHash, rows}.
 * @returns {Promise<{headBallId: string, epoch: number, receiptsLeafHash: string, nodePubkeyHex: string}>} The facts.
 */
export async function readHeadAnchorFacts({ storage, readSelectedHead, readReceiptsHead }) {
  const { head, identity } = await storage.transaction(async tx => ({ head: await selectedHeadFact(readSelectedHead, tx), identity: await readMessagesIdentityInTransaction(tx) }))
  if (!head || typeof head.ballId !== 'string' || !HEX.test(head.ballId) || !Number.isSafeInteger(head.epoch) || head.epoch < 0) refuse('NOSTR_ANCHOR_UNAVAILABLE', 503)
  if (!identity) refuse('NOSTR_ANCHOR_IDENTITY_REQUIRED', 409)
  if (typeof identity.pubkey !== 'string' || !HEX.test(identity.pubkey)) refuse('NOSTR_ANCHOR_UNAVAILABLE', 503)
  const receipts = checkedReceiptsHead(await readReceiptsHead({ ballId: head.ballId, epoch: head.epoch }))
  return { headBallId: head.ballId, epoch: head.epoch, receiptsLeafHash: receipts.leafHash, nodePubkeyHex: identity.pubkey }
}

/**
 * Publish one announcement. Every check runs before the approval is consumed, and a refusal writes nothing.
 * @param {object} options storage (transactional), body (the unsigned event), nowMs, readReceiptsHead({ballId, epoch})
 *   -> the mirror's verified {leafHash, rows}, and two
 *   trusted callbacks run inside the one transaction: readSelectedHead(tx) -> {ballId, epoch}|null, and
 *   authorizeInTransaction(tx) -> the consumed Class 3 approval (or throws CLASS3_WEBAUTHN_REQUIRED).
 * @returns {Promise<object>} The signed, re-verified event that is now stored.
 */
export async function publishHeadAnchor({ storage, body, nowMs, readReceiptsHead, readSelectedHead, authorizeInTransaction }) {
  const fields = parseAnchorEvent(body)
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) refuse('NOSTR_ANCHOR_CLOCK_UNAVAILABLE', 503)
  if (Math.abs(fields.created_at - Math.floor(nowMs / 1000)) > NOSTR_ANCHOR_LIMITS.clockSkewSeconds) refuse('NOSTR_ANCHOR_CLOCK_SKEW', 409)
  // The receipts head comes from the mirror's own verification of the whole chain; the page's claim is only compared, never trusted.
  const receipts = checkedReceiptsHead(await readReceiptsHead({ ballId: fields.headBallId, epoch: fields.epoch }))
  if (receipts.leafHash !== fields.receiptsLeafHash) refuse('NOSTR_ANCHOR_RECEIPTS_MISMATCH', 409)
  return storage.transaction(async tx => {
    const head = await selectedHeadFact(readSelectedHead, tx)
    if (!head || head.ballId !== fields.headBallId || head.epoch !== fields.epoch) refuse('NOSTR_ANCHOR_HEAD_MISMATCH', 409)
    const identity = await readMessagesIdentityInTransaction(tx)
    if (!identity) refuse('NOSTR_ANCHOR_IDENTITY_REQUIRED', 409)
    if (identity.pubkey !== fields.nodePubkeyHex) refuse('NOSTR_ANCHOR_PUBKEY_MISMATCH', 409)
    const approval = await authorizeInTransaction(tx)
    if (approval?.ok !== true || !Number.isSafeInteger(approval.expiresAt) || approval.expiresAt <= nowMs) refuse('CLASS3_WEBAUTHN_REQUIRED', 403)
    const event = await signNodeEventInTransaction(tx, { pubkey: body.pubkey, created_at: body.created_at, kind: body.kind, tags: body.tags, content: body.content })
    if (!await verifyNostrEvent(event)) refuse('NOSTR_ANCHOR_SIGNING_UNAVAILABLE', 503)
    parseAnchorEvent(event, { signed: true })
    if (encoder.encode(JSON.stringify(event)).byteLength > NOSTR_ANCHOR_LIMITS.storedBytes) refuse('NOSTR_ANCHOR_EVENT_INVALID')
    await tx.put(NOSTR_ANCHOR_KEY, event)
    return projectEvent(event)
  })
}

const projectEvent = event => ({ id: event.id, pubkey: event.pubkey, created_at: event.created_at, kind: event.kind,
  tags: event.tags.map(tag => [...tag]), content: event.content, sig: event.sig })

/** A stored or received announcement, checked in full: shape, NIP-01 id, BIP-340 signature, tags against content. */
export async function checkSignedAnchor(event) {
  try {
    parseAnchorEvent(event, { signed: true })
    return await verifyNostrEvent(event)
  } catch (_error) { return false }
}

/** The latest stored announcement, re-checked before it is returned, or null when nothing was ever published. */
export async function readHeadAnchor(storage) {
  return storage.transaction(async tx => {
    const stored = await tx.get(NOSTR_ANCHOR_KEY)
    if (stored === undefined) return null
    if (!await checkSignedAnchor(stored)) refuse('NOSTR_ANCHOR_STATE_CORRUPT', 503)
    return projectEvent(stored)
  })
}

const headReply = (body, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } })

/**
 * HEAD's Nostr routes (wired by the NOSTR hook in head-do.mjs, after the bootstrap check).
 * @param {Request} request Internal request.
 * @param {object} context url, bootstrap, storage, env, owner (Worker-verified owner session), now, and the trusted
 *   readSelectedHead(tx) and authorizeInTransaction(tx, body) callbacks.
 */
export async function handleNostrAnchorRoute(request, { url, bootstrap, storage, env, owner, now = Date.now, readSelectedHead, authorizeInTransaction }) {
  try {
    const bodyless = request.body === null && (!request.headers.has('content-length') || request.headers.get('content-length') === '0') && !request.headers.has('transfer-encoding')
    if (url.pathname === NOSTR_ANCHOR_LATEST_PATH) {
      if (request.method !== 'GET') return headReply({ ok: false, code: 'METHOD_UNAVAILABLE' }, 405)
      if (url.href.includes('?') || url.hash || !bodyless) return headReply({ ok: false, code: 'NOT_FOUND' }, 404)
      return headReply({ ok: true, event: await readHeadAnchor(storage) })
    }
    const readReceiptsHead = head => readMirrorReceiptsHead(env, { seedId: bootstrap.seedId, head, nowMs: now(), signal: request.signal })
    if (request.method === 'GET') {
      // The owner's read of the four facts: same refusals as the POST, then the same sources; nothing signed or written.
      if (url.href.includes('?') || url.hash) return headReply({ ok: false, code: 'NOT_FOUND' }, 404)
      if (!bodyless) return headReply({ ok: false, code: 'NOSTR_ANCHOR_REQUEST_INVALID' }, 400)
      if (request.headers.get('x-x6-bootstrap-seed') !== bootstrap.seedId) return headReply({ ok: false, code: 'BOOTSTRAP_REQUIRED' }, 503)
      if (owner !== true) return headReply({ ok: false, code: 'NOSTR_ANCHOR_OWNER_REQUIRED' }, 403)
      return headReply({ ok: true, facts: await readHeadAnchorFacts({ storage, readSelectedHead, readReceiptsHead }) })
    }
    if (request.method !== 'POST') return headReply({ ok: false, code: 'METHOD_UNAVAILABLE' }, 405)
    if (url.href.includes('?') || url.hash) return headReply({ ok: false, code: 'NOT_FOUND' }, 404)
    if (request.headers.get('x-x6-bootstrap-seed') !== bootstrap.seedId) return headReply({ ok: false, code: 'BOOTSTRAP_REQUIRED' }, 503)
    if (owner !== true) return headReply({ ok: false, code: 'NOSTR_ANCHOR_OWNER_REQUIRED' }, 403)
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('content-type') ?? '')) refuse('NOSTR_ANCHOR_JSON_REQUIRED', 415)
    let body
    try { body = JSON.parse(await boundedText(request, NOSTR_ANCHOR_LIMITS.requestBytes, 'NOSTR_ANCHOR_REQUEST_LIMIT')) }
    catch (error) { if (error?.code === 'NOSTR_ANCHOR_REQUEST_LIMIT') throw error; refuse('NOSTR_ANCHOR_EVENT_INVALID') }
    const event = await publishHeadAnchor({ storage, body, nowMs: now(), readSelectedHead, readReceiptsHead,
      authorizeInTransaction: tx => authorizeInTransaction(tx, body) })
    return headReply({ ok: true, event, publicUrl: NOSTR_HEAD_ROUTE, nip05Url: `${NOSTR_NIP05_ROUTE}?name=${NOSTR_NIP05_NAME}` })
  } catch (error) {
    const code = typeof error?.code === 'string' && /^(?:NOSTR_ANCHOR_|CLASS3_|MESSAGES_)[A-Z0-9_]{1,80}$/.test(error.code) ? error.code : 'NOSTR_ANCHOR_UNAVAILABLE'
    const status = code === 'NOSTR_ANCHOR_UNAVAILABLE' ? 503 : [400, 403, 409, 413, 415, 503].includes(error.status) ? error.status : 503
    return headReply({ ok: false, code }, status)
  }
}

const publicHeaders = cache => ({ 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*',
  'cache-control': cache ? 'public, max-age=60' : 'no-store', 'x-content-type-options': 'nosniff' })
const publicReply = (body, status, cache = false) => new Response(JSON.stringify(body), { status, headers: publicHeaders(cache) })

/**
 * The Worker's signed-out door for the two read routes. One instance per isolate: it holds the 60 s cache (one value,
 * whatever HEAD answered, including "nothing published" and "unavailable") and one in-flight read (shared-call.mjs).
 * While reads settle, a flood costs at most one durable read per isolate per minute. While reads do NOT settle (slow, or
 * abandoned by a cancelled request), at most one new read starts per `shareWaitMs`, however many callers wait; a caller
 * waits at most `shareMaxWaits` x `shareWaitMs` on reads it did not start and is then answered 503
 * NOSTR_ANCHOR_UNAVAILABLE, which is not cached. A read a caller starts itself is bounded by `readTimeoutMs` only as far as that request's own timers
 * run. Only the first caller to have watched a dead read for a whole `shareWaitMs` replaces it: while replacement reads
 * keep being abandoned too, every other caller is answered that 503 (bounded and retryable, never a hang). An answer is
 * cached only if no read started after it has been cached (by call sequence, never by the clock). On a cache miss each
 * caller's network first passes the isolate shield.
 * @param {object} options now(), shield (createIsolateShield instance), subjectOf(request) -> shield row name.
 * @returns {{serve: Function}} serve(request, url, readLatest) -> Response; readLatest(signal) -> HEAD's {ok, event}.
 */
export function createNostrReadDoor({ now = Date.now, shield, subjectOf, cacheMs = NOSTR_ANCHOR_LIMITS.cacheMs, shareWaitMs = SHARED_CALL_WAIT_MS, shareMaxWaits = SHARED_CALL_MAX_WAITS }) {
  const cache = { value: null, until: 0, seq: 0 }, reads = createSharedCalls({ waitMs: shareWaitMs, maxWaits: shareMaxWaits, capacity: 1 })
  const answer = (path, value) => {
    if (value.state === 'unavailable') return publicReply({ ok: false, code: 'NOSTR_ANCHOR_UNAVAILABLE' }, 503)
    if (value.state === 'unpublished') return publicReply({ ok: false, code: 'NOSTR_ANCHOR_UNPUBLISHED' }, 404, true)
    return path === NOSTR_HEAD_ROUTE ? publicReply(value.event, 200, true) : publicReply({ names: { [NOSTR_NIP05_NAME]: value.event.pubkey } }, 200, true)
  }
  const load = async readLatest => {
    try {
      const result = await readLatest(AbortSignal.timeout(NOSTR_ANCHOR_LIMITS.readTimeoutMs))
      if (result?.ok !== true || !Object.hasOwn(result, 'event')) return { state: 'unavailable' }
      if (result.event === null) return { state: 'unpublished' }
      return await checkSignedAnchor(result.event) ? { state: 'published', event: projectEvent(result.event) } : { state: 'unavailable' }
    } catch (_error) { return { state: 'unavailable' } }
  }
  return Object.freeze({
    async serve(request, url, readLatest) {
      if (url.hash) return publicReply({ ok: false, code: 'NOT_FOUND' }, 404)
      if (url.pathname === NOSTR_HEAD_ROUTE ? url.href.includes('?') : url.search !== `?name=${NOSTR_NIP05_NAME}`) return publicReply({ ok: false, code: 'NOT_FOUND' }, 404)
      if (request.method !== 'GET') {
        const refused = publicReply({ ok: false, code: 'METHOD_UNAVAILABLE' }, 405)
        refused.headers.set('allow', 'GET')
        return refused
      }
      if (request.body !== null || request.headers.has('transfer-encoding') || (request.headers.has('content-length') && request.headers.get('content-length') !== '0')) {
        return publicReply({ ok: false, code: 'NOSTR_REQUEST_INVALID' }, 400)
      }
      const at = now()
      if (cache.value && cache.until > at) return answer(url.pathname, cache.value)
      const taken = shield.take(subjectOf(request), at)
      if (!taken.ok) {
        const refused = publicReply({ ok: false, code: 'NOSTR_READ_BUSY' }, 429)
        if (Number.isFinite(taken.retryAfterMs)) refused.headers.set('retry-after', String(Math.max(1, Math.ceil(taken.retryAfterMs / 1000))))
        return refused
      }
      // One read for concurrent callers, each waiting on its own timers (shared-call.mjs): a read whose request was
      // cancelled never settles, and no later caller may wait on it for ever.
      try {
        return answer(url.pathname, await reads.call('latest', async ({ seq }) => {
          const read = await load(readLatest)
          // A read that finishes late never replaces the answer of a read that started after it.
          if (seq > cache.seq) { cache.value = read; cache.until = now() + cacheMs; cache.seq = seq }
          return read
        }))
      } catch (error) {
        if (error?.code !== SHARED_CALL_BUSY) throw error
        // Out of waits on other requests' reads and no answer: unavailable for this caller, and nothing is cached.
        return answer(url.pathname, { state: 'unavailable' })
      }
    },
  })
}
