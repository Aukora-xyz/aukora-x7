/** Durable pre-inference turn journal for Aukora provider doors.
 *
 * Commits user turn metadata and request SHA-256 to HeadDO storage strictly BEFORE
 * upstream provider dispatch (`networkFetch`), so browser tab crashes, session expiry,
 * or ambiguous upstream transport failures (`PROVIDER_OUTCOME_UNKNOWN`) never lose what
 * the user asked.
 *
 * Honesty invariant: session-authenticated `/door/*` requests are recorded with
 * `signerRole: "owner-session-observed"`, never `"owner-confirmed"` (which is reserved
 * exclusively for hardware/cryptographic owner signatures).
 */

export const TURN_JOURNAL_SCHEMA = 'aukora.turn-journal.v1'
export const TURN_JOURNAL_RING_LIMIT = 256

const SEQ_KEY = 'head:turn-journal:seq'
const ROW_PREFIX = 'head:turn-journal:row:'
const TURN_INDEX_PREFIX = 'head:turn-journal:turn:'
const TURN_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/
const HEX_64 = /^[0-9a-f]{64}$/

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const journalError = (code, status = 400) => Object.assign(new Error(code), { code, status })
const terminalCode = value => {
  if (value?.cancelled === true || value?.abandoned === true || value?.cancelledAt !== undefined || value?.abandonedAt !== undefined
    || value?.status === 'cancelled' || value?.status === 'abandoned') return 'TURN_CANCELLED'
  if (value?.completed === true || value?.completedAt !== undefined || value?.status === 'completed') return 'TURN_COMPLETED'
  return null
}

async function parentTurnFailure(tx, parentTurnId) {
  if (parentTurnId === null) return null
  const terminal = terminalCode(await tx.get(`${TURN_INDEX_PREFIX}${parentTurnId}`))
  if (terminal) return terminal
  const active = await tx.get('head:turn:active')
  if (!isObject(active) || active.turn_id !== parentTurnId) return 'TURN_PARENT_NOT_ACTIVE'
  if (active.status === 'completed') return 'TURN_COMPLETED'
  if (active.status !== 'running') return 'TURN_CANCELLED'
  return null
}

async function sha256Hex(input) {
  const bytes = typeof input === 'string' ? encoder.encode(input) : input
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}

function extractTextFromContent(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const parts = []
    for (const block of content) {
      if (typeof block === 'string') parts.push(block)
      else if (isObject(block) && typeof block.text === 'string') parts.push(block.text)
      else if (isObject(block) && typeof block.input_text === 'string') parts.push(block.input_text)
    }
    return parts.join('\n')
  }
  return ''
}

function extractLastUserUtterance(parsed) {
  if (!isObject(parsed)) return ''
  if (Array.isArray(parsed.messages)) {
    for (let i = parsed.messages.length - 1; i >= 0; i--) {
      const msg = parsed.messages[i]
      if (isObject(msg) && msg.role === 'user') {
        const text = extractTextFromContent(msg.content).trim()
        if (text) return text
      }
    }
  }
  if (typeof parsed.input === 'string') return parsed.input.trim()
  if (Array.isArray(parsed.input)) {
    for (let i = parsed.input.length - 1; i >= 0; i--) {
      const item = parsed.input[i]
      if (typeof item === 'string' && item.trim()) return item.trim()
      if (isObject(item) && (item.role === 'user' || item.role === undefined)) {
        const text = extractTextFromContent(item.content ?? item.text ?? '').trim()
        if (text) return text
      }
    }
  }
  return ''
}

/** Extract bounded pre-model metadata. Request IDs are distinct from optional parent lifecycle IDs.
 * Omitting parentTurnIdHeader leaves the request unassociated; no active parent is inferred.
 */
