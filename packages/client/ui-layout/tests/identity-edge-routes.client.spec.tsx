// @vitest-environment jsdom
/**
 * Identity on the edge: the passkey and AUMLOK cards read the route the edge serves
 * (`GET /_host/aumlok/status`), never the unrouted `/_host/passkey` or bare `/_host/aumlok`; an invite link opens at the
 * address the invite was made for; the guest door's lock is said truly (it counts every check, not failed ones).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { IDENTITY_SURFACE, IdentitySurface } from '../src/client/spatial/apps/identity/IdentitySurface.tsx'
import { INVITE_LINK_PREFIX, inviteShareLink, redeemRefusalWords, type InviteReceipt } from '../src/client/spatial/apps/identity/invite.ts'

class FakeChannel { onmessage = null; close() {} }
class FakeSocket { onopen = null; onmessage = null; onclose = null; close() {} }
beforeEach(() => {
  vi.stubGlobal('BroadcastChannel', FakeChannel)
  vi.stubGlobal('WebSocket', FakeSocket)
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const OWNER = { ok: true, publicKeyHex: 'cd'.repeat(32), keyId: `owner-ed25519-${'cd'.repeat(6)}` }
const BOUND_AT = Date.UTC(2026, 10, 3, 9, 0, 0)
const USED_AT = Date.UTC(2026, 10, 12, 6, 30, 0)
const BOUND = { ok: true, phase: 'BOUND', bound: true, passkeyVerified: true, nodePubkeyHex: 'ef'.repeat(32), boundAt: BOUND_AT,
  lastVerifiedAt: USED_AT, blockers: [] }
const UNBOUND = { ok: true, phase: 'UNBOUND', bound: false, passkeyVerified: false, nodePubkeyHex: null, boundAt: null, lastVerifiedAt: null, blockers: [] }

/** The edge as it routes today: `/_host/passkey` and bare `/_host/aumlok` answer 501 like any unrouted path. */
const edge = (status: Record<string, unknown>) => vi.fn(async (input: string) => {
  if (input === '/_host/owner-key') return json(OWNER)
  if (input === '/_host/aumlok/status') return json(status)
  return new Response('Not Implemented', { status: 501 })
})
const PROPS = { activeSurface: IDENTITY_SURFACE, closeSurface: () => {} } as unknown as Parameters<typeof IdentitySurface>[0]
const open = (container: HTMLElement, portal: string) => {
  const head = container.querySelector(`[data-identity-portal="${portal}"] .ak-portal__head`)
  if (!(head instanceof HTMLElement)) throw new Error(`no ${portal} portal`)
  fireEvent.click(head)
}
const routesAsked = (fetch: ReturnType<typeof edge>) => fetch.mock.calls.map(([route]) => route.split('?')[0])

describe('Identity: the passkey and AUMLOK cards read the edge\'s own status route', () => {
  it('a bound node: the passkey card says what the passkey does, LIVE, and neither card asks an unrouted path', async () => {
    const fetch = edge(BOUND)
    vi.stubGlobal('fetch', fetch)
    const { container } = render(<IdentitySurface {...PROPS} />)
    open(container, 'passkey')
    open(container, 'aumlok')
    const passkey = () => container.querySelector('[data-identity-portal="passkey"]')
    const aumlok = () => container.querySelector('[data-identity-portal="aumlok"]')
    await waitFor(() => { expect(passkey()?.textContent).toContain('signs you in to this node') })
    await waitFor(() => { expect(aumlok()?.textContent).toContain('LIVE') })
    expect(passkey()?.textContent).toContain('LIVE')
    expect(passkey()?.textContent).not.toContain('NOT CONNECTED YET')
    expect(passkey()?.textContent).toContain('2026-11-03')
    expect(passkey()?.textContent).toContain('2026-11-12')
    expect(passkey()?.textContent).toContain('Your devices')
    expect(aumlok()?.textContent).toContain('/_host/aumlok/status · bound')
    expect(aumlok()?.textContent).not.toContain('NOT CONNECTED YET')
    // No ceremony of its own: the card offers no create or verify press that has no route behind it.
    expect(container.querySelector('[data-identity-passkey]')).toBeNull()
    const asked = routesAsked(fetch)
    expect(asked).toContain('/_host/aumlok/status')
    expect(asked).not.toContain('/_host/passkey')
    expect(asked).not.toContain('/_host/aumlok')
  })

  it('an unbound node says so plainly; a node that does not answer still says NOT CONNECTED YET naming the route', async () => {
    vi.stubGlobal('fetch', edge(UNBOUND))
    const first = render(<IdentitySurface {...PROPS} />)
    open(first.container, 'passkey')
    await waitFor(() => {
      expect(first.container.querySelector('[data-identity-portal="passkey"]')?.textContent).toContain('No passkey is bound to this node yet')
    })
    cleanup()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('Not Implemented', { status: 501 })))
    const second = render(<IdentitySurface {...PROPS} />)
    open(second.container, 'passkey')
    await waitFor(() => {
      expect(second.container.querySelector('[data-identity-portal="passkey"]')?.textContent).toContain('NOT CONNECTED YET: /_host/aumlok/status')
    })
  })
})

describe('Identity: the invite link and the guest door\'s words', () => {
  const receipt = (assignedDomainPointer: string | null) => ({
    schema: 'aukora.invite.v1', inviteId: 'i'.repeat(43), sponsorPubkeyHex: 'ab'.repeat(32), inviteeCommitmentSha256: 'cd'.repeat(32),
    assignedDomainPointer, quotaMonth: '2026-11', monthlySequence: 1, revoked: false, issuedAt: BOUND_AT, expiresAt: BOUND_AT + 86_400_000,
    signature: 's'.repeat(86),
  }) as unknown as InviteReceipt

  it('the link starts with the invite\'s assigned address when it has one, else this page\'s origin', () => {
    const pointed = inviteShareLink(receipt('https://friend.example.invalid'), 'https://node.example.invalid')
    expect(pointed.startsWith(`https://friend.example.invalid/${INVITE_LINK_PREFIX}`)).toBe(true)
    const plain = inviteShareLink(receipt(null), 'https://node.example.invalid')
    expect(plain.startsWith(`https://node.example.invalid/${INVITE_LINK_PREFIX}`)).toBe(true)
    expect(inviteShareLink(receipt(null)).startsWith(`${globalThis.location.origin}/${INVITE_LINK_PREFIX}`)).toBe(true)
    // The fragment is the same receipt either way.
    // With a pointer, this page's own origin plays no part; the fragment carries the receipt either way.
    expect(inviteShareLink(receipt('https://friend.example.invalid'), 'https://elsewhere.example')).toBe(pointed)
    expect(new URL(pointed).hash.startsWith('#invite=')).toBe(true)
  })

  it('a locked guest door says the node counts every check from the network, never that checks failed', () => {
    const words = redeemRefusalWords('GUEST_DOOR_LOCKED')
    expect(words).toBe('Too many checks came from this network, so this node is not checking invites from it for now. Nothing was checked or granted.')
    expect(words).not.toMatch(/failed/i)
  })
})
