/**
 * One run with nothing fake between the parts. The REAL Worker (`createWorker`, a real passkey session),
 * the REAL HEAD and the REAL MirrorDO behind EVERY MIRROR path (lease, thread, world budget, delta, status), the REAL
 * vault and thread log over one in-memory R2 bucket, and the REAL rescue kit (rescue-kit.mjs) driven as the join's own tests
 * drive it. Only the outsides are fixtures: his browser's IndexedDB (FakeIndexedDb) and R2's storage (createVaultBucket,
 * with R2's ranged get added below). No WRITER_LEASE and no HOME_FREEZE setting: the deployment's default mode.
 *
 * Step 3.4 is here too: after a join run ends (success, a refused import, a thrown error, a tab closed with no
 * pagehide), a home save from the app's own client is accepted, and the lease is gone or has run out.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import { isoCBOR } from '@simplewebauthn/server/helpers'
import { AUMLOK_STORAGE_KEY } from '../aumlok.mjs'
import { X61HeadDurableObject, bootstrapPackage, digest, manifestIdCanon } from '../head-do.mjs'
import { MirrorDO, mirrorDigest } from '../mirror-do.mjs'
import { createWorker, OWNER_PASSKEY } from '../worker.mjs'
import { rescueKit } from '../rescue-kit.mjs'
import { WORLD_LEASE } from '../world-lease.mjs'
import { createThreadMount } from '../thread-mount.mjs'
import { FakeIndexedDb, dirEntry, fileEntry } from './rescue-fakes.mjs'
import { createVaultBucket } from './vault-fakes.mjs'

const ORIGIN = 'https://w3-join.example.invalid'
const OWNER = 'owner@example.invalid'
const DB = 'aukora-x6-vfs'
const PIECE = 2097152
const HIS = '1b4e28ba-2fa1-41d2-883f-0016d3cca427'
const SECOND = '6fa459ea-ee8a-4ca4-894e-db77e160355e'
const EMPTY = '/dsh/home/sessions/agent/e/session.v1.jsonl'
const LONG = '/dsh/home/sessions/agent/l/session.v1.jsonl'
const WIDE = '/dsh/home/auma/session/messages.jsonl'
const encoder = new TextEncoder()
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const keyHex = key => key.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex')
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url')

/** A journal of whole JSON lines, exactly `size` bytes, ending in a newline. */
function journal(size, tag) {
  const out = new Uint8Array(size)
  let at = 0, n = 0
  while (at < size) {
    const line = encoder.encode(`{"role":"user","t":"${tag}","n":${n++},"text":"a line of his conversation"}\n`)
    out.set(line.subarray(0, Math.min(line.length, size - at)), at)
    at += line.length
  }
  out[size - 1] = 10
  return out
}
/** A short journal whose open end holds one line over 256 KiB. */
function wideJournal() {
  const head = encoder.encode('{"role":"user","text":"short"}\n')
  const line = encoder.encode(`{"role":"assistant","text":"${'w'.repeat(300 * 1024)}"}\n`)
  const out = new Uint8Array(head.length + line.length)
  out.set(head)
  out.set(line, head.length)
  return out
}
const J_LONG = journal(2 * PIECE + 1000, 'long')
const J_WIDE = wideJournal()

/** His store as idb-persist leaves it: the three journals and his mirror client id. */
function hisStore(clientId = HIS) {
  const idb = new FakeIndexedDb()
  idb.seed(DB, [['/dsh/home', dirEntry()], ['/dsh/home/auma', dirEntry()], ['/dsh/home/auma/session', dirEntry()], ['/dsh/home/sessions', dirEntry()],
    ['/dsh/home/sessions/agent', dirEntry()], ['/dsh/home/auma/notes.md', fileEntry('notes')],
    [EMPTY, fileEntry(new Uint8Array(0))], [LONG, fileEntry(J_LONG)], [WIDE, fileEntry(J_WIDE)],
    ['@x6-mirror-meta', { clientId, cloudBase: { lineageId: 'L1', revision: 7 } }]])
  return idb
}

