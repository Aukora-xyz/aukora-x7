/**
 * the vault's fetch-site rules run BEFORE the owner session is read.
 * The PRODUCTION session path: the real Worker, the real HeadDO and MirrorDO over in-memory storage, a real passkey
 * sign-in (synthetic keys) whose session cookie is then sent with requests a sibling origin, a cross-site page or a
 * browser without fetch marks would make. A refused request costs no HEAD, MIRROR or bucket call, warm (this isolate has
 * read the session before) and cold (a new isolate), and its answer is exactly the one a signed-out caller gets on any
 * other path: it learns nothing new. Her own page and the owner's own navigation still read. No network.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import { isoCBOR } from '@simplewebauthn/server/helpers'
import { AUMLOK_STORAGE_KEY } from '../aumlok.mjs'
import { X61HeadDurableObject, bootstrapPackage, digest, manifestIdCanon } from '../head-do.mjs'
import { MirrorDO } from '../mirror-do.mjs'
import { createWorker, OWNER_PASSKEY } from '../worker.mjs'
import { createVaultBucket } from './vault-fakes.mjs'

const ORIGIN = 'https://vault-door.example.invalid'
const OWNER = 'owner@example.invalid'
const clone = value => structuredClone(value)
const keyHex = key => key.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex')
const sha = value => createHash('sha256').update(value).digest()
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url')

/** Durable Object storage in memory (transactions in order), as the sign-in door suite uses. */
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
const assertionFor = (passkey, challenge) => {
  const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge, origin: ORIGIN, crossOrigin: false }))
  const auth = Buffer.alloc(37)
  sha(new URL(ORIGIN).hostname).copy(auth); auth[32] = 0x05; auth.writeUInt32BE(0, 33)
  const signature = sign('sha256', Buffer.concat([auth, sha(clientDataJSON)]), passkey.key.privateKey)
  return { id: passkey.id, rawId: passkey.id, type: 'public-key', clientExtensionResults: {}, response: { clientDataJSON: clientDataJSON.toString('base64url'),
    authenticatorData: auth.toString('base64url'), signature: signature.toString('base64url') } }
}

