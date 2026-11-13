/**
 * THE OWNER JWT LOGIN OBEYS THE ONE RULE (proof-failure-rule.mjs), through the real Worker and HEAD over
 * in-memory storage. Only a well-formed, in-window owner JWT whose Ed25519 signature was CHECKED and WRONG records a
 * login failure; a malformed JWT, one out of its window, for another audience or owner, or otherwise refused before its
 * signature is checked moves no counter, however many arrive (so five junk strings can no longer lock the door). The
 * distinction reaches HEAD as a closed field of the internal Worker-to-HEAD call, which no client can send: HEAD refuses
 * a failure without it, and the Worker never forwards a client's request to that route.
 * (The twelve injected answers for this signature are a row of the TABLE in passkey-devices.test.mjs.)
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { runInNewContext } from 'node:vm'
import { JSDOM } from 'jsdom'
import { createWorker } from '../worker.mjs'
import { X61HeadDurableObject } from '../head-do.mjs'
import { proofOutcome, relayWrong } from '../proof-failure-rule.mjs'
import { OWNER_LOGIN_SLOTS, createLoginSlots } from '../owner-login-slots.mjs'
import { waitFor } from './wait-for.mjs'

const ORIGIN = 'https://owner-login-gate.example.invalid'
const OWNER = 'owner@example.invalid'
const b64 = value => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url')

function memoryStorage() {
  const rows = new Map()
  let queue = Promise.resolve()
  const adapter = map => ({
    get: async key => structuredClone(map.get(key)),
    put: async (key, value) => { map.set(key, structuredClone(value)) },
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

async function fixture({ clock } = {}) {
  const keys = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])
  const other = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])
  const at = Date.now()
  const env = { PUBLIC_HOST: new URL(ORIGIN).host, OWNER_EMAIL: OWNER, OWNER_PUBLIC_KEY_HEX: Buffer.from(await crypto.subtle.exportKey('raw', keys.publicKey)).toString('hex') }
  const storage = memoryStorage()
  const head = new X61HeadDurableObject({ storage, getWebSockets: () => [] }, env)
  const headPaths = []
  env.HEAD = { idFromName: name => name, get: () => ({ fetch: request => { headPaths.push(new URL(request.url).pathname); return head.fetch(request) } }) }
  const claims = { iss: 'aukora.x61.owner', aud: env.PUBLIC_HOST, email: OWNER, nbf: Math.floor(at / 1000) - 1, exp: Math.floor(at / 1000) + 600 }
  /** A JWT from raw parts: `header` and `payload` are objects (encoded compactly) or strings (encoded as they are). */
  const jwt = async ({ header = { alg: 'EdDSA', typ: 'JWT' }, payload = claims, key = keys.privateKey, signature } = {}) => {
    const input = b64(header) + '.' + b64(payload)
    return input + '.' + (signature ?? Buffer.from(await crypto.subtle.sign('Ed25519', key, new TextEncoder().encode(input))).toString('base64url'))
  }
  const worker = createWorker({ now: clock ? () => clock.now : () => at })
  const login = (body, address = '192.0.2.50') => worker.fetch(new Request(ORIGIN + '/_auth/owner', {
    method: 'POST', headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/jwt', 'cf-connecting-ip': address }, body }), env)
  const subjectOf = address => 'owner-login:' + createHash('sha256').update('/_auth/owner\0' + address).digest('hex')
  /** The durable login failures recorded for one address (0 when it has no entry). */
  const failures = async (address = '192.0.2.50') => (((await storage.get('gate-lockout:v1')) ?? []).find(([subject]) => subject === subjectOf(address))?.[1].failedAt.length) ?? 0
  return { env, at, keys, other, claims, jwt, login, failures, subjectOf, head, headPaths, storage, worker }
}

/** Fifty refusals that come BEFORE any signature check: malformed, out of window, another audience, issuer or owner. */
async function refusedBeforeSignature(f) {
  const s = f.at / 1000
  const forms = [
    'invalid', 'a.b.c', 'x'.repeat(200), 'eyJ.eyJ.eyJ', '...', 'a..b', 'not a jwt at all',
    b64('{') + '.' + b64(f.claims) + '.' + 'A'.repeat(86),
    b64({ alg: 'EdDSA', typ: 'JWT' }) + '.' + b64('not json') + '.' + 'A'.repeat(86),
    await f.jwt({ header: { alg: 'none', typ: 'JWT' } }),
    await f.jwt({ header: { alg: 'RS256', typ: 'JWT', kid: 'k' } }),
    await f.jwt({ header: { alg: 'EdDSA' } }),
    await f.jwt({ header: { alg: 'EdDSA', typ: 'JWT', kid: 'extra' } }),
    await f.jwt({ header: '{"alg": "EdDSA", "typ": "JWT"}' }),
    await f.jwt({ payload: { ...f.claims, extra: 1 } }),
    await f.jwt({ payload: { ...f.claims, iss: 'someone.else' } }),
    await f.jwt({ payload: { ...f.claims, aud: 'other.example.invalid' } }),
    await f.jwt({ payload: { ...f.claims, email: 'stranger@example.invalid' } }),
    await f.jwt({ payload: { ...f.claims, exp: s - 1, nbf: s - 600 } }),
    await f.jwt({ payload: { ...f.claims, nbf: s + 60, exp: s + 600 } }),
    await f.jwt({ payload: { ...f.claims, nbf: s - 1, exp: s + 86400 * 2 } }),
    await f.jwt({ payload: { ...f.claims, exp: 'soon' } }),
    await f.jwt({ payload: JSON.stringify(f.claims).replace('{', '{ ') }),
    await f.jwt({ signature: 'A'.repeat(85) }),
    await f.jwt({ signature: 'A'.repeat(88) }),
    // Wrongly signed AND for another audience: refused on its claims, before the signature is ever checked.
    await f.jwt({ payload: { ...f.claims, aud: 'other.example.invalid' }, key: f.other.privateKey }),
  ]
  return Array.from({ length: 50 }, (_, index) => forms[index % forms.length])
}

test('50 malformed or refused-before-signature owner JWTs never lock the door and record nothing; 5 well-formed wrongly signed ones lock it', async () => {
  const f = await fixture()
  for (const [index, token] of (await refusedBeforeSignature(f)).entries()) {
    const response = await f.login(token)
    assert.ok([400, 401].includes(response.status), `${index}: ${token.slice(0, 60)} answered ${response.status}`)
    assert.equal(response.headers.get('set-cookie'), null)
    assert.notEqual((await response.json()).code, 'GATE_LOCKOUT_ACTIVE')
  }
  assert.equal(await f.failures(), 0, 'not one of the fifty moved the login gate')
  // Review fix: a refusal before the signature check is answered in the isolate; not one of the fifty reached HEAD.
  assert.deepEqual(f.headPaths.filter(path => path === '/_head/gate-lockout'), [], 'no durable call for a refused JWT')
  // Five well-formed, in-window owner JWTs, each signed by another key: checked, wrong, counted; the fifth locks.
  const statuses = []
  for (let index = 0; index < 5; index++) {
    const response = await f.login(await f.jwt({ key: f.other.privateKey, payload: { ...f.claims, exp: f.claims.exp + index } }))
    statuses.push(response.status)
    if (index === 4) assert.equal((await response.json()).code, 'GATE_LOCKOUT_ACTIVE')
  }
  assert.deepEqual(statuses, [401, 401, 401, 401, 429])
  assert.equal(await f.failures(), 5)
  // The genuine owner JWT while locked: still refused (a lock is never lifted early), no cookie.
  const held = await f.login(await f.jwt())
  assert.equal(held.status, 429); assert.equal(held.headers.get('set-cookie'), null)
})

test('the signed-out door stays cheap: 200 junk JWTs from one address, or from 200 addresses, make no durable call at all', async () => {
  const f = await fixture()
  for (let index = 0; index < 200; index++) {
    const response = await f.login('junk', '198.51.100.7')
    assert.equal(response.status, 401, String(index))
    assert.equal(response.headers.get('set-cookie'), null)
  }
  for (let index = 0; index < 200; index++) assert.equal((await f.login('junk.junk.junk', `198.51.${100 + (index >> 8)}.${index & 255}`)).status, 401)
  // A JWT whose window cannot be judged (no usable clock) reaches no verdict: 503, also without a durable call.
  const noClock = createWorker({ now: () => Number.NaN })
  const unavailable = await noClock.fetch(new Request(ORIGIN + '/_auth/owner', { method: 'POST', headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin',
    'content-type': 'application/jwt', 'cf-connecting-ip': '198.51.100.8' }, body: await f.jwt() }), f.env)
  assert.equal(unavailable.status, 503)
  assert.equal(f.headPaths.length, 0, `HEAD was called ${f.headPaths.length} times: ${[...new Set(f.headPaths)].join(', ')}`)
  assert.equal(await f.failures('198.51.100.7'), 0)
  // The well-formed path still asks HEAD: check, then success, for the genuine owner JWT.
  assert.equal((await f.login(await f.jwt(), '198.51.100.7')).status, 200)
  assert.deepEqual(f.headPaths, ['/_head/gate-lockout', '/_head/gate-lockout'])
})

test('a refusal before the signature check, then the genuine owner JWT: signed in at once', async () => {
  const f = await fixture()
  for (let index = 0; index < 10; index++) assert.equal((await f.login('junk.junk.junk')).status, 401)
  const genuine = await f.login(await f.jwt())
  assert.equal(genuine.status, 200)
  assert.match(genuine.headers.get('set-cookie') ?? '', /^CF_Authorization=/)
})

test('HEAD records a login failure only with the closed field the Worker sends for a checked-wrong signature; anything else is 400 and writes nothing', async () => {
  const f = await fixture()
  const subject = f.subjectOf('192.0.2.77')
  const claim = relayWrong(await proofOutcome(() => false, { code: 'OWNER_LOGIN_SIGNATURE_INVALID' }))
  const internal = body => f.head.fetch(new Request('https://x61.internal/_head/gate-lockout', { method: 'POST',
    headers: { 'x-x6-internal-authorized': '1', 'content-type': 'application/json' }, body: JSON.stringify(body) }))
  for (const body of [
    { action: 'failure', subject },
    { action: 'failure', subject, proof: 'owner-login-checked-wrong' },
    { action: 'failure', subject, proof: true },
    { action: 'failure', subject, proof: { claim } },
    { action: 'failure', subject, proof: claim + ' ' },
    { action: 'failure', subject, proof: claim, extra: 1 },
    { action: 'check', subject, proof: claim },
    { action: 'success', subject, proof: claim },
  ]) {
    const response = await internal(body)
    assert.equal(response.status, 400, JSON.stringify(body))
    assert.equal((await response.json()).code, 'GATE_REQUEST_INVALID')
  }
  assert.equal(await f.storage.get('gate-lockout:v1'), undefined, 'nothing was written')
  // Without the internal header nothing is admitted at all.
  const outside = await f.head.fetch(new Request('https://x61.internal/_head/gate-lockout', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'failure', subject, proof: claim }) }))
  assert.equal(outside.status, 401)
  assert.equal(await f.storage.get('gate-lockout:v1'), undefined)
  // The Worker's own claim counts exactly one.
  const counted = await internal({ action: 'failure', subject, proof: claim })
  assert.equal(counted.status, 200)
  assert.equal((await counted.json()).gate.failures, 1)
  assert.throws(() => relayWrong(null), { code: 'PROOF_RULE_VIOLATION' })
  assert.throws(() => relayWrong({ kind: 'wrong', code: 'OWNER_LOGIN_SIGNATURE_INVALID', status: 403 }), { code: 'PROOF_RULE_VIOLATION' })
})

