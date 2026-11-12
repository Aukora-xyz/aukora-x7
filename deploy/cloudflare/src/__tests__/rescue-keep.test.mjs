/**
 * The rescue pack, job 2 review: the kit says "saved" only after it has read the finished pack
 * back from the Blob itself (from a dry run where a pack Blob broke after fourteen runs in one tab), it
 * holds one pack at a time, its hashing yields without timers, and the way back never leaves its folder.
 * Every pack is made by the REAL kit over a made-up store (rescue-fakes.mjs); the Blobs that fail are fakes built on the
 * real Blob, so only the read-back sees the fault.
 */
import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { rescueKit } from '../rescue-kit.mjs'
import { composeLocalConsoleScript, composeMemoryConsoleScript, composeRescuePageScript } from '../rescue-page.generate.mjs'
import { FakeIndexedDb, dirEntry, fakeFsFromEntries, fileEntry } from './rescue-fakes.mjs'

const DB = 'aukora-x6-vfs'
const MiB = 1048576
const ROOT = fileURLToPath(new URL('../../../../', import.meta.url))
const VERIFY = join(ROOT, 'server/rescue-verify.mjs')
/**
 * The temporary folder, made by the FIRST test that writes a file (not at load): in a sandbox where the temporary
 * folder cannot be written, only the tests that write fail (with the reason), and every other test still runs.
 */
let made = null
const scratch = () => (made ??= mkdtempSync(join(tmpdir(), 'rescue-keep-test-')))
after(() => { if (made) rmSync(made, { recursive: true, force: true }) })
const later = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms))
const COULD_NOT_KEEP = /^This browser could not keep the copy \((.+)\)\. Close this window and run once in a new one\.$/
const HELD = 'A copy made in this window is still held here. Close this window and run once in a new one.'

const MAIN = '/dsh/home/sessions/agent/main/session.v3.jsonl'
/** A made-up store with a 9 MiB journal (so the read-back takes three slices) and a few small rows. */
function entries(extra = []) {
  const big = new Uint8Array(9 * MiB + 77)
  for (let at = 0; at < big.length; at++) big[at] = (at * 31 + 7) & 0xff
  return [
    ['/dsh/home', dirEntry()], ['/dsh/home/sessions', dirEntry()], ['/dsh/home/sessions/agent', dirEntry()],
    ['/dsh/home/sessions/agent/main', dirEntry()], [MAIN, fileEntry(big, 1700000000000, 0o600)],
    ['/dsh/home/notes.md', fileEntry('hello', 1700000000001)], ['/dsh/home/other.md', fileEntry('world', 1700000000002)],
    ['@x6-mirror-meta', { clientId: 'client-A', cloudBase: null }],
    ...extra,
  ]
}
const seeded = (list = entries()) => { const idb = new FakeIndexedDb(); idb.seed(DB, list); return idb }

