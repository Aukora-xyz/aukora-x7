/**
 * The archive status stays within the Worker's limits, export and drill refuse a home too
 * large for one piece with a plain code before any body is read, a mirror list past its ceiling is refused instead of cut
 * short, and a drill reports its cleanup only when both disposable objects are proven empty.
 *
 * Drives the real Worker, HEAD and Mirror objects over in-memory storage, with MADE-UP values only. The large store has
 * 4,210 files of made-up sizes (fixtures/cold-archive/home-sizes.json, a fixed synthetic list of sizes).
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import { isoCBOR } from '@simplewebauthn/server/helpers'
import { createReceiptChainFixture } from './fixtures/cold-archive/receipt-chain.mjs'
import { createWorker } from '../worker.mjs'
import { X61HeadDurableObject, canonicalBootstrap, digest, manifestId, BOOTSTRAP_VERSION } from '../head-do.mjs'
import { MirrorDO } from '../mirror-do.mjs'
import { AUMLOK_STORAGE_KEY, aumlokClass3Binding, createAumlokStore } from '../aumlok.mjs'
import { canonicalJson } from '../owner-grant-policy.mjs'
// A namespace import, so a missing export fails its own test instead of the whole file.
import * as archive from '../cold-archive.mjs'

const ORIGIN = 'https://x61.example.invalid'
const ARCHIVE = '/_host/archive'
const LIVE = 'node-main-v1'
const RECEIPTS_PATH = '/dsh/home/auma/seed/receipts.v3.jsonl'
const CHECKPOINTS_PATH = '/dsh/home/auma/seed/checkpoints.v1.jsonl'
const EXPORT_BODY = Object.freeze({ action: 'export', includeBundle: true })
const MIB = 1024 * 1024
const HOME_SIZES = JSON.parse(readFileSync(new URL('./fixtures/cold-archive/home-sizes.json', import.meta.url), 'utf8'))
const MADE_UP_PEPPER = Buffer.from('bounded-made-up-pepper-32-bytes!').toString('base64url')
const MADE_UP_COMMITMENT = 'b1'.repeat(32)
const SECRET_MARKERS = ['aumlokState', 'pepper.v1', 'recoveryCommitment', 'rootEscrow', MADE_UP_PEPPER, MADE_UP_COMMITMENT]

const clone = value => structuredClone(value)
const sha = value => createHash('sha256').update(value).digest()
const rowId = path => createHash('sha256').update(JSON.stringify(path)).digest('hex')
const chunkPrefixOf = path => `mirror:v2:chunk:${rowId(path)}:`
const leaks = text => SECRET_MARKERS.filter(marker => text.includes(marker))
const byPath = ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)

/** Durable Object storage double. The live pair logs every chunk key it is asked for and every list prefix. */
function memoryStorage(log = null) {
  const data = new Map()
  let alarm = null
  const storage = {
    get: async key => {
      if (log && typeof key === 'string' && key.startsWith('mirror:v2:chunk:')) log.chunkReads.push(key)
      return data.has(key) ? clone(data.get(key)) : undefined
    },
    put: async (key, value) => { data.set(key, clone(value)) },
    delete: async key => data.delete(key),
    deleteAll: async () => { data.clear(); alarm = null },
    // 1d: `startAfter` pages as the Durable Object storage does; the live pair logs how many rows each list returned.
    list: async ({ prefix = '', limit = Infinity, startAfter } = {}) => {
      const keys = [...data.keys()].filter(key => key.startsWith(prefix) && (startAfter === undefined || key > startAfter)).sort().slice(0, limit)
      if (log) { log.lists.push(prefix); log.listedRows.push({ prefix, rows: keys.length }) }
      return new Map(keys.map(key => [key, clone(data.get(key))]))
    },
    getAlarm: async () => alarm, setAlarm: async at => { alarm = at }, deleteAlarm: async () => { alarm = null },
    transaction: async operation => operation(storage),
    size: () => data.size,
  }
  return storage
}

function memoryR2() {
  const objects = new Map()
  const stats = { puts: 0, textReads: [] }
  const meta = key => ({ key, size: Buffer.byteLength(objects.get(key).text), uploaded: objects.get(key).uploaded })
  return {
    objects, stats,
    async put(key, value) { stats.puts++; objects.set(key, { text: typeof value === 'string' ? value : new TextDecoder().decode(value), uploaded: new Date(1794350000000) }) },
    async get(key) {
      if (!objects.has(key)) return null
      const { text } = objects.get(key)
      return { ...meta(key), body: new Response(text).body, text: async () => { stats.textReads.push(key); return text }, json: async () => JSON.parse(text) }
    },
    async head(key) { return objects.has(key) ? meta(key) : null },
    async list({ prefix = '', limit = 1000 } = {}) {
      const keys = [...objects.keys()].filter(key => key.startsWith(prefix)).sort()
      return { objects: keys.slice(0, limit).map(meta), truncated: keys.length > limit }
    },
  }
}

/** A DO namespace whose stubs record every call and reply size, and let a test stand in for one route. */
function namespace(kind, make, storages, log) {
  const stubs = new Map()
  return {
    idFromName: name => name,
    get: name => {
      if (!stubs.has(name)) {
        const storage = memoryStorage(name === LIVE ? log : null)
        storages.set(name, storage)
        // 1d: a drill's objects are named per attempt, so a test reaches them as they are made, not by a name it chose.
        log.onStorage?.(kind, name, storage)
        const real = make(storage)
        const fetch = async (input, init) => {
          const request = input instanceof Request ? input : new Request(input, init)
          const path = new URL(request.url).pathname
          log.calls.push({ kind, name, path })
          const override = log.overrides.get(`${kind} ${path}`)
          if (override) return override(request, real)
          const response = await real.fetch(request)
          const text = await response.text()
          log.replies.push({ kind, name, path, bytes: Buffer.byteLength(text) })
          return new Response(text, { status: response.status, headers: response.headers })
        }
        stubs.set(name, new Proxy(real, { get: (target, prop) => {
          if (prop === 'fetch') return fetch
          const value = Reflect.get(target, prop)
          return typeof value === 'function' ? value.bind(target) : value
        } }))
      }
      return stubs.get(name)
    },
  }
}

/** The C2 fixture's 68 organ modules (cold-archive.test.mjs), as a ball and its code. */
async function organModules() {
  const sources = []
  for (let i = 0; i < 68; i++) {
    const organId = i === 0 ? 'seed-pearl' : `organ-${String(i).padStart(2, '0')}`
    sources.push([organId, `export const organ = ${JSON.stringify(organId)}; export const rev = ${67 + i};\n`])
  }
  return modulesBall(sources)
}

/** A ball over [[organId, source]]. */
async function modulesBall(sources) {
  const codeBySha = {}, modules = {}, entries = {}
  for (const [organId, source] of sources) {
    const moduleSha = await digest(source)
    codeBySha[moduleSha] = source
    modules[moduleSha] = { sha256: moduleSha, specifier: `ball:${moduleSha}`, size: Buffer.byteLength(source) }
    entries[organId] = { id: organId, specifier: `ball:${moduleSha}`, disabled: false, config: {}, previousSpecifiers: [] }
  }
  const draft = { version: 'x6.1-ball/v1', epoch: 167, parentBallId: '44'.repeat(32), createdAt: '2026-11-11T00:00:00.000Z',
    authorPeerId: 'auma-live-body', entries, modules }
  return { ball: { ...draft, ballId: await manifestId(draft) }, codeBySha }
}

/**
 * A world bootstrapped through the real `/_bootstrap`: the C2 fixture's modules, mirror files and receipt chain, and a
 * made-up legacy BOUND owner row his made-up passkey can approve with. `large` adds 4,208 files of made-up sizes.
 */
