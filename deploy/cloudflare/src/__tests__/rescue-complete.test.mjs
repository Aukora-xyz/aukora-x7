/**
 * "complete" means every copied row was checked again and every listing
 * succeeded. The REAL kit over the suite fakes, the REAL verifier (imported) on its packs, and the REAL vault for what her
 * cloud records. Made-up data only.
 *   M1  ONE list of what the copy holds (the index's rows, every kind) is walked by the recheck, in both modes, through the
 *       same `take`/`itemFor` path the first read took: each kind changed or deleted between the passes is NOT complete.
 *   M2  a listing that failed is never an empty listing: it is recorded (`unlisted`, count and shape) and makes the run
 *       NOT complete; a source scan refuses a `catch` that turns a failure into an empty list, array or zero.
 *   S4  a file whose mode moved between the reads is "changed" in the cloud copy too.
 */
import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rescueKit } from '../rescue-kit.mjs'
import { verifyRescuePack } from '../../../../server/rescue-verify.mjs'
import { FakeIndexedDb, FakeLocalStorage, createFakeVault, dirEntry, fakeFsFromEntries, fileEntry, goneEntry } from './rescue-fakes.mjs'
import { createVaultBucket, createVaultBudget, createVaultFetch } from './vault-fakes.mjs'

const DB = 'aukora-x6-vfs'
const MAIN = '/dsh/home/sessions/agent/main/session.v3.jsonl'
const NOTES = '/dsh/home/notes.md'
const OUTSIDE = '/dsh/system/config.json' // a file outside /dsh/home/: the old recheck never read such a row again
const FOLDER = '/dsh/home/auma'
const GONE = '/dsh/home/old.txt'
const META = '@x6-content-revision'
const COUNTER = '@x6-counter' // bookkeeping whose JSON text can get longer and still start with the old text (9 -> 97)
const LOG = 'aukora-auma-live-log-v2:session-1'
const LOCAL = 'localStorage:' + LOG
const SOURCE = name => readFileSync(new URL('../' + name, import.meta.url), 'utf8')
const KIT_TEXT = SOURCE('rescue-kit.mjs')

let made = null
const scratch = () => (made ??= mkdtempSync(join(tmpdir(), 'rescue-complete-test-')))
after(() => { if (made) rmSync(made, { recursive: true, force: true }) })

/** Her store with one row of EVERY kind the copy holds: file, dir, gone, meta (and, in settings, local). */
const entries = () => [
  ['/dsh/home', dirEntry()], [FOLDER, dirEntry()], ['/dsh/home/sessions', dirEntry()], ['/dsh/home/sessions/agent', dirEntry()],
  ['/dsh/home/sessions/agent/main', dirEntry()],
  [MAIN, fileEntry('{"role":"user","text":"x"}\n'.repeat(8), 1700000000000)],
  [NOTES, fileEntry('hello', 1700000000001, 0o644)],
  [OUTSIDE, fileEntry('{"a":1}', 1700000000002, 0o600)],
  [GONE, goneEntry()],
  [META, { kind: 'content-revision', seq: 9 }],
  [COUNTER, 9],
  ['@x6-mirror-meta', { clientId: 'client-A', cloudBase: null }],
]
const settings = () => [[LOG, JSON.stringify([{ role: 'you', text: 'Original words', ts: 1 }])], ['aukora.theme', 'dark']]

/** localStorage that records which values were read, in order. */
class CountingStorage extends FakeLocalStorage {
  got = []
  getItem(name) { this.got.push(name); return super.getItem(name) }
}

const packIndex = async blob => {
  const buffer = Buffer.from(await blob.arrayBuffer())
  const length = Number(buffer.readBigUInt64BE(buffer.length - 19))
  return JSON.parse(buffer.subarray(buffer.length - 19 - length, buffer.length - 19).toString())
}
let packs = 0
/** The REAL verifier on the pack, written under its own name. */
const verifyPack = async result => {
  const path = join(scratch(), String(packs++) + '-' + result.fileName)
  writeFileSync(path, Buffer.from(await result.blob.arrayBuffer()))
  return verifyRescuePack(path)
}

// The marks each mode reports just before its second pass (the second read of every copied row).
const LOCAL_MARK = line => line.startsWith('Reading every')
const CLOUD_MARK = line => line === 'Her cloud is checking this copy.'

