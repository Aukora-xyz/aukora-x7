/** WIT2B A: the witness object checks each confirmed proof against the Bitcoin block header itself, from two explorers run
 * by unrelated operators (a third only when one of them fails). The stored proofs are the two live confirmed proofs, byte
 * for byte (fixtures/ots/witness-seq*.confirmed.ots); the explorers are fakes. No network.
 *
 * Real 2026 headers for those heights are not in this repo (the saved check kept only hash and merkle root), and a header
 * with 72 leading zero bits cannot be made in a test. So the header a fake explorer answers is BUILT here around the
 * proof's real merkle root and ground to an easy target; the object under test is given a lower floor (8 bits) through
 * its tests-only option, and one test shows the shipped 72-bit floor refuses that same header. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { bitcoinAttestations } from '../ots.mjs'
import { headerHash, leadingZeroBits, meetsOwnTarget, rebuildHeader } from '../bitcoin-header.mjs'
import { WITNESS_HEADER_CODES, WITNESS_HEADER_HOSTS, WITNESS_HEADER_SOURCES, WITNESS_HEADER_WHY, WITNESS_LIMITS, WitnessDO, headerUrlAllowed, projectWitnessPublic } from '../witness-do.mjs'

const HOUR = 3_600_000
const T0 = 1_794_830_400_000
const hex = bytes => Buffer.from(bytes).toString('hex')
const rev = text => Buffer.from(text, 'hex').reverse().toString('hex')
const PROOF = seq => new Uint8Array(readFileSync(new URL(`./fixtures/ots/witness-seq${seq}.confirmed.ots`, import.meta.url)))
const FLOOR = 8

function memoryStorage() {
  const data = new Map()
  const storage = {
    get: async key => Array.isArray(key) ? new Map(key.filter(name => data.has(name)).map(name => [name, structuredClone(data.get(name))])) : structuredClone(data.get(key)),
    put: async (key, value) => { data.set(key, structuredClone(value)) },
    delete: async key => data.delete(key),
    getAlarm: async () => null, setAlarm: async () => {},
  }
  return { storage, data }
}

/** A header around `merkleRoot` (display order), ground until it meets its own easy target and the test floor. */
async function ground(merkleRoot, { salt = 0, bits = 0x207fffff, time = 1_794_847_294 } = {}) {
  for (let nonce = salt * 100_000; ; nonce++) {
    const header = rebuildHeader({ version: 0x20000000, prevHash: 'ab'.repeat(32), merkleRoot, time, bits, nonce })
    if (await meetsOwnTarget(header) && leadingZeroBits(await headerHash(header)) >= FLOOR) return { header, hash: await headerHash(header) }
  }
}
/** The real proof's commitment for a seq: its height and the merkle root it names, in display order. */
async function commitment(seq) {
  const [attestation] = await bitcoinAttestations(PROOF(seq))
  return { height: attestation.height, merkleRoot: rev(attestation.merkleRoot) }
}

/**
 * Explorers by host: `{ blocks: { [height]: { hash, header } }, tip }`, 'down' (every call 503), or a function
 * (url) -> Response. api.blockcypher.com, api.blockchain.info and api.bitaps.com answer `{ blocks: { [height]: json } }`
 * (WIT2C B: the haskoin and bitaps reply shapes are built by haskoinReply and bitapsReply below).
 */
function explorers(hosts) {
  const calls = []
  const fetch = async (url, init = {}) => {
    const call = { url: String(url), method: init.method ?? 'GET', headers: Object.fromEntries(new Headers(init.headers)), body: init.body ?? null, redirect: init.redirect, signal: init.signal }
    calls.push(call)
    const target = new URL(call.url), rule = hosts[target.hostname]
    if (rule === undefined) return new Response('no', { status: 500 })
    if (rule === 'down') return new Response('busy', { status: 503 })
    if (typeof rule === 'function') return rule(call.url)
    const json = { 'api.blockcypher.com': /^\/v1\/btc\/main\/blocks\/(\d+)$/, 'api.blockchain.info': /^\/haskoin-store\/btc\/block\/height\/(\d+)$/,
      'api.bitaps.com': /^\/btc\/v1\/blockchain\/block\/(\d+)$/ }[target.hostname]
    if (json) {
      const match = json.exec(target.pathname)
      const block = match && rule.blocks?.[match[1]]
      return block ? Response.json(block) : new Response('no', { status: 404 })
    }
    const path = target.pathname.replace(/^\/api/, '')
    let match
    if (path === '/blocks/tip/height') return rule.tip === undefined ? new Response('no', { status: 503 }) : new Response(String(rule.tip))
    if ((match = /^\/block-height\/(\d+)$/.exec(path))) return rule.blocks?.[match[1]] ? new Response(rule.blocks[match[1]].hash) : new Response('no', { status: 404 })
    if ((match = /^\/block\/([0-9a-f]{64})\/header$/.exec(path))) {
      const block = Object.values(rule.blocks ?? {}).find(item => (item.named ?? item.hash) === match[1] || item.hash === match[1])
      return block ? new Response(hex(block.header)) : new Response('no', { status: 404 })
    }
    return new Response('no', { status: 404 })
  }
  return { fetch, calls }
}

/** The witness object over storage holding confirmed records (each stored proof a live proof), the newest made 1 h ago. */
async function fixture({ seqs = [1, 2], hosts = {}, floor = FLOOR, states = {}, extra = {}, totalMs = null } = {}) {
  const ws = memoryStorage(), net = explorers(hosts)
  const clock = { now: T0 + 8 * HOUR + HOUR }
  for (const seq of seqs) {
    const proofSeq = seq % 2 === 0 ? 2 : 1, proof = PROOF(proofSeq), [attestation] = await bitcoinAttestations(proof)
    const state = states[seq] ?? 'confirmed'
    const digest = hex(proof.subarray(33, 65))
    await ws.storage.put(`witness:record:${seq}`, { seq, digest, record: { v: 1, seq, prev: seq === 1 ? '0'.repeat(64) : 'd'.repeat(64), at: T0 + (seq - 1) * HOUR,
      facts: { head: null, receipts: null, journals: null }, missing: ['head-unavailable', 'journals-unavailable', 'receipts-unavailable'] },
    nonce: '0'.repeat(32), eventId: null, event: null, relays: null, publishAttempts: 0,
    ots: { state, height: state === 'confirmed' ? attestation.height : null, attempts: 1, at: T0 }, trigger: 'schedule', ...extra[seq] })
    await ws.storage.put(`witness:ots:${seq}`, hex(proof))
  }
  await ws.storage.put('witness:meta', { seq: Math.max(...seqs), pubkey: null, signed: Math.max(...seqs) })
  clock.now = T0 + (Math.max(...seqs) - 1) * HOUR + HOUR
  const object = new WitnessDO({ storage: ws.storage }, { WITNESS_SWITCH: 'on' }, { now: () => clock.now, fetch: net.fetch,
    openSocket: () => { throw new Error('no sockets here') }, timers: { set: fn => setTimeout(fn, 1), clear: id => clearTimeout(id) },
    ...(floor === null ? {} : { headerMinZeroBits: floor }), ...(totalMs === null ? {} : { headerTotalMs: totalMs }) })
  const tick = async (trigger) => {
    const response = await object.fetch(new Request('https://x61.internal/_witness/tick', { method: 'POST', headers: { 'x-x6-internal-authorized': '1' } }))
    assert.equal(response.status, 200)
    return response.json()
  }
  const header = async seq => (await ws.storage.get(`witness:record:${seq}`)).header ?? null
  const row = async seq => (await (await object.fetch(new Request('https://x61.internal/_witness/public', { headers: { 'x-x6-internal-authorized': '1' } }))).json()).public.records.find(item => item.seq === seq)
  const explorerCalls = () => net.calls.filter(call => WITNESS_HEADER_HOSTS.has(new URL(call.url).hostname))
  return { ws, net, clock, object, tick, header, row, explorerCalls }
}

