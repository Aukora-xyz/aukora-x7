/**
 * Manifest id, proposed signature, and parent-link checks.
 * Keys in this file are generated for the test. They are not owner keys.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PINNED_RECEIPT_SIGNERS } from './authority.ts'
import {
  MANIFEST_DOMAIN, MANIFEST_SIGNATURE_SCHEMA, canonManifestPreimage, loaderManifestPreimage,
  manifestDigest, monotoneParent, verifyManifestSignature,
} from './manifest.ts'

const PARENT = 'ab'.repeat(32)
const CHILD = 'cd'.repeat(32)

async function keyPair(): Promise<{ publicKeyHex: string; privateKey: CryptoKey }> {
  const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))
  const publicKeyHex = [...raw].map(byte => byte.toString(16).padStart(2, '0')).join('')
  return { publicKeyHex, privateKey: pair.privateKey }
}

async function sign(preimage: string, privateKey: CryptoKey): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.sign(
    { name: 'Ed25519' },
    privateKey,
    new TextEncoder().encode(MANIFEST_DOMAIN + preimage),
  ))
  return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

function draft(entries: Record<string, unknown>, epoch = 1): Record<string, unknown> {
  return {
    version: 'x6.1-ball/v1',
    ballId: CHILD,
    parentBallId: PARENT,
    epoch,
    createdAt: 10,
    entries,
    modules: {},
  }
}

test('loader and canon ids keep the host key-order split', async () => {
  const swapped = draft({ organ: { specifier: 'ball:module', disabled: false, config: {}, id: 'organ' } })
  const ordered = draft({ organ: { id: 'organ', specifier: 'ball:module', disabled: false, config: {} } })
  const loaderA = loaderManifestPreimage(swapped)
  const loaderB = loaderManifestPreimage(ordered)
  assert.notEqual(loaderA, loaderB)
  assert.equal(canonManifestPreimage(swapped), canonManifestPreimage(ordered))
  assert.equal(await manifestDigest(swapped, 'loader'), await sha(loaderA ?? ''))
  assert.notEqual(await manifestDigest(swapped, 'loader'), await manifestDigest(swapped, 'canon'))
})

test('a trusted signature verifies, and the pinned set does not adopt the envelope key', async () => {
  const signer = await keyPair()
  const other = await keyPair()
  const body = draft({ organ: { id: 'organ', specifier: 's', disabled: false, config: {} } })
  const preimage = loaderManifestPreimage(body)
  assert.ok(preimage)
  body.ballId = await manifestDigest(body, 'loader')
  const signatureHex = await sign(preimage ?? '', signer.privateKey)
  const envelope = {
    schema: MANIFEST_SIGNATURE_SCHEMA,
    ballId: body.ballId,
    idForm: 'loader',
    publicKeyHex: signer.publicKeyHex,
    signatureHex,
  }
  const trusted = await verifyManifestSignature(body, envelope, 'strict', [signer.publicKeyHex])
  assert.equal(trusted.verified, true)
  if (trusted.verified) assert.equal(trusted.idForm, 'loader')
  const pinned = await verifyManifestSignature(body, envelope, 'strict')
  assert.equal(pinned.verified, false)
  assert.equal(pinned.status, 'untrusted-key')
  assert.equal(PINNED_RECEIPT_SIGNERS.some(key => key === signer.publicKeyHex), false)

  const forged = { ...envelope, signatureHex: 'ab'.repeat(64) }
  const bad = await verifyManifestSignature(body, forged, 'strict', [signer.publicKeyHex])
  assert.equal(bad.verified, false)
  assert.equal(bad.status, 'bad-signature')

  const wrongKey = { ...envelope, publicKeyHex: other.publicKeyHex }
  const mismatched = await verifyManifestSignature(body, wrongKey, 'strict', [other.publicKeyHex])
  assert.equal(mismatched.verified, false)
  assert.equal(mismatched.status, 'bad-signature')
})

test('tamper, missing envelopes, and bad encodings stay unverified', async () => {
  const signer = await keyPair()
  const body = draft({ organ: { id: 'organ', specifier: 's', disabled: false, config: {} } })
  const preimage = loaderManifestPreimage(body)
  assert.ok(preimage)
  body.ballId = await manifestDigest(body, 'loader')
  const envelope = {
    schema: MANIFEST_SIGNATURE_SCHEMA,
    ballId: body.ballId,
    idForm: 'loader' as const,
    publicKeyHex: signer.publicKeyHex,
    signatureHex: await sign(preimage ?? '', signer.privateKey),
  }
  const tampered = { ...body, epoch: 2 }
  const moved = await verifyManifestSignature(tampered, envelope, 'strict', [signer.publicKeyHex])
  assert.equal(moved.verified, false)
  assert.equal(moved.status, 'id-mismatch')

  const resignedId = { ...tampered, ballId: await manifestDigest(tampered, 'loader') }
  const staleSig = await verifyManifestSignature(resignedId, { ...envelope, ballId: resignedId.ballId }, 'strict', [signer.publicKeyHex])
  assert.equal(staleSig.verified, false)
  assert.equal(staleSig.status, 'bad-signature')

  const absent = await verifyManifestSignature(body, null, 'unsigned-optional', [signer.publicKeyHex])
  assert.deepEqual(absent, { verified: false, status: 'unsigned' })
  const required = await verifyManifestSignature(body, null, 'strict', [signer.publicKeyHex])
  assert.deepEqual(required, { verified: false, status: 'missing' })
  const garbage = await verifyManifestSignature(body, { schema: 'nope' }, 'unsigned-optional', [signer.publicKeyHex])
  assert.equal(garbage.status, 'malformed')
  assert.equal(loaderManifestPreimage({ ...body, epoch: 1.5 }), null)
  assert.equal(loaderManifestPreimage({ ...body, entries: { organ: { config: { n: Number.NaN } } } }), null)
  assert.equal(canonManifestPreimage({ ...body, modules: [] }), null)
})

test('parent publication is monotone by one epoch and does not accept a stale or foreign parent', () => {
  const selected = { ballId: PARENT, epoch: 142 }
  assert.deepEqual(monotoneParent(selected, { ballId: CHILD, parentBallId: PARENT, epoch: 143 }), { ok: true })
  assert.deepEqual(monotoneParent(selected, { ballId: CHILD, parentBallId: PARENT, epoch: 142 }), { ok: false, reason: 'non-monotone-epoch' })
  assert.deepEqual(monotoneParent(selected, { ballId: CHILD, parentBallId: PARENT, epoch: 141 }), { ok: false, reason: 'non-monotone-epoch' })
  assert.deepEqual(monotoneParent(selected, { ballId: CHILD, parentBallId: PARENT, epoch: 144 }), { ok: false, reason: 'stale-parent' })
  assert.deepEqual(monotoneParent(selected, { ballId: CHILD, parentBallId: CHILD, epoch: 143 }), { ok: false, reason: 'unrelated-parent' })
  assert.deepEqual(monotoneParent({ ballId: null, epoch: -1 }, { ballId: CHILD, parentBallId: null, epoch: 0 }), { ok: true })
  assert.deepEqual(monotoneParent(selected, { ballId: 'zz', parentBallId: PARENT, epoch: 143 }), { ok: false, reason: 'malformed' })
})

async function sha(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}
