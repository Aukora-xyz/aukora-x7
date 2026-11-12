/** Restore from a Continuity recovery snapshot into an empty edge: real Worker, real HeadDO and MirrorDO over in-memory
 * storage, the real client capture code (`recovery-snapshot.ts`), synthetic identities, no network. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { tsImport } from 'tsx/esm/api'
import { createWorker } from '../worker.mjs'
import { X61HeadDurableObject, bootstrapPackage, canonicalBootstrap, digest, manifestId } from '../head-do.mjs'
import { MirrorDO } from '../mirror-do.mjs'
import { recoveryRestoreKit } from '../recovery-restore.mjs'
import { RECOVERY_RESTORE_PAGE, RECOVERY_RESTORE_INTROS, recoveryRestorePageMode } from '../recovery-restore-page.mjs'
import { composeRecoveryRestorePageScript, recoveryRestorePageScriptModule } from '../recovery-restore-page.generate.mjs'
import { applyMirrorEntries } from '../mirror-do.mjs'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { runInNewContext } from 'node:vm'

const { captureRecoverySnapshot } = await tsImport('../../../../packages/client/ui-layout/src/client/spatial/portal/recovery-snapshot.ts', import.meta.url)
const { verifyRecoveryFile } = await tsImport('../../../../packages/client/ui-layout/src/client/spatial/portal/recovery-restore.ts', import.meta.url)
const ORIGIN = 'https://restore-fixture.example.invalid'
const OWNER_EMAIL = 'owner@example.invalid'
const kit = recoveryRestoreKit()
const clone = value => structuredClone(value)
const b64 = text => Buffer.from(text).toString('base64')
const RECEIPTS = '/dsh/home/auma/seed/receipts.v3.jsonl'
const receiptLines = count => Array.from({ length: count }, (_, index) =>
  JSON.stringify({ schema: 'aukora.receipt.v3', seq: index + 1, hash: String(index + 1).padStart(64, 'a') })).join('\n') + '\n'

function memoryStorage() {
  let rows = new Map(), queue = Promise.resolve(), alarmAt = null
  const adapter = (map, alarm) => ({
    get: async key => clone(map.get(key)),
    getAlarm: async () => alarm.value, setAlarm: async value => { alarm.value = Number(value) }, deleteAlarm: async () => { alarm.value = null },
    put: async (key, value) => { assert.ok(Buffer.byteLength(JSON.stringify(value)) <= 128 * 1024, 'DO value exceeds its platform limit'); map.set(key, clone(value)) },
    delete: async key => map.delete(key),
    list: async ({ prefix = '', limit = Infinity } = {}) => new Map([...map].filter(([key]) => key.startsWith(prefix))
      .sort(([a], [b]) => a.localeCompare(b)).slice(0, limit).map(([key, value]) => [key, clone(value)])),
  })
  return {
    get: key => adapter(rows, { value: alarmAt }).get(key), list: options => adapter(rows, { value: alarmAt }).list(options),
    getAlarm: async () => alarmAt, setAlarm: async value => { alarmAt = value }, deleteAlarm: async () => { alarmAt = null },
    transaction(operation) {
      const pending = queue.then(async () => {
        const staged = clone(rows), alarm = { value: alarmAt }
        const result = await operation(adapter(staged, alarm))
        rows = staged; alarmAt = alarm.value
        return result
      })
      queue = pending.catch(() => {})
      return pending
    },
    snapshot: () => clone(rows), idle: () => queue,
  }
}

/** One edge world: its own HEAD and MIRROR storage behind the real Worker. */
function world(t) {
  const headStorage = memoryStorage(), mirrorStorage = memoryStorage()
  const env = { PUBLIC_HOST: new URL(ORIGIN).host, ACCESS_TEAM: 'fixture.cloudflareaccess.com', ACCESS_AUD: 'fixture-audience', OWNER_EMAIL }
  const head = new X61HeadDurableObject({ storage: headStorage, getWebSockets: () => [] }, env, {})
  const mirror = new MirrorDO({ storage: mirrorStorage })
  for (const name of ['HEAD', 'MIRROR']) env[name] = {
    idFromName(value) { assert.equal(value, 'node-main-v1'); return value },
    get() { return { fetch: request => (name === 'HEAD' ? head : mirror).fetch(request) } },
  }
  env.ASSETS = { fetch() { return new Response('Fixture asset') } }
  let network = 0
  const worker = createWorker({
    verifyAccess: async request => request.headers.get('cookie') === 'CF_Authorization=fixture-token'
      ? { type: 'owner', email: OWNER_EMAIL, expires: Math.floor(Date.now() / 1000) + 3600 } : null,
    networkFetch: async () => { network++; throw new Error('External network is forbidden in this fixture') },
  })
  t.after(async () => { await headStorage.idle(); await mirrorStorage.idle(); await mirror.queue; assert.equal(network, 0) })
  const writes = { count: 0 }
  // The page's same-origin fetch, as the browser sends it with the owner's session cookie.
  const fetchImpl = async (url, init = {}) => {
    const target = new URL(url, ORIGIN)
    // A seed write is any /_bootstrap POST but the no-write preflight (storage equality is checked separately).
    if (init.method === 'POST' && target.pathname === '/_bootstrap' && !['preflight', 'preflight-entries'].includes(JSON.parse(init.body).action)) writes.count++
    const headers = new Headers(init.headers ?? {})
    headers.set('cookie', 'CF_Authorization=fixture-token'); headers.set('origin', ORIGIN); headers.set('sec-fetch-site', 'same-origin')
    return worker.fetch(new Request(target, { method: init.method ?? 'GET', headers, signal: init.signal, ...(init.body === undefined ? {} : { body: init.body }) }), env)
  }
  const storageState = () => JSON.stringify([[...headStorage.snapshot()].filter(([key]) => key !== 'gate-lockout:v1'), [...mirrorStorage.snapshot()]])
  return { env, worker, fetchImpl, writes, storageState, headStorage, mirrorStorage }
}

/** Seed a world the way the Mac seeded the live edge: one Pearl at `epoch`, and a home with `receipts` receipts. */
async function seed(edge, { epoch = 169, receipts = 3, note = 'she remembers the fixture', extra = [] } = {}) {
  const code = 'export default { fixture: true }', sha = await digest(code)
  const ball = { version: 'x6.1-ball/v1', parentBallId: 'c'.repeat(64), epoch,
    entries: { 'organ.fixture': { id: 'organ.fixture', specifier: `ball:${sha}`, config: {}, disabled: false, previousSpecifiers: [] } },
    modules: { [sha]: { sha256: sha, specifier: `ball:${sha}` } } }
  ball.ballId = await manifestId(ball)
  const entries = [
    ['/dsh/home/auma', { kind: 'dir', mode: 0o700 }],
    ['/dsh/home/auma/memory', { kind: 'dir', mode: 0o700 }],
    ['/dsh/home/auma/memory/note.md', { kind: 'file', mode: 0o600, mtimeMs: 1700000000000, b64: b64(note) }],
    ['/dsh/home/auma/seed', { kind: 'dir', mode: 0o700 }],
    ['/dsh/home/auma/seed/checkpoints.v1.jsonl', { kind: 'file', mode: 0o600, mtimeMs: 1700000000001, b64: b64('{"checkpoint":1}\n') }],
    [RECEIPTS, { kind: 'file', mode: 0o600, mtimeMs: 1700000000002, b64: b64(receiptLines(receipts)) }],
    ['/dsh/workspace/readme.txt', { kind: 'file', mode: 0o644, mtimeMs: 1700000000003, b64: b64('workspace') }],
    ...extra,
  ].sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))
  const pkg = await bootstrapPackage({ version: 'x61-bootstrap/v1', ball, codeBySha: { [sha]: code },
    mirror: { entryCount: entries.length, batchDigests: [await digest(canonicalBootstrap(entries))] } })
  for (const input of [{ action: 'prepare', package: pkg }, { action: 'batch', seedId: pkg.seedId, index: 0, entries }, { action: 'commit', seedId: pkg.seedId }]) {
    const response = await edge.fetchImpl('/_bootstrap', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) })
    assert.equal(response.status, 200, await response.text())
  }
  edge.writes.count = 0
  return { ball }
}

/** Take the snapshot exactly as the Continuity screen does. */
async function snapshotOf(edge) {
  const capture = await captureRecoverySnapshot(new AbortController().signal, { fetchImpl: edge.fetchImpl, origin: ORIGIN, now: () => 1794000000000 })
  return JSON.parse(capture.json)
}

// Pins: the restore kit's digests for the seed fixture below (see the pinned test).
const PIN_PLAIN_MIRROR = '8dce542b6d4eb83517fffa5bc2198d3d3965005ac562a5e7f76d1432676226f7', PIN_PLAIN_SEED = 'b9507e091ea06f4bec33de7aca37a1295dc22aafdbb1046961812118183b900c', PIN_MARKED_MIRROR = '66f86e1240b14200d8b0c3da538b8e6d720e921eb696bdf1529de3602b55afbb'
const statusEpoch = async edge => (await (await edge.fetchImpl('/__x6/status')).json())?.head?.epoch

