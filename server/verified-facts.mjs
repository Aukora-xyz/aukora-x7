/** Counts from verified snapshots only. This module uses Web Crypto on both runtimes. */
import { canonicalJson, verifyHybridEnvelopeV2 } from '../deploy/cloudflare/src/owner-grant-policy.mjs'
import { auraInputsComplete } from './aura-rules.mjs'
import { verifyAumlokInviteReceipt } from '../deploy/cloudflare/src/aumlok.mjs'

const count = n => Number.isSafeInteger(n) && n >= 0 && !Object.is(n, -0)
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const publicKey = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const bridgeDomain = 'aukora.checkpoint-signer-bridge.v2\0'
const finiteCheckpoint = value => count(value) && value > 0 && value < Number.MAX_SAFE_INTEGER
const signerTrust = new Set(['unpinned', 'pinned', 'mismatch', 'invalid-pin'])
const hex = bytes => [...new Uint8Array(bytes)].map(n => n.toString(16).padStart(2, '0')).join('')
const bytes = value => Uint8Array.from(value.match(/../g) ?? [], n => parseInt(n, 16))
const hash = async value => hex(await crypto.subtle.digest('SHA-256', typeof value === 'string' ? new TextEncoder().encode(value) : value))
const requireFact = condition => { if (!condition) throw Object.assign(new Error('AURA_CHECKPOINT_INVALID'), { code: 'AURA_CHECKPOINT_INVALID' }) }

/** Parse optional, independently configured public trust. Candidate-writable files must never supply this input.
 * @param {unknown} value Pin object or bounded JSON text; undefined means no configured pin.
 * @returns {object} Absent, invalid, or configured public key and optional finite legacy upper bound.
 */
export function parseCheckpointSignerPin(value) {
  if (value === undefined) return { status: 'absent' }
  if (typeof value === 'string') {
    if (value.length > 4096) return { status: 'invalid' }
    try { value = JSON.parse(value) } catch (_error) { return { status: 'invalid' } }
  }
  const bounded = object(value) && Object.hasOwn(value, 'validToCheckpoint')
  if (!object(value) || Object.keys(value).length !== (bounded ? 4 : 3) || value.schema !== 'aukora.checkpoint-signer.v1'
    || value.domain !== 'aukora.x5.edge-head.v1' || !publicKey(value.publicKeyHex)
    || (bounded && !finiteCheckpoint(value.validToCheckpoint))) return { status: 'invalid' }
  return { status: 'configured', publicKeyHex: value.publicKeyHex,
    ...(bounded ? { validToCheckpoint: value.validToCheckpoint } : {}) }
}

/** Parse independently configured, finite signer sequence windows. Mirror files cannot authorize rotation.
 * @param {unknown} value Policy object or bounded JSON text; absent input leaves signers unpinned.
 * Legacy windows beyond checkpoint 14 require explicit finite configuration. Once v2 begins, v1 cannot resume.
 * @returns {object} Absent, invalid, or normalized contiguous ranges beginning at checkpoint one. Parsed v2 bridges still require signature verification.
 */
