/**
 * a secret file's temp, backup, lock or swap sibling is never admitted by the cloud mirror, and a row
 * of that shape already in MIRROR storage (admitted under the older exact-name rule) is never served by any read path.
 * Real mirror code over a transactional in-memory storage; the planted rows are written straight into it.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import {
  bootstrapMirror, bootstrapResetPaths, handleMirrorRequest, hiddenStoredPath, MIRROR_LIMITS, mirrorDigest, mirrorPathExcluded,
  publishMirror, readMirrorRepoFile, secretShapedPart, validateMirrorPath,
} from '../mirror-do.mjs'

const FENCE = 'mirror:v2:global-fence', ENTRY = 'mirror:v2:entry:', CHUNK = 'mirror:v2:chunk:', RESET = 'mirror:v2:reset:'
const CONFLICT = 'mirror:v2:conflict:', CONFLICT_CHUNK = 'mirror:v2:conflict-chunk:', BOOTSTRAP = 'mirror:bootstrap:v1'
const LINEAGE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', CLIENT = '00000000-0000-4000-8000-000000000001', SEED = 'c'.repeat(64)
const SECRET_TEXT = 'records:\n  client-connection/browser-session: SYNTHETIC-SIGNING-VALUE\n'
const SECRET_B64 = Buffer.from(SECRET_TEXT).toString('base64')
const TMP = '/dsh/home/.credentials.yaml.3fa9c1d2e4b5.tmp'
const LOCK = '/dsh/home/.credentials.yaml.lock'
const CAP_TMP = '/dsh/home/auma/session.cap.3fa9c1.tmp'
const NOTE = '/dsh/home/auma/note.md'

class Storage {
  data = new Map([[FENCE, { lineageId: LINEAGE, revision: 0 }]])
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

const file = text => ({ kind: 'file', mode: 0o644, mtimeMs: 1, b64: Buffer.from(text).toString('base64') })
async function envelope(storage, seq, entries) {
  const batch = { id: `${CLIENT}:${seq}`, clientId: CLIENT, seq, entries, cloudBase: structuredClone(storage.data.get(FENCE)) }
  return { v: 2, batch, digest: await mirrorDigest(batch) }
}
/** A row admitted under the old exact-name rule, written straight into storage, as the live mirror may hold it. */
async function plantFile(storage, path, b64 = SECRET_B64) {
  const id = await mirrorDigest(path)
  storage.data.set(ENTRY + id, { path, kind: 'file', mode: 0o600, mtimeMs: 1, chunks: 1, bytes: Buffer.from(b64, 'base64').length })
  storage.data.set(`${CHUNK}${id}:0`, b64)
}
async function plantReset(storage, path) { storage.data.set(RESET + await mirrorDigest(path), path) }

/** Her mirror with one note, plus planted secret-shaped rows: a temp copy with bytes, a lock reset, a session-cap temp. */
async function mirrorWithPlantedRows() {
  const storage = new Storage()
  const applied = await publishMirror(storage, await envelope(storage, 1, [['/dsh/home/auma', { kind: 'dir', mode: 0o755 }], [NOTE, file('hello\n')]]))
  assert.equal(applied.ok, true)
  await plantFile(storage, TMP)
  await plantFile(storage, CAP_TMP)
  await plantReset(storage, LOCK)
  await plantReset(storage, '/dsh/home/.credentials.yaml.77aa00.tmp')
  storage.data.set(BOOTSTRAP, { phase: 'ready', seedId: SEED, lineageId: LINEAGE })
  return storage
}
const call = (storage, path, init) => handleMirrorRequest(new Request(`https://x61.internal${path}`, init), storage, { authorized: true })
const snapshotText = async storage => {
  const response = await call(storage, '/api/snapshot?snapshotFormat=x61-mirror-snapshot%2Fv2')
  assert.equal(response.status, 200)
  return response.text()
}
const leaks = text => text.includes(SECRET_B64) || text.includes('credentials.yaml.') || text.includes('session.cap.')

// Job 4: the grammar, over the review's whole table (section 1) and the shapes
// packages/util/atomic-write really writes (`<file>.<12 hex>.tmp`, `<file>.lock`, `<file>.lock.takeover-<16 hex>`).
const RULE_TABLE = JSON.parse(readFileSync(new URL('./secret-path-rule-table.json', import.meta.url), 'utf8'))

test('job 4: the secret-path rule matches a secret name, its closed-list temp, lock, backup and swap siblings and the prefixes, nothing else', () => {
  for (const part of RULE_TABLE.shaped) assert.equal(secretShapedPart(part), true, part)
  for (const part of RULE_TABLE.ordinary) assert.equal(secretShapedPart(part), false, part)
  // Directory names follow the same rule; a matching directory withholds what is under it.
  for (const path of [TMP, LOCK, CAP_TMP, '/dsh/home/auma/aumlok/pepper.v1', '/dsh/workspace/.ssh.bak/config', '/dsh/home/.ssh/known_hosts']) {
    assert.equal(mirrorPathExcluded(path), true, path)
    assert.throws(() => validateMirrorPath(path), { code: 'INVALID_MIRROR_PATH' })
    assert.equal(hiddenStoredPath(path), true, path)
  }
  for (const path of [NOTE, '/dsh/home/auma/seed/receipts.v3.jsonl', '/dsh/home/auma/notes/pepper.v10', '/dsh/workspace/.ssh-config-docs/readme.md',
    '/dsh/home/auma/credentials.yaml-notes.md', '/dsh/home/auma/session.cap.md', '/dsh/home/.transport-notes', '/dsh/home/.credentials.yamlx']) {
    assert.equal(mirrorPathExcluded(path), false, path)
    assert.equal(validateMirrorPath(path), path)
    assert.equal(hiddenStoredPath(path), false, path)
  }
  // Malformed paths are not hidden quietly: they still fail closed where they are read.
  for (const path of ['/dsh/home/../.credentials.yaml.tmp', '/elsewhere/.credentials.yaml.tmp', '/dsh/home/balls/.credentials.yaml.tmp']) {
    assert.equal(hiddenStoredPath(path), false, path)
  }
})

