// @vitest-environment jsdom
/**
 * Redeeming an invite on the Identity screen ("Check with this node"), against the REAL edge AUMLOK store.
 *
 * The first test drives the page's own code through `fetch` into the real Worker (`createWorker`) and the real HEAD
 * Durable Object, with in-memory storage and a software authenticator: the owner binds, issues one real invite, and the
 * Redeem card then asks the host to check it. The AUMLOK routes are not stubbed, so "verified", "revoked" and the exact
 * fields of the host's answer are the store's own. The harness is the minimal part of
 * `identity-invite-issue.client.spec.tsx`, copied rather than shared. ONE ANSWER IS STUBBED: `GET /__x6/status`, which the
 * page reads to learn what host it is on. HEAD's status route needs stores this minimal harness does not build (it
 * answers 503 HEAD_STORAGE_UNAVAILABLE here), so the harness answers it as the edge does (SOURCE: head-do.mjs,
 * `runtime: 'cloudflare'`).
 *
 * The other tests use a strict `fetch` stub (it refuses any redeem body that is not exactly `{ invite, code }`) for what
 * the real edge cannot be made to do here: a host without the route, the Mac host, a lost answer, an answer that claims
 * more than the store's does.
 *
 * Run it from the repository root of a full `pnpm install` (the edge's aumlok.mjs imports `@simplewebauthn/server`):
 *   ./node_modules/.bin/vitest run packages/client/ui-layout/tests/identity-invite-redeem.client.spec.tsx
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { IDENTITY_SURFACE, IdentitySurface } from '../src/client/spatial/apps/identity/IdentitySurface.tsx'
import type { HostAnswer } from '../src/client/spatial/apps/identity/host.ts'
import {
  forgetInviteBookForTests, INVITE_VERIFICATION_SCHEMA, inviteLinkOf, invitePreimage, inviteVerificationOf, issueInvite, newInviteeCode,
  openNodeForInvite, readInviteStatus, REDEEM_ABSENT_WORDS, REDEEM_ROUTE, redeemInvite, redeemRefusalWords, redeemWords, revokeInvite,
  signWithNode,
  type InvitePayload, type InviteReceipt, type InviteStatus, type InviteVerification,
} from '../src/client/spatial/apps/identity/invite.ts'
import {
  aumlokCommitment, aumlokRequestId, createBrowserCeremony, parseAumlokPhrase, readAumlokStatus,
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
/** The host's own receipt check (deploy/cloudflare/src/aumlok.mjs). */
const hostVerifiesReceipt = aumlokModule.verifyAumlokInviteReceipt as (receipt: unknown, node: string) => Promise<boolean>

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

/** One page request as the edge saw it, and (for a redemption) the host's own answer to it. */
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
  /** Every answer the host gave to a redemption: its status and its JSON, as the store wrote them. */
  const redeemed: { status: number; body: Record<string, unknown> }[] = []
  const flight = { open: 0 }
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (!url.startsWith('/')) throw new Error(`the page reached outside its origin: ${url}`)
    const path = url.split('?')[0] ?? url
    sent.push({ method: init?.method ?? 'GET', path, body: typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : null })
    // The one stubbed answer (see the header): what the edge says it is.
    if (path === '/__x6/status') return Response.json({ ok: true, runtime: 'cloudflare' })
    const headers = new Headers(init?.headers)
    headers.set('cookie', `CF_Authorization=${jwt.join('.')}`)
    headers.set('origin', EDGE)
    headers.set('sec-fetch-site', 'same-origin')
    flight.open += 1
    try {
      const response = await app.fetch(new Request(EDGE + url, { method: init?.method ?? 'GET', headers, body: init?.body ?? null }), env)
      if (path === REDEEM_ROUTE) redeemed.push({ status: response.status, body: await response.clone().json() as Record<string, unknown> })
      return response
    } finally {
      flight.open -= 1
    }
  }))
  return { sent, redeemed, flight }
}

