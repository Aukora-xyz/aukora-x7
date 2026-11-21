/** Every NEW witness record commits to the newest COMPLETE nightly copy of her cloud (nightly-copy.mjs).
 * The version rule (v 1 frozen as it was, v 2 with the nightly fact, each invalid under the other), old chains and old
 * chains followed by new records, the bounded pointer read (never throws, never stalls a tick), HEAD signing a v 2 record
 * after a memory written for v 1 records, and the public surfaces pinned (they gain nothing). Expected digests and
 * hashes are recomputed here with node:crypto. Fakes only: no network, no live store. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { provisionMessagesIdentity, verifyNostrEvent } from '../messages-store.mjs'
import { OBJECT_NAMES, runNightlyCopy } from '../nightly-copy.mjs'
import { parseOts } from '../ots.mjs'
import { createIsolateShield, ISOLATE_SHIELD } from '../worker.mjs'
import {
  WITNESS_JOURNAL_PATHS, WITNESS_MISSING, WITNESS_MISSING_V2, WITNESS_NIGHTLY_MISSING, WITNESS_SIGNER_KEY, WITNESS_VERSION, WITNESS_VERSIONS, WITNESS_ZERO,
  buildWitnessRecord, handleWitnessHeadRoute, signWitnessEvent, validWitnessRecord, verifyWitnessChain, witnessDigest, witnessFactValid, witnessNightlySetValid,
} from '../witness.mjs'
import {
  WITNESS_CALENDARS, WITNESS_NIGHTLY_LIMITS, WITNESS_RELAYS, WitnessDO, createWitnessReadDoor, projectWitnessPublic, readNightlyFact, witnessOwnerRecord,
} from '../witness-do.mjs'

const sha256hex = text => createHash('sha256').update(text).digest('hex')
const canon = value => value === null || typeof value !== 'object' ? JSON.stringify(value)
  : Array.isArray(value) ? `[${value.map(canon).join(',')}]`
  : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canon(value[key])}`).join(',')}}`
const [VOICE, TIMELINE] = WITNESS_JOURNAL_PATHS
const HEAD = { ballId: 'a'.repeat(64), epoch: 80 }
const OLD_FACTS = { head: HEAD, receipts: { leafHash: 'b'.repeat(64), rows: 412 },
  journals: [{ path: VOICE, bytes: 1834, last: 'c'.repeat(64) }, { path: TIMELINE, bytes: 0, last: '' }] }
const NIGHTLY = { set: '2026-11-18T19-17-00Z', sha256: 'e'.repeat(64) }
const T0 = 1_794_830_400_000
const HOUR = 3_600_000
const NOW = Date.parse('2026-11-18T19:17:00Z')

// ---- the version rule (witness.mjs) ----

test('v 1 keeps its exact present shape; v 2 is the same with the nightly fact; each is invalid under the other', async () => {
  assert.equal(WITNESS_VERSION, 2)
  assert.deepEqual(WITNESS_VERSIONS, [1, 2])
  assert.deepEqual(WITNESS_NIGHTLY_MISSING, ['nightly-none', 'nightly-off', 'nightly-unavailable'])
  assert.deepEqual(WITNESS_MISSING_V2, { ...WITNESS_MISSING, nightly: ['nightly-none', 'nightly-off', 'nightly-unavailable'] })
  // A record of the live shape, written by hand exactly as the live chain holds them.
  const old = { v: 1, seq: 1, prev: WITNESS_ZERO, at: T0, facts: structuredClone(OLD_FACTS), missing: [] }
  assert.equal(validWitnessRecord(old), true)
  assert.deepEqual(buildWitnessRecord({ seq: 1, prev: WITNESS_ZERO, at: T0, facts: OLD_FACTS }), old, 'the builder still makes v 1 from three facts')
  const fresh = buildWitnessRecord({ seq: 2, prev: 'd'.repeat(64), at: T0 + 4 * HOUR, facts: { ...OLD_FACTS, nightly: NIGHTLY }, v: WITNESS_VERSION })
  assert.deepEqual(fresh, { v: 2, seq: 2, prev: 'd'.repeat(64), at: T0 + 4 * HOUR, facts: { ...OLD_FACTS, nightly: NIGHTLY }, missing: [] })
  assert.equal(validWitnessRecord(fresh), true)
  // The exact canonical bytes of a v 2 record, and its digest, recomputed here.
  assert.equal(canon(fresh), '{"at":1794844800000,"facts":{"head":{"ballId":"' + 'a'.repeat(64) + '","epoch":80},"journals":[{"bytes":1834,"last":"'
    + 'c'.repeat(64) + '","path":"/dsh/home/auma/voice/chain.v1.jsonl"},{"bytes":0,"last":"","path":"/dsh/home/auma/timeline/chain.v1.jsonl"}],'
    + '"nightly":{"set":"2026-11-18T19-17-00Z","sha256":"' + 'e'.repeat(64) + '"},'
    + '"receipts":{"leafHash":"' + 'b'.repeat(64) + '","rows":412}},"missing":[],"prev":"' + 'd'.repeat(64) + '","seq":2,"v":2}')
  assert.equal(await witnessDigest(fresh), sha256hex(canon(fresh)))
  assert.equal(await witnessDigest(old), sha256hex(canon(old)))
  // Both directions: the old shape under the new version, the new shape under the old one.
  assert.equal(validWitnessRecord({ ...old, v: 2 }), false, 'v 2 without the nightly fact')
  assert.equal(validWitnessRecord({ ...fresh, v: 1 }), false, 'v 1 with a nightly fact')
  assert.equal(validWitnessRecord({ ...old, facts: { ...old.facts, nightly: null }, missing: ['nightly-off'] }), false, 'v 1 with a null nightly fact')
  assert.equal(validWitnessRecord({ ...old, missing: ['nightly-none'] }), false, 'a nightly code on a v 1 record')
  for (const v of [0, 3, '2', 2.5, null]) assert.equal(validWitnessRecord({ ...fresh, v }), false, `v ${v}`)
  assert.throws(() => buildWitnessRecord({ seq: 1, prev: WITNESS_ZERO, at: T0, facts: OLD_FACTS, v: 2 }), { code: 'WITNESS_RECORD_INVALID' })
  assert.throws(() => buildWitnessRecord({ seq: 1, prev: WITNESS_ZERO, at: T0, facts: { ...OLD_FACTS, nightly: NIGHTLY }, v: 1 }), { code: 'WITNESS_RECORD_INVALID' })
  assert.throws(() => buildWitnessRecord({ seq: 1, prev: WITNESS_ZERO, at: T0, facts: OLD_FACTS, v: 3 }), { code: 'WITNESS_RECORD_INVALID' })
  assert.throws(() => buildWitnessRecord({ seq: 1, prev: WITNESS_ZERO, at: T0, facts: OLD_FACTS, reasons: { nightly: 'nightly-off' } }), { code: 'WITNESS_RECORD_INVALID' })
})

test('the nightly fact is null with one closed code, or exactly { set, sha256 }: a real UTC set name and 64 lower-case hex', () => {
  for (const reason of WITNESS_NIGHTLY_MISSING) {
    const record = buildWitnessRecord({ seq: 1, prev: WITNESS_ZERO, at: T0, facts: { ...OLD_FACTS, nightly: null }, reasons: { nightly: reason }, v: 2 })
    assert.deepEqual(record.missing, [reason])
    assert.equal(validWitnessRecord(record), true)
  }
  const plain = buildWitnessRecord({ seq: 1, prev: WITNESS_ZERO, at: T0, facts: { head: null, receipts: null, journals: null, nightly: null }, v: 2 })
  assert.deepEqual(plain.missing, ['head-unavailable', 'journals-unavailable', 'nightly-unavailable', 'receipts-unavailable'])
  const good = { seq: 1, prev: WITNESS_ZERO, at: T0, facts: { ...OLD_FACTS, nightly: NIGHTLY }, v: 2 }
  assert.throws(() => buildWitnessRecord({ ...good, facts: { ...good.facts, nightly: null }, reasons: { nightly: 'nightly-late' } }), { code: 'WITNESS_RECORD_INVALID' })
  assert.throws(() => buildWitnessRecord({ ...good, reasons: { nightly: 'nightly-none' } }), { code: 'WITNESS_RECORD_INVALID' }, 'a reason for a fact that is there')
  const bad = {
    'no sha256': { set: NIGHTLY.set },
    'no set': { sha256: NIGHTLY.sha256 },
    'an extra key': { ...NIGHTLY, finishedAt: '2026-11-18T19:20:00.000Z' },
    'upper-case hex': { ...NIGHTLY, sha256: 'E'.repeat(64) },
    '63 hex': { ...NIGHTLY, sha256: 'e'.repeat(63) },
    '65 hex': { ...NIGHTLY, sha256: 'e'.repeat(65) },
    'sha256 not a string': { ...NIGHTLY, sha256: 7 },
    'colons in the set': { ...NIGHTLY, set: '2026-11-18T19:17:00Z' },
    'milliseconds in the set': { ...NIGHTLY, set: '2026-11-18T19-17-00.000Z' },
    'a day that is not one': { ...NIGHTLY, set: '2026-02-30T19-17-00Z' },
    'an hour that is not one': { ...NIGHTLY, set: '2026-11-18T24-00-00Z' },
    'a path in the set': { ...NIGHTLY, set: '../2026-11-18T19-17-00Z' },
    'a set with words': { ...NIGHTLY, set: 'latest' },
    'an array': [NIGHTLY.set, NIGHTLY.sha256],
    'a string': NIGHTLY.sha256,
  }
  for (const [name, nightly] of Object.entries(bad)) {
    assert.equal(witnessFactValid('nightly', nightly), false, name)
    assert.throws(() => buildWitnessRecord({ ...good, facts: { ...good.facts, nightly } }), { code: 'WITNESS_RECORD_INVALID' }, name)
  }
  assert.equal(witnessFactValid('nightly', NIGHTLY), true)
  assert.equal(witnessFactValid('nightly', null), true)
  assert.equal(witnessNightlySetValid('2028-02-29T00-00-00Z'), true)
  assert.equal(witnessNightlySetValid('2026-02-29T00-00-00Z'), false)
})

test('an old chain verifies; an old chain followed by new records verifies; a changed nightly fact breaks the next link', async () => {
  const records = []
  let prev = WITNESS_ZERO
  for (let seq = 1; seq <= 5; seq++) {
    const facts = seq <= 3 ? OLD_FACTS : { ...OLD_FACTS, nightly: seq === 4 ? null : NIGHTLY }
    const record = buildWitnessRecord({ seq, prev, at: T0 + (seq - 1) * 4 * HOUR, facts, ...(seq === 4 ? { reasons: { nightly: 'nightly-none' } } : {}) })
    records.push(record)
    prev = sha256hex(canon(record))
  }
  assert.deepEqual(records.map(record => record.v), [1, 1, 1, 2, 2])
  assert.deepEqual(await verifyWitnessChain(records.slice(0, 3)), { ok: true, seq: 3, digest: sha256hex(canon(records[2])) })
  assert.deepEqual(await verifyWitnessChain(records), { ok: true, seq: 5, digest: prev })
  const changed = structuredClone(records)
  changed[3].facts.nightly = NIGHTLY
  changed[3].missing = []
  assert.equal(validWitnessRecord(changed[3]), true)
  assert.deepEqual(await verifyWitnessChain(changed), { ok: false, code: 'WITNESS_CHAIN_BROKEN', seq: 5 })
  // An old-shape record relabelled v 2 inside a chain is not a record.
  const relabelled = structuredClone(records)
  relabelled[2].v = 2
  assert.deepEqual(await verifyWitnessChain(relabelled), { ok: false, code: 'WITNESS_RECORD_INVALID', seq: 3 })
  // A v 1 record after a v 2 one (what a rollback to an older build makes) is valid: it commits to no copy.
  const back = buildWitnessRecord({ seq: 6, prev, at: T0 + 20 * HOUR, facts: OLD_FACTS })
  assert.deepEqual(await verifyWitnessChain([...records, back]), { ok: true, seq: 6, digest: sha256hex(canon(back)) })
})

// ---- the pointer read (witness-do.mjs readNightlyFact) over the nightly copy's own writer ----

function memoryBucket() {
  const values = new Map(), gets = []
  return {
    values, gets,
    async put(key, text, options = {}) {
      const existing = values.get(key), condition = options.onlyIf
      if (condition?.etagMatches && existing?.etag !== condition.etagMatches) return null
      if (condition?.etagDoesNotMatch === '*' && existing) return null
      const stored = { text, size: Buffer.byteLength(text), etag: String(values.size + 1) + ':' + key }
      values.set(key, stored)
      return { key, size: stored.size, etag: stored.etag }
    },
    async get(key) {
      gets.push(key)
      const stored = values.get(key)
      return stored ? { size: stored.size, etag: stored.etag, text: async () => stored.text } : null
    },
    async list({ prefix = '', limit = 1000 } = {}) {
      const keys = [...values.keys()].filter(key => key.startsWith(prefix)).sort().slice(0, limit)
      return { objects: keys.map(key => ({ key, size: values.get(key).size })), truncated: false }
    },
  }
}
/** A page shaped as the copier requires one: runNightlyCopy refuses a page without `redacted` and a safe-integer
 * `withheld`, so this stub carries both, as every real dumpPage page does. */