/** A local pack; `between(data, ls)` runs once, between the copy and the second pass. */
async function local(between = null, { ls = new CountingStorage(settings()), idb = null, kitOptions = {} } = {}) {
  if (!idb) { idb = new FakeIndexedDb(); idb.seed(DB, entries()) }
  const kit = rescueKit({ indexedDB: idb, localStorage: ls, ...kitOptions })
  let fired = false, mark = 0, readMark = 0
  const result = await kit.saveLocal({ report: line => {
    if (fired || !LOCAL_MARK(line)) return
    fired = true; mark = idb.log.requests.length; readMark = ls && ls.got ? ls.got.length : 0
    if (between) between(idb.data(), ls)
  } })
  assert.ok(fired, 'the second pass was announced')
  return { kit, idb, ls, result, mark, readMark, verified: result.blob ? await verifyPack(result) : null, index: result.blob ? await packIndex(result.blob) : null }
}

/** A cloud copy to the suite's fake vault; `between` runs once, after the list was sent and before the read-back. */
async function cloud(between = null, { ls = new CountingStorage(settings()), idb = null, vault = createFakeVault(), fetch = null } = {}) {
  if (!idb) { idb = new FakeIndexedDb(); idb.seed(DB, entries()) }
  const kit = rescueKit({ indexedDB: idb, localStorage: ls, fetch: fetch ?? vault.fetch, sleep: async () => {} })
  let fired = false, mark = 0, readMark = 0
  const result = await kit.copyToCloud({ report: line => {
    if (fired || !CLOUD_MARK(line)) return
    fired = true; mark = idb.log.requests.length; readMark = ls && ls.got ? ls.got.length : 0
    if (between) between(idb.data(), ls)
  } })
  assert.ok(fired, 'the walk was announced')
  return { kit, idb, ls, vault, result, mark, readMark }
}

// ── The baseline: nothing moves, both modes complete, and every copied row was checked again ──────────────────────

test('baseline: nothing moves between the passes; both modes are complete and the verifier exits 0', async () => {
  const pack = await local()
  assert.equal(pack.result.complete, true, pack.result.line)
  assert.match(pack.result.line, /^Saved a copy on this computer: /)
  assert.equal(pack.verified.code, 0, pack.verified.lines.join('\n'))
  assert.equal(pack.index.completeness.rechecked, pack.index.rows.length)
  assert.deepEqual(pack.index.unlisted, { count: 0, shapes: [] })
  const copy = await cloud()
  assert.equal(copy.result.complete, true, copy.result.line + ' ' + JSON.stringify(copy.result.lines))
  assert.equal(copy.result.rechecked, JSON.parse(new TextDecoder().decode(copy.vault.rescues.get(copy.result.id))).rows.length)
})

// ── M1: THE one list, walked by the recheck, in both modes ─────────────────────────────────────────────────────────

/** Keys read again after `mark`: IndexedDB gets and saved-setting values, as row keys. */
const readAgain = run => [...run.idb.log.requests.slice(run.mark).filter(request => request.method === 'get').map(request => request.key),
  ...run.ls.got.slice(run.readMark).map(name => 'localStorage:' + name)]

test('M1 the one list: the second pass reads EVERY row of the index (every kind) exactly once, in both modes, and says how many', async () => {
  const pack = await local()
  const keys = pack.index.rows.map(row => row.key)
  assert.deepEqual([...new Set(pack.index.rows.map(row => row.type))].sort(), [...pack.kit.ROW_KINDS].sort(), 'this store holds every kind the kit copies')
  assert.deepEqual(readAgain(pack).sort(), [...keys].sort(), 'local: each copied row read again, once, and nothing else')
  assert.equal(pack.result.rechecked, keys.length)
  assert.equal(pack.index.completeness.rechecked, keys.length)
  const copy = await cloud()
  const sent = JSON.parse(new TextDecoder().decode(copy.vault.rescues.get(copy.result.id)))
  assert.deepEqual(readAgain(copy).sort(), sent.rows.map(row => row.key).sort(), 'cloud: each row of the list her cloud holds read again, once')
  assert.equal(copy.result.rechecked, sent.rows.length)
})