export function parseCheckpointSignerPolicy(value) {
  if (value === undefined) return { status: 'absent' }
  if (typeof value === 'string') {
    if (value.length > 1024 * 1024) return { status: 'invalid' }
    try { value = JSON.parse(value) } catch (_error) { return { status: 'invalid' } }
  }
  if (!object(value) || Object.keys(value).length !== 3 || !Array.isArray(value.ranges)
    || value.ranges.length < 1 || value.ranges.length > 256) return { status: 'invalid' }
  const hybrid = value.schema === 'aukora.checkpoint-signer.v2' && value.domain === 'aukora.hybrid.v2'
  if (!hybrid && (value.schema !== 'aukora.checkpoint-signer-policy.v1' || value.domain !== 'aukora.x5.edge-head.v1')) return { status: 'invalid' }
  const ranges = []
  const hybridKeys = new Set()
  let hybridStarted = false
  let next = 1
  for (const range of value.ranges) {
    if (hybrid) {
      if (!object(range) || range.validFromCheckpoint !== next || !count(range.validToCheckpoint)
        || range.validToCheckpoint < next || range.validToCheckpoint >= Number.MAX_SAFE_INTEGER || !publicKey(range.publicKeyHex)
        || !['v1', 'v2'].includes(range.envelope)
        || (range.envelope === 'v1' ? Object.keys(range).length !== 4 || hybridStarted
          : Object.keys(range).length !== 6 || next < 15 || !ranges.length
            || typeof range.mlDsaPublicKeyHex !== 'string' || !/^[a-f0-9]{3904}$/.test(range.mlDsaPublicKeyHex)
            || typeof range.countersignatureHex !== 'string' || !/^[a-f0-9]{128}$/.test(range.countersignatureHex))) return { status: 'invalid' }
      if (range.envelope === 'v2') {
        const identity = range.publicKeyHex + ':' + range.mlDsaPublicKeyHex
        if (hybridKeys.has(identity)) return { status: 'invalid' }
        hybridKeys.add(identity)
        hybridStarted = true
      }
      ranges.push(Object.freeze({ firstSeq: next, lastSeq: range.validToCheckpoint, publicKeyHex: range.publicKeyHex,
        envelope: range.envelope, ...(range.envelope === 'v2'
          ? { mlDsaPublicKeyHex: range.mlDsaPublicKeyHex, countersignatureHex: range.countersignatureHex } : {}) }))
      next = range.validToCheckpoint + 1
      continue
    }
    if (!object(range) || Object.keys(range).length !== 3 || range.firstSeq !== next
      || !count(range.lastSeq) || range.lastSeq < next || range.lastSeq >= Number.MAX_SAFE_INTEGER
      || !publicKey(range.publicKeyHex)) return { status: 'invalid' }
    ranges.push({ firstSeq: next, lastSeq: range.lastSeq, publicKeyHex: range.publicKeyHex })
    next = range.lastSeq + 1
  }
  return { status: 'configured', ranges, ...(hybrid ? { envelope: 'v2' } : {}) }
}

/** Authenticate independently configured signer windows before host readers expose or use them.
 * @param {unknown} value Public policy object or bounded JSON text; missing input remains absent.
 * @param {Function} check Optional cancellation check between bridge verifications.
 * @returns {Promise<object>} Normalized configuration, or invalid when any outgoing-key countersignature fails.
 */
export async function verifyCheckpointSignerPolicy(value, check = () => {}) {
  const policy = parseCheckpointSignerPolicy(value)
  if (policy.status !== 'configured' || policy.envelope !== 'v2') return policy
  for (const [index, range] of policy.ranges.entries()) {
    if (range.envelope !== 'v2') continue
    check()
    const entry = { validFromCheckpoint: range.firstSeq, validToCheckpoint: range.lastSeq,
      envelope: 'v2', publicKeyHex: range.publicKeyHex, mlDsaPublicKeyHex: range.mlDsaPublicKeyHex }
    // Each successor binds its complete finite window to the immediately outgoing, independently configured key.
    const outgoing = policy.ranges[index - 1]
    let verified = false
    try {
      const key = await crypto.subtle.importKey('raw', bytes(outgoing.publicKeyHex), 'Ed25519', false, ['verify'])
      verified = await crypto.subtle.verify('Ed25519', key, bytes(range.countersignatureHex),
        new TextEncoder().encode(bridgeDomain + canonicalJson(entry)))
    } catch (_error) { return { status: 'invalid' } }
    if (!verified) return { status: 'invalid' }
  }
  check()
  return policy
}

/** Validate recorded build metadata without claiming the selected organs execute that source revision.
 * @param {unknown} value BUILD_INFO.json object or bounded text; absent or invalid input reports no source commit.
 * @returns {object} Payload-free recorded commit status, separate from independent signer or owner authority.
 */
