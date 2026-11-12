/** Offline owner-signing regressions: generated fixture keys, no host startup or external I/O. */
import assert from 'node:assert/strict'
import { createHash, createHmac, hkdfSync, generateKeyPairSync, sign, verify, createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes, createPrivateKey, createPublicKey } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'
import { createLocalOwnerGrantHandler, createOwnerGrantSigner, createOwnerJwtSigner, OWNER_GRANT_DOMAIN, OWNER_JWT_MAX_HOURS, OWNER_KEY_FILE, ownerGrantCanonical } from './owner-grant.mjs'
import { normalizeOwnerGrantBinding, OWNER_GOVERNANCE_ORGANS, planLocalBrokerAction, planLocalRuntimeAction, canonicalJson } from '../deploy/cloudflare/src/owner-grant-policy.mjs'
import { runMintOwnerJwt } from './mint-owner-jwt.mjs'
import { createAccessVerifier } from '../deploy/cloudflare/src/access.mjs'
import { createWorker } from '../deploy/cloudflare/src/worker.mjs'
import { createDurableGateLockoutStore } from '../deploy/cloudflare/src/gate-lockout.mjs'
import { X61HeadDurableObject, manifestId } from '../deploy/cloudflare/src/head-do.mjs'
import { createAumlokStore, AUMLOK_STORAGE_KEY, AUMLOK_LIMITS, verifyAumlokInviteReceipt, aumlokInvitePreimage, aumlokRequestAction, aumlokClass3Binding } from '../deploy/cloudflare/src/aumlok.mjs'
import { isoCBOR } from '@simplewebauthn/server/helpers'
import { verifyAuthenticationResponse } from '@simplewebauthn/server'
import {
  assertModelSourcePath,
  planModelIntegrationAction,
  planModelRepoAction,
  readModelRepositoryStatus,
  readModelSourceFile,
} from '../deploy/cloudflare/src/model-host-policy.mjs'
import {
  ownerGrantCanonical as browserCanonical,
  verifyOwnerAttestation,
} from '../apps/web/src/spatial/superagent/owner-grant.ts'

const NOW = 1794000000000
const ORIGIN = 'https://owner-fixture.example.invalid'
const KEY_ROUTE = '/_host/owner-key'
const GRANT_ROUTE = '/_host/owner-grant'
const POSIX_ONLY = process.platform === 'win32' ? 'Requires POSIX permissions and link semantics' : false

// Synthetic WebAuthn messages use ephemeral test keys, never a host or authenticator.
const SYNTHETIC_ROOT = Object.freeze({ sealedRootKeyB64: Buffer.alloc(48, 19).toString('base64url'), kdfSaltB64: Buffer.alloc(32, 37).toString('base64url'),
  kdfIterations: 600000, ivB64: Buffer.alloc(12, 41).toString('base64url') })
function aumlokFixture({ approve = true, onApproval, approvalGranted = true, ownerKey = 'independent', passkeyAlgorithm = 'p256', pepperSecret } = {}) {
  const node = generateKeyPairSync('ed25519'), approver = generateKeyPairSync('ed25519')
  const passkey = passkeyAlgorithm === 'node' ? node : passkeyAlgorithm === 'ed25519' ? generateKeyPairSync('ed25519') : generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const publicJwk = passkey.publicKey.export({ format: 'jwk' })
  const credentialId = Buffer.alloc(32, 23).toString('base64url')
  const cose = isoCBOR.encode(new Map(passkeyAlgorithm === 'p256'
    ? [[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(publicJwk.x, 'base64url')], [-3, Buffer.from(publicJwk.y, 'base64url')]]
    : [[1, 1], [3, -8], [-1, 6], [-2, Buffer.from(publicJwk.x, 'base64url')]]))
  const nodePubkeyHex = node.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex')
  const nodeCredentialPublicKeyB64 = Buffer.from(isoCBOR.encode(new Map([[1, 1], [3, -8], [-1, 6], [-2, Buffer.from(nodePubkeyHex, 'hex')]]))).toString('base64url')
  const ownerPublicKeyHex = ownerKey === 'missing' ? undefined : ownerKey === 'node' ? nodePubkeyHex : approver.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex')
  let at = NOW, value, queue = Promise.resolve(), counter = 0
  const storage = { transaction(operation) {
    const run = queue.then(async () => {
      let next = structuredClone(value)
      const result = await operation({ async get(key) { assert.equal(key, AUMLOK_STORAGE_KEY); return structuredClone(next) }, async put(key, incoming) { assert.equal(key, AUMLOK_STORAGE_KEY); next = structuredClone(incoming) } })
      value = next
      return result
    })
    queue = run.catch(() => undefined)
    return run
  } }
  const options = { origins: [ORIGIN], now: () => at, ownerPublicKeyHex, pepperSecret, ...(approve ? { authorizeEnrollment: async (intent, context) => {
    assert.equal(intent.genesis, true); assert.equal(intent.registrationVerified, true); assert.equal(intent.assertionVerified, true); assert.equal(intent.nodeProofVerified, true)
    assert.equal(context.access.email, 'owner@example.invalid')
    const signature = sign(null, Buffer.from(intent.intentHash), approver.privateKey)
    const authorized = approvalGranted && verify(null, Buffer.from(intent.intentHash), approver.publicKey, signature)
    if (onApproval) onApproval(() => { at += AUMLOK_LIMITS.challengeMs })
    return { authorized, intentHash: intent.intentHash }
  } } : {}) }
  const rawStore = createAumlokStore(storage, options)
  const transport = () => ({ access: { email: 'owner@example.invalid', type: 'owner', expires: (at + 3600000) / 1000 }, ip: '203.0.113.7' })
  const store = { ...rawStore, challenge: (input, origin, context = transport()) => rawStore.challenge(input, origin, context),
    complete: (purpose, input, origin, context = transport()) => rawStore.complete(purpose, input, origin, context),
    consumeApproval: (token, binding, origin, context = transport()) => rawStore.consumeApproval(token, binding, origin, context) }
  function client(challenge, type = 'webauthn.get', overrides = {}) {
    return Buffer.from(JSON.stringify({ type, challenge: challenge.publicKey.challenge, origin: ORIGIN, crossOrigin: false, ...overrides })).toString('base64url')
  }
  function registration(challenge, flags = 0x45) {
    const auth = Buffer.alloc(37 + 16 + 2 + 32)
    createHash('sha256').update(new URL(ORIGIN).hostname).digest().copy(auth)
    auth[32] = flags
    auth.writeUInt16BE(32, 53); Buffer.from(credentialId, 'base64url').copy(auth, 55)
    const attestationObject = Buffer.from(isoCBOR.encode(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', Buffer.concat([auth, Buffer.from(cose)])]]))).toString('base64url')
    return { id: credentialId, rawId: credentialId, type: 'public-key', clientExtensionResults: {}, response: { clientDataJSON: client(challenge, 'webauthn.create'), attestationObject } }
  }
  function assertion(challenge, { flags = 5, clientOverrides = {}, wrongKey = false, nodeKey = false, rpId = new URL(ORIGIN).hostname } = {}) {
    const clientDataJSON = client(challenge, 'webauthn.get', clientOverrides)
    const auth = Buffer.alloc(37)
    createHash('sha256').update(rpId).digest().copy(auth)
    auth[32] = flags; auth.writeUInt32BE(++counter, 33)
    const signed = Buffer.concat([auth, createHash('sha256').update(Buffer.from(clientDataJSON, 'base64url')).digest()])
    const key = nodeKey ? node.privateKey : wrongKey ? (passkeyAlgorithm === 'p256' ? generateKeyPairSync('ec', { namedCurve: 'prime256v1' }) : generateKeyPairSync('ed25519')).privateKey : passkey.privateKey
    return { id: credentialId, rawId: credentialId, type: 'public-key', clientExtensionResults: {}, response: { clientDataJSON,
      authenticatorData: auth.toString('base64url'), signature: sign(key.asymmetricKeyType === 'ed25519' ? null : 'sha256', signed, key).toString('base64url') } }
  }
  async function prepareBind(root = SYNTHETIC_ROOT) {
    const challenge = await store.challenge({ purpose: 'bind', requestId: 'fixture-bind', commitmentSha256: 'a'.repeat(64), nodePubkeyHex, ...root }, ORIGIN)
    return store.complete('bind', { challengeId: challenge.challengeId, credential: registration(challenge) }, ORIGIN)
  }
  const nodeSignature = preimage => sign(null, Buffer.from(preimage), node.privateKey).toString('base64url')
  async function bind(root) {
    const challenge = await prepareBind(root)
    const input = { challengeId: challenge.challengeId, credential: assertion(challenge), nodeSignature: nodeSignature(challenge.nodeProofPreimage) }
    return { result: await store.complete('bind', input, ORIGIN), input, challenge }
  }
  function sealRoot(phrase) {
    const salt = randomBytes(32), iv = randomBytes(12), rootSeed = node.privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32)
    const cipher = createCipheriv('aes-256-gcm', pbkdf2Sync(phrase, salt, 600000, 32, 'sha256'), iv)
    const ciphertext = Buffer.concat([cipher.update(rootSeed), cipher.final(), cipher.getAuthTag()])
    return { sealedRootKeyB64: ciphertext.toString('base64url'), kdfSaltB64: salt.toString('base64url'), kdfIterations: 600000, ivB64: iv.toString('base64url') }
  }
  return { store, rawStore, storage, nodePubkeyHex, ownerPublicKeyHex, nodeCredentialPublicKeyB64, registration, assertion, prepareBind, bind, nodeSignature, sealRoot, transport,
    now: () => at, reopen: secret => createAumlokStore(storage, { ...options, pepperSecret: secret }),
    state: () => structuredClone(value), advance: amount => { at += amount }, replace: incoming => { value = structuredClone(incoming) } }
}

test('AUMLOK production seam is unbound and refuses raw secrets before storage', async () => {
  const fixture = aumlokFixture({ approve: false })
  assert.equal((await fixture.store.status()).bound, false)
  await assert.rejects(() => fixture.store.challenge({ purpose: 'bind', requestId: 'safe', commitmentSha256: 'a'.repeat(64), nodePubkeyHex: fixture.nodePubkeyHex }, ORIGIN), { code: 'AUMLOK_TRUSTED_ENROLLMENT_UNAVAILABLE' })
  for (const payload of [{ phrase: 'never persist' }, { proof: { words: ['never persist'] } }, { response: { private_key: 'never persist' } }, { nested: { biometric: true } }]) {
    await assert.rejects(() => fixture.store.challenge(payload, ORIGIN), { code: 'CLASS4_RAW_SECRET_FORBIDDEN', status: 400 })
  }
  assert.equal(fixture.state(), undefined)
})

test('AUMLOK registration stays unbound until verified assertion and node signature without network', async t => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => { throw new Error('Unexpected verification network request') }
  t.after(() => { globalThis.fetch = originalFetch })
  const fixture = aumlokFixture(), challenge = await fixture.prepareBind()
  assert.equal(challenge.phase, 'PENDING_ASSERTION')
  assert.equal((await fixture.store.status()).bound, false)
  const input = { challengeId: challenge.challengeId, credential: fixture.assertion(challenge), nodeSignature: fixture.nodeSignature(challenge.nodeProofPreimage) }
  const stored = fixture.state().challenges.at(-1).credential
  const checked = await verifyAuthenticationResponse({ response: input.credential, expectedChallenge: challenge.publicKey.challenge,
    expectedOrigin: ORIGIN, expectedRPID: new URL(ORIGIN).hostname, requireUserVerification: true,
    credential: { id: stored.id, publicKey: Buffer.from(stored.publicKeyB64, 'base64url'), counter: stored.counter } })
  assert.equal(checked.verified, true)
  const result = await fixture.store.complete('bind', input, ORIGIN)
  assert.equal(result.phase, 'BOUND'); assert.equal(result.passkeyVerified, true)
  assert.equal(result.biometricVerified, false); assert.equal(result.nodePubkeyHex, fixture.nodePubkeyHex)
  assert.equal((await fixture.store.complete('bind', input, ORIGIN)).idempotent, true)
  assert.equal(JSON.stringify(fixture.state()).includes('clientDataJSON'), false)
})

test('AUMLOK rejects missing UV, wrong origin or RP, challenge replay, forged signatures and node substitution', async () => {
  for (const variation of [{ flags: 1 }, { rpId: 'wrong.example.invalid' }, { clientOverrides: { origin: 'https://attacker.example.invalid' } }, { clientOverrides: { challenge: 'wrong' } }, { clientOverrides: { crossOrigin: true, topOrigin: ORIGIN } }, { wrongKey: true }, { nodeWrong: true }]) {
    const fixture = aumlokFixture(), challenge = await fixture.prepareBind()
    const input = { challengeId: challenge.challengeId, credential: fixture.assertion(challenge, variation), nodeSignature: fixture.nodeSignature(variation.nodeWrong ? 'wrong intent' : challenge.nodeProofPreimage) }
    const result = await fixture.store.complete('bind', input, ORIGIN)
    assert.equal(result.ok, false, JSON.stringify(variation)); assert.equal((await fixture.store.status()).bound, false)
    fixture.advance(AUMLOK_LIMITS.backoffMs)
    await assert.rejects(() => fixture.store.complete('bind', input, ORIGIN), { code: 'AUMLOK_CHALLENGE_USED' })
  }
})

test('AUMLOK late approval consumes challenge without changing authoritative state', async () => {
  const fixture = aumlokFixture({ onApproval: expire => expire() })
  const { result } = await fixture.bind()
  assert.equal(result.code, 'AUMLOK_CHALLENGE_EXPIRED')
  const state = fixture.state()
  assert.equal(state.binding, null); assert.equal(state.generation, 0)
  assert.equal(state.invites.length, 0); assert.equal(state.challenges.at(-1).outcome, 'AUMLOK_CHALLENGE_EXPIRED')
})

test('AUMLOK refresh requires stored passkey and cannot use public commitment or browser flags', async () => {
  const fixture = aumlokFixture(); assert.equal((await fixture.bind()).result.bound, true)
  await assert.rejects(() => fixture.store.challenge({ purpose: 'refresh', requestId: 'bad-refresh', commitmentSha256: 'b'.repeat(64), currentPhraseVerified: true }, ORIGIN), { code: 'CLASS4_RAW_SECRET_FORBIDDEN' })
  const challenge = await fixture.store.challenge({ purpose: 'refresh', requestId: 'refresh-1', commitmentSha256: 'b'.repeat(64), ...SYNTHETIC_ROOT }, ORIGIN)
  const input = { challengeId: challenge.challengeId, credential: fixture.assertion(challenge), nodeSignature: fixture.nodeSignature(challenge.nodeProofPreimage) }
  const result = await fixture.store.complete('refresh', input, ORIGIN)
  assert.equal(result.commitmentSha256, null); assert.equal(result.bound, true)
  assert.equal((await fixture.store.complete('refresh', input, ORIGIN)).idempotent, true)
  await assert.rejects(() => fixture.store.complete('refresh', { ...input, credential: fixture.assertion(challenge) }, ORIGIN), { code: 'AUMLOK_CHALLENGE_USED' })
})

test('AUMLOK invites verify bound sponsor, cap issuance, and retain append-only revocations', async () => {
  const fixture = aumlokFixture(); assert.equal((await fixture.bind()).result.bound, true)
  const issued = []
  for (let index = 0; index < 3; index++) {
    fixture.advance(AUMLOK_LIMITS.challengeMs)
    const challenge = await fixture.store.challenge({ purpose: 'invite', requestId: 'invite-' + index, inviteeCommitmentSha256: 'c'.repeat(64), assignedDomainPointer: 'https://invite.example.invalid' }, ORIGIN)
    const input = { challengeId: challenge.challengeId, credential: fixture.assertion(challenge), signature: fixture.nodeSignature(challenge.signaturePreimage) }
    const result = await fixture.store.complete('invite', input, ORIGIN)
    assert.equal(result.ok, true); assert.equal(result.invite.monthlySequence, index + 1)
    assert.equal(await verifyAumlokInviteReceipt(result.invite, fixture.nodePubkeyHex), true)
    assert.equal(await verifyAumlokInviteReceipt({ ...result.invite, assignedDomainPointer: 'https://other.example.invalid' }, fixture.nodePubkeyHex), false)
    assert.equal(await verifyAumlokInviteReceipt(result.invite, 'd'.repeat(64)), false)
    assert.equal((await fixture.store.complete('invite', input, ORIGIN)).idempotent, true)
    issued.push(result.invite)
  }
  await assert.rejects(() => fixture.store.challenge({ purpose: 'invite', requestId: 'fourth-invite', inviteeCommitmentSha256: 'c'.repeat(64), assignedDomainPointer: null }, ORIGIN), { code: 'AUMLOK_INVITE_MONTHLY_LIMIT' })
  fixture.advance(AUMLOK_LIMITS.backoffMs)
  const challenge = await fixture.store.challenge({ purpose: 'invite', action: 'revoke', requestId: 'revoke-1', inviteId: issued[0].inviteId }, ORIGIN)
  const result = await fixture.store.complete('invite', { challengeId: challenge.challengeId, credential: fixture.assertion(challenge), signature: fixture.nodeSignature(challenge.signaturePreimage) }, ORIGIN)
  assert.equal(result.ok, true); assert.equal(result.invite.issuedThisMonth, 3); assert.equal(result.invite.revokedCount, 1)
  assert.deepEqual(fixture.state().invites, issued)
})

