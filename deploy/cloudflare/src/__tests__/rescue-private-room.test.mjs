/**
 * A NEW copy to her cloud leaves her private room at origin. Her private folder
 * (`/dsh/home/auma/private` and everything under it) is not read into the copy, not hashed into its index and not named
 * anywhere in it; the index says only how many files and bytes stayed (`leftAtOrigin: {private: {files, bytes}}`, in
 * every new cloud copy, zeros when there is none). The checkpoint signer stays behind too. The local pack on this computer
 * still holds her private room; it leaves the checkpoint signer behind, as it leaves the key pair. The REAL kit over the
 * suite's fakes, against the REAL vault. Made-up bytes only.
 * job 2: a secret-shaped row INSIDE the room is judged by its key first (never read, listed by kind, not counted);
 * and the room line is said on every end of a Copy run that got as far as reading this browser.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { runInNewContext } from 'node:vm'
import { rescueKit } from '../rescue-kit.mjs'
import { RESCUE_PAGE } from '../rescue-page.mjs'
import { FakeIndexedDb, FakeLocalStorage, dirEntry, fakeFsFromEntries, fileEntry } from './rescue-fakes.mjs'
import { createVaultBucket, createVaultBudget, createVaultFetch } from './vault-fakes.mjs'
import { waitFor } from './wait-for.mjs'

const DB = 'aukora-x6-vfs'
const WORLD = 'node-main-v1'
const CLIENT = '1b4e28ba-2fa1-41d2-883f-0016d3cca427'
const enc = new TextEncoder()
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const T = Date.UTC(2026, 10, 13, 2, 0, 0)
const PRIVATE = '/dsh/home/auma/private'
const DIARY = PRIVATE + '/diary-qz7.md', INNER_DIR = PRIVATE + '/inner-kx2', INNER = INNER_DIR + '/letter-wv5.txt'
const DIARY_TEXT = 'made-up private words alpha-91\n', INNER_TEXT = 'made-up private words beta-37, a little longer\n'
const NOTES = '/dsh/home/auma/notes.md', NOTES_TEXT = 'an ordinary made-up note\n'
const ROOM_BYTES = enc.encode(DIARY_TEXT).length + enc.encode(INNER_TEXT).length
const SIGNER = '/dsh/home/auma/seed/checkpoint-signer.v1.json', SIGNER_TEXT = '{"made":"up signer, not a key, mark-sg8"}'
/** Everything of the room that must never be found in what she sent: its folder, its names, its bytes and their hashes. */
const ROOM_MARKS = [PRIVATE, 'diary-qz7', 'inner-kx2', 'letter-wv5', 'alpha-91', 'beta-37', sha(enc.encode(DIARY_TEXT)), sha(enc.encode(INNER_TEXT))]
/** The local pack id the kit at an earlier commit gave for `privateEntries()` (computed with the earlier kit before any edit). */
const LOCAL_PACK_ID_EARLIER = '1632d4413fa45f89b44556ea81f748fa'

/** Her store with two private files (one in an inner folder) beside one ordinary file, and her bookkeeping. */
const privateEntries = () => [['/dsh/home', dirEntry()], ['/dsh/home/auma', dirEntry()], [PRIVATE, dirEntry(0o700)], [INNER_DIR, dirEntry(0o700)],
  [DIARY, fileEntry(DIARY_TEXT, T, 0o600)], [INNER, fileEntry(INNER_TEXT, T + 1000, 0o600)],
  [NOTES, fileEntry(NOTES_TEXT, T + 2000)],
  ['@x6-mirror-meta', { clientId: CLIENT, cloudBase: { lineageId: 'L1', revision: 7 } }], ['@x6-content-revision', { kind: 'content-revision', seq: 3 }]]

