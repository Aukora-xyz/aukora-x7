/**
 * the outside review's remaining kit items. One rule for leading dots; a
 * deadline on every network step of the cloud copy; saved settings off for the cloud copy too; a stuck or out-voted
 * IndexedDB read is aborted; unexpected errors pass the private-path redaction. The real kit, over the suite fakes.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { rescueKit } from '../rescue-kit.mjs'
import { RESCUE_PAGE } from '../rescue-page.mjs'
import { composeLocalConsoleScript, composeMemoryConsoleScript, composeRescuePageScript } from '../rescue-page.generate.mjs'
import { FakeIndexedDb, FakeLocalStorage, createFakeVault, dirEntry, fileEntry } from './rescue-fakes.mjs'

const DB = 'aukora-x6-vfs'
const MAIN = '/dsh/home/sessions/agent/main/session.v3.jsonl'
const later = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms))
const LIMIT = { timeout: 15000 }
const STALLED = 'This copy is not complete: her cloud stopped answering partway. Press the button again: pieces already there are not sent again.'
const UPGRADING = 'This copy is not complete: her app is upgrading its storage here. Run this again.'
const SLOW_READ = 'This copy is not complete: this browser took more than a minute to read one row. Nothing was changed. Run this again.'
// Auma Live chat logs travel by default; the line says exactly what this run did.
const STAY = 'No Auma Live chat logs were found. Other saved settings stay in this browser.'
const ALL = 'No Auma Live chat logs were found. Other saved settings were copied, except names that look secret.'
const RETRY_WAITS = [500, 1000, 2000, 4000, 8000]

/** A small store: folders and ONE thread, the only row with bytes (one piece), so one piece request at a time. */
const baseEntries = (extra = []) => [
  ['/dsh/home', dirEntry()], ['/dsh/home/sessions', dirEntry()], ['/dsh/home/sessions/agent', dirEntry()], ['/dsh/home/sessions/agent/main', dirEntry()],
  [MAIN, fileEntry('{"role":"user","text":"x"}\n'.repeat(4), 1700000000000)],
  ...extra,
]
function world({ entries = baseEntries(), settings = [], fetch = null, deadlines = {} } = {}) {
  const idb = new FakeIndexedDb()
  idb.seed(DB, entries)
  const ls = new FakeLocalStorage(settings)
  const vault = createFakeVault()
  const sleeps = []
  const kit = (more = {}) => rescueKit({ indexedDB: idb, localStorage: ls, fetch: fetch ? fetch(vault) : vault.fetch,
    deadlines: { headers: 40, upload: 40, idle: 40, total: 400, read: 60000, ...deadlines },
    sleep: async ms => { sleeps.push(ms) }, ...more })
  return { idb, ls, vault, kit, sleeps }
}

// ── MUST 1: one rule for leading dots ──────────────────────────────────────────────────────────────────────────────

// [family, the name after its dots, the fewest leading dots that make it secret-shaped]
const FAMILIES = [
  ['credentials.yaml', 'credentials.yaml', 0], ['session.cap', 'session.cap', 0], ['ed25519-keypair.json', 'ed25519-keypair.json', 0],
  ['pepper.v1', 'pepper.v1', 0], ['credentials', 'credentials', 1], ['ssh', 'ssh', 1], ['aws', 'aws', 1], ['transport', 'transport', 1],
  ['afferent-probe', 'afferent-probe', 1], ['env…', 'env.local', 1], ['env…', 'envrc', 1], ['aukora-…', 'aukora-escrow', 1],
]
const DOTS = [0, 1, 2, 5]
const AFTER = ['', '.3fa9c1d2e4b5.tmp', '~', '-old', '_bak', '.lock.takeover-0123456789abcdef']

