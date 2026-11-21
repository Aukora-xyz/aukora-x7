/** Fakes for the VoiceBridge tests: the Workers WebSocket pair and 101 answer, a manual clock, an in-memory storage,
 * HEAD with the REAL turn journal (turn-journal.mjs), the provider's REST answers, and a provider that signs its own
 * Speech Engine JWT with a test key. The Worker and the VoiceBridgeDO under test are the real code. No network.
 * The bridge object is made the first time the Worker reaches its binding (as Cloudflare makes it), so a test can see
 * that it never was. Fault hooks (tests of the review's items): `journalFault(body)` answers a HEAD journal call
 * instead of the real journal, `journalGate(body)` is awaited before one, `bridgeFault(request)` answers (or throws for)
 * a call to the bridge object. The page half's joint spec (apps/web/tests) uses this same file. `modelFetch`
 * (the provider's network for the fast path) makes HEAD answer its REAL provider budget and REAL provider dispatcher too;
 * `budgetFault(input)` answers a budget call instead. */
import assert from 'node:assert/strict'
import { createWorker } from '../worker.mjs'
import { VoiceBridgeDO } from '../voice-bridge-do.mjs'
import { forgetProviderNotes } from '../voice-bridge.mjs'
import { handleInternalTurnJournalRoute } from '../turn-journal.mjs'
import { SPEECH_ENGINE_ISSUER, SPEECH_ENGINE_SUBJECT } from '../voice-provider-speech-engine.mjs'
import { createProviderDispatcher } from '../provider-dispatch.mjs'
import { MEMORY_KEYS } from '../voice-memory.mjs'
import { MEMORY_DIGEST_KEY } from '../voice-bridge-do.mjs'
import { providerBudgetLimits, reserveProviderBudget } from '../provider-budget.mjs'

export const ORIGIN = 'https://voice.example.invalid'
export const SEED = 'a'.repeat(64)
export const AT = Date.UTC(2026, 10, 13, 12, 0, 0)
export const KEY = 'synthetic-eleven-account-key-for-tests'
export const SECRET = 'synthetic-bridge-secret-0123456789abcdef'
export const RESOURCE = 'seng_x61test'
export const OWNER = 'owner@example.invalid'
export const ACCESS = Object.freeze({ type: 'owner', email: OWNER, expires: AT / 1000 + 86400, session: 'synthetic-session-mac' })
export const TOKEN = 'T'.repeat(64)

// ── The Workers runtime pieces Node lacks ──────────────────────────────────────────────────────────────────────────
class FakeSocket {
  constructor() { this.listeners = { message: [], close: [], error: [] }; this.received = []; this.closedCode = null; this.peer = null; this.accepted = false }
  accept() { this.accepted = true }
  addEventListener(type, fn) { this.listeners[type]?.push(fn) }
  fire(type, event) { for (const fn of this.listeners[type]) fn(event) }
  send(data) {
    if (this.closedCode !== null) throw new Error('socket closed')
    this.peer.received.push(data)
    this.peer.fire('message', { data })
  }
  close(code = 1000) {
    if (this.closedCode !== null) return
    this.closedCode = code
    this.peer.closedCode ??= code
    queueMicrotask(() => { this.fire('close', { code }); this.peer.fire('close', { code }) })
  }
  /** Test side: the frames the edge sent, parsed. */
  frames() { return this.received.map(text => JSON.parse(text)) }
  json(value) { this.send(typeof value === 'string' ? value : JSON.stringify(value)) }
}

const BaseResponse = globalThis.Response
class WorkersResponse extends BaseResponse {
  constructor(body, init) {
    if (init?.status === 101) {
      super(null, { ...init, status: 200 })
      Object.defineProperty(this, 'status', { value: 101 })
      this.webSocket = init.webSocket
    } else super(body, init)
  }
}
globalThis.Response = WorkersResponse
globalThis.WebSocketPair = class {
  constructor() { const a = new FakeSocket(), b = new FakeSocket(); a.peer = b; b.peer = a; this[0] = a; this[1] = b }
}

