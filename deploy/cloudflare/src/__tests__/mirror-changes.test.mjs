/** `GET /_mirror/changes` is a read-only fact route. Real MIRROR code (bootstrap, publish, wake checkpoint,
 * the route) on in-memory Durable Object storage; every case checks that the route itself put and deleted nothing. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { MirrorDO, bootstrapMirror, publishMirror, appendMirrorWakeCheckpoint, handleMirrorRequest, mirrorDigest,
  mirrorChangesQuery, rebaseMode, REBASE_MODES, MIRROR_CHANGES_LIMITS } from '../mirror-do.mjs'
import { canonicalBootstrap, digest, CLOUD_WAKE_CHECKPOINT_PATH } from '../head-do.mjs'
import { MIRROR_WAKE_CLIENT_ID } from '../mirror-client-slots.mjs'

const SEED = 'a'.repeat(64), BALL = 'b'.repeat(64)
const HER = '5e000006-0000-4000-8000-000000000006', PHONE = '5e0000010-0000-4000-8000-0000000000010'
const b64 = text => Buffer.from(text).toString('base64')
const file = (text, mtimeMs = 1) => ({ kind: 'file', mode: 0o644, mtimeMs, b64: b64(text) })

/** In-memory DO storage; counts every put and delete made inside a transaction. */
function memoryStorage() {
  let rows = new Map(), tail = Promise.resolve()
  const writes = { put: 0, delete: 0 }
  const view = data => ({
    get: async key => structuredClone(data.get(key)),
    put: async (key, value) => { writes.put++; data.set(key, structuredClone(value)) },
    delete: async key => { writes.delete++; data.delete(key) },
    list: async ({ prefix = '', limit = Infinity } = {}) => structuredClone(new Map([...data].filter(([key]) => key.startsWith(prefix)).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).slice(0, limit))),
  })
  const storage = {
    get: key => view(rows).get(key), list: options => view(rows).list(options),
    put: async (key, value) => { rows.set(key, structuredClone(value)) }, delete: async key => { rows.delete(key) },
    transaction(operation) {
      const result = tail.then(async () => { const data = structuredClone(rows); const value = await operation(view(data)); rows = data; return value })
      tail = result.catch(() => {})
      return result
    },
  }
  return { storage, writes, rows: () => rows }
}

/** A bootstrapped mirror at revision 1: her seed files, plus an empty checkpoint file's directory. */
async function seeded() {
  const ms = memoryStorage()
  const entries = [['/dsh/home/auma', { kind: 'dir', mode: 0o755 }], ['/dsh/home/auma/notes', { kind: 'dir', mode: 0o755 }],
    ['/dsh/home/auma/notes/a.md', file('a\n')], ['/dsh/home/auma/seed', { kind: 'dir', mode: 0o755 }]]
  await bootstrapMirror(ms.storage, { action: 'begin', seedId: SEED, ballId: BALL, epoch: 1, mirror: { batchDigests: [await digest(canonicalBootstrap(entries))], entryCount: entries.length } })
  await bootstrapMirror(ms.storage, { action: 'batch', seedId: SEED, index: 0, entries })
  const ready = await bootstrapMirror(ms.storage, { action: 'commit', seedId: SEED })
  return { ms, lineageId: ready.lineageId }
}
let seq = new Map()
async function save(ms, clientId, lineageId, revision, entries) {
  const next = (seq.get(clientId) ?? 0) + 1
  const batch = { clientId, seq: next, id: `${clientId}:${next}`, entries, cloudBase: { lineageId, revision } }
  const answer = await publishMirror(ms.storage, { v: 2, batch, digest: await mirrorDigest(batch) })
  if (answer.ok) seq.set(clientId, next)
  return answer
}
let wakeCount = 0
const wake = ms => appendMirrorWakeCheckpoint(ms.storage, { at: 1_763_000_000_000 + ++wakeCount, id: (wakeCount.toString(16)).padStart(64, '0'),
  head: { ballId: BALL, epoch: 80 }, evidence: [{ tool: 'readMirrorText', digest: 'c'.repeat(64) }] }, { seedId: SEED })
const ask = async (ms, query, options = {}) => {
  const before = { ...ms.writes }
  const response = await handleMirrorRequest(new Request(`https://x61.internal/_mirror/changes${query}`), ms.storage, { authorized: true, ...options })
  assert.deepEqual(ms.writes, before, 'the changes route puts and deletes nothing')
  return { status: response.status, body: await response.json() }
}

test.beforeEach(() => { seq = new Map(); wakeCount = 0 })

