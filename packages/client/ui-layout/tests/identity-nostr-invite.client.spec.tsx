// @vitest-environment jsdom
/**
 * Identity surface: the node's Nostr identity (contacts.json + nostr_provision) and the human-vouching quota
 * (aukora.invite.v1 from /_host/aumlok/status), only as the host answers them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { IDENTITY_SURFACE, IdentitySurface } from '../src/client/spatial/apps/identity/IdentitySurface.tsx'
import { inviteOf, nostrOf, resetPublicationForTests } from '../src/client/spatial/apps/identity/nostr.ts'
import { resetApprovalsForTests } from '../src/client/spatial/portal/touch-id-timing.ts'

class FakeChannel { onmessage = null; close() {} }
class FakeSocket { onopen = null; onmessage = null; onclose = null; close() {} }
beforeEach(() => {
  vi.stubGlobal('BroadcastChannel', FakeChannel)
  vi.stubGlobal('WebSocket', FakeSocket)
})
afterEach(() => {
  cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); resetApprovalsForTests(); resetPublicationForTests()
  Reflect.deleteProperty(navigator, 'credentials')
  Reflect.deleteProperty(window, 'isSecureContext')
})

const b64u = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url')
const ab = (bytes: Uint8Array): ArrayBuffer => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
/** The browser's own passkey sheet, for jsdom: it answers exactly the challenge it was given. */
function stubPasskey(): string[] {
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
    get: async ({ publicKey }: { publicKey: PublicKeyCredentialRequestOptions }) => {
      prompts.push('assert')
      const data = new TextEncoder().encode(JSON.stringify({ type: 'webauthn.get', challenge: b64u(Buffer.from(publicKey.challenge as Uint8Array)),
        origin: location.origin, crossOrigin: false }))
      return new Credential(ab(new Uint8Array(16).fill(7)), new Assertion(ab(data), ab(new Uint8Array(37)), ab(new Uint8Array(64)), null))
    },
  } })
  return prompts
}
/** The approval routes as the host answers them: echo the binding, take the assertion, hand back a single-use approval. */
function approvalRoutes(seen: { binding: unknown }): Record<string, (init: RequestInit | undefined) => Response> {
  return {
    '/_host/aumlok/challenge': (init) => {
      seen.binding = (JSON.parse(init?.body as string) as { binding: unknown }).binding
      return json({ ok: true, challengeId: 'approve-0001', binding: seen.binding,
        publicKey: { challenge: b64u(new Uint8Array(32).fill(9)), rpId: location.hostname, userVerification: 'required' } })
    },
    '/_host/aumlok/approve': () => json({ ok: true, approvalToken: b64u(new Uint8Array(32).fill(4)), expiresAt: Date.now() + 60_000,
      approvedAt: Date.now(), binding: seen.binding }),
  }
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const NPUB = `npub1${'q'.repeat(58)}`
const PUB = 'ab'.repeat(32)
const OWNER = { ok: true, publicKeyHex: 'cd'.repeat(32), keyId: `owner-ed25519-${'cd'.repeat(6)}` }
const contacts = (npub: string | null) => ({
  ok: true, conversations: [], contacts: [],
  identity: npub === null ? { npub: null, pubkey: null, signing: 'unavailable' } : { npub, pubkey: PUB, signing: 'bip340-schnorr' },
  relay: { connected: false, urls: [] },
})
const BOUND = { ok: true, phase: 'BOUND', bound: true, passkeyVerified: true, nodePubkeyHex: 'ef'.repeat(32), blockers: [] }

type Route = Response | ((init: RequestInit | undefined) => Response | Promise<Response>)
const edge = (routes: Record<string, Route>) => vi.fn(async (input: string, init?: RequestInit) => {
  const route = routes[input]
  if (route === undefined) return new Response('nope', { status: 404 })
  return typeof route === 'function' ? route(init) : route.clone()
})

/** The `action` a request to /_head/transcript carried. */
const actionOf = (init: RequestInit | undefined): unknown => (JSON.parse(init?.body as string) as { action?: unknown }).action
const PROPS = { activeSurface: IDENTITY_SURFACE, closeSurface: () => {} } as unknown as Parameters<typeof IdentitySurface>[0]
/** The same surface with another app in the centre lane (Identity closed, as the owner closes it). */
const CLOSED = { ...PROPS, activeSurface: 'messages' } as unknown as Parameters<typeof IdentitySurface>[0]
const mount = () => render(<IdentitySurface {...PROPS} />)
const open = (container: HTMLElement, portal: string) => {
  const head = container.querySelector(`[data-identity-portal="${portal}"] .ak-portal__head`)
  if (!(head instanceof HTMLElement)) throw new Error(`no ${portal} portal`)
  fireEvent.click(head)
}

describe('Identity: Nostr identity portal', () => {
  it('shows the live npub, its signing word and the relay state, and puts the npub on the card', async () => {
    vi.stubGlobal('fetch', edge({ '/_host/owner-key': json(OWNER), '/aukora-messages/contacts.json': json(contacts(NPUB)) }))
    const { container } = mount()
    await waitFor(() => { expect(container.querySelector('[data-identity-card-npub]')?.textContent).toBe(`nostr:${NPUB}`) })
    open(container, 'nostr')
    expect(container.querySelector('[data-identity-npub]')?.textContent).toBe(NPUB)
    expect(container.querySelector('[data-identity-nostr="live"]')?.textContent).toContain('bip340-schnorr')
    expect(container.querySelector('[data-identity-relay]')?.textContent).toBe('local NIP-01 · BIP-340 signed; no relay connected yet')
    expect(container.querySelector('[data-identity-provision]')).toBeNull()
  })

  it('with no npub yet, one press asks Touch ID for exactly { action: nostr_provision }, POSTs it once, then reads the npub back', async () => {
    const prompts = stubPasskey()
    const seen = { binding: null as unknown }
    let provisioned = false
    const fetch = edge({
      ...approvalRoutes(seen),
      '/_host/owner-key': json(OWNER),
      '/aukora-messages/contacts.json': () => json(contacts(provisioned ? NPUB : null)),
      '/_head/transcript': (init) => {
        if (actionOf(init) === 'nostr_status') return json({ ok: true, nostr: { npub: null } })
        provisioned = true
        return json({ ok: true, identity: { npub: NPUB, pubkey: PUB, signing: 'bip340-schnorr' } })
      },
    })
    vi.stubGlobal('fetch', fetch)
    const { container } = mount()
    open(container, 'nostr')
    await waitFor(() => { expect(container.querySelector('[data-identity-provision]')).not.toBeNull() })
    expect(container.querySelector('[data-identity-nostr="none"]')?.textContent).toContain('no relay connected yet')
    fireEvent.click(container.querySelector('[data-identity-provision]') as HTMLElement)
    await waitFor(() => { expect(container.querySelector('[data-identity-npub]')?.textContent).toBe(NPUB) })
    const asks = fetch.mock.calls.filter(([route]) => route === '/_head/transcript')
    expect(asks.map(([, init]) => actionOf(init))).toEqual(['nostr_status', 'nostr_provision'])
    const posts = asks.slice(1)
    const init = posts[0]?.[1]
    expect(init?.method).toBe('POST')
    expect(init?.credentials).toBe('same-origin')
    expect((init?.headers as Record<string, string>)['content-type']).toBe('application/json')
    expect(JSON.parse(init?.body as string)).toEqual({ action: 'nostr_provision' })
    // MINTING HER PUBLIC KEY NEEDS THE FINGERPRINT: one passkey, bound to exactly this request, carried in its header.
    expect(prompts).toEqual(['assert'])
    const bodySha256 = createHash('sha256').update('{"action":"nostr_provision"}').digest('hex')
    expect(seen.binding).toEqual({ schema: 'aukora.class3.action.v1', audience: location.origin, method: 'POST', pathname: '/_head/transcript', bodySha256 })
    expect((init?.headers as Record<string, string>)['x-x6-class3-approval']).toBe(b64u(new Uint8Array(32).fill(4)))
    const order = fetch.mock.calls.map(([route]) => route).filter(route => route !== '/_host/owner-key' && route !== '/aukora-messages/contacts.json'
      && route !== '/_host/aumlok/status')
    expect(order.indexOf('/_host/aumlok/approve')).toBeLessThan(order.lastIndexOf('/_head/transcript'))
  })

  it('with no passkey in this browser, provisioning sends nothing and says why', async () => {
    const fetch = edge({
      '/aukora-messages/contacts.json': json(contacts(null)),
      '/_head/transcript': json({ ok: true, nostr: { npub: null } }),
    })
    vi.stubGlobal('fetch', fetch)
    const { container } = mount()
    open(container, 'nostr')
    await waitFor(() => { expect(container.querySelector('[data-identity-provision]')).not.toBeNull() })
    expect(container.querySelector('[data-identity-provision-fingerprint]')?.textContent).toContain('Touch ID approves exactly this request, once')
    fireEvent.click(container.querySelector('[data-identity-provision]') as HTMLElement)
    await waitFor(() => { expect(container.textContent).toContain('Touch ID cannot run in this browser') })
    expect(fetch.mock.calls.filter(([route, init]) => route === '/_head/transcript' && actionOf(init) === 'nostr_provision')).toHaveLength(0)
    expect(fetch.mock.calls.some(([route]) => route === '/_host/aumlok/challenge')).toBe(false)
  })

  it('says the host refusal in words and does not retry', async () => {
    stubPasskey()
    const fetch = edge({
      ...approvalRoutes({ binding: null }),
      '/aukora-messages/contacts.json': json(contacts(null)),
      '/_head/transcript': json({ ok: false, code: 'SAME_ORIGIN_BROWSER_REQUIRED' }, 403),
    })
    vi.stubGlobal('fetch', fetch)
    const { container } = mount()
    open(container, 'nostr')
    await waitFor(() => { expect(container.querySelector('[data-identity-provision]')).not.toBeNull() })
    fireEvent.click(container.querySelector('[data-identity-provision]') as HTMLElement)
    await waitFor(() => { expect(container.textContent).toContain('SAME_ORIGIN_BROWSER_REQUIRED') })
    expect(container.textContent).toContain('same browser origin')
    const presses = fetch.mock.calls.filter(([route, init]) => route === '/_head/transcript' && actionOf(init) === 'nostr_provision')
    expect(presses).toHaveLength(1)
  })

  it('a host with contacts.json but no /_head/transcript (the Mac host) offers no button and says why', async () => {
    vi.stubGlobal('fetch', edge({ '/aukora-messages/contacts.json': json(contacts(null)) }))
    const { container } = mount()
    open(container, 'nostr')
    await waitFor(() => { expect(container.querySelector('[data-identity-provision-closed]')).not.toBeNull() })
    expect(container.querySelector('[data-identity-provision]')).toBeNull()
    expect(container.querySelector('[data-identity-provision-closed]')?.textContent).toBe('This host does not offer to create her Nostr key.')
    // The route is named only in the fold.
    expect(container.querySelector('[data-identity-nostr-details]')?.textContent).toContain('This host does not serve /_head/transcript')
  })

  it('a host without the route says so in one line and offers no button', async () => {
    vi.stubGlobal('fetch', edge({}))
    const { container } = mount()
    open(container, 'nostr')
    await waitFor(() => { expect(container.querySelector('[data-identity-nostr="absent"]')).not.toBeNull() })
    expect(container.querySelector('[data-identity-nostr-line]')?.textContent).toContain('does not serve a Nostr identity')
    expect(container.querySelector('[data-identity-provision]')).toBeNull()
    expect(container.querySelector('[data-identity-npub]')).toBeNull()
  })

  it('reads only the fields the route returns', () => {
    const live = (body: Record<string, unknown>) => ({ kind: 'live' as const, route: '/aukora-messages/contacts.json', body })
    expect(nostrOf(live({ ok: true })).kind).toBe('unreadable')
    expect(nostrOf(live({ ok: true, identity: { npub: 'npub1short' } })).kind).toBe('unreadable')
    expect(nostrOf({ kind: 'refused', route: 'x', status: 401, code: 'MESSAGES_AUTH_REQUIRED', message: 'no' })).toEqual({ kind: 'refused', code: 'MESSAGES_AUTH_REQUIRED' })
  })
})

describe('Identity: human vouching (aukora.invite.v1)', () => {
  it('computes remaining from the status fields and shows revocations', async () => {
    vi.stubGlobal('fetch', edge({ '/_host/aumlok/status': json({ ...BOUND, invite: { quotaMonth: '2026-11', issuedThisMonth: 1, limit: 3, revokedCount: 2 } }) }))
    const { container } = mount()
    open(container, 'invite')
    await waitFor(() => { expect(container.querySelector('[data-identity-invite-count]')?.textContent).toBe('2 of 3 remaining in 2026-11 · aukora.invite.v1') })
    expect(container.querySelector('[data-identity-invite-revoked]')?.textContent).toBe('2 revoked in total (revoking does not restore this month’s quota)')
    // THE LIVE CARD NOW CARRIES EXACTLY ONE CONTROL, "Invite someone" (issuing is wired since the invite desk landed). This
    // status reports no phraseBlockers, so the control stays shut and says why in words; nothing else is offered.
    await waitFor(() => {
      expect(container.querySelector('[data-identity-invite-blocked]')?.textContent)
        .toBe('This host does not say whether your words are locked, so nothing is asked.')
    })
    const controls = [...(container.querySelector('[data-identity-invite="live"]')?.querySelectorAll('button') ?? [])]
    expect(controls.map(control => [control.hasAttribute('data-identity-invite-issue'), control.disabled, control.textContent]))
      .toEqual([[true, true, 'Invite someone']])
  })

  it('floors remaining at zero', () => {
    const read = inviteOf({ kind: 'live', route: '/_host/aumlok/status', body: { ...BOUND, invite: { quotaMonth: '2026-11', issuedThisMonth: 5, limit: 3, revokedCount: 0 } } })
    expect(read).toEqual({ kind: 'live', month: '2026-11', issued: 5, limit: 3, remaining: 0, revoked: 0 })
  })

  it('missing fields, an unbound node or an absent route show no numbers', async () => {
    vi.stubGlobal('fetch', edge({ '/_host/aumlok/status': json({ ...BOUND, invite: { quotaMonth: '2026-11', limit: 3 } }) }))
    const { container } = mount()
    open(container, 'invite')
    await waitFor(() => { expect(container.querySelector('[data-identity-invite="missing"]')).not.toBeNull() })
    expect(container.querySelector('[data-identity-invite-count]')).toBeNull()
    expect(container.querySelector('[data-identity-invite="missing"]')?.textContent).not.toMatch(/\d+ of \d+/)
    const unbound = inviteOf({ kind: 'live', route: '/_host/aumlok/status', body: { ok: true, phase: 'UNBOUND', bound: false,
      invite: { quotaMonth: '2026-11', issuedThisMonth: 0, limit: 3, revokedCount: 0 } } })
    expect(unbound).toEqual({ kind: 'unbound' })
    expect(inviteOf({ kind: 'absent', route: '/_host/aumlok/status', detail: 'the host answers 404' }).kind).toBe('absent')
  })
})

// ── The contact card stays simple: no icon and no word "Owner" above the QR ───────────────────────────────────────

/** A part of the page as the owner sees it before opening any fold. */
const unfolded = (element: Element | null): HTMLElement => {
  if (!(element instanceof HTMLElement)) throw new Error('nothing to show')
  const view = element.cloneNode(true) as HTMLElement
  for (const fold of view.querySelectorAll('details')) fold.remove()
  return view
}

describe('Identity opens on its cards (owner, job 4)', () => {
  it('no icon tile and no "Owner" above the QR; the QR is folded under "Show my contact code", the first card, closed', async () => {
    vi.stubGlobal('fetch', edge({ '/_host/owner-key': json(OWNER), '/aukora-messages/contacts.json': json(contacts(NPUB)) }))
    const { container } = mount()
    await waitFor(() => { expect(container.querySelector('[data-identity-card-npub]')?.textContent).toBe(`nostr:${NPUB}`) })
    const root = container.querySelector('.x6-identity')
    expect(root?.firstElementChild?.matches('ul.ak-grid')).toBe(true)
    expect(root?.querySelector('header')).toBeNull()
    expect(container.querySelector('[data-identity-owner]')).toBeNull()
    expect([...container.querySelectorAll('h2')].map(heading => heading.textContent)).not.toContain('Owner')
    const first = root?.querySelector('ul.ak-grid > li')
    expect(first?.getAttribute('data-identity-portal')).toBe('contact-code')
    const fold = first?.querySelector('details')
    expect(fold?.open).toBe(false)
    expect(fold?.querySelector('summary')?.textContent).toContain('Show my contact code')
    // Folded, the code is still the owner public key and her npub (Verify a contact needs it from the other side).
    expect(fold?.querySelector('[data-identity-qr] img')?.getAttribute('alt')).toBe('QR code of the owner public key and the node npub')
    expect(fold?.textContent).toContain(`aukora:owner-public-key:v1:ed25519:${OWNER.publicKeyHex}`)
    expect([...(fold?.querySelectorAll('button') ?? [])].map(button => button.getAttribute('aria-label'))).toEqual(['Copy contact', 'Copy public key'])
    expect(container.querySelector('[data-identity-portal="scan"]')).not.toBeNull()
  })

  it('at 390, 768 and 1280 the QR fits the grid cell it is folded into, down to the narrowest cell the grid makes (jsdom lays '
    + 'nothing out: the cell is modelled from the rules the browser applies)', async () => {
    vi.stubGlobal('fetch', edge({ '/_host/owner-key': json(OWNER), '/aukora-messages/contacts.json': json(contacts(NPUB)) }))
    const { container } = mount()
    await waitFor(() => { expect(container.querySelector('[data-identity-qr] img')).not.toBeNull() })
    // WHERE THE QR LIVES (review SHOULD: model the cell, not the lane): QR, in its halo, in the code column, in the fold's
    // body, in the fold, in a cell of the Identity grid. Each step is checked, so the arithmetic below is about this nesting.
    const qrNode = container.querySelector('[data-identity-qr]')
    const haloNode = qrNode?.parentElement
    const codeNode = haloNode?.parentElement
    const bodyNode = codeNode?.parentElement
    const foldNode = bodyNode?.parentElement
    const cellNode = foldNode?.parentElement
    expect(codeNode?.classList.contains('x6-identity__code')).toBe(true)
    expect(bodyNode?.classList.contains('ak-portal__body')).toBe(true)
    expect(foldNode?.matches('details.ak-portal.ak-portal--fold')).toBe(true)
    expect(cellNode?.matches('ul.ak-grid > li[data-identity-portal="contact-code"]')).toBe(true)
    expect(cellNode?.parentElement?.getAttribute('data-open')).toBe('no')
    const ROOT = `${resolve(process.cwd())}/packages/client/ui-layout/src/client/spatial/`
    const sheet = (file: string) => readFileSync(`${ROOT}${file}`, 'utf8').replace(/\/\*[\s\S]*?\*\//gu, '')
    /** Every declaration of every rule (media rules included) whose selector list names exactly `selector`. */
    const declared = (css: string, selector: string) => new Map([...css.matchAll(/([^{}]+)\{([^{}]*)\}/gu)]
      .filter(([, selectors]) => (selectors ?? '').split(',').map(part => part.trim()).includes(selector))
      .flatMap(([, , body]) => [...(body ?? '').matchAll(/([\w-]+)\s*:\s*([^;]+);/gu)].map(([, name, value]) => [name ?? '', (value ?? '').trim()] as const)))
    const px = (value: string | undefined, pattern: RegExp): number => Number(pattern.exec(value ?? '')?.[1] ?? Number.NaN)
    const face = sheet('aumlok/AumlokFace.module.css')
    const mine = sheet('apps/identity/identity-surface.css')
    const primitives = sheet('primitives/primitives.css')
    const halo = declared(face, '.identityQrHalo')
    const qr = declared(face, '.identityQr')
    const code = declared(mine, '.x6-identity__code')
    expect(halo.get('box-sizing')).toBe('border-box')
    expect(qr.get('box-sizing')).toBe('border-box')
    const haloCap = px(halo.get('width'), /^min\(100%, (\d+)px\)$/u)
    const qrCap = px(qr.get('width'), /^min\(100%, (\d+)px\)$/u)
    const haloPad = px(halo.get('padding'), /^(\d+)px$/u)
    for (const rules of [halo, qr, code]) expect(rules.has('min-width') ? rules.get('min-width') : '0').toBe('0')
    expect(code.has('width')).toBe(false)
    expect(declared(mine, '.x6-identity__caption code').get('overflow-wrap')).toBe('anywhere')
    // The grid: auto-fill cells of at least min(100%, CELL) with GAP between them; the portal's border; the body's inline inset.
    const grid = declared(primitives, '.ak-grid')
    const cellMin = px(grid.get('grid-template-columns'), /^repeat\(auto-fill, minmax\(min\(100%, (\d+)px\), 1fr\)\)$/u)
    expect(grid.get('gap')).toBe('var(--ak-portal-gap)')
    const gap = px(primitives, /--ak-portal-gap:\s*(\d+)px;/u)
    const border = px(declared(primitives, '.ak-portal').get('border'), /^(\d+)px solid /u)
    const inset = px(declared(primitives, '.ak-portal__body').get('padding'), /^\d+px (\d+)px \d+px$/u)
    for (const value of [haloCap, qrCap, haloPad, cellMin, gap, border, inset]) expect(Number.isFinite(value)).toBe(true)
    /** The width of one cell when the grid's lane is `lane` px wide (auto-fill: as many cells of cellMin as fit, then 1fr). */
    const cellOf = (lane: number): number => {
      const columns = Math.max(1, Math.floor((lane + gap) / (Math.min(lane, cellMin) + gap)))
      return (lane - (columns - 1) * gap) / columns
    }
    for (const width of [390, 768, 1280]) {
      // The lane is at most the viewport less its 16px gutters; side panels can make it narrower, so every lane width from the
      // narrowest cell up to that is tried, and the narrowest cell the grid then makes is the one checked.
      const widest = width - 2 * 16
      let narrowest = Number.POSITIVE_INFINITY
      for (let lane = Math.min(cellMin, widest); lane <= widest; lane += 1) {
        const cell = cellOf(lane)
        narrowest = Math.min(narrowest, cell)
        const content = cell - 2 * border - 2 * inset
        const haloWidth = Math.min(content, haloCap)
        const qrWidth = Math.min(haloWidth - 2 * haloPad, qrCap)
        expect(cell, `${String(width)}/${String(lane)}`).toBeLessThanOrEqual(lane)
        expect(haloWidth, `${String(width)}/${String(lane)}`).toBeLessThanOrEqual(content)
        expect(qrWidth, `${String(width)}/${String(lane)}`).toBeLessThanOrEqual(haloWidth - 2 * haloPad)
        // Large enough to scan from a phone held over the screen at the narrowest cell (222px there with today's rules).
        expect(qrWidth, `${String(width)}/${String(lane)}`).toBeGreaterThanOrEqual(200)
      }
      // Every viewport reaches the narrowest cell the grid allows; a phone's full lane holds one cell, the whole lane wide.
      expect(narrowest, String(width)).toBe(cellMin)
      if (width === 390) expect(cellOf(widest)).toBe(widest)
      else expect(cellOf(widest)).toBeLessThan(widest)
    }
  })
})

describe('Nostr identity, simple by default (owner, job 4)', () => {
  it('no npub yet: one sentence and one button; the technical sentences are under "Details"; "immutable" is gone', async () => {
    vi.stubGlobal('fetch', edge({
      '/aukora-messages/contacts.json': json(contacts(null)),
      '/_head/transcript': json({ ok: true, nostr: { npub: null } }),
    }))
    const { container } = mount()
    open(container, 'nostr')
    await waitFor(() => { expect(container.querySelector('[data-identity-provision]')).not.toBeNull() })
    const card = container.querySelector('[data-identity-nostr="none"]')
    const view = unfolded(card)
    expect([...view.querySelectorAll('.ak-lead')].map(lead => lead.textContent))
      .toEqual(['This node has no Nostr key yet: one key for this node; Touch ID approves it once.'])
    expect([...view.querySelectorAll('button')].map(button => button.textContent)).toEqual(['Create her Nostr key'])
    for (const words of ['/_head', 'transcript', '/aukora-messages', 'contacts.json']) expect(view.textContent).not.toContain(words)
    const details = card?.querySelector('details[data-identity-nostr-details]')
    expect(details instanceof HTMLDetailsElement && !details.open).toBe(true)
    expect(details?.querySelector('summary')?.textContent).toContain('Details')
    expect(details?.textContent).toContain('One press asks /_head/transcript for one BIP-340 key for this node; it is never retried.')
    expect(details?.querySelector('[data-identity-provision-fingerprint]')).not.toBeNull()
    expect(container.textContent?.toLowerCase()).not.toContain('immutable')
    expect(container.querySelector('[data-identity-portal="nostr"] .ak-portal__summary')?.textContent).toBe('your npub for Messages')
  })

  it('closed after Touch ID approved creating her key (review SHOULD): the request is not cancelled, on return the card says where it '
    + 'stands, and then it reads her npub back', async () => {
    const prompts = stubPasskey()
    const seen = { binding: null as unknown }
    let provisioned = false
    let posted: RequestInit | undefined
    let answer: (response: Response) => void = () => {}
    const fetch = edge({
      ...approvalRoutes(seen),
      '/aukora-messages/contacts.json': () => json(contacts(provisioned ? NPUB : null)),
      '/_head/transcript': (init) => {
        if (actionOf(init) === 'nostr_status') return json({ ok: true, nostr: { npub: null } })
        posted = init
        return new Promise<Response>((done) => { answer = done })
      },
    })
    vi.stubGlobal('fetch', fetch)
    const view = mount()
    open(view.container, 'nostr')
    await waitFor(() => { expect(view.container.querySelector('[data-identity-provision]')).not.toBeNull() })
    fireEvent.click(view.container.querySelector('[data-identity-provision]') as HTMLElement)
    await waitFor(() => { expect(posted).not.toBeUndefined() })
    view.rerender(<IdentitySurface {...CLOSED} />)
    // Closing Identity cancelled nothing that was approved.
    expect(posted?.signal?.aborted).toBe(false)
    view.rerender(<IdentitySurface {...PROPS} />)
    open(view.container, 'nostr')
    await waitFor(() => { expect(view.container.textContent).toContain('Touch ID approved creating her key. The request is on its way to the node') })
    expect(view.container.querySelector('[data-identity-provision]')?.textContent).toBe('Creating her key…')
    provisioned = true
    answer(json({ ok: true, identity: { npub: NPUB, pubkey: PUB, signing: 'bip340-schnorr' } }))
    await waitFor(() => { expect(view.container.querySelector('[data-identity-npub]')?.textContent).toBe(NPUB) })
    expect(prompts).toEqual(['assert'])
    expect(fetch.mock.calls.filter(([route, init]) => route === '/_head/transcript' && actionOf(init) === 'nostr_provision')).toHaveLength(1)
  })
})

describe('Nostr identity: an unclear answer, then her npub read back (review SHOULD)', () => {
  it('the node made the key but gave no clear answer: once the npub is read back, the "not known" line is gone, and stays gone '
    + 'when Identity is closed and opened again', async () => {
    const prompts = stubPasskey()
    const seen = { binding: null as unknown }
    let provisioned = false
    const fetch = edge({
      ...approvalRoutes(seen),
      '/aukora-messages/contacts.json': () => json(contacts(provisioned ? NPUB : null)),
      '/_head/transcript': (init) => {
        if (actionOf(init) === 'nostr_status') return json({ ok: true, nostr: { npub: null } })
        // It makes the key, then answers with no code and no npub: the page cannot know what happened.
        provisioned = true
        return new Response('bad gateway', { status: 502 })
      },
    })
    vi.stubGlobal('fetch', fetch)
    const view = mount()
    open(view.container, 'nostr')
    await waitFor(() => { expect(view.container.querySelector('[data-identity-provision]')).not.toBeNull() })
    fireEvent.click(view.container.querySelector('[data-identity-provision]') as HTMLElement)
    await waitFor(() => { expect(view.container.querySelector('[data-identity-npub]')?.textContent).toBe(NPUB) })
    expect(fetch.mock.calls.filter(([route, init]) => route === '/_head/transcript' && actionOf(init) === 'nostr_provision')).toHaveLength(1)
    expect(prompts).toEqual(['assert'])
    await waitFor(() => { expect(view.container.textContent).not.toContain('No clear answer') })
    expect(view.container.textContent).not.toContain('Whether a key was made is not known')
    view.rerender(<IdentitySurface {...CLOSED} />)
    view.rerender(<IdentitySurface {...PROPS} />)
    open(view.container, 'nostr')
    await waitFor(() => { expect(view.container.querySelector('[data-identity-npub]')?.textContent).toBe(NPUB) })
    expect(view.container.textContent).not.toContain('No clear answer')
  })
})