export function projectBuildInfo(value) {
  const unavailable = status => ({ status, organSourceCommit: null })
  if (value === undefined) return unavailable('unavailable')
  if (typeof value === 'string') {
    if (new TextEncoder().encode(value).byteLength > 65536) return unavailable('invalid')
    try { value = JSON.parse(value) } catch (_error) { return unavailable('invalid') }
  }
  if (!object(value) || Object.keys(value).length !== 4 || value.schema !== 'aukora.build-info.v1'
    || typeof value.organSourceCommit !== 'string' || !/^[a-f0-9]{40}$/.test(value.organSourceCommit)
    || typeof value.builtAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.builtAt)
    || !Number.isFinite(Date.parse(value.builtAt)) || new Date(value.builtAt).toISOString() !== value.builtAt
    || !object(value.candidateOrgans) || Object.keys(value.candidateOrgans).length > 256
    || Object.entries(value.candidateOrgans).some(([name, entry]) => !/^[a-z][a-z0-9-]{0,63}$/.test(name)
      || !object(entry) || Object.keys(entry).length !== 3 || !publicKey(entry.activeSha256)
      || !publicKey(entry.candidateSha256) || !count(entry.bytes) || entry.bytes > 24 * 1024 * 1024)) return unavailable('invalid')
  return { status: 'recorded-build-info', organSourceCommit: value.organSourceCommit }
}

/** Validate the payload-free build metadata projection crossing the MirrorDO read response.
 * @param {unknown} value Projected build metadata; absent input is unavailable and malformed input is invalid.
 * @returns {object} Recorded source commit only, never runtime identity or trust authority.
 */
export function projectSourceMetadata(value) {
  if (value === undefined) return { status: 'unavailable', organSourceCommit: null }
  if (!object(value) || Object.keys(value).length !== 2
    || !['recorded-build-info', 'unavailable', 'invalid'].includes(value.status)
    || (value.status === 'recorded-build-info'
      ? typeof value.organSourceCommit !== 'string' || !/^[a-f0-9]{40}$/.test(value.organSourceCommit)
      : value.organSourceCommit !== null)) return { status: 'invalid', organSourceCommit: null }
  return { status: value.status, organSourceCommit: value.organSourceCommit }
}

const emptyAumlok = () => ({ phase: 'UNAVAILABLE', bound: null, passkeyVerified: null, authorityAvailable: null,
  enrollmentAvailable: null, biometricVerified: false, phraseRecoveryAvailable: false,
  invite: { quotaMonth: null, issuedThisMonth: null, limit: 3, revokedCount: null } })
const statusFields = ['ok', 'schema', 'phase', 'bound', 'passkeyVerified', 'aumlokId', 'nodePubkeyHex', 'commitmentSha256',
  'boundAt', 'lastVerifiedAt', 'authorityAvailable', 'enrollmentAvailable', 'blockers', 'biometricVerified',
  'phraseRecoveryAvailable', 'identityIsKey', 'domainIsPointer', 'invite']
const revisionFields = ['enrollmentCount', 'rotationSeq', 'keyCommitmentId', 'approvedGrants']
const custodyFields = ['lastRotationChallengeId', 'pepperSeparated', 'pepperMigrationRequired', 'phraseBlockers']
const exact = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
const statusTime = value => count(value) && value <= 8640000000000000

function publicApprovalValid(record, generation) {
  if (!exact(record, ['schema', 'approvalId', 'binding', 'generation', 'approvedAt', 'expiresAt', 'consumedAt', 'recordMac'])
    || record.schema !== 'aumlok.approval.v1' || !/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(record.approvalId)
    || record.generation !== generation || !statusTime(record.approvedAt) || !statusTime(record.expiresAt)
    || record.expiresAt !== record.approvedAt + 300000 || !publicKey(record.recordMac)
    || (record.consumedAt !== null && (!statusTime(record.consumedAt) || record.consumedAt < record.approvedAt || record.consumedAt >= record.expiresAt))) return false
  const binding = record.binding
  if (!object(binding) || typeof binding.audience !== 'string' || binding.audience.length > 253) return false
  let audience
  try { audience = new URL(binding.audience) } catch (_error) { return false }
  if (audience.origin !== binding.audience || (audience.protocol !== 'https:'
    && !(audience.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(audience.hostname)))) return false
  return exact(binding, ['schema', 'audience', 'method', 'pathname', 'bodySha256'])
    && binding.schema === 'aukora.class3.action.v1' && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(binding.method)
    && typeof binding.pathname === 'string' && /^\/[A-Za-z0-9/_-]{1,180}$/.test(binding.pathname) && publicKey(binding.bodySha256)
    || exact(binding, ['schema', 'audience', 'action', 'ballId', 'epoch', 'organId', 'candidateSha256'])
    && binding.schema === 'aukora.class3.head-promotion.v1' && binding.action === 'head.promote'
    && publicKey(binding.ballId) && count(binding.epoch) && publicKey(binding.candidateSha256)
    && typeof binding.organId === 'string' && /^[a-z][a-z0-9-]{0,40}$/.test(binding.organId)
}

