/**
 * The word check and the sealed root never leave the edge in a reply without the owner's passkey.
 *
 * HEAD's `aumlok:v1` row holds the recovery commitment, the root escrow (and every challenge that copies them) and, on a
 * legacy store, the pepper that keys both. A copy of that row lets anyone test guesses of the words offline. These tests
 * drive the real Worker, HEAD and Mirror objects over in-memory storage, with MADE-UP values only: no real row, pepper,
 * commitment or words. Every Class 3 approval is a real passkey (P-256, user verified) ceremony through the production
 * aumlok store, consumed once by HEAD's production consumer.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import { isoCBOR } from '@simplewebauthn/server/helpers'
import { createReceiptChainFixture } from './fixtures/cold-archive/receipt-chain.mjs'
import { canonicalJson } from '../owner-grant-policy.mjs'
import { createWorker } from '../worker.mjs'
import { X61HeadDurableObject, canonicalBootstrap, digest, manifestId, BOOTSTRAP_VERSION } from '../head-do.mjs'
import { MirrorDO } from '../mirror-do.mjs'
import { AUMLOK_STORAGE_KEY, aumlokClass3Binding, createAumlokStore } from '../aumlok.mjs'
import { COLD_ARCHIVE_SCHEMA, runDisposableRebuildDrill, verifyColdArchive, verifyRestorableOwnerRecord } from '../cold-archive.mjs'

const ORIGIN = 'https://x61.example.invalid'
const ARCHIVE = '/_host/archive'
const EXPORT_BODY = Object.freeze({ action: 'export', includeBundle: true })

// Made-up owner-secret values. Each is distinctive so a search of a serialised reply finds it wherever it lands.
const MADE_UP_PEPPER = Buffer.from('export1-made-up-pepper-32-bytes!').toString('base64url')
const MADE_UP_COMMITMENT = 'e1'.repeat(32)
const MADE_UP_ESCROW_IV = Buffer.from('export1-iv12').toString('base64url')
const MADE_UP_ESCROW_CIPHERTEXT = Buffer.from('export1-made-up-escrow-ciphertext-48-bytes-long!').toString('base64url')
const SECRET_MARKERS = ['aumlokState', 'pepper.v1', 'recoveryCommitment', 'rootEscrow', 'sealedRoot',
  MADE_UP_PEPPER, MADE_UP_COMMITMENT, MADE_UP_ESCROW_IV, MADE_UP_ESCROW_CIPHERTEXT]

const clone = value => structuredClone(value)
const sha = value => createHash('sha256').update(value).digest()
const leaks = text => SECRET_MARKERS.filter(marker => text.includes(marker))

/** Durable Object storage double: staged transactions that commit only on success (as the platform does). */
function memoryStorage() {
  let rows = new Map(), alarmAt = null, queue = Promise.resolve()
  const view = map => ({
    getAlarm: async () => alarmAt, setAlarm: async value => { alarmAt = value }, deleteAlarm: async () => { alarmAt = null },
    get: async key => clone(map.get(key)),
    put: async (key, value) => { map.set(key, clone(value)) },
    delete: async key => map.delete(key),
    list: async ({ prefix = '', limit = Infinity } = {}) => new Map([...map].filter(([key]) => key.startsWith(prefix))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).slice(0, limit).map(([key, value]) => [key, clone(value)])),
  })
  return {
    ...view(rows),
    get: key => view(rows).get(key), put: (key, value) => view(rows).put(key, value), delete: key => view(rows).delete(key),
    list: options => view(rows).list(options),
    deleteAll: async () => { rows = new Map(); alarmAt = null },
    getAlarm: async () => alarmAt, setAlarm: async value => { alarmAt = value }, deleteAlarm: async () => { alarmAt = null },
    transaction(operation) {
      const pending = queue.then(async () => {
        const staged = new Map([...rows].map(([key, value]) => [key, clone(value)]))
        const result = await operation(view(staged))
        rows = staged
        return result
      })
      queue = pending.catch(() => {})
      return pending
    },
    size: () => rows.size,
  }
}

function memoryR2() {
  const objects = new Map()
  const meta = key => ({ key, size: Buffer.byteLength(objects.get(key).text), uploaded: objects.get(key).uploaded })
  return {
    objects,
    async put(key, value) { objects.set(key, { text: typeof value === 'string' ? value : new TextDecoder().decode(value), uploaded: new Date(1794350000000) }) },
    async get(key) {
      if (!objects.has(key)) return null
      const { text } = objects.get(key)
      return { ...meta(key), body: new Response(text).body, text: async () => text, json: async () => JSON.parse(text) }
    },
    async head(key) { return objects.has(key) ? meta(key) : null },
    async list({ prefix = '', limit = 1000 } = {}) {
      const keys = [...objects.keys()].filter(key => key.startsWith(prefix)).sort()
      return { objects: keys.slice(0, limit).map(meta), truncated: keys.length > limit }
    },
  }
}

