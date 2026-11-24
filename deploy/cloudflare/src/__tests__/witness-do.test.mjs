/** The witness object (witness-do.mjs): one bounded tick (upgrade pass, retry pass, new record), the
 * stamp on four calendars, the upgrade from listed calendar hosts only, the signed event through HEAD's real sign route
 * (witness.mjs, over in-memory storage with a node key from the message store's own provisioning), and the publish to
 * three relays. Every outbound call goes to a fake `fetch` and a fake socket: no network. Expected values are recomputed
 * here with node:crypto. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { provisionMessagesIdentity, verifyNostrEvent } from '../messages-store.mjs'
import { handleWitnessHeadRoute, WITNESS_JOURNAL_PATHS, WITNESS_SIGNER_KEY } from '../witness.mjs'
import { parseOts, pendingLeaves, bitcoinAttestations } from '../ots.mjs'
import { WITNESS_CALENDARS, WITNESS_RELAYS, WITNESS_LIMITS, WitnessDO, relayState } from '../witness-do.mjs'

const SEED = '5'.repeat(64)
const HEAD = { ballId: 'a'.repeat(64), epoch: 80 }
const T0 = 1_794_830_400_000
const HOUR = 3_600_000
const hex = bytes => Buffer.from(bytes).toString('hex')
const unhex = text => new Uint8Array(Buffer.from(text, 'hex'))
const cat = (...parts) => new Uint8Array(Buffer.concat(parts.map(part => Buffer.from(part))))
const sha256 = bytes => new Uint8Array(createHash('sha256').update(bytes).digest())
const sorted = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(name => [name, item[name]])) : item)
const varuint = value => { const out = []; do { let byte = value & 0x7f; value = Math.floor(value / 128); if (value) byte |= 0x80; out.push(byte) } while (value); return Uint8Array.from(out) }
const varbytes = bytes => cat(varuint(bytes.length), bytes)
const pendingAtt = uri => cat([0x00], unhex('83dfe30d2ef90c8e'), varbytes(varbytes(new TextEncoder().encode(uri))))
const bitcoinAtt = height => cat([0x00], unhex('0588960d73d71901'), varbytes(varuint(height)))
const calendarReply = (prefix, suffix, uri) => cat([0xf1], varbytes(prefix), [0xf0], varbytes(suffix), pendingAtt(uri))
/** Where each default calendar says it will answer an upgrade (the last one is not on the upgrade list). */
const PENDING_URI = {
  'https://a.pool.opentimestamps.org': 'https://alice.btc.calendar.opentimestamps.org',
  'https://b.pool.opentimestamps.org': 'https://bob.btc.calendar.opentimestamps.org',
  'https://a.pool.eternitywall.com': 'https://finney.calendar.eternitywall.com',
  'https://ots.btc.catallaxy.com': 'https://ots.btc.catallaxy.com',
}

function memoryStorage() {
  let data = new Map(), tail = Promise.resolve()
  const view = rows => ({
    get: async key => Array.isArray(key) ? new Map(key.filter(name => rows.has(name)).map(name => [name, structuredClone(rows.get(name))])) : structuredClone(rows.get(key)),
    put: async (key, value) => { rows.set(key, structuredClone(value)) },
    delete: async key => rows.delete(key),
  })
  const storage = { get: key => view(data).get(key), put: (key, value) => view(data).put(key, value), delete: key => view(data).delete(key) }
  storage.transaction = operation => {
    const result = tail.then(async () => { const rows = structuredClone(data); const value = await operation(view(rows)); data = rows; return value })
    tail = result.catch(() => {})
    return result
  }
  // The Durable Object alarm: one time or null, as Cloudflare's getAlarm / setAlarm / deleteAlarm keep it.
  const alarm = { at: null, sets: [] }
  storage.getAlarm = async () => alarm.at
  storage.setAlarm = async at => { alarm.at = at; alarm.sets.push(at) }
  storage.deleteAlarm = async () => { alarm.at = null }
  return { storage, alarm, snapshot: () => structuredClone(data) }
}

/** Three relays that each answer by a rule: a function of the event, returning the frame to send back or null (silence). */
function relaySockets(rules) {
  const opened = []
  const open = url => {
    if (rules.throws) throw new Error('socket refused')
    const listeners = {}
    const emit = (type, value) => { for (const listener of listeners[type] ?? []) listener(value) }
    const socket = { url, sent: [], closed: false,
      addEventListener: (type, listener) => { (listeners[type] ??= []).push(listener) },
      send(data) {
        socket.sent.push(data)
        const frame = JSON.parse(data)
        // A read-back (REQ) is answered by `rules.read(url, subId, filter)`: the frames to send back, in order, or
        // null (silence). With no read rule a relay stays silent.
        if (frame[0] === 'REQ') {
          const frames = rules.read?.(url, frame[1], frame[2]) ?? []
          // A frame that is neither a string nor an array is the message object itself (a test that counts its reads).
          for (const out of frames) queueMicrotask(() => emit('message', typeof out === 'string' ? { data: out } : Array.isArray(out) ? { data: JSON.stringify(out) } : out))
          return
        }
        const answer = (rules[url] ?? rules.default)?.(frame[1])
        if (answer != null) queueMicrotask(() => emit('message', { data: typeof answer === 'string' ? answer : JSON.stringify(answer) }))
      },
      close() { socket.closed = true } }
    opened.push(socket)
    // `greet`: a frame the relay sends on its own as the socket opens (NIP-42's AUTH challenge), before any OK.
    queueMicrotask(() => { emit('open', {}); if (rules.greet) emit('message', { data: JSON.stringify(rules.greet) }) })
    return socket
  }
  return { open, opened }
}
const OK = event => ['OK', event.id, true, '']

/**
 * The witness object over in-memory storage, with HEAD's real witness routes (and its node key) behind env.HEAD, a fake
 * mirror behind env.MIRROR, and fake calendars and relays.
 */
