/**
 * W3JOIN (job 1 step 3, job 2 MUST 3): her running app must not notice wave 3. The app in his tab is main's client: it
 * knows no lease and reads a 423 or 410 as "try again" (idb-persist.ts deliveryRefusal). This test runs MAIN's
 * mirror-do.mjs (and every module it imports, all taken from `git show <BASE>:...`, never beside the joined ones) and
 * the JOINED mirror-do.mjs side by side, each over its own in-memory storage, with a fixed clock and fixed ids, and
 * drives both with the requests today's client and HEAD send, with NO new setting (the deployment's default mode).
 *
 * For every request, the ANSWER (status, headers and body, byte for byte) and the COST must be equal. The cost is the
 * storage double's whole record of that request (W3JOIN job 3, SHOULD 1): every transaction opened, every get, put and
 * delete with the keys it touched (batch forms recorded as batches, key by key), and every listing with its normalised
 * options AND the keys it returned. An overload or a storage method the double does not implement is REFUSED and
 * recorded, never passed through uncounted.
 *
 * The ALLOW-LIST is EMPTY (W3JOIN job 3, MUST 1): full status too is main's answer at main's cost. A difference is
 * collected (not thrown at the first), so a failing run names every request that differs. On the joined side ONLY, while the client works: the /rescue page holds a live lease (acquired under its
 * own browser id) and a thread import records a pending home. Neither is sent to main (main has no such routes);
 * neither may change one answer or one storage operation of the app. Every storage row outside `world:v1:` and
 * `thread:v1:` must end equal on both sides.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { AsyncLocalStorage } from 'node:async_hooks'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as joined from '../mirror-do.mjs'
import { canonicalBootstrap, digest } from '../head-do.mjs'
import { THREAD_PROTOCOL, bytesToBase64, threadIdForPath } from '../thread-log.mjs'

/** Main at the time of the join (the lead's `base`). It must be an ancestor of HEAD. */
const BASE = 'de5b3fa6'
const REPO = fileURLToPath(new URL('../../../../', import.meta.url))
const ENTRY = 'deploy/cloudflare/src/mirror-do.mjs'
const SEED = 'a'.repeat(64)
const BALL = 'b'.repeat(64)
const LINEAGE = '11111111-1111-4111-8111-111111111111'
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const D = 'dddddddd-0000-4000-8000-00000000000d'
const E = 'eeeeeeee-0000-4000-8000-00000000000e'
const RESCUE = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const T0 = 1_800_000_000_000
const DAY = 86400000
const MIB = 1024 * 1024
/** The read today's client makes at boot (idb-persist.ts readSnapshot). */
const SNAPSHOT = '/api/snapshot?snapshotFormat=x61-mirror-snapshot%2Fv2'
const WAVE3 = key => typeof key === 'string' && (key.startsWith('world:') || key.startsWith('thread:'))
const client = index => `${index.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`

