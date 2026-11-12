// @vitest-environment jsdom
/**
 * Round 29, Lane 4: The owner's whole path, page to edge, as Cloudflare builds the edge.
 *
 * The page's own code (the AUMLOK ceremony, and the Sovereignty surface with its Approve button) talks through `fetch`
 * to the real Worker (`createWorker`) and the real HEAD Durable Object constructed with TWO arguments
 * (`new X61HeadDurableObject(state, env)`, exactly as Cloudflare does), with an owner session cookie, in-memory
 * storage, and a software authenticator that signs real WebAuthn bytes (P-256) for this origin. Nothing on the host side
 * is stubbed: no third constructor argument, no enrollment header, no qualification callback.
 *
 * Run it from the repository root of a full `pnpm install` (the edge's aumlok.mjs imports `@simplewebauthn/server`, a
 * root dependency, and the root vitest config holds this package's test pattern):
 *   ./node_modules/.bin/vitest run packages/client/ui-layout/tests/r29-edge-e2e.client.spec.tsx
 * A copy of the tree without the root node_modules cannot load the edge, and no test runs (Round 35).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { createBrowserCeremony, readAumlokStatus } from '../src/client/spatial/aumlok/aumlok-ceremony.ts'
import { STAGED_PROMOTION_PATH } from '../src/client/spatial/aumlok/head-promotion.ts'
import { STAGED_OUTWARD_PATH, STAGED_OUTWARD_SCHEMA } from '../src/client/spatial/aumlok/outward-class3.ts'
import { SOVEREIGNTY_SURFACE, SovereigntySurface } from '../src/client/spatial/portal/SovereigntySurface.tsx'
import { resetApprovalsForTests, TAP_AGAIN } from '../src/client/spatial/portal/touch-id-timing.ts'
import type { FileRead, WorkReader } from '../src/client/spatial/work/WorkSurface.tsx'

/** The card's check is older than FRESH_CHECK_MS, so the click checks again first (Safari's fast path does not apply). */
const ageCards = (): void => { const real = Date.now.bind(Date); vi.spyOn(Date, 'now').mockImplementation(() => real() + 31_000) }


/** Open a portal card (approval cards now draw open: a click on an open one would close it). */
const openHead = (head: Element | null | undefined): void => { if (head instanceof HTMLButtonElement && head.getAttribute('aria-expanded') !== 'true') fireEvent.click(head) }


const EDGE = 'https://r29.example.invalid'
const EMAIL = 'owner@example.invalid'
const sha = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest()
const hex = (bytes: string | Uint8Array) => sha(bytes).toString('hex')
const publicHex = (key: { publicKey: KeyObject }) => key.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex')
const b64u = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url')
const ab = (bytes: Uint8Array): ArrayBuffer => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer

// ── The edge's modules, loaded from this checkout (deploy/cloudflare/src) ───────────────────────────────────────────────
const edgePath = (file: string) => ['', '../../../'].map(prefix => resolve(process.cwd(), `${prefix}deploy/cloudflare/src/${file}`)).find(existsSync)
type Loaded = Record<string, unknown>
const load = async (file: string): Promise<Loaded> => import(pathToFileURL(edgePath(file) ?? file).href) as Promise<Loaded>
const worker = await load('worker.mjs')
const headDo = await load('head-do.mjs')
const mirrorDo = await load('mirror-do.mjs')
type Fn = (...args: never[]) => unknown
const fn = <T extends Fn>(module: Loaded, name: string) => module[name] as T

/** A Durable Object's transactional storage in memory (the shape the edge tests use). */
function memoryStorage() {
  let rows = new Map<string, unknown>()
  let queue: Promise<unknown> = Promise.resolve()
  return {
    transaction(operation: (tx: unknown) => Promise<unknown>) {
      const run = queue.then(async () => {
        const next = structuredClone(rows)
        const result = await operation({
          get: async (key: string) => structuredClone(next.get(key)),
          put: async (key: string, value: unknown) => { next.set(key, structuredClone(value)) },
          delete: async (key: string) => next.delete(key),
          list: async ({ prefix = '', limit = Infinity }: { prefix?: string; limit?: number } = {}) =>
            new Map([...next].filter(([key]) => key.startsWith(prefix)).slice(0, limit)),
        })
        rows = next
        return result
      })
      queue = run.catch(() => undefined)
      return run
    },
  }
}

// ── A minimal CBOR writer (unsigned and negative ints, byte and text strings, maps): enough for WebAuthn ─────────────
type Cbor = number | string | Uint8Array | Map<Cbor, Cbor>
const head = (major: number, n: number): number[] => (n < 24 ? [major << 5 | n] : n < 256 ? [major << 5 | 24, n]
  : [major << 5 | 25, n >> 8, n & 255])
const cbor = (value: Cbor): number[] => {
  if (typeof value === 'number') return value >= 0 ? head(0, value) : head(1, -1 - value)
  if (typeof value === 'string') { const bytes = [...new TextEncoder().encode(value)]; return [...head(3, bytes.length), ...bytes] }
  if (value instanceof Uint8Array) return [...head(2, value.length), ...value]
  return [...head(5, value.size), ...[...value].flatMap(([k, v]) => [...cbor(k), ...cbor(v)])]
}

/** A platform authenticator for this origin: one P-256 credential, real attestation and assertion bytes, UV set. */
function softwareAuthenticator(rpId: string) {
  const key = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const jwk = key.publicKey.export({ format: 'jwk' }) as { x: string; y: string }
  const credentialId = new Uint8Array(randomBytes(32))
  let counter = 0
  const prompts: string[] = []
  /** Runs just before a passkey assertion is answered (a test can act in the middle of Touch ID). */
  const hooks: { beforeAssert: (() => Promise<void>) | null } = { beforeAssert: null }
  class Attestation {
    constructor(readonly clientDataJSON: ArrayBuffer, readonly attestationObject: ArrayBuffer) {}
    getTransports(): string[] { return ['internal'] }
  }
  class Assertion {
    constructor(readonly clientDataJSON: ArrayBuffer, readonly authenticatorData: ArrayBuffer, readonly signature: ArrayBuffer,
      readonly userHandle: ArrayBuffer | null) {}
  }
  class Credential {
    readonly type = 'public-key'
    readonly authenticatorAttachment = 'platform'
    readonly id: string
    constructor(readonly rawId: ArrayBuffer, readonly response: unknown) { this.id = b64u(new Uint8Array(rawId)) }
    getClientExtensionResults(): Record<string, unknown> { return {} }
  }
  const clientData = (type: string, challenge: BufferSource) => new TextEncoder().encode(JSON.stringify({ type,
    challenge: b64u(new Uint8Array(challenge instanceof ArrayBuffer ? challenge : challenge.buffer)), origin: location.origin,
    crossOrigin: false }))
  vi.stubGlobal('PublicKeyCredential', Credential)
  vi.stubGlobal('AuthenticatorAttestationResponse', Attestation)
  vi.stubGlobal('AuthenticatorAssertionResponse', Assertion)
  Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true })
  Object.defineProperty(navigator, 'credentials', { configurable: true, value: {
    create: async ({ publicKey }: { publicKey: PublicKeyCredentialCreationOptions }) => {
      prompts.push('register')
      const data = clientData('webauthn.create', publicKey.challenge)
      const cose = new Uint8Array(cbor(new Map<Cbor, Cbor>([[1, 2], [3, -7], [-1, 1],
        [-2, new Uint8Array(Buffer.from(jwk.x, 'base64url'))], [-3, new Uint8Array(Buffer.from(jwk.y, 'base64url'))]])))
      const auth = Buffer.concat([sha(rpId), Buffer.from([0x45]), Buffer.alloc(4), Buffer.alloc(16), Buffer.from([0, credentialId.length]),
        Buffer.from(credentialId), Buffer.from(cose)])
      const object = new Uint8Array(cbor(new Map<Cbor, Cbor>([['fmt', 'none'], ['attStmt', new Map()], ['authData', new Uint8Array(auth)]])))
      return new Credential(ab(credentialId), new Attestation(ab(data), ab(object)))
    },
    get: async ({ publicKey }: { publicKey: PublicKeyCredentialRequestOptions }) => {
      prompts.push('assert')
      if (hooks.beforeAssert !== null) { const hook = hooks.beforeAssert; hooks.beforeAssert = null; await hook() }
      const data = clientData('webauthn.get', publicKey.challenge)
      counter += 1
      const count = Buffer.alloc(4)
      count.writeUInt32BE(counter)
      const auth = Buffer.concat([sha(rpId), Buffer.from([0x05]), count])
      const signature = sign('sha256', Buffer.concat([auth, sha(data)]), key.privateKey)
      return new Credential(ab(credentialId), new Assertion(ab(data), ab(new Uint8Array(auth)), ab(new Uint8Array(signature)), null))
    },
  } })
  return { prompts, hooks }
}

/** The organ bytes and a manifest in HEAD's own shape, its id from HEAD's own `manifestId`. */
const codeOf = (organ: string, version: number) => `export default { organ: ${JSON.stringify(organ)}, version: ${String(version)} }\n`
const entryOf = (id: string, code: string) => ({ id, specifier: `ball:${hex(code)}`, config: {}, disabled: false, previousSpecifiers: [] as string[] })
async function ballOf(parentBallId: string | null, epoch: number, codes: Record<string, string>, authorPeerId?: string, canonical = false,
  tweak?: (entries: Record<string, Record<string, unknown>>) => void) {
  const entries: Record<string, Record<string, unknown>> = Object.fromEntries(Object.entries(codes)
    .map(([id, code]) => [id, entryOf(id, code)]))
  tweak?.(entries)
  const ball: Record<string, unknown> = { version: 'x6.1-ball/v1', parentBallId, epoch, ...(authorPeerId === undefined ? {} : { authorPeerId }),
    entries, modules: Object.fromEntries(Object.values(codes).map(code => [hex(code), { sha256: hex(code), specifier: `ball:${hex(code)}` }])) }
  ball.ballId = await fn<(ball: unknown) => Promise<string>>(headDo, canonical ? 'manifestIdCanon' : 'manifestId')(ball)
  return ball as Record<string, unknown> & { ballId: string; epoch: number }
}

/** The edge, built as Cloudflare builds it, bootstrapped at Pearl 162 with a governance organ (seed-receipts). */
interface EdgeOptions {
  canonical?: boolean
  sibling?: boolean
  networkFetch?: typeof fetch
  extraEnv?: Record<string, unknown>
}
async function edge({ canonical = true, sibling = false, networkFetch, extraEnv = {} }: EdgeOptions = {}) {
  const owner = generateKeyPairSync('ed25519')
  const storage = memoryStorage()
  const env: Record<string, unknown> = {
    PUBLIC_HOST: new URL(EDGE).host, OWNER_EMAIL: EMAIL, OWNER_PUBLIC_KEY_HEX: publicHex(owner), ...extraEnv,
  }
  const HeadClass = headDo.X61HeadDurableObject as new (state: unknown, env: unknown) => { fetch: (request: Request) => Promise<Response> }
  const MirrorClass = mirrorDo.MirrorDO as new (state: unknown) => { fetch: (request: Request) => Promise<Response> }
  // TWO ARGUMENTS, as Cloudflare constructs it (wrangler.toml class_name = "X61HeadDurableObject").
  const headObject = new HeadClass({ storage, getWebSockets: () => [] }, env)
  env.HEAD = { idFromName: (name: string) => name, get: () => ({ fetch: (request: Request) => headObject.fetch(request) }) }
  const mirrorStorage = memoryStorage()
  const mirror = new MirrorClass({ storage: mirrorStorage })
  env.MIRROR = { idFromName: (name: string) => name, get: () => ({ fetch: (request: Request) => mirror.fetch(request) }) }
  const app = fn<(options?: { networkFetch?: typeof fetch }) => { fetch: (request: Request, env: unknown) => Promise<Response> }>(worker,
    'createWorker')(networkFetch === undefined ? undefined : { networkFetch })
  const seconds = Math.floor(Date.now() / 1000)
  const jwt = [Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' })).toString('base64url'),
    Buffer.from(JSON.stringify({ iss: 'aukora.x61.owner', aud: env.PUBLIC_HOST, email: EMAIL, nbf: seconds - 1, exp: seconds + 3600 })).toString('base64url')]
  jwt.push(sign(null, Buffer.from(jwt.join('.')), owner.privateKey).toString('base64url'))
  const v62: Record<string, string> = { 'seed-receipts': codeOf('seed-receipts', 162), 'auma-notes': codeOf('auma-notes', 1),
    // With `sibling`: a second governance organ, so a change to it outside the classified fields can be staged.
    ...(sibling ? { 'seed-aura': codeOf('seed-aura', 162) } : {}) }
  const genesis = await ballOf(null, 162, v62)
  const seed = await fn<(input: unknown) => Promise<{ seedId: string; mirror: unknown }>>(headDo, 'bootstrapPackage')({
    version: 'x61-bootstrap/v1', ball: genesis, codeBySha: Object.fromEntries(Object.values(v62).map(code => [hex(code), code])),
    mirror: { entryCount: 0, batchDigests: [] } })
  const bootstrapMirror = fn<(storage: unknown, input: unknown) => Promise<unknown>>(mirrorDo, 'bootstrapMirror')
  await bootstrapMirror(mirrorStorage, { action: 'begin', seedId: seed.seedId, ballId: genesis.ballId, epoch: genesis.epoch, mirror: seed.mirror })
  await bootstrapMirror(mirrorStorage, { action: 'commit', seedId: seed.seedId })
  type Bootstrap = {
    bootstrapPrepare: (s: unknown) => Promise<unknown>
    bootstrapCommit: (id: string, r: unknown) => Promise<{ ok: boolean }>
  }
  const store = (headObject as unknown as { store: Bootstrap }).store
  await store.bootstrapPrepare(seed)
  expect((await store.bootstrapCommit(seed.seedId, { ok: true, phase: 'ready', seedId: seed.seedId, ballId: genesis.ballId, epoch: genesis.epoch,
    entryCount: 0, nextBatch: 0, batchCount: 0 })).ok).toBe(true)
  // Epoch 163 as Auma stages it: seed-receipts changes (a governance organ, so Class 3), authored under her writer peer.
  const v63 = { ...v62, 'seed-receipts': codeOf('seed-receipts', 163) }
  // Round 29: a passkey-only governance Pearl lands only under its canonical manifest id (head-do.mjs manifestIdCanon).
  const next = await ballOf(genesis.ballId, 163, v63, 'auma-writer', canonical, sibling ? (entries) => {
    // A governance sibling changed only in a field the transition is not classified by (its history list), and validly
    // (the specifier it lists is a module of this Pearl), so nothing but HEAD's sibling rule stands in the way.
    const aura = entries['seed-aura']
    if (aura !== undefined) aura.previousSpecifiers = [aura.specifier]
  } : undefined)
  const stagedWith = (generation: number) => JSON.stringify({ schema: 'aukora.staged-head-promotion.v1', stagedAt: Date.now() - 60_000, body: {
    ball: next, codeBySha: { [hex(v63['seed-receipts'] ?? '')]: v63['seed-receipts'] }, expectedParentBallId: genesis.ballId, expectedEpoch: 162,
    writerLease: { ownerPeerId: 'auma-writer', generation } } })
  const staged = stagedWith(1)
  // Another Epoch 163 Auma might stage instead: the same organ, other code.
  const v63b = { ...v62, 'seed-receipts': codeOf('seed-receipts', 6300) }
  const other = await ballOf(genesis.ballId, 163, v63b, 'auma-writer', canonical)
  const stagedOther = JSON.stringify({ schema: 'aukora.staged-head-promotion.v1', stagedAt: Date.now(), body: {
    ball: other, codeBySha: { [hex(v63b['seed-receipts'] ?? '')]: v63b['seed-receipts'] }, expectedParentBallId: genesis.ballId, expectedEpoch: 162,
    writerLease: { ownerPeerId: 'auma-writer', generation: 1 } } })
  // Every page fetch goes to the Worker with the browser's same-origin headers and the owner's session cookie.
  const calls: string[] = []
  const sent: Array<{ readonly method: string; readonly path: string; readonly body: Record<string, unknown> | null }> = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (!url.startsWith('/')) throw new Error(`the page reached outside its origin: ${url}`)
    calls.push(`${init?.method ?? 'GET'} ${url.split('?')[0] ?? url}`)
    sent.push({ method: init?.method ?? 'GET', path: url.split('?')[0] ?? url,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : null })
    const headers = new Headers(init?.headers)
    headers.set('cookie', `CF_Authorization=${jwt.join('.')}`)
    headers.set('origin', EDGE)
    headers.set('sec-fetch-site', 'same-origin')
    return app.fetch(new Request(EDGE + url, { method: init?.method ?? 'GET', headers, body: init?.body ?? null }), env)
  }))
  const headNow = async () => ((await (await fetch('/_head/ball')).json()) as { head?: { ballId?: string; epoch?: number } }).head
  // Epoch 164 as Auma stages it once 163 is HEAD: seed-receipts again, chained from 163, the only change.
  const v64 = { ...v63, 'seed-receipts': codeOf('seed-receipts', 164) }
  const after = await ballOf(next.ballId, 164, v64, 'auma-writer', canonical)
  const stagedAfter = JSON.stringify({ schema: 'aukora.staged-head-promotion.v1', stagedAt: Date.now(), body: {
    ball: after, codeBySha: { [hex(v64['seed-receipts'] ?? '')]: v64['seed-receipts'] }, expectedParentBallId: next.ballId, expectedEpoch: 163,
    writerLease: { ownerPeerId: 'auma-writer', generation: 1 } } })
  return { genesis, next, after, staged, stagedWith, stagedOther, stagedAfter, calls, sent, headNow }
}

