/**
 * the Mac host is never blocked by an old queued save. A save queued by an older page names a
 * credentials temp copy or lock as `gone`; under the secret-shaped rule the host must take it as an applied no-op, answer
 * an exact replay of a batch it already applied with its stored receipt before any entry rule runs, and finish an
 * interrupted pending batch that holds such an entry. A file or directory entry for such a path is still refused.
 * The real publisher (mirror-store.mjs) with the host's real validator, preflight and apply, evaluated from
 * server/local-host.mjs without starting the host, over a throwaway mirror directory.
 */
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { atomicMirrorWrite, createMirrorPublisher } from './mirror-store.mjs'
import { secretShapedPart } from '../deploy/cloudflare/src/mirror-secret-paths.mjs'

const CLIENT = '00000000-0000-4000-8000-0000000000aa'
const TMP = '/dsh/home/.credentials.yaml.3fa9c1d2e4b5.tmp'
const LOCK = '/dsh/home/.credentials.yaml.lock'
const NOTE = '/dsh/home/auma/note.md'
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex')
const file = text => ({ kind: 'file', mode: 0o600, mtimeMs: 1700000000000, b64: Buffer.from(text).toString('base64') })
const envelope = (seq, entries) => {
  const batch = { id: `${CLIENT}:${seq}`, clientId: CLIENT, seq, entries }
  return { batch, digest: sha256(JSON.stringify(batch)) }
}

/** The host's own mirror functions, from its source, bound to a throwaway mirror directory. */
async function hostMirror(t) {
  const root = await fsp.mkdtemp(path.join(await fsp.realpath(os.tmpdir()), 'x61-mirror-secret-'))
  t.after(() => fsp.rm(root, { recursive: true, force: true }))
  const MIRROR_DIR = path.join(root, 'mirror')
  await fsp.mkdir(path.join(MIRROR_DIR, 'home'), { recursive: true })
  await fsp.mkdir(path.join(MIRROR_DIR, 'workspace'), { recursive: true })
  const source = await fsp.readFile(new URL('./local-host.mjs', import.meta.url), 'utf8')
  const start = source.indexOf('function isSensitiveFilename(p) {'), end = source.indexOf('async function walkMirrorRoot(', start)
  assert.ok(start > 0 && end > start, 'the host\'s mirror functions are where this test reads them')
  const history = []
  const host = runInNewContext(source.slice(start, end) + '\n({ validateMirrorEntries, preflightMirrorEntries, applyMirrorDelta, withheldMirrorEntry })', {
    secretShapedPart, path, fs, fsp, Buffer, process, atomicMirrorWrite, MIRROR_DIR,
    MIRROR_HOME_DIR: path.join(MIRROR_DIR, 'home'), MIRROR_WORKSPACE_DIR: path.join(MIRROR_DIR, 'workspace'),
    memoryHistory: { beforeApply: async diskPath => { history.push(diskPath) } },
  })
  const directory = path.join(MIRROR_DIR, '.transport')
  const publisher = (overrides = {}) => createMirrorPublisher({ directory, apply: host.applyMirrorDelta, validateEntries: host.validateMirrorEntries,
    preflightEntries: host.preflightMirrorEntries, readSnapshot: async () => 'snapshot-read', withheldEntry: host.withheldMirrorEntry, ...overrides })
  const disk = vfsPath => path.join(MIRROR_DIR, 'home', vfsPath.slice('/dsh/home/'.length))
  const exists = vfsPath => fsp.lstat(disk(vfsPath)).then(() => true, () => false)
  const homeListing = async () => (await fsp.readdir(path.join(MIRROR_DIR, 'home'), { recursive: true })).sort()
  return { host, publisher, directory, disk, exists, homeListing, history }
}

