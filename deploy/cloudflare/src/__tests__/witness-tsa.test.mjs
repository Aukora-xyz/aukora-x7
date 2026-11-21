/** A second timestamp of another kind (RFC 3161, from freetsa.org), STORED and sanity-read, never verified at the
 * edge. The query bytes are compared with the research file's layout (a 69-byte SHA-256 query with an 8-byte nonce and
 * certReq TRUE, as LibreSSL wrote it for the digest of "abc"); the authority is a fake. No network. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createIsolateShield, ISOLATE_SHIELD } from '../worker.mjs'
import { TSA_AUTHORITY, TSA_URL, sanityReadReply, timestampQuery, tsaNonce } from '../tsa.mjs'
import { WITNESS_LIMITS, WITNESS_PUBLIC_ROUTES, WitnessDO, createWitnessReadDoor, projectWitnessPublic, witnessTsaOn } from '../witness-do.mjs'

const HOUR = 3_600_000
const T0 = 1_794_830_400_000
const hex = bytes => Buffer.from(bytes).toString('hex')
const unhex = text => new Uint8Array(Buffer.from(text, 'hex'))
const cat = (...parts) => new Uint8Array(Buffer.concat(parts.map(part => Buffer.from(part))))
const ABC = createHash('sha256').update('abc').digest('hex')
/** DER: a tag, its length (short or long form), its body. */
const der = (tag, body) => {
  const length = body.length < 0x80 ? [body.length] : body.length < 0x100 ? [0x81, body.length] : [0x82, body.length >> 8, body.length & 0xff]
  return cat([tag], length, body)
}
/** OID 1.2.840.113549.1.7.2 (signedData), DER. */
const SIGNED_DATA = unhex('06092a864886f70d010702')
/** A token-like ContentInfo: SEQUENCE { signedData OID, [0] { SEQUENCE { the given body } } }. */
const token = body => der(0x30, cat(SIGNED_DATA, der(0xa0, der(0x30, body))))
/** A reply shaped as RFC 3161's TimeStampResp: PKIStatusInfo, then a token (a signedData ContentInfo) holding the digest and nonce. */
const tsaReply = (status, { digest, nonce, pad = 400 } = {}) => der(0x30, cat(der(0x30, cat([0x02, 0x01, status])),
  ...(status <= 1 ? [token(cat(...(digest ? [der(0x04, digest)] : []), ...(nonce ? [der(0x02, nonce)] : []), der(0x04, new Uint8Array(pad).fill(0x55))))] : [])))

test('the query: 69 bytes exactly as the research file lays it out (digest of "abc", nonce, certReq TRUE)', () => {
  const nonce = unhex('0102030405060708')
  const query = timestampQuery(unhex(ABC), nonce)
  assert.equal(query.length, 69)
  assert.equal(hex(query), '3043' + '020101' + '3031' + '300d' + '0609608648016503040201' + '0500' + '0420' + ABC + '0208' + '0102030405060708' + '0101ff')
  // The nonce's lead byte is kept below 0x80 (no padding byte) and above 0 (no non-minimal INTEGER).
  assert.deepEqual(tsaNonce(unhex('ff00000000000001')), unhex('7f00000000000001'))
  assert.deepEqual(tsaNonce(unhex('8000000000000001')), unhex('0100000000000001'))
  assert.deepEqual(tsaNonce(unhex('0000000000000001')), unhex('0100000000000001'))
  for (const bad of [unhex('80'.repeat(8)), unhex('00'.repeat(8)), new Uint8Array(7)]) assert.throws(() => timestampQuery(unhex(ABC), bad), { code: 'TSA_INPUT_INVALID' })
  assert.throws(() => timestampQuery(new Uint8Array(31), nonce), { code: 'TSA_INPUT_INVALID' })
  assert.equal(TSA_URL, 'https://freetsa.org/tsr')
  assert.equal(TSA_AUTHORITY, 'freetsa.org')
})

