// @vitest-environment jsdom
/**
 * Identity, Nostr card: "Publish her head on Nostr" and minting her key, both behind the one Class 3 approval flow.
 *
 * The unsigned event is checked against the MOUNTED seed-nostr-anchor organ itself (found through mirror/home/balls/HEAD.json,
 * its bytes checked against its specifier), the npub against @scure/base's bech32, the request binding against a SHA-256
 * computed here with the organ's own canonical JSON, and the node's answer is signed here with @noble/curves (the library
 * the edge signs with). Nothing here talks to a real host.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { schnorr } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js'
import { bech32 } from '@scure/base'
import { IDENTITY_SURFACE, IdentitySurface } from '../src/client/spatial/apps/identity/IdentitySurface.tsx'
import {
  ANCHOR_ROUTE, ANCHOR_VISIBLE_POLL_MS, ANCHOR_VISIBLE_POLLS, APPROVAL_FINISH_DEADLINE_MS, PUBLIC_HEAD_ROUTE, anchorEvent, anchorFactsOf,
  anchorRefusalWords, approvalWords, approveBounded, nip01Id, npubOf, prepareAnchor, publishOutcomeOf, readPublicHead,
  resetPublicationForTests, servedMatch, signedAnchorOf, type AnchorFacts, type UnsignedAnchor,
} from '../src/client/spatial/apps/identity/nostr.ts'
import { resetApprovalsForTests } from '../src/client/spatial/portal/touch-id-timing.ts'

// ── the mounted organ, by HEAD's own pointer ─────────────────────────────────────────────────────────────────────────
interface Organ {
  checkpointTags: (args: Record<string, unknown>) => Record<string, unknown>
  checkpointVerify: (event: unknown) => Record<string, unknown>
  canonicalJson: (value: unknown) => string
}
/** The repository root (vitest runs from it). */
const ROOT = `${resolve(process.cwd())}/`
const head = JSON.parse(readFileSync(`${ROOT}mirror/home/balls/HEAD.json`, 'utf8')) as { entries: Record<string, { specifier: string }> }
const specifier = head.entries['seed-nostr-anchor']?.specifier ?? ''
const organSha = specifier.replace(/^ball:/, '')
const organCode = readFileSync(`${ROOT}mirror/home/balls/${organSha}.js`, 'utf8')
const organ: Organ = (() => {
  const module = { exports: {} as Organ }
  // The organ is CommonJS text; this runs exactly its bytes, in a context of its own.
  runInNewContext(organCode, { module, exports: module.exports })
  return module.exports
})()

const sha256Hex = (text: string | Uint8Array) => createHash('sha256').update(text).digest('hex')
const b64u = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url')
const ab = (bytes: Uint8Array): ArrayBuffer => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer

const SECRET = hexToBytes('3'.repeat(64))
const PUB = bytesToHex(schnorr.getPublicKey(SECRET))
const NPUB = bech32.encode('npub', bech32.toWords(hexToBytes(PUB)))
const FACTS: AnchorFacts = { headBallId: '7a'.repeat(32), epoch: 171, receiptsLeafHash: '5c'.repeat(32), nodePubkeyHex: PUB }

/** Sign as the edge does: id = sha256 of the NIP-01 array, BIP-340 over the id with @noble. */
function nodeSigns(event: UnsignedAnchor) {
  const id = sha256Hex(JSON.stringify([0, event.pubkey, event.created_at, event.kind, event.tags, event.content]))
  return { ...event, id, sig: bytesToHex(schnorr.sign(hexToBytes(id), SECRET)) }
}

// ── a passkey for jsdom: the browser's own sheet, answering exactly the challenge it was given ───────────────────────
function stubPasskey({ pending = false } = {}) {
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
  const prompts: string[] = []
  vi.stubGlobal('PublicKeyCredential', Credential)
  vi.stubGlobal('AuthenticatorAssertionResponse', Assertion)
  vi.stubGlobal('AuthenticatorAttestationResponse', class Attestation { readonly kind = 'attestation' })
  Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true })
  Object.defineProperty(navigator, 'credentials', { configurable: true, value: {
    create: async () => { throw new Error('not asked here') },
    get: async ({ publicKey, signal }: { publicKey: PublicKeyCredentialRequestOptions; signal?: AbortSignal }) => {
      prompts.push('assert')
      // A sheet still open: it ends only when the page aborts it, as the browser's own does.
      if (pending) {
        return new Promise<never>((_resolve, reject) => {
          signal?.addEventListener('abort', () => { reject(new DOMException('The operation was aborted.', 'AbortError')) })
        })
      }
      const challenge = Buffer.from(publicKey.challenge as Uint8Array)
      const data = new TextEncoder().encode(JSON.stringify({ type: 'webauthn.get', challenge: b64u(challenge), origin: location.origin, crossOrigin: false }))
      return new Credential(ab(new Uint8Array(16).fill(7)), new Assertion(ab(data), ab(new Uint8Array(37)), ab(new Uint8Array(64)), null))
    },
  } })
  return prompts
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
type Route = Response | ((init: RequestInit | undefined) => Response | Promise<Response>)
interface Call { readonly route: string; readonly init: RequestInit | undefined }
function edge(routes: Record<string, Route>) {
  const calls: Call[] = []
  const fetch = vi.fn(async (input: string, init?: RequestInit) => {
    calls.push({ route: input, init })
    const route = routes[input]
    if (route === undefined) return new Response('nope', { status: 404 })
    return typeof route === 'function' ? await route(init) : route.clone()
  })
  return { fetch, calls }
}
const bodyOf = (init: RequestInit | undefined): Record<string, unknown> => JSON.parse(init?.body as string) as Record<string, unknown>
/**
 * Every code the edge can answer a publication with, SOURCE: nostr-anchor.mjs handleNostrAnchorRoute,
 * publishHeadAnchor, parseAnchorEvent, readMirrorReceiptsText, readHeadAnchor; head-do.mjs authorizeClass3InTransaction;
 * messages-store.mjs signNodeEventInTransaction; the Worker's NOSTR hook and the owner checks in front of it.
 */
const EDGE_CODES = [
  'NOSTR_ANCHOR_OWNER_REQUIRED', 'NOSTR_ANCHOR_JSON_REQUIRED', 'NOSTR_ANCHOR_REQUEST_LIMIT', 'NOSTR_ANCHOR_EVENT_INVALID',
  'NOSTR_ANCHOR_KIND_INVALID', 'NOSTR_ANCHOR_CONTENT_INVALID', 'NOSTR_ANCHOR_CONTENT_NOT_CANONICAL', 'NOSTR_ANCHOR_PUBKEY_MISMATCH',
  'NOSTR_ANCHOR_TAGS_MISMATCH', 'NOSTR_ANCHOR_CLOCK_UNAVAILABLE', 'NOSTR_ANCHOR_CLOCK_SKEW', 'NOSTR_ANCHOR_RECEIPTS_UNAVAILABLE',
  'NOSTR_ANCHOR_RECEIPTS_MISMATCH', 'NOSTR_ANCHOR_HEAD_MISMATCH', 'NOSTR_ANCHOR_IDENTITY_REQUIRED', 'NOSTR_ANCHOR_SIGNING_UNAVAILABLE',
  'NOSTR_ANCHOR_STATE_CORRUPT', 'NOSTR_ANCHOR_UNAVAILABLE', 'BOOTSTRAP_REQUIRED', 'CLASS3_WEBAUTHN_REQUIRED',
  'MESSAGES_EVENT_INVALID', 'MESSAGES_EVENT_PUBKEY_MISMATCH', 'MESSAGES_IDENTITY_REQUIRED', 'MESSAGES_SIGNING_UNAVAILABLE',
  'MESSAGES_STATE_CORRUPT', 'METHOD_UNAVAILABLE', 'NOT_FOUND', 'SAME_ORIGIN_BROWSER_REQUIRED', 'OWNER_ACCESS_REQUIRED',
  'ORIGIN_REFUSED', 'OWNER_ACCESS_NOT_CONFIGURED',
] as const
const contacts = { ok: true, conversations: [], contacts: [], identity: { npub: NPUB, pubkey: PUB, signing: 'bip340-schnorr' },
  relay: { connected: false, urls: [] } }

/** The approval routes as the host answers them: echo the binding, take the assertion, hand back a single-use approval. */
function approvalRoutes(seen: { binding: unknown }) {
  return {
    '/_host/aumlok/challenge': (init: RequestInit | undefined) => {
      seen.binding = bodyOf(init).binding
      return json({ ok: true, challengeId: 'approve-0001', binding: seen.binding,
        publicKey: { challenge: b64u(new Uint8Array(32).fill(9)), rpId: location.hostname, userVerification: 'required' } })
    },
    '/_host/aumlok/approve': () => json({ ok: true, approvalToken: b64u(new Uint8Array(32).fill(4)), expiresAt: Date.now() + 60_000,
      approvedAt: Date.now(), binding: seen.binding }),
  }
}

