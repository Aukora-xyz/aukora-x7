// @vitest-environment jsdom
/**
 * Human vouching (aukora.invite.v1) issued and revoked from the Identity screen, against the REAL edge AUMLOK store.
 *
 * The page's own code (the Identity surface, its invite desk, the AUMLOK ceremony) talks through `fetch` to the real
 * Worker (`createWorker`) and the real HEAD Durable Object built with two arguments as Cloudflare builds it, with an
 * owner session cookie, in-memory storage, and a software authenticator that signs real WebAuthn bytes (P-256) for this
 * origin. The harness is the minimal part of `r29-edge-e2e.client.spec.tsx`, copied rather than shared: nothing on the
 * host side is stubbed. The owner binds with known words through the page's own ceremony, then types them into the
 * invite panel's tiles.
 *
 * Run it from the repository root of a full `pnpm install` (the edge's aumlok.mjs imports `@simplewebauthn/server`):
 *   ./node_modules/.bin/vitest run packages/client/ui-layout/tests/identity-invite-issue.client.spec.tsx
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { createHash, createPublicKey, generateKeyPairSync, randomBytes, sign, verify, type KeyObject } from 'node:crypto'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { IDENTITY_SURFACE, IdentitySurface } from '../src/client/spatial/apps/identity/IdentitySurface.tsx'
import { hostCall, type HostAnswer } from '../src/client/spatial/apps/identity/host.ts'
import {
  INVITE_BOOK_KEY, INVITE_CAPACITY_KEY, forgetInviteBookForTests, inviteEcho, inviteeCommitment, invitePreimage, inviteReadiness,
  inviteRefusalWords, inviteStatusOf, issueInvite, newInviteeCode, openNodeForInvite, readInviteStatus, revocationEcho, revocationPreimage,
  revokeInvite, signWithNode,
  type InvitePayload, type InviteReceipt, type InviteStatus, type RevocationPayload,
} from '../src/client/spatial/apps/identity/invite.ts'
import { fromBase64url, type PasskeyResponseJson } from '../src/client/spatial/apps/identity/webauthn.ts'
import { qrSvgDataUrl } from '../src/client/spatial/apps/identity/qr.ts'
import {
  aumlokCommitment, aumlokRequestId, createBrowserCeremony, generateAumlokPhrase, parseAumlokPhrase, readAumlokStatus,
  type AumlokHostCall, type AumlokPlatform,
} from '../src/client/spatial/aumlok/aumlok-ceremony.ts'
import { resetApprovalsForTests } from '../src/client/spatial/portal/touch-id-timing.ts'

const EDGE = 'https://invite.example.invalid'
const EMAIL = 'owner@example.invalid'
const sha = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest()
const hex = (bytes: string | Uint8Array) => sha(bytes).toString('hex')
const publicHex = (key: { publicKey: KeyObject }) => key.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex')
const b64u = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url')
const ab = (bytes: Uint8Array): ArrayBuffer => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer

// ── The edge's modules, loaded from this checkout (deploy/cloudflare/src), read-only ───────────────────────────────────
const edgePath = (file: string) => ['', '../../../'].map(prefix => resolve(process.cwd(), `${prefix}deploy/cloudflare/src/${file}`)).find(existsSync)
type Loaded = Record<string, unknown>
const load = async (file: string): Promise<Loaded> => import(pathToFileURL(edgePath(file) ?? file).href) as Promise<Loaded>
const worker = await load('worker.mjs')
const headDo = await load('head-do.mjs')
const mirrorDo = await load('mirror-do.mjs')
const aumlokModule = await load('aumlok.mjs')
const policy = await load('owner-grant-policy.mjs')
/** The host's own receipt check (deploy/cloudflare/src/aumlok.mjs), and its own canonical JSON. */
const hostVerifiesReceipt = aumlokModule.verifyAumlokInviteReceipt as (receipt: unknown, node: string) => Promise<boolean>
const hostCanonical = policy.canonicalJson as (value: unknown) => string

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
  /** Runs just before a passkey assertion is answered (a test can cancel Touch ID once). */
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
async function genesisBall(codes: Record<string, string>) {
  const entries = Object.fromEntries(Object.entries(codes).map(([id, code]) => [id,
    { id, specifier: `ball:${hex(code)}`, config: {}, disabled: false, previousSpecifiers: [] as string[] }]))
  const ball: Record<string, unknown> = { version: 'x6.1-ball/v1', parentBallId: null, epoch: 162, entries,
    modules: Object.fromEntries(Object.values(codes).map(code => [hex(code), { sha256: hex(code), specifier: `ball:${hex(code)}` }])) }
  ball.ballId = await (headDo.manifestIdCanon as (ball: unknown) => Promise<string>)(ball)
  return ball as Record<string, unknown> & { ballId: string; epoch: number }
}

/** One page request as the edge saw it. */
interface Sent { readonly method: string; readonly path: string; readonly body: Record<string, unknown> | null }

/** The edge, built as Cloudflare builds it and bootstrapped, with every page fetch routed to its Worker. */
async function edge() {
  const owner = generateKeyPairSync('ed25519')
  const storage = memoryStorage()
  const env: Record<string, unknown> = { PUBLIC_HOST: new URL(EDGE).host, OWNER_EMAIL: EMAIL, OWNER_PUBLIC_KEY_HEX: publicHex(owner) }
  const HeadClass = headDo.X61HeadDurableObject as new (state: unknown, env: unknown) => { fetch: (request: Request) => Promise<Response> }
  const MirrorClass = mirrorDo.MirrorDO as new (state: unknown) => { fetch: (request: Request) => Promise<Response> }
  const headObject = new HeadClass({ storage, getWebSockets: () => [] }, env)
  env.HEAD = { idFromName: (name: string) => name, get: () => ({ fetch: (request: Request) => headObject.fetch(request) }) }
  const mirrorStorage = memoryStorage()
  const mirror = new MirrorClass({ storage: mirrorStorage })
  env.MIRROR = { idFromName: (name: string) => name, get: () => ({ fetch: (request: Request) => mirror.fetch(request) }) }
  const app = (worker.createWorker as () => { fetch: (request: Request, env: unknown) => Promise<Response> })()
  const seconds = Math.floor(Date.now() / 1000)
  const jwt = [Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' })).toString('base64url'),
    Buffer.from(JSON.stringify({ iss: 'aukora.x61.owner', aud: env.PUBLIC_HOST, email: EMAIL, nbf: seconds - 1, exp: seconds + 3600 })).toString('base64url')]
  jwt.push(sign(null, Buffer.from(jwt.join('.')), owner.privateKey).toString('base64url'))
  const v62: Record<string, string> = { 'seed-receipts': codeOf('seed-receipts', 162), 'auma-notes': codeOf('auma-notes', 1) }
  const genesis = await genesisBall(v62)
  const seed = await (headDo.bootstrapPackage as (input: unknown) => Promise<{ seedId: string; mirror: unknown }>)({
    version: 'x61-bootstrap/v1', ball: genesis, codeBySha: Object.fromEntries(Object.values(v62).map(code => [hex(code), code])),
    mirror: { entryCount: 0, batchDigests: [] } })
  const bootstrapMirror = mirrorDo.bootstrapMirror as (storage: unknown, input: unknown) => Promise<unknown>
  await bootstrapMirror(mirrorStorage, { action: 'begin', seedId: seed.seedId, ballId: genesis.ballId, epoch: genesis.epoch, mirror: seed.mirror })
  await bootstrapMirror(mirrorStorage, { action: 'commit', seedId: seed.seedId })
  const store = (headObject as unknown as { store: {
    bootstrapPrepare: (s: unknown) => Promise<unknown>
    bootstrapCommit: (id: string, r: unknown) => Promise<{ ok: boolean }>
  } }).store
  await store.bootstrapPrepare(seed)
  expect((await store.bootstrapCommit(seed.seedId, { ok: true, phase: 'ready', seedId: seed.seedId, ballId: genesis.ballId, epoch: genesis.epoch,
    entryCount: 0, nextBatch: 0, batchCount: 0 })).ok).toBe(true)
  const sent: Sent[] = []
  const flight = { open: 0 }
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (!url.startsWith('/')) throw new Error(`the page reached outside its origin: ${url}`)
    sent.push({ method: init?.method ?? 'GET', path: url.split('?')[0] ?? url,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : null })
    const headers = new Headers(init?.headers)
    headers.set('cookie', `CF_Authorization=${jwt.join('.')}`)
    headers.set('origin', EDGE)
    headers.set('sec-fetch-site', 'same-origin')
    flight.open += 1
    try { return await app.fetch(new Request(EDGE + url, { method: init?.method ?? 'GET', headers, body: init?.body ?? null }), env) } finally {
      flight.open -= 1
    }
  }))
  return { sent, flight }
}

