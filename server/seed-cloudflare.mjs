/** Offline, bounded Cloudflare seed packages. The CLI never reads credentials or uses the network. */
import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { bootstrapPackage, canonicalBootstrap, validateManifest, BOOTSTRAP_LIMITS } from '../deploy/cloudflare/src/head-do.mjs'
import { MIRROR_LIMITS, applyMirrorEntries, mirrorPathExcluded, validateMirrorEntries, validateMirrorPath } from '../deploy/cloudflare/src/mirror-do.mjs'

const BATCH_BYTES = BOOTSTRAP_LIMITS.requestBytes - 2 * 1024 * 1024
const MAX_BATCHES = 256
const MAX_SCAN_ENTRIES = 100000
const MAX_DEPTH = 128
const ORIGIN = 'https://node.example.invalid'
const ENDPOINT = ORIGIN + '/_bootstrap'
const RESPONSE_BYTES = 64 * 1024
const DEADLINE_MS = 15000
const transientSegments = new Set(['.git', 'node_modules', '.cache'])
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
const bytes = text => Buffer.byteLength(text)
const fail = code => { throw Object.assign(new Error(code), { code }) }
const absent = error => { if (error.code === 'ENOENT') return null; throw error }
const fingerprint = stat => ['dev', 'ino', 'mode', 'nlink', 'uid', 'gid', 'size', 'mtimeNs', 'ctimeNs'].map(key => String(stat[key])).join(':')
const identity = stat => ['dev', 'ino', 'mode', 'uid', 'gid'].map(key => String(stat[key])).join(':')
const ordered = (left, right) => left < right ? -1 : left > right ? 1 : 0
const batchName = index => `batch-${String(index).padStart(3, '0')}.json`
const batchRequestBytes = entries => bytes(JSON.stringify({ action: 'batch', seedId: 'f'.repeat(64), index: MAX_BATCHES - 1, entries }))
const parseJson = raw => {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)) }
  catch { fail('SEED_INVALID_JSON') }
}

// Ancestor identities are checked before and after each open. Directory timestamps
// within the source are also inventoried, so a changing tree is refused, not trimmed.
function sourceReader(root) {
  const ancestors = new Map()
  const tracked = new Map()
  async function stat(file) {
    const parts = path.resolve(file).split(path.sep).filter(Boolean)
    let current = path.parse(file).root
    for (let index = -1; index < parts.length; index++) {
      if (index >= 0) current = path.join(current, parts[index])
      const value = await fsp.lstat(current, { bigint: true }).catch(absent)
      if (!value) return null
      if (value.isSymbolicLink()) fail('SEED_SYMLINK_REFUSED')
      if (index < parts.length - 1) {
        if (!value.isDirectory()) fail('SEED_ANCESTOR_NOT_DIRECTORY')
        const previous = ancestors.get(current)
        if (previous !== undefined && previous !== identity(value)) fail('SEED_SOURCE_CHANGED')
        ancestors.set(current, identity(value))
      } else return value
    }
  }
  async function read(file, maximum, optional = false) {
    const before = await stat(file)
    tracked.set(file, before ? fingerprint(before) : null)
    if (!before) { if (optional) return null; fail('SEED_SOURCE_MISSING') }
    if (!before.isFile() || before.nlink !== 1n) fail('SEED_UNSAFE_SOURCE_FILE')
    if (before.size > BigInt(maximum)) fail('SEED_FILE_TOO_LARGE')
    const handle = await fsp.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
    try {
      if (fingerprint(await handle.stat({ bigint: true })) !== fingerprint(before)) fail('SEED_SOURCE_CHANGED')
      const buffer = Buffer.alloc(Number(before.size) + 1)
      let used = 0
      while (used < buffer.length) {
        const read = await handle.read(buffer, used, buffer.length - used, used)
        if (!read.bytesRead) break
        used += read.bytesRead
      }
      const after = await handle.stat({ bigint: true })
      const selected = await stat(file)
      if (!selected || used !== Number(before.size) || fingerprint(after) !== fingerprint(before) || fingerprint(selected) !== fingerprint(before)) fail('SEED_SOURCE_CHANGED')
      return buffer.subarray(0, used)
    } finally { await handle.close() }
  }
  async function recheck() {
    for (const [file, expected] of tracked) {
      const current = await stat(file)
      if ((current ? fingerprint(current) : null) !== expected) fail('SEED_SOURCE_CHANGED')
    }
    for (const [file, expected] of ancestors) {
      const current = await fsp.lstat(file, { bigint: true })
      if (current.isSymbolicLink() || !current.isDirectory() || identity(current) !== expected) fail('SEED_SOURCE_CHANGED')
    }
  }
  return { root, stat, read, recheck }
}