test('job 4: hiddenStoredPath judges the path as stored: an over-long secret part is malformed, a valid near-limit path stays hidden', () => {
  // Before: the part was replaced by `secret-shaped` first, so a 297-byte part passed and a valid 4,096-byte path failed.
  const longPart = '.credentials.yaml' + '.tmp'.repeat(70)
  assert.equal(secretShapedPart(longPart), true)
  assert.equal(hiddenStoredPath(`/dsh/home/${longPart}`), false, 'a part over 255 bytes is malformed, not hidden')
  assert.equal(hiddenStoredPath('/dsh/home/.credentials.yaml.tmp\u0001'), false)
  const filler = 'x'.repeat(200)
  let near = '/dsh/home/.ssh'
  while (near.length + filler.length + 1 <= 4096) near += '/' + filler
  near += '/' + 'y'.repeat(4096 - near.length - 1)
  assert.equal(new TextEncoder().encode(near).length, 4096)
  assert.equal(hiddenStoredPath(near), true, 'a valid path at the length limit is hidden, never a reason to fail every read')
})

test('a delta writing a credentials temp copy (file or directory) is refused as INVALID_MIRROR_PATH and changes nothing', async () => {
  // Job 3: a `gone` for such a path is an applied no-op (the next tests); every entry that would store one is refused.
  const storage = new Storage()
  for (const path of [TMP, LOCK, CAP_TMP]) {
    for (const wire of [file(SECRET_TEXT), { kind: 'dir', mode: 0o700 }]) {
      for (const entries of [[[path, wire]], [[path, { kind: 'gone' }], [path, wire]], [[NOTE, file('kept back\n')], [path, wire]]]) {
        const before = structuredClone(storage.data)
        const response = await call(storage, '/_mirror/delta', { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify(await envelope(storage, 1, entries)) })
        assert.equal(response.status, 400, `${path} ${wire.kind}`)
        assert.equal((await response.json()).code, 'INVALID_MIRROR_PATH', `${path} ${wire.kind}`)
        assert.deepEqual(storage.data, before, `${path} ${wire.kind}`)
      }
    }
  }
})

test('job 3: the exact save an older page boot queued is taken as an applied no-op; the browser is never fenced, later saves flow', async () => {
  const storage = new Storage()
  assert.equal((await post(storage, await envelope(storage, 1, [['/dsh/home/auma', { kind: 'dir', mode: 0o755 }]]))).status, 200)
  const rows = () => [...storage.data].filter(([key]) => key.startsWith(ENTRY) || key.startsWith(CHUNK) || key.startsWith(RESET))
  const before = rows()
  // What every boot of the older page queued (atomic-write's temp copy, then its writer lock, both gone by the flush).
  const old = await envelope(storage, 2, [[TMP, { kind: 'gone' }], [LOCK, { kind: 'gone' }]])
  const base = old.batch.cloudBase
  const response = await post(storage, old)
  assert.equal(response.status, 200)
  const ack = await response.json()
  // Exactly what idb-persist's drain requires before it removes the queued save (ok, id, digest, applied, next revision).
  assert.equal(ack.ok, true)
  assert.equal(ack.id, old.batch.id)
  assert.equal(ack.digest, old.digest)
  assert.equal(ack.applied, old.batch.entries.length)
  assert.equal(ack.lineageId, base.lineageId)
  assert.equal(ack.revision, base.revision + 1)
  assert.deepEqual(rows(), before, 'nothing written, no deletion marker kept')
  assert.deepEqual(storage.data.get(FENCE), { lineageId: LINEAGE, revision: base.revision + 1 })
  // Its lost acknowledgement: the exact retry gets the same receipt and changes nothing.
  const kept = structuredClone(storage.data)
  const retry = await (await post(storage, old)).json()
  assert.equal(retry.replayed, true)
  assert.equal(retry.revision, ack.revision)
  assert.deepEqual(storage.data, kept)
  // A later save that still carries one such marker beside her own work applies her work only.
  const mixed = await post(storage, await envelope(storage, 3, [[`/dsh/home/.credentials.yaml.0a1b2c3d4e5f.tmp`, { kind: 'gone' }], [NOTE, file('hello\n')]]))
  assert.equal(mixed.status, 200)
  assert.equal((await mixed.json()).applied, 2)
  const text = await snapshotText(storage)
  assert.deepEqual(JSON.parse(text).entries.map(([path]) => path), ['/dsh/home/auma', NOTE])
  assert.deepEqual(JSON.parse(text).resetPaths, [])
  assert.equal(leaks(text), false)
  assert.equal((await post(storage, await envelope(storage, 4, [[NOTE, file('later\n')]]))).status, 200)
})