const pageOf = name => async () => ({ rows: [[`${name}:row`, 'value']], next: null, leftOut: [], redacted: [], withheld: 0, withheldHidden: 0, withheldConflict: 0, unreadable: [], bookmarkBefore: null, bookmarkAfter: null, alarm: null })
/** A bucket holding one complete set, written by the nightly copy's own runNightlyCopy. */
async function completeSet() {
  const bucket = memoryBucket()
  const manifest = await runNightlyCopy({ NIGHTLY_COPY: 'on' }, { now: NOW, bucket, objects: Object.fromEntries(OBJECT_NAMES.map(name => [name, pageOf(name)])) })
  assert.equal(manifest.complete, true)
  const text = bucket.values.get(`nightly/${manifest.set}/manifest.json`).text
  return { bucket, set: manifest.set, sha256: sha256hex(text) }
}

test('the pointer read answers the newest complete set: its name and the SHA-256 of its manifest bytes, as LATEST holds it', async () => {
  const { bucket, set, sha256 } = await completeSet()
  assert.equal(set, '2026-11-18T19-17-00Z')
  assert.equal(JSON.parse(bucket.values.get('nightly/LATEST.json').text).sha256, sha256)
  const read = await readNightlyFact({ NIGHTLY_COPY: 'on', ARCHIVE_BUCKET: bucket })
  assert.deepEqual(read, { nightly: { set, sha256 }, reason: null })
  assert.equal(witnessFactValid('nightly', read.nightly), true)
  assert.deepEqual(bucket.gets.slice(-2), ['nightly/LATEST.json', `nightly/${set}/manifest.json`], 'two objects read, no row page')
  assert.equal(WITNESS_NIGHTLY_LIMITS.timeoutMs, 5000)
})