/** The real vault over an in-memory bucket; every request the kit sent is logged. */
function cloudOf(entries, { source = 'indexeddb', fs = null, hook = null } = {}) {
  const bucket = createVaultBucket()
  const vaultFetch = createVaultFetch({ bucket, budget: createVaultBudget({ now: () => T }), world: WORLD, now: () => T })
  const sent = []
  const fetch = async (path, init = {}) => {
    sent.push({ method: String(init.method ?? 'GET'), path: String(path), body: init.body ?? null })
    // `hook` (job 2): an answer of its own instead of the vault's, for a run that must end early.
    const own = hook ? await hook({ method: String(init.method ?? 'GET'), path: String(path) }) : undefined
    return own || vaultFetch(path, init)
  }
  const idb = new FakeIndexedDb()
  idb.seed(DB, entries)
  const kit = () => (source === 'memory'
    ? rescueKit({ source: 'memory', fs, indexedDB: null, localStorage: null, fetch, now: () => T, sleep: async () => {} })
    : rescueKit({ indexedDB: idb, localStorage: null, fetch, now: () => T, sleep: async () => {} }))
  const stored = id => bucket.objects.get(`w/${WORLD}/rescue/${id}/pending.json`)
  return { bucket, idb, sent, kit, stored, fetch }
}
/** Every byte that reached her cloud: object keys and bodies, and every request's path and body. */
const everythingSent = c => {
  const parts = []
  for (const [key, entry] of c.bucket.objects) { parts.push(Buffer.from(key)); parts.push(Buffer.from(entry.bytes)) }
  for (const call of c.sent) {
    parts.push(Buffer.from(call.path))
    if (typeof call.body === 'string') parts.push(Buffer.from(call.body))
    else if (call.body) parts.push(Buffer.from(call.body.buffer ? new Uint8Array(call.body.buffer, call.body.byteOffset, call.body.byteLength) : call.body))
  }
  return Buffer.concat(parts)
}
/** The page (the committed generated script, run as a browser would) over `c`: press "Copy to her cloud", wait for the end. */
async function pageCopy(c) {
  const elements = new Map()
  const element = id => ({ id, hidden: false, disabled: false, textContent: '', children: [], listeners: {},
    get firstChild() { return this.children[0] ?? null }, addEventListener(type, listener) { this.listeners[type] = listener },
    appendChild(child) { this.children.push(child) }, removeChild(child) { this.children.splice(this.children.indexOf(child), 1) }, remove() {} })
  for (const id of ['rescue-cloud', 'rescue-local', 'rescue-status', 'rescue-detail', 'rescue-left', 'rescue-left-list', 'rescue-signin',
    'rescue-join', 'rescue-state', 'rescue-threads']) elements.set(id, element(id))
  elements.get('rescue-left').hidden = true; elements.get('rescue-signin').hidden = true
  runInNewContext(RESCUE_PAGE.script, {
    document: { getElementById: id => elements.get(id), createElement: tag => element(tag), body: element('body') },
    location: { assign() {} }, crypto, TextEncoder, TextDecoder, Blob,
    setTimeout: (fn, ms) => { const timer = setTimeout(fn, ms); if (ms > 1000) timer.unref(); return timer },
    URL: { createObjectURL: () => 'blob:rescue', revokeObjectURL() {} },
    fetch: c.fetch, indexedDB: c.idb, localStorage: new FakeLocalStorage([]),
  })
  elements.get('rescue-cloud').listeners.click()
  await waitFor(() => !elements.get('rescue-cloud').disabled, 'the run to end (rescue-cloud enabled again)')
  return elements
}
/** The index of a local pack Blob. */
const packIndex = async blob => {
  const buffer = Buffer.from(await blob.arrayBuffer())
  const length = Number(buffer.readBigUInt64BE(buffer.length - 19))
  return JSON.parse(buffer.subarray(buffer.length - 19 - length, buffer.length - 19).toString('utf8'))
}