test('job 3: a secret-shaped `gone` over a planted row deletes nothing; a `gone` outside the rule\'s reach is still refused', async () => {
  const storage = await mirrorWithPlantedRows()
  const planted = new Map([...storage.data].filter(([key]) => key.startsWith(ENTRY) || key.startsWith(CHUNK) || key.startsWith(RESET)))
  const ok = await post(storage, await envelope(storage, 2, [[TMP, { kind: 'gone' }], [CAP_TMP, { kind: 'gone' }], [LOCK, { kind: 'gone' }]]))
  assert.equal(ok.status, 200)
  // Every row and marker is exactly as it was: none deleted, none added.
  assert.deepEqual(new Map([...storage.data].filter(([key]) => key.startsWith(ENTRY) || key.startsWith(CHUNK) || key.startsWith(RESET))), planted)
  // Not secret-shaped but excluded, malformed, or outside the roots: refused as before, nothing changes.
  for (const path of ['/dsh/home/balls/.credentials.yaml.tmp', '/dsh/home/../.credentials.yaml.tmp', '/elsewhere/.credentials.yaml.tmp',
    '/dsh/home/.DS_Store', '/dsh/home/.DS_Store/.credentials.yaml.tmp', '/dsh/home/auma/snapshots/x.json']) {
    const before = structuredClone(storage.data)
    const refused = await post(storage, await envelope(storage, 3, [[path, { kind: 'gone' }]]))
    assert.equal(refused.status, 400, path)
    assert.equal((await refused.json()).code, 'INVALID_MIRROR_PATH', path)
    assert.deepEqual(storage.data, before, path)
  }
})

test('/api/snapshot v2 (and /_mirror/export, which forwards to it) never returns a planted secret-shaped row', async () => {
  const storage = await mirrorWithPlantedRows()
  const text = await snapshotText(storage)
  const snapshot = JSON.parse(text)
  assert.deepEqual(snapshot.entries.map(([path]) => path), ['/dsh/home/auma', NOTE])
  assert.deepEqual(snapshot.resetPaths, [])
  assert.equal(leaks(text), false)
})

test('/_mirror/status never names or counts a planted secret-shaped row', async () => {
  const storage = await mirrorWithPlantedRows()
  const response = await call(storage, '/_mirror/status')
  const text = await response.text()
  const status = JSON.parse(text)
  assert.equal(status.ok, true)
  assert.deepEqual([...status.homeFiles].sort(), ['auma', 'auma/note.md'])
  assert.equal(status.entryCount, 2)
  assert.equal(status.resetCount, 0)
  assert.equal(leaks(text), false)
})

test('the repo reader (readMirrorRepoFile) refuses a planted secret-shaped path and never returns its bytes', async () => {
  const storage = await mirrorWithPlantedRows()
  for (const path of [CAP_TMP, TMP]) {
    await assert.rejects(readMirrorRepoFile(storage, { path, seedId: SEED }), error => error.status === 400 || error.status === 403, path)
  }
  const note = await readMirrorRepoFile(storage, { path: NOTE, seedId: SEED })
  assert.equal(note.kind, 'file')
})

test('a publish over planted rows still applies, leaves those rows exactly as they were, and never serves them', async () => {
  const storage = await mirrorWithPlantedRows()
  const planted = new Map([...storage.data].filter(([key, value]) => (key.startsWith(ENTRY) || key.startsWith(RESET))
    && hiddenStoredPath(typeof value === 'string' ? value : value.path)))
  const chunks = [...storage.data].filter(([key]) => key.startsWith(CHUNK) && storage.data.get(key) === SECRET_B64)
  assert.equal(planted.size, 4)
  const response = await call(storage, '/_mirror/delta', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(await envelope(storage, 2, [['/dsh/home/auma/later.md', file('later\n')], [NOTE, { kind: 'gone' }]])) })
  assert.equal(response.status, 200)
  assert.equal((await response.json()).ok, true)
  for (const [key, value] of planted) assert.deepEqual(storage.data.get(key), value, key)
  for (const [key, value] of chunks) assert.equal(storage.data.get(key), value, key)
  const text = await snapshotText(storage)
  assert.deepEqual(JSON.parse(text).entries.map(([path]) => path), ['/dsh/home/auma', '/dsh/home/auma/later.md'])
  assert.deepEqual(JSON.parse(text).resetPaths, [NOTE])
  assert.equal(leaks(text), false)
})

test('a retained conflict download holds back secret-shaped entries and says how many', async () => {
  const storage = await mirrorWithPlantedRows()
  const batch = { id: `${CLIENT}:9`, clientId: CLIENT, seq: 9, cloudBase: { lineageId: LINEAGE, revision: 0 },
    entries: [[TMP, file(SECRET_TEXT)], [NOTE, file('mine\n')], [LOCK, { kind: 'gone' }]] }
  const envelopeBytes = new TextEncoder().encode(JSON.stringify({ v: 2, batch, digest: await mirrorDigest(batch) }))
  const id = 'd'.repeat(64)
  storage.data.set(CONFLICT + id, { id, clientId: CLIENT, batchId: batch.id, seq: 9, digest: 'e'.repeat(64), code: 'MIRROR_GLOBAL_FENCE_CONFLICT',
    cloudBase: batch.cloudBase, observedCloudBase: { lineageId: LINEAGE, revision: 1 }, retainedAt: 1, bytes: envelopeBytes.length, chunks: 1 })
  storage.data.set(`${CONFLICT_CHUNK}${id}:0`, envelopeBytes)
  const response = await call(storage, `/_mirror/conflicts?clientId=${CLIENT}&id=${id}`)
  assert.equal(response.status, 200)
  const text = await response.text()
  const body = JSON.parse(text)
  assert.deepEqual(body.batch.entries.map(([path]) => path), [NOTE])
  assert.equal(body.withheldEntries, 2)
  assert.equal(text.includes(Buffer.from(SECRET_TEXT).toString('base64')), false)
  assert.equal(text.includes('credentials.yaml'), false)
})

