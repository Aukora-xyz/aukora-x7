import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { createHash, randomUUID } from 'node:crypto'
import { createAssetCache, immutablePath } from './asset-cache.mjs'
import { createRuntimeHead } from './runtime-head.mjs'

async function fixture(t, captureWaitMs) {
  const repository = await fsp.mkdtemp(path.join(await fsp.realpath(os.tmpdir()), 'x61-asset-cache-'))
  t.after(() => fsp.rm(repository, { recursive: true, force: true }))
  const cache = createAssetCache({ repository, dist: path.join(repository, 'dist'), captureWaitMs })
  await cache.listReleases() // creates the private cache directories
  const lockFile = path.join(cache.directory, 'CAPTURE.lock')
  await fsp.writeFile(lockFile, JSON.stringify({ pid: process.pid, id: 'other-capture', startedAt: 1 }), { mode: 0o600, flag: 'wx' })
  return { cache, lockFile }
}

test('a capture waits for a live capture lock to clear instead of failing', async t => {
  const { cache, lockFile } = await fixture(t, 5000)
  let released = 0
  setTimeout(() => { released = Date.now(); void fsp.rm(lockFile) }, 200)
  const result = await cache.capture()
  assert.notEqual(released, 0, 'capture ran before the holder released its lock')
  assert.equal(result.error, 'ENOENT', 'the waiter took the lock and reached the missing dist')
  assert.equal(result.lockHolder, undefined)
  await assert.rejects(fsp.lstat(lockFile), { code: 'ENOENT' }, 'the waiter released its own lock')
})

test('a lock held past the bounded wait still refuses, names its holder and is never removed', async t => {
  const { cache, lockFile } = await fixture(t, 100)
  const result = await cache.capture()
  assert.equal(result.ok, false)
  assert.equal(result.error, 'ASSET_CACHE_CAPTURE_LOCKED')
  assert.deepEqual(result.lockHolder, { pid: process.pid, startedAt: 1, alive: true, sameProcess: true })
  const still = JSON.parse(await fsp.readFile(lockFile, 'utf8'))
  assert.equal(still.id, 'other-capture')
})

test('a lock whose holder is dead refuses at once and is left for inspection', async t => {
  const { cache, lockFile } = await fixture(t, 60000)
  const dead = 2 ** 22 + 12345 // above macOS and Linux default pid_max, so no live process owns it
  await fsp.writeFile(lockFile, JSON.stringify({ pid: dead, id: 'dead-capture', startedAt: 2 }), { mode: 0o600 })
  const started = Date.now()
  const result = await cache.capture()
  assert.ok(Date.now() - started < 5000, 'a dead holder must not cost the full wait')
  assert.equal(result.error, 'ASSET_CACHE_CAPTURE_LOCKED')
  assert.deepEqual(result.lockHolder, { pid: dead, startedAt: 2, alive: false, sameProcess: false })
  assert.equal(JSON.parse(await fsp.readFile(lockFile, 'utf8')).id, 'dead-capture')
})