test('a NEW cloud copy leaves her private room at origin: one file row, the field {files: 2, bytes}, no private path, name, hash or byte in anything sent', async () => {
  const c = cloudOf(privateEntries())
  const result = await c.kit().copyToCloud()
  assert.equal(result.complete, true, result.line + ' | ' + result.lines.join(' | '))
  assert.equal(result.line, 'Rescue copy complete and checked: 0 threads, 1 home files, 0 MB; main thread: none; newest save of any thread: never; checked '
    + String(new Date(T).getHours()).padStart(2, '0') + ':' + String(new Date(T).getMinutes()).padStart(2, '0'))
  const stored = c.stored(result.id)
  assert.ok(stored, 'the index is in her cloud under the id the kit computed')
  assert.equal(sha(stored.bytes).slice(0, 32), result.id)
  const text = Buffer.from(stored.bytes).toString('utf8')
  const index = JSON.parse(text)
  // Exactly one file row (the ordinary note); the room's folders and files are not rows.
  assert.deepEqual(index.rows.filter(row => row.type === 'file').map(row => row.key), [NOTES])
  assert.deepEqual(index.rows.map(row => row.key), ['/dsh/home', '/dsh/home/auma', NOTES, '@x6-content-revision', '@x6-mirror-meta'])
  // The one new field: existence and size only.
  assert.deepEqual(index.leftAtOrigin, { private: { files: 2, bytes: ROOM_BYTES } })
  assert.deepEqual(result.leftAtOrigin, index.leftAtOrigin)
  assert.equal(index.totals.homeFiles, 1)
  assert.equal(index.totals.bytes, index.rows.reduce((sum, row) => sum + row.bytes, 0))
  // Nothing of the room anywhere: the index bytes, every stored object and key, every request's path and body.
  const all = everythingSent(c)
  for (const mark of ROOM_MARKS) {
    assert.ok(!text.includes(mark), mark + ' is in the index')
    assert.ok(!all.includes(mark), mark + ' reached her cloud')
  }
  // Her cloud's own record of the copy counts the ordinary file only.
  const manifest = JSON.parse(Buffer.from(c.bucket.objects.get(`w/${WORLD}/rescue/${result.id}/manifest.json`).bytes).toString('utf8'))
  assert.equal(manifest.files, 1)
  // The page's lines say it, by count and size only, and never name a path in the room.
  assert.ok(result.lines.includes(`private: not carried — 2 files, ${ROOM_BYTES} bytes, left at origin.`), result.lines.join(' | '))
  assert.ok(!JSON.stringify(result).includes(PRIVATE), JSON.stringify(result))
  // The room was read in this browser's memory only, to count it (IndexedDB holds no size beside the bytes).
  assert.deepEqual(result.skipped, [])
})

test('the memory source counts the room by its sizes alone: no private file is ever read, and the copy says the same', async () => {
  const fs = fakeFsFromEntries(privateEntries())
  const read = []
  const reading = Object.assign({}, fs, { readFileSync: path => { read.push(String(path)); return fs.readFileSync(path) } })
  const c = cloudOf([], { source: 'memory', fs: reading })
  const result = await c.kit().copyToCloud()
  assert.equal(result.complete, true, result.line + ' | ' + result.lines.join(' | '))
  assert.ok(read.length > 0, 'ordinary files are read')
  assert.deepEqual(read.filter(path => path === PRIVATE || path.startsWith(PRIVATE + '/')), [], 'no file in her private folder is read')
  const index = JSON.parse(Buffer.from(c.stored(result.id).bytes).toString('utf8'))
  assert.deepEqual(index.leftAtOrigin, { private: { files: 2, bytes: ROOM_BYTES } })
  assert.deepEqual(index.rows.filter(row => row.type === 'file').map(row => row.key), [NOTES])
  const all = everythingSent(c)
  for (const mark of ROOM_MARKS) assert.ok(!all.includes(mark), mark + ' reached her cloud')
})

test('the local pack still holds her private room (it leaves the checkpoint signer behind, as it leaves the key pair): all three files and the room, no new field, and the id the earlier kit gave', async () => {
  const idb = new FakeIndexedDb()
  idb.seed(DB, privateEntries())
  const pack = await rescueKit({ indexedDB: idb, localStorage: null }).saveLocal()
  assert.equal(pack.complete, true, pack.line)
  assert.equal(pack.id, LOCAL_PACK_ID_EARLIER)
  const index = await packIndex(pack.blob)
  assert.deepEqual(index.rows.filter(row => row.type === 'file').map(row => row.key).sort(), [DIARY, INNER, NOTES].sort())
  assert.ok(index.rows.some(row => row.key === PRIVATE && row.type === 'dir'), 'the room folder is a row')
  assert.equal('leftAtOrigin' in index, false)
  const bytes = Buffer.from(await pack.blob.arrayBuffer())
  assert.ok(bytes.includes(DIARY_TEXT) && bytes.includes(INNER_TEXT), 'the room travels in the pack on this computer')
  assert.ok(!pack.lines.some(line => line.startsWith('private: ')), 'the pack says nothing was left behind: nothing was')
})