export async function extractDoorTurnSummary(provider, endpoint, bodyBytes, { turnIdHeader = null, parentTurnIdHeader = null, requestedModel = null } = {}) {
  if (!(bodyBytes instanceof Uint8Array)) throw journalError('TURN_JOURNAL_BODY_REQUIRED', 400)
  if (turnIdHeader !== null && turnIdHeader !== undefined && !TURN_ID_RE.test(turnIdHeader)) {
    throw journalError('TURN_JOURNAL_ID_INVALID', 400)
  }
  if (parentTurnIdHeader !== null && parentTurnIdHeader !== undefined && !TURN_ID_RE.test(parentTurnIdHeader)) {
    throw journalError('TURN_JOURNAL_PARENT_ID_INVALID', 400)
  }
  const requestSha256 = await sha256Hex(bodyBytes)
  let parsed = null
  try {
    parsed = JSON.parse(decoder.decode(bodyBytes))
  } catch {
    throw journalError('TURN_JOURNAL_JSON_INVALID', 400)
  }
  const utterance = extractLastUserUtterance(parsed)
  const utteranceSha256 = await sha256Hex(utterance)
  const utterancePreview = utterance.slice(0, 280)
  return {
    turnId: turnIdHeader ?? null,
    parentTurnId: parentTurnIdHeader ?? null,
    provider: String(provider),
    endpoint: String(endpoint),
    requestedModel: typeof requestedModel === 'string' ? requestedModel : (typeof parsed?.model === 'string' ? parsed.model.slice(0, 200) : null),
    requestSha256,
    utteranceSha256,
    utterancePreview,
    utteranceBytes: encoder.encode(utterance).byteLength,
  }
}

