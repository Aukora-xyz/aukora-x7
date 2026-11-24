/** Private immutable recovery copies for finalized memory files, never an automatic restore. */
import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

const MAX_BYTES = 32 * 1024 * 1024
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
const fail = code => { throw Object.assign(new Error(code), { code, status: 503 }) }
const missing = error => { if (error.code === 'ENOENT') return null; throw error }

/** Only mirror startup and ordered mirror writes are covered, not privileged host edits. */
export function createMemoryHistory({ mirrorDirectory }) {
  const directory = path.join(mirrorDirectory, '.transport', 'memory-history')
  const sources = [
    { name: 'v1', file: path.join(mirrorDirectory, 'home', 'auma', 'memory-store.json') },
    { name: 'v2', file: path.join(mirrorDirectory, 'home', 'auma', 'memory-store.v2.json') },
  ]
  let ready = false
  const owned = stat => typeof process.getuid === 'function' && stat.uid === process.getuid()
  async function syncDirectory(target) {
    const handle = await fsp.open(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
    try { if (!(await handle.stat()).isDirectory()) fail('MEMORY_HISTORY_NOT_DIRECTORY'); await handle.sync() }
    finally { await handle.close() }
  }
  async function checkParents(target) {
    let current = mirrorDirectory
    const root = await fsp.lstat(current)
    if (!root.isDirectory() || root.isSymbolicLink() || !owned(root) || (root.mode & 0o022) !== 0) fail('MEMORY_HISTORY_UNSAFE_ROOT')
    for (const part of path.relative(mirrorDirectory, target).split(path.sep)) {
      current = path.join(current, part)
      const stat = await fsp.lstat(current).catch(missing)
      if (!stat) return
      if (stat.isSymbolicLink()) fail('MEMORY_HISTORY_SYMLINK_REFUSED')
      if (current !== target && (!stat.isDirectory() || !owned(stat) || (stat.mode & 0o022) !== 0)) fail('MEMORY_HISTORY_UNSAFE_PARENT')
    }
  }
  async function ensureDirectory(target, privateDirectory) {
    await checkParents(target)
    try { await fsp.mkdir(target, { mode: privateDirectory ? 0o700 : 0o755 }) }
    catch (error) { if (error.code !== 'EEXIST') throw error }
    const stat = await fsp.lstat(target)
    if (!stat.isDirectory() || stat.isSymbolicLink() || !owned(stat) || (stat.mode & (privateDirectory ? 0o077 : 0o022)) !== 0) fail('MEMORY_HISTORY_UNSAFE_DIRECTORY')
    // Also sync an existing parent entry: a previous interrupted attempt may
    // have created this directory before its parent's sync completed.
    await syncDirectory(path.dirname(target))
    await syncDirectory(target)
  }
  async function verifyPrivateFile(file, expected) {
    const handle = await fsp.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
    try {
      const stat = await handle.stat()
      if (!stat.isFile() || !owned(stat) || (stat.mode & 0o077) !== 0 || stat.size > MAX_BYTES) fail('MEMORY_HISTORY_UNSAFE_OBJECT')
      const bytes = await handle.readFile()
      if (hash(bytes) !== expected) fail('MEMORY_HISTORY_OBJECT_MISMATCH')
      await handle.sync()
      return bytes.length
    } finally { await handle.close() }
  }
  async function retain(source, bytes) {
    if (bytes.length > MAX_BYTES) fail('MEMORY_HISTORY_BYTE_BUDGET')
    await ensureDirectory(directory, true)
    const bucket = path.join(directory, source.name)
    await ensureDirectory(bucket, true)
    const digest = hash(bytes)
    const target = path.join(bucket, digest + '.json')
    const temporary = path.join(bucket, '.' + crypto.randomUUID() + '.tmp')
    const handle = await fsp.open(temporary, 'wx', 0o600)
    try {
      try { await handle.writeFile(bytes); await handle.sync() }
      finally { await handle.close() }
      // Hard-link publication is exclusive: an old hash object is never replaced.
      try { await fsp.link(temporary, target) }
      catch (error) { if (error.code !== 'EEXIST') throw error }
      if (await verifyPrivateFile(target, digest) !== bytes.length) fail('MEMORY_HISTORY_OBJECT_MISMATCH')
      // Refuse the destructive mirror write if directory durability is unavailable.
      await syncDirectory(bucket)
    } finally { await fsp.rm(temporary, { force: true }) }
  }
  async function retainCurrent(source) {
    await checkParents(source.file)
    const handle = await fsp.open(source.file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW).catch(missing)
    if (!handle) return
    try {
      const before = await handle.stat()
      if (!before.isFile() || before.size > MAX_BYTES) fail('MEMORY_HISTORY_SOURCE_NOT_FILE')
      const bytes = await handle.readFile()
      const after = await handle.stat()
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || bytes.length !== after.size) fail('MEMORY_HISTORY_SOURCE_MOVED')
      await retain(source, bytes)
    } finally { await handle.close() }
  }
  return {
    directory,
    async initialize() {
      await ensureDirectory(path.join(mirrorDirectory, '.transport'), false)
      await ensureDirectory(directory, true)
      for (const source of sources) { await ensureDirectory(path.join(directory, source.name), true); await retainCurrent(source) }
      ready = true
    },
    async beforeApply(target, wire) {
      if (!ready) fail('MEMORY_HISTORY_NOT_READY')
      for (const source of sources) {
        if (target !== source.file && !source.file.startsWith(target + path.sep)) continue
        // Includes ancestor deletion/type replacement, not only direct overwrites.
        await retainCurrent(source)
        if (target === source.file && wire.kind === 'file') await retain(source, Buffer.from(wire.b64, 'base64'))
      }
    },
    async inspect() {
      if (!ready) fail('MEMORY_HISTORY_NOT_READY')
      const stores = []
      for (const source of sources) {
        const bucket = path.join(directory, source.name)
        await ensureDirectory(bucket, true)
        let versions = 0; let bytes = 0
        for (const name of await fsp.readdir(bucket)) {
          if (!/^[a-f0-9]{64}\.json$/.test(name)) continue
          bytes += await verifyPrivateFile(path.join(bucket, name), name.slice(0, -5)); versions += 1
        }
        stores.push({ store: source.name, versions, bytes })
      }
      return { ok: true, scope: 'local-host-startup-and-mirror-apply', automaticRestore: false, stores }
    },
  }
}