/** A seeded, bound edge with a counting vault bucket; `calls` records every HEAD and MIRROR call, `bucket.calls` every bucket call. */
async function vaultEdge(t) {
  const at = Date.now(), headStorage = memoryStorage(), mirrorStorage = memoryStorage()
  const owner = generateKeyPairSync('ed25519'), node = generateKeyPairSync('ed25519'), passkey = passkeyPair()
  const identity = { schema: 'aukora.aumlok.state.v2', generation: 1,
    binding: { aumlokId: 'a'.repeat(64), recoveryCommitment: 'b'.repeat(64), nodePubkeyHex: keyHex(node),
      rootEscrow: { schema: 'aukora.aumlok.escrow.v2', ivB64: Buffer.alloc(12, 1).toString('base64url'), ciphertextB64: Buffer.alloc(48, 2).toString('base64url') },
      credential: { id: passkey.id, counter: 0, publicKeyB64: passkey.publicKeyB64 }, boundAt: at, lastVerifiedAt: at, generation: 1 },
    'pepper.v1': randomBytes(32).toString('base64url'), challenges: [], invites: [], revocations: [], failures: 0, failedAt: [], nextAllowedAt: 0, attempts: [], approvals: [] }
  const bucket = createVaultBucket()
  const env = { PUBLIC_HOST: new URL(ORIGIN).host, OWNER_EMAIL: OWNER, OWNER_PUBLIC_KEY_HEX: keyHex(owner), ARCHIVE_BUCKET: bucket }
  let network = 0
  const noNetwork = async () => { network++; throw new Error('Network forbidden in this fixture') }
  t.after(() => assert.equal(network, 0))
  const head = new X61HeadDurableObject({ storage: headStorage, getWebSockets: () => [] }, env, { networkFetch: noNetwork })
  const mirror = new MirrorDO({ storage: mirrorStorage })
  const calls = []
  env.HEAD = { idFromName: value => value, get: () => ({ fetch: request => (calls.push('HEAD ' + new URL(request.url).pathname), head.fetch(request)) }) }
  env.MIRROR = { idFromName: value => value, get: () => ({ fetch: request => (calls.push('MIRROR ' + new URL(request.url).pathname), mirror.fetch(request)) }) }
  env.ASSETS = { fetch() { return new Response('Fixture asset') } }
  const isolate = () => createWorker({ networkFetch: noNetwork })
  const warm = isolate()
  const jwt = () => {
    const payload = encode({ alg: 'EdDSA', typ: 'JWT' }) + '.' + encode({ iss: 'aukora.x61.owner', aud: env.PUBLIC_HOST, email: OWNER,
      nbf: Math.floor(Date.now() / 1000) - 1, exp: Math.floor(Date.now() / 1000) + 600 })
    return payload + '.' + sign(null, Buffer.from(payload), owner.privateKey).toString('base64url')
  }
  /** One browser request; a header given as null is left out. */
  const call = async (worker, path, { method = 'GET', body, cookie, headers = {} } = {}) => {
    const response = await worker.fetch(new Request(new URL(path, ORIGIN), { method,
      headers: Object.fromEntries(Object.entries({ origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'cf-connecting-ip': '203.0.113.40',
        ...(method === 'POST' && body !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...headers })
        .filter(([, value]) => value !== null)),
      ...(body === undefined ? {} : { body: typeof body === 'string' || body instanceof Uint8Array ? body : JSON.stringify(body) }) }), env)
    const text = await response.text()
    let parsed = text
    try { parsed = JSON.parse(text) } catch { /* not JSON */ }
    return { status: response.status, body: parsed, text }
  }
  const source = 'export const fixture = true;', moduleSha = await digest(source)
  const draft = { version: 'x6.1-ball/v1', epoch: 1, parentBallId: null, authorPeerId: 'fixture-peer',
    entries: { fixture: { id: 'fixture', specifier: `ball:${moduleSha}`, disabled: false, config: {}, previousSpecifiers: [] } },
    modules: { [moduleSha]: { sha256: moduleSha, specifier: `ball:${moduleSha}` } } }
  const seed = await bootstrapPackage({ version: 'x61-bootstrap/v1', ball: { ...draft, ballId: await manifestIdCanon(draft) }, codeBySha: { [moduleSha]: source }, mirror: { entryCount: 0, batchDigests: [] } })
  for (const input of [{ action: 'prepare', package: seed }, { action: 'commit', seedId: seed.seedId }]) {
    const result = await call(warm, '/_bootstrap', { method: 'POST', body: input, headers: { 'x-x6-owner-assertion': jwt() } })
    assert.equal(result.status, 200, JSON.stringify(result.body))
  }
  await headStorage.put(AUMLOK_STORAGE_KEY, identity)
  const issued = (await call(warm, OWNER_PASSKEY.challenge, { method: 'POST', body: {} })).body
  const signed = await warm.fetch(new Request(new URL(OWNER_PASSKEY.signin, ORIGIN), { method: 'POST',
    headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'cf-connecting-ip': '203.0.113.40', 'content-type': 'application/json' },
    body: JSON.stringify({ challengeId: issued.challengeId, credential: assertionFor(passkey, issued.publicKey.challenge) }) }), env)
  assert.equal(signed.status, 200, await signed.clone().text())
  const cookie = signed.headers.get('set-cookie').split(';')[0]
  return { env, warm, isolate, call, cookie, calls, bucket, jwt }
}