/** Durable Object storage in memory: transactions one at a time, staged, dropped on throw; listing honours start/startAfter. */
function createStorage() {
  const data = new Map()
  let tail = Promise.resolve()
  const listOf = (read, { prefix = '', start, startAfter, limit = Infinity } = {}) => {
    const out = new Map()
    for (const key of read.keys().filter(key => key.startsWith(prefix) && (start === undefined || key >= start) && (startAfter === undefined || key > startAfter)).sort()) {
      if (out.size >= limit) break
      out.set(key, read.get(key))
    }
    return out
  }
  const direct = { keys: () => [...data.keys()], get: key => structuredClone(data.get(key)) }
  return {
    data,
    get: async key => direct.get(key),
    put: async (key, value) => { data.set(key, structuredClone(value)) },
    delete: async key => data.delete(key),
    list: async options => listOf(direct, options),
    getAlarm: async () => null, setAlarm: async () => {}, deleteAlarm: async () => {},
    transaction(fn) {
      const run = tail.then(async () => {
        const writes = new Map(), deletes = new Set()
        const read = {
          keys: () => [...new Set([...data.keys(), ...writes.keys()])].filter(key => !deletes.has(key) || writes.has(key)),
          get: key => (writes.has(key) ? structuredClone(writes.get(key)) : deletes.has(key) ? undefined : structuredClone(data.get(key))),
        }
        const view = {
          get: async key => read.get(key),
          put: async (key, value) => { deletes.delete(key); writes.set(key, structuredClone(value)) },
          delete: async key => { const had = read.get(key) !== undefined; writes.delete(key); deletes.add(key); return had },
          list: async options => listOf(read, options),
          getAlarm: async () => null, setAlarm: async () => {}, deleteAlarm: async () => {},
        }
        const result = await fn(view)
        for (const key of deletes) if (!writes.has(key)) data.delete(key)
        for (const [key, value] of writes) data.set(key, value)
        return result
      })
      tail = run.catch(() => {})
      return run
    },
  }
}

/** R2 in memory: the vault's fake bucket, plus R2's ranged get (`range`: the body and arrayBuffer are that range). */
function r2() {
  const bucket = createVaultBucket()
  const streamOf = bytes => new ReadableStream({ start(controller) { if (bytes.byteLength) controller.enqueue(Uint8Array.from(bytes)); controller.close() } })
  return {
    objects: bucket.objects,
    put: (key, value, options) => bucket.put(key, value, options),
    head: key => bucket.head(key),
    list: options => bucket.list(options),
    delete: key => bucket.delete(key),
    async get(key, options = {}) {
      const object = await bucket.get(key)
      if (!object || !options.range) return object
      const whole = new Uint8Array(await object.arrayBuffer())
      const offset = options.range.offset ?? 0
      const bytes = whole.slice(offset, offset + (options.range.length ?? whole.length - offset))
      return { ...object, range: { offset, length: bytes.byteLength }, body: streamOf(bytes), arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) }
    },
  }
}

function passkeyPair() {
  const key = generateKeyPairSync('ec', { namedCurve: 'P-256' }), jwk = key.publicKey.export({ format: 'jwk' })
  const id = randomBytes(32).toString('base64url')
  const publicKeyB64 = Buffer.from(isoCBOR.encode(new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]]))).toString('base64url')
  return { key, id, publicKeyB64 }
}
const assertionFor = (passkey, challenge) => {
  const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge, origin: ORIGIN, crossOrigin: false }))
  const auth = Buffer.alloc(37)
  createHash('sha256').update(new URL(ORIGIN).hostname).digest().copy(auth); auth[32] = 0x05; auth.writeUInt32BE(0, 33)
  const signature = sign('sha256', Buffer.concat([auth, createHash('sha256').update(clientDataJSON).digest()]), passkey.key.privateKey)
  return { id: passkey.id, rawId: passkey.id, type: 'public-key', clientExtensionResults: {}, response: { clientDataJSON: clientDataJSON.toString('base64url'),
    authenticatorData: auth.toString('base64url'), signature: signature.toString('base64url') } }
}

/**
 * Her edge, whole: a seeded world, a bound passkey and a signed-in session. `browser(path, init)` is one browser's
 * fetch (her origin, same-origin, his cookie) and records `METHOD path` in `routes`; `mirror` records every internal
 * MIRROR path the Worker called.
 */