test('AUMLOK exact routes reject query, wrong methods and cross-origin POST', () => {
  const post = { method: 'POST', headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' } }
  assert.equal(aumlokRequestAction(new Request(ORIGIN + '/_host/aumlok/status'), [ORIGIN]), 'status')
  assert.equal(aumlokRequestAction(new Request(ORIGIN + '/_host/aumlok/challenge', post), [ORIGIN]), 'challenge')
  assert.throws(() => aumlokRequestAction(new Request(ORIGIN + '/_host/aumlok/challenge?x=1', post), [ORIGIN]), { code: 'AUMLOK_ROUTE_NOT_FOUND' })
  assert.throws(() => aumlokRequestAction(new Request(ORIGIN + '/_host/aumlok/challenge', { method: 'POST' }), [ORIGIN]), { code: 'AUMLOK_ORIGIN_REQUIRED' })
})

test('AUMLOK challenges bind intent, reject arbitrary SPKI, and expire with bounded retained state', async () => {
  const fixture = aumlokFixture()
  const request = { purpose: 'bind', requestId: 'bound-intent', commitmentSha256: 'a'.repeat(64), nodePubkeyHex: fixture.nodePubkeyHex, ...SYNTHETIC_ROOT }
  const challenge = await fixture.store.challenge(request, ORIGIN)
  assert.equal((await fixture.store.challenge(request, ORIGIN)).challengeId, challenge.challengeId)
  await assert.rejects(() => fixture.store.challenge({ ...request, commitmentSha256: 'b'.repeat(64) }, ORIGIN), { code: 'AUMLOK_IDEMPOTENCY_CONFLICT' })
  fixture.advance(1000)
  await assert.rejects(() => fixture.store.complete('refresh', { challengeId: challenge.challengeId, credential: fixture.registration(challenge) }, ORIGIN), { code: 'AUMLOK_CHALLENGE_BINDING_MISMATCH' })
  fixture.advance(2000)
  await assert.rejects(() => fixture.store.complete('bind', { challengeId: challenge.challengeId, credential: fixture.registration(challenge), publicKeySpkiB64: 'fake' }, ORIGIN), { code: 'AUMLOK_REQUEST_INVALID' })
  fixture.advance(4000)
  for (let index = 1; index < AUMLOK_LIMITS.challenges; index++) await fixture.store.challenge({ ...request, requestId: 'bounded-' + index }, ORIGIN)
  await assert.rejects(() => fixture.store.challenge({ ...request, requestId: 'overflow' }, ORIGIN), { code: 'AUMLOK_CHALLENGE_CAPACITY' })
  fixture.advance(AUMLOK_LIMITS.challengeMs)
  await assert.rejects(() => fixture.store.complete('bind', { challengeId: challenge.challengeId, credential: fixture.registration(challenge) }, ORIGIN), { code: 'AUMLOK_CHALLENGE_EXPIRED' })
  fixture.advance(3600000)
  await fixture.store.challenge({ ...request, requestId: 'after-expiry' }, ORIGIN)
  assert.equal(fixture.state().challenges.length, 1)
  const corrupt = fixture.state(); corrupt.binding = { bound: true }; fixture.replace(corrupt)
  await assert.rejects(() => fixture.store.status(), { code: 'AUMLOK_STATE_CORRUPT' })
})

test('AUMLOK full issuance storage still reserves authenticated append-only revocation', async () => {
  const fixture = aumlokFixture(); await fixture.bind()
  const state = fixture.state()
  for (let index = 0; index < AUMLOK_LIMITS.inviteRecords; index++) {
    const issuedAt = NOW - (index + 1) * 35 * 86400000
    const payload = { schema: 'aukora.invite.v1', inviteId: Buffer.alloc(32, index + 1).toString('base64url'), sponsorPubkeyHex: fixture.nodePubkeyHex,
      inviteeCommitmentSha256: 'a'.repeat(64), assignedDomainPointer: null, quotaMonth: new Date(issuedAt).toISOString().slice(0, 7), monthlySequence: 1,
      revoked: false, issuedAt, expiresAt: issuedAt + 604800000 }
    state.invites.push({ ...payload, signature: fixture.nodeSignature(aumlokInvitePreimage(payload)) })
  }
  fixture.replace(state); fixture.advance(AUMLOK_LIMITS.challengeMs)
  await assert.rejects(() => fixture.store.challenge({ purpose: 'invite', requestId: 'full-issue', inviteeCommitmentSha256: 'b'.repeat(64), assignedDomainPointer: null }, ORIGIN), { code: 'AUMLOK_INVITE_CAPACITY' })
  fixture.advance(AUMLOK_LIMITS.backoffMs)
  const challenge = await fixture.store.challenge({ purpose: 'invite', action: 'revoke', requestId: 'full-revoke', inviteId: state.invites[0].inviteId }, ORIGIN)
  const result = await fixture.store.complete('invite', { challengeId: challenge.challengeId, credential: fixture.assertion(challenge), signature: fixture.nodeSignature(challenge.signaturePreimage) }, ORIGIN)
  assert.equal(result.ok, true); assert.equal(fixture.state().revocations.length, 1)
  assert.deepEqual(fixture.state().invites, state.invites)
})


function binding(overrides = {}) {
  return {
    mandateId: 'fixture-mandate',
    ticketId: 'fixture-ticket',
    scope: { organs: ['seed-calc'], z: ['review', { b: true, a: null }], a: 'read-only', expiresAt: NOW + 60000 },
    ballId: 'a'.repeat(64),
    epoch: 7,
    expiresAt: NOW + 60000,
    identity: 'Fixture Owner',
    ...overrides,
  }
}

test('AUMLOK escrow is peppered, private, and rotated with unchanged node-key possession', async () => {
  const fixture = aumlokFixture(), original = fixture.sealRoot('synthetic original phrase')
  assert.equal((await fixture.bind(original)).result.bound, true)
  const firstState = fixture.state(), serialized = JSON.stringify(firstState), status = await fixture.store.status()
  assert.equal(firstState.schema, 'aukora.aumlok.state.v2')
  assert.equal(Buffer.from(firstState['pepper.v1'], 'base64url').length, 32)
  assert.equal(serialized.includes('"commitmentSha256"'), false)
  assert.equal(serialized.includes('a'.repeat(64)), false)
  assert.equal(serialized.includes(original.sealedRootKeyB64), false)
  assert.equal(firstState.binding.rootEscrow.schema, 'aukora.aumlok.escrow.v3')
  assert.equal(firstState.binding.rootEscrow.kdfSaltB64, original.kdfSaltB64, 'HKDF salt is public; client ciphertext remains encrypted')
  assert.equal(JSON.stringify(status).includes(firstState['pepper.v1']), false)
  assert.equal(status.commitmentSha256, null)
  assert.equal(status.rotationSeq, 0)
  assert.equal(status.lastRotationChallengeId, null)
  assert.match(status.keyCommitmentId, /^[0-9a-f]{64}$/)
  fixture.advance(AUMLOK_LIMITS.challengeMs)
  const read = async (requestId, commitmentSha256 = 'a'.repeat(64)) => {
    const challenge = await fixture.store.challenge({ purpose: 'unseal', requestId }, ORIGIN)
    const input = { challengeId: challenge.challengeId, credential: fixture.assertion(challenge), commitmentSha256 }
    return { result: await fixture.store.complete('unseal', input, ORIGIN), input }
  }
  assert.deepEqual((await read('first-unseal')).result.sealedRoot, original)
  assert.equal((await fixture.store.status()).keyCommitmentId, status.keyCommitmentId, 'Verification does not change the root revision')
  const rotated = fixture.sealRoot('synthetic replacement phrase')
  const challenge = await fixture.store.challenge({ purpose: 'refresh', requestId: 'root-rotation', commitmentSha256: 'b'.repeat(64), ...rotated }, ORIGIN)
  const refresh = await fixture.store.complete('refresh', { challengeId: challenge.challengeId, credential: fixture.assertion(challenge), nodeSignature: fixture.nodeSignature(challenge.nodeProofPreimage) }, ORIGIN)
  assert.equal(refresh.ok, true); assert.equal(refresh.nodePubkeyHex, fixture.nodePubkeyHex)
  assert.equal(refresh.rotationSeq, 1)
  assert.equal(refresh.lastRotationChallengeId, challenge.challengeId)
  assert.equal((await fixture.store.status()).lastRotationChallengeId, challenge.challengeId)
  assert.notEqual(refresh.keyCommitmentId, status.keyCommitmentId)
  assert.equal((await fixture.store.status()).keyCommitmentId, refresh.keyCommitmentId, 'A dropped response can be reconciled with durable status')
  assert.equal(fixture.state()['pepper.v1'], firstState['pepper.v1'])
  assert.notEqual(fixture.state().binding.recoveryCommitment, firstState.binding.recoveryCommitment)
  const { result, input } = await read('rotated-unseal', 'b'.repeat(64))
  assert.deepEqual(result.sealedRoot, rotated)
  const ciphertext = Buffer.from(result.sealedRoot.sealedRootKeyB64, 'base64url')
  const decipher = createDecipheriv('aes-256-gcm', pbkdf2Sync('synthetic replacement phrase', Buffer.from(rotated.kdfSaltB64, 'base64url'), rotated.kdfIterations, 32, 'sha256'), Buffer.from(rotated.ivB64, 'base64url'))
  decipher.setAuthTag(ciphertext.subarray(-16))
  const root = Buffer.concat([decipher.update(ciphertext.subarray(0, -16)), decipher.final()])
  const key = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), root]), format: 'der', type: 'pkcs8' })
  assert.equal(createPublicKey(key).export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex'), fixture.nodePubkeyHex)
  await assert.rejects(() => fixture.store.complete('unseal', input, ORIGIN), { code: 'AUMLOK_CHALLENGE_USED' })
})

test('AUMLOK independent enrollment approval cannot be replaced by ambient Access and a new software passkey', async () => {
  const fixture = aumlokFixture({ approvalGranted: false })
  const { result } = await fixture.bind()
  assert.equal(result.code, 'AUMLOK_TRUSTED_ENROLLMENT_REQUIRED')
  assert.equal(fixture.state().binding, null)
  // A refusal by policy (no independent approval) is never a failed passkey (the one rule).
  assert.equal(fixture.state().failures, 0)
  assert.equal(fixture.state().enrollmentCount, 0)
  assert.deepEqual(fixture.state().enrollments, [])
})

test('AUMLOK HKDF escrow requires the pepper and rejects altered authenticated metadata', async () => {
  const fixture = aumlokFixture(); await fixture.bind()
  const state = fixture.state(), escrow = state.binding.rootEscrow
  assert.equal(JSON.stringify(state).includes('sealedRootKeyB64'), false)
  const open = (pepper, nodePubkeyHex = fixture.nodePubkeyHex) => {
    const key = hkdfSync('sha256', pepper, Buffer.from(escrow.kdfSaltB64, 'base64url'), 'aukora.aumlok.escrow-wrap.v2', 32)
    const cipher = Buffer.from(escrow.ciphertextB64, 'base64url'), decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(escrow.ivB64, 'base64url'))
    decipher.setAAD(Buffer.from(escrow.schema + '\0' + nodePubkeyHex + '\0' + state.binding.recoveryCommitment))
    decipher.setAuthTag(cipher.subarray(-16))
    return JSON.parse(Buffer.concat([decipher.update(cipher.subarray(0, -16)), decipher.final()]).toString())
  }
  assert.deepEqual(open(Buffer.from(state['pepper.v1'], 'base64url')), SYNTHETIC_ROOT)
  assert.throws(() => open(Buffer.alloc(32)))
  assert.throws(() => open(Buffer.from(state['pepper.v1'], 'base64url'), 'f'.repeat(64)))
  // The pepper remains in private state; this test does not claim protection from theft of that entire state.
})

test('AUMLOK legacy v2 escrow and approval rows remain readable without rewriting status', async () => {
  const fixture = aumlokFixture(); await fixture.bind()
  const { action, result } = await class3Approval(fixture)
  const legacy = fixture.state(), iv = randomBytes(12)
  const key = createHmac('sha256', Buffer.from(legacy['pepper.v1'], 'base64url')).update('aukora.aumlok.escrow-key.v2\0').digest()
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(Buffer.from('aukora.aumlok.escrow.v2\0' + fixture.nodePubkeyHex + '\0' + legacy.binding.recoveryCommitment))
  legacy.binding.rootEscrow = { schema: 'aukora.aumlok.escrow.v2', ivB64: iv.toString('base64url'),
    ciphertextB64: Buffer.concat([cipher.update(canonicalJson(SYNTHETIC_ROOT)), cipher.final(), cipher.getAuthTag()]).toString('base64url') }
  delete legacy.enrollmentCount; delete legacy.enrollments
  for (const approval of legacy.approvals) { delete approval.approvalId; delete approval.approvedAt; delete approval.recordMac }
  fixture.replace(legacy)
  const status = await fixture.store.status()
  assert.equal(status.enrollmentCount, 1)
  assert.deepEqual(status.approvedGrants, [], 'Legacy rows are not fabricated as signed public records')
  assert.deepEqual(fixture.state(), legacy)
  assert.equal((await fixture.store.verifyApproval(result.approvalToken, action, ORIGIN)).ok, true)
  const challenge = await fixture.store.challenge({ purpose: 'unseal', requestId: 'old-wrapper' }, ORIGIN)
  const unsealed = await fixture.store.complete('unseal', { challengeId: challenge.challengeId, credential: fixture.assertion(challenge), commitmentSha256: 'a'.repeat(64) }, ORIGIN)
  assert.deepEqual(unsealed.sealedRoot, SYNTHETIC_ROOT); assert.equal(unsealed.phraseVerified, true)
  assert.equal(fixture.state().binding.rootEscrow.schema, 'aukora.aumlok.escrow.v2')
})

test('AUMLOK optional Worker pepper protects new escrow without persisting or publishing the secret', async () => {
  const pepperSecret = Buffer.alloc(32, 91).toString('base64url'), fixture = aumlokFixture({ pepperSecret })
  assert.equal((await fixture.store.status()).pepperSeparated, false)
  assert.equal(fixture.state(), undefined, 'Configuration and status do not initialize or migrate custody')
  const { result } = await fixture.bind(), state = fixture.state()
  assert.equal(result.pepperSeparated, true); assert.equal(result.pepperMigrationRequired, false)
  assert.equal(state.pepperProtection.schema, 'aukora.aumlok.pepper.v2')
  assert.equal(state.binding.rootEscrow.schema, 'aukora.aumlok.escrow.v4')
  assert.equal(JSON.stringify(state).includes(pepperSecret), false)
  assert.equal(JSON.stringify(result).includes(state.pepperProtection.keyCheck), false)
  const material = hkdfSync('sha256', Buffer.from(pepperSecret, 'base64url'), Buffer.from(state['pepper.v1'], 'base64url'), 'aukora.aumlok.separated-pepper.v1', 32)
  const expectedCommitment = createHmac('sha256', material).update('aukora.aumlok.recovery.v2\0' + 'a'.repeat(64)).digest('hex')
  assert.equal(state.binding.recoveryCommitment, expectedCommitment)
  const escrow = state.binding.rootEscrow
  const decrypt = pepper => {
    const key = hkdfSync('sha256', pepper, Buffer.from(escrow.kdfSaltB64, 'base64url'), 'aukora.aumlok.escrow-wrap.v3', 32)
    const ciphertext = Buffer.from(escrow.ciphertextB64, 'base64url'), decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(escrow.ivB64, 'base64url'))
    decipher.setAAD(Buffer.from(escrow.schema + '\0' + fixture.nodePubkeyHex + '\0' + state.binding.recoveryCommitment))
    decipher.setAuthTag(ciphertext.subarray(-16))
    return JSON.parse(Buffer.concat([decipher.update(ciphertext.subarray(0, -16)), decipher.final()]).toString())
  }
  assert.throws(() => decrypt(Buffer.from(state['pepper.v1'], 'base64url')), 'DO state alone cannot decrypt separated escrow')
  assert.deepEqual(decrypt(material), SYNTHETIC_ROOT)
  const reopened = fixture.reopen(pepperSecret)
  assert.equal((await reopened.status()).pepperSeparated, true)
  const challenge = await reopened.challenge({ purpose: 'unseal', requestId: 'separated-unseal' }, ORIGIN, fixture.transport())
  assert.deepEqual((await reopened.complete('unseal', { challengeId: challenge.challengeId, credential: fixture.assertion(challenge), commitmentSha256: 'a'.repeat(64) }, ORIGIN, fixture.transport())).sealedRoot, SYNTHETIC_ROOT)
  fixture.advance(AUMLOK_LIMITS.challengeMs)
  const approval = await class3Approval(fixture)
  assert.equal((await reopened.verifyApproval(approval.result.approvalToken, approval.action, ORIGIN)).ok, true)
})

test('AUMLOK separated custody refuses missing or changed secrets without status or mutation downgrade', async () => {
  const pepperSecret = Buffer.alloc(32, 93).toString('base64url'), fixture = aumlokFixture({ pepperSecret })
  await fixture.bind()
  const { action, result } = await class3Approval(fixture), before = fixture.state()
  for (const [secret, code] of [[undefined, 'AUMLOK_PEPPER_SECRET_REQUIRED'], [Buffer.alloc(32, 94).toString('base64url'), 'AUMLOK_PEPPER_SECRET_MISMATCH']]) {
    const reopened = fixture.reopen(secret)
    await assert.rejects(() => reopened.status(), { code, status: 503 })
    await assert.rejects(() => reopened.challenge({ purpose: 'unseal', requestId: 'secret-changed' }, ORIGIN, fixture.transport()), { code })
    await assert.rejects(() => reopened.complete('unseal', { challengeId: 'malformed' }, ORIGIN, fixture.transport()), { code })
    await assert.rejects(() => reopened.verifyApproval(result.approvalToken, action, ORIGIN), { code })
    await assert.rejects(() => reopened.consumeApproval(result.approvalToken, action, ORIGIN, fixture.transport()), { code })
    assert.deepEqual(fixture.state(), before)
  }
  assert.equal((await fixture.reopen(pepperSecret).status()).bound, true, 'Restoring the exact secret restores reads without migration')
  assert.deepEqual(fixture.state(), before)
})

test('AUMLOK adding a secret preserves bound legacy v2 and v3 ciphertext, records and pending challenges', async () => {
  for (const version of [2, 3]) {
    const fixture = aumlokFixture(); await fixture.bind()
    const { action, result } = await class3Approval(fixture)
    const legacy = fixture.state()
    if (version === 2) {
      const iv = randomBytes(12), key = createHmac('sha256', Buffer.from(legacy['pepper.v1'], 'base64url')).update('aukora.aumlok.escrow-key.v2\0').digest()
      const cipher = createCipheriv('aes-256-gcm', key, iv)
      cipher.setAAD(Buffer.from('aukora.aumlok.escrow.v2\0' + fixture.nodePubkeyHex + '\0' + legacy.binding.recoveryCommitment))
      legacy.binding.rootEscrow = { schema: 'aukora.aumlok.escrow.v2', ivB64: iv.toString('base64url'),
        ciphertextB64: Buffer.concat([cipher.update(canonicalJson(SYNTHETIC_ROOT)), cipher.final(), cipher.getAuthTag()]).toString('base64url') }
    }
    delete legacy.pepperProtection; delete legacy.phraseFailures; delete legacy.phraseFailedAt; delete legacy.phraseNextAllowedAt; delete legacy.lastRotationChallengeId
    fixture.replace(legacy)
    const reopened = fixture.reopen(Buffer.alloc(32, 95).toString('base64url'))
    const status = await reopened.status()
    assert.equal(status.pepperSeparated, false); assert.equal(status.pepperMigrationRequired, true)
    assert.equal(status.lastRotationChallengeId, null); assert.deepEqual(status.phraseBlockers, [])
    assert.deepEqual(fixture.state(), legacy, 'Status does not add compatibility fields or re-MAC anything')
    assert.equal((await reopened.verifyApproval(result.approvalToken, action, ORIGIN)).ok, true)
    const challenge = await reopened.challenge({ purpose: 'unseal', requestId: 'legacy-under-secret' }, ORIGIN, fixture.transport())
    assert.deepEqual((await reopened.complete('unseal', { challengeId: challenge.challengeId, credential: fixture.assertion(challenge), commitmentSha256: 'a'.repeat(64) }, ORIGIN, fixture.transport())).sealedRoot, SYNTHETIC_ROOT)
    const after = fixture.state()
    assert.deepEqual(after.binding.rootEscrow, legacy.binding.rootEscrow); assert.deepEqual(after.enrollments, legacy.enrollments)
    assert.deepEqual(after.approvals, legacy.approvals); assert.equal(after.pepperProtection, null)
    assert.equal((await fixture.reopen(undefined).status()).pepperSeparated, false)
    assert.equal((await fixture.reopen(Buffer.alloc(32, 96).toString('base64url')).status()).pepperMigrationRequired, true)
  }
})

test('AUMLOK pre-bind legacy custody remains legacy when a Worker secret is added', async () => {
  const fixture = aumlokFixture(), challenge = await fixture.prepareBind(), before = fixture.state()
  const reopened = fixture.reopen(Buffer.alloc(32, 97).toString('base64url'))
  const status = await reopened.status()
  assert.equal(status.bound, false); assert.equal(status.pepperSeparated, false); assert.equal(status.pepperMigrationRequired, true)
  assert.deepEqual(fixture.state(), before)
  const result = await reopened.complete('bind', { challengeId: challenge.challengeId, credential: fixture.assertion(challenge), nodeSignature: fixture.nodeSignature(challenge.nodeProofPreimage) }, ORIGIN, fixture.transport())
  assert.equal(result.bound, true); assert.equal(result.pepperSeparated, false); assert.equal(result.pepperMigrationRequired, true)
  assert.equal(fixture.state()['pepper.v1'], before['pepper.v1'])
  assert.equal(fixture.state().binding.rootEscrow.schema, 'aukora.aumlok.escrow.v3')
  assert.equal((await fixture.reopen(undefined).status()).bound, true)
})

test('AUMLOK invalid pepper configuration or version metadata fails closed', async () => {
  for (const pepperSecret of ['', null, 'raw secret', Buffer.alloc(31).toString('base64url'), Buffer.alloc(33).toString('base64url')]) {
    assert.throws(() => aumlokFixture({ pepperSecret }), { message: 'AUMLOK_CONFIGURATION_INVALID' })
  }
  const fixture = aumlokFixture({ pepperSecret: Buffer.alloc(32, 98).toString('base64url') }); await fixture.bind()
  const before = fixture.state()
  for (const change of [state => { delete state.pepperProtection }, state => { state.pepperProtection = null }, state => { state.pepperProtection = undefined }, state => { state.lastRotationChallengeId = undefined }, state => { state.pepperProtection.schema = 'unknown' }, state => { state.binding.rootEscrow.schema = 'aukora.aumlok.escrow.v3' }]) {
    const state = structuredClone(before); change(state); fixture.replace(state)
    await assert.rejects(() => fixture.store.status(), { code: 'AUMLOK_STATE_CORRUPT' })
    assert.deepEqual(fixture.state(), state)
  }
})

test('AUMLOK appends exactly one enrollment record and rejects a second enrollment', async () => {
  const fixture = aumlokFixture(), { input, result } = await fixture.bind()
  assert.equal(result.enrollmentCount, 1)
  const enrolled = fixture.state().enrollments
  assert.equal(enrolled.length, 1)
  assert.equal(enrolled[0].schema, 'aumlok.enrollment.v1')
  assert.equal(enrolled[0].ownerPublicKeyHex, fixture.ownerPublicKeyHex)
  assert.equal((await fixture.store.complete('bind', input, ORIGIN)).idempotent, true)
  await assert.rejects(() => fixture.store.challenge({ purpose: 'bind', requestId: 'second-enrollment', commitmentSha256: 'b'.repeat(64),
    nodePubkeyHex: fixture.nodePubkeyHex, ...SYNTHETIC_ROOT }, ORIGIN), { code: 'ENROLLMENT_ALREADY_BOUND', status: 409 })
  assert.deepEqual(fixture.state().enrollments, enrolled)
})