/** Project only a trusted host's AUMLOK status, never mirror identity files or client assertions.
 * @param {unknown} value Result from the durable AUMLOK store; absent, unavailable or inconsistent status stays unknown.
 * @returns {object} Aggregate binding and verifier status without credential IDs, keys or commitments. Legacy and lifetime invite counts and complete custody fields are validated but never grant authority.
 */
export function projectAumlokStatus(value) {
  const lifetimeInvite = object(value) && object(value.invite) && Object.hasOwn(value.invite, 'lifetimeIssuedCount')
  const custody = object(value) && custodyFields.some(key => Object.hasOwn(value, key))
  const extended = custody || object(value) && revisionFields.some(key => Object.hasOwn(value, key))
  if (!exact(value, custody ? [...statusFields, ...revisionFields, ...custodyFields] : extended ? [...statusFields, ...revisionFields] : statusFields)
    || value.ok !== true || value.schema !== 'aukora.aumlok.status.v1' || !['BOUND', 'UNBOUND'].includes(value.phase)
    || value.bound !== (value.phase === 'BOUND') || value.passkeyVerified !== value.bound
    || typeof value.enrollmentAvailable !== 'boolean' || typeof value.authorityAvailable !== 'boolean'
    || (value.bound && value.enrollmentAvailable) || (value.authorityAvailable && !(value.bound || value.enrollmentAvailable))
    || value.biometricVerified !== false || value.phraseRecoveryAvailable !== false || value.identityIsKey !== true || value.domainIsPointer !== true
    || !Array.isArray(value.blockers) || value.blockers.length > 16 || value.blockers.some(code => typeof code !== 'string' || !/^(AUMLOK_[A-Z_]{1,64}|NODE_KEY_IS_NOT_OWNER_KEY)$/.test(code))
    || (!value.authorityAvailable && (value.bound || value.enrollmentAvailable)
      && !value.blockers.some(code => ['AUMLOK_OWNER_KEY_UNAVAILABLE', 'NODE_KEY_IS_NOT_OWNER_KEY'].includes(code)))
    || (value.bound ? !publicKey(value.aumlokId) || !publicKey(value.nodePubkeyHex) || value.commitmentSha256 !== null
      || !statusTime(value.boundAt) || !statusTime(value.lastVerifiedAt) || value.lastVerifiedAt < value.boundAt
      : [value.aumlokId, value.nodePubkeyHex, value.commitmentSha256, value.boundAt, value.lastVerifiedAt].some(field => field !== null))
    || (extended && (!count(value.enrollmentCount) || value.enrollmentCount > 1 || (value.bound && value.enrollmentCount !== 1)
      || !count(value.rotationSeq) || value.rotationSeq >= Number.MAX_SAFE_INTEGER
      || (value.bound ? !publicKey(value.keyCommitmentId) : value.keyCommitmentId !== null || value.rotationSeq !== 0)
      || (value.enrollmentAvailable && value.enrollmentCount !== 0)
      || !Array.isArray(value.approvedGrants) || value.approvedGrants.length > 8 || (!value.bound && value.approvedGrants.length !== 0)
      || value.approvedGrants.some(record => !publicApprovalValid(record, value.rotationSeq + 1))
      || new Set(value.approvedGrants.map(record => record.approvalId)).size !== value.approvedGrants.length))
    || (custody && ((value.lastRotationChallengeId !== null && (typeof value.lastRotationChallengeId !== 'string'
      || !/^[A-Za-z0-9_-]{16,128}$/.test(value.lastRotationChallengeId) || !value.bound || value.rotationSeq === 0))
      || typeof value.pepperSeparated !== 'boolean' || (value.pepperSeparated && !value.bound)
      || typeof value.pepperMigrationRequired !== 'boolean' || (value.pepperSeparated && value.pepperMigrationRequired)
      || !Array.isArray(value.phraseBlockers) || value.phraseBlockers.length > 1
      || value.phraseBlockers.some(code => !['AUMLOK_PHRASE_GUARDIAN_QUORUM_REQUIRED', 'AUMLOK_PHRASE_RATE_LIMITED'].includes(code))))
    || !exact(value.invite, ['quotaMonth', 'issuedThisMonth', 'limit', 'revokedCount', ...(lifetimeInvite ? ['lifetimeIssuedCount'] : [])])
    || typeof value.invite.quotaMonth !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(value.invite.quotaMonth)
    || !count(value.invite.issuedThisMonth) || value.invite.issuedThisMonth > 3 || value.invite.limit !== 3
    || !count(value.invite.revokedCount) || value.invite.revokedCount > 128
    || (lifetimeInvite && (!count(value.invite.lifetimeIssuedCount) || value.invite.lifetimeIssuedCount > 128
      || value.invite.lifetimeIssuedCount < Math.max(value.invite.issuedThisMonth, value.invite.revokedCount)
      || (!value.bound && value.invite.lifetimeIssuedCount !== 0)))
    || (!value.bound && (value.invite.issuedThisMonth !== 0 || value.invite.revokedCount !== 0))) return emptyAumlok()
  return { phase: value.phase, bound: value.bound, passkeyVerified: value.passkeyVerified, authorityAvailable: value.authorityAvailable,
    enrollmentAvailable: value.enrollmentAvailable, biometricVerified: false, phraseRecoveryAvailable: false,
    invite: { quotaMonth: value.invite.quotaMonth, issuedThisMonth: value.invite.issuedThisMonth, limit: 3, revokedCount: value.invite.revokedCount } }
}