test('M1 the one list, structurally: every row kind the kit writes is a kind the recheck judges (the vault and the verifier agree); the scan bites when a kind is added', () => {
  const kit = rescueKit({ indexedDB: null, localStorage: null })
  /** Every `type: '<kind>'` a row is written with in the kit's source. */
  const written = text => [...new Set([...text.matchAll(/\btype:\s*'([a-z]+)'/g)].map(match => match[1]))].sort()
  assert.deepEqual(written(KIT_TEXT), [...kit.ROW_KINDS].sort(), 'the kinds the kit writes ARE the kinds its recheck table judges')
  const vaultKinds = /const ROW_TYPES = new Set\(\[([^\]]*)\]\)/.exec(SOURCE('vault.mjs'))[1].match(/'([a-z]+)'/g).map(name => name.slice(1, -1)).sort()
  assert.deepEqual(vaultKinds, [...kit.ROW_KINDS].sort(), "the vault's row rule names the same kinds")
  const verifier = readFileSync(new URL('../../../../server/rescue-verify.mjs', import.meta.url), 'utf8')
  const block = /const ROW_FIELDS = \{([\s\S]*?)\n\}/.exec(verifier)[1]
  assert.deepEqual([...block.matchAll(/^\s+([a-z]+):/gm)].map(match => match[1]).sort(), [...kit.ROW_KINDS].sort(), "the verifier's row fields name the same kinds")
  // Biting: a kind added to what the kit copies, without a recheck entry, is caught by the same scan.
  const mutated = KIT_TEXT.replace("return { row: { key: item.key, type: 'local',", "return { row: { key: item.key, type: 'session',")
  assert.notEqual(mutated, KIT_TEXT)
  assert.notDeepEqual(written(mutated), [...kit.ROW_KINDS].sort())
})

// Each kind changed between the two passes. [label, the row key the run names, how her browser changed it]
const CHANGES = [
  ['a file (its bytes)', NOTES, data => { data.get(NOTES).bytes[0] ^= 1 }],
  ['a file outside /dsh/home/', OUTSIDE, data => { data.get(OUTSIDE).bytes[2] ^= 1 }],
  ['a file (only its mode: S4)', NOTES, data => { data.get(NOTES).mode = 0o777 }],
  ['a folder (its mode)', FOLDER, data => { data.get(FOLDER).mode = 0o700 }],
  ['a gone row (now a file again)', GONE, data => { data.set(GONE, fileEntry('back again')) }],
  ['a bookkeeping row', META, data => { data.get(META).seq = 10 }],
  ['a bookkeeping row whose text only got longer', COUNTER, data => { data.set(COUNTER, 97) }],
  ['a saved setting (the chat log rewritten)', LOCAL, (data, ls) => { ls.map.set(LOG, JSON.stringify([{ role: 'you', text: 'Corrected words', ts: 1 }])) }],
  ['a saved setting whose text only got longer', LOCAL, (data, ls) => { ls.map.set(LOG, ls.map.get(LOG) + ' ') }],
]
for (const [label, key, change] of CHANGES) {
  test(`M1 changed between the passes, ${label}: the local pack is NOT complete (verify exits 3) and the cloud copy is not complete`, async () => {
    const pack = await local(change)
    assert.equal(pack.result.complete, false, pack.result.line)
    assert.equal(pack.result.changed, 1)
    assert.equal(pack.result.line, 'Copy saved, NOT complete: 1 row changed while being copied. Run again when she is idle.')
    assert.ok(pack.result.lines.includes('Changed: ' + key), JSON.stringify(pack.result.lines))
    assert.equal(pack.index.completeness.changed, 1)
    assert.equal(pack.verified.code, 3, pack.verified.lines.join('\n'))
    assert.ok(pack.verified.lines.includes('NOT COMPLETE: unreadable 0, missing 0, new rows 0, changed 1, vanished 0'), pack.verified.lines.join('\n'))
    const copy = await cloud(change)
    assert.equal(copy.result.complete, false, JSON.stringify(copy.result.lines))
    assert.equal(copy.result.line, 'This copy is not complete.')
    assert.deepEqual(copy.result.changed, [key])
    assert.deepEqual(copy.result.mismatched, [], 'her cloud holds exactly what was copied: the SOURCE moved')
    assert.ok(copy.result.lines.includes('1 rows changed while this copy was being made. Run again.'), JSON.stringify(copy.result.lines))
  })
}