// Review fixes (fix(the secret-path rule): review).
const post = async (storage, body) => call(storage, '/_mirror/delta', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

test('a recovery snapshot taken before the rule still restores: its secret-shaped deletion markers are dropped, not refused', async () => {
  // resetPaths exactly as /_mirror/export gave them before the rule: sorted, and naming the credentials temp copies.
  const old = [TMP, LOCK, '/dsh/home/auma/old.md']
  assert.deepEqual(bootstrapResetPaths(old), ['/dsh/home/auma/old.md'])
  // Only well-formed hidden paths are dropped; anything malformed, unsorted or nested still fails closed.
  assert.throws(() => bootstrapResetPaths(['/dsh/home/../.credentials.yaml.tmp']), { code: 'INVALID_MIRROR_PATH' })
  assert.throws(() => bootstrapResetPaths([LOCK, TMP]), { code: 'INVALID_BOOTSTRAP_RESETS' })
  assert.throws(() => bootstrapResetPaths(['/dsh/home/.ssh', '/dsh/home/.ssh/id.tmp']), { code: 'INVALID_BOOTSTRAP_RESETS' })
  const storage = new Storage()
  const begin = await bootstrapMirror(storage, { action: 'begin', seedId: SEED, ballId: 'b'.repeat(64), epoch: 1, mirror: { batchDigests: [], entryCount: 0 }, resetPaths: old })
  assert.equal(begin.phase, 'receiving')
  // Idempotent begin with the same old list is not a conflict.
  assert.equal((await bootstrapMirror(storage, { action: 'begin', seedId: SEED, ballId: 'b'.repeat(64), epoch: 1, mirror: { batchDigests: [], entryCount: 0 }, resetPaths: old })).idempotent, true)
  const committed = await bootstrapMirror(storage, { action: 'commit', seedId: SEED })
  assert.equal(committed.phase, 'ready')
  assert.deepEqual([...storage.data].filter(([key]) => key.startsWith(RESET)).map(([, value]) => value), ['/dsh/home/auma/old.md'])
  const text = await snapshotText(storage)
  assert.deepEqual(JSON.parse(text).resetPaths, ['/dsh/home/auma/old.md'])
  assert.equal(leaks(text), false)
})

test('hidden rows still count toward the combined row limit, so a publish never pushes a later read past it', async () => {
  const storage = new Storage()
  for (let index = 0; index < MIRROR_LIMITS.entries - 2; index += 1) await plantReset(storage, `/dsh/workspace/r${String(index).padStart(5, '0')}`)
  await plantReset(storage, TMP)
  await plantReset(storage, LOCK)
  storage.data.set(BOOTSTRAP, { phase: 'ready', seedId: SEED, lineageId: LINEAGE })
  const response = await post(storage, await envelope(storage, 1, [['/dsh/workspace/zz', { kind: 'gone' }]]))
  assert.equal(response.status, 413)
  assert.equal((await response.json()).code, 'MIRROR_STORAGE_LIMIT')
  // Every read still answers: nothing went past the per-prefix ceiling.
  assert.equal(JSON.parse(await snapshotText(storage)).resetPaths.length, MIRROR_LIMITS.entries - 2)
})

test('a conflict download with no secret-shaped name streams the retained bytes as they are, without parsing them', async () => {
  const storage = await mirrorWithPlantedRows()
  const bytes = new TextEncoder().encode('{"v":2,"batch":{"entries":[["/dsh/home/auma/note.md",{"kind":"gone"}]]') // cut short: never parsed
  const id = 'f'.repeat(64)
  storage.data.set(CONFLICT + id, { id, clientId: CLIENT, batchId: `${CLIENT}:9`, seq: 9, digest: 'e'.repeat(64), code: 'MIRROR_GLOBAL_FENCE_CONFLICT', retainedAt: 1, bytes: bytes.length, chunks: 1 })
  storage.data.set(`${CONFLICT_CHUNK}${id}:0`, bytes)
  const response = await call(storage, `/_mirror/conflicts?clientId=${CLIENT}&id=${id}`)
  assert.equal(response.status, 200)
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes)
})

test('a secret-shaped name cut across two conflict chunks is still found and held back', async () => {
  const storage = await mirrorWithPlantedRows()
  const batch = { id: `${CLIENT}:9`, clientId: CLIENT, seq: 9, cloudBase: { lineageId: LINEAGE, revision: 0 }, entries: [[NOTE, file('mine\n')], [TMP, { kind: 'gone' }]] }
  const bytes = new TextEncoder().encode(JSON.stringify({ v: 2, batch, digest: await mirrorDigest(batch) }))
  const cut = new TextDecoder().decode(bytes).indexOf('credentials.yaml') + 6
  const id = 'a'.repeat(64)
  storage.data.set(CONFLICT + id, { id, clientId: CLIENT, batchId: batch.id, seq: 9, digest: 'e'.repeat(64), code: 'MIRROR_GLOBAL_FENCE_CONFLICT', retainedAt: 1, bytes: bytes.length, chunks: 2 })
  storage.data.set(`${CONFLICT_CHUNK}${id}:0`, bytes.slice(0, cut))
  storage.data.set(`${CONFLICT_CHUNK}${id}:1`, bytes.slice(cut))
  const body = await (await call(storage, `/_mirror/conflicts?clientId=${CLIENT}&id=${id}`)).json()
  assert.deepEqual(body.batch.entries.map(([path]) => path), [NOTE])
  assert.equal(body.withheldEntries, 1)
})

test('an exact replay of a batch the mirror already applied gets its stored receipt, even if it names a path refused since', async () => {
  const storage = new Storage()
  const first = await envelope(storage, 1, [[NOTE, file('hello\n')]])
  assert.equal((await post(storage, first)).status, 200)
  // The same batch as an older browser sent it, before the rule: it also named a credentials temp copy. Its receipt is the
  // one the mirror stored then (the receipt and the client head carry that batch's digest).
  const batch = { ...first.batch, entries: [[TMP, { kind: 'gone' }], [NOTE, file('hello\n')]] }
  const old = { v: 2, batch, digest: await mirrorDigest(batch) }
  for (const [key, value] of storage.data) if (key.startsWith('mirror:v2:receipt:') || key.startsWith('mirror:v2:head:')) storage.data.set(key, { ...value, digest: old.digest })
  const before = structuredClone(storage.data)
  const replay = await post(storage, old)
  assert.equal(replay.status, 200)
  const receipt = await replay.json()
  assert.equal(receipt.replayed, true)
  assert.equal(receipt.digest, old.digest)
  assert.deepEqual(storage.data, before)
  // A batch that was never applied is still refused by the rule, and changes nothing (a file entry: job 3 takes a lone
  // `gone` for such a path as a no-op).
  const fresh = await envelope(storage, 2, [[TMP, file(SECRET_TEXT)]])
  const refused = await post(storage, fresh)
  assert.equal(refused.status, 400)
  assert.equal((await refused.json()).code, 'INVALID_MIRROR_PATH')
  assert.deepEqual(storage.data, before)
})

