/** Durable Head staging, cancellation, outcomes, and owner-gate regressions. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { X61HeadDurableObject, BOOTSTRAP_VERSION, canonicalBootstrap, digest, manifestIdCanon } from '../head-do.mjs'

import { ml_dsa65 } from '@noble/post-quantum/ml-dsa.js'
import { HYBRID_ENVELOPE_DOMAIN, HYBRID_ENVELOPE_SCHEMA, canonicalJson } from '../owner-grant-policy.mjs'
import { SIGNED_ACTION_SCHEMA } from '../signed-action.mjs'

const ORIGIN = 'https://head.example.invalid'

// Transactions serialize and commit a private snapshot only on success.
function storageFixture() {
  let data = new Map(), tail = Promise.resolve()
  const view = map => ({
    get: async key => structuredClone(map.get(key)),
    put: async (key, value) => { map.set(key, structuredClone(value)) },
    delete: async key => map.delete(key),
    list: async ({ prefix = '', limit = Infinity } = {}) => new Map([...map].filter(([key]) => key.startsWith(prefix)).sort(([a], [b]) => a.localeCompare(b)).slice(0, limit).map(([key, value]) => [key, structuredClone(value)])),
    getAlarm: async () => null, setAlarm: async () => {}, deleteAlarm: async () => {},
  })
  const storage = Object.fromEntries(['get', 'put', 'delete', 'list', 'getAlarm', 'setAlarm', 'deleteAlarm'].map(method => [method, (...args) => view(data)[method](...args)]))
  storage.transaction = operation => {
    const result = tail.then(async () => {
      const copy = structuredClone(data)
      const result = await operation(view(copy))
      data = copy
      return result
    })
    tail = result.catch(() => {})
    return result
  }
  return storage
}

async function fixture() {
  const storage = storageFixture()
  const env = { PUBLIC_HOST: 'head.example.invalid', OWNER_PUBLIC_KEY_HEX: '11'.repeat(32), OWNER_EMAIL: 'owner@example.invalid', AUMLOK_CUSTODY_PEPPER: '22'.repeat(32) }
  const create = () => new X61HeadDurableObject({ storage, getWebSockets: () => [] }, env)
  const head = create()
  const source = 'export const organ = "seed-echo";\n', sha = await digest(source)
  const draft = { version: 'x6.1-ball/v1', epoch: 167, parentBallId: null, createdAt: '2026-11-11T00:00:00.000Z', authorPeerId: 'fixture-peer',
    entries: { 'seed-echo': { id: 'seed-echo', specifier: `ball:${sha}`, disabled: false, config: {}, previousSpecifiers: [] } },
    modules: { [sha]: { sha256: sha, specifier: `ball:${sha}`, size: Buffer.byteLength(source) } } }
  const ball = { ...draft, ballId: await manifestIdCanon(draft) }
  const payload = { version: BOOTSTRAP_VERSION, ball, codeBySha: { [sha]: source }, mirror: { entryCount: 0, batchDigests: [] } }
  const seedId = await digest(canonicalBootstrap(payload))
  assert.equal((await head.store.bootstrapPrepare({ ...payload, seedId })).ok, true)
  assert.equal((await head.store.bootstrapCommit(seedId, { ok: true, phase: 'ready', seedId, ballId: ball.ballId, epoch: ball.epoch, entryCount: 0, nextBatch: 0, batchCount: 0 })).ok, true)
  const request = (path, body, extra = {}) => new Request(ORIGIN + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'x-x6-internal-authorized': '1', 'x-x6-bootstrap-seed': seedId, origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json',
      'x-x6-verified-access': JSON.stringify({ type: 'owner', email: env.OWNER_EMAIL, expires: Math.floor(Date.now() / 1000) + 3600 }), ...extra },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const call = async (path, body, extra, object = head) => {
    const response = await object.fetch(request(path, body, extra))
    return { status: response.status, body: await response.json() }
  }
  const candidate = async label => {
    const code = `export const continuity = ${JSON.stringify(label)};\n`, hash = await digest(code)
    const next = { ...ball, epoch: 168, parentBallId: ball.ballId, createdAt: '2026-11-11T00:01:00.000Z',
      entries: { ...ball.entries, 'seed-continuity': { id: 'seed-continuity', specifier: `ball:${hash}`, disabled: false, config: { governance: true }, previousSpecifiers: [] } },
      modules: { ...ball.modules, [hash]: { sha256: hash, specifier: `ball:${hash}`, size: Buffer.byteLength(code) } } }
    delete next.ballId
    return { ball: { ...next, ballId: await manifestIdCanon(next) }, codeBySha: { [hash]: code }, expectedParentBallId: ball.ballId, expectedEpoch: 167 }
  }
  return { storage, head, create, call, request, candidate, ball, env }
}

const encoder = new TextEncoder()
const hex = bytes => [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('')

async function createHybridTrustedKeys() {
  const edPair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])
  const edPub = new Uint8Array(await crypto.subtle.exportKey('raw', edPair.publicKey))
  const pqSeed = crypto.getRandomValues(new Uint8Array(32))
  const pqPair = ml_dsa65.keygen(pqSeed)
  const keyId = async raw => hex(await crypto.subtle.digest('SHA-256', raw)).slice(0, 12)
  const algManifest = {
    classical: { alg: 'Ed25519', keyId: await keyId(edPub) },
    pq: { alg: 'ML-DSA-65', keyId: await keyId(pqPair.publicKey) },
  }
  const trustedKeys = {
    ed25519PublicKeyHex: hex(edPub),
    mlDsaPublicKeyHex: hex(pqPair.publicKey),
  }
  async function signAction(payload) {
    const preimage = encoder.encode(
      HYBRID_ENVELOPE_DOMAIN +
        canonicalJson({
          schema: HYBRID_ENVELOPE_SCHEMA,
          artifact: 'signed-action',
          payload,
          algManifest,
        }),
    )
    const edSig = await crypto.subtle.sign('Ed25519', edPair.privateKey, preimage)
    const pqSig = ml_dsa65.sign(preimage, pqPair.secretKey, { context: encoder.encode('aukora.v2') })
    return {
      schema: HYBRID_ENVELOPE_SCHEMA,
      artifact: 'signed-action',
      payload,
      algManifest,
      signatures: {
        ed25519SigHex: hex(edSig),
        mlDsaSigHex: hex(pqSig),
      },
    }
  }
  return { trustedKeys, signAction }
}


async function signedFixture() {
  const fx = await fixture(), signing = await createHybridTrustedKeys()
  fx.env.OWNER_PUBLIC_KEY_HEX = signing.trustedKeys.ed25519PublicKeyHex
  fx.env.OWNER_MLDSA_PUBLIC_KEY_HEX = signing.trustedKeys.mlDsaPublicKeyHex
  let sequence = 0
  const envelope = async (path, body, overrides = {}) => signing.signAction({
    schema: SIGNED_ACTION_SCHEMA, actionId: `fixture-action-${++sequence}`,
    action: { '/_head/stage': 'head.stage', '/_head/promote': 'head.promote', '/_head/ball': 'head.publish' }[path],
    audience: ORIGIN, ballId: fx.ball.ballId, epoch: fx.ball.epoch, expiresAt: Date.now() + 60000,
    targetDigest: await digest(canonicalJson({ method: 'POST', pathname: path, body })), ...overrides,
  })
  return { ...fx, envelope }
}

test('stage accepts hybrid body or header envelope, rejects replay after recreation, and atomically admits one concurrent use', async () => {
  for (const carrier of ['body', 'header']) {
    const fx = await signedFixture(), candidate = await fx.candidate(carrier)
    const envelope = await fx.envelope('/_head/stage', candidate)
    const body = carrier === 'body' ? { ...candidate, signedAction: envelope } : candidate
    const headers = carrier === 'header' ? { 'x-x6-signed-action': JSON.stringify(envelope) } : {}
    const results = await Promise.all([fx.call('/_head/stage', body, headers), fx.call('/_head/stage', body, headers)])
    assert.deepEqual(results.map(result => result.status).sort(), [200, 409])
    assert.equal(results.find(result => result.status === 409).body.code, 'SIGNED_ACTION_REPLAYED')
    assert.ok(await fx.storage.get(`head:signed-action:${envelope.payload.actionId}`))
    const replay = await fx.call('/_head/stage', body, headers, fx.create())
    assert.equal(replay.status, 409)
    assert.equal(replay.body.code, 'SIGNED_ACTION_REPLAYED')
  }
})

test('signed mutations bind route, full body, audience, current head and epoch; malformed or ambiguous carriers fail closed', async () => {
  const variants = [
    ['action', { action: 'head.publish' }, 'SIGNED_ACTION_TARGET_MISMATCH'],
    ['digest', { targetDigest: 'f'.repeat(64) }, 'SIGNED_ACTION_TARGET_MISMATCH'],
    ['audience', { audience: 'https://wrong.example.invalid' }, 'SIGNED_ACTION_AUDIENCE_MISMATCH'],
    ['head', { ballId: 'f'.repeat(64) }, 'SIGNED_ACTION_STALE_HEAD'],
    ['epoch', { epoch: 166 }, 'SIGNED_ACTION_STALE_HEAD'],
    ['expiry', { expiresAt: 1 }, 'SIGNED_ACTION_EXPIRED'],
  ]
  for (const [label, overrides, code] of variants) {
    const fx = await signedFixture(), candidate = await fx.candidate(label)
    const envelope = await fx.envelope('/_head/stage', candidate, overrides)
    const response = await fx.call('/_head/stage', { ...candidate, signedAction: envelope })
    assert.equal(response.body.code, code, label)
    assert.equal((await fx.head.store.readStaged()).staged, null)
    assert.equal(await fx.storage.get(`head:signed-action:${envelope.payload.actionId}`), undefined)
  }
  const fx = await signedFixture(), candidate = await fx.candidate('altered')
  const signedAction = await fx.envelope('/_head/stage', candidate)
  const altered = await fx.call('/_head/stage', { ...candidate, replaceStaged: true, signedAction })
  assert.equal(altered.body.code, 'SIGNED_ACTION_TARGET_MISMATCH')
  for (const bad of [null, {}, 'invalid']) {
    assert.equal((await fx.call('/_head/stage', { ...candidate, signedAction: bad })).status >= 400, true)
  }
  assert.equal((await fx.call('/_head/stage', { ...candidate, signedAction }, { 'x-x6-signed-action': JSON.stringify(signedAction) })).body.code, 'SIGNED_ACTION_MALFORMED')
  assert.equal((await fx.call('/_head/stage', candidate, { 'x-x6-signed-action': '{' })).body.code, 'SIGNED_ACTION_MALFORMED')
})

test('invalid ML-DSA signature and owner/node key reuse reject through the actual stage endpoint', async () => {
  const fx = await signedFixture(), candidate = await fx.candidate('invalid-key')
  const envelope = await fx.envelope('/_head/stage', candidate)
  const forged = structuredClone(envelope)
  forged.signatures.mlDsaSigHex = '0'.repeat(forged.signatures.mlDsaSigHex.length)
  assert.equal((await fx.call('/_head/stage', { ...candidate, signedAction: forged })).body.code, 'HYBRID_SIGNATURE_INVALID')
  await fx.storage.transaction(tx => tx.put('aumlok:v1', { binding: { nodePubkeyHex: fx.env.OWNER_PUBLIC_KEY_HEX } }))
  assert.equal((await fx.call('/_head/stage', { ...candidate, signedAction: envelope })).body.code, 'NODE_KEY_IS_NOT_OWNER_KEY')
})

test('failed signed stage leaves action unconsumed and a later authorized replacement can succeed', async () => {
  const fx = await signedFixture(), a = await fx.candidate('a'), b = await fx.candidate('b')
  await fx.call('/_head/stage', a)
  const envelope = await fx.envelope('/_head/stage', b)
  assert.equal((await fx.call('/_head/stage', { ...b, signedAction: envelope })).body.code, 'CANDIDATE_ALREADY_STAGED')
  assert.equal(await fx.storage.get(`head:signed-action:${envelope.payload.actionId}`), undefined)
  await fx.head.store.clearStaged(a.ball.ballId)
  assert.equal((await fx.call('/_head/stage', { ...b, signedAction: envelope })).status, 200)
})

test('signed promote does not replace Class 3 approval and successful replay is refused durably', async () => {
  const fx = await signedFixture(), candidate = await fx.candidate('promote')
  await fx.call('/_head/stage', candidate)
  const body = { ballId: candidate.ball.ballId }, envelope = await fx.envelope('/_head/promote', body)
  const signed = { ...body, signedAction: envelope }
  assert.equal((await fx.call('/_head/promote', signed)).body.code, 'CLASS3_WEBAUTHN_REQUIRED')
  assert.equal(await fx.storage.get(`head:signed-action:${envelope.payload.actionId}`), undefined)
  let consumed = 0
  fx.head.aumlokStore = { consumeApprovalInTransaction: async tx => {
    consumed++
    await tx.put('test:approval', 'consumed')
    return { ok: true, expiresAt: Date.now() + 60000 }
  } }
  const promoted = await fx.call('/_head/promote', signed, { 'x-x6-class3-approval': 'fixture-passkey-approval' })
  assert.equal(promoted.status, 200, JSON.stringify(promoted.body))
  assert.equal(consumed, 1)
  assert.equal((await fx.head.store.read()).head.ballId, candidate.ball.ballId)
  const recreated = fx.create()
  const replay = await fx.call('/_head/promote', signed, { 'x-x6-class3-approval': 'fixture-passkey-approval' }, recreated)
  assert.equal(replay.body.code, 'SIGNED_ACTION_REPLAYED')
  const stored = await fx.storage.get('head:last-publish-outcome')
  assert.equal(stored.code, 'PUBLISHED')
  assert.equal(stored.resultingBallId, candidate.ball.ballId)
  assert.equal(stored.hasApprovalToken, true)
  assert.equal((await fx.storage.get('head:last-publish-attempt')).code, 'SIGNED_ACTION_REPLAYED')
})

test('signed ball publication is transactionally single use and successful T1 outcome survives restart', async () => {
  const fx = await signedFixture()
  const source = 'export const organ = "new-echo";', sha = await digest(source)
  const draft = { ...structuredClone(fx.ball), epoch: 168, parentBallId: fx.ball.ballId }
  draft.entries['seed-echo'].specifier = `ball:${sha}`
  draft.entries['seed-echo'].previousSpecifiers = [fx.ball.entries['seed-echo'].specifier]
  draft.modules[sha] = { sha256: sha, specifier: `ball:${sha}`, size: Buffer.byteLength(source) }
  delete draft.ballId
  const candidate = { ...draft, ballId: await manifestIdCanon(draft) }
  const grant = await fx.head.store.lease({ action: 'acquire', ownerPeerId: candidate.authorPeerId })
  const body = { ball: candidate, codeBySha: { [sha]: source }, expectedParentBallId: fx.ball.ballId, expectedEpoch: 167, writerLease: grant.lease }
  const envelope = await fx.envelope('/_head/ball', body)
  const result = await fx.call('/_head/ball', { ...body, signedAction: envelope })
  assert.equal(result.status, 200, JSON.stringify(result.body))
  assert.equal(result.body.tier, 'T1')
  const status = await fx.call('/_head/promotion-status', undefined, undefined, fx.create())
  assert.equal(status.body.lastPublishOutcome.ok, true)
  assert.equal(status.body.lastPublishOutcome.hasApprovalToken, false)
  assert.equal(status.body.lastPublishOutcome.candidateBallId, candidate.ballId)
  const replay = await fx.call('/_head/ball', { ...body, signedAction: envelope }, undefined, fx.create())
  assert.equal(replay.body.code, 'SIGNED_ACTION_REPLAYED')
})