async function fixture({ identity = true, calendars = {}, upgrades = {}, relays = {}, journals = 'ok', receipts = 'ok', head = HEAD, headBinding = true } = {}) {
  const clock = { now: T0 }
  const hs = memoryStorage(), ws = memoryStorage()
  if (identity) await provisionMessagesIdentity(hs.storage, { approved: true })
  const journalsAnswer = { ok: true, journals: [{ path: WITNESS_JOURNAL_PATHS[0], bytes: 1834, last: 'c'.repeat(64) }, { path: WITNESS_JOURNAL_PATHS[1], bytes: 0, last: '' }] }
  const mirrorCalls = []
  const mirror = { idFromName: name => name, get: () => ({ fetch: async request => {
    const path = new URL(request.url).pathname
    mirrorCalls.push({ path, seed: request.headers.get('x-x6-bootstrap-seed') })
    if (path === '/_mirror/witness-journals') {
      if (journals === 'over') return Response.json({ ok: false, code: 'MIRROR_WITNESS_OVER_BOUND' }, { status: 413 })
      if (journals !== 'ok') return Response.json({ ok: false, code: 'BOOTSTRAP_REQUIRED' }, { status: 503 })
      return Response.json(journalsAnswer)
    }
    if (receipts !== 'ok') return Response.json({ ok: false }, { status: 503 })
    return Response.json({ ok: true, seedId: SEED, scope: 'nostr-receipts-head', evidence: { status: 'complete', scope: 'nostr-receipts-head' },
      head: { ballId: request.headers.get('x-x6-aura-head'), epoch: Number(request.headers.get('x-x6-aura-epoch')) },
      receiptsLeafHash: 'b'.repeat(64), receiptRows: 9, verifiedReceipts: 9 })
  } }) }
  const headEnv = { WITNESS_SWITCH: 'on', MIRROR: mirror }
  const selected = { head } // HEAD's selected head; a test moves it to stand for a promotion.
  const headCalls = []
  const headBindingValue = { idFromName: name => name, get: () => ({ fetch: async request => {
    headCalls.push(new URL(request.url).pathname)
    return handleWitnessHeadRoute(request, { url: new URL(request.url), bootstrap: { seedId: SEED }, storage: hs.storage, env: headEnv,
      now: () => clock.now, readSelectedHead: async () => selected.head && { ...selected.head } })
  } }) }
  const net = []
  /** Calendars answer by rule: 'good' (a reply ending in a pending attestation), 'fail', 'big', 'junk', 'throw'. */
  const calendarRule = url => calendars[url] ?? calendars.default ?? 'good'
  const fetchFake = async (url, init = {}) => {
    const call = { url: String(url), method: init.method ?? 'GET', headers: Object.fromEntries(new Headers(init.headers)), body: init.body === undefined ? null : new Uint8Array(init.body), redirect: init.redirect }
    net.push(call)
    const target = new URL(call.url)
    if (call.method === 'POST' && target.pathname === '/digest') {
      const origin = target.origin, rule = calendarRule(origin)
      if (rule === 'throw') throw new TypeError('network down')
      if (rule === 'fail') return new Response('busy', { status: 503 })
      if (rule === 'big') return new Response(new Uint8Array(WITNESS_LIMITS.replyBytes + 1), { status: 200 })
      if (rule === 'junk') return new Response(unhex('55'), { status: 200 })
      if (rule === 'bitcoin-only') return new Response(cat([0x08], bitcoinAtt(1)), { status: 200 })
      // A reply the edge cannot run: RIPEMD-160 then SHA-256 (no ripemd160 at the edge); and one whose message outgrows the bound.
      if (rule === 'ripemd') return new Response(cat([0x03, 0x08], pendingAtt(PENDING_URI[origin])), { status: 200 })
      if (rule === 'long') return new Response(cat([0xf0], varbytes(new Uint8Array(4090)), pendingAtt(PENDING_URI[origin])), { status: 200 })
      const index = WITNESS_CALENDARS.indexOf(origin)
      return new Response(calendarReply(Uint8Array.of(1, 2, 3, index), Uint8Array.of(9, 9, 9, 9, 9, 9, 9, index), PENDING_URI[origin] ?? origin), { status: 200 })
    }
    const match = /^\/timestamp\/([0-9a-f]+)$/.exec(target.pathname)
    if (call.method === 'GET' && match) {
      const rule = upgrades[target.origin] ?? upgrades.default ?? 'pending'
      if (rule === 'pending') return new Response('Pending confirmation in Bitcoin blockchain', { status: 404 })
      if (rule === 'still-pending') return new Response(pendingAtt(target.origin), { status: 200 })
      if (typeof rule === 'number') return new Response(cat([0x08], bitcoinAtt(rule)), { status: 200 })
    }
    return new Response('unexpected', { status: 500 })
  }
  const sockets = relaySockets(relays)
  let nonces = 0
  const env = { WITNESS_SWITCH: 'on', HEAD: headBinding ? headBindingValue : undefined, MIRROR: mirror }
  const object = new WitnessDO({ storage: ws.storage }, env, {
    now: () => clock.now, fetch: fetchFake, openSocket: sockets.open,
    randomBytes: count => { nonces++; return new Uint8Array(count).fill(nonces) },
    timers: { set: fn => setTimeout(fn, 1), clear: id => clearTimeout(id) },
  })
  const call = async (path, init = {}) => {
    const response = await object.fetch(new Request('https://x61.internal' + path, { ...init, headers: { 'x-x6-internal-authorized': '1', ...(init.headers ?? {}) } }))
    return response
  }
  const tick = async () => { const response = await call('/_witness/tick', { method: 'POST' }); assert.equal(response.status, 200); return response.json() }
  const record = async seq => (await call('/_witness/record?seq=' + seq)).json()
  const pub = async () => (await call('/_witness/public')).json()
  const proof = async seq => { const response = await call('/_witness/ots?seq=' + seq); return response.status === 200 ? new Uint8Array(await response.arrayBuffer()) : null }
  return { clock, hs, ws, net, sockets, headCalls, mirrorCalls, object, env, call, tick, record, pub, proof, calendars, upgrades, relays, selected }
}

const posts = fx => fx.net.filter(call => call.method === 'POST')
const gets = fx => fx.net.filter(call => call.method === 'GET')

test('the first tick makes record 1 and stamps, signs and publishes it; 2 h later nothing new; 4 h later record 2, chained', async () => {
  const fx = await fixture({ relays: { default: OK } })
  const first = await fx.tick()
  assert.equal(first.ok, true)
  assert.equal(first.created, true)
  assert.equal(first.seq, 1)
  const one = await fx.record(1)
  assert.equal(one.ok, true)
  // A new record is v 2 and carries the nightly fact; this fixture has no NIGHTLY_COPY, so it is null, nightly-off.
  assert.deepEqual(one.record, { v: 2, seq: 1, prev: '0'.repeat(64), at: T0, missing: ['nightly-off'],
    facts: { head: HEAD, receipts: { leafHash: 'b'.repeat(64), rows: 9 },
      journals: [{ path: WITNESS_JOURNAL_PATHS[0], bytes: 1834, last: 'c'.repeat(64) }, { path: WITNESS_JOURNAL_PATHS[1], bytes: 0, last: '' }], nightly: null } })
  const digest1 = hex(sha256(new TextEncoder().encode(sorted(one.record))))
  assert.equal(one.digest, digest1)
  assert.deepEqual(one.ots, { state: 'pending', height: null })
  assert.equal(fx.mirrorCalls.find(call => call.path === '/_mirror/witness-journals').seed, SEED)
  // The stamp: sha256(digest || nonce) to each calendar; the stored proof is that digest, the nonce and four replies.
  const nonce = new Uint8Array(16).fill(1)
  const commitment = sha256(cat(unhex(digest1), nonce))
  assert.deepEqual(posts(fx).map(call => call.url).sort(), WITNESS_CALENDARS.map(origin => origin + '/digest').sort())
  for (const call of posts(fx)) assert.equal(hex(call.body), hex(commitment))
  const proof = await fx.proof(1)
  assert.equal(hex(parseOts(proof).digest), digest1)
  assert.equal((await pendingLeaves(proof)).length, 4)
  // The event: signed by HEAD, checked here.
  const event = one.event
  assert.equal(await verifyNostrEvent(event), true)
  assert.equal(one.eventId, event.id)
  assert.deepEqual(event.tags, [['seq', '1'], ['digest', digest1], ['chain', 'witness.v1']])
  assert.deepEqual(fx.sockets.opened.map(socket => socket.url), WITNESS_RELAYS)
  for (const socket of fx.sockets.opened) { assert.deepEqual(JSON.parse(socket.sent[0]), ['EVENT', event]); assert.equal(socket.closed, true) }
  assert.deepEqual(one.relays, Object.fromEntries(WITNESS_RELAYS.map(url => [url, 'ok'])))

  fx.clock.now = T0 + 2 * HOUR
  const quiet = await fx.tick()
  assert.equal(quiet.created, false)
  assert.equal((await fx.record(2)).ok, false)

  fx.clock.now = T0 + 4 * HOUR
  const next = await fx.tick()
  assert.equal(next.created, true)
  const two = await fx.record(2)
  assert.equal(two.record.prev, digest1)
  assert.deepEqual(two.event.tags, [['e', event.id], ['seq', '2'], ['digest', two.digest], ['chain', 'witness.v1']])
  const view = await fx.pub()
  assert.equal(view.ok, true)
  assert.deepEqual(view.public.head, { seq: 2, digest: two.digest, at: T0 + 4 * HOUR })
  assert.deepEqual(view.public.records.map(row => row.seq), [2, 1])
  // 3 h 59 min after record 2 is enough for record 3.
  fx.clock.now = T0 + 4 * HOUR + WITNESS_LIMITS.intervalMs
  assert.equal(WITNESS_LIMITS.intervalMs, 4 * HOUR - 60_000)
  assert.equal((await fx.tick()).created, true)
})

