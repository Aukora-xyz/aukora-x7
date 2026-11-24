/** Synthetic signed-record tests: no network, real user keys, or authentication grants. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { isoCBOR } from '@simplewebauthn/server/helpers'
import { AUMLOK_STORAGE_KEY, aumlokInvitePreimage, aumlokRequestAction, createAumlokStore } from '../aumlok.mjs'
import { canonicalJson } from '../owner-grant-policy.mjs'

const ORIGIN = 'https://invite-test.example.invalid'
const NOW = Date.UTC(2026, 10, 11)
const publicHex = key => key.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex')
const b64 = (size, fill) => Buffer.alloc(size, fill).toString('base64url')

function fixture() {
  const node = generateKeyPairSync('ed25519'), passkey = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const jwk = passkey.publicKey.export({ format: 'jwk' }), code = b64(32, 27)
  const payload = { schema: 'aukora.invite.v1', inviteId: b64(32, 32), sponsorPubkeyHex: publicHex(node),
    inviteeCommitmentSha256: createHash('sha256').update('aukora.invite.invitee.v1\0').update(Buffer.from(code, 'base64url')).digest('hex'),
    assignedDomainPointer: null, quotaMonth: '2026-11', monthlySequence: 1, revoked: false, issuedAt: NOW, expiresAt: NOW + 604800000 }
  const receipt = { ...payload, signature: sign(null, Buffer.from(aumlokInvitePreimage(payload)), node.privateKey).toString('base64url') }
  let state = { schema: 'aukora.aumlok.state.v2', generation: 1,
    binding: { aumlokId: 'a'.repeat(64), recoveryCommitment: 'b'.repeat(64), nodePubkeyHex: publicHex(node),
      rootEscrow: { schema: 'aukora.aumlok.escrow.v2', ivB64: b64(12, 1), ciphertextB64: b64(48, 2) },
      credential: { id: b64(32, 3), counter: 0, publicKeyB64: Buffer.from(isoCBOR.encode(new Map([
        [1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')],
      ]))).toString('base64url') }, boundAt: NOW, lastVerifiedAt: NOW, generation: 1 },
    'pepper.v1': b64(32, 4), challenges: [], invites: [receipt], revocations: [], failures: 0, failedAt: [],
    nextAllowedAt: 0, attempts: [], approvals: [] }
  let at = NOW, writes = 0
  const storage = { transaction: operation => operation({ get: async key => key === AUMLOK_STORAGE_KEY ? structuredClone(state) : undefined,
    put: async () => { writes++; throw new Error('Read-only operation attempted a write') } }) }
  const open = () => createAumlokStore(storage, { origins: [ORIGIN], now: () => at, ownerPublicKeyHex: 'e'.repeat(64) })
  const revoke = () => {
    const record = { schema: 'aukora.invite-revocation.v1', inviteId: receipt.inviteId, sponsorPubkeyHex: publicHex(node), revokedAt: NOW }
    state.revocations.push({ ...record, signature: sign(null, Buffer.from(record.schema + '\n' + canonicalJson(record)), node.privateKey).toString('base64url') })
  }
  return { store: open(), open, receipt, code, revoke, state: () => state, setState: value => { state = value },
    setTime: value => { at = value }, writes: () => writes }
}
const rejectsCode = (promise, code) => assert.rejects(promise, error => error.code === code)

test('lists verified public receipts and revocations, including expired invites in lifetime count', async () => {
  const fx = fixture(); fx.revoke(); fx.setTime(NOW + 604800000)
  const before = structuredClone(fx.state()), result = await fx.store.invites(), status = await fx.store.status()
  assert.deepEqual(result, { ok: true, schema: 'aukora.invite-list.v1', invites: [fx.receipt], revocations: fx.state().revocations, lifetimeIssuedCount: 1 })
  assert.equal(status.invite.lifetimeIssuedCount, 1)
  assert.equal(status.invite.revokedCount, 1)
  assert.equal(JSON.stringify(result).includes('pepper'), false)
  assert.equal(JSON.stringify(result).includes('credential'), false)
  result.invites.length = 0
  assert.deepEqual(fx.state(), before)
  assert.equal(fx.writes(), 0)
})

test('verifies code possession repeatedly without consuming, enrolling, granting, or storing code', async () => {
  const fx = fixture(), before = structuredClone(fx.state())
  const result = await fx.store.redeem({ invite: fx.receipt, code: fx.code }, ORIGIN)
  assert.deepEqual(result, { ok: true, schema: 'aukora.invite-verification.v1', inviteId: fx.receipt.inviteId,
    sponsorPubkeyHex: fx.receipt.sponsorPubkeyHex, recipientStatus: 'CODE_VERIFIED', verifiedAt: NOW,
    expiresAt: fx.receipt.expiresAt, accessGranted: false, identityEnrolled: false, inviteConsumed: false,
    freshness: 'LOCAL_DURABLE_STATE_ONLY', guestAccess: { available: false, code: 'GUEST_ACCESS_UNAVAILABLE' } })
  assert.deepEqual(await fx.open().redeem({ invite: fx.receipt, code: fx.code }, ORIGIN), result)
  assert.equal(JSON.stringify(result).includes(fx.code), false)
  assert.deepEqual(fx.state(), before)
  assert.equal(fx.writes(), 0)
})

test('unknown, mismatching, foreign-sponsor, and revoked receipts fail without writes', async () => {
  const fx = fixture()
  await rejectsCode(fx.store.redeem({ invite: { ...fx.receipt, inviteId: b64(32, 51) }, code: fx.code }, ORIGIN), 'AUMLOK_INVITE_NOT_FOUND')
  await rejectsCode(fx.store.redeem({ invite: { ...fx.receipt, assignedDomainPointer: 'https://elsewhere.invalid' }, code: fx.code }, ORIGIN), 'AUMLOK_INVITE_NOT_FOUND')
  await rejectsCode(fx.store.redeem({ invite: { ...fx.receipt, sponsorPubkeyHex: 'f'.repeat(64) }, code: fx.code }, ORIGIN), 'AUMLOK_INVITE_SPONSOR_UNTRUSTED')
  fx.revoke()
  await rejectsCode(fx.store.redeem({ invite: fx.receipt, code: fx.code }, ORIGIN), 'AUMLOK_INVITE_REVOKED')
  assert.equal(fx.writes(), 0)
})

test('code input is bounded canonical 32-byte base64url and uses the client commitment domain', async () => {
  const fx = fixture(), before = structuredClone(fx.state())
  for (const code of ['', b64(31, 27), b64(33, 27), fx.code + '=', null, 'a'.repeat(32769)]) {
    await rejectsCode(fx.store.redeem({ invite: fx.receipt, code }, ORIGIN), 'AUMLOK_INVITE_REDEEM_INVALID')
  }
  await rejectsCode(fx.store.redeem({ invite: fx.receipt, code: fx.code, role: 'owner' }, ORIGIN), 'AUMLOK_INVITE_REDEEM_INVALID')
  await rejectsCode(fx.store.redeem({ invite: fx.receipt, code: b64(32, 28) }, ORIGIN), 'AUMLOK_INVITE_CODE_INVALID')
  await rejectsCode(fx.store.redeem({ invite: { ...fx.receipt, schema: 'other' }, code: fx.code }, ORIGIN), 'AUMLOK_INVITE_REDEEM_INVALID')
  await rejectsCode(fx.store.redeem({ invite: fx.receipt, code: fx.code }, 'https://other.invalid'), 'AUMLOK_ORIGIN_REQUIRED')
  assert.deepEqual(fx.state(), before)
})

test('expiry and not-yet-issued checks use local time including exact expiry', async () => {
  const fx = fixture()
  for (const at of [NOW - 1, fx.receipt.expiresAt, fx.receipt.expiresAt + 1]) {
    fx.setTime(at)
    await rejectsCode(fx.store.redeem({ invite: fx.receipt, code: fx.code }, ORIGIN), 'AUMLOK_INVITE_EXPIRED')
  }
  fx.setTime(fx.receipt.expiresAt - 1)
  assert.equal((await fx.store.redeem({ invite: fx.receipt, code: fx.code }, ORIGIN)).accessGranted, false)
})

test('stored invite and revocation signatures must verify before listing or status', async () => {
  for (const kind of ['invite', 'revocation']) {
    const fx = fixture()
    if (kind === 'revocation') fx.revoke()
    const record = kind === 'invite' ? fx.state().invites[0] : fx.state().revocations[0]
    record.signature = b64(64, 1)
    await rejectsCode(fx.store.invites(), 'AUMLOK_INVITE_STATE_CORRUPT')
    await rejectsCode(fx.store.status(), 'AUMLOK_INVITE_STATE_CORRUPT')
    await rejectsCode(fx.store.redeem({ invite: fx.receipt, code: fx.code }, ORIGIN), 'AUMLOK_INVITE_STATE_CORRUPT')
    assert.equal(fx.writes(), 0)
  }
})

test('quota gaps, duplicate slots, and invalid revocation chronology fail closed', async () => {
  for (const change of [state => { state.invites[0].monthlySequence = 2 }, state => { state.invites.push(structuredClone(state.invites[0])) },
    state => { state.revocations[0].revokedAt = NOW - 1 }]) {
    const fx = fixture(); fx.revoke(); change(fx.state())
    await assert.rejects(fx.store.invites(), error => error.status === 503)
    assert.equal(fx.writes(), 0)
  }
})

test('fresh stores list zero invites without initializing private state', async () => {
  const fx = fixture(); fx.setState(undefined)
  assert.deepEqual(await fx.store.invites(), { ok: true, schema: 'aukora.invite-list.v1', invites: [], revocations: [], lifetimeIssuedCount: 0 })
  assert.equal((await fx.store.status()).invite.lifetimeIssuedCount, 0)
  await rejectsCode(fx.store.redeem({ invite: fx.receipt, code: fx.code }, ORIGIN), 'AUMLOK_INVITE_SPONSOR_UNTRUSTED')
  assert.equal(fx.writes(), 0)
})

test('route metadata allows only bodyless GET invites and same-origin JSON POST redeem', () => {
  const request = (path, init) => new Request(ORIGIN + '/_host/aumlok/' + path, init)
  assert.equal(aumlokRequestAction(request('invites'), [ORIGIN]), 'invites')
  assert.equal(aumlokRequestAction(request('redeem', { method: 'POST', headers: { origin: ORIGIN,
    'sec-fetch-site': 'same-origin', 'content-type': 'application/json' }, body: '{}' }), [ORIGIN]), 'redeem')
  for (const value of [request('invites', { headers: { 'content-length': '1' } }), request('invites?q=1'), request('redeem'),
    request('redeem', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })]) {
    assert.throws(() => aumlokRequestAction(value, [ORIGIN]))
  }
})


test('concurrent and reopened verification cannot turn invite possession into Class 3 authority', async () => {
  const fx = fixture(), before = structuredClone(fx.state())
  const results = await Promise.all(Array.from({ length: 4 }, () => fx.open().redeem({ invite: fx.receipt, code: fx.code }, ORIGIN)))
  for (const result of results) {
    assert.equal(result.accessGranted, false)
    assert.equal(result.inviteConsumed, false)
    assert.deepEqual(result.guestAccess, { available: false, code: 'GUEST_ACCESS_UNAVAILABLE' })
    for (const token of [fx.code, fx.receipt.inviteId, JSON.stringify(result)]) {
      await rejectsCode(fx.open().verifyApproval(token, {}, ORIGIN), 'CLASS3_WEBAUTHN_REQUIRED')
    }
  }
  assert.deepEqual(fx.state(), before)
  assert.equal(fx.writes(), 0)
})

test('seven-word recovery input and privilege fields are rejected before any state writes', async () => {
  const fx = fixture(), before = structuredClone(fx.state())
  // Synthetic words only: a recovery phrase must never be sent as an invite bearer.
  for (const input of [{ invite: fx.receipt, code: 'alpha bravo charlie delta echo foxtrot golf' },
    { invite: fx.receipt, phrase: 'alpha bravo charlie delta echo foxtrot golf' },
    { invite: fx.receipt, code: fx.code, access: { type: 'owner' } },
    { invite: fx.receipt, code: fx.code, approvalToken: fx.code }]) {
    await rejectsCode(fx.store.redeem(input, ORIGIN), 'AUMLOK_INVITE_REDEEM_INVALID')
  }
  assert.deepEqual(fx.state(), before)
  assert.equal(fx.writes(), 0)
})