async function fixture() {
  const { receiptsText, checkpointsText } = createReceiptChainFixture()
  const owner = generateKeyPairSync('ed25519'), node = generateKeyPairSync('ed25519')
  const passkey = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const ownerPublicKeyHex = owner.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex')
  const nodePubkeyHex = node.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex')
  const jwk = passkey.publicKey.export({ format: 'jwk' })
  const credentialId = randomBytes(32).toString('base64url')

  const code = 'export const organ = "archive-fixture"\n'
  const moduleSha = await digest(code)
  const ballDraft = { version: 'x6.1-ball/v1', epoch: 3, parentBallId: null, createdAt: '2026-11-12T00:00:00.000Z', authorPeerId: 'archive-fixture',
    entries: { 'organ.fixture': { id: 'organ.fixture', specifier: `ball:${moduleSha}`, disabled: false, config: {}, previousSpecifiers: [] } },
    modules: { [moduleSha]: { sha256: moduleSha, specifier: `ball:${moduleSha}`, size: Buffer.byteLength(code) } } }
  const ball = { ...ballDraft, ballId: await manifestId(ballDraft) }
  const file = text => ({ kind: 'file', mode: 0o600, mtimeMs: 1794348000000, b64: Buffer.from(text).toString('base64') })
  const mirrorEntries = [
    ['/dsh/home/auma', { kind: 'dir', mode: 0o700 }],
    ['/dsh/home/auma/seed', { kind: 'dir', mode: 0o700 }],
    ['/dsh/home/auma/seed/checkpoints.v1.jsonl', file(checkpointsText)],
    ['/dsh/home/auma/seed/receipts.v3.jsonl', file(receiptsText)],
  ]
  const seedPayload = { version: BOOTSTRAP_VERSION, ball, codeBySha: { [moduleSha]: code },
    mirror: { entryCount: mirrorEntries.length, batchDigests: [await digest(canonicalBootstrap(mirrorEntries))] } }
  const seedId = await digest(canonicalBootstrap(seedPayload))

  const headStorages = new Map(), mirrorStorages = new Map(), heads = new Map(), mirrors = new Map()
  const r2 = memoryR2()
  const env = {
    PUBLIC_HOST: new URL(ORIGIN).host,
    OWNER_EMAIL: 'owner@example.invalid',
    OWNER_PUBLIC_KEY_HEX: ownerPublicKeyHex,
    ARCHIVE_BUCKET: r2,
    HEAD: { idFromName: name => name, get: name => {
      if (!heads.has(name)) { const storage = memoryStorage(); headStorages.set(name, storage); heads.set(name, new X61HeadDurableObject({ storage, getWebSockets: () => [] }, env)) }
      return heads.get(name)
    } },
    MIRROR: { idFromName: name => name, get: name => {
      if (!mirrors.has(name)) { const storage = memoryStorage(); mirrorStorages.set(name, storage); mirrors.set(name, new MirrorDO({ storage }, env)) }
      return mirrors.get(name)
    } },
    ASSETS: { fetch: () => new Response('fixture asset') },
  }
  const worker = createWorker({
    // A second, non-owner Access session (`access`, the type a guest's Access login gets) for the owner-only checks.
    verifyAccess: async request => request.headers.get('cookie') === 'CF_Authorization=fixture-owner'
      ? { type: 'owner', email: env.OWNER_EMAIL, expires: Math.floor(Date.now() / 1000) + 3600 }
      : request.headers.get('cookie') === 'CF_Authorization=fixture-guest'
        ? { type: 'access', email: 'guest@example.invalid', expires: Math.floor(Date.now() / 1000) + 3600 } : null,
    networkFetch: async () => { throw new Error('External network is forbidden in this fixture') },
  })
  const call = (pathname, value, { headers = {}, method } = {}) => {
    const all = new Headers({ cookie: 'CF_Authorization=fixture-owner', origin: ORIGIN, 'sec-fetch-site': 'same-origin',
      ...(value === undefined ? {} : { 'content-type': 'application/json' }) })
    for (const [name, entry] of Object.entries(headers)) entry === null ? all.delete(name) : all.set(name, entry)
    return worker.fetch(new Request(new URL(pathname, ORIGIN), { method: method ?? (value === undefined ? 'GET' : 'POST'), headers: all,
      ...(value === undefined ? {} : { body: JSON.stringify(value) }) }), env)
  }
  for (const input of [{ action: 'prepare', package: { ...seedPayload, seedId } }, { action: 'batch', seedId, index: 0, entries: mirrorEntries }, { action: 'commit', seedId }]) {
    const response = await call('/_bootstrap', input)
    assert.equal(response.status, 200, await response.text())
  }

  // A valid legacy (pepper not separated) bound row, with MADE-UP secrets, as the live store is reported to be.
  const at = Date.now()
  await headStorages.get('node-main-v1').put(AUMLOK_STORAGE_KEY, {
    schema: 'aukora.aumlok.state.v2', generation: 1,
    binding: { aumlokId: 'a1'.repeat(32), recoveryCommitment: MADE_UP_COMMITMENT,
      rootEscrow: { schema: 'aukora.aumlok.escrow.v2', ivB64: MADE_UP_ESCROW_IV, ciphertextB64: MADE_UP_ESCROW_CIPHERTEXT },
      nodePubkeyHex,
      credential: { id: credentialId, counter: 0, publicKeyB64: Buffer.from(isoCBOR.encode(new Map([
        [1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')],
      ]))).toString('base64url') },
      boundAt: at - 3600000, lastVerifiedAt: at - 3600000, generation: 1 },
    'pepper.v1': MADE_UP_PEPPER, challenges: [], invites: [], revocations: [],
    failures: 0, failedAt: [], nextAllowedAt: 0, attempts: [], approvals: [],
  })

  // His passkey approves one exact action. `clock` lets a test approve in the past (an approval that has since expired).
  let sequence = 0
  const approve = async ({ pathname = ARCHIVE, body = EXPORT_BODY, method = 'POST', clock = Date.now } = {}) => {
    const store = createAumlokStore(headStorages.get('node-main-v1'), { origins: [ORIGIN], ownerPublicKeyHex, now: clock })
    const binding = await aumlokClass3Binding({ audience: ORIGIN, method, pathname, body })
    const challenge = await store.challenge({ purpose: 'approve', requestId: `export1-approval-${++sequence}`, binding }, ORIGIN)
    assert.equal(challenge.ok, true, JSON.stringify(challenge))
    const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: challenge.publicKey.challenge, origin: ORIGIN, crossOrigin: false })).toString('base64url')
    const authenticatorData = Buffer.alloc(37)
    sha(new URL(ORIGIN).hostname).copy(authenticatorData)
    authenticatorData[32] = 5 // user present + user verified
    authenticatorData.writeUInt32BE(sequence, 33)
    const signature = sign('sha256', Buffer.concat([authenticatorData, sha(Buffer.from(clientDataJSON, 'base64url'))]), passkey.privateKey)
    const result = await store.complete('approve', { challengeId: challenge.challengeId, credential: { id: credentialId, rawId: credentialId, type: 'public-key',
      clientExtensionResults: {}, response: { clientDataJSON, authenticatorData: authenticatorData.toString('base64url'), signature: signature.toString('base64url') } } }, ORIGIN)
    assert.equal(result.ok, true, JSON.stringify(result))
    return result.approvalToken
  }
  const liveRow = () => headStorages.get('node-main-v1').get(AUMLOK_STORAGE_KEY)
  return { env, call, approve, r2, ball, headStorages, mirrorStorages, liveRow, credentialId, nodePubkeyHex }
}