const sha = bytes => createHash('sha256').update(bytes).digest('hex')
async function buildFixture(t) {
  const repository = await fsp.mkdtemp(path.join(await fsp.realpath(os.tmpdir()), 'x61-retention-'))
  t.after(() => fsp.rm(repository, { recursive: true, force: true }))
  const dist = path.join(repository, 'dist')
  const cache = createAssetCache({ repository, dist })
  const head = createRuntimeHead({ repository, directory: path.join(cache.directory, 'runtime-head'), verifyRelease: id => cache.verifyRuntime(id) })
  async function build(number, payloadBytes = 32) {
    const worker = `preview/worker-${String(number).padStart(8, '0')}.js`
    const contents = {
      'preview.html': `<html><script src="./${worker}"></script><link href="./manifest.webmanifest"></html>`,
      'manifest.webmanifest': JSON.stringify({ name: 'Synthetic fixture', icons: [] }),
      'preview/vfs-image.tar.gz': 'synthetic image',
      'preview/fixtures.json': '{}',
      'preview/scion/esbuild-0.28.2-b1831a5c.wasm': 'synthetic wasm',
      'preview/bootstrap-12345678.js': 'export {}',
      [worker]: Buffer.alloc(payloadBytes, number),
    }
    const files = []
    for (const [file, value] of Object.entries(contents)) {
      const bytes = Buffer.from(value)
      await fsp.mkdir(path.dirname(path.join(dist, file)), { recursive: true })
      await fsp.writeFile(path.join(dist, file), bytes)
      files.push({ path: file, sha256: sha(bytes), bytes: bytes.length })
    }
    await fsp.writeFile(path.join(dist, 'preview/asset-seal.json'), JSON.stringify({ version: 1, kind: 'completed-build', sealedAt: number, files: files.filter(entry => immutablePath(entry.path)), runtime: { version: 1, storageProtocol: 2, imageBase: 'module-relative-v1', files } }))
    const result = await cache.capture()
    assert.equal(result.ok, true, result.error)
    const id = result.latestRelease
    const stamp = new Date(1700000000000 + number * 1000)
    await fsp.utimes(path.join(cache.directory, 'releases', id + '.json'), stamp, stamp)
    return { id, worker, workerSha: files.find(entry => entry.path === worker).sha256 }
  }
  async function select(id) {
    const { selected } = await head.view()
    const result = await head.select({ operationId: randomUUID(), releaseId: id, expectedEpoch: selected.epoch, expectedRecordId: selected.recordId })
    assert.equal(result.ok, true, result.code)
  }
  return { repository, dist, cache, head, build, select }
}

test('capture retains selected history, explicit pins and newest five without rewriting immutable manifests', async t => {
  const { cache, build, select } = await buildFixture(t)
  const rows = []
  for (let number = 0; number < 9; number += 1) {
    rows.push(await build(number))
    if (number < 2) await select(rows[number].id)
    if (number === 2) await cache.pinRelease(rows[number].id)
  }
  const expected = rows.filter((_, number) => number !== 3).map(row => row.id).sort()
  assert.deepEqual((await cache.listReleases()).candidates.map(row => row.releaseId).sort(), expected)
  await assert.rejects(cache.readRuntime(rows[3].id, 'preview.html'), { code: 'RUNTIME_RELEASE_UNAVAILABLE' })
  assert.equal(await cache.read(rows[3].worker), null)
  for (const row of rows.filter((_, number) => number !== 3)) {
    const bytes = await fsp.readFile(path.join(cache.directory, 'releases', row.id + '.json'))
    assert.equal(sha(bytes), row.id)
    assert.ok((await cache.readRuntime(row.id, row.worker)).bytes.length)
  }
  const restarted = createAssetCache({ repository: path.dirname(path.dirname(cache.directory)), dist: '/unused' })
  assert.equal((await restarted.readRuntime(rows[2].id, rows[2].worker)).bytes.length, 32)
  await cache.pinRelease(rows[2].id, false)
  await build(9)
  await assert.rejects(cache.verifyRuntime(rows[2].id), { code: 'RUNTIME_RELEASE_UNAVAILABLE' })
})

test('pruning is planned before byte budget enforcement and removes stranded unreferenced objects', async t => {
  const { repository, dist, cache, build } = await buildFixture(t)
  const rows = []
  for (let number = 0; number < 6; number += 1) {
    rows.push(await build(number, 6 * 1024 * 1024))
    if (number === 0) await cache.pinRelease(rows[0].id)
  }
  const orphan = Buffer.alloc(1024, 88)
  const orphanPath = path.join(cache.directory, 'objects', sha(orphan))
  await fsp.writeFile(orphanPath, orphan, { mode: 0o600 })
  const constrained = createAssetCache({ repository, dist, maxBytes: 32 * 1024 * 1024 })
  assert.equal((await constrained.capture()).error, 'ASSET_CACHE_BUDGET_EXHAUSTED')
  assert.equal((await cache.listReleases()).candidates.length, 6, 'budget failure must preserve pins')
  await cache.pinRelease(rows[0].id, false)
  const result = await constrained.capture()
  assert.equal(result.ok, true, result.error)
  assert.ok(result.bytes <= result.maxBytes)
  assert.equal((await cache.listReleases()).candidates.length, 5)
  await assert.rejects(fsp.lstat(orphanPath), { code: 'ENOENT' })
  await assert.rejects(fsp.lstat(path.join(cache.directory, 'objects', rows[0].workerSha)), { code: 'ENOENT' })
})

