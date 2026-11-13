/** Her signed head announcement. Real Worker, HEAD and Mirror objects over in-memory storage; the
 * passkey store is a single-use, exact-binding fake (as in outward-dedupe). Synthetic keys and receipts only; no
 * network. The published event is checked independently: the NIP-01 id with node:crypto, the BIP-340 signature with the
 * @noble/curves library directly, never with the edge's own helper. This is not a relay test: there is no relay. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { schnorr } from '@noble/curves/secp256k1.js'
import { createWorker, createIsolateShield, ISOLATE_SHIELD } from '../worker.mjs'
import { MirrorDO } from '../mirror-do.mjs'
import { X61HeadDurableObject, BOOTSTRAP_VERSION, canonicalBootstrap, digest, manifestIdCanon } from '../head-do.mjs'
import { aumlokClass3Binding } from '../aumlok.mjs'
import { canonicalJson } from '../owner-grant-policy.mjs'
import { MESSAGES_STORAGE_KEY } from '../messages-store.mjs'
import { NOSTR_ANCHOR_KEY, NOSTR_ANCHOR_ROUTE, NOSTR_HEAD_ROUTE, NOSTR_NIP05_ROUTE,
  anchorContent, anchorTags, createNostrReadDoor, parseAnchorEvent } from '../nostr-anchor.mjs'

const ORIGIN = 'https://nostr-anchor.example.invalid'
const OWNER = 'owner@example.invalid'
const NIP05 = NOSTR_NIP05_ROUTE + '?name=auma'
const ORGAN_PATH = new URL('../../../../mirror/home/balls/70a63fb5864143fd5be7c4b9d151e58e303478cc88911e297504884e383451a9.js', import.meta.url)
const RECEIPTS_PATH = '/dsh/home/auma/seed/receipts.v3.jsonl'
const sha256 = text => createHash('sha256').update(text).digest('hex')

/** The mounted organ seed-nostr-anchor, loaded as the page loads it: CommonJS, zero imports, pure. */
function organ() {
  const module = { exports: {} }
  runInNewContext(readFileSync(ORGAN_PATH, 'utf8'), { module, exports: module.exports })
  // Results cross back from the organ's own realm as plain JSON values.
  const plain = run => (...args) => JSON.parse(JSON.stringify(run(...args)))
  return { checkpointTags: plain(module.exports.checkpointTags), checkpointVerify: plain(module.exports.checkpointVerify) }
}

/** A receipts.v3 chain by the mirror's rule: leafHash = sha256(0x00 || canonicalJson(row without leafHash)). */
function receiptsText(count, { pad = 0 } = {}) {
  let previous = '0'.repeat(64), text = ''
  for (let seq = 1; seq <= count; seq++) {
    const row = { schema: 'aukora.receipt.v3', seq, at: `2026-11-12T00:00:0${seq}.000Z`, kind: seq === count ? 'head.promote' : 'head.stage',
      data: pad ? { epoch: 1, note: 'n'.repeat(pad) } : { epoch: 1 }, prevHash: previous }
    row.leafHash = sha256('\0' + canonicalJson(row))
    previous = row.leafHash
    text += JSON.stringify(row) + '\n'
  }
  return { text, leaf: previous }
}