test('off, no binding, no set yet, an incomplete set: null with its closed code; nothing read while off', async () => {
  const spy = memoryBucket()
  for (const value of [undefined, 'off', 'ON', true, 'on ']) {
    assert.deepEqual(await readNightlyFact({ NIGHTLY_COPY: value, ARCHIVE_BUCKET: spy }), { nightly: null, reason: 'nightly-off' }, String(value))
  }
  assert.deepEqual(spy.gets, [])
  assert.deepEqual(await readNightlyFact(undefined), { nightly: null, reason: 'nightly-off' })
  assert.deepEqual(await readNightlyFact({ NIGHTLY_COPY: 'on' }), { nightly: null, reason: 'nightly-unavailable' }, 'no R2 binding')
  assert.deepEqual(await readNightlyFact({ NIGHTLY_COPY: 'on', ARCHIVE_BUCKET: {} }), { nightly: null, reason: 'nightly-unavailable' })
  assert.deepEqual(await readNightlyFact({ NIGHTLY_COPY: 'on', ARCHIVE_BUCKET: memoryBucket() }), { nightly: null, reason: 'nightly-none' })
  // A set that did not complete never becomes LATEST, so the read finds none.
  const bucket = memoryBucket()
  const objects = Object.fromEntries(OBJECT_NAMES.map(name => [name, name === 'MIRROR' ? async () => { throw new Error('down') } : pageOf(name)]))
  const manifest = await runNightlyCopy({ NIGHTLY_COPY: 'on' }, { now: NOW, bucket, objects })
  assert.equal(manifest.complete, false)
  assert.deepEqual(await readNightlyFact({ NIGHTLY_COPY: 'on', ARCHIVE_BUCKET: bucket }), { nightly: null, reason: 'nightly-none' })
})