test('a snapshot from one world restores into an empty world with the same HEAD epoch and receipt high-water', async t => {
  const source = world(t), { ball } = await seed(source, { epoch: 169, receipts: 5 })
  const snapshot = await snapshotOf(source)
  assert.equal(snapshot.complete, true)
  assert.equal(snapshot.epoch, '169')
  const sourceLive = await kit.liveState(source.fetchImpl, ORIGIN)
  assert.equal(sourceLive.kind, 'live')

  const target = world(t)
  assert.equal((await target.fetchImpl('/__x6/status')).status, 503)
  const preview = await kit.previewRestore({ fetchImpl: target.fetchImpl, origin: ORIGIN, snapshot })
  assert.equal(preview.ok, true, JSON.stringify(preview))
  assert.equal(preview.action, 'restore')
  assert.equal(preview.live.kind, 'empty')
  assert.deepEqual(preview.verified.parts.filter(part => part.ok).map(part => part.route).includes('/_head/ball'), true)
  assert.equal(target.writes.count, 0, 'previewing writes nothing')

  const restored = await kit.applyRestore({ fetchImpl: target.fetchImpl, origin: ORIGIN, preview, confirm: true })
  assert.equal(restored.ok, true, JSON.stringify(restored))
  // Before and after are both shown: empty before; after equals the snapshot and the source world exactly.
  assert.equal(restored.before.kind, 'empty')
  assert.equal(restored.after.head.epoch, 169)
  assert.equal(restored.after.head.ballId, ball.ballId)
  assert.equal(restored.after.statusEpoch, 169)
  assert.equal(restored.after.runtime, 'cloudflare')
  assert.deepEqual(restored.after.highWater, sourceLive.highWater)
  assert.equal(restored.after.mirrorSha256, sourceLive.mirrorSha256)
  assert.equal(restored.after.highWater.receiptCount, 5)
  assert.equal(restored.after.highWater.lastReceiptSeq, 5)
  assert.equal(await statusEpoch(target), await statusEpoch(source))
  // The restored world serves the same Pearl, code and mirror bytes as the source.
  const read = async (edge, path) => (await edge.fetchImpl(path)).json()
  const [sourceBall, targetBall] = [await read(source, '/_head/ball'), await read(target, '/_head/ball')]
  assert.deepEqual(targetBall.head, sourceBall.head)
  assert.deepEqual(targetBall.modules, sourceBall.modules)
  assert.deepEqual((await read(target, '/_mirror/export')).entries, (await read(source, '/_mirror/export')).entries)
  // A snapshot taken now from the restored world verifies, and the edge says it is already current.
  const again = await kit.previewRestore({ fetchImpl: target.fetchImpl, origin: ORIGIN, snapshot: await snapshotOf(target) })
  assert.equal(again.action, 'already-current', JSON.stringify(again))
})

test('an identical live world is reported as already current and nothing is written', async t => {
  const edge = world(t); await seed(edge)
  const snapshot = await snapshotOf(edge), before = edge.storageState()
  const preview = await kit.previewRestore({ fetchImpl: edge.fetchImpl, origin: ORIGIN, snapshot })
  assert.equal(preview.ok, true)
  assert.equal(preview.action, 'already-current')
  assert.deepEqual(preview.live.head, preview.snapshot.ballId && { epoch: 169, ballId: preview.snapshot.ballId })
  assert.equal((await kit.applyRestore({ fetchImpl: edge.fetchImpl, origin: ORIGIN, preview, confirm: true })).code, 'RECOVERY_NOTHING_TO_RESTORE')
  assert.equal(edge.writes.count, 0)
  assert.equal(edge.storageState(), before)
})

for (const route of ['/_head/ball', '/__x6/facts', '/_host/estate', '/_mirror/export']) {
  test(`a part that fails its hash stops the whole restore and is named: ${route}`, async t => {
    const source = world(t); await seed(source)
    const snapshot = await snapshotOf(source)
    const part = snapshot.parts.find(item => item.route === route)
    if (part.ok !== true) {
      // A part the source did not serve is recorded as not captured; claiming bytes for it is tampering too.
      part.sha256 = 'f'.repeat(64); part.bytes = 1
    } else if (route === '/_mirror/export') part.body.entries[2][1].b64 = b64('she remembers something else')
    else if (route === '/_head/ball') part.body.head.epoch = 170
    else part.body = { ...part.body, injected: true }
    const target = world(t), before = target.storageState()
    const preview = await kit.previewRestore({ fetchImpl: target.fetchImpl, origin: ORIGIN, snapshot })
    assert.equal(preview.ok, false)
    assert.equal(preview.code, 'RECOVERY_PART_HASH_MISMATCH')
    assert.equal(preview.part, route)
    assert.equal(target.writes.count, 0)
    assert.equal(target.storageState(), before)
  })
}

test('each file-level refusal writes nothing and says why', async t => {
  const source = world(t); await seed(source)
  const good = await snapshotOf(source)
  const target = world(t), before = target.storageState()
  const cases = [
    ['RECOVERY_SCHEMA_INVALID', snapshot => { snapshot.schema = 'aukora.recovery-snapshot.v0' }],
    ['RECOVERY_PARTS_INVALID', snapshot => { snapshot.parts.reverse() }],
    ['RECOVERY_PARTS_INVALID', snapshot => { snapshot.parts.pop() }],
    // A part re-hashed consistently after editing still fails: the manifest covers every part's digest.
    ['RECOVERY_MANIFEST_MISMATCH', async snapshot => {
      const part = snapshot.parts[0]
      part.body.head.epoch = 170
      const bytes = Buffer.from(JSON.stringify(part.body))
      part.bytes = bytes.length; part.sha256 = (await import('node:crypto')).createHash('sha256').update(bytes).digest('hex')
    }],
    ['RECOVERY_PART_MISSING', snapshot => {
      Object.assign(snapshot.parts[3], { ok: false, status: 503, sha256: null, bytes: null, contentType: null, reason: 'answered 503' })
      delete snapshot.parts[3].body; delete snapshot.parts[3].encoding
    }],
  ]
  for (const [code, mutate] of cases) {
    const snapshot = clone(good)
    await mutate(snapshot)
    const preview = await kit.previewRestore({ fetchImpl: target.fetchImpl, origin: ORIGIN, snapshot })
    assert.equal(preview.code, code)
    if (code === 'RECOVERY_PART_MISSING') assert.equal(preview.part, '/_mirror/export')
  }
  assert.equal(await kit.previewRestore({ fetchImpl: target.fetchImpl, origin: ORIGIN, snapshot: null }).then(result => result.code), 'RECOVERY_SCHEMA_INVALID')
  assert.equal(target.writes.count, 0)
  assert.equal(target.storageState(), before)
})

test('a host that is not the Cloudflare edge is refused before anything is read or written', async t => {
  const source = world(t); await seed(source)
  const snapshot = await snapshotOf(source)
  const seen = []
  const macHost = async url => {
    seen.push(new URL(url, ORIGIN).pathname)
    if (new URL(url, ORIGIN).pathname === '/__x6/status') return Response.json({ ok: true, runtime: 'node', head: { epoch: 169 } })
    if (new URL(url, ORIGIN).pathname === '/api/health') return Response.json({ ok: true, runtime: 'node' })
    return Response.json({ ok: false }, { status: 404 })
  }
  const preview = await kit.previewRestore({ fetchImpl: macHost, origin: ORIGIN, snapshot })
  assert.equal(preview.code, 'RECOVERY_EDGE_REQUIRED')
  assert.deepEqual(seen, ['/__x6/status'])
  // An empty-looking host must also prove it is the edge with no Mac dependency.
  const pretender = async url => new URL(url, ORIGIN).pathname === '/__x6/status'
    ? Response.json({ ok: false, code: 'BOOTSTRAP_REQUIRED' }, { status: 503 })
    : Response.json({ ok: true, runtime: 'cloudflare', macDependency: true })
  assert.equal((await kit.previewRestore({ fetchImpl: pretender, origin: ORIGIN, snapshot })).code, 'RECOVERY_EDGE_REQUIRED')
  // Applying a forged preview against the Mac host is refused too, and posts nothing.
  const forged = { ok: true, action: 'restore', seed: { package: { seedId: 'a'.repeat(64) }, batches: [] } }
  assert.equal((await kit.applyRestore({ fetchImpl: macHost, origin: ORIGIN, preview: forged, confirm: true })).code, 'RECOVERY_EDGE_REQUIRED')
})