test('a client can never reach HEAD\'s login gate through the Worker, signed in or not, whatever headers it sends', async () => {
  const f = await fixture()
  const claim = relayWrong(await proofOutcome(() => false, { code: 'OWNER_LOGIN_SIGNATURE_INVALID' }))
  const body = JSON.stringify({ action: 'failure', subject: f.subjectOf('192.0.2.50'), proof: claim })
  const owner = await f.jwt()
  for (const cookie of [null, `CF_Authorization=${owner}`]) {
    const response = await f.worker.fetch(new Request(ORIGIN + '/_head/gate-lockout', { method: 'POST',
      headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', 'x-x6-internal-authorized': '1',
        'cf-connecting-ip': '192.0.2.50', ...(cookie ? { cookie } : {}) }, body }), f.env)
    assert.notEqual(response.status, 200, String(cookie))
  }
  assert.equal(f.headPaths.includes('/_head/gate-lockout'), false, 'no client request reached the login gate')
  assert.equal(await f.failures(), 0)
})

// ── The lock bounds failures STORED, not checks in flight. Now the
// isolate bounds the signature checks in flight per address to the failures that remain before the lock; the rest are
// answered at once (429, the lock's shape, a short wait), let go on settle and at a deadline of their own. ──
/** Holds every owner-JWT Ed25519 check (counts them); `settle(answer)` answers the held ones. Everything else is real. */
function holdChecks(t, header) {
  const original = crypto.subtle.verify.bind(crypto.subtle), held = []
  const mock = t.mock.method(crypto.subtle, 'verify', (name, ...rest) => {
    if ((typeof name === 'string' ? name : name?.name) === 'Ed25519' && Buffer.from(rest[2]).toString('latin1').startsWith(header)) {
      return new Promise(resolve => { held.push(resolve) })
    }
    return original(name, ...rest)
  })
  return { held, settle: answer => { for (const resolve of held.splice(0)) resolve(answer) }, restore: () => mock.mock.restore() }
}
const until = (condition, what) => waitFor(condition, what)

