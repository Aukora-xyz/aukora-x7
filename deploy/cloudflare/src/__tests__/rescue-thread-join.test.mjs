/**
 * The `/rescue` page joins his rescued journals as her threads and checks one from any
 * device. No fake of either side: the REAL `rescueKit` and page script, over the exported fakes of the outsides only
 * (rescue-fakes.mjs: in-memory IndexedDB, MIRROR's storage, R2's ranged get; vault-fakes.mjs: in-memory bucket, budget
 * and roll-back storage), against the REAL `handleVaultRequest`, the REAL `handleThreadRequest` whose `mirror.call` runs
 * the REAL `threadCommit` in that storage, and the REAL `leaseAction` and `checkLease`. No worker.mjs and no
 * mirror-do.mjs: those joins have their own tests (thread-mount, mirror-world-mount). `edge()` below is the only glue,
 * and it is the glue those mounts build: `/_vault/*` to the vault, `/_thread/*` to the thread handler, `POST /_mirror/lease` to `leaseAction`.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import v8 from 'node:v8'
import vm, { runInNewContext } from 'node:vm'
import { rescueKit } from '../rescue-kit.mjs'
import { RESCUE_PAGE } from '../rescue-page.mjs'
import { handleThreadRequest, threadCommit, threadLimits, createR2PartStore, threadIdForPath } from '../thread-log.mjs'
import { leaseAction, checkLease, WORLD_LEASE } from '../world-lease.mjs'
import { retiredReply } from '../mirror-slot-tombstone.mjs'
import { chargeWorldBudgetIn } from '../world-budget.mjs'
import { FakeIndexedDb, createMirrorStorage, rangedBucket, dirEntry, fileEntry } from './rescue-fakes.mjs'
import { buildRescue, createVaultBucket, createVaultBudget, createVaultFetch } from './vault-fakes.mjs'
import { waitFor } from './wait-for.mjs'

const DB = 'aukora-x6-vfs'
const WORLD = 'node-main-v1'
const ORIGIN = 'https://x61.example.invalid'
const PIECE = 4096
const CLIENT = '1b4e28ba-2fa1-41d2-883f-0016d3cca427'
const OTHER = '6fa459ea-ee8a-4ca4-894e-db77e160355e'
const A = '/dsh/home/sessions/agent/a/session.v1.jsonl'
const B = '/dsh/home/sessions/agent/b/session.v1.jsonl'
const C = '/dsh/home/auma/session/messages.jsonl'
const LEASE_ROW = 'world:v1:lease'
const T0 = new Date(2026, 10, 12, 19, 30, 0).getTime()
const T_B = new Date(2026, 10, 12, 19, 41, 0).getTime()
const enc = new TextEncoder()
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const later = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms))
const hhmm = ms => { const d = new Date(ms); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') }

/** A journal of whole JSON lines, `size` bytes, different in every piece. */
function journal(size, tag) {
  const out = new Uint8Array(size)
  let at = 0, n = 0
  while (at < size) {
    const line = enc.encode(`{"role":"user","t":"${tag}","n":${n++},"text":"a line of his conversation"}\n`)
    out.set(line.subarray(0, Math.min(line.length, size - at)), at)
    at += line.length
  }
  // The last byte is a newline, as her journals end.
  out[size - 1] = 10
  return out
}
const join2 = (a, b) => { const out = new Uint8Array(a.length + b.length); out.set(a); out.set(b, a.length); return out }

/** Her store as idb-persist leaves it, with the given journals and her mirror client id. */
function storeEntries(journals, clientId = CLIENT) {
  const rows = [['/dsh/home', dirEntry()], ['/dsh/home/auma', dirEntry()], ['/dsh/home/auma/session', dirEntry()],
    ['/dsh/home/sessions', dirEntry()], ['/dsh/home/sessions/agent', dirEntry()], ['/dsh/home/auma/notes.md', fileEntry('notes')]]
  for (const [path, bytes, mtimeMs] of journals) rows.push([path, fileEntry(bytes, mtimeMs ?? T0)])
  // `clientId` null: a store that never had a mirror client id (no meta row at all).
  if (clientId !== null) rows.push(['@x6-mirror-meta', { clientId, cloudBase: { lineageId: 'L1', revision: 7 } }])
  return rows
}

/**
 * Her edge in memory: the real vault, the real thread handler over the real `threadCommit`, the real lease, one MIRROR
 * storage for the lease and the thread rows. `hooks.before(entry, init)` may answer first (to inject an edge answer);
 * `log` records every request (method, path, keepalive); `imports` counts the import requests in flight at once.
 */
function edge({ piece = PIECE, clock = { t: T0 } } = {}) {
  const bucket = createVaultBucket()
  const budget = createVaultBudget({ now: () => clock.t })
  const vaultFetch = createVaultFetch({ bucket, budget, world: WORLD, now: () => clock.t, ...(piece === 2097152 ? {} : { limits: { piece } }) })
  const mirror = createMirrorStorage()
  const protocol = { piece, row: piece === 2097152 ? 65536 : 128 }
  const parts = createR2PartStore(rangedBucket(bucket), WORLD)
  // `rescues.get(id)`: `{ index, verifiedAt }` for a verified index (its manifest names the SHA-256 of its bytes), else
  // null: the shape the Worker's glue answers (thread-mount.mjs vaultRescues). It was the plain index.
  const rescues = {
    async get(id) {
      const manifest = bucket.objects.get(`w/${WORLD}/rescue/${id}/manifest.json`)
      const pending = bucket.objects.get(`w/${WORLD}/rescue/${id}/pending.json`)
      if (!manifest || !pending) return null
      const facts = JSON.parse(new TextDecoder().decode(manifest.bytes))
      if (facts.verified !== true || sha(pending.bytes) !== facts.indexSha) return null
      return { index: JSON.parse(new TextDecoder().decode(pending.bytes)), verifiedAt: facts.verifiedAt }
    },
  }
  const e = { bucket, mirror, clock, log: [], hooks: { before: null, after: null }, imports: { now: 0, max: 0, order: [] }, piece }
  e.threadMirror = {
    async call(op, input) {
      const answer = await mirror.transaction(tx => threadCommit(tx, op, JSON.parse(JSON.stringify(input)), {
        checkLease: (t, ref, at) => checkLease(t, ref, at, { mode: 'observe' }),
        budget: { charge: (t, ask) => chargeWorldBudgetIn(t, { ...ask, now: clock.t }) },
        limits: threadLimits({}), protocol, now: () => clock.t,
      }))
      return JSON.parse(JSON.stringify(answer))
    },
  }
  const route = async (url, method, init) => {
    if (url.pathname.startsWith('/_vault/')) return vaultFetch(url.pathname + url.search, init)
    if (url.pathname.startsWith('/_thread/')) {
      const headers = { ...(init.headers ?? {}), origin: ORIGIN, 'sec-fetch-site': 'same-origin' }
      const request = new Request(url, { method, headers, body: method === 'GET' || method === 'HEAD' ? null : init.body })
      return handleThreadRequest({ request, url, mirror: e.threadMirror, parts, rescues, protocol })
    }
    if (url.pathname === '/_mirror/lease' && method === 'POST') {
      const answer = await leaseAction(mirror, JSON.parse(init.body), { now: clock.t, ownerApproved: false, homeFreeze: 'record' })
      return Response.json(answer.body, { status: answer.status })
    }
    return Response.json({ ok: false, code: 'NOT_FOUND' }, { status: 404 })
  }
  e.fetch = async (input, init = {}) => {
    const url = new URL(String(input), ORIGIN)
    const method = String(init.method ?? 'GET').toUpperCase()
    const entry = { method, path: url.pathname, search: url.search, keepalive: init.keepalive === true, headers: { ...(init.headers ?? {}) },
      body: typeof init.body === 'string' ? init.body : null }
    e.log.push(entry)
    const importing = url.pathname === '/_thread/import'
    if (importing) {
      e.imports.now += 1
      e.imports.max = Math.max(e.imports.max, e.imports.now)
      e.imports.order.push(JSON.parse(init.body).path)
    }
    try {
      await later(0)
      const hooked = e.hooks.before ? await e.hooks.before(entry, init) : undefined
      const response = hooked ?? await route(url, method, init)
      entry.status = response.status
      if (e.hooks.after) await e.hooks.after(entry, response)
      return response
    } finally { if (importing) e.imports.now -= 1 }
  }
  e.lease = () => mirror.snapshot().get(LEASE_ROW) ?? null
  e.thread = async path => mirror.snapshot().get('thread:v1:index:' + await threadIdForPath(path)) ?? null
  e.since = n => e.log.slice(n)
  return e
}

/** The real kit over her store (or none) and this edge. Waits are recorded, never slept. */
function kitOf(e, idb, extra = {}) {
  const sleeps = []
  const kit = rescueKit({ indexedDB: idb, localStorage: null, fetch: e.fetch, piece: e.piece, sleep: async ms => { sleeps.push(ms) }, now: () => e.clock.t, ...extra })
  kit.sleeps = sleeps
  return kit
}
const seeded = journals => { const idb = new FakeIndexedDb(); idb.seed(DB, storeEntries(journals)); return idb }
const reseed = (idb, journals) => { const data = idb.data(); data.clear(); for (const [key, value] of storeEntries(journals)) data.set(key, structuredClone(value)) }

const B1 = journal(3 * PIECE + 100, 'b1')
const B2 = join2(B1, journal(PIECE + 700, 'b2'))
const C1 = journal(PIECE + 300, 'c1')
const C2 = journal(2 * PIECE + 40, 'c2')
const A1 = journal(2 * PIECE + 50, 'a1')

/** The cloud after a first copy and join of B1 and C1, then his store moved on: A new, B grown, C forked. */
async function movedOn() {
  const e = edge()
  const idb = seeded([[B, B1, T0], [C, C1, T0]])
  const first = kitOf(e, idb)
  const copied = await first.copyToCloud()
  assert.equal(copied.complete, true, copied.line)
  const joined = await first.joinThreads({ clientId: CLIENT, rescueId: copied.id })
  assert.deepEqual(joined.rows.map(row => [row.path, row.outcome]), [[C, 'imported'], [B, 'imported']])
  e.clock.t += 60000
  reseed(idb, [[A, A1, T0 + 120000], [B, B2, T_B], [C, C2, T0 + 60000]])
  return { e, idb }
}


// ── The words of one read of her cloud, each with its time ───────────────────────────────────────────
const COUNT = (n, m, at) => `At ${hhmm(at)} her cloud showed ${n} of ${m} threads with the same content as this copy.`
const NEWEST = (at, title) => `This copy's newest line is from ${hhmm(at)} (${title}). Anything written in this browser after the copy was not looked at.`
const AHEAD = (n, at) => `At ${hhmm(at)} her cloud held more bytes than this copy of ${n} ${n === 1 ? 'thread' : 'threads'}.`
// An open reads with no turn; each of its observations is said with its own read's time, to the second.
const hhmmss = ms => `${hhmm(ms)}:${String(new Date(ms).getSeconds()).padStart(2, '0')}`
const OPEN_COUNT = (n, m, at) => `At ${hhmmss(at)} her cloud showed ${n} of ${m} threads with the same content as this copy.`
const OPEN_AHEAD = (n, at) => `At ${hhmmss(at)} her cloud held more bytes than this copy of ${n} ${n === 1 ? 'thread' : 'threads'}.`
const OPEN_HOME = at => `At ${hhmmss(at)} her home files from this browser were in her vault, waiting for one answer from you.`
const CHANGE_LINE = ' Her cloud can change while it is being read; Join checks it again before it writes.'
const KEPT = titles => `Kept beside a different thread of the same name in her cloud, not joined into it: ${titles}.`
const NOT_JOINED = titles => `Not joined: ${titles}. Press Join again.`
const NOT_CONFIRMED_LINE = titles => `Join not confirmed for: ${titles}. Her cloud may hold them. Press Join again to check.`
const NOT_TRIED_LINE = titles => `Not tried in this press: ${titles}. Press Join again to continue.`
const UNCONFIRMED = 'not confirmed: sent, no answer said whether it was joined'
const UNCONFIRMED_READ = "What this Join did could not be confirmed: her cloud could not be read whole while this page held its turn. Press Join again to check."
const HELD_LINE = 'This Join stopped after 30 minutes, the longest one press may. Press Join again: it compares her cloud again and goes on with what is left.'
const LOST_LINE = 'This page lost its turn to write in her cloud. Press Join again.'
const NO_ANSWER_LINE = "This page's turn to write could not be confirmed: no answer came back from her edge. Nothing was sent to join. Press Join again."
const UNSURE_LINE = "This page's turn to write could not be confirmed: an answer from her edge was lost or did not say whether it was given. Nothing was sent to join. Press Join again."
const UNSURE_AGAIN_LINE = "This page's turn to write could not be confirmed again: an answer from her edge was lost or did not say whether it was given. Press Join again."
const NO_TURN_LINE = 'Her edge did not give this page its turn to write just now. Nothing was joined. Press Join again.'
const UNREAD_LINE = 'Her cloud could not be read just now. Press the button again.'
const leaseActions = (e, mark) => e.since(mark).filter(entry => entry.path === '/_mirror/lease').map(entry => JSON.parse(entry.body))
const importsOf = (e, mark) => e.since(mark).filter(entry => entry.path === '/_thread/import')
const sessionPath = k => `/dsh/home/sessions/agent/s${String(k).padStart(2, '0')}/session.v1.jsonl`
/** Every line a Join result can show: the headline, its lines, its rows. */
const allWords = result => [result.line, ...result.lines, ...result.rows.map(row => row.text)]

// ── MUSTs 3, 4, 5, 6 in one run: copy, join, the line, a second press, the check ────────────────────────────────────

test('copy, then join three journals (one new, one a byte prefix, one a fork): the line, a second press compares first, the check', async () => {
  const { e, idb } = await movedOn()
  const kit = kitOf(e, idb)
  const copied = await kit.copyToCloud()
  assert.equal(copied.complete, true, copied.line)
  const mark = e.log.length
  const lines = []
  const joined = await kit.joinThreads({ clientId: CLIENT, rescueId: copied.id, report: line => lines.push(line) })
  const end = e.log.length
  // One import per journal her cloud did not show with this copy's content, in index order, the next only after the answer.
  assert.deepEqual(e.imports.order.slice(-3), [C, A, B])
  assert.equal(e.imports.max, 1)
  assert.deepEqual(joined.rows.map(row => [row.title, row.outcome]), [['auma/session', 'kept beside'], ['agent/a', 'imported'], ['agent/b', 'extended']])
  assert.deepEqual(joined.rows.map(row => row.text), ['auma/session: kept beside', 'agent/a: imported', 'agent/b: extended'])
  const head = COUNT(2, 3, e.clock.t)
  assert.equal(joined.line, head)
  // A thread kept beside is not this copy's content: the press is not done, and the kept line says why.
  assert.equal(joined.done, false)
  assert.deepEqual(joined.lines, [head, NEWEST(T_B, 'agent/b'), KEPT('auma/session')])
  assert.equal((await kit.cloudState({ clientId: CLIENT, store: true })).line, OPEN_COUNT(2, 3, e.clock.t), 'a reload says the same count, with its own read\'s time')
  assert.ok(!JSON.stringify(joined).includes('only in this browser'))
  // The lease: acquired once with the store's own client id and a page id, each import carries it, released at the end.
  const leaseCalls = leaseActions(e, mark)
  assert.deepEqual(leaseCalls.map(call => call.action), ['acquire', 'release'])
  assert.equal(leaseCalls[0].clientId, CLIENT)
  assert.equal(leaseCalls[0].label, 'Rescue page')
  assert.match(leaseCalls[0].tabId, /^[A-Za-z0-9_-]{1,64}$/)
  assert.equal(leaseCalls[1].tabId, leaseCalls[0].tabId)
  const leaseHeaders = importsOf(e, mark).map(entry => entry.headers['x-thread-lease'])
  assert.equal(leaseHeaders.length, 3)
  assert.ok(leaseHeaders.every(value => /^[0-9a-f]{32}\.\d+$/.test(value) && value === leaseHeaders[0]))
  assert.equal(e.lease().holder, null, 'the lease is free at the end')
  // The final read of her index is made BEFORE the release, under the turn.
  const made = e.log.slice(mark, end).map(entry => entry.method + ' ' + entry.path + (entry.body && entry.path === '/_mirror/lease' ? ' ' + JSON.parse(entry.body).action : ''))
  assert.deepEqual(made.slice(-2), ['GET /_thread/index', 'POST /_mirror/lease release'])
  assert.equal((await e.thread(A)).bytes, A1.length)
  assert.equal((await e.thread(B)).bytes, B2.length)
  assert.equal((await e.thread(C)).bytes, C1.length)
  assert.equal((await e.thread(C)).keptCount, 1)

  // A second press: A and B show this copy's content in the start read, so only C is asked again (kept once).
  const second = e.log.length
  const again = await kit.joinThreads({ clientId: CLIENT, rescueId: copied.id })
  assert.deepEqual(again.rows.map(row => row.outcome), ['kept beside', 'same', 'same'])
  assert.deepEqual(importsOf(e, second).map(entry => JSON.parse(entry.body).path), [C])
  assert.equal(again.line, head)
  assert.equal((await e.thread(C)).keptCount, 1, 'the fork is kept once')
  assert.equal(e.lease().holder, null)

  // MUST 6: the longest thread checked from her cloud, piece by piece, against the rescue copy.
  const longest = again.rows.find(row => row.path === B)
  assert.ok(longest.id && longest.rescue)
  const checked = await kit.checkThread({ id: longest.id, title: longest.title, rescue: longest.rescue })
  assert.equal(checked.equal, true, checked.line)
  assert.equal(checked.line, `Read back from her cloud: ${B2.length} bytes, SHA-256 ${sha(B2)}, every piece equal.`)
  assert.ok(checked.lines.includes(`Equal to the rescue copy of ${hhmm(e.clock.t)}.`), JSON.stringify(checked.lines))
  const fork = again.rows.find(row => row.path === C)
  const forkCheck = await kit.checkThread({ id: fork.id, title: fork.title, rescue: fork.rescue })
  assert.equal(forkCheck.equal, false)
  assert.equal(forkCheck.line, `NOT equal to the rescue copy of ${hhmm(fork.rescue.verifiedAt ? Date.parse(fork.rescue.verifiedAt) : 0)}: her cloud holds ${C1.length} bytes, SHA-256 ${sha(C1)}; the copy holds ${C2.length} bytes, SHA-256 ${sha(C2)}.`)
  assert.ok(forkCheck.lines.includes(`Read back from her cloud: ${C1.length} bytes, SHA-256 ${sha(C1)}, every piece equal to its name.`))
})

