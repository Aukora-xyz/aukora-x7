/** HEAD's two internal witness routes (witness.mjs handleWitnessHeadRoute): the facts read and the sign
 * route with its { seq, id } memory. In-memory storage with a node key minted by the message store's own provisioning; the
 * signed event is checked independently (NIP-01 id with node:crypto, BIP-340 with @noble/curves) and with the edge's
 * verifyNostrEvent. No network. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { schnorr } from '@noble/curves/secp256k1.js'
import { provisionMessagesIdentity, verifyNostrEvent, MESSAGES_STORAGE_KEY } from '../messages-store.mjs'
import { WITNESS_HEAD_ROUTES, WITNESS_SIGNER_KEY, handleWitnessHeadRoute } from '../witness.mjs'

const SEED = '5'.repeat(64)
const HEAD = { ballId: 'a'.repeat(64), epoch: 80 }

function memoryStorage() {
  let data = new Map(), tail = Promise.resolve()
  const view = rows => ({
    get: async key => Array.isArray(key) ? new Map(key.filter(name => rows.has(name)).map(name => [name, structuredClone(rows.get(name))])) : structuredClone(rows.get(key)),
    put: async (key, value) => { rows.set(key, structuredClone(value)) },
    delete: async key => rows.delete(key),
  })
  const storage = { get: key => view(data).get(key), put: (key, value) => view(data).put(key, value), delete: key => view(data).delete(key) }
  storage.transaction = operation => {
    const result = tail.then(async () => {
      const rows = structuredClone(data)
      const value = await operation(view(rows))
      data = rows
      return value
    })
    tail = result.catch(() => {})
    return result
  }
  return { storage, snapshot: () => structuredClone(data) }
}

/** HEAD's witness routes over one store, as head-do.mjs wires them (after its internal-mark and bootstrap checks). */
function fixture({ identity = true, head = HEAD, receipts = { leafHash: 'b'.repeat(64), rows: 9 } } = {}) {
  const { storage, snapshot } = memoryStorage()
  const clock = { now: 1_794_830_400_000 }
  const mirrorCalls = []
  const env = { WITNESS_SWITCH: 'on', MIRROR: { idFromName: name => name, get: () => ({ fetch: async request => {
    mirrorCalls.push({ path: new URL(request.url).pathname, headers: Object.fromEntries(request.headers) })
    if (receipts === 'fail') return Response.json({ ok: false, code: 'AURA_UNAVAILABLE' }, { status: 503 })
    return Response.json({ ok: true, seedId: SEED, scope: 'nostr-receipts-head', evidence: { status: 'complete', scope: 'nostr-receipts-head' },
      head: { ballId: request.headers.get('x-x6-aura-head'), epoch: Number(request.headers.get('x-x6-aura-epoch')) },
      receiptsLeafHash: receipts.leafHash, receiptRows: receipts.rows, verifiedReceipts: receipts.rows })
  } }) } }
  const route = (path, init = {}) => handleWitnessHeadRoute(new Request('https://x61.internal' + path, { ...init, headers: { 'x-x6-internal-authorized': '1', ...(init.headers ?? {}) } }),
    { url: new URL('https://x61.internal' + path), bootstrap: { seedId: SEED }, storage, env, now: () => clock.now,
      readSelectedHead: async () => { if (head === 'throw') throw new Error('SELECTED_HEAD_INVALID'); return head === null ? null : { ...head, entries: {} } } })
  const sign = async body => {
    const response = await route(WITNESS_HEAD_ROUTES.sign, { method: 'POST', headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) })
    return { status: response.status, body: await response.json() }
  }
  const facts = async () => { const response = await route(WITNESS_HEAD_ROUTES.facts); return { status: response.status, body: await response.json() } }
  return { storage, snapshot, clock, sign, facts, route, mirrorCalls, ready: identity ? provisionMessagesIdentity(storage, { approved: true }) : Promise.resolve(null) }
}