test('one rule for leading dots: zero, one, two and five dots for every family, with every ending, as a file and as a folder', () => {
  const kit = rescueKit({ indexedDB: null, localStorage: null })
  for (const [family, rest, need] of FAMILIES) {
    for (const dots of DOTS) {
      for (const after of AFTER) {
        const part = '.'.repeat(dots) + rest + after
        const skipped = dots >= need
        for (const path of ['/dsh/home/auma/' + part, '/dsh/home/' + part + '/inside.txt']) {
          assert.equal(Boolean(kit.secretShape(path)), skipped, `${family}: ${path} should be ${skipped ? 'skipped' : 'copied'} (local)`)
          // The cloud copy is never narrower than the local rule.
          if (skipped) assert.ok(kit.secretShape(path, 'cloud'), path + ' (cloud)')
        }
      }
    }
  }
  // Ordinary names stay ordinary, however many dots they carry when no listed stem follows.
  for (const name of ['environment.md', 'aukora-notes.md', 'credentials', 'ssh', 'aws', 'transport', 'afferent-probe', 'notes.md',
    '..notes.md', '.DS_Store', '.conflict-backup', 'sessions', 'session.capx', '..session.capx', 'pepper.v10', '.....pepper.v10']) {
    assert.equal(kit.secretShape('/dsh/home/' + name), null, name)
  }
  // The shape says how the part began, never more of the name than the listed stem.
  assert.equal(kit.secretShape('/dsh/home/..ed25519-keypair.json'), '.ed25519-keypair.json with extra leading dots')
  assert.equal(kit.secretShape('/dsh/home/.....session.cap.tmp'), '.session.cap with extra leading dots plus an ending')
  assert.equal(kit.secretShape('/dsh/home/..env.local'), '.env…')
})

// The mirror rule's own table, withheld names only ("shaped"), copied as data from
// deploy/cloudflare/src/__tests__/secret-path-rule-table.json (rule version 5).
const MIRROR_WITHHELD = ['.credentials.yaml', '.credentials.yaml.3fa9c1d2e4b5.tmp', '.credentials.yaml.lock', '.credentials.yaml~',
  'credentials.yaml.bak', 'credentials.yaml-old', 'credentials.yaml_backup', 'credentials.yaml.temp', 'session.cap.tmp', 'session.cap~',
  '.session.cap.swp', '.session.cap.swo', 'session.cap.1', 'session.cap.orig', 'session.cap.part', 'session.cap.partial', 'session.cap.new.tmp',
  'ed25519-keypair.json.4f2a9c', 'ed25519-keypair.json.' + 'a'.repeat(64), '.ssh', '.ssh.bak', '.ssh-backup', '.aws.old', '.transport.prev',
  '.transport.next', 'pepper.v1', 'pepper.v1.next', 'pepper.v1.anything', '.env', '.env.local', '.envrc', '.aukora-x6-vault', '.afferent-probe.tmp',
  '..credentials.yaml.tmp', '.credentials.yaml.lock.3fa9c1d2e4b5', 'credentials.yaml.20261112', 'session.cap', '.session.cap', 'ed25519-keypair.json',
  '.ed25519-keypair.json', 'credentials.yaml', '..credentials.yaml', '.session.cap~', '.ed25519-keypair.json~', '..credentials.yaml~',
  'credentials.yaml.bak~', '.credentials.yaml.bak~', 'session.cap.tmp~', '.session.cap.3fa9c1~', 'credentials.yaml.lock.takeover-0123456789abcdef',
  '.credentials.yaml.lock.takeover-0123456789abcdef', '..credentials.yaml.lock.takeover-0123456789abcdef',
  '.credentials.yaml.lock.takeover-0123456789abcdef~', 'credentials.yaml.lock.takeover']

test('the kit is at least as wide as the mirror rule: every name the mirror withholds, the kit skips (file and folder, both copies)', () => {
  assert.equal(MIRROR_WITHHELD.length, 54)
  const kit = rescueKit({ indexedDB: null, localStorage: null })
  for (const name of MIRROR_WITHHELD) {
    for (const mode of [undefined, 'cloud']) {
      assert.ok(kit.secretShape('/dsh/home/auma/' + name, mode), name)
      assert.ok(kit.secretShape('/dsh/home/' + name + '/x', mode), name + ' as a folder')
    }
  }
})

