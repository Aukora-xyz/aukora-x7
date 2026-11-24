/** The owner sign-in door on every engine, cheap for strangers, fast on repeat visits.
 * Real Worker, HeadDO, MirrorDO and AUMLOK store over in-memory storage where the owner's path is judged; small counting
 * fakes where only the Worker's own cost is measured. Synthetic keys only; no network. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import ts from 'typescript'
import { isoCBOR } from '@simplewebauthn/server/helpers'
import { AUMLOK_STORAGE_KEY, aumlokInvitePreimage } from '../aumlok.mjs'
import { X61HeadDurableObject, bootstrapPackage, digest, manifestIdCanon } from '../head-do.mjs'
import { GUEST_GATE_KEY, GUEST_GATE_LIMITS, guestGateDecision, MirrorDO } from '../mirror-do.mjs'
import { cloudWakeProvider } from '../cloud-wake-tools.mjs'
import { createGateLockoutStore } from '../gate-lockout.mjs'
import { BUILD_ROUTE, createIsolateShield, createWorker, GUEST_DOOR, guestNetwork, ISOLATE_SHIELD, OWNER_PASSKEY, staticCachePolicy } from '../worker.mjs'

const ORIGIN = 'https://signin-door.example.invalid'
const OWNER = 'owner@example.invalid'
const REOPEN = 'x61-owner-signin-reopen'
const clone = value => structuredClone(value)
const keyHex = key => key.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex')
const sha = value => createHash('sha256').update(value).digest()
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url')
const arrayBuffer = buffer => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
/** Waits until `predicate()` holds. What it waits for crosses the libuv thread pool many times (every WebCrypto call of
 * the Worker, HEAD and the passkey check), and a busy machine (a CI runner running test files in parallel) can hold one
 * such job longer than hundreds of quick event-loop turns. So the wait is bounded by elapsed time, not by a count of
 * turns: quick turns first, then 1 ms sleeps that leave the CPU to the pool, and past the limit it fails loudly, naming
 * the condition, instead of returning as if it held. */
const SETTLE_LIMIT_MS = 30000
const settle = async predicate => {
  const started = performance.now()
  for (let turn = 0; !predicate(); turn++) {
    const waited = performance.now() - started
    if (waited > SETTLE_LIMIT_MS) throw new Error(`settle: still waiting after ${String(Math.round(waited))} ms (${String(turn)} turns) for ${String(predicate)}`)
    await new Promise(resolve => (turn < 500 ? setImmediate(resolve) : setTimeout(resolve, 1)))
  }
}

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

/** The raw parts of a WebAuthn get() answer over `challenge` (base64url), as an authenticator with UV makes them. */
function assertionParts(passkey, challenge, { counter = 0 } = {}) {
  const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge, origin: ORIGIN, crossOrigin: false }))
  const auth = Buffer.alloc(37)
  sha(new URL(ORIGIN).hostname).copy(auth); auth[32] = 0x05; auth.writeUInt32BE(counter, 33)
  const signature = sign('sha256', Buffer.concat([auth, sha(clientDataJSON)]), passkey.key.privateKey)
  return { clientDataJSON, authenticatorData: auth, signature }
}
const assertionFor = (passkey, challenge) => {
  const parts = assertionParts(passkey, challenge)
  return { id: passkey.id, rawId: passkey.id, type: 'public-key', clientExtensionResults: {}, response: { clientDataJSON: parts.clientDataJSON.toString('base64url'),
    authenticatorData: parts.authenticatorData.toString('base64url'), signature: parts.signature.toString('base64url') } }
}

/** A seeded, bound edge (real objects). `rewriteSigninKey` may change what HEAD's signin-key answers, to stand for a store that records more. */
async function boundEdge(t, { rewriteSigninKey = null, expectNetwork = false } = {}) {
  const at = Date.now(), headStorage = memoryStorage(), mirrorStorage = memoryStorage()
  const owner = generateKeyPairSync('ed25519'), node = generateKeyPairSync('ed25519'), passkey = passkeyPair()
  const identity = { schema: 'aukora.aumlok.state.v2', generation: 1,
    binding: { aumlokId: 'a'.repeat(64), recoveryCommitment: 'b'.repeat(64), nodePubkeyHex: keyHex(node),
      rootEscrow: { schema: 'aukora.aumlok.escrow.v2', ivB64: Buffer.alloc(12, 1).toString('base64url'), ciphertextB64: Buffer.alloc(48, 2).toString('base64url') },
      credential: { id: passkey.id, counter: 0, publicKeyB64: passkey.publicKeyB64 }, boundAt: at, lastVerifiedAt: at, generation: 1 },
    'pepper.v1': randomBytes(32).toString('base64url'), challenges: [], invites: [], revocations: [], failures: 0, failedAt: [], nextAllowedAt: 0, attempts: [], approvals: [] }
  const env = { PUBLIC_HOST: new URL(ORIGIN).host, OWNER_EMAIL: OWNER, OWNER_PUBLIC_KEY_HEX: keyHex(owner) }
  let network = 0
  const noNetwork = async () => { network++; throw new Error('Network forbidden in sign-in door fixture') }
  const head = new X61HeadDurableObject({ storage: headStorage, getWebSockets: () => [] }, env, { networkFetch: noNetwork })
  const mirror = new MirrorDO({ storage: mirrorStorage })
  const doCalls = []
  env.HEAD = { idFromName: value => value, get: () => ({ fetch: async request => {
    const path = new URL(request.url).pathname
    doCalls.push('HEAD ' + path)
    const response = await head.fetch(request)
    if (path !== '/_host/aumlok/signin-key' || !rewriteSigninKey || !response.ok) return response
    return Response.json(rewriteSigninKey(await response.json()))
  } }) }
  env.MIRROR = { idFromName: value => value, get: () => ({ fetch: request => (doCalls.push('MIRROR ' + new URL(request.url).pathname), mirror.fetch(request)) }) }
  env.ASSETS = { fetch() { return new Response('Fixture asset') } }
  t.after(() => { if (!expectNetwork) assert.equal(network, 0) })
  const clock = { offset: 0 }
  const worker = createWorker({ networkFetch: noNetwork, now: () => Date.now() + clock.offset })
  const jwt = () => {
    const payload = encode({ alg: 'EdDSA', typ: 'JWT' }) + '.' + encode({ iss: 'aukora.x61.owner', aud: env.PUBLIC_HOST, email: OWNER,
      nbf: Math.floor(Date.now() / 1000) - 1, exp: Math.floor(Date.now() / 1000) + 600 })
    return payload + '.' + sign(null, Buffer.from(payload), owner.privateKey).toString('base64url')
  }
  // A header given as null is left out of the request (no Origin, no fetch metadata).
  const call = async (path, { method = 'GET', body, cookie, address = '203.0.113.40', headers = {} } = {}) => {
    const response = await worker.fetch(new Request(new URL(path, ORIGIN), { method,
      headers: Object.fromEntries(Object.entries({ origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'cf-connecting-ip': address,
        ...(method === 'POST' ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...headers })
        .filter(([, value]) => value !== null)),
      ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) }), env)
    const text = await response.text()
    let parsed = text
    try { parsed = JSON.parse(text) } catch { /* HTML */ }
    return { response, body: parsed }
  }
  const source = 'export const fixture = true;', moduleSha = await digest(source)
  const draft = { version: 'x6.1-ball/v1', epoch: 1, parentBallId: null, authorPeerId: 'fixture-peer',
    entries: { fixture: { id: 'fixture', specifier: `ball:${moduleSha}`, disabled: false, config: {}, previousSpecifiers: [] } },
    modules: { [moduleSha]: { sha256: moduleSha, specifier: `ball:${moduleSha}` } } }
  const seed = await bootstrapPackage({ version: 'x61-bootstrap/v1', ball: { ...draft, ballId: await manifestIdCanon(draft) }, codeBySha: { [moduleSha]: source }, mirror: { entryCount: 0, batchDigests: [] } })
  for (const input of [{ action: 'prepare', package: seed }, { action: 'commit', seedId: seed.seedId }]) {
    const result = await call('/_bootstrap', { method: 'POST', body: input, headers: { 'x-x6-owner-assertion': jwt() } })
    assert.equal(result.response.status, 200, JSON.stringify(result.body))
  }
  await headStorage.put(AUMLOK_STORAGE_KEY, identity)
  const signIn = async (options = {}) => {
    const issued = (await call(OWNER_PASSKEY.challenge, { method: 'POST', body: {}, ...options })).body
    return call(OWNER_PASSKEY.signin, { method: 'POST', body: { challengeId: issued.challengeId, credential: assertionFor(passkey, issued.publicKey.challenge) }, ...options })
  }
  const ownerCounters = async () => {
    const state = await headStorage.get(AUMLOK_STORAGE_KEY)
    return { failures: state.failures, failedAt: state.failedAt, nextAllowedAt: state.nextAllowedAt, approvals: state.approvals, headGates: await headStorage.get('gate-lockout:v1') ?? null }
  }
  return { env, worker, call, signIn, passkey, node, headStorage, mirrorStorage, doCalls, clock, ownerCounters, network: () => network }
}

/**
 * The real sign-in page, its one script run against a fake browser whose network is the real Worker above.
 * `deliver(response, path, ordinal)` may hold a challenge answer before the page sees it (a slow network); `ordinal` is
 * the request's place in `requests`, so a test can name one request whichever answer the Worker finishes first. Each
 * request whose answer was handed to the page, or whose fetch failed, is recorded by ordinal in `settled`. `manualPasskey` makes each
 * passkey prompt wait until the test answers it (a phone), and it ends with AbortError when the page aborts it;
 * `webauthn: false` is a browser without passkey support; `referrer` is the page the link was on; `hash` is the
 * address-bar fragment the page was opened with; `respond(path)` may answer a request in the node's place (a reply the
 * fixture cannot easily produce); `addressBarStuck` makes the browser refuse to replace the address-bar entry (SecurityError,
 * the fragment stays). Both page clocks are `pageClock.offset` ahead; the wall clock alone is a further
 * `pageClock.wall` ahead (a Mac that slept). Each request deadline (AbortSignal.timeout) is recorded in `deadlines`,
 * apart from `timers`, and fired only by the test.
 */