/** A Blob class whose slices fail or lie on read; every Blob the kit builds is one of these, but only slices are read. */
function faultyBlob({ rejectPast = Infinity, flipAt = -1, sizes = null } = {}) {
  return class FaultyBlob extends Blob {
    slice(start = 0, end = this.size) {
      const inner = super.slice(start, end)
      if (sizes) sizes.push(end - start)
      return {
        size: inner.size,
        arrayBuffer: async () => {
          if (end > rejectPast) throw new DOMException('The requested file could not be read', 'NotReadableError')
          const bytes = new Uint8Array(await inner.arrayBuffer())
          if (flipAt >= start && flipAt < end) bytes[flipAt - start] ^= 0x01
          return bytes.buffer
        },
      }
    }
  }
}
/** A URL stand-in that records what was made and revoked. */
function recordingUrl() {
  const made = [], revoked = []
  return { made, revoked, URL: { createObjectURL: () => { const url = 'blob:rescue-' + (made.length + 1); made.push(url); return url }, revokeObjectURL: url => { revoked.push(url) } } }
}
/** The REAL kit inside a bare context with the given globals. */
const kitIn = (globals, options) => runInNewContext(`(${rescueKit.toString()})`, { crypto, TextEncoder, TextDecoder, setTimeout, Blob, ...globals })(options)
/** The page script (from the current sources), run as a browser would, with a fake document. */
function pageIn(globals) {
  const elements = new Map()
  const element = id => ({ id, hidden: false, disabled: false, textContent: '', children: [], listeners: {}, href: '', download: '',
    get firstChild() { return this.children[0] ?? null }, addEventListener(type, listener) { this.listeners[type] = listener },
    appendChild(child) { this.children.push(child) }, removeChild(child) { this.children.splice(this.children.indexOf(child), 1) },
    click() { this.clicked = (this.clicked || 0) + 1 }, remove() {} })
  for (const id of ['rescue-cloud', 'rescue-local', 'rescue-status', 'rescue-detail', 'rescue-left', 'rescue-left-list', 'rescue-signin']) elements.set(id, element(id))
  const created = []
  runInNewContext(composeRescuePageScript(), { crypto, TextEncoder, TextDecoder, setTimeout, Blob, localStorage: null, location: { assign() {} },
    fetch: () => { throw new Error('no network') },
    document: { getElementById: id => elements.get(id), createElement: tag => { const made = element(tag); created.push(made); return made }, body: element('body') },
    ...globals })
  const press = async id => {
    elements.get(id).listeners.click()
    await later(0)
    for (let spins = 0; spins < 4000 && elements.get('rescue-local').disabled; spins++) await later(1)
  }
  return { elements, created, press, status: () => elements.get('rescue-status').textContent, downloads: () => created.filter(made => made.download) }
}

// ── MUST 7 (a): the finished pack is read back before the kit says "saved" ──────────────────────────────────────────

test('a pack Blob whose slice rejects after N bytes: "could not keep", no Blob, and no download (kit, page, console)', async () => {
  const N = 5 * MiB
  const kit = kitIn({ Blob: faultyBlob({ rejectPast: N }), URL: recordingUrl().URL }, { indexedDB: seeded(), localStorage: null })
  const result = await kit.saveLocal()
  assert.match(result.line, COULD_NOT_KEEP)
  assert.equal(COULD_NOT_KEEP.exec(result.line)[1], 'it could not read the copy back: NotReadableError')
  assert.equal(result.blob, null)
  assert.equal(result.ok, false)
  assert.equal(result.complete, false)
  assert.equal(result.fileName, null)
  // The page: no object URL, no anchor, no click; the status line is the same headline.
  const urls = recordingUrl()
  const page = pageIn({ Blob: faultyBlob({ rejectPast: N }), URL: urls.URL, indexedDB: seeded() })
  await page.press('rescue-local')
  assert.match(page.status(), COULD_NOT_KEEP)
  assert.deepEqual(page.downloads(), [])
  assert.deepEqual(urls.made, [])
  // The console script for a plain page: the same.
  const consoleUrls = recordingUrl()
  const clicked = []
  const text = await runInNewContext(composeLocalConsoleScript(), { crypto, TextEncoder, TextDecoder, setTimeout, Blob: faultyBlob({ rejectPast: N }),
    indexedDB: seeded(), localStorage: null, URL: consoleUrls.URL, console: { log() {} },
    document: { createElement: () => ({ click() { clicked.push(1) }, remove() {} }), body: { appendChild() {} } } })
  assert.match(text.split('\n')[0], COULD_NOT_KEEP)
  assert.deepEqual(clicked, [])
  assert.deepEqual(consoleUrls.made, [])
})

