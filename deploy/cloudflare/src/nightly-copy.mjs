/** Complete, paged KV copies. No subsystem schema, restore, retention, or deletion lives here.
 * A copy may leave a row out or replace a field inside one, but never silently: both are named in the manifest. */
import { MESSAGES_STORAGE_KEY, redactMessagesForCopy } from './messages-store.mjs'
import { secretShapedPart, MIRROR_SECRET_RULE_VERSION } from './mirror-secret-paths.mjs'
export const NIGHTLY_PAGE_ROUTE = '/_nightly/page'
export const OBJECT_NAMES = Object.freeze(['HEAD', 'MIRROR', 'VOICE_BRIDGE', 'WITNESS'])
/** Rows that are never copied: credentials in flight, and owner recovery material. On the unseparated pepper
 * scheme the owner row holds the whole pepper and the wrapped root; a copied owner row would remove the Touch ID
 * and the attempt limit from guessing the seven recovery words, which a set holder could then do offline. The
 * nightly copy lane leaves it out; the owner archive-export route is a different lane and writes the whole row
 * into this same bucket under `snapshots/` when it runs, so the bucket is not guaranteed to be free of it. */
export const LEFT_OUT = Object.freeze({
  HEAD: Object.freeze(['aumlok:signin:v1', 'aumlok:devices:pending:v1', 'aumlok:v1']),
  MIRROR: Object.freeze([]), VOICE_BRIDGE: Object.freeze([]), WITNESS: Object.freeze([]),
})
/** Fields replaced inside an otherwise copied value. Pages and the manifest carry the KEY name only: REDACT holds
 * exactly one redactor per key, and a field label invented by the generic dumper would be a claim it cannot check. */
export const REDACT = Object.freeze({
  HEAD: Object.freeze({ [MESSAGES_STORAGE_KEY]: redactMessagesForCopy }),
  MIRROR: Object.freeze({}), VOICE_BRIDGE: Object.freeze({}), WITNESS: Object.freeze({}),
})
/** MIRROR rows never copied: the same secret-path rule every other MIRROR reader uses, applied to the path where the
 * mirror actually keeps it. A stored key carries `mirrorDigest(path)` — the digest, never the path — so a rule that
 * reads the key cannot see a name and matched nothing on real data (the fault this replaces). The path is in the
 * VALUE: an entry row holds `{ path, kind, chunks, bytes }`, and a reset row holds the path itself. A chunk row holds
 * no path at all, so its entry row is read by digest and the same judgement applied. Every conflict row (metadata and
 * chunks) is withheld too, as the archive export already omits conflicts. Only COUNTS are recorded, never a path or a
 * digest. */
export const MIRROR_WITHHELD_RULE = `mirror-hidden-path-rule:v${MIRROR_SECRET_RULE_VERSION}`
/** How the rule found the path, recorded beside the rule name. A set whose manifest has no marker was judged by the
 * key, so its withheld count says nothing about hidden paths; the two reads are recorded apart instead of looking
 * alike, and `/_host/nightly` reports a missing marker as null rather than as a count. */
