/** Offline integration: synthetic identities, in-memory DOs and owned temporary files only. */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { Readable } from 'node:stream'
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { isoCBOR } from '@simplewebauthn/server/helpers'
import { runInNewContext } from 'node:vm'
import { JSDOM } from 'jsdom'
import { computeAura, validateAuraVector } from '../../../../server/aura-rules.mjs'
import { createAccessVerifier, ownerAccessConfigured } from '../access.mjs'
import { createWorker } from '../worker.mjs'
import { aumlokClass3Binding, AUMLOK_STORAGE_KEY, createAumlokStore } from '../aumlok.mjs'
import { canonicalJson, classifyHeadTransition, headPromotionBinding, requireOwnerNodeKeySeparation } from '../owner-grant-policy.mjs'
import { providerBudgetLimits, providerRequestReservation, providerBudgetRecordStorage, reserveProviderBudget } from '../provider-budget.mjs'
import { CLOUD_BROKER_LIMITS, cloudRepoMirrorPathAllowed } from '../cloud-brokers.mjs'
import { X61HeadDurableObject, createDurableHeadStore, createDurableWakeStore, bootstrapPackage, canonicalBootstrap, digest, manifestId, validateManifest, checkpointPolicyView } from '../head-do.mjs'
import { MirrorDO, MIRROR_LIMITS, mirrorDigest } from '../mirror-do.mjs'
import { handleMessagesRequest, projectPredictionReceipts } from '../messages-store.mjs'
import { createLocalMessagesStorage, createLocalMessagesRequestHandler, readLocalPredictionStatus } from '../../../../server/messages-store.mjs'
import { PIECE as VAULT_PIECE } from '../vault.mjs' // ANYBROWSER hook
import { RESCUE_PAGE } from '../rescue-page.mjs' // ANYBROWSER hook
import { createVaultBucket } from './vault-fakes.mjs' // ANYBROWSER hook

const ORIGIN = 'https://messages-fixture.example.invalid'
const CONTACTS = '/aukora-messages/contacts.json'
const SEND = '/aukora-messages/send'
const THREAD = '/aukora-messages/thread'
const ADD = '/aukora-messages/add-contact'
const clone = value => structuredClone(value)

test('governance capability requires both trusted qualification and atomic approval consumers', async t => {
  const cloud = await fixture(t); await cloud.bootstrap()
  const production = await body(await cloud.request('/_head/lease'))
  assert.equal(production.governancePromotion, false)
  assert.equal(production.governancePromotionBlocker, 'PEARL_QUALIFICATION_UNVERIFIABLE')
  const verifier = async () => { throw new Error('Capability inspection must never execute qualification') }
  const noCustody = new X61HeadDurableObject({ storage: cloud.headStorage, getWebSockets: () => [] }, {}, { verifyTransitionQualification: verifier })
  assert.equal((await noCustody.store.inspectLease()).governancePromotion, false)
  assert.equal((await noCustody.store.inspectLease()).governancePromotionBlocker, 'CLASS3_WEBAUTHN_REQUIRED')
  const noOwnerKey = new X61HeadDurableObject({ storage: cloud.headStorage, getWebSockets: () => [] }, cloud.env, { verifyTransitionQualification: verifier })
  assert.equal((await noOwnerKey.store.inspectLease()).governancePromotion, false)
  for (const [options, ready, blocker] of [
    [{}, false, 'PEARL_QUALIFICATION_UNVERIFIABLE'],
    [{ verifyTransitionQualification: verifier }, false, 'CLASS3_WEBAUTHN_REQUIRED'],
    [{ consumeGovernanceApproval: verifier }, false, 'PEARL_QUALIFICATION_UNVERIFIABLE'],
    [{ verifyTransitionQualification: verifier, consumeGovernanceApproval: verifier }, true, undefined],
  ]) {
    const result = await createDurableHeadStore(cloud.headStorage, options).inspectLease()
    assert.equal(result.governancePromotion, ready)
    assert.equal(result.governancePromotionBlocker, blocker)
  }
})

test('valid hashes and caller qualification claims cannot replace the independent verifier', async t => {
  const cloud = await fixture(t); await cloud.bootstrap()
  let consumed = 0
  const store = createDurableHeadStore(cloud.headStorage, { consumeGovernanceApproval: async () => { consumed++; return { ok: true, expiresAt: Date.now() + 10000 } } })
  const lease = await store.lease({ action: 'acquire', ownerPeerId: 'fixture-writer' })
  const ball = { ...clone(cloud.ball), parentBallId: cloud.ball.ballId, epoch: cloud.ball.epoch + 1, authorPeerId: 'fixture-writer' }
  ball.entries['seed-pearl'] = { ...Object.values(ball.entries)[0], id: 'seed-pearl' }
  ball.ballId = await manifestId(ball)
  const input = { ball, codeBySha: {}, expectedParentBallId: cloud.ball.ballId, expectedEpoch: cloud.ball.epoch, writerLease: lease.lease,
    qualified: true, qualificationId: ball.ballId, qualification: { transitionSha256: await digest(canonicalBootstrap({ parentBallId: cloud.ball.ballId, parentEpoch: cloud.ball.epoch, candidate: ball })), expiresAt: Date.now() + 10000 } }
  const before = cloud.headStorage.snapshot()
  assert.equal((await store.publish(input, { approvalToken: 'synthetic-token', audience: ORIGIN })).code, 'PEARL_QUALIFICATION_UNVERIFIABLE')
  assert.deepEqual(cloud.headStorage.snapshot(), before)
  assert.equal(consumed, 0)
})

test('fresh lease replaces only the envelope without changing qualification or passkey terms', async t => {
  const cloud = await fixture(t); await cloud.bootstrap()
  let at = 1000, expectedTransition, expectedBinding, consumed = 0
  const store = createDurableHeadStore(cloud.headStorage, { now: () => at,
    verifyTransitionQualification: async terms => {
      assert.equal(terms.transitionSha256, expectedTransition)
      return { transitionSha256: terms.transitionSha256, qualificationId: terms.candidateBallId, expiresAt: at + 10000 }
    },
    consumeGovernanceApproval: async (_tx, token, binding, audience) => {
      assert.equal(token, 'synthetic-private-approval'); assert.equal(audience, ORIGIN); assert.deepEqual(binding, expectedBinding)
      consumed++; return { ok: true, expiresAt: at + 10000 }
    },
  })
  const expired = await store.lease({ action: 'acquire', ownerPeerId: 'original-author' })
  const ball = { ...clone(cloud.ball), parentBallId: cloud.ball.ballId, epoch: cloud.ball.epoch + 1, authorPeerId: 'original-author' }
  ball.entries['seed-pearl'] = { ...Object.values(ball.entries)[0], id: 'seed-pearl' }
  ball.ballId = await manifestId(ball)
  const originalBall = clone(ball)
  expectedBinding = await headPromotionBinding({ audience: ORIGIN, ball, entryId: 'seed-pearl', previous: cloud.ball })
  expectedTransition = await digest(canonicalBootstrap({ parentBallId: cloud.ball.ballId, parentEpoch: cloud.ball.epoch, candidate: ball }))
  at += 31000
  const fresh = await store.lease({ action: 'acquire', ownerPeerId: ball.authorPeerId })
  const input = { ball, codeBySha: {}, expectedParentBallId: cloud.ball.ballId, expectedEpoch: cloud.ball.epoch, writerLease: expired.lease }
  assert.equal((await store.publish(input, { approvalToken: 'synthetic-private-approval', audience: ORIGIN })).code, 'WRITER_LEASE_REQUIRED')
  assert.equal(consumed, 0)
  const wrongAuthor = { ...input, ball: { ...ball, authorPeerId: 'replacement-author' }, writerLease: fresh.lease }
  assert.equal(await manifestId(wrongAuthor.ball), ball.ballId)
  assert.equal((await store.publish(wrongAuthor, { approvalToken: 'synthetic-private-approval', audience: ORIGIN })).code, 'WRITER_LEASE_REQUIRED')
  assert.equal(consumed, 0)
  assert.equal((await store.publish({ ...input, writerLease: fresh.lease }, { approvalToken: 'synthetic-private-approval', audience: ORIGIN })).ok, true)
  assert.deepEqual(ball, originalBall)
  assert.equal(consumed, 1)
})

test('qualification cannot mutate captured author, manifest or module bytes across an await', async t => {
  const cloud = await fixture(t); await cloud.bootstrap()
  const entered = Promise.withResolvers(), release = Promise.withResolvers()
  const source = 'export default { captured: true }', sha = await digest(source)
  const ball = { ...clone(cloud.ball), parentBallId: cloud.ball.ballId, epoch: 2, authorPeerId: 'captured-author' }
  ball.modules[sha] = { sha256: sha, specifier: `ball:${sha}` }
  ball.entries['seed-pearl'] = { ...Object.values(ball.entries)[0], id: 'seed-pearl', specifier: `ball:${sha}` }
  ball.ballId = await manifestId(ball)
  const expected = clone(ball), expectedBinding = await headPromotionBinding({ audience: ORIGIN, ball, entryId: 'seed-pearl' })
  let qualification, consumed = 0
  const store = createDurableHeadStore(cloud.headStorage, { now: () => 1000,
    verifyTransitionQualification: async terms => {
      assert.equal(terms.transitionSha256, await digest(canonicalBootstrap({ parentBallId: cloud.ball.ballId, parentEpoch: 1, candidate: expected })))
      entered.resolve(); await release.promise
      qualification = { transitionSha256: terms.transitionSha256, qualificationId: terms.candidateBallId, expiresAt: 10000 }
      return qualification
    },
    consumeGovernanceApproval: async (tx, _token, binding) => {
      assert.deepEqual(binding, expectedBinding)
      qualification.expiresAt = 0
      consumed++; await tx.put('test:round25:spent', true)
      return { ok: true, expiresAt: 10000 }
    },
  })
  const lease = await store.lease({ action: 'acquire', ownerPeerId: ball.authorPeerId })
  const input = { ball, codeBySha: { [sha]: source }, expectedParentBallId: cloud.ball.ballId, expectedEpoch: 1, writerLease: lease.lease }
  const pending = store.publish(input, { approvalToken: 'fixture-private-token', audience: ORIGIN })
  try {
    await Promise.race([entered.promise, pending.then(() => { throw new Error('Publication settled before qualification') })])
    ball.authorPeerId = 'injected-author'
    ball.epoch = 99
    ball.entries['seed-pearl'].config.injected = true
    input.codeBySha[sha] = 'export default { injected: true }'
    input.writerLease.ownerPeerId = 'injected-author'
  } finally { release.resolve() }
  const result = await pending
  assert.equal(result.ok, true)
  const selected = await store.read()
  assert.deepEqual(selected.ball, expected)
  assert.equal(selected.modules[sha], source)
  assert.equal(await cloud.headStorage.get(`head:qualification:${expected.ballId}`), 10000)
  assert.equal(await cloud.headStorage.get('test:round25:spent'), true)
  assert.equal(consumed, 1)
})

test('a previously staged v1 manifest cannot substitute another author on fresh-lease retry', async t => {
  const cloud = await fixture(t); await cloud.bootstrap()
  let at = 1000, expireAfterStaging = true, consumed = 0
  const ball = { ...clone(cloud.ball), parentBallId: cloud.ball.ballId, epoch: 2, authorPeerId: 'original-author' }
  ball.entries['seed-pearl'] = { ...Object.values(ball.entries)[0], id: 'seed-pearl' }
  ball.ballId = await manifestId(ball)
  const storage = { transaction: operation => cloud.headStorage.transaction(tx => operation({ ...tx, put: async (key, value) => {
    await tx.put(key, value)
    if (expireAfterStaging && key === `manifest:${ball.ballId}:count`) { at = 31001; expireAfterStaging = false }
  } })) }
  const store = createDurableHeadStore(storage, { now: () => at,
    verifyTransitionQualification: async terms => ({ transitionSha256: terms.transitionSha256, qualificationId: terms.candidateBallId, expiresAt: at + 10000 }),
    consumeGovernanceApproval: async () => { consumed++; return { ok: true, expiresAt: at + 10000 } },
  })
  const originalLease = await store.lease({ action: 'acquire', ownerPeerId: ball.authorPeerId })
  const input = { ball, expectedParentBallId: cloud.ball.ballId, expectedEpoch: 1, writerLease: originalLease.lease }
  const approval = { approvalToken: 'fixture-private-token', audience: ORIGIN }
  assert.equal((await store.publish(input, approval)).code, 'WRITER_LEASE_EXPIRED')
  assert.equal(consumed, 0)
  const replacementLease = await store.lease({ action: 'acquire', ownerPeerId: 'replacement-author' })
  const replacement = { ...ball, authorPeerId: 'replacement-author' }
  assert.equal(await manifestId(replacement), ball.ballId)
  assert.equal((await store.publish({ ...input, ball: replacement, writerLease: replacementLease.lease }, approval)).code, 'MANIFEST_CONTENT_CONFLICT')
  assert.equal(consumed, 0)
  assert.equal(await cloud.headStorage.get('head'), cloud.ball.ballId)
  await store.lease({ action: 'release', ...replacementLease.lease })
  const fresh = await store.lease({ action: 'acquire', ownerPeerId: ball.authorPeerId })
  assert.equal((await store.publish({ ...input, writerLease: fresh.lease }, approval)).ok, true)
  assert.equal((await store.read()).ball.authorPeerId, ball.authorPeerId)
  assert.equal(consumed, 1)
})

test('protected executable changes are classified independently from caller labels', async () => {
  for (const organ of ['seed-receipts', 'seed-superagent', 'seed-pearl', 'seed-aura']) {
    for (const id of [organ, organ + ':' + 'a'.repeat(64)]) {
      const previous = { entries: { [id]: { id, specifier: 'ball:' + 'a'.repeat(64), config: { enabled: true }, disabled: false } } }
      for (const change of [{ specifier: 'ball:' + 'b'.repeat(64) }, { config: { enabled: false } }, { disabled: true }, null]) {
        const candidate = { ballId: 'c'.repeat(64), epoch: 163, entries: change === null ? {} : { [id]: { ...previous.entries[id], ...change } }, class: 0, approved: true }
        assert.deepEqual(classifyHeadTransition(previous, candidate), { class: 3, entryIds: [id] })
        const binding = await headPromotionBinding({ audience: ORIGIN, ball: candidate, entryId: id })
        assert.equal(binding.organId, organ)
        assert.equal(binding.ballId, candidate.ballId)
        assert.equal(binding.epoch, candidate.epoch)
        assert.match(binding.candidateSha256, /^[a-f0-9]{64}$/)
      }
      assert.equal(classifyHeadTransition(previous, { entries: { [id]: { ...previous.entries[id], updatedAt: 2, previousSpecifiers: [] } } }).class, 1)
    }
  }
  assert.throws(() => requireOwnerNodeKeySeparation('a'.repeat(64), 'a'.repeat(64)), { code: 'NODE_KEY_IS_NOT_OWNER_KEY' })
  requireOwnerNodeKeySeparation('a'.repeat(64), 'b'.repeat(64))
})

test('head commits spend one exact approval atomically and replay only reads the selected head', async t => {
  const cloud = await fixture(t); await cloud.bootstrap()
  let at = 1000, consumed = 0
  const approvals = new Map()
  const options = { now: () => at,
    verifyTransitionQualification: async terms => ({ transitionSha256: terms.transitionSha256, qualificationId: terms.candidateBallId, expiresAt: at + 10000 }),
    consumeGovernanceApproval: async (tx, token, binding, origin) => {
      if (origin !== ORIGIN || approvals.get(token) !== canonicalJson(binding) || await tx.get('test:spent:' + token)) throw Object.assign(new Error('CLASS3_WEBAUTHN_REQUIRED'), { code: 'CLASS3_WEBAUTHN_REQUIRED', status: 403 })
      await tx.put('test:spent:' + token, true); consumed++
      return { ok: true, binding, expiresAt: 5000 }
    },
  }
  const store = createDurableHeadStore(cloud.headStorage, options)
  const lease = await store.lease({ action: 'acquire', ownerPeerId: 'fixture-writer' })
  const ball = { ...clone(cloud.ball), parentBallId: cloud.ball.ballId, epoch: cloud.ball.epoch + 1, authorPeerId: 'fixture-writer' }
  ball.entries['seed-pearl'] = { ...Object.values(ball.entries)[0], id: 'seed-pearl' }
  ball.ballId = await manifestId(ball)
  const input = { ball, codeBySha: {}, expectedParentBallId: cloud.ball.ballId, expectedEpoch: cloud.ball.epoch, writerLease: lease.lease }
  const binding = await headPromotionBinding({ audience: ORIGIN, ball, entryId: 'seed-pearl' })
  approvals.set('private-test-token', canonicalJson(binding))
  assert.equal((await store.publish(input, { class3Approved: true })).code, 'CLASS3_WEBAUTHN_REQUIRED')
  assert.equal((await store.publish({ ...input, codeBySha: { [Object.keys(ball.modules)[0]]: 'wrong source' } }, { audience: ORIGIN, approvalToken: 'private-test-token' })).code, 'MODULE_HASH_MISMATCH')
  assert.equal(consumed, 0)
  const before = cloud.headStorage.snapshot()
  await assert.rejects(store.publish(input, { audience: ORIGIN, approvalToken: 'forged-token' }), { code: 'CLASS3_WEBAUTHN_REQUIRED' })
  assert.deepEqual(cloud.headStorage.snapshot(), before)
  const result = await store.publish(input, { audience: ORIGIN, approvalToken: 'private-test-token' })
  assert.equal(result.ok, true)
  assert.equal(consumed, 1)
  assert.equal(await cloud.headStorage.get('head'), ball.ballId)
  assert.equal(await cloud.headStorage.get('test:spent:private-test-token'), true)
  assert.equal((await store.publish(input)).idempotent, true)
  assert.equal(consumed, 1)
  const changed = { ...clone(ball), epoch: ball.epoch + 1, parentBallId: ball.ballId }
  changed.entries['seed-pearl'].config = { changed: true }
  changed.ballId = await manifestId(changed)
  await assert.rejects(store.publish({ ...input, ball: changed, expectedParentBallId: ball.ballId, expectedEpoch: ball.epoch }, { audience: ORIGIN, approvalToken: 'private-test-token' }), { code: 'CLASS3_WEBAUTHN_REQUIRED' })
  assert.equal(await cloud.headStorage.get('head'), ball.ballId)
})

test('an approval expiring during the final head write rolls back approval and selection', async t => {
  const cloud = await fixture(t); await cloud.bootstrap()
  let at = 1000
  const storage = { transaction: operation => cloud.headStorage.transaction(tx => operation({ ...tx, put: async (key, value) => {
    await tx.put(key, value)
    if (key === 'head') at = 1500
  } })) }
  const store = createDurableHeadStore(storage, { now: () => at,
    verifyTransitionQualification: async terms => ({ transitionSha256: terms.transitionSha256, qualificationId: terms.candidateBallId, expiresAt: 10000 }),
    consumeGovernanceApproval: async tx => { await tx.put('test:approval-spent', true); return { ok: true, expiresAt: 1500 } },
  })
  const lease = await store.lease({ action: 'acquire', ownerPeerId: 'fixture-writer' })
  const ball = { ...clone(cloud.ball), parentBallId: cloud.ball.ballId, epoch: 2, authorPeerId: 'fixture-writer' }
  ball.entries['seed-pearl'] = { ...Object.values(ball.entries)[0], id: 'seed-pearl' }
  ball.ballId = await manifestId(ball)
  const before = cloud.headStorage.snapshot()
  await assert.rejects(store.publish({ ball, expectedParentBallId: cloud.ball.ballId, expectedEpoch: 1, writerLease: lease.lease }, { audience: ORIGIN, approvalToken: 'private-token' }), { code: 'CLASS3_TRANSITION_EXPIRED' })
  assert.deepEqual(cloud.headStorage.snapshot(), before)
})

test('checkpoint producer policy uses finite independent configuration and refuses conflicting sources', async t => {
  const pin = { schema: 'aukora.checkpoint-signer.v1', domain: 'aukora.x5.edge-head.v1', publicKeyHex: 'a'.repeat(64), validToCheckpoint: 23 }
  assert.equal(await checkpointPolicyView({}), null)
  assert.equal(await checkpointPolicyView({ CHECKPOINT_SIGNER_PIN: JSON.stringify(pin), CHECKPOINT_SIGNER_POLICY: '{}' }), null)
  assert.deepEqual(await checkpointPolicyView({ CHECKPOINT_SIGNER_PIN: JSON.stringify(pin) }), { ok: true, schema: 'aukora.checkpoint-policy.v1', ranges: [{ firstSeq: 1, lastSeq: 23, publicKeyHex: pin.publicKeyHex, envelope: 'v1' }] })
  const cloud = await fixture(t); await cloud.bootstrap()
  assert.equal((await cloud.request('/_host/checkpoint-policy')).status, 503)
  cloud.env.CHECKPOINT_SIGNER_PIN = JSON.stringify(pin)
  assert.equal((await body(await cloud.request('/_host/checkpoint-policy'))).ranges[0].lastSeq, 23)
})

test('mandate scope retains the organ and candidate and confirmation does not mint an owner grant', async () => {
  const files = new Map([['/dsh/home/balls/HEAD.json', JSON.stringify({ ballId: 'a'.repeat(64), epoch: 162 })]])
  const syntheticFs = {
    existsSync: key => files.has(key), readFileSync: key => { if (!files.has(key)) throw new Error('ENOENT'); return files.get(key) },
    mkdirSync() {}, writeFileSync: (key, value) => { files.set(key, value) },
    renameSync: (from, to) => { files.set(to, files.get(from)); files.delete(from) },
  }
  let execute, verifications = 0
  const ctx = { provide() {}, set() {}, tools: { register: (_name, value) => { execute = value.execute } },
    get: name => name === 'governance' ? { verifyApproval: async binding => { verifications++; return { ok: true, binding, approvalId: 'synthetic-public-approval-id', expiresAt: 5000 } } } : null,
  }
  const source = await fs.readFile(new URL('../../../../mirror/home/auma/seed/organs/seed-superagent.js', import.meta.url), 'utf8')
  runInNewContext(source.replace(/^export /gm, '') + '\napply(ctx)', { ctx, Buffer, Date: class extends Date { static now() { return 1000 } },
    process: { getBuiltinModule: name => name === 'node:fs' ? syntheticFs : name === 'node:crypto' ? { createHash } : null } })
  const invoke = async input => JSON.parse((await execute(input)).output)
  const created = await invoke({ action: 'eval_accept', title: 'Exact governance candidate', scope: { organ: 'seed-pearl', candidateSha256: 'c'.repeat(64), tools: ['tree_patch'], expiresAt: 10000 } })
  assert.equal(created.ok, true)
  let state = JSON.parse(files.get('/dsh/home/auma/superagent/state.json'))
  assert.equal(state.mandates[0].scope.organ, 'seed-pearl')
  assert.equal(state.mandates[0].scope.candidateSha256, 'c'.repeat(64))
  const promotionBinding = { schema: 'aukora.class3.head-promotion.v1', audience: ORIGIN, action: 'head.promote', ballId: 'b'.repeat(64), epoch: 163, organId: 'seed-pearl', candidateSha256: 'c'.repeat(64) }
  assert.equal((await invoke({ action: 'confirm', mandateId: created.mandateId, promotionBinding: { ...promotionBinding, candidateSha256: 'd'.repeat(64) } })).error, 'CLASS3_GOVERNANCE_BINDING_REQUIRED')
  assert.equal(verifications, 0)
  const result = await invoke({ action: 'confirm', mandateId: created.mandateId, promotionBinding })
  assert.equal(result.ok, true)
  assert.equal(result.grant, null)
  assert.equal(result.receiptHash, null)
  assert.equal(verifications, 1)
  state = JSON.parse(files.get('/dsh/home/auma/superagent/state.json'))
  assert.equal(state.mandates[0].confirmedBy, 'host-passkey-approval')
  assert.equal(state.mandates[0].scope.candidateSha256, 'c'.repeat(64))
  assert.equal(files.has('/dsh/home/auma/seed/receipts.v3.jsonl'), false)
  assert.equal(JSON.stringify(state).includes('approvalToken'), false)
})

test('local protected selection remains unavailable without an atomic effect store', async t => {
  const cloud = await fixture(t); await cloud.bootstrap()
  const source = await fs.readFile(new URL('../../../../server/local-host.mjs', import.meta.url), 'utf8')
  const executor = /async function publishQualifiedLocalHead\(input\) \{[\s\S]*?\n\}/.exec(source)?.[0]
  assert.ok(executor, 'The local admission owner must remain explicitly reviewable')
  // Evaluate only the admission function, never start the host, read its vault, or invoke an app effect.
  let consumed = 0
  const publish = runInNewContext(executor + '\npublishQualifiedLocalHead', {
    validateManifest, classifyHeadTransition, ballHeadStore: { read: async () => clone(cloud.ball) },
    localAumlok: { consumeApproval: async () => { consumed++; throw new Error('Local approval must remain unspent') } },
  })
  assert.equal((await publish({ ball: cloud.ball })).idempotent, true)
  const candidate = { ...clone(cloud.ball), parentBallId: cloud.ball.ballId, epoch: 2 }
  candidate.entries['seed-pearl'] = { ...Object.values(candidate.entries)[0], id: 'seed-pearl' }
  candidate.ballId = await manifestId(candidate)
  assert.equal((await publish({ ball: candidate, class3Approved: true, approvalToken: 'not-authority' })).code, 'CLASS3_WEBAUTHN_REQUIRED')
  delete candidate.entries['seed-pearl']
  candidate.ballId = await manifestId(candidate)
  assert.equal((await publish({ ball: candidate })).code, 'PEARL_QUALIFICATION_UNVERIFIABLE')
  assert.equal(consumed, 0)
})

