/** Shared head transition tiering (T0/T1/T2) across edge HeadDO and worker runtime. */

/** Fixed governance organs shared by grant issuance and both transition classifiers. */
export const T2_ONLY_ORGANS = Object.freeze([
  'seed-receipts', 'seed-superagent', 'seed-pearl', 'seed-aura',
  'seed-predict', 'seed-recall', 'seed-memory', 'auma-body-map',
  'seed-judge', 'gate-judge', 'grant-ledger', 'aumlok-identity', 'aumlok-keys',
  'auma-scion', 'seed-boot',
])

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const unsignedInteger = value => Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0)
const isSha = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
const ownEntry = (entries, id) => Object.hasOwn(entries, id) ? entries[id] : undefined

function ownerSessionPermitsTransition(previous, candidate, entryId, session, now) {
  if (!isObject(session) || !isObject(session.scope) || !unsignedInteger(now)
    || !isSha(session.ballId) || !unsignedInteger(session.epoch) || !unsignedInteger(session.expiresAt)
    || session.expiresAt <= now || session.ballId !== previous?.ballId || session.epoch !== previous?.epoch
    || !unsignedInteger(candidate?.epoch) || candidate.parentBallId !== session.ballId || candidate.epoch !== session.epoch + 1) return false
  if (Object.keys(session).some(key => !['ballId', 'epoch', 'expiresAt', 'scope'].includes(key))
    || Object.keys(session.scope).length !== 1 || !Object.hasOwn(session.scope, 'organs')) return false
  const organs = session.scope.organs
  return Array.isArray(organs) && organs.length > 0 && organs.length <= 128
    && new Set(organs).size === organs.length
    && organs.every(id => typeof id === 'string' && /^[a-z][a-z0-9-]{0,40}$/.test(id) && !isT2OnlyOrgan(id))
    && organs.includes(stripOrganHashSuffix(entryId))
}

export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(item => canonicalJson(item === undefined ? null : item)).join(',') + ']'
  const keys = Object.keys(value).filter(key => value[key] !== undefined).sort()
  return '{' + keys.map(key => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}'
}

export function stripOrganHashSuffix(id) {
  return typeof id === 'string' ? id.replace(/:[0-9a-f]{64}$/, '') : ''
}

export function declaresGovernance(entry) {
  return [entry, entry?.config].some(
    value => isObject(value) && Object.hasOwn(value, 'governance') && value.governance !== false,
  )
}

export function isT2OnlyOrgan(id, previousEntry = undefined, candidateEntry = undefined) {
  const baseId = stripOrganHashSuffix(id)
  if (T2_ONLY_ORGANS.includes(baseId)) return true
  return declaresGovernance(previousEntry) || declaresGovernance(candidateEntry)
}

/**
 * Classify a manifest transition into T1 (single existing enabled non-T2-only organ with unchanged config)
 * vs T2 (passkey/WebAuthn required: T2_ONLY_ORGANS, multi-organ, added/removed organ, disabled/re-enabled organ,
 * or modified config). A T1 classification is eligibility, not authorization.
 * @param {object|null} previous Selected manifest inside the effect transaction.
 * @param {object} candidate Validated candidate manifest.
 * @param {object} options Canonical ID verification and independently verified owner-session evidence.
 * ownerSessionApproved alone never grants T1. ownerSession binds the previous ballId/epoch,
 * an integer expiresAt in milliseconds and an explicit scope.organs list. The caller must capture
 * these terms from authenticated authority, not infer them from the mutation, and recheck after awaits.
 * Missing session evidence or canonical ID verification cannot authorize a T1 effect.
 * @returns {object} Immutable structural tier and whether the supplied session permits this T1 effect.
 */
export function classifyTransition(previous, candidate, options = {}) {
  const prevEntries = isObject(previous?.entries) ? previous.entries : {}
  const candEntries = isObject(candidate?.entries) ? candidate.entries : {}
  const allEntryIds = [...new Set([...Object.keys(prevEntries), ...Object.keys(candEntries)])]
  const changedEntryIds = allEntryIds.filter(
    id => canonicalJson(ownEntry(prevEntries, id) ?? null) !== canonicalJson(ownEntry(candEntries, id) ?? null),
  )
  const singleOrganId = changedEntryIds.length === 1 ? changedEntryIds[0] : null
  const prevSingle = singleOrganId !== null && Object.hasOwn(prevEntries, singleOrganId)
    ? prevEntries[singleOrganId]
    : undefined
  const candSingle = singleOrganId !== null && Object.hasOwn(candEntries, singleOrganId)
    ? candEntries[singleOrganId]
    : undefined

  const t2Reasons = []
  if (changedEntryIds.length === 0) {
    t2Reasons.push('NO_ENTRY_CHANGED')
  } else if (changedEntryIds.length > 1) {
    t2Reasons.push('MULTI_ORGAN_TRANSITION')
  } else if (singleOrganId !== null) {
    if (isT2OnlyOrgan(singleOrganId, prevSingle, candSingle)) {
      t2Reasons.push('T2_PROTECTED_ORGAN')
    }
    if (!prevSingle || !candSingle) {
      t2Reasons.push('ORGAN_ADDED_OR_REMOVED')
    } else {
      if (!/^ball:[0-9a-f]{64}$/.test(prevSingle.specifier ?? '')
        || !/^ball:[0-9a-f]{64}$/.test(candSingle.specifier ?? '')
        || prevSingle.specifier === candSingle.specifier) {
        t2Reasons.push('ORGAN_MODULE_UPDATE_REQUIRED')
      }
      if (prevSingle.disabled !== false || candSingle.disabled !== false) {
        t2Reasons.push('ORGAN_DISABLED_STATE_CHANGE')
      }
      if (canonicalJson(prevSingle.config ?? {}) !== canonicalJson(candSingle.config ?? {})) {
        t2Reasons.push('ORGAN_CONFIG_CHANGED')
      }
    }
  }

  const canonicalManifestMatches = options.canonicalManifestMatches === true
  if (!canonicalManifestMatches) {
    t2Reasons.push('NON_CANONICAL_MANIFEST_ID')
  }

  const eligibleForT1 = t2Reasons.length === 0
  const isEdgeT1OrganUpdate = eligibleForT1 && options.ownerSessionApproved === true
    && ownerSessionPermitsTransition(previous, candidate, singleOrganId, options.ownerSession, options.now ?? Date.now())

  return Object.freeze({
    tier: eligibleForT1 ? 'T1' : 'T2',
    requiresPasskey: !eligibleForT1,
    eligibleForT1,
    isEdgeT1OrganUpdate,
    changedEntryIds: Object.freeze(changedEntryIds),
    singleOrganId,
    t2Reasons: Object.freeze(t2Reasons),
  })
}