test('the sanity read: status 0 or 1 with the digest and the nonce in the reply; anything else refused; never a "verified"', () => {
  const digest = unhex(ABC), nonce = unhex('0102030405060708')
  assert.deepEqual(sanityReadReply(tsaReply(0, { digest, nonce }), { digest, nonce }), { status: 0 })
  assert.deepEqual(sanityReadReply(tsaReply(1, { digest, nonce }), { digest, nonce }), { status: 1 })
  assert.deepEqual(sanityReadReply(tsaReply(0, { digest, nonce })), { status: 0 }, 'the shape alone, for the door')
  assert.throws(() => sanityReadReply(tsaReply(2), { digest, nonce }), { code: 'TSA_REPLY_STATUS' })
  assert.throws(() => sanityReadReply(tsaReply(0, { nonce }), { digest, nonce }), { code: 'TSA_REPLY_NO_DIGEST' })
  assert.throws(() => sanityReadReply(tsaReply(0, { digest }), { digest, nonce }), { code: 'TSA_REPLY_NO_NONCE' })
  assert.throws(() => sanityReadReply(tsaReply(0, { digest, nonce, pad: 16 * 1024 }), { digest, nonce }), { code: 'TSA_REPLY_TOO_LARGE' })
  const good = tsaReply(0, { digest, nonce })
  for (const bad of [new Uint8Array(0), good.subarray(0, good.length - 1), cat(good, [0]), cat([0x31], good.subarray(1)), unhex('3003020100'), unhex('30053003020201')]) {
    assert.throws(() => sanityReadReply(bad), { code: 'TSA_REPLY_MALFORMED' }, hex(bad))
  }
  // Review: a token must follow the status, and the digest and nonce must sit inside it.
  const statusOnly = unhex('3003020100')
  // Our own query echoed back after a status 0 (76 bytes): it holds the digest and nonce, but no token.
  const echoed = der(0x30, cat(statusOnly, timestampQuery(digest, nonce)))
  assert.equal(echoed.length, 76)
  assert.throws(() => sanityReadReply(echoed, { digest, nonce }), { code: 'TSA_REPLY_NO_TOKEN' })
  assert.throws(() => sanityReadReply(echoed), { code: 'TSA_REPLY_NO_TOKEN' }, 'the door too')
  // Status 0 with nothing after it, or with a SEQUENCE that is not a signedData ContentInfo.
  assert.throws(() => sanityReadReply(der(0x30, statusOnly), { digest, nonce }), { code: 'TSA_REPLY_NO_TOKEN' })
  assert.throws(() => sanityReadReply(der(0x30, cat(statusOnly, der(0x30, cat(unhex('06092a864886f70d010701'), der(0x04, digest), der(0x02, nonce))))), { digest, nonce }), { code: 'TSA_REPLY_NO_TOKEN' })
  // A token followed by anything more is not a TimeStampResp.
  assert.throws(() => sanityReadReply(der(0x30, cat(statusOnly, token(cat(der(0x04, digest), der(0x02, nonce))), der(0x05, []))), { digest, nonce }), { code: 'TSA_REPLY_MALFORMED' })
  // The digest and nonce outside the token (in the status's free text) do not count.
  const outside = der(0x30, cat(der(0x30, cat([0x02, 0x01, 0x00], der(0x30, der(0x0c, cat(digest, nonce))))), token(der(0x04, new Uint8Array(40)))))
  assert.throws(() => sanityReadReply(outside, { digest, nonce }), { code: 'TSA_REPLY_NO_DIGEST' })
  const outsideNonce = der(0x30, cat(der(0x30, cat([0x02, 0x01, 0x00], der(0x30, der(0x0c, nonce)))), token(der(0x04, digest))))
  assert.throws(() => sanityReadReply(outsideNonce, { digest, nonce }), { code: 'TSA_REPLY_NO_NONCE' })
  // A status 2 reply carries no token and is refused by its status first.
  assert.throws(() => sanityReadReply(der(0x30, unhex('3003020102')), { digest, nonce }), { code: 'TSA_REPLY_STATUS' })
  const source = readFileSync(new URL('../tsa.mjs', import.meta.url), 'utf8') + readFileSync(new URL('../witness-do.mjs', import.meta.url), 'utf8')
  assert.equal(/tsa\w*verified|verified\w*tsa/i.test(source), false, 'no name calls the token verified')
})