test('a fact that cannot be read is null with its reason and the tick still completes', async () => {
  const over = await fixture({ journals: 'over', receipts: 'fail', relays: { default: OK } })
  const result = await over.tick()
  assert.equal(result.ok, true)
  assert.equal(result.created, true)
  const { record } = await over.record(1)
  assert.deepEqual(record.facts, { head: HEAD, receipts: null, journals: null, nightly: null })
  assert.deepEqual(record.missing, ['journals-over-bound', 'nightly-off', 'receipts-unavailable'])

  const headless = await fixture({ headBinding: false, relays: { default: OK } })
  const answer = await headless.tick()
  assert.equal(answer.created, true)
  const plain = await headless.record(1)
  assert.deepEqual(plain.record.missing, ['head-unavailable', 'journals-unavailable', 'nightly-off', 'receipts-unavailable'])
  assert.equal(plain.eventId, null)
  assert.ok(answer.codes.includes('WITNESS_SIGN_UNAVAILABLE'))
  assert.deepEqual(plain.ots, { state: 'pending', height: null }, 'the stamp needs no HEAD')
})

test('stamp: 2 of 4 calendars is enough; 1 of 4 is failed and the next tick reuses the same nonce; bad replies do not count', async () => {
  const two = await fixture({ calendars: { 'https://a.pool.opentimestamps.org': 'fail', 'https://b.pool.opentimestamps.org': 'big' }, relays: { default: OK } })
  await two.tick()
  assert.deepEqual((await two.record(1)).ots, { state: 'pending', height: null })
  assert.equal((await pendingLeaves(await two.proof(1))).length, 2)

  const one = await fixture({ calendars: { default: 'junk', 'https://a.pool.eternitywall.com': 'good', 'https://ots.btc.catallaxy.com': 'bitcoin-only' }, relays: { default: OK } })
  const first = await one.tick()
  assert.ok(first.codes.includes('WITNESS_STAMP_FAILED'))
  assert.deepEqual((await one.record(1)).ots, { state: 'failed', height: null })
  assert.equal(await one.proof(1), null)
  const firstBodies = posts(one).map(call => hex(call.body))
  assert.equal(new Set(firstBodies).size, 1)
  // The next tick: the retry pass submits the SAME commitment (same nonce), and two calendars now answer.
  one.net.length = 0
  one.calendars.default = 'good'
  one.clock.now = T0 + HOUR
  const retry = await one.tick()
  assert.equal(retry.created, false)
  assert.equal(retry.stamped, 1)
  assert.deepEqual(posts(one).map(call => hex(call.body)), Array(4).fill(firstBodies[0]))
  assert.deepEqual((await one.record(1)).ots, { state: 'pending', height: null })

  // Three failed attempts, then never again.
  const never = await fixture({ calendars: { default: 'throw' }, relays: { default: OK } })
  for (let index = 0; index < 5; index++) { never.clock.now = T0 + index * HOUR / 2; await never.tick() }
  assert.equal(posts(never).length, 3 * 4)
  assert.deepEqual((await never.record(1)).ots, { state: 'failed', height: null })
})

test('every outbound request: only the listed hosts, the reference client\'s headers, a 32-byte body, no name of hers', async () => {
  const fx = await fixture({ relays: { default: OK }, upgrades: { default: 358400 } })
  await fx.tick()
  fx.clock.now = T0 + 2 * HOUR
  await fx.tick()
  for (const call of posts(fx)) {
    assert.ok(WITNESS_CALENDARS.includes(new URL(call.url).origin))
    assert.deepEqual(call.headers, { accept: 'application/vnd.opentimestamps.v1', 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'ots-client' })
    assert.equal(call.body.length, 32)
    assert.equal(call.redirect, 'manual')
  }
  assert.ok(gets(fx).length > 0)
  for (const call of gets(fx)) {
    assert.match(new URL(call.url).hostname, /\.calendar\.(?:opentimestamps\.org|eternitywall\.com|catallaxy\.com)$/)
    assert.equal(new URL(call.url).protocol, 'https:')
    assert.deepEqual(call.headers, { accept: 'application/vnd.opentimestamps.v1', 'user-agent': 'ots-client' })
  }
  for (const socket of fx.sockets.opened) assert.ok(WITNESS_RELAYS.includes(socket.url))
})

test('upgrade: under an hour nothing; pending stays pending; a Bitcoin attestation confirms with its height; 14 days is stale', async () => {
  const fx = await fixture({ relays: { default: OK } })
  await fx.tick()
  fx.clock.now = T0 + 30 * 60_000
  await fx.tick()
  assert.equal(gets(fx).length, 0, 'not before an hour')
  fx.clock.now = T0 + HOUR
  const pending = await fx.tick()
  // The three listed calendars are asked; catallaxy's pending host is not on the upgrade list and is never fetched.
  assert.deepEqual(gets(fx).map(call => new URL(call.url).origin), ['https://alice.btc.calendar.opentimestamps.org', 'https://bob.btc.calendar.opentimestamps.org', 'https://finney.calendar.eternitywall.com'])
  const leaves = await pendingLeaves(await fx.proof(1))
  assert.deepEqual(gets(fx).map(call => call.url), leaves.slice(0, 3).map(leaf => `${leaf.uri}/timestamp/${leaf.commitment}`))
  assert.equal(pending.confirmed, 0)
  assert.deepEqual((await fx.record(1)).ots, { state: 'pending', height: null })
  // A 200 that still holds only a pending attestation is not an upgrade.
  fx.upgrades.default = 'still-pending'
  fx.clock.now = T0 + 2 * HOUR
  await fx.tick()
  assert.deepEqual((await fx.record(1)).ots, { state: 'pending', height: null })
  // Bob's calendar has it in a block.
  fx.upgrades['https://bob.btc.calendar.opentimestamps.org'] = 358512
  fx.clock.now = T0 + 3 * HOUR
  const confirmed = await fx.tick()
  assert.equal(confirmed.confirmed, 1)
  assert.deepEqual((await fx.record(1)).ots, { state: 'confirmed', height: 358512 })
  const spliced = await fx.proof(1)
  assert.deepEqual(await bitcoinAttestations(spliced), [{ height: 358512, merkleRoot: hex(sha256(unhex(leaves[1].commitment))) }])
  // A confirmed proof is not asked about again.
  fx.net.length = 0
  fx.clock.now = T0 + 5 * HOUR
  await fx.tick()
  assert.equal(gets(fx).filter(call => call.url.includes(leaves[0].commitment)).length, 0)

  const old = await fixture({ relays: { default: OK } })
  await old.tick()
  old.clock.now = T0 + WITNESS_LIMITS.staleAfterMs
  old.net.length = 0
  const stale = await old.tick()
  assert.equal(stale.stale, 1)
  assert.deepEqual((await old.record(1)).ots, { state: 'stale', height: null })
  assert.equal(gets(old).length, 0)
})

test('at most 6 calendar GETs a tick, however many proofs wait', async () => {
  const fx = await fixture({ relays: { default: OK } })
  for (let index = 0; index < 4; index++) { fx.clock.now = T0 + index * 4 * HOUR; await fx.tick() }
  fx.net.length = 0
  fx.clock.now = T0 + 13 * HOUR
  await fx.tick()
  assert.equal(gets(fx).length, WITNESS_LIMITS.upgradeGetsPerTick)
  assert.equal(WITNESS_LIMITS.upgradeGetsPerTick, 6)
})

test('a calendar that names a host off the list is never fetched', async () => {
  const fx = await fixture({ relays: { default: OK } })
  // Swap the stored proof for one whose two pending leaves name hosts off the upgrade list.
  await fx.tick()
  const digest = (await fx.record(1)).digest
  const nonce = new Uint8Array(16).fill(1)
  const { buildDetached } = await import('../ots.mjs')
  const evil = buildDetached(unhex(digest), nonce, [calendarReply(unhex('01010101'), unhex('0202020202020202'), 'https://calendar.opentimestamps.org.evil.example'),
    calendarReply(unhex('03030303'), unhex('0404040404040404'), 'http://alice.btc.calendar.opentimestamps.org')])
  await fx.ws.storage.put('witness:ots:1', hex(evil))
  fx.clock.now = T0 + 2 * HOUR
  await fx.tick()
  assert.equal(gets(fx).length, 0)
  assert.deepEqual((await fx.record(1)).ots, { state: 'pending', height: null })
})

