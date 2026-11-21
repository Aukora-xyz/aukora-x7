/** WITNESS LAND item 1: the witness lands switched off. Only `WITNESS_SWITCH` exactly "on" lets it run. While it is
 * anything else the Worker's `scheduled` handler makes no call at all, the witness object's tick answers WITNESS_OFF
 * before any storage read, fetch, socket or call to HEAD or the mirror, and HEAD's sign route answers the same code and
 * signs nothing. The read routes keep answering what is stored. No network: every binding, store and socket is a fake. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { provisionMessagesIdentity } from '../messages-store.mjs'
import { WITNESS_HEAD_ROUTES, WITNESS_SIGNER_KEY, handleWitnessHeadRoute, witnessSwitchOn } from '../witness.mjs'
import { WitnessDO } from '../witness-do.mjs'
import { createWorker } from '../worker.mjs'

const SEED = '5'.repeat(64)
/** The default (no value) and odd values: all of them are off. */
const OFF_VALUES = [undefined, null, '', 'off', 'On', 'ON', ' on', 'on ', '1', 'true', 'yes', true, 1]

/** A store that counts every touch (reads, writes, transactions) and holds nothing unless seeded. */
function countingStorage(seed = new Map()) {
  const touches = []
  let data = new Map(seed)
  const view = rows => ({
    get: async key => { touches.push(['get', key]); return Array.isArray(key) ? new Map(key.filter(name => rows.has(name)).map(name => [name, structuredClone(rows.get(name))])) : structuredClone(rows.get(key)) },
    put: async (key, value) => { touches.push(['put', key]); rows.set(key, structuredClone(value)) },
    delete: async key => { touches.push(['delete', key]); return rows.delete(key) },
  })
  const storage = { get: key => view(data).get(key), put: (key, value) => view(data).put(key, value), delete: key => view(data).delete(key),
    transaction: async operation => { touches.push(['transaction']); const rows = structuredClone(data); const value = await operation(view(rows)); data = rows; return value } }
  return { storage, touches, rows: () => data }
}

/** A binding whose every use is recorded; it answers 500 so a call that should never happen is also visible as a failure. */
function spyBinding(calls, name) {
  return { idFromName: id => { calls.push([name, 'idFromName', id]); return id }, get: id => { calls.push([name, 'get', id]); return { fetch: async request => { calls.push([name, 'fetch', new URL(request.url).pathname]); return Response.json({ ok: false }, { status: 500 }) } } } }
}

function offObject(switchValue) {
  const calls = []
  const store = countingStorage()
  const env = { HEAD: spyBinding(calls, 'HEAD'), MIRROR: spyBinding(calls, 'MIRROR') }
  if (switchValue !== undefined) env.WITNESS_SWITCH = switchValue
  const object = new WitnessDO({ storage: store.storage }, env, {
    now: () => 1_794_830_400_000,
    fetch: async url => { calls.push(['fetch', String(url)]); throw new Error('no network') },
    openSocket: url => { calls.push(['socket', String(url)]); throw new Error('no socket') },
    randomBytes: size => { calls.push(['random', size]); return new Uint8Array(size) },
  })
  const call = (path, init = {}) => object.fetch(new Request('https://x61.internal' + path, { ...init, headers: { 'x-x6-internal-authorized': '1', ...(init.headers ?? {}) } }))
  return { object, store, calls, call, env }
}

test('the switch: only exactly "on" is on', () => {
  assert.equal(witnessSwitchOn({ WITNESS_SWITCH: 'on' }), true)
  for (const value of OFF_VALUES) assert.equal(witnessSwitchOn(value === undefined ? {} : { WITNESS_SWITCH: value }), false, String(value))
  assert.equal(witnessSwitchOn(undefined), false)
  assert.equal(witnessSwitchOn(null), false)
})