test('wake-only versions: complete, writer wake, the checkpoint file as the one path, its bytes served, storage untouched', async () => {
  const { ms, lineageId } = await seeded()
  assert.equal((await save(ms, HER, lineageId, 1, [['/dsh/home/auma/notes/a.md', file('a\nb\n', 2)]])).revision, 2)
  for (let index = 0; index < 3; index++) assert.equal((await wake(ms)).ok, true)
  const frozen = JSON.stringify([...ms.rows()])
  const { status, body } = await ask(ms, `?since=2&clientId=${HER}`)
  assert.equal(status, 200)
  assert.equal(JSON.stringify([...ms.rows()]), frozen)
  assert.equal(body.ok, true); assert.equal(body.protocol, 'x61-cloud-mirror/v1'); assert.equal(body.lineageId, lineageId)
  assert.equal(body.revision, 5); assert.equal(body.since, 2); assert.equal(body.complete, true); assert.equal(body.mode, 'off')
  assert.equal(body.clientHeadSeq, 1)
  assert.deepEqual(body.revisions.map(item => [item.revision, item.writer, item.client, item.seq, item.applied, item.paths]),
    [3, 4, 5].map((revision, index) => [revision, 'wake', MIRROR_WAKE_CLIENT_ID.slice(0, 8), index + 1, 1, [CLOUD_WAKE_CHECKPOINT_PATH]]))
  assert.ok(body.revisions.every(item => /^[0-9a-f]{64}$/.test(item.digest) && Number.isSafeInteger(item.acknowledgedAt)))
  const entry = body.entries[CLOUD_WAKE_CHECKPOINT_PATH]
  assert.equal(entry.kind, 'file'); assert.equal(entry.mode, 0o600)
  const lines = Buffer.from(entry.b64, 'base64').toString('utf8').trimEnd().split('\n').map(line => JSON.parse(line))
  assert.deepEqual(lines.map(row => row.schema), Array(3).fill('aukora.cloud-wake-checkpoint.v1'))
  assert.deepEqual(Object.keys(body.entries), [CLOUD_WAKE_CHECKPOINT_PATH])
  assert.equal(body.tooLarge, undefined)
})

test('another browser and her own save: writers browser and self, paths unknown (null), only the wake path served', async () => {
  const { ms, lineageId } = await seeded()
  await save(ms, HER, lineageId, 1, [['/dsh/home/auma/notes/a.md', file('her\n', 2)]])
  await save(ms, PHONE, lineageId, 2, [['/dsh/home/auma/notes/a.md', file('phone\n', 3)]])
  await wake(ms)
  await save(ms, HER, lineageId, 4, [['/dsh/home/auma/notes/b.md', file('b\n', 4)]])
  const { body } = await ask(ms, `?since=1&clientId=${HER}`)
  assert.equal(body.complete, true)
  assert.deepEqual(body.revisions.map(item => [item.revision, item.writer, item.client, item.paths]), [
    [2, 'self', HER.slice(0, 8), null], [3, 'browser', PHONE.slice(0, 8), null], [4, 'wake', MIRROR_WAKE_CLIENT_ID.slice(0, 8), [CLOUD_WAKE_CHECKPOINT_PATH]],
    [5, 'self', HER.slice(0, 8), null]])
  assert.deepEqual(Object.keys(body.entries), [CLOUD_WAKE_CHECKPOINT_PATH])
  assert.equal(body.clientHeadSeq, 2)
  // The phone asks: its own versions are `self`, hers are `browser`.
  const phone = await ask(ms, `?since=4&clientId=${PHONE}`)
  assert.deepEqual(phone.body.revisions.map(item => item.writer), ['browser'])
  assert.equal(phone.body.clientHeadSeq, 1)
  // A client the edge never saw has head 0.
  assert.equal((await ask(ms, '?since=5&clientId=00000000-0000-4000-8000-000000000001')).body.clientHeadSeq, 0)
})

test('complete is false when a version has no receipt (the bootstrap revision); since equal to the revision lists nothing', async () => {
  const { ms } = await seeded()
  await wake(ms)
  const from0 = (await ask(ms, `?since=0&clientId=${HER}`)).body
  assert.equal(from0.complete, false)
  assert.deepEqual(from0.revisions.map(item => item.revision), [2])
  const atHead = (await ask(ms, `?since=2&clientId=${HER}`)).body
  assert.equal(atHead.complete, true); assert.deepEqual(atHead.revisions, []); assert.deepEqual(atHead.entries, {})
})

test('a changed path absent now is `missing`, with whether a deletion marker covers it; never a write', async () => {
  const { ms } = await seeded()
  await wake(ms)
  const id = await mirrorDigest(CLOUD_WAKE_CHECKPOINT_PATH)
  const raw = ms.rows()
  const entry = raw.get(`mirror:v2:entry:${id}`)
  for (let index = 0; index < entry.chunks; index++) raw.delete(`mirror:v2:chunk:${id}:${index}`)
  raw.delete(`mirror:v2:entry:${id}`)
  assert.deepEqual((await ask(ms, `?since=1&clientId=${HER}`)).body.entries[CLOUD_WAKE_CHECKPOINT_PATH], { kind: 'missing', reset: false })
  // Each transaction commits a fresh map, so the live rows are read again before the marker is put.
  ms.rows().set(`mirror:v2:reset:${await mirrorDigest('/dsh/home/auma/seed')}`, '/dsh/home/auma/seed')
  assert.deepEqual((await ask(ms, `?since=1&clientId=${HER}`)).body.entries[CLOUD_WAKE_CHECKPOINT_PATH], { kind: 'missing', reset: true })
})