function memoryStorage() {
  let data = new Map(), alarm = null, tail = Promise.resolve()
  const view = (rows, timer) => ({
    get: async key => structuredClone(rows.get(key)), put: async (key, value) => { rows.set(key, structuredClone(value)) },
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

/** Test-local canonical JSON (keys sorted at every depth), written apart from the edge's own canonicalJson. */
const sortedJson = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(name => [name, item[name]])) : item)

/** The receipts head recomputed here from the journal text alone: every link and hash, then the last leaf and the row count.
 * A row's claimed hash is `leafHash` (or, in the older spelling the mirror also reads, `hash`), and the payload is the row
 * without that one field. */
function independentReceiptsHead(text) {
  let previous = '0'.repeat(64), rows = 0
  for (const line of text.split('\n').filter(Boolean)) {
    const row = JSON.parse(line)
    const field = row.leafHash === undefined ? 'hash' : 'leafHash'
    const { [field]: claimed, ...payload } = row
    assert.equal(row.prevHash, previous)
    assert.equal(sha256('\0' + sortedJson(payload)), claimed)
    previous = claimed
    rows++
  }
  return { leafHash: previous, rows }
}

/** The home as this repository holds it (mirror/home/auma: the genesis seed and synthetic files): its HANDOFF.md, receipts
 * chain, memory DAG, discovery corpus and superagent state, with `receiptsText` standing in for the journal when given.
 * Nothing here may rest on what her ordinary work changes (a file's size, the row count, the last leaf, an epoch): each
 * value is read from her files and recomputed here, and a condition a test needs is built in the test's own store. */
const REPO_HOME = new URL('../../../../mirror/home/auma/', import.meta.url)
const repoText = path => readFileSync(new URL(path, REPO_HOME), 'utf8')
function realReceipts(text = repoText('seed/receipts.v3.jsonl')) {
  const last = JSON.parse(text.trimEnd().split('\n').at(-1))
  return { text, leaf: last.leafHash ?? last.hash }
}
/** The mirror's hand-off cap: AURA_EDGE_LIMITS.nodeBytes in mirror-do.mjs (not exported). The padded-home test below
 * proves the relation itself: its padded store must be refused by the full Aura answer with AURA_BYTE_LIMIT. */
const MIRROR_HANDOFF_CAP = 64 * 1024
/** THE FROZEN HOME: a SYNTHETIC home committed beside this test (hand-off table, a 158-row receipts chain built by the
 * mirror's rule, an empty corpus and an empty superagent state), pinned here by SHA-256. It belongs to no real node. */
const FROZEN_HOME = new URL('./fixtures/nostr-anchor-home/', import.meta.url)
const FROZEN_SHA256 = Object.freeze({
  'HANDOFF.md': 'a98e4fee93fc3c65f8cc39e283d970dcdbd070a0198fefe83d8c25fde5dbc465',
  'seed/receipts.v3.jsonl': '18aea03b30a622d57373d1d0f19ffa6810ac716dc7a31a3449d3027e6f1f9958',
  'seed/discovery-corpus.v1.jsonl': 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  'superagent/state.json': 'c0f32450e4e3cc5ccc0b84f1229315c66faba02929f7ec612e12846f2d928d15',
})
const frozenText = path => {
  const text = readFileSync(new URL(path, FROZEN_HOME), 'utf8')
  assert.equal(sha256(text), FROZEN_SHA256[path], `the frozen fixture ${path} is the committed bytes`)
  return text
}
const frozenReceipts = (text = frozenText('seed/receipts.v3.jsonl')) => realReceipts(text)
function frozenHome(file, receipts, { handoff = frozenText('HANDOFF.md') } = {}) {
  const dir = { kind: 'dir', mode: 0o700 }
  return [['/dsh/home/auma', dir], ['/dsh/home/auma/HANDOFF.md', file(handoff)],
    ['/dsh/home/auma/memory', dir], ['/dsh/home/auma/memory/dag', dir],
    ['/dsh/home/auma/memory/dag/HEAD.json', file(JSON.stringify({ heads: [], count: 0 }))],
    ['/dsh/home/auma/seed', dir], ['/dsh/home/auma/seed/discovery-corpus.v1.jsonl', file(frozenText('seed/discovery-corpus.v1.jsonl'))],
    [RECEIPTS_PATH, file(receipts.text)],
    ['/dsh/home/auma/superagent', dir], ['/dsh/home/auma/superagent/state.json', file(frozenText('superagent/state.json'))]]
}

/** The scoped receipts head's ceiling: AURA_EDGE_LIMITS in mirror-do.mjs (not exported): rows 2048, the whole 4 MiB budget,
 * nodeBytes 64 KiB a row. The ceiling test below proves the row figure on the real code: 2,048 rows publish, 2,049 refuse. */
const SCOPED_CEILING = Object.freeze({ rows: 2048, bytes: 4 * 1024 * 1024, rowBytes: 64 * 1024 })
/** A journal's size against that ceiling: its rows, bytes and widest row. */
function journalSize(text) {
  const lines = text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n')
  const rows = text === '' ? 0 : lines.length
  return { rows, bytes: Buffer.byteLength(text), widest: Math.max(0, ...lines.map(line => Buffer.byteLength(line))) }
}
const overCeiling = ({ rows, bytes, widest }) => rows > SCOPED_CEILING.rows || bytes > SCOPED_CEILING.bytes || widest > SCOPED_CEILING.rowBytes

async function stack(t, { receipts = receiptsText(3), home } = {}) {
  const clock = { now: Date.now() }
  const hs = memoryStorage(), ms = memoryStorage(), headCalls = [], mirrorCalls = []
  const access = { type: 'owner', email: OWNER, expires: Math.floor(Date.now() / 1000) + 3600 }
  const session = { identity: access }
  const env = { PUBLIC_HOST: new URL(ORIGIN).host, ACCESS_TEAM: 'fixture.cloudflareaccess.com', ACCESS_AUD: 'fixture', OWNER_EMAIL: OWNER }
  const head = new X61HeadDurableObject({ storage: hs.storage, getWebSockets: () => [] }, env)
  t.after(() => head.wakeStore.dispose())
  const mirror = new MirrorDO({ storage: ms.storage }, env)
  // The owner's passkey, as the HEAD sees it: an approval is single use and binds one exact {method, pathname, body}.
  const approvals = new Map()
  head.aumlokStore = {
    consumeApprovalInTransaction: async (tx, token, binding, origin) => {
      const refuse = () => { throw Object.assign(new Error('CLASS3_WEBAUTHN_REQUIRED'), { code: 'CLASS3_WEBAUTHN_REQUIRED', status: 403 }) }
      if (origin !== ORIGIN || !approvals.has(token) || canonicalJson(approvals.get(token)) !== canonicalJson(binding) || await tx.get('fixture-approval-used:' + token)) refuse()
      await tx.put('fixture-approval-used:' + token, true)
      return { ok: true, binding, approvalId: 'fixture', expiresAt: Date.now() + 120000 }
    },
  }
  const approve = async (token, pathname, body) => approvals.set(token, await aumlokClass3Binding({ audience: ORIGIN, method: 'POST', pathname, body }))
  env.HEAD = { idFromName: name => name, get: () => ({ fetch: request => { headCalls.push(new URL(request.url).pathname); return head.fetch(request) } }) }
  env.MIRROR = { idFromName: name => name, get: () => ({ fetch: request => { mirrorCalls.push(new URL(request.url).pathname); return mirror.fetch(request) } }) }
  const worker = createWorker({ verifyAccess: async () => session.identity, now: () => clock.now, networkFetch: () => assert.fail('No live network') })
  const call = (path, { method = 'GET', body, headers = {}, signedOut = false } = {}) => worker.fetch(new Request(ORIGIN + path, { method,
    headers: { ...(signedOut ? { 'cf-connecting-ip': '198.51.100.7' } : { origin: ORIGIN, 'sec-fetch-site': 'same-origin' }),
      ...(method === 'POST' ? { 'content-type': 'application/json' } : {}), ...headers },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) }), env)
  const code = 'export const fixture = true;\n', moduleSha = await digest(code)
  const draft = { version: 'x6.1-ball/v1', epoch: 4, parentBallId: null, createdAt: '2026-11-12T00:00:00.000Z', authorPeerId: 'fixture-peer',
    entries: { fixture: { id: 'fixture', specifier: `ball:${moduleSha}`, disabled: false, config: {}, previousSpecifiers: [] } },
    modules: { [moduleSha]: { sha256: moduleSha, specifier: `ball:${moduleSha}`, size: Buffer.byteLength(code) } } }
  const ball = { ...draft, ballId: await manifestIdCanon(draft) }
  // The mirror's Aura evidence set (it verifies the receipts chain there): hand-off, an empty memory DAG, no discoveries, no assignments.
  const file = text => ({ kind: 'file', mode: 0o600, mtimeMs: 1, b64: Buffer.from(text).toString('base64') })
  const entries = home ? home(file, receipts) : [['/dsh/home/auma', { kind: 'dir', mode: 0o700 }],
    ['/dsh/home/auma/HANDOFF.md', file(`| epoch | **${ball.epoch}** |\n| ballId | \`${ball.ballId}\` |\n`)],
    ['/dsh/home/auma/memory', { kind: 'dir', mode: 0o700 }], ['/dsh/home/auma/memory/dag', { kind: 'dir', mode: 0o700 }],
    ['/dsh/home/auma/memory/dag/HEAD.json', file(JSON.stringify({ heads: [], count: 0 }))],
    ['/dsh/home/auma/seed', { kind: 'dir', mode: 0o700 }], ['/dsh/home/auma/seed/discovery-corpus.v1.jsonl', file('')],
    [RECEIPTS_PATH, file(receipts.text)],
    ['/dsh/home/auma/superagent', { kind: 'dir', mode: 0o700 }], ['/dsh/home/auma/superagent/state.json', file(JSON.stringify({ assignments: [] }))]]
  const payload = { version: BOOTSTRAP_VERSION, ball, codeBySha: { [moduleSha]: code }, mirror: { entryCount: entries.length, batchDigests: [await digest(canonicalBootstrap(entries))] } }
  const prepared = await call('/_bootstrap', { method: 'POST', body: { action: 'prepare', package: payload } })
  assert.equal(prepared.status, 200, await prepared.clone().text())
  const { seedId } = await prepared.json()
  const batched = await call('/_bootstrap', { method: 'POST', body: { action: 'batch', seedId, index: 0, entries } })
  assert.equal(batched.status, 200, await batched.clone().text())
  assert.equal((await call('/_bootstrap', { method: 'POST', body: { action: 'commit', seedId } })).status, 200)
  const provision = async token => {
    const headers = token ? { 'x-x6-class3-approval': token } : {}
    const response = await call('/_head/transcript', { method: 'POST', body: { action: 'nostr_provision' }, headers })
    return { response, body: await response.json() }
  }
  // Exactly what the page sends: the organ's own unsigned event for the live head, receipts head and node key.
  const unsigned = ({ headBallId = ball.ballId, epoch = ball.epoch, receiptsLeafHash = receipts.leaf, nodePubkeyHex, createdAt = Math.floor(Date.now() / 1000) }) => {
    const built = organ().checkpointTags({ headBallId, epoch, receiptsLeafHash, nodePubkeyHex, createdAt })
    assert.equal(built.ok, true)
    return { pubkey: nodePubkeyHex, created_at: built.created_at, kind: built.kind, tags: built.tags, content: built.content }
  }
  const publish = async (body, token) => {
    const response = await call(NOSTR_ANCHOR_ROUTE, { method: 'POST', body, headers: token ? { 'x-x6-class3-approval': token } : {} })
    return { response, body: await response.json() }
  }
  // What HEAD itself asks the mirror for its Aura evidence; the facts answer carries the receipts head.
  const auraFacts = async () => (await mirror.fetch(new Request('https://x61.internal/_mirror/aura-inputs', { headers: {
    'x-x6-internal-authorized': '1', 'x-x6-bootstrap-seed': seedId, 'x-x6-aura-head': ball.ballId, 'x-x6-aura-epoch': String(ball.epoch),
    'x-x6-aura-now': String(Date.now()) } }))).json()
  // What the anchor asks the mirror: the receipts head alone (the NOSTR hook's scoped answer).
  const receiptsHeadFacts = async () => (await mirror.fetch(new Request('https://x61.internal/_mirror/aura-inputs', { headers: {
    'x-x6-internal-authorized': '1', 'x-x6-bootstrap-seed': seedId, 'x-x6-aura-head': ball.ballId, 'x-x6-aura-epoch': String(ball.epoch),
    'x-x6-aura-now': String(Date.now()), 'x-x6-aura-receipts-head': '1' } }))).json()
  return { clock, hs, ms, head, env, worker, call, approve, provision, unsigned, publish, ball, receipts, session, access, headCalls, mirrorCalls, auraFacts, receiptsHeadFacts, seedId }
}