/** The owner's first bind through the page's own ceremony; the words come back so the test can type them. */
const bindOwner = async (): Promise<readonly string[]> => {
  const read = await readAumlokStatus(new AbortController().signal)
  const ceremony = createBrowserCeremony()
  const drawn = await ceremony.draw('bind', read.kind === 'live' ? read.status : null)
  if (!drawn.ok || drawn.words === undefined) throw new Error(`draw: ${drawn.reason ?? 'no words'}`)
  expect(await ceremony.submit('bind', drawn.words)).toMatchObject({ ok: true })
  return drawn.words
}
/** The node key the host reports now. */
const nodeKey = async (): Promise<string> => {
  const read = await readAumlokStatus(new AbortController().signal)
  if (read.kind !== 'live' || read.status.nodePubkeyHex === null) throw new Error('no node key')
  return read.status.nodePubkeyHex
}
/** A live invite status read, or the test fails. */
const liveStatus = async (): Promise<InviteStatus> => {
  const read = await readInviteStatus(new AbortController().signal)
  if (read.kind !== 'live') throw new Error(`status: ${read.kind}`)
  return read.value
}

/** The host's clock, which the AUMLOK store reads through `Date.now` (installed before the edge, so the store takes it). */
const clock = { skew: 0 }
const skewClock = (): void => {
  clock.skew = 0
  const real = Date.now.bind(Date)
  vi.spyOn(Date, 'now').mockImplementation(() => real() + clock.skew)
}
/** Let every challenge already issued expire (each lives 120 s; at most four are open at once). */
const expireChallenges = (): void => { clock.skew += 121_000 }

/** What the page put on the clipboard. */
const clipboard: string[] = []
const PROPS = { activeSurface: IDENTITY_SURFACE, closeSurface: () => {} } as unknown as Parameters<typeof IdentitySurface>[0]
const mount = () => render(<IdentitySurface {...PROPS} />)
const openInvites = async (container: HTMLElement) => {
  const head = container.querySelector('[data-identity-portal="invite"] .ak-portal__head')
  if (!(head instanceof HTMLElement)) throw new Error('no invite portal')
  fireEvent.click(head)
  await waitFor(() => { expect(container.querySelector('[data-identity-invite="live"]')).not.toBeNull() }, { timeout: 20_000 })
}
const button = (container: HTMLElement, selector: string): HTMLButtonElement | null => container.querySelector<HTMLButtonElement>(selector)
/** Wait until a control is live, with nothing in flight, then press it; returns the index of the first request it makes. */
const press = async (container: HTMLElement, selector: string, flight: { open: number }, sent: readonly Sent[]): Promise<number> => {
  await waitFor(() => {
    expect(button(container, selector)?.disabled).toBe(false)
    expect(flight.open).toBe(0)
  }, { timeout: 30_000 })
  const at = sent.length
  fireEvent.click(button(container, selector) as HTMLButtonElement)
  return at
}
const typeWords = (container: HTMLElement, words: readonly string[]) => {
  words.forEach((word, position) => {
    const tile = container.querySelector(`[data-identity-invite-panel] [data-aumlok-tile-input="${String(position)}"]`)
    if (!(tile instanceof HTMLInputElement)) throw new Error(`no tile ${String(position)}`)
    fireEvent.change(tile, { target: { value: word } })
  })
}
/** Every string the page kept in this origin's storage. */
const stored = (): string => Object.keys(localStorage).map(key => `${key}=${localStorage.getItem(key) ?? ''}`).join('\n')
/**
 * Every key or string value in a JSON tree that is one of the words, or carries two of them in a row or the whole phrase.
 * (A bare substring check would match protocol words that are also list words, such as "invite" or "platform".)
 */
const leaks = (tree: unknown, words: readonly string[]): string[] => {
  const pairs = words.slice(1).map((word, index) => `${words[index] ?? ''} ${word}`)
  const bad = (text: string): boolean => words.includes(text.toLowerCase()) || pairs.some(pair => text.toLowerCase().includes(pair))
  const found: string[] = []
  const walk = (value: unknown): void => {
    if (typeof value === 'string') { if (bad(value)) found.push(value); return }
    if (value === null || typeof value !== 'object') return
    for (const [name, child] of Object.entries(value)) { if (bad(name)) found.push(name); walk(child) }
  }
  walk(tree)
  return found
}
const ED25519_SPKI = Buffer.from('302a300506032b6570032100', 'hex')
const nodeVerifies = (node: string, preimage: string, signature: string): boolean =>
  verify(null, Buffer.from(preimage), createPublicKey({ key: Buffer.concat([ED25519_SPKI, Buffer.from(node, 'hex')]), format: 'der', type: 'spki' }),
    Buffer.from(signature, 'base64url'))

beforeEach(() => {
  ;(globalThis as { jsdom?: { reconfigure: (o: { url: string }) => void } }).jsdom?.reconfigure({ url: `${EDGE}/` })
  vi.stubGlobal('BroadcastChannel', class { onmessage = null; close() {} })
  vi.stubGlobal('WebSocket', class { onopen = null; onmessage = null; onclose = null; close() {} })
  clipboard.length = 0
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { clipboard.push(text) } } })
  localStorage.clear()
  forgetInviteBookForTests()
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  resetApprovalsForTests()
  localStorage.clear()
  forgetInviteBookForTests()
})