async function exportReply(response) {
  const text = await response.text()
  return { status: response.status, text, value: JSON.parse(text) }
}

test('an owner-session export without his passkey returns a bundle with the owner-secret row withheld, marked, and verifying as itself', async () => {
  const fx = await fixture()
  // The approval ceremony itself copies the commitment and escrow into a challenge record: the row now holds them twice.
  await fx.approve({ body: { action: 'export', includeBundle: false } })
  const row = JSON.stringify(await fx.liveRow())
  assert.ok(row.includes(MADE_UP_PEPPER) && row.split(MADE_UP_COMMITMENT).length > 2, 'the made-up secrets are really in HEAD, also inside a challenge record')

  const reply = await exportReply(await fx.call(ARCHIVE, EXPORT_BODY))
  assert.equal(reply.status, 200, reply.text)
  assert.deepEqual(leaks(reply.text), [], 'no owner-secret field name or made-up value anywhere in the reply')
  assert.equal(reply.value.ownerSecrets, 'withheld')
  const bundle = reply.value.bundle
  assert.equal(bundle.ownerSecrets, 'withheld')
  assert.equal(Object.hasOwn(bundle.head, 'aumlokState'), false)
  assert.deepEqual(Object.keys(bundle.head).sort(), ['ball', 'bootstrap', 'codeBySha'])
  assert.equal(bundle.head.ball.ballId, fx.ball.ballId)
  assert.equal(bundle.ownerSummary.phase, 'BOUND')

  // Its digest is computed over exactly what came back, and it names the full archive it was made from.
  const { archiveId, ...unsigned } = bundle
  assert.equal(archiveId, await digest(`${COLD_ARCHIVE_SCHEMA}\0${canonicalJson(unsigned)}`))
  assert.equal(bundle.sourceArchiveId, reply.value.archiveId)
  assert.notEqual(archiveId, reply.value.archiveId)

  // It is not a restore source: verification names why, and the library drill refuses it before any write.
  await assert.rejects(verifyColdArchive(bundle, { expectedOwnerPublicKeyHex: fx.env.OWNER_PUBLIC_KEY_HEX }),
    error => error.code === 'ARCHIVE_OWNER_SECRETS_WITHHELD' && error.status === 409)
  const targetHead = memoryStorage(), targetMirror = memoryStorage()
  await assert.rejects(runDisposableRebuildDrill({ targetName: 'x61-drill-export1-withheld', bundle, targetHeadStorage: targetHead,
    targetMirrorStorage: targetMirror, expectedOwnerPublicKeyHex: fx.env.OWNER_PUBLIC_KEY_HEX }),
  error => error.code === 'ARCHIVE_OWNER_SECRETS_WITHHELD' && error.status === 409)
  assert.equal(targetHead.size() + targetMirror.size(), 0)
  // Over HTTP a bundle from the client is never even looked at: refused by its own code, no drill object made.
  const drill = await exportReply(await fx.call(ARCHIVE, { action: 'rebuild_drill', targetName: 'x61-drill-export1-withheld', bundle }))
  assert.equal(drill.status, 400, drill.text)
  assert.equal(drill.value.code, 'ARCHIVE_CLIENT_BUNDLE_REFUSED')
  // 1d review: no object is named by the label any more, so the check is that no drill object of any name was made.
  assert.deepEqual([...fx.headStorages.keys()], ['node-main-v1'], 'no drill HEAD object was even made')
  assert.deepEqual([...fx.mirrorStorages.keys()], ['node-main-v1'], 'no drill Mirror object was even made')
})