test('an old recaptured release is retained, even when its immutable manifest timestamp is old', async t => {
  const { cache, build } = await buildFixture(t)
  const old = await build(0)
  await cache.pinRelease(old.id)
  for (let number = 1; number < 7; number += 1) await build(number)
  await cache.pinRelease(old.id, false)
  assert.equal((await build(0)).id, old.id)
  assert.equal((await cache.verifyRuntime(old.id)).releaseId, old.id)
})

test('runtime writers and pending selection block capture without changing releases', async t => {
  const { cache, build } = await buildFixture(t)
  const row = await build(0)
  const runtime = path.join(cache.directory, 'runtime-head')
  const lock = path.join(runtime, 'WRITE.lock')
  await fsp.writeFile(lock, JSON.stringify({ pid: process.pid }), { mode: 0o600, flag: 'wx' })
  assert.equal((await cache.capture()).error, 'RUNTIME_WRITER_ACTIVE')
  assert.ok(await fsp.lstat(lock))
  await fsp.unlink(lock)
  await fsp.writeFile(path.join(runtime, 'pending.json'), '{}', { mode: 0o600 })
  assert.equal((await cache.capture()).ok, false)
  assert.equal((await cache.verifyRuntime(row.id)).releaseId, row.id)
})

test('malformed pins and unsafe pin links refuse pruning; cache readers respect the shared capture lock', async t => {
  const { repository, dist, cache, build } = await buildFixture(t)
  const row = await build(0)
  const pins = path.join(cache.directory, 'pins.json')
  await fsp.writeFile(pins, '{"version":1,"releaseIds":["fabricated"]}', { mode: 0o600 })
  assert.equal((await cache.capture()).error, 'INVALID_ASSET_CACHE_PINS')
  await fsp.unlink(pins)
  await fsp.symlink(path.join(cache.directory, 'index.json'), pins)
  assert.equal((await cache.capture()).ok, false)
  await fsp.unlink(pins)
  const lock = path.join(cache.directory, 'CAPTURE.lock')
  await fsp.writeFile(lock, JSON.stringify({ pid: process.pid }), { mode: 0o600 })
  const reader = createAssetCache({ repository, dist, captureWaitMs: 0 })
  await assert.rejects(reader.readRuntime(row.id, row.worker), { code: 'ASSET_CACHE_CAPTURE_LOCKED' })
  await fsp.unlink(lock)
  assert.equal((await reader.verifyRuntime(row.id)).releaseId, row.id)
})

test('reconciled capture removes abandoned temporary bytes before budgeting, preserving published hardlinks', async t => {
  const { repository, dist, cache, build, select } = await buildFixture(t)
  const row = await build(0)
  await select(row.id)
  const object = path.join(cache.directory, 'objects', row.workerSha)
  const manifest = path.join(cache.directory, 'releases', row.id + '.json')
  const originalManifest = await fsp.readFile(manifest)
  const temporaries = []
  for (const [folder, size, published] of [['objects', 32 * 1024 * 1024, null], ['releases', 8 * 1024 * 1024, null], ['objects', 0, object], ['releases', 0, manifest]]) {
    const file = path.join(cache.directory, folder, '.' + randomUUID() + '.tmp')
    if (published) await fsp.link(published, file)
    else {
      const handle = await fsp.open(file, 'wx', 0o600)
      try { await handle.truncate(size) } finally { await handle.close() }
    }
    temporaries.push(file)
  }
  const constrained = createAssetCache({ repository, dist, maxBytes: 32 * 1024 * 1024, captureWaitMs: 0 })
  const lock = path.join(cache.directory, 'CAPTURE.lock')
  await fsp.writeFile(lock, JSON.stringify({ pid: process.pid }), { mode: 0o600, flag: 'wx' })
  assert.equal((await constrained.capture()).error, 'ASSET_CACHE_CAPTURE_LOCKED')
  await fsp.writeFile(lock, JSON.stringify({ pid: 2 ** 22 + 12345 }), { mode: 0o600 })
  assert.equal((await constrained.capture()).error, 'ASSET_CACHE_CAPTURE_LOCKED')
  for (const file of temporaries) assert.ok(await fsp.lstat(file))
  await fsp.unlink(lock) // Explicit fixture-only operator reconciliation, never performed by capture.
  const result = await constrained.capture()
  assert.equal(result.ok, true, result.error)
  assert.ok(result.bytes < result.maxBytes)
  for (const file of temporaries) await assert.rejects(fsp.lstat(file), { code: 'ENOENT' })
  assert.deepEqual(await fsp.readFile(manifest), originalManifest)
  assert.equal((await fsp.lstat(object)).nlink, 1)
  assert.equal((await fsp.lstat(manifest)).nlink, 1)
  assert.equal((await constrained.verifyRuntime(row.id)).releaseId, row.id)
})