test('newer or different live state is never overwritten: the comparison is shown and nothing is written', async t => {
  const old = world(t); await seed(old, { epoch: 169, receipts: 3 })
  const snapshot = await snapshotOf(old)
  const newer = world(t); await seed(newer, { epoch: 170, receipts: 4 })
  const before = newer.storageState()
  const refused = await kit.previewRestore({ fetchImpl: newer.fetchImpl, origin: ORIGIN, snapshot })
  assert.equal(refused.ok, false)
  assert.equal(refused.code, 'RECOVERY_LIVE_NEWER')
  assert.equal(refused.snapshot.epoch, 169)
  assert.equal(refused.live.head.epoch, 170)
  assert.equal(refused.snapshot.highWater.receiptCount, 3)
  assert.equal(refused.live.highWater.receiptCount, 4)
  const different = world(t); await seed(different, { epoch: 169, receipts: 3, note: 'a different memory' })
  const differs = await kit.previewRestore({ fetchImpl: different.fetchImpl, origin: ORIGIN, snapshot })
  assert.equal(differs.code, 'RECOVERY_LIVE_DIFFERS')
  // Even a hand-built "restore" preview cannot write over a live world: the edge is re-read first.
  const empty = world(t)
  const preview = await kit.previewRestore({ fetchImpl: empty.fetchImpl, origin: ORIGIN, snapshot })
  assert.equal(preview.action, 'restore')
  const pushed = await kit.applyRestore({ fetchImpl: newer.fetchImpl, origin: ORIGIN, preview, confirm: true })
  assert.equal(pushed.code, 'RECOVERY_EDGE_CHANGED')
  assert.equal(pushed.live.head.epoch, 170)
  assert.equal(newer.writes.count, 0)
  assert.equal(newer.storageState(), before)
  // And the edge's own seed path refuses an initialized world on its own, whatever a page sends.
  const direct = await newer.fetchImpl('/_bootstrap', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'prepare', package: preview.seed.package }) })
  assert.equal(direct.status, 409)
  assert.equal((await direct.json()).code, 'HEAD_ALREADY_INITIALIZED')
  assert.equal(newer.storageState(), before)
})

test('without explicit confirmation nothing is written', async t => {
  const source = world(t); await seed(source)
  const snapshot = await snapshotOf(source)
  const target = world(t), before = target.storageState()
  const preview = await kit.previewRestore({ fetchImpl: target.fetchImpl, origin: ORIGIN, snapshot })
  for (const confirm of [undefined, false, 'yes', 1]) {
    assert.equal((await kit.applyRestore({ fetchImpl: target.fetchImpl, origin: ORIGIN, preview, confirm })).code, 'RECOVERY_CONFIRMATION_REQUIRED')
  }
  assert.equal(target.writes.count, 0)
  assert.equal(target.storageState(), before)
})

test('an edge partly seeded by another seed is refused; an interrupted restore of the same file resumes', async t => {
  const source = world(t); await seed(source)
  const snapshot = await snapshotOf(source)
  const target = world(t)
  const preview = await kit.previewRestore({ fetchImpl: target.fetchImpl, origin: ORIGIN, snapshot })
  // Interrupt after prepare: the same file resumes to the same result.
  const prepared = await target.fetchImpl('/_bootstrap', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'prepare', package: preview.seed.package }) })
  assert.equal(prepared.status, 200)
  const resumed = await kit.previewRestore({ fetchImpl: target.fetchImpl, origin: ORIGIN, snapshot })
  assert.equal(resumed.action, 'restore')
  assert.equal(resumed.resuming, true)
  const done = await kit.applyRestore({ fetchImpl: target.fetchImpl, origin: ORIGIN, preview: resumed, confirm: true })
  assert.equal(done.ok, true, JSON.stringify(done))
  // A different file against a partly seeded edge is refused.
  const other = world(t); await seed(other, { epoch: 170, receipts: 1 })
  const otherSnapshot = await snapshotOf(other)
  const partial = world(t)
  const firstPreview = await kit.previewRestore({ fetchImpl: partial.fetchImpl, origin: ORIGIN, snapshot })
  await partial.fetchImpl('/_bootstrap', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'prepare', package: firstPreview.seed.package }) })
  const before = partial.storageState()
  assert.equal((await kit.previewRestore({ fetchImpl: partial.fetchImpl, origin: ORIGIN, snapshot: otherSnapshot })).code, 'RECOVERY_EDGE_PARTLY_SEEDED')
  assert.equal(partial.storageState(), before)
})