const PROPS = { activeSurface: IDENTITY_SURFACE, closeSurface: () => {} } as unknown as Parameters<typeof IdentitySurface>[0]
const mount = () => render(<IdentitySurface {...PROPS} />)
/** The same surface with another app in the centre lane (Identity closed, as the owner closes it). */
const CLOSED = { ...PROPS, activeSurface: 'messages' } as unknown as Parameters<typeof IdentitySurface>[0]
const openNostr = (container: HTMLElement) => {
  const head = container.querySelector('[data-identity-portal="nostr"] .ak-portal__head')
  if (!(head instanceof HTMLElement)) throw new Error('no nostr portal')
  fireEvent.click(head)
}
const text = (container: HTMLElement, selector: string) => container.querySelector(selector)?.textContent ?? null

class FakeChannel { onmessage = null; close() {} }
class FakeSocket { onopen = null; onmessage = null; onclose = null; close() {} }
beforeEach(() => {
  vi.stubGlobal('BroadcastChannel', FakeChannel)
  vi.stubGlobal('WebSocket', FakeSocket)
})
afterEach(() => {
  vi.useRealTimers()
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  resetApprovalsForTests()
  resetPublicationForTests()
  Reflect.deleteProperty(navigator, 'credentials')
  Reflect.deleteProperty(window, 'isSecureContext')
})

describe('the event this page builds is the mounted organ’s event', () => {
  it('HEAD points at the organ by the SHA-256 of its exact bytes', () => {
    expect(specifier).toMatch(/^ball:[0-9a-f]{64}$/)
    expect(sha256Hex(organCode)).toBe(organSha)
  })

  it('byte for byte: kind, created_at, tags and content, for several facts', () => {
    for (const facts of [FACTS, { ...FACTS, epoch: 0 }, { headBallId: '0'.repeat(64), epoch: 9_007_199_254_740_991, receiptsLeafHash: 'f'.repeat(64), nodePubkeyHex: 'a'.repeat(64) }]) {
      const built = organ.checkpointTags({ ...facts, createdAt: 1_794_400_000 })
      expect(built.ok).toBe(true)
      const mine = anchorEvent(facts, 1_794_400_000)
      expect(JSON.stringify([mine.kind, mine.created_at, mine.tags, mine.content]))
        .toBe(JSON.stringify([built.kind, built.created_at, built.tags, built.content]))
      expect(mine.pubkey).toBe(facts.nodePubkeyHex)
      expect(organ.checkpointVerify(mine)).toMatchObject({ ok: true, headBallId: facts.headBallId, epoch: facts.epoch })
    }
  })

  it('reads facts only when every one is exactly well formed (the organ refuses the same ones)', () => {
    expect(anchorFactsOf(FACTS)).toEqual(FACTS)
    for (const bad of [{ headBallId: 'AB'.repeat(32) }, { epoch: -1 }, { epoch: 1.5 }, { receiptsLeafHash: 'ab' }, { nodePubkeyHex: null }]) {
      expect(anchorFactsOf({ ...FACTS, ...bad })).toBeNull()
      expect(organ.checkpointTags({ ...FACTS, ...bad }).ok).toBe(false)
    }
  })

  it('a signed event whose tags and content disagree is not read as her head, as the organ refuses it', () => {
    const signed = nodeSigns(anchorEvent(FACTS, 1_794_400_000))
    expect(signedAnchorOf(signed)?.id).toBe(signed.id)
    const tagged = { ...signed, tags: signed.tags.map(tag => (tag[0] === 'epoch' ? ['epoch', '172'] : tag)) }
    expect(signedAnchorOf(tagged)).toBeNull()
    expect(organ.checkpointVerify(tagged).ok).toBe(false)
    expect(signedAnchorOf({ ...signed, content: signed.content.replace('"epoch":171', '"epoch":170') })).toBeNull()
    expect(signedAnchorOf({ ...signed, kind: 1 })).toBeNull()
  })

  it('the body the passkey binds is the bare unsigned event, exactly the five keys the edge takes', async () => {
    const prepared = await prepareAnchor(FACTS, 'https://x61.example', 1_794_400_000_000)
    // nostr-anchor.mjs parseAnchorEvent: exactKeys(event, ['pubkey','created_at','kind','tags','content']).
    expect(Object.keys(prepared.body).sort()).toEqual(['content', 'created_at', 'kind', 'pubkey', 'tags'])
    expect(organ.canonicalJson(prepared.body)).toBe(organ.canonicalJson(prepared.event))
    expect(prepared.terms).toEqual({ schema: 'aukora.class3.action.v1', audience: 'https://x61.example', method: 'POST',
      pathname: ANCHOR_ROUTE, bodySha256: sha256Hex(organ.canonicalJson(prepared.event)) })
    expect(organ.checkpointVerify(prepared.body)).toMatchObject({ ok: true, headBallId: FACTS.headBallId, epoch: FACTS.epoch })
  })

  it('the npub is computed here from the key, and equals bech32 from @scure/base', () => {
    expect(npubOf(PUB)).toBe(NPUB)
    for (const key of ['0'.repeat(64), 'f'.repeat(64), '7e'.repeat(32)]) expect(npubOf(key)).toBe(bech32.encode('npub', bech32.toWords(hexToBytes(key))))
    expect(npubOf('AB'.repeat(32))).toBeNull()
  })
})