/** Independent of the edge: NIP-01 id with node:crypto, BIP-340 with @noble/curves' schnorr.verify. */
function independentlyValid(event) {
  const id = sha256(JSON.stringify([0, event.pubkey, event.created_at, event.kind, event.tags, event.content]))
  if (id !== event.id) return false
  try { return schnorr.verify(Buffer.from(event.sig, 'hex'), Buffer.from(id, 'hex'), Buffer.from(event.pubkey, 'hex')) } catch { return false }
}

test('minting her Nostr key needs a passkey approval of that exact request; an existing key answers as before', async t => {
  const fx = await stack(t)
  const before = fx.hs.snapshot()
  const missing = await fx.provision()
  assert.equal(missing.response.status, 403)
  assert.equal(missing.body.code, 'CLASS3_WEBAUTHN_REQUIRED')
  assert.deepEqual(fx.hs.snapshot(), before, 'a refused mint writes nothing')
  await fx.approve('other-body', '/_head/transcript', { action: 'nostr_status' })
  await fx.approve('other-path', NOSTR_ANCHOR_ROUTE, { action: 'nostr_provision' })
  for (const token of ['other-body', 'other-path', 'never-approved']) {
    const refused = await fx.provision(token)
    assert.equal(refused.response.status, 403, token)
    assert.deepEqual(fx.hs.snapshot(), before, token)
  }
  await fx.approve('mint', '/_head/transcript', { action: 'nostr_provision' })
  const minted = await fx.provision('mint')
  assert.equal(minted.response.status, 200, JSON.stringify(minted.body))
  assert.match(minted.body.identity.pubkey, /^[0-9a-f]{64}$/)
  assert.match(minted.body.identity.npub, /^npub1/)
  const secret = fx.hs.snapshot().get(MESSAGES_STORAGE_KEY).identity.secretKey
  assert.equal(JSON.stringify(minted.body).includes(secret), false, 'the secret key never leaves')
  const afterMint = fx.hs.snapshot()
  assert.equal(afterMint.get('fixture-approval-used:mint'), true)
  const again = await fx.provision()
  assert.equal(again.response.status, 200)
  assert.deepEqual(again.body.identity, minted.body.identity, 'the provisioned node keeps its key')
  assert.deepEqual(fx.hs.snapshot(), afterMint, 'no write and no approval consumed once a key exists')
})

test('a published announcement is the organ event signed by the node key, and checks with independent tools', async t => {
  const fx = await stack(t)
  await fx.approve('mint', '/_head/transcript', { action: 'nostr_provision' })
  const { identity } = (await fx.provision('mint')).body
  const body = fx.unsigned({ nodePubkeyHex: identity.pubkey })
  await fx.approve('publish', NOSTR_ANCHOR_ROUTE, body)
  const before = fx.hs.snapshot()
  const published = await fx.publish(body, 'publish')
  assert.equal(published.response.status, 200, JSON.stringify(published.body))
  const event = published.body.event
  assert.deepEqual(Object.keys(event), ['id', 'pubkey', 'created_at', 'kind', 'tags', 'content', 'sig'])
  assert.deepEqual({ pubkey: event.pubkey, created_at: event.created_at, kind: event.kind, tags: event.tags, content: event.content }, body)
  assert.equal(event.kind, 30078)
  assert.equal(independentlyValid(event), true)
  assert.equal(organ().checkpointVerify(event).ok, true, 'the organ accepts what the edge signed')
  // One byte changed anywhere fails.
  assert.equal(independentlyValid({ ...event, content: event.content.replace('"epoch":4', '"epoch":5') }), false)
  assert.equal(independentlyValid({ ...event, sig: (event.sig[0] === '0' ? '1' : '0') + event.sig.slice(1) }), false)
  assert.equal(independentlyValid({ ...event, created_at: event.created_at + 1 }), false)
  // Exactly one new stored announcement and the one consumed approval; nothing else changed.
  const after = fx.hs.snapshot()
  assert.deepEqual([...after.keys()].filter(key => !before.has(key)).sort(), ['fixture-approval-used:publish', NOSTR_ANCHOR_KEY])
  assert.deepEqual(after.get(NOSTR_ANCHOR_KEY), event)
  // A replayed approval is refused.
  const replay = await fx.publish(body, 'publish')
  assert.equal(replay.response.status, 403)
  assert.deepEqual(fx.hs.snapshot(), after)
  // The signed-out reads, after the in-isolate cache from any earlier read has run out.
  fx.clock.now += 61000
  const read = await fx.call(NOSTR_HEAD_ROUTE, { signedOut: true })
  assert.equal(read.status, 200)
  assert.equal(read.headers.get('access-control-allow-origin'), '*')
  assert.equal(read.headers.get('cache-control'), 'public, max-age=60')
  const text = await read.text()
  assert.deepEqual(JSON.parse(text), event)
  const secret = after.get(MESSAGES_STORAGE_KEY).identity.secretKey
  for (const hidden of [secret, 'secretKey', 'Auma Pearl', 'marmot', 'publish', 'fixture-approval', 'approval', 'leafHash', 'head.promote', 'fixture']) {
    assert.equal(text.includes(hidden), false, hidden)
  }
  const nip05 = await fx.call(NIP05, { signedOut: true })
  assert.equal(nip05.status, 200)
  assert.equal(nip05.headers.get('access-control-allow-origin'), '*')
  assert.deepEqual(await nip05.json(), { names: { auma: event.pubkey } }, 'NIP-05 names the same key that signed the event')
})

test('every mismatch refuses, consumes no approval and writes nothing', async t => {
  const fx = await stack(t)
  await fx.approve('mint', '/_head/transcript', { action: 'nostr_provision' })
  const { identity } = (await fx.provision('mint')).body
  const good = fx.unsigned({ nodePubkeyHex: identity.pubkey })
  const otherKey = Buffer.from(schnorr.getPublicKey(schnorr.utils.randomSecretKey())).toString('hex')
  const reordered = { ...good, content: JSON.stringify({ schema: 'aukora.nostr.head.v1', headBallId: fx.ball.ballId, epoch: fx.ball.epoch, receiptsLeafHash: fx.receipts.leaf, nodePubkeyHex: identity.pubkey }) }
  const cases = {
    'head id': [fx.unsigned({ nodePubkeyHex: identity.pubkey, headBallId: 'e'.repeat(64) }), 409, 'NOSTR_ANCHOR_HEAD_MISMATCH'],
    epoch: [fx.unsigned({ nodePubkeyHex: identity.pubkey, epoch: fx.ball.epoch + 1 }), 409, 'NOSTR_ANCHOR_HEAD_MISMATCH'],
    pubkey: [fx.unsigned({ nodePubkeyHex: otherKey }), 409, 'NOSTR_ANCHOR_PUBKEY_MISMATCH'],
    'receipts leaf': [fx.unsigned({ nodePubkeyHex: identity.pubkey, receiptsLeafHash: 'f'.repeat(64) }), 409, 'NOSTR_ANCHOR_RECEIPTS_MISMATCH'],
    'tag against content': [{ ...good, tags: good.tags.map(tag => tag[0] === 'epoch' ? ['epoch', String(fx.ball.epoch + 1)] : tag) }, 409, 'NOSTR_ANCHOR_TAGS_MISMATCH'],
    'missing tag': [{ ...good, tags: good.tags.slice(0, 4) }, 409, 'NOSTR_ANCHOR_TAGS_MISMATCH'],
    'pubkey against content': [{ ...good, pubkey: otherKey }, 409, 'NOSTR_ANCHOR_PUBKEY_MISMATCH'],
    'non-canonical content': [reordered, 400, 'NOSTR_ANCHOR_CONTENT_NOT_CANONICAL'],
    'clock ahead': [fx.unsigned({ nodePubkeyHex: identity.pubkey, createdAt: Math.floor(Date.now() / 1000) + 700 }), 409, 'NOSTR_ANCHOR_CLOCK_SKEW'],
    'clock behind': [fx.unsigned({ nodePubkeyHex: identity.pubkey, createdAt: Math.floor(Date.now() / 1000) - 700 }), 409, 'NOSTR_ANCHOR_CLOCK_SKEW'],
    kind: [{ ...good, kind: 1 }, 400, 'NOSTR_ANCHOR_KIND_INVALID'],
    'extra field': [{ ...good, id: 'a'.repeat(64) }, 400, 'NOSTR_ANCHOR_EVENT_INVALID'],
  }
  const before = fx.hs.snapshot()
  for (const [name, [body, status, code]] of Object.entries(cases)) {
    await fx.approve(name, NOSTR_ANCHOR_ROUTE, body)
    const refused = await fx.publish(body, name)
    assert.equal(refused.response.status, status, name + ' ' + JSON.stringify(refused.body))
    assert.equal(refused.body.code, code, name)
    assert.deepEqual(fx.hs.snapshot(), before, name + ': nothing written, approval not consumed')
  }
  const unapproved = await fx.publish(good)
  assert.equal(unapproved.response.status, 403)
  await fx.approve('wrong-body', NOSTR_ANCHOR_ROUTE, cases.epoch[0])
  assert.equal((await fx.publish(good, 'wrong-body')).response.status, 403, 'an approval binds one exact body')
  assert.deepEqual(fx.hs.snapshot(), before)
  fx.session.identity = { ...fx.access, type: 'access' }
  assert.equal((await fx.call(NOSTR_ANCHOR_ROUTE, { method: 'POST', body: good })).status, 403, 'owner session only')
  fx.session.identity = null
  assert.equal((await fx.call(NOSTR_ANCHOR_ROUTE, { method: 'POST', body: good })).status, 401, 'never signed out')
  fx.session.identity = fx.access
  assert.equal((await fx.call(NOSTR_ANCHOR_ROUTE, { method: 'POST', body: good, headers: { 'sec-fetch-site': 'cross-site' } })).status, 403)
  assert.equal((await fx.call(NOSTR_ANCHOR_ROUTE + '?x=1', { method: 'POST', body: good })).status, 404)
  assert.equal((await fx.call(NOSTR_ANCHOR_ROUTE, { method: 'PUT', body: good })).status, 405)
  assert.deepEqual(fx.hs.snapshot(), before)
})