function admitted(vfsPath) {
  if (mirrorPathExcluded(vfsPath)) return false
  // Malformed or overlong durable names are an error, never a silent omission.
  validateMirrorPath(vfsPath)
  return !vfsPath.split('/').some(part => transientSegments.has(part)) && vfsPath !== '/dsh/home/cache' && !vfsPath.startsWith('/dsh/home/cache/')
}

async function inventory(reader) {
  const items = new Map()
  let scanned = 0
  let excluded = 0
  let fileBytes = 0
  async function walk(relative, depth) {
    if (depth > MAX_DEPTH) fail('SEED_DEPTH_LIMIT')
    const absolute = path.join(reader.root, relative)
    const stat = await reader.stat(absolute)
    if (!stat) fail('SEED_SOURCE_CHANGED')
    if (!stat.isFile() && !stat.isDirectory()) fail('SEED_SPECIAL_FILE_REFUSED')
    if (stat.isFile() && (stat.nlink !== 1n || stat.size > BigInt(MIRROR_LIMITS.fileBytes))) fail('SEED_UNSAFE_SOURCE_FILE')
    if (items.size >= MIRROR_LIMITS.entries + 2) fail('SEED_ENTRY_LIMIT')
    const root = relative === 'home' || relative === 'workspace'
    if (root && !stat.isDirectory()) fail('SEED_ROOT_NOT_DIRECTORY')
    items.set(relative, { stat, fingerprint: fingerprint(stat), root })
    if (stat.isFile()) {
      fileBytes += Number(stat.size)
      if (fileBytes > MIRROR_LIMITS.snapshotBytes) fail('SEED_SNAPSHOT_TOO_LARGE')
      return
    }
    const directory = await fsp.opendir(absolute)
    const names = []
    for await (const entry of directory) {
      if (++scanned > MAX_SCAN_ENTRIES) fail('SEED_SCAN_LIMIT')
      const child = relative + '/' + entry.name
      if (!admitted('/dsh/' + child)) { excluded++; continue }
      names.push(child)
    }
    for (const child of names.sort(ordered)) await walk(child, depth + 1)
    const after = await reader.stat(absolute)
    if (!after || fingerprint(after) !== fingerprint(stat)) fail('SEED_SOURCE_CHANGED')
  }
  for (const root of ['home', 'workspace']) {
    if (await reader.stat(path.join(reader.root, root))) await walk(root, 0)
    else items.set(root, { fingerprint: null, root: true })
  }
  return { items, excluded }
}

function summary(manifest, batches, excluded = 0) {
  let fileCount = 0
  let decodedBytes = 0
  let directoryCount = 0
  for (const batch of batches) for (const [, wire] of batch) {
    if (wire.kind === 'file') { fileCount++; decodedBytes += Buffer.byteLength(wire.b64, 'base64') }
    else directoryCount++
  }
  return { seedId: manifest.seedId, ballId: manifest.ball.ballId, epoch: manifest.ball.epoch, moduleCount: Object.keys(manifest.codeBySha).length, batchCount: batches.length, entryCount: manifest.mirror.entryCount, fileCount, directoryCount, decodedBytes, excludedRootsOrEntries: excluded }
}

