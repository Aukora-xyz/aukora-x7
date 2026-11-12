// @vitest-environment jsdom
/**
 * Wave 5, Identity: the host's own invite list (when a host serves it), the host's lifetime count, an invite link, and
 * what a vouched guest can check on the Redeem card without any host. Receipts here are really signed (WebCrypto
 * Ed25519), so "verifies" and "does not verify" are the real check, not a stub.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { IDENTITY_SURFACE, IdentitySurface } from '../src/client/spatial/apps/identity/IdentitySurface.tsx'
import {
  checkGuestInvite, forgetInviteBookForTests, INVITE_LIFETIME_CAP, INVITE_LINK_PREFIX, inviteFromText, inviteLinkOf, invitePreimage,
  inviteReadiness, inviteStatusOf, INVITES_ROUTE, newInviteeCode, readInviteBook, revocationPreimage, signWithNode, syncHostInvites,
  type InvitePayload, type InviteReceipt, type SignedRevocation,
} from '../src/client/spatial/apps/identity/invite.ts'
import type { HostAnswer } from '../src/client/spatial/apps/identity/host.ts'

class FakeChannel { onmessage = null; close() {} }
class FakeSocket { onopen = null; onmessage = null; onclose = null; close() {} }
beforeEach(() => {
  vi.stubGlobal('BroadcastChannel', FakeChannel)
  vi.stubGlobal('WebSocket', FakeSocket)
  globalThis.localStorage.clear()
  forgetInviteBookForTests()
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); forgetInviteBookForTests(); globalThis.location.hash = '' })

const hex = (bytes: Uint8Array) => [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('')
const NOW = Date.UTC(2026, 10, 11, 4)
/** A node key and an invite it really signed. */
async function signedInvite(over: Partial<InvitePayload> = {}, at = NOW) {
  const pair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])
  const node = hex(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)))
  const invitee = await newInviteeCode()
  const payload: InvitePayload = { schema: 'aukora.invite.v1', inviteId: `invite-${'a'.repeat(20)}`, sponsorPubkeyHex: node,
    inviteeCommitmentSha256: invitee.commitmentSha256, assignedDomainPointer: null, quotaMonth: '2026-11', monthlySequence: 1, revoked: false,
    issuedAt: at, expiresAt: at + 604_800_000, ...over }
  const receipt: InviteReceipt = { ...payload, signature: await signWithNode(pair.privateKey, invitePreimage(payload)) }
  const revoke = async (): Promise<SignedRevocation> => {
    const body = { schema: 'aukora.invite-revocation.v1', inviteId: payload.inviteId, sponsorPubkeyHex: node, revokedAt: at + 1000 } as const
    return { ...body, signature: await signWithNode(pair.privateKey, revocationPreimage(body)) }
  }
  return { node, receipt, code: invitee.code, revoke }
}
const live = (body: Record<string, unknown>): HostAnswer => ({ kind: 'live', route: INVITES_ROUTE, body })
const signal = () => new AbortController().signal

describe('Identity: the host\'s own invite list', () => {
  it('keeps every listed record that verifies against the node key, drops and counts the rest, and asks with one GET', async () => {
    const mine = await signedInvite()
    const other = await signedInvite({ inviteId: `invite-${'b'.repeat(20)}` })
    const forged = { ...mine.receipt, inviteId: `invite-${'c'.repeat(20)}` }
    const call = vi.fn(async (_route: string, _signal: AbortSignal, _body?: Record<string, unknown>) => live({ ok: true, invites: [mine.receipt, other.receipt, forged, 'junk'], revocations: [await mine.revoke(), { nope: 1 }] }))
    expect(await syncHostInvites(mine.node, signal(), call)).toEqual({ kind: 'live', receipts: 1, revocations: 1, dropped: 4 })
    expect(call.mock.calls.map(([route, , body]) => [route, body])).toEqual([[INVITES_ROUTE, undefined]])
    const book = readInviteBook()
    expect(book.receipts.map(receipt => receipt.inviteId)).toEqual([mine.receipt.inviteId])
    expect(book.revocations.map(revocation => revocation.inviteId)).toEqual([mine.receipt.inviteId])
  })

  it('a host without the list, or one that refuses, changes nothing in this browser\'s book', async () => {
    const mine = await signedInvite()
    expect(await syncHostInvites(mine.node, signal(), async () => ({ kind: 'absent', route: INVITES_ROUTE, detail: 'the host answers 404' })))
      .toEqual({ kind: 'absent' })
    expect(await syncHostInvites(mine.node, signal(), async () => ({ kind: 'refused', route: INVITES_ROUTE, status: 401,
      code: 'OWNER_ACCESS_REQUIRED', message: 'no' }))).toEqual({ kind: 'refused', code: 'OWNER_ACCESS_REQUIRED' })
    expect(readInviteBook()).toEqual({ receipts: [], revocations: [] })
  })

  it('the host\'s lifetime count is read when it reports one, and at the cap nothing is asked', async () => {
    const status = (invite: Record<string, unknown>, more: Record<string, unknown> = {}) => inviteStatusOf({ kind: 'live', route: '/_host/aumlok/status',
      body: { ok: true, phase: 'BOUND', bound: true, passkeyVerified: true, nodePubkeyHex: 'ef'.repeat(32), blockers: [], phraseBlockers: [],
        invite: { quotaMonth: '2026-11', issuedThisMonth: 0, limit: 3, revokedCount: 0, ...invite }, ...more } })
    const none = status({})
    const inside = status({ lifetimeIssuedCount: 31 })
    const top = status({}, { lifetimeIssuedCount: INVITE_LIFETIME_CAP })
    if (none.kind !== 'live' || inside.kind !== 'live' || top.kind !== 'live') throw new Error('status not read')
    expect([none.value.lifetimeIssued, inside.value.lifetimeIssued, top.value.lifetimeIssued]).toEqual([null, 31, INVITE_LIFETIME_CAP])
    const platform = { passkeyBlocker: () => null, nodeKeys: async () => true } as unknown as Parameters<typeof inviteReadiness>[2]
    const words = await inviteReadiness({ ...top.value, status: { ...top.value.status, checksPhraseOnline: true } }, 'issue', platform)
    expect(words).toContain(`its limit of ${String(INVITE_LIFETIME_CAP)} for all time`)
  })
})