test('a pointer or manifest that does not check is nightly-unavailable, never a guess and never a throw', async () => {
  const unavailable = { nightly: null, reason: 'nightly-unavailable' }
  const read = bucket => readNightlyFact({ NIGHTLY_COPY: 'on', ARCHIVE_BUCKET: bucket })
  const edits = {
    'a changed manifest': (values, set) => { values.get(`nightly/${set}/manifest.json`).text += ' ' },
    'a missing manifest': (values, set) => { values.delete(`nightly/${set}/manifest.json`) },
    'a pointer set that is not a set name': values => { const p = JSON.parse(values.get('nightly/LATEST.json').text); values.get('nightly/LATEST.json').text = JSON.stringify({ ...p, set: 'latest' }) },
    'a pointer sha256 in upper case': values => { const p = JSON.parse(values.get('nightly/LATEST.json').text); values.get('nightly/LATEST.json').text = JSON.stringify({ ...p, sha256: p.sha256.toUpperCase() }) },
    'a pointer that is not JSON': values => { values.get('nightly/LATEST.json').text = '{' },
    'a pointer that is a list': values => { values.get('nightly/LATEST.json').text = '[]' },
    'a pointer over its bound': values => { values.get('nightly/LATEST.json').size = WITNESS_NIGHTLY_LIMITS.pointerBytes + 1 },
    'a manifest over its bound': (values, set) => { values.get(`nightly/${set}/manifest.json`).size = WITNESS_NIGHTLY_LIMITS.manifestBytes + 1 },
  }
  for (const [name, edit] of Object.entries(edits)) {
    const { bucket, set } = await completeSet()
    edit(bucket.values, set)
    assert.deepEqual(await read(bucket), unavailable, name)
  }
  // A manifest whose hash matches but which is not complete, or names another set (written by hand, hash recomputed).
  for (const [name, change] of Object.entries({ 'not complete': { complete: false }, 'another set': { set: '2026-11-17T19-17-00Z' } })) {
    const { bucket, set } = await completeSet()
    const text = JSON.stringify({ ...JSON.parse(bucket.values.get(`nightly/${set}/manifest.json`).text), ...change })
    bucket.values.get(`nightly/${set}/manifest.json`).text = text
    bucket.values.get('nightly/LATEST.json').text = JSON.stringify({ set, sha256: sha256hex(text), finishedAt: '2026-11-18T19:18:00.000Z' })
    assert.deepEqual(await read(bucket), unavailable, name)
  }
  // Reads that throw.
  assert.deepEqual(await read({ get: async () => { throw new Error('r2 down') } }), unavailable)
  assert.deepEqual(await read({ get: () => { throw new Error('sync throw') } }), unavailable)
  assert.deepEqual(await read({ get: async () => ({ size: 10, text: async () => { throw new Error('body cut') } }) }), unavailable)
})

