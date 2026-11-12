/**
 * The rescue pack: the copy kit says exactly what it copied, the check cannot be fooled,
 * and there is a way back. Every pack here is made by the REAL kit over a made-up store (the fakes in rescue-fakes.mjs),
 * then damaged by hand and run through the REAL `node server/rescue-verify.mjs`.
 */
import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { rescueKit } from '../rescue-kit.mjs'
import { composeLocalConsoleScript, composeMemoryConsoleScript } from '../rescue-page.generate.mjs'
import { FakeIndexedDb, FakeLocalStorage, createFakeVault, fakeFsFromEntries, fileEntry, dirEntry, goneEntry } from './rescue-fakes.mjs'

const DB = 'aukora-x6-vfs'
const PIECE = 2097152
const ROOT = fileURLToPath(new URL('../../../../', import.meta.url))
const VERIFY = join(ROOT, 'server/rescue-verify.mjs')
const MAGIC = Buffer.from('X61RESCUE1\n')
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const later = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms))
/**
 * The temporary folder, made by the FIRST test that writes a file (not at load): in a sandbox where the temporary
 * folder cannot be written, only the tests that write fail (with the reason), and every other test still runs.
 */
let made = null
const scratch = () => (made ??= mkdtempSync(join(tmpdir(), 'rescue-pack-test-')))
after(() => { if (made) rmSync(made, { recursive: true, force: true }) })

const MAIN = '/dsh/home/sessions/agent/main/session.v3.jsonl'
const SIDE = '/dsh/home/auma/session/messages.jsonl'
const NOTES = '/dsh/home/notes.md'
const OTHER = '/dsh/home/other.md'
const PRIVATE_FILE = '/dsh/home/auma/private/diary-PRIVMARK.md'
const T_MAIN = new Date(2026, 10, 12, 13, 40, 5).getTime()
const T_SIDE = new Date(2026, 10, 12, 13, 58, 30).getTime()
const hhmm = ms => { const d = new Date(ms); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') }

/** A made-up store: the main thread is the LONGEST, a smaller thread is the NEWEST; a private file; a secret; bookkeeping. */
function storeEntries(extra = []) {
  return [
    ['/dsh/home', dirEntry()], ['/dsh/home/auma', dirEntry()], ['/dsh/home/auma/private', dirEntry(0o700)], ['/dsh/home/auma/session', dirEntry()],
    ['/dsh/home/sessions', dirEntry()], ['/dsh/home/sessions/agent', dirEntry()], ['/dsh/home/sessions/agent/main', dirEntry()],
    [MAIN, fileEntry('{"role":"user","text":"x"}\n'.repeat(80), T_MAIN, 0o644)],
    [SIDE, fileEntry('{"l":1}\n', T_SIDE, 0o600)],
    [NOTES, fileEntry('hello', 1700000000000, 0o644)],
    [OTHER, fileEntry('world', 1700000000001, 0o400)],
    [PRIVATE_FILE, fileEntry('private words', 1700000000002, 0o600)],
    ['/dsh/home/empty.txt', fileEntry('', 1700000000003)],
    ['/dsh/home/old.txt', goneEntry()],
    ['/dsh/home/.credentials.yaml', fileEntry('k: v')],
    ['@x6-mirror-meta', { clientId: 'client-A', cloudBase: { lineageId: 'L', revision: 5 } }],
    ['@x6-content-revision', { kind: 'content-revision', seq: 9 }],
    ...extra,
  ]
}
const SETTINGS = [['aukora-auma-live-log-v2:abc', 'what he said aloud'], ['aukora.theme', 'dark'], ['apiKey', 'k']]

async function makePack(name, { entries = storeEntries(), settings = SETTINGS, save = {}, hook = null, kitOptions = {} } = {}) {
  const idb = new FakeIndexedDb()
  idb.seed(DB, entries)
  if (hook) idb.hooks.beforeRequest = hook
  const ls = new FakeLocalStorage(settings)
  const kit = rescueKit({ indexedDB: idb, localStorage: ls, fetch: () => { throw new Error('no network') }, ...kitOptions })
  const said = []
  const result = await kit.saveLocal({ report: line => said.push(line), ...save })
  const buf = Buffer.from(await result.blob.arrayBuffer())
  const folder = join(scratch(), name)
  mkdirSync(folder, { recursive: true })
  const path = join(folder, result.fileName)
  writeFileSync(path, buf)
  return { idb, ls, kit, result, buf, path, said, folder }
}
const verify = (file, ...args) => {
  const run = spawnSync(process.execPath, [VERIFY, file, ...args], { encoding: 'utf8' })
  return { code: run.status, out: run.stdout + run.stderr }
}
function parse(buf) {
  const length = Number(buf.readBigUInt64BE(buf.length - 19))
  const start = buf.length - 19 - length
  const text = buf.subarray(start, buf.length - 19).toString('utf8')
  return { index: JSON.parse(text), text, data: buf.subarray(MAGIC.length, start) }
}
function assemble(data, text) {
  const bytes = Buffer.from(text, 'utf8'), length = Buffer.alloc(8)
  length.writeBigUInt64BE(BigInt(bytes.length))
  return Buffer.concat([MAGIC, data, bytes, length, MAGIC])
}
/** Canonical JSON, written here on its own (pack-id.mjs's rule), so the kit's own function is checked, not trusted. */
const canon = value => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value === undefined ? null : value)
  if (Array.isArray(value)) return '[' + value.map(canon).join(',') + ']'
  return '{' + Object.keys(value).sort().filter(name => value[name] !== undefined).map(name => JSON.stringify(name) + ':' + canon(value[name])).join(',') + '}'
}
const idOf = index => sha(canon({ ...index, rows: index.rows.map(({ offset, ...rest }) => rest) })).slice(0, 32)
const put = (folder, name, buf) => { const path = join(folder, name); writeFileSync(path, buf); return path }

// ── MUST 1: the index is pinned ─────────────────────────────────────────────────────────────────────────────────────