test('100 overlapping wrongly signed owner passes start at most five signature checks; the other 95 are answered at once (429, a short wait); five failures lock the door', async t => {
  const f = await fixture()
  const header = b64({ alg: 'EdDSA', typ: 'JWT' }) + '.'
  const checks = holdChecks(t, header)
  const answers = []
  const passes = await Promise.all(Array.from({ length: 100 }, (_, index) => f.jwt({ key: f.other.privateKey, payload: { ...f.claims, exp: f.claims.exp + index } })))
  const pending = passes.map(token => f.login(token).then(response => { answers.push(response); return response }))
  // Every request has either been answered or is holding a signature check.
  await until(() => answers.length + checks.held.length === 100, `answered ${String(answers.length)}, checks held ${String(checks.held.length)}`)
  assert.ok(checks.held.length <= 5, `${String(checks.held.length)} signature checks started at once (the budget is five)`)
  assert.equal(checks.held.length, 5, 'the budget is used, not more')
  for (const response of answers) {
    assert.equal(response.status, 429)
    assert.equal(response.headers.get('retry-after'), '1')
    assert.deepEqual(await response.json(), { ok: false, code: 'OWNER_LOGIN_CHECKS_BUSY', status: 429, retryAfterMs: 1000 })
  }
  checks.settle(false)
  const all = await Promise.all(pending)
  checks.restore()
  const held = all.filter(response => !answers.slice(0, 95).includes(response))
  assert.deepEqual(held.map(response => response.status).sort(), [401, 401, 401, 401, 429])
  assert.equal(await f.failures(), 5, 'exactly the five checked-wrong signatures were counted')
  // Locked now: the genuine owner pass is refused (a lock is never lifted early), with no signature check.
  const verify = t.mock.method(crypto.subtle, 'verify')
  assert.equal((await f.login(await f.jwt())).status, 429)
  assert.equal(verify.mock.calls.filter(call => call.arguments[0] === 'Ed25519').length, 0)
})