test('the compared facts are her index\'s bytes, partCount, chain and tailSha, and the copy\'s piece names give the same four', async () => {
  const e = edge()
  // A: one sealed piece and an open end; B: exactly two whole pieces (no open end); C: under one piece.
  const two = journal(2 * PIECE, 'whole')
  const small = journal(900, 'small')
  const idb = seeded([[A, A1, T0], [B, two, T0], [C, small, T0]])
  const kit = kitOf(e, idb)
  const copied = await kit.copyToCloud()
  assert.equal(copied.complete, true, copied.line)
  assert.equal((await kit.joinThreads({ clientId: CLIENT, rescueId: copied.id })).done, true)
  const index = await (await e.fetch('/_thread/index?limit=200')).json()
  for (const path of [A, B, C]) {
    const row = index.threads.find(t => t.path === path)
    const stored = await e.thread(path)
    assert.deepEqual([row.bytes, row.partCount, row.chain, row.tailSha], [stored.bytes, stored.partCount, stored.chain, stored.tailSha])
    assert.match(row.chain, /^[0-9a-f]{64}$/)
    assert.match(row.tailSha, /^[0-9a-f]{64}$/)
  }
  assert.equal(index.threads.find(t => t.path === B).tailSha, sha(new Uint8Array(0)), 'no open end: the SHA-256 of no bytes')
  assert.equal(index.threads.find(t => t.path === C).tailSha, sha(small), 'all in the open end: its SHA-256 is the whole journal\'s')
  // The second press asks nothing: all three show this copy's content in the start read.
  const mark = e.log.length
  const again = await kit.joinThreads({ clientId: CLIENT, rescueId: copied.id })
  assert.equal(importsOf(e, mark).length, 0)
  assert.deepEqual(again.rows.map(row => row.outcome), ['same', 'same', 'same'])
  assert.equal(again.done, true)
})

test('main\'s client never reads her thread index (no caller under apps/ or packages/)', () => {
  const root = new URL('../../../../', import.meta.url)
  let found = ''
  try {
    found = execFileSync('git', ['-C', root.pathname, 'grep', '-l', '-e', '_thread/index', '--', 'apps', 'packages'], { encoding: 'utf8' })
  } catch (error) {
    // git grep exits 1 when nothing matches.
    if (error.status !== 1) throw error
  }
  assert.equal(found.trim(), '', found)
})

// ── MUST 3: the lease ──────────────────────────────────────────────────────────────────────────────────────────────

test('the lease is held by another browser: her words, nothing imported, that lease untouched', async () => {
  const { e, idb } = await movedOn()
  const kit = kitOf(e, idb)
  const copied = await kit.copyToCloud()
  const held = await leaseAction(e.mirror, { action: 'acquire', clientId: OTHER, tabId: 'mac', label: 'Chrome on the Mac' }, { now: e.clock.t })
  assert.equal(held.status, 200)
  const mark = e.log.length
  const joined = await kit.joinThreads({ clientId: CLIENT, rescueId: copied.id })
  assert.equal(joined.line, 'She is answering in Chrome on the Mac. Try again when she has finished.')
  assert.deepEqual(joined.lines, ['Her edge answered: WRITER_ELSEWHERE'])
  assert.equal(importsOf(e, mark).length, 0, 'nothing imported')
  assert.equal(e.lease().holder.clientId, OTHER)
  assert.equal(e.lease().leaseId, held.body.lease.leaseId)
  assert.equal((await e.thread(A)), null)
})

test('her edge grants the turn but every acquire answer is lost: the turn "could not be confirmed", no answer was received, never "her edge refused"', async () => {
  const { e, idb } = await movedOn()
  const kit = kitOf(e, idb)
  const copied = await kit.copyToCloud()
  e.hooks.after = entry => {
    if (entry.path === '/_mirror/lease' && JSON.parse(entry.body).action === 'acquire') throw new TypeError('the answer was lost')
  }
  const mark = e.log.length
  const joined = await kit.joinThreads({ clientId: CLIENT, rescueId: copied.id })
  assert.equal(joined.line, NO_ANSWER_LINE)
  assert.deepEqual(joined.lines, [])
  assert.ok(!allWords(joined).some(line => /answered|did not give/.test(line)), JSON.stringify(joined))
  assert.equal(leaseActions(e, mark).filter(call => call.action === 'acquire').length, 5)
  assert.equal(importsOf(e, mark).length, 0)
  assert.equal(e.lease().holder.clientId, CLIENT, 'her edge did grant it (it runs out by itself)')
})

test('acquire answers mixed, a 503 and grants whose answers were lost, in either order, or 503 THREAD_STORAGE_UNAVAILABLE: the turn "could not be confirmed", never "did not give"', async () => {
  const OSU = () => Response.json({ ok: false, code: 'OWNER_SESSION_UNAVAILABLE' }, { status: 503 })
  const TSU = () => Response.json({ ok: false, code: 'THREAD_STORAGE_UNAVAILABLE' }, { status: 503 })
  // Per acquire try (1 to 5): 'osu' / 'tsu' answered by the hook (nothing granted), 'lost' granted at her edge, answer lost.
  const cases = [['osu', 'lost', 'lost', 'lost', 'lost'], ['lost', 'osu', 'osu', 'osu', 'osu'], ['tsu', 'tsu', 'tsu', 'tsu', 'tsu']]
  for (const plan of cases) {
    const { e, idb } = await movedOn()
    const kit = kitOf(e, idb)
    const copied = await kit.copyToCloud()
    let tries = 0
    e.hooks.before = entry => {
      if (entry.path !== '/_mirror/lease' || JSON.parse(entry.body).action !== 'acquire') return undefined
      entry.plan = plan[tries++]
      return entry.plan === 'osu' ? OSU() : entry.plan === 'tsu' ? TSU() : undefined
    }
    e.hooks.after = entry => { if (entry.plan === 'lost') throw new TypeError('the answer was lost') }
    const mark = e.log.length
    const joined = await kit.joinThreads({ clientId: CLIENT, rescueId: copied.id })
    assert.equal(joined.line, UNSURE_LINE, plan.join(','))
    assert.deepEqual(joined.lines, [], plan.join(','))
    assert.ok(!allWords(joined).some(line => /answered|did not give/.test(line)), JSON.stringify(joined))
    assert.equal(leaseActions(e, mark).filter(call => call.action === 'acquire').length, 5)
    assert.equal(importsOf(e, mark).length, 0)
    if (plan.includes('lost')) assert.equal(e.lease().holder.label, 'Rescue page', 'her edge did grant it')
  }
  // Five plain busy answers prove nothing was given: that sentence stays.
  const { e, idb } = await movedOn()
  const kit = kitOf(e, idb)
  const copied = await kit.copyToCloud()
  e.hooks.before = entry => (entry.path === '/_mirror/lease' && JSON.parse(entry.body).action === 'acquire' ? OSU() : undefined)
  const joined = await kit.joinThreads({ clientId: CLIENT, rescueId: copied.id })
  assert.equal(joined.line, NO_TURN_LINE)
  assert.deepEqual(joined.lines, ['Her edge answered: OWNER_SESSION_UNAVAILABLE'])
})

test('mid-press, the renew answers 410, then a 503 and grants whose answers were lost: B "not tried", the turn "could not be confirmed again"', async () => {
  const e = edge()
  const idb = seeded([[A, A1, T0], [B, B1, T0]])
  const kit = kitOf(e, idb)
  const copied = await kit.copyToCloud()
  assert.equal(copied.complete, true, copied.line)
  const mark = e.log.length
  let acquires = 0
  e.hooks.before = entry => {
    if (entry.path === '/_thread/import') return undefined
    if (entry.path !== '/_mirror/lease' || JSON.parse(entry.body).action !== 'acquire') return undefined
    acquires += 1
    if (acquires === 2) return Response.json({ ok: false, code: 'OWNER_SESSION_UNAVAILABLE' }, { status: 503 })
    return undefined
  }
  e.hooks.after = entry => {
    if (entry.path === '/_thread/import') e.clock.t += 91000
    if (entry.path === '/_mirror/lease' && JSON.parse(entry.body).action === 'acquire' && acquires > 2) throw new TypeError('the answer was lost')
  }
  const joined = await kit.joinThreads({ clientId: CLIENT, rescueId: copied.id })
  assert.equal(joined.line, UNSURE_AGAIN_LINE)
  // Her edge gave a NEW lease to a lost try, so the release of the old one is not `released: true`: A is not confirmed.
  assert.deepEqual(joined.rows.map(row => row.text), ['agent/a: not confirmed: her edge answered imported; no later read of her cloud confirmed it', 'agent/b: not tried'])
  assert.equal(e.lease().holder.label, 'Rescue page', 'a lost try was granted')
  assert.ok(!allWords(joined).some(line => line.startsWith('Not joined') || line === LOST_LINE), JSON.stringify(joined))
  assert.deepEqual(leaseActions(e, mark).map(call => call.action), ['acquire', 'renew', 'acquire', 'acquire', 'acquire', 'acquire', 'acquire', 'release'])
  assert.equal(importsOf(e, mark).length, 1)
})

test('the tab closes after the first import (pagehide sends the release): a second page completes the join', async () => {
  const { e, idb } = await movedOn()
  const kit = kitOf(e, idb)
  const copied = await kit.copyToCloud()
  let dead = false
  const inner = e.fetch
  const closing = { ...e, fetch: async (input, init = {}) => {
    if (dead && init.keepalive !== true) throw new TypeError('the page is gone')
    const response = await inner(input, init)
    if (!dead && String(input) === '/_thread/import') { dead = true; closing.kit.leave() }
    return response
  } }
  closing.kit = kitOf(closing, idb)
  const first = await closing.kit.joinThreads({ clientId: CLIENT, rescueId: copied.id })
  assert.equal(first.rows[0].outcome, 'kept beside')
  // Sent and never answered is "not confirmed" (never counted joined, never refused).
  assert.deepEqual(first.rows.slice(1).map(row => row.text), ['agent/a: ' + UNCONFIRMED, 'agent/b: ' + UNCONFIRMED])
  assert.equal(first.done, false)
  assert.equal(first.line, UNCONFIRMED_READ)
  const releases = e.log.filter(entry => entry.path === '/_mirror/lease' && JSON.parse(entry.body).action === 'release')
  assert.equal(releases.at(-1).keepalive, true, 'the pagehide release is a keepalive request')
  await waitFor(() => releases.at(-1).status !== undefined, 'the pagehide release\'s answer')
  assert.equal(releases.at(-1).status, 200)
  assert.equal(e.lease().holder, null, 'the pagehide release freed the lease')
  const second = await kitOf(e, idb).joinThreads({ clientId: CLIENT, rescueId: copied.id })
  assert.deepEqual(second.rows.map(row => row.outcome), ['kept beside', 'imported', 'extended'])
  assert.equal(second.line, COUNT(2, 3, e.clock.t))
  assert.equal(e.lease().holder, null)
})

test('the tab closes with no pagehide: the lease runs out by itself and the next page completes', async () => {
  const { e, idb } = await movedOn()
  const kit = kitOf(e, idb)
  const copied = await kit.copyToCloud()
  let dead = false
  const inner = e.fetch
  const gone = { ...e, fetch: async (input, init = {}) => {
    if (dead) throw new TypeError('the page is gone')
    const response = await inner(input, init)
    if (String(input) === '/_thread/import') dead = true
    return response
  } }
  await kitOf(gone, idb).joinThreads({ clientId: CLIENT, rescueId: copied.id })
  assert.ok(e.lease().holder, 'the closed page still holds the lease')
  e.clock.t += 91000
  const next = await kitOf(e, idb).joinThreads({ clientId: CLIENT, rescueId: copied.id })
  assert.deepEqual(next.rows.map(row => row.outcome), ['kept beside', 'imported', 'extended'])
  assert.equal(e.lease().holder, null)
})

test('the lease is released on every path: a refused import, a sign-in that ended, a lease taken away mid-run', async () => {
  // A refused import (409): that thread is "not done: <code>", the others go on, the lease is free.
  {
    const { e, idb } = await movedOn()
    const kit = kitOf(e, idb)
    const copied = await kit.copyToCloud()
    e.hooks.before = entry => (entry.path === '/_thread/import' && JSON.parse(entry.body).path === A ? Response.json({ ok: false, code: 'PIECE_MISMATCH' }, { status: 409 }) : undefined)
    const joined = await kit.joinThreads({ clientId: CLIENT, rescueId: copied.id })
    assert.deepEqual(joined.rows.map(row => row.text), ['auma/session: kept beside', 'agent/a: not done: PIECE_MISMATCH', 'agent/b: extended'])
    assert.equal(joined.done, false)
    assert.equal(joined.line, NOT_JOINED('agent/a'))
    assert.deepEqual(joined.lines, [COUNT(1, 3, e.clock.t), NEWEST(T_B, 'agent/b'), KEPT('auma/session'), NOT_JOINED('agent/a')])
    assert.equal(e.lease().holder, null)
  }
  // 401 on an import: the sign-in line, nothing more imported, the release is still sent; the halt shows the same
  // outcome lines as any other path.
  {
    const { e, idb } = await movedOn()
    const kit = kitOf(e, idb)
    const copied = await kit.copyToCloud()
    e.hooks.before = entry => (entry.path === '/_thread/import' ? Response.json({ ok: false, code: 'OWNER_ACCESS_REQUIRED' }, { status: 401 }) : undefined)
    const mark = e.log.length
    const joined = await kit.joinThreads({ clientId: CLIENT, rescueId: copied.id })
    assert.equal(joined.line, 'Your sign-in ended. Sign in on this page and press Join again.')
    assert.equal(joined.signin, true)
    assert.equal(importsOf(e, mark).length, 1)
    assert.deepEqual(joined.rows.map(row => row.text), ['auma/session: not done: HTTP_401', 'agent/a: not tried', 'agent/b: not tried'])
    assert.deepEqual(joined.lines, [NOT_JOINED('auma/session'), NOT_TRIED_LINE('agent/a, agent/b')])
    assert.equal(e.lease().holder, null)
  }
  // The lease taken by another browser with his approval mid-run: 423 stops the run in her words; the final read
  // cannot be confirmed (the turn was not this page's at the release), so nothing is said joined.
  {
    const { e, idb } = await movedOn()
    const kit = kitOf(e, idb)
    const copied = await kit.copyToCloud()
    let taken = false
    e.hooks.before = async entry => {
      if (entry.path === '/_thread/import' && !taken && JSON.parse(entry.body).path === A) {
        taken = true
        await leaseAction(e.mirror, { action: 'take', clientId: OTHER, tabId: 'phone', label: 'Safari on his phone' }, { now: e.clock.t, ownerApproved: true })
      }
      return undefined
    }
    const joined = await kit.joinThreads({ clientId: CLIENT, rescueId: copied.id })
    assert.equal(joined.line, 'She is answering in Safari on his phone. Try again when she has finished.')
    assert.deepEqual(joined.rows.map(row => row.outcome), ['kept beside', 'not done: WRITER_ELSEWHERE', 'not tried'])
    assert.deepEqual(joined.lines, [UNCONFIRMED_READ, KEPT('auma/session'), NOT_JOINED('agent/a'), NOT_TRIED_LINE('agent/b')])
    assert.equal(joined.done, false)
    assert.equal(e.lease().holder.clientId, OTHER, "his phone's lease is not touched by this page's release")
  }
})