test('no private folder: the field is present and says zero; the page says nothing about a room', async () => {
  const c = cloudOf(privateEntries().filter(([key]) => key !== PRIVATE && !key.startsWith(PRIVATE + '/')))
  const result = await c.kit().copyToCloud()
  assert.equal(result.complete, true, result.line)
  const index = JSON.parse(Buffer.from(c.stored(result.id).bytes).toString('utf8'))
  assert.deepEqual(index.leftAtOrigin, { private: { files: 0, bytes: 0 } })
  assert.ok(!result.lines.some(line => line.startsWith('private: ')), result.lines.join(' | '))
  // An empty room folder: still zero files, and still not a row.
  const empty = cloudOf([...privateEntries().filter(([key]) => !key.startsWith(PRIVATE + '/')), [PRIVATE + '-ish', dirEntry()], [PRIVATE + '-ish/kept.md', fileEntry('kept')]])
  const second = await empty.kit().copyToCloud()
  assert.equal(second.complete, true, second.line)
  const sent = JSON.parse(Buffer.from(empty.stored(second.id).bytes).toString('utf8'))
  assert.deepEqual(sent.leftAtOrigin, { private: { files: 0, bytes: 0 } })
  assert.ok(!sent.rows.some(row => row.key === PRIVATE), 'the empty room folder is not a row')
  assert.ok(sent.rows.some(row => row.key === PRIVATE + '-ish/kept.md'), 'a neighbour whose name only starts the same travels')
})

test('bookkeeping that names her private folder (a reset, a waiting save, a queued save of a private file) stays in this browser in the cloud copy; the local pack keeps it', async () => {
  const batch = { kind: 'mirror-batch', digest: 'd', batch: { clientId: CLIENT, seq: 1, id: 'b1',
    entries: [[DIARY, { kind: 'file', b64: Buffer.from(DIARY_TEXT).toString('base64'), mode: 384, mtimeMs: T }], [NOTES, { kind: 'file', b64: 'eA==', mode: 420, mtimeMs: T }]] } }
  const extra = [
    ['@x6-vfs-reset:' + PRIVATE, { kind: 'subtree-reset', path: PRIVATE }],
    ['@x6-deferred-journal:' + INNER, { kind: 'deferred-journal', path: INNER, notBefore: 1, failures: 0 }],
    ['@x6-mirror-batch:0000000000000001', batch],
    ['@x6-mirror-batch:0000000000000002', { kind: 'mirror-batch', digest: 'e', batch: { clientId: CLIENT, seq: 2, id: 'b2', entries: [[NOTES, { kind: 'file', b64: 'eQ==', mode: 420, mtimeMs: T }]] } }],
    ['@x6-vfs-reset:/dsh/home/auma', { kind: 'subtree-reset', path: '/dsh/home/auma' }],
  ]
  const c = cloudOf([...privateEntries(), ...extra])
  const result = await c.kit().copyToCloud()
  assert.equal(result.complete, true, result.line + ' | ' + result.lines.join(' | '))
  const text = Buffer.from(c.stored(result.id).bytes).toString('utf8')
  const keys = JSON.parse(text).rows.map(row => row.key)
  assert.ok(keys.includes('@x6-mirror-batch:0000000000000002'), 'an ordinary queued save travels')
  assert.ok(keys.includes('@x6-vfs-reset:/dsh/home/auma'), 'an ordinary reset row travels')
  assert.deepEqual(result.skipped, [{ shape: 'bookkeeping row naming her private folder', count: 3 }])
  const all = everythingSent(c)
  for (const mark of [...ROOM_MARKS, Buffer.from(DIARY_TEXT).toString('base64')]) {
    assert.ok(!text.includes(mark), mark + ' is in the index')
    assert.ok(!all.includes(mark), mark + ' reached her cloud')
  }
  // The local pack: today's rule, every one of them is in it.
  const idb = new FakeIndexedDb()
  idb.seed(DB, [...privateEntries(), ...extra])
  const pack = await rescueKit({ indexedDB: idb, localStorage: null }).saveLocal()
  assert.equal(pack.complete, true, pack.line)
  const local = (await packIndex(pack.blob)).rows.map(row => row.key)
  for (const [key] of extra) assert.ok(local.includes(key), key + ' is in the local pack')
})