/** Both primaries answer the same ground header for each seq's height, and the given tip. */
async function agreeing(seqs, tip) {
  const blocks = {}
  for (const seq of seqs) { const { height, merkleRoot } = await commitment(seq); blocks[height] = await ground(merkleRoot) }
  return { 'mempool.space': { blocks, tip }, 'btcscan.org': { blocks, tip } }
}

test('a true check: two explorers agree on the header, it hashes to the hash they name, meets its own target and the floor, holds the proof\'s merkle root, 6+ confirmations', async () => {
  const hosts = await agreeing([1, 2], 976200)
  const fx = await fixture({ hosts })
  const result = await fx.tick()
  assert.equal(result.ok, true)
  const { height, merkleRoot } = await commitment(2)
  const block = hosts['mempool.space'].blocks[height]
  assert.deepEqual(await fx.header(2), { checked: true, hash: block.hash, time: 1_794_847_294, confirmations: 976200 - height + 1, sources: ['mempool.space', 'btcscan.org'],
    tried: [{ host: 'mempool.space', why: 'ok' }, { host: 'btcscan.org', why: 'ok' }], at: fx.clock.now })
  assert.equal((await fx.header(1)).checked, true)
  assert.equal((await fx.header(1)).confirmations, 976200 - 976152 + 1)
  assert.equal(rev(merkleRoot), hex(block.header.subarray(36, 68)), 'the header holds the proof\'s value in header order')
  // The public row: ots { state, height, header }.
  const row = await fx.row(2)
  assert.deepEqual(row.ots, { state: 'confirmed', height, header: await fx.header(2) })
  // What left: block heights and block hashes only, GET, no body, the plain User-Agent, no redirect followed, https.
  const calls = fx.explorerCalls()
  assert.ok(calls.length > 0)
  for (const call of calls) {
    const url = new URL(call.url)
    assert.equal(url.protocol, 'https:')
    assert.equal(call.method, 'GET')
    assert.equal(call.body, null)
    assert.equal(call.redirect, 'manual')
    assert.ok(call.signal instanceof AbortSignal)
    assert.deepEqual(call.headers, { accept: '*/*', 'user-agent': 'header-check/1' })
    assert.match(url.pathname, /^\/api\/(?:block-height\/\d+|block\/[0-9a-f]{64}\/header|blocks\/tip\/height)$/, call.url)
    assert.equal(url.search, '')
  }
  // The tip is asked once per source per tick, not once per record.
  assert.equal(calls.filter(call => call.url.endsWith('/blocks/tip/height')).length, 2)
  // A checked header is never asked about again.
  const before = fx.explorerCalls().length
  fx.clock.now += 7 * HOUR
  await fx.tick()
  assert.equal(fx.explorerCalls().length, before)
})

test('the shipped floor is 72 leading zero bits: the same ground header is refused HEADER_WORK_TOO_LOW', async () => {
  assert.equal(WITNESS_LIMITS.headerMinZeroBits, 72)
  const { height } = await commitment(1)
  const fx = await fixture({ seqs: [1], hosts: await everywhere(height, (await agreeing([1], 976200))['mempool.space'].blocks[height], 976200), floor: null })
  await fx.tick()
  // WIT2C B: every source fails its own checks (self-mismatch); the code is the work's. (Review: the whole pool answers,
  // since a source that does not answer makes it unavailable.)
  const stored = await fx.header(1)
  assert.equal(stored.code, 'HEADER_WORK_TOO_LOW')
  assert.deepEqual(stored.tried.slice(0, 2), [{ host: 'mempool.space', why: 'self-mismatch' }, { host: 'btcscan.org', why: 'self-mismatch' }])
})

test('refusals: a header that does not hash to the hash its source names; one past its own target; a merkle root that is not the proof\'s; two sources that disagree', async () => {
  const { height, merkleRoot } = await commitment(1)
  const good = await ground(merkleRoot)
  // A wrong but well-formed header for the height: the source names the right hash, but answers another ground header.
  const other = await ground(merkleRoot, { salt: 3 })
  const lying = { blocks: { [height]: { hash: good.hash, header: other.header, named: good.hash } }, tip: 976200 }
  // Review: the rest of the pool lies the same way (a source that does not answer would make it unavailable).
  let fx = await fixture({ seqs: [1], hosts: { ...await everywhere(height, { hash: good.hash, header: other.header }, 976200), 'mempool.space': { blocks: { [height]: good }, tip: 976200 }, 'btcscan.org': lying } })
  await fx.tick()
  assert.equal((await fx.header(1)).code, 'HEADER_HASH_MISMATCH')
  // A header of valid form with too little work: real-looking bits, not ground.
  const weak = rebuildHeader({ version: 0x20000000, prevHash: 'ab'.repeat(32), merkleRoot, time: 1_794_847_294, bits: 0x17023a04, nonce: 7 })
  const weakBlock = { hash: await headerHash(weak), header: weak }
  fx = await fixture({ seqs: [1], hosts: await everywhere(height, weakBlock, 976200) })
  await fx.tick()
  assert.equal((await fx.header(1)).code, 'HEADER_WORK_TOO_LOW')
  // A real header that names another merkle root: never retried, it stays shown.
  const elsewhere = await ground('cd'.repeat(32))
  fx = await fixture({ seqs: [1], hosts: { 'mempool.space': { blocks: { [height]: elsewhere }, tip: 976200 }, 'btcscan.org': { blocks: { [height]: elsewhere }, tip: 976200 } } })
  await fx.tick()
  assert.equal((await fx.header(1)).code, 'HEADER_MERKLE_MISMATCH')
  // Two sources, each self-consistent, naming different blocks for the height: never retried either.
  const disagree = await fixture({ seqs: [1], hosts: { 'mempool.space': { blocks: { [height]: good }, tip: 976200 }, 'btcscan.org': { blocks: { [height]: other }, tip: 976200 } } })
  await disagree.tick()
  assert.equal((await disagree.header(1)).code, 'HEADER_SOURCES_DISAGREE')
  // A merkle mismatch is never retried; WIT2C B: a disagreement is tried ONCE more after 6 h, then it stays.
  let asked = fx.explorerCalls().length
  for (let index = 1; index <= 3; index++) { fx.clock.now += 7 * HOUR; await fx.tick() }
  assert.equal(fx.explorerCalls().length, asked, 'a merkle mismatch is not retried')
  assert.equal((await fx.row(1)).ots.header.checked, false)
  asked = disagree.explorerCalls().length
  disagree.clock.now += 7 * HOUR
  await disagree.tick()
  assert.ok(disagree.explorerCalls().length > asked, 'a disagreement is asked once more')
  assert.equal((await disagree.header(1)).code, 'HEADER_SOURCES_DISAGREE')
  assert.equal((await disagree.ws.storage.get('witness:record:1')).headerDisagreements, 2)
  asked = disagree.explorerCalls().length
  for (let index = 1; index <= 3; index++) { disagree.clock.now += 7 * HOUR; await disagree.tick() }
  assert.equal(disagree.explorerCalls().length, asked, 'then it stays')
  assert.equal((await disagree.row(1)).ots.header.code, 'HEADER_SOURCES_DISAGREE')
  assert.equal(WITNESS_LIMITS.headerDisagreeTries, 2)
  assert.deepEqual([...WITNESS_HEADER_CODES].sort(), ['HEADER_HASH_MISMATCH', 'HEADER_MERKLE_MISMATCH', 'HEADER_PROOF_UNREADABLE', 'HEADER_SOURCES_DISAGREE', 'HEADER_SOURCE_UNAVAILABLE', 'HEADER_TOO_FEW_CONFIRMATIONS', 'HEADER_WORK_TOO_LOW'])
})

