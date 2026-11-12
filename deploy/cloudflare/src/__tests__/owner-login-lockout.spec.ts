import assert from 'node:assert/strict'
import test from 'node:test'
import { createWorker } from '../worker.mjs'
import { X61HeadDurableObject } from '../head-do.mjs'
import { createDurableGateLockoutStore } from '../gate-lockout.mjs'

const ORIGIN = 'https://owner-lockout.example.invalid'
function memoryStorage() {
  let rows = new Map(), queue = Promise.resolve()
  const adapter = map => ({
    get: async key => structuredClone(map.get(key)),
    put: async (key, value) => {
      assert.ok(Buffer.byteLength(JSON.stringify(value)) < 128 * 1024)
      map.set(key, structuredClone(value))
    },
    delete: async key => map.delete(key),
    list: async ({ prefix = '', limit = Infinity } = {}) => new Map([...map].filter(([key]) => key.startsWith(prefix)).slice(0, limit)),
  })
  return {
    ...adapter(rows),
    transaction(operation) {
      const result = queue.then(async () => {
        const next = structuredClone(rows)
        const value = await operation(adapter(next))
        rows.clear(); for (const [key, entry] of next) rows.set(key, entry)
        return value
      })
      queue = result.catch(() => undefined)
      return result
    },
  }
}
async function fixture() {
  const keys = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])
  const at = Date.now()
  const env = { PUBLIC_HOST: new URL(ORIGIN).host, OWNER_EMAIL: 'owner@example.invalid', OWNER_PUBLIC_KEY_HEX: Buffer.from(await crypto.subtle.exportKey('raw', keys.publicKey)).toString('hex') }
  const storage = memoryStorage()
  let head
  const recreate = () => { head = new X61HeadDurableObject({ storage, getWebSockets: () => [] }, env) }
  recreate()
  env.HEAD = { idFromName: name => name, get: () => head }
  const input = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' })).toString('base64url') + '.' + Buffer.from(JSON.stringify({ iss: 'aukora.x61.owner', aud: env.PUBLIC_HOST, email: env.OWNER_EMAIL, nbf: Math.floor(at / 1000) - 1, exp: Math.floor(at / 1000) + 600 })).toString('base64url')
  const token = input + '.' + Buffer.from(await crypto.subtle.sign('Ed25519', keys.privateKey, new TextEncoder().encode(input))).toString('base64url')
  // Job 10: only a well-formed, in-window owner JWT whose signature is checked and WRONG is a login failure (this one is
  // signed by another key). A malformed body ('invalid') is refused before any check and counts nothing.
  const other = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])
  const wrong = input + '.' + Buffer.from(await crypto.subtle.sign('Ed25519', other.privateKey, new TextEncoder().encode(input))).toString('base64url')
  const login = (body = wrong, address = '192.0.2.1', extra = {}) => createWorker({ now: () => at }).fetch(new Request(ORIGIN + '/_auth/owner', {
    method: 'POST', headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/jwt', 'cf-connecting-ip': address, ...extra }, body,
  }), env)
  return { env, storage, recreate, token, wrong, login }
}

test('owner login fifth failure locks across Worker and HeadDO recreation and ignores spoofed identities', async () => {
  const f = await fixture()
  for (let i = 0; i < 4; i++) {
    const response = await f.login(f.wrong, '192.0.2.1', { 'x-forwarded-for': `192.0.2.${i + 10}`, 'x-x6-verified-access': 'spoofed', 'x-x6-owner-assertion': f.token })
    assert.equal(response.status, 401)
    f.recreate()
  }
  const fifth = await f.login()
  assert.equal(fifth.status, 429)
  assert.equal((await fifth.json()).code, 'GATE_LOCKOUT_ACTIVE')
  assert.ok(Number(fifth.headers.get('retry-after')) > 0)
  f.recreate()
  const validWhileLocked = await f.login(f.token)
  assert.equal(validWhileLocked.status, 429)
  assert.equal(validWhileLocked.headers.get('set-cookie'), null)
  assert.equal((await f.login(f.token, '192.0.2.2')).status, 200)
  const serialized = JSON.stringify(await f.storage.get('gate-lockout:v1'))
  assert.equal(serialized.includes('192.0.2.1'), false)
  assert.equal(serialized.includes(f.token), false)
})