test('no announcement exists before her key is minted, and none is served before a first publication', async t => {
  const fx = await stack(t)
  const body = fx.unsigned({ nodePubkeyHex: 'a'.repeat(64) })
  await fx.approve('early', NOSTR_ANCHOR_ROUTE, body)
  const before = fx.hs.snapshot()
  const refused = await fx.publish(body, 'early')
  assert.equal(refused.response.status, 409)
  assert.equal(refused.body.code, 'NOSTR_ANCHOR_IDENTITY_REQUIRED')
  assert.deepEqual(fx.hs.snapshot(), before)
  for (const path of [NOSTR_HEAD_ROUTE, NIP05]) {
    const response = await fx.call(path, { signedOut: true })
    assert.equal(response.status, 404)
    assert.deepEqual(await response.json(), { ok: false, code: 'NOSTR_ANCHOR_UNPUBLISHED' })
  }
})

test('a signed-out flood costs at most one HEAD read per isolate per minute', async t => {
  const fx = await stack(t)
  const reads = () => fx.headCalls.filter(path => path === '/_head/nostr/latest').length
  const flood = async count => Promise.all(Array.from({ length: count }, (_, index) => fx.worker.fetch(new Request(ORIGIN + (index % 2 ? NIP05 : NOSTR_HEAD_ROUTE),
    { headers: { 'cf-connecting-ip': `203.0.113.${index % 250}` } }), fx.env)))
  const first = await flood(200)
  assert.ok(first.every(response => response.status === 404))
  assert.equal(reads(), 1, 'a concurrent burst shares one read')
  fx.clock.now += 59000
  assert.ok((await flood(200)).every(response => response.status === 404))
  assert.equal(reads(), 1, 'within the minute every answer comes from the isolate')
  // Publication is not visible to this isolate until its cached answer ends (at most 60 s); then exactly one more read.
  await fx.approve('mint', '/_head/transcript', { action: 'nostr_provision' })
  const { identity } = (await fx.provision('mint')).body
  const body = fx.unsigned({ nodePubkeyHex: identity.pubkey })
  await fx.approve('publish', NOSTR_ANCHOR_ROUTE, body)
  assert.equal((await fx.publish(body, 'publish')).response.status, 200)
  fx.clock.now += 2000
  const later = await flood(200)
  assert.ok(later.every(response => response.status === 200))
  assert.equal(reads(), 2)
  // Refusals never reach HEAD.
  const calls = fx.headCalls.length
  for (const [path, method, status] of [[NOSTR_HEAD_ROUTE + '?x=1', 'GET', 404], [NOSTR_HEAD_ROUTE + '?', 'GET', 404], [NOSTR_HEAD_ROUTE, 'POST', 405],
    [NOSTR_HEAD_ROUTE, 'PUT', 405], [NOSTR_HEAD_ROUTE, 'HEAD', 405], [NOSTR_NIP05_ROUTE, 'GET', 404], [NOSTR_NIP05_ROUTE + '?name=bob', 'GET', 404],
    [NOSTR_NIP05_ROUTE + '?name=auma&x=1', 'GET', 404], [NOSTR_NIP05_ROUTE + '?name=AUMA', 'GET', 404], [NIP05, 'POST', 405]]) {
    const response = await fx.worker.fetch(new Request(ORIGIN + path, { method, ...(method === 'POST' || method === 'PUT' ? { body: '{}' } : {}) }), fx.env)
    assert.equal(response.status, status, method + ' ' + path)
  }
  const withLength = await fx.worker.fetch(new Request(ORIGIN + NOSTR_HEAD_ROUTE, { headers: { 'content-length': '5' } }), fx.env)
  assert.equal(withLength.status, 400)
  assert.equal(fx.headCalls.length, calls)
})

test('a stored announcement that no longer verifies is never served', async t => {
  const fx = await stack(t)
  await fx.approve('mint', '/_head/transcript', { action: 'nostr_provision' })
  const { identity } = (await fx.provision('mint')).body
  const body = fx.unsigned({ nodePubkeyHex: identity.pubkey })
  await fx.approve('publish', NOSTR_ANCHOR_ROUTE, body)
  const { event } = (await fx.publish(body, 'publish')).body
  await fx.hs.storage.put(NOSTR_ANCHOR_KEY, { ...event, content: event.content.replace('"epoch":4', '"epoch":9'), tags: event.tags.map(tag => tag[0] === 'epoch' ? ['epoch', '9'] : tag) })
  const response = await fx.call(NOSTR_HEAD_ROUTE, { signedOut: true })
  assert.equal(response.status, 503)
  assert.equal((await response.text()).includes('"epoch":9'), false)
})

test('the read door shields one network on cache misses and never refuses a cached answer', async () => {
  let at = 0, reads = 0
  const door = createNostrReadDoor({ now: () => at, cacheMs: 0, shield: createIsolateShield(ISOLATE_SHIELD.guest), subjectOf: () => 'one-network' })
  const url = new URL(ORIGIN + NOSTR_HEAD_ROUTE)
  const statuses = []
  for (let index = 0; index < ISOLATE_SHIELD.guest.limit + 1; index++) {
    statuses.push((await door.serve(new Request(url), url, async () => { reads++; return { ok: true, event: null } })).status)
  }
  assert.deepEqual(statuses, [...Array(ISOLATE_SHIELD.guest.limit).fill(404), 429])
  assert.equal(reads, ISOLATE_SHIELD.guest.limit)
  at += ISOLATE_SHIELD.guest.windowMs
  assert.equal((await door.serve(new Request(url), url, async () => ({ ok: true, event: null }))).status, 404)
  const unavailable = createNostrReadDoor({ now: () => at, shield: createIsolateShield(ISOLATE_SHIELD.guest), subjectOf: () => 'x' })
  assert.equal((await unavailable.serve(new Request(url), url, async () => { throw new Error('down') })).status, 503)
  assert.equal((await unavailable.serve(new Request(url), url, async () => assert.fail('cached for the minute'))).status, 503)
  const forged = createNostrReadDoor({ now: () => at, shield: createIsolateShield(ISOLATE_SHIELD.guest), subjectOf: () => 'y' })
  const fake = { id: 'a'.repeat(64), pubkey: 'b'.repeat(64), created_at: 1, kind: 30078, tags: [], content: '{}', sig: 'c'.repeat(128) }
  assert.equal((await forged.serve(new Request(url), url, async () => ({ ok: true, event: fake }))).status, 503, 'HEAD answers are checked, not trusted')
})