test('memory-history serves no stored path at all', async () => {
  const storage = await mirrorWithPlantedRows()
  const response = await call(storage, '/_mirror/memory-history')
  assert.equal(response.status, 501)
  assert.equal(leaks(await response.text()), false)
})

// ── Job 2: the same rule where the head, the Mac host and the estate read it ─────────────────────────────────────────

/** Every part a copy of the rule could disagree on, from both lists together (so an extra name in either is caught). */
const partBattery = names => [...names.flatMap(name => [name, `${name}.3fa9.tmp`, `${name}.3fa9c1.tmp`, `.${name}~`, `${name}~`, `${name}-x`, `${name}_bak`,
  `${name}-notes.md`, `${name}.lock.takeover-0123456789abcdef`, `.${name}.swp`, `${name}x`, `x${name}`, `.${name}`, `..${name}`, `${name}.`,
  name.slice(0, -1), name.toUpperCase()]), ...RULE_TABLE.shaped, ...RULE_TABLE.ordinary, 'pepper.v10', 'session.capture', 'HANDOFF.md', 'credentials.md', '.e', '.aukora', '']

test('the leaf module (head, archive and Mac host readers) carries exactly the mirror\'s rule', async () => {
  const edge = await import('../mirror-do.mjs'), leaf = await import('../mirror-secret-paths.mjs')
  assert.deepEqual([...leaf.MIRROR_SECRET_NAMES], [...edge.MIRROR_SECRET_NAMES])
  assert.deepEqual([...leaf.MIRROR_SECRET_PREFIXES], [...edge.MIRROR_SECRET_PREFIXES])
  assert.equal(String(leaf.MIRROR_SECRET_SUFFIX), String(edge.MIRROR_SECRET_SUFFIX))
  for (const part of partBattery([...edge.MIRROR_SECRET_NAMES, ...edge.MIRROR_SECRET_PREFIXES, ...leaf.MIRROR_SECRET_NAMES, ...leaf.MIRROR_SECRET_PREFIXES])) {
    assert.equal(leaf.secretShapedPart(part), edge.secretShapedPart(part), part)
  }
  for (const path of [TMP, LOCK, CAP_TMP, NOTE, '/dsh/home/auma/aumlok/pepper.v1']) assert.equal(leaf.secretShapedPath(path), path.split('/').some(edge.secretShapedPart), path)
})

const SHAPED = [TMP, LOCK, CAP_TMP, '/dsh/home/auma/aumlok/pepper.v1', '/dsh/home/auma/aumlok/pepper.v1.next', '/dsh/workspace/.ssh.bak/config', '/dsh/home/credentials.yaml.bak']
const PLAIN = [NOTE, '/dsh/home/auma/seed/receipts.v3.jsonl', '/dsh/home/auma/notes/pepper.v10', '/dsh/workspace/credentials.md', '/dsh/home/auma/session.capture',
  '/dsh/home/auma/.conflict-backup/note.md', '/dsh/workspace/.ssh-config-docs/readme.md', '/dsh/home/auma/credentials.yaml-notes.md', '/dsh/home/.transport-notes']

test('a mirror update notification never names a secret-shaped path, and still names every path the mirror admits', async () => {
  const { createMirrorUpdate, validateMirrorUpdate } = await import('../head-do.mjs')
  const receipt = { seq: 1, clientId: CLIENT, acknowledgedAt: 1700000000000 }
  for (const path of SHAPED) {
    assert.throws(() => createMirrorUpdate(receipt, [path]), { code: 'MIRROR_UPDATE_INVALID' }, path)
    const update = createMirrorUpdate(receipt, [NOTE])
    assert.throws(() => validateMirrorUpdate({ ...update, changedPaths: [path] }), { code: 'MIRROR_UPDATE_INVALID' }, path)
  }
  for (const path of PLAIN) assert.deepEqual(createMirrorUpdate(receipt, [path]).changedPaths, [path], path)
  // Never stricter than the mirror: a path the mirror admits always gets its notification.
  for (const path of [...SHAPED, ...PLAIN].filter(path => !mirrorPathExcluded(path))) assert.deepEqual(createMirrorUpdate(receipt, [path]).changedPaths, [path], path)
})

test('the Mac host (server/local-host.mjs) refuses, never walks and never lists a secret-shaped path', async () => {
  const { readFile } = await import('node:fs/promises')
  const { runInNewContext } = await import('node:vm')
  const leaf = await import('../mirror-secret-paths.mjs')
  const source = await readFile(new URL('../../../../server/local-host.mjs', import.meta.url), 'utf8')
  assert.ok(source.includes("import { secretShapedPart } from '../deploy/cloudflare/src/mirror-secret-paths.mjs'"))
  // Evaluate only this pure function: importing the host would start it.
  const start = source.indexOf('function isSensitiveFilename(p) {'), end = source.indexOf('/** Map a VFS path', start)
  assert.ok(start >= 0 && end > start)
  const sensitive = runInNewContext(source.slice(start, end) + '\nisSensitiveFilename', { secretShapedPart: leaf.secretShapedPart, String })
  for (const path of [...SHAPED, '/dsh/home/.credentials.yaml', '/dsh/home/auma/.env.local', '/dsh/home/.aukora-x6-vault/x', '/dsh/workspace/.DS_Store',
    '.credentials.yaml.3fa9c1.tmp', 'auma/session.cap.tmp']) assert.equal(sensitive(path), true, path)
  for (const path of PLAIN) assert.equal(sensitive(path), false, path)
})