const stagedReads = { count: 0 }
/** One staged read a test holds open until it says what that read returns. */
const heldRead: { next: Promise<string> | null } = { next: null }
const mountSovereignty = (staged: string | (() => string), outward?: string) => {
  stagedReads.count = 0
  heldRead.next = null
  const list = { ids: ['s1' as SessionId], byId: { ['s1' as SessionId]: { id: 's1' as SessionId, displayTitle: 'Test', running: false,
    retainedBy: { mainView: 1 }, blank: false, updatedAt: 1 } }, phase: 'ready', projectionsBySession: {} } as unknown as SessionListState
  const props = {
    activeSurface: SOVEREIGNTY_SURFACE,
    useSessions: bindSnapshotSelector(createSnapshotStore<SessionListState>(list)),
    reader: { whole: async (_session: unknown, path: string): Promise<FileRead> => {
      if (path === STAGED_OUTWARD_PATH && outward !== undefined) return { ok: true, text: outward }
      if (path !== STAGED_PROMOTION_PATH) return { ok: false, reason: 'not-found' }
      stagedReads.count += 1
      if (heldRead.next !== null) { const held = heldRead.next; heldRead.next = null; return { ok: true, text: await held } }
      return { ok: true, text: typeof staged === 'string' ? staged : staged() }
    } },
  } as unknown as Parameters<typeof SovereigntySurface>[0]
  return render(<SovereigntySurface {...props} />)
}

class FakeChannel { onmessage = null; close() {} }
class FakeSocket {
  static open: FakeSocket[] = []
  onopen = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose = null
  closed = false
  constructor() { FakeSocket.open.push(this) }
  close() { this.closed = true }
}
/** A live message from the host, as its socket pushes it. */
const push = (message: unknown) => {
  for (const socket of FakeSocket.open.filter(s => !s.closed)) socket.onmessage?.({ data: JSON.stringify(message) })
}
/** The owner's first bind, through the page's own ceremony (see the first test for every step). */
const bindOwner = async () => {
  const signal = new AbortController().signal
  const read = await readAumlokStatus(signal)
  const ceremony = createBrowserCeremony()
  const drawn = await ceremony.draw('bind', read.kind === 'live' ? read.status : null)
  if (!drawn.ok || drawn.words === undefined) throw new Error(`draw: ${drawn.reason ?? 'no words'}`)
  expect(await ceremony.submit('bind', drawn.words)).toMatchObject({ ok: true })
}
/** The staged card, opened as the owner opens it. */
const openCard = async (container: HTMLElement, words: string) => {
  const card = () => container.querySelector('[data-sovereignty-portal="promotion"]')
  await waitFor(() => { expect(card()?.textContent).toContain(words) }, { timeout: 20_000 })
  openHead(card()?.querySelector('button.ak-portal__head'))
  return card
}
beforeEach(() => {
  ;(globalThis as { jsdom?: { reconfigure: (o: { url: string }) => void } }).jsdom?.reconfigure({ url: `${EDGE}/` })
  vi.stubGlobal('BroadcastChannel', FakeChannel)
  vi.stubGlobal('WebSocket', FakeSocket)
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); resetApprovalsForTests() })

describe('Round 29: The owner\'s path on the edge as Cloudflare builds it (page code end to end)', () => {
  it('first bind in the browser, then Approve on Sovereignty lands the staged Class 3 Pearl', async () => {
    expect(location.origin).toBe(EDGE)
    const { genesis, next, staged, calls, sent, headNow } = await edge()
    const authenticator = softwareAuthenticator(new URL(EDGE).hostname)
    const signal = new AbortController().signal

    // 1. AUMLOK: the host says a first bind is open; the page draws seven words, Touch ID registers then asserts.
    const before = await readAumlokStatus(signal)
    expect(before.kind).toBe('live')
    const unbound = before.kind === 'live' ? before.status : null
    expect([unbound?.state, unbound?.enrollmentAvailable, unbound?.blockers]).toEqual(['unbound', true, []])
    const ceremony = createBrowserCeremony()
    const drawn = await ceremony.draw('bind', unbound)
    if (!drawn.ok || drawn.words === undefined) throw new Error(`draw: ${drawn.reason ?? 'no words'}`)
    expect(drawn.words).toHaveLength(7)
    const bound = await ceremony.submit('bind', drawn.words)
    expect(bound).toMatchObject({ ok: true })
    expect(authenticator.prompts).toEqual(['register', 'assert'])
    const after = await readAumlokStatus(signal)
    expect(after.kind === 'live' ? [after.status.state, after.status.passkeyVerified, after.status.enrollmentAvailable] : after)
      .toEqual(['bound', true, false])
    // A second first-bind is refused: the owner is set once.
    const again = createBrowserCeremony()
    expect(await again.draw('bind', after.kind === 'live' ? after.status : null)).toMatchObject({ ok: false, reason: 'aumlok:already-bound' })

    // 2. Sovereignty: HEAD says a governance Pearl can land; the staged Epoch 163 card offers Approve.
    const lease = await (await fetch('/_head/lease')).json() as { governancePromotion?: boolean; governancePromotionBlocker?: string }
    expect([lease.governancePromotion, lease.governancePromotionBlocker]).toEqual([true, undefined])
    const { container } = mountSovereignty(staged)
    const card = () => container.querySelector('[data-sovereignty-portal="promotion"]')
    await waitFor(() => { expect(card()?.textContent).toContain('HEAD could take it: waits for your passkey') }, { timeout: 20_000 })
    openHead(card()?.querySelector('button.ak-portal__head'))
    const approve = () => container.querySelector<HTMLButtonElement>('[data-sovereignty-promote]')
    await waitFor(() => { expect(approve()?.disabled).toBe(false) }, { timeout: 20_000 })
    expect(approve()?.textContent).toContain('seed-receipts')

    // 3. Touch ID approves the exact terms; the page takes a fresh lease and sends the staged Pearl; HEAD commits it.
    fireEvent.click(approve() as HTMLButtonElement)
    await waitFor(() => {
      expect(container.querySelector('[data-sovereignty-promotion-outcome]')?.getAttribute('data-sovereignty-promotion-outcome')).toBe('ok')
    }, { timeout: 20_000 })
    expect(authenticator.prompts).toEqual(['register', 'assert', 'assert'])
    expect(await headNow()).toMatchObject({ ballId: next.ballId, epoch: 163 })
    expect(next.parentBallId).toBe(genesis.ballId)
    expect(calls).toEqual(expect.arrayContaining(['POST /_host/aumlok/approve', 'POST /_head/lease', 'POST /_head/ball']))
    // Round 30: the lease is taken in the name Auma staged as the Pearl's author (HEAD requires ball.authorPeerId to hold
    // it), never a name the page makes up; and the Pearl goes out byte for byte, so its canonical id still binds that author.
    expect(next.authorPeerId).toBe('auma-writer')
    const acquire = sent.find(call => call.method === 'POST' && call.path === '/_head/lease' && call.body?.action === 'acquire')
    expect(acquire?.body?.ownerPeerId).toBe(next.authorPeerId)
    const publish = sent.find(call => call.method === 'POST' && call.path === '/_head/ball')
    expect((publish?.body?.writerLease as { ownerPeerId?: string } | undefined)?.ownerPeerId).toBe(next.authorPeerId)
    expect(publish?.body?.ball).toEqual(next)
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  }, 60_000)

  it('a Pearl staged under the older manifest id is stopped on the card, before any passkey is asked for', async () => {
    const { staged, genesis, headNow } = await edge({ canonical: false })
    const authenticator = softwareAuthenticator(new URL(EDGE).hostname)
    const { container } = mountSovereignty(staged)
    const card = () => container.querySelector('[data-sovereignty-portal="promotion"]')
    await waitFor(() => { expect(card()?.textContent).toContain('CANNOT LAND') }, { timeout: 20_000 })
    openHead(card()?.querySelector('button.ak-portal__head'))
    expect(card()?.textContent).toContain('CLASS3_CANONICAL_MANIFEST_REQUIRED')
    expect(container.querySelector('[data-sovereignty-promote]')).toBeNull()
    expect(authenticator.prompts).toEqual([])
    expect(await headNow()).toMatchObject({ ballId: genesis.ballId, epoch: 162 })
  }, 60_000)

  it('without the passkey approval, or with the approval spent, HEAD keeps Pearl 162', async () => {
    const { genesis, next, headNow } = await edge()
    // A publish with no approval, and with a made-up one, under a fresh lease the page would take.
    const lease = await (await fetch('/_head/lease', { method: 'POST', body: JSON.stringify({ action: 'acquire', ownerPeerId: 'auma-writer', ttlMs: 30_000 }) })).json() as
      { lease?: { generation?: number } }
    const body = { ball: next, codeBySha: {}, expectedParentBallId: genesis.ballId, expectedEpoch: 162,
      writerLease: { ownerPeerId: 'auma-writer', generation: lease.lease?.generation } }
    const none = await fetch('/_head/ball', { method: 'POST', body: JSON.stringify(body) })
    const forged = await fetch('/_head/ball', { method: 'POST', headers: { 'x-x6-class3-approval': b64u(new Uint8Array(32)) }, body: JSON.stringify(body) })
    expect([none.status, forged.status].every(status => status >= 400)).toBe(true)
    // A lease held under any other name than the Pearl's author is not its writer lease (HEAD: WRITER_LEASE_REQUIRED).
    await fetch('/_head/lease', { method: 'POST', body: JSON.stringify({ action: 'release', ownerPeerId: 'auma-writer', generation: lease.lease?.generation }) })
    const other = await (await fetch('/_head/lease', { method: 'POST', body: JSON.stringify({ action: 'acquire', ownerPeerId: 'browser-tab', ttlMs: 30_000 }) })).json() as
      { lease?: { generation?: number } }
    const elsewhere = await fetch('/_head/ball', { method: 'POST', headers: { 'x-x6-class3-approval': b64u(new Uint8Array(32)) },
      body: JSON.stringify({ ...body, writerLease: { ownerPeerId: 'browser-tab', generation: other.lease?.generation } }) })
    expect([elsewhere.status, ((await elsewhere.json()) as { code?: string }).code]).toEqual([423, 'WRITER_LEASE_REQUIRED'])
    expect(await headNow()).toMatchObject({ ballId: genesis.ballId, epoch: 162 })
  }, 60_000)

  it('Round 31: a governance sibling changed in any field stops the card before Touch ID, as HEAD would refuse it', async () => {
    const { headNow, genesis, staged } = await edge({ sibling: true })
    const authenticator = softwareAuthenticator(new URL(EDGE).hostname)
    await bindOwner()
    const { container } = mountSovereignty(staged)
    const card = await openCard(container, 'CANNOT LAND')
    expect(card()?.textContent).toContain('it also changes seed-aura')
    expect(card()?.textContent).not.toContain('not one HEAD accepts')
    expect(container.querySelector('[data-sovereignty-promote]')).toBeNull()
    expect(authenticator.prompts).toEqual(['register', 'assert'])
    expect(await headNow()).toMatchObject({ ballId: genesis.ballId, epoch: 162 })
  }, 60_000)

  it('Round 31: a staged file that changed after the card read it is never approved; no passkey is asked', async () => {
    const { headNow, genesis, staged, stagedOther } = await edge()
    const authenticator = softwareAuthenticator(new URL(EDGE).hostname)
    await bindOwner()
    let onDisk = staged
    const { container } = mountSovereignty(() => onDisk)
    await openCard(container, 'HEAD could take it: waits for your passkey')
    const approve = () => container.querySelector<HTMLButtonElement>('[data-sovereignty-promote]')
    await waitFor(() => { expect(approve()?.disabled).toBe(false) }, { timeout: 20_000 })
    // Auma stages another Pearl while the card is open, and the owner then clicks Approve on the old card.
    onDisk = stagedOther
    ageCards()
    fireEvent.click(approve() as HTMLButtonElement)
    await waitFor(() => {
      expect(container.querySelector('[data-sovereignty-promotion-outcome]')?.textContent).toContain('has changed since this card read it')
    }, { timeout: 20_000 })
    expect(authenticator.prompts).toEqual(['register', 'assert'])
    expect(await headNow()).toMatchObject({ ballId: genesis.ballId, epoch: 162 })
  }, 60_000)

  it('Round 31: a live change to her staged file or a commit on HEAD reads the card again; an unrelated change does not', async () => {
    const { staged } = await edge()
    const { container } = mountSovereignty(staged)
    const card = await openCard(container, 'Staged governance Pearl')
    const open = () => card()?.querySelector('button.ak-portal__head')?.getAttribute('aria-expanded')
    expect(open()).toBe('true')
    await waitFor(() => { expect(FakeSocket.open.filter(s => !s.closed).length).toBeGreaterThan(0) })
    const before = stagedReads.count
    push({ type: 'mirror:updated', changedPaths: ['home/auma/memory/dag/HEAD.json'] })
    await new Promise(r => setTimeout(r, 800))
    expect(stagedReads.count).toBe(before)
    push({ type: 'mirror:updated', changedPaths: ['home/auma/staged/head-promotion.json'] })
    await waitFor(() => { expect(stagedReads.count).toBeGreaterThan(before) }, { timeout: 5_000 })
    // The card the owner has open stays open through the re-read (Round 31 review): it never flashes away and back closed.
    await new Promise(r => setTimeout(r, 300))
    expect(open()).toBe('true')
    const after = stagedReads.count
    push({ type: 'ball:commit' })
    await waitFor(() => { expect(stagedReads.count).toBeGreaterThan(after) }, { timeout: 5_000 })
    expect(open()).toBe('true')
  }, 60_000)

  it('Round 34: Epoch 163 lands, Auma stages 164 in its place, and the same card offers 164 for a second Touch ID without a reload', async () => {
    const { next, after, staged, stagedAfter, headNow } = await edge()
    const authenticator = softwareAuthenticator(new URL(EDGE).hostname)
    await bindOwner()
    let onDisk = staged
    const { container } = mountSovereignty(() => onDisk)
    await waitFor(() => { expect(FakeSocket.open.filter(s => !s.closed).length).toBeGreaterThan(0) })
    const approve = () => container.querySelector<HTMLButtonElement>('[data-sovereignty-promote]')
    const outcome = () => container.querySelector('[data-sovereignty-promotion-outcome]')
    // Epoch 163: The owner opens the card and approves with Touch ID; HEAD takes it.
    await openCard(container, 'HEAD could take it: waits for your passkey')
    await waitFor(() => { expect(approve()?.disabled).toBe(false) }, { timeout: 20_000 })
    expect(approve()?.textContent).toContain(next.ballId === undefined ? '' : 'seed-receipts')
    fireEvent.click(approve() as HTMLButtonElement)
    await waitFor(() => { expect(outcome()?.getAttribute('data-sovereignty-promotion-outcome')).toBe('ok') }, { timeout: 20_000 })
    expect(await headNow()).toMatchObject({ ballId: next.ballId, epoch: 163 })
    // Auma moves her Epoch 164 file into the launchpad; the host pushes the change. No reload, no Refresh.
    onDisk = stagedAfter
    push({ type: 'mirror:updated', changedPaths: ['/dsh/home/auma/staged/head-promotion.json'] })
    const card = () => container.querySelector('[data-sovereignty-portal="promotion"]')
    await waitFor(() => { expect(card()?.textContent).toContain('epoch 164') }, { timeout: 20_000 })
    await waitFor(() => { expect(card()?.textContent).toContain('HEAD could take it: waits for your passkey') }, { timeout: 20_000 })
    openHead(card()?.querySelector('button.ak-portal__head'))
    await waitFor(() => { expect(approve()?.disabled).toBe(false) }, { timeout: 20_000 })
    fireEvent.click(approve() as HTMLButtonElement)
    await waitFor(() => {
      expect(outcome()?.getAttribute('data-sovereignty-promotion-outcome')).toBe('ok')
      expect(outcome()?.textContent).toContain('epoch 164')
    }, { timeout: 20_000 })
    expect(await headNow()).toMatchObject({ ballId: after.ballId, epoch: 164 })
    // Bind (register + assert), then one Touch ID per Pearl.
    expect(authenticator.prompts).toEqual(['register', 'assert', 'assert', 'assert'])
  }, 90_000)

  it('Round 34: a card open in another tab follows HEAD on its own: after 163 lands elsewhere it offers 164, no Refresh', async () => {
    const { next, staged, stagedAfter } = await edge()
    softwareAuthenticator(new URL(EDGE).hostname)
    await bindOwner()
    let onDisk = staged
    // Two Sovereignty views of the same body (two tabs): A approves, B only watches.
    const a = mountSovereignty(() => onDisk)
    const b = mountSovereignty(() => onDisk)
    await waitFor(() => { expect(FakeSocket.open.filter(s => !s.closed).length).toBeGreaterThan(0) })
    const cardB = () => b.container.querySelector('[data-sovereignty-portal="promotion"]')
    await waitFor(() => { expect(cardB()?.textContent).toContain('HEAD could take it: waits for your passkey') }, { timeout: 20_000 })
    await openCard(a.container, 'HEAD could take it: waits for your passkey')
    const approveA = () => a.container.querySelector<HTMLButtonElement>('[data-sovereignty-promote]')
    await waitFor(() => { expect(approveA()?.disabled).toBe(false) }, { timeout: 20_000 })
    fireEvent.click(approveA() as HTMLButtonElement)
    await waitFor(() => {
      expect(a.container.querySelector('[data-sovereignty-promotion-outcome]')?.getAttribute('data-sovereignty-promotion-outcome')).toBe('ok')
    }, { timeout: 20_000 })
    expect(next.epoch).toBe(163)
    // The host pushes the commit, then Auma's file swap. Tab B is never refreshed.
    push({ type: 'ball:commit' })
    onDisk = stagedAfter
    push({ type: 'mirror:updated', changedPaths: ['/dsh/home/auma/staged/head-promotion.json'] })
    await waitFor(() => {
      expect(cardB()?.textContent).toContain('epoch 164')
      expect(cardB()?.textContent).toContain('HEAD could take it: waits for your passkey')
    }, { timeout: 20_000 })
    expect(cardB()?.textContent).not.toContain('REBASE_REQUIRED')
  }, 90_000)

  it('Round 35: a card read that settles during Touch ID never replaces the card mid-approval; the approved Pearl lands', async () => {
    const { next, staged, stagedOther, headNow } = await edge()
    const authenticator = softwareAuthenticator(new URL(EDGE).hostname)
    await bindOwner()
    const { container } = mountSovereignty(staged)
    await waitFor(() => { expect(FakeSocket.open.filter(s => !s.closed).length).toBeGreaterThan(0) })
    await openCard(container, 'HEAD could take it: waits for your passkey')
    const approve = () => container.querySelector<HTMLButtonElement>('[data-sovereignty-promote]')
    await waitFor(() => { expect(approve()?.disabled).toBe(false) }, { timeout: 20_000 })
    const shown = approve()?.textContent ?? ''
    // A live change starts a quiet re-read of the card, and this test holds that read open.
    let release: (text: string) => void = () => {}
    heldRead.next = new Promise<string>((resolve) => { release = resolve })
    const before = stagedReads.count
    push({ type: 'mirror:updated', changedPaths: ['/dsh/home/auma/staged/head-promotion.json'] })
    await waitFor(() => { expect(stagedReads.count).toBeGreaterThan(before) }, { timeout: 5_000 })
    // In the middle of Touch ID the held read settles with another Pearl: the card the owner is approving must not change.
    let midApproval = ''
    authenticator.hooks.beforeAssert = async () => {
      release(stagedOther)
      await new Promise(r => setTimeout(r, 200))
      midApproval = approve()?.textContent ?? ''
    }
    fireEvent.click(approve() as HTMLButtonElement)
    await waitFor(() => {
      expect(container.querySelector('[data-sovereignty-promotion-outcome]')?.getAttribute('data-sovereignty-promotion-outcome')).toBe('ok')
    }, { timeout: 20_000 })
    expect(midApproval).toBe(shown)
    expect(await headNow()).toMatchObject({ ballId: next.ballId, epoch: 163 })
  }, 90_000)
})