async function buildWorld({ large = false, sources = null } = {}) {
  const { receiptsText, checkpointsText } = createReceiptChainFixture()
  const owner = generateKeyPairSync('ed25519'), node = generateKeyPairSync('ed25519')
  const passkey = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const ownerPublicKeyHex = owner.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex')
  const nodePubkeyHex = node.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex')
  const jwk = passkey.publicKey.export({ format: 'jwk' })
  const credentialId = randomBytes(32).toString('base64url')
  const { ball, codeBySha } = sources ? await modulesBall(sources) : await organModules()

  const file = b64 => ({ kind: 'file', mode: 0o644, mtimeMs: 1794348000000, b64 })
  const mirrorEntries = [
    ['/dsh/home/auma', { kind: 'dir', mode: 0o755 }],
    ['/dsh/home/auma/HANDOFF.md', file(Buffer.from(`# HANDOFF\nepoch: ${ball.epoch}\nballId: ${ball.ballId}\n`).toString('base64'))],
    ['/dsh/home/auma/index', { kind: 'dir', mode: 0o755 }],
    ['/dsh/home/auma/index/RECALL.md', file(Buffer.from('# RECALL\n- Epoch 165 promoted with owner Touch ID.\n').toString('base64'))],
    ['/dsh/home/auma/seed', { kind: 'dir', mode: 0o755 }],
    [CHECKPOINTS_PATH, file(Buffer.from(checkpointsText).toString('base64'))],
    [RECEIPTS_PATH, file(Buffer.from(receiptsText).toString('base64'))],
  ]
  if (large) {
    const dirs = 88
    for (let d = 0; d < dirs; d++) mirrorEntries.push([`/dsh/home/auma/m${String(d).padStart(4, '0')}`, { kind: 'dir', mode: 0o755 }])
    for (let i = 0; i < 4206; i++) {
      const bytes = HOME_SIZES[i % HOME_SIZES.length]
      mirrorEntries.push([`/dsh/home/auma/m${String(i % dirs).padStart(4, '0')}/f${String(i).padStart(5, '0')}.md`,
        file(Buffer.alloc(bytes, 0x61 + (i % 26)).toString('base64'))])
    }
  }
  mirrorEntries.sort(byPath)
  const batches = []
  let batch = [], batchChars = 0
  for (const entry of mirrorEntries) {
    const chars = entry[1].b64?.length ?? 0
    if (batch.length && (batchChars + chars > 6e6 || batch.length >= 5000)) { batches.push(batch); batch = []; batchChars = 0 }
    batch.push(entry); batchChars += chars
  }
  if (batch.length) batches.push(batch)
  const batchDigests = []
  for (const value of batches) batchDigests.push(await digest(canonicalBootstrap(value)))
  const seedPayload = { version: BOOTSTRAP_VERSION, ball, codeBySha, mirror: { entryCount: mirrorEntries.length, batchDigests } }
  const seedId = await digest(canonicalBootstrap(seedPayload))

  const log = { calls: [], replies: [], chunkReads: [], lists: [], listedRows: [], overrides: new Map(), onStorage: null }
  log.reset = () => { log.calls.length = 0; log.replies.length = 0; log.chunkReads.length = 0; log.lists.length = 0; log.listedRows.length = 0 }
  const headStorages = new Map(), mirrorStorages = new Map()
  const r2 = memoryR2()
  const env = {
    PUBLIC_HOST: new URL(ORIGIN).host,
    OWNER_EMAIL: 'owner@example.invalid',
    OWNER_PUBLIC_KEY_HEX: ownerPublicKeyHex,
    ARCHIVE_BUCKET: r2,
    ASSETS: { fetch: () => new Response('fixture asset') },
  }
  env.HEAD = namespace('HEAD', storage => new X61HeadDurableObject({ storage, getWebSockets: () => [] }, env), headStorages, log)
  env.MIRROR = namespace('MIRROR', storage => new MirrorDO({ storage }, env), mirrorStorages, log)
  const worker = createWorker({
    verifyAccess: async request => request.headers.get('cookie') === 'CF_Authorization=fixture-owner'
      ? { type: 'owner', email: env.OWNER_EMAIL, expires: Math.floor(Date.now() / 1000) + 3600 } : null,
    networkFetch: async () => { throw new Error('External network is forbidden in this fixture') },
  })
  const call = (pathname, value, { headers = {} } = {}) => {
    const all = new Headers({ cookie: 'CF_Authorization=fixture-owner', origin: ORIGIN, 'sec-fetch-site': 'same-origin',
      ...(value === undefined ? {} : { 'content-type': 'application/json' }) })
    for (const [name, entry] of Object.entries(headers)) all.set(name, entry)
    return worker.fetch(new Request(new URL(pathname, ORIGIN), { method: value === undefined ? 'GET' : 'POST', headers: all,
      ...(value === undefined ? {} : { body: JSON.stringify(value) }) }), env)
  }
  for (const input of [{ action: 'prepare', package: { ...seedPayload, seedId } },
    ...batches.map((entries, index) => ({ action: 'batch', seedId, index, entries })), { action: 'commit', seedId }]) {
    const response = await call('/_bootstrap', input)
    assert.equal(response.status, 200, await response.text())
  }

  const at = Date.now()
  await headStorages.get(LIVE).put(AUMLOK_STORAGE_KEY, {
    schema: 'aukora.aumlok.state.v2', generation: 1,
    binding: { aumlokId: 'a1'.repeat(32), recoveryCommitment: MADE_UP_COMMITMENT,
      rootEscrow: { schema: 'aukora.aumlok.escrow.v2', ivB64: Buffer.from('bounded-iv12').toString('base64url'),
        ciphertextB64: Buffer.from('bounded-made-up-escrow-ciphertext-48-bytes-long!').toString('base64url') },
      nodePubkeyHex,
      credential: { id: credentialId, counter: 0, publicKeyB64: Buffer.from(isoCBOR.encode(new Map([
        [1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')],
      ]))).toString('base64url') },
      boundAt: at - 3600000, lastVerifiedAt: at - 3600000, generation: 1 },
    'pepper.v1': MADE_UP_PEPPER, challenges: [], invites: [], revocations: [],
    failures: 0, failedAt: [], nextAllowedAt: 0, attempts: [], approvals: [],
  })

  let sequence = 0
  const approve = async ({ body = EXPORT_BODY } = {}) => {
    const store = createAumlokStore(headStorages.get(LIVE), { origins: [ORIGIN], ownerPublicKeyHex })
    const binding = await aumlokClass3Binding({ audience: ORIGIN, method: 'POST', pathname: ARCHIVE, body })
    const challenge = await store.challenge({ purpose: 'approve', requestId: `bounded-approval-${++sequence}`, binding }, ORIGIN)
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
  const seedBytes = Buffer.byteLength(receiptsText) + Buffer.byteLength(checkpointsText)
  const files = mirrorEntries.filter(([, wire]) => wire.kind === 'file')
  log.reset()
  return { env, worker, call, approve, r2, log, ball, codeBySha, seedId, headStorages, mirrorStorages, seedBytes, mirrorEntries, files, receiptsText, checkpointsText }
}

let largeWorld = null
const large = () => (largeWorld ??= buildWorld({ large: true }))

async function exportReply(response) {
  const text = await response.text()
  return { status: response.status, text, value: JSON.parse(text) }
}
/** Rows in every HEAD and Mirror object other than the live pair. */
const drillRows = fx => [...fx.headStorages, ...fx.mirrorStorages].filter(([name]) => name !== LIVE).reduce((sum, [, storage]) => sum + storage.size(), 0)
// 1d: the name a drill attempt gives its own objects (`x61-drill-` and its attempt id), and the objects made so far.
const ATTEMPT_OBJECT = /^x61-drill-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const drillNames = fx => [...new Set([...fx.headStorages.keys(), ...fx.mirrorStorages.keys()])].filter(name => name !== LIVE)
/** Every drill Mirror object made from now on refuses deleteAll, as a failed wipe would. */
const failDrillMirrorWipes = fx => {
  fx.log.onStorage = (kind, name, storage) => {
    if (kind === 'MIRROR' && name !== LIVE) storage.deleteAll = async () => { throw new Error('test: deleteAll refused') }
  }
}
/** The one drill object this world has made; it is an attempt's own name, never the label the caller gave. */
const onlyDrillName = (fx, label) => {
  const names = drillNames(fx)
  assert.equal(names.length, 1, names.join(', '))
  assert.match(names[0], ATTEMPT_OBJECT)
  assert.notEqual(names[0], label)
  return names[0]
}
const internal = (binding, name, path, body) => binding.get(name).fetch(new Request(`https://x61.internal${path}`, {
  method: body === undefined ? 'GET' : 'POST',
  headers: { 'x-x6-internal-authorized': '1', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
}))

/** Today's status, computed the way an earlier commit computes it: both whole archive-state replies, then the summaries. */
async function statusTheOldWay(fx) {
  const head = await (await internal(fx.env.HEAD, LIVE, '/_head/archive-state')).json()
  const mirror = await (await internal(fx.env.MIRROR, LIVE, '/_mirror/archive-state')).json()
  const text = path => {
    const found = mirror.entries.find(([p, wire]) => p === path && wire.kind === 'file')
    return found ? Buffer.from(found[1].b64, 'base64').toString('utf8') : null
  }
  const receiptsSummary = await archive.verifyArchiveReceiptChain(text(RECEIPTS_PATH), text(CHECKPOINTS_PATH) ?? '')
  const ownerSummary = archive.extractBoundOwnerSummary(head.aumlokState, fx.env.OWNER_PUBLIC_KEY_HEX)
  const liveCompositeHead = await archive.computeCompositeHeadCommitment({ head: head.ball, codeBySha: head.codeBySha, ownerSummary, receiptsSummary })
  const latest = fx.r2.objects.get('snapshots/LATEST.json')
  return JSON.parse(JSON.stringify({ ok: true, coldR2BackupConfigured: true, latestR2Snapshot: latest ? JSON.parse(latest.text) : null,
    liveCompositeHead, ownerSummary, receiptsSummary }))
}

test('status on a 4,210-file store reads metadata and the two seed files only; no DO reply carries a bundle', { timeout: 600000 }, async () => {
  const fx = await large()
  assert.equal(fx.files.length, 4210)
  fx.log.reset()
  const reply = await exportReply(await fx.call(ARCHIVE))
  assert.equal(reply.status, 200, reply.text.slice(0, 300))
  const paths = fx.log.calls.map(entry => entry.path)
  assert.equal(paths.includes('/_head/archive-state'), false, 'status never asks HEAD for its whole state')
  assert.equal(paths.includes('/_mirror/archive-state'), false, 'status never asks the Mirror for every body')
  const seeds = [chunkPrefixOf(RECEIPTS_PATH), chunkPrefixOf(CHECKPOINTS_PATH)]
  assert.deepEqual(fx.log.chunkReads.filter(key => !seeds.some(prefix => key.startsWith(prefix))), [], 'no body chunk is read but the two seed files')
  assert.deepEqual(fx.log.lists.filter(prefix => 'mirror:v2:chunk:'.startsWith(prefix)), [], 'no list walks the chunk rows')
  const ceiling = 2 * MIB + fx.seedBytes
  assert.deepEqual(fx.log.replies.filter(entry => entry.bytes > ceiling), [], `every DO reply is at most ${ceiling} bytes`)
  assert.deepEqual(leaks(reply.text), [])
  const bodyB64Bytes = fx.files.reduce((sum, [, wire]) => sum + wire.b64.length, 0)
  const moduleBytes = Object.values(fx.codeBySha).reduce((sum, code) => sum + Buffer.byteLength(code), 0)
  const { serializedBytesAtMost, ...counts } = reply.value.plan
  assert.deepEqual(counts, { entries: fx.mirrorEntries.length, files: 4210, bodyB64Bytes,
    largestFileB64: Math.max(...fx.files.map(([, wire]) => wire.b64.length)), moduleCount: 68, moduleBytes, withinOnePiece: false })
  // 1b: the estimate bounds, from above and within the exportedAt allowance, the bytes an export of this store serializes.
  const whole = await archive.exportColdArchive({ headStorage: fx.headStorages.get(LIVE), mirrorStorage: fx.mirrorStorages.get(LIVE),
    expectedOwnerPublicKeyHex: fx.env.OWNER_PUBLIC_KEY_HEX })
  const exact = Buffer.byteLength(JSON.stringify(whole.bundle))
  assert.ok(exact <= serializedBytesAtMost && serializedBytesAtMost - exact <= 24, `${exact} <= ${serializedBytesAtMost}`)
  assert.equal(reply.value.ownerSummary.phase, 'BOUND')
  assert.equal(reply.value.receiptsSummary.receiptCount, 87)
  assert.equal(reply.value.liveCompositeHead.moduleCount, 68)
})

test('on the C2-shaped store, status keeps its five fields exactly as today\'s code computes them, and adds the plan', async () => {
  const fx = await buildWorld()
  const exported = await exportReply(await fx.call(ARCHIVE, { action: 'export' }))
  assert.equal(exported.status, 200, exported.text)
  const before = await statusTheOldWay(fx)
  assert.notEqual(before.latestR2Snapshot, null)
  const reply = await exportReply(await fx.call(ARCHIVE))
  assert.equal(reply.status, 200, reply.text)
  const { plan, ...fields } = reply.value
  assert.deepEqual(fields, before)
  const bodyB64Bytes = fx.files.reduce((sum, [, wire]) => sum + wire.b64.length, 0)
  const moduleBytes = Object.values(fx.codeBySha).reduce((sum, code) => sum + Buffer.byteLength(code), 0)
  const { serializedBytesAtMost, ...counts } = plan
  assert.deepEqual(counts, { entries: 7, files: 4, bodyB64Bytes, largestFileB64: Math.max(...fx.files.map(([, wire]) => wire.b64.length)),
    moduleCount: 68, moduleBytes, withinOnePiece: true })
  const written = Buffer.byteLength(fx.r2.objects.get(exported.value.r2Key).text)
  assert.ok(written <= serializedBytesAtMost && serializedBytesAtMost - written <= 24, `${written} <= ${serializedBytesAtMost}`)
  assert.deepEqual(leaks(reply.text), [])
})

test('compositeFromInventory over moduleInventoryOf equals computeCompositeHeadCommitment (C2 modules, and a non-ASCII module set)', async () => {
  assert.equal(typeof archive.moduleInventoryOf, 'function')
  assert.equal(typeof archive.compositeFromInventory, 'function')
  const { receiptsText, checkpointsText } = createReceiptChainFixture()
  const receiptsSummary = await archive.verifyArchiveReceiptChain(receiptsText, checkpointsText)
  const ownerSummary = { schema: 'aukora.x61.owner-record.v1', phase: 'BOUND', ownerPublicKeyHex: '11'.repeat(32), aumlokId: '33'.repeat(32),
    nodePubkeyHex: '22'.repeat(32), credentialId: 'made-up-credential', credentialPublicKeyB64: 'bWFkZS11cA', signerCounter: 7, generation: 1 }

  const c2 = await organModules()
  const sources = ['export const greeting = "Grüße aus 東京 🌏"\n', 'export const plain = 1\n', '// ünïcödé comment only\n']
  const codeBySha = {}, modules = {}, entries = {}
  for (const [index, source] of sources.entries()) {
    const moduleSha = await digest(source)
    codeBySha[moduleSha] = source
    modules[moduleSha] = { sha256: moduleSha, specifier: `ball:${moduleSha}`, size: Buffer.byteLength(source) }
    entries[`organ-${index}`] = { id: `organ-${index}`, specifier: `ball:${moduleSha}`, disabled: false, config: {}, previousSpecifiers: [] }
  }
  const draft = { version: 'x6.1-ball/v1', epoch: 9, parentBallId: null, createdAt: '2026-11-12T00:00:00.000Z', authorPeerId: 'bounded', entries, modules }
  const unicode = { ball: { ...draft, ballId: await manifestId(draft) }, codeBySha }

  for (const { ball, codeBySha: code } of [c2, unicode]) {
    const moduleInventory = await archive.moduleInventoryOf(code)
    assert.deepEqual(moduleInventory, Object.keys(code).sort().map(key => [key, Buffer.byteLength(code[key])]))
    const fromInventory = await archive.compositeFromInventory({ head: ball, moduleInventory, ownerSummary, receiptsSummary })
    const whole = await archive.computeCompositeHeadCommitment({ head: ball, codeBySha: code, ownerSummary, receiptsSummary })
    assert.deepEqual(fromInventory, whole)
    // An inventory that leaves a module out, or names another, is refused.
    await assert.rejects(archive.compositeFromInventory({ head: ball, moduleInventory: moduleInventory.slice(1), ownerSummary, receiptsSummary }),
      { code: 'ARCHIVE_MODULE_MISSING' })
    await assert.rejects(archive.compositeFromInventory({ head: ball, moduleInventory: [['f'.repeat(64), 1], ...moduleInventory.slice(1)], ownerSummary, receiptsSummary }),
      { code: 'ARCHIVE_MODULE_MISSING' })
  }
  assert.notEqual(Buffer.byteLength(sources[0]), sources[0].length, 'the inventory counts UTF-8 bytes, not UTF-16 units')
})

test('on the 4,210-file store, export and the live drill answer 413 with zero bucket writes and zero drill rows; a drill by key refuses an oversized object before reading it', { timeout: 600000 }, async () => {
  const fx = await large()
  const putsBefore = fx.r2.stats.puts
  fx.log.reset()
  const exported = await exportReply(await fx.call(ARCHIVE, { action: 'export' }))
  assert.equal(exported.status, 413, exported.text.slice(0, 300))
  assert.equal(exported.value.code, 'ARCHIVE_TOO_LARGE_FOR_ONE_PIECE')
  const drill = await exportReply(await fx.call(ARCHIVE, { action: 'rebuild_drill', targetName: 'x61-drill-bounded-live' }))
  assert.equal(drill.status, 413, drill.text.slice(0, 300))
  assert.equal(drill.value.code, 'ARCHIVE_TOO_LARGE_FOR_ONE_PIECE')
  assert.equal(fx.r2.stats.puts, putsBefore, 'nothing written to the bucket')
  assert.equal(drillRows(fx), 0, 'nothing applied to a drill object')
  assert.equal(fx.log.calls.some(entry => entry.path.endsWith('/archive-state') || entry.path.endsWith('/archive-drill-apply')), false, 'no body was read')
  const seeds = [chunkPrefixOf(RECEIPTS_PATH), chunkPrefixOf(CHECKPOINTS_PATH)]
  assert.deepEqual(fx.log.chunkReads.filter(key => !seeds.some(prefix => key.startsWith(prefix))), [])

  const key = `snapshots/epoch-${String(fx.ball.epoch)}-${fx.ball.ballId}.json`
  fx.r2.objects.set(key, { text: 'x'.repeat(16 * MIB + 1), uploaded: new Date(1794350000000) })
  const byKey = await exportReply(await fx.call(ARCHIVE, { action: 'rebuild_drill', targetName: 'x61-drill-bounded-key', r2Key: key }))
  assert.equal(byKey.status, 413, byKey.text.slice(0, 300))
  assert.equal(byKey.value.code, 'ARCHIVE_TOO_LARGE_FOR_ONE_PIECE')
  assert.deepEqual(fx.r2.stats.textReads, [], 'the oversized object was never read')
  assert.equal(drillRows(fx), 0)
  fx.r2.objects.delete(key)
})

test('on the 4,210-file store, an export with includeBundle and a valid approval is refused 413 and writes nothing; the approval was judged first and is spent', { timeout: 600000 }, async () => {
  const fx = await large()
  const putsBefore = fx.r2.stats.puts
  const token = await fx.approve()
  const reply = await exportReply(await fx.call(ARCHIVE, EXPORT_BODY, { headers: { 'x-x6-class3-approval': token } }))
  assert.equal(reply.status, 413, reply.text.slice(0, 300))
  assert.equal(reply.value.code, 'ARCHIVE_TOO_LARGE_FOR_ONE_PIECE')
  assert.deepEqual(leaks(reply.text), [])
  assert.equal(fx.r2.stats.puts, putsBefore)
  assert.equal([...fx.r2.objects.keys()].some(key => key.startsWith('snapshots/')), false)
  // The export's order holds: the approval is judged (and consumed) before anything is read, so the same approval is now spent.
  const again = await exportReply(await fx.call(ARCHIVE, EXPORT_BODY, { headers: { 'x-x6-class3-approval': token } }))
  assert.equal(again.status, 403, again.text.slice(0, 300))
  assert.equal(again.value.code, 'CLASS3_WEBAUTHN_REQUIRED')
})

test('20,001 directory rows, or 20,001 reset rows, are refused with ARCHIVE_TOO_MANY_ENTRIES, never cut short', { timeout: 120000 }, async () => {
  for (const kind of ['entry', 'reset']) {
    const fx = await buildWorld()
    const mirror = fx.mirrorStorages.get(LIVE)
    for (let i = 0; i < 20001; i++) {
      const path = `/dsh/home/auma/many/d${String(i).padStart(5, '0')}`
      if (kind === 'entry') await mirror.put(`mirror:v2:entry:${rowId(path)}`, { path, kind: 'dir', mode: 0o755 })
      else await mirror.put(`mirror:v2:reset:${rowId(path)}`, path)
    }
    const status = await exportReply(await fx.call(ARCHIVE))
    assert.equal(status.status, 413, `${kind}: ${status.text.slice(0, 300)}`)
    assert.equal(status.value.code, 'ARCHIVE_TOO_MANY_ENTRIES', kind)
    const exported = await exportReply(await fx.call(ARCHIVE, { action: 'export' }))
    assert.equal(exported.status, 413, kind)
    assert.equal(exported.value.code, 'ARCHIVE_TOO_MANY_ENTRIES', kind)
    assert.equal(fx.r2.stats.puts, 0, kind)
    for (const path of ['/_mirror/archive-state', '/_mirror/archive-plan']) {
      const reply = await internal(fx.env.MIRROR, LIVE, path)
      assert.equal(reply.status, 413, `${kind} ${path}`)
      assert.equal((await reply.json()).code, 'ARCHIVE_TOO_MANY_ENTRIES', `${kind} ${path}`)
    }
    await assert.rejects(archive.exportColdArchive({ headStorage: fx.headStorages.get(LIVE), mirrorStorage: mirror, expectedOwnerPublicKeyHex: fx.env.OWNER_PUBLIC_KEY_HEX }),
      { code: 'ARCHIVE_TOO_MANY_ENTRIES' })
  }
})

test('a drill whose Mirror wipe throws is refused with DRILL_CLEANUP_PENDING, never reported clean', async () => {
  const fx = await buildWorld()
  const label = 'x61-drill-bounded-wipe-throws'
  failDrillMirrorWipes(fx)
  const reply = await exportReply(await fx.call(ARCHIVE, { action: 'rebuild_drill', targetName: label }))
  assert.equal(reply.status, 503, reply.text)
  assert.equal(reply.value.code, 'DRILL_CLEANUP_PENDING')
  assert.equal(reply.value.disposableStorageCleanedUp, undefined)
  const target = onlyDrillName(fx, label)
  assert.equal(fx.headStorages.get(target).size(), 0, 'the HEAD drill object was still wiped')
  assert.ok(fx.mirrorStorages.get(target).size() > 0, 'the rows the wipe left are really there')
})

test('a drill whose HEAD wipe never answers is refused with DRILL_CLEANUP_PENDING at its deadline', { timeout: 30000 }, async () => {
  const fx = await buildWorld()
  fx.log.overrides.set('HEAD /_head/archive-drill-wipe', () => new Promise(() => {}))
  const started = Date.now()
  await assert.rejects(archive.executeEdgeArchiveOperation({ env: fx.env, seedId: fx.seedId, input: { action: 'rebuild_drill', targetName: 'x61-drill-bounded-stalled' },
    drillWipeDeadlineMs: 50 }), error => error.code === 'DRILL_CLEANUP_PENDING' && error.status === 503)
  assert.ok(Date.now() - started < 10000, 'refused at the injected deadline, not after it')
  assert.equal(fx.mirrorStorages.get(onlyDrillName(fx, 'x61-drill-bounded-stalled')).size(), 0, 'the Mirror drill object answered and is empty')
})

test('the C2-shaped drill still reports a clean pair; the wipe proves the object empty and clears its alarm', async () => {
  const fx = await buildWorld()
  const live = await exportReply(await fx.call(ARCHIVE, { action: 'rebuild_drill', targetName: 'x61-drill-bounded-clean' }))
  assert.equal(live.status, 200, live.text)
  assert.equal(live.value.disposableStorageCleanedUp, true)
  assert.equal(live.value.ownerPhase, 'BOUND')
  assert.equal(drillRows(fx), 0)
  const exported = await exportReply(await fx.call(ARCHIVE, { action: 'export' }))
  const byKey = await exportReply(await fx.call(ARCHIVE, { action: 'rebuild_drill', targetName: 'x61-drill-bounded-key-clean', r2Key: exported.value.r2Key }))
  assert.equal(byKey.status, 200, byKey.text)
  assert.equal(byKey.value.disposableStorageCleanedUp, true)
  assert.equal(drillRows(fx), 0)

  for (const [binding, storages, path] of [[fx.env.HEAD, fx.headStorages, '/_head/archive-drill-wipe'], [fx.env.MIRROR, fx.mirrorStorages, '/_mirror/archive-drill-wipe']]) {
    const name = 'x61-drill-bounded-direct'
    binding.get(name)
    await storages.get(name).put('leftover', 1)
    await storages.get(name).setAlarm(1794350000000)
    const reply = await internal(binding, name, path, { targetName: name })
    assert.equal(reply.status, 200, path)
    assert.deepEqual(await reply.json(), { ok: true, wiped: true, remainingRows: 0 }, path)
    assert.equal(storages.get(name).size(), 0, path)
    assert.equal(await storages.get(name).getAlarm(), null, path)
  }
})

test('a drill whose read-back fails still wipes both objects and still answers with its own code', async () => {
  const fx = await buildWorld()
  fx.log.overrides.set('HEAD /_head/archive-drill-apply', async (request, real) => {
    const value = await (await real.fetch(request)).json()
    return Response.json({ ...value, moduleCount: value.moduleCount + 1 })
  })
  const reply = await exportReply(await fx.call(ARCHIVE, { action: 'rebuild_drill', targetName: 'x61-drill-bounded-parity' }))
  assert.equal(reply.status, 503, reply.text)
  assert.equal(reply.value.code, 'DRILL_READBACK_PARITY_FAILED')
  assert.equal(drillRows(fx), 0)
})

// one bound for "one piece", measured on the serialized snapshot where it is written.
const ONE_PIECE = 16 * MIB
const MIRROR_CHUNK_CHARS = 96 * 1024
const snapshotKeys = fx => [...fx.r2.objects.keys()].filter(key => key.startsWith('snapshots/'))

/** One file row and its chunks, written straight into the live Mirror in the shape the Mirror stores them. */
async function putMirrorFile(fx, path, content, { mode = 0o644, mtimeMs = 1794348000000 } = {}) {
  const storage = fx.mirrorStorages.get(LIVE)
  const id = rowId(path)
  for (const key of (await storage.list({ prefix: `mirror:v2:chunk:${id}:` })).keys()) await storage.delete(key)
  const raw = typeof content === 'number' ? Buffer.alloc(content, 0x62) : Buffer.from(content)
  const b64 = raw.toString('base64')
  const chunks = Math.ceil(b64.length / MIRROR_CHUNK_CHARS)
  for (let i = 0; i < chunks; i++) await storage.put(`mirror:v2:chunk:${id}:${i}`, b64.slice(i * MIRROR_CHUNK_CHARS, (i + 1) * MIRROR_CHUNK_CHARS))
  await storage.put(`mirror:v2:entry:${id}`, { path, kind: 'file', mode, mtimeMs, chunks, bytes: raw.length })
}

test('fitsInOnePiece is the one rule, on a serialized byte count', () => {
  assert.equal(typeof archive.fitsInOnePiece, 'function')
  assert.equal(archive.fitsInOnePiece(0), true)
  assert.equal(archive.fitsInOnePiece(ONE_PIECE), true)
  assert.equal(archive.fitsInOnePiece(ONE_PIECE + 1), false)
  for (const bad of [-1, 1.5, Number.NaN, Infinity, '1', null, undefined]) assert.equal(archive.fitsInOnePiece(bad), false, String(bad))
})

test('under the old bound but over one piece once serialized: status says so, export answers 413 with zero bucket writes and no snapshot, the live drill refuses; 3 bytes less: export 200 and a drill by that key succeeds', { timeout: 600000 }, async () => {
  const fx = await buildWorld()
  const last = '/dsh/home/auma/fill/last.bin'
  for (let i = 0; i < 3; i++) await putMirrorFile(fx, `/dsh/home/auma/fill/f${i}.bin`, 3 * MIB)
  const start = 3000
  await putMirrorFile(fx, last, start)
  const first = await exportReply(await fx.call(ARCHIVE, { action: 'export' }))
  assert.equal(first.status, 200, first.text.slice(0, 300))
  const s0 = Buffer.byteLength(fx.r2.objects.get(first.value.r2Key).text)
  // The snapshot grows by 4 characters per 3 bytes of `last`, plus the digits of its `bytes` field.
  const predicted = bytes => s0 + 4 * (bytes - start) / 3 + String(bytes).length - String(start).length
  let under = start + 3 * Math.floor((ONE_PIECE - s0) / 4)
  while (predicted(under) > ONE_PIECE) under -= 3
  const over = under + 3
  assert.ok(predicted(over) > ONE_PIECE && predicted(under) > ONE_PIECE - 8)
  fx.r2.objects.clear()
  const putsBefore = fx.r2.stats.puts

  await putMirrorFile(fx, last, over)
  const status = await exportReply(await fx.call(ARCHIVE))
  assert.equal(status.status, 200, status.text.slice(0, 300))
  const { plan } = status.value
  assert.ok(plan.bodyB64Bytes + plan.moduleBytes <= ONE_PIECE, 'the old measure would have said it fits')
  assert.equal(plan.withinOnePiece, false)
  assert.ok(plan.serializedBytesAtMost >= predicted(over), `${plan.serializedBytesAtMost} >= ${predicted(over)}`)
  fx.log.reset()
  const refused = await exportReply(await fx.call(ARCHIVE, { action: 'export' }))
  assert.equal(refused.status, 413, refused.text.slice(0, 300))
  assert.equal(refused.value.code, 'ARCHIVE_TOO_LARGE_FOR_ONE_PIECE')
  assert.equal(fx.r2.stats.puts, putsBefore, 'nothing written to the bucket')
  assert.deepEqual(snapshotKeys(fx), [], 'no snapshot exists')
  assert.equal(fx.log.calls.some(entry => entry.path === '/_head/telemetry'), false, 'no export was recorded')
  const liveDrill = await exportReply(await fx.call(ARCHIVE, { action: 'rebuild_drill', targetName: 'x61-drill-bounded-over' }))
  assert.equal(liveDrill.status, 413, liveDrill.text.slice(0, 300))
  assert.equal(liveDrill.value.code, 'ARCHIVE_TOO_LARGE_FOR_ONE_PIECE')
  assert.equal(drillRows(fx), 0)

  await putMirrorFile(fx, last, under)
  const exported = await exportReply(await fx.call(ARCHIVE, { action: 'export' }))
  assert.equal(exported.status, 200, exported.text.slice(0, 300))
  const written = Buffer.byteLength(fx.r2.objects.get(exported.value.r2Key).text)
  assert.equal(written, predicted(under))
  assert.ok(written <= ONE_PIECE && written > ONE_PIECE - 8, `${written} is just under ${ONE_PIECE}`)
  const byKey = await exportReply(await fx.call(ARCHIVE, { action: 'rebuild_drill', targetName: 'x61-drill-bounded-under-key', r2Key: exported.value.r2Key }))
  assert.equal(byKey.status, 200, byKey.text.slice(0, 300))
  assert.equal(byKey.value.disposableStorageCleanedUp, true)
  assert.equal(byKey.value.archiveId, exported.value.archiveId)
  const live = await exportReply(await fx.call(ARCHIVE, { action: 'rebuild_drill', targetName: 'x61-drill-bounded-under-live' }))
  assert.equal(live.status, 200, live.text.slice(0, 300))
  assert.equal(drillRows(fx), 0)

  // Last, because an approval grows the owner row: over again, an approved full export is refused too and writes nothing.
  await putMirrorFile(fx, last, over)
  const putsAfter = fx.r2.stats.puts
  const snapshotBefore = fx.r2.objects.get(exported.value.r2Key).text
  const approved = await exportReply(await fx.call(ARCHIVE, EXPORT_BODY, { headers: { 'x-x6-class3-approval': await fx.approve() } }))
  assert.equal(approved.status, 413, approved.text.slice(0, 300))
  assert.equal(approved.value.code, 'ARCHIVE_TOO_LARGE_FOR_ONE_PIECE')
  assert.deepEqual(leaks(approved.text), [])
  assert.equal(fx.r2.stats.puts, putsAfter, 'nothing written to the bucket')
  assert.equal(fx.r2.objects.get(exported.value.r2Key).text, snapshotBefore, 'the good snapshot is untouched')
})

test('over generated shapes, the status estimate is never below the bytes export writes, so withinOnePiece is never true where the real check refuses', { timeout: 600000 }, async () => {
  const awkward = [
    ['grusse', 'export const greeting = "Grüße aus 東京 🌏"\n'],
    ['escapes', 'export const s = "quote \\" backslash \\\\ tab\t ctl\u0001 sep  end"\n// \'single\' `tick`\n'],
    ['lone', 'export const half = "\ud800"\n'],
    ['plain', 'export const plain = 1\n'],
  ]
  const segment = (char, bytes) => char.repeat(Math.floor(bytes / Buffer.byteLength(char)))
  const shapes = [
    ['many small files', {}, async fx => {
      for (let i = 0; i < 2500; i++) {
        await putMirrorFile(fx, `/dsh/home/auma/small/d${i % 40}/s${i}.md`, (i * 7) % 97, { mode: i % 2 ? 0o600 : 0o644, mtimeMs: 1794348000000 + i + (i % 3) / 4 })
      }
    }],
    ['few large files', {}, async fx => {
      for (const [i, bytes] of [700001, 350000, 1, 0].entries()) await putMirrorFile(fx, `/dsh/home/auma/large/l${i}.bin`, bytes)
    }],
    ['long paths', {}, async fx => {
      const mirror = fx.mirrorStorages.get(LIVE)
      for (const [i, char] of ['a', 'é', '東', '"', '🌏'].entries()) {
        const path = `/dsh/home/auma/long${i}/${segment(char, 255)}/${segment(char, 255)}/${segment(char, 250)}.md`
        assert.ok(Buffer.byteLength(path) <= 4096)
        await putMirrorFile(fx, path, `long path ${i} ${char}\n`)
        const resetPath = `/dsh/home/auma/gone${i}/${segment(char, 255)}`
        await mirror.put(`mirror:v2:reset:${rowId(resetPath)}`, resetPath)
      }
    }],
    ['non-ASCII module code', { sources: awkward }, async () => {}],
  ]
  for (const [name, options, shape] of shapes) {
    const fx = await buildWorld(options)
    await shape(fx)
    const status = await exportReply(await fx.call(ARCHIVE))
    assert.equal(status.status, 200, `${name}: ${status.text.slice(0, 300)}`)
    const { plan } = status.value
    const exported = await exportReply(await fx.call(ARCHIVE, { action: 'export' }))
    assert.equal(exported.status, 200, `${name}: ${exported.text.slice(0, 300)}`)
    const written = Buffer.byteLength(fx.r2.objects.get(exported.value.r2Key).text)
    assert.ok(written <= plan.serializedBytesAtMost, `${name}: written ${written} <= estimate ${plan.serializedBytesAtMost}`)
    assert.ok(plan.serializedBytesAtMost - written <= 24, `${name}: estimate within the exportedAt allowance`)
    assert.equal(plan.withinOnePiece, archive.fitsInOnePiece(plan.serializedBytesAtMost), name)
    if (plan.withinOnePiece) assert.equal(archive.fitsInOnePiece(written), true, name)
    assert.ok(plan.bodyB64Bytes + plan.moduleBytes < written, `${name}: the old measure undercounts`)
  }
})

test('through the Worker, no public request under /_head/archive- or /_mirror/archive- reaches a durable object, signed in or not, with or without forged internal headers', async () => {
  const fx = await buildWorld()
  const paths = ['/_head/archive-state', '/_head/archive-summary', '/_head/archive-drill-apply', '/_head/archive-drill-wipe', '/_head/archive-',
    '/_head/archive-anything', '/_head/archive-summary/', '/_head/archive-%73ummary', '/_head/archive-summary?x=1',
    '/_mirror/archive-state', '/_mirror/archive-plan', '/_mirror/archive-drill-apply', '/_mirror/archive-drill-wipe', '/_mirror/archive-',
    '/_mirror/archive-anything', '/_mirror/archive-plan/', '/_mirror/archive-%70lan', '/_mirror/archive-plan?x=1']
  const forgeries = [{}, { 'x-x6-internal-authorized': '1' }, { 'x-x6-internal-authorized': '1', 'x-x6-bootstrap-seed': fx.seedId,
    'x-x6-verified-access': JSON.stringify({ type: 'owner', email: fx.env.OWNER_EMAIL, expires: 4102444800 }) }]
  const body = JSON.stringify({ targetName: 'x61-drill-public', expectedOwnerPublicKeyHex: fx.env.OWNER_PUBLIC_KEY_HEX })
  const send = (path, method, signedIn, forged) => fx.worker.fetch(new Request(ORIGIN + path, { method, headers: new Headers({
    ...(signedIn ? { cookie: 'CF_Authorization=fixture-owner' } : {}), origin: ORIGIN, 'sec-fetch-site': 'same-origin',
    ...(method === 'POST' ? { 'content-type': 'application/json' } : {}), ...forged }), ...(method === 'POST' ? { body } : {}) }), fx.env)
  const outcome = async response => {
    const text = await response.text()
    let code = null
    try { code = JSON.parse(text).code ?? null } catch {}
    return { status: response.status, code }
  }
  for (const signedIn of [true, false]) {
    for (const method of ['GET', 'POST']) {
      for (const forged of forgeries) {
        for (const path of paths) {
          fx.log.reset()
          const reference = await outcome(await send('/_head/archive-state', method, signedIn, forged))
          const got = await outcome(await send(path, method, signedIn, forged))
          const label = `${signedIn ? 'owner' : 'public'} ${method} ${path} ${Object.keys(forged).join('+') || 'no forgery'}`
          assert.deepEqual(got, reference, label)
          assert.notEqual(got.status, 200, label)
          if (signedIn) assert.deepEqual(got, { status: 501, code: 'CLOUD_CAPABILITY_UNAVAILABLE' }, label)
          assert.deepEqual(fx.log.calls.filter(entry => entry.path.includes('/archive-')), [], `${label}: no archive route reached a durable object`)
        }
      }
    }
  }
  // And at the objects themselves, a request without the internal header is refused before the hook.
  for (const path of paths.filter(path => !path.includes('?'))) {
    const binding = path.startsWith('/_head/') ? fx.env.HEAD : fx.env.MIRROR
    const response = await binding.get(LIVE).fetch(new Request(`https://x61.internal${path}`, { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-x6-bootstrap-seed': fx.seedId }, body }))
    assert.equal(response.status, 401, path)
    assert.equal((await response.json()).code, 'UNAUTHORIZED', path)
  }
})

// status bounded for every state, the early guard on the measured sections, a held apply never
// leaves rows, a failure still reports its cleanup, and overlapping drills never report each other.
const LIMITS = Object.freeze({ seedFileBytes: 4 * MIB, seedFileChunks: 57, manifestBytes: 4 * MIB, moduleCount: 256,
  moduleBytes: 2 * MIB, metadataBytes: 10 * MIB, replyBytes: 256 * 1024 })
const DRILL_MARK = 'archive-drill:v1'
const HEAD_CHUNK = 24000
const repliesOver = (fx, bytes) => fx.log.replies.filter(entry => entry.bytes > bytes)
const seedChunkReads = (fx, path) => fx.log.chunkReads.filter(key => key.startsWith(chunkPrefixOf(path)))

/** A HEAD blob written in the shape every HEAD writer uses (24,000-character pieces, then the count). */
async function putHeadBlob(fx, key, value) {
  const storage = fx.headStorages.get(LIVE)
  const count = Math.ceil(value.length / HEAD_CHUNK)
  for (let i = 0; i < count; i++) await storage.put(`${key}:${i}`, value.slice(i * HEAD_CHUNK, (i + 1) * HEAD_CHUNK))
  await storage.put(`${key}:count`, count)
}

/** Make `ball` (with extra module code, if any) the live HEAD, as a promotion would: modules, manifest, then `head`. */
async function setLiveBall(fx, draft, extraCode = {}) {
  for (const [moduleSha, code] of Object.entries(extraCode)) await putHeadBlob(fx, `module:${moduleSha}`, code)
  const ball = { ...draft, ballId: await manifestId(draft) }
  await putHeadBlob(fx, `manifest:${ball.ballId}`, JSON.stringify(ball))
  await fx.headStorages.get(LIVE).put('head', ball.ballId)
  return ball
}
const draftOf = ({ ballId: _id, ...draft }) => draft

/** The C2 ball with its first entry's config padded so the stored manifest is exactly `bytes` long. */
async function manifestOfBytes(fx, bytes) {
  const base = draftOf(fx.ball)
  const first = Object.keys(base.entries).sort()[0]
  const withPad = pad => ({ ...base, entries: { ...base.entries, [first]: { ...base.entries[first], config: { pad } } } })
  const empty = Buffer.byteLength(JSON.stringify({ ...withPad(''), ballId: '0'.repeat(64) }))
  const draft = withPad('p'.repeat(bytes - empty))
  assert.equal(Buffer.byteLength(JSON.stringify({ ...draft, ballId: '0'.repeat(64) })), bytes)
  return draft
}

/** `count` more modules (small, distinct code), added to the C2 ball's module map. */
async function withExtraModules(fx, count, codeOf = i => `export const extra = ${i}\n`) {
  const draft = draftOf(fx.ball)
  const modules = { ...draft.modules }, extraCode = {}
  for (let i = 0; i < count; i++) {
    const code = codeOf(i)
    const moduleSha = await digest(code)
    extraCode[moduleSha] = code
    modules[moduleSha] = { sha256: moduleSha, specifier: `ball:${moduleSha}`, size: Buffer.byteLength(code) }
  }
  return { draft: { ...draft, modules }, extraCode }
}

test('the status limits are the named constants', () => {
  assert.equal(archive.STATUS_SEED_FILE_MAX_BYTES, LIMITS.seedFileBytes)
  assert.equal(archive.STATUS_SEED_FILE_MAX_CHUNKS, LIMITS.seedFileChunks)
  assert.equal(archive.STATUS_MANIFEST_MAX_BYTES, LIMITS.manifestBytes)
  assert.equal(archive.STATUS_MODULE_COUNT_MAX, LIMITS.moduleCount)
  assert.equal(archive.STATUS_MODULE_MAX_BYTES, LIMITS.moduleBytes)
  assert.equal(archive.STATUS_METADATA_MAX_BYTES, LIMITS.metadataBytes)
  assert.equal(archive.STATUS_REPLY_MAX_BYTES, LIMITS.replyBytes)
})

test('jsonStringByteLength is the byte length JSON.stringify writes, without building it', () => {
  assert.equal(typeof archive.jsonStringByteLength, 'function')
  const samples = ['', 'plain', '"quoted" \\ back', '\b\f\n\r\t', '\u0000\u0001\u001f\u007f', 'é東🌏', '  ', '\ud800', 'a\udc00b',
    '\ud83c', '🌏𐏿', '</script>']
  let seed = 7
  const next = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed }
  for (let n = 0; n < 200; n++) samples.push(Array.from({ length: next() % 40 }, () => String.fromCharCode(next() % 0x10000)).join(''))
  for (const sample of samples) assert.equal(archive.jsonStringByteLength(sample), Buffer.byteLength(JSON.stringify(sample)), JSON.stringify(sample))
})

test('LF-only seed journals at the byte limit: status answers from summaries, every reply small; one byte over: 413 named, no chunk of it read', { timeout: 600000 }, async () => {
  const fx = await buildWorld()
  await putMirrorFile(fx, RECEIPTS_PATH, '\n'.repeat(LIMITS.seedFileBytes))
  await putMirrorFile(fx, CHECKPOINTS_PATH, '\n'.repeat(LIMITS.seedFileBytes))
  const entry = await fx.mirrorStorages.get(LIVE).get(`mirror:v2:entry:${rowId(RECEIPTS_PATH)}`)
  assert.equal(entry.chunks, LIMITS.seedFileChunks, 'a seed file at the byte limit takes exactly the chunk limit')
  fx.log.reset()
  const reply = await exportReply(await fx.call(ARCHIVE))
  assert.equal(reply.status, 200, reply.text.slice(0, 300))
  assert.equal(reply.value.receiptsSummary.receiptCount, 0)
  assert.equal(reply.value.receiptsSummary.checkpointCount, 0)
  assert.deepEqual(repliesOver(fx, LIMITS.replyBytes), [], 'no durable object reply carries a journal')
  assert.ok(Buffer.byteLength(reply.text) < 16 * 1024, `status is ${Buffer.byteLength(reply.text)} bytes`)
  for (const path of [RECEIPTS_PATH, CHECKPOINTS_PATH]) {
    await putMirrorFile(fx, path, '\n'.repeat(LIMITS.seedFileBytes + 1))
    fx.log.reset()
    const over = await exportReply(await fx.call(ARCHIVE))
    assert.equal(over.status, 413, `${path}: ${over.text.slice(0, 300)}`)
    assert.equal(over.value.code, 'ARCHIVE_STATUS_SEED_FILE_TOO_LARGE', path)
    assert.equal(over.value.limit, LIMITS.seedFileBytes, `${path}: 1d the Worker names the limit`)
    assert.deepEqual(seedChunkReads(fx, path), [], `${path}: refused from its entry row, before any chunk`)
    await putMirrorFile(fx, path, '\n'.repeat(LIMITS.seedFileBytes))
  }
  const direct = await archive.executeEdgeArchiveOperation({ env: fx.env, seedId: fx.seedId, input: { action: 'status' } })
  assert.equal(direct.ok, true)
  await putMirrorFile(fx, RECEIPTS_PATH, '\n'.repeat(LIMITS.seedFileBytes + 1))
  await assert.rejects(archive.executeEdgeArchiveOperation({ env: fx.env, seedId: fx.seedId, input: { action: 'status' } }),
    error => error.code === 'ARCHIVE_STATUS_SEED_FILE_TOO_LARGE' && error.status === 413 && error.limit === LIMITS.seedFileBytes)
})

test('a NUL-filled receipts file is refused with every reply small (the text never leaves the Mirror)', { timeout: 120000 }, async () => {
  const fx = await buildWorld()
  await putMirrorFile(fx, RECEIPTS_PATH, '\0'.repeat(MIB))
  fx.log.reset()
  const reply = await exportReply(await fx.call(ARCHIVE))
  assert.equal(reply.status, 400, reply.text.slice(0, 300))
  assert.equal(reply.value.code, 'ARCHIVE_RECEIPT_CHAIN_INVALID')
  assert.deepEqual(repliesOver(fx, LIMITS.replyBytes), [])
})

test('a seed row claiming more chunks than the limit is refused unread; a chunk longer than its row says is refused, not buffered', { timeout: 120000 }, async () => {
  const fx = await buildWorld()
  const mirror = fx.mirrorStorages.get(LIVE)
  const key = `mirror:v2:entry:${rowId(RECEIPTS_PATH)}`
  const row = await mirror.get(key)
  await mirror.put(key, { ...row, bytes: 10, chunks: LIMITS.seedFileChunks + 1 })
  fx.log.reset()
  const tooMany = await exportReply(await fx.call(ARCHIVE))
  assert.equal(tooMany.status, 413, tooMany.text.slice(0, 300))
  assert.equal(tooMany.value.code, 'ARCHIVE_STATUS_SEED_FILE_TOO_MANY_CHUNKS')
  assert.deepEqual(seedChunkReads(fx, RECEIPTS_PATH), [])
  await mirror.put(key, { ...row, bytes: 100, chunks: 1 })
  await mirror.put(`${chunkPrefixOf(RECEIPTS_PATH)}0`, 'QUFB'.repeat(256 * 1024))
  fx.log.reset()
  const longer = await exportReply(await fx.call(ARCHIVE))
  assert.equal(longer.status, 503, longer.text.slice(0, 300))
  assert.equal(longer.value.code, 'ARCHIVE_MIRROR_CHUNK_CORRUPT')
  assert.deepEqual(repliesOver(fx, LIMITS.replyBytes), [])
})

test('a valid 3 MiB manifest: status equals the old computation and HEAD\'s reply stays small; the manifest at its limit answers, one byte over is 413 named', { timeout: 600000 }, async () => {
  const fx = await buildWorld()
  await setLiveBall(fx, await manifestOfBytes(fx, 3 * MIB))
  fx.log.reset()
  const reply = await exportReply(await fx.call(ARCHIVE))
  assert.equal(reply.status, 200, reply.text.slice(0, 300))
  assert.deepEqual(repliesOver(fx, LIMITS.replyBytes), [], 'the manifest never leaves HEAD for a status')
  const { plan: _plan, ...fields } = reply.value
  assert.deepEqual(fields, await statusTheOldWay(fx))

  await setLiveBall(fx, await manifestOfBytes(fx, LIMITS.manifestBytes))
  const at = await exportReply(await fx.call(ARCHIVE))
  assert.equal(at.status, 200, at.text.slice(0, 300))
  await setLiveBall(fx, await manifestOfBytes(fx, LIMITS.manifestBytes + 1))
  fx.log.reset()
  const over = await exportReply(await fx.call(ARCHIVE))
  assert.equal(over.status, 413, over.text.slice(0, 300))
  assert.equal(over.value.code, 'ARCHIVE_STATUS_MANIFEST_TOO_LARGE')
  assert.deepEqual(repliesOver(fx, LIMITS.replyBytes), [])
})

test('256 modules answer, 257 are refused 413 named; a module of exactly 2 MiB answers, one byte more is refused 413 named', { timeout: 600000 }, async () => {
  const fx = await buildWorld()
  const existing = Object.keys(fx.ball.modules).length
  const atCount = await withExtraModules(fx, LIMITS.moduleCount - existing)
  await setLiveBall(fx, atCount.draft, atCount.extraCode)
  const at = await exportReply(await fx.call(ARCHIVE))
  assert.equal(at.status, 200, at.text.slice(0, 300))
  assert.equal(at.value.liveCompositeHead.moduleCount, LIMITS.moduleCount)
  const overCount = await withExtraModules(fx, LIMITS.moduleCount - existing + 1)
  await setLiveBall(fx, overCount.draft, overCount.extraCode)
  const over = await exportReply(await fx.call(ARCHIVE))
  assert.equal(over.status, 413, over.text.slice(0, 300))
  assert.equal(over.value.code, 'ARCHIVE_STATUS_TOO_MANY_MODULES')

  const sized = bytes => i => `//${'m'.repeat(bytes - 3 - String(i).length)}${i}\n`
  const atBytes = await withExtraModules(fx, 1, sized(LIMITS.moduleBytes))
  assert.equal(Buffer.byteLength(Object.values(atBytes.extraCode)[0]), LIMITS.moduleBytes)
  await setLiveBall(fx, atBytes.draft, atBytes.extraCode)
  const big = await exportReply(await fx.call(ARCHIVE))
  assert.equal(big.status, 200, big.text.slice(0, 300))
  const overBytes = await withExtraModules(fx, 1, sized(LIMITS.moduleBytes + 1))
  await setLiveBall(fx, overBytes.draft, overBytes.extraCode)
  fx.log.reset()
  const tooBig = await exportReply(await fx.call(ARCHIVE))
  assert.equal(tooBig.status, 413, tooBig.text.slice(0, 300))
  assert.equal(tooBig.value.code, 'ARCHIVE_STATUS_MODULE_TOO_LARGE')
  assert.deepEqual(repliesOver(fx, LIMITS.replyBytes), [])
})

test('20,000 entry rows answer and 20,001 are refused; listed metadata at 10 MiB answers and one byte over is refused 413 named', { timeout: 600000 }, async () => {
  const fx = await buildWorld()
  const mirror = fx.mirrorStorages.get(LIVE)
  const entryRows = async () => (await mirror.list({ prefix: 'mirror:v2:entry:' })).size
  const dirRow = async path => mirror.put(`mirror:v2:entry:${rowId(path)}`, { path, kind: 'dir', mode: 0o755 })
  for (let n = 0, have = await entryRows(); have < 20000; n++, have++) await dirRow(`/dsh/home/auma/count/d${String(n).padStart(5, '0')}`)
  assert.equal(await entryRows(), 20000)
  const at = await exportReply(await fx.call(ARCHIVE))
  assert.equal(at.status, 200, at.text.slice(0, 300))
  assert.equal(at.value.plan.entries, 20000)
  await dirRow('/dsh/home/auma/count/one-more')
  const over = await exportReply(await fx.call(ARCHIVE))
  assert.equal(over.status, 413, over.text.slice(0, 300))
  assert.equal(over.value.code, 'ARCHIVE_TOO_MANY_ENTRIES')

  const meta = await buildWorld()
  const store = meta.mirrorStorages.get(LIVE)
  const listed = async () => {
    let bytes = 0
    for (const prefix of ['mirror:v2:entry:', 'mirror:v2:reset:']) for (const value of (await store.list({ prefix })).values()) bytes += Buffer.byteLength(JSON.stringify(value))
    return bytes
  }
  // A directory path of exactly `length` bytes under its own folder, cut into 200-byte names.
  const pathOf = (i, length) => {
    let path = `/dsh/home/auma/meta/r${String(i).padStart(5, '0')}`
    while (path.length < length) path += '/' + 'q'.repeat(Math.min(200, length - path.length - 1) || 1)
    return path.slice(0, length)
  }
  const rowBytes = path => Buffer.byteLength(JSON.stringify({ path, kind: 'dir', mode: 0o755 }))
  const put = path => store.put(`mirror:v2:entry:${rowId(path)}`, { path, kind: 'dir', mode: 0o755 })
  let room = LIMITS.metadataBytes - await listed(), i = 0
  const full = rowBytes(pathOf(0, 4000))
  while (room >= 2 * full) { await put(pathOf(i++, 4000)); room -= full }
  const first = Math.floor(room / 2)
  for (const want of [first, room - first]) {
    const path = pathOf(i++, 4000 - (full - want))
    assert.equal(rowBytes(path), want)
    await put(path)
  }
  assert.equal(await listed(), LIMITS.metadataBytes)
  const atMeta = await exportReply(await meta.call(ARCHIVE))
  assert.equal(atMeta.status, 200, atMeta.text.slice(0, 300))
  const last = pathOf(i - 1, 4000 - (full - (room - first)))
  await store.delete(`mirror:v2:entry:${rowId(last)}`)
  await put(last + 'z')
  assert.equal(await listed(), LIMITS.metadataBytes + 1)
  const overMeta = await exportReply(await meta.call(ARCHIVE))
  assert.equal(overMeta.status, 413, overMeta.text.slice(0, 300))
  assert.equal(overMeta.value.code, 'ARCHIVE_STATUS_METADATA_TOO_LARGE')
})

test('the Worker reads a durable object reply of exactly 256 KiB and refuses one byte more, 413 named', async () => {
  const fx = await buildWorld()
  let pad = 0
  fx.log.overrides.set('MIRROR /_mirror/archive-plan', async (request, real) => {
    const response = await real.fetch(request)
    const text = await response.text()
    return new Response(text + ' '.repeat(pad - Buffer.byteLength(text)), { status: response.status, headers: response.headers })
  })
  pad = LIMITS.replyBytes
  const at = await exportReply(await fx.call(ARCHIVE))
  assert.equal(at.status, 200, at.text.slice(0, 300))
  pad = LIMITS.replyBytes + 1
  const over = await exportReply(await fx.call(ARCHIVE))
  assert.equal(over.status, 413, over.text.slice(0, 300))
  assert.equal(over.value.code, 'ARCHIVE_STATUS_REPLY_TOO_LARGE')
})

test('escape-heavy module code that the old floor admits is refused 413 by the measured sections before any body route; the drill too', { timeout: 600000 }, async () => {
  const half = 1.5 * MIB
  const fx = await buildWorld({ sources: [['ctl-a', '\u0001'.repeat(half)], ['ctl-b', '\u0002'.repeat(half)], ['plain', 'export const plain = 1\n']] })
  const status = await exportReply(await fx.call(ARCHIVE))
  assert.equal(status.status, 200, status.text.slice(0, 300))
  assert.ok(status.value.plan.bodyB64Bytes + status.value.plan.moduleBytes <= ONE_PIECE, 'the old floor would have admitted it')
  assert.equal(status.value.plan.withinOnePiece, false)
  fx.log.reset()
  const exported = await exportReply(await fx.call(ARCHIVE, { action: 'export' }))
  assert.equal(exported.status, 413, exported.text.slice(0, 300))
  assert.equal(exported.value.code, 'ARCHIVE_TOO_LARGE_FOR_ONE_PIECE')
  const drill = await exportReply(await fx.call(ARCHIVE, { action: 'rebuild_drill', targetName: 'x61-drill-escapes' }))
  assert.equal(drill.status, 413, drill.text.slice(0, 300))
  assert.equal(drill.value.code, 'ARCHIVE_TOO_LARGE_FOR_ONE_PIECE')
  assert.deepEqual(fx.log.calls.filter(entry => entry.path.endsWith('/archive-state') || entry.path.endsWith('/archive-drill-apply')), [], 'archive-state is never called')
  assert.equal(fx.r2.stats.puts, 0)
  assert.equal(drillRows(fx), 0)
})

test('over generated shapes, headJsonBytes and mirrorJsonBytes are exactly the written sections, so their sum is never above the snapshot', { timeout: 600000 }, async () => {
  let seed = 20261112
  const next = n => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n }
  const alphabet = ['a', 'Z', '9', '-', '_', 'é', '東', '"', '🌏', ' ', "'", ' ']
  const name = () => Array.from({ length: 1 + next(24) }, () => alphabet[next(alphabet.length)]).join('')
  const awkward = ['\u0001\t"\\', '\ud800', 'é東🌏', ' ', '</script>', 'plain']
  for (let shape = 0; shape < 8; shape++) {
    const sources = next(2) ? Array.from({ length: 1 + next(5) }, (_, i) => [`gen-${shape}-${i}`,
      `export const v${i} = ${JSON.stringify(Array.from({ length: next(30) }, () => awkward[next(awkward.length)]).join(''))} // ${awkward[next(awkward.length)]}${i}\n`]) : null
    const fx = await buildWorld(sources ? { sources } : {})
    const files = next(300)
    for (let i = 0; i < files; i++) {
      await putMirrorFile(fx, `/dsh/home/auma/gen${shape}/${name()}-${i}.md`, next(5) ? next(4000) : name(), { mode: next(2) ? 0o600 : 0o644, mtimeMs: 1794348000000 + next(1e6) + next(4) / 4 })
    }
    for (let i = 0; i < next(6); i++) {
      const path = `/dsh/home/auma/gone${shape}/${name()}-${i}`
      await fx.mirrorStorages.get(LIVE).put(`mirror:v2:reset:${rowId(path)}`, path)
    }
    const head = await (await internal(fx.env.HEAD, LIVE, '/_head/archive-summary', { expectedOwnerPublicKeyHex: fx.env.OWNER_PUBLIC_KEY_HEX })).json()
    const mirror = await (await internal(fx.env.MIRROR, LIVE, '/_mirror/archive-plan', { seedFiles: false })).json()
    const exported = await exportReply(await fx.call(ARCHIVE, { action: 'export' }))
    assert.equal(exported.status, 200, `shape ${shape}: ${exported.text.slice(0, 300)}`)
    const text = fx.r2.objects.get(exported.value.r2Key).text
    const snapshot = JSON.parse(text)
    assert.equal(head.headJsonBytes, Buffer.byteLength(JSON.stringify(snapshot.head)), `shape ${shape}: head section`)
    assert.equal(mirror.mirrorJsonBytes, Buffer.byteLength(JSON.stringify(snapshot.mirror)), `shape ${shape}: mirror section`)
    assert.ok(head.headJsonBytes + mirror.mirrorJsonBytes < Buffer.byteLength(text), `shape ${shape}: the floor is under the snapshot`)
  }
})

/** Hold every HEAD drill apply until released; `late` collects the held calls' own answers. */
function holdHeadApply(fx) {
  let release
  const gate = new Promise(resolve => { release = resolve })
  const late = []
  fx.log.overrides.set('HEAD /_head/archive-drill-apply', (request, real) => {
    const answer = gate.then(() => real.fetch(request))
    late.push(answer)
    return answer
  })
  return { release, late }
}
/** The rows of a drill object other than its drill mark (the cleanup counts these). */
const rowsBesideMark = async storage => [...(await storage.list()).keys()].filter(key => key !== DRILL_MARK).length
const withinSeconds = (promise, seconds) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`no answer within ${seconds} s`)), seconds * 1000))])