/** Verify signed invitation history against an independently supplied sponsor key, never its own signer claim.
 * @param {object[]} rows Bounded public invite receipts. Duplicate IDs or monthly sequence slots reject the history.
 * @param {object} options trustedSponsorPubkeyHex from authoritative BOUND state and optional cancellation check.
 * @returns {Promise<object>} Signature counts only; current revocation, expiry eligibility and redemption remain unverified.
 */
export async function verifyFactInvites(rows, { trustedSponsorPubkeyHex, check = () => {} } = {}) {
  const unverified = { revocation: 'unverified', redemption: 'unverified', currentEligibility: 'unverified', behavioralStanding: 'unverified', ownerApproval: false, independentAudit: false }
  if (!Array.isArray(rows) || rows.length > 128) return { status: 'unavailable', receiptsTotal: null, signaturesVerified: null, sponsorTrust: 'unpinned', ...unverified }
  const trust = trustedSponsorPubkeyHex === undefined ? 'unpinned' : publicKey(trustedSponsorPubkeyHex) ? 'pinned' : 'invalid-pin'
  const ids = new Set(), slots = new Set()
  let verified = 0, invalid = false, sponsorMismatch = false
  for (const row of rows) {
    check()
    if (!object(row)) { invalid = true; continue }
    if (trust === 'pinned' && row.sponsorPubkeyHex !== trustedSponsorPubkeyHex) sponsorMismatch = true
    if (!await verifyAumlokInviteReceipt(row, trustedSponsorPubkeyHex)) { invalid = true; continue }
    const slot = `${row.sponsorPubkeyHex}:${row.quotaMonth}:${row.monthlySequence}`
    if (ids.has(row.inviteId) || slots.has(slot)) { invalid = true; continue }
    ids.add(row.inviteId); slots.add(slot); verified++
  }
  check()
  return { status: !rows.length ? 'not-recorded' : invalid ? 'unverified' : 'signature-verified',
    receiptsTotal: rows.length, signaturesVerified: invalid ? null : verified,
    sponsorTrust: sponsorMismatch ? 'mismatch' : trust, ...unverified }
}

const emptyTask = status => ({ status, retentionPassed: null, retentionTotal: null,
  qualifiedForPromotion: null, graderControlsPassed: null, routeEvidenceStatus: null })
const routeStatuses = new Set(['unsupported', 'checked', 'violated', 'inconclusive'])