test('the empty edge serves the owner the restore page; strangers and API calls never get it', async t => {
  const edge = world(t)
  const navigate = headers => edge.worker.fetch(new Request(new URL('/', ORIGIN), { headers: { accept: 'text/html', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', ...headers } }), edge.env)
  const page = await navigate({ cookie: 'CF_Authorization=fixture-token' })
  assert.equal(page.status, 503)
  const html = await page.text()
  assert.match(html, /<title>Restore Auma<\/title>/)
  assert.ok(html.includes(RECOVERY_RESTORE_PAGE.script))
  const csp = page.headers.get('content-security-policy')
  const hash = 'sha256-' + (await import('node:crypto')).createHash('sha256').update(RECOVERY_RESTORE_PAGE.script).digest('base64')
  assert.ok(csp.includes(`script-src '${hash}'`), csp)
  assert.ok(csp.includes("connect-src 'self'"))
  assert.equal(page.headers.get('cache-control'), 'no-store')
  // The page script is the kit itself plus glue, never a fetch to another origin.
  assert.ok(RECOVERY_RESTORE_PAGE.script.includes(recoveryRestoreKit.toString()))
  assert.doesNotMatch(RECOVERY_RESTORE_PAGE.script, /https?:\/\//)
  // No session: the owner sign-in page, not the restore page.
  const stranger = await navigate({})
  assert.equal(stranger.status, 401)
  assert.doesNotMatch(await stranger.text(), /Restore Auma/)
  // An owner API read on the empty edge is still BOOTSTRAP_REQUIRED.
  const api = await edge.fetchImpl('/_head/ball')
  assert.equal(api.status, 503)
  assert.equal((await api.json()).code, 'BOOTSTRAP_REQUIRED')
  // Once seeded, the same navigation reaches the app, not the restore page.
  await seed(edge)
  const app = await navigate({ cookie: 'CF_Authorization=fixture-token' })
  assert.equal(app.status, 200)
  assert.equal(await app.text(), 'Fixture asset')
})

test('the page script runs the kit in a browser-like context without outer names', async () => {
  const { runInNewContext } = await import('node:vm')
  const kitInVm = runInNewContext(`(${recoveryRestoreKit.toString()})()`, { crypto, TextEncoder, TextDecoder, atob, URL })
  const result = await kitInVm.verifySnapshot({ schema: 'aukora.recovery-snapshot.v1', parts: [] })
  assert.equal(result.code, 'RECOVERY_PARTS_INVALID')
})

test('the in-app check and the edge restore judge every file the same way', async t => {
  const source = world(t); await seed(source, { receipts: 4 })
  const good = await snapshotOf(source)
  const variants = [['good', () => {}],
    ['ball tampered', snapshot => { snapshot.parts[0].body.head.epoch = 170 }],
    ['facts tampered', snapshot => { snapshot.parts[1].body = { injected: true } }],
    ['mirror tampered', snapshot => { snapshot.parts[3].body.entries[2][1].b64 = b64('other') }],
    ['manifest', snapshot => { snapshot.manifestSha256 = 'f'.repeat(64) }],
    ['schema', snapshot => { snapshot.schema = 'x' }],
    ['order', snapshot => { snapshot.parts.reverse() }],
    ['mode -1', snapshot => { snapshot.parts[3].body.entries[2][1].mode = -1 }],
    ['impossible time', snapshot => { snapshot.parts[3].body.entries[2][1].mtimeMs = 9e15 }],
    ['mirror missing', snapshot => { Object.assign(snapshot.parts[3], { ok: false, sha256: null, bytes: null, contentType: null, reason: 'x' }); delete snapshot.parts[3].body; delete snapshot.parts[3].encoding }]]
  for (const [name, mutate] of variants) {
    const snapshot = clone(good)
    mutate(snapshot)
    const [edge, app] = [await kit.verifySnapshot(clone(snapshot)), await verifyRecoveryFile(clone(snapshot))]
    assert.equal(app.ok, edge.ok, name)
    if (!edge.ok) { assert.equal(app.code, edge.code, name); assert.equal(app.part, edge.part, name) }
    else {
      assert.equal(app.epoch, edge.epoch); assert.equal(app.ballId, edge.ballId)
      assert.deepEqual(app.highWater, edge.highWater); assert.equal(app.mirrorSha256, edge.mirrorSha256)
    }
  }
})

// ── Regressions ─────────────────────────────────────────────────────────────────────

/** Re-sign a hand-edited snapshot: each JSON part's bytes and SHA-256, then the manifest (as the capture writes them). */
function resign(snapshot) {
  for (const part of snapshot.parts) {
    if (part.ok !== true || part.encoding !== 'json') continue
    const bytes = Buffer.from(JSON.stringify(part.body))
    part.bytes = bytes.length; part.sha256 = createHash('sha256').update(bytes).digest('hex')
  }
  snapshot.manifestSha256 = createHash('sha256').update(JSON.stringify(snapshot.parts.map(part => [part.route, part.sha256, part.bytes]))).digest('hex')
  return snapshot
}
const esbuild = () => createRequire(createRequire(new URL('../../../../package.json', import.meta.url)).resolve('tsx'))('esbuild')

test('BLOCKER 1: the page script survives Wrangler-style bundling (keepNames, and minify) and runs in a browser context', async () => {
  // The hazard is real in this toolchain: a function serialized at runtime from a keepNames bundle carries __name.
  const hazard = await esbuild().build({ stdin: { contents: 'export const text = (function outer() { function inner() {} return inner }).toString()', loader: 'js' },
    bundle: true, format: 'esm', keepNames: true, write: false, logLevel: 'silent' })
  assert.match((await import('data:text/javascript;base64,' + Buffer.from(hazard.outputFiles[0].text).toString('base64'))).text, /__name/)
  for (const minify of [false, true]) {
    const out = await esbuild().build({ entryPoints: [fileURLToPath(new URL('../recovery-restore-page.mjs', import.meta.url))], bundle: true, format: 'esm',
      keepNames: true, minify, write: false, platform: 'neutral', logLevel: 'silent' })
    const bundled = await import('data:text/javascript;base64,' + Buffer.from(out.outputFiles[0].text).toString('base64'))
    const script = bundled.RECOVERY_RESTORE_PAGE.script
    assert.equal(script, RECOVERY_RESTORE_PAGE.script, 'bundling must not change the served script')
    assert.doesNotMatch(script, /__name/)
    assert.ok(bundled.RECOVERY_RESTORE_PAGE.html.includes('<script>' + script + '</script>'))
    // Run the emitted text as the browser would, with only browser globals: no ReferenceError, every control wired.
    const elements = new Map()
    const element = id => ({ id, listeners: {}, files: [], checked: false, disabled: false, textContent: '', firstChild: null,
      addEventListener(type, listener) { this.listeners[type] = listener }, appendChild() {}, removeChild() {} })
    for (const id of ['restore-file', 'restore-check', 'restore-confirm', 'restore-go', 'restore-status', 'restore-detail']) elements.set(id, element(id))
    runInNewContext(script, { document: { getElementById: id => elements.get(id), createElement: () => element('p') }, crypto, TextEncoder, TextDecoder, atob, btoa, URL,
      fetch: async () => { throw new Error('no network in this check') }, location: { origin: ORIGIN } })
    for (const [id, type] of [['restore-check', 'click'], ['restore-go', 'click'], ['restore-file', 'change'], ['restore-confirm', 'change']]) {
      assert.equal(typeof elements.get(id).listeners[type], 'function', `${id} ${type}`)
    }
  }
  // The committed generated module is exactly what the generator makes from today's sources.
  assert.equal(RECOVERY_RESTORE_PAGE.script, composeRecoveryRestorePageScript())
  assert.equal(readFileSync(new URL('../recovery-restore-page.script.mjs', import.meta.url), 'utf8'), recoveryRestorePageScriptModule())
})

test('BLOCKER 2: an exported read-only directory with children restores; live writes into it are still refused', async t => {
  const locked = [['/dsh/home/auma/locked', { kind: 'dir', mode: 0o555 }],
    ['/dsh/home/auma/locked/keep.md', { kind: 'file', mode: 0o444, mtimeMs: 1700000000009, b64: b64('kept as it was') }]]
  const source = world(t); await seed(source, { extra: locked })
  const snapshot = await snapshotOf(source)
  const target = world(t)
  const preview = await kit.previewRestore({ fetchImpl: target.fetchImpl, origin: ORIGIN, snapshot })
  assert.equal(preview.action, 'restore', JSON.stringify(preview))
  const restored = await kit.applyRestore({ fetchImpl: target.fetchImpl, origin: ORIGIN, preview, confirm: true })
  assert.equal(restored.ok, true, JSON.stringify(restored))
  const exported = await (await target.fetchImpl('/_mirror/export')).json()
  assert.deepEqual(exported.entries.find(([path]) => path === '/dsh/home/auma/locked'), locked[0])
  // Only the seed import of a whole inventory may hold children under a read-only directory.
  const current = new Map([['/dsh/home/auma', { kind: 'dir', mode: 0o700 }], ['/dsh/home/auma/locked', { kind: 'dir', mode: 0o555 }]])
  assert.throws(() => applyMirrorEntries(current, [['/dsh/home/auma/locked/new.md', { kind: 'file', mode: 0o600, mtimeMs: 1, b64: b64('x') }]]), { code: 'MIRROR_PARENT_NOT_WRITABLE' })
})

test('BLOCKER 2: whatever the edge would refuse during import is refused before the first durable write', async t => {
  const source = world(t); await seed(source)
  const good = await snapshotOf(source)
  for (const [name, mutate, code, extra] of [
    ['a path the mirror never admits', snapshot => { const entries = snapshot.parts[3].body.entries; entries.splice(1, 0, ['/dsh/home/auma/.env', { kind: 'file', mode: 0o600, mtimeMs: 1, b64: b64('x') }]) },
      'RECOVERY_PREFLIGHT_REFUSED', { edgeCode: 'INVALID_MIRROR_PATH', path: '/dsh/home/auma/.env' }],
    ['a child whose parent directory is not in the file', snapshot => { snapshot.parts[3].body.entries = snapshot.parts[3].body.entries.filter(([path]) => path !== '/dsh/home/auma/memory') },
      'RECOVERY_PREFLIGHT_PARENT_MISSING', { path: '/dsh/home/auma/memory/note.md' }],
    ['a deletion marker the mirror never admits', snapshot => { snapshot.parts[3].body.resetPaths = ['/dsh/home/balls/x'] }, 'RECOVERY_PREFLIGHT_REFUSED', { edgeCode: 'INVALID_MIRROR_PATH' }],
  ]) {
    const snapshot = clone(good); mutate(snapshot); resign(snapshot)
    const target = world(t), before = target.storageState()
    const preview = await kit.previewRestore({ fetchImpl: target.fetchImpl, origin: ORIGIN, snapshot })
    assert.equal(preview.code, code, name + ' ' + JSON.stringify(preview))
    for (const [key, value] of Object.entries(extra)) assert.equal(preview[key], value, name)
    assert.equal(target.writes.count, 0, name)
    assert.equal(target.storageState(), before, name)
  }
})

test('SHOULD-FIX 3: deletion markers are restored and compared; a world without them is not "already current"', async t => {
  const source = world(t); await seed(source)
  const plain = await snapshotOf(source)
  const marked = resign(clone(plain)); marked.parts[3].body.resetPaths = ['/dsh/home/auma/retired', '/dsh/workspace/old']; resign(marked)
  const target = world(t)
  const preview = await kit.previewRestore({ fetchImpl: target.fetchImpl, origin: ORIGIN, snapshot: marked })
  assert.equal(preview.resetCount, 2)
  const restored = await kit.applyRestore({ fetchImpl: target.fetchImpl, origin: ORIGIN, preview, confirm: true })
  assert.equal(restored.ok, true, JSON.stringify(restored))
  assert.deepEqual((await (await target.fetchImpl('/_mirror/export')).json()).resetPaths, ['/dsh/home/auma/retired', '/dsh/workspace/old'])
  assert.equal((await kit.previewRestore({ fetchImpl: target.fetchImpl, origin: ORIGIN, snapshot: marked })).action, 'already-current')
  // The same memory without the markers is a different world.
  assert.equal((await kit.previewRestore({ fetchImpl: target.fetchImpl, origin: ORIGIN, snapshot: plain })).code, 'RECOVERY_LIVE_DIFFERS')
  assert.equal((await kit.previewRestore({ fetchImpl: source.fetchImpl, origin: ORIGIN, snapshot: marked })).code, 'RECOVERY_LIVE_DIFFERS')
})

test('an unexpired passkey cookie on an empty or half-restored edge still gets the sign-in page (the way to the restore page), never a 503 loop', async t => {
  // Not ready is not a busy read: it does not clear by waiting. A navigation must reach the sign-in page, whose "Another
  // way to sign in" (owner pass) is the only way to the restore page. Same-browser cookie from before the edge emptied.
  const passkeyOnly = `__Host-x61-owner=${'A'.repeat(43)}.${String(Date.now() + 3600000)}.1.${'0'.repeat(64)}`
  const navigate = edge => edge.worker.fetch(new Request(new URL('/', ORIGIN), { headers: { accept: 'text/html', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document',
    cookie: passkeyOnly } }), edge.env)
  const source = world(t); await seed(source)
  const snapshot = await snapshotOf(source)
  const partial = world(t)
  const preview = await kit.previewRestore({ fetchImpl: partial.fetchImpl, origin: ORIGIN, snapshot })
  await partial.fetchImpl('/_bootstrap', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'prepare', package: preview.seed.package }) })
  for (const [name, edge] of [['empty', world(t)], ['resumable', partial]]) {
    for (let reload = 0; reload < 2; reload++) {
      const page = await navigate(edge)
      assert.equal(page.status, 401, `${name} reload ${reload}`)
      assert.equal(page.headers.get('set-cookie'), null)
      const html = await page.text()
      assert.ok(html.includes('id="passkey-submit"'), name)
      assert.ok(html.includes('id="owner-signin"') && html.includes('id="owner-token"'), name)
      assert.doesNotMatch(html, /Restore Auma|OWNER_SESSION_UNAVAILABLE/)
    }
    // An API call with that cookie alone is still the short "try again" (the app retries; it is never told "signed out").
    const api = await edge.worker.fetch(new Request(new URL('/_head/ball', ORIGIN), { headers: { cookie: passkeyOnly } }), edge.env)
    assert.equal(api.status, 503, name)
    assert.deepEqual(await api.json(), { ok: false, code: 'OWNER_SESSION_UNAVAILABLE' })
    assert.equal(api.headers.get('set-cookie'), null)
    // The owner pass that page swaps for CF_Authorization reaches the restore page on the next navigation.
    const restore = await edge.worker.fetch(new Request(new URL('/', ORIGIN), { headers: { accept: 'text/html', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document',
      cookie: 'CF_Authorization=fixture-token' } }), edge.env)
    assert.equal(restore.status, 503)
    assert.ok((await restore.text()).includes(RECOVERY_RESTORE_INTROS[name]), name)
  }
})

test('SHOULD-FIX 4: the restore page only on a truly empty edge or an unfinished restore, and it says which', async t => {
  const navigate = edge => edge.worker.fetch(new Request(new URL('/', ORIGIN), { headers: { accept: 'text/html', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document',
    cookie: 'CF_Authorization=fixture-token' } }), edge.env)
  // An established (occupied, unseeded) mirror: never the page, never a claim that nothing exists.
  const occupied = world(t)
  await occupied.mirrorStorage.transaction(tx => tx.put('mirror:v2:entry:stray', { path: '/dsh/home/stray', kind: 'dir', mode: 0o700 }))
  const refused = await navigate(occupied)
  assert.equal(refused.status, 503)
  assert.equal((await refused.json()).code, 'BOOTSTRAP_REQUIRED')
  const source = world(t); await seed(source)
  const snapshot = await snapshotOf(source)
  assert.equal((await kit.previewRestore({ fetchImpl: occupied.fetchImpl, origin: ORIGIN, snapshot })).code, 'RECOVERY_EDGE_NOT_EMPTY')
  // An unfinished restore of a file: the page says so.
  const partial = world(t)
  const preview = await kit.previewRestore({ fetchImpl: partial.fetchImpl, origin: ORIGIN, snapshot })
  await partial.fetchImpl('/_bootstrap', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'prepare', package: preview.seed.package }) })
  const resumable = await navigate(partial)
  assert.equal(resumable.status, 503)
  const html = await resumable.text()
  assert.ok(html.includes(RECOVERY_RESTORE_INTROS.resumable))
  assert.ok(!html.includes(RECOVERY_RESTORE_INTROS.empty))
  const empty = await navigate(world(t))
  assert.ok((await empty.text()).includes(RECOVERY_RESTORE_INTROS.empty))
  for (const [bootstrap, mode] of [
    [{ ready: false, head: { phase: 'empty' }, mirror: { phase: 'empty' } }, 'empty'],
    [{ ready: false, head: { phase: 'prepared', seedId: 'a' }, mirror: { phase: 'receiving', seedId: 'a' } }, 'resumable'],
    [{ ready: false, head: { phase: 'prepared', seedId: 'a' }, mirror: { phase: 'empty' } }, 'resumable'],
    [{ ready: false, head: { phase: 'prepared', seedId: 'a' }, mirror: { phase: 'receiving', seedId: 'b' } }, null],
    [{ ready: false, head: { phase: 'established' }, mirror: { phase: 'empty' } }, null],
    [{ ready: false, head: { phase: 'empty' }, mirror: { phase: 'established' } }, null],
    [{ ready: false, head: { phase: 'complete', seedId: 'a' }, mirror: { phase: 'receiving', seedId: 'a' } }, null],
    [{ ready: true, head: { phase: 'complete' }, mirror: { phase: 'ready' } }, null],
  ]) assert.equal(recoveryRestorePageMode(bootstrap), mode, JSON.stringify(bootstrap))
})