test('owner login success resets prior failures before the next sequence', async () => {
  const f = await fixture()
  // Malformed bodies are refused (401) and never move the gate: twenty of them first change nothing below.
  for (let i = 0; i < 20; i++) assert.equal((await f.login('invalid')).status, 401)
  assert.equal(await f.storage.get('gate-lockout:v1'), undefined)
  for (let i = 0; i < 4; i++) assert.equal((await f.login()).status, 401)
  assert.equal((await f.login(f.token)).status, 200)
  f.recreate()
  for (let i = 0; i < 4; i++) assert.equal((await f.login()).status, 401)
  assert.equal((await f.login()).status, 429)
})

test('owner login fails closed without durable HEAD and public clients cannot clear gates', async () => {
  const f = await fixture()
  const head = f.env.HEAD.get()
  const forged = await head.fetch(new Request(ORIGIN + '/_head/gate-lockout', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'success', subject: 'owner-login:' + '0'.repeat(64) }) }))
  assert.notEqual(forged.status, 200)
  delete f.env.HEAD
  const response = await f.login(f.token)
  assert.equal(response.status, 503)
  assert.equal(response.headers.get('set-cookie'), null)
})

test('durable gate serializes concurrent failures, keeps an active lock on success, and expires', async () => {
  const storage = memoryStorage()
  const gate = createDurableGateLockoutStore(storage)
  const subject = 'owner-login:' + 'a'.repeat(64)
  const attempts = await Promise.all(Array.from({ length: 5 }, () => gate.recordFailure(subject, 1000)))
  assert.deepEqual(attempts.map(x => x.ok), [true, true, true, true, false])
  assert.equal((await gate.recordSuccess(subject, 1001)).code, 'GATE_LOCKOUT_ACTIVE')
  const restored = createDurableGateLockoutStore(storage)
  assert.equal((await restored.checkSubject(subject, 2000)).code, 'GATE_LOCKOUT_ACTIVE')
  assert.equal((await restored.recordSuccess(subject, 301001)).ok, true)
  assert.equal((await restored.checkSubject(subject, 301002)).failures, 0)
})

test('durable gate capacity stays bounded and rejects corrupt persisted state', async () => {
  const storage = memoryStorage()
  const gate = createDurableGateLockoutStore(storage, { maxSubjects: 2 })
  await gate.recordFailure('one', 1000); await gate.recordFailure('two', 1000)
  assert.equal((await gate.recordFailure('three', 1000)).code, 'GATE_LOCKOUT_CAPACITY')
  assert.equal((await storage.get('gate-lockout:v1')).length, 2)
  await storage.put('gate-lockout:v1', [['one', { failedAt: [NaN], lockedUntil: 0 }]])
  await assert.rejects(gate.checkSubject('one', 1000), /GATE_STORAGE_INVALID/)
})


test('concurrent owner failures remain durable and login does not occupy an empty bootstrap', async () => {
  const f = await fixture()
  const responses = await Promise.all(Array.from({ length: 8 }, () => f.login()))
  assert.equal(responses.filter(response => response.status === 401).length, 4)
  assert.equal(responses.filter(response => response.status === 429).length, 4)
  const status = await f.env.HEAD.get().store.bootstrapStatus()
  assert.equal(status.phase, 'empty')
})

test('owner login does not issue a cookie when durable state cannot be committed', async () => {
  const f = await fixture()
  f.storage.transaction = async () => { throw new Error('storage unavailable') }
  const response = await f.login(f.token)
  assert.equal(response.status, 503)
  assert.equal(response.headers.get('set-cookie'), null)
})