test('AUMLOK independently configured owner key must differ from the node at enrollment and approval use', async () => {
  for (const ownerKey of ['missing', 'node']) {
    const fixture = aumlokFixture({ ownerKey })
    assert.equal((await fixture.store.status()).bound, false)
    await assert.rejects(() => fixture.prepareBind(), { code: ownerKey === 'node' ? 'NODE_KEY_IS_NOT_OWNER_KEY' : 'AUMLOK_TRUSTED_ENROLLMENT_UNAVAILABLE' })
  }
  const fixture = aumlokFixture(); await fixture.bind()
  const { action, result } = await class3Approval(fixture)
  for (const ownerPublicKeyHex of [undefined, fixture.nodePubkeyHex]) {
    const store = createAumlokStore(fixture.storage, { origins: [ORIGIN], now: fixture.now, ownerPublicKeyHex })
    assert.equal((await store.status()).authorityAvailable, false)
    await assert.rejects(() => store.verifyApproval(result.approvalToken, action, ORIGIN),
      { code: ownerPublicKeyHex ? 'NODE_KEY_IS_NOT_OWNER_KEY' : 'AUMLOK_OWNER_KEY_UNAVAILABLE' })
    assert.equal(fixture.state().approvals[0].consumedAt, null)
  }
})

test('AUMLOK distinct Ed25519 passkeys remain usable for enrollment and Class3 approval', async () => {
  const fixture = aumlokFixture({ passkeyAlgorithm: 'ed25519' })
  assert.equal((await fixture.bind()).result.bound, true)
  const { action, result } = await class3Approval(fixture)
  assert.equal((await fixture.store.verifyApproval(result.approvalToken, action, ORIGIN)).ok, true)
  assert.equal((await fixture.store.consumeApproval(result.approvalToken, action, ORIGIN)).ok, true)
})

test('AUMLOK refuses an Ed25519 registration using the node key before requesting independent approval', async () => {
  let approvals = 0
  const fixture = aumlokFixture({ passkeyAlgorithm: 'node', onApproval: () => { approvals++ } })
  const result = await fixture.prepareBind()
  assert.equal(result.ok, false)
  assert.equal(result.code, 'NODE_KEY_IS_NOT_OWNER_KEY')
  assert.equal(approvals, 0)
  assert.equal(fixture.state().binding, null)
  assert.equal(fixture.state().enrollmentCount, 0)
  assert.deepEqual(fixture.state().enrollments, [])
})

test('AUMLOK pending legacy enrollment rejects a cryptographically valid node-key WebAuthn assertion', async () => {
  let approvals = 0
  const fixture = aumlokFixture({ passkeyAlgorithm: 'ed25519', onApproval: () => { approvals++ } })
  const challenge = await fixture.prepareBind(), state = fixture.state()
  const pending = state.challenges.find(value => value.id === challenge.challengeId)
  pending.credential.publicKeyB64 = fixture.nodeCredentialPublicKeyB64
  fixture.replace(state)
  const credential = fixture.assertion(challenge, { nodeKey: true })
  const verified = await verifyAuthenticationResponse({ response: credential, expectedChallenge: challenge.publicKey.challenge,
    expectedOrigin: ORIGIN, expectedRPID: new URL(ORIGIN).hostname, requireUserVerification: true,
    credential: { id: pending.credential.id, publicKey: Buffer.from(pending.credential.publicKeyB64, 'base64url'), counter: pending.credential.counter } })
  assert.equal(verified.verified, true, 'A software UV bit and node signature alone pass the ordinary WebAuthn verifier')
  const result = await fixture.store.complete('bind', { challengeId: challenge.challengeId, credential,
    nodeSignature: fixture.nodeSignature(challenge.nodeProofPreimage) }, ORIGIN)
  assert.equal(result.code, 'NODE_KEY_IS_NOT_OWNER_KEY')
  assert.equal(approvals, 0)
  assert.equal(fixture.state().binding, null)
  assert.equal(fixture.state().enrollmentCount, 0)
})

test('AUMLOK legacy node-key passkeys cannot issue, complete, verify or consume Class3 approvals', async () => {
  for (const operation of ['issue', 'complete', 'verify', 'consume', 'transaction']) {
    const fixture = aumlokFixture({ passkeyAlgorithm: 'ed25519' }); await fixture.bind()
    const { action, result } = await class3Approval(fixture)
    const challenge = operation === 'complete' ? await fixture.store.challenge({ purpose: 'approve', requestId: 'pending-legacy-approval', binding: action }, ORIGIN) : null
    const state = fixture.state()
    state.binding.credential.publicKeyB64 = fixture.nodeCredentialPublicKeyB64
    if (challenge) state.challenges.find(value => value.id === challenge.challengeId).credential.publicKeyB64 = fixture.nodeCredentialPublicKeyB64
    fixture.replace(state)
    const status = await fixture.store.status()
    assert.equal(status.bound, true)
    assert.equal(status.authorityAvailable, false)
    assert.deepEqual(status.blockers, ['NODE_KEY_IS_NOT_OWNER_KEY'])
    if (operation === 'complete') {
      const completed = await fixture.store.complete('approve', { challengeId: challenge.challengeId, credential: fixture.assertion(challenge, { nodeKey: true }) }, ORIGIN)
      assert.equal(completed.code, 'NODE_KEY_IS_NOT_OWNER_KEY')
    } else {
      const invoke = operation === 'issue' ? () => fixture.store.challenge({ purpose: 'approve', requestId: 'legacy-approval', binding: action }, ORIGIN)
        : operation === 'verify' ? () => fixture.store.verifyApproval(result.approvalToken, action, ORIGIN)
          : operation === 'consume' ? () => fixture.store.consumeApproval(result.approvalToken, action, ORIGIN)
            : () => fixture.storage.transaction(tx => fixture.store.consumeApprovalInTransaction(tx, result.approvalToken, action, ORIGIN))
      await assert.rejects(invoke, { code: 'NODE_KEY_IS_NOT_OWNER_KEY' }, operation)
    }
    assert.equal(fixture.state().approvals.length, 1)
    assert.equal(fixture.state().approvals[0].consumedAt, null)
    assert.equal(fixture.state().binding.nodePubkeyHex, fixture.nodePubkeyHex)
  }
})

test('AUMLOK genesis requires trusted unexpired Access and keeps its owner subject fixed', async () => {
  for (const context of [undefined, { access: true }, { access: { email: 'owner@example.invalid', type: 'owner', expires: NOW / 1000 } }]) {
    const fixture = aumlokFixture()
    await assert.rejects(() => fixture.rawStore.challenge({ purpose: 'bind', requestId: 'missing-access', commitmentSha256: 'a'.repeat(64), nodePubkeyHex: fixture.nodePubkeyHex, ...SYNTHETIC_ROOT }, ORIGIN, context), { code: 'AUMLOK_OWNER_ACCESS_REQUIRED' })
    assert.equal(fixture.state().binding, null)
  }
  const fixture = aumlokFixture(), challenge = await fixture.prepareBind()
  const context = fixture.transport(); context.access.email = 'different@example.invalid'
  await assert.rejects(() => fixture.store.complete('bind', { challengeId: challenge.challengeId, credential: fixture.assertion(challenge), nodeSignature: fixture.nodeSignature(challenge.nodeProofPreimage) }, ORIGIN, context), { code: 'AUMLOK_CHALLENGE_BINDING_MISMATCH' })
  assert.equal(fixture.state().binding, null)
})

test('AUMLOK refuses missing or underspecified sealed-root KDF metadata', async () => {
  for (const change of [{ kdfIterations: 599999 }, { kdfIterations: 2000001 }, { ivB64: 'short' }, { sealedRootKeyB64: Buffer.alloc(32).toString('base64url') }]) {
    const fixture = aumlokFixture()
    await assert.rejects(() => fixture.store.challenge({ purpose: 'bind', requestId: 'invalid-root', commitmentSha256: 'a'.repeat(64), nodePubkeyHex: fixture.nodePubkeyHex, ...SYNTHETIC_ROOT, ...change }, ORIGIN), { code: 'AUMLOK_SEALED_ROOT_REQUIRED' })
    assert.equal(fixture.state().binding, null)
  }
})

test('AUMLOK rotation rejects a node proof for different ciphertext without changing custody', async () => {
  const fixture = aumlokFixture(); await fixture.bind()
  const before = fixture.state().binding
  const challenge = await fixture.store.challenge({ purpose: 'refresh', requestId: 'wrong-rotation', commitmentSha256: 'b'.repeat(64), ...SYNTHETIC_ROOT }, ORIGIN)
  const result = await fixture.store.complete('refresh', { challengeId: challenge.challengeId, credential: fixture.assertion(challenge), nodeSignature: fixture.nodeSignature('different root intent') }, ORIGIN)
  assert.equal(result.code, 'AUMLOK_NODE_PROOF_INVALID')
  assert.deepEqual(fixture.state().binding, before)
})

test('AUMLOK refuses malformed attempts uncounted; persists wrong-proof backoff, hourly budget, audit privacy and cumulative guardian lockout', async () => {
  const fixture = aumlokFixture()
  // Job 6, the one rule: a malformed request is refused and moves no budget, however often.
  for (let index = 0; index < 10; index++) {
    await assert.rejects(() => fixture.store.complete('bind', { challengeId: 'not-valid' }, ORIGIN), { code: 'AUMLOK_REQUEST_INVALID' })
    assert.equal(fixture.state().failures, 0); assert.equal(fixture.state().nextAllowedAt, 0)
  }
  for (let index = 0; index < 10; index++) {
    await wrongProof(fixture, 'wrong-proof-' + index)
    assert.equal(fixture.state().failures, index + 1)
    if (index < 9) {
      await assert.rejects(() => fixture.store.challenge({ purpose: 'unseal', requestId: 'throttled-' + index }, ORIGIN), { code: 'AUMLOK_RATE_LIMITED' })
      assert.equal(fixture.state().failures, index + 1)
    }
    fixture.advance(1000 * 2 ** index)
    if (index === 4) {
      await assert.rejects(() => fixture.store.challenge({ purpose: 'unseal', requestId: 'hourly-budget' }, ORIGIN), { code: 'AUMLOK_RATE_LIMITED' })
      fixture.advance(3600000)
    }
  }
  fixture.advance(86400000)
  await assert.rejects(() => fixture.store.challenge({ purpose: 'unseal', requestId: 'still-locked' }, ORIGIN), { code: 'AUMLOK_GUARDIAN_QUORUM_REQUIRED' })
  const state = fixture.state()
  assert.equal(state.failures, 10)
  assert.deepEqual((await fixture.store.status()).blockers, ['AUMLOK_GUARDIAN_QUORUM_REQUIRED'])
  // 10 refused malformed + 10 × (challenge issued + registration + wrong proof: job 11's wrong proof is bind's assertion
  // step) + 9 + 1 rate-limited + 1 still locked.
  assert.equal(state.attempts.length, 51)
  for (const [index, attempt] of state.attempts.entries()) {
    assert.equal(attempt.schema, 'aumlok.attempt.v1'); assert.equal(attempt.sequence, index + 1)
    assert.match(attempt.ipHash32, /^[0-9a-f]{8}$/)
  }
  assert.equal(JSON.stringify(state).includes('203.0.113.7'), false)
  assert.equal(JSON.stringify(state).includes('owner@example.invalid'), false)
})

test('AUMLOK fresh verified UV assertions reset only WebAuthn failures', async () => {
  const fixture = aumlokFixture(); await fixture.bind()
  await assert.rejects(() => fixture.store.complete('unseal', { challengeId: 'bad' }, ORIGIN), { code: 'AUMLOK_REQUEST_INVALID' })
  fixture.advance(1000)
  const challenge = await fixture.store.challenge({ purpose: 'unseal', requestId: 'after-failure' }, ORIGIN)
  const { sealedRoot, phraseVerified, ...status } = await fixture.store.complete('unseal', { challengeId: challenge.challengeId, credential: fixture.assertion(challenge), commitmentSha256: 'a'.repeat(64) }, ORIGIN)
  assert.deepEqual(sealedRoot, SYNTHETIC_ROOT)
  assert.equal(phraseVerified, true)
  assert.deepEqual(status, await fixture.store.status(), 'Completion exposes the same status as the committed reset')
  assert.equal(fixture.state().failures, 0)
  assert.deepEqual(fixture.state().failedAt, [])
  assert.equal(fixture.state().nextAllowedAt, 0)
})

/**
 * One COUNTED WebAuthn failure under the one rule (proof-failure-rule.mjs): a proof the verifier checked and refused.
 * Bound: an approval asserted with a key that is not the passkey's. Not bound: a bind registration without user
 * verification. (A malformed request, the way these tests used to make one, is refused and never counted.)
 */
async function wrongProof(fixture, requestId = 'wrong-proof') {
  if (fixture.state()?.binding) {
    const action = await aumlokClass3Binding({ audience: ORIGIN, method: 'POST', pathname: '/_host/github', body: { requestId } })
    const challenge = await fixture.store.challenge({ purpose: 'approve', requestId, binding: action }, ORIGIN)
    assert.equal((await fixture.store.complete('approve', { challengeId: challenge.challengeId, credential: fixture.assertion(challenge, { wrongKey: true }) }, ORIGIN)).code, 'AUMLOK_PROOF_INVALID')
    return
  }
  // Job 11: a registration ('none' attestation) carries no signature, and a bent one is screened (never counted), so the
  // checked-wrong proof before a binding is bind's ASSERTION step signed by another key.
  const challenge = await fixture.store.challenge({ purpose: 'bind', requestId, commitmentSha256: 'a'.repeat(64), nodePubkeyHex: fixture.nodePubkeyHex, ...SYNTHETIC_ROOT }, ORIGIN)
  const registered = await fixture.store.complete('bind', { challengeId: challenge.challengeId, credential: fixture.registration(challenge) }, ORIGIN)
  assert.equal((await fixture.store.complete('bind', { challengeId: registered.challengeId, credential: fixture.assertion(registered, { wrongKey: true }),
    nodeSignature: fixture.nodeSignature(registered.nodeProofPreimage) }, ORIGIN)).code, 'AUMLOK_PROOF_INVALID')
}

async function class3Approval(fixture, requestId = 'class3') {
  const action = await aumlokClass3Binding({ audience: ORIGIN, method: 'POST', pathname: '/_head/ball', body: { promote: true, ballId: 'b'.repeat(64), epoch: 163 } })
  const challenge = await fixture.store.challenge({ purpose: 'approve', requestId, binding: action }, ORIGIN)
  const proof = { challengeId: challenge.challengeId, credential: fixture.assertion(challenge) }
  const result = await fixture.store.complete('approve', proof, ORIGIN)
  assert.equal(result.ok, true)
  assert.equal(result.expiresAt, result.approvedAt + AUMLOK_LIMITS.approvalMs)
  return { action, challenge, proof, result }
}

function assertUnsealCustodyUnchanged(after, before) {
  const { credential: _beforeCredential, lastVerifiedAt: _beforeVerifiedAt, ...beforeBinding } = before.binding
  const { credential: _afterCredential, lastVerifiedAt: _afterVerifiedAt, ...afterBinding } = after.binding
  assert.deepEqual(afterBinding, beforeBinding)
  for (const key of ['generation', 'lastRotationChallengeId', 'pepper.v1', 'pepperProtection', 'enrollmentCount', 'enrollments', 'invites', 'revocations', 'approvals']) {
    assert.deepEqual(after[key], before[key], key + ' cannot change during unseal')
  }
}

test('AUMLOK unseal returns only encrypted custody after mandatory phrase verification', async () => {
  for (const pepperSecret of [undefined, Buffer.alloc(32, 101).toString('base64url')]) {
    const fixture = aumlokFixture({ pepperSecret }); await fixture.bind()
    await assert.rejects(() => fixture.store.complete('unseal', { challengeId: 'malformed' }, ORIGIN), { code: 'AUMLOK_REQUEST_INVALID' })
    fixture.advance(1000)
    const challenge = await fixture.store.challenge({ purpose: 'unseal', requestId: 'required-phrase' }, ORIGIN)
    const input = { challengeId: challenge.challengeId, credential: fixture.assertion(challenge), commitmentSha256: 'a'.repeat(64) }
    const before = fixture.state(), originalInput = structuredClone(input)
    const { sealedRoot, phraseVerified, ...status } = await fixture.store.complete('unseal', input, ORIGIN)
    const after = fixture.state(), outcome = after.challenges.at(-1)
    assert.deepEqual(input, originalInput)
    assert.deepEqual(sealedRoot, SYNTHETIC_ROOT)
    assert.equal(phraseVerified, true)
    assert.deepEqual(status, await fixture.store.status())
    assert.equal(after.failures, 0); assert.deepEqual(after.failedAt, []); assert.equal(after.nextAllowedAt, 0)
    assert.equal(after.phraseFailures, before.phraseFailures)
    assert.deepEqual(after.phraseFailedAt, before.phraseFailedAt)
    assert.equal(after.phraseNextAllowedAt, before.phraseNextAllowedAt)
    assertUnsealCustodyUnchanged(after, before)
    assert.ok(after.binding.credential.counter > before.binding.credential.counter)
    assert.equal(after.binding.lastVerifiedAt, fixture.now())
    assert.equal(outcome.outcome, 'VERIFIED'); assert.equal(outcome.consumedAt, fixture.now())
    assert.equal(JSON.stringify(after).includes('commitmentSha256'), false)
    assert.equal(JSON.stringify(after).includes(SYNTHETIC_ROOT.sealedRootKeyB64), false)
    assert.equal(JSON.stringify(status).includes(after.binding.recoveryCommitment), false)
    await assert.rejects(() => fixture.store.complete('unseal', input, ORIGIN), { code: 'AUMLOK_CHALLENGE_USED' })
    assert.deepEqual(fixture.state().challenges.at(-1), outcome, 'Replay cannot replace a successful outcome')
    fixture.advance(AUMLOK_LIMITS.backoffMs)
    const changedProof = { ...input, commitmentSha256: 'b'.repeat(64) }
    await assert.rejects(() => fixture.store.complete('unseal', changedProof, ORIGIN), { code: 'AUMLOK_CHALLENGE_USED' })
    assert.deepEqual(fixture.state().challenges.at(-1), outcome, 'A different commitment cannot replace a successful outcome')
    assertUnsealCustodyUnchanged(fixture.state(), after)
  }
})

test('AUMLOK unseal refuses missing or inherited commitments for legacy and separated escrow', async () => {
  for (const pepperSecret of [undefined, Buffer.alloc(32, 101).toString('base64url')]) {
    for (const inherited of [false, true]) {
      const fixture = aumlokFixture({ pepperSecret }); await fixture.bind()
      await wrongProof(fixture)
      fixture.advance(AUMLOK_LIMITS.backoffMs)
      const challenge = await fixture.store.challenge({ purpose: 'unseal', requestId: 'missing-commitment' }, ORIGIN)
      const input = { challengeId: challenge.challengeId, credential: fixture.assertion(challenge) }
      if (inherited) Object.setPrototypeOf(input, { commitmentSha256: 'a'.repeat(64) })
      const before = fixture.state()
      const result = await fixture.store.complete('unseal', input, ORIGIN)
      assert.deepEqual(result, { ok: false, code: 'AUMLOK_COMMITMENT_INVALID', status: 400 })
      const after = fixture.state(), outcome = after.challenges.at(-1)
      // Job 7: a missing commitment is refused BEFORE the passkey is read, so it moves no counter in either direction: the
      // earlier wrong proof stays counted (never reset), no phrase guess is made, and the passkey's counter is untouched.
      assert.equal(after.failures, before.failures); assert.equal(after.failures, 1)
      assert.deepEqual(after.failedAt, before.failedAt); assert.equal(after.nextAllowedAt, before.nextAllowedAt)
      assert.equal(after.phraseFailures, 0); assert.deepEqual(after.phraseFailedAt, [])
      assert.equal(after.phraseNextAllowedAt, 0)
      assertUnsealCustodyUnchanged(after, before)
      assert.deepEqual(after.binding.credential, before.binding.credential)
      assert.equal(outcome.outcome, result.code); assert.equal(outcome.consumedAt, fixture.now())
      assert.equal(JSON.stringify(after).includes('commitmentSha256'), false)
      assert.equal(JSON.stringify(after).includes(SYNTHETIC_ROOT.sealedRootKeyB64), false)
      await assert.rejects(() => fixture.store.complete('unseal', { ...input, commitmentSha256: 'a'.repeat(64) }, ORIGIN), { code: 'AUMLOK_CHALLENGE_USED' })
      assert.deepEqual(fixture.state().challenges.at(-1), outcome, 'Adding a commitment cannot replace a refused outcome')
      fixture.advance(AUMLOK_LIMITS.backoffMs)
      const fresh = await fixture.store.challenge({ purpose: 'unseal', requestId: 'fresh-required-commitment' }, ORIGIN)
      const unsealed = await fixture.store.complete('unseal', { challengeId: fresh.challengeId, credential: fixture.assertion(fresh), commitmentSha256: 'a'.repeat(64) }, ORIGIN)
      assert.deepEqual(unsealed.sealedRoot, SYNTHETIC_ROOT); assert.equal(unsealed.phraseVerified, true)
      assert.equal(fixture.state().phraseFailures, after.phraseFailures)
      assert.deepEqual(fixture.state().phraseFailedAt, after.phraseFailedAt)
      assert.equal(fixture.state().phraseNextAllowedAt, after.phraseNextAllowedAt)
      assertUnsealCustodyUnchanged(fixture.state(), after)
    }
  }
})