export const MIRROR_WITHHELD_READS = 'value'
const MIRROR_ENTRY = 'mirror:v2:entry:'
const MIRROR_CHUNK = 'mirror:v2:chunk:'
const MIRROR_RESET = 'mirror:v2:reset:'
const MIRROR_CONFLICT = 'mirror:v2:conflict'
const MIRROR_KINDS = Object.freeze([[MIRROR_ENTRY, 'entry'], [MIRROR_CHUNK, 'chunk'], [MIRROR_RESET, 'reset']])
const mirrorKind = key => {
  if (key.startsWith(MIRROR_CONFLICT)) return 'conflict'
  for (const [prefix, kind] of MIRROR_KINDS) if (key.startsWith(prefix)) return kind
  return null
}
/** The path a row names in its own value, or undefined when that value cannot be read. A chunk names none (null). */
const ownMirrorPath = (kind, value) => {
  if (kind === 'entry') return value !== null && typeof value === 'object' && typeof value.path === 'string' ? value.path : undefined
  if (kind === 'reset') return typeof value === 'string' ? value : undefined
  return null
}
const hiddenMirrorPath = path => path === '' || path.split('/').some(secretShapedPart)
/** Why one MIRROR row must not be copied, or false to copy it.
 * An entry or reset row is judged by its own value. A chunk row carries only the path's digest, so the entry for that
 * digest is read and judged instead; a chunk whose entry is missing or is not a row with a string path is withheld,
 * because copying it would write bytes whose path nothing in storage still names (fail closed). A read that THROWS is
 * not evidence about the path: it rethrows as NightlyReadFault so the page fails, instead of publishing a "complete"
 * set that silently dropped a file's bytes. A conflict row is always withheld and counted apart from a hidden path: it
 * is a different fault.
 * @param {string} key Stored MIRROR key. @param {Map} listed The page's listed rows, read only for an entry or a reset row.
 * @param {(key: string) => Promise<any>} read Reads one stored key.
 * @param {Map<string, false|'hidden'>} [verdicts] Optional per-page cache, so a file with many chunks costs one entry read.
 * @returns {Promise<false|'hidden'|'conflict'>} The verdict for this row. Throws NightlyReadFault when the entry read fails. */
export async function withholdMirrorRow(key, listed, read, verdicts = null) {
  const kind = mirrorKind(key)
  if (kind === null) return false
  if (kind === 'conflict') return 'conflict'
  if (kind !== 'chunk') {
    const own = ownMirrorPath(kind, listed.get(key))
    return own === undefined || hiddenMirrorPath(own) ? 'hidden' : false
  }
  // `chunk` sorts before `entry`, so a file's bytes are met before its path: the entry is read, not awaited in order.
  const rest = key.slice(MIRROR_CHUNK.length), cut = rest.lastIndexOf(':')
  if (cut <= 0) return 'hidden'
  const digest = rest.slice(0, cut), cached = verdicts?.get(digest)
  if (cached !== undefined) return cached
  let entry
  try { entry = await read(MIRROR_ENTRY + digest) }
  catch (_error) {
    // A storage fault is not a hidden path: fail the page rather than publish a "complete" set missing bytes.
    const fault = new Error('NIGHTLY_MIRROR_READ_FAILED'); fault.name = 'NightlyReadFault'; throw fault
  }
  const path = ownMirrorPath('entry', entry)
  const verdict = path === undefined || hiddenMirrorPath(path) ? 'hidden' : false
  verdicts?.set(digest, verdict)
  return verdict
}
const WITHHOLD = Object.freeze({ HEAD: null, MIRROR: withholdMirrorRow, VOICE_BRIDGE: null, WITNESS: null })
const encoder = new TextEncoder()
const byteLength = text => encoder.encode(text).byteLength
const PAGE_BYTES = 4 * 1024 * 1024
const PAGE_ROWS = 1000
const WORLD = 'node-main-v1'
/** The name each object is reached under, exactly as its own callers reach it (worker.mjs, witness-do.mjs and
 * voice-bridge.mjs VOICE_BRIDGE_OBJECT_NAME). A wrong name here would address a NEW, empty object and copy nothing of the
 * real one while reporting a complete set; the test pins these against the callers' own constants. */
export const OBJECT_IDS = Object.freeze({ HEAD: WORLD, MIRROR: WORLD, VOICE_BRIDGE: 'x61-voice-bridge-v1', WITNESS: WORLD })
const SET_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z$/
const setName = time => new Date(time).toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/:/g, '-')
const setTime = set => Date.parse(set.replace(/T(\d{2})-(\d{2})-(\d{2})Z$/, 'T$1:$2:$3Z'))
const utf8Order = (a, b) => {
  const x = encoder.encode(a), y = encoder.encode(b)
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] - y[i]
  return x.length - y.length
}
const refuseValue = () => { const error = new Error('Value cannot be represented exactly'); error.name = 'NightlyValueError'; throw error }
const toBase64 = bytes => {
  let result = ''
  for (let i = 0; i < bytes.length; i += 8192) result += String.fromCharCode(...bytes.subarray(i, i + 8192))
  return btoa(result)
}
const fromBase64 = text => Uint8Array.from(atob(text), char => char.charCodeAt(0))

