// @vitest-environment jsdom
/**
 * The owner mandate as the page builds, shows and reads it (aumlok/mandate.ts, portal/MandateCell.tsx). HEAD's
 * rules and every refusal are in deploy/cloudflare/src/__tests__/owner-mandate.test.mjs; this file holds the page's side:
 * the terms are terms HEAD accepts, the words are HEAD's words, issuing asks the passkey (the AUMLOK approve route) and
 * Stop asks none, and an unread mandate is never "fine".
 */
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { canonicalJson } from '../src/client/spatial/aumlok/class3-approval.ts'
import { MANDATE_DEFAULT_PER_DAY, MANDATE_SCOPES, mandateTerms, mandateWords, parseMandateStatus, readMandate } from '../src/client/spatial/aumlok/mandate.ts'
import { MandateCell, mandateSummary } from '../src/client/spatial/portal/MandateCell.tsx'

const policyPath = ['', '../../../'].map(prefix => resolve(process.cwd(), `${prefix}deploy/cloudflare/src/owner-mandate.mjs`)).find(existsSync)
const policy = await import(pathToFileURL(policyPath ?? 'deploy/cloudflare/src/owner-mandate.mjs').href) as {
  normalizeOwnerMandateTerms: (input: unknown, context: { now: number }) => unknown
  ownerMandatePlainWords: (terms: unknown) => readonly string[]
  OWNER_MANDATE_SCOPES: readonly string[]
  OWNER_MANDATE_DEFAULT_PER_DAY: Record<string, number>
}
// The passkey itself cannot run in jsdom: the approval step is watched instead, and answers "not completed".
const approvals = vi.hoisted(() => [] as unknown[])
vi.mock('../src/client/spatial/aumlok/class3-approval.ts', async original => ({
  ...(await original<typeof import('../src/client/spatial/aumlok/class3-approval.ts')>()),
  approveClass3: vi.fn(async (action: unknown) => { approvals.push(action); return { ok: false, reason: 'class3:fixture' } }),
}))
const sha256Hex = async (text: string): Promise<string> =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map(byte => byte.toString(16).padStart(2, '0')).join('')
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const DAY = 24 * 60 * 60 * 1000
const FIXED_NOW = Date.UTC(2026, 10, 14, 12)

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); approvals.length = 0 })

describe('mandate page side', () => {
  const now = 1_800_000_000_000

  it('builds terms HEAD accepts for 1, 7 and 30 days, with the closed scope set and the default bounds', () => {
    for (const days of [1, 7, 30] as const) {
      const terms = mandateTerms({ now, days })
      expect(() => policy.normalizeOwnerMandateTerms(terms, { now })).not.toThrow()
      expect(terms.expiresAt - terms.issuedAt).toBe(days * DAY)
      expect(terms.id).toMatch(/^mandate-[0-9a-f]{24}$/)
    }
    expect([...MANDATE_SCOPES]).toEqual([...policy.OWNER_MANDATE_SCOPES])
    expect({ ...MANDATE_DEFAULT_PER_DAY }).toEqual({ ...policy.OWNER_MANDATE_DEFAULT_PER_DAY })
  })

  it('shows the owner exactly the words HEAD states, with the plain terms the brief names', () => {
    const terms = mandateTerms({ now, days: 7 })
    const words = mandateWords(terms)
    expect(words).toEqual([...policy.ownerMandatePlainWords(terms)])
    expect(words[0]).toBe('Let Auma work while I am away.')
    expect(words.join(' ')).toContain('Each day at most: 24 commits on her own branches, 8 new branches, 24 runner jobs (240 minutes), 12 proposal cards, 24 comments')
    expect(words).toContain('Never without my fingerprint: merge, deploy, keys, deletes.')
    expect(words.join(' ')).not.toMatch(/token/i)
  })

  it('never reports an unread or malformed mandate as none or active', async () => {
    expect(mandateSummary({ kind: 'unknown' }).badge).toBe('UNKNOWN')
    expect(parseMandateStatus({ ok: true, mandate: { state: 'active', terms: { schema: 'other' }, plainWords: [] } })).toBeNull()
    const failing = (() => Promise.resolve(json({ ok: false }, 503))) as unknown as typeof fetch
    expect(await readMandate(new AbortController().signal, failing)).toBeNull()
    const none = (() => Promise.resolve(json({ ok: true, mandate: null }))) as unknown as typeof fetch
    expect(await readMandate(new AbortController().signal, none)).toBe('none')
  })
})