/** The owner's first bind through the page's own ceremony; the words come back so the test can use them. */
const bindOwner = async (): Promise<readonly string[]> => {
  const read = await readAumlokStatus(new AbortController().signal)
  const ceremony = createBrowserCeremony()
  const drawn = await ceremony.draw('bind', read.kind === 'live' ? read.status : null)
  if (!drawn.ok || drawn.words === undefined) throw new Error(`draw: ${drawn.reason ?? 'no words'}`)
  expect(await ceremony.submit('bind', drawn.words)).toMatchObject({ ok: true })
  return drawn.words
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

const PROPS = { activeSurface: IDENTITY_SURFACE, closeSurface: () => {} } as unknown as Parameters<typeof IdentitySurface>[0]
const redeemCard = (container: HTMLElement): Element => {
  const card = container.querySelector('[data-identity-portal="redeem"]')
  if (card === null) throw new Error('no redeem card')
  return card
}
const sendButton = (container: HTMLElement): HTMLButtonElement | null =>
  redeemCard(container).querySelector<HTMLButtonElement>('[data-identity-redeem-send]')
const resultOf = (container: HTMLElement): Element | null => redeemCard(container).querySelector('[data-identity-redeem-result]')
const typeCode = (container: HTMLElement, code: string): void => {
  fireEvent.change(redeemCard(container).querySelector('[data-identity-redeem-code]') as Element, { target: { value: code } })
}
/** Wait until the page's own check has landed for the code as typed, and say whether the button is live. */
const codeChecked = async (container: HTMLElement, matches: boolean): Promise<void> => {
  await waitFor(() => {
    expect(redeemCard(container).querySelector('[data-identity-redeem-code-check]')?.getAttribute('data-identity-redeem-code-check')).toBe(String(matches))
    expect(sendButton(container)?.disabled).toBe(!matches)
  }, { timeout: 10_000 })
}
/** Every string the page kept in this origin's storage. */
const stored = (): string => [localStorage, sessionStorage].flatMap(area => Object.keys(area).map(key => `${key}=${area.getItem(key) ?? ''}`)).join('\n')
const redeemPosts = (sent: readonly Sent[]): Sent[] => sent.filter(call => call.path === REDEEM_ROUTE)

beforeEach(() => {
  ;(globalThis as { jsdom?: { reconfigure: (o: { url: string }) => void } }).jsdom?.reconfigure({ url: `${EDGE}/` })
  vi.stubGlobal('BroadcastChannel', class { onmessage = null; close() {} })
  vi.stubGlobal('WebSocket', class { onopen = null; onmessage = null; onclose = null; close() {} })
  localStorage.clear()
  sessionStorage.clear()
  forgetInviteBookForTests()
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  resetApprovalsForTests()
  localStorage.clear()
  sessionStorage.clear()
  forgetInviteBookForTests()
  globalThis.location.hash = ''
})

describe('Redeem an invite: "Check with this node", against the real edge AUMLOK store', () => {
  it('a real invite and its code are verified by the host with its exact answer; a wrong code is never sent; a revoked invite is refused in words', async () => {
    skewClock()
    const { sent, redeemed, flight } = await edge()
    softwareAuthenticator(new URL(EDGE).hostname)
    const words = await bindOwner()
    expireChallenges()
    // One real invite, issued through the page's own module (one unseal, one signature).
    const signal = new AbortController().signal
    const start = await liveStatus()
    const node = start.status.nodePubkeyHex ?? ''
    const parsed = parseAumlokPhrase(words)
    if (!parsed.ok) throw new Error('words')
    const commitment = await aumlokCommitment(parsed.canonical, node)
    const opened = await openNodeForInvite(parsed.canonical, commitment, start.status, aumlokRequestId(), { signal })
    if (opened.kind !== 'done') throw new Error(`open: ${JSON.stringify(opened)}`)
    const invitee = await newInviteeCode()
    const request = { requestId: aumlokRequestId(), inviteeCommitmentSha256: invitee.commitmentSha256, assignedDomainPointer: null }
    const issued = await issueInvite(request, () => opened.value.signingKey, await liveStatus(), { signal })
    if (issued.kind !== 'done') throw new Error(`issue: ${JSON.stringify(issued)}`)
    const receipt = issued.value
    expect(await hostVerifiesReceipt(receipt, node)).toBe(true)
    expect(redeemPosts(sent)).toEqual([])

    // The guest opens the invite link: the card shows the page's own checks, and the button waits for a code.
    globalThis.location.hash = new URL(inviteLinkOf(receipt, EDGE)).hash
    const { container, rerender } = render(<IdentitySurface {...PROPS} />)
    await waitFor(() => { expect(redeemCard(container).querySelector('[data-identity-redeem="signed"]')).not.toBeNull() }, { timeout: 20_000 })
    expect(sendButton(container)?.textContent).toBe('Check with this node')
    expect(sendButton(container)?.disabled).toBe(true)
    expect(redeemCard(container).textContent).not.toContain('no host takes a redemption yet')
    expect(redeemCard(container).textContent).toContain('only a host can say')

    // A WRONG CODE (well formed, another invite's): the page's own check says no, the button stays dead, nothing is sent.
    const wrong = (await newInviteeCode()).code
    typeCode(container, wrong)
    await codeChecked(container, false)
    fireEvent.click(sendButton(container) as HTMLButtonElement)
    // Even asked directly, the module sends nothing for a code its own check refuses.
    expect(await redeemInvite(receipt, wrong, signal)).toEqual({ kind: 'unclear',
      detail: 'Nothing was sent: this page’s own check of the signature, the date and the code does not pass.' })
    await waitFor(() => { expect(flight.open).toBe(0) })
    expect(redeemPosts(sent)).toEqual([])
    expect(JSON.stringify(sent)).not.toContain(wrong)
    expect(resultOf(container)).toBeNull()

    // THE RIGHT CODE: one press, one request, exactly { invite, code }, after one read of what the host is.
    typeCode(container, invitee.code)
    await codeChecked(container, true)
    await waitFor(() => { expect(flight.open).toBe(0) })
    const before = sent.length
    fireEvent.click(sendButton(container) as HTMLButtonElement)
    fireEvent.click(sendButton(container) as HTMLButtonElement)
    await waitFor(() => { expect(resultOf(container)?.getAttribute('data-identity-redeem-result')).toBe('verified') }, { timeout: 20_000 })
    await waitFor(() => { expect(flight.open).toBe(0) })
    const after = sent.slice(before).filter(call => call.path === '/__x6/status' || call.path.startsWith('/_host/aumlok/'))
    expect(after.map(call => [call.method, call.path])).toEqual([['GET', '/__x6/status'], ['POST', REDEEM_ROUTE]])
    expect(redeemPosts(sent)).toHaveLength(1)
    expect(redeemPosts(sent)[0]?.body).toEqual({ invite: receipt, code: invitee.code })
    expect(Object.keys(redeemPosts(sent)[0]?.body ?? {}).sort()).toEqual(['code', 'invite'])
    // The host's own answer, field for field (the store's `redeem`), and the line says all of it, the "not done" included.
    expect(redeemed).toHaveLength(1)
    const answer = redeemed[0]?.body ?? {}
    expect(redeemed[0]?.status).toBe(200)
    expect(answer).toEqual({ ok: true, schema: 'aukora.invite-verification.v1', inviteId: receipt.inviteId, sponsorPubkeyHex: node,
      recipientStatus: 'CODE_VERIFIED', verifiedAt: answer.verifiedAt, expiresAt: receipt.expiresAt, accessGranted: false,
      identityEnrolled: false, inviteConsumed: false, freshness: 'LOCAL_DURABLE_STATE_ONLY',
      // Since the Wave 6 edge (an earlier commit) the host also says a guest gets no way in yet.
      guestAccess: { available: false, code: 'GUEST_ACCESS_UNAVAILABLE' } })
    const line = resultOf(container)?.textContent ?? ''
    expect(line).toBe(redeemWords({ kind: 'verified', value: inviteVerificationOf(answer, receipt) as InviteVerification }))
    expect(line).toMatch(/^This node verified the code for this invite at \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC: /u)
    expect(line).toContain('It read only its own stored records, with no outside witness.')
    expect(line).toContain('nothing was granted, no identity was enrolled, and the invite was not used up')
    expect(line).toContain('This node gives guests no way in yet (GUEST_ACCESS_UNAVAILABLE).')
    expect(line).not.toMatch(/welcome|you are in|redeemed|access granted/iu)
    expect(sendButton(container)?.disabled).toBe(false)
    // Through the module the value is the host's answer exactly (without `ok`).
    const direct = await redeemInvite(receipt, invitee.code, signal)
    const { ok: _ok, ...fields } = redeemed[1]?.body ?? {}
    expect(direct).toEqual({ kind: 'verified', value: fields })
    // The host recorded nothing against the node for any of it: no blocker, and the invite is still there to redeem.
    expect((await liveStatus()).status.blockers).toEqual([])

    // The code is in that one kind of request only: no storage, no link, no other request.
    expect(stored()).not.toContain(invitee.code)
    expect(globalThis.location.href).not.toContain(invitee.code)
    expect(sent.filter(call => JSON.stringify(call).includes(invitee.code)).map(call => call.path)).toEqual([REDEEM_ROUTE, REDEEM_ROUTE])

    // REVOKED by the node that signed it: the next press is the host's refusal, in words, with its code.
    expireChallenges()
    const revoked = await revokeInvite({ requestId: aumlokRequestId(), inviteId: receipt.inviteId }, () => opened.value.signingKey,
      await liveStatus(), { signal })
    expect(revoked.kind).toBe('done')
    await waitFor(() => { expect(sendButton(container)?.disabled).toBe(false) })
    fireEvent.click(sendButton(container) as HTMLButtonElement)
    await waitFor(() => { expect(resultOf(container)?.getAttribute('data-identity-redeem-result')).toBe('refused') }, { timeout: 20_000 })
    expect(resultOf(container)?.textContent).toBe('This invite was revoked by the node that signed it. Nothing was granted. (AUMLOK_INVITE_REVOKED)')
    expect(redeemed[2]).toEqual({ status: 409, body: { ok: false, code: 'AUMLOK_INVITE_REVOKED', status: 409 } })
    expect(redeemPosts(sent)).toHaveLength(3)

    // A REDEMPTION COUNTS NOTHING ON THE EDGE, EVEN A REFUSED ONE. Twelve refused redemptions straight at the host leave
    // the node unlocked: ten counted failures would hard-lock it (AUMLOK_GUARDIAN_QUORUM_REQUIRED) and five in an hour
    // would rate-limit it, and either would show in `blockers`.
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const refused = await globalThis.fetch('/_host/aumlok/redeem', { method: 'POST', credentials: 'same-origin',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ invite: receipt, code: invitee.code }) })
      expect([refused.status, (await refused.json() as { code?: string }).code]).toEqual([409, 'AUMLOK_INVITE_REVOKED'])
    }
    expect((await liveStatus()).status.blockers).toEqual([])

    // Closing Identity takes the code and the host's line with it.
    rerender(<IdentitySurface {...PROPS} activeSurface="aumlok" />)
    rerender(<IdentitySurface {...PROPS} />)
    await waitFor(() => { expect(redeemCard(container).querySelector<HTMLInputElement>('[data-identity-redeem-code]')?.value).toBe('') })
    expect(resultOf(container)).toBeNull()
    expect(sendButton(container)?.disabled).toBe(true)
  }, 180_000)
})