describe('Publish her head on Nostr', () => {
  it('before any fingerprint shows every public field in full and what stays private, and asks nothing', async () => {
    const host = edge({ '/aukora-messages/contacts.json': json(contacts), [ANCHOR_ROUTE]: json({ ok: true, facts: FACTS }) })
    vi.stubGlobal('fetch', host.fetch)
    const { container } = mount()
    openNostr(container)
    await waitFor(() => { expect(container.querySelector('[data-identity-anchor-publish]')).not.toBeNull() })
    expect(text(container, '[data-identity-anchor-epoch]')).toBe('171')
    expect(text(container, '[data-identity-anchor-head]')).toBe(FACTS.headBallId)
    expect(text(container, '[data-identity-anchor-receipts]')).toBe(FACTS.receiptsLeafHash)
    expect(text(container, '[data-identity-anchor-npub]')).toBe(NPUB)
    expect(text(container, '[data-identity-anchor-time]')).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC \(created_at \d+\)$/)
    expect(text(container, '[data-identity-anchor-content]')).toBe(organ.canonicalJson({ schema: 'aukora.nostr.head.v1', ...FACTS }))
    const card = container.querySelector('[data-identity-anchor]')?.textContent ?? ''
    for (const words of ['not a relay', 'NIP-78 application data', 'Stays private', 'secret key', 'your Messages', 'passkey data',
      'NIP-05 maps a name to a key and proves nothing else', 'does not show that your fingerprint approved it']) expect(card).toContain(words)
    expect(card.toLowerCase()).not.toContain('token')
    expect(text(container, '[data-identity-anchor-url]')).toBe(`${location.origin}/api/nostr/head`)
    expect(text(container, '[data-identity-anchor-published]')).toBe('nothing is served at this address yet')
    expect(host.calls.map(call => call.route)).not.toContain('/_host/aumlok/challenge')
    expect(host.calls.filter(call => call.route === ANCHOR_ROUTE).every(call => call.init?.method === 'GET')).toBe(true)
  })

  it('one press: Touch ID on exactly this body, then the node signs exactly the approved event', async () => {
    const prompts = stubPasskey()
    const seen = { binding: null as unknown }
    let signed: ReturnType<typeof nodeSigns> | null = null
    const host = edge({
      '/aukora-messages/contacts.json': json(contacts),
      ...approvalRoutes(seen),
      [ANCHOR_ROUTE]: (init) => {
        if (init?.method !== 'POST') return json({ ok: true, facts: FACTS })
        signed = nodeSigns(bodyOf(init) as unknown as UnsignedAnchor)
        return json({ ok: true, event: signed })
      },
      [PUBLIC_HEAD_ROUTE]: () => (signed === null ? json({ ok: false, code: 'NOSTR_ANCHOR_UNPUBLISHED' }, 404) : json({ ok: true, event: signed })),
    })
    vi.stubGlobal('fetch', host.fetch)
    const { container } = mount()
    openNostr(container)
    await waitFor(() => { expect(container.querySelector('[data-identity-anchor-publish]')).not.toBeNull() })
    fireEvent.click(container.querySelector('[data-identity-anchor-publish]') as HTMLElement)
    await waitFor(() => { expect(container.textContent).toContain('Accepted. The node took it and returned exactly the event you approved') })
    // THE PAGE DOES NOT CHECK THE BIP-340 SIGNATURE ITSELF, AND SAYS SO.
    expect(container.textContent).toContain('with a signature this page does not check; anyone can check it at the public address once it shows there')
    expect(container.textContent).not.toContain('The node signed exactly')
    expect(prompts).toEqual(['assert'])
    const post = host.calls.find(call => call.route === ANCHOR_ROUTE && call.init?.method === 'POST')
    // THE BODY IS THE BARE UNSIGNED EVENT: exactly the five keys the edge's parseAnchorEvent takes, no wrapper.
    const body = bodyOf(post?.init)
    expect(Object.keys(body).sort()).toEqual(['content', 'created_at', 'kind', 'pubkey', 'tags'])
    const event = body as unknown as UnsignedAnchor
    expect(event.kind).toBe(30078)
    expect(event.pubkey).toBe(PUB)
    expect(JSON.stringify(event.tags)).toBe(JSON.stringify(organ.checkpointTags({ ...FACTS, createdAt: event.created_at }).tags))
    expect(Math.abs(event.created_at - Math.floor(Date.now() / 1000))).toBeLessThan(60)
    // THE PASSKEY APPROVED EXACTLY THESE BYTES, ON THIS ORIGIN, FOR THIS PATH.
    expect(seen.binding).toEqual({ schema: 'aukora.class3.action.v1', audience: location.origin, method: 'POST', pathname: ANCHOR_ROUTE,
      bodySha256: sha256Hex(organ.canonicalJson(body)) })
    expect((post?.init?.headers as Record<string, string>)['x-x6-class3-approval']).toBe(b64u(new Uint8Array(32).fill(4)))
    // SEEN AT THE PUBLIC ADDRESS only once a read of that address, made after the POST, serves this id.
    await waitFor(() => { expect(container.querySelector('[data-identity-anchor-seen]')?.getAttribute('data-identity-anchor-seen')).toBe('yes') })
    expect(text(container, '[data-identity-anchor-published]')).toBe(`serves the event you approved: epoch 171, signed ${
      new Date((signed?.['created_at'] ?? 0) * 1000).toISOString().slice(0, 19).replace('T', ' ')} UTC, id ${signed?.['id'] ?? 'none'}`)
    expect(host.calls.filter(call => call.route === ANCHOR_ROUTE && call.init?.method === 'POST')).toHaveLength(1)
    expect(container.querySelector('[data-identity-anchor-check]')).toBeNull()
  })

  it('every refusal from the node is one plain sentence that says nothing was published', async () => {
    stubPasskey()
    const seen = { binding: null as unknown }
    const host = edge({
      '/aukora-messages/contacts.json': json(contacts),
      ...approvalRoutes(seen),
      [ANCHOR_ROUTE]: init => (init?.method === 'POST' ? json({ ok: false, code: 'NOSTR_ANCHOR_RECEIPTS_MISMATCH' }, 409) : json({ ok: true, facts: FACTS })),
    })
    vi.stubGlobal('fetch', host.fetch)
    const { container } = mount()
    openNostr(container)
    await waitFor(() => { expect(container.querySelector('[data-identity-anchor-publish]')).not.toBeNull() })
    fireEvent.click(container.querySelector('[data-identity-anchor-publish]') as HTMLElement)
    await waitFor(() => { expect(container.textContent).toContain('(NOSTR_ANCHOR_RECEIPTS_MISMATCH). Nothing was published.') })
    expect(container.textContent).toContain('a new receipt may still be on its way')
    for (const code of [...EDGE_CODES, 'SOMETHING_NEW']) {
      const words = anchorRefusalWords(code)
      expect(words).toContain(`(${code}). Nothing was published.`)
      expect(words.toLowerCase()).not.toContain('token')
    }
  })

  it('every code the paired edge returns has a sentence of its own, never the generic one', () => {
    const generic = (code: string) => `The node refused (${code}). Nothing was published.`
    expect(anchorRefusalWords('SOMETHING_NEW')).toBe(generic('SOMETHING_NEW'))
    for (const code of EDGE_CODES) expect(anchorRefusalWords(code), code).not.toBe(generic(code))
    // Distinct causes read as distinct sentences.
    expect(new Set(EDGE_CODES.filter(code => !code.endsWith('IDENTITY_REQUIRED')).map(anchorRefusalWords)).size)
      .toBe(EDGE_CODES.filter(code => !code.endsWith('IDENTITY_REQUIRED')).length)
    // A wrong clock is this computer's to fix: reading again cannot help.
    expect(anchorRefusalWords('NOSTR_ANCHOR_CLOCK_SKEW')).toContain('this computer’s clock and the node’s clock differ by more than ten minutes')
    expect(anchorRefusalWords('NOSTR_ANCHOR_HEAD_MISMATCH')).toContain('her head or its epoch changed')
  })

  it('without a passkey in this browser nothing is sent, and it says why', async () => {
    const host = edge({ '/aukora-messages/contacts.json': json(contacts), [ANCHOR_ROUTE]: json({ ok: true, facts: FACTS }) })
    vi.stubGlobal('fetch', host.fetch)
    const { container } = mount()
    openNostr(container)
    await waitFor(() => { expect(container.querySelector('[data-identity-anchor-publish]')).not.toBeNull() })
    fireEvent.click(container.querySelector('[data-identity-anchor-publish]') as HTMLElement)
    await waitFor(() => { expect(container.textContent).toContain('Touch ID cannot run in this browser') })
    expect(host.calls.some(call => call.init?.method === 'POST')).toBe(false)
    expect(approvalWords('class3:binding-mismatch')).toContain('Touch ID was not asked')
  })

  it('a key that is not this card’s npub, or facts not in full, offer nothing', async () => {
    const other = edge({ '/aukora-messages/contacts.json': json(contacts), [ANCHOR_ROUTE]: json({ ok: true, facts: { ...FACTS, nodePubkeyHex: 'ab'.repeat(32) } }) })
    vi.stubGlobal('fetch', other.fetch)
    const first = mount()
    openNostr(first.container)
    await waitFor(() => { expect(text(first.container, '[data-identity-anchor-line]')).toContain('different key') })
    expect(first.container.querySelector('[data-identity-anchor-publish]')).toBeNull()
    cleanup()
    vi.stubGlobal('fetch', edge({ '/aukora-messages/contacts.json': json(contacts), [ANCHOR_ROUTE]: json({ ok: true, facts: { ...FACTS, epoch: '171' } }) }).fetch)
    const second = mount()
    openNostr(second.container)
    await waitFor(() => { expect(text(second.container, '[data-identity-anchor-line]')).toContain('without the four facts in full') })
    cleanup()
    vi.stubGlobal('fetch', edge({ '/aukora-messages/contacts.json': json(contacts) }).fetch)
    const third = mount()
    openNostr(third.container)
    // Job 4: the default line says it in plain words; the route is in the fold.
    await waitFor(() => { expect(text(third.container, '[data-identity-anchor-line-detail]')).toContain(`does not yet tell this page the four facts it checks an event against (GET ${ANCHOR_ROUTE}: the host answers 404`) })
    expect(text(third.container, '[data-identity-anchor-line]')).toBe('This node does not yet tell this page what it would publish, so nothing is offered.')
    expect(third.container.querySelector('[data-identity-anchor-details] [data-identity-anchor-line-detail]')).not.toBeNull()
    expect(third.container.querySelector('[data-identity-anchor-publish]')).toBeNull()
  })

  it('an event prepared too long ago is prepared again and shown, never approved', async () => {
    const prompts = stubPasskey()
    let now = 1_794_400_000_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const host = edge({ '/aukora-messages/contacts.json': json(contacts), [ANCHOR_ROUTE]: json({ ok: true, facts: FACTS }) })
    vi.stubGlobal('fetch', host.fetch)
    const { container } = mount()
    openNostr(container)
    await waitFor(() => { expect(container.querySelector('[data-identity-anchor-publish]')).not.toBeNull() })
    expect(text(container, '[data-identity-anchor-time]')).toContain('(created_at 1794400000)')
    now += 6 * 60_000
    fireEvent.click(container.querySelector('[data-identity-anchor-publish]') as HTMLElement)
    await waitFor(() => { expect(container.textContent).toContain('The time was taken again') })
    expect(text(container, '[data-identity-anchor-time]')).toContain('(created_at 1794400360)')
    expect(prompts).toEqual([])
    expect(host.calls.some(call => call.init?.method === 'POST')).toBe(false)
  })

  it('the re-taken time is in the note itself, and the note names the fold that holds the event (review SHOULD: the time row is '
    + 'folded)', async () => {
    const prompts = stubPasskey()
    let now = 1_794_400_000_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const host = edge({ '/aukora-messages/contacts.json': json(contacts), [ANCHOR_ROUTE]: json({ ok: true, facts: FACTS }) })
    vi.stubGlobal('fetch', host.fetch)
    const { container } = mount()
    openNostr(container)
    await waitFor(() => { expect(container.querySelector('[data-identity-anchor-publish]')).not.toBeNull() })
    now += 6 * 60_000
    fireEvent.click(container.querySelector('[data-identity-anchor-publish]') as HTMLElement)
    await waitFor(() => { expect(text(container, '[data-identity-anchor-time]')).toContain('(created_at 1794400360)') })
    const fold = container.querySelector('[data-identity-anchor-details]')
    expect(fold instanceof HTMLDetailsElement && !fold.open).toBe(true)
    const note = [...container.querySelectorAll('[data-identity-anchor] .x6-identity__status')]
      .find(line => (line.textContent ?? '').includes('The time was taken again'))
    // The note is in the default view (not in the fold), says the new time, and says where the whole event is.
    expect(note).not.toBeUndefined()
    expect(fold?.contains(note ?? null)).toBe(false)
    const utc = `${new Date(1_794_400_360_000).toISOString().slice(0, 19).replace('T', ' ')} UTC`
    expect(note?.textContent).toContain(`(now ${utc})`)
    expect(text(container, '[data-identity-anchor-time]')).toContain(utc)
    expect(note?.textContent).toContain('Open “See exactly what becomes public” to look at the event, then press again.')
    expect(note?.textContent).not.toContain('Look at it, then')
    expect(prompts).toEqual([])
    expect(host.calls.some(call => call.init?.method === 'POST')).toBe(false)
  })

  it('an answer that is not exactly the approved event is not called published', async () => {
    const prepared = await prepareAnchor(FACTS, 'https://x61.example', 1_794_400_000_000)
    const good = nodeSigns(prepared.event)
    expect((await publishOutcomeOf({ status: 200, body: { ok: true, event: good } }, prepared.event)).kind).toBe('published')
    const other = nodeSigns(anchorEvent({ ...FACTS, epoch: 172 }, prepared.event.created_at))
    expect(await publishOutcomeOf({ status: 200, body: { ok: true, event: other } }, prepared.event)).toMatchObject({ kind: 'unclear' })
    expect(await publishOutcomeOf({ status: 200, body: { ok: true, event: { ...good, id: 'ab'.repeat(32) } } }, prepared.event)).toMatchObject({ kind: 'unclear' })
    expect(await publishOutcomeOf({ status: 200, body: { ok: true } }, prepared.event)).toMatchObject({ kind: 'unclear' })
    expect(await publishOutcomeOf({ status: 403, body: { ok: false, code: 'CLASS3_WEBAUTHN_REQUIRED' } }, prepared.event))
      .toEqual({ kind: 'refused', code: 'CLASS3_WEBAUTHN_REQUIRED' })
    expect(await nip01Id(prepared.event)).toBe(good.id)
  })
})