test('WIT2C B: a source down: the pool goes on two at a time until two agree (blockcypher\'s fields rebuilt); all down, or one source alone: unavailable', async () => {
  const { height, merkleRoot } = await commitment(1)
  const good = await ground(merkleRoot)
  const fields = { hash: good.hash, height, ver: 0x20000000, prev_block: 'ab'.repeat(32), mrkl_root: merkleRoot, time: new Date(1_794_847_294_000).toISOString().replace('.000Z', 'Z'), bits: 0x207fffff, nonce: (await import('../bitcoin-header.mjs')).parseHeader(good.header).nonce }
  const fx = await fixture({ seqs: [1], hosts: { 'mempool.space': { blocks: { [height]: good }, tip: 976200 }, 'btcscan.org': 'down', 'mempool.emzy.de': 'down', 'api.blockchain.info': 'down',
    'api.blockcypher.com': { blocks: { [height]: fields } } } })
  await fx.tick()
  assert.deepEqual(await fx.header(1), { checked: true, hash: good.hash, time: 1_794_847_294, confirmations: 976200 - height + 1, sources: ['mempool.space', 'api.blockcypher.com'],
    tried: [{ host: 'mempool.space', why: 'ok' }, { host: 'btcscan.org', why: 'http-503' }, { host: 'mempool.emzy.de', why: 'http-503' }, { host: 'api.blockchain.info', why: 'http-503' },
      { host: 'api.blockcypher.com', why: 'ok' }, { host: 'api.bitaps.com', why: 'http-500' }, { host: 'blockstream.info', why: 'http-500' }], at: fx.clock.now })
  assert.deepEqual(fx.explorerCalls().filter(call => new URL(call.url).hostname === 'api.blockcypher.com').map(call => call.url), [`https://api.blockcypher.com/v1/btc/main/blocks/${height}`])
  // The tip: mempool.space (it agreed) and the one Esplora source not yet failed (blockstream.info, asked for its tip only).
  assert.deepEqual(fx.explorerCalls().filter(call => new URL(call.url).hostname === 'blockstream.info').map(call => call.url), ['https://blockstream.info/api/blocks/tip/height'])
  // The first two up: nobody else is asked.
  const both = await fixture({ seqs: [1], hosts: { ...await agreeing([1], 976200), 'api.blockcypher.com': { blocks: { [height]: fields } } } })
  await both.tick()
  assert.deepEqual([...new Set(both.explorerCalls().map(call => new URL(call.url).hostname))], ['mempool.space', 'btcscan.org'])
  // Everything down: every source asked once, in order, each row saying how.
  const down = await fixture({ seqs: [1], hosts: Object.fromEntries(['mempool.space', 'btcscan.org', 'mempool.emzy.de', 'api.blockchain.info', 'api.blockcypher.com', 'api.bitaps.com', 'blockstream.info'].map(host => [host, 'down'])) })
  await down.tick()
  assert.deepEqual(await down.header(1), { checked: false, code: 'HEADER_SOURCE_UNAVAILABLE', tried: ['mempool.space', 'btcscan.org', 'mempool.emzy.de', 'api.blockchain.info', 'api.blockcypher.com', 'api.bitaps.com', 'blockstream.info'].map(host => ({ host, why: 'http-503' })), at: down.clock.now })
  // One source alone is not enough.
  const one = await fixture({ seqs: [1], hosts: { 'api.blockcypher.com': { blocks: { [height]: fields } } } })
  await one.tick()
  assert.equal((await one.header(1)).code, 'HEADER_SOURCE_UNAVAILABLE')
})

test('too few confirmations, then enough on a later tick (6 h on)', async () => {
  const { height } = await commitment(1)
  const hosts = await agreeing([1], height + 4)
  const fx = await fixture({ seqs: [1], hosts })
  await fx.tick()
  assert.deepEqual(await fx.header(1), { checked: false, code: 'HEADER_TOO_FEW_CONFIRMATIONS', tried: [{ host: 'mempool.space', why: 'ok' }, { host: 'btcscan.org', why: 'ok' }], at: fx.clock.now })
  // Review: the LOWER of the two tips decides: one source a block ahead is not enough.
  hosts['btcscan.org'].tip = height + 5
  fx.clock.now += 6 * HOUR
  await fx.tick()
  assert.equal((await fx.header(1)).code, 'HEADER_TOO_FEW_CONFIRMATIONS', 'one source ahead does not make 6')
  // Both a block ahead make 6 confirmations, but only on a try 6 h on.
  hosts['mempool.space'].tip = height + 5
  fx.clock.now += HOUR
  await fx.tick()
  assert.equal((await fx.header(1)).code, 'HEADER_TOO_FEW_CONFIRMATIONS', 'not retried within 6 h')
  fx.clock.now += 5 * HOUR
  await fx.tick()
  assert.equal((await fx.header(1)).checked, true)
  assert.equal((await fx.header(1)).confirmations, 6)
  assert.equal(WITNESS_LIMITS.headerConfirmations, 6)
})

test('review: one source answering an absurd tip cannot make the count; the lower tip decides', async () => {
  const { height } = await commitment(1)
  const hosts = await agreeing([1], height + 1)
  hosts['mempool.space'].tip = 999_999_999
  const fx = await fixture({ seqs: [1], hosts })
  await fx.tick()
  assert.deepEqual(await fx.header(1), { checked: false, code: 'HEADER_TOO_FEW_CONFIRMATIONS', tried: [{ host: 'mempool.space', why: 'ok' }, { host: 'btcscan.org', why: 'ok' }], at: fx.clock.now })
  // Both sane: the count stored is the lower tip's.
  const both = await agreeing([1], height + 20)
  both['btcscan.org'].tip = height + 9
  const ok = await fixture({ seqs: [1], hosts: both })
  await ok.tick()
  assert.equal((await ok.header(1)).confirmations, 10)
})