/** Validate all package bytes before any write or request; no entries are discarded.
 * @param {{ package: object, batches: Array<Array> }} input Package and ordered batches.
 * @returns {Promise<object>} Detached normalized package, batches and a content-free summary.
 */
export async function verifySeedPackage(input) {
  const detached = structuredClone(input)
  if (!Array.isArray(detached.batches) || detached.batches.length > MAX_BATCHES) fail('SEED_BATCH_LIMIT')
  const manifest = await bootstrapPackage(detached.package)
  if (detached.batches.length !== manifest.mirror.batchDigests.length) fail('SEED_BATCH_COUNT_MISMATCH')
  if (bytes(JSON.stringify({ action: 'prepare', package: manifest })) > MIRROR_LIMITS.requestBytes) fail('SEED_PACKAGE_TOO_LARGE')
  const batches = []
  const seen = new Set()
  let state = new Map()
  let previousPath = ''
  // Use the longest revision representation, retaining headroom for the real fence.
  let snapshotBytes = bytes(JSON.stringify({ ok: true, protocol: 'x61-cloud-mirror/v1', lineageId: '00000000-0000-0000-0000-000000000000', revision: Number.MAX_SAFE_INTEGER, snapshotFormat: 'x61-mirror-snapshot/v2', resetPaths: [], entries: [] }))
  for (let index = 0; index < detached.batches.length; index++) {
    const entries = validateMirrorEntries(detached.batches[index])
    for (const [vfsPath, wire] of entries) {
      if (!admitted(vfsPath) || wire.kind === 'gone' || seen.has(vfsPath) || vfsPath <= previousPath) fail('SEED_INVALID_ENTRY')
      previousPath = vfsPath
      seen.add(vfsPath)
      snapshotBytes += bytes(JSON.stringify([vfsPath, wire])) + (seen.size > 1 ? 1 : 0)
      if (snapshotBytes > MIRROR_LIMITS.snapshotBytes || seen.size > MIRROR_LIMITS.entries) fail('SEED_SNAPSHOT_TOO_LARGE')
    }
    const packedBytes = bytes(JSON.stringify(entries))
    const requestBytes = bytes(JSON.stringify({ action: 'batch', seedId: manifest.seedId, index, entries }))
    if (requestBytes > MIRROR_LIMITS.requestBytes || (entries.length !== 1 && packedBytes > BATCH_BYTES)) fail('SEED_BATCH_TOO_LARGE')
    if (digest(canonicalBootstrap(entries)) !== manifest.mirror.batchDigests[index]) fail('SEED_BATCH_DIGEST_MISMATCH')
    const next = applyMirrorEntries(state, entries)
    if (next.size !== state.size + entries.length) fail('SEED_ENTRY_COUNT_MISMATCH')
    state = next
    batches.push(entries)
  }
  if (seen.size !== manifest.mirror.entryCount || state.size !== seen.size) fail('SEED_ENTRY_COUNT_MISMATCH')
  return { package: manifest, batches, summary: summary(manifest, batches) }
}

/** Capture an unchanged local mirror, excluding private and explicitly transient paths.
 * @param {{ mirrorDir: string }} options Local mirror root, never a remote URL.
 * @returns {Promise<object>} Verified offline package and batches; writes nothing.
 */