test('a private row that cannot be read is never counted as left behind: the copy is not complete and names it [redacted]', async () => {
  const c = cloudOf([...privateEntries(), [PRIVATE + '/broken-pv3.bin', { kind: 'file', bytes: 'not bytes', mode: 0o600, mtimeMs: 1 }]])
  const result = await c.kit().copyToCloud()
  assert.equal(result.complete, false)
  assert.ok(result.lines.includes('Could not read: /dsh/home/auma/private/[redacted]'), result.lines.join(' | '))
  assert.ok(!JSON.stringify(result).includes('broken-pv3'))
  const index = JSON.parse(Buffer.from(c.stored(result.id).bytes).toString('utf8'))
  assert.deepEqual(index.leftAtOrigin, { private: { files: 2, bytes: ROOM_BYTES } }, 'only what was read is counted')
})

test('the checkpoint signer stays behind: not in the cloud copy (nor the local pack, like her ed25519 key pair), and the page lists it under "Left in this browser only"', async () => {
  const extra = [['/dsh/home/auma/seed', dirEntry()], [SIGNER, fileEntry(SIGNER_TEXT, T, 0o600)], ['/dsh/home/auma/seed/receipts.v3.jsonl', fileEntry('{"made":"up"}\n', T)]]
  const kit = rescueKit({ indexedDB: null, localStorage: null })
  for (const name of ['checkpoint-signer.v1.json', 'checkpoint-signer.v1.json.3fa9c1.tmp', 'checkpoint-signer.v1.json~', '.checkpoint-signer.v1.json']) {
    assert.ok(kit.secretShape('/dsh/home/auma/seed/' + name), name)
  }
  assert.equal(kit.secretShape('/dsh/home/auma/seed/checkpoint-signers.md'), null, 'a name that only starts the same is ordinary')
  const c = cloudOf([...privateEntries(), ...extra])
  const result = await c.kit().copyToCloud()
  assert.equal(result.complete, true, result.line)
  const index = JSON.parse(Buffer.from(c.stored(result.id).bytes).toString('utf8'))
  assert.ok(!index.rows.some(row => row.key.includes('checkpoint-signer')), 'the signer is not a row')
  assert.ok(index.rows.some(row => row.key === '/dsh/home/auma/seed/receipts.v3.jsonl'), 'her other seed files travel')
  assert.deepEqual(result.skipped, [{ shape: 'file or folder named checkpoint-signer.v1.json', count: 1 }])
  assert.deepEqual(index.skipped, result.skipped)
  assert.ok(!everythingSent(c).includes('mark-sg8'), 'the signer bytes never reached her cloud')
  // The local pack leaves it too (SECRET_NAMES is the rule for both ways out, as for the ed25519 key pair).
  const idb = new FakeIndexedDb()
  idb.seed(DB, [...privateEntries(), ...extra])
  const pack = await rescueKit({ indexedDB: idb, localStorage: null }).saveLocal()
  assert.ok(!(await packIndex(pack.blob)).rows.some(row => row.key.includes('checkpoint-signer')))
  assert.ok(!Buffer.from(await pack.blob.arrayBuffer()).includes('mark-sg8'))

  // The page (the committed generated script, run as a browser would): the left-behind list counts it, and the room line shows.
  const elements = await pageCopy(cloudOf([...privateEntries(), ...extra]))
  assert.match(elements.get('rescue-status').textContent, /^Rescue copy complete and checked: 0 threads, 2 home files/)
  assert.equal(elements.get('rescue-left').hidden, false)
  assert.deepEqual(elements.get('rescue-left-list').children.map(child => child.textContent), ['file or folder named checkpoint-signer.v1.json: 1'])
  const detail = elements.get('rescue-detail').children.map(child => child.textContent)
  assert.ok(detail.includes(`private: not carried — 2 files, ${ROOM_BYTES} bytes, left at origin.`), detail.join(' | '))
  assert.ok(!detail.join('\n').includes(PRIVATE))
})