describe('Human vouching on the Identity screen, against the real edge AUMLOK store', () => {
  it('issues one invite with the words and two Touch ID taps; the receipt verifies with the host\'s own check', async () => {
    const { sent, flight } = await edge()
    const authenticator = softwareAuthenticator(new URL(EDGE).hostname)
    const words = await bindOwner()
    expect(authenticator.prompts).toEqual(['register', 'assert'])
    const node = await nodeKey()
    const { container } = mount()
    await openInvites(container)
    await waitFor(() => { expect(container.querySelector('[data-identity-invite-count]')?.textContent).toMatch(/^3 of 3 remaining in \d{4}-\d{2} /) })

    // The panel opens on a fresh status read; the address is normalised and checked before anything is asked.
    await press(container, '[data-identity-invite-issue]', flight, sent)
    await waitFor(() => { expect(container.querySelector('[data-identity-invite-panel="issue"]')).not.toBeNull() })
    expect(container.querySelector('[data-identity-invite-warning]')?.textContent)
      .toBe('Wrong words count against a lifetime limit. Check them before you tap.')
    const domain = container.querySelector('[data-identity-invite-domain]') as HTMLInputElement
    fireEvent.change(domain, { target: { value: 'https://Friend.Example/some/path' } })
    expect(container.querySelector('[data-identity-invite-domain-hint]')?.textContent).toBe('The invite will carry https://friend.example.')
    typeWords(container, words)
    await waitFor(() => { expect(container.querySelector('[data-identity-invite-words]')?.getAttribute('data-identity-invite-words')).toBe('ready') },
      { timeout: 30_000 })

    // TAP 1: the first request is the unseal challenge; the words leave the tiles at once.
    const tap1 = await press(container, '[data-identity-invite-open]', flight, sent)
    expect(sent[tap1]).toMatchObject({ method: 'POST', path: '/_host/aumlok/challenge', body: { purpose: 'unseal' } })
    expect(Object.keys(sent[tap1]?.body ?? {}).sort()).toEqual(['purpose', 'requestId'])
    await waitFor(() => { expect(container.querySelector('[data-identity-invite-step="open"]')).not.toBeNull() }, { timeout: 30_000 })
    expect(container.querySelectorAll('[data-identity-invite-panel] input[data-aumlok-tile-input]')).toHaveLength(0)
    const unseal = sent.slice(tap1).filter(call => call.path === '/_host/aumlok/unseal')
    expect(unseal).toHaveLength(1)
    expect(Object.keys(unseal[0]?.body ?? {}).sort()).toEqual(['challengeId', 'commitmentSha256', 'credential'])

    // TAP 2: the first request is the invite challenge with exactly the four keys; then the passkey; then the last step.
    const tap2 = await press(container, '[data-identity-invite-sign]', flight, sent)
    expect(sent[tap2]).toMatchObject({ method: 'POST', path: '/_host/aumlok/challenge',
      body: { purpose: 'invite', assignedDomainPointer: 'https://friend.example' } })
    expect(Object.keys(sent[tap2]?.body ?? {}).sort()).toEqual(['assignedDomainPointer', 'inviteeCommitmentSha256', 'purpose', 'requestId'])
    await waitFor(() => { expect(container.querySelector('[data-identity-invite-receipt]')).not.toBeNull() }, { timeout: 30_000 })
    const completes = sent.slice(tap2).filter(call => call.path === '/_host/aumlok/invite')
    expect(completes).toHaveLength(1)
    expect(Object.keys(completes[0]?.body ?? {}).sort()).toEqual(['challengeId', 'credential', 'signature'])
    // Exactly two Touch ID assertions for the invite: one to open the root, one to sign.
    expect(authenticator.prompts).toEqual(['register', 'assert', 'assert', 'assert'])

    // The receipt the page shows is the one the host recorded, and the host's own check verifies it against the node key.
    fireEvent.click(container.querySelector('[data-identity-invite-receipt] button[aria-label="Copy receipt"]') as HTMLButtonElement)
    await waitFor(() => { expect(clipboard).toHaveLength(1) })
    const json = clipboard[0] ?? ''
    const receipt = JSON.parse(json) as InviteReceipt
    expect(Object.keys(receipt).sort()).toEqual(['assignedDomainPointer', 'expiresAt', 'inviteId', 'inviteeCommitmentSha256', 'issuedAt',
      'monthlySequence', 'quotaMonth', 'revoked', 'schema', 'signature', 'sponsorPubkeyHex'])
    expect(json).toBe(hostCanonical(receipt))
    expect(await hostVerifiesReceipt(receipt, node)).toBe(true)
    expect(receipt).toMatchObject({ schema: 'aukora.invite.v1', sponsorPubkeyHex: node, assignedDomainPointer: 'https://friend.example',
      monthlySequence: 1, revoked: false })
    expect(receipt.expiresAt - receipt.issuedAt).toBe(604_800_000)
    expect(receipt.signature).toBe(completes[0]?.body?.signature)
    expect(container.querySelector('[data-identity-invite-line]')?.textContent)
      .toMatch(new RegExp(`^Invite 1 of 3 for ${receipt.quotaMonth} · expires .+ UTC · for https://friend\\.example · signed by this node’s key ${node.slice(0, 16)}…$`))
    expect(container.querySelector('[data-identity-invite-verified]')?.textContent).toContain('it verifies')

    // The invite code is the PROPOSED aukora.invite.invitee.v1 preimage of the commitment, and it is nowhere but the screen.
    const code = container.querySelector('[data-identity-invite-code-value]')?.textContent ?? ''
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(await inviteeCommitment(fromBase64url(code) ?? new Uint8Array())).toBe(receipt.inviteeCommitmentSha256)
    expect(container.querySelector('[data-identity-invite-code]')?.hasAttribute('data-private')).toBe(true)
    expect(container.querySelector('[data-identity-invite-code]')?.textContent)
      .toContain('Give this code to the person privately. It is not in the receipt and this page does not keep it.')
    expect(json).not.toContain(code)
    const qr = container.querySelector<HTMLImageElement>('[data-identity-invite-qr] img')?.getAttribute('src')
    expect(qr).toBe(qrSvgDataUrl(json, 'Q'))
    expect(stored()).not.toContain(code)
    expect(JSON.stringify(sent)).not.toContain(code)
    // The receipt (public) is what this browser keeps.
    expect(localStorage.getItem(INVITE_BOOK_KEY)).toContain(receipt.inviteId)

    // The words are in no request body and in no storage: no key or string value is a word, a pair of words, or the phrase.
    const kept = Object.keys(localStorage).map(name => JSON.parse(localStorage.getItem(name) ?? 'null') as unknown)
    expect(leaks([sent.map(call => call.body), kept], words)).toEqual([])
    expect(stored()).not.toContain(words.join(' '))
    // The count moves to 2 of 3, read from the host.
    await waitFor(() => { expect(container.querySelector('[data-identity-invite-count]')?.textContent).toMatch(/^2 of 3 remaining in /) })
    // The issued list offers this receipt for revoking (it verifies against the node key read just now).
    await waitFor(() => { expect(container.querySelector(`[data-identity-invite-row="${receipt.inviteId}"]`)?.getAttribute('data-state')).toBe('verifies') })
    // "Done" drops the code from the page.
    fireEvent.click(container.querySelector('[data-identity-invite-done]') as HTMLButtonElement)
    expect(container.textContent).not.toContain(code)
  }, 120_000)

  it('a full month disables the control with the reason in words and asks for no challenge', async () => {
    skewClock()
    const { sent, flight } = await edge()
    softwareAuthenticator(new URL(EDGE).hostname)
    const words = await bindOwner()
    expireChallenges()
    // Three invites, through the page's own module (one unseal, three signatures).
    const signal = new AbortController().signal
    const start = await liveStatus()
    const node = start.status.nodePubkeyHex ?? ''
    const parsed = parseAumlokPhrase(words)
    if (!parsed.ok) throw new Error('words')
    const commitment = await aumlokCommitment(parsed.canonical, node)
    const opened = await openNodeForInvite(parsed.canonical, commitment, start.status, aumlokRequestId(), { signal })
    if (opened.kind !== 'done') throw new Error(`open: ${JSON.stringify(opened)}`)
    for (let index = 0; index < 3; index += 1) {
      const code = await newInviteeCode()
      const request = { requestId: aumlokRequestId(), inviteeCommitmentSha256: code.commitmentSha256, assignedDomainPointer: null }
      const issued = await issueInvite(request,
        () => opened.value.signingKey, await liveStatus(), { signal })
      expect(issued.kind).toBe('done')
    }
    const before = sent.length
    const { container } = mount()
    await openInvites(container)
    await waitFor(() => { expect(container.querySelector('[data-identity-invite-count]')?.textContent).toMatch(/^0 of 3 remaining in /) })
    await waitFor(() => {
      expect(container.querySelector('[data-identity-invite-blocked]')?.textContent)
        .toMatch(/^All 3 invites for \d{4}-\d{2} are used\. Revoking one does not give it back\.$/)
    })
    expect(button(container, '[data-identity-invite-issue]')?.disabled).toBe(true)
    fireEvent.click(button(container, '[data-identity-invite-issue]') as HTMLButtonElement)
    await waitFor(() => { expect(flight.open).toBe(0) })
    expect(container.querySelector('[data-identity-invite-panel]')).toBeNull()
    // (The Nostr card's own read-only `nostr_status` probe is a POST too; it is not an AUMLOK call and counts nothing.)
    expect(sent.slice(before).filter(call => call.method === 'POST' && call.path.startsWith('/_host/aumlok/'))).toEqual([])
    expect(sent.slice(before).filter(call => call.path.startsWith('/_host/aumlok/')).map(call => call.method)).not.toContain('POST')
  }, 120_000)

  it('wrong words: the host\'s refusal is said in words, the unseal is not retried, and nothing is signed', async () => {
    const { sent, flight } = await edge()
    const authenticator = softwareAuthenticator(new URL(EDGE).hostname)
    const words = await bindOwner()
    let wrong = generateAumlokPhrase()
    while (wrong.join(' ') === words.join(' ')) wrong = generateAumlokPhrase()
    const { container } = mount()
    await openInvites(container)
    await press(container, '[data-identity-invite-issue]', flight, sent)
    await waitFor(() => { expect(container.querySelector('[data-identity-invite-panel="issue"]')).not.toBeNull() })
    typeWords(container, wrong)
    await waitFor(() => { expect(container.querySelector('[data-identity-invite-words="ready"]')).not.toBeNull() }, { timeout: 30_000 })
    const tap1 = await press(container, '[data-identity-invite-open]', flight, sent)
    await waitFor(() => {
      expect(container.querySelector('[data-identity-invite-notice]')?.textContent)
        .toBe('Those words did not match. This counts against your lifetime limit. (aumlok:AUMLOK_RECOVERY_COMMITMENT_MISMATCH)')
    }, { timeout: 30_000 })
    await waitFor(() => { expect(flight.open).toBe(0) })
    const after = sent.slice(tap1).filter(call => call.method === 'POST').map(call => call.path)
    expect(after).toEqual(['/_host/aumlok/challenge', '/_host/aumlok/unseal'])
    expect(authenticator.prompts).toEqual(['register', 'assert', 'assert'])
    expect(container.querySelector('[data-identity-invite-panel]')).toBeNull()
    expect(container.querySelector('[data-identity-invite-receipt]')).toBeNull()
    expect(localStorage.getItem(INVITE_BOOK_KEY)).toBeNull()
  }, 120_000)

  it('Touch ID that does not complete on tap 2 is asked once more with the same request, and the invite is issued once', async () => {
    const { sent, flight } = await edge()
    const authenticator = softwareAuthenticator(new URL(EDGE).hostname)
    const words = await bindOwner()
    const { container } = mount()
    await openInvites(container)
    await press(container, '[data-identity-invite-issue]', flight, sent)
    await waitFor(() => { expect(container.querySelector('[data-identity-invite-panel="issue"]')).not.toBeNull() })
    typeWords(container, words)
    await waitFor(() => { expect(container.querySelector('[data-identity-invite-words="ready"]')).not.toBeNull() }, { timeout: 30_000 })
    await press(container, '[data-identity-invite-open]', flight, sent)
    await waitFor(() => { expect(container.querySelector('[data-identity-invite-step="open"]')).not.toBeNull() }, { timeout: 30_000 })
    authenticator.hooks.beforeAssert = async () => { throw new DOMException('The request is not allowed by the user agent.', 'NotAllowedError') }
    const first = await press(container, '[data-identity-invite-sign]', flight, sent)
    await waitFor(() => {
      expect(container.querySelector('[data-identity-invite-notice]')?.textContent)
        .toBe('Touch ID did not complete: cancelled, timed out, or the browser would not open it. Nothing was sent past the request. '
          + 'Tap “Sign invite with Touch ID” once more. (Passkey cancelled or timed out. Nothing was sent.)')
    }, { timeout: 30_000 })
    const second = await press(container, '[data-identity-invite-sign]', flight, sent)
    await waitFor(() => { expect(container.querySelector('[data-identity-invite-receipt]')).not.toBeNull() }, { timeout: 30_000 })
    expect(sent[first]?.path).toBe('/_host/aumlok/challenge')
    expect(sent[second]?.path).toBe('/_host/aumlok/challenge')
    expect(sent[second]?.body).toEqual(sent[first]?.body)
    expect(sent.slice(first).filter(call => call.path === '/_host/aumlok/invite')).toHaveLength(1)
    const status = await liveStatus()
    expect(status.quota?.issued).toBe(1)
  }, 120_000)

  it('revokes the issued invite: the signed revocation verifies, it is listed as revoked, and it is not offered again', async () => {
    skewClock()
    const { sent, flight } = await edge()
    const authenticator = softwareAuthenticator(new URL(EDGE).hostname)
    const words = await bindOwner()
    expireChallenges()
    const signal = new AbortController().signal
    const start = await liveStatus()
    const node = start.status.nodePubkeyHex ?? ''
    const parsed = parseAumlokPhrase(words)
    if (!parsed.ok) throw new Error('words')
    const commitment = await aumlokCommitment(parsed.canonical, node)
    const opened = await openNodeForInvite(parsed.canonical, commitment, start.status, aumlokRequestId(), { signal })
    if (opened.kind !== 'done') throw new Error('open')
    const code = await newInviteeCode()
    const request = { requestId: aumlokRequestId(), inviteeCommitmentSha256: code.commitmentSha256, assignedDomainPointer: null }
    const issued = await issueInvite(request,
      () => opened.value.signingKey, await liveStatus(), { signal })
    if (issued.kind !== 'done') throw new Error('issue')
    const inviteId = issued.value.inviteId
    expireChallenges()
    const { container } = mount()
    await openInvites(container)
    const revoke = `[data-identity-invite-revoke="${inviteId}"]`
    await waitFor(() => { expect(container.querySelector(`[data-identity-invite-row="${inviteId}"]`)?.getAttribute('data-state')).toBe('verifies') })
    await press(container, revoke, flight, sent)
    await waitFor(() => { expect(container.querySelector('[data-identity-invite-panel="revoke"]')).not.toBeNull() })
    expect(container.querySelector('[data-identity-invite-domain]')).toBeNull()
    typeWords(container, words)
    await waitFor(() => { expect(container.querySelector('[data-identity-invite-words="ready"]')).not.toBeNull() }, { timeout: 30_000 })
    const prompts = authenticator.prompts.length
    const tap1 = await press(container, '[data-identity-invite-open]', flight, sent)
    expect(sent[tap1]).toMatchObject({ method: 'POST', path: '/_host/aumlok/challenge', body: { purpose: 'unseal' } })
    await waitFor(() => { expect(container.querySelector('[data-identity-invite-step="open"]')).not.toBeNull() }, { timeout: 30_000 })
    expect(button(container, '[data-identity-invite-sign]')?.textContent).toContain('Revoke with Touch ID')
    const tap2 = await press(container, '[data-identity-invite-sign]', flight, sent)
    expect(sent[tap2]).toMatchObject({ method: 'POST', path: '/_host/aumlok/challenge', body: { purpose: 'invite', action: 'revoke', inviteId } })
    expect(Object.keys(sent[tap2]?.body ?? {}).sort()).toEqual(['action', 'inviteId', 'purpose', 'requestId'])
    await waitFor(() => { expect(container.querySelector(`[data-identity-invite-revocation="${inviteId}"]`)).not.toBeNull() }, { timeout: 30_000 })
    expect(authenticator.prompts.length - prompts).toBe(2)
    fireEvent.click(container.querySelector('[data-identity-invite-revocation] button[aria-label="Copy revocation"]') as HTMLButtonElement)
    await waitFor(() => { expect(clipboard).toHaveLength(1) })
    const revocation = JSON.parse(clipboard[0] ?? '') as { schema: string; inviteId: string; sponsorPubkeyHex: string; revokedAt: number; signature: string }
    expect(Object.keys(revocation).sort()).toEqual(['inviteId', 'revokedAt', 'schema', 'signature', 'sponsorPubkeyHex'])
    expect(revocation).toMatchObject({ schema: 'aukora.invite-revocation.v1', inviteId, sponsorPubkeyHex: node })
    const { signature, ...payload } = revocation
    expect(nodeVerifies(node, `aukora.invite-revocation.v1\n${hostCanonical(payload)}`, signature)).toBe(true)
    expect(container.querySelector('[data-identity-invite-verified]')?.textContent).toContain('Revoking does not give this month’s invite back.')
    // Listed as revoked, and never offered again; the host counts it, and the month's quota is not given back.
    await waitFor(() => { expect(container.querySelector(`[data-identity-invite-row="${inviteId}"]`)?.getAttribute('data-state')).toBe('revoked') })
    expect(container.querySelector(revoke)).toBeNull()
    const after = await liveStatus()
    expect([after.quota?.issued, after.quota?.revoked]).toEqual([1, 1])
    await waitFor(() => { expect(container.querySelector('[data-identity-invite-count]')?.textContent).toMatch(/^2 of 3 remaining in /) })
  }, 120_000)

  it('a stored receipt whose signature does not verify is not offered for revoking, and nothing is asked', async () => {
    const { sent, flight } = await edge()
    softwareAuthenticator(new URL(EDGE).hostname)
    await bindOwner()
    const node = await nodeKey()
    const issuedAt = Date.now()
    const forged = { schema: 'aukora.invite.v1', inviteId: b64u(new Uint8Array(randomBytes(32))), sponsorPubkeyHex: node,
      inviteeCommitmentSha256: hex('someone'), assignedDomainPointer: null, quotaMonth: new Date(issuedAt).toISOString().slice(0, 7),
      monthlySequence: 1, revoked: false, issuedAt, expiresAt: issuedAt + 604_800_000, signature: b64u(new Uint8Array(randomBytes(64))) }
    localStorage.setItem(INVITE_BOOK_KEY, JSON.stringify({ schema: 'aukora.invite.issued.v1', receipts: [forged], revocations: [] }))
    const before = sent.length
    const { container } = mount()
    await openInvites(container)
    await waitFor(() => { expect(container.querySelector(`[data-identity-invite-row="${forged.inviteId}"]`)?.getAttribute('data-state')).toBe('fails') })
    expect(container.querySelector(`[data-identity-invite-revoke="${forged.inviteId}"]`)).toBeNull()
    expect(container.querySelector('[data-identity-invite-issued]')?.textContent)
      .toContain('Its signature does not verify against this node’s key, so it is not offered for revoking.')
    await waitFor(() => { expect(flight.open).toBe(0) })
    expect(sent.slice(before).filter(call => call.method === 'POST' && call.path.startsWith('/_host/aumlok/'))).toEqual([])
  }, 120_000)

  it('hostCall reads the store\'s own 404 AUMLOK_INVITE_NOT_FOUND as a refusal; a route that is not there stays absent', async () => {
    await edge()
    softwareAuthenticator(new URL(EDGE).hostname)
    await bindOwner()
    const signal = new AbortController().signal
    const real = await hostCall('/_host/aumlok/challenge', signal,
      { purpose: 'invite', requestId: aumlokRequestId(), action: 'revoke', inviteId: b64u(new Uint8Array(randomBytes(32))) })
    expect(real).toMatchObject({ kind: 'refused', route: '/_host/aumlok/challenge', status: 404, code: 'AUMLOK_INVITE_NOT_FOUND' })

    const json = (body: unknown, status: number) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    const answers: Record<string, Response> = {
      '/coded': json({ ok: false, code: 'AUMLOK_INVITE_NOT_FOUND', status: 404 }, 404),
      '/route': json({ ok: false, code: 'AUMLOK_ROUTE_NOT_FOUND', status: 404 }, 404),
      '/method': json({ ok: false, code: 'AUMLOK_METHOD_NOT_ALLOWED', status: 405 }, 405),
      '/other': json({ ok: false, code: 'NOT_FOUND' }, 404),
      '/plain': new Response('not found', { status: 404 }),
      '/unimplemented': json({ ok: false, code: 'AUMLOK_INVITE_NOT_FOUND' }, 501),
    }
    vi.stubGlobal('fetch', vi.fn(async (input: string) => answers[input] ?? new Response('nope', { status: 404 })))
    expect(await hostCall('/coded', signal)).toEqual({ kind: 'refused', route: '/coded', status: 404, code: 'AUMLOK_INVITE_NOT_FOUND', message: 'refused' })
    expect(await hostCall('/route', signal)).toEqual({ kind: 'absent', route: '/route', detail: 'the host answers 404 for /route' })
    expect(await hostCall('/method', signal)).toEqual({ kind: 'absent', route: '/method', detail: 'the host answers 405 for /method' })
    expect(await hostCall('/other', signal)).toEqual({ kind: 'absent', route: '/other', detail: 'the host answers 404 for /other' })
    expect(await hostCall('/plain', signal)).toEqual({ kind: 'absent', route: '/plain', detail: 'the host answers 404 for /plain' })
    expect(await hostCall('/unimplemented', signal)).toEqual({ kind: 'absent', route: '/unimplemented', detail: 'the host answers 501 for /unimplemented' })
  }, 120_000)
})

