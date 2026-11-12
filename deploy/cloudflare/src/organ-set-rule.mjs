/**
 * THE ONE RULE for what an ordinary-organ change may contain, shared by HEAD's organ-set approval
 * (deploy/cloudflare/src/owner-grant-policy.mjs) and the night grant (night-grant.mjs). The Sovereignty card
 * (aumlok/organ-set.ts) and Auma's worker (ball-loader.ts organAdditionSetOf) keep TypeScript copies that must pass
 * the same vectors (organ-set-rule.vectors.json): a copy that drifts fails its own spec.
 * Pure, keyless, dependency-free apart from ball-transition.mjs.
 *
 * DECISIONS (every implementation follows them, and the vectors pin each one):
 * - A root field outside ROOT_FIELDS_MAY_DIFFER that is ADDED, even valued null, is refused: presence counts.
 * - An added organ may carry `previousVersions: []` (the same as none) and an `updatedAt` that is a non-negative safe
 *   integer; any other history or timestamp is refused.
 * - SIZES ARE NEVER TRUSTED. A module's size is the UTF-8 byte length of its hash-verified code. A NEW module's
 *   metadata `size`, when present, must equal that length (else refused); when absent it is fine. A new module whose
 *   verified bytes are not known is refused. Published modules are unchanged by rule, so they are not re-sized.
 */
import { canonicalJson, isT2OnlyOrgan } from '../../../server/ball-transition.mjs'

export const ORGAN_SET_MAX = 8
export const ORGAN_ID_RE = /^[a-z][a-z0-9-]{0,40}$/
/** The ONLY root fields of a candidate manifest that may differ from the selected head's. Anything else, present or
 * absent on either side, must be byte-identical. */
export const ROOT_FIELDS_MAY_DIFFER = Object.freeze(['entries', 'modules', 'epoch', 'parentBallId', 'ballId', 'createdAt', 'authorPeerId'])
const ADD_FIELDS = Object.freeze(['id', 'specifier', 'disabled', 'config', 'previousSpecifiers', 'previousVersions', 'updatedAt'])
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const optionalTime = value => value === undefined || (Number.isSafeInteger(value) && value >= 0)
const BALL = /^ball:[0-9a-f]{64}$/

/** Every root field outside ROOT_FIELDS_MAY_DIFFER is byte-identical (same presence, same canonical value). */
export function rootFieldsUnchanged(previous, candidate) {
  if (!plain(previous) || !plain(candidate)) return false
  for (const key of new Set([...Object.keys(previous), ...Object.keys(candidate)])) {
    if (ROOT_FIELDS_MAY_DIFFER.includes(key)) continue
    if (Object.hasOwn(previous, key) !== Object.hasOwn(candidate, key)) return false
    if (Object.hasOwn(previous, key) && canonicalJson(previous[key]) !== canonicalJson(candidate[key])) return false
  }
  return true
}

/** Every published module is kept byte-identical (metadata), so no rollback target disappears or changes. */
export function publishedModulesKept(previous, candidate) {
  return Object.keys(previous.modules).every(sha => Object.hasOwn(candidate.modules, sha)
    && canonicalJson(previous.modules[sha]) === canonicalJson(candidate.modules[sha]))
}

/** Every module the candidate adds is run by exactly one of `changedSpecifiers` (the new specifiers of the changed
 * entries), and its metadata names itself. No unlisted module rides along. */
export function newModulesOwned(previous, candidate, changedSpecifiers) {
  const owners = new Map()
  for (const specifier of changedSpecifiers) {
    const sha = specifier.slice(5)
    if (!Object.hasOwn(previous.modules, sha)) owners.set(sha, (owners.get(sha) ?? 0) + 1)
  }
  for (const sha of Object.keys(candidate.modules)) {
    if (Object.hasOwn(previous.modules, sha)) continue
    const meta = candidate.modules[sha]
    if (owners.get(sha) !== 1 || !plain(meta) || meta.sha256 !== sha || meta.specifier !== `ball:${sha}`) return false
  }
  return [...owners.keys()].every(sha => Object.hasOwn(candidate.modules, sha))
}

/** A new ordinary organ's entry, exactly: its own id, enabled, `config: {}`, NO rollback history, no governance key,
 * an optional updatedAt. */
export function ordinaryAddShapeOk(id, entry) {
  return plain(entry) && Object.keys(entry).every(key => ADD_FIELDS.includes(key)) && entry.id === id
    && entry.disabled === false && plain(entry.config) && Object.keys(entry.config).length === 0
    && Array.isArray(entry.previousSpecifiers) && entry.previousSpecifiers.length === 0
    && (entry.previousVersions === undefined || (Array.isArray(entry.previousVersions) && entry.previousVersions.length === 0))
    && optionalTime(entry.updatedAt) && typeof entry.specifier === 'string' && BALL.test(entry.specifier)
}