test('the bound is what REMAINS before the lock: after three failures, five overlapping passes start two checks; slots are let go when their checks settle', async t => {
  const f = await fixture()
  const header = b64({ alg: 'EdDSA', typ: 'JWT' }) + '.'
  for (let index = 0; index < 3; index++) assert.equal((await f.login(await f.jwt({ key: f.other.privateKey, payload: { ...f.claims, exp: f.claims.exp + index } }))).status, 401)
  assert.equal(await f.failures(), 3)
  const checks = holdChecks(t, header)
  const answers = []
  const pending = Array.from({ length: 5 }, (_, index) => f.jwt({ key: f.other.privateKey, payload: { ...f.claims, exp: f.claims.exp + 10 + index } })
    .then(token => f.login(token)).then(response => { answers.push(response.status); return response }))
  await until(() => answers.length + checks.held.length === 5, 'all five answered or checking')
  assert.deepEqual([checks.held.length, answers], [2, [429, 429, 429]])
  // Settled as genuine (the slots are let go on settle): the genuine owner pass is then admitted at once and signs in.
  checks.settle(true)
  await Promise.all(pending)
  checks.restore()
  const genuine = await f.login(await f.jwt())
  assert.equal(genuine.status, 200)
})

// ── The finding "five pending checks become ten after lease expiry". A lease
// that ends while its signature check still runs frees nothing: the check counts until its own promise settles. The
// request's check and gate call run under the lease's deadline; past it the request is FENCED (503, retry in a second)
// and its late result is acted on by nobody. ──
/** Mock setTimeout (the request's deadline) and keep the injected clock in step with it. */
const advance = (t, clock, ms) => { clock.now += ms; t.mock.timers.tick(ms) }
const edCalls = verify => verify.mock.calls.filter(call => (typeof call.arguments[0] === 'string' ? call.arguments[0] : call.arguments[0]?.name) === 'Ed25519').length