/** Encode one stored value as JSON-compatible data; unsupported values throw NightlyValueError.
 * @param {any} value Stored value. @returns {any} Tagged JSON data, not a serialized string. */
export function encodeValue(value) {
  const seen = new Set()
  const encode = item => {
    if (item === undefined) return { $undefined: true }
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) return refuseValue()
      return Object.is(item, -0) ? { $number: '-0' } : item
    }
    if (typeof item !== 'object' || seen.has(item)) return refuseValue()
    seen.add(item)
    const proto = Object.getPrototypeOf(item)
    if (proto === Uint8Array.prototype) {
      if (Reflect.ownKeys(item).length !== item.length) return refuseValue()
      return { $bytes: toBase64(item) }
    }
    if (proto === ArrayBuffer.prototype || proto === Date.prototype) {
      if (Reflect.ownKeys(item).length) return refuseValue()
      if (proto === ArrayBuffer.prototype) return { $buffer: toBase64(new Uint8Array(item)) }
      if (!Number.isFinite(item.getTime())) return refuseValue()
      return { $date: item.getTime() }
    }
    if (proto !== Object.prototype && proto !== Array.prototype) return refuseValue()
    const keys = Reflect.ownKeys(item)
    if (Array.isArray(item)) {
      if (keys.length !== item.length + 1) return refuseValue()
      for (let i = 0; i < item.length; i++) if (!Object.hasOwn(item, i)) return refuseValue()
    }
    const entries = []
    for (const key of keys) {
      if (Array.isArray(item) && key === 'length') continue
      const descriptor = Object.getOwnPropertyDescriptor(item, key)
      if (typeof key !== 'string' || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) return refuseValue()
      entries.push([key.startsWith('$') ? '$' + key : key, encode(descriptor.value)])
    }
    return Array.isArray(item) ? entries.map(([, value]) => value) : Object.fromEntries(entries)
  }
  return encode(value)
}

/** Decode data produced by encodeValue, preserving undefined members and literal dollar-prefixed keys.
 * @param {any} json Tagged JSON data. @returns {any} The represented stored value. */
export function decodeValue(json) {
  if (json === null || typeof json !== 'object') return json
  if (Array.isArray(json)) return json.map(decodeValue)
  if (Object.hasOwn(json, '$bytes')) return fromBase64(json.$bytes)
  if (Object.hasOwn(json, '$buffer')) return fromBase64(json.$buffer).buffer
  if (Object.hasOwn(json, '$date')) return new Date(json.$date)
  if (Object.hasOwn(json, '$undefined')) return undefined
  if (Object.hasOwn(json, '$number')) return -0
  return Object.fromEntries(Object.entries(json).map(([key, value]) => [key.startsWith('$$') ? key.slice(1) : key, decodeValue(value)]))
}

/** Read a bounded page in storage order. Excluded values are never accessed in the returned Map or encoded.
 * A redactor runs before encoding and signals a replacement by returning a different value; returning the same
 * value means nothing needed replacing and the copy records no redaction. A name is recorded on the page that
 * actually carries the row: a row held over by the byte budget is named when it lands, not on the page before.
 * If a redactor throws, the page fails
 * instead of copying the unreplaced value. list() itself returns values: the platform has no keys-only list
 * option. bytes measures the rows' JSON text.
 * @param {object} storage Durable Object KV storage. @param {object} options Cursor, page bounds, omitted keys, redactors.
 * @returns {Promise<object>} Rows, exclusive continuation cursor, byte count, and omitted, redacted and unreadable key names. */