test('the edge builds exactly the organ content and tags, and refuses what the organ would refuse', () => {
  const fields = { headBallId: '1'.repeat(64), epoch: 170, receiptsLeafHash: '2'.repeat(64), nodePubkeyHex: '3'.repeat(64) }
  const built = organ().checkpointTags({ ...fields, createdAt: 1794367000 })
  assert.equal(anchorContent(fields), built.content)
  assert.deepEqual(anchorTags(fields), built.tags)
  const event = { pubkey: fields.nodePubkeyHex, created_at: 1794367000, kind: built.kind, tags: built.tags, content: built.content }
  assert.deepEqual(parseAnchorEvent(event), { ...fields, created_at: 1794367000 })
  const swapped = { ...event, tags: built.tags.map(tag => tag[0] === 'head' ? ['head', '4'.repeat(64)] : tag) }
  assert.equal(organ().checkpointVerify(swapped).ok, false)
  assert.throws(() => parseAnchorEvent(swapped), { code: 'NOSTR_ANCHOR_TAGS_MISMATCH' })
})

// The first test above already covers this through the Worker; this one also asks HEAD directly, as any forwarded
// owner request would reach it, so the refusal does not rest on the page or on the Worker.
test('minting her key without the passkey header refuses with CLASS3_WEBAUTHN_REQUIRED, with no page involved', async t => {
  const fx = await stack(t)
  const before = fx.hs.snapshot()
  const viaWorker = await fx.call('/_head/transcript', { method: 'POST', body: { action: 'nostr_provision' } })
  const direct = await fx.head.fetch(new Request(ORIGIN + '/_head/transcript', { method: 'POST', body: JSON.stringify({ action: 'nostr_provision' }), headers: {
    'content-type': 'application/json', 'x-x6-internal-authorized': '1', 'x-x6-bootstrap-seed': fx.seedId,
    'x-x6-verified-access': JSON.stringify({ type: 'owner', email: OWNER, expires: fx.access.expires }) } }))
  for (const [name, response] of [['worker', viaWorker], ['head', direct]]) {
    assert.equal(response.status, 403, name)
    assert.equal((await response.json()).code, 'CLASS3_WEBAUTHN_REQUIRED', name)
  }
  assert.equal(fx.hs.snapshot().has(MESSAGES_STORAGE_KEY), false, 'no key minted')
  assert.deepEqual(fx.hs.snapshot(), before, 'nothing written')
})

test('a 600 KiB journal with a valid chain publishes, checked on the mirror\'s verified head, never by reading the journal', async t => {
  const receipts = receiptsText(300, { pad: 2000 })
  assert.ok(Buffer.byteLength(receipts.text) >= 600 * 1024, String(Buffer.byteLength(receipts.text)))
  const fx = await stack(t, { receipts })
  await fx.approve('mint', '/_head/transcript', { action: 'nostr_provision' })
  const { identity } = (await fx.provision('mint')).body
  const body = fx.unsigned({ nodePubkeyHex: identity.pubkey })
  await fx.approve('publish', NOSTR_ANCHOR_ROUTE, body)
  fx.mirrorCalls.length = 0
  const published = await fx.publish(body, 'publish')
  assert.equal(published.response.status, 200, JSON.stringify(published.body))
  assert.equal(independentlyValid(published.body.event), true)
  assert.equal(JSON.parse(published.body.event.content).receiptsLeafHash, independentReceiptsHead(receipts.text).leafHash)
  // The Worker's own bootstrap check aside, the anchor asks the mirror once, for its evidence; the journal bytes never cross to HEAD.
  assert.deepEqual(fx.mirrorCalls.filter(path => path !== '/_mirror/bootstrap-status'), ['/_mirror/aura-inputs'])
})

test('a chain the mirror cannot verify refuses, consumes no approval and writes nothing', async t => {
  const good = receiptsText(5)
  const lines = good.text.split('\n')
  // One changed byte in a middle row: its stored leafHash (and so the page's claimed last leaf) no longer recomputes.
  lines[2] = lines[2].replace('"epoch":1', '"epoch":2')
  const broken = { text: lines.join('\n'), leaf: good.leaf }
  for (const [name, receipts, gap] of [['changed byte', broken, 'AURA_RECEIPT_HASH_MISMATCH'], ['torn journal', { text: good.text.slice(0, -1), leaf: good.leaf }, 'AURA_JOURNAL_TRUNCATED']]) {
    const fx = await stack(t, { receipts })
    const facts = await fx.auraFacts()
    assert.equal(facts.evidence.status, 'incomplete', name)
    assert.deepEqual(facts.evidence.gaps, [gap], name)
    assert.equal(Object.hasOwn(facts, 'receiptsLeafHash'), false, name + ': an unverified chain names no leaf')
    await fx.approve('mint', '/_head/transcript', { action: 'nostr_provision' })
    const { identity } = (await fx.provision('mint')).body
    const body = fx.unsigned({ nodePubkeyHex: identity.pubkey })
    await fx.approve('publish', NOSTR_ANCHOR_ROUTE, body)
    const before = fx.hs.snapshot()
    fx.mirrorCalls.length = 0
    const refused = await fx.publish(body, 'publish')
    assert.equal(refused.response.status, 503, name)
    assert.equal(refused.body.code, 'NOSTR_ANCHOR_RECEIPTS_UNAVAILABLE', name)
    assert.deepEqual(fx.hs.snapshot(), before, name + ': nothing written, approval not consumed')
    assert.deepEqual(fx.mirrorCalls.filter(path => path !== '/_mirror/bootstrap-status'), ['/_mirror/aura-inputs'], name + ': refused on the mirror\'s verdict')
  }
})

test('the mirror\'s facts answer carries the verified last leaf and row count, equal to an independent recomputation', async t => {
  for (const receipts of [receiptsText(1), receiptsText(7), receiptsText(300, { pad: 2000 })]) {
    const fx = await stack(t, { receipts })
    const facts = await fx.auraFacts()
    assert.equal(facts.evidence.status, 'complete', JSON.stringify(facts.evidence))
    const expected = independentReceiptsHead(receipts.text)
    assert.equal(facts.receiptsLeafHash, expected.leafHash)
    assert.equal(facts.receiptRows, expected.rows)
    assert.equal(facts.receiptRows, facts.verifiedReceipts)
    assert.equal(facts.receiptsLeafHash, receipts.leaf)
  }
})

/** Mint her key, publish the organ's event for the stack's head and her journal's head, and return the signed leaf. */
async function publishOnHome(fx) {
  await fx.approve('mint', '/_head/transcript', { action: 'nostr_provision' })
  const { identity } = (await fx.provision('mint')).body
  const body = fx.unsigned({ nodePubkeyHex: identity.pubkey })
  await fx.approve('publish', NOSTR_ANCHOR_ROUTE, body)
  const published = await fx.publish(body, 'publish')
  assert.equal(published.response.status, 200, JSON.stringify(published.body))
  assert.equal(independentlyValid(published.body.event), true)
  return JSON.parse(published.body.event.content).receiptsLeafHash
}

test('the frozen home is the committed bytes, a whole verified chain, and bounded well under the scoped ceiling', () => {
  const receipts = frozenReceipts()
  const size = journalSize(receipts.text)
  assert.equal(size.rows, 158)
  assert.equal(overCeiling(size), false, JSON.stringify(size))
  const head = independentReceiptsHead(receipts.text)
  assert.equal(head.rows, size.rows)
  assert.equal(head.leafHash, receipts.leaf)
  for (const path of Object.keys(FROZEN_SHA256)) assert.equal(sha256(frozenText(path)), FROZEN_SHA256[path], path)
})

test('the frozen home publishes end to end: her HANDOFF.md, her chain, corpus and heartbeat as committed', async t => {
  const receipts = frozenReceipts()
  const fx = await stack(t, { receipts, home: frozenHome })
  const signedLeaf = await publishOnHome(fx)
  assert.equal(signedLeaf, independentReceiptsHead(receipts.text).leafHash, 'the leaf signed is the frozen journal\'s last, recomputed here')
  assert.equal(signedLeaf, receipts.leaf)
})