test('relays: ok, duplicate, each refused prefix and timeout are kept per relay; three attempts, then never again', async () => {
  const [damus, nos, primal, band, mom] = WITNESS_RELAYS
  const fx = await fixture({ relays: {
    [damus]: event => ['OK', event.id, true, 'duplicate: already have this event'],
    [nos]: event => ['OK', event.id, false, 'blocked: not on the list'],
    [primal]: () => null,
  } })
  await fx.tick()
  assert.deepEqual((await fx.record(1)).relays, { [damus]: 'duplicate', [nos]: 'refused:blocked', [primal]: 'timeout', [band]: 'timeout', [mom]: 'timeout' })
  const { ok, of } = (await fx.pub()).public.records[0].relays
  assert.deepEqual({ ok, of }, { ok: 1, of: 5 })
  // Retries go only to the relays not yet ok, and stop after the third attempt (publish sockets only; read-backs are REQs).
  const opened = () => fx.sockets.opened.filter(socket => JSON.parse(socket.sent[0] ?? '[]')[0] === 'EVENT').map(socket => socket.url)
  for (let index = 1; index <= 4; index++) { fx.clock.now = T0 + index * HOUR / 2; await fx.tick() }
  assert.equal(opened().filter(url => url === damus).length, 1)
  assert.equal(opened().filter(url => url === nos).length, 3)
  assert.equal(opened().filter(url => url === primal).length, 3)

  for (const prefix of ['pow', 'blocked', 'rate-limited', 'invalid', 'restricted', 'mute', 'error', 'auth-required']) {
    const one = await fixture({ relays: { default: event => ['OK', event.id, false, `${prefix}: no`] } })
    await one.tick()
    assert.deepEqual(Object.values((await one.record(1)).relays), Array(WITNESS_RELAYS.length).fill(`refused:${prefix}`))
  }
  for (const [rule, state] of [
    [event => ['OK', event.id, false, 'something new'], 'refused:other'],
    [event => ['OK', event.id, false, 'duplicate: seen'], 'duplicate'],
    // A challenge alone is not a demand: with no OK the relay simply times out.
    [() => ['AUTH', 'challenge-string'], 'timeout'],
    [event => ['OK', 'f'.repeat(64), true, ''], 'timeout'],
    [() => 'not json', 'timeout'],
    [() => JSON.stringify(['NOTICE', 'x'.repeat(WITNESS_LIMITS.relayFrameChars)]), 'timeout'],
  ]) {
    const one = await fixture({ relays: { default: rule } })
    await one.tick()
    assert.deepEqual(Object.values((await one.record(1)).relays), Array(WITNESS_RELAYS.length).fill(state), state)
  }
})

test('no identity: the record has no event, the stamp still runs; once a key exists the chain is signed from record 1 in order', async () => {
  const fx = await fixture({ identity: false, relays: { default: OK } })
  const first = await fx.tick()
  assert.ok(first.codes.includes('WITNESS_IDENTITY_REQUIRED'))
  assert.equal((await fx.record(1)).eventId, null)
  assert.equal(fx.sockets.opened.length, 0)
  fx.clock.now = T0 + 4 * HOUR
  await fx.tick()
  assert.equal((await fx.record(2)).eventId, null)
  assert.deepEqual((await fx.pub()).public.records.map(row => row.eventId), [null, null])
  await provisionMessagesIdentity(fx.hs.storage, { approved: true })
  fx.clock.now = T0 + 5 * HOUR
  const signed = await fx.tick()
  assert.equal(signed.signed, 2)
  const [one, two] = [await fx.record(1), await fx.record(2)]
  assert.deepEqual(two.event.tags[0], ['e', one.eventId])
  assert.equal(one.event.tags.length, 3)
})

test('review: a relay\'s unsolicited AUTH challenge is not a refusal; its OK true is kept as ok', async () => {
  const fx = await fixture({ relays: { greet: ['AUTH', 'challenge-xyz'], default: OK } })
  await fx.tick()
  assert.deepEqual((await fx.record(1)).relays, Object.fromEntries(WITNESS_RELAYS.map(url => [url, 'ok'])))
  const { ok, of } = (await fx.pub()).public.records[0].relays
  assert.deepEqual({ ok, of }, { ok: 5, of: 5 })
  // A demand is still a refusal: OK false with the auth-required prefix, after the challenge.
  const demand = await fixture({ relays: { greet: ['AUTH', 'challenge-xyz'], default: event => ['OK', event.id, false, 'auth-required: sign in'] } })
  await demand.tick()
  assert.deepEqual(Object.values((await demand.record(1)).relays), Array(WITNESS_RELAYS.length).fill('refused:auth-required'))
})

test('review: a reply the edge cannot run (RIPEMD-160, or a message past the bound) is not counted; the good ones still stamp', async () => {
  for (const rule of ['ripemd', 'long']) {
    const fx = await fixture({ calendars: { 'https://a.pool.opentimestamps.org': rule }, relays: { default: OK } })
    const result = await fx.tick()
    assert.equal(result.stamped, 1, rule)
    assert.equal(result.codes.includes('WITNESS_STAMP_FAILED'), false, rule)
    assert.deepEqual((await fx.record(1)).ots, { state: 'pending', height: null }, rule)
    const leaves = await pendingLeaves(await fx.proof(1))
    assert.deepEqual(leaves.map(leaf => leaf.uri), [PENDING_URI['https://b.pool.opentimestamps.org'], PENDING_URI['https://a.pool.eternitywall.com'], PENDING_URI['https://ots.btc.catallaxy.com']], rule)
  }
  // Only one runnable reply: failed, as before.
  const few = await fixture({ calendars: { default: 'ripemd', 'https://ots.btc.catallaxy.com': 'good' }, relays: { default: OK } })
  assert.ok((await few.tick()).codes.includes('WITNESS_STAMP_FAILED'))
  assert.deepEqual((await few.record(1)).ots, { state: 'failed', height: null })
})

test('review: a record left with ots state none (the object restarted mid-stamp) is stamped by a later tick, same nonce', async () => {
  const fx = await fixture({ relays: { default: OK } })
  await fx.tick()
  const body = posts(fx)[0].body
  const stored = await fx.ws.storage.get('witness:record:1')
  await fx.ws.storage.put('witness:record:1', { ...stored, ots: { state: 'none', height: null, attempts: 1, at: null } })
  await fx.ws.storage.delete('witness:ots:1')
  fx.net.length = 0
  fx.clock.now = T0 + HOUR / 2
  const retry = await fx.tick()
  assert.equal(retry.stamped, 1)
  assert.deepEqual(posts(fx).map(call => hex(call.body)), Array(4).fill(hex(body)))
  assert.deepEqual((await fx.record(1)).ots, { state: 'pending', height: null })
  assert.equal((await pendingLeaves(await fx.proof(1))).length, 4)
})

test('review: a key that arrives after more than the window of records still signs the chain from record 1, in order', async () => {
  const fx = await fixture({ identity: false, relays: { default: OK } })
  const total = WITNESS_LIMITS.window + 2
  for (let index = 0; index < total; index++) { fx.clock.now = T0 + index * 4 * HOUR; await fx.tick() }
  assert.equal((await fx.record(total)).ok, true)
  assert.equal((await fx.record(1)).eventId, null)
  await provisionMessagesIdentity(fx.hs.storage, { approved: true })
  fx.clock.now = T0 + total * 4 * HOUR - HOUR
  const first = await fx.tick()
  assert.ok(first.signed > 0, 'signing resumes')
  const one = await fx.record(1)
  assert.equal(await verifyNostrEvent(one.event), true)
  assert.deepEqual(one.event.tags, [['seq', '1'], ['digest', one.digest], ['chain', 'witness.v1']])
  assert.ok(fx.sockets.opened.some(socket => JSON.parse(socket.sent[0])[1].id === one.eventId), 'record 1 is published when signed')
  // Bounded catch-up: keep ticking (an hour apart) until the newest record has its event; every link names the one before.
  for (let index = 0; index < 60 && !(await fx.record(total)).eventId; index++) { fx.clock.now += HOUR / 4; await fx.tick() }
  let before = null
  for (let seq = 1; seq <= total; seq++) {
    const entry = await fx.record(seq)
    assert.ok(entry.eventId, `record ${seq} signed`)
    if (before) assert.deepEqual(entry.event.tags[0], ['e', before])
    before = entry.eventId
  }
})

