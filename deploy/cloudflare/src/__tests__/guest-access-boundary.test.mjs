/** Synthetic owner assertions establish that invite verification is not a guest login. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { generateKeyPairSync, sign } from 'node:crypto'
import { createWorker } from '../worker.mjs'

const ORIGIN = 'https://guest-boundary.example.invalid'
const NOW = 1794000000000
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url')

function fixture() {
  const owner = generateKeyPairSync('ed25519')
  let durableCalls = 0
  const namespace = { idFromName: name => name, get: () => {
    durableCalls++
    throw new Error('An unauthenticated invite must not reach durable state')
  } }
  const env = { PUBLIC_HOST: new URL(ORIGIN).host, OWNER_EMAIL: 'owner@example.invalid',
    OWNER_PUBLIC_KEY_HEX: owner.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'),
    HEAD: namespace, MIRROR: namespace }
  const jwt = changes => {
    const payload = encode({ alg: 'EdDSA', typ: 'JWT' }) + '.' + encode({ iss: 'aukora.x61.owner',
      aud: env.PUBLIC_HOST, email: env.OWNER_EMAIL, nbf: NOW / 1000 - 1, exp: NOW / 1000 + 60, ...changes })
    return payload + '.' + sign(null, Buffer.from(payload), owner.privateKey).toString('base64url')
  }
  const worker = createWorker({ now: () => NOW })
  const call = (path, headers = {}) => worker.fetch(new Request(ORIGIN + path, {
    method: 'POST', headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', ...headers },
    body: '{}',
  }), env)
  return { jwt, call, durableCalls: () => durableCalls }
}

test('production authentication rejects guest claims even with a valid synthetic owner signature', async () => {
  const f = fixture()
  for (const changes of [{ email: 'guest@example.invalid' }, { iss: 'aukora.x61.guest' }, { type: 'guest' }, { role: 'owner' }]) {
    // The guest invite door is the one route open without a session; forged claims on it are checked below.
    for (const path of ['/_host/aumlok/approve', '/_host/aumlok/challenge', '/_head/promote', '/_mirror/delta']) {
      const response = await f.call(path, { 'x-x6-owner-assertion': f.jwt(changes) })
      assert.equal(response.status, 401)
      assert.equal((await response.json()).code, 'OWNER_ACCESS_REQUIRED')
      assert.equal(response.headers.get('set-cookie'), null)
    }
  }
  assert.equal(f.durableCalls(), 0)
})

test('invite-shaped bearer and spoofed internal guest or owner identity never authenticate', async () => {
  const f = fixture(), code = Buffer.alloc(32, 7).toString('base64url')
  for (const headers of [{ 'x-x6-owner-assertion': code }, { cookie: `CF_Authorization=${code}` },
    { authorization: `Bearer ${code}` },
    { 'x-x6-verified-access': JSON.stringify({ type: 'owner', email: 'owner@example.invalid', expires: NOW / 1000 + 60 }) },
    { 'x-x6-verified-access': JSON.stringify({ type: 'guest', inviteId: code }) }]) {
    for (const path of ['/_host/aumlok/approve', '/_host/aumlok/bind', '/_host/aumlok/status']) {
      const response = await f.call(path, headers)
      assert.equal(response.status, 401)
      assert.equal(response.headers.get('set-cookie'), null)
    }
  }
  assert.equal(f.durableCalls(), 0)
})

/** A ready edge whose HEAD records what reaches it, to see whether a forged claim ever arrives as verified access. */
function doorFixture() {
  const owner = generateKeyPairSync('ed25519'), arrived = []
  const answer = path => {
    if (path === '/_head/bootstrap-status') return { ok: true, phase: 'complete', seedId: 'a'.repeat(64), ballId: 'b'.repeat(64), epoch: 1 }
    if (path === '/_mirror/bootstrap-status') return { ok: true, phase: 'ready', seedId: 'a'.repeat(64), ballId: 'b'.repeat(64), epoch: 1 }
    if (path === '/_mirror/guest-gate') return { ok: true, gate: { ok: true, failures: 0 } }
    return { ok: false, code: 'AUMLOK_INVITE_NOT_FOUND', status: 404 }
  }
  const namespace = { idFromName: name => name, get: () => ({ fetch: async request => {
    arrived.push({ path: new URL(request.url).pathname, access: request.headers.get('x-x6-verified-access'), approval: request.headers.get('x-x6-class3-approval') })
    const body = answer(new URL(request.url).pathname)
    return Response.json(body, { status: body.ok ? 200 : 404 })
  } }) }
  const env = { PUBLIC_HOST: new URL(ORIGIN).host, OWNER_EMAIL: 'owner@example.invalid',
    OWNER_PUBLIC_KEY_HEX: owner.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'), HEAD: namespace, MIRROR: namespace }
  const jwt = changes => {
    const payload = encode({ alg: 'EdDSA', typ: 'JWT' }) + '.' + encode({ iss: 'aukora.x61.owner',
      aud: env.PUBLIC_HOST, email: env.OWNER_EMAIL, nbf: NOW / 1000 - 1, exp: NOW / 1000 + 60, ...changes })
    return payload + '.' + sign(null, Buffer.from(payload), owner.privateKey).toString('base64url')
  }
  const worker = createWorker({ now: () => NOW })
  const call = headers => worker.fetch(new Request(ORIGIN + '/_host/aumlok/redeem', {
    method: 'POST', headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ invite: {}, code: 'x' }) }), env)
  return { jwt, call, arrived }
}

test('the guest invite door: forged guest or owner claims never authenticate and never reach HEAD as verified access', async () => {
  const f = doorFixture(), code = Buffer.alloc(32, 7).toString('base64url')
  const forged = [
    ...[{ email: 'guest@example.invalid' }, { iss: 'aukora.x61.guest' }, { type: 'guest' }, { role: 'owner' }].map(changes => ({ 'x-x6-owner-assertion': f.jwt(changes) })),
    { 'x-x6-owner-assertion': code }, { cookie: `CF_Authorization=${code}` }, { authorization: `Bearer ${code}` },
    { 'x-x6-verified-access': JSON.stringify({ type: 'owner', email: 'owner@example.invalid', expires: NOW / 1000 + 60 }) },
    { 'x-x6-verified-access': JSON.stringify({ type: 'guest', inviteId: code }), 'x-x6-internal-authorized': '1', 'x-x6-class3-approval': code },
  ]
  for (const headers of forged) {
    const response = await f.call(headers)
    assert.equal(response.status, 404)
    assert.equal((await response.json()).code, 'AUMLOK_INVITE_NOT_FOUND')
    assert.equal(response.headers.get('set-cookie'), null)
  }
  const redeems = f.arrived.filter(item => item.path === '/_host/aumlok/redeem')
  assert.equal(redeems.length, forged.length)
  for (const item of redeems) { assert.equal(item.access, null); assert.equal(item.approval, null) }
  // Nothing but the seed status, the guest table and the redeem itself was asked of durable state.
  assert.deepEqual([...new Set(f.arrived.map(item => item.path))].sort(), ['/_head/bootstrap-status', '/_host/aumlok/redeem', '/_mirror/bootstrap-status', '/_mirror/guest-gate'])
  // A valid owner assertion still arrives as owner access (the normal path, not the guest door).
  const ownerResponse = await f.call({ 'x-x6-owner-assertion': f.jwt({}) })
  assert.equal(ownerResponse.status, 404)
  assert.match(f.arrived.at(-1).access, /"type":"owner"/)
})