test('the scoped ceiling the smoke test reports against: 2,048 rows publish, 2,049 refuse and write nothing', async t => {
  const at = receiptsText(SCOPED_CEILING.rows)
  assert.equal(journalSize(at.text).rows, SCOPED_CEILING.rows)
  assert.equal(overCeiling(journalSize(at.text)), false)
  assert.equal(await publishOnHome(await stack(t, { receipts: at })), at.leaf)
  const over = receiptsText(SCOPED_CEILING.rows + 1)
  assert.equal(overCeiling(journalSize(over.text)), true)
  const fx = await stack(t, { receipts: over })
  await fx.approve('mint', '/_head/transcript', { action: 'nostr_provision' })
  const { identity } = (await fx.provision('mint')).body
  const body = fx.unsigned({ nodePubkeyHex: identity.pubkey })
  await fx.approve('publish', NOSTR_ANCHOR_ROUTE, body)
  const before = fx.hs.snapshot()
  const refused = await fx.publish(body, 'publish')
  assert.equal(refused.response.status, 503)
  assert.equal(refused.body.code, 'NOSTR_ANCHOR_RECEIPTS_UNAVAILABLE')
  assert.deepEqual(fx.hs.snapshot(), before, 'nothing written, approval not consumed')
})

test('the frozen home with its hand-off padded past the mirror\'s 64 KiB cap still publishes; the full Aura answer for that store is incomplete', async t => {
  // Built here, in the test's own store, from her frozen HANDOFF.md (the fixture is only read): her text, then filler.
  const real = frozenText('HANDOFF.md')
  const padded = real + '\n<!-- padding: test store only -->\n' + 'x'.repeat(Math.max(0, MIRROR_HANDOFF_CAP + 1024 - Buffer.byteLength(real)))
  assert.ok(padded.startsWith(real))
  assert.ok(Buffer.byteLength(padded) > MIRROR_HANDOFF_CAP, String(Buffer.byteLength(padded)))
  const receipts = frozenReceipts()
  const fx = await stack(t, { receipts, home: (file, journal) => frozenHome(file, journal, { handoff: padded }) })
  // The condition this test claims, shown on its own store first: Aura's full evidence answer refuses the hand-off.
  const full = await fx.auraFacts()
  assert.equal(full.evidence.status, 'incomplete', JSON.stringify(full.evidence))
  assert.deepEqual(full.evidence.gaps, ['AURA_BYTE_LIMIT'])
  assert.equal(Object.hasOwn(full, 'receiptsLeafHash'), false, 'the full answer names no leaf')
  const signedLeaf = await publishOnHome(fx)
  assert.equal(signedLeaf, independentReceiptsHead(receipts.text).leafHash, 'the leaf she signs is her journal\'s last, recomputed here')
  assert.equal(signedLeaf, receipts.leaf)
})

test('one changed byte or a torn end in her frozen journal refuses, consumes no approval and writes nothing', async t => {
  const text = frozenText('seed/receipts.v3.jsonl')
  // Format, not size: a journal that does not end on a whole row could not publish at all (the first real-home test).
  assert.ok(text.endsWith('\n'))
  const lines = text.split('\n'), rows = lines.length - 1
  assert.ok(rows >= 3, String(rows))
  // One byte inside the middle row's `at` value (wherever that key sits): still a well-formed row, its hash no longer recomputes.
  const middle = Math.floor(rows / 2), row = JSON.parse(lines[middle])
  assert.equal(typeof row.at, 'string')
  const at = lines[middle].indexOf('"at":' + JSON.stringify(row.at)) + '"at":"'.length
  assert.ok(at >= '"at":"'.length)
  lines[middle] = lines[middle].slice(0, at) + (lines[middle][at] === '2' ? '3' : '2') + lines[middle].slice(at + 1)
  assert.equal(JSON.parse(lines[middle]).at.length, row.at.length)
  assert.notEqual(JSON.parse(lines[middle]).at, row.at)
  const leaf = frozenReceipts(text).leaf
  for (const [name, receipts] of [['changed byte', { text: lines.join('\n'), leaf }], ['torn end', { text: text.slice(0, -1), leaf }]]) {
    const fx = await stack(t, { receipts, home: frozenHome })
    const facts = await fx.receiptsHeadFacts()
    assert.equal(facts.evidence.status, 'incomplete', name)
    assert.equal(Object.hasOwn(facts, 'receiptsLeafHash'), false, name)
    await fx.approve('mint', '/_head/transcript', { action: 'nostr_provision' })
    const { identity } = (await fx.provision('mint')).body
    const body = fx.unsigned({ nodePubkeyHex: identity.pubkey })
    await fx.approve('publish', NOSTR_ANCHOR_ROUTE, body)
    const before = fx.hs.snapshot()
    const refused = await fx.publish(body, 'publish')
    assert.equal(refused.response.status, 503, name)
    assert.equal(refused.body.code, 'NOSTR_ANCHOR_RECEIPTS_UNAVAILABLE', name)
    assert.deepEqual(fx.hs.snapshot(), before, name + ': nothing written, approval not consumed')
  }
})

test('the scoped receipts-head answer carries only the verified leaf and row count, equal to an independent recomputation', async t => {
  for (const [receipts, home] of [[frozenReceipts(), frozenHome], [receiptsText(1)], [receiptsText(300, { pad: 2000 })]]) {
    const fx = await stack(t, { receipts, home })
    const facts = await fx.receiptsHeadFacts()
    const expected = independentReceiptsHead(receipts.text)
    assert.deepEqual(Object.keys(facts).sort(), ['evidence', 'fence', 'head', 'ok', 'receiptRows', 'receiptsLeafHash', 'scope', 'seedId', 'verifiedReceipts'],
      'no Aura metrics in the scoped answer')
    assert.deepEqual(facts.evidence, { status: 'complete', scope: 'nostr-receipts-head', gaps: [] })
    assert.equal(facts.scope, 'nostr-receipts-head')
    assert.equal(facts.receiptsLeafHash, expected.leafHash)
    assert.equal(facts.receiptRows, expected.rows)
    assert.equal(facts.verifiedReceipts, expected.rows)
  }
})

// ── The owner's GET of the four facts the POST is checked against ───────────────────────────────────────────────

/** The owner's page, as a browser sends a same-origin GET: no Origin header, Sec-Fetch-Site same-origin, no body. */
const pageGet = (fx, path = NOSTR_ANCHOR_ROUTE, headers = {}) => fx.worker.fetch(new Request(ORIGIN + path, {
  headers: { 'sec-fetch-site': 'same-origin', accept: 'application/json', ...headers } }), fx.env)
const answerOf = async response => ({ status: response.status, body: await response.json() })

test('the owner\'s GET answers the four facts, and they are exactly what a following POST accepts', async t => {
  for (const [receipts, home] of [[receiptsText(3)], [frozenReceipts(), frozenHome]]) {
    const fx = await stack(t, { receipts, home })
    await fx.approve('mint', '/_head/transcript', { action: 'nostr_provision' })
    const { identity } = (await fx.provision('mint')).body
    fx.mirrorCalls.length = 0
    const read = await answerOf(await pageGet(fx))
    assert.equal(read.status, 200, JSON.stringify(read.body))
    assert.deepEqual(Object.keys(read.body).sort(), ['facts', 'ok'])
    assert.equal(read.body.ok, true)
    assert.deepEqual(Object.keys(read.body.facts).sort(), ['epoch', 'headBallId', 'nodePubkeyHex', 'receiptsLeafHash'])
    // Each fact against its own source, recomputed here: the selected ball, the minted key, the journal's last leaf.
    assert.deepEqual(read.body.facts, { headBallId: fx.ball.ballId, epoch: fx.ball.epoch,
      receiptsLeafHash: independentReceiptsHead(receipts.text).leafHash, nodePubkeyHex: identity.pubkey })
    assert.deepEqual(fx.mirrorCalls.filter(path => path !== '/_mirror/bootstrap-status'), ['/_mirror/aura-inputs'], 'the mirror\'s verified receipts head, not a journal read')
    // The organ builds the event from those facts alone; the POST accepts it and signs exactly those facts.
    const body = fx.unsigned(read.body.facts)
    await fx.approve('publish', NOSTR_ANCHOR_ROUTE, body)
    const published = await fx.publish(body, 'publish')
    assert.equal(published.response.status, 200, JSON.stringify(published.body))
    assert.equal(independentlyValid(published.body.event), true)
    const signed = JSON.parse(published.body.event.content)
    assert.deepEqual({ headBallId: signed.headBallId, epoch: signed.epoch, receiptsLeafHash: signed.receiptsLeafHash, nodePubkeyHex: signed.nodePubkeyHex }, read.body.facts)
    // After a publication the GET still answers the same facts (the head and the journal did not move).
    assert.deepEqual((await answerOf(await pageGet(fx))).body, read.body)
  }
})