test('the id: the kit, the verifier and an independent recompute agree, and the verifier prints it', async () => {
  const { result, buf, path, kit } = await makePack('id')
  const { index } = parse(buf)
  assert.equal(result.id, idOf(index))
  assert.equal(kit.indexId(index), result.id)
  const ok = verify(path)
  assert.equal(ok.code, 0, ok.out)
  assert.ok(ok.out.includes('id: ' + result.id + ' (file name: equal; --expect-id: not given)'), ok.out)
  assert.equal(verify(path, '--expect-id', result.id).code, 0)
  const wrongId = verify(path, '--expect-id', 'f'.repeat(32))
  assert.equal(wrongId.code, 1, wrongId.out)
  assert.match(wrongId.out, /different id than --expect-id/)
  // A file name with no id and no --expect-id: nothing pins the index, so it does not pass.
  const bare = put(scratch(), 'renamed.x61pack', buf)
  const unpinned = verify(bare)
  assert.equal(unpinned.code, 1, unpinned.out)
  assert.match(unpinned.out, /not pinned/)
  assert.equal(verify(bare, '--expect-id', result.id).code, 0)
  // Chrome's "(1)" suffix keeps the id readable.
  assert.equal(verify(put(scratch(), 'aukora-rescue-' + result.id + ' (1).x61pack', buf)).code, 0)
  assert.equal(verify(bare, '--expect-id', 'nothex').code, 2, 'a malformed id is a usage error')
})

test("the readers' damage cases now FAIL: renamed key, mode, mtime, client, skipped count, folder and gone rows, duplicate file row, the consistent lie", async () => {
  const { result, buf, folder } = await makePack('damage')
  const P = parse(buf)
  const named = 'aukora-rescue-' + result.id + '.x61pack'
  const row = key => P.index.rows.find(entry => entry.key === key)
  /** Edit a copy of the index, write it canonically (so only the pin can catch it), keep the kit's file name. */
  const edited = (label, edit, data = P.data) => {
    const index = structuredClone(P.index)
    edit(index)
    const sub = join(folder, label)
    mkdirSync(sub, { recursive: true })
    return { path: put(sub, named, assemble(data, canon(index))), index }
  }
  const cases = [
    ['renamed key', index => { index.rows.find(entry => entry.key === NOTES).key = '/dsh/home/notez.md' }],
    ['changed mode', index => { index.rows.find(entry => entry.key === NOTES).mode = 0o645 }],
    ['changed mtime', index => { index.rows.find(entry => entry.key === NOTES).mtimeMs += 1 }],
    ['changed client id', index => { index.client.clientId = 'client-B' }],
    ['changed skipped count', index => { index.skipped[0].count = 7 }],
    ['folder row removed', index => { index.rows = index.rows.filter(entry => entry.key !== '/dsh/home/sessions/agent') }],
    ['folder row duplicated', index => { const at = index.rows.findIndex(entry => entry.key === '/dsh/home/sessions'); index.rows.splice(at, 0, structuredClone(index.rows[at])) }],
    ['gone row removed', index => { index.rows = index.rows.filter(entry => entry.key !== '/dsh/home/old.txt') }],
    ['gone row duplicated', index => { const at = index.rows.findIndex(entry => entry.key === '/dsh/home/old.txt'); index.rows.splice(at, 0, structuredClone(index.rows[at])) }],
    ['completeness record removed', index => { delete index.completeness }],
  ]
  for (const [label, edit] of cases) {
    const { path } = edited(label.replace(/\W+/g, '-'), edit)
    const run = verify(path)
    assert.equal(run.code, 1, label + ': ' + run.out)
    assert.match(run.out, /different id than the file name/, label)
  }
  // A file row duplicated with its bytes, offsets and totals kept consistent.
  {
    const notes = row(NOTES)
    const data = Buffer.concat([P.data, P.data.subarray(notes.offset - 11, notes.offset - 11 + notes.bytes)])
    const { path } = edited('dup-file', index => {
      const at = index.rows.findIndex(entry => entry.key === NOTES)
      index.rows.splice(at + 1, 0, { ...structuredClone(notes), offset: 11 + P.data.length })
      index.totals.homeFiles += 1; index.totals.bytes += notes.bytes
    }, data)
    const run = verify(path)
    assert.equal(run.code, 1, run.out)
    assert.ok(run.out.includes('mismatch: ' + NOTES + ' (duplicate key)'), run.out)
  }
  // The consistent lie: a row and its bytes removed, every later offset shifted, the totals lowered, and the file renamed
  // to the forged id. Only the id the kit showed on screen can catch it, and it does.
  {
    const other = row(OTHER)
    const data = Buffer.concat([P.data.subarray(0, other.offset - 11), P.data.subarray(other.offset - 11 + other.bytes)])
    const index = structuredClone(P.index)
    index.rows = index.rows.filter(entry => entry.key !== OTHER).map(entry => (entry.offset > other.offset ? { ...entry, offset: entry.offset - other.bytes } : entry))
    index.totals.homeFiles -= 1; index.totals.bytes -= other.bytes
    const forged = idOf(index)
    const path = put(folder, 'aukora-rescue-' + forged + '.x61pack', assemble(data, canon(index)))
    const pinned = verify(path, '--expect-id', result.id)
    assert.equal(pinned.code, 1, pinned.out)
    assert.ok(pinned.out.includes('id: ' + forged + ' (file name: equal; --expect-id: DIFFERENT)'), pinned.out)
  }
})

test('refused: piece size, version, source, unsorted keys, bytes after the index, non-canonical index, an empty pack', async () => {
  const { buf, folder } = await makePack('refuse')
  const P = parse(buf)
  const write = (label, index, text = canon(index)) => put(folder, 'aukora-rescue-' + idOf(index) + '-' + label + '.x61pack', assemble(P.data, text))
  // Piece size changed, every piece re-hashed so the rows still match their index.
  const recut = structuredClone(P.index)
  recut.piece = PIECE * 4
  for (const entry of recut.rows) {
    if (!(entry.bytes > 0)) continue
    const bytes = P.data.subarray(entry.offset - 11, entry.offset - 11 + entry.bytes)
    entry.pieces = []
    for (let at = 0; at < bytes.length; at += recut.piece) entry.pieces.push(sha(bytes.subarray(at, at + recut.piece)))
  }
  let run = verify(write('piece', recut))
  assert.equal(run.code, 2, run.out); assert.match(run.out, /piece size is not 2097152/)
  run = verify(write('v2', { ...structuredClone(P.index), v: 2 }))
  assert.equal(run.code, 2, run.out); assert.match(run.out, /not a v1/)
  run = verify(write('source', { ...structuredClone(P.index), source: 'elsewhere' }))
  assert.equal(run.code, 2, run.out); assert.match(run.out, /unknown source/)
  // Two rows swapped in order only: the id is recomputed to match, so only the order rule catches it.
  const swapped = structuredClone(P.index)
  const [a, b] = [swapped.rows.findIndex(entry => entry.key === NOTES), swapped.rows.findIndex(entry => entry.key === OTHER)]
  ;[swapped.rows[a], swapped.rows[b]] = [swapped.rows[b], swapped.rows[a]]
  run = verify(write('order', swapped))
  assert.equal(run.code, 1, run.out); assert.match(run.out, /key out of order/)
  // Bytes after the index (inside the length the trailer gives), and an index written another way.
  for (const [label, text] of [['space', P.text + ' '], ['newline', P.text + '\n'], ['pretty', JSON.stringify(P.index, null, 1)]]) {
    run = verify(write(label, P.index, text))
    assert.equal(run.code, 2, label + ': ' + run.out); assert.match(run.out, /canonical/)
  }
  // An empty pack: no file at all. It says NO THREAD and does not pass unless asked.
  const empty = await makePack('empty', { entries: [['/dsh/home', dirEntry()], ['@x6-mirror-meta', { clientId: 'c' }]], settings: [] })
  run = verify(empty.path)
  assert.equal(run.code, 1, run.out)
  assert.match(run.out, /\*\*\* NO THREAD/)
  assert.match(run.out, /empty: it holds no file at all/)
  run = verify(empty.path, '--allow-empty')
  assert.equal(run.code, 0, run.out)
  assert.match(run.out, /\*\*\* NO THREAD/)
  // A pack from a kit that did not record what it could not copy: never "complete".
  const old = structuredClone(P.index)
  delete old.completeness
  run = verify(write('old-kit', old))
  assert.equal(run.code, 3, run.out)
  assert.match(run.out, /NOT COMPLETE: not recorded/)
})

