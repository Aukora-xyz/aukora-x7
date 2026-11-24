/** Bounded metadata comparison of retained HEAD manifests, never module bodies or entry contents. */
export const STATE_DIFF_LIMITS = Object.freeze({ manifestBytes: 256 * 1024, entries: 256, changes: 100 })
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const fields = (value, names) => object(value) && Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name))
const sha = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
const epoch = value => Number.isSafeInteger(value) && value >= 0
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)
const idAllowed = value => typeof value === 'string' && !value.includes('..') && !value.startsWith('/') && !value.endsWith('/') && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}(?::[0-9a-f]{64})?$/.test(value)
const unavailable = code => ({ state: 'unavailable', basis: 'none', changes: null, total: null, truncated: false, limit: STATE_DIFF_LIMITS.changes, code })

/** Validate an exact HEAD identity supplied across a request or storage boundary.
 * @param {object} value Untrusted identity.
 * @returns {boolean} Whether both identity fields are valid, with no extras.
 */
export const validHeadIdentity = value => fields(value, ['ballId', 'epoch']) && sha(value.ballId) && epoch(value.epoch)
export const validHeadBase = value => validHeadIdentity(value) || fields(value, ['ballId']) && sha(value.ballId)

/** Validate a MIRROR fence without accepting private state or extra fields.
 * @param {object} value Untrusted fence.
 * @returns {boolean} Whether the UUID and positive revision are valid.
 */
export const validMirrorIdentity = value => fields(value, ['lineageId', 'revision']) && uuid(value.lineageId) && Number.isSafeInteger(value.revision) && value.revision >= 1

/** Validate the optional complete baseline; omission means snapshot only.
 * @param {object|string|undefined} value Caller baseline, not an attestation of earlier MIRROR state.
 * @returns {boolean} Whether the baseline is absent, a 64-hex ballId, or contains exactly two valid identities.
 */
export const validStateDiffBase = value => value === undefined || sha(value) || fields(value, ['head', 'mirror']) && validHeadIdentity(value.head) && validMirrorIdentity(value.mirror)

async function manifest(tx, id, validateManifest, canonicalize) {
  if (!sha(id)) throw new Error('STATE_DIFF_MANIFEST_INVALID')
  const count = await tx.get(`manifest:${id}:count`)
  if (count === undefined) return null
  if (!Number.isSafeInteger(count) || count < 1 || count > Math.ceil(STATE_DIFF_LIMITS.manifestBytes / 24000)) throw new Error('STATE_DIFF_MANIFEST_INVALID')
  let raw = '', bytes = 0
  for (let index = 0; index < count; index++) {
    const chunk = await tx.get(`manifest:${id}:${index}`)
    if (typeof chunk !== 'string' || chunk.length > 24000) throw new Error('STATE_DIFF_MANIFEST_INVALID')
    bytes += new TextEncoder().encode(chunk).length
    if (bytes > STATE_DIFF_LIMITS.manifestBytes) throw new Error('STATE_DIFF_MANIFEST_INVALID')
    raw += chunk
  }
  const value = JSON.parse(raw)
  if (!object(value) || value.ballId !== id || !object(value.entries) || Object.keys(value.entries).length > STATE_DIFF_LIMITS.entries) throw new Error('STATE_DIFF_MANIFEST_INVALID')
  canonicalize(value)
  if (await validateManifest(value)) throw new Error('STATE_DIFF_MANIFEST_INVALID')
  return value
}

/** Compare bounded retained manifests inside the caller's single HEAD storage transaction.
 * @param {object} tx Transactional storage reader.
 * @param {object|undefined} base Caller-selected retained manifest identity; retention does not attest prior selection or ancestry. Omission returns current metadata only.
 * @param {Function} validateManifest Existing immutable manifest verifier.
 * @param {Function} canonicalize Existing depth/node-bounded canonical serializer.
 * @returns {Promise<object>} Versions and changed entry IDs, with explicit missing-basis or metadata failures.
 */