async function signinPage(t, fx, { name = '', failFirstChallenge = false, cookie = null, address = '203.0.113.41', deliver = null, manualPasskey = false, webauthn = true, referrer = undefined, pageClock = { offset: 0, wall: 0 }, hash = '', respond = null, addressBarStuck = false } = {}) {
  const page = await fx.call('/', { headers: { accept: 'text/html', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' } })
  assert.equal(page.response.status, 401)
  const dom = new JSDOM(page.body, { url: ORIGIN, pretendToBeVisual: true, ...(referrer ? { referrer } : {}) })
  t.after(() => dom.window.close())
  const document = dom.window.document
  const jar = { cookie }, requests = [], settled = [], replacements = [], timers = new Map(), gets = [], prompts = [], issued = [], deadlines = [], said = [], bodies = [], addressBar = []
  let challenges = 0, nextTimer = 0
  const statusNode = document.getElementById('passkey-status')
  const watcher = new dom.window.MutationObserver(() => said.push(statusNode.textContent))
  watcher.observe(statusNode, { childList: true, characterData: true, subtree: true })
  t.after(() => watcher.disconnect())
  const win = { name, ...(webauthn ? { PublicKeyCredential: function PublicKeyCredential() {} } : {}), addEventListener: dom.window.addEventListener.bind(dom.window),
    location: { origin: ORIGIN, replace: destination => replacements.push(destination), pathname: '/', hash },
    history: { replaceState: (state, unused, destination) => {
      if (addressBarStuck) throw new DOMException('The operation is insecure.', 'SecurityError')
      addressBar.push(destination); win.location.hash = ''
    } } }
  const credentials = { get(options) {
    // The answer is made from exactly what the page passed: its challenge bytes, its allow-list.
    gets.push(options)
    const challenge = Buffer.from(options.publicKey.challenge).toString('base64url')
    const parts = assertionParts(fx.passkey, challenge)
    const answer = { id: fx.passkey.id, rawId: arrayBuffer(Buffer.from(fx.passkey.id, 'base64url')), type: 'public-key', getClientExtensionResults: () => ({}),
      response: { clientDataJSON: arrayBuffer(parts.clientDataJSON), authenticatorData: arrayBuffer(parts.authenticatorData), signature: arrayBuffer(parts.signature), userHandle: null } }
    if (!manualPasskey) return Promise.resolve(answer)
    return new Promise((resolve, reject) => {
      prompts.push({ options, answer: () => resolve(answer) })
      options.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')))
    })
  } }
  runInNewContext(document.querySelector('script').textContent, {
    document, window: win, navigator: webauthn ? { credentials } : {}, AbortController, URL, btoa, atob, TextDecoder,
    Date: { now: () => Date.now() + pageClock.offset + (pageClock.wall ?? 0) }, performance: { now: () => performance.now() + pageClock.offset },
    AbortSignal: { timeout(ms) { const controller = new AbortController(); deadlines.push({ ms, fire: () => controller.abort() }); return controller.signal } },
    setTimeout(callback, delay) { timers.set(++nextTimer, { callback, delay }); return nextTimer },
    clearTimeout(timer) { timers.delete(timer) },
    async fetch(path, options) {
      const ordinal = requests.length
      requests.push(path)
      bodies.push(options.body)
      try {
        if (path === OWNER_PASSKEY.challenge && failFirstChallenge && challenges++ === 0) throw new TypeError('Failed to fetch')
        const stand = respond ? respond(path) : undefined
        if (stand) return stand
        const response = await fx.worker.fetch(new Request(new URL(path, ORIGIN), { method: options.method,
          headers: { ...options.headers, origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'cf-connecting-ip': address, ...(jar.cookie ? { cookie: jar.cookie } : {}) },
          body: options.body }), fx.env)
        const set = response.headers.get('set-cookie')
        if (set) jar.cookie = set.split(';')[0]
        if (path === OWNER_PASSKEY.challenge && response.status === 200) issued.push(await response.clone().json())
        if (deliver) await deliver(response, path, ordinal)
        return response
      } finally { settled.push(ordinal) }
    },
  })
  const button = document.getElementById('passkey-submit'), status = document.getElementById('passkey-status')
  const click = () => button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  return { dom, document, win, jar, requests, settled, bodies, addressBar, replacements, timers, gets, prompts, issued, deadlines, said, button, status, click, pageClock }
}

test('B3: the challenge is fetched before the click, and the click asks for the passkey before any network wait', async t => {
  const fx = await boundEdge(t)
  const page = await signinPage(t, fx)
  // On load: one challenge request, and a refresh is scheduled before that challenge runs out.
  await settle(() => page.timers.size === 1)
  assert.deepEqual(page.requests, [OWNER_PASSKEY.challenge])
  const [refresh] = [...page.timers.values()]
  assert.ok(refresh.delay > 0 && refresh.delay <= 120000 - 20000, String(refresh.delay))
  assert.equal(page.button.disabled, false)
  // The click: credentials.get runs synchronously inside the click handler (no await before it).
  page.click()
  assert.equal(page.gets.length, 1, 'credentials.get was called inside the click, before any network wait')
  assert.equal(page.requests.length, 1, 'no request was made between the click and the passkey prompt')
  const options = page.gets[0].publicKey
  assert.equal(options.userVerification, 'required')
  assert.equal(options.rpId, new URL(ORIGIN).hostname)
  assert.deepEqual(options.hints, ['client-device', 'hybrid'])
  assert.equal(Buffer.from(options.allowCredentials[0].id).toString('base64url'), fx.passkey.id)
  // Then the proof goes to the node and the page opens the app.
  await settle(() => page.replacements.length === 1)
  assert.deepEqual(page.replacements, ['/'])
  assert.deepEqual(page.requests, [OWNER_PASSKEY.challenge, OWNER_PASSKEY.signin])
  assert.match(page.jar.cookie, /^__Host-x61-owner=/)
  assert.equal((await fx.call('/__x6/status', { cookie: page.jar.cookie })).response.status, 200)
})

test('B3: a held challenge always leaves time for a phone sign-in, and the prompt never outlives the challenge', async t => {
  const fx = await boundEdge(t)
  const life = 120000
  // Held for at most half its life: the refresh comes while a full minute is still left.
  const page = await signinPage(t, fx)
  await settle(() => page.timers.size === 1)
  const [refresh] = [...page.timers.values()]
  assert.ok(refresh.delay > 0 && refresh.delay <= life - 60000, String(refresh.delay))
  // Clicked 50 s after the prefetch (refresh not yet run): the held challenge is used, and the prompt's own timeout is
  // only what is left of the challenge, so the browser can never accept a passkey the node will refuse as expired.
  page.pageClock.offset = 50000
  page.click()
  assert.equal(page.gets.length, 1, 'the held challenge was used inside the click')
  const timeout = page.gets[0].publicKey.timeout
  assert.ok(timeout >= 60000 && timeout <= life - 50000, String(timeout))
  await settle(() => page.replacements.length === 1)
  assert.deepEqual(page.replacements, ['/'])
  // Clicked 65 s after the prefetch with the refresh starved (a throttled background timer): too little is left for a
  // phone sign-in, so the page asks for a fresh challenge first (never prompting after that wait), says when it is
  // ready, and the next press prompts at once with the fresh challenge's time.
  const late = await signinPage(t, fx, { address: '203.0.113.42' })
  await settle(() => late.timers.size === 1)
  late.pageClock.offset = 65000
  late.click()
  assert.equal(late.gets.length, 0, 'a challenge with about a minute left is not used')
  assert.match(late.status.textContent, /Asking this node/)
  await settle(() => /again/.test(late.status.textContent))
  assert.equal(late.gets.length, 0, 'no prompt after a network wait')
  assert.equal(late.button.disabled, false)
  const asked = late.requests.length
  late.click()
  assert.equal(late.gets.length, 1, 'the next press prompts inside the click')
  assert.equal(late.requests.length, asked, 'with no request between the press and the prompt')
  assert.ok(late.gets[0].publicKey.timeout > life - 10000, String(late.gets[0].publicKey.timeout))
  await settle(() => late.replacements.length === 1)
  assert.deepEqual(late.replacements, ['/'])
})

test('B3: a challenge lives the node\'s span from when it was REQUESTED: delivered at 10 s, pressed at 64 s, a phone answering at 122 s', async t => {
  const fx = await boundEdge(t)
  // One timeline t, two clocks. HEAD's own store reads the real clock, so the node's clock is set to reach real time at
  // t = 122 s: node time = real time + (t - 122 s). The page's monotonic clock reads t on its own scale (skewed from the
  // node by 122 s, which must not matter). The first challenge is issued at t = 0 and delivered only at t = 10 s.
  const T = 122000
  fx.clock.offset = -T
  let release = null, first = true
  const delivered = new Promise(resolve => { release = resolve })
  const page = await signinPage(t, fx, { manualPasskey: true,
    deliver: async (response, path) => { if (path === OWNER_PASSKEY.challenge && first) { first = false; await delivered } } })
  const at = time => { fx.clock.offset = time - T; page.pageClock.offset = time }
  await settle(() => page.issued.length === 1)
  const [old] = page.issued
  const life = old.expiresAt - (Date.now() + fx.clock.offset)
  assert.ok(life > 119000 && life <= 120000, `the node gave it 120 s from t = 0: ${String(life)}`)
  at(10000)
  release()
  await settle(() => page.timers.size === 1)
  // Counted from the request (t = 0), not the delivery: the refresh is due when 60 s (plus the margin) is left, at 55 s.
  const [refresh] = [...page.timers.values()]
  assert.ok(refresh.delay > 44000 && refresh.delay <= 45000, String(refresh.delay))
  // Pressed at 64 s with the refresh starved: 56 s of the node's 120 s remain, too little for a phone, so the page does
  // not prompt with it (before this fix it did, with a 61 s timeout).
  at(64000)
  page.click()
  assert.equal(page.gets.length, 0, 'a challenge with 56 s left is never used')
  assert.match(page.status.textContent, /Asking this node/)
  await settle(() => /again/.test(page.status.textContent))
  assert.equal(page.gets.length, 0)
  page.click()
  assert.equal(page.gets.length, 1, 'the next press prompts inside the click')
  const timeout = page.gets[0].publicKey.timeout
  assert.ok(timeout > 114000 && timeout <= 115000, `requested at 64 s, it ends 5 s before its 184 s expiry: ${String(timeout)}`)
  assert.ok([...page.timers.values()].some(timer => timer.delay === timeout), 'and the prompt is aborted at that deadline')
  // The phone answers at 122 s: inside the fresh challenge, so the node accepts it and the page opens the app.
  at(122000)
  page.prompts[0].answer()
  await settle(() => page.replacements.length === 1)
  assert.deepEqual(page.replacements, ['/'])
  assert.match(page.jar.cookie, /^__Host-x61-owner=/)
  // The node's expiry edge for the challenge issued at t = 0: a proof over it is refused at 120 s and at 122 s, which is
  // where a prompt started on it at 64 s would have ended.
  for (const time of [120000, 122000]) {
    at(time)
    const late = await fx.call(OWNER_PASSKEY.signin, { method: 'POST', body: { challengeId: old.challengeId, credential: assertionFor(fx.passkey, old.publicKey.challenge) } })
    assert.equal(late.response.status, 409, String(time))
    assert.equal(late.body.code, 'AUMLOK_SIGNIN_CHALLENGE_EXPIRED')
  }
})

test('B3: the prompt is ended at the challenge deadline (the WebAuthn timeout is only a hint), and a late answer is never sent', async t => {
  const fx = await boundEdge(t)
  const page = await signinPage(t, fx, { manualPasskey: true })
  await settle(() => page.timers.size === 1)
  page.pageClock.offset = 50000
  page.click()
  assert.equal(page.gets.length, 1)
  const { timeout } = page.gets[0].publicKey
  assert.ok(timeout >= 60000 && timeout <= 65000, String(timeout))
  assert.equal(page.gets[0].signal.aborted, false)
  const stop = [...page.timers.values()].find(timer => timer.delay === timeout)
  assert.ok(stop, 'an abort is armed at the deadline')
  page.pageClock.offset = 50000 + timeout
  stop.callback()
  assert.equal(page.gets[0].signal.aborted, true)
  await settle(() => /ran out/.test(page.status.textContent))
  assert.equal(page.requests.includes(OWNER_PASSKEY.signin), false, 'nothing was sent')
  assert.equal(page.button.disabled, false)
  // An answer that comes after the deadline, before the abort has run, is not sent either.
  const slow = await signinPage(t, fx, { manualPasskey: true, address: '203.0.113.43' })
  await settle(() => slow.timers.size === 1)
  slow.pageClock.offset = 50000
  slow.click()
  assert.equal(slow.gets.length, 1)
  slow.pageClock.offset = 50000 + slow.gets[0].publicKey.timeout + 1
  slow.prompts[0].answer()
  await settle(() => /ran out/.test(slow.status.textContent))
  assert.equal(slow.requests.includes(OWNER_PASSKEY.signin), false, 'a proof past its deadline is never sent')
})

test('B3: a Mac that slept: wall and node time jump 180 s while the monotonic clock barely moves; the stale challenge is never used', async t => {
  const fx = await boundEdge(t)
  // HEAD's store reads the real clock, so the node starts 180 s behind it and the sleep brings it to real time.
  const T = 180000
  const asleep = async options => {
    fx.clock.offset = -T
    const page = await signinPage(t, fx, options)
    await settle(() => page.timers.size === 1)
    assert.equal(page.issued.length, 1)
    page.pageClock.wall = T; page.pageClock.offset = 200; fx.clock.offset = 0
    return page
  }
  const challengeOf = options => Buffer.from(options.publicKey.challenge).toString('base64url')
  // Woken and shown again (visible, a restored page, focus): the held challenge is dropped and a fresh one fetched.
  const shown = await asleep()
  shown.document.dispatchEvent(new shown.dom.window.Event('visibilitychange'))
  shown.dom.window.dispatchEvent(new shown.dom.window.PageTransitionEvent('pageshow', { persisted: true }))
  shown.dom.window.dispatchEvent(new shown.dom.window.FocusEvent('focus'))
  await settle(() => shown.issued.length === 2 && shown.timers.size === 1)
  assert.deepEqual(shown.requests, [OWNER_PASSKEY.challenge, OWNER_PASSKEY.challenge], 'one fresh request for all three events')
  shown.click()
  assert.equal(shown.gets.length, 1)
  assert.equal(challengeOf(shown.gets[0]), shown.issued[1].publicKey.challenge, 'the fresh challenge, never the stale one')
  await settle(() => shown.replacements.length === 1)
  assert.deepEqual(shown.replacements, ['/'])
  // Pressed straight after waking, with no event: no prompt, nothing sent, a fresh challenge, then one more press.
  const pressed = await asleep({ address: '203.0.113.44' })
  pressed.click()
  assert.equal(pressed.gets.length, 0, 'no prompt with a challenge 180 s old by the wall clock')
  assert.match(pressed.status.textContent, /Asking this node/)
  await settle(() => /again/.test(pressed.status.textContent))
  pressed.click()
  assert.equal(pressed.gets.length, 1)
  assert.equal(challengeOf(pressed.gets[0]), pressed.issued[1].publicKey.challenge)
  await settle(() => pressed.replacements.length === 1)
  assert.equal(pressed.requests.filter(path => path === OWNER_PASSKEY.signin).length, 1, 'only the fresh proof was ever sent')
  // A wall clock moved back is not trusted either.
  const back = await signinPage(t, fx, { address: '203.0.113.45' })
  await settle(() => back.timers.size === 1)
  back.pageClock.wall = -1000
  back.click()
  assert.equal(back.gets.length, 0)
})

test('B3: an older challenge request that fails or answers late never clears or replaces a newer challenge', async t => {
  const fx = await boundEdge(t)
  for (const outcome of ['reject', 'resolve']) {
    let first = true, finish = null
    const late = new Promise((resolve, reject) => { finish = () => (outcome === 'reject' ? reject(new TypeError('Failed to fetch')) : resolve()) })
    const page = await signinPage(t, fx, { address: outcome === 'reject' ? '203.0.113.46' : '203.0.113.47',
      deliver: async (response, path) => { if (path === OWNER_PASSKEY.challenge && first) { first = false; await late } } })
    await settle(() => page.issued.length === 1)
    // The first request outlives its 10 s deadline and is abandoned; a press then gets a newer challenge.
    assert.equal(page.deadlines.length, 1); assert.equal(page.deadlines[0].ms, 10000)
    page.deadlines[0].fire()
    for (let index = 0; index < 5; index++) await new Promise(resolve => setImmediate(resolve))
    assert.equal(page.button.disabled, false)
    page.click()
    await settle(() => /again/.test(page.status.textContent))
    assert.equal(page.issued.length, 2)
    // Now the old request finishes: it must change nothing.
    finish()
    // The old request (ordinal 0) has reached the page before the check, however slow the machine.
    await settle(() => page.settled.includes(0))
    for (let index = 0; index < 50; index++) await new Promise(resolve => setImmediate(resolve))
    page.click()
    assert.equal(page.gets.length, 1, `${outcome}: the newer challenge is still held`)
    assert.equal(Buffer.from(page.gets[0].publicKey.challenge).toString('base64url'), page.issued[1].publicKey.challenge, outcome)
    await settle(() => page.replacements.length === 1)
    assert.deepEqual(page.replacements, ['/'])
  }
})

test('B3: answers that arrive too old to use are never announced as ready; two automatic retries, then plain words and a press works', async t => {
  const fx = await boundEdge(t)
  const pageClock = { offset: 0, wall: 0 }
  let slow = true
  const page = await signinPage(t, fx, { pageClock, deliver: async (response, path) => { if (path === OWNER_PASSKEY.challenge && slow) pageClock.offset += 65000 } })
  await settle(() => page.requests.length === 3 && /Press/.test(page.status.textContent))
  for (let index = 0; index < 50; index++) await new Promise(resolve => setImmediate(resolve))
  assert.equal(page.requests.length, 3, 'the first answer and two retries, then it waits')
  assert.match(page.status.textContent, /^This node answered too slowly\. Press “Sign in with passkey” to try again\.$/)
  assert.ok(page.said.every(text => !/^Ready/.test(text)), JSON.stringify(page.said))
  assert.equal(page.gets.length, 0); assert.equal(page.button.disabled, false)
  // The network recovers: a press fetches, says Ready, and the next press prompts.
  slow = false
  page.click()
  await settle(() => /^Ready/.test(page.status.textContent))
  page.click()
  assert.equal(page.gets.length, 1)
  await settle(() => page.replacements.length === 1)
  assert.deepEqual(page.replacements, ['/'])
})

test('B3: a challenge request that never settles ends at its 10 s deadline; the button comes back and another press works', async t => {
  const fx = await boundEdge(t)
  let hang = -1
  const page = await signinPage(t, fx, { failFirstChallenge: true,
    deliver: async (response, path, ordinal) => { if (path === OWNER_PASSKEY.challenge && ordinal === hang) await new Promise(() => {}) } })
  // The prefetch has failed (its fetch settled). The page's handling of that failure is all promise reactions, so one
  // turn of the event loop after it finishes that handling: nothing is in flight when the button is pressed.
  await settle(() => page.settled.length === 1)
  assert.deepEqual(page.requests, [OWNER_PASSKEY.challenge])
  await new Promise(resolve => setImmediate(resolve))
  // The request THIS press makes is the one that never settles. It is named by its order, not by whose answer the
  // Worker finishes first: the abandoned request's answer may be finished after the next press's request (that late
  // answer is ignored by generation, see the test above about older challenge requests).
  hang = page.requests.length
  page.click()
  assert.equal(page.requests.length, hang + 1, 'the press started its own request; it did not join the failed prefetch')
  assert.match(page.status.textContent, /Asking this node/)
  assert.equal(page.button.disabled, true)
  await settle(() => page.deadlines.length === 2)
  assert.equal(page.deadlines[1].ms, 10000)
  page.deadlines[1].fire()
  await settle(() => page.button.disabled === false)
  assert.match(page.status.textContent, /did not answer in time\. Press “Sign in with passkey” to try again/)
  page.click()
  await settle(() => /^Ready/.test(page.status.textContent))
  page.click()
  assert.equal(page.gets.length, 1)
  await settle(() => page.replacements.length === 1)
  assert.deepEqual(page.replacements, ['/'])
})

test('B3: the ceremony binding holds for a prefetched challenge: single use, and a captured sign-in is dead after sign-out', async t => {
  const fx = await boundEdge(t)
  const page = await signinPage(t, fx)
  await settle(() => page.timers.size === 1)
  // Capture exactly what the page sends.
  const sent = []
  const original = fx.worker.fetch.bind(fx.worker)
  fx.worker.fetch = async (request, env) => {
    if (new URL(request.url).pathname === OWNER_PASSKEY.signin) sent.push(await request.clone().text())
    return original(request, env)
  }
  page.click()
  await settle(() => page.replacements.length === 1)
  assert.equal(sent.length, 1)
  const session = page.jar.cookie
  // Replayed while the session lives: the ceremony is single use.
  const replay = await fx.call(OWNER_PASSKEY.signin, { method: 'POST', body: sent[0] })
  assert.equal(replay.response.status, 409); assert.equal(replay.body.code, 'AUMLOK_SIGNIN_CHALLENGE_USED')
  // Sign out (HEAD confirms), then replay again: still refused, no cookie, and the old session is gone.
  assert.equal((await fx.call(OWNER_PASSKEY.signout, { method: 'POST', body: {}, cookie: session })).response.status, 200)
  const after = await fx.call(OWNER_PASSKEY.signin, { method: 'POST', body: sent[0] })
  assert.notEqual(after.response.status, 200)
  assert.equal(after.response.headers.has('set-cookie'), false)
  assert.equal((await fx.call('/__x6/status', { cookie: session })).response.status, 401)
})

test('B3: when no challenge is held (the prefetch failed) the click asks first, says so, and the next press signs in', async t => {
  const fx = await boundEdge(t)
  const page = await signinPage(t, fx, { failFirstChallenge: true })
  await settle(() => page.requests.length === 1)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(page.timers.size, 0, 'nothing held, nothing to refresh')
  page.click()
  assert.equal(page.gets.length, 0, 'no challenge was held, so the page must ask first')
  assert.match(page.status.textContent, /Asking this node/)
  // Safari drops a passkey prompt started after a network wait, so the page never does that: it says the challenge is
  // ready and asks for one more press, which prompts inside the click.
  await settle(() => /again/.test(page.status.textContent))
  assert.match(page.status.textContent, /^Ready\. Press “Sign in with passkey” again/)
  assert.equal(page.gets.length, 0, 'no prompt after a network wait')
  assert.equal(page.button.disabled, false, 'the button is live again')
  assert.equal(page.timers.size, 1, 'the challenge now held is refreshed before it runs low')
  const asked = page.requests.length
  page.click()
  assert.equal(page.gets.length, 1, 'credentials.get was called inside the second press')
  assert.equal(page.requests.length, asked)
  await settle(() => page.replacements.length === 1)
  assert.deepEqual(page.replacements, ['/'])
})

test('B10: a page reached without the Strict cookie reopens once when the same-site challenge request carries a live session', async t => {
  const fx = await boundEdge(t)
  const session = (await fx.signIn()).response.headers.get('set-cookie').split(';')[0]
  // The cross-site arrival: the document came without the cookie, but the page's own (same-site) request carries it.
  const arrived = await signinPage(t, fx, { cookie: session })
  await settle(() => arrived.replacements.length === 1)
  assert.deepEqual(arrived.replacements, ['/'])
  assert.equal(arrived.win.name, REOPEN)
  // The reopened page (same tab, name kept): never a second reopen, even if the session is dead server-side.
  const reopened = await signinPage(t, fx, { cookie: session, name: REOPEN })
  await settle(() => reopened.timers.size === 1)
  assert.deepEqual(reopened.replacements, [])
  assert.equal(reopened.win.name, '')
  // No cookie, or one this node never signed: no reopen, and the hint costs no durable call beyond the challenge's read.
  const fake = `__Host-x61-owner=${'A'.repeat(43)}.${String(Date.now() + 3600000)}.1.${'0'.repeat(64)}`
  for (const cookie of [null, fake]) {
    const page = await signinPage(t, fx, { cookie })
    await settle(() => page.timers.size === 1)
    assert.deepEqual(page.replacements, [])
  }
  const mark = fx.doCalls.length
  const hinted = await fx.call(OWNER_PASSKEY.challenge, { method: 'POST', body: {}, cookie: session })
  assert.equal(hinted.response.headers.get('x-x61-session'), 'present')
  assert.deepEqual(fx.doCalls.slice(mark), ['HEAD /_host/aumlok/signin-key'])
  assert.equal((await fx.call(OWNER_PASSKEY.challenge, { method: 'POST', body: {}, cookie: fake })).response.headers.get('x-x61-session'), 'absent')
  assert.equal((await fx.call(OWNER_PASSKEY.challenge, { method: 'POST', body: {} })).response.headers.get('x-x61-session'), 'absent')
})

test('B10: the reopen does not depend on passkey support: without WebAuthn a live session reached from another site still reopens, once', async t => {
  const fx = await boundEdge(t)
  const session = (await fx.signIn()).response.headers.get('set-cookie').split(';')[0]
  const elsewhere = 'https://elsewhere.example.invalid/thread'
  const arrived = await signinPage(t, fx, { cookie: session, webauthn: false, referrer: elsewhere })
  assert.match(arrived.status.textContent, /cannot use a passkey/)
  assert.equal(arrived.button.disabled, true)
  await settle(() => arrived.replacements.length === 1)
  assert.deepEqual(arrived.replacements, ['/'])
  assert.equal(arrived.win.name, REOPEN)
  assert.deepEqual(arrived.requests, [OWNER_PASSKEY.challenge], 'one same-site request')
  // The reopened page never reopens again (and asks nothing for it).
  const reopened = await signinPage(t, fx, { cookie: session, webauthn: false, name: REOPEN, referrer: elsewhere })
  for (let index = 0; index < 20; index++) await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(reopened.replacements, [])
  assert.deepEqual(reopened.requests, [])
  assert.equal(reopened.win.name, '')
  // No session: the one request is made and nothing is reopened.
  const none = await signinPage(t, fx, { webauthn: false, referrer: elsewhere })
  await settle(() => none.requests.length === 1)
  // The Worker's answer (HEAD and WebCrypto behind it) has reached the page before the check, however slow the machine.
  await settle(() => none.settled.length === 1)
  for (let index = 0; index < 20; index++) await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(none.replacements, [])
  // A direct or same-site arrival already carried the Strict cookie, so it has nothing to reopen: no request at all.
  for (const referrer of [undefined, ORIGIN + '/elsewhere']) {
    const direct = await signinPage(t, fx, { cookie: session, webauthn: false, referrer })
    for (let index = 0; index < 20; index++) await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(direct.requests, [], String(referrer))
    assert.deepEqual(direct.replacements, [])
  }
})

test('job 2 #1: the provider door GET (it spends) is same-origin only; a cross-site GET is refused before HEAD or the provider', async t => {
  const fx = await boundEdge(t, { expectNetwork: true })
  const signed = await fx.signIn()
  // The session cookie stays SameSite=Strict (the B10 decision is unchanged by this fix).
  assert.match(signed.response.headers.get('set-cookie'), /; SameSite=Strict;/)
  const cookie = signed.response.headers.get('set-cookie').split(';')[0]
  Object.assign(fx.env, { OPENAI_API_KEY: 'synthetic-not-a-key', PROVIDER_BUDGET_WINDOW_MS: '60000', PROVIDER_BUDGET_REQUESTS: '1000',
    PROVIDER_BUDGET_TOKENS: '50000000', PROVIDER_MAX_OUTPUT_TOKENS: '256000' })
  const spent = async () => (await fx.headStorage.get('provider-budget:v1:openai')) ?? null
  const before = await spent()
  // A valid session, but not the node's own page: a top-level cross-site GET (what Lax would let the cookie follow), a
  // same-site sibling, no fetch metadata at all, and a foreign Origin. Each is refused, and nothing durable moves.
  for (const headers of [{ origin: null, 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate' }, { origin: null, 'sec-fetch-site': 'same-site' },
    { origin: null, 'sec-fetch-site': null }, { origin: 'https://elsewhere.example.invalid', 'sec-fetch-site': 'cross-site' }]) {
    const mark = fx.doCalls.length, network = fx.network()
    const refused = await fx.call('/door/openai/v1/models', { cookie, headers })
    assert.equal(refused.response.status, 403, JSON.stringify(headers))
    assert.ok(['SAME_ORIGIN_BROWSER_REQUIRED', 'ORIGIN_REFUSED'].includes(refused.body.code), refused.body.code)
    assert.ok(!fx.doCalls.slice(mark).some(call => call.startsWith('HEAD /_head/provider') || call === 'HEAD /_head/turn-journal'), JSON.stringify(fx.doCalls.slice(mark)))
    assert.equal(fx.network(), network, 'the paid provider was not called')
  }
  assert.deepEqual(await spent(), before, 'no budget was reserved')
  // The node's own page (same-origin fetch; a same-origin GET may omit Origin): exactly as before, the budget is reserved
  // in HEAD and the provider is asked (the fixture refuses the network).
  for (const headers of [{ origin: null }, {}]) {
    const mark = fx.doCalls.length, network = fx.network()
    await fx.call('/door/openai/v1/models', { cookie, headers })
    assert.ok(fx.doCalls.slice(mark).includes('HEAD /_head/provider-budget'), JSON.stringify(fx.doCalls.slice(mark)))
    assert.ok(fx.network() > network, 'and it tries the paid provider')
  }
  assert.notDeepEqual(await spent(), before)
})

test('B2: the challenge carries the hints, and stored transports go through only when the store recorded valid ones', async t => {
  const plain = await boundEdge(t)
  const issued = (await plain.call(OWNER_PASSKEY.challenge, { method: 'POST', body: {} })).body
  assert.deepEqual(issued.publicKey.hints, ['client-device', 'hybrid'])
  assert.deepEqual(issued.publicKey.allowCredentials, [{ type: 'public-key', id: plain.passkey.id }])
  const recorded = await boundEdge(t, { rewriteSigninKey: body => ({ ...body, transports: ['hybrid', 'internal'] }) })
  const withTransports = (await recorded.call(OWNER_PASSKEY.challenge, { method: 'POST', body: {} })).body
  assert.deepEqual(withTransports.publicKey.allowCredentials, [{ type: 'public-key', id: recorded.passkey.id, transports: ['hybrid', 'internal'] }])
  const bent = await boundEdge(t, { rewriteSigninKey: body => ({ ...body, transports: ['internal', 'carrier-pigeon'] }) })
  const dropped = (await bent.call(OWNER_PASSKEY.challenge, { method: 'POST', body: {} })).body
  assert.deepEqual(dropped.publicKey.allowCredentials, [{ type: 'public-key', id: bent.passkey.id }])
  // And the page passes them to the browser.
  const page = await signinPage(t, recorded)
  await settle(() => page.timers.size === 1)
  page.click()
  assert.deepEqual(page.gets[0].publicKey.allowCredentials[0].transports, ['hybrid', 'internal'])
})

/** A ready edge of counting fakes: what the Worker asks of durable objects, and nothing real behind it. */
function countingEdge({ gate = () => ({ ok: true, admitted: true }), ownerGate = () => ({ ok: true }), access = null, assets = null } = {}) {
  const calls = []
  const namespace = { idFromName: name => name, get: () => ({ fetch: async request => {
    const path = new URL(request.url).pathname
    calls.push(path)
    let body = { ok: false, code: 'AUMLOK_INVITE_NOT_FOUND' }
    if (path === '/_head/bootstrap-status') body = { ok: true, phase: 'complete', seedId: 'a'.repeat(64), ballId: 'b'.repeat(64), epoch: 1 }
    if (path === '/_mirror/bootstrap-status') body = { ok: true, phase: 'ready', seedId: 'a'.repeat(64), ballId: 'b'.repeat(64), epoch: 1 }
    if (path === '/_mirror/guest-gate') body = { ok: true, gate: gate(JSON.parse(await request.text()).subject) }
    if (path === '/_head/gate-lockout') body = { ok: true, gate: await ownerGate(JSON.parse(await request.text())) }
    if (path === '/_head/telemetry') body = { ok: true }
    return Response.json(body, { status: body.ok ? 200 : 404 })
  } }) }
  const env = { PUBLIC_HOST: new URL(ORIGIN).host, OWNER_EMAIL: OWNER, OWNER_PUBLIC_KEY_HEX: 'e'.repeat(64), HEAD: namespace, MIRROR: namespace,
    SOURCE_REVISION: 'c'.repeat(40), ...(assets ? { ASSETS: assets } : {}) }
  const clock = { at: 1794000000000 }
  const worker = createWorker({ now: () => clock.at, verifyAccess: async () => access, networkFetch: async () => { throw new Error('No network') } })
  const request = (path, { method = 'GET', body, address = '198.51.100.5', headers = {} } = {}) => worker.fetch(new Request(new URL(path, ORIGIN), { method,
    headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'cf-connecting-ip': address, ...(method === 'POST' ? { 'content-type': 'application/json' } : {}), ...headers },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) }), env)
  return { env, calls, clock, request }
}
/**
 * Review of job 10: a JWT refused on its face (malformed, out of window, ...) is answered before any durable call, so the
 * owner-login lock tests drive the door with a WELL-FORMED, in-window owner JWT for `edge` whose signature is checked and
 * wrong (an all-zero signature against the edge's key): it reaches HEAD's check and, if admitted, its failure.
 */
const wronglySignedOwnerJwt = edge => {
  const seconds = Math.floor(edge.clock.at / 1000)
  return encode({ alg: 'EdDSA', typ: 'JWT' }) + '.' + encode({ iss: 'aukora.x61.owner', aud: edge.env.PUBLIC_HOST, email: OWNER, nbf: seconds - 1, exp: seconds + 3600 }) +
    '.' + Buffer.alloc(64).toString('base64url')
}

test('F9: guest door bytes from a caller with no session cookie are judged before any durable call; a burst from one address is answered in the isolate', async () => {
  const edge = countingEdge()
  const valid = { invite: { schema: 'aukora.invite.v1' }, code: Buffer.alloc(32, 9).toString('base64url') }
  // Malformed bodies: refused with no durable call at all (no seed read, no guest-table write).
  for (const body of [{ invite: valid.invite }, { ...valid, extra: 1 }, [], 'not json', { invite: null, code: valid.code }, { invite: valid.invite, code: 7 }]) {
    const response = await edge.request(GUEST_DOOR.route, { method: 'POST', body, address: `198.51.100.${String(edge.calls.length + 100)}` })
    assert.equal(response.status, 400)
  }
  assert.deepEqual(edge.calls, [])
  // Well-formed: the seed status is read once and held briefly; each attempt reserves in the guest table, then HEAD.
  const limit = ISOLATE_SHIELD.guest.limit
  const answers = []
  for (let index = 0; index < limit + 3; index++) answers.push(await edge.request(GUEST_DOOR.route, { method: 'POST', body: valid }))
  assert.deepEqual(answers.map(response => response.status), [...Array(limit).fill(404), 429, 429, 429])
  const refused = await answers.at(-1).json()
  assert.equal(refused.code, 'GUEST_DOOR_BUSY')
  assert.ok(Number(answers.at(-1).headers.get('retry-after')) > 0)
  assert.equal(edge.calls.filter(path => path === '/_mirror/guest-gate').length, limit, 'the refused burst never reached the guest table')
  assert.equal(edge.calls.filter(path => path === '/_head/bootstrap-status').length, 1, 'one seed read for the whole burst')
  // Another address is not affected; after the window the first address is admitted again; the seed is read again later.
  assert.equal((await edge.request(GUEST_DOOR.route, { method: 'POST', body: valid, address: '198.51.100.6' })).status, 404)
  edge.clock.at += ISOLATE_SHIELD.guest.windowMs
  assert.equal((await edge.request(GUEST_DOOR.route, { method: 'POST', body: valid })).status, 404)
  assert.equal(edge.calls.filter(path => path === '/_head/bootstrap-status').length, 2)
})

test('F9: a durable guest lock is remembered in the isolate until it ends (capped), never longer', async () => {
  const locked = new Set()
  const edge = countingEdge({ gate: subject => locked.has(subject) ? { ok: false, code: 'GATE_LOCKOUT_ACTIVE', status: 429, retryAfterMs: 3600000 } : (locked.add(subject), { ok: true, admitted: true }) })
  const valid = { invite: { schema: 'aukora.invite.v1' }, code: Buffer.alloc(32, 9).toString('base64url') }
  assert.equal((await edge.request(GUEST_DOOR.route, { method: 'POST', body: valid })).status, 404)
  const first = await edge.request(GUEST_DOOR.route, { method: 'POST', body: valid })
  assert.equal(first.status, 429); assert.equal((await first.json()).code, 'GUEST_DOOR_LOCKED')
  const asked = edge.calls.length
  const second = await edge.request(GUEST_DOOR.route, { method: 'POST', body: valid })
  assert.equal(second.status, 429); assert.equal((await second.json()).code, 'GUEST_DOOR_LOCKED')
  assert.equal(edge.calls.length, asked, 'answered in the isolate')
  edge.clock.at += ISOLATE_SHIELD.guest.holdMs
  assert.equal((await edge.request(GUEST_DOOR.route, { method: 'POST', body: valid })).status, 429)
  assert.ok(edge.calls.length > asked, 'after the hold the durable table is asked again')
})

test('F9: the isolate table is bounded and a full table still admits a new address (it can only forget)', () => {
  const shield = createIsolateShield({ limit: 1, windowMs: 10000, holdMs: 60000, capacity: 4 })
  for (let index = 0; index < 4; index++) assert.equal(shield.take(`subject-${String(index)}`, 1000).ok, true)
  assert.equal(shield.take('subject-0', 1000).ok, false)
  assert.equal(shield.take('subject-new', 1000).ok, true, 'a new address is never refused for want of room')
  assert.equal(shield.size(), 4)
  shield.locked('subject-new', 1000, 5000)
  assert.equal(shield.take('subject-new', 5999).code, 'GATE_LOCKOUT_ACTIVE')
  assert.equal(shield.take('subject-new', 11000).ok, true, 'the lock and the window both ended')
})

test('F9: a stranger on the owner\'s own address floods both doors; the owner signs in at once and no owner counter moves', async t => {
  const fx = await boundEdge(t)
  const before = await fx.ownerCounters()
  const shared = '198.51.100.70'
  const body = { invite: { schema: 'aukora.invite.v1' }, code: Buffer.alloc(32, 3).toString('base64url') }
  const guests = await Promise.all(Array.from({ length: 40 }, () => fx.call(GUEST_DOOR.route, { method: 'POST', body, address: shared })))
  assert.ok(guests.every(result => [400, 403, 404, 429].includes(result.response.status)), JSON.stringify(guests.map(result => result.response.status)))
  assert.ok(guests.filter(result => result.response.status === 429).length >= 40 - ISOLATE_SHIELD.guest.limit)
  const proofs = await Promise.all(Array.from({ length: 30 }, () => fx.call(OWNER_PASSKEY.signin, { method: 'POST', address: shared, body: { challengeId: 'x.y', credential: { id: 'x' } } })))
  assert.ok(proofs.every(result => result.response.status === 403))
  const owner = await fx.signIn({ address: shared })
  assert.equal(owner.response.status, 200, JSON.stringify(owner.body))
  assert.deepEqual(await fx.ownerCounters(), before)
})

test('F9: an owner-token lock HEAD reported is answered in the isolate; other addresses and the HEAD verdict are unchanged', async () => {
  const keys = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])
  let at = Date.now()
  const env = { PUBLIC_HOST: new URL(ORIGIN).host, OWNER_EMAIL: OWNER, OWNER_PUBLIC_KEY_HEX: Buffer.from(await crypto.subtle.exportKey('raw', keys.publicKey)).toString('hex') }
  const head = new X61HeadDurableObject({ storage: memoryStorage(), getWebSockets: () => [] }, env)
  const gateCalls = []
  env.HEAD = { idFromName: name => name, get: () => ({ fetch: request => { gateCalls.push(new URL(request.url).pathname); return head.fetch(request) } }) }
  const input = encode({ alg: 'EdDSA', typ: 'JWT' }) + '.' + encode({ iss: 'aukora.x61.owner', aud: env.PUBLIC_HOST, email: OWNER, nbf: Math.floor(at / 1000) - 1, exp: Math.floor(at / 1000) + 600 })
  const token = input + '.' + Buffer.from(await crypto.subtle.sign('Ed25519', keys.privateKey, new TextEncoder().encode(input))).toString('base64url')
  const worker = createWorker({ now: () => at })
  const login = (body, address) => worker.fetch(new Request(ORIGIN + '/_auth/owner', { method: 'POST',
    headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/jwt', 'cf-connecting-ip': address }, body }), env)
  // Job 10: a login failure is a well-formed owner JWT whose signature is checked and wrong (here: signed by another key).
  const other = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])
  const wrong = input + '.' + Buffer.from(await crypto.subtle.sign('Ed25519', other.privateKey, new TextEncoder().encode(input))).toString('base64url')
  for (let index = 0; index < 4; index++) assert.equal((await login(wrong, '192.0.2.1')).status, 401)
  assert.equal((await login(wrong, '192.0.2.1')).status, 429)
  const asked = gateCalls.length
  const held = await login(token, '192.0.2.1')
  assert.equal(held.status, 429); assert.equal((await held.json()).code, 'GATE_LOCKOUT_ACTIVE')
  assert.ok(Number(held.headers.get('retry-after')) > 0); assert.equal(held.headers.get('set-cookie'), null)
  assert.equal(gateCalls.length, asked, 'no durable call while the lock is known here')
  assert.equal((await login(token, '192.0.2.2')).status, 200)
  // After the hold the isolate asks HEAD again, and HEAD still says locked: the isolate never decided anything itself.
  at += ISOLATE_SHIELD.ownerLogin.holdMs
  const again = gateCalls.length
  assert.equal((await login(token, '192.0.2.1')).status, 429)
  assert.ok(gateCalls.length > again)
})

test('F9: a lock learned from a slow durable reply is held only until the durable unlock, never longer (guest door and owner token)', async () => {
  // The durable gate reads the time when the request reaches it and says "locked for 40 s"; its reply takes 30 s to
  // arrive. The real unlock is 40 s after the request was SENT; the isolate may answer in its place until then, not later.
  const lock = { ok: false, code: 'GATE_LOCKOUT_ACTIVE', status: 429, retryAfterMs: 40000 }
  let guest = null, slowGuest = false
  guest = countingEdge({ gate: () => { if (!slowGuest) return { ok: true, admitted: true }; slowGuest = false; guest.clock.at += 30000; return lock } })
  const valid = { invite: { schema: 'aukora.invite.v1' }, code: Buffer.alloc(32, 9).toString('base64url') }
  const redeem = () => guest.request(GUEST_DOOR.route, { method: 'POST', body: valid })
  const reserves = () => guest.calls.filter(path => path === '/_mirror/guest-gate').length
  assert.equal((await redeem()).status, 404)
  slowGuest = true
  const guestSent = guest.clock.at
  const locked = await redeem()
  assert.equal(locked.status, 429); assert.equal((await locked.json()).code, 'GUEST_DOOR_LOCKED')
  const guestAsked = reserves()
  assert.equal((await redeem()).status, 429)
  guest.clock.at = guestSent + 39999
  assert.equal((await redeem()).status, 429)
  assert.equal(reserves(), guestAsked, 'answered in the isolate while the durable lock lasts')
  guest.clock.at = guestSent + 40000
  assert.equal((await redeem()).status, 404, 'at the durable unlock the isolate no longer refuses')
  assert.equal(reserves(), guestAsked + 1)

  // The owner-token door holds a lock in the isolate for at most 30 s, so here HEAD says 25 s and replies 10 s late.
  let owner = null, slowOwner = false
  owner = countingEdge({ ownerGate: ({ action }) => {
    if (!slowOwner || action !== 'check') return { ok: true }
    slowOwner = false; owner.clock.at += 10000; return { ...lock, retryAfterMs: 25000 }
  } })
  const wrong = wronglySignedOwnerJwt(owner)
  const login = () => owner.request('/_auth/owner', { method: 'POST', body: wrong, headers: { 'content-type': 'application/jwt' } })
  const gateCalls = () => owner.calls.filter(path => path === '/_head/gate-lockout').length
  assert.equal((await login()).status, 401)
  slowOwner = true
  const ownerSent = owner.clock.at
  const held = await login()
  assert.equal(held.status, 429); assert.equal((await held.json()).code, 'GATE_LOCKOUT_ACTIVE')
  const ownerAsked = gateCalls()
  owner.clock.at = ownerSent + 24999
  assert.equal((await login()).status, 429)
  assert.equal(gateCalls(), ownerAsked, 'answered in the isolate while the durable lock lasts')
  owner.clock.at = ownerSent + 25000
  assert.equal((await login()).status, 401, 'at the durable unlock HEAD is asked again')
  assert.ok(gateCalls() > ownerAsked)
})

test('F9: 100 concurrent owner-token requests from one address during a slow durable answer make ONE lock check, and the lock is held', async () => {
  // HEAD says "locked for 300 s" and the answer arrives 31 s late: the isolate holds it until min(sent + 300 s,
  // received + 30 s), never already expired, and the 100 requests waiting on it shared the one check.
  let owner = null, release = null
  const answered = new Promise(resolve => { release = resolve })
  owner = countingEdge({ ownerGate: async ({ action }) => {
    if (action !== 'check') return { ok: true }
    await answered
    owner.clock.at += 31000
    return { ok: false, code: 'GATE_LOCKOUT_ACTIVE', status: 429, retryAfterMs: 300000 }
  } })
  const wrong = wronglySignedOwnerJwt(owner)
  const login = () => owner.request('/_auth/owner', { method: 'POST', body: wrong, headers: { 'content-type': 'application/jwt' } })
  const gateCalls = () => owner.calls.filter(path => path === '/_head/gate-lockout').length
  const sent = owner.clock.at
  const burst = Array.from({ length: 100 }, () => login())
  await settle(() => gateCalls() >= 1)
  for (let index = 0; index < 50; index++) await new Promise(resolve => setImmediate(resolve))
  release()
  const answers = await Promise.all(burst)
  assert.deepEqual([...new Set(answers.map(response => response.status))], [429])
  assert.equal(gateCalls(), 1, 'one durable lock check for the whole burst')
  // Installed and live on arrival: answered here until received + 30 s, then HEAD is asked again.
  assert.equal((await login()).status, 429)
  owner.clock.at = sent + 31000 + ISOLATE_SHIELD.ownerLogin.holdMs - 1
  assert.equal((await login()).status, 429)
  assert.equal(gateCalls(), 1)
  owner.clock.at = sent + 31000 + ISOLATE_SHIELD.ownerLogin.holdMs
  await Promise.all([login(), (async () => { await settle(() => gateCalls() === 2); release() })()])
  assert.equal(gateCalls(), 2)
})

test('B9: content-hashed files are cached for a year, the seed image and cells revalidate, everything else stays no-store', async () => {
  // The paths come from the real build layout, not from the policy: the preview build writes the seed image into
  // dist/preview/, and the boot fetches it (and its lazy/ chunks) relative to the preview bootstrap.
  const repo = new URL('../../../../', import.meta.url)
  const layout = readFileSync(new URL('packages/experimental/webworker-runtime/src/image-layout.ts', repo), 'utf8')
  const imageName = layout.match(/export const IMAGE_FILE_NAME = '([^']+)'/)?.[1]
  const lazyDirectory = layout.match(/export const IMAGE_LAZY_DIRECTORY = '([^']+)'/)?.[1]
  assert.equal(imageName, 'vfs-image.tar.gz'); assert.equal(lazyDirectory, 'lazy')
  assert.match(readFileSync(new URL('server/build-preview.mjs', repo), 'utf8'), /path\.join\(dist, 'preview', 'vfs-image\.tar\.gz'\)/)
  const seedImage = `/preview/${imageName}`, lazyArchive = `/preview/${lazyDirectory}/${'f'.repeat(64)}.tar.gz`
  const assetCalls = []
  const assets = { fetch: async request => {
    const url = new URL(request.url)
    assetCalls.push(url.pathname)
    if (url.pathname.includes('missing')) return new Response('missing', { status: 404 })
    const etag = url.pathname === '/cells/no-etag.wasm' ? null : '"fixture-etag"'
    if (etag && request.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers: { etag } })
    return new Response('bytes', { headers: { ...(etag ? { etag } : {}), 'set-cookie': 'leak=1' } })
  } }
  const owner = { type: 'owner', email: OWNER, expires: 4102444800 }
  const signedIn = countingEdge({ access: owner, assets })
  const immutable = 'private, max-age=31536000, immutable'
  for (const [path, policy] of [
    ['/assets/index-C2MMIvhO.js', immutable], ['/assets/vendor-t74FFCZZ.css', immutable], ['/preview/bootstrap-Ab3dE_9z.js', immutable],
    ['/assets/langs/python-D1x-Qa0p.js', immutable], ['/assets/fonts/KaTeX_Main-Regular-B22Nviop.woff2', immutable],
    ['/assets/stock-apps/dakini-code/assets/index-C2MMIvhO.css', immutable], [lazyArchive, immutable], ['/preview/worker-BGGQHzF0.js', immutable],
    [seedImage, 'private, no-cache'], ['/cells/kira-core.wasm', 'private, no-cache'], ['/cells/no-etag.wasm', 'no-store'],
    // Nothing is served at the site root under these names; they get no caching rule.
    ['/vfs-image.tar.gz', 'no-store'], [`/lazy/${'f'.repeat(64)}.tar.gz`, 'no-store'], [`/preview/lazy/${'F'.repeat(64)}.tar.gz`, 'no-store'],
    ['/preview/asset-seal.json', 'no-store'], ['/preview/fixtures.json', 'no-store'],
    ['/', 'no-store'], ['/preview.html', 'no-store'], ['/manifest.webmanifest', 'no-store'], ['/assets/stock-apps/auma-live.html', 'no-store'],
    ['/assets/aukora-mark-96.png', 'no-store'], ['/assets/stock-apps/data/pentora-opening-v1.json', 'no-store'], ['/assets/plain-settings.js', 'no-store'],
    ['/assets/index-missing0.js', 'no-store'], ['/favicon.svg', 'no-store'],
  ]) {
    const response = await signedIn.request(path, { headers: { 'sec-fetch-site': 'same-origin' } })
    assert.equal(response.headers.get('cache-control'), policy, path)
    assert.equal(response.headers.get('set-cookie'), null, path)
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff', path)
  }
  // Revalidation: the ETag is kept and a matching If-None-Match gets 304 with the same policy.
  const image = await signedIn.request(seedImage)
  assert.equal(image.headers.get('etag'), '"fixture-etag"')
  const unchanged = await signedIn.request(seedImage, { headers: { 'if-none-match': '"fixture-etag"' } })
  assert.equal(unchanged.status, 304); assert.equal(unchanged.headers.get('cache-control'), 'private, no-cache')
  // Signed out: nothing is served and nothing may be kept.
  const before = assetCalls.length
  const signedOut = countingEdge({ access: null, assets })
  for (const path of ['/assets/index-C2MMIvhO.js', seedImage, '/cells/kira-core.wasm', lazyArchive]) {
    const response = await signedOut.request(path)
    assert.equal(response.status, 401, path)
    assert.equal(response.headers.get('cache-control'), 'no-store', path)
  }
  assert.equal(assetCalls.length, before)
  assert.equal(staticCachePolicy('/assets/index-C2MMIvhO.js', 500, new Headers()), 'no-store')
})