test('the estate counts only her rows; entries matching the secret-path rule are reported apart, as a number and one plain line', async () => {
  const { MirrorDO } = await import('../mirror-do.mjs')
  const estate = async storage => {
    storage.data.set(BOOTSTRAP, { phase: 'ready', seedId: SEED, ballId: 'b'.repeat(64), epoch: 2, lineageId: LINEAGE, batchDigests: [], entryCount: 2 })
    const object = new MirrorDO({ storage }, {})
    const response = await object.fetch(new Request('https://x61.internal/_mirror/estate', { headers: { 'x-x6-internal-authorized': '1', 'x-x6-bootstrap-seed': SEED } }))
    const text = await response.text()
    assert.equal(response.status, 200, text)
    return text
  }
  const plain = new Storage()
  assert.equal((await publishMirror(plain, await envelope(plain, 1, [['/dsh/home/auma', { kind: 'dir', mode: 0o755 }], [NOTE, file('hello\n')]]))).ok, true)
  const before = JSON.parse(await estate(plain))
  const plantedText = await estate(await mirrorWithPlantedRows())
  const planted = JSON.parse(plantedText)
  // The previous build reads these fields only: same names, same values.
  for (const key of ['ok', 'schema', 'entryCount', 'fileCount', 'directoryCount', 'highWater', 'snapshotETag']) assert.deepEqual(planted[key], before[key], key)
  assert.equal(planted.entryCount, 2)
  assert.equal(planted.fileCount, 1)
  assert.deepEqual([before.withheldEntries, before.pathRuleNote], [0, 'entries withheld by the secret-path rule: 0'])
  assert.deepEqual([planted.withheldEntries, planted.pathRuleNote], [2, 'entries withheld by the secret-path rule: 2'])
  // The Continuity card draws every field whose name does not look secret (EstateCell SECRET): both would be drawn.
  for (const key of ['withheldEntries', 'pathRuleNote']) assert.doesNotMatch(key, /secret|private|seed|token|credential|session/i)
  assert.equal(leaks(plantedText), false)
  assert.equal(/copies of secret/i.test(plantedText), false)
})

// ── Job 4: the review's SHOULD items ─────────────────────────────────────────────────────────────────────────────────

test('job 4: a mixed batch notifies its ordinary paths only; a batch of no-op markers notifies nothing', async () => {
  const storage = new Storage()
  const notices = []
  const send = async body => handleMirrorRequest(new Request('https://x61.internal/_mirror/delta', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body) }), storage, { authorized: true, onUpdated: update => { notices.push(update) } })
  assert.equal((await send(await envelope(storage, 1, [['/dsh/home/auma', { kind: 'dir', mode: 0o755 }]]))).status, 200)
  notices.length = 0
  const mixed = await send(await envelope(storage, 2, [[TMP, { kind: 'gone' }], [NOTE, file('hello\n')], [LOCK, { kind: 'gone' }]]))
  assert.equal(mixed.status, 200)
  assert.equal(notices.length, 1, 'the ordinary change is announced, not dropped with the markers')
  assert.deepEqual(notices[0].changedPaths, [NOTE])
  assert.equal(notices[0].changedPathsTruncated, false)
  notices.length = 0
  assert.equal((await send(await envelope(storage, 3, [[TMP, { kind: 'gone' }]]))).status, 200)
  assert.deepEqual(notices, [], 'nothing changed, nothing is announced')
})

test('job 4: a redacted conflict download keeps the original digest and says what it covers and how many entries were withheld', async () => {
  const storage = await mirrorWithPlantedRows()
  const batch = { id: `${CLIENT}:9`, clientId: CLIENT, seq: 9, cloudBase: { lineageId: LINEAGE, revision: 0 },
    entries: [[TMP, file(SECRET_TEXT)], [NOTE, file('mine\n')], [LOCK, { kind: 'gone' }]] }
  const digest = await mirrorDigest(batch)
  const bytes = new TextEncoder().encode(JSON.stringify({ v: 2, batch, digest }))
  const id = 'b'.repeat(64)
  storage.data.set(CONFLICT + id, { id, clientId: CLIENT, batchId: batch.id, seq: 9, digest: 'e'.repeat(64), code: 'MIRROR_GLOBAL_FENCE_CONFLICT', retainedAt: 1, bytes: bytes.length, chunks: 1 })
  storage.data.set(`${CONFLICT_CHUNK}${id}:0`, bytes)
  const body = await (await call(storage, `/_mirror/conflicts?clientId=${CLIENT}&id=${id}`)).json()
  assert.equal(body.digest, digest, 'the digest still names the batch as the browser queued it')
  assert.notEqual(await mirrorDigest(body.batch), digest, 'and is not the digest of the redacted entries')
  assert.equal(body.withheldEntries, 2)
  assert.match(body.digestCovers, /^the batch as sent, before the entries matching the secret-path rule were withheld/)
})