async function herEdge(t) {
  const clock = { now: Date.now() }
  t.mock.method(Date, 'now', () => clock.now)
  const headStorage = createStorage(), mirrorStorage = createStorage()
  const owner = generateKeyPairSync('ed25519'), node = generateKeyPairSync('ed25519'), passkey = passkeyPair()
  const at = clock.now
  const identity = { schema: 'aukora.aumlok.state.v2', generation: 1,
    binding: { aumlokId: 'a'.repeat(64), recoveryCommitment: 'b'.repeat(64), nodePubkeyHex: keyHex(node),
      rootEscrow: { schema: 'aukora.aumlok.escrow.v2', ivB64: Buffer.alloc(12, 1).toString('base64url'), ciphertextB64: Buffer.alloc(48, 2).toString('base64url') },
      credential: { id: passkey.id, counter: 0, publicKeyB64: passkey.publicKeyB64 }, boundAt: at, lastVerifiedAt: at, generation: 1 },
    'pepper.v1': randomBytes(32).toString('base64url'), challenges: [], invites: [], revocations: [], failures: 0, failedAt: [], nextAllowedAt: 0, attempts: [], approvals: [] }
  const bucket = r2()
  const env = { PUBLIC_HOST: new URL(ORIGIN).host, OWNER_EMAIL: OWNER, OWNER_PUBLIC_KEY_HEX: keyHex(owner), ARCHIVE_BUCKET: bucket }
  let network = 0
  const noNetwork = async () => { network++; throw new Error('Network forbidden in this fixture') }
  t.after(() => assert.equal(network, 0, 'no network call'))
  const head = new X61HeadDurableObject({ storage: headStorage, getWebSockets: () => [] }, env, { networkFetch: noNetwork })
  const mirror = new MirrorDO({ storage: mirrorStorage }, env)
  const mirrorCalls = []
  env.HEAD = { idFromName: value => value, get: () => ({ fetch: request => head.fetch(request) }) }
  env.MIRROR = { idFromName: value => value, get: () => ({ fetch: request => { mirrorCalls.push(new URL(request.url).pathname); return mirror.fetch(request) } }) }
  env.ASSETS = { fetch() { return new Response('Fixture asset') } }
  const worker = createWorker({ networkFetch: noNetwork })
  const jwt = () => {
    const payload = encode({ alg: 'EdDSA', typ: 'JWT' }) + '.' + encode({ iss: 'aukora.x61.owner', aud: env.PUBLIC_HOST, email: OWNER,
      nbf: Math.floor(Date.now() / 1000) - 1, exp: Math.floor(Date.now() / 1000) + 600 })
    return payload + '.' + sign(null, Buffer.from(payload), owner.privateKey).toString('base64url')
  }
  const raw = (path, { method = 'GET', body, headers = {} } = {}) => worker.fetch(new Request(new URL(path, ORIGIN), { method,
    headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'cf-connecting-ip': '203.0.113.40', ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) }), env)
  const source = 'export const fixture = true;', moduleSha = await digest(source)
  const draft = { version: 'x6.1-ball/v1', epoch: 1, parentBallId: null, authorPeerId: 'fixture-peer',
    entries: { fixture: { id: 'fixture', specifier: `ball:${moduleSha}`, disabled: false, config: {}, previousSpecifiers: [] } },
    modules: { [moduleSha]: { sha256: moduleSha, specifier: `ball:${moduleSha}` } } }
  const seed = await bootstrapPackage({ version: 'x61-bootstrap/v1', ball: { ...draft, ballId: await manifestIdCanon(draft) }, codeBySha: { [moduleSha]: source }, mirror: { entryCount: 0, batchDigests: [] } })
  for (const input of [{ action: 'prepare', package: seed }, { action: 'commit', seedId: seed.seedId }]) {
    const result = await raw('/_bootstrap', { method: 'POST', body: input, headers: { 'x-x6-owner-assertion': jwt() } })
    assert.equal(result.status, 200, await result.text())
  }
  await headStorage.put(AUMLOK_STORAGE_KEY, identity)
  const issued = await (await raw(OWNER_PASSKEY.challenge, { method: 'POST', body: {} })).json()
  const signed = await raw(OWNER_PASSKEY.signin, { method: 'POST', body: { challengeId: issued.challengeId, credential: assertionFor(passkey, issued.publicKey.challenge) } })
  assert.equal(signed.status, 200, await signed.clone().text())
  const cookie = signed.headers.get('set-cookie').split(';')[0]
  const routes = []
  /** One browser's fetch, as the kit and the app call it: (path, init). */
  const browser = async (input, init = {}) => {
    const url = new URL(String(input), ORIGIN)
    const method = String(init.method ?? 'GET').toUpperCase()
    routes.push(`${method} ${url.pathname}`)
    const headers = { origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'cf-connecting-ip': '203.0.113.40', cookie, ...(init.headers ?? {}) }
    return worker.fetch(new Request(url, { method, headers, ...(init.body === undefined || init.body === null ? {} : { body: init.body }) }), env)
  }
  const json = async (path, init) => { const response = await browser(path, init); return { status: response.status, body: await response.json() } }
  return { clock, env, bucket, mirror, mirrorStorage, mirrorCalls, routes, browser, json }
}