test('with HEAD\'s apply held, the drill answers at its deadline, both objects are cleaned (HEAD to its end mark, reported pending), and the late apply writes no row',{ timeout: 60000 }, async () => {
  const fx = await buildWorld()
  const label = 'x61-drill-held-apply'
  const held = holdHeadApply(fx)
  let error = null
  try {
    await withinSeconds(archive.executeEdgeArchiveOperation({ env: fx.env, seedId: fx.seedId, input: { action: 'rebuild_drill', targetName: label },
      drillDeadlineMs: 200, drillWipeDeadlineMs: 2000 }), 10)
  } catch (caught) { error = caught }
  held.release()
  assert.equal(error?.code, 'DRILL_DEADLINE_EXCEEDED', String(error?.message))
  assert.equal(error.status, 503)
  assert.equal(error.step, 'HEAD_APPLY')
  const target = onlyDrillName(fx, label)
  // 1c review: HEAD keeps its end mark until the late apply lands, so the reply says the cleanup is pending, with that row.
  assert.deepEqual(error.cleanup, { pending: true, targetName: target, objects: [{ object: 'HEAD', remainingRows: 1, endMarkLeft: true }, { object: 'MIRROR', remainingRows: 0 }] })
  assert.equal(fx.mirrorStorages.get(target).size(), 0, 'the Mirror rows the drill applied are gone')
  const head = fx.headStorages.get(target)
  assert.equal(head.size(), 1, 'HEAD holds only its end mark while the apply is out')
  assert.equal((await head.get(DRILL_MARK)).ended, true)
  assert.equal(held.late.length, 1)
  const lateReply = await held.late[0]
  assert.equal(lateReply.status, 409)
  assert.equal((await lateReply.json()).code, 'DRILL_TARGET_ENDED')
  assert.equal(head.size(), 0, 'the late apply wrote no row and removed the mark')
  assert.equal(drillRows(fx), 0)
})

