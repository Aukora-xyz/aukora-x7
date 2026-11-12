/** Shared, keyless validation for owner-grant issuance. Browser headers are not owner approval. */
import { ml_dsa65 } from '@noble/post-quantum/ml-dsa.js'
import { proofError, proofIs, proofOutcome, settleProof } from './proof-failure-rule.mjs'
import { canonicalJson, isT2OnlyOrgan, T2_ONLY_ORGANS } from '../../../server/ball-transition.mjs'

export { canonicalJson }

/** Both signature algorithms bind this domain and the complete v2 algorithm manifest. */
export const HYBRID_ENVELOPE_DOMAIN = 'aukora.hybrid.v2\0'
export const HYBRID_ENVELOPE_SCHEMA = 'aukora.hybrid-envelope.v2'
const HYBRID_CONTEXT = new TextEncoder().encode('aukora.v2')
const HYBRID_ARTIFACTS = Object.freeze(['owner-key', 'checkpoint-signer', 'owner-grant', 'checkpoint', 'invite', 'signed-action'])
export const OWNER_GRANT_DOMAIN = 'aukora.x6.owner-grant.v1\0'
export const OWNER_GRANT_SCHEMA = 'aukora.x6.owner-grant.v1'
export const OWNER_GRANT_MAX_BODY_BYTES = 16 * 1024
export const REJECTED_OWNER_IDENTITIES = new Set(['spatial-tab', 'agent', 'agent-self-unverified', 'person'])
/** Governance organs cannot be covered by a standing self-build grant. */
export const OWNER_GOVERNANCE_ORGANS = T2_ONLY_ORGANS
const HEX_64 = /^[0-9a-f]{64}$/
const FIELDS = ['mandateId', 'ticketId', 'scope', 'ballId', 'epoch', 'expiresAt', 'identity']
const encoder = new TextEncoder()

/** Throw a public error without including request contents or private material. */
export function ownerGrantFailure(code, status = 400) {
  throw Object.assign(new Error(code), { code, status })
}

/** Reject a node identity reused as the independently configured owner authority.
 * @param {string} ownerPublicKeyHex Trusted owner key, never an envelope-supplied key.
 * @param {string|null} nodePublicKeyHex Trusted enrolled node key, or null before enrollment.
 * @returns {void} Invalid configuration or identical keys fail closed.
 */
export function requireOwnerNodeKeySeparation(ownerPublicKeyHex, nodePublicKeyHex = null) {
  if (typeof ownerPublicKeyHex !== 'string' || !HEX_64.test(ownerPublicKeyHex)) ownerGrantFailure('OWNER_KEY_NOT_CONFIGURED', 503)
  if (nodePublicKeyHex !== null && (typeof nodePublicKeyHex !== 'string' || !HEX_64.test(nodePublicKeyHex))) ownerGrantFailure('NODE_KEY_INVALID', 503)
  if (nodePublicKeyHex === ownerPublicKeyHex) ownerGrantFailure('NODE_KEY_IS_NOT_OWNER_KEY', 403)
}

const governanceEntry = (id, entry) => isT2OnlyOrgan(id, entry)
const execution = entry => entry ? { specifier: entry.specifier, disabled: entry.disabled, config: entry.config, governance: entry.governance } : null
const ownEntry = (ball, id) => ball && Object.hasOwn(ball.entries, id) ? ball.entries[id] : undefined

/** Classify executable governance changes independently of caller labels and history metadata.
 * Fixed IDs and declarations on either head require Class 3. Malformed declarations cannot lower it.
 * Absent or false declarations are ordinary by policy, not an owner-trusted registration.
 * @param {object|null} previous Selected manifest read inside the effect transaction.
 * @param {object} candidate Validated candidate manifest.
 * @returns {object} Class 3 plus exact changed entry IDs, or Class 1 for other transitions.
 */
export function classifyHeadTransition(previous, candidate) {
  const ids = [...new Set([...Object.keys(previous?.entries ?? {}), ...Object.keys(candidate.entries)])]
  const changed = ids.filter(id => (governanceEntry(id, ownEntry(previous, id)) || governanceEntry(id, ownEntry(candidate, id)))
    && canonicalJson(execution(ownEntry(previous, id))) !== canonicalJson(execution(ownEntry(candidate, id))))
  return Object.freeze({ class: changed.length ? 3 : 1, entryIds: Object.freeze(changed) })
}