// ── MUST 2: nothing is dropped in silence ───────────────────────────────────────────────────────────────────────────

test('unreadable, missing and new rows are recorded in the index: the headline says NOT complete and verify exits 3', async () => {
  // Unreadable: binary bookkeeping and a file row without bytes, counted by shape.
  const unreadable = await makePack('unreadable', { entries: storeEntries([['@x6-binary', { data: new Uint8Array([1, 2, 3]) }], ['/dsh/home/broken.bin', { kind: 'file', bytes: 'not bytes', mode: 0o600, mtimeMs: 1 }]]) })
  const c = parse(unreadable.buf).index.completeness
  assert.deepEqual(c.unreadable, { count: 2, shapes: [{ shape: 'a bookkeeping row: not plain text', count: 1 }, { shape: 'a file or folder under /dsh/home/: a file row without bytes', count: 1 }] })
  assert.equal(unreadable.result.complete, false)
  assert.equal(unreadable.result.line, 'Copy saved, NOT complete: 2 rows could not be read. Run again when she is idle.')
  assert.doesNotMatch(unreadable.result.line, /^(?:Saved a copy|Rescue copy complete)/)
  let run = verify(unreadable.path)
  assert.equal(run.code, 3, run.out)
  assert.ok(run.out.includes('NOT COMPLETE: unreadable 2 (a bookkeeping row: not plain text: 1; a file or folder under /dsh/home/: a file row without bytes: 1), missing 0, new rows 0, changed 0, vanished 0'), run.out)
  // Missing: listed, then gone when read (counted in take(), never dropped).
  const missing = await makePack('missing', { hook: (method, key, count, db) => { if (method === 'get' && key === NOTES && count < 20) db.stores.get('entries').delete(NOTES) } })
  assert.equal(parse(missing.buf).index.completeness.missing, 1)
  assert.equal(missing.result.line, 'Copy saved, NOT complete: 1 row were gone when read. Run again when she is idle.')
  run = verify(missing.path)
  assert.equal(run.code, 3, run.out); assert.match(run.out, /missing 1/)
  // New rows: a key that appeared during the run.
  let added = false
  const fresh = await makePack('new-rows', { hook: (method, key, count, db) => { if (!added && method === 'get' && key === MAIN) { added = true; db.stores.get('entries').set('/dsh/home/new.md', fileEntry('new')) } } })
  assert.equal(parse(fresh.buf).index.completeness.newRows, 1)
  assert.match(fresh.result.line, /^Copy saved, NOT complete: 1 new row appeared while copying\./)
  run = verify(fresh.path)
  assert.equal(run.code, 3, run.out); assert.match(run.out, /new rows 1/)
})

test('the second read-only pass: grew is reported (exit 0), changed and vanished are NOT complete; one request per transaction', async () => {
  // The first get of a key is the copy; the second (the recheck) sees what her tab did meanwhile.
  const afterFirst = (target, change) => {
    let gets = 0
    return (method, key, count, db) => { if (method === 'get' && key === target && ++gets === 2) change(db.stores.get('entries')) }
  }
  const grew = await makePack('grew', { hook: afterFirst(MAIN, data => { const value = data.get(MAIN); value.bytes = new Uint8Array([...value.bytes, ...Buffer.from('{"new":1}\n')]) }) })
  assert.equal(grew.result.complete, true, grew.result.line)
  assert.equal(grew.result.grew, 1)
  assert.match(grew.result.line, /^Saved a copy on this computer: /)
  assert.ok(grew.result.lines.includes('1 row grew after being copied (the copy holds what was read). Run again to add the new lines.'))
  let run = verify(grew.path)
  assert.equal(run.code, 0, run.out)
  assert.match(run.out, /grew: 1 rows got longer/)
  const changed = await makePack('changed', { hook: afterFirst(NOTES, data => { data.get(NOTES).bytes[0] ^= 1 }) })
  assert.equal(changed.result.changed, 1)
  assert.equal(changed.result.line, 'Copy saved, NOT complete: 1 row changed while being copied. Run again when she is idle.')
  run = verify(changed.path)
  assert.equal(run.code, 3, run.out); assert.match(run.out, /changed 1/)
  const vanished = await makePack('vanished', { hook: afterFirst(OTHER, data => { data.delete(OTHER) }) })
  assert.equal(vanished.result.vanished, 1)
  run = verify(vanished.path)
  assert.equal(run.code, 3, run.out); assert.match(run.out, /vanished 1/)
  // Every thread row and every row under /dsh/home/ was read exactly twice, each read in its own readonly transaction.
  const { idb } = grew
  for (const tx of idb.log.transactions) { assert.equal(tx.mode, 'readonly'); assert.equal(tx.requests.length, 1) }
  const index = parse(grew.buf).index
  for (const entry of index.rows.filter(row => row.key === '/dsh/home' || row.key.startsWith('/dsh/home/'))) {
    assert.equal(idb.log.requests.filter(request => request.method === 'get' && request.key === entry.key).length, 2, entry.key)
  }
})