test('F2: GET /api/build answers signed out with only the stamped revision, at constant cost', async () => {
  const edge = countingEdge({ access: null })
  const response = await edge.request(BUILD_ROUTE, { headers: { origin: null, 'sec-fetch-site': 'cross-site' } })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.deepEqual(await response.json(), { ok: true, schema: 'aukora.edge-build.v1', sourceRevision: 'c'.repeat(40) })
  assert.equal((await edge.request(BUILD_ROUTE, { method: 'POST', body: {} })).status, 405)
  assert.equal((await edge.request(BUILD_ROUTE + '?x=1')).status, 404)
  edge.env.SOURCE_REVISION = 'not-a-revision'
  assert.deepEqual(await (await edge.request(BUILD_ROUTE)).json(), { ok: true, schema: 'aukora.edge-build.v1', sourceRevision: null })
  delete edge.env.OWNER_PUBLIC_KEY_HEX
  assert.equal((await edge.request(BUILD_ROUTE)).status, 200, 'even before owner access is configured')
  assert.deepEqual(edge.calls, [], 'no durable call')
})

test('F2: /api/health says, as booleans only, which doors are configured, plus the stamped build', async () => {
  const owner = { type: 'owner', email: OWNER, expires: 4102444800 }
  const edge = countingEdge({ access: owner })
  const secrets = { ANTHROPIC_API_KEY: 'synthetic-anthropic-value', DEEPGRAM_API_KEY: '  synthetic-deepgram-value ', GITHUB_TOKEN: 'synthetic-github-value',
    CLOUDFLARE_API_TOKEN: 'synthetic-cloudflare-value', CLOUDFLARE_ACCOUNT_ID: 'synthetic-account' }
  const empty = await (await edge.request('/api/health')).json()
  assert.deepEqual([empty.capabilities.speechProvider, empty.capabilities.githubBroker, empty.capabilities.cloudWake, empty.capabilities.cloudflareBroker], [false, false, false, false])
  assert.equal(empty.capabilities.providerDoors.anthropic, false)
  Object.assign(edge.env, secrets)
  const configured = await (await edge.request('/api/health')).json()
  assert.deepEqual([configured.capabilities.speechProvider, configured.capabilities.githubBroker, configured.capabilities.cloudWake, configured.capabilities.cloudflareBroker], [true, true, false, true])
  assert.equal(configured.capabilities.providerDoors.anthropic, true)
  assert.equal(configured.sourceRevision, 'c'.repeat(40)); assert.equal(configured.buildSha, 'c'.repeat(40))
  for (const value of Object.values(secrets)) assert.ok(!JSON.stringify(configured).includes(value.trim()), 'no secret value is ever shown')
  // HEAD's own rule: with no provider named only deepseek or openai count; a named provider needs its own key. And no wake
  // runs without the switch (job 4 C), so a provider alone, or the switch alone, is not a cloud wake.
  edge.env.CLOUD_WAKE_PROVIDER = 'anthropic'
  assert.equal((await (await edge.request('/api/health')).json()).capabilities.cloudWake, false)
  edge.env.CLOUD_WAKE_PROVIDER = 'deepseek'
  assert.equal((await (await edge.request('/api/health')).json()).capabilities.cloudWake, false)
  edge.env.WAKE_EXECUTOR_ENABLED = '1'
  assert.equal((await (await edge.request('/api/health')).json()).capabilities.cloudWake, false)
  edge.env.CLOUD_WAKE_PROVIDER = 'anthropic'
  assert.equal((await (await edge.request('/api/health')).json()).capabilities.cloudWake, true)
  // Signed out, health is not answered.
  assert.equal((await countingEdge({ access: null }).request('/api/health')).status, 401)
})