/** Bind one governance effect to the complete candidate head and its candidate module bytes.
 * Removal and non-ball entries bind their execution fields instead of pretending they are module bytes.
 * The v1 terms remain unchanged. The Head owner separately fixes authorPeerId to its held
 * writer lease and captures the candidate before qualification or approval can yield.
 * @param {object} input Trusted audience, validated candidate manifest, classified entry ID and optional
 * previous selected manifest. Without previous, only candidate declarations or fixed IDs can be bound.
 * @returns {Promise<object>} Exact passkey approval terms, never an authorization by themselves.
 */
export async function headPromotionBinding({ audience, ball, entryId, previous = null }) {
  if (typeof ball?.ballId !== 'string' || !HEX_64.test(ball.ballId)
    || !Number.isSafeInteger(ball.epoch) || ball.epoch < 0 || Object.is(ball.epoch, -0)
    || typeof entryId !== 'string') ownerGrantFailure('CLASS3_ACTION_INVALID')
  const organId = entryId.replace(/:[0-9a-f]{64}$/, '')
  const entry = ownEntry(ball, entryId)
  if (!/^[a-z][a-z0-9-]{0,40}$/.test(organId)
    || (!governanceEntry(entryId, entry) && !governanceEntry(entryId, ownEntry(previous, entryId)))) ownerGrantFailure('CLASS3_ACTION_INVALID')
  const candidateSha256 = /^ball:[0-9a-f]{64}$/.test(entry?.specifier ?? '') ? entry.specifier.slice(5)
    : hexString(await crypto.subtle.digest('SHA-256', encoder.encode(canonicalJson(execution(entry)))))
  return Object.freeze({ schema: 'aukora.class3.head-promotion.v1', audience, action: 'head.promote', ballId: ball.ballId, epoch: ball.epoch, organId, candidateSha256 })
}

export { codeOnlyUpdateCheck, ordinaryAddShapeOk, organAdditionSet, organSetOf, ORGAN_SET_MAX } from './organ-set-rule.mjs'

export const ORGAN_SET_SCHEMA = 'aukora.head-organ-set.v1'
export const ORGAN_SET_PATH = '/_head/promote'

/** The exact `/_head/promote` body an owner approves for an organ set. Its Class 3 action binding hashes this body.
 * `bytes` is the UTF-8 length of each module HEAD verified by hash; ballId is the canonical id of the whole manifest.
 */
export function organSetPromotionBody(ball, organs, bytesOf) {
  return { schema: ORGAN_SET_SCHEMA, ballId: ball.ballId, epoch: ball.epoch, parentBallId: ball.parentBallId,
    organs: organs.map(organ => ({ organId: organ.organId, sha256: organ.sha256, bytes: bytesOf(organ.sha256) })) }
}

/** Return exactly the seven-field preimage used by the browser verifier. */
export function ownerGrantCanonical(binding) {
  return canonicalJson({ schema: OWNER_GRANT_SCHEMA, mandateId: binding.mandateId, ticketId: binding.ticketId,
    scope: binding.scope === undefined ? null : binding.scope, ballId: binding.ballId, epoch: binding.epoch,
    expiresAt: binding.expiresAt, identity: binding.identity })
}

function plainRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function boundedJsonCopy(value, budget, depth = 0) {
  if (++budget.nodes > 1024 || depth > 16) ownerGrantFailure('OWNER_GRANT_TOO_COMPLEX')
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) ownerGrantFailure('OWNER_GRANT_INVALID_SCOPE')
    return value
  }
  if (typeof value === 'string') {
    budget.bytes += encoder.encode(value).length
    if (budget.bytes > OWNER_GRANT_MAX_BODY_BYTES) ownerGrantFailure('REQUEST_BODY_TOO_LARGE', 413)
    return value
  }
  if (!Array.isArray(value) && !plainRecord(value)) ownerGrantFailure('OWNER_GRANT_INVALID_SCOPE')
  if (budget.seen.has(value)) ownerGrantFailure('OWNER_GRANT_INVALID_SCOPE')
  budget.seen.add(value)
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const keys = Reflect.ownKeys(descriptors)
  if (keys.length > 1024 - budget.nodes) ownerGrantFailure('OWNER_GRANT_TOO_COMPLEX')
  const copy = Array.isArray(value) ? [] : Object.create(null)
  if (Array.isArray(value) && (value.length > 1024 || keys.length !== value.length + 1)) ownerGrantFailure('OWNER_GRANT_INVALID_SCOPE')
  for (const key of keys) {
    if (Array.isArray(value) && key === 'length') continue
    if (typeof key !== 'string') ownerGrantFailure('OWNER_GRANT_INVALID_SCOPE')
    const descriptor = descriptors[key]
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) ownerGrantFailure('OWNER_GRANT_INVALID_SCOPE')
    budget.bytes += encoder.encode(key).length
    if (budget.bytes > OWNER_GRANT_MAX_BODY_BYTES) ownerGrantFailure('REQUEST_BODY_TOO_LARGE', 413)
    if (Array.isArray(value) && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length)) ownerGrantFailure('OWNER_GRANT_INVALID_SCOPE')
    copy[key] = boundedJsonCopy(descriptor.value, budget, depth + 1)
  }
  budget.seen.delete(value)
  return Object.freeze(copy)
}

function boundedLabel(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 200 && value.trim() === value && value.trim().length > 0
}

function exactFields(value, fields) {
  return plainRecord(value) && Object.keys(value).length === fields.length && fields.every(key => Object.hasOwn(value, key))
}

function hybridCopy(value) {
  try { return boundedJsonCopy(value, { nodes: 0, bytes: 0, seen: new Set() }) }
  catch (_error) { ownerGrantFailure('HYBRID_ENVELOPE_INVALID', 403) }
}

const hexBytes = value => Uint8Array.from(value.match(/../g) ?? [], byte => parseInt(byte, 16))
const hexString = value => [...new Uint8Array(value)].map(byte => byte.toString(16).padStart(2, '0')).join('')

/** Verify both signatures using independently configured public keys, never keys from the envelope.
 * @param {unknown} input Exact v2 envelope; missing either signature is a 403 refusal, never a downgrade.
 * @param {object} options Required expected artifact and trustedKeys with ed25519PublicKeyHex and mlDsaPublicKeyHex.
 * @returns {Promise<object>} Immutable authenticated envelope. Artifact-specific admission remains the caller's responsibility.
 */