/** Wait until the card offers Publish, and return the button. */
async function publishButton(container: HTMLElement): Promise<HTMLButtonElement> {
  await waitFor(() => { expect(container.querySelector('[data-identity-anchor-publish]')).not.toBeNull() })
  return container.querySelector('[data-identity-anchor-publish]') as HTMLButtonElement
}
/** A response the test hands out later. */
function deferred() {
  let resolve: (response: Response) => void = () => {}
  const promise = new Promise<Response>((done) => { resolve = done })
  return { promise, resolve }
}
/** What the card shows of the event: every field the passkey binds. */
const shownEvent = (container: HTMLElement) => ({ epoch: text(container, '[data-identity-anchor-epoch]'),
  tags: text(container, '[data-identity-anchor-tags]'), content: text(container, '[data-identity-anchor-content]'),
  time: text(container, '[data-identity-anchor-time]') })
const created = (time: string | null) => Number(/\(created_at (\d+)\)/.exec(time ?? '')?.[1])

describe('what is approved is what is on screen (review MUST)', () => {
  it('Read again, then Publish before the read lands: Publish waits; the event approved and sent is the one on screen at the press, '
    + 'and it stays on screen, unchanged, until the publication settles', async () => {
    const prompts = stubPasskey()
    const seen = { binding: null as unknown }
    const reads = [() => json({ ok: true, facts: FACTS })] as (() => Response | Promise<Response>)[]
    const second = deferred()
    reads.push(() => second.promise)
    // A read after the press (Identity closed and opened again while the event is on its way) says the head moved on.
    reads.push(() => json({ ok: true, facts: { ...FACTS, epoch: 173 } }))
    const post = deferred()
    const sent: UnsignedAnchor[] = []
    const host = edge({
      '/aukora-messages/contacts.json': json(contacts),
      ...approvalRoutes(seen),
      [ANCHOR_ROUTE]: (init) => {
        if (init?.method === 'POST') { sent.push(bodyOf(init) as unknown as UnsignedAnchor); return post.promise }
        return (reads.shift() ?? (() => json({ ok: true, facts: { ...FACTS, epoch: 173 } })))()
      },
    })
    vi.stubGlobal('fetch', host.fetch)
    const view = mount()
    const { container } = view
    openNostr(container)
    const button = await publishButton(container)
    expect(text(container, '[data-identity-anchor-epoch]')).toBe('171')
    // THE REVIEWER'S CASE: "Read again", then "Publish" before that read finishes.
    fireEvent.click(container.querySelector('[data-identity-anchor-reread]') as HTMLElement)
    await waitFor(() => { expect(button.disabled).toBe(true) })
    expect(container.querySelector('[data-identity-anchor-reading]')).not.toBeNull()
    fireEvent.click(button)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(prompts).toEqual([])
    expect(host.calls.some(call => call.route === '/_host/aumlok/challenge')).toBe(false)
    // The read lands with a head one epoch on: only now, shown in full, can it be approved.
    second.resolve(json({ ok: true, facts: { ...FACTS, epoch: 172 } }))
    await waitFor(() => { expect(button.disabled).toBe(false) })
    expect(text(container, '[data-identity-anchor-epoch]')).toBe('172')
    const atPress = shownEvent(container)
    fireEvent.click(button)
    await waitFor(() => { expect(sent).toHaveLength(1) })
    // THE BYTES APPROVED AND SENT ARE THE BYTES ON SCREEN AT THE PRESS.
    const body = sent[0] as UnsignedAnchor
    expect(JSON.stringify(body.tags)).toBe(atPress.tags)
    expect(body.content).toBe(atPress.content)
    expect(body.created_at).toBe(created(atPress.time))
    expect(seen.binding).toMatchObject({ bodySha256: sha256Hex(organ.canonicalJson(body)) })
    expect(prompts).toEqual(['assert'])
    // A read made while it is on its way (Identity closed, which unmounts the card, and opened again) lands, and changes
    // nothing on screen.
    view.rerender(<IdentitySurface {...CLOSED} />)
    expect(container.querySelector('[data-identity-anchor]')).toBeNull()
    view.rerender(<IdentitySurface {...PROPS} />)
    openNostr(container)
    await waitFor(() => { expect(host.calls.filter(call => call.route === ANCHOR_ROUTE && call.init?.method !== 'POST')).toHaveLength(3) })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(shownEvent(container)).toEqual(atPress)
    expect(container.textContent).toContain('the event you are approving')
    expect(container.textContent).toContain('Touch ID approved this event. It is on its way to the node')
    // Settled: the outcome is about the event approved; only then may the card show the newer read.
    post.resolve(json({ ok: true, event: nodeSigns(body) }))
    await waitFor(() => { expect(container.textContent).toContain('Accepted. The node took it and returned exactly the event you approved (epoch 172') })
    await waitFor(() => { expect(text(container, '[data-identity-anchor-epoch]')).toBe('173') })
    expect(sent).toHaveLength(1)
  })
})