// ── The invite review fixes (F1-F8) ────────────────────────────────────────────────────────────────────────────────────

/** A node key made here: its signing half (never exported) and its public hex. */
const nodeKeyPair = async (): Promise<{ readonly signingKey: CryptoKey; readonly pub: string }> => {
  const keys = await crypto.subtle.generateKey('Ed25519', false, ['sign', 'verify'])
  return { signingKey: keys.privateKey, pub: Buffer.from(await crypto.subtle.exportKey('raw', keys.publicKey)).toString('hex') }
}
const monthOf = (at: number): string => new Date(at).toISOString().slice(0, 7)
/** A bound host's status body that allows an invite, with this month's quota. */
const statusBody = (node: string, issued = 0): Record<string, unknown> => ({ ok: true, phase: 'BOUND', bound: true, passkeyVerified: true,
  nodePubkeyHex: node, blockers: [], phraseBlockers: [], pepperSeparated: true,
  invite: { quotaMonth: monthOf(Date.now()), issuedThisMonth: issued, limit: 3, revokedCount: 0 } })
const statusOf = (node: string, issued = 0): InviteStatus => {
  const read = inviteStatusOf({ kind: 'live', route: '/_host/aumlok/status', body: statusBody(node, issued) })
  if (read.kind !== 'live') throw new Error(`status: ${read.kind}`)
  return read.value
}
/** A browser with a passkey and Ed25519, whose passkey answers every assertion (each one counted). */
const stubPlatform = (prompts: string[] = []): AumlokPlatform => ({
  passkeyBlocker: () => null,
  nodeKeys: async () => true,
  passkey: async (): Promise<PasskeyResponseJson> => {
    prompts.push('assert')
    return { id: 'credential', rawId: 'credential', type: 'public-key', authenticatorAttachment: 'platform', response: {}, clientExtensionResults: {} }
  },
})
const PASSKEY_CHALLENGE = { challengeId: 'C'.repeat(43), publicKey: { challenge: b64u(new Uint8Array(32).fill(7)), rpId: 'invite.example.invalid' } }
/** The ten fields an invite challenge echoes, as the host would choose them at `at`. */
const echoedInvite = (node: string, commitment: string, at: number, monthlySequence = 1): InvitePayload => ({ schema: 'aukora.invite.v1',
  inviteId: 'A'.repeat(43), sponsorPubkeyHex: node, inviteeCommitmentSha256: commitment, assignedDomainPointer: null, quotaMonth: monthOf(at),
  monthlySequence, revoked: false, issuedAt: at, expiresAt: at + 604_800_000 })