test('the tick never throws: no bindings, a failing network, a socket that cannot open; it answers counts and closed codes', async () => {
  const broken = await fixture({ calendars: { default: 'throw' }, relays: { throws: true } })
  const answer = await broken.tick()
  assert.equal(answer.ok, true)
  assert.equal(answer.created, true)
  assert.ok(answer.codes.every(code => /^WITNESS_[A-Z_]+$/.test(code)))
  assert.deepEqual((await broken.record(1)).relays, Object.fromEntries(WITNESS_RELAYS.map(url => [url, 'timeout'])))

  const bare = new WitnessDO({ storage: memoryStorage().storage }, { WITNESS_SWITCH: 'on' }, { fetch: async () => { throw new Error('down') }, openSocket: () => { throw new Error('no') } })
  const response = await bare.fetch(new Request('https://x61.internal/_witness/tick', { method: 'POST', headers: { 'x-x6-internal-authorized': '1' } }))
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.ok, true)
  assert.ok(body.codes.includes('WITNESS_SIGN_UNAVAILABLE'))

  const storageDown = new WitnessDO({ storage: { get: async () => { throw new Error('io') }, put: async () => { throw new Error('io') } } }, { WITNESS_SWITCH: 'on' }, {})
  const down = await storageDown.fetch(new Request('https://x61.internal/_witness/tick', { method: 'POST', headers: { 'x-x6-internal-authorized': '1' } }))
  assert.equal(down.status, 200)
  assert.deepEqual(await down.json(), { ok: false, created: false, seq: null, upgraded: 0, confirmed: 0, stale: 0, stamped: 0, signed: 0, published: 0, codes: ['WITNESS_STORAGE_UNAVAILABLE'] })
})

test('the object answers only internal callers, and its read routes are exact', async () => {
  const fx = await fixture({ relays: { default: OK } })
  await fx.tick()
  const outside = await fx.object.fetch(new Request('https://x61.internal/_witness/tick', { method: 'POST' }))
  assert.equal(outside.status, 401)
  assert.equal((await fx.call('/_witness/tick')).status, 405)
  assert.equal((await fx.call('/_witness/record?seq=01')).status, 404)
  assert.equal((await fx.call('/_witness/record?seq=1&x=1')).status, 404)
  assert.equal((await fx.call('/_witness/ots?seq=2')).status, 404)
  assert.equal((await fx.call('/_witness/nope')).status, 404)
  const ots = await fx.call('/_witness/ots?seq=1')
  assert.equal(ots.headers.get('content-type'), 'application/octet-stream')
  // The public view carries no facts, no missing list and no nonce.
  const text = JSON.stringify(await fx.pub())
  for (const word of ['facts', 'missing', 'nonce', 'journals', 'receipts', 'ballId']) assert.equal(text.includes(word), false, word)
})

/** Every frame any relay socket carried for this event id. */
const framesFor = (fx, id) => fx.sockets.opened.filter(socket => socket.sent.some(data => JSON.parse(data)[1].id === id)).length

test('review (land): records signed before the window are all sent to the relays, none skipped when four are signed in one tick', async () => {
  const fx = await fixture({ identity: false, relays: { default: OK } })
  const total = WITNESS_LIMITS.window + 5
  for (let index = 0; index < total; index++) { fx.clock.now = T0 + index * 4 * HOUR; await fx.tick() }
  await provisionMessagesIdentity(fx.hs.storage, { approved: true })
  fx.clock.now = T0 + total * 4 * HOUR - HOUR
  // Hourly ticks until every record up to `total` has reached every relay (bounded).
  const done = async () => { for (let seq = 1; seq <= total; seq++) { const entry = await fx.record(seq); if (!entry.relays || Object.values(entry.relays).some(state => state !== 'ok')) return false } return true }
  for (let index = 0; index < 300 && !await done(); index++) { await fx.tick(); fx.clock.now += HOUR }
  for (let seq = 1; seq <= total; seq++) {
    const entry = await fx.record(seq)
    assert.ok(entry.eventId, `record ${seq} signed`)
    assert.deepEqual(Object.values(entry.relays), Array(WITNESS_RELAYS.length).fill('ok'), `record ${seq} reached every relay`)
    assert.equal(framesFor(fx, entry.eventId), WITNESS_RELAYS.length, `record ${seq} sent once to each relay`)
  }
})

test('review (land): a record signed before the window whose publish fails is retried like the others, three attempts, then never again', async () => {
  const mode = { answer: false }
  const fx = await fixture({ identity: false, relays: { default: event => mode.answer ? OK(event) : null } })
  const total = WITNESS_LIMITS.window + 2
  for (let index = 0; index < total; index++) { fx.clock.now = T0 + index * 4 * HOUR; await fx.tick() }
  await provisionMessagesIdentity(fx.hs.storage, { approved: true })
  fx.clock.now = T0 + total * 4 * HOUR - HOUR
  await fx.tick()
  const one = await fx.record(1), two = await fx.record(2)
  assert.ok(one.eventId && two.eventId, 'records 1 and 2 (before the window) are signed')
  assert.deepEqual(Object.values(one.relays), Array(WITNESS_RELAYS.length).fill('timeout'))
  // The relays stay silent: each record before the window gets exactly three attempts, however many ticks follow.
  for (let index = 0; index < 12; index++) { fx.clock.now += HOUR; await fx.tick() }
  for (const entry of [one, two]) assert.equal(framesFor(fx, entry.eventId), 3 * WITNESS_RELAYS.length, `record ${entry.seq}: three attempts`)
  // A record before the window whose first publish failed reaches the relays once they answer.
  const fresh = await fixture({ identity: false, relays: { default: event => mode.answer ? OK(event) : null } })
  mode.answer = false
  for (let index = 0; index < total; index++) { fresh.clock.now = T0 + index * 4 * HOUR; await fresh.tick() }
  await provisionMessagesIdentity(fresh.hs.storage, { approved: true })
  fresh.clock.now = T0 + total * 4 * HOUR - HOUR
  await fresh.tick()
  mode.answer = true
  fresh.clock.now += HOUR
  await fresh.tick()
  assert.deepEqual(Object.values((await fresh.record(1)).relays), Array(WITNESS_RELAYS.length).fill('ok'))
  assert.deepEqual(Object.values((await fresh.record(2)).relays), Array(WITNESS_RELAYS.length).fill('ok'))
})

test('review (land): an OK frame longer than the frame bound is read from its first 4,096 characters, not dropped', () => {
  const id = 'd'.repeat(64), long = 'x'.repeat(5000)
  assert.equal(relayState(JSON.stringify(['OK', id, true, long]), id), 'ok')
  assert.equal(relayState(JSON.stringify(['OK', id, false, 'duplicate: ' + long]), id), 'duplicate')
  assert.equal(relayState(JSON.stringify(['OK', id, false, 'blocked: ' + long]), id), 'refused:blocked')
  assert.equal(relayState(JSON.stringify(['OK', id, false, long]), id), 'refused:other')
  // Not an answer to this event: another id, another frame type, or a long frame that is not an OK at all.
  assert.equal(relayState(JSON.stringify(['OK', 'e'.repeat(64), true, long]), id), null)
  assert.equal(relayState(JSON.stringify(['NOTICE', long]), id), null)
  assert.equal(relayState(JSON.stringify(['OK', id, 'true', long]), id), null)
  assert.equal(relayState('x'.repeat(5000), id), null)
  // The short frames read as before.
  assert.equal(relayState(JSON.stringify(['OK', id, true, '']), id), 'ok')
  assert.equal(relayState(JSON.stringify(['OK', id, false, 'pow: difficulty 30']), id), 'refused:pow')
})