// ── What the real edge cannot be made to do here: a strict stub ────────────────────────────────────────────────────────

const hexOf = (bytes: Uint8Array) => [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('')
/** A node key and an invite it really signed (WebCrypto Ed25519), so the page's own check is the real one. */
async function signedInvite(over: Partial<InvitePayload> = {}, at = Date.now()) {
  const pair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])
  const node = hexOf(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)))
  const invitee = await newInviteeCode()
  const payload: InvitePayload = { schema: 'aukora.invite.v1', inviteId: `invite-${'a'.repeat(20)}`, sponsorPubkeyHex: node,
    inviteeCommitmentSha256: invitee.commitmentSha256, assignedDomainPointer: null, quotaMonth: new Date(at).toISOString().slice(0, 7),
    monthlySequence: 1, revoked: false, issuedAt: at, expiresAt: at + 604_800_000, ...over }
  const receipt: InviteReceipt = { ...payload, signature: await signWithNode(pair.privateKey, invitePreimage(payload)) }
  return { node, receipt, code: invitee.code }
}
/** The store's answer to a good redemption (SOURCE: deploy/cloudflare/src/aumlok.mjs `redeem`). */
const verification = (receipt: InviteReceipt, over: Record<string, unknown> = {}): Record<string, unknown> => ({ ok: true,
  schema: INVITE_VERIFICATION_SCHEMA, inviteId: receipt.inviteId, sponsorPubkeyHex: receipt.sponsorPubkeyHex, recipientStatus: 'CODE_VERIFIED',
  verifiedAt: receipt.issuedAt + 1000, expiresAt: receipt.expiresAt, accessGranted: false, identityEnrolled: false, inviteConsumed: false,
  freshness: 'LOCAL_DURABLE_STATE_ONLY', ...over })