describe('Identity: an invite link and what a guest can check', () => {
  it('a link carries the public receipt in its fragment and never the invite code; it reads back exactly', async () => {
    const { receipt, code } = await signedInvite()
    const link = inviteLinkOf(receipt, 'https://node.example.invalid')
    expect(link.startsWith(`https://node.example.invalid/${INVITE_LINK_PREFIX}`)).toBe(true)
    expect(link).not.toContain(code)
    expect(inviteFromText(link)).toEqual(receipt)
    expect(inviteFromText(new URL(link).hash)).toEqual(receipt)
    expect(inviteFromText(JSON.stringify(receipt))).toEqual(receipt)
    for (const junk of ['', 'hello', '#invite=@@@', '#invite=aGVsbG8', '{"schema":"aukora.invite.v1"}']) expect(inviteFromText(junk)).toBeNull()
  })

  it('checks the signature against the sponsor key, the expiry, and the code against the commitment', async () => {
    const { receipt, code } = await signedInvite()
    const stranger = await signedInvite()
    expect(await checkGuestInvite(receipt, '', NOW + 1)).toEqual({ signed: true, expired: false, codeMatches: null })
    expect(await checkGuestInvite(receipt, code, NOW + 1)).toEqual({ signed: true, expired: false, codeMatches: true })
    expect(await checkGuestInvite(receipt, stranger.code, NOW + 1)).toMatchObject({ codeMatches: false })
    expect(await checkGuestInvite(receipt, 'not-a-code', NOW + 1)).toMatchObject({ codeMatches: false })
    expect(await checkGuestInvite(receipt, code, receipt.expiresAt)).toMatchObject({ signed: true, expired: true })
    // A receipt edited after signing (another address) no longer verifies.
    expect(await checkGuestInvite({ ...receipt, assignedDomainPointer: 'https://evil.example' }, code, NOW + 1)).toMatchObject({ signed: false })
  })

  it('opening an invite link shows the Redeem card open with the checks, sends nothing to any host for it, and says what it cannot know', async () => {
    const { receipt, code, node } = await signedInvite({}, Date.now())
    globalThis.location.hash = new URL(inviteLinkOf(receipt, 'https://node.example.invalid')).hash
    const fetch = vi.fn(async () => new Response('nope', { status: 404 }))
    vi.stubGlobal('fetch', fetch)
    const props = { activeSurface: IDENTITY_SURFACE, closeSurface: () => {} } as unknown as Parameters<typeof IdentitySurface>[0]
    const { container, rerender } = render(<IdentitySurface {...props} />)
    const card = () => container.querySelector('[data-identity-portal="redeem"]')
    await waitFor(() => { expect(card()?.querySelector('[data-identity-redeem="signed"]')).not.toBeNull() })
    expect(card()?.textContent).toContain('SIGNATURE VERIFIES')
    expect(card()?.querySelector('[data-identity-redeem-sponsor]')?.textContent).toBe(node)
    expect(card()?.textContent).toContain('only a host can say')
    // Typing the code never unmounts its field (it is the same element after each keystroke, so it keeps its focus).
    const field = card()?.querySelector('[data-identity-redeem-code]') as HTMLInputElement
    fireEvent.change(field, { target: { value: code.slice(0, 5) } })
    expect(card()?.querySelector('[data-identity-redeem-code]')).toBe(field)
    fireEvent.change(field, { target: { value: code } })
    expect(card()?.querySelector('[data-identity-redeem-code]')).toBe(field)
    await waitFor(() => { expect(card()?.querySelector('[data-identity-redeem-code-check]')?.getAttribute('data-identity-redeem-code-check')).toBe('true') })
    fireEvent.change(card()?.querySelector('[data-identity-redeem-code]') as Element, { target: { value: 'wrong' } })
    await waitFor(() => { expect(card()?.querySelector('[data-identity-redeem-code-check]')?.getAttribute('data-identity-redeem-code-check')).toBe('false') })
    // Nothing about the invite or its code went to any host: no request names a redeem route or carries either.
    const sent = JSON.stringify(fetch.mock.calls)
    expect(sent).not.toMatch(/redeem/u)
    expect(sent).not.toContain(code)
    expect(sent).not.toContain(receipt.inviteId)
    // The code goes with the screen: once Identity closes, the page holds it nowhere.
    fireEvent.change(card()?.querySelector('[data-identity-redeem-code]') as Element, { target: { value: code } })
    rerender(<IdentitySurface {...props} activeSurface="aumlok" />)
    rerender(<IdentitySurface {...props} />)
    await waitFor(() => { expect(card()?.querySelector<HTMLInputElement>('[data-identity-redeem-code]')?.value).toBe('') })
    // Something that is not an invite says so.
    fireEvent.change(card()?.querySelector('[data-identity-redeem-receipt]') as Element, { target: { value: 'hello' } })
    await waitFor(() => { expect(card()?.querySelector('[data-identity-redeem="unreadable"]')).not.toBeNull() })
  })
})