const cloudProviderOk = env => cloudWakeProvider(env).ok === true
test('job 4 C: /api/health cloudWake is true only when the wake switch is on AND a provider is configured by HEAD\'s rule', async () => {
  const edge = countingEdge({ access: { type: 'owner', email: OWNER, expires: 4102444800 } })
  const cloudWake = async () => (await (await edge.request('/api/health')).json()).capabilities.cloudWake
  // A provider and no switch: no wake runs, so none is claimed (the old answer was true here).
  Object.assign(edge.env, { ANTHROPIC_API_KEY: 'synthetic-anthropic-value', CLOUD_WAKE_PROVIDER: 'anthropic' })
  assert.equal(cloudProviderOk(edge.env), true)
  assert.equal(await cloudWake(), false)
  for (const off of ['0', '', 'true', ' 1', '1 ', 'yes']) {
    edge.env.WAKE_EXECUTOR_ENABLED = off
    assert.equal(await cloudWake(), false, JSON.stringify(off))
  }
  edge.env.WAKE_EXECUTOR_ENABLED = 1
  assert.equal(await cloudWake(), false, 'only the exact string "1" turns it on')
  // Switch on and a provider: true.
  edge.env.WAKE_EXECUTOR_ENABLED = '1'
  assert.equal(await cloudWake(), true)
  // Switch on, no usable provider by HEAD's rule (named provider without its key, unknown name, legacy order with no
  // deepseek or openai key): false (the old answer was true here).
  for (const provider of ['deepseek', 'anthropicc', '']) {
    edge.env.CLOUD_WAKE_PROVIDER = provider
    assert.equal(cloudProviderOk(edge.env), false, provider)
    assert.equal(await cloudWake(), false, provider)
  }
  // Legacy order with its own key, switch on: true; the same with the switch off: false.
  edge.env.DEEPSEEK_API_KEY = 'synthetic-deepseek-value'
  assert.equal(await cloudWake(), true)
  delete edge.env.WAKE_EXECUTOR_ENABLED
  assert.equal(await cloudWake(), false)
  assert.ok(!JSON.stringify(await (await edge.request('/api/health')).json()).includes('synthetic-'), 'no secret value is ever shown')
})