test('a save an older page boot queued (temp copy and lock, both gone) is applied as a no-op; nothing is written; later saves flow', async t => {
  const mirror = await hostMirror(t)
  const publisher = mirror.publisher()
  const old = envelope(1, [[TMP, { kind: 'gone' }], [LOCK, { kind: 'gone' }]])
  const ack = await publisher.publish(old)
  // What idb-persist's drain requires under the Mac host: ok, the same id and digest, every entry applied.
  assert.equal(ack.ok, true, JSON.stringify(ack))
  assert.equal(ack.id, old.batch.id)
  assert.equal(ack.digest, old.digest)
  assert.equal(ack.applied, 2)
  assert.deepEqual(await mirror.homeListing(), [])
  assert.deepEqual(mirror.history, [], 'a no-op never reaches memory history')
  const mixed = await publisher.publish(envelope(2, [[NOTE, file('hello\n')], ['/dsh/home/auma/session.cap.3fa9c1.tmp', { kind: 'gone' }]]))
  assert.equal(mixed.ok, true, JSON.stringify(mixed))
  assert.equal(mixed.applied, 2)
  assert.equal(await fsp.readFile(mirror.disk(NOTE), 'utf8'), 'hello\n')
  assert.deepEqual(await mirror.homeListing(), ['auma', 'auma/note.md'])
  const later = await publisher.publish(envelope(3, [[NOTE, file('later\n')]]))
  assert.equal(later.ok, true, JSON.stringify(later))
  assert.equal(await fsp.readFile(mirror.disk(NOTE), 'utf8'), 'later\n')
  assert.equal(await publisher.snapshot(), 'snapshot-read')
})

test('a file or directory entry for a secret-shaped path is still refused 400 INVALID_MIRROR_PATH, and nothing is written', async t => {
  const mirror = await hostMirror(t)
  const publisher = mirror.publisher()
  for (const wire of [file('records: SYNTHETIC\n'), { kind: 'dir', mode: 0o700 }]) {
    for (const entries of [[[TMP, wire]], [[TMP, { kind: 'gone' }], [TMP, wire]], [[NOTE, file('held back\n')], [LOCK, wire]]]) {
      const refused = await publisher.publish(envelope(1, entries))
      assert.equal(refused.ok, false, JSON.stringify(entries))
      // The host names a rule in `error` (its validator throws plain errors); the status says the batch is refused.
      assert.equal(refused.status, 400)
      assert.equal(refused.error, 'INVALID_MIRROR_PATH')
    }
  }
  // A `gone` the rule cannot vouch for (malformed, an immutable ball path, .DS_Store) is refused as before.
  for (const vfsPath of ['/dsh/home/../.credentials.yaml.tmp', '/dsh/home/balls/.credentials.yaml.tmp', '/elsewhere/.credentials.yaml.tmp',
    '/dsh/home/.DS_Store', '/dsh/home/.DS_Store/.credentials.yaml.tmp']) {
    const refused = await publisher.publish(envelope(1, [[vfsPath, { kind: 'gone' }]]))
    assert.equal(refused.status, 400, vfsPath)
    assert.equal(refused.error, 'INVALID_MIRROR_PATH', vfsPath)
  }
  assert.deepEqual(await mirror.homeListing(), [])
  assert.equal(fs.existsSync(path.join(mirror.directory, 'pending.json')), false)
  assert.equal((await mirror.publisher().publish(envelope(1, [[NOTE, file('first\n')]]))).ok, true)
})

test('a lost acknowledgement: the exact replay of a batch applied under the older rule gets its stored receipt before the path rule', async t => {
  const mirror = await hostMirror(t)
  // The host before the rule admitted a temp FILE beside her note (its validator knew only exact names).
  const old = envelope(1, [[TMP, file('records: SYNTHETIC\n')], [NOTE, file('hello\n')]])
  const olderHost = mirror.publisher({ validateEntries: async () => {}, preflightEntries: async () => {}, apply: async entries => entries.length })
  const first = await olderHost.publish(old)
  assert.equal(first.ok, true, JSON.stringify(first))
  // The browser never saw that answer and retries the exact batch against today's host.
  const publisher = mirror.publisher()
  const replay = await publisher.publish(old)
  assert.equal(replay.ok, true, JSON.stringify(replay))
  assert.equal(replay.replayed, true)
  assert.equal(replay.digest, old.digest)
  assert.equal(replay.acknowledgedAt, first.acknowledgedAt)
  // The same id with different bytes is a conflict, never a receipt; a batch never applied is judged by the rule.
  const changed = envelope(1, [[TMP, file('records: OTHER\n')], [NOTE, file('hello\n')]])
  assert.equal((await publisher.publish(changed)).code, 'MIRROR_REPLAY_CONFLICT')
  const fresh = await publisher.publish(envelope(2, [[TMP, file('records: SYNTHETIC\n')]]))
  assert.equal(fresh.error, 'INVALID_MIRROR_PATH')
  assert.equal(fresh.status, 400)
  assert.equal(await mirror.exists(TMP), false)
  assert.equal((await publisher.publish(envelope(2, [[NOTE, file('next\n')]]))).ok, true)
})

