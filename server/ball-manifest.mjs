/** Shared x6.1-ball/v1 serialization and structural checks; hosts own hashing and canonical policy. */
const isSha = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const entryVersionValid = entry => isObject(entry) && typeof entry.specifier === 'string' && entry.specifier.length > 0 && typeof entry.disabled === 'boolean' && isObject(entry.config)

/** Serialize the legacy ID fields, preserving nested property order and excluding other root metadata.
 * @param {object} ball Manifest with entry and module maps; validation is separate.
 * @returns {string} The exact UTF-8 string to hash for the legacy ID form.
 */
export const legacyManifestPreimage = ball => JSON.stringify({
  version: 'x6.1-ball/v1', parentBallId: ball.parentBallId, epoch: ball.epoch,
  entries: Object.keys(ball.entries).sort().map(key => ball.entries[key]),
  modules: Object.keys(ball.modules).sort().map(key => ball.modules[key]),
})

/** Check manifest fields and referenced module metadata without hashing or narrowing host canonical policy.
 * Unknown fields remain accepted. Entry failures and missing references precede module metadata failures.
 * @param {unknown} ball Candidate manifest.
 * @returns {string|null} The existing first structural failure code, or null before ID verification.
 */
export const validateManifestStructure = ball => {
  if (!isObject(ball) || ball.version !== 'x6.1-ball/v1' || !isSha(ball.ballId) || (ball.parentBallId !== null && !isSha(ball.parentBallId)) || !Number.isSafeInteger(ball.epoch) || ball.epoch < 0 || !isObject(ball.entries) || !isObject(ball.modules)) return 'INVALID_MANIFEST'
  for (const [id, entry] of Object.entries(ball.entries)) {
    if (!entryVersionValid(entry) || entry.id !== id || !Array.isArray(entry.previousSpecifiers) || entry.previousSpecifiers.some(specifier => typeof specifier !== 'string' || !specifier) || (entry.previousVersions !== undefined && (!Array.isArray(entry.previousVersions) || entry.previousVersions.some(version => !entryVersionValid(version))))) return 'INVALID_ENTRY'
    for (const version of [entry, ...(entry.previousVersions ?? []), ...entry.previousSpecifiers.map(specifier => ({ specifier }))]) {
      if (version.specifier.startsWith('ball:') && (!isSha(version.specifier.slice(5)) || !Object.hasOwn(ball.modules, version.specifier.slice(5)))) return 'MODULE_MISSING'
    }
  }
  for (const [sha, meta] of Object.entries(ball.modules)) if (!isSha(sha) || !isObject(meta) || meta.sha256 !== sha || meta.specifier !== `ball:${sha}`) return 'INVALID_MODULE'
  return null
}