test('the real kit never reads, sends or packs a double-dot signing key, cap, pepper, env, escrow or a two-dot secret folder', LIMIT, async () => {
  const secrets = ['/dsh/home/auma/..ed25519-keypair.json', '/dsh/home/auma/..session.cap', '/dsh/home/auma/..pepper.v1', '/dsh/home/..env.local',
    '/dsh/home/..aukora-escrow', '/dsh/home/.....credentials.yaml', '/dsh/home/..ssh/id_ed25519']
  const entries = baseEntries([['/dsh/home/auma', dirEntry()], ['/dsh/home/..ssh', dirEntry(0o700)], ...secrets.map(key => [key, fileEntry('SECRETMARK ' + key)])])
  const w = world({ entries })
  const cloud = await w.kit().copyToCloud()
  assert.equal(cloud.complete, true, cloud.line + ' ' + cloud.lines.join(' | '))
  const sent = JSON.parse(new TextDecoder().decode(w.vault.rescues.get(cloud.id)))
  for (const key of [...secrets, '/dsh/home/..ssh']) assert.ok(!sent.rows.some(row => row.key === key), key + ' reached her cloud')
  assert.ok(![...w.vault.blobs.values()].some(bytes => Buffer.from(bytes).includes('SECRETMARK')), 'a secret piece was uploaded')
  assert.equal(cloud.skipped.reduce((sum, entry) => sum + entry.count, 0), secrets.length + 1)
  const read = w.idb.log.requests.filter(request => request.method === 'get').map(request => request.key)
  assert.ok(!read.some(key => key.includes('/..') || key.includes('/.....')), 'a secret row was read: ' + read.join(','))
  const local = await w.kit().saveLocal()
  assert.equal(local.complete, true, local.line)
  const bytes = Buffer.from(await local.blob.arrayBuffer())
  assert.ok(!bytes.includes('SECRETMARK') && !bytes.includes('/..'), 'a secret reached the local pack')
})

// ── MUST 2: every network step of the cloud copy has a deadline ────────────────────────────────────────────────────

/** A stream that sends `first` bytes, then never another (it ignores cancel too). */
const stuckAfter = first => new ReadableStream({ start(controller) { if (first.length > 0) controller.enqueue(first) }, pull() { return new Promise(() => {}) } })
/** A stream that sends `bytes` in `size`-byte chunks every `every` ms (empty chunks when `size` is 0, for ever). */
function trickle(bytes, size, every) {
  let at = 0
  return new ReadableStream({
    async pull(controller) {
      await later(every)
      if (size === 0) { controller.enqueue(new Uint8Array(0)); return }
      if (at >= bytes.length) { controller.close(); return }
      controller.enqueue(bytes.slice(at, at + size))
      at += size
    },
  })
}
/**
 * Wrap the vault: requests that `pick` matches are answered by `answer(realResponse)` (or never, for 'headers'). Every
 * fetch must carry an AbortSignal; the log counts the stalled ones whose signal the kit aborted. `times` stalls at most.
 */