// A hash-chain receipt preserves a recorded outcome, but cannot grant runtime promotion admission.
function recordedTaskOutcome(receipts) {
  const challenge = receipts.findLast(row => row.kind === 'pearl.challenge')
  if (!challenge) return emptyTask('not-recorded')
  const data = challenge.data
  if (!object(data) || data.authorityTier !== 'self-attested' || data.realm !== 'scion-trial-worker'
    || data.admissionScope !== 'behavioral-retention-only' || data.candidateId !== 'candidate'
    || !Array.isArray(data.candidates) || data.candidates.length !== 2
    || data.candidates.some(value => !object(value))
    || data.candidates.filter(value => value.label === 'candidate').length !== 1
    || data.candidates.filter(value => value.label === 'baseline').length !== 1) return emptyTask('unverified')
  const candidate = data.candidates.find(value => value.label === 'candidate')
  const controls = candidate.graderControls, route = candidate.routeEvidence
  if (!count(candidate.passedCases) || !count(candidate.totalCases) || candidate.totalCases < 1 || candidate.totalCases > 256
    || candidate.passedCases > candidate.totalCases || candidate.passed !== candidate.passedCases || candidate.total !== candidate.totalCases
    || !Array.isArray(candidate.retentionResults) || candidate.retentionResults.length !== candidate.totalCases
    || candidate.retentionResults.some(value => !object(value) || typeof value.id !== 'string' || value.id.length < 1 || value.id.length > 128 || typeof value.pass !== 'boolean')
    || new Set(candidate.retentionResults.map(value => value.id)).size !== candidate.totalCases
    || candidate.retentionResults.filter(value => value.pass).length !== candidate.passedCases
    || typeof candidate.trialOk !== 'boolean' || typeof candidate.qualifiedForPromotion !== 'boolean'
    || data.qualifiedForPromotion !== candidate.qualifiedForPromotion
    || !object(controls) || ['allPassed', 'knownGoodAccepted', 'knownBadRejected', 'acceptAllRejected', 'rejectAllRejected'].some(key => typeof controls[key] !== 'boolean')
    || !object(route) || !routeStatuses.has(route.status)) return emptyTask('unverified')
  const graderControlsPassed = controls.knownGoodAccepted && controls.knownBadRejected && controls.acceptAllRejected && controls.rejectAllRejected
  if (controls.allPassed !== graderControlsPassed || (candidate.qualifiedForPromotion
    && (!candidate.trialOk || !graderControlsPassed || candidate.passedCases !== candidate.totalCases || route.status === 'violated'))) return emptyTask('unverified')
  return { status: 'self-attested', retentionPassed: candidate.passedCases, retentionTotal: candidate.totalCases,
    qualifiedForPromotion: null, graderControlsPassed, routeEvidenceStatus: route.status }
}

function projectTask(value) {
  if (!object(value) || value.status !== 'self-attested') return emptyTask(value?.status === 'not-recorded' ? 'not-recorded' : 'unverified')
  if (!count(value.retentionPassed) || !count(value.retentionTotal) || value.retentionTotal < 1 || value.retentionTotal > 256
    || value.retentionPassed > value.retentionTotal || value.qualifiedForPromotion !== null
    || typeof value.graderControlsPassed !== 'boolean' || !routeStatuses.has(value.routeEvidenceStatus)) return emptyTask('unverified')
  return { status: value.status, retentionPassed: value.retentionPassed, retentionTotal: value.retentionTotal,
    qualifiedForPromotion: null, graderControlsPassed: value.graderControlsPassed, routeEvidenceStatus: value.routeEvidenceStatus }
}

function projectCalibration(input, complete) {
  const scores = complete ? input.observedSurpriseScores : undefined
  const available = Array.isArray(scores) && scores.length <= 4096
    && Array.from(scores).every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && !Object.is(value, -0))
  let mean = 0
  // Nonnegative bounded errors permit an online mean without an overflowing intermediate sum.
  if (available) for (const [index, score] of scores.entries()) mean += (score - mean) / (index + 1)
  return { status: !available ? 'unavailable' : scores.length ? 'observed' : 'insufficient-samples', version: 'receipt-error-v1',
    samples: available ? scores.length : null, minSamples: null,
    receiptErrorMean: available && scores.length && Number.isFinite(mean) ? mean : null,
    receiptErrorLast: available && scores.length ? scores.at(-1) : null }
}

/** Verify checkpoint chains, public signatures and covered receipt prefixes; no signer is implicitly trusted.
 * @param {object[]} rows Bounded parsed checkpoint records.
 * @param {object[]} receipts Already hash-chain-verified receipts.
 * @param {Function} check Cancellation check invoked between cryptographic operations.
 * @param {object} options Optional checkpointSignerPin or checkpointSignerPolicy from independent host configuration.
 * Absent inputs leave all signers unpinned; supplying both is invalid and cannot downgrade rotation to a single-key pin.
 * @returns {Promise<object>} Bounded aggregate counts, never receipt payloads or signing material.
 */