test('a pointer read that never answers ends at its deadline as nightly-unavailable', async () => {
  const hanging = { get: () => new Promise(() => {}) }
  const started = Date.now()
  assert.deepEqual(await readNightlyFact({ NIGHTLY_COPY: 'on', ARCHIVE_BUCKET: hanging }, { timeoutMs: 40 }), { nightly: null, reason: 'nightly-unavailable' })
  assert.ok(Date.now() - started < 2000)
  // A manifest body that never arrives: the same.
  const { bucket, set } = await completeSet()
  const slow = { get: async key => key === `nightly/${set}/manifest.json` ? { size: 10, text: () => new Promise(() => {}) } : bucket.get(key) }
  assert.deepEqual(await readNightlyFact({ NIGHTLY_COPY: 'on', ARCHIVE_BUCKET: slow }, { timeoutMs: 40 }), { nightly: null, reason: 'nightly-unavailable' })
})

// ---- the witness object: new records, old records, HEAD's signing across the change, and the public surfaces ----

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
  storage.getAlarm = async () => null
  storage.setAlarm = async () => {}
  return { storage, snapshot: () => structuredClone(data) }
}

const cat = (...parts) => new Uint8Array(Buffer.concat(parts.map(part => Buffer.from(part))))
const varuint = value => { const out = []; do { let byte = value & 0x7f; value = Math.floor(value / 128); if (value) byte |= 0x80; out.push(byte) } while (value); return Uint8Array.from(out) }
const varbytes = bytes => cat(varuint(bytes.length), bytes)
const pendingAtt = uri => cat([0x00], Buffer.from('83dfe30d2ef90c8e', 'hex'), varbytes(varbytes(new TextEncoder().encode(uri))))