test('AUMLOK unseal validates every supplied phrase commitment (its syntax before UV) and before opening escrow', async () => {
  for (const commitmentSha256 of [undefined, null, '', 0, false, [], {}, 'a'.repeat(63), 'A'.repeat(64), 'a'.repeat(66), 'b'.repeat(64)]) {
    const fixture = aumlokFixture(); await fixture.bind()
    await wrongProof(fixture)
    fixture.advance(1000)
    const challenge = await fixture.store.challenge({ purpose: 'unseal', requestId: 'phrase-check' }, ORIGIN)
    const before = fixture.state(), input = { challengeId: challenge.challengeId, credential: fixture.assertion(challenge), commitmentSha256 }
    const result = await fixture.store.complete('unseal', input, ORIGIN)
    assert.equal(result.code, commitmentSha256 === 'b'.repeat(64) ? 'AUMLOK_RECOVERY_COMMITMENT_MISMATCH' : 'AUMLOK_COMMITMENT_INVALID')
    assert.equal(Object.hasOwn(result, 'sealedRoot'), false)
    assert.equal(Object.hasOwn(result, 'phraseVerified'), false)
    const after = fixture.state()
    // Only words checked and wrong are a phrase guess; a malformed or absent commitment is refused, never counted.
    const guessed = commitmentSha256 === 'b'.repeat(64)
    // Job 7: wrong words come after a GOOD passkey, which resets the passkey budget and advances its counter, as ever. A
    // malformed commitment is refused before the passkey is read: every counter stays exactly as it was (never reset).
    if (guessed) {
      assert.equal(after.failures, 0); assert.deepEqual(after.failedAt, []); assert.equal(after.nextAllowedAt, 0)
      assert.ok(after.binding.credential.counter > before.binding.credential.counter)
    } else {
      assert.equal(after.failures, 1)
      assert.deepEqual([after.failures, after.failedAt, after.nextAllowedAt], [before.failures, before.failedAt, before.nextAllowedAt])
      assert.deepEqual(after.binding.credential, before.binding.credential)
    }
    assert.equal(after.phraseFailures, guessed ? 1 : 0); assert.deepEqual(after.phraseFailedAt, guessed ? [fixture.now()] : [])
    assert.equal(after.phraseNextAllowedAt, guessed ? fixture.now() + 1000 : 0)
    assertUnsealCustodyUnchanged(after, before)
    assert.equal(after.challenges.at(-1).outcome, result.code)
    assert.equal(JSON.stringify(after).includes('commitmentSha256'), false)
    assert.equal(JSON.stringify(await fixture.store.status()).includes(after.binding.recoveryCommitment), false)
    await assert.rejects(() => fixture.store.complete('unseal', input, ORIGIN), { code: 'AUMLOK_CHALLENGE_USED' })
    assert.deepEqual(fixture.state().challenges.at(-1), after.challenges.at(-1), 'Replay cannot replace a refused outcome')
    fixture.advance(AUMLOK_LIMITS.backoffMs)
    const { commitmentSha256: _rejectedCommitment, ...passkeyOnly } = input
    await assert.rejects(() => fixture.store.complete('unseal', passkeyOnly, ORIGIN), { code: 'AUMLOK_CHALLENGE_USED' })
    assert.deepEqual(fixture.state().challenges.at(-1), after.challenges.at(-1), 'Removing the commitment cannot replace a refused outcome')
    assertUnsealCustodyUnchanged(fixture.state(), after)
  }
  for (const commitment of [{}, { commitmentSha256: 'not-a-digest' }, { commitmentSha256: 'b'.repeat(64) }]) {
    const fixture = aumlokFixture(); await fixture.bind()
    const corrupt = fixture.state(); corrupt.binding.rootEscrow.ciphertextB64 = Buffer.alloc(48, 77).toString('base64url'); fixture.replace(corrupt)
    const challenge = await fixture.store.challenge({ purpose: 'unseal', requestId: 'commitment-before-open' }, ORIGIN)
    const result = await fixture.store.complete('unseal', { challengeId: challenge.challengeId, credential: fixture.assertion(challenge), ...commitment }, ORIGIN)
    assert.equal(result.code, commitment.commitmentSha256 === 'b'.repeat(64) ? 'AUMLOK_RECOVERY_COMMITMENT_MISMATCH' : 'AUMLOK_COMMITMENT_INVALID', 'An absent, malformed or wrong digest never reaches corrupt escrow decryption')
  }
})

test('AUMLOK invalid UV cannot reset WebAuthn failures or consume a phrase guess', async () => {
  for (const supplied of [false, true]) {
    for (const variation of [{ flags: 1 }, { flags: 4 }, { wrongKey: true }, { rpId: 'wrong.example.invalid' },
      { clientOverrides: { origin: 'https://attacker.example.invalid' } }, { clientOverrides: { challenge: 'wrong' } }]) {
      const fixture = aumlokFixture(); await fixture.bind()
      await wrongProof(fixture)
      fixture.advance(1000)
      const challenge = await fixture.store.challenge({ purpose: 'unseal', requestId: 'invalid-uv' }, ORIGIN)
      const before = fixture.state()
      const result = await fixture.store.complete('unseal', { challengeId: challenge.challengeId, credential: fixture.assertion(challenge, variation),
        ...(supplied ? { commitmentSha256: 'b'.repeat(64) } : {}) }, ORIGIN)
      // Job 7: without a commitment the request is refused (COMMITMENT_INVALID, 400) before the passkey is read, so the bad
      // UV is never checked and never counted. With one, job 11: a wrong flag, RP id, origin or challenge is refused by the
      // screen (403, no signature checked, never counted); only the wrong key's signature is checked and counted. Nothing is reset.
      assert.equal(result.ok, false); assert.equal(fixture.state().failures, supplied && variation.wrongKey ? 2 : 1); assert.equal(fixture.state().phraseFailures, 0)
      if (supplied) assert.deepEqual([result.code, result.status], ['AUMLOK_PROOF_INVALID', 403])
      if (!supplied) assert.equal(result.code, 'AUMLOK_COMMITMENT_INVALID')
      assert.equal(Object.hasOwn(result, 'sealedRoot'), false)
      assert.equal(Object.hasOwn(result, 'phraseVerified'), false)
      assert.deepEqual(fixture.state().binding, before.binding)
      assertUnsealCustodyUnchanged(fixture.state(), before)
    }
  }
})

test('AUMLOK unseal cannot bypass phrase backoff, hourly limits or hard lock by omitting its commitment', async () => {
  for (const lock of ['backoff', 'hourly', 'hard']) {
    const fixture = aumlokFixture(); await fixture.bind(); fixture.advance(AUMLOK_LIMITS.challengeMs)
    const state = fixture.state()
    state.phraseFailures = lock === 'hard' ? AUMLOK_LIMITS.hardLockFailures : lock === 'hourly' ? AUMLOK_LIMITS.failuresPerHour : 1
    state.phraseFailedAt = Array(state.phraseFailures).fill(fixture.now())
    state.phraseNextAllowedAt = lock === 'backoff' ? fixture.now() + AUMLOK_LIMITS.backoffMs : 0
    fixture.replace(state)
    const before = fixture.state(), code = lock === 'hard' ? 'AUMLOK_PHRASE_GUARDIAN_QUORUM_REQUIRED' : 'AUMLOK_PHRASE_RATE_LIMITED'
    const challenge = await fixture.store.challenge({ purpose: 'unseal', requestId: 'passkey-during-phrase-lock' }, ORIGIN)
    const refused = await fixture.store.complete('unseal', { challengeId: challenge.challengeId, credential: fixture.assertion(challenge) }, ORIGIN)
    assert.equal(refused.code, code); assert.equal(Object.hasOwn(refused, 'sealedRoot'), false)
    assert.equal(Object.hasOwn(refused, 'phraseVerified'), false)
    assert.deepEqual((await fixture.store.status()).phraseBlockers, [code])
    const checked = await fixture.store.challenge({ purpose: 'unseal', requestId: 'commitment-during-phrase-lock' }, ORIGIN)
    const result = await fixture.store.complete('unseal', { challengeId: checked.challengeId, credential: fixture.assertion(checked), commitmentSha256: 'a'.repeat(64) }, ORIGIN)
    assert.equal(result.code, code); assert.equal(Object.hasOwn(result, 'sealedRoot'), false)
    assert.equal(Object.hasOwn(result, 'phraseVerified'), false)
    const after = fixture.state()
    assert.equal(after.failures, 0); assert.equal(after.phraseFailures, before.phraseFailures)
    assert.deepEqual(after.phraseFailedAt, before.phraseFailedAt)
    assert.equal(after.phraseNextAllowedAt, before.phraseNextAllowedAt)
    assertUnsealCustodyUnchanged(after, before)
  }
})

test('AUMLOK unseal refuses expired challenges and a locked passkey budget with or without a commitment', async () => {
  for (const supplied of [false, true]) {
    for (const expired of [false, true]) {
      const fixture = aumlokFixture(); await fixture.bind()
      const challenge = await fixture.store.challenge({ purpose: 'unseal', requestId: 'no-fresh-uv' }, ORIGIN)
      if (expired) fixture.advance(AUMLOK_LIMITS.challengeMs)
      else { const state = fixture.state(); state.failures = AUMLOK_LIMITS.hardLockFailures; fixture.replace(state) }
      const before = fixture.state(), code = expired ? 'AUMLOK_CHALLENGE_EXPIRED' : 'AUMLOK_GUARDIAN_QUORUM_REQUIRED'
      const input = { challengeId: challenge.challengeId, credential: fixture.assertion(challenge), ...(supplied ? { commitmentSha256: 'a'.repeat(64) } : {}) }
      await assert.rejects(() => fixture.store.complete('unseal', input, ORIGIN), { code })
      const after = fixture.state()
      assert.deepEqual(after.binding, before.binding); assert.deepEqual(after.challenges, before.challenges)
      assert.equal(after.phraseFailures, before.phraseFailures)
      assertUnsealCustodyUnchanged(after, before)
    }
  }
})

test('AUMLOK phrase backoff and hard lock survive fresh UV while Class3 remains available', async () => {
  const fixture = aumlokFixture(); await fixture.bind()
  for (let index = 0; index < AUMLOK_LIMITS.hardLockFailures; index++) {
    if (index) fixture.advance(3600000)
    const challenge = await fixture.store.challenge({ purpose: 'unseal', requestId: 'guess-' + index }, ORIGIN)
    const result = await fixture.store.complete('unseal', { challengeId: challenge.challengeId, credential: fixture.assertion(challenge), commitmentSha256: 'b'.repeat(64) }, ORIGIN)
    assert.equal(result.code, 'AUMLOK_RECOVERY_COMMITMENT_MISMATCH')
    assert.equal(fixture.state().phraseFailures, index + 1); assert.equal(fixture.state().failures, 0)
    if (index === 0) {
      const throttled = await fixture.store.challenge({ purpose: 'unseal', requestId: 'correct-but-throttled' }, ORIGIN)
      assert.equal((await fixture.store.complete('unseal', { challengeId: throttled.challengeId, credential: fixture.assertion(throttled), commitmentSha256: 'a'.repeat(64) }, ORIGIN)).code, 'AUMLOK_PHRASE_RATE_LIMITED')
      assert.equal(fixture.state().phraseFailures, 1); assert.equal(fixture.state().failures, 0)
    }
  }
  const before = fixture.state(), { result } = await class3Approval(fixture, 'phrase-locked-approval')
  assert.equal(result.ok, true); assert.deepEqual(result.blockers, [])
  assert.deepEqual(result.phraseBlockers, ['AUMLOK_PHRASE_GUARDIAN_QUORUM_REQUIRED'])
  assert.equal(fixture.state().phraseFailures, before.phraseFailures)
  assert.deepEqual(fixture.state().phraseFailedAt, before.phraseFailedAt)
  assert.equal(fixture.state().phraseNextAllowedAt, before.phraseNextAllowedAt)
  const challenge = await fixture.store.challenge({ purpose: 'unseal', requestId: 'correct-but-locked' }, ORIGIN)
  assert.equal((await fixture.store.complete('unseal', { challengeId: challenge.challengeId, credential: fixture.assertion(challenge), commitmentSha256: 'a'.repeat(64) }, ORIGIN)).code, 'AUMLOK_PHRASE_GUARDIAN_QUORUM_REQUIRED')
  assert.equal(fixture.state().failures, 0); assert.equal(fixture.state().phraseFailures, 10)
})

test('AUMLOK registration, idempotent completion and approval consumption never reset failures', async () => {
  const fixture = aumlokFixture()
  await wrongProof(fixture, 'wrong-before-bind')
  fixture.advance(1000)
  const challenge = await fixture.prepareBind()
  assert.equal(fixture.state().failures, 1, 'Unsigned registration cannot reset failures')
  const input = { challengeId: challenge.challengeId, credential: fixture.assertion(challenge), nodeSignature: fixture.nodeSignature(challenge.nodeProofPreimage) }
  assert.equal((await fixture.store.complete('bind', input, ORIGIN)).ok, true)
  assert.equal(fixture.state().failures, 0)
  await wrongProof(fixture, 'wrong-after-bind')
  fixture.advance(1000)
  assert.equal((await fixture.store.complete('bind', input, ORIGIN)).idempotent, true)
  assert.equal(fixture.state().failures, 1)
  const { action, result } = await class3Approval(fixture)
  assert.equal(fixture.state().failures, 0)
  await wrongProof(fixture, 'wrong-before-consume')
  fixture.advance(1000)
  assert.equal((await fixture.store.consumeApproval(result.approvalToken, action, ORIGIN)).ok, true)
  assert.equal(fixture.state().failures, 1)
})

test('AUMLOK the independent hourly phrase budget survives successful passkey approvals', async () => {
  const fixture = aumlokFixture(); await fixture.bind()
  for (let index = 0; index < AUMLOK_LIMITS.failuresPerHour; index++) {
    fixture.advance(AUMLOK_LIMITS.challengeMs)
    const challenge = await fixture.store.challenge({ purpose: 'unseal', requestId: 'hourly-guess-' + index }, ORIGIN)
    assert.equal((await fixture.store.complete('unseal', { challengeId: challenge.challengeId, credential: fixture.assertion(challenge), commitmentSha256: 'b'.repeat(64) }, ORIGIN)).code, 'AUMLOK_RECOVERY_COMMITMENT_MISMATCH')
  }
  fixture.advance(AUMLOK_LIMITS.challengeMs)
  const before = fixture.state()
  assert.equal((await class3Approval(fixture, 'hourly-phrase-approval')).result.ok, true)
  const challenge = await fixture.store.challenge({ purpose: 'unseal', requestId: 'hourly-phrase-blocked' }, ORIGIN)
  assert.equal((await fixture.store.complete('unseal', { challengeId: challenge.challengeId, credential: fixture.assertion(challenge), commitmentSha256: 'a'.repeat(64) }, ORIGIN)).code, 'AUMLOK_PHRASE_RATE_LIMITED')
  assert.equal(fixture.state().failures, 0); assert.equal(fixture.state().phraseFailures, 5)
  assert.deepEqual(fixture.state().phraseFailedAt, before.phraseFailedAt)
  fixture.advance(3600000)
  const permitted = await fixture.store.challenge({ purpose: 'unseal', requestId: 'phrase-hour-passed' }, ORIGIN)
  assert.equal((await fixture.store.complete('unseal', { challengeId: permitted.challengeId, credential: fixture.assertion(permitted), commitmentSha256: 'a'.repeat(64) }, ORIGIN)).ok, true)
  assert.equal(fixture.state().phraseFailures, 5, 'Successful unseal does not erase cumulative phrase history')
})

test('AUMLOK late UV does not reset failures and hard lock has no assertion bypass', async () => {
  const late = aumlokFixture({ onApproval: expire => expire() })
  await wrongProof(late)
  late.advance(1000)
  assert.equal((await late.bind()).result.code, 'AUMLOK_CHALLENGE_EXPIRED')
  // The late UV resets nothing, and expiry itself is refused, never counted (the one rule).
  assert.equal(late.state().failures, 1); assert.equal(late.state().binding, null)
  const fixture = aumlokFixture(); await fixture.bind()
  const challenge = await fixture.store.challenge({ purpose: 'unseal', requestId: 'before-lock' }, ORIGIN)
  const state = fixture.state(); state.failures = 10; fixture.replace(state)
  const input = { challengeId: challenge.challengeId, credential: fixture.assertion(challenge), commitmentSha256: 'a'.repeat(64) }
  await assert.rejects(() => fixture.store.complete('unseal', input, ORIGIN), { code: 'AUMLOK_GUARDIAN_QUORUM_REQUIRED' })
  assert.equal(fixture.state().failures, 10); assert.deepEqual(fixture.state().binding, state.binding)
})

test('AUMLOK Class3 approval binds full action, audience and origin and is consumed exactly once', async () => {
  const fixture = aumlokFixture(); await fixture.bind()
  const { action, result } = await class3Approval(fixture)
  assert.equal(JSON.stringify(fixture.state()).includes(result.approvalToken), false)
  await assert.rejects(() => fixture.store.consumeApproval(result.approvalToken, { ...action, bodySha256: 'c'.repeat(64) }, ORIGIN), { code: 'CLASS3_WEBAUTHN_REQUIRED' })
  fixture.advance(1000)
  const outcomes = await Promise.allSettled([fixture.store.consumeApproval(result.approvalToken, action, ORIGIN), fixture.store.consumeApproval(result.approvalToken, action, ORIGIN)])
  assert.equal(outcomes.filter(value => value.status === 'fulfilled').length, 1)
  assert.equal(outcomes.find(value => value.status === 'rejected').reason.code, 'CLASS3_WEBAUTHN_REQUIRED')
  assert.notEqual(fixture.state().approvals[0].consumedAt, null)
})

test('AUMLOK approvals last five minutes from assertion success and status never exposes a bearer', async () => {
  const fixture = aumlokFixture(); await fixture.bind()
  const action = await aumlokClass3Binding({ audience: ORIGIN, method: 'POST', pathname: '/_head/ball', body: { promote: true } })
  const challenge = await fixture.store.challenge({ purpose: 'approve', requestId: 'late-success', binding: action }, ORIGIN)
  fixture.advance(AUMLOK_LIMITS.challengeMs - 1)
  const result = await fixture.store.complete('approve', { challengeId: challenge.challengeId, credential: fixture.assertion(challenge) }, ORIGIN)
  assert.equal(result.approvedAt, fixture.now())
  assert.equal(result.expiresAt, fixture.now() + 300000)
  const state = fixture.state(), status = await fixture.store.status(), publicJson = JSON.stringify(status)
  assert.deepEqual(status.approvedGrants, [result.approval])
  for (const secret of [result.approvalToken, state.approvals[0].tokenHash, state['pepper.v1'], state.binding.recoveryCommitment]) assert.equal(publicJson.includes(secret), false)
  for (const field of ['approvalToken', 'tokenHash', 'recoveryCommitment', 'sealedRootKeyB64']) assert.equal(publicJson.includes(field), false)
  fixture.advance(AUMLOK_LIMITS.approvalMs - 1)
  const before = fixture.state()
  assert.equal((await fixture.store.verifyApproval(result.approvalToken, action, ORIGIN)).ok, true)
  assert.deepEqual(fixture.state(), before, 'Verification never consumes, audits, or writes')
  fixture.advance(1)
  await assert.rejects(() => fixture.store.verifyApproval(result.approvalToken, action, ORIGIN), { code: 'CLASS3_WEBAUTHN_REQUIRED' })
  assert.deepEqual((await fixture.store.status()).approvedGrants, [])
})

test('AUMLOK semantic promotion approvals bind every field and roll back with the effect transaction', async () => {
  const fixture = aumlokFixture(); await fixture.bind()
  const action = { schema: 'aukora.class3.head-promotion.v1', audience: ORIGIN, action: 'head.promote', ballId: 'b'.repeat(64), epoch: 163,
    organId: 'seed-pearl', candidateSha256: 'c'.repeat(64) }
  const challenge = await fixture.store.challenge({ purpose: 'approve', requestId: 'semantic-promotion', binding: action }, ORIGIN)
  const result = await fixture.store.complete('approve', { challengeId: challenge.challengeId, credential: fixture.assertion(challenge) }, ORIGIN)
  assert.equal(result.ok, true)
  const before = fixture.state()
  for (const change of [{ ballId: 'd'.repeat(64) }, { epoch: 164 }, { organId: 'seed-aura' }, { candidateSha256: 'e'.repeat(64) }, { action: 'other' }]) {
    await assert.rejects(() => fixture.store.verifyApproval(result.approvalToken, { ...action, ...change }, ORIGIN), { code: 'CLASS3_WEBAUTHN_REQUIRED' })
  }
  assert.deepEqual(fixture.state(), before)
  await assert.rejects(() => fixture.storage.transaction(async tx => {
    assert.equal((await fixture.store.consumeApprovalInTransaction(tx, result.approvalToken, action, ORIGIN)).ok, true)
    throw new Error('Synthetic effect rollback')
  }), /Synthetic effect rollback/)
  assert.deepEqual(fixture.state(), before)
  assert.equal((await fixture.store.verifyApproval(result.approvalToken, action, ORIGIN)).approvalId, result.approval.approvalId)
  await fixture.storage.transaction(tx => fixture.store.consumeApprovalInTransaction(tx, result.approvalToken, action, ORIGIN))
  await assert.rejects(() => fixture.store.verifyApproval(result.approvalToken, action, ORIGIN), { code: 'CLASS3_WEBAUTHN_REQUIRED' })
  assert.equal((await fixture.store.status()).approvedGrants[0].consumedAt, fixture.now())
  assert.equal((await fixture.store.status()).approvedGrants[0].recordMac, result.approval.recordMac)
})

