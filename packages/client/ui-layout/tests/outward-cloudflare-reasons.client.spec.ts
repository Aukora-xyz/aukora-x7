/**
 * The owner's card for her Cloudflare asks says EVERY reason the edge gave, binds that reason
 * into the bytes his fingerprint covers (`expect`), and when the edge answers that its reason changed, says so in one
 * sentence and never offers the same bytes again. The other two tools are unchanged, byte for byte. Every host answer
 * here is a local stand-in; no passkey, Cloudflare or network is real.
 */
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { canonicalJson, class3Action, type Class3Action } from '../src/client/spatial/aumlok/class3-approval.ts'

// The edge's own table of every reason it can emit (read, never changed here): a code it adds without a sentence turns this red.
const root = ['', '../../../'].map(prefix => resolve(process.cwd(), `${prefix}deploy/cloudflare/src`)).find(path => existsSync(`${path}/cloudflare-door.mjs`))
const { CLOUDFLARE_DOOR_LEVEL_TABLE } = await import(pathToFileURL(`${root ?? 'deploy/cloudflare/src'}/cloudflare-door.mjs`).href) as {
  readonly CLOUDFLARE_DOOR_LEVEL_TABLE: readonly { readonly family: string; readonly reason: string }[]
}

const approvals: Class3Action[] = []
vi.mock('../src/client/spatial/aumlok/class3-approval.ts', async (original) => {
  const real = await original<typeof import('../src/client/spatial/aumlok/class3-approval.ts')>()
  return { ...real, approveClass3: async (action: Class3Action) => {
    approvals.push(action)
    return { ok: true, token: 'stand-in-approval', expiresAt: Date.now() + 60_000, action, hostRemainingMs: 60_000, receivedAt: 0 }
  } }
})
const {
  approveAndSendOutward, CLOUDFLARE_REASON_CHANGED_WORDS, CLOUDFLARE_REASON_WHY, CLOUDFLARE_WHY, cloudflareReasons, outwardWords,
  parseStagedOutward, readStagedOutward, reasonChangedFor, resetReasonChangedForTests, STAGED_OUTWARD_PATH, STAGED_OUTWARD_SCHEMA,
} = await import('../src/client/spatial/aumlok/outward-class3.ts')

afterEach(() => { resetReasonChangedForTests(); approvals.length = 0 })

const dns = { action: 'api', method: 'PATCH', path: '/zones/0123456789abcdef0123456789abcdef/dns_records/r1', body: { content: '192.0.2.9', proxied: true } }
const file = (body: unknown, protection: unknown, stagedAt = 1) => JSON.stringify({ schema: STAGED_OUTWARD_SCHEMA, stagedAt,
  tool: 'x6_cloudflare', method: 'POST', pathname: '/_host/cloudflare', body, protection })
const why = (protection: unknown): string[] => {
  const staged = parseStagedOutward(file(dns, protection))
  expect(staged, JSON.stringify(protection)).not.toBeNull()
  return new Map(outwardWords(staged!).rows).get('why')!.split('\n')
}
const words = (sentence: string): number => sentence.trim().split(/\s+/u).length
const ADVICE = /\b(?:recommend\w*|should|suggest\w*|worth|cheap\w*|best|save|deal|consider|token\w*)\b/iu
const CONTRACT_7_CODES = [['P2', 'app-secret'], ['P1', 'live-facts-unresolved'], ['P1', 'inspection-limit']] as const
const UNCHECKED = ['zone-unresolved', 'bound-id-unresolved', 'live-dependency-unresolved', 'live-facts-unresolved', 'host-unreadable']

describe('`also`, read exactly as the edge writes it', () => {
  const primary = { family: 'P4', reason: 'registrar-renewal' }
  it('accepts 1 to 8 pairs, sorted by family then reason, and keeps every member exactly as staged', () => {
    const also = [{ family: 'P1', reason: 'live-domain' }, { family: 'P1', reason: 'live-zone' }, { family: 'P2', reason: 'keys' },
      { family: 'account-wide-unclassified', reason: 'unclassified' }]
    const staged = parseStagedOutward(file(dns, { ...primary, also }))!
    expect(staged.protection).toEqual({ ...primary, also })
    const eight = Array.from({ length: 8 }, (_, index) => ({ family: 'P1', reason: `live-${'a'.repeat(index + 1)}` }))
    expect(parseStagedOutward(file(dns, { ...primary, also: eight }))?.protection?.also).toEqual(eight)
  })
  it('refuses every other shape', () => {
    const pair = { family: 'P1', reason: 'live-domain' }
    for (const also of [null, [], {}, 'P1', [pair, pair], [{ family: 'P1', reason: 'live-zone' }, pair], [primary],
      [{ ...pair, apiFamily: 'x' }], [{ family: 'P1' }], [{ reason: 'live-domain' }], [{ family: 'P9', reason: 'live-domain' }],
      [{ family: 'P1', reason: 'Live!' }], [pair, null], [{ family: 'P2', reason: 'keys' }, pair],
      Array.from({ length: 9 }, (_, index) => ({ family: 'P1', reason: `live-${'a'.repeat(index + 1)}` }))]) {
      expect(parseStagedOutward(file(dns, { ...primary, also })), JSON.stringify(also)).toBeNull()
    }
  })
  it('refuses a staged body that already carries `expect`', () => {
    expect(parseStagedOutward(file({ ...dns, expect: primary }, primary))).toBeNull()
  })
})

