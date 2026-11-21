/** The witness object wired to the REAL HEAD and mirror objects (in-memory storage, bootstrapped
 * through the real Worker as nostr-anchor-door.test.mjs does), with fake calendars and relays. The record's facts come
 * from HEAD's facts read (the selected head, the mirror-verified receipts head, the node pubkey) and the mirror's one
 * bounded journals read; the event is signed by HEAD's sign route through its WITNESS hook. Every expected value is
 * recomputed here with node:crypto. No network. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { schnorr } from '@noble/curves/secp256k1.js'
import { createWorker } from '../worker.mjs'
import { MirrorDO } from '../mirror-do.mjs'
import { X61HeadDurableObject, BOOTSTRAP_VERSION, canonicalBootstrap, digest, manifestIdCanon } from '../head-do.mjs'
import { canonicalJson } from '../owner-grant-policy.mjs'
import { provisionMessagesIdentity } from '../messages-store.mjs'
import { WITNESS_JOURNAL_PATHS, WITNESS_SIGNER_KEY } from '../witness.mjs'
import { WITNESS_RELAYS, WitnessDO } from '../witness-do.mjs'

const ORIGIN = 'https://witness-stack.example.invalid'
const OWNER = 'owner@example.invalid'
const RECEIPTS_PATH = '/dsh/home/auma/seed/receipts.v3.jsonl'
const [VOICE, TIMELINE] = WITNESS_JOURNAL_PATHS
const sha256 = text => createHash('sha256').update(text).digest('hex')
const sorted = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(name => [name, item[name]])) : item)

function receiptsText(count) {
  let previous = '0'.repeat(64), text = ''
  for (let seq = 1; seq <= count; seq++) {
    const row = { schema: 'aukora.receipt.v3', seq, at: `2026-11-12T00:00:0${seq}.000Z`, kind: 'head.stage', data: { epoch: 1 }, prevHash: previous }
    row.leafHash = sha256('\0' + canonicalJson(row))
    previous = row.leafHash
    text += JSON.stringify(row) + '\n'
  }
  return { text, leaf: previous }
}

function memoryStorage() {
  let data = new Map(), alarm = null, tail = Promise.resolve()
  const view = (rows, timer) => ({
    get: async key => Array.isArray(key) ? new Map(key.filter(name => rows.has(name)).map(name => [name, structuredClone(rows.get(name))])) : structuredClone(rows.get(key)),
    put: async (key, value) => { rows.set(key, structuredClone(value)) },
    delete: async key => rows.delete(key),
    list: async ({ prefix = '', limit = Infinity } = {}) => structuredClone(new Map([...rows].filter(([key]) => key.startsWith(prefix)).slice(0, limit))),
    getAlarm: async () => timer.value, setAlarm: async value => { timer.value = value }, deleteAlarm: async () => { timer.value = null },
  })
  const storage = Object.fromEntries(['get', 'put', 'delete', 'list'].map(method => [method, (...args) => view(data, { value: alarm })[method](...args)]))
  storage.getAlarm = async () => alarm
  storage.transaction = operation => {
    const result = tail.then(async () => {
      const rows = structuredClone(data), timer = { value: alarm }
      const value = await operation(view(rows, timer))
      data = rows; alarm = timer.value
      return value
    })
    tail = result.catch(() => {})
    return result
  }
  return { storage, snapshot: () => structuredClone(data) }
}

/** A voice chain journal of `count` lines, each `width` characters of JSON. */
function voiceChain(count, width = 120) {
  let text = ''
  for (let seq = 1; seq <= count; seq++) {
    const line = JSON.stringify({ v: 1, seq, pad: 'x'.repeat(Math.max(0, width - 30)) })
    text += line + '\n'
  }
  return text
}

