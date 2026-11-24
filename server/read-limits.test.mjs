/** Synthetic bounded reads only: no private mirror files, live services, credentials or disk writes. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { CLOUD_BROKER_LIMITS, CLOUD_REPO_READ_LIMITS, handleCloudBroker } from '../deploy/cloudflare/src/cloud-brokers.mjs'
import { MirrorDO, readMirrorRepoFile } from '../deploy/cloudflare/src/mirror-do.mjs'

const LIMIT = 256 * 1024
const NORTHSTAR = '/dsh/workspace/NORTH-STAR.md'
const RETENTION = '/dsh/home/auma/seed/staging/retention-suite.r23.json'
const ORGAN = '/dsh/home/auma/seed/organs/fixture.js'
const ORIGIN = 'https://node.example.invalid'
const SEED = 'a'.repeat(64)
const LINEAGE = '01234567-89ab-cdef-0123-456789abcdef'
const pathKey = path => createHash('sha256').update(JSON.stringify(path)).digest('hex')
const source = readFileSync(new URL('../mirror/home/auma/seed/organs/auma-body-map.js', import.meta.url), 'utf8')
const probe = runInNewContext(source + '\nprobeNorthStar', { require: () => ({}), module: { exports: {} }, Buffer })
const syntheticText = (bytes, unit = 'x') => unit.repeat(bytes / Buffer.byteLength(unit))

function bodyFixture(bytes, descriptor) {
  const events = [], mutations = []
  const fs = {
    statSync: () => ({ isFile: () => true, size: bytes.length }),
    readFileSync: file => { assert.equal(file, NORTHSTAR); events.push('readFile'); return bytes },
    writeFileSync: () => { mutations.push('write'); throw new Error('Read cannot write') },
  }
  if (descriptor) Object.assign(fs, {
    openSync: (file, mode) => { assert.equal(file, NORTHSTAR); assert.equal(mode, 'r'); events.push('open'); return 5 },
    fstatSync: fd => { assert.equal(fd, 5); return fs.statSync() },
    readSync: (fd, buffer, offset, length, position) => {
      assert.equal(fd, 5); assert.equal(buffer.length, 1); assert.equal(offset, 0); assert.equal(length, 1); assert.equal(position, 0)
      events.push('read'); buffer[0] = bytes[0]; return 1
    },
    closeSync: fd => { assert.equal(fd, 5); events.push('close') },
  })
  return { fs, events, mutations, run: () => JSON.parse(JSON.stringify(probe(fs, NORTHSTAR))) }
}

for (const descriptor of [false, true]) for (const size of [70 * 1024, 76 * 1024, LIMIT]) {
  test(`Round27 A: NORTHSTAR ${size} bytes is readable through ${descriptor ? 'descriptor' : 'VFS'} without exposing contents`, () => {
    const f = bodyFixture(Buffer.alloc(size, 120), descriptor)
    assert.deepEqual(f.run(), { path: NORTHSTAR, exists: true, readable: true })
    assert.deepEqual(f.events, descriptor ? ['open', 'read', 'close'] : ['readFile'])
    assert.deepEqual(f.mutations, [])
  })
}

for (const descriptor of [false, true]) test(`Round27 A: NORTHSTAR over 256 KiB is refused before ${descriptor ? 'opening' : 'reading'}`, () => {
  const f = bodyFixture(Buffer.alloc(LIMIT + 1), descriptor)
  assert.equal(f.run().error, 'NORTHSTAR_UNREADABLE')
  assert.deepEqual(f.events, [])
  assert.deepEqual(f.mutations, [])
})

test('Round27 A: changing descriptor size, oversized VFS bytes and read failures remain read-only refusals', () => {
  const opened = bodyFixture(Buffer.from('fixture'), true)
  opened.fs.fstatSync = () => ({ isFile: () => true, size: LIMIT + 1 })
  assert.equal(opened.run().error, 'NORTHSTAR_UNREADABLE')
  assert.deepEqual(opened.events, ['open', 'close'])
  const changed = bodyFixture(Buffer.alloc(LIMIT + 1), false)
  changed.fs.statSync = () => ({ isFile: () => true, size: 70 * 1024 })
  assert.equal(changed.run().error, 'NORTHSTAR_UNREADABLE')
  for (const descriptor of [false, true]) {
    const failed = bodyFixture(Buffer.from('fixture'), descriptor)
    failed.fs[descriptor ? 'readSync' : 'readFileSync'] = () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }) }
    assert.equal(failed.run().error, 'NORTHSTAR_UNREADABLE')
    assert.deepEqual(failed.events, descriptor ? ['open', 'close'] : [])
    assert.deepEqual(failed.mutations, [])
  }
  assert.deepEqual(opened.mutations, [])
  assert.deepEqual(changed.mutations, [])
})

function mirrorFixture(path, content) {
  const rows = new Map([
    ['mirror:bootstrap:v1', { phase: 'ready', seedId: SEED, lineageId: LINEAGE }],
    ['mirror:v2:global-fence', { lineageId: LINEAGE, revision: 1 }],
  ])
  const reads = [], mutations = [], network = []
  if (content !== null) {
    const b64 = Buffer.from(content).toString('base64'), chunks = Math.ceil(b64.length / (96 * 1024))
    rows.set('mirror:v2:entry:' + pathKey(path), { path, kind: 'file', mode: 0o600, mtimeMs: 1, bytes: Buffer.byteLength(content), chunks })
    for (let index = 0; index < chunks; index++) rows.set(`mirror:v2:chunk:${pathKey(path)}:${index}`, b64.slice(index * 96 * 1024, (index + 1) * 96 * 1024))
  }
  const tx = {
    get: async key => { reads.push(key); return structuredClone(rows.get(key)) },
    put: async () => { mutations.push('put'); throw new Error('Read cannot put') },
    delete: async () => { mutations.push('delete'); throw new Error('Read cannot delete') },
    list: async () => { throw new Error('Read cannot inventory namespace') },
  }
  const storage = { transaction: async run => run(tx) }, mirror = new MirrorDO({ storage })
  const env = {
    GITHUB_TOKEN: 'synthetic-read-fixture',
    MIRROR: { idFromName: name => { assert.equal(name, 'node-main-v1'); return name }, get: () => mirror },
  }
  const broker = async (input, { route = 'repo', networkFetch, ...options } = {}) => {
    const request = new Request(`${ORIGIN}/_host/${route}`, { method: 'POST', headers: {
      origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json',
    }, body: JSON.stringify(input) })
    return handleCloudBroker(request, env, {
      bootstrap: { head: { seedId: SEED } },
      networkFetch: async (url, init) => {
        network.push(init.method)
        assert.equal(init.method, 'GET', 'Read-only test must never transmit a mutation')
        if (!networkFetch) throw new Error('Unexpected external read')
        return networkFetch(url, init)
      }, ...options,
    })
  }
  return { rows, reads, mutations, network, env, storage, broker }
}

const repoPath = path => path.startsWith('/dsh/home/') ? 'mirror/' + path.slice('/dsh/'.length) : path.slice('/dsh/workspace/'.length)
const githubFile = (path, content) => Response.json({ type: 'file', path: repoPath(path), encoding: 'base64',
  content: Buffer.from(content).toString('base64').replace(/.{60}/g, '$&\n'), sha: 'b'.repeat(40) })

for (const [path, size, unit] of [[NORTHSTAR, 70 * 1024, 'x'], [RETENTION, 76 * 1024, 'x'], [ORGAN, LIMIT, 'x'], [NORTHSTAR, LIMIT, '\u0001'], [RETENTION, LIMIT, 'é']]) {
  test(`Round27 A: mirror broker reads ${size} UTF-8 bytes at ${path} without storage writes`, async () => {
    const content = syntheticText(size, unit), f = mirrorFixture(path, content)
    const response = await f.broker({ action: 'read', path: repoPath(path) })
    assert.equal(response.status, 200)
    const result = await response.json()
    assert.equal(result.content, content)
    assert.equal(result.source, 'mirror')
    assert.deepEqual(f.mutations, [])
    assert.deepEqual(f.network, [])
  })
}

test('Round27 A: an oversized mirror file fails before chunk reads and never falls back to GitHub', async () => {
  const f = mirrorFixture(RETENTION, syntheticText(LIMIT + 1))
  await assert.rejects(readMirrorRepoFile(f.storage, { path: RETENTION, seedId: SEED }), { code: 'MIRROR_REPO_FILE_TOO_LARGE' })
  const response = await f.broker({ action: 'read', path: repoPath(RETENTION) })
  assert.equal(response.status, 413)
  assert.equal((await response.json()).code, 'REPO_MIRROR_READ_FAILED')
  assert.equal(f.reads.some(key => key.startsWith('mirror:v2:chunk:')), false)
  assert.deepEqual(f.mutations, [])
  assert.deepEqual(f.network, [])
})

for (const route of ['repo', 'github']) for (const unit of ['x', '\u0001']) {
  test(`Round27 A: ${route} file fallback carries a full 256 KiB through base64 and JSON escaping`, async () => {
    const content = syntheticText(LIMIT, unit), f = mirrorFixture(NORTHSTAR, null)
    const input = route === 'repo' ? { action: 'read', path: repoPath(NORTHSTAR) }
      : { action: 'api', endpoint: '/repos/your_org_x/your-node/contents/NORTH-STAR.md?ref=main' }
    const response = await f.broker(input, { route, networkFetch: async () => githubFile(NORTHSTAR, content) })
    assert.equal(response.status, 200)
    const result = await response.json()
    assert.equal(route === 'repo' ? result.content : result.json.content, content)
    if (route === 'github') assert.equal(JSON.parse(result.stdout).content, content)
    assert.deepEqual(f.mutations, [])
    assert.deepEqual(f.network, ['GET'])
  })
}

test('Round27 A: oversized decoded GitHub content is rejected without writes', async () => {
  const f = mirrorFixture(NORTHSTAR, null)
  const response = await f.broker({ action: 'read', path: repoPath(NORTHSTAR) }, { networkFetch: async () => githubFile(NORTHSTAR, syntheticText(LIMIT + 1)) })
  assert.equal(response.status, 502)
  assert.equal((await response.json()).code, 'BROKER_CONTENT_INVALID')
  assert.deepEqual(f.mutations, [])
  assert.deepEqual(f.network, ['GET'])
})

test('Round27 A: base64 response streams retain a finite byte ceiling and cancel overflow', async () => {
  const f = mirrorFixture(NORTHSTAR, null)
  let cancelled = false
  const response = await f.broker({ action: 'read', path: repoPath(NORTHSTAR) }, { networkFetch: async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(CLOUD_REPO_READ_LIMITS.encodedResponseBytes + 1)) },
    cancel() { cancelled = true },
  }), { headers: { 'content-type': 'application/json' } }) })
  assert.equal(response.status, 413)
  assert.equal((await response.json()).code, 'BROKER_BODY_TOO_LARGE')
  assert.equal(cancelled, true)
  assert.deepEqual(f.mutations, [])
  assert.deepEqual(f.network, ['GET'])
})

test('Round27 A: private paths, deleted files and malformed chunks remain refused without writes or fallback', async () => {
  for (const mode of ['private', 'deleted', 'corrupt']) {
    const path = mode === 'private' ? '/dsh/home/auma/secret.txt' : RETENTION
    const f = mirrorFixture(path, mode === 'deleted' ? null : syntheticText(76 * 1024))
    if (mode === 'deleted') f.rows.set('mirror:v2:reset:' + pathKey(path), path)
    if (mode === 'corrupt') f.rows.delete('mirror:v2:chunk:' + pathKey(path) + ':1')
    const response = await f.broker({ action: 'read', path: repoPath(path) })
    assert.equal((await response.json()).ok, false)
    assert.deepEqual(f.mutations, [])
    assert.deepEqual(f.network, [])
  }
})

test('Round27 A: larger read allowance does not enlarge publication or general broker budgets', async () => {
  assert.equal(CLOUD_REPO_READ_LIMITS.fileBytes, LIMIT)
  assert.equal(CLOUD_BROKER_LIMITS.fileBytes, 64 * 1024)
  assert.equal(CLOUD_BROKER_LIMITS.publicationBytes, 128 * 1024)
  assert.equal(CLOUD_BROKER_LIMITS.requestBytes, 256 * 1024)
  assert.equal(CLOUD_BROKER_LIMITS.responseBytes, 256 * 1024)
  const f = mirrorFixture(ORGAN, null)
  let approvals = 0
  const response = await f.broker({ action: 'write', path: repoPath(ORGAN), content: syntheticText(70 * 1024),
    message: 'Synthetic only', expectedHeadSha: 'a'.repeat(40), idempotencyKey: 'fixture-publication-0001',
  }, { authorizeClass3: async () => { approvals++; throw new Error('Oversized publication cannot consume approval') } })
  assert.equal((await response.json()).code, 'BROKER_CONTENT_INVALID')
  assert.equal(approvals, 0)
  assert.deepEqual(f.network, [])
  assert.deepEqual(f.mutations, [])
  const log = await f.broker({ action: 'log' }, { networkFetch: async () => new Response(' '.repeat(CLOUD_BROKER_LIMITS.responseBytes + 1), { headers: { 'content-type': 'application/json' } }) })
  assert.equal((await log.json()).code, 'BROKER_BODY_TOO_LARGE')
  assert.deepEqual(f.network, ['GET'])
})