describe('closing Identity never leaves a stale sentence (review SHOULD)', () => {
  it('closed while Touch ID is asked: the sheet is cancelled, nothing is sent, and on return the card says so', async () => {
    const prompts = stubPasskey({ pending: true })
    const seen = { binding: null as unknown }
    const host = edge({ '/aukora-messages/contacts.json': json(contacts), ...approvalRoutes(seen), [ANCHOR_ROUTE]: json({ ok: true, facts: FACTS }) })
    vi.stubGlobal('fetch', host.fetch)
    const view = mount()
    openNostr(view.container)
    fireEvent.click(await publishButton(view.container))
    await waitFor(() => { expect(prompts).toEqual(['assert']) })
    expect(view.container.textContent).toContain('Waiting for Touch ID.')
    view.rerender(<IdentitySurface {...CLOSED} />)
    view.rerender(<IdentitySurface {...PROPS} />)
    openNostr(view.container)
    await waitFor(() => { expect(view.container.textContent).toContain('The card closed before Touch ID finished. Nothing was sent.') })
    expect(view.container.textContent).not.toContain('Waiting for Touch ID')
    expect(host.calls.some(call => call.route === ANCHOR_ROUTE && call.init?.method === 'POST')).toBe(false)
    // Nothing is running: the card read the facts again and offers Publish.
    const again = await publishButton(view.container)
    await waitFor(() => { expect(again.disabled).toBe(false) })
  })

  it('closed and folded after the fingerprint: the approved send still completes, and on return the card says what the node did, '
    + 'after reading the public address again', async () => {
    stubPasskey()
    const seen = { binding: null as unknown }
    const post = deferred()
    let signed: ReturnType<typeof nodeSigns> | null = null
    let body: UnsignedAnchor | null = null
    const host = edge({
      '/aukora-messages/contacts.json': json(contacts),
      ...approvalRoutes(seen),
      [ANCHOR_ROUTE]: (init) => {
        if (init?.method !== 'POST') return json({ ok: true, facts: FACTS })
        body = bodyOf(init) as unknown as UnsignedAnchor
        return post.promise
      },
      [PUBLIC_HEAD_ROUTE]: () => (signed === null ? json({ ok: false, code: 'NOSTR_ANCHOR_UNPUBLISHED' }, 404) : json({ ok: true, event: signed })),
    })
    vi.stubGlobal('fetch', host.fetch)
    const view = mount()
    openNostr(view.container)
    fireEvent.click(await publishButton(view.container))
    await waitFor(() => { expect(body).not.toBeNull() })
    // Fold the Nostr card (it unmounts) and close Identity, with the approved event on its way.
    openNostr(view.container)
    expect(view.container.querySelector('[data-identity-anchor]')).toBeNull()
    view.rerender(<IdentitySurface {...CLOSED} />)
    // Shown again before the node answers: the truth is "sent, waiting", never "Waiting for Touch ID".
    view.rerender(<IdentitySurface {...PROPS} />)
    openNostr(view.container)
    await waitFor(() => { expect(view.container.textContent).toContain('Touch ID approved this event. It is on its way to the node') })
    expect(view.container.textContent).not.toContain('Waiting for Touch ID')
    openNostr(view.container)
    view.rerender(<IdentitySurface {...CLOSED} />)
    // The node answers while Identity is closed; the send was never cancelled.
    signed = nodeSigns(body as unknown as UnsignedAnchor)
    post.resolve(json({ ok: true, event: signed }))
    await new Promise(resolve => setTimeout(resolve, 20))
    view.rerender(<IdentitySurface {...PROPS} />)
    openNostr(view.container)
    await waitFor(() => { expect(view.container.textContent).toContain('Accepted. The node took it and returned exactly the event you approved') })
    await waitFor(() => { expect(view.container.querySelector('[data-identity-anchor-seen]')?.getAttribute('data-identity-anchor-seen')).toBe('yes') })
    expect(view.container.textContent).not.toContain('Waiting for Touch ID')
    expect(view.container.textContent).not.toContain('on its way to the node')
    expect(host.calls.filter(call => call.route === ANCHOR_ROUTE && call.init?.method === 'POST')).toHaveLength(1)
  })

  it('no clear answer: the card says it is not known and offers one Check, which reads the public address', async () => {
    stubPasskey()
    const seen = { binding: null as unknown }
    let served: ReturnType<typeof nodeSigns> | null = null
    let body: UnsignedAnchor | null = null
    const host = edge({
      '/aukora-messages/contacts.json': json(contacts),
      ...approvalRoutes(seen),
      [ANCHOR_ROUTE]: (init) => {
        if (init?.method !== 'POST') return json({ ok: true, facts: FACTS })
        body = bodyOf(init) as unknown as UnsignedAnchor
        return new Response('upstream went away', { status: 502 })
      },
      [PUBLIC_HEAD_ROUTE]: () => (served === null ? json({ ok: false, code: 'NOSTR_ANCHOR_UNPUBLISHED' }, 404) : json({ ok: true, event: served })),
    })
    vi.stubGlobal('fetch', host.fetch)
    const { container } = mount()
    openNostr(container)
    fireEvent.click(await publishButton(container))
    await waitFor(() => { expect(container.textContent).toContain('No clear answer (the node answered 502 without a code). Whether it was published is not known') })
    expect(container.querySelectorAll('[data-identity-anchor-check]')).toHaveLength(1)
    // The public address, read again on Check, now serves exactly the event approved: so it was published.
    served = nodeSigns(body as unknown as UnsignedAnchor)
    const before = host.calls.filter(call => call.route === PUBLIC_HEAD_ROUTE).length
    fireEvent.click(container.querySelector('[data-identity-anchor-check]') as HTMLElement)
    await waitFor(() => { expect(container.textContent).toContain('so it was published') })
    expect(host.calls.filter(call => call.route === PUBLIC_HEAD_ROUTE).length).toBe(before + 1)
    expect(host.calls.filter(call => call.route === PUBLIC_HEAD_ROUTE).every(call => call.init?.credentials === 'omit')).toBe(true)
    expect(container.querySelector('[data-identity-anchor-check]')).toBeNull()
  })
})

describe('the node accepting it is not the public address serving it (review SHOULD)', () => {
  it('a cached "nothing published" after the POST: the card says the node accepted it, that it can take up to two minutes, '
    + 'and calls it seen only when that address serves this id', async () => {
    stubPasskey()
    const seen = { binding: null as unknown }
    let signed: ReturnType<typeof nodeSigns> | null = null
    let cacheExpired = false
    const host = edge({
      '/aukora-messages/contacts.json': json(contacts),
      ...approvalRoutes(seen),
      [ANCHOR_ROUTE]: (init) => {
        if (init?.method !== 'POST') return json({ ok: true, facts: FACTS })
        signed = nodeSigns(bodyOf(init) as unknown as UnsignedAnchor)
        return json({ ok: true, event: signed })
      },
      // The answer cached before the publication, served until the caches let it go.
      [PUBLIC_HEAD_ROUTE]: () => (cacheExpired && signed !== null ? json({ ok: true, event: signed }) : json({ ok: false, code: 'NOSTR_ANCHOR_UNPUBLISHED' }, 404)),
    })
    vi.stubGlobal('fetch', host.fetch)
    const { container } = mount()
    openNostr(container)
    const button = await publishButton(container)
    await waitFor(() => { expect(text(container, '[data-identity-anchor-published]')).toBe('nothing is served at this address yet') })
    fireEvent.click(button)
    await waitFor(() => { expect(container.textContent).toContain('Accepted. The node took it') })
    await waitFor(() => { expect(text(container, '[data-identity-anchor-published]')).toContain('the node accepted the event you approved') })
    const now = text(container, '[data-identity-anchor-published]') ?? ''
    expect(now).toContain(`(id ${signed?.['id'] ?? 'none'}), but this address does not show it yet; it shows: nothing is served at this address yet`)
    expect(now).toContain('can take up to two minutes to appear here')
    expect(now).not.toContain('serves the event you approved')
    expect(container.querySelector('[data-identity-anchor-seen]')?.getAttribute('data-identity-anchor-seen')).toBe('no')
    // The caches let go; reading again shows it.
    cacheExpired = true
    fireEvent.click(container.querySelector('[data-identity-anchor-check]') as HTMLElement)
    await waitFor(() => { expect(container.querySelector('[data-identity-anchor-seen]')?.getAttribute('data-identity-anchor-seen')).toBe('yes') })
    expect(text(container, '[data-identity-anchor-published]')).toContain('serves the event you approved: epoch 171')
    expect(container.textContent).not.toContain('can take up to two minutes')
  })
})

/** Publish once with Touch ID, the node accepting; `serve` answers the public address (it sees what the node signed). */
async function publishAccepted(serve: (signed: ReturnType<typeof nodeSigns> | null) => Response | Promise<Response>) {
  stubPasskey()
  const seen = { binding: null as unknown }
  const state = { signed: null as ReturnType<typeof nodeSigns> | null }
  const host = edge({
    '/aukora-messages/contacts.json': json(contacts),
    ...approvalRoutes(seen),
    [ANCHOR_ROUTE]: (init) => {
      if (init?.method !== 'POST') return json({ ok: true, facts: FACTS })
      state.signed = nodeSigns(bodyOf(init) as unknown as UnsignedAnchor)
      return json({ ok: true, event: state.signed })
    },
    [PUBLIC_HEAD_ROUTE]: () => serve(state.signed),
  })
  vi.stubGlobal('fetch', host.fetch)
  const view = mount()
  openNostr(view.container)
  fireEvent.click(await publishButton(view.container))
  await waitFor(() => { expect(view.container.textContent).toContain('Accepted. The node took it') })
  const publicReads = () => host.calls.filter(call => call.route === PUBLIC_HEAD_ROUTE).length
  return { ...view, host, state, publicReads }
}
const unpublished = () => json({ ok: false, code: 'NOSTR_ANCHOR_UNPUBLISHED' }, 404)
const nowLine = (container: HTMLElement) => text(container, '[data-identity-anchor-published]') ?? ''