async function stack(t, { voice = voiceChain(5), timeline = null, identity = true } = {}) {
  const clock = { now: Date.now() }
  const hs = memoryStorage(), ms = memoryStorage(), ws = memoryStorage(), headCalls = [], mirrorCalls = []
  const access = { type: 'owner', email: OWNER, expires: Math.floor(Date.now() / 1000) + 3600 }
  const session = { identity: access }
  const env = { WITNESS_SWITCH: 'on', PUBLIC_HOST: new URL(ORIGIN).host, ACCESS_TEAM: 'fixture.cloudflareaccess.com', ACCESS_AUD: 'fixture', OWNER_EMAIL: OWNER }
  const head = new X61HeadDurableObject({ storage: hs.storage, getWebSockets: () => [] }, env)
  t.after(() => head.wakeStore.dispose())
  const mirror = new MirrorDO({ storage: ms.storage }, env)
  env.HEAD = { idFromName: name => name, get: () => ({ fetch: request => { headCalls.push(new URL(request.url).pathname); return head.fetch(request) } }) }
  env.MIRROR = { idFromName: name => name, get: () => ({ fetch: request => { mirrorCalls.push(new URL(request.url).pathname); return mirror.fetch(request) } }) }
  const net = [], sockets = []
  const witness = new WitnessDO({ storage: ws.storage }, env, {
    now: () => clock.now,
    fetch: async (url, init) => {
      net.push(String(url))
      const index = ['https://a.pool.opentimestamps.org', 'https://b.pool.opentimestamps.org', 'https://a.pool.eternitywall.com', 'https://ots.btc.catallaxy.com'].indexOf(new URL(url).origin)
      if (init.method !== 'POST' || index < 0) return new Response('no', { status: 404 })
      const uri = new TextEncoder().encode(`https://c${index}.btc.calendar.opentimestamps.org`)
      return new Response(Uint8Array.of(0xf1, 4, 1, 2, 3, index, 0xf0, 8, 9, 9, 9, 9, 9, 9, 9, index, 0x00, 0x83, 0xdf, 0xe3, 0x0d, 0x2e, 0xf9, 0x0c, 0x8e, uri.length + 1, uri.length, ...uri), { status: 200 })
    },
    openSocket: url => {
      const listeners = {}, emit = (type, value) => { for (const listener of listeners[type] ?? []) listener(value) }
      const socket = { url, addEventListener: (type, listener) => { (listeners[type] ??= []).push(listener) },
        send: data => { const event = JSON.parse(data)[1]; queueMicrotask(() => emit('message', { data: JSON.stringify(['OK', event.id, true, '']) })) }, close() {} }
      sockets.push(socket)
      queueMicrotask(() => emit('open', {}))
      return socket
    },
    timers: { set: fn => setTimeout(fn, 1), clear: id => clearTimeout(id) },
  })
  const witnessCalls = []
  env.WITNESS = { idFromName: name => name, get: () => ({ fetch: request => { witnessCalls.push(new URL(request.url).pathname + new URL(request.url).search); return witness.fetch(request) } }) }
  const worker = createWorker({ verifyAccess: async () => session.identity, now: () => clock.now, networkFetch: () => assert.fail('No live network') })
  const call = (path, { method = 'GET', body, headers = {}, signedOut = false } = {}) => worker.fetch(new Request(ORIGIN + path, { method,
    headers: { ...(signedOut ? { 'cf-connecting-ip': '198.51.100.7' } : { origin: ORIGIN, 'sec-fetch-site': 'same-origin' }),
      ...(method === 'POST' ? { 'content-type': 'application/json' } : {}), ...headers },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) }), env)
  const receipts = receiptsText(3)
  const code = 'export const fixture = true;\n', moduleSha = await digest(code)
  const draft = { version: 'x6.1-ball/v1', epoch: 4, parentBallId: null, createdAt: '2026-11-12T00:00:00.000Z', authorPeerId: 'fixture-peer',
    entries: { fixture: { id: 'fixture', specifier: `ball:${moduleSha}`, disabled: false, config: {}, previousSpecifiers: [] } },
    modules: { [moduleSha]: { sha256: moduleSha, specifier: `ball:${moduleSha}`, size: Buffer.byteLength(code) } } }
  const ball = { ...draft, ballId: await manifestIdCanon(draft) }
  const file = text => ({ kind: 'file', mode: 0o600, mtimeMs: 1, b64: Buffer.from(text).toString('base64') })
  const dir = { kind: 'dir', mode: 0o700 }
  const entries = [['/dsh/home/auma', dir],
    ['/dsh/home/auma/HANDOFF.md', file(`| epoch | **${ball.epoch}** |\n| ballId | \`${ball.ballId}\` |\n`)],
    ['/dsh/home/auma/memory', dir], ['/dsh/home/auma/memory/dag', dir],
    ['/dsh/home/auma/memory/dag/HEAD.json', file(JSON.stringify({ heads: [], count: 0 }))],
    ['/dsh/home/auma/seed', dir], ['/dsh/home/auma/seed/discovery-corpus.v1.jsonl', file('')],
    [RECEIPTS_PATH, file(receipts.text)],
    ['/dsh/home/auma/superagent', dir], ['/dsh/home/auma/superagent/state.json', file(JSON.stringify({ assignments: [] }))],
    ['/dsh/home/auma/voice', dir], [VOICE, file(voice)],
    ...(timeline === null ? [] : [['/dsh/home/auma/timeline', dir], [TIMELINE, file(timeline)]])].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
  const payload = { version: BOOTSTRAP_VERSION, ball, codeBySha: { [moduleSha]: code }, mirror: { entryCount: entries.length, batchDigests: [await digest(canonicalBootstrap(entries))] } }
  const prepared = await call('/_bootstrap', { method: 'POST', body: { action: 'prepare', package: payload } })
  assert.equal(prepared.status, 200, await prepared.clone().text())
  const { seedId } = await prepared.json()
  const batched = await call('/_bootstrap', { method: 'POST', body: { action: 'batch', seedId, index: 0, entries } })
  assert.equal(batched.status, 200, await batched.clone().text())
  assert.equal((await call('/_bootstrap', { method: 'POST', body: { action: 'commit', seedId } })).status, 200)
  if (identity) await provisionMessagesIdentity(hs.storage, { approved: true })
  const tick = async () => (await witness.fetch(new Request('https://x61.internal/_witness/tick', { method: 'POST', headers: { 'x-x6-internal-authorized': '1' } }))).json()
  const record = async seq => (await witness.fetch(new Request('https://x61.internal/_witness/record?seq=' + seq, { headers: { 'x-x6-internal-authorized': '1' } }))).json()
  const journals = async () => {
    const response = await mirror.fetch(new Request('https://x61.internal/_mirror/witness-journals', { headers: { 'x-x6-internal-authorized': '1', 'x-x6-bootstrap-seed': seedId } }))
    return { status: response.status, body: await response.json() }
  }
  return { clock, hs, ms, ws, env, head, mirror, witness, worker, call, ball, receipts, seedId, session, access, headCalls, mirrorCalls, witnessCalls, net, sockets, tick, record, journals }
}