test('AUMLOK semantic approvals support bounded dynamic organ IDs without broadening their binding', async () => {
  const fixture = aumlokFixture(); await fixture.bind()
  const action = { schema: 'aukora.class3.head-promotion.v1', audience: ORIGIN, action: 'head.promote', ballId: 'b'.repeat(64), epoch: 163,
    organId: 'custom-governance', candidateSha256: 'c'.repeat(64) }
  const challenge = await fixture.store.challenge({ purpose: 'approve', requestId: 'dynamic-promotion', binding: action }, ORIGIN)
  const result = await fixture.store.complete('approve', { challengeId: challenge.challengeId, credential: fixture.assertion(challenge) }, ORIGIN)
  assert.equal(result.ok, true)
  for (const organId of ['other-governance', 'Custom', '../organ', 'x'.repeat(42), '@scope/organ']) {
    await assert.rejects(() => fixture.store.verifyApproval(result.approvalToken, { ...action, organId }, ORIGIN), { code: 'CLASS3_WEBAUTHN_REQUIRED' })
  }
  assert.equal((await fixture.store.consumeApproval(result.approvalToken, action, ORIGIN)).ok, true)
})

test('AUMLOK bounded approval records reject overflow and detect edited durable approval metadata', async () => {
  const fixture = aumlokFixture(); await fixture.bind(); fixture.advance(AUMLOK_LIMITS.challengeMs)
  for (let batch = 0; batch < 2; batch++) {
    for (let index = 0; index < AUMLOK_LIMITS.challenges; index++) await class3Approval(fixture, `bounded-approval-${batch}-${index}`)
    fixture.advance(AUMLOK_LIMITS.challengeMs)
  }
  assert.equal((await fixture.store.status()).approvedGrants.length, AUMLOK_LIMITS.approvalRecords)
  const action = await aumlokClass3Binding({ audience: ORIGIN, method: 'POST', pathname: '/_head/ball', body: { overflow: true } })
  const challenge = await fixture.store.challenge({ purpose: 'approve', requestId: 'approval-overflow', binding: action }, ORIGIN)
  const result = await fixture.store.complete('approve', { challengeId: challenge.challengeId, credential: fixture.assertion(challenge) }, ORIGIN)
  assert.equal(result.code, 'AUMLOK_APPROVAL_CAPACITY')
  assert.equal(fixture.state().approvals.length, AUMLOK_LIMITS.approvalRecords)
  const tampered = fixture.state(); tampered.approvals[0].binding.bodySha256 = 'f'.repeat(64); fixture.replace(tampered)
  await assert.rejects(() => fixture.store.status(), { code: 'AUMLOK_APPROVAL_CORRUPT' })
  assert.deepEqual(fixture.state(), tampered)
})

test('AUMLOK transaction consumption rolls back when its awaited write crosses the approval deadline', async () => {
  const fixture = aumlokFixture(); await fixture.bind()
  const { action, result } = await class3Approval(fixture), before = fixture.state()
  await assert.rejects(() => fixture.storage.transaction(tx => fixture.store.consumeApprovalInTransaction({
    get: key => tx.get(key),
    put: async (key, value) => { await tx.put(key, value); fixture.advance(AUMLOK_LIMITS.approvalMs) },
  }, result.approvalToken, action, ORIGIN)), { code: 'CLASS3_WEBAUTHN_REQUIRED' })
  assert.deepEqual(fixture.state(), before, 'Expired approval consumption must not survive a rolled-back effect transaction')
})

test('AUMLOK Class3 rejects token issuance replay, expiry, browser flags and changed binding generations', async () => {
  for (const variation of ['replay', 'expiry', 'generation', 'audience', 'route']) {
    const fixture = aumlokFixture(); await fixture.bind()
    const { action, proof, result } = await class3Approval(fixture)
    if (variation === 'replay') {
      await assert.rejects(() => fixture.store.complete('approve', proof, ORIGIN), { code: 'AUMLOK_CHALLENGE_USED' })
      continue
    }
    if (variation === 'expiry') fixture.advance(AUMLOK_LIMITS.approvalMs)
    if (variation === 'generation') {
      const challenge = await fixture.store.challenge({ purpose: 'refresh', requestId: 'invalidate-token', commitmentSha256: 'd'.repeat(64), ...SYNTHETIC_ROOT }, ORIGIN)
      assert.equal((await fixture.store.complete('refresh', { challengeId: challenge.challengeId, credential: fixture.assertion(challenge), nodeSignature: fixture.nodeSignature(challenge.nodeProofPreimage) }, ORIGIN)).ok, true)
    }
    const changed = variation === 'audience' ? { ...action, audience: 'https://other.example.invalid' } : variation === 'route' ? { ...action, pathname: '/_host/github' } : action
    await assert.rejects(() => fixture.store.consumeApproval(result.approvalToken, changed, ORIGIN), { code: 'CLASS3_WEBAUTHN_REQUIRED' })
  }
  const fixture = aumlokFixture(); await fixture.bind()
  const action = await aumlokClass3Binding({ audience: ORIGIN, method: 'POST', pathname: '/_host/github', body: { action: 'push' } })
  const challenge = await fixture.store.challenge({ purpose: 'approve', requestId: 'browser-flag', binding: action }, ORIGIN)
  const result = await fixture.store.complete('approve', { challengeId: challenge.challengeId, credential: true }, ORIGIN)
  assert.equal(result.code, 'AUMLOK_PROOF_INVALID'); assert.equal(fixture.state().approvals.length, 0)
})

test('AUMLOK v1 state is refused without overwriting legacy identity', async () => {
  const fixture = aumlokFixture()
  const legacy = { schema: 'aukora.aumlok.state.v1', generation: 1, binding: { nodePubkeyHex: fixture.nodePubkeyHex }, challenges: [], invites: [], revocations: [] }
  fixture.replace(legacy)
  await assert.rejects(() => fixture.store.status(), { code: 'AUMLOK_STATE_MIGRATION_REQUIRED' })
  assert.deepEqual(fixture.state(), legacy)
})

test('AUMLOK corrupt attempt arrays produce a stable storage error', async () => {
  const fixture = aumlokFixture(); await fixture.bind()
  const state = fixture.state(); state.attempts = null; state['pepper.v1'] = null; state.binding = null; state.generation = 0; state.challenges = []; fixture.replace(state)
  await assert.rejects(() => fixture.store.status(), { code: 'AUMLOK_STATE_CORRUPT' })
})

test('AUMLOK rate-limited floods cannot exhaust custody audit capacity', async () => {
  const fixture = aumlokFixture(); await fixture.bind()
  await wrongProof(fixture)
  for (let index = 0; index < AUMLOK_LIMITS.attemptRecords + 1; index++) {
    await assert.rejects(() => fixture.store.challenge({ purpose: 'unseal', requestId: 'throttled-flood' }, ORIGIN), { code: 'AUMLOK_RATE_LIMITED' })
  }
  fixture.advance(1000)
  const challenge = await fixture.store.challenge({ purpose: 'unseal', requestId: 'after-flood' }, ORIGIN)
  assert.equal((await fixture.store.complete('unseal', { challengeId: challenge.challengeId, credential: fixture.assertion(challenge), commitmentSha256: 'a'.repeat(64) }, ORIGIN)).ok, true)
  assertAuditRetention(fixture.state())
})

function assertAuditRetention(state) {
  assert.equal(state.audit.retainedLimit, AUMLOK_LIMITS.attemptRecords)
  assert.equal(state.attempts.length, Math.min(state.audit.totalRecords, AUMLOK_LIMITS.attemptRecords))
  assert.equal(state.audit.totalRecords - state.audit.prunedRecords, state.attempts.length)
  let digest = state.audit.prunedThroughHash
  for (const [index, record] of state.attempts.entries()) {
    assert.equal(record.sequence, state.audit.prunedRecords + index + 1)
    digest = createHash('sha256').update('aukora.aumlok.audit.v1\0' + digest + '\0' + canonicalJson(record)).digest('hex')
  }
  assert.equal(digest, state.audit.latestHash)
}

test('AUMLOK idempotent successes and ordinary lifetime growth retain bounded audit without locking custody', async () => {
  const fixture = aumlokFixture(); await fixture.bind()
  const input = { purpose: 'unseal', requestId: 'repeated-request' }
  const challenge = await fixture.store.challenge(input, ORIGIN)
  for (let index = 0; index < AUMLOK_LIMITS.attemptRecords + 1; index++) {
    const repeated = await fixture.store.challenge(input, ORIGIN)
    assert.equal(repeated.idempotent, true); assert.equal(repeated.challengeId, challenge.challengeId)
  }
  assert.equal((await fixture.store.complete('unseal', { challengeId: challenge.challengeId, credential: fixture.assertion(challenge), commitmentSha256: 'a'.repeat(64) }, ORIGIN)).ok, true)
  await assert.rejects(() => fixture.store.complete('unseal', { challengeId: 'malformed' }, ORIGIN), { code: 'AUMLOK_REQUEST_INVALID' })
  for (let index = 0; index < AUMLOK_LIMITS.attemptRecords + 1; index++) {
    fixture.advance(AUMLOK_LIMITS.challengeMs)
    const fresh = await fixture.store.challenge({ purpose: 'unseal', requestId: 'lifetime-' + index }, ORIGIN)
    assert.equal((await fixture.store.complete('unseal', { challengeId: fresh.challengeId, credential: fixture.assertion(fresh), commitmentSha256: 'a'.repeat(64) }, ORIGIN)).ok, true)
  }
  const state = fixture.state()
  assertAuditRetention(state)
  assert.ok(state.audit.prunedRecords > AUMLOK_LIMITS.attemptRecords)
  assert.notEqual(state.audit.prunedThroughHash, '0'.repeat(64))
  assert.equal(state.failures, 0)
  assert.equal(state.attempts.some(value => value.outcome === 'AUMLOK_REQUEST_INVALID'), false)
})

test('AUMLOK old v2 audit rows remain unchanged on status and survive compatible metadata adoption', async () => {
  const fixture = aumlokFixture(); await fixture.bind()
  await class3Approval(fixture)
  await assert.rejects(() => fixture.store.complete('approve', { challengeId: 'malformed' }, ORIGIN), { code: 'AUMLOK_REQUEST_INVALID' })
  fixture.advance(1000)
  const legacy = fixture.state(); delete legacy.audit; fixture.replace(legacy)
  assert.equal((await fixture.store.status()).bound, true)
  assert.deepEqual(fixture.state(), legacy, 'Status must not persist or mutate normalized metadata')
  const challenge = await fixture.store.challenge({ purpose: 'unseal', requestId: 'compatible-v2' }, ORIGIN)
  const adopted = fixture.state()
  for (const key of Object.keys(legacy).filter(key => !['attempts', 'challenges'].includes(key))) assert.deepEqual(adopted[key], legacy[key], key)
  assert.deepEqual(adopted.attempts.slice(0, legacy.attempts.length), legacy.attempts)
  assert.deepEqual(adopted.challenges.slice(0, legacy.challenges.length), legacy.challenges)
  assert.equal(adopted.audit.prunedRecords, 0)
  assert.equal(adopted.audit.totalRecords, legacy.attempts.length + 1)
  assertAuditRetention(adopted)
  assert.equal((await fixture.store.complete('unseal', { challengeId: challenge.challengeId, credential: fixture.assertion(challenge), commitmentSha256: 'a'.repeat(64) }, ORIGIN)).ok, true)
})

test('AUMLOK malformed or inconsistent audit metadata cannot take the legacy fallback', async () => {
  for (const change of [state => { state.audit = null }, state => { state.audit = {} }, state => { state.audit.latestHash = 'f'.repeat(64) }, state => { state.attempts[0].outcome = 'TAMPERED' }]) {
    const fixture = aumlokFixture(); await fixture.bind()
    const state = fixture.state(); change(state); fixture.replace(state)
    await assert.rejects(() => fixture.store.status(), error => ['AUMLOK_STATE_CORRUPT', 'AUMLOK_AUDIT_CORRUPT'].includes(error.code))
    assert.deepEqual(fixture.state(), state)
  }
})

function generatedKeyRecord() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const publicKeyHex = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex')
  return {
    version: 1,
    publicKeyHex,
    seedHex: privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32).toString('hex'),
    keyId: `owner-ed25519-${publicKeyHex.slice(0, 12)}`,
    createdAt: new Date(NOW).toISOString(),
  }
}

async function temporaryRoot(t) {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'x61-owner-grant-'))
  t.after(async () => { await fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 }) })
  await fs.chmod(root, 0o700)
  return root
}

async function keyFixture(t, record = generatedKeyRecord()) {
  const root = await temporaryRoot(t)
  const keyFile = path.join(root, 'test-owner-key.json')
  await fs.writeFile(keyFile, JSON.stringify(record), { flag: 'wx', mode: 0o600 })
  return { root, keyFile, record, signer: createOwnerGrantSigner({ keyFile, now: () => NOW }), jwtSigner: createOwnerJwtSigner({ keyFile, now: () => NOW }) }
}

// Inventory only test-owned paths. Symlinks are recorded, never followed.
async function inventory(root) {
  const rows = []
  async function visit(relative) {
    const absolute = path.join(root, relative)
    const stat = await fs.lstat(absolute, { bigint: true })
    const row = [relative, ...['dev', 'ino', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs'].map(name => String(stat[name]))]
    if (stat.isSymbolicLink()) row.push(await fs.readlink(absolute))
    else if (stat.isFile()) row.push(createHash('sha256').update(await fs.readFile(absolute)).digest('hex'))
    rows.push(row)
    if (stat.isDirectory()) for (const child of (await fs.readdir(absolute)).sort()) await visit(path.join(relative, child))
    assert.ok(rows.length < 100, 'Fixture inventory must remain bounded')
  }
  await visit('')
  return rows
}

function throwsCode(action, code, status) {
  assert.throws(action, error => {
    assert.equal(error.code, code)
    if (status !== undefined) assert.equal(error.status, status)
    return true
  })
}

test('explicit temporary signer matches the browser verifier without changing its key file', { skip: POSIX_ONLY }, async t => {
  const fixture = await keyFixture(t)
  const before = await inventory(fixture.root)
  assert.deepEqual(fixture.signer.getOwnerPublicKey(), {
    ok: true, publicKeyHex: fixture.record.publicKeyHex, keyId: fixture.record.keyId,
  })
  const input = binding()
  const inputBefore = structuredClone(input)
  const result = fixture.signer.signOwnerGrant(input)
  assert.equal(result.ok, true)
  assert.equal(result.keyId, fixture.record.keyId)
  assert.equal(ownerGrantCanonical(input), browserCanonical(input))
  assert.match(result.ownerGrant.signatureHex, /^[0-9a-f]{128}$/)
  assert.equal(await verifyOwnerAttestation(input, result.ownerGrant, [fixture.record.publicKeyHex]), 'verified')
  assert.equal(await verifyOwnerAttestation(input, result.ownerGrant, []), 'untrusted-key')
  assert.ok(!JSON.stringify(result).includes(fixture.record.seedHex))
  assert.deepEqual(input, inputBefore)
  assert.deepEqual(await inventory(fixture.root), before)

  for (const [field, value] of Object.entries({
    mandateId: 'other-mandate', ticketId: null, scope: { altered: true },
    ballId: 'b'.repeat(64), epoch: 8, expiresAt: NOW + 120000, identity: 'Other Owner',
  })) {
    const changed = { ...input, [field]: value }
    assert.equal(await verifyOwnerAttestation(changed, result.ownerGrant, [fixture.record.publicKeyHex]), 'binding-mismatch', field)
    assert.equal(await verifyOwnerAttestation(changed, { ...result.ownerGrant, [field]: value }, [fixture.record.publicKeyHex]), 'bad-signature', field)
  }
  const changedSignature = (result.ownerGrant.signatureHex[0] === '0' ? '1' : '0') + result.ownerGrant.signatureHex.slice(1)
  assert.equal(await verifyOwnerAttestation(input, { ...result.ownerGrant, signatureHex: changedSignature }, [fixture.record.publicKeyHex]), 'bad-signature')
  const noTicket = binding({ ticketId: null, identity: ' Fixture  Owner ' })
  const noTicketGrant = fixture.signer.signOwnerGrant(noTicket).ownerGrant
  assert.equal(noTicketGrant.identity, noTicket.identity, 'Identity text must not be silently normalized')
  assert.equal(await verifyOwnerAttestation(noTicket, noTicketGrant, [fixture.record.publicKeyHex]), 'verified')
  const unbounded = binding({ ticketId: null, scope: null, expiresAt: null })
  throwsCode(() => fixture.signer.signOwnerGrant(unbounded), 'OWNER_GRANT_EXPLICIT_SCOPE_REQUIRED', 403)
  // Since an earlier commit a non-null expiry is a safe integer of milliseconds: a fractional one is refused before signing, and the
  // nearest whole millisecond still signs and verifies in the browser.
  const fractional = binding({ expiresAt: NOW + 0.5, scope: { organs: ['seed-calc'], expiresAt: NOW + 0.5 } })
  throwsCode(() => fixture.signer.signOwnerGrant(fractional), 'OWNER_GRANT_INVALID_EXPIRY', 400)
  const nextMillisecond = binding({ expiresAt: NOW + 1, scope: { organs: ['seed-calc'], expiresAt: NOW + 1 } })
  const nextGrant = fixture.signer.signOwnerGrant(nextMillisecond).ownerGrant
  assert.equal(await verifyOwnerAttestation(nextMillisecond, nextGrant, [fixture.record.publicKeyHex]), 'verified')
  // The browser verifier holds the same expiry rule as the signer: the owner key signs each binding's exact canonical bytes
  // directly (as a grant made before an earlier commit or by hand would be); the whole millisecond verifies, the fractional one is
  // refused as malformed, never verified.
  const ownerKey = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(fixture.record.seedHex, 'hex')]), format: 'der', type: 'pkcs8' })
  const signedDirectly = value => ({ ...nextGrant, ...value, signatureHex: sign(null, Buffer.from(OWNER_GRANT_DOMAIN + browserCanonical(value)), ownerKey).toString('hex') })
  assert.equal(await verifyOwnerAttestation(nextMillisecond, signedDirectly(nextMillisecond), [fixture.record.publicKeyHex]), 'verified')
  assert.equal(normalizeOwnerGrantBinding(nextMillisecond, { now: NOW }).expiresAt, NOW + 1)
  throwsCode(() => normalizeOwnerGrantBinding(fractional, { now: NOW }), 'OWNER_GRANT_INVALID_EXPIRY', 400)
  assert.equal(await verifyOwnerAttestation(fractional, signedDirectly(fractional), [fixture.record.publicKeyHex]), 'malformed')
  assert.deepEqual(await inventory(fixture.root), before)
})