describe('the reason is inside the bytes his fingerprint covers', () => {
  it('approves and sends `{ ...body, expect: protection }`, one value for the digest, the POST and the count', async () => {
    for (const protection of [{ family: 'P1', reason: 'live-zone' }, { family: 'P4', reason: 'registrar-renewal', also: [{ family: 'P1', reason: 'live-domain' }] },
      { family: 'account-wide-unclassified', reason: 'unclassified', apiFamily: 'load_balancers' },
      // No family named: `expect` carries none either (the card's "unnamed" is words only).
      { family: 'account-wide-unclassified', reason: 'other-account' }]) {
      approvals.length = 0
      const staged = parseStagedOutward(file(dns, protection))!
      const approved = { ...dns, expect: protection }
      expect(staged.approved).toEqual(approved)
      expect(staged.canonical).toBe(canonicalJson(approved))
      const posts: string[] = []
      const fetchImpl: typeof fetch = async (_resource, init) => {
        posts.push(typeof init?.body === 'string' ? init.body : '')
        return Promise.resolve(Response.json({ ok: true, status: 200, success: true, result: {} }))
      }
      expect(await approveAndSendOutward(staged, 'https://fixture.invalid', { signal: new AbortController().signal }, fetchImpl))
        .toMatchObject({ kind: 'sent' })
      const binding = await class3Action({ audience: 'https://fixture.invalid', method: 'POST', pathname: '/_host/cloudflare', body: approved })
      expect(approvals.map(canonicalJson)).toEqual([canonicalJson(binding)])
      expect(posts.map(text => canonicalJson(JSON.parse(text)))).toEqual([staged.canonical])
      expect(new Map(outwardWords(staged).rows).get('request')).toBe(`POST /_host/cloudflare · ${String(new TextEncoder().encode(staged.canonical).byteLength)} bytes`)
    }
  })

  it('the other two tools are unchanged, byte for byte: nothing added, the same digest, the same POST text', async () => {
    const github = { action: 'api', method: 'POST', endpoint: 'repos/your_org_x/your-node/issues', body: { title: 'T', body: 'B' } }
    const repo = { action: 'write', path: 'docs/a.md', content: 'one\n', message: 'm', expectedHeadSha: 'a'.repeat(40) }
    for (const [tool, pathname, body] of [['x6_github', '/_host/github', github], ['x6_repo', '/_host/repo', repo]] as const) {
      approvals.length = 0
      const staged = parseStagedOutward(JSON.stringify({ schema: STAGED_OUTWARD_SCHEMA, stagedAt: 1, tool, method: 'POST', pathname, body }))!
      expect(staged.approved).toEqual(body)
      expect(staged.canonical).toBe(canonicalJson(body))
      const posts: string[] = []
      const fetchImpl: typeof fetch = async (_resource, init) => {
        posts.push(typeof init?.body === 'string' ? init.body : '')
        return Promise.resolve(Response.json({ ok: true }))
      }
      await approveAndSendOutward(staged, 'https://fixture.invalid', { signal: new AbortController().signal }, fetchImpl)
      expect(approvals.map(canonicalJson)).toEqual([canonicalJson(await class3Action({ audience: 'https://fixture.invalid', method: 'POST', pathname, body }))])
      expect(posts).toEqual([JSON.stringify(body)])
    }
  })
})

describe('the edge answers that its reason changed', () => {
  it('one plain sentence, none of the edge\'s body, and the same bytes are never offered again; a new ask is', async () => {
    const protection = { family: 'P1', reason: 'live-zone' }
    const text = file(dns, protection)
    const staged = parseStagedOutward(text)!
    const answer = { ok: false, code: 'CLOUDFLARE_REASON_CHANGED', protection: { family: 'P3', reason: 'zone-deletion' } }
    const fetchImpl: typeof fetch = async () => Promise.resolve(Response.json(answer, { status: 409 }))
    const outcome = await approveAndSendOutward(staged, 'https://fixture.invalid', { signal: new AbortController().signal }, fetchImpl)
    expect(outcome).toMatchObject({ kind: 'refused', words: CLOUDFLARE_REASON_CHANGED_WORDS })
    expect(CLOUDFLARE_REASON_CHANGED_WORDS).toBe('Not sent: why this needs your fingerprint changed since she asked, so she must ask again.')
    for (const raw of ['zone-deletion', 'P3', 'CLOUDFLARE_REASON_CHANGED', '{']) expect(outcome.words).not.toContain(raw)
    expect(reasonChangedFor(staged)).toBe(true)
    const reader = (body: string) => ({ whole: async (_s: unknown, path: string) => (path === STAGED_OUTWARD_PATH ? { ok: true as const, text: body } : { ok: false as const, reason: 'nf' }) })
    const signal = new AbortController().signal
    expect(await readStagedOutward(reader(text), 's' as never, signal)).toEqual({ kind: 'none' })
    // She asks again: a new staged file (a new time), even with the same bytes, is offered.
    const again = await readStagedOutward(reader(file(dns, protection, 2)), 's' as never, signal)
    expect(again.kind).toBe('staged')
    // Another 409, or this code for another tool, is not this answer.
    resetReasonChangedForTests()
    const other = await approveAndSendOutward(staged, 'https://fixture.invalid', { signal },
      async () => Promise.resolve(Response.json({ ok: false, code: 'CLOUDFLARE_REQUEST_INVALID' }, { status: 409 })))
    expect(other).toMatchObject({ kind: 'refused', words: 'Not sent: the host refused it (CLOUDFLARE_REQUEST_INVALID).' })
    expect(reasonChangedFor(staged)).toBe(false)
  })
})