const live = (route: string, body: Record<string, unknown>): HostAnswer => ({ kind: 'live', route, body })
const refusal = (status: number, code: string): HostAnswer => ({ kind: 'refused', route: REDEEM_ROUTE, status, code, message: 'refused' })
const EDGE_STATUS = live('/__x6/status', { ok: true, runtime: 'cloudflare' })
const GUEST_DOOR = { ok: true, schema: 'aukora.guest-door.v1', runtime: 'cloudflare', route: REDEEM_ROUTE, method: 'POST',
  grants: 'nothing', counts: 'this-door-only' }
/**
 * A STRICT HOST CALL: it answers what the host is, and a redemption only when its body is exactly `{ invite, code }` with
 * the receipt's eleven fields and a 43-character code; anything else throws, failing the test.
 */
function strictHost(receipt: InviteReceipt, code: string, redeem: () => HostAnswer | Promise<HostAnswer>, status = EDGE_STATUS,
  door?: HostAnswer) {
  const calls: { route: string; body: Record<string, unknown> | undefined }[] = []
  const call = async (route: string, _signal: AbortSignal, body?: Record<string, unknown>): Promise<HostAnswer> => {
    calls.push({ route, body })
    if (route === '/__x6/status' && body === undefined) return status
    if (route === REDEEM_ROUTE && body === undefined && door !== undefined) return door
    if (route !== REDEEM_ROUTE || body === undefined) throw new Error(`unexpected call: ${route}`)
    expect(Object.keys(body).sort()).toEqual(['code', 'invite'])
    expect(body.invite).toEqual(receipt)
    expect(Object.keys(body.invite as object)).toHaveLength(11)
    expect(body.code).toBe(code)
    expect(body.code).toMatch(/^[A-Za-z0-9_-]{43}$/u)
    return redeem()
  }
  return { call, calls, redeems: () => calls.filter(entry => entry.route === REDEEM_ROUTE) }
}
const signal = () => new AbortController().signal

