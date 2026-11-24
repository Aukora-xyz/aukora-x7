export const name = 'seed-superagent'

const STATE_DIR = '/dsh/home/auma/superagent'
const STATE_FILE = STATE_DIR + '/state.json'
const RECEIPTS = '/dsh/home/auma/seed/receipts.v3.jsonl'
const HEAD = '/dsh/home/balls/HEAD.json'
const STALE_HEARTBEAT_MS = 120000
// The status consumer accepts ISO years 0000–9999, not Date's signed extended years.
const MIN_STATUS_EXPIRY_MS = -62167219200000
const MAX_STATUS_EXPIRY_MS = 253402300799999
const validExpiry = (value) => Number.isSafeInteger(value) && value >= MIN_STATUS_EXPIRY_MS && value <= MAX_STATUS_EXPIRY_MS

// --- Owner front door -------------------------------------------------
// Matches apps/web/src/spatial/superagent/owner-grant.ts byte-for-byte.
const OWNER_GRANT_DOMAIN = 'aukora.x6.owner-grant.v1\u0000'
const OWNER_GRANT_SCHEMA = 'aukora.x6.owner-grant.v1'
// Trust anchor: the owner key is read from owner-key.v1.json, and that file is pinned by its
// SHA-256 here, so a key supplied by the caller, or a swapped file, is never a trust root. A missing or
// changed file closes the front door for everyone (no owner keys).
const OWNER_KEY_FILE = '/dsh/home/auma/seed/owner-key.v1.json'
const OWNER_KEY_FILE_SHA256 = '23454c87b5ebf2f3b9fef7917c04656d80bfe79909e9a34935fc907b2c27bfa3'
const ownerPublicKeys = (fs, crypto) => {
  try {
    const raw = fs.readFileSync(OWNER_KEY_FILE)
    const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(typeof raw === 'string' ? raw : new Uint8Array(raw))
    if (crypto.createHash('sha256').update(bytes).digest('hex') !== OWNER_KEY_FILE_SHA256) return []
    const key = JSON.parse(bytes.toString('utf8'))
    if (!key || key.schema !== 'aukora.owner-key.v1' || key.algorithm !== 'Ed25519' || key.domain !== OWNER_GRANT_SCHEMA) return []
    return typeof key.publicKeyHex === 'string' && /^[0-9a-f]{64}$/.test(key.publicKeyHex) ? [key.publicKeyHex] : []
  } catch (_) { return [] }
}
const OWNER_REJECTED_IDENTITIES = ['spatial-tab', 'agent', 'agent-self-unverified', 'person']
const ownerCanonical = (v) => {
  if (v === null || typeof v !== 'object') return JSON.stringify(v)
  if (Array.isArray(v)) return '[' + v.map((x) => ownerCanonical(x === undefined ? null : x)).join(',') + ']'
  const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort()
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + ownerCanonical(v[k])).join(',') + '}'
}
const ownerGrantText = (b) => ownerCanonical({
  schema: OWNER_GRANT_SCHEMA,
  mandateId: b.mandateId,
  ticketId: b.ticketId,
  scope: b.scope === undefined ? null : b.scope,
  ballId: b.ballId,
  epoch: b.epoch,
  expiresAt: b.expiresAt,
  identity: b.identity,
})
const verifyOwnerGrant = (crypto, ownerKeys, grant, mandate, expectedTicketId, currentHead) => {
  if (!grant || typeof grant !== 'object') return 'missing'
  if (grant.schema !== OWNER_GRANT_SCHEMA) return 'malformed'
  if (typeof grant.mandateId !== 'string' || grant.mandateId !== mandate.id) return 'binding-mismatch'
  if (typeof grant.identity !== 'string' || !grant.identity) return 'malformed'
  if (OWNER_REJECTED_IDENTITIES.includes(grant.identity)) return 'identity-rejected'
  if (typeof grant.publicKeyHex !== 'string' || !/^[0-9a-f]{64}$/.test(grant.publicKeyHex)) return 'malformed'
  if (typeof grant.signatureHex !== 'string' || !/^[0-9a-f]{128}$/.test(grant.signatureHex)) return 'malformed'
  if (!ownerKeys.includes(grant.publicKeyHex)) return 'untrusted-key'
  // Full binding check. A valid signature over the WRONG terms is still a forgery:
  // it lets an owner-signed grant for one scope/epoch be replayed against another. Every field
  // the signature covers must match the stored mandate and the live head before crypto runs.
  const head = currentHead || {}
  const wantTicket = expectedTicketId === undefined ? null : (expectedTicketId || null)
  const gotTicket = typeof grant.ticketId === 'string' && grant.ticketId ? grant.ticketId : null
  if (gotTicket !== wantTicket) return 'binding-mismatch'
  const gotScope = ownerCanonical(grant.scope === undefined ? null : grant.scope)
  const wantScope = ownerCanonical(mandate.scope === undefined ? null : mandate.scope)
  if (gotScope !== wantScope) return 'binding-mismatch'
  if (typeof grant.ballId !== 'string' || !head.ballId || grant.ballId !== head.ballId) return 'binding-mismatch'
  if (!Number.isSafeInteger(grant.epoch) || !Number.isSafeInteger(head.epoch) || grant.epoch !== head.epoch) return 'binding-mismatch'
  if (!validExpiry(grant.expiresAt) || !validExpiry(mandate.expiresAt) || grant.expiresAt !== mandate.expiresAt) return 'binding-mismatch'
  try {
    const der = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(grant.publicKeyHex, 'hex')])
    const key = crypto.createPublicKey({ key: der, format: 'der', type: 'spki' })
    const binding = {
      mandateId: grant.mandateId,
      ticketId: typeof grant.ticketId === 'string' ? grant.ticketId : null,
      scope: grant.scope === undefined ? null : grant.scope,
      ballId: typeof grant.ballId === 'string' ? grant.ballId : null,
      epoch: Number.isSafeInteger(grant.epoch) ? grant.epoch : null,
      expiresAt: grant.expiresAt,
      identity: grant.identity,
    }
    const message = OWNER_GRANT_DOMAIN + ownerGrantText(binding)
    const okSig = crypto.verify(null, Buffer.from(message, 'utf8'), key, Buffer.from(grant.signatureHex, 'hex'))
    return okSig ? 'verified' : 'bad-signature'
  } catch (_) { return 'bad-signature' }
}
// --- end owner front door --------------------------------------------------------