describe('a sentence for every reason, and every reason said', () => {
  const codes = [...CLOUDFLARE_DOOR_LEVEL_TABLE.map(row => [row.family, row.reason] as const), ...CONTRACT_7_CODES]

  it('every (family, reason) the edge can emit has its own sentence: plain, under 22 words, no advice', () => {
    for (const [family, reason] of codes) {
      const said = CLOUDFLARE_REASON_WHY[`${family}/${reason}`]
      expect(said, `${family}/${reason}`).toBeDefined()
      const [sentence] = why({ family, reason, ...(family === 'account-wide-unclassified' ? { apiFamily: 'load_balancers' } : {}) })
      expect(words(sentence!), sentence).toBeLessThan(22)
      expect(sentence, sentence).not.toMatch(ADVICE)
      if (family === 'P3') expect(sentence).toMatch(/^It deletes .*That cannot be undone\.$/u)
      if (family === 'P4') expect(sentence).toMatch(/^It commits you to a charge/u)
      if (UNCHECKED.includes(reason)) expect(sentence).toMatch(/^The door could not (?:check|read) .*live home.*so it asks you\.$/u)
    }
    for (const sentence of Object.values(CLOUDFLARE_WHY)) {
      expect(words(sentence)).toBeLessThan(22)
      expect(sentence).not.toMatch(ADVICE)
    }
    expect(why({ family: 'P1', reason: 'inspection-limit' })).toEqual(['Part of this request is wrapped too deeply for the door to read, so it asks you.'])
    expect(why({ family: 'P2', reason: 'app-secret' })).toEqual(['It sets or changes a secret or certificate that one of your applications uses.'])
    expect(why({ family: 'P2', reason: 'app-secret' })).not.toEqual(why({ family: 'P2', reason: 'keys' }))
  })

  it('a charge with a live-home reason shows both; a charge after any primary is still said', () => {
    expect(why({ family: 'P4', reason: 'registrar-renewal', also: [{ family: 'P1', reason: 'live-domain' }] })).toEqual([
      CLOUDFLARE_REASON_WHY['P4/registrar-renewal'], CLOUDFLARE_REASON_WHY['P1/live-domain']])
    // Precedence never sends this, but if it came the charge is still said.
    expect(why({ family: 'P1', reason: 'live-zone', also: [{ family: 'P4', reason: 'billing' }] })).toEqual([
      CLOUDFLARE_REASON_WHY['P1/live-zone'], CLOUDFLARE_REASON_WHY['P4/billing']])
    expect(why({ family: 'P3', reason: 'zone-deletion', also: [{ family: 'P1', reason: 'live-zone' }, { family: 'P4', reason: 'billing' }] })).toEqual([
      CLOUDFLARE_REASON_WHY['P3/zone-deletion'], CLOUDFLARE_REASON_WHY['P1/live-zone'], CLOUDFLARE_REASON_WHY['P4/billing']])
  })

  it('a sentence already said is not said twice; an unknown word is said by its family', () => {
    expect(cloudflareReasons({ family: 'P1', reason: 'new-word', also: [{ family: 'P1', reason: 'other-new-word' }, { family: 'P2', reason: 'new' }] }))
      .toEqual([CLOUDFLARE_WHY.P1, CLOUDFLARE_WHY.P2])
    expect(cloudflareReasons({ family: 'P2', reason: 'keys', also: [{ family: 'account-wide-unclassified', reason: 'unclassified' }] }))
      .toEqual([CLOUDFLARE_REASON_WHY['P2/keys'], `${CLOUDFLARE_WHY.unclassified}.`])
  })

  it('`expect` is never a row: the sentences are its reading', () => {
    const staged = parseStagedOutward(file(dns, { family: 'P4', reason: 'billing', also: [{ family: 'P1', reason: 'live-zone' }] }))!
    const rows = outwardWords(staged).rows
    expect(rows.map(([name]) => name)).toEqual(['why', 'method', 'path', 'body', 'request'])
    for (const [, value] of rows) expect(value).not.toContain('expect')
    expect(new Map(rows).get('body')!.replace(/\s+/gu, '')).toBe(canonicalJson(dns.body))
  })
})