export async function dumpPage(storage, { after, maxBytes = PAGE_BYTES, maxRows = PAGE_ROWS, leaveOut = [], redact = {}, withhold = null } = {}) {
  if (!Number.isSafeInteger(maxRows) || maxRows < 1 || maxRows > PAGE_ROWS || !Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new RangeError('Invalid page bounds')
  const rows = [], leftOut = [], unreadable = [], redacted = []
  let withheld = 0, withheldHidden = 0, withheldConflict = 0
  let bytes = 2, cursor = after ?? null, scanned = 0
  // A withheld row's value is never encoded, and a chunk's own value is never read: the rule reads its entry instead.
  const read = key => typeof storage.get === 'function' ? storage.get(key) : Promise.reject(new Error('NIGHTLY_NO_READER'))
  // One entry read per file on this page: consecutive chunk keys share a digest, so the same verdict is reused.
  const verdicts = withhold === withholdMirrorRow ? new Map() : null
  for (;;) {
    // Small list batches avoid materializing 1000 maximum-size stored values before enforcing the byte budget.
    const limit = Math.min(32, maxRows - scanned + 1)
    const listed = await storage.list({ ...(cursor === null ? {} : { startAfter: cursor }), limit })
    for (const key of listed.keys()) {
      if (scanned === maxRows) return { rows, next: cursor, bytes, leftOut, unreadable, redacted, withheld, withheldHidden, withheldConflict }
      const omitted = leaveOut.includes(key)
      const verdict = omitted || withhold === null ? false : await withhold(key, listed, read, verdicts)
      if (omitted) leftOut.push(key)
      // 'conflict' and 'hidden' are counted apart: a rule hit and a fault row are different facts to report.
      else if (verdict) { withheld++; if (verdict === 'conflict') withheldConflict++; else withheldHidden++ }
      else {
        let encoded, replaced = false
        try {
          const value = listed.get(key), replace = Object.hasOwn(redact, key) ? redact[key] : null
          const projected = replace === null ? value : replace(value)
          encoded = encodeValue(projected)
          replaced = replace !== null && projected !== value
        }
        catch (error) {
          if (error.name !== 'NightlyValueError') throw error
          unreadable.push(key)
        }
        if (encoded !== undefined) {
          const row = [key, encoded], size = byteLength(JSON.stringify(row)) + (rows.length ? 1 : 0)
          if (rows.length && bytes + size > maxBytes) return { rows, next: cursor, bytes, leftOut, unreadable, redacted, withheld, withheldHidden, withheldConflict }
          rows.push(row); bytes += size
          // Named only once the row is in a page: a row held over to the next page is named there, not on both.
          if (replaced) redacted.push(key)
        }
      }
      cursor = key; scanned++
    }
    if (listed.size < limit) return { rows, next: null, bytes, leftOut, unreadable, redacted, withheld, withheldHidden, withheldConflict }
  }
}

/** Read-only internal DO endpoint. Called before request diagnostics so even diagnostics cannot write.
 * @param {Request} request Internal GET. @param {object} storage Own storage. @param {string} object Object binding name.
 * @returns {Promise<Response>} A page and guarded SQLite restore-point metadata. */
export async function nightlyPageResponse(request, storage, object) {
  if (request.headers.get('x-x6-internal-authorized') !== '1') return Response.json({ code: 'UNAUTHORIZED' }, { status: 401 })
  const url = new URL(request.url)
  if (request.method !== 'GET' || url.hash || [...url.searchParams.keys()].some(key => !['after', 'maxRows', 'maxBytes'].includes(key))) return Response.json({ code: 'NIGHTLY_REQUEST_INVALID' }, { status: 400 })
  const options = { leaveOut: LEFT_OUT[object], redact: REDACT[object], withhold: WITHHOLD[object] }
  if (url.searchParams.has('after')) options.after = url.searchParams.get('after')
  for (const field of ['maxRows', 'maxBytes']) if (url.searchParams.has(field)) options[field] = Number(url.searchParams.get(field))
  const bookmark = async () => {
    if (typeof storage.getCurrentBookmark !== 'function') return { value: null, reason: 'unavailable' }
    try { return { value: await storage.getCurrentBookmark(), reason: null } }
    catch (_error) { return { value: null, reason: 'failed' } }
  }
  const before = options.after === undefined ? await bookmark() : null
  const page = await dumpPage(storage, options)
  const after = page.next === null ? await bookmark() : null
  return Response.json({ ...page, bookmarkBefore: before, bookmarkAfter: after,
    alarm: options.after === undefined && typeof storage.getAlarm === 'function' ? await storage.getAlarm() : null })
}

/** Hash exact UTF-8 page/manifest text. @param {string} text Text to hash. @returns {Promise<string>} SHA-256 hex. */
export async function nightlySha256(text) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text)))].map(x => x.toString(16).padStart(2, '0')).join('')
}
const readJson = async (bucket, key) => {
  const object = await bucket.get(key)
  return object ? JSON.parse(await object.text()) : null
}
const windowOf = now => {
  const date = new Date(now)
  date.setUTCHours(19, 0, 0, 0)
  if (date.getTime() > now) date.setUTCDate(date.getUTCDate() - 1)
  return date.toISOString()
}
/** Determine whether this UTC night's successful copy is missing.
 * @param {object|null} latest Finished LATEST pointer. @param {number} now Current epoch milliseconds.
 * @returns {boolean} Whether a copy is due, independently of the attempt budget. */