describe('redeemInvite: what is sent, to whom, and how the answer is read', () => {
  it('asks what the host is (a GET), then sends exactly { invite, code } once; an object with more than the eleven fields is not sent', async () => {
    const { receipt, code } = await signedInvite()
    const host = strictHost(receipt, code, () => live(REDEEM_ROUTE, verification(receipt)))
    const outcome = await redeemInvite(receipt, ` ${code} `, signal(), host.call)
    const { ok: _ok, ...fields } = verification(receipt)
    expect(outcome).toEqual({ kind: 'verified', value: fields })
    expect(host.calls.map(entry => entry.route)).toEqual(['/__x6/status', REDEEM_ROUTE])
    expect(host.calls[0]?.body).toBeUndefined()
    // A receipt object carrying anything more is not a receipt to this page: its own check fails, and nothing is asked.
    const padded = strictHost(receipt, code, () => { throw new Error('a redemption was sent') })
    expect(await redeemInvite({ ...receipt, note: 'extra' } as InviteReceipt, code, signal(), padded.call)).toMatchObject({ kind: 'unclear' })
    expect(padded.calls).toEqual([])
  })

  it('a host without the route says "This host does not take a redemption yet." and is asked once', async () => {
    const { receipt, code } = await signedInvite()
    // hostCall reads a 404 with no AUMLOK code as an absent route (the Worker's NOT_FOUND, or a static fallback).
    const host = strictHost(receipt, code, () => ({ kind: 'absent', route: REDEEM_ROUTE, detail: `the host answers 404 for ${REDEEM_ROUTE}` }))
    const outcome = await redeemInvite(receipt, code, signal(), host.call)
    expect(outcome).toEqual({ kind: 'absent' })
    expect(redeemWords(outcome)).toBe('This host does not take a redemption yet.')
    expect(REDEEM_ABSENT_WORDS).toBe('This host does not take a redemption yet.')
    expect(host.redeems()).toHaveLength(1)
  })

  it('THE MAC HOST IS SENT NOTHING: it would count a redemption as a failed Touch ID attempt (and so is any host this page cannot name)', async () => {
    const { receipt, code } = await signedInvite()
    const never = () => { throw new Error('a redemption was sent') }
    const mac = strictHost(receipt, code, never, live('/__x6/status', { ok: true, runtime: 'local' }))
    expect(await redeemInvite(receipt, code, signal(), mac.call)).toEqual({ kind: 'absent' })
    expect(mac.calls.map(entry => [entry.route, entry.body])).toEqual([['/__x6/status', undefined]])
    for (const status of [live('/__x6/status', { ok: true }), live('/__x6/status', { ok: true, runtime: 'something-else' }),
      { kind: 'absent', route: '/__x6/status', detail: 'the host answers 404 for /__x6/status' } as HostAnswer]) {
      const unknown = strictHost(receipt, code, never, status)
      const outcome = await redeemInvite(receipt, code, signal(), unknown.call)
      expect(outcome).toEqual({ kind: 'unclear', detail: 'Nothing was sent: this page could not tell which host serves it, and it asks only a host it '
        + 'knows takes a redemption.' })
      expect(unknown.redeems()).toEqual([])
    }
    // A host that refuses the read with anything else has not said what it is: nothing is sent, and its code is named.
    const degraded = strictHost(receipt, code, never, { kind: 'refused', route: '/__x6/status', status: 503, code: 'HEAD_STORAGE_UNAVAILABLE', message: 'no' })
    expect(await redeemInvite(receipt, code, signal(), degraded.call)).toEqual({ kind: 'unclear', detail: 'Nothing was sent: this host would '
      + 'not say what it is (HEAD_STORAGE_UNAVAILABLE), and this page asks only a host it knows takes a redemption.' })
    expect(degraded.redeems()).toEqual([])
    // A signed-out host whose guest door does not answer as the edge's: its code is said, and no code is sent.
    const signedOutStatus: HostAnswer = { kind: 'refused', route: '/__x6/status', status: 401, code: 'OWNER_ACCESS_REQUIRED', message: 'no' }
    for (const door of [{ kind: 'refused', route: REDEEM_ROUTE, status: 401, code: 'OWNER_ACCESS_REQUIRED', message: 'no' } as HostAnswer,
      { kind: 'absent', route: REDEEM_ROUTE, detail: `the host answers 404 for ${REDEEM_ROUTE}` } as HostAnswer,
      live(REDEEM_ROUTE, { ...GUEST_DOOR, runtime: 'local' }), live(REDEEM_ROUTE, { ...GUEST_DOOR, grants: 'access' }),
      live(REDEEM_ROUTE, { ...GUEST_DOOR, extra: true }), live(REDEEM_ROUTE, verification(receipt))]) {
      const signedOut = strictHost(receipt, code, never, signedOutStatus, door)
      expect(await redeemInvite(receipt, code, signal(), signedOut.call)).toEqual({ kind: 'refused', code: 'OWNER_ACCESS_REQUIRED',
        words: 'This node answers only a signed-in session today, and this page has none here. Nothing was checked.' })
      expect(signedOut.calls.every(entry => entry.body === undefined)).toBe(true)
    }
  })

  it('A GUEST WITH NO SESSION: the edge\'s guest door says what it is, then exactly { invite, code } is sent once', async () => {
    const { receipt, code } = await signedInvite()
    const guest = strictHost(receipt, code, () => live(REDEEM_ROUTE, verification(receipt)),
      { kind: 'refused', route: '/__x6/status', status: 401, code: 'OWNER_ACCESS_REQUIRED', message: 'no' }, live(REDEEM_ROUTE, GUEST_DOOR))
    const outcome = await redeemInvite(receipt, code, signal(), guest.call)
    const { ok: _ok, ...fields } = verification(receipt)
    expect(outcome).toEqual({ kind: 'verified', value: fields })
    expect(guest.calls.map(entry => [entry.route, entry.body === undefined ? 'GET' : 'POST'])).toEqual([
      ['/__x6/status', 'GET'], [REDEEM_ROUTE, 'GET'], [REDEEM_ROUTE, 'POST']])
    // The guest door's refusals are said in words like any other, and the strict reading of the answer is unchanged.
    const locked = strictHost(receipt, code, () => refusal(429, 'GUEST_DOOR_LOCKED'),
      { kind: 'refused', route: '/__x6/status', status: 401, code: 'OWNER_ACCESS_REQUIRED', message: 'no' }, live(REDEEM_ROUTE, GUEST_DOOR))
    expect(await redeemInvite(receipt, code, signal(), locked.call)).toMatchObject({ kind: 'refused', code: 'GUEST_DOOR_LOCKED' })
    const claims = strictHost(receipt, code, () => live(REDEEM_ROUTE, verification(receipt, { accessGranted: true })),
      { kind: 'refused', route: '/__x6/status', status: 401, code: 'OWNER_ACCESS_REQUIRED', message: 'no' }, live(REDEEM_ROUTE, GUEST_DOOR))
    expect(await redeemInvite(receipt, code, signal(), claims.call)).toMatchObject({ kind: 'unclear' })
  })

  it('nothing this page already knows will fail is sent: no code, a wrong or malformed code, an expired or edited invite', async () => {
    const { receipt, code } = await signedInvite()
    const other = await signedInvite()
    const old = await signedInvite({}, Date.now() - 604_800_001)
    const never = () => { throw new Error('a redemption was sent') }
    const notSent = { kind: 'unclear', detail: 'Nothing was sent: this page’s own check of the signature, the date and the code does not pass.' }
    for (const [invite, typed] of [[receipt, ''], [receipt, other.code], [receipt, 'not-a-code'], [receipt, code.slice(0, 42)], [receipt, `${code}A`],
      [old.receipt, old.code], [{ ...receipt, assignedDomainPointer: 'https://evil.example' }, code]] as [InviteReceipt, string][]) {
      const host = strictHost(invite, typed, never)
      expect(await redeemInvite(invite, typed, signal(), host.call)).toEqual(notSent)
      expect(host.calls).toEqual([])
    }
  })

  it('every refusal the store gives is said in plain words with its code, and each says nothing was granted or checked', async () => {
    const { receipt, code } = await signedInvite()
    const expected: Record<string, [number, string]> = {
      AUMLOK_INVITE_REDEEM_INVALID: [400, 'This node refused the request as malformed. Nothing was checked.'],
      AUMLOK_INVITE_SPONSOR_UNTRUSTED: [403, 'This node did not sign this invite: it was vouched by another node’s key, or this node is not bound. '
        + 'Nothing was granted.'],
      AUMLOK_INVITE_NOT_FOUND: [404, 'This node holds no invite like this one. Nothing was granted.'],
      AUMLOK_INVITE_REVOKED: [409, 'This invite was revoked by the node that signed it. Nothing was granted.'],
      AUMLOK_INVITE_EXPIRED: [403, 'This node says the invite is not valid at this time (it has expired, or its time has not come). '
        + 'Nothing was granted.'],
      AUMLOK_INVITE_CODE_INVALID: [403, 'This node says the code is not the one this invite was made for. Nothing was granted.'],
      OWNER_ACCESS_REQUIRED: [401, 'This node answers only a signed-in session today, and this page has none here. Nothing was checked.'],
    }
    for (const [refusalCode, [status, words]] of Object.entries(expected)) {
      const host = strictHost(receipt, code, () => refusal(status, refusalCode))
      const outcome = await redeemInvite(receipt, code, signal(), host.call)
      expect(outcome).toEqual({ kind: 'refused', code: refusalCode, words })
      expect(redeemWords(outcome)).toBe(`${words} (${refusalCode})`)
      expect(words).toMatch(/Nothing was (?:granted|checked)\.$/u)
      // A refusal is never asked again by the page.
      expect(host.redeems()).toHaveLength(1)
    }
    // A code this page does not know is named as the host said it, and claims nothing more.
    expect(redeemRefusalWords('AUMLOK_SOMETHING_NEW')).toBe('This node refused (AUMLOK_SOMETHING_NEW). Nothing was granted.')
    expect(redeemRefusalWords('constructor')).toBe('This node refused (constructor). Nothing was granted.')
  })

  it('the answer is read strictly: another invite, another sponsor, a claim of access, or a missing field is never shown as verified', async () => {
    const { receipt, code } = await signedInvite()
    const good = verification(receipt)
    expect(inviteVerificationOf(good, receipt)).not.toBeNull()
    const { freshness: _freshness, ...short } = good
    const bad: Record<string, unknown>[] = [
      { ...good, schema: 'aukora.invite-verification.v2' }, { ...good, inviteId: `invite-${'b'.repeat(20)}` },
      { ...good, sponsorPubkeyHex: 'f'.repeat(64) }, { ...good, recipientStatus: 'ENROLLED' }, { ...good, accessGranted: true },
      { ...good, identityEnrolled: true }, { ...good, inviteConsumed: true }, { ...good, expiresAt: receipt.expiresAt + 1 },
      { ...good, verifiedAt: receipt.expiresAt }, { ...good, verifiedAt: receipt.issuedAt - 1 }, { ...good, verifiedAt: '1' },
      { ...good, freshness: 'not a code' }, { ...good, role: 'owner' }, short, { ok: true },
      // Guest access may only be said as NOT available: a claim that a guest was let in, or a loose shape, is not read.
      { ...good, guestAccess: { available: true, code: 'GUEST_ACCESS_GRANTED' } }, { ...good, guestAccess: { available: false } },
      { ...good, guestAccess: { available: false, code: 'X', session: 's' } }, { ...good, guestAccess: null },
    ]
    for (const body of bad) {
      expect(inviteVerificationOf(body, receipt)).toBeNull()
      const host = strictHost(receipt, code, () => live(REDEEM_ROUTE, body))
      expect(await redeemInvite(receipt, code, signal(), host.call)).toEqual({ kind: 'unclear',
        detail: 'This node answered in a shape this page does not read, so nothing is claimed from it.' })
      expect(host.redeems()).toHaveLength(1)
    }
    // An older edge (eleven fields) and the Wave 6 edge (with guestAccess: not available) are both read; only the newer
    // one makes the line say guests have no way in.
    const older = inviteVerificationOf(good, receipt) as InviteVerification
    const newer = inviteVerificationOf({ ...good, guestAccess: { available: false, code: 'GUEST_ACCESS_UNAVAILABLE' } }, receipt) as InviteVerification
    expect(older.guestAccess).toBeUndefined()
    expect(newer.guestAccess).toEqual({ available: false, code: 'GUEST_ACCESS_UNAVAILABLE' })
    expect(redeemWords({ kind: 'verified', value: older })).not.toContain('no way in')
    expect(redeemWords({ kind: 'verified', value: newer })).toContain('This node gives guests no way in yet (GUEST_ACCESS_UNAVAILABLE).')
    // Another freshness word is said as the host said it, never as the local-only sentence.
    const witnessed = inviteVerificationOf({ ...good, freshness: 'WITNESSED' }, receipt) as InviteVerification
    expect(redeemWords({ kind: 'verified', value: witnessed })).toContain('It names its freshness as WITNESSED.')
  })

  it('a lost answer is unclear and is NOT sent again', async () => {
    const { receipt, code } = await signedInvite()
    const host = strictHost(receipt, code, () => ({ kind: 'absent', route: REDEEM_ROUTE, detail: 'the host did not answer (Failed to fetch)' }))
    expect(await redeemInvite(receipt, code, signal(), host.call)).toEqual({ kind: 'unclear',
      detail: 'The answer was lost on the way, so what this node said is not known. It was not sent again.' })
    expect(host.redeems()).toHaveLength(1)
  })
})