/** The witness object over memory storage, HEAD's real witness routes behind env.HEAD, a fake mirror, fake calendars and relays. */
async function fixture({ env: extra = {}, nightlyTimeoutMs } = {}) {
  const clock = { now: T0 }
  const hs = memoryStorage(), ws = memoryStorage()
  await provisionMessagesIdentity(hs.storage, { approved: true })
  const mirror = { idFromName: name => name, get: () => ({ fetch: async request => {
    if (new URL(request.url).pathname === '/_mirror/witness-journals') return Response.json({ ok: true, journals: OLD_FACTS.journals })
    return Response.json({ ok: true, seedId: '5'.repeat(64), scope: 'nostr-receipts-head', evidence: { status: 'complete', scope: 'nostr-receipts-head' },
      head: { ballId: request.headers.get('x-x6-aura-head'), epoch: Number(request.headers.get('x-x6-aura-epoch')) }, receiptsLeafHash: 'b'.repeat(64), receiptRows: 9, verifiedReceipts: 9 })
  } }) }
  const headBinding = { idFromName: name => name, get: () => ({ fetch: async request => handleWitnessHeadRoute(request, { url: new URL(request.url),
    bootstrap: { seedId: '5'.repeat(64) }, storage: hs.storage, env: { WITNESS_SWITCH: 'on', MIRROR: mirror }, now: () => clock.now, readSelectedHead: async () => ({ ...HEAD }) }) }) }
  const fetchFake = async (url, init = {}) => {
    const target = new URL(String(url))
    if (init.method === 'POST' && target.pathname === '/digest' && WITNESS_CALENDARS.includes(target.origin)) {
      const index = WITNESS_CALENDARS.indexOf(target.origin)
      return new Response(cat([0xf1], varbytes(Uint8Array.of(1, 2, 3, index)), [0xf0], varbytes(Uint8Array.of(9, 9, 9, 9, 9, 9, 9, index)),
        pendingAtt(`https://alice${index}.btc.calendar.opentimestamps.org`)), { status: 200 })
    }
    return new Response('unexpected', { status: 500 })
  }
  const openSocket = url => {
    const listeners = {}
    const emit = (type, value) => { for (const listener of listeners[type] ?? []) listener(value) }
    const socket = { url, addEventListener: (type, listener) => { (listeners[type] ??= []).push(listener) }, close() {},
      send(data) {
        const frame = JSON.parse(data)
        queueMicrotask(() => emit('message', { data: JSON.stringify(frame[0] === 'EVENT' ? ['OK', frame[1].id, true, ''] : ['EOSE', frame[1]]) }))
      } }
    queueMicrotask(() => emit('open', {}))
    return socket
  }
  let nonces = 0
  const env = { WITNESS_SWITCH: 'on', HEAD: headBinding, MIRROR: mirror, ...extra }
  const object = new WitnessDO({ storage: ws.storage }, env, { now: () => clock.now, fetch: fetchFake, openSocket,
    randomBytes: count => { nonces++; return new Uint8Array(count).fill(nonces) }, timers: { set: fn => setTimeout(fn, 1), clear: id => clearTimeout(id) },
    ...(nightlyTimeoutMs ? { nightlyTimeoutMs } : {}) })
  const read = (path, signal) => object.fetch(new Request('https://x61.internal' + path, { headers: { 'x-x6-internal-authorized': '1' }, signal }))
  const tick = async () => (await object.fetch(new Request('https://x61.internal/_witness/tick', { method: 'POST', headers: { 'x-x6-internal-authorized': '1' } }))).json()
  const record = async seq => (await read('/_witness/record?seq=' + seq)).json()
  return { clock, hs, ws, object, env, read, tick, record }
}

test('with a complete set, a new record is v 2 and commits to it; the digest covers it; HEAD signs it', async () => {
  const { bucket, set, sha256 } = await completeSet()
  const fx = await fixture({ env: { NIGHTLY_COPY: 'on', ARCHIVE_BUCKET: bucket } })
  const answer = await fx.tick()
  assert.equal(answer.created, true, JSON.stringify(answer))
  assert.deepEqual(answer.codes, [])
  const one = await fx.record(1)
  assert.deepEqual(one.record, { v: 2, seq: 1, prev: WITNESS_ZERO, at: T0, facts: { ...OLD_FACTS, receipts: { leafHash: 'b'.repeat(64), rows: 9 }, nightly: { set, sha256 } }, missing: [] })
  assert.equal(one.digest, sha256hex(canon(one.record)))
  assert.equal(await verifyNostrEvent(one.event), true)
  assert.deepEqual(one.event.tags, [['seq', '1'], ['digest', one.digest], ['chain', 'witness.v1']])
})

test('a pointer read that hangs never stalls the tick: the record is made with nightly-unavailable', async () => {
  const fx = await fixture({ env: { NIGHTLY_COPY: 'on', ARCHIVE_BUCKET: { get: () => new Promise(() => {}) } }, nightlyTimeoutMs: 50 })
  const started = Date.now()
  const answer = await fx.tick()
  assert.ok(Date.now() - started < 3000)
  assert.equal(answer.created, true)
  const one = await fx.record(1)
  assert.equal(one.record.v, 2)
  assert.equal(one.record.facts.nightly, null)
  assert.deepEqual(one.record.missing, ['nightly-unavailable'])
  assert.notEqual(one.eventId, null, 'a missing nightly fact never stops the signature')
  // A bucket that throws: the same, and the tick still answers ok.
  const broken = await fixture({ env: { NIGHTLY_COPY: 'on', ARCHIVE_BUCKET: { get: async () => { throw new Error('r2 down') } } } })
  assert.equal((await broken.tick()).ok, true)
  assert.deepEqual((await broken.record(1)).record.missing, ['nightly-unavailable'])
})