test('a pack Blob whose bytes differ (in a row, in the list of rows): "could not keep", and no download', async () => {
  // Find where things sit in a good pack made from the same store.
  const good = await rescueKit({ indexedDB: seeded(), localStorage: null }).saveLocal()
  assert.equal(good.complete, true, good.line)
  const size = good.blob.size
  for (const [flipAt, reason] of [[11 + 3 * MiB + 5, '1 row read back different from what was copied'], [size - 40, 'its list of rows read back different']]) {
    const kit = kitIn({ Blob: faultyBlob({ flipAt }), URL: recordingUrl().URL }, { indexedDB: seeded(), localStorage: null })
    const result = await kit.saveLocal()
    assert.match(result.line, COULD_NOT_KEEP, 'flip at ' + flipAt)
    assert.equal(COULD_NOT_KEEP.exec(result.line)[1], reason)
    assert.equal(result.blob, null)
    const urls = recordingUrl()
    const page = pageIn({ Blob: faultyBlob({ flipAt }), URL: urls.URL, indexedDB: seeded() })
    await page.press('rescue-local')
    assert.match(page.status(), COULD_NOT_KEEP)
    assert.deepEqual(page.downloads(), [])
    assert.deepEqual(urls.made, [])
  }
})

test('a good pack is read back in slices of at most 4 MiB, then said saved', async () => {
  const sizes = []
  const kit = kitIn({ Blob: faultyBlob({ sizes }), URL: recordingUrl().URL }, { indexedDB: seeded(), localStorage: null })
  const result = await kit.saveLocal()
  assert.match(result.line, /^Saved a copy on this computer: 1 threads/)
  assert.ok(result.blob)
  assert.ok(sizes.length >= 4, 'read back in ' + sizes.length + ' slices')
  assert.ok(Math.max(...sizes) <= 4 * MiB, 'largest slice ' + Math.max(...sizes))
  assert.equal(sizes.reduce((a, b) => a + b, 0), result.blob.size, 'every byte was read back once')
})

// ── MUST 7 (b), (c): one pack held at a time; the URL revoked after the click ───────────────────────────────────────

test('a second saveLocal while a pack is held is refused (nothing read) unless again: true, which releases the old pack and URL first', async () => {
  const urls = recordingUrl()
  const idb = seeded()
  const kit = kitIn({ URL: urls.URL }, { indexedDB: idb, localStorage: null })
  const first = await kit.saveLocal()
  assert.ok(first.blob)
  const url = kit.urlOf(first.blob)
  const opens = idb.log.opens.length
  const refused = await kit.saveLocal()
  assert.equal(refused.line, HELD)
  assert.equal(refused.blob, null)
  assert.equal(refused.ok, false)
  assert.equal(idb.log.opens.length, opens, 'nothing was read for a refused run')
  assert.deepEqual(urls.revoked, [], 'a refused run lets nothing go')
  const again = await kit.saveLocal({ again: true })
  assert.deepEqual(urls.revoked, [url], 'the old URL was revoked before the new run')
  assert.ok(again.blob && again.blob !== first.blob)
  assert.match(again.line, /^Saved a copy on this computer/)
  kit.release()
  assert.ok((await kit.saveLocal()).blob, 'after release() a run is not refused')
})

