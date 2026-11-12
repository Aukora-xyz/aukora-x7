/** Retain named immutable build assets for open tabs; this is not runtime selection. */
import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { createRuntimeHead } from './runtime-head.mjs'

const MAX_FILE_BYTES = 32 * 1024 * 1024
const MAX_FILES = 10000
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
const fail = (code, status = 503) => { throw Object.assign(new Error(code), { code, status }) }
const absent = error => { if (error.code === 'ENOENT') return null; throw error }
export const immutablePath = file => typeof file === 'string' && file.length <= 1024 && !/[\\\0]/.test(file) && path.posix.normalize(file) === file && (
  /^(?:assets|preview)\/(?:[^/]+\/)*[^/]+-[A-Za-z0-9_-]{8,16}\.(?:js|css|woff2?|ttf|png|svg|jpe?g|webp|avif|ico)$/.test(file)
  || /^preview\/lazy\/[a-f0-9]{64}\.tar\.gz$/.test(file)
  || file === 'preview/scion/esbuild-0.28.2-b1831a5c.wasm'
)

/** Public deployment files; private mirror state is never a release input. */
export const runtimePath = file => {
  if (typeof file !== 'string' || file.length > 1024 || !/^[A-Za-z0-9_./-]+$/.test(file) || file.startsWith('/') || path.posix.normalize(file) !== file || file === 'preview/asset-seal.json' || file.endsWith('.map')) return false
  const parts = file.toLowerCase().split('/')
  if (parts.some(part => !part || part.startsWith('.') || ['mirror', 'private', 'sessions', 'storages', 'snapshots'].includes(part) || /(?:credentials?|secrets?|keypair|memory-store|receipts|ledger)/.test(part))) return false
  const root = ['index.html', 'preview.html', 'manifest.webmanifest'].includes(file) || /^[A-Za-z0-9_-]+\.(?:png|svg|ico)$/.test(file)
  return (root || file.startsWith('assets/') || file.startsWith('preview/')) && /\.(?:html|js|css|json|webmanifest|png|svg|jpe?g|webp|avif|ico|woff2?|ttf|wasm|txt|gz)$/.test(file)
}

/** Captures retain the selected release, explicit pins and five newest releases.
 * Retained closures are immutable. Failures may leave unreferenced objects, never delete a protected closure.
 */