describe('when the automatic reads are spent, the card says so once and plainly', () => {
  it('after the last automatic read: one final sentence, nothing more is scheduled, Check reads again, Read again forgets the run', async () => {
    // The page's timers are fake from here (they still move with the real clock).
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout'] })
    const { container, state, publicReads } = await publishAccepted(() => unpublished())
    await waitFor(() => { expect(nowLine(container)).toContain('this card reads it again') })
    const first = publicReads()
    for (let read = 1; read <= ANCHOR_VISIBLE_POLLS; read += 1) {
      // While a read is still to come, the card may say it reads again.
      expect(nowLine(container)).toContain('can take up to two minutes to appear here')
      vi.advanceTimersByTime(ANCHOR_VISIBLE_POLL_MS)
      await waitFor(() => { expect(publicReads()).toBe(first + read) })
    }
    const id = state.signed?.id ?? 'none'
    await waitFor(() => {
      expect(nowLine(container)).toBe(`the node accepted the event you approved (id ${id}), but this address has not served it after two minutes `
        + 'of reading; it serves nothing. “Check” reads it again.')
    })
    expect(container.textContent).not.toContain('this card reads it again')
    expect(container.textContent).not.toContain('can take up to two minutes')
    // Nothing is scheduled: time passes and the address is not read again.
    vi.advanceTimersByTime(10 * ANCHOR_VISIBLE_POLL_MS)
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(publicReads()).toBe(first + ANCHOR_VISIBLE_POLLS)
    // "Check" reads it once more, and the sentence stays final.
    fireEvent.click(container.querySelector('[data-identity-anchor-check]') as HTMLElement)
    await waitFor(() => { expect(publicReads()).toBe(first + ANCHOR_VISIBLE_POLLS + 1) })
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(nowLine(container)).toContain('has not served it after two minutes of reading; it serves nothing. “Check” reads it again.')
    // "Read again" forgets a run whose reads are spent: the card is back to what the address serves.
    fireEvent.click(container.querySelector('[data-identity-anchor-reread]') as HTMLElement)
    await waitFor(() => { expect(container.textContent).not.toContain('Accepted. The node took it') })
    await waitFor(() => { expect(nowLine(container)).toBe('nothing is served at this address yet') })
    expect(container.querySelector('[data-identity-anchor-check]')).toBeNull()
  }, 30_000)

  it('a different event with a later time at the address (review SHOULD, job 4): reported as a different event, never "since then"; '
    + 'the bounded reads continue, and the card waits for the approved one', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout'] })
    let newer: ReturnType<typeof nodeSigns> | null = null
    const { container, state, publicReads } = await publishAccepted((signed) => {
      if (signed === null) return unpublished()
      newer ??= nodeSigns(anchorEvent({ ...FACTS, epoch: 172 }, signed.created_at + 30))
      return json({ ok: true, event: newer })
    })
    await waitFor(() => { expect(nowLine(container)).toContain('it shows a different event: epoch 172') })
    const id = state.signed?.id ?? 'none'
    expect(nowLine(container)).toContain(`the node accepted the event you approved (id ${id}), but this address does not show it yet`)
    expect(nowLine(container)).toContain('this card reads it again')
    expect(container.textContent).not.toContain('since then')
    expect(container.textContent).not.toContain('later time')
    expect(container.querySelector('[data-identity-anchor-seen]')?.getAttribute('data-identity-anchor-seen')).toBe('no')
    expect(text(container, '[data-identity-anchor-result]')).toBe('Accepted. The public address still shows a different event; this card reads it again for up to two minutes.')
    // THE BOUNDED READS GO ON: every automatic read is still made, and then the one final sentence.
    const first = publicReads()
    for (let read = 1; read <= ANCHOR_VISIBLE_POLLS; read += 1) {
      vi.advanceTimersByTime(ANCHOR_VISIBLE_POLL_MS)
      await waitFor(() => { expect(publicReads()).toBe(first + read) })
    }
    await waitFor(() => { expect(nowLine(container)).toContain('has not served it after two minutes of reading; it serves epoch 172') })
    expect(container.textContent).not.toContain('since then')
  }, 30_000)
})

describe('"seen" means the address serves exactly the approved event, not just its id string', () => {
  it('the id is recomputed from the served fields, once per read, and every field must be the approved one', async () => {
    const prepared = await prepareAnchor(FACTS, 'https://x61.example', 1_794_400_000_000)
    const good = nodeSigns(prepared.event)
    const serve = (event: unknown) => readPublicHead(new AbortController().signal, async () => json({ ok: true, event }))
    const exact = await serve(good)
    expect(exact).toMatchObject({ kind: 'published', computedId: good.id })
    expect(servedMatch(exact, prepared)).toEqual({ kind: 'exact' })
    // The approved id string, on an event with another time: its fields hash to another id.
    const retimed = await serve({ ...good, created_at: good.created_at + 1 })
    expect(servedMatch(retimed, prepared)).toMatchObject({ kind: 'false', differs: ['time'] })
    expect(servedMatch(retimed, prepared)).not.toMatchObject({ computedId: good.id })
    // The approved id string, on another head (tags and content agree with each other, not with the approval).
    const other = anchorEvent({ ...FACTS, epoch: 172 }, good.created_at)
    expect(servedMatch(await serve({ ...nodeSigns(other), id: good.id }), prepared)).toMatchObject({ kind: 'false', differs: ['tags', 'content'] })
    // Another id: not this publication, whatever its time says (nothing is inferred from a later time).
    expect(servedMatch(await serve(nodeSigns(anchorEvent(FACTS, good.created_at + 5))), prepared)).toEqual({ kind: 'other' })
    expect(servedMatch(await serve(nodeSigns(anchorEvent(FACTS, good.created_at - 5))), prepared)).toEqual({ kind: 'other' })
    expect(servedMatch({ kind: 'none' }, prepared)).toEqual({ kind: 'none' })
  })

  it('accepted, and the address serves the approved id on other fields: the card says so plainly and never calls it seen', async () => {
    let forged = 0
    const { container, state } = await publishAccepted((signed) => {
      if (signed === null) return unpublished()
      forged += 1
      return json({ ok: true, event: { ...signed, created_at: signed.created_at + 1 } })
    })
    // Once a read of the address has served it and landed, the card has judged it.
    await waitFor(() => { expect(forged).toBeGreaterThan(0) })
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(container.querySelector('[data-identity-anchor-seen]')?.getAttribute('data-identity-anchor-seen')).toBe('no')
    expect(container.textContent).not.toContain('serves the event you approved:')
    expect(container.querySelector('[data-identity-anchor-match]')?.getAttribute('data-identity-anchor-match')).toBe('false')
    const id = state.signed?.id ?? 'none'
    const line = nowLine(container)
    expect(line).toContain(`serves an event that names the id you approved (${id}), but its fields hash to the NIP-01 id `)
    expect(line).toContain('not to that id; and its time is not the approved event’s. It is not the event you approved, and this card does '
      + 'not call it published.')
    expect(line).not.toContain(`hash to the NIP-01 id ${id}`)
    expect(container.querySelector('[data-identity-anchor-seen]')?.getAttribute('data-identity-anchor-seen')).toBe('no')
    expect(container.textContent).not.toContain('serves the event you approved:')
    expect(container.textContent).not.toContain('so it was published')
  })

  it('no clear answer, then Check finds the approved id on another head: never "so it was published"', async () => {
    stubPasskey()
    const seen = { binding: null as unknown }
    let served: unknown = null
    let body: UnsignedAnchor | null = null
    const host = edge({
      '/aukora-messages/contacts.json': json(contacts),
      ...approvalRoutes(seen),
      [ANCHOR_ROUTE]: (init) => {
        if (init?.method !== 'POST') return json({ ok: true, facts: FACTS })
        body = bodyOf(init) as unknown as UnsignedAnchor
        return new Response('upstream went away', { status: 502 })
      },
      [PUBLIC_HEAD_ROUTE]: () => (served === null ? unpublished() : json({ ok: true, event: served })),
    })
    vi.stubGlobal('fetch', host.fetch)
    const { container } = mount()
    openNostr(container)
    fireEvent.click(await publishButton(container))
    await waitFor(() => { expect(container.textContent).toContain('Whether it was published is not known') })
    const approvedId = nodeSigns(body as unknown as UnsignedAnchor).id
    const moved = anchorEvent({ ...FACTS, epoch: 172 }, (body as unknown as UnsignedAnchor).created_at)
    served = { ...nodeSigns(moved), id: approvedId }
    const before = host.calls.filter(call => call.route === PUBLIC_HEAD_ROUTE).length
    fireEvent.click(container.querySelector('[data-identity-anchor-check]') as HTMLElement)
    await waitFor(() => { expect(host.calls.filter(call => call.route === PUBLIC_HEAD_ROUTE).length).toBe(before + 1) })
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(container.textContent).not.toContain('so it was published')
    expect(container.querySelector('[data-identity-anchor-seen]')?.getAttribute('data-identity-anchor-seen')).toBe('no')
    expect(container.querySelector('[data-identity-anchor-match]')?.getAttribute('data-identity-anchor-match')).toBe('false')
    expect(nowLine(container)).toContain(`names the id you approved (${approvedId}), but its fields hash to the NIP-01 id `)
    expect(nowLine(container)).toContain('its tags and its content are not the approved event’s')
    expect(container.textContent).not.toContain('so it was published')
    expect(container.textContent).toContain('Whether it was published is not known')
    expect(container.querySelectorAll('[data-identity-anchor-check]')).toHaveLength(1)
  })
})