const inviteChallenge = (invite: InvitePayload): HostAnswer => ({ kind: 'live', route: '/_host/aumlok/challenge',
  body: { purpose: 'invite', invite, signaturePreimage: invitePreimage(invite), ...PASSKEY_CHALLENGE } })
const refusalOf = (route: string, status: number, code: string): HostAnswer => ({ kind: 'refused', route, status, code, message: 'refused' })
const lostOn = (route: string): HostAnswer => ({ kind: 'absent', route, detail: 'the host did not answer (TypeError: Load failed)' })
/** A stand-in host: the challenge's answer, then the last step's answers in order (each last-step body recorded). */
const scriptedHost = (challenge: HostAnswer, finals: HostAnswer[]) => {
  const posts: Record<string, unknown>[] = []
  const call: AumlokHostCall = async (route, _signal, body) => {
    if (route === '/_host/aumlok/challenge') return challenge
    posts.push(body ?? {})
    return finals.shift() ?? lostOn(route)
  }
  return { call, posts }
}
/** A receipt signed here with `key` that names `node` as its sponsor (the index picks its month and sequence). */
const signedReceipt = async (node: string, key: CryptoKey, index: number): Promise<InviteReceipt> => {
  const issuedAt = Date.UTC(2024, Math.floor(index / 3), 2)
  const payload: InvitePayload = { schema: 'aukora.invite.v1', inviteId: b64u(new Uint8Array(randomBytes(32))), sponsorPubkeyHex: node,
    inviteeCommitmentSha256: hex(`invitee ${String(index)}`), assignedDomainPointer: null, quotaMonth: monthOf(issuedAt),
    monthlySequence: index % 3 + 1, revoked: false, issuedAt, expiresAt: issuedAt + 604_800_000 }
  return { ...payload, signature: await signWithNode(key, invitePreimage(payload)) }
}
const keepBook = (receipts: readonly InviteReceipt[]): void => {
  localStorage.setItem(INVITE_BOOK_KEY, JSON.stringify({ schema: 'aukora.invite.issued.v1', receipts, revocations: [] }))
}
const issueRequest = (commitment: string) =>
  ({ requestId: aumlokRequestId(), inviteeCommitmentSha256: commitment, assignedDomainPointer: null })
