/** The Worker's signed-out witness door (createWitnessReadDoor, built like the Nostr door: a 60 s
 * in-isolate cache, the isolate shield on misses) and the hourly `scheduled` handler that never throws. The witness
 * object is a fake here; the real object behind the real Worker is in witness-stack.test.mjs. No network. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createIsolateShield, createWorker, ISOLATE_SHIELD } from '../worker.mjs'
import { WITNESS_PUBLIC_ROUTES, createWitnessReadDoor } from '../witness-do.mjs'

const HELLO = new Uint8Array(readFileSync(new URL('./fixtures/ots/hello-world.txt.ots', import.meta.url)))
const D = n => String(n).repeat(64).slice(0, 64)
const HOSTS = ['relay.damus.io', 'nos.lol', 'relay.primal.net', 'relay.nostr.band', 'nostr.mom']
/** Ok counts accepted publishes; held counts relays whose newest read-back returned the event. */
const RELAYS = { ok: 2, of: 5, held: 1, heldCheckedAt: 1_794_848_400_000,
  rows: [{ relay: HOSTS[0], sent: 'ok', held: true }, { relay: HOSTS[1], sent: 'duplicate', held: false }, { relay: HOSTS[2], sent: 'timeout', held: false },
    { relay: HOSTS[3], sent: 'refused:rate-limited', held: false }, { relay: HOSTS[4], sent: 'none', held: null }] }
const NEVER_ASKED = { ok: 0, of: 5, held: null, heldCheckedAt: null, rows: HOSTS.map(relay => ({ relay, sent: 'none', held: null })) }
const ROW = { seq: 2, at: 1_794_844_800_000, digest: D(2), prev: D(1), eventId: D(3), trigger: 'promotion', relays: RELAYS, ots: { state: 'pending', height: null, header: null }, tsa: { state: 'stored', authority: 'freetsa.org', at: 1_794_844_801_000 } }
/** A header checked against two explorers. */
const CHECKED = { checked: true, hash: D(4), time: 1_794_847_294, confirmations: 9, sources: ['mempool.space', 'blockstream.info'], at: 1_794_848_400_000 }
const PUBLIC = { schema: 'witness.v1', pubkey: D(9), head: { seq: 2, digest: D(2), at: 1_794_844_800_000 },
  records: [ROW, { seq: 1, at: 1_794_830_400_000, digest: D(1), prev: '0'.repeat(64), eventId: null, trigger: 'schedule', relays: NEVER_ASKED, ots: { state: 'confirmed', height: 925001, header: CHECKED }, tsa: null }] }

/** A fake witness object behind the door: what it answers for each internal path, and every path asked. */
function object(answers) {
  const asked = []
  const read = async (path, signal) => {
    asked.push(path)
    assert.ok(signal instanceof AbortSignal)
    const answer = typeof answers === 'function' ? answers(path) : answers[path]
    if (answer instanceof Error) throw answer
    if (answer instanceof Uint8Array) return new Response(answer, { status: 200, headers: { 'content-type': 'application/octet-stream' } })
    if (answer === undefined) return Response.json({ ok: false, code: 'WITNESS_OTS_NONE' }, { status: 404 })
    return Response.json(answer)
  }
  return { read, asked }
}
const get = (path, init = {}) => { const url = new URL('https://node.example.invalid' + path); return [new Request(url, init), url] }