// ── JOB 4: simple by default (owner's words), and the reviewer's last four SHOULDs ───────────────────────────────────

/** The Nostr card as the owner sees it before opening anything: the card without its folded rows. */
function defaultView(container: HTMLElement): HTMLElement {
  const card = container.querySelector('[data-identity-nostr="live"]')
  if (!(card instanceof HTMLElement)) throw new Error('no live nostr card')
  const view = card.cloneNode(true) as HTMLElement
  for (const fold of view.querySelectorAll('details')) fold.remove()
  return view
}
const detailsOf = (container: HTMLElement): HTMLDetailsElement => {
  const fold = container.querySelector('details[data-identity-anchor-details]')
  if (!(fold instanceof HTMLDetailsElement)) throw new Error('no details fold')
  return fold
}
const ROUTE_WORDS = ['/_head', '/aukora-messages', '/api/', '/_host', '/.well-known', 'transcript', 'contacts.json']
/** A body that fails while it is read: the connection went away after the status line. */
const brokenBody = () => new Response(new ReadableStream({ start(controller) { controller.error(new Error('connection reset')) } }),
  { status: 200, headers: { 'content-type': 'application/json' } })

describe('simple by default (owner, job 4)', () => {
  it('the card opens on one sentence, her npub with Copy and ONE gold button; every other row is in one closed fold, and nothing in '
    + 'view names a route', async () => {
    const host = edge({ '/aukora-messages/contacts.json': json(contacts), [ANCHOR_ROUTE]: json({ ok: true, facts: FACTS }), [PUBLIC_HEAD_ROUTE]: unpublished() })
    vi.stubGlobal('fetch', host.fetch)
    const { container } = mount()
    openNostr(container)
    await publishButton(container)
    await waitFor(() => { expect(text(container, '[data-identity-anchor-published]')).toBe('nothing is served at this address yet') })
    const view = defaultView(container)
    expect([...view.querySelectorAll('.ak-lead')].map(lead => lead.textContent))
      .toEqual(['Publish a signed public statement of her head. Nothing private.'])
    expect(view.querySelector('[data-identity-npub]')?.textContent).toBe(NPUB)
    expect([...view.querySelectorAll('button')].map(button => button.textContent)).toEqual(['Copy npub', 'Publish her head on Nostr'])
    expect(view.querySelectorAll('.ak-tone-gold')).toHaveLength(1)
    expect(view.querySelector('.ak-tone-gold')?.hasAttribute('data-identity-anchor-publish')).toBe(true)
    for (const words of ROUTE_WORDS) expect(view.textContent).not.toContain(words)
    // ONE fold, closed, labelled as the owner reads it; it holds every row that was on the card before, unchanged.
    const fold = detailsOf(container)
    expect(container.querySelectorAll('[data-identity-nostr="live"] details')).toHaveLength(1)
    expect(fold.open).toBe(false)
    expect(fold.querySelector('summary')?.textContent).toContain('See exactly what becomes public')
    for (const selector of ['[data-identity-relay]', '[data-identity-anchor-epoch]', '[data-identity-anchor-head]', '[data-identity-anchor-receipts]',
      '[data-identity-anchor-time]', '[data-identity-anchor-npub]', '[data-identity-anchor-tags]', '[data-identity-anchor-content]',
      '[data-identity-anchor-url]', '[data-identity-anchor-published]', '[data-identity-anchor-nip05]', '[data-identity-anchor-reread]']) {
      expect(fold.querySelector(selector), selector).not.toBeNull()
      expect(view.querySelector(selector), selector).toBeNull()
    }
    for (const words of ['bip340-schnorr', 'not a relay', 'only the latest is kept', 'Stays private', 'your Messages', 'does not show that your '
      + 'fingerprint approved it', 'Touch ID approves exactly this event, once', 'NIP-05 maps a name to a key', 'verify its id and BIP-340 signature']) {
      expect(fold.textContent).toContain(words)
      expect(view.textContent).not.toContain(words)
    }
    expect(container.textContent?.toLowerCase()).not.toContain('token')
  })

  it('a press with the fold never opened approves exactly the event the fold holds; afterwards one line and the address with Copy, '
    + 'and the fold stays closed', async () => {
    const prompts = stubPasskey()
    const seen = { binding: null as unknown }
    let sent: UnsignedAnchor | null = null
    let signed: ReturnType<typeof nodeSigns> | null = null
    const host = edge({
      '/aukora-messages/contacts.json': json(contacts),
      ...approvalRoutes(seen),
      [ANCHOR_ROUTE]: (init) => {
        if (init?.method !== 'POST') return json({ ok: true, facts: FACTS })
        sent = bodyOf(init) as unknown as UnsignedAnchor
        signed = nodeSigns(sent)
        return json({ ok: true, event: signed })
      },
      [PUBLIC_HEAD_ROUTE]: () => (signed === null ? unpublished() : json({ ok: true, event: signed })),
    })
    vi.stubGlobal('fetch', host.fetch)
    const { container } = mount()
    openNostr(container)
    const button = await publishButton(container)
    const atPress = shownEvent(container)
    expect(detailsOf(container).open).toBe(false)
    fireEvent.click(button)
    await waitFor(() => { expect(sent).not.toBeNull() })
    const body = sent as unknown as UnsignedAnchor
    // THE EXACT BYTES: what the fold holds at the press, opened or not, is what Touch ID approved and the node received.
    expect(JSON.stringify(body.tags)).toBe(atPress.tags)
    expect(body.content).toBe(atPress.content)
    expect(body.created_at).toBe(created(atPress.time))
    expect(seen.binding).toMatchObject({ bodySha256: sha256Hex(organ.canonicalJson(body)) })
    expect(prompts).toEqual(['assert'])
    await waitFor(() => { expect(container.querySelector('[data-identity-anchor-seen]')?.getAttribute('data-identity-anchor-seen')).toBe('yes') })
    const view = defaultView(container)
    expect(view.querySelector('[data-identity-anchor-result]')?.textContent).toBe('Accepted, and the public address shows it.')
    expect(view.querySelector('[data-identity-anchor-address]')?.textContent).toBe(`${location.origin}${PUBLIC_HEAD_ROUTE}`)
    expect([...view.querySelectorAll('button')].map(control => control.textContent)).toContain('Copy address')
    // The long sentence and every id are in the fold, which stayed closed.
    expect(view.textContent).not.toContain('Accepted. The node took it')
    expect(view.textContent).not.toContain(signed?.['id'] ?? 'none')
    expect(detailsOf(container).querySelector('[data-identity-anchor-outcome]')?.textContent).toContain('Accepted. The node took it and returned exactly')
    expect(detailsOf(container).open).toBe(false)
  })
})