test('job 4: an exact replay of an applied batch holding a now-refused FILE or DIRECTORY entry gets its receipt before the rule', async () => {
  for (const wire of [file(SECRET_TEXT), { kind: 'dir', mode: 0o700 }]) {
    const storage = new Storage()
    const first = await envelope(storage, 1, [[NOTE, file('hello\n')]])
    assert.equal((await post(storage, first)).status, 200)
    // The batch as an older browser sent it and an older mirror applied it: a credentials temp copy as a file (or a
    // directory) beside her note. Its stored receipt and client head carry that batch's digest.
    const batch = { ...first.batch, entries: [[TMP, wire], [NOTE, file('hello\n')]] }
    const old = { v: 2, batch, digest: await mirrorDigest(batch) }
    for (const [key, value] of storage.data) if (key.startsWith('mirror:v2:receipt:') || key.startsWith('mirror:v2:head:')) storage.data.set(key, { ...value, digest: old.digest })
    const before = structuredClone(storage.data)
    const replay = await post(storage, old)
    assert.equal(replay.status, 200, wire.kind)
    const receipt = await replay.json()
    assert.equal(receipt.replayed, true, wire.kind)
    assert.equal(receipt.digest, old.digest)
    assert.deepEqual(storage.data, before, wire.kind)
    // The same id with other bytes is no receipt: the path rule answers first, nothing changes.
    const other = { ...batch, entries: [[TMP, wire]] }
    const refused = await post(storage, { v: 2, batch: other, digest: await mirrorDigest(other) })
    assert.equal(refused.status, 400, wire.kind)
    assert.equal((await refused.json()).code, 'INVALID_MIRROR_PATH')
    assert.deepEqual(storage.data, before, wire.kind)
  }
})

// ── Review of job 4: the rule answers in time linear in the name, whatever the name ──────────────────────────────────────

/**
 * A name built to make an ambiguous suffix grammar backtrack: a secret name, then digit segments each of which both the
 * hex and the digits tokens match, then one character that fails the rule. Grows to a full 255-byte part (n = 34).
 */
const digitChain = n => 'credentials.yaml' + '.111111'.repeat(n) + 'x'
/** Each call, from 170 bytes up to 255, answers within 50 ms (growing, so an exponential rule fails early, not after hours). */
const assertPrompt = (label, call) => {
  for (let n = 22; n <= 34; n += 1) {
    const part = digitChain(n)
    const started = performance.now()
    call(part)
    const elapsed = performance.now() - started
    assert.ok(elapsed < 50, `${label}: a ${part.length}-byte part took ${elapsed.toFixed(1)} ms`)
  }
  assert.equal(Buffer.byteLength(digitChain(34)), 255)
}

test('review: every edge reader of the rule answers a 255-byte chain of digit segments within 50 ms, and calls it ordinary', async () => {
  const leaf = await import('../mirror-secret-paths.mjs')
  assertPrompt('leaf secretShapedPart', part => assert.equal(leaf.secretShapedPart(part), false))
  assertPrompt('leaf secretShapedPath', part => assert.equal(leaf.secretShapedPath(`/dsh/home/auma/${part}`), false))
  assertPrompt('edge secretShapedPart', part => assert.equal(secretShapedPart(part), false))
  assertPrompt('edge validateMirrorPath', part => assert.equal(validateMirrorPath(`/dsh/home/auma/${part}`), `/dsh/home/auma/${part}`))
  assertPrompt('edge hiddenStoredPath', part => assert.equal(hiddenStoredPath(`/dsh/home/auma/${part}`), false))
  assertPrompt('edge mirrorPathExcluded', part => assert.equal(mirrorPathExcluded(`/dsh/home/auma/${part}`), false))
  // The same chain WITHOUT the failing character is a backup sibling by the rule: the language is unchanged.
  for (const n of [1, 5, 34]) assert.equal(secretShapedPart(digitChain(n).slice(0, -1)), true, String(n))
  for (const token of ['12345', '123456', '1'.repeat(64), '1'.repeat(65), '1'.repeat(200), 'abcdef', 'ABCDEF0123', '0'.repeat(64) + 'f']) {
    assert.equal(secretShapedPart(`credentials.yaml.${token}`), /^(?:[0-9a-fA-F]{6,64}|[0-9]+)$/.test(token), token)
  }
})

// ── Job 5: the dotted stem and the trailing tilde are in the rule; the ETag names the rule ──────

/**
 * The longest chain a 255-byte part allows with `takeover` and `~` in it: the dotted stem, `~takeover~111111` segments
 * (each `111111` is hex and only hex), then a single trailing `~`. `shaped` ends on that tilde; `poisoned` puts one
 * character the rule fails in its place, so an engine that retries splits does so over the whole chain.
 */
const takeoverChain = () => {
  const body = '..credentials.yaml' + '~takeover~111111'.repeat(14) + '.111111' + '.1234'
  return { shaped: body + '~', poisoned: body + 'x' }
}

test('job 5: a listed name with one extra leading dot, or a trailing tilde after the stem or a suffix, is refused as a new FILE; the ordinary look-alikes are admitted', async () => {
  const refused = ['/dsh/home/.session.cap', '/dsh/home/auma/.ed25519-keypair.json', '/dsh/home/..credentials.yaml', '/dsh/home/.session.cap~',
    '/dsh/home/credentials.yaml.bak~', '/dsh/home/.credentials.yaml.lock.takeover-0123456789abcdef', '/dsh/home/auma/.session.cap/inside.md']
  for (const path of refused) {
    const storage = new Storage()
    const before = structuredClone(storage.data)
    const response = await post(storage, await envelope(storage, 1, [[path, file(SECRET_TEXT)]]))
    assert.equal(response.status, 400, path)
    assert.equal((await response.json()).code, 'INVALID_MIRROR_PATH', path)
    assert.deepEqual(storage.data, before, path)
    assert.equal(hiddenStoredPath(path), true, path)
  }
  const admitted = ['/dsh/home/auma/credentials.yaml-notes.md', '/dsh/home/auma/session.cap.md', '/dsh/home/.transport-notes',
    '/dsh/workspace/.ssh-config-docs/readme.md', '/dsh/home/auma/session.capture', '/dsh/home/auma/pepper.v10', '/dsh/home/auma/.session.capx',
    '/dsh/home/auma/session.cap.takeover-notes.md']
  const storage = new Storage()
  const response = await post(storage, await envelope(storage, 1, [['/dsh/home/auma', { kind: 'dir', mode: 0o755 }], ['/dsh/workspace/.ssh-config-docs', { kind: 'dir', mode: 0o755 }],
    ...admitted.map(path => [path, file('ordinary\n')])]))
  assert.equal(response.status, 200, await response.clone().text())
  const entries = JSON.parse(await snapshotText(storage)).entries.map(([path]) => path)
  for (const path of admitted) assert.ok(entries.includes(path), path)
})