const nip01 = event => createHash('sha256').update(JSON.stringify([0, event.pubkey, event.created_at, event.kind, event.tags, event.content])).digest('hex')
const independentlyValid = event => nip01(event) === event.id && schnorr.verify(Buffer.from(event.sig, 'hex'), Buffer.from(event.id, 'hex'), Buffer.from(event.pubkey, 'hex'))

test('the sign route signs exactly the closed event for seq 1, then only seq n+1 naming the id it returned', async () => {
  const fx = fixture()
  const { pubkey } = await fx.ready
  const first = await fx.sign({ seq: 1, digest: 'd'.repeat(64), prevEventId: null })
  assert.equal(first.status, 200, JSON.stringify(first.body))
  const event = first.body.event
  assert.deepEqual(Object.keys(first.body).sort(), ['event', 'ok'])
  assert.deepEqual(Object.keys(event).sort(), ['content', 'created_at', 'id', 'kind', 'pubkey', 'sig', 'tags'])
  assert.equal(event.pubkey, pubkey)
  assert.equal(event.kind, 4871)
  assert.equal(event.content, '')
  assert.equal(event.created_at, Math.floor(fx.clock.now / 1000))
  assert.deepEqual(event.tags, [['seq', '1'], ['digest', 'd'.repeat(64)], ['chain', 'witness.v1']])
  assert.equal(event.id, nip01(event))
  assert.equal(independentlyValid(event), true)
  assert.equal(await verifyNostrEvent(event), true)
  assert.deepEqual(fx.snapshot().get(WITNESS_SIGNER_KEY), { seq: 1, id: event.id, digest: 'd'.repeat(64), prevEventId: null, event })

  // Not seq 3, not seq 2 naming another id, not seq 1 again with a new digest: no fork at the signer.
  const before = fx.snapshot()
  for (const [body, code] of [
    [{ seq: 3, digest: 'e'.repeat(64), prevEventId: event.id }, 'WITNESS_SIGN_SEQ'],
    [{ seq: 2, digest: 'e'.repeat(64), prevEventId: 'f'.repeat(64) }, 'WITNESS_SIGN_PREV'],
    [{ seq: 1, digest: 'e'.repeat(64), prevEventId: null }, 'WITNESS_SIGN_FORK'],
  ]) {
    const refused = await fx.sign(body)
    assert.equal(refused.status, 409, code)
    assert.deepEqual(refused.body, { ok: false, code })
  }
  assert.deepEqual(fx.snapshot(), before, 'a refusal writes nothing')

  // The same request again answers the same stored event (a lost answer is no deadlock): no new signature.
  fx.clock.now += 5000
  const again = await fx.sign({ seq: 1, digest: 'd'.repeat(64), prevEventId: null })
  assert.deepEqual(again, first)
  assert.deepEqual(fx.snapshot(), before)

  // seq 2 names event 1; its time never runs before event 1's, even when the edge clock steps back.
  fx.clock.now -= 3_600_000
  const second = await fx.sign({ seq: 2, digest: 'e'.repeat(64), prevEventId: event.id })
  assert.equal(second.status, 200)
  assert.deepEqual(second.body.event.tags, [['e', event.id], ['seq', '2'], ['digest', 'e'.repeat(64)], ['chain', 'witness.v1']])
  assert.equal(second.body.event.created_at, event.created_at)
  assert.equal(independentlyValid(second.body.event), true)
  assert.equal(fx.snapshot().get(WITNESS_SIGNER_KEY).seq, 2)
})

test('no node identity: a closed code, nothing written, and never a key minted here', async () => {
  const fx = fixture({ identity: false })
  await fx.ready
  const refused = await fx.sign({ seq: 1, digest: 'd'.repeat(64), prevEventId: null })
  assert.equal(refused.status, 409)
  assert.deepEqual(refused.body, { ok: false, code: 'WITNESS_IDENTITY_REQUIRED' })
  assert.equal(fx.snapshot().has(MESSAGES_STORAGE_KEY), false)
  assert.equal(fx.snapshot().size, 0)
})