/** A guest-table subject for address number `index` (the shape the Worker makes: a SHA-256 of the door and the address). */
const guestSubject = index => 'guest-redeem:' + createHash('sha256').update(`guest-table-${index}`).digest('hex')

test('job 2 #2: a full guest table lets a new honest address in once the oldest row is idle, never sooner', async () => {
  const storage = memoryStorage(), t0 = 1_800_000_000_000, { maxSubjects, idleMs } = GUEST_GATE_LIMITS
  // Many addresses, each sending one well-formed request: the table fills (row i used at t0 + i).
  for (let index = 0; index < maxSubjects; index++) assert.deepEqual(await guestGateDecision(storage, 'reserve', guestSubject(index), t0 + index), { ok: true, admitted: true })
  const honest = guestSubject('honest')
  // While every row was used within the idle clock, a new address is refused, told when the first row frees up.
  const busy = await guestGateDecision(storage, 'reserve', honest, t0 + maxSubjects)
  assert.equal(busy.code, 'GUEST_DOOR_BUSY')
  assert.equal(busy.retryAfterMs, idleMs - maxSubjects)
  assert.equal((await storage.get(GUEST_GATE_KEY)).length, maxSubjects)
  // A read ('check') never evicts.
  assert.equal((await guestGateDecision(storage, 'check', honest, t0 + idleMs)).ok, true)
  assert.equal((await storage.get(GUEST_GATE_KEY)).some(([key]) => key === guestSubject(0)), true)
  // Once the oldest row is idle, the honest address is admitted: exactly that oldest row goes, the table stays full-sized.
  assert.deepEqual(await guestGateDecision(storage, 'reserve', honest, t0 + idleMs), { ok: true, admitted: true })
  const rows = await storage.get(GUEST_GATE_KEY)
  assert.equal(rows.length, maxSubjects)
  assert.equal(rows.some(([key]) => key === guestSubject(0)), false)
  assert.equal(rows.some(([key]) => key === guestSubject(1)), true)
  assert.equal(rows.some(([key]) => key === honest), true)
  // The admitted address is counted like any other (its own limit still applies).
  assert.equal((await guestGateDecision(storage, 'check', honest, t0 + idleMs + 1)).failures, 1)
})