test('HEAD whose signer memory was written for v 1 records signs the next v 2 record; the whole chain verifies (no stall)', async () => {
  const { bucket, set, sha256 } = await completeSet()
  const fx = await fixture({ env: { NIGHTLY_COPY: 'on', ARCHIVE_BUCKET: bucket } })
  // Three records of the live shape, signed through HEAD's own sign path, stored as the live object stores them.
  let prev = WITNESS_ZERO, prevEventId = null, pubkey = null
  for (let seq = 1; seq <= 3; seq++) {
    const at = T0 + (seq - 1) * 4 * HOUR
    const record = buildWitnessRecord({ seq, prev, at, facts: OLD_FACTS })
    assert.equal(record.v, 1)
    const digest = await witnessDigest(record)
    const event = await signWitnessEvent({ storage: fx.hs.storage, input: { seq, digest, prevEventId }, now: () => at })
    await fx.ws.storage.put(`witness:record:${seq}`, { seq, digest, record, nonce: '0'.repeat(32), eventId: event.id, event, publishAttempts: 1,
      relays: Object.fromEntries(WITNESS_RELAYS.map(url => [url, 'ok'])), ots: { state: 'stale', height: null, attempts: 1, at } })
    prev = digest; prevEventId = event.id; pubkey = event.pubkey
  }
  await fx.ws.storage.put('witness:meta', { seq: 3, pubkey, signed: 3 })
  const memory = fx.hs.snapshot().get(WITNESS_SIGNER_KEY)
  assert.deepEqual(Object.keys(memory).sort(), ['digest', 'event', 'id', 'prevEventId', 'seq'], 'HEAD remembers no record shape, only seq, digest and ids')
  assert.equal(memory.seq, 3)
  fx.clock.now = T0 + 12 * HOUR
  const answer = await fx.tick()
  assert.equal(answer.created, true)
  assert.equal(answer.codes.includes('WITNESS_SIGN_REFUSED'), false, JSON.stringify(answer.codes))
  const four = await fx.record(4)
  assert.equal(four.record.v, 2)
  assert.deepEqual(four.record.facts.nightly, { set, sha256 })
  assert.equal(four.record.prev, prev)
  assert.deepEqual(four.event.tags, [['e', prevEventId], ['seq', '4'], ['digest', four.digest], ['chain', 'witness.v1']])
  assert.equal(fx.hs.snapshot().get(WITNESS_SIGNER_KEY).seq, 4)
  const chain = []
  for (let seq = 1; seq <= 4; seq++) chain.push((await fx.record(seq)).record)
  assert.deepEqual(chain.map(record => record.v), [1, 1, 1, 2])
  assert.deepEqual(await verifyWitnessChain(chain), { ok: true, seq: 4, digest: four.digest })
  // The next tick signs record 5 too.
  fx.clock.now = T0 + 16 * HOUR
  await fx.tick()
  assert.equal(fx.hs.snapshot().get(WITNESS_SIGNER_KEY).seq, 5)
})

const PUBLIC_ROW_KEYS = ['seq', 'at', 'digest', 'prev', 'eventId', 'trigger', 'relays', 'ots', 'tsa']
const door = () => createWitnessReadDoor({ now: () => 0, shield: createIsolateShield(ISOLATE_SHIELD.guest), subjectOf: () => 'n' })
const get = path => { const url = new URL('https://node.example.invalid' + path); return [new Request(url), url] }

test('GET /api/witness and /api/witness/ots keep their exact present shape; the fact shows only where the whole record is', async () => {
  const { bucket, set, sha256 } = await completeSet()
  const fx = await fixture({ env: { NIGHTLY_COPY: 'on', ARCHIVE_BUCKET: bucket } })
  await fx.tick()
  const one = await fx.record(1)
  assert.deepEqual(one.record.facts.nightly, { set, sha256 })
  // The object's public view and the door's answer: the same keys as before the nightly commitment, and no trace of the fact.
  const view = (await (await fx.read('/_witness/public')).json()).public
  assert.deepEqual(Object.keys(view), ['schema', 'pubkey', 'head', 'records'])
  assert.deepEqual(Object.keys(view.records[0]), PUBLIC_ROW_KEYS)
  assert.deepEqual(Object.keys(view.records[0].ots), ['state', 'height', 'header'])
  assert.deepEqual(projectWitnessPublic(view), view)
  const served = await door().serve(...get('/api/witness'), fx.read)
  assert.equal(served.status, 200)
  const text = await served.text(), body = JSON.parse(text)
  assert.deepEqual(Object.keys(body), ['schema', 'pubkey', 'head', 'records'])
  assert.deepEqual(Object.keys(body.records[0]), PUBLIC_ROW_KEYS)
  assert.deepEqual(Object.keys(body.records[0].relays), ['ok', 'of', 'held', 'heldCheckedAt', 'rows'])
  assert.deepEqual(body.head, { seq: 1, digest: one.digest, at: T0 })
  for (const word of ['nightly', set, sha256, 'facts', 'missing']) assert.equal(text.includes(word), false, word)
  // The proof download: the stored .ots bytes, for this digest, with the same headers as before.
  const proof = await door().serve(...get('/api/witness/ots?seq=1'), fx.read)
  assert.equal(proof.status, 200)
  assert.equal(proof.headers.get('content-type'), 'application/octet-stream')
  assert.equal(proof.headers.get('content-disposition'), 'attachment; filename="witness-1.ots"')
  const bytes = new Uint8Array(await proof.arrayBuffer())
  assert.equal(Buffer.from(parseOts(bytes).digest).toString('hex'), one.digest)
  assert.equal(Buffer.from(bytes).includes(Buffer.from(set)), false)
  // The outsider record read (off unless the Worker says exactly true) serves the whole v 2 record, digest recomputed.
  const off = await door().serve(...get('/api/witness/record?seq=1'), fx.read)
  assert.equal(off.status, 404)
  const on = await door().serve(...get('/api/witness/record?seq=1'), fx.read, { recordPublic: true })
  assert.equal(on.status, 200)
  const whole = await on.json()
  assert.deepEqual(Object.keys(whole), ['ok', 'seq', 'digest', 'record'])
  assert.deepEqual(whole.record.facts.nightly, { set, sha256 })
  assert.equal(sha256hex(canon(whole.record)), whole.digest)
  // The owner's read shows it too.
  const env = { WITNESS: { idFromName: name => name, get: () => fx.object } }
  const owner = await (await witnessOwnerRecord(env, new URL('https://node.example.invalid/_head/witness/record?seq=1'))).json()
  assert.equal(owner.ok, true)
  assert.deepEqual(owner.record, one.record)
})