test('the edge\'s own R2 copy keeps the row and a rebuild drill accepts it; the drill reply carries none of it', async () => {
  const fx = await fixture()
  const reply = await exportReply(await fx.call(ARCHIVE, EXPORT_BODY))
  assert.equal(reply.status, 200, reply.text)
  assert.equal(reply.value.r2Stored, true)
  const stored = fx.r2.objects.get(reply.value.r2Key).text
  assert.ok(stored.includes(MADE_UP_PEPPER) && stored.includes(MADE_UP_COMMITMENT) && stored.includes(MADE_UP_ESCROW_CIPHERTEXT), 'R2 keeps the whole row')
  const full = JSON.parse(stored)
  assert.equal(full.ownerSecrets, undefined)
  assert.equal(full.archiveId, reply.value.archiveId)
  const verified = await verifyColdArchive(full, { expectedOwnerPublicKeyHex: fx.env.OWNER_PUBLIC_KEY_HEX })
  assert.equal(verified.ownerSummary.phase, 'BOUND')

  const drill = await exportReply(await fx.call(ARCHIVE, { action: 'rebuild_drill', targetName: 'x61-drill-export1-r2', r2Key: reply.value.r2Key }))
  assert.equal(drill.status, 200, drill.text)
  assert.equal(drill.value.ok, true)
  assert.equal(drill.value.ownerPhase, 'BOUND')
  assert.equal(drill.value.ballId, fx.ball.ballId)
  assert.deepEqual(leaks(drill.text), [])
  // the drill's objects are its attempt's own; the name given is only its label.
  assert.equal(drill.value.label, 'x61-drill-export1-r2')
  assert.equal(fx.headStorages.get(drill.value.targetName).size(), 0)
  assert.equal(fx.mirrorStorages.get(drill.value.targetName).size(), 0)
})

test('with his passkey approval over this exact body the reply is today\'s full bundle; that approval works once', async () => {
  const fx = await fixture()
  const token = await fx.approve()
  const reply = await exportReply(await fx.call(ARCHIVE, EXPORT_BODY, { headers: { 'x-x6-class3-approval': token } }))
  assert.equal(reply.status, 200, reply.text)
  assert.equal(reply.value.ownerSecrets, 'included')
  assert.equal(reply.value.bundle.ownerSecrets, undefined)
  assert.equal(reply.value.bundle.head.aumlokState['pepper.v1'], MADE_UP_PEPPER)
  assert.equal(reply.value.bundle.head.aumlokState.binding.recoveryCommitment, MADE_UP_COMMITMENT)
  assert.equal(reply.value.bundle.head.aumlokState.binding.rootEscrow.ciphertextB64, MADE_UP_ESCROW_CIPHERTEXT)
  // Byte for byte the bundle the edge wrote to R2 in the same call: today's bundle, unchanged.
  assert.equal(JSON.stringify(reply.value.bundle), fx.r2.objects.get(reply.value.r2Key).text)
  await verifyColdArchive(reply.value.bundle, { expectedOwnerPublicKeyHex: fx.env.OWNER_PUBLIC_KEY_HEX })

  // Replayed: refused, nothing in the reply.
  const replay = await exportReply(await fx.call(ARCHIVE, EXPORT_BODY, { headers: { 'x-x6-class3-approval': token } }))
  assert.equal(replay.status, 403, replay.text)
  assert.equal(replay.value.code, 'CLASS3_WEBAUTHN_REQUIRED')
  assert.deepEqual(leaks(replay.text), [])
})