function memoryStorage(initial = []) {
  let rows = new Map(clone(initial)), queue = Promise.resolve(), alarmAt = null
  const adapter = (map, alarm = { value: alarmAt }) => ({
    get: async key => clone(map.get(key)),
    getAlarm: async () => alarm.value,
    setAlarm: async value => { alarm.value = Number(value) },
    deleteAlarm: async () => { alarm.value = null },
    put: async (key, value) => {
      assert.ok(Buffer.byteLength(JSON.stringify(value)) <= 128 * 1024, 'DO value exceeds its platform limit')
      map.set(key, clone(value))
    },
    delete: async key => map.delete(key),
    list: async ({ prefix = '', limit = Infinity } = {}) => new Map([...map].filter(([key]) => key.startsWith(prefix)).sort(([a], [b]) => a.localeCompare(b)).slice(0, limit).map(([key, value]) => [key, clone(value)])),
  })
  return {
    get: key => adapter(rows).get(key), list: options => adapter(rows).list(options),
    getAlarm: async () => alarmAt, setAlarm: async value => { alarmAt = value }, deleteAlarm: async () => { alarmAt = null },
    transaction(operation) {
      const pending = queue.then(async () => {
        const staged = clone(rows), alarm = { value: alarmAt }
        const result = await operation(adapter(staged, alarm))
        rows = staged; alarmAt = alarm.value
        return result
      })
      queue = pending.catch(() => {})
      return pending
    },
    snapshot: () => clone(rows), idle: () => queue,
  }
}

async function body(response) {
  const text = await response.text()
  assert.ok(text.length < 256 * 1024)
  return JSON.parse(text)
}

