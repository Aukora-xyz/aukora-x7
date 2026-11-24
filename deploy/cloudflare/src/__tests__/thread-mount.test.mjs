/**
 * The thread log and the lease forward, mounted in the Worker. Through the REAL Worker entry, the real
 * HeadDO and MirrorDO over in-memory storage and a real passkey sign-in (synthetic keys), with a fake MIRROR route for
 * `/_mirror/thread` (the real threadCommit over a rolling-back store) and `/_mirror/lease` (mirror-do.mjs builds the real ones),
 * and an R2 fake that honours ranges. Every HEAD and MIRROR call and every bucket call is recorded. No network.
 * The unit tests at the end import thread-mount.mjs directly (one import at a time, memory, the source rules).
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import v8 from 'node:v8'
import vm from 'node:vm'
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import { isoCBOR } from '@simplewebauthn/server/helpers'
import { AUMLOK_STORAGE_KEY } from '../aumlok.mjs'
import { X61HeadDurableObject, bootstrapPackage, digest, manifestIdCanon } from '../head-do.mjs'
import { MirrorDO } from '../mirror-do.mjs'
import { createWorker, OWNER_PASSKEY } from '../worker.mjs'
import { THREAD_LIMITS, THREAD_PROTOCOL, threadCommit, threadIdForPath } from '../thread-log.mjs'
import { waitFor } from './wait-for.mjs'

const ORIGIN = 'https://thread-door.example.invalid'
const OWNER = 'owner@example.invalid'
const WORLD = 'node-main-v1'
const PATH = '/dsh/home/auma/session/messages.jsonl'
const OTHER_PATH = '/dsh/home/sessions/s1/t1/session.v1.jsonl'
const LEASE = 'a'.repeat(32)
const CLIENT = '0b8f1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4'
const HOME_STATE = Object.freeze({ pending: true, rescue: 'c'.repeat(32), freeze: 'record' })
const LEASE_STATE = Object.freeze({ holder: { label: 'Chrome on the Mac', since: 1000, seenAt: 2000 }, generation: 3 })
const encoder = new TextEncoder()
const clone = value => structuredClone(value)
const keyHex = key => key.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex')
const sha = value => createHash('sha256').update(value).digest()
const shaHex = value => createHash('sha256').update(value).digest('hex')
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url')
const lines = (count, tag) => encoder.encode(Array.from({ length: count }, (_, i) => `{"t":"${tag}","i":${i}}\n`).join(''))
const ID = await threadIdForPath(PATH)

/** Durable Object storage in memory (transactions in order), as the sign-in door suite uses. */
function memoryStorage() {
  let rows = new Map(), tail = Promise.resolve()
  const view = map => ({ get: async key => clone(map.get(key)), put: async (key, value) => { map.set(key, clone(value)) },
    delete: async key => map.delete(key), list: async ({ prefix = '', limit = Infinity } = {}) => new Map([...map].filter(([key]) => key.startsWith(prefix)).slice(0, limit)),
    getAlarm: async () => null, setAlarm: async () => {}, deleteAlarm: async () => {} })
  const storage = Object.fromEntries(['get', 'put', 'delete', 'list', 'getAlarm', 'setAlarm', 'deleteAlarm'].map(method => [method, (...args) => view(rows)[method](...args)]))
  storage.transaction = operation => {
    const result = tail.then(async () => { const copy = clone(rows), output = await operation(view(copy)); rows = copy; return output })
    tail = result.catch(() => undefined)
    return result
  }
  return storage
}

/** A sorted, rolling-back store for the fake MIRROR thread route (threadCommit lists with start and startAfter). */
function threadStore() {
  let data = new Map()
  const view = map => ({
    get: async key => clone(map.get(key)), put: async (key, value) => { map.set(key, clone(value)) }, delete: async key => map.delete(key),
    list: async ({ prefix = '', start, startAfter, limit = Infinity } = {}) => {
      const out = new Map()
      for (const key of [...map.keys()].sort()) {
        if (!key.startsWith(prefix) || (start !== undefined && key < start) || (startAfter !== undefined && key <= startAfter)) continue
        if (out.size >= limit) break
        out.set(key, clone(map.get(key)))
      }
      return out
    },
  })
  return { transaction: async fn => { const draft = new Map([...data].map(([k, v]) => [k, clone(v)])); const value = await fn(view(draft)); data = draft; return value }, raw: () => data }
}

/**
 * R2 in memory that honours `range`, `onlyIf` and `sha256`; `gates` holds a get until released; `sizes` makes a get
 * report a recorded size other than its bytes (a body read short, or a size over a cap); every call recorded.
 */
function threadBucket() {
  const objects = new Map(), calls = [], gates = new Map(), sizes = new Map()
  const stream = bytes => new ReadableStream({ start(controller) { if (bytes.byteLength) controller.enqueue(new Uint8Array(bytes)); controller.close() } })
  return {
    objects, calls, gates, sizes,
    async head(key) { calls.push(['head', key]); const v = objects.get(key); return v ? { key, size: v.byteLength } : null },
    async put(key, value, options = {}) {
      calls.push(['put', key])
      if (options.onlyIf instanceof Headers && options.onlyIf.get('if-none-match') === '*' && objects.has(key)) return null
      const bytes = value instanceof Uint8Array ? Uint8Array.from(value) : encoder.encode(String(value))
      if (typeof options.sha256 === 'string' && options.sha256 !== shaHex(bytes)) throw new Error('fake bucket: sha256 mismatch')
      objects.set(key, bytes)
      return { key, size: bytes.byteLength }
    },
    async get(key, options = {}) {
      calls.push(['get', key])
      if (gates.has(key)) await gates.get(key)
      const v = objects.get(key)
      if (!v) return null
      const bytes = options.range ? v.slice(options.range.offset, options.range.offset + options.range.length) : v
      return { key, size: sizes.get(key) ?? v.byteLength, body: stream(bytes), arrayBuffer: async () => bytes.slice().buffer, text: async () => new TextDecoder().decode(bytes) }
    },
    async list() { calls.push(['list']); return { objects: [], truncated: false } },
  }
}