// ── Clock, timers, storage ─────────────────────────────────────────────────────────────────────────────────────────
export function manualClock(start = AT) {
  const clock = { t: start, next: 0, queue: new Map() }
  clock.now = () => clock.t
  clock.timers = {
    set: (fn, ms) => { const id = ++clock.next; clock.queue.set(id, { at: clock.t + ms, fn }); return id },
    clear: id => { clock.queue.delete(id) },
  }
  clock.advance = ms => {
    const until = clock.t + ms
    for (;;) {
      const due = [...clock.queue].filter(([, item]) => item.at <= until).sort((a, b) => a[1].at - b[1].at)[0]
      if (!due) break
      clock.queue.delete(due[0])
      clock.t = due[1].at
      due[1].fn()
    }
    clock.t = until
  }
  return clock
}

export function memoryStorage() {
  const data = new Map()
  const view = {
    get: async key => (data.has(key) ? structuredClone(data.get(key)) : undefined),
    put: async (key, value) => { data.set(key, structuredClone(value)) },
    delete: async key => data.delete(key),
  }
  // The Durable Object alarm (the spoken history's sweep): its time is only recorded; a test runs alarm().
  let alarm = null
  return { data, ...view, transaction: async fn => fn(view), setAlarm: async at => { alarm = at }, getAlarm: async () => alarm, deleteAlarm: async () => { alarm = null }, alarmAt: () => alarm }
}