test('review: a confirmed record whose stored proof cannot be read is recorded HEADER_PROOF_UNREADABLE and counted; it never starves a good one', async () => {
  const fx = await fixture({ seqs: [1, 2, 3], hosts: await agreeing([1], 976200) })
  // The two newest have no stored proof (or one that is not a proof): they take the two slots of the first tick.
  fx.ws.data.delete('witness:ots:3')
  fx.ws.data.set('witness:ots:2', '00'.repeat(40))
  await fx.tick()
  assert.deepEqual(await fx.header(3), { checked: false, code: 'HEADER_PROOF_UNREADABLE', tried: [], at: fx.clock.now })
  assert.deepEqual(await fx.header(2), { checked: false, code: 'HEADER_PROOF_UNREADABLE', tried: [], at: fx.clock.now })
  assert.equal((await fx.ws.storage.get('witness:record:3')).headerTries, 1)
  assert.deepEqual((await fx.row(3)).ots.header, await fx.header(3), 'shown on the public row')
  // The next hourly tick checks the good one.
  fx.clock.now += HOUR
  await fx.tick()
  assert.equal((await fx.header(1)).checked, true)
  assert.ok(WITNESS_HEADER_CODES.includes('HEADER_PROOF_UNREADABLE'))
})

test('review: the header pass runs after the new record is made (explorer slowness never delays a record)', async () => {
  const fx = await fixture({ seqs: [1, 2], hosts: await agreeing([1, 2], 976200) })
  fx.clock.now += 4 * HOUR
  let explorerCallsAtRecord = null
  const put = fx.ws.storage.put
  fx.ws.storage.put = async (key, value) => { if (key === 'witness:record:3' && explorerCallsAtRecord === null) explorerCallsAtRecord = fx.explorerCalls().length; return put(key, value) }
  const result = await fx.tick()
  assert.equal(result.created, true)
  assert.equal(explorerCallsAtRecord, 0, 'no explorer was asked before the record was stored')
  assert.equal((await fx.header(1)).checked, true)
  assert.equal((await fx.header(2)).checked, true)
})

test('bounds: 2 records a tick, newest first; WIT2C C: unavailable again at the next hourly tick for its first 3 tries, then every 6 h, at most 8; a pending proof fetches nothing', async () => {
  const fx = await fixture({ seqs: [1, 2, 3], hosts: { 'mempool.space': 'down', 'btcscan.org': 'down', 'api.blockcypher.com': 'down' } })
  await fx.tick()
  assert.equal(await fx.header(1), null, 'the oldest waits')
  assert.equal((await fx.header(3)).code, 'HEADER_SOURCE_UNAVAILABLE')
  assert.equal((await fx.header(2)).code, 'HEADER_SOURCE_UNAVAILABLE')
  assert.equal(WITNESS_LIMITS.headerRecordsPerTick, 2)
  const tries = async () => [await fx.ws.storage.get('witness:record:1'), await fx.ws.storage.get('witness:record:2'), await fx.ws.storage.get('witness:record:3')].map(entry => entry.headerTries ?? 0)
  fx.clock.now += HOUR
  await fx.tick()
  assert.equal((await fx.header(1)).code, 'HEADER_SOURCE_UNAVAILABLE', 'the next tick takes the one never tried first')
  assert.deepEqual(await tries(), [1, 1, 2], 'and one unavailable record again an hour on (the oldest try, newest first)')
  // Hourly, two a tick, until each has had its 3 quick tries; none gets a 4th within 6 h of its 3rd.
  for (let index = 0; index < 3; index++) { fx.clock.now += HOUR; await fx.tick() }
  assert.deepEqual(await tries(), [3, 3, 3])
  const asked = fx.explorerCalls().length
  fx.clock.now += HOUR
  await fx.tick()
  assert.equal(fx.explorerCalls().length, asked, 'after 3 tries: every 6 h')
  // Every 6 h one more try each, up to 8, then never again.
  for (let index = 0; index < 12; index++) { fx.clock.now += 6 * HOUR; await fx.tick() }
  assert.deepEqual(await tries(), [8, 8, 8])
  assert.equal(WITNESS_LIMITS.headerTries, 8)
  assert.equal(WITNESS_LIMITS.headerRetryMs, 6 * HOUR)
  assert.equal(WITNESS_LIMITS.headerQuickTries, 3)
  const done = fx.explorerCalls().length
  fx.clock.now += 6 * HOUR
  await fx.tick()
  assert.equal(fx.explorerCalls().length, done)

  const pending = await fixture({ seqs: [1], states: { 1: 'pending' }, hosts: await agreeing([1], 976200) })
  await pending.tick()
  assert.deepEqual(pending.explorerCalls(), [])
  assert.equal(await pending.header(1), null)
  assert.equal((await pending.row(1)).ots.header, null)
})

test('the promotion tick checks no header; only the hourly one does', async () => {
  const fx = await fixture({ seqs: [1], hosts: await agreeing([1], 976200) })
  await fx.object.tick({ trigger: 'promotion' })
  assert.deepEqual(fx.explorerCalls(), [])
})

test('host allow-list: https and the pool\'s seven hosts exactly; a redirect is a failure, never followed', async () => {
  for (const url of ['https://mempool.space/api/blocks/tip/height', 'https://blockstream.info/api/block-height/1', 'https://api.blockcypher.com/v1/btc/main/blocks/1',
    'https://btcscan.org/api/block-height/1', 'https://mempool.emzy.de/api/blocks/tip/height', 'https://api.blockchain.info/haskoin-store/btc/block/height/1?notx=true',
    'https://api.bitaps.com/btc/v1/blockchain/block/1']) assert.equal(headerUrlAllowed(url), true, url)
  for (const url of ['http://mempool.space/api/blocks/tip/height', 'https://evil.mempool.space/api/x', 'https://mempool.space:8443/api/x', 'https://user@mempool.space/api/x',
    'https://blockchain.info/rawblock/x', 'https://mempool.space.evil.example/api/x', 'https://bitaps.com/x', 'https://emzy.de/api/x', 'not a url']) assert.equal(headerUrlAllowed(url), false, url)
  const { height } = await commitment(1)
  const hosts = await agreeing([1], 976200)
  hosts['btcscan.org'] = url => new Response(null, { status: 302, headers: { location: 'https://evil.example/' + new URL(url).pathname } })
  const fx = await fixture({ seqs: [1], hosts })
  await fx.tick()
  assert.equal((await fx.header(1)).code, 'HEADER_SOURCE_UNAVAILABLE', 'the rest of the pool is not there; a redirect counts as a failure')
  assert.deepEqual((await fx.header(1)).tried.slice(0, 2), [{ host: 'mempool.space', why: 'ok' }, { host: 'btcscan.org', why: 'redirect' }])
  assert.equal(fx.net.calls.some(call => call.url.includes('evil.example')), false)
  // A reply past 4 KiB is a failure too.
  const big = await agreeing([1], 976200)
  big['btcscan.org'] = () => new Response('0'.repeat(WITNESS_LIMITS.headerReplyBytes + 1))
  const large = await fixture({ seqs: [1], hosts: big })
  await large.tick()
  assert.equal((await large.header(1)).code, 'HEADER_SOURCE_UNAVAILABLE')
  assert.equal(WITNESS_LIMITS.headerReplyBytes, 4096)
  assert.equal(WITNESS_LIMITS.headerTimeoutMs, 8000)
  assert.ok(height > 0)
})