test('wrangler.toml holds the witness switched on, with a comment line naming the other value', () => {
  const toml = readFileSync(new URL('../../wrangler.toml', import.meta.url), 'utf8')
  const vars = toml.slice(toml.indexOf('[vars]'), toml.indexOf('\n[', toml.indexOf('[vars]') + 1))
  const lines = vars.split('\n')
  const at = lines.findIndex(line => /^WITNESS_SWITCH\s*=/.test(line))
  assert.ok(at > 0, 'WITNESS_SWITCH is in [vars]')
  assert.equal(lines[at], 'WITNESS_SWITCH = "on"')
  assert.match(lines[at - 1], /^# .*"off"/, 'the comment line above names "off"')
  assert.equal(lines.filter(line => /^WITNESS_SWITCH\s*=/.test(line)).length, 1)
  assert.equal(/^WITNESS\s*=/m.test(vars), false, 'no var shadows the WITNESS object binding')
})

test('off: the tick answers WITNESS_OFF with no storage read, no fetch, no socket, no HEAD or mirror call', async () => {
  for (const value of OFF_VALUES) {
    const fx = offObject(value)
    const response = await fx.call('/_witness/tick', { method: 'POST' })
    assert.equal(response.status, 200, String(value))
    assert.deepEqual(await response.json(), { ok: false, code: 'WITNESS_OFF' }, String(value))
    assert.deepEqual(await fx.object.tick(), { ok: false, code: 'WITNESS_OFF' }, String(value))
    assert.deepEqual(fx.store.touches, [], String(value))
    assert.deepEqual(fx.calls, [], String(value))
    assert.equal(fx.store.rows().size, 0)
  }
})

test('off: the read routes still answer what is stored (nothing yet), and still touch no network', async () => {
  const fx = offObject('off')
  const view = await fx.call('/_witness/public')
  assert.equal(view.status, 200)
  const body = await view.json()
  assert.equal(body.ok, true)
  assert.equal(body.public.head, null)
  assert.deepEqual(body.public.records, [])
  const record = await fx.call('/_witness/record?seq=1')
  assert.equal(record.status, 404)
  assert.deepEqual(await record.json(), { ok: false, code: 'WITNESS_RECORD_NONE' })
  assert.deepEqual(fx.calls, [])
  assert.equal(fx.store.touches.some(([kind]) => kind !== 'get'), false, 'reads only')
})

test('off: HEAD\'s sign route answers WITNESS_OFF and signs nothing, even with her node key present and a valid request', async () => {
  for (const value of OFF_VALUES) {
    const store = countingStorage()
    await provisionMessagesIdentity(store.storage, { approved: true })
    const before = structuredClone(store.rows())
    store.touches.length = 0
    const calls = []
    const env = { MIRROR: spyBinding(calls, 'MIRROR') }
    if (value !== undefined) env.WITNESS_SWITCH = value
    const path = WITNESS_HEAD_ROUTES.sign
    const response = await handleWitnessHeadRoute(new Request('https://x61.internal' + path, { method: 'POST', headers: { 'x-x6-internal-authorized': '1', 'content-type': 'application/json' },
      body: JSON.stringify({ seq: 1, digest: 'd'.repeat(64), prevEventId: null }) }), { url: new URL('https://x61.internal' + path), bootstrap: { seedId: SEED }, storage: store.storage, env,
      now: () => 1_794_830_400_000, readSelectedHead: async () => null })
    assert.equal(response.status, 503, String(value))
    assert.deepEqual(await response.json(), { ok: false, code: 'WITNESS_OFF' }, String(value))
    assert.deepEqual(store.touches, [], String(value))
    assert.deepEqual(store.rows(), before)
    assert.equal(store.rows().has(WITNESS_SIGNER_KEY), false)
    assert.deepEqual(calls, [])
  }
})

test('on: the same valid sign request is signed (the switch is the only difference)', async () => {
  const store = countingStorage()
  await provisionMessagesIdentity(store.storage, { approved: true })
  const path = WITNESS_HEAD_ROUTES.sign
  const response = await handleWitnessHeadRoute(new Request('https://x61.internal' + path, { method: 'POST', headers: { 'x-x6-internal-authorized': '1', 'content-type': 'application/json' },
    body: JSON.stringify({ seq: 1, digest: 'd'.repeat(64), prevEventId: null }) }), { url: new URL('https://x61.internal' + path), bootstrap: { seedId: SEED }, storage: store.storage,
    env: { WITNESS_SWITCH: 'on' }, now: () => 1_794_830_400_000, readSelectedHead: async () => null })
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.ok, true)
  assert.equal(body.event.kind, 4871)
  assert.equal(store.rows().get(WITNESS_SIGNER_KEY).seq, 1)
})