test('the sign route takes only { seq, digest, prevEventId } as JSON from an internal caller', async () => {
  const fx = fixture()
  await fx.ready
  const before = fx.snapshot()
  for (const body of [
    { seq: 1, digest: 'd'.repeat(64) },
    { seq: 1, digest: 'd'.repeat(64), prevEventId: null, content: 'hello' },
    { seq: 1, digest: 'd'.repeat(64), prevEventId: null, tags: [['t', 'x']] },
    { seq: 0, digest: 'd'.repeat(64), prevEventId: null },
    { seq: 1.5, digest: 'd'.repeat(64), prevEventId: null },
    { seq: 1, digest: 'D'.repeat(64), prevEventId: null },
    { seq: 2, digest: 'd'.repeat(64), prevEventId: null },
    [1, 'd'.repeat(64), null],
    'not json',
    JSON.stringify({ seq: 1, digest: 'd'.repeat(64), prevEventId: null, pad: 'x'.repeat(2000) }),
  ]) {
    const refused = await fx.sign(body)
    assert.equal(refused.status, 400, JSON.stringify(body).slice(0, 80))
    assert.equal(refused.body.code, 'WITNESS_SIGN_INVALID')
  }
  const get = await fx.route(WITNESS_HEAD_ROUTES.sign)
  assert.equal(get.status, 405)
  const query = await fx.route(WITNESS_HEAD_ROUTES.sign + '?seq=1', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
  assert.equal(query.status, 404)
  const outside = await handleWitnessHeadRoute(new Request('https://x61.internal' + WITNESS_HEAD_ROUTES.sign, { method: 'POST', body: '{}' }),
    { url: new URL('https://x61.internal' + WITNESS_HEAD_ROUTES.sign), bootstrap: { seedId: SEED }, storage: fx.storage, env: {}, readSelectedHead: async () => null })
  assert.equal(outside.status, 401)
  assert.deepEqual(fx.snapshot(), before)
})

test('the facts read: the selected head, the mirror-verified receipts head (the anchor\'s own read) and the node pubkey', async () => {
  const fx = fixture()
  const { pubkey } = await fx.ready
  const { status, body } = await fx.facts()
  assert.equal(status, 200)
  assert.deepEqual(body, { ok: true, seedId: SEED, pubkey, head: HEAD, receipts: { leafHash: 'b'.repeat(64), rows: 9 }, reasons: {} })
  assert.deepEqual(fx.mirrorCalls.map(call => [call.path, call.headers['x-x6-aura-receipts-head'], call.headers['x-x6-aura-head']]), [['/_mirror/aura-inputs', '1', HEAD.ballId]])
  assert.equal((await fx.route(WITNESS_HEAD_ROUTES.facts + '?x=1')).status, 404)
  assert.equal((await fx.route(WITNESS_HEAD_ROUTES.facts, { method: 'POST', body: '{}' })).status, 405)
})

test('a fact HEAD cannot read is null with its reason; the read itself still answers', async () => {
  for (const [options, expected] of [
    [{ head: null }, { head: null, receipts: null, reasons: { head: 'head-none', receipts: 'receipts-unavailable' } }],
    [{ head: 'throw' }, { head: null, receipts: null, reasons: { head: 'head-unavailable', receipts: 'receipts-unavailable' } }],
    [{ receipts: 'fail' }, { head: HEAD, receipts: null, reasons: { receipts: 'receipts-unavailable' } }],
  ]) {
    const fx = fixture(options)
    await fx.ready
    const { status, body } = await fx.facts()
    assert.equal(status, 200)
    assert.deepEqual({ head: body.head, receipts: body.receipts, reasons: body.reasons }, expected)
  }
  const fx = fixture({ identity: false })
  await fx.ready
  assert.equal((await fx.facts()).body.pubkey, null)
})
