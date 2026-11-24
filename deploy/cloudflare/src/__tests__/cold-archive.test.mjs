/** Cold archive, composite owner-bound head commitment (D4b anti-silence), and fail-stop DO rebuild drill tests. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createHmac, generateKeyPairSync } from 'node:crypto'
import { isoCBOR } from '@simplewebauthn/server/helpers'
import { createReceiptChainFixture } from './fixtures/cold-archive/receipt-chain.mjs'
import { canonicalJson } from '../owner-grant-policy.mjs'
import { createWorker } from '../worker.mjs'
import { X61HeadDurableObject, canonicalBootstrap, digest, manifestId, BOOTSTRAP_VERSION } from '../head-do.mjs'
import { MirrorDO } from '../mirror-do.mjs'
import { AUMLOK_STORAGE_KEY } from '../aumlok.mjs'
import {
  COLD_ARCHIVE_SCHEMA,
  COMPOSITE_HEAD_SCHEMA,
  exportColdArchive,
  executeEdgeArchiveOperation,
  verifyColdArchive,
  runDisposableRebuildDrill,
} from '../cold-archive.mjs'

const ORIGIN = 'https://x61.example.invalid'

function createMemoryStorage() {
  const data = new Map()
  let alarm = null
  const view = {
    get: async key => (data.has(key) ? structuredClone(data.get(key)) : undefined),
    put: async (key, value) => { data.set(key, structuredClone(value)) },
    delete: async key => data.delete(key),
    deleteAll: async () => { data.clear(); alarm = null },
    list: async ({ prefix = '', limit = Infinity } = {}) => {
      const out = new Map()
      for (const [k, v] of [...data.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
        if (k.startsWith(prefix)) {
          out.set(k, structuredClone(v))
          if (out.size >= limit) break
        }
      }
      return out
    },
    getAlarm: async () => alarm,
    setAlarm: async at => { alarm = at },
    deleteAlarm: async () => { alarm = null },
    transaction: async fn => fn(view),
    size: () => data.size,
    snapshot: () => Object.fromEntries([...data.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
  }
  return view
}

function createMemoryR2Bucket() {
  const objects = new Map()
  return {
    objects,
    async put(key, value, options = {}) {
      const text = typeof value === 'string' ? value : new TextDecoder().decode(value)
      objects.set(key, { text, options })
    },
    async get(key) {
      const entry = objects.get(key)
      if (!entry) return null
      return {
        // R2 always reports an object's size; the drill refuses one over ONE_PIECE_MAX before reading it.
        size: Buffer.byteLength(entry.text),
        customMetadata: entry.options.customMetadata ?? {},
        text: async () => entry.text,
        json: async () => JSON.parse(entry.text),
      }
    },
  }
}

async function create68ModuleOrganismFixture() {
  const { receiptsText, checkpointsText } = createReceiptChainFixture()

  const ownerPublicKeyHex = '11'.repeat(32)
  const nodePubkeyHex = '22'.repeat(32)
  const aumlokId = '33'.repeat(32)
  // a credential the AUMLOK store loads: base64url id and a real COSE P-256 public key (made up, never used to sign).
  const credentialId = Buffer.from('cred-touchid-epoch65-bound').toString('base64url')
  const passkeyJwk = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey.export({ format: 'jwk' })
  const credentialPublicKeyB64 = Buffer.from(isoCBOR.encode(new Map([
    [1, 2], [3, -7], [-1, 1], [-2, Buffer.from(passkeyJwk.x, 'base64url')], [-3, Buffer.from(passkeyJwk.y, 'base64url')],
  ]))).toString('base64url')

  const codeBySha = {}
  const modules = {}
  const entries = {}
  for (let i = 0; i < 68; i++) {
    const organId = i === 0 ? 'seed-pearl' : `organ-${String(i).padStart(2, '0')}`
    const source = `export const organ = ${JSON.stringify(organId)}; export const rev = ${67 + i};\n`
    const sha = await digest(source)
    codeBySha[sha] = source
    modules[sha] = { sha256: sha, specifier: `ball:${sha}`, size: Buffer.byteLength(source) }
    entries[organId] = {
      id: organId,
      specifier: `ball:${sha}`,
      disabled: false,
      config: {},
      previousSpecifiers: [],
    }
  }

  const ballDraft = {
    version: 'x6.1-ball/v1',
    epoch: 167,
    parentBallId: '44'.repeat(32),
    createdAt: '2026-11-11T00:00:00.000Z',
    authorPeerId: 'auma-live-body',
    entries,
    modules,
  }
  const ball = { ...ballDraft, ballId: await manifestId(ballDraft) }

  const mirrorEntries = [
    ['/dsh/home/auma', { kind: 'dir', mode: 0o755 }],
    ['/dsh/home/auma/HANDOFF.md', {
      kind: 'file',
      mode: 0o644,
      mtimeMs: 1794348000000,
      b64: Buffer.from(`# HANDOFF\nepoch: ${ball.epoch}\nballId: ${ball.ballId}\n`).toString('base64'),
    }],
    ['/dsh/home/auma/index', { kind: 'dir', mode: 0o755 }],
    ['/dsh/home/auma/index/RECALL.md', {
      kind: 'file',
      mode: 0o644,
      mtimeMs: 1794348000000,
      b64: Buffer.from('# RECALL\n- Epoch 165 promoted with owner Touch ID.\n').toString('base64'),
    }],
    ['/dsh/home/auma/seed', { kind: 'dir', mode: 0o755 }],
    ['/dsh/home/auma/seed/checkpoints.v1.jsonl', {
      kind: 'file',
      mode: 0o644,
      mtimeMs: 1794348000000,
      b64: Buffer.from(checkpointsText, 'utf8').toString('base64'),
    }],
    ['/dsh/home/auma/seed/receipts.v3.jsonl', {
      kind: 'file',
      mode: 0o644,
      mtimeMs: 1794348000000,
      b64: Buffer.from(receiptsText, 'utf8').toString('base64'),
    }],
  ].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))

  const batchDigest = await digest(canonicalBootstrap(mirrorEntries))
  const seedPayload = {
    version: BOOTSTRAP_VERSION,
    ball,
    codeBySha,
    mirror: {
      entryCount: mirrorEntries.length,
      batchDigests: [batchDigest],
    },
  }
  const seedId = await digest(canonicalBootstrap(seedPayload))
  const pkg = { ...seedPayload, seedId }

  const headStorages = new Map()
  const mirrorStorages = new Map()
  const headObjects = new Map()
  const mirrorObjects = new Map()

  const env = {
    PUBLIC_HOST: 'x61.example.invalid',
    OWNER_EMAIL: 'owner@example.invalid',
    OWNER_PUBLIC_KEY_HEX: ownerPublicKeyHex,
    AUMLOK_CUSTODY_PEPPER: '55'.repeat(32),
    HEAD: {
      idFromName: name => name,
      get: name => {
        if (!headObjects.has(name)) {
          const storage = createMemoryStorage()
          headStorages.set(name, storage)
          headObjects.set(name, new X61HeadDurableObject({ storage, getWebSockets: () => [] }, env))
        }
        return headObjects.get(name)
      },
    },
    MIRROR: {
      idFromName: name => name,
      get: name => {
        if (!mirrorObjects.has(name)) {
          const storage = createMemoryStorage()
          mirrorStorages.set(name, storage)
          mirrorObjects.set(name, new MirrorDO({ storage }, env))
        }
        return mirrorObjects.get(name)
      },
    },
  }

  const worker = createWorker({
    verifyAccess: async () => ({ type: 'owner', email: 'owner@example.invalid', expires: Math.floor(Date.now() / 1000) + 3600 }),
    now: () => 1794350000000,
  })

  const postBootstrap = body => worker.fetch(new Request(`${ORIGIN}/_bootstrap`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }), env)

  assert.equal((await postBootstrap({ action: 'prepare', package: pkg })).status, 200)
  assert.equal((await postBootstrap({ action: 'batch', seedId, index: 0, entries: mirrorEntries })).status, 200)
  assert.equal((await postBootstrap({ action: 'commit', seedId })).status, 200)

  // a complete legacy (pepper not separated) BOUND row the AUMLOK store loads, with MADE-UP recovery values. The
  // drill now refuses an owner row the store would not load, so the earlier summary-fields-only row no longer passes.
  const boundAumlok = {
    schema: 'aukora.aumlok.state.v2',
    generation: 1,
    binding: {
      aumlokId,
      recoveryCommitment: '66'.repeat(32),
      rootEscrow: { schema: 'aukora.aumlok.escrow.v2', ivB64: Buffer.from('cold-archive').toString('base64url'),
        ciphertextB64: Buffer.from('cold-archive-made-up-escrow-ciphertext-48-bytes!').toString('base64url') },
      nodePubkeyHex,
      credential: {
        id: credentialId,
        publicKeyB64: credentialPublicKeyB64,
        counter: 7,
      },
      boundAt: 1794340000000,
      lastVerifiedAt: 1794345000000,
      generation: 1,
    },
    'pepper.v1': Buffer.from('cold-archive-made-up-pepper-32b!').toString('base64url'),
    challenges: [], invites: [], revocations: [],
    failures: 0, failedAt: [], nextAllowedAt: 0, attempts: [], approvals: [],
    enrollmentCount: 1, enrollments: [],
  }
  // The owner's enrollment record, MAC'd under the made-up pepper exactly as the store writes it.
  const enrollment = { schema: 'aumlok.enrollment.v1', at: boundAumlok.binding.boundAt, intentHash: '77'.repeat(32),
    nodePubkeyHex, ownerPublicKeyHex, credentialId }
  boundAumlok.enrollments.push({ ...enrollment, recordMac: createHmac('sha256', Buffer.from(boundAumlok['pepper.v1'], 'base64url'))
    .update(`aukora.aumlok.enrollment.v1\0${canonicalJson(enrollment)}`).digest('hex') })
  await headStorages.get('node-main-v1').put(AUMLOK_STORAGE_KEY, boundAumlok)

  return {
    env,
    worker,
    ball,
    seedId,
    ownerPublicKeyHex,
    credentialId,
    headStorages,
    mirrorStorages,
  }
}

test('C2: 68-module R2 cold archive + disposable DO rebuild drill preserves ballId, Merkle root, signed checkpoints, BOUND credential, and composite head commitment', async () => {
  const fx = await create68ModuleOrganismFixture()

  // Before binding ARCHIVE_BUCKET, /api/health truthfully reports coldR2Backup: false
  const healthUnbound = await (await fx.worker.fetch(new Request(`${ORIGIN}/api/health`), fx.env)).json()
  assert.equal(healthUnbound.capabilities.coldR2Backup, false)
  assert.equal(healthUnbound.unsupported.includes('cold-r2-backup'), true)

  // Bind in-memory R2 bucket and verify /api/health flips truthfully
  const r2 = createMemoryR2Bucket()
  fx.env.ARCHIVE_BUCKET = r2
  const healthBound = await (await fx.worker.fetch(new Request(`${ORIGIN}/api/health`), fx.env)).json()
  assert.equal(healthBound.capabilities.coldR2Backup, true)
  assert.equal(healthBound.unsupported.includes('cold-r2-backup'), false)

  // Export via POST /_host/archive
  const exportResp = await fx.worker.fetch(new Request(`${ORIGIN}/_host/archive`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'export', includeBundle: true }),
  }), fx.env)
  assert.equal(exportResp.status, 200)
  const exported = await exportResp.json()
  assert.equal(exported.ok, true)
  assert.equal(exported.r2Stored, true)
  assert.equal(exported.epoch, 167)
  assert.equal(exported.ballId, fx.ball.ballId)
  assert.equal(exported.moduleCount, 68)
  assert.equal(exported.receiptsSummary.receiptCount, 87)
  assert.equal(exported.receiptsSummary.checkpointCount, 6)
  assert.equal(exported.receiptsSummary.merkleRoot, 'c7f215e13155bd9e8d2f03134a074b83160634790691e51c29917554001528e5')
  assert.equal(exported.ownerSummary.phase, 'BOUND')
  assert.equal(exported.ownerSummary.credentialId, fx.credentialId)
  assert.equal(exported.ownerSummary.signerCounter, 7)
  assert.equal(exported.compositeHead.schema, COMPOSITE_HEAD_SCHEMA)
  assert.equal(exported.bundle.schema, COLD_ARCHIVE_SCHEMA)

  // Verify R2 content-addressed objects + LATEST pointer exist
  assert.ok(r2.objects.has('snapshots/LATEST.json'))
  assert.ok(r2.objects.has(exported.r2Key))
  const moduleKeys = [...r2.objects.keys()].filter(k => k.startsWith('modules/'))
  assert.equal(moduleKeys.length, 68)

  // Run rebuild_drill via POST /_host/archive from R2 snapshot into disposable DO namespace
  const drillTarget = 'x61-drill-ci-parity-01'
  const drillResp = await fx.worker.fetch(new Request(`${ORIGIN}/_host/archive`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'rebuild_drill', targetName: drillTarget, r2Key: exported.r2Key }),
  }), fx.env)
  assert.equal(drillResp.status, 200)
  const drill = await drillResp.json()
  assert.equal(drill.ok, true)
  // the name given is the reply's label; the drill wrote only to its attempt's own objects.
  assert.equal(drill.label, drillTarget)
  assert.equal(drill.targetName, `x61-drill-${drill.attemptId}`)
  assert.match(drill.attemptId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  assert.equal(fx.headStorages.has(drillTarget) || fx.mirrorStorages.has(drillTarget), false)
  assert.equal(drill.disposableStorageCleanedUp, true)
  assert.equal(drill.ballId, fx.ball.ballId)
  assert.equal(drill.verifiedModules, 68)
  assert.equal(drill.stateDiffChanged, 0)
  assert.equal(drill.receiptCount, 87)
  assert.equal(drill.checkpointCount, 6)
  assert.equal(drill.merkleRoot, exported.receiptsSummary.merkleRoot)
  assert.equal(drill.ownerPhase, 'BOUND')
  assert.equal(drill.ownerCredentialId, fx.credentialId)
  assert.equal(drill.ownerSignerCounter, 7)
  assert.equal(drill.compositeHead.compositeHeadHash, exported.compositeHead.compositeHeadHash)

  // Disposable drill DO storage must be completely wiped in finally (zero split-brain residue)
  assert.equal(fx.headStorages.get(drill.targetName).size(), 0)
  assert.equal(fx.mirrorStorages.get(drill.targetName).size(), 0)
  // Live node-main-v1 storage remains untouched
  assert.ok(fx.headStorages.get('node-main-v1').size() > 0)
})

test('C2: tamper, receipt prefix truncation, module corruption, D4b owner divergence, NO_NODE missing owner, and live-head target all fail closed before any write', async () => {
  const fx = await create68ModuleOrganismFixture()
  const liveHead = fx.headStorages.get('node-main-v1')
  const liveMirror = fx.mirrorStorages.get('node-main-v1')

  const validExport = await exportColdArchive({
    headStorage: liveHead,
    mirrorStorage: liveMirror,
    expectedOwnerPublicKeyHex: fx.ownerPublicKeyHex,
  })

  // 1. Live production DO name ('node-main-v1') is unconditionally refused (HTTP 403 LIVE_HEAD_REFUSED)
  await assert.rejects(
    () => runDisposableRebuildDrill({
      targetName: 'node-main-v1',
      bundle: validExport.bundle,
      targetHeadStorage: createMemoryStorage(),
      targetMirrorStorage: createMemoryStorage(),
      expectedOwnerPublicKeyHex: fx.ownerPublicKeyHex,
    }),
    err => err.code === 'LIVE_HEAD_REFUSED' && err.status === 403,
  )
  const liveDrillAttempt = await fx.worker.fetch(new Request(`${ORIGIN}/_host/archive`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'rebuild_drill', targetName: 'node-main-v1' }),
  }), fx.env)
  assert.equal(liveDrillAttempt.status, 403)
  assert.equal((await liveDrillAttempt.json()).code, 'LIVE_HEAD_REFUSED')

  // 2. 1-byte flip in receipt file fails closed with zero target storage writes
  const flippedReceiptBundle = structuredClone(validExport.bundle)
  const receiptEntry = flippedReceiptBundle.mirror.entries.find(([p]) => p === '/dsh/home/auma/seed/receipts.v3.jsonl')
  const decodedReceipts = Buffer.from(receiptEntry[1].b64, 'base64').toString('utf8')
  const corruptedReceipts = decodedReceipts.replace('"seq":2', '"seq":9')
  assert.notEqual(corruptedReceipts, decodedReceipts)
  receiptEntry[1].b64 = Buffer.from(corruptedReceipts, 'utf8').toString('base64')
  receiptEntry[1].bytes = Buffer.byteLength(corruptedReceipts)
  receiptEntry[1].sha256 = await digest(corruptedReceipts)
  // A valid outer digest ensures the receipt chain verifier sees the altered sequence.
  const { archiveId: _ignore1, ...unsignedFlipped } = flippedReceiptBundle
  flippedReceiptBundle.archiveId = await digest(`${COLD_ARCHIVE_SCHEMA}\0${canonicalJson(unsignedFlipped)}`)
  const targetH1 = createMemoryStorage()
  const targetM1 = createMemoryStorage()
  await assert.rejects(
    () => runDisposableRebuildDrill({
      targetName: 'x61-drill-tamper-01',
      bundle: flippedReceiptBundle,
      targetHeadStorage: targetH1,
      targetMirrorStorage: targetM1,
      expectedOwnerPublicKeyHex: fx.ownerPublicKeyHex,
    }),
    err => err.code === 'ARCHIVE_RECEIPT_CHAIN_INVALID',
  )
  assert.equal(targetH1.size(), 0)
  assert.equal(targetM1.size(), 0)

  // Structure only: rehash the final receipt so no later prevHash or leaf check can mask a bad sequence.
  const structureOnlyBundle = structuredClone(validExport.bundle)
  const structureEntry = structureOnlyBundle.mirror.entries.find(([p]) => p === '/dsh/home/auma/seed/receipts.v3.jsonl')
  const structureRows = Buffer.from(structureEntry[1].b64, 'base64').toString('utf8').trimEnd().split('\n').map(line => JSON.parse(line))
  const structureReceipt = structureRows.at(-1)
  structureReceipt.seq += 1
  const { leafHash: _oldLeaf, ...structurePayload } = structureReceipt
  structureReceipt.leafHash = await digest(`\0${canonicalJson(structurePayload)}`)
  const structureText = structureRows.map(row => JSON.stringify(row)).join('\n') + '\n'
  structureEntry[1].b64 = Buffer.from(structureText, 'utf8').toString('base64')
  structureEntry[1].bytes = Buffer.byteLength(structureText)
  structureEntry[1].sha256 = await digest(structureText)
  const { archiveId: _oldStructureId, ...unsignedStructure } = structureOnlyBundle
  structureOnlyBundle.archiveId = await digest(`${COLD_ARCHIVE_SCHEMA}\0${canonicalJson(unsignedStructure)}`)
  const targetStructureH = createMemoryStorage()
  const targetStructureM = createMemoryStorage()
  await assert.rejects(
    () => runDisposableRebuildDrill({
      targetName: 'x61-drill-structure-only',
      bundle: structureOnlyBundle,
      targetHeadStorage: targetStructureH,
      targetMirrorStorage: targetStructureM,
      expectedOwnerPublicKeyHex: fx.ownerPublicKeyHex,
    }),
    err => err.code === 'ARCHIVE_RECEIPT_CHAIN_INVALID',
  )
  assert.equal(targetStructureH.size(), 0)
  assert.equal(targetStructureM.size(), 0)

  // Leaf only: preserve sequence, previous hash, and claimed leaf while changing the receipt payload.
  const leafOnlyBundle = structuredClone(validExport.bundle)
  const leafEntry = leafOnlyBundle.mirror.entries.find(([p]) => p === '/dsh/home/auma/seed/receipts.v3.jsonl')
  const leafRows = Buffer.from(leafEntry[1].b64, 'base64').toString('utf8').trimEnd().split('\n').map(line => JSON.parse(line))
  leafRows.at(-1).data.message = 'Tampered receipt message'
  const leafText = leafRows.map(row => JSON.stringify(row)).join('\n') + '\n'
  leafEntry[1].b64 = Buffer.from(leafText, 'utf8').toString('base64')
  leafEntry[1].bytes = Buffer.byteLength(leafText)
  leafEntry[1].sha256 = await digest(leafText)
  const { archiveId: _oldLeafId, ...unsignedLeaf } = leafOnlyBundle
  leafOnlyBundle.archiveId = await digest(`${COLD_ARCHIVE_SCHEMA}\0${canonicalJson(unsignedLeaf)}`)
  const targetLeafH = createMemoryStorage()
  const targetLeafM = createMemoryStorage()
  await assert.rejects(
    () => runDisposableRebuildDrill({
      targetName: 'x61-drill-leaf-only',
      bundle: leafOnlyBundle,
      targetHeadStorage: targetLeafH,
      targetMirrorStorage: targetLeafM,
      expectedOwnerPublicKeyHex: fx.ownerPublicKeyHex,
    }),
    err => err.code === 'ARCHIVE_RECEIPT_CHAIN_INVALID',
  )
  assert.equal(targetLeafH.size(), 0)
  assert.equal(targetLeafM.size(), 0)

  // This valid 87-receipt archive cannot satisfy a caller requiring an 88-receipt prefix.
  await assert.rejects(
    () => verifyColdArchive(
      validExport.bundle,
      { expectedOwnerPublicKeyHex: fx.ownerPublicKeyHex, minimumReceiptCount: 88 },
    ),
    err => err.code === 'ARCHIVE_RECEIPT_PREFIX_TRUNCATED' && err.status === 409,
  )

  // 3. Missing or corrupted 1-of-68 module fails closed with zero target writes
  const missingModBundle = structuredClone(validExport.bundle)
  const firstSha = Object.keys(missingModBundle.head.codeBySha)[0]
  delete missingModBundle.head.codeBySha[firstSha]
  const reSeal = async draft => {
    const { archiveId: _old, ...unsigned } = draft
    return { archiveId: await digest(`${COLD_ARCHIVE_SCHEMA}\0${canonicalJson(unsigned)}`), ...unsigned }
  }
  const targetH2 = createMemoryStorage()
  const targetM2 = createMemoryStorage()
  await assert.rejects(
    () => runDisposableRebuildDrill({
      targetName: 'x61-drill-missing-mod',
      bundle: missingModBundle,
      targetHeadStorage: targetH2,
      targetMirrorStorage: targetM2,
      expectedOwnerPublicKeyHex: fx.ownerPublicKeyHex,
    }),
    err => err.status >= 400,
  )
  await assert.rejects(
    async () => verifyColdArchive(await reSeal(missingModBundle), { expectedOwnerPublicKeyHex: fx.ownerPublicKeyHex }),
    err => err.code === 'ARCHIVE_MODULE_MISSING',
  )
  assert.equal(targetH2.size(), 0)
  assert.equal(targetM2.size(), 0)

  // Corrupted module bytes despite matching key
  const corruptModBundle = structuredClone(validExport.bundle)
  corruptModBundle.head.codeBySha[firstSha] += '// tampered\n'
  await assert.rejects(
    async () => verifyColdArchive(await reSeal(corruptModBundle), { expectedOwnerPublicKeyHex: fx.ownerPublicKeyHex }),
    err => err.code === 'ARCHIVE_MODULE_HASH_MISMATCH',
  )

  // 4. D4b / NO_NODE terminal fail-stop: missing/unbound aumlok:v1 NEVER reconstructs an owner
  const noOwnerBundle = structuredClone(validExport.bundle)
  noOwnerBundle.head.aumlokState = null
  const targetH3 = createMemoryStorage()
  const targetM3 = createMemoryStorage()
  await assert.rejects(
    async () => runDisposableRebuildDrill({
      targetName: 'x61-drill-no-owner',
      bundle: await reSeal(noOwnerBundle),
      targetHeadStorage: targetH3,
      targetMirrorStorage: targetM3,
      expectedOwnerPublicKeyHex: fx.ownerPublicKeyHex,
    }),
    err => err.code === 'OWNER_RECORD_MISSING' && err.status === 409,
  )
  assert.equal(targetH3.size(), 0)
  assert.equal(targetM3.size(), 0)

  // 5. D4b silent owner-authority divergence: wrong ownerPublicKeyHex or counter mismatch fails closed (409)
  await assert.rejects(
    () => verifyColdArchive(validExport.bundle, { expectedOwnerPublicKeyHex: '99'.repeat(32) }),
    err => err.code === 'ARCHIVE_OWNER_AUTHORITY_DIVERGENCE' && err.status === 409,
  )
  const counterTamperBundle = structuredClone(validExport.bundle)
  counterTamperBundle.head.aumlokState.binding.credential.counter = 6
  await assert.rejects(
    async () => verifyColdArchive(await reSeal(counterTamperBundle), { expectedOwnerPublicKeyHex: fx.ownerPublicKeyHex }),
    err => err.code === 'ARCHIVE_OWNER_AUTHORITY_DIVERGENCE' && err.status === 409,
  )
})

test('a stored secret-shaped row is skipped, never archived and never refused; the archive of the rest is byte-identical', async () => {
  const fx = await create68ModuleOrganismFixture()
  const headStorage = fx.headStorages.get('node-main-v1'), mirrorStorage = fx.mirrorStorages.get('node-main-v1')
  const exportNow = () => exportColdArchive({ headStorage, mirrorStorage, expectedOwnerPublicKeyHex: fx.ownerPublicKeyHex, now: () => 1794350000000 })
  const before = await exportNow()
  assert.equal(before.ok, true)
  const rowKey = async p => (await import('node:crypto')).createHash('sha256').update(JSON.stringify(p)).digest('hex')
  const SECRET = Buffer.from('records:\n  client-connection/browser-session: SYNTHETIC-SIGNING-VALUE\n').toString('base64')
  // Rows admitted under the older exact-name rule, written straight into storage as the live mirror may hold them.
  for (const p of ['/dsh/home/.credentials.yaml.3fa9c1d2e4b5.tmp', '/dsh/home/auma/session.cap.3fa9c1.tmp', '/dsh/home/auma/pepper.v1']) {
    const id = await rowKey(p)
    await mirrorStorage.put(`mirror:v2:entry:${id}`, { path: p, kind: 'file', mode: 0o600, mtimeMs: 1, chunks: 1, bytes: Buffer.from(SECRET, 'base64').length })
    await mirrorStorage.put(`mirror:v2:chunk:${id}:0`, SECRET)
  }
  for (const p of ['/dsh/home/.credentials.yaml.lock', '/dsh/home/.credentials.yaml.77aa00.tmp']) await mirrorStorage.put(`mirror:v2:reset:${await rowKey(p)}`, p)
  const after = await exportNow()
  assert.equal(after.ok, true)
  assert.equal(JSON.stringify(after.bundle), JSON.stringify(before.bundle))
  assert.equal(after.archiveId, before.archiveId)
  assert.equal(after.mirrorEntryCount, before.mirrorEntryCount)
  // The fixture's owner row (head.aumlokState) legitimately carries the legacy FIELD named pepper.v1; what must never appear is a
  // mirror PATH ending in that name, so the needle is the path part (a JSON key is preceded by a quote, never by a slash).
  for (const needle of [SECRET, 'credentials.yaml', 'session.cap', '/pepper.v1']) assert.equal(JSON.stringify(after).includes(needle), false, needle)
  // A row the archive's own rule refused before is still refused, never skipped.
  const exact = '/dsh/home/auma/.ssh'
  await mirrorStorage.put(`mirror:v2:entry:${await rowKey(exact)}`, { path: exact, kind: 'dir', mode: 0o700 })
  await assert.rejects(exportNow(), { code: 'INVALID_MIRROR_PATH' })
})

test('the LIVE archive route (executeEdgeArchiveOperation over /_mirror/archive-state) never bundles or writes to R2 a row matching the secret-path rule', async () => {
  const fx = await create68ModuleOrganismFixture()
  const mirrorStorage = fx.mirrorStorages.get('node-main-v1')
  const run = async () => {
    const r2 = createMemoryR2Bucket()
    const result = await executeEdgeArchiveOperation({ env: { ...fx.env, ARCHIVE_BUCKET: r2 }, seedId: fx.seedId, input: { action: 'export', includeBundle: true }, now: () => 1794350000000 })
    return { result, r2 }
  }
  const before = await run()
  assert.equal(before.result.ok, true)
  const rowKey = async p => (await import('node:crypto')).createHash('sha256').update(JSON.stringify(p)).digest('hex')
  const SECRET = Buffer.from('records:\n  client-connection/browser-session: SYNTHETIC-SIGNING-VALUE-JOB4\n').toString('base64')
  // Rows admitted under the older exact-name rule, written straight into the live mirror's storage.
  for (const p of ['/dsh/home/.credentials.yaml.3fa9c1d2e4b5.tmp', '/dsh/home/auma/session.cap.3fa9c1.tmp', '/dsh/home/auma/pepper.v1']) {
    const id = await rowKey(p)
    await mirrorStorage.put(`mirror:v2:entry:${id}`, { path: p, kind: 'file', mode: 0o600, mtimeMs: 1, chunks: 1, bytes: Buffer.from(SECRET, 'base64').length })
    await mirrorStorage.put(`mirror:v2:chunk:${id}:0`, SECRET)
  }
  for (const p of ['/dsh/home/.credentials.yaml.lock', '/dsh/home/.credentials.yaml.77aa00.tmp']) await mirrorStorage.put(`mirror:v2:reset:${await rowKey(p)}`, p)
  const after = await run()
  assert.equal(after.result.ok, true)
  // The bundle, its id and every R2 object are exactly what they were without those rows.
  assert.equal(after.result.archiveId, before.result.archiveId)
  assert.equal(after.result.mirrorEntryCount, before.result.mirrorEntryCount)
  assert.deepEqual([...after.r2.objects.keys()].sort(), [...before.r2.objects.keys()].sort())
  for (const [key, value] of after.r2.objects) assert.equal(value.text, before.r2.objects.get(key).text, key)
  const written = JSON.stringify([...after.r2.objects.values()].map(value => value.text)) + JSON.stringify(after.result)
  for (const needle of [SECRET, 'credentials.yaml', 'session.cap', '/pepper.v1']) assert.equal(written.includes(needle), false, needle)
  // An ordinary name the rule no longer matches is archived like any other file.
  const notes = '/dsh/home/auma/credentials.yaml-notes.md'
  const notesId = await rowKey(notes)
  const notesB64 = Buffer.from('where the credentials file lives\n').toString('base64')
  await mirrorStorage.put(`mirror:v2:entry:${notesId}`, { path: notes, kind: 'file', mode: 0o644, mtimeMs: 1, chunks: 1, bytes: Buffer.from(notesB64, 'base64').length })
  await mirrorStorage.put(`mirror:v2:chunk:${notesId}:0`, notesB64)
  const withNotes = await run()
  assert.equal(withNotes.result.mirrorEntryCount, before.result.mirrorEntryCount + 1)
  assert.ok([...withNotes.r2.objects.values()].some(value => value.text === notesB64))
  // A row this archive's own rule refuses outright is refused, never exported.
  const exact = '/dsh/home/auma/.ssh'
  await mirrorStorage.put(`mirror:v2:entry:${await rowKey(exact)}`, { path: exact, kind: 'dir', mode: 0o700 })
  const r2 = createMemoryR2Bucket()
  await assert.rejects(executeEdgeArchiveOperation({ env: { ...fx.env, ARCHIVE_BUCKET: r2 }, seedId: fx.seedId, input: { action: 'export' }, now: () => 1794350000000 }), { code: 'INVALID_MIRROR_PATH' })
  assert.equal(r2.objects.size, 0)
})