export async function prepareSeedPackage({ mirrorDir }) {
  if (typeof mirrorDir !== 'string' || !mirrorDir) fail('SEED_MIRROR_REQUIRED')
  const reader = sourceReader(path.resolve(mirrorDir))
  const root = await reader.stat(reader.root)
  if (!root?.isDirectory()) fail('SEED_ROOT_NOT_DIRECTORY')
  const ball = parseJson(await reader.read(path.join(reader.root, 'balls', 'HEAD.json'), MIRROR_LIMITS.requestBytes))
  if (await validateManifest(ball) || ball.epoch < 1) fail('SEED_MANIFEST_INVALID')
  const homeHead = await reader.read(path.join(reader.root, 'home', 'balls', 'HEAD.json'), MIRROR_LIMITS.requestBytes, true)
  if (homeHead && canonicalBootstrap(parseJson(homeHead)) !== canonicalBootstrap(ball)) fail('SEED_HEAD_COPIES_DIFFER')
  const codeBySha = {}
  let moduleBytes = 0
  for (const sha of Object.keys(ball.modules).sort(ordered)) {
    const primary = await reader.read(path.join(reader.root, 'balls', `${sha}.js`), MIRROR_LIMITS.fileBytes, true)
    const secondary = await reader.read(path.join(reader.root, 'home', 'balls', `${sha}.js`), MIRROR_LIMITS.fileBytes, true)
    const source = primary ?? secondary
    if (!source || digest(source) !== sha || (secondary && digest(secondary) !== sha)) fail('SEED_MODULE_HASH_MISMATCH')
    moduleBytes += source.length
    if (moduleBytes > MIRROR_LIMITS.requestBytes) fail('SEED_PACKAGE_TOO_LARGE')
    try { codeBySha[sha] = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(source) }
    catch { fail('SEED_MODULE_ENCODING_INVALID') }
  }
  const before = await inventory(reader)
  const batches = []
  let batch = []
  let batchBytes = 2
  let inventoryBytes = 2
  for (const [relative, item] of [...before.items].sort(([left], [right]) => ordered(left, right))) {
    if (item.root) continue
    const wire = { kind: item.stat.isDirectory() ? 'dir' : 'file', mode: Number(item.stat.mode & 0o777n) }
    if (wire.kind === 'file') {
      const payload = await reader.read(path.join(reader.root, relative), MIRROR_LIMITS.fileBytes)
      const selected = await reader.stat(path.join(reader.root, relative))
      if (!selected || fingerprint(selected) !== item.fingerprint) fail('SEED_SOURCE_CHANGED')
      wire.b64 = payload.toString('base64')
      wire.mtimeMs = Number(item.stat.mtimeNs) / 1e6
    }
    const entry = validateMirrorEntries([['/dsh/' + relative, wire]])[0]
    const length = bytes(JSON.stringify(entry))
    inventoryBytes += length + 1
    if (inventoryBytes > MIRROR_LIMITS.snapshotBytes) fail('SEED_SNAPSHOT_TOO_LARGE')
    // One file may use the full bootstrap request. BATCH_BYTES only packs smaller files together.
    if (batchRequestBytes([entry]) > MIRROR_LIMITS.requestBytes) fail('SEED_BATCH_TOO_LARGE')
    if (length + 2 > BATCH_BYTES) {
      if (batch.length) { batches.push(batch); batch = []; batchBytes = 2 }
      batches.push([entry])
      if (batches.length >= MAX_BATCHES) fail('SEED_BATCH_LIMIT')
      continue
    }
    if (batch.length && (batchBytes + length + 1 > BATCH_BYTES || batch.length >= MIRROR_LIMITS.batchEntries)) {
      batches.push(batch); batch = []; batchBytes = 2
    }
    batchBytes += length + (batch.length ? 1 : 0)
    batch.push(entry)
    if (batches.length >= MAX_BATCHES) fail('SEED_BATCH_LIMIT')
  }
  if (batch.length) batches.push(batch)
  const manifest = await bootstrapPackage({ version: 'x61-bootstrap/v1', ball, codeBySha, mirror: { batchDigests: batches.map(entries => digest(canonicalBootstrap(entries))), entryCount: batches.reduce((count, entries) => count + entries.length, 0) } })
  const verified = await verifySeedPackage({ package: manifest, batches })
  const after = await inventory(reader)
  if (before.items.size !== after.items.size || before.excluded !== after.excluded) fail('SEED_SOURCE_CHANGED')
  for (const [relative, item] of before.items) if (after.items.get(relative)?.fingerprint !== item.fingerprint) fail('SEED_SOURCE_CHANGED')
  await reader.recheck()
  verified.summary.excludedRootsOrEntries = before.excluded
  return verified
}

