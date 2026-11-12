/**
 * RESTORE FROM A RECOVERY SNAPSHOT (aukora.recovery-snapshot.v1, made by the Continuity screen) INTO AN EMPTY EDGE.
 *
 * One source for two places: `recoveryRestoreKit` is a SELF-CONTAINED function (no imports, no outer names), so the
 * Worker can serve `recoveryRestoreKit.toString()` to the empty-edge restore page and Node tests run the very same
 * bytes. Only WebCrypto, TextEncoder/TextDecoder, atob and fetch are used.
 *
 * What it does, in order, and nothing else:
 *   1. EDGE ONLY. The target must say it is the Cloudflare edge: `GET /__x6/status` answers `runtime: "cloudflare"`,
 *      or (an empty edge cannot answer status yet) it answers 503 BOOTSTRAP_REQUIRED and `GET /api/health` answers
 *      `runtime: "cloudflare"` with `macDependency: false`. The Mac host never qualifies.
 *   2. EVERY PART IS VERIFIED BEFORE ANYTHING IS WRITTEN: each captured part's bytes are rebuilt from the file and must
 *      match its recorded length and SHA-256; then the manifest digest must match. The first part that fails stops the
 *      whole restore and is named. The Pearl (`/_head/ball`) and the mirror (`/_mirror/export`) are required.
 *   3. NEVER OVER LIVE STATE. It writes only into an EMPTY edge (no HEAD, no mirror), through the edge's existing
 *      `/_bootstrap` seed path, which re-verifies the manifest, every module hash and every mirror batch digest and
 *      itself refuses an initialized world. A live edge is only compared: identical = "already here", anything else is
 *      refused with the comparison shown. Nothing here can roll a live HEAD or mirror back.
 *   4. The owner must confirm explicitly (`confirm: true`) after seeing the comparison.
 *   5. After writing, it reads the edge back and requires the SAME HEAD epoch and ballId, the SAME receipt
 *      high-water mark (count, last receipt seq and hash, receipts file SHA-256, checkpoint count) and the same
 *      whole-mirror digest as the snapshot.
 *
 * What it does NOT restore (the snapshot does not hold them): the AUMLOK owner binding and passkey, Messages, turn
 * journal, provider budget, HEAD history before the selected Pearl. Each is reported, never implied; so are the rows of
 * an older file that the secret-path rule leaves out (`leftOut`, counted by kind, in `notRestored`). Mirror deletion
 * markers (`resetPaths`) ARE restored and are part of every comparison.
 * @module recovery-restore
 */