export async function verifyFactCheckpoints(rows, receipts, check = () => {}, { checkpointSignerPin, checkpointSignerPolicy } = {}) {
  requireFact(Array.isArray(rows) && rows.length <= 256 && Array.isArray(receipts) && receipts.length <= 4096)
  const pin = parseCheckpointSignerPin(checkpointSignerPin)
  const policy = await verifyCheckpointSignerPolicy(checkpointSignerPolicy, check)
  const signers = new Set()
  let policyMatches = true
  let previous = null, coverage = 0
  for (const [index, row] of rows.entries()) {
    check()
    requireFact(object(row))
    const hybrid = Object.hasOwn(row, 'envelope')
    const body = hybrid ? row.envelope?.payload : row.body
    const range = policy.status === 'configured' ? policy.ranges.find(value => index + 1 >= value.firstSeq && index + 1 <= value.lastSeq) : undefined
    requireFact(object(body) && body.schema === 'aukora.edge-checkpoint.v1' && body.seq === index + 1
      && typeof body.at === 'string' && Number.isFinite(Date.parse(body.at))
      && count(body.receiptCount) && body.receiptCount >= coverage && body.receiptCount <= receipts.length
      && body.prevCheckpointHash === previous)
    if (hybrid) {
      requireFact(body.seq >= 15 && Object.keys(row).length === 2 && Object.hasOwn(row, 'checkpointHash')
        && pin.status === 'absent' && policy.status === 'configured' && policy.envelope === 'v2' && range?.envelope === 'v2')
    } else {
      const boundedLegacy = pin.status === 'configured' && policy.status === 'absent'
        ? pin.publicKeyHex === row.publicKeyHex && body.seq <= pin.validToCheckpoint
        : pin.status === 'absent' && policy.status === 'configured' && range
          && range.envelope !== 'v2' && range.publicKeyHex === row.publicKeyHex
      requireFact((body.seq <= 14 || boundedLegacy) && publicKey(row.publicKeyHex) && /^[a-f0-9]{128}$/.test(row.signatureHex)
        && (!range?.envelope || range.envelope === 'v1'))
    }
    let level = receipts.slice(0, body.receiptCount).map(item => bytes(item.leafHash ?? item.hash))
    while (level.length > 1) {
      const next = []
      for (let i = 0; i < level.length; i += 2) {
        check()
        next.push(i + 1 === level.length ? level[i] : bytes(await hash(Uint8Array.from([1, ...level[i], ...level[i + 1]]))))
      }
      level = next
    }
    requireFact(body.merkleRoot === (level.length ? hex(level[0]) : await hash(''))
      && body.lastReceiptHash === (body.receiptCount ? (receipts[body.receiptCount - 1].leafHash ?? receipts[body.receiptCount - 1].hash) : '0'.repeat(64)))
    if (hybrid) {
      await verifyHybridEnvelopeV2(row.envelope, { artifact: 'checkpoint', trustedKeys: {
        ed25519PublicKeyHex: range.publicKeyHex, mlDsaPublicKeyHex: range.mlDsaPublicKeyHex,
      } })
      previous = await hash(canonicalJson(row.envelope))
    } else {
      const key = await crypto.subtle.importKey('raw', bytes(row.publicKeyHex), 'Ed25519', false, ['verify'])
      requireFact(await crypto.subtle.verify('Ed25519', key, bytes(row.signatureHex), new TextEncoder().encode('aukora.x5.edge-head.v1\0' + canonicalJson(body))))
      previous = await hash(canonicalJson({ body, publicKeyHex: row.publicKeyHex, signatureHex: row.signatureHex }))
    }
    requireFact(row.checkpointHash === previous)
    signers.add(hybrid ? range.publicKeyHex : row.publicKeyHex)
    if (policy.status === 'configured') {
      if (!range || (!hybrid && range.publicKeyHex !== row.publicKeyHex)) policyMatches = false
    }
    coverage = body.receiptCount
  }
  const kinds = new Map()
  for (const receipt of receipts) {
    requireFact(/^[a-zA-Z0-9_.:-]{1,80}$/.test(receipt.kind))
    kinds.set(receipt.kind, (kinds.get(receipt.kind) ?? 0) + 1)
    requireFact(kinds.size <= 256)
  }
  check()
  return { receiptsByKind: Object.fromEntries([...kinds].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)),
    checkpointsTotal: rows.length, lastCheckpointSeq: rows.length ? rows.length : null,
    lastCheckpointReceiptCount: rows.length ? coverage : null,
    checkpointVerification: 'signature-and-receipt-prefix',
    checkpointSignerTrust: pin.status === 'invalid' || policy.status === 'invalid'
      || (pin.status !== 'absent' && policy.status !== 'absent') ? 'invalid-pin'
      : signers.size === 0 ? 'unpinned' : policy.status === 'configured' ? policyMatches ? 'pinned' : 'mismatch'
        : pin.status === 'absent' ? 'unpinned' : [...signers].every(value => value === pin.publicKeyHex)
          && (pin.validToCheckpoint === undefined || rows.length <= pin.validToCheckpoint) ? 'pinned' : 'mismatch',
    taskOutcome: recordedTaskOutcome(receipts),
    receiptVerification: 'hash-and-chain', ownerApproval: false, independentAudit: false }
}