test('signed-out and guest callers get the POST\'s own refusal for the GET, and HEAD is never asked', async t => {
  const fx = await stack(t)
  await fx.approve('mint', '/_head/transcript', { action: 'nostr_provision' })
  const { identity } = (await fx.provision('mint')).body
  const good = fx.unsigned({ nodePubkeyHex: identity.pubkey })
  const calls = fx.headCalls.length
  for (const [who, identityValue, status] of [['signed out', null, 401], ['guest (non-owner Access)', { ...fx.access, type: 'access' }, 403]]) {
    fx.session.identity = identityValue
    const post = await answerOf(await fx.call(NOSTR_ANCHOR_ROUTE, { method: 'POST', body: good }))
    const get = await answerOf(await pageGet(fx))
    assert.equal(get.status, status, who)
    assert.deepEqual(get, post, who + ': the GET refuses exactly as the POST does')
    assert.equal(JSON.stringify(get.body).includes(identity.pubkey), false, who)
    assert.equal(JSON.stringify(get.body).includes(fx.ball.ballId), false, who)
  }
  // A signed-out caller with no cookie at all, from another network, as a stranger would send it.
  fx.session.identity = null
  const stranger = await answerOf(await fx.call(NOSTR_ANCHOR_ROUTE, { signedOut: true }))
  assert.deepEqual(stranger, { status: 401, body: { ok: false, code: 'OWNER_ACCESS_REQUIRED' } })
  fx.session.identity = fx.access
  // The owner, but not from her own page, or not a bare GET: refused at the Worker, before HEAD.
  for (const [name, path, headers, status, code] of [
    ['cross-site', NOSTR_ANCHOR_ROUTE, { 'sec-fetch-site': 'cross-site' }, 403, 'SAME_ORIGIN_BROWSER_REQUIRED'],
    ['no fetch metadata', NOSTR_ANCHOR_ROUTE, { 'sec-fetch-site': 'none' }, 403, 'SAME_ORIGIN_BROWSER_REQUIRED'],
    ['foreign origin', NOSTR_ANCHOR_ROUTE, { origin: 'https://elsewhere.example.invalid' }, 403, 'ORIGIN_REFUSED'],
    ['query', NOSTR_ANCHOR_ROUTE + '?x=1', {}, 404, 'NOT_FOUND'],
    ['empty query', NOSTR_ANCHOR_ROUTE + '?', {}, 404, 'NOT_FOUND'],
    ['declared body', NOSTR_ANCHOR_ROUTE, { 'content-length': '5' }, 400, 'NOSTR_ANCHOR_REQUEST_INVALID'],
  ]) {
    const refused = await answerOf(await pageGet(fx, path, headers))
    assert.deepEqual(refused, { status, body: { ok: false, code } }, name)
  }
  assert.deepEqual(fx.headCalls.slice(calls), [], 'no refused GET (or POST) reached HEAD at all')
  // HEAD's own rule, if a forwarded GET ever arrived without the owner: the POST's refusal code.
  const direct = await fx.head.fetch(new Request(ORIGIN + NOSTR_ANCHOR_ROUTE, { headers: { 'x-x6-internal-authorized': '1', 'x-x6-bootstrap-seed': fx.seedId } }))
  assert.deepEqual(await answerOf(direct), { status: 403, body: { ok: false, code: 'NOSTR_ANCHOR_OWNER_REQUIRED' } })
  const directPost = await fx.head.fetch(new Request(ORIGIN + NOSTR_ANCHOR_ROUTE, { method: 'POST', body: JSON.stringify(good), headers: {
    'content-type': 'application/json', 'x-x6-internal-authorized': '1', 'x-x6-bootstrap-seed': fx.seedId } }))
  assert.deepEqual(await answerOf(directPost), { status: 403, body: { ok: false, code: 'NOSTR_ANCHOR_OWNER_REQUIRED' } })
})

test('the GET changes no stored key, signs nothing and consumes no approval; its refusals are the POST\'s codes', async t => {
  const fx = await stack(t)
  // No key yet: the identity-required refusal, and nothing minted.
  const before = { head: fx.hs.snapshot(), mirror: fx.ms.snapshot() }
  assert.deepEqual(await answerOf(await pageGet(fx)), { status: 409, body: { ok: false, code: 'NOSTR_ANCHOR_IDENTITY_REQUIRED' } })
  assert.deepEqual(fx.hs.snapshot(), before.head, 'no key minted, nothing written')
  assert.deepEqual(fx.ms.snapshot(), before.mirror)
  await fx.approve('mint', '/_head/transcript', { action: 'nostr_provision' })
  const { identity } = (await fx.provision('mint')).body
  const body = fx.unsigned({ nodePubkeyHex: identity.pubkey })
  // An approval for a publication, present on the GET as a header: it is not consumed, and nothing is signed or stored.
  await fx.approve('publish', NOSTR_ANCHOR_ROUTE, body)
  const quiet = { head: fx.hs.snapshot(), mirror: fx.ms.snapshot() }
  for (let index = 0; index < 3; index++) assert.equal((await pageGet(fx, NOSTR_ANCHOR_ROUTE, { 'x-x6-class3-approval': 'publish' })).status, 200)
  assert.deepEqual(fx.hs.snapshot(), quiet.head, 'HEAD storage unchanged by three GETs')
  assert.deepEqual(fx.ms.snapshot(), quiet.mirror, 'mirror storage unchanged by three GETs')
  assert.equal(fx.hs.snapshot().has(NOSTR_ANCHOR_KEY), false, 'nothing published')
  // The approval is still unused: the POST it was made for succeeds afterwards.
  assert.equal((await fx.publish(body, 'publish')).response.status, 200)
  const published = fx.hs.snapshot()
  assert.equal((await pageGet(fx)).status, 200)
  assert.deepEqual(fx.hs.snapshot(), published, 'the stored announcement is untouched by a GET')
})

test('a journal the mirror cannot verify: the GET answers the POST\'s receipts-unavailable refusal and names no leaf', async t => {
  const good = receiptsText(5)
  const fx = await stack(t, { receipts: { text: good.text.slice(0, -1), leaf: good.leaf } })
  await fx.approve('mint', '/_head/transcript', { action: 'nostr_provision' })
  await fx.provision('mint')
  const before = fx.hs.snapshot()
  const read = await answerOf(await pageGet(fx))
  assert.deepEqual(read, { status: 503, body: { ok: false, code: 'NOSTR_ANCHOR_RECEIPTS_UNAVAILABLE' } })
  assert.equal(JSON.stringify(read.body).includes(good.leaf), false)
  assert.deepEqual(fx.hs.snapshot(), before)
})

/** COPIED from the page (packages/client/ui-layout/src/client/spatial/apps/identity/nostr.ts
 * `readAnchorFacts`, `anchorFactsOf` and `anchorEvent`, as its spec identity-nostr-anchor.client.spec.tsx feeds them
 * `{ ok: true, facts: FACTS }`), not imported across packages: the page takes `answer.body.facts ?? answer.body`, then each
 * fact must be exactly well formed (64 lowercase hex, a non-negative safe integer), and builds the event from them. */
