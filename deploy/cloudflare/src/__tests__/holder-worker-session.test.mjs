/**
 * job 4 (R1d, R6): the REAL Worker, HeadDO and MirrorDO over in-memory storage. A browser signed in by
 * the owner pass (the ambient owner JWT, which the Worker prefers) that ALSO holds a passkey session: its passkey session
 * is looked up (one HEAD read) only for a lease request whose body carries a `proof` or a `checkpoint`; every other lease
 * request costs exactly what the owner pass alone costs. A passkey-only browser gets its session id with no extra call
 * (worker.mjs line 1: `access.session`). Synthetic keys only; no network.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import { isoCBOR } from '@simplewebauthn/server/helpers'
import { AUMLOK_STORAGE_KEY } from '../aumlok.mjs'
import { X61HeadDurableObject, bootstrapPackage, digest, manifestIdCanon } from '../head-do.mjs'
import { MirrorDO } from '../mirror-do.mjs'
import { OWNER_PASSKEY, createWorker } from '../worker.mjs'
import { WORLD_HOLDER, holderProofMessage } from '../world-holder.mjs'

const ORIGIN = 'https://holder-session.example.invalid'
const OWNER = 'owner@example.invalid'
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const clone = value => structuredClone(value)
const keyHex = key => key.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex')
const sha = value => createHash('sha256').update(value).digest()
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url')
const SESSION_LOOKUP = 'HEAD /_host/aumlok/session'

function memoryStorage() {
  let rows = new Map(), tail = Promise.resolve()
  const view = map => ({ get: async key => clone(map.get(key)), put: async (key, value) => { map.set(key, clone(value)) },
    delete: async key => map.delete(key), list: async ({ prefix = '', limit = Infinity } = {}) => new Map([...map].filter(([key]) => key.startsWith(prefix)).slice(0, limit)),
    getAlarm: async () => null, setAlarm: async () => {}, deleteAlarm: async () => {} })
  const storage = Object.fromEntries(['get', 'put', 'delete', 'list', 'getAlarm', 'setAlarm', 'deleteAlarm'].map(method => [method, (...args) => view(rows)[method](...args)]))
  storage.transaction = operation => {
    const result = tail.then(async () => { const copy = clone(rows), output = await operation(view(copy)); rows = copy; return output })
    tail = result.catch(() => undefined)
    return result
  }
  return storage
}

function passkeyPair() {
  const key = generateKeyPairSync('ec', { namedCurve: 'P-256' }), jwk = key.publicKey.export({ format: 'jwk' })
  const id = randomBytes(32).toString('base64url')
  const publicKeyB64 = Buffer.from(isoCBOR.encode(new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]]))).toString('base64url')
  return { key, id, publicKeyB64 }
}
function assertionFor(passkey, challenge) {
  const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge, origin: ORIGIN, crossOrigin: false }))
  const auth = Buffer.alloc(37)
  sha(new URL(ORIGIN).hostname).copy(auth); auth[32] = 0x05; auth.writeUInt32BE(0, 33)
  const signature = sign('sha256', Buffer.concat([auth, sha(clientDataJSON)]), passkey.key.privateKey)
  return { id: passkey.id, rawId: passkey.id, type: 'public-key', clientExtensionResults: {}, response: { clientDataJSON: clientDataJSON.toString('base64url'),
    authenticatorData: auth.toString('base64url'), signature: signature.toString('base64url') } }
}

/** A seeded, bound edge: the real Worker, HeadDO and MirrorDO; every durable call the Worker makes is recorded. */
async function boundEdge() {
  const at = Date.now(), headStorage = memoryStorage(), mirrorStorage = memoryStorage()
  const owner = generateKeyPairSync('ed25519'), node = generateKeyPairSync('ed25519'), passkey = passkeyPair()
  const env = { PUBLIC_HOST: new URL(ORIGIN).host, OWNER_EMAIL: OWNER, OWNER_PUBLIC_KEY_HEX: keyHex(owner) }
  const noNetwork = async () => { throw new Error('no network in this test') }
  const head = new X61HeadDurableObject({ storage: headStorage, getWebSockets: () => [] }, env, { networkFetch: noNetwork })
  const mirror = new MirrorDO({ storage: mirrorStorage })
  const doCalls = []
  env.HEAD = { idFromName: value => value, get: () => ({ fetch: request => (doCalls.push('HEAD ' + new URL(request.url).pathname), head.fetch(request)) }) }
  env.MIRROR = { idFromName: value => value, get: () => ({ fetch: request => (doCalls.push('MIRROR ' + new URL(request.url).pathname), mirror.fetch(request)) }) }
  env.ASSETS = { fetch() { return new Response('Fixture asset') } }
  const worker = createWorker({ networkFetch: noNetwork })
  const jwt = () => {
    const payload = encode({ alg: 'EdDSA', typ: 'JWT' }) + '.' + encode({ iss: 'aukora.x61.owner', aud: env.PUBLIC_HOST, email: OWNER,
      nbf: Math.floor(Date.now() / 1000) - 1, exp: Math.floor(Date.now() / 1000) + 600 })
    return payload + '.' + sign(null, Buffer.from(payload), owner.privateKey).toString('base64url')
  }
  const call = async (path, { method = 'GET', body, cookie, headers = {} } = {}) => {
    const response = await worker.fetch(new Request(new URL(path, ORIGIN), { method,
      headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'cf-connecting-ip': '203.0.113.41', ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
        ...(cookie ? { cookie } : {}), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), env)
    const text = await response.text()
    let parsed = text
    try { parsed = JSON.parse(text) } catch { /* not JSON */ }
    return { status: response.status, body: parsed }
  }
  const source = 'export const fixture = true;', moduleSha = await digest(source)
  const draft = { version: 'x6.1-ball/v1', epoch: 1, parentBallId: null, authorPeerId: 'fixture-peer',
    entries: { fixture: { id: 'fixture', specifier: `ball:${moduleSha}`, disabled: false, config: {}, previousSpecifiers: [] } },
    modules: { [moduleSha]: { sha256: moduleSha, specifier: `ball:${moduleSha}` } } }
  const seed = await bootstrapPackage({ version: 'x61-bootstrap/v1', ball: { ...draft, ballId: await manifestIdCanon(draft) }, codeBySha: { [moduleSha]: source }, mirror: { entryCount: 0, batchDigests: [] } })
  for (const input of [{ action: 'prepare', package: seed }, { action: 'commit', seedId: seed.seedId }]) {
    const result = await call('/_bootstrap', { method: 'POST', body: input, headers: { 'x-x6-owner-assertion': jwt() } })
    assert.equal(result.status, 200, JSON.stringify(result.body))
  }
  await headStorage.put(AUMLOK_STORAGE_KEY, { schema: 'aukora.aumlok.state.v2', generation: 1,
    binding: { aumlokId: 'a'.repeat(64), recoveryCommitment: 'b'.repeat(64), nodePubkeyHex: keyHex(node),
      rootEscrow: { schema: 'aukora.aumlok.escrow.v2', ivB64: Buffer.alloc(12, 1).toString('base64url'), ciphertextB64: Buffer.alloc(48, 2).toString('base64url') },
      credential: { id: passkey.id, counter: 0, publicKeyB64: passkey.publicKeyB64 }, boundAt: at, lastVerifiedAt: at, generation: 1 },
    'pepper.v1': randomBytes(32).toString('base64url'), challenges: [], invites: [], revocations: [], failures: 0, failedAt: [], nextAllowedAt: 0, attempts: [], approvals: [] })
  const issued = (await call(OWNER_PASSKEY.challenge, { method: 'POST', body: {} })).body
  const signedIn = await worker.fetch(new Request(new URL(OWNER_PASSKEY.signin, ORIGIN), { method: 'POST',
    headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'cf-connecting-ip': '203.0.113.41', 'content-type': 'application/json' },
    body: JSON.stringify({ challengeId: issued.challengeId, credential: assertionFor(passkey, issued.publicKey.challenge) }) }), env)
  assert.equal(signedIn.status, 200, await signedIn.clone().text())
  const cookie = signedIn.headers.get('set-cookie').split(';')[0]
  return { call, jwt, cookie, doCalls, mirrorStorage }
}