test('409 CLIENT_SLOT_RETIRED on the lease: the edge\'s own sentence, nothing imported', async () => {
  const { e, idb } = await movedOn()
  const kit = kitOf(e, idb)
  const copied = await kit.copyToCloud()
  const reply = retiredReply({ clientId: CLIENT, state: 'retired', retiredAt: Date.UTC(2026, 9, 1), seq: 4, base: { lineageId: 'L1', revision: 7 }, lastSeenAt: 1, resurrectedAt: null }, 'lease')
  const { status, ...body } = reply
  e.hooks.before = entry => (entry.path === '/_mirror/lease' && JSON.parse(entry.body).action === 'acquire' ? Response.json(body, { status }) : undefined)
  const mark = e.log.length
  const joined = await kit.joinThreads({ clientId: CLIENT, rescueId: copied.id })
  assert.equal(joined.line, body.message)
  assert.equal(importsOf(e, mark).length, 0)
})

// ── MUST 4: waits, and nothing silent ──────────────────────────────────────────────────────────────────────────────

test('503 IMPORT_BUSY, THREAD_MOVED, SEAL_PENDING, OWNER_SESSION_UNAVAILABLE: wait retry-after and try again, five times at most', async () => {
  const { e, idb } = await movedOn()
  const kit = kitOf(e, idb)
  const copied = await kit.copyToCloud()
  const busy = { [A]: ['IMPORT_BUSY', 'THREAD_MOVED', 'SEAL_PENDING', 'OWNER_SESSION_UNAVAILABLE'], [B]: Array(9).fill('IMPORT_BUSY') }
  e.hooks.before = entry => {
    if (entry.path !== '/_thread/import') return undefined
    const left = busy[JSON.parse(entry.body).path]
    if (!left || left.length === 0) return undefined
    return Response.json({ ok: false, code: left.shift() }, { status: 503, headers: { 'retry-after': '2' } })
  }
  const joined = await kit.joinThreads({ clientId: CLIENT, rescueId: copied.id })
  assert.deepEqual(joined.rows.map(row => row.outcome), ['kept beside', 'imported', 'not done: IMPORT_BUSY'])
  assert.deepEqual(kit.sleeps, Array(9).fill(2000), 'four waits for A, five for B, each the retry-after')
  assert.equal(e.lease().holder, null)
  // Pressing Join again: A shows this copy's content (no import), B is extended.
  e.hooks.before = null
  const again = await kit.joinThreads({ clientId: CLIENT, rescueId: copied.id })
  assert.deepEqual(again.rows.map(row => row.outcome), ['kept beside', 'same', 'extended'])
})

test('one join of 17 threads: the requests, counted', async () => {
  const e = edge()
  const journals = Array.from({ length: 17 }, (_, n) => [`/dsh/home/sessions/agent/s${String(n).padStart(2, '0')}/session.v1.jsonl`, journal(PIECE + 97 * n + 11, 's' + n), T0 + n])
  const idb = seeded(journals)
  const kit = kitOf(e, idb)
  const copied = await kit.copyToCloud()
  assert.equal(copied.complete, true, copied.line)
  const mark = e.log.length
  const joined = await kit.joinThreads({ clientId: CLIENT, rescueId: copied.id })
  const made = e.since(mark).map(entry => entry.method + ' ' + entry.path)
  const count = name => made.filter(entry => entry === name).length
  assert.equal(count('GET /_vault/rescue'), 1)
  assert.equal(made.filter(entry => entry.startsWith('GET /_vault/rescue/')).length, 1)
  assert.equal(count('POST /_mirror/lease'), 2)
  assert.equal(count('POST /_thread/import'), 17)
  // One read of her thread index at the start (what each journal is compared with) and one at the end, before the release.
  assert.equal(count('GET /_thread/index'), 2)
  assert.equal(made.length, 23, made.join('\n'))
  assert.equal(joined.line, COUNT(17, 17, e.clock.t))
  assert.equal(joined.done, true)
})

// ── MUST 5: the line on any signed-in open, and the home line ──────────────────────────────────────────────────────

test('the state line on an open: in the copied browser, on a phone with no store, and the home line', async () => {
  const { e, idb } = await movedOn()
  const kit = kitOf(e, idb)
  const copied = await kit.copyToCloud()
  await kit.joinThreads({ clientId: CLIENT, rescueId: copied.id })
  const mark = e.log.length
  const here = await kit.cloudState({ clientId: CLIENT, store: true })
  assert.ok(e.since(mark).every(entry => entry.method === 'GET'), 'an open only reads')
  assert.equal(here.line, OPEN_COUNT(2, 3, e.clock.t))
  assert.deepEqual(here.lines, [NEWEST(T_B, 'agent/b')])
  assert.equal(here.ownVerified, true)
  const now = hhmmss(e.clock.t)
  assert.deepEqual(here.rows.map(row => row.text), [`auma/session: ${C1.length} bytes in her cloud at ${now}, ${C2.length} in the copy`,
    `agent/a: ${A1.length} bytes at ${now}, the same content as the copy`, `agent/b: ${B2.length} bytes at ${now}, the same content as the copy`])
  assert.deepEqual(here.rows.map(row => row.seenAt), [e.clock.t, e.clock.t, e.clock.t], 'each row keeps its read\'s time')
  const phoneIdb = new FakeIndexedDb()
  const phone = kitOf(e, phoneIdb)
  const client = await phone.readClient()
  assert.deepEqual(client, { store: false, clientId: null })
  const there = await phone.cloudState({ clientId: client.clientId, store: client.store })
  assert.equal(there.line, here.line)
  assert.deepEqual(there.lines, [])
  assert.equal(there.ownVerified, false)
  assert.deepEqual(phoneIdb.log.opens, [], 'a phone with no store of hers: her database is never opened')
  const inner = e.fetch
  const pending = { ...e, fetch: async (input, init) => {
    const response = await inner(input, init)
    if (!String(input).startsWith('/_thread/index')) return response
    const body = await response.json()
    return Response.json({ ...body, home: { pending: true, rescue: copied.id, freeze: 'record' } }, { status: response.status })
  } }
  const withHome = await kitOf(pending, idb).cloudState({ clientId: CLIENT, store: true })
  assert.equal(withHome.lines.at(-1), OPEN_HOME(e.clock.t))
  const phoneHome = await kitOf(pending, new FakeIndexedDb()).cloudState({ clientId: null, store: false })
  assert.ok(!phoneHome.lines.some(line => line.startsWith('Her home files')))
})


// ── MUST 6: check from her cloud, in a browser with no store ───────────────────────────────────────────────────────

/** gc without a command-line flag (as rescue-vault-join and vault-hold do). */
function collector() {
  if (typeof globalThis.gc === 'function') return globalThis.gc
  v8.setFlagsFromString('--expose-gc')
  return vm.runInNewContext('gc')
}

/** A thread of `pieces` sealed pieces plus an open end, put in her cloud through the real vault and the real import. */
async function cloudThread(e, path, bytes) {
  const { index, indexBytes, id, pieces } = await buildRescue({ piece: e.piece, rows: [{ key: path, type: 'file', bytes }], clientId: CLIENT })
  for (const [name, part] of pieces) assert.ok([200, 201].includes((await e.fetch('/_vault/blob/' + name, { method: 'PUT', body: part })).status))
  assert.ok([200, 201].includes((await e.fetch('/_vault/rescue/' + id, { method: 'PUT', body: new TextDecoder().decode(indexBytes) })).status))
  let cursor = 0
  for (;;) {
    const answer = await (await e.fetch(`/_vault/rescue/${id}/verify?cursor=${cursor}`, { method: 'POST' })).json()
    if (answer.done) break
    cursor = answer.cursor
  }
  const lease = (await leaseAction(e.mirror, { action: 'acquire', clientId: CLIENT, tabId: 'seed', label: 'seed' }, { now: e.clock.t })).body.lease
  const imported = await (await e.fetch('/_thread/import', { method: 'POST', body: JSON.stringify({ path, rescue: id }), headers: { 'content-type': 'application/json', 'x-thread-lease': lease.leaseId + '.' + lease.generation } })).json()
  assert.equal(imported.outcome, 'imported', JSON.stringify(imported))
  await leaseAction(e.mirror, { action: 'release', clientId: CLIENT, tabId: 'seed', label: 'seed', leaseId: lease.leaseId }, { now: e.clock.t })
  return { id: await threadIdForPath(path), rescueId: id, index }
}

test('check from her cloud on a phone: a 48-piece thread, one piece in memory at a time, nothing stored', async () => {
  const PROTOCOL_PIECE = 2097152
  const e = edge({ piece: PROTOCOL_PIECE })
  const bytes = journal(48 * PROTOCOL_PIECE + 70000, 'long')
  const wholeSha = sha(bytes)
  const made = await cloudThread(e, B, bytes)
  const stored = await e.thread(B)
  assert.equal(stored.partCount, 48)
  const size = bytes.length
  const gc = collector()
  const idb = new FakeIndexedDb()
  const sample = () => { const m = process.memoryUsage(); return m.heapUsed + m.arrayBuffers }
  gc(); gc()
  const before = sample()
  let peak = before
  const watched = { fetch: async (input, init) => { const response = await e.fetch(input, init); peak = Math.max(peak, sample()); return response } }
  const watchedKit = rescueKit({ indexedDB: idb, localStorage: null, fetch: watched.fetch, sleep: async () => {} })
  const checked = await watchedKit.checkThread({ id: made.id, title: 'agent/b', rescue: { bytes: size, sha256: wholeSha, verifiedAt: new Date(e.clock.t).toISOString() } })
  gc(); gc()
  const after = sample()
  assert.equal(checked.line, `Read back from her cloud: ${size} bytes, SHA-256 ${wholeSha}, every piece equal.`)
  assert.equal(checked.equal, true)
  const growth = after - before
  console.log(`Check of a 48-piece thread (${size} bytes): heap+arrayBuffers growth after gc ${(growth / 1048576).toFixed(2)} MiB; peak above start ${((peak - before) / 1048576).toFixed(2)} MiB`)
  assert.ok(growth < 16 * 1048576, `growth ${growth}`)
  // One blob GET per sealed piece, one at a time, and nothing written anywhere.
  const blobGets = e.log.filter(entry => entry.method === 'GET' && entry.path.startsWith('/_vault/blob/'))
  assert.equal(blobGets.length, 48)
  assert.ok(e.log.every(entry => !(entry.method !== 'GET' && entry.path.startsWith('/_thread/')) || entry.path === '/_thread/import'))
  assert.deepEqual(idb.log.opens, [])
})

test('one flipped byte in a piece, in the chain, or in the open end is caught and named', async () => {
  const bytes = journal(5 * PIECE + 900, 'flip')
  const fresh = async () => { const e = edge(); const made = await cloudThread(e, B, bytes); return { e, made } }
  const phone = e => rescueKit({ indexedDB: new FakeIndexedDb(), localStorage: null, fetch: e.fetch, piece: PIECE, sleep: async () => {} })
  {
    const { e, made } = await fresh()
    const ok = await phone(e).checkThread({ id: made.id })
    assert.equal(ok.equal, true, ok.line)
    const hash = made.index.rows[0].pieces[2]
    e.bucket.objects.get(`w/${WORLD}/blob/${hash}`).bytes[17] ^= 0x01
    const piece = await phone(e).checkThread({ id: made.id })
    assert.equal(piece.equal, false)
    assert.equal(piece.line, `NOT equal in her cloud: piece 3 of 5 (bytes ${2 * PIECE} to ${3 * PIECE}) does not hash to its name.`)
  }
  {
    const { e, made } = await fresh()
    await e.mirror.transaction(async tx => {
      const row = await tx.get('thread:v1:index:' + made.id)
      await tx.put('thread:v1:index:' + made.id, { ...row, chain: (row.chain[0] === 'a' ? 'b' : 'a') + row.chain.slice(1) })
    })
    const chain = await phone(e).checkThread({ id: made.id })
    assert.equal(chain.equal, false)
    assert.equal(chain.line, 'NOT equal in her cloud: the chain of its 5 pieces does not match its list.')
  }
  {
    const { e, made } = await fresh()
    await e.mirror.transaction(async tx => {
      const rows = await tx.list({ prefix: `thread:v1:tail:${made.id}:` })
      const [key, value] = [...rows][1]
      const flipped = Uint8Array.from(value)
      flipped[3] ^= 0x01
      await tx.put(key, flipped)
    })
    const open = await phone(e).checkThread({ id: made.id })
    assert.equal(open.equal, false)
    assert.equal(open.line, `NOT equal in her cloud: the open end (bytes ${5 * PIECE} to ${bytes.length}) does not match its SHA-256.`)
  }
})


// ── MUSTs 1, 2 and 5 on the page itself ────────────────────────────────────────────────────────────────────────────

/** The page script, run as a browser would, with a fake document over this edge and store. */
function pageOn(e, idb) {
  const elements = new Map()
  const element = id => ({ id, hidden: false, disabled: false, textContent: '', children: [], listeners: {}, href: '', download: '', type: '',
    get firstChild() { return this.children[0] ?? null }, addEventListener(type, listener) { this.listeners[type] = listener },
    appendChild(child) { this.children.push(child) }, removeChild(child) { this.children.splice(this.children.indexOf(child), 1) },
    click() { this.clicked = true }, remove() {} })
  const ids = ['rescue-cloud', 'rescue-local', 'rescue-join', 'rescue-status', 'rescue-detail', 'rescue-left', 'rescue-left-list', 'rescue-signin',
    'rescue-state', 'rescue-threads']
  for (const id of ids) elements.set(id, element(id))
  for (const id of ['rescue-left', 'rescue-signin', 'rescue-join']) elements.get(id).hidden = true
  elements.get('rescue-join').disabled = true
  const listeners = {}
  const assigned = []
  runInNewContext(RESCUE_PAGE.script, {
    document: { getElementById: id => elements.get(id), createElement: tag => element(tag), body: element('body') },
    location: { assign: target => assigned.push(target) }, crypto, TextEncoder, TextDecoder, Blob, AbortController, setTimeout, clearTimeout,
    URL: { createObjectURL: () => 'blob:rescue', revokeObjectURL() {} }, fetch: e.fetch, indexedDB: idb, localStorage: null,
    addEventListener: (type, listener) => { listeners[type] = listener },
  })
  const get = id => elements.get(id)
  const texts = id => get(id).children.filter(child => typeof child.textContent === 'string' && child.textContent !== '' && !child.listeners.click).map(child => child.textContent)
  const until = (fn, what) => waitFor(fn, 'waited for ' + what)
  return { elements, get, texts, until, listeners, assigned, checks: () => get('rescue-threads').children.filter(child => child.listeners.click) }
}