const lastLineDigest = text => { const lines = text.replace(/\n$/, '').split('\n'); return sha256(lines.at(-1)) }

test('a tick on the real HEAD and mirror: the record holds her head, the verified receipts head and her two journals', async t => {
  const voice = voiceChain(7)
  const fx = await stack(t, { voice })
  const answer = await fx.tick()
  assert.equal(answer.created, true, JSON.stringify(answer))
  assert.deepEqual(answer.codes, [])
  const one = await fx.record(1)
  assert.deepEqual(one.record.facts, {
    head: { ballId: fx.ball.ballId, epoch: fx.ball.epoch },
    receipts: { leafHash: fx.receipts.leaf, rows: 3 },
    journals: [{ path: VOICE, bytes: Buffer.byteLength(voice), last: lastLineDigest(voice) }, { path: TIMELINE, bytes: 0, last: '' }],
    nightly: null, // This stack has no NIGHTLY_COPY switch, so the nightly fact is null with nightly-off.
  })
  assert.deepEqual(one.record.missing, ['nightly-off'])
  assert.equal(one.digest, sha256(sorted(one.record)))
  // HEAD signed the event through its WITNESS hook; checked here independently.
  const event = one.event
  assert.equal(event.id, sha256(JSON.stringify([0, event.pubkey, event.created_at, event.kind, event.tags, event.content])))
  assert.equal(schnorr.verify(Buffer.from(event.sig, 'hex'), Buffer.from(event.id, 'hex'), Buffer.from(event.pubkey, 'hex')), true)
  assert.deepEqual(event.tags, [['seq', '1'], ['digest', one.digest], ['chain', 'witness.v1']])
  assert.deepEqual(fx.hs.snapshot().get(WITNESS_SIGNER_KEY).id, event.id)
  assert.ok(fx.headCalls.includes('/_head/witness/facts') && fx.headCalls.includes('/_head/witness/sign'))
  assert.ok(fx.mirrorCalls.includes('/_mirror/witness-journals'))
  assert.deepEqual(fx.sockets.map(socket => socket.url), WITNESS_RELAYS)
})