const deps = (call: AumlokHostCall, platform: AumlokPlatform = stubPlatform()) => ({ call, platform, signal: new AbortController().signal })
const LOST_WORDS = 'The answer was lost on the way. If it was the words step, that try may have counted.'
const CAP_REFUSED_WORDS = 'This node refused an invite here for its 32-invite limit for all time, so nothing more is asked from this browser.'
const CAP_HELD_WORDS = 'This browser holds 32 invites this node signed, which is its limit for all time, so nothing is asked.'
const noticeText = (container: HTMLElement): string | null => container.querySelector('[data-identity-invite-notice]')?.textContent ?? null
/** Open the issue panel and type the words until they are ready (nothing is asked of the host but GETs). */
const readyWords = async (container: HTMLElement, words: readonly string[], flight: { open: number }, sent: readonly Sent[]) => {
  await press(container, '[data-identity-invite-issue]', flight, sent)
  await waitFor(() => { expect(container.querySelector('[data-identity-invite-panel="issue"]')).not.toBeNull() })
  typeWords(container, words)
  await waitFor(() => { expect(container.querySelector('[data-identity-invite-words="ready"]')).not.toBeNull() }, { timeout: 30_000 })
}
const urlOf = (input: RequestInfo | URL): string => (typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)

describe('Invite review fixes, on a stand-in host (the module alone)', () => {
  it('F2: the last step takes CAPACITY and CLOCK_INVALID as final at any status; a replayed CHALLENGE_UNKNOWN leaves it unknown', async () => {
    const { pub, signingKey } = await nodeKeyPair()
    const code = await newInviteeCode()
    const INVITE = '/_host/aumlok/invite'
    const settleWith = async (finals: HostAnswer[]) => {
      const host = scriptedHost(inviteChallenge(echoedInvite(pub, code.commitmentSha256, Date.now())), finals)
      const step = await issueInvite(issueRequest(code.commitmentSha256), () => signingKey, statusOf(pub), deps(host.call))
      return [step, host.posts.length] as const
    }
    // The store gives these only when it records nothing: no replay (which the host would refuse, and count, as USED).
    expect(await settleWith([refusalOf(INVITE, 507, 'AUMLOK_INVITE_CAPACITY'), refusalOf(INVITE, 409, 'AUMLOK_CHALLENGE_USED')]))
      .toEqual([{ kind: 'refused', code: 'AUMLOK_INVITE_CAPACITY' }, 1])
    expect(await settleWith([refusalOf(INVITE, 503, 'AUMLOK_CLOCK_INVALID'), refusalOf(INVITE, 409, 'AUMLOK_CHALLENGE_USED')]))
      .toEqual([{ kind: 'refused', code: 'AUMLOK_CLOCK_INVALID' }, 1])
    // A replay that finds the record pruned says nothing about the first attempt, as an expired one does.
    expect(await settleWith([lostOn(INVITE), refusalOf(INVITE, 409, 'AUMLOK_CHALLENGE_UNKNOWN')]))
      .toEqual([{ kind: 'unknown', code: 'invite:outcome-unknown' }, 2])
    expect(await settleWith([lostOn(INVITE), refusalOf(INVITE, 409, 'AUMLOK_CHALLENGE_EXPIRED')]))
      .toEqual([{ kind: 'unknown', code: 'invite:outcome-unknown' }, 2])
    // Nor does a replay the store's clock refused before it read the record; a replay refused at the cap was the only try.
    expect(await settleWith([lostOn(INVITE), refusalOf(INVITE, 503, 'AUMLOK_CLOCK_INVALID')]))
      .toEqual([{ kind: 'unknown', code: 'invite:outcome-unknown' }, 2])
    expect(await settleWith([lostOn(INVITE), refusalOf(INVITE, 507, 'AUMLOK_INVITE_CAPACITY')]))
      .toEqual([{ kind: 'refused', code: 'AUMLOK_INVITE_CAPACITY' }, 2])
    // Unchanged: a replayed CHALLENGE_USED is the first attempt's refusal, and a 5xx with no store code is asked again.
    expect(await settleWith([lostOn(INVITE), refusalOf(INVITE, 409, 'AUMLOK_CHALLENGE_USED')]))
      .toEqual([{ kind: 'refused', code: 'AUMLOK_CHALLENGE_USED' }, 2])
    expect(await settleWith([refusalOf(INVITE, 503, 'CLOUD_REQUEST_FAILED'), refusalOf(INVITE, 409, 'AUMLOK_CHALLENGE_USED')]))
      .toEqual([{ kind: 'refused', code: 'AUMLOK_CHALLENGE_USED' }, 2])
  })

  it('F5: the echo ties the host’s month, sequence and time to the fresh read and to now; a future-dated one asks no Touch ID', async () => {
    const { pub, signingKey } = await nodeKeyPair()
    const code = await newInviteeCode()
    const commitment = code.commitmentSha256
    const request = issueRequest(commitment)
    const now = Date.now()
    const year = now + 365 * 86_400_000
    const quota = { month: monthOf(now), issued: 1, limit: 3, revoked: 0 }
    const echo = (invite: InvitePayload, against = quota) => inviteEcho({ purpose: 'invite', invite }, request, pub, against, now)
    expect(echo(echoedInvite(pub, commitment, now, 2))).not.toBeNull()
    // A year ahead, even in its own month and as that month's first: its shape alone used to let it through.
    expect(echo(echoedInvite(pub, commitment, year, 2))).toBeNull()
    expect(echo(echoedInvite(pub, commitment, year, 1), { ...quota, month: monthOf(year), issued: 0 })).toBeNull()
    // A slot already used, a slot skipped, or a month the fresh read does not report.
    expect(echo(echoedInvite(pub, commitment, now, 1))).toBeNull()
    expect(echo(echoedInvite(pub, commitment, now, 3))).toBeNull()
    expect(echo(echoedInvite(pub, commitment, now, 2), { ...quota, month: '1999-01' })).toBeNull()
    // Within five minutes of this page's clock either way, and no further.
    const at = (offset: number) => echo(echoedInvite(pub, commitment, now + offset, 2), { ...quota, month: monthOf(now + offset) })
    expect([at(-300_000), at(300_000)].map(value => value !== null)).toEqual([true, true])
    expect([at(-301_000), at(301_000)]).toEqual([null, null])
    // A revocation's time is bound the same way.
    const revocation = (revokedAt: number): RevocationPayload => ({ schema: 'aukora.invite-revocation.v1', inviteId: 'A'.repeat(43),
      sponsorPubkeyHex: pub, revokedAt })
    const revoked = (revokedAt: number) => revocationEcho({ purpose: 'invite', revocation: revocation(revokedAt) }, 'A'.repeat(43), pub, now)
    expect(revoked(now)).toEqual(revocation(now))
    expect([revoked(year), revoked(now - 301_000), revoked(now + 301_000)]).toEqual([null, null, null])
    // Through tap 2: a future-dated echo is refused before Touch ID, and nothing is signed or sent.
    const prompts: string[] = []
    const ahead = scriptedHost(inviteChallenge(echoedInvite(pub, commitment, year, 1)), [])
    expect(await issueInvite(request, () => signingKey, statusOf(pub), deps(ahead.call, stubPlatform(prompts))))
      .toEqual({ kind: 'refused', code: 'invite:echo-mismatch' })
    const later = scriptedHost({ kind: 'live', route: '/_host/aumlok/challenge', body: { purpose: 'invite', revocation: revocation(year),
      signaturePreimage: revocationPreimage(revocation(year)), ...PASSKEY_CHALLENGE } }, [])
    expect(await revokeInvite({ requestId: aumlokRequestId(), inviteId: 'A'.repeat(43) }, () => signingKey, statusOf(pub),
      deps(later.call, stubPlatform(prompts)))).toEqual({ kind: 'refused', code: 'invite:echo-mismatch' })
    expect(prompts).toEqual([])
    expect([...ahead.posts, ...later.posts]).toEqual([])
  })

  it('F6: one AUMLOK_INVITE_CAPACITY refusal shuts issuing for that node in this browser, in words, even with storage closed', async () => {
    const { pub, signingKey } = await nodeKeyPair()
    const platform = stubPlatform()
    const code = await newInviteeCode()
    expect(await inviteReadiness(statusOf(pub), 'issue', platform)).toBeNull()
    // The tap-2 challenge is refused at the cap (the host counts that refusal).
    const capped = scriptedHost(refusalOf('/_host/aumlok/challenge', 507, 'AUMLOK_INVITE_CAPACITY'), [])
    expect(await issueInvite(issueRequest(code.commitmentSha256), () => signingKey, statusOf(pub), deps(capped.call, platform)))
      .toEqual({ kind: 'refused', code: 'AUMLOK_INVITE_CAPACITY' })
    // From then on nothing is asked for that node, though the month still has room; revoking is still offered.
    expect(await inviteReadiness(statusOf(pub), 'issue', platform)).toBe(CAP_REFUSED_WORDS)
    expect(await inviteReadiness(statusOf(pub), 'revoke', platform)).toBeNull()
    expect(localStorage.getItem(INVITE_CAPACITY_KEY)).toBe(pub)
    expect(await inviteReadiness(statusOf((await nodeKeyPair()).pub), 'issue', platform)).toBeNull()
    // With storage closed, a refusal at the last step is kept in this page's memory.
    localStorage.clear()
    forgetInviteBookForTests()
    expect(await inviteReadiness(statusOf(pub), 'issue', platform)).toBeNull()
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('closed', 'SecurityError') })
    const last = scriptedHost(inviteChallenge(echoedInvite(pub, code.commitmentSha256, Date.now())),
      [refusalOf('/_host/aumlok/invite', 507, 'AUMLOK_INVITE_CAPACITY')])
    expect(await issueInvite(issueRequest(code.commitmentSha256), () => signingKey, statusOf(pub), deps(last.call, platform)))
      .toEqual({ kind: 'refused', code: 'AUMLOK_INVITE_CAPACITY' })
    expect(last.posts).toHaveLength(1)
    expect(localStorage.getItem(INVITE_CAPACITY_KEY)).toBeNull()
    expect(await inviteReadiness(statusOf(pub), 'issue', platform)).toBe(CAP_REFUSED_WORDS)
  })

  it('F6: a book holding 32 receipts this node signed shuts issuing; 31, or 32 with one that does not verify, does not', async () => {
    const node = await nodeKeyPair()
    const other = await nodeKeyPair()
    const platform = stubPlatform()
    const receipts = await Promise.all(Array.from({ length: 32 }, async (_, index) => signedReceipt(node.pub, node.signingKey, index)))
    keepBook(receipts.slice(0, 31))
    expect(await inviteReadiness(statusOf(node.pub), 'issue', platform)).toBeNull()
    keepBook([...receipts.slice(0, 31), await signedReceipt(node.pub, other.signingKey, 31)])
    expect(await inviteReadiness(statusOf(node.pub), 'issue', platform)).toBeNull()
    keepBook(receipts)
    expect(await inviteReadiness(statusOf(node.pub), 'issue', platform)).toBe(CAP_HELD_WORDS)
    expect(await inviteReadiness(statusOf(node.pub), 'revoke', platform)).toBeNull()
    // They must verify against the node key read now: under another node key the same book shuts nothing.
    expect(await inviteReadiness(statusOf(other.pub), 'issue', platform)).toBeNull()
  })

  it('F7: a lost answer is not a missing route; a lost unseal or challenge answer says the try may have counted', async () => {
    const { pub, signingKey } = await nodeKeyPair()
    const unsealChallenge: HostAnswer = { kind: 'live', route: '/_host/aumlok/challenge', body: PASSKEY_CHALLENGE }
    const open = async (challenge: HostAnswer, unseal: HostAnswer) => openNodeForInvite('canonical words', 'c'.repeat(64),
      statusOf(pub).status, aumlokRequestId(), deps(async route => (route === '/_host/aumlok/challenge' ? challenge : unseal)))
    // TAP 1: the unseal's answer is lost after the host may have checked (and counted) the words.
    expect(await open(unsealChallenge, lostOn('/_host/aumlok/unseal'))).toEqual({ kind: 'refused', code: 'aumlok:not-answered' })
    expect(inviteRefusalWords('aumlok:not-answered')).toBe(LOST_WORDS)
    expect(await open(lostOn('/_host/aumlok/challenge'), unsealChallenge)).toEqual({ kind: 'refused', code: 'aumlok:not-answered' })
    // A route that is really not there (404, 405, or no JSON) still reads as not on this host.
    for (const detail of ['the host answers 404 for /_host/aumlok/unseal', 'the host answers 405 for /_host/aumlok/unseal',
      '/_host/aumlok/unseal answered 200 without JSON']) {
      expect(await open(unsealChallenge, { kind: 'absent', route: '/_host/aumlok/unseal', detail }))
        .toEqual({ kind: 'refused', code: 'aumlok:route-absent' })
    }
    expect(inviteRefusalWords('aumlok:route-absent')).toBe('Invites are not on this host yet.')
    // TAP 2: the invite challenge's answer lost, or its route not there.
    const code = await newInviteeCode()
    const tapTwo = async (challenge: HostAnswer) =>
      issueInvite(issueRequest(code.commitmentSha256), () => signingKey, statusOf(pub), deps(async () => challenge))
    expect(await tapTwo(lostOn('/_host/aumlok/challenge'))).toEqual({ kind: 'refused', code: 'invite:not-answered' })
    expect(inviteRefusalWords('invite:not-answered')).toBe(LOST_WORDS)
    expect(await tapTwo({ kind: 'absent', route: '/_host/aumlok/challenge', detail: 'the host answers 404 for /_host/aumlok/challenge' }))
      .toEqual({ kind: 'refused', code: 'invite:route-absent' })
  })
})