test('a stored v 1 record is still served whole by the outsider read, its digest recomputed (the live chain stays readable)', async () => {
  const fx = await fixture()
  const record = buildWitnessRecord({ seq: 1, prev: WITNESS_ZERO, at: T0, facts: OLD_FACTS })
  const digest = await witnessDigest(record)
  await fx.ws.storage.put('witness:record:1', { seq: 1, digest, record, nonce: '0'.repeat(32), eventId: null, event: null, relays: null, publishAttempts: 0,
    ots: { state: 'stale', height: null, attempts: 1, at: T0 } })
  await fx.ws.storage.put('witness:meta', { seq: 1, pubkey: null })
  const on = await door().serve(...get('/api/witness/record?seq=1'), fx.read, { recordPublic: true })
  assert.equal(on.status, 200)
  assert.deepEqual(await on.json(), { ok: true, seq: 1, digest, record })
  // And a record whose stored digest does not recompute is refused, whatever its version.
  await fx.ws.storage.put('witness:record:2', { seq: 2, digest: 'f'.repeat(64), record: { ...record, seq: 2, prev: digest }, nonce: '0'.repeat(32), ots: { state: 'stale', height: null, attempts: 1, at: T0 } })
  assert.equal((await door().serve(...get('/api/witness/record?seq=2'), fx.read, { recordPublic: true })).status, 503)
})

test('docs (review): the record switch consent names the nightly fact; both READMEs give both versions; the doc names the two HEAD rows never copied', async () => {
  const { readFileSync } = await import('node:fs')
  const read = path => readFileSync(new URL(path, import.meta.url), 'utf8')
  const toml = read('../../wrangler.toml')
  const consent = toml.slice(toml.indexOf('# Promotion records: GET /api/witness/record'), toml.indexOf('WITNESS_RECORD_PUBLIC = '))
  for (const words of ['v 2 record', 'nightly set', 'manifest', 'SHA-256']) assert.ok(consent.includes(words), `wrangler.toml consent: ${words}`)
  for (const name of ['README.md', 'README.zh.md']) {
    const readme = read(`../../${name}`)
    assert.equal(readme.includes('facts: { head, receipts, journals }, missing }'), false, `${name} gives only the v 1 facts`)
    for (const words of ['`v` 1', '`v` 2', '{ head, receipts, journals }', '`nightly: { set, sha256 } | null`', '`nightly-none`', '`nightly-off`', '`nightly-unavailable`']) {
      assert.ok(readme.includes(words), `${name}: ${words}`)
    }
  }
  const doc = read('../../../../docs/auma/outside-witness.md')
  assert.equal(/every stored key of HEAD, the mirror/.test(doc), false, 'the doc must not say every HEAD key is copied')
  for (const words of ['`aumlok:signin:v1`', '`aumlok:devices:pending:v1`', 'never copied', 'key and size only']) assert.ok(doc.includes(words), `outside-witness.md: ${words}`)
  const { LEFT_OUT } = await import('../nightly-copy.mjs')
  for (const key of LEFT_OUT.HEAD) assert.ok(doc.includes(`\`${key}\``), `outside-witness.md names left-out HEAD key ${key}`)
})