const kitOf = (edge, idb) => rescueKit({ indexedDB: idb, localStorage: null, fetch: edge.browser, piece: PIECE, sleep: async () => {}, now: () => edge.clock.now })
/** The kit's own clock words (rescue-kit.mjs hhmm, hhmmss): local time, to the minute and to the second. */
const hhmm = ms => { const d = new Date(ms); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') }
const hhmmss = ms => `${hhmm(ms)}:${String(new Date(ms).getSeconds()).padStart(2, '0')}`
const count = list => list.reduce((out, item) => ({ ...out, [item]: (out[item] ?? 0) + 1 }), {})
/** One phase's requests by route, browser side and inside MIRROR: a blob's sha and a rescue's id are named by kind, never by value. */
const routeOf = (route, rescueId) => route.replace(/\/_vault\/blob\/[0-9a-f]{64}$/, '/_vault/blob/*').split(`/${rescueId}`).join('/<id>')
const phases = edge => {
  let routesAt = 0, mirrorAt = 0
  return rescueId => {
    const out = { browser: count(edge.routes.slice(routesAt).map(route => routeOf(route, rescueId))), mirror: count(edge.mirrorCalls.slice(mirrorAt)) }
    routesAt = edge.routes.length
    mirrorAt = edge.mirrorCalls.length
    return out
  }
}

/** The app's own home save (idb-persist.ts drain), at the fence the edge shows now. */
async function homeSave(edge, clientId, seq, text) {
  const fence = (await edge.json('/_mirror/status?compact=1')).body
  const batch = { id: `${clientId}:${seq}`, clientId, seq, entries: [[`/dsh/home/auma/${clientId.slice(0, 4)}-${seq}.md`, { kind: 'file', mode: 0o644, mtimeMs: 1, b64: Buffer.from(text).toString('base64') }]],
    cloudBase: { lineageId: fence.lineageId, revision: fence.revision } }
  return edge.json('/_mirror/delta', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ v: 2, batch, digest: await mirrorDigest(batch) }) })
}
const leaseNow = async edge => (await edge.json('/_thread/index')).body.lease