test('100 held checks, leases expired again and again: exactly five signature checks ever start; the five requests are fenced (503) and their late wrong answers count nothing', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const clock = { now: Date.now() }
  const f = await fixture({ clock })
  const header = b64({ alg: 'EdDSA', typ: 'JWT' }) + '.'
  const checks = holdChecks(t, header)
  const started = () => checks.held.length
  const answers = []
  const passes = await Promise.all(Array.from({ length: 200 }, (_, index) => f.jwt({ key: f.other.privateKey, payload: { ...f.claims, exp: f.claims.exp + index } })))
  const first = passes.slice(0, 100).map(token => f.login(token).then(response => { answers.push(response); return response }))
  await until(() => answers.length + started() === 100, `answered ${String(answers.length)}, checks started ${String(started())}`)
  assert.equal(started(), 5, 'the budget, not more')
  const early = [...answers]
  assert.ok(early.every(response => response.status === 429), 'the other 95 answered at once')
  // The leases' deadline passes while the five checks still run. The leases are gone; the five checks are not. A hundred
  // more passes, with the clock moved past every deadline again: not one more check starts (before this job: five more
  // did after each expiry, the reviewer's "five become ten").
  for (const [index, batch] of [passes.slice(100, 150), passes.slice(150, 200)].entries()) {
    advance(t, clock, index === 0 ? OWNER_LOGIN_SLOTS.holdMs + 1 : OWNER_LOGIN_SLOTS.holdMs * 3)
    // The watcher ends when the fifty are answered (the race is then already theirs) or a sixth check starts; it waits on
    // elapsed time, never a count of turns, so a slow machine cannot end it first with a false 'more checks started'.
    let answered = false
    const statuses = await Promise.race([Promise.all(batch.map(token => f.login(token).then(response => response.status))).then(all => { answered = true; return all }),
      (async () => { await waitFor(() => answered || started() > 5, 'the fifty answers, or a sixth signature check'); return 'more checks started' })()])
    assert.equal(started(), 5, `after lease expiry ${String(index + 1)}: ${String(started())} signature checks started (the budget is five)`)
    assert.deepEqual(statuses, Array(50).fill(429))
  }
  assert.equal(started(), 5, 'two hundred passes and every lease expired: five signature checks ever started')
  // The five requests themselves were fenced at their deadline: 503, retry in a second, no cookie.
  const fenced = (await Promise.all(first)).filter(response => !early.includes(response))
  assert.equal(fenced.length, 5)
  for (const response of fenced) {
    assert.equal(response.status, 503)
    assert.deepEqual(await response.json(), { ok: false, code: 'OWNER_LOGIN_UNAVAILABLE' })
    assert.equal(response.headers.get('retry-after'), '1')
    assert.equal(response.headers.get('set-cookie'), null)
  }
  // The five checks finally answer WRONG: fenced, so nothing is counted (their requests were answered 503 long ago).
  const gateCalls = () => f.headPaths.filter(path => path === '/_head/gate-lockout').length
  const before = gateCalls()
  checks.settle(false)
  for (let index = 0; index < 50; index++) await new Promise(resolve => setImmediate(resolve))
  assert.equal(gateCalls(), before, 'a fenced result makes no gate call')
  assert.equal(await f.failures(), 0, 'and counts no failure')
  checks.restore()
  // The checks have settled: the place is free, and the genuine owner pass signs in.
  const genuine = await f.login(await f.jwt())
  assert.equal(genuine.status, 200)
  assert.match(genuine.headers.get('set-cookie') ?? '', /^CF_Authorization=/)
})