test('the public projection takes the new header field and refuses any other shape; rows before this change read header null', async () => {
  const relays = { ok: 0, of: 5, held: null, heldCheckedAt: null, rows: ['relay.damus.io', 'nos.lol', 'relay.primal.net', 'relay.nostr.band', 'nostr.mom'].map(relay => ({ relay, sent: 'none', held: null })) }
  const D = n => String(n).repeat(64).slice(0, 64)
  const row = header => ({ seq: 1, at: T0, digest: D(1), prev: '0'.repeat(64), eventId: null, trigger: 'schedule', relays, ots: { state: 'confirmed', height: 976152, header }, tsa: null })
  const view = header => ({ schema: 'witness.v1', pubkey: null, head: { seq: 1, digest: D(1), at: T0 }, records: [row(header)] })
  const checked = { checked: true, hash: D(0), time: 1_794_847_294, confirmations: 9, sources: ['mempool.space', 'btcscan.org'], at: T0 }
  for (const header of [null, checked, { ...checked, sources: ['mempool.space', 'api.blockcypher.com'] }, ...WITNESS_HEADER_CODES.map(code => ({ checked: false, code, at: T0 }))]) {
    assert.deepEqual(projectWitnessPublic(view(header))?.records[0].ots.header, header, JSON.stringify(header))
  }
  // Extra keys inside are dropped (the projection rebuilds it).
  assert.deepEqual(projectWitnessPublic(view({ ...checked, tries: 3 })).records[0].ots.header, checked)
  for (const bad of [undefined, { checked: 'yes' }, { ...checked, checked: false }, { checked: false, code: 'HEADER_OTHER', at: T0 }, { checked: false, code: 'HEADER_WORK_TOO_LOW' },
    { ...checked, hash: 'x' }, { ...checked, sources: ['mempool.space'] }, { ...checked, sources: ['mempool.space', 'mempool.space'] }, { ...checked, sources: ['mempool.space', 'blockchain.info'] },
    { ...checked, confirmations: 5 }, { ...checked, time: -1 }, { ...checked, at: null }]) {
    assert.equal(projectWitnessPublic(view(bad)), null, JSON.stringify(bad))
  }
  // A record stored before this change (no header beside it) reads header null.
  const fx = await fixture({ seqs: [1], states: { 1: 'pending' } })
  assert.equal((await fx.row(1)).ots.header, null)
})

// ---- WIT2C A: a check says which sources were asked and how each ended ----

const ok = host => ({ host, why: 'ok' })
const rowsOnly = rows => rows.every(row => Object.keys(row).sort().join() === 'host,why' && WITNESS_HEADER_WHY.test(row.why))

test('WIT2C A: a failed check stores and shows, beside its code, each source asked and how it ended (status digits only)', async () => {
  const { height, merkleRoot } = await commitment(1)
  const good = await ground(merkleRoot)
  // One answers, one is busy, the third is not there: unavailable, and the rows say so.
  let fx = await fixture({ seqs: [1], hosts: { 'mempool.space': { blocks: { [height]: good }, tip: 976200 }, 'btcscan.org': 'down' } })
  await fx.tick()
  const stored = await fx.header(1)
  assert.equal(stored.code, 'HEADER_SOURCE_UNAVAILABLE')
  assert.deepEqual(stored.tried, [ok('mempool.space'), { host: 'btcscan.org', why: 'http-503' }, ...['mempool.space', 'btcscan.org', 'mempool.emzy.de', 'api.blockchain.info', 'api.blockcypher.com', 'api.bitaps.com', 'blockstream.info'].slice(2).map(host => ({ host, why: 'http-500' }))])
  assert.deepEqual((await fx.row(1)).ots.header, stored, 'shown on the public row as stored')
  // Slow, redirected, too large, answered but not the form, a fetch that throws, a status that is not three digits.
  const slow = () => { throw new DOMException('slow', 'TimeoutError') }
  const up = { blocks: { [height]: good }, tip: 976200 }
  const cases = [
    [{ 'mempool.space': up, 'btcscan.org': slow, 'mempool.emzy.de': () => new Response(null, { status: 302, headers: { location: 'https://evil.example/' } }) }, ['ok', 'timeout', 'redirect']],
    [{ 'mempool.space': () => new Response('x'.repeat(WITNESS_LIMITS.headerReplyBytes + 1)), 'btcscan.org': up, 'mempool.emzy.de': () => new Response('not json') }, ['too-large', 'ok', 'shape']],
    [{ 'mempool.space': () => new Response('not a hash'), 'btcscan.org': up, 'mempool.emzy.de': () => { throw new TypeError('network') } }, ['shape', 'ok', 'error']],
    [{ 'mempool.space': up, 'btcscan.org': () => ({ status: 0, body: null }), 'mempool.emzy.de': () => new Response('gone', { status: 410 }) }, ['ok', 'error', 'http-410']],
  ]
  for (const [hosts, words] of cases) {
    fx = await fixture({ seqs: [1], hosts })
    await fx.tick()
    assert.deepEqual((await fx.header(1)).tried.slice(0, 3), ['mempool.space', 'btcscan.org', 'mempool.emzy.de'].map((host, index) => ({ host, why: words[index] })), words.join())
    assert.equal(fx.net.calls.some(call => call.url.includes('evil.example')), false)
  }
  // A source whose header does not hash to the hash it names: self-mismatch.
  const other = await ground(merkleRoot, { salt: 3 })
  fx = await fixture({ seqs: [1], hosts: { 'mempool.space': { blocks: { [height]: good }, tip: 976200 }, 'btcscan.org': { blocks: { [height]: { hash: good.hash, header: other.header } }, tip: 976200 } } })
  await fx.tick()
  assert.deepEqual((await fx.header(1)).tried.slice(0, 2), [ok('mempool.space'), { host: 'btcscan.org', why: 'self-mismatch' }])
  assert.ok(rowsOnly((await fx.header(1)).tried))
})

test('WIT2C A: a true check keeps its tried rows too; a proof that cannot be read asks nobody (no rows)', async () => {
  const fx = await fixture({ seqs: [1], hosts: await agreeing([1], 976200) })
  await fx.tick()
  const stored = await fx.header(1)
  assert.equal(stored.checked, true)
  assert.deepEqual(stored.tried, [ok('mempool.space'), ok('btcscan.org')])
  assert.deepEqual((await fx.row(1)).ots.header, stored)
  const none = await fixture({ seqs: [1], hosts: await agreeing([1], 976200) })
  none.ws.data.delete('witness:ots:1')
  await none.tick()
  assert.deepEqual(await none.header(1), { checked: false, code: 'HEADER_PROOF_UNREADABLE', tried: [], at: none.clock.now })
})