test('an interrupted pending batch holding such a `gone` is finished on the next snapshot and publish, and nothing blocks', async t => {
  const mirror = await hostMirror(t)
  await fsp.mkdir(mirror.directory, { recursive: true })
  // The host stopped after journaling this batch (and applying its first entry) under the older rule.
  const pending = envelope(1, [[TMP, { kind: 'gone' }], [LOCK, { kind: 'gone' }], [NOTE, file('kept through the restart\n')]])
  await fsp.writeFile(path.join(mirror.directory, 'pending.json'), JSON.stringify(pending) + '\n')
  await fsp.writeFile(path.join(mirror.directory, 'pending-progress.json'), JSON.stringify({ id: pending.batch.id, digest: pending.digest, applied: 1 }) + '\n')
  const publisher = mirror.publisher()
  assert.equal(await publisher.snapshot(), 'snapshot-read')
  assert.equal(fs.existsSync(path.join(mirror.directory, 'pending.json')), false)
  assert.equal(await fsp.readFile(mirror.disk(NOTE), 'utf8'), 'kept through the restart\n')
  assert.equal(await mirror.exists(TMP), false)
  // The browser's retry of that batch gets its receipt; its next save applies.
  const retry = await publisher.publish(pending)
  assert.equal(retry.ok, true, JSON.stringify(retry))
  assert.equal(retry.replayed, true)
  assert.equal(retry.applied, 3)
  assert.equal((await publisher.publish(envelope(2, [[NOTE, file('after\n')]]))).ok, true)
  assert.equal(await fsp.readFile(mirror.disk(NOTE), 'utf8'), 'after\n')
})

test('the host takes as a no-op the `gone` entries the edge takes as one (paths the edge would hide)', async t => {
  const { hiddenStoredPath } = await import('../deploy/cloudflare/src/mirror-do.mjs')
  const { host } = await hostMirror(t)
  const accepted = vfsPath => { try { host.validateMirrorEntries([[vfsPath, { kind: 'gone' }]]); return true } catch { return false } }
  for (const vfsPath of [TMP, LOCK, '/dsh/home/auma/session.cap.tmp', '/dsh/home/auma/aumlok/pepper.v1.next', '/dsh/workspace/.ssh.bak/config',
    '/dsh/home/.env.local', '/dsh/home/.aukora-x6-vault/x', '/dsh/home/credentials.yaml.bak']) {
    assert.equal(hiddenStoredPath(vfsPath), true, vfsPath)
    assert.equal(accepted(vfsPath), true, vfsPath)
  }
  assert.equal(secretShapedPart('note.md'), false)
  assert.equal(accepted(NOTE), true, 'an ordinary deletion is validated as before')
})

// ── Job 4: crash recovery consults the receipt before the current rule; an unreceipted older batch never blocks ─────────

test('job 4: a crash after the receipt was written: recovery takes the receipt before the rule, even for a now-refused FILE entry', async t => {
  const mirror = await hostMirror(t)
  // An older host applied this batch (its validator knew exact names only) and wrote the receipt, then stopped before
  // removing pending.json.
  const old = envelope(1, [[TMP, file('records: SYNTHETIC\n')], [NOTE, file('hello\n')]])
  const olderHost = mirror.publisher({ validateEntries: async () => {}, preflightEntries: async () => {}, apply: async entries => entries.length })
  const first = await olderHost.publish(old)
  assert.equal(first.ok, true, JSON.stringify(first))
  await fsp.writeFile(path.join(mirror.directory, 'pending.json'), JSON.stringify({ batch: old.batch, digest: old.digest }) + '\n')
  await fsp.writeFile(path.join(mirror.directory, 'pending-progress.json'), JSON.stringify({ id: old.batch.id, digest: old.digest, applied: 2 }) + '\n')
  const publisher = mirror.publisher()
  assert.equal(await publisher.snapshot(), 'snapshot-read', 'snapshots are not blocked')
  assert.equal(fs.existsSync(path.join(mirror.directory, 'pending.json')), false)
  assert.equal(fs.existsSync(path.join(mirror.directory, 'pending-progress.json')), false)
  const next = await publisher.publish(envelope(2, [[NOTE, file('next\n')]]))
  assert.equal(next.ok, true, JSON.stringify(next))
  assert.equal(await fsp.readFile(mirror.disk(NOTE), 'utf8'), 'next\n')
  assert.equal(await mirror.exists(TMP), false)
})