async function fixture(t, { receipts, authorize = true } = {}) {
  const headStorage = memoryStorage(), mirrorStorage = memoryStorage()
  const env = { PUBLIC_HOST: new URL(ORIGIN).host, ACCESS_TEAM: 'fixture.cloudflareaccess.com', ACCESS_AUD: 'fixture-audience', OWNER_EMAIL: 'fixture@example.invalid' }
  let providerFetch = () => { throw new Error('External provider network is forbidden in fixture') }
  const headOptions = { networkFetch: (...args) => providerFetch(...args) }
  let head = new X61HeadDurableObject({ storage: headStorage, getWebSockets: () => [] }, env, headOptions)
  const approvals = new Map()
  let messagePasskey = null, messageCredentialId, messageApprovalSequence = 0
  const issueMessageApproval = async (value, method) => {
    if (messagePasskey === null) {
      // Only pre-existing enrollment is seeded. Every send approval uses a real UV signature,
      // durable MAC-protected approval record, and the production transactional consumer.
      const owner = generateKeyPairSync('ed25519'), node = generateKeyPairSync('ed25519')
      messagePasskey = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
      const jwk = messagePasskey.publicKey.export({ format: 'jwk' }), at = Date.now()
      messageCredentialId = randomBytes(32).toString('base64url')
      env.OWNER_PUBLIC_KEY_HEX = owner.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex')
      await headStorage.transaction(tx => tx.put(AUMLOK_STORAGE_KEY, {
        schema: 'aukora.aumlok.state.v2', generation: 1,
        binding: { aumlokId: 'a'.repeat(64), recoveryCommitment: 'b'.repeat(64),
          rootEscrow: { schema: 'aukora.aumlok.escrow.v2', ivB64: randomBytes(12).toString('base64url'), ciphertextB64: randomBytes(48).toString('base64url') },
          nodePubkeyHex: node.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'),
          credential: { id: messageCredentialId, counter: 0, publicKeyB64: Buffer.from(isoCBOR.encode(new Map([
            [1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')],
          ]))).toString('base64url') }, boundAt: at, lastVerifiedAt: at, generation: 1 },
        'pepper.v1': randomBytes(32).toString('base64url'), challenges: [], invites: [], revocations: [],
        failures: 0, failedAt: [], nextAllowedAt: 0, attempts: [], approvals: [],
      }))
      head.aumlokStore = createAumlokStore(headStorage, { origins: [ORIGIN], ownerPublicKeyHex: env.OWNER_PUBLIC_KEY_HEX })
    }
    const binding = await aumlokClass3Binding({ audience: ORIGIN, method, pathname: SEND, body: value })
    const challenge = await head.aumlokStore.challenge({ purpose: 'approve', requestId: `message-approval-${++messageApprovalSequence}`, binding }, ORIGIN)
    const hash = value => createHash('sha256').update(value).digest()
    const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: challenge.publicKey.challenge,
      origin: ORIGIN, crossOrigin: false })).toString('base64url')
    const auth = Buffer.alloc(37)
    hash(new URL(ORIGIN).hostname).copy(auth)
    auth[32] = 5; auth.writeUInt32BE(messageApprovalSequence, 33)
    const signature = sign('sha256', Buffer.concat([auth, hash(Buffer.from(clientDataJSON, 'base64url'))]), messagePasskey.privateKey)
    const result = await head.aumlokStore.complete('approve', { challengeId: challenge.challengeId,
      credential: { id: messageCredentialId, rawId: messageCredentialId, type: 'public-key', clientExtensionResults: {},
        response: { clientDataJSON, authenticatorData: auth.toString('base64url'), signature: signature.toString('base64url') } } }, ORIGIN)
    assert.equal(result.ok, true, JSON.stringify(result))
    return result.approvalToken
  }
  // Existing repository-publication fixtures retain their exact one-use broker verifier.
  // This separate-transaction stand-in is never installed for message sends.
  const issueClass3 = async (pathname, value, method = 'POST') => {
    if (pathname === SEND) return issueMessageApproval(value, method)
    const token = crypto.randomUUID()
    approvals.set(token, canonicalJson(await aumlokClass3Binding({ audience: ORIGIN, method, pathname, body: value })))
    head.aumlokStore = { ...head.aumlokStore, consumeApproval: async (received, binding, origin) => {
      if (origin !== ORIGIN || approvals.get(received) !== canonicalJson(binding)) return { ok: false }
      approvals.delete(received)
      return { ok: true, binding: clone(binding), expiresAt: Date.now() + 60000 }
    } }
    return token
  }
  let mirror = new MirrorDO({ storage: mirrorStorage })
  let network = 0, assetCalls = 0
  const calls = []
  for (const name of ['HEAD', 'MIRROR']) env[name] = {
    idFromName(value) { assert.equal(value, 'node-main-v1'); return value },
    get(value) {
      assert.equal(value, 'node-main-v1')
      return { fetch(request) { calls.push([name, new URL(request.url).pathname]); return (name === 'HEAD' ? head : mirror).fetch(request) } }
    },
  }
  env.ASSETS = { fetch() { assetCalls++; return new Response('Fixture asset') } }
  const worker = createWorker({
    verifyAccess: async request => authorize && request.headers.get('cookie') === 'CF_Authorization=fixture-token',
    networkFetch: async () => { network++; throw new Error('External network is forbidden in this fixture') },
  })
  t.after(async () => { await headStorage.idle(); await mirrorStorage.idle(); await mirror.queue; assert.equal(network, 0) })
  const request = (pathname, value, overrides = {}) => {
    const headers = new Headers({ cookie: 'CF_Authorization=fixture-token', origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' })
    for (const [name, entry] of Object.entries(overrides.headers ?? {})) entry === null ? headers.delete(name) : headers.set(name, entry)
    return worker.fetch(new Request(new URL(pathname, ORIGIN), { method: overrides.method ?? (value === undefined ? 'GET' : 'POST'), headers, signal: overrides.signal, ...(value === undefined ? {} : { body: typeof value === 'string' ? value : JSON.stringify(value) }) }), env)
  }
  const code = 'export default { fixture: true }'
  const sha = await digest(code)
  const ball = { version: 'x6.1-ball/v1', parentBallId: null, epoch: 1, entries: { 'organ.fixture': { id: 'organ.fixture', specifier: `ball:${sha}`, config: {}, disabled: false, previousSpecifiers: [] } }, modules: { [sha]: { sha256: sha, specifier: `ball:${sha}` } } }
  ball.ballId = await manifestId(ball)
  const entries = receipts === undefined ? [] : [
    ['/dsh/home/auma', { kind: 'dir', mode: 0o700 }],
    ['/dsh/home/auma/seed', { kind: 'dir', mode: 0o700 }],
    ['/dsh/home/auma/seed/receipts.v3.jsonl', { kind: 'file', mode: 0o600, mtimeMs: 1, b64: Buffer.from(receipts).toString('base64') }],
  ]
  const seed = await bootstrapPackage({ version: 'x61-bootstrap/v1', ball, codeBySha: { [sha]: code }, mirror: { entryCount: entries.length, batchDigests: entries.length ? [await digest(canonicalBootstrap(entries))] : [] } })
  async function bootstrap() {
    for (const input of [
      { action: 'prepare', package: seed },
      ...(entries.length ? [{ action: 'batch', seedId: seed.seedId, index: 0, entries }] : []),
      { action: 'commit', seedId: seed.seedId },
    ]) {
      const response = await request('/_bootstrap', input)
      assert.equal(response.status, 200, JSON.stringify(await body(response)))
    }
  }
  return { env, request, bootstrap, headStorage, mirrorStorage, seed, ball, calls, issueClass3,
    hasClass3Approval: token => approvals.has(token),
    approvedRequest: async (pathname, value, overrides = {}) => request(pathname, value, { ...overrides, headers: { ...overrides.headers, 'x-x6-class3-approval': await issueClass3(pathname, value, overrides.method ?? 'POST') } }),
    setProviderFetch(value) { providerFetch = value },
    setAumlokStore(value) { head.aumlokStore = value },
    get mirror() { return mirror },
    get assetCalls() { return assetCalls },
    directHead: request => head.fetch(request),
    alarm: info => head.alarm(info),
    setWakeStore(value) { head.wakeStore = value },
    recreate() { head = new X61HeadDurableObject({ storage: headStorage, getWebSockets: () => [] }, env, headOptions); mirror = new MirrorDO({ storage: mirrorStorage }) },
  }
}

const SNAPSHOT_ROUTE = '/api/snapshot?snapshotFormat=x61-mirror-snapshot/v2'
const FIXTURE_MIRROR_CLIENT = '11111111-1111-4111-8111-111111111111'
const fixtureMirrorFile = value => ({ kind: 'file', mode: 0o600, mtimeMs: 1, b64: Buffer.from(value).toString('base64') })

function fixtureGithubTree(files) {
  const entries = new Map()
  for (const [path, sha] of Object.entries(files)) {
    const parts = path.split('/')
    for (let index = 1; index < parts.length; index++) {
      const parent = parts.slice(0, index).join('/')
      entries.set(parent, { path: parent, type: 'tree', mode: '040000', sha: 'd'.repeat(40) })
    }
    entries.set(path, { path, type: 'blob', mode: '100644', sha, size: 1 })
  }
  return { sha: 'f'.repeat(40), truncated: false, tree: [...entries.values()] }
}

function fixtureGithubPin(url, files, head = 'a'.repeat(40)) {
  const prefix = 'https://api.github.com/repos/your_org_x/your-node'
  if (url === prefix + '/commits/main' || url === prefix + '/commits/' + 'a'.repeat(40)) return Response.json({ sha: url.endsWith('/main') ? head : 'a'.repeat(40), commit: { tree: { sha: 'f'.repeat(40) }, message: 'Synthetic base' }, parents: [] })
  if (url === prefix + '/git/trees/' + 'f'.repeat(40) + '?recursive=1' || url === prefix + '/git/trees/main?recursive=1') return Response.json(fixtureGithubTree(files))
  return null
}

function brokerFixture(cloud, options = {}) {
  const calls = []
  const networkFetch = async (url, init) => {
      calls.push({ url, ...init })
      if (options.sourceFiles) {
        const pinned = fixtureGithubPin(url, options.sourceFiles, options.sourceHead)
        if (pinned) return pinned
      }
      if (!options.networkFetch) throw new Error('Unexpected synthetic network call')
      return options.networkFetch(url, init)
  }
  const worker = createWorker({ verifyAccess: async request => request.headers.get('cookie') === 'CF_Authorization=fixture-token', networkFetch, approveRepoPublication: options.approveRepoPublication })
  return { calls, request: async (route, input, overrides = {}) => {
    cloud.setProviderFetch(networkFetch)
    const headers = new Headers({ cookie: 'CF_Authorization=fixture-token', origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' })
    for (const [key, value] of Object.entries(overrides.headers ?? {})) value === null ? headers.delete(key) : headers.set(key, value)
    if (options.class3Approval && input !== undefined) headers.set('x-x6-class3-approval', await cloud.issueClass3(route, input, overrides.method ?? 'POST'))
    return worker.fetch(new Request(ORIGIN + route, { method: overrides.method ?? (input === undefined ? 'GET' : 'POST'), headers, signal: overrides.signal, ...(input === undefined ? {} : { body: typeof input === 'string' ? input : JSON.stringify(input) }) }), cloud.env)
  } }
}

test('selftest aliases require owner, same origin and paired bootstrap before projecting the same state', async t => {
  const cloud = await fixture(t), broker = brokerFixture(cloud)
  for (const [route, input] of [['/_host/selftest', undefined], ['/_host/repo', { action: 'selftest' }]]) {
    assert.equal((await broker.request(route, input, { headers: { cookie: null } })).status, 401)
    if (route !== '/_host/selftest') assert.equal((await broker.request(route, input, { headers: { origin: null } })).status, 403)
    assert.equal((await broker.request(route, input, { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403)
    assert.equal((await body(await broker.request(route, input))).code, 'BOOTSTRAP_REQUIRED')
  }
  for (const method of ['POST', 'PUT', 'DELETE', 'HEAD']) assert.equal((await broker.request('/_host/selftest', undefined, { method })).status, 405)
  for (const suffix of ['?', '?scope=all', '#fragment']) assert.equal((await broker.request('/_host/selftest' + suffix)).status, 404)
  await cloud.bootstrap()
  cloud.env.SOURCE_REVISION = 'a'.repeat(40)
  cloud.env.ANTHROPIC_API_KEY = 'synthetic-anthropic-key'
  cloud.env.BUILD_INFO = { id: 'fixture-build', private: 'discard-me' }
  const before = [cloud.headStorage.snapshot(), cloud.mirrorStorage.snapshot()]
  const direct = await body(await broker.request('/_host/selftest'))
  assert.deepEqual(direct, await body(await broker.request('/_host/repo', { action: 'selftest' })))
  assert.equal(direct.ok, true)
  assert.equal(direct.head.ballId, cloud.ball.ballId)
  assert.equal(direct.head.phase, 'complete')
  assert.equal(direct.mirror.phase, 'ready')
  assert.equal(direct.aumlok.credentialCount, 0)
  assert.equal(direct.providerDoors.anthropic, true)
  assert.equal(direct.providerDoors.openrouter, false)
  assert.equal(direct.brokers.webEyesConfigured, false)
  assert.equal(direct.brokers.trustedDocsConfigured, true)
  assert.deepEqual(await body(await broker.request('/_host/selftest', undefined, { headers: { origin: null } })), direct)
  for (const headers of [{ origin: null, 'sec-fetch-site': null }, { origin: null, referer: 'https://other.example.com/' }, { referer: 'invalid-url' }, { referer: 'https://user@messages-fixture.example.invalid/' }]) {
    assert.equal((await broker.request('/_host/selftest', undefined, { headers })).status, 403)
  }
  assert.equal(JSON.stringify(direct).includes('discard-me'), false)
  assert.equal(JSON.stringify(direct).includes(cloud.env.ANTHROPIC_API_KEY), false)
  assert.deepEqual([cloud.headStorage.snapshot(), cloud.mirrorStorage.snapshot()], before)
  assert.equal(broker.calls.length, 0)
  const health = await body(await broker.request('/api/health'))
  assert.equal(health.capabilities.selftest, true)
  assert.equal(health.capabilities.trustedDocsHttpsFetch, true)
  assert.equal(health.unsupported.includes('public-web-fetch'), true)
  cloud.setAumlokStore({ status: async () => { throw new Error('Synthetic unavailable identity') } })
  const unavailable = await body(await broker.request('/_host/selftest'))
  assert.equal(unavailable.ok, false)
  assert.equal(unavailable.code, 'SELFTEST_INCOMPLETE')
  assert.equal(unavailable.aumlok.state, 'unavailable')
  assert.equal(unavailable.head.state, 'available')
})

test('broad source reads and tree listings use pinned GitHub files without private mirror fallback', async t => {
  const cloud = await fixture(t); await cloud.bootstrap()
  cloud.env.GITHUB_TOKEN = 'synthetic-github-key'
  const paths = ['README.md', 'package.json', 'server/local-host.mjs', 'deploy/cloudflare/src/worker.mjs', 'docs/fixture.md']
  const sourceFiles = Object.fromEntries(paths.map(path => [path, 'c'.repeat(40)]))
  const broker = brokerFixture(cloud, { sourceFiles, networkFetch: async (url, init) => {
    assert.equal(init.method, 'GET')
    assert.equal(init.redirect, 'error')
    assert.equal(new Headers(init.headers).get('authorization'), 'Bearer ' + cloud.env.GITHUB_TOKEN)
    assert.ok(url.endsWith('?ref=' + 'a'.repeat(40)))
    const path = new URL(url).pathname.split('/contents/')[1]
    assert.ok(paths.includes(path))
    return Response.json({ type: 'file', path, encoding: 'base64', sha: sourceFiles[path], content: Buffer.from('Synthetic ' + path).toString('base64') })
  } })
  const before = cloud.calls.length
  for (const path of paths) {
    const result = await body(await broker.request('/_host/repo', { action: 'read', path }))
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.source, 'github-main')
    assert.equal(result.content, 'Synthetic ' + path)
  }
  assert.equal(cloud.calls.slice(before).filter(([name, route]) => name === 'MIRROR' && route === '/_mirror/repo-read').length, 1, 'Only the legacy docs subset may consult the live mirror')
  const tree = await body(await broker.request('/_host/repo', { action: 'tree', prefix: 'deploy/cloudflare' }))
  assert.equal(tree.ok, true)
  assert.ok(tree.entries.some(entry => entry.path === 'deploy/cloudflare/src/worker.mjs'))
  assert.ok(tree.entries.every(entry => entry.path.startsWith('deploy/cloudflare')))
  for (const path of ['.git/config', '.env', 'server/private/key.mjs', 'mirror/home/auma/memory/private.md']) {
    const calls = broker.calls.length
    const result = await broker.request('/_host/repo', { action: 'read', path })
    assert.ok([403, 404].includes(result.status), path)
    assert.equal(broker.calls.length, calls)
  }
})

test('matching malformed bootstrap identifiers never admit selftest or assets', async t => {
  const cloud = await fixture(t), broker = brokerFixture(cloud)
  for (const values of [{}, { seedId: 'a'.repeat(64), ballId: 'b'.repeat(64) }, { seedId: ['a'.repeat(64)], ballId: 'b'.repeat(64), epoch: 1 },
    { seedId: 'a'.repeat(64), ballId: 'not-a-hash', epoch: 1 }, { seedId: 'a'.repeat(64), ballId: 'b'.repeat(64), epoch: -1 },
    { seedId: 'a'.repeat(64), ballId: 'b'.repeat(64), epoch: Number.MAX_SAFE_INTEGER + 1 }]) {
    for (const name of ['HEAD', 'MIRROR']) cloud.env[name] = { idFromName: value => value, get: () => ({ fetch: async request => {
      assert.ok(new URL(request.url).pathname.endsWith('/bootstrap-status'))
      return Response.json({ ok: true, phase: name === 'HEAD' ? 'complete' : 'ready', ...values })
    } }) }
    assert.equal((await body(await broker.request('/api/health'))).ready, false)
    assert.equal((await body(await broker.request('/_host/selftest'))).code, 'BOOTSTRAP_REQUIRED')
    assert.equal((await body(await broker.request('/'))).code, 'BOOTSTRAP_REQUIRED')
  }
  assert.equal(cloud.assetCalls, 0)
  assert.equal(broker.calls.length, 0)
})

test('bootstrap timeout cancels a late signal-ignoring fetch response', async t => {
  const cloud = await fixture(t), broker = brokerFixture(cloud)
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const entered = Promise.withResolvers(), release = Promise.withResolvers(), cancelled = Promise.withResolvers()
  let signal
  cloud.env.HEAD = { idFromName: value => value, get: () => ({ fetch: request => { signal = request.signal; entered.resolve(); return release.promise } }) }
  const pending = broker.request('/_host/selftest')
  await entered.promise
  t.mock.timers.tick(60000)
  const response = await pending
  assert.equal(response.status, 503)
  assert.equal((await body(response)).code, 'BOOTSTRAP_TIMEOUT')
  assert.equal(signal.aborted, true)
  release.resolve(new Response(new ReadableStream({ cancel() { cancelled.resolve() } })))
  await cancelled.promise
  assert.equal(broker.calls.length, 0)
})

test('bootstrap timeout and caller cancellation stop signal-ignoring response bodies', async t => {
  for (const callerCancels of [false, true]) await t.test(callerCancels ? 'caller abort' : 'deadline', async t => {
    const cloud = await fixture(t), broker = brokerFixture(cloud), controller = new AbortController()
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const reading = Promise.withResolvers(), cancelled = Promise.withResolvers()
    let signal
    cloud.env.HEAD = { idFromName: value => value, get: () => ({ fetch: async request => {
      signal = request.signal
      return new Response(new ReadableStream({ pull() { reading.resolve(); return new Promise(() => {}) }, cancel() { cancelled.resolve(); return new Promise(() => {}) } }), { headers: { 'content-type': 'application/json' } })
    } }) }
    const pending = broker.request('/_host/selftest', undefined, { signal: controller.signal })
    await reading.promise
    if (callerCancels) controller.abort()
    else t.mock.timers.tick(60000)
    const response = await pending
    assert.equal((await body(response)).code, callerCancels ? 'BOOTSTRAP_CANCELLED' : 'BOOTSTRAP_TIMEOUT')
    assert.equal(response.status, callerCancels ? 408 : 503)
    assert.equal(signal.aborted, true)
    await cancelled.promise
  })
})

test('bootstrap checks elapsed time when timer delivery is delayed', async t => {
  const cloud = await fixture(t), broker = brokerFixture(cloud)
  let elapsed = 0, cancelled = 0
  t.mock.method(performance, 'now', () => elapsed)
  cloud.env.HEAD = { idFromName: value => value, get: () => ({ fetch: async () => {
    elapsed = 60001
    return new Response(new ReadableStream({ cancel() { cancelled++ } }), { headers: { 'content-type': 'application/json' } })
  } }) }
  assert.equal((await body(await broker.request('/_host/selftest'))).code, 'BOOTSTRAP_TIMEOUT')
  assert.equal(cancelled, 1)
})

test('broad source publication consumes only the approval for the exact file and bytes', async t => {
  const cloud = await fixture(t); await cloud.bootstrap()
  cloud.env.GITHUB_TOKEN = 'synthetic-github-key'
  const paths = ['README.md', 'package.json', 'server/local-host.mjs', 'deploy/cloudflare/src/worker.mjs', 'docs/fixture.md']
  let writes = 0
  const broker = brokerFixture(cloud, { sourceFiles: Object.fromEntries(paths.map(path => [path, 'c'.repeat(40)])), networkFetch: async (url, init) => {
    if (init.method === 'GET') return Response.json([{ sha: 'a'.repeat(40), commit: { message: 'Synthetic base' } }])
    assert.equal(url, 'https://api.github.com/graphql')
    const input = JSON.parse(init.body).variables.input
    assert.equal(input.expectedHeadOid, 'a'.repeat(40))
    assert.deepEqual(input.fileChanges.additions, [{ path: paths[writes], contents: Buffer.from('Synthetic source').toString('base64') }])
    writes++
    return Response.json({ data: { createCommitOnBranch: { commit: { oid: 'b'.repeat(40) } } } })
  } })
  for (const path of paths) {
    const input = { ...fixturePublication(), path, content: 'Synthetic source' }
    assert.equal((await body(await broker.request('/_host/repo', input))).code, 'CLASS3_WEBAUTHN_REQUIRED')
    const token = await cloud.issueClass3('/_host/repo', input), headers = { 'x-x6-class3-approval': token }
    assert.equal((await body(await broker.request('/_host/repo', { ...input, content: 'Changed bytes' }, { headers }))).code, 'CLASS3_WEBAUTHN_REQUIRED')
    const result = await body(await broker.request('/_host/repo', input, { headers }))
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(cloud.hasClass3Approval(token), false)
    assert.equal((await body(await broker.request('/_host/repo', input, { headers }))).code, 'CLASS3_WEBAUTHN_REQUIRED')
  }
  assert.equal(writes, paths.length)
})

test('GitHub issues and comments require exact one-use Class 3 approval and never replay uncertain posts', async t => {
  const cloud = await fixture(t); await cloud.bootstrap()
  cloud.env.GITHUB_TOKEN = 'synthetic-github-key'
  const prefix = '/repos/your_org_x/your-node', html = 'https://github.com/your_org_x/your-node/issues/12'
  let posts = 0, failAfterPost = false
  const broker = brokerFixture(cloud, { networkFetch: async (url, init) => {
    assert.equal(new Headers(init.headers).get('authorization'), 'Bearer ' + cloud.env.GITHUB_TOKEN)
    assert.equal(new Headers(init.headers).get('cookie'), null)
    assert.equal(init.redirect, 'error')
    if (init.method === 'GET') {
      assert.equal(url, 'https://api.github.com' + prefix + '/issues/12')
      return Response.json({ id: 123, number: 12, state: 'open', title: 'Synthetic issue', body: 'Synthetic body', html_url: html })
    }
    assert.equal(init.method, 'POST')
    posts++
    if (failAfterPost) throw new Error('Uncertain synthetic write ' + cloud.env.GITHUB_TOKEN)
    const input = JSON.parse(init.body)
    return Response.json(url.endsWith('/comments') ? { id: 456, body: input.body, html_url: html + '#issuecomment-456' }
      : { id: 123, number: 12, state: 'open', title: input.title, body: input.body, html_url: html })
  } })
  for (const input of [
    { action: 'api', method: 'POST', endpoint: prefix + '/issues', body: { title: 'Synthetic issue', body: 'Synthetic body' } },
    { action: 'api', method: 'POST', endpoint: prefix + '/issues/12/comments', body: { body: 'Synthetic comment' } },
  ]) {
    assert.equal((await body(await broker.request('/_host/github', input))).code, 'CLASS3_WEBAUTHN_REQUIRED')
    const token = await cloud.issueClass3('/_host/github', input), headers = { 'x-x6-class3-approval': token }, before = posts
    assert.equal((await body(await broker.request('/_host/github', { ...input, body: { ...input.body, body: 'Changed bytes' } }, { headers }))).code, 'CLASS3_WEBAUTHN_REQUIRED')
    assert.equal(posts, before)
    const result = await body(await broker.request('/_host/github', input, { headers }))
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.replaySafe, false)
    assert.equal(result.json.body, input.body.body)
    assert.equal(cloud.hasClass3Approval(token), false)
    assert.equal((await body(await broker.request('/_host/github', input, { headers }))).code, 'CLASS3_WEBAUTHN_REQUIRED')
    assert.equal(posts, before + 1)
  }
  failAfterPost = true
  const input = { action: 'api', method: 'POST', endpoint: prefix + '/issues/12/comments', body: { body: 'Uncertain synthetic comment' } }
  const token = await cloud.issueClass3('/_host/github', input), headers = { 'x-x6-class3-approval': token }
  const unknown = await body(await broker.request('/_host/github', input, { headers }))
  assert.equal(unknown.code, 'GITHUB_MUTATION_OUTCOME_UNKNOWN')
  assert.equal(unknown.outcome, 'unknown')
  assert.equal(unknown.retry, 'inspect-github-before-new-approval')
  assert.equal(JSON.stringify(unknown).includes(cloud.env.GITHUB_TOKEN), false)
  assert.equal((await body(await broker.request('/_host/github', input, { headers }))).code, 'CLASS3_WEBAUTHN_REQUIRED')
  assert.equal(posts, 3)
  for (const endpoint of ['/pulls', '/actions/workflows/test/dispatches', '/git/refs/heads/main']) {
    assert.equal((await broker.request('/_host/github', { ...input, endpoint: prefix + endpoint })).status, 403)
  }
  assert.equal(posts, 3)
})

test('Worker web-eyes uses only the four trusted anonymous origins and reports arbitrary fetch unavailable', async t => {
  const cloud = await fixture(t); await cloud.bootstrap()
  cloud.env.GITHUB_TOKEN = 'synthetic-github-key'
  const targets = ['https://api.github.com/repos/your_org_x/your-node?page=1&per_page=2', 'https://developers.cloudflare.com/workers/', 'https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API', 'https://registry.npmjs.org/typescript']
  const broker = brokerFixture(cloud, { networkFetch: async (url, init) => {
    assert.ok(targets.includes(url))
    assert.equal(init.method, 'GET')
    assert.equal(init.redirect, 'manual')
    assert.equal(init.credentials, 'omit')
    for (const key of ['authorization', 'cookie', 'x-api-key', 'x-x6-owner-assertion', 'x-x6-internal-authorized']) assert.equal(new Headers(init.headers).get(key), null)
    return new Response('Synthetic documentation', { headers: { 'content-type': 'text/plain', 'set-cookie': 'never-returned' } })
  } })
  for (const url of targets) {
    const response = await broker.request('/_host/web-eyes', { action: 'fetch', url }), result = await body(response)
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.capability, 'trusted-docs-fetch')
    assert.equal(result.content, 'Synthetic documentation')
    assert.equal(response.headers.get('set-cookie'), null)
  }
  for (const url of ['https://example.com/', 'https://127.0.0.1/', 'https://api.github.com/user?token=secret', 'https://developers.cloudflare.com/' + cloud.env.GITHUB_TOKEN, 'https://developer.mozilla.org/?q=private', ORIGIN + '/_head/status']) {
    assert.equal((await broker.request('/_host/web-eyes', { action: 'fetch', url })).status, 403, url)
  }
  assert.equal(broker.calls.length, targets.length)
  const health = await body(await broker.request('/api/health'))
  assert.equal(health.capabilities.trustedDocsHttpsFetch, true)
  assert.equal(health.capabilities.trustedDocsOrigins.length, 4)
  assert.equal(health.unsupported.includes('public-web-fetch'), true)
  cloud.env.PUBLIC_HOST = 'api.github.com'
  const worker = createWorker({ verifyAccess: async () => true, networkFetch: async () => { throw new Error('Own-host request must not dispatch') } })
  const refused = await worker.fetch(new Request('https://api.github.com/_host/web-eyes', { method: 'POST', headers: { origin: 'https://api.github.com', 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' }, body: JSON.stringify({ action: 'fetch', url: 'https://api.github.com/repos/your_org_x/your-node' }) }), cloud.env)
  assert.equal((await body(refused)).code, 'TRUSTED_DOCS_ORIGIN_REFUSED')
})

test('cloud brokers authenticate, require same-origin and retain bootstrap refusal', async t => {
  const cloud = await fixture(t), broker = brokerFixture(cloud)
  for (const route of ['/_host/repo', '/_host/github', '/_host/cloudflare']) {
    assert.equal((await broker.request(route, { action: 'status' }, { headers: { cookie: null, 'x-x6-internal-authorized': '1' } })).status, 401)
    assert.equal((await broker.request(route, { action: 'status' }, { headers: { origin: null } })).status, 403)
    assert.equal((await broker.request(route, { action: 'status' }, { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403)
    assert.equal((await broker.request(route, { action: 'status' })).status, 503)
  }
  await cloud.bootstrap()
  assert.equal((await broker.request('/_host/repo?scope=all', { action: 'status' })).status, 404)
  assert.equal((await broker.request('/_host/repo', undefined, { method: 'DELETE' })).status, 405)
  assert.equal((await broker.request('/_host/repo', {}, { headers: { 'content-type': 'text/plain' } })).status, 400)
  assert.equal((await broker.request('/_host/repo', { action: 'status' }, { headers: { 'content-encoding': 'gzip' } })).status, 400)
  assert.equal((await broker.request('/_host/repo', '{')).status, 400)
  assert.equal((await broker.request('/_host/repo', ' '.repeat(CLOUD_BROKER_LIMITS.requestBytes + 1))).status, 413)
  assert.equal(broker.calls.length, 0)
})

test('cloud repo status projects live Head/Mirror and allowlisted build metadata without secrets', async t => {
  const cloud = await fixture(t)
  await cloud.bootstrap()
  cloud.env.SOURCE_REVISION = 'a'.repeat(40)
  cloud.env.BUILD_INFO = { id: 'fixture-version', timestamp: '2026-11-09T00:00:00Z', secret: 'discard-me' }
  await publishFixtureMirror(cloud, [['/dsh/workspace/docs/fixture.md', fixtureMirrorFile('source fixture')]])
  const broker = brokerFixture(cloud), response = await broker.request('/_host/repo', { action: 'status' }), value = await body(response)
  assert.equal(response.status, 200)
  assert.equal(value.head.ballId, cloud.ball.ballId)
  assert.equal(value.mirror.revision, 2)
  assert.equal(value.sourceRevision, cloud.env.SOURCE_REVISION)
  assert.equal(value.buildInfo.id, 'fixture-version')
  assert.equal(JSON.stringify(value).includes('discard-me'), false)
  assert.equal(value.macDependency, false)
  assert.equal((await body(await broker.request('/_host/github', { action: 'status' }))).code, 'GITHUB_BROKER_TOKEN_UNCONFIGURED')
  assert.equal((await body(await broker.request('/_host/cloudflare', { action: 'versions' }))).versions[0].id, 'fixture-version')
  assert.equal(broker.calls.length, 0)
})

test('cloud repo reads mirror files and owner memory without network, refuses private paths and secret content', async t => {
  const cloud = await fixture(t)
  await cloud.bootstrap()
  const source = '/dsh/home/auma/seed/organs/fixture.js', memory = '/dsh/home/auma/memory/fixture.md'
  await publishFixtureMirror(cloud, [[source, fixtureMirrorFile('export default 1')], [memory, fixtureMirrorFile('Owner-only memory')], ['/dsh/workspace/docs/fixture.md', fixtureMirrorFile('github_pat_' + 'x'.repeat(40))]])
  const broker = brokerFixture(cloud)
  for (const [path, content] of [['mirror/home/auma/seed/organs/fixture.js', 'export default 1'], ['mirror/home/auma/memory/fixture.md', 'Owner-only memory']]) {
    const value = await body(await broker.request('/_host/repo', { action: 'read', path }))
    assert.equal(value.source, 'mirror')
    assert.equal(value.content, content)
  }
  for (const path of ['../docs/file.md', 'docs/../README.md', 'docs/.env.md', 'docs/private/file.md', 'mirror/home/auma/seed/owner-key.v1.json', 'mirror/home/auma/.ssh/id_rsa', 'docs/%2e%2e/file.md']) {
    const response = await broker.request('/_host/repo', { action: 'read', path })
    assert.equal(response.status, 403, path)
  }
  const refused = await body(await broker.request('/_host/repo', { action: 'read', path: 'docs/fixture.md' }))
  assert.equal(refused.code, 'BROKER_PRIVATE_CONTENT_REFUSED')
  assert.equal(JSON.stringify(refused).includes('github_pat_'), false)
  assert.equal((await body(await broker.request('/_host/repo', { action: 'read', path: 'mirror/home/auma/memory/missing.md' }))).code, 'REPO_PRIVATE_FALLBACK_REFUSED')
  assert.equal(broker.calls.length, 0)
})

test('cloud repo missing source falls back only to fixed GitHub main with server-side credentials', async t => {
  const cloud = await fixture(t)
  await cloud.bootstrap()
  cloud.env.GITHUB_TOKEN = 'synthetic-fixture-broker-credential'
  const broker = brokerFixture(cloud, { sourceFiles: { 'docs/fixture.md': 'a'.repeat(40) }, networkFetch: async (url, init) => {
    assert.equal(url, 'https://api.github.com/repos/your_org_x/your-node/contents/docs/fixture.md?ref=' + 'a'.repeat(40))
    assert.equal(init.method, 'GET')
    assert.equal(init.redirect, 'error')
    assert.equal(new Headers(init.headers).get('authorization'), 'Bearer ' + cloud.env.GITHUB_TOKEN)
    assert.equal(new Headers(init.headers).get('cookie'), null)
    return Response.json({ type: 'file', path: 'docs/fixture.md', encoding: 'base64', sha: 'a'.repeat(40), content: Buffer.from('Tracked source').toString('base64') })
  } })
  const response = await broker.request('/_host/repo', { action: 'read', path: 'docs/fixture.md', endpoint: 'https://other.invalid' }), value = await body(response)
  assert.equal(response.status, 200)
  assert.equal(value.content, 'Tracked source')
  assert.equal(value.source, 'github-main')
  assert.equal(JSON.stringify(value).includes(cloud.env.GITHUB_TOKEN), false)
  assert.equal(broker.calls.length, 3)
})

test('cloud repo preserves durable deletion, directory refusal and revived descendant precedence', async t => {
  const cloud = await fixture(t)
  await cloud.bootstrap()
  const root = '/dsh/workspace/docs', file = root + '/fixture.md', broker = brokerFixture(cloud)
  await publishFixtureMirror(cloud, [[root, { kind: 'dir', mode: 0o700 }], [file, fixtureMirrorFile('first')]])
  await publishFixtureMirror(cloud, [[root, { kind: 'gone' }]], 2)
  assert.equal((await body(await broker.request('/_host/repo', { action: 'read', path: 'docs/fixture.md' }))).code, 'REPO_PATH_DELETED')
  await publishFixtureMirror(cloud, [[file, fixtureMirrorFile('revived')]], 3)
  assert.equal((await body(await broker.request('/_host/repo', { action: 'read', path: 'docs/fixture.md' }))).content, 'revived')
  await publishFixtureMirror(cloud, [[file, { kind: 'dir', mode: 0o700 }]], 4)
  assert.equal((await body(await broker.request('/_host/repo', { action: 'read', path: 'docs/fixture.md' }))).code, 'REPO_FILE_REQUIRED')
  assert.equal(broker.calls.length, 0)
})

test('internal mirror repo reader refuses forged public routing and validates bounded exact-file reads', async t => {
  const cloud = await fixture(t)
  await cloud.bootstrap()
  const path = '/dsh/workspace/docs/fixture.md'
  await publishFixtureMirror(cloud, [[path, fixtureMirrorFile('small')]])
  const direct = (value, overrides = {}) => cloud.mirror.fetch(new Request('https://x61.internal/_mirror/repo-read' + (overrides.query ?? ''), {
    method: overrides.method ?? 'POST', headers: { 'content-type': 'application/json', 'x-x6-internal-authorized': '1', 'x-x6-bootstrap-seed': cloud.seed.seedId, ...overrides.headers }, ...(overrides.method === 'GET' ? {} : { body: JSON.stringify(value) }),
  }))
  assert.equal((await direct({ path }, { headers: { 'x-x6-internal-authorized': '0' } })).status, 401)
  assert.equal((await direct({ path }, { headers: { 'x-x6-bootstrap-seed': 'b'.repeat(64) } })).status, 503)
  assert.equal((await direct({ path }, { method: 'GET' })).status, 405)
  assert.equal((await direct({ path }, { query: '?path=x' })).status, 404)
  assert.equal((await direct({ path, extra: true })).status, 400)
  assert.equal((await direct({ path }, { headers: { 'content-type': 'text/plain' } })).status, 400)
  assert.equal((await cloud.request('/_mirror/repo-read', { path })).status, 501)
  const restore = observeMirrorStorage(cloud.mirrorStorage, kind => assert.notEqual(kind, 'list'))
  const result = await body(await direct({ path }))
  assert.equal(result.kind, 'file')
  assert.equal(Buffer.from(result.b64, 'base64').toString(), 'small')
  assert.equal((await body(await direct({ path: '/dsh/workspace/docs/missing.md' }))).kind, 'missing')
  restore()
  await publishFixtureMirror(cloud, [[path, fixtureMirrorFile('x'.repeat(256 * 1024 + 1))]], 2)
  assert.equal((await direct({ path })).status, 413)
  await publishFixtureMirror(cloud, [[path, fixtureMirrorFile('small')]], 3)
  const chunk = [...cloud.mirrorStorage.snapshot().keys()].find(key => key.includes(':chunk:'))
  assert.ok(chunk)
  await cloud.mirrorStorage.transaction(tx => tx.delete(chunk))
  assert.equal((await direct({ path })).status, 503)
  for (const forbidden of ['/dsh/home/auma/seed/owner-key.v1.json', '/dsh/home/auma/private/test.md', '/dsh/workspace/docs/.env.md', '/dsh/home/other/file.md']) assert.equal(cloudRepoMirrorPathAllowed(forbidden), false)
})

test('GitHub broker rejects unscoped endpoints, writes, CLI, path traversal and caller-selected refs', async t => {
  const cloud = await fixture(t)
  await cloud.bootstrap()
  cloud.env.GITHUB_TOKEN = 'synthetic-fixture-broker-credential'
  const broker = brokerFixture(cloud)
  for (const input of [
    { action: 'cli', args: ['auth', 'token'] },
    { action: 'api', endpoint: 'https://api.github.com/user' },
    { action: 'api', endpoint: '/user' },
    { action: 'api', endpoint: '/repos/other/repository' },
    { action: 'api', endpoint: '/repos/your_org_x/your-node/actions/secrets' },
    { action: 'api', endpoint: '/repos/your_org_x/your-node/contents/docs/../NORTH-STAR.md' },
    { action: 'api', endpoint: '/repos/your_org_x/your-node/contents/docs/file.md?ref=other' },
    { action: 'api', endpoint: '/repos/your_org_x/your-node/commits?per_page=100' },
    { action: 'api', endpoint: '/repos/your_org_x/your-node', method: 'POST' },
    { action: 'api', endpoint: '/repos/your_org_x/your-node', body: {} },
  ]) assert.equal((await broker.request('/_host/github', input)).status, 403, JSON.stringify(input))
  assert.equal(broker.calls.length, 0)
})

test('cloud read brokers project bounded log/diff/API output and sanitize upstream failures', async t => {
  const cloud = await fixture(t)
  await cloud.bootstrap()
  cloud.env.GITHUB_TOKEN = 'synthetic-fixture-broker-credential'
  cloud.env.SOURCE_REVISION = 'a'.repeat(40)
  const broker = brokerFixture(cloud, { sourceFiles: { 'docs/fixture.md': 'a'.repeat(40) }, sourceHead: 'b'.repeat(40), networkFetch: async url => url.includes('/compare/')
    ? Response.json({ base_commit: { sha: 'a'.repeat(40) }, merge_base_commit: { sha: 'a'.repeat(40) }, status: 'ahead', ahead_by: 1, behind_by: 0, files: [{ filename: 'docs/fixture.md', status: 'modified', patch: '+safe source' }, { filename: 'mirror/home/auma/memory/dag.json', status: 'modified', patch: 'private memory' }] })
    : Response.json([{ sha: 'b'.repeat(40), commit: { message: 'Fixture change', author: { email: 'not-returned@example.invalid' } } }]) })
  const log = await body(await broker.request('/_host/repo', { action: 'log', limit: 1 }))
  assert.equal(log.commits.length, 1)
  assert.equal(JSON.stringify(log).includes('not-returned'), false)
  const diff = await body(await broker.request('/_host/repo', { action: 'diff' }))
  assert.deepEqual(diff.files, [{ path: 'docs/fixture.md', status: 'modified', patch: '+safe source' }])
  assert.equal(JSON.stringify(diff).includes('private memory'), false)
  assert.equal((await body(await broker.request('/_host/github', { action: 'api', endpoint: '/repos/your_org_x/your-node/commits?per_page=1' }))).json.length, 1)
  const failed = brokerFixture(cloud, { networkFetch: async () => new Response(cloud.env.GITHUB_TOKEN, { status: 500 }) })
  const error = await body(await failed.request('/_host/repo', { action: 'log' }))
  assert.equal(error.code, 'BROKER_UPSTREAM_FAILED')
  assert.equal(JSON.stringify(error).includes(cloud.env.GITHUB_TOKEN), false)
  const redirect = brokerFixture(cloud, { networkFetch: async () => new Response(null, { status: 302, headers: { location: 'https://other.invalid' } }) })
  assert.equal((await body(await redirect.request('/_host/repo', { action: 'log' }))).code, 'BROKER_REDIRECT_REFUSED')
})

test('Cloudflare versions uses optional fixed-target credentials only inside the Worker', async t => {
  const cloud = await fixture(t)
  await cloud.bootstrap()
  const unconfigured = brokerFixture(cloud)
  assert.equal((await body(await unconfigured.request('/_host/cloudflare', { action: 'versions', remote: true }))).code, 'CLOUDFLARE_BROKER_TOKEN_UNCONFIGURED')
  cloud.env.CLOUDFLARE_API_TOKEN = 'synthetic-cloudflare-credential'
  cloud.env.CLOUDFLARE_ACCOUNT_ID = 'a'.repeat(32)
  const broker = brokerFixture(cloud, { networkFetch: async (url, init) => {
    assert.equal(url, 'https://api.cloudflare.com/client/v4/accounts/' + 'a'.repeat(32) + '/workers/scripts/your-node/versions')
    assert.equal(init.method, 'GET')
    assert.equal(init.redirect, 'error')
    assert.equal(new Headers(init.headers).get('authorization'), 'Bearer ' + cloud.env.CLOUDFLARE_API_TOKEN)
    return Response.json({ success: true, result: { items: [{ id: 'fixture-version', metadata: { created_on: '2026-11-09T00:00:00Z', credentials: 'discard-me' } }] } })
  } })
  const value = await body(await broker.request('/_host/cloudflare', { action: 'versions', remote: true, account: 'other', script: 'other' }))
  assert.equal(value.versions[0].id, 'fixture-version')
  assert.equal(JSON.stringify(value).includes('discard-me'), false)
  assert.equal(JSON.stringify(value).includes(cloud.env.CLOUDFLARE_API_TOKEN), false)
  const unsupported = await broker.request('/_host/cloudflare', { action: 'wrangler', args: ['secret', 'list'] })
  assert.equal(unsupported.status, 400)
  assert.equal((await body(unsupported)).code, 'CLOUDFLARE_ACTION_UNAVAILABLE')
})

const fixturePublication = (action = 'write') => ({ action, path: 'mirror/home/auma/seed/organs/fixture.js', content: 'export default 1', changes: [{ path: 'mirror/home/auma/seed/organs/fixture.js', content: 'export default 1' }], expectedHeadSha: 'a'.repeat(40), idempotencyKey: 'fixture-request-0001', message: 'Publish synthetic fixture' })

test('Class 3 refuses same-origin flags, cross-action tokens and token replay', async t => {
  const cloud = await fixture(t)
  await cloud.bootstrap()
  const contacts = await body(await cloud.request(CONTACTS))
  const input = { conversationId: contacts.conversations[0].id, content: 'Synthetic guarded turn', requestId: 'class3-fixture-1' }
  const before = cloud.headStorage.snapshot()
  assert.equal((await body(await cloud.request(SEND, input, { headers: { 'x-x6-class3-approved': '1', 'x-x6-internal-authorized': '1' } }))).code, 'CLASS3_WEBAUTHN_REQUIRED')
  assert.deepEqual(cloud.headStorage.snapshot(), before)
  const token = await cloud.issueClass3(SEND, input)
  const headers = { 'x-x6-class3-approval': token }
  assert.equal((await cloud.request(SEND, { ...input, content: 'Different action' }, { headers })).status, 403)
  const sent = await cloud.request(SEND, input, { headers })
  assert.ok([200, 201].includes(sent.status))
  const saved = cloud.headStorage.snapshot()
  assert.equal((await body(await cloud.request(SEND, input, { headers }))).code, 'CLASS3_WEBAUTHN_REQUIRED')
  assert.deepEqual(cloud.headStorage.snapshot(), saved)
  cloud.env.GITHUB_TOKEN = 'synthetic-fixture-broker-credential'
  const broker = brokerFixture(cloud, { approveRepoPublication: async terms => ({ approved: true, canonical: terms.canonical }) })
  for (const [route, value, code] of [
    ['/_host/repo', fixturePublication(), 'CLASS3_WEBAUTHN_REQUIRED'],
    ['/_host/github', { action: 'api', method: 'POST', endpoint: '/repos/your_org_x/your-node/pulls', body: {} }, 'GITHUB_API_REFUSED'],
    ['/_host/cloudflare', { action: 'deploy' }, 'CLOUDFLARE_ACTION_UNAVAILABLE'],
  ]) {
    assert.equal((await body(await broker.request(route, value))).code, code)
  }
  assert.equal(broker.calls.length, 0)
  const ball = clone(cloud.ball)
  ball.entries['seed-pearl'] = { ...ball.entries['organ.fixture'], id: 'seed-pearl' }
  ball.parentBallId = cloud.ball.ballId; ball.epoch++
  ball.authorPeerId = 'governance-fixture'
  ball.ballId = await manifestId(ball)
  const lease = await body(await cloud.request('/_head/lease', { action: 'acquire', ownerPeerId: ball.authorPeerId }))
  assert.equal((await body(await cloud.request('/_head/ball', { ball, expectedParentBallId: cloud.ball.ballId, expectedEpoch: cloud.ball.epoch, writerLease: lease.lease }))).code, 'CLASS3_WEBAUTHN_REQUIRED')
})

test('public web-eyes never uses DNS preflight as connection authorization', async t => {
  const cloud = await fixture(t)
  await cloud.bootstrap()
  const broker = brokerFixture(cloud)
  for (const url of ['http://example.com/', 'https://127.0.0.1/', 'https://[::1]/', 'https://169.254.169.254/latest/meta-data/', 'https://0x7f000001/', 'https://metadata.google.internal/', 'https://user:password@example.com/', 'https://example.com:444/']) {
    assert.equal((await body(await broker.request('/_host/web-eyes', { action: 'fetch', url }))).code, 'WEB_EYES_URL_REFUSED')
  }
  assert.equal((await body(await broker.request('/_host/web-eyes', { action: 'fetch', url: 'https://example.com/' }))).code, 'TRUSTED_DOCS_ORIGIN_REFUSED')
  assert.equal(broker.calls.length, 0)
})

test('owner public key lookup never reads a signing secret', async t => {
  const cloud = await fixture(t)
  await cloud.bootstrap()
  cloud.env.OWNER_PUBLIC_KEY_HEX = 'a'.repeat(64)
  Object.defineProperty(cloud.env, 'OWNER_ED25519_SECRET_KEY', { get() { throw new Error('Private signing material must never be read') } })
  const result = await body(await cloud.request('/_host/owner-key'))
  assert.equal(result.publicKeyHex, 'a'.repeat(64))
  assert.equal(result.keyId, 'owner-ed25519-' + 'a'.repeat(12))
})

test('provider budgets reserve atomically across isolates and DO recreation', async t => {
  const cloud = await fixture(t)
  await cloud.bootstrap()
  const first = brokerFixture(cloud, { networkFetch: async () => Response.json({ ok: true }) })
  assert.equal((await body(await first.request('/door/openai/v1/models'))).code, 'PROVIDER_BUDGET_UNCONFIGURED')
  Object.assign(cloud.env, { OPENAI_API_KEY: 'synthetic-provider-key', PROVIDER_BUDGET_WINDOW_MS: '60000', PROVIDER_BUDGET_REQUESTS: '2', PROVIDER_BUDGET_TOKENS: '10000', PROVIDER_MAX_OUTPUT_TOKENS: '128' })
  const second = brokerFixture(cloud, { networkFetch: async () => Response.json({ ok: true }) })
  const input = { model: 'fixture-model', messages: [{ role: 'user', content: 'Synthetic only' }], max_tokens: 20 }
  assert.equal((await first.request('/door/openai/v1/chat/completions', { ...input, max_tokens: 129 })).status, 400)
  const responses = await Promise.all([first.request('/door/openai/v1/chat/completions', input), second.request('/door/openai/v1/chat/completions', input), second.request('/door/openai/v1/chat/completions', input)])
  assert.deepEqual(responses.map(value => value.status).sort(), [200, 200, 429])
  assert.equal(first.calls.length + second.calls.length, 2)
  const state = await cloud.headStorage.get('provider-budget:v1:openai')
  assert.equal(state.requests, 2)
  assert.equal(state.tokens, 2 * providerRequestReservation(Buffer.from(JSON.stringify(input)), providerBudgetLimits(cloud.env), '/v1/chat/completions').tokens)
  cloud.recreate()
  assert.equal((await body(await second.request('/door/openai/v1/models'))).code, 'PROVIDER_BUDGET_EXHAUSTED')
  assert.equal(first.calls.length + second.calls.length, 2)
})

const fixtureProviderLimits = { PROVIDER_BUDGET_WINDOW_MS: '60000', PROVIDER_BUDGET_REQUESTS: '20', PROVIDER_BUDGET_TOKENS: '100000', PROVIDER_MAX_OUTPUT_TOKENS: '128' }

test('provider doors preserve Anthropic Messages and OpenRouter model IDs with server-owned headers', async t => {
  const cloud = await fixture(t); await cloud.bootstrap()
  Object.assign(cloud.env, fixtureProviderLimits, { ANTHROPIC_API_KEY: 'synthetic-anthropic-key', OPENROUTER_API_KEY: 'synthetic-openrouter-key', DEEPSEEK_API_KEY: 'synthetic-deepseek-key' })
  const broker = brokerFixture(cloud, { networkFetch: async (url, init) => {
    const input = JSON.parse(Buffer.from(init.body).toString()), headers = new Headers(init.headers)
    assert.equal(init.method, 'POST')
    assert.equal(init.redirect, 'manual')
    assert.ok(init.signal instanceof AbortSignal)
    for (const header of ['cookie', 'x-x6-owner-assertion', 'x-x6-internal-authorized']) assert.equal(headers.get(header), null)
    assert.equal(input.max_tokens, 32)
    assert.equal(input.messages[0].content, 'Synthetic text only')
    if (url === 'https://api.anthropic.com/v1/messages') {
      assert.equal(headers.get('x-api-key'), cloud.env.ANTHROPIC_API_KEY)
      assert.equal(headers.get('authorization'), null)
      assert.equal(headers.get('anthropic-version'), '2023-06-01')
      assert.equal(headers.get('anthropic-beta'), 'prompt-caching-2024-07-31')
    } else if (url === 'https://api.deepseek.com/anthropic/v1/messages') {
      assert.equal(headers.get('authorization'), 'Bearer ' + cloud.env.DEEPSEEK_API_KEY)
      assert.equal(headers.get('x-api-key'), cloud.env.DEEPSEEK_API_KEY)
      assert.equal(headers.get('anthropic-version'), '2023-06-01')
    } else {
      assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions')
      assert.equal(headers.get('authorization'), 'Bearer ' + cloud.env.OPENROUTER_API_KEY)
      assert.equal(headers.get('x-api-key'), null)
      assert.equal(headers.get('anthropic-version'), null)
      assert.equal(headers.get('anthropic-beta'), null)
    }
    return new Response('data: {"synthetic":true}\n\n', { headers: { 'content-type': 'text/event-stream', 'x-model': input.model, 'set-cookie': 'upstream-private-cookie' } })
  } })
  for (const [route, model] of [
    ['/door/anthropic/v1/messages', 'claude-opus-4-1-20250805'],
    ['/door/deepseek/anthropic/v1/messages', 'deepseek-chat'],
    ...['anthropic/claude-opus-4.1', 'x-ai/grok-4', 'google/gemini-2.5-pro', 'deepseek/deepseek-chat'].map(model => ['/door/openrouter/v1/chat/completions', model]),
  ]) {
    const response = await broker.request(route, { model, max_tokens: 32, stream: true, messages: [{ role: 'user', content: 'Synthetic text only' }] }, {
      headers: { authorization: 'Bearer untrusted-browser-key', 'x-api-key': 'untrusted-browser-key', 'anthropic-version': 'untrusted-version', 'anthropic-beta': 'prompt-caching-2024-07-31', 'x-x6-owner-assertion': 'untrusted-owner-token' },
    })
    assert.equal(response.status, 200)
    assert.equal(await response.text(), 'data: {"synthetic":true}\n\n')
    assert.equal(response.headers.get('set-cookie'), null)
    assert.deepEqual(JSON.parse(response.headers.get('x-x6-model-attribution')), { requestedModel: model, providerReportedModel: model, immutableRevision: null, evidenceQuality: 'gateway-observed' })
  }
  assert.equal(broker.calls.length, 6)
  assert.equal((await cloud.headStorage.get('provider-budget:v1:openrouter')).requests, 4)
})

test('provider doors reject unauthenticated, unbounded and remote-content requests before dispatch', async t => {
  const cloud = await fixture(t); await cloud.bootstrap()
  Object.assign(cloud.env, fixtureProviderLimits, { ANTHROPIC_API_KEY: 'synthetic-anthropic-key', OPENROUTER_API_KEY: 'synthetic-openrouter-key' })
  const broker = brokerFixture(cloud), route = '/door/openrouter/v1/chat/completions'
  const input = { model: 'x-ai/grok-4', max_tokens: 32, messages: [{ role: 'user', content: 'Synthetic only' }] }
  assert.equal((await broker.request(route, input, { headers: { cookie: null } })).status, 401)
  assert.equal((await broker.request(route, input, { headers: { origin: 'https://other.example.com' } })).status, 403)
  for (const endpoint of [route + '?target=https://127.0.0.1/', route + '#fragment', '/door/openrouter/v1/files', '/door/openrouter/https://127.0.0.1/messages', '/door/unknown/v1/messages']) {
    assert.equal((await broker.request(endpoint, input)).status, 404)
  }
  for (const extra of [{ max_tokens: undefined }, { max_tokens: 129 }, { max_completion_tokens: 32 }, { messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://127.0.0.1/' } }] }] }, { tools: [{ type: 'web_search' }] }, { previous_response_id: 'stored-conversation' }]) {
    assert.equal((await broker.request(route, { ...input, ...extra })).status, 400)
  }
  assert.equal((await broker.request('/door/anthropic/v1/messages', { ...input, messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'url', url: 'https://127.0.0.1/' } }] }] })).status, 400)
  assert.equal(await cloud.headStorage.get('provider-budget:v1:openrouter'), undefined)
  assert.equal(await cloud.headStorage.get('provider-budget:v1:anthropic'), undefined)
  assert.equal(broker.calls.length, 0)
})

test('ambiguous provider dispatch spends one reservation and never retries or leaks its failure', async t => {
  const cloud = await fixture(t); await cloud.bootstrap()
  Object.assign(cloud.env, fixtureProviderLimits, { PROVIDER_BUDGET_REQUESTS: '1', OPENROUTER_API_KEY: 'synthetic-openrouter-key' })
  const broker = brokerFixture(cloud, { networkFetch: async () => { throw new Error('Ambiguous transport failure: ' + cloud.env.OPENROUTER_API_KEY) } })
  const input = { model: 'google/gemini-2.5-pro', max_tokens: 32, messages: [{ role: 'user', content: 'Synthetic only' }] }
  const response = await broker.request('/door/openrouter/v1/chat/completions', input)
  assert.equal(response.status, 422)
  assert.equal(response.headers.get('x-should-retry'), 'false')
  const failure = await body(response)
  assert.deepEqual(failure, { ok: false, code: 'PROVIDER_OUTCOME_UNKNOWN', outcome: 'unknown', retry: 'do-not-repeat-automatically', error: {
    type: 'provider_outcome_unknown', code: 'PROVIDER_OUTCOME_UNKNOWN', message: 'The provider may have processed this request. Its result is unknown. Do not automatically resubmit it.',
  } })
  assert.equal(JSON.stringify(failure).includes(cloud.env.OPENROUTER_API_KEY), false)
  // Execute the actual source classifiers through the repository's source loader, without an app or provider call.
  const classifications = JSON.parse(execFileSync(process.execPath, ['--import', 'tsx/esm', '--input-type=module', '-e', `
    import fs from 'node:fs';
    import { providerError } from './packages/llm/llm-deepseek/src/transport.ts';
    import { mapStopReason } from './packages/llm/llm-pi-ai/src/stream.ts';
    import { resolveRetryPolicy } from './packages/llm/llm/src/retry-policy.ts';
    const body = JSON.parse(fs.readFileSync(0, 'utf8'));
    const codes = [providerError(body, 422).code, mapStopReason({stopReason:'error', errorMessage:'422 ' + body.error.message}).failure.code];
    const policy = resolveRetryPolicy(undefined, 'synthetic provider route');
    console.log(JSON.stringify({codes, retryable: codes.map(code => policy.retryableCodes.includes(code)), oldStatusCode: providerError(body, 503).code}));
  `], { cwd: new URL('../../../../', import.meta.url), input: JSON.stringify(failure), encoding: 'utf8' }))
  assert.deepEqual(classifications, { codes: ['HTTP_422', 'PI_AI_ERROR'], retryable: [false, false], oldStatusCode: 'SERVER' })
  const reserved = await cloud.headStorage.get('provider-budget:v1:openrouter')
  assert.equal(reserved.requests, 1)
  assert.ok(reserved.tokens > input.max_tokens)
  cloud.recreate()
  assert.equal((await body(await broker.request('/door/openrouter/v1/chat/completions', input))).code, 'PROVIDER_BUDGET_EXHAUSTED')
  assert.deepEqual(await cloud.headStorage.get('provider-budget:v1:openrouter'), reserved)
  assert.equal(broker.calls.length, 1)
})

test('provider redirects are refused and cancelled without a follow-up dispatch', async t => {
  const cloud = await fixture(t); await cloud.bootstrap()
  Object.assign(cloud.env, fixtureProviderLimits, { ANTHROPIC_API_KEY: 'synthetic-anthropic-key' })
  let cancelled = 0
  const broker = brokerFixture(cloud, { networkFetch: async () => new Response(new ReadableStream({ cancel() { cancelled++ } }), { status: 307, headers: { location: 'https://127.0.0.1/private' } }) })
  const response = await broker.request('/door/anthropic/v1/messages', { model: 'claude-opus-4-1-20250805', max_tokens: 32, messages: [{ role: 'user', content: 'Synthetic only' }] })
  assert.equal(response.status, 502)
  assert.equal((await body(response)).code, 'PROVIDER_REDIRECT_REFUSED')
  assert.equal(cancelled, 1)
  assert.equal(broker.calls.length, 1)
  assert.equal((await cloud.headStorage.get('provider-budget:v1:anthropic')).requests, 1)
})

test('budget windows do not reset on clock rollback or refund failures', async () => {
  const storage = memoryStorage()
  const limits = providerBudgetLimits({ PROVIDER_BUDGET_WINDOW_MS: 60000, PROVIDER_BUDGET_REQUESTS: 1, PROVIDER_BUDGET_TOKENS: 100, PROVIDER_MAX_OUTPUT_TOKENS: 100 })
  await reserveProviderBudget(storage, { provider: 'openai', tokens: 100 }, limits, 100000)
  for (const now of [0, 100001, 159999]) await assert.rejects(reserveProviderBudget(storage, { provider: 'openai', tokens: 1 }, limits, now), { code: 'PROVIDER_BUDGET_EXHAUSTED' })
  assert.equal((await reserveProviderBudget(storage, { provider: 'openai', tokens: 1 }, limits, 160000)).ok, true)
})

test('provider wire validation preserves inline tools while refusing hidden-cost inputs', () => {
  const limits = { maxOutputTokens: 128 }
  const reserve = (value, path = '/v1/chat/completions') => providerRequestReservation(Buffer.from(JSON.stringify(value)), limits, path)
  const base = { model: 'fixture', messages: [{ role: 'user', content: 'Use an inline client tool' }], max_tokens: 32 }
  const definition = { name: 'fixture', description: 'Synthetic client-side function', parameters: { type: 'object', properties: { text: { type: 'string' } } } }
  const tool = { type: 'function', function: definition }
  assert.ok(reserve({ ...base, tools: [tool], messages: [...base.messages, { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'fixture', arguments: '{"text":"hello"}' } }] }, { role: 'tool', tool_call_id: 'call_1', content: 'Inline returned text' }] }).tokens > 32)
  for (const extra of [{ previous_response_id: 'remote' }, { conversation: 'remote' }, { best_of: 2 }, { tools: [{ type: 'web_search' }] }, { tools: [{ type: 'function', function: { ...definition, parameters: { $ref: 'https://remote.invalid/schema' } } }] }, { messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://remote.invalid/image' } }] }] }]) {
    assert.throws(() => reserve({ ...base, ...extra }), { code: 'PROVIDER_REQUEST_SHAPE_UNSUPPORTED' })
  }
  assert.throws(() => reserve({ ...base, n: 2 }), { code: 'PROVIDER_BUDGET_REQUEST_INVALID' })
  assert.throws(() => reserve({ model: 'fixture', messages: base.messages, max_output_tokens: 32 }), { code: 'PROVIDER_REQUEST_SHAPE_UNSUPPORTED' })
  assert.throws(() => reserve({ ...base, max_completion_tokens: 32 }), { code: 'PROVIDER_OUTPUT_LIMIT_REQUIRED' })
  const responses = { model: 'fixture', input: [{ type: 'function_call_output', call_id: 'call_1', output: 'Inline result' }], tools: [{ type: 'function', ...definition }], max_output_tokens: 32, store: false }
  assert.ok(reserve(responses, '/v1/responses').tokens > 32)
  assert.throws(() => reserve({ ...responses, input: [{ type: 'item_reference', id: 'remote' }] }, '/v1/responses'), { code: 'PROVIDER_REQUEST_SHAPE_UNSUPPORTED' })
  assert.throws(() => reserve({ ...responses, max_output_tokens: undefined, max_tokens: 32 }, '/v1/responses'), { code: 'PROVIDER_REQUEST_SHAPE_UNSUPPORTED' })
  const anthropic = { model: 'fixture', max_tokens: 32, tools: [{ name: 'fixture', input_schema: definition.parameters }], messages: [{ role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'fixture', input: { text: 'hello' } }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'Inline result' }] }] }
  assert.ok(reserve(anthropic, '/anthropic/v1/messages').tokens > 32)
  assert.throws(() => reserve({ ...anthropic, messages: [{ role: 'user', content: [{ type: 'document', source: { type: 'url', url: 'https://remote.invalid/' } }] }] }, '/v1/messages'), { code: 'PROVIDER_REQUEST_SHAPE_UNSUPPORTED' })
})

test('private provider reservations persist through local adapter recreation', async t => {
  const root = await temporaryRoot(t)
  const make = () => providerBudgetRecordStorage(createLocalMessagesStorage({ directory: path.join(root, 'provider-budget') }), 'messages:v1')
  const limits = providerBudgetLimits({ PROVIDER_BUDGET_WINDOW_MS: 60000, PROVIDER_BUDGET_REQUESTS: 2, PROVIDER_BUDGET_TOKENS: 100, PROVIDER_MAX_OUTPUT_TOKENS: 50 })
  const first = make()
  await reserveProviderBudget(first, { provider: 'openai', tokens: 40 }, limits, 100000)
  await reserveProviderBudget(make(), { provider: 'openai', tokens: 40 }, limits, 100001)
  await assert.rejects(reserveProviderBudget(make(), { provider: 'openai', tokens: 1 }, limits, 100002), { code: 'PROVIDER_BUDGET_EXHAUSTED' })
})

test('local relay URL policy allows only exact numeric-loopback status probes', async () => {
  // Evaluate only this pure source function. Importing local-host would start the
  // application and access live private state, which this fixture must never do.
  const source = await fs.readFile(new URL('../../../../server/local-host.mjs', import.meta.url), 'utf8')
  const start = source.indexOf('function validateRelayTargetUrl(rawUrl) {')
  const end = source.indexOf('/** Bound complete relay bodies', start)
  assert.ok(start >= 0 && end > start)
  const validate = runInNewContext(source.slice(start, end) + '\nvalidateRelayTargetUrl', { URL, PORT: 4610 })
  for (const pathname of ['/_head/ball', '/_mirror/status', '/_head/runtime']) {
    const result = validate('http://localhost:4610' + pathname)
    assert.equal(result.ok, true)
    assert.equal(result.url, 'http://127.0.0.1:4610' + pathname)
  }
  for (const target of ['http://127.0.0.1:4610/_head/ball?mutate=1', 'http://user@127.0.0.1:4610/_head/ball', 'http://127.0.0.1:4610/_host/repo', 'http://localhost:4611/_mirror/status', 'https://[::1]/', 'https://169.254.169.254/', 'http://example.com/']) assert.equal(validate(target).ok, false)
  for (const target of ['https://example.com/', 'https://dns-rebind.example/']) assert.equal(validate(target).code, 'PUBLIC_NETWORK_GUARD_UNAVAILABLE')
})

test('identity read failures preserve core facts and mirror export reuses snapshots', async t => {
  const cloud = await fixture(t)
  await cloud.bootstrap()
  const baseline = await body(await cloud.request('/__x6/facts'))
  cloud.setAumlokStore({ status: async () => { throw new Error('Synthetic identity storage failure') } })
  const failed = await body(await cloud.request('/__x6/facts'))
  delete baseline.aumlok; delete failed.aumlok
  assert.deepEqual(failed, baseline)
  const exported = await cloud.request('/_mirror/export')
  const snapshot = await cloud.request(SNAPSHOT_ROUTE)
  assert.equal(exported.status, 200)
  assert.equal(await exported.text(), await snapshot.text())
})

test('cloud publication fails closed without exact trusted approval, regardless of request booleans or origin', async t => {
  const cloud = await fixture(t)
  await cloud.bootstrap()
  cloud.env.GITHUB_TOKEN = 'synthetic-fixture-broker-credential'
  for (const approveRepoPublication of [undefined, async () => true, async () => ({ approved: true, canonical: 'different action' })]) {
    const broker = brokerFixture(cloud, { approveRepoPublication })
    for (const action of ['write', 'commit', 'push']) {
      const result = await body(await broker.request('/_host/repo', { ...fixturePublication(action), ownerApproved: true, approved: true, authorization: 'owner' }))
      assert.equal(result.code, 'CLASS3_WEBAUTHN_REQUIRED')
    }
    assert.equal(broker.calls.length, 0)
  }
})

test('publication preflight refuses invalid paths, bytes and configuration without consuming a token', async t => {
  const cloud = await fixture(t); await cloud.bootstrap()
  cloud.env.GITHUB_TOKEN = 'synthetic-fixture-broker-credential'
  for (const [input, config, code] of [
    ...['mirror/home/auma/memory/note.md', 'mirror/home/auma/seed/organs/../fixture.js', 'mirror/home/auma/seed/organs/.hidden.js',
      'mirror/home/auma/seed/organs/owner-key.js', 'mirror/home/auma/seed/organs/fixture%2f.js']
      .map(path => [{ ...fixturePublication(), path }, {}, 'REPO_PATH_REFUSED']),
    [{ ...fixturePublication(), content: '-----BEGIN PRIVATE KEY-----' }, {}, 'BROKER_PRIVATE_CONTENT_REFUSED'],
    [{ ...fixturePublication(), content: 'x'.repeat(CLOUD_BROKER_LIMITS.fileBytes + 1) }, {}, 'BROKER_CONTENT_INVALID'],
    [{ ...fixturePublication(), message: 'line one\nline two' }, {}, 'REPO_COMMIT_MESSAGE_INVALID'],
    [fixturePublication(), { approveRepoPublication: null }, 'OWNER_APPROVAL_REQUIRED'],
    [fixturePublication(), { approveRepoPublication: true }, 'OWNER_APPROVAL_REQUIRED'],
  ]) {
    const token = await cloud.issueClass3('/_host/repo', input)
    const broker = brokerFixture(cloud, config)
    assert.equal((await body(await broker.request('/_host/repo', input, { headers: { 'x-x6-class3-approval': token } }))).code, code)
    assert.equal(cloud.hasClass3Approval(token), true)
    assert.equal(broker.calls.length, 0)
  }
  delete cloud.env.GITHUB_TOKEN
  const input = fixturePublication(), token = await cloud.issueClass3('/_host/repo', input)
  assert.equal((await body(await brokerFixture(cloud).request('/_host/repo', input, { headers: { 'x-x6-class3-approval': token } }))).code, 'GITHUB_BROKER_TOKEN_UNCONFIGURED')
  assert.equal(cloud.hasClass3Approval(token), true)
})

test('production factory publishes exact passkey-approved source with no injected publication approver', async t => {
  const cloud = await fixture(t); await cloud.bootstrap()
  cloud.env.GITHUB_TOKEN = 'synthetic-fixture-broker-credential'
  const headBefore = cloud.headStorage.snapshot(), mirrorBefore = cloud.mirrorStorage.snapshot()
  let writes = 0
  const broker = brokerFixture(cloud, { sourceFiles: { [fixturePublication().path]: 'c'.repeat(40) }, networkFetch: async (url, init) => {
    if (init.method === 'GET') return Response.json([{ sha: 'a'.repeat(40), commit: { message: 'Fixture base' } }])
    assert.equal(url, 'https://api.github.com/graphql')
    const publication = JSON.parse(init.body).variables.input
    assert.equal(publication.expectedHeadOid, 'a'.repeat(40))
    assert.deepEqual(publication.fileChanges.additions, [{ path: fixturePublication().path, contents: Buffer.from('export default 1').toString('base64') }])
    writes++; return Response.json({ data: { createCommitOnBranch: { commit: { oid: 'b'.repeat(40) } } } })
  } })
  assert.equal((await body(await broker.request('/api/health'))).capabilities.sourcePublicationApproval, true)
  for (const action of ['write', 'commit', 'push']) {
    const input = fixturePublication(action), token = await cloud.issueClass3('/_host/repo', input)
    const headers = { 'x-x6-class3-approval': token }
    const result = await body(await broker.request('/_host/repo', input, { headers }))
    assert.equal(result.ok, true)
    assert.equal(result.mode, 'atomic-main-publication')
    assert.equal(cloud.hasClass3Approval(token), false)
    assert.equal((await body(await broker.request('/_host/repo', input, { headers }))).code, 'CLASS3_WEBAUTHN_REQUIRED')
  }
  assert.equal(writes, 3)
  assert.deepEqual(cloud.headStorage.snapshot(), headBefore)
  assert.deepEqual(cloud.mirrorStorage.snapshot(), mirrorBefore)
})

test('trusted cloud source publication uses atomic expectedHeadOid and reconciles identical retries without a second write', async t => {
  const cloud = await fixture(t)
  await cloud.bootstrap()
  cloud.env.GITHUB_TOKEN = 'synthetic-fixture-broker-credential'
  let published = null, writes = 0, approvals = 0
  const broker = brokerFixture(cloud, {
    sourceFiles: { [fixturePublication().path]: 'c'.repeat(40) },
    approveRepoPublication: async terms => {
      approvals++
      assert.equal(Object.isFrozen(terms.binding), true)
      assert.equal(Object.isFrozen(terms.files[0]), true)
      assert.equal(terms.binding.repository, 'your_org_x/your-node')
      assert.equal(terms.binding.expectedHeadSha, 'a'.repeat(40))
      assert.equal(terms.files[0].content, 'export default 1')
      assert.equal(terms.binding.files[0].sha256, createHash('sha256').update('export default 1').digest('hex'))
      return { approved: true, canonical: terms.canonical }
    },
    networkFetch: async (url, init) => {
      if (url.endsWith('/commits/' + 'b'.repeat(40))) return Response.json({ ...published, files: [{ filename: fixturePublication().path, status: 'modified' }] })
      if (url.includes('/contents/')) {
        assert.ok(url.endsWith('?ref=' + 'b'.repeat(40)))
        return Response.json({ type: 'file', path: fixturePublication().path, encoding: 'base64', sha: 'c'.repeat(40), content: Buffer.from('export default 1').toString('base64') })
      }
      if (init.method === 'GET') return Response.json(published ? [published] : [{ sha: 'a'.repeat(40), commit: { message: 'Fixture base' } }])
      assert.equal(url, 'https://api.github.com/graphql')
      const input = JSON.parse(init.body).variables.input
      assert.deepEqual(input.branch, { repositoryNameWithOwner: 'your_org_x/your-node', branchName: 'main' })
      assert.equal(input.expectedHeadOid, 'a'.repeat(40))
      assert.deepEqual(input.fileChanges.additions, [{ path: fixturePublication().path, contents: Buffer.from('export default 1').toString('base64') }])
      published = { sha: 'b'.repeat(40), parents: [{ sha: 'a'.repeat(40) }], commit: { tree: { sha: 'f'.repeat(40) }, message: input.message.headline + '\n\n' + input.message.body } }
      writes++
      throw new Error('Synthetic lost response after commit')
    },
  })
  const firstToken = await cloud.issueClass3('/_host/repo', fixturePublication())
  const first = await body(await broker.request('/_host/repo', fixturePublication(), { headers: { 'x-x6-class3-approval': firstToken } }))
  assert.equal(first.code, 'REPO_PUBLICATION_OUTCOME_UNKNOWN')
  assert.equal(first.outcome, 'unknown')
  assert.equal(first.requiresFreshClass3Approval, true)
  const callsAfterUnknown = broker.calls.length
  assert.equal((await body(await broker.request('/_host/repo', fixturePublication(), { headers: { 'x-x6-class3-approval': firstToken } }))).code, 'CLASS3_WEBAUTHN_REQUIRED')
  assert.equal(broker.calls.length, callsAfterUnknown)
  const freshToken = await cloud.issueClass3('/_host/repo', fixturePublication())
  const replay = await body(await broker.request('/_host/repo', fixturePublication(), { headers: { 'x-x6-class3-approval': freshToken } }))
  assert.equal(replay.ok, true)
  assert.equal(replay.replayed, true)
  assert.equal(replay.commit, 'b'.repeat(40))
  assert.equal(writes, 1)
  assert.equal(approvals, 2)
  const changedInput = { ...fixturePublication(), content: 'export default 2' }
  const changedToken = await cloud.issueClass3('/_host/repo', changedInput)
  const changed = await body(await broker.request('/_host/repo', changedInput, { headers: { 'x-x6-class3-approval': changedToken } }))
  assert.equal(changed.code, 'OWNER_APPROVAL_REQUIRED')
  assert.equal(writes, 1)
})

test('cloud publication rejects private files, non-source writes and stale main before mutation', async t => {
  const cloud = await fixture(t)
  await cloud.bootstrap()
  cloud.env.GITHUB_TOKEN = 'synthetic-fixture-broker-credential'
  const broker = brokerFixture(cloud, { class3Approval: true, approveRepoPublication: async terms => ({ approved: true, canonical: terms.canonical }), networkFetch: async (url, init) => {
    assert.equal(init.method, 'GET')
    return Response.json([{ sha: 'd'.repeat(40), commit: { message: 'Main advanced' } }])
  } })
  for (const path of ['mirror/home/auma/memory/note.md', 'mirror/home/auma/seed/receipts.v3.jsonl', 'mirror/home/auma/seed/owner-key.v1.json']) {
    assert.equal((await body(await broker.request('/_host/repo', { ...fixturePublication(), path }))).code, 'REPO_PATH_REFUSED')
  }
  assert.equal((await body(await broker.request('/_host/repo', { ...fixturePublication(), content: '-----BEGIN PRIVATE KEY-----' }))).code, 'BROKER_PRIVATE_CONTENT_REFUSED')
  assert.equal(broker.calls.length, 0)
  assert.equal((await body(await broker.request('/_host/repo', fixturePublication()))).code, 'REPO_HEAD_CONFLICT')
  assert.equal(broker.calls.length, 1)
})

test('cloud publication succeeds only for approved source and keeps GraphQL error outcomes uncertain', async t => {
  const cloud = await fixture(t)
  await cloud.bootstrap()
  cloud.env.GITHUB_TOKEN = 'synthetic-fixture-broker-credential'
  let rejectMutation = false, writes = 0
  const broker = brokerFixture(cloud, { sourceFiles: { [fixturePublication().path]: 'c'.repeat(40) }, class3Approval: true, approveRepoPublication: async terms => ({ approved: true, canonical: terms.canonical }), networkFetch: async (url, init) => {
    if (init.method === 'GET') return Response.json([{ sha: 'a'.repeat(40), commit: { message: 'Fixture base' } }])
    writes++
    return Response.json(rejectMutation ? { errors: [{ type: 'STALE_DATA', message: cloud.env.GITHUB_TOKEN }] } : { data: { createCommitOnBranch: { commit: { oid: 'b'.repeat(40) } } } })
  } })
  for (const action of ['write', 'commit', 'push']) {
    const result = await body(await broker.request('/_host/repo', fixturePublication(action)))
    assert.equal(result.ok, true)
    assert.equal(result.mode, 'atomic-main-publication')
    assert.equal(result.commit, 'b'.repeat(40))
    assert.equal(result.replayed, false)
  }
  rejectMutation = true
  const denied = await body(await broker.request('/_host/repo', fixturePublication()))
  assert.equal(denied.code, 'REPO_PUBLICATION_OUTCOME_UNKNOWN')
  assert.equal(JSON.stringify(denied).includes(cloud.env.GITHUB_TOKEN), false)
  assert.equal(writes, 4)
})

test('cloud publication does not acknowledge a forged replay marker with extra changed files', async t => {
  const cloud = await fixture(t)
  await cloud.bootstrap()
  cloud.env.GITHUB_TOKEN = 'synthetic-fixture-broker-credential'
  let terms
  const broker = brokerFixture(cloud, { class3Approval: true, approveRepoPublication: async value => { terms = value; return { approved: true, canonical: value.canonical } }, networkFetch: async (url, init) => {
    assert.equal(init.method, 'GET')
    const commit = { sha: 'b'.repeat(40), parents: [{ sha: 'a'.repeat(40) }], commit: { message: `${terms.binding.message}\n\nX61-Publication: ${terms.publicationDigest}\nX61-Request: ${createHash('sha256').update(terms.binding.idempotencyKey).digest('hex')}` } }
    if (url.endsWith('/commits/' + 'b'.repeat(40))) return Response.json({ ...commit, files: [{ filename: fixturePublication().path, status: 'modified' }, { filename: 'mirror/home/auma/memory/note.md', status: 'added' }] })
    return Response.json([commit])
  } })
  assert.equal((await body(await broker.request('/_host/repo', fixturePublication()))).code, 'REPO_REPLAY_CONFLICT')
  assert.equal(broker.calls.length, 2)
})

test('cloud brokers reject structured signing secrets, oversized upstream bodies and token echoes in metadata IDs', async t => {
  const cloud = await fixture(t)
  await cloud.bootstrap()
  await publishFixtureMirror(cloud, [['/dsh/home/auma/innocuous.json', fixtureMirrorFile(JSON.stringify({ seedHex: 'a'.repeat(64) }))]])
  const broker = brokerFixture(cloud)
  assert.equal((await body(await broker.request('/_host/repo', { action: 'read', path: 'mirror/home/auma/innocuous.json' }))).code, 'BROKER_PRIVATE_CONTENT_REFUSED')
  assert.equal(cloudRepoMirrorPathAllowed('/dsh/home/auma/seed/checkpoint-key.v1.json'), false)
  cloud.env.GITHUB_TOKEN = 'synthetic-fixture-broker-credential'
  const oversized = brokerFixture(cloud, { networkFetch: async () => Response.json({ data: 'x'.repeat(CLOUD_BROKER_LIMITS.responseBytes) }) })
  assert.equal((await oversized.request('/_host/repo', { action: 'log' })).status, 413)
  cloud.env.CLOUDFLARE_API_TOKEN = 'synthetic-cloudflare-credential'
  cloud.env.CLOUDFLARE_ACCOUNT_ID = 'a'.repeat(32)
  const echo = brokerFixture(cloud, { networkFetch: async () => Response.json({ success: true, result: { items: [{ id: cloud.env.CLOUDFLARE_API_TOKEN }] } }) })
  const rejected = await body(await echo.request('/_host/cloudflare', { action: 'versions', remote: true }))
  assert.equal(rejected.code, 'BROKER_PRIVATE_CONTENT_REFUSED')
  assert.equal(JSON.stringify(rejected).includes(cloud.env.CLOUDFLARE_API_TOKEN), false)
})

async function rejectedMirrorMutation(cloud, entries, seq) {
  const { lineageId, revision } = await body(await cloud.request('/_mirror/status?compact=1'))
  const batch = { clientId: FIXTURE_MIRROR_CLIENT, id: `${FIXTURE_MIRROR_CLIENT}:${seq}`, seq, cloudBase: { lineageId, revision }, entries }
  const before = cloud.mirrorStorage.snapshot()
  const response = await cloud.request('/_mirror/delta', { v: 2, batch, digest: await mirrorDigest(batch) })
  assert.equal(response.status, 409)
  assert.equal((await body(response)).code, 'MIRROR_HISTORY_APPEND_ONLY')
  assert.deepEqual(cloud.mirrorStorage.snapshot(), before)
}

test('cloud mirror journal appends preserve byte prefixes across base64 padding and chunk boundaries', async t => {
  for (const length of [1, 2, 3, 73727, 73728, 73729]) {
    const cloud = await fixture(t)
    await cloud.bootstrap()
    const path = '/dsh/home/auma/seed/receipts.v3.jsonl', original = 'x'.repeat(length), appended = original + 'tail'
    await publishFixtureMirror(cloud, [[path, fixtureMirrorFile(original)]])
    await publishFixtureMirror(cloud, [[path, fixtureMirrorFile(appended)]], 2)
    await rejectedMirrorMutation(cloud, [[path, fixtureMirrorFile('y' + appended.slice(1))]], 3)
    await rejectedMirrorMutation(cloud, [[path, fixtureMirrorFile(appended.slice(0, -1))]], 3)
    await rejectedMirrorMutation(cloud, [[path, { kind: 'gone' }]], 3)
    await rejectedMirrorMutation(cloud, [['/dsh/home/auma/seed', { kind: 'gone' }]], 3)
    await publishFixtureMirror(cloud, [['/dsh/home/auma/seed', { kind: 'gone' }], [path, fixtureMirrorFile(appended + 'again')]], 3)
  }
})

test('cloud mirror checkpoints are append-only and committed hash-addressed DAG nodes are immutable', async t => {
  const cloud = await fixture(t)
  await cloud.bootstrap()
  const checkpoint = '/dsh/home/auma/seed/checkpoints.v1.jsonl', node = '/dsh/home/auma/memory/dag/nodes/' + 'a'.repeat(64) + '.json'
  await publishFixtureMirror(cloud, [[checkpoint, fixtureMirrorFile('first')], [node, fixtureMirrorFile('node')]])
  await publishFixtureMirror(cloud, [[checkpoint, fixtureMirrorFile('firstsecond')], [node, fixtureMirrorFile('node')]], 2)
  await rejectedMirrorMutation(cloud, [[checkpoint, fixtureMirrorFile('replacement')]], 3)
  await rejectedMirrorMutation(cloud, [[node, fixtureMirrorFile('edit')]], 3)
  await rejectedMirrorMutation(cloud, [[node, fixtureMirrorFile('nodeappend')]], 3)
  await rejectedMirrorMutation(cloud, [['/dsh/home/auma/memory/dag', { kind: 'gone' }]], 3)
  await publishFixtureMirror(cloud, [[node, { kind: 'gone' }], [node, fixtureMirrorFile('node')]], 3)
})

async function publishFixtureMirror(cloud, entries, seq = 1) {
  const { lineageId, revision } = await body(await cloud.request('/_mirror/status?compact=1'))
  const batch = { clientId: FIXTURE_MIRROR_CLIENT, id: `${FIXTURE_MIRROR_CLIENT}:${seq}`, seq, cloudBase: { lineageId, revision }, entries }
  const response = await cloud.request('/_mirror/delta', { v: 2, batch, digest: await mirrorDigest(batch) })
  const result = await body(response)
  assert.equal(response.status, 200, JSON.stringify(result))
  return result
}

function observeMirrorStorage(storage, observe) {
  const transaction = storage.transaction.bind(storage)
  storage.transaction = operation => transaction(tx => operation({ ...tx,
    get: async key => { await observe('get', key); return tx.get(key) },
    list: async options => { await observe('list', options?.prefix ?? ''); return tx.list(options) },
  }))
  return () => { storage.transaction = transaction }
}

test('mirror compact status authenticates, requires bootstrap and reads only fence metadata', async t => {
  const cloud = await fixture(t)
  assert.equal((await cloud.request('/_mirror/status?compact=1', undefined, { headers: { cookie: null, 'x-x6-internal-authorized': '1' } })).status, 401)
  assert.equal((await cloud.request(SNAPSHOT_ROUTE, undefined, { headers: { cookie: null, 'x-x6-internal-authorized': '1', 'if-none-match': '*' } })).status, 401)
  assert.equal((await cloud.request('/_mirror/status?compact=1')).status, 503)
  assert.equal((await cloud.request(SNAPSHOT_ROUTE)).status, 503)
  await cloud.bootstrap()
  await publishFixtureMirror(cloud, [['/dsh/home/private-fixture.txt', fixtureMirrorFile('fixture body')]])
  const full = await body(await cloud.request('/_mirror/status'))
  assert.deepEqual(full.homeFiles, ['private-fixture.txt'])
  const before = cloud.mirrorStorage.snapshot()
  const restore = observeMirrorStorage(cloud.mirrorStorage, (kind, key) => {
    assert.notEqual(kind, 'list', 'Compact status must not inventory paths or payloads')
    assert.ok(['mirror:bootstrap:v1', 'mirror:v2:global-fence'].includes(key))
  })
  t.after(restore)
  const response = await cloud.request('/_mirror/status?compact=1')
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  const status = await body(response)
  assert.equal(status.revision, 2)
  assert.deepEqual(Object.keys(status).sort(), ['lineageId', 'ok', 'protocol', 'revision', 'runtime', 'snapshotETag', 'snapshotFormat'].sort())
  assert.match(status.snapshotETag, /^"x61-mirror-snapshot-v2:/)
  assert.deepEqual(cloud.mirrorStorage.snapshot(), before)
  for (const route of ['/_mirror/status?compact=0', '/_mirror/status?compact=1&compact=1', '/_mirror/status?other=1', '/_mirror/status#fragment']) {
    assert.equal((await cloud.request(route)).status, 400)
  }
  assert.equal((await cloud.request('/_mirror/status?compact=1', {})).status, 405)
  assert.equal((await cloud.request('/_mirror/status?compact=1', undefined, { headers: { 'content-length': '1' } })).status, 400)
})

test('mirror snapshot ETags skip unchanged payloads and reject stale preconditions without losing resets', async t => {
  const cloud = await fixture(t)
  await cloud.bootstrap()
  await publishFixtureMirror(cloud, [['/dsh/home/fixture.txt', fixtureMirrorFile('first')]])
  const response = await cloud.request(SNAPSHOT_ROUTE)
  t.after(() => response.body?.cancel().catch(() => {}))
  const saved = await response.json()
  const etag = response.headers.get('etag')
  assert.equal(saved.revision, 2)
  assert.equal(etag, (await body(await cloud.request('/_mirror/status?compact=1'))).snapshotETag)
  const before = cloud.mirrorStorage.snapshot()
  const restore = observeMirrorStorage(cloud.mirrorStorage, (kind, key) => {
    assert.ok(!key.startsWith('mirror:v2:chunk:'))
    assert.ok(!(kind === 'list' && key === 'mirror:v2:entry:'))
  })
  try {
    for (const condition of [etag, `"other", W/${etag}`, '*']) {
      const unchanged = await cloud.request(SNAPSHOT_ROUTE, undefined, { headers: { 'if-none-match': condition } })
      assert.equal(unchanged.status, 304)
      assert.equal(unchanged.body, null)
      assert.equal(unchanged.headers.get('etag'), etag)
    }
    for (const condition of ['"stale"', `W/${etag}`]) {
      const refused = await cloud.request(SNAPSHOT_ROUTE, undefined, { headers: { 'if-match': condition } })
      assert.equal(refused.status, 412)
      assert.equal((await body(refused)).code, 'MIRROR_SNAPSHOT_PRECONDITION_FAILED')
    }
    assert.deepEqual(cloud.mirrorStorage.snapshot(), before)
  } finally { restore() }
  await publishFixtureMirror(cloud, [['/dsh/home/fixture.txt', { kind: 'gone' }]], 2)
  assert.equal((await cloud.request('/api/snapshot', undefined, { headers: { 'if-none-match': '*' } })).status, 409)
  const current = await cloud.request(SNAPSHOT_ROUTE, undefined, { headers: { 'if-none-match': etag } })
  const snapshot = await current.json()
  assert.equal(current.status, 200)
  assert.notEqual(current.headers.get('etag'), etag)
  assert.deepEqual(snapshot.resetPaths, ['/dsh/home/fixture.txt'])
  assert.deepEqual(snapshot.entries, [])
})

test('mirror stalled snapshots do not block status or writes and error before mixing revised chunks', async t => {
  const cloud = await fixture(t)
  await cloud.bootstrap()
  const original = fixtureMirrorFile('a'.repeat(180000)), replacement = fixtureMirrorFile('b'.repeat(180000))
  await publishFixtureMirror(cloud, [['/dsh/home/fixture.txt', original]])
  const response = await cloud.request(SNAPSHOT_ROUTE)
  const reader = response.body.getReader()
  t.after(() => reader.cancel().catch(() => {}))
  let partial = ''
  for (;;) {
    const part = await reader.read()
    assert.equal(part.done, false)
    partial += new TextDecoder().decode(part.value)
    if (part.value.byteLength === 96 * 1024) break
  }
  const committed = await publishFixtureMirror(cloud, [['/dsh/home/fixture.txt', replacement]], 2)
  assert.equal(committed.revision, 3)
  await assert.rejects(reader.read(), error => error.code === 'MIRROR_SNAPSHOT_CHANGED')
  await assert.rejects(response.mirrorCompletion, error => error.code === 'MIRROR_SNAPSHOT_CHANGED')
  assert.throws(() => JSON.parse(partial))
  assert.ok(!partial.includes(replacement.b64.slice(0, 100)))
  const fresh = await (await cloud.request(SNAPSHOT_ROUTE)).json()
  assert.equal(fresh.revision, 3)
  assert.equal(fresh.entries[0][1].b64, replacement.b64)
})

test('mirror metadata-only snapshots recheck revision before the final JSON closure', async t => {
  const cloud = await fixture(t)
  await cloud.bootstrap()
  await publishFixtureMirror(cloud, [['/dsh/home/fixture', { kind: 'dir', mode: 0o700 }]])
  const response = await cloud.request(SNAPSHOT_ROUTE)
  const reader = response.body.getReader()
  t.after(() => reader.cancel().catch(() => {}))
  let partial = ''
  for (let index = 0; index < 4; index++) partial += new TextDecoder().decode((await reader.read()).value)
  assert.ok(partial.endsWith(']'))
  await publishFixtureMirror(cloud, [['/dsh/home/fixture', { kind: 'gone' }]], 2)
  await assert.rejects(reader.read(), error => error.code === 'MIRROR_SNAPSHOT_CHANGED')
  assert.throws(() => JSON.parse(partial))
})

test('mirror snapshot reader capacity leaves compact and conditional reads available', async t => {
  const cloud = await fixture(t)
  await cloud.bootstrap()
  const responses = []
  t.after(async () => { for (const response of responses) await response.body?.cancel().catch(() => {}) })
  for (let index = 0; index < MIRROR_LIMITS.snapshotReaders; index++) responses.push(await cloud.request(SNAPSHOT_ROUTE))
  const saturated = await cloud.request(SNAPSHOT_ROUTE)
  assert.equal(saturated.status, 503)
  assert.equal((await body(saturated)).code, 'MIRROR_SNAPSHOT_BUSY')
  const status = await body(await cloud.request('/_mirror/status?compact=1'))
  assert.equal((await cloud.request(SNAPSHOT_ROUTE, undefined, { headers: { 'if-none-match': status.snapshotETag } })).status, 304)
  for (const response of responses) await response.body.cancel()
  const fresh = await cloud.request(SNAPSHOT_ROUTE)
  assert.equal(fresh.status, 200)
  await fresh.json()
})

test('mirror snapshot deadline and request cancellation terminate idle bodies without blocking later reads', async t => {
  const cloud = await fixture(t)
  await cloud.bootstrap()
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const timed = await cloud.request(SNAPSHOT_ROUTE)
  t.after(() => timed.body?.cancel().catch(() => {}))
  t.mock.timers.tick(MIRROR_LIMITS.snapshotTimeoutMs)
  await assert.rejects(timed.text(), error => error.code === 'MIRROR_SNAPSHOT_TIMEOUT')
  await assert.rejects(timed.mirrorCompletion, error => error.code === 'MIRROR_SNAPSHOT_TIMEOUT')
  const controller = new AbortController()
  const aborted = await cloud.request(SNAPSHOT_ROUTE, undefined, { signal: controller.signal })
  t.after(() => aborted.body?.cancel().catch(() => {}))
  controller.abort()
  await assert.rejects(aborted.text(), error => error.code === 'MIRROR_SNAPSHOT_ABORTED')
  const fresh = await cloud.request(SNAPSHOT_ROUTE)
  assert.equal(fresh.status, 200)
  await fresh.json()
})

test('mirror snapshot deadline errors a stalled chunk read and retains its slot until storage settles', async t => {
  const cloud = await fixture(t)
  await cloud.bootstrap()
  await publishFixtureMirror(cloud, [['/dsh/home/fixture.txt', fixtureMirrorFile('fixture')]])
  const entered = Promise.withResolvers(), unblock = Promise.withResolvers()
  const restore = observeMirrorStorage(cloud.mirrorStorage, async (kind, key) => {
    if (kind === 'get' && key.startsWith('mirror:v2:chunk:')) { entered.resolve(); await unblock.promise }
  })
  t.after(restore)
  t.after(() => unblock.resolve())
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const response = await cloud.request(SNAPSHOT_ROUTE)
  const pending = response.text()
  try {
    await entered.promise
    const rejected = assert.rejects(pending, error => error.code === 'MIRROR_SNAPSHOT_TIMEOUT')
    t.mock.timers.tick(MIRROR_LIMITS.snapshotTimeoutMs)
    await rejected
    assert.equal(cloud.mirror.snapshotReaders, 1)
  } finally { unblock.resolve() }
  await cloud.mirrorStorage.idle()
  restore()
  const fresh = await cloud.request(SNAPSHOT_ROUTE)
  assert.equal(fresh.status, 200)
  assert.equal((await fresh.json()).entries[0][1].b64, fixtureMirrorFile('fixture').b64)
})

test('mirror near-limit metadata remains readable after chunk counters persist and excess writes are atomic', async t => {
  const cloud = await fixture(t)
  await cloud.bootstrap()
  const entries = [], segments = []
  let bytes = Buffer.byteLength('[]')
  for (let index = 0; index < 15; index++) {
    segments.push('p'.repeat(250))
    const entry = ['/dsh/home/' + segments.join('/'), { kind: 'dir', mode: 0o700 }]
    bytes += Buffer.byteLength(JSON.stringify(entry))
    entries.push(entry)
  }
  const parent = entries.at(-1)[0]
  let omitted
  for (let index = 0; ; index++) {
    const name = `${parent}/${'f'.repeat(240)}${String(index).padStart(5, '0')}`
    const wire = fixtureMirrorFile('')
    const { b64, ...metadata } = wire
    const amount = Buffer.byteLength(JSON.stringify([name, metadata]))
    if (bytes + amount > MIRROR_LIMITS.metadataBytes) { omitted = [name, wire]; break }
    bytes += amount
    entries.push([name, wire])
  }
  await publishFixtureMirror(cloud, entries)
  const before = cloud.mirrorStorage.snapshot()
  const storedBytes = [...before].filter(([key]) => key.startsWith('mirror:v2:entry:')).reduce((total, [, { path: name, ...metadata }]) => total + Buffer.byteLength(JSON.stringify([name, metadata])), 0)
  assert.ok(storedBytes > MIRROR_LIMITS.metadataBytes, 'Fixture must cross the wire-to-storage metadata overhead gap')
  cloud.recreate()
  const snapshot = await cloud.request(SNAPSHOT_ROUTE)
  assert.equal(snapshot.status, 200)
  assert.deepEqual((await snapshot.json()).entries, entries)
  const { lineageId, revision } = await body(await cloud.request('/_mirror/status?compact=1'))
  const batch = { clientId: FIXTURE_MIRROR_CLIENT, id: `${FIXTURE_MIRROR_CLIENT}:2`, seq: 2, cloudBase: { lineageId, revision }, entries: [omitted] }
  const refused = await cloud.request('/_mirror/delta', { v: 2, batch, digest: await mirrorDigest(batch) })
  assert.equal(refused.status, 413)
  assert.equal((await body(refused)).code, 'MIRROR_METADATA_LIMIT')
  assert.deepEqual(cloud.mirrorStorage.snapshot(), before)
  const shrunk = await publishFixtureMirror(cloud, [[parent, { kind: 'gone' }]], 2)
  assert.equal(shrunk.revision, revision + 1)
  const remaining = await (await cloud.request(SNAPSHOT_ROUTE)).json()
  assert.deepEqual(remaining.resetPaths, [parent])
  assert.equal(remaining.entries.length, 14)
})

// Encode a fixed, public fixture identifier. No signing key or real contact is created.
function fixtureNpub() {
  const alphabet = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'
  const words = []
  let accumulator = 0, bits = 0
  for (const byte of new Uint8Array(32).fill(17)) {
    accumulator = (accumulator << 8) | byte; bits += 8
    while (bits >= 5) { bits -= 5; words.push((accumulator >>> bits) & 31) }
  }
  if (bits) words.push((accumulator << (5 - bits)) & 31)
  const hrp = [...'npub'].map(char => char.charCodeAt(0))
  const values = [...hrp.map(byte => byte >>> 5), 0, ...hrp.map(byte => byte & 31), ...words, 0, 0, 0, 0, 0, 0]
  const generators = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]
  let checksum = 1
  for (const value of values) {
    const top = checksum >>> 25
    checksum = ((checksum & 0x1ffffff) << 5) ^ value
    for (let index = 0; index < 5; index++) if ((top >>> index) & 1) checksum ^= generators[index]
  }
  checksum ^= 1
  return 'npub1' + [...words, ...Array.from({ length: 6 }, (_, index) => (checksum >>> (5 * (5 - index))) & 31)].map(value => alphabet[value]).join('')
}

test('facts aliases require authentication, exact GET requests and bootstrap, then fail closed on missing evidence', async t => {
  const cloud = await fixture(t)
  for (const route of ['/__x6/facts', '/api/x61/facts']) {
    assert.equal((await cloud.request(route, undefined, { headers: { cookie: null } })).status, 401)
    assert.equal((await cloud.request(route, {})).status, 405)
    assert.equal((await cloud.request(route + '?x=1')).status, 404)
    assert.equal((await cloud.request(route)).status, 503)
  }
  await cloud.bootstrap()
  for (const route of ['/__x6/facts', '/api/x61/facts']) {
    const response = await cloud.request(route)
    assert.equal(response.status, 503)
    const value = await body(response)
    assert.equal(value.ok, false); assert.equal(value.runtime, 'cloudflare')
    assert.equal(value.receiptsVerified, null); assert.equal(value.checkpointsTotal, null)
    assert.equal(value.wakeUrgency, null); assert.equal(value.auraStatus, 'incomplete')
    assert.equal(value.ownerApproval, false)
  }
  assert.equal(cloud.assetCalls, 0)
})

test('new message routes enforce authentication, bootstrap and origin before mutation', async t => {
  const cloud = await fixture(t)
  const empty = cloud.headStorage.snapshot()
  for (const headers of [{ cookie: null }, { cookie: 'invalid', 'x-x6-internal-authorized': '1' }]) {
    assert.equal((await cloud.request(CONTACTS, undefined, { headers })).status, 401)
    assert.deepEqual(cloud.headStorage.snapshot(), empty)
  }
  assert.equal((await cloud.request(CONTACTS)).status, 503)
  await cloud.bootstrap()
  const before = cloud.headStorage.snapshot()
  for (const headers of [{ origin: null }, { origin: 'https://other.example.invalid' }, { 'sec-fetch-site': null }, { 'sec-fetch-site': 'cross-site' }]) {
    assert.equal((await cloud.request(SEND, { conversationId: 'fixture', content: 'hello', requestId: 'origin-test' }, { headers })).status, 403)
    assert.deepEqual(cloud.headStorage.snapshot(), before)
  }
  const direct = new Request(ORIGIN + CONTACTS, { headers: { 'x-x6-internal-authorized': '1', 'x-x6-bootstrap-seed': '0'.repeat(64) } })
  assert.equal((await cloud.directHead(direct)).status, 503)
  assert.deepEqual(cloud.headStorage.snapshot(), before)
  assert.equal(cloud.assetCalls, 0)
})

test('real Worker and HeadDO persist honest local channels and idempotent unsigned turns', async t => {
  const cloud = await fixture(t)
  await cloud.bootstrap()
  const response = await cloud.request(CONTACTS)
  assert.equal(response.status, 200)
  const contacts = await body(response)
  assert.equal(contacts.identity.npub, null)
  assert.equal(contacts.identity.pubkey, null)
  assert.equal(contacts.relay.connected, false)
  assert.deepEqual(contacts.relay.urls, [])
  assert.ok(contacts.conversations.length >= 2)
  for (const row of contacts.conversations) { assert.equal(row.sample, false); assert.equal(row.tier, 'microverse-local'); assert.equal(row.mls, null) }
  const conversationId = contacts.conversations[0].id
  const input = { conversationId, content: 'Synthetic local note.', requestId: 'fixture-send-1' }
  assert.equal((await body(await cloud.request(SEND, input))).code, 'CLASS3_WEBAUTHN_REQUIRED')
  const sent = await cloud.approvedRequest(SEND, input)
  assert.ok([200, 201].includes(sent.status))
  const result = await body(sent)
  const event = result.event ?? result.turn
  assert.equal(event.content, input.content)
  assert.equal(event.delivery, 'microverse-local')
  assert.equal(event.sig, null)
  assert.equal(event.pubkey, null)
  assert.equal(event.signatureStatus, 'unavailable')
  assert.equal(event.kind, 30078)
  assert.ok(Number.isSafeInteger(event.created_at))
  assert.ok(Array.isArray(event.tags))
  assert.equal(event.idScheme, 'aukora.messages.local/v1')
  const replayToken = await cloud.issueClass3(SEND, input), beforeReplay = cloud.headStorage.snapshot()
  const replay = await body(await cloud.request(SEND, input, { headers: { 'x-x6-class3-approval': replayToken } }))
  assert.deepEqual(replay.event ?? replay.turn, event)
  const afterReplay = cloud.headStorage.snapshot(), expectedReplay = clone(beforeReplay)
  const approvalState = expectedReplay.get(AUMLOK_STORAGE_KEY), afterApproval = afterReplay.get(AUMLOK_STORAGE_KEY)
  const tokenHash = createHash('sha256').update(replayToken).digest('hex')
  const consumed = afterApproval.approvals.find(value => value.tokenHash === tokenHash)
  assert.ok(Number.isSafeInteger(consumed.consumedAt) && consumed.consumedAt >= consumed.approvedAt && consumed.consumedAt < consumed.expiresAt)
  approvalState.approvals.find(value => value.tokenHash === tokenHash).consumedAt = consumed.consumedAt
  const auditRecord = afterApproval.attempts.at(-1)
  assert.equal(auditRecord.purpose, 'consume-approval'); assert.equal(auditRecord.outcome, 'VERIFIED')
  assert.equal(auditRecord.sequence, approvalState.audit.totalRecords + 1)
  assert.equal(auditRecord.at, consumed.consumedAt)
  approvalState.attempts.push(auditRecord)
  approvalState.audit.totalRecords++
  approvalState.audit.latestHash = createHash('sha256').update('aukora.aumlok.audit.v1\0' + approvalState.audit.latestHash + '\0' + canonicalJson(auditRecord)).digest('hex')
  assert.deepEqual(afterReplay, expectedReplay, 'Replay changes only its fresh approval and the verified consumption audit')
  const conflict = { ...input, content: 'conflicting content' }, conflictToken = await cloud.issueClass3(SEND, conflict)
  const beforeConflict = cloud.headStorage.snapshot()
  assert.equal((await cloud.request(SEND, conflict, { headers: { 'x-x6-class3-approval': conflictToken } })).status, 409)
  assert.deepEqual(cloud.headStorage.snapshot(), beforeConflict)
  assert.ok((await cloud.request(SEND, { conversationId, content: 'missing replay key' })).status >= 400)
  cloud.recreate()
  const thread = await body(await cloud.request(THREAD, { conversationId }))
  assert.deepEqual(thread.turns, [event])
  assert.equal(cloud.assetCalls, 0)
})

test('contact and group metadata persist without implying a relay or MLS session', async t => {
  const cloud = await fixture(t)
  await cloud.bootstrap()
  const contact = { kind: 'contact', name: 'Fixture contact', npub: fixtureNpub() }
  const addedResponse = await cloud.request(ADD, contact)
  assert.ok([200, 201].includes(addedResponse.status))
  const added = await body(addedResponse)
  assert.equal(added.conversation.tier, 'microverse-local')
  const saved = cloud.headStorage.snapshot()
  assert.deepEqual((await body(await cloud.request(ADD, contact))).conversation, added.conversation)
  assert.deepEqual(cloud.headStorage.snapshot(), saved)
  assert.ok((await cloud.request(ADD, { ...contact, npub: contact.npub.slice(0, -1) + (contact.npub.endsWith('q') ? 'p' : 'q') })).status >= 400)
  assert.deepEqual(cloud.headStorage.snapshot(), saved)
  const group = await body(await cloud.request(ADD, { kind: 'marmot-group', name: 'Fixture group', memberNpubs: [fixtureNpub()] }))
  assert.equal(group.conversation.tier, 'microverse-local')
  assert.equal(group.conversation.mls, null)
  assert.notEqual(group.conversation.protocol, 'marmot-mls')
  assert.ok((await cloud.request(ADD, { ...contact, relayAck: true })).status >= 400)
})

test('message routes reject oversized bodies, corrupt stores and repeated-key conflicts without partial effects', async t => {
  const cloud = await fixture(t)
  await cloud.bootstrap()
  await cloud.request(CONTACTS)
  const before = cloud.headStorage.snapshot()
  assert.equal((await cloud.request(SEND, ' '.repeat(16385))).status, 413)
  assert.deepEqual(cloud.headStorage.snapshot(), before)
  for (const route of [CONTACTS + '?extra=1', '/aukora-messages/unknown']) {
    assert.ok((await cloud.request(route)).status >= 400)
    assert.equal(cloud.assetCalls, 0)
  }
  await cloud.headStorage.transaction(tx => tx.put('messages:v1', { schema: 'corrupt' }))
  const corrupt = cloud.headStorage.snapshot()
  assert.equal((await cloud.request(CONTACTS)).status, 503)
  assert.deepEqual(cloud.headStorage.snapshot(), corrupt)
})

test('both status aliases return only unverified prediction projections from the designated mirror journal', async t => {
  const receipts = [
    { schema: 'aukora.receipt.v3', seq: 1, kind: 'prediction.register', prevHash: '0'.repeat(64), leafHash: 'a'.repeat(64), data: { predictionId: 'fixture', metric: 'organ-count', expected: 3, targetBallId: 'b'.repeat(64), targetEpoch: 2 } },
    { schema: 'aukora.receipt.v3', seq: 2, kind: 'prediction.observe', prevHash: 'a'.repeat(64), leafHash: 'c'.repeat(64), data: { predictionId: 'fixture', metric: 'organ-count', observed: 4, surpriseScore: 100, secretExtra: 'must not project' } },
  ].map(value => JSON.stringify(value)).join('\n') + '\n'
  const cloud = await fixture(t, { receipts })
  await cloud.bootstrap()
  for (const route of ['/__x6/status', '/api/x61/status']) {
    const response = await cloud.request(route)
    assert.equal(response.status, 200)
    const result = await body(response)
    assert.equal(result.head.ballId, cloud.ball.ballId)
    assert.equal(result.head.epoch, 1)
    assert.equal(result.prediction.verified, false)
    assert.equal(result.prediction.surpriseScore, null)
    assert.ok(result.prediction.latest.register)
    assert.ok(result.prediction.latest.observe)
    assert.ok(!JSON.stringify(result).includes('must not project'))
  }
  assert.equal(projectPredictionReceipts('{broken').ok, false)
  assert.equal(projectPredictionReceipts('x'.repeat(1024 * 1024 + 1)).ok, false)
})

async function temporaryRoot(t) {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'x61-messages-fixture-'))
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 }))
  await fs.chmod(root, 0o700)
  return root
}