test('copy, join three threads (0 bytes, two pieces, a line over 256 KiB), the state line, Check each, release; then a second browser saves', async t => {
  const edge = await herEdge(t)
  const idb = hisStore()
  const kit = kitOf(edge, idb)
  const phase = phases(edge)
  const seen = {}
  seen.setup = phase()

  const copied = await kit.copyToCloud()
  assert.equal(copied.complete, true, copied.line)
  seen.copy = phase(copied.id)

  const joined = await kit.joinThreads({ clientId: HIS, rescueId: copied.id })
  assert.equal(joined.ok, true, joined.line)
  assert.deepEqual(Object.fromEntries(joined.rows.map(row => [row.path, row.outcome])), { [EMPTY]: 'empty, nothing to join', [LONG]: 'imported', [WIDE]: 'imported' })
  assert.equal(joined.equal, 3)
  assert.equal(joined.total, 3)
  assert.equal(joined.line, `At ${hhmm(edge.clock.now)} her cloud showed 3 of 3 threads with the same content as this copy.`)
  assert.equal(joined.done, true)
  seen.join = phase(copied.id)
  assert.equal(await leaseNow(edge), null, 'the lease is released at the end of the join')
  seen.leaseRead = phase(copied.id)

  // The state line, as a page that opens /rescue reads it.
  const state = await kit.cloudState({ clientId: HIS })
  // An open's read is said to the second; its count is the join's.
  assert.equal(state.line, `At ${hhmmss(edge.clock.now)} her cloud showed 3 of 3 threads with the same content as this copy.`)
  assert.deepEqual([state.equal, state.total], [joined.equal, joined.total])
  seen.state = phase(copied.id)

  // Check each thread from her cloud (as on a phone: the store plays no part). The second press compares
  // first, so both threads are "same" with no import call.
  const rows = (await kit.joinThreads({ clientId: HIS, rescueId: copied.id })).rows
  assert.deepEqual(rows.map(row => row.outcome).sort(), ['empty, nothing to join', 'same', 'same'])
  seen.rejoin = phase(copied.id)
  const long = rows.find(row => row.path === LONG)
  const longCheck = await kit.checkThread({ id: long.id, title: long.title, rescue: long.rescue })
  assert.equal(longCheck.equal, true, longCheck.line)
  assert.equal(longCheck.line, `Read back from her cloud: ${J_LONG.length} bytes, SHA-256 ${sha(J_LONG)}, every piece equal.`)
  seen.checkLong = phase(copied.id)
  const wide = rows.find(row => row.path === WIDE)
  const wideCheck = await kit.checkThread({ id: wide.id, title: wide.title, rescue: wide.rescue })
  assert.notEqual(wideCheck.equal, true, 'a line over 256 KiB at the open end is never called equal from a partial read')
  assert.ok([wideCheck.line, ...wideCheck.lines].some(line => /^Not (fully )?checked/.test(line)), JSON.stringify(wideCheck))
  seen.checkWide = phase(copied.id)
  const empty = rows.find(row => row.path === EMPTY)
  assert.equal(empty.id ?? null, null, 'a 0-byte journal never became a thread')

  // Inside MIRROR: one lease row, free; the two threads at their bytes; the home recorded pending (his base is behind).
  const index = (await edge.json('/_thread/index')).body
  assert.equal(index.lease, null)
  assert.equal(index.home.pending, true)
  assert.equal(index.home.freeze, 'record')
  assert.deepEqual(index.threads.map(thread => thread.bytes).sort((a, b) => a - b), [J_WIDE.length, J_LONG.length].sort((a, b) => a - b))
  seen.index = phase(copied.id)

  // A second browser's home save, in the default mode: accepted.
  const second = await homeSave(edge, SECOND, 1, 'from the second browser\n')
  assert.equal(second.status, 200, JSON.stringify(second.body))
  assert.equal(second.body.ok, true)
  seen.homeSave = phase(copied.id)

  // Every request, by phase and route, on both sides of the Worker. Each /_mirror/thread call holds MIRROR's one queue in
  // front of her app's saves, so a phase that starts asking MIRROR more often must fail here, not pass unnoticed.
  const bs = n => ({ '/_mirror/bootstrap-status': n })
  const rescueReads = { 'GET /_vault/rescue': 1, 'GET /_vault/rescue/<id>': 1 }
  // A press reads her thread index twice, under its turn: once before any import (what each journal is
  // compared with) and once before the release (the final read its lines come from). A journal her cloud already shows
  // with this copy's content costs no import: the second press (`rejoin`) sends none.
  const joinRun = { browser: { ...rescueReads, 'POST /_mirror/lease': 2, 'POST /_thread/import': 2, 'GET /_thread/index': 2 },
    mirror: { ...bs(8), '/_mirror/lease': 2, '/_mirror/thread': 6 } }
  const rejoinRun = { browser: { ...rescueReads, 'POST /_mirror/lease': 2, 'GET /_thread/index': 2 },
    mirror: { ...bs(6), '/_mirror/lease': 2, '/_mirror/thread': 2 } }
  const indexRead = { browser: { 'GET /_thread/index': 1 }, mirror: { ...bs(1), '/_mirror/thread': 1 } }
  assert.deepEqual(seen, {
    setup: { browser: {}, mirror: { ...bs(4), '/_mirror/bootstrap': 2 } },
    copy: { browser: { 'HEAD /_vault/blob/*': 6, 'PUT /_vault/blob/*': 6, 'PUT /_vault/rescue/<id>': 1, 'POST /_vault/rescue/<id>/verify': 1,
      'GET /_vault/rescue/<id>': 1, 'GET /_vault/blob/*': 6 }, mirror: { ...bs(21), '/_mirror/world/budget': 12 } },
    join: joinRun,
    leaseRead: indexRead,
    state: { browser: { ...rescueReads, 'GET /_thread/index': 1 }, mirror: { ...bs(3), '/_mirror/thread': 1 } },
    rejoin: rejoinRun,
    checkLong: { browser: { 'GET /_thread/manifest': 1, 'GET /_vault/blob/*': 2, 'GET /_thread/tail': 2 }, mirror: { ...bs(5), '/_mirror/thread': 5 } },
    checkWide: { browser: { 'GET /_thread/manifest': 1, 'GET /_thread/tail': 2 }, mirror: { ...bs(3), '/_mirror/thread': 5 } },
    index: indexRead,
    homeSave: { browser: { 'GET /_mirror/status': 1, 'POST /_mirror/delta': 1 }, mirror: { ...bs(2), '/_mirror/status': 1, '/_mirror/delta': 1 } },
  })
  assert.deepEqual(count(edge.mirrorCalls), { '/_mirror/bootstrap-status': 54, '/_mirror/bootstrap': 2, '/_mirror/world/budget': 12,
    '/_mirror/lease': 4, '/_mirror/thread': 21, '/_mirror/status': 1, '/_mirror/delta': 1 }, 'whole run, inside MIRROR')
})