/** The session's public id as thread-mount.mjs derives it from the passkey session's MAC (the cookie's last part). */
const sidOf = cookie => sha(Buffer.concat([Buffer.from('aukora-x6-session-id/1'), Buffer.from([0]), Buffer.from(cookie.split('.').at(-1))])).toString('hex').slice(0, 32)

test('job 4 R1d through the real Worker: an owner-pass browser with a passkey session pays a passkey-session lookup ONLY for a lease body with a proof or a checkpoint; its proof then verifies; a passkey-only browser needs no extra call', async () => {
  const fx = await boundEdge()
  const sid = sidOf(fx.cookie)
  const pass = () => ({ 'x-x6-owner-assertion': fx.jwt() })
  /** One lease request; answers its status, body and the durable calls it made. */
  const lease = async (body, { cookie = null, owner = true } = {}) => {
    const from = fx.doCalls.length
    const got = await fx.call('/_mirror/lease', { method: 'POST', body, ...(cookie ? { cookie } : {}), headers: owner ? pass() : {} })
    return { ...got, calls: fx.doCalls.slice(from) }
  }
  const who = { clientId: A, tabId: 'tab-a', label: 'Chrome on the Mac' }
  // Ordinary lease requests of a world never claimed: with the passkey cookie beside the owner pass, exactly the owner pass's
  // calls and answers (no session lookup), request by request.
  for (const body of [{ action: 'status', ...who }, { action: 'ask', ...who }, { action: 'status', ...who }]) {
    const alone = await lease(body)
    const both = await lease(body, { cookie: fx.cookie })
    assert.deepEqual([both.status, both.body], [alone.status, alone.body], JSON.stringify(body))
    assert.deepEqual(both.calls, alone.calls, `the same durable calls: ${JSON.stringify(body)}`)
    assert.equal(both.calls.includes(SESSION_LOOKUP), false)
  }
  const acquired = await lease({ action: 'acquire', ...who }, { cookie: fx.cookie })
  assert.equal(acquired.status, 200)
  assert.equal(acquired.calls.includes(SESSION_LOOKUP), false, 'an acquire without a proof: no lookup')
  const renewed = await lease({ action: 'renew', ...who, leaseId: acquired.body.lease.leaseId }, { cookie: fx.cookie })
  assert.deepEqual([renewed.status, renewed.calls.includes(SESSION_LOOKUP)], [200, false])
  assert.equal((await lease({ action: 'release', ...who, leaseId: acquired.body.lease.leaseId }, { cookie: fx.cookie })).calls.includes(SESSION_LOOKUP), false)
  // The preview (a checkpoint key): ONE lookup, and the answer names this passkey session's id, so the page can sign.
  const preview = await lease({ action: 'status', ...who, checkpoint: null }, { cookie: fx.cookie })
  assert.equal(preview.status, 200, JSON.stringify(preview.body))
  assert.equal(preview.body.sid, sid)
  assert.equal(preview.calls.filter(call => call === SESSION_LOOKUP).length, 1)
  // The owner pass alone (no passkey cookie): no lookup, sid null (fail closed).
  const passOnly = await lease({ action: 'status', ...who, checkpoint: null })
  assert.deepEqual([passOnly.body.sid, passOnly.calls.includes(SESSION_LOOKUP)], [null, false])
  // A reserve signed with that sid (the first claim): one lookup; its proof verifies through the real Worker and MIRROR.
  const pair = await globalThis.crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify'])
  const key = Buffer.from(await globalThis.crypto.subtle.exportKey('raw', pair.publicKey)).toString('base64url')
  const input = { action: 'reserve', ...who, expect: 0, checkpoint: null, log: preview.body.move.log, accept: [], key }
  const ts = preview.body.now
  const sig = Buffer.from(await globalThis.crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, new TextEncoder().encode(holderProofMessage({ ...input, sid }, ts)))).toString('base64url')
  const reserved = await lease({ ...input, proof: { ts, sig } }, { cookie: fx.cookie })
  assert.equal(reserved.status, 200, JSON.stringify(reserved.body))
  assert.equal(reserved.calls.filter(call => call === SESSION_LOOKUP).length, 1)
  assert.equal((await fx.mirrorStorage.get(WORLD_HOLDER)).reservation.descriptor.key, key)
  // The same signed reserve with the owner pass alone: no session, so no proof can verify: 403 with sid null, no lookup.
  const unsessioned = await lease({ ...input, proof: { ts, sig } })
  assert.deepEqual([unsessioned.status, unsessioned.body.code, unsessioned.body.sid, unsessioned.calls.includes(SESSION_LOOKUP)], [403, 'KEY_PROOF_INVALID', null, false])
  // A passkey-only browser (no owner pass): the gate's own session check is its only lookup, and the sid comes with it.
  const passkeyOnly = await lease({ action: 'status', ...who, checkpoint: null }, { cookie: fx.cookie, owner: false })
  assert.deepEqual([passkeyOnly.body.sid, passkeyOnly.calls.filter(call => call === SESSION_LOOKUP).length], [sid, 1])
})