test("her tab and the kit open side by side: every one of her saves succeeds, and the counts say what happened", async () => {
  const run = async (target, nextValue) => {
    const idb = new FakeIndexedDb()
    idb.seed(DB, storeEntries())
    const hers = await new Promise((resolve, reject) => { const request = idb.open(DB); request.onsuccess = () => resolve(request.result); request.onerror = reject })
    let stop = false, saves = 0, failures = 0, side = 0
    idb.hooks.beforeRequest = (method, key, count, db) => { side = Math.max(side, db.db.connections.size) }
    const save = () => new Promise(resolve => {
      const tx = hers.transaction('entries', 'readwrite')
      tx.objectStore('entries').put(nextValue(idb.data().get(target), saves), target)
      tx.oncomplete = () => { saves += 1; resolve() }
      tx.onabort = tx.onerror = () => { failures += 1; resolve() }
    })
    const writer = (async () => { while (!stop) { await save(); await later(0) } })()
    const kit = rescueKit({ indexedDB: idb, localStorage: null })
    const result = await kit.saveLocal()
    stop = true
    await writer
    assert.equal(failures, 0)
    assert.ok(saves >= 5, 'her tab kept saving: ' + saves)
    assert.equal(side, 2, 'both connections were open at once')
    assert.equal(hers.closed, false, "the kit's close() did not close her connection")
    await save()
    assert.equal(failures, 0, 'she still saves after the kit is done')
    for (const tx of idb.log.transactions.filter(entry => entry.connection !== hers)) { assert.equal(tx.mode, 'readonly'); assert.equal(tx.requests.length, 1) }
    const path = put(scratch(), result.fileName, Buffer.from(await result.blob.arrayBuffer()))
    return { result, verified: verify(path) }
  }
  // She keeps adding lines to the main thread: the copy is complete, the thread grew.
  const appended = await run(MAIN, value => fileEntry(new Uint8Array([...value.bytes, ...Buffer.from('{"more":1}\n')]), Date.now()))
  assert.equal(appended.result.complete, true, appended.result.line)
  assert.equal(appended.result.grew, 1)
  assert.equal(appended.result.changed, 0)
  assert.equal(appended.verified.code, 0, appended.verified.out)
  // She keeps rewriting a note: the copy is NOT complete, and says so.
  const rewritten = await run(NOTES, (value, n) => fileEntry(String(n).padStart(8, '0'), Date.now()))
  assert.equal(rewritten.result.complete, false)
  assert.equal(rewritten.result.changed, 1)
  assert.match(rewritten.result.line, /^Copy saved, NOT complete: 1 row changed while being copied\./)
  assert.equal(rewritten.verified.code, 3, rewritten.verified.out)
})

test('the cloud copy counts a row that was gone when read: not complete', async () => {
  const idb = new FakeIndexedDb()
  idb.seed(DB, storeEntries())
  idb.hooks.beforeRequest = (method, key, count, db) => { if (method === 'get' && key === NOTES && count < 20) db.stores.get('entries').delete(NOTES) }
  const vault = createFakeVault({ piece: PIECE })
  const result = await rescueKit({ indexedDB: idb, localStorage: null, fetch: vault.fetch, sleep: async () => {} }).copyToCloud()
  assert.equal(result.missing, 1)
  assert.equal(result.complete, false)
  assert.equal(result.line, 'This copy is not complete.')
  assert.ok(result.lines.includes('1 row were gone when read. Run again.'))
})

// ── MUST 3: private paths never reach a screen, a console or a return value ─────────────────────────────────────────

test('private paths are redacted in every line, list and return value, the console scripts and the verifier', async () => {
  const broken = '/dsh/home/auma/private/broken-PRIVMARK.bin'
  const entries = storeEntries([[broken, { kind: 'file', bytes: 'not bytes', mode: 0o600, mtimeMs: 1 }], ['/dsh/home/auma/private/gone-PRIVMARK.md', fileEntry('x')]])
  const gets = new Map()
  const pack = await makePack('private', { entries, hook: (method, key, count, db) => {
    if (method !== 'get') return
    gets.set(key, (gets.get(key) || 0) + 1)
    // The second read of a key is the recheck: one private row changed meanwhile, one was deleted.
    if (key === PRIVATE_FILE && gets.get(key) === 2) db.stores.get('entries').get(PRIVATE_FILE).bytes[0] ^= 1
    if (key === '/dsh/home/auma/private/gone-PRIVMARK.md' && gets.get(key) === 2) db.stores.get('entries').delete(key)
  } })
  const { result, said } = pack
  const everything = JSON.stringify({ ...result, blob: null }) + said.join('\n')
  assert.ok(!everything.includes('PRIVMARK'), everything)
  assert.ok(result.lines.includes('Could not read: /dsh/home/auma/private/[redacted]'), result.lines.join('|'))
  assert.ok(result.lines.includes('Changed: /dsh/home/auma/private/[redacted]'), result.lines.join('|'))
  assert.ok(result.lines.includes('Deleted meanwhile: /dsh/home/auma/private/[redacted]'), result.lines.join('|'))
  assert.deepEqual(result.unreadable, ['/dsh/home/auma/private/[redacted]'])
  // `plain` (what the console scripts return) holds counts and shapes only: no key at all.
  assert.ok(result.plain.every(line => !line.includes('/dsh/home/')), result.plain.join('|'))
  assert.ok(result.plain.includes('Could not read: a file or folder in her private folder: a file row without bytes: 1.'), result.plain.join('|'))
  assert.ok(result.plain.includes('Main thread: agent/main.'))
  // The verifier names a damaged private row only as redacted.
  const P = parse(pack.buf)
  const row = P.index.rows.find(entry => entry.key === PRIVATE_FILE)
  const bad = Buffer.from(pack.buf)
  bad[11 + (row.offset - 11)] ^= 1
  const run = verify(put(scratch(), 'private-' + result.fileName, bad), '--expect-id', result.id)
  assert.equal(run.code, 1, run.out)
  assert.ok(!run.out.includes('PRIVMARK'), run.out)
  assert.ok(run.out.includes('mismatch: /dsh/home/auma/private/[redacted] (piece 0 SHA-256)'), run.out)
  // The cloud copy's lines and lists.
  const idb = new FakeIndexedDb()
  idb.seed(DB, entries)
  const vault = createFakeVault({ piece: PIECE })
  const cloud = await rescueKit({ indexedDB: idb, localStorage: null, fetch: vault.fetch, sleep: async () => {} }).copyToCloud()
  assert.equal(cloud.complete, false)
  assert.ok(!JSON.stringify(cloud).includes('PRIVMARK'), JSON.stringify(cloud))
  assert.ok(cloud.lines.includes('Could not read: /dsh/home/auma/private/[redacted]'))
})