export async function readHeadStateDiff(tx, base, validateManifest, canonicalize) {
  if (base !== undefined && !validHeadBase(base)) return { ok: false, code: 'STATE_DIFF_BASE_INVALID', status: 400 }
  let current
  try { current = await manifest(tx, await tx.get('head'), validateManifest, canonicalize) }
  catch (_error) { return { ok: false, code: 'STATE_DIFF_HEAD_UNAVAILABLE', status: 503 } }
  if (!current) return { ok: false, code: 'STATE_DIFF_HEAD_UNAVAILABLE', status: 503 }
  const result = { ok: true, state: 'available', base: base ? { ballId: base.ballId, epoch: base.epoch ?? current.epoch } : null, current: { ballId: current.ballId, epoch: current.epoch }, changed: null,
    entries: unavailable('STATE_DIFF_BASE_REQUIRED') }
  if (base === undefined) return result
  let before
  try { before = base.ballId === current.ballId ? current : await manifest(tx, base.ballId, validateManifest, canonicalize) }
  catch (_error) { result.entries = unavailable('STATE_DIFF_BASE_UNAVAILABLE'); return result }
  if (!before) { result.entries = unavailable('STATE_DIFF_BASE_UNAVAILABLE'); return result }
  if (base.epoch !== undefined && before.epoch !== base.epoch) return { ok: false, code: 'STATE_DIFF_BASE_MISMATCH', status: 409 }
  result.base = { ballId: before.ballId, epoch: before.epoch }
  result.changed = current.ballId !== before.ballId || current.epoch !== before.epoch
  const ids = [...new Set([...Object.keys(before.entries), ...Object.keys(current.entries)])].sort()
  if (ids.some(id => !idAllowed(id))) { result.entries = unavailable('STATE_DIFF_ENTRIES_UNAVAILABLE'); return result }
  const changes = []
  for (const id of ids) {
    const prior = Object.hasOwn(before.entries, id), next = Object.hasOwn(current.entries, id)
    if (!prior) changes.push({ id, status: 'added' })
    else if (!next) changes.push({ id, status: 'removed' })
    else if (canonicalize(before.entries[id]) !== canonicalize(current.entries[id])) changes.push({ id, status: 'modified' })
  }
  result.entries = { state: 'available', basis: 'retained-manifests', changes: changes.slice(0, STATE_DIFF_LIMITS.changes),
    total: changes.length, truncated: changes.length > STATE_DIFF_LIMITS.changes, limit: STATE_DIFF_LIMITS.changes }
  return result
}

/** Project a bounded HEAD diff from the internal wire response.
 * @param {object} value Untrusted HEAD result.
 * @param {object|undefined} base Exact requested baseline.
 * @returns {object} Copied metadata or throws on malformed evidence.
 */
export function projectHeadStateDiff(value, base) {
  if (value?.ok !== true || value.state !== 'available' || !validHeadIdentity(value.current)
    || (base === undefined ? value.base !== null : !validHeadIdentity(value.base) || value.base.ballId !== base.ballId || (base.epoch !== undefined && value.base.epoch !== base.epoch))
    || ![true, false, null].includes(value.changed)) throw new Error('STATE_DIFF_HEAD_INVALID')
  const entries = value.entries
  let projected
  if (entries?.state === 'unavailable' && ['STATE_DIFF_BASE_REQUIRED', 'STATE_DIFF_BASE_UNAVAILABLE', 'STATE_DIFF_ENTRIES_UNAVAILABLE'].includes(entries.code)) {
    if ((entries.code === 'STATE_DIFF_BASE_REQUIRED') !== (base === undefined)) throw new Error('STATE_DIFF_HEAD_INVALID')
    projected = unavailable(entries.code)
  } else {
    if (entries?.state !== 'available' || entries.basis !== 'retained-manifests' || !base || !Array.isArray(entries.changes)
      || entries.changes.length > STATE_DIFF_LIMITS.changes || !Number.isSafeInteger(entries.total) || entries.total < 0 || entries.total > 2 * STATE_DIFF_LIMITS.entries
      || entries.changes.length !== Math.min(entries.total, STATE_DIFF_LIMITS.changes) || entries.truncated !== (entries.total > STATE_DIFF_LIMITS.changes)
      || value.changed === false && entries.total !== 0
      || entries.limit !== STATE_DIFF_LIMITS.changes || new Set(entries.changes.map(change => change?.id)).size !== entries.changes.length
      || entries.changes.some(change => !object(change) || !idAllowed(change.id) || !['added', 'removed', 'modified'].includes(change.status))) throw new Error('STATE_DIFF_HEAD_INVALID')
    projected = { state: 'available', basis: 'retained-manifests', changes: entries.changes.map(({ id, status }) => ({ id, status })), total: entries.total, truncated: entries.truncated, limit: entries.limit }
  }
  const resolvedBase = value.base ?? base ?? null
  if (projected.state === 'available' && value.changed !== (resolvedBase.ballId !== value.current.ballId || resolvedBase.epoch !== value.current.epoch)
    || (!base || projected.code === 'STATE_DIFF_BASE_UNAVAILABLE') && value.changed !== null) throw new Error('STATE_DIFF_HEAD_INVALID')
  return { state: 'available', base: resolvedBase, current: { ballId: value.current.ballId, epoch: value.current.epoch }, changed: value.changed, entries: projected }
}