/** Write only a new private directory; package.json is the last completion marker.
 * @param {{ outDir: string, package: object, batches: Array<Array> }} input Verified package destination.
 * @returns {Promise<object>} Summary. Failure leaves a private, incomplete directory for inspection.
 */
export async function writeSeedPackage({ outDir, ...input }) {
  const verified = await verifySeedPackage(input)
  if (typeof outDir !== 'string' || !outDir) fail('SEED_OUTPUT_REQUIRED')
  const output = path.resolve(outDir)
  const reader = sourceReader(output)
  const parent = await reader.stat(path.dirname(output))
  if (!parent?.isDirectory()) fail('SEED_OUTPUT_PARENT_MISSING')
  await fsp.mkdir(output, { mode: 0o700 })
  const created = await reader.stat(output)
  if (!created?.isDirectory() || (created.mode & 0o077n) !== 0n) fail('SEED_OUTPUT_NOT_PRIVATE')
  async function write(name, value) {
    const current = await reader.stat(output)
    if (!current || identity(current) !== identity(created)) fail('SEED_OUTPUT_CHANGED')
    const file = path.join(output, name)
    const handle = await fsp.open(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600)
    try { await handle.writeFile(JSON.stringify(value) + '\n'); await handle.sync() }
    finally { await handle.close() }
    const saved = await reader.stat(file)
    if (!saved?.isFile() || saved.nlink !== 1n || (saved.mode & 0o077n) !== 0n) fail('SEED_OUTPUT_NOT_PRIVATE')
  }
  for (let index = 0; index < verified.batches.length; index++) await write(batchName(index), verified.batches[index])
  // Do not recursively canonicalize the saved manifest: its legacy hash preserves
  // the original property order inside module and entry metadata.
  await write('package.json', verified.package)
  const handle = await fsp.open(output, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  try {
    if (identity(await handle.stat({ bigint: true })) !== identity(created)) fail('SEED_OUTPUT_CHANGED')
    await handle.sync()
  } finally { await handle.close() }
  return verified.summary
}

/** Load a private package without following links; validate every batch before use.
 * @param {{ packageDir: string }} options Directory produced by writeSeedPackage.
 * @returns {Promise<object>} Verified package, ordered batches and summary.
 */
export async function readSeedPackage({ packageDir }) {
  if (typeof packageDir !== 'string' || !packageDir) fail('SEED_PACKAGE_REQUIRED')
  const reader = sourceReader(path.resolve(packageDir))
  const initial = await reader.stat(reader.root)
  if (!initial?.isDirectory() || (initial.mode & 0o077n) !== 0n) fail('SEED_OUTPUT_NOT_PRIVATE')
  const manifest = await bootstrapPackage(parseJson(await reader.read(path.join(reader.root, 'package.json'), MIRROR_LIMITS.requestBytes)))
  const expected = new Set(['package.json', ...manifest.mirror.batchDigests.map((_, index) => batchName(index))])
  const directory = await fsp.opendir(reader.root)
  let count = 0
  for await (const entry of directory) {
    if (!expected.has(entry.name) || ++count > MAX_BATCHES + 1) fail('SEED_PACKAGE_FILES_MISMATCH')
    const stat = await reader.stat(path.join(reader.root, entry.name))
    if (!stat?.isFile() || (stat.mode & 0o077n) !== 0n) fail('SEED_OUTPUT_NOT_PRIVATE')
  }
  if (count !== expected.size) fail('SEED_PACKAGE_FILES_MISMATCH')
  const batches = []
  let total = 0
  for (let index = 0; index < manifest.mirror.batchDigests.length; index++) {
    const raw = await reader.read(path.join(reader.root, batchName(index)), BATCH_BYTES + 1)
    total += raw.length
    if (total > MIRROR_LIMITS.snapshotBytes + MAX_BATCHES * 3) fail('SEED_SNAPSHOT_TOO_LARGE')
    batches.push(parseJson(raw))
  }
  const verified = await verifySeedPackage({ package: manifest, batches })
  await reader.recheck()
  if (fingerprint(await reader.stat(reader.root)) !== fingerprint(initial)) fail('SEED_SOURCE_CHANGED')
  return verified
}

async function request(fetchImpl, payload) {
  const body = JSON.stringify(payload)
  if (bytes(body) > MIRROR_LIMITS.requestBytes) fail('SEED_REQUEST_TOO_LARGE')
  const controller = new AbortController()
  let reader
  let timeout
  const deadline = new Promise((_, reject) => {
    timeout = setTimeout(() => {
      controller.abort()
      if (reader) void reader.cancel().catch(() => {})
      reject(Object.assign(new Error('SEED_UPLOAD_OUTCOME_UNKNOWN'), { code: 'SEED_UPLOAD_OUTCOME_UNKNOWN' }))
    }, DEADLINE_MS)
  })
  try {
    return await Promise.race([deadline, (async () => {
      const response = await fetchImpl(ENDPOINT, { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN }, body, redirect: 'error', signal: controller.signal })
      if (controller.signal.aborted) { void response.body?.cancel().catch(() => {}); fail('SEED_UPLOAD_OUTCOME_UNKNOWN') }
      if (response.redirected || (response.url && response.url !== ENDPOINT)) fail('SEED_UPLOAD_OUTCOME_UNKNOWN')
      const length = response.headers.get('content-length')
      if (length !== null && (!/^\d+$/.test(length) || Number(length) > RESPONSE_BYTES)) fail('SEED_UPLOAD_OUTCOME_UNKNOWN')
      reader = response.body?.getReader()
      if (!reader) fail('SEED_UPLOAD_OUTCOME_UNKNOWN')
      const chunks = []
      let total = 0
      for (;;) {
        const { done, value } = await reader.read()
        if (controller.signal.aborted) fail('SEED_UPLOAD_OUTCOME_UNKNOWN')
        if (done) break
        total += value.byteLength
        if (total > RESPONSE_BYTES) fail('SEED_UPLOAD_OUTCOME_UNKNOWN')
        chunks.push(value)
      }
      const encoding = response.headers.get('content-encoding')
      if (length !== null && (!encoding || encoding === 'identity') && Number(length) !== total) fail('SEED_UPLOAD_OUTCOME_UNKNOWN')
      const result = parseJson(Buffer.concat(chunks, total))
      if (!response.ok || result?.ok !== true) fail('SEED_UPLOAD_NOT_ACKNOWLEDGED')
      return result
    })()])
  } catch (error) {
    // No retry follows any response failure: the server may have committed it.
    if (error.code === 'SEED_UPLOAD_NOT_ACKNOWLEDGED') throw error
    fail('SEED_UPLOAD_OUTCOME_UNKNOWN')
  } finally {
    clearTimeout(timeout)
    controller.abort()
    if (reader) void reader.cancel().catch(() => {})
  }
}