test('WIT2C A: the closed words, and the projection takes tried exactly (bounded), old rows without it read as before', () => {
  for (const why of ['ok', 'http-200', 'http-404', 'http-503', 'timeout', 'redirect', 'too-large', 'shape', 'self-mismatch', 'error']) assert.ok(WITNESS_HEADER_WHY.test(why), why)
  for (const why of ['http-50', 'http-5030', 'http-abc', 'http-503 ', 'OK', 'refused', '', 'timeout:8s']) assert.equal(WITNESS_HEADER_WHY.test(why), false, why)
  assert.equal(WITNESS_LIMITS.headerTriedRows, 8)
  const relays = { ok: 0, of: 5, held: null, heldCheckedAt: null, rows: ['relay.damus.io', 'nos.lol', 'relay.primal.net', 'relay.nostr.band', 'nostr.mom'].map(relay => ({ relay, sent: 'none', held: null })) }
  const D = n => String(n).repeat(64).slice(0, 64)
  const view = header => ({ schema: 'witness.v1', pubkey: null, head: { seq: 1, digest: D(1), at: T0 },
    records: [{ seq: 1, at: T0, digest: D(1), prev: '0'.repeat(64), eventId: null, trigger: 'schedule', relays, ots: { state: 'confirmed', height: 976152, header }, tsa: null }] })
  const failedRow = { checked: false, code: 'HEADER_SOURCE_UNAVAILABLE', at: T0 }
  const tried = [ok('mempool.space'), { host: 'btcscan.org', why: 'http-429' }, { host: 'mempool.emzy.de', why: 'timeout' }]
  const checked = { checked: true, hash: D(0), time: 1_794_847_294, confirmations: 9, sources: ['mempool.space', 'btcscan.org'], at: T0 }
  for (const header of [failedRow, { ...failedRow, tried }, { ...failedRow, tried: [] }, checked, { ...checked, tried }]) {
    assert.deepEqual(projectWitnessPublic(view(header)).records[0].ots.header, header, JSON.stringify(header))
  }
  // A row's extra keys are dropped (rebuilt from host and why).
  assert.deepEqual(projectWitnessPublic(view({ ...failedRow, tried: [{ ...tried[0], url: 'https://mempool.space/api/x' }] })).records[0].ots.header.tried, [tried[0]])
  for (const bad of [{ ...failedRow, tried: 'none' }, { ...failedRow, tried: [{ host: 'evil.example', why: 'ok' }] }, { ...failedRow, tried: [{ host: 'mempool.space', why: 'http-5034' }] },
    { ...failedRow, tried: [{ host: 'mempool.space', why: 'slow' }] }, { ...failedRow, tried: [{ host: 'mempool.space' }] }, { ...failedRow, tried: [null] },
    { ...failedRow, tried: Array(9).fill(ok('mempool.space')) }, { ...checked, tried: [{ host: 'mempool.space', why: 'ok', extra: 1 }, 7] }]) {
    assert.equal(projectWitnessPublic(view(bad)), null, JSON.stringify(bad))
  }
})

// ---- WIT2C B: a pool of sources instead of two plus one ----

const B125552 = { height: 125552, header: '0100000081cd02ab7e569e8bcd9317e2fe99f2de44d49ab2b8851ba4a308000000000000e320b6c2fffc8d750423db8b1eb942ae710e951ed797f7affc8892b0f1fc122bc7f5d74df2b9441a42a14695',
  hash: '00000000000000001e8d6829a8a21adc5d38d0a473b144b6765798e61f98bd1d' }
/** The haskoin store's reply shape (api.blockchain.info, ?notx=true): a JSON list of ONE block. */
async function haskoinReply(height, block) {
  const { parseHeader } = await import('../bitcoin-header.mjs')
  const f = parseHeader(block.header)
  return [{ hash: block.hash, height, mainchain: true, previous: f.prevHash, time: f.time, version: f.version, bits: f.bits, nonce: f.nonce, merkle: f.merkleRoot }]
}
/** bitaps' reply shape: `data.header` base64 of the 80 header bytes and a 3-byte transaction count (83 bytes). */
const bitapsReply = (height, block) => ({ data: { height, hash: block.hash, header: Buffer.concat([Buffer.from(block.header), Buffer.from([0xfd, 0x01, 0x02])]).toString('base64') } })
async function blockcypherReply(height, block) {
  const { parseHeader } = await import('../bitcoin-header.mjs')
  const f = parseHeader(block.header)
  return { hash: block.hash, height, ver: f.version, prev_block: f.prevHash, mrkl_root: f.merkleRoot, time: new Date(f.time * 1000).toISOString().replace('.000Z', 'Z'), bits: f.bits, nonce: f.nonce }
}

test('WIT2C B: the pool, in order, each with its kind and byte bound; the allow-list is exactly these seven hosts', () => {
  assert.deepEqual(WITNESS_HEADER_SOURCES.map(item => [item.host, item.kind, item.base, item.bytes]), [
    ['mempool.space', 'esplora', 'https://mempool.space/api', 4096],
    ['btcscan.org', 'esplora', 'https://btcscan.org/api', 4096],
    ['mempool.emzy.de', 'esplora', 'https://mempool.emzy.de/api', 4096],
    ['api.blockchain.info', 'fields', 'https://api.blockchain.info/haskoin-store/btc', 2048],
    ['api.blockcypher.com', 'fields', 'https://api.blockcypher.com/v1/btc/main', 4096],
    ['api.bitaps.com', 'raw', 'https://api.bitaps.com/btc/v1/blockchain', 2048],
    ['blockstream.info', 'esplora', 'https://blockstream.info/api', 4096]])
  assert.deepEqual([...WITNESS_HEADER_HOSTS], WITNESS_HEADER_SOURCES.map(item => item.host))
  assert.equal(WITNESS_LIMITS.headerSmallReplyBytes, 2048)
})