test('an apply that arrives after its drill ended an object writes nothing; another drill\'s apply is refused there; an apply without a drill id is refused', async () => {
  const fx = await buildWorld()
  const { bundle } = await archive.exportColdArchive({ headStorage: fx.headStorages.get(LIVE), mirrorStorage: fx.mirrorStorages.get(LIVE),
    expectedOwnerPublicKeyHex: fx.env.OWNER_PUBLIC_KEY_HEX })
  const bodies = {
    HEAD: ['/_head/archive-drill-apply', '/_head/archive-drill-wipe', { seedId: bundle.seedId, head: bundle.head }, fx.env.HEAD, fx.headStorages],
    MIRROR: ['/_mirror/archive-drill-apply', '/_mirror/archive-drill-wipe', { seedId: bundle.seedId, ballId: bundle.head.ball.ballId, epoch: bundle.head.ball.epoch, mirror: bundle.mirror }, fx.env.MIRROR, fx.mirrorStorages],
  }
  for (const [object, [applyPath, wipePath, body, binding, storages]] of Object.entries(bodies)) {
    const own = crypto.randomUUID(), other = crypto.randomUUID()
    const name = `x61-drill-late-${object.toLowerCase()}`
    const ended = await internal(binding, name, wipePath, { targetName: name, drillId: own, end: true })
    assert.deepEqual(await ended.json(), { ok: true, wiped: false, endMarkLeft: true, remainingRows: 1 }, `${object}: the wipe says the mark it left`)
    const foreign = await internal(binding, name, applyPath, { ...body, targetName: name, drillId: other })
    assert.equal(foreign.status, 409, object)
    assert.equal((await foreign.json()).code, 'DRILL_TARGET_CLAIMED', object)
    assert.deepEqual([...(await storages.get(name).list()).keys()], [DRILL_MARK], `${object}: another drill's apply wrote nothing`)
    const late = await internal(binding, name, applyPath, { ...body, targetName: name, drillId: own })
    assert.equal(late.status, 409, object)
    assert.equal((await late.json()).code, 'DRILL_TARGET_ENDED', object)
    assert.equal(storages.get(name).size(), 0, `${object}: the late apply wrote no row`)
    const noId = await internal(binding, `${name}-noid`, applyPath, { ...body, targetName: `${name}-noid` })
    assert.equal(noId.status, 400, object)
    assert.equal((await noId.json()).code, 'DRILL_ID_INVALID', object)
    assert.equal(storages.get(`${name}-noid`).size(), 0, object)
  }
})