describe('Invite review fixes, on the Identity screen', () => {
  it('F1: "tap once more" after tap 1 lasts only as long as its challenge; then the words and the request go, unposted', async () => {
    const { sent, flight } = await edge()
    const authenticator = softwareAuthenticator(new URL(EDGE).hostname)
    const words = await bindOwner()
    const { container } = mount()
    await openInvites(container)
    await readyWords(container, words, flight, sent)
    // The page's timers are fake from here (they still move with the real clock); Touch ID does not complete once.
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout'] })
    authenticator.hooks.beforeAssert = async () => { throw new DOMException('The request is not allowed by the user agent.', 'NotAllowedError') }
    const tap1 = await press(container, '[data-identity-invite-open]', flight, sent)
    await waitFor(() => { expect(noticeText(container)).toContain('Tap “Open with Touch ID” once more.') }, { timeout: 30_000 })
    await waitFor(() => { expect(flight.open).toBe(0) })
    const requestId = sent[tap1]?.body?.requestId
    expect(typeof requestId).toBe('string')
    const after = sent.length
    // Well inside the challenge's two minutes, the one more tap is still offered.
    vi.advanceTimersByTime(100_000)
    expect(button(container, '[data-identity-invite-open]')?.disabled).toBe(false)
    // From INVITE_TAP_AGAIN_MARGIN_MS (15 s) before they end, the flow ends (a Touch ID sheet takes time, and an unseal
    // reaching the host after expiry is a counted refusal): the panel (and the words it held) is gone, and the request is
    // never posted again.
    vi.advanceTimersByTime(6_000)
    await waitFor(() => {
      expect(noticeText(container)).toBe('Touch ID was not tapped again within two minutes, so that request expired. It was not sent again, '
        + 'and your words were dropped. Start again.')
    })
    expect(container.querySelector('[data-identity-invite-panel]')).toBeNull()
    await waitFor(() => { expect(flight.open).toBe(0) })
    expect(sent.slice(after).filter(call => call.body?.requestId === requestId)).toEqual([])
    expect(sent.slice(after).filter(call => call.method === 'POST' && call.path.startsWith('/_host/aumlok/'))).toEqual([])
    expect(authenticator.prompts).toEqual(['register', 'assert', 'assert'])
  }, 120_000)

  it('F3: a count re-read that fails right after a confirmed invite never hides its invite code', async () => {
    const { sent, flight } = await edge()
    softwareAuthenticator(new URL(EDGE).hostname)
    const words = await bindOwner()
    // Once the last step is answered, every status read is lost on the way (a network error, or a sign-in page).
    const forward = globalThis.fetch
    const after = { invited: false }
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (after.invited && urlOf(input) === '/_host/aumlok/status') throw new TypeError('Load failed')
      const answer = await forward(input, init)
      if (urlOf(input) === '/_host/aumlok/invite') after.invited = true
      return answer
    }))
    const { container } = mount()
    await openInvites(container)
    await readyWords(container, words, flight, sent)
    await press(container, '[data-identity-invite-open]', flight, sent)
    await waitFor(() => { expect(container.querySelector('[data-identity-invite-step="open"]')).not.toBeNull() }, { timeout: 30_000 })
    await press(container, '[data-identity-invite-sign]', flight, sent)
    // The card's count is no longer read...
    await waitFor(() => { expect(container.querySelector('[data-identity-invite="absent"]')).not.toBeNull() }, { timeout: 30_000 })
    expect(container.querySelector('[data-identity-invite-count]')).toBeNull()
    // ...and the confirmed invite, its receipt and its code shown this once are still on the screen.
    const code = container.querySelector('[data-identity-invite-code-value]')?.textContent ?? ''
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(container.querySelector('[data-identity-invite-receipt]')).not.toBeNull()
    expect(noticeText(container)).toBe('The node confirmed this invite.')
    fireEvent.click(container.querySelector('[data-identity-invite-done]') as HTMLButtonElement)
    expect(container.textContent).not.toContain(code)
  }, 120_000)

  it('F4: Close waits while Touch ID is open and clears the notice; an invite confirmed after the card closed is said', async () => {
    skewClock()
    const { sent, flight } = await edge()
    const authenticator = softwareAuthenticator(new URL(EDGE).hostname)
    const words = await bindOwner()
    expireChallenges()
    // The last step can be held on its way to the host.
    const forward = globalThis.fetch
    const lastStep: { gate: Promise<void> | null; asked: number } = { gate: null, asked: 0 }
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (urlOf(input) === '/_host/aumlok/invite') { lastStep.asked += 1; await lastStep.gate }
      return forward(input, init)
    }))
    const { container } = mount()
    await openInvites(container)
    await readyWords(container, words, flight, sent)
    const close = () => button(container, '[data-identity-invite-close]')
    // TAP 1, with its Touch ID sheet still open: Close waits.
    let finishTap1 = (): void => {}
    authenticator.hooks.beforeAssert = () => new Promise<void>((resolve) => { finishTap1 = resolve })
    await press(container, '[data-identity-invite-open]', flight, sent)
    await waitFor(() => { expect(authenticator.prompts).toEqual(['register', 'assert', 'assert']) })
    expect(container.querySelector('[data-identity-invite-step="opening"]')).not.toBeNull()
    expect(close()?.disabled).toBe(true)
    finishTap1()
    await waitFor(() => { expect(container.querySelector('[data-identity-invite-step="open"]')).not.toBeNull() }, { timeout: 30_000 })
    expect(close()?.disabled).toBe(false)
    // TAP 2: Close waits while its Touch ID sheet is open, and while the last step is out.
    let finishTap2 = (): void => {}
    authenticator.hooks.beforeAssert = () => new Promise<void>((resolve) => { finishTap2 = resolve })
    let letLastStep = (): void => {}
    lastStep.gate = new Promise<void>((resolve) => { letLastStep = resolve })
    await press(container, '[data-identity-invite-sign]', flight, sent)
    await waitFor(() => { expect(authenticator.prompts).toHaveLength(4) })
    expect(container.querySelector('[data-identity-invite-step="signing"]')).not.toBeNull()
    expect(close()?.disabled).toBe(true)
    finishTap2()
    await waitFor(() => { expect(lastStep.asked).toBe(1) })
    expect(close()?.disabled).toBe(true)
    // The card itself is closed while the last step is out; then the host records the invite.
    const head = container.querySelector('[data-identity-portal="invite"] .ak-portal__head') as HTMLElement
    fireEvent.click(head)
    await waitFor(() => { expect(container.querySelector('[data-identity-invite-panel]')).toBeNull() })
    letLastStep()
    await waitFor(() => { expect(localStorage.getItem(INVITE_BOOK_KEY)).not.toBeNull() }, { timeout: 30_000 })
    await waitFor(() => { expect(flight.open).toBe(0) })
    const issued = (JSON.parse(localStorage.getItem(INVITE_BOOK_KEY) ?? '{}') as { receipts: InviteReceipt[] }).receipts
    expect(issued).toHaveLength(1)
    // Reopened: the notice says what happened, no code is shown, and the list holds the invite, checked against the node key.
    fireEvent.click(head)
    await waitFor(() => {
      expect(noticeText(container)).toBe('The node confirmed an invite after this panel was closed. Its invite code cannot be shown, so that '
        + 'invite cannot be given to anyone; it is listed below. Revoking it does not give this month’s invite back.')
    })
    expect(container.querySelector('[data-identity-invite-code]')).toBeNull()
    await waitFor(() => {
      expect(container.querySelector(`[data-identity-invite-row="${issued[0]?.inviteId ?? ''}"]`)?.getAttribute('data-state')).toBe('verifies')
    })
    await waitFor(() => { expect(container.querySelector('[data-identity-invite-count]')?.textContent).toMatch(/^2 of 3 remaining in /) })
    // A second flow: with the root open, Close ends it and takes its notice along.
    await readyWords(container, words, flight, sent)
    await press(container, '[data-identity-invite-open]', flight, sent)
    await waitFor(() => { expect(container.querySelector('[data-identity-invite-step="open"]')).not.toBeNull() }, { timeout: 30_000 })
    expect(noticeText(container)).toBe('Your root is open on this page for up to two minutes. Nothing is signed until you tap again.')
    await press(container, '[data-identity-invite-close]', flight, sent)
    expect(container.querySelector('[data-identity-invite-panel]')).toBeNull()
    expect(noticeText(container)).toBeNull()
  }, 120_000)

  it('F6: a book of 32 receipts this node signed shuts "Invite someone" on the screen and says why', async () => {
    const node = await nodeKeyPair()
    keepBook(await Promise.all(Array.from({ length: 32 }, async (_, index) => signedReceipt(node.pub, node.signingKey, index))))
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => (urlOf(input) === '/_host/aumlok/status'
      ? new Response(JSON.stringify(statusBody(node.pub)), { status: 200, headers: { 'content-type': 'application/json' } })
      : new Response('nope', { status: 404 }))))
    const { container } = mount()
    await openInvites(container)
    await waitFor(() => { expect(container.querySelector('[data-identity-invite-blocked]')?.textContent).toBe(CAP_HELD_WORDS) })
    expect(container.querySelector('[data-identity-invite-count]')?.textContent).toMatch(/^3 of 3 remaining in /)
    expect(button(container, '[data-identity-invite-issue]')?.disabled).toBe(true)
  })

  it('F8: a stored receipt that does not verify, or is not checked yet, is named by its id and month, never as signed by this node', async () => {
    const node = await nodeKeyPair()
    const other = await nodeKeyPair()
    // It names this node as its sponsor, but another key signed it.
    const receipt = await signedReceipt(node.pub, other.signingKey, 0)
    keepBook([receipt])
    const desk = { hold: false, reads: 0 }
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (urlOf(input) !== '/_host/aumlok/status') return new Response('nope', { status: 404 })
      desk.reads += 1
      // The card's own read answers; with `hold`, the desk's read (the second) never does, so nothing is checked.
      if (desk.hold && desk.reads > 1) return new Promise<Response>(() => {})
      return new Response(JSON.stringify(statusBody(node.pub)), { status: 200, headers: { 'content-type': 'application/json' } })
    }))
    const plain = `Invite ${receipt.inviteId.slice(0, 12)}… for ${receipt.quotaMonth}`
    const rowOf = (container: HTMLElement) => container.querySelector(`[data-identity-invite-row="${receipt.inviteId}"]`)
    const fails = mount()
    await openInvites(fails.container)
    await waitFor(() => { expect(rowOf(fails.container)?.getAttribute('data-state')).toBe('fails') })
    expect(rowOf(fails.container)?.closest('li')?.getAttribute('title')).toBe(plain)
    expect(rowOf(fails.container)?.closest('li')?.textContent).not.toContain('signed by this node’s key')
    cleanup()
    desk.hold = true
    desk.reads = 0
    const checking = mount()
    await openInvites(checking.container)
    await waitFor(() => { expect(desk.reads).toBe(2) })
    expect(rowOf(checking.container)?.getAttribute('data-state')).toBe('checking')
    expect(rowOf(checking.container)?.closest('li')?.getAttribute('title')).toBe(plain)
    expect(rowOf(checking.container)?.closest('li')?.querySelector('.ak-row__summary')?.textContent).toBe(plain)
    expect(rowOf(checking.container)?.closest('li')?.textContent).not.toContain('signed by this node’s key')
  })
})