export function nightlyDue(latest, now) {
  if (!latest?.finishedAt || latest.complete === false) return true
  const date = new Date(now)
  if (date.getUTCHours() < 19) return false
  date.setUTCHours(19, 0, 0, 0)
  return (latest.startedAt ? Date.parse(latest.startedAt) : setTime(latest.set)) < date.getTime()
}
const pageReader = (env, name) => async options => {
  const binding = env[name]
  const url = new URL('https://x61.internal' + NIGHTLY_PAGE_ROUTE)
  for (const [key, value] of Object.entries(options)) if (value !== undefined && value !== null) url.searchParams.set(key, String(value))
  const response = await binding.get(binding.idFromName(OBJECT_IDS[name])).fetch(new Request(url, {
    headers: { 'x-x6-internal-authorized': '1' }, signal: AbortSignal.timeout(60000),
  }))
  if (!response.ok) throw new Error('NIGHTLY_PAGE_FAILED')
  return response.json()
}
async function listAll(bucket, prefix, visit) {
  let cursor
  do {
    const page = await bucket.list({ prefix, limit: 1000, ...(cursor ? { cursor } : {}) })
    for (const object of page.objects) await visit(object)
    if (page.truncated && (!page.cursor || page.cursor === cursor)) throw new Error('NIGHTLY_LIST_FAILED')
    cursor = page.truncated ? page.cursor : null
  } while (cursor)
}
async function vaultInventory(bucket) {
  const objects = []
  await listAll(bucket, `w/${WORLD}/blob/`, object => { objects.push([object.key, object.size]) })
  objects.sort(([a], [b]) => utf8Order(a, b))
  return { count: objects.length, bytes: objects.reduce((sum, [, size]) => sum + size, 0),
    sha256: await nightlySha256(objects.map(([key, size]) => `${key} ${size}\n`).join('')) }
}

/** Copy all four objects, isolating failures; only a complete manifest can become LATEST.
 * Attempts are reserved by conditional R2 writes before copying. An unfinished reservation spends one attempt.
 * @param {object} env Worker bindings. @param {object} options Injectable clock, page readers, and bucket.
 * @returns {Promise<object>} Manifest, or a closed skip/failure code. */