test('a cleanup that is not complete answers DRILL_CLEANUP_PENDING with the target and each object\'s rows left (null when a wipe did not answer)', { timeout: 30000 }, async () => {
  const fx = await buildWorld()
  const label = 'x61-drill-pending-counts'
  failDrillMirrorWipes(fx)
  const error = await archive.executeEdgeArchiveOperation({ env: fx.env, seedId: fx.seedId, input: { action: 'rebuild_drill', targetName: label } }).then(() => null, caught => caught)
  assert.equal(error?.code, 'DRILL_CLEANUP_PENDING')
  assert.equal(error.status, 503)
  const target = onlyDrillName(fx, label)
  // 1d: every row left is counted, the drill's own mark among them.
  const left = fx.mirrorStorages.get(target).size()
  assert.ok(left > 0)
  assert.equal(left, await rowsBesideMark(fx.mirrorStorages.get(target)) + 1, 'the mark is one of the rows left')
  assert.deepEqual(error.cleanup, { pending: true, targetName: target, objects: [{ object: 'HEAD', remainingRows: 0 }, { object: 'MIRROR', remainingRows: left }] })

  const stalled = await buildWorld()
  stalled.log.overrides.set('HEAD /_head/archive-drill-wipe', () => new Promise(() => {}))
  const silent = await archive.executeEdgeArchiveOperation({ env: stalled.env, seedId: stalled.seedId, input: { action: 'rebuild_drill', targetName: 'x61-drill-pending-silent' },
    drillWipeDeadlineMs: 50 }).then(() => null, caught => caught)
  assert.equal(silent?.code, 'DRILL_CLEANUP_PENDING')
  assert.deepEqual(silent.cleanup.objects, [{ object: 'HEAD', remainingRows: null }, { object: 'MIRROR', remainingRows: 0 }])
})