test('the field is exactly {private: {files, bytes}}, in the canonical form, inside the bytes the id is the hash of; a copy made twice is the same copy', async () => {
  const c = cloudOf(privateEntries())
  const kit = c.kit()
  const first = await kit.copyToCloud()
  const read = await kit.readIndex()
  assert.equal(read.id, first.id, 'readIndex gives the very index the copy sent')
  assert.ok(read.text.includes(`"leftAtOrigin":{"private":{"bytes":${ROOM_BYTES},"files":2}}`), read.text)
  assert.equal(kit.canon(JSON.parse(read.text)), read.text)
  assert.equal(kit.indexId(JSON.parse(read.text)), first.id)
  assert.deepEqual(Object.keys(read.index.leftAtOrigin), ['private'])
  assert.deepEqual(Object.keys(read.index.leftAtOrigin.private).sort(), ['bytes', 'files'])
  const again = await c.kit().copyToCloud()
  assert.equal(again.id, first.id)
})

// ── job 2 ──────────────────────────────────────────────────────────────────────────────────────────────────────

const KEYPAIR = PRIVATE + '/ed25519-keypair.json', SSH_DIR = PRIVATE + '/.ssh', SSH_ID = SSH_DIR + '/id'
const ROOM_LINE = `private: not carried — 2 files, ${ROOM_BYTES} bytes, left at origin.`

test('a secret-shaped row inside her private room is judged by its key first: never read, listed by kind under "Left in this browser only", not counted', async () => {
  const secrets = [[KEYPAIR, fileEntry('made-up pair mark-kp4', T, 0o600)], [SSH_DIR, dirEntry(0o700)], [SSH_ID, fileEntry('made-up id mark-id6', T, 0o600)]]
  const c = cloudOf([...privateEntries(), ...secrets])
  const result = await c.kit().copyToCloud()
  assert.equal(result.complete, true, result.line + ' | ' + result.lines.join(' | '))
  // Not one request for them, in the first read or the second.
  const asked = c.idb.log.requests.filter(request => request.method === 'get').map(request => request.key)
  for (const [key] of secrets) assert.ok(!asked.includes(key), key + ' was read')
  assert.ok(asked.includes(DIARY) && asked.includes(INNER), 'her ordinary private files are still read in memory to count them')
  // Listed by kind, as every secret-shaped row is; the count is of the room's ordinary files only.
  assert.deepEqual(result.skipped, [{ shape: 'file or folder named .ssh', count: 2 }, { shape: 'file or folder named ed25519-keypair.json', count: 1 }])
  const index = JSON.parse(Buffer.from(c.stored(result.id).bytes).toString('utf8'))
  assert.deepEqual(index.leftAtOrigin, { private: { files: 2, bytes: ROOM_BYTES } })
  assert.deepEqual(index.skipped, result.skipped)
  assert.ok(result.lines.includes(ROOM_LINE), result.lines.join(' | '))
  const all = everythingSent(c)
  for (const mark of [...ROOM_MARKS, 'mark-kp4', 'mark-id6']) assert.ok(!all.includes(mark), mark + ' reached her cloud')
  // The memory source: none of them is read either, and the count is the same.
  const fs = fakeFsFromEntries([...privateEntries(), ...secrets])
  const read = []
  const reading = Object.assign({}, fs, { readFileSync: path => { read.push(String(path)); return fs.readFileSync(path) } })
  const m = cloudOf([], { source: 'memory', fs: reading })
  const fromMemory = await m.kit().copyToCloud()
  assert.equal(fromMemory.complete, true, fromMemory.line)
  assert.deepEqual(read.filter(path => path.startsWith(PRIVATE)), [])
  assert.deepEqual(fromMemory.leftAtOrigin, { private: { files: 2, bytes: ROOM_BYTES } })
})