function localRequest(storage, pathname, input) {
  return handleMessagesRequest(new Request(ORIGIN + pathname, { method: input === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json' }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) }), storage, { authorized: true })
}

test('local adapter persists across instances, serializes concurrent operations and preserves corrupt state', async t => {
  const root = await temporaryRoot(t)
  const directory = path.join(root, 'messages')
  let storage = createLocalMessagesStorage({ directory })
  const contacts = await body(await localRequest(storage, CONTACTS))
  const conversationId = contacts.conversations[0].id
  const input = { conversationId, content: 'Fixture-only disk note.', requestId: 'disk-1' }
  const results = await Promise.all(Array.from({ length: 4 }, () => localRequest(storage, SEND, input)))
  for (const response of results) assert.ok([200, 201].includes(response.status))
  storage = createLocalMessagesStorage({ directory })
  const thread = await body(await localRequest(storage, THREAD, { conversationId }))
  assert.equal(thread.turns.length, 1)
  assert.equal(thread.turns[0].content, input.content)
  await storage.transaction(tx => tx.put('messages:v1', { invalid: true }))
  assert.equal((await localRequest(storage, CONTACTS)).status, 503)
})

test('local storage and receipt readers refuse links without following fixture targets', async t => {
  const root = await temporaryRoot(t)
  const target = path.join(root, 'target')
  await fs.mkdir(target, { mode: 0o700 })
  const alias = path.join(root, 'alias')
  await fs.symlink(target, alias, 'dir')
  const storage = createLocalMessagesStorage({ directory: alias })
  assert.equal((await localRequest(storage, CONTACTS)).status, 503)
  assert.deepEqual(await fs.readdir(target), [])
  const mirrorDirectory = path.join(root, 'mirror')
  await fs.mkdir(path.join(mirrorDirectory, 'home', 'auma', 'seed'), { recursive: true, mode: 0o700 })
  const journal = path.join(mirrorDirectory, 'home', 'auma', 'seed', 'receipts.v3.jsonl')
  const fixtureFile = path.join(root, 'fixture-journal.jsonl')
  await fs.writeFile(fixtureFile, '{}\n', { mode: 0o600 })
  await fs.symlink(fixtureFile, journal)
  const result = await readLocalPredictionStatus({ mirrorDirectory })
  assert.equal(result.ok, false)
  assert.equal(await fs.readFile(fixtureFile, 'utf8'), '{}\n')
})

test('the shared local HTTP dispatcher uses exact routes and real capability rather than origin alone', async () => {
  const origin = 'http://127.0.0.1:4610'
  const capability = 'synthetic-fixture-capability'
  const storage = memoryStorage()
  const handler = createLocalMessagesRequestHandler({
    storage, sessionCapability: capability, allowedOrigins: new Set([origin]),
    verifyHostAndOrigin: () => ({ ok: true }), readStatus: async () => ({ ok: true, fixture: true }),
  })
  const invoke = (pathname, input, overrides = {}) => {
    const request = Readable.from(input === undefined ? [] : [Buffer.from(typeof input === 'string' ? input : JSON.stringify(input))])
    request.method = overrides.method ?? (input === undefined ? 'GET' : 'POST')
    request.headers = { host: '127.0.0.1:4610', origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', cookie: '__x6_cap=' + capability, ...overrides.headers }
    return handler(request, new URL(pathname, origin))
  }
  assert.equal((await invoke(CONTACTS, undefined, { headers: { cookie: '' } })).status, 403)
  assert.equal((await invoke(CONTACTS + '?cap=' + capability, undefined, { headers: { cookie: '' } })).status, 403)
  assert.equal(storage.snapshot().size, 0)
  const contacts = await body(await invoke(CONTACTS))
  assert.ok(contacts.conversations.length)
  const before = storage.snapshot()
  const input = { conversationId: contacts.conversations[0].id, content: 'Local dispatch fixture', requestId: 'dispatch-1' }
  assert.equal((await invoke(SEND, input, { headers: { origin: undefined } })).status, 403)
  assert.deepEqual(storage.snapshot(), before)
  assert.equal((await invoke('/aukora-messages/contacts')).status, 404)
  assert.equal((await invoke('/aukora-messages/addcontact', {})).status, 404)
  assert.equal((await invoke(ADD, { kind: 'contact', name: 'Fixture', npub: fixtureNpub() })).status, 200)
  assert.equal((await invoke(SEND, input)).status, 200)
  assert.equal((await body(await invoke(THREAD, { conversationId: input.conversationId }))).turns.length, 1)
  const headerOnly = { conversationId: input.conversationId, content: 'Header replay fixture' }
  assert.equal((await invoke(SEND, headerOnly, { headers: { 'idempotency-key': 'header-id-1' } })).status, 200)
  assert.equal((await invoke(SEND, headerOnly, { headers: { 'idempotency-key': 'header-id-1' } })).status, 200)
  const afterHeader = storage.snapshot()
  assert.equal((await invoke(SEND, { ...headerOnly, requestId: 'body-key' }, { headers: { 'idempotency-key': 'different-key' } })).status, 409)
  assert.deepEqual(storage.snapshot(), afterHeader)
  assert.equal((await invoke(SEND, 'x'.repeat(16385))).status, 413)
  assert.equal((await invoke('/__x6/status')).status, 200)
  assert.equal(await invoke('/unrelated'), null)
})

test('message capacity fails without eviction and exact earlier retries still succeed', async () => {
  const storage = memoryStorage()
  const contacts = await body(await localRequest(storage, CONTACTS))
  const conversationId = contacts.conversations[0].id
  const first = { conversationId, content: 'f'.repeat(4096), requestId: 'capacity-first' }
  const original = await body(await localRequest(storage, SEND, first))
  let full = false
  for (let index = 0; index < 100; index++) {
    const before = storage.snapshot()
    const response = await localRequest(storage, SEND, { conversationId, content: 'x'.repeat(4096), requestId: 'capacity-' + index })
    if (response.status === 507) { assert.deepEqual(storage.snapshot(), before); full = true; break }
    assert.equal(response.status, 200)
  }
  assert.equal(full, true)
  const saved = storage.snapshot()
  const replay = await body(await localRequest(storage, SEND, first))
  assert.deepEqual(replay.event ?? replay.turn, original.event ?? original.turn)
  assert.deepEqual(storage.snapshot(), saved)
})

test('distinct local adapters and persisted locks refuse overlapping writers without deleting the lock', async t => {
  const root = await temporaryRoot(t)
  const directory = path.join(root, 'messages')
  const first = createLocalMessagesStorage({ directory }), second = createLocalMessagesStorage({ directory })
  await localRequest(first, CONTACTS)
  let release, entered
  const blocked = new Promise(resolve => { release = resolve })
  const ready = new Promise(resolve => { entered = resolve })
  const holding = first.transaction(async tx => { await tx.get('messages:v1'); entered(); await blocked })
  try {
    await ready
    assert.equal((await localRequest(second, CONTACTS)).status, 423)
  } finally { release(); await holding }
  assert.equal((await localRequest(second, CONTACTS)).status, 200)
  const lock = path.join(directory, 'WRITE.lock')
  await fs.writeFile(lock, 'fixture-crashed-writer\n', { flag: 'wx', mode: 0o600 })
  assert.equal((await localRequest(first, CONTACTS)).status, 423)
  assert.equal(await fs.readFile(lock, 'utf8'), 'fixture-crashed-writer\n')
})

test('a failed local transaction or rename does not replace saved state', async t => {
  const root = await temporaryRoot(t)
  const directory = path.join(root, 'messages')
  const storage = createLocalMessagesStorage({ directory })
  const contacts = await body(await localRequest(storage, CONTACTS))
  const stateFile = path.join(directory, 'messages.v1.json')
  const original = await fs.readFile(stateFile, 'utf8')
  await assert.rejects(storage.transaction(async tx => { await tx.put('messages:v1', { invalid: 'fixture' }); throw new Error('Fixture callback failed') }))
  assert.equal(await fs.readFile(stateFile, 'utf8'), original)
  // The mock is restricted to this test's own target and restored before inspecting output.
  const nativeRename = fs.rename.bind(fs)
  let failures = 0
  const mocked = t.mock.method(fs, 'rename', async (source, target) => {
    if (target === stateFile) { failures++; throw Object.assign(new Error('Fixture rename failure'), { code: 'EIO' }) }
    return nativeRename(source, target)
  })
  try {
    const response = await localRequest(storage, SEND, { conversationId: contacts.conversations[0].id, content: 'Must not commit', requestId: 'failed-rename' })
    assert.equal(response.status, 503)
  } finally { mocked.mock.restore() }
  assert.equal(failures, 1)
  assert.equal(await fs.readFile(stateFile, 'utf8'), original)
  assert.equal((await fs.readdir(directory)).includes('WRITE.lock'), true)
  assert.equal((await localRequest(storage, CONTACTS)).status, 423)
})

test('uncertain post-rename durability preserves the lock and never acknowledges success', async t => {
  const root = await temporaryRoot(t)
  const directory = path.join(root, 'messages')
  const storage = createLocalMessagesStorage({ directory })
  const contacts = await body(await localRequest(storage, CONTACTS))
  const nativeOpen = fs.open.bind(fs)
  let failures = 0
  const mocked = t.mock.method(fs, 'open', async (file, ...args) => {
    const handle = await nativeOpen(file, ...args)
    if (file === directory) {
      const nativeSync = handle.sync.bind(handle)
      let syncs = 0
      handle.sync = async () => {
        if (++syncs === 2) { failures++; throw Object.assign(new Error('Fixture durability failure'), { code: 'EIO' }) }
        return nativeSync()
      }
    }
    return handle
  })
  const input = { conversationId: contacts.conversations[0].id, content: 'Uncertain fixture commit', requestId: 'uncertain-durability' }
  try { assert.equal((await localRequest(storage, SEND, input)).status, 503) }
  finally { mocked.mock.restore() }
  assert.equal(failures, 1)
  assert.ok((await fs.readdir(directory)).includes('WRITE.lock'))
  const before = await fs.readFile(path.join(directory, 'messages.v1.json'), 'utf8')
  assert.equal((await localRequest(storage, SEND, input)).status, 423)
  assert.equal(await fs.readFile(path.join(directory, 'messages.v1.json'), 'utf8'), before)
})

test('real Worker status aliases expose conservative aura without changing head or creating identity', async t => {
  const cloud = await fixture(t)
  await cloud.bootstrap()
  const selected = await cloud.headStorage.get('head')
  for (const route of ['/__x6/status', '/api/x61/status']) {
    const status = await body(await cloud.request(route))
    assert.equal(status.aura.status, 'incomplete'); assert.equal(status.aura.vector, null)
    assert.equal(status.aura.recommendedFocus, 'verify'); assert.ok(status.aura.gaps.length > 0)
    assert.equal(status.aura.ballId, selected); assert.equal(status.wake.aura, null)
    assert.equal(status.wake.enabled, false)
    assert.ok(Object.hasOwn(status, 'nostr'))
  }
  assert.equal(await cloud.headStorage.get('messages:v1'), undefined, 'Status does not initialize message identity/state')
  const tick = await body(await cloud.request('/_host/wake', { action: 'trigger' }))
  assert.equal(tick.receipt.executor.invoked, false)
  for (const route of ['/__x6/status', '/api/x61/status']) {
    const status = await body(await cloud.request(route))
    assert.equal(status.aura.status, 'incomplete'); assert.equal(status.aura.vector, null)
    assert.ok(status.aura.gaps.length > 0)
    assert.equal(status.aura.authorityTier, 'peripheral-hint'); assert.equal(status.aura.ballId, selected)
    assert.equal(status.wake.aura, null)
    assert.equal(status.aura.recommendedFocus, 'verify')
    assert.equal(status.wake.wakeCount, 1)
    assert.equal(JSON.stringify(status).includes('secretKey'), false)
  }
  await cloud.headStorage.transaction(tx => tx.put('aura:latest', { ...tick.aura, authorityTier: 'owner-confirmed' }))
  const afterInvalidHistoricalAura = await body(await cloud.request('/__x6/status'))
  assert.equal(afterInvalidHistoricalAura.wake.aura, null)
  assert.equal(afterInvalidHistoricalAura.aura.status, 'incomplete')
  assert.equal(afterInvalidHistoricalAura.aura.vector, null)
  assert.equal(afterInvalidHistoricalAura.aura.recommendedFocus, 'verify')
  assert.equal(await cloud.headStorage.get('head'), selected)
  assert.equal(await cloud.headStorage.get('messages:v1'), undefined)
})

test('actual HeadDO alarm computes trusted aura and pauses without mutating the selected head', async t => {
  const cloud = await fixture(t)
  await cloud.bootstrap()
  let now = 1700000000000, probes = 0
  const wake = createDurableWakeStore(cloud.headStorage, { now: () => now,
    readAuraInputs: () => ({ reachableDagNodes: 1, declaredDagNodes: 1, verifiedReceipts: 1, totalReceipts: 1, activeOrgans: 1, declaredOrgans: 1,
      observedSurpriseScores: [], handOffEpochMismatch: false, unanchoredPredictions: 0, pendingWakes: 0, lastRollbackAgeEpochs: 3, staleHeartbeatRatio: 0 }),
    runWakeProbe() { probes++; return { status: 'success' } },
  })
  cloud.setWakeStore(wake); t.after(() => wake.dispose())
  await cloud.request('/_host/wake', { action: 'configure', enabled: true, intervalMs: 60000 })
  for (let index = 0; index < 3; index++) {
    now += 60000
    const result = await cloud.alarm()
    assert.equal(result.receipt.status, 'probe_skipped_rest')
  }
  const status = await body(await cloud.request('/api/x61/status'))
  assert.equal(status.aura.authorityTier, 'peripheral-hint'); assert.equal(status.aura.recommendedFocus, 'verify')
  assert.equal(status.aura.status, 'incomplete'); assert.equal(status.aura.vector, null)
  assert.ok(status.aura.gaps.length > 0)
  assert.equal(validateAuraVector(status.wake.aura), true)
  assert.equal(status.wake.aura.recommendedFocus, 'rest')
  assert.equal(status.wake.aura.computedAt, now)
  assert.equal(status.wake.aura.ballId, cloud.ball.ballId)
  assert.equal(status.wake.autoPaused, true); assert.equal(status.wake.enabled, false)
  assert.equal(status.wake.consecutiveUnacknowledgedWakes, 3)
  assert.equal(await cloud.headStorage.getAlarm(), null); assert.equal(probes, 0)
  assert.equal(await cloud.headStorage.get('head'), cloud.ball.ballId)
  assert.equal(await cloud.headStorage.get('owner-grant'), undefined)
})

async function ownerAuthFixture() {
  const at = 2_000_000_000_000
  const keys = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])
  const env = { PUBLIC_HOST: new URL(ORIGIN).host, OWNER_EMAIL: 'owner@example.invalid', OWNER_PUBLIC_KEY_HEX: Buffer.from(await crypto.subtle.exportKey('raw', keys.publicKey)).toString('hex') }
  const claims = { iss: 'aukora.x61.owner', aud: env.PUBLIC_HOST, email: env.OWNER_EMAIL, nbf: at / 1000 - 1, exp: at / 1000 + 600 }
  const sign = async (changes = {}, header = { alg: 'EdDSA', typ: 'JWT' }, key = keys.privateKey, rawClaims = null) => {
    const input = Buffer.from(JSON.stringify(header)).toString('base64url') + '.' + Buffer.from(rawClaims ?? JSON.stringify({ ...claims, ...changes })).toString('base64url')
    return input + '.' + Buffer.from(await crypto.subtle.sign('Ed25519', key, new TextEncoder().encode(input))).toString('base64url')
  }
  return { at, env, claims, sign }
}

test('owner JWT verification rejects wrong keys, algorithms, claims, times and noncanonical encodings without network', async () => {
  const f = await ownerAuthFixture()
  const verify = createAccessVerifier({ now: () => f.at, fetchKeys: () => { throw new Error('No network for owner assertions') } })
  const check = token => verify(new Request(ORIGIN, { headers: { 'x-x6-owner-assertion': token } }), f.env)
  assert.deepEqual(await check(await f.sign()), { email: f.env.OWNER_EMAIL, expires: f.claims.exp, type: 'owner' })
  assert.deepEqual(await check(await f.sign({ exp: f.claims.nbf + 86400 })), { email: f.env.OWNER_EMAIL, expires: f.claims.nbf + 86400, type: 'owner' })
  for (const changes of [
    { iss: 'other' }, { aud: 'other' }, { aud: [f.env.PUBLIC_HOST] }, { email: 'other@example.invalid' },
    { exp: f.at / 1000 }, { nbf: f.at / 1000 + 1 }, { nbf: undefined }, { exp: undefined },
    { exp: '2000000600' }, { nbf: null }, { nbf: 1e308, exp: 1e308 },
    { exp: f.claims.nbf + 86401 }, { exp: f.claims.nbf }, { scope: 'owner-signing' }, { sub: 'owner' }, { iat: f.claims.nbf },
  ]) assert.equal(await check(await f.sign(changes)), null)
  for (const header of [{ alg: 'none', typ: 'JWT' }, { alg: 'HS256', typ: 'JWT' }, { alg: 'RS256', typ: 'JWT' }, { alg: 'EdDSA' }, { alg: 'EdDSA', typ: 'JWT', crit: [] }]) assert.equal(await check(await f.sign({}, header)), null)
  const other = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])
  assert.equal(await check(await f.sign({}, undefined, other.privateKey)), null)
  const token = await f.sign()
  for (const invalid of [token + '=', token + '.extra', token.replace(/.$/, '='), 'a'.repeat(16385), await f.sign({}, undefined, undefined, JSON.stringify(f.claims).replace('{', '{"iss":"wrong",')), await f.sign({}, undefined, undefined, ' ' + JSON.stringify(f.claims))]) assert.equal(await check(invalid), null)
  assert.equal(ownerAccessConfigured(f.env), true)
  for (const env of [{ ...f.env, OWNER_PUBLIC_KEY_HEX: 'bad' }, { ...f.env, OWNER_EMAIL: '' }, { ...f.env, PUBLIC_HOST: 'example.invalid/path' }, { ...f.env, PUBLIC_HOST: 'example.invalid@evil.invalid' }]) assert.equal(ownerAccessConfigured(env), false)
})

