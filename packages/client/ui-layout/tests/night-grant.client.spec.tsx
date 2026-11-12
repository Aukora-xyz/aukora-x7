/**
 * The night grant as the page builds, shows and reads it (aumlok/night-grant.ts, portal/NightGrantCell.tsx). HEAD's own
 * rules and every refusal are in deploy/cloudflare/src/__tests__/night-grant.test.mjs; this file holds the page's side:
 * the words the owner reads are HEAD's words, the default terms are terms HEAD accepts, and an unread grant is never "fine".
 */
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  NIGHT_GRANT_MAX_LIFETIME_MS, nightGrantTerms, nightGrantWords, newNightGrantId, parseNightGrantStatus, readNightGrant,
} from '../src/client/spatial/aumlok/night-grant.ts'
import { nightGrantSummary } from '../src/client/spatial/portal/NightGrantCell.tsx'

const ORIGIN = 'https://x61.example.invalid'
const HEAD = { ballId: 'ab'.repeat(32), epoch: 169 }
const policyPath = ['', '../../../'].map(prefix => resolve(process.cwd(), `${prefix}deploy/cloudflare/src/night-grant.mjs`)).find(existsSync)
const policy = await import(pathToFileURL(policyPath ?? 'deploy/cloudflare/src/night-grant.mjs').href) as {
  normalizeNightGrantTerms: (input: unknown, context: { now: number; audience: string; head: typeof HEAD }) => unknown
  nightGrantPlainWords: (terms: unknown) => readonly string[]
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('night grant page side', () => {
  const now = 1_800_000_000_000
  const terms = nightGrantTerms({ origin: ORIGIN, head: HEAD, now, grantId: newNightGrantId() })

  it('builds default terms HEAD accepts: 12 uses, at most 12 hours, ordinary organs only', () => {
    expect(() => policy.normalizeNightGrantTerms(terms, { now, audience: ORIGIN, head: HEAD })).not.toThrow()
    expect(terms.maxUses).toBe(12)
    expect(terms.notAfter - now).toBeLessThanOrEqual(NIGHT_GRANT_MAX_LIFETIME_MS)
    expect(terms.scope).toBe('add-or-update-non-governance-organs')
    expect(terms.grantId).toMatch(/^night-[0-9a-f]{24}$/)
  })

  it('shows the owner exactly the words HEAD states', () => {
    expect(nightGrantWords(terms)).toEqual([...policy.nightGrantPlainWords(terms)])
  })

  it('Without a grant, it claims no Touch ID that is not asked today', () => {
    for (const read of [{ kind: 'none' } as const]) {
      const words = nightGrantSummary(read).summary
      expect(words).not.toMatch(/every new or changed organ/i)
      expect(words).toContain('Adding an organ')
      expect(words).toContain('asks for your Touch ID today')
    }
  })

  it('never reports an unread or malformed grant as none or active', async () => {
    expect(nightGrantSummary({ kind: 'unknown' }).badge).toBe('UNKNOWN')
    expect(parseNightGrantStatus({ ok: true, nightGrant: { state: 'active', terms: { schema: 'other' }, usesLeft: 3, plainWords: [] } })).toBeNull()
    const failing = (() => Promise.resolve(json({ ok: false }, 503))) as unknown as typeof fetch
    expect(await readNightGrant(new AbortController().signal, failing)).toBeNull()
    const none = (() => Promise.resolve(json({ ok: true, nightGrant: null }))) as unknown as typeof fetch
    expect(await readNightGrant(new AbortController().signal, none)).toBe('none')
  })
})