test('job 5: the longest takeover-and-tilde chain a 255-byte part allows is judged within 50 ms by every edge reader', async () => {
  const leaf = await import('../mirror-secret-paths.mjs')
  const { shaped, poisoned } = takeoverChain()
  assert.deepEqual([Buffer.byteLength(shaped), Buffer.byteLength(poisoned)], [255, 255])
  for (const [part, expected] of [[shaped, true], [poisoned, false]]) {
    const path = `/dsh/home/auma/${part}`
    for (const [label, call, answer] of [
      ['leaf secretShapedPart', () => leaf.secretShapedPart(part), expected],
      ['leaf secretShapedPath', () => leaf.secretShapedPath(path), expected],
      ['edge secretShapedPart', () => secretShapedPart(part), expected],
      ['edge hiddenStoredPath', () => hiddenStoredPath(path), expected],
      ['edge mirrorPathExcluded', () => mirrorPathExcluded(path), expected],
    ]) {
      const started = performance.now()
      const result = call()
      const elapsed = performance.now() - started
      assert.deepEqual([label, part.slice(-2), result], [label, part.slice(-2), answer])
      assert.ok(elapsed < 50, `${label}: took ${elapsed.toFixed(1)} ms`)
    }
  }
})

/**
 * The rule's fingerprint per MIRROR_SECRET_RULE_VERSION. When the rule changes, this fails: bump the version (every
 * snapshot validator issued under the old rule then misses, and a reader gets the new bytes) and record the new one.
 */
const RULE_FINGERPRINTS = { 5: '4c19d83479457afc9f8cb6a8ec6d763f25387f2818935ce383b5eb057794dd61' }

test('job 5: the snapshot ETag carries the rule version; the rule cannot change without it', async () => {
  const leaf = await import('../mirror-secret-paths.mjs')
  const { createHash } = await import('node:crypto')
  const fingerprint = createHash('sha256').update(JSON.stringify([leaf.MIRROR_SECRET_NAMES, leaf.MIRROR_SECRET_PREFIXES,
    String(leaf.MIRROR_SECRET_SUFFIX), String(leaf.secretFamily), String(leaf.secretShapedPart)])).digest('hex')
  assert.ok(Number.isSafeInteger(leaf.MIRROR_SECRET_RULE_VERSION) && leaf.MIRROR_SECRET_RULE_VERSION >= 5)
  assert.equal(fingerprint, RULE_FINGERPRINTS[leaf.MIRROR_SECRET_RULE_VERSION], 'the rule changed: bump MIRROR_SECRET_RULE_VERSION and record its fingerprint')
})

test('job 5: an old snapshot validator gets 200 with the filtered bytes once the representation changed; the current one gets 304 every time; the fence never moves', async () => {
  const storage = new Storage()
  assert.equal((await post(storage, await envelope(storage, 1, [['/dsh/home/auma', { kind: 'dir', mode: 0o755 }], [NOTE, file('hello\n')]]))).status, 200)
  // A row the previous rule admitted (a dotted stem with no suffix), as the live mirror may hold it.
  await plantFile(storage, '/dsh/home/.session.cap')
  storage.data.set(BOOTSTRAP, { phase: 'ready', seedId: SEED, lineageId: LINEAGE })
  const fence = structuredClone(storage.data.get(FENCE))
  const route = '/api/snapshot?snapshotFormat=x61-mirror-snapshot%2Fv2'
  // The validator an edge issued before the representation carried a version (54ef8b0f and earlier) for this same fence.
  const old = `"x61-mirror-snapshot-v2:${fence.lineageId}:${fence.revision}"`
  const first = await call(storage, route, { headers: { 'if-none-match': old } })
  assert.equal(first.status, 200)
  const text = await first.text()
  assert.equal(text.includes('.session.cap'), false)
  assert.equal(text.includes(SECRET_B64), false)
  assert.deepEqual(JSON.parse(text).entries.map(([path]) => path), ['/dsh/home/auma', NOTE])
  const current = first.headers.get('etag')
  assert.notEqual(current, old)
  assert.match(current, /^"x61-mirror-snapshot-v2:[0-9a-f-]{36}:[0-9]{1,16}:r[0-9]{1,6}"$/)
  for (const tag of [old, 'W/' + old]) assert.equal((await call(storage, route, { headers: { 'if-none-match': tag } })).status, 200, tag)
  for (let round = 0; round < 2; round += 1) {
    const again = await call(storage, route, { headers: { 'if-none-match': current } })
    assert.equal(again.status, 304)
    assert.equal(again.headers.get('etag'), current)
  }
  // An older validator in If-Match is refused rather than served as if it described these bytes.
  assert.equal((await call(storage, route, { headers: { 'if-match': old } })).status, 412)
  assert.equal((await call(storage, route, { headers: { 'if-match': current } })).status, 200)
  // The status route and the estate name the same tag; the cloud fence did not advance.
  assert.equal((await (await call(storage, '/_mirror/status?compact=1')).json()).snapshotETag, current)
  assert.deepEqual(storage.data.get(FENCE), fence)
})