export async function verifyHybridEnvelopeV2(input, { artifact, trustedKeys } = {}) {
  const envelope = hybridCopy(input)
  if (!plainRecord(envelope) || envelope.schema !== HYBRID_ENVELOPE_SCHEMA
    || !HYBRID_ARTIFACTS.includes(artifact) || envelope.artifact !== artifact) ownerGrantFailure('HYBRID_ENVELOPE_INVALID', 403)
  if (!plainRecord(envelope.signatures) || !envelope.signatures.ed25519SigHex || !envelope.signatures.mlDsaSigHex) ownerGrantFailure('HYBRID_SIGNATURE_INCOMPLETE', 403)
  if (!exactFields(envelope, ['schema', 'artifact', 'payload', 'algManifest', 'signatures']) || !plainRecord(envelope.payload)
    || !exactFields(envelope.algManifest, ['classical', 'pq'])
    || !exactFields(envelope.algManifest.classical, ['alg', 'keyId']) || !exactFields(envelope.algManifest.pq, ['alg', 'keyId'])
    || envelope.algManifest.classical.alg !== 'Ed25519' || envelope.algManifest.pq.alg !== 'ML-DSA-65'
    || !/^[a-f0-9]{12}$/.test(envelope.algManifest.classical.keyId) || !/^[a-f0-9]{12}$/.test(envelope.algManifest.pq.keyId)
    || !exactFields(envelope.signatures, ['ed25519SigHex', 'mlDsaSigHex'])
    || !/^[a-f0-9]{128}$/.test(envelope.signatures.ed25519SigHex) || !/^[a-f0-9]{6618}$/.test(envelope.signatures.mlDsaSigHex)) ownerGrantFailure('HYBRID_ENVELOPE_INVALID', 403)
  if (trustedKeys === undefined) ownerGrantFailure('HYBRID_TRUST_REQUIRED', 403)
  const keys = hybridCopy(trustedKeys)
  if (!exactFields(keys, ['ed25519PublicKeyHex', 'mlDsaPublicKeyHex']) || !/^[a-f0-9]{64}$/.test(keys.ed25519PublicKeyHex)
    || !/^[a-f0-9]{3904}$/.test(keys.mlDsaPublicKeyHex)) ownerGrantFailure('HYBRID_TRUST_INVALID', 403)
  const edKey = hexBytes(keys.ed25519PublicKeyHex), pqKey = hexBytes(keys.mlDsaPublicKeyHex)
  const keyId = async key => hexString(await crypto.subtle.digest('SHA-256', key)).slice(0, 12)
  if (envelope.algManifest.classical.keyId !== await keyId(edKey) || envelope.algManifest.pq.keyId !== await keyId(pqKey)) ownerGrantFailure('HYBRID_KEY_MISMATCH', 403)
  const { schema, payload, algManifest } = envelope
  const preimage = encoder.encode(HYBRID_ENVELOPE_DOMAIN + canonicalJson({ schema, artifact, payload, algManifest }))
  // A WRONG signature is thrown carrying its branded outcome (proof-failure-rule.mjs): HEAD's gate counts that, and only that.
  settleProof(await hybridSignaturesOutcome({ ed25519PublicKey: edKey, mlDsaPublicKey: pqKey, ed25519Signature: hexBytes(envelope.signatures.ed25519SigHex),
    mlDsaSignature: hexBytes(envelope.signatures.mlDsaSigHex), message: preimage }))
  return envelope
}

/** The two signature backends a hybrid envelope is checked with. Each answers true or false, or throws (no verdict). */
export const HYBRID_SIGNATURE_BACKENDS = Object.freeze({
  ed25519: async (publicKey, signature, message) => crypto.subtle.verify('Ed25519', await crypto.subtle.importKey('raw', publicKey, 'Ed25519', false, ['verify']), signature, message),
  mlDsa65: (publicKey, signature, message) => ml_dsa65.verify(signature, message, publicKey, { context: HYBRID_CONTEXT }),
})

/**
 * THREE OUTCOMES OF A HYBRID SIGNATURE CHECK (job 7 review, through proof-failure-rule.mjs since job 9). The envelope's
 * shape, lengths and key ids were already read (a parsing failure is refused before this, never counted). Each backend's
 * answer goes through proofOutcome: both a strict true is a valid signature (`ok`); a strict false is
 * HYBRID_SIGNATURE_INVALID (`wrong`, 403, the only hybrid refusal HEAD's gate counts); a backend that throws or answers
 * anything but a boolean reached no verdict: HYBRID_VERIFIER_UNAVAILABLE (`unavailable`, 503), never counted.
 * `backends` exists for tests; verifyHybridEnvelopeV2 always uses HYBRID_SIGNATURE_BACKENDS.
 * @returns {Promise<object>} A branded outcome.
 */
export async function hybridSignaturesOutcome({ ed25519PublicKey, mlDsaPublicKey, ed25519Signature, mlDsaSignature, message }, backends = HYBRID_SIGNATURE_BACKENDS) {
  const terms = { code: 'HYBRID_SIGNATURE_INVALID', unavailableCode: 'HYBRID_VERIFIER_UNAVAILABLE' }
  const classical = await proofOutcome(() => backends.ed25519(ed25519PublicKey, ed25519Signature, message), terms)
  if (!proofIs(classical, 'ok')) return classical
  return proofOutcome(() => backends.mlDsa65(mlDsaPublicKey, mlDsaSignature, message), terms)
}
/**
 * The same check as a boolean (true: both signatures verified; false: one was checked and wrong). No verdict throws 503
 * HYBRID_VERIFIER_UNAVAILABLE. A report: it carries nothing a budget could count.
 * @returns {Promise<boolean>} Whether both signatures verified.
 */