describe('Round 36: Auma\'s outward request, approved by Touch ID in Sovereignty and sent by the page (page code end to end)', () => {
  it('her staged GitHub issue shows word for word; one passkey approval sends exactly those bytes, once', async () => {
    const posted: Array<{ readonly url: string; readonly method: string; readonly body: unknown }> = []
    const networkFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      posted.push({ url, method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? JSON.parse(init.body) : null })
      const sent = (typeof init?.body === 'string' ? JSON.parse(init.body) : {}) as { title?: string; body?: string }
      return Response.json({ id: 9001, number: 42, state: 'open', title: sent.title, body: sent.body,
        html_url: 'https://github.com/your_org_x/your-node/issues/42' }, { status: 201 })
    }) as typeof fetch
    const { staged } = await edge({ networkFetch, extraEnv: { GITHUB_TOKEN: 'test-github-token' } })
    const authenticator = softwareAuthenticator(new URL(EDGE).hostname)
    await bindOwner()
    const args = { action: 'api', method: 'POST', endpoint: 'repos/your_org_x/your-node/issues',
      body: { title: 'Trial worker after a deploy', body: 'Seen at epoch 164: the trial worker URL is gone after a deploy.' } }

    // What Auma's worker gets today: the edge will not post it without the passkey, and nothing reaches GitHub.
    const refused = await fetch('/_host/github', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(args) })
    expect(refused.status).toBe(403)
    expect(await refused.json()).toMatchObject({ ok: false, code: 'CLASS3_WEBAUTHN_REQUIRED' })
    expect(posted).toEqual([])

    // Her worker stages it; Sovereignty shows it as it will go out.
    const outward = JSON.stringify({ schema: STAGED_OUTWARD_SCHEMA, stagedAt: Date.now(), tool: 'x6_github', method: 'POST',
      pathname: '/_host/github', body: args })
    const { container } = mountSovereignty(staged, outward)
    const card = () => container.querySelector('[data-sovereignty-portal="outward"]')
    await waitFor(() => { expect(card()?.textContent).toContain('GitHub: a new issue in your_org_x/your-node') }, { timeout: 20_000 })
    openHead(card()?.querySelector('button.ak-portal__head'))
    const field = (name: string) => card()?.querySelector(`[data-outward-field="${name}"]`)?.textContent
    await waitFor(() => { expect(field('title')).toBe('Trial worker after a deploy') })
    expect(field('text')).toBe('Seen at epoch 164: the trial worker URL is gone after a deploy.')
    const approve = () => card()?.querySelector<HTMLButtonElement>('[data-outward-approve]') ?? null
    await waitFor(() => { expect(approve()?.disabled).toBe(false) }, { timeout: 20_000 })

    // Touch ID approves the exact request; the page sends it; the edge checks the bytes and posts exactly them.
    const prompts = authenticator.prompts.length
    fireEvent.click(approve() as HTMLButtonElement)
    const outcome = () => card()?.querySelector('[data-outward-outcome]')
    await waitFor(() => { expect(outcome()?.getAttribute('data-outward-outcome')).toBe('sent') }, { timeout: 20_000 })
    expect(outcome()?.textContent).toContain('https://github.com/your_org_x/your-node/issues/42')
    expect(authenticator.prompts.slice(prompts)).toEqual(['assert'])
    expect(posted).toEqual([{ url: 'https://api.github.com/repos/your_org_x/your-node/issues', method: 'POST', body: args.body }])
    // A post has no idempotency key: once sent, the page never offers it again.
    await waitFor(() => { expect(approve()).toBeNull() })
  })

  it('a post whose answer never comes back is said to have maybe gone out, and is never offered again', async () => {
    const posted: string[] = []
    const networkFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      posted.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
      const sent = (typeof init?.body === 'string' ? JSON.parse(init.body) : {}) as { title?: string; body?: string }
      return Response.json({ id: 9002, number: 43, state: 'open', title: sent.title, body: sent.body,
        html_url: 'https://github.com/your_org_x/your-node/issues/43' }, { status: 201 })
    }) as typeof fetch
    const { staged } = await edge({ networkFetch, extraEnv: { GITHUB_TOKEN: 'test-github-token' } })
    softwareAuthenticator(new URL(EDGE).hostname)
    await bindOwner()
    const args = { action: 'api', method: 'POST', endpoint: 'repos/your_org_x/your-node/issues', body: { title: 'Lost answer', body: 'x' } }
    // The connection drops after the edge has posted: the page's fetch of the approved request rejects.
    const pageFetch = globalThis.fetch
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const answer = await pageFetch(input, init)
      if (String(input) === '/_host/github' && new Headers(init?.headers).has('x-x6-class3-approval')) throw new TypeError('network connection lost')
      return answer
    })
    const outward = JSON.stringify({ schema: STAGED_OUTWARD_SCHEMA, stagedAt: Date.now(), tool: 'x6_github', method: 'POST',
      pathname: '/_host/github', body: args })
    const { container } = mountSovereignty(staged, outward)
    const card = () => container.querySelector('[data-sovereignty-portal="outward"]')
    await waitFor(() => { expect(card()?.textContent).toContain('GitHub: a new issue') }, { timeout: 20_000 })
    openHead(card()?.querySelector('button.ak-portal__head'))
    const approve = () => card()?.querySelector<HTMLButtonElement>('[data-outward-approve]') ?? null
    await waitFor(() => { expect(approve()?.disabled).toBe(false) }, { timeout: 20_000 })
    fireEvent.click(approve() as HTMLButtonElement)
    const outcome = () => card()?.querySelector('[data-outward-outcome]')
    await waitFor(() => { expect(outcome()?.getAttribute('data-outward-outcome')).toBe('unknown') }, { timeout: 20_000 })
    expect(outcome()?.textContent).toContain('It may have gone out: check GitHub before approving it again.')
    expect(posted).toEqual(['https://api.github.com/repos/your_org_x/your-node/issues'])
    await waitFor(() => { expect(approve()).toBeNull() })
  })
})

// ── Wave 3, Seam 2: the promotion HEAD holds itself, in a window whose copy of her home has no staged file ─────────────
/** A second owner window: its reader finds no staged file (or the one given), so only HEAD's own record can bring the card. */
const mountSecondWindow = (homeFile?: string) => {
  const list = { ids: ['s1' as SessionId], byId: { ['s1' as SessionId]: { id: 's1' as SessionId, displayTitle: 'Test', running: false,
    retainedBy: { mainView: 1 }, blank: false, updatedAt: 1 } }, phase: 'ready', projectionsBySession: {} } as unknown as SessionListState
  const props = {
    activeSurface: SOVEREIGNTY_SURFACE,
    useSessions: bindSnapshotSelector(createSnapshotStore<SessionListState>(list)),
    reader: { whole: async (_session: unknown, path: string): Promise<FileRead> => (path === STAGED_PROMOTION_PATH && homeFile !== undefined
      ? { ok: true, text: homeFile } : { ok: false, reason: 'not-found' }) },
  } as unknown as Parameters<typeof SovereigntySurface>[0]
  return render(<SovereigntySurface {...props} />)
}
/** Her worker hands a candidate to HEAD (`POST /_head/stage`), as ball-loader.ts does for a T2 candidate. */
const stageOnHead = async (stagedFile: string) => {
  const response = await fetch('/_head/stage', { method: 'POST', headers: { 'content-type': 'application/json' }, body: stagedFile })
  return { status: response.status, body: await response.json() as { ok?: boolean; code?: string; staged?: Record<string, unknown> } }
}
const heldNow = async () => ((await (await fetch('/_head/promotion-status')).json()) as { staged: Record<string, unknown> | null }).staged