test('the public door: exactly the public shape, never facts or the missing list, cached for 60 s', async () => {
  let at = 0
  // Whatever the object adds is not served: the door rebuilds the answer from the closed fields.
  const leaky = { ...PUBLIC, facts: { head: { ballId: D(4) } }, missing: ['x'], records: PUBLIC.records.map(row => ({ ...row, facts: {}, nonce: D(5), record: {} })) }
  const fake = object({ '/_witness/public': { ok: true, public: leaky } })
  const door = createWitnessReadDoor({ now: () => at, shield: createIsolateShield(ISOLATE_SHIELD.guest), subjectOf: () => 'one-network' })
  const response = await door.serve(...get('/api/witness'), fake.read)
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8')
  assert.equal(response.headers.get('cache-control'), 'public, max-age=60')
  assert.equal(response.headers.get('access-control-allow-origin'), '*')
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
  const body = await response.json()
  assert.deepEqual(body, PUBLIC)
  assert.deepEqual(Object.keys(body), ['schema', 'pubkey', 'head', 'records'])
  for (const word of ['facts', 'missing', 'nonce', 'record"', 'ballId']) assert.equal(JSON.stringify(body).includes(word), false, word)
  at = 59_999
  await door.serve(...get('/api/witness'), fake.read)
  assert.equal(fake.asked.length, 1, 'served from the cache')
  at = 60_000
  await door.serve(...get('/api/witness'), fake.read)
  assert.equal(fake.asked.length, 2)
  // Nothing made yet is an answer too: head null, no records.
  const empty = createWitnessReadDoor({ now: () => 0, shield: createIsolateShield(ISOLATE_SHIELD.guest), subjectOf: () => 'n' })
  const none = await empty.serve(...get('/api/witness'), object({ '/_witness/public': { ok: true, public: { schema: 'witness.v1', pubkey: null, head: null, records: [] } } }).read)
  assert.deepEqual(await none.json(), { schema: 'witness.v1', pubkey: null, head: null, records: [] })
})

test('a malformed or failed object answer is 503 WITNESS_UNAVAILABLE, not cached', async () => {
  for (const bad of [
    new Error('down'),
    { ok: false, code: 'WITNESS_UNAVAILABLE' },
    { ok: true, public: { ...PUBLIC, schema: 'witness.v2' } },
    { ok: true, public: { ...PUBLIC, records: [{ ...ROW, relays: { ...RELAYS, ok: 6 } }] } },
    // The read-back's shape is closed too.
    { ok: true, public: { ...PUBLIC, records: [{ ...ROW, relays: { ok: 2, of: 5 } }] } },
    { ok: true, public: { ...PUBLIC, records: [{ ...ROW, relays: { ...RELAYS, of: 3 } }] } },
    { ok: true, public: { ...PUBLIC, records: [{ ...ROW, relays: { ...RELAYS, ok: 3 } }] } },
    { ok: true, public: { ...PUBLIC, records: [{ ...ROW, relays: { ...RELAYS, held: 2 } }] } },
    { ok: true, public: { ...PUBLIC, records: [{ ...ROW, relays: { ...RELAYS, heldCheckedAt: null } }] } },
    { ok: true, public: { ...PUBLIC, records: [{ ...ROW, relays: { ...RELAYS, rows: RELAYS.rows.slice(1) } }] } },
    { ok: true, public: { ...PUBLIC, records: [{ ...ROW, relays: { ...RELAYS, rows: [{ ...RELAYS.rows[0], relay: 'wss://relay.damus.io' }, ...RELAYS.rows.slice(1)] } }] } },
    { ok: true, public: { ...PUBLIC, records: [{ ...ROW, relays: { ...RELAYS, rows: [{ ...RELAYS.rows[0], sent: 'maybe' }, ...RELAYS.rows.slice(1)] } }] } },
    { ok: true, public: { ...PUBLIC, records: [{ ...ROW, relays: { ...RELAYS, rows: [{ ...RELAYS.rows[0], held: 'yes' }, ...RELAYS.rows.slice(1)] } }] } },
    { ok: true, public: { ...PUBLIC, records: [{ ...ROW, ots: { state: 'maybe', height: null } }] } },
    // The trigger is one of two words; a row without it, or with another, is not served.
    { ok: true, public: { ...PUBLIC, records: [{ ...ROW, trigger: 'owner' }] } },
    { ok: true, public: { ...PUBLIC, records: [(({ trigger: _gone, ...row }) => row)(ROW)] } },
    { ok: true, public: { ...PUBLIC, records: Array(25).fill(ROW) } },
    { ok: true, public: { ...PUBLIC, pubkey: 'npub1x' } },
  ]) {
    const fake = object({ '/_witness/public': bad })
    const door = createWitnessReadDoor({ now: () => 0, shield: createIsolateShield(ISOLATE_SHIELD.guest), subjectOf: () => 'n' })
    const response = await door.serve(...get('/api/witness'), fake.read)
    assert.equal(response.status, 503, JSON.stringify(bad))
    assert.deepEqual(await response.json(), { ok: false, code: 'WITNESS_UNAVAILABLE' })
    assert.equal(response.headers.get('cache-control'), 'no-store')
    await door.serve(...get('/api/witness'), fake.read)
    assert.equal(fake.asked.length, 2, 'not cached')
  }
})