export async function hybridSignaturesVerdict(input, backends = HYBRID_SIGNATURE_BACKENDS) {
  const outcome = await hybridSignaturesOutcome(input, backends)
  if (proofIs(outcome, 'unavailable')) throw proofError(outcome)
  return proofIs(outcome, 'ok')
}

/** Verify a client-signed v2 grant, then validate its exact seven terms without signing or widening scope.
 * @param {unknown} input Hybrid owner-grant envelope; legacy grants cannot enter this approval path.
 * @param {object} options Independently supplied trustedKeys and optional now for expiry validation.
 * @returns {Promise<object>} Immutable envelope and normalized binding; Class 3 WebAuthn remains independently required.
 */
export async function verifySignedOwnerGrant(input, { trustedKeys, nodePublicKeyHex = null, now = Date.now() } = {}) {
  requireOwnerNodeKeySeparation(trustedKeys?.ed25519PublicKeyHex, nodePublicKeyHex)
  const envelope = await verifyHybridEnvelopeV2(input, { artifact: 'owner-grant', trustedKeys })
  const binding = normalizeOwnerGrantBinding(envelope.payload, { now })
  if (canonicalJson(binding) !== canonicalJson(envelope.payload)) ownerGrantFailure('OWNER_GRANT_MALFORMED')
  return Object.freeze({ envelope, binding })
}

function requireExplicitSelectors(scope, field) {
  if (!Object.hasOwn(scope, field)) return []
  const selectors = scope[field]
  if (!Array.isArray(selectors) || selectors.some(value => !boundedLabel(value) || /[\u0000-\u001f\u007f]/.test(value))) ownerGrantFailure('OWNER_GRANT_INVALID_SCOPE')
  // No exclusion syntax is enforced by existing mandate consumers. Do not sign a glob
  // and rely on an ignored exclude list to keep governance outside a standing grant.
  if (selectors.some(value => /[*?\[\]{}!]/.test(value))) ownerGrantFailure('OWNER_GRANT_EXPLICIT_SCOPE_REQUIRED', 403)
  return selectors
}

function organPathTarget(value) {
  // Only the two canonical seed source roots identify organ files without guessing
  // whether an arbitrary path is a directory, alias or a broader permission prefix.
  const match = /^(?:\/dsh\/home\/auma\/seed\/organs\/|mirror\/home\/auma\/seed\/organs\/)([a-z][a-z0-9-]{0,40})\.js$/.exec(value)
  if (!match) ownerGrantFailure('OWNER_GRANT_EXPLICIT_SCOPE_REQUIRED', 403)
  return match[1]
}

function requireGovernanceBinding(binding) {
  const scope = binding.scope
  if (scope === null) ownerGrantFailure('OWNER_GRANT_EXPLICIT_SCOPE_REQUIRED', 403)
  const organs = [...requireExplicitSelectors(scope, 'organs')]
  if (Object.hasOwn(scope, 'organ') && (typeof scope.organ !== 'string' || !/^[a-z][a-z0-9-]{0,40}$/.test(scope.organ))) ownerGrantFailure('OWNER_GRANT_INVALID_SCOPE')
  if (scope.organ !== undefined && organs.length && (organs.length !== 1 || organs[0] !== scope.organ)) ownerGrantFailure('OWNER_GRANT_INVALID_SCOPE')
  if (scope.organ !== undefined && !organs.length) organs.push(scope.organ)
  const paths = requireExplicitSelectors(scope, 'paths')
  requireExplicitSelectors(scope, 'tools')
  if (organs.some(value => !/^[a-z][a-z0-9-]{0,40}$/.test(value))) ownerGrantFailure('OWNER_GRANT_INVALID_SCOPE')
  const pathTargets = paths.map(organPathTarget)
  if (organs.length === 0 && pathTargets.length === 0) ownerGrantFailure('OWNER_GRANT_EXPLICIT_SCOPE_REQUIRED', 403)
  const targets = new Set([...organs, ...pathTargets].filter(organ => OWNER_GOVERNANCE_ORGANS.includes(organ)))
  if (Object.hasOwn(scope, 'candidateSha256') && (typeof scope.candidateSha256 !== 'string' || !HEX_64.test(scope.candidateSha256))) ownerGrantFailure('OWNER_GRANT_INVALID_CANDIDATE')
  if (targets.size === 0) return
  const [target] = targets
  if (targets.size !== 1 || organs.some(organ => organ !== target) || pathTargets.some(organ => organ !== target)) ownerGrantFailure('OWNER_GRANT_EXPLICIT_SCOPE_REQUIRED', 403)
  if (typeof scope.candidateSha256 !== 'string' || binding.ticketId === null || binding.expiresAt === null) ownerGrantFailure('OWNER_GRANT_GOVERNANCE_BINDING_REQUIRED', 403)
}