test('job 2 #2: an address under a penalty stays penalised however many new addresses churn the full table', async () => {
  const storage = memoryStorage(), t0 = 1_800_000_000_000, { maxSubjects, maxFailures, idleMs, lockoutMs } = GUEST_GATE_LIMITS
  const abuser = guestSubject('abuser')
  for (let attempt = 0; attempt < maxFailures; attempt++) await guestGateDecision(storage, 'reserve', abuser, t0)
  const lockedAt = await guestGateDecision(storage, 'reserve', abuser, t0)
  assert.equal(lockedAt.code, 'GATE_LOCKOUT_ACTIVE')
  for (let index = 1; index < maxSubjects; index++) await guestGateDecision(storage, 'reserve', guestSubject(index), t0)
  // Rounds of new addresses, ten idle clocks apart, until just before the lock ends: each round evicts the previous one,
  // never the locked row.
  let round = 0, at = t0
  while (at + 10 * idleMs < t0 + lockoutMs) {
    at += 10 * idleMs
    round++
    for (let index = 1; index < maxSubjects; index++) {
      assert.deepEqual(await guestGateDecision(storage, 'reserve', guestSubject(`round-${round}-${index}`), at), { ok: true, admitted: true })
    }
    // With the rest of the table fresh and the abuser locked, the next new address is refused, not let in over the lock.
    const busy = await guestGateDecision(storage, 'reserve', guestSubject(`late-${round}`), at)
    assert.equal(busy.code, 'GUEST_DOOR_BUSY')
    const held = await guestGateDecision(storage, 'reserve', abuser, at)
    assert.equal(held.code, 'GATE_LOCKOUT_ACTIVE', `round ${round}`)
    assert.equal(held.retryAfterMs, t0 + lockoutMs - at)
  }
  assert.ok(round >= 5, String(round))
  const rows = await storage.get(GUEST_GATE_KEY)
  assert.equal(rows.length, maxSubjects)
  assert.equal(rows.find(([key]) => key === abuser)[1].lockedUntil, t0 + lockoutMs, 'the lock was never shortened')
})

test('job 2 #2: memory and storage stay bounded: one value, at most the table size, at most the failure limit per row', async () => {
  const storage = memoryStorage(), t0 = 1_800_000_000_000, { maxSubjects, maxFailures, idleMs } = GUEST_GATE_LIMITS
  let largest = 0
  for (let index = 0; index < 4 * maxSubjects; index++) {
    const at = t0 + Math.floor(index / 64) * idleMs
    await guestGateDecision(storage, 'reserve', guestSubject(index), at)
    for (let again = 0; again < index % 7; again++) await guestGateDecision(storage, 'reserve', guestSubject(index), at)
    const rows = await storage.get(GUEST_GATE_KEY)
    assert.ok(rows.length <= maxSubjects)
    assert.ok(rows.every(([, entry]) => entry.failedAt.length <= maxFailures))
    largest = Math.max(largest, JSON.stringify(rows).length)
  }
  // Only the one key, and it never outgrows a full table of full rows (about 200 bytes a row, about 50 KB in all), well
  // under one 128 KiB storage value.
  assert.deepEqual([...(await storage.list()).keys()], [GUEST_GATE_KEY])
  assert.ok(largest <= maxSubjects * 200, String(largest))
})

/** A signed invite this bound edge's node issued, stored as the AUMLOK store keeps it; and its link fragment. */
async function issuedInvite(fx) {
  const at = Date.now(), code = randomBytes(32).toString('base64url')
  const payload = { schema: 'aukora.invite.v1', inviteId: randomBytes(32).toString('base64url'), sponsorPubkeyHex: keyHex(fx.node),
    inviteeCommitmentSha256: createHash('sha256').update('aukora.invite.invitee.v1\0').update(Buffer.from(code, 'base64url')).digest('hex'),
    assignedDomainPointer: null, quotaMonth: new Date(at).toISOString().slice(0, 7), monthlySequence: 1, revoked: false, issuedAt: at - 1000, expiresAt: at + 3 * 86400000 }
  const invite = { ...payload, signature: sign(null, Buffer.from(aumlokInvitePreimage(payload)), fx.node.privateKey).toString('base64url') }
  const state = await fx.headStorage.get(AUMLOK_STORAGE_KEY)
  await fx.headStorage.put(AUMLOK_STORAGE_KEY, { ...state, invites: [...state.invites, invite] })
  return { invite, code, fragment: '#invite=' + Buffer.from(JSON.stringify(invite)).toString('base64url') }
}

/** The invite part of the sign-in page: type a code, press Check invite, wait for the node's answer to show. */
async function checkInvite(page, code) {
  const document = page.document, status = document.getElementById('invite-status'), before = page.requests.length
  document.getElementById('invite-code').value = code
  document.getElementById('invite-form').dispatchEvent(new page.dom.window.Event('submit', { bubbles: true, cancelable: true }))
  await settle(() => page.requests.length > before && document.getElementById('invite-submit').disabled === false)
  return status.textContent
}

test('job 2 #3: an invite link opens on the sign-in page, leaves the address bar at once, and shows the node\'s true answer', async t => {
  const fx = await boundEdge(t)
  const { invite, code, fragment } = await issuedInvite(fx)
  const page = await signinPage(t, fx, { hash: fragment })
  // The fragment left the address bar while the script ran, before any request.
  assert.deepEqual(page.addressBar, ['/'])
  assert.equal(page.win.location.hash, '')
  const section = page.document.getElementById('invite-check')
  assert.equal(section.hidden, false)
  assert.match(section.textContent, /An invite grants no access to this node today\./)
  // Nothing of the link is written into the page.
  assert.ok(!page.document.documentElement.outerHTML.includes(fragment.slice(8, 40)))
  assert.ok(!page.document.documentElement.outerHTML.includes(invite.inviteId))
  // The owner sign-in below is unchanged: the challenge is still fetched ahead and the passkey button still signs in.
  await settle(() => page.timers.size === 1)
  assert.deepEqual(page.requests, [OWNER_PASSKEY.challenge])
  // A code that is not this invite's: the node says so; nothing granted.
  const wrong = await checkInvite(page, randomBytes(32).toString('base64url'))
  assert.equal(wrong, 'This node says the code is not the one this invite was made for. Nothing was granted.')
  // A code of the wrong shape never leaves the page.
  const sent = page.requests.length
  page.document.getElementById('invite-code').value = 'short'
  page.document.getElementById('invite-form').dispatchEvent(new page.dom.window.Event('submit', { bubbles: true, cancelable: true }))
  assert.equal(page.requests.length, sent)
  assert.match(page.document.getElementById('invite-status').textContent, /Nothing was sent\.$/)
  // The right code: exactly { invite, code } goes to the guest door, and the true reply is shown, grants included.
  const right = await checkInvite(page, `  ${code}  `)
  assert.equal(page.requests.at(-1), GUEST_DOOR.route)
  assert.deepEqual(JSON.parse(page.bodies.at(-1)), { invite, code })
  assert.equal(right, 'This node checked the invite and its code: they match, and the invite is valid (2 days left). An invite grants no access today: '
    + 'nothing was signed in, no guest view was opened, and the invite was not used up.')
  assert.equal(page.document.getElementById('invite-code').value, '', 'the code does not stay in the field')
  assert.equal(page.jar.cookie, null, 'no session of any kind')
  // The owner's passkey sign-in on the same page still works after the invite checks.
  page.click()
  await settle(() => page.replacements.length === 1)
  assert.deepEqual(page.replacements, ['/'])
  assert.match(page.jar.cookie, /^__Host-x61-owner=/)
})

test('job 2 #3: an unknown invite, a locked address and an unreadable link are said plainly; no invite, no change to the page', async t => {
  const fx = await boundEdge(t)
  const { invite, code, fragment } = await issuedInvite(fx)
  // Unknown to this node (a different id, same shape): the node's own answer.
  const stranger = { ...invite, inviteId: randomBytes(32).toString('base64url') }
  const unknown = await signinPage(t, fx, { hash: '#invite=' + Buffer.from(JSON.stringify(stranger)).toString('base64url') })
  assert.equal(await checkInvite(unknown, code), 'This node holds no invite like this one. Nothing was granted.')
  // Unreadable link: shown as such, the fragment still leaves the address bar, and nothing is sent.
  for (const bad of ['#invite=', '#invite=%%%', '#invite=' + Buffer.from('not json').toString('base64url'), '#invite=' + Buffer.from('[1]').toString('base64url')]) {
    const page = await signinPage(t, fx, { hash: bad })
    assert.deepEqual(page.addressBar, ['/'])
    assert.equal(page.document.getElementById('invite-check').hidden, false)
    assert.equal(page.document.getElementById('invite-status').textContent, 'This link does not carry an invite this page can read. Nothing was sent.')
    assert.equal(page.document.getElementById('invite-submit').disabled, true)
    await settle(() => page.timers.size === 1)
    assert.deepEqual(page.requests, [OWNER_PASSKEY.challenge])
  }
  // No invite in the address: the invite part stays hidden and the address bar is left alone.
  for (const hash of ['', '#other=1']) {
    const page = await signinPage(t, fx, { hash })
    assert.deepEqual(page.addressBar, [])
    assert.equal(page.document.getElementById('invite-check').hidden, true)
    assert.equal(page.document.getElementById('invite-submit').disabled, true)
  }
  // A busy guest table answers in plain words too (the reply the node gives when it is turning invite checks away).
  const page = await signinPage(t, fx, { hash: fragment })
  for (let index = 0; index < GUEST_GATE_LIMITS.maxFailures; index++) await checkInvite(page, randomBytes(32).toString('base64url'))
  assert.equal(await checkInvite(page, code), 'Too many checks came from this network, so this node is not checking invites from it for now. '
    + 'The node asks for a wait of about 60 minutes before trying again. Nothing was checked.')
})

test('job 3 #2: the guest door\'s refusals say only what is true, and state the wait the node gave or promise none', async t => {
  const fx = await boundEdge(t)
  const { code, fragment } = await issuedInvite(fx)
  let reply = null
  const page = await signinPage(t, fx, { hash: fragment, respond: path => path === GUEST_DOOR.route && reply ? reply() : undefined })
  const refusal = (refused, retryAfter, status = 429) => () => new Response(JSON.stringify({ ok: false, code: refused }),
    { status, headers: { 'content-type': 'application/json', ...(retryAfter === null ? {} : { 'retry-after': retryAfter }) } })
  const LOCKED = 'Too many checks came from this network, so this node is not checking invites from it for now.'
  const BUSY = 'This node is turning away invite checks for now.'
  for (const [retryAfter, wait] of [['1', 'less than a minute'], ['59', 'less than a minute'], ['60', 'about a minute'], ['61', 'about 2 minutes'],
    ['3600', 'about 60 minutes'], ['5340', 'about 89 minutes'], ['5341', 'about 2 hours'], ['86400', 'about 24 hours']]) {
    for (const [refused, words] of [['GUEST_DOOR_LOCKED', LOCKED], ['GUEST_DOOR_BUSY', BUSY]]) {
      reply = refusal(refused, retryAfter)
      assert.equal(await checkInvite(page, code), `${words} The node asks for a wait of ${wait} before trying again. Nothing was checked.`, retryAfter)
    }
  }
  // No wait, or one that is not a plain bounded number of seconds: nothing is promised.
  for (const retryAfter of [null, '', '0', '86401', '9999999', '1.5', '-5', 'Wed, 21 Oct 2026 07:28:00 GMT', '60, 60']) {
    for (const [refused, words] of [['GUEST_DOOR_LOCKED', LOCKED], ['GUEST_DOOR_BUSY', BUSY]]) {
      reply = refusal(refused, retryAfter)
      const said = await checkInvite(page, code)
      assert.equal(said, `${words} Nothing was checked.`, String(retryAfter))
      assert.doesNotMatch(said, /failed|minute|hour|again/)
    }
  }
  // A wait is read only from the door's own 429.
  reply = refusal('GUEST_DOOR_BUSY', '30', 503)
  assert.equal(await checkInvite(page, code), `${BUSY} Nothing was checked.`)
})