test('an approval for another body, another route, or one that has expired releases nothing', async () => {
  // One fresh world per case: a refused approval counts as a failed passkey attempt and backs the next one off.
  const cases = [
    ['other body', fx => fx.approve({ body: { action: 'export', includeBundle: false } })],
    ['other route', fx => fx.approve({ pathname: '/_host/repo' })],
    ['expired', fx => fx.approve({ clock: () => Date.now() - 600000 })],
    ['made up', async () => randomBytes(32).toString('base64url')],
  ]
  for (const [name, issue] of cases) {
    const fx = await fixture()
    const token = await issue(fx)
    const reply = await exportReply(await fx.call(ARCHIVE, EXPORT_BODY, { headers: { 'x-x6-class3-approval': token } }))
    assert.equal(reply.status, 403, `${name}: ${reply.text}`)
    assert.equal(reply.value.code, 'CLASS3_WEBAUTHN_REQUIRED', name)
    assert.deepEqual(leaks(reply.text), [], name)
    // The refused call exported nothing: no snapshot was written.
    assert.equal([...fx.r2.objects.keys()].some(key => key.startsWith('snapshots/')), false, name)
  }
})

test('signed out or cross-origin, the archive route answers as before and carries nothing', async () => {
  const fx = await fixture()
  const token = await fx.approve()
  const cases = [
    ['signed out', { cookie: null, 'x-x6-class3-approval': token }, 401],
    ['cross-origin', { origin: 'https://other.example.invalid', 'x-x6-class3-approval': token }, 403],
    ['cross-site fetch', { 'sec-fetch-site': 'cross-site', 'x-x6-class3-approval': token }, 403],
  ]
  for (const [name, headers, status] of cases) {
    const reply = await exportReply(await fx.call(ARCHIVE, EXPORT_BODY, { headers }))
    assert.equal(reply.status, status, `${name}: ${reply.text}`)
    assert.deepEqual(leaks(reply.text), [], name)
  }
  // The approval was never reached, so it is still unspent and works for its owner from his own page.
  const reply = await exportReply(await fx.call(ARCHIVE, EXPORT_BODY, { headers: { 'x-x6-class3-approval': token } }))
  assert.equal(reply.value.ownerSecrets, 'included')
})

test('no other owner route carries the owner-secret row', async () => {
  const fx = await fixture()
  await fx.approve({ body: { action: 'export', includeBundle: false } })
  const exported = await exportReply(await fx.call(ARCHIVE, { action: 'export' }))
  assert.equal(exported.status, 200, exported.text)
  const routes = [
    ['archive export without includeBundle', exported],
    ['archive status (GET)', await exportReply(await fx.call(ARCHIVE))],
    ['archive status (POST)', await exportReply(await fx.call(ARCHIVE, { action: 'status' }))],
    ['archive rebuild drill from R2', await exportReply(await fx.call(ARCHIVE, { action: 'rebuild_drill', targetName: 'x61-drill-export1-routes', r2Key: exported.value.r2Key }))],
    ['aumlok status', await exportReply(await fx.call('/_host/aumlok/status'))],
    ['aumlok approve challenge', await exportReply(await fx.call('/_host/aumlok/challenge', { purpose: 'approve', requestId: 'export1-route-check',
      binding: await aumlokClass3Binding({ audience: ORIGIN, method: 'POST', pathname: ARCHIVE, body: EXPORT_BODY }) }))],
    ['estate', await exportReply(await fx.call('/_host/estate'))],
    ['estate archive metadata', await exportReply(await fx.call('/_host/estate', { action: 'archive_status' }))],
    ['diagnostics', await exportReply(await fx.call('/_host/diagnostics'))],
    ['selftest', await exportReply(await fx.call('/_host/selftest'))],
    ['mirror export', await exportReply(await fx.call('/_mirror/export'))],
    ['wake', await exportReply(await fx.call('/_host/wake'))],
    ['facts', await exportReply(await fx.call('/__x6/facts'))],
    ['status', await exportReply(await fx.call('/__x6/status'))],
    ['health', await exportReply(await fx.call('/api/health'))],
  ]
  for (const [name, reply] of routes) {
    // Facts answers its full projection with 503 here: this fixture configures no checkpoint signer, so it is unverified.
    assert.ok(reply.status < 500 || (name === 'facts' && reply.value.runtime === 'cloudflare'), `${name} answered ${reply.status}: ${reply.text.slice(0, 300)}`)
    assert.deepEqual(leaks(reply.text), [], name)
  }
})

// ---- Job 2: the rebuild drill never trusts a bundle a client hands it, and never reports an owner row it has not loaded.