test('off: the Worker\'s scheduled handler makes no call at all and returns', async () => {
  const worker = createWorker({ verifyAccess: async () => null, networkFetch: () => assert.fail('no network') })
  const event = { cron: '17 * * * *', scheduledTime: Date.now() }
  for (const value of OFF_VALUES) {
    const calls = []
    const env = { WITNESS: spyBinding(calls, 'WITNESS'), HEAD: spyBinding(calls, 'HEAD'), MIRROR: spyBinding(calls, 'MIRROR') }
    if (value !== undefined) env.WITNESS_SWITCH = value
    assert.equal(await worker.scheduled(event, env, { waitUntil: () => assert.fail('nothing waited on') }), undefined, String(value))
    assert.deepEqual(calls, [], String(value))
  }
  // On: exactly one tick through the witness object.
  const calls = []
  assert.equal(await worker.scheduled(event, { WITNESS_SWITCH: 'on', WITNESS: spyBinding(calls, 'WITNESS') }, { waitUntil: () => {} }), undefined)
  assert.deepEqual(calls.filter(([, kind]) => kind === 'fetch'), [['WITNESS', 'fetch', '/_witness/tick']])
})

test('docs: the witness doc opens with the switch and what turning it on sends; both READMEs name the switch', () => {
  const doc = readFileSync(new URL('../../../../docs/auma/outside-witness.md', import.meta.url), 'utf8')
  const sections = doc.split(/^## /m)
  assert.match(sections[1], /^The switch\n/, 'the first section is the switch')
  const first = sections[1]
  for (const words of ['WITNESS_SWITCH = "on"', '"off"', '32-byte', 'signed', 'CF-Worker', 'cannot remove', '/.well-known/nostr.json']) assert.ok(first.includes(words), words)
  for (const name of ['README.md', 'README.zh.md']) {
    const readme = readFileSync(new URL(`../../${name}`, import.meta.url), 'utf8')
    assert.equal(readme.split('\n').filter(line => line.includes('WITNESS_SWITCH')).length, 1, name)
  }
})

test('docs (review of the landing branch): the witness doc names the stalled-signing state and how it is recovered', () => {
  const doc = readFileSync(new URL('../../../../docs/auma/outside-witness.md', import.meta.url), 'utf8')
  const section = doc.split(/^## /m).find(part => part.startsWith('Known state: signing stalled\n'))
  assert.ok(section, 'a "Known state: signing stalled" section')
  for (const words of ['witness:signer:last', 'WITNESS_SIGN_REFUSED', '"eventId": null', 'never forks', 'code change', 'scheduled']) assert.ok(section.includes(words), words)
})

test('docs: the witness doc names the kick and alarm, the floors and caps, trigger, the record route and its switch, ok against held, five relays, and what is not checked', () => {
  const doc = readFileSync(new URL('../../../../docs/auma/outside-witness.md', import.meta.url), 'utf8')
  for (const words of ['POST /_witness/kick', 'about 15 s ahead', 'at least 60 s', 'at most 24 promotion-triggered', '`trigger: "schedule" | "promotion"`',
    'GET /api/witness/record?seq=n', 'WITNESS_RECORD_PUBLIC', 'ships `"off"`', 'WITNESS_RECORD_NOT_PUBLIC', 'newest-line digests', 'No words',
    '`relays.ok` against `relays.held`', 'wss://relay.nostr.band', 'wss://nostr.mom', 'block headers', 'second timestamp authority', 'the only one for its time']) assert.ok(doc.includes(words), words)
  assert.equal(doc.includes('three Nostr relays'), false)
  assert.equal(doc.includes('the public series shows nothing about when she was active'), false, 'promotion records show when her head moved')
})

test('docs: the header check and the RFC 3161 token, every limit, the public row\'s shape, and what is still not checked', () => {
  const doc = readFileSync(new URL('../../../../docs/auma/outside-witness.md', import.meta.url), 'utf8')
  for (const words of ['mempool.space', 'blockstream.info', 'api.blockcypher.com', '/api/block-height/', '/api/block/<hash>/header', '/api/blocks/tip/height', '/v1/btc/main/blocks/',
    'at least 72 leading zero bits', '6 confirmations', 'at most 2 records', 'once every 6 h', 'at most 8 times', '8 s', '4 KiB', 'header-check/1',
    'HEADER_SOURCE_UNAVAILABLE', 'HEADER_SOURCES_DISAGREE', 'HEADER_HASH_MISMATCH', 'HEADER_WORK_TOO_LOW', 'HEADER_MERKLE_MISMATCH', 'HEADER_TOO_FEW_CONFIRMATIONS',
    '"ots": { "state": "confirmed", "height": 900000, "header":', '"tsa": { "state": "stored", "authority": "freetsa.org"',
    'https://freetsa.org/tsr', 'WITNESS_TSA', 'GET /api/witness/tsa?seq=n', '16 KiB', 'at most 3 tries',
    'does not check the token\'s signature or its certificate chain', 'volunteer-run', 'best effort', 'from the day the token was made',
    'openssl ts -reply -in', 'openssl ts -verify -digest', '-CAfile cacert.pem -untrusted tsa.crt',
    'Still not checked', 'the only one for its time', 'beyond `held`']) assert.ok(doc.includes(words), words)
  const still = doc.split(/^## /m).find(part => part.startsWith('Not built, and not checked\n'))
  assert.ok(still.includes('signature'), 'the token\'s signature is listed as not checked')
  assert.equal(/tsa[^\n]*\bverified\b/i.test(doc.replace(/never "verified"|not "verified"/g, '')), false, 'the token is never called verified')
})

test('docs: the pool and its order, the tried rows and their closed words, the retry rule, what happened on 2026-11-17, the limits', () => {
  const doc = readFileSync(new URL('../../../../docs/auma/outside-witness.md', import.meta.url), 'utf8')
  for (const words of ['`mempool.space`, `btcscan.org`, `mempool.emzy.de`, `api.blockchain.info`, `api.blockcypher.com`, `api.bitaps.com`, `blockstream.info`',
    '/haskoin-store/btc/block/height/<height>?notx=true', '/btc/v1/blockchain/block/<height>', 'two at a time', '`self-mismatch`', 'last',
    '"tried": [ { "host": "mempool.space", "why": "http-429" }', '`ok`', '`http-<3 digits>`', '`timeout`', '`redirect`', '`too-large`', '`shape`', '`error`',
    'at most 8 rows', 'next hourly tick', 'first 3 tries', 'then every 6 h', 'tried once more', 'one deadline', '30 s', '2 KiB',
    '2026-11-17', 'every header check failed', '48 KiB', 'lower of the tips of up to two Esplora sources']) assert.ok(doc.includes(words), words)
  assert.equal(doc.includes('Only when one of the two fails, a third'), false, 'the old two-plus-one wording is gone')
  assert.equal(doc.includes('32 KiB bound'), false)
})