test('refusals: since past the revision (409), an unfenced namespace is never initialized (409), every malformed query (400)', async () => {
  const { ms } = await seeded()
  assert.deepEqual((await ask(ms, `?since=2&clientId=${HER}`)).body.code, 'MIRROR_CHANGES_SINCE_OUT_OF_RANGE')
  assert.equal((await ask(ms, `?since=2&clientId=${HER}`)).status, 409)
  const empty = memoryStorage()
  const answer = await ask(empty, `?since=0&clientId=${HER}`)
  assert.equal(answer.status, 409); assert.equal(answer.body.code, 'MIRROR_GLOBAL_FENCE_INITIALIZATION_REQUIRED')
  assert.equal(empty.rows().size, 0)
  for (const query of ['', `?since=1`, `?clientId=${HER}`, `?since=01&clientId=${HER}`, `?since=-1&clientId=${HER}`, `?since=1.0&clientId=${HER}`,
    `?since=1&clientId=${HER.toUpperCase()}`, `?since=1&clientId=nope`, `?since=1&since=1&clientId=${HER}`, `?since=1&clientId=${HER}&x=1`,
    `?since=99999999999999999&clientId=${HER}`, `?since=1&clientId=${HER}#h`]) {
    const refused = await ask(ms, query)
    assert.equal(refused.status, 400, query); assert.equal(refused.body.code, 'INVALID_MIRROR_CHANGES_QUERY', query)
  }
  // Parameter order does not matter; anything but GET is not this route.
  assert.equal((await ask(ms, `?clientId=${HER}&since=1`)).status, 200)
  const post = await handleMirrorRequest(new Request(`https://x61.internal/_mirror/changes?since=1&clientId=${HER}`, { method: 'POST', body: '{}' }), ms.storage, { authorized: true })
  assert.equal(post.status, 404)
  const signedOut = await handleMirrorRequest(new Request(`https://x61.internal/_mirror/changes?since=1&clientId=${HER}`), ms.storage, {})
  assert.equal(signedOut.status, 401)
})

test('the switch: exactly report, apply or chrome-wins names a mode; anything else is off; the DO tells it from its env', async () => {
  assert.deepEqual(REBASE_MODES, ['off', 'report', 'apply', 'chrome-wins'])
  for (const value of ['report', 'apply', 'chrome-wins']) assert.equal(rebaseMode({ MIRROR_REBASE: value }), value)
  for (const value of [undefined, '', 'on', 'APPLY', ' apply', 'apply ', 'off', '1', 'chrome']) assert.equal(rebaseMode({ MIRROR_REBASE: value }), 'off')
  assert.equal(rebaseMode(undefined), 'off')
  assert.deepEqual(MIRROR_CHANGES_LIMITS, { paths: 10000, fileBytes: 16 * 1024 * 1024 })
  const { ms } = await seeded()
  await wake(ms)
  for (const [value, expected] of [['apply', 'apply'], ['chrome-wins', 'chrome-wins'], ['yes', 'off']]) {
    const mirror = new MirrorDO({ storage: ms.storage }, { MIRROR_REBASE: value })
    const before = { ...ms.writes }
    const response = await mirror.fetch(new Request(`https://x61.internal/_mirror/changes?since=1&clientId=${HER}`, { headers: { 'x-x6-internal-authorized': '1', 'x-x6-bootstrap-seed': SEED } }))
    assert.deepEqual(ms.writes, before)
    const body = await response.json()
    assert.equal(response.status, 200); assert.equal(body.mode, expected); assert.equal(body.revision, 2)
  }
  // An unknown option value is never passed through.
  assert.equal((await ask(ms, `?since=1&clientId=${HER}`, { rebaseMode: 'everything' })).body.mode, 'off')
})

test('mirrorChangesQuery is the one strict query check the Worker and the DO share', () => {
  assert.deepEqual(mirrorChangesQuery(new URL(`https://x/_mirror/changes?since=2083&clientId=${HER}`)), { since: 2083, clientId: HER })
  assert.equal(mirrorChangesQuery(new URL(`https://x/_mirror/changes?since=2083&clientId=${HER}&clientId=${HER}`)), null)
  assert.equal(mirrorChangesQuery(new URL('https://x/_mirror/changes')), null)
})