function stalling(pick, mode, { times = Infinity, size = 1, every = 30 } = {}) {
  const log = { signals: 0, stalled: [], fetches: 0 }
  const fetch = vault => async (path, init) => {
    log.fetches += 1
    if (init.signal && typeof init.signal.aborted === 'boolean') log.signals += 1
    const method = String(init.method || 'GET')
    if (!pick(method, String(path)) || log.stalled.length >= times) return vault.fetch(path, init)
    log.stalled.push(init.signal)
    if (mode === 'headers') return new Promise(() => {})
    const real = await vault.fetch(path, init)
    const bytes = new Uint8Array(await real.arrayBuffer())
    const body = mode === 'body' ? stuckAfter(bytes.subarray(0, 1)) : mode === 'empty' ? trickle(bytes, 0, 5) : trickle(bytes, size, every)
    return new Response(body, { status: real.status, headers: real.headers })
  }
  return { log, fetch }
}
const STEPS = [
  ['HEAD of a piece', (method, path) => method === 'HEAD'],
  ['PUT of a piece', (method, path) => method === 'PUT' && path.startsWith('/_vault/blob/')],
  ['PUT of the list', (method, path) => method === 'PUT' && path.startsWith('/_vault/rescue/')],
  ['verify call', (method, path) => method === 'POST'],
  ['GET of the list', (method, path) => method === 'GET' && path.startsWith('/_vault/rescue/')],
  ['GET of a piece', (method, path) => method === 'GET' && path.startsWith('/_vault/blob/')],
]

for (const [label, pick] of STEPS) {
  for (const mode of label.startsWith('HEAD') ? ['headers'] : ['headers', 'body', 'empty', 'slow']) {
    const said = { headers: 'no answer at all', body: 'a body that stops after one byte', empty: 'a body of empty chunks', slow: 'a body that trickles past the whole deadline' }[mode]
    test(`${label}, ${said}: cancelled, retried as a 5xx, then "not complete" with a plain sentence`, LIMIT, async () => {
      const { log, fetch } = stalling(pick, mode)
      // 'slow': a byte every 30 ms (inside the 40 ms idle deadline), past the whole deadline of 100 ms.
      // a request that sends a body has its own whole deadline (`bodyTotal`, above the edge's), held to 100 ms too.
      const w = world({ fetch, deadlines: mode === 'slow' ? { total: 100, bodyTotal: 100 } : {} })
      const result = await w.kit().copyToCloud()
      assert.equal(result.line, STALLED)
      assert.equal(result.complete, false)
      assert.equal(result.ok, false)
      assert.deepEqual(w.sleeps, RETRY_WAITS, 'the same five waits as a 5xx')
      assert.equal(log.stalled.length, 6, 'one try and five retries')
      assert.equal(log.signals, log.fetches, 'every fetch carries an AbortSignal')
      assert.ok(log.stalled.every(signal => signal.aborted), 'the kit aborted every stalled request')
    })
  }
}

test('a stall that happens once is retried and the copy completes', LIMIT, async () => {
  for (const [label, pick] of STEPS) {
    const { fetch } = stalling(pick, label.startsWith('HEAD') ? 'headers' : 'body', { times: 1 })
    const w = world({ fetch })
    const result = await w.kit().copyToCloud()
    assert.equal(result.complete, true, label + ': ' + result.line)
    assert.deepEqual(w.sleeps, [500], label)
  }
})

test('a body that trickles in time (a byte well inside the idle deadline, all inside the whole one) is not cut', LIMIT, async () => {
  const { log, fetch } = stalling((method, path) => method === 'GET' && path.startsWith('/_vault/blob/'), 'slow', { size: 16, every: 20 })
  const w = world({ fetch, deadlines: { idle: 200, total: 10000 } })
  const result = await w.kit().copyToCloud()
  assert.equal(result.complete, true, result.line)
  assert.deepEqual(w.sleeps, [])
  assert.equal(log.stalled.length, 1, 'the one piece came back as a trickle')
  assert.equal(log.stalled[0].aborted, false, 'and was never cut')
})

test('a body that ends short: the read-back says not the same, the run ends and never waits', LIMIT, async () => {
  const w = world({ fetch: vault => async (path, init) => {
    const real = await vault.fetch(path, init)
    if (init.method !== 'GET' || !String(path).startsWith('/_vault/blob/')) return real
    const bytes = new Uint8Array(await real.arrayBuffer())
    return new Response(bytes.subarray(0, bytes.length - 3), { status: 200 })
  } })
  const result = await w.kit().copyToCloud()
  assert.equal(result.complete, false)
  assert.deepEqual(result.lines.slice(0, 1), ['Not the same in her cloud: ' + MAIN])
})