test('job 3 #2: the door\'s Retry-After is the real wait: a lock answered in the isolate reports the durable unlock, not its own shorter hold', async () => {
  const locked = new Set()
  const edge = countingEdge({ gate: subject => locked.has(subject) ? { ok: false, code: 'GATE_LOCKOUT_ACTIVE', status: 429, retryAfterMs: 3600000 } : (locked.add(subject), { ok: true, admitted: true }) })
  const valid = { invite: { schema: 'aukora.invite.v1' }, code: Buffer.alloc(32, 9).toString('base64url') }
  const redeem = () => edge.request(GUEST_DOOR.route, { method: 'POST', body: valid })
  assert.equal((await redeem()).status, 404)
  const durable = await redeem()
  assert.equal(durable.headers.get('retry-after'), '3600')
  const asked = edge.calls.length
  edge.clock.at += 30000
  const isolate = await redeem()
  assert.equal(edge.calls.length, asked, 'answered in the isolate')
  assert.equal((await isolate.json()).code, 'GUEST_DOOR_LOCKED')
  assert.equal(isolate.headers.get('retry-after'), '3570')
  // The isolate still holds the lock no longer than its cap; the durable gate is asked again after it.
  edge.clock.at += ISOLATE_SHIELD.guest.holdMs
  await redeem()
  assert.ok(edge.calls.length > asked)
  // A burst refused in the isolate is told the true, short wait (the rest of its window).
  const open = countingEdge(), burst = []
  for (let index = 0; index <= ISOLATE_SHIELD.guest.limit; index++) burst.push(await open.request(GUEST_DOOR.route, { method: 'POST', body: valid, address: '198.51.100.77' }))
  assert.equal((await burst.at(-1).json()).code, 'GUEST_DOOR_BUSY')
  assert.ok(Number(burst.at(-1).headers.get('retry-after')) <= ISOLATE_SHIELD.guest.windowMs / 1000)
})

test('job 3 #3: a guest-door row stands for a network: an IPv4 address, or an IPv6 /64', () => {
  assert.equal(guestNetwork('203.0.113.7'), '203.0.113.7')
  assert.notEqual(guestNetwork('203.0.113.8'), guestNetwork('203.0.113.7'))
  for (const address of ['2001:db8:1:2:3:4:5:6', '2001:DB8:1:2::9', '2001:0db8:0001:0002:ffff:ffff:ffff:ffff', '2001:db8:1:2::', '2001:db8:1:2:a:b:1.2.3.4', '2001:db8:1:2::1%en0', ' 2001:db8:1:2::77 ']) {
    assert.equal(guestNetwork(address), '2001:db8:1:2::/64', address)
  }
  assert.equal(guestNetwork('2001:db8:1:3::1'), '2001:db8:1:3::/64')
  assert.equal(guestNetwork('::1'), '0:0:0:0::/64')
  assert.equal(guestNetwork('::'), '0:0:0:0::/64')
  // An IPv4 address written as IPv6 is that IPv4 address, not one shared ::ffff /64 for every IPv4 caller.
  assert.equal(guestNetwork('::ffff:203.0.113.7'), '203.0.113.7')
  assert.equal(guestNetwork('::FFFF:cb00:7107'), '203.0.113.7')
  // Anything that does not parse stands for itself, as before.
  for (const odd of ['2001:db8::1::2', '2001:db8:1:2:3:4:5:6:7', '12345::1', ':1:2:3:4:5:6:7', '1.2.3.256', '::ffff:1.2.3.999', 'garbage']) assert.equal(guestNetwork(odd), odd, odd)
  assert.equal(guestNetwork(null), 'unknown')
  assert.equal(guestNetwork(''), 'unknown')
})

test('job 3 #3: 256 addresses x 5 checks from one IPv6 /64 take one row, keep their penalty, and leave room for honest callers', async t => {
  const fx = await boundEdge(t)
  const body = { invite: { schema: 'aukora.invite.v1' }, code: Buffer.alloc(32, 5).toString('base64url') }
  const statuses = new Map()
  for (let index = 0; index < GUEST_GATE_LIMITS.maxSubjects; index++) {
    const address = `2001:db8:77:5:${(index * 7919 % 65536).toString(16)}:${index.toString(16)}:0:1`
    for (let attempt = 0; attempt < GUEST_GATE_LIMITS.maxFailures; attempt++) {
      // Step past the isolate window and its hold so every attempt that the isolate would not answer reaches the table.
      fx.clock.offset += ISOLATE_SHIELD.guest.holdMs
      const result = await fx.call(GUEST_DOOR.route, { method: 'POST', body, address })
      statuses.set(result.response.status, (statuses.get(result.response.status) ?? 0) + 1)
    }
  }
  // Five checks were admitted for the whole /64, then it was locked.
  assert.equal(statuses.get(429), GUEST_GATE_LIMITS.maxSubjects * GUEST_GATE_LIMITS.maxFailures - GUEST_GATE_LIMITS.maxFailures, JSON.stringify([...statuses]))
  const rows = await fx.mirrorStorage.get(GUEST_GATE_KEY)
  assert.equal(rows.length, 1)
  assert.ok(rows[0][1].lockedUntil > Date.now())
  const lockedUntil = rows[0][1].lockedUntil
  const locked = await fx.call(GUEST_DOOR.route, { method: 'POST', body, address: '2001:db8:77:5::abcd' })
  assert.equal(locked.body.code, 'GUEST_DOOR_LOCKED')
  // Honest callers on another network (IPv4, another /64) are checked at once.
  for (const address of ['192.0.2.55', '2001:db8:77:6::1']) {
    const honest = await fx.call(GUEST_DOOR.route, { method: 'POST', body, address })
    assert.notEqual(honest.response.status, 429, address)
  }
  const after = await fx.mirrorStorage.get(GUEST_GATE_KEY)
  assert.equal(after.length, 3)
  assert.equal(after.find(([, entry]) => entry.lockedUntil > 0)[1].lockedUntil, lockedUntil, 'the penalty was kept whole')
})

test('job 3 #3: penalties are capped, so many networks each earning one can never fill the table; honest networks get in on the idle clock', async () => {
  const storage = memoryStorage(), t0 = 1_800_000_000_000, { maxSubjects, maxFailures, idleMs, lockoutMs, maxLocked } = GUEST_GATE_LIMITS
  assert.ok(maxLocked < maxSubjects)
  const outcomes = []
  for (let index = 0; index < maxSubjects + 44; index++) {
    for (let attempt = 0; attempt < maxFailures; attempt++) outcomes.push([index, attempt, await guestGateDecision(storage, 'reserve', guestSubject(`net-${index}`), t0)])
  }
  let rows = await storage.get(GUEST_GATE_KEY)
  const lockedRows = () => rows.filter(([, entry]) => entry.lockedUntil > t0)
  assert.equal(rows.length, maxSubjects)
  assert.equal(lockedRows().length, maxLocked)
  // Past the cap, the attempt that would earn a penalty is refused and counts nothing; it is told when the first penalty ends.
  const capped = outcomes.find(([index, attempt]) => index === maxLocked && attempt === maxFailures - 1)[2]
  assert.deepEqual(capped, { ok: false, code: 'GUEST_DOOR_BUSY', status: 429, retryAfterMs: lockoutMs })
  assert.equal(rows.find(([key]) => key === guestSubject(`net-${maxLocked}`))[1].failedAt.length, maxFailures - 1)
  assert.equal((await guestGateDecision(storage, 'reserve', guestSubject(`net-${maxLocked}`), t0 + idleMs)).code, 'GUEST_DOOR_BUSY')
  // An honest new network gets in once the oldest unlocked row is idle, though every penalty row is taken.
  const honest = guestSubject('honest-network')
  assert.equal((await guestGateDecision(storage, 'reserve', honest, t0 + idleMs - 1)).code, 'GUEST_DOOR_BUSY')
  assert.deepEqual(await guestGateDecision(storage, 'reserve', honest, t0 + idleMs), { ok: true, admitted: true })
  // Rounds of new networks churning the table for most of an hour: the penalty rows never grow past the cap, every
  // penalised network stays penalised for its whole hour, and an honest network gets in every round.
  for (let round = 1, at = t0 + 2 * idleMs; at < t0 + lockoutMs - idleMs; round++, at += 5 * idleMs) {
    for (let index = 0; index < 80; index++) {
      for (let attempt = 0; attempt < maxFailures; attempt++) await guestGateDecision(storage, 'reserve', guestSubject(`round-${round}-${index}`), at)
    }
    rows = await storage.get(GUEST_GATE_KEY)
    assert.ok(rows.filter(([, entry]) => entry.lockedUntil > at).length <= maxLocked)
    assert.deepEqual(await guestGateDecision(storage, 'reserve', guestSubject(`honest-${round}`), at + idleMs), { ok: true, admitted: true }, `round ${round}`)
  }
  for (let index = 0; index < maxLocked; index++) {
    const held = await guestGateDecision(storage, 'check', guestSubject(`net-${index}`), t0 + lockoutMs - 1)
    assert.equal(held.code, 'GATE_LOCKOUT_ACTIVE', String(index))
  }
  rows = await storage.get(GUEST_GATE_KEY)
  assert.ok(rows.length <= maxSubjects)
  assert.ok(rows.every(([, entry]) => entry.failedAt.length <= maxFailures))
})

// ── Job 4 B: the first page an outsider sees ─────────────────────────────────────────────────────────────────────────
/** Every string literal in the page's script that a person could read (it has a space): status and error lines. */
function scriptWords(source) {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, source)
  const words = []
  for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
    if ([ts.SyntaxKind.StringLiteral, ts.SyntaxKind.NoSubstitutionTemplateLiteral].includes(kind) && scanner.getTokenValue().includes(' ')) words.push(scanner.getTokenValue())
  }
  return words
}
/** What a person reads on the page as served: its text outside script and style, its title, and the readable attributes. */
function readableText(document) {
  const copy = document.body.cloneNode(true)
  for (const node of copy.querySelectorAll('script, style')) node.remove()
  const attributes = [...document.querySelectorAll('[aria-label], [placeholder], [title], [alt]')]
    .flatMap(node => ['aria-label', 'placeholder', 'title', 'alt'].map(name => node.getAttribute(name) ?? ''))
  return [document.title, copy.textContent, ...attributes].join('\n')
}
const UNSAID = /token|jwt|x6\.1/i