test('the mirror\'s journals read: byte lengths and the last line\'s digest from the newest 64 KiB, across chunk boundaries', async t => {
  // About 200 KiB of short lines: the file spans three of the mirror's storage chunks; only the tail is read.
  const voice = voiceChain(1700), timeline = voiceChain(3, 60).replace(/\n$/, '')
  const fx = await stack(t, { voice, timeline })
  assert.ok(Buffer.byteLength(voice) > 2 * 72 * 1024)
  const { status, body } = await fx.journals()
  assert.equal(status, 200)
  assert.deepEqual(body, { ok: true, journals: [
    { path: VOICE, bytes: Buffer.byteLength(voice), last: lastLineDigest(voice) },
    { path: TIMELINE, bytes: Buffer.byteLength(timeline), last: lastLineDigest(timeline) },
  ] })
  // Internal only, with this world's seed; no query; GET only.
  const outside = await fx.mirror.fetch(new Request('https://x61.internal/_mirror/witness-journals'))
  assert.equal(outside.status, 401)
  const noSeed = await fx.mirror.fetch(new Request('https://x61.internal/_mirror/witness-journals', { headers: { 'x-x6-internal-authorized': '1' } }))
  assert.equal(noSeed.status, 503)
  const query = await fx.mirror.fetch(new Request('https://x61.internal/_mirror/witness-journals?x=1', { headers: { 'x-x6-internal-authorized': '1', 'x-x6-bootstrap-seed': fx.seedId } }))
  assert.equal(query.status, 400)
})

test('a last line longer than 64 KiB is over the bound: the record carries journals null with journals-over-bound', async t => {
  const voice = voiceChain(2) + JSON.stringify({ v: 1, seq: 3, pad: 'y'.repeat(70 * 1024) }) + '\n'
  const fx = await stack(t, { voice })
  const { status, body } = await fx.journals()
  assert.equal(status, 413)
  assert.deepEqual(body, { ok: false, code: 'MIRROR_WITNESS_OVER_BOUND' })
  await fx.tick()
  const one = await fx.record(1)
  assert.equal(one.record.facts.journals, null)
  assert.deepEqual(one.record.missing, ['journals-over-bound', 'nightly-off'])
  assert.notEqual(one.eventId, null, 'a missing fact never stops the tick')
})

test('no node key on the real HEAD: the record is made and stamped, with no event and nothing minted', async t => {
  const fx = await stack(t, { identity: false })
  const answer = await fx.tick()
  assert.equal(answer.created, true)
  assert.deepEqual(answer.codes, ['WITNESS_IDENTITY_REQUIRED'])
  const one = await fx.record(1)
  assert.equal(one.eventId, null)
  assert.equal(one.ots.state, 'pending')
  assert.equal(fx.hs.snapshot().has(WITNESS_SIGNER_KEY), false)
  assert.equal(fx.sockets.length, 0)
})

test('through the real Worker: the signed-out door serves the public view and the stored proof bytes, never the facts', async t => {
  const fx = await stack(t)
  await fx.tick()
  const one = await fx.record(1)
  const pub = await fx.call('/api/witness', { signedOut: true })
  assert.equal(pub.status, 200)
  const body = await pub.json()
  assert.deepEqual(body, { schema: 'witness.v1', pubkey: one.event.pubkey, head: { seq: 1, digest: one.digest, at: one.record.at },
    records: [{ seq: 1, at: one.record.at, digest: one.digest, prev: '0'.repeat(64), eventId: one.eventId, trigger: 'schedule',
      relays: { ok: 5, of: 5, held: null, heldCheckedAt: null, rows: WITNESS_RELAYS.map(url => ({ relay: new URL(url).hostname, sent: 'ok', held: null })) }, ots: { state: 'pending', height: null, header: null }, tsa: null }] })
  for (const word of ['facts', 'missing', 'nonce', fx.ball.ballId, fx.receipts.leaf]) assert.equal(JSON.stringify(body).includes(word), false, word)
  const proof = await fx.call('/api/witness/ots?seq=1', { signedOut: true })
  assert.equal(proof.status, 200)
  assert.equal(Buffer.from(await proof.arrayBuffer()).toString('hex'), fx.ws.snapshot().get('witness:ots:1'))
  assert.equal((await fx.call('/api/witness/ots?seq=2', { signedOut: true })).status, 404)
})

test('the owner door shows the whole record (facts included) to the owner session only', async t => {
  const fx = await stack(t)
  await fx.tick()
  const one = await fx.record(1)
  const owner = await fx.call('/_head/witness/record?seq=1')
  assert.equal(owner.status, 200)
  const body = await owner.json()
  assert.equal(owner.headers.get('cache-control'), 'no-store')
  assert.deepEqual(body.record, one.record)
  assert.equal(body.digest, one.digest)
  assert.equal((await fx.call('/_head/witness/record?seq=7')).status, 404)
  assert.equal((await fx.call('/_head/witness/record?seq=01')).status, 404)
  assert.equal((await fx.call('/_head/witness/record')).status, 404)
  assert.equal((await fx.call('/_head/witness/record?seq=1', { method: 'POST', body: {} })).status, 405)
  assert.equal((await fx.call('/_head/witness/record?seq=1', { headers: { 'sec-fetch-site': 'cross-site', origin: '' } })).status, 403)
  assert.equal((await fx.call('/_head/witness/record?seq=1', { signedOut: true })).status, 403, 'an owner session without her page\'s same-origin marks')
  fx.session.identity = null
  assert.equal((await fx.call('/_head/witness/record?seq=1')).status, 401)
  fx.session.identity = { ...fx.access, type: 'access' }
  assert.equal((await fx.call('/_head/witness/record?seq=1')).status, 403)
  fx.session.identity = { ...fx.access, email: 'someone@example.invalid' }
  assert.equal((await fx.call('/_head/witness/record?seq=1')).status, 403)
})