function memoryStorage() {
  const data = new Map()
  return { data, storage: {
    get: async key => Array.isArray(key) ? new Map(key.filter(name => data.has(name)).map(name => [name, structuredClone(data.get(name))])) : structuredClone(data.get(key)),
    put: async (key, value) => { data.set(key, structuredClone(value)) },
    delete: async key => data.delete(key), getAlarm: async () => null, setAlarm: async () => {},
  } }
}

/** The object with no HEAD (a record is still made, its facts missing) and a fake authority answering by `rule`. */
async function fixture(options = {}) {
  const { rule = 'good', old = 0 } = options
  const tsa = Object.hasOwn(options, 'tsa') ? options.tsa : 'on'
  const ws = memoryStorage(), calls = []
  const clock = { now: T0 }
  const state = { rule }
  const fetch = async (url, init = {}) => {
    const call = { url: String(url), method: init.method, headers: Object.fromEntries(new Headers(init.headers)), body: init.body ? new Uint8Array(init.body) : null, redirect: init.redirect, signal: init.signal }
    calls.push(call)
    if (call.url !== TSA_URL) return new Response('no', { status: 500 })
    const body = call.body, digest = body.subarray(24, 56), nonce = body.subarray(58, 66)
    const now = typeof state.rule === 'function' ? state.rule(call) : state.rule
    if (now === 'good') return new Response(tsaReply(0, { digest, nonce }), { headers: { 'content-type': 'application/timestamp-reply' } })
    if (now === 'mods') return new Response(tsaReply(1, { digest, nonce }))
    if (now === 'rejected') return new Response(tsaReply(2))
    if (now === 'no-digest') return new Response(tsaReply(0, { nonce }))
    if (now === 'no-nonce') return new Response(tsaReply(0, { digest }))
    if (now === 'echo') return new Response(der(0x30, cat(unhex('3003020100'), body)))
    if (now === 'big') return new Response(tsaReply(0, { digest, nonce, pad: WITNESS_LIMITS.tsaReplyBytes }))
    if (now === 'slow') throw new DOMException('The operation timed out.', 'TimeoutError')
    if (now === 'redirect') return new Response(null, { status: 302, headers: { location: 'https://elsewhere.example/' } })
    return new Response('busy', { status: 503 })
  }
  for (let seq = 1; seq <= old; seq++) {
    await ws.storage.put(`witness:record:${seq}`, { seq, digest: String(seq).repeat(64).slice(0, 64), record: { v: 1, seq, prev: '0'.repeat(64), at: T0 - (old - seq + 1) * 60_000,
      facts: { head: null, receipts: null, journals: null }, missing: ['head-unavailable', 'journals-unavailable', 'receipts-unavailable'] },
    nonce: '0'.repeat(32), eventId: null, event: null, relays: null, publishAttempts: 0, ots: { state: 'pending', height: null, attempts: 1, at: T0 }, trigger: 'schedule' })
  }
  if (old) await ws.storage.put('witness:meta', { seq: old, pubkey: null, signed: old })
  let nonces = 0
  const object = new WitnessDO({ storage: ws.storage }, { WITNESS_SWITCH: 'on', ...(tsa === undefined ? {} : { WITNESS_TSA: tsa }) }, { now: () => clock.now, fetch,
    openSocket: () => { throw new Error('no sockets') }, randomBytes: count => { nonces++; return new Uint8Array(count).fill(0x80 + nonces) },
    timers: { set: fn => setTimeout(fn, 1), clear: id => clearTimeout(id) } })
  const internal = path => object.fetch(new Request('https://x61.internal' + path, { headers: { 'x-x6-internal-authorized': '1' } }))
  const tick = async () => (await object.fetch(new Request('https://x61.internal/_witness/tick', { method: 'POST', headers: { 'x-x6-internal-authorized': '1' } }))).json()
  const entry = async seq => ws.storage.get(`witness:record:${seq}`)
  const row = async seq => (await (await internal('/_witness/public')).json()).public.records.find(item => item.seq === seq)
  const tsaCalls = () => calls.filter(call => call.url === TSA_URL)
  return { ws, calls, clock, state, object, internal, tick, entry, row, tsaCalls }
}