/** Main's module graph from git, in a folder of its own; bare packages resolve through a link to the repo's node_modules. */
async function loadMain() {
  try { execFileSync('git', ['-C', REPO, 'merge-base', '--is-ancestor', BASE, 'HEAD'], { stdio: 'ignore' }) }
  catch { throw new Error(`w3-app-unchanged: main ${BASE} is not an ancestor of HEAD in ${REPO}, so main's mirror cannot be compared here. Rebase onto main, or update BASE to the main commit this branch was cut from.`) }
  const root = await mkdtemp(path.join(os.tmpdir(), 'w3-main-'))
  await symlink(path.join(REPO, 'node_modules'), path.join(root, 'node_modules'), 'dir')
  const seen = new Set()
  const todo = [ENTRY]
  const specifiers = /(?:^|\n)\s*(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|(?:^|\n)\s*import\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g
  while (todo.length) {
    const file = todo.pop()
    if (seen.has(file)) continue
    seen.add(file)
    const text = execFileSync('git', ['-C', REPO, 'show', `${BASE}:${file}`], { encoding: 'utf8', maxBuffer: 64 << 20 })
    await mkdir(path.join(root, path.dirname(file)), { recursive: true })
    await writeFile(path.join(root, file), text)
    for (const match of text.matchAll(specifiers)) {
      const spec = match[1] ?? match[2] ?? match[3]
      if (spec.startsWith('.')) todo.push(path.posix.normalize(path.posix.join(path.posix.dirname(file), spec)))
    }
  }
  const mod = await import(pathToFileURL(path.join(root, ENTRY)).href)
  return { root, mod, files: seen.size }
}

/**
 * Durable-Object-like storage: staged writes per transaction, committed on return, dropped on throw; one at a time.
 * W3JOIN job 3 (SHOULD 1): `ops` counts every transaction, get, list, put and delete (a batch counts each key) and `log`
 * records each with its normalised arguments: the keys touched, a listing's options and the keys it returned. The batch
 * forms Durable Object storage has (get/delete of an array of keys, put of an object of entries) are implemented and
 * recorded as batches; any other overload, an unknown listing option, a second argument, and every storage method this
 * double does not implement are REFUSED: recorded in `refused` and thrown, never passed through uncounted.
 * `poison`, when set, makes every operation on a wave 3 key (`world:` or `thread:`, a listing by its prefix included)
 * throw, as a failing storage would.
 */
const LIST_OPTIONS = new Set(['prefix', 'start', 'startAfter', 'end', 'reverse', 'limit'])
/**
 * W3JOIN job 6 (S4): which request of an overlapping group (sendTogether) a storage operation belongs to. Each request runs
 * inside `REQUEST.run(index)`, and the context follows its own awaits and promise callbacks, so every operation, the
 * transaction and commit marks included, is recorded with the index of the request that made it.
 */
const REQUEST = new AsyncLocalStorage()
const UNIMPLEMENTED = ['rollback', 'deleteAll', 'getAlarm', 'setAlarm', 'deleteAlarm', 'sync', 'transactionSync', 'sql', 'kv', 'getCurrentBookmark', 'getBookmarkForTime', 'onNextSessionRestoreBookmark']
function createStorage() {
  const data = new Map()
  const ops = { transaction: 0, get: 0, list: 0, put: 0, delete: 0 }
  const log = []
  // W3JOIN job 6 (S4): the same record, each entry with the index of the request that made it (null: none).
  const tagged = []
  const record = entry => { log.push(entry); tagged.push([REQUEST.getStore() ?? null, entry]) }
  const refused = []
  const state = { poison: false }
  let tail = Promise.resolve()
  const refuse = what => { refused.push(what); throw new TypeError(`storage double: ${what} is not implemented`) }
  const touch = (kind, keys, entry) => {
    ops[kind] += kind === 'list' ? 1 : keys.length
    record(entry)
    if (state.poison && keys.some(WAVE3)) throw Object.assign(new Error('STORAGE_FAILED'), { code: undefined })
  }
  const keysOf = (kind, key, extra) => {
    if (extra.length > 0) refuse(`${kind} with a second argument`)
    if (typeof key === 'string') return { keys: [key], batch: false }
    if (Array.isArray(key) && key.length > 0 && key.length <= 128 && key.every(item => typeof item === 'string')) return { keys: key, batch: true }
    return refuse(`${kind}(${Array.isArray(key) ? 'array' : typeof key})`)
  }
  const listOf = (read, options = {}, extra = []) => {
    if (extra.length > 0) refuse('list with a second argument')
    if (options === null || typeof options !== 'object' || Array.isArray(options)) refuse('list(non-object)')
    for (const name of Object.keys(options)) if (!LIST_OPTIONS.has(name)) refuse(`list option ${name}`)
    const { prefix = '', start, startAfter, end, reverse = false, limit = Infinity } = options
    if (typeof prefix !== 'string' || (start !== undefined && typeof start !== 'string') || (startAfter !== undefined && typeof startAfter !== 'string')
      || (end !== undefined && typeof end !== 'string') || typeof reverse !== 'boolean' || !(limit === Infinity || (Number.isSafeInteger(limit) && limit > 0))) refuse('list with an option of another type')
    const keys = read.keys().filter(key => key.startsWith(prefix) && (start === undefined || key >= start) && (startAfter === undefined || key > startAfter) && (end === undefined || key < end)).sort()
    if (reverse) keys.reverse()
    const out = new Map()
    for (const key of keys) {
      if (out.size >= limit) break
      out.set(key, read.get(key))
    }
    const normalised = { prefix, start: start ?? null, startAfter: startAfter ?? null, end: end ?? null, reverse, limit: limit === Infinity ? null : limit }
    return { out, entry: `list ${JSON.stringify(normalised)} -> ${out.size} [${[...out.keys()].join(',')}]`, prefix }
  }
  const surface = (read, write) => ({
    get: async (key, ...extra) => {
      const { keys, batch } = keysOf('get', key, extra)
      touch('get', keys, `get${batch ? '[]' : ''} ${keys.join(',')}`)
      if (!batch) return read.get(key)
      const out = new Map()
      for (const name of keys) { const value = read.get(name); if (value !== undefined) out.set(name, value) }
      return out
    },
    put: async (key, value, ...extra) => {
      if (typeof key === 'string') {
        if (extra.length > 0) refuse('put with a third argument')
        touch('put', [key], `put ${key}`)
        write.put(key, value)
        return
      }
      if (key === null || typeof key !== 'object' || Array.isArray(key) || value !== undefined || extra.length > 0) refuse(`put(${typeof key})`)
      const keys = Object.keys(key)
      if (keys.length === 0 || keys.length > 128) refuse('put of an object of 0 or more than 128 entries')
      touch('put', keys, `put{} ${keys.join(',')}`)
      for (const name of keys) write.put(name, key[name])
    },
    delete: async (key, ...extra) => {
      const { keys, batch } = keysOf('delete', key, extra)
      touch('delete', keys, `delete${batch ? '[]' : ''} ${keys.join(',')}`)
      let removed = 0
      for (const name of keys) if (write.delete(name)) removed += 1
      return batch ? removed : removed === 1
    },
    list: async (options = {}, ...extra) => {
      const listed = listOf(read, options, extra)
      touch('list', [listed.prefix], listed.entry)
      return listed.out
    },
    ...Object.fromEntries(UNIMPLEMENTED.map(name => [name, () => refuse(name)])),
  })
  const direct = surface(
    { keys: () => [...data.keys()], get: key => structuredClone(data.get(key)) },
    { put: (key, value) => { data.set(key, structuredClone(value)) }, delete: key => data.delete(key) })
  return {
    data, ops, log, tagged, refused, state,
    ...direct,
    transaction(fn, ...extra) {
      if (typeof fn !== 'function' || extra.length > 0) refuse('transaction overload')
      const run = tail.then(async () => {
        ops.transaction += 1
        record('transaction')
        const writes = new Map(), deletes = new Set()
        const read = {
          keys: () => [...new Set([...data.keys(), ...writes.keys()])].filter(key => !deletes.has(key) || writes.has(key)),
          get: key => (writes.has(key) ? structuredClone(writes.get(key)) : deletes.has(key) ? undefined : structuredClone(data.get(key))),
        }
        const view = {
          ...surface(read, {
            put: (key, value) => { deletes.delete(key); writes.set(key, structuredClone(value)) },
            delete: key => { const had = read.get(key) !== undefined; writes.delete(key); deletes.add(key); return had },
          }),
          transaction: () => refuse('a transaction inside a transaction'),
        }
        const result = await fn(view)
        for (const key of deletes) if (!writes.has(key)) data.delete(key)
        for (const [key, value] of writes) data.set(key, value)
        record('commit')
        return result
      })
      tail = run.catch(() => {})
      return run
    },
  }
}

test('W3JOIN job 3 SHOULD 1: the storage double records what the counters alone missed (an empty transaction, batch forms, a listing\'s options and rows) and refuses what it does not implement', async () => {
  const one = createStorage(), two = createStorage()
  for (const store of [one, two]) for (let n = 0; n < 5; n++) store.data.set(`mirror:v2:entry:${n}`, n)
  await one.transaction(async () => null)
  assert.deepEqual([one.ops.transaction, one.log], [1, ['transaction', 'commit']], 'an empty transaction is counted')
  await one.get(['mirror:v2:entry:1', 'mirror:v2:entry:2'])
  await one.delete(['mirror:v2:entry:3'])
  await one.put({ 'mirror:v2:entry:9': 9, 'mirror:v2:entry:8': 8 })
  assert.deepEqual([one.ops.get, one.ops.delete, one.ops.put], [2, 1, 2], 'a batch counts each key')
  assert.deepEqual(one.log.slice(2), ['get[] mirror:v2:entry:1,mirror:v2:entry:2', 'delete[] mirror:v2:entry:3', 'put{} mirror:v2:entry:9,mirror:v2:entry:8'])
  await two.list({ prefix: 'mirror:v2:entry:', limit: 1 })
  await two.list({ prefix: 'mirror:v2:entry:', end: 'mirror:v2:entry:3', reverse: true })
  assert.deepEqual(two.log, [
    'list {"prefix":"mirror:v2:entry:","start":null,"startAfter":null,"end":null,"reverse":false,"limit":1} -> 1 [mirror:v2:entry:0]',
    'list {"prefix":"mirror:v2:entry:","start":null,"startAfter":null,"end":"mirror:v2:entry:3","reverse":true,"limit":null} -> 3 [mirror:v2:entry:2,mirror:v2:entry:1,mirror:v2:entry:0]',
  ], 'a listing is recorded with its options and the rows it returned')
  for (const call of [() => two.get(42), () => two.get('k', { allowConcurrency: true }), () => two.put(['k'], 1), () => two.list({ prefix: 'm', unknown: 1 }), () => two.deleteAll(), () => two.setAlarm(1),
    () => two.transaction(async tx => tx.transaction(async () => null))]) {
    await assert.rejects(Promise.resolve().then(call), /storage double/)
  }
  assert.equal(two.refused.length, 7, 'every refusal is recorded')
})

/** One MirrorDO over its own storage and NO setting; `send` answers `{status, headers, text, ops, log}` (that request's whole storage record). */
function side(Mirror) {
  const storage = createStorage()
  const mirror = new Mirror({ storage }, {})
  // D3HOLDER job 4 (the reviewer's SHOULD 1, the lead's R1e): what the object's CONSTRUCTOR did to storage is kept here before
  // the first request resets the counters, so the comparison below cannot lose it.
  const started = { ops: { ...storage.ops }, log: [...storage.log], refused: [...storage.refused] }
  const send = async ({ method, path: route, body, seed = true }, { poison = false } = {}) => {
    for (const kind of Object.keys(storage.ops)) storage.ops[kind] = 0
    storage.log.length = 0
    storage.tagged.length = 0
    storage.state.poison = poison
    try {
      const response = await mirror.fetch(new Request(`https://x61.internal${route}`, {
        method, headers: { 'content-type': 'application/json', 'x-x6-internal-authorized': '1', ...(seed ? { 'x-x6-bootstrap-seed': SEED } : {}) },
        ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
      }))
      const headers = JSON.stringify([...response.headers].sort(([x], [y]) => (x < y ? -1 : 1)))
      return { status: response.status, headers, text: await response.text(), ops: { ...storage.ops }, log: [...storage.log] }
    } finally { storage.state.poison = false }
  }
  /**
   * W3JOIN job 5 (S2): `requests` sent AT ONCE (none awaited before the next is sent), as overlapping requests reach the
   * object. Each answer is returned in order; the storage record and counts are the whole group's.
   * W3JOIN job 6 (S4): and `own[i]`, request i's own storage record in its own order (its answer read whole included);
   * `stray`, any operation no request of the group owns.
   */
  const sendTogether = async requests => {
    for (const kind of Object.keys(storage.ops)) storage.ops[kind] = 0
    storage.log.length = 0
    storage.tagged.length = 0
    const answers = await Promise.all(requests.map(({ method, path: route, body }, index) => REQUEST.run(index, async () => {
      const response = await mirror.fetch(new Request(`https://x61.internal${route}`, {
        method, headers: { 'content-type': 'application/json', 'x-x6-internal-authorized': '1', 'x-x6-bootstrap-seed': SEED },
        ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
      }))
      const headers = JSON.stringify([...response.headers].sort(([x], [y]) => (x < y ? -1 : 1)))
      return { status: response.status, headers, text: await response.text() }
    })))
    const own = requests.map((_, index) => storage.tagged.filter(([tag]) => tag === index).map(([, entry]) => entry))
    const stray = storage.tagged.filter(([tag]) => tag === null).map(([, entry]) => entry)
    return { answers, ops: { ...storage.ops }, log: [...storage.log], own, stray }
  }
  return { storage, send, sendTogether, started, mirror }
}

const file = (text, mtimeMs = 1000) => ({ kind: 'file', mode: 0o644, mtimeMs, b64: Buffer.from(text).toString('base64') })
const fileOfBytes = (bytes, mtimeMs = 1000) => ({ kind: 'file', mode: 0o644, mtimeMs, b64: Buffer.from(bytes).toString('base64') })
const dir = () => ({ kind: 'dir', mode: 0o755 })
const gone = () => ({ kind: 'gone' })

/** The client's envelope (idb-persist.ts drain): `{v: 2, batch, digest}`; computed ONCE and sent to both sides. */
async function envelope(clientId, seq, entries, revision, lineageId = LINEAGE) {
  const batch = { id: `${clientId}:${seq}`, clientId, seq, entries, cloudBase: { lineageId, revision } }
  return { v: 2, batch, digest: await joined.mirrorDigest(batch) }
}

/**
 * Both sides, one request at a time. `both(name, request, {poison})` sends to main then joined and records every
 * difference of status, headers, body, storage counts or storage record in `findings`; the allow-list is EMPTY.
 * `poison` fails every wave 3 key on the JOINED side only (main has none): her app's answer must not depend on any of them.
 */
function pair(before, after, clock) {
  const findings = []
  const compared = []
  const both = async (name, request, { poison = false } = {}) => {
    clock.now += 1000
    const a = await before.send(request)
    const b = await after.send(request, { poison })
    if (b.status !== a.status) findings.push(`${name}: status main ${a.status} ${a.text.slice(0, 200)} / joined ${b.status} ${b.text.slice(0, 200)}`)
    if (b.headers !== a.headers) findings.push(`${name}: headers main ${a.headers} / joined ${b.headers}`)
    if (b.text !== a.text) findings.push(`${name}: body main ${a.text.slice(0, 200)} / joined ${b.text.slice(0, 200)}`)
    for (const kind of Object.keys(a.ops)) {
      if (b.ops[kind] !== a.ops[kind]) findings.push(`${name}: storage ${kind} main ${a.ops[kind]} / joined ${b.ops[kind]}`)
    }
    const at = a.log.findIndex((entry, index) => entry !== b.log[index])
    if (at >= 0 || a.log.length !== b.log.length) {
      const first = at >= 0 ? at : Math.min(a.log.length, b.log.length)
      findings.push(`${name}: storage record differs at operation ${first}: main ${String(a.log[first]).slice(0, 160)} / joined ${String(b.log[first]).slice(0, 160)}`)
    }
    for (const [label, sideOf] of [['main', before], ['joined', after]]) {
      if (sideOf.storage.refused.length) findings.push(`${name}: the ${label} side used storage the double does not implement: ${sideOf.storage.refused.splice(0).join('; ')}`)
    }
    compared.push([name, a.status, a.ops])
    let parsed = null
    try { parsed = JSON.parse(a.text) } catch { parsed = null }
    return parsed
  }
  /** W3JOIN job 5 (S2): overlapping requests, the same on both sides: every answer, and the group's storage record. */
  const together = async (name, requests) => {
    clock.now += 1000
    const a = await before.sendTogether(requests)
    const b = await after.sendTogether(requests)
    a.answers.forEach((answer, index) => {
      const other = b.answers[index], label = `${name} [${index}]`
      if (other.status !== answer.status) findings.push(`${label}: status main ${answer.status} ${answer.text.slice(0, 200)} / joined ${other.status} ${other.text.slice(0, 200)}`)
      if (other.headers !== answer.headers) findings.push(`${label}: headers main ${answer.headers} / joined ${other.headers}`)
      if (other.text !== answer.text) findings.push(`${label}: body main ${answer.text.slice(0, 200)} / joined ${other.text.slice(0, 200)}`)
      compared.push([label, answer.status, a.ops])
    })
    for (const kind of Object.keys(a.ops)) if (b.ops[kind] !== a.ops[kind]) findings.push(`${name}: storage ${kind} main ${a.ops[kind]} / joined ${b.ops[kind]}`)
    // W3JOIN job 6 (S4): the order BETWEEN two overlapping requests is not defined (it follows when each one's awaits
    // settle), so one total order is not compared. What is defined is compared exactly: each request's own storage record
    // in its own order, and the whole group's record as a multiset. Every operation must belong to one request.
    a.own.forEach((mine, index) => {
      const theirs = b.own[index], label = `${name} [${index}]`
      const at = mine.findIndex((entry, k) => entry !== theirs[k])
      if (at >= 0 || mine.length !== theirs.length) {
        const first = at >= 0 ? at : Math.min(mine.length, theirs.length)
        findings.push(`${label}: storage record differs at its operation ${first}: main ${String(mine[first]).slice(0, 160)} / joined ${String(theirs[first]).slice(0, 160)}`)
      }
    })
    const sorted = log => [...log].sort()
    if (JSON.stringify(sorted(a.log)) !== JSON.stringify(sorted(b.log))) findings.push(`${name}: the group's storage records differ as multisets`)
    for (const [label, sideOf] of [['main', a], ['joined', b]]) {
      if (sideOf.stray.length) findings.push(`${name}: the ${label} side made ${sideOf.stray.length} storage operations no request owns: ${sideOf.stray.slice(0, 3).join('; ')}`)
    }
    for (const [label, sideOf] of [['main', before], ['joined', after]]) {
      if (sideOf.storage.refused.length) findings.push(`${name}: the ${label} side used storage the double does not implement: ${sideOf.storage.refused.splice(0).join('; ')}`)
    }
    return a.answers.map(answer => { try { return JSON.parse(answer.text) } catch { return null } })
  }
  return { both, together, findings, compared }
}

async function sides(t) {
  const main = await loadMain()
  t.after(() => rm(main.root, { recursive: true, force: true }))
  assert.ok(main.files > 10, `main's module graph was extracted (${main.files} files)`)
  assert.notEqual(main.mod.MirrorDO, joined.MirrorDO, 'two separate module graphs')
  const clock = { now: T0 }
  t.mock.method(Date, 'now', () => clock.now)
  t.mock.method(globalThis.crypto, 'randomUUID', () => LINEAGE)
  const before = side(main.mod.MirrorDO)
  const after = side(joined.MirrorDO)
  // D3HOLDER job 4 (R1e): THE BUDGET of a world never claimed: main's constructor touches no storage; the joined one makes
  // exactly ONE read (the holder row) and nothing else; every request below must then cost exactly main's operations.
  await Promise.all([before.mirror.queue, after.mirror.queue])
  assert.deepEqual(before.started, { ops: { transaction: 0, get: 0, list: 0, put: 0, delete: 0 }, log: [], refused: [] }, 'main\'s constructor')
  assert.deepEqual(after.started, { ops: { transaction: 0, get: 1, list: 0, put: 0, delete: 0 }, log: ['get world:v1:holder'], refused: [] }, 'the joined constructor: one read')
  assert.deepEqual([before.storage.ops, after.storage.ops].map(ops => ops.transaction + ops.put + ops.delete + ops.list), [0, 0], 'and nothing after it settled')
  return { clock, before, after, ...pair(before, after, clock) }
}

/** Boot before a seed, then the real seed (HEAD's begin, batch, commit). */
async function seedBoth(both, entries) {
  await both('compact status before a seed', { method: 'GET', path: '/_mirror/status?compact=1' })
  await both('bootstrap status', { method: 'GET', path: '/_mirror/bootstrap-status', seed: false })
  const batchDigest = await digest(canonicalBootstrap(entries))
  assert.equal((await both('bootstrap begin', { method: 'POST', path: '/_mirror/bootstrap', seed: false, body: { action: 'begin', seedId: SEED, ballId: BALL, epoch: 2, mirror: { batchDigests: [batchDigest], entryCount: entries.length } } }))?.ok, true, 'the seed begins')
  assert.equal((await both('bootstrap batch', { method: 'POST', path: '/_mirror/bootstrap', seed: false, body: { action: 'batch', seedId: SEED, index: 0, entries } }))?.ok, true, 'the seed batch lands')
  assert.equal((await both('bootstrap commit', { method: 'POST', path: '/_mirror/bootstrap', seed: false, body: { action: 'commit', seedId: SEED } }))?.ok, true, 'the seed is committed')
}

/** The fence the app reads before a save. */
const fenceOf = async both => (await both('compact status', { method: 'GET', path: '/_mirror/status?compact=1' })).revision

test('W3JOIN MUST 3 (job 3: the allow-list is EMPTY): main\'s MIRROR and the joined MIRROR answer today\'s client byte for byte AND with the same storage record, full status included, while /rescue holds a lease and a home is pending', async t => {
  const { clock, before, after, both, findings, compared } = await sides(t)
  /** Joined side only (main has no such route): what /rescue and the Worker do in wave 3. */
  const only = async request => { clock.now += 1000; const out = await after.send(request); return { status: out.status, body: JSON.parse(out.text) } }

  await seedBoth(both, [['/dsh/home/auma', dir()], ['/dsh/home/auma/notes.md', file('her notes\n')], ['/dsh/home/auma/seed', dir()], ['/dsh/home/sessions', dir()], ['/dsh/home/sessions/agent', dir()], ['/dsh/home/sessions/agent/s1', dir()]])
  await both('boot: compact status', { method: 'GET', path: '/_mirror/status?compact=1' })
  await both('boot: full status', { method: 'GET', path: '/_mirror/status' })
  assert.equal((await both('boot: snapshot (the client\'s v2 read)', { method: 'GET', path: SNAPSHOT }))?.ok, true)

  // Joined only: /rescue takes the lease under ITS browser's id and imports one thread whose home is behind (pending).
  const acquired = await only({ method: 'POST', path: '/_mirror/lease', body: { input: { action: 'acquire', clientId: RESCUE, tabId: 'rescue-page', label: 'Rescue page' }, ownerApproved: false } })
  assert.equal(acquired.status, 200, JSON.stringify(acquired.body))
  const lease = { leaseId: acquired.body.lease.leaseId, generation: acquired.body.lease.generation }
  const threadPath = '/dsh/home/auma/session/messages.jsonl'
  const tail = Buffer.from('{"role":"user","text":"his line"}\n')
  const imported = await only({ method: 'POST', path: '/_mirror/thread', body: {
    op: 'import',
    input: { id: await threadIdForPath(threadPath), path: threadPath, piece: THREAD_PROTOCOL.piece, from: 0, prefixChain: '0'.repeat(64), parts: [], tail: bytesToBase64(tail), lineEnd: tail.length, sealedLineEnd: 0, expect: null, run: { client: RESCUE, from: 0 }, lease },
    home: { rescue: 'e'.repeat(32), clientId: RESCUE, base: { lineageId: '22222222-2222-4222-8222-222222222222', revision: 3 }, reconciliation: null, verifiedAt: '2026-11-12T11:00:00.000Z' },
  } })
  assert.equal(imported.status, 200, JSON.stringify(imported.body))
  const index = await only({ method: 'POST', path: '/_mirror/thread', body: { op: 'index', input: {} } })
  assert.equal(index.body.home.pending, true, 'a home is recorded as pending')
  assert.equal(index.body.lease.live, true, 'the /rescue lease is live while the app saves')

  // Today's client: deltas with files, folders and removals; a large file; a replayed batch; a sequence gap; an unknown
  // client; a stale base; conflicts; memory history; HEAD's wake checkpoint; status and snapshot again.
  const large = 'x'.repeat(5 * MIB + 17)
  const a1 = await envelope(A, 1, [['/dsh/home/auma/a.md', file('A one\n')], ['/dsh/home/auma/folder', dir()], ['/dsh/home/auma/folder/f.md', file('in a folder\n')]], 1)
  const r1 = await both('A seq 1: files and a folder', { method: 'POST', path: '/_mirror/delta', body: a1 })
  assert.equal(r1?.ok, true, 'the app saves while /rescue holds the lease')
  const a2 = await envelope(A, 2, [['/dsh/home/auma/a.md', gone()], ['/dsh/home/auma/big.bin', file(large)], ['/dsh/workspace/project', dir()]], 2)
  await both('A seq 2: a removal and a large file', { method: 'POST', path: '/_mirror/delta', body: a2 })
  await both('A seq 2 again: a replayed batch', { method: 'POST', path: '/_mirror/delta', body: a2 })
  await both('A seq 4: a sequence gap', { method: 'POST', path: '/_mirror/delta', body: await envelope(A, 4, [['/dsh/home/auma/gap.md', file('gap\n')]], 3) })
  await both('C seq 3: an unknown client past seq 1', { method: 'POST', path: '/_mirror/delta', body: await envelope(C, 3, [['/dsh/home/auma/c.md', file('C\n')]], 3) })
  await both('C seq 3: an unknown client on another lineage', { method: 'POST', path: '/_mirror/delta', body: await envelope(C, 3, [['/dsh/home/auma/c.md', file('C\n')]], 3, '33333333-3333-4333-8333-333333333333') })
  await both('B seq 1: a stale base', { method: 'POST', path: '/_mirror/delta', body: await envelope(B, 1, [['/dsh/home/auma/b.md', file('B\n')]], 1) })
  await both('B seq 1 with a lease reference it does not hold', { method: 'POST', path: '/_mirror/delta', body: { ...await envelope(B, 1, [['/dsh/home/auma/b.md', file('B\n')]], 3), lease } })
  for (const [name, id] of [['A', A], ['C', C], ['B', B]]) {
    const listed = await both(`conflicts of ${name}`, { method: 'GET', path: `/_mirror/conflicts?clientId=${id}` })
    assert.equal(listed?.ok, true)
  }
  await both('conflicts with no client id', { method: 'GET', path: '/_mirror/conflicts' })
  await both('memory history', { method: 'GET', path: '/_mirror/memory-history' })
  await both('wake checkpoint (HEAD) while /rescue holds the lease', { method: 'POST', path: '/_mirror/wake-checkpoint', body: { id: 'f'.repeat(64), at: 1000, head: { ballId: BALL, epoch: 2 }, evidence: [{ tool: 'inspectHeadWish', digest: 'd'.repeat(64) }] } })
  let fence = await fenceOf(both)
  await both('A seq 3 after the wake', { method: 'POST', path: '/_mirror/delta', body: await envelope(A, 3, [['/dsh/home/auma/after.md', file('after\n')]], fence) })

  // The reviewer's answer 2, case by case.
  // A deferred session journal near the size limit (24 MiB: MIRROR_LIMITS.fileBytes), alone in its batch; one byte
  // more is 413; a body past the request limit is 413; then a small save at once.
  const journalPath = '/dsh/home/sessions/agent/s1/session.v4.jsonl'
  const journalBytes = Buffer.alloc(24 * MIB, 0x61)
  journalBytes[journalBytes.length - 1] = 10
  fence = await fenceOf(both)
  assert.equal((await both('A seq 4: a deferred session journal at the file limit', { method: 'POST', path: '/_mirror/delta', body: await envelope(A, 4, [[journalPath, fileOfBytes(journalBytes)]], fence) }))?.ok, true)
  fence = await fenceOf(both)
  await both('A seq 5: the journal one byte over the file limit', { method: 'POST', path: '/_mirror/delta', body: await envelope(A, 5, [[journalPath, fileOfBytes(Buffer.concat([journalBytes, Buffer.from('\n')]))]], fence) })
  const half = Buffer.alloc(13 * MIB, 0x62)
  await both('A seq 5: a body past the request limit', { method: 'POST', path: '/_mirror/delta', body: await envelope(A, 5, [['/dsh/home/auma/h1.bin', fileOfBytes(half)], ['/dsh/home/auma/h2.bin', fileOfBytes(half)]], fence) })
  assert.equal((await both('A seq 5: a small save right after', { method: 'POST', path: '/_mirror/delta', body: await envelope(A, 5, [['/dsh/home/auma/small.md', file('small\n')]], fence) }))?.ok, true)

  // Secret-shaped `gone` entries (legacy outbox scrubbing): an entirely inert batch, then a mixed one.
  fence = await fenceOf(both)
  await both('A seq 6: an entirely inert batch of secret-shaped gone entries', { method: 'POST', path: '/_mirror/delta', body: await envelope(A, 6, [['/dsh/home/auma/.credentials.yaml.0123abcd.tmp', gone()], ['/dsh/home/auma/.credentials.yaml.lock', gone()]], fence) })
  fence = await fenceOf(both)
  await both('A seq 7: a mixed batch with a secret-shaped gone', { method: 'POST', path: '/_mirror/delta', body: await envelope(A, 7, [['/dsh/home/auma/.env.local', gone()], ['/dsh/home/auma/mixed.md', file('mixed\n')]], fence) })

  // A protected receipt append, then a refused history change (409 MIRROR_HISTORY_APPEND_ONLY).
  const receipts = '/dsh/home/auma/seed/receipts.v3.jsonl'
  fence = await fenceOf(both)
  await both('A seq 8: a protected receipt file', { method: 'POST', path: '/_mirror/delta', body: await envelope(A, 8, [[receipts, file('{"r":1}\n')]], fence) })
  fence = await fenceOf(both)
  await both('A seq 9: a protected receipt append', { method: 'POST', path: '/_mirror/delta', body: await envelope(A, 9, [[receipts, file('{"r":1}\n{"r":2}\n')]], fence) })
  fence = await fenceOf(both)
  await both('A seq 10: a refused history change', { method: 'POST', path: '/_mirror/delta', body: await envelope(A, 10, [[receipts, file('{"r":9}\n')]], fence) })

  // Subtree delete and recreate; file-to-folder replacement.
  fence = await fenceOf(both)
  await both('A seq 10: a subtree delete', { method: 'POST', path: '/_mirror/delta', body: await envelope(A, 10, [['/dsh/home/auma/folder/f.md', gone()], ['/dsh/home/auma/folder', gone()]], fence) })
  fence = await fenceOf(both)
  await both('A seq 11: the subtree recreated', { method: 'POST', path: '/_mirror/delta', body: await envelope(A, 11, [['/dsh/home/auma/folder', dir()], ['/dsh/home/auma/folder/g.md', file('again\n')]], fence) })
  fence = await fenceOf(both)
  await both('A seq 12: a file replaced by a folder', { method: 'POST', path: '/_mirror/delta', body: await envelope(A, 12, [['/dsh/home/auma/mixed.md', dir()], ['/dsh/home/auma/mixed.md/inside.md', file('inside\n')]], fence) })

  // A coalesced multi-batch resync: a new browser D sends two batches back to back on one base (the second conflicts),
  // then resyncs on the new fence.
  fence = await fenceOf(both)
  await both('D seq 1: first batch of a resync', { method: 'POST', path: '/_mirror/delta', body: await envelope(D, 1, [['/dsh/home/auma/d1.md', file('d1\n')]], fence) })
  await both('D seq 2: second batch on the same base', { method: 'POST', path: '/_mirror/delta', body: await envelope(D, 2, [['/dsh/home/auma/d2.md', file('d2\n')]], fence) })
  const resynced = await fenceOf(both)
  await both('D seq 2: the resync on the new fence', { method: 'POST', path: '/_mirror/delta', body: await envelope(D, 2, [['/dsh/home/auma/d2.md', file('d2\n')], ['/dsh/home/auma/d3.md', file('d3\n')]], resynced) })

  // A retry after receipt eviction: E saves 65 times (64 receipts are kept per browser), then retries its first batch.
  const e1 = await envelope(E, 1, [['/dsh/home/auma/e.md', file('e 1\n')]], await fenceOf(both))
  await both('E seq 1', { method: 'POST', path: '/_mirror/delta', body: e1 })
  for (let seq = 2; seq <= 65; seq++) await both(`E seq ${seq}`, { method: 'POST', path: '/_mirror/delta', body: await envelope(E, seq, [['/dsh/home/auma/e.md', file(`e ${seq}\n`)]], await fenceOf(both)) })
  await both('E seq 1 again after its receipt was evicted', { method: 'POST', path: '/_mirror/delta', body: e1 })

  // New storage failures: every wave 3 key fails on the joined side while the app saves, reads status and HEAD checkpoints.
  fence = await fenceOf(both)
  await both('A seq 13 while every wave 3 row fails', { method: 'POST', path: '/_mirror/delta', body: await envelope(A, 13, [['/dsh/home/auma/poison.md', file('still saved\n')]], fence) }, { poison: true })
  await both('compact status while every wave 3 row fails', { method: 'GET', path: '/_mirror/status?compact=1' }, { poison: true })
  await both('full status while every wave 3 row fails', { method: 'GET', path: '/_mirror/status' }, { poison: true })
  await both('wake checkpoint while every wave 3 row fails', { method: 'POST', path: '/_mirror/wake-checkpoint', body: { id: '9'.repeat(64), at: 2000, head: { ballId: BALL, epoch: 2 }, evidence: [{ tool: 'inspectHeadWish', digest: 'd'.repeat(64) }] } }, { poison: true })
  await both('snapshot while every wave 3 row fails', { method: 'GET', path: SNAPSHOT }, { poison: true })

  await both('full status at the end', { method: 'GET', path: '/_mirror/status' })
  assert.equal((await both('snapshot at the end (the client\'s v2 read)', { method: 'GET', path: SNAPSHOT }))?.ok, true)
  await both('snapshot at the end, old format after a removal', { method: 'GET', path: '/api/snapshot' })
  await both('a snapshot write', { method: 'POST', path: '/api/snapshot', body: {} })
  await both('a bad status query', { method: 'GET', path: '/_mirror/status?compact=2' })
  await both('a path main never had', { method: 'GET', path: '/_mirror/nothing-here' })

  assert.deepEqual(findings, [], `every difference from main:\n${findings.join('\n')}`)
  // The joined side's lease is still the rescue page's (it ran out on the clock only: over a hundred requests at one
  // second each, and /rescue never renews while idle): nothing in it was enforced against the app, nothing took it.
  assert.equal((await only({ method: 'POST', path: '/_mirror/thread', body: { op: 'index', input: {} } })).body.lease.label, 'Rescue page')
  // No app request wrote a wave 3 row: only /rescue's lease and import did (their own rows), no tombstone, no browser's
  // write time but the rescue page's own import.
  assert.deepEqual([...after.storage.data.keys()].filter(key => key.startsWith('world:v1:retired:')), [])
  assert.deepEqual(Object.keys(after.storage.data.get('world:v1:wrote') ?? {}), [RESCUE])
  // Every row outside the wave 3 namespaces ends equal on both sides.
  const rows = storage => Object.fromEntries([...storage.data].filter(([key]) => !WAVE3(key)).sort(([x], [y]) => (x < y ? -1 : 1)))
  assert.deepEqual(rows(after.storage), rows(before.storage))
  for (const [name, status, ops] of compared.filter(([name]) => /^(A seq 1: |A seq 2 again|A seq 3 after|full status at the end|wake checkpoint \(HEAD\)|E seq 1 again)/.test(name))) {
    t.diagnostic(`${name}: ${status}, main = joined: get ${ops.get}, list ${ops.list}, put ${ops.put}, delete ${ops.delete}`)
  }
  assert.ok(compared.length >= 100, `${compared.length} requests compared`)
  assert.ok(compared.filter(([, status]) => status === 409).length >= 5, 'the conflict answers were exercised')
  assert.ok(compared.filter(([, status]) => status === 413).length >= 2, 'the size refusals were exercised')
})

test('W3JOIN MUST 3a: the FULL TABLE (256 slots, an idle one among them): a new browser is 507 on both sides, nothing is retired, and the active browser\'s queued save is accepted on both', async t => {
  const { clock, before, after, both, findings } = await sides(t)
  await seedBoth(both, [['/dsh/home/auma', dir()]])
  // The idle browser saves first; 40 days later 254 more browsers and A fill the table (256 heads).
  let fence = await fenceOf(both)
  await both('the idle browser, 40 days ago', { method: 'POST', path: '/_mirror/delta', body: await envelope(client(1), 1, [['/dsh/home/auma/idle.md', file('idle\n')]], fence) })
  clock.now += 40 * DAY
  for (let index = 2; index <= 255; index++) {
    fence = await fenceOf(both)
    await both(`browser ${index}`, { method: 'POST', path: '/_mirror/delta', body: await envelope(client(index), 1, [[`/dsh/home/auma/n${index}.md`, file(`${index}\n`)]], fence) })
  }
  fence = await fenceOf(both)
  assert.equal((await both('A seq 1 (the 256th slot)', { method: 'POST', path: '/_mirror/delta', body: await envelope(A, 1, [['/dsh/home/auma/a.md', file('A\n')]], fence) }))?.ok, true)
  const R = await fenceOf(both)
  // A's next save is queued on R; B arrives first, on R.
  const queued = await envelope(A, 2, [['/dsh/home/auma/a.md', file('A two\n')]], R)
  const b1 = await both('B seq 1 at a full table', { method: 'POST', path: '/_mirror/delta', body: await envelope(B, 1, [['/dsh/home/auma/b.md', file('B\n')]], R) })
  assert.equal(b1?.code, 'MIRROR_CLIENT_LIMIT', 'main refuses the 257th browser')
  const a2 = await both('A seq 2, queued on R', { method: 'POST', path: '/_mirror/delta', body: queued })
  assert.equal(a2?.ok, true, 'main accepts the active browser\'s queued save')
  await both('full status after', { method: 'GET', path: '/_mirror/status' })
  assert.deepEqual(findings, [], `every difference from main:\n${findings.join('\n')}`)
  assert.equal([...after.storage.data.keys()].filter(key => key.startsWith('world:')).length, 0, 'no tombstone, no write time, no wave 3 row at all')
  assert.ok(after.storage.data.has('mirror:v2:head:' + client(1)), 'the idle browser keeps its slot')
})

test('W3JOIN job 5 S2: a save that commits and whose answer is lost, then replayed; saves overlapping with reads; descendants with special permissions; an immutable checkpoint replaced: main\'s answers at main\'s cost, the allow-list EMPTY', async t => {
  const { clock, before, after, both, together, findings, compared } = await sides(t)
  const only = async request => { clock.now += 1000; const out = await after.send(request); return { status: out.status, body: JSON.parse(out.text) } }
  const node = 'a'.repeat(64)
  // A read-only folder that already holds children (a restore), a private folder, and a private file in it.
  await seedBoth(both, [['/dsh/home/auma', dir()], ['/dsh/home/auma/locked', { kind: 'dir', mode: 0o555 }], ['/dsh/home/auma/locked/inside.md', file('kept\n')],
    ['/dsh/home/auma/private-ish', { kind: 'dir', mode: 0o700 }], ['/dsh/home/auma/private-ish/key.md', { ...file('mode 600\n'), mode: 0o600 }],
    ['/dsh/home/auma/memory', dir()], ['/dsh/home/auma/memory/dag', dir()], ['/dsh/home/auma/memory/dag/nodes', dir()], ['/dsh/home/auma/seed', dir()]].sort(([x], [y]) => (x < y ? -1 : 1)))
  // Joined only: /rescue holds a live lease and has imported a thread, as while the app works.
  const acquired = await only({ method: 'POST', path: '/_mirror/lease', body: { input: { action: 'acquire', clientId: RESCUE, tabId: 'rescue-page', label: 'Rescue page' }, ownerApproved: false } })
  assert.equal(acquired.status, 200, JSON.stringify(acquired.body))
  const lease = { leaseId: acquired.body.lease.leaseId, generation: acquired.body.lease.generation }
  const threadPath = '/dsh/home/auma/session/messages.jsonl'
  const tail = Buffer.from('{"role":"user","text":"his line"}\n')
  assert.equal((await only({ method: 'POST', path: '/_mirror/thread', body: { op: 'import',
    input: { id: await threadIdForPath(threadPath), path: threadPath, piece: THREAD_PROTOCOL.piece, from: 0, prefixChain: '0'.repeat(64), parts: [], tail: bytesToBase64(tail), lineEnd: tail.length, sealedLineEnd: 0, expect: null, run: { client: RESCUE, from: 0 }, lease } } })).status, 200)

  // 1. A save commits, its answer is lost; another browser saves; the first replays the SAME batch (after its lease-free
  // minute and a half), then goes on; a replay of an older batch on an old base.
  let fence = await fenceOf(both)
  const a1 = await envelope(A, 1, [['/dsh/home/auma/a.md', file('A one\n')]], fence)
  assert.equal((await both('A seq 1 (its answer is lost on the way back)', { method: 'POST', path: '/_mirror/delta', body: a1 }))?.ok, true)
  fence = await fenceOf(both)
  await both('B seq 1 in between', { method: 'POST', path: '/_mirror/delta', body: await envelope(B, 1, [['/dsh/home/auma/b.md', file('B\n')]], fence) })
  clock.now += 91000
  const replay = await both('A seq 1 replayed after its answer was lost', { method: 'POST', path: '/_mirror/delta', body: a1 })
  assert.equal(replay?.replayed, true, 'main answers the replay from its receipt')
  fence = await fenceOf(both)
  await both('A seq 2 after the replay', { method: 'POST', path: '/_mirror/delta', body: await envelope(A, 2, [['/dsh/home/auma/a.md', file('A two\n')]], fence) })
  await both('A seq 1 replayed again, two saves later', { method: 'POST', path: '/_mirror/delta', body: a1 })
  // The same batch sent twice at once (a retry racing its own original).
  fence = await fenceOf(both)
  const a3 = await envelope(A, 3, [['/dsh/home/auma/a3.md', file('A three\n')]], fence)
  await together('A seq 3 and its own retry at once', [{ method: 'POST', path: '/_mirror/delta', body: a3 }, { method: 'POST', path: '/_mirror/delta', body: a3 }])

  // 2. Saves overlapping with reads: every read the app makes, sent while two browsers' saves are in flight.
  fence = await fenceOf(both)
  await together('saves overlapping with status, snapshot, conflicts and history', [
    { method: 'POST', path: '/_mirror/delta', body: await envelope(A, 4, [['/dsh/home/auma/a4.md', file('A four\n')]], fence) },
    { method: 'GET', path: '/_mirror/status?compact=1' },
    { method: 'GET', path: SNAPSHOT },
    { method: 'POST', path: '/_mirror/delta', body: await envelope(B, 2, [['/dsh/home/auma/b2.md', file('B two\n')]], fence) },
    { method: 'GET', path: '/_mirror/status' },
    { method: 'GET', path: `/_mirror/conflicts?clientId=${B}` },
    { method: 'GET', path: '/_mirror/memory-history' },
    { method: 'GET', path: '/api/snapshot' },
  ])
  fence = await fenceOf(both)
  await together('a wake checkpoint overlapping a save and a snapshot', [
    { method: 'POST', path: '/_mirror/wake-checkpoint', body: { id: '7'.repeat(64), at: 3000, head: { ballId: BALL, epoch: 2 }, evidence: [{ tool: 'inspectHeadWish', digest: 'd'.repeat(64) }] } },
    { method: 'POST', path: '/_mirror/delta', body: await envelope(A, 5, [['/dsh/home/auma/a5.md', file('A five\n')]], fence) },
    { method: 'GET', path: SNAPSHOT },
  ])

  // 3. Descendants with special permissions. Browser D, on the current fence each time; its sequence moves only on a save
  // that was applied (a refused batch is sent again with the same number, as the client does).
  let seq = 1
  const save = async (name, entries) => {
    fence = await fenceOf(both)
    const answer = await both(name, { method: 'POST', path: '/_mirror/delta', body: await envelope(D, seq, entries, fence) })
    if (answer?.ok === true) seq += 1
    return answer?.ok === true ? 'applied' : answer?.code
  }
  const outcomes = {}
  const step = async (name, entries) => { outcomes[name] = await save(name, entries) }
  await step('a new file inside the read-only folder', [['/dsh/home/auma/locked/new.md', file('no\n')]])
  await step('a change to a file inside the read-only folder', [['/dsh/home/auma/locked/inside.md', file('changed\n')]])
  await step('a removal inside the read-only folder', [['/dsh/home/auma/locked/inside.md', gone()]])
  await step('the read-only folder made writable, then a child', [['/dsh/home/auma/locked', dir()], ['/dsh/home/auma/locked/new.md', file('now\n')]])
  await step('a private file\'s mode changed (600 to 644)', [['/dsh/home/auma/private-ish/key.md', file('mode 600\n')]])
  await step('a private folder made read-only with a child written after', [['/dsh/home/auma/private-ish', { kind: 'dir', mode: 0o500 }], ['/dsh/home/auma/private-ish/late.md', file('late\n')]])
  await step('a private folder made read-only', [['/dsh/home/auma/private-ish', { kind: 'dir', mode: 0o500 }]])
  await step('a child changed inside it', [['/dsh/home/auma/private-ish/key.md', file('changed\n')]])
  await step('a folder with a setuid-style mode', [['/dsh/home/auma/odd', { kind: 'dir', mode: 0o4755 }]])
  await step('a file with a mode past 777', [['/dsh/home/auma/odd.md', { ...file('odd\n'), mode: 0o1644 }]])
  await step('a write-only folder (300) and its child', [['/dsh/home/auma/drop', { kind: 'dir', mode: 0o300 }], ['/dsh/home/auma/drop/in.md', file('in\n')]])
  await step('a read-only folder removed with its children', [['/dsh/home/auma/private-ish', gone()]])

  // 4. An immutable checkpoint (a memory DAG node) and the append-only checkpoint journal: written, then replaced.
  const nodePath = `/dsh/home/auma/memory/dag/nodes/${node}.json`
  await step('a DAG node written', [[nodePath, file('{"n":1}\n')]])
  await step('the DAG node replaced (same length)', [[nodePath, file('{"n":2}\n')]])
  await step('the DAG node replaced (longer)', [[nodePath, file('{"n":1}\n{"n":2}\n')]])
  await step('the DAG node removed', [[nodePath, gone()]])
  await step('the DAG node replaced by a folder', [[nodePath, dir()]])
  await step('the DAG node written again unchanged', [[nodePath, file('{"n":1}\n')]])
  const checkpoints = '/dsh/home/auma/seed/checkpoints.v1.jsonl'
  await step('the checkpoint journal written', [[checkpoints, file('{"c":1}\n')]])
  await step('the checkpoint journal appended', [[checkpoints, file('{"c":1}\n{"c":2}\n')]])
  await step('the checkpoint journal replaced', [[checkpoints, file('{"c":9}\n{"c":2}\n')]])
  await step('the checkpoint journal truncated', [[checkpoints, file('{"c":1}\n')]])
  await step('the seed folder removed with the journal in it', [['/dsh/home/auma/seed', gone()]])

  await both('full status at the end', { method: 'GET', path: '/_mirror/status' })
  await both('snapshot at the end', { method: 'GET', path: SNAPSHOT })
  assert.deepEqual(findings, [], `every difference from main:\n${findings.join('\n')}`)
  const rows = storage => Object.fromEntries([...storage.data].filter(([key]) => !WAVE3(key)).sort(([x], [y]) => (x < y ? -1 : 1)))
  assert.deepEqual(rows(after.storage), rows(before.storage))
  const statuses = new Set(compared.map(([, status]) => status))
  assert.ok(statuses.has(409) && statuses.has(400) && statuses.has(200), `refusals and saves exercised: ${[...statuses].join(',')}`)
  assert.ok(compared.filter(([name]) => /replayed/.test(name)).length >= 2)
  // Main's own answers (both sides gave the same, above): each case reached the rule it names.
  const W = 'MIRROR_PARENT_NOT_WRITABLE', H = 'MIRROR_HISTORY_APPEND_ONLY', M = 'INVALID_MIRROR_MODE'
  assert.deepEqual(Object.values(outcomes), [W, W, W, 'applied', 'applied', W, 'applied', W, M, M, 'applied', 'applied',
    'applied', H, H, H, H, 'applied', 'applied', 'applied', H, H, H], JSON.stringify(outcomes))
})