test('the generator console scripts return and log counts and shapes only, never a key', async () => {
  const entries = storeEntries([['/dsh/home/auma/private/broken-PRIVMARK.bin', { kind: 'file', bytes: 'not bytes', mode: 0o600, mtimeMs: 1 }]])
  const idb = new FakeIndexedDb()
  idb.seed(DB, entries)
  const logged = []
  const anchor = { click() {}, remove() {} }
  const text = await runInNewContext(composeLocalConsoleScript(), {
    crypto, TextEncoder, TextDecoder, setTimeout, Blob, indexedDB: idb, localStorage: new FakeLocalStorage(SETTINGS),
    URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} }, console: { log: line => logged.push(line) },
    document: { createElement: () => anchor, body: { appendChild() {} } },
  })
  assert.match(text, /^Copy saved, NOT complete: 1 row could not be read\./)
  assert.ok(!/\/dsh\/home\/|PRIVMARK|what he said/.test(text + logged.join('\n')), text)
  assert.ok(text.includes('Main thread: agent/main.'))
  // the chat log in SETTINGS travels by default; the line says so (the words of the log are never printed).
  assert.ok(text.includes('Auma Live chat logs were copied. Other saved settings stay in this browser.'))
  // Her worker's console: same rule for what it returns and logs.
  const memoryLogged = []
  const fs = fakeFsFromEntries(entries.filter(([key]) => key.startsWith('/') && !key.includes('broken')))
  const memory = await runInNewContext(composeMemoryConsoleScript(), { crypto, TextEncoder, TextDecoder, setTimeout, Blob,
    URL: { createObjectURL: () => 'blob:m' }, console: { log: line => memoryLogged.push(line) }, __X6_SERVICES__: { fs } })
  assert.equal(memory.ok, true)
  assert.equal(memory.url, 'blob:m')
  assert.ok(memory.blob instanceof Blob)
  assert.deepEqual(Object.keys(memory).sort(), ['blob', 'complete', 'fileName', 'id', 'line', 'lines', 'ok', 'url'])
  assert.ok(!/\/dsh\/home\/|PRIVMARK/.test(JSON.stringify({ ...memory, blob: null }) + memoryLogged.join('\n')))
  // --settings is the only way to put saved settings in a console pack.
  assert.match(composeLocalConsoleScript(), /settings: false/)
  assert.match(composeLocalConsoleScript({ settings: true }), /settings: true/)
})

// ── MUST 4: saved settings are off by default for the local pack ────────────────────────────────────────────────────

class CountingStorage extends FakeLocalStorage {
  reads = 0
  got = []
  get length() { this.reads += 1; return this.map.size }
  key(index) { this.reads += 1; return super.key(index) }
  getItem(name) { this.reads += 1; this.got.push(name); return super.getItem(name) }
}

test('the local pack leaves saved settings out unless asked (only Auma Live chat logs are read); the cloud copy keeps them only when asked', async () => {
  const idb = new FakeIndexedDb()
  idb.seed(DB, storeEntries())
  const ls = new CountingStorage(SETTINGS)
  const kit = rescueKit({ indexedDB: idb, localStorage: ls })
  const off = await kit.saveLocal()
  // the chat log is her conversation and travels by default; no other value is read.
  // read once by the copy and once by the recheck (every copied row is read again); no other value.
  assert.deepEqual(ls.got, ['aukora-auma-live-log-v2:abc', 'aukora-auma-live-log-v2:abc'], 'only the allow-listed value was read')
  const index = parse(Buffer.from(await off.blob.arrayBuffer())).index
  assert.deepEqual(index.rows.filter(row => row.type === 'local').map(row => row.key), ['localStorage:aukora-auma-live-log-v2:abc'])
  assert.equal(index.completeness.settings, false)
  assert.ok(off.lines.includes('Auma Live chat logs were copied. Other saved settings stay in this browser.'))
  assert.equal(off.complete, true)
  assert.ok(Buffer.from(await off.blob.arrayBuffer()).includes('what he said aloud'), 'the chat log is in the pack')
  assert.ok(!Buffer.from(await off.blob.arrayBuffer()).includes('"dark"') && !Buffer.from(await off.blob.arrayBuffer()).includes('localStorage:aukora.theme'))
  const on = await makePack('settings-on', { save: { settings: true } })
  const withSettings = parse(on.buf).index
  assert.deepEqual(withSettings.rows.filter(row => row.type === 'local').map(row => row.key), ['localStorage:aukora-auma-live-log-v2:abc', 'localStorage:aukora.theme'])
  assert.equal(withSettings.completeness.settings, true)
  assert.ok(!on.result.lines.includes('Auma Live chat logs were copied. Other saved settings stay in this browser.'))
  assert.ok(on.result.lines.includes('Auma Live chat logs were copied. Other saved settings were copied too, except names that look secret.'))
  const run = verify(on.path)
  assert.equal(run.code, 0, run.out)
  assert.match(run.out, /saved settings: copied/)
  // The cloud copy with settings: true: the earlier behaviour (settings travel). Its default is in rescue-guard.test.mjs.
  const vault = createFakeVault({ piece: PIECE })
  const cloud = await rescueKit({ indexedDB: idb, localStorage: new FakeLocalStorage(SETTINGS), fetch: vault.fetch, sleep: async () => {} }).copyToCloud({ settings: true })
  assert.equal(cloud.complete, true, cloud.line)
  const sent = JSON.parse(new TextDecoder().decode(vault.rescues.get(cloud.id)))
  assert.deepEqual(sent.rows.filter(row => row.type === 'local').map(row => row.key), ['localStorage:aukora-auma-live-log-v2:abc', 'localStorage:aukora.theme'])
  assert.equal('completeness' in sent, false, 'the cloud index on the wire is unchanged')
})

// ── MUST 5: memory, and the incremental SHA-256 ────────────────────────────────────────────────────────────────────