export function createAssetCache({ repository, dist, maxBytes = 256 * 1024 * 1024, captureWaitMs = 30000 }) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < MAX_FILE_BYTES) fail('INVALID_ASSET_CACHE_BUDGET')
  if (!Number.isSafeInteger(captureWaitMs) || captureWaitMs < 0 || captureWaitMs > 120000) fail('INVALID_ASSET_CACHE_WAIT')
  const directory = path.join(repository, '.cache', 'x61-runtime-assets')
  const objects = path.join(directory, 'objects')
  const indexFile = path.join(directory, 'index.json')
  const releases = path.join(directory, 'releases')
  const pinsFile = path.join(directory, 'pins.json')
  const runtimeDirectory = path.join(directory, 'runtime-head')
  let entries = null
  let capturedAt = null
  let storageBytes = null
  let error = null
  let releaseCount = 0
  let latestRelease = null
  let queue = Promise.resolve()
  const own = stat => typeof process.getuid === 'function' && stat.uid === process.getuid()
  async function syncDirectory(file) {
    const handle = await fsp.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
    try { if (!(await handle.stat()).isDirectory()) fail('ASSET_CACHE_NOT_DIRECTORY'); await handle.sync() }
    finally { await handle.close() }
  }
  async function ensureDirectory(file, privateDirectory = true) {
    const stat = await fsp.lstat(file).catch(absent)
    if (!stat) {
      try { await fsp.mkdir(file, { mode: privateDirectory ? 0o700 : 0o755 }) } catch (failure) { if (failure.code !== 'EEXIST') throw failure }
      await syncDirectory(path.dirname(file))
    }
    const current = await fsp.lstat(file)
    if (!current.isDirectory() || current.isSymbolicLink() || !own(current) || (current.mode & (privateDirectory ? 0o077 : 0o022))) fail('UNSAFE_ASSET_CACHE_DIRECTORY')
  }
  async function ensureStorage() {
    const root = await fsp.lstat(repository)
    if (!root.isDirectory() || root.isSymbolicLink() || !own(root) || (root.mode & 0o022)) fail('UNSAFE_ASSET_CACHE_ROOT')
    await ensureDirectory(path.join(repository, '.cache'), false)
    await ensureDirectory(directory)
    await ensureDirectory(objects)
    await ensureDirectory(releases)
  }
  async function readPrivate(file, maximum) {
    const handle = await fsp.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
    try {
      const before = await handle.stat()
      if (!before.isFile() || !own(before) || (before.mode & 0o077) || before.size > maximum) fail('UNSAFE_ASSET_CACHE_FILE')
      const bytes = await handle.readFile()
      const after = await handle.stat()
      if (bytes.length > maximum || before.size !== after.size || before.mtimeMs !== after.mtimeMs || bytes.length !== after.size) fail('ASSET_CACHE_FILE_MOVED')
      return bytes
    } finally { await handle.close() }
  }
  /** Describes a capture lock's holder for diagnosis; it never breaks or removes the lock. */
  async function lockHolder(file) {
    try {
      const owner = JSON.parse((await readPrivate(file, 4096)).toString('utf8'))
      if (!Number.isSafeInteger(owner?.pid) || owner.pid < 1) return { readable: false }
      let alive = true
      try { process.kill(owner.pid, 0) } catch (failure) { alive = failure.code === 'EPERM' }
      return { pid: owner.pid, startedAt: Number.isSafeInteger(owner.startedAt) ? owner.startedAt : null, alive, sameProcess: owner.pid === process.pid }
    } catch { return { readable: false } }
  }
  async function load(force = false) {
    await ensureStorage()
    if (!force && entries !== null) return
    const stat = await fsp.lstat(indexFile).catch(absent)
    if (!stat) {
      if (capturedAt !== null || entries?.size) fail('ASSET_CACHE_INDEX_MISSING')
      entries = new Map(); return
    }
    const index = JSON.parse((await readPrivate(indexFile, 8 * 1024 * 1024)).toString('utf8'))
    if (index?.version !== 1 || !Array.isArray(index.files) || index.files.length > MAX_FILES || !Number.isSafeInteger(index.capturedAt) || index.capturedAt < 0) fail('INVALID_ASSET_CACHE_INDEX')
    const next = new Map()
    for (const entry of index.files) {
      if (!entry || !immutablePath(entry.path) || !/^[a-f0-9]{64}$/.test(entry.sha256) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || entry.bytes > MAX_FILE_BYTES || next.has(entry.path)) fail('INVALID_ASSET_CACHE_INDEX')
      if (immutablePath(entry.path)) next.set(entry.path, { sha256: entry.sha256, bytes: entry.bytes })
    }
    entries = next; capturedAt = index.capturedAt
  }
  async function verifyObject(sha, size) {
    const bytes = await readPrivate(path.join(objects, sha), MAX_FILE_BYTES)
    if (bytes.length !== size || digest(bytes) !== sha) fail('ASSET_CACHE_DIGEST_MISMATCH')
    return bytes
  }
  async function writeObject(sha, bytes) {
    const target = path.join(objects, sha)
    const temporary = path.join(objects, '.' + crypto.randomUUID() + '.tmp')
    const handle = await fsp.open(temporary, 'wx', 0o600)
    try {
      try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
      try { await fsp.link(temporary, target) } catch (failure) { if (failure.code !== 'EEXIST') throw failure }
      await verifyObject(sha, bytes.length)
      await syncDirectory(objects)
    } finally { await fsp.rm(temporary, { force: true }) }
  }
  function validateRuntimeFiles(files) {
    if (!Array.isArray(files) || !files.length || files.length > MAX_FILES) fail('INVALID_RUNTIME_CLOSURE')
    const seen = new Set()
    for (const entry of files) {
      if (!entry || !runtimePath(entry.path) || seen.has(entry.path) || !/^[a-f0-9]{64}$/.test(entry.sha256) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || entry.bytes > MAX_FILE_BYTES) fail('INVALID_RUNTIME_CLOSURE')
      seen.add(entry.path)
    }
    for (const required of ['preview.html', 'preview/vfs-image.tar.gz', 'manifest.webmanifest', 'preview/fixtures.json', 'preview/scion/esbuild-0.28.2-b1831a5c.wasm']) if (!seen.has(required)) fail('INCOMPLETE_RUNTIME_CLOSURE')
    if (files.filter(entry => /^preview\/worker-[A-Za-z0-9_-]+\.js$/.test(entry.path)).length !== 1 || files.filter(entry => /^preview\/bootstrap-[A-Za-z0-9_-]+\.js$/.test(entry.path)).length !== 1) fail('AMBIGUOUS_RUNTIME_CLOSURE')
  }
  async function readRelease(id) {
    if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) fail('INVALID_RUNTIME_RELEASE', 400)
    const bytes = await readPrivate(path.join(releases, id + '.json'), 8 * 1024 * 1024).catch(failure => { if (failure.code === 'ENOENT') fail('RUNTIME_RELEASE_UNAVAILABLE', 404); throw failure })
    if (digest(bytes) !== id) fail('RUNTIME_RELEASE_DIGEST_MISMATCH')
    const manifest = JSON.parse(bytes.toString('utf8'))
    if (manifest?.version !== 1 || manifest.kind !== 'local-runtime-closure' || manifest.storageProtocol !== 2 || manifest.imageBase !== 'module-relative-v1' || Object.keys(manifest).sort().join(',') !== 'files,imageBase,kind,storageProtocol,version') fail('INVALID_RUNTIME_RELEASE')
    validateRuntimeFiles(manifest.files)
    return manifest
  }
  async function releaseList(verify = false) {
    const names = await fsp.readdir(releases)
    if (names.length > MAX_FILES) fail('RUNTIME_RELEASE_BUDGET')
    const rows = []
    for (const name of names.sort()) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue
      const id = name.slice(0, -5)
      const manifest = await readRelease(id)
      if (verify) for (const entry of manifest.files) await verifyObject(entry.sha256, entry.bytes)
      rows.push({ releaseId: id, files: manifest.files.length, bytes: manifest.files.reduce((sum, entry) => sum + entry.bytes, 0), storageProtocol: manifest.storageProtocol, recordedBoot: false })
    }
    releaseCount = rows.length
    return rows
  }
  function projectRuntime(manifest, id, file, originalBytes, mainEntry = false) {
    let bytes = originalBytes
    if (file === 'preview.html') {
      let html = bytes.toString('utf8')
      if (/<base\b|<style\b|\bsrcset\s*=|\bstyle\s*=/i.test(html) || [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].some(match => match[1].trim())) fail('UNSUPPORTED_RUNTIME_HTML')
      const attributes = [...html.matchAll(/\b(?:src|href)\s*=/gi)].length
      let rewritten = 0
      html = html.replace(/\b(src|href)\s*=\s*(["'])\.\/([A-Za-z0-9_./-]+)\2/gi, (_match, attribute, quote, asset) => {
        if (!manifest.files.some(entry => entry.path === asset)) fail('INCOMPLETE_RUNTIME_HTML')
        rewritten += 1
        return attribute + '=' + quote + '/_runtime/' + id + '/' + asset + (mainEntry && asset === 'manifest.webmanifest' ? '?runtime_main=1' : '') + quote
      })
      if (!attributes || rewritten !== attributes) fail('UNSUPPORTED_RUNTIME_HTML_REFERENCE')
      bytes = Buffer.from(html)
    } else if (file === 'manifest.webmanifest') {
      const original = JSON.parse(bytes.toString('utf8'))
      const fields = new Set(['name', 'short_name', 'start_url', 'scope', 'display', 'background_color', 'theme_color', 'icons'])
      if (!Array.isArray(original.icons) || Object.keys(original).some(key => !fields.has(key))) fail('INVALID_RUNTIME_WEBMANIFEST')
      const icons = original.icons.map(icon => {
        if (typeof icon.src !== 'string') fail('INVALID_RUNTIME_WEBMANIFEST')
        const file = icon.src.replace(/^\.\//, '')
        if (!manifest.files.some(entry => entry.path === file)) fail('INCOMPLETE_RUNTIME_WEBMANIFEST')
        return { ...icon, src: '/_runtime/' + id + '/' + file }
      })
      bytes = Buffer.from(JSON.stringify({ ...original, start_url: mainEntry ? '/' : '/?runtime_candidate=' + id, scope: '/', icons }))
    }
    return bytes
  }
  async function capture() {
    await load()
    const next = new Map(entries)
    const objectSizes = new Map()
    const retainedReleases = []
    const temporaryFiles = []
    const canonicalInodes = new Set()
    let totalBytes = 0
    let physicalObjects = 0
    const releaseNames = await fsp.readdir(releases)
    if (releaseNames.length > MAX_FILES) fail('RUNTIME_RELEASE_BUDGET')
    for (const name of releaseNames) {
      const stat = await fsp.lstat(path.join(releases, name))
      if (!stat.isFile() || stat.isSymbolicLink() || !own(stat) || (stat.mode & 0o077) || stat.size > 8 * 1024 * 1024) fail('UNSAFE_RUNTIME_RELEASE_FILE')
      if (!/^[a-f0-9]{64}\.json$/.test(name) && !/^\.[a-f0-9-]{36}\.tmp$/.test(name)) fail('UNKNOWN_RUNTIME_RELEASE_FILE')
      totalBytes += stat.size
      if (/^[a-f0-9]{64}\.json$/.test(name)) {
        retainedReleases.push({ id: name.slice(0, -5), bytes: stat.size, at: stat.mtimeMs, manifest: await readRelease(name.slice(0, -5)) })
        canonicalInodes.add(stat.dev + ':' + stat.ino)
      } else temporaryFiles.push({ file: path.join(releases, name), stat, object: false })
    }
    const objectNames = await fsp.readdir(objects)
    physicalObjects = objectNames.length
    if (objectNames.length > MAX_FILES) fail('ASSET_CACHE_OBJECT_BUDGET')
    for (const name of objectNames) {
      const stat = await fsp.lstat(path.join(objects, name))
      if (!stat.isFile() || stat.isSymbolicLink() || !own(stat) || (stat.mode & 0o077) || stat.size > MAX_FILE_BYTES) fail('UNSAFE_ASSET_CACHE_FILE')
      totalBytes += stat.size
      if (/^[a-f0-9]{64}$/.test(name)) { objectSizes.set(name, stat.size); canonicalInodes.add(stat.dev + ':' + stat.ino) }
      else if (!/^\.[a-f0-9-]{36}\.tmp$/.test(name)) fail('UNKNOWN_ASSET_CACHE_OBJECT')
      else temporaryFiles.push({ file: path.join(objects, name), stat, object: true })
    }
    // Only this writer creates these reserved names, under CAPTURE.lock. A reconciled prior crash may
    // leave an unlinked temporary or one extra link to a published immutable object/manifest.
    for (const { stat } of temporaryFiles) if (stat.nlink !== 1 && !(stat.nlink === 2 && canonicalInodes.has(stat.dev + ':' + stat.ino))) fail('UNSAFE_ASSET_CACHE_TEMPORARY')
    storageBytes = totalBytes
    // A healthy recapture also verifies historical mappings absent from dist.
    for (const entry of entries.values()) await verifyObject(entry.sha256, entry.bytes)
    await releaseList(true)
    const sealFile = path.join(dist, 'preview', 'asset-seal.json')
    if (await fsp.realpath(dist) !== dist || await fsp.realpath(path.dirname(sealFile)) !== path.dirname(sealFile)) fail('BUILD_ASSET_PARENT_CHANGED')
    const sealHandle = await fsp.open(sealFile, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW).catch(failure => { if (failure.code === 'ENOENT') fail('BUILD_ASSET_SEAL_MISSING'); throw failure })
    let sealBytes
    try {
      const stat = await sealHandle.stat()
      if (!stat.isFile() || stat.size > 8 * 1024 * 1024) fail('INVALID_BUILD_ASSET_SEAL')
      sealBytes = await sealHandle.readFile()
    } finally { await sealHandle.close() }
    const seal = JSON.parse(sealBytes.toString('utf8'))
    if (seal?.version !== 1 || !['completed-build', 'explicitly-sealed-existing-build'].includes(seal.kind) || !Array.isArray(seal.files) || !seal.files.length || seal.files.length > MAX_FILES || !Number.isSafeInteger(seal.sealedAt) || seal.sealedAt < 0) fail('INVALID_BUILD_ASSET_SEAL')
    const runtime = seal.runtime
    if (runtime !== undefined) {
      if (seal.kind !== 'completed-build' || runtime?.version !== 1 || runtime.storageProtocol !== 2 || runtime.imageBase !== 'module-relative-v1') fail('INVALID_RUNTIME_SEAL')
      validateRuntimeFiles(runtime.files)
      for (const entry of seal.files) if (!runtime.files.some(file => file.path === entry.path && file.sha256 === entry.sha256 && file.bytes === entry.bytes)) fail('INCOMPLETE_RUNTIME_SEAL')
    }
    const seen = new Set()
    const prepared = new Map()
    let preparedBytes = 0
    for (const entry of runtime?.files ?? seal.files) {
      if (!entry || !(runtime ? runtimePath(entry.path) : immutablePath(entry.path)) || seen.has(entry.path) || !/^[a-f0-9]{64}$/.test(entry.sha256) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || entry.bytes > MAX_FILE_BYTES) fail('INVALID_BUILD_ASSET_SEAL')
      seen.add(entry.path)
      const target = path.join(dist, entry.path)
      const stat = await fsp.lstat(target)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== entry.bytes || await fsp.realpath(target) !== target) fail('BUILD_ASSET_SOURCE_CHANGED')
      const handle = await fsp.open(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
      let bytes
      try {
        const before = await handle.stat()
        if (!before.isFile() || before.dev !== stat.dev || before.ino !== stat.ino || before.size !== entry.bytes) fail('BUILD_ASSET_SOURCE_CHANGED')
        bytes = await handle.readFile()
        const after = await handle.stat()
        if (bytes.length !== entry.bytes || before.size !== after.size || before.mtimeMs !== after.mtimeMs || digest(bytes) !== entry.sha256) fail('BUILD_ASSET_SOURCE_CHANGED')
      } finally { await handle.close() }
      const previous = immutablePath(entry.path) ? next.get(entry.path) : null
      if (previous && (previous.sha256 !== entry.sha256 || previous.bytes !== entry.bytes)) fail('BUILD_ASSET_NAME_COLLISION')
      if (!prepared.has(entry.sha256)) {
        preparedBytes += bytes.length
        if (preparedBytes > maxBytes) fail('ASSET_CACHE_BUDGET_EXHAUSTED')
        prepared.set(entry.sha256, bytes)
      }
    }
    // Publishing a different/new seal during capture invalidates this snapshot.
    const finalSeal = await fsp.readFile(sealFile)
    if (!finalSeal.equals(sealBytes)) fail('BUILD_ASSET_SEAL_CHANGED')
    const manifest = runtime ? { version: 1, kind: 'local-runtime-closure', storageProtocol: 2, imageBase: 'module-relative-v1', files: [...runtime.files].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0).map(entry => ({ path: entry.path, sha256: entry.sha256, bytes: entry.bytes })) } : null
    const body = manifest ? JSON.stringify(manifest) + '\n' : null
    if (body && Buffer.byteLength(body) > 8 * 1024 * 1024) fail('RUNTIME_RELEASE_BYTE_BUDGET')
    const id = body ? digest(body) : null
    if (manifest) for (const file of ['preview.html', 'manifest.webmanifest']) projectRuntime(manifest, id, file, prepared.get(manifest.files.find(entry => entry.path === file).sha256))

    const pins = new Set(await readPins())
    const selection = await createRuntimeHead({ repository, directory: runtimeDirectory, verifyRelease: async () => {} }).view()
    if (selection.pendingReconciliation) fail('RUNTIME_PUBLICATION_PENDING')
    if (selection.selected.releaseId) pins.add(selection.selected.releaseId)
    const existingReleases = new Set(retainedReleases.map(release => release.id))
    // Active selection and explicit pins require available closures, even if the build could recreate one.
    for (const pin of pins) if (!existingReleases.has(pin)) fail('PINNED_RUNTIME_UNAVAILABLE')
    if (id) pins.add(id)
    const history = path.join(runtimeDirectory, 'history')
    const historyNames = await fsp.readdir(history).catch(failure => { if (failure.code === 'ENOENT') return []; throw failure })
    if (historyNames.length > MAX_FILES) fail('RUNTIME_HISTORY_BUDGET')
    for (const name of historyNames) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) fail('UNKNOWN_RUNTIME_HISTORY_FILE')
      const record = JSON.parse((await readPrivate(path.join(history, name), 16384)).toString('utf8'))
      const recordBody = { version: record.version, epoch: record.epoch, releaseId: record.releaseId, parentRecordId: record.parentRecordId, operationId: record.operationId }
      if (record.version !== 1 || !/^[a-f0-9]{64}$/.test(record.releaseId) || record.recordId !== name.slice(0, -5) || digest(JSON.stringify(recordBody)) !== record.recordId) fail('INVALID_RUNTIME_HISTORY')
      // History is immutable selection evidence, not a promise that a prior installation retained its closure.
      if (existingReleases.has(record.releaseId)) pins.add(record.releaseId)
    }
    const newest = [...retainedReleases]
    if (id && !newest.some(release => release.id === id)) newest.push({ id, at: Infinity })
    newest.sort((left, right) => right.at - left.at || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
    for (const release of newest.slice(0, 5)) pins.add(release.id)
    const removed = retainedReleases.filter(release => !pins.has(release.id))
    const keptPaths = new Set(retainedReleases.filter(release => pins.has(release.id)).flatMap(release => release.manifest.files.map(entry => entry.path)))
    for (const entry of runtime?.files ?? seal.files) keptPaths.add(entry.path)
    for (const release of removed) for (const entry of release.manifest.files) if (!keptPaths.has(entry.path)) next.delete(entry.path)
    const keptObjects = new Set([...next.values()].map(entry => entry.sha256))
    for (const release of retainedReleases.filter(release => pins.has(release.id))) for (const entry of release.manifest.files) keptObjects.add(entry.sha256)
    for (const sha of prepared.keys()) keptObjects.add(sha)
    // Includes objects stranded by an interrupted capture/prune, not just this round's removed manifests.
    const removedObjects = new Set([...objectSizes.keys()].filter(sha => !keptObjects.has(sha)))
    const reclaimed = removed.reduce((sum, release) => sum + release.bytes, 0) + [...removedObjects].reduce((sum, sha) => sum + objectSizes.get(sha), 0) + temporaryFiles.reduce((sum, temporary) => sum + temporary.stat.size, 0)
    const temporaryObjects = temporaryFiles.filter(temporary => temporary.object).length
    const addedObjects = [...prepared].filter(([sha]) => !objectSizes.has(sha))
    const addedManifestBytes = id && !releaseNames.includes(id + '.json') ? Buffer.byteLength(body) : 0
    // Budget the retained set, not the historical accumulation. Impossible pins fail before deleting anything.
    if (totalBytes - reclaimed + addedObjects.reduce((sum, [, bytes]) => sum + bytes.length, 0) + addedManifestBytes > maxBytes) fail('ASSET_CACHE_BUDGET_EXHAUSTED')
    if (physicalObjects - removedObjects.size - temporaryObjects + addedObjects.length > MAX_FILES) fail('ASSET_CACHE_OBJECT_BUDGET')
    if (retainedReleases.length - removed.length + Number(addedManifestBytes > 0) > MAX_FILES) fail('RUNTIME_RELEASE_BUDGET')
    if (removed.length || removedObjects.size || temporaryFiles.length) {
      // Publish the reduced fallback index before removing objects it used to reference.
      await publishIndex(next, capturedAt ?? Date.now())
      for (const { file, stat } of temporaryFiles) {
        const current = await fsp.lstat(file)
        if (!current.isFile() || current.isSymbolicLink() || !own(current) || (current.mode & 0o077) || ['dev', 'ino', 'nlink', 'size', 'mtimeMs', 'ctimeMs'].some(key => current[key] !== stat[key])) fail('ASSET_CACHE_TEMPORARY_CHANGED')
        // Unlink only the reserved name; a published hardlink remains immutable and readable.
        await fsp.unlink(file)
      }
      for (const release of removed) await fsp.unlink(path.join(releases, release.id + '.json'))
      await syncDirectory(releases)
      for (const sha of removedObjects) { await fsp.unlink(path.join(objects, sha)); objectSizes.delete(sha) }
      await syncDirectory(objects)
      totalBytes -= reclaimed; physicalObjects -= removedObjects.size + temporaryObjects; storageBytes = totalBytes
    }
    for (const [sha, bytes] of prepared) {
      if (!objectSizes.has(sha)) { await writeObject(sha, bytes); objectSizes.set(sha, bytes.length); totalBytes += bytes.length; physicalObjects += 1 }
      else await verifyObject(sha, bytes.length)
    }
    storageBytes = totalBytes
    for (const entry of runtime?.files ?? seal.files) if (immutablePath(entry.path)) next.set(entry.path, { sha256: entry.sha256, bytes: entry.bytes })
    if (next.size > MAX_FILES) fail('ASSET_CACHE_INDEX_BUDGET')
    if (runtime) {
      if (releaseNames.includes(id + '.json')) await readRelease(id)
      else {
        const temporary = path.join(releases, '.' + crypto.randomUUID() + '.tmp')
        const handle = await fsp.open(temporary, 'wx', 0o600)
        try {
          try { await handle.writeFile(body); await handle.sync() } finally { await handle.close() }
          try { await fsp.link(temporary, path.join(releases, id + '.json')) } catch (failure) { if (failure.code !== 'EEXIST') throw failure }
          await readRelease(id); await syncDirectory(releases)
          totalBytes += Buffer.byteLength(body); storageBytes = totalBytes
        } finally { await fsp.rm(temporary, { force: true }) }
      }
      latestRelease = id
      await releaseList()
    }
    await publishIndex(next, Date.now())
    error = null
  }
  async function writePrivateJson(target, value) {
    const body = JSON.stringify(value) + '\n'
    if (Buffer.byteLength(body) > 8 * 1024 * 1024) fail('ASSET_CACHE_INDEX_BYTE_BUDGET')
    const temporary = path.join(directory, '.' + crypto.randomUUID() + '.tmp')
    const handle = await fsp.open(temporary, 'wx', 0o600)
    try {
      try { await handle.writeFile(body); await handle.sync() } finally { await handle.close() }
      await fsp.rename(temporary, target); await syncDirectory(directory)
    } finally { await fsp.rm(temporary, { force: true }) }
  }
  async function publishIndex(next, timestamp) {
    await writePrivateJson(indexFile, { version: 1, capturedAt: timestamp, files: [...next].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([file, entry]) => ({ path: file, ...entry })) })
    entries = new Map(next); capturedAt = timestamp
  }
  async function readPins() {
    const bytes = await readPrivate(pinsFile, 1024 * 1024).catch(absent)
    if (!bytes) return []
    const pins = JSON.parse(bytes.toString('utf8'))
    if (pins?.version !== 1 || !Array.isArray(pins.releaseIds) || pins.releaseIds.length > MAX_FILES || new Set(pins.releaseIds).size !== pins.releaseIds.length || pins.releaseIds.some(id => typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id))) fail('INVALID_ASSET_CACHE_PINS')
    return pins.releaseIds
  }
  function serialized(operation, fenceRuntime = false) {
      const result = queue.then(async () => {
          await ensureStorage()
          const lockFile = path.join(directory, 'CAPTURE.lock')
          const owner = JSON.stringify({ pid: process.pid, id: crypto.randomUUID(), startedAt: Date.now() })
          let handle
          const deadline = Date.now() + captureWaitMs
          // A live capture in another process holds the lock: wait for it with bounded backoff; never break it.
          for (let delay = 25; !handle; delay = Math.min(delay * 2, 1000)) {
            try { handle = await fsp.open(lockFile, 'wx', 0o600) } catch (failure) {
              if (failure.code !== 'EEXIST') throw failure
              const holder = await lockHolder(lockFile)
              // A dead holder will never release: refuse at once and leave the lock for manual inspection.
              if (holder.alive === false || Date.now() + delay > deadline) throw Object.assign(new Error('ASSET_CACHE_CAPTURE_LOCKED'), { code: 'ASSET_CACHE_CAPTURE_LOCKED', status: 503, holder })
              await new Promise(resolve => setTimeout(resolve, delay))
            }
          }
          const identity = await handle.stat()
          try {
            await handle.writeFile(owner); await handle.sync()
            await load(true)
            if (!fenceRuntime) return await operation()
            await ensureDirectory(runtimeDirectory)
            const runtimeLock = path.join(runtimeDirectory, 'WRITE.lock')
            // Selection holds WRITE.lock while calling verifyRuntime. Never wait for it while holding CAPTURE.lock.
            const runtimeHandle = await fsp.open(runtimeLock, 'wx', 0o600).catch(failure => { if (failure.code === 'EEXIST') fail('RUNTIME_WRITER_ACTIVE'); throw failure })
            const runtimeIdentity = await runtimeHandle.stat()
            try {
              await runtimeHandle.writeFile(owner); await runtimeHandle.sync()
              return await operation()
            } finally {
              try {
                const current = await fsp.lstat(runtimeLock)
                if (current.dev !== runtimeIdentity.dev || current.ino !== runtimeIdentity.ino) fail('RUNTIME_LOCK_CHANGED')
                await fsp.unlink(runtimeLock); await syncDirectory(runtimeDirectory)
              } finally { await runtimeHandle.close() }
            }
          } finally {
            try {
              const current = await fsp.lstat(lockFile)
              if (current.dev !== identity.dev || current.ino !== identity.ino) fail('ASSET_CACHE_LOCK_CHANGED')
              await fsp.rm(lockFile); await syncDirectory(directory)
            } finally { await handle.close() }
          }
      })
      queue = result.then(() => undefined, () => undefined)
      return result
  }
  const status = () => ({ ok: error === null && capturedAt !== null, files: entries?.size ?? 0, bytes: storageBytes, indexedBytes: [...new Map([...(entries ?? [])].map(([, entry]) => [entry.sha256, entry.bytes])).values()].reduce((sum, size) => sum + size, 0), maxBytes, capturedAt, error, releaseCount, latestRelease, automaticRuntimeRestore: false })
  return {
    directory,
    capture() {
      return serialized(capture, true).then(status).catch(failure => { error = failure.code ?? failure.message; return { ...status(), ok: false, ...(failure.holder ? { lockHolder: failure.holder } : {}) } })
    },
    status,
    /** Explicit pins persist across hosts; unpinning does not delete a release until a later capture. */
    pinRelease(id, pinned = true) {
      return serialized(async () => {
        if (typeof pinned !== 'boolean') fail('INVALID_ASSET_CACHE_PIN', 400)
        await readRelease(id)
        const pins = new Set(await readPins())
        if (pinned) pins.add(id); else pins.delete(id)
        await writePrivateJson(pinsFile, { version: 1, releaseIds: [...pins].sort() })
        return { releaseId: id, pinned }
      })
    },
    listReleases() { return serialized(async () => ({ ok: true, candidates: await releaseList(), selectionAvailable: false, candidateIsLive: true })) },
    verifyRuntime(id) { return serialized(async () => {
      const manifest = await readRelease(id)
      const verified = new Set()
      for (const entry of manifest.files) if (!verified.has(entry.sha256)) { await verifyObject(entry.sha256, entry.bytes); verified.add(entry.sha256) }
      for (const file of ['preview.html', 'manifest.webmanifest']) { const entry = manifest.files.find(entry => entry.path === file); projectRuntime(manifest, id, file, await verifyObject(entry.sha256, entry.bytes)) }
      return { releaseId: id, files: manifest.files.length, storageProtocol: manifest.storageProtocol }
    }) },
    readRuntime(id, file, mainEntry = false) { return serialized(async () => {
      if (!runtimePath(file)) fail('INVALID_RUNTIME_FILE', 400)
      const manifest = await readRelease(id)
      const entry = manifest.files.find(entry => entry.path === file)
      if (!entry) fail('RUNTIME_FILE_UNAVAILABLE', 404)
      const bytes = projectRuntime(manifest, id, file, await verifyObject(entry.sha256, entry.bytes), mainEntry)
      return { bytes, sourceSha256: entry.sha256, responseSha256: digest(bytes) }
    }) },
    assertCurrent(file, bytes) {
      const expected = immutablePath(file) ? entries?.get(file) : null
      if (expected && (expected.bytes !== bytes.length || expected.sha256 !== digest(bytes))) { error = 'BUILD_ASSET_NAME_COLLISION'; fail(error) }
    },
    async read(file) {
      if (!immutablePath(file)) return null
      try { return await serialized(async () => {
        const entry = entries.get(file)
        if (!entry) return null
        return { bytes: await verifyObject(entry.sha256, entry.bytes), sha256: entry.sha256 }
      }) } catch (failure) { error = failure.code ?? failure.message; throw failure }
    },
  }
}