test('the page: the words before the button; an open only reads; Join appears only for a store of hers with a checked copy', async () => {
  const wait = '<p id="rescue-wait">Wait until she has finished answering. Leave this tab in front. This takes a few minutes.</p>'
  assert.ok(RESCUE_PAGE.html.includes(wait + '<button id="rescue-cloud"'), 'the words sit right above the button')
  assert.match(RESCUE_PAGE.html, /<button id="rescue-join" type="button" hidden disabled>Join her threads in her cloud<\/button>/)
  assert.doesNotMatch(RESCUE_PAGE.html, /t[o]ken/i)

  const e = edge({ piece: 2097152 })
  const idb = seeded([[A, A1, T0], [B, B1, T_B]])
  const fresh = pageOn(e, idb)
  await fresh.until(() => fresh.get('rescue-state').children.length > 0, 'the state lines')
  assert.ok(e.log.length > 0 && e.log.every(entry => entry.method === 'GET'), e.log.map(entry => entry.method + ' ' + entry.path).join(','))
  assert.equal(e.log.filter(entry => entry.method === 'PUT' || entry.method === 'POST').length, 0)
  assert.equal(idb.writableTransactions().length, 0)
  assert.equal(fresh.get('rescue-join').hidden, false)
  assert.equal(fresh.get('rescue-join').disabled, true)
  assert.equal(typeof fresh.listeners.pagehide, 'function', 'pagehide releases the lease')

  fresh.get('rescue-cloud').listeners.click()
  await fresh.until(() => /^Rescue copy complete and checked/.test(fresh.get('rescue-status').textContent), 'the copy')
  await fresh.until(() => fresh.get('rescue-join').disabled === false, 'Join enabled')
  fresh.get('rescue-join').listeners.click()
  await fresh.until(() => /^At \d\d:\d\d her cloud showed /.test(fresh.get('rescue-status').textContent), 'the join')
  // The page runs on the browser's own clock: the time is any HH:MM.
  const PAGE_COUNT = /^At \d\d:\d\d her cloud showed 2 of 2 threads with the same content as this copy\.$/
  // An open's one-page read, to the second.
  const OPEN_PAGE_COUNT = /^At \d\d:\d\d:\d\d her cloud showed 2 of 2 threads with the same content as this copy\.$/
  assert.match(fresh.get('rescue-status').textContent, PAGE_COUNT)
  assert.deepEqual(fresh.texts('rescue-threads'), ['agent/a: imported', 'agent/b: imported'])
  assert.equal(fresh.checks().length, 2, 'one Check button a thread')
  assert.equal(e.lease().holder, null)

  const mark = e.log.length
  const second = pageOn(e, idb)
  await second.until(() => second.get('rescue-join').disabled === false, 'Join enabled on open')
  await second.until(() => second.texts('rescue-state').length > 0, 'state')
  assert.ok(e.since(mark).every(entry => entry.method === 'GET'))
  assert.equal(second.texts('rescue-state').length, 2)
  assert.match(second.texts('rescue-state')[0], OPEN_PAGE_COUNT)
  assert.equal(second.texts('rescue-state')[1], NEWEST(T_B, 'agent/b'))
  second.checks()[1].listeners.click()
  await second.until(() => /^Read back from her cloud/.test(second.get('rescue-status').textContent), 'the check')
  assert.equal(second.get('rescue-status').textContent, `Read back from her cloud: ${B1.length} bytes, SHA-256 ${sha(B1)}, every piece equal.`)

  const phoneIdb = new FakeIndexedDb()
  const phone = pageOn(e, phoneIdb)
  await phone.until(() => phone.texts('rescue-state').length > 0, 'state on a phone')
  assert.equal(phone.get('rescue-join').hidden, true)
  assert.equal(phone.texts('rescue-state').length, 1)
  assert.match(phone.texts('rescue-state')[0], OPEN_PAGE_COUNT)
  assert.equal(phone.checks().length, 2)
  assert.deepEqual(phoneIdb.log.opens, [])

  const bare = new FakeIndexedDb()
  bare.seed(DB, storeEntries([[A, A1, T0]], null))
  const nameless = pageOn(e, bare)
  await nameless.until(() => nameless.texts('rescue-state').length > 0, 'state')
  assert.equal(nameless.get('rescue-join').hidden, true)
  assert.deepEqual([fresh, second, phone, nameless].flatMap(page => page.assigned), [], 'nothing navigates anywhere')
})

test('a Join that halts (the sign-in ended) shows the same outcome lines on the page as any other path', async () => {
  const e = edge({ piece: 2097152 })
  const idb = seeded([[A, A1, T0], [B, B1, T_B]])
  const page = pageOn(e, idb)
  await page.until(() => page.get('rescue-state').children.length > 0, 'the state lines')
  page.get('rescue-cloud').listeners.click()
  await page.until(() => /^Rescue copy complete and checked/.test(page.get('rescue-status').textContent), 'the copy')
  await page.until(() => page.get('rescue-join').disabled === false, 'Join enabled')
  e.hooks.before = entry => (entry.path === '/_thread/import' ? Response.json({ ok: false, code: 'OWNER_ACCESS_REQUIRED' }, { status: 401 }) : undefined)
  page.get('rescue-join').listeners.click()
  await page.until(() => page.get('rescue-status').textContent === 'Your sign-in ended. Sign in on this page and press Join again.', 'the halt')
  await page.until(() => page.get('rescue-join').disabled === false, 'the press ended')
  assert.deepEqual(page.texts('rescue-state'), [NOT_JOINED('agent/a'), NOT_TRIED_LINE('agent/b')])
  assert.deepEqual(page.texts('rescue-threads'), ['agent/a: not done: HTTP_401', 'agent/b: not tried'])
  assert.equal(page.get('rescue-signin').hidden, false)
})

// ── Review follow-up ──────────────────────────────────────────────────────────────────────

test('a journal of 0 bytes in the copy: never sent to import, counted, so the join reaches N of N', async () => {
  const e = edge()
  const idb = seeded([[A, A1, T0], [B, new Uint8Array(0), T_B]])
  const kit = kitOf(e, idb)
  const copied = await kit.copyToCloud()
  assert.equal(copied.complete, true, copied.line)
  const mark = e.log.length
  const joined = await kit.joinThreads({ clientId: CLIENT, rescueId: copied.id })
  assert.deepEqual(joined.rows.map(row => row.text), ['agent/a: imported', 'agent/b: empty, nothing to join'])
  assert.deepEqual(importsOf(e, mark).map(entry => JSON.parse(entry.body).path), [A])
  const head = COUNT(2, 2, e.clock.t)
  assert.equal(joined.line, head)
  assert.equal(joined.done, true)
  // An empty journal has no line, so the copy's newest line is A's.
  assert.deepEqual(joined.lines, [NEWEST(T0, 'agent/a')])
  const again = await kit.joinThreads({ clientId: CLIENT, rescueId: copied.id })
  assert.deepEqual(again.rows.map(row => row.outcome), ['same', 'empty, nothing to join'])
  assert.equal(again.line, head)
  const open = await kit.cloudState({ clientId: CLIENT, store: true })
  assert.equal(open.line, OPEN_COUNT(2, 2, e.clock.t))
  assert.deepEqual(open.rows.map(row => row.text), [`agent/a: ${A1.length} bytes at ${hhmmss(e.clock.t)}, the same content as the copy`, 'agent/b: empty, nothing to join'])
  assert.equal(e.lease().holder, null)
})

test('a different journal of the SAME length is never "same": it is sent, kept beside, counted 0 of 1 on the join and on a reload; Check says NOT equal', async () => {
  const e = edge()
  const first8292 = journal(8292, 'first')
  const fork = journal(8292, 'fork')
  assert.equal(first8292.length, 8292)
  assert.notEqual(sha(first8292), sha(fork))
  const idb = seeded([[A, first8292, T0]])
  const kit = kitOf(e, idb)
  const first = await kit.copyToCloud()
  const one = await kit.joinThreads({ clientId: CLIENT, rescueId: first.id })
  assert.equal(one.line, COUNT(1, 1, e.clock.t))
  e.clock.t += 60000
  reseed(idb, [[A, fork, T0 + 60000]])
  const copied = await kit.copyToCloud()
  assert.equal(copied.complete, true, copied.line)
  const mark = e.log.length
  const joined = await kit.joinThreads({ clientId: CLIENT, rescueId: copied.id })
  assert.equal(importsOf(e, mark).length, 1, 'equal byte counts alone never skip the import')
  assert.deepEqual(joined.rows.map(row => row.text), ['agent/a: kept beside'])
  assert.equal(joined.line, COUNT(0, 1, e.clock.t))
  assert.equal(joined.equal, 0)
  assert.equal(joined.done, false)
  assert.ok(joined.lines.includes(KEPT('agent/a')), JSON.stringify(joined.lines))
  const open = await kit.cloudState({ clientId: CLIENT, store: true })
  assert.equal(open.line, OPEN_COUNT(0, 1, e.clock.t), 'the join and the reload say the same count')
  assert.equal(open.equal, 0)
  assert.deepEqual(open.rows.map(row => row.text), [`agent/a: 8292 bytes in her cloud at ${hhmmss(e.clock.t)}, the same count as the copy but not shown to be the same content`])
  const row = open.rows[0]
  const checked = await kit.checkThread({ id: row.id, title: row.title, rescue: row.rescue })
  assert.equal(checked.equal, false)
  assert.ok(checked.line.includes(sha(first8292)) && checked.line.includes(sha(fork)))
})

test('a join whose final index read cannot be read says it could not be confirmed: never "Joined.", never a joined row', async () => {
  const e = edge()
  const idb = seeded([[A, A1, T0], [B, B1, T0]])
  const kit = kitOf(e, idb)
  const copied = await kit.copyToCloud()
  assert.equal(copied.complete, true, copied.line)
  let reads = 0
  e.hooks.before = entry => {
    if (entry.path === '/_thread/import' && JSON.parse(entry.body).path === A) return Response.json({ ok: false, code: 'IMPORT_NOT_PREFIX' }, { status: 409 })
    // The start read (one page) is answered; the FINAL read is the one that cannot be read.
    if (entry.path === '/_thread/index' && ++reads > 1) return Response.json({ ok: false, code: 'NOT_FOUND' }, { status: 404 })
    return undefined
  }
  const joined = await kit.joinThreads({ clientId: CLIENT, rescueId: copied.id })
  assert.deepEqual(joined.rows.map(row => row.text), ['agent/a: not done: IMPORT_NOT_PREFIX',
    'agent/b: not confirmed: her edge answered imported; no later read of her cloud confirmed it'])
  assert.equal(joined.done, false)
  assert.equal(joined.line, UNCONFIRMED_READ)
  assert.deepEqual(joined.lines, [NOT_JOINED('agent/a'), NOT_CONFIRMED_LINE('agent/b')])
  assert.ok(!allWords(joined).some(line => line.startsWith('Joined')), JSON.stringify(joined))
})

test('only a divergent journal, kept beside, then the final index answers 404: the kept line stays, never "Joined."', async () => {
  const e = edge()
  const idb = seeded([[A, A1, T0]])
  const kit = kitOf(e, idb)
  await kit.joinThreads({ clientId: CLIENT, rescueId: (await kit.copyToCloud()).id })
  e.clock.t += 60000
  reseed(idb, [[A, journal(A1.length + 10, 'other'), T0 + 60000]])
  const copied = await kit.copyToCloud()
  assert.equal(copied.complete, true, copied.line)
  let reads = 0
  e.hooks.before = entry => (entry.path === '/_thread/index' && ++reads > 1 ? Response.json({ ok: false, code: 'NOT_FOUND' }, { status: 404 }) : undefined)
  const joined = await kit.joinThreads({ clientId: CLIENT, rescueId: copied.id })
  assert.deepEqual(joined.rows.map(row => row.text), ['agent/a: kept beside'])
  assert.equal(joined.line, UNCONFIRMED_READ)
  assert.deepEqual(joined.lines, [KEPT('agent/a')])
  assert.equal(joined.done, false)
  assert.ok(!allWords(joined).some(line => line.startsWith('Joined')), JSON.stringify(joined))
})

test('her cloud holds more than this copy: the row says so with its time, and the page never asks for a Copy that cannot help', async () => {
  const e = edge()
  const idb = seeded([[A, A1, T0]])
  const kit = kitOf(e, idb)
  const first = await kit.copyToCloud()
  await kit.joinThreads({ clientId: CLIENT, rescueId: first.id })
  e.clock.t += 60000
  reseed(idb, [[A, A1.subarray(0, PIECE + 18), T0]])
  const copied = await kit.copyToCloud()
  assert.equal(copied.complete, true, copied.line)
  const mark = e.log.length
  const joined = await kit.joinThreads({ clientId: CLIENT, rescueId: copied.id })
  // More bytes cannot be judged from her index alone: one import proves the copy is a prefix.
  assert.equal(importsOf(e, mark).length, 1)
  assert.deepEqual(joined.rows.map(row => row.text), [`agent/a: same (her cloud held more than this copy at ${hhmm(e.clock.t)})`])
  assert.equal(joined.done, true, 'her cloud holding more, proved and said as such')
  assert.equal(joined.line, COUNT(0, 1, e.clock.t))
  assert.deepEqual(joined.lines, [NEWEST(T0, 'agent/a'), AHEAD(1, e.clock.t)])
  const open = await kit.cloudState({ clientId: CLIENT, store: true })
  assert.deepEqual(open.rows.map(row => row.text), [`agent/a: ${A1.length} bytes in her cloud at ${hhmmss(e.clock.t)}, more than the ${PIECE + 18} in this copy`])
  assert.deepEqual(open.lines, [NEWEST(T0, 'agent/a'), OPEN_AHEAD(1, e.clock.t)])
  assert.ok(!JSON.stringify(open).includes('Press Copy'))
})

test('an open waits out a busy edge as a copy does, and a cloud it cannot read says "Reload this page"', async () => {
  const { e, idb } = await movedOn()
  const kit = kitOf(e, idb)
  const copied = await kit.copyToCloud()
  await kit.joinThreads({ clientId: CLIENT, rescueId: copied.id })
  let busy = 1
  e.hooks.before = entry => (entry.method === 'GET' && entry.path === '/_vault/rescue' && busy-- > 0
    ? Response.json({ ok: false, code: 'OWNER_SESSION_UNAVAILABLE' }, { status: 503, headers: { 'retry-after': '1' } }) : undefined)
  const open = await kit.cloudState({ clientId: CLIENT, store: true })
  assert.equal(open.ok, true, open.line)
  assert.equal(open.ownVerified, true)
  assert.equal(open.line, OPEN_COUNT(2, 3, e.clock.t))
  e.hooks.before = entry => (entry.path === '/_thread/index' ? Response.json({ ok: false, code: 'BROKEN' }, { status: 500 }) : undefined)
  const down = await kit.cloudState({ clientId: CLIENT, store: true })
  assert.equal(down.ok, false)
  assert.equal(down.line, 'Her cloud could not be read just now. Reload this page to read it again.')
})

test('the acquire is granted but its answer is lost: asked again (her edge gives the same lease), the join runs and releases', async () => {
  const { e, idb } = await movedOn()
  const kit = kitOf(e, idb)
  const copied = await kit.copyToCloud()
  let lost = 0
  e.hooks.after = entry => {
    if (entry.path === '/_mirror/lease' && JSON.parse(entry.body).action === 'acquire' && lost++ === 0) throw new TypeError('the answer was lost')
  }
  const joined = await kit.joinThreads({ clientId: CLIENT, rescueId: copied.id })
  assert.deepEqual(joined.rows.map(row => row.outcome), ['kept beside', 'imported', 'extended'])
  assert.equal(lost, 2, 'asked twice')
  assert.equal(e.lease().holder, null, 'the lease is free at the end')
})

test('check from her cloud: a thread listed by ANOTHER verified rescue gets its Equal line too', async () => {
  const e = edge()
  const mac = seeded([[A, A1, T0]])
  const macKit = kitOf(e, mac)
  const macCopy = await macKit.copyToCloud()
  assert.equal(macCopy.complete, true, macCopy.line)
  await macKit.joinThreads({ clientId: CLIENT, rescueId: macCopy.id })
  e.clock.t += 60000
  const other = new FakeIndexedDb()
  other.seed(DB, storeEntries([[B, B1, T_B]], OTHER))
  const otherKit = kitOf(e, other)
  const otherCopy = await otherKit.copyToCloud()
  assert.equal(otherCopy.complete, true, otherCopy.line)
  await otherKit.joinThreads({ clientId: OTHER, rescueId: otherCopy.id })
  // A phone: the page compares with the newest copy (the other browser's), so A's row carries no copy of its own.
  const phone = kitOf(e, new FakeIndexedDb())
  const state = await phone.cloudState({ clientId: null, store: false })
  const row = state.rows.find(entry => entry.path === A)
  assert.equal(row.rescue, null)
  const checked = await phone.checkThread({ id: row.id, title: row.title, path: row.path, rescue: row.rescue })
  assert.equal(checked.equal, true, checked.line)
  assert.ok(checked.lines.includes(`Equal to the rescue copy of ${hhmm(T0)}.`), JSON.stringify(checked.lines))
})