test('missing or invalid fixture keys fail closed without creation, repair or cached reuse', { skip: POSIX_ONLY }, async t => {
  await t.test('missing key and missing parent directory stay absent', async t => {
    const root = await temporaryRoot(t)
    const before = await inventory(root)
    for (const keyFile of [path.join(root, 'absent.json'), path.join(root, 'absent-directory', 'key.json')]) {
      const signer = createOwnerGrantSigner({ keyFile, now: () => NOW })
      throwsCode(() => signer.getOwnerPublicKey(), 'OWNER_KEY_NOT_CONFIGURED', 503)
      throwsCode(() => signer.signOwnerGrant(binding()), 'OWNER_KEY_NOT_CONFIGURED', 503)
      throwsCode(() => createOwnerJwtSigner({ keyFile, now: () => NOW }).mint(), 'OWNER_KEY_NOT_CONFIGURED', 503)
    }
    assert.deepEqual(await inventory(root), before)
  })
  for (const [name, change] of [
    ['malformed JSON', async f => fs.writeFile(f.keyFile, '{')],
    ['oversized record', async f => fs.writeFile(f.keyFile, ' '.repeat(4097))],
    ['invalid seed', async f => fs.writeFile(f.keyFile, JSON.stringify({ ...f.record, seedHex: 'not-a-key' }))],
    ['invalid metadata', async f => fs.writeFile(f.keyFile, JSON.stringify({ ...f.record, version: 2 }))],
    ['private seed in public key identifier', async f => fs.writeFile(f.keyFile, JSON.stringify({ ...f.record, keyId: f.record.seedHex }))],
    ['mismatched key pair', async f => fs.writeFile(f.keyFile, JSON.stringify({ ...f.record, publicKeyHex: generatedKeyRecord().publicKeyHex }))],
    ['permissive file', async f => fs.chmod(f.keyFile, 0o644)],
    ['permissive parent', async f => fs.chmod(f.root, 0o755)],
    ['symlink file', async f => {
      const target = path.join(f.root, 'other-test-key.json')
      await fs.rename(f.keyFile, target)
      await fs.symlink(target, f.keyFile)
    }],
    ['hardlink file', async f => fs.link(f.keyFile, path.join(f.root, 'test-key-hardlink.json'))],
    ['directory in place of key', async f => { await fs.unlink(f.keyFile); await fs.mkdir(f.keyFile, { mode: 0o700 }) }],
  ]) {
    await t.test(name, async t => {
      const fixture = await keyFixture(t)
      assert.equal(fixture.signer.getOwnerPublicKey().publicKeyHex, fixture.record.publicKeyHex)
      await change(fixture)
      const before = await inventory(fixture.root)
      throwsCode(() => fixture.signer.getOwnerPublicKey(), 'OWNER_KEY_INVALID', 503)
      throwsCode(() => fixture.signer.signOwnerGrant(binding()), 'OWNER_KEY_INVALID', 503)
      throwsCode(() => fixture.jwtSigner.mint(), 'OWNER_KEY_INVALID', 503)
      assert.deepEqual(await inventory(fixture.root), before)
    })
  }
  await t.test('symlink ancestor never reaches the fixture key', async t => {
    const fixture = await keyFixture(t)
    const alias = path.join(fixture.root, 'linked-directory')
    await fs.symlink(fixture.root, alias, 'dir')
    const signer = createOwnerGrantSigner({ keyFile: path.join(alias, path.basename(fixture.keyFile)), now: () => NOW })
    const before = await inventory(fixture.root)
    throwsCode(() => signer.getOwnerPublicKey(), 'OWNER_KEY_INVALID', 503)
    throwsCode(() => signer.signOwnerGrant(binding()), 'OWNER_KEY_INVALID', 503)
    throwsCode(() => createOwnerJwtSigner({ keyFile: path.join(alias, path.basename(fixture.keyFile)), now: () => NOW }).mint(), 'OWNER_KEY_INVALID', 503)
    assert.deepEqual(await inventory(fixture.root), before)
  })
  await t.test('symlink above the immediate key directory is refused', async t => {
    const fixture = await keyFixture(t)
    const realDirectory = path.join(fixture.root, 'real', 'private')
    await fs.mkdir(realDirectory, { recursive: true, mode: 0o700 })
    await fs.rename(fixture.keyFile, path.join(realDirectory, 'test-key.json'))
    await fs.symlink(path.join(fixture.root, 'real'), path.join(fixture.root, 'alias'), 'dir')
    const signer = createOwnerGrantSigner({ keyFile: path.join(fixture.root, 'alias', 'private', 'test-key.json'), now: () => NOW })
    const before = await inventory(fixture.root)
    throwsCode(() => signer.getOwnerPublicKey(), 'OWNER_KEY_INVALID', 503)
    throwsCode(() => signer.signOwnerGrant(binding()), 'OWNER_KEY_INVALID', 503)
    throwsCode(() => createOwnerJwtSigner({ keyFile: path.join(fixture.root, 'alias', 'private', 'test-key.json'), now: () => NOW }).mint(), 'OWNER_KEY_INVALID', 503)
    assert.deepEqual(await inventory(fixture.root), before)
  })
})

test('invalid bindings are rejected before the explicit missing test key can be opened', { skip: POSIX_ONLY }, async t => {
  const root = await temporaryRoot(t)
  const signer = createOwnerGrantSigner({ keyFile: path.join(root, 'deliberately-absent.json'), now: () => NOW })
  const before = await inventory(root)
  const cases = [null, [], 'binding', { ...binding(), extra: true }]
  for (const field of Object.keys(binding())) {
    const missing = binding()
    delete missing[field]
    cases.push(missing)
  }
  for (const [field, values] of Object.entries({
    mandateId: ['', ' ', 12, 'm'.repeat(201)],
    ticketId: ['', ' ', 12, {}, 't'.repeat(201)],
    ballId: [null, 12, 'A'.repeat(64), 'a'.repeat(63)],
    epoch: [null, '7', -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1],
    expiresAt: [String(NOW + 60000), NOW, NOW - 1, Infinity],
    identity: ['', ' ', 12, 'agent', ' Agent ', 'PERSON', 'spatial-tab', 'agent-self-unverified', 'i'.repeat(201)],
    scope: [[], 'scope', { missing: undefined }, { invalid: NaN }, { invalid: Infinity }, { invalid: 1n }, { invalid() {} }, { expiresAt: NOW + 1 }, { huge: 'x'.repeat(16385) }, new Date(NOW), { sparse: Array(2) }, { [Symbol('hidden')]: true }],
  })) for (const value of values) cases.push(binding({ [field]: value }))
  const cycle = {}; cycle.self = cycle
  let deep = {}; for (let i = 0; i < 20; i++) deep = { child: deep }
  cases.push(binding({ scope: cycle }), binding({ scope: deep }), binding({ scope: { many: Array(1100).fill(null) } }))
  let accessorCalls = 0
  cases.push(binding({ scope: { get field() { accessorCalls++; return 'must not execute' } } }))
  const accessorBinding = binding()
  Object.defineProperty(accessorBinding, 'identity', { enumerable: true, get() { accessorCalls++; return 'Fixture Owner' } })
  cases.push(accessorBinding)
  for (const input of cases) {
    assert.throws(() => signer.signOwnerGrant(input), error => {
      assert.match(error.code, /^OWNER_GRANT_|^REQUEST_BODY_TOO_LARGE$/)
      assert.ok(error.status === 400 || error.status === 403 || error.status === 413)
      return true
    })
  }
  assert.equal(accessorCalls, 0)
  assert.deepEqual(await inventory(root), before)
})