test('the door shields one network on cache misses and never refuses a cached answer', async () => {
  const fake = object({ '/_witness/public': { ok: true, public: PUBLIC } })
  const door = createWitnessReadDoor({ now: () => 0, cacheMs: 0, shield: createIsolateShield(ISOLATE_SHIELD.guest), subjectOf: () => 'one-network' })
  const statuses = []
  for (let index = 0; index <= ISOLATE_SHIELD.guest.limit; index++) statuses.push((await door.serve(...get('/api/witness'), fake.read)).status)
  assert.deepEqual(statuses, [...Array(ISOLATE_SHIELD.guest.limit).fill(200), 429])
  const cached = createWitnessReadDoor({ now: () => 0, shield: createIsolateShield({ ...ISOLATE_SHIELD.guest, limit: 1 }), subjectOf: () => 'one-network' })
  const other = object({ '/_witness/public': { ok: true, public: PUBLIC } })
  for (let index = 0; index < 5; index++) assert.equal((await cached.serve(...get('/api/witness'), other.read)).status, 200)
  assert.equal(other.asked.length, 1)
})

test('the proof door: the stored .ots bytes for ?seq=n, 404 when none, exact queries only, at most 16 KiB of a real proof', async () => {
  const fake = object({ '/_witness/ots?seq=1': HELLO, '/_witness/ots?seq=3': new Uint8Array(16 * 1024 + 1), '/_witness/ots?seq=4': new Uint8Array([1, 2, 3]) })
  const door = createWitnessReadDoor({ now: () => 0, shield: createIsolateShield(ISOLATE_SHIELD.guest), subjectOf: () => 'n' })
  const proof = await door.serve(...get('/api/witness/ots?seq=1'), fake.read)
  assert.equal(proof.status, 200)
  assert.equal(proof.headers.get('content-type'), 'application/octet-stream')
  assert.equal(proof.headers.get('content-disposition'), 'attachment; filename="witness-1.ots"')
  assert.equal(proof.headers.get('cache-control'), 'public, max-age=60')
  assert.deepEqual(new Uint8Array(await proof.arrayBuffer()), HELLO)
  const none = await door.serve(...get('/api/witness/ots?seq=2'), fake.read)
  assert.equal(none.status, 404)
  assert.deepEqual(await none.json(), { ok: false, code: 'WITNESS_OTS_NONE' })
  for (const seq of [3, 4]) assert.equal((await door.serve(...get(`/api/witness/ots?seq=${seq}`), fake.read)).status, 503)
  const asked = fake.asked.length
  for (const path of ['/api/witness/ots', '/api/witness/ots?seq=01', '/api/witness/ots?seq=', '/api/witness/ots?seq=1&x=1', '/api/witness/ots?x=1', '/api/witness?seq=1', '/api/witness/ots?seq=1#x']) {
    assert.equal((await door.serve(...get(path), fake.read)).status, 404, path)
  }
  assert.equal(fake.asked.length, asked, 'a refused query asks the object nothing')
  // Methods and bodies, as the Nostr door answers them.
  const post = await door.serve(...get('/api/witness', { method: 'POST', body: 'x' }), fake.read)
  assert.equal(post.status, 405)
  assert.equal(post.headers.get('allow'), 'GET')
  assert.deepEqual(WITNESS_PUBLIC_ROUTES, new Set(['/api/witness', '/api/witness/ots', '/api/witness/record', '/api/witness/tsa']))
})