const reseal = async draft => {
  const { archiveId: _old, ...unsigned } = draft
  return { archiveId: await digest(`${COLD_ARCHIVE_SCHEMA}\0${canonicalJson(unsigned)}`), ...unsigned }
}
/** Everything a drill could have written: every HEAD and Mirror object other than the live pair, and their row counts. */
const drillRows = fx => [...fx.headStorages, ...fx.mirrorStorages].filter(([name]) => name !== 'node-main-v1')
  .reduce((sum, [, storage]) => sum + storage.size(), 0)
/** The outside reviewer's reproduction: a withheld bundle with its marker removed and an owner row refilled, resealed. */
async function refilled(withheld, aumlokState) {
  const { ownerSecrets: _marker, sourceArchiveId: _source, ...rest } = structuredClone(withheld)
  return reseal({ ...rest, head: { ...rest.head, aumlokState } })
}
/** Only what the public owner summary discloses, shaped as a v2 row. */
const summaryOnlyRow = summary => ({ schema: 'aukora.aumlok.state.v2', binding: { aumlokId: summary.aumlokId, nodePubkeyHex: summary.nodePubkeyHex,
  credential: { id: summary.credentialId, publicKeyB64: summary.credentialPublicKeyB64, counter: summary.signerCounter }, generation: summary.generation } })
/** The same public fields, plus invented but well-formed recovery values: a row the AUMLOK store would load. */
const inventedRow = summary => ({ schema: 'aukora.aumlok.state.v2', generation: summary.generation,
  binding: { aumlokId: summary.aumlokId, recoveryCommitment: '9c'.repeat(32),
    rootEscrow: { schema: 'aukora.aumlok.escrow.v2', ivB64: Buffer.from('invented-iv!').toString('base64url'),
      ciphertextB64: Buffer.from('invented-escrow-ciphertext-of-forty-eight-bytes!!').toString('base64url') },
    nodePubkeyHex: summary.nodePubkeyHex, credential: { id: summary.credentialId, publicKeyB64: summary.credentialPublicKeyB64, counter: summary.signerCounter },
    boundAt: 1794340000000, lastVerifiedAt: 1794340000000, generation: summary.generation },
  'pepper.v1': Buffer.from('invented-pepper-thirty-two-byte!').toString('base64url'), challenges: [], invites: [], revocations: [],
  failures: 0, failedAt: [], nextAllowedAt: 0, attempts: [], approvals: [] })

test('every bundle a client hands the HTTP drill is refused at the route, and nothing is written anywhere', async () => {
  const fx = await fixture()
  const withheld = (await exportReply(await fx.call(ARCHIVE, EXPORT_BODY))).value.bundle
  const approved = await exportReply(await fx.call(ARCHIVE, EXPORT_BODY, { headers: { 'x-x6-class3-approval': await fx.approve() } }))
  assert.equal(approved.value.ownerSecrets, 'included', approved.text)
  const summaryOnly = await refilled(withheld, summaryOnlyRow(withheld.ownerSummary))
  const invented = await refilled(withheld, inventedRow(withheld.ownerSummary))
  // The reproduction is real at the summary level: both forgeries pass the archive's own offline verification.
  for (const forged of [summaryOnly, invented]) {
    const verified = await verifyColdArchive(forged, { expectedOwnerPublicKeyHex: fx.env.OWNER_PUBLIC_KEY_HEX })
    assert.equal(verified.ownerSummary.phase, 'BOUND')
  }
  const liveBefore = canonicalJson(await fx.liveRow())
  const snapshotsBefore = [...fx.r2.objects.keys()].sort()
  const cases = [
    ['stripped marker, summary-only owner row', { action: 'rebuild_drill', targetName: 'x61-drill-forged-summary', bundle: summaryOnly }],
    ['stripped marker, invented well-formed owner row', { action: 'rebuild_drill', targetName: 'x61-drill-forged-invented', bundle: invented }],
    ['untouched withheld bundle', { action: 'rebuild_drill', targetName: 'x61-drill-client-withheld', bundle: withheld }],
    ['full bundle supplied by a client', { action: 'rebuild_drill', targetName: 'x61-drill-client-full', bundle: approved.value.bundle }],
    ['a bundle beside a service key', { action: 'rebuild_drill', targetName: 'x61-drill-client-both', r2Key: approved.value.r2Key, bundle: approved.value.bundle }],
    ['a bundle with no drill name', { action: 'rebuild_drill', bundle: approved.value.bundle }],
    ['a bundle on export', { action: 'export', includeBundle: true, bundle: approved.value.bundle }],
    ['a bundle on status', { action: 'status', bundle: approved.value.bundle }],
    ['an empty bundle', { action: 'rebuild_drill', targetName: 'x61-drill-client-null', bundle: null }],
  ]
  for (const [name, body] of cases) {
    const reply = await exportReply(await fx.call(ARCHIVE, body))
    assert.equal(reply.status, 400, `${name}: ${reply.text}`)
    assert.equal(reply.value.code, 'ARCHIVE_CLIENT_BUNDLE_REFUSED', name)
    assert.equal(reply.value.ok, false, name)
    assert.deepEqual(leaks(reply.text), [], name)
    assert.equal(drillRows(fx), 0, `${name}: no drill row`)
    assert.deepEqual([...fx.headStorages.keys()], ['node-main-v1'], `${name}: no drill HEAD object was even made`)
    assert.deepEqual([...fx.mirrorStorages.keys()], ['node-main-v1'], `${name}: no drill Mirror object was even made`)
  }
  assert.equal(canonicalJson(await fx.liveRow()), liveBefore, 'the live owner row is untouched')
  assert.deepEqual([...fx.r2.objects.keys()].sort(), snapshotsBefore, 'nothing new in the bucket')
})