// ── The provider's JWT ─────────────────────────────────────────────────────────────────────────────────────────────
const b64url = bytes => Buffer.from(bytes).toString('base64url')
export async function signJwt(claims = {}, { key = KEY, header = { alg: 'HS256', typ: 'JWT' }, at = AT } = {}) {
  const body = { iss: SPEECH_ENGINE_ISSUER, sub: SPEECH_ENGINE_SUBJECT, iat: Math.floor(at / 1000), exp: Math.floor(at / 1000) + 300, ...claims }
  for (const [name, value] of Object.entries(body)) if (value === undefined) delete body[name]
  const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(body))}`
  const raw = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key))
  const hmac = await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return `${input}.${b64url(await crypto.subtle.sign('HMAC', hmac, new TextEncoder().encode(input)))}`
}

// ── The edge under test ────────────────────────────────────────────────────────────────────────────────────────────
export const settle = async bridge => {
  for (let index = 0; index < 12; index++) { await bridge.chain; await new Promise(resolve => setImmediate(resolve)) }
}

export function fixture(options = {}) {
  forgetProviderNotes() // each fixture stands for one fresh isolate (the provider-door throttle is per isolate)
  const clock = options.clock ?? manualClock()
  const calls = { provider: [], journal: [], bridge: [], head: [], model: [], budget: [] }
  const headStorage = memoryStorage()
  const env = {
    PUBLIC_HOST: new URL(ORIGIN).host, OWNER_EMAIL: OWNER, OWNER_PUBLIC_KEY_HEX: '11'.repeat(32),
    VOICE_MANAGED: '1', ELEVENLABS_API_KEY: KEY, ELEVENLABS_X61_VOICE_RESOURCE_ID: RESOURCE, ELEVENLABS_BRIDGE_SECRET: SECRET,
    // The early "mm-hm" / "hmm" ships OFF. The fixtures keep it ON so every test of that
    // machinery still runs; voice-bridge-cues.test.mjs proves the shipped setting says none.
    VOICE_EARLY_CUE: 'on',
    ...options.env,
  }
  for (const [name, value] of Object.entries(env)) if (value === undefined) delete env[name]
  const status = phase => Response.json({ ok: true, phase, seedId: SEED, ballId: 'b'.repeat(64), epoch: 170 })
  // With `modelFetch` (the fake provider network), HEAD also answers its REAL provider budget and its REAL
  // provider dispatcher (provider-dispatch.mjs, over the same journal storage), as the edge's own door uses them.
  const dispatcher = options.modelFetch ? createProviderDispatcher({ storage: headStorage, env, networkFetch: (url, init) => { calls.model.push({ url, init }); return options.modelFetch(url, init) } }) : null
  env.HEAD = { idFromName: name => { assert.equal(name, 'node-main-v1'); return name }, get: () => ({ fetch: async request => {
    const path = new URL(request.url).pathname
    calls.head.push(path)
    if (path === '/_head/bootstrap-status') return status('complete')
    if (dispatcher && path === '/_head/provider-budget') {
      assert.equal(request.headers.get('x-x6-internal-authorized'), '1')
      const input = await request.json()
      calls.budget.push(input)
      if (options.budgetGate) await options.budgetGate(input)
      if (options.budgetFault) { const fault = await options.budgetFault(input); if (fault) return fault }
      try { return Response.json(await reserveProviderBudget(headStorage, input, providerBudgetLimits(env), clock.now())) }
      catch (error) { return Response.json({ ok: false, code: error.code }, { status: error.status ?? 503 }) }
    }
    if (dispatcher && path === '/_head/provider-dispatch') {
      assert.equal(request.headers.get('x-x6-internal-authorized'), '1')
      assert.equal(request.headers.get('x-x6-bootstrap-seed'), SEED)
      return dispatcher.dispatch(request)
    }
    assert.equal(path, '/_head/turn-journal')
    assert.equal(request.headers.get('x-x6-internal-authorized'), '1')
    assert.equal(request.headers.get('x-x6-bootstrap-seed'), SEED)
    const body = await request.json()
    calls.journal.push(body)
    if (options.journalGate) await options.journalGate(body)
    if (options.journalDown) return Response.json({ ok: false, code: 'DOWN' }, { status: 503 })
    const fault = options.journalFault ? await options.journalFault(body) : undefined
    if (fault) return fault
    return handleInternalTurnJournalRoute(headStorage, 'POST', body, clock.now)
  } }) }
  env.MIRROR = { idFromName: () => 'mirror', get: () => ({ fetch: async () => status('ready') }) }
  // A second fixture may share one bridge storage (a new object instance over the same storage).
  const bridgeStorage = options.bridgeStorage ?? memoryStorage()
  let bridge = null
  const made = () => (bridge ??= new VoiceBridgeDO({ storage: bridgeStorage }, env, { now: clock.now, timers: clock.timers }))
  if (!options.noBinding) env.VOICE_BRIDGE = { idFromName: name => { assert.equal(name, 'x61-voice-bridge-v1'); return name }, get: () => ({ fetch: async request => {
    calls.bridge.push(new URL(request.url).pathname)
    const fault = options.bridgeFault ? await options.bridgeFault(request.clone()) : undefined
    if (fault) return fault
    return made().fetch(request)
  } }) }
  let minted = 0
  const networkFetch = async (url, init) => {
    calls.provider.push({ url, init })
    if (options.providerFetch) return options.providerFetch(url, init, calls.provider.length)
    const parsed = new URL(url)
    if (parsed.pathname.startsWith('/v1/speech-engine/') || parsed.pathname.startsWith('/v1/convai/agents/')) {
      const seconds = Object.hasOwn(options, 'duration') ? options.duration : 1200
      return Response.json(parsed.pathname.startsWith('/v1/convai/agents/') ? { conversation_config: { conversation: { max_duration_seconds: seconds } } } : { conversation: { max_duration_seconds: seconds } })
    }
    // The status read asks the provider for its account and its newest conversations. A fixture that does
    // not say otherwise (options.providerSide) answers 404, so every status read is the same in every test.
    if (parsed.pathname === '/v1/user/subscription' || parsed.pathname === '/v1/convai/conversations' || parsed.pathname.startsWith('/v1/convai/conversations/')) {
      return options.providerSide ? options.providerSide(parsed, init) : Response.json({ detail: 'not found' }, { status: 404 })
    }
    assert.equal(parsed.pathname, '/v1/convai/conversation/token')
    minted++
    return Response.json({ token: TOKEN, conversation_id: `conv_${String(minted)}` })
  }
  const access = Object.hasOwn(options, 'access') ? options.access : ACCESS
  const worker = createWorker({ verifyAccess: async () => access, networkFetch, now: clock.now })
  const send = request => worker.fetch(request, env)
  const ownerDoor = (extra = {}) => {
    const headers = new Headers({ origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' })
    for (const [name, value] of Object.entries(extra.headers ?? {})) value === null ? headers.delete(name) : headers.set(name, value)
    return send(new Request(ORIGIN + '/_host/voice', { method: 'POST', headers, body: extra.raw ?? JSON.stringify(extra.body ?? { action: 'managed_session' }) }))
  }
  const openTab = async (extra = {}) => {
    const headers = new Headers({ origin: ORIGIN, 'sec-fetch-site': 'same-origin', upgrade: 'websocket' })
    for (const [name, value] of Object.entries(extra.headers ?? {})) value === null ? headers.delete(name) : headers.set(name, value)
    return send(new Request(ORIGIN + (extra.path ?? '/_host/voice/bridge'), { method: extra.method ?? 'GET', headers }))
  }
  const openProvider = async (extra = {}) => {
    const headers = new Headers({ upgrade: 'websocket', 'x-elevenlabs-speech-engine-authorization': extra.jwt ?? await signJwt({}, { at: clock.now() }), 'x-aukora-voice-bridge': SECRET })
    for (const [name, value] of Object.entries(extra.headers ?? {})) value === null ? headers.delete(name) : headers.set(name, value)
    return send(new Request(ORIGIN + (extra.path ?? '/door/voice-brain'), { method: extra.method ?? 'GET', headers }))
  }
  /** A whole managed session: mint, tab hello (ready), provider init. */
  const connect = async () => {
    const minted = await ownerDoor()
    assert.equal(minted.status, 200)
    const answer = await minted.json()
    const conv = `conv_${String(calls.provider.filter(call => call.url.includes('/conversation/token')).length)}`
    const tabResponse = await openTab()
    assert.equal(tabResponse.status, 101)
    const tab = tabResponse.webSocket
    tab.json({ t: 'hello', conv })
    await settle(made())
    const providerResponse = await openProvider()
    assert.equal(providerResponse.status, 101)
    const provider = providerResponse.webSocket
    provider.json({ type: 'init', conversation_id: conv })
    await settle(made())
    return { conv, tab, provider, answer }
  }
  const rows = async () => [...headStorage.data].filter(([key]) => key.startsWith('head:turn-journal:row:')).map(([, value]) => value)
  /** Nothing left in the bridge: no conversation, no socket, no journal write waiting, and no timer on the clock. */
  const empty = () => ({ conversations: bridge?.convs.size ?? 0, sockets: bridge?.peers.size ?? 0, writes: bridge?.writes.size ?? 0, timers: clock.queue.size })
  return {
    clock, calls, env, bridgeStorage, headStorage, worker, send, ownerDoor, openTab, openProvider, connect, rows, empty,
    get bridge() { return made() },
    get bridgeBuilt() { return bridge !== null },
    settle: () => (bridge ? settle(bridge) : new Promise(resolve => setImmediate(resolve))),
  }
}

/** Her voice memory at the edge as the old spoken-history tests read it: each kept exchange's words (his,
 * hers), how it ended and its seq, oldest first; and the digest a cut turn left for the next turn (or null). */
export async function storedMemory(storage) {
  const tail = (await storage.get(MEMORY_KEYS.tail)) ?? []
  const digest = (await storage.get(MEMORY_DIGEST_KEY))?.digest ?? null
  return { exchanges: tail.map(item => ({ heard: item.words.heard, said: item.words.said, ended: item.record.ended, seq: item.record.seq })), digest }
}

export const transcript = (eventId, text, history = []) => ({ type: 'user_transcript', event_id: eventId, user_transcript: [...history, { role: 'user', content: text }] })
export const agentFrames = provider => provider.frames().filter(frame => frame.type === 'agent_response')

/** The same fixture, where he first speaks once the call has been open AWARE_FIRST_HELLO_MS (2.5 s), so the
 * first turn's bounded wait for the tab's first awareness frame (voice-bridge-do.mjs firstAwareness) is not taken. That
 * wait is proven on its own in voice-bridge-aware-store.test.mjs, with `fixture` as is. */
export const AFTER_HELLO_MS = 2500
export function fixtureAfterHello(options = {}) {
  const fx = fixture(options)
  const connect = fx.connect
  fx.connect = async () => { const call = await connect(); fx.clock.advance(AFTER_HELLO_MS); await fx.settle(); return call }
  return fx
}