const nodeOf = (m) => {
  try {
    if (typeof process !== 'undefined' && typeof process.getBuiltinModule === 'function') return process.getBuiltinModule(m)
    // eslint-disable-next-line no-undef
    if (typeof require === 'function') return require(m)
  } catch (_) { /* ignore */ }
  return null
}

export function apply(ctx) {
  const fs = nodeOf('node:fs')
  const crypto = nodeOf('node:crypto')

  const canonical = (v) => {
    if (v === null || typeof v !== 'object') return JSON.stringify(v)
    if (Array.isArray(v)) return '[' + v.map((x) => canonical(x === undefined ? null : x)).join(',') + ']'
    const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort()
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}'
  }
  const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex')
  const merkleLeafHash = (payloadObj) => {
    const canon = Buffer.from(canonical(payloadObj), 'utf8')
    return crypto.createHash('sha256').update(Buffer.concat([Buffer.from([0x00]), canon])).digest('hex')
  }
  const id = (prefix, obj) => prefix + '_' + sha256(canonical(obj)).slice(0, 16)
  const now = () => Date.now()

  const empty = () => ({ version: 1, updatedAt: now(), triggers: [], threads: [], mandates: [], tickets: [], assignments: [], attention: [], outbox: [] })

  const load = () => {
    let state
    try {
      if (!fs.existsSync(STATE_FILE)) return empty()
      const raw = fs.readFileSync(STATE_FILE, 'utf8')
      if (!raw.trim()) return empty()
      state = Object.assign(empty(), JSON.parse(raw))
    } catch (_) { return empty() }
    if (!Array.isArray(state.mandates)) return { ok: false, error: 'MANDATE_STATE_UNREADABLE' }
    // Historical expiry is allowed for inspection, but malformed persisted values
    // must not be formatted, assigned, or carried into another state write.
    for (const mandate of state.mandates) {
      if (!mandate || !validExpiry(mandate.expiresAt)
        || (mandate.scope && mandate.scope.expiresAt !== undefined && mandate.scope.expiresAt !== mandate.expiresAt)) {
        return { ok: false, error: 'MANDATE_EXPIRY_INVALID', mandateId: mandate && mandate.id || null }
      }
    }
    return state
  }

  const save = (state) => {
    state.updatedAt = now()
    try { if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true }) } catch (_) {}
    const tmp = STATE_FILE + '.tmp'
    const body = JSON.stringify(state, null, 2)
    fs.writeFileSync(tmp, body)
    fs.renameSync(tmp, STATE_FILE)
    return sha256(body)
  }

  const readReceiptsChain = () => {
    try {
      if (!fs.existsSync(RECEIPTS)) return { intact: false, receipts: [] }
      const lines = fs.readFileSync(RECEIPTS, 'utf8').split('\n').filter((l) => l.trim() !== '')
      let prev = '0'.repeat(64)
      const out = []
      for (let i = 0; i < lines.length; i++) {
        const rec = JSON.parse(lines[i])
        const { leafHash, ...payload } = rec
        const recomputed = merkleLeafHash(payload)
        if (rec.schema !== 'aukora.receipt.v3' || rec.seq !== i + 1 || rec.prevHash !== prev || leafHash !== recomputed) {
          return { intact: false, receipts: out }
        }
        out.push(rec)
        prev = leafHash
      }
      return { intact: true, receipts: out }
    } catch (_) {
      return { intact: false, receipts: [] }
    }
  }

  const receiptHead = () => {
    const chain = readReceiptsChain()
    if (!chain.receipts.length) return null
    return chain.receipts[chain.receipts.length - 1].leafHash || null
  }

  const headNow = () => {
    try { return JSON.parse(fs.readFileSync(HEAD, 'utf8')) || {} } catch (_) { return {} }
  }

  const ballIdNow = () => headNow().ballId || null
  const epochNow = () => {
    const ep = headNow().epoch
    return Number.isSafeInteger(ep) ? ep : null
  }

  const verifyGrantReceipt = (targetHash, scopeObj, mandateId) => {
    if (typeof targetHash !== 'string' || !/^[0-9a-f]{64}$/.test(targetHash)) return null
    const chain = readReceiptsChain()
    if (!chain.intact) return null
    const found = chain.receipts.find((r) => r.leafHash === targetHash && r.kind === 'mandate.grant')
    if (!found) return null
    const data = (found.data && typeof found.data === 'object') ? found.data : {}
    if (mandateId && typeof data.mandateId === 'string' && data.mandateId !== mandateId) return null
    if (scopeObj && data.scope !== undefined && canonical(data.scope) !== canonical(scopeObj)) return null
    return found
  }

  // Gate 0: seed-receipts is the only writer of the receipt log. A confirmed grant is appended
  // through it, with the owner-signed envelope, and seed-receipts verifies that signature itself.
  const appendGrantReceipt = async (mandate, ticketId, identity) => {
    const organs = ctx && ctx.organs
    if (!organs || typeof organs.call !== 'function') return { ok: false, error: 'RECEIPTS_ORGAN_UNAVAILABLE' }
    try {
      const result = await organs.call('seed-receipts', {
        action: 'append',
        kind: 'mandate.grant',
        envelope: mandate.ownerGrant,
        data: {
          mandateId: mandate.id,
          ticketId: ticketId || null,
          scope: mandate.scope === undefined ? null : mandate.scope,
          identity,
          ballId: mandate.ownerGrant.ballId,
          epoch: mandate.ownerGrant.epoch,
        },
      })
      if (!result || result.ok !== true || !result.receipt) return { ok: false, error: (result && result.error) || 'RECEIPT_NOT_ACKNOWLEDGED', reason: result && result.reason }
      return { ok: true, record: result.receipt }
    } catch (error) {
      return { ok: false, error: error && error.message ? error.message : String(error) }
    }
  }

  const detailSummary = (kind, detail) => {
    if (!detail || typeof detail !== 'object') return String(kind)
    const parts = [detail.title, detail.note, detail.mandateId, detail.assignmentId, detail.ticketId]
      .filter((x) => typeof x === 'string' && x.length > 0)
    return parts.length ? parts.join(' · ') : String(kind)
  }

  const attention = (state, kind, detail) => {
    const item = {
      id: id('att', { kind, detail, t: now() }),
      kind,
      text: detailSummary(kind, detail),
      detail,
      at: now(),
      resolved: false,
    }
    state.attention.push(item)
    return item
  }

  const enqueue = (state, opId, payload) => {
    if (state.outbox.some((o) => o.id === opId)) return { id: opId, status: 'duplicate' }
    const entry = { id: opId, payload, status: 'pending', at: now() }
    state.outbox.push(entry)
    return entry
  }

  const findMandate = (state, mandateId) => state.mandates.find((m) => m.id === mandateId)
  const findTicket = (state, ticketId) => state.tickets.find((t) => t.id === ticketId)

  const mandateUsable = (m) => {
    if (!m) return 'mandate-missing'
    if (!validExpiry(m.expiresAt)) return 'MANDATE_EXPIRY_INVALID'
    if (m.expiresAt <= now()) return 'mandate-expired'
    if (m.stopped) return 'mandate-stopped'
    if (!m.confirmed) return m.strength === 'inferred' ? 'inferred-unconfirmed' : 'explicit-unverified-grant'
    if (m.governanceApproval && (!validExpiry(m.governanceApproval.expiresAt) || m.governanceApproval.expiresAt <= now())) return 'governance-approval-expired'
    if (m.budgetSteps <= 0) return 'budget-exhausted'
    return null
  }

  const api = {
    trigger(input) {
      const state = load()
      if (state.ok === false) return state
      const t = {
        id: id('trg', { src: input.source, kind: input.kind, p: input.payload, t: now() }),
        source: input.source || 'unknown',
        kind: input.kind || 'event',
        payload: input.payload === undefined ? null : input.payload,
        at: now(),
        fannedOutTo: [],
      }
      for (const th of state.threads) {
        if (th.subscription && (th.subscription === '*' || th.subscription === t.kind || th.subscription === t.source)) {
          th.messageIds = th.messageIds || []
          th.messageIds.push(t.id)
          t.fannedOutTo.push(th.id)
        }
      }
      state.triggers.push(t)
      const hash = save(state)
      return { triggerId: t.id, fannedOutTo: t.fannedOutTo, stateHash: hash }
    },

    subscribe(input) {
      const state = load()
      if (state.ok === false) return state
      const th = { id: id('thr', { s: input.subscription, n: now() }), subscription: input.subscription || '*', title: input.title || null, at: now(), messageIds: [] }
      state.threads.push(th)
      save(state)
      return { threadId: th.id }
    },

    eval_accept(input) {
      const state = load()
      if (state.ok === false) return state
      // Close the side door. eval_accept never calls verifyOwnerGrant, so the
      // only thing that ever made a mandate "confirmed" here was the *existence* of a
      // mandate.grant receipt. Confirmation is exclusively the `confirm` action below,
      // which is the sole caller of verifyOwnerGrant.
      if (input && input.strength === 'explicit') {
        return {
          ok: false,
          error: 'EXPLICIT_REQUIRES_CONFIRM',
          note: 'eval_accept mints inferred mandates only. Use action:"confirm" with a signed aukora.x6.owner-grant.v1 grant.',
        }
      }
      const strength = 'inferred'
      const scope = input.scope || {}
      if (scope.candidateSha256 !== undefined && (typeof scope.candidateSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(scope.candidateSha256))) return { ok: false, error: 'candidate-sha256-invalid' }
      if (scope.organ !== undefined && (typeof scope.organ !== 'string' || !/^[a-z][a-z0-9-]{0,40}$/.test(scope.organ))) return { ok: false, error: 'organ-invalid' }
      if (scope.organ !== undefined && Array.isArray(scope.organs) && scope.organs.some(organ => organ !== scope.organ)) return { ok: false, error: 'organ-scope-mismatch' }
      if (!scope.paths && !scope.organs && !scope.organ && !scope.tools) return { ok: false, error: 'scope-required' }
      // Only an omitted expiry receives the six-hour default. Both paths are validated.
      const expiresAt = scope.expiresAt === undefined ? now() + 1000 * 60 * 60 * 6 : scope.expiresAt
      if (!validExpiry(expiresAt) || expiresAt <= now()) return { ok: false, error: 'MANDATE_EXPIRY_INVALID' }

      const normalizedScope = {
        paths: scope.paths || [],
        organs: scope.organs || (scope.organ ? [scope.organ] : []),
        tools: scope.tools || [],
        budgetSteps: Number.isFinite(scope.budgetSteps) ? scope.budgetSteps : 5,
        expiresAt,
        ...(scope.organ === undefined ? {} : { organ: scope.organ }),
        ...(scope.candidateSha256 === undefined ? {} : { candidateSha256: scope.candidateSha256 }),
      }
      const mandateId = id('mnd', { trig: input.triggerId || null, title: input.title, scope, t: now() })
      const ticketId = id('tkt', { m: mandateId, t: now() })
      // Deliberately no receipt lookup: a receipt proves a grant was *recorded*, never that
      // the owner signed THIS scope against THIS head now. Anchoring is the whole point.
      const verifiedGrant = null
      const confirmed = false
      const activeBallId = ballIdNow()
      const activeEpoch = epochNow()

      const mandate = {
        id: mandateId,
        triggerId: input.triggerId || null,
        title: input.title || 'untitled',
        strength,
        confirmed,
        confirmedBy: confirmed ? (verifiedGrant.data && verifiedGrant.data.identity ? verifiedGrant.data.identity : 'receipt-grant') : null,
        policyVersion: input.policyVersion || 'x6.1/v1',
        scope: normalizedScope,
        budgetSteps: normalizedScope.budgetSteps,
        expiresAt: normalizedScope.expiresAt,
        receiptHash: verifiedGrant ? verifiedGrant.leafHash : null,
        receiptLeafHash: verifiedGrant ? verifiedGrant.leafHash : null,
        grant: verifiedGrant ? {
          seq: verifiedGrant.seq,
          hash: verifiedGrant.leafHash,
          kind: verifiedGrant.kind,
          scope: normalizedScope,
          ticketId: (verifiedGrant.data && verifiedGrant.data.ticketId) || ticketId,
          identity: (verifiedGrant.data && verifiedGrant.data.identity) || null,
          ballId: (verifiedGrant.data && verifiedGrant.data.ballId) || activeBallId,
          epoch: (verifiedGrant.data && Number.isSafeInteger(verifiedGrant.data.epoch)) ? verifiedGrant.data.epoch : activeEpoch,
        } : null,
        ballId: activeBallId,
        at: now(),
        stopped: false,
      }
      state.mandates.push(mandate)

      const ticket = {
        id: ticketId,
        mandateId: mandate.id,
        title: mandate.title,
        state: 'open',
        stoppedByPerson: false,
        createdAt: now(),
      }
      state.tickets.push(ticket)

      let att = null
      if (!mandate.confirmed) {
        att = attention(state, strength === 'explicit' ? 'explicit-mandate-confirmation' : 'inferred-mandate-confirmation', {
          mandateId: mandate.id,
          title: mandate.title,
          scope: mandate.scope,
          note: strength === 'explicit' ? 'Explicit mandate requires verified mandate.grant receipt or confirmation' : 'Inferred mandate requires confirmation',
        })
      }

      const op = enqueue(state, 'obx_' + mandate.id, { kind: 'mandate.minted', mandateId: mandate.id, receiptHash: mandate.receiptHash })
      save(state)
      return {
        ok: true,
        mandateId: mandate.id,
        ticketId: ticket.id,
        strength,
        confirmed: mandate.confirmed,
        requiresConfirmation: !mandate.confirmed,
        receiptHash: mandate.receiptHash,
        receiptLeafHash: mandate.receiptLeafHash,
        grant: mandate.grant,
        ballId: mandate.ballId,
        attention: att,
        outbox: op,
      }
    },

    async confirm(input) {
      const state = load()
      if (state.ok === false) return state
      const m = findMandate(state, input.mandateId)
      if (!m) return { ok: false, error: 'mandate-missing' }
      if (m.expiresAt <= now()) return { ok: false, error: 'mandate-expired', confirmed: false }
      if (m.confirmed && m.grant) return { ok: false, error: 'already-confirmed' }
      const ticket = state.tickets.find((t) => t.mandateId === m.id) || null
      if (input.promotionBinding !== undefined) {
        const binding = input.promotionBinding
        const scope = m.scope || {}
        const governance = typeof ctx.get === 'function' ? ctx.get('governance') : ctx.governance
        const organ = scope.organ || (Array.isArray(scope.organs) && scope.organs.length === 1 ? scope.organs[0] : null)
        const head = headNow()
        if (!governance || typeof governance.verifyApproval !== 'function' || !binding || binding.schema !== 'aukora.class3.head-promotion.v1'
          || binding.action !== 'head.promote' || binding.organId !== organ || binding.candidateSha256 !== scope.candidateSha256
          || typeof organ !== 'string' || !/^[a-z][a-z0-9-]{0,40}$/.test(organ)
          || !Number.isSafeInteger(head.epoch) || binding.epoch !== head.epoch + 1 || m.ballId !== head.ballId
          || !validExpiry(m.expiresAt) || m.expiresAt <= now()
          || (scope.organs || []).some(value => value !== organ)
          || (scope.paths || []).some(value => ![`/dsh/home/auma/seed/organs/${organ}.js`, `mirror/home/auma/seed/organs/${organ}.js`].includes(value))
          || (scope.tools || []).some(value => !['ball_put', 'tree_patch'].includes(value))) return { ok: false, error: 'CLASS3_GOVERNANCE_BINDING_REQUIRED', confirmed: false }
        const before = ownerCanonical(state)
        // Dynamic governance IDs use the same exact host approval. The selected-head
        // classifier, not this caller-supplied ID or a mandate, decides promotion authority.
        const approval = await governance.verifyApproval(binding)
        if (approval?.ok !== true || ownerCanonical(approval.binding) !== ownerCanonical(binding) || !validExpiry(approval.expiresAt) || approval.expiresAt <= now()) return { ok: false, error: 'CLASS3_WEBAUTHN_REQUIRED', confirmed: false }
        if (ownerCanonical(load()) !== before || headNow().ballId !== head.ballId || m.expiresAt <= now()) return { ok: false, error: 'CLASS3_CONFIRMATION_STALE', confirmed: false }
        // This confirms a narrow, host-verified intent. It is not an owner-signed grant
        // receipt, and the approval remains unspent until the host commits this head.
        m.confirmed = true
        m.confirmedAt = now()
        m.confirmedBy = 'host-passkey-approval'
        m.governanceApproval = { approvalId: approval.approvalId, binding: approval.binding, expiresAt: approval.expiresAt }
        for (const attention of state.attention) if (attention.detail?.mandateId === m.id) attention.resolved = true
        save(state)
        return { ok: true, mandateId: m.id, confirmed: true, confirmedBy: m.confirmedBy, governanceApproval: m.governanceApproval, receiptHash: null, grant: null }
      }
      // Front door. Confirmation requires a valid aukora.x6.owner-grant.v1
      // signature from a PINNED owner key. The caller cannot supply its own trust root.
      const grantStatus = verifyOwnerGrant(crypto, ownerPublicKeys(fs, crypto), input.ownerGrant, m, ticket ? ticket.id : null, headNow())
      if (grantStatus !== 'verified') {
        const reason = grantStatus === 'missing' ? 'OWNER_SIGNATURE_REQUIRED'
          : grantStatus === 'untrusted-key' ? 'OWNER_KEY_UNTRUSTED'
          : grantStatus === 'binding-mismatch' ? 'OWNER_BINDING_MISMATCH'
          : grantStatus === 'identity-rejected' ? 'OWNER_IDENTITY_REJECTED'
          : grantStatus === 'malformed' ? 'OWNER_GRANT_MALFORMED'
          : 'OWNER_SIGNATURE_INVALID'
        m.confirmed = false
        m.confirmedBy = 'agent-self-unverified'
        m.lastConfirmAttempt = { by: input.by || 'unspecified', at: now(), refused: true, reason }
        const refusal = attention(state, 'owner-confirmation-refused', {
          mandateId: m.id,
          title: m.title,
          attemptedBy: input.by || 'unspecified',
          detail: grantStatus,
          note: 'Requires a valid aukora.x6.owner-grant.v1 signature from a pinned owner key',
        })
        save(state)
        return {
          ok: false,
          error: reason,
          ownerGrantStatus: grantStatus,
          mandateId: m.id,
          confirmed: false,
          confirmedBy: 'agent-self-unverified',
          receiptHash: null,
          receiptLeafHash: null,
          grant: null,
          attention: refusal,
        }
      }
      m.ownerGrant = input.ownerGrant
      const by = input.ownerGrant.identity
      const appended = await appendGrantReceipt(m, ticket ? ticket.id : null, by)
      if (!appended.ok) {
        // The signature verified here, but the single writer refused or could not record it: no receipt,
        // no confirmation. Nothing is minted on the strength of this organ's own check alone.
        delete m.ownerGrant
        m.lastConfirmAttempt = { by, at: now(), refused: true, reason: appended.error }
        save(state)
        return { ok: false, error: 'GRANT_RECEIPT_NOT_RECORDED', receiptError: appended.error, reason: appended.reason || null, mandateId: m.id, confirmed: false }
      }
      const rec = appended.record
      m.confirmed = true
      m.confirmedAt = now()
      m.confirmedBy = by
      if (rec) {
        m.receiptHash = rec.leafHash
        m.receiptLeafHash = rec.leafHash
        m.ballId = rec.data.ballId || m.ballId || ballIdNow()
        m.grant = {
          seq: rec.seq,
          hash: rec.leafHash,
          kind: 'mandate.grant',
          scope: m.scope,
          ticketId: ticket ? ticket.id : null,
          identity: by,
          ballId: m.ballId,
          epoch: rec.data.epoch,
        }
      }
      for (const a of state.attention) if (a.detail && a.detail.mandateId === m.id) a.resolved = true
      save(state)
      return { ok: true, mandateId: m.id, confirmedBy: m.confirmedBy, receiptHash: m.receiptHash, receiptLeafHash: m.receiptLeafHash, grant: m.grant || null }
    },

    assign(input) {
      const state = load()
      if (state.ok === false) return state
      const t = findTicket(state, input.ticketId)
      if (!t) return { ok: false, error: 'ticket-missing' }
      if (t.stoppedByPerson) return { ok: false, error: 'ticket-stopped-by-person' }
      const m = findMandate(state, t.mandateId)
      const bad = mandateUsable(m)
      if (bad) return { ok: false, error: bad }

      const executor = ['browser-worker', 'cloudflare-do', 'mac-limb'].includes(input.executor) ? input.executor : 'browser-worker'
      const ts = now()
      const a = {
        id: id('asg', { t: t.id, ex: executor, n: ts }),
        ticketId: t.id,
        mandateId: m.id,
        executor,
        state: 'running',
        lastReport: null,
        startedAt: ts,
        heartbeatAt: ts,
        reports: [],
      }
      m.budgetSteps -= 1
      state.assignments.push(a)
      save(state)
      return { ok: true, assignmentId: a.id, executor, remainingBudget: m.budgetSteps, receiptHash: m.receiptHash }
    },

    heartbeat(input) {
      const state = load()
      if (state.ok === false) return state
      const a = state.assignments.find((x) => x.id === input.assignmentId)
      if (!a) return { ok: false, error: 'assignment-missing' }
      a.heartbeatAt = now()
      for (const att of state.attention) {
        if (!att.resolved && att.kind === 'stale-heartbeat' && att.detail && att.detail.assignmentId === a.id) {
          att.resolved = true
        }
      }
      save(state)
      return { ok: true, assignmentId: a.id, heartbeatAt: a.heartbeatAt }
    },

    check_heartbeats(input) {
      const state = load()
      if (state.ok === false) return state
      const threshold = Number.isFinite(input && input.staleAfterMs) && input.staleAfterMs > 0 ? input.staleAfterMs : STALE_HEARTBEAT_MS
      const clock = now()
      const stale = []
      for (const a of state.assignments) {
        if (a.state !== 'running') continue
        const lastReportTime = Array.isArray(a.reports) && a.reports.length > 0 ? a.reports[a.reports.length - 1].at : null
        const pulse = a.heartbeatAt || lastReportTime || a.startedAt || 0
        const ageMs = clock - pulse
        if (ageMs > threshold) {
          const exists = state.attention.some((att) => !att.resolved && att.kind === 'stale-heartbeat' && att.detail && att.detail.assignmentId === a.id)
          const att = exists ? null : attention(state, 'stale-heartbeat', {
            assignmentId: a.id,
            ticketId: a.ticketId,
            note: `Heartbeat stale (${Math.round(ageMs / 1000)}s > ${Math.round(threshold / 1000)}s)`,
          })
          stale.push({ assignmentId: a.id, ageMs, attentionId: att ? att.id : null })
        }
      }
      if (stale.length > 0) save(state)
      return { ok: true, checkedAt: clock, staleAfterMs: threshold, staleCount: stale.length, stale }
    },

    report(input) {
      const state = load()
      if (state.ok === false) return state
      const a = state.assignments.find((x) => x.id === input.assignmentId)
      if (!a) return { ok: false, error: 'assignment-missing' }
      const allowed = ['progress', 'waiting', 'ready', 'blocked', 'failed', 'dropped']
      const status = allowed.includes(input.status) ? input.status : 'progress'
      const ts = now()
      const rec = { status, note: input.note || null, at: ts }
      a.reports.push(rec)
      a.lastReport = status
      a.heartbeatAt = ts
      if (status === 'ready' || status === 'failed' || status === 'dropped') a.state = 'ended'
      let att = null
      if (status === 'blocked' || status === 'waiting') {
        att = attention(state, status === 'blocked' ? 'assignment-blocked' : 'assignment-waiting', { assignmentId: a.id, note: rec.note })
      }
      const op = enqueue(state, 'obx_' + a.id + '_' + a.reports.length, { kind: 'assignment.report', assignmentId: a.id, status })
      save(state)
      return { ok: true, assignmentId: a.id, status, attention: att, outbox: op }
    },

    stop(input) {
      const state = load()
      if (state.ok === false) return state
      if (input.ticketId) {
        const t = findTicket(state, input.ticketId)
        if (t) {
          t.stoppedByPerson = true
          t.state = 'ended'
          t.outcome = 'stopped'
          const m = findMandate(state, t.mandateId)
          if (m) m.stopped = true
          for (const a of state.assignments) {
            if (a.ticketId === t.id && a.state === 'running') a.state = 'ended'
          }
        }
      }
      if (input.mandateId) { const m = findMandate(state, input.mandateId); if (m) m.stopped = true }
      save(state)
      return { ok: true, stoppedTicket: input.ticketId || null, stoppedMandate: input.mandateId || null }
    },

    outbox_flush() {
      const state = load()
      if (state.ok === false) return state
      const sent = []
      for (const o of state.outbox) {
        if (o.status === 'pending') { o.status = 'sent'; o.sentAt = now(); sent.push(o.id) }
      }
      save(state)
      return { ok: true, flushed: sent.length, ids: sent, pending: state.outbox.filter((o) => o.status === 'pending').length }
    },

    status() {
      const state = load()
      if (state.ok === false) return state
      return {
        ok: true,
        schema: 'auma.superagent.status.v1',
        observedAt: new Date().toISOString(),
        survivedRestart: true,
        updatedAt: state.updatedAt || now(),
        receiptHash: receiptHead(),
        ballId: ballIdNow(),
        counts: {
          triggers: state.triggers.length,
          threads: state.threads.length,
          mandates: state.mandates.length,
          tickets: state.tickets.filter((t) => t.state === 'open').length,
          assignments: state.assignments.filter((a) => a.state === 'running').length,
          attention: state.attention.filter((a) => !a.resolved).length,
          outboxPending: state.outbox.filter((o) => o.status === 'pending').length,
        },
        openTickets: state.tickets.filter((t) => t.state === 'open').map((t) => ({ id: t.id, title: t.title, stoppedByPerson: t.stoppedByPerson })),
        runningAssignments: state.assignments.filter((a) => a.state === 'running').map((a) => ({ id: a.id, executor: a.executor, lastReport: a.lastReport })),
        tickets: state.tickets,
        assignments: state.assignments.map((a) => {
          const last = Array.isArray(a.reports) && a.reports.length > 0 ? a.reports[a.reports.length - 1] : null
          return {
            ...a,
            heartbeatAt: a.heartbeatAt || (last && last.at) || a.startedAt || null,
            report: a.lastReport ? { state: a.lastReport, summary: (last && last.note) ? String(last.note) : String(a.lastReport) } : null,
          }
        }),
        outbox: state.outbox,
        mandates: state.mandates.map((m) => ({
          id: m.id,
          title: m.title,
          strength: m.strength,
          policyVersion: m.policyVersion || 'v1',
          scope: typeof m.scope === 'string' ? m.scope : JSON.stringify(m.scope || {}),
          expiry: new Date(m.expiresAt).toISOString(),
          confirmed: Boolean(m.confirmed),
          confirmedBy: m.confirmedBy || null,
          stopped: Boolean(m.stopped),
          budgetSteps: m.budgetSteps,
          receiptHash: m.receiptHash || null,
          receiptLeafHash: m.receiptLeafHash || m.receiptHash || null,
          grant: m.grant || null,
          governanceApproval: m.governanceApproval || null,
          ballId: m.ballId || null,
        })),
        attention: state.attention.filter((a) => !a.resolved).map((a) => ({
          ...a,
          text: a.text || detailSummary(a.kind, a.detail),
        })),
      }
    },
  }

  // Expose as a Cordis service where the runtime supports it. Guarded: a
  // registration failure must not take the organ down.
  let serviceRegistered = false
  try {
    if (typeof ctx.provide === 'function') { ctx.provide('auma.superagent'); serviceRegistered = true }
    if (typeof ctx.set === 'function') ctx.set('auma.superagent', api)
  } catch (_) { serviceRegistered = false }

  ctx.tools.register('auma_superagent', {
    description: 'SuperAgent coordination: triggers, mandates (strength/scope/receipt-bound), tickets, assignments across executors, heartbeats, structured reports, attention queue, idempotent outbox. Actions: trigger, subscribe, eval_accept, confirm, assign, heartbeat, check_heartbeats, report, stop, outbox_flush, status.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['trigger', 'subscribe', 'eval_accept', 'confirm', 'assign', 'heartbeat', 'check_heartbeats', 'report', 'stop', 'outbox_flush', 'status'] },
        source: { type: 'string' },
        kind: { type: 'string' },
        payload: {},
        subscription: { type: 'string' },
        title: { type: 'string' },
        triggerId: { type: 'string' },
        strength: { type: 'string', enum: ['explicit', 'inferred'] },
        scope: { type: 'object', description: 'Bounded scope. Omitted expiresAt defaults to six hours; supplied expiry must be a future integer epoch-millisecond timestamp within ISO years 0000–9999.' },
        promotionBinding: { type: 'object' },
        policyVersion: { type: 'string' },
        receiptHash: { type: 'string' },
        receiptLeafHash: { type: 'string' },
        mandateId: { type: 'string' },
        ticketId: { type: 'string' },
        assignmentId: { type: 'string' },
        executor: { type: 'string', enum: ['browser-worker', 'cloudflare-do', 'mac-limb'] },
        status: { type: 'string', enum: ['progress', 'waiting', 'ready', 'blocked', 'failed', 'dropped'] },
        note: { type: 'string' },
        by: { type: 'string' },
        staleAfterMs: { type: 'number' },
      },
      required: ['action'],
      additionalProperties: true,
    },
    async execute(input) {
      const action = input && input.action
      try {
        if (typeof api[action] !== 'function') return { output: JSON.stringify({ ok: false, error: 'unknown-action', action }) }
        const result = await api[action](input)
        result.serviceRegistered = serviceRegistered
        return { output: JSON.stringify(result, null, 2) }
      } catch (e) {
        return { output: JSON.stringify({ ok: false, error: e && e.message ? e.message : String(e) }) }
      }
    },
  })
}