function verifyReceipt(receipt, verified, complete) {
  const manifest = verified.package
  const head = receipt.head
  const mirror = receipt.mirror
  const phase = complete ? 'complete' : receipt.phase
  if (receipt.seedId !== manifest.seedId || !['prepared', 'complete'].includes(phase) || receipt.phase !== phase || !head || !mirror) fail('SEED_UPLOAD_ACK_MISMATCH')
  for (const item of [head, mirror]) if (item.seedId !== manifest.seedId || item.ballId !== manifest.ball.ballId || item.epoch !== manifest.ball.epoch) fail('SEED_UPLOAD_ACK_MISMATCH')
  if (head.phase !== phase || mirror.batchCount !== verified.batches.length || !Number.isSafeInteger(mirror.nextBatch) || mirror.nextBatch < 0 || mirror.nextBatch > mirror.batchCount || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(mirror.lineageId) || !Number.isSafeInteger(mirror.revision) || mirror.revision < 0) fail('SEED_UPLOAD_ACK_MISMATCH')
  const count = verified.batches.slice(0, mirror.nextBatch).reduce((sum, batch) => sum + batch.length, 0)
  if (mirror.entryCount !== count || !['receiving', 'ready'].includes(mirror.phase) || mirror.revision !== (mirror.phase === 'ready' ? 1 : 0) || (mirror.phase === 'ready' && mirror.nextBatch !== mirror.batchCount) || (phase === 'complete' && (mirror.phase !== 'ready' || mirror.nextBatch !== mirror.batchCount || count !== manifest.mirror.entryCount))) fail('SEED_UPLOAD_ACK_MISMATCH')
}