test('an open end that starts with a line longer than 256 KiB: "Not checked", and its sealed pieces are named equal', async () => {
  const PROTOCOL_PIECE = 2097152
  const e = edge({ piece: PROTOCOL_PIECE })
  const long = enc.encode('{"x":"' + 'a'.repeat(300000 - 9) + '"}\n')
  assert.equal(long.length, 300000)
  const bytes = join2(join2(journal(PROTOCOL_PIECE, 'p'), long), journal(5000, 'z'))
  const made = await cloudThread(e, B, bytes)
  const phone = rescueKit({ indexedDB: new FakeIndexedDb(), localStorage: null, fetch: e.fetch, sleep: async () => {} })
  const checked = await phone.checkThread({ id: made.id })
  assert.equal(checked.line, 'Not checked: the open end of this thread holds a line longer than this page can read back (256 KiB).')
  assert.equal(checked.equal, false)
  assert.deepEqual(checked.lines, ['Its 1 sealed pieces are equal.'])
})

// ── MUST 2 (never "equal" from a count) and the SHOULD (a run is done only when every thread is) ─────────

/** The reviewer's sequence: copy A and join it; a different copy B of the SAME length, copied and joined (kept beside). */
async function sameLengthCopies() {
  const e = edge()
  const first = journal(2 * PIECE + 100, 'first')
  const other = journal(2 * PIECE + 100, 'other')
  assert.equal(first.length, other.length)
  assert.notEqual(sha(first), sha(other))
  const idb = seeded([[B, first, T0]])
  const one = await kitOf(e, idb).copyToCloud()
  assert.equal(one.complete, true, one.line)
  assert.deepEqual((await kitOf(e, idb).joinThreads({ clientId: CLIENT, rescueId: one.id })).rows.map(row => row.outcome), ['imported'])
  e.clock.t += 60000
  reseed(idb, [[B, other, T_B]])
  const two = await kitOf(e, idb).copyToCloud()
  assert.equal(two.complete, true, two.line)
  const joined = await kitOf(e, idb).joinThreads({ clientId: CLIENT, rescueId: two.id })
  assert.deepEqual(joined.rows.map(row => row.outcome), ['kept beside'], 'the join says kept beside')
  const kit = kitOf(e, idb)
  return { e, kit, first, other, copiedAt: e.clock.t, state: await kit.cloudState({ clientId: CLIENT, store: true }) }
}

test('a different copy of the SAME length is kept beside; the reload counts it 0 of 1 and never says "equal"', async () => {
  const { e, state } = await sameLengthCopies()
  assert.equal(state.line, OPEN_COUNT(0, 1, e.clock.t))
  const words = [state.line, ...state.lines, ...state.rows.map(row => row.text)].join('\n')
  assert.doesNotMatch(words, /equal/i, words)
})

test('a run is done only when every thread is; a row "not done: CODE" makes the run not done and the page names the threads not joined', async () => {
  const { e, idb } = await movedOn()
  const kit = kitOf(e, idb)
  const copied = await kit.copyToCloud()
  e.hooks.before = entry => (entry.path === '/_thread/import' && JSON.parse(entry.body).path === A ? Response.json({ ok: false, code: 'ARCHIVE_UNAVAILABLE' }, { status: 503 }) : undefined)
  const joined = await kit.joinThreads({ clientId: CLIENT, rescueId: copied.id })
  assert.deepEqual(joined.rows.map(row => row.text), ['auma/session: kept beside', 'agent/a: not done: ARCHIVE_UNAVAILABLE', 'agent/b: extended'])
  assert.equal(importsOf(e, 0).filter(entry => JSON.parse(entry.body).path === A && entry.status === 503).length, 1, 'a refusal is not retried')
  assert.equal(joined.ok, true)
  assert.equal(joined.done, false, 'a row not done makes the run not done')
  assert.equal(joined.line, NOT_JOINED('agent/a'))
  assert.ok(joined.lines.includes(NOT_JOINED('agent/a')), JSON.stringify(joined.lines))
  assert.equal(joined.lines[0], COUNT(1, 3, e.clock.t))
  e.hooks.before = null
  const again = await kit.joinThreads({ clientId: CLIENT, rescueId: copied.id })
  assert.deepEqual(again.rows.map(row => row.outcome), ['kept beside', 'imported', 'same'])
  // A journal kept beside is not this copy's content in her cloud, so the press is not done.
  assert.equal(again.done, false)
  assert.equal(again.line, COUNT(2, 3, e.clock.t))
})

// ── A Join keeps its turn while it works; one press works 30 minutes at most ────────────────────────────

/** `n` journals copied and joined (the clock still), then `extra` new journals after them in the copy, copied again. */
async function joinedThen(n, extra = 1, size = k => PIECE + 31 * k + 7) {
  const e = edge()
  const old = Array.from({ length: n }, (_, k) => [sessionPath(k), journal(size(k), 's' + k), T0 + k])
  const idb = seeded(old)
  const first = await kitOf(e, idb).copyToCloud()
  assert.equal(first.complete, true, first.line)
  const joined = await kitOf(e, idb).joinThreads({ clientId: CLIENT, rescueId: first.id })
  assert.equal(joined.done, true, joined.line)
  const fresh = Array.from({ length: extra }, (_, k) => [`/dsh/home/sessions/agent/z${k}/session.v1.jsonl`, journal(PIECE + 500 + k, 'z' + k), T0 + 1000 + k])
  reseed(idb, old.concat(fresh))
  const kit = kitOf(e, idb)
  const copied = await kit.copyToCloud()
  assert.equal(copied.complete, true, copied.line)
  return { e, kit, copied, old, fresh }
}

test('five imports of 25 s each (125 s in all): the Join renews its turn while it works and joins all five in one press', async () => {
  const { e, kit, copied, fresh } = await joinedThen(0, 5)
  const mark = e.log.length
  e.hooks.after = entry => { if (entry.path === '/_thread/import') e.clock.t += 25000 }
  const joined = await kit.joinThreads({ clientId: CLIENT, rescueId: copied.id })
  assert.deepEqual(joined.rows.map(row => row.outcome), Array(5).fill('imported'))
  assert.equal(joined.done, true, joined.line)
  assert.equal(joined.line, COUNT(5, 5, e.clock.t))
  assert.ok(importsOf(e, mark).every(entry => entry.status === 200), 'no import was refused')
  const calls = leaseActions(e, mark)
  assert.deepEqual(calls.map(call => call.action), ['acquire', 'renew', 'renew', 'renew', 'renew', 'release'])
  assert.ok(calls.every(call => call.clientId === CLIENT && call.tabId === calls[0].tabId))
  for (const [path, bytes] of fresh) assert.equal((await e.thread(path)).bytes, bytes.length)
  assert.equal(e.lease().holder, null, 'released at the end')
})

test('a turn truly taken by another browser in between is NOT taken back: her words (423), nothing more sent, that lease untouched', async () => {
  const { e, kit, copied, fresh } = await joinedThen(0, 4)
  const mark = e.log.length
  let answered = 0, other = null
  e.hooks.after = async entry => {
    if (entry.path !== '/_thread/import' || ++answered !== 2) return
    e.clock.t += 91000
    other = await leaseAction(e.mirror, { action: 'acquire', clientId: OTHER, tabId: 'mac', label: 'Chrome on the Mac' }, { now: e.clock.t })
    assert.equal(other.status, 200)
  }
  const joined = await kit.joinThreads({ clientId: CLIENT, rescueId: copied.id })
  assert.equal(joined.line, 'She is answering in Chrome on the Mac. Try again when she has finished.')
  // The third journal was never sent: "not tried", never a refusal of the turn written into its row.
  assert.deepEqual(joined.rows.map(row => row.outcome), ['not confirmed', 'not confirmed', 'not tried', 'not tried'])
  assert.ok(!allWords(joined).some(line => line.startsWith('Not joined')), JSON.stringify(joined))
  assert.ok(joined.lines.includes(UNCONFIRMED_READ))
  assert.equal(joined.done, false)
  assert.equal(importsOf(e, mark).length, 2, 'nothing sent after the turn was taken')
  assert.deepEqual(leaseActions(e, mark).map(call => call.action), ['acquire', 'renew', 'acquire', 'release'])
  assert.equal(e.lease().holder.clientId, OTHER)
  assert.equal(e.lease().leaseId, other.body.lease.leaseId, "his Mac's lease is untouched")
  assert.equal(e.lease().expiresAt, other.body.lease.expiresAt)
  assert.equal(await e.thread(fresh[2][0]), null, 'nothing written')
})

test('an import answered 410 (the turn ran out, nobody took it): one acquire under the same client and page ids, that journal retried once, joined', async () => {
  const { e, kit, copied, fresh } = await joinedThen(2)
  const mark = e.log.length
  let jumped = false
  e.hooks.before = entry => {
    if (entry.path === '/_thread/import' && JSON.parse(entry.body).path === fresh[0][0] && !jumped) { jumped = true; e.clock.t += 91000 }
    return undefined
  }
  const joined = await kit.joinThreads({ clientId: CLIENT, rescueId: copied.id })
  assert.deepEqual(joined.rows.map(row => row.outcome), ['same', 'same', 'imported'])
  assert.equal(joined.done, true, joined.line)
  const tries = importsOf(e, mark).filter(entry => JSON.parse(entry.body).path === fresh[0][0])
  assert.deepEqual(tries.map(entry => entry.status), [410, 200])
  assert.equal(importsOf(e, mark).length, 2, 'the two journals her cloud showed with this content were never asked')
  assert.notEqual(tries[0].headers['x-thread-lease'], tries[1].headers['x-thread-lease'], 'the retry carries the new lease')
  const calls = leaseActions(e, mark)
  assert.deepEqual(calls.map(call => call.action), ['acquire', 'acquire', 'release'])
  assert.ok(calls.every(call => call.clientId === CLIENT && call.tabId === calls[0].tabId), 'the same client and page ids')
  assert.equal(e.lease().holder, null)
})

test('a journal whose retry is answered 410 again stops the run: retried ONCE, her words, nothing more sent', async () => {
  const { e, kit, copied, fresh } = await joinedThen(1, 2)
  const mark = e.log.length
  e.hooks.before = entry => {
    if (entry.path === '/_thread/import' && JSON.parse(entry.body).path === fresh[0][0]) e.clock.t += 91000
    return undefined
  }
  const joined = await kit.joinThreads({ clientId: CLIENT, rescueId: copied.id })
  assert.equal(joined.line, LOST_LINE)
  assert.deepEqual(joined.rows.map(row => row.outcome), ['same', 'not done: WRITER_GONE', 'not tried'])
  assert.deepEqual(importsOf(e, mark).map(entry => [JSON.parse(entry.body).path, entry.status]), [[fresh[0][0], 410], [fresh[0][0], 410]])
  assert.deepEqual(leaseActions(e, mark).map(call => call.action), ['acquire', 'acquire', 'release'])
  assert.equal(e.lease().holder, null)
  assert.equal(await e.thread(fresh[0][0]), null)
})

test('one press works 30 minutes at most: it stops before the next journal in plain words, and Join again compares afresh and finishes', async () => {
  const { e, kit, copied, fresh } = await joinedThen(3, 4)
  const mark = e.log.length
  e.hooks.after = entry => { if (entry.path === '/_thread/import') e.clock.t += 11 * 60000 }
  const joined = await kit.joinThreads({ clientId: CLIENT, rescueId: copied.id })
  assert.equal(joined.line, HELD_LINE)
  assert.equal(joined.done, false)
  assert.deepEqual(joined.rows.map(row => row.outcome), ['same', 'same', 'same', 'imported', 'imported', 'imported', 'not tried'])
  assert.equal(importsOf(e, mark).length, 3)
  assert.ok(joined.lines.includes(NOT_TRIED_LINE('agent/z3')), JSON.stringify(joined.lines))
  assert.ok(!joined.lines.some(line => line.startsWith('Not joined')), JSON.stringify(joined.lines))
  assert.equal(leaseActions(e, mark).at(-1).action, 'release')
  assert.equal(e.lease().holder, null)
  // Join again (a still clock): nothing remembered, it compares again: one import, the one left.
  e.hooks.after = null
  const second = e.log.length
  const again = await kit.joinThreads({ clientId: CLIENT, rescueId: copied.id })
  assert.deepEqual(importsOf(e, second).map(entry => JSON.parse(entry.body).path), [fresh[3][0]])
  assert.deepEqual(again.rows.map(row => row.outcome), Array(6).fill('same').concat(['imported']))
  assert.equal(again.done, true, again.line)
})

test('the kit\'s lease timing is her edge\'s (WORLD_LEASE ttlMs, renewMs and writeHoldMs); the held line says 30 minutes', () => {
  const source = readFileSync(new URL('../rescue-kit.mjs', import.meta.url), 'utf8')
  assert.ok(source.includes(`const LEASE_TTL_MS = ${WORLD_LEASE.ttlMs}, LEASE_RENEW_MS = ${WORLD_LEASE.renewMs}, JOIN_HOLD_MS = ${WORLD_LEASE.writeHoldMs}\n`))
  assert.equal(WORLD_LEASE.writeHoldMs, 30 * 60000)
  assert.ok(source.includes(`held: '${HELD_LINE}',`))
})

// ── A press compares before it asks; the page remembers nothing ──────────────────────────────────────────

/** `n` journals of 640 bytes copied and joined by `kit`'s page, then `extra` new ones after them, copied again. */
async function manyJoined(n, extra) {
  const e = edge()
  const old = Array.from({ length: n }, (_, k) => [sessionPath(k), journal(640, 'm' + k), T0 + k])
  const idb = seeded(old)
  const kit = kitOf(e, idb)
  const first = await kit.copyToCloud()
  assert.equal(first.complete, true, first.line)
  const joined = await kit.joinThreads({ clientId: CLIENT, rescueId: first.id })
  assert.equal(joined.done, true, joined.line)
  const fresh = Array.from({ length: extra }, (_, k) => [sessionPath(n + k), journal(640, 'n' + k), T0 + n + k])
  reseed(idb, old.concat(fresh))
  const copied = await kit.copyToCloud()
  assert.equal(copied.complete, true, copied.line)
  return { e, kit, copied, old, fresh }
}

test('201 journals already joined plus one new: ONE press, one index read at the start, exactly one import, done at the final read', async () => {
  const { e, kit, copied, fresh } = await manyJoined(201, 1)
  const mark = e.log.length
  const joined = await kit.joinThreads({ clientId: CLIENT, rescueId: copied.id })
  const made = e.since(mark)
  const firstImport = made.findIndex(entry => entry.path === '/_thread/import')
  // One read, all pages: 202 threads are two pages of 200.
  assert.equal(made.slice(0, firstImport).filter(entry => entry.path === '/_thread/index').length, 2)
  assert.deepEqual(importsOf(e, mark).map(entry => JSON.parse(entry.body).path), [fresh[0][0]])
  assert.equal(made.filter(entry => entry.path === '/_thread/index').length, 4, 'the start read and the final read, two pages each')
  assert.deepEqual(leaseActions(e, mark).map(call => call.action), ['acquire', 'release'])
  assert.equal(joined.done, true, joined.line)
  assert.equal(joined.line, COUNT(202, 202, e.clock.t))
  assert.deepEqual(joined.rows.filter(row => row.outcome !== 'same').map(row => [row.path, row.outcome]), [[fresh[0][0], 'imported']])
  assert.equal(joined.rows.length, 202)
})

test('the page remembers nothing between presses: the same page and a new page send the same requests', async () => {
  const { e, kit, copied, fresh } = await joinedThen(2, 2)
  const sent = mark => importsOf(e, mark).map(entry => JSON.parse(entry.body).path)
  // A press stopped by time (16 minutes per answer): two imports, then the deadline.
  e.hooks.after = entry => { if (entry.path === '/_thread/import') e.clock.t += 16 * 60000 }
  const stopped = await kit.joinThreads({ clientId: CLIENT, rescueId: copied.id })
  assert.deepEqual(stopped.rows.map(row => row.outcome), ['same', 'same', 'imported', 'imported'])
  e.hooks.after = null
  let mark = e.log.length
  await kit.joinThreads({ clientId: CLIENT, rescueId: copied.id })
  assert.deepEqual(sent(mark), [], 'the same page: everything shows this copy\'s content, nothing is asked')
  mark = e.log.length
  const reload = await kitOf(e, seeded([])).joinThreads({ clientId: CLIENT, rescueId: copied.id })
  assert.deepEqual(sent(mark), [], 'a new page: the same')
  assert.equal(reload.done, true)
  assert.ok(fresh.length === 2)
})

// ── The 30 minutes hold across renew, re-acquire and retry; said truthfully ───────────────────────

