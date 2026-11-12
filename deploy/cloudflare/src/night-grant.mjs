/** Night grant: one owner passkey lets HEAD promote a bounded number of ordinary organ changes without a tap each.
 * Pure, keyless policy. HEAD (head-do.mjs) owns storage, the passkey consumption and the atomic use.
 * Governance organs are never covered. A refusal never opens anything: the normal biometric card remains.
 */
import { canonicalJson, isT2OnlyOrgan } from '../../../server/ball-transition.mjs'
import { classifyHeadTransition } from './owner-grant-policy.mjs'
import { codeOnlyUpdateCheck, newModuleSizesMatch, newModulesOwned, ordinaryAddShapeOk, publishedModulesKept, rootFieldsUnchanged } from './organ-set-rule.mjs'

export const NIGHT_GRANT_SCHEMA = 'aukora.night-grant.v1'
export const NIGHT_GRANT_RECORD_SCHEMA = 'aukora.night-grant.record.v1'
export const NIGHT_GRANT_SCOPE = 'add-or-update-non-governance-organs'
export const NIGHT_GRANT_MAX_LIFETIME_MS = 12 * 60 * 60 * 1000
export const NIGHT_GRANT_MAX_USES = 12
export const NIGHT_GRANT_DEFAULT_USES = 12
export const NIGHT_GRANT_MAX_ORGANS_PER_USE = 8
const TERM_FIELDS = Object.freeze(['schema', 'grantId', 'audience', 'scope', 'issuedAtHead', 'notAfter', 'maxUses', 'maxOrgansPerUse'])
const ORGAN_ID = /^[a-z][a-z0-9-]{0,40}$/
const HEX_64 = /^[0-9a-f]{64}$/

/** Throw a public refusal; never includes request contents. */
export function nightGrantFailure(code, status = 403) {
  throw Object.assign(new Error(code), { code, status })
}