test('a new record: one request to freetsa.org with the record\'s digest only; the reply stored beside it; the row and the route', async () => {
  const fx = await fixture()
  const result = await fx.tick()
  assert.equal(result.created, true)
  const one = await fx.entry(1)
  const [call] = fx.tsaCalls()
  assert.equal(fx.tsaCalls().length, 1)
  assert.equal(call.method, 'POST')
  assert.equal(call.redirect, 'manual')
  assert.ok(call.signal instanceof AbortSignal)
  assert.deepEqual(call.headers, { 'content-type': 'application/timestamp-query', accept: 'application/timestamp-reply', 'user-agent': 'tsa-client/1' })
  assert.equal(call.body.length, 69)
  // The body is the query for this record's digest: what leaves is that digest and a fresh random nonce, nothing else.
  const nonce = call.body.subarray(58, 66)
  assert.deepEqual(call.body, timestampQuery(unhex(one.digest), nonce))
  assert.ok(nonce[0] > 0 && nonce[0] < 0x80)
  assert.deepEqual(one.tsa, { state: 'stored', at: T0 })
  assert.equal(one.tsaTries, 1)
  assert.deepEqual(Object.keys(one.record).sort(), ['at', 'facts', 'missing', 'prev', 'seq', 'v'], 'the hashed record keeps its shape')
  assert.deepEqual((await fx.row(1)).tsa, { state: 'stored', authority: 'freetsa.org', at: T0 })
  const stored = fx.ws.data.get('witness:tsa:1')
  const route = await fx.internal('/_witness/tsa?seq=1')
  assert.equal(route.status, 200)
  assert.equal(route.headers.get('content-type'), 'application/timestamp-reply')
  assert.equal(hex(new Uint8Array(await route.arrayBuffer())), stored)
  assert.equal((await fx.internal('/_witness/tsa?seq=2')).status, 404)
  // Stored once: a later hourly tick asks nothing about record 1.
  fx.clock.now += HOUR
  await fx.tick()
  assert.equal(fx.tsaCalls().length, 1)
})

test('status 1 (granted with modifications) is stored too; another status, no digest, no nonce, our query echoed with no token, too large, too slow, a redirect: failed', async () => {
  const mods = await fixture({ rule: 'mods' })
  await mods.tick()
  assert.equal((await mods.entry(1)).tsa.state, 'stored')
  for (const rule of ['rejected', 'no-digest', 'no-nonce', 'echo', 'big', 'slow', 'redirect', 'down']) {
    const fx = await fixture({ rule })
    await fx.tick()
    assert.deepEqual((await fx.entry(1)).tsa, { state: 'failed', at: T0 }, rule)
    assert.equal(fx.ws.data.has('witness:tsa:1'), false, rule)
    assert.deepEqual((await fx.row(1)).tsa, { state: 'failed', authority: 'freetsa.org', at: T0 }, rule)
    assert.equal((await fx.internal('/_witness/tsa?seq=1')).status, 404, rule)
  }
  assert.equal(WITNESS_LIMITS.tsaReplyBytes, 16 * 1024)
  assert.equal(WITNESS_LIMITS.tsaTimeoutMs, 8000)
})