describe('Wave 3: a Pearl staged on HEAD is approved from any owner window, and promoted by HEAD', () => {
  it('a window with no staged file reads HEAD\'s record, asks Touch ID for HEAD\'s own terms, and HEAD promotes what it holds', async () => {
    const { genesis, next, staged, sent, headNow } = await edge()
    const authenticator = softwareAuthenticator(new URL(EDGE).hostname)
    await bindOwner()
    // Tab A: her worker stages Epoch 163 on HEAD. HEAD records the candidate and its own passkey terms.
    const stagedAnswer = await stageOnHead(staged)
    expect([stagedAnswer.status, stagedAnswer.body.ok, stagedAnswer.body.staged?.stagedForOwner]).toEqual([200, true, true])
    const record = await heldNow()
    expect(record).toMatchObject({ ballId: next.ballId, epoch: 163, state: 'awaiting_owner', governanceClass: 3,
      changedEntries: ['seed-receipts'], binding: { action: 'head.promote', ballId: next.ballId, organId: 'seed-receipts' } })
    // Tab B: no staged file in this window's home. The card comes from HEAD's record alone.
    const { container } = mountSecondWindow()
    const card = await openCard(container, 'HEAD could take it: waits for your passkey')
    expect(card()?.getAttribute('data-sovereignty-promotion-source')).toBe('head')
    expect(card()?.textContent).toContain('held on HEAD')
    expect(card()?.textContent).toContain('epoch 163 · changes seed-receipts')
    expect(card()?.textContent).toContain('T2_PROTECTED_ORGAN')
    expect(card()?.textContent).toContain(`${String(record?.candidateDigest)} (the hash of the fields above, checked here)`)
    const approve = () => container.querySelector<HTMLButtonElement>('[data-sovereignty-promote]')
    await waitFor(() => { expect(approve()?.disabled).toBe(false) }, { timeout: 20_000 })
    const before = sent.length
    fireEvent.click(approve() as HTMLButtonElement)
    await waitFor(() => {
      expect(container.querySelector('[data-sovereignty-promotion-outcome]')?.getAttribute('data-sovereignty-promotion-outcome')).toBe('ok')
    }, { timeout: 20_000 })
    expect(container.querySelector('[data-sovereignty-promotion-outcome]')?.textContent).toContain('HEAD took it: epoch 163')
    // One Touch ID, for exactly the terms HEAD recorded; then HEAD promotes its own bytes. The page sends the Pearl's id
    // only: no lease request and no publish of its own.
    expect(authenticator.prompts).toEqual(['register', 'assert', 'assert'])
    const mine = sent.slice(before).filter(call => call.method === 'POST')
    expect(mine.find(call => call.path === '/_host/aumlok/challenge')?.body?.binding).toEqual(record?.binding)
    // SAFARI: the card's check was fresh, so the tap went straight to the passkey challenge: no read ran first.
    expect(sent.slice(before)[0]).toMatchObject({ method: 'POST', path: '/_host/aumlok/challenge' })
    expect(mine.find(call => call.path === '/_head/promote')?.body).toEqual({ ballId: next.ballId })
    expect(mine.map(call => call.path).filter(path => path === '/_head/ball' || path === '/_head/lease')).toEqual([])
    expect(await headNow()).toMatchObject({ ballId: next.ballId, epoch: 163 })
    expect(next.parentBallId).toBe(genesis.ballId)
    expect(await heldNow()).toBeNull()
  }, 60_000)

  it('a `head:staged` push brings the card to a window that is already open, without Refresh', async () => {
    const { staged } = await edge()
    softwareAuthenticator(new URL(EDGE).hostname)
    await bindOwner()
    const { container } = mountSecondWindow()
    const card = () => container.querySelector('[data-sovereignty-portal="promotion"]')
    // The published head is read (its card is on Continuity since Wave 5; the screen carries the epoch it read).
    await waitFor(() => { expect(container.querySelector('[data-sovereignty-surface]')?.getAttribute('data-published-epoch')).toBe('162') }, { timeout: 20_000 })
    expect(card()).toBeNull()
    expect((await stageOnHead(staged)).body.ok).toBe(true)
    // The push names nothing the page believes: what is staged is read back from HEAD itself.
    push({ type: 'head:staged', staged: { ballId: 'ff'.repeat(32), epoch: 999 } })
    await waitFor(() => { expect(card()?.textContent).toContain('seed-receipts · epoch 163 · HEAD could take it') }, { timeout: 20_000 })
    expect(card()?.getAttribute('data-sovereignty-promotion-source')).toBe('head')
  }, 60_000)

  it('a new organ staged without a governance declaration is offered as an ordinary add, and HEAD lands it on one Touch ID', async () => {
    const { genesis, headNow } = await edge()
    const authenticator = softwareAuthenticator(new URL(EDGE).hostname)
    await bindOwner()
    // Epoch 168 as it was first staged: `seed-continuity` added with `config: {}`. It stays ordinary (part a).
    const codes = { 'seed-receipts': codeOf('seed-receipts', 162), 'auma-notes': codeOf('auma-notes', 1), 'seed-continuity': codeOf('seed-continuity', 1) }
    const plain = await ballOf(genesis.ballId, 163, codes, 'auma-writer', true)
    const file = JSON.stringify({ schema: 'aukora.staged-head-promotion.v1', stagedAt: Date.now(), body: { ball: plain,
      codeBySha: { [hex(codes['seed-continuity'])]: codes['seed-continuity'] }, expectedParentBallId: genesis.ballId,
        expectedEpoch: 162 } })
    expect((await stageOnHead(file)).body).toMatchObject({ ok: true, staged: { governanceClass: 1, binding: null,
      organSet: { ballId: plain.ballId, organs: [{ organId: 'seed-continuity', sha256: hex(codes['seed-continuity']) }] } } })
    const { container } = mountSecondWindow()
    const cell = () => container.querySelector('[data-sovereignty-portal="organ-set"]')
    await waitFor(() => { expect(cell()?.textContent).toContain('seed-continuity') }, { timeout: 20_000 })
    expect(cell()?.textContent).toContain(hex(codes['seed-continuity']).slice(0, 12))
    expect(cell()?.textContent).toContain('epoch 163 · adds 1 ordinary organ')
    // No governance card is drawn for it: it is not a governance change, and nothing says "no passkey can approve it".
    expect(container.querySelector('[data-sovereignty-portal="promotion"]')).toBeNull()
    const approve = () => container.querySelector<HTMLButtonElement>('[data-sovereignty-organ-set-approve]')
    await waitFor(() => { expect(approve()?.disabled).toBe(false) }, { timeout: 20_000 })
    fireEvent.click(approve() as HTMLButtonElement)
    await waitFor(() => { expect(container.querySelector('[data-sovereignty-organ-set-said]')?.textContent).toContain('HEAD took it') },
      { timeout: 20_000 })
    expect(authenticator.prompts).toEqual(['register', 'assert', 'assert'])
    expect(await headNow()).toMatchObject({ ballId: plain.ballId, epoch: 163 })
  }, 60_000)

  it('a new organ that rides with any other change is still held, with why no passkey can approve it', async () => {
    const { genesis } = await edge()
    const authenticator = softwareAuthenticator(new URL(EDGE).hostname)
    await bindOwner()
    const codes = { 'seed-receipts': codeOf('seed-receipts', 162), 'auma-notes': codeOf('auma-notes', 1), 'seed-continuity': codeOf('seed-continuity', 1) }
    const rider = await ballOf(genesis.ballId, 163, codes, 'auma-writer', true, (entries) => {
      const notes = entries['auma-notes']
      if (notes !== undefined) notes.config = { rider: true }
    })
    const file = JSON.stringify({ schema: 'aukora.staged-head-promotion.v1', stagedAt: Date.now(), body: { ball: rider,
      codeBySha: { [hex(codes['seed-continuity'])]: codes['seed-continuity'] }, expectedParentBallId: genesis.ballId,
        expectedEpoch: 162 } })
    expect((await stageOnHead(file)).body).toMatchObject({ ok: true, staged: { governanceClass: 1, binding: null, organSet: null } })
    const { container } = mountSecondWindow()
    const card = await openCard(container, 'held on HEAD: no passkey can approve it as staged')
    expect(card()?.textContent).toContain('CANNOT LAND')
    expect(card()?.textContent).toContain('A passkey approves only a governance change (Class 3)')
    expect(card()?.textContent).toContain('MULTI_ORGAN_TRANSITION')
    // The rendered epoch and HEAD's change list (restored from the earlier held-organ test).
    expect(card()?.textContent).toContain('epoch 163 · changes auma-notes, seed-continuity')
    expect(container.querySelector('[data-sovereignty-promote]')).toBeNull()
    expect(container.querySelector('[data-sovereignty-organ-set-approve]')).toBeNull()
    expect(authenticator.prompts).toEqual(['register', 'assert'])
  }, 60_000)

  it('the same new organ declared `config: { governance: true }` is offered, and HEAD lands it on one Touch ID', async () => {
    const { genesis, headNow } = await edge()
    const authenticator = softwareAuthenticator(new URL(EDGE).hostname)
    await bindOwner()
    const codes = { 'seed-receipts': codeOf('seed-receipts', 162), 'auma-notes': codeOf('auma-notes', 1), 'seed-continuity': codeOf('seed-continuity', 1) }
    const declared = await ballOf(genesis.ballId, 163, codes, 'auma-writer', true, (entries) => {
      const organ = entries['seed-continuity']
      if (organ !== undefined) organ.config = { governance: true }
    })
    const file = JSON.stringify({ schema: 'aukora.staged-head-promotion.v1', stagedAt: Date.now(), body: { ball: declared,
      codeBySha: { [hex(codes['seed-continuity'])]: codes['seed-continuity'] }, expectedParentBallId: genesis.ballId,
        expectedEpoch: 162 } })
    expect((await stageOnHead(file)).body).toMatchObject({ ok: true, staged: { governanceClass: 3, binding: { organId: 'seed-continuity' } } })
    const { container } = mountSecondWindow()
    const card = await openCard(container, 'seed-continuity · epoch 163 · HEAD could take it: waits for your passkey')
    expect(card()?.textContent).toContain('adds the organ')
    const approve = () => container.querySelector<HTMLButtonElement>('[data-sovereignty-promote]')
    await waitFor(() => { expect(approve()?.disabled).toBe(false) }, { timeout: 20_000 })
    fireEvent.click(approve() as HTMLButtonElement)
    await waitFor(() => {
      expect(container.querySelector('[data-sovereignty-promotion-outcome]')?.getAttribute('data-sovereignty-promotion-outcome')).toBe('ok')
    }, { timeout: 20_000 })
    expect(authenticator.prompts).toEqual(['register', 'assert', 'assert'])
    expect(await headNow()).toMatchObject({ ballId: declared.ballId, epoch: 163 })
  }, 60_000)

  it('HEAD holding another Pearl by the time of the click asks for no passkey', async () => {
    const { staged, stagedOther, genesis, headNow } = await edge()
    const authenticator = softwareAuthenticator(new URL(EDGE).hostname)
    await bindOwner()
    expect((await stageOnHead(staged)).body.ok).toBe(true)
    const { container } = mountSecondWindow()
    await openCard(container, 'HEAD could take it: waits for your passkey')
    const approve = () => container.querySelector<HTMLButtonElement>('[data-sovereignty-promote]')
    await waitFor(() => { expect(approve()?.disabled).toBe(false) }, { timeout: 20_000 })
    // HEAD keeps the Pearl it holds: another one on the same parent is refused unless the stager says to replace it.
    expect((await stageOnHead(stagedOther)).body).toMatchObject({ ok: false, code: 'CANDIDATE_ALREADY_STAGED' })
    // Auma stages another Epoch 163 on HEAD in its place while the card is open (no push has reached this window yet).
    const replacing = JSON.stringify({ ...(JSON.parse(stagedOther) as Record<string, unknown>), replaceStaged: true })
    expect((await stageOnHead(replacing)).body.ok).toBe(true)
    ageCards()
    fireEvent.click(approve() as HTMLButtonElement)
    await waitFor(() => {
      expect(container.querySelector('[data-sovereignty-promotion-outcome]')?.textContent)
        .toContain('what HEAD holds has changed since this card read it, so no passkey was asked for')
    }, { timeout: 20_000 })
    expect(authenticator.prompts).toEqual(['register', 'assert'])
    expect(await headNow()).toMatchObject({ ballId: genesis.ballId, epoch: 162 })
  }, 60_000)

  it('the same Pearl in her home and on HEAD keeps the file\'s card (the page sends it), with HEAD\'s record beside it', async () => {
    const { staged, next, sent, headNow } = await edge()
    softwareAuthenticator(new URL(EDGE).hostname)
    await bindOwner()
    expect((await stageOnHead(staged)).body.ok).toBe(true)
    const { container } = mountSecondWindow(staged)
    const card = await openCard(container, 'HEAD could take it: waits for your passkey')
    expect(card()?.getAttribute('data-sovereignty-promotion-source')).toBe('home')
    expect(card()?.textContent).toContain('held on HEAD')
    const approve = () => container.querySelector<HTMLButtonElement>('[data-sovereignty-promote]')
    await waitFor(() => { expect(approve()?.disabled).toBe(false) }, { timeout: 20_000 })
    fireEvent.click(approve() as HTMLButtonElement)
    await waitFor(() => {
      expect(container.querySelector('[data-sovereignty-promotion-outcome]')?.getAttribute('data-sovereignty-promotion-outcome')).toBe('ok')
    }, { timeout: 20_000 })
    expect(sent.some(call => call.method === 'POST' && call.path === '/_head/ball')).toBe(true)
    expect(sent.some(call => call.path === '/_head/promote')).toBe(false)
    expect(await headNow()).toMatchObject({ ballId: next.ballId, epoch: 163 })
    // HEAD's own record of it is spent with the landing: nothing is left waiting.
    expect(await heldNow()).toBeNull()
  }, 60_000)

  it('a Pearl staged only in this window\'s home can be handed to HEAD to hold, and a second window then shows it', async () => {
    const { staged, next, genesis, sent, headNow } = await edge()
    const authenticator = softwareAuthenticator(new URL(EDGE).hostname)
    await bindOwner()
    expect(await heldNow()).toBeNull()
    const first = mountSecondWindow(staged)
    const card = await openCard(first.container, 'HEAD could take it: waits for your passkey')
    expect(card()?.getAttribute('data-sovereignty-promotion-source')).toBe('home')
    const stage = () => first.container.querySelector<HTMLButtonElement>('[data-sovereignty-stage-edge]')
    await waitFor(() => { expect(stage()?.disabled).toBe(false) }, { timeout: 20_000 })
    fireEvent.click(stage() as HTMLButtonElement)
    await waitFor(() => {
      expect(first.container.querySelector('[data-sovereignty-stage-outcome]')?.textContent).toContain('HEAD holds it now')
    }, { timeout: 20_000 })
    // The exact staged body went to HEAD; no passkey was asked for, and nothing was published.
    const sentStage = sent.find(call => call.method === 'POST' && call.path === '/_head/stage')
    expect(sentStage?.body?.body).toEqual((JSON.parse(staged) as { body: unknown }).body)
    expect(authenticator.prompts).toEqual(['register', 'assert'])
    expect(await headNow()).toMatchObject({ ballId: genesis.ballId, epoch: 162 })
    expect(await heldNow()).toMatchObject({ ballId: next.ballId, state: 'awaiting_owner' })
    // The card now carries HEAD's record, and offers the staging no more.
    await waitFor(() => { expect(stage()).toBeNull() }, { timeout: 20_000 })
    expect(card()?.textContent).toContain('held on HEAD')
    cleanup()
    // Another owner window, with no staged file of its own.
    const second = mountSecondWindow()
    const other = await openCard(second.container, 'HEAD could take it: waits for your passkey')
    expect(other()?.getAttribute('data-sovereignty-promotion-source')).toBe('head')
    expect(second.container.querySelector('[data-sovereignty-stage-edge]')).toBeNull()
  }, 60_000)

  it('HEAD\'s record not read, with nothing staged in this window: said as not checked, never drawn as nothing staged', async () => {
    const { staged } = await edge()
    softwareAuthenticator(new URL(EDGE).hostname)
    await bindOwner()
    expect((await stageOnHead(staged)).body.ok).toBe(true)
    // The route starts failing for this window (HEAD does hold a Pearl).
    const pageFetch = globalThis.fetch
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => (String(input) === '/_head/promotion-status'
      ? new Response(JSON.stringify({ ok: false, code: 'HEAD_STORAGE_UNAVAILABLE' }), { status: 503 }) : pageFetch(input, init)))
    const { container } = mountSecondWindow()
    const card = await openCard(container, 'not checked: what HEAD holds for you was not read')
    expect(card()?.textContent).toContain('NOT CHECKED')
    expect(card()?.textContent).toContain('HEAD\'s own record of a staged Pearl could not be read (it answered 503)')
    expect(card()?.textContent).toContain('this window has no staged Pearl of its own to show, so whether a Pearl waits for your passkey is not known')
    expect(container.querySelector('[data-sovereignty-promote]')).toBeNull()
    cleanup()
    // A host that has no such route at all (404) is not a failed read: no card.
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => (String(input) === '/_head/promotion-status'
      ? new Response('nope', { status: 404 }) : pageFetch(input, init)))
    const none = mountSecondWindow()
    await waitFor(() => { expect(none.container.querySelector('[data-sovereignty-surface]')?.getAttribute('data-published-epoch')).toBe('162') },
      { timeout: 20_000 })
    await new Promise((resolve) => { setTimeout(resolve, 50) })
    expect(none.container.querySelector('[data-sovereignty-portal="promotion"]')).toBeNull()
  }, 60_000)

  it('staging on the edge is checked again at the click: HEAD holding a Pearl by then is not replaced', async () => {
    const { staged, stagedOther, sent } = await edge()
    softwareAuthenticator(new URL(EDGE).hostname)
    await bindOwner()
    const { container } = mountSecondWindow(staged)
    await openCard(container, 'HEAD could take it: waits for your passkey')
    const stage = () => container.querySelector<HTMLButtonElement>('[data-sovereignty-stage-edge]')
    await waitFor(() => { expect(stage()?.disabled).toBe(false) }, { timeout: 20_000 })
    // Her worker stages another Pearl on HEAD after this card was read.
    expect((await stageOnHead(stagedOther)).body.ok).toBe(true)
    const stagings = () => sent.filter(call => call.method === 'POST' && call.path === '/_head/stage').length
    const before = stagings()
    fireEvent.click(stage() as HTMLButtonElement)
    await waitFor(() => {
      expect(container.querySelector('[data-sovereignty-stage-outcome]')?.textContent)
        .toContain('HEAD holds a staged Pearl by now, so nothing was sent')
    }, { timeout: 20_000 })
    // The page never asks HEAD to replace what it holds (HEAD itself refuses that too, unless told to replace).
    expect(stagings()).toBe(before)
    expect(await heldNow()).toMatchObject({ ballId: (JSON.parse(stagedOther) as { body: { ball: { ballId: string } } }).body.ball.ballId })
  }, 60_000)

  it('the same Pearl with a fault in her file\'s copy alone: HEAD\'s copy is the one offered, and lands', async () => {
    const { staged, next, sent, headNow } = await edge()
    softwareAuthenticator(new URL(EDGE).hostname)
    await bindOwner()
    expect((await stageOnHead(staged)).body.ok).toBe(true)
    // Her file names an older head than it was staged on (a fault of the file's envelope, not of the Pearl).
    const file = JSON.parse(staged) as { body: Record<string, unknown> }
    const stale = JSON.stringify({ ...file, body: { ...file.body, expectedEpoch: 161 } })
    const { container } = mountSecondWindow(stale)
    const card = await openCard(container, 'HEAD could take it: waits for your passkey')
    expect(card()?.getAttribute('data-sovereignty-promotion-source')).toBe('head')
    const approve = () => container.querySelector<HTMLButtonElement>('[data-sovereignty-promote]')
    await waitFor(() => { expect(approve()?.disabled).toBe(false) }, { timeout: 20_000 })
    fireEvent.click(approve() as HTMLButtonElement)
    await waitFor(() => {
      expect(container.querySelector('[data-sovereignty-promotion-outcome]')?.getAttribute('data-sovereignty-promotion-outcome')).toBe('ok')
    }, { timeout: 20_000 })
    expect(sent.some(call => call.path === '/_head/promote')).toBe(true)
    expect(await headNow()).toMatchObject({ ballId: next.ballId, epoch: 163 })
  }, 60_000)

  it('her home holding a different staged Pearl than HEAD: HEAD\'s is the one shown, and the other is named', async () => {
    const { staged, stagedOther, next } = await edge()
    softwareAuthenticator(new URL(EDGE).hostname)
    await bindOwner()
    expect((await stageOnHead(staged)).body.ok).toBe(true)
    const { container } = mountSecondWindow(stagedOther)
    const card = await openCard(container, 'HEAD could take it: waits for your passkey')
    expect(card()?.getAttribute('data-sovereignty-promotion-source')).toBe('head')
    expect(card()?.textContent).toContain(next.ballId)
    expect(card()?.textContent).toContain('her home also holds')
  }, 60_000)
})