function localFixture({ approveOwnerGrant, signer, now = () => NOW, readHead } = {}) {
  const calls = { approvals: 0, keys: 0, heads: 0, chunks: 0, cancelled: false }
  const head = { ballId: 'a'.repeat(64), epoch: 7 }
  const handler = createLocalOwnerGrantHandler({
    now,
    readHead: async () => { calls.heads++; return readHead ? readHead() : head },
    signer: {
      getOwnerPublicKey() { calls.keys++; assert.ok(signer, 'Unexpected key metadata read'); return signer.getOwnerPublicKey() },
      signOwnerGrant(input) { calls.keys++; assert.ok(signer, 'Unexpected signing call'); return signer.signOwnerGrant(input) },
    },
    ...(approveOwnerGrant === undefined ? {} : { approveOwnerGrant: input => { calls.approvals++; return approveOwnerGrant(input) } }),
  })
  return {
    calls, head,
    async request(route = GRANT_ROUTE, { method = route.split('?')[0] === GRANT_ROUTE ? 'POST' : 'GET', body = JSON.stringify(binding()), headers = {} } = {}) {
      const requestHeaders = { origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', ...headers }
      for (const [key, value] of Object.entries(requestHeaders)) if (value === null) delete requestHeaders[key]
      const chunks = Array.isArray(body) ? body : [Buffer.from(body)]
      const req = Readable.from((async function* () {
        try { for (const chunk of chunks) { calls.chunks++; yield chunk } }
        finally { calls.cancelled = true }
      })(), { highWaterMark: 0 })
      req.method = method
      req.headers = requestHeaders
      try { return await handler(req, new URL(route, ORIGIN)) }
      finally { req.destroy() }
    },
  }
}

// Only generated fixtures use this out-of-band approval simulator; the local server installs no provider.
const approveLocalFixture = ({ canonical, preimageHash }) => ({ approved: true, canonical, preimageHash })

test('local owner scope and same-origin request metadata never supply owner approval', async () => {
  for (const approveOwnerGrant of [
    undefined,
    () => true,
    () => ({ approved: true }),
    ({ canonical }) => ({ approved: true, canonical }),
    ({ canonical }) => ({ approved: true, canonical, preimageHash: '0'.repeat(64) }),
    ({ preimageHash }) => ({ approved: true, canonical: 'different', preimageHash }),
    () => { throw new Error('Synthetic approval failure') },
  ]) {
    const local = localFixture({ approveOwnerGrant })
    await responseCode(local.request(GRANT_ROUTE, {
      body: JSON.stringify(binding({ scope: { paths: ['mirror/home/auma/seed/organs/seed-calc.js'] } })),
      headers: { 'x-owner-approved': 'true', 'x-x6-internal-authorized': '1', 'x-owner-identity': 'Fixture Owner' },
    }), 'OWNER_APPROVAL_REQUIRED', 403)
    assert.equal(local.calls.keys, 0)
    if (approveOwnerGrant === undefined) assert.equal(local.calls.heads, 0)
  }
})

test('local owner routes reject method, origin and body mismatches before approval or key access', async () => {
  for (const [route, method] of [[GRANT_ROUTE, 'GET'], [GRANT_ROUTE, 'PUT'], [KEY_ROUTE, 'POST']]) {
    const local = localFixture({ approveOwnerGrant: approveLocalFixture })
    await responseCode(local.request(route, { method }), 'METHOD_UNAVAILABLE', 405)
    assert.equal(local.calls.keys + local.calls.approvals + local.calls.chunks, 0)
  }
  for (const route of [GRANT_ROUTE + '/', GRANT_ROUTE + '/extra', GRANT_ROUTE + '?approved=true', KEY_ROUTE + '?approved=true']) {
    const local = localFixture({ approveOwnerGrant: approveLocalFixture })
    await responseCode(local.request(route), 'OWNER_ROUTE_UNAVAILABLE', 404)
    assert.equal(local.calls.keys + local.calls.approvals + local.calls.chunks, 0)
  }
  for (const headers of [{ origin: null }, { origin: 'null' }, { origin: 'https://other.example.invalid' }, { 'sec-fetch-site': null }, { 'sec-fetch-site': 'same-site' }]) {
    const local = localFixture({ approveOwnerGrant: approveLocalFixture })
    await responseCode(local.request(GRANT_ROUTE, { headers }), 'SAME_ORIGIN_BROWSER_REQUIRED', 403)
    assert.equal(local.calls.keys + local.calls.approvals + local.calls.chunks, 0)
  }
  const invalidUtf8 = Buffer.from(JSON.stringify(binding()))
  invalidUtf8[invalidUtf8.indexOf('Fixture Owner')] = 0xff
  for (const [body, headers, code, status] of [
    ['{', {}, 'OWNER_GRANT_MALFORMED', 400],
    ['null', {}, 'OWNER_GRANT_MALFORMED', 400],
    [invalidUtf8, {}, 'OWNER_GRANT_MALFORMED', 400],
    [JSON.stringify(binding()), { 'content-length': 'NaN' }, 'OWNER_GRANT_MALFORMED', 400],
    [JSON.stringify(binding()), { 'content-length': '3' }, 'OWNER_GRANT_MALFORMED', 400],
    [JSON.stringify(binding()), { 'content-length': '16385' }, 'REQUEST_BODY_TOO_LARGE', 413],
    [JSON.stringify(binding()), { 'content-type': 'text/plain' }, 'OWNER_GRANT_MALFORMED', 400],
    [JSON.stringify(binding()), { 'content-encoding': 'gzip' }, 'OWNER_GRANT_MALFORMED', 400],
    [[Buffer.alloc(16384, 32), Buffer.from(' ')], {}, 'REQUEST_BODY_TOO_LARGE', 413],
  ]) {
    const local = localFixture({ approveOwnerGrant: approveLocalFixture })
    await responseCode(local.request(GRANT_ROUTE, { body, headers }), code, status)
    assert.equal(local.calls.keys + local.calls.approvals, 0)
  }
})

test('local operator approval covers the exact immutable scope, current HEAD and domain-separated preimage hash', { skip: POSIX_ONLY }, async t => {
  const fixture = await keyFixture(t)
  const before = await inventory(fixture.root)
  const input = binding({ ticketId: null, scope: { paths: ['mirror/home/auma/seed/organs/seed-calc.js'], expiresAt: NOW + 60000 } })
  const expectedHash = createHash('sha256').update(OWNER_GRANT_DOMAIN + browserCanonical(input)).digest('hex')
  const local = localFixture({ signer: fixture.signer, approveOwnerGrant: terms => {
    assert.equal(terms.canonical, browserCanonical(input))
    assert.equal(terms.preimageHash, expectedHash)
    assert.equal(Object.isFrozen(terms), true)
    assert.equal(Object.isFrozen(terms.binding.scope.paths), true)
    assert.equal(local.calls.keys, 0)
    return approveLocalFixture(terms)
  } })
  const result = await local.request(GRANT_ROUTE, { body: JSON.stringify(input) })
  assert.equal(result.status, 200)
  assert.equal(result.body.preimageHash, expectedHash)
  assert.equal(await verifyOwnerAttestation(input, result.body.ownerGrant, [fixture.record.publicKeyHex]), 'verified')
  assert.equal(local.calls.heads, 2)
  assert.equal(local.calls.keys, 1)
  const metadata = await local.request(KEY_ROUTE)
  assert.equal(metadata.body.publicKeyHex, fixture.record.publicKeyHex)
  assert.equal(local.calls.approvals, 1)
  assert.deepEqual(await inventory(fixture.root), before)
})

test('local grants reject stale or unavailable HEAD and approval-time expiry without signing', async () => {
  for (const override of [{ ballId: 'b'.repeat(64) }, { epoch: 8 }]) {
    const local = localFixture({ approveOwnerGrant: approveLocalFixture })
    await responseCode(local.request(GRANT_ROUTE, { body: JSON.stringify(binding(override)) }), 'OWNER_GRANT_STALE_BINDING', 409)
    assert.equal(local.calls.keys + local.calls.approvals, 0)
  }
  for (const head of [null, { ballId: 'bad', epoch: 7 }, { ballId: 'a'.repeat(64), epoch: '7' }]) {
    const local = localFixture({ readHead: () => head, approveOwnerGrant: approveLocalFixture })
    await responseCode(local.request(), 'OWNER_GRANT_HEAD_UNAVAILABLE', 503)
    assert.equal(local.calls.keys + local.calls.approvals, 0)
  }
  const changed = localFixture({ approveOwnerGrant: terms => { changed.head.epoch++; return approveLocalFixture(terms) } })
  await responseCode(changed.request(), 'OWNER_GRANT_STALE_BINDING', 409)
  assert.equal(changed.calls.keys, 0)
  const failed = localFixture({ approveOwnerGrant: approveLocalFixture, readHead: () => {
    if (failed.calls.heads > 1) throw new Error('Synthetic HEAD failure')
    return failed.head
  } })
  await responseCode(failed.request(), 'OWNER_GRANT_HEAD_UNAVAILABLE', 503)
  assert.equal(failed.calls.keys, 0)
  let at = NOW
  const expired = localFixture({ now: () => at, approveOwnerGrant: terms => { at += 60000; return approveLocalFixture(terms) } })
  await responseCode(expired.request(), 'OWNER_GRANT_INVALID_EXPIRY', 400)
  assert.equal(expired.calls.keys, 0)
})

test('synthetic owner login passes default to 24 hours and preserve shorter expiry through cookie exchange', { skip: POSIX_ONLY }, async t => {
  const fixture = await keyFixture(t)
  const before = await inventory(fixture.root)
  const verify = createAccessVerifier({ now: () => NOW, fetchKeys: async () => assert.fail('Owner login must not fetch keys') })
  for (const hours of [undefined, 1, 12, 13, 24]) {
    const result = hours === undefined ? fixture.jwtSigner.mint() : fixture.jwtSigner.mint({ hours })
    const parts = result.token.split('.')
    assert.equal(parts.length, 3)
    assert.deepEqual(JSON.parse(Buffer.from(parts[0], 'base64url')), { alg: 'EdDSA', typ: 'JWT' })
    const expires = NOW / 1000 + (hours ?? 24) * 3600
    assert.deepEqual(JSON.parse(Buffer.from(parts[1], 'base64url')), { iss: 'aukora.x61.owner', aud: 'node.example.invalid', email: 'owner@example.invalid', nbf: NOW / 1000, exp: expires })
    assert.equal(result.publicKeyHex, fixture.record.publicKeyHex)
    const request = new Request('https://node.example.invalid', { headers: { 'x-x6-owner-assertion': result.token } })
    const env = { PUBLIC_HOST: 'node.example.invalid', OWNER_EMAIL: 'owner@example.invalid', OWNER_PUBLIC_KEY_HEX: fixture.record.publicKeyHex }
    assert.deepEqual(await verify(request, env), { email: 'owner@example.invalid', expires, type: 'owner' })
    assert.equal(await verify(request, { PUBLIC_HOST: 'other.example.invalid', OWNER_EMAIL: 'owner@example.invalid', OWNER_PUBLIC_KEY_HEX: fixture.record.publicKeyHex }), null)
    assert.equal(await verify(request, { PUBLIC_HOST: 'node.example.invalid', OWNER_EMAIL: 'owner@example.invalid', OWNER_PUBLIC_KEY_HEX: generatedKeyRecord().publicKeyHex }), null)
    let at = NOW
    // Since an earlier commit every owner login asks HEAD's durable lockout gate (check, then success or failure). HEAD here is the
    // real durable gate store over in-memory storage; it may be asked nothing else.
    const gateRows = new Map(), gateCalls = []
    const gate = createDurableGateLockoutStore({ transaction: async operation => operation({ get: async key => structuredClone(gateRows.get(key)), put: async (key, value) => { gateRows.set(key, structuredClone(value)) } }) })
    const HEAD = { idFromName: name => name, get: () => ({ fetch: async request => {
      assert.equal(new URL(request.url).pathname, '/_head/gate-lockout', 'owner login asks HEAD only for its lockout gate')
      assert.equal(request.method, 'POST')
      const input = await request.json()
      assert.deepEqual(Object.keys(input).sort(), ['action', 'subject'])
      assert.match(input.subject, /^owner-login:[0-9a-f]{64}$/)
      gateCalls.push(input.action)
      const decision = input.action === 'check' ? await gate.checkSubject(input.subject, at)
        : input.action === 'failure' ? await gate.recordFailure(input.subject, at) : await gate.recordSuccess(input.subject, at)
      return Response.json({ ok: true, gate: decision })
    } }) }
    const worker = createWorker({ now: () => at, networkFetch: () => assert.fail('Owner login must not use external network') })
    const login = () => worker.fetch(new Request('https://node.example.invalid/_auth/owner', { method: 'POST', headers: { origin: 'https://node.example.invalid', 'sec-fetch-site': 'same-origin', 'content-type': 'application/jwt' }, body: result.token }), { ...env, HEAD })
    for (const elapsed of [0, 10_000]) {
      at = NOW + elapsed
      const response = await login()
      assert.equal(response.status, 200)
      assert.deepEqual(await response.json(), { ok: true, expires })
      assert.equal(response.headers.get('set-cookie'), `CF_Authorization=${result.token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${expires - at / 1000}`)
    }
    assert.deepEqual(gateCalls, ['check', 'success', 'check', 'success'])
    at = expires * 1000
    const expired = await login()
    assert.equal(expired.status, 401)
    assert.deepEqual(await expired.json(), { ok: false, code: 'OWNER_ACCESS_REQUIRED' })
    assert.equal(expired.headers.get('set-cookie'), null)
    // Since the second-passkey change (an earlier commit) a pass outside its time window is refused by the screen before any
    // durable call: HEAD is not asked and nothing is counted (only a signature that was checked and found wrong counts;
    // that case, with its exact gate calls and counts, is pinned in deploy/cloudflare/src/__tests__/owner-login-gate.test.mjs).
    assert.deepEqual(gateCalls, ['check', 'success', 'check', 'success'])
    assert.equal((gateRows.get('gate-lockout:v1') ?? []).length, 0, 'an expired pass is never counted against its address')
  }
  assert.equal(OWNER_JWT_MAX_HOURS, 24)
  assert.deepEqual(await inventory(fixture.root), before)
})

test('owner JWT options and times fail before a missing fixture key is opened', { skip: POSIX_ONLY }, async t => {
  const root = await temporaryRoot(t)
  const keyFile = path.join(root, 'absent.json')
  const before = await inventory(root)
  for (const hours of [0, -1, 1.5, 25, 72, 73, '24', NaN, Infinity]) throwsCode(() => createOwnerJwtSigner({ keyFile, now: () => NOW }).mint({ hours }), 'OWNER_JWT_INVALID_HOURS')
  for (const at of [-1, NaN, Infinity, Number.MAX_VALUE]) throwsCode(() => createOwnerJwtSigner({ keyFile, now: () => at }).mint(), 'OWNER_JWT_INVALID_TIME')
  for (const keyFile of [undefined, 'relative.json']) throwsCode(() => createOwnerJwtSigner({ keyFile }), 'OWNER_KEY_PATH_REQUIRED')
  assert.deepEqual(await inventory(root), before)
})

test('owner JWT refuses a clock rollback or expiry during signing and emits no expired command output', { skip: POSIX_ONLY }, async t => {
  const fixture = await keyFixture(t)
  const before = await inventory(fixture.root)
  for (const second of [NOW - 1, NOW + 24 * 3600 * 1000, NaN]) {
    let calls = 0
    throwsCode(() => createOwnerJwtSigner({ keyFile: fixture.keyFile, now: () => ++calls === 1 ? NOW : second }).mint(), 'OWNER_JWT_INVALID_TIME')
  }
  const output = [], errors = []
  let calls = 0
  const result = await runMintOwnerJwt([], { keyFile: fixture.keyFile, now: () => ++calls <= 2 ? NOW : NOW + 24 * 3600 * 1000, stdout: text => output.push(text), stderr: text => errors.push(text) })
  assert.equal(result, 1)
  assert.equal(output.length, 0)
  assert.equal(errors.length, 1)
  assert.deepEqual(await inventory(fixture.root), before)
})

test('owner JWT command parses before custody access and only outputs a synthetic policy-verified token', { skip: POSIX_ONLY }, async t => {
  const fixture = await keyFixture(t)
  const before = await inventory(fixture.root)
  for (const args of [[], ['--hours', '1'], ['--hours', '12'], ['--hours', '13'], ['--hours', '24'], ['--help'], ['--hours', '25'], ['--hours', '72'], ['--hours', '0'], ['--hours', '1.5'], ['--hours'], ['--key-file', fixture.keyFile]]) {
    const output = [], errors = []
    const valid = args.length === 0 || (args[0] === '--hours' && ['1', '12', '13', '24'].includes(args[1]))
    const help = args[0] === '--help'
    const exitCode = await runMintOwnerJwt(args, { keyFile: valid ? fixture.keyFile : path.join(fixture.root, 'missing.json'), now: () => NOW, stdout: text => output.push(text), stderr: text => errors.push(text) })
    assert.equal(exitCode, valid || help ? 0 : 1)
    assert.equal(output.length, valid || help ? 1 : 0)
    assert.equal(errors.length, valid || help ? 0 : 1)
    if (valid) {
      assert.equal(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\n$/.test(output[0]), true)
      const claims = JSON.parse(Buffer.from(output[0].split('.')[1], 'base64url'))
      assert.equal(claims.exp - claims.nbf, (args.length === 0 ? 24 : Number(args[1])) * 3600)
    } else if (help) assert.match(output[0], /--hours 1\.\.24/)
    else assert.match(errors[0], /permits 1\.\.24 hours/)
  }
  for (const keyFile of [path.join(fixture.root, 'missing.json'), fixture.keyFile]) {
    if (keyFile === fixture.keyFile) await fs.chmod(keyFile, 0o644)
    const output = [], errors = []
    assert.equal(await runMintOwnerJwt([], { keyFile, now: () => NOW, stdout: text => output.push(text), stderr: text => errors.push(text) }), 1)
    assert.equal(output.length, 0)
    assert.equal(errors.length, 1)
    assert.equal(errors[0].includes(fixture.record.seedHex), false)
    assert.equal(errors[0].includes(keyFile), false)
  }
  await fs.chmod(fixture.keyFile, 0o600)
  // chmod deliberately changes ctime; compare the original contents and inode, not mutable timestamps.
  const after = await inventory(fixture.root)
  assert.equal(after[1].at(-1), before[1].at(-1))
  assert.equal(after[1][2], before[1][2])
})

test('local host source installs no approval shim or model broker subprocess and guards runtime selection', async () => {
  const source = await fs.readFile(new URL('./local-host.mjs', import.meta.url), 'utf8')
  assert.ok(source.includes('createLocalOwnerGrantHandler({ readHead: () => ballHeadStore.read() })'))
  assert.equal(source.includes('approveOwnerGrant:'), false)
  assert.equal(source.includes('const deniedSubpaths = ['), false)
  assert.ok(source.includes("planLocalBrokerAction(surface, await readAumlokBody(req, 'LOCAL_BROKER'))"))
  assert.ok(source.includes('planLocalRuntimeAction(req.method)'))
  assert.equal(source.includes('localLiveUpdates.selectRuntime('), false)
  for (const executable of ["execFileAsync('gh'", "execFileAsync('npx'", "execFileAsync('/usr/bin/sandbox-exec'"]) assert.equal(source.includes(executable), false)
  assert.ok(source.includes("path.join(os.homedir(), '.aukora-x6-vault')"))
  assert.ok(source.includes('await handleLocalOwnerGrant(req, url)'))
})

function workerFixture(t, { approveOwnerGrant, class3Authorize, approvalToken = Buffer.alloc(32, 81).toString('base64url'), keyRecord, keyOverrides = {}, envOverrides = {}, now = () => NOW, currentHead,
  nodePublicKeyHex = null } = {}) {
  const calls = { access: 0, approvals: 0, keys: [], network: 0, assets: 0 }
  const boot = { ok: true, seedId: 'f'.repeat(64), ballId: 'a'.repeat(64), epoch: 7 }
  const head = { ok: true, ballId: boot.ballId, epoch: boot.epoch, ...currentHead }
  const namespace = phase => ({
    idFromName(name) { assert.equal(name, 'node-main-v1'); return name },
    get() {
      return { async fetch(request) {
        const pathname = new URL(request.url).pathname
        if (phase === 'complete' && pathname === '/_host/aumlok/status') return Response.json({ ok: true, phase: nodePublicKeyHex ? 'BOUND' : 'UNBOUND', nodePubkeyHex: nodePublicKeyHex })
        if (phase === 'complete' && pathname === '/_head/lease') return Response.json({ ok: true, lease: null, ballId: head.ballId, epoch: head.epoch })
        if (phase === 'complete' && pathname === '/_head/ball') return Response.json({ ok: true, ball: { ballId: head.ballId, epoch: head.epoch }, head: { ballId: head.ballId, epoch: head.epoch }, codeBySha: {}, modules: {}, peers: [] })
        if (phase === 'complete' && pathname === '/_head/class3-authorize') {
          calls.approvals++
          const input = await request.json()
          assert.equal(input.token, approvalToken)
          return class3Authorize ? Response.json(await class3Authorize(input)) : Response.json({ ok: false, code: 'CLASS3_WEBAUTHN_REQUIRED' }, { status: 403 })
        }
        assert.equal(pathname, phase === 'complete' ? '/_head/bootstrap-status' : '/_mirror/bootstrap-status')
        return Response.json({ ...boot, phase })
      } }
    },
  })
  const env = {
    PUBLIC_HOST: new URL(ORIGIN).host,
    ACCESS_TEAM: 'fixture-access-team', ACCESS_AUD: 'fixture-access-audience', OWNER_EMAIL: 'fixture@example.invalid',
    HEAD: namespace('complete'), MIRROR: namespace('ready'),
    ASSETS: { async fetch() { calls.assets++; return new Response('Fixture asset', { status: 404 }) } },
    ...envOverrides,
  }
  for (const [name, value] of Object.entries({
    OWNER_PUBLIC_KEY_HEX: keyRecord?.publicKeyHex ?? 'c'.repeat(64),
    OWNER_ED25519_SECRET_KEY: keyRecord?.seedHex,
    ...keyOverrides,
  })) Object.defineProperty(env, name, { get() { calls.keys.push(name); return value }, enumerable: true })
  const options = {
    now,
    verifyAccess: async request => { calls.access++; return request.headers.get('cookie') === 'CF_Authorization=synthetic-owner-token' ? { type: 'owner', email: 'fixture@example.invalid', expires: (NOW + 3600000) / 1000 } : null },
    networkFetch: async () => { calls.network++; throw new Error('Unexpected network request') },
  }
  if (approveOwnerGrant !== undefined) options.approveOwnerGrant = async input => { calls.approvals++; return approveOwnerGrant(input) }
  const worker = createWorker(options)
  t.after(() => { assert.equal(calls.network, 0, 'Owner tests must not use network transport') })
  return {
    calls, head,
    async request(route = GRANT_ROUTE, { method = route.split('?')[0] === GRANT_ROUTE ? 'POST' : 'GET', body, headers = {} } = {}) {
      const requestHeaders = new Headers({ origin: ORIGIN, 'sec-fetch-site': 'same-origin', cookie: 'CF_Authorization=synthetic-owner-token', 'content-type': 'application/json' })
      if (class3Authorize) requestHeaders.set('x-x6-class3-approval', approvalToken)
      for (const [name, value] of Object.entries(headers)) {
        if (value === null) requestHeaders.delete(name)
        else requestHeaders.set(name, value)
      }
      const payload = ['GET', 'HEAD'].includes(method) ? undefined : body === undefined ? JSON.stringify(binding()) : body
      const response = await worker.fetch(new Request(new URL(route, ORIGIN), { method, headers: requestHeaders, ...(payload === undefined ? {} : { body: payload, duplex: 'half' }) }), env)
      const text = await response.text()
      const result = text.startsWith('{') ? JSON.parse(text) : text
      return { status: response.status, body: result, headers: response.headers }
    },
  }
}

async function responseCode(promise, code, status) {
  const result = await promise
  assert.equal(result.status, status)
  assert.equal(result.body.code, code)
  assert.equal(result.body.ok, false)
  return result
}

const approveExact = ({ canonical }) => ({ approved: true, canonical })

test('same-origin Access headers are not owner consent and never reach signing key configuration', async t => {
  for (const [name, approveOwnerGrant] of [
    ['no approval verifier', undefined],
    ['approval denied', () => ({ approved: false })],
    ['boolean is not a bound approval', () => true],
    ['approval is for different bytes', () => ({ approved: true, canonical: 'different-binding' })],
    ['approval verifier throws', () => { throw new Error('Synthetic approval failure') }],
  ]) await t.test(name, async t => {
    const cloud = workerFixture(t, { approveOwnerGrant })
    await responseCode(cloud.request(), 'CLASS3_WEBAUTHN_REQUIRED', 403)
    await responseCode(cloud.request(GRANT_ROUTE, { headers: { 'x-owner-approved': 'true', 'x-x6-internal-authorized': '1', 'x-owner-identity': 'Fixture Owner' } }), 'CLASS3_WEBAUTHN_REQUIRED', 403)
    assert.deepEqual(cloud.calls.keys, [])
    assert.equal(cloud.calls.approvals, 0)
  })
})

test('owner routes enforce exact paths, methods, Access and browser-origin gates before approval or key access', async t => {
  for (const [route, method] of [[GRANT_ROUTE, 'GET'], [GRANT_ROUTE, 'PUT'], [GRANT_ROUTE, 'HEAD'], [KEY_ROUTE, 'POST'], [KEY_ROUTE, 'DELETE']]) {
    const cloud = workerFixture(t, { approveOwnerGrant: approveExact })
    const result = await cloud.request(route, { method })
    assert.equal(result.status, 405, `${method} ${route}`)
    if (method !== 'HEAD') assert.equal(result.body.code, 'METHOD_UNAVAILABLE')
    assert.equal(cloud.calls.approvals, 0)
    assert.deepEqual(cloud.calls.keys, [])
  }
  for (const route of [GRANT_ROUTE + '/', GRANT_ROUTE + '/extra', GRANT_ROUTE + '?approved=true', KEY_ROUTE + '/', KEY_ROUTE + '?grant=true']) {
    const cloud = workerFixture(t, { approveOwnerGrant: approveExact })
    const result = await cloud.request(route, { method: route.startsWith(GRANT_ROUTE) ? 'POST' : 'GET' })
    assert.ok(result.status >= 400, route)
    assert.equal(cloud.calls.approvals, 0)
    assert.deepEqual(cloud.calls.keys, [])
  }
  for (const headers of [
    { cookie: null }, { cookie: 'CF_Authorization=invalid', 'x-x6-internal-authorized': '1' },
    { origin: null }, { origin: 'null' }, { origin: 'https://other.example.invalid' },
    { 'sec-fetch-site': null }, { 'sec-fetch-site': 'same-site' }, { 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-site': 'none' },
  ]) {
    const cloud = workerFixture(t, { approveOwnerGrant: approveExact })
    const result = await cloud.request(GRANT_ROUTE, { headers })
    assert.ok(result.status === 401 || result.status === 403)
    assert.equal(cloud.calls.approvals, 0)
    assert.deepEqual(cloud.calls.keys, [])
  }
  for (const envOverrides of [{ ACCESS_TEAM: '' }, { ACCESS_AUD: '' }, { OWNER_EMAIL: '' }]) {
    const cloud = workerFixture(t, { approveOwnerGrant: approveExact, envOverrides, keyOverrides: { OWNER_PUBLIC_KEY_HEX: undefined } })
    await responseCode(cloud.request(), 'OWNER_ACCESS_NOT_CONFIGURED', 503)
    assert.equal(cloud.calls.access, 0)
    assert.ok(cloud.calls.keys.every(name => name === 'OWNER_PUBLIC_KEY_HEX'), 'Access readiness may read only the public verification key')
  }
})

test('Worker consumes a real bound-passkey token for exact owner-grant bytes and never signs', async t => {
  const record = generatedKeyRecord()
  const input = binding()
  const custody = aumlokFixture(); await custody.bind()
  const expected = await aumlokClass3Binding({ audience: ORIGIN, method: 'POST', pathname: GRANT_ROUTE, body: input })
  const challenge = await custody.store.challenge({ purpose: 'approve', requestId: 'worker-owner-grant', binding: expected }, ORIGIN)
  const { approvalToken } = await custody.store.complete('approve', { challengeId: challenge.challengeId, credential: custody.assertion(challenge) }, ORIGIN)
  const cloud = workerFixture(t, {
    keyRecord: record, approvalToken,
    class3Authorize: async ({ token, binding: approved }) => {
      assert.deepEqual(approved, expected)
      assert.deepEqual(cloud.calls.keys, ['OWNER_PUBLIC_KEY_HEX'])
      return custody.store.consumeApproval(token, approved, ORIGIN)
    },
  })
  const result = await cloud.request()
  assert.equal(result.status, 200)
  assert.equal(result.body.ok, true)
  assert.equal(cloud.calls.approvals, 1)
  assert.deepEqual(result.body.binding, input)
  assert.equal(result.body.authorization, 'bound-passkey-exact-action')
  assert.equal(result.body.ownerGrant, undefined)
  assert.equal(result.body.signatureHex, undefined)
  assert.ok(!JSON.stringify(result.body).includes(record.seedHex))
  assert.equal(result.headers.get('cache-control'), 'no-store')
  assert.equal(result.headers.get('x-content-type-options'), 'nosniff')
  const key = await cloud.request(KEY_ROUTE)
  assert.equal(key.status, 200)
  assert.equal(key.body.publicKeyHex, record.publicKeyHex)
  assert.equal(cloud.calls.approvals, 1, 'Public metadata must not issue an attestation')
  assert.ok(!JSON.stringify(key.body).includes(record.seedHex))
  assert.equal(cloud.calls.keys.includes('OWNER_ED25519_SECRET_KEY'), false)
})

test('Worker validates current binding and public metadata without reading a private key', async t => {
  for (const override of [{ ballId: 'b'.repeat(64) }, { epoch: 8 }]) {
    const cloud = workerFixture(t, { approveOwnerGrant: approveExact })
    await responseCode(cloud.request(GRANT_ROUTE, { body: JSON.stringify(binding(override)) }), 'OWNER_GRANT_STALE_BINDING', 409)
    assert.equal(cloud.calls.approvals, 0)
    assert.deepEqual(cloud.calls.keys, [])
  }
  const record = generatedKeyRecord()
  for (const keyOverrides of [
    { OWNER_PUBLIC_KEY_HEX: undefined }, { OWNER_PUBLIC_KEY_HEX: 'malformed' },
  ]) {
    const cloud = workerFixture(t, { keyRecord: record, keyOverrides, approveOwnerGrant: approveExact })
    for (const route of [KEY_ROUTE]) {
      const result = await cloud.request(route)
      assert.equal(result.status, 503)
      assert.ok(['OWNER_KEY_NOT_CONFIGURED', 'OWNER_KEY_INVALID'].includes(result.body.code))
      assert.equal(result.body.ownerGrant, undefined)
      assert.equal(result.body.signatureHex, undefined)
    }
    assert.equal(cloud.calls.keys.includes('OWNER_ED25519_SECRET_KEY'), false)
  }
  for (const secret of [undefined, 'malformed', generatedKeyRecord().seedHex]) {
    const cloud = workerFixture(t, { keyRecord: record, keyOverrides: { OWNER_ED25519_SECRET_KEY: secret } })
    assert.equal((await cloud.request(KEY_ROUTE)).body.publicKeyHex, record.publicKeyHex)
    assert.equal(cloud.calls.keys.includes('OWNER_ED25519_SECRET_KEY'), false)
  }
})

test('Worker binds the current HEAD and rechecks it and expiry after awaited approval', async t => {
  const record = generatedKeyRecord()
  const currentHead = { ballId: 'b'.repeat(64), epoch: 8 }
  const input = binding(currentHead)
  const advanced = workerFixture(t, { keyRecord: record, currentHead, class3Authorize: async () => ({ ok: true, expiresAt: NOW + AUMLOK_LIMITS.approvalMs }) })
  const valid = await advanced.request(GRANT_ROUTE, { body: JSON.stringify(input) })
  assert.equal(valid.status, 200, 'Current HEAD, rather than initial bootstrap seed, controls authorization')
  assert.deepEqual(valid.body.binding, input)
  assert.equal(valid.body.ownerGrant, undefined)

  const changed = workerFixture(t, {
    class3Authorize: async () => {
      changed.head.epoch++
      return { ok: true, expiresAt: NOW + AUMLOK_LIMITS.approvalMs }
    },
  })
  await responseCode(changed.request(), 'OWNER_GRANT_STALE_BINDING', 409)
  assert.deepEqual(changed.calls.keys, ['OWNER_PUBLIC_KEY_HEX'])
  let clock = NOW
  const expired = workerFixture(t, {
    now: () => clock,
    class3Authorize: async () => { clock = NOW + 60000; return { ok: true, expiresAt: NOW + AUMLOK_LIMITS.approvalMs } },
  })
  await responseCode(expired.request(), 'OWNER_GRANT_INVALID_EXPIRY', 400)
  assert.deepEqual(expired.calls.keys, ['OWNER_PUBLIC_KEY_HEX'])
})

test('Worker checks real Durable Object current HEAD but refuses missing bound-passkey approval', async t => {
  const ball = { version: 'x6.1-ball/v1', parentBallId: 'a'.repeat(64), epoch: 8, entries: {}, modules: {} }
  ball.ballId = await manifestId(ball)
  const rows = new Map([
    ['bootstrap:v1', { phase: 'complete', seedId: 'f'.repeat(64), ballId: 'a'.repeat(64), epoch: 7 }],
    ['head', ball.ballId],
    [`manifest:${ball.ballId}:count`, 1],
    [`manifest:${ball.ballId}:0`, JSON.stringify(ball)],
  ])
  const before = structuredClone(rows)
  let writes = 0
  const storage = {
    transaction: async operation => operation({
      get: async key => structuredClone(rows.get(key)),
      put: async () => { writes++; assert.fail('Read-only HEAD fixture must not write') },
      delete: async () => { writes++; assert.fail('Read-only HEAD fixture must not delete') },
    }),
  }
  const record = generatedKeyRecord()
  const head = new X61HeadDurableObject({ storage, getWebSockets: () => [] }, { PUBLIC_HOST: new URL(ORIGIN).host, OWNER_PUBLIC_KEY_HEX: record.publicKeyHex })
  const cloud = workerFixture(t, {
    keyRecord: record, approveOwnerGrant: approveExact,
    envOverrides: { HEAD: { idFromName: name => name, get: () => head } },
  })
  const input = binding({ ballId: ball.ballId, epoch: ball.epoch })
  const result = await cloud.request(GRANT_ROUTE, { body: JSON.stringify(input) })
  assert.equal(result.status, 403, JSON.stringify(result.body))
  assert.equal(result.body.code, 'CLASS3_WEBAUTHN_REQUIRED')
  assert.equal(result.body.ownerGrant, undefined)
  assert.equal(writes, 0)
  assert.deepEqual(rows, before)
})

test('Worker rejects malformed or oversized grant bodies without approval or key access', async t => {
  const validBody = JSON.stringify(binding())
  const invalidUtf8 = Buffer.from(validBody)
  invalidUtf8[invalidUtf8.indexOf('Fixture Owner')] = 0xff
  for (const [body, headers] of [
    ['{', {}], ['null', {}], ['[]', {}],
    [new Uint8Array([0xff]), {}], [invalidUtf8, {}],
    [validBody, { 'content-length': 'invalid' }], [validBody, { 'content-length': '3' }],
    [validBody, { 'content-length': '16385' }], [validBody, { 'content-encoding': 'gzip' }],
    [validBody, { 'content-type': 'text/plain' }],
    [JSON.stringify(binding({ identity: 'agent' })), {}],
    [JSON.stringify(binding({ epoch: '7' })), {}],
    [JSON.stringify(binding({ scope: { oversized: 'x'.repeat(16385) } })), {}],
  ]) {
    const cloud = workerFixture(t, { approveOwnerGrant: approveExact })
    const result = await cloud.request(GRANT_ROUTE, { body, headers })
    assert.ok([400, 403, 413].includes(result.status), JSON.stringify(result.body))
    assert.equal(cloud.calls.approvals, 0)
    assert.deepEqual(cloud.calls.keys, [])
  }
  let cancelled = false
  const oversized = new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(16385).fill(32)) },
    cancel() { cancelled = true },
  }, { highWaterMark: 0 })
  const cloud = workerFixture(t, { approveOwnerGrant: approveExact })
  await responseCode(cloud.request(GRANT_ROUTE, { body: oversized }), 'REQUEST_BODY_TOO_LARGE', 413)
  assert.equal(cancelled, true)
  assert.equal(cloud.calls.approvals, 0)
  assert.deepEqual(cloud.calls.keys, [])
})

