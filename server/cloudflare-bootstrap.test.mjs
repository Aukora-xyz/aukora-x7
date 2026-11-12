/** Offline bootstrap integration: real Worker/DOs, synthetic VFS, no sockets or app processes. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { runBootstrapCli } from './cloudflare-bootstrap-cli.mjs'
import { prepareSeedPackage, readSeedPackage, verifySeedPackage, writeSeedPackage } from './seed-cloudflare.mjs'
import { createWorker } from '../deploy/cloudflare/src/worker.mjs'
import { BOOTSTRAP_LIMITS, X61HeadDurableObject, createDurableHeadStore, createMirrorUpdate, readCloudAuraInputs, bootstrapPackage, canonicalBootstrap, validateManifest } from '../deploy/cloudflare/src/head-do.mjs'
import { MIRROR_LIMITS, MirrorDO, bootstrapMirror, handleMirrorRequest, mirrorBootstrapStatus, mirrorDigest, readMirrorAuraInputs, mirrorPathExcluded, validateMirrorPath } from '../deploy/cloudflare/src/mirror-do.mjs'

const ORIGIN = 'https://node.example.invalid'
const ENDPOINT = ORIGIN + '/_bootstrap'
const sha256 = value => createHash('sha256').update(value).digest('hex')
const fingerprint = stat => ['dev', 'ino', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs'].map(key => String(stat[key])).join(':')
const clone = value => structuredClone(value)
const SOURCE_BALLS = fileURLToPath(new URL('../mirror/balls/', import.meta.url))
const PRIVATE_MARKER = 'synthetic-private-bootstrap-test-content'

// This reader never inventories the real mirror or opens home/session/snapshot data.
// Every opened source is bounded, checked through its descriptor and rechecked after capture.
async function captureCode(destination) {
  assert.equal(await fsp.realpath(SOURCE_BALLS), path.resolve(SOURCE_BALLS), 'Source ancestors must not be symlinks')
  const directory = await fsp.lstat(SOURCE_BALLS, { bigint: true })
  const tracked = new Map()
  async function read(name, maximum) {
    const source = path.join(SOURCE_BALLS, name)
    const before = await fsp.lstat(source, { bigint: true })
    assert.ok(before.isFile() && before.nlink === 1n && before.size <= BigInt(maximum), 'Unsafe or oversized bootstrap code source')
    const handle = await fsp.open(source, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
    try {
      assert.equal(fingerprint(await handle.stat({ bigint: true })), fingerprint(before), 'Source changed before open')
      const bytes = Buffer.alloc(Number(before.size) + 1)
      let used = 0
      while (used < bytes.length) {
        const result = await handle.read(bytes, used, bytes.length - used, used)
        if (!result.bytesRead) break
        used += result.bytesRead
      }
      assert.equal(used, Number(before.size), 'Source changed while reading')
      assert.equal(fingerprint(await handle.stat({ bigint: true })), fingerprint(before), 'Source changed while reading')
      assert.equal(fingerprint(await fsp.lstat(source, { bigint: true })), fingerprint(before), 'Source was replaced')
      tracked.set(source, fingerprint(before))
      return bytes.subarray(0, used)
    } finally { await handle.close() }
  }
  const headBytes = await read('HEAD.json', BOOTSTRAP_LIMITS.requestBytes)
  const ball = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(headBytes))
  assert.equal(await validateManifest(ball), null, 'Real HEAD must validate before copying code')
  assert.ok(ball.epoch >= 1)
  const modules = Object.keys(ball.modules).sort()
  assert.ok(modules.length > 0 && modules.length <= BOOTSTRAP_LIMITS.modules)
  const sources = new Map([['HEAD.json', headBytes]])
  let total = headBytes.length
  for (const sha of modules) {
    assert.match(sha, /^[0-9a-f]{64}$/)
    const bytes = await read(sha + '.js', MIRROR_LIMITS.fileBytes)
    assert.equal(sha256(bytes), sha, 'Immutable module hash mismatch')
    total += bytes.length
    assert.ok(total <= BOOTSTRAP_LIMITS.requestBytes, 'Captured code exceeds bootstrap limit')
    sources.set(sha + '.js', bytes)
  }
  for (const [source, expected] of tracked) {
    assert.equal(fingerprint(await fsp.lstat(source, { bigint: true })), expected, 'Source capture was unstable; do not retry silently')
  }
  const currentDirectory = await fsp.lstat(SOURCE_BALLS, { bigint: true })
  assert.ok(currentDirectory.isDirectory() && currentDirectory.dev === directory.dev && currentDirectory.ino === directory.ino, 'Source directory was replaced')
  assert.equal(await fsp.realpath(SOURCE_BALLS), path.resolve(SOURCE_BALLS))
  await fsp.mkdir(destination, { mode: 0o700 })
  for (const [name, bytes] of sources) await fsp.writeFile(path.join(destination, name), bytes, { flag: 'wx', mode: 0o600 })
  return ball
}

async function syntheticFixture(root) {
  const mirrorDir = path.join(root, 'mirror')
  await fsp.mkdir(mirrorDir, { mode: 0o700 })
  const ball = await captureCode(path.join(mirrorDir, 'balls'))
  const files = new Map([
    ['home/auma/snapshots/LATEST.json', '{"pointer":true}\n'],
    ['home/notes.txt', 'Synthetic home note.\n'],
    ['workspace/project/readme.txt', 'Synthetic workspace document.\n'],
    ['workspace/readme.txt', 'Synthetic root document.\n'],
  ])
  const excluded = [
    'home/.env', 'home/.env.local', 'home/.credentials.yaml', 'home/credentials.yaml',
    'home/session.cap', 'home/.afferent-probe', 'home/ed25519-keypair.json',
    'home/.credentials/item', 'home/.ssh/key', 'home/.aws/config', 'home/.transport/item',
    'home/.aukora-test/item', 'home/.DS_Store', 'home/cache/item', 'home/balls/ignored.js',
    'workspace/.git/config', 'workspace/node_modules/package.js', 'workspace/.cache/item',
    'home/auma/snapshots/deadbeef.json', 'home/auma/snapshots/nested/again.json',
  ]
  for (const name of excluded) files.set(name, PRIVATE_MARKER)
  for (const [name, contents] of files) {
    const target = path.join(mirrorDir, name)
    await fsp.mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
    await fsp.writeFile(target, contents, { flag: 'wx', mode: 0o600 })
  }
  const prepared = await prepareSeedPackage({ mirrorDir })
  assert.equal(prepared.package.ball.ballId, ball.ballId)
  const entries = prepared.batches.flat()
  assert.deepEqual(entries.map(([name]) => name), [
    '/dsh/home/auma', '/dsh/home/auma/snapshots', '/dsh/home/auma/snapshots/LATEST.json',
    '/dsh/home/notes.txt', '/dsh/workspace/project',
    '/dsh/workspace/project/readme.txt', '/dsh/workspace/readme.txt',
  ])
  assert.ok(prepared.summary.excludedRootsOrEntries >= excluded.length)
  assert.ok(!JSON.stringify(prepared).includes(Buffer.from(PRIVATE_MARKER).toString('base64')))
  // Keep ordered parent directories explicit while exercising a genuine resume boundary.
  const batches = [entries.slice(0, 3), entries.slice(3)]
  const manifest = await bootstrapPackage({
    version: 'x61-bootstrap/v1', ball: prepared.package.ball, codeBySha: prepared.package.codeBySha,
    mirror: { batchDigests: batches.map(batch => sha256(canonicalBootstrap(batch))), entryCount: entries.length },
  })
  const seed = await verifySeedPackage({ package: manifest, batches })
  const packageDir = path.join(root, 'saved-package')
  await writeSeedPackage({ outDir: packageDir, ...seed })
  return { mirrorDir, packageDir, seed, entries, excluded }
}

// Clone on read/write, serialize transactions and roll back rejected transactions.
// No production Durable Object namespace or persistence adapter is used.
function memoryStorage(initial = []) {
  let rows = new Map(clone(initial))
  let queue = Promise.resolve()
  let writes = 0
  const adapter = map => ({
    get: async key => clone(map.get(key)),
    getAlarm: async () => map.get('fixture:alarm') ?? null,
    setAlarm: async value => { writes++; map.set('fixture:alarm', value) },
    deleteAlarm: async () => { writes++; map.delete('fixture:alarm') },
    put: async (key, value) => { writes++; map.set(key, clone(value)) },
    delete: async key => { writes++; return map.delete(key) },
    list: async ({ prefix = '', limit = Infinity } = {}) => new Map([...map]
      .filter(([key]) => key.startsWith(prefix)).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .slice(0, limit).map(([key, value]) => [key, clone(value)])),
  })
  return {
    get: key => adapter(rows).get(key),
    list: options => adapter(rows).list(options),
    transaction(operation) {
      const pending = queue.then(async () => {
        const staged = clone(rows)
        const result = await operation(adapter(staged))
        rows = staged
        return result
      })
      queue = pending.catch(() => {})
      return pending
    },
    snapshot: () => clone(rows),
    get writes() { return writes },
    idle: () => queue,
  }
}

function host(t, { headRows = [], mirrorRows = [], authorized = true } = {}) {
  const headStorage = memoryStorage(headRows)
  const mirrorStorage = memoryStorage(mirrorRows)
  const calls = []
  let networkCalls = 0
  const env = { PUBLIC_HOST: 'node.example.invalid', ACCESS_TEAM: 'test-team.cloudflareaccess.com', ACCESS_AUD: 'test-audience', OWNER_EMAIL: 'owner@example.invalid' }
  const mirror = new MirrorDO({ storage: mirrorStorage })
  const head = new X61HeadDurableObject({ storage: headStorage, getWebSockets: () => [] }, env)
  for (const [name, object] of [['HEAD', head], ['MIRROR', mirror]]) {
    env[name] = {
      idFromName(value) { assert.equal(value, 'node-main-v1'); return value },
      get(value) { assert.equal(value, 'node-main-v1'); return { fetch(request) { calls.push([name, new URL(request.url).pathname]); return object.fetch(request) } } },
    }
  }
  const worker = createWorker({
    verifyAccess: async request => authorized && request.headers.get('cookie') === 'CF_Authorization=fixture-access-token',
    networkFetch: async () => { networkCalls++; assert.fail('No provider or external network request is permitted') },
  })
  t.after(async () => { await mirror.queue; await headStorage.idle(); await mirrorStorage.idle(); assert.equal(networkCalls, 0) })
  function fetch(input, init = {}) {
    const url = new URL(input, ORIGIN)
    const headers = new Headers({ cookie: 'CF_Authorization=fixture-access-token', origin: ORIGIN, ...init.headers })
    return worker.fetch(new Request(url, { ...init, headers }), env)
  }
  async function request(payload, pathname = '/_bootstrap') {
    const response = await fetch(pathname, payload === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })
    const body = await response.json()
    await response.mirrorCompletion
    return { status: response.status, body }
  }
  return { fetch, request, headStorage, mirrorStorage, calls, worker, env }
}

async function expectError(result, code, status = 409) {
  const response = await result
  assert.equal(response.status, status)
  assert.equal(response.body.ok, false)
  assert.equal(response.body.code, code)
}

const prepare = seed => ({ action: 'prepare', package: seed.package })
const batch = (seed, index) => ({ action: 'batch', seedId: seed.package.seedId, index, entries: seed.batches[index] })
const commit = seed => ({ action: 'commit', seedId: seed.package.seedId })

// Snapshot only the owned fixture, excluding atime changes caused by our own reads.
async function fixtureTree(root) {
  const result = []
  async function visit(relative) {
    const absolute = path.join(root, relative)
    const stat = await fsp.lstat(absolute, { bigint: true })
    assert.ok(stat.isDirectory() || stat.isFile())
    result.push([relative, fingerprint(stat), stat.isFile() ? sha256(await fsp.readFile(absolute)) : null])
    if (stat.isDirectory()) for (const child of (await fsp.readdir(absolute)).sort()) await visit(path.join(relative, child))
    assert.ok(result.length <= 1024, 'Fixture inventory is bounded')
  }
  await visit('')
  return result
}

function paddedBody(size) {
  const whitespace = new Uint8Array(64 * 1024).fill(32)
  let remaining = size
  let first = true
  let cancelled = false
  return {
    stream: new ReadableStream({
      pull(controller) {
        if (first) { first = false; remaining -= 2; controller.enqueue(new TextEncoder().encode('{}')); return }
        if (!remaining) { controller.close(); return }
        const count = Math.min(remaining, whitespace.length)
        remaining -= count
        controller.enqueue(whitespace.subarray(0, count))
      },
      cancel() { cancelled = true },
    }, { highWaterMark: 0 }),
    get cancelled() { return cancelled },
  }
}

const NOW = 1794000000000
const jwt = payload => [
  Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url'),
  Buffer.from(JSON.stringify(payload)).toString('base64url'),
  Buffer.from('synthetic-signature-not-a-credential').toString('base64url'),
].join('.')
const TOKEN = jwt({ exp: Math.floor(NOW / 1000) + 600 })

async function cli(argv, { fetchImpl, token, ...extra } = {}) {
  let stdout = '', stderr = ''
  let stdinReads = 0
  let unexpectedNetworkCalls = 0
  const stdin = new Readable({ read() { stdinReads++; this.push(token === undefined ? null : token); this.push(null) } })
  try {
    const code = await runBootstrapCli(argv, {
      fetchImpl: fetchImpl ?? (async () => { unexpectedNetworkCalls++; throw new Error('Unexpected CLI network request') }),
      stdin, stdout: { write(value) { stdout += value; return true } },
      stderr: { write(value) { stderr += value; return true } }, now: () => NOW, ...extra,
    })
    assert.equal(unexpectedNetworkCalls, 0, 'Invalid or offline CLI invocation attempted network access')
    assert.ok(!stdout.includes(TOKEN) && !stderr.includes(TOKEN), 'Token must not appear in output')
    return { code, stdout, stderr, stdinReads }
  } finally { stdin.destroy() }
}

const uploadArgs = (packageDir, seed) => [
  '--url', ORIGIN, '--package', packageDir, '--confirm-seed-id', seed.package.seedId, '--access-token-stdin',
]

test('Cloudflare bootstrap stays offline, isolated and exact across prepare, batch and commit', { timeout: 120000 }, async t => {
  // Resolve macOS's /var alias before the production no-symlink reader sees it.
  const root = await fsp.mkdtemp(path.join(await fsp.realpath(os.tmpdir()), 'x61-bootstrap-'))
  t.after(async () => { await fsp.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 }) })
  const { mirrorDir, packageDir, seed, entries } = await syntheticFixture(root)

  await t.test('actual HEAD and hashed code prepare without private or transient VFS paths', async () => {
    const restored = await readSeedPackage({ packageDir })
    assert.deepEqual(restored.package, seed.package)
    assert.deepEqual(restored.batches, seed.batches)
    assert.equal(restored.summary.entryCount, entries.length)
    const fresh = await prepareSeedPackage({ mirrorDir })
    assert.deepEqual(fresh.batches.flat(), entries)
    assert.equal(fresh.package.ball.epoch, seed.package.ball.epoch)
    for (const [sha, code] of Object.entries(fresh.package.codeBySha)) assert.equal(sha256(code), sha)
  })

  await t.test('real Worker and DOs stage invisibly, reject invalid batches, resume and commit exactly once', async t => {
    const cloud = host(t)
    assert.equal((await cloud.request(undefined, '/api/health')).body.ready, false)
    assert.equal(cloud.headStorage.writes + cloud.mirrorStorage.writes, 0)
    for (const route of ['/', '/_head/ball', '/api/snapshot', '/door/openai/v1/models']) await expectError(cloud.request(undefined, route), 'BOOTSTRAP_REQUIRED', 503)
    const prepared = await cloud.request(prepare(seed))
    assert.equal(prepared.status, 200)
    assert.equal(prepared.body.phase, 'prepared')
    assert.equal(prepared.body.mirror.nextBatch, 0)
    assert.equal(await cloud.headStorage.get('head'), undefined)
    await expectError(cloud.request(undefined, '/api/snapshot'), 'BOOTSTRAP_REQUIRED', 503)
    await expectError(cloud.request(commit(seed)), 'BOOTSTRAP_BATCHES_INCOMPLETE')
    await expectError(cloud.request({ ...batch(seed, 0), seedId: 'f'.repeat(64) }), 'BOOTSTRAP_SEED_CONFLICT')
    await expectError(cloud.request(batch(seed, 1)), 'BOOTSTRAP_BATCH_SEQUENCE')
    const altered = clone(batch(seed, 0))
    const file = altered.entries.find(([, wire]) => wire.kind === 'file')
    assert.ok(file)
    file[1].b64 = Buffer.from('Changed synthetic data').toString('base64')
    const beforeRejected = cloud.mirrorStorage.snapshot()
    await expectError(cloud.request(altered), 'BOOTSTRAP_BATCH_DIGEST_MISMATCH')
    assert.deepEqual(cloud.mirrorStorage.snapshot(), beforeRejected)
    assert.equal((await cloud.request(batch(seed, 0))).body.nextBatch, 1)
    const beforeReplay = cloud.mirrorStorage.snapshot()
    assert.equal((await cloud.request(batch(seed, 0))).body.idempotent, true)
    assert.deepEqual(cloud.mirrorStorage.snapshot(), beforeReplay)
    assert.equal((await cloud.request(prepare(seed))).body.mirror.nextBatch, 1)
    assert.equal((await cloud.request(batch(seed, 1))).body.nextBatch, 2)
    assert.equal(await cloud.headStorage.get('head'), undefined)
    const completed = await cloud.request(commit(seed))
    assert.equal(completed.status, 200)
    assert.equal(completed.body.phase, 'complete')
    assert.equal(completed.body.mirror.revision, 1)
    assert.equal((await cloud.request(undefined, '/api/health')).body.ready, true)
    const selected = await cloud.request(undefined, '/_head/ball')
    assert.deepEqual(selected.body.ball, seed.package.ball)
    assert.deepEqual(selected.body.codeBySha, seed.package.codeBySha)
    const snapshot = await cloud.request(undefined, '/api/snapshot?snapshotFormat=x61-mirror-snapshot/v2')
    assert.equal(snapshot.body.revision, 1)
    assert.deepEqual(snapshot.body.entries, entries)
    const saved = [cloud.headStorage.snapshot(), cloud.mirrorStorage.snapshot()]
    assert.equal((await cloud.request(commit(seed))).body.head.idempotent, true)
    assert.equal((await cloud.request(prepare(seed))).body.phase, 'complete')
    assert.deepEqual([cloud.headStorage.snapshot(), cloud.mirrorStorage.snapshot()], saved)
  })

  await t.test('occupied HEAD or mirror namespaces cannot be adopted or overwritten', async t => {
    for (const [headRows, mirrorRows, error] of [
      [[['generation', 1]], [], 'HEAD_ALREADY_INITIALIZED'],
      [[], [['orphan-content', { synthetic: true }]], 'MIRROR_ALREADY_INITIALIZED'],
      [[], [['mirror:v2:global-fence', { lineageId: '11111111-1111-1111-1111-111111111111', revision: 1 }]], 'MIRROR_ALREADY_INITIALIZED'],
    ]) {
      const cloud = host(t, { headRows, mirrorRows })
      const before = [cloud.headStorage.snapshot(), cloud.mirrorStorage.snapshot()]
      await expectError(cloud.request(prepare(seed)), error)
      assert.deepEqual([cloud.headStorage.snapshot(), cloud.mirrorStorage.snapshot()], before)
      assert.equal(cloud.headStorage.writes + cloud.mirrorStorage.writes, 0)
    }
    const cloud = host(t)
    await cloud.request(prepare(seed))
    const different = await bootstrapPackage({ ...seed.package, seedId: undefined, mirror: { batchDigests: [], entryCount: 0 } })
    await expectError(cloud.request({ action: 'prepare', package: different }), 'HEAD_ALREADY_INITIALIZED')
  })

  await t.test('host, origin and access failures do not reach either durable binding', async t => {
    const cloud = host(t)
    for (const [url, headers, expected, status] of [
      ['https://other.example.invalid/_bootstrap', {}, 'HOST_REFUSED', 403],
      ['http://node.example.invalid/_bootstrap', {}, 'HOST_REFUSED', 403],
      [ENDPOINT, { origin: 'https://other.example.invalid' }, 'ORIGIN_REFUSED', 403],
      [ENDPOINT, { cookie: '', 'x-x6-internal-authorized': '1' }, 'OWNER_ACCESS_REQUIRED', 401],
      [ENDPOINT, { 'sec-fetch-site': 'cross-site' }, 'CROSS_SITE_REFUSED', 403],
    ]) {
      const response = await cloud.fetch(url, { method: 'POST', headers, body: '{}' })
      await expectError(Promise.resolve({ status: response.status, body: await response.json() }), expected, status)
    }
    assert.deepEqual(cloud.calls, [])
  })

  await t.test('malformed bootstrap bodies and declared sizes fail before storage access', async t => {
    const cloud = host(t)
    for (const [body, headers, code, status] of [
      ['{', {}, 'INVALID_JSON', 400],
      [new Uint8Array([0xff]), {}, 'INVALID_UTF8', 400],
      ['{}', { 'content-length': 'invalid' }, 'INVALID_CONTENT_LENGTH', 400],
      ['{}', { 'content-length': '3' }, 'CONTENT_LENGTH_MISMATCH', 400],
      ['{}', { 'content-encoding': 'gzip' }, 'REQUEST_ENCODING_UNSUPPORTED', 400],
      ['{}', { 'content-length': String(BOOTSTRAP_LIMITS.requestBytes + 1) }, 'REQUEST_BODY_TOO_LARGE', 413],
    ]) {
      const response = await cloud.fetch('/_bootstrap', { method: 'POST', body, headers })
      await expectError(Promise.resolve({ status: response.status, body: await response.json() }), code, status)
    }
    assert.deepEqual(cloud.calls, [])
    assert.equal(cloud.headStorage.writes + cloud.mirrorStorage.writes, 0)
  })

  await t.test('streaming bootstrap accepts 34 MiB and ordinary routes retain their 16 MiB ceiling', async t => {
    assert.equal(BOOTSTRAP_LIMITS.requestBytes, 34 * 1024 * 1024)
    const cloud = host(t)
    for (const [route, size, code, status] of [
      ['/_bootstrap', 34 * 1024 * 1024, 'INVALID_BOOTSTRAP_REQUEST', 400],
      ['/_bootstrap', 34 * 1024 * 1024 + 1, 'REQUEST_BODY_TOO_LARGE', 413],
      ['/_head/lease', 16 * 1024 * 1024, 'BOOTSTRAP_REQUIRED', 503],
      ['/_head/lease', 16 * 1024 * 1024 + 1, 'REQUEST_BODY_TOO_LARGE', 413],
    ]) {
      const source = paddedBody(size)
      const response = await cloud.fetch(route, { method: 'POST', body: source.stream, duplex: 'half' })
      await expectError(Promise.resolve({ status: response.status, body: await response.json() }), code, status)
      if (status === 413) assert.equal(source.cancelled, true)
    }
    assert.equal(cloud.headStorage.writes + cloud.mirrorStorage.writes, 0)
  })

  await t.test('server refuses excluded paths even when an attacker supplies their matching digest', async t => {
    for (const privatePath of ['/dsh/home/.env', '/dsh/workspace/nested/.ssh/key', '/dsh/home/balls/private.js']) {
      const evilEntries = [[privatePath, { kind: 'file', mode: 0o600, mtimeMs: 0, b64: Buffer.from(PRIVATE_MARKER).toString('base64') }]]
      const evil = await bootstrapPackage({ ...seed.package, seedId: undefined, mirror: { batchDigests: [sha256(canonicalBootstrap(evilEntries))], entryCount: 1 } })
      const cloud = host(t)
      assert.equal((await cloud.request({ action: 'prepare', package: evil })).status, 200)
      const before = cloud.mirrorStorage.snapshot()
      await expectError(cloud.request({ action: 'batch', seedId: evil.seedId, index: 0, entries: evilEntries }), 'INVALID_MIRROR_PATH', 400)
      assert.deepEqual(cloud.mirrorStorage.snapshot(), before)
      assert.equal(await cloud.headStorage.get('head'), undefined)
    }
  })

  await t.test('dry-run reads only the fixture and emits content-free identities and sizes without writes or network', async () => {
    for (const args of [['--mirror', mirrorDir], ['--package', packageDir]]) {
      const before = await fixtureTree(root)
      const result = await cli(['--dry-run', ...args])
      assert.equal(result.code, 0, result.stderr)
      assert.equal(result.stderr, '')
      assert.equal(result.stdinReads, 0)
      const output = JSON.parse(result.stdout)
      assert.deepEqual(Object.keys(output).sort(), ['ballId', 'batchCount', 'batches', 'bytes', 'epoch', 'seedId'])
      assert.equal(output.ballId, seed.package.ball.ballId)
      assert.equal(output.epoch, seed.package.ball.epoch)
      assert.ok(output.bytes.prepare > 0 && output.bytes.modules > 0)
      assert.ok(!result.stdout.includes(mirrorDir) && !result.stdout.includes('Synthetic') && !result.stdout.includes(PRIVATE_MARKER))
      assert.deepEqual(await fixtureTree(root), before)
    }
  })

  await t.test('CLI prepare saves a new private package and refuses replacing it', async () => {
    const outDir = path.join(root, 'cli-prepared')
    const result = await cli(['--prepare', '--mirror', mirrorDir, '--out', outDir])
    assert.equal(result.code, 0, result.stderr)
    assert.equal(result.stdinReads, 0)
    assert.equal(JSON.parse(result.stdout).written, true)
    assert.deepEqual((await readSeedPackage({ packageDir: outDir })).batches.flat(), entries)
    assert.equal((await fsp.stat(outDir)).mode & 0o077, 0)
    const before = await fixtureTree(root)
    const duplicate = await cli(['--prepare', '--mirror', mirrorDir, '--out', outDir])
    assert.equal(duplicate.code, 1)
    assert.deepEqual(await fixtureTree(root), before)
  })

  await t.test('source and saved-package symlinks or mutated batches are rejected before authentication', async () => {
    const sourceLink = path.join(root, 'source-link')
    const packageLink = path.join(root, 'package-link')
    await fsp.symlink(mirrorDir, sourceLink, 'dir')
    await fsp.symlink(packageDir, packageLink, 'dir')
    for (const args of [['--dry-run', '--mirror', sourceLink], ['--dry-run', '--package', packageLink]]) {
      const result = await cli(args)
      assert.equal(result.code, 1)
      assert.equal(JSON.parse(result.stderr).code, 'SEED_SYMLINK_REFUSED')
      assert.equal(result.stdinReads, 0)
    }
    await fsp.unlink(sourceLink)
    await fsp.unlink(packageLink)
    const corruptDir = path.join(root, 'corrupt-package')
    await writeSeedPackage({ outDir: corruptDir, ...seed })
    const batchFile = path.join(corruptDir, 'batch-000.json')
    await fsp.unlink(batchFile)
    await fsp.symlink(path.join(packageDir, 'batch-000.json'), batchFile)
    const linked = await cli(uploadArgs(corruptDir, seed), { token: TOKEN })
    assert.equal(linked.code, 1)
    assert.equal(JSON.parse(linked.stderr).code, 'SEED_SYMLINK_REFUSED')
    assert.equal(linked.stdinReads, 0)
    await fsp.unlink(batchFile)
    const mutated = clone(seed.batches[0])
    mutated[0][1].mode ^= 0o100
    await fsp.writeFile(batchFile, JSON.stringify(mutated), { flag: 'wx', mode: 0o600 })
    const changed = await cli(uploadArgs(corruptDir, seed), { token: TOKEN })
    assert.equal(changed.code, 1)
    assert.equal(JSON.parse(changed.stderr).code, 'SEED_BATCH_DIGEST_MISMATCH')
    assert.equal(changed.stdinReads, 0)
  })

  await t.test('CLI refuses invalid host, missing confirmation and invalid authentication without a request', async () => {
    for (const origin of ['http://node.example.invalid', 'https://other.example.invalid', ORIGIN + '/path', ORIGIN + '?query=1', 'https://user@node.example.invalid']) {
      const result = await cli(['--url', origin, '--package', packageDir, '--confirm-seed-id', seed.package.seedId, '--access-token-stdin'], { token: TOKEN + '\n' })
      assert.equal(result.code, 1)
      assert.equal(result.stdout, '')
      assert.equal(result.stdinReads, 0)
    }
    for (const token of ['', 'not-a-token\n', TOKEN + '\n' + TOKEN, jwt({ exp: Math.floor(NOW / 1000) - 1 }), jwt({ exp: Math.floor(NOW / 1000) + 7200, nbf: Math.floor(NOW / 1000) + 1 }), 'x'.repeat(16 * 1024 + 1)]) {
      assert.equal((await cli(uploadArgs(packageDir, seed), { token })).code, 1)
    }
    const missing = uploadArgs(packageDir, seed).filter(value => value !== '--access-token-stdin')
    assert.equal((await cli(missing)).code, 1)
    const wrong = uploadArgs(packageDir, seed)
    wrong[wrong.indexOf('--confirm-seed-id') + 1] = 'f'.repeat(64)
    assert.equal((await cli(wrong, { token: TOKEN })).code, 1)
  })

  await t.test('valid fractional JWT expiry and long remaining sessions reach only the injected transport', async () => {
    for (const expiration of [NOW / 1000 + 0.5, NOW / 1000 + 7200]) {
      let calls = 0
      const token = jwt({ exp: expiration })
      const result = await cli(uploadArgs(packageDir, seed), {
        token: token + '\r\n',
        fetchImpl: async (url, options) => {
          calls++
          assert.equal(url, ENDPOINT)
          assert.equal(new Headers(options.headers).get('cookie'), 'CF_Authorization=' + token)
          return Response.json({ ok: false, code: 'SYNTHETIC_OWNER_REJECTION' }, { status: 401 })
        },
      })
      assert.equal(calls, 1)
      assert.equal(result.code, 1)
      assert.equal(JSON.parse(result.stderr).code, 'SEED_UPLOAD_NOT_ACKNOWLEDGED')
      assert.ok(!result.stdout.includes(token) && !result.stderr.includes(token))
    }
  })

  await t.test('CLI never retries an uncertain batch and resumes the exact saved seed through real Worker receipts', async t => {
    const cloud = host(t)
    const requests = []
    let loseFirstBatch = true
    const fetchImpl = async (url, options) => {
      assert.equal(url, ENDPOINT)
      assert.equal(options.method, 'POST')
      assert.equal(options.redirect, 'error')
      assert.equal(new Headers(options.headers).get('origin'), ORIGIN)
      assert.equal(new Headers(options.headers).get('cookie'), 'CF_Authorization=' + TOKEN)
      const input = JSON.parse(options.body)
      requests.push([input.action, input.index])
      const response = await cloud.fetch(url, { ...options, headers: { ...Object.fromEntries(new Headers(options.headers)), cookie: 'CF_Authorization=fixture-access-token' } })
      if (input.action === 'batch' && input.index === 0 && loseFirstBatch) {
        loseFirstBatch = false
        await response.arrayBuffer()
        throw new Error('Synthetic dropped response after durable acknowledgement')
      }
      return response
    }
    const before = await fixtureTree(root)
    const first = await cli(uploadArgs(packageDir, seed), { fetchImpl, token: TOKEN + '\n' })
    assert.equal(first.code, 1)
    assert.equal(JSON.parse(first.stderr).code, 'SEED_UPLOAD_OUTCOME_UNKNOWN')
    assert.deepEqual(requests, [['prepare', undefined], ['batch', 0]])
    assert.equal(await cloud.headStorage.get('head'), undefined)
    requests.length = 0
    const resumed = await cli(uploadArgs(packageDir, seed), { fetchImpl, token: TOKEN + '\n' })
    assert.equal(resumed.code, 0, resumed.stderr)
    assert.equal(JSON.parse(resumed.stdout).complete, true)
    assert.deepEqual(requests, [['prepare', undefined], ['batch', 1], ['commit', undefined]])
    requests.length = 0
    assert.equal((await cli(uploadArgs(packageDir, seed), { fetchImpl, token: TOKEN + '\n' })).code, 0)
    assert.deepEqual(requests, [['prepare', undefined]])
    assert.deepEqual((await cloud.request(undefined, '/api/snapshot?snapshotFormat=x61-mirror-snapshot/v2')).body.entries, entries)
    assert.deepEqual(await fixtureTree(root), before)
  })

  await t.test('CLI refuses redirects and forged receipts without retries or subsequent uploads', async () => {
    for (const response of [
      () => new Response(null, { status: 302, headers: { location: 'https://other.example.invalid/collect' } }),
      () => Response.json({ ok: true, phase: 'complete', seedId: 'f'.repeat(64) }),
    ]) {
      const calls = []
      const result = await cli(uploadArgs(packageDir, seed), {
        token: TOKEN + '\n',
        fetchImpl: async (url, options) => { calls.push(url); assert.equal(options.redirect, 'error'); return response() },
      })
      assert.equal(result.code, 1)
      assert.equal(result.stdout, '')
      assert.deepEqual(calls, [ENDPOINT])
    }
  })
})

const CONFLICT_BACKUP_PATHS = [
  '/dsh/home/.conflict-backup',
  '/dsh/home/.conflict-backup/journal.bak',
  '/dsh/home/auma/seed/.conflict-backup/journal.bak',
  '/dsh/workspace/.conflict-backup',
  '/dsh/workspace/project/nested/.conflict-backup/journal.bak',
]
const CONFLICT_BACKUP_SIBLINGS = [
  '/dsh/home/.conflict-backups/journal.bak',
  '/dsh/home/auma/seed/.conflict-backup.txt',
  '/dsh/workspace/project/old.conflict-backup/journal.bak',
  '/dsh/workspace/.conflict-backup-copy/journal.bak',
]

test('cloud .conflict-backup exclusion matches whole path segments without changing local update notifications', () => {
  for (const name of CONFLICT_BACKUP_PATHS) {
    assert.equal(mirrorPathExcluded(name), true, name)
    assert.throws(() => validateMirrorPath(name), error => error.code === 'INVALID_MIRROR_PATH')
  }
  for (const name of CONFLICT_BACKUP_SIBLINGS) {
    assert.equal(mirrorPathExcluded(name), false, name)
    assert.equal(validateMirrorPath(name), name)
  }
  const receipt = { clientId: '11111111-1111-4111-8111-111111111111', seq: 1, acknowledgedAt: 1 }
  assert.deepEqual(createMirrorUpdate(receipt, CONFLICT_BACKUP_PATHS).changedPaths, CONFLICT_BACKUP_PATHS)
})

test('offline seed excludes .conflict-backup contents without traversing backup roots or losing similar names', async t => {
  const root = await fsp.mkdtemp(path.join(await fsp.realpath(os.tmpdir()), 'x61-backup-seed-'))
  t.after(() => fsp.rm(root, { recursive: true, force: true }))
  const body = { version: 'x6.1-ball/v1', parentBallId: null, epoch: 1, entries: {}, modules: {} }
  const ball = { ...body, ballId: sha256(canonicalBootstrap(body)) }
  await fsp.mkdir(path.join(root, 'balls'))
  await fsp.writeFile(path.join(root, 'balls/HEAD.json'), JSON.stringify(ball))
  const backups = [
    'home/.conflict-backup/private.bak',
    'home/auma/seed/.conflict-backup/private.bak',
    'workspace/project/nested/.conflict-backup/private.bak',
  ]
  const files = new Map(backups.map(name => [name, PRIVATE_MARKER]))
  for (const name of CONFLICT_BACKUP_SIBLINGS) files.set(name.slice('/dsh/'.length), 'kept synthetic sibling')
  for (const [name, contents] of files) {
    await fsp.mkdir(path.dirname(path.join(root, name)), { recursive: true })
    await fsp.writeFile(path.join(root, name), contents)
  }
  // Traversing either excluded root would fail the seed reader's symlink checks.
  await fsp.symlink(path.join(root, 'missing-backup-target'), path.join(root, 'workspace/.conflict-backup'))
  await fsp.symlink(path.join(root, 'missing-backup-target'), path.join(root, 'home/.conflict-backup/unreadable'))
  const prepared = await prepareSeedPackage({ mirrorDir: root })
  const names = prepared.batches.flat().map(([name]) => name)
  assert.ok(names.every(name => !name.split('/').includes('.conflict-backup')))
  for (const name of CONFLICT_BACKUP_SIBLINGS) assert.ok(names.includes(name), name)
  assert.ok(!JSON.stringify(prepared).includes(PRIVATE_MARKER))
  assert.ok(!JSON.stringify(prepared).includes(Buffer.from(PRIVATE_MARKER).toString('base64')))
  for (const name of backups) assert.equal(await fsp.readFile(path.join(root, name), 'utf8'), PRIVATE_MARKER)
})

test('cloud .conflict-backup bootstrap batches and remote deltas reject matching digests without partial writes', async () => {
  const clientId = '11111111-1111-4111-8111-111111111111'
  const cloudBase = { lineageId: '22222222-2222-4222-8222-222222222222', revision: 0 }
  const file = { kind: 'file', mode: 0o600, mtimeMs: 0, b64: Buffer.from(PRIVATE_MARKER).toString('base64') }
  const storage = memoryStorage([['mirror:v2:global-fence', cloudBase]])
  const before = storage.snapshot()
  for (const name of CONFLICT_BACKUP_PATHS) {
    for (const wire of [file, { kind: 'dir', mode: 0o700 }, { kind: 'gone' }]) {
      const entries = [['/dsh/home/ordinary.txt', file], [name, wire]]
      const batch = { clientId, id: `${clientId}:1`, seq: 1, cloudBase, entries }
      const envelope = { v: 2, batch, digest: await mirrorDigest(batch) }
      const request = new Request(ORIGIN + '/_mirror/delta', { method: 'POST', body: JSON.stringify(envelope) })
      const response = await handleMirrorRequest(request, storage, { authorized: true })
      await expectError({ status: response.status, body: await response.json() }, 'INVALID_MIRROR_PATH', 400)
      assert.deepEqual(storage.snapshot(), before)
      assert.equal(storage.writes, 0)
    }
    const entries = [[name, file]]
    const seedId = 'a'.repeat(64)
    const bootstrapStorage = memoryStorage()
    await bootstrapMirror(bootstrapStorage, { action: 'begin', seedId, ballId: 'b'.repeat(64), epoch: 1,
      mirror: { batchDigests: [sha256(canonicalBootstrap(entries))], entryCount: 1 } })
    const staged = bootstrapStorage.snapshot()
    const writes = bootstrapStorage.writes
    await assert.rejects(bootstrapMirror(bootstrapStorage, { action: 'batch', seedId, index: 0, entries }), error => error.code === 'INVALID_MIRROR_PATH')
    assert.deepEqual(bootstrapStorage.snapshot(), staged)
    assert.equal(bootstrapStorage.writes, writes)
  }
  const entries = CONFLICT_BACKUP_SIBLINGS.map(name => [name, file])
  const batch = { clientId, id: `${clientId}:1`, seq: 1, cloudBase, entries }
  const response = await handleMirrorRequest(new Request(ORIGIN + '/_mirror/delta', {
    method: 'POST', body: JSON.stringify({ v: 2, batch, digest: await mirrorDigest(batch) }),
  }), storage, { authorized: true })
  assert.equal(response.status, 200)
  assert.equal((await response.json()).applied, entries.length)
  const snapshot = await handleMirrorRequest(new Request(ORIGIN + '/api/snapshot?snapshotFormat=x61-mirror-snapshot/v2'), storage, { authorized: true })
  const saved = await snapshot.json()
  await snapshot.mirrorCompletion
  assert.equal(snapshot.status, 200)
  for (const name of CONFLICT_BACKUP_SIBLINGS) assert.ok(saved.entries.some(([path]) => path === name), name)
})

test('persisted cloud .conflict-backup entries and reset paths fail closed without reading or migrating backup bytes', async () => {
  const name = '/dsh/home/auma/seed/.conflict-backup/private.bak'
  const id = await mirrorDigest(name)
  const cloudBase = { lineageId: '22222222-2222-4222-8222-222222222222', revision: 0 }
  for (const row of [
    [`mirror:v2:entry:${id}`, { path: name, kind: 'file', mode: 0o600, mtimeMs: 0, chunks: 1, bytes: 1 }],
    [`mirror:v2:reset:${id}`, name],
  ]) {
    const storage = memoryStorage([['mirror:v2:global-fence', cloudBase], row, [`mirror:v2:chunk:${id}:0`, 'eA==']])
    const before = storage.snapshot()
    const read = storage.get
    storage.get = key => { assert.ok(!key.startsWith('mirror:v2:chunk:'), 'Excluded backup payload must not be read'); return read(key) }
    for (const route of ['/api/snapshot?snapshotFormat=x61-mirror-snapshot/v2', '/_mirror/status']) {
      const response = await handleMirrorRequest(new Request(ORIGIN + route), storage, { authorized: true })
      await expectError({ status: response.status, body: await response.json() }, 'INVALID_MIRROR_PATH', 400)
      assert.deepEqual(storage.snapshot(), before)
      assert.equal(storage.writes, 0)
    }
  }
})

test('seed admission and the mirror DO share file, snapshot, and snapshot-dump limits', async () => {
  assert.equal(MIRROR_LIMITS.fileBytes, 24 * 1024 * 1024)
  assert.equal(MIRROR_LIMITS.snapshotBytes, 96 * 1024 * 1024)
  assert.equal(MIRROR_LIMITS.requestBytes, 34 * 1024 * 1024)
  // The largest admissible file must also fit one request once base64-encoded with its batch envelope.
  const ceilingEncoded = Math.ceil(MIRROR_LIMITS.fileBytes / 3) * 4
  const ceilingEnvelope = Buffer.byteLength(JSON.stringify({
    action: 'batch', seedId: 'f'.repeat(64), index: 255,
    entries: [['/dsh/home/' + 'p'.repeat(4000), { kind: 'file', mode: 0o644, b64: '', mtimeMs: Number.MAX_SAFE_INTEGER }]],
  }))
  assert.ok(ceilingEncoded + ceilingEnvelope <= MIRROR_LIMITS.requestBytes)
  const session = '/dsh/home/sessions/--dsh-home-auma-one--/session-00000000-0000-4000-8000-000000000001/session.v4.jsonl'
  const decoded = 18_000_000
  assert.ok(decoded > 16 * 1024 * 1024)
  assert.ok(decoded <= MIRROR_LIMITS.fileBytes)
  const encoded = Math.ceil(decoded / 3) * 4
  const envelope = Buffer.byteLength(JSON.stringify({
    action: 'batch', seedId: 'f'.repeat(64), index: 255,
    entries: [[session, { kind: 'file', mode: 0o644, b64: '', mtimeMs: 1 }]],
  }))
  assert.ok(encoded + envelope <= MIRROR_LIMITS.requestBytes)
  assert.equal(mirrorPathExcluded('/dsh/home/auma/snapshots/deadbeef.json'), true)
  assert.equal(mirrorPathExcluded('/dsh/home/auma/snapshots/nested/again.json'), true)
  assert.equal(mirrorPathExcluded('/dsh/home/auma/snapshots/LATEST.json'), false)
  assert.equal(mirrorPathExcluded('/dsh/home/auma/snapshots'), false)
  assert.equal(mirrorPathExcluded('/dsh/home/.env'), true)
  assert.equal(validateMirrorPath('/dsh/home/auma/snapshots/LATEST.json'), '/dsh/home/auma/snapshots/LATEST.json')
  assert.throws(() => validateMirrorPath('/dsh/home/auma/snapshots/deadbeef.json'), error => error.code === 'INVALID_MIRROR_PATH')
  const root = await fsp.mkdtemp(path.join(await fsp.realpath(os.tmpdir()), 'x61-seed-limit-'))
  try {
    const mirrorDir = path.join(root, 'mirror')
    await fsp.mkdir(mirrorDir, { recursive: true })
    const ball = await captureCode(path.join(mirrorDir, 'balls'))
    const sessionFile = path.join(mirrorDir, 'home/sessions/--dsh-home-auma-one--/session-00000000-0000-4000-8000-000000000001/session.v4.jsonl')
    await fsp.mkdir(path.dirname(sessionFile), { recursive: true })
    const handle = await fsp.open(sessionFile, 'w', 0o600)
    try { await handle.truncate(16 * 1024 * 1024 + 1) }
    finally { await handle.close() }
    const dump = path.join(mirrorDir, 'home/auma/snapshots/redundant.json')
    await fsp.mkdir(path.dirname(dump), { recursive: true })
    await fsp.writeFile(dump, 'not-seeded')
    await fsp.writeFile(path.join(mirrorDir, 'home/auma/snapshots/LATEST.json'), '{"kept":true}\n')
    const prepared = await prepareSeedPackage({ mirrorDir })
    const names = prepared.batches.flat().map(([name]) => name)
    assert.ok(names.includes(session))
    assert.ok(names.includes('/dsh/home/auma/snapshots/LATEST.json'))
    assert.equal(names.includes('/dsh/home/auma/snapshots/redundant.json'), false)
    assert.equal(prepared.package.ball.ballId, ball.ballId)
  } finally {
    await fsp.rm(root, { recursive: true, force: true })
  }
})


const AURA_FIXTURE_NOW = 1794096000000
const auraCanonicalHash = value => sha256(canonicalBootstrap(value))
const auraPathKey = value => sha256(JSON.stringify(value))

// All evidence below is generated in memory. No source mirror, credentials, keys or personal notes are read.
async function edgeAuraFixture(t, { nested = false } = {}) {
  const headBody = { version: 'x6.1-ball/v1', parentBallId: null, epoch: 12,
    entries: { fixture: { id: 'fixture', specifier: 'fixture:only', disabled: false, config: {}, previousSpecifiers: [] } }, modules: {} }
  const ball = { ...headBody, ballId: auraCanonicalHash(headBody) }
  const nodeBody = { content: 'Synthetic edge Aura memory.', createdAt: AURA_FIXTURE_NOW, parentIds: [] }
  const node = { ...nodeBody, id: auraCanonicalHash(nodeBody) }
  const receiptBody = { schema: 'aukora.receipt.v3', seq: 1, at: new Date(AURA_FIXTURE_NOW).toISOString(),
    prevHash: '0'.repeat(64), kind: 'memory.dag.append', data: { nodeId: node.id, content: node.content } }
  const receipt = { ...receiptBody, leafHash: sha256('\0' + canonicalBootstrap(receiptBody)) }
  const base = '/dsh/home/auma/'
  const files = new Map([
    [base + 'HANDOFF.md', `| epoch | **${ball.epoch}** |\n| ballId | \`${ball.ballId}\` |\n`],
    [base + 'memory/dag/HEAD.json', JSON.stringify({ heads: [node.id], count: 1 })],
    [base + `memory/dag/${nested ? 'nodes/' : ''}${node.id}.json`, JSON.stringify(node)],
    [base + 'seed/receipts.v3.jsonl', JSON.stringify(receipt) + '\n'],
    [base + 'seed/discovery-corpus.v1.jsonl', ''],
    [base + 'superagent/state.json', JSON.stringify({ assignments: [] })],
  ])
  const entries = new Map()
  for (const [name, text] of files) {
    entries.set(name, { kind: 'file', mode: 0o600, mtimeMs: AURA_FIXTURE_NOW, b64: Buffer.from(text).toString('base64') })
    let directory = name.slice(0, name.lastIndexOf('/'))
    while (directory !== '/dsh/home') {
      entries.set(directory, { kind: 'dir', mode: 0o700 })
      directory = directory.slice(0, directory.lastIndexOf('/'))
    }
  }
  const batchEntries = [...entries].sort(([a], [b]) => a < b ? -1 : 1)
  const seed = await bootstrapPackage({ version: 'x61-bootstrap/v1', ball, codeBySha: {},
    mirror: { entryCount: entries.size, batchDigests: [auraCanonicalHash(batchEntries)] } })
  const headStorage = memoryStorage(), mirrorStorage = memoryStorage(), env = {}
  const mirror = new MirrorDO({ storage: mirrorStorage }, env)
  const head = new X61HeadDurableObject({ storage: headStorage, getWebSockets: () => [] }, env)
  env.MIRROR = { idFromName: value => value, get: () => ({ fetch: request => mirror.fetch(request) }) }
  const store = createDurableHeadStore(headStorage)
  await store.bootstrapPrepare(seed)
  await bootstrapMirror(mirrorStorage, { action: 'begin', ...seed, ballId: ball.ballId, epoch: ball.epoch })
  await bootstrapMirror(mirrorStorage, { action: 'batch', seedId: seed.seedId, index: 0, entries: batchEntries })
  await bootstrapMirror(mirrorStorage, { action: 'commit', seedId: seed.seedId })
  assert.equal((await store.bootstrapCommit(seed.seedId, await mirrorBootstrapStatus(mirrorStorage))).phase, 'complete')
  const headers = { 'x-x6-internal-authorized': '1', 'x-x6-bootstrap-seed': seed.seedId,
    'x-x6-aura-head': ball.ballId, 'x-x6-aura-epoch': String(ball.epoch), 'x-x6-aura-now': String(AURA_FIXTURE_NOW) }
  const request = (overrides = {}, pathname = '/_mirror/aura-inputs') => mirror.fetch(new Request('https://x61.internal' + pathname, { headers: { ...headers, ...overrides } }))
  const read = () => readCloudAuraInputs({ storage: headStorage, env, head: ball, now: AURA_FIXTURE_NOW })
  const change = async (relative, text) => mirrorStorage.transaction(async tx => {
    const name = base + relative, id = auraPathKey(name), key = 'mirror:v2:entry:' + id
    const metadata = await tx.get(key)
    assert.ok(metadata)
    if (text === null) { await tx.delete(key); return }
    const b64 = Buffer.from(text).toString('base64')
    await tx.put(key, { ...metadata, bytes: Buffer.byteLength(text), chunks: Math.ceil(b64.length / (96 * 1024)) })
    for (let index = 0; index < Math.ceil(b64.length / (96 * 1024)); index++) await tx.put(`mirror:v2:chunk:${id}:${index}`, b64.slice(index * 96 * 1024, (index + 1) * 96 * 1024))
  })
  t.after(async () => { await head.wakeStore.dispose(); await mirror.queue })
  return { headStorage, mirrorStorage, env, mirror, head, ball, seed, node, receipt, headers, request, read, change }
}

function incompleteEdgeAura(result, code) {
  assert.equal(result.evidence.status, 'incomplete')
  assert.equal(result.auraShadow.status, 'incomplete')
  assert.equal(result.auraShadow.focus, null)
  assert.equal(result.auraShadow.inputEvidence, null)
  assert.equal(result.aura.vector, null)
  assert.equal(result.aura.status, 'incomplete')
  assert.equal(Object.hasOwn(result, 'verifiedReceipts'), false)
  if (code) assert.ok(result.evidence.gaps.includes(code), JSON.stringify(result.evidence))
}

test('edge Aura reads flat and nested synthetic evidence and a real HeadDO wake without a model executor', async t => {
  for (const nested of [false, true]) {
    const fixture = await edgeAuraFixture(t, { nested })
    const before = [fixture.headStorage.writes, fixture.mirrorStorage.writes]
    const result = await fixture.read()
    assert.equal(result.evidence.status, 'complete')
    assert.equal(result.evidence.dagLayout, nested ? 'nodes' : 'flat')
    assert.deepEqual(result.aura.vector, { coherence: 1, surprisePressure: 0, driftRisk: 0, wakeUrgency: 0 })
    assert.equal(result.auraShadow.focus, 'rest')
    assert.equal(result.auraShadow.status, 'complete')
    assert.equal(result.auraShadow.baselineComparison.status, 'agrees')
    assert.equal(result.auraShadow.ballId, fixture.ball.ballId)
    assert.equal(result.auraShadow.epoch, fixture.ball.epoch)
    assert.equal(result.auraShadow.computedAt, AURA_FIXTURE_NOW)
    assert.equal(result.auraShadow.authorityTier, 'peripheral-hint')
    assert.deepEqual([fixture.headStorage.writes, fixture.mirrorStorage.writes], before, 'Evidence reads never mutate storage')
    assert.equal(JSON.stringify(result).includes(fixture.node.content), false)
    assert.equal(JSON.stringify(result).includes(fixture.node.id), false)
    const response = await fixture.head.fetch(new Request('https://x61.internal/_host/wake', {
      method: 'POST', headers: { ...fixture.headers, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'trigger' }),
    }))
    const wake = await response.json()
    assert.equal(response.status, 200)
    assert.equal(wake.receipt.executor.invoked, false)
    assert.equal(wake.receipt.executor.available, false)
    assert.equal(wake.aura.vector.coherence, 1)
    assert.equal(wake.aura.vector.surprisePressure, 0)
    assert.equal(Object.hasOwn(wake.aura, 'auraShadow'), false)
    assert.equal(wake.wakeCount, 1)
    // Status recomputes current evidence, rather than repeating the last persisted wake vector.
    await fixture.change('superagent/state.json', JSON.stringify({ assignments: [{ state: 'running', ticketId: 'fixture-ticket', startedAt: 0 }] }))
    const status = await fixture.head.fetch(new Request('https://x61.internal/api/x61/status', { headers: fixture.headers }))
    const current = await status.json()
    assert.equal(current.aura.status, 'alert')
    assert.equal(current.aura.vector.wakeUrgency, 1)
    assert.equal(current.wake.aura.vector.wakeUrgency, 0)
    assert.equal(current.auraShadow.focus, 'escalate-to-owner')
    assert.equal(current.auraShadow.baselineComparison.status, 'agrees')
    assert.equal(current.auraShadow.computedAt, current.aura.computedAt)
    assert.equal(Object.hasOwn(current.wake, 'auraShadow'), false)
  }
})

test('edge Aura requires internal authorization and a matching completed bootstrap without initializing empty storage', async t => {
  const empty = memoryStorage(), mirror = new MirrorDO({ storage: empty })
  const response = await mirror.fetch(new Request('https://x61.internal/_mirror/aura-inputs', { headers: {
    'x-x6-internal-authorized': '1', 'x-x6-bootstrap-seed': 'a'.repeat(64),
  } }))
  assert.equal(response.status, 503)
  assert.equal(empty.writes, 0)
  const fixture = await edgeAuraFixture(t)
  assert.equal((await fixture.request({ 'x-x6-internal-authorized': '0' })).status, 401)
  assert.equal((await fixture.request({ 'x-x6-bootstrap-seed': 'f'.repeat(64) })).status, 503)
  assert.equal((await fixture.request({}, '/_mirror/aura-inputs?extra=1')).status, 404)
  assert.equal((await fixture.request({ 'x-x6-aura-epoch': '-1' })).status, 400)
  const result = await readMirrorAuraInputs(empty, { seedId: fixture.seed.seedId, head: fixture.ball, now: AURA_FIXTURE_NOW })
  assert.equal(result.evidence.status, 'incomplete')
  assert.equal(empty.writes, 0)
})

test('edge Aura refuses missing, torn, oversized, corrupt and ambiguous evidence instead of healthy counters', async t => {
  const cases = [
    ['missing', fixture => fixture.change('superagent/state.json', null), 'AURA_SOURCE_ABSENT'],
    ['torn', fixture => fixture.change('seed/receipts.v3.jsonl', JSON.stringify(fixture.receipt)), 'AURA_JOURNAL_TRUNCATED'],
    ['hash', fixture => fixture.change('seed/receipts.v3.jsonl', JSON.stringify({ ...fixture.receipt, leafHash: 'f'.repeat(64) }) + '\n'), 'AURA_RECEIPT_HASH_MISMATCH'],
    ['discovery', fixture => fixture.change('seed/discovery-corpus.v1.jsonl', '{}\n'), 'AURA_DISCOVERY_INCOMPLETE'],
    ['heartbeat', fixture => fixture.change('superagent/state.json', JSON.stringify({ assignments: [{ state: 'running' }] })), 'AURA_HEARTBEAT_UNKNOWN'],
    ['oversized', fixture => fixture.mirrorStorage.transaction(async tx => {
      const key = 'mirror:v2:entry:' + auraPathKey('/dsh/home/auma/HANDOFF.md'), value = await tx.get(key)
      await tx.put(key, { ...value, bytes: 64 * 1024 + 1 })
    }), 'AURA_BYTE_LIMIT'],
    ['chunk', fixture => fixture.mirrorStorage.transaction(tx => tx.delete('mirror:v2:chunk:' + auraPathKey('/dsh/home/auma/HANDOFF.md') + ':0')), 'AURA_SOURCE_INVALID'],
    ['ambiguous', fixture => fixture.mirrorStorage.transaction(tx => tx.put('mirror:v2:entry:' + auraPathKey('/dsh/home/auma/memory/dag/nodes'),
      { path: '/dsh/home/auma/memory/dag/nodes', kind: 'dir', mode: 0o700, mtimeMs: AURA_FIXTURE_NOW })), 'AURA_DAG_LAYOUT_AMBIGUOUS'],
  ]
  for (const [name, mutate, code] of cases) await t.test(name, async t => {
    const fixture = await edgeAuraFixture(t)
    await mutate(fixture)
    incompleteEdgeAura(await fixture.read(), code)
  })
})

test('edge Aura rejects changing Mirror revisions and Head identity across bound requests', async t => {
  for (const changeHead of [false, true]) {
    const fixture = await edgeAuraFixture(t)
    let calls = 0
    fixture.env.MIRROR.get = () => ({ fetch: async request => {
      const response = await fixture.mirror.fetch(request)
      if (++calls === 1) {
        if (changeHead) await fixture.headStorage.transaction(tx => tx.put('head', 'e'.repeat(64)))
        else await fixture.mirrorStorage.transaction(async tx => {
          const fence = await tx.get('mirror:v2:global-fence')
          await tx.put('mirror:v2:global-fence', { ...fence, revision: fence.revision + 1 })
        })
      }
      return response
    } })
    incompleteEdgeAura(await fixture.read(), changeHead ? 'AURA_HEAD_CHANGED' : 'AURA_SNAPSHOT_CHANGED')
  }
})

test('edge Aura bounds response bytes, checks returned seed identity and honors cancellation', async t => {
  const fixture = await edgeAuraFixture(t)
  for (const response of [
    Response.json({ ok: true, seedId: 'f'.repeat(64) }),
    new Response(' '.repeat(128 * 1024 + 1)),
    new Response('{}', { headers: { 'content-length': '999999999' } }),
  ]) {
    fixture.env.MIRROR.get = () => ({ fetch: async () => response })
    incompleteEdgeAura(await fixture.read())
  }
  const controller = new AbortController(); controller.abort()
  incompleteEdgeAura(await readCloudAuraInputs({ storage: fixture.headStorage, env: fixture.env,
    head: fixture.ball, now: AURA_FIXTURE_NOW, signal: controller.signal }), 'AURA_ABORTED')
})

test('edge Aura rejects cancellation during the final Head read and a torn transactional fence', async t => {
  const fixture = await edgeAuraFixture(t)
  const controller = new AbortController()
  let transactions = 0
  const storage = { transaction: operation => fixture.headStorage.transaction(tx => {
    const final = ++transactions === 2
    return operation({ ...tx, get: async key => {
      const value = await tx.get(key)
      if (final && key === 'wake:probe-claim:v1') controller.abort()
      return value
    } })
  }) }
  incompleteEdgeAura(await readCloudAuraInputs({ storage, env: fixture.env, head: fixture.ball,
    now: AURA_FIXTURE_NOW, signal: controller.signal }), 'AURA_ABORTED')
  let fenceReads = 0
  const tornStorage = { transaction: operation => fixture.mirrorStorage.transaction(tx => operation({ ...tx,
    get: async key => {
      const value = await tx.get(key)
      return key === 'mirror:v2:global-fence' && ++fenceReads > 1 ? { ...value, revision: value.revision + 1 } : value
    },
  })) }
  const torn = await readMirrorAuraInputs(tornStorage, { seedId: fixture.seed.seedId, head: fixture.ball, now: AURA_FIXTURE_NOW })
  assert.equal(torn.evidence.status, 'incomplete')
  assert.ok(torn.evidence.gaps.includes('AURA_SNAPSHOT_CHANGED'))
  await fixture.headStorage.transaction(async tx => {
    await tx.put('wake:v1', { version: 'x61-wake/v1', seedId: fixture.seed.seedId, enabled: true, intervalMs: 60000,
      lastWakeAt: null, lastWakeOutcome: null, wakeCount: 0, nextWakeAt: AURA_FIXTURE_NOW - 30000, receipts: [],
      consecutiveUnacknowledgedWakes: 0, autoPaused: false })
    await tx.setAlarm(AURA_FIXTURE_NOW - 30000)
  })
  const halfLate = await fixture.read()
  assert.equal(halfLate.evidence.status, 'complete')
  assert.equal(halfLate.overdueWakeRatio, 0.5)
  assert.equal(halfLate.staleHeartbeatRatio, 0.5)
  assert.equal(halfLate.aura.vector.wakeUrgency, 0.5)
  await fixture.headStorage.transaction(tx => tx.deleteAlarm())
  const missingAlarm = await fixture.read()
  assert.equal(missingAlarm.evidence.status, 'complete')
  assert.equal(missingAlarm.overdueWakeRatio, 1)
  assert.equal(missingAlarm.staleHeartbeatRatio, 1)
  assert.equal(missingAlarm.aura.status, 'alert')
})


test('edge receipt verification admits transition kinds and still rejects a changed hash', async t => {
  const fx = await edgeAuraFixture(t)
  const receipts = [fx.receipt]
  for (const kind of ['outward.stage', 'aura.attest', 'scion.compile']) {
    const body = { schema: 'aukora.receipt.v3', seq: receipts.length + 1, at: new Date(AURA_FIXTURE_NOW).toISOString(),
      prevHash: receipts.at(-1).leafHash, kind, data: { ballId: fx.ball.ballId, epoch: fx.ball.epoch } }
    receipts.push({ ...body, leafHash: sha256('\0' + canonicalBootstrap(body)) })
  }
  const filename = 'seed/receipts.v3.jsonl'
  await fx.change(filename, receipts.map(row => JSON.stringify(row)).join('\n') + '\n')
  const response = await fx.request()
  const result = await response.json()
  assert.equal(response.status, 200)
  assert.equal(result.evidence.status, 'complete')
  assert.equal(result.verifiedReceipts, 4)
  assert.equal(result.totalReceipts, 4)
  receipts[2].data.epoch++
  await fx.change(filename, receipts.map(row => JSON.stringify(row)).join('\n') + '\n')
  incompleteEdgeAura(await fx.read(), 'AURA_RECEIPT_HASH_MISMATCH')
})
