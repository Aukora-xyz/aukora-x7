/**
 * The rescue kit and the `/rescue` page. The kit runs in a browser that may hold the only full
 * copy of her main thread, so every test here also asks: did it create, change or hold anything? Its outsides are the
 * in-memory fakes in rescue-fakes.mjs (an IndexedDB that records every open, transaction and request; a localStorage that
 * records writes; the worker file system face; a `/_vault/*` as strict as the edge).
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { setFlagsFromString } from 'node:v8'
import { rescueKit } from '../rescue-kit.mjs'
import { RESCUE_PAGE, rescuePageResponse, rescueBusyResponse, wantsRescueDocument } from '../rescue-page.mjs'
import { composeRescuePageScript, rescuePageScriptModule, composeLocalConsoleScript, composeMemoryConsoleScript } from '../rescue-page.generate.mjs'
import { FakeIndexedDb, FakeLocalStorage, createFakeVault, fakeFsFromEntries, rowBreaksRule, fileEntry, dirEntry, goneEntry } from './rescue-fakes.mjs'
import { waitFor } from './wait-for.mjs'

const DB = 'aukora-x6-vfs'
const PIECE = 64
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const later = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms))
const ROOT = fileURLToPath(new URL('../../../../', import.meta.url))
const MAIN = '/dsh/home/sessions/agent/main/session.v3.jsonl'
const SMALL = '/dsh/home/auma/session/messages.jsonl'
const NOTES = '/dsh/home/auma/notes.md'
const T_NEWEST = new Date(2026, 10, 12, 13, 58, 30).getTime()
const T_CHECK = new Date(2026, 10, 12, 14, 2, 10).getTime()
const MAIN_LINE = '{"role":"user","text":"x"}\n'
const MAIN_BYTES = MAIN_LINE.length * 30

/** Her store, shaped as idb-persist writes it: folders, files (two threads, one empty file), a gone row, bookkeeping. */
function storeEntries(extra = []) {
  return [
    ['/dsh/home', dirEntry()], ['/dsh/home/auma', dirEntry()], ['/dsh/home/auma/session', dirEntry()],
    ['/dsh/home/sessions', dirEntry()], ['/dsh/home/sessions/agent', dirEntry()], ['/dsh/home/sessions/agent/main', dirEntry()],
    [NOTES, fileEntry('hello '.repeat(40), 1700000000001)],
    ['/dsh/home/auma/empty.txt', fileEntry(new Uint8Array(0), 1700000000002)],
    [SMALL, fileEntry('{"line":1}\n'.repeat(10), T_NEWEST - 60000)],
    [MAIN, fileEntry(MAIN_LINE.repeat(30), T_NEWEST)],
    ['/dsh/home/old.txt', goneEntry()],
    ['@x6-mirror-meta', { clientId: 'client-1', cloudBase: { lineageId: 'L1', revision: 7 } }],
    ['@x6-content-revision', { kind: 'content-revision', seq: 9 }],
    ['@x6-cloud-reconciliation', { kind: 'cloud-reconciliation', firstRevision: 3, lastRevision: 5, scope: 'all-persisted-mirror-content', cause: 'transient' }],
    ...extra,
  ]
}
function world({ extra = [], settings = [['aukora.theme', 'dark']], step = 2, piece = PIECE, listsDatabases = true } = {}) {
  const idb = new FakeIndexedDb({ listsDatabases })
  idb.seed(DB, storeEntries(extra))
  const ls = new FakeLocalStorage(settings)
  const vault = createFakeVault({ piece, step })
  const sleeps = []
  const kit = (more = {}) => rescueKit({ indexedDB: idb, localStorage: ls, fetch: vault.fetch, piece, now: () => T_CHECK,
    sleep: async ms => { sleeps.push(ms); await later(0) }, ...more })
  return { idb, ls, vault, kit, sleeps }
}
const snapshot = map => JSON.stringify(Array.from(map, ([key, value]) => [key, value && value.bytes ? { ...value, bytes: Array.from(value.bytes) } : value]))
const hhmm = ms => { const d = new Date(ms); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') }

// ── MUST 1: never create, change or hold the database ───────────────────────────────────────────────────────────────

test('no database listed: open is never called and nothing is sent', async () => {
  const idb = new FakeIndexedDb()
  const vault = createFakeVault({ piece: PIECE })
  const kit = rescueKit({ indexedDB: idb, localStorage: null, fetch: vault.fetch, piece: PIECE })
  for (const result of [await kit.copyToCloud(), await kit.saveLocal()]) {
    assert.equal(result.line, 'This browser holds nothing of hers to copy.')
    assert.equal(result.complete ?? false, false)
  }
  assert.equal(idb.log.opens.length, 0)
  assert.equal(vault.log.length, 0)
  assert.equal(idb.dbs.size, 0)
})

test('databases() missing and no database: the would-be creation is aborted and no database exists afterwards', async () => {
  const idb = new FakeIndexedDb({ listsDatabases: false })
  assert.equal(typeof idb.databases, 'undefined')
  const kit = rescueKit({ indexedDB: idb, localStorage: null, fetch: async () => { throw new Error('no network') }, piece: PIECE })
  const result = await kit.copyToCloud()
  assert.equal(result.line, 'This browser holds nothing of hers to copy.')
  assert.equal(idb.log.opens.length, 1)
  assert.equal(idb.log.opens[0].withVersion, false, 'opened with no version')
  assert.equal(idb.log.aborted, 1, 'the upgrade was aborted')
  assert.equal(idb.dbs.size, 0, 'no database exists afterwards')
  assert.deepEqual(idb.log.created, [], 'no store was ever created')
  // Where her database exists but databases() is missing, the open goes ahead without an upgrade.
  const w = world({ listsDatabases: false })
  assert.equal((await w.kit().copyToCloud()).complete, true)
  assert.equal(w.idb.log.aborted, 0)
})

test('a database without her store is left alone: "nothing to copy", no store created, connection closed', async () => {
  const idb = new FakeIndexedDb()
  idb.seed(DB, [], { version: 1, store: null })
  const result = await rescueKit({ indexedDB: idb, localStorage: null, piece: PIECE }).copyToCloud()
  assert.equal(result.line, 'This browser holds nothing of hers to copy.')
  assert.equal(idb.dbs.get(DB).version, 1)
  assert.deepEqual(idb.log.created, [])
  assert.equal(idb.log.closes, 1)
})

test('a full run is read-only: zero readwrite, zero getAll, one get per transaction, zero localStorage writes; it says complete', async () => {
  const w = world({ settings: [['aukora.theme', 'dark'], ['x6.last-thread', MAIN], ['oauthState', 'secret-ish']] })
  const before = snapshot(w.idb.data())
  const lines = []
  // settings: true, the caller who asks for saved settings (job 3 made the cloud copy leave them out by default).
  const result = await w.kit().copyToCloud({ report: line => lines.push(line), settings: true })
  assert.equal(result.complete, true, JSON.stringify(result))
  // 2 threads; home files are the other files under /dsh/home (notes.md, empty.txt). The main thread and the newest save
  // of ANY thread are two labelled figures (here the main thread is also the newest).
  assert.equal(result.line, `Rescue copy complete and checked: 2 threads, 2 home files, 0 MB; main thread: ${MAIN_BYTES} bytes, saved ${hhmm(T_NEWEST)}; newest save of any thread: ${hhmm(T_NEWEST)}; checked ${hhmm(T_CHECK)}`)
  assert.equal(lines.at(-1), result.line)
  assert.equal(w.idb.writableTransactions().length, 0, 'no readwrite or versionchange transaction')
  assert.equal(w.idb.count('getAll'), 0)
  assert.equal(w.idb.count('openCursor') + w.idb.count('openKeyCursor'), 0)
  assert.equal(w.idb.log.requests.filter(request => request.refused).length, 0)
  for (const tx of w.idb.log.transactions) {
    assert.equal(tx.mode, 'readonly')
    assert.equal(tx.requests.length, 1, 'each request has its own transaction')
  }
  assert.ok(w.idb.count('get') > 0)
  assert.equal(w.idb.count('getAllKeys'), 2, 'one listing at the start, a second at the end')
  assert.ok(w.idb.log.opens.every(open => open.withVersion === false), 'every open has no version')
  assert.equal(w.ls.writes.length, 0, 'localStorage saw no write')
  assert.equal(snapshot(w.idb.data()), before, 'her store is byte-identical afterwards')
  assert.equal(w.idb.dbs.get(DB).version, 2)
  assert.equal(w.idb.log.closes, w.idb.log.opens.length, 'every connection it opened is closed')
  // The client and (asked for) the saved settings travel; a setting with a secret-like name does not.
  const index = JSON.parse(new TextDecoder().decode(w.vault.rescues.get(result.id)))
  assert.deepEqual(index.client, { clientId: 'client-1', base: { lineageId: 'L1', revision: 7 }, reconciliation: { kind: 'cloud-reconciliation', firstRevision: 3, lastRevision: 5, scope: 'all-persisted-mirror-content', cause: 'transient' } })
  assert.deepEqual(index.rows.filter(row => row.type === 'local').map(row => row.key), ['localStorage:aukora.theme', 'localStorage:x6.last-thread'])
  assert.deepEqual(index.totals.mainThread, { key: MAIN, bytes: MAIN_BYTES })
  assert.equal(index.totals.newestThreadMtimeMs, T_NEWEST)
})

test('her app upgrading its storage mid-run closes the connection and stops with the plain line', async () => {
  const w = world()
  let fired = false
  w.idb.hooks.beforeRequest = (method, key, count, db) => { if (method === 'get' && count === 3 && !fired) { fired = true; db.fireVersionChange() } }
  const result = await w.kit().copyToCloud()
  assert.equal(result.line, 'This copy is not complete: her app is upgrading its storage here. Run this again.')
  assert.equal(result.complete, false)
  assert.equal(w.idb.dbs.get(DB).connections.size, 0, 'the kit closed its connection')
  assert.equal(w.idb.log.closes, w.idb.log.opens.length)
})

// ── MUST 2: what is copied, and what is not ─────────────────────────────────────────────────────────────────────────

const SECRET_BASES = ['.credentials.yaml', 'credentials.yaml', 'session.cap', '.afferent-probe', 'ed25519-keypair.json', '.credentials', '.ssh', '.aws', '.transport', 'pepper.v1', 'checkpoint-signer.v1.json']

test('the secret rule: every name, with any ending after the mark, dotted or not; ordinary names pass', () => {
  const kit = rescueKit({ indexedDB: null, localStorage: null })
  for (const base of SECRET_BASES) {
    for (const name of [base, base + '.3fa9c1.tmp', base + '~', base + '-old', base + '_bak', '.' + base, '.' + base + '.tmp', '.' + base + '~']) {
      assert.ok(kit.secretShape('/dsh/home/auma/' + name), name)
      assert.ok(kit.secretShape('/dsh/home/' + name + '/inside.txt'), name + ' as a folder')
    }
  }
  for (const name of ['.credentials.yaml.3fa9c1.tmp', '.credentials.yaml_bak', 'session.cap_old', '.env', '.env.local', '.aukora-anything']) {
    assert.ok(kit.secretShape('/dsh/home/' + name), name)
  }
  for (const name of ['notes.md', 'credentials', 'session.capx', 'pepper.v10', 'xcredentials.yaml', '.DS_Store', '.conflict-backup', 'sessions', 'environment']) {
    assert.equal(kit.secretShape('/dsh/home/' + name), null, name)
  }
  // Saved settings: secret-shaped names, and any name holding one of the words, in any case.
  for (const name of ['apiKey', 'SECRET_x', 'myPassword', 'oauthState', 'capture', 'credentialHint', 'session' + 'TOKEN', '.env', 'x/session.cap']) {
    assert.ok(kit.settingShape(name), name)
  }
  assert.equal(kit.settingShape('aukora.theme'), null)
})

test('secret-shaped rows are skipped as path rows, reset rows, waiting saves and inside a queued save; counted by shape only', async () => {
  const batch = (seq, paths) => ({ kind: 'mirror-batch', digest: 'd', batch: { clientId: 'client-1', seq, id: 'b' + seq,
    entries: paths.map(path => [path, { kind: 'file', b64: 'eA==', mode: 420, mtimeMs: 1 }]) } })
  const extra = [
    ['/dsh/home/.credentials.yaml', fileEntry('secret: 1')],
    ['/dsh/home/.credentials.yaml.3fa9c1.tmp', goneEntry()],
    ['/dsh/home/.credentials.yaml.77aa01.tmp', goneEntry()],
    ['/dsh/home/.credentials.yaml_bak', fileEntry('secret: 2')],
    ['/dsh/home/auma/session.cap_old', fileEntry('cap')],
    ['/dsh/home/.ssh', dirEntry()],
    ['/dsh/home/.ssh/id_ed25519', fileEntry('key')],
    ['/dsh/home/.env.local', fileEntry('A=1')],
    ['/dsh/home/auma/pepper.v1.next', fileEntry('p')],
    // job 2: a secret-shaped row INSIDE her private room is judged by its key first, like any other: never read.
    ['/dsh/home/auma/private/ed25519-keypair.json', fileEntry('made-up pair')],
    ['@x6-vfs-reset:/dsh/home/.credentials.yaml.3fa9c1.tmp', { kind: 'subtree-reset', path: '/dsh/home/.credentials.yaml.3fa9c1.tmp' }],
    ['@x6-vfs-reset:/dsh/home/auma', { kind: 'subtree-reset', path: '/dsh/home/auma' }],
    ['@x6-deferred-journal:/dsh/home/.aukora-cache/x.jsonl', { kind: 'deferred-journal', path: '/dsh/home/.aukora-cache/x.jsonl', notBefore: 1, failures: 0 }],
    ['@x6-mirror-batch:0000000000000001', batch(1, ['/dsh/home/auma/notes.md', '/dsh/home/session.cap_old'])],
    ['@x6-mirror-batch:0000000000000002', batch(2, ['/dsh/home/auma/notes.md'])],
  ]
  const w = world({ extra, settings: [['aukora.theme', 'dark'], ['apiKey', 'k'], ['session' + 'Token', 't']] })
  const result = await w.kit().copyToCloud({ settings: true })
  assert.equal(result.complete, true, result.line + ' ' + result.lines.join(' | '))
  // The rows and the client travel; the skipped list names only shapes (checked below).
  const sent = JSON.parse(new TextDecoder().decode(w.vault.rescues.get(result.id)))
  const text = JSON.stringify([sent.rows, sent.client])
  for (const fragment of ['.credentials', 'session.cap', '.ssh', '.env', 'pepper.v1', '.aukora-', 'apiKey', 'ession' + 'Token', 'secret: ', 'keypair', 'made-up pair']) {
    assert.ok(!text.includes(fragment), fragment + ' must not travel')
  }
  const keys = sent.rows.map(row => row.key)
  assert.ok(keys.includes('@x6-vfs-reset:/dsh/home/auma'), 'an ordinary reset row travels')
  assert.ok(keys.includes('@x6-mirror-batch:0000000000000002'), 'an ordinary queued save travels')
  assert.ok(!keys.includes('@x6-mirror-batch:0000000000000001'), 'a queued save holding a secret is skipped whole')
  assert.deepEqual(result.skipped, [
    { shape: 'file or folder named .credentials.yaml', count: 1 },
    { shape: 'file or folder named .credentials.yaml plus an ending', count: 3 },
    { shape: 'file or folder named .env…', count: 1 },
    { shape: 'file or folder named .ssh', count: 2 },
    { shape: 'file or folder named ed25519-keypair.json', count: 1 },
    { shape: 'file or folder named pepper.v1 plus an ending', count: 1 },
    { shape: 'file or folder named session.cap plus an ending', count: 1 },
    { shape: 'queued save holding session.cap plus an ending', count: 1 },
    { shape: 'reset row for .credentials.yaml plus an ending', count: 1 },
    { shape: 'saved setting with a secret-like name', count: 2 },
    { shape: 'waiting save for .aukora-…', count: 1 },
  ])
  // Secret-shaped rows are never even read.
  const read = new Set(w.idb.log.requests.filter(request => request.method === 'get').map(request => request.key))
  assert.ok(![...read].some(key => /credentials|session\.cap|\.ssh|\.env|pepper|\.aukora-|keypair/.test(key)), [...read].join(','))
  // ... and one in her private room is listed by kind above, never counted as one of the room's files.
  assert.deepEqual(result.leftAtOrigin, { private: { files: 0, bytes: 0 } })
  assert.equal(w.ls.writes.length, 0)
})

test('the secret lists in the app and the edge cannot drift from this rule unseen', () => {
  // on the deploy tree the edge's list lives in mirror-secret-paths.mjs (the secret-path rule) and the app's twin carries
  // a type annotation; both are read, so the check still finds every list it found before.
  const sources = [readFileSync(new URL('../mirror-do.mjs', import.meta.url), 'utf8'),
    readFileSync(new URL('../mirror-secret-paths.mjs', import.meta.url), 'utf8'),
    readFileSync(join(ROOT, 'packages/experimental/webworker-runtime/src/storage/idb-persist.ts'), 'utf8')]
  const anchors = [/secretNames\s*=\s*new Set\(\[([^\]]*)\]/g, /REMOTE_SECRET_SEGMENTS\s*=\s*new Set\(\[([^\]]*)\]/g,
    /MIRROR_SECRET_NAMES(?:\s*:\s*[^=]+)?\s*=\s*(?:new Set\(|Object\.freeze\()?\[([^\]]*)\]/g]
  const names = new Set()
  for (const text of sources) for (const anchor of anchors) for (const match of text.matchAll(anchor)) for (const name of match[1].matchAll(/'([^']+)'/g)) names.add(name[1])
  assert.ok(names.size >= 9, 'found ' + [...names].join(', '))
  const kit = rescueKit({ indexedDB: null, localStorage: null })
  for (const name of names) {
    if (name === '.DS_Store' || name === '.conflict-backup') { assert.equal(kit.secretShape('/dsh/home/' + name), null, name); continue }
    assert.ok(kit.secretShape('/dsh/home/' + name), name + ' is in an app or edge secret list but not secret-shaped here')
  }
})

test('a 5 MiB file gives three pieces at the fixed offsets and the right whole hash', async () => {
  const bytes = new Uint8Array(5 * 1024 * 1024)
  for (let at = 0; at < bytes.length; at++) bytes[at] = (at * 31 + 7) & 0xff
  const idb = new FakeIndexedDb()
  idb.seed(DB, [['/dsh/home/big.bin', fileEntry(bytes)]])
  const kit = rescueKit({ indexedDB: idb, localStorage: null })
  assert.equal(kit.PIECE, 2097152)
  const { index } = await kit.readIndex()
  assert.equal(index.piece, 2097152)
  const [row] = index.rows
  assert.equal(row.bytes, 5242880)
  assert.equal(row.sha256, sha(bytes))
  assert.deepEqual(row.pieces, [sha(bytes.subarray(0, 2097152)), sha(bytes.subarray(2097152, 4194304)), sha(bytes.subarray(4194304))])
})

test('every index row follows the row rule: dir and gone rows exactly empty, the zero-byte file has no pieces', async () => {
  const w = world()
  // settings: true, so a saved-setting row is checked against the row rule too (they stay behind by default).
  const { index, text, id } = await w.kit().readIndex({ settings: true })
  assert.equal(id, sha(text).slice(0, 32))
  assert.ok(!/"(?:checkedAt|createdAt|now|time)"/.test(text), 'no clock in the index')
  const types = new Set()
  for (const row of index.rows) {
    for (const field of ['key', 'type', 'bytes', 'sha256', 'pieces']) assert.ok(field in row, row.key + ' ' + field)
    assert.equal(rowBreaksRule(row, PIECE), false, row.key)
    types.add(row.type)
    if (row.type === 'dir' || row.type === 'gone') { assert.equal(row.bytes, 0); assert.equal(row.sha256, null); assert.deepEqual(row.pieces, []) }
    if (row.type === 'dir') assert.equal(row.mode, 0o755)
    if (row.type === 'file') { assert.equal(typeof row.mode, 'number'); assert.equal(typeof row.mtimeMs, 'number') }
  }
  assert.deepEqual([...types].sort(), ['dir', 'file', 'gone', 'local', 'meta'])
  const empty = index.rows.find(row => row.key === '/dsh/home/auma/empty.txt')
  assert.deepEqual([empty.bytes, empty.sha256, empty.pieces], [0, sha(Buffer.alloc(0)), []])
  const notes = index.rows.find(row => row.key === NOTES)
  assert.equal(notes.pieces.length, Math.ceil(240 / PIECE))
  assert.deepEqual(index.rows.map(row => row.key), index.rows.map(row => row.key).slice().sort())
  assert.deepEqual(Object.keys(index.totals).sort(), ['bytes', 'homeFiles', 'mainThread', 'newestThreadMtimeMs', 'threads'])
})

test('the same store twice gives the same index bytes and the same id', async () => {
  const w = world()
  const [a, b] = [await w.kit().readIndex(), await w.kit().readIndex()]
  assert.equal(a.text, b.text)
  assert.equal(a.id, b.id)
  const [first, second] = [await w.kit().copyToCloud(), await w.kit().copyToCloud()]
  assert.equal(first.id, a.id)
  assert.equal(second.id, a.id)
  assert.equal(second.complete, true)
})

test('unreadable rows (binary bookkeeping, a key that is not text) mean the run is not complete', async () => {
  const w = world({ extra: [['@x6-strange', { blob: new Uint8Array([1, 2, 3]) }], [42, { kind: 'gone' }]] })
  const result = await w.kit().copyToCloud()
  assert.equal(result.complete, false)
  assert.equal(result.line, 'This copy is not complete.')
  assert.deepEqual(result.unreadable.slice().sort(), ['@x6-strange', 'a row whose key is not text'])
  assert.ok(result.lines.includes('2 rows could not be read here.'))
})

// ── MUST 3: the cloud, checked byte for byte ────────────────────────────────────────────────────────────────────────

test('verify: the first call is cursor=0, each later one carries the reply before it; after a 424 the same cursor again', async () => {
  const w = world({ step: 2 })
  const { index } = await w.kit().readIndex()
  // A piece of a row the walk reaches only after a few calls goes missing just as the walk starts.
  const late = index.rows.findIndex((row, at) => at >= 4 && row.pieces.length > 0)
  const target = index.rows[late].pieces[0]
  let removed = false
  w.vault.hook = ({ method, path }) => {
    if (!removed && method === 'POST' && path.endsWith('/verify')) { removed = true; w.vault.blobs.delete(target) }
  }
  const result = await w.kit().copyToCloud()
  assert.equal(result.complete, true, result.line + result.lines.join('|'))
  const calls = w.vault.verifyCalls
  assert.equal(calls[0].sent, '0')
  assert.ok(calls.some(call => call.status === 424 && call.sent !== '0'), 'the 424 came at a later cursor')
  for (let at = 1; at < calls.length; at++) {
    const before = calls[at - 1]
    assert.equal(calls[at].sent, before.status === 424 ? before.sent : String(before.next), 'call ' + at)
  }
  assert.equal(calls.at(-1).status, 200)
  assert.ok(w.vault.blobs.has(target), 'the missing piece was sent again')
  assert.equal(w.vault.puts().filter(entry => entry.path.endsWith(target)).length, 2)
})

test('the fake vault is as strict as the edge: a row that breaks the rule and a verify call with no cursor get 400', async () => {
  const vault = createFakeVault({ piece: PIECE })
  const send = async index => {
    const bytes = new TextEncoder().encode(JSON.stringify(index))
    return vault.fetch('/_vault/rescue/' + sha(bytes).slice(0, 32), { method: 'PUT', body: bytes })
  }
  const base = { v: 1, piece: PIECE, rows: [{ key: '/dsh/home', type: 'dir', bytes: 0, sha256: null, pieces: [] }] }
  assert.equal((await send(base)).status, 201)
  for (const row of [{ key: '/a', type: 'dir', bytes: 0, sha256: '', pieces: [] }, { key: '/a', type: 'gone', bytes: 0, sha256: null },
    { key: '/a', type: 'file', bytes: 70, sha256: sha('x'), pieces: [sha('x')] }, { key: '/a', type: 'meta', bytes: 1, sha256: 'ABC', pieces: [sha('x')] }]) {
    assert.equal((await send({ ...base, rows: [row] })).status, 400, JSON.stringify(row))
  }
  const id = [...vault.rescues.keys()][0]
  assert.equal((await vault.fetch('/_vault/rescue/' + id + '/verify', { method: 'POST' })).status, 400)
  assert.equal((await vault.fetch('/_vault/rescue/' + id + '/verify?cursor=5', { method: 'POST' })).status, 400, 'a cursor it never gave')
  assert.equal((await vault.fetch('/_vault/rescue/' + id + '/verify?cursor=0', { method: 'POST' })).status, 200)
})

test('a 400 on the index stops with the plain line and never says complete', async () => {
  const w = world()
  w.vault.hook = ({ method, path }) => (method === 'PUT' && path.startsWith('/_vault/rescue/') ? new Response('{"ok":false,"code":"VAULT_REQUEST_INVALID"}', { status: 400 }) : undefined)
  const result = await w.kit().copyToCloud()
  assert.equal(result.line, "Her cloud did not take this copy's list. Report this.")
  assert.equal(result.complete, false)
  assert.equal(w.vault.verifyCalls.length, 0)
  // A 400 on verify too.
  const v = world()
  v.vault.hook = ({ method, path }) => (method === 'POST' && path.endsWith('/verify') ? new Response('{"ok":false,"code":"VAULT_REQUEST_INVALID"}', { status: 400 }) : undefined)
  const again = await v.kit().copyToCloud()
  assert.equal(again.line, "Her cloud did not take this copy's list. Report this.")
  assert.equal(again.complete, false)
})

test('a resumed run re-sends only the missing pieces', async () => {
  const w = world()
  let puts = 0
  w.vault.hook = ({ method, path }) => {
    if (method === 'PUT' && path.startsWith('/_vault/blob/') && ++puts === 4) return new Response('{"ok":false,"code":"VAULT_FULL"}', { status: 507 })
  }
  const first = await w.kit().copyToCloud()
  assert.equal(first.line, 'Her cloud copy space is full. Report this.')
  assert.equal(first.complete, false)
  const stored = w.vault.blobs.size
  assert.ok(stored >= 3)
  const distinct = new Set((await w.kit().readIndex()).index.rows.flatMap(row => row.pieces)).size
  w.vault.hook = null
  const mark = w.vault.log.length
  const second = await w.kit().copyToCloud()
  assert.equal(second.complete, true)
  const blobPuts = w.vault.log.slice(mark).filter(entry => entry.method === 'PUT' && entry.path.startsWith('/_vault/blob/'))
  assert.equal(blobPuts.length, distinct - stored, 'only the pieces her cloud did not hold')
})

test('the upload holds one row at a time: a row whose pieces are still in flight is let go before the next row is read', async () => {
  setFlagsFromString('--expose-gc')
  const gc = runInNewContext('gc')
  const A = '/dsh/home/a.bin', B = '/dsh/home/b.bin'
  const base = fakeFsFromEntries([['/dsh/home', dirEntry()], [A, fileEntry(new Uint8Array(PIECE * 2).map((_, at) => at & 0xff))], [B, fileEntry('b'.repeat(PIECE))]])
  // Every read hands out its own buffer, watched by a WeakRef only, so the test itself never keeps a row alive.
  const reads = new Map(), watched = []
  let open = null
  const gate = new Promise(resolve => { open = resolve })
  const vault = createFakeVault({ piece: PIECE })
  const seen = { aLive: null, inFlight: null }
  const fs = {
    statSync: path => base.statSync(path),
    readdirSync: path => base.readdirSync(path),
    readFileSync(path) {
      const n = (reads.get(path) || 0) + 1
      reads.set(path, n)
      if (path === B && n === 2) {
        // The upload is about to read row B while row A's pieces wait at the edge.
        seen.inFlight = vault.inFlight
        gc()
        seen.aLive = watched.find(entry => entry.path === A && entry.n === 2).ref.deref() !== undefined
        open()
      }
      const copy = base.readFileSync(path).slice()
      watched.push({ path, n, ref: new WeakRef(copy.buffer) })
      return copy
    },
  }
  vault.hook = async ({ path }) => { if (path.startsWith('/_vault/blob/')) await Promise.race([gate, later(2000)]) }
  const result = await rescueKit({ source: 'memory', fs, indexedDB: null, localStorage: null, piece: PIECE, fetch: vault.fetch, sleep: async () => {} }).copyToCloud()
  assert.equal(result.complete, true, result.line)
  assert.ok(seen.inFlight >= 1, 'row A still had pieces in flight when row B was read')
  assert.equal(seen.aLive, false, "row A's whole buffer was still held while row B was read")
})

test('one flipped byte in a stored piece: the read-back names the row and the page does not say complete', async () => {
  const w = world()
  assert.equal((await w.kit().copyToCloud()).complete, true)
  const { index } = await w.kit().readIndex()
  const notes = index.rows.find(row => row.key === NOTES)
  w.vault.flip(notes.pieces[1])
  const result = await w.kit().copyToCloud()
  assert.equal(result.complete, false)
  assert.equal(result.line, 'This copy is not complete.')
  assert.deepEqual(result.mismatched, [NOTES])
  assert.ok(result.lines.includes('Not the same in her cloud: ' + NOTES))
})

test('the index fetched back differs from the one sent: not complete', async () => {
  const w = world()
  w.vault.hook = ({ method, path }) => {
    if (method === 'GET' && /^\/_vault\/rescue\/[0-9a-f]{32}$/.test(path)) w.vault.tamperIndex(path.slice(-32))
  }
  const result = await w.kit().copyToCloud()
  assert.equal(result.complete, false)
  assert.equal(result.line, 'This copy is not complete.')
  assert.match(result.lines[0], /different list/)
})

test('a thread that grows between the two reads is checked as a prefix and reported as grown', async () => {
  const w = world()
  let gets = 0
  w.idb.hooks.beforeRequest = (method, key, count, db) => {
    if (method === 'get' && key === MAIN && ++gets === 2) {
      const value = db.stores.get('entries').get(MAIN)
      value.bytes = new Uint8Array([...value.bytes, ...new TextEncoder().encode('{"role":"assistant","text":"new"}\n')])
    }
  }
  const result = await w.kit().copyToCloud()
  assert.equal(result.complete, true, result.lines.join('|'))
  assert.equal(result.grew, 1)
  assert.ok(result.lines.includes('1 threads grew since this copy. Run again to add the new lines.'))
  // A row that changes in any other way is not checked, and named: the recheck names it as CHANGED here (the source
  // moved), not as "not the same in her cloud" (her cloud holds exactly what was copied).
  const c = world()
  let seen = 0
  c.idb.hooks.beforeRequest = (method, key, count, db) => {
    if (method === 'get' && key === NOTES && ++seen === 3) db.stores.get('entries').get(NOTES).bytes[0] ^= 1
  }
  const changed = await c.kit().copyToCloud()
  assert.equal(changed.complete, false)
  assert.equal(changed.line, 'This copy is not complete.')
  assert.deepEqual(changed.changed, [NOTES])
  assert.deepEqual(changed.mismatched, [])
  assert.ok(changed.lines.includes('Changed: ' + NOTES), JSON.stringify(changed.lines))
})

test('a new key at the end means the run is not complete', async () => {
  const w = world()
  w.idb.hooks.beforeRequest = (method, key, count, db) => {
    if (method === 'getAllKeys' && count === 2) db.stores.get('entries').set('/dsh/home/auma/fresh.md', fileEntry('new'))
  }
  const result = await w.kit().copyToCloud()
  assert.equal(result.complete, false)
  assert.equal(result.newRows, 1)
  assert.ok(result.lines.includes('1 new rows since this copy. Run again.'))
})

test('507 stops cleanly with the plain line; RESCUE_LIMIT says so', async () => {
  const w = world()
  w.vault.hook = ({ method, path }) => (method === 'PUT' && path.startsWith('/_vault/blob/') ? new Response('{"ok":false}', { status: 507 }) : undefined)
  const full = await w.kit().copyToCloud()
  assert.equal(full.line, 'Her cloud copy space is full. Report this.')
  assert.equal(full.complete, false)
  const l = world()
  l.vault.hook = ({ method, path }) => (method === 'PUT' && path.startsWith('/_vault/rescue/') ? new Response('{"ok":false,"code":"RESCUE_LIMIT"}', { status: 507 }) : undefined)
  assert.equal((await l.kit().copyToCloud()).line, 'Her cloud already holds its limit of rescue copies. Report this.')
})

test('408s: retried five times with a growing wait then a clean stop; after the first 408 no two requests overlap', async () => {
  const w = world()
  const { index } = await w.kit().readIndex()
  const stuck = index.rows.find(row => row.key === NOTES).pieces[0]
  let tries = 0
  w.vault.hook = ({ path }) => { if (path.endsWith(stuck)) { tries += 1; return new Response(null, { status: 408 }) } }
  const result = await w.kit().copyToCloud()
  assert.equal(result.line, 'Her cloud did not answer. Press the button again: pieces already there are not sent again.')
  assert.equal(result.complete, false)
  assert.equal(tries, 6, 'the first try and five retries')
  assert.deepEqual(w.sleeps, [500, 1000, 2000, 4000, 8000])
  assert.equal(w.vault.overlapAfter408, false)
  assert.equal(w.vault.verifyCalls.length, 0)
  // Without a 408 the pieces do go three at a time (so the check above means something) ...
  const free = world()
  assert.equal((await free.kit().copyToCloud()).complete, true)
  assert.ok(free.vault.maxInFlight > 1)
  // ... and after one 408 the run finishes one request at a time.
  const once = world()
  let fired = false
  once.vault.hook = ({ method }) => { if (!fired && method === 'HEAD' && once.vault.log.length >= 3) { fired = true; return new Response(null, { status: 408 }) } }
  const finished = await once.kit().copyToCloud()
  assert.equal(finished.complete, true)
  assert.equal(fired, true)
  assert.equal(once.vault.overlapAfter408, false)
})

test('401 stops at once with the sign-in line and no further request', async () => {
  const w = world()
  let target = null
  w.vault.hook = ({ entry }) => { if (entry.n === 4) { target = entry.n; return new Response('{"ok":false,"code":"OWNER_ACCESS_REQUIRED"}', { status: 401 }) } }
  const result = await w.kit().copyToCloud()
  assert.equal(result.line, 'Your sign-in ended. Sign in again on this page, then press the button again.')
  assert.equal(result.signin, true)
  assert.equal(result.complete, false)
  const ended = w.vault.events.findIndex(([kind, n]) => kind === 'end' && n === target)
  assert.ok(ended >= 0)
  assert.deepEqual(w.vault.events.slice(ended + 1).filter(([kind]) => kind === 'start'), [], 'no request started after the 401')
  assert.equal(w.sleeps.length, 0, 'a 401 is never waited out')
})

test('forty 503 OWNER_SESSION_UNAVAILABLE answers, then success: the run completes (never "signed out")', async () => {
  const w = world()
  let busy = 0
  w.vault.hook = () => {
    if (busy < 40) { busy += 1; return new Response('{"ok":false,"code":"OWNER_SESSION_UNAVAILABLE"}', { status: 503, headers: { 'retry-after': '1', 'content-type': 'application/json' } }) }
  }
  const lines = []
  const result = await w.kit().copyToCloud({ report: line => lines.push(line) })
  assert.equal(result.complete, true, result.line)
  assert.equal(result.signin, false)
  assert.equal(busy, 40)
  assert.equal(w.sleeps.filter(ms => ms === 1000).length, 40)
  assert.ok(lines.includes('Her edge is busy. Waiting.'))
})

// ── The memory source and the local pack ────────────────────────────────────────────────────────────────────────────

test('the memory source over the worker file system gives the same row hashes as the IndexedDB source', async () => {
  const entries = storeEntries()
  const fs = fakeFsFromEntries(entries)
  const before = JSON.stringify(Array.from(fs.nodes, ([key, value]) => [key, value.bytes ? Array.from(value.bytes) : value.mode]))
  const memory = rescueKit({ source: 'memory', fs, indexedDB: null, localStorage: null, piece: PIECE })
  const idb = new FakeIndexedDb()
  idb.seed(DB, entries)
  const stored = rescueKit({ indexedDB: idb, localStorage: null, piece: PIECE })
  const [a, b] = [(await memory.readIndex()).index, (await stored.readIndex()).index]
  const files = index => Object.fromEntries(index.rows.filter(row => row.type === 'file').map(row => [row.key, [row.bytes, row.sha256, row.pieces]]))
  assert.deepEqual(files(a), files(b))
  assert.equal(Object.keys(files(a)).length, 4)
  assert.deepEqual(a.rows.filter(row => row.type === 'dir').map(row => row.key), b.rows.filter(row => row.type === 'dir').map(row => row.key))
  assert.equal(a.source, 'memory')
  assert.deepEqual(a.client, { clientId: null, base: null, reconciliation: null })
  assert.deepEqual(a.totals, { ...b.totals, bytes: a.totals.bytes })
  assert.equal(JSON.stringify(Array.from(fs.nodes, ([key, value]) => [key, value.bytes ? Array.from(value.bytes) : value.mode])), before, 'nothing in it changed')
  // It copies to the cloud the same way.
  const vault = createFakeVault({ piece: PIECE })
  const copied = await rescueKit({ source: 'memory', fs, indexedDB: null, localStorage: null, piece: PIECE, fetch: vault.fetch, sleep: async () => {} }).copyToCloud()
  assert.equal(copied.complete, true, copied.line)
})

test('the local pack round-trips through server/rescue-verify.mjs; one flipped byte exits 1', async () => {
  // The verifier refuses any piece size but the protocol's, so this pack is cut at 2,097,152 like a real one.
  const w = world({ settings: [['aukora.theme', 'dark']], piece: 2097152 })
  const result = await w.kit().saveLocal()
  assert.equal(result.ok, true)
  assert.equal(result.complete, true)
  assert.match(result.line, new RegExp(`^Saved a copy on this computer: 2 threads, 2 home files, 0 MB; main thread: ${MAIN_BYTES} bytes, saved \\d\\d:\\d\\d; newest save of any thread: \\d\\d:\\d\\d\\.$`))
  assert.match(result.fileName, /^aukora-rescue-[0-9a-f]{32}\.x61pack$/)
  assert.ok(result.lines.includes('No Auma Live chat logs were found. Other saved settings stay in this browser.'))
  assert.equal(result.lines.at(-1), 'Check it on a computer: node server/rescue-verify.mjs ' + result.fileName + ' --expect-id ' + result.id)
  assert.equal(w.vault.log.length, 0, 'no byte leaves the computer')
  assert.equal(w.idb.writableTransactions().length, 0)
  assert.equal(w.ls.writes.length, 0)
  const bytes = new Uint8Array(await result.blob.arrayBuffer())
  assert.equal(new TextDecoder().decode(bytes.subarray(0, 11)), 'X61RESCUE1\n')
  assert.equal(new TextDecoder().decode(bytes.subarray(bytes.length - 11)), 'X61RESCUE1\n')
  const dir = mkdtempSync(join(tmpdir(), 'rescue-pack-'))
  try {
    const file = join(dir, result.fileName)
    writeFileSync(file, bytes)
    const ok = spawnSync(process.execPath, [join(ROOT, 'server/rescue-verify.mjs'), file], { encoding: 'utf8' })
    assert.equal(ok.status, 0, ok.stdout + ok.stderr)
    assert.match(ok.stdout, /mismatches: 0/)
    assert.ok(ok.stdout.includes('id: ' + result.id + ' (file name: equal; --expect-id: not given)'), ok.stdout)
    assert.ok(ok.stdout.includes(`main thread: agent/main: ${MAIN_BYTES} bytes, saved ${hhmm(T_NEWEST)}`), ok.stdout)
    assert.ok(ok.stdout.includes(`newest save of any thread: ${hhmm(T_NEWEST)} (`), ok.stdout)
    assert.match(ok.stdout, /threads: 2, home files: 2/)
    assert.match(ok.stdout, /saved settings: not copied/)
    assert.match(ok.stdout, /completeness: complete/)
    assert.ok(!ok.stdout.includes('hello'), 'never contents')
    assert.ok(!ok.stdout.includes(MAIN), 'the main thread is named by its folder only')
    // Flip one byte inside the notes row.
    const length = Number(new DataView(bytes.buffer, bytes.length - 19, 8).getBigUint64(0))
    const index = JSON.parse(new TextDecoder().decode(bytes.subarray(bytes.length - 19 - length, bytes.length - 19)))
    const notes = index.rows.find(row => row.key === NOTES)
    const bad = bytes.slice()
    bad[notes.offset + 70] ^= 0x20
    writeFileSync(file, bad)
    const failed = spawnSync(process.execPath, [join(ROOT, 'server/rescue-verify.mjs'), file], { encoding: 'utf8' })
    assert.equal(failed.status, 1, failed.stdout + failed.stderr)
    assert.ok(failed.stdout.includes('mismatch: ' + NOTES + ' (piece 0 SHA-256)'), failed.stdout)
    assert.match(failed.stdout, /mismatches: 1/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// ── MUST 4: the page ────────────────────────────────────────────────────────────────────────────────────────────────

const workerStyle = () => {
  const text = readFileSync(new URL('../worker.mjs', import.meta.url), 'utf8')
  const start = text.indexOf('const OWNER_SIGNIN_STYLE = `') + 'const OWNER_SIGNIN_STYLE = `'.length
  return text.slice(start, text.indexOf('`', start))
}

test('the page: headers, CSP hashes, the committed script, the Spatial palette by value, no way to "/", no forbidden word', async () => {
  const page = await rescuePageResponse()
  assert.equal(page.status, 200)
  assert.equal(page.headers.get('content-type'), 'text/html; charset=utf-8')
  assert.equal(page.headers.get('cache-control'), 'no-store')
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(page.headers.get('referrer-policy'), 'no-referrer')
  const csp = page.headers.get('content-security-policy')
  const b64 = text => 'sha256-' + createHash('sha256').update(text).digest('base64')
  assert.equal(csp, `default-src 'none'; base-uri 'none'; object-src 'none'; script-src '${b64(RESCUE_PAGE.script)}'; style-src '${b64(RESCUE_PAGE.style)}'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'`)
  const html = await page.text()
  assert.equal(html, RESCUE_PAGE.html)
  assert.ok(html.includes('<script>' + RESCUE_PAGE.script + '</script>'))
  assert.ok(html.includes('<style>' + RESCUE_PAGE.style + '</style>'))
  assert.match(html, /<title>Rescue copy<\/title>/)
  assert.match(html, /<h1>A second copy of this browser<\/h1>/)
  // job 2: before anything is pressed, the intro says what each way out holds (her private folder: local pack only).
  assert.ok(html.includes('<p>This page copies what this browser holds of hers: every thread, her home files, her storage’s own records and her Auma Live chat logs. '
    + 'Other saved settings stay in this browser. The copy saved on this computer holds every home file; the copy in her cloud holds every home file '
    + 'except her private folder, which stays in this browser and is said by its size only. Secret files ('), 'the intro')
  assert.ok(!html.includes('every thread, every home file'), 'the old intro is gone')
  assert.match(html, /<button id="rescue-cloud" type="button" disabled>Copy to her cloud<\/button>/)
  assert.match(html, /<button id="rescue-local" type="button" disabled>Save a copy on this computer<\/button>/)
  assert.match(html, /id="rescue-status" role="status"/)
  assert.match(html, /<h2 id="rescue-left-heading">Left in this browser only<\/h2>/)
  // The committed generated module is exactly what the generator makes from today's sources.
  assert.equal(RESCUE_PAGE.script, composeRescuePageScript())
  assert.equal(readFileSync(new URL('../rescue-page.script.mjs', import.meta.url), 'utf8'), rescuePageScriptModule())
  // The Spatial palette by value: every colour here is one of the sign-in page's, and the font stack is the same line.
  const theirs = workerStyle()
  const colours = text => new Set(text.match(/rgba?\([^)]*\)/g))
  for (const colour of colours(RESCUE_PAGE.style)) assert.ok(colours(theirs).has(colour), colour)
  for (const token of ['rgb(11, 13, 24)', 'rgb(232, 234, 237)', 'rgb(150, 180, 255)', 'rgb(184, 188, 196)', 'rgba(255, 255, 255, 0.043)']) assert.ok(RESCUE_PAGE.style.includes(token), token)
  const font = theirs.match(/font: 100%\/1\.5 [^;]+;/)[0]
  assert.ok(RESCUE_PAGE.style.includes(font))
  assert.doesNotMatch(RESCUE_PAGE.style, /url\(|@import|@font-face/)
  // Nothing goes to '/': the only place it ever loads is /rescue; the one href it sets is the pack's own object URL.
  const script = RESCUE_PAGE.script
  assert.deepEqual(script.match(/\blocation\b[^)]*\)/g), ["location.assign('/rescue')"])
  assert.deepEqual([...script.matchAll(/\.href\s*=\s*([^\n;]+)/g)].map(match => match[1].trim()), ['url'])
  assert.doesNotMatch(script, /window\.open|\.replace\(\s*['"`]\/['"`]\s*\)|https?:\/\//)
  assert.doesNotMatch(html.replace(RESCUE_PAGE.script, ''), /href=/)
  assert.doesNotMatch(script, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/)
  // The word spelled t-o-k-e-n appears nowhere in either page.
  assert.doesNotMatch(html, /t[o]ken/i)
  assert.doesNotMatch(RESCUE_PAGE.busyHtml, /t[o]ken/i)
})

test('the busy page: 503, retry in a second, one link to /rescue, no script', async () => {
  const busy = await rescueBusyResponse()
  assert.equal(busy.status, 503)
  assert.equal(busy.headers.get('retry-after'), '1')
  assert.equal(busy.headers.get('cache-control'), 'no-store')
  const html = await busy.text()
  assert.match(html, /Her edge is busy\. Try again\./)
  assert.deepEqual(html.match(/href="[^"]*"/g), ['href="/rescue"'])
  assert.doesNotMatch(html, /<script/)
  assert.match(busy.headers.get('content-security-policy'), /script-src 'none'/)
  assert.ok(busy.headers.get('content-security-policy').includes("style-src 'sha256-" + createHash('sha256').update(RESCUE_PAGE.style).digest('base64') + "'"))
})

test('wantsRescueDocument: only a GET /rescue document navigation', () => {
  const ask = (path, headers = {}, method = 'GET') => {
    const url = new URL(path, 'https://edge.test')
    return wantsRescueDocument(new Request(url, { method, headers }), url)
  }
  assert.equal(ask('/rescue', { accept: 'text/html', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' }), true)
  assert.equal(ask('/rescue', { accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' }), true)
  assert.equal(ask('/rescue', { accept: 'text/html', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' }), false, 'a fetch')
  assert.equal(ask('/rescue', { accept: '*/*' }), false)
  assert.equal(ask('/rescue', { accept: 'text/html, text/html' }), false)
  assert.equal(ask('/rescue', { accept: 'text/html;q=0' }), false)
  assert.equal(ask('/', { accept: 'text/html', 'sec-fetch-mode': 'navigate' }), false)
  assert.equal(ask('/rescue/', { accept: 'text/html' }), false)
  assert.equal(ask('/rescue', { accept: 'text/html' }, 'POST'), false)
})

test('the kit runs in a context with no page and no outer names; the page script wires every control', async () => {
  const kitText = rescueKit.toString()
  assert.doesNotMatch(kitText, /\b(?:document|window|deleteDatabase|setItem|removeItem|sessionStorage|BroadcastChannel|locks|serviceWorker)\b/)
  assert.doesNotMatch(kitText, /\bimport\s*\(|\brequire\s*\(/)
  assert.doesNotMatch(kitText, /'readwrite'|getAll\(|openCursor/)
  // A full copy inside a bare context (a worker console has the same globals).
  const w = world()
  const kitInVm = runInNewContext(`(${kitText})`, { crypto, TextEncoder, TextDecoder, setTimeout, Blob, URL })({
    indexedDB: w.idb, localStorage: w.ls, fetch: w.vault.fetch, piece: PIECE, sleep: async () => {} })
  assert.equal((await kitInVm.copyToCloud()).complete, true)
  const memoryInVm = runInNewContext(composeMemoryConsoleScript(), { crypto, TextEncoder, TextDecoder, setTimeout, Blob, URL: { createObjectURL: () => 'blob:x' },
    console: { log() {} }, __X6_SERVICES__: { fs: fakeFsFromEntries(storeEntries()) } })
  const packed = await memoryInVm
  assert.equal(packed.ok, true)
  assert.match(packed.line, /^Saved a copy on this computer: 2 threads/)
  // The page script, run as a browser would, with the fakes standing in for her storage and her cloud.
  const run = async ({ fail401 = false, button = 'rescue-cloud' } = {}) => {
    // The page runs the kit with no options, so at the protocol piece size.
    const v = world({ extra: [['/dsh/home/.credentials.yaml.3fa9c1.tmp', goneEntry()]], piece: 2097152 })
    if (fail401) v.vault.hook = () => new Response('{}', { status: 401 })
    const elements = new Map()
    const element = id => ({ id, hidden: false, disabled: false, textContent: '', children: [], listeners: {}, href: '', download: '',
      get firstChild() { return this.children[0] ?? null }, addEventListener(type, listener) { this.listeners[type] = listener },
      appendChild(child) { this.children.push(child) }, removeChild(child) { this.children.splice(this.children.indexOf(child), 1) },
      click() { this.clicked = true }, remove() {} })
    for (const id of ['rescue-cloud', 'rescue-local', 'rescue-status', 'rescue-detail', 'rescue-left', 'rescue-left-list', 'rescue-signin',
    'rescue-join', 'rescue-state', 'rescue-threads']) elements.set(id, element(id))
    elements.get('rescue-left').hidden = true; elements.get('rescue-signin').hidden = true
    const created = []
    const assigned = []
    const body = element('body')
    runInNewContext(RESCUE_PAGE.script, {
      document: { getElementById: id => elements.get(id), createElement: tag => { const made = element(tag); created.push(made); return made }, body },
      // The page's one long timer (revoking the download's object URL) must not hold this test process open.
      location: { assign: target => assigned.push(target) }, crypto, TextEncoder, TextDecoder, Blob,
      setTimeout: (fn, ms) => { const timer = setTimeout(fn, ms); if (ms > 1000) timer.unref(); return timer },
      URL: { createObjectURL: () => 'blob:rescue', revokeObjectURL() {} },
      fetch: v.vault.fetch, indexedDB: v.idb, localStorage: v.ls,
    })
    for (const id of ['rescue-cloud', 'rescue-local', 'rescue-signin']) assert.equal(typeof elements.get(id).listeners.click, 'function', id)
    assert.equal(elements.get('rescue-cloud').disabled, false)
    elements.get(button).listeners.click()
    await waitFor(() => !elements.get('rescue-cloud').disabled, 'the run to end (rescue-cloud enabled again)')
    return { v, elements, created, assigned }
  }
  const cloud = await run()
  assert.match(cloud.elements.get('rescue-status').textContent, /^Rescue copy complete and checked: 2 threads, 2 home files/)
  assert.equal(cloud.elements.get('rescue-left').hidden, false)
  assert.deepEqual(cloud.elements.get('rescue-left-list').children.map(child => child.textContent), ['file or folder named .credentials.yaml plus an ending: 1'])
  assert.equal(cloud.elements.get('rescue-signin').hidden, true)
  const local = await run({ button: 'rescue-local' })
  const anchor = local.created.find(made => made.download)
  assert.ok(anchor && anchor.clicked, 'one download')
  assert.equal(anchor.href, 'blob:rescue')
  assert.match(local.elements.get('rescue-status').textContent, /^Saved a copy on this computer/)
  const signedOut = await run({ fail401: true })
  assert.equal(signedOut.elements.get('rescue-status').textContent, 'Your sign-in ended. Sign in again on this page, then press the button again.')
  assert.equal(signedOut.elements.get('rescue-signin').hidden, false)
  signedOut.elements.get('rescue-signin').listeners.click()
  assert.deepEqual(signedOut.assigned, ['/rescue'])
  // The console helper for a plain page is the kit plus the download, and nothing that writes.
  const consoleScript = composeLocalConsoleScript()
  assert.ok(consoleScript.includes(rescueKit.toString()))
  assert.match(consoleScript, /kit\.saveLocal\(/)
  assert.doesNotMatch(consoleScript, /location|copyToCloud\(\{/)
})