/** A VERIFIED rescue in the vault's shape: pieces as blobs, pending.json, manifest.json naming its SHA-256. */
async function storeRescue(bucket, { file, path = PATH, clientId = CLIENT, base = { revision: 2183, batch: 'b'.repeat(64) }, reconciliation = null, filler = 0,
  verifiedAt = '2026-11-12T11:00:00.000Z' }) {
  const piece = THREAD_PROTOCOL.piece, pieces = []
  for (let at = 0; at < file.length; at += piece) {
    const bytes = file.subarray(at, at + piece)
    const hash = shaHex(bytes)
    bucket.objects.set(`w/${WORLD}/blob/${hash}`, Uint8Array.from(bytes))
    pieces.push(hash)
  }
  const rows = [{ key: '/dsh/home', type: 'dir', bytes: 0, sha256: null, pieces: [] }, { key: path, type: 'file', bytes: file.length, sha256: shaHex(file), pieces }]
  for (let i = 0; i < filler; i++) rows.push({ key: `/dsh/home/auma/notes/${String(i).padStart(6, '0')}.json`, type: 'file', bytes: 1, sha256: shaHex(String(i)), pieces: [shaHex(`p${i}`)] })
  const index = encoder.encode(JSON.stringify({ v: 1, piece, source: 'indexeddb', client: { clientId, base, reconciliation }, rows, skipped: [], totals: { rows: rows.length } }))
  const indexSha = shaHex(index), id = indexSha.slice(0, 32)
  bucket.objects.set(`w/${WORLD}/rescue/${id}/pending.json`, index)
  bucket.objects.set(`w/${WORLD}/rescue/${id}/manifest.json`, encoder.encode(JSON.stringify({ verified: true, verifiedAt, rows: rows.length, files: rows.length - 1, bytes: file.length, clientId, unlisted: null, indexSha })))
  return { id, index, verifiedAt, base, reconciliation, clientId, pieces }
}