/** Handle internal HeadDO `/_head/turn-journal` (`GET` status/list, `POST` pre-inference append). */
export async function handleInternalTurnJournalRoute(storage, method, body, now = Date.now) {
  if (method === 'GET') {
    const limit = Number.isSafeInteger(body?.limit) && body.limit >= 1 && body.limit <= TURN_JOURNAL_RING_LIMIT
      ? body.limit
      : 40
    const state = await storage.transaction(async tx => {
      const seq = Number((await tx.get(SEQ_KEY)) ?? 0)
      const start = Math.max(1, seq - limit + 1)
      const entries = []
      for (let s = start; s <= seq; s++) {
        const row = await tx.get(`${ROW_PREFIX}${s}`)
        if (isObject(row)) entries.push(row)
      }
      return { ok: true, schema: TURN_JOURNAL_SCHEMA, seq, entries }
    })
    return Response.json(state, { headers: { 'cache-control': 'no-store' } })
  }

  if (method !== 'POST') {
    return Response.json({ ok: false, code: 'METHOD_UNAVAILABLE' }, { status: 405, headers: { 'cache-control': 'no-store' } })
  }

  if (isObject(body) && body.action === 'cancel') {
    const cancelTurnId = typeof body.turnId === 'string' && TURN_ID_RE.test(body.turnId) ? body.turnId : null
    if (!cancelTurnId) {
      return Response.json({ ok: false, code: 'TURN_JOURNAL_ID_INVALID' }, { status: 400, headers: { 'cache-control': 'no-store' } })
    }
    const reason = typeof body.reason === 'string' && /^[A-Za-z0-9._:-]{1,64}$/.test(body.reason) ? body.reason : 'barge_in'
    const cancelledOutcome = await storage.transaction(async tx => {
      const idx = await tx.get(`${TURN_INDEX_PREFIX}${cancelTurnId}`)
      if (terminalCode(idx) === 'TURN_COMPLETED') return { ok: false, status: 409, code: 'TURN_COMPLETED', turnId: cancelTurnId }
      const cancelledAt = idx?.cancelledAt ?? now()
      if (isObject(idx)) await tx.put(`${TURN_INDEX_PREFIX}${cancelTurnId}`, { ...idx, cancelled: true, cancelledAt })
      let updatedRow = null
      if (isObject(idx) && Number.isSafeInteger(idx.seq)) {
        const existingRow = await tx.get(`${ROW_PREFIX}${idx.seq}`)
        if (isObject(existingRow)) {
          updatedRow = existingRow.cancelled === true
            ? existingRow
            : { ...existingRow, cancelled: true, cancelledAt, cancelReason: reason }
          await tx.put(`${ROW_PREFIX}${idx.seq}`, updatedRow)
        }
      }
      const activeTurn = await tx.get('head:turn:active')
      let activeTurnCancelled = false
      if (isObject(activeTurn) && activeTurn.turn_id === cancelTurnId && activeTurn.status === 'running') {
        await tx.put('head:turn:active', {
          ...activeTurn,
          status: 'abandoned',
          outcome: reason === 'barge_in' ? 'barge_in_cancelled' : reason,
          completed_at: cancelledAt,
        })
        activeTurnCancelled = true
      }
      if (activeTurnCancelled && !isObject(idx)) await tx.put(`${TURN_INDEX_PREFIX}${cancelTurnId}`, { cancelled: true, cancelledAt })
      if (!updatedRow && !activeTurnCancelled && !isObject(idx)) {
        return { ok: false, status: 404, code: 'TURN_JOURNAL_NOT_FOUND', turnId: cancelTurnId }
      }
      return {
        ok: true,
        cancelled: true,
        turnId: cancelTurnId,
        reason,
        cancelledAt: updatedRow?.cancelledAt ?? cancelledAt,
        activeTurnCancelled,
        entry: updatedRow,
      }
    })
    return Response.json(cancelledOutcome, {
      status: cancelledOutcome.status ?? 200,
      headers: { 'cache-control': 'no-store' },
    })
  }

  if (!isObject(body)
    || typeof body.provider !== 'string' || !body.provider
    || typeof body.endpoint !== 'string' || !body.endpoint
    || !HEX_64.test(body.requestSha256 ?? '')
    || !HEX_64.test(body.utteranceSha256 ?? '')
    || (body.turnId !== null && body.turnId !== undefined && !TURN_ID_RE.test(body.turnId))
    || (body.parentTurnId !== null && body.parentTurnId !== undefined && !TURN_ID_RE.test(body.parentTurnId))) {
    return Response.json({ ok: false, code: 'TURN_JOURNAL_INVALID' }, { status: 400, headers: { 'cache-control': 'no-store' } })
  }

  const outcome = await storage.transaction(async tx => {
    const explicitTurnId = typeof body.turnId === 'string' ? body.turnId : null
    const parentTurnId = typeof body.parentTurnId === 'string' ? body.parentTurnId : null
    const parentFailure = await parentTurnFailure(tx, parentTurnId)
    if (parentFailure) return { ok: false, status: 409, code: parentFailure, parentTurnId }
    const active = await tx.get('head:turn:active')
    if (explicitTurnId) {
      const existingIndex = await tx.get(`${TURN_INDEX_PREFIX}${explicitTurnId}`)
      const terminal = terminalCode(existingIndex)
      if (terminal) return { ok: false, status: 409, code: terminal, turnId: explicitTurnId }
      if (active?.turn_id === explicitTurnId && active.status !== 'running') {
        return { ok: false, status: 409, code: active.status === 'completed' ? 'TURN_COMPLETED' : 'TURN_CANCELLED', turnId: explicitTurnId }
      }
      if (existingIndex !== undefined) {
        if (!isObject(existingIndex)) return { ok: false, status: 409, code: 'TURN_JOURNAL_CONFLICT', turnId: explicitTurnId }
        if (existingIndex.requestSha256 !== body.requestSha256 || (existingIndex.parentTurnId ?? null) !== parentTurnId) {
          return { ok: false, status: 409, code: 'TURN_JOURNAL_CONFLICT', turnId: explicitTurnId }
        }
        if (existingIndex.dispatchedAt !== undefined) return { ok: false, status: 409, code: 'TURN_DISPATCH_ALREADY_STARTED', turnId: explicitTurnId }
        const existingRow = await tx.get(`${ROW_PREFIX}${existingIndex.seq}`)
        const rowTerminal = terminalCode(existingRow)
        if (rowTerminal) return { ok: false, status: 409, code: rowTerminal, turnId: explicitTurnId }
        if (!isObject(existingRow)) return { ok: false, status: 409, code: 'TURN_JOURNAL_REQUIRED', turnId: explicitTurnId }
        if (existingRow.turnId !== explicitTurnId || existingRow.requestSha256 !== body.requestSha256
          || existingRow.provider !== body.provider || existingRow.endpoint !== body.endpoint
          || (existingRow.parentTurnId ?? null) !== parentTurnId) {
          return { ok: false, status: 409, code: 'TURN_JOURNAL_CONFLICT', turnId: explicitTurnId }
        }
        return { ok: true, idempotent: true, savedBeforeInference: true, entry: existingRow }
      }
    }

    const prevSeq = Number((await tx.get(SEQ_KEY)) ?? 0)
    const seq = prevSeq + 1
    let turnId = explicitTurnId
    if (turnId === null) {
      // Never overwrite a caller-selected ID or a retained terminal/dispatch index.
      for (let attempt = 0; attempt < 8; attempt++) {
        const candidate = `turn-${crypto.randomUUID()}`
        if (candidate !== active?.turn_id && await tx.get(`${TURN_INDEX_PREFIX}${candidate}`) === undefined) {
          turnId = candidate
          break
        }
      }
      if (turnId === null) return { ok: false, status: 503, code: 'TURN_JOURNAL_ID_COLLISION' }
    }
    const recordedAt = now()
    const isVoiceModality = body.modality === 'voice' || body.provider === 'personaplex-voice'
    const entry = {
      schema: TURN_JOURNAL_SCHEMA,
      seq,
      recordedAt,
      turnId,
      parentTurnId,
      provider: body.provider,
      endpoint: body.endpoint,
      requestedModel: typeof body.requestedModel === 'string' ? body.requestedModel : null,
      requestSha256: body.requestSha256,
      utteranceSha256: body.utteranceSha256,
      utterancePreview: typeof body.utterancePreview === 'string' ? body.utterancePreview.slice(0, 280) : '',
      utteranceBytes: Number.isSafeInteger(body.utteranceBytes) && body.utteranceBytes >= 0 ? body.utteranceBytes : 0,
      savedBeforeInference: true,
      signerRole: isVoiceModality ? 'voice-transcript-unconfirmed' : 'owner-session-observed',
      ...(isVoiceModality ? {
        modality: 'voice',
        voiceAuthority: 'none',
        voiceId: typeof body.voiceId === 'string' ? body.voiceId : null,
      } : {}),
    }

    await tx.put(SEQ_KEY, seq)
    await tx.put(`${ROW_PREFIX}${seq}`, entry)
    await tx.put(`${TURN_INDEX_PREFIX}${turnId}`, { seq, requestSha256: body.requestSha256, parentTurnId })

    if (seq > TURN_JOURNAL_RING_LIMIT) {
      const evictedSeq = seq - TURN_JOURNAL_RING_LIMIT
      const evicted = await tx.get(`${ROW_PREFIX}${evictedSeq}`)
      await tx.delete(`${ROW_PREFIX}${evictedSeq}`)
      if (isObject(evicted) && typeof evicted.turnId === 'string') {
        const idx = await tx.get(`${TURN_INDEX_PREFIX}${evicted.turnId}`)
        if (isObject(idx) && idx.seq === evictedSeq && !terminalCode(idx) && idx.dispatchedAt === undefined) {
          await tx.delete(`${TURN_INDEX_PREFIX}${evicted.turnId}`)
        }
      }
    }

    return { ok: true, idempotent: false, savedBeforeInference: true, entry }
  })

  return Response.json(outcome, {
    status: outcome.status ?? 200,
    headers: { 'cache-control': 'no-store' },
  })
}