const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value))
const exactKeys = (value, keys) => plain(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
const safeCount = (value, min, max) => typeof value === 'number' && Number.isSafeInteger(value) && !Object.is(value, -0) && value >= min && value <= max
const originValid = value => {
  if (typeof value !== 'string' || value.length > 200) return false
  try { const url = new URL(value); return url.protocol === 'https:' && url.origin === value } catch { return false }
}

/** Validate the exact terms the owner approves. Nothing is defaulted, narrowed or widened.
 * @param {unknown} input Candidate terms from the request body.
 * @param {{ now: number, audience: string, head: { ballId: string, epoch: number } | null }} context HEAD's clock, the
 *   request origin and the selected head, all read by HEAD, never by the caller.
 * @returns {object} Frozen copy of the terms.
 */
export function normalizeNightGrantTerms(input, { now, audience, head }) {
  if (!exactKeys(input, TERM_FIELDS) || input.schema !== NIGHT_GRANT_SCHEMA) nightGrantFailure('NIGHT_GRANT_TERMS_INVALID', 400)
  if (typeof input.grantId !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(input.grantId)) nightGrantFailure('NIGHT_GRANT_TERMS_INVALID', 400)
  if (!originValid(input.audience) || input.audience !== audience) nightGrantFailure('NIGHT_GRANT_AUDIENCE_MISMATCH')
  if (input.scope !== NIGHT_GRANT_SCOPE) nightGrantFailure('NIGHT_GRANT_SCOPE_REFUSED')
  if (!exactKeys(input.issuedAtHead, ['ballId', 'epoch']) || typeof input.issuedAtHead.ballId !== 'string' || !HEX_64.test(input.issuedAtHead.ballId)
    || !safeCount(input.issuedAtHead.epoch, 0, Number.MAX_SAFE_INTEGER)) nightGrantFailure('NIGHT_GRANT_TERMS_INVALID', 400)
  if (!head || input.issuedAtHead.ballId !== head.ballId || input.issuedAtHead.epoch !== head.epoch) nightGrantFailure('NIGHT_GRANT_STALE_HEAD', 409)
  if (!safeCount(now, 0, Number.MAX_SAFE_INTEGER) || !safeCount(input.notAfter, 0, Number.MAX_SAFE_INTEGER)
    || input.notAfter <= now) nightGrantFailure('NIGHT_GRANT_EXPIRED')
  if (input.notAfter > now + NIGHT_GRANT_MAX_LIFETIME_MS) nightGrantFailure('NIGHT_GRANT_LIFETIME_REFUSED')
  if (!safeCount(input.maxUses, 1, NIGHT_GRANT_MAX_USES)) nightGrantFailure('NIGHT_GRANT_USES_REFUSED')
  if (!safeCount(input.maxOrgansPerUse, 1, NIGHT_GRANT_MAX_ORGANS_PER_USE)) nightGrantFailure('NIGHT_GRANT_SCOPE_REFUSED')
  return Object.freeze({ ...Object.fromEntries(TERM_FIELDS.map(key => [key, input[key]])), issuedAtHead: Object.freeze({ ...input.issuedAtHead }) })
}

/** One plain-words description, shared by HEAD responses and the card. */
export function nightGrantPlainWords(terms) {
  const until = new Date(terms.notAfter).toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
  return Object.freeze([
    `Let Auma add new ordinary organs, or replace an ordinary organ's code, where your Touch ID is asked today, without asking you, at most ${terms.maxUses} times.`,
    'An organ\'s settings and undo history never change under this grant; new organs start with no settings.',
    `Each time she may change at most ${terms.maxOrgansPerUse} organs, and each change must build on her current head.`,
    'Governance organs (her judge, receipts, Aura, AUMLOK, keys, scion, boot and memory) are never covered.',
    `It ends at ${until} or when the uses run out, whichever comes first. You can revoke it at any time.`,
    `Grant ${terms.grantId}, for ${terms.audience}, issued at epoch ${terms.issuedAtHead.epoch}.`,
  ])
}

/** Public status of a stored record at `now`; never reports an unusable grant as active. */
export function nightGrantState(record, now) {
  if (!plain(record) || record.schema !== NIGHT_GRANT_RECORD_SCHEMA || !plain(record.terms)) return 'missing'
  if (record.revokedAt !== null) return 'revoked'
  if (!safeCount(now, 0, Number.MAX_SAFE_INTEGER) || now >= record.terms.notAfter) return 'expired'
  if (!safeCount(record.usesLeft, 1, NIGHT_GRANT_MAX_USES)) return 'exhausted'
  return 'active'
}

/** Decide whether the stored grant covers exactly this candidate on top of `previous`.
 * @returns {{ ok: true, organs: object[] } | { ok: false, code: string }} Never throws for policy refusals.
 */
/* `bytesOf(sha)` answers the UTF-8 length of hash-verified module code. HEAD's pre-check before it has verified the
 * bytes passes none (sizes unchecked, receipt sizes null); the binding check inside the commit ALWAYS passes it, so new
 * module sizes are checked and the receipt records verified sizes only. */
export function nightGrantCovers({ record, previous, candidate, now, audience, bytesOf = null }) {
  const refuse = code => Object.freeze({ ok: false, code })
  const state = nightGrantState(record, now)
  if (state !== 'active') return refuse(`NIGHT_GRANT_${state.toUpperCase()}`)
  const { terms } = record
  if (terms.audience !== audience) return refuse('NIGHT_GRANT_AUDIENCE_MISMATCH')
  if (!plain(previous) || !plain(candidate) || !plain(previous.entries) || !plain(candidate.entries) || !plain(previous.modules) || !plain(candidate.modules)) return refuse('NIGHT_GRANT_STALE_HEAD')
  if (candidate.parentBallId !== previous.ballId || candidate.epoch !== previous.epoch + 1) return refuse('NIGHT_GRANT_STALE_HEAD')
  // Shared rule (deploy/cloudflare/src/organ-set-rule.mjs): only entries, modules, epoch, parent, id, createdAt and author may differ.
  if (!rootFieldsUnchanged(previous, candidate)) return refuse('NIGHT_GRANT_ROOT_FIELD_REFUSED')
  if (classifyHeadTransition(previous, candidate).class !== 1) return refuse('NIGHT_GRANT_GOVERNANCE_REFUSED')
  const own = (ball, id) => Object.hasOwn(ball.entries, id) ? ball.entries[id] : undefined
  const ids = [...new Set([...Object.keys(previous.entries), ...Object.keys(candidate.entries)])]
  const changed = ids.filter(id => canonicalJson(own(previous, id) ?? null) !== canonicalJson(own(candidate, id) ?? null))
  if (changed.length === 0) return refuse('NIGHT_GRANT_NO_CHANGE')
  if (changed.length > terms.maxOrgansPerUse) return refuse('NIGHT_GRANT_SCOPE_REFUSED')
  const organs = []
  for (const id of changed.sort()) {
    const before = own(previous, id), after = own(candidate, id)
    if (isT2OnlyOrgan(id, before, after)) return refuse('NIGHT_GRANT_GOVERNANCE_REFUSED')
    if (!ORGAN_ID.test(id)) return refuse('NIGHT_GRANT_SCOPE_REFUSED')
    if (!plain(after)) return refuse('NIGHT_GRANT_REMOVAL_REFUSED')
    if (after.disabled !== false || (before !== undefined && before.disabled !== false)) return refuse('NIGHT_GRANT_DISABLED_STATE_REFUSED')
    const sha = typeof after.specifier === 'string' && /^ball:[0-9a-f]{64}$/.test(after.specifier) ? after.specifier.slice(5) : null
    if (!sha || !Object.hasOwn(candidate.modules, sha)) return refuse('NIGHT_GRANT_SCOPE_REFUSED')
    // ADDS with no history and config {}, or CODE-ONLY updates whose history HEAD derives: nothing else.
    if (before === undefined) {
      if (!ordinaryAddShapeOk(id, after)) return refuse('NIGHT_GRANT_ADD_SHAPE_REFUSED')
    } else {
      const check = codeOnlyUpdateCheck(before, after)
      if (check === 'CONFIG_CHANGED' || check === 'NOT_CODE') return refuse('NIGHT_GRANT_CONFIG_CHANGE_REFUSED')
      if (check !== 'ok') return refuse('NIGHT_GRANT_HISTORY_REFUSED')
    }
    // Never the declared size: the verified byte length, or null in the pre-check that has no verified bytes yet.
    const size = typeof bytesOf === 'function' ? bytesOf(sha) : null
    organs.push(Object.freeze({ organId: id, sha256: sha, size: Number.isSafeInteger(size) ? size : null, kind: before === undefined ? 'add' : 'update' }))
  }
  if (!publishedModulesKept(previous, candidate)) return refuse('NIGHT_GRANT_MODULE_REMOVAL_REFUSED')
  // Every new module is run by exactly one changed organ; no unlisted module rides along.
  if (!newModulesOwned(previous, candidate, changed.map(id => own(candidate, id).specifier))) return refuse('NIGHT_GRANT_UNLISTED_MODULE_REFUSED')
  if (typeof bytesOf === 'function' && (!newModuleSizesMatch(previous, candidate, bytesOf)
    || organs.some(organ => organ.size === null))) return refuse('NIGHT_GRANT_MODULE_SIZE_REFUSED')
  return Object.freeze({ ok: true, organs: Object.freeze(organs) })
}