test('SHA-256 that takes chunks: the standard vectors, fed whole and in odd chunks', () => {
  const kit = rescueKit({ indexedDB: null, localStorage: null })
  const vectors = [
    ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
    ['abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq', '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1'],
    ['abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu', 'cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1'],
    ['a'.repeat(1000000), 'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0'],
  ]
  for (const [text, want] of vectors) {
    const bytes = new TextEncoder().encode(text)
    assert.equal(kit.sha256Hex(bytes), want, text.slice(0, 20))
    for (const step of [1, 7, 63, 64, 65, 1000]) {
      const hash = kit.newHash()
      for (let at = 0; at < bytes.length; at += step) hash.update(bytes.subarray(at, at + step))
      assert.equal(hash.digest(), want, text.slice(0, 20) + ' in chunks of ' + step)
    }
  }
  const done = kit.newHash()
  done.digest()
  assert.throws(() => done.update(new Uint8Array(1)))
  assert.throws(() => done.digest())
})

test('SHA-256 on random inputs and random chunk cuts equals node:crypto and WebCrypto', async () => {
  const kit = rescueKit({ indexedDB: null, localStorage: null })
  let seed = 0x9e3779b9
  const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 4294967296 }
  const lengths = [0, 1, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 129, 1000, 4095, 4096, 65537]
  for (let n = 0; n < 40; n++) lengths.push(Math.floor(random() * 300000))
  for (const length of lengths) {
    const bytes = new Uint8Array(length)
    for (let at = 0; at < length; at++) bytes[at] = Math.floor(random() * 256)
    const want = sha(bytes)
    assert.equal(toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))), want)
    const hash = kit.newHash()
    for (let at = 0; at < length;) { const step = 1 + Math.floor(random() * 200); hash.update(bytes.subarray(at, at + step)); at += step }
    if (length === 0) hash.update(bytes)
    assert.equal(hash.digest(), want, 'length ' + length)
  }
})
const toHex = bytes => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')

test('the length words past 512 MB: the padding for a synthetic counter equals the BigInt rule', () => {
  const kit = rescueKit({ indexedDB: null, localStorage: null })
  const counts = [0, 1, 55, 56, 63, 64, 2 ** 29 - 1, 2 ** 29, 2 ** 29 + 1, 2 ** 29 + 63, 2 ** 32 - 1, 2 ** 32, 2 ** 32 + 5, 3 * 2 ** 31 + 17, 2 ** 40 + 63, 2 ** 53 - 1]
  for (const count of counts) {
    const pad = kit.padding(count)
    assert.equal((count + pad.length) % 64, 0, String(count))
    assert.ok(pad.length >= 9 && pad.length <= 72, String(count))
    assert.equal(pad[0], 0x80)
    assert.ok(pad.subarray(1, pad.length - 8).every(byte => byte === 0))
    const bits = BigInt(count) * 8n
    const want = Buffer.alloc(8)
    want.writeBigUInt64BE(bits)
    assert.deepEqual(Buffer.from(pad.subarray(pad.length - 8)), want, String(count))
  }
  // Exactly 512 MB is 2^32 bits: the high word is 1 and the low word 0 (a 32-bit-only length would wrap to 0).
  assert.deepEqual(Array.from(kit.padding(2 ** 29).subarray(-8)), [0, 0, 0, 1, 0, 0, 0, 0])
  assert.throws(() => kit.padding(-1))
  assert.throws(() => kit.padding(2 ** 53))
})

/** The rows and their bytes as 61b1e3b6 hashed them: WebCrypto over the whole row and over each piece. */
async function oldCut(bytes) {
  const digest = async view => toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', view)))
  const pieces = []
  for (let offset = 0; offset < bytes.length; offset += PIECE) pieces.push(await digest(bytes.subarray(offset, Math.min(offset + PIECE, bytes.length))))
  return { sha256: await digest(bytes), pieces }
}

test('the piece and row hashes are byte-identical to the old way on the suite fixtures (the cloud wire depends on them)', async () => {
  const big = new Uint8Array(5 * 1048576 + 123)
  for (let at = 0; at < big.length; at++) big[at] = (at * 31 + 7) & 0xff
  const entries = storeEntries([['/dsh/home/big.bin', fileEntry(big)], ['/dsh/home/exact.bin', fileEntry(big.subarray(0, PIECE * 2))]])
  const idb = new FakeIndexedDb()
  idb.seed(DB, entries)
  const { index } = await rescueKit({ indexedDB: idb, localStorage: new FakeLocalStorage(SETTINGS) }).readIndex()
  const byKey = new Map(entries)
  let checked = 0
  for (const row of index.rows.filter(entry => entry.type === 'file')) {
    assert.deepEqual({ sha256: row.sha256, pieces: row.pieces }, await oldCut(byKey.get(row.key).bytes), row.key)
    checked += 1
  }
  for (const row of index.rows.filter(entry => entry.type === 'meta')) {
    assert.deepEqual({ sha256: row.sha256, pieces: row.pieces }, await oldCut(new TextEncoder().encode(JSON.stringify(byKey.get(row.key)))), row.key)
    checked += 1
  }
  assert.equal(checked, 10)
  assert.equal(index.rows.find(row => row.key === '/dsh/home/big.bin').pieces.length, 3)
})

test('memory: no hash or Blob part ever holds more than one piece of a row (the old kit copied whole rows twice)', async () => {
  const big = new Uint8Array(5 * 1048576 + 123)
  for (let at = 0; at < big.length; at++) big[at] = (at * 131 + 3) & 0xff
  const entries = storeEntries([['/dsh/home/big.bin', fileEntry(big)]])
  const seen = { digest: 0, part: 0 }
  const recordingCrypto = { subtle: { digest: (name, data) => { seen.digest = Math.max(seen.digest, data.byteLength); return crypto.subtle.digest(name, data) } } }
  class RecordingBlob extends Blob {
    constructor(parts = [], options) {
      for (const part of parts) if (ArrayBuffer.isView(part)) seen.part = Math.max(seen.part, part.byteLength)
      super(parts, options)
    }
  }
  const make = runInNewContext(`(${rescueKit.toString()})`, { crypto: recordingCrypto, Blob: RecordingBlob, TextEncoder, TextDecoder, setTimeout, URL })
  const idb = new FakeIndexedDb()
  idb.seed(DB, entries)
  const local = await make({ indexedDB: idb, localStorage: null }).saveLocal()
  assert.equal(local.complete, true, local.line)
  assert.ok(seen.digest <= PIECE, 'largest hash input ' + seen.digest)
  assert.ok(seen.part <= PIECE, 'largest Blob part ' + seen.part)
  // The pack is the same bytes as one made outside the recording context.
  const plainIdb = new FakeIndexedDb()
  plainIdb.seed(DB, entries)
  const plain = await rescueKit({ indexedDB: plainIdb, localStorage: null }).saveLocal()
  assert.deepEqual(Buffer.from(await local.blob.arrayBuffer()), Buffer.from(await plain.blob.arrayBuffer()))
  // The cloud copy: the same bound for every hash (the send, the read-back and the whole-row checks).
  seen.digest = 0
  const cloudIdb = new FakeIndexedDb()
  cloudIdb.seed(DB, entries)
  const vault = createFakeVault({ piece: PIECE })
  const cloud = await make({ indexedDB: cloudIdb, localStorage: null, fetch: vault.fetch, sleep: async () => {} }).copyToCloud()
  assert.equal(cloud.complete, true, cloud.line)
  assert.ok(seen.digest <= PIECE, 'largest hash input in the cloud copy ' + seen.digest)
})