test('job 4 (review): an unreceipted older pending batch: ordinary entries apply, a matching `gone` is a no-op, a matching FILE is withheld, the batch is receipted and set aside on record, and that browser moves on', async t => {
  const mirror = await hostMirror(t)
  await fsp.mkdir(mirror.directory, { recursive: true })
  const OTHER = '00000000-0000-4000-8000-0000000000bb'
  // Journaled by an older host, never applied: her note, a temp marker, a temp FILE (between write and rename), a later note.
  const batch = { id: `${CLIENT}:1`, clientId: CLIENT, seq: 1, entries: [[NOTE, file('first\n')], [LOCK, { kind: 'gone' }],
    [TMP, file('records: SYNTHETIC\n')], ['/dsh/home/auma/after.md', file('after\n')]] }
  const pending = { batch, digest: sha256(JSON.stringify(batch)) }
  await fsp.writeFile(path.join(mirror.directory, 'pending.json'), JSON.stringify(pending) + '\n')
  const publisher = mirror.publisher()
  const warnings = []
  t.mock.method(console, 'warn', message => { warnings.push(String(message)) })
  // The next publish, from another browser, is not blocked; the set-aside batch is named in a readable record.
  const otherBatch = { id: `${OTHER}:1`, clientId: OTHER, seq: 1, entries: [['/dsh/home/auma/other.md', file('other\n')]] }
  const other = await publisher.publish({ batch: otherBatch, digest: sha256(JSON.stringify(otherBatch)) })
  assert.equal(other.ok, true, JSON.stringify(other))
  assert.equal(await fsp.readFile(mirror.disk(NOTE), 'utf8'), 'first\n', 'the entry before the withheld one is applied')
  assert.equal(await mirror.exists(TMP), false, 'the matching file is never written')
  assert.equal(await fsp.readFile(mirror.disk('/dsh/home/auma/after.md'), 'utf8'), 'after\n', 'the entry after the withheld one is applied too')
  assert.equal(fs.existsSync(path.join(mirror.directory, 'pending.json')), false)
  assert.equal(fs.existsSync(path.join(mirror.directory, 'pending-progress.json')), false)
  const aside = path.join(mirror.directory, 'set-aside')
  const record = JSON.parse(await fsp.readFile(path.join(aside, `${CLIENT}.1.record.json`), 'utf8'))
  assert.equal(record.code, 'MIRROR_PENDING_SET_ASIDE')
  assert.deepEqual([record.id, record.digest, record.entryCount, record.appliedEntries, record.withheldEntries], [batch.id, pending.digest, 4, 3, 1])
  for (const needle of ['credentials', 'SYNTHETIC', 'note.md', 'after.md']) assert.equal(JSON.stringify(record).includes(needle), false, needle)
  assert.deepEqual(JSON.parse(await fsp.readFile(path.join(aside, `${CLIENT}.1.json`), 'utf8')), pending, 'the batch is kept, unchanged')
  assert.ok(warnings.some(line => line.includes('MIRROR_PENDING_SET_ASIDE') && !line.includes('credentials')))
  // The browser that queued it retries the exact batch: it gets the stored receipt (every entry accounted for, one
  // withheld), so its queue moves on; nothing is written again.
  const retry = await publisher.publish(pending)
  assert.equal(retry.ok, true, JSON.stringify(retry))
  assert.equal(retry.replayed, true)
  assert.deepEqual([retry.id, retry.digest, retry.applied, retry.withheldEntries], [batch.id, pending.digest, 4, 1])
  assert.equal(await mirror.exists(TMP), false)
  // Its next save, and the other browser's, flow; snapshots too.
  const mineNext = { id: `${CLIENT}:2`, clientId: CLIENT, seq: 2, entries: [[NOTE, file('second\n')]] }
  const next = await publisher.publish({ batch: mineNext, digest: sha256(JSON.stringify(mineNext)) })
  assert.equal(next.ok, true, JSON.stringify(next))
  assert.equal(await fsp.readFile(mirror.disk(NOTE), 'utf8'), 'second\n')
  assert.equal(await publisher.snapshot(), 'snapshot-read')
  const otherNext = { id: `${OTHER}:2`, clientId: OTHER, seq: 2, entries: [['/dsh/home/auma/other.md', file('other 2\n')]] }
  assert.equal((await publisher.publish({ batch: otherNext, digest: sha256(JSON.stringify(otherNext)) })).ok, true)
  // A NEW batch naming such a file is still refused, as before: only the older host's journal is ever withheld from.
  const fresh = { id: `${CLIENT}:3`, clientId: CLIENT, seq: 3, entries: [[TMP, file('records: SYNTHETIC\n')]] }
  const refused = await publisher.publish({ batch: fresh, digest: sha256(JSON.stringify(fresh)) })
  assert.deepEqual([refused.ok, refused.status, refused.error], [false, 400, 'INVALID_MIRROR_PATH'])
})