test('a verified manifest with no readable verifiedAt is not a rescue to import: 404 RESCUE_UNKNOWN, and MIRROR is never asked', async t => {
  const edge = await herEdge(t)
  const copied = await kitOf(edge, hisStore()).copyToCloud()
  assert.equal(copied.complete, true, copied.line)
  const key = `w/node-main-v1/rescue/${copied.id}/manifest.json`
  const manifest = JSON.parse(new TextDecoder().decode(edge.bucket.objects.get(key).bytes))
  delete manifest.verifiedAt
  edge.bucket.objects.get(key).bytes = encoder.encode(JSON.stringify(manifest))
  const taken = await edge.json('/_mirror/lease', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'acquire', clientId: HIS, tabId: 'page', label: 'Rescue page' }) })
  const threadCalls = edge.mirrorCalls.filter(path => path === '/_mirror/thread').length
  const imported = await edge.json('/_thread/import', { method: 'POST', headers: { 'content-type': 'application/json', 'x-thread-lease': `${taken.body.lease.leaseId}.${taken.body.lease.generation}` },
    body: JSON.stringify({ path: LONG, rescue: copied.id }) })
  assert.deepEqual([imported.status, imported.body.code], [404, 'RESCUE_UNKNOWN'])
  assert.equal(edge.mirrorCalls.filter(path => path === '/_mirror/thread').length, threadCalls, 'no thread call reached MIRROR')
})