test('scheduled: one tick through the witness object each hour; it never throws when the object or the network fails', async () => {
  const worker = createWorker({ verifyAccess: async () => null, networkFetch: () => assert.fail('no network') })
  const calls = []
  const binding = fetch => ({ idFromName: name => name, get: () => ({ fetch: request => { calls.push([request.method, new URL(request.url).pathname, request.headers.get('x-x6-internal-authorized')]); return fetch(request) } }) })
  const event = { cron: '17 * * * *', scheduledTime: Date.now() }
  const ctx = { waitUntil: () => {} }
  assert.equal(await worker.scheduled(event, { WITNESS_SWITCH: 'on', WITNESS: binding(async () => Response.json({ ok: true, created: true })) }, ctx), undefined)
  assert.deepEqual(calls, [['POST', '/_witness/tick', '1']])
  for (const env of [{ WITNESS_SWITCH: 'on' }, { WITNESS_SWITCH: 'on', WITNESS: binding(async () => { throw new Error('object down') }) }, { WITNESS_SWITCH: 'on', WITNESS: binding(async () => new Response('not json', { status: 500 })) },
    { WITNESS_SWITCH: 'on', WITNESS: { idFromName: () => { throw new Error('bad binding') } } }]) {
    assert.equal(await worker.scheduled(event, env, ctx), undefined)
  }
  const toml = readFileSync(new URL('../../wrangler.toml', import.meta.url), 'utf8')
  assert.match(toml, /^\[triggers\]\ncrons = \["17 \* \* \* \*"\]$/m)
})

// ---- One whole record for outsiders, built and OFF until WITNESS_RECORD_PUBLIC is exactly "on" ----

const sha256hex = text => createHash('sha256').update(text).digest('hex')
const canon = value => value === null || typeof value !== 'object' ? JSON.stringify(value)
  : Array.isArray(value) ? `[${value.map(canon).join(',')}]`
  : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canon(value[key])}`).join(',')}}`
const RECORD = { v: 1, seq: 2, prev: D(1), at: 1_794_844_800_000,
  facts: { head: { ballId: D(7), epoch: 81 }, receipts: { leafHash: D(8), rows: 9 },
    journals: [{ path: '/dsh/home/auma/voice/chain.v1.jsonl', bytes: 1834, last: D(6) }, { path: '/dsh/home/auma/timeline/chain.v1.jsonl', bytes: 0, last: '' }] },
  missing: [] }
const RECORD_DIGEST = sha256hex(canon(RECORD))
/** What the object's /_witness/record answers (the owner's read): far more than the outsider may see. */
const OWNER_ANSWER = { ok: true, seq: 2, digest: RECORD_DIGEST, record: RECORD, eventId: D(3), event: { id: D(3), sig: D(4) },
  relays: { 'wss://relay.damus.io': 'ok' }, ots: { state: 'pending', height: null }, nonce: D(5), trigger: 'promotion' }