/** The fake MIRROR routes mirror-do.mjs builds for real: the real threadCommit, a lease that always names one client. */
function fakeMirrorRoutes(fx) {
  const store = threadStore()
  return async request => {
    const path = new URL(request.url).pathname
    const internal = request.headers.get('x-x6-internal-authorized') === '1' && request.headers.get('x-x6-bootstrap-seed') === fx.seedId
    const body = await request.json()
    if (path === '/_mirror/thread') {
      fx.threadPosts.push({ internal, body })
      const answer = await store.transaction(tx => threadCommit(tx, body.op, body.input, { checkLease: async () => ({ ok: true, clientId: fx.leaseClient ?? 'client-lease' }),
        budget: { charge: async () => ({ ok: true }) }, limits: THREAD_LIMITS, now: () => 1000 }))
      const out = body.op === 'index' && answer.status === 200 ? { ...answer.body, home: HOME_STATE, lease: LEASE_STATE } : answer.body
      return Response.json(out, { status: answer.status })
    }
    fx.leasePosts.push({ internal, body })
    const [status, answer] = fx.leaseAnswer ?? [200, { ok: true, lease: LEASE_STATE }]
    return Response.json(answer, { status })
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
  sha(new URL(ORIGIN).hostname).copy(auth); auth[32] = 0x05; auth.writeUInt32BE(0, 33)
  const signature = sign('sha256', Buffer.concat([auth, sha(clientDataJSON)]), passkey.key.privateKey)
  return { id: passkey.id, rawId: passkey.id, type: 'public-key', clientExtensionResults: {}, response: { clientDataJSON: clientDataJSON.toString('base64url'),
    authenticatorData: auth.toString('base64url'), signature: signature.toString('base64url') } }
}

/** A seeded, bound edge with a signed-in passkey session; `calls` records HEAD and MIRROR paths, `bucket.calls` the bucket. */
async function threadEdge(t) {
  const at = Date.now(), headStorage = memoryStorage(), mirrorStorage = memoryStorage()
  const owner = generateKeyPairSync('ed25519'), node = generateKeyPairSync('ed25519'), passkey = passkeyPair()
  const identity = { schema: 'aukora.aumlok.state.v2', generation: 1,
    binding: { aumlokId: 'a'.repeat(64), recoveryCommitment: 'b'.repeat(64), nodePubkeyHex: keyHex(node),
      rootEscrow: { schema: 'aukora.aumlok.escrow.v2', ivB64: Buffer.alloc(12, 1).toString('base64url'), ciphertextB64: Buffer.alloc(48, 2).toString('base64url') },
      credential: { id: passkey.id, counter: 0, publicKeyB64: passkey.publicKeyB64 }, boundAt: at, lastVerifiedAt: at, generation: 1 },
    'pepper.v1': randomBytes(32).toString('base64url'), challenges: [], invites: [], revocations: [], failures: 0, failedAt: [], nextAllowedAt: 0, attempts: [], approvals: [] }
  const bucket = threadBucket()
  const env = { PUBLIC_HOST: new URL(ORIGIN).host, OWNER_EMAIL: OWNER, OWNER_PUBLIC_KEY_HEX: keyHex(owner), ARCHIVE_BUCKET: bucket }
  let network = 0
  const noNetwork = async () => { network++; throw new Error('Network forbidden in this fixture') }
  t.after(() => assert.equal(network, 0))
  const head = new X61HeadDurableObject({ storage: headStorage, getWebSockets: () => [] }, env, { networkFetch: noNetwork })
  const mirror = new MirrorDO({ storage: mirrorStorage })
  const calls = []
  const fx = { env, bucket, calls, threadPosts: [], leasePosts: [], leaseAnswer: null, leaseClient: null, unready: false, seedId: null }
  const routes = fakeMirrorRoutes(fx)
  env.HEAD = { idFromName: value => value, get: () => ({ fetch: request => (calls.push('HEAD ' + new URL(request.url).pathname), head.fetch(request)) }) }
  env.MIRROR = { idFromName: value => value, get: () => ({ fetch: async request => {
    const path = new URL(request.url).pathname
    calls.push('MIRROR ' + path)
    if (path === '/_mirror/thread' || path === '/_mirror/lease') return routes(request)
    const response = await mirror.fetch(request)
    if (path !== '/_mirror/bootstrap-status' || !fx.unready) return response
    return Response.json({ ...(await response.json()), phase: 'empty' })
  } }) }
  env.ASSETS = { fetch() { return new Response('Fixture asset') } }
  const isolate = () => createWorker({ networkFetch: noNetwork })
  const warm = isolate()
  const jwt = () => {
    const payload = encode({ alg: 'EdDSA', typ: 'JWT' }) + '.' + encode({ iss: 'aukora.x61.owner', aud: env.PUBLIC_HOST, email: OWNER,
      nbf: Math.floor(Date.now() / 1000) - 1, exp: Math.floor(Date.now() / 1000) + 600 })
    return payload + '.' + sign(null, Buffer.from(payload), owner.privateKey).toString('base64url')
  }
  /** One browser request; a header given as null is left out. */
  const call = async (worker, path, { method = 'GET', body, cookie, headers = {} } = {}) => {
    const response = await worker.fetch(new Request(new URL(path, ORIGIN), { method,
      headers: Object.fromEntries(Object.entries({ origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'cf-connecting-ip': '203.0.113.40',
        ...(method === 'POST' && body !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...headers })
        .filter(([, value]) => value !== null)),
      ...(body === undefined ? {} : { body: typeof body === 'string' || body instanceof Uint8Array ? body : JSON.stringify(body) }) }), env)
    const text = await response.text()
    let parsed = text
    try { parsed = JSON.parse(text) } catch { /* not JSON */ }
    return { status: response.status, body: parsed, text, headers: response.headers }
  }
  const source = 'export const fixture = true;', moduleSha = await digest(source)
  const draft = { version: 'x6.1-ball/v1', epoch: 1, parentBallId: null, authorPeerId: 'fixture-peer',
    entries: { fixture: { id: 'fixture', specifier: `ball:${moduleSha}`, disabled: false, config: {}, previousSpecifiers: [] } },
    modules: { [moduleSha]: { sha256: moduleSha, specifier: `ball:${moduleSha}` } } }
  const seed = await bootstrapPackage({ version: 'x61-bootstrap/v1', ball: { ...draft, ballId: await manifestIdCanon(draft) }, codeBySha: { [moduleSha]: source }, mirror: { entryCount: 0, batchDigests: [] } })
  for (const input of [{ action: 'prepare', package: seed }, { action: 'commit', seedId: seed.seedId }]) {
    const result = await call(warm, '/_bootstrap', { method: 'POST', body: input, headers: { 'x-x6-owner-assertion': jwt() } })
    assert.equal(result.status, 200, JSON.stringify(result.body))
  }
  fx.seedId = seed.seedId
  await headStorage.put(AUMLOK_STORAGE_KEY, identity)
  const issued = (await call(warm, OWNER_PASSKEY.challenge, { method: 'POST', body: {} })).body
  const signed = await warm.fetch(new Request(new URL(OWNER_PASSKEY.signin, ORIGIN), { method: 'POST',
    headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'cf-connecting-ip': '203.0.113.40', 'content-type': 'application/json' },
    body: JSON.stringify({ challengeId: issued.challengeId, credential: assertionFor(passkey, issued.publicKey.challenge) }) }), env)
  assert.equal(signed.status, 200, await signed.clone().text())
  const cookie = signed.headers.get('set-cookie').split(';')[0]
  return Object.assign(fx, { warm, isolate, call, cookie })
}

const leaseHeaders = { 'x-thread-lease': `${LEASE}.1` }
const FIRST_LINES = lines(3, 'one')
/** The eight routes, each with what a signed-in owner sends. `appendBody` is the first append of a new thread. */
async function routeCases(fx) {
  const rescue = await storeRescue(fx.bucket, { file: lines(5, 'rescued'), path: OTHER_PATH })
  const keepBlob = rescue.pieces[0]
  const keepBytes = fx.bucket.objects.get(`w/${WORLD}/blob/${keepBlob}`)
  return [
    ['GET', '/_thread/index', undefined, {}],
    ['GET', `/_thread/manifest?id=${ID}`, undefined, {}],
    ['GET', `/_thread/tail?id=${ID}`, undefined, {}],
    ['POST', `/_thread/append?id=${ID}&at=0&p=1`, FIRST_LINES, { ...leaseHeaders, 'x-thread-path': PATH, 'x-thread-sha256': shaHex(FIRST_LINES),
      'x-thread-have': `${'0'.repeat(64)}.${shaHex(new Uint8Array(0))}`, 'content-type': 'application/octet-stream' }],
    ['POST', '/_thread/import', { path: OTHER_PATH, rescue: rescue.id }, leaseHeaders],
    ['POST', '/_thread/keep', { id: ID, forkAt: 0, pieces: [keepBlob], bytes: keepBytes.byteLength, sha256: shaHex(keepBytes) }, {}],
    ['POST', '/_thread/retract', { id: ID, forkAt: FIRST_LINES.length, to: FIRST_LINES.length, sha256: shaHex(new Uint8Array(0)) }, leaseHeaders],
    ['POST', '/_mirror/lease', { action: 'status', clientId: CLIENT, tabId: 't1', label: 'Chrome' }, {}],
  ]
}

test('MUST 1: the eight routes answer through the real Worker; signed out each is 401 with zero HEAD, MIRROR and bucket calls', async t => {
  const fx = await threadEdge(t)
  const cases = await routeCases(fx)
  const signedOutElsewhere = await fx.call(fx.warm, '/_host/estate', { headers: { origin: null } })
  assert.equal(signedOutElsewhere.status, 401)
  for (const [name, worker] of [['warm', fx.warm], ['cold', fx.isolate()]]) {
    for (const [method, path, body] of cases) {
      const before = { calls: fx.calls.length, bucket: fx.bucket.calls.length }
      const out = await fx.call(worker, path, { method, body, headers: method === 'GET' ? { origin: null } : {} })
      assert.deepEqual([out.status, out.text], [401, signedOutElsewhere.text], `${name} signed out ${method} ${path}`)
      assert.deepEqual(fx.calls.slice(before.calls), [], `${name} signed out ${method} ${path}: no HEAD or MIRROR call`)
      assert.equal(fx.bucket.calls.length, before.bucket, `${name} signed out ${method} ${path}: no bucket call`)
    }
  }
  // Signed in: each route is answered by the mounted code (never the generic 501), in this order.
  const expected = [[200, 'index'], [404, 'THREAD_UNKNOWN'], [404, 'THREAD_UNKNOWN'], [200, 'APPLIED'], [200, 'IMPORT'], [200, 'KEPT'], [200, undefined], [200, 'lease']]
  for (const [i, [method, path, body, headers]] of cases.entries()) {
    const out = await fx.call(fx.warm, path, { method, body, cookie: fx.cookie, headers: { ...(method === 'GET' ? { origin: null } : {}), ...headers } })
    const [status, code] = expected[i]
    assert.equal(out.status, status, `${method} ${path}: ${out.text}`)
    if (code === 'index') assert.ok(Array.isArray(out.body.threads))
    else if (code === 'lease') assert.deepEqual(out.body, { ok: true, lease: LEASE_STATE })
    else assert.equal(out.body.code, code, `${method} ${path}`)
  }
  assert.equal(fx.calls.filter(call => call === 'MIRROR /_mirror/lease').length, 1)
  assert.ok(fx.threadPosts.length >= 7)
  for (const post of [...fx.threadPosts, ...fx.leasePosts]) assert.equal(post.internal, true, 'every internal POST carries the mark and this world\'s seed')
  for (const post of fx.threadPosts) assert.deepEqual(Object.keys(post.body).filter(key => key !== 'home').sort(), ['input', 'op'])
  // The internal thread route is never reachable as a public path.
  const before = fx.threadPosts.length
  const forged = await fx.call(fx.warm, '/_mirror/thread', { method: 'POST', body: { op: 'index', input: {} }, cookie: fx.cookie })
  assert.equal(forged.status, 501, forged.text)
  assert.equal(fx.threadPosts.length, before)
})

test('MUST 1: a world that is not seeded answers 503 BOOTSTRAP_REQUIRED with no bucket, thread or lease call', async t => {
  const fx = await threadEdge(t)
  fx.unready = true
  for (const [method, path, body, headers] of await routeCases(fx)) {
    const before = { bucket: fx.bucket.calls.length, thread: fx.threadPosts.length, lease: fx.leasePosts.length }
    const out = await fx.call(fx.warm, path, { method, body, cookie: fx.cookie, headers: { ...(method === 'GET' ? { origin: null } : {}), ...headers } })
    assert.equal(out.status, 503, `${method} ${path}: ${out.text}`)
    assert.equal(out.body.code, 'BOOTSTRAP_REQUIRED')
    assert.deepEqual([fx.bucket.calls.length, fx.threadPosts.length, fx.leasePosts.length], [before.bucket, before.thread, before.lease], `${method} ${path}`)
  }
})

const READS = [['GET', '/_thread/index'], ['GET', `/_thread/manifest?id=${ID}`], ['GET', `/_thread/tail?id=${ID}`]]
const WRITES = [['POST', `/_thread/append?id=${ID}&at=0&p=1`], ['POST', '/_thread/import'], ['POST', '/_thread/keep'], ['POST', '/_thread/retract'], ['POST', '/_mirror/lease']]
const REFUSED_READS = [{ origin: null, 'sec-fetch-site': 'same-site' }, { origin: null, 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate' },
  { origin: null, 'sec-fetch-site': null }, { origin: null, 'sec-fetch-site': 'none', 'sec-fetch-mode': 'cors' }]
const REFUSED_WRITES = [{ origin: null, 'sec-fetch-site': 'same-site' }, { origin: null, 'sec-fetch-site': null }, { origin: null }, { 'sec-fetch-site': 'same-site' }]

test('MUST 2: with a LIVE session a refused fetch mark is answered as signed out, byte for byte, with zero HEAD, MIRROR and bucket calls', async t => {
  const fx = await threadEdge(t)
  const mine = await fx.call(fx.warm, '/_thread/index', { cookie: fx.cookie, headers: { origin: null } })
  assert.equal(mine.status, 200, mine.text)
  const signedOut = await fx.call(fx.warm, '/_host/estate', { headers: { origin: null } })
  for (const [name, worker] of [['warm', fx.warm], ['cold', fx.isolate()]]) {
    const cases = [...READS.flatMap(([method, path]) => REFUSED_READS.map(headers => [method, path, headers])),
      ...WRITES.flatMap(([method, path]) => REFUSED_WRITES.map(headers => [method, path, headers]))]
    for (const [method, path, headers] of cases) {
      const before = { calls: fx.calls.length, bucket: fx.bucket.calls.length }
      const refused = await fx.call(worker, path, { method, body: method === 'POST' ? { action: 'status' } : undefined, cookie: fx.cookie, headers: { ...leaseHeaders, ...headers } })
      const label = `${name}: ${method} ${path} ${JSON.stringify(headers)}`
      assert.deepEqual([refused.status, refused.text], [401, signedOut.text], label)
      assert.deepEqual(fx.calls.slice(before.calls), [], label + ': no HEAD or MIRROR call')
      assert.equal(fx.bucket.calls.length, before.bucket, label + ': no bucket call')
    }
  }
  const cold = fx.isolate()
  const typed = await fx.call(cold, '/_thread/index', { cookie: fx.cookie, headers: { origin: null, 'sec-fetch-site': 'none', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' } })
  assert.equal(typed.status, 200, 'the owner\'s own navigation still reads')
  const source = await fs.readFile(new URL('../worker.mjs', import.meta.url), 'utf8')
  const passLine = source.split('\n').find(line => line.includes('const request = vaultRoute'))
  assert.ok(passLine.includes('threadRoute'), 'the thread routes join the pass-through list: the Worker never reads their bodies first')
})

/** Wait until `done()` holds: bounded by elapsed time (wait-for.mjs), failing loudly with `label`. */
function until(done, label) {
  return waitFor(done, label)
}

/** A rescue index just under 4 MiB, the journal row among filler rows. */
async function bigRescue(bucket, file) {
  const probe = await storeRescue(threadBucket(), { file, filler: 1000 })
  const perRow = (probe.index.byteLength - (await storeRescue(threadBucket(), { file })).index.byteLength) / 1000
  const filler = Math.floor((4 * 1024 * 1024 - 4096) / perRow)
  const rescue = await storeRescue(bucket, { file, filler })
  assert.ok(rescue.index.byteLength <= 4 * 1024 * 1024 && rescue.index.byteLength > 4 * 1024 * 1024 - 16384, String(rescue.index.byteLength))
  return rescue
}

test('MUST 3: 17 imports sent together over a 4 MiB index: one runs, 16 answer 503 IMPORT_BUSY with zero bucket reads; retried one by one all finish', async t => {
  const fx = await threadEdge(t)
  const rescue = await bigRescue(fx.bucket, lines(40, 'main'))
  let release
  fx.bucket.gates.set(`w/${WORLD}/rescue/${rescue.id}/pending.json`, new Promise(resolve => { release = resolve }))
  const bucketBefore = fx.bucket.calls.length
  const answers = []
  const send = () => fx.call(fx.warm, '/_thread/import', { method: 'POST', body: { path: PATH, rescue: rescue.id }, cookie: fx.cookie, headers: leaseHeaders })
  const all = Array.from({ length: 17 }, () => send().then(answer => (answers.push(answer), answer)))
  await until(() => answers.length === 16, '16 answered while one import holds the slot')
  await until(() => fx.bucket.calls.length - bucketBefore >= 2, 'the running import is held at its index read')
  const busy = answers.filter(answer => answer.status === 503 && answer.body.code === 'IMPORT_BUSY')
  assert.equal(busy.length, 16)
  for (const answer of busy) assert.equal(answer.headers.get('retry-after'), '1')
  const bucketReads = fx.bucket.calls.slice(bucketBefore)
  assert.deepEqual(bucketReads.map(([op, key]) => `${op} ${key.split('/').at(-1)}`), ['get manifest.json', 'get pending.json'], 'only the one running import touched the bucket')
  release()
  fx.bucket.gates.clear()
  const results = await Promise.all(all)
  const ran = results.filter(answer => answer.status === 200)
  assert.equal(ran.length, 1)
  assert.equal(ran[0].body.outcome, 'imported')
  for (let i = 0; i < 16; i++) {
    const again = await send()
    assert.equal(again.status, 200, again.text)
    assert.equal(again.body.outcome, 'same')
  }
})

test('MUST 4: the import that commits carries exactly whose home it came from; no other MIRROR call carries a home', async t => {
  const fx = await threadEdge(t)
  const rescue = await storeRescue(fx.bucket, { file: lines(12, 'main'), reconciliation: { mark: 'reconcile-1' } })
  const out = await fx.call(fx.warm, '/_thread/import', { method: 'POST', body: { path: PATH, rescue: rescue.id }, cookie: fx.cookie, headers: leaseHeaders })
  assert.deepEqual([out.status, out.body.outcome], [200, 'imported'], out.text)
  const homed = fx.threadPosts.filter(post => Object.hasOwn(post.body, 'home'))
  assert.equal(homed.length, 1)
  assert.equal(homed[0].body.op, 'import')
  assert.deepEqual(homed[0].body.home, { rescue: rescue.id, clientId: CLIENT, base: rescue.base, reconciliation: { mark: 'reconcile-1' }, verifiedAt: rescue.verifiedAt })
  assert.ok(fx.threadPosts.some(post => post.body.op === 'manifest' && !Object.hasOwn(post.body, 'home')))
  // A rescue that names no client: clientId null is passed as null (MIRROR decides what to record).
  const nameless = await storeRescue(fx.bucket, { file: lines(4, 'other'), path: OTHER_PATH, clientId: null, base: null })
  const second = await fx.call(fx.warm, '/_thread/import', { method: 'POST', body: { path: OTHER_PATH, rescue: nameless.id }, cookie: fx.cookie, headers: leaseHeaders })
  assert.equal(second.status, 200, second.text)
  const last = fx.threadPosts.filter(post => Object.hasOwn(post.body, 'home')).at(-1)
  assert.deepEqual(last.body.home, { rescue: nameless.id, clientId: null, base: null, reconciliation: null, verifiedAt: nameless.verifiedAt })
  // A fork is kept beside: the keep call carries no home, and no import call is made.
  const fork = await storeRescue(fx.bucket, { file: lines(20, 'fork') })
  const posts = fx.threadPosts.length
  const kept = await fx.call(fx.warm, '/_thread/import', { method: 'POST', body: { path: PATH, rescue: fork.id }, cookie: fx.cookie, headers: leaseHeaders })
  assert.deepEqual([kept.status, kept.body.outcome], [200, 'kept-beside'], kept.text)
  const forkPosts = fx.threadPosts.slice(posts)
  assert.ok(forkPosts.some(post => post.body.op === 'keep'))
  assert.equal(forkPosts.filter(post => Object.hasOwn(post.body, 'home')).length, 0)
  // An unverified rescue (no manifest) and a pending.json that is not the manifest's index: RESCUE_UNKNOWN, no MIRROR import.
  const unverified = await storeRescue(fx.bucket, { file: lines(2, 'u') })
  fx.bucket.objects.delete(`w/${WORLD}/rescue/${unverified.id}/manifest.json`)
  const swapped = await storeRescue(fx.bucket, { file: lines(2, 's') })
  fx.bucket.objects.set(`w/${WORLD}/rescue/${swapped.id}/pending.json`, fork.index)
  for (const id of [unverified.id, swapped.id]) {
    const before = fx.threadPosts.length
    const refused = await fx.call(fx.warm, '/_thread/import', { method: 'POST', body: { path: PATH, rescue: id }, cookie: fx.cookie, headers: leaseHeaders })
    assert.deepEqual([refused.status, refused.body.code], [404, 'RESCUE_UNKNOWN'])
    assert.equal(fx.threadPosts.slice(before).filter(post => post.body.op === 'import').length, 0)
  }
})

test('MUST 5: GET /_thread/index brings MIRROR\'s home and lease to the browser unchanged', async t => {
  const fx = await threadEdge(t)
  const out = await fx.call(fx.warm, '/_thread/index?limit=10', { cookie: fx.cookie, headers: { origin: null } })
  assert.equal(out.status, 200, out.text)
  assert.deepEqual(out.body.home, HOME_STATE)
  assert.deepEqual(out.body.lease, LEASE_STATE)
  assert.deepEqual(fx.threadPosts.at(-1).body, { op: 'index', input: { after: '', limit: 10 } })
})

test('MUST 6: the lease forward: the Worker alone writes ownerApproved; take without approval is false with no passkey call; MIRROR\'s answer comes back', async t => {
  const fx = await threadEdge(t)
  const class3 = () => fx.calls.filter(call => call === 'HEAD /_head/class3-authorize').length
  const lease = async (body, headers = {}) => fx.call(fx.warm, '/_mirror/lease', { method: 'POST', body, cookie: fx.cookie, headers })
  const take = { action: 'take', clientId: CLIENT, tabId: 't2', label: 'Safari' }
  // A browser that sends ownerApproved: true is forwarded as false, the field gone, the passkey never asked.
  for (const [body, headers] of [[{ ...take, ownerApproved: true }, { 'x-x6-class3-approval': 'forged' }], [{ action: 'acquire', clientId: CLIENT, tabId: 't2', label: 'Safari', ownerApproved: true }, {}]]) {
    const before = class3()
    const out = await lease(body, headers)
    assert.equal(out.status, 200, out.text)
    const { ownerApproved: _dropped, ...input } = body
    assert.deepEqual(fx.leasePosts.at(-1).body, { input, ownerApproved: false })
    assert.equal(class3(), before, 'no passkey call')
  }
  // take with no approval header: forwarded false, no HEAD call at all.
  const calls = fx.calls.length
  await lease(take)
  assert.deepEqual(fx.leasePosts.at(-1).body, { input: take, ownerApproved: false })
  assert.deepEqual(fx.calls.slice(calls).filter(call => call.startsWith('HEAD /_head/class3')), [])
  // take with an approval that does not check out: the passkey IS asked, over this body, and the answer is still false.
  const before = class3()
  await lease(take, { 'x-x6-class3-approval': 'not-a-real-approval' })
  assert.equal(class3(), before + 1)
  assert.deepEqual(fx.leasePosts.at(-1).body, { input: take, ownerApproved: false })
  // MIRROR's status and body come back (a field named conflictCode never does).
  fx.leaseAnswer = [423, { ok: false, code: 'WRITER_ELSEWHERE', holder: { label: 'Chrome on the Mac', since: 1, seenAt: 2 }, conflictCode: 'NEVER' }]
  const refused = await lease({ action: 'acquire', clientId: CLIENT, tabId: 't2', label: 'Safari' })
  assert.deepEqual([refused.status, refused.body], [423, { ok: false, code: 'WRITER_ELSEWHERE', holder: { label: 'Chrome on the Mac', since: 1, seenAt: 2 } }])
  // Over 1 KiB, or not a JSON object: refused here, nothing forwarded.
  const posts = fx.leasePosts.length
  assert.equal((await lease({ action: 'status', label: 'x'.repeat(1100) })).status, 413)
  assert.equal((await lease('[1]')).status, 400)
  assert.equal((await lease('{"action":')).status, 400)
  assert.equal((await fx.call(fx.warm, '/_mirror/lease', { cookie: fx.cookie, headers: { origin: null } })).status, 405)
  assert.equal(fx.leasePosts.length, posts)
  for (const post of fx.leasePosts) assert.deepEqual(Object.keys(post.body).sort(), ['input', 'ownerApproved'])
})

// ── Unit tests: thread-mount.mjs on its own (imported inside each test, so a missing module fails only these). ──

function unitEnv(bucket, record = []) {
  const routes = fakeMirrorRoutes(Object.assign(record, { threadPosts: record, leasePosts: [], seedId: 's'.repeat(64) }))
  return { ARCHIVE_BUCKET: bucket, MIRROR: { idFromName: value => value, get: () => ({ fetch: routes }) } }
}
const unitImport = (rescue, headers = leaseHeaders) => new Request(ORIGIN + '/_thread/import', { method: 'POST',
  headers: { 'content-type': 'application/json', origin: ORIGIN, 'sec-fetch-site': 'same-origin', ...headers }, body: JSON.stringify({ path: PATH, rescue }) })

test('MUST 3: 17 imports in a row over a 4 MiB index: heap growth after a collection stays under 32 MiB (node figure)', async t => {
  const { createThreadMount } = await import('../thread-mount.mjs')
  if (typeof globalThis.gc !== 'function') v8.setFlagsFromString('--expose-gc')
  const gc = typeof globalThis.gc === 'function' ? globalThis.gc : vm.runInNewContext('gc')
  const bucket = threadBucket()
  const rescue = await bigRescue(bucket, lines(40, 'main'))
  const env = unitEnv(bucket)
  const mount = createThreadMount()
  const one = async () => {
    const request = unitImport(rescue.id)
    const out = await mount.handle({ request, url: new URL(request.url), env, ready: true, seedId: 's'.repeat(64), access: { type: 'owner' } })
    assert.equal(out.status, 200, await out.clone().text())
    return (await out.json()).outcome
  }
  assert.equal(await one(), 'imported')
  gc(); gc()
  const before = process.memoryUsage().heapUsed
  for (let i = 0; i < 17; i++) assert.equal(await one(), 'same')
  gc(); gc()
  const growth = process.memoryUsage().heapUsed - before
  t.diagnostic(`heap growth after 17 imports of a ${rescue.index.byteLength}-byte index: ${growth} bytes (${(growth / 1048576).toFixed(2)} MiB)`)
  assert.ok(growth < 32 * 1024 * 1024, `heap grew ${growth} bytes`)
})

test('MUST 3: a second import while one is in flight answers 503 IMPORT_BUSY before any bucket read; the slot is let go after an error', async () => {
  const { createThreadMount } = await import('../thread-mount.mjs')
  const bucket = threadBucket()
  const rescue = await storeRescue(bucket, { file: lines(3, 'x') })
  let release
  bucket.gates.set(`w/${WORLD}/rescue/${rescue.id}/manifest.json`, new Promise(resolve => { release = resolve }))
  const env = unitEnv(bucket)
  const mount = createThreadMount()
  const go = request => mount.handle({ request, url: new URL(request.url), env, ready: true, seedId: 's'.repeat(64), access: { type: 'owner' } })
  const first = go(unitImport(rescue.id))
  await until(() => bucket.calls.length === 1, 'the first import is reading the bucket')
  const second = await go(unitImport(rescue.id))
  assert.deepEqual([second.status, second.headers.get('retry-after'), (await second.json()).code], [503, '1', 'IMPORT_BUSY'])
  assert.equal(bucket.calls.length, 1)
  // Other thread routes are not held by the import slot.
  const index = await go(new Request(ORIGIN + '/_thread/index'))
  assert.equal(index.status, 200)
  release()
  assert.equal((await first).status, 200)
  // A refused import (no lease) lets the slot go too.
  assert.equal((await go(unitImport(rescue.id, {}))).status, 423)
  assert.equal((await go(unitImport(rescue.id))).status, 200)
  // Not seeded, or not the owner: refused before any bucket or MIRROR call.
  const calls = bucket.calls.length
  const unready = await mount.handle({ request: unitImport(rescue.id), url: new URL(ORIGIN + '/_thread/import'), env, ready: false, seedId: 's'.repeat(64), access: { type: 'owner' } })
  assert.deepEqual([unready.status, (await unready.json()).code], [503, 'BOOTSTRAP_REQUIRED'])
  const guest = await mount.handle({ request: unitImport(rescue.id), url: new URL(ORIGIN + '/_thread/import'), env, ready: true, seedId: 's'.repeat(64), access: { type: 'guest' } })
  assert.equal(guest.status, 403)
  assert.equal(bucket.calls.length, calls)
})

test('MUST 6: take and forget ask the passkey over the exact body; ownerApproved is true only on a live approval; other actions never ask', async () => {
  const { createThreadMount } = await import('../thread-mount.mjs')
  const record = []
  const env = unitEnv(threadBucket(), record)
  const leasePosts = []
  env.MIRROR = { idFromName: value => value, get: () => ({ fetch: async request => { leasePosts.push(await request.json()); return Response.json({ ok: true }) } }) }
  const mount = createThreadMount()
  const asked = []
  const now = () => 5000
  const send = (body, approval, expiresAt = 6000) => {
    const request = new Request(ORIGIN + '/_mirror/lease', { method: 'POST', headers: { 'content-type': 'application/json', ...(approval ? { 'x-x6-class3-approval': approval } : {}) }, body: JSON.stringify(body) })
    return mount.handle({ request, url: new URL(request.url), env, ready: true, seedId: 's'.repeat(64), access: { type: 'owner' }, now,
      authorize: async card => {
        asked.push(card)
        if (expiresAt === 'throw') throw new Error('lost')
        // HEAD's own refusal (the Worker's edgeClass3 throws it with HEAD's status and code): nothing was spent by this ask.
        if (expiresAt === 'refuse') throw Object.assign(new Error('CLASS3_WEBAUTHN_REQUIRED'), { status: 403, code: 'CLASS3_WEBAUTHN_REQUIRED' })
        return { expiresAt }
      } })
  }
  for (const action of ['take', 'forget']) {
    await send({ action, clientId: CLIENT }, 'ok')
    assert.deepEqual(asked.at(-1), { action, clientId: CLIENT })
    assert.deepEqual(leasePosts.at(-1), { input: { action, clientId: CLIENT }, ownerApproved: true })
  }
  // job 4 (R3): a take's passkey answer that arrives already expired, or is lost, may have spent the
  // approval: 503 TAKE_OUTCOME_UNKNOWN, and NOTHING is forwarded in its place (never "the passkey is required"). Job 4
  // review: the one post is the unapproved preflight made BEFORE the passkey was asked.
  for (const [why, expiresAt] of [['an expired approval', 4000], ['a lost answer', 'throw']]) {
    const posts = leasePosts.length
    const out = await send({ action: 'take', clientId: CLIENT }, 'ok', expiresAt)
    assert.deepEqual([out.status, await out.json()], [503, { ok: false, code: 'TAKE_OUTCOME_UNKNOWN', approval: 'may be spent', next: 'approve again' }], why)
    assert.deepEqual(leasePosts.slice(posts), [{ input: { action: 'take', clientId: CLIENT }, ownerApproved: false }], `${why}: nothing forwarded after the passkey`)
  }
  await send({ action: 'take', clientId: CLIENT }, 'ok', 'refuse')
  assert.equal(leasePosts.at(-1).ownerApproved, false, 'a refused approval')
  const count = asked.length
  for (const action of ['acquire', 'renew', 'ask', 'release', 'status']) {
    await send({ action, clientId: CLIENT }, 'ok')
    assert.equal(leasePosts.at(-1).ownerApproved, false)
  }
  assert.equal(asked.length, count, 'no passkey call for any other action')
})

test('MUST 7: the reply rules, pinned on the source: no conflictCode field is written, nothing is thrown, no bucket delete', async () => {
  const source = await fs.readFile(new URL('../thread-mount.mjs', import.meta.url), 'utf8')
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
  assert.doesNotMatch(code, /conflictCode['"]?\s*:/, 'no reply has a field named conflictCode')
  assert.doesNotMatch(code, /\bthrow\b/, 'every refusal is returned, none thrown')
  assert.doesNotMatch(code, /\.delete\s*\(/, 'no bucket.delete (and no other delete call)')
  assert.doesNotMatch(code, /Promise\.reject/, 'no refusal is a rejected promise either')
})

// ── Review: the import slot's own deadline, the lease forward's size, the retract's passkey, the 503s. ──

test('REVIEW MUST: an import whose request the runtime cancelled holds the slot only until its own deadline; a late finally never frees a newer holder', async t => {
  const { createThreadMount, THREAD_MOUNT_DEADLINES } = await import('../thread-mount.mjs')
  const hold = THREAD_MOUNT_DEADLINES.importHoldMs ?? 300000
  const bucket = threadBucket()
  const held = await storeRescue(bucket, { file: lines(3, 'held') })
  const other = await storeRescue(bucket, { file: lines(3, 'other'), path: OTHER_PATH })
  // The busy probe's rescue is never gated: a probe let in by mistake finishes at once and fails the check fast.
  const probe = await storeRescue(bucket, { file: lines(3, 'probe'), path: OTHER_PATH })
  const env = unitEnv(bucket)
  const mount = createThreadMount()
  let clock = 1_000_000
  const go = (rescue, path) => {
    const request = new Request(ORIGIN + '/_thread/import', { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN, 'sec-fetch-site': 'same-origin', ...leaseHeaders },
      body: JSON.stringify({ path, rescue }) })
    // The thread log's own R2 deadline is set long, so the held import stands for a request whose `finally` never runs.
    return mount.handle({ request, url: new URL(request.url), env, ready: true, seedId: 's'.repeat(64), access: { type: 'owner' }, now: () => clock, threadDeadlines: { r2Ms: 600000 } })
  }
  const opened = []
  t.after(() => { for (const open of opened) open() }) // a failed assertion never leaves a held import (and its timer) behind
  const gate = key => { let release; bucket.gates.set(key, new Promise(resolve => { release = resolve })); const open = () => { bucket.gates.delete(key); release() }; opened.push(open); return open }
  const releaseHeld = gate(`w/${WORLD}/rescue/${held.id}/manifest.json`)
  const stuck = go(held.id, PATH)
  await until(() => bucket.calls.some(([, key]) => key.endsWith(`${held.id}/manifest.json`)), 'the first import is held at its manifest read')
  const busy = async label => {
    const reads = bucket.calls.length
    const out = await go(probe.id, OTHER_PATH)
    assert.deepEqual([out.status, out.headers.get('retry-after'), (await out.json()).code], [503, '1', 'IMPORT_BUSY'], label)
    assert.equal(bucket.calls.length, reads, label + ': no bucket read')
  }
  await busy('while the first import holds the slot')
  clock += hold - 1
  await busy('one millisecond before the hold ends')
  clock += 2
  const freed = await go(other.id, OTHER_PATH)
  assert.deepEqual([freed.status, (await freed.json()).outcome], [200, 'imported'], 'past the hold, the next import runs')
  // A newer holder; then the first request's late `finally` runs: it must not free the newer holder's slot.
  const releaseNewer = gate(`w/${WORLD}/rescue/${other.id}/manifest.json`)
  const newer = go(other.id, OTHER_PATH)
  await until(() => bucket.calls.filter(([, key]) => key.endsWith(`${other.id}/manifest.json`)).length === 2, 'the newer import is held')
  releaseHeld()
  assert.equal((await stuck).status, 200)
  await busy('the first request settled late; the newer import still holds the slot')
  releaseNewer()
  assert.equal((await newer).status, 200)
  const after = await go(other.id, OTHER_PATH)
  assert.deepEqual([after.status, (await after.json()).outcome], [200, 'same'])
  assert.ok(Number.isSafeInteger(THREAD_MOUNT_DEADLINES.importHoldMs) && THREAD_MOUNT_DEADLINES.importHoldMs >= 180000, 'the hold outlasts an honest import')
})

test('REVIEW SHOULD: a lease body whose forward would pass MIRROR\'s 1 KiB reader is refused 413 before the passkey is asked; one that fits exactly is forwarded', async t => {
  const fx = await threadEdge(t)
  const class3 = () => fx.calls.filter(call => call === 'HEAD /_head/class3-authorize').length
  const wire = body => Buffer.byteLength(JSON.stringify({ input: body, ownerApproved: false }))
  const sized = bytes => { const body = { action: 'take', clientId: CLIENT, tabId: 't3', label: '' }; body.label = 'x'.repeat(bytes - wire(body)); return body }
  const over = sized(1025)
  assert.ok(Buffer.byteLength(JSON.stringify(over)) <= 1024, 'the browser body itself is within 1 KiB')
  const before = { class3: class3(), posts: fx.leasePosts.length }
  const refused = await fx.call(fx.warm, '/_mirror/lease', { method: 'POST', body: over, cookie: fx.cookie, headers: { 'x-x6-class3-approval': 'not-a-real-approval' } })
  assert.deepEqual([refused.status, refused.body.code], [413, 'LEASE_REQUEST_TOO_LARGE'], refused.text)
  assert.deepEqual([class3(), fx.leasePosts.length], [before.class3, before.posts], 'no passkey asked, nothing forwarded')
  const fits = sized(1024)
  const out = await fx.call(fx.warm, '/_mirror/lease', { method: 'POST', body: fits, cookie: fx.cookie })
  assert.equal(out.status, 200, out.text)
  assert.deepEqual(fx.leasePosts.at(-1).body, { input: fits, ownerApproved: false })
  assert.equal(Buffer.byteLength(JSON.stringify(fx.leasePosts.at(-1).body)), 1024)
})

test('a retract MIRROR marks CLASS3_WEBAUTHN_REQUIRED asks the passkey only with an approval header; without a live approval nothing is removed', async t => {
  const fx = await threadEdge(t)
  const class3 = () => fx.calls.filter(call => call === 'HEAD /_head/class3-authorize').length
  const appended = await fx.call(fx.warm, `/_thread/append?id=${ID}&at=0&p=1`, { method: 'POST', body: FIRST_LINES, cookie: fx.cookie, headers: { ...leaseHeaders, 'x-thread-path': PATH,
    'x-thread-sha256': shaHex(FIRST_LINES), 'x-thread-have': `${'0'.repeat(64)}.${shaHex(new Uint8Array(0))}`, 'content-type': 'application/octet-stream' } })
  assert.deepEqual([appended.status, appended.body.code], [200, 'APPLIED'], appended.text)
  // Another writer now holds the lease: its retract of lines it did not write needs the owner's passkey.
  fx.leaseClient = 'client-other'
  const tail = () => fx.call(fx.warm, `/_thread/tail?id=${ID}`, { cookie: fx.cookie, headers: { origin: null } })
  const tailBefore = await tail()
  assert.equal(tailBefore.status, 200, tailBefore.text)
  const card = { id: ID, forkAt: 0, to: FIRST_LINES.length, sha256: shaHex(FIRST_LINES) }
  for (const [headers, asked] of [[{}, 0], [{ 'x-x6-class3-approval': 'not-a-real-approval' }, 1]]) {
    const before = { class3: class3(), posts: fx.threadPosts.length }
    const out = await fx.call(fx.warm, '/_thread/retract', { method: 'POST', body: card, cookie: fx.cookie, headers: { ...leaseHeaders, ...headers } })
    const label = JSON.stringify(headers)
    assert.deepEqual([out.status, out.body.code], [403, 'CLASS3_WEBAUTHN_REQUIRED'], `${label}: ${out.text}`)
    assert.equal(class3() - before.class3, asked, `${label}: passkey checks`)
    assert.deepEqual(fx.threadPosts.slice(before.posts).filter(post => post.body.op === 'retract').map(post => post.body.input.approved), [false], `${label}: one retract, never approved`)
    const now = await tail()
    assert.deepEqual([now.status, now.body], [tailBefore.status, tailBefore.body], `${label}: thread unchanged`)
  }
})

test('REVIEW SHOULD: a rescue manifest or index read short or recorded over its cap answers 503 ARCHIVE_UNAVAILABLE (never RESCUE_UNKNOWN) with no MIRROR call', async t => {
  const fx = await threadEdge(t)
  const rescue = await storeRescue(fx.bucket, { file: lines(6, 'main') })
  const base = `w/${WORLD}/rescue/${rescue.id}`
  const send = () => fx.call(fx.warm, '/_thread/import', { method: 'POST', body: { path: PATH, rescue: rescue.id }, cookie: fx.cookie, headers: leaseHeaders })
  for (const [key, size] of [[`${base}/pending.json`, rescue.index.byteLength + 1], [`${base}/pending.json`, 4 * 1024 * 1024 + 1], [`${base}/manifest.json`, 65537]]) {
    fx.bucket.sizes.set(key, size)
    const before = fx.threadPosts.length
    const out = await send()
    assert.deepEqual([out.status, out.body.code], [503, 'ARCHIVE_UNAVAILABLE'], `${key.split('/').at(-1)} recorded as ${size}: ${out.text}`)
    assert.equal(fx.threadPosts.length, before, 'no MIRROR call')
    fx.bucket.sizes.clear()
  }
  const whole = await send()
  assert.deepEqual([whole.status, whole.body.outcome], [200, 'imported'], whole.text)
})

test('REVIEW SHOULD: a MIRROR answer over its limit, late, or not JSON answers 503 THREAD_STORAGE_UNAVAILABLE', async () => {
  const { createThreadMount, THREAD_MOUNT_LIMITS } = await import('../thread-mount.mjs')
  const mount = createThreadMount({ deadlines: { mirrorMs: 200 } })
  const big = limit => '{"ok":true,"pad":"' + 'x'.repeat(limit) + '"}'
  const cases = [
    ['thread reply over 8 MiB', '/_thread/index', () => new Response(big(THREAD_MOUNT_LIMITS.mirrorReplyBytes))],
    ['lease reply over 64 KiB', '/_mirror/lease', () => new Response(big(THREAD_MOUNT_LIMITS.leaseReplyBytes))],
    ['late', '/_thread/index', () => new Promise(() => {})],
    ['not JSON', '/_thread/index', () => new Response('not json')],
  ]
  for (const [label, path, answer] of cases) {
    const env = { ARCHIVE_BUCKET: threadBucket(), MIRROR: { idFromName: value => value, get: () => ({ fetch: answer }) } }
    const request = path === '/_mirror/lease'
      ? new Request(ORIGIN + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"action":"status"}' })
      : new Request(ORIGIN + path)
    const out = await mount.handle({ request, url: new URL(request.url), env, ready: true, seedId: 's'.repeat(64), access: { type: 'owner' } })
    assert.deepEqual([out.status, (await out.json()).code], [503, 'THREAD_STORAGE_UNAVAILABLE'], label)
  }
})