test('a body that breaks mid-way counts as a failed fetch: retried, then the plain line', LIMIT, async () => {
  const w = world({ fetch: vault => async (path, init) => {
    if (init.method !== 'GET' || !String(path).startsWith('/_vault/blob/')) return vault.fetch(path, init)
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1])); controller.error(new Error('reset')) } }), { status: 200 })
  } })
  const result = await w.kit().copyToCloud()
  assert.equal(result.line, 'Her cloud did not answer. Press the button again: pieces already there are not sent again.')
  assert.deepEqual(w.sleeps, RETRY_WAITS)
})

/** The page script from the current sources, with timers 100 times faster, a fake document and the given globals. */
function pageIn(globals) {
  const elements = new Map()
  const element = id => ({ id, hidden: false, disabled: false, textContent: '', children: [], listeners: {}, href: '', download: '',
    get firstChild() { return this.children[0] ?? null }, addEventListener(type, listener) { this.listeners[type] = listener },
    appendChild(child) { this.children.push(child) }, removeChild(child) { this.children.splice(this.children.indexOf(child), 1) },
    click() { this.clicked = (this.clicked || 0) + 1 }, remove() {} })
  for (const id of ['rescue-cloud', 'rescue-local', 'rescue-status', 'rescue-detail', 'rescue-left', 'rescue-left-list', 'rescue-signin']) elements.set(id, element(id))
  runInNewContext(composeRescuePageScript(), { crypto, TextEncoder, TextDecoder, Blob, AbortController, localStorage: null, location: { assign() {} },
    setTimeout: (fn, ms) => setTimeout(fn, ms / 100), clearTimeout, URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
    document: { getElementById: id => elements.get(id), createElement: tag => element(tag), body: element('body') }, ...globals })
  const press = async id => {
    elements.get(id).listeners.click()
    await later(0)
    for (let spins = 0; spins < 5000 && elements.get('rescue-cloud').disabled; spins++) await later(1)
  }
  return { elements, press, status: () => elements.get('rescue-status').textContent, detail: () => elements.get('rescue-detail').children.map(child => child.textContent) }
}

test('the page: a piece GET that never answers ends "not complete" with both buttons enabled again', LIMIT, async () => {
  const idb = new FakeIndexedDb()
  idb.seed(DB, baseEntries())
  const vault = createFakeVault()
  const { log, fetch } = stalling((method, path) => method === 'GET' && path.startsWith('/_vault/blob/'), 'headers')
  const page = pageIn({ indexedDB: idb, fetch: fetch(vault) })
  await page.press('rescue-cloud')
  assert.equal(page.status(), STALLED)
  assert.equal(page.elements.get('rescue-cloud').disabled, false)
  assert.equal(page.elements.get('rescue-local').disabled, false)
  assert.ok(log.stalled.length === 6 && log.stalled.every(signal => signal.aborted))
})

// ── MUST 3: saved settings stay in this browser for the cloud copy too ─────────────────────────────────────────────

class CountingStorage extends FakeLocalStorage {
  reads = 0
  got = []
  get length() { this.reads += 1; return this.map.size }
  key(index) { this.reads += 1; return super.key(index) }
  getItem(name) { this.reads += 1; this.got.push(name); return super.getItem(name) }
}