export async function runNightlyCopy(env, { now = Date.now, objects, bucket = env.ARCHIVE_BUCKET } = {}) {
  if (env.NIGHTLY_COPY !== 'on') return { code: 'NIGHTLY_OFF' }
  if (!bucket) return { code: 'NIGHTLY_BUCKET_UNAVAILABLE' }
  const clock = typeof now === 'function' ? now : () => now
  const started = clock(), window = windowOf(started)
  let state, reserved
  try {
    if (!nightlyDue(await readJson(bucket, 'nightly/LATEST.json'), started)) return { code: 'NIGHTLY_NOT_DUE' }
    const previous = await bucket.get('nightly/STATE.json')
    state = previous ? JSON.parse(await previous.text()) : null
    if (state?.window === window && state.attempts >= 3) return { code: 'NIGHTLY_ATTEMPTS_EXHAUSTED' }
    // A live reservation excludes overlapping cron deliveries, including deliveries from another isolate.
    if (state?.window === window && state.code === 'NIGHTLY_RUNNING' && started - Date.parse(state.startedAt) < 60 * 60 * 1000) return { code: 'NIGHTLY_BUSY' }
    state = { window, attempts: state?.window === window ? state.attempts + 1 : 1, startedAt: new Date(started).toISOString(), code: 'NIGHTLY_RUNNING' }
    reserved = await bucket.put('nightly/STATE.json', JSON.stringify(state), { onlyIf: previous ? { etagMatches: previous.etag } : { etagDoesNotMatch: '*' } })
    if (!reserved) return { code: 'NIGHTLY_BUSY' }
  } catch (_error) { return { code: 'NIGHTLY_STATE_FAILED' } }
  const finishState = async code => {
    try { await bucket.put('nightly/STATE.json', JSON.stringify({ ...state, code }), { onlyIf: { etagMatches: reserved.etag } }) }
    catch (_error) { console.warn('NIGHTLY_STATE_FAILED') }
  }
  const set = setName(started)
  const manifest = { schema: 'aukora.nightly-copy.v1', set, startedAt: new Date(started).toISOString(), finishedAt: null,
    buildSha: env.SOURCE_REVISION || 'UNVERIFIED', sourceRevision: typeof env.SOURCE_REVISION === 'string' && /^[0-9a-f]{40,64}$/.test(env.SOURCE_REVISION) ? env.SOURCE_REVISION : null,
    objects: {}, vault: null, complete: false }
  try {
    // Never overwrite even an unfinished set with the same second-resolution name.
    const collision = await bucket.list({ prefix: `nightly/${set}/`, limit: 1 })
    if (collision.objects.length) { await finishState('NIGHTLY_SET_EXISTS'); return { code: 'NIGHTLY_SET_EXISTS' } }
    for (const name of OBJECT_NAMES) {
      const result = manifest.objects[name] = { pages: [], rows: 0, bytes: 0, leftOut: [], redacted: [], withheld: 0,
        withheldHidden: 0, withheldConflict: 0, withheldRule: name === 'MIRROR' ? MIRROR_WITHHELD_RULE : null,
        withheldReads: name === 'MIRROR' ? MIRROR_WITHHELD_READS : null, unreadable: [], alarm: null,
        bookmarkBefore: null, bookmarkAfter: null, bookmarkBeforeReason: 'unavailable', bookmarkAfterReason: 'unavailable', changedDuring: null, complete: false, code: null }
      let code = 'NIGHTLY_PAGE_FAILED'
      try {
        const readPage = objects?.[name] ?? pageReader(env, name)
        let after, firstHash
        do {
          code = 'NIGHTLY_PAGE_FAILED'
          const page = await readPage({ after })
          if (!Array.isArray(page.rows) || !Array.isArray(page.leftOut) || !Array.isArray(page.redacted) || !Array.isArray(page.unreadable)
            || !Number.isSafeInteger(page.withheld) || page.withheld < 0
            // A page that cannot say how many of its withheld rows were hidden paths comes from code that judged the
            // key, so its count is not evidence; the sum check catches a page that counts the same row twice.
            || !Number.isSafeInteger(page.withheldHidden) || page.withheldHidden < 0
            || !Number.isSafeInteger(page.withheldConflict) || page.withheldConflict < 0
            || page.withheldHidden + page.withheldConflict !== page.withheld
            || !(page.next === null || typeof page.next === 'string' && (after === undefined || utf8Order(page.next, after) > 0))) throw new Error('Invalid page')
          const text = JSON.stringify({ rows: page.rows }), sha256 = await nightlySha256(text)
          if (after === undefined) {
            firstHash = sha256
            result.alarm = page.alarm ?? null
            result.bookmarkBefore = page.bookmarkBefore?.value ?? null
            result.bookmarkBeforeReason = page.bookmarkBefore?.reason ?? 'unavailable'
          }
          if (page.next === null) {
            result.bookmarkAfter = page.bookmarkAfter?.value ?? null
            result.bookmarkAfterReason = page.bookmarkAfter?.reason ?? 'unavailable'
          }
          code = 'NIGHTLY_PAGE_WRITE_FAILED'
          const key = `nightly/${set}/${name}/${String(result.pages.length).padStart(5, '0')}.json`, bytes = byteLength(text)
          await bucket.put(key, text)
          result.pages.push({ key, sha256, bytes, rows: page.rows.length })
          result.rows += page.rows.length; result.bytes += bytes
          result.leftOut.push(...page.leftOut); result.redacted.push(...page.redacted); result.withheld += page.withheld
          result.withheldHidden += page.withheldHidden; result.withheldConflict += page.withheldConflict; result.unreadable.push(...page.unreadable)
          after = page.next
        } while (after !== null)
        // A cheap comparison, not an atomic snapshot or a guarantee about unobserved middle pages.
        try {
          const again = await readPage({})
          const changed = await nightlySha256(JSON.stringify({ rows: again.rows })) !== firstHash
          result.changedDuring = changed ? true : result.pages.length === 1 && again.next === null ? false : null
        } catch (_error) { /* A failed second read cannot establish stability. */ }
        // Two equal bookmarks prove nothing was written in between. Two different ones prove nothing: whether a
        // bookmark moves with time alone is NOT VERIFIED on the platform, so they never say "changed".
        if (result.changedDuring !== true && result.bookmarkBefore !== null && result.bookmarkBefore === result.bookmarkAfter) result.changedDuring = false
        result.complete = result.unreadable.length === 0
        if (!result.complete) result.code = 'NIGHTLY_UNREADABLE'
      } catch (_error) { result.code = code }
    }
    try { manifest.vault = await vaultInventory(bucket) }
    catch (_error) { manifest.vault = { count: null, bytes: null, sha256: null, code: 'NIGHTLY_VAULT_FAILED' } }
    manifest.complete = OBJECT_NAMES.every(name => manifest.objects[name].complete) && !manifest.vault.code
    manifest.finishedAt = new Date(clock()).toISOString()
    const text = JSON.stringify(manifest), sha256 = await nightlySha256(text)
    try { await bucket.put(`nightly/${set}/manifest.json`, text) }
    catch (_error) { await finishState('NIGHTLY_MANIFEST_WRITE_FAILED'); return { code: 'NIGHTLY_MANIFEST_WRITE_FAILED' } }
    if (manifest.complete) {
      try {
        const previous = await bucket.get('nightly/LATEST.json')
        const pointer = previous ? JSON.parse(await previous.text()) : null
        if (!pointer || setTime(pointer.set) < started) {
          const written = await bucket.put('nightly/LATEST.json', JSON.stringify({ set, sha256, finishedAt: manifest.finishedAt }),
            { onlyIf: previous ? { etagMatches: previous.etag } : { etagDoesNotMatch: '*' } })
          if (!written) throw new Error('NIGHTLY_LATEST_WRITE_FAILED')
        }
      }
      catch (_error) { await finishState('NIGHTLY_LATEST_WRITE_FAILED'); return { code: 'NIGHTLY_LATEST_WRITE_FAILED' } }
    }
    await finishState(manifest.complete ? 'NIGHTLY_COMPLETE' : 'NIGHTLY_INCOMPLETE')
    return manifest
  } catch (_error) { await finishState('NIGHTLY_FAILED'); return { code: 'NIGHTLY_FAILED' } }
}