test('review (land): the witness object\'s storage lost while HEAD keeps its last signed seq: signing stalls, it never forks', async () => {
  const fx = await fixture({ relays: { default: OK } })
  await fx.tick()
  const signed = fx.hs.snapshot().get(WITNESS_SIGNER_KEY)
  assert.equal(signed.seq, 1)
  for (const key of ['witness:meta', 'witness:record:1', 'witness:ots:1']) await fx.ws.storage.delete(key)
  const framesBefore = fx.sockets.opened.length
  for (let index = 1; index <= 3; index++) {
    fx.clock.now = T0 + index * 4 * HOUR
    const answer = await fx.tick()
    assert.equal(answer.created, true)
    assert.ok(answer.codes.includes('WITNESS_SIGN_REFUSED'), JSON.stringify(answer))
  }
  for (let seq = 1; seq <= 3; seq++) assert.equal((await fx.record(seq)).eventId, null, `record ${seq} has no event`)
  assert.deepEqual(fx.hs.snapshot().get(WITNESS_SIGNER_KEY), signed, 'HEAD signed nothing new')
  assert.equal(fx.sockets.opened.length, framesBefore, 'nothing was sent')
  assert.deepEqual((await fx.pub()).public.records.map(row => row.eventId), [null, null, null])
})

// ---- A record at each promotion (HEAD's kick, the object's alarm, one promotion-triggered tick) ----

/** The object's alarm, run as Cloudflare runs it once the time comes. */
const fireAlarm = async fx => { fx.ws.alarm.at = null; return fx.object.alarm() }
const kick = fx => fx.call('/_witness/kick', { method: 'POST' })
const NEXT = { ballId: '7'.repeat(64), epoch: 81 }

test('a kick answers at once and sets the alarm about 15 s ahead (an earlier alarm is kept); it runs no tick', async () => {
  const fx = await fixture({ relays: { default: OK } })
  const response = await kick(fx)
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { ok: true, alarmAt: T0 + 15_000, kept: false })
  assert.equal(WITNESS_LIMITS.kickDelayMs, 15_000)
  assert.equal(fx.ws.alarm.at, T0 + 15_000)
  assert.deepEqual(fx.headCalls, [], 'no call back into HEAD inside the kick')
  assert.deepEqual(fx.net, [])
  assert.equal(fx.sockets.opened.length, 0)
  assert.equal(fx.ws.snapshot().size, 0, 'no record, no meta')
  // A second kick 5 s later keeps the earlier alarm.
  fx.clock.now = T0 + 5_000
  assert.deepEqual(await (await kick(fx)).json(), { ok: true, alarmAt: T0 + 15_000, kept: true })
  assert.deepEqual(fx.ws.alarm.sets, [T0 + 15_000])
  // Exact route: POST only, no query.
  assert.equal((await fx.call('/_witness/kick')).status, 405)
  assert.equal((await fx.call('/_witness/kick?x=1', { method: 'POST' })).status, 404)
  assert.equal((await fx.object.fetch(new Request('https://x61.internal/_witness/kick', { method: 'POST' }))).status, 401)
})

test('the alarm\'s tick makes record n+1 when the head changed, without waiting 4 hours, and none when it did not', async () => {
  const fx = await fixture({ relays: { default: OK } })
  assert.equal((await fx.tick()).seq, 1)
  // Same head, two minutes on: no record.
  fx.clock.now = T0 + 2 * 60_000
  await kick(fx)
  const same = await fireAlarm(fx)
  assert.equal(same.created, false)
  assert.equal((await fx.record(2)).ok, false)
  // A promotion moved the head: record 2 at once, chained, signed, its trigger kept beside it (not in the record).
  fx.selected.head = NEXT
  fx.clock.now = T0 + 3 * 60_000
  await kick(fx)
  const moved = await fireAlarm(fx)
  assert.equal(moved.created, true, JSON.stringify(moved))
  assert.equal(moved.seq, 2)
  const one = await fx.record(1), two = await fx.record(2)
  assert.deepEqual(two.record.facts.head, NEXT)
  assert.equal(two.record.prev, one.digest)
  assert.deepEqual(Object.keys(two.record).sort(), ['at', 'facts', 'missing', 'prev', 'seq', 'v'])
  assert.deepEqual(two.event.tags, [['e', one.eventId], ['seq', '2'], ['digest', two.digest], ['chain', 'witness.v1']])
  assert.equal(fx.ws.snapshot().get('witness:record:2').trigger, 'promotion')
  const rows = (await fx.pub()).public.records
  assert.deepEqual(rows.map(row => [row.seq, row.trigger]), [[2, 'promotion'], [1, 'schedule']])
  // The hourly schedule is unchanged: 2 h after record 2 nothing new; 3 h 59 min after it, a scheduled record.
  fx.clock.now = two.record.at + 2 * HOUR
  assert.equal((await fx.tick()).created, false)
  fx.clock.now = two.record.at + WITNESS_LIMITS.intervalMs
  assert.equal((await fx.tick()).created, true)
  assert.equal(fx.ws.snapshot().get('witness:record:3').trigger, 'schedule')
})

test('the 60 s floor since the newest record', async () => {
  const fx = await fixture({ relays: { default: OK } })
  await fx.tick()
  fx.selected.head = NEXT
  fx.clock.now = T0 + 59_999
  const callsBefore = fx.headCalls.length
  const early = await fireAlarm(fx)
  assert.equal(early.created, false)
  assert.ok(early.codes.includes('WITNESS_PROMOTION_TOO_SOON'))
  assert.equal(WITNESS_LIMITS.promotionFloorMs, 60_000)
  assert.equal(fx.headCalls.filter(path => path === '/_head/witness/facts').length,
    fx.headCalls.slice(0, callsBefore).filter(path => path === '/_head/witness/facts').length, 'the floor is checked before HEAD\'s facts are read')
  // Review: the refusal is a deferral, not a drop: the alarm is set for the floor's end, and that alarm makes the record.
  assert.equal(fx.ws.alarm.at, T0 + WITNESS_LIMITS.promotionFloorMs)
  fx.clock.now = fx.ws.alarm.at
  assert.equal((await fireAlarm(fx)).created, true)
})

test('review: the last head of a burst is recorded: a rollback inside the floor is deferred to the floor\'s end, not dropped', async () => {
  const fx = await fixture({ relays: { default: OK } })
  await fx.tick()
  // P1 at T0 + 45 s, recorded by its alarm at T0 + 60 s.
  fx.selected.head = NEXT
  fx.clock.now = T0 + 45_000
  await kick(fx)
  fx.clock.now = fx.ws.alarm.at
  assert.equal((await fireAlarm(fx)).seq, 2)
  // Rolled back at T0 + 80 s; its alarm at T0 + 95 s is inside the floor of record 2.
  fx.selected.head = HEAD
  fx.clock.now = T0 + 80_000
  await kick(fx)
  fx.clock.now = fx.ws.alarm.at
  const early = await fireAlarm(fx)
  assert.equal(early.created, false)
  assert.ok(early.codes.includes('WITNESS_PROMOTION_TOO_SOON'))
  assert.equal(fx.ws.alarm.at, T0 + 60_000 + WITNESS_LIMITS.promotionFloorMs, 'deferred to the floor\'s end')
  // A kick in the meantime sets its own, earlier alarm; that one is refused by the floor and deferred again.
  fx.clock.now = T0 + 100_000
  await kick(fx)
  assert.equal(fx.ws.alarm.at, T0 + 100_000 + WITNESS_LIMITS.kickDelayMs)
  fx.clock.now = fx.ws.alarm.at
  assert.equal((await fireAlarm(fx)).created, false, 'still inside the floor: deferred again')
  assert.equal(fx.ws.alarm.at, T0 + 60_000 + WITNESS_LIMITS.promotionFloorMs)
  fx.clock.now = fx.ws.alarm.at
  const late = await fireAlarm(fx)
  assert.equal(late.seq, 3)
  assert.deepEqual((await fx.record(3)).record.facts.head, HEAD, 'the newest record names the head that is live')
  assert.equal(fx.ws.alarm.at, null, 'nothing more is scheduled once the head is recorded')
})