export function recoveryRestoreKit(options = {}) {
  const SCHEMA = 'aukora.recovery-snapshot.v1'
  const ROUTES = ['/_head/ball', '/__x6/facts', '/_host/estate', '/_mirror/export']
  const REQUIRED = ['/_head/ball', '/_mirror/export']
  const RECEIPTS_PATH = '/dsh/home/auma/seed/receipts.v3.jsonl'
  const CHECKPOINTS_PATH = '/dsh/home/auma/seed/checkpoints.v1.jsonl'
  const BATCH_ENTRIES = 10000
  // The edge reads at most this many BYTES of one /_bootstrap request (BOOTSTRAP_LIMITS.requestBytes). Every request this
  // kit sends is measured in UTF-8 bytes against it, whole envelope included. Tests may pass a smaller bound.
  const REQUEST_BYTES = Number.isSafeInteger(options.requestBytes) && options.requestBytes > 0 ? options.requestBytes : 34 * 1024 * 1024
  const MAX_BATCHES = 256
  const MAX_ENTRIES = 20000
  const FILE_BYTES = 24 * 1024 * 1024
  const STATE_BYTES = 128 * 1024 * 1024
  const METADATA_BYTES = 8 * 1024 * 1024
  const PACKAGE_BYTES = 34 * 1024 * 1024
  const encoder = new TextEncoder()
  const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  const isSha = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
  const refusal = (code, extra = {}) => ({ ok: false, code, ...extra })
  const hex = buffer => [...new Uint8Array(buffer)].map(byte => byte.toString(16).padStart(2, '0')).join('')
  const sha256 = async bytes => hex(await crypto.subtle.digest('SHA-256', typeof bytes === 'string' ? encoder.encode(bytes) : bytes))
  // The same canonical form as the edge's `canonicalBootstrap` and the client's `canonicalJson` for these values.
  const canonical = value => {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
    if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
    if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
    if (isObject(value)) return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}'
    throw Object.assign(new Error('RECOVERY_VALUE_INVALID'), { code: 'RECOVERY_VALUE_INVALID' })
  }
  const base64Bytes = text => {
    if (typeof text !== 'string' || text.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) return null
    const binary = atob(text), bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
    return bytes
  }
  const utf8 = bytes => { try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { return null } }

  /** The bytes a part claims the host sent, rebuilt from the file; null when they cannot be rebuilt. */
  const partBytes = part => {
    if (part.encoding === 'json') {
      const text = JSON.stringify(part.body)
      return typeof text === 'string' ? encoder.encode(text) : null
    }
    return part.encoding === 'base64' ? base64Bytes(part.body) : null
  }

  /** One digest over a whole mirror inventory (paths, kinds, modes, times, bytes), so "already current" means all of it. */
  // Deletion markers (`resetPaths`) are part of her memory: without them a deleted packaged file comes back.
  const mirrorDigest = (entries, resetPaths) => sha256(canonical({ entries: entries.map(([path, wire]) => [path, wire.kind === 'dir'
    ? { kind: 'dir', mode: wire.mode } : { kind: 'file', mode: wire.mode, mtimeMs: wire.mtimeMs, b64: wire.b64 }]), resetPaths: [...resetPaths].sort() }))
  // THE SECRET-PATH RULE: a copy of mirror-secret-paths.mjs `MIRROR_SECRET_NAMES` / `MIRROR_SECRET_PREFIXES`
  // / `MIRROR_SECRET_SUFFIX` / `secretShapedPart` (this kit is self-contained, serialized into the page);
  // recovery-restore.test.mjs fails when they differ. A snapshot exported before that rule may name such a path (a
  // credentials temp copy, or its deletion marker): the edge now neither takes nor exports one, so a restore leaves it out
  // and every comparison is made without it. Only what the older edge rule admitted (no part an exact secret name,
  // `pepper.v1` aside, or a `.env` / `.aukora-` name) is left out; anything that rule also refused could never have been
  // exported and is still refused by the edge preflight.
  const SECRET_NAMES = ['.credentials.yaml', 'credentials.yaml', 'session.cap', '.afferent-probe', 'ed25519-keypair.json', '.credentials', '.ssh', '.aws', '.transport', 'pepper.v1']
  const SECRET_PREFIXES = ['.env', '.aukora-', 'pepper.v1.']
  // A stem (a secret name, or it with ONE extra leading dot), suffix segments, then at most one `~`. One way to match each
  // token (digits 1 to 5 or 65 and more; 6 to 64 are hex) and a lone `~` cannot start a segment: linear in the name.
  const SECRET_SUFFIX = /^(?:[.~_-](?:[0-9a-fA-F]{6,64}|[0-9]{1,5}|[0-9]{65,}|tmp|temp|lock|bak|backup|old|new|next|prev|orig|swp|swo|part|partial|takeover))*~?$/
  const secretShapedPart = part => typeof part === 'string' && (SECRET_PREFIXES.some(prefix => part.startsWith(prefix))
    || SECRET_NAMES.some(name => [name, '.' + name].some(stem => part.startsWith(stem) && SECRET_SUFFIX.test(part.slice(stem.length)))))
  const refusedBefore = part => (part !== 'pepper.v1' && SECRET_NAMES.includes(part)) || ['.env', '.aukora-'].some(prefix => part.startsWith(prefix))
  const secretShaped = path => { const parts = path.split('/'); return parts.some(secretShapedPart) && !parts.some(refusedBefore) }
  // What a restore leaves out is said, never implied: one plain sentence with the counts,
  // naming only the rule (no path, no content; the rule may also match an ordinary name). The in-app check
  // (portal/recovery-restore.ts `leftOutWords`) says the same words.
  const leftOutWords = (entries, markers) => {
    if (!entries && !markers) return null
    const counted = [entries ? entries + (entries === 1 ? ' entry' : ' entries') : '',
      markers ? markers + (markers === 1 ? ' deletion marker' : ' deletion markers') : ''].filter(Boolean).join(' and ')
    return counted + ' matching the secret-path rule in this recovery file ' + (entries + markers === 1 ? 'was' : 'were')
      + ' left out: the edge does not keep paths matching that rule'
  }
  const NOT_IN_SNAPSHOT = ['AUMLOK owner binding and passkey', 'Messages', 'turn journal', 'provider budget', 'HEAD history before this Pearl']
  const resetsOf = value => (Array.isArray(value) && value.length <= MAX_ENTRIES && value.every(path => typeof path === 'string' && path.startsWith('/dsh/'))
    && value.every((path, index) => index === 0 || value[index - 1] < path) ? value : null)
  const canonicalBase64 = text => {
    const bytes = base64Bytes(text)
    if (!bytes) return false
    let binary = ''
    for (let at = 0; at < bytes.length; at += 32768) binary += String.fromCharCode(...bytes.subarray(at, at + 32768))
    return btoa(binary) === text
  }

  /** The receipt high-water mark of a mirror inventory: what a restore must bring back exactly. */
  async function receiptHighWater(entries) {
    const file = path => entries.find(([entryPath, wire]) => entryPath === path && wire?.kind === 'file')?.[1] ?? null
    const lines = text => text.split('\n').map(line => line.trim()).filter(Boolean)
    const receipts = file(RECEIPTS_PATH), checkpoints = file(CHECKPOINTS_PATH)
    const receiptBytes = receipts ? base64Bytes(receipts.b64) : new Uint8Array(0)
    const checkpointBytes = checkpoints ? base64Bytes(checkpoints.b64) : new Uint8Array(0)
    const receiptText = receiptBytes ? utf8(receiptBytes) : null
    const checkpointText = checkpointBytes ? utf8(checkpointBytes) : null
    if (receiptText === null || checkpointText === null) return null
    const rows = lines(receiptText)
    let last = null
    try { last = rows.length ? JSON.parse(rows[rows.length - 1]) : null } catch { last = null }
    return {
      receiptCount: rows.length,
      lastReceiptSeq: Number.isSafeInteger(last?.seq) ? last.seq : null,
      lastReceiptHash: isSha(last?.leafHash ?? last?.hash) ? (last.leafHash ?? last.hash) : null,
      receiptsSha256: await sha256(receiptBytes),
      receiptsBytes: receiptBytes.length,
      checkpointCount: lines(checkpointText).length,
    }
  }

  /**
   * Verify a snapshot file completely, before anything is written. Never throws for a bad file.
   * @param {unknown} snapshot - the parsed file.
   * @returns {Promise<object>} `{ ok: true, ball, codeBySha, entries, resetPaths, epoch, ballId, highWater, parts }`
   *   or `{ ok: false, code, part? }` naming the first part that failed.
   */
  async function verifySnapshot(snapshot) {
    if (!isObject(snapshot) || snapshot.schema !== SCHEMA || !Array.isArray(snapshot.parts)) return refusal('RECOVERY_SCHEMA_INVALID')
    if (snapshot.parts.length !== ROUTES.length || snapshot.parts.some((part, index) => !isObject(part) || part.route !== ROUTES[index])) return refusal('RECOVERY_PARTS_INVALID')
    const checked = []
    for (const part of snapshot.parts) {
      if (part.ok !== true) {
        if (REQUIRED.includes(part.route)) return refusal('RECOVERY_PART_MISSING', { part: part.route, reason: typeof part.reason === 'string' ? part.reason.slice(0, 120) : null })
        if (part.sha256 !== null || part.bytes !== null) return refusal('RECOVERY_PART_HASH_MISMATCH', { part: part.route })
        checked.push({ route: part.route, ok: false, sha256: null, bytes: null })
        continue
      }
      const bytes = partBytes(part)
      if (!bytes || !isSha(part.sha256) || bytes.length !== part.bytes || await sha256(bytes) !== part.sha256) {
        return refusal('RECOVERY_PART_HASH_MISMATCH', { part: part.route })
      }
      checked.push({ route: part.route, ok: true, sha256: part.sha256, bytes: part.bytes })
    }
    if (!isSha(snapshot.manifestSha256)
      || await sha256(canonical(snapshot.parts.map(part => [part.route, part.sha256, part.bytes]))) !== snapshot.manifestSha256) {
      return refusal('RECOVERY_MANIFEST_MISMATCH')
    }
    const ballPart = snapshot.parts[0], mirrorPart = snapshot.parts[3]
    const ball = ballPart.encoding === 'json' && isObject(ballPart.body) ? ballPart.body.head : null
    const codeBySha = ballPart.encoding === 'json' && isObject(ballPart.body) ? ballPart.body.modules : null
    if (!isObject(ball) || !isSha(ball.ballId) || !Number.isSafeInteger(ball.epoch) || ball.epoch < 1 || !isObject(ball.modules)
      || !isObject(codeBySha) || Object.keys(codeBySha).length !== Object.keys(ball.modules).length) {
      return refusal('RECOVERY_PART_SHAPE_INVALID', { part: '/_head/ball' })
    }
    for (const sha of Object.keys(ball.modules)) {
      if (typeof codeBySha[sha] !== 'string' || await sha256(codeBySha[sha]) !== sha) return refusal('RECOVERY_PART_SHAPE_INVALID', { part: '/_head/ball', module: sha })
    }
    const mirror = mirrorPart.encoding === 'json' ? mirrorPart.body : null
    const resetPaths = isObject(mirror) ? resetsOf(mirror.resetPaths) : null
    if (!isObject(mirror) || mirror.snapshotFormat !== 'x61-mirror-snapshot/v2' || !Array.isArray(mirror.entries) || resetPaths === null
      || mirror.entries.length > MAX_ENTRIES) return refusal('RECOVERY_PART_SHAPE_INVALID', { part: '/_mirror/export' })
    const entries = []
    let previous = ''
    for (const item of mirror.entries) {
      if (!Array.isArray(item) || item.length !== 2 || typeof item[0] !== 'string' || item[0] <= previous || !isObject(item[1])) {
        return refusal('RECOVERY_PART_SHAPE_INVALID', { part: '/_mirror/export' })
      }
      const [path, wire] = item
      previous = path
      // The import's own rules (validateMirrorEntries): mode 0..0o777; a file's time finite, not negative, a real date.
      const mode = Number.isInteger(wire.mode) && wire.mode >= 0 && wire.mode <= 0o777
      if (wire.kind === 'dir' && mode) entries.push([path, { kind: 'dir', mode: wire.mode }])
      else if (wire.kind === 'file' && mode && Number.isFinite(wire.mtimeMs) && wire.mtimeMs >= 0 && Number.isFinite(new Date(wire.mtimeMs).getTime())
        && canonicalBase64(wire.b64)) {
        entries.push([path, { kind: 'file', mode: wire.mode, mtimeMs: wire.mtimeMs, b64: wire.b64 }])
      } else return refusal('RECOVERY_PART_SHAPE_INVALID', { part: '/_mirror/export', path })
    }
    const highWater = await receiptHighWater(entries)
    if (!highWater) return refusal('RECOVERY_PART_SHAPE_INVALID', { part: '/_mirror/export', path: RECEIPTS_PATH })
    const kept = entries.filter(([path]) => !secretShaped(path)), keptResets = resetPaths.filter(path => !secretShaped(path))
    return { ok: true, ball, codeBySha, entries: kept, resetPaths: keptResets, withheld: entries.length - kept.length + resetPaths.length - keptResets.length,
      leftOut: leftOutWords(entries.length - kept.length, resetPaths.length - keptResets.length),
      epoch: ball.epoch, ballId: ball.ballId, highWater, mirrorSha256: await mirrorDigest(kept, keptResets), parts: checked, createdAt: typeof snapshot.createdAt === 'string' ? snapshot.createdAt : null }
  }

  /**
   * The edge's seed request bodies for a verified snapshot: one `prepare` package and its mirror batches, cut so each
   * batch stays under the edge's entry and request-size bounds.
   */
  async function seedInputs(verified) {
    // PREFLIGHT, before any durable write: every rule the edge's seed import applies that this page can check from the
    // file alone. A refusal here names the path; nothing has been sent.
    const dirs = new Set(['/dsh/home', '/dsh/workspace'])
    let fileBytes = 0, metadataBytes = 0
    for (const [path, wire] of verified.entries) {
      const parent = path.slice(0, path.lastIndexOf('/'))
      if (!dirs.has(parent)) return refusal('RECOVERY_PREFLIGHT_PARENT_MISSING', { path })
      if (wire.kind === 'dir') dirs.add(path)
      else {
        if (wire.b64.length > Math.ceil(FILE_BYTES / 3) * 4) return refusal('RECOVERY_PREFLIGHT_FILE_TOO_LARGE', { path })
        fileBytes += Math.floor(wire.b64.length / 4) * 3
      }
      metadataBytes += encoder.encode(JSON.stringify([path, wire.kind === 'dir' ? wire : { kind: 'file', mode: wire.mode, mtimeMs: wire.mtimeMs }])).length
    }
    // Deletion markers count against the same metadata bound, on their own and together with the entries.
    const resetBytes = encoder.encode(JSON.stringify(verified.resetPaths)).length
    if (verified.entries.length + verified.resetPaths.length > MAX_ENTRIES || fileBytes > STATE_BYTES || metadataBytes + resetBytes > METADATA_BYTES) {
      return refusal('RECOVERY_PREFLIGHT_MIRROR_LIMIT')
    }
    if (Object.keys(verified.ball.modules).length > 256 || Object.keys(verified.ball.entries ?? {}).length > 256) return refusal('RECOVERY_PREFLIGHT_HEAD_LIMIT')
    const bytesOf = value => encoder.encode(JSON.stringify(value)).length
    // A batch envelope with the largest seed id and index it can carry, and no entries: its fixed overhead in bytes.
    const overhead = bytesOf({ action: 'batch', seedId: 'f'.repeat(64), index: MAX_BATCHES, entries: [] })
    const batches = []
    let current = [], bytes = overhead
    for (const entry of verified.entries) {
      const size = bytesOf(entry) + 1
      if (overhead + size > REQUEST_BYTES) return refusal('RECOVERY_PREFLIGHT_REQUEST_TOO_LARGE', { path: entry[0] })
      if (current.length && (current.length >= BATCH_ENTRIES || bytes + size > REQUEST_BYTES)) { batches.push(current); current = []; bytes = overhead }
      current.push(entry)
      bytes += size
    }
    if (current.length) batches.push(current)
    if (batches.length > MAX_BATCHES) return refusal('RECOVERY_TOO_MANY_BATCHES')
    const batchDigests = []
    for (const batch of batches) batchDigests.push(await sha256(canonical(batch)))
    const body = { version: 'x61-bootstrap/v1', ball: verified.ball, codeBySha: verified.codeBySha,
      mirror: { batchDigests, entryCount: verified.entries.length } }
    const seedPackage = { ...body, seedId: await sha256(canonical(body)) }
    if (encoder.encode(JSON.stringify(seedPackage)).length > PACKAGE_BYTES) return refusal('RECOVERY_PREFLIGHT_PACKAGE_TOO_LARGE')
    // Every entry's metadata (path, kind, mode, time) goes to the edge's import rules in chunks, each a whole request under
    // the bound; contents were judged here (canonical base64, size).
    const metas = verified.entries.map(([path, wire]) => [path, wire.kind === 'dir' ? { kind: 'dir', mode: wire.mode }
      : { kind: 'file', mode: wire.mode, mtimeMs: wire.mtimeMs, b64Length: wire.b64.length }])
    const entryOverhead = bytesOf({ action: 'preflight-entries', after: '', bytes: Number.MAX_SAFE_INTEGER, count: MAX_ENTRIES, entries: [] })
    const entryChunks = []
    let chunk = { after: '', entries: [] }, chunkBytes = entryOverhead
    for (const meta of metas) {
      const size = bytesOf(meta) + 1
      if (chunk.entries.length && (chunk.entries.length >= BATCH_ENTRIES || chunkBytes + size + bytesOf(chunk.after) > REQUEST_BYTES)) {
        entryChunks.push(chunk); chunk = { after: chunk.entries[chunk.entries.length - 1][0], entries: [] }; chunkBytes = entryOverhead
      }
      chunk.entries.push(meta); chunkBytes += size
    }
    if (chunk.entries.length) entryChunks.push(chunk)
    // Every request this restore will send, exactly as sent, measured before the first write.
    const requests = [['preflight', { action: 'preflight', package: seedPackage, resetPaths: verified.resetPaths }],
      ...entryChunks.map((value, index) => [`preflight entries ${String(index)}`, { action: 'preflight-entries', after: value.after, bytes: Number.MAX_SAFE_INTEGER, count: MAX_ENTRIES, entries: value.entries }]),
      ['prepare', { action: 'prepare', package: seedPackage, resetPaths: verified.resetPaths }],
      ...batches.map((entries, index) => [`batch ${String(index)}`, { action: 'batch', seedId: seedPackage.seedId, index, entries }])]
    for (const [step, envelope] of requests) if (bytesOf(envelope) > REQUEST_BYTES) return refusal('RECOVERY_PREFLIGHT_REQUEST_TOO_LARGE', { step })
    return { ok: true, package: seedPackage, resetPaths: verified.resetPaths, entryChunks, batches }
  }

  /** The edge's own no-write checks: the package and markers, then every path in byte-bounded chunks. */
  async function edgePreflight(fetchImpl, origin, seed) {
    const refused = checked => refusal('RECOVERY_PREFLIGHT_REFUSED', { edgeCode: typeof checked.body?.code === 'string' ? checked.body.code : null, path: checked.body?.path ?? null })
    const checked = await post(fetchImpl, origin, '/_bootstrap', { action: 'preflight', package: seed.package, resetPaths: seed.resetPaths })
    if (checked.status !== 200 || checked.body?.ok !== true || checked.body.seedId !== seed.package.seedId) return refused(checked)
    // The edge counts the export this restore will make with the mirror's own accounting, chunk by chunk, against the
    // limit the import enforces: an over-size inventory is refused here, before anything is written.
    let bytes = checked.body.bytes, count = 0
    if (!Number.isSafeInteger(bytes)) return refused(checked)
    for (const chunk of seed.entryChunks) {
      const entries = await post(fetchImpl, origin, '/_bootstrap', { action: 'preflight-entries', after: chunk.after, bytes, count, entries: chunk.entries })
      if (entries.status !== 200 || entries.body?.ok !== true || entries.body.checked !== chunk.entries.length || entries.body.count !== count + chunk.entries.length) return refused(entries)
      bytes = entries.body.bytes; count = entries.body.count
    }
    return { ok: true }
  }

  const readJson = async response => {
    try { return { status: response.status, body: await response.json() } } catch { return { status: response.status, body: null } }
  }
  const get = async (fetchImpl, origin, path) => readJson(await fetchImpl(new URL(path, origin).href, { method: 'GET', credentials: 'same-origin', cache: 'no-store' }))
  const post = async (fetchImpl, origin, path, value) => readJson(await fetchImpl(new URL(path, origin).href, {
    method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) }))

  /** Edge only: the status answer says Cloudflare, or an empty edge's health answer does. */
  async function edgeCheck(fetchImpl, origin) {
    const status = await get(fetchImpl, origin, '/__x6/status')
    if (status.status === 200 && status.body?.runtime === 'cloudflare') return { ok: true, empty: false, status: status.body }
    if (status.status === 503 && status.body?.code === 'BOOTSTRAP_REQUIRED') {
      const health = await get(fetchImpl, origin, '/api/health')
      if (health.status === 200 && health.body?.runtime === 'cloudflare' && health.body?.macDependency === false) return { ok: true, empty: true, status: null }
    }
    return refusal('RECOVERY_EDGE_REQUIRED')
  }

  /** What the edge holds now: its seed phases, its HEAD, and its receipt high-water (when it can be read). */
  async function liveState(fetchImpl, origin) {
    const seed = await get(fetchImpl, origin, '/_bootstrap')
    if (seed.status !== 200 || seed.body?.ok !== true) return refusal('RECOVERY_EDGE_STATE_UNREADABLE')
    const { head, mirror } = seed.body
    if (head?.phase === 'empty' && mirror?.phase === 'empty') return { ok: true, kind: 'empty', head: null, highWater: null, seed: seed.body }
    // An unfinished restore: HEAD prepared, the mirror not begun or still receiving the same seed. Anything else that is
    // not ready (established, mismatched) is occupied and is never written.
    if (head?.phase === 'prepared' && (mirror?.phase === 'empty' || (['receiving', 'ready'].includes(mirror?.phase) && mirror.seedId === head.seedId))) {
      return { ok: true, kind: 'partial', head: null, highWater: null, seed: seed.body }
    }
    if (!seed.body.ready) return { ok: true, kind: 'occupied', head: null, highWater: null, seed: seed.body }
    const ball = await get(fetchImpl, origin, '/_head/ball')
    const exported = await get(fetchImpl, origin, '/_mirror/export')
    const view = ball.body?.head
    const entries = Array.isArray(exported.body?.entries) ? exported.body.entries : null
    const resets = resetsOf(exported.body?.resetPaths)
    return { ok: true, kind: 'live', seed: seed.body,
      head: isObject(view) ? { epoch: view.epoch, ballId: view.ballId } : null,
      highWater: entries ? await receiptHighWater(entries) : null,
      mirrorSha256: entries && resets && entries.every(item => Array.isArray(item) && isObject(item[1])) ? await mirrorDigest(entries, resets) : null }
  }

  const sameHighWater = (a, b) => Boolean(a && b) && canonical(a) === canonical(b)
  const describe = verified => ({ epoch: verified.epoch, ballId: verified.ballId, highWater: verified.highWater, mirrorSha256: verified.mirrorSha256 })

  /**
   * Everything the owner must see before confirming. Writes nothing.
   * @returns {Promise<object>} `{ ok: true, action: 'restore' | 'already-current', snapshot, live, ... }` or a refusal
   *   that carries the comparison.
   */
  async function previewRestore({ fetchImpl, origin, snapshot }) {
    const verified = await verifySnapshot(snapshot)
    if (!verified.ok) return verified
    const edge = await edgeCheck(fetchImpl, origin)
    if (!edge.ok) return { ...edge, snapshot: describe(verified) }
    const live = await liveState(fetchImpl, origin)
    if (!live.ok) return { ...live, snapshot: describe(verified) }
    const seed = await seedInputs(verified)
    if (!seed.ok) return seed
    const comparison = { snapshot: describe(verified), live: { kind: live.kind, head: live.head, highWater: live.highWater, mirrorSha256: live.mirrorSha256 ?? null } }
    if (live.kind === 'live') {
      if (live.head?.ballId === verified.ballId && live.head?.epoch === verified.epoch && sameHighWater(live.highWater, verified.highWater)
        && live.mirrorSha256 === verified.mirrorSha256) {
        return { ok: true, action: 'already-current', ...comparison, leftOut: verified.leftOut, notRestored: verified.leftOut ? [verified.leftOut] : [] }
      }
      const newer = Number.isSafeInteger(live.head?.epoch) && live.head.epoch > verified.epoch
        || (live.highWater?.receiptCount ?? 0) > verified.highWater.receiptCount
      return refusal(newer ? 'RECOVERY_LIVE_NEWER' : 'RECOVERY_LIVE_DIFFERS', comparison)
    }
    if (live.kind === 'occupied') return refusal('RECOVERY_EDGE_NOT_EMPTY', comparison)
    if (live.kind === 'partial' && live.seed.head?.seedId !== seed.package.seedId) return refusal('RECOVERY_EDGE_PARTLY_SEEDED', comparison)
    const checked = await edgePreflight(fetchImpl, origin, seed)
    if (!checked.ok) return { ...checked, ...comparison }
    return { ok: true, action: 'restore', resuming: live.kind === 'partial', ...comparison, verified, seed,
      batchCount: seed.batches.length, entryCount: verified.entries.length, resetCount: verified.resetPaths.length,
      leftOut: verified.leftOut, notRestored: [...NOT_IN_SNAPSHOT, ...(verified.leftOut ? [verified.leftOut] : [])] }
  }

  /**
   * Write a previewed restore into the empty edge, then read it back. Refuses without `confirm: true`.
   * @returns {Promise<object>} `{ ok: true, before, after, ... }` or a refusal naming the step.
   */
  async function applyRestore({ fetchImpl, origin, preview, confirm, onStep = () => {} }) {
    if (confirm !== true) return refusal('RECOVERY_CONFIRMATION_REQUIRED')
    if (preview?.ok !== true || preview.action !== 'restore') return refusal('RECOVERY_NOTHING_TO_RESTORE')
    // The world may have changed since the preview: re-check, and refuse anything but the same empty or resumable edge.
    const edge = await edgeCheck(fetchImpl, origin)
    if (!edge.ok) return edge
    const live = await liveState(fetchImpl, origin)
    if (!live.ok) return live
    if (!['empty', 'partial'].includes(live.kind) || (live.kind === 'partial' && live.seed.head?.seedId !== preview.seed.package.seedId)) {
      return refusal('RECOVERY_EDGE_CHANGED', { live: { kind: live.kind, head: live.head, highWater: live.highWater } })
    }
    const { package: seedPackage, batches, resetPaths } = preview.seed
    onStep({ step: 'preflight' })
    const checked = await edgePreflight(fetchImpl, origin, preview.seed)
    if (!checked.ok) return checked
    onStep({ step: 'prepare' })
    const prepared = await post(fetchImpl, origin, '/_bootstrap', { action: 'prepare', package: seedPackage, resetPaths })
    if (prepared.status !== 200 || prepared.body?.ok !== true) return refusal('RECOVERY_WRITE_REFUSED', { step: 'prepare', edgeCode: prepared.body?.code ?? null })
    for (let index = 0; index < batches.length; index++) {
      onStep({ step: 'batch', index, of: batches.length })
      const batch = await post(fetchImpl, origin, '/_bootstrap', { action: 'batch', seedId: seedPackage.seedId, index, entries: batches[index] })
      if (batch.status !== 200 || batch.body?.ok !== true) return refusal('RECOVERY_WRITE_REFUSED', { step: 'batch', index, edgeCode: batch.body?.code ?? null })
    }
    onStep({ step: 'commit' })
    const committed = await post(fetchImpl, origin, '/_bootstrap', { action: 'commit', seedId: seedPackage.seedId })
    if (committed.status !== 200 || committed.body?.ok !== true) return refusal('RECOVERY_WRITE_REFUSED', { step: 'commit', edgeCode: committed.body?.code ?? null })
    onStep({ step: 'read-back' })
    const after = await liveState(fetchImpl, origin)
    const status = await get(fetchImpl, origin, '/__x6/status')
    const result = { before: preview.live, snapshot: preview.snapshot,
      after: { kind: after.kind, head: after.head ?? null, highWater: after.highWater ?? null, mirrorSha256: after.mirrorSha256 ?? null, statusEpoch: status.body?.head?.epoch ?? null, runtime: status.body?.runtime ?? null },
      leftOut: preview.leftOut ?? null, notRestored: preview.notRestored }
    const same = after.ok && after.kind === 'live' && after.head?.ballId === preview.snapshot.ballId && after.head?.epoch === preview.snapshot.epoch
      && status.body?.head?.epoch === preview.snapshot.epoch && sameHighWater(after.highWater, preview.snapshot.highWater)
      && after.mirrorSha256 === preview.snapshot.mirrorSha256
    return same ? { ok: true, ...result } : refusal('RECOVERY_READBACK_MISMATCH', result)
  }

  return Object.freeze({ SCHEMA, ROUTES, REQUIRED, SECRET_NAMES, SECRET_PREFIXES, SECRET_SUFFIX, secretShapedPart, verifySnapshot, receiptHighWater, seedInputs, edgePreflight, edgeCheck, liveState, previewRestore, applyRestore })
}

