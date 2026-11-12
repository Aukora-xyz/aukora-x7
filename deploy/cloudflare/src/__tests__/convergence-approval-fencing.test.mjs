/** Adversarial fencing suite: single-use, generation, binding and expiry
 * enforcement in the AUMLOK approval path, plus state-validator forgery rejection. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomBytes, generateKeyPairSync } from 'node:crypto'
import { AUMLOK_STORAGE_KEY, createAumlokStore, aumlokClass3Binding } from '../aumlok.mjs'
import { isoCBOR } from '@simplewebauthn/server/helpers'

const ORIGIN = 'https://node.example.invalid'
const sha256 = value => createHash('sha256').update(value).digest('hex')
const at = Date.now()

const passkey = generateKeyPairSync('ec', { namedCurve: 'P-256' })
const jwk = passkey.publicKey.export({ format: 'jwk' })
const baseState = generation => ({
  schema: 'aukora.aumlok.state.v2', generation,
  binding: { aumlokId: 'a'.repeat(64), recoveryCommitment: 'b'.repeat(64),
    rootEscrow: { schema: 'aukora.aumlok.escrow.v2', ivB64: randomBytes(12).toString('base64url'), ciphertextB64: randomBytes(48).toString('base64url') },
    nodePubkeyHex: 'c'.repeat(64),
    credential: { id: randomBytes(32).toString('base64url'), counter: 0, publicKeyB64: Buffer.from(isoCBOR.encode(new Map([
      [1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')],
    ]))).toString('base64url') },
    boundAt: at, lastVerifiedAt: at, generation },
  'pepper.v1': randomBytes(32).toString('base64url'),
  challenges: [], invites: [], revocations: [], failures: 0, failedAt: [], nextAllowedAt: 0, attempts: [], approvals: [],
})

const harness = state => {
  const map = new Map([[AUMLOK_STORAGE_KEY, structuredClone(state)]])
  const storage = {
    async transaction(fn) {
      return fn({ get: async k => map.get(k), put: async (k, v) => { map.set(k, v) }, delete: async k => { map.delete(k) } })
    },
  }
  const store = createAumlokStore(storage, { origins: [ORIGIN], ownerPublicKeyHex: 'e'.repeat(64), now: () => Date.now() })
  const consume = (token, binding) => storage.transaction(tx => store.consumeApprovalInTransaction(tx, token, binding, ORIGIN))
  return { store, consume, map }
}

const approvalRecord = (token, binding, generation, expiresAt) => ({
  tokenHash: sha256(token), binding, origin: ORIGIN, generation, expiresAt, consumedAt: null,
})

test('consumed approval token cannot be replayed (single-use, persisted consumption)', async () => {
  const binding = await aumlokClass3Binding({ audience: ORIGIN, method: 'POST', pathname: '/x', body: { a: 1 } })
  const token = randomBytes(32).toString('base64url')
  const state = baseState(1)
  state.approvals = [approvalRecord(token, binding, 1, at + 60000)]
  const { consume, map } = harness(state)
  assert.equal((await consume(token, binding)).ok, true)
  assert.ok(map.get(AUMLOK_STORAGE_KEY).approvals[0].consumedAt !== null, 'consumedAt must persist in state')
  await assert.rejects(() => consume(token, binding), { message: 'CLASS3_WEBAUTHN_REQUIRED' })
})

test('approval minted at generation 1 is refused after rotation to generation 2', async () => {
  const binding = await aumlokClass3Binding({ audience: ORIGIN, method: 'POST', pathname: '/x', body: { a: 1 } })
  const token = randomBytes(32).toString('base64url')
  const state = baseState(2)
  state.approvals = [approvalRecord(token, binding, 1, at + 60000)]
  const { consume } = harness(state)
  await assert.rejects(() => consume(token, binding), { message: 'CLASS3_WEBAUTHN_REQUIRED' })
})

test('same token with substituted action bytes is refused', async () => {
  const binding = await aumlokClass3Binding({ audience: ORIGIN, method: 'POST', pathname: '/x', body: { a: 1 } })
  const other = await aumlokClass3Binding({ audience: ORIGIN, method: 'POST', pathname: '/x', body: { a: 2 } })
  const token = randomBytes(32).toString('base64url')
  const state = baseState(1)
  state.approvals = [approvalRecord(token, binding, 1, at + 60000)]
  const { consume } = harness(state)
  await assert.rejects(() => consume(token, other), { message: 'CLASS3_WEBAUTHN_REQUIRED' })
})

test('expired approval is refused', async () => {
  const binding = await aumlokClass3Binding({ audience: ORIGIN, method: 'POST', pathname: '/x', body: { a: 1 } })
  const token = randomBytes(32).toString('base64url')
  const state = baseState(1)
  state.approvals = [approvalRecord(token, binding, 1, at - 60000)]
  const { consume } = harness(state)
  await assert.rejects(() => consume(token, binding), { message: 'CLASS3_WEBAUTHN_REQUIRED' })
})

test('forged state with non-canonical base64url credential id fails closed at read', async () => {
  const state = baseState(1)
  state.binding.credential.id = 'd'.repeat(43)
  const { store } = harness(state)
  await assert.rejects(() => store.status(ORIGIN), { message: 'AUMLOK_STATE_CORRUPT' })
})
