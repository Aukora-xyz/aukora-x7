/**
 * the owner's estate (`GET /_host/estate`) carries how many stored entries the secret-path rule
 * withholds, as a count and one plain line, and accepts the snapshot tag with its representation version. The mirror's
 * own estate answer comes from the real MirrorDO over in-memory storage; the head is a fixture. Synthetic owner identity,
 * no live network or credentials (the fixture pattern of estate.test.mjs).
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createWorker } from '../worker.mjs'
import { MirrorDO, mirrorDigest } from '../mirror-do.mjs'

const ORIGIN = 'https://estate.example.invalid', SEED = 'a'.repeat(64), BALL = 'b'.repeat(64)
const LINEAGE = '11111111-1111-4111-8111-111111111111', SECRET = 'SYNTHETIC_PRIVATE_CONTENT'
const FENCE = 'mirror:v2:global-fence', ENTRY = 'mirror:v2:entry:', CHUNK = 'mirror:v2:chunk:'
const owner = { type: 'owner', email: 'owner@example.invalid', expires: 2000 }
const headView = () => ({ ok: true, schema: 'aukora.head-estate.v1', coverage: 'partial', head: { ballId: BALL, epoch: 2 },
  lease: { active: false, expiresAt: null }, wake: { enabled: false, intervalMs: 60000, wakeCount: 0, nextWakeAt: null, lastWakeAt: null,
    lastWakeOutcome: null, consecutiveUnacknowledgedWakes: 0, autoPaused: false, scheduleStatus: 'disabled', scheduledAlarmAt: null },
  repo: { staged: false, pending: false, lastOutcome: null }, transcript: { lastSequence: 0 } })

class Storage {
  data = new Map([[FENCE, { lineageId: LINEAGE, revision: 7 }], ['mirror:bootstrap:v1', { phase: 'ready', seedId: SEED, ballId: BALL, epoch: 2,
    lineageId: LINEAGE, batchDigests: [], entryCount: 0 }]])
  async transaction(callback) {
    const working = structuredClone(this.data)
    const tx = {
      get: async key => structuredClone(working.get(key)),
      list: async ({ prefix = '', limit = Infinity } = {}) => new Map([...working].filter(([key]) => key.startsWith(prefix))
        .sort(([a], [b]) => a.localeCompare(b)).slice(0, limit).map(([key, value]) => [key, structuredClone(value)])),
      put: async (key, value) => { working.set(key, structuredClone(value)) },
      delete: async key => working.delete(key),
    }
    const result = await callback(tx)
    this.data = working
    return result
  }
  async get(key) { return structuredClone(this.data.get(key)) }
  async list(options) { return this.transaction(tx => tx.list(options)) }
}

async function plant(storage, path) {
  const id = await mirrorDigest(path)
  storage.data.set(ENTRY + id, { path, kind: 'file', mode: 0o600, mtimeMs: 1, chunks: 1, bytes: SECRET.length })
  storage.data.set(`${CHUNK}${id}:0`, Buffer.from(SECRET).toString('base64'))
}

/** The worker with the real MirrorDO answering `/_mirror/estate`, or a stand-in answer when `mirrorAnswer` is given. */
function fixture(storage, mirrorAnswer) {
  const mirror = new MirrorDO({ storage }, {})
  const env = { PUBLIC_HOST: new URL(ORIGIN).host, ACCESS_TEAM: 'fixture.cloudflareaccess.com', ACCESS_AUD: 'fixture', OWNER_EMAIL: owner.email,
    SOURCE_REVISION: 'c'.repeat(40) }
  env.HEAD = { idFromName: value => value, get: () => ({ fetch: async request => {
    const path = new URL(request.url).pathname
    if (path.endsWith('/bootstrap-status')) return Response.json({ ok: true, phase: 'complete', seedId: SEED, ballId: BALL, epoch: 2 })
    if (path === '/_head/estate') return Response.json(headView())
    assert.fail('Unexpected internal route ' + path)
  } }) }
  env.MIRROR = { idFromName: value => value, get: () => ({ fetch: async request => {
    const path = new URL(request.url).pathname
    if (path.endsWith('/bootstrap-status')) return Response.json({ ok: true, phase: 'ready', seedId: SEED, ballId: BALL, epoch: 2 })
    if (path === '/_mirror/estate' && mirrorAnswer) return Response.json(mirrorAnswer)
    if (path === '/_mirror/estate') return mirror.fetch(request)
    assert.fail('Unexpected internal route ' + path)
  } }) }
  const worker = createWorker({ verifyAccess: async () => owner, now: () => 1000000, networkFetch: () => assert.fail('No network permitted') })
  return () => worker.fetch(new Request(ORIGIN + '/_host/estate', { headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin' } }), env)
}

test('the estate carries the withheld count and its plain line from the real mirror, with the versioned snapshot tag', async () => {
  const storage = new Storage()
  for (const path of ['/dsh/home/auma/note.md', '/dsh/home/.session.cap', '/dsh/home/.credentials.yaml.3fa9c1d2e4b5.tmp', '/dsh/home/credentials.yaml.bak~']) {
    await plant(storage, path)
  }
  const response = await fixture(storage)()
  const text = await response.text()
  assert.equal(response.status, 200, text)
  const { mirror } = JSON.parse(text)
  assert.deepEqual([mirror.entryCount, mirror.fileCount, mirror.withheldEntries, mirror.pathRuleNote],
    [1, 1, 3, 'entries withheld by the secret-path rule: 3'])
  assert.match(mirror.snapshotETag, new RegExp(`^"x61-mirror-snapshot-v2:${LINEAGE}:7:r[0-9]+"$`))
  for (const needle of [SECRET, 'session.cap', 'credentials']) assert.equal(text.includes(needle), false, needle)
  // Nothing withheld: the count is 0 (the card then draws nothing for it).
  const clean = new Storage()
  await plant(clean, '/dsh/home/auma/note.md')
  const answer = await (await fixture(clean)()).json()
  assert.deepEqual([answer.mirror.withheldEntries, answer.mirror.pathRuleNote], [0, 'entries withheld by the secret-path rule: 0'])
})

test('the estate still fails closed on a malformed count or note, and takes an older mirror answer without them', async () => {
  const base = { ok: true, schema: 'aukora.mirror-estate.v1', entryCount: 1, fileCount: 1, directoryCount: 0, highWater: 3 }
  const tag = `"x61-mirror-snapshot-v2:${LINEAGE}:3"`
  for (const extra of [{ withheldEntries: -1, pathRuleNote: 'x' }, { withheldEntries: 1.5, pathRuleNote: 'x' }, { withheldEntries: 1, pathRuleNote: 'x'.repeat(81) },
    { withheldEntries: 1 }, { pathRuleNote: 'x' }, { withheldEntries: 1, pathRuleNote: ['x'] }]) {
    const response = await fixture(new Storage(), { ...base, snapshotETag: tag, ...extra })()
    assert.equal(response.status, 503, JSON.stringify(extra))
  }
  for (const bad of [`"x61-mirror-snapshot-v2:${LINEAGE}:3:r"`, `"x61-mirror-snapshot-v2:${LINEAGE}:3:rx"`, `"x61-mirror-snapshot-v2:${LINEAGE}:3:r1234567"`]) {
    assert.equal((await fixture(new Storage(), { ...base, snapshotETag: bad, withheldEntries: 0, pathRuleNote: 'n' })()).status, 503, bad)
  }
  // An older mirror (no count, unversioned tag): the same answer as before, with no invented count.
  const older = await (await fixture(new Storage(), { ...base, snapshotETag: tag })()).json()
  assert.deepEqual(older.mirror, { entryCount: 1, fileCount: 1, directoryCount: 0, highWater: 3, snapshotETag: tag })
  const versioned = await (await fixture(new Storage(), { ...base, snapshotETag: `"x61-mirror-snapshot-v2:${LINEAGE}:3:r5"`, withheldEntries: 2,
    pathRuleNote: 'entries withheld by the secret-path rule: 2', paths: [SECRET] })()).json()
  assert.deepEqual([versioned.mirror.withheldEntries, versioned.mirror.pathRuleNote, Object.hasOwn(versioned.mirror, 'paths')],
    [2, 'entries withheld by the secret-path rule: 2', false])
})