test('WIT2C B: each adapter turns its real reply shape into the same 80 bytes (block 125552, a real header)', async () => {
  const real = { hash: B125552.hash, header: new Uint8Array(Buffer.from(B125552.header, 'hex')) }
  const h = B125552.height
  const hosts = { 'mempool.space': { blocks: { [h]: real } }, 'api.blockchain.info': { blocks: { [h]: await haskoinReply(h, real) } },
    'api.blockcypher.com': { blocks: { [h]: await blockcypherReply(h, real) } }, 'api.bitaps.com': { blocks: { [h]: bitapsReply(h, real) } } }
  const fx = await fixture({ seqs: [1], hosts })
  const deadline = AbortSignal.timeout(5000)
  for (const item of WITNESS_HEADER_SOURCES.filter(entry => entry.host in hosts)) {
    const answer = await fx.object.sourceBlock(item, h, deadline)
    assert.equal(answer.host, item.host)
    assert.equal(answer.hash, B125552.hash, item.host)
    assert.equal(hex(answer.header), B125552.header, item.host)
    assert.equal(await fx.object.ownCheck(answer), null, item.host)
  }
  assert.equal(JSON.stringify(await haskoinReply(h, real)).length < 2048, true)
  assert.ok(fx.net.calls.some(call => call.url === `https://api.blockchain.info/haskoin-store/btc/block/height/${h}?notx=true`))
  assert.ok(fx.net.calls.some(call => call.url === `https://api.bitaps.com/btc/v1/blockchain/block/${h}`))
  // Wrong forms: shape; another height: self-mismatch; past 2 KiB: too-large.
  const ask = async (host, body) => {
    const one = await fixture({ seqs: [1], hosts: { [host]: () => (typeof body === 'string' ? new Response(body) : Response.json(body)) } })
    return (await one.object.sourceBlock(WITNESS_HEADER_SOURCES.find(item => item.host === host), h, deadline)).why
  }
  const [hask] = await haskoinReply(h, real)
  assert.equal(await ask('api.blockchain.info', [{ ...hask, mainchain: false }]), 'shape')
  assert.equal(await ask('api.blockchain.info', [hask, hask]), 'shape')
  assert.equal(await ask('api.blockchain.info', hask), 'shape', 'not a list')
  assert.equal(await ask('api.blockchain.info', [{ ...hask, height: h + 1 }]), 'self-mismatch')
  assert.equal(await ask('api.blockchain.info', [{ ...hask, pad: 'x'.repeat(2048) }]), 'too-large')
  const raw = bitapsReply(h, real)
  assert.equal(await ask('api.bitaps.com', { data: { ...raw.data, header: Buffer.from(real.header.subarray(0, 79)).toString('base64') } }), 'shape')
  assert.equal(await ask('api.bitaps.com', { data: { ...raw.data, header: '!!!' } }), 'shape')
  assert.equal(await ask('api.bitaps.com', { data: { ...raw.data, height: h - 1 } }), 'self-mismatch')
  assert.equal(await ask('api.bitaps.com', { ...raw, pad: 'x'.repeat(2048) }), 'too-large')
  assert.equal(await ask('api.blockcypher.com', { ...await blockcypherReply(h, real), height: 1 }), 'self-mismatch')
  // A source that names a hash its header does not hash to fails its own check.
  assert.equal(await fx.object.ownCheck({ ...real, hash: 'f'.repeat(64) }), 'HEADER_HASH_MISMATCH')
})

test('WIT2C B: the two primaries refused from the edge (as on 2026-11-17): the next two in the pool decide', async () => {
  const { height, merkleRoot } = await commitment(1)
  const good = await ground(merkleRoot)
  const hosts = { 'mempool.space': () => new Response('slow down', { status: 429 }), 'btcscan.org': { blocks: { [height]: good }, tip: 976200 }, 'mempool.emzy.de': { blocks: { [height]: good }, tip: 976190 },
    'blockstream.info': () => { throw new DOMException('slow', 'TimeoutError') } }
  const fx = await fixture({ seqs: [1], hosts })
  await fx.tick()
  assert.deepEqual(await fx.header(1), { checked: true, hash: good.hash, time: 1_794_847_294, confirmations: 976190 - height + 1, sources: ['btcscan.org', 'mempool.emzy.de'],
    tried: [{ host: 'mempool.space', why: 'http-429' }, { host: 'btcscan.org', why: 'ok' }, { host: 'mempool.emzy.de', why: 'ok' }, { host: 'api.blockchain.info', why: 'http-500' }], at: fx.clock.now })
  // Only the fields and raw kinds answer: two of them agree; the tip comes from an Esplora source not yet failed (the last).
  const fields = await fixture({ seqs: [1], hosts: { 'mempool.space': 'down', 'btcscan.org': 'down', 'mempool.emzy.de': 'down',
    'api.blockchain.info': { blocks: { [height]: await haskoinReply(height, good) } }, 'api.blockcypher.com': 'down', 'api.bitaps.com': { blocks: { [height]: bitapsReply(height, good) } },
    'blockstream.info': { tip: 976200 } } })
  await fields.tick()
  const stored = await fields.header(1)
  assert.equal(stored.checked, true)
  assert.deepEqual(stored.sources, ['api.blockchain.info', 'api.bitaps.com'])
  assert.equal(stored.confirmations, 976200 - height + 1, 'blockstream.info gave the tip; mempool.space (failed) the other, still down')
  assert.deepEqual(stored.tried, [{ host: 'mempool.space', why: 'http-503' }, { host: 'btcscan.org', why: 'http-503' }, { host: 'mempool.emzy.de', why: 'http-503' },
    { host: 'api.blockchain.info', why: 'ok' }, { host: 'api.blockcypher.com', why: 'http-503' }, { host: 'api.bitaps.com', why: 'ok' }, { host: 'blockstream.info', why: 'ok' }])
  // No Esplora source gives a tip: too few confirmations, the rows saying why.
  const tipless = await fixture({ seqs: [1], hosts: { 'mempool.space': 'down', 'btcscan.org': 'down', 'mempool.emzy.de': 'down',
    'api.blockchain.info': { blocks: { [height]: await haskoinReply(height, good) } }, 'api.bitaps.com': { blocks: { [height]: bitapsReply(height, good) } }, 'blockstream.info': 'down' } })
  await tipless.tick()
  assert.equal((await tipless.header(1)).code, 'HEADER_TOO_FEW_CONFIRMATIONS')
  assert.deepEqual((await tipless.header(1)).tried.find(row => row.host === 'blockstream.info'), { host: 'blockstream.info', why: 'http-503' })
  assert.equal(tipless.explorerCalls().filter(call => call.url.endsWith('/blocks/tip/height')).length, 2, 'at most two tips asked')
})

test('WIT2C B: a source whose own answer fails is self-mismatch and the next is asked (no longer the end of the check)', async () => {
  const { height, merkleRoot } = await commitment(1)
  const good = await ground(merkleRoot), other = await ground(merkleRoot, { salt: 3 })
  const fx = await fixture({ seqs: [1], hosts: { 'mempool.space': { blocks: { [height]: { hash: good.hash, header: other.header } }, tip: 976200 },
    'btcscan.org': { blocks: { [height]: good }, tip: 976200 }, 'mempool.emzy.de': { blocks: { [height]: good }, tip: 976200 } } })
  await fx.tick()
  const stored = await fx.header(1)
  assert.equal(stored.checked, true)
  assert.deepEqual(stored.sources, ['btcscan.org', 'mempool.emzy.de'])
  // Two at a time: mempool.emzy.de was asked with api.blockchain.info (not there here).
  assert.deepEqual(stored.tried, [{ host: 'mempool.space', why: 'self-mismatch' }, { host: 'btcscan.org', why: 'ok' }, { host: 'mempool.emzy.de', why: 'ok' }, { host: 'api.blockchain.info', why: 'http-500' }])
})

test('WIT2C B: one deadline for the whole pass: sources that never answer end it as unavailable, timed out; no record is started past it', async () => {
  assert.equal(WITNESS_LIMITS.headerTotalMs, 30000)
  const signals = []
  const hosts = Object.fromEntries(WITNESS_HEADER_SOURCES.map(item => [item.host, () => new Promise(() => {})]))
  const fx = await fixture({ seqs: [1, 2], hosts, totalMs: 60 })
  const inner = fx.net.fetch
  fx.object.net = (url, init) => { signals.push(init?.signal); return inner(url, init) }
  const started = Date.now()
  await fx.tick()
  assert.ok(Date.now() - started < 3000, 'the pass ended at its deadline')
  assert.deepEqual(await fx.header(2), { checked: false, code: 'HEADER_SOURCE_UNAVAILABLE', tried: [{ host: 'mempool.space', why: 'timeout' }, { host: 'btcscan.org', why: 'timeout' }], at: fx.clock.now })
  assert.equal(await fx.header(1), null, 'the second record was not started past the deadline')
  assert.ok(signals.length >= 2 && signals.every(signal => signal instanceof AbortSignal && signal.aborted), 'every call was handed the deadline')
})