test('at most 24 promotion-triggered records in any rolling 24 h; past the cap the hourly schedule carries on', async () => {
  const fx = await fixture({ relays: { default: OK } })
  await fx.tick()
  assert.equal(WITNESS_LIMITS.promotionsPerWindow, 24)
  assert.equal(WITNESS_LIMITS.promotionWindowMs, 24 * HOUR)
  for (let index = 1; index <= 24; index++) {
    fx.selected.head = { ballId: '7'.repeat(64), epoch: 80 + index }
    fx.clock.now = T0 + index * 2 * 60_000
    assert.equal((await fireAlarm(fx)).created, true, `promotion ${index}`)
  }
  fx.selected.head = { ballId: '7'.repeat(64), epoch: 200 }
  fx.clock.now = T0 + 25 * 2 * 60_000
  const capped = await fireAlarm(fx)
  assert.equal(capped.created, false)
  assert.ok(capped.codes.includes('WITNESS_PROMOTION_CAP'))
  // The schedule still makes its record 3 h 59 min after the newest.
  fx.clock.now = T0 + 24 * 2 * 60_000 + WITNESS_LIMITS.intervalMs
  const scheduled = await fx.tick()
  assert.equal(scheduled.created, true)
  assert.equal(scheduled.seq, 26)
  // 24 h after the first promotion record it rolls out of the window and one more promotion may be stamped.
  fx.selected.head = { ballId: '7'.repeat(64), epoch: 201 }
  fx.clock.now = T0 + 2 * 60_000 + 24 * HOUR
  assert.equal((await fireAlarm(fx)).created, true)
})

test('switch off, a kick does nothing (no storage, no alarm) and an alarm makes no call', async () => {
  const fx = await fixture({ relays: { default: OK } })
  fx.env.WITNESS_SWITCH = 'off'
  const response = await kick(fx)
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { ok: false, code: 'WITNESS_OFF' })
  assert.equal(fx.ws.alarm.at, null)
  assert.deepEqual(await fx.object.alarm(), { ok: false, code: 'WITNESS_OFF' })
  assert.deepEqual(fx.headCalls, [])
  assert.deepEqual(fx.net, [])
  assert.equal(fx.ws.snapshot().size, 0)
})

test('a scheduled tick and a promotion tick that overlap make one record; HEAD signs seq 1 once and the alarm is set again', async () => {
  const fx = await fixture({ relays: { default: OK } })
  const scheduled = fx.tick()
  const promoted = fx.object.alarm()
  const [first, second] = await Promise.all([scheduled, promoted])
  assert.equal(first.created, true)
  assert.equal(second.created, false)
  assert.ok(second.codes.includes('WITNESS_TICK_BUSY'))
  assert.equal((await fx.record(2)).ok, false)
  assert.equal(fx.hs.snapshot().get(WITNESS_SIGNER_KEY).seq, 1)
  assert.equal(fx.ws.alarm.at, T0 + WITNESS_LIMITS.kickDelayMs, 'the busy promotion tick tries again later')
  // Its later run finds the head unchanged and makes nothing.
  fx.clock.now = T0 + 2 * 60_000
  assert.equal((await fireAlarm(fx)).created, false)
  assert.equal(fx.hs.snapshot().get(WITNESS_SIGNER_KEY).seq, 1)
})

test('records made before this change (no trigger beside them) still verify, read as schedule, and the next record chains on', async () => {
  const { verifyWitnessChain } = await import('../witness.mjs')
  const fx = await fixture({ relays: { default: OK } })
  for (let index = 0; index < 4; index++) { fx.clock.now = T0 + index * 4 * HOUR; await fx.tick() }
  // As the live records are stored: no trigger field.
  for (let seq = 1; seq <= 4; seq++) {
    const { trigger: _gone, ...old } = await fx.ws.storage.get(`witness:record:${seq}`)
    await fx.ws.storage.put(`witness:record:${seq}`, old)
  }
  const before = []
  for (let seq = 1; seq <= 4; seq++) before.push(await fx.record(seq))
  fx.selected.head = NEXT
  fx.clock.now = T0 + 12 * HOUR + 2 * 60_000
  assert.equal((await fireAlarm(fx)).seq, 5)
  const after = []
  for (let seq = 1; seq <= 5; seq++) after.push(await fx.record(seq))
  for (let index = 0; index < 4; index++) assert.deepEqual(after[index].record, before[index].record)
  const checked = await verifyWitnessChain(after.map(entry => entry.record))
  assert.deepEqual(checked, { ok: true, seq: 5, digest: after[4].digest })
  assert.deepEqual((await fx.pub()).public.records.map(row => row.trigger), ['promotion', 'schedule', 'schedule', 'schedule', 'schedule'])
})

// ---- A true holder count (read-back of each published event, five relays) ----

/** The read-back sockets (their first frame is a REQ) and the publish sockets (EVENT). */
const reqSockets = fx => fx.sockets.opened.filter(socket => JSON.parse(socket.sent[0] ?? '[]')[0] === 'REQ')
/** A relay that holds exactly these events (by id) and answers a REQ with them, then EOSE. */
const holding = events => (url, sub, filter) => [...filter.ids.filter(id => events.has(id)).map(id => ['EVENT', sub, events.get(id)]), ['EOSE', sub]]