test('89 imports at 20 s, the next loses its turn after another 91 s: no acquire at 31 min 11 s, nothing more written, the lost-turn line', async () => {
  const { e, kit, copied } = await joinedThen(0, 90)
  const start = e.clock.t
  const mark = e.log.length
  // The 90th import sent (the copy's order is its keys' order, so it is counted, not named).
  let jumped = false, sentCount = 0, lastPath = null
  e.hooks.before = entry => {
    if (entry.path === '/_thread/import' && ++sentCount === 90 && !jumped) { jumped = true; lastPath = JSON.parse(entry.body).path; e.clock.t += 91000 }
    return undefined
  }
  e.hooks.after = entry => { if (entry.path === '/_thread/import' && !jumped) e.clock.t += 20000 }
  const joined = await kit.joinThreads({ clientId: CLIENT, rescueId: copied.id })
  assert.ok(e.clock.t - start >= 31 * 60000 + 11000, 'the clock is past 31 min 11 s')
  assert.equal(joined.line, LOST_LINE)
  assert.equal(joined.done, false)
  // Every row, as before job 7: the 89 imported, then the 90th refused.
  assert.deepEqual(joined.rows.map(row => row.outcome), Array(89).fill('imported').concat(['not done: WRITER_GONE']))
  const sent = importsOf(e, mark)
  assert.equal(sent.length, 90, 'the 410 import was not retried')
  assert.equal(sent.at(-1).status, 410)
  const actions = leaseActions(e, mark).map(call => call.action)
  assert.equal(actions.filter(action => action === 'acquire').length, 1, `no acquire after the deadline: ${actions.join()}`)
  assert.equal(actions.at(-1), 'release')
  assert.equal(await e.thread(lastPath), null, 'nothing written')
  const other = await leaseAction(e.mirror, { action: 'acquire', clientId: OTHER, tabId: 'mac', label: 'Chrome on the Mac' }, { now: e.clock.t })
  assert.equal(other.status, 200, 'another browser is not refused')
})

test('a closed lid (one minute in, 40 minutes asleep before the next import): the page says it lost its turn, never that it held her cloud, and sends nothing more', async () => {
  const { e, kit, copied, fresh } = await joinedThen(0, 5)
  const mark = e.log.length
  e.hooks.after = entry => { if (entry.path === '/_thread/import' && JSON.parse(entry.body).path === fresh[0][0]) e.clock.t += 60000 }
  e.hooks.before = entry => { if (entry.path === '/_thread/import' && JSON.parse(entry.body).path === fresh[1][0]) e.clock.t += 40 * 60000 }
  const joined = await kit.joinThreads({ clientId: CLIENT, rescueId: copied.id })
  assert.equal(joined.line, LOST_LINE)
  assert.notEqual(joined.line, HELD_LINE)
  assert.deepEqual(joined.rows.map(row => row.outcome), ['imported', 'not done: WRITER_GONE', 'not tried', 'not tried', 'not tried'])
  assert.equal(importsOf(e, mark).length, 2, 'nothing sent after the pause')
  assert.deepEqual(leaseActions(e, mark).map(call => call.action), ['acquire', 'renew', 'release'])
})

test('a retry waited out past the deadline is not sent (503 IMPORT_BUSY at 29 min 50 s)', async () => {
  const { e, copied, fresh } = await joinedThen(1, 1)
  const mark = e.log.length
  e.hooks.before = entry => {
    if (entry.path !== '/_thread/import' || JSON.parse(entry.body).path !== fresh[0][0]) return undefined
    e.clock.t += 29 * 60000 + 50000
    return Response.json({ ok: false, code: 'IMPORT_BUSY' }, { status: 503, headers: { 'retry-after': '20' } })
  }
  const joined = await kitOf(e, seeded([]), { sleep: async ms => { e.clock.t += ms } }).joinThreads({ clientId: CLIENT, rescueId: copied.id })
  assert.equal(importsOf(e, mark).filter(entry => JSON.parse(entry.body).path === fresh[0][0]).length, 1, 'the retry after the deadline was not sent')
  assert.equal(joined.rows.at(-1).outcome, 'not done: IMPORT_BUSY')
  assert.equal(joined.done, false)
  assert.equal(joined.line, LOST_LINE, 'no renew or commit for 30 minutes: her edge let the turn run out')
})

test('A imported, 91 s pass, the renew answers 410 and every acquire 503: B was never sent, so it is "not tried", never "Not joined"', async () => {
  const e = edge()
  const idb = seeded([[A, A1, T0], [B, B1, T0]])
  const kit = kitOf(e, idb)
  const copied = await kit.copyToCloud()
  assert.equal(copied.complete, true, copied.line)
  const mark = e.log.length
  let acquires = 0
  e.hooks.after = entry => { if (entry.path === '/_thread/import') e.clock.t += 91000 }
  e.hooks.before = entry => {
    if (entry.path !== '/_mirror/lease' || JSON.parse(entry.body).action !== 'acquire' || ++acquires === 1) return undefined
    return Response.json({ ok: false, code: 'OWNER_SESSION_UNAVAILABLE' }, { status: 503 })
  }
  const joined = await kit.joinThreads({ clientId: CLIENT, rescueId: copied.id })
  assert.equal(joined.line, LOST_LINE)
  assert.ok(!JSON.stringify(joined).includes('Nothing was joined'))
  assert.deepEqual(joined.rows.map(row => row.text), ['agent/a: imported', 'agent/b: not tried'])
  assert.ok(!allWords(joined).some(line => line.startsWith('Not joined')), JSON.stringify(joined))
  assert.ok(joined.lines.includes(NOT_TRIED_LINE('agent/b')), JSON.stringify(joined.lines))
  assert.deepEqual(leaseActions(e, mark).map(call => call.action), ['acquire', 'renew', 'acquire', 'acquire', 'acquire', 'acquire', 'acquire', 'release'])
  assert.equal(importsOf(e, mark).length, 1)
})

// ── What the page says is what the press's own final read showed ─────────────────────────────────────

/** Another tab of the same browser takes the turn, retracts `path` to zero (her own run: no approval needed), lets go. */
async function retractElsewhere(e, path) {
  const taken = await leaseAction(e.mirror, { action: 'acquire', clientId: CLIENT, tabId: 'other-tab', label: 'Chrome tab' }, { now: e.clock.t })
  assert.equal(taken.status, 200, JSON.stringify(taken.body))
  const t = await e.thread(path)
  const kept = await e.threadMirror.call('retract', { id: t.id, forkAt: 0, expect: { bytes: t.bytes, sealedBytes: t.sealedBytes, chain: t.chain, tailSha: t.tailSha },
    kept: { bytes: t.bytes, sha256: t.tailSha, pieces: [t.tailSha] }, lease: { leaseId: taken.body.lease.leaseId, generation: taken.body.lease.generation } })
  assert.equal(kept.status, 200, JSON.stringify(kept.body))
  const freed = await leaseAction(e.mirror, { action: 'release', clientId: CLIENT, tabId: 'other-tab', label: 'Chrome tab', leaseId: taken.body.lease.leaseId }, { now: e.clock.t })
  assert.equal(freed.status, 200, JSON.stringify(freed.body))
  assert.equal((await e.thread(path)).bytes, 0)
}

test('11 minutes per import answer, another tab retracts the FIRST journal right after its answer: never "same", never done', async () => {
  const e = edge()
  const journals = Array.from({ length: 3 }, (_, k) => [sessionPath(k), journal(640, 'p' + k), T0 + k])
  const idb = seeded(journals)
  const kit = kitOf(e, idb)
  const copied = await kit.copyToCloud()
  assert.equal(copied.complete, true, copied.line)
  const target = sessionPath(0)
  let answers = 0
  e.hooks.after = async entry => {
    if (entry.path !== '/_thread/import') return
    e.clock.t += 11 * 60000
    if (++answers === 1) await retractElsewhere(e, target)
  }
  const joined = await kit.joinThreads({ clientId: CLIENT, rescueId: copied.id })
  assert.equal(answers, 3)
  assert.equal((await e.thread(target)).bytes, 0, 'her cloud holds none of s00')
  assert.equal(joined.done, false)
  assert.equal(joined.rows[0].outcome, 'not confirmed')
  assert.equal(joined.rows[0].text, `agent/s00: not confirmed: her edge answered imported, but at ${hhmm(e.clock.t)} her cloud did not show this copy's content`)
  assert.deepEqual(joined.rows.slice(1).map(row => row.outcome), ['imported', 'imported'])
  assert.equal(joined.line, NOT_CONFIRMED_LINE('agent/s00'))
  assert.equal(joined.lines[0], COUNT(2, 3, e.clock.t))
  // The next press compares again: s00 is the one import.
  e.hooks.after = null
  const mark = e.log.length
  const again = await kit.joinThreads({ clientId: CLIENT, rescueId: copied.id })
  assert.deepEqual(importsOf(e, mark).map(entry => JSON.parse(entry.body).path), [target])
  assert.equal(again.done, true, again.line)
})

test('201 joined, three imports of 11 minutes, an untouched journal of page one retracted BETWEEN the final read\'s two pages: the read is not confirmed, nothing is said same, not done', async () => {
  const { e, kit, copied, old } = await manyJoined(201, 3)
  const oldPaths = new Set(old.map(([path]) => path))
  e.hooks.after = entry => { if (entry.path === '/_thread/import') e.clock.t += 11 * 60000 }
  const mark = e.log.length
  // The start read's two pages are answered before any import moves the clock.
  const startAt = e.clock.t
  let reads = 0, target = null
  const inner = e.hooks.after
  e.hooks.after = async (entry, response) => {
    await inner(entry, response)
    if (entry.path !== '/_thread/index' || entry.method !== 'GET' || e.since(mark).filter(seen => seen.path === '/_thread/import').length < 3) return
    if (++reads !== 1) return
    // The final read's FIRST page has been answered: another tab retracts an untouched journal it listed.
    const page = await response.clone().json()
    target = page.threads.map(t => t.path).find(path => oldPaths.has(path))
    await retractElsewhere(e, target)
  }
  const joined = await kit.joinThreads({ clientId: CLIENT, rescueId: copied.id })
  assert.ok(target, 'a journal of page one was retracted')
  assert.equal(importsOf(e, mark).length, 3)
  assert.equal(joined.done, false)
  assert.equal(joined.line, UNCONFIRMED_READ)
  const row = joined.rows.find(entry => entry.path === target)
  assert.equal(row.outcome, 'not confirmed')
  assert.equal(row.text, `${row.title}: not confirmed: her cloud showed the same content at ${hhmmss(startAt)}; no later read of her cloud confirmed it`)
  assert.ok(!joined.rows.some(entry => entry.outcome === 'same'), 'no row is said same')
  assert.ok(!allWords(joined).some(line => /unchanged|^At \d\d:\d\d her cloud showed/.test(line)), 'no count from an unconfirmed read')
})

test('a closed lid of 31 minutes right after the start read, s02 retracted meanwhile: nothing imported, s02 never said same, not done', async () => {
  const { e, kit, copied } = await manyJoined(4, 0)
  const target = sessionPath(2)
  let reads = 0
  e.hooks.after = async entry => {
    if (entry.path !== '/_thread/index' || ++reads !== 1) return
    e.clock.t += 31 * 60000
    await retractElsewhere(e, target)
  }
  const mark = e.log.length
  const lid = await kit.joinThreads({ clientId: CLIENT, rescueId: copied.id })
  assert.equal(importsOf(e, mark).length, 0)
  assert.equal((await e.thread(target)).bytes, 0)
  assert.equal(lid.done, false)
  assert.notEqual(lid.rows[2].outcome, 'same')
  assert.equal(lid.rows[2].outcome, 'not confirmed')
})

test('a journal that GREW in her cloud elsewhere: one import proves this copy is a prefix, "same, her cloud held more" with its time', async () => {
  const e = edge()
  const idb = seeded([[A, A1, T0], [B, B1, T0]])
  const kit = kitOf(e, idb)
  const copied = await kit.copyToCloud()
  assert.equal(copied.complete, true, copied.line)
  assert.deepEqual((await kit.joinThreads({ clientId: CLIENT, rescueId: copied.id })).rows.map(row => row.outcome), ['imported', 'imported'])
  e.clock.t += 60000
  reseed(idb, [[A, A1, T0], [B, B2, T_B]])
  const other = kitOf(e, idb)
  const grown = await other.copyToCloud()
  assert.equal(grown.complete, true, grown.line)
  assert.deepEqual((await other.joinThreads({ clientId: CLIENT, rescueId: grown.id })).rows.map(row => row.outcome), ['same', 'extended'])
  const mark = e.log.length
  const again = await kit.joinThreads({ clientId: CLIENT, rescueId: copied.id })
  assert.deepEqual(importsOf(e, mark).map(entry => JSON.parse(entry.body).path), [B])
  assert.deepEqual(again.rows.map(row => row.text), ['agent/a: same', `agent/b: same (her cloud held more than this copy at ${hhmm(e.clock.t)})`])
  assert.equal(again.done, true, again.line)
})

test('a start read that stays unreadable (503 on every try) is asked five times, then NOTHING is sent: "could not be read", no rows, released', async () => {
  const { e, kit, copied } = await joinedThen(3, 2)
  e.hooks.before = entry => (entry.path === '/_thread/index' ? Response.json({ ok: false, code: 'THREAD_STORAGE_UNAVAILABLE' }, { status: 503, headers: { 'retry-after': '2' } }) : undefined)
  const mark = e.log.length
  const joined = await kit.joinThreads({ clientId: CLIENT, rescueId: copied.id })
  assert.equal(e.since(mark).filter(entry => entry.path === '/_thread/index').length, 5, 'the first page, five tries')
  assert.deepEqual(kit.sleeps, Array(4).fill(2000), 'four waits, each the retry-after')
  assert.equal(importsOf(e, mark).length, 0, 'no walk over every journal')
  assert.equal(joined.line, UNREAD_LINE)
  assert.equal(joined.done, false)
  assert.deepEqual(joined.rows, [])
  assert.deepEqual(joined.lines, [])
  assert.deepEqual(leaseActions(e, mark).map(call => call.action), ['acquire', 'release'])
  assert.equal(e.lease().holder, null, 'released')
})

test('201 joined plus one new, the start read\'s first page answers 503 OWNER_SESSION_UNAVAILABLE once: waited out, ONE import, done', async () => {
  const { e, kit, copied, fresh } = await manyJoined(201, 1)
  const mark = e.log.length
  let busy = 1
  e.hooks.before = entry => (entry.path === '/_thread/index' && busy-- > 0
    ? Response.json({ ok: false, code: 'OWNER_SESSION_UNAVAILABLE' }, { status: 503, headers: { 'retry-after': '3' } }) : undefined)
  const joined = await kit.joinThreads({ clientId: CLIENT, rescueId: copied.id })
  const made = e.since(mark)
  const firstImport = made.findIndex(entry => entry.path === '/_thread/import')
  assert.equal(made.slice(0, firstImport).filter(entry => entry.path === '/_thread/index').length, 3, 'page one twice (busy, then answered), page two once')
  assert.deepEqual(kit.sleeps, [3000], 'the retry-after')
  assert.deepEqual(importsOf(e, mark).map(entry => JSON.parse(entry.body).path), [fresh[0][0]])
  assert.equal(joined.done, true, joined.line)
  assert.equal(joined.line, COUNT(202, 202, e.clock.t))
})

test('a start read still unanswered at the press\'s 30 minutes is not asked again, and nothing is sent', async () => {
  const { e, kit, copied } = await joinedThen(1, 2)
  e.hooks.before = entry => {
    if (entry.path !== '/_thread/index') return undefined
    e.clock.t += 31 * 60000
    return Response.json({ ok: false, code: 'OWNER_SESSION_UNAVAILABLE' }, { status: 503 })
  }
  const mark = e.log.length
  const joined = await kit.joinThreads({ clientId: CLIENT, rescueId: copied.id })
  assert.equal(e.since(mark).filter(entry => entry.path === '/_thread/index').length, 1)
  assert.deepEqual(kit.sleeps, [])
  assert.equal(importsOf(e, mark).length, 0)
  assert.equal(joined.line, UNREAD_LINE)
  assert.deepEqual(joined.rows, [])
})

// ── Refused, not confirmed and not tried are three different outcomes ───────────────────────────────