describe('mandate section', () => {
  it('renders the terms and a length choice; Approve asks the passkey (the AUMLOK approve route) before anything is sent', async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init })
      if (url === '/_head/mandate' && (init?.method ?? 'GET') === 'GET') return json({ ok: true, mandate: null })
      return json({ ok: false, code: 'FIXTURE_STOP' }, 503)
    }))
    vi.spyOn(Date, 'now').mockReturnValue(FIXED_NOW)
    vi.spyOn(crypto, 'getRandomValues').mockImplementation(<T extends ArrayBufferView | null>(bytes: T): T => { if (bytes instanceof Uint8Array) bytes.fill(7); return bytes })
    const view = render(<MandateCell active round={0} />)
    await waitFor(() => { expect(view.container.textContent).toContain('No mandate') })
    const text = view.container.textContent
    expect(text).toContain('Let Auma work while I am away.')
    expect(text).toContain('Never without my fingerprint: merge, deploy, keys, deletes.')
    expect(text).toContain('Nothing she does uses it yet')
    expect(text).toMatch(/1 day.*7 days.*30 days/)
    const pressed = [...view.container.querySelectorAll('[data-sovereignty-mandate-length] button')].map(button => button.getAttribute('aria-pressed'))
    expect(pressed).toEqual(['false', 'true', 'false'])
    const shown = view.container.querySelector('[data-sovereignty-mandate-proposal]')?.textContent ?? ''
    fireEvent.click(view.container.querySelector('[data-sovereignty-mandate-approve]') as Element)
    await waitFor(() => { expect(view.container.querySelector('[data-sovereignty-mandate-said]')).not.toBeNull() })
    // The passkey was asked for exactly one binding: POST /_head/mandate on this origin, over the terms that were shown.
    expect(approvals).toHaveLength(1)
    const action = approvals[0] as { audience: string; method: string; pathname: string; bodySha256: string }
    expect([action.audience, action.method, action.pathname]).toEqual([window.location.origin, 'POST', '/_head/mandate'])
    const idShown = /Mandate (mandate-[0-9a-f]{24})\./.exec(shown)?.[1]
    expect(idShown).toBeDefined()
    // Not approved, so nothing at all was sent to the mandate route.
    expect(calls.filter(call => (call.init?.method ?? 'GET') !== 'GET')).toEqual([])
    // The binding hashes exactly the terms that were shown (clock and randomness fixed, so the page's terms are known).
    const expected = mandateTerms({ now: FIXED_NOW, days: 7 })
    expect(idShown).toBe(expected.id)
    expect(action.bodySha256).toBe(await sha256Hex(canonicalJson({ action: 'issue', terms: expected })))
    expect(view.container.textContent).toMatch(/Not given/)
  })

  it('a tap 11 minutes after the section opened sends terms made at the tap, shown and bound, that HEAD\'s own check accepts', async () => {
    const { approveClass3 } = await import('../src/client/spatial/aumlok/class3-approval.ts')
    const opened = FIXED_NOW
    const tapped = FIXED_NOW + 11 * 60 * 1000
    let clock = opened
    vi.spyOn(Date, 'now').mockImplementation(() => clock)
    vi.mocked(approveClass3).mockImplementationOnce(async (action: unknown) => {
      approvals.push(action)
      return { ok: true, token: 'fixture-approval', expiresAt: tapped + 60_000, action, hostRemainingMs: 60_000, receivedAt: 0 } as never
    })
    const sent: { body: { action: string; terms: Record<string, unknown> }; header: string | null }[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/_head/mandate' && (init?.method ?? 'GET') === 'GET') return json({ ok: true, mandate: null })
      const body = JSON.parse(init?.body as string) as { action: string; terms: Record<string, unknown> }
      sent.push({ body, header: new Headers(init?.headers).get('x-x6-class3-approval') })
      // Answer exactly as HEAD would: its own check, on its own clock (the tap time).
      const terms = policy.normalizeOwnerMandateTerms(body.terms, { now: tapped })
      return json({ ok: true, mandate: { state: 'active', terms, plainWords: policy.ownerMandatePlainWords(terms) } })
    }))
    const view = render(<MandateCell active round={0} />)
    await waitFor(() => { expect(view.container.textContent).toContain('No mandate') })
    clock = tapped
    fireEvent.click(view.container.querySelector('[data-sovereignty-mandate-approve]') as Element)
    await waitFor(() => { expect(view.container.querySelector('[data-sovereignty-mandate-said]')?.textContent).toBe('Given.') })
    expect(sent).toHaveLength(1)
    const terms = sent[0]?.body.terms as { issuedAt: number; expiresAt: number; id: string }
    expect(terms.issuedAt).toBe(tapped)
    expect(terms.expiresAt).toBe(tapped + 7 * DAY)
    expect(sent[0]?.header).toBe('fixture-approval')
    expect(() => policy.normalizeOwnerMandateTerms(terms, { now: tapped })).not.toThrow()
    // The passkey was asked for exactly the bytes sent.
    const action = approvals[0] as { bodySha256: string }
    expect(action.bodySha256).toBe(await sha256Hex(canonicalJson(sent[0]?.body)))
  })

  it('when HEAD refuses the issue time, the card says in one plain line that this computer\'s clock is off', async () => {
    const { approveClass3 } = await import('../src/client/spatial/aumlok/class3-approval.ts')
    vi.mocked(approveClass3).mockImplementationOnce(async (action: unknown) => {
      approvals.push(action)
      return { ok: true, token: 'fixture-approval', expiresAt: Date.now() + 60_000, action, hostRemainingMs: 60_000, receivedAt: 0 } as never
    })
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/_head/mandate' && (init?.method ?? 'GET') === 'GET') return json({ ok: true, mandate: null })
      return json({ ok: false, code: 'MANDATE_ISSUED_AT_REFUSED' }, 409)
    }))
    const view = render(<MandateCell active round={0} />)
    await waitFor(() => { expect(view.container.textContent).toContain('No mandate') })
    fireEvent.click(view.container.querySelector('[data-sovereignty-mandate-approve]') as Element)
    await waitFor(() => { expect(view.container.querySelector('[data-sovereignty-mandate-said]')).not.toBeNull() })
    const said = view.container.querySelector('[data-sovereignty-mandate-said]')?.textContent ?? ''
    expect(said).toBe('Not given: the clock of this computer is more than 10 minutes off. Set it right, then approve again.')
    // In the section itself, in the page's flow: never a floating element.
    expect(view.container.querySelector('[data-sovereignty-mandate-section] [data-sovereignty-mandate-said]')).not.toBeNull()
  })

  it('an active mandate shows its end date and today\'s counts; Stop sends revoke with no passkey', async () => {
    const terms = mandateTerms({ now: Date.UTC(2026, 10, 14), days: 7 })
    const calls: { url: string; init: RequestInit | undefined }[] = []
    let stopped = false
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init })
      if ((init?.method ?? 'GET') === 'POST') { stopped = true; return json({ ok: true, mandate: { state: 'revoked', terms, plainWords: mandateWords(terms) } }) }
      return json({ ok: true, mandate: { state: stopped ? 'revoked' : 'active', terms, plainWords: mandateWords(terms) },
        today: { ...MANDATE_DEFAULT_PER_DAY, commits: 3, branchCreates: 1, execRuns: 0, execMinutes: 0, proposalStages: 0,
          linearComments: 2, relayPosts: 0 } })
    }))
    const view = render(<MandateCell active round={0} />)
    await waitFor(() => { expect(view.container.textContent).toContain('ACTIVE') })
    expect(view.container.textContent).toContain('2026-11-21 00:00 UTC')
    expect(view.container.textContent).toContain('3 of 24')
    expect(view.container.querySelector('[data-sovereignty-mandate-approve]')).toBeNull()
    fireEvent.click(view.container.querySelector('[data-sovereignty-mandate-stop]') as Element)
    await waitFor(() => { expect(view.container.textContent).toContain('Stopped.') })
    const writes = calls.filter(call => (call.init?.method ?? 'GET') !== 'GET')
    expect(writes).toHaveLength(1)
    expect(writes[0]?.url).toBe('/_head/mandate')
    expect(JSON.parse(writes[0]?.init?.body as string)).toEqual({ action: 'revoke', id: terms.id })
    expect(new Headers(writes[0]?.init?.headers).has('x-x6-class3-approval')).toBe(false)
    expect(calls.some(call => call.url.includes('/_host/aumlok/'))).toBe(false)
    expect(approvals).toEqual([])
  })
})