describe('The Redeem card over a stubbed host', () => {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  /** A page fetch that knows two routes: what the host is, and the redemption (strictly `{ invite, code }`, by POST). */
  const stubFetch = (receipt: InviteReceipt, code: string, redeem: () => Response | Promise<Response>, runtime: string = 'cloudflare') => {
    const posts: unknown[] = []
    const fetch = vi.fn(async (input: string, init?: RequestInit) => {
      if (input === '/__x6/status') return json({ ok: true, runtime })
      if (input !== REDEEM_ROUTE) return new Response('nope', { status: 404 })
      expect(init).toMatchObject({ method: 'POST', credentials: 'same-origin', cache: 'no-store' })
      const body = JSON.parse(typeof init?.body === 'string' ? init.body : '') as Record<string, unknown>
      expect(body).toEqual({ invite: receipt, code })
      posts.push(body)
      return redeem()
    })
    vi.stubGlobal('fetch', fetch)
    return { fetch, posts }
  }
  const openCard = async (receipt: InviteReceipt, code: string) => {
    globalThis.location.hash = new URL(inviteLinkOf(receipt, EDGE)).hash
    const view = render(<IdentitySurface {...PROPS} />)
    await waitFor(() => { expect(redeemCard(view.container).querySelector('[data-identity-redeem="signed"]')).not.toBeNull() }, { timeout: 10_000 })
    typeCode(view.container, code)
    await codeChecked(view.container, true)
    return view
  }

  it('a host without the route (a 404 with no code) says so in the host\'s place, after one request', async () => {
    const { receipt, code } = await signedInvite()
    const { posts } = stubFetch(receipt, code, () => new Response('Not found', { status: 404 }))
    const { container } = await openCard(receipt, code)
    fireEvent.click(sendButton(container) as HTMLButtonElement)
    await waitFor(() => { expect(resultOf(container)?.getAttribute('data-identity-redeem-result')).toBe('absent') })
    expect(resultOf(container)?.textContent).toBe('This host does not take a redemption yet.')
    expect(posts).toHaveLength(1)
  })

  it('on the Mac host nothing is sent, and the card says this host does not take a redemption yet', async () => {
    const { receipt, code } = await signedInvite()
    const { posts, fetch } = stubFetch(receipt, code, () => { throw new Error('a redemption was sent') }, 'local')
    const { container } = await openCard(receipt, code)
    fireEvent.click(sendButton(container) as HTMLButtonElement)
    await waitFor(() => { expect(resultOf(container)?.getAttribute('data-identity-redeem-result')).toBe('absent') })
    expect(resultOf(container)?.textContent).toBe('This host does not take a redemption yet.')
    expect(posts).toEqual([])
    expect(JSON.stringify(fetch.mock.calls)).not.toContain(code)
  })

  it('one press sends once while the answer is out; a keystroke after it takes the line away; an answer for a code since changed is dropped', async () => {
    const { receipt, code } = await signedInvite()
    let answer: (response: Response) => void = () => {}
    const { posts } = stubFetch(receipt, code, () => new Promise<Response>((done) => { answer = done }))
    const { container } = await openCard(receipt, code)
    fireEvent.click(sendButton(container) as HTMLButtonElement)
    fireEvent.click(sendButton(container) as HTMLButtonElement)
    await waitFor(() => { expect(posts).toHaveLength(1) })
    expect(sendButton(container)?.disabled).toBe(true)
    expect(sendButton(container)?.textContent).toBe('Asking this node…')
    // Nothing says verified before the host answered.
    expect(resultOf(container)).toBeNull()
    fireEvent.click(sendButton(container) as HTMLButtonElement)
    answer(json(verification(receipt)))
    await waitFor(() => { expect(resultOf(container)?.getAttribute('data-identity-redeem-result')).toBe('verified') })
    expect(posts).toHaveLength(1)
    expect(resultOf(container)?.textContent).toContain('nothing was granted, no identity was enrolled, and the invite was not used up')
    // The line was about that code: one more keystroke and it is gone, and the button is dead until the code is right again.
    typeCode(container, code.slice(0, 42))
    await codeChecked(container, false)
    expect(resultOf(container)).toBeNull()
    // An answer that lands after the code changed is not shown under the new code.
    typeCode(container, code)
    await codeChecked(container, true)
    fireEvent.click(sendButton(container) as HTMLButtonElement)
    await waitFor(() => { expect(posts).toHaveLength(2) })
    typeCode(container, code.slice(0, 41))
    answer(json(verification(receipt)))
    await codeChecked(container, false)
    await new Promise((done) => { setTimeout(done, 30) })
    expect(resultOf(container)).toBeNull()
    expect(posts).toHaveLength(2)
  })
})