const PAGE_HEX_64 = /^[0-9a-f]{64}$/
function pageAnchorFactsOf(value) {
  const record = value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const { headBallId, epoch, receiptsLeafHash, nodePubkeyHex } = record
  if (typeof headBallId !== 'string' || !PAGE_HEX_64.test(headBallId)) return null
  if (typeof epoch !== 'number' || !Number.isSafeInteger(epoch) || epoch < 0) return null
  if (typeof receiptsLeafHash !== 'string' || !PAGE_HEX_64.test(receiptsLeafHash)) return null
  if (typeof nodePubkeyHex !== 'string' || !PAGE_HEX_64.test(nodePubkeyHex)) return null
  return { headBallId, epoch, receiptsLeafHash, nodePubkeyHex }
}
function pageAnchorEvent(facts, createdAt) {
  const content = sortedJson({ schema: 'aukora.nostr.head.v1', headBallId: facts.headBallId, epoch: facts.epoch,
    receiptsLeafHash: facts.receiptsLeafHash, nodePubkeyHex: facts.nodePubkeyHex })
  return { pubkey: facts.nodePubkeyHex, created_at: createdAt, kind: 30078, tags: [['d', `aukora-head:${facts.nodePubkeyHex}`],
    ['epoch', String(facts.epoch)], ['head', facts.headBallId], ['receipts', facts.receiptsLeafHash], ['schema', 'aukora.nostr.head.v1']], content }
}

test('cross-lane: the GET answer read the way the page reads it gives an event the POST signs', async t => {
  const fx = await stack(t)
  // Before her key exists the page sees a refusal with the edge's code, never facts.
  const early = await answerOf(await pageGet(fx))
  assert.equal(early.body.ok, false)
  assert.equal(early.body.code, 'NOSTR_ANCHOR_IDENTITY_REQUIRED')
  await fx.approve('mint', '/_head/transcript', { action: 'nostr_provision' })
  const { identity } = (await fx.provision('mint')).body
  const response = await pageGet(fx)
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type') ?? '', /application\/json/, 'the page reads only a JSON answer as live')
  const answer = await response.json()
  assert.equal(answer.ok, true)
  const facts = pageAnchorFactsOf(answer.facts ?? answer)
  assert.notEqual(facts, null, 'the page reads the answer as live facts, not unreadable')
  assert.equal(facts.nodePubkeyHex, identity.pubkey, 'the page shows the npub of the key the node holds')
  const event = pageAnchorEvent(facts, Math.floor(Date.now() / 1000))
  // The page's rule and the organ's agree on these facts, byte for byte.
  assert.deepEqual(event, fx.unsigned({ ...facts, createdAt: event.created_at }))
  await fx.approve('page', NOSTR_ANCHOR_ROUTE, event)
  const published = await fx.publish(event, 'page')
  assert.equal(published.response.status, 200, JSON.stringify(published.body))
  assert.deepEqual({ pubkey: published.body.event.pubkey, created_at: published.body.event.created_at, kind: published.body.event.kind,
    tags: published.body.event.tags, content: published.body.event.content }, event, 'the node signed exactly the event the page built')
  assert.equal(independentlyValid(published.body.event), true)
})

test('a read abandoned by its cancelled request never hangs the public door: a later caller takes the read over', async () => {
  let reads = 0
  const door = createNostrReadDoor({ now: () => 0, shareWaitMs: 20, shield: createIsolateShield(ISOLATE_SHIELD.guest), subjectOf: () => 'one-network' })
  const url = new URL(ORIGIN + NOSTR_HEAD_ROUTE), pending = Symbol('pending')
  const abandoned = door.serve(new Request(url), url, () => { reads++; return new Promise(() => {}) })
  await new Promise(resolve => setImmediate(resolve))
  // A live read takes longer than the gap between two waiters' timers, as a durable read does.
  const live = async () => { reads++; await new Promise(resolve => setTimeout(resolve, 5)); return { ok: true, event: null } }
  const later = await Promise.race([Promise.all([door.serve(new Request(url), url, live), door.serve(new Request(url), url, live)]),
    new Promise(resolve => setTimeout(() => resolve(pending), 3000))])
  assert.notEqual(later, pending, 'later callers still wait on the abandoned read')
  assert.deepEqual(later.map(response => response.status), [404, 404])
  assert.equal(reads, 2, 'one abandoned read, one live read shared by both later callers')
  // The live answer is held: the next caller reads nothing.
  assert.equal((await door.serve(new Request(url), url, live)).status, 404)
  assert.equal(reads, 2)
  assert.equal(await Promise.race([abandoned, new Promise(resolve => setImmediate(() => resolve(pending)))]), pending)
})

const doorPending = Symbol('pending')
/** The promise's outcome, or `doorPending` after `ms` (the timer is cleared either way: it only elapses on a failure). */
const doorWithin = (promise, ms = 30_000) => {
  let timer
  return Promise.race([promise, new Promise(resolve => { timer = setTimeout(() => resolve(doorPending), ms) })]).finally(() => clearTimeout(timer))
}
const doorTurn = () => new Promise(resolve => setImmediate(resolve))

test('equal clock: two door reads start in the same millisecond, the newer answers first; the older, answering later, never replaces the cached answer', async () => {
  let reads = 0, failOlder
  // The clock never moves: both reads start in millisecond 0.
  const door = createNostrReadDoor({ now: () => 0, shareWaitMs: 20, shield: createIsolateShield(ISOLATE_SHIELD.guest), subjectOf: () => 'one-network' })
  const url = new URL(ORIGIN + NOSTR_HEAD_ROUTE)
  const older = door.serve(new Request(url), url, () => { reads++; return new Promise((_resolve, reject) => { failOlder = reject }) })
  await doorTurn()
  const live = async () => { reads++; return { ok: true, event: null } }
  // The next caller gives the older read its own short wait, then reads itself: a newer read, the same millisecond.
  const newer = await doorWithin(door.serve(new Request(url), url, live))
  assert.notEqual(newer, doorPending)
  assert.equal(newer.status, 404)
  assert.equal(reads, 2)
  // The older read fails at last. Its own caller is told so; the cached answer stays the newer one.
  failOlder(new Error('the older read failed late'))
  assert.equal((await doorWithin(older)).status, 503)
  const next = await door.serve(new Request(url), url, live)
  assert.equal(next.status, 404, 'an older read replaced the newer cached answer')
  assert.equal(next.headers.get('cache-control'), 'public, max-age=60')
  assert.equal(reads, 2, 'the newer answer is still cached: nothing was read again')
})

test('door reads that never answer: a caller out of waits gets 503 NOSTR_ANCHOR_UNAVAILABLE, reads nothing itself, and that answer is not cached', async () => {
  let reads = 0
  const door = createNostrReadDoor({ now: () => 0, shareWaitMs: 20, shield: createIsolateShield(ISOLATE_SHIELD.guest), subjectOf: () => 'one-network' })
  const url = new URL(ORIGIN + NOSTR_HEAD_ROUTE)
  const dead = () => { reads++; return new Promise(() => {}) }, live = async () => { reads++; return { ok: true, event: null } }
  const abandoned = door.serve(new Request(url), url, dead)
  await doorTurn()
  // The first later caller takes the read over after its wait, and its own read never answers either.
  const taker = door.serve(new Request(url), url, dead)
  await doorTurn()
  // The second has then waited twice on reads it did not start: it is answered, and starts no read of its own.
  const refused = await doorWithin(door.serve(new Request(url), url, live))
  assert.notEqual(refused, doorPending, 'a caller out of waits still waits')
  assert.equal(refused.status, 503)
  assert.deepEqual(await refused.json(), { ok: false, code: 'NOSTR_ANCHOR_UNAVAILABLE' })
  assert.equal(refused.headers.get('cache-control'), 'no-store')
  assert.equal(reads, 2, 'the abandoned read and one replacement: the refused caller read nothing')
  // Not cached: the next caller, after its own wait on the dead replacement, reads and is served.
  const served = await doorWithin(door.serve(new Request(url), url, live))
  assert.notEqual(served, doorPending)
  assert.equal(served.status, 404)
  assert.equal(reads, 3)
  for (const hung of [abandoned, taker]) assert.equal(await doorWithin(hung, 0), doorPending)
})