test('the library drill loads the owner row in the AUMLOK store first; a row it would not load leaves the target empty', async () => {
  const fx = await fixture()
  const exported = await exportReply(await fx.call(ARCHIVE, EXPORT_BODY))
  const full = JSON.parse(fx.r2.objects.get(exported.value.r2Key).text)
  const summaryOnly = await refilled(exported.value.bundle, summaryOnlyRow(full.ownerSummary))
  const drill = (targetName, bundle, targetHeadStorage = memoryStorage(), targetMirrorStorage = memoryStorage()) => ({ targetHeadStorage, targetMirrorStorage,
    run: () => runDisposableRebuildDrill({ targetName, bundle, targetHeadStorage, targetMirrorStorage, expectedOwnerPublicKeyHex: fx.env.OWNER_PUBLIC_KEY_HEX }) })

  const forged = drill('x61-drill-library-summary', summaryOnly)
  await assert.rejects(forged.run(), error => error.code === 'ARCHIVE_OWNER_RECORD_INVALID' && error.status === 409
    && error.ownerRecordCode === 'AUMLOK_STATE_CORRUPT')
  assert.equal(forged.targetHeadStorage.size() + forged.targetMirrorStorage.size(), 0, 'zero rows: refused before any write')
  await assert.rejects(verifyRestorableOwnerRecord(summaryOnly.head.aumlokState, { expectedOwnerPublicKeyHex: fx.env.OWNER_PUBLIC_KEY_HEX }),
    error => error.code === 'ARCHIVE_OWNER_RECORD_INVALID')

  const good = drill('x61-drill-library-full', full)
  const result = await good.run()
  assert.equal(result.ok, true)
  assert.equal(result.ownerPhase, 'BOUND')
  assert.equal(result.ownerCredentialId, fx.credentialId)
  // The restored HEAD store loads its own row, through the store's public surface.
  const restored = await createAumlokStore(good.targetHeadStorage, { origins: [ORIGIN], ownerPublicKeyHex: fx.env.OWNER_PUBLIC_KEY_HEX }).status()
  assert.equal(restored.phase, 'BOUND')
})