test('the record read is OFF unless WITNESS_RECORD_PUBLIC is exactly "on": 404 WITNESS_RECORD_NOT_PUBLIC, no object call', async () => {
  for (const options of [undefined, {}, { recordPublic: false }, { recordPublic: 'on' }, { recordPublic: 1 }]) {
    const fake = object({ '/_witness/record?seq=2': OWNER_ANSWER })
    const door = createWitnessReadDoor({ now: () => 0, shield: createIsolateShield(ISOLATE_SHIELD.guest), subjectOf: () => 'n' })
    for (const path of ['/api/witness/record?seq=2', '/api/witness/record?seq=01', '/api/witness/record']) {
      const response = await door.serve(...get(path), fake.read, options)
      assert.equal(response.status, 404, `${JSON.stringify(options)} ${path}`)
      assert.deepEqual(await response.json(), { ok: false, code: 'WITNESS_RECORD_NOT_PUBLIC' })
      assert.equal(response.headers.get('cache-control'), 'no-store')
    }
    assert.deepEqual(fake.asked, [], 'off asks the object nothing')
  }
  assert.ok(WITNESS_PUBLIC_ROUTES.has('/api/witness/record'))
  // The Worker passes the switch from env: only exactly "on".
  const toml = readFileSync(new URL('../../wrangler.toml', import.meta.url), 'utf8')
  const vars = toml.slice(toml.indexOf('[vars]'), toml.indexOf('\n[', toml.indexOf('[vars]') + 1)).split('\n')
  const at = vars.findIndex(line => /^WITNESS_RECORD_PUBLIC\s*=/.test(line))
  assert.ok(at > 0, 'WITNESS_RECORD_PUBLIC is in [vars]')
  assert.equal(vars[at], 'WITNESS_RECORD_PUBLIC = "off"')
  assert.match(vars.slice(Math.max(0, at - 4), at).join('\n'), /owner has not yet said yes/, 'the comment says why it ships off')
})

test('on, it answers exactly { ok, seq, digest, record }; anyone recomputes the digest; nothing stored beside the record', async () => {
  let at = 0
  const fake = object({ '/_witness/record?seq=2': OWNER_ANSWER })
  const door = createWitnessReadDoor({ now: () => at, shield: createIsolateShield(ISOLATE_SHIELD.guest), subjectOf: () => 'n' })
  const response = await door.serve(...get('/api/witness/record?seq=2'), fake.read, { recordPublic: true })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'public, max-age=60')
  assert.equal(response.headers.get('access-control-allow-origin'), '*')
  const text = await response.text(), body = JSON.parse(text)
  assert.deepEqual(Object.keys(body), ['ok', 'seq', 'digest', 'record'])
  assert.deepEqual(body, { ok: true, seq: 2, digest: RECORD_DIGEST, record: RECORD })
  assert.equal(sha256hex(canon(body.record)), body.digest, 'the digest recomputed from the answer')
  for (const word of ['nonce', 'relays', 'eventId', '"event"', '"sig"', 'ots', 'trigger', 'wss://', D(5)]) assert.equal(text.includes(word), false, word)
  assert.deepEqual(fake.asked, ['/_witness/record?seq=2'])
  // Cached 60 s, like the other answers.
  at = 59_999
  await door.serve(...get('/api/witness/record?seq=2'), fake.read, { recordPublic: true })
  assert.equal(fake.asked.length, 1)
})

test('a seq that does not exist, a malformed query, and an object answer that does not check', async () => {
  const fake = object(path => path === '/_witness/record?seq=2' ? OWNER_ANSWER
    : path === '/_witness/record?seq=3' ? { ...OWNER_ANSWER, seq: 3 }
      : path === '/_witness/record?seq=4' ? { ...OWNER_ANSWER, seq: 4, record: { ...RECORD, seq: 4 } }
        : path === '/_witness/record?seq=5' ? { ...OWNER_ANSWER, seq: 5, record: { ...RECORD, seq: 5, note: 'x' } }
          : path === '/_witness/record?seq=7' ? { ok: false, code: 'WITNESS_RECORD_NONE', status: 404 } : undefined)
  const read = async (path, signal) => {
    if (path === '/_witness/record?seq=7' || path === '/_witness/record?seq=8') { fake.asked.push(path); return Response.json({ ok: false, code: 'WITNESS_RECORD_NONE' }, { status: 404 }) }
    return fake.read(path, signal)
  }
  const door = createWitnessReadDoor({ now: () => 0, shield: createIsolateShield(ISOLATE_SHIELD.guest), subjectOf: () => 'n' })
  const none = await door.serve(...get('/api/witness/record?seq=7'), read, { recordPublic: true })
  assert.equal(none.status, 404)
  assert.deepEqual(await none.json(), { ok: false, code: 'WITNESS_RECORD_NONE' })
  // The object's seq differs from the one asked; the record's seq differs; its digest does not recompute; an extra key.
  for (const seq of [3, 4, 5]) {
    const response = await door.serve(...get(`/api/witness/record?seq=${seq}`), read, { recordPublic: true })
    assert.equal(response.status, 503, String(seq))
    assert.deepEqual(await response.json(), { ok: false, code: 'WITNESS_UNAVAILABLE' })
  }
  const asked = fake.asked.length
  for (const path of ['/api/witness/record', '/api/witness/record?seq=0', '/api/witness/record?seq=01', '/api/witness/record?seq=', '/api/witness/record?seq=1&x=1',
    '/api/witness/record?x=1', '/api/witness/record?seq=1#x', '/api/witness/record?seq=99999999999999999']) {
    const response = await door.serve(...get(path), read, { recordPublic: true })
    assert.equal(response.status, 404, path)
    assert.deepEqual(await response.json(), { ok: false, code: 'NOT_FOUND' }, path)
  }
  assert.equal(fake.asked.length, asked, 'a refused query asks the object nothing')
  const post = await door.serve(...get('/api/witness/record?seq=2', { method: 'POST', body: 'x' }), read, { recordPublic: true })
  assert.equal(post.status, 405)
})