/**
 * Validate immutable signed terms without changing the seven-field preimage.
 * Issuance requires explicit organ IDs or exact .js paths under the canonical seed organ roots.
 * Governance issuance requires one explicit target, a ticket, future expiry and scope.candidateSha256.
 * Epochs and non-null expiry timestamps are safe integers; ordinary standing grants may have null expiry.
 * Null, empty, tools-only, wildcard and arbitrary-path scopes are refused rather than narrowed.
 * Consumers must enforce target permission and candidate bytes against these terms, including older grants.
 */
export function normalizeOwnerGrantBinding(input, { now = Date.now() } = {}) {
  if (!plainRecord(input)) ownerGrantFailure('OWNER_GRANT_MALFORMED')
  const descriptors = Object.getOwnPropertyDescriptors(input)
  if (Reflect.ownKeys(descriptors).length !== FIELDS.length || FIELDS.some(key => !descriptors[key]?.enumerable || !Object.hasOwn(descriptors[key], 'value'))) ownerGrantFailure('OWNER_GRANT_MALFORMED')
  const binding = Object.fromEntries(FIELDS.map(key => [key, descriptors[key].value]))
  if (!boundedLabel(binding.mandateId)) ownerGrantFailure('OWNER_GRANT_INVALID_MANDATE')
  if (binding.ticketId !== null && !boundedLabel(binding.ticketId)) ownerGrantFailure('OWNER_GRANT_INVALID_TICKET')
  if (typeof binding.ballId !== 'string' || !HEX_64.test(binding.ballId)) ownerGrantFailure('OWNER_GRANT_INVALID_BALL')
  if (typeof binding.epoch !== 'number' || !Number.isSafeInteger(binding.epoch) || Object.is(binding.epoch, -0) || binding.epoch < 0) ownerGrantFailure('OWNER_GRANT_INVALID_EPOCH')
  if (binding.expiresAt !== null && (typeof binding.expiresAt !== 'number' || !Number.isSafeInteger(binding.expiresAt) || Object.is(binding.expiresAt, -0) || !Number.isSafeInteger(now) || now < 0 || Object.is(now, -0) || binding.expiresAt <= now)) ownerGrantFailure('OWNER_GRANT_INVALID_EXPIRY')
  if (typeof binding.identity !== 'string' || binding.identity.length > 200 || !binding.identity.trim() || REJECTED_OWNER_IDENTITIES.has(binding.identity.trim().toLowerCase())) ownerGrantFailure('OWNER_GRANT_IDENTITY_REJECTED', 403)
  if (binding.scope !== null && !plainRecord(binding.scope)) ownerGrantFailure('OWNER_GRANT_INVALID_SCOPE')
  binding.scope = boundedJsonCopy(binding.scope, { nodes: 0, bytes: 0, seen: new Set() })
  if (binding.scope !== null && Object.hasOwn(binding.scope, 'expiresAt') && binding.scope.expiresAt !== binding.expiresAt) ownerGrantFailure('OWNER_GRANT_INVALID_EXPIRY')
  requireGovernanceBinding(binding)
  if (encoder.encode(ownerGrantCanonical(binding)).length > OWNER_GRANT_MAX_BODY_BYTES) ownerGrantFailure('REQUEST_BODY_TOO_LARGE', 413)
  return Object.freeze(binding)
}

