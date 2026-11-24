/** Build the real preview under one writer lock; seal assets only after all producers finish. */
import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { gzipSync, gunzipSync } from 'node:zlib'
import { immutablePath, runtimePath } from './asset-cache.mjs'

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const web = path.join(repository, 'apps', 'web')
const dist = path.join(web, 'dist')
const cache = path.join(repository, '.cache')
const lockFile = path.join(cache, 'x61-preview-build.lock')
const generationFile = path.join(cache, 'x61-preview-generation.json')
const generationId = crypto.randomUUID()
const existing = process.argv.length === 3 && process.argv[2] === '--seal-existing'
const rebuildUnsealed = process.argv.length === 3 && process.argv[2] === '--rebuild-unsealed'
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
const fail = message => { throw new Error(message) }
const absent = error => { if (error.code === 'ENOENT') return null; throw error }
let child = null
let stopped = null
async function directorySync(file) { const handle = await fsp.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); try { await handle.sync() } finally { await handle.close() } }
async function publishGeneration(phase) {
  const temporary = generationFile + '.' + generationId + '.tmp'
  const handle = await fsp.open(temporary, 'wx', 0o600)
  try {
    try { await handle.writeFile(JSON.stringify({ version: 1, id: generationId, phase, updatedAt: Date.now() })); await handle.sync() } finally { await handle.close() }
    await fsp.rename(temporary, generationFile); await directorySync(cache)
  } finally { await fsp.rm(temporary, { force: true }) }
}
async function run(args, cwd) {
  if (stopped) fail('Preview build interrupted before next command')
  await new Promise((resolve, reject) => {
    child = spawn('pnpm', args, { cwd, env: process.env, stdio: 'inherit' })
    child.once('error', reject)
    child.once('close', (code, signal) => { child = null; if (code === 0) resolve(); else reject(new Error('Preview producer failed: ' + (signal ?? code))) })
  })
}
async function retain(promote = false) {
  const port = Number(process.env.PORT ?? 4610)
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail('Invalid local host port')
  const origin = 'http://127.0.0.1:' + port
  let page
  try { page = await fetch(origin + '/recovery/', { signal: AbortSignal.timeout(3000) }) }
  catch (error) {
    if (error.cause?.code !== 'ECONNREFUSED') throw error
    console.warn('[preview-build] No local host is listening; live asset retention was not performed.')
    return
  }
  const cookie = page.headers.get('set-cookie')?.split(';')[0]
  if (!page.ok || !cookie) fail('Local host retention capability unavailable; existing dist was not replaced')
  const response = await fetch(origin + '/_host/runtime-assets', { method: 'POST', headers: { cookie }, signal: AbortSignal.timeout(60000) })
  if (response.status === 404) { console.warn('[preview-build] Local host does not support retained assets; no retention guarantee.'); return }
  const status = await response.json()
  if (!response.ok || status.ok !== true) fail('Local asset retention failed: ' + (status.error ?? response.status) + (status.lockHolder ? ' (lock holder ' + JSON.stringify(status.lockHolder) + ')' : ''))
  console.log('[preview-build] Retained ' + status.files + ' named assets, ' + status.bytes + ' bytes.')
  if (promote) {
    const rtRes = await fetch(origin + '/_head/runtime', { headers: { cookie }, signal: AbortSignal.timeout(10000) }).catch(() => null)
    if (rtRes?.ok) {
      const rt = await rtRes.json().catch(() => null)
      if (rt?.latestCapturedRelease && rt?.selectionAvailable && rt.selected?.releaseId !== rt.latestCapturedRelease) {
        const selRes = await fetch(origin + '/_head/runtime', {
          method: 'POST',
          headers: { cookie, 'content-type': 'application/json' },
          body: JSON.stringify({
            operationId: crypto.randomUUID(),
            releaseId: rt.latestCapturedRelease,
            expectedEpoch: rt.selected?.epoch ?? 0,
            expectedRecordId: rt.selected?.recordId ?? null,
          }),
          signal: AbortSignal.timeout(10000),
        }).catch(() => null)
        if (selRes?.ok) console.log('[preview-build] Promoted runtime head to ' + rt.latestCapturedRelease)
      }
    }
  }
}
async function seal(kind) {
  if (await fsp.realpath(dist) !== dist) fail('Build output root must not be a symlink')
  const files = []
  const runtimeFiles = []
  let scanned = 0
  async function walk(relative) {
    const target = path.join(dist, relative)
    const stat = await fsp.lstat(target)
    if (stat.isSymbolicLink()) fail('Build output symlink refused')
    if (stat.isDirectory()) {
      for (const name of (await fsp.readdir(target)).sort()) {
        if (++scanned > 10000) fail('Build inventory file budget exhausted')
        await walk(relative ? relative + '/' + name : name)
      }
    } else if (stat.isFile() && (immutablePath(relative) || (kind === 'completed-build' && runtimePath(relative)))) {
      if (stat.size > 32 * 1024 * 1024 || await fsp.realpath(target) !== target) fail('Build asset source refused')
      const handle = await fsp.open(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
      try {
        const before = await handle.stat()
        if (!before.isFile() || before.dev !== stat.dev || before.ino !== stat.ino || before.size !== stat.size) fail('Build asset source moved')
        const bytes = await handle.readFile(); const after = await handle.stat()
        if (bytes.length !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs) fail('Build asset source moved')
        const entry = { path: relative, sha256: sha(bytes), bytes: bytes.length }
        if (immutablePath(relative)) files.push(entry)
        if (kind === 'completed-build' && runtimePath(relative)) runtimeFiles.push(entry)
      } finally { await handle.close() }
    }
  }
  await walk('')
  if (stopped) fail('Preview build interrupted before seal publication')
  if (!files.length) fail('No immutable preview assets were produced')
  const body = JSON.stringify({ version: 1, kind, sealedAt: Date.now(), files, ...(kind === 'completed-build' ? { runtime: { version: 1, storageProtocol: 2, imageBase: 'module-relative-v1', files: runtimeFiles } } : {}) }) + '\n'
  if (Buffer.byteLength(body) > 8 * 1024 * 1024) fail('Build inventory byte budget exhausted')
  const target = path.join(dist, 'preview', 'asset-seal.json')
  const temporary = target + '.' + crypto.randomUUID() + '.tmp'
  const handle = await fsp.open(temporary, 'wx', 0o600)
  try {
    try { await handle.writeFile(body); await handle.sync() } finally { await handle.close() }
    await fsp.rename(temporary, target); await directorySync(path.dirname(target))
  } finally { await fsp.rm(temporary, { force: true }) }
  console.log('[preview-build] Sealed ' + files.length + ' named immutable assets (' + kind + ').')
}

/**
 * Collect only selected, content-verified organ sources and the two requested Pearl data files.
 * No recursive mirror walk: keys, receipts, journals, snapshots and conflict backups cannot enter here.
 * @param root - Repository root, supplied explicitly for synthetic fixtures.
 * @returns Allowlisted image-relative files; a changed head or unsafe source refuses the build.
 */
export async function collectSeedImageFiles(root) {
  const files = Object.create(null)
  let total = 0
  const read = async relative => {
    const target = path.join(root, 'mirror', relative)
    if (await fsp.realpath(target) !== target) fail('Seed image source symlink refused: ' + relative)
    const handle = await fsp.open(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
    try {
      const before = await handle.stat()
      if (!before.isFile() || before.size > 2 * 1024 * 1024) fail('Seed image source limit: ' + relative)
      const bytes = await handle.readFile()
      const after = await handle.stat()
      if (bytes.length !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs) fail('Seed image source changed: ' + relative)
      return bytes
    } finally { await handle.close() }
  }
  const add = (name, bytes) => {
    total += bytes.length
    if (total > 8 * 1024 * 1024) fail('Seed image total exceeds 8 MiB')
    files[name] = bytes
  }
  const headBytes = await read('home/balls/HEAD.json')
  const head = JSON.parse(headBytes)
  if (head?.version !== 'x6.1-ball/v1' || !head.entries || typeof head.entries !== 'object' || Array.isArray(head.entries)) fail('Seed image head invalid')
  const entries = Object.entries(head.entries)
  if (!entries.length || entries.length > 128) fail('Seed image organ count invalid')
  for (const [id, entry] of entries.sort(([a], [b]) => a.localeCompare(b))) {
    if (!/^ball:[a-f0-9]{64}$/.test(entry?.specifier)) fail('Seed image selected organ invalid')
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(id)) continue
    const digest = entry.specifier.slice(5)
    const bytes = await read('home/balls/' + digest + '.js')
    if (sha(bytes) !== digest) fail('Seed image selected organ hash mismatch: ' + id)
    add('home/auma/seed/organs/' + id + '.js', bytes)
  }
  for (const relative of ['home/auma/seed/pearl/retention-suite.v1.json', 'home/auma/seed/scars.jsonl']) add(relative, await read(relative))
  if (!(await read('home/balls/HEAD.json')).equals(headBytes)) fail('Seed image head changed during collection')
  return files
}

async function hydrateSeedImage() {
  // Uses the just-built runtime's existing ustar codec; never invent another archive format.
  const { packTar, parseTar } = await import('../packages/experimental/webworker-runtime/lib/index.js')
  const target = path.join(dist, 'preview', 'vfs-image.tar.gz')
  const sources = await collectSeedImageFiles(repository)
  const files = Object.create(null)
  for (const entry of parseTar(gunzipSync(await fsp.readFile(target)))) {
    if (Object.hasOwn(files, entry.name)) fail('Duplicate VFS image entry')
    files[entry.name] = entry.bytes
  }
  for (const [name, bytes] of Object.entries(sources)) {
    if (Object.hasOwn(files, name)) fail('Seed image path already packaged: ' + name)
    files[name] = bytes
  }
  // Stage working-copy candidate organs under home/auma/seed/candidates/<id>.js and stamp BUILD_INFO.json
  // so cloud-mode sessions receive unpromoted repo candidates without needing x6_repo or overwriting MirrorDO.
  const candidateOrgans = Object.create(null)
  for (const [name, activeBytes] of Object.entries(sources)) {
    const match = /^home\/auma\/seed\/organs\/([a-z][a-z0-9-]{0,63})\.js$/.exec(name)
    if (!match) continue
    const id = match[1]
    const diskPath = path.join(repository, 'mirror', name)
    const diskBytes = await fsp.readFile(diskPath).catch(absent)
    if (!diskBytes) continue
    const diskSha = sha(diskBytes)
    const activeSha = sha(activeBytes)
    if (diskSha !== activeSha) {
      files['home/auma/seed/candidates/' + id + '.js'] = new Uint8Array(diskBytes)
      files['home/balls/' + diskSha + '.js'] = new Uint8Array(diskBytes)
      candidateOrgans[id] = { activeSha256: activeSha, candidateSha256: diskSha, bytes: diskBytes.length }
    }
  }
  let gitHead = null
  try {
    const headRef = (await fsp.readFile(path.join(repository, '.git', 'HEAD'), 'utf8')).trim()
    gitHead = headRef.startsWith('ref: ')
      ? (await fsp.readFile(path.join(repository, '.git', headRef.slice(5)), 'utf8')).trim()
      : headRef
  } catch {}
  for (const covRel of [
    'home/auma/COVENANT.md',
    'home/auma/seed/COVENANT.md',
    'home/auma/UNCHANGEABLE.md',
    'home/auma/seed/UNCHANGEABLE.md',
    'home/auma/seed/SMALL-MODE-ANSWER.md',
    'home/auma/seed/R-W3-CAP.md',
    'home/auma/seed/SUPERAGENT-INTEGRATION-SPEC.md',
  ]) {
    const covBytes = await fsp.readFile(path.join(repository, 'mirror', covRel)).catch(absent)
    if (covBytes) files[covRel] = new Uint8Array(covBytes)
  }
  files['home/auma/seed/BUILD_INFO.json'] = new Uint8Array(Buffer.from(JSON.stringify({
    schema: 'aukora.build-info.v1',
    organSourceCommit: gitHead,
    builtAt: new Date().toISOString(),
    candidateOrgans,
  }, null, 2) + '\n'))
  const bytes = gzipSync(packTar(files), { level: 9 })
  bytes[9] = 255
  await fsp.writeFile(target, bytes)
  console.log('[preview-build] Added ' + Object.keys(sources).length + ' allowlisted selected Seed files and ' + Object.keys(candidateOrgans).length + ' staged candidate organs.')
}

async function main() {
if (process.argv.length !== (existing || rebuildUnsealed ? 3 : 2)) throw new Error('Expected no arguments, --seal-existing for a verified legacy build, or --rebuild-unsealed after inspecting a failed partial build')
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { stopped = signal; child?.kill(signal) })
const root = await fsp.lstat(repository)
if (!root.isDirectory() || root.isSymbolicLink() || root.uid !== process.getuid() || (root.mode & 0o022)) fail('Unsafe repository root')
try { await fsp.mkdir(cache, { mode: 0o700 }) } catch (error) { if (error.code !== 'EEXIST') throw error }
const cacheStat = await fsp.lstat(cache)
if (!cacheStat.isDirectory() || cacheStat.isSymbolicLink() || cacheStat.uid !== process.getuid() || (cacheStat.mode & 0o022)) fail('Unsafe build cache parent')
let lock
try { lock = await fsp.open(lockFile, 'wx', 0o600) } catch (error) { if (error.code === 'EEXIST') fail('PREVIEW_BUILD_LOCKED: preserve the active build; inspect a stale lock manually after stopping its owner'); throw error }
const identity = await lock.stat()
let mutatingOutput = false
try {
  await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: Date.now(), existing })); await lock.sync(); await directorySync(cache)
  if (existing) await seal('explicitly-sealed-existing-build')
  else {
    if (rebuildUnsealed) {
      if (await fsp.lstat(path.join(dist, 'preview', 'asset-seal.json')).catch(absent)) fail('A sealed output exists; ordinary retention must run before rebuilding it')
      console.warn('[preview-build] Explicit operator recovery: replacing unsealed partial build output without sealing or retaining it. Previously retained objects are untouched; their availability must be checked in recovery.')
    } else if (await fsp.lstat(path.join(dist, 'preview.html')).catch(absent)) await retain()
    // EVERY WORKSPACE LIBRARY FIRST (Round 33): the app ships each package's gitignored lib/ bundle, so a package this
    // step does not build ships whatever was last built on this machine (once that was a five-day-old build for about 60
    // client packages, and the Round 23 thread header, the Round 26 sign-in wording and the DeepSeek owner-session
    // mapping were on main but not in the app). A clean checkout has no lib/ at all. build:lib is the repository's own
    // full library build (host types and bundles, then every client bundle), incremental where nothing changed.
    await run(['run', 'build:lib'], repository)
    await run(['--filter', '@deepseek-ai/dsh-experimental-webworker-runtime', 'exec', 'tsc', '-p', 'tsconfig.json', '--emitDeclarationOnly'], repository)
    await run(['--filter', '@deepseek-ai/dsh-experimental-webworker-runtime', 'exec', 'tsdown'], repository)
    await run(['--filter', '@deepseek-ai/dsh-experimental-webworker-packer', 'exec', 'tsdown'], repository)
    await run(['--filter', '@deepseek-ai/dsh-client-ui-layout', 'exec', 'tsdown'], repository)
    await publishGeneration('building')
    mutatingOutput = true
    await run(['exec', 'vite', 'build'], web)
    await run(['exec', 'dsh-pack-vfs-image', '--out', 'dist/preview/vfs-image.tar.gz'], web)
    await hydrateSeedImage()
    if (stopped) fail('Preview build interrupted before seal')
    await seal('completed-build')
    await retain(true)
  }
  await publishGeneration('complete')
} catch (failure) {
  if (mutatingOutput) await publishGeneration(stopped ? 'interrupted' : 'failed')
  throw failure
} finally {
  try {
    const current = await fsp.lstat(lockFile).catch(absent)
    if (current?.dev !== identity.dev || current?.ino !== identity.ino) fail('Build lock changed; not removing another owner’s lock')
    if (stopped) console.error('[preview-build] Interrupted producer outcome requires inspection; build lock retained.')
    else { await fsp.rm(lockFile); await directorySync(cache) }
  } finally { await lock.close() }
}
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