// ── Regressions ───────────────────────────────────────────────────────────────────

test('S1 BLOCKER 1: a thousand deletion markers restore (one bounded row each); too many bytes of markers are refused before any write', async t => {
  const source = world(t); await seed(source)
  const snapshot = clone(await snapshotOf(source))
  const markers = Array.from({ length: 1000 }, (_, index) => `/dsh/home/auma/retired/${String(index).padStart(4, '0')}-${'m'.repeat(120)}`)
  snapshot.parts[3].body.resetPaths = markers; resign(snapshot)
  assert.ok(Buffer.byteLength(JSON.stringify(markers)) > 120 * 1024, 'more than one storage value could hold')
  const target = world(t)
  const preview = await kit.previewRestore({ fetchImpl: target.fetchImpl, origin: ORIGIN, snapshot })
  assert.equal(preview.action, 'restore', JSON.stringify(preview).slice(0, 300))
  const restored = await kit.applyRestore({ fetchImpl: target.fetchImpl, origin: ORIGIN, preview, confirm: true })
  assert.equal(restored.ok, true, JSON.stringify(restored).slice(0, 300))
  assert.deepEqual((await (await target.fetchImpl('/_mirror/export')).json()).resetPaths, markers)
  // Over the metadata bound: refused by the local preflight, nothing sent, nothing stored.
  const huge = clone(await snapshotOf(source))
  huge.parts[3].body.resetPaths = Array.from({ length: 2400 }, (_, index) => `/dsh/home/auma/old/${String(index).padStart(5, '0')}/${Array.from({ length: 15 }, () => 'p'.repeat(250)).join('/')}`)
  resign(huge)
  assert.ok(Buffer.byteLength(JSON.stringify(huge.parts[3].body.resetPaths)) > 8 * 1024 * 1024)
  const empty = world(t), before = empty.storageState()
  const refused = await kit.previewRestore({ fetchImpl: empty.fetchImpl, origin: ORIGIN, snapshot: huge })
  assert.equal(refused.code, 'RECOVERY_PREFLIGHT_MIRROR_LIMIT')
  assert.equal(empty.writes.count, 0)
  assert.equal(empty.storageState(), before)
})

test('S1 BLOCKER 2: batches are sized by the UTF-8 bytes of the whole request; an oversized request is refused before any write', async t => {
  // Multi-byte paths: their character count understates their bytes almost threefold.
  const unicode = [['/dsh/home/auma/記憶', { kind: 'dir', mode: 0o700 }], ...Array.from({ length: 200 }, (_, index) =>
    [`/dsh/home/auma/記憶/${String(index).padStart(3, '0')}-${'記'.repeat(80)}.md`, { kind: 'file', mode: 0o600, mtimeMs: 1, b64: b64('記'.repeat(40)) }])]
  const source = world(t); await seed(source, { extra: unicode })
  const snapshot = await snapshotOf(source)
  const requestBytes = 16 * 1024
  const small = recoveryRestoreKit({ requestBytes })
  const target = world(t)
  const preview = await small.previewRestore({ fetchImpl: target.fetchImpl, origin: ORIGIN, snapshot })
  assert.equal(preview.action, 'restore', JSON.stringify(preview).slice(0, 300))
  assert.ok(preview.batchCount > 1)
  for (const [index, entries] of preview.seed.batches.entries()) {
    const envelope = JSON.stringify({ action: 'batch', seedId: preview.seed.package.seedId, index, entries })
    assert.ok(Buffer.byteLength(envelope) <= requestBytes, `batch ${String(index)}: ${String(Buffer.byteLength(envelope))} bytes`)
  }
  // The character-counting cut would have overrun: some batch holds more characters' worth of bytes than characters.
  assert.ok(preview.seed.batches.some(entries => Buffer.byteLength(JSON.stringify(entries)) > 1.5 * JSON.stringify(entries).length))
  assert.equal((await small.applyRestore({ fetchImpl: target.fetchImpl, origin: ORIGIN, preview, confirm: true })).ok, true)
  // One entry larger than a whole request: refused by the local preflight, nothing sent.
  const tiny = recoveryRestoreKit({ requestBytes: 600 })
  const empty = world(t), before = empty.storageState()
  const refused = await tiny.previewRestore({ fetchImpl: empty.fetchImpl, origin: ORIGIN, snapshot })
  assert.equal(refused.code, 'RECOVERY_PREFLIGHT_REQUEST_TOO_LARGE')
  assert.equal(empty.writes.count, 0)
  assert.equal(empty.storageState(), before)
})

test('F1 #4: an entry the import would refuse (mode -1, mode 0o1000, an impossible time) is refused before any write', async t => {
  const source = world(t); await seed(source)
  const good = await snapshotOf(source)
  for (const [name, bend] of [['mode -1', wire => { wire.mode = -1 }], ['mode 0o1000', wire => { wire.mode = 0o1000 }],
    ['time past the end of dates', wire => { wire.mtimeMs = 9e15 }], ['negative time', wire => { wire.mtimeMs = -1 }]]) {
    const snapshot = clone(good)
    bend(snapshot.parts[3].body.entries.find(([path]) => path === '/dsh/home/auma/memory/note.md')[1]); resign(snapshot)
    const target = world(t), before = target.storageState()
    const preview = await kit.previewRestore({ fetchImpl: target.fetchImpl, origin: ORIGIN, snapshot })
    assert.equal(preview.ok, false, name)
    assert.equal(target.writes.count, 0, name)
    assert.equal(target.storageState(), before, name)
  }
  // The edge's own no-write check applies the import's rules to each entry and names it, whatever a page sends.
  const target = world(t), before = target.storageState()
  for (const [meta, code] of [[{ kind: 'file', mode: -1, mtimeMs: 1, b64Length: 0 }, 'INVALID_MIRROR_MODE'], [{ kind: 'dir', mode: 0o1000 }, 'INVALID_MIRROR_MODE'],
    [{ kind: 'file', mode: 0o600, mtimeMs: 9e15, b64Length: 0 }, 'INVALID_MIRROR_FILE'], [{ kind: 'gone' }, 'INVALID_MIRROR_ENTRY'], [{ kind: 'file', mode: 0o600, mtimeMs: 1, b64Length: 0, b64: 'x' }, 'INVALID_MIRROR_ENTRY'],
    [{ kind: 'file', mode: 0o600, mtimeMs: 1, b64Length: 3 }, 'INVALID_MIRROR_ENTRY']]) {
    const answer = await target.fetchImpl('/_bootstrap', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'preflight-entries', after: '', bytes: 0, count: 0, entries: [['/dsh/home/auma/x', meta]] }) })
    assert.equal(answer.status, 400, JSON.stringify(meta))
    assert.deepEqual(await answer.json(), { ok: false, code, path: '/dsh/home/auma/x' })
  }
  assert.equal(target.storageState(), before)
})