test('the cloud copy leaves saved settings in this browser (names listed, no value read) unless settings: true; the page says so in one line', LIMIT, async () => {
  const settings = [['aukora.theme', 'dark'], ['session', 'NEUTRALNAME-SECRET'], ['settings', '{"key":"VALUEMARK"}'], ['apiKey', 'k']]
  const w = world({ settings })
  const ls = new CountingStorage(settings)
  const off = await w.kit({ localStorage: ls }).copyToCloud()
  assert.equal(off.complete, true, off.line)
  // the names are listed (to find Auma Live chat logs); no value outside that allow-list is read.
  assert.deepEqual(ls.got, [], 'no saved setting was read')
  const sent = JSON.parse(new TextDecoder().decode(w.vault.rescues.get(off.id)))
  assert.deepEqual(sent.rows.filter(row => row.type === 'local'), [])
  assert.ok(![...w.vault.blobs.values()].some(bytes => /NEUTRALNAME|VALUEMARK/.test(Buffer.from(bytes).toString())))
  assert.deepEqual(off.lines, [STAY])
  assert.equal('completeness' in sent, false, 'the cloud wire is unchanged')
  // settings: true keeps the earlier behaviour for a caller that asks (secret-like names still stay behind).
  const on = await w.kit().copyToCloud({ settings: true })
  assert.equal(on.complete, true, on.line)
  const sentOn = JSON.parse(new TextDecoder().decode(w.vault.rescues.get(on.id)))
  assert.deepEqual(sentOn.rows.filter(row => row.type === 'local').map(row => row.key), ['localStorage:aukora.theme', 'localStorage:session', 'localStorage:settings'])
  assert.ok(!on.lines.includes(STAY))
  assert.ok(on.lines.includes(ALL))
  assert.deepEqual(on.skipped, [{ shape: 'saved setting with a secret-like name', count: 1 }])
  // readIndex follows the same default.
  assert.deepEqual((await w.kit().readIndex()).index.rows.filter(row => row.type === 'local'), [])
  // The page: its text says it, and a cloud run shows the line.
  assert.ok(RESCUE_PAGE.html.includes('her Auma Live chat logs. Other saved settings stay in this browser.'))
  assert.ok(!/cloud also takes/.test(RESCUE_PAGE.html))
  const idb = new FakeIndexedDb()
  idb.seed(DB, baseEntries())
  const vault = createFakeVault()
  const page = pageIn({ indexedDB: idb, fetch: vault.fetch, localStorage: new FakeLocalStorage(settings) })
  await page.press('rescue-cloud')
  assert.match(page.status(), /^Rescue copy complete and checked/)
  assert.deepEqual(page.detail(), [STAY])
  const index = JSON.parse(new TextDecoder().decode([...vault.rescues.values()][0]))
  assert.deepEqual(index.rows.filter(row => row.type === 'local'), [])
})

// ── SHOULD: IndexedDB reads never hold her app up ──────────────────────────────────────────────────────────────────

test('a version change during a read ABORTS that read at once, closes the connection and ends "not complete"', LIMIT, async () => {
  for (const run of ['copyToCloud', 'saveLocal']) {
    const w = world()
    let held = null
    w.idb.hooks.hold = (method, key, tx) => { if (method === 'get' && key === MAIN && !held) { held = tx; return true } return false }
    const done = w.kit()[run]()
    while (!held) await later(1)
    const db = w.idb.dbs.get(DB)
    db.fireVersionChange()
    // Synchronously, inside her app's versionchange: the read is aborted and the connection is gone.
    assert.equal(held.entry.aborted, true, run + ': the active read was aborted')
    assert.equal(db.connections.size, 0, run + ': the connection is closed')
    const result = await done
    assert.equal(result.line, UPGRADING, run)
    assert.equal(result.complete, false)
    assert.equal(result.blob ?? null, null)
  }
})

test('one read past its deadline is aborted and the run ends "not complete" (it never waits for ever)', LIMIT, async () => {
  for (const run of ['copyToCloud', 'saveLocal']) {
    const w = world({ deadlines: { read: 50 } })
    let held = null
    w.idb.hooks.hold = (method, key, tx) => { if (method === 'get' && key === MAIN && !held) { held = tx; return true } return false }
    const result = await w.kit()[run]()
    assert.equal(result.line, SLOW_READ, run)
    assert.equal(result.complete, false)
    assert.equal(held.entry.aborted, true, run + ': the stuck read was aborted')
    assert.equal(w.idb.log.closes, w.idb.log.opens.length, run + ': every connection closed')
    assert.equal(w.vault.log.length, 0, run + ': nothing was sent')
  }
})