test('one 8,242-byte journal, the import and its five retries delivered but every answer lost: "Join not confirmed", never "Not joined"; the next press finds it same without an import', async () => {
  const e = edge()
  const bytes = journal(8242, 'lost')
  assert.equal(bytes.length, 8242)
  const idb = seeded([[A, bytes, T0]])
  const kit = kitOf(e, idb)
  const copied = await kit.copyToCloud()
  assert.equal(copied.complete, true, copied.line)
  const mark = e.log.length
  e.hooks.after = entry => { if (entry.path === '/_thread/import') throw new TypeError('the answer was lost') }
  const joined = await kit.joinThreads({ clientId: CLIENT, rescueId: copied.id })
  const sent = importsOf(e, mark)
  assert.equal(sent.length, 6, 'the import and its five retries')
  assert.ok(sent.every(entry => entry.status === 200), 'each was delivered and answered at her edge')
  assert.equal((await e.thread(A)).bytes, 8242, 'her cloud holds the whole journal')
  assert.deepEqual(joined.rows.map(row => row.text), [`agent/a: ${UNCONFIRMED}; at ${hhmm(e.clock.t)} her cloud showed this copy's content`])
  assert.equal(joined.line, NOT_CONFIRMED_LINE('agent/a'))
  assert.equal(joined.done, false, 'not confirmed is never counted joined')
  assert.equal(joined.equal, 1)
  assert.equal(joined.lines[0], COUNT(1, 1, e.clock.t))
  assert.ok(!allWords(joined).some(line => line.startsWith('Not joined')), JSON.stringify(joined))
  assert.equal(e.lease().holder, null, 'released')
  e.hooks.after = null
  const next = e.log.length
  const again = await kit.joinThreads({ clientId: CLIENT, rescueId: copied.id })
  assert.equal(importsOf(e, next).length, 0)
  assert.deepEqual(again.rows.map(row => row.text), ['agent/a: same'])
  assert.equal(again.done, true, again.line)
})

test('the import commits, its answer is lost, the retry is answered 401: the sign-in headline, and the row "not confirmed", never "not done"', async () => {
  const e = edge()
  const bytes = journal(8242, 'signin')
  const idb = seeded([[A, bytes, T0]])
  const kit = kitOf(e, idb)
  const copied = await kit.copyToCloud()
  assert.equal(copied.complete, true, copied.line)
  let tries = 0
  e.hooks.before = entry => (entry.path === '/_thread/import' && tries > 0 ? Response.json({ ok: false, code: 'OWNER_ACCESS_REQUIRED' }, { status: 401 }) : undefined)
  e.hooks.after = entry => { if (entry.path === '/_thread/import' && tries++ === 0) throw new TypeError('the answer was lost') }
  const joined = await kit.joinThreads({ clientId: CLIENT, rescueId: copied.id })
  assert.equal((await e.thread(A)).bytes, 8242, 'committed')
  assert.equal(joined.signin, true)
  assert.equal(joined.line, 'Your sign-in ended. Sign in on this page and press Join again.')
  assert.deepEqual(joined.rows.map(row => row.text), ['agent/a: ' + UNCONFIRMED])
  assert.deepEqual(joined.lines, [NOT_CONFIRMED_LINE('agent/a')])
  assert.equal(joined.done, false)
  assert.equal(e.lease().holder, null, 'released')
})

test('one refused, one not confirmed and one not tried in a single press: three lines, in a fixed order; the next press sends only what her cloud does not show', async () => {
  const e = edge()
  const C3 = '/dsh/home/sessions/agent/c/session.v1.jsonl'
  const idb = seeded([[A, A1, T0], [B, B1, T0], [C3, C1, T0]])
  const kit = kitOf(e, idb)
  const copied = await kit.copyToCloud()
  assert.equal(copied.complete, true, copied.line)
  e.hooks.before = entry => (entry.path === '/_thread/import' && JSON.parse(entry.body).path === A ? Response.json({ ok: false, code: 'IMPORT_NOT_PREFIX' }, { status: 409 }) : undefined)
  e.hooks.after = entry => {
    if (entry.path !== '/_thread/import' || JSON.parse(entry.body).path !== B) return
    e.clock.t += 31 * 60000
    throw new TypeError('the answer was lost')
  }
  const mark = e.log.length
  const joined = await kit.joinThreads({ clientId: CLIENT, rescueId: copied.id })
  assert.deepEqual(importsOf(e, mark).map(entry => JSON.parse(entry.body).path), [A, B])
  assert.deepEqual(joined.rows.map(row => row.text), ['agent/a: not done: IMPORT_NOT_PREFIX',
    `agent/b: ${UNCONFIRMED}; at ${hhmm(e.clock.t)} her cloud showed this copy's content`, 'agent/c: not tried'])
  assert.equal(joined.line, LOST_LINE)
  assert.equal(joined.done, false)
  assert.deepEqual(joined.lines.slice(-3), [NOT_JOINED('agent/a'), NOT_CONFIRMED_LINE('agent/b'), NOT_TRIED_LINE('agent/c')])
  assert.equal((await e.thread(B)).bytes, B1.length, 'her cloud holds B')
  assert.equal(await e.thread(C3), null)
  e.hooks.before = null
  e.hooks.after = null
  const next = e.log.length
  const again = await kit.joinThreads({ clientId: CLIENT, rescueId: copied.id })
  assert.deepEqual(importsOf(e, next).map(entry => JSON.parse(entry.body).path), [A, C3])
  assert.deepEqual(again.rows.map(row => row.text), ['agent/a: imported', 'agent/b: same', 'agent/c: imported'])
  assert.equal(again.done, true, again.line)
})

/** MIRROR commits every `import` op, then the answer is lost between MIRROR and the Worker (`lose(n)`, n from 1). */
function loseMirrorAnswers(e, lose) {
  const real = e.threadMirror.call
  let n = 0
  e.threadMirror.call = async (op, input, home) => {
    const answer = await real(op, input, home)
    if (op === 'import' && lose(++n)) throw new Error('the connection to MIRROR was lost')
    return answer
  }
}

test('MIRROR commits the 8,242-byte import, its answer is lost before the Worker (503 THREAD_STORAGE_UNAVAILABLE): retried in the same press, it settles as "same"', async () => {
  const e = edge()
  const bytes = journal(8242, 'store')
  const idb = seeded([[A, bytes, T0]])
  const kit = kitOf(e, idb)
  const copied = await kit.copyToCloud()
  assert.equal(copied.complete, true, copied.line)
  loseMirrorAnswers(e, n => n === 1)
  const mark = e.log.length
  const joined = await kit.joinThreads({ clientId: CLIENT, rescueId: copied.id })
  assert.deepEqual(importsOf(e, mark).map(entry => entry.status), [503, 200], 'the first answer was THREAD_STORAGE_UNAVAILABLE, the retry answered')
  assert.equal((await e.thread(A)).bytes, 8242)
  assert.deepEqual(joined.rows.map(row => row.text), ['agent/a: same'])
  assert.equal(joined.done, true, joined.line)
  assert.ok(!allWords(joined).some(line => line.startsWith('Not joined')), JSON.stringify(joined))
  assert.equal(e.lease().holder, null)
})

test('answers that prove nothing (503 THREAD_STORAGE_UNAVAILABLE, 503 THREAD_UNAVAILABLE, a 502 with no code of hers) are retried five times, then "not confirmed", never "Not joined"', async () => {
  const e = edge()
  const C3 = '/dsh/home/sessions/agent/c/session.v1.jsonl'
  const idb = seeded([[A, A1, T0], [B, B1, T0], [C3, C1, T0]])
  const kit = kitOf(e, idb)
  const copied = await kit.copyToCloud()
  assert.equal(copied.complete, true, copied.line)
  const answers = {
    [A]: () => Response.json({ ok: false, code: 'THREAD_STORAGE_UNAVAILABLE' }, { status: 503 }),
    [B]: () => new Response('bad gateway', { status: 502 }),
    [C3]: () => Response.json({ ok: false, code: 'THREAD_UNAVAILABLE' }, { status: 503 }),
  }
  e.hooks.before = entry => (entry.path === '/_thread/import' ? answers[JSON.parse(entry.body).path]() : undefined)
  const mark = e.log.length
  const joined = await kit.joinThreads({ clientId: CLIENT, rescueId: copied.id })
  const sent = importsOf(e, mark)
  assert.deepEqual(sent.map(entry => [JSON.parse(entry.body).path, entry.status]), Array(6).fill([A, 503]).concat(Array(6).fill([B, 502]), Array(6).fill([C3, 503])))
  assert.deepEqual(joined.rows.map(row => row.text), ['agent/a: ' + UNCONFIRMED, 'agent/b: ' + UNCONFIRMED, 'agent/c: ' + UNCONFIRMED])
  assert.equal(joined.line, NOT_CONFIRMED_LINE('agent/a, agent/b, agent/c'))
  assert.equal(joined.done, false)
  assert.ok(!allWords(joined).some(line => line.startsWith('Not joined')), JSON.stringify(joined))
  assert.equal(e.lease().holder, null)
  e.hooks.before = null
  const again = await kit.joinThreads({ clientId: CLIENT, rescueId: copied.id })
  assert.deepEqual(again.rows.map(row => row.outcome), ['imported', 'imported', 'imported'])
  assert.equal(again.done, true, again.line)
})

// ── Sentences about her cloud are observations; one number per fact ─────────────────────────────────

test('P joins A and B at 19:30, another page joins B extended at 19:41, P presses Join on its older copy: nothing says later bytes are only in this browser', async () => {
  const e = edge()
  const idb = seeded([[A, A1, T0], [B, B1, T0]])
  const page = kitOf(e, idb)
  const copied = await page.copyToCloud()
  assert.equal((await page.joinThreads({ clientId: CLIENT, rescueId: copied.id })).done, true)
  e.clock.t = T_B
  reseed(idb, [[A, A1, T0], [B, B2, T_B]])
  const other = kitOf(e, idb)
  const grown = await other.copyToCloud()
  assert.deepEqual((await other.joinThreads({ clientId: CLIENT, rescueId: grown.id })).rows.map(row => row.outcome), ['same', 'extended'])
  const joined = await page.joinThreads({ clientId: CLIENT, rescueId: copied.id })
  const words = allWords(joined)
  assert.ok(!words.some(line => /only in this browser/.test(line)), words.join('\n'))
  assert.equal(joined.line, COUNT(1, 2, e.clock.t))
  assert.deepEqual(joined.lines, [NEWEST(T0, 'agent/a'), AHEAD(1, e.clock.t)])
})

test('an empty journal and a refused one: one count, and no second line contradicting it', async () => {
  const e = edge()
  const idb = seeded([[A, new Uint8Array(0), T0], [B, B1, T0]])
  const kit = kitOf(e, idb)
  const copied = await kit.copyToCloud()
  e.hooks.before = entry => (entry.path === '/_thread/import' ? Response.json({ ok: false, code: 'IMPORT_NOT_PREFIX' }, { status: 409 }) : undefined)
  const joined = await kit.joinThreads({ clientId: CLIENT, rescueId: copied.id })
  assert.equal(joined.line, NOT_JOINED('agent/b'))
  assert.deepEqual(joined.lines, [COUNT(1, 2, e.clock.t), NEWEST(T0, 'agent/b'), NOT_JOINED('agent/b')])
  assert.ok(!allWords(joined).some(line => line.startsWith('None')), JSON.stringify(joined))
})

test('Check against the chosen copy whose digest differs answers equal:false and its headline says NOT equal; against the matching copy it says Equal', async () => {
  const { kit, first, other, copiedAt, state } = await sameLengthCopies()
  const row = state.rows.find(entry => entry.path === B)
  assert.equal(row.rescue.sha256, sha(other), 'the chosen copy is the second one')
  const checked = await kit.checkThread({ id: row.id, title: row.title, path: row.path, rescue: row.rescue })
  assert.equal(checked.equal, false, checked.line)
  assert.equal(checked.ok, true)
  assert.equal(checked.line, `NOT equal to the rescue copy of ${hhmm(copiedAt)}: her cloud holds ${first.length} bytes, SHA-256 ${sha(first)}; the copy holds ${other.length} bytes, SHA-256 ${sha(other)}.`)
  assert.ok(checked.lines.includes(`Read back from her cloud: ${first.length} bytes, SHA-256 ${sha(first)}, every piece equal to its name.`), JSON.stringify(checked.lines))
  // Against the first copy it is equal, and says so.
  const same = await kit.checkThread({ id: row.id, title: row.title, rescue: { bytes: first.length, sha256: sha(first), verifiedAt: new Date(T0).toISOString() } })
  assert.equal(same.equal, true, same.line)
  assert.equal(same.line, `Read back from her cloud: ${first.length} bytes, SHA-256 ${sha(first)}, every piece equal.`)
  assert.ok(same.lines.includes(`Equal to the rescue copy of ${hhmm(T0)}.`))
})

// ── Opening the page reads with no turn; its pages are several moments and are said as such ─────────

/** The thread id range page one of an open covered, and its time: the hooks of the reviewer's two-page sequence. */
function betweenPages(e, onPageTwo) {
  const seen = { pageOneAt: null, pageOneLast: null, pageOnePaths: [], pageTwoAt: null }
  e.hooks.after = async (entry, response) => {
    if (entry.path !== '/_thread/index' || entry.search.includes('after=')) return
    const page = await response.clone().json()
    seen.pageOneAt = e.clock.t
    seen.pageOnePaths = page.threads.map(t => t.path)
    seen.pageOneLast = page.next
  }
  e.hooks.before = async entry => {
    if (entry.path !== '/_thread/index' || !entry.search.includes('after=')) return undefined
    // Before page two is served: a minute passes and another tab of the same browser acts.
    e.clock.t += 60000
    await onPageTwo()
    seen.pageTwoAt = e.clock.t
    return undefined
  }
  return seen
}

test('201 joined, the page opens, a page-one journal is retracted before page two is served: the read is said as an interval, the row carries its page\'s time, never "201 of 201" at one time', async () => {
  const { e, kit, copied, old } = await manyJoined(201, 0)
  e.clock.t += 5000
  const oldPaths = new Set(old.map(([path]) => path))
  let target = null
  const seen = betweenPages(e, async () => {
    target = seen.pageOnePaths.find(path => oldPaths.has(path))
    await retractElsewhere(e, target)
  })
  const mark = e.log.length
  const open = await kit.cloudState({ clientId: CLIENT, store: true })
  e.hooks.before = e.hooks.after = null
  assert.ok(target, 'a journal of page one was retracted')
  assert.ok(e.since(mark).every(entry => entry.method === 'GET'), 'the open itself only reads (the other tab wrote straight to her edge)')
  assert.equal(e.since(mark).filter(entry => entry.path === '/_thread/index').length, 2, 'two pages: two requests')
  assert.equal((await e.thread(target)).bytes, 0, 'her cloud held none of it when page two was read')
  assert.notEqual(hhmmss(seen.pageOneAt), hhmmss(seen.pageTwoAt))
  // The summary names the interval and says once that her cloud can change while it is read.
  assert.equal(open.line, `Read between ${hhmmss(seen.pageOneAt)} and ${hhmmss(seen.pageTwoAt)}, her cloud showed 201 of 201 threads with the same content as this copy.${CHANGE_LINE}`)
  assert.deepEqual([open.reads, open.readFrom, open.readTo], [2, seen.pageOneAt, seen.pageTwoAt])
  // The changed journal's row says what the page that listed it showed, at that page's time.
  const row = open.rows.find(entry => entry.path === target)
  assert.equal(row.text, `${row.title}: 640 bytes at ${hhmmss(seen.pageOneAt)}, the same content as the copy`)
  assert.equal(row.seenAt, seen.pageOneAt)
  const later = open.rows.find(entry => !seen.pageOnePaths.includes(entry.path))
  assert.equal(later.seenAt, seen.pageTwoAt, 'a thread of page two carries page two\'s time')
  assert.equal(later.text, `${later.title}: 640 bytes at ${hhmmss(seen.pageTwoAt)}, the same content as the copy`)
  assert.ok(open.rows.every(entry => entry.seenAt === (seen.pageOnePaths.includes(entry.path) ? seen.pageOneAt : seen.pageTwoAt)))
  // No line says that all 201 had the same content AT one time; no row is undated.
  const words = [open.line, ...open.lines, ...open.rows.map(entry => entry.text)]
  assert.ok(!words.some(line => /^At \d\d:\d\d(:\d\d)? her cloud showed 201 of 201/.test(line)), words.slice(0, 3).join('\n'))
  assert.ok(open.rows.every(entry => / at \d\d:\d\d:\d\d, /.test(entry.text)), 'every row is an observation with its time')
  // Join checks again before it writes: the retracted journal is the one import, and its own final read keeps its words.
  const joinMark = e.log.length
  const joined = await kit.joinThreads({ clientId: CLIENT, rescueId: copied.id })
  assert.deepEqual(importsOf(e, joinMark).map(entry => JSON.parse(entry.body).path), [target])
  assert.equal(joined.done, true, joined.line)
  assert.equal(joined.line, COUNT(201, 201, e.clock.t))
})