test('a read-back parity failure followed by a failed Mirror wipe keeps its own code and carries the cleanup that is pending', async () => {
  const fx = await buildWorld()
  const label = 'x61-drill-parity-pending'
  failDrillMirrorWipes(fx)
  fx.log.overrides.set('HEAD /_head/archive-drill-apply', async (request, real) => {
    const value = await (await real.fetch(request)).json()
    return Response.json({ ...value, moduleCount: value.moduleCount + 1 })
  })
  const error = await archive.executeEdgeArchiveOperation({ env: fx.env, seedId: fx.seedId, input: { action: 'rebuild_drill', targetName: label } }).then(() => null, caught => caught)
  assert.equal(error?.code, 'DRILL_READBACK_PARITY_FAILED')
  assert.equal(error.status, 503)
  const target = onlyDrillName(fx, label)
  const left = fx.mirrorStorages.get(target).size()
  assert.ok(left > 0)
  assert.deepEqual(error.cleanup, { pending: true, targetName: target, objects: [{ object: 'HEAD', remainingRows: 0 }, { object: 'MIRROR', remainingRows: left }] })
  // 1d: the same failure through the Worker carries the same cleanup to the owner (asserted in full below).
  const viaWorker = await exportReply(await fx.call(ARCHIVE, { action: 'rebuild_drill', targetName: 'x61-drill-parity-worker' }))
  assert.equal(viaWorker.status, 503)
  assert.equal(viaWorker.value.code, 'DRILL_READBACK_PARITY_FAILED')
  const second = drillNames(fx).find(name => name !== target)
  assert.deepEqual(viaWorker.value.cleanup, { pending: true, targetName: second,
    objects: [{ object: 'HEAD', remainingRows: 0 }, { object: 'MIRROR', remainingRows: fx.mirrorStorages.get(second).size() }] })
})