test('the page revokes its URL right after the click and refuses a second press; the console scripts hold one pack per page', async () => {
  const urls = recordingUrl()
  const idb = seeded()
  const page = pageIn({ URL: urls.URL, indexedDB: idb })
  await page.press('rescue-local')
  assert.match(page.status(), /^Saved a copy on this computer/)
  assert.equal(page.downloads().length, 1)
  assert.equal(page.downloads()[0].clicked, 1)
  assert.deepEqual(urls.made, ['blob:rescue-1'])
  assert.deepEqual(urls.revoked, ['blob:rescue-1'], 'revoked at once, not after a timer')
  const opens = idb.log.opens.length
  await page.press('rescue-local')
  assert.equal(page.status(), HELD)
  assert.equal(page.downloads().length, 1, 'no second download')
  assert.equal(idb.log.opens.length, opens)
  // Console: one shared global per page holds the pack across pastes.
  const consoleUrls = recordingUrl()
  const context = { crypto, TextEncoder, TextDecoder, setTimeout, Blob, indexedDB: seeded(), localStorage: null, URL: consoleUrls.URL, console: { log() {} },
    document: { createElement: () => ({ click() {}, remove() {} }), body: { appendChild() {} } } }
  const first = await runInNewContext(composeLocalConsoleScript(), context)
  assert.match(first, /^Saved a copy on this computer/)
  assert.deepEqual(consoleUrls.revoked, consoleUrls.made, 'the console revokes its URL after the click')
  assert.equal((await runInNewContext(composeLocalConsoleScript(), context)).split('\n')[0], HELD)
  assert.match(await runInNewContext(composeLocalConsoleScript({ again: true }), context), /^Saved a copy on this computer/)
  // Her worker's console hands its URL out; the next run with again revokes it first.
  const memoryUrls = recordingUrl()
  const fs = fakeFsFromEntries(entries().filter(([key]) => key.startsWith('/')))
  const memoryContext = { crypto, TextEncoder, TextDecoder, setTimeout, Blob, URL: memoryUrls.URL, console: { log() {} }, __X6_SERVICES__: { fs } }
  const handed = await runInNewContext(composeMemoryConsoleScript(), memoryContext)
  assert.equal(handed.url, 'blob:rescue-1')
  assert.deepEqual(memoryUrls.revoked, [])
  assert.equal((await runInNewContext(composeMemoryConsoleScript(), memoryContext)).line, HELD)
  const second = await runInNewContext(composeMemoryConsoleScript({ again: true }), memoryContext)
  assert.equal(second.url, 'blob:rescue-2')
  assert.deepEqual(memoryUrls.revoked, ['blob:rescue-1'])
  assert.match(composeLocalConsoleScript(), /again: false/)
  assert.match(composeLocalConsoleScript({ again: true }), /again: true/)
})

// ── SHOULD: hashing a large row yields without a timer (a hidden tab throttles timers) ─────────────────────────────

test('a large row is hashed with no timer turn: the run ends even where timers never fire', async () => {
  const stalled = () => 0
  const kit = kitIn({ setTimeout: stalled, MessageChannel, URL: recordingUrl().URL }, { indexedDB: seeded(), localStorage: null })
  const ended = await Promise.race([kit.saveLocal().then(result => result.line), later(10000).then(() => 'still waiting on a timer')])
  assert.match(ended, /^Saved a copy on this computer/)
})

// ── SHOULD: the way back never leaves its folder ────────────────────────────────────────────────────────────────────

test('--extract refuses a name holding a backslash (a folder mark on Windows) and, on Windows, a colon', async () => {
  const evil = '/dsh/home/a/..\\..\\..\\evil'
  const result = await rescueKit({ indexedDB: seeded(entries([['/dsh/home/a', dirEntry()], [evil, fileEntry('x')]])), localStorage: null }).saveLocal()
  assert.equal(result.complete, true, result.line)
  const folder = join(scratch(), 'backslash')
  mkdirSync(folder)
  const pack = join(folder, result.fileName)
  writeFileSync(pack, Buffer.from(await result.blob.arrayBuffer()))
  const out = join(folder, 'out')
  const run = spawnSync(process.execPath, [VERIFY, pack, '--extract', out], { encoding: 'utf8' })
  assert.equal(run.status, 1, run.stdout + run.stderr)
  assert.match(run.stdout, /refused paths 1/)
  assert.ok(existsSync(join(out, 'files/dsh/home/notes.md')))
  assert.deepEqual(readdirSync(join(out, 'files/dsh/home/a')), [], 'the backslash name was not written')
  const { partsOf, inside } = await import('../../../../server/rescue-verify.mjs')
  assert.equal(typeof partsOf, 'function')
  assert.equal(partsOf(evil, 'darwin'), null)
  assert.equal(partsOf(evil, 'win32'), null)
  assert.equal(partsOf('/dsh/home/C:/x', 'win32'), null)
  assert.equal(partsOf('/dsh/home/a:b', 'win32'), null)
  assert.deepEqual(partsOf('/dsh/home/at 12:30.md', 'darwin'), ['dsh', 'home', 'at 12:30.md'])
  assert.equal(inside('/x/files', '/x/files/a/b'), true)
  assert.equal(inside('/x/files', '/x/files/../evil'), false)
  assert.equal(inside('/x/files', '/x/files'), false)
})