test('job 4 (review): a crash while a set-aside batch is being finished resumes from its cursor and receipts it once', async t => {
  const mirror = await hostMirror(t)
  await fsp.mkdir(mirror.directory, { recursive: true })
  const batch = { id: `${CLIENT}:1`, clientId: CLIENT, seq: 1, entries: [[NOTE, file('first\n')], [TMP, file('records: SYNTHETIC\n')],
    ['/dsh/home/auma/after.md', file('after\n')]] }
  const pending = { batch, digest: sha256(JSON.stringify(batch)) }
  await fsp.writeFile(path.join(mirror.directory, 'pending.json'), JSON.stringify(pending) + '\n')
  // The first two entries were already taken (the note applied, the matching file withheld) when the host stopped.
  await fsp.mkdir(path.dirname(mirror.disk(NOTE)), { recursive: true })
  await fsp.writeFile(mirror.disk(NOTE), 'first\n')
  await fsp.writeFile(path.join(mirror.directory, 'pending-progress.json'), JSON.stringify({ id: batch.id, digest: pending.digest, applied: 2 }) + '\n')
  t.mock.method(console, 'warn', () => {})
  const publisher = mirror.publisher()
  assert.equal(await publisher.snapshot(), 'snapshot-read')
  assert.equal(await fsp.readFile(mirror.disk('/dsh/home/auma/after.md'), 'utf8'), 'after\n')
  assert.equal(await mirror.exists(TMP), false)
  const retry = await publisher.publish(pending)
  assert.deepEqual([retry.ok, retry.replayed, retry.applied], [true, true, 3])
  const record = JSON.parse(await fsp.readFile(path.join(mirror.directory, 'set-aside', `${CLIENT}.1.record.json`), 'utf8'))
  assert.deepEqual([record.appliedEntries, record.withheldEntries], [2, 1], 'counted over the whole batch')
})

test('job 4: an unreceipted older pending batch with only ordinary entries and matching `gone` markers is finished and receipted', async t => {
  const mirror = await hostMirror(t)
  await fsp.mkdir(mirror.directory, { recursive: true })
  const pending = envelope(1, [[TMP, { kind: 'gone' }], [NOTE, file('kept\n')], ['/dsh/home/auma/credentials.yaml-notes.md', file('ordinary\n')]])
  await fsp.writeFile(path.join(mirror.directory, 'pending.json'), JSON.stringify(pending) + '\n')
  const publisher = mirror.publisher()
  assert.equal(await publisher.snapshot(), 'snapshot-read')
  assert.equal(await fsp.readFile(mirror.disk(NOTE), 'utf8'), 'kept\n')
  assert.equal(await fsp.readFile(mirror.disk('/dsh/home/auma/credentials.yaml-notes.md'), 'utf8'), 'ordinary\n', 'an ordinary name is written')
  const retry = await publisher.publish(pending)
  assert.equal(retry.ok, true, JSON.stringify(retry))
  assert.equal(retry.replayed, true)
  assert.equal(retry.applied, 3)
  assert.equal(fs.existsSync(path.join(mirror.directory, 'set-aside')), false)
})

// ── Review of job 4: the host's rule answers in time linear in the name; an over-long part never reaches it ──────────────