test('after a join run ends (success, a refused import, a thrown error, a tab closed with no pagehide), the app saves and the lease is gone or has run out', async t => {
  const edge = await herEdge(t)
  const idb = hisStore()
  const copied = await kitOf(edge, idb).copyToCloud()
  assert.equal(copied.complete, true, copied.line)
  let seq = 0
  const appSaves = async why => {
    const saved = await homeSave(edge, SECOND, ++seq, `${why}\n`)
    assert.equal(saved.status, 200, `${why}: ${JSON.stringify(saved.body)}`)
  }

  // A refused import (the edge answers the first import with a refusal the kit cannot retry).
  const refusing = { ...edge, browser: async (input, init = {}) => {
    if (String(input).startsWith('/_thread/import')) return Response.json({ ok: false, code: 'IMPORT_NOT_PREFIX' }, { status: 409 })
    return edge.browser(input, init)
  } }
  const refused = await kitOf(refusing, idb).joinThreads({ clientId: HIS, rescueId: copied.id })
  assert.ok(refused.rows.some(row => row.outcome.startsWith('not done')), JSON.stringify(refused.rows))
  assert.equal(await leaseNow(edge), null, 'a refused import: released')
  await appSaves('after a join whose import was refused')

  // A thrown error (the network fails under the first import).
  const failing = { ...edge, browser: async (input, init = {}) => {
    if (String(input).startsWith('/_thread/import')) throw new TypeError('Failed to fetch')
    return edge.browser(input, init)
  } }
  await kitOf(failing, idb).joinThreads({ clientId: HIS, rescueId: copied.id }).catch(() => null)
  assert.equal(await leaseNow(edge), null, 'a thrown error: released')
  await appSaves('after a join that threw')

  // Success (after the two presses above, which joined nothing, so this one still sends its imports).
  const done = await kitOf(edge, idb).joinThreads({ clientId: HIS, rescueId: copied.id })
  assert.equal(done.ok, true, done.line)
  assert.equal(done.done, true, done.line)
  assert.equal(await leaseNow(edge), null, 'success: released')
  await appSaves('after a join that succeeded')

  // A tab closed with no pagehide: the page took the lease under his browser's id, imported, and never released.
  const taken = await edge.json('/_mirror/lease', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'acquire', clientId: HIS, tabId: 'closed-tab', label: 'Rescue page' }) })
  assert.equal(taken.status, 200, JSON.stringify(taken.body))
  const imported = await edge.json('/_thread/import', { method: 'POST', headers: { 'content-type': 'application/json', 'x-thread-lease': `${taken.body.lease.leaseId}.${taken.body.lease.generation}` },
    body: JSON.stringify({ path: LONG, rescue: copied.id }) })
  assert.equal(imported.status, 200, JSON.stringify(imported.body))
  assert.equal((await leaseNow(edge)).live, true)
  await appSaves('while a closed tab still holds the lease')
  edge.clock.now += WORLD_LEASE.ttlMs + 1
  assert.equal((await leaseNow(edge)).live, false, 'the lease has run out by itself')
  await appSaves('after the closed tab\'s lease ran out')
})