test('G2 #2: the export a restore would make is counted with the mirror\'s own accounting; over 96 MiB is refused with zero writes', async t => {
  const source = world(t); await seed(source)
  // Parity: the preflight's total equals the byte length of the export the restored edge then serves.
  const snapshot = await snapshotOf(source)
  const target = world(t)
  const seen = []
  const watching = async (url, init = {}) => {
    const response = await target.fetchImpl(url, init)
    if (init.method === 'POST' && JSON.parse(init.body).action === 'preflight-entries') seen.push((await response.clone().json()).bytes)
    return response
  }
  const preview = await kit.previewRestore({ fetchImpl: watching, origin: ORIGIN, snapshot })
  assert.equal(preview.action, 'restore')
  assert.equal((await kit.applyRestore({ fetchImpl: target.fetchImpl, origin: ORIGIN, preview, confirm: true })).ok, true)
  const exported = await (await target.fetchImpl('/_mirror/export')).text()
  assert.equal(seen.at(-1), Buffer.byteLength(exported), 'the preflight counts exactly what the mirror serves')
  // Probe: four files of 18 MiB each (base64 just over the 96 MiB export limit together) in a hash-consistent file.
  const big = snapshot // no longer needed as it was: reused, not copied, to keep this test's memory down
  const filler = 'A'.repeat(Math.ceil(18 * 1024 * 1024 / 3) * 4)
  big.parts[3].body.entries.push(['/dsh/workspace/big', { kind: 'dir', mode: 0o755 }],
    ...[1, 2, 3, 4].map(index => [`/dsh/workspace/big/${String(index)}.bin`, { kind: 'file', mode: 0o644, mtimeMs: 1, b64: filler }]))
  big.parts[3].body.entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  resign(big)
  const empty = world(t), before = empty.storageState()
  const refused = await kit.previewRestore({ fetchImpl: empty.fetchImpl, origin: ORIGIN, snapshot: big })
  assert.equal(refused.code, 'RECOVERY_PREFLIGHT_REFUSED', JSON.stringify(refused).slice(0, 300))
  assert.equal(refused.edgeCode, 'MIRROR_SNAPSHOT_TOO_LARGE')
  assert.equal(empty.writes.count, 0)
  assert.equal(empty.storageState(), before)
  assert.equal((await empty.fetchImpl('/_bootstrap').then(response => response.json())).head.phase, 'empty')
})

test('H2 #2: a check for a file no longer selected is thrown away; the page restores only what is selected now', async t => {
  const source = world(t); await seed(source)
  const oldText = JSON.stringify(await snapshotOf(source))
  const target = world(t), before = target.storageState()
  const elements = new Map()
  const element = id => ({ id, listeners: {}, files: [], checked: false, disabled: false, textContent: '', firstChild: null,
    addEventListener(type, listener) { this.listeners[type] = listener }, appendChild() {}, removeChild() {} })
  for (const id of ['restore-file', 'restore-check', 'restore-confirm', 'restore-go', 'restore-status', 'restore-detail']) elements.set(id, element(id))
  runInNewContext(RECOVERY_RESTORE_PAGE.script, { document: { getElementById: id => elements.get(id), createElement: () => element('p') }, crypto, TextEncoder, TextDecoder,
    atob, btoa, URL, fetch: (url, init) => target.fetchImpl(url, init), location: { origin: ORIGIN } })
  const input = elements.get('restore-file'), check = elements.get('restore-check'), confirm = elements.get('restore-confirm'), go = elements.get('restore-go')
  const status = elements.get('restore-status')
  let release
  const oldFile = { name: 'old.json', size: oldText.length, text: () => new Promise(resolve => { release = () => resolve(oldText) }) }
  const newFile = { name: 'new.json', size: 2, text: async () => '{}' }
  input.files = [oldFile]; input.listeners.change()
  const checking = check.listeners.click()
  assert.equal(input.disabled, true, 'the file cannot be changed while it is checked')
  // Probe: the selection changes during the outstanding check, then the old check finishes.
  input.files = [newFile]; input.listeners.change()
  release()
  await checking
  assert.doesNotMatch(status.textContent, /Every part verified/)
  confirm.checked = true; confirm.listeners.change()
  assert.equal(go.disabled, true, 'no preview of old.json survives')
  await go.listeners.click()
  assert.equal(target.writes.count, 0)
  assert.equal(target.storageState(), before)
  // The file selected now is checked on its own merits.
  await check.listeners.click()
  assert.match(status.textContent, /^Refused: RECOVERY_SCHEMA_INVALID/)
  assert.equal(go.disabled, true)
  assert.equal(input.disabled, false)
})

const restorePolicyOf = page => {
  const hash = text => `'sha256-${createHash('sha256').update(text).digest('base64')}'`
  return `default-src 'none'; base-uri 'none'; object-src 'none'; script-src ${hash(page.script)}; style-src ${hash(page.style)}; connect-src 'self'; form-action 'none'; frame-ancestors 'none'`
}

test('S3: two concurrent first requests for the restore page both carry its exact CSP', async () => {
  // A fresh copy of the page module: nothing has computed its policy yet.
  const fresh = await import('../recovery-restore-page.mjs?first-restore-page-concurrent')
  const pages = await Promise.all([fresh.recoveryRestorePageResponse('empty'), fresh.recoveryRestorePageResponse('resumable')])
  for (const page of pages) {
    assert.equal(page.status, 503)
    assert.equal(page.headers.get('content-security-policy'), restorePolicyOf(fresh.RECOVERY_RESTORE_PAGE))
  }
  assert.equal((await fresh.recoveryRestorePageResponse()).headers.get('content-security-policy'), restorePolicyOf(RECOVERY_RESTORE_PAGE))
})

test('S3: a first restore page request whose hashing never finishes does not hang the next one', async t => {
  const fresh = await import('../recovery-restore-page.mjs?first-restore-page-abandoned')
  const digestBytes = crypto.subtle.digest.bind(crypto.subtle)
  let hang = true, hung = 0
  t.mock.method(crypto.subtle, 'digest', (...args) => hang ? (hung++, new Promise(() => {})) : digestBytes(...args))
  const pending = Symbol('pending')
  const within = (promise, ms) => { let timer; return Promise.race([promise, new Promise(resolve => { timer = setTimeout(() => resolve(pending), ms) })]).finally(() => clearTimeout(timer)) }
  const abandoned = fresh.recoveryRestorePageResponse()
  await new Promise(resolve => setImmediate(resolve))
  assert.ok(hung > 0)
  hang = false
  const page = await within(fresh.recoveryRestorePageResponse(), 3000)
  assert.notEqual(page, pending, 'the next request waits on the abandoned request\'s policy')
  assert.equal(page.headers.get('content-security-policy'), restorePolicyOf(fresh.RECOVERY_RESTORE_PAGE))
  assert.equal(await within(abandoned, 0), pending)
})

// ── the secret-shaped rule on restore and in the in-app check ─────────────────────────────────────────

/** Every copy of the rule, beside the edge's own (mirror-do.mjs): a part battery built from all their lists together. */
async function secretRuleCopies() {
  const edge = await import('../mirror-do.mjs'), leaf = await import('../mirror-secret-paths.mjs')
  const app = await tsImport('../../../../packages/client/ui-layout/src/client/spatial/portal/recovery-restore.ts', import.meta.url)
  const lists = [[edge.MIRROR_SECRET_NAMES, edge.MIRROR_SECRET_PREFIXES], [kit.SECRET_NAMES, kit.SECRET_PREFIXES],
    [app.RECOVERY_SECRET_NAMES, app.RECOVERY_SECRET_PREFIXES], [leaf.MIRROR_SECRET_NAMES, leaf.MIRROR_SECRET_PREFIXES]]
  const names = [...new Set(lists.flat(2))]
  // Job 4: the shared rule table (the review's paths and atomic-write's real shapes) is in the battery too.
  const table = JSON.parse(readFileSync(new URL('./secret-path-rule-table.json', import.meta.url), 'utf8'))
  const battery = [...names.flatMap(name => [name, `${name}.3fa9.tmp`, `${name}.3fa9c1.tmp`, `.${name}~`, `${name}~`, `${name}-x`, `${name}_bak`,
    `${name}-notes.md`, `.${name}.swp`, `${name}x`, `x${name}`, `.${name}`, `..${name}`, `${name}.`, name.slice(0, -1), name.toUpperCase()]),
    ...table.shaped, ...table.ordinary, 'pepper.v10', 'session.capture', 'HANDOFF.md', 'credentials.md', '.e', '.aukora', '']
  for (const [suffix, copy] of [[kit.SECRET_SUFFIX, 'restore kit'], [app.RECOVERY_SECRET_SUFFIX, 'in-app check'], [leaf.MIRROR_SECRET_SUFFIX, 'leaf module']]) {
    assert.equal(String(suffix), String(edge.MIRROR_SECRET_SUFFIX), copy)
  }
  return { edge, lists, battery, copies: [['restore kit', kit.secretShapedPart], ['in-app check', app.secretShapedPart], ['leaf module', leaf.secretShapedPart]] }
}