// replaces 1c's S2 test, whose second drill on one name was refused. Each attempt now has its own
// objects, so two attempts with one label both run, neither touches the other's rows, and each "cleaned" is true for its own.
const settle = promise => promise.then(value => ({ value }), error => ({ error }))
const until = async (condition, seconds = 10) => {
  const started = Date.now()
  while (!condition()) {
    if (Date.now() - started > seconds * 1000) throw new Error(`condition not met within ${seconds} s`)
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

test('the review\'s interleaving: A\'s reply held after its real wipes, B with the same label fills its Mirror object, A released: A\'s "cleaned" is true of A\'s objects', { timeout: 60000 }, async () => {
  const fx = await buildWorld()
  const label = 'x61-drill-interleave'
  let releaseA, releaseB
  const gateA = new Promise(resolve => { releaseA = resolve }), gateB = new Promise(resolve => { releaseB = resolve })
  let mirrorWipes = 0, headApplies = 0, aWiped = false, bHeld = false
  // A's first Mirror wipe really runs, then its reply waits; B's HEAD apply waits, after B's Mirror apply has landed.
  fx.log.overrides.set('MIRROR /_mirror/archive-drill-wipe', async (request, real) => {
    const first = ++mirrorWipes === 1
    const reply = await real.fetch(request)
    if (first) { aWiped = true; await gateA }
    return reply
  })
  fx.log.overrides.set('HEAD /_head/archive-drill-apply', async (request, real) => {
    if (++headApplies === 2) { bHeld = true; await gateB }
    return real.fetch(request)
  })
  const drill = () => settle(archive.executeEdgeArchiveOperation({ env: fx.env, seedId: fx.seedId, input: { action: 'rebuild_drill', targetName: label } }))
  const a = drill()
  try {
    await until(() => aWiped)
    const b = drill()
    await until(() => bHeld)
    releaseA()
    const outcomeA = await withinSeconds(a, 10)
    assert.equal(outcomeA.error, undefined, String(outcomeA.error?.code))
    assert.equal(outcomeA.value.disposableStorageCleanedUp, true)
    const nameA = outcomeA.value.targetName
    // At the moment A answers, B's Mirror object holds rows, and A's two objects hold none: A's statement is true.
    assert.equal(fx.headStorages.get(nameA).size() + fx.mirrorStorages.get(nameA).size(), 0, 'A\'s own objects are empty')
    assert.equal(outcomeA.value.label, label)
    assert.match(nameA, ATTEMPT_OBJECT)
    assert.equal(nameA, `x61-drill-${outcomeA.value.attemptId}`)
    const others = drillNames(fx).filter(name => name !== nameA)
    assert.equal(others.length, 1, others.join(', '))
    assert.ok(fx.mirrorStorages.get(others[0]).size() > 0, 'B has populated its own Mirror object')
    assert.equal(fx.headStorages.has(label) || fx.mirrorStorages.has(label), false, 'no object is named by the label')
    releaseB()
    const outcomeB = await withinSeconds(b, 10)
    assert.equal(outcomeB.error, undefined, String(outcomeB.error?.code))
    assert.equal(outcomeB.value.disposableStorageCleanedUp, true)
    assert.equal(outcomeB.value.label, label)
    assert.equal(outcomeB.value.targetName, others[0])
    assert.notEqual(outcomeB.value.attemptId, outcomeA.value.attemptId)
    for (const name of [nameA, others[0]]) assert.equal(fx.headStorages.get(name).size() + fx.mirrorStorages.get(name).size(), 0, name)
    assert.equal(drillRows(fx), 0)
  } finally {
    releaseA(); releaseB()
  }
})

test('two overlapping drills with one label both finish clean, each true for its own objects; all four objects end with zero rows', { timeout: 60000 }, async () => {
  const fx = await buildWorld()
  const label = 'x61-drill-overlap'
  const held = holdHeadApply(fx)
  const drill = () => settle(archive.executeEdgeArchiveOperation({ env: fx.env, seedId: fx.seedId, input: { action: 'rebuild_drill', targetName: label } }))
  const first = drill(), second = drill()
  try {
    // Both have applied their Mirror rows and wait at their HEAD applies: the two drills really overlap.
    await until(() => held.late.length === 2)
    const names = drillNames(fx)
    assert.equal(names.length, 2, names.join(', '))
    for (const name of names) assert.ok(fx.mirrorStorages.get(name).size() > 0, `${name} holds its own drill's Mirror rows`)
  } finally {
    held.release()
  }
  const outcomes = [await withinSeconds(first, 10), await withinSeconds(second, 10)]
  for (const outcome of outcomes) {
    assert.equal(outcome.error, undefined, String(outcome.error?.code))
    assert.equal(outcome.value.disposableStorageCleanedUp, true)
    assert.equal(outcome.value.ownerPhase, 'BOUND')
    assert.equal(outcome.value.label, label)
    assert.equal(outcome.value.targetName, `x61-drill-${outcome.value.attemptId}`)
  }
  assert.notEqual(outcomes[0].value.targetName, outcomes[1].value.targetName)
  assert.deepEqual(drillNames(fx).sort(), outcomes.map(outcome => outcome.value.targetName).sort())
  const objects = outcomes.flatMap(outcome => [fx.headStorages.get(outcome.value.targetName), fx.mirrorStorages.get(outcome.value.targetName)])
  assert.equal(objects.length, 4)
  assert.deepEqual(objects.map(storage => storage.size()), [0, 0, 0, 0])
})

test('a drill with no label, or a label of any allowed shape, writes only to its attempt\'s objects; the live name and other shapes are still refused before any object is made', async () => {
  const fx = await buildWorld()
  const plain = await archive.executeEdgeArchiveOperation({ env: fx.env, seedId: fx.seedId, input: { action: 'rebuild_drill' } })
  assert.equal(plain.label, null)
  assert.equal(plain.targetName, onlyDrillName(fx, null))
  for (const targetName of [LIVE, 'x61-main', 'X61-DRILL-UPPER', 'x61-drill-', `x61-drill-${'a'.repeat(65)}`]) {
    await assert.rejects(archive.executeEdgeArchiveOperation({ env: fx.env, seedId: fx.seedId, input: { action: 'rebuild_drill', targetName } }),
      error => error.code === 'LIVE_HEAD_REFUSED' && error.status === 403, targetName)
  }
  assert.equal(drillNames(fx).length, 1, 'a refused label made no object')
  assert.equal(drillRows(fx), 0)
})

// status time is about receipts + checkpoints x log(receipts), a wipe ends only an apply that has not
// committed and says the mark it leaves, and the size guard holds a blob to one piece, not to the status limits.

/** `n` chained receipts and an Ed25519-signed checkpoint at each of `counts`, with roots made the plain way (a tree each). */
function signedChain(n, counts) {
  const hash = bytes => createHash('sha256').update(bytes).digest()
  const rootOf = leaves => {
    if (leaves.length === 0) return hash(Buffer.alloc(0)).toString('hex')
    let level = leaves.map(leaf => Buffer.from(leaf, 'hex'))
    while (level.length > 1) {
      const next = []
      for (let i = 0; i < level.length; i += 2) next.push(i + 1 < level.length ? hash(Buffer.concat([Buffer.from([1]), level[i], level[i + 1]])) : level[i])
      level = next
    }
    return level[0].toString('hex')
  }
  const receipts = []
  let prevHash = '0'.repeat(64)
  for (let seq = 1; seq <= n; seq++) {
    const payload = { schema: 'aukora.receipt.v3', seq, at: '2026-01-01T00:00:00.000Z', kind: 'synthetic.review', prevHash, data: { n: seq } }
    const leafHash = hash(Buffer.concat([Buffer.from([0]), Buffer.from(canonicalJson(payload))])).toString('hex')
    receipts.push({ ...payload, leafHash })
    prevHash = leafHash
  }
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const publicKeyHex = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url').toString('hex')
  const checkpoints = []
  const signed = body => {
    const signatureHex = sign(null, Buffer.from('aukora.x5.edge-head.v1\0' + canonicalJson(body)), privateKey).toString('hex')
    const checkpoint = { body, publicKeyHex, signatureHex }
    return { ...checkpoint, checkpointHash: hash(canonicalJson(checkpoint)).toString('hex') }
  }
  for (const receiptCount of counts) {
    checkpoints.push(signed({ schema: 'aukora.edge-checkpoint.v1', seq: checkpoints.length + 1, at: '2026-01-01T00:00:00.000Z', receiptCount,
      lastReceiptHash: receiptCount === 0 ? '0'.repeat(64) : receipts[receiptCount - 1].leafHash,
      merkleRoot: rootOf(receipts.slice(0, receiptCount).map(row => row.leafHash)), prevCheckpointHash: checkpoints.at(-1)?.checkpointHash ?? null }))
  }
  const jsonl = rows => rows.map(row => JSON.stringify(row)).join('\n') + '\n'
  return { receiptsText: jsonl(receipts), checkpointsText: jsonl(checkpoints), checkpoints, signed }
}

/** SHA-256 digests WebCrypto computes while `operation` runs. */
async function digestsDuring(operation) {
  const original = crypto.subtle.digest
  let count = 0
  crypto.subtle.digest = function counted(...args) { count++; return original.apply(this, args) }
  try { await operation() } finally { delete crypto.subtle.digest }
  assert.equal(crypto.subtle.digest, original)
  return count
}

test('every prefix root from cached subtrees equals a tree built per checkpoint (counts 0 to 70); a wrong root is still refused', async () => {
  const counts = Array.from({ length: 71 }, (_, i) => i)
  const chain = signedChain(70, counts)
  const summary = await archive.verifyArchiveReceiptChain(chain.receiptsText, chain.checkpointsText)
  assert.equal(summary.receiptCount, 70)
  assert.equal(summary.checkpointCount, 71)
  assert.equal(summary.lastCheckpointReceiptCount, 70)
  for (const at of [1, 2, 3, 37, 64]) {
    const rows = chain.checkpoints.slice(0, at)
    const { checkpointHash: _hash, publicKeyHex: _key, signatureHex: _sig, ...last } = rows.at(-1)
    rows[at - 1] = chain.signed({ ...last.body, merkleRoot: 'ab'.repeat(32) })
    await assert.rejects(archive.verifyArchiveReceiptChain(chain.receiptsText, rows.map(row => JSON.stringify(row)).join('\n')),
      error => error.code === 'ARCHIVE_CHECKPOINT_INVALID' && error.seq === at, `a wrong root at checkpoint ${at}`)
  }
})

test('verifying 512 receipts and 64 checkpoints costs about receipts + checkpoints x log2(receipts) hashes, not a tree per checkpoint', async () => {
  const receipts = 512
  const counts = Array.from({ length: 64 }, (_, i) => 8 * (i + 1))
  const chain = signedChain(receipts, counts)
  let summary = null
  const digests = await digestsDuring(async () => { summary = await archive.verifyArchiveReceiptChain(chain.receiptsText, chain.checkpointsText) })
  assert.equal(summary.checkpointCount, 64)
  // Leaf hashes and the full root (2 per receipt), the subtree levels (1 per receipt), and per checkpoint at most
  // log2(512) = 9 fold hashes plus its own checkpoint hash. A tree per checkpoint is over 16,000.
  const ceiling = 3 * receipts + counts.length * (Math.log2(receipts) + 1)
  assert.ok(digests <= ceiling, `${digests} digests, ceiling ${ceiling}`)
})

test('an end:true wipe that finds its drill\'s apply already committed deletes everything and leaves no mark, so the name is free again', async () => {
  const fx = await buildWorld()
  const { bundle } = await archive.exportColdArchive({ headStorage: fx.headStorages.get(LIVE), mirrorStorage: fx.mirrorStorages.get(LIVE),
    expectedOwnerPublicKeyHex: fx.env.OWNER_PUBLIC_KEY_HEX })
  const bodies = {
    HEAD: ['/_head/archive-drill-apply', '/_head/archive-drill-wipe', { seedId: bundle.seedId, head: bundle.head }, fx.env.HEAD, fx.headStorages],
    MIRROR: ['/_mirror/archive-drill-apply', '/_mirror/archive-drill-wipe', { seedId: bundle.seedId, ballId: bundle.head.ball.ballId, epoch: bundle.head.ball.epoch, mirror: bundle.mirror }, fx.env.MIRROR, fx.mirrorStorages],
  }
  for (const [object, [applyPath, wipePath, body, binding, storages]] of Object.entries(bodies)) {
    const name = `x61-drill-committed-${object.toLowerCase()}`
    const a = crypto.randomUUID(), b = crypto.randomUUID()
    const applied = await internal(binding, name, applyPath, { ...body, targetName: name, drillId: a })
    assert.equal(applied.status, 200, `${object}: ${await applied.clone().text()}`)
    assert.ok(storages.get(name).size() > 1, `${object}: the apply committed its rows`)
    // Drill A gave up waiting for that reply, so its wipe asks to end the object.
    const wiped = await internal(binding, name, wipePath, { targetName: name, drillId: a, end: true })
    assert.deepEqual(await wiped.json(), { ok: true, wiped: true, remainingRows: 0 }, object)
    assert.equal(storages.get(name).size(), 0, `${object}: no mark is left behind a committed apply`)
    const next = await internal(binding, name, applyPath, { ...body, targetName: name, drillId: b })
    assert.equal(next.status, 200, `${object}: a later drill may use the name (${await next.clone().text()})`)
    const cleaned = await internal(binding, name, wipePath, { targetName: name, drillId: b })
    assert.deepEqual(await cleaned.json(), { ok: true, wiped: true, remainingRows: 0 }, object)
    assert.equal(storages.get(name).size(), 0, object)
  }
})

test('a HEAD apply that commits but answers after the deadline: the drill reports a clean cleanup that is true, and the next drill on that name succeeds', { timeout: 60000 }, async () => {
  const fx = await buildWorld()
  const label = 'x61-drill-late-reply'
  let release
  const gate = new Promise(resolve => { release = resolve })
  fx.log.overrides.set('HEAD /_head/archive-drill-apply', async (request, real) => {
    const reply = await real.fetch(request)
    await gate
    return reply
  })
  const error = await withinSeconds(archive.executeEdgeArchiveOperation({ env: fx.env, seedId: fx.seedId, input: { action: 'rebuild_drill', targetName: label },
    drillDeadlineMs: 200, drillWipeDeadlineMs: 2000 }), 10).then(() => null, caught => caught)
  release()
  assert.equal(error?.code, 'DRILL_DEADLINE_EXCEEDED', String(error?.message))
  assert.equal(error.step, 'HEAD_APPLY')
  const target = onlyDrillName(fx, label)
  assert.deepEqual(error.cleanup, { pending: false, targetName: target, objects: [{ object: 'HEAD', remainingRows: 0 }, { object: 'MIRROR', remainingRows: 0 }] })
  assert.equal(fx.headStorages.get(target).size(), 0, 'nothing, not even a mark, is left in HEAD')
  assert.equal(drillRows(fx), 0)
  fx.log.overrides.delete('HEAD /_head/archive-drill-apply')
  const next = await archive.executeEdgeArchiveOperation({ env: fx.env, seedId: fx.seedId, input: { action: 'rebuild_drill', targetName: label } })
  assert.equal(next.disposableStorageCleanedUp, true)
  assert.equal(next.label, label)
  assert.notEqual(next.targetName, target, 'the next attempt has objects of its own')
  assert.equal(drillRows(fx), 0)
})

test('export and the live drill keep the one-piece rule, not the status limits: a 2.2 MiB module, a manifest over 4 MiB and 257 modules are exported; status still refuses each, named', { timeout: 600000 }, async () => {
  const fx = await buildWorld()
  const sized = bytes => i => `//${'m'.repeat(bytes - 3 - String(i).length)}${i}\n`
  const bigModule = await withExtraModules(fx, 1, sized(Math.round(2.2 * MIB)))
  const manifest = await manifestOfBytes(fx, LIMITS.manifestBytes + 1)
  const existing = Object.keys(fx.ball.modules).length
  const many = await withExtraModules(fx, LIMITS.moduleCount - existing + 1)
  const cases = [
    ['a 2.2 MiB module', bigModule.draft, bigModule.extraCode, 'ARCHIVE_STATUS_MODULE_TOO_LARGE', LIMITS.moduleBytes],
    ['a manifest one byte over 4 MiB', manifest, {}, 'ARCHIVE_STATUS_MANIFEST_TOO_LARGE', LIMITS.manifestBytes],
    ['257 modules', many.draft, many.extraCode, 'ARCHIVE_STATUS_TOO_MANY_MODULES', LIMITS.moduleCount],
  ]
  for (const [label, draft, extraCode, statusCode, limit] of cases) {
    const ball = await setLiveBall(fx, draft, extraCode)
    const status = await exportReply(await fx.call(ARCHIVE))
    assert.equal(status.status, 413, `${label}: ${status.text.slice(0, 300)}`)
    assert.equal(status.value.code, statusCode, label)
    await assert.rejects(archive.executeEdgeArchiveOperation({ env: fx.env, seedId: fx.seedId, input: { action: 'status' } }),
      error => error.code === statusCode && error.limit === limit, `${label}: the status limit is named`)
    const exported = await exportReply(await fx.call(ARCHIVE, { action: 'export' }))
    assert.equal(exported.status, 200, `${label}: ${exported.text.slice(0, 300)}`)
    assert.equal(exported.value.ballId, ball.ballId, label)
    assert.ok(fx.r2.objects.has(exported.value.r2Key), `${label}: the snapshot is written`)
  }
  await setLiveBall(fx, bigModule.draft, bigModule.extraCode)
  const drill = await archive.executeEdgeArchiveOperation({ env: fx.env, seedId: fx.seedId, input: { action: 'rebuild_drill', targetName: 'x61-drill-big-module' } })
  assert.equal(drill.disposableStorageCleanedUp, true)
  assert.equal(drillRows(fx), 0)
})

// the cleanup, the step and the limit reach the owner through the Worker, each checked; every observed
// key of a drill object is counted; the status metadata budget is held page by page.

const MARKED_PRIVATE_PATH = '/dsh/home/auma/private-mark-r1d/never-in-a-reply-q7.md'
const MARKED_PRIVATE_BODY = 'PRIVATE-BODY-MARK-r1d: owner words that must stay home'

test('through the Worker, the review\'s example (parity failure, then a failed Mirror deletion) answers its code with the checked cleanup, and nothing of the owner\'s', async () => {
  const fx = await buildWorld()
  await putMirrorFile(fx, MARKED_PRIVATE_PATH, MARKED_PRIVATE_BODY)
  failDrillMirrorWipes(fx)
  fx.log.overrides.set('HEAD /_head/archive-drill-apply', async (request, real) => {
    const value = await (await real.fetch(request)).json()
    return Response.json({ ...value, moduleCount: value.moduleCount + 1 })
  })
  const label = 'x61-drill-r1-worker'
  const reply = await exportReply(await fx.call(ARCHIVE, { action: 'rebuild_drill', targetName: label }))
  assert.equal(reply.status, 503, reply.text)
  assert.equal(reply.value.code, 'DRILL_READBACK_PARITY_FAILED')
  assert.equal(reply.value.cleanup?.pending, true, 'the pending cleanup reaches the owner')
  const target = onlyDrillName(fx, label)
  const left = fx.mirrorStorages.get(target).size()
  assert.ok(left > 1, 'the Mirror object really holds rows')
  assert.ok((await fx.mirrorStorages.get(target).list()).has(`mirror:v2:entry:${rowId(MARKED_PRIVATE_PATH)}`), 'the marked file is among them')
  assert.deepEqual(reply.value, { ok: false, code: 'DRILL_READBACK_PARITY_FAILED',
    cleanup: { pending: true, targetName: target, objects: [{ object: 'HEAD', remainingRows: 0 }, { object: 'MIRROR', remainingRows: left }] } })
  for (const secret of ['private-mark-r1d', 'never-in-a-reply', 'PRIVATE-BODY-MARK', Buffer.from(MARKED_PRIVATE_BODY).toString('base64').slice(0, 24),
    fx.ball.ballId, fx.seedId, '/dsh/', label, ...SECRET_MARKERS]) {
    assert.equal(reply.text.includes(secret), false, `the reply carries no ${secret.slice(0, 24)}`)
  }
  assert.doesNotMatch(reply.text, /[0-9a-f]{64}/, 'no hash of any kind')
})

test('through the Worker, a limit refusal names its limit; a drill that runs out of time names its step and its cleanup; an ordinary refusal carries none of the three', { timeout: 60000 }, async () => {
  const fx = await buildWorld()
  // A limit: the receipts file's entry row says one byte over the limit (no chunk is needed: it is refused from the row).
  const mirror = fx.mirrorStorages.get(LIVE)
  const entryKey = `mirror:v2:entry:${rowId(RECEIPTS_PATH)}`
  const entry = await mirror.get(entryKey)
  await mirror.put(entryKey, { ...entry, bytes: LIMITS.seedFileBytes + 1 })
  const limited = await exportReply(await fx.call(ARCHIVE))
  assert.equal(limited.status, 413, limited.text)
  assert.deepEqual(limited.value, { ok: false, code: 'ARCHIVE_STATUS_SEED_FILE_TOO_LARGE', limit: LIMITS.seedFileBytes })
  await mirror.put(entryKey, entry)

  // A step: HEAD's apply is held and the clock has passed the drill's deadline when its wait begins.
  let release
  const gate = new Promise(resolve => { release = resolve })
  const realNow = Date.now
  let late = null
  fx.log.overrides.set('HEAD /_head/archive-drill-apply', (request, real) => {
    Date.now = () => realNow() + 10 * 60 * 1000
    queueMicrotask(() => { Date.now = realNow })
    const answer = gate.then(() => real.fetch(request))
    late = answer.then(response => response.clone().json())
    return answer
  })
  let timed
  try {
    timed = await exportReply(await withinSeconds(fx.call(ARCHIVE, { action: 'rebuild_drill', targetName: 'x61-drill-r1-step' }), 20))
  } finally {
    Date.now = realNow
    release()
  }
  assert.equal(timed.status, 503, timed.text)
  const target = onlyDrillName(fx, 'x61-drill-r1-step')
  assert.deepEqual(timed.value, { ok: false, code: 'DRILL_DEADLINE_EXCEEDED', step: 'HEAD_APPLY',
    cleanup: { pending: true, targetName: target, objects: [{ object: 'HEAD', remainingRows: 1, endMarkLeft: true }, { object: 'MIRROR', remainingRows: 0 }] } })
  assert.equal((await late).code, 'DRILL_TARGET_ENDED')
  assert.equal(drillRows(fx), 0, 'the late apply wrote nothing and removed the mark')
  fx.log.overrides.delete('HEAD /_head/archive-drill-apply')

  // Ordinary refusals: exactly ok and code.
  for (const [body, status, code] of [[{ action: 'no_such_action' }, 400, 'ARCHIVE_ACTION_INVALID'], [{ action: 'rebuild_drill', targetName: LIVE }, 403, 'LIVE_HEAD_REFUSED'],
    [{ action: 'rebuild_drill', r2Key: 'snapshots/LATEST.json' }, 400, 'ARCHIVE_R2_KEY_INVALID']]) {
    const plain = await exportReply(await fx.call(ARCHIVE, body))
    assert.equal(plain.status, status, plain.text)
    assert.deepEqual(plain.value, { ok: false, code }, code)
  }
})

test('through the Worker, a drill that fails with no code (HEAD\'s apply rejects; a read-back that throws a TypeError) answers DRILL_FAILED with its cleanup, never a bare CLOUD_REQUEST_FAILED', async () => {
  const fx = await buildWorld()
  failDrillMirrorWipes(fx)
  // The HEAD object is reset mid-drill: its apply rejects with a plain Error and never answers.
  fx.log.overrides.set('HEAD /_head/archive-drill-apply', async () => { throw new Error('test: HEAD object reset mid-apply') })
  const rejected = await exportReply(await fx.call(ARCHIVE, { action: 'rebuild_drill', targetName: 'x61-drill-uncoded' }))
  assert.equal(rejected.status, 503, rejected.text)
  const target = onlyDrillName(fx, 'x61-drill-uncoded')
  const left = fx.mirrorStorages.get(target).size()
  assert.ok(left > 0, 'the Mirror object really holds rows')
  assert.deepEqual(rejected.value, { ok: false, code: 'DRILL_FAILED',
    cleanup: { pending: true, targetName: target, objects: [{ object: 'HEAD', remainingRows: 1, endMarkLeft: true }, { object: 'MIRROR', remainingRows: left }] } })
  assert.equal(rejected.text.includes('mid-apply'), false, 'the raw error message stays at the edge')
  fx.log.overrides.delete('HEAD /_head/archive-drill-apply')

  // Both applies answer, then the drill Mirror's read-back has no entries: the read-back code throws a TypeError.
  let applied = false
  fx.log.overrides.set('HEAD /_head/archive-drill-apply', async (request, real) => { applied = true; return real.fetch(request) })
  fx.log.overrides.set('MIRROR /_mirror/archive-state', async (request, real) => (applied ? Response.json({ ok: true }) : real.fetch(request)))
  const thrown = await exportReply(await fx.call(ARCHIVE, { action: 'rebuild_drill', targetName: 'x61-drill-uncoded' }))
  assert.equal(thrown.status, 503, thrown.text)
  const second = drillNames(fx).find(name => name !== target)
  assert.match(second ?? '', ATTEMPT_OBJECT)
  assert.deepEqual(thrown.value, { ok: false, code: 'DRILL_FAILED',
    cleanup: { pending: true, targetName: second, objects: [{ object: 'HEAD', remainingRows: 0 }, { object: 'MIRROR', remainingRows: fx.mirrorStorages.get(second).size() }] } })
  assert.equal(/TypeError|entries/.test(thrown.text), false, 'the raw error stays at the edge')
})

test('archiveErrorReply passes a cleanup only in its exact shape, a step only as a short upper-case code, a limit only as a safe integer', () => {
  assert.equal(typeof archive.archiveErrorReply, 'function')
  const name = `x61-drill-${'0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'}`
  const good = { pending: true, targetName: name, objects: [{ object: 'HEAD', remainingRows: null }, { object: 'MIRROR', remainingRows: 65, remainingRowsAtLeast: true, endMarkLeft: true }] }
  const reply = error => archive.archiveErrorReply(Object.assign(new Error('x'), error))
  assert.deepEqual(reply({ code: 'DRILL_CLEANUP_PENDING', status: 503, cleanup: good, step: 'MIRROR_READBACK', limit: 0 }),
    { status: 503, body: { ok: false, code: 'DRILL_CLEANUP_PENDING', cleanup: good, step: 'MIRROR_READBACK', limit: 0 } })
  const forged = [
    { ...good, label: 'x' }, { ...good, targetName: 'x61-drill-chosen-by-a-caller' }, { ...good, targetName: LIVE }, { ...good, pending: 'yes' },
    { ...good, objects: [{ object: 'HEAD', remainingRows: 0, path: MARKED_PRIVATE_PATH }] }, { ...good, objects: [{ object: 'LIVE', remainingRows: 0 }] },
    { ...good, objects: [{ object: 'HEAD', remainingRows: -1 }] }, { ...good, objects: [{ object: 'HEAD', remainingRows: 66 }] },
    { ...good, objects: [{ object: 'HEAD', remainingRows: '0' }] }, { ...good, objects: [{ object: 'HEAD', remainingRows: 0, endMarkLeft: false }] },
    { ...good, objects: [{ object: 'HEAD', remainingRows: 0 }, { object: 'HEAD', remainingRows: 0 }] }, { ...good, objects: [...good.objects, good.objects[0]] },
    { ...good, objects: 'HEAD' }, [good], 'cleanup', null,
  ]
  for (const cleanup of forged) assert.deepEqual(reply({ code: 'DRILL_READBACK_PARITY_FAILED', status: 503, cleanup }).body, { ok: false, code: 'DRILL_READBACK_PARITY_FAILED' }, JSON.stringify(cleanup))
  for (const step of ['head_apply', 'HEAD APPLY', `${'A'.repeat(41)}`, '/dsh/home', 7, MARKED_PRIVATE_BODY]) assert.equal(reply({ code: 'C', status: 503, step }).body.step, undefined, String(step))
  for (const limit of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, '4194304', null]) assert.equal(reply({ code: 'C', status: 413, limit }).body.limit, undefined, String(limit))
  // The outer catch's status rule, and its code rule: an uncoded error is not answered here.
  assert.equal(reply({ code: 'ARCHIVE_SNAPSHOT_NOT_FOUND', status: 404 }).status, 503)
  assert.equal(reply({ code: 'ARCHIVE_TOO_LARGE_FOR_ONE_PIECE', status: 413 }).status, 413)
  for (const code of [undefined, 'lower', 'A'.repeat(81), 7]) assert.equal(reply({ code, status: 400 }), null, String(code))
})

const DRILL_MARK_SCHEMA = 'aukora.archive-drill-mark.v1'

test('a wipe counts every key it observes: a mark and two rows with a throwing deletion are three; a mark alone that a no-op deletion leaves is one, never zero', async () => {
  const fx = await buildWorld()
  for (const [binding, storages, path] of [[fx.env.HEAD, fx.headStorages, '/_head/archive-drill-wipe'], [fx.env.MIRROR, fx.mirrorStorages, '/_mirror/archive-drill-wipe']]) {
    const own = crypto.randomUUID()
    const name = `x61-drill-r3-${path.includes('head') ? 'head' : 'mirror'}`
    binding.get(name)
    const storage = storages.get(name)
    await storage.put(DRILL_MARK, { schema: DRILL_MARK_SCHEMA, drillId: own, ended: false })
    await storage.put('row-a', 1)
    await storage.put('row-b', 2)
    storage.deleteAll = async () => { throw new Error('test: deleteAll refused') }
    for (const end of [false, true]) {
      const reply = await internal(binding, name, path, { targetName: name, drillId: own, end })
      assert.equal(reply.status, 503, `${path} end:${end}`)
      assert.deepEqual(await reply.json(), { ok: false, code: 'DRILL_WIPE_INCOMPLETE', remainingRows: 3 }, `${path} end:${end}`)
      assert.equal(storage.size(), 3)
    }
    // The mark alone, and a deletion that answers but removes nothing.
    await storage.delete('row-a')
    await storage.delete('row-b')
    storage.deleteAll = async () => {}
    const markOnly = await internal(binding, name, path, { targetName: name, drillId: own })
    assert.deepEqual(await markOnly.json(), { ok: false, code: 'DRILL_WIPE_INCOMPLETE', remainingRows: 1 }, path)
    // With no mark of its own, an ending wipe that cannot delete counts its two rows and the end mark it wrote.
    const fresh = `${name}-end`
    binding.get(fresh)
    const other = storages.get(fresh)
    await other.put('row-a', 1)
    await other.put('row-b', 2)
    other.deleteAll = async () => { throw new Error('test: deleteAll refused') }
    const ended = await internal(binding, fresh, path, { targetName: fresh, drillId: crypto.randomUUID(), end: true })
    assert.deepEqual(await ended.json(), { ok: false, code: 'DRILL_WIPE_INCOMPLETE', remainingRows: 3, endMarkLeft: true }, path)
    assert.equal(other.size(), 3)
  }
})

test('status refuses metadata past its budget having fetched at most one page beyond it, never every row first', { timeout: 120000 }, async () => {
  const page = 64
  const fx = await buildWorld()
  const mirror = fx.mirrorStorages.get(LIVE)
  const rows = 1500
  const pad = 'p'.repeat(16 * 1024)
  for (let i = 0; i < rows; i++) {
    const path = `/dsh/home/auma/r4/d${String(i).padStart(5, '0')}`
    await mirror.put(`mirror:v2:entry:${rowId(path)}`, { path, kind: 'dir', mode: 0o755, pad })
  }
  const rowBytes = Buffer.byteLength(JSON.stringify({ path: '/dsh/home/auma/r4/d00000', kind: 'dir', mode: 0o755, pad }))
  assert.ok(rows * rowBytes > 2 * LIMITS.metadataBytes, 'the store is far past the budget')
  fx.log.reset()
  const status = await exportReply(await fx.call(ARCHIVE))
  assert.equal(status.status, 413, status.text.slice(0, 300))
  assert.equal(status.value.code, 'ARCHIVE_STATUS_METADATA_TOO_LARGE')
  const listed = fx.log.listedRows.filter(entry => entry.prefix === 'mirror:v2:entry:')
  const fetched = listed.reduce((sum, entry) => sum + entry.rows, 0)
  assert.ok(fetched <= Math.ceil(LIMITS.metadataBytes / rowBytes) + page, `${fetched} rows fetched; the budget is passed at ${Math.ceil(LIMITS.metadataBytes / rowBytes)}`)
  assert.ok(fetched < rows)
  assert.ok(listed.every(entry => entry.rows <= page), 'every listing is one page')
  assert.deepEqual(status.value, { ok: false, code: 'ARCHIVE_STATUS_METADATA_TOO_LARGE', limit: LIMITS.metadataBytes })
  assert.equal(archive.STATUS_METADATA_PAGE_ROWS, page)
})

test('paging lists every row exactly once (a store of several full pages gives the same plan as one listing would), and a store that ignores startAfter is refused, never looped over', { timeout: 120000 }, async () => {
  const fx = await buildWorld()
  const mirror = fx.mirrorStorages.get(LIVE)
  for (let i = 0; i < 64 * 3; i++) {
    const path = `/dsh/home/auma/paged/d${String(i).padStart(4, '0')}`
    await mirror.put(`mirror:v2:entry:${rowId(path)}`, { path, kind: 'dir', mode: 0o755 })
  }
  for (let i = 0; i < 64; i++) await mirror.put(`mirror:v2:reset:${rowId(`/dsh/home/auma/gone/g${i}`)}`, `/dsh/home/auma/gone/g${i}`)
  const plan = await (await internal(fx.env.MIRROR, LIVE, '/_mirror/archive-plan', { seedFiles: false })).json()
  assert.equal(plan.ok, true, JSON.stringify(plan))
  assert.equal(plan.totals.entries, 7 + 64 * 3)
  assert.equal(plan.totals.dirs, 3 + 64 * 3)
  assert.equal(plan.totals.resetCount, 64)
  const list = mirror.list
  mirror.list = ({ startAfter: _ignored, ...options } = {}) => list(options)
  const looping = await internal(fx.env.MIRROR, LIVE, '/_mirror/archive-plan', { seedFiles: false })
  assert.equal(looping.status, 503)
  assert.equal((await looping.json()).code, 'ARCHIVE_MIRROR_LIST_INVALID')
  mirror.list = list
})