// ── Wave 4, Wall 2: a repo proposal approved with a real passkey ceremony against the real Worker ─────────────────────
describe('Wave 4: a staged repo proposal is approved for exactly the page\'s own terms, and sent as approved', () => {
  it('the real AUMLOK approves the class3 action the page computed; the page sends that exact body with the approval', async () => {
    const { sent } = await edge()
    const authenticator = softwareAuthenticator(new URL(EDGE).hostname)
    await bindOwner()
    const { class3Action } = await import('../src/client/spatial/aumlok/class3-approval.ts')
    const mergeBody = { action: 'merge_proposal', baseSha: 'a'.repeat(40), branch: 'auma/proposal/fix-receipts-signer-policy', headSha: 'b'.repeat(40),
      treeSha: 'c'.repeat(40) }
    const proposal = { schema: 'aukora.staged-repo-proposal.v1', branch: mergeBody.branch, title: 'Enforce the checkpoint signer policy', summary: null,
      baseSha: mergeBody.baseSha, headSha: mergeBody.headSha, treeSha: mergeBody.treeSha,
      changedFiles: [{ path: 'mirror/home/auma/seed/organs/seed-receipts.js', status: 'modified', additions: 10, deletions: 2, t2Protected: true }],
      ciStatus: 'passed', stagedAt: Date.now(), mergeBody,
      binding: await class3Action({ audience: EDGE, method: 'POST', pathname: '/_host/repo', body: mergeBody }) }
    // HEAD's record, as the Wave 4 contract serves it (the edge side lands in another lane): added to the real answer.
    const edgeFetch = globalThis.fetch
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const answer = await edgeFetch(input, init)
      if (String(input) !== '/_head/promotion-status') return answer
      const body = await answer.json() as Record<string, unknown>
      return new Response(JSON.stringify({ ...body, stagedRepoProposal: proposal }), { status: answer.status, headers: { 'content-type': 'application/json' } })
    })
    const { RepoProposalCell } = await import('../src/client/spatial/portal/RepoProposalCell.tsx')
    const { container } = render(<RepoProposalCell active round={0} ownerBound />)
    await waitFor(() => { expect(container.querySelector('[data-sovereignty-portal="repo-proposal"]')).not.toBeNull() }, { timeout: 20_000 })
    openHead(container.querySelector('[data-sovereignty-portal="repo-proposal"] button.ak-portal__head'))
    const approve = () => container.querySelector<HTMLButtonElement>('[data-repo-proposal-approve]')
    await waitFor(() => { expect(approve()?.disabled).toBe(false) }, { timeout: 20_000 })
    const before = sent.length
    fireEvent.click(approve() as HTMLButtonElement)
    await waitFor(() => {
      const state = container.querySelector('[data-repo-proposal-outcome]')?.getAttribute('data-repo-proposal-outcome')
      expect(['refused', 'merged', 'unclear']).toContain(state)
    }, { timeout: 20_000 })
    // One Touch ID, for the terms the page computed: the real AUMLOK took them (it signs only an exact class3 action).
    expect(authenticator.prompts).toEqual(['register', 'assert', 'assert'])
    const mine = sent.slice(before)
    expect(mine.find(call => call.path === '/_host/aumlok/challenge')?.body?.binding).toEqual(proposal.binding)
    // SAFARI: a fresh card goes straight to the passkey challenge inside the tap.
    expect(mine[0]).toMatchObject({ method: 'POST', path: '/_host/aumlok/challenge' })
    // Then exactly the approved body went to /_host/repo. (This edge has no merge_proposal yet, so it refuses; whatever it
    // answers, the page never claims a merge it was not told of.)
    expect(mine.find(call => call.method === 'POST' && call.path === '/_host/repo')?.body).toEqual(mergeBody)
    expect(container.querySelector('[data-repo-proposal-outcome]')?.getAttribute('data-repo-proposal-outcome')).not.toBe('merged')
  }, 60_000)
})

// ── Lane B2: Touch ID that cannot be missed ────────────────────────────────────────────────────────────────────────────
describe('Lane B2: the Fingerprint card in the chat approves on one tap; Sovereignty puts the waiting card first and open', () => {
  it('the chat card says what waits, and its button runs the whole approval: the challenge first, Touch ID, HEAD promotes', async () => {
    const { next, staged, sent, headNow } = await edge()
    const authenticator = softwareAuthenticator(new URL(EDGE).hostname)
    await bindOwner()
    expect((await stageOnHead(staged)).body.ok).toBe(true)
    const { FingerprintWaiting } = await import('../src/client/spatial/portal/FingerprintWaiting.tsx')
    const openSovereignty = vi.fn()
    const { container } = render(<FingerprintWaiting openSovereignty={openSovereignty} />)
    const card = () => container.querySelector('[data-fingerprint-waiting]')
    await waitFor(() => { expect(card()?.getAttribute('data-fingerprint-waiting')).toBe('pearl') }, { timeout: 20_000 })
    expect(card()?.querySelector('[data-fingerprint-line]')?.textContent).toBe(`Epoch 163 · seed-receipts (${next.ballId.slice(0, 8)}…)`)
    fireEvent.click(card()?.querySelector('[data-fingerprint-inspect]') as HTMLButtonElement)
    expect(openSovereignty).toHaveBeenCalledTimes(1)
    const before = sent.length
    fireEvent.click(card()?.querySelector('[data-fingerprint-approve]') as HTMLButtonElement)
    await waitFor(() => { expect(container.querySelector('[data-fingerprint-outcome]')?.getAttribute('data-fingerprint-outcome')).toBe('done') },
      { timeout: 20_000 })
    expect(container.querySelector('[data-fingerprint-outcome]')?.textContent).toContain('HEAD took it: epoch 163')
    // SAFARI: nothing ran between the tap and the passkey challenge.
    expect(sent.slice(before)[0]).toMatchObject({ method: 'POST', path: '/_host/aumlok/challenge' })
    expect(authenticator.prompts).toEqual(['register', 'assert', 'assert'])
    expect(await headNow()).toMatchObject({ ballId: next.ballId, epoch: 163 })
  }, 60_000)

  it('nothing waiting: no card; a Pearl no passkey can approve as staged: the card says so and only points to Sovereignty', async () => {
    const { genesis } = await edge()
    softwareAuthenticator(new URL(EDGE).hostname)
    await bindOwner()
    const { FingerprintWaiting } = await import('../src/client/spatial/portal/FingerprintWaiting.tsx')
    const first = render(<FingerprintWaiting openSovereignty={() => {}} />)
    await new Promise((resolve) => { setTimeout(resolve, 300) })
    expect(first.container.querySelector('[data-fingerprint-waiting]')).toBeNull()
    cleanup()
    const codes = { 'seed-receipts': codeOf('seed-receipts', 162), 'auma-notes': codeOf('auma-notes', 1), 'seed-continuity': codeOf('seed-continuity', 1) }
    // A new organ riding with another change: no passkey can approve it as staged (a pure add is offered, test below).
    const plain = await ballOf(genesis.ballId, 163, codes, 'auma-writer', true, (entries) => {
      const notes = entries['auma-notes']
      if (notes !== undefined) notes.config = { rider: true }
    })
    expect((await stageOnHead(JSON.stringify({ schema: 'aukora.staged-head-promotion.v1', stagedAt: Date.now(), body: { ball: plain,
      codeBySha: { [hex(codes['seed-continuity'])]: codes['seed-continuity'] }, expectedParentBallId: genesis.ballId, expectedEpoch: 162 } }))).body.ok).toBe(true)
    const second = render(<FingerprintWaiting openSovereignty={() => {}} />)
    await waitFor(() => { expect(second.container.querySelector('[data-fingerprint-line]')?.textContent).toContain('cannot be approved from here') },
      { timeout: 20_000 })
    expect(second.container.querySelector('[data-fingerprint-approve]')).toBeNull()
    fireEvent.click(second.container.querySelector('[data-fingerprint-dismiss]') as HTMLButtonElement)
    expect(second.container.querySelector('[data-fingerprint-waiting]')).toBeNull()
  }, 60_000)

  it('a pure ordinary add: the Fingerprint card lists every organ with its module and size, and offers one Touch ID', async () => {
    const { genesis, headNow } = await edge()
    const authenticator = softwareAuthenticator(new URL(EDGE).hostname)
    await bindOwner()
    const codes = { 'seed-receipts': codeOf('seed-receipts', 162), 'auma-notes': codeOf('auma-notes', 1),
      'repo-forge': codeOf('repo-forge', 1), 'voice-slot': codeOf('voice-slot', 2) }
    const plain = await ballOf(genesis.ballId, 163, codes, 'auma-writer', true)
    expect((await stageOnHead(JSON.stringify({ schema: 'aukora.staged-head-promotion.v1', stagedAt: Date.now(), body: { ball: plain,
      codeBySha: { [hex(codes['repo-forge'])]: codes['repo-forge'], [hex(codes['voice-slot'])]: codes['voice-slot'] },
      expectedParentBallId: genesis.ballId, expectedEpoch: 162 } }))).body.ok).toBe(true)
    const { FingerprintWaiting } = await import('../src/client/spatial/portal/FingerprintWaiting.tsx')
    const card = render(<FingerprintWaiting openSovereignty={() => {}} />)
    await waitFor(() => { expect(card.container.querySelector('[data-fingerprint-approve]')).not.toBeNull() }, { timeout: 20_000 })
    expect(card.container.querySelector('[data-fingerprint-waiting]')?.getAttribute('data-fingerprint-waiting')).toBe('organ-set')
    for (const id of ['repo-forge', 'voice-slot'] as const) {
      const row = card.container.querySelector(`[data-fingerprint-organ="${id}"]`)
      expect(row?.textContent).toContain(hex(codes[id]))
      expect(row?.textContent).toContain(`${String(new TextEncoder().encode(codes[id]).byteLength)} bytes`)
    }
    fireEvent.click(card.container.querySelector('[data-fingerprint-approve]') as HTMLButtonElement)
    await waitFor(() => { expect(card.container.querySelector('[data-fingerprint-outcome="done"]')).not.toBeNull() }, { timeout: 20_000 })
    expect(authenticator.prompts).toEqual(['register', 'assert', 'assert'])
    expect(await headNow()).toMatchObject({ ballId: plain.ballId, epoch: 163 })
  }, 60_000)

  it('a restage inside the fresh window: a live change to her staged file before the tap sends it back to the file; no passkey', async () => {
    const { headNow, genesis, staged, stagedOther } = await edge()
    const authenticator = softwareAuthenticator(new URL(EDGE).hostname)
    await bindOwner()
    let onDisk = staged
    const { container } = mountSovereignty(() => onDisk)
    await openCard(container, 'HEAD could take it: waits for your passkey')
    const approve = () => container.querySelector<HTMLButtonElement>('[data-sovereignty-promote]')
    await waitFor(() => { expect(approve()?.disabled).toBe(false) }, { timeout: 20_000 })
    await waitFor(() => { expect(FakeSocket.open.filter(s => !s.closed).length).toBeGreaterThan(0) })
    // Auma stages another Pearl seconds after the card read hers (well inside FRESH_CHECK_MS); the host says so on its
    // socket, and the owner taps before the card has read it again.
    onDisk = stagedOther
    push({ type: 'mirror:updated', changedPaths: ['home/auma/staged/head-promotion.json'] })
    fireEvent.click(approve() as HTMLButtonElement)
    await waitFor(() => {
      expect(container.querySelector('[data-sovereignty-promotion-outcome]')?.textContent).toContain('has changed since this card read it')
    }, { timeout: 20_000 })
    expect(authenticator.prompts).toEqual(['register', 'assert'])
    expect(await headNow()).toMatchObject({ ballId: genesis.ballId, epoch: 162 })
  }, 60_000)

  it('SAFARI: after a re-check the browser refuses the sheet; the card asks for one more tap, which goes straight to Touch ID', async () => {
    const { next, staged, sent, headNow } = await edge()
    const authenticator = softwareAuthenticator(new URL(EDGE).hostname)
    await bindOwner()
    expect((await stageOnHead(staged)).body.ok).toBe(true)
    const { FingerprintWaiting } = await import('../src/client/spatial/portal/FingerprintWaiting.tsx')
    const { container } = render(<FingerprintWaiting openSovereignty={() => {}} />)
    const card = () => container.querySelector('[data-fingerprint-waiting]')
    await waitFor(() => { expect(card()?.getAttribute('data-fingerprint-waiting')).toBe('pearl') }, { timeout: 20_000 })
    // The card has been open a while: the tap reads HEAD again first, and Safari then will not open the sheet.
    ageCards()
    authenticator.hooks.beforeAssert = async () => { throw new DOMException('The request is not allowed by the user agent.', 'NotAllowedError') }
    fireEvent.click(card()?.querySelector('[data-fingerprint-approve]') as HTMLButtonElement)
    await waitFor(() => { expect(container.querySelector('[data-fingerprint-outcome]')?.textContent).toBe(TAP_AGAIN) }, { timeout: 20_000 })
    expect(await headNow()).toMatchObject({ epoch: 162 })
    await waitFor(() => { expect(card()?.querySelector<HTMLButtonElement>('[data-fingerprint-approve]')?.disabled).toBe(false) })
    // One more tap: the check is current, so nothing runs before the challenge, and HEAD promotes.
    const before = sent.length
    fireEvent.click(card()?.querySelector('[data-fingerprint-approve]') as HTMLButtonElement)
    await waitFor(() => { expect(container.querySelector('[data-fingerprint-outcome]')?.getAttribute('data-fingerprint-outcome')).toBe('done') },
      { timeout: 20_000 })
    expect(sent.slice(before)[0]).toMatchObject({ method: 'POST', path: '/_host/aumlok/challenge' })
    expect(authenticator.prompts).toEqual(['register', 'assert', 'assert', 'assert'])
    expect(await headNow()).toMatchObject({ ballId: next.ballId, epoch: 163 })
  }, 60_000)

  it('one approval at a time: while Sovereignty runs Touch ID for a Pearl, the chat card asks for nothing', async () => {
    const { next, staged, headNow } = await edge()
    const authenticator = softwareAuthenticator(new URL(EDGE).hostname)
    await bindOwner()
    expect((await stageOnHead(staged)).body.ok).toBe(true)
    const { FingerprintWaiting } = await import('../src/client/spatial/portal/FingerprintWaiting.tsx')
    const chat = render(<FingerprintWaiting openSovereignty={() => {}} />)
    const chatCard = () => chat.container.querySelector('[data-fingerprint-waiting]')
    await waitFor(() => { expect(chatCard()?.getAttribute('data-fingerprint-waiting')).toBe('pearl') }, { timeout: 20_000 })
    const { container } = mountSecondWindow()
    await waitFor(() => { expect(container.querySelector<HTMLButtonElement>('[data-sovereignty-promote]')?.disabled).toBe(false) }, { timeout: 20_000 })
    // In the middle of Sovereignty's Touch ID, the owner taps the chat card too.
    authenticator.hooks.beforeAssert = async () => {
      fireEvent.click(chatCard()?.querySelector('[data-fingerprint-approve]') as HTMLButtonElement)
      await waitFor(() => { expect(chat.container.querySelector('[data-fingerprint-outcome]')?.textContent).toContain('Another card on this page') })
    }
    fireEvent.click(container.querySelector('[data-sovereignty-promote]') as HTMLButtonElement)
    await waitFor(() => { expect(container.querySelector('[data-sovereignty-promotion-outcome]')?.textContent).toContain('HEAD took it: epoch 163') },
      { timeout: 20_000 })
    expect(authenticator.prompts).toEqual(['register', 'assert', 'assert'])
    expect(await headNow()).toMatchObject({ ballId: next.ballId, epoch: 163 })
  }, 60_000)

  it('Sovereignty: "Waiting for your Touch ID" comes first, the card is open, and its button is above the details', async () => {
    const { staged } = await edge()
    softwareAuthenticator(new URL(EDGE).hostname)
    await bindOwner()
    expect((await stageOnHead(staged)).body.ok).toBe(true)
    const { container } = mountSecondWindow()
    await waitFor(() => { expect(container.querySelector('[data-sovereignty-promote]')).not.toBeNull() }, { timeout: 20_000 })
    const waiting = container.querySelector('[data-sovereignty-waiting]') as HTMLElement
    expect(waiting.hidden).toBe(false)
    expect(waiting.textContent).toContain('Waiting for your Touch ID')
    const order = (a: Element | null, b: Element | null) =>
      (a !== null && b !== null ? a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING : 0)
    // The durability strip moved to the Continuity screen (Wave 5): Sovereignty opens on what waits, then keys and receipts.
    expect(container.querySelector('[data-sovereignty-durability]')).toBeNull()
    expect([...container.querySelectorAll('[data-sovereignty-portal]')].map(cell => cell.getAttribute('data-sovereignty-portal')))
      .toEqual(['promotion', 'keys', 'chain'])
    expect(order(waiting, container.querySelector('[data-sovereignty-portal="keys"]'))).toBeTruthy()
    const card = container.querySelector('[data-sovereignty-portal="promotion"]') as HTMLElement
    expect(card.querySelector('button.ak-portal__head')?.getAttribute('aria-expanded')).toBe('true')
    expect(order(card.querySelector('[data-sovereignty-promote]'), card.querySelector('.ak-fields, table, dl'))).toBeTruthy()
    expect(container.querySelector('[data-sovereignty-promote]')?.textContent).toContain('with Touch ID')
  }, 60_000)
})