// ── MUST 6: a way back ──────────────────────────────────────────────────────────────────────────────────────────────

test('--extract: every file row back as a file (threads included), modes at most owner rw, save times kept, re-hashed; counts only', async () => {
  const pack = await makePack('extract', { save: { settings: true } })
  const out = join(pack.folder, 'out')
  const run = verify(pack.path, '--extract', out)
  assert.equal(run.code, 0, run.out)
  assert.match(run.out, /extracted: files 6, folders 7, records 2, saved settings 2; gone rows not written 1/)
  assert.match(run.out, /not written: clashes 0, refused paths 0, failed the re-hash from disk 0, records that are not JSON 0/)
  assert.ok(!/\/dsh\/home\/|hello|private words/.test(run.out.split('extracted:')[1]), 'the extract prints counts only')
  const entries = new Map(storeEntries())
  for (const key of [MAIN, SIDE, NOTES, OTHER, PRIVATE_FILE, '/dsh/home/empty.txt']) {
    const file = join(out, 'files', key)
    assert.deepEqual(readFileSync(file), Buffer.from(entries.get(key).bytes), key)
    const info = statSync(file)
    assert.equal(info.mode & 0o777, entries.get(key).mode & 0o600, key + ' mode')
    assert.equal(Math.round(info.mtimeMs), entries.get(key).mtimeMs, key + ' save time')
  }
  assert.equal(statSync(join(out, 'files/dsh/home/auma/private')).mode & 0o777, 0o700)
  assert.equal(existsSync(join(out, 'files/dsh/home/old.txt')), false, 'a gone row is not written')
  assert.equal(existsSync(join(out, 'files/dsh/home/.credentials.yaml')), false)
  assert.equal(readFileSync(join(out, 'INDEX.json'), 'utf8'), parse(pack.buf).text)
  assert.deepEqual(JSON.parse(readFileSync(join(out, 'RECORDS.json'), 'utf8')).map(([key]) => key), ['@x6-content-revision', '@x6-mirror-meta'])
  assert.deepEqual(JSON.parse(readFileSync(join(out, 'SETTINGS.json'), 'utf8')), [['aukora-auma-live-log-v2:abc', 'what he said aloud'], ['aukora.theme', 'dark']])
  for (const name of ['INDEX.json', 'RECORDS.json', 'SETTINGS.json']) assert.equal(statSync(join(out, name)).mode & 0o777, 0o600, name)
  // Settings left out: SETTINGS.json holds the Auma Live chat log alone; with no chat log there is none.
  const off = await makePack('extract-off')
  const offOut = join(off.folder, 'out')
  const offRun = verify(off.path, '--extract', offOut)
  assert.equal(offRun.code, 0, offRun.out)
  assert.match(offRun.out, /Auma Live chat logs: 1\n/)
  assert.match(offRun.out, /saved settings: not copied \(only Auma Live chat logs\)/)
  assert.deepEqual(JSON.parse(readFileSync(join(offOut, 'SETTINGS.json'), 'utf8')), [['aukora-auma-live-log-v2:abc', 'what he said aloud']])
  const none = await makePack('extract-none', { settings: [['aukora.theme', 'dark']] })
  const noneOut = join(none.folder, 'out')
  assert.equal(verify(none.path, '--extract', noneOut).code, 0)
  assert.equal(existsSync(join(noneOut, 'SETTINGS.json')), false)
  // A folder that exists and is not empty is refused, and nothing in it is touched.
  const busy = join(off.folder, 'busy')
  mkdirSync(busy)
  writeFileSync(join(busy, 'mine.txt'), 'keep')
  const refused = verify(off.path, '--extract', busy)
  assert.equal(refused.code, 1, refused.out)
  assert.match(refused.out, /extract stopped: the extract folder exists and is not empty/)
  assert.deepEqual(readdirSync(busy), ['mine.txt'])
})

test('--extract refuses a pack that does not verify, and a NOT COMPLETE pack unless --extract-incomplete', async () => {
  const incomplete = await makePack('extract-incomplete', { entries: storeEntries([['@x6-binary', { data: new Uint8Array([1]) }]]) })
  const out = join(incomplete.folder, 'out')
  let run = verify(incomplete.path, '--extract', out)
  assert.equal(run.code, 3, run.out)
  assert.match(run.out, /extract refused: the pack is NOT COMPLETE/)
  assert.equal(existsSync(out), false)
  run = verify(incomplete.path, '--extract', out, '--extract-incomplete')
  assert.equal(run.code, 3, run.out)
  assert.ok(existsSync(join(out, 'files', MAIN)))
  const bad = Buffer.from(incomplete.buf)
  bad[20] ^= 1
  const badOut = join(incomplete.folder, 'bad-out')
  run = verify(put(join(incomplete.folder), 'bad-' + incomplete.result.fileName, bad), '--extract', badOut, '--extract-incomplete')
  assert.equal(run.code, 1, run.out)
  assert.match(run.out, /extract refused: the pack did not verify/)
  assert.equal(existsSync(badOut), false)
  assert.equal(verify(incomplete.path, '--extract-incomplete').code, 2, 'a usage error without --extract')
})