/** Read and verify the latest manifest without reading any row pages.
 * @param {object} bucket R2 binding. @returns {Promise<object|null>} Latest verified manifest, or null without a pointer. */
export async function latestNightly(bucket) {
  if (!bucket) return null
  const pointer = await readJson(bucket, 'nightly/LATEST.json')
  if (!pointer) return null
  if (!SET_RE.test(pointer.set)) throw new Error('NIGHTLY_POINTER_INVALID')
  const object = await bucket.get(`nightly/${pointer.set}/manifest.json`)
  if (!object) throw new Error('NIGHTLY_MANIFEST_MISSING')
  const text = await object.text()
  if (await nightlySha256(text) !== pointer.sha256) throw new Error('NIGHTLY_MANIFEST_HASH_MISMATCH')
  return JSON.parse(text)
}

/** Owner status for the newest manifest (including incomplete sets): counts and presence flags only, never row data, key lists, or bookmark values.
 * @param {object} bucket R2 binding. @returns {Promise<object>} Latest counts, attempts and newest 30 manifests. */
export async function nightlyStatus(bucket) {
  if (!bucket) return { latest: null, attempts: null, sets: [], code: 'NIGHTLY_BUCKET_UNAVAILABLE' }
  const latestComplete = await latestNightly(bucket), sets = []
  let manifest = null
  await listAll(bucket, 'nightly/', object => {
    const match = /^nightly\/([^/]+)\/manifest\.json$/.exec(object.key)
    if (match && SET_RE.test(match[1])) {
      sets.push({ set: match[1], key: object.key })
      sets.sort((a, b) => utf8Order(b.set, a.set))
      if (sets.length > 30) sets.pop()
    }
  })
  const summaries = []
  for (const item of sets) {
    const object = await bucket.get(item.key)
    if (!object) throw new Error('NIGHTLY_MANIFEST_MISSING')
    const text = await object.text()
    if (manifest === null) manifest = JSON.parse(text)
    summaries.push({ set: item.set, sha256: await nightlySha256(text) })
  }
  return { latest: manifest ? { set: manifest.set, complete: manifest.complete, finishedAt: manifest.finishedAt,
    objects: Object.fromEntries(OBJECT_NAMES.map(name => {
      const object = manifest.objects[name]
      return [name, { rows: object.rows, bytes: object.bytes, pages: object.pages.length, leftOut: object.leftOut.length,
        redacted: Array.isArray(object.redacted) ? object.redacted.length : null, withheld: Number.isSafeInteger(object.withheld) ? object.withheld : null,
        // A manifest written before the rule read the value reports both split counts and the marker as null rather
        // than as zero: its single withheld count cannot say whether any hidden path was actually withheld.
        withheldHidden: Number.isSafeInteger(object.withheldHidden) ? object.withheldHidden : null,
        withheldConflict: Number.isSafeInteger(object.withheldConflict) ? object.withheldConflict : null,
        withheldReads: object.withheldReads === MIRROR_WITHHELD_READS ? MIRROR_WITHHELD_READS : null,
        unreadable: object.unreadable.length, changedDuring: object.changedDuring,
        bookmarks: { before: object.bookmarkBefore !== null, after: object.bookmarkAfter !== null }, complete: object.complete, code: object.code }]
    })), vault: { count: manifest.vault.count, bytes: manifest.vault.bytes } } : null,
    latestCompleteSet: latestComplete?.set ?? null, attempts: await readJson(bucket, 'nightly/STATE.json'), sets: summaries }
}