/** Atomically consume exact journal evidence before an upstream provider request.
 * Dispatch/cancellation index tombstones survive row eviction to prevent turn ID replay.
 * @param {object} storage HeadDO durable storage.
 * @param {object} input Exact request hash and provider identifiers.
 * @param {Function} check Synchronous in-memory cancellation check inside the transaction.
 * @returns {Promise<void>} Resolves only once for an uncancelled journaled turn.
 */
export async function claimTurnJournalDispatch(storage, input, check) {
  await storage.transaction(async tx => {
    check()
    const index = await tx.get(`${TURN_INDEX_PREFIX}${input.turnId}`)
    const terminal = terminalCode(index)
    if (terminal) throw journalError(terminal, 409)
    if (!isObject(index) || !Number.isSafeInteger(index.seq)) throw journalError('TURN_JOURNAL_REQUIRED', 409)
    if (index.dispatchedAt !== undefined) throw journalError('TURN_DISPATCH_ALREADY_STARTED', 409)
    const row = await tx.get(`${ROW_PREFIX}${index.seq}`)
    if (!isObject(row) || row.savedBeforeInference !== true) throw journalError('TURN_JOURNAL_REQUIRED', 409)
    const rowTerminal = terminalCode(row)
    if (rowTerminal) throw journalError(rowTerminal, 409)
    if (row.turnId !== input.turnId || row.provider !== input.provider || row.endpoint !== input.endpoint
      || row.requestSha256 !== input.requestSha256 || index.requestSha256 !== input.requestSha256
      || (row.parentTurnId ?? null) !== (input.parentTurnId ?? null)
      || (index.parentTurnId ?? null) !== (input.parentTurnId ?? null)) throw journalError('TURN_JOURNAL_CONFLICT', 409)
    const parentFailure = await parentTurnFailure(tx, input.parentTurnId ?? null)
    if (parentFailure) throw journalError(parentFailure, 409)
    const active = await tx.get('head:turn:active')
    if (isObject(active) && active.turn_id === input.turnId && active.status !== 'running') throw journalError(active.status === 'completed' ? 'TURN_COMPLETED' : 'TURN_CANCELLED', 409)
    check()
    const dispatchedAt = Date.now()
    await tx.put(`${TURN_INDEX_PREFIX}${input.turnId}`, { ...index, dispatchedAt })
    await tx.put(`${ROW_PREFIX}${index.seq}`, { ...row, dispatchedAt })
  })
}