test('the public door serves the new relays row whole, and a full 24-row view past 16 KiB still fits its read bound', async () => {
  const leaky = { ...PUBLIC, records: PUBLIC.records.map(row => ({ ...row, relays: { ...row.relays, rows: row.relays.rows.map(r => ({ ...r, url: 'wss://' + r.relay })), extra: 1 } })) }
  const door = createWitnessReadDoor({ now: () => 0, shield: createIsolateShield(ISOLATE_SHIELD.guest), subjectOf: () => 'n' })
  const body = await (await door.serve(...get('/api/witness'), object({ '/_witness/public': { ok: true, public: leaky } }).read)).json()
  assert.deepEqual(body, PUBLIC)
  assert.equal(JSON.stringify(body).includes('wss://'), false, 'host names only')
  // The widest row the object can make: every count at its widest, every relay refused with the longest closed state.
  const wide = { seq: 9_007_199_254_740_991, at: 9_007_199_254_740_991, digest: D(1), prev: D(2), eventId: D(3), trigger: 'promotion',
    relays: { ok: 0, of: 5, held: 0, heldCheckedAt: 9_007_199_254_740_991, rows: HOSTS.map(relay => ({ relay, sent: 'refused:auth-required', held: false })) },
    ots: { state: 'confirmed', height: 9_007_199_254_740_991, header: { checked: true, hash: D(4), time: 4_294_967_295, confirmations: 9_007_199_254_740_991,
      sources: ['api.blockcypher.com', 'blockstream.info'], tried: Array(8).fill({ host: 'api.blockcypher.com', why: 'self-mismatch' }), at: 9_007_199_254_740_991 } },
    tsa: { state: 'failed', authority: 'freetsa.org', at: 9_007_199_254_740_991 } }
  const full = { schema: 'witness.v1', pubkey: D(9), head: { seq: 9_007_199_254_740_991, digest: D(1), at: 9_007_199_254_740_991 }, records: Array(24).fill(wide) }
  assert.ok(JSON.stringify({ ok: true, public: full }).length > 16 * 1024, 'the full view is past the old 16 KiB bound')
  // With eight tried rows on every header check it is past 32 KiB too.
  assert.ok(JSON.stringify({ ok: true, public: full }).length > 32 * 1024, 'the full view with tried rows is past 32 KiB')
  const served = await createWitnessReadDoor({ now: () => 0, shield: createIsolateShield(ISOLATE_SHIELD.guest), subjectOf: () => 'n' })
    .serve(...get('/api/witness'), object({ '/_witness/public': { ok: true, public: full } }).read)
  assert.equal(served.status, 200)
  assert.deepEqual(await served.json(), full)
})