test('the restore kit, the in-app check and the leaf module carry exactly the edge\'s secret-shaped rule', async () => {
  const { edge, lists, battery, copies } = await secretRuleCopies()
  for (const [names, prefixes] of lists) {
    assert.deepEqual([...names], [...edge.MIRROR_SECRET_NAMES])
    assert.deepEqual([...prefixes], [...edge.MIRROR_SECRET_PREFIXES])
  }
  for (const [copy, predicate] of copies) for (const part of battery) assert.equal(predicate(part), edge.secretShapedPart(part), `${copy}: ${part}`)
})

/** An old file: the plain snapshot plus what the older edge rule admitted and the new one hides, entries and markers. */
const OLD_RESETS = ['/dsh/home/.credentials.yaml.3fa9c1d2e4b5.tmp', '/dsh/home/.credentials.yaml.lock', '/dsh/home/auma/pepper.v1.next']
const OLD_ENTRIES = [['/dsh/home/.credentials.yaml.77aa00.tmp', { kind: 'file', mode: 0o600, mtimeMs: 1700000000009, b64: b64('records: SYNTHETIC\n') }],
  ['/dsh/home/auma/pepper.v1', { kind: 'file', mode: 0o600, mtimeMs: 1700000000010, b64: b64('SYNTHETIC-PEPPER') }]]
function oldFile(plain, { resets = OLD_RESETS, entries = OLD_ENTRIES, keep = ['/dsh/workspace/old'] } = {}) {
  const old = resign(clone(plain)), body = old.parts[3].body
  body.resetPaths = [...resets, ...keep].sort()
  body.entries = [...body.entries, ...clone(entries)].sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))
  return resign(old)
}

test('a snapshot exported before the secret-shaped rule restores without those rows, reads back the same digest, and compares as current', async t => {
  const { checkRecoveryAgainstEdge } = await tsImport('../../../../packages/client/ui-layout/src/client/spatial/portal/recovery-restore.ts', import.meta.url)
  const source = world(t); await seed(source)
  const plain = await snapshotOf(source)
  const old = oldFile(plain)
  const target = world(t)
  const preview = await kit.previewRestore({ fetchImpl: target.fetchImpl, origin: ORIGIN, snapshot: old })
  assert.equal(preview.ok, true, JSON.stringify(preview))
  assert.equal(preview.action, 'restore')
  assert.equal(preview.resetCount, 1)
  assert.equal(preview.entryCount, plain.parts[3].body.entries.length)
  assert.equal(preview.verified.withheld, 5)
  // The in-app check of the same old file shows the same memory digest the restore will write.
  const app = await verifyRecoveryFile(clone(old))
  assert.equal(app.ok, true)
  assert.equal(app.withheld, 5)
  assert.equal(app.mirrorSha256, preview.snapshot.mirrorSha256)
  const restored = await kit.applyRestore({ fetchImpl: target.fetchImpl, origin: ORIGIN, preview, confirm: true })
  assert.equal(restored.ok, true, JSON.stringify(restored))
  // Read back from the edge: the same digest as the file (applyRestore refuses RECOVERY_READBACK_MISMATCH otherwise).
  assert.equal(restored.after.mirrorSha256, preview.snapshot.mirrorSha256)
  assert.equal((await kit.liveState(target.fetchImpl, ORIGIN)).mirrorSha256, preview.snapshot.mirrorSha256)
  const exported = await (await target.fetchImpl('/_mirror/export')).json()
  assert.deepEqual(exported.resetPaths, ['/dsh/workspace/old'])
  assert.deepEqual(exported.entries, plain.parts[3].body.entries)
  for (const name of ['credentials.yaml', 'pepper', 'SYNTHETIC']) assert.equal(JSON.stringify(exported).includes(name), false, name)
  assert.equal((await kit.previewRestore({ fetchImpl: target.fetchImpl, origin: ORIGIN, snapshot: old })).action, 'already-current')
  const inApp = await checkRecoveryAgainstEdge(clone(old), new AbortController().signal, target.fetchImpl)
  assert.equal(inApp.ok, true, JSON.stringify(inApp))
  assert.equal(inApp.verdict, 'already-here')
})

test('a snapshot with no secret-shaped path is judged byte for byte as before (digest and seed pinned earlier)', async t => {
  const source = world(t); await seed(source)
  const plain = await snapshotOf(source)
  const verified = await kit.verifySnapshot(clone(plain))
  assert.equal(verified.ok, true)
  assert.equal(verified.withheld, 0)
  assert.deepEqual(verified.entries, plain.parts[3].body.entries)
  assert.deepEqual(verified.resetPaths, plain.parts[3].body.resetPaths)
  // Pinned from an earlier restore kit (before the rule reached it), over this same fixture.
  assert.equal(verified.mirrorSha256, PIN_PLAIN_MIRROR)
  assert.equal((await verifyRecoveryFile(clone(plain))).mirrorSha256, PIN_PLAIN_MIRROR)
  const seedInputs = await kit.seedInputs(verified)
  assert.equal(seedInputs.package.seedId, PIN_PLAIN_SEED)
  // With ordinary deletion markers too.
  const marked = oldFile(plain, { resets: [], entries: [], keep: ['/dsh/home/auma/retired', '/dsh/workspace/old'] })
  const markedVerified = await kit.verifySnapshot(clone(marked))
  assert.equal(markedVerified.withheld, 0)
  assert.equal(markedVerified.mirrorSha256, PIN_MARKED_MIRROR)
  assert.equal((await verifyRecoveryFile(clone(marked))).mirrorSha256, PIN_MARKED_MIRROR)
})

test('an ordinary name the narrower rule no longer matches is kept, restored and compared like any other file', async t => {
  const source = world(t); await seed(source)
  const plain = await snapshotOf(source)
  const ordinary = [['/dsh/home/auma/credentials.yaml-notes.md', { kind: 'file', mode: 0o644, mtimeMs: 1700000000012, b64: b64('where it lives\n') }],
    ['/dsh/workspace/.ssh-config-docs', { kind: 'dir', mode: 0o755 }]]
  const file = oldFile(plain, { resets: [], entries: ordinary, keep: [] })
  const verified = await kit.verifySnapshot(clone(file))
  assert.equal(verified.withheld, 0)
  assert.equal(verified.leftOut, null)
  assert.deepEqual(verified.entries.filter(([path]) => ordinary.some(([kept]) => kept === path)).map(([path]) => path), ordinary.map(([path]) => path).sort())
  assert.equal((await verifyRecoveryFile(clone(file))).withheld, 0)
  const target = world(t)
  const preview = await kit.previewRestore({ fetchImpl: target.fetchImpl, origin: ORIGIN, snapshot: file })
  assert.equal(preview.ok, true, JSON.stringify(preview))
  const restored = await kit.applyRestore({ fetchImpl: target.fetchImpl, origin: ORIGIN, preview, confirm: true })
  assert.equal(restored.ok, true, JSON.stringify(restored))
  const exported = await (await target.fetchImpl('/_mirror/export')).json()
  for (const [path] of ordinary) assert.ok(exported.entries.some(([kept]) => kept === path), path)
})

test('a path the older rule already refused is not quietly dropped: the edge preflight still refuses it, nothing written', async t => {
  const source = world(t); await seed(source)
  const plain = await snapshotOf(source)
  for (const path of ['/dsh/home/auma/.ssh', '/dsh/home/auma/.env.local']) {
    const forged = oldFile(plain, { resets: [], entries: [[path, { kind: 'file', mode: 0o600, mtimeMs: 1700000000011, b64: b64('x') }]], keep: [] })
    const verified = await kit.verifySnapshot(clone(forged))
    assert.equal(verified.withheld, 0, path)
    assert.equal((await verifyRecoveryFile(clone(forged))).withheld, 0, path)
    const target = world(t), before = target.storageState()
    const preview = await kit.previewRestore({ fetchImpl: target.fetchImpl, origin: ORIGIN, snapshot: forged })
    assert.equal(preview.ok, false, path)
    assert.equal(preview.code, 'RECOVERY_PREFLIGHT_REFUSED', path)
    assert.equal(preview.edgeCode, 'INVALID_MIRROR_PATH', path)
    assert.equal(target.writes.count, 0)
    assert.equal(target.storageState(), before)
  }
})