// Each kind deleted between the two passes.
const DELETES = [
  ['a file', NOTES, data => { data.delete(NOTES) }],
  ['a file outside /dsh/home/', OUTSIDE, data => { data.delete(OUTSIDE) }],
  ['a folder', FOLDER, data => { data.delete(FOLDER) }],
  ['a gone row', GONE, data => { data.delete(GONE) }],
  ['a bookkeeping row', META, data => { data.delete(META) }],
  ['a saved setting (the chat log)', LOCAL, (data, ls) => { ls.map.delete(LOG) }],
]
for (const [label, key, remove] of DELETES) {
  test(`M1 deleted between the passes, ${label}: the local pack is NOT complete (verify exits 3) and the cloud copy is not complete`, async () => {
    const pack = await local(remove)
    assert.equal(pack.result.complete, false, pack.result.line)
    assert.equal(pack.result.vanished, 1)
    assert.equal(pack.result.line, 'Copy saved, NOT complete: 1 row were deleted while being copied. Run again when she is idle.')
    assert.ok(pack.result.lines.includes('Deleted meanwhile: ' + key), JSON.stringify(pack.result.lines))
    assert.equal(pack.verified.code, 3, pack.verified.lines.join('\n'))
    assert.ok(pack.verified.lines.includes('NOT COMPLETE: unreadable 0, missing 0, new rows 0, changed 0, vanished 1'), pack.verified.lines.join('\n'))
    const copy = await cloud(remove)
    assert.equal(copy.result.complete, false, JSON.stringify(copy.result.lines))
    assert.equal(copy.result.line, 'This copy is not complete.')
    assert.deepEqual(copy.result.vanished, [key])
    assert.ok(copy.result.lines.includes('1 rows were deleted while this copy was being made. Run again.'), JSON.stringify(copy.result.lines))
  })
}

test('M1 a thread that only got longer is still a notice, not a failure, in both modes (her journal is appended to)', async () => {
  const grow = data => { const value = data.get(MAIN); value.bytes = new Uint8Array([...value.bytes, ...Buffer.from('{"more":1}\n')]) }
  const pack = await local(grow)
  assert.equal(pack.result.complete, true, pack.result.line)
  assert.equal(pack.result.grew, 1)
  assert.equal(pack.verified.code, 0, pack.verified.lines.join('\n'))
  const copy = await cloud(grow)
  assert.equal(copy.result.complete, true, JSON.stringify(copy.result.lines))
  assert.ok(copy.result.lines.includes('1 threads grew since this copy. Run again to add the new lines.'))
})

test('M1 the verifier holds a pack to its own count: a pack that says it checked fewer rows again than it holds is NOT complete', async () => {
  const pack = await local()
  const buffer = Buffer.from(await pack.result.blob.arrayBuffer())
  const length = Number(buffer.readBigUInt64BE(buffer.length - 19))
  const start = buffer.length - 19 - length
  const index = JSON.parse(buffer.subarray(start, buffer.length - 19).toString())
  index.completeness.rechecked -= 1
  const kit = rescueKit({ indexedDB: null, localStorage: null })
  const text = Buffer.from(kit.canon(index))
  const trailer = Buffer.alloc(8)
  trailer.writeBigUInt64BE(BigInt(text.length))
  const path = join(scratch(), 'aukora-rescue-' + kit.indexId(index) + '.x61pack')
  writeFileSync(path, Buffer.concat([buffer.subarray(0, start), text, trailer, Buffer.from('X61RESCUE1\n')]))
  const verified = await verifyRescuePack(path)
  assert.equal(verified.code, 3, verified.lines.join('\n'))
  assert.ok(verified.lines.some(line => line.includes(`checked again ${index.rows.length - 1} of ${index.rows.length} rows`)), verified.lines.join('\n'))
})

// ── M2: a listing that failed is never an empty listing ────────────────────────────────────────────────────────────