test('at most 3 tries per record, one per tick; then never again', async () => {
  const fx = await fixture({ rule: 'down' })
  await fx.tick()
  // Hourly ticks inside the 4-hour spacing: no new record, so every request is a retry of record 1.
  for (let index = 1; index <= 3; index++) { fx.clock.now = T0 + index * HOUR; await fx.tick() }
  assert.equal(fx.tsaCalls().length, 3)
  assert.equal((await fx.entry(1)).tsaTries, 3)
  assert.equal(WITNESS_LIMITS.tsaTries, 3)
  // The third try answers: stored.
  const late = await fixture({ rule: call => late.tsaCalls().length >= 3 ? 'good' : 'down' })
  await late.tick()
  for (let index = 1; index <= 3; index++) { late.clock.now = T0 + index * HOUR; await late.tick() }
  assert.equal(late.tsaCalls().length, 3)
  assert.equal((await late.entry(1)).tsa.state, 'stored')
})

test('backfill: records made before this change get a token one per hourly tick, oldest first; none on a promotion tick', async () => {
  const fx = await fixture({ old: 3 })
  await fx.object.tick({ trigger: 'promotion' })
  assert.equal(fx.tsaCalls().length, 0, 'a promotion tick that makes no record asks nothing')
  const asked = []
  for (let index = 0; index < 4; index++) {
    fx.clock.now = T0 + index * HOUR
    const before = fx.tsaCalls().length
    await fx.tick()
    asked.push(fx.tsaCalls().slice(before).map(call => hex(call.body.subarray(24, 56))))
  }
  assert.deepEqual(asked, [['1'.repeat(64)], ['2'.repeat(64)], ['3'.repeat(64)], []])
  assert.equal(WITNESS_LIMITS.tsaBackfillPerTick, 1)
  for (const seq of [1, 2, 3]) assert.equal((await fx.entry(seq)).tsa.state, 'stored')
})

test('the switch: only exactly "on"; off, no request, rows read tsa null and the route answers nothing', async () => {
  for (const value of [undefined, 'off', 'ON', 'on ', '1', 'true']) {
    assert.equal(witnessTsaOn({ WITNESS_TSA: value }), false, String(value))
    const fx = await fixture({ tsa: value, old: 1 })
    fx.clock.now = T0 + 5 * HOUR
    await fx.tick()
    assert.deepEqual(fx.tsaCalls(), [], String(value))
    assert.equal((await fx.row(1)).tsa, null)
    assert.equal((await fx.row(2)).tsa, null)
  }
  assert.equal(witnessTsaOn({ WITNESS_TSA: 'on' }), true)
  // A token stored while on is not shown while off.
  const fx = await fixture()
  await fx.tick()
  const off = new WitnessDO({ storage: fx.ws.storage }, { WITNESS_SWITCH: 'on', WITNESS_TSA: 'off' }, { now: () => T0 })
  const view = await (await off.fetch(new Request('https://x61.internal/_witness/public', { headers: { 'x-x6-internal-authorized': '1' } }))).json()
  assert.equal(view.public.records[0].tsa, null)
  assert.equal((await off.fetch(new Request('https://x61.internal/_witness/tsa?seq=1', { headers: { 'x-x6-internal-authorized': '1' } }))).status, 404)
  // Shipped on, with the host and what it receives named beside it.
  const toml = readFileSync(new URL('../../wrangler.toml', import.meta.url), 'utf8')
  const vars = toml.slice(toml.indexOf('[vars]'), toml.indexOf('\n[', toml.indexOf('[vars]') + 1)).split('\n')
  const at = vars.findIndex(line => /^WITNESS_TSA\s*=/.test(line))
  assert.equal(vars[at], 'WITNESS_TSA = "on"')
  const comment = vars.slice(Math.max(0, at - 5), at).join('\n')
  for (const words of ['https://freetsa.org/tsr', '32-byte digest', 'nonce']) assert.ok(comment.includes(words), words)
})

const door = () => createWitnessReadDoor({ now: () => 0, shield: createIsolateShield(ISOLATE_SHIELD.guest), subjectOf: () => 'n' })
const get = path => { const url = new URL('https://node.example.invalid' + path); return [new Request(url), url] }