test('the room line on a complete end, with the left-behind list and the line on the page', async () => {
  const c = cloudOf(privateEntries())
  const result = await c.kit().copyToCloud()
  assert.equal(result.complete, true)
  assert.deepEqual(result.lines.filter(line => line.startsWith('private: ')), [ROOM_LINE])
  const elements = await pageCopy(cloudOf(privateEntries()))
  assert.match(elements.get('rescue-status').textContent, /^Rescue copy complete and checked/)
  assert.ok(elements.get('rescue-detail').children.map(child => child.textContent).includes(ROOM_LINE))
})

test('the room line on a "This copy is not complete" end: a row that changed before its pieces were sent', async () => {
  const c = cloudOf(privateEntries())
  let seen = 0
  c.idb.hooks.beforeRequest = (method, key, count, db) => {
    if (method === 'get' && key === NOTES && ++seen === 2) db.stores.get('entries').get(NOTES).bytes[0] ^= 1
  }
  const result = await c.kit().copyToCloud()
  assert.equal(result.complete, false)
  assert.equal(result.line, 'This copy is not complete.')
  assert.deepEqual(result.lines, ['1 rows changed while this copy was being made. Run again.', 'Changed: ' + NOTES, ROOM_LINE])
  // The index sent back differs: the other early "not complete" end says it too.
  const back = cloudOf(privateEntries(), { hook: ({ method, path }) => {
    if (method === 'GET' && /^\/_vault\/rescue\/[0-9a-f]{32}$/.test(path)) return new Response('{"v":1}', { status: 200 })
  } })
  const differs = await back.kit().copyToCloud()
  assert.equal(differs.line, 'This copy is not complete.')
  assert.deepEqual(differs.lines, ['Her cloud holds a different list for this copy than the one sent. Report this.', ROOM_LINE])
})

test('the room line on a halted end: her sign-in ended, her edge stayed busy; and on the page', async () => {
  const signedOut = ({ path }) => (path.startsWith('/_vault/') ? new Response('{"ok":false,"code":"OWNER_ACCESS_REQUIRED"}', { status: 401 }) : undefined)
  const ended = await cloudOf(privateEntries(), { hook: signedOut }).kit().copyToCloud()
  assert.equal(ended.line, 'Your sign-in ended. Sign in again on this page, then press the button again.')
  assert.equal(ended.signin, true)
  assert.deepEqual(ended.lines, [ROOM_LINE])
  const busy = ({ path }) => (path.startsWith('/_vault/')
    ? new Response('{"ok":false,"code":"OWNER_SESSION_UNAVAILABLE"}', { status: 503, headers: { 'retry-after': '1' } }) : undefined)
  const stayed = await cloudOf(privateEntries(), { hook: busy }).kit().copyToCloud()
  assert.equal(stayed.line, 'Her edge stayed busy. Press the button again in a minute.')
  assert.deepEqual(stayed.lines, [ROOM_LINE])
  // The page shows it under the status, beside "Sign in again".
  const elements = await pageCopy(cloudOf(privateEntries(), { hook: signedOut }))
  assert.equal(elements.get('rescue-status').textContent, 'Your sign-in ended. Sign in again on this page, then press the button again.')
  assert.equal(elements.get('rescue-signin').hidden, false)
  assert.deepEqual(elements.get('rescue-detail').children.map(child => child.textContent), [ROOM_LINE])
})