/** localStorage whose enumeration fails one way: its length throws, its key() throws, or a name goes before the count ends. */
class BrokenListStorage extends CountingStorage {
  constructor(entries, how) { super(entries); this.how = how }
  get length() { if (this.how === 'length') throw new DOMException('denied', 'SecurityError'); return super.length }
  key(index) {
    if (this.how === 'key') throw new DOMException('denied', 'SecurityError')
    if (this.how === 'moved' && index === 1) return null
    return super.key(index)
  }
}
const SETTINGS_FAILS = [
  ['its length throws', 'length', 'saved settings: their list could not be read'],
  ['its key() throws', 'key', 'saved settings: their list could not be read'],
  ['a name goes before the count ends (the list moved)', 'moved', 'saved settings: their list changed while it was read'],
]
for (const [label, how, shape] of SETTINGS_FAILS) {
  test(`M2 the saved-settings list fails (${label}): recorded by shape, NOT complete in both modes, verify exits 3, her cloud's index records it`, async () => {
    const pack = await local(null, { ls: new BrokenListStorage([['aukora.theme', 'dark'], [LOG, '[]']], how) })
    assert.equal(pack.result.complete, false, pack.result.line)
    // Both listings of the run (the copy's and the look for new rows) failed, and each is counted.
    assert.deepEqual(pack.index.unlisted, { count: 2, shapes: [{ shape, count: 2 }] })
    assert.equal(pack.result.line, `Copy saved, NOT complete: 2 listings could not be read (${shape}). Run again when she is idle.`)
    assert.equal(pack.verified.code, 3, pack.verified.lines.join('\n'))
    assert.ok(pack.verified.lines.includes(`NOT COMPLETE: listings that failed 2 (${shape}: 2)`), pack.verified.lines.join('\n'))
    const copy = await cloud(null, { ls: new BrokenListStorage([['aukora.theme', 'dark'], [LOG, '[]']], how) })
    assert.equal(copy.result.complete, false, JSON.stringify(copy.result.lines))
    assert.equal(copy.result.line, 'This copy is not complete.')
    assert.ok(copy.result.lines.includes('Could not list: ' + shape + ': 2'), JSON.stringify(copy.result.lines))
    const sent = JSON.parse(new TextDecoder().decode(copy.vault.rescues.get(copy.result.id)))
    assert.deepEqual(sent.unlisted, { count: 1, shapes: [{ shape, count: 1 }] }, 'the index her cloud keeps records the first listing that failed')
  })
}

test('M2 a browser that refuses its saved settings outright (the localStorage getter throws) is not a browser with none: NOT complete', async () => {
  const before = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new DOMException('denied', 'SecurityError') } })
  try {
    const idb = new FakeIndexedDb()
    idb.seed(DB, entries())
    const result = await rescueKit({ indexedDB: idb }).saveLocal()
    assert.equal(result.complete, false, result.line)
    assert.deepEqual(result.unlisted, { count: 2, shapes: [{ shape: 'saved settings: this browser would not open them', count: 2 }] })
    assert.equal((await verifyPack(result)).code, 3)
  } finally {
    if (before) Object.defineProperty(globalThis, 'localStorage', before)
    else delete globalThis.localStorage
  }
  // No saved settings at all (a worker, or a test passing none): nothing failed, nothing recorded.
  const idb = new FakeIndexedDb()
  idb.seed(DB, entries())
  const none = await rescueKit({ indexedDB: idb, localStorage: null }).saveLocal()
  assert.equal(none.complete, true, none.line)
  assert.deepEqual(none.unlisted, { count: 0, shapes: [] })
})

/** Her worker's file system, with one folder whose listing fails. */
const memoryEntries = () => [
  ['/dsh/home', dirEntry()], ['/dsh/home/sessions', dirEntry()], ['/dsh/home/sessions/agent', dirEntry()], ['/dsh/home/sessions/agent/main', dirEntry()],
  [MAIN, fileEntry('{"role":"user","text":"x"}\n'.repeat(8), 1700000000000)],
  ['/dsh/home/auma', dirEntry()], ['/dsh/home/auma/notes.md', fileEntry('notes')],
  ['/dsh/home/auma/private', dirEntry(0o700)], ['/dsh/home/auma/private/diary-PRIVMARK.md', fileEntry('private words')],
]
const brokenFs = (failing, { stat = null } = {}) => {
  const fs = fakeFsFromEntries(memoryEntries())
  const readdirSync = fs.readdirSync.bind(fs), statSync = fs.statSync.bind(fs)
  fs.readdirSync = path => { if (path === failing) throw Object.assign(new Error('EACCES: ' + path), { code: 'EACCES' }); return readdirSync(path) }
  fs.statSync = path => { if (path === stat) throw Object.assign(new Error('EIO: ' + path), { code: 'EIO' }); return statSync(path) }
  return fs
}