test('a journal not in her cloud, read over two pages, is "not in her cloud" at the time of the page whose ids hold it; one page says "At HH:MM:SS"', async () => {
  const { e, kit, copied, fresh } = await manyJoined(201, 1)
  e.clock.t += 7000
  const seen = betweenPages(e, async () => {})
  // Both copies were checked in the same second: the page names the newer one, as after its own Copy.
  const open = await kit.cloudState({ clientId: CLIENT, store: true, rescueId: copied.id })
  e.hooks.before = e.hooks.after = null
  const missing = fresh[0][0]
  const id = sha(enc.encode(missing))
  assert.equal(id, await threadIdForPath(missing))
  const expected = id <= seen.pageOneLast ? seen.pageOneAt : seen.pageTwoAt
  const row = open.rows.find(entry => entry.path === missing)
  assert.equal(row.seenAt, expected)
  assert.equal(row.text, `${row.title}: not in her cloud at ${hhmmss(expected)}`)
  assert.equal(open.line, `Read between ${hhmmss(seen.pageOneAt)} and ${hhmmss(seen.pageTwoAt)}, her cloud showed 201 of 202 threads with the same content as this copy.${CHANGE_LINE}`)
  // Each request's own time, to the second: a read of one page names one moment and no caveat.
  const one = edge()
  const idb = seeded([[A, A1, T0]])
  const small = kitOf(one, idb)
  const smallCopy = await small.copyToCloud()
  one.clock.t += 61000
  // Every answer comes one second after the request before it: the list of copies, then the index.
  one.hooks.after = entry => { if (entry.method === 'GET') one.clock.t += 1000 }
  const alone = await small.cloudState({ clientId: CLIENT, store: true })
  assert.equal(alone.reads, 1)
  assert.equal(alone.line, OPEN_COUNT(0, 1, one.clock.t))
  assert.deepEqual(alone.rows.map(entry => entry.text), [`agent/a: not in her cloud at ${hhmmss(one.clock.t)}`])
  assert.ok(smallCopy.complete)
})

test('"no checked copy" is what the list of copies showed, with its time, on an open and on Join; the home line carries page one\'s time', async () => {
  const e = edge()
  e.clock.t += 3000
  e.hooks.after = entry => { if (entry.method === 'GET') e.clock.t += 1000 }
  const start = e.clock.t
  const open = await kitOf(e, new FakeIndexedDb()).cloudState({ clientId: null, store: false })
  assert.equal(open.line, `At ${hhmmss(start + 1000)} her cloud held no checked rescue copy. At ${hhmmss(start + 2000)} it listed 0 threads.`)
  const before = e.clock.t
  const joined = await kitOf(e, seeded([[A, A1, T0]])).joinThreads({ clientId: CLIENT })
  assert.equal(joined.line, `At ${hhmmss(before + 1000)} her cloud held no checked copy of this browser. Press Copy to her cloud first.`)
  assert.deepEqual(joined.rows, [])
  e.hooks.after = null
  // The home line: the index's home row is page one's, so it is said with page one's time.
  const { e: two, copied } = await manyJoined(201, 0)
  const inner = two.fetch
  const pending = { ...two, fetch: async (input, init) => {
    const response = await inner(input, init)
    if (!String(input).startsWith('/_thread/index')) return response
    const body = await response.json()
    // Page two is answered a minute after page one.
    if (String(input).includes('after=')) two.clock.t += 60000
    return Response.json({ ...body, home: { pending: true, rescue: copied.id, freeze: 'record' } }, { status: response.status })
  } }
  const pageOneAt = two.clock.t
  const withHome = await kitOf(pending, new FakeIndexedDb()).cloudState({ clientId: CLIENT, store: false })
  assert.equal(withHome.reads, 2)
  assert.equal(withHome.lines.at(-1), OPEN_HOME(pageOneAt))
})

// ── The final confirmation read keeps the press's deadline ─────────────────────────────────────────

test('the import commits, every final index answer is 503 OWNER_SESSION_UNAVAILABLE with retry-after 60: a few tries, never past the press deadline, then "could not be confirmed"', async () => {
  const e = edge()
  const idb = seeded([[A, A1, T0]])
  const kit = kitOf(e, idb, { sleep: async ms => { e.clock.t += ms } })
  const copied = await kit.copyToCloud()
  assert.equal(copied.complete, true, copied.line)
  const mark = e.log.length
  const start = e.clock.t
  e.hooks.before = entry => (entry.path === '/_thread/index' && importsOf(e, mark).length > 0
    ? Response.json({ ok: false, code: 'OWNER_SESSION_UNAVAILABLE' }, { status: 503, headers: { 'retry-after': '60' } }) : undefined)
  const joined = await kit.joinThreads({ clientId: CLIENT, rescueId: copied.id })
  const made = e.since(mark)
  const finals = made.slice(made.findIndex(entry => entry.path === '/_thread/import')).filter(entry => entry.path === '/_thread/index')
  assert.equal(finals.length, 5, 'five tries of the final page, as the start read has')
  assert.ok(e.clock.t - start < 30 * 60000, `the press ended inside its 30 minutes (${(e.clock.t - start) / 60000} min)`)
  assert.equal(joined.line, UNCONFIRMED_READ)
  assert.equal(joined.done, false)
  assert.deepEqual(joined.rows.map(row => row.text), ['agent/a: not confirmed: her edge answered imported; no later read of her cloud confirmed it'])
  assert.equal(leaseActions(e, mark).at(-1).action, 'release')
  assert.equal(e.lease().holder, null)
})

test('the import answered at 29 min 30 s, the final index busy (retry-after 60): one try, no wait that would end past the deadline, no try after it, "could not be confirmed"', async () => {
  const e = edge()
  const idb = seeded([[A, A1, T0]])
  const waits = []
  const kit = kitOf(e, idb, { sleep: async ms => { waits.push([e.clock.t, ms]); e.clock.t += ms } })
  const copied = await kit.copyToCloud()
  assert.equal(copied.complete, true, copied.line)
  const mark = e.log.length
  let granted = null
  e.hooks.after = entry => {
    if (entry.path === '/_mirror/lease' && granted === null) granted = e.clock.t
    if (entry.path === '/_thread/import') e.clock.t = granted + 29 * 60000 + 30000
  }
  e.hooks.before = entry => (entry.path === '/_thread/index' && importsOf(e, mark).length > 0
    ? Response.json({ ok: false, code: 'OWNER_SESSION_UNAVAILABLE' }, { status: 503, headers: { 'retry-after': '60' } }) : undefined)
  const joined = await kit.joinThreads({ clientId: CLIENT, rescueId: copied.id })
  const made = e.since(mark)
  const after = made.slice(made.findIndex(entry => entry.path === '/_thread/import') + 1)
  assert.deepEqual(after.map(entry => entry.method + ' ' + entry.path), ['GET /_thread/index', 'POST /_mirror/lease'], 'one final try, then the release')
  assert.equal(joined.line, UNCONFIRMED_READ)
  assert.equal(joined.done, false)
  // A wait that would end at or past the deadline is not begun (no try could follow it).
  assert.deepEqual(waits.filter(([at]) => at >= granted + 29 * 60000), [], 'no wait begun at 29 min 30 s')
  assert.equal(e.clock.t, granted + 29 * 60000 + 30000, 'the press ended at 29 min 30 s, inside its 30 minutes')
})

// ── Join's start read names each row's own page, to the second; no wait runs past the deadline ──

test('Join\'s start read spans two pages, its turn runs out before page two, another tab retracts a page-one journal: each row names the time of the page that listed it, to the second', async () => {
  const { e, kit, copied, old } = await manyJoined(201, 0)
  e.clock.t += 5000
  const oldPaths = new Set(old.map(([path]) => path))
  const seen = { pageOneAt: null, pageOnePaths: [], pageTwoAt: null }
  let target = null
  e.hooks.after = async (entry, response) => {
    if (entry.path !== '/_thread/index' || entry.search.includes('after=') || seen.pageOneAt !== null) return
    seen.pageOneAt = e.clock.t
    seen.pageOnePaths = (await response.clone().json()).threads.map(t => t.path)
  }
  e.hooks.before = async entry => {
    if (entry.path !== '/_thread/index' || !entry.search.includes('after=') || seen.pageTwoAt !== null) return undefined
    // Page two stalls past the press's turn (90 s): at 1 min 40 s another tab takes the turn, retracts a page-one
    // journal and releases; page two is answered 24 s later.
    e.clock.t += WORLD_LEASE.ttlMs + 10000
    target = seen.pageOnePaths.find(path => oldPaths.has(path))
    await retractElsewhere(e, target)
    e.clock.t += 24000
    seen.pageTwoAt = e.clock.t
    return undefined
  }
  const mark = e.log.length
  const joined = await kit.joinThreads({ clientId: CLIENT, rescueId: copied.id })
  e.hooks.before = e.hooks.after = null
  assert.ok(target, 'a journal of page one was retracted')
  assert.notEqual(hhmm(seen.pageOneAt), hhmm(seen.pageTwoAt), 'the two pages were answered in different minutes')
  assert.equal(importsOf(e, mark).length, 0, 'the start read showed every journal with this copy\'s content')
  assert.equal((await e.thread(target)).bytes, 0, 'her cloud held none of it when page two was read')
  assert.equal(joined.done, false)
  assert.equal(joined.line, UNCONFIRMED_READ)
  const row = joined.rows.find(entry => entry.path === target)
  assert.equal(row.seenAt, seen.pageOneAt)
  assert.equal(row.text, `${row.title}: not confirmed: her cloud showed the same content at ${hhmmss(seen.pageOneAt)}; no later read of her cloud confirmed it`)
  const later = joined.rows.find(entry => !seen.pageOnePaths.includes(entry.path))
  assert.equal(later.seenAt, seen.pageTwoAt)
  assert.equal(later.text, `${later.title}: not confirmed: her cloud showed the same content at ${hhmmss(seen.pageTwoAt)}; no later read of her cloud confirmed it`)
  assert.ok(joined.rows.every(entry => entry.seenAt === (seen.pageOnePaths.includes(entry.path) ? seen.pageOneAt : seen.pageTwoAt)), 'every row carries its own page\'s time')
})

// ── job 1: an OLDER copy (private rows in it, no `leftAtOrigin`) and a NEW one (the field, no private rows) ────────
const OLD_COPY = JSON.parse(readFileSync(new URL('./rescue-old-copy.fixture.json', import.meta.url), 'utf8'))
const OLD_T = Date.UTC(2026, 10, 13, 1, 0, 0)
const OLD_PRIVATE = '/dsh/home/auma/private'
const OLD_PRIVATE_TEXT = 'made-up private words for the old-copy fixture\n'
/** The made-up store the fixture was made from by the kit at an earlier commit: explicit UTC times only. */
const oldShapeEntries = () => [...storeEntries([[B, B1, OLD_T], [C, C1, OLD_T + 60000]]),
  [OLD_PRIVATE, dirEntry(0o700)], [OLD_PRIVATE + '/note-ow4.md', fileEntry(OLD_PRIVATE_TEXT, OLD_T, 0o600)],
  ['/dsh/home/auma/seed', dirEntry()], ['/dsh/home/auma/seed/checkpoint-signer.v1.json', fileEntry('{"made":"up signer, not a key"}', OLD_T, 0o600)]]

test('an OLDER copy keeps its id and bytes, verifies at the real vault and joins; a NEW copy of the same store has the field, no private rows, no signer, a new id, and verifies and joins too', async () => {
  const e = edge()
  const idb = new FakeIndexedDb()
  idb.seed(DB, oldShapeEntries())
  const kit = kitOf(e, idb)
  // The older copy, byte for byte as the kit at an earlier commit made it: the same canonical bytes and the same id today.
  const old = JSON.parse(OLD_COPY.text)
  assert.equal(OLD_COPY.piece, PIECE)
  assert.equal(kit.canon(old), OLD_COPY.text)
  assert.equal(kit.indexId(old), OLD_COPY.id)
  assert.equal(sha(enc.encode(OLD_COPY.text)), OLD_COPY.indexSha256)
  assert.equal(OLD_COPY.indexSha256.slice(0, 32), OLD_COPY.id)
  assert.equal('leftAtOrigin' in old, false)
  assert.ok(old.rows.some(row => row.key === OLD_PRIVATE + '/note-ow4.md'), 'the older copy holds the room as rows')
  assert.ok(old.rows.some(row => row.key.endsWith('checkpoint-signer.v1.json')), 'and the signer')
  // It goes to her cloud as an older page sent it: every piece from the store's bytes, then the list, then the edge's walk.
  const stored = new Map(oldShapeEntries())
  for (const row of old.rows) {
    if (row.pieces.length === 0) continue
    const value = stored.get(row.key)
    const bytes = value && value.kind === 'file' ? value.bytes : enc.encode(JSON.stringify(value))
    assert.equal(sha(bytes), row.sha256, row.key)
    for (let n = 0; n < row.pieces.length; n++) {
      const put = await e.fetch('/_vault/blob/' + row.pieces[n], { method: 'PUT', body: bytes.slice(n * PIECE, Math.min((n + 1) * PIECE, bytes.length)) })
      assert.ok(put.status === 200 || put.status === 201, row.key + ' piece ' + n + ': ' + put.status)
    }
  }
  assert.equal((await e.fetch('/_vault/rescue/' + OLD_COPY.id, { method: 'PUT', body: OLD_COPY.text })).status, 201)
  let cursor = 0, walked = null
  for (let calls = 0; calls < 50 && walked === null; calls++) {
    const answer = await (await e.fetch(`/_vault/rescue/${OLD_COPY.id}/verify?cursor=${cursor}`, { method: 'POST' })).json()
    assert.equal(answer.ok, true, JSON.stringify(answer))
    if (answer.done) walked = answer
    else cursor = answer.cursor
  }
  assert.ok(walked, 'the edge verified the older copy')
  assert.equal(walked.files, old.rows.filter(row => row.type === 'file').length, 'her cloud counts its rows as they are, the room included')
  // Join from the older copy: both journals are hers, done.
  const joinedOld = await kit.joinThreads({ clientId: CLIENT, rescueId: OLD_COPY.id })
  assert.equal(joinedOld.done, true, joinedOld.line + ' | ' + joinedOld.lines.join(' | '))
  assert.deepEqual(joinedOld.rows.map(row => [row.path, row.outcome]).sort(), [[B, 'imported'], [C, 'imported']].sort())
  assert.equal(joinedOld.rescue.id, OLD_COPY.id)

  // A NEW copy of the same store: the field, no room rows, no signer; a different id (new copies only).
  e.clock.t += 60000
  const copied = await kit.copyToCloud()
  assert.equal(copied.complete, true, copied.line + ' | ' + copied.lines.join(' | '))
  assert.notEqual(copied.id, OLD_COPY.id)
  const sent = JSON.parse(new TextDecoder().decode(e.bucket.objects.get(`w/${WORLD}/rescue/${copied.id}/pending.json`).bytes))
  assert.deepEqual(sent.leftAtOrigin, { private: { files: 1, bytes: enc.encode(OLD_PRIVATE_TEXT).length } })
  assert.ok(!sent.rows.some(row => row.key === OLD_PRIVATE || row.key.startsWith(OLD_PRIVATE + '/')), 'no room row')
  assert.ok(!sent.rows.some(row => row.key.includes('checkpoint-signer')), 'no signer row')
  // The journal rows of the two shapes are the same rows: Join reads the same journals from either.
  assert.deepEqual(sent.rows.filter(row => kit.isThread(row.key)), old.rows.filter(row => kit.isThread(row.key)))
  const joinedNew = await kit.joinThreads({ clientId: CLIENT, rescueId: copied.id })
  assert.equal(joinedNew.done, true, joinedNew.line)
  assert.deepEqual(joinedNew.rows.map(row => row.outcome), ['same', 'same'])
  assert.equal(joinedNew.rescue.id, copied.id)
  // Both copies stay listed as checked; nothing rewrote or removed the older one.
  const state = await kit.cloudState({ clientId: CLIENT, store: true, rescueId: OLD_COPY.id })
  assert.equal(state.ok, true, state.line)
  assert.equal(state.rescue.id, OLD_COPY.id)
  assert.equal(new TextDecoder().decode(e.bucket.objects.get(`w/${WORLD}/rescue/${OLD_COPY.id}/pending.json`).bytes), OLD_COPY.text)
})