test('/_witness/* and HEAD\'s witness routes are unreachable from outside, signed out or as the owner', async t => {
  const fx = await stack(t)
  await fx.tick()
  const witnessBefore = fx.witnessCalls.length, headBefore = fx.headCalls.length, snapshot = fx.ws.snapshot()
  // As the owner (from her page and from elsewhere) and with no session at all.
  for (const identity of [fx.access, null]) {
    fx.session.identity = identity
    for (const path of ['/_witness/tick', '/_witness/public', '/_witness/record?seq=1', '/_witness/ots?seq=1', '/_witness/', '/_witness']) {
      for (const method of ['GET', 'POST']) for (const signedOut of [true, false]) {
        const response = await fx.call(path, { method, signedOut, ...(method === 'POST' ? { body: {} } : {}) })
        assert.equal(response.status, 404, `${method} ${path} ${signedOut} ${identity === null}`)
      }
    }
    for (const path of ['/_head/witness/sign', '/_head/witness/facts']) {
      for (const method of ['GET', 'POST']) for (const signedOut of [true, false]) {
        const response = await fx.call(path, { method, signedOut, ...(method === 'POST' ? { body: { seq: 2, digest: 'e'.repeat(64), prevEventId: 'f'.repeat(64) } } : {}) })
        assert.notEqual(response.status, 200, `${method} ${path}`)
      }
    }
  }
  assert.equal(fx.witnessCalls.length, witnessBefore, 'no outside request reached the witness object')
  assert.equal(fx.headCalls.slice(headBefore).some(path => path.startsWith('/_head/witness/')), false, 'no outside request reached HEAD\'s witness routes')
  assert.deepEqual(fx.ws.snapshot(), snapshot)
})

test('the Worker\'s scheduled handler runs one tick through the real objects', async t => {
  const fx = await stack(t)
  assert.equal(await fx.worker.scheduled({ cron: '17 * * * *', scheduledTime: fx.clock.now }, fx.env, { waitUntil: () => {} }), undefined)
  assert.deepEqual(fx.witnessCalls, ['/_witness/tick'])
  assert.equal((await fx.record(1)).seq, 1)
})

test('B through the real Worker: /api/witness/record is 404 NOT_PUBLIC while off; on, byte for byte the owner route\'s record', async t => {
  const fx = await stack(t)
  await fx.tick()
  const before = fx.witnessCalls.length
  for (const value of [undefined, 'off', 'On', 'yes']) {
    if (value === undefined) delete fx.env.WITNESS_RECORD_PUBLIC
    else fx.env.WITNESS_RECORD_PUBLIC = value
    const off = await fx.call('/api/witness/record?seq=1', { signedOut: true })
    assert.equal(off.status, 404, String(value))
    assert.deepEqual(await off.json(), { ok: false, code: 'WITNESS_RECORD_NOT_PUBLIC' })
  }
  assert.equal(fx.witnessCalls.length, before, 'off makes no call to the witness object')
  fx.env.WITNESS_RECORD_PUBLIC = 'on'
  const response = await fx.call('/api/witness/record?seq=1', { signedOut: true })
  assert.equal(response.status, 200)
  const text = await response.text(), body = JSON.parse(text)
  assert.deepEqual(Object.keys(body), ['ok', 'seq', 'digest', 'record'])
  assert.equal(sha256(sorted(body.record)), body.digest, 'the digest recomputed here from the answer alone')
  const owner = await (await fx.call('/_head/witness/record?seq=1')).json()
  assert.equal(JSON.stringify(body.record), JSON.stringify(owner.record), 'byte for byte the owner route\'s record')
  assert.equal(body.digest, owner.digest)
  const stored = fx.ws.snapshot().get('witness:record:1')
  for (const word of [stored.nonce, 'relays', 'wss://', stored.eventId, 'trigger']) assert.equal(text.includes(word), false, word)
  assert.equal((await fx.call('/api/witness/record?seq=2', { signedOut: true })).status, 404)
})
