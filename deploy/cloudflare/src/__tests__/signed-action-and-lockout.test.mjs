import assert from 'node:assert/strict'
import test from 'node:test'
import { ml_dsa65 } from '@noble/post-quantum/ml-dsa.js'
import { HYBRID_ENVELOPE_DOMAIN, HYBRID_ENVELOPE_SCHEMA, canonicalJson } from '../owner-grant-policy.mjs'
import { SIGNED_ACTION_SCHEMA, verifySignedActionEnvelope } from '../signed-action.mjs'
import { createGateLockoutStore } from '../gate-lockout.mjs'

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

test('signed-action hybrid envelope verifies dual Ed25519 + ML-DSA-65 and rejects stale, expired, or node-reused keys', async () => {
  const { trustedKeys, signAction } = await createHybridTrustedKeys()
  const now = 1_794_350_000_000
  const validPayload = {
    schema: SIGNED_ACTION_SCHEMA,
    actionId: 'act_20261111_001',
    action: 'archive.verify',
    audience: 'https://node.example.invalid',
    ballId: 'a'.repeat(64),
    epoch: 167,
    expiresAt: now + 60_000,
    targetDigest: 'b'.repeat(64),
  }
  const envelope = await signAction(validPayload)
  const verified = await verifySignedActionEnvelope(envelope, {
    trustedKeys,
    nodePublicKeyHex: 'c'.repeat(64),
    expectedAudience: 'https://node.example.invalid',
    expectedBallId: 'a'.repeat(64),
    expectedEpoch: 167,
    now,
  })
  assert.equal(verified.payload.actionId, 'act_20261111_001')
  assert.equal(verified.replayKey, 'head:signed-action:act_20261111_001')

  await assert.rejects(
    () =>
      verifySignedActionEnvelope(envelope, {
        trustedKeys,
        nodePublicKeyHex: trustedKeys.ed25519PublicKeyHex,
        now,
      }),
    { code: 'NODE_KEY_IS_NOT_OWNER_KEY' },
  )

  await assert.rejects(
    () =>
      verifySignedActionEnvelope(envelope, {
        trustedKeys,
        expectedEpoch: 168,
        now,
      }),
    { code: 'SIGNED_ACTION_STALE_EPOCH' },
  )

  await assert.rejects(
    () =>
      verifySignedActionEnvelope(envelope, {
        trustedKeys,
        now: now + 60_000,
      }),
    { code: 'SIGNED_ACTION_EXPIRED' },
  )
})

test('gate-lockout enforces failure lockout and single-use origin-bound WebSocket tickets', () => {
  const store = createGateLockoutStore({ maxFailures: 3, windowMs: 10_000, lockoutMs: 30_000, ticketTtlMs: 5_000 })
  const t0 = 1_794_350_000_000

  const issued = store.issueWsTicket({ subject: 'owner@example.com', origin: 'https://node.example.invalid', now: t0 })
  assert.equal(issued.ok, true)

  const wrongOrigin = store.consumeWsTicket({ ticket: issued.ticket, origin: 'https://evil.example', now: t0 + 100 })
  assert.equal(wrongOrigin.ok, false)
  assert.equal(wrongOrigin.code, 'WS_TICKET_BINDING_MISMATCH')

  // Even a wrong-origin attempt consumes and burns the single-use ticket.
  const replayAfterBurn = store.consumeWsTicket({ ticket: issued.ticket, origin: 'https://node.example.invalid', now: t0 + 200 })
  assert.equal(replayAfterBurn.ok, false)
  assert.equal(replayAfterBurn.code, 'WS_TICKET_EXPIRED_OR_USED')

  const issued2 = store.issueWsTicket({ subject: 'owner@example.com', origin: 'https://node.example.invalid', now: t0 + 300 })
  const firstUse = store.consumeWsTicket({ ticket: issued2.ticket, origin: 'https://node.example.invalid', now: t0 + 400 })
  assert.equal(firstUse.ok, true)
  const secondUse = store.consumeWsTicket({ ticket: issued2.ticket, origin: 'https://node.example.invalid', now: t0 + 401 })
  assert.equal(secondUse.ok, false)
  assert.equal(secondUse.code, 'WS_TICKET_EXPIRED_OR_USED')

  assert.equal(store.recordFailure('attacker-ip', t0).ok, true)
  assert.equal(store.recordFailure('attacker-ip', t0 + 100).ok, true)
  const locked = store.recordFailure('attacker-ip', t0 + 200)
  assert.equal(locked.ok, false)
  assert.equal(locked.code, 'GATE_LOCKOUT_ACTIVE')
  assert.equal(store.issueWsTicket({ subject: 'attacker-ip', origin: 'https://node.example.invalid', now: t0 + 500 }).code, 'GATE_LOCKOUT_ACTIVE')
  assert.equal(store.checkSubject('attacker-ip', t0 + 30_201).ok, true)
})