test('five relays: the three, then relay.nostr.band and nostr.mom', () => {
  assert.deepEqual(WITNESS_RELAYS, ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net', 'wss://relay.nostr.band', 'wss://nostr.mom'])
  assert.equal(WITNESS_LIMITS.readbackRecords, 4)
  assert.equal(WITNESS_LIMITS.readbackEveryMs, 6 * HOUR)
  assert.ok(WITNESS_LIMITS.readbackWaitMs <= WITNESS_LIMITS.relayWaitMs)
  assert.ok(WITNESS_LIMITS.readbackTotalMs <= WITNESS_LIMITS.readbackRecords * WITNESS_LIMITS.readbackWaitMs)
})

test('read-back true: one REQ by id per relay, the event checked, every socket closed; the public row\'s exact shape', async () => {
  const events = new Map()
  const fx = await fixture({ relays: { default: OK, read: holding(events) } })
  await fx.tick()
  const one = await fx.record(1)
  events.set(one.eventId, one.event)
  assert.equal(reqSockets(fx).length, 0, 'nothing is read back before it was published')
  fx.clock.now = T0 + HOUR
  await fx.tick()
  const reqs = reqSockets(fx)
  assert.deepEqual(reqs.map(socket => socket.url), WITNESS_RELAYS)
  for (const socket of reqs) {
    assert.deepEqual(JSON.parse(socket.sent[0]), ['REQ', one.eventId.slice(0, 16), { ids: [one.eventId] }])
    assert.equal(socket.sent.length, 1, 'one REQ, nothing else sent')
    assert.equal(socket.closed, true)
  }
  const row = (await fx.pub()).public.records[0]
  assert.deepEqual(row.relays, { ok: 5, of: 5, held: 5, heldCheckedAt: T0 + HOUR,
    rows: WITNESS_RELAYS.map(url => ({ relay: new URL(url).hostname, sent: 'ok', held: true })) })
  assert.deepEqual(row.relays.rows.map(r => r.relay), ['relay.damus.io', 'nos.lol', 'relay.primal.net', 'relay.nostr.band', 'nostr.mom'])
  // The read-back is kept beside the record; the hashed record is unchanged.
  assert.deepEqual((await fx.record(1)).record, one.record)
})

test('read-back false: EOSE with no event, a wrong id, a bad signature, a timeout, a CLOSED; ok keeps counting accepted publishes', async () => {
  const events = new Map()
  const [damus, nos, primal, band, mom] = WITNESS_RELAYS
  const reads = {}
  const fx = await fixture({ relays: { default: OK, read: (url, sub, filter) => reads[url]?.(sub, filter) ?? null } })
  await fx.tick()
  const one = await fx.record(1)
  events.set(one.eventId, one.event)
  const flip = text => (text[0] === '0' ? '1' : '0') + text.slice(1)
  reads[damus] = sub => [['EOSE', sub]] // holds nothing
  reads[nos] = sub => [['EVENT', sub, { ...one.event, content: 'x' }], ['EOSE', sub]] // its id no longer matches its bytes
  reads[primal] = sub => [['EVENT', sub, { ...one.event, sig: flip(one.event.sig) }], ['EOSE', sub]] // the signature does not verify
  reads[band] = () => null // silent: the wait runs out
  reads[mom] = sub => [['CLOSED', sub, 'blocked: no']]
  fx.clock.now = T0 + HOUR
  await fx.tick()
  const row = (await fx.pub()).public.records[0]
  assert.deepEqual(row.relays, { ok: 5, of: 5, held: 0, heldCheckedAt: T0 + HOUR,
    rows: WITNESS_RELAYS.map(url => ({ relay: new URL(url).hostname, sent: 'ok', held: false })) })
  for (const socket of reqSockets(fx)) assert.equal(socket.closed, true, socket.url)
  // An event that is right counts even after a wrong one on the same subscription.
  const mixedEvent = { value: null }
  const mixed = await fixture({ relays: { default: OK, read: (url, sub) => [['EVENT', sub, { ...mixedEvent.value, content: 'x' }], ['EVENT', sub, mixedEvent.value], ['EOSE', sub]] } })
  await mixed.tick()
  mixedEvent.value = (await mixed.record(1)).event
  mixed.clock.now = T0 + HOUR
  await mixed.tick()
  assert.equal((await mixed.pub()).public.records[0].relays.held, 5)
})

test('each relay is asked at most once per record per 6 h', async () => {
  const events = new Map()
  const fx = await fixture({ relays: { default: OK, read: holding(events) } })
  await fx.tick()
  const one = await fx.record(1)
  events.set(one.eventId, one.event)
  fx.clock.now = T0 + HOUR
  await fx.tick()
  assert.equal(reqSockets(fx).length, 5)
  for (const at of [2, 3, 4.5, 6.99]) { fx.clock.now = T0 + at * HOUR; await fx.tick() }
  // Ticks at 4.5 h made record 2 (published at once); only it is read back, record 1 is not asked again before 6 h.
  const ids = reqSockets(fx).map(socket => JSON.parse(socket.sent[0])[2].ids[0])
  assert.equal(ids.filter(id => id === one.eventId).length, 5)
  fx.clock.now = T0 + 7 * HOUR
  await fx.tick()
  assert.equal(reqSockets(fx).map(socket => JSON.parse(socket.sent[0])[2].ids[0]).filter(id => id === one.eventId).length, 10)
  assert.equal((await fx.pub()).public.records.at(-1).relays.heldCheckedAt, T0 + 7 * HOUR)
})

test('at most the 4 newest due records are read back in one tick', async () => {
  const fx = await fixture({ relays: { default: OK } })
  for (let index = 0; index < 6; index++) { fx.clock.now = T0 + index * 4 * HOUR; await fx.tick() }
  // Forget every read-back so that all six are due at once.
  for (let seq = 1; seq <= 6; seq++) {
    const { held: _h, heldCheckedAt: _c, ...entry } = await fx.ws.storage.get(`witness:record:${seq}`)
    await fx.ws.storage.put(`witness:record:${seq}`, entry)
  }
  const before = reqSockets(fx).length
  fx.clock.now = T0 + 21 * HOUR
  await fx.tick()
  const asked = reqSockets(fx).slice(before).map(socket => JSON.parse(socket.sent[0])[2].ids[0])
  assert.equal(asked.length, 4 * WITNESS_RELAYS.length)
  const newest = []
  for (let seq = 3; seq <= 6; seq++) newest.push((await fx.record(seq)).eventId)
  assert.deepEqual([...new Set(asked)].sort(), newest.sort())
  for (const socket of reqSockets(fx)) assert.equal(socket.closed, true)
  // Review: once the 4 newest were read back, a tick asks nothing, not the older due records behind them.
  const settled = reqSockets(fx).length
  fx.clock.now = T0 + 22 * HOUR
  await fx.tick()
  assert.equal(reqSockets(fx).length, settled, 'records 1 and 2 are past the 4 newest: never walked to')
})

test('review: a relay that floods its read-back is read at most readbackFrames frames, and a held event ends the wait at once', async () => {
  const frames = { emitted: 0, read: 0 }
  const events = { one: null }
  const flood = (sub, count, frame) => Array.from({ length: count }, () => {
    frames.emitted++
    // A frame whose data is counted when the handler reads it.
    return { get data() { frames.read++; return JSON.stringify(frame(sub)) } }
  })
  const fx = await fixture({ relays: { default: OK, read: (url, sub) => url === WITNESS_RELAYS[0]
    ? flood(sub, 2000, s => ['EVENT', s, events.one]) // the real event, replayed, never an EOSE
    : flood(sub, 2000, s => ['EVENT', s, { ...events.one, content: 'x' }]) } }) // a wrong event, replayed
  await fx.tick()
  events.one = (await fx.record(1)).event
  fx.clock.now = T0 + HOUR
  await fx.tick()
  const row = (await fx.pub()).public.records[0].relays
  assert.deepEqual(row.rows.map(r => r.held), [true, false, false, false, false])
  assert.equal(frames.emitted, 2000 * WITNESS_RELAYS.length)
  assert.ok(frames.read <= WITNESS_RELAYS.length * WITNESS_LIMITS.readbackFrames, `frames read ${frames.read}`)
  for (const socket of reqSockets(fx)) assert.equal(socket.closed, true)
})

test('review: the read-back runs after the new record, so a read-back can never keep a record from being made', async () => {
  const fx = await fixture({ relays: { default: OK, read: (url, sub) => [['EOSE', sub]] } })
  await fx.tick()
  const seen = []
  const open = fx.object.openSocket
  fx.object.openSocket = url => { seen.push(fx.ws.snapshot().has('witness:record:2')); return open(url) }
  fx.clock.now = T0 + WITNESS_LIMITS.intervalMs
  assert.equal((await fx.tick()).seq, 2)
  const opened = fx.sockets.opened.slice(-seen.length)
  const reqs = opened.map((socket, index) => [socket, seen[index]]).filter(([socket]) => JSON.parse(socket.sent[0] ?? '[]')[0] === 'REQ')
  assert.equal(reqs.length, WITNESS_RELAYS.length, 'record 1 is read back this tick')
  assert.ok(reqs.every(([, made]) => made), 'every read-back socket opened after record 2 was stored')
})

test('a record published to the three relays before this change goes to the two new relays by the retry pass, 3 tries each', async () => {
  const [damus, nos, primal, band, mom] = WITNESS_RELAYS
  const mode = { answer: false }
  const fx = await fixture({ relays: { default: OK, [band]: event => mode.answer ? OK(event) : null, [mom]: event => mode.answer ? OK(event) : null } })
  await fx.tick()
  // As a live record is stored: three relays, one that never answered, its three attempts used.
  const stored = await fx.ws.storage.get('witness:record:1')
  const { relayTries: _t, held: _h, heldCheckedAt: _c, ...legacy } = stored
  await fx.ws.storage.put('witness:record:1', { ...legacy, relays: { [damus]: 'ok', [nos]: 'ok', [primal]: 'timeout' }, publishAttempts: 3 })
  const sentTo = () => fx.sockets.opened.filter(socket => JSON.parse(socket.sent[0] ?? '[]')[0] === 'EVENT').map(socket => socket.url)
  const before = sentTo().length
  for (let index = 1; index <= 5; index++) { fx.clock.now = T0 + index * HOUR / 2; await fx.tick() }
  const after = sentTo().slice(before)
  assert.equal(after.filter(url => url === band).length, 3)
  assert.equal(after.filter(url => url === mom).length, 3)
  assert.equal(after.filter(url => [damus, nos, primal].includes(url)).length, 0, 'the three keep their used attempts')
  assert.deepEqual((await fx.record(1)).relays, { [damus]: 'ok', [nos]: 'ok', [primal]: 'timeout', [band]: 'timeout', [mom]: 'timeout' })
  // A fresh legacy record whose two new relays do answer: ok becomes 4 of 5.
  const fresh = await fixture({ relays: { default: OK } })
  await fresh.tick()
  const { relayTries: _x, ...older } = await fresh.ws.storage.get('witness:record:1')
  await fresh.ws.storage.put('witness:record:1', { ...older, relays: { [damus]: 'ok', [nos]: 'ok', [primal]: 'timeout' }, publishAttempts: 3 })
  fresh.clock.now = T0 + HOUR
  await fresh.tick()
  const { ok, of } = (await fresh.pub()).public.records[0].relays
  assert.deepEqual({ ok, of }, { ok: 4, of: 5 })
})