test('assertion carriers agree or fail closed without header or cookie precedence', async () => {
  const f = await ownerAuthFixture(), token = await f.sign(), other = await f.sign({ exp: f.claims.exp - 1 })
  const verify = createAccessVerifier({ now: () => f.at })
  for (const headers of [{ 'cf-access-jwt-assertion': token }, { 'x-x6-owner-assertion': token }, { cookie: `unrelated=value; CF_Authorization=${token}` }, { cookie: `CF_Authorization=${token}`, 'cf-access-jwt-assertion': token, 'x-x6-owner-assertion': token }]) assert.ok(await verify(new Request(ORIGIN, { headers }), f.env))
  for (const headers of [
    { cookie: `CF_Authorization=${token}; CF_Authorization=${token}` },
    { cookie: `CF_Authorization=${token}`, 'cf-access-jwt-assertion': other },
    { cookie: `CF_Authorization=${token}`, 'x-x6-owner-assertion': 'invalid' },
    { 'cf-access-jwt-assertion': `${token}, ${token}` },
    { 'cf-access-jwt-assertion': token, 'x-x6-owner-assertion': other },
    { cookie: `CF_Authorization="${token}"` },
  ]) assert.equal(await verify(new Request(ORIGIN, { headers }), f.env), null)
})

test('RS256 Cloudflare Access remains verified with pinned issuer, audience, email and cached keys', async () => {
  const f = await ownerAuthFixture()
  const env = { ...f.env, ACCESS_TEAM: 'fixture.cloudflareaccess.com', ACCESS_AUD: 'fixture-audience' }
  const keys = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify'])
  const jwk = { ...await crypto.subtle.exportKey('jwk', keys.publicKey), kid: 'fixture-key' }
  let calls = 0
  const verify = createAccessVerifier({ now: () => f.at, fetchKeys: async url => { calls++; assert.equal(url, 'https://fixture.cloudflareaccess.com/cdn-cgi/access/certs'); return Response.json({ keys: [jwk] }) } })
  const sign = async changes => {
    const input = Buffer.from(JSON.stringify({ alg: 'RS256', kid: jwk.kid })).toString('base64url') + '.' + Buffer.from(JSON.stringify({ ...f.claims, iss: 'https://' + env.ACCESS_TEAM, aud: [env.ACCESS_AUD], ...changes })).toString('base64url')
    return input + '.' + Buffer.from(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', keys.privateKey, new TextEncoder().encode(input))).toString('base64url')
  }
  for (const carrier of ['cf-access-jwt-assertion', 'x-x6-owner-assertion', 'cookie']) {
    const token = await sign({})
    assert.equal((await verify(new Request(ORIGIN, { headers: { [carrier]: carrier === 'cookie' ? `CF_Authorization=${token}` : token } }), env)).type, 'access')
  }
  for (const claims of [{ iss: 'https://evil.invalid' }, { aud: 'other' }, { email: 'other@example.invalid' }, { exp: f.at / 1000 }, { nbf: f.at / 1000 + 1 }]) assert.equal(await verify(new Request(ORIGIN, { headers: { 'cf-access-jwt-assertion': await sign(claims) } }), env), null)
  assert.equal(calls, 1)
})

test('owner login is bounded, same-origin, non-refreshing and grants no asset or signing bypass', async t => {
  const f = await ownerAuthFixture(), token = await f.sign()
  const cloud = await fixture(t)
  await cloud.bootstrap()
  Object.assign(cloud.env, f.env)
  delete cloud.env.ACCESS_TEAM; delete cloud.env.ACCESS_AUD
  let at = f.at
  const worker = createWorker({ now: () => at, networkFetch: () => { throw new Error('No external network') } })
  const login = (overrides = {}) => worker.fetch(new Request(ORIGIN + (overrides.path ?? '/_auth/owner'), { method: overrides.method ?? 'POST', headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/jwt', ...overrides.headers }, ...((overrides.method ?? 'POST') === 'POST' ? { body: overrides.body ?? token } : {}) }), cloud.env)
  assert.equal((await login({ headers: { cookie: '__cf_bm=unrelated; analytics=value' } })).status, 200)
  assert.equal((await worker.fetch(new Request(ORIGIN + '/_auth/owner', { method: 'POST', headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/jwt' }, body: token }), cloud.env)).status, 200)
  const result = await login()
  assert.equal(result.status, 200)
  assert.equal(result.headers.get('set-cookie'), `CF_Authorization=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=600`)
  assert.equal(result.headers.get('cache-control'), 'no-store')
  const replacement = await f.sign({ exp: f.claims.exp + 100 })
  const rsaKeys = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify'])
  const accessInput = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'fixture-upstream' })).toString('base64url') + '.' + Buffer.from(JSON.stringify({ ...f.claims, iss: 'https://fixture.cloudflareaccess.com', aud: ['fixture-audience'] })).toString('base64url')
  const accessToken = accessInput + '.' + Buffer.from(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', rsaKeys.privateKey, new TextEncoder().encode(accessInput))).toString('base64url')
  for (const headers of [
    { cookie: `CF_Authorization=${token}` },
    { cookie: `CF_Authorization=${token}`, 'cf-access-jwt-assertion': accessToken },
    { cookie: `CF_Authorization=${token}; CF_Authorization=${token}`, 'x-x6-owner-assertion': 'invalid' },
  ]) {
    const replaced = await login({ body: replacement, headers })
    assert.equal(replaced.status, 200)
    assert.equal(replaced.headers.get('set-cookie'), `CF_Authorization=${replacement}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=700`)
  }
  const wrongKey = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])
  for (const invalid of ['invalid', await f.sign({}, undefined, wrongKey.privateKey), await f.sign({ exp: f.at / 1000 })]) {
    const rejected = await login({ body: invalid, headers: { cookie: `CF_Authorization=${token}`, 'x-x6-owner-assertion': token, 'cf-access-jwt-assertion': accessToken } })
    assert.equal(rejected.status, 401)
    assert.equal(rejected.headers.get('set-cookie'), null)
  }
  at += 10_000
  assert.ok((await login()).headers.get('set-cookie').endsWith('Max-Age=590'))
  for (const [overrides, status] of [
    [{ method: 'GET' }, 405], [{ path: '/_auth/owner?x=1' }, 404],
    [{ headers: { origin: 'https://other.invalid' } }, 403], [{ headers: { 'sec-fetch-site': 'cross-site' } }, 403],
    [{ headers: { 'content-type': 'application/json' } }, 400], [{ body: 'x'.repeat(16385) }, 413],
    [{ body: 'invalid' }, 401],
    [{ headers: { 'content-encoding': 'gzip' } }, 400],
  ]) { const rejected = await login(overrides); assert.equal(rejected.status, status); assert.equal(rejected.headers.get('set-cookie'), null) }
  const assets = cloud.assetCalls
  assert.equal((await worker.fetch(new Request(ORIGIN + '/preview.html'), cloud.env)).status, 401)
  assert.equal(cloud.assetCalls, assets)
  const authHeaders = { cookie: `CF_Authorization=${token}`, origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' }
  assert.equal((await worker.fetch(new Request(ORIGIN + '/preview.html', { headers: authHeaders }), cloud.env)).status, 200)
  const grant = { mandateId: 'fixture-mandate', ticketId: null, ballId: cloud.ball.ballId, epoch: cloud.ball.epoch, scope: { organs: ['seed-echo'] }, identity: 'owner-fixture', expiresAt: at + 60000 }
  // Login never supplies the separate trusted approval callback or a signing key.
  const denied = await worker.fetch(new Request(ORIGIN + '/_host/owner-grant', { method: 'POST', headers: authHeaders, body: JSON.stringify(grant) }), cloud.env)
  assert.equal(denied.status, 403)
  assert.equal((await body(denied)).code, 'CLASS3_WEBAUTHN_REQUIRED')
  assert.equal((await worker.fetch(new Request(ORIGIN + '/_mirror/aura-inputs', { headers: authHeaders }), cloud.env)).status, 501)
  cloud.env.OWNER_PUBLIC_KEY_HEX = 'bad'
  assert.equal((await login()).status, 503)
})


test('owner login accepts exactly 24 hours without refreshing old tokens or accepting longer lifetimes', async () => {
  const f = await ownerAuthFixture()
  const head = new X61HeadDurableObject({ storage: memoryStorage(), getWebSockets: () => [] }, f.env)
  f.env.HEAD = { idFromName: name => name, get: () => head }
  let at = f.at
  const worker = createWorker({ now: () => at, networkFetch: () => assert.fail('Owner login must not use external network') })
  const login = token => worker.fetch(new Request(ORIGIN + '/_auth/owner', { method: 'POST', headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/jwt' }, body: token }), f.env)
  for (const seconds of [3600, 43200, 86400]) {
    const expires = f.at / 1000 + seconds
    const token = await f.sign({ nbf: f.at / 1000, exp: expires })
    for (const elapsed of [0, 10_000, seconds * 1000 - 1000]) {
      at = f.at + elapsed
      const response = await login(token)
      assert.equal(response.status, 200)
      assert.deepEqual(await body(response), { ok: true, expires })
      assert.equal(response.headers.get('set-cookie'), `CF_Authorization=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${seconds - elapsed / 1000}`)
    }
    at = expires * 1000
    const expired = await login(token)
    assert.equal(expired.status, 401)
    assert.equal(expired.headers.get('set-cookie'), null)
  }
  at = f.at
  for (const changes of [
    { nbf: f.at / 1000, exp: f.at / 1000 + 86401 },
    { nbf: f.at / 1000 - 3600, exp: f.at / 1000 + 86400 },
  ]) {
    const refused = await login(await f.sign(changes))
    assert.equal(refused.status, 401)
    assert.equal(refused.headers.get('set-cookie'), null)
  }
})

test('owner login cancels a stalled body at its independent elapsed-time deadline', async t => {
  const f = await ownerAuthFixture()
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let cancelled = false
  const stalled = new ReadableStream({
    pull() { return new Promise(() => {}) },
    cancel() { cancelled = true; return new Promise(() => {}) },
  })
  const worker = createWorker({ now: () => f.at })
  const pending = worker.fetch(new Request(ORIGIN + '/_auth/owner', {
    method: 'POST', headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/jwt' },
    body: stalled, duplex: 'half',
  }), f.env)
  t.mock.timers.tick(10000)
  const response = await pending
  assert.equal(response.status, 408)
  assert.equal((await body(response)).code, 'OWNER_LOGIN_TIMEOUT')
  assert.equal(response.headers.get('set-cookie'), null)
  assert.equal(cancelled, true)
})

test('Access readiness does not read owner signing configuration and malformed issuers never authenticate', async () => {
  let publicReads = 0
  const env = { PUBLIC_HOST: new URL(ORIGIN).host, OWNER_EMAIL: 'owner@example.invalid', ACCESS_TEAM: 'fixture', ACCESS_AUD: 'fixture',
    get OWNER_PUBLIC_KEY_HEX() { publicReads++; return undefined },
    get OWNER_ED25519_SECRET_KEY() { throw new Error('Authentication must not read signing secrets') },
  }
  assert.equal(ownerAccessConfigured(env), true)
  assert.equal(publicReads, 0)
  const verify = createAccessVerifier({ fetchKeys: () => { throw new Error('Malformed issuer must not fetch keys') } })
  const token = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'fixture' })).toString('base64url') + '.' + Buffer.from('{}').toString('base64url') + '.AA'
  assert.equal(await verify(new Request(ORIGIN, { headers: { 'cf-access-jwt-assertion': token } }), env), null)
  assert.equal(publicReads, 0)
})

function signinFixture() {
  let protectedReads = 0, verifications = 0
  const env = {
    PUBLIC_HOST: new URL(ORIGIN).host, OWNER_EMAIL: 'private-owner@example.invalid', OWNER_PUBLIC_KEY_HEX: 'ab'.repeat(32),
    get OWNER_ED25519_SECRET_KEY() { throw new Error('Sign-in must not read a private key') },
    get ASSETS() { protectedReads++; throw new Error('Unauthenticated asset access') },
    get HEAD() { protectedReads++; throw new Error('Unauthenticated head access') },
    get MIRROR() { protectedReads++; throw new Error('Unauthenticated mirror access') },
  }
  const worker = createWorker({ verifyAccess: async () => { verifications++; return null }, networkFetch: () => { throw new Error('No external network') } })
  const request = (pathname = '/', { method = 'GET', headers = {}, selectedEnv = env, origin = ORIGIN } = {}) => worker.fetch(new Request(origin + pathname, { method, headers: { accept: 'text/html', ...headers } }), selectedEnv)
  return { env, request, get protectedReads() { return protectedReads }, get verifications() { return verifications } }
}

test('owner sign-in is static 401 HTML only for explicit entry document requests without protected reads', async () => {
  const f = signinFixture()
  let expected
  for (const route of ['/', '/index.html', '/preview.html']) {
    for (const headers of [
      {},
      { accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' },
      { accept: 'TEXT/HTML;q=0.001', 'sec-fetch-site': 'cross-site' },
      { accept: 'text/html; q=1.000', cookie: 'CF_Authorization=synthetic-private-token', 'x-x6-owner-assertion': '<untrusted-assertion>' },
    ]) {
      const response = await f.request(route, { headers })
      assert.equal(response.status, 401)
      assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8')
      assert.equal(response.headers.get('cache-control'), 'no-store')
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
      assert.equal(response.headers.get('referrer-policy'), 'no-referrer')
      assert.equal(response.headers.get('set-cookie'), null)
      const html = await response.text()
      expected ??= html
      assert.equal(html, expected)
      assert.ok(!html.includes(f.env.OWNER_EMAIL))
      assert.ok(!html.includes(f.env.OWNER_PUBLIC_KEY_HEX))
      assert.ok(!html.includes('synthetic-private-token'))
      assert.ok(!html.includes('<untrusted-assertion>'))
      const dom = new JSDOM(html)
      try {
        const document = dom.window.document
        const scripts = document.querySelectorAll('script'), styles = document.querySelectorAll('style')
        assert.equal(scripts.length, 1); assert.equal(styles.length, 1)
        assert.equal(document.querySelectorAll('[src], link, iframe').length, 0)
        const scriptHash = createHash('sha256').update(scripts[0].textContent).digest('base64')
        const styleHash = createHash('sha256').update(styles[0].textContent).digest('base64')
        assert.equal(response.headers.get('content-security-policy'), `default-src 'none'; base-uri 'none'; object-src 'none'; script-src 'sha256-${scriptHash}'; style-src 'sha256-${styleHash}'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'`)
        const input = document.getElementById('owner-token')
        assert.equal(input.getAttribute('type'), 'password'); assert.equal(input.getAttribute('autocomplete'), 'off')
        assert.equal(input.hasAttribute('name'), false); assert.equal(input.hasAttribute('value'), false)
        assert.equal(document.getElementById('owner-signin').getAttribute('method'), 'post')
        assert.equal(document.getElementById('owner-submit').disabled, true, 'No script means no enabled submit')
        assert.equal(document.getElementById('owner-status').getAttribute('role'), 'status')
        assert.doesNotMatch(scripts[0].textContent, /localStorage|sessionStorage|indexedDB|document\.cookie|console\.|innerHTML|outerHTML|insertAdjacentHTML|document\.write|location\.search/)
        // The fragment is read in exactly one place: the invite reader, which takes it out of the address bar at once and
        // never writes it into the page (edge-signin-door.test.mjs). The query is never read.
        assert.equal(scripts[0].textContent.match(/location\.hash/g)?.length, 1)
      } finally { dom.window.close() }
    }
  }
  assert.equal(f.protectedReads, 0)
  assert.equal(f.verifications, 12)
})

test('owner sign-in leaves APIs, assets, non-GET and non-document requests as JSON authentication failures', async () => {
  const f = signinFixture()
  const rejected = [
    ...['/api/health', '/_bootstrap', '/__x6/status', '/api/x61/status', '/__x6/facts', '/api/x61/facts', '/_head/ball', '/_mirror/status', '/_host/wake', '/_host/owner-key', '/_host/owner-grant', '/door/openai/v1/models', '/app.js', '/preview.html/', '/other', '/api/health#session', '/app.js#session'].map(route => [route, {}]),
    ...['HEAD', 'POST', 'PUT', 'DELETE', 'OPTIONS'].map(method => ['/', { method }]),
    ...['', '*/*', 'text/*', 'application/json', 'text/html;q=0', 'text/html;q=0.000,*/*;q=1', 'text/html;q=1.1', 'text/html;q=bogus', 'text/html;q=.5', 'text/html;q=0.0001', 'text/html;q=1;q=0', 'text/html,text/html;q=0', 'text/html;charset=unsupported'].map(accept => ['/', { headers: { accept } }]),
    ...['cors', 'no-cors', 'same-origin', ''].map(mode => ['/', { headers: { 'sec-fetch-mode': mode } }]),
    ...['empty', 'script', 'iframe', ''].map(destination => ['/', { headers: { 'sec-fetch-dest': destination } }]),
  ]
  for (const [route, options] of rejected) {
    const response = await f.request(route, options)
    assert.equal(response.status, 401, JSON.stringify([route, options]))
    assert.equal(response.headers.get('content-type'), 'application/json')
    assert.deepEqual(await body(response), { ok: false, code: 'OWNER_ACCESS_REQUIRED' })
  }
  for (const route of ['/?x=secret', '/preview.html?']) {
    const response = await f.request(route)
    assert.equal(response.status, 401)
    assert.match(response.headers.get('content-type'), /^text\/html/)
    assert.ok(!(await response.text()).includes('x=secret'))
  }
  assert.equal(f.protectedReads, 0)
})

test('owner sign-in preserves host, configuration, origin and login endpoint refusals', async () => {
  const f = signinFixture()
  for (const [options, status, code] of [
    [{ origin: 'http://messages-fixture.example.invalid' }, 403, 'HOST_REFUSED'],
    [{ origin: 'https://other.example.invalid' }, 403, 'HOST_REFUSED'],
    [{ selectedEnv: { PUBLIC_HOST: f.env.PUBLIC_HOST } }, 503, 'OWNER_ACCESS_NOT_CONFIGURED'],
    [{ selectedEnv: { PUBLIC_HOST: f.env.PUBLIC_HOST, OWNER_EMAIL: f.env.OWNER_EMAIL, OWNER_PUBLIC_KEY_HEX: 'bad' } }, 503, 'OWNER_ACCESS_NOT_CONFIGURED'],
    [{ headers: { origin: 'https://other.example.invalid' } }, 403, 'ORIGIN_REFUSED'],
    [{ method: 'POST', headers: { 'sec-fetch-site': 'cross-site' } }, 403, 'CROSS_SITE_REFUSED'],
  ]) {
    const response = await f.request('/', options)
    assert.equal(response.status, status)
    assert.deepEqual(await body(response), { ok: false, code })
  }
  assert.equal(f.verifications, 0)
  const login = await f.request('/_auth/owner')
  assert.equal(login.status, 405); assert.equal((await body(login)).code, 'METHOD_UNAVAILABLE')
  const worker = createWorker({ verifyAccess: async () => { throw new Error('Untrusted verification detail') } })
  const failure = await worker.fetch(new Request(ORIGIN, { headers: { accept: 'text/html' } }), f.env)
  assert.equal(failure.status, 503); assert.deepEqual(await body(failure), { ok: false, code: 'CLOUD_REQUEST_FAILED' })
  assert.equal(f.protectedReads, 0)
})

test('authenticated entry documents still require bootstrap before fetching application assets', async t => {
  const cloud = await fixture(t)
  for (const route of ['/', '/index.html', '/preview.html']) {
    // An owner's document navigation on an empty edge gets the restore page, never the application assets.
    const response = await cloud.request(route, undefined, { headers: { accept: 'text/html' } })
    assert.equal(response.status, 503)
    assert.match(response.headers.get('content-type'), /^text\/html/)
    assert.match(await response.text(), /<title>Restore Auma<\/title>/)
    // Any other request still gets the plain refusal.
    const read = await cloud.request(route, undefined, { headers: { accept: 'application/json' } })
    assert.equal(read.status, 503); assert.equal((await body(read)).code, 'BOOTSTRAP_REQUIRED')
  }
  assert.equal(cloud.assetCalls, 0)
  await cloud.bootstrap()
  for (const route of ['/', '/index.html', '/preview.html']) {
    const response = await cloud.request(route, undefined, { headers: { accept: 'text/html' } })
    assert.equal(response.status, 200); assert.equal(await response.text(), 'Fixture asset')
  }
  assert.equal(cloud.assetCalls, 3)
})

async function signinBrowser(t, fetchImplementation) {
  const response = await signinFixture().request()
  const dom = new JSDOM(await response.text(), { url: ORIGIN })
  t.after(() => dom.window.close())
  const document = dom.window.document, form = document.getElementById('owner-signin')
  const input = document.getElementById('owner-token'), button = document.getElementById('owner-submit'), status = document.getElementById('owner-status')
  const submissions = [], timers = new Map(), requests = [], replacements = []
  let nextTimer = 0
  const listen = form.addEventListener.bind(form)
  form.addEventListener = (name, listener, options) => listen(name, event => { submissions.push(Promise.resolve(listener(event))) }, options)
  runInNewContext(document.querySelector('script').textContent, {
    document,
    window: { addEventListener: dom.window.addEventListener.bind(dom.window), location: { replace: destination => replacements.push(destination) } },
    AbortController,
    setTimeout(callback, delay) { assert.equal(delay, 10000); timers.set(++nextTimer, callback); return nextTimer },
    clearTimeout(timer) { timers.delete(timer) },
    fetch(url, options) {
      assert.equal(input.value, '', 'Clear the field before handing the token to fetch')
      requests.push({ url, options })
      return fetchImplementation(url, options)
    },
  })
  const submit = value => {
    input.value = value
    const event = new dom.window.Event('submit', { bubbles: true, cancelable: true })
    form.dispatchEvent(event)
    assert.equal(event.defaultPrevented, true)
    return submissions.at(-1)
  }
  const page = name => dom.window.dispatchEvent(new dom.window.PageTransitionEvent(name, { persisted: true }))
  return { document, form, input, button, status, requests, replacements, timers, submit, page,
    timeout() { assert.equal(timers.size, 1); const [id, callback] = [...timers][0]; timers.delete(id); callback() },
  }
}

test('owner sign-in script clears and trims a token, sends one fixed request and replaces only after HTTP 200', async t => {
  const reply = Promise.withResolvers()
  const page = await signinBrowser(t, () => reply.promise)
  assert.equal(page.button.disabled, false)
  const first = page.submit('  synthetic.owner.assertion  ')
  assert.equal(page.input.value, ''); assert.equal(page.input.disabled, true); assert.equal(page.button.disabled, true)
  assert.equal(page.form.getAttribute('aria-busy'), 'true')
  await page.submit('second.synthetic.assertion')
  assert.equal(page.input.value, ''); assert.equal(page.requests.length, 1); assert.deepEqual(page.replacements, [])
  const { url, options } = page.requests[0]
  assert.equal(url, '/_auth/owner'); assert.equal(options.method, 'POST'); assert.equal(options.headers['content-type'], 'application/jwt')
  assert.equal(options.credentials, 'same-origin'); assert.equal(options.redirect, 'error'); assert.equal(options.cache, 'no-store')
  assert.equal(options.body, 'synthetic.owner.assertion'); assert.equal(options.signal.aborted, false)
  reply.resolve({ status: 200, get body() { throw new Error('Do not read login response bodies') } })
  await first
  assert.deepEqual(page.replacements, ['/']); assert.equal(page.timers.size, 0)
  assert.equal(page.button.disabled, true, 'No second exchange while navigation is pending')
  assert.equal(page.document.documentElement.outerHTML.includes('synthetic.owner.assertion'), false)
})

test('owner sign-in script keeps failures generic, rejects empty input and permits explicit retry', async t => {
  let outcome = () => Promise.resolve({ status: 401, get body() { throw new Error('private response') } })
  const page = await signinBrowser(t, () => outcome())
  for (const value of ['', '  ', 'x'.repeat(16385)]) {
    await page.submit(value)
    assert.equal(page.requests.length, 0); assert.equal(page.input.value, ''); assert.equal(page.timers.size, 0)
  }
  for (const status of [201, 204, 302, 400, 401, 403, 408, 413, 500, 503]) {
    outcome = () => Promise.resolve({ status, get body() { throw new Error('private response') } })
    await page.submit('synthetic.private.assertion')
    assert.deepEqual(page.replacements, []); assert.equal(page.button.disabled, false); assert.equal(page.input.disabled, false)
    assert.equal(page.form.hasAttribute('aria-busy'), false); assert.equal(page.timers.size, 0)
    assert.equal(page.input.value, ''); assert.equal(page.document.activeElement, page.input)
    assert.match(page.status.textContent, /try again/); assert.doesNotMatch(page.status.textContent, /private|synthetic/)
  }
  for (const failure of [() => Promise.reject(new Error('synthetic.private.assertion')), () => { throw new Error('synthetic.private.assertion') }]) {
    outcome = failure
    await page.submit('synthetic.private.assertion')
    assert.equal(page.status.textContent, 'Sign-in could not complete. Paste the pass to try again.')
    assert.equal(page.button.disabled, false); assert.equal(page.timers.size, 0)
  }
  outcome = () => Promise.resolve({ status: 200 })
  await page.submit('synthetic.retry.assertion')
  assert.deepEqual(page.replacements, ['/'])
})

test('owner sign-in timeout aborts, releases retry and ignores a late successful response', async t => {
  const stalled = Promise.withResolvers(), retry = Promise.withResolvers()
  let calls = 0
  const page = await signinBrowser(t, () => (++calls === 1 ? stalled.promise : retry.promise))
  const first = page.submit('synthetic.timeout.assertion')
  page.timeout()
  await first
  assert.equal(page.requests[0].options.signal.aborted, true)
  assert.equal(page.status.textContent, 'Sign-in timed out. Paste the pass to try again.')
  assert.equal(page.button.disabled, false); assert.equal(page.input.value, '')
  const second = page.submit('synthetic.retry.assertion')
  stalled.resolve({ status: 200 })
  await first
  assert.deepEqual(page.replacements, []); assert.equal(page.button.disabled, true); assert.equal(page.timers.size, 1)
  retry.resolve({ status: 200 })
  await second
  assert.deepEqual(page.replacements, ['/']); assert.equal(page.timers.size, 0)
})

test('owner sign-in clears BFCache fields and fences abandoned requests from restored-page retries', async t => {
  const abandoned = Promise.withResolvers(), retry = Promise.withResolvers()
  let calls = 0
  const page = await signinBrowser(t, () => (++calls === 1 ? abandoned.promise : retry.promise))
  const first = page.submit('synthetic.abandoned.assertion')
  page.input.value = 'synthetic.autofilled.assertion'
  page.page('pagehide')
  assert.equal(page.input.value, ''); assert.equal(page.requests[0].options.signal.aborted, true); assert.equal(page.timers.size, 0)
  page.input.value = 'synthetic.restored.assertion'
  page.page('pageshow')
  assert.equal(page.input.value, ''); assert.equal(page.button.disabled, false); assert.equal(page.status.textContent, '')
  const second = page.submit('synthetic.retry.assertion')
  abandoned.resolve({ status: 200 })
  await first
  assert.deepEqual(page.replacements, []); assert.equal(page.button.disabled, true); assert.equal(page.timers.size, 1)
  retry.resolve({ status: 401 })
  await second
  assert.deepEqual(page.replacements, []); assert.equal(page.button.disabled, false); assert.equal(page.timers.size, 0)
  assert.doesNotMatch(page.document.documentElement.outerHTML, /synthetic\./)
})

// ANYBROWSER HOOK: the vault and the /rescue page THROUGH the Worker, over the fixture's real HEAD and MIRROR and the
// vault suite's in-memory bucket. A second Worker over the same env sends raw and streamed bodies (the fixture's request
// sends JSON text only).
function vaultFixture(cloud) {
  const bucket = createVaultBucket()
  cloud.env.ARCHIVE_BUCKET = bucket
  const worker = createWorker({ verifyAccess: async request => request.headers.get('cookie') === 'CF_Authorization=fixture-token' })
  const vault = (pathname, { method = 'GET', body, headers = {} } = {}) => {
    const all = new Headers({ cookie: 'CF_Authorization=fixture-token', origin: ORIGIN, 'sec-fetch-site': 'same-origin' })
    for (const [name, value] of Object.entries(headers)) value === null ? all.delete(name) : all.set(name, value)
    const streamed = body instanceof ReadableStream
    return worker.fetch(new Request(ORIGIN + pathname, { method, headers: all, ...(body === undefined ? {} : { body, ...(streamed ? { duplex: 'half' } : {}) }) }), cloud.env)
  }
  return { bucket, worker, vault }
}
const vaultSha = value => createHash('sha256').update(value).digest('hex')
const budgetRow = cloud => cloud.mirrorStorage.snapshot().get('world:v1:budget')

test('ANYBROWSER: the vault through the Worker: signed out 401, unseeded 503 with no bucket or row call, then hash-checked, first body kept', async t => {
  const cloud = await fixture(t)
  const { bucket, vault } = vaultFixture(cloud)
  const hello = Buffer.from('hello piece'), helloSha = vaultSha(hello)
  // Signed out: the owner gate answers; nothing reaches the bucket.
  for (const [path, method] of [['/_vault/rescue', 'GET'], ['/_vault/blob/' + helloSha, 'PUT'], ['/_vault/blob/' + helloSha, 'HEAD']]) {
    const response = await vault(path, { method, ...(method === 'PUT' ? { body: hello } : {}), headers: { cookie: null } })
    assert.equal(response.status, 401, path + ' ' + method)
  }
  // Signed in, before the world is seeded: 503 BOOTSTRAP_REQUIRED, no bucket call and no row written.
  const before = cloud.mirrorStorage.snapshot()
  for (const [path, method] of [['/_vault/blob/' + helloSha, 'PUT'], ['/_vault/rescue', 'GET'], ['/_vault/rescue/' + 'a'.repeat(32) + '/verify?cursor=0', 'POST']]) {
    const response = await vault(path, { method, ...(method === 'PUT' ? { body: hello } : {}) })
    assert.equal(response.status, 503, path)
    assert.equal((await body(response)).code, 'BOOTSTRAP_REQUIRED')
  }
  assert.equal(bucket.calls.length, 0, 'no bucket call before the seed')
  assert.deepEqual(cloud.mirrorStorage.snapshot(), before, 'no row before the seed')
  await cloud.bootstrap()
  // A body that does not match its name: 422, nothing stored, nothing counted.
  const wrong = await vault('/_vault/blob/' + vaultSha('another body'), { method: 'PUT', body: hello })
  assert.equal(wrong.status, 422)
  assert.equal((await body(wrong)).code, 'BLOB_HASH_MISMATCH')
  assert.equal(bucket.calls.filter(call => call.op === 'put').length, 0)
  assert.equal(budgetRow(cloud), undefined)
  // The right body: stored once, counted through MIRROR's budget route (a real row in the real MirrorDO).
  const stored = await vault('/_vault/blob/' + helloSha, { method: 'PUT', body: hello })
  assert.equal(stored.status, 201, JSON.stringify(await body(stored.clone())))
  assert.deepEqual(await body(stored), { ok: true, stored: true })
  assert.equal(budgetRow(cloud).totalBytes, hello.length)
  assert.ok(cloud.calls.some(([name, path]) => name === 'MIRROR' && path === '/_mirror/world/budget'))
  // Two different bodies to one key: only the first is stored; the second is never 201.
  const second = await vault('/_vault/blob/' + helloSha, { method: 'PUT', body: Buffer.from('a different body') })
  assert.equal(second.status, 422)
  const again = await vault('/_vault/blob/' + helloSha, { method: 'PUT', body: hello })
  assert.equal(again.status, 200)
  assert.deepEqual(await body(again), { ok: true, stored: false })
  assert.deepEqual(Buffer.from(bucket.objects.get(`w/node-main-v1/blob/${helloSha}`).bytes), hello)
  assert.equal(bucket.writes.get(`w/node-main-v1/blob/${helloSha}`), 1)
  assert.equal(budgetRow(cloud).totalBytes, hello.length, 'a refused or repeated put counts nothing')
  // Reads: the bytes, no-store; HEAD gives the length.
  const read = await vault('/_vault/blob/' + helloSha)
  assert.equal(read.status, 200)
  assert.equal(read.headers.get('cache-control'), 'no-store')
  assert.deepEqual(Buffer.from(await read.arrayBuffer()), hello)
  const head = await vault('/_vault/blob/' + helloSha, { method: 'HEAD' })
  assert.equal(head.status, 200)
  assert.equal(head.headers.get('content-length'), String(hello.length))
  assert.equal((await vault('/_vault/blob/' + vaultSha('never sent'), { method: 'HEAD' })).status, 404)
  // The world key is the object name, never the seed.
  assert.ok([...bucket.objects.keys()].every(key => key.startsWith('w/node-main-v1/')))
  assert.ok(![...bucket.objects.keys()].some(key => key.includes(cloud.seed.seedId)))
  assert.equal(bucket.calls.filter(call => call.op === 'delete').length, 0)
})

test('ANYBROWSER: vault writes come only from her own page: another origin, no Origin or no same-origin fetch mark is refused before the bucket', async t => {
  const cloud = await fixture(t)
  await cloud.bootstrap()
  const { bucket, vault } = vaultFixture(cloud)
  const piece = Buffer.from('origin probe'), path = '/_vault/blob/' + vaultSha(piece)
  // the vault's own rule now runs BEFORE the session and answers as a signed-out caller is
  // answered (401 OWNER_ACCESS_REQUIRED); the Worker's earlier rules (foreign Origin, cross-site write) still say 403.
  for (const [name, headers, status] of [
    ['another origin', { origin: 'https://elsewhere.example.invalid' }, 403],
    ['another origin, same-origin mark', { origin: 'https://elsewhere.example.invalid', 'sec-fetch-site': 'same-origin' }, 403],
    ['no Origin', { origin: null }, 401],
    ['no fetch mark', { 'sec-fetch-site': null }, 401],
    ['same-site', { 'sec-fetch-site': 'same-site' }, 401],
    ['cross-site', { 'sec-fetch-site': 'cross-site' }, 403],
    ['typed in the address bar', { 'sec-fetch-site': 'none' }, 401],
  ]) {
    for (const [method, target] of [['PUT', path], ['POST', '/_vault/rescue/' + 'b'.repeat(32) + '/verify?cursor=0'], ['PUT', '/_vault/rescue/' + 'c'.repeat(32)]]) {
      const response = await vault(target, { method, headers, ...(method === 'PUT' ? { body: piece } : {}) })
      assert.equal(response.status, status, `${name}: ${method} ${target}`)
      if (status === 401) assert.equal((await response.json()).code, 'OWNER_ACCESS_REQUIRED', `${name}: ${method} ${target}`)
    }
  }
  assert.equal(bucket.calls.length, 0, 'no refused write reached the bucket')
  assert.equal(budgetRow(cloud), undefined)
  // A read from another origin is refused too (the Worker's own origin rule).
  assert.equal((await vault(path, { headers: { origin: 'https://elsewhere.example.invalid' } })).status, 403)
  assert.equal((await vault(path, { method: 'PUT', body: piece })).status, 201)
})

test('ANYBROWSER: vault bodies are cut off WHILE reading at the piece limit, and a stalled body is answered 408 at 30 s idle or 120 s in all', async t => {
  const cloud = await fixture(t)
  await cloud.bootstrap()
  const { bucket, vault } = vaultFixture(cloud)
  // A body that never ends: 1 MiB per pull, no content-length. The vault must stop it after the piece limit.
  let pulls = 0, cancelled = false
  const endless = new ReadableStream({ pull(controller) { pulls++; controller.enqueue(new Uint8Array(1024 * 1024)) }, cancel() { cancelled = true } }, { highWaterMark: 0 })
  const tooLarge = await vault('/_vault/blob/' + 'e'.repeat(64), { method: 'PUT', body: endless })
  assert.equal(tooLarge.status, 413)
  assert.equal((await body(tooLarge)).code, 'PART_TOO_LARGE')
  assert.ok(pulls <= VAULT_PIECE / (1024 * 1024) + 2, `read ${pulls} MiB of an endless body`)
  assert.equal(cancelled, true, 'the endless body was cancelled')
  // An index over 4 MiB is cut off the same way.
  let indexPulls = 0
  const endlessIndex = new ReadableStream({ pull(controller) { indexPulls++; controller.enqueue(new Uint8Array(1024 * 1024).fill(0x20)) } }, { highWaterMark: 0 })
  const indexTooLarge = await vault('/_vault/rescue/' + 'd'.repeat(32), { method: 'PUT', body: endlessIndex })
  assert.equal(indexTooLarge.status, 413)
  assert.ok(indexPulls <= 4 + 2, `read ${indexPulls} MiB of an endless index`)
  assert.equal(bucket.calls.length, 0)
  // Deadlines (the PLAN's 30 s without a byte, 120 s in all), on mocked timers.
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() })
  const settle = async (predicate, label) => { for (let i = 0; i < 2000 && !predicate(); i++) await new Promise(resolve => setImmediate(resolve)); assert.ok(predicate(), label) }
  let idlePulls = 0
  const stalled = new ReadableStream({ pull(controller) { if (idlePulls++ === 0) { controller.enqueue(new Uint8Array(10)); return } return new Promise(() => {}) } }, { highWaterMark: 0 })
  let idleAnswer = null
  void vault('/_vault/blob/' + 'f'.repeat(64), { method: 'PUT', body: stalled }).then(response => { idleAnswer = response })
  await settle(() => idlePulls >= 2, 'the vault waits for the second chunk')
  for (let i = 0; i < 50; i++) await new Promise(resolve => setImmediate(resolve))
  t.mock.timers.tick(29999)
  for (let i = 0; i < 50; i++) await new Promise(resolve => setImmediate(resolve))
  assert.equal(idleAnswer, null, 'still waiting before 30 s')
  t.mock.timers.tick(1)
  await settle(() => idleAnswer !== null, 'answered at 30 s without a byte')
  assert.equal(idleAnswer.status, 408)
  assert.equal((await body(idleAnswer)).code, 'REQUEST_BODY_TIMEOUT')
  // A trickle (one byte every 20 s) is still stopped at 120 s in all.
  let trickles = 0
  const trickle = new ReadableStream({ pull(controller) { trickles++; controller.enqueue(new Uint8Array(1)) } }, { highWaterMark: 0 })
  const slowSource = new ReadableStream({ async pull(controller) {
    const reader = trickle.getReader()
    const step = await reader.read(); reader.releaseLock()
    await new Promise(resolve => setTimeout(resolve, 20000))
    controller.enqueue(step.value)
  } }, { highWaterMark: 0 })
  let totalAnswer = null
  void vault('/_vault/blob/' + 'f'.repeat(64), { method: 'PUT', body: slowSource }).then(response => { totalAnswer = response })
  for (let second = 0; second < 140 && totalAnswer === null; second += 20) {
    await settle(() => trickles > second / 20 || totalAnswer !== null, 'the trickle pulled at ' + second + ' s')
    for (let i = 0; i < 50; i++) await new Promise(resolve => setImmediate(resolve))
    t.mock.timers.tick(20000)
  }
  await settle(() => totalAnswer !== null, 'answered at 120 s in all')
  assert.equal(totalAnswer.status, 408)
  assert.ok(trickles >= 6 && trickles <= 7, `a byte every 20 s for 120 s: ${trickles}`)
  assert.equal(bucket.calls.length, 0)
})

test('ANYBROWSER: the world budget route answers only inside: the Worker never forwards it, and MIRROR wants its mark, the seed and a closed body', async t => {
  const cloud = await fixture(t)
  await cloud.bootstrap()
  const input = { op: 'charge', kind: 'blob', bytes: 1024 }
  for (const headers of [{}, { 'x-x6-internal-authorized': '1', 'x-x6-bootstrap-seed': cloud.seed.seedId }]) {
    for (const method of ['POST', 'GET']) {
      const response = await cloud.request('/_mirror/world/budget', method === 'POST' ? input : undefined, { headers })
      assert.equal(response.status, 501, method + ' ' + JSON.stringify(headers))
    }
  }
  assert.equal(cloud.calls.filter(([, path]) => path === '/_mirror/world/budget').length, 0, 'no public request reached MIRROR')
  assert.equal(budgetRow(cloud), undefined)
  const direct = (value, headers = {}, method = 'POST') => cloud.mirror.fetch(new Request('https://x61.internal/_mirror/world/budget', { method,
    headers: { 'content-type': 'application/json', 'x-x6-internal-authorized': '1', 'x-x6-bootstrap-seed': cloud.seed.seedId, ...headers }, ...(method === 'POST' ? { body: JSON.stringify(value) } : {}) }))
  assert.equal((await direct(input, { 'x-x6-internal-authorized': '0' })).status, 401)
  assert.equal((await direct(input, { 'x-x6-bootstrap-seed': 'b'.repeat(64) })).status, 503)
  assert.equal((await direct(input, {}, 'GET')).status, 400)
  for (const bad of [{ ...input, op: 'delete' }, { ...input, kind: 'other' }, { ...input, bytes: -1 }, { ...input, extra: 1 }, { op: 'check', kind: 'blob' }]) assert.equal((await direct(bad)).status, 400, JSON.stringify(bad))
  assert.equal(budgetRow(cloud), undefined)
  const charged = await body(await direct(input))
  assert.deepEqual(charged, { ok: true, budget: { ok: true } })
  assert.equal(budgetRow(cloud).totalBytes, 1024)
  assert.deepEqual(await body(await direct({ op: 'check', kind: 'blob', bytes: 3 * 1024 * 1024 * 1024 })), { ok: true, budget: { ok: false, code: 'WORLD_FULL', status: 507 } })
  assert.equal(budgetRow(cloud).totalBytes, 1024, 'check writes nothing')
})

test('ANYBROWSER: full mirror status names the browser slots in use as `clients`; compact status is unchanged', async t => {
  const cloud = await fixture(t)
  await cloud.bootstrap()
  assert.equal((await body(await cloud.request('/_mirror/status'))).clients, 0)
  await publishFixtureMirror(cloud, [['/dsh/home/fixture.txt', fixtureMirrorFile('one')]])
  const full = await body(await cloud.request('/_mirror/status'))
  assert.equal(full.clients, 1)
  assert.equal(full.limits.clients, MIRROR_LIMITS.clients)
  assert.equal(Object.hasOwn(await body(await cloud.request('/_mirror/status?compact=1')), 'clients'), false)
})

test('ANYBROWSER: /rescue: signed in it is the rescue page with its own CSP; signed out the owner sign-in page; unseeded no page; nothing else is served there', async t => {
  const cloud = await fixture(t)
  const navigation = { accept: 'text/html', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' }
  const hash = text => `'sha256-${createHash('sha256').update(text).digest('base64')}'`
  // Signed out: the sign-in page itself (status 401, its script lands back here).
  const out = await cloud.request('/rescue', undefined, { headers: { ...navigation, cookie: null } })
  assert.equal(out.status, 401)
  const signin = await out.text()
  assert.match(signin, /id="passkey-submit"/)
  assert.match(signin, /window\.location\.pathname === '\/rescue' \? '\/rescue' : '\/'/)
  // Signed out, not a document: the plain 401.
  assert.deepEqual(await body(await cloud.request('/rescue', undefined, { headers: { cookie: null } })), { ok: false, code: 'OWNER_ACCESS_REQUIRED' })
  // Signed in before the seed: no page (the vault behind it could not take a byte).
  assert.equal((await cloud.request('/rescue', undefined, { headers: navigation })).status, 503)
  await cloud.bootstrap()
  const assets = cloud.assetCalls
  const page = await cloud.request('/rescue', undefined, { headers: navigation })
  assert.equal(page.status, 200)
  assert.equal(page.headers.get('cache-control'), 'no-store')
  assert.equal(page.headers.get('content-security-policy'), `default-src 'none'; base-uri 'none'; object-src 'none'; script-src ${hash(RESCUE_PAGE.script)}; style-src ${hash(RESCUE_PAGE.style)}; connect-src 'self'; form-action 'none'; frame-ancestors 'none'`)
  const html = await page.text()
  assert.equal(html, RESCUE_PAGE.html)
  assert.ok(!/href="\/"|location\.(?:replace|assign)\('\/'\)|location\.href\s*=\s*'\/'/.test(html), 'nothing on /rescue goes to `/`')
  assert.equal(cloud.assetCalls, assets, 'the app bundle is not served on /rescue')
  for (const crafted of ['/rescue/', '/RESCUE', '/rescue%2f..', '/rescue.html']) {
    const response = await cloud.request(crafted, undefined, { headers: navigation })
    assert.notEqual(await response.clone().text(), RESCUE_PAGE.html, crafted)
  }
})