describe('a finished fingerprint never leaves "Waiting for Touch ID" (review SHOULD, job 4)', () => {
  /** The approval exchange stalls after the fingerprint: the node never answers /_host/aumlok/approve (nor its abort). */
  function stalled() {
    const seen = { binding: null as unknown }
    const host = edge({
      '/aukora-messages/contacts.json': json(contacts),
      ...approvalRoutes(seen),
      '/_host/aumlok/approve': () => new Promise<Response>(() => {}),
      [ANCHOR_ROUTE]: json({ ok: true, facts: FACTS }),
    })
    vi.stubGlobal('fetch', host.fetch)
    return host
  }
  const posts = (host: ReturnType<typeof stalled>) => host.calls.filter(call => call.route === ANCHOR_ROUTE && call.init?.method === 'POST')

  it('closed while the node finishes the approval: on return, "Approval did not finish; nothing was sent", and Publish is offered again', async () => {
    const prompts = stubPasskey()
    const host = stalled()
    const view = mount()
    openNostr(view.container)
    fireEvent.click(await publishButton(view.container))
    await waitFor(() => { expect(view.container.textContent).toContain('Touch ID is done. The node is finishing the approval; nothing is sent until it has.') })
    expect(prompts).toEqual(['assert'])
    expect(view.container.textContent).not.toContain('Waiting for Touch ID')
    expect(text(view.container, '[data-identity-anchor-publish]')).toBe('Finishing the approval…')
    view.rerender(<IdentitySurface {...CLOSED} />)
    view.rerender(<IdentitySurface {...PROPS} />)
    openNostr(view.container)
    await waitFor(() => { expect(text(view.container, '[data-identity-anchor-result]')).toBe('Approval did not finish; nothing was sent.') })
    expect(view.container.textContent).not.toContain('Waiting for Touch ID')
    expect(view.container.textContent).not.toContain('The card closed before Touch ID finished')
    expect(posts(host)).toHaveLength(0)
    const again = await publishButton(view.container)
    await waitFor(() => { expect(again.disabled).toBe(false) })
  })

  it('left open: the wait after the fingerprint is bounded, then it says so and nothing was sent', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout'] })
    stubPasskey()
    const host = stalled()
    const { container } = mount()
    openNostr(container)
    fireEvent.click(await publishButton(container))
    await waitFor(() => { expect(container.textContent).toContain('The node is finishing the approval') })
    vi.advanceTimersByTime(APPROVAL_FINISH_DEADLINE_MS)
    await waitFor(() => {
      expect(text(container, '[data-identity-anchor-result]')).toBe('Touch ID was done, but the node did not finish the approval within 30 seconds. '
        + 'Approval did not finish; nothing was sent.')
    })
    expect(container.querySelector('[data-identity-anchor-run]')?.getAttribute('data-identity-anchor-run')).toBe('settled')
    expect(posts(host)).toHaveLength(0)
  }, 30_000)

  it('approveBounded tells the three ends apart, and an approval that comes back after the end is never used', async () => {
    const terms = (await prepareAnchor(FACTS, 'https://x61.example', 1_794_400_000_000)).terms
    const assertion = { id: 'a', rawId: 'a', type: 'public-key', response: {} } as never
    const challenge = { kind: 'live' as const, route: '/_host/aumlok/challenge', body: { ok: true, challengeId: 'c-1', binding: terms,
      publicKey: { challenge: b64u(new Uint8Array(32).fill(9)), rpId: 'x61.example', userVerification: 'required' } } }
    let approve: (answer: unknown) => void = () => {}
    const call = vi.fn(async (route: string) => (route === '/_host/aumlok/challenge' ? challenge : new Promise((done) => { approve = done }))) as never
    let assert: () => void = () => {}
    const platform = { passkeyBlocker: () => null, nodeKeys: async () => true,
      passkey: () => new Promise((done) => { assert = () => { done(assertion) } }) } as never
    // Closed before the fingerprint.
    const before = new AbortController()
    const first = approveBounded(terms, before.signal, { call, platform }, () => {})
    await new Promise(resolve => setTimeout(resolve, 5))
    before.abort()
    expect(await first).toEqual({ ok: false, reason: 'class3:closed' })
    // Closed after it: the fingerprint is told once, and the reason says the approval did not finish.
    const after = new AbortController()
    const told: string[] = []
    const second = approveBounded(terms, after.signal, { call, platform }, () => { told.push('fingerprint') })
    await new Promise(resolve => setTimeout(resolve, 5))
    assert()
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(told).toEqual(['fingerprint'])
    after.abort()
    expect(await second).toEqual({ ok: false, reason: 'class3:unfinished' })
    // The node's approval arriving now changes nothing (it was dropped, unused).
    approve({ kind: 'live', route: '/_host/aumlok/approve', body: { ok: true, approvalToken: b64u(new Uint8Array(32).fill(4)), expiresAt: Date.now() + 60_000,
      binding: terms } })
    expect(approvalWords('class3:unfinished')).toBe('Approval did not finish; nothing was sent.')
    expect(approvalWords('class3:unfinished-late')).toContain('Approval did not finish; nothing was sent.')
  })
})

describe('a public read that fails is an unreadable attempt (review SHOULD, job 4)', () => {
  it('readPublicHead: a body that cannot be read is "unreadable", never a rejection', async () => {
    const read = await readPublicHead(new AbortController().signal, async () => brokenBody())
    expect(read).toMatchObject({ kind: 'unreadable' })
    expect(read.kind === 'unreadable' ? read.detail : '').toContain('its answer could not be read')
  })

  it('on the card: the first read failing says "not readable", not "reading"; failed automatic reads count, and the reads end', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout'] })
    const { container, publicReads } = await publishAccepted(() => brokenBody())
    await waitFor(() => { expect(nowLine(container)).toContain('could not read this address to check whether it serves it: its answer could not be read') })
    expect(nowLine(container)).not.toBe('reading')
    const first = publicReads()
    for (let read = 1; read <= ANCHOR_VISIBLE_POLLS; read += 1) {
      vi.advanceTimersByTime(ANCHOR_VISIBLE_POLL_MS)
      await waitFor(() => { expect(publicReads()).toBe(first + read) })
    }
    // Seven failed reads are seven attempts: the final sentence, and nothing more is scheduled. It says the address could not be
    // read to check, never that it "has not served it" (an unreadable answer is not an absent event).
    await waitFor(() => { expect(nowLine(container)).toContain('could not read this address to check whether it serves it: its answer could not be read') })
    expect(nowLine(container)).toContain('This card has tried for two minutes; “Check” reads it again.')
    expect(nowLine(container)).not.toContain('has not served it')
    expect(text(container, '[data-identity-anchor-result]')).toBe('Accepted. This card could not read the public address to check whether it shows it, '
      + 'after two minutes of trying; “Check” reads it again.')
    vi.advanceTimersByTime(5 * ANCHOR_VISIBLE_POLL_MS)
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(publicReads()).toBe(first + ANCHOR_VISIBLE_POLLS)
  }, 30_000)
})

describe('the default view says only what this page saw (review MUST and SHOULD, job 5)', () => {
  it('the one sentence promises a signed statement of her head, never a proof of which version of her is live', async () => {
    const host = edge({ '/aukora-messages/contacts.json': json(contacts), [ANCHOR_ROUTE]: json({ ok: true, facts: FACTS }), [PUBLIC_HEAD_ROUTE]: unpublished() })
    vi.stubGlobal('fetch', host.fetch)
    const { container } = mount()
    openNostr(container)
    await publishButton(container)
    const view = defaultView(container)
    expect([...view.querySelectorAll('.ak-lead')].map(lead => lead.textContent)).toEqual(['Publish a signed public statement of her head. Nothing private.'])
    for (const words of ['proof', 'which version', 'is live']) expect(view.textContent?.toLowerCase()).not.toContain(words)
  })

  it('three plain states after an acceptance: could not read the address to check; read, and not there yet; seen there', async () => {
    let mode: 'reject' | 'none' | 'exact' = 'reject'
    const { container, publicReads } = await publishAccepted((signed) => {
      // A rejected read: the connection itself failed, so the page learns nothing about what the address serves.
      if (mode === 'reject') throw new TypeError('Failed to fetch')
      return mode === 'exact' && signed !== null ? json({ ok: true, event: signed }) : unpublished()
    })
    const result = () => defaultView(container).querySelector('[data-identity-anchor-result]')?.textContent ?? ''
    // 1. COULD NOT READ: said in the default view, never "does not show it yet".
    await waitFor(() => { expect(result()).toBe('Accepted. This card could not read the public address to check whether it shows it; '
      + 'it tries again for up to two minutes.') })
    expect(defaultView(container).textContent).not.toContain('does not show it yet')
    expect(nowLine(container)).toContain('could not read this address to check whether it serves it: it did not answer (Failed to fetch)')
    expect(nowLine(container)).not.toContain('does not show it yet')
    // 2. READ, AND NOT THERE YET.
    mode = 'none'
    let reads = publicReads()
    fireEvent.click(container.querySelector('[data-identity-anchor-check]') as HTMLElement)
    await waitFor(() => { expect(publicReads()).toBe(reads + 1) })
    await waitFor(() => { expect(result()).toBe('Accepted. The public address does not show it yet; this card reads it again for up to two minutes.') })
    expect(defaultView(container).textContent).not.toContain('could not read')
    // 3. SEEN THERE: exactly the approved event.
    mode = 'exact'
    reads = publicReads()
    fireEvent.click(container.querySelector('[data-identity-anchor-check]') as HTMLElement)
    await waitFor(() => { expect(result()).toBe('Accepted, and the public address shows it.') })
    expect(publicReads()).toBe(reads + 1)
  })

  it('shown again with the public read not yet answered: it says it is reading, never "does not show it yet"', async () => {
    let hold = false
    const later = deferred()
    // Every held read gets its own fresh answer once the test lets them land.
    const view = await publishAccepted(() => (hold ? later.promise.then(() => unpublished()) : unpublished()))
    await waitFor(() => { expect(text(view.container, '[data-identity-anchor-result]')).toContain('does not show it yet') })
    // Identity closed (the card unmounts) and opened again, with the address's answer still on its way.
    hold = true
    view.rerender(<IdentitySurface {...CLOSED} />)
    view.rerender(<IdentitySurface {...PROPS} />)
    openNostr(view.container)
    await waitFor(() => { expect(text(view.container, '[data-identity-anchor-result]')).toBe('Accepted. Reading the public address to check whether it shows it.') })
    expect(view.container.textContent).not.toContain('does not show it yet')
    // The answer lands: read, and not there yet.
    later.resolve(new Response(null, { status: 204 }))
    await waitFor(() => { expect(text(view.container, '[data-identity-anchor-result]')).toBe('Accepted. The public address does not show it yet; '
      + 'this card reads it again for up to two minutes.') })
  })
})