// ---- WIT2C C: retry sooner when sources were simply unavailable ----

test('WIT2C C: the four live records that failed under the old build (one try, no tried rows) are retried at the first tick after the deploy', async () => {
  // As stored live on 2026-11-17: records 3 and 4 failed at the 15:17 tick, 1 and 2 at 16:17, each { checked, code, at }
  // and headerTries 1, nothing else. The first tick after the deploy is (say) 18:17.
  const at1517 = T0 + 3 * HOUR - HOUR, at1617 = at1517 + HOUR
  const old = at => ({ header: { checked: false, code: 'HEADER_SOURCE_UNAVAILABLE', at }, headerTries: 1 })
  const fx = await fixture({ seqs: [1, 2, 3, 4], hosts: await agreeing([1, 2], 976200), extra: { 1: old(at1617), 2: old(at1617), 3: old(at1517), 4: old(at1517) } })
  fx.clock.now = at1617 + 2 * HOUR
  assert.equal((await fx.row(1)).ots.header.tried, undefined, 'an old row reads as before: no tried')
  await fx.tick()
  // Two a tick (the cap stands): the two failed longest ago first, then the other two on the next tick.
  assert.equal((await fx.header(4)).checked, true)
  assert.equal((await fx.header(3)).checked, true)
  assert.equal((await fx.header(1)).at, at1617, 'waits for the next tick (2 a tick)')
  fx.clock.now += HOUR
  await fx.tick()
  assert.equal((await fx.header(1)).checked, true)
  assert.equal((await fx.header(2)).checked, true)
  assert.equal((await fx.ws.storage.get('witness:record:1')).headerTries, 2)
  // The hashed records did not change.
  for (const seq of [1, 2, 3, 4]) assert.equal((await fx.ws.storage.get(`witness:record:${seq}`)).record.seq, seq)
})

test('WIT2C C: only unavailable is retried hourly; any other retried code keeps the 6 h rule', async () => {
  const { height } = await commitment(1)
  const fx = await fixture({ seqs: [1], hosts: await agreeing([1], height + 4) })
  await fx.tick()
  assert.equal((await fx.header(1)).code, 'HEADER_TOO_FEW_CONFIRMATIONS')
  const asked = fx.explorerCalls().length
  for (let index = 0; index < 5; index++) { fx.clock.now += HOUR; await fx.tick() }
  assert.equal(fx.explorerCalls().length, asked, 'too few confirmations: not within 6 h')
  // A quick retry needs at least half an hour since the last try (a second tick in the same hour does not ask again).
  const quick = await fixture({ seqs: [1], hosts: { 'mempool.space': 'down' } })
  await quick.tick()
  const first = quick.explorerCalls().length
  quick.clock.now += 10 * 60_000
  await quick.tick()
  assert.equal(quick.explorerCalls().length, first)
  quick.clock.now += 50 * 60_000
  await quick.tick()
  assert.ok(quick.explorerCalls().length > first)
  assert.equal(WITNESS_LIMITS.headerQuickRetryMs, 30 * 60_000)
})

// ---- Review of WIT2C: a lying source never gives the tip nor loses its row; one liar among unreachable sources is unavailable ----

/** Every source in the pool answering `block` at `height` in its own reply shape (esplora ones with `tip`). */
async function everywhere(height, block, tip) {
  const esplora = { blocks: { [height]: block }, tip }
  return { 'mempool.space': esplora, 'btcscan.org': esplora, 'mempool.emzy.de': esplora, 'blockstream.info': esplora,
    'api.blockchain.info': { blocks: { [height]: await haskoinReply(height, block) } }, 'api.blockcypher.com': { blocks: { [height]: await blockcypherReply(height, block) } },
    'api.bitaps.com': { blocks: { [height]: bitapsReply(height, block) } } }
}

test('review: a self-mismatched Esplora source is never asked for the tip and its row stays self-mismatch', async () => {
  const { height, merkleRoot } = await commitment(1)
  const good = await ground(merkleRoot), other = await ground(merkleRoot, { salt: 3 })
  const fx = await fixture({ seqs: [1], hosts: { 'mempool.space': { blocks: { [height]: { hash: good.hash, header: other.header } }, tip: height + 39 },
    'btcscan.org': 'down', 'mempool.emzy.de': 'down', 'api.blockchain.info': { blocks: { [height]: await haskoinReply(height, good) } }, 'api.blockcypher.com': 'down',
    'api.bitaps.com': { blocks: { [height]: bitapsReply(height, good) } }, 'blockstream.info': { tip: height + 59 } } })
  await fx.tick()
  const stored = await fx.header(1)
  assert.equal(stored.checked, true)
  assert.equal(stored.confirmations, 60, 'the depth is the honest tip\'s, never the lying source\'s')
  assert.deepEqual(stored.tried.find(row => row.host === 'mempool.space'), { host: 'mempool.space', why: 'self-mismatch' })
  assert.deepEqual((await fx.row(1)).ots.header.tried.find(row => row.host === 'mempool.space'), { host: 'mempool.space', why: 'self-mismatch' })
  assert.equal(fx.explorerCalls().some(call => call.url === 'https://mempool.space/api/blocks/tip/height'), false, 'the liar is not asked for its tip')
  // A tip that fails after an ok header does not hide the header row's first failure either (btcscan stays http-503).
  assert.deepEqual(stored.tried.find(row => row.host === 'btcscan.org'), { host: 'btcscan.org', why: 'http-503' })
})

test('review: one source answering garbage while the rest are unreachable is unavailable (hourly retry); only liars everywhere name a lying code', async () => {
  const { height, merkleRoot } = await commitment(1)
  const good = await ground(merkleRoot), other = await ground(merkleRoot, { salt: 3 })
  const down = Object.fromEntries(WITNESS_HEADER_SOURCES.map(item => [item.host, 'down']))
  const fx = await fixture({ seqs: [1], hosts: { ...down, 'mempool.space': { blocks: { [height]: good }, tip: 976200 }, 'btcscan.org': { blocks: { [height]: { hash: good.hash, header: other.header } }, tip: 976200 } } })
  await fx.tick()
  assert.equal((await fx.header(1)).code, 'HEADER_SOURCE_UNAVAILABLE')
  assert.deepEqual((await fx.header(1)).tried.slice(0, 2), [ok('mempool.space'), { host: 'btcscan.org', why: 'self-mismatch' }], 'the rows still show the liar')
  const asked = fx.explorerCalls().length
  fx.clock.now += HOUR
  await fx.tick()
  assert.ok(fx.explorerCalls().length > asked, 'asked again an hour on')
  // Every source but one lies: the code is the liars'.
  const liars = await everywhere(height, { hash: good.hash, header: other.header }, 976200)
  const all = await fixture({ seqs: [1], hosts: { ...liars, 'mempool.space': { blocks: { [height]: good }, tip: 976200 } } })
  await all.tick()
  assert.equal((await all.header(1)).code, 'HEADER_HASH_MISMATCH')
})