test('a drill by key from a service-held archive succeeds; one whose owner row is damaged in the bucket is refused with zero rows', async () => {
  const fx = await fixture()
  const exported = await exportReply(await fx.call(ARCHIVE, { action: 'export' }))
  assert.equal(exported.value.r2Stored, true, exported.text)
  const key = exported.value.r2Key
  const pristine = fx.r2.objects.get(key).text

  const ok = await exportReply(await fx.call(ARCHIVE, { action: 'rebuild_drill', targetName: 'x61-drill-service-held', r2Key: key }))
  assert.equal(ok.status, 200, ok.text)
  assert.equal(ok.value.ok, true)
  assert.equal(ok.value.ownerPhase, 'BOUND')
  assert.equal(ok.value.archiveId, exported.value.archiveId)
  assert.equal(drillRows(fx), 0, 'the disposable pair is wiped after a good drill')

  // Damaged in the bucket and resealed, so the digest, the owner summary and the composite head all still agree.
  const damages = [
    ['recovery commitment and escrow removed', row => { delete row.binding.recoveryCommitment; delete row.binding.rootEscrow }],
    ['pepper cut short', row => { row['pepper.v1'] = Buffer.from('too-short').toString('base64url') }],
    ['an unknown field added', row => { row.extra = true }],
  ]
  for (const [index, [name, damage]] of damages.entries()) {
    const bundle = JSON.parse(pristine)
    damage(bundle.head.aumlokState)
    fx.r2.objects.get(key).text = JSON.stringify(await reseal(bundle))
    await verifyColdArchive(JSON.parse(fx.r2.objects.get(key).text), { expectedOwnerPublicKeyHex: fx.env.OWNER_PUBLIC_KEY_HEX })
    const label = `x61-drill-damaged-${String(index)}`
    // 1d review: the label never names an object, so the checks are over every drill object, by any name.
    const headsBefore = [...fx.headStorages.keys()], mirrorsBefore = [...fx.mirrorStorages.keys()]
    const reply = await exportReply(await fx.call(ARCHIVE, { action: 'rebuild_drill', targetName: label, r2Key: key }))
    assert.equal(reply.status, 409, `${name}: ${reply.text}`)
    assert.equal(reply.value.code, 'ARCHIVE_OWNER_RECORD_INVALID', name)
    assert.equal(reply.value.ownerPhase, undefined, name)
    assert.deepEqual(leaks(reply.text), [], name)
    assert.equal(drillRows(fx), 0, `${name}: zero rows in every drill object`)
    assert.deepEqual([...fx.headStorages.keys()], headsBefore, `${name}: no drill HEAD object made`)
    assert.deepEqual([...fx.mirrorStorages.keys()], mirrorsBefore, `${name}: no drill Mirror object made`)
  }
  assert.equal(drillRows(fx), 0)

  // A key that is asked for is never swapped for the live state, and only the service's own snapshot keys are read.
  for (const [name, r2Key, code, status] of [
    ['missing snapshot', `snapshots/epoch-3-${'0'.repeat(64)}.json`, 'ARCHIVE_SNAPSHOT_NOT_FOUND', 503],
    ['a module object', `modules/${'0'.repeat(64)}.js`, 'ARCHIVE_R2_KEY_INVALID', 400],
    ['the latest pointer', 'snapshots/LATEST.json', 'ARCHIVE_R2_KEY_INVALID', 400],
    ['not a string', 7, 'ARCHIVE_R2_KEY_INVALID', 400],
  ]) {
    const reply = await exportReply(await fx.call(ARCHIVE, { action: 'rebuild_drill', targetName: 'x61-drill-key-checks', r2Key }))
    assert.equal(reply.status, status, `${name}: ${reply.text}`)
    assert.equal(reply.value.code, code, name)
  }
  delete fx.env.ARCHIVE_BUCKET
  const noBucket = await exportReply(await fx.call(ARCHIVE, { action: 'rebuild_drill', targetName: 'x61-drill-no-bucket', r2Key: key }))
  assert.equal(noBucket.status, 503, noBucket.text)
  assert.equal(noBucket.value.code, 'ARCHIVE_BUCKET_UNAVAILABLE')
  assert.equal(drillRows(fx), 0)
})

test('an approval whose body differs by one nested field releases nothing; one approval used twice at once gives one full reply and one 403', async () => {
  const fx = await fixture()
  const nested = await fx.approve({ body: { ...EXPORT_BODY, extra: { a: 1 } } })
  const reply = await exportReply(await fx.call(ARCHIVE, { ...EXPORT_BODY, extra: { a: 2 } }, { headers: { 'x-x6-class3-approval': nested } }))
  assert.equal(reply.status, 403, reply.text)
  assert.equal(reply.value.code, 'CLASS3_WEBAUTHN_REQUIRED')
  assert.deepEqual(leaks(reply.text), [])
  assert.equal([...fx.r2.objects.keys()].some(key => key.startsWith('snapshots/')), false)

  const twice = await fixture()
  const token = await twice.approve()
  const replies = await Promise.all([1, 2].map(async () => exportReply(await twice.call(ARCHIVE, EXPORT_BODY, { headers: { 'x-x6-class3-approval': token } }))))
  assert.deepEqual(replies.map(r => r.status).sort(), [200, 403], replies.map(r => r.text.slice(0, 200)).join(' | '))
  const full = replies.find(r => r.status === 200), refused = replies.find(r => r.status === 403)
  assert.equal(full.value.ownerSecrets, 'included')
  assert.equal(refused.value.code, 'CLASS3_WEBAUTHN_REQUIRED')
  assert.deepEqual(leaks(refused.text), [])
})

test('archive status is owner-only; a non-owner session gets 403 and none of his credential metadata', async () => {
  const fx = await fixture()
  const guest = { cookie: 'CF_Authorization=fixture-guest' }
  const owned = [fx.credentialId, 'a1'.repeat(32), fx.nodePubkeyHex]
  for (const [name, reply] of [
    ['guest GET', await exportReply(await fx.call(ARCHIVE, undefined, { headers: guest }))],
    ['guest POST status', await exportReply(await fx.call(ARCHIVE, { action: 'status' }, { headers: guest }))],
    ['guest drill', await exportReply(await fx.call(ARCHIVE, { action: 'rebuild_drill' }, { headers: guest }))],
  ]) {
    assert.equal(reply.status, 403, `${name}: ${reply.text}`)
    assert.equal(reply.value.code, 'OWNER_ACCESS_REQUIRED', name)
    assert.deepEqual(owned.filter(value => reply.text.includes(value)), [], name)
    assert.deepEqual(leaks(reply.text), [], name)
  }
  const owner = await exportReply(await fx.call(ARCHIVE))
  assert.equal(owner.status, 200, owner.text)
  assert.equal(owner.value.ownerSummary.credentialId, fx.credentialId)
  assert.deepEqual(leaks(owner.text), [])
})