test('a run that stopped before the room was counted says "private: not carried." without numbers, rather than nothing', async () => {
  const c = cloudOf(privateEntries())
  let fired = false
  c.idb.hooks.beforeRequest = (method, key, count, db) => { if (method === 'get' && !fired) { fired = true; db.fireVersionChange() } }
  const result = await c.kit().copyToCloud()
  assert.equal(result.line, 'This copy is not complete: her app is upgrading its storage here. Run this again.')
  assert.equal(result.leftAtOrigin, null)
  assert.deepEqual(result.lines, ['private: not carried.'])
  // A store with no private folder at all, stopped as early: the same plain line (nothing private was carried either way).
  const none = cloudOf(privateEntries().filter(([key]) => key !== PRIVATE && !key.startsWith(PRIVATE + '/')))
  let once = false
  none.idb.hooks.beforeRequest = (method, key, count, db) => { if (method === 'get' && !once) { once = true; db.fireVersionChange() } }
  assert.deepEqual((await none.kit().copyToCloud()).lines, ['private: not carried.'])
  // Counted and zero: said by nothing, on every end (the room line is only for a room that holds a file).
  const zero = cloudOf(privateEntries().filter(([key]) => key !== PRIVATE && !key.startsWith(PRIVATE + '/')),
    { hook: ({ path }) => (path.startsWith('/_vault/') ? new Response('{}', { status: 401 }) : undefined) })
  assert.deepEqual((await zero.kit().copyToCloud()).lines, [])
})

test('a halt after the last row of her private room was read says the count; a halt on that last row says the plain line', async () => {
  // Rows are read in key order: her bookkeeping (`@x6-...`) comes after every home path, so the room is counted by then.
  const after = cloudOf(privateEntries())
  let fired = false
  after.idb.hooks.beforeRequest = (method, key, count, db) => { if (method === 'get' && key === '@x6-mirror-meta' && !fired) { fired = true; db.fireVersionChange() } }
  const counted = await after.kit().copyToCloud()
  assert.equal(counted.line, 'This copy is not complete: her app is upgrading its storage here. Run this again.')
  assert.deepEqual(counted.leftAtOrigin, { private: { files: 2, bytes: ROOM_BYTES } })
  assert.deepEqual(counted.lines, [ROOM_LINE])
  // Stopped ON the room's last row: that row was never counted, so no number is said.
  const on = cloudOf(privateEntries())
  let once = false
  on.idb.hooks.beforeRequest = (method, key, count, db) => { if (method === 'get' && key === INNER && !once) { once = true; db.fireVersionChange() } }
  const uncounted = await on.kit().copyToCloud()
  assert.equal(uncounted.line, 'This copy is not complete: her app is upgrading its storage here. Run this again.')
  assert.equal(uncounted.leftAtOrigin, null)
  assert.deepEqual(uncounted.lines, ['private: not carried.'])
})

test('a Copy run stopped by an unexpected error (her browser\'s store failed a listing) still says the room line, and the page shows it', async () => {
  /** Her store's listing number `which` fails with a plain error (not an upgrade, not the read deadline). */
  const failing = which => {
    const c = cloudOf(privateEntries())
    c.idb.hooks.beforeRequest = (method, key, count, db) => {
      if (method === 'getAllKeys' && count === which) db.stores.set('entries', { keys() { throw new Error('made-up backing store failure') } })
    }
    return c
  }
  const stopped = which => error => {
    assert.equal(error.name, 'RescueStopped')
    assert.equal(error.message, 'made-up backing store failure')
    assert.deepEqual(error.lines, which === 1 ? ['private: not carried.'] : [ROOM_LINE])
    return true
  }
  // The first listing: nothing was counted yet.
  await assert.rejects(failing(1).kit().copyToCloud(), stopped(1))
  // The second listing (new rows since the copy, after the read-back): the room was counted.
  await assert.rejects(failing(2).kit().copyToCloud(), stopped(2))
  // The page: the stopped line under the status, the room line in the detail box.
  const elements = await pageCopy(failing(1))
  assert.equal(elements.get('rescue-status').textContent,
    'This copy stopped: made-up backing store failure. Nothing in this browser was changed. Press the button again.')
  assert.deepEqual(elements.get('rescue-detail').children.map(child => child.textContent), ['private: not carried.'])
  const later = await pageCopy(failing(2))
  assert.deepEqual(later.get('rescue-detail').children.map(child => child.textContent), [ROOM_LINE])
})