/**
 * The restore page's glue: runs in the browser with the kit. Self-contained (no outer names), because the generator
 * (`recovery-restore-page.generate.mjs`) serializes it, unbundled, into `recovery-restore-page.script.mjs`.
 */
export function recoveryRestorePage(kit) {
  const MAX_FILE_BYTES = 320 * 1024 * 1024
  const byId = id => document.getElementById(id)
  const fileInput = byId('restore-file'), checkButton = byId('restore-check'), confirmBox = byId('restore-confirm')
  const goButton = byId('restore-go'), statusLine = byId('restore-status'), detail = byId('restore-detail')
  // Every selection gets a new number; a check's result counts only if its number is still the current one.
  let preview = null, busy = false, selection = 0
  const say = text => { statusLine.textContent = text }
  const clear = () => { while (detail.firstChild) detail.removeChild(detail.firstChild) }
  const line = text => { const p = document.createElement('p'); p.textContent = text; detail.appendChild(p) }
  const water = h => (h ? h.receiptCount + ' receipts (last seq ' + (h.lastReceiptSeq ?? 'none') + '), ' + h.checkpointCount
    + ' checkpoints, receipts sha256 ' + h.receiptsSha256.slice(0, 16) + '…' : 'none')
  const head = h => (h ? 'epoch ' + h.epoch + ', Pearl ' + String(h.ballId).slice(0, 16) + '…' : 'none')
  const refresh = () => {
    goButton.disabled = busy || !preview || preview.action !== 'restore' || !confirmBox.checked
    fileInput.disabled = busy
  }
  const showComparison = result => {
    if (result.snapshot) line('Snapshot: ' + head(result.snapshot) + '; ' + water(result.snapshot.highWater))
    if (result.live) line('This edge now: ' + (result.live.kind === 'empty' ? 'empty (no HEAD, no mirror)' : result.live.kind === 'partial'
      ? 'partly seeded' : head(result.live.head) + '; ' + water(result.live.highWater)))
  }
  confirmBox.addEventListener('change', refresh)
  fileInput.addEventListener('change', () => { selection++; preview = null; confirmBox.checked = false; clear(); say(''); checkButton.disabled = !fileInput.files?.length; refresh() })
  checkButton.addEventListener('click', async () => {
    const file = fileInput.files?.[0]
    if (!file || busy) return
    const mine = selection
    // Anything this check finds is about `file` only; once another file is selected it is thrown away, never shown.
    const current = () => mine === selection && fileInput.files?.[0] === file
    busy = true; preview = null; clear(); refresh()
    try {
      if (file.size > MAX_FILE_BYTES) { say('Refused: the file is larger than any snapshot this edge can make.'); return }
      say('Checking every part of ' + file.name + ' against its SHA-256…')
      let snapshot
      try { snapshot = JSON.parse(await file.text()) } catch { if (current()) say('Refused: the file is not JSON.'); return }
      if (!current()) return
      const result = await kit.previewRestore({ fetchImpl: (url, init) => fetch(url, init), origin: location.origin, snapshot })
      if (!current()) return
      if (Array.isArray(result.verified?.parts)) for (const part of result.verified.parts) line((part.ok ? 'verified ' : 'not in file ') + part.route + (part.ok ? ' sha256 ' + part.sha256.slice(0, 16) + '…' : ''))
      showComparison(result)
      if (!result.ok) { say('Refused: ' + result.code + (result.part ? ' (part ' + result.part + ')' : '') + '. Nothing was written.'); return }
      if (result.leftOut) line(result.leftOut + '.')
      if (result.action === 'already-current') { say('She is already here: this edge holds the same HEAD and the same receipts. Nothing to write.'); return }
      preview = result
      line('Will write ' + result.entryCount + ' mirror entries in ' + result.batchCount + ' batches, and this Pearl as HEAD.')
      line('Not in a snapshot, so not restored: ' + result.notRestored.filter(item => item !== result.leftOut).join(', ') + '.')
      if (result.resetCount) line('With ' + result.resetCount + ' deletion markers, so files deleted before the snapshot stay deleted.')
      say((result.resuming ? 'This edge holds an unfinished restore of this same file; it will resume. ' : '') + 'Every part verified. Tick the box to confirm, then Restore.')
    } catch { if (current()) say('Refused: the check could not complete. Nothing was written.') } finally { busy = false; refresh() }
  })
  goButton.addEventListener('click', async () => {
    if (!preview || busy || !confirmBox.checked) return
    busy = true; refresh()
    try {
      const result = await kit.applyRestore({ fetchImpl: (url, init) => fetch(url, init), origin: location.origin, preview, confirm: confirmBox.checked,
        onStep: step => say(step.step === 'batch' ? 'Writing batch ' + (step.index + 1) + ' of ' + step.of + '…' : 'Restore: ' + step.step + '…') })
      clear()
      if (result.before) line('Before: ' + (result.before.kind === 'empty' ? 'empty' : head(result.before.head) + '; ' + water(result.before.highWater)))
      if (result.snapshot) line('Snapshot: ' + head(result.snapshot) + '; ' + water(result.snapshot.highWater))
      if (result.after) line('After: ' + head(result.after.head) + '; ' + water(result.after.highWater) + '; status runtime ' + result.after.runtime)
      if (result.leftOut) line(result.leftOut + '.')
      if (!result.ok) { say('Refused: ' + result.code + (result.step ? ' at ' + result.step : '') + (result.edgeCode ? ' (' + result.edgeCode + ')' : '') + '.'); return }
      say('Restored: same HEAD epoch and same receipt high-water as the snapshot. Reload to open her.')
      preview = null
    } catch { say('The restore stopped before it finished. Check the file again to see what this edge now holds.') } finally { busy = false; refresh() }
  })
}