// ── Lane B3: the chat card also reads her home: a Pearl staged there, and her outward request ──────────────────────────
const urlOf = (input: RequestInfo | URL): string => (typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
/** Her home as one window's reader serves it: her staged Pearl and her outward request, each optional, each may change. */
const homeReader = (promotion?: string | (() => string), outward?: string | (() => string)): WorkReader & { reads: string[] } => {
  const reads: string[] = []
  return {
    reads,
    whole: async (_session: unknown, path: string): Promise<FileRead> => {
      reads.push(path)
      const file = path === STAGED_PROMOTION_PATH ? promotion : path === STAGED_OUTWARD_PATH ? outward : undefined
      return file === undefined ? { ok: false, reason: 'not-found' } : { ok: true, text: typeof file === 'string' ? file : file() }
    },
  }
}
/** The chat lane's Fingerprint card, given her home as the frame gives it: the page's reader and the Session it shows. */
const mountChat = async (reader: WorkReader) => {
  const { FingerprintWaiting } = await import('../src/client/spatial/portal/FingerprintWaiting.tsx')
  const view = render(<FingerprintWaiting openSovereignty={() => {}} reader={reader} sessionId={'s1' as SessionId} />)
  const card = () => view.container.querySelector('[data-fingerprint-waiting]')
  return {
    ...view,
    card,
    kind: () => card()?.getAttribute('data-fingerprint-waiting'),
    line: () => card()?.querySelector('[data-fingerprint-line]')?.textContent,
    approve: () => card()?.querySelector<HTMLButtonElement>('[data-fingerprint-approve]') ?? null,
    outcome: () => view.container.querySelector('[data-fingerprint-outcome]'),
  }
}
/** GitHub as the edge reaches it (`networkFetch`): every post is recorded, and answered as GitHub answers a new issue. */
const githubStub = () => {
  const posted: Array<{ readonly url: string; readonly method: string; readonly body: unknown }> = []
  const networkFetch: typeof fetch = async (input, init) => {
    const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : null
    posted.push({ url: urlOf(input), method: init?.method ?? 'GET', body })
    const sent = (body ?? {}) as { title?: string; body?: string }
    return Response.json({ id: 9101, number: 51, state: 'open', title: sent.title, body: sent.body,
      html_url: 'https://github.com/your_org_x/your-node/issues/51' }, { status: 201 })
  }
  return { posted, networkFetch }
}
/** Her staged GitHub issue, as her worker stages it (`ball-loader.ts` `stageOutward`). */
const outwardIssue = (title: string) => {
  const args = { action: 'api', method: 'POST', endpoint: 'repos/your_org_x/your-node/issues',
    body: { title, body: `Staged for Lane B3: ${title}.` } }
  return { args, file: JSON.stringify({ schema: STAGED_OUTWARD_SCHEMA, stagedAt: Date.now(), tool: 'x6_github', method: 'POST',
    pathname: '/_host/github', body: args }) }
}
const COUNT = /· \d+ waiting/u
/** One row of her outward request as the chat card shows it before the tap: its value, every byte of it. */
const outwardRow = (card: Element | null | undefined, name: string) =>
  card?.querySelector(`[data-fingerprint-outward-rows] [data-fingerprint-outward-row="${name}"] [data-fingerprint-outward-value]`)?.textContent
/** How many of the page's requests were this one (`GET /_head/ball`, …), from the edge's record of them. */
const countOf = (calls: readonly string[], call: string) => calls.filter(each => each === call).length

describe('Lane B3: the chat card also approves a Pearl staged at home and an outward request', () => {
  it('a Pearl staged only in her home, HEAD holding none: the chat offers it, and one tap sends her bytes to HEAD', async () => {
    const { next, staged, sent, headNow } = await edge()
    const authenticator = softwareAuthenticator(new URL(EDGE).hostname)
    await bindOwner()
    expect(await heldNow()).toBeNull()
    const chat = await mountChat(homeReader(staged))
    await waitFor(() => { expect(chat.kind()).toBe('home-pearl') }, { timeout: 20_000 })
    expect(chat.line()).toBe(`Epoch 163 · seed-receipts (${next.ballId.slice(0, 8)}…) · staged in this window only`)
    expect(chat.approve()?.textContent).toBe('Approve with Touch ID')
    const before = sent.length
    fireEvent.click(chat.approve() as HTMLButtonElement)
    await waitFor(() => { expect(chat.outcome()?.getAttribute('data-fingerprint-outcome')).toBe('done') }, { timeout: 20_000 })
    expect(chat.outcome()?.textContent).toContain('HEAD took it: epoch 163')
    // SAFARI: the card's check was fresh, so nothing ran between the tap and the passkey challenge.
    const mine = sent.slice(before)
    expect(mine[0]).toMatchObject({ method: 'POST', path: '/_host/aumlok/challenge' })
    // Her staged bytes went to HEAD under a fresh writer lease (as Sovereignty sends them); HEAD was not asked to promote.
    expect(mine.find(call => call.method === 'POST' && call.path === '/_head/lease')?.body)
      .toMatchObject({ action: 'acquire', ownerPeerId: 'auma-writer' })
    expect(mine.find(call => call.method === 'POST' && call.path === '/_head/ball')?.body?.ball).toEqual(next)
    expect(mine.some(call => call.path === '/_head/promote')).toBe(false)
    expect(authenticator.prompts).toEqual(['register', 'assert', 'assert'])
    expect(await headNow()).toMatchObject({ ballId: next.ballId, epoch: 163 })
  }, 60_000)

  it('the same Pearl in her home and on HEAD is one item, and it lands as her file\'s card does (POST /_head/ball)', async () => {
    const { next, staged, sent, headNow } = await edge()
    softwareAuthenticator(new URL(EDGE).hostname)
    await bindOwner()
    expect((await stageOnHead(staged)).body.ok).toBe(true)
    const chat = await mountChat(homeReader(staged))
    await waitFor(() => { expect(chat.kind()).toBe('home-pearl') }, { timeout: 20_000 })
    // One Pearl, one item: never "· 2 waiting", and not "only in this window" (HEAD holds it too).
    expect(chat.card()?.textContent).not.toMatch(COUNT)
    expect(chat.line()).toBe(`Epoch 163 · seed-receipts (${next.ballId.slice(0, 8)}…)`)
    const before = sent.length
    fireEvent.click(chat.approve() as HTMLButtonElement)
    await waitFor(() => { expect(chat.outcome()?.getAttribute('data-fingerprint-outcome')).toBe('done') }, { timeout: 20_000 })
    expect(sent.slice(before)[0]).toMatchObject({ method: 'POST', path: '/_host/aumlok/challenge' })
    expect(sent.some(call => call.method === 'POST' && call.path === '/_head/ball')).toBe(true)
    expect(sent.some(call => call.path === '/_head/promote')).toBe(false)
    expect(await headNow()).toMatchObject({ ballId: next.ballId, epoch: 163 })
    // HEAD's own record of it is spent with the landing: nothing is left waiting.
    expect(await heldNow()).toBeNull()
  }, 60_000)

  it('her home holding a different Pearl than HEAD: the chat offers HEAD\'s, and counts one', async () => {
    const { next, staged, stagedOther } = await edge()
    softwareAuthenticator(new URL(EDGE).hostname)
    await bindOwner()
    expect((await stageOnHead(staged)).body.ok).toBe(true)
    const chat = await mountChat(homeReader(stagedOther))
    await waitFor(() => { expect(chat.kind()).toBe('pearl') }, { timeout: 20_000 })
    expect(chat.line()).toBe(`Epoch 163 · seed-receipts (${next.ballId.slice(0, 8)}…)`)
    expect(chat.card()?.textContent).not.toMatch(COUNT)
  }, 60_000)

  it('a restage inside the fresh window: a live change to her staged file before the tap is read again first; no passkey', async () => {
    const { genesis, staged, stagedOther, headNow } = await edge()
    const authenticator = softwareAuthenticator(new URL(EDGE).hostname)
    await bindOwner()
    const other = (JSON.parse(stagedOther) as { body: { ball: { ballId: string } } }).body.ball.ballId
    let onDisk = staged
    const chat = await mountChat(homeReader(() => onDisk))
    await waitFor(() => { expect(chat.kind()).toBe('home-pearl') }, { timeout: 20_000 })
    await waitFor(() => { expect(FakeSocket.open.filter(s => !s.closed).length).toBeGreaterThan(0) })
    // Auma stages another Pearl seconds after the card read hers (well inside FRESH_CHECK_MS); the host says so on its
    // socket, and the owner taps before the card has read it again.
    onDisk = stagedOther
    push({ type: 'mirror:updated', changedPaths: ['home/auma/staged/head-promotion.json'] })
    fireEvent.click(chat.approve() as HTMLButtonElement)
    await waitFor(() => {
      expect(chat.outcome()?.textContent).toContain('it changed since this card read it, so no passkey was asked for')
    }, { timeout: 20_000 })
    expect(chat.outcome()?.getAttribute('data-fingerprint-outcome')).toBe('refused')
    // The card shows what she staged in its place; nothing was asked for and nothing landed.
    expect(chat.line()).toContain(`(${other.slice(0, 8)}…)`)
    expect(authenticator.prompts).toEqual(['register', 'assert'])
    expect(await headNow()).toMatchObject({ ballId: genesis.ballId, epoch: 162 })
  }, 60_000)

  it('one approval at a time: while Sovereignty runs Touch ID for her staged Pearl, the chat card asks for nothing', async () => {
    const { next, staged, headNow } = await edge()
    const authenticator = softwareAuthenticator(new URL(EDGE).hostname)
    await bindOwner()
    const chat = await mountChat(homeReader(staged))
    await waitFor(() => { expect(chat.kind()).toBe('home-pearl') }, { timeout: 20_000 })
    const { container } = mountSecondWindow(staged)
    const promote = () => container.querySelector<HTMLButtonElement>('[data-sovereignty-promote]')
    await waitFor(() => { expect(promote()?.disabled).toBe(false) }, { timeout: 20_000 })
    // In the middle of Sovereignty's Touch ID, the owner taps the chat card too.
    authenticator.hooks.beforeAssert = async () => {
      fireEvent.click(chat.approve() as HTMLButtonElement)
      await waitFor(() => { expect(chat.outcome()?.textContent).toContain('Another card on this page') })
    }
    fireEvent.click(promote() as HTMLButtonElement)
    await waitFor(() => {
      expect(container.querySelector('[data-sovereignty-promotion-outcome]')?.textContent).toContain('HEAD took it: epoch 163')
    }, { timeout: 20_000 })
    expect(authenticator.prompts).toEqual(['register', 'assert', 'assert'])
    expect(await headNow()).toMatchObject({ ballId: next.ballId, epoch: 163 })
  }, 60_000)

  it('one approval at a time: while the chat card runs Touch ID for her staged Pearl, Sovereignty asks for nothing', async () => {
    const { next, staged, headNow } = await edge()
    const authenticator = softwareAuthenticator(new URL(EDGE).hostname)
    await bindOwner()
    const chat = await mountChat(homeReader(staged))
    await waitFor(() => { expect(chat.kind()).toBe('home-pearl') }, { timeout: 20_000 })
    const { container } = mountSecondWindow(staged)
    const promote = () => container.querySelector<HTMLButtonElement>('[data-sovereignty-promote]')
    await waitFor(() => { expect(promote()?.disabled).toBe(false) }, { timeout: 20_000 })
    authenticator.hooks.beforeAssert = async () => {
      fireEvent.click(promote() as HTMLButtonElement)
      await waitFor(() => {
        expect(container.querySelector('[data-sovereignty-promotion-outcome]')?.textContent)
          .toContain('Another card on this page is approving this Pearl')
      })
    }
    fireEvent.click(chat.approve() as HTMLButtonElement)
    await waitFor(() => { expect(chat.outcome()?.getAttribute('data-fingerprint-outcome')).toBe('done') }, { timeout: 20_000 })
    expect(authenticator.prompts).toEqual(['register', 'assert', 'assert'])
    expect(await headNow()).toMatchObject({ ballId: next.ballId, epoch: 163 })
  }, 60_000)

  it('SAFARI: her staged Pearl after a re-check, the browser refuses the sheet; one more tap goes straight to Touch ID', async () => {
    const { next, staged, sent, headNow } = await edge()
    const authenticator = softwareAuthenticator(new URL(EDGE).hostname)
    await bindOwner()
    const chat = await mountChat(homeReader(staged))
    await waitFor(() => { expect(chat.kind()).toBe('home-pearl') }, { timeout: 20_000 })
    // The card has been open a while: the tap reads her file and HEAD again first, and Safari then will not open the sheet.
    ageCards()
    authenticator.hooks.beforeAssert = async () => {
      throw new DOMException('The request is not allowed by the user agent.', 'NotAllowedError')
    }
    fireEvent.click(chat.approve() as HTMLButtonElement)
    await waitFor(() => { expect(chat.outcome()?.textContent).toBe(TAP_AGAIN) }, { timeout: 20_000 })
    expect(await headNow()).toMatchObject({ epoch: 162 })
    await waitFor(() => { expect(chat.approve()?.disabled).toBe(false) })
    // One more tap: the check is current, so nothing runs before the challenge, and her Pearl lands.
    const before = sent.length
    fireEvent.click(chat.approve() as HTMLButtonElement)
    await waitFor(() => { expect(chat.outcome()?.getAttribute('data-fingerprint-outcome')).toBe('done') }, { timeout: 20_000 })
    expect(sent.slice(before)[0]).toMatchObject({ method: 'POST', path: '/_host/aumlok/challenge' })
    expect(sent.slice(before).some(call => call.method === 'POST' && call.path === '/_head/ball')).toBe(true)
    expect(authenticator.prompts).toEqual(['register', 'assert', 'assert', 'assert'])
    expect(await headNow()).toMatchObject({ ballId: next.ballId, epoch: 163 })
  }, 60_000)

  it('a host without HEAD\'s promotion route (404) offers no home Pearl in the chat, nor reads it; her outward request still shows', async () => {
    const { staged } = await edge()
    softwareAuthenticator(new URL(EDGE).hostname)
    await bindOwner()
    const pageFetch = globalThis.fetch
    let asked = 0
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      if (urlOf(input) !== '/_head/promotion-status') return pageFetch(input, init)
      asked += 1
      return new Response('nope', { status: 404 })
    })
    const reader = homeReader(staged, outwardIssue('Shown without the promotion route').file)
    const chat = await mountChat(reader)
    // The Mac host serves outward requests but not HEAD's promotion route: the outward side never waits on it.
    await waitFor(() => { expect(chat.kind()).toBe('outward') }, { timeout: 20_000 })
    await waitFor(() => { expect(asked).toBeGreaterThan(0) })
    await waitFor(() => { expect(FakeSocket.open.filter(s => !s.closed).length).toBeGreaterThan(0) })
    // Live changes to her staged Pearl read the card again, each time HEAD's answer first.
    for (let round = 0; round < 2; round += 1) {
      const before = asked
      push({ type: 'mirror:updated', changedPaths: ['home/auma/staged/head-promotion.json'] })
      await waitFor(() => { expect(asked).toBeGreaterThan(before) }, { timeout: 20_000 })
    }
    await new Promise((resolve) => { setTimeout(resolve, 300) })
    // COST (Lane B3 review, B3-2): HEAD answered it has no such route, so her staged Pearl (up to 4 MiB) is never read here:
    // Sovereignty shows it, with the host's own reason. One item only.
    expect(reader.reads.filter(path => path === STAGED_PROMOTION_PATH)).toEqual([])
    expect(reader.reads).toContain(STAGED_OUTWARD_PATH)
    expect(chat.kind()).toBe('outward')
    expect(chat.card()?.textContent).not.toMatch(COUNT)
  }, 60_000)

  it('her outward request sent from the chat goes out once, and neither card offers it again', async () => {
    const { posted, networkFetch } = githubStub()
    const { staged, sent } = await edge({ networkFetch, extraEnv: { GITHUB_TOKEN: 'test-github-token' } })
    const authenticator = softwareAuthenticator(new URL(EDGE).hostname)
    await bindOwner()
    const { args, file } = outwardIssue('Sent from the chat card')
    const chat = await mountChat(homeReader(undefined, file))
    await waitFor(() => { expect(chat.kind()).toBe('outward') }, { timeout: 20_000 })
    expect(chat.line()).toBe('GitHub: a new issue in your_org_x/your-node')
    expect(chat.approve()?.textContent).toBe('Approve with Touch ID and Send')
    // EVERY BYTE THE TAP SENDS IS ON THE CARD BEFORE IT (Lane B3 review, B3-1): the title and the whole text, under the
    // words Sovereignty's card uses, above the button.
    const rows = chat.card()?.querySelector('[data-fingerprint-outward-rows]') ?? null
    expect(rows?.textContent).toContain(
      'Touch ID approves exactly these bytes, once. The page then sends them, and the host checks they are the same.')
    expect(outwardRow(chat.card(), 'posts')).toBe('a new issue')
    expect(outwardRow(chat.card(), 'title')).toBe(args.body.title)
    expect(outwardRow(chat.card(), 'text')).toBe(args.body.body)
    expect(outwardRow(chat.card(), 'text')).toBe('Staged for Lane B3: Sent from the chat card.')
    expect(outwardRow(chat.card(), 'request')).toMatch(/^POST \/_host\/github · \d+ bytes$/u)
    expect(rows !== null && rows.compareDocumentPosition(chat.approve() as Node) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // Sovereignty is open on the same request in this page.
    const { container } = mountSovereignty(staged, file)
    const sovereignApprove = () => container.querySelector<HTMLButtonElement>('[data-outward-approve]')
    await waitFor(() => { expect(sovereignApprove()?.disabled).toBe(false) }, { timeout: 20_000 })
    // Sovereignty's own opening reads are still landing: wait until the page asks nothing for a moment, so the first
    // request counted after the tap is the tap's own.
    await waitFor(async () => {
      const count = sent.length
      await new Promise((resolve) => { setTimeout(resolve, 250) })
      expect(sent.length).toBe(count)
    }, { timeout: 20_000 })
    const before = sent.length
    const prompts = authenticator.prompts.length
    fireEvent.click(chat.approve() as HTMLButtonElement)
    await waitFor(() => { expect(chat.outcome()?.getAttribute('data-fingerprint-outcome')).toBe('done') }, { timeout: 20_000 })
    expect(chat.outcome()?.textContent).toContain('https://github.com/your_org_x/your-node/issues/51')
    expect(sent.slice(before)[0]).toMatchObject({ method: 'POST', path: '/_host/aumlok/challenge' })
    expect(authenticator.prompts.slice(prompts)).toEqual(['assert'])
    expect(posted).toEqual([{ url: 'https://api.github.com/repos/your_org_x/your-node/issues', method: 'POST', body: args.body }])
    // A post has no idempotency key: once sent, no card on this page offers it again.
    await waitFor(() => { expect(chat.approve()).toBeNull() })
    await waitFor(() => { expect(sovereignApprove()).toBeNull() })
    expect(posted).toHaveLength(1)
  }, 60_000)

  it('with localStorage refused (a private window), a request sent from the chat is still never offered again on this page', async () => {
    const { posted, networkFetch } = githubStub()
    const { staged } = await edge({ networkFetch, extraEnv: { GITHUB_TOKEN: 'test-github-token' } })
    softwareAuthenticator(new URL(EDGE).hostname)
    await bindOwner()
    const refuse = () => { throw new DOMException('The operation is insecure.', 'SecurityError') }
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(refuse)
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(refuse)
    const { file } = outwardIssue('Sent with storage refused')
    const chat = await mountChat(homeReader(undefined, file))
    const { container } = mountSovereignty(staged, file)
    const sovereignApprove = () => container.querySelector<HTMLButtonElement>('[data-outward-approve]')
    await waitFor(() => { expect(chat.kind()).toBe('outward') }, { timeout: 20_000 })
    await waitFor(() => { expect(sovereignApprove()?.disabled).toBe(false) }, { timeout: 20_000 })
    fireEvent.click(chat.approve() as HTMLButtonElement)
    await waitFor(() => { expect(chat.outcome()?.getAttribute('data-fingerprint-outcome')).toBe('done') }, { timeout: 20_000 })
    await waitFor(() => { expect(sovereignApprove()).toBeNull() })
    expect(chat.approve()).toBeNull()
    expect(posted).toHaveLength(1)
    // A card opened later on this page reads the same in-memory record.
    cleanup()
    const later = await mountChat(homeReader(undefined, file))
    await new Promise((resolve) => { setTimeout(resolve, 300) })
    expect(later.approve()).toBeNull()
  }, 60_000)

  it('one approval at a time: while Sovereignty runs Touch ID for her request, the chat card asks for nothing; one post', async () => {
    const { posted, networkFetch } = githubStub()
    const { staged } = await edge({ networkFetch, extraEnv: { GITHUB_TOKEN: 'test-github-token' } })
    const authenticator = softwareAuthenticator(new URL(EDGE).hostname)
    await bindOwner()
    const { file } = outwardIssue('Locked by Sovereignty')
    const chat = await mountChat(homeReader(undefined, file))
    const { container } = mountSovereignty(staged, file)
    const card = () => container.querySelector('[data-sovereignty-portal="outward"]')
    const sovereignApprove = () => card()?.querySelector<HTMLButtonElement>('[data-outward-approve]') ?? null
    await waitFor(() => { expect(chat.kind()).toBe('outward') }, { timeout: 20_000 })
    await waitFor(() => { expect(sovereignApprove()?.disabled).toBe(false) }, { timeout: 20_000 })
    const prompts = authenticator.prompts.length
    authenticator.hooks.beforeAssert = async () => {
      fireEvent.click(chat.approve() as HTMLButtonElement)
      await waitFor(() => { expect(chat.outcome()?.textContent).toContain('Another card on this page') })
    }
    fireEvent.click(sovereignApprove() as HTMLButtonElement)
    await waitFor(() => { expect(card()?.querySelector('[data-outward-outcome]')?.getAttribute('data-outward-outcome')).toBe('sent') },
      { timeout: 20_000 })
    expect(authenticator.prompts.slice(prompts)).toEqual(['assert'])
    expect(posted).toHaveLength(1)
    // Sovereignty's send is the page's record too: the chat card stops offering it.
    await waitFor(() => { expect(chat.approve()).toBeNull() })
    // Its "another card is approving" line was about that approval only (Lane B3 review, refactor B3-2): once it is over,
    // the chat card reads again, nothing waits, and the card goes.
    await waitFor(() => { expect(chat.card()).toBeNull() })
  }, 60_000)

  it('one approval at a time: while the chat card runs Touch ID for her request, Sovereignty says so and asks for nothing', async () => {
    const { posted, networkFetch } = githubStub()
    const { staged } = await edge({ networkFetch, extraEnv: { GITHUB_TOKEN: 'test-github-token' } })
    const authenticator = softwareAuthenticator(new URL(EDGE).hostname)
    await bindOwner()
    const { file } = outwardIssue('Locked by the chat card')
    const chat = await mountChat(homeReader(undefined, file))
    const { container } = mountSovereignty(staged, file)
    const card = () => container.querySelector('[data-sovereignty-portal="outward"]')
    const sovereignApprove = () => card()?.querySelector<HTMLButtonElement>('[data-outward-approve]') ?? null
    await waitFor(() => { expect(chat.kind()).toBe('outward') }, { timeout: 20_000 })
    await waitFor(() => { expect(sovereignApprove()?.disabled).toBe(false) }, { timeout: 20_000 })
    const prompts = authenticator.prompts.length
    authenticator.hooks.beforeAssert = async () => {
      fireEvent.click(sovereignApprove() as HTMLButtonElement)
      await waitFor(() => {
        expect(card()?.querySelector('[data-outward-outcome]')?.textContent)
          .toBe('Another card on this page is approving this request right now; nothing more was asked.')
      })
    }
    fireEvent.click(chat.approve() as HTMLButtonElement)
    await waitFor(() => { expect(chat.outcome()?.getAttribute('data-fingerprint-outcome')).toBe('done') }, { timeout: 20_000 })
    expect(authenticator.prompts.slice(prompts)).toEqual(['assert'])
    expect(posted).toHaveLength(1)
    // Its "another card is approving" line was about the chat card's approval only (Lane B3 review, refactor B3-2): once
    // that is over, Sovereignty's card reads again, nothing waits and no outcome of its own is left, so the card goes.
    await waitFor(() => { expect(card()).toBeNull() })
  }, 60_000)

  it('her outward request\'s rows show before the tap: a long text whole, in a box of its own that scrolls', async () => {
    await edge()
    softwareAuthenticator(new URL(EDGE).hostname)
    await bindOwner()
    const text = Array.from({ length: 120 }, (_, n) => `Line ${String(n + 1)}: every byte of this comment is shown before Touch ID.`)
      .join('\n')
    const args = { action: 'api', method: 'POST', endpoint: 'repos/your_org_x/your-node/issues/7/comments', body: { body: text } }
    const file = JSON.stringify({ schema: STAGED_OUTWARD_SCHEMA, stagedAt: Date.now(), tool: 'x6_github', method: 'POST',
      pathname: '/_host/github', body: args })
    const chat = await mountChat(homeReader(undefined, file))
    await waitFor(() => { expect(chat.kind()).toBe('outward') }, { timeout: 20_000 })
    expect(chat.line()).toBe('GitHub: a comment on issue #7 in your_org_x/your-node')
    const rows = chat.card()?.querySelector('[data-fingerprint-outward-rows]')
    expect([...(rows?.querySelectorAll('[data-fingerprint-outward-row]') ?? [])].map(row => row.getAttribute('data-fingerprint-outward-row')))
      .toEqual(['posts', 'text', 'request'])
    expect(outwardRow(chat.card(), 'posts')).toBe('a comment on issue #7')
    // The whole text, line breaks kept: nothing is cut.
    expect(outwardRow(chat.card(), 'text')).toBe(text)
    const box = rows?.querySelector<HTMLElement>('[data-fingerprint-outward-row="text"] [data-fingerprint-outward-value]')
    expect([box?.style.maxHeight, box?.style.overflow, box?.style.whiteSpace]).toEqual(['180px', 'auto', 'pre-wrap'])
    expect(outwardRow(chat.card(), 'request')).toMatch(/^POST \/_host\/github · \d+ bytes$/u)
  }, 60_000)

  it('her Pearl left over from a landing, HEAD holding none: reads never fetch /_head/ball, and a commit reads once', async () => {
    const { next, staged, calls, headNow } = await edge()
    softwareAuthenticator(new URL(EDGE).hostname)
    await bindOwner()
    const chat = await mountChat(homeReader(staged))
    await waitFor(() => { expect(chat.kind()).toBe('home-pearl') }, { timeout: 20_000 })
    fireEvent.click(chat.approve() as HTMLButtonElement)
    await waitFor(() => { expect(chat.outcome()?.getAttribute('data-fingerprint-outcome')).toBe('done') }, { timeout: 20_000 })
    expect(await headNow()).toMatchObject({ ballId: next.ballId, epoch: 163 })
    expect(await heldNow()).toBeNull()
    // Her worker never removes her staged file: it is on HEAD now, so nothing waits.
    await waitFor(() => { expect(chat.approve()).toBeNull() }, { timeout: 20_000 })
    await new Promise((resolve) => { setTimeout(resolve, 300) })
    chat.unmount()
    // A chat card opened after the landing (a reload, another window), her leftover file in its home.
    const before = calls.length
    const later = await mountChat(homeReader(staged))
    await waitFor(() => { expect(countOf(calls.slice(before), 'GET /_head/lease')).toBe(1) }, { timeout: 20_000 })
    await waitFor(() => { expect(FakeSocket.open.filter(s => !s.closed).length).toBeGreaterThan(0) })
    // Live changes read the card again; each read reads her file and HEAD's lease answer, which names her Pearl as HEAD's.
    for (const message of [{ type: 'mirror:updated', changedPaths: ['home/auma/staged/head-promotion.json'] }, { type: 'head:staged' },
      { type: 'mirror:updated', changedPaths: null }]) {
      const leases = countOf(calls, 'GET /_head/lease')
      push(message)
      await waitFor(() => { expect(countOf(calls, 'GET /_head/lease')).toBeGreaterThan(leases) }, { timeout: 20_000 })
    }
    // A commit from elsewhere reads once: with no Pearl from her home offered, its follow-ups (1.5 s, 5 s) are not armed.
    const statusReads = countOf(calls, 'GET /_head/promotion-status')
    push({ type: 'ball:commit' })
    await waitFor(() => { expect(countOf(calls, 'GET /_head/promotion-status')).toBe(statusReads + 1) }, { timeout: 20_000 })
    await new Promise((resolve) => { setTimeout(resolve, 1_800) })
    expect(countOf(calls, 'GET /_head/promotion-status')).toBe(statusReads + 1)
    // COST (Lane B3 review, B3-2): the published head, which carries every module's code, was never read for her leftover,
    // not even once.
    expect(countOf(calls.slice(before), 'GET /_head/lease')).toBeGreaterThanOrEqual(5)
    expect(countOf(calls.slice(before), 'GET /_head/ball')).toBe(0)
    expect(later.card()).toBeNull()
  }, 60_000)

  it('HEAD holding a Pearl: the published head is read once for that head, not on every read', async () => {
    const { staged, calls } = await edge()
    softwareAuthenticator(new URL(EDGE).hostname)
    await bindOwner()
    expect((await stageOnHead(staged)).body.ok).toBe(true)
    const chat = await mountChat(homeReader())
    await waitFor(() => { expect(chat.kind()).toBe('pearl') }, { timeout: 20_000 })
    await waitFor(() => { expect(FakeSocket.open.filter(s => !s.closed).length).toBeGreaterThan(0) })
    expect(countOf(calls, 'GET /_head/ball')).toBe(1)
    for (let round = 0; round < 3; round += 1) {
      const leases = countOf(calls, 'GET /_head/lease')
      push({ type: 'head:staged' })
      await waitFor(() => { expect(countOf(calls, 'GET /_head/lease')).toBeGreaterThan(leases) }, { timeout: 20_000 })
    }
    await new Promise((resolve) => { setTimeout(resolve, 300) })
    // Three more reads, each classifying HEAD's Pearl against the same head (HEAD's lease answer names it): read once.
    expect(countOf(calls, 'GET /_head/ball')).toBe(1)
    expect(chat.kind()).toBe('pearl')
  }, 60_000)

  it('HEAD takes another Pearl to hold inside the fresh window: the next tap reads again first, and asks no passkey', async () => {
    const { staged, stagedOther, genesis, headNow } = await edge()
    const authenticator = softwareAuthenticator(new URL(EDGE).hostname)
    await bindOwner()
    expect((await stageOnHead(staged)).body.ok).toBe(true)
    const other = (JSON.parse(stagedOther) as { body: { ball: { ballId: string } } }).body.ball.ballId
    const chat = await mountChat(homeReader())
    await waitFor(() => { expect(chat.kind()).toBe('pearl') }, { timeout: 20_000 })
    await waitFor(() => { expect(FakeSocket.open.filter(s => !s.closed).length).toBeGreaterThan(0) })
    // Auma stages another Epoch 163 on HEAD in its place seconds after the card read HEAD's (well inside FRESH_CHECK_MS);
    // the host says so on its socket, and the owner taps before the card has read it again.
    const replacing = JSON.stringify({ ...(JSON.parse(stagedOther) as Record<string, unknown>), replaceStaged: true })
    expect((await stageOnHead(replacing)).body.ok).toBe(true)
    push({ type: 'head:staged' })
    fireEvent.click(chat.approve() as HTMLButtonElement)
    await waitFor(() => { expect(chat.outcome()?.textContent).toContain('Checked again just now') }, { timeout: 20_000 })
    expect(chat.outcome()?.getAttribute('data-fingerprint-outcome')).toBe('refused')
    // No passkey for the Pearl HEAD no longer holds, and nothing landed; the card shows the one HEAD holds now.
    expect(authenticator.prompts).toEqual(['register', 'assert'])
    expect(await headNow()).toMatchObject({ ballId: genesis.ballId, epoch: 162 })
    await waitFor(() => { expect(chat.line()).toContain(`(${other.slice(0, 8)}…)`) }, { timeout: 20_000 })
  }, 60_000)

  it('an approval\'s outcome stays above the next item until ×: the Pearl lands, and her outward request comes next', async () => {
    const { next, staged, headNow } = await edge()
    softwareAuthenticator(new URL(EDGE).hostname)
    await bindOwner()
    const chat = await mountChat(homeReader(staged, outwardIssue('Waiting behind the Pearl').file))
    await waitFor(() => { expect(chat.kind()).toBe('home-pearl') }, { timeout: 20_000 })
    await waitFor(() => { expect(chat.card()?.textContent).toContain('· 2 waiting') }, { timeout: 20_000 })
    fireEvent.click(chat.approve() as HTMLButtonElement)
    // The Pearl lands and her file is left on HEAD, so her request is the item now: the outcome stays, above it.
    await waitFor(() => { expect(chat.kind()).toBe('outward') }, { timeout: 20_000 })
    const outcome = chat.outcome()
    expect(outcome?.getAttribute('data-fingerprint-outcome')).toBe('done')
    expect(outcome?.textContent).toContain('HEAD took it: epoch 163')
    const line = chat.card()?.querySelector('[data-fingerprint-line]') ?? null
    expect(line?.textContent).toBe('GitHub: a new issue in your_org_x/your-node')
    expect(outcome !== null && line !== null && outcome.compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(await headNow()).toMatchObject({ ballId: next.ballId, epoch: 163 })
    // × closes the outcome; her request, which the owner has not looked at yet, stays.
    fireEvent.click(chat.card()?.querySelector('[data-fingerprint-dismiss]') as HTMLButtonElement)
    expect(chat.outcome()).toBeNull()
    expect(chat.kind()).toBe('outward')
    expect(chat.approve()?.textContent).toBe('Approve with Touch ID and Send')
  }, 60_000)

  it('× hides a Pearl as a Pearl: dismissed from her home, it stays hidden when the card flips to HEAD\'s record of it', async () => {
    const { next, staged } = await edge()
    softwareAuthenticator(new URL(EDGE).hostname)
    await bindOwner()
    let onDisk = staged
    const chat = await mountChat(homeReader(() => onDisk))
    // A second chat card on the page, never dismissed: it shows what the merge of the two sources offers.
    const control = await mountChat(homeReader(() => onDisk))
    await waitFor(() => { expect(chat.kind()).toBe('home-pearl') }, { timeout: 20_000 })
    await waitFor(() => { expect(control.kind()).toBe('home-pearl') }, { timeout: 20_000 })
    expect(chat.line()).toContain('staged in this window only')
    fireEvent.click(chat.card()?.querySelector('[data-fingerprint-dismiss]') as HTMLButtonElement)
    expect(chat.card()).toBeNull()
    await waitFor(() => { expect(FakeSocket.open.filter(s => !s.closed).length).toBeGreaterThan(0) })
    // HEAD takes the same Pearl to hold, and her file's copy gains a fault of its own (it names an older head): by
    // Sovereignty's rule the card now offers HEAD's record of the same Pearl.
    expect((await stageOnHead(staged)).body.ok).toBe(true)
    const file = JSON.parse(staged) as { body: Record<string, unknown> }
    onDisk = JSON.stringify({ ...file, body: { ...file.body, expectedEpoch: 161 } })
    push({ type: 'head:staged' })
    push({ type: 'mirror:updated', changedPaths: ['home/auma/staged/head-promotion.json'] })
    await waitFor(() => { expect(control.kind()).toBe('pearl') }, { timeout: 20_000 })
    expect(control.line()).toBe(`Epoch 163 · seed-receipts (${next.ballId.slice(0, 8)}…)`)
    await new Promise((resolve) => { setTimeout(resolve, 300) })
    // The dismissed card: the same Pearl from another source stays hidden for this page.
    expect(chat.card()).toBeNull()
  }, 60_000)
})

// ── Lane B3: the staged card's "View code diff" row, read from the real edge's own answers ─────────────────────────────
const diffHook = (container: HTMLElement) => container.querySelector('[data-sovereignty-code-diff]')
const diffState = (container: HTMLElement) => diffHook(container)?.getAttribute('data-sovereignty-code-diff')
const diffSources = (container: HTMLElement) => container.querySelector('[data-code-diff-sources]')?.textContent ?? ''
/** Open the row as the owner opens it (a click on an open row would close it). */
const openDiffRow = (container: HTMLElement) => {
  const head = diffHook(container)?.closest('button')
  if (head instanceof HTMLButtonElement && head.getAttribute('aria-expanded') !== 'true') fireEvent.click(head)
}
const diffLine = (container: HTMLElement, kind: 'del' | 'add') => container.querySelector(`[data-sovereignty-code-diff-body] .ak-diff__${kind}`)?.textContent

describe('Lane B3: the staged card shows the organ code diff', () => {
  it('her staged file: "+1 / −1 lines", the code it runs now from the published Pearl, the new code from hers; it still lands', async () => {
    const { next, staged, calls, sent, headNow } = await edge()
    const authenticator = softwareAuthenticator(new URL(EDGE).hostname)
    await bindOwner()
    const before = calls.length
    const { container } = mountSovereignty(staged)
    await openCard(container, 'HEAD could take it: waits for your passkey')
    await waitFor(() => { expect(diffState(container)).toBe('ok') }, { timeout: 20_000 })
    expect(diffHook(container)?.textContent).toBe('+1 / −1 lines')
    expect([diffHook(container)?.getAttribute('data-code-diff-added'), diffHook(container)?.getAttribute('data-code-diff-removed')]).toEqual(['1', '1'])
    // Closed until opened; opened, Pearl 162's line is removed and 63's added, each side said by where it was read.
    expect(container.querySelector('[data-sovereignty-code-diff-body]')).toBeNull()
    openDiffRow(container)
    await waitFor(() => { expect(diffLine(container, 'add')).toContain('version: 163') })
    expect(diffLine(container, 'del')).toContain('"seed-receipts", version: 162')
    expect(diffSources(container)).toContain('the code it runs now: from the published Pearl')
    expect(diffSources(container)).toContain('the new code: from the staged Pearl')
    // NO REQUEST OF ITS OWN: the opening's one `/_head/ball` read carries the code it runs now.
    expect(calls.slice(before).filter(call => call === 'GET /_head/ball')).toHaveLength(1)
    // The approval is untouched: one Touch ID, nothing run between the tap and its challenge, and HEAD commits 163.
    const approve = () => container.querySelector<HTMLButtonElement>('[data-sovereignty-promote]')
    await waitFor(() => { expect(approve()?.disabled).toBe(false) }, { timeout: 20_000 })
    const tapped = sent.length
    fireEvent.click(approve() as HTMLButtonElement)
    await waitFor(() => {
      expect(container.querySelector('[data-sovereignty-promotion-outcome]')?.getAttribute('data-sovereignty-promotion-outcome')).toBe('ok')
    }, { timeout: 20_000 })
    expect(sent.slice(tapped)[0]).toMatchObject({ method: 'POST', path: '/_host/aumlok/challenge' })
    expect(authenticator.prompts).toEqual(['register', 'assert', 'assert'])
    expect(await headNow()).toMatchObject({ ballId: next.ballId, epoch: 163 })
  }, 60_000)

  it('a Pearl HEAD holds, in a window with no staged file: the new code from HEAD\'s own staged record, no extra head read', async () => {
    const { staged, calls } = await edge()
    softwareAuthenticator(new URL(EDGE).hostname)
    await bindOwner()
    expect((await stageOnHead(staged)).body.ok).toBe(true)
    const before = calls.length
    const { container } = mountSecondWindow()
    const card = await openCard(container, 'HEAD could take it: waits for your passkey')
    expect(card()?.getAttribute('data-sovereignty-promotion-source')).toBe('head')
    await waitFor(() => { expect(diffState(container)).toBe('ok') }, { timeout: 20_000 })
    expect(diffHook(container)?.textContent).toBe('+1 / −1 lines')
    openDiffRow(container)
    await waitFor(() => { expect(diffLine(container, 'add')).toContain('version: 163') })
    expect(diffSources(container)).toContain('the code it runs now: from the published Pearl')
    expect(diffSources(container)).toContain('the new code: from the staged Pearl')
    expect(calls.slice(before).filter(call => call === 'GET /_head/ball')).toHaveLength(1)
  }, 60_000)

  it('a new organ HEAD holds: "+1 / −0 lines", the code it runs now said as none (a new organ)', async () => {
    const { genesis } = await edge()
    softwareAuthenticator(new URL(EDGE).hostname)
    await bindOwner()
    const codes = { 'seed-receipts': codeOf('seed-receipts', 162), 'auma-notes': codeOf('auma-notes', 1), 'seed-continuity': codeOf('seed-continuity', 1) }
    const declared = await ballOf(genesis.ballId, 163, codes, 'auma-writer', true, (entries) => {
      const organ = entries['seed-continuity']
      if (organ !== undefined) organ.config = { governance: true }
    })
    const file = JSON.stringify({ schema: 'aukora.staged-head-promotion.v1', stagedAt: Date.now(), body: { ball: declared,
      codeBySha: { [hex(codes['seed-continuity'])]: codes['seed-continuity'] }, expectedParentBallId: genesis.ballId,
        expectedEpoch: 162 } })
    expect((await stageOnHead(file)).body.ok).toBe(true)
    const { container } = mountSecondWindow()
    await openCard(container, 'seed-continuity · epoch 163 · HEAD could take it: waits for your passkey')
    await waitFor(() => { expect(diffState(container)).toBe('ok') }, { timeout: 20_000 })
    expect(diffHook(container)?.textContent).toBe('+1 / −0 lines')
    openDiffRow(container)
    await waitFor(() => { expect(diffLine(container, 'add')).toContain('"seed-continuity", version: 1') })
    expect(diffSources(container)).toContain('the code it runs now: none (a new organ)')
    expect(diffSources(container)).toContain('the new code: from the staged Pearl')
  }, 60_000)

  it('a Pearl going back to code the head already holds: HEAD leaves it out of its compact map, the published Pearl serves it', async () => {
    const { genesis } = await edge()
    softwareAuthenticator(new URL(EDGE).hostname)
    await bindOwner()
    // seed-receipts set to the module auma-notes runs: a sha already in the published head's modules.
    const held = codeOf('auma-notes', 1)
    const codes = { 'seed-receipts': held, 'auma-notes': held }
    const back = await ballOf(genesis.ballId, 163, codes, 'auma-writer', true)
    const file = JSON.stringify({ schema: 'aukora.staged-head-promotion.v1', stagedAt: Date.now(), body: { ball: back,
      codeBySha: { [hex(held)]: held }, expectedParentBallId: genesis.ballId, expectedEpoch: 162 } })
    expect((await stageOnHead(file)).body.ok).toBe(true)
    const record = await heldNow() as { envelope?: { body?: { codeBySha?: Record<string, unknown> } } } | null
    expect(record?.envelope?.body?.codeBySha).toEqual({})
    const { container } = mountSecondWindow()
    const card = await openCard(container, 'seed-receipts · epoch 163')
    expect(card()?.getAttribute('data-sovereignty-promotion-source')).toBe('head')
    await waitFor(() => { expect(diffState(container)).toBe('ok') }, { timeout: 20_000 })
    expect(diffHook(container)?.textContent).toBe('+1 / −1 lines')
    openDiffRow(container)
    await waitFor(() => { expect(diffLine(container, 'add')).toContain('"auma-notes", version: 1') })
    expect(diffLine(container, 'del')).toContain('"seed-receipts", version: 162')
    expect(diffSources(container)).toContain('the new code: from the published Pearl')
  }, 60_000)

  it('the row follows the Pearl on the card: Auma stages another in its place (Round 31), and that one is compared', async () => {
    const { staged, stagedOther } = await edge()
    softwareAuthenticator(new URL(EDGE).hostname)
    await bindOwner()
    const other = (JSON.parse(stagedOther) as { body: { ball: { ballId: string } } }).body.ball.ballId
    let onDisk = staged
    const { container } = mountSovereignty(() => onDisk)
    const card = await openCard(container, 'HEAD could take it: waits for your passkey')
    await waitFor(() => { expect(diffState(container)).toBe('ok') }, { timeout: 20_000 })
    openDiffRow(container)
    await waitFor(() => { expect(diffLine(container, 'add')).toContain('version: 163 }') })
    await waitFor(() => { expect(FakeSocket.open.filter(s => !s.closed).length).toBeGreaterThan(0) })
    onDisk = stagedOther
    push({ type: 'mirror:updated', changedPaths: ['home/auma/staged/head-promotion.json'] })
    await waitFor(() => { expect(card()?.textContent).toContain(other) }, { timeout: 20_000 })
    await waitFor(() => {
      openDiffRow(container)
      expect(diffLine(container, 'add')).toContain('version: 6300')
    }, { timeout: 20_000 })
    expect(diffHook(container)?.textContent).toBe('+1 / −1 lines')
    expect(diffLine(container, 'del')).toContain('version: 162')
  }, 60_000)
})