test('review: the host answers a 255-byte chain of digit segments within 50 ms, and never runs the rule on a part over 255 bytes', async t => {
  const root = await fsp.mkdtemp(path.join(await fsp.realpath(os.tmpdir()), 'x61-mirror-secret-'))
  t.after(() => fsp.rm(root, { recursive: true, force: true }))
  const MIRROR_DIR = path.join(root, 'mirror')
  const source = await fsp.readFile(new URL('./local-host.mjs', import.meta.url), 'utf8')
  const start = source.indexOf('function isSensitiveFilename(p) {'), end = source.indexOf('async function walkMirrorRoot(', start)
  assert.ok(start > 0 && end > start)
  // The real rule, wrapped to record the longest part it is ever asked about.
  let longest = 0
  const counted = part => { longest = Math.max(longest, Buffer.byteLength(String(part))); return secretShapedPart(part) }
  const host = runInNewContext(source.slice(start, end) + '\n({ isSensitiveFilename, validateMirrorEntries })', {
    secretShapedPart: counted, path, fs, fsp, Buffer, process, atomicMirrorWrite, MIRROR_DIR,
    MIRROR_HOME_DIR: path.join(MIRROR_DIR, 'home'), MIRROR_WORKSPACE_DIR: path.join(MIRROR_DIR, 'workspace'), memoryHistory: {},
  })
  // Digit segments that both the hex and the digits tokens match, then a character the rule fails: grown to 255 bytes.
  const chain = n => 'credentials.yaml' + '.111111'.repeat(n) + 'x'
  assert.equal(Buffer.byteLength(chain(34)), 255)
  for (let n = 22; n <= 34; n += 1) {
    const vfsPath = `/dsh/home/auma/${chain(n)}`
    for (const [label, call] of [
      ['isSensitiveFilename', () => assert.equal(host.isSensitiveFilename(vfsPath), false)],
      ['a file entry', () => host.validateMirrorEntries([[vfsPath, file('ordinary\n')]])],
      ['a gone entry', () => host.validateMirrorEntries([[vfsPath, { kind: 'gone' }]])],
    ]) {
      const started = performance.now()
      call()
      const elapsed = performance.now() - started
      assert.ok(elapsed < 50, `${label}: a ${chain(n).length}-byte part took ${elapsed.toFixed(1)} ms`)
    }
  }
  // A `gone` naming a part over 255 bytes is refused on its length before the rule ever reads that part.
  longest = 0
  const overLong = `/dsh/home/auma/${'credentials.yaml' + '.111111'.repeat(40)}`
  assert.throws(() => host.validateMirrorEntries([[overLong, { kind: 'gone' }]]), /INVALID_MIRROR_PATH/)
  assert.ok(longest <= 255, `the rule read a ${longest}-byte part`)
})

// ── Job 5: the set-aside record never claims what has not happened; the host holds the job-5 rule ─────────────────────

test('job 5: a crash between the set-aside record and the receipt leaves a record that says pending, not done; recovery then marks it receipted', async t => {
  const mirror = await hostMirror(t)
  await fsp.mkdir(mirror.directory, { recursive: true })
  const batch = { id: `${CLIENT}:1`, clientId: CLIENT, seq: 1, entries: [[NOTE, file('first\n')], [TMP, file('records: SYNTHETIC\n')],
    ['/dsh/home/auma/after.md', file('after\n')]] }
  const pending = { batch, digest: sha256(JSON.stringify(batch)) }
  await fsp.writeFile(path.join(mirror.directory, 'pending.json'), JSON.stringify(pending) + '\n')
  t.mock.method(console, 'warn', () => {})
  // The host stops while applying the first ordinary entry: the record is on disk, the receipt is not.
  const crashing = mirror.publisher({ apply: async () => { throw Object.assign(new Error('host stopped'), { code: 'HOST_STOPPED' }) } })
  assert.equal(await crashing.snapshot().then(() => 'read', error => error.code), 'HOST_STOPPED')
  const recordPath = path.join(mirror.directory, 'set-aside', `${CLIENT}.1.record.json`)
  const interrupted = JSON.parse(await fsp.readFile(recordPath, 'utf8'))
  assert.equal(fs.existsSync(path.join(mirror.directory, 'pending.json')), true, 'the batch is still journaled')
  assert.equal(interrupted.status, 'pending')
  assert.equal(interrupted.receiptAt, undefined)
  assert.doesNotMatch(interrupted.reason, /\b(are|is|were|was) (applied|receipted)\b/, 'the record claims nothing that has not happened')
  assert.match(interrupted.reason, /receipt/)
  assert.equal(typeof interrupted.receipt, 'string')
  // The next start finishes it: the record now says receipted, with the receipt's own time, and still no path or content.
  assert.equal(await mirror.publisher().snapshot(), 'snapshot-read')
  const done = JSON.parse(await fsp.readFile(recordPath, 'utf8'))
  assert.equal(done.status, 'receipted')
  const receipt = JSON.parse(await fsp.readFile(path.join(mirror.directory, done.receipt), 'utf8'))
  assert.deepEqual([receipt.id, receipt.digest, receipt.withheldEntries, done.receiptAt], [batch.id, pending.digest, 1, receipt.acknowledgedAt])
  assert.deepEqual([done.appliedEntries, done.withheldEntries, done.setAsideAt], [2, 1, interrupted.setAsideAt])
  for (const needle of ['credentials', 'SYNTHETIC', 'note.md', 'after.md']) assert.equal(JSON.stringify(done).includes(needle), false, needle)
})