test('a GENUINE owner pass whose check answers only after its deadline is fenced: 503, no cookie, no success recorded; the next one signs in', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const clock = { now: Date.now() }
  const f = await fixture({ clock })
  // Three counted failures first, so a recorded success would show (it clears them).
  for (let index = 0; index < 3; index++) assert.equal((await f.login(await f.jwt({ key: f.other.privateKey, payload: { ...f.claims, exp: f.claims.exp + index } }))).status, 401)
  assert.equal(await f.failures(), 3)
  const checks = holdChecks(t, b64({ alg: 'EdDSA', typ: 'JWT' }) + '.')
  const late = f.login(await f.jwt())
  await until(() => checks.held.length === 1, 'the genuine check is held')
  advance(t, clock, OWNER_LOGIN_SLOTS.holdMs + 1)
  const answer = await late
  assert.deepEqual([answer.status, (await answer.json()).code, answer.headers.get('set-cookie')], [503, 'OWNER_LOGIN_UNAVAILABLE', null])
  const gateCalls = () => f.headPaths.filter(path => path === '/_head/gate-lockout').length
  const before = gateCalls()
  checks.settle(true)
  for (let index = 0; index < 50; index++) await new Promise(resolve => setImmediate(resolve))
  checks.restore()
  assert.equal(gateCalls(), before, 'no success call for a fenced result')
  assert.equal(await f.failures(), 3, 'no success recorded: the three failures stand')
  const next = await f.login(await f.jwt())
  assert.equal(next.status, 200)
  assert.match(next.headers.get('set-cookie') ?? '', /^CF_Authorization=/)
  assert.equal(await f.failures(), 0, 'a success in time clears them')
})

test('an answer in time is acted on as before; the deadline timer is cleared (nothing left behind), wrong and genuine', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = await fixture()
  assert.equal((await f.login(await f.jwt({ key: f.other.privateKey }))).status, 401)
  assert.equal(await f.failures(), 1)
  const genuine = await f.login(await f.jwt())
  assert.equal(genuine.status, 200)
  assert.equal(await f.failures(), 0)
  // Both requests cleared their deadlines: running every timer now fences nothing and changes nothing.
  t.mock.timers.runAll()
  assert.equal(await f.failures(), 0)
})