test('--extract never escapes its folder and never overwrites: bad path parts are refused, a file/folder clash is reported', async () => {
  // A pack whose rows are consistent (it verifies) but whose keys try to leave the folder or clash.
  const rows = [
    ['/dsh/home/../escape.txt', 'out'], ['/dsh/home/./dot.txt', 'dot'], ['/dsh/home/a//b.txt', 'empty part'], ['/dsh/home/nul\0.txt', 'nul'],
    ['/dsh/home/x', 'a file'], ['/dsh/home/x/y', 'under a file'], ['/dsh/home/z.txt', 'fine'],
  ].sort((a, b) => (a[0] < b[0] ? -1 : 1))
  let position = 11
  const data = [], indexRows = []
  for (const [key, text] of rows) {
    const bytes = Buffer.from(text)
    indexRows.push({ key, type: 'file', mode: 0o644, mtimeMs: 1700000000000, bytes: bytes.length, sha256: sha(bytes), pieces: [sha(bytes)], offset: position })
    data.push(bytes)
    position += bytes.length
  }
  const bytes = rows.reduce((sum, [, text]) => sum + Buffer.byteLength(text), 0)
  const index = { v: 1, piece: PIECE, source: 'indexeddb', client: { clientId: null, base: null, reconciliation: null }, rows: indexRows, skipped: [],
    totals: { threads: 0, homeFiles: rows.length, bytes, newestThreadMtimeMs: null, mainThread: null },
    completeness: { settings: false, unreadable: { count: 0, shapes: [] }, missing: 0, newRows: 0, grew: 0, changed: 0, vanished: 0, rechecked: rows.length },
    unlisted: { count: 0, shapes: [] } }
  const folder = join(scratch(), 'escape')
  mkdirSync(folder)
  const path = put(folder, 'aukora-rescue-' + idOf(index) + '.x61pack', assemble(Buffer.concat(data), canon(index)))
  assert.equal(verify(path).code, 0)
  const out = join(folder, 'out')
  const run = verify(path, '--extract', out)
  assert.equal(run.code, 1, run.out)
  assert.match(run.out, /extracted: files 2, /)
  assert.match(run.out, /not written: clashes 1, refused paths 4, /)
  assert.match(run.out, /EXTRACT NOT COMPLETE/)
  assert.equal(readFileSync(join(out, 'files/dsh/home/x'), 'utf8'), 'a file', 'the file was not overwritten by a folder')
  assert.equal(readFileSync(join(out, 'files/dsh/home/z.txt'), 'utf8'), 'fine')
  assert.equal(existsSync(join(out, 'files/dsh/escape.txt')), false)
  assert.equal(existsSync(join(folder, 'escape.txt')), false)
  assert.deepEqual(readdirSync(join(out, 'files/dsh/home')).sort(), ['x', 'z.txt'])
})

// ── SHOULD ──────────────────────────────────────────────────────────────────────────────────────────────────────────

test('the main thread and the newest save of ANY thread are two labelled figures', async () => {
  const { result } = await makePack('figures')
  assert.ok(result.line.includes(`main thread: ${'{"role":"user","text":"x"}\n'.length * 80} bytes, saved ${hhmm(T_MAIN)}; newest save of any thread: ${hhmm(T_SIDE)}`), result.line)
  assert.notEqual(hhmm(T_MAIN), hhmm(T_SIDE))
})

test('the memory source keeps mode & 0o777, as her app stores it', async () => {
  const fs = fakeFsFromEntries([['/dsh/home', dirEntry(0o41755)], ['/dsh/home/run.sh', fileEntry('x', 1, 0o104755)]])
  const { index } = await rescueKit({ source: 'memory', fs, indexedDB: null, localStorage: null }).readIndex()
  assert.deepEqual(index.rows.map(row => [row.key, row.mode]), [['/dsh/home', 0o755], ['/dsh/home/run.sh', 0o755]])
})

test('a queued save of any shape but [path, entry] pairs is never copied: it counts as unreadable', async () => {
  const shapes = [
    ['@x6-mirror-batch:01', { kind: 'mirror-batch', batch: { entries: { '/dsh/home/.ssh/id': {} } } }],
    ['@x6-mirror-batch:02', { kind: 'mirror-batch', batch: { entries: [['/dsh/home/a.md', {}, 'extra']] } }],
    ['@x6-mirror-batch:03', { kind: 'mirror-batch', batch: { entries: [[42, {}]] } }],
    ['@x6-mirror-batch:04', { kind: 'mirror-batch', entries: [['/dsh/home/.credentials.yaml', {}]] }],
    ['@x6-mirror-batch:05', { kind: 'mirror-batch', batch: { entries: [['/dsh/home/fine.md', { kind: 'file' }]] } }],
  ]
  const pack = await makePack('batches', { entries: storeEntries(shapes) })
  const index = parse(pack.buf).index
  assert.deepEqual(index.rows.filter(row => row.key.startsWith('@x6-mirror-batch:')).map(row => row.key), ['@x6-mirror-batch:05'])
  assert.deepEqual(index.completeness.unreadable, { count: 4, shapes: [{ shape: 'a bookkeeping row (@x6-mirror-batch:): a queued save of an unknown shape', count: 4 }] })
  assert.ok(!pack.buf.includes('/dsh/home/.ssh/id'), 'an unchecked queued save never reaches the pack')
  assert.equal(pack.result.complete, false)
})

test("the cloud copy also leaves main's estate names behind (not her private folder); the local pack keeps today's rule", async () => {
  const sensitive = ['/dsh/home/auma/server.pem', '/dsh/home/auma/node.key', '/dsh/home/auma/cert.P12', '/dsh/home/auma/my-secret.txt',
    '/dsh/home/auma/passwords/list.txt', '/dsh/home/auma/aws-credential.json', '/dsh/home/auma/old-keypair.bin', '/dsh/home/auma/private-key.txt',
    '/dsh/home/auma/Private_Key.txt']
  const entries = storeEntries([['/dsh/home/auma/passwords', dirEntry()], ...sensitive.map(key => [key, fileEntry('MARK')])])
  const idb = new FakeIndexedDb()
  idb.seed(DB, entries)
  const vault = createFakeVault({ piece: PIECE })
  const cloud = await rescueKit({ indexedDB: idb, localStorage: null, fetch: vault.fetch, sleep: async () => {} }).copyToCloud()
  assert.equal(cloud.complete, true, cloud.line)
  const sent = JSON.parse(new TextDecoder().decode(vault.rescues.get(cloud.id)))
  const keys = sent.rows.map(row => row.key)
  for (const key of [...sensitive, '/dsh/home/auma/passwords']) assert.ok(!keys.includes(key), key + ' must not reach her cloud')
  assert.ok(keys.includes(PRIVATE_FILE), 'her private folder is copied (chosen by the owner)')
  assert.ok(![...vault.blobs.values()].some(bytes => Buffer.from(bytes).toString() === 'MARK'))
  assert.ok(cloud.skipped.some(entry => entry.shape === 'file or folder named ….pem'))
  // The local pack: today's rule, so these names are in it.
  const local = await makePack('estate-local', { entries })
  const localKeys = parse(local.buf).index.rows.map(row => row.key)
  for (const key of sensitive) assert.ok(localKeys.includes(key), key + ' stays in the local pack')
})