test('temporary cleanup rejects symlinks and unrelated or excess hardlinks without changing their targets', async t => {
  const { repository, cache, build } = await buildFixture(t)
  const row = await build(0)
  const temporary = path.join(cache.directory, 'objects', '.' + randomUUID() + '.tmp')
  const unrelated = path.join(repository, 'unrelated-file')
  await fsp.writeFile(unrelated, 'preserve', { mode: 0o600 })
  await fsp.symlink(unrelated, temporary)
  assert.equal((await cache.capture()).error, 'UNSAFE_ASSET_CACHE_FILE')
  assert.equal(await fsp.readFile(unrelated, 'utf8'), 'preserve')
  await fsp.unlink(temporary)
  await fsp.link(unrelated, temporary)
  assert.equal((await cache.capture()).error, 'UNSAFE_ASSET_CACHE_TEMPORARY')
  assert.ok(await fsp.lstat(temporary))
  await fsp.unlink(temporary)
  const published = path.join(cache.directory, 'objects', row.workerSha)
  await fsp.link(published, temporary)
  const extra = path.join(repository, 'extra-link')
  await fsp.link(published, extra)
  assert.equal((await cache.capture()).error, 'UNSAFE_ASSET_CACHE_TEMPORARY')
  assert.ok(await fsp.lstat(temporary))
  await fsp.unlink(extra)
  assert.equal((await cache.capture()).ok, true)
  await assert.rejects(fsp.lstat(temporary), { code: 'ENOENT' })
  assert.equal((await cache.verifyRuntime(row.id)).releaseId, row.id)
  assert.equal(await fsp.readFile(unrelated, 'utf8'), 'preserve')
})

test('missing historical closures do not block capture, but missing active and explicit pins still do', async t => {
  const { cache, build, select } = await buildFixture(t)
  const historical = await build(0)
  await select(historical.id)
  const active = await build(1)
  await select(active.id)
  const history = path.join(cache.directory, 'runtime-head', 'history')
  const evidence = new Map(await Promise.all((await fsp.readdir(history)).map(async name => [name, await fsp.readFile(path.join(history, name))])))
  const absentManifest = path.join(cache.directory, 'releases', historical.id + '.json')
  await fsp.unlink(absentManifest) // Synthetic prior-installation retention state only.
  const result = await cache.capture()
  assert.equal(result.ok, true, result.error)
  await assert.rejects(fsp.lstat(absentManifest), { code: 'ENOENT' }, 'capture must not resurrect absent historical releases')
  assert.deepEqual((await fsp.readdir(history)).sort(), [...evidence.keys()].sort())
  for (const [name, bytes] of evidence) assert.deepEqual(await fsp.readFile(path.join(history, name)), bytes)
  assert.equal((await cache.verifyRuntime(active.id)).releaseId, active.id)
  await fsp.unlink(path.join(cache.directory, 'releases', active.id + '.json'))
  assert.equal((await cache.capture()).error, 'PINNED_RUNTIME_UNAVAILABLE', 'even the incoming build cannot silently recreate a missing active closure')

  const explicit = await buildFixture(t)
  const pinned = await explicit.build(0)
  await explicit.cache.pinRelease(pinned.id)
  await fsp.unlink(path.join(explicit.cache.directory, 'releases', pinned.id + '.json'))
  assert.equal((await explicit.cache.capture()).error, 'PINNED_RUNTIME_UNAVAILABLE')
})