const hash = createHash('sha256').update('x').digest('hex')
const READS = [['GET', '/_vault/rescue'], ['GET', '/_vault/blob/' + hash], ['HEAD', '/_vault/blob/' + hash], ['GET', '/_vault/rescue/' + 'd'.repeat(32)]]
const WRITES = [['PUT', '/_vault/blob/' + hash], ['POST', '/_vault/rescue/' + 'd'.repeat(32) + '/verify?cursor=0']]
// What a sibling origin, a cross-site page or a browser without fetch marks would send (Origin left out: a foreign Origin
// is refused earlier still, as before).
const REFUSED_READS = [{ origin: null, 'sec-fetch-site': 'same-site' }, { origin: null, 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate' },
  { origin: null, 'sec-fetch-site': null }, { origin: null, 'sec-fetch-site': 'none', 'sec-fetch-mode': 'cors' }]
const REFUSED_WRITES = [{ origin: null, 'sec-fetch-site': 'same-site' }, { origin: null, 'sec-fetch-site': null }, { origin: null }, { 'sec-fetch-site': 'same-site' }]

test('SHOULD 1: with a LIVE owner session, a refused vault request costs no HEAD, MIRROR or bucket call, warm and cold, and is answered as a signed-out caller is', async t => {
  const fx = await vaultEdge(t)
  // Warm: her own page reads through this isolate first (the session, bootstrap and key reads happen here).
  const mine = await fx.call(fx.warm, '/_vault/rescue', { cookie: fx.cookie, headers: { origin: null } })
  assert.deepEqual([mine.status, mine.body], [200, { ok: true, rescues: [], limit: 32 }])
  assert.ok(fx.calls.length > 0 && fx.bucket.calls.length > 0, 'the allowed read did reach HEAD and the bucket')
  // The answer a signed-out caller gets on an ordinary path, and on a vault path, today.
  const signedOutElsewhere = await fx.call(fx.warm, '/_host/estate', { headers: { origin: null } })
  const signedOutVault = await fx.call(fx.warm, '/_vault/rescue', { headers: { origin: null } })
  assert.equal(signedOutElsewhere.status, 401)
  assert.deepEqual([signedOutVault.status, signedOutVault.text], [signedOutElsewhere.status, signedOutElsewhere.text])
  for (const [name, worker] of [['warm', fx.warm], ['cold', fx.isolate()]]) {
    const cases = [...READS.flatMap(([method, path]) => REFUSED_READS.map(headers => [method, path, headers])),
      ...WRITES.flatMap(([method, path]) => REFUSED_WRITES.map(headers => [method, path, headers]))]
    for (const [method, path, headers] of cases) {
      const before = { calls: fx.calls.length, bucket: fx.bucket.calls.length }
      const body = method === 'PUT' ? new TextEncoder().encode('x') : undefined
      const refused = await fx.call(worker, path, { method, body, cookie: fx.cookie, headers })
      const label = `${name}: ${method} ${path} ${JSON.stringify(headers)}`
      assert.equal(refused.status, 401, label)
      if (method !== 'HEAD') assert.equal(refused.text, signedOutElsewhere.text, label + ': the signed-out answer, word for word')
      assert.deepEqual(fx.calls.slice(before.calls), [], label + ': no HEAD or MIRROR call (no session, bootstrap or key read)')
      assert.equal(fx.bucket.calls.length, before.bucket, label + ': no bucket call')
    }
  }
  // Her own page and the owner's own navigation are unchanged, in a cold isolate too.
  const cold = fx.isolate()
  const typed = await fx.call(cold, '/_vault/rescue', { cookie: fx.cookie, headers: { origin: null, 'sec-fetch-site': 'none', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' } })
  assert.deepEqual([typed.status, typed.body], [200, { ok: true, rescues: [], limit: 32 }])
  assert.equal((await fx.call(cold, '/_vault/rescue', { cookie: fx.cookie, headers: { origin: null } })).status, 200)
  assert.equal((await fx.call(cold, '/_vault/blob/' + hash, { method: 'HEAD', cookie: fx.cookie, headers: { origin: null } })).status, 404)
})

// ── an ambient owner JWT whose check reaches no
// verdict, with no passkey session. /rescue as a navigation reaches the sign-in page (never a 503 loop); a /_vault/ API call
// answers exactly as main's other API routes do (503, retry in a second, cookie kept); a refused vault fetch mark is still
// the signed-out 401 before any session read. A passkey session sent beside the stuck cookie still decides. ──
test('job 4 rule 3: an unverifiable ambient owner JWT: /rescue navigates to the sign-in page, /_vault/ API calls answer as other API routes, refusals stay signed-out', async t => {
  const fx = await vaultEdge(t)
  const stuck = `CF_Authorization=${fx.jwt()}`
  const navigation = { origin: null, accept: 'text/html,application/xhtml+xml', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', 'sec-fetch-site': 'none' }
  const signedOut = await fx.call(fx.warm, '/_host/estate', { headers: { origin: null } })
  assert.equal(signedOut.status, 401)
  const original = crypto.subtle.verify.bind(crypto.subtle)
  for (const [name, answer] of [['a throw', () => { throw new Error('down') }], ['{}', () => ({})], ['undefined', () => undefined]]) {
    const mock = t.mock.method(crypto.subtle, 'verify', (algorithm, ...rest) => (typeof algorithm === 'string' ? algorithm : algorithm?.name) === 'Ed25519' ? answer() : original(algorithm, ...rest))
    try {
      for (const [label, worker] of [['warm', fx.warm], ['cold', fx.isolate()]]) {
        const at = `${name}, ${label}`
        // /rescue, a navigation, twice (a reload must not loop on 503): the owner sign-in page, with the passkey.
        for (const reload of [0, 1]) {
          const page = await worker.fetch(new Request(new URL('/rescue', ORIGIN), { headers: { ...Object.fromEntries(Object.entries(navigation).filter(([, value]) => value !== null)), cookie: stuck, 'cf-connecting-ip': '203.0.113.41' } }), fx.env)
          const text = await page.text()
          assert.equal(page.status, 401, `${at} /rescue reload ${reload}: ${text.slice(0, 200)}`)
          assert.match(page.headers.get('content-type') ?? '', /^text\/html/, at)
          assert.ok(text.includes('id="passkey-submit"') && text.includes('id="owner-signin"'), `${at}: the sign-in page, with the passkey`)
          assert.equal(page.headers.get('set-cookie'), null, `${at}: nothing about the cookie changes`)
        }
        // /rescue fetched by a script is not a navigation: answered as any API route is.
        const scripted = await fx.call(worker, '/rescue', { cookie: stuck, headers: { origin: null } })
        assert.deepEqual([scripted.status, scripted.body], [503, { ok: false, code: 'OWNER_SESSION_UNAVAILABLE' }], at)
        // /_vault/ API calls from her own page: word for word what main's other API routes answer with the same cookie.
        const elsewhere = await fx.call(worker, '/_host/estate', { cookie: stuck, headers: { origin: null } })
        assert.deepEqual([elsewhere.status, elsewhere.body], [503, { ok: false, code: 'OWNER_SESSION_UNAVAILABLE' }], at)
        for (const [method, path] of [...READS, ...WRITES]) {
          const before = fx.bucket.calls.length
          const vault = await fx.call(worker, path, { method, cookie: stuck, headers: { origin: method === 'GET' || method === 'HEAD' ? null : ORIGIN }, body: method === 'PUT' ? new TextEncoder().encode('x') : undefined })
          assert.equal(vault.status, 503, `${at} ${method} ${path}`)
          if (method !== 'HEAD') assert.equal(vault.text, elsewhere.text, `${at} ${method} ${path}: the other API routes' answer`)
          assert.equal(fx.bucket.calls.length, before, `${at} ${method} ${path}: no bucket call`)
        }
        // A refused fetch mark with the same stuck cookie: the signed-out answer, before any session read (no HEAD or MIRROR).
        for (const [method, path, headers] of [...READS.map(([method, path]) => [method, path, REFUSED_READS[0]]), ...WRITES.map(([method, path]) => [method, path, REFUSED_WRITES[0]])]) {
          const before = fx.calls.length
          const refused = await fx.call(worker, path, { method, cookie: stuck, headers, body: method === 'PUT' ? new TextEncoder().encode('x') : undefined })
          assert.equal(refused.status, 401, `${at} ${method} ${path}`)
          if (method !== 'HEAD') assert.equal(refused.text, signedOut.text, `${at} ${method} ${path}: the signed-out answer, word for word`)
          assert.deepEqual(fx.calls.slice(before), [], `${at} ${method} ${path}: no HEAD or MIRROR call`)
        }
        // The passkey session sent beside the stuck cookie decides: the vault reads and /rescue is the rescue page.
        const both = `${stuck}; ${fx.cookie}`
        const read = await fx.call(worker, '/_vault/rescue', { cookie: both, headers: { origin: null } })
        assert.deepEqual([read.status, read.body], [200, { ok: true, rescues: [], limit: 32 }], at)
        const rescue = await worker.fetch(new Request(new URL('/rescue', ORIGIN), { headers: { ...Object.fromEntries(Object.entries(navigation).filter(([, value]) => value !== null)), cookie: both, 'cf-connecting-ip': '203.0.113.41' } }), fx.env)
        const page = await rescue.text()
        assert.equal(rescue.status, 200, `${at}: ${page.slice(0, 200)}`)
        assert.ok(!page.includes('id="passkey-submit"'), `${at}: the rescue page itself, not the sign-in page`)
      }
    } finally { mock.mock.restore() }
  }
})