// ── SHOULD: unexpected errors pass the private-path redaction ──────────────────────────────────────────────────────

const PRIVATE_PATH = '/dsh/home/auma/private/diary PRIVMARK.md'
/** An IndexedDB whose transactions throw an error naming a private file. */
function throwingIdb() {
  const db = { objectStoreNames: { contains: () => true }, close() {}, transaction() { throw new Error('cannot read ' + PRIVATE_PATH + ' (and %2Fdsh%2Fhome%2Fauma%2Fprivate%2FPRIVMARK)') } }
  return {
    databases: async () => [{ name: DB }],
    open() {
      const request = {}
      setTimeout(() => { request.result = db; request.onsuccess() }, 0)
      return request
    },
  }
}

test('an unexpected error never shows a private file: kit, page, local console and worker console', LIMIT, async () => {
  const kit = rescueKit({ indexedDB: throwingIdb(), localStorage: null })
  for (const run of ['copyToCloud', 'saveLocal', 'readIndex']) {
    const error = await kit[run]().then(() => null, caught => caught)
    assert.ok(error, run + ' threw')
    assert.equal(error.message, 'cannot read /dsh/home/auma/private/[redacted]')
    assert.doesNotMatch(String(error.stack), /PRIVMARK/)
  }
  assert.equal(kit.redactText('x %2fdsh%2Fhome%2fauma%2Fprivate%2fPRIVMARK y'), 'x /dsh/home/auma/private/[redacted]')
  assert.equal(kit.redactText('a \\/dsh\\/home\\/auma\\/private\\/PRIVMARK'), 'a /dsh/home/auma/private/[redacted]')
  assert.equal(kit.stoppedLine(new Error('boom ' + PRIVATE_PATH)), 'This copy stopped: boom /dsh/home/auma/private/[redacted]. Nothing in this browser was changed. Press the button again.')
  // The page.
  const page = pageIn({ indexedDB: throwingIdb() })
  await page.press('rescue-local')
  assert.equal(page.status(), 'This copy stopped: cannot read /dsh/home/auma/private/[redacted]. Nothing in this browser was changed. Press the button again.')
  assert.equal(page.elements.get('rescue-local').disabled, false)
  // The plain page's console.
  const logged = []
  const text = await runInNewContext(composeLocalConsoleScript(), { crypto, TextEncoder, TextDecoder, setTimeout, clearTimeout, Blob, indexedDB: throwingIdb(),
    localStorage: null, URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} }, console: { log: line => logged.push(line) },
    document: { createElement: () => ({ click() {}, remove() {} }), body: { appendChild() {} } } })
  assert.match(text, /^This copy stopped: cannot read \/dsh\/home\/auma\/private\/\[redacted\]\./)
  assert.doesNotMatch(text + logged.join('\n'), /PRIVMARK/)
  // Her worker's console: a file system whose stat answers with a broken object naming a private file.
  const fs = { readdirSync: () => [], readFileSync: () => new Uint8Array(0),
    statSync: () => ({ mode: 0o600, mtimeMs: 1, isDirectory() { throw new Error('stat ' + PRIVATE_PATH) } }) }
  const memoryLogged = []
  const memory = await runInNewContext(composeMemoryConsoleScript(), { crypto, TextEncoder, TextDecoder, setTimeout, clearTimeout, Blob,
    URL: { createObjectURL: () => 'blob:m' }, console: { log: line => memoryLogged.push(line) }, __X6_SERVICES__: { fs } })
  assert.equal(memory.ok, false)
  assert.deepEqual(Object.keys(memory).sort(), ['blob', 'complete', 'fileName', 'id', 'line', 'lines', 'ok', 'url'])
  assert.doesNotMatch(JSON.stringify(memory) + memoryLogged.join('\n'), /PRIVMARK/)
  assert.match(memory.line, /^This copy stopped: stat \/dsh\/home\/auma\/private\/\[redacted\]\./)
})