/** Explicit future-operator upload; the caller supplies an already authorized fetch.
 * Reads no credentials, accepts no alternate destination, and never retries failures.
 * @param {{ packageDir: string, confirmSeedId: string, fetchImpl: Function }} input Persisted approved seed and authenticated transport; retries reuse this same directory.
 * @returns {Promise<object>} Content-free summary only after an exact complete receipt.
 */
export async function uploadSeedPackage({ packageDir, confirmSeedId, fetchImpl }) {
  const verified = await readSeedPackage({ packageDir })
  if (confirmSeedId !== verified.package.seedId || typeof fetchImpl !== 'function') fail('SEED_UPLOAD_CONFIRMATION_REQUIRED')
  const prepared = await request(fetchImpl, { action: 'prepare', package: verified.package })
  verifyReceipt(prepared, verified, false)
  if (prepared.phase === 'complete') return { ...verified.summary, complete: true }
  for (let index = prepared.mirror.nextBatch; index < verified.batches.length; index++) {
    const result = await request(fetchImpl, { action: 'batch', seedId: confirmSeedId, index, entries: verified.batches[index] })
    if (result.seedId !== confirmSeedId || result.index !== index || result.digest !== verified.package.mirror.batchDigests[index] || result.nextBatch !== index + 1 || (result.phase !== 'receiving' && !(result.phase === 'ready' && index + 1 === verified.batches.length))) fail('SEED_UPLOAD_ACK_MISMATCH')
  }
  verifyReceipt(await request(fetchImpl, { action: 'commit', seedId: confirmSeedId }), verified, true)
  return { ...verified.summary, complete: true }
}

async function main(argv) {
  const usage = 'Offline only: node server/seed-cloudflare.mjs --mirror <directory> [--out <new-directory>] | --package <directory>'
  if (argv.length === 1 && argv[0] === '--help') { console.log(usage); return }
  const options = {}
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    if (!['--mirror', '--out', '--package'].includes(key) || Object.hasOwn(options, key) || !argv[index + 1] || argv[index + 1].startsWith('--')) fail('SEED_INVALID_ARGUMENTS')
    options[key] = argv[index + 1]
  }
  if (Boolean(options['--mirror']) === Boolean(options['--package']) || (options['--package'] && options['--out'])) fail('SEED_INVALID_ARGUMENTS')
  if (options['--out']) {
    const mirror = path.resolve(options['--mirror'])
    const output = path.resolve(options['--out'])
    if (output === mirror || output.startsWith(mirror + path.sep)) fail('SEED_OUTPUT_INSIDE_SOURCE')
  }
  const prepared = options['--mirror'] ? await prepareSeedPackage({ mirrorDir: options['--mirror'] }) : await readSeedPackage({ packageDir: options['--package'] })
  if (options['--out']) await writeSeedPackage({ outDir: options['--out'], ...prepared })
  console.log(JSON.stringify({ ok: true, offline: true, written: Boolean(options['--out']), ...prepared.summary }))
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => {
    const code = typeof error.code === 'string' && /^(?:SEED|MIRROR|BOOTSTRAP)_[A-Z_]+$/.test(error.code) ? error.code : 'SEED_OPERATION_FAILED'
    console.error(JSON.stringify({ ok: false, code, offline: true }))
    process.exitCode = 1
  })
}