// ── what a restore leaves out is reported, never implied ───────────────────────────────────────

const NOT_IN_SNAPSHOT = ['AUMLOK owner binding and passkey', 'Messages', 'turn journal', 'provider budget', 'HEAD history before this Pearl']
// Job 4: the words name the rule, never "copies of secret files" (the rule may also match an ordinary name).
const OLD_LEFT_OUT = '2 entries and 3 deletion markers matching the secret-path rule in this recovery file were left out: '
  + 'the edge does not keep paths matching that rule'

test('the preview, the result and an already-current check name what an old file leaves out, by kind and count only', async t => {
  const { checkRecoveryAgainstEdge, recoveryCheckWords } = await tsImport('../../../../packages/client/ui-layout/src/client/spatial/portal/recovery-restore.ts', import.meta.url)
  const source = world(t); await seed(source)
  const plain = await snapshotOf(source)
  const old = oldFile(plain)
  const target = world(t)
  const preview = await kit.previewRestore({ fetchImpl: target.fetchImpl, origin: ORIGIN, snapshot: old })
  assert.equal(preview.action, 'restore', JSON.stringify(preview))
  assert.equal(preview.leftOut, OLD_LEFT_OUT)
  assert.deepEqual(preview.notRestored, [...NOT_IN_SNAPSHOT, OLD_LEFT_OUT])
  for (const name of ['credentials', 'pepper', '.tmp', '.lock', 'SYNTHETIC', '/dsh/', 'copies of secret', 'secret files']) assert.equal(OLD_LEFT_OUT.includes(name), false, name)
  const restored = await kit.applyRestore({ fetchImpl: target.fetchImpl, origin: ORIGIN, preview, confirm: true })
  assert.equal(restored.ok, true, JSON.stringify(restored))
  assert.equal(restored.leftOut, OLD_LEFT_OUT)
  assert.deepEqual(restored.notRestored, [...NOT_IN_SNAPSHOT, OLD_LEFT_OUT])
  const current = await kit.previewRestore({ fetchImpl: target.fetchImpl, origin: ORIGIN, snapshot: old })
  assert.equal(current.action, 'already-current')
  assert.deepEqual(current.notRestored, [OLD_LEFT_OUT])
  // The in-app check says the same count in the same words.
  const inApp = await checkRecoveryAgainstEdge(clone(old), new AbortController().signal, target.fetchImpl)
  assert.equal(inApp.verdict, 'already-here', JSON.stringify(inApp))
  assert.equal(inApp.leftOut, OLD_LEFT_OUT)
  assert.match(recoveryCheckWords(inApp), /^She is already here/)
  assert.ok(recoveryCheckWords(inApp).includes(OLD_LEFT_OUT + '.'))
  // A file with nothing left out says nothing more than before.
  const fresh = world(t)
  const plainPreview = await kit.previewRestore({ fetchImpl: fresh.fetchImpl, origin: ORIGIN, snapshot: plain })
  assert.equal(plainPreview.leftOut, null)
  assert.deepEqual(plainPreview.notRestored, NOT_IN_SNAPSHOT)
  assert.deepEqual((await kit.previewRestore({ fetchImpl: source.fetchImpl, origin: ORIGIN, snapshot: plain })).notRestored, [])
  // Singular and plural, each kind alone: kit and app agree word for word.
  const app = await tsImport('../../../../packages/client/ui-layout/src/client/spatial/portal/recovery-restore.ts', import.meta.url)
  for (const [entries, resets, words] of [
    [OLD_ENTRIES.slice(0, 1), [], '1 entry matching the secret-path rule in this recovery file was left out'],
    [[], OLD_RESETS.slice(0, 1), '1 deletion marker matching the secret-path rule in this recovery file was left out'],
    [[], OLD_RESETS.slice(0, 2), '2 deletion markers matching the secret-path rule in this recovery file were left out'],
  ]) {
    const file = oldFile(plain, { entries, resets, keep: [] })
    const verified = await kit.verifySnapshot(clone(file))
    assert.ok(verified.leftOut.startsWith(words + ': '), verified.leftOut)
    assert.equal((await app.verifyRecoveryFile(clone(file))).leftOut, verified.leftOut)
  }
})

test('the restore page shows what an old file leaves out, before the owner confirms and after the restore', async t => {
  const source = world(t); await seed(source)
  const oldText = JSON.stringify(oldFile(await snapshotOf(source)))
  const target = world(t)
  const shown = []
  const elements = new Map()
  const element = id => ({ id, listeners: {}, files: [], checked: false, disabled: false, textContent: '', firstChild: null,
    addEventListener(type, listener) { this.listeners[type] = listener },
    appendChild(child) { if (id === 'restore-detail') { shown.push(child.textContent); this.firstChild = child } }, removeChild() { shown.length = 0; this.firstChild = null } })
  for (const id of ['restore-file', 'restore-check', 'restore-confirm', 'restore-go', 'restore-status', 'restore-detail']) elements.set(id, element(id))
  runInNewContext(RECOVERY_RESTORE_PAGE.script, { document: { getElementById: id => elements.get(id), createElement: () => element('p') }, crypto, TextEncoder, TextDecoder,
    atob, btoa, URL, fetch: (url, init) => target.fetchImpl(url, init), location: { origin: ORIGIN } })
  const input = elements.get('restore-file'), confirm = elements.get('restore-confirm'), status = elements.get('restore-status')
  input.files = [{ name: 'old.json', size: oldText.length, text: async () => oldText }]; input.listeners.change()
  await elements.get('restore-check').listeners.click()
  assert.match(status.textContent, /Every part verified/)
  assert.ok(shown.includes(OLD_LEFT_OUT + '.'), shown.join('\n'))
  assert.ok(shown.includes('Not in a snapshot, so not restored: ' + NOT_IN_SNAPSHOT.join(', ') + '.'), shown.join('\n'))
  confirm.checked = true; confirm.listeners.change()
  await elements.get('restore-go').listeners.click()
  assert.match(status.textContent, /^Restored/)
  assert.ok(shown.includes(OLD_LEFT_OUT + '.'), shown.join('\n'))
  // Checked again, the same file is already here, and the page still says what it left out.
  await elements.get('restore-check').listeners.click()
  assert.match(status.textContent, /^She is already here/)
  assert.ok(shown.includes(OLD_LEFT_OUT + '.'), shown.join('\n'))
})

test('the restore kit and the in-app check answer a 255-byte chain of digit segments within 50 ms', async () => {
  const { copies } = await secretRuleCopies()
  // Digit segments that both the hex and the digits tokens match, then a character the rule fails: grown to 255 bytes.
  const chain = n => 'credentials.yaml' + '.111111'.repeat(n) + 'x'
  assert.equal(Buffer.byteLength(chain(34)), 255)
  for (const [copy, predicate] of copies) {
    for (let n = 22; n <= 34; n += 1) {
      const started = performance.now()
      assert.equal(predicate(chain(n)), false, copy)
      const elapsed = performance.now() - started
      assert.ok(elapsed < 50, `${copy}: a ${chain(n).length}-byte part took ${elapsed.toFixed(1)} ms`)
    }
    assert.equal(predicate(chain(34).slice(0, -1)), true, `${copy}: the same chain without the last character is a backup sibling`)
  }
  // The restore page runs the kit as generated: the page's copy is the same text (the generator test checks the file).
  assert.ok(RECOVERY_RESTORE_PAGE.script.includes(String(kit.SECRET_SUFFIX)), 'the committed page script carries the kit\'s rule')
})

test('the restore kit, the in-app check and the leaf module each answer the shared table itself, dotted stems and trailing tildes included', async () => {
  const { copies } = await secretRuleCopies()
  const table = JSON.parse(readFileSync(new URL('./secret-path-rule-table.json', import.meta.url), 'utf8'))
  for (const name of ['.session.cap', '.ed25519-keypair.json', '..credentials.yaml', '.session.cap~', 'credentials.yaml.bak~',
    '.credentials.yaml.lock.takeover-0123456789abcdef']) assert.ok(table.shaped.includes(name), name)
  for (const [copy, predicate] of copies) {
    for (const part of table.shaped) assert.equal(predicate(part), true, `${copy}: ${part}`)
    for (const part of table.ordinary) assert.equal(predicate(part), false, `${copy}: ${part}`)
  }
})

test('the restore kit and the in-app check answer the longest takeover-and-tilde chain of a 255-byte part within 50 ms', async () => {
  const { copies } = await secretRuleCopies()
  // The dotted stem, `~takeover~111111` segments, then one trailing `~` (shaped) or a failing character in its place.
  const body = '..credentials.yaml' + '~takeover~111111'.repeat(14) + '.111111' + '.1234'
  for (const [part, expected] of [[body + '~', true], [body + 'x', false]]) {
    assert.equal(Buffer.byteLength(part), 255)
    for (const [copy, predicate] of copies) {
      const started = performance.now()
      assert.equal(predicate(part), expected, `${copy}: ${part.slice(-2)}`)
      const elapsed = performance.now() - started
      assert.ok(elapsed < 50, `${copy}: took ${elapsed.toFixed(1)} ms`)
    }
  }
})