test('what a person reads for 429 OWNER_LOGIN_CHECKS_BUSY: the real sign-in page, its owner-pass form, against the real Worker with five checks in flight', async t => {
  const f = await fixture()
  const header = b64({ alg: 'EdDSA', typ: 'JWT' }) + '.'
  const checks = holdChecks(t, header)
  // Five wrongly signed passes from the page's own address hold every slot.
  const held = Array.from({ length: 5 }, async (_, index) => f.login(await f.jwt({ key: f.other.privateKey, payload: { ...f.claims, exp: f.claims.exp + index } }), '192.0.2.70'))
  await until(() => checks.held.length === 5, 'five checks held')
  const served = await f.worker.fetch(new Request(ORIGIN + '/', { headers: { accept: 'text/html', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', 'cf-connecting-ip': '192.0.2.70' } }), f.env)
  assert.equal(served.status, 401)
  const dom = new JSDOM(await served.text(), { url: ORIGIN })
  t.after(() => dom.window.close())
  const document = dom.window.document, answers = []
  const win = { name: '', addEventListener: dom.window.addEventListener.bind(dom.window), location: { origin: ORIGIN, replace: () => {}, pathname: '/', hash: '' },
    history: { replaceState: () => {} } }
  runInNewContext(document.querySelector('script').textContent, {
    document, window: win, navigator: {}, AbortController, URL, btoa, atob, TextDecoder, Date, performance, AbortSignal,
    setTimeout: () => 0, clearTimeout: () => {},
    async fetch(path, options) {
      const response = await f.worker.fetch(new Request(new URL(path, ORIGIN), { method: options.method,
        headers: { ...options.headers, origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'cf-connecting-ip': '192.0.2.70' }, body: options.body }), f.env)
      answers.push([response.status, (await response.clone().json()).code])
      return response
    },
  })
  const form = document.getElementById('owner-signin'), input = document.getElementById('owner-token'), status = document.getElementById('owner-status')
  input.value = await f.jwt({ key: f.other.privateKey, payload: { ...f.claims, exp: f.claims.exp + 50 } })
  form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }))
  await until(() => status.textContent !== '' && status.textContent !== 'Signing in…', 'the page answered')
  assert.deepEqual(answers, [[429, 'OWNER_LOGIN_CHECKS_BUSY']], 'the page met the busy answer itself')
  // SOURCE worker.mjs OWNER_SIGNIN_SCRIPT: every answer other than 200 and 401 reads the same; it says nothing was locked.
  assert.equal(status.textContent, 'Sign-in could not complete. Paste the pass to try again.')
  assert.equal(input.disabled, false, 'the form is usable again at once')
  checks.settle(false)
  await Promise.all(held)
  checks.restore()
})

test('the slot table itself: per subject, bounded by the limit asked, released once, a lease expired at its deadline, a running check counted until it settles, bounded in size', async () => {
  const slots = createLoginSlots({ holdMs: 100, capacity: 3 })
  const a = [slots.take('a', 2, 0), slots.take('a', 2, 0)]
  assert.ok(a.every(slot => slot !== null && typeof slot.release === 'function' && typeof slot.check === 'function'))
  assert.equal(slots.take('a', 2, 0), null, 'two in flight, the limit is two')
  assert.notEqual(slots.take('b', 2, 0), null, 'another subject has its own')
  a[0].release(); a[0].release()
  assert.equal(slots.inFlight('a', 0), 1, 'released once, however often it is called')
  assert.equal(slots.inFlight('a', 100), 0, 'at the deadline an unchecked lease is gone')
  for (const limit of [0, -1, 1.5, Number.NaN, Infinity]) assert.equal(slots.take('c', limit, 0), null, String(limit))
  // A check that is running holds its place past its lease's deadline and past release, until its own promise settles.
  let finish
  const running = slots.take('r', 1, 1000)
  const pending = running.check(() => new Promise(resolve => { finish = resolve }))
  running.release()
  assert.deepEqual([slots.inFlight('r', 1000), slots.running('r')], [1, 1])
  assert.equal(slots.take('r', 1, 1000 + 100 * 50), null, 'fifty deadlines later: still one running, the limit is one')
  await assert.rejects(running.check(() => true), { code: 'OWNER_LOGIN_CHECK_STARTED' })
  finish('done')
  assert.equal(await pending, 'done')
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual([slots.inFlight('r', 1000), slots.running('r')], [0, 0])
  assert.notEqual(slots.take('r', 1, 1000), null, 'settled: the place is free')
  // A check that throws or rejects settles too.
  const thrown = slots.take('s', 1, 0)
  await assert.rejects(thrown.check(() => { throw new Error('down') }), /down/)
  thrown.release()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(slots.inFlight('s', 0), 0)
  // Bounded in size; when full, a row whose check still runs is kept and a row with only leases goes.
  const table = createLoginSlots({ holdMs: 100, capacity: 3 })
  const hung = table.take('hung', 1, 0)
  void hung.check(() => new Promise(() => {}))
  for (const subject of ['d', 'e', 'f', 'g']) table.take(subject, 1, 0)
  assert.ok(table.size() <= 3, 'bounded')
  assert.equal(table.running('hung'), 1, 'the row with a running check was kept')
  assert.equal(table.take('hung', 1, 10000), null, 'and still bounds its subject')
})

// ── Job 11, SHOULD 3: an ambient owner JWT whose check reached no verdict is 503 through the access dispatcher, never 401
// "signed out"; a checked-wrong one is still 401, a genuine one still reads. ──
test('an owner JWT cookie whose signature check reaches no verdict reads as 503 OWNER_SESSION_UNAVAILABLE, never signed out; false is 401; true reads', async t => {
  const f = await fixture()
  const cookie = `CF_Authorization=${await f.jwt()}`
  const read = () => f.worker.fetch(new Request(ORIGIN + '/_host/aumlok/devices', { headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin', cookie, 'cf-connecting-ip': '192.0.2.60' } }), f.env)
  const original = crypto.subtle.verify.bind(crypto.subtle)
  for (const [name, answer, status] of [['{}', () => ({}), 503], ['undefined', () => undefined, 503], ['a throw', () => { throw new Error('down') }, 503],
    ['false', () => false, 401]]) {
    const mock = t.mock.method(crypto.subtle, 'verify', (algorithm, ...rest) => (typeof algorithm === 'string' ? algorithm : algorithm?.name) === 'Ed25519' ? answer() : original(algorithm, ...rest))
    const response = await read()
    mock.mock.restore()
    assert.equal(response.status, status, `${name}: ${await response.clone().text()}`)
    if (status === 503) {
      assert.deepEqual(await response.json(), { ok: false, code: 'OWNER_SESSION_UNAVAILABLE' })
      assert.equal(response.headers.get('retry-after'), '1')
      assert.equal(response.headers.get('set-cookie'), null, 'the cookie is kept')
    }
  }
  // Nothing counted anywhere: the ambient check is never a login.
  assert.equal(await f.failures('192.0.2.60'), 0)
  // A genuine check: past access (whatever this bare fixture's route then answers, it is neither signed out nor unchecked).
  const genuine = await read(), body = await genuine.text()
  assert.ok(genuine.status !== 401 && !body.includes('OWNER_SESSION_UNAVAILABLE') && !body.includes('OWNER_ACCESS_REQUIRED'), `${String(genuine.status)}: ${body}`)
})

// ── Job 11 review (SHOULD): that 503 never shuts the owner out of the sign-in page. The cookie is HttpOnly (the page cannot
// clear it) and lives up to 24 h; if its check never reaches a verdict, a NAVIGATION still gets the sign-in page (his
// passkey is the way in), exactly as on an unseeded edge. API routes keep the 503. ──
test('an owner JWT cookie whose check never reaches a verdict still lets a navigation reach the sign-in page; API routes stay 503', async t => {
  const f = await fixture()
  const cookie = `CF_Authorization=${await f.jwt()}`
  const navigate = path => f.worker.fetch(new Request(ORIGIN + path, { headers: { cookie, 'cf-connecting-ip': '192.0.2.61',
    accept: 'text/html,application/xhtml+xml', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', 'sec-fetch-site': 'none' } }), f.env)
  const api = () => f.worker.fetch(new Request(ORIGIN + '/_host/aumlok/devices', { headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin', cookie, 'cf-connecting-ip': '192.0.2.61' } }), f.env)
  const original = crypto.subtle.verify.bind(crypto.subtle)
  for (const [name, answer] of [['a throw', () => { throw new Error('down') }], ['{}', () => ({})], ['undefined', () => undefined]]) {
    const mock = t.mock.method(crypto.subtle, 'verify', (algorithm, ...rest) => (typeof algorithm === 'string' ? algorithm : algorithm?.name) === 'Ed25519' ? answer() : original(algorithm, ...rest))
    try {
      for (const path of ['/', '/index.html']) {
        const page = await navigate(path), text = await page.text()
        assert.equal(page.status, 401, `${name} ${path}: ${text.slice(0, 200)}`)
        assert.match(page.headers.get('content-type') ?? '', /^text\/html/)
        assert.ok(text.includes('id="passkey-submit"') && text.includes('id="owner-signin"'), `${name} ${path}: the sign-in page, with the passkey`)
        assert.equal(page.headers.get('set-cookie'), null, 'nothing about the cookie changes')
      }
      const refused = await api()
      assert.equal(refused.status, 503, name)
      assert.deepEqual(await refused.json(), { ok: false, code: 'OWNER_SESSION_UNAVAILABLE' })
    } finally { mock.mock.restore() }
  }
  assert.equal(await f.failures('192.0.2.61'), 0, 'nothing counted')
})