/** Project a complete coherent evidence snapshot to a deterministic, payload-free public response.
 * @param {string} runtime Runtime name.
 * @param {object} input Fresh verified Aura snapshot with optional verified checkpoint facts.
 * @param {object} options Optional aumlokStatus from the trusted durable ceremony store; absent status stays unknown.
 * @returns {object} Explicit nulls for unavailable counts; incomplete Aura does not erase verified counts.
 */
export function projectVerifiedFacts(runtime, input, { aumlokStatus } = {}) {
  const complete = input?.evidence?.status === 'complete' && input?.facts != null
  const auraComplete = complete && input?.aura?.status !== 'incomplete' && input?.aura?.vector != null && auraInputsComplete(input)
  const metric = key => complete && count(input[key]) ? input[key] : null
  const build = input?.sourceMetadata === undefined ? projectBuildInfo(input?.buildInfo) : projectSourceMetadata(input.sourceMetadata)
  return { ok: complete, runtime, epoch: complete ? input.aura?.epoch ?? input.head?.epoch ?? null : null,
    ballId: complete ? input.aura?.ballId ?? input.head?.ballId ?? null : null,
    organCount: metric('declaredOrgans'), activeOrganCount: metric('activeOrgans'), receiptTotal: metric('totalReceipts'),
    receiptsVerified: metric('verifiedReceipts'), receiptsByKind: complete ? input.facts.receiptsByKind : null,
    checkpointsTotal: complete ? input.facts.checkpointsTotal : null, lastCheckpointSeq: complete ? input.facts.lastCheckpointSeq : null,
    lastCheckpointReceiptCount: complete ? input.facts.lastCheckpointReceiptCount : null,
    dagReachable: metric('reachableDagNodes'), dagDeclared: metric('declaredDagNodes'),
    auraStatus: auraComplete ? input.aura.status : 'incomplete', wakeUrgency: auraComplete ? input.aura.vector.wakeUrgency : null,
    ...(complete ? { receiptVerification: input.facts.receiptVerification, checkpointVerification: input.facts.checkpointVerification,
      checkpointSignerTrust: signerTrust.has(input.facts.checkpointSignerTrust) ? input.facts.checkpointSignerTrust : 'unpinned' } : {}),
    taskOutcome: complete ? projectTask(input.facts.taskOutcome) : emptyTask('unavailable'),
    predictionCalibration: projectCalibration(input, complete),
    organSourceCommit: build.organSourceCommit, organSourceEvidence: build.status,
    aumlok: projectAumlokStatus(aumlokStatus),
    // Neither a mirror gates.json nor receipt payloads establish protected runner or provider-call evidence.
    gates: { status: 'unverified' },
    modelAttribution: { evidenceQuality: 'unknown', requestedModel: null, providerReportedModel: null, immutableRevision: null },
    evidenceStatus: complete ? 'complete' : 'incomplete',
    organCounts: 'declared-enabled-not-runtime-health', ownerApproval: false, independentAudit: false }
}