// A multi-step import whose lease runs out BETWEEN two steps. Her edge whole, as above; only the
// import requests go through a second thread mount (the same createThreadMount the Worker holds) whose step is ONE piece,
// so a two-piece journal is imported in two steps (the Worker's step is 1,024 pieces; no journal here is that long).
test('the lease runs out between two import steps: the committed prefix stays valid, the next step is refused, Check reports the thread truthfully in between, and a later join continues from the prefix', async t => {
  const edge = await herEdge(t)
  const idb = hisStore()
  const copied = await kitOf(edge, idb).copyToCloud()
  assert.equal(copied.complete, true, copied.line)
  const seedId = edge.mirrorStorage.data.get('mirror:bootstrap:v1').seedId
  const stepped = createThreadMount({ importStep: 1 })
  const stepping = { ...edge, browser: async (input, init = {}) => {
    const url = new URL(String(input), ORIGIN)
    if (url.pathname !== '/_thread/import') return edge.browser(input, init)
    edge.routes.push(`POST ${url.pathname}`)
    const request = new Request(url, { method: 'POST', headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin', ...(init.headers ?? {}) }, body: init.body })
    return stepped.handle({ request, url, env: edge.env, ready: true, seedId, access: { type: 'owner' }, now: () => edge.clock.now })
  } }
  // Between the first and the second step of the long journal, the clock passes the lease's whole life: EVERY time that
  // step is sent (the Join takes its turn again once and retries the journal once; lost again, it stops).
  // The wide journal's step takes 25 s, so the Join renews its turn through the real Worker before the long journal.
  const steps = [], stepLeases = []
  const mirrorOf = edge.env.MIRROR
  edge.env.MIRROR = { idFromName: mirrorOf.idFromName, get: id => {
    const stub = mirrorOf.get(id)
    return { fetch: async request => {
      if (new URL(request.url).pathname === '/_mirror/thread') {
        const body = await request.clone().json()
        if (body.op === 'import') {
          steps.push([body.input.path, body.input.from])
          stepLeases.push(body.input.lease.generation)
          if (body.input.path === WIDE) edge.clock.now += 25000
          if (body.input.path === LONG && body.input.from === 1) edge.clock.now += WORLD_LEASE.ttlMs + 1
        }
      }
      return stub.fetch(request)
    } }
  } }
  const leaseRoutes = edge.routes.filter(route => route === 'POST /_mirror/lease').length
  const first = await kitOf(stepping, idb).joinThreads({ clientId: HIS, rescueId: copied.id })
  edge.env.MIRROR = mirrorOf
  assert.deepEqual(steps, [[WIDE, 0], [LONG, 0], [LONG, 1], [LONG, 1]], 'the long journal went in two steps; the second was refused, retried once under a new turn, refused again')
  // The first turn carried the wide journal and the long journal's first step (renewed in between); the retry, a new one.
  assert.deepEqual(stepLeases, [1, 1, 1, 2])
  assert.equal(edge.routes.filter(route => route === 'POST /_mirror/lease').length - leaseRoutes, 4, 'acquire, renew, acquire, release')
  assert.equal(first.done, false)
  assert.equal(first.line, 'This page lost its turn to write in her cloud. Press Join again.')
  assert.deepEqual(Object.fromEntries(first.rows.map(row => [row.path, row.outcome])), { [EMPTY]: 'empty, nothing to join', [LONG]: 'not done: WRITER_GONE', [WIDE]: 'imported' })
  const lease = edge.mirrorStorage.data.get('world:v1:lease')
  assert.equal(lease.holder, null, 'released at the end of the run, never renewed after it ran out')
  assert.equal(lease.generation, 2, 'the second turn was a new lease, not the old one revived')

  // In between: her cloud holds the committed prefix (one whole piece), and both the state line and Check say so.
  const kit = kitOf(edge, idb)
  const state = await kit.cloudState({ clientId: HIS })
  const long = state.rows.find(row => row.path === LONG)
  assert.equal(long.text, `${long.title}: ${PIECE} bytes in her cloud at ${hhmmss(edge.clock.now)}, ${J_LONG.length} in the copy`)
  assert.equal(state.line, `At ${hhmmss(edge.clock.now)} her cloud showed 2 of 3 threads with the same content as this copy.`)
  const between = await kit.checkThread({ id: long.id, title: long.title, rescue: long.rescue })
  assert.equal(between.equal, false)
  const prefix = J_LONG.subarray(0, PIECE)
  assert.ok(between.lines.includes(`Read back from her cloud: ${PIECE} bytes, SHA-256 ${sha(prefix)}, every piece equal to its name.`), JSON.stringify(between))
  assert.ok(between.line.startsWith(`NOT equal to the rescue copy of `) && between.line.includes(`her cloud holds ${PIECE} bytes, SHA-256 ${sha(prefix)}; the copy holds ${J_LONG.length} bytes, SHA-256 ${sha(J_LONG)}.`), between.line)

  // A later join (the Worker's own mount) continues from the committed prefix.
  const later = await kit.joinThreads({ clientId: HIS, rescueId: copied.id })
  assert.equal(later.done, true, later.line)
  assert.deepEqual(Object.fromEntries(later.rows.map(row => [row.path, row.outcome])), { [EMPTY]: 'empty, nothing to join', [LONG]: 'extended', [WIDE]: 'same' })
  assert.equal(later.line, `At ${hhmm(edge.clock.now)} her cloud showed 3 of 3 threads with the same content as this copy.`)
  const row = later.rows.find(entry => entry.path === LONG)
  const after = await kit.checkThread({ id: row.id, title: row.title, rescue: row.rescue })
  assert.equal(after.equal, true, after.line)
  assert.equal(after.line, `Read back from her cloud: ${J_LONG.length} bytes, SHA-256 ${sha(J_LONG)}, every piece equal.`)
})