test('job 4 B1: the page never says token, tokens or JWT, in its text, its attributes, or any line its script can show', async t => {
  const fx = await boundEdge(t)
  const served = await fx.call('/', { headers: { accept: 'text/html', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' } })
  const dom = new JSDOM(served.body)
  t.after(() => dom.window.close())
  const document = dom.window.document
  assert.doesNotMatch(readableText(document), UNSAID)
  const words = scriptWords(document.querySelector('script').textContent)
  // The scan sees the lines it must: the passkey, owner-pass and invite status lines.
  for (const line of ['Paste a signed owner pass of at most 16 KiB.', 'Sign-in timed out. Paste the pass to try again.',
    'This browser cannot use a passkey here. Use “Another way to sign in” below.', 'Asking this node for a sign-in challenge…',
    'This link does not carry an invite this page can read. Nothing was sent.']) assert.ok(words.includes(line), line)
  for (const line of words) assert.doesNotMatch(line, UNSAID, line)
  // The second way in is said truly: a signed owner pass made by the owner's key elsewhere, which this page cannot make.
  assert.equal(document.querySelector('label[for="owner-token"]').textContent, 'Signed owner pass')
  assert.equal(document.getElementById('owner-help').textContent, 'A signed owner pass is made by the owner’s key on another machine. '
    + 'Pasted here, it is swapped for a secure browser session. This page cannot make or renew one.')
  // Identifiers, field ids and the wire format keep their names (the deploy checks and automated sign-in use them).
  assert.ok(document.getElementById('owner-token')); assert.match(document.querySelector('script').textContent, /'content-type': 'application\/jwt'/)
  // Every line the owner-pass form and the passkey part show, as they run: none says the words either.
  const page = await signinPage(t, fx, { webauthn: false })
  const form = page.document.getElementById('owner-signin'), input = page.document.getElementById('owner-token'), status = page.document.getElementById('owner-status')
  const shown = [page.status.textContent]
  for (const value of ['', 'synthetic.unknown.pass']) {
    input.value = value
    form.dispatchEvent(new page.dom.window.Event('submit', { bubbles: true, cancelable: true }))
    await settle(() => status.textContent !== '' && status.textContent !== 'Signing in…')
    shown.push(status.textContent)
  }
  assert.equal(shown.at(-1), 'This pass was not accepted. Paste a valid signed owner pass that has not run out, and try again.')
  for (const line of shown) assert.doesNotMatch(line, UNSAID, line)
})

test('job 4 B1: the page leads with the passkey; the signed owner pass waits under a closed "Another way to sign in"', async t => {
  const fx = await boundEdge(t)
  const served = await fx.call('/', { headers: { accept: 'text/html', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' } })
  assert.match(served.body, /<title>Owner sign-in<\/title>/); assert.match(served.body, /id="passkey-submit"/)
  const dom = new JSDOM(served.body)
  t.after(() => dom.window.close())
  const document = dom.window.document
  assert.equal(document.querySelector('h1').textContent, 'AUKORA')
  assert.equal(document.querySelector('h1').nextElementSibling.textContent, 'Owner sign-in')
  // The first control a person meets (the invite part is hidden without an invite link) is the passkey button.
  const controls = [...document.querySelectorAll('button, input, summary')].filter(node => !node.closest('[hidden]'))
  assert.equal(controls[0].id, 'passkey-submit')
  const other = document.getElementById('owner-other')
  assert.equal(other.tagName, 'DETAILS'); assert.equal(other.open, false)
  assert.equal(other.querySelector('summary').textContent, 'Another way to sign in')
  for (const id of ['owner-signin', 'owner-token', 'owner-submit', 'owner-status']) assert.ok(other.contains(document.getElementById(id)), id)
  // A browser that cannot use passkeys is shown that way open at once, since it is the only one.
  const page = await signinPage(t, fx, { webauthn: false })
  assert.equal(page.document.getElementById('owner-other').open, true)
  const able = await signinPage(t, fx)
  assert.equal(able.document.getElementById('owner-other').open, false)
  // Opening it and signing in with a pass still works: the owner-pass exchange is the same request as before.
  const owner = able.document.getElementById('owner-signin')
  able.document.getElementById('owner-token').value = 'synthetic.owner.pass'
  owner.dispatchEvent(new able.dom.window.Event('submit', { bubbles: true, cancelable: true }))
  await settle(() => able.requests.includes('/_auth/owner'))
  assert.equal(able.bodies[able.requests.indexOf('/_auth/owner')], 'synthetic.owner.pass')
})

test('job 4 B2: the Spatial look by value: palette and type from the tokens, one hashed style, nothing loaded, focus and motion cared for', async t => {
  const fx = await boundEdge(t)
  const served = await fx.call('/', { headers: { accept: 'text/html', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' } })
  const dom = new JSDOM(served.body)
  t.after(() => dom.window.close())
  const styles = dom.window.document.querySelectorAll('style')
  assert.equal(styles.length, 1)
  const css = styles[0].textContent
  // The exact-hash CSP is unchanged in form: style and script by hash, nothing else.
  const hash = text => `'sha256-${createHash('sha256').update(text).digest('base64')}'`
  assert.equal(served.response.headers.get('content-security-policy'), `default-src 'none'; base-uri 'none'; object-src 'none'; script-src ${hash(dom.window.document.querySelector('script').textContent)}; style-src ${hash(css)}; connect-src 'self'; form-action 'none'; frame-ancestors 'none'`)
  assert.doesNotMatch(css, /url\(|@import|@font-face|!important/)
  // The values are the Spatial tokens' own, each read from the files that define them.
  const read = path => readFileSync(new URL(path, import.meta.url), 'utf8')
  const spatial = read('../../../../packages/client/ui-layout/src/client/spatial/spatial-tokens.css')
  const platform = read('../../../../packages/client/ui-theme/src/styles/design-platform.css')
  const base = read('../../../../packages/client/ui-theme/src/styles/base.css')
  const token = (sheet, name) => new RegExp(`${name}:\\s*([^;]+);`).exec(sheet)?.[1].trim()
  for (const [sheet, name, why] of [
    [spatial, '--dsw-static-spatial-blue', 'accent line, primary button, focus ring'], [spatial, '--aukora-background', 'page'], [spatial, '--aukora-text', 'text'],
    [spatial, '--aukora-text-secondary', 'status line'], [spatial, '--aukora-text-muted', 'control borders'], [spatial, '--aukora-backdrop', 'field'],
    [spatial, '--dsw-static-spatial-night-900', 'canvas'], [spatial, '--dsw-static-spatial-night-950', 'canvas, primary label'],
    [platform, '--dsw-static-neutral-bluish-00', 'white title'], [platform, '--dsw-static-deepseek-300', 'primary hover'],
  ]) {
    const value = token(sheet, name)
    assert.ok(value && css.includes(value), `${name} (${why}): ${value}`)
    assert.ok(css.includes(name), `${name} is named in a comment beside its value`)
  }
  assert.ok(css.includes(token(base, '--dsh-font-family-text-default').replace(/\s+/g, ' ')), 'the platform text font stack')
  assert.match(css, /:focus-visible \{ outline: 3px solid rgb\(150, 180, 255\); outline-offset: 3px; \}/)
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{ input, button \{ transition: none; \} \}/)
  assert.doesNotMatch(css, /@keyframes|animation/)
  // Readable at 360 px and at 200% text: no fixed pixel widths or heights on content; sizes in rem/em; long words wrap.
  assert.doesNotMatch(css, /(?:^|[\s;{])(?:width|height|max-height):\s*\d+px/m)
  assert.match(css, /max-width: 26rem/); assert.match(css, /overflow-wrap: anywhere/)
  assert.match(served.body, /<meta name="viewport" content="width=device-width, initial-scale=1">/)
})

test('job 4 B2: the invite front door wears the same look, inside the same card, above the owner\'s passkey button', async t => {
  const fx = await boundEdge(t)
  const { fragment } = await issuedInvite(fx)
  const page = await signinPage(t, fx, { hash: fragment })
  const section = page.document.getElementById('invite-check')
  assert.equal(section.hidden, false)
  assert.equal(section.closest('main'), page.document.querySelector('main'))
  assert.ok(section.compareDocumentPosition(page.button) & page.dom.window.Node.DOCUMENT_POSITION_FOLLOWING)
  assert.doesNotMatch(readableText(page.document), UNSAID)
  assert.equal(page.document.getElementById('invite-submit').disabled, false)
})

/** The subject the door used before rows stood for networks: the raw address, as the baseline door hashed it. */
const legacySubject = address => 'guest-redeem:' + createHash('sha256').update(GUEST_DOOR.route + '\0' + address).digest('hex')
/** The persisted guest table exactly as the baseline door wrote it: its limits, its store, rows keyed by the raw address. */
function baselineGuestTable(attempts) {
  const gate = createGateLockoutStore({ maxFailures: 5, windowMs: 15 * 60_000, lockoutMs: 60 * 60_000, maxSubjects: 256 })
  for (const [address, at] of attempts) gate.recordFailure(legacySubject(address), at)
  return gate.snapshotSubjects()
}

test('job 5: a penalty set under the old raw-address subject still holds after the /64 change (IPv6 and IPv4), counting nothing', async () => {
  const t0 = 1_800_000_000_000, { lockoutMs, maxFailures } = GUEST_GATE_LIMITS
  const six = '2001:db8:1234:5678::beef', four = '203.0.113.9'
  const table = baselineGuestTable([...Array(maxFailures)].flatMap(() => [[six, t0], [four, t0]]))
  assert.deepEqual(table.map(([, entry]) => entry), [{ failedAt: Array(maxFailures).fill(t0), lockedUntil: t0 + lockoutMs }, { failedAt: Array(maxFailures).fill(t0), lockedUntil: t0 + lockoutMs }])
  const storage = memoryStorage()
  await storage.put(GUEST_GATE_KEY, table)
  const network = address => 'guest-redeem:' + createHash('sha256').update(GUEST_DOOR.route + '\0' + guestNetwork(address)).digest('hex')
  // IPv6: the new /64 row is free, but the old address's penalty answers first, with its true remaining wait.
  assert.notEqual(network(six), legacySubject(six))
  for (const action of ['reserve', 'check', 'failure']) {
    assert.deepEqual(await guestGateDecision(storage, action, network(six), t0 + 1, legacySubject(six)),
      { ok: false, code: 'GATE_LOCKOUT_ACTIVE', status: 429, retryAfterMs: lockoutMs - 1, legacy: true }, action)
  }
  // IPv4: old and new subjects are one, so the row's own lock answers.
  assert.equal(network(four), legacySubject(four))
  const locked4 = await guestGateDecision(storage, 'reserve', network(four), t0 + 1)
  assert.equal(locked4.code, 'GATE_LOCKOUT_ACTIVE')
  assert.equal(locked4.retryAfterMs, lockoutMs - 1)
  // Nothing was counted or created: the two baseline rows stand as they were, and no /64 row was made.
  assert.deepEqual(await storage.get(GUEST_GATE_KEY), table)
  // Late in the hour it still holds; once it ends the network is admitted on its own row.
  assert.equal((await guestGateDecision(storage, 'reserve', network(six), t0 + lockoutMs - 1, legacySubject(six))).retryAfterMs, 1)
  assert.deepEqual(await guestGateDecision(storage, 'reserve', network(six), t0 + lockoutMs, legacySubject(six)), { ok: true, admitted: true })
  assert.deepEqual(await guestGateDecision(storage, 'reserve', network(four), t0 + lockoutMs), { ok: true, admitted: true })
  // The expired legacy row left the table on its own; only the two current rows remain.
  assert.deepEqual((await storage.get(GUEST_GATE_KEY)).map(([key]) => key).sort(), [network(six), network(four)].sort())
})

test('job 5: the legacy check only reads: it never creates, counts on or extends a legacy row, and a bad legacy subject is refused', async () => {
  const t0 = 1_800_000_000_000, storage = memoryStorage(), subject = guestSubject('net-a')
  // Unlocked legacy row (four old attempts): it neither refuses nor is counted on.
  await storage.put(GUEST_GATE_KEY, baselineGuestTable([...Array(GUEST_GATE_LIMITS.maxFailures - 1)].map(() => ['2001:db8:9::1', t0])))
  const before = await storage.get(GUEST_GATE_KEY)
  assert.deepEqual(await guestGateDecision(storage, 'reserve', subject, t0 + 1, legacySubject('2001:db8:9::1')), { ok: true, admitted: true })
  const after = await storage.get(GUEST_GATE_KEY)
  assert.deepEqual(after.find(([key]) => key === legacySubject('2001:db8:9::1')), before[0])
  // A legacy subject with no row creates none.
  await guestGateDecision(storage, 'reserve', subject, t0 + 2, legacySubject('2001:db8:9::2'))
  assert.equal((await storage.get(GUEST_GATE_KEY)).some(([key]) => key === legacySubject('2001:db8:9::2')), false)
  assert.equal((await storage.get(GUEST_GATE_KEY)).length, 2)
  for (const bad of ['', 'guest-redeem:xyz', 5, {}]) {
    await assert.rejects(guestGateDecision(storage, 'reserve', subject, t0 + 3, bad), { message: 'GUEST_GATE_REQUEST_INVALID' }, String(bad))
  }
})

test('job 5: through the door: a penalised IPv6 address stays penalised after the deploy, its /64 neighbours are still checked; IPv4 the same', async t => {
  const fx = await boundEdge(t)
  const body = { invite: { schema: 'aukora.invite.v1' }, code: Buffer.alloc(32, 7).toString('base64url') }
  const now = Date.now(), six = '2001:db8:1234:5678::beef', four = '198.51.100.9'
  await fx.mirrorStorage.put(GUEST_GATE_KEY, baselineGuestTable([...Array(GUEST_GATE_LIMITS.maxFailures)].flatMap(() => [[six, now], [four, now]])))
  // (The old door keyed rows by the exact address text, so the penalty is on exactly that text, as the edge sends it.)
  for (const address of [six, four]) {
    const locked = await fx.call(GUEST_DOOR.route, { method: 'POST', body, address })
    assert.equal(locked.response.status, 429, address)
    assert.equal(locked.body.code, 'GUEST_DOOR_LOCKED', address)
    assert.ok(Number(locked.response.headers.get('retry-after')) > 3500, address)
  }
  // The neighbour on the same /64 never had a penalty: it is checked (and that legacy lock was not held for its network).
  const neighbour = await fx.call(GUEST_DOOR.route, { method: 'POST', body, address: '2001:db8:1234:5678::1' })
  assert.notEqual(neighbour.response.status, 429)
  // The penalised address is still refused after its neighbour was admitted.
  assert.equal((await fx.call(GUEST_DOOR.route, { method: 'POST', body, address: six })).body.code, 'GUEST_DOOR_LOCKED')
  // Once the old penalties have run out (the table as it stands an hour on; the mirror reads the real clock) both are
  // checked again. The IPv6 address is checked at once: the isolate never held the legacy lock for its network. The
  // IPv4 row's own lock was held in the isolate, for at most its hold.
  await fx.mirrorStorage.put(GUEST_GATE_KEY, baselineGuestTable([...Array(GUEST_GATE_LIMITS.maxFailures)].flatMap(() => [[six, now - GUEST_GATE_LIMITS.lockoutMs - 1], [four, now - GUEST_GATE_LIMITS.lockoutMs - 1]])))
  assert.notEqual((await fx.call(GUEST_DOOR.route, { method: 'POST', body, address: six })).response.status, 429)
  fx.clock.offset += ISOLATE_SHIELD.guest.holdMs
  assert.notEqual((await fx.call(GUEST_DOOR.route, { method: 'POST', body, address: four })).response.status, 429)
})

test('job 5: when the browser will not take the invite out of the address bar, the page reads nothing, sends nothing and says so', async t => {
  const fx = await boundEdge(t)
  const { code, fragment } = await issuedInvite(fx)
  const page = await signinPage(t, fx, { hash: fragment, addressBarStuck: true })
  assert.deepEqual(page.addressBar, [])
  assert.equal(page.win.location.hash, fragment)
  assert.equal(page.document.getElementById('invite-check').hidden, false)
  assert.equal(page.document.getElementById('invite-status').textContent,
    'This invite could not be opened safely here: its link could not be taken out of the address bar. Nothing was sent. Open the invite link again.')
  assert.equal(page.document.getElementById('invite-submit').disabled, true)
  assert.equal(page.document.getElementById('invite-code').disabled, true)
  page.document.getElementById('invite-code').value = code
  page.document.getElementById('invite-form').dispatchEvent(new page.dom.window.Event('submit', { bubbles: true, cancelable: true }))
  await settle(() => page.timers.size === 1)
  assert.deepEqual(page.requests, [OWNER_PASSKEY.challenge])
  assert.ok(!page.document.documentElement.outerHTML.includes(fragment.slice(8, 40)))
  // The owner's passkey sign-in on the page is untouched.
  page.click()
  await settle(() => page.replacements.length === 1)
  assert.match(page.jar.cookie, /^__Host-x61-owner=/)
})