function policyFailure(error) {
  assert.equal(error.status, 403)
  assert.equal(typeof error.code, 'string')
  return true
}

test('local broker plans preserve observations but never treat client flags or command aliases as authority', () => {
  assert.deepEqual(planLocalBrokerAction('repo', { action: 'status' }), { kind: 'repository-status' })
  assert.deepEqual(planLocalBrokerAction('repo', { action: 'read', path: 'server/fixture.mjs' }), { kind: 'source-read', path: 'server/fixture.mjs' })
  for (const action of ['log', 'diff']) assert.deepEqual(planLocalBrokerAction('repo', { action }), { kind: 'unavailable', action, code: 'LOCAL_REPO_READ_UNAVAILABLE' })
  for (const action of ['write', 'commit']) {
    for (const approval of [{}, { approved: true }, { qualificationId: 'client-claim', signature: 'client-claim' }]) {
      assert.throws(() => planLocalBrokerAction('repo', { action, ...approval }), { code: 'PEARL_QUALIFICATION_UNVERIFIABLE', status: 403 })
    }
  }
  for (const command of ['git status', 'git push', 'git push origin main', 'git -c alias.p=push p', 'node -e 0', 'curl https://example.invalid', 'wrangler deploy', 'gh auth token']) {
    assert.throws(() => planLocalBrokerAction('repo', { action: 'exec', command, approved: true }), { code: 'CLASS3_OWNER_SIGNATURE_REQUIRED', status: 403 })
  }
  assert.throws(() => planLocalBrokerAction('repo', { action: 'push' }), { code: 'CLASS3_OWNER_SIGNATURE_REQUIRED', status: 403 })
  for (const input of [null, [], 'status', { action: 'read' }, { action: 'read', path: 1 }, { action: 'status', command: 'git status' }, { action: 'diff', path: [] }]) {
    assert.throws(() => planLocalBrokerAction('repo', input), { code: 'LOCAL_BROKER_REQUEST_INVALID', status: 400 })
  }
})

test('local integration plans never invoke ambient credentials and distinguish unavailable reads from mutations', () => {
  for (const surface of ['github', 'cloudflare']) {
    for (const input of [{}, { action: 'status' }]) assert.deepEqual(planLocalBrokerAction(surface, input), { kind: 'integration-status', surface })
    for (const input of [{ action: 'cli', args: ['auth', 'status'] }, { action: 'wrangler', args: ['--version'] }, { action: 'deploy' }, { action: 'secret' }, { action: 'api', method: 'POST', endpoint: '/repos/example/issues' }, { action: 'api', method: 'GET', body: {} }]) {
      assert.throws(() => planLocalBrokerAction(surface, input), { code: 'CLASS3_OWNER_SIGNATURE_REQUIRED', status: 403 })
    }
    assert.throws(() => planLocalBrokerAction(surface, { action: 'status', cwd: '/tmp' }), { code: 'LOCAL_BROKER_REQUEST_INVALID', status: 400 })
    assert.throws(() => planLocalBrokerAction(surface, { action: 'status', approved: true }), { code: 'LOCAL_BROKER_REQUEST_INVALID', status: 400 })
  }
  for (const endpoint of ['/repos/example/project/commits', 'https://example.invalid', '/user/keys', '--help']) {
    assert.deepEqual(planLocalBrokerAction('github', { action: 'api', method: 'GET', endpoint }), { kind: 'unavailable', action: 'api', code: 'LOCAL_GITHUB_READ_UNAVAILABLE' })
  }
})

test('runtime selection cannot be enabled by retained release identifiers, CAS or client approval', () => {
  assert.deepEqual(planLocalRuntimeAction('GET'), { kind: 'runtime-status' })
  for (const input of [{}, { releaseId: 'a'.repeat(64), expectedRecordId: 'b'.repeat(64), expectedEpoch: 7 }, { approved: true, ownerSignature: 'untrusted', qualificationId: 'untrusted' }]) {
    assert.throws(() => planLocalRuntimeAction('POST', input), { code: 'PEARL_QUALIFICATION_UNVERIFIABLE', status: 403 })
  }
  for (const method of ['PUT', 'PATCH', 'DELETE', 'HEAD', 'post', undefined]) assert.throws(() => planLocalRuntimeAction(method), { code: 'METHOD_UNAVAILABLE', status: 405 })
})

test('pure repository policy rejects interpreters, network tools, git execution controls and mutations', () => {
  assert.deepEqual(planModelRepoAction({ action: 'read', path: 'server/owner-grant.mjs' }), { kind: 'read', path: 'server/owner-grant.mjs' })
  assert.deepEqual(planModelRepoAction({ action: 'status' }), { kind: 'status' })
  for (const command of ['git status', 'git status --short -b']) assert.deepEqual(planModelRepoAction({ action: 'exec', command }), { kind: 'status' })
  assert.deepEqual(planModelRepoAction({ action: 'exec', command: 'git rev-parse --short=8 HEAD' }), { kind: 'head' })
  for (const command of [
    'node -e "process.exit()"', 'python -c "print(1)"', 'python3 -c "print(1)"', 'curl https://example.invalid',
    'sh -c true', 'bash -c true', 'base64 server/owner-grant.mjs', 'env node -e "0"',
    'git config --get user.email', 'git --no-pager status', 'git -c core.pager=cat status',
    'git -c core.hooksPath=/tmp/hooks status', 'git -c core.fsmonitor=helper status',
    'git --config-env=core.pager=VALUE status', 'git -c alias.inspect=status inspect',
    'git --git-dir=/tmp/other status', 'git status --short -b; node -e "0"',
    'git status | base64', 'git status\nnode -e "0"', 'git diff --ext-diff', 'git diff --textconv',
    'git diff --output=/tmp/out', 'git show HEAD:server/owner-grant.mjs', 'git log -n 10 --oneline',
    'git add .', 'git commit -m test', 'git push', 'wrangler deploy', 'gh api --method POST repos/example/issues',
  ]) assert.throws(() => planModelRepoAction({ action: 'exec', command }), policyFailure, command)
  for (const input of [
    { action: 'write', path: 'server/owner-grant.mjs', content: 'changed' },
    { action: 'commit', message: 'changed' }, { action: 'diff' }, { action: 'log' },
    { action: 'status', command: 'node' }, { action: 'read', path: 'README.md', extra: true },
  ]) assert.throws(() => planModelRepoAction(input), policyFailure)
})

test('pure repository paths exclude secrets, runtime data and protected configuration', () => {
  for (const value of ['README.md', 'docs/testing.md', 'server/owner-grant.mjs', 'apps/web/src/spatial/superagent/owner-grant.ts']) assert.doesNotThrow(() => assertModelSourcePath(value))
  for (const value of [
    '../outside.md', '/tmp/outside.md', 'server/../README.md', 'server\\owner-grant.mjs',
    '.env', '.env.local', '.git/config', '.git/hooks/pre-commit', '.aukora-x6-vault/owner-ed25519.json',
    'mirror/home/notes.txt', 'mirror/balls/HEAD.json', 'package.json', 'pnpm-workspace.yaml',
    'server/.credentials.json', 'server/credentials.mjs', 'server/private-key.mjs',
    'deploy/cloudflare/wrangler.jsonc', 'apps/web/dist/index.js', 'apps/web/node_modules/tool/index.js',
    'packages/core/test/lib/index.js', 'server/owner-grant.mjs\0.json',
  ]) assert.throws(() => assertModelSourcePath(value), policyFailure, value)
})

test('repository fixture reads reject symlink, hardlink and metadata redirection without executing git', { skip: POSIX_ONLY }, async t => {
  const root = await temporaryRoot(t)
  await fs.mkdir(path.join(root, 'server'), { mode: 0o700 })
  const source = path.join(root, 'server', 'fixture.mjs')
  await fs.writeFile(source, 'export const fixture = true\n', { flag: 'wx', mode: 0o600 })
  await fs.mkdir(path.join(root, '.git', 'refs', 'heads'), { recursive: true, mode: 0o700 })
  await fs.writeFile(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n', { flag: 'wx', mode: 0o600 })
  await fs.writeFile(path.join(root, '.git', 'refs', 'heads', 'main'), 'a'.repeat(40) + '\n', { flag: 'wx', mode: 0o600 })
  await fs.writeFile(path.join(root, '.git', 'config'), '[filter "fixture"]\n clean = deliberately-not-executable\n', { flag: 'wx', mode: 0o600 })
  const before = await inventory(root)
  const read = await readModelSourceFile(root, 'server/fixture.mjs')
  assert.ok(JSON.stringify(read).includes('export const fixture = true'))
  const status = await readModelRepositoryStatus(root)
  assert.equal(status.branch, 'main')
  assert.equal(status.head, 'a'.repeat(40))
  assert.equal(status.worktreeStatus, 'not-inspected')
  assert.deepEqual(await inventory(root), before)
  await fs.symlink(source, path.join(root, 'server', 'linked.mjs'))
  await assert.rejects(readModelSourceFile(root, 'server/linked.mjs'), policyFailure)
  await fs.link(source, path.join(root, 'server', 'hardlink.mjs'))
  await assert.rejects(readModelSourceFile(root, 'server/hardlink.mjs'), policyFailure)
  await assert.rejects(readModelSourceFile(root, 'server/fixture.mjs'), policyFailure)
  await fs.mkdir(path.join(root, 'real-source'), { mode: 0o700 })
  await fs.writeFile(path.join(root, 'real-source', 'safe.mjs'), 'synthetic', { flag: 'wx', mode: 0o600 })
  await fs.symlink(path.join(root, 'real-source'), path.join(root, 'server', 'alias'), 'dir')
  await assert.rejects(readModelSourceFile(root, 'server/alias/safe.mjs'), policyFailure)
  for (const [name, bytes] of [
    ['invalid-utf8.mjs', new Uint8Array([0xff])],
    ['binary.mjs', 'synthetic\0binary'],
    ['oversized.mjs', Buffer.alloc(2 * 1024 * 1024 + 1, 32)],
    ['embedded-key.mjs', '-----BEGIN PRIVATE KEY-----\nsynthetic-not-a-key\n'],
  ]) {
    await fs.writeFile(path.join(root, 'server', name), bytes, { flag: 'wx', mode: 0o600 })
    const unchanged = await inventory(root)
    await assert.rejects(readModelSourceFile(root, 'server/' + name), policyFailure)
    assert.deepEqual(await inventory(root), unchanged)
  }
  await fs.rename(path.join(root, '.git'), path.join(root, 'test-git-directory'))
  await fs.symlink(path.join(root, 'test-git-directory'), path.join(root, '.git'), 'dir')
  await assert.rejects(readModelRepositoryStatus(root), policyFailure)
  await fs.unlink(path.join(root, '.git'))
  await fs.writeFile(path.join(root, '.git'), 'gitdir: test-git-directory\n', { flag: 'wx', mode: 0o600 })
  await assert.rejects(readModelRepositoryStatus(root), policyFailure)
})

test('integration planners expose metadata only and reject generic Wrangler or GitHub mutations', () => {
  for (const surface of ['cloudflare', 'github']) {
    assert.deepEqual(planModelIntegrationAction(surface, { action: 'status' }), { kind: 'status', surface })
    for (const input of [
      { action: 'exec', command: 'wrangler deploy' },
      { action: 'exec', command: 'gh api --method POST repos/example/issues' },
      { action: 'exec', command: 'gh auth token' },
      { action: 'api', method: 'DELETE', path: '/repos/example' },
      { action: 'deploy' }, { action: 'write' }, { action: 'status', command: 'gh auth token' },
    ]) assert.throws(() => planModelIntegrationAction(surface, input), policyFailure)
  }
})

test('governance issuance requires one explicit candidate-bound promotion', () => {
  const normalize = input => normalizeOwnerGrantBinding(input, { now: NOW })
  // The fixed list, pinned exactly: the first eight and the seven that an earlier commit added (the judges, the grant ledger, the
  // two AUMLOK organs, the scion and the boot organ). A shorter list fails here; so does an extra name nobody decided on.
  assert.deepEqual(OWNER_GOVERNANCE_ORGANS, [
    'seed-receipts', 'seed-superagent', 'seed-pearl', 'seed-aura',
    'seed-predict', 'seed-recall', 'seed-memory', 'auma-body-map',
    'seed-judge', 'gate-judge', 'grant-ledger', 'aumlok-identity', 'aumlok-keys',
    'auma-scion', 'seed-boot',
  ])
  for (const organ of OWNER_GOVERNANCE_ORGANS) {
    for (const scope of [
      { organs: [organ] },
      { paths: [`/dsh/home/auma/seed/organs/${organ}.js`] },
      { paths: [`mirror/home/auma/seed/organs/${organ}.js`] },
      { organs: [organ], paths: [`mirror/home/auma/seed/organs/${organ}.js`] },
    ]) {
      throwsCode(() => normalize(binding({ scope })), 'OWNER_GRANT_GOVERNANCE_BINDING_REQUIRED', 403)
      const exact = binding({ scope: { ...scope, candidateSha256: 'c'.repeat(64) } })
      assert.equal(ownerGrantCanonical(normalize(exact)), browserCanonical(exact))
      throwsCode(() => normalize({ ...exact, ticketId: null }), 'OWNER_GRANT_GOVERNANCE_BINDING_REQUIRED', 403)
      throwsCode(() => normalize({ ...exact, expiresAt: null }), 'OWNER_GRANT_GOVERNANCE_BINDING_REQUIRED', 403)
      for (const candidateSha256 of [null, 1, '', 'C'.repeat(64), 'c'.repeat(63)]) {
        throwsCode(() => normalize(binding({ scope: { ...scope, candidateSha256 } })), 'OWNER_GRANT_INVALID_CANDIDATE', 400)
      }
    }
  }
  const ordinary = binding({
    ticketId: null,
    scope: { organs: ['seed-calc'], paths: ['mirror/home/auma/seed/organs/seed-calc.js'] },
  })
  assert.equal(ownerGrantCanonical(normalize(ordinary)), browserCanonical(ordinary))
  const standing = binding({ ticketId: null, expiresAt: null, scope: {
    organs: ['seed-calc', 'seed-wish'], paths: [], tools: ['tree_patch'],
  } })
  assert.equal(ownerGrantCanonical(normalize(standing)), browserCanonical(standing))
  for (const scope of [
    null, {}, { paths: [], organs: [], tools: [] },
    { tools: ['seed_cycle'] }, { tools: ['fs_write'] }, { tools: ['tree_patch'] },
    { paths: ['/workspace/fixture/x6.1'] }, { paths: ['docs/readme.md'] },
    { organs: ['*'] },
    { organs: ['seed-*'], excludedOrgans: OWNER_GOVERNANCE_ORGANS },
    { paths: ['mirror/home/auma/seed/organs/**'] },
    { paths: ['/dsh/home/auma/seed/organs'] },
    { tools: ['*'] },
    { organs: ['seed-aura', 'seed-pearl'], candidateSha256: 'c'.repeat(64) },
    { organs: ['seed-aura', 'seed-calc'], candidateSha256: 'c'.repeat(64) },
    { organs: ['seed-aura'], paths: ['docs/readme.md'], candidateSha256: 'c'.repeat(64) },
    { paths: ['../seed-aura.js'] },
    { paths: ['mirror//home/auma/seed/organs/seed-aura.js'] },
    { paths: ['mirror/home/auma/seed/organs/%73eed-aura.js'] },
    { paths: ['mirror/home/auma/seed/organs/Seed-Aura.js'] },
    { paths: ['mirror/home/auma/seed/organs/seed-aura.js/child'] },
    { paths: ['/'] }, { paths: ['mirror/home/auma/seed/organs/'] },
    { paths: ['/dsh/home/auma/seed/organs/../organs/seed-aura.js'] },
    { paths: ['mirror\\home\\auma\\seed\\organs\\seed-aura.js'] },
  ]) throwsCode(() => normalize(binding({ scope })), 'OWNER_GRANT_EXPLICIT_SCOPE_REQUIRED', 403)
  for (const scope of [
    { organs: '*' }, { paths: '*' }, { tools: '*' },
    { organs: [null] }, { organs: ['seed-aura.js'] }, { organs: ['Seed-Aura'] },
    { organs: ['seed_aura'] }, { organs: ['a'.repeat(42)] },
  ]) throwsCode(() => normalize(binding({ scope })), 'OWNER_GRANT_INVALID_SCOPE', 400)
})

test('local and Worker issuance reject standing governance grants before approval or key access', async t => {
  for (const [scope, expected] of [
    ...OWNER_GOVERNANCE_ORGANS.map(organ => [{ organs: [organ] }, 'OWNER_GRANT_GOVERNANCE_BINDING_REQUIRED']),
    ...[null, {}, { paths: [], organs: [], tools: [] },
      { tools: ['seed_cycle'] }, { tools: ['fs_write'] }, { tools: ['tree_patch'] },
      { organs: ['*'] }, { paths: ['mirror/home/auma/seed/organs/**'] },
      { paths: ['/workspace/fixture/x6.1'] },
    ].map(scope => [scope, 'OWNER_GRANT_EXPLICIT_SCOPE_REQUIRED']),
  ]) {
    const body = JSON.stringify(binding({ scope }))
    const local = localFixture({ approveOwnerGrant: approveLocalFixture })
    const cloud = workerFixture(t, { approveOwnerGrant: approveExact })
    await responseCode(local.request(GRANT_ROUTE, { body }), expected, 403)
    await responseCode(cloud.request(GRANT_ROUTE, { body }), expected, 403)
    assert.equal(local.calls.approvals + local.calls.keys + local.calls.heads, 0)
    assert.equal(cloud.calls.approvals, 0)
    assert.deepEqual(cloud.calls.keys, [])
  }
})

test('synthetic governance signatures bind candidate hash inside the existing canonical scope', { skip: POSIX_ONLY }, async t => {
  const fixture = await keyFixture(t)
  const before = await inventory(fixture.root)
  for (const organ of OWNER_GOVERNANCE_ORGANS) {
    const input = binding({ scope: {
      organs: [organ], paths: [], tools: [],
      budgetSteps: 1, expiresAt: NOW + 60000, candidateSha256: 'c'.repeat(64),
    } })
    const local = localFixture({ signer: fixture.signer, approveOwnerGrant: approveLocalFixture })
    const result = await local.request(GRANT_ROUTE, { body: JSON.stringify(input) })
    assert.equal(result.status, 200)
    assert.equal(await verifyOwnerAttestation(input, result.body.ownerGrant, [fixture.record.publicKeyHex]), 'verified')
    const cloud = workerFixture(t, { keyRecord: fixture.record, class3Authorize: async () => ({ ok: true, expiresAt: NOW + AUMLOK_LIMITS.approvalMs }) })
    const edgeResult = await cloud.request(GRANT_ROUTE, { body: JSON.stringify(input) })
    assert.equal(edgeResult.status, 200)
    assert.deepEqual(edgeResult.body.binding, input)
    assert.equal(edgeResult.body.authorization, 'bound-passkey-exact-action')
    assert.equal(edgeResult.body.ownerGrant, undefined)
    const altered = { ...input, scope: { ...input.scope, candidateSha256: 'd'.repeat(64) } }
    assert.equal(await verifyOwnerAttestation(altered, result.body.ownerGrant, [fixture.record.publicKeyHex]), 'binding-mismatch')
    assert.equal(await verifyOwnerAttestation(altered, {
      ...result.body.ownerGrant, scope: altered.scope,
    }, [fixture.record.publicKeyHex]), 'bad-signature')
    assert.equal(Object.hasOwn(result.body.ownerGrant, 'candidateSha256'), false)
    const changed = localFixture({
      approveOwnerGrant: terms => {
        changed.head.epoch++
        return approveLocalFixture(terms)
      },
    })
    await responseCode(changed.request(GRANT_ROUTE, { body: JSON.stringify(input) }), 'OWNER_GRANT_STALE_BINDING', 409)
    assert.equal(changed.calls.keys, 0)
  }
  assert.deepEqual(await inventory(fixture.root), before)
})

test('dormant JWT command shares the canonical existing-key path without invoking it', async () => {
  assert.equal(OWNER_KEY_FILE, path.join(os.homedir(), '.aukora-x6-vault', 'owner-ed25519.json'))
  const source = await fs.readFile(new URL('./mint-owner-jwt.mjs', import.meta.url), 'utf8')
  assert.match(source, /keyFile: OWNER_KEY_FILE/)
  assert.equal(source.includes("'owner-ed25519.key'"), false)
})