/** The entry a CODE-ONLY update must be, derived from the selected head: every field kept, specifier replaced, the old
 * specifier appended to previousSpecifiers (once) and the old version appended to previousVersions; only updatedAt free.
 * @returns {'ok'|'NOT_CODE'|'CONFIG_CHANGED'|'HISTORY_MISMATCH'}
 */
export function codeOnlyUpdateCheck(previous, candidate) {
  if (!plain(previous) || !plain(candidate) || typeof candidate.specifier !== 'string'
    || candidate.specifier === previous.specifier || !BALL.test(candidate.specifier)) return 'NOT_CODE'
  const strip = entry => { const { updatedAt: _updatedAt, ...rest } = entry; return rest }
  if (canonicalJson(candidate.config ?? null) !== canonicalJson(previous.config ?? null) || candidate.disabled !== previous.disabled
    || canonicalJson(candidate.governance ?? null) !== canonicalJson(previous.governance ?? null)) return 'CONFIG_CHANGED'
  const priorSpecifiers = Array.isArray(previous.previousSpecifiers) ? previous.previousSpecifiers : []
  const expected = { ...strip(previous), specifier: candidate.specifier,
    previousSpecifiers: priorSpecifiers.includes(previous.specifier) ? [...priorSpecifiers] : [...priorSpecifiers, previous.specifier],
    previousVersions: [...(Array.isArray(previous.previousVersions) ? previous.previousVersions : []),
      { specifier: previous.specifier, config: previous.config ?? {}, disabled: previous.disabled }] }
  if (!optionalTime(candidate.updatedAt) || canonicalJson(strip(candidate)) !== canonicalJson(expected)) return 'HISTORY_MISMATCH'
  return 'ok'
}

/** Every NEW module's verified byte length is known (`bytesOf(sha)` from hash-verified code, null when unknown), and its
 * metadata `size`, if present, equals it. */
export function newModuleSizesMatch(previous, candidate, bytesOf) {
  for (const sha of Object.keys(candidate.modules)) {
    if (Object.hasOwn(previous.modules, sha)) continue
    const bytes = typeof bytesOf === 'function' ? bytesOf(sha) : null
    if (!Number.isSafeInteger(bytes) || bytes < 0) return false
    const meta = candidate.modules[sha]
    if (plain(meta) && Object.hasOwn(meta, 'size') && meta.size !== bytes) return false
  }
  return true
}

/** The complete organ-set verdict: organAdditionSet's structure AND newModuleSizesMatch, with each organ's size taken
 * from its verified bytes (reused published modules included). `bytesOf` must answer for every module an added organ
 * runs. @returns {null|Array<{organId: string, sha256: string, bytes: number}>} */
export function organSetOf(previous, candidate, bytesOf) {
  const organs = organAdditionSet(previous, candidate)
  if (organs === null || !newModuleSizesMatch(previous, candidate, bytesOf)) return null
  const sized = organs.map(organ => ({ ...organ, bytes: bytesOf(organ.sha256) }))
  return sized.every(organ => Number.isSafeInteger(organ.bytes) && organ.bytes >= 0) ? sized : null
}

/** The ordinary organs a candidate ADDS, when that is ALL it does; otherwise null.
 * Root fields: only ROOT_FIELDS_MAY_DIFFER may differ. Every published entry and module byte-identical. 1..8 adds, each
 * an ordinary add shape, not governance by id or declaration, running a module the candidate carries. Every new
 * module run by exactly one added organ; no other module. An added organ may run an already-published module.
 * @returns {null|Array<{organId: string, sha256: string}>} sorted by organId.
 */
export function organAdditionSet(previous, candidate) {
  if (!plain(previous) || !plain(candidate) || !plain(previous.entries) || !plain(candidate.entries)
    || !plain(previous.modules) || !plain(candidate.modules) || !rootFieldsUnchanged(previous, candidate)) return null
  for (const id of Object.keys(previous.entries)) {
    if (!Object.hasOwn(candidate.entries, id) || canonicalJson(previous.entries[id]) !== canonicalJson(candidate.entries[id])) return null
  }
  if (!publishedModulesKept(previous, candidate)) return null
  const added = Object.keys(candidate.entries).filter(id => !Object.hasOwn(previous.entries, id)).sort()
  if (added.length === 0 || added.length > ORGAN_SET_MAX) return null
  const organs = []
  for (const id of added) {
    const entry = candidate.entries[id]
    if (!ORGAN_ID_RE.test(id) || isT2OnlyOrgan(id, undefined, entry) || !ordinaryAddShapeOk(id, entry)
      || !Object.hasOwn(candidate.modules, entry.specifier.slice(5))) return null
    organs.push({ organId: id, sha256: entry.specifier.slice(5) })
  }
  if (!newModulesOwned(previous, candidate, added.map(id => candidate.entries[id].specifier))) return null
  return organs
}