test('the signed-out route GET /api/witness/tsa?seq=n: found, not found, malformed query, an answer that is not a reply', async () => {
  assert.ok(WITNESS_PUBLIC_ROUTES.has('/api/witness/tsa'))
  const digest = unhex(ABC), nonce = unhex('0102030405060708'), reply = tsaReply(0, { digest, nonce })
  const asked = []
  const read = async path => {
    asked.push(path)
    if (path === '/_witness/tsa?seq=1') return new Response(reply, { status: 200, headers: { 'content-type': 'application/timestamp-reply' } })
    if (path === '/_witness/tsa?seq=3') return new Response(unhex('3003020102'), { status: 200 })
    if (path === '/_witness/tsa?seq=4') return new Response(new Uint8Array(16 * 1024 + 1), { status: 200 })
    return Response.json({ ok: false, code: 'WITNESS_TSA_NONE' }, { status: 404 })
  }
  const d = door()
  const found = await d.serve(...get('/api/witness/tsa?seq=1'), read)
  assert.equal(found.status, 200)
  assert.equal(found.headers.get('content-type'), 'application/timestamp-reply')
  assert.equal(found.headers.get('content-disposition'), 'attachment; filename="witness-1.tsr"')
  assert.equal(found.headers.get('cache-control'), 'public, max-age=60')
  assert.equal(found.headers.get('access-control-allow-origin'), '*')
  assert.deepEqual(new Uint8Array(await found.arrayBuffer()), reply)
  const none = await d.serve(...get('/api/witness/tsa?seq=2'), read)
  assert.equal(none.status, 404)
  assert.deepEqual(await none.json(), { ok: false, code: 'WITNESS_TSA_NONE' })
  for (const seq of [3, 4]) assert.equal((await d.serve(...get(`/api/witness/tsa?seq=${seq}`), read)).status, 503, String(seq))
  const before = asked.length
  for (const path of ['/api/witness/tsa', '/api/witness/tsa?seq=01', '/api/witness/tsa?seq=', '/api/witness/tsa?seq=1&x=1', '/api/witness/tsa?x=1', '/api/witness/tsa?seq=1#x']) {
    const response = await d.serve(...get(path), read)
    assert.equal(response.status, 404, path)
    assert.deepEqual(await response.json(), { ok: false, code: 'NOT_FOUND' }, path)
  }
  assert.equal(asked.length, before, 'a refused query asks the object nothing')
})

test('the public projection takes tsa null or one exact shape and refuses any other', () => {
  const D = n => String(n).repeat(64).slice(0, 64)
  const relays = { ok: 0, of: 5, held: null, heldCheckedAt: null, rows: ['relay.damus.io', 'nos.lol', 'relay.primal.net', 'relay.nostr.band', 'nostr.mom'].map(relay => ({ relay, sent: 'none', held: null })) }
  const view = tsa => ({ schema: 'witness.v1', pubkey: null, head: { seq: 1, digest: D(1), at: T0 },
    records: [{ seq: 1, at: T0, digest: D(1), prev: '0'.repeat(64), eventId: null, trigger: 'schedule', relays, ots: { state: 'pending', height: null, header: null }, tsa }] })
  for (const tsa of [null, { state: 'stored', authority: 'freetsa.org', at: T0 }, { state: 'failed', authority: 'freetsa.org', at: T0 }]) {
    assert.deepEqual(projectWitnessPublic(view(tsa)).records[0].tsa, tsa)
  }
  assert.deepEqual(projectWitnessPublic(view({ state: 'stored', authority: 'freetsa.org', at: T0, code: 'x' })).records[0].tsa, { state: 'stored', authority: 'freetsa.org', at: T0 })
  for (const bad of [undefined, { state: 'verified', authority: 'freetsa.org', at: T0 }, { state: 'stored', authority: 'other.example', at: T0 }, { state: 'stored', authority: 'freetsa.org' }, 'stored']) {
    assert.equal(projectWitnessPublic(view(bad)), null, JSON.stringify(bad))
  }
})