test('job 5: the host refuses the dotted stem and the trailing tilde, takes the ordinary look-alikes, and answers the takeover chain within 50 ms', async t => {
  const mirror = await hostMirror(t)
  const RULE_TABLE = JSON.parse(await fsp.readFile(new URL('../deploy/cloudflare/src/__tests__/secret-path-rule-table.json', import.meta.url), 'utf8'))
  const source = await fsp.readFile(new URL('./local-host.mjs', import.meta.url), 'utf8')
  const start = source.indexOf('function isSensitiveFilename(p) {'), end = source.indexOf('async function walkMirrorRoot(', start)
  const host = runInNewContext(source.slice(start, end) + '\n({ isSensitiveFilename })', {
    secretShapedPart, path, fs, fsp, Buffer, process, atomicMirrorWrite, MIRROR_DIR: '/nonexistent', MIRROR_HOME_DIR: '/nonexistent/home',
    MIRROR_WORKSPACE_DIR: '/nonexistent/workspace', memoryHistory: {},
  })
  for (const part of RULE_TABLE.shaped) assert.equal(host.isSensitiveFilename(`/dsh/home/auma/${part}`), true, part)
  for (const part of RULE_TABLE.ordinary) assert.equal(host.isSensitiveFilename(`/dsh/home/auma/${part}`), false, part)
  const publisher = mirror.publisher()
  let seq = 0
  for (const vfsPath of ['/dsh/home/.session.cap', '/dsh/home/auma/.ed25519-keypair.json', '/dsh/home/..credentials.yaml', '/dsh/home/.session.cap~',
    '/dsh/home/credentials.yaml.bak~', '/dsh/home/.credentials.yaml.lock.takeover-0123456789abcdef']) {
    const refused = await publisher.publish(envelope(seq + 1, [[vfsPath, file('records: SYNTHETIC\n')]]))
    assert.deepEqual([vfsPath, refused.ok, refused.status, refused.error], [vfsPath, false, 400, 'INVALID_MIRROR_PATH'])
    assert.equal(await mirror.exists(vfsPath), false, vfsPath)
  }
  for (const vfsPath of ['/dsh/home/auma/.session.capx', '/dsh/home/auma/session.cap.takeover-notes.md', '/dsh/home/auma/credentials.yaml-notes.md']) {
    seq += 1
    const ack = await publisher.publish(envelope(seq, [[vfsPath, file('ordinary\n')]]))
    assert.equal(ack.ok, true, JSON.stringify(ack))
    assert.equal(await fsp.readFile(mirror.disk(vfsPath), 'utf8'), 'ordinary\n')
  }
  const body = '..credentials.yaml' + '~takeover~111111'.repeat(14) + '.111111' + '.1234'
  for (const [part, shaped] of [[body + '~', true], [body + 'x', false]]) {
    assert.equal(Buffer.byteLength(part), 255)
    const vfsPath = `/dsh/home/auma/${part}`
    for (const [label, call] of [
      ['isSensitiveFilename', () => assert.equal(host.isSensitiveFilename(vfsPath), shaped)],
      ['a file entry', () => shaped ? assert.throws(() => mirror.host.validateMirrorEntries([[vfsPath, file('x\n')]]), /INVALID_MIRROR_PATH/)
        : mirror.host.validateMirrorEntries([[vfsPath, file('x\n')]])],
      ['a gone entry', () => mirror.host.validateMirrorEntries([[vfsPath, { kind: 'gone' }]])],
    ]) {
      const started = performance.now()
      call()
      const elapsed = performance.now() - started
      assert.ok(elapsed < 50, `${label} (${part.slice(-2)}): took ${elapsed.toFixed(1)} ms`)
    }
  }
})