/** Match only the two owner routes; both browser headers are CSRF checks, never approval. */
export function ownerGrantRequestFailure({ pathname, method, origin, fetchSite, expectedOrigin, search = '' }) {
  if (!['/_host/owner-key', '/_host/owner-grant'].includes(pathname) || search) return { code: 'OWNER_ROUTE_UNAVAILABLE', status: 404 }
  if (method !== (pathname === '/_host/owner-key' ? 'GET' : 'POST')) return { code: 'METHOD_UNAVAILABLE', status: 405 }
  if (pathname === '/_host/owner-grant' && (!expectedOrigin || origin !== expectedOrigin || fetchSite !== 'same-origin')) return { code: 'SAME_ORIGIN_BROWSER_REQUIRED', status: 403 }
  return null
}

/** A trusted, out-of-band provider must approve these exact bytes. No such provider is installed by default. */
export async function requireOwnerGrantApproval(binding, approveOwnerGrant) {
  if (typeof approveOwnerGrant !== 'function') ownerGrantFailure('OWNER_APPROVAL_REQUIRED', 403)
  const canonical = ownerGrantCanonical(binding)
  let approval
  try { approval = await approveOwnerGrant(Object.freeze({ binding, canonical })) }
  catch { ownerGrantFailure('OWNER_APPROVAL_REQUIRED', 403) }
  if (!plainRecord(approval) || Object.getOwnPropertyDescriptor(approval, 'approved')?.value !== true || Object.getOwnPropertyDescriptor(approval, 'canonical')?.value !== canonical) ownerGrantFailure('OWNER_APPROVAL_REQUIRED', 403)
}

/** Classify local model-broker requests without executing a command or trusting approval flags.
 * @param {string} surface repo, github or cloudflare.
 * @param {object} input Untrusted JSON request. Only explicit observations survive classification.
 * @returns {object} A fixed read/status plan or an unavailable read; mutations throw before I/O.
 */
export function planLocalBrokerAction(surface, input) {
  if (!['repo', 'github', 'cloudflare'].includes(surface) || !plainRecord(input)) ownerGrantFailure('LOCAL_BROKER_REQUEST_INVALID')
  const only = keys => { if (Object.keys(input).some(key => !keys.includes(key))) ownerGrantFailure('LOCAL_BROKER_REQUEST_INVALID') }
  const action = input.action ?? (surface === 'repo' ? null : 'status')
  if (surface === 'repo') {
    if (['write', 'commit'].includes(action)) ownerGrantFailure('PEARL_QUALIFICATION_UNVERIFIABLE', 403)
    if (!['status', 'read', 'log', 'diff'].includes(action)) ownerGrantFailure('CLASS3_OWNER_SIGNATURE_REQUIRED', 403)
    if (action === 'status') { only(['action']); return { kind: 'repository-status' } }
    if (action === 'read') {
      only(['action', 'path'])
      if (typeof input.path !== 'string') ownerGrantFailure('LOCAL_BROKER_REQUEST_INVALID')
      return { kind: 'source-read', path: input.path }
    }
    only(action === 'diff' ? ['action', 'path'] : ['action'])
    if (input.path !== undefined && typeof input.path !== 'string') ownerGrantFailure('LOCAL_BROKER_REQUEST_INVALID')
    return { kind: 'unavailable', code: 'LOCAL_REPO_READ_UNAVAILABLE', action }
  }
  if (action === 'status') { only(['action']); return { kind: 'integration-status', surface } }
  if (surface === 'github' && action === 'api' && (input.method === undefined || input.method === 'GET') && input.body === undefined) {
    only(['action', 'method', 'endpoint'])
    return { kind: 'unavailable', code: 'LOCAL_GITHUB_READ_UNAVAILABLE', action }
  }
  ownerGrantFailure('CLASS3_OWNER_SIGNATURE_REQUIRED', 403)
}

/** Keep runtime observations available without treating retained artifacts or CAS as admission.
 * @param {string} method Request method; no request-supplied proof can enable selection.
 * @returns {object} A read-only status plan. Selection fails closed until a trusted verifier exists.
 */
export function planLocalRuntimeAction(method) {
  if (method === 'GET') return { kind: 'runtime-status' }
  if (method === 'POST') ownerGrantFailure('PEARL_QUALIFICATION_UNVERIFIABLE', 403)
  ownerGrantFailure('METHOD_UNAVAILABLE', 405)
}