test('M2 a memory-source folder whose listing fails: its subtree is NOT silently missing; the pack says so (verify 3), and the shape never names her private folder', async () => {
  const kit = rescueKit({ source: 'memory', fs: brokenFs('/dsh/home/auma'), indexedDB: null, localStorage: null })
  const result = await kit.saveLocal()
  assert.equal(result.complete, false, result.line)
  assert.deepEqual(result.unlisted, { count: 2, shapes: [{ shape: 'a folder could not be listed (a file or folder under /dsh/home/)', count: 2 }] })
  assert.match(result.line, /^Copy saved, NOT complete: 2 listings could not be read \(a folder could not be listed/)
  const verified = await verifyPack(result)
  assert.equal(verified.code, 3, verified.lines.join('\n'))
  const index = await packIndex(result.blob)
  assert.ok(!index.rows.some(row => row.key.startsWith('/dsh/home/auma/')), 'what could not be listed is not in the pack, and the pack says a listing failed')
  // Her private folder failing: the shape says where in plain words, never its name or what is in it.
  const secret = await rescueKit({ source: 'memory', fs: brokenFs('/dsh/home/auma/private'), indexedDB: null, localStorage: null }).saveLocal()
  assert.equal(secret.complete, false)
  assert.deepEqual(secret.unlisted.shapes.map(entry => entry.shape), ['a folder could not be listed (a file or folder in her private folder)'])
  assert.ok(!/PRIVMARK|diary/.test(JSON.stringify({ ...secret, blob: null })))
})

test('M2 a memory-source path whose stat fails is still listed: its read finds it gone, so the run is NOT complete (never dropped)', async () => {
  const result = await rescueKit({ source: 'memory', fs: brokenFs(null, { stat: '/dsh/home/auma/notes.md' }), indexedDB: null, localStorage: null }).saveLocal()
  assert.equal(result.complete, false, result.line)
  assert.equal(result.missing, 1)
  assert.equal((await verifyPack(result)).code, 3)
})

/** A stat that fails only on some of its calls for one path (1-based call numbers): a failure that comes and goes. */
const flakyStatFs = (path, failOn, extra = []) => {
  const fs = fakeFsFromEntries([...memoryEntries(), ...extra])
  const statSync = fs.statSync.bind(fs)
  let calls = 0
  fs.statSync = target => {
    if (target === path) { calls += 1; if (failOn.includes(calls)) throw Object.assign(new Error('EIO: ' + target), { code: 'EIO' }) }
    return statSync(target)
  }
  return fs
}

test('M2 (third outside look) a folder whose stat fails only during the two traversals, and succeeds when the folder row is copied and rechecked: the child it hid is NOT silently missing', async () => {
  const LOST = ['/dsh/home/auma/lost.md', fileEntry('this must travel')]
  // Local pack: stat calls 1 and 4 on the folder are the two traversals (first listing, recheck listing); 2 and 3 copy and recheck its row.
  const local = await rescueKit({ source: 'memory', fs: flakyStatFs('/dsh/home/auma', [1, 4], [LOST]), indexedDB: null, localStorage: null }).saveLocal()
  assert.equal(local.complete, false, local.line)
  assert.ok(local.unlisted.count >= 1, JSON.stringify(local.unlisted))
  assert.ok(local.unlisted.shapes.some(entry => entry.shape === 'a file or folder could not be examined (a file or folder under /dsh/home/)'), JSON.stringify(local.unlisted))
  assert.ok(!/^Saved a copy/.test(local.line), local.line)
  assert.equal((await verifyPack(local)).code, 3)
  // Cloud copy through the real vault: the same failure pattern.
  const bucket = createVaultBucket()
  const fetch = createVaultFetch({ bucket, budget: createVaultBudget() })
  const cloud = await rescueKit({ source: 'memory', fs: flakyStatFs('/dsh/home/auma', [1, 4], [LOST]), indexedDB: null, localStorage: null, fetch, sleep: async () => {} }).copyToCloud()
  assert.equal(cloud.complete, false, JSON.stringify(cloud.lines))
  assert.ok(!cloud.lines.some(line => /^Rescue copy complete and checked/.test(line)), JSON.stringify(cloud.lines))
  // Any single failing call is enough: the first traversal alone, or the recheck traversal alone.
  for (const failOn of [[1], [4]]) {
    const once = await rescueKit({ source: 'memory', fs: flakyStatFs('/dsh/home/auma', failOn, [LOST]), indexedDB: null, localStorage: null }).saveLocal()
    assert.equal(once.complete, false, 'stat call ' + failOn[0] + ': ' + once.line)
  }
  // Her private folder: the shape says where in plain words, never a name.
  const secret = await rescueKit({ source: 'memory', fs: flakyStatFs('/dsh/home/auma/private', [1]), indexedDB: null, localStorage: null }).saveLocal()
  assert.equal(secret.complete, false)
  assert.ok(!/PRIVMARK|diary/.test(JSON.stringify({ ...secret, blob: null })))
})

test('M2 through the REAL vault: a memory-source copy whose folder listing failed is not complete, and her cloud records it with the copy (index and manifest)', async () => {
  const bucket = createVaultBucket()
  const fetch = createVaultFetch({ bucket, budget: createVaultBudget() })
  const kit = rescueKit({ source: 'memory', fs: brokenFs('/dsh/home/auma'), indexedDB: null, localStorage: null, fetch, sleep: async () => {} })
  const result = await kit.copyToCloud()
  assert.equal(result.complete, false, JSON.stringify(result.lines))
  assert.ok(result.lines.includes('Could not list: a folder could not be listed (a file or folder under /dsh/home/): 2'), JSON.stringify(result.lines))
  const pending = JSON.parse(new TextDecoder().decode(bucket.objects.get(`w/node-main-v1/rescue/${result.id}/pending.json`).bytes))
  assert.deepEqual(pending.unlisted, { count: 1, shapes: [{ shape: 'a folder could not be listed (a file or folder under /dsh/home/)', count: 1 }] })
  const manifest = JSON.parse(new TextDecoder().decode(bucket.objects.get(`w/node-main-v1/rescue/${result.id}/manifest.json`).bytes))
  assert.equal(manifest.unlisted, 1, "her cloud's verification reports it")
  const answer = await fetch(`/_vault/rescue/${result.id}/verify?cursor=0`, { method: 'POST' })
  assert.equal((await answer.json()).unlisted, 1)
  // A complete copy records none (and says 0, not "not recorded").
  const clean = await rescueKit({ source: 'memory', fs: brokenFs(null), indexedDB: null, localStorage: null, fetch, sleep: async () => {} }).copyToCloud()
  assert.equal(clean.complete, true, JSON.stringify(clean.lines))
  assert.equal(JSON.parse(new TextDecoder().decode(bucket.objects.get(`w/node-main-v1/rescue/${clean.id}/manifest.json`).bytes)).unlisted, 0)
})

// ── M2: the source scan ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Every `catch` in a source whose failure turns into an EMPTY result without being recorded. Detection, said plainly:
 *  - each `catch (...) { body }` and `catch { body }` is found and its body cut out by brace matching (string literals
 *    and comments skipped), and each promise `.catch(... => <expression>)`;
 *  - a body is EMPTY-MAKING when it returns or assigns an empty list, array or zero (`return []`, `return 0`, `return ''`,
 *    `return new Set()`/`Map()`/`Array()`, `x = []`, `x = 0`, `x = new Set()`...), or `continue`s or `break`s (a loop over a
 *    listing that skips what it could not read is the same thing); an arrow `.catch(() => [])` / `=> 0` likewise;
 *  - it is RECORDED when the same body calls `noteUnlisted(`. An empty-making body that is not recorded is a finding.
 * A catch that returns null, a refusal or an `{unreadable}` record is not empty-making: those are judged by their callers.
 */
const EMPTY = /\breturn\s*(?:\[\s*\]|0\b|''|""|new\s+(?:Set|Map|Array)\s*\(\s*\))|(?:^|[^=!<>+\-*/%&|^])=\s*(?:\[\s*\]|0\b|''|""|new\s+(?:Set|Map|Array)\s*\(\s*\))|\bcontinue\b|\bbreak\b/
const RECORDED = /\bnoteUnlisted\s*\(/
const closeOf = (text, open) => {
  let depth = 0
  for (let at = open; at < text.length; at++) {
    const char = text[at]
    if (char === '/' && text[at + 1] === '/') { at = text.indexOf('\n', at); if (at < 0) return text.length; continue }
    if (char === '/' && text[at + 1] === '*') { at = text.indexOf('*/', at + 2) + 1; continue }
    if (char === "'" || char === '"' || char === '`') { for (at++; at < text.length && text[at] !== char; at++) if (text[at] === '\\') at++; continue }
    if (char === '{') depth++
    else if (char === '}' && --depth === 0) return at
  }
  return text.length
}
const emptyListingCatches = text => {
  const found = []
  for (const match of text.matchAll(/\bcatch\s*(?:\(\s*[A-Za-z_$][\w$]*\s*\))?\s*\{/g)) {
    const open = match.index + match[0].length - 1
    const body = text.slice(open + 1, closeOf(text, open))
    if (EMPTY.test(body) && !RECORDED.test(body)) found.push({ line: text.slice(0, match.index).split('\n').length, body: body.trim() })
  }
  for (const match of text.matchAll(/\.catch\(\s*(?:\([^)]*\)|[\w$]+)\s*=>\s*(\[\s*\]|0\b|''|""|new\s+(?:Set|Map|Array)\s*\(\s*\))/g)) {
    found.push({ line: text.slice(0, match.index).split('\n').length, body: match[1] })
  }
  return found
}

test('M2 the source scan: no catch in the kit (or the vault) turns a failed listing into an empty one without recording it; it bites on each old form', () => {
  assert.deepEqual(emptyListingCatches(KIT_TEXT), [], 'rescue-kit.mjs')
  assert.deepEqual(emptyListingCatches(SOURCE('vault.mjs')), [], 'vault.mjs')
  // Biting on the three forms the review found (87069752, rescue-kit.mjs :465, :556, :561), put back into today's kit.
  const restore = [
    ['} catch (error) { noteUnlisted(lost, UNLISTED.failed) }', '} catch (error) { return [] }'],
    ["try { stat = fs.statSync(path) } catch (error) { noteUnlisted(lost, 'a file or folder could not be examined (' + whereOf(path) + ')') }", 'try { stat = fs.statSync(path) } catch (error) { continue }'],
    ["try { names = Array.from(fs.readdirSync(path), String) } catch (error) {\n            noteUnlisted(lost, 'a folder could not be listed (' + whereOf(path) + ')')\n            continue\n          }",
      'try { names = Array.from(fs.readdirSync(path), String) } catch (error) { continue }'],
  ]
  for (const [now, old] of restore) {
    assert.ok(KIT_TEXT.includes(now), 'the fixed form is in the kit: ' + now)
    const findings = emptyListingCatches(KIT_TEXT.replace(now, old))
    assert.equal(findings.length, 1, old)
    assert.equal(findings[0].body.replace(/\s+/g, ' '), old.slice(old.lastIndexOf('{') + 1, -1).trim())
  }
  // The rule on small cases, both ways.
  const cases = [
    ['try { a() } catch (error) { return [] }', 1], ['try { a() } catch { list = [] }', 1], ['try { a() } catch (e) { count = 0 }', 1],
    ['try { a() } catch (e) { return new Set() }', 1], ['for (;;) { try { a() } catch (e) { break } }', 1], ['p.catch(() => [])', 1], ['p.catch(e => 0)', 1],
    ["try { a() } catch (e) { noteUnlisted(lost, 'x'); continue }", 0], ['try { a() } catch (e) { /* gone */ }', 0],
    ["try { a() } catch (e) { return { unreadable: 'x' } }", 0], ['try { a() } catch (e) { tries += 1 }', 0], ['try { a() } catch (e) { x === 0 }', 0],
  ]
  for (const [source, count] of cases) assert.equal(emptyListingCatches(source).length, count, source)
})
