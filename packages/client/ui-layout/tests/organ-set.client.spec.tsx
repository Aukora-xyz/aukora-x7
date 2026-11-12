// @vitest-environment jsdom
/**
 * Adding ordinary organs with one Touch ID (aumlok/organ-set.ts, portal/OrganSetCell.tsx). HEAD's own rule and every
 * refusal at the edge are in deploy/cloudflare/src/__tests__/organ-set.test.mjs; this file holds the page: it computes the
 * same body HEAD records (parity with owner-grant-policy.mjs), binds the same hash HEAD's Class 3 binding does, lists every
 * organ on the card, and offers nothing it cannot confirm.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { canonicalJson, class3Action } from '../src/client/spatial/aumlok/class3-approval.ts'
import { organSetBodyOf, readOrganSet, type OrganSetBody } from '../src/client/spatial/aumlok/organ-set.ts'
import { OrganSetCell } from '../src/client/spatial/portal/OrganSetCell.tsx'

const ORIGIN = 'https://x61.example.invalid'
const root = ['', '../../../'].map(prefix => resolve(process.cwd(), `${prefix}deploy/cloudflare/src`)).find(path => existsSync(`${path}/owner-grant-policy.mjs`))
const policy = await import(pathToFileURL(`${root ?? 'deploy/cloudflare/src'}/owner-grant-policy.mjs`).href) as {
  organAdditionSet: (previous: unknown, candidate: unknown) => { organId: string; sha256: string }[] | null
  organSetPromotionBody: (ball: unknown, organs: unknown, bytesOf: (sha: string) => number) => unknown
}
const aumlok = await import(pathToFileURL(`${root ?? 'deploy/cloudflare/src'}/aumlok.mjs`).href) as {
  aumlokClass3Binding: (input: { audience: string; method: string; pathname: string; body: unknown }) => Promise<unknown>
}
const sha = (text: string) => createHash('sha256').update(text).digest('hex')
const organ = (name: string) => {
  const code = `export const organ = ${JSON.stringify(name)}; // ü`
  return { code, sha: sha(code), entry: { id: name, specifier: `ball:${sha(code)}`, disabled: false, config: {}, previousSpecifiers: [] } }
}
const base = organ('ordinary-a')
const published = { version: 'x6.1-ball/v1', ballId: 'aa'.repeat(32), parentBallId: null, epoch: 170,
  entries: { 'ordinary-a': base.entry }, modules: { [base.sha]: { sha256: base.sha, specifier: `ball:${base.sha}` } } }
const candidateWith = (names: string[], tweak: (entries: Record<string, Record<string, unknown>>) => void = () => {}) => {
  type Ball = typeof published & { entries: Record<string, Record<string, unknown>>; modules: Record<string, unknown> }
  const ball = structuredClone(published) as Ball
  const codeBySha: Record<string, string> = {}
  for (const name of names) {
    const made = organ(name)
    ball.entries[name] = { ...made.entry }
    ball.modules[made.sha] = { sha256: made.sha, specifier: `ball:${made.sha}` }
    codeBySha[made.sha] = made.code
  }
  tweak(ball.entries)
  return { ball: { ...ball, ballId: 'bb'.repeat(32), parentBallId: published.ballId, epoch: 171 }, codeBySha }
}

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const vectorsPath = ['', '../../../'].map(prefix => resolve(process.cwd(), `${prefix}server/organ-set-rule.vectors.json`)).find(existsSync)
const vectors = JSON.parse(readFileSync(vectorsPath ?? 'server/organ-set-rule.vectors.json', 'utf8')) as {
  previous: Record<string, unknown>
  publishedCode: Record<string, string>
  cases: { name: string; candidate: Record<string, unknown>; codeBySha: Record<string, string>; expect: OrganSetBody['organs'] | null }[]
}

describe('organ set, the shared vectors (server/organ-set-rule.vectors.json, also run by HEAD and the night grant)', () => {
  for (const item of vectors.cases) {
    it(item.name, async () => {
      const body = await organSetBodyOf({ published: vectors.previous, staged: item.candidate, codeBySha: item.codeBySha,
        publishedCode: vectors.publishedCode })
      if (item.expect === null) expect(typeof body).toBe('string')
      else expect(typeof body === 'string' ? body : body.organs).toEqual(item.expect)
    })
  }
})

describe('organ set, page side', () => {
  it('computes exactly the body HEAD records, and binds the hash HEAD binds', async () => {
    const { ball, codeBySha } = candidateWith(['voice-slot', 'repo-forge', 'auma-cortex'])
    const body = await organSetBodyOf({ published, staged: ball, codeBySha })
    expect(typeof body).not.toBe('string')
    const organs = policy.organAdditionSet(published, ball)
    expect(organs).not.toBeNull()
    const server = policy.organSetPromotionBody(ball, organs, s => Buffer.byteLength(codeBySha[s] ?? '', 'utf8'))
    expect(canonicalJson(body)).toBe(canonicalJson(server))
    expect((body as OrganSetBody).organs.map(o => o.organId)).toEqual(['auma-cortex', 'repo-forge', 'voice-slot'])
    const page = await class3Action({ audience: ORIGIN, method: 'POST', pathname: '/_head/promote', body })
    expect(page).toEqual(await aumlok.aumlokClass3Binding({ audience: ORIGIN, method: 'POST', pathname: '/_head/promote', body: server }))
  })

  it('offers nothing for governance, riders, disabled adds or bytes that do not hash', async () => {
    const reasons = await Promise.all([
      (() => { const c = candidateWith(['grant-ledger']); return organSetBodyOf({ published, staged: c.ball, codeBySha: c.codeBySha }) })(),
      (() => { const c = candidateWith(['quiet', 'other'], (e) => { e.quiet = { ...e.quiet, governance: true } }); return organSetBodyOf({ published, staged: c.ball, codeBySha: c.codeBySha }) })(),
      (() => { const c = candidateWith(['new-one'], (e) => { e['ordinary-a'] = { ...e['ordinary-a'], config: { x: 1 } } }); return organSetBodyOf({ published, staged: c.ball, codeBySha: c.codeBySha }) })(),
      (() => { const c = candidateWith(['new-one'], (e) => { e['new-one'] = { ...e['new-one'], disabled: true } }); return organSetBodyOf({ published, staged: c.ball, codeBySha: c.codeBySha }) })(),
      (() => { const c = candidateWith(['new-one']); return organSetBodyOf({ published, staged: c.ball, codeBySha: { [Object.keys(c.codeBySha)[0] ?? '']: 'tampered' } }) })(),
    ])
    for (const reason of reasons) expect(typeof reason).toBe('string')
  })

  const edge = (claimed: unknown, ball: unknown, codeBySha: unknown) => vi.fn(async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : input.toString()
    if (url.endsWith('/_head/promotion-status')) {
      return new Response(JSON.stringify({ ok: true, staged: { ballId: 'bb'.repeat(32), epoch: 171, parentBallId: published.ballId, changedEntries: [],
        t2Reasons: ['ORGAN_ADDED_OR_REMOVED'], governanceClass: 1, binding: null, organSet: claimed,
        envelope: { schema: 'aukora.staged-head-promotion.v1', stagedAt: 1, body: { ball, codeBySha } } } }))
    }
    if (url.endsWith('/_head/ball')) return new Response(JSON.stringify({ ball: published }))
    return new Response('{}', { status: 404 })
  })

  it('lists every organ on the card and offers one Touch ID when HEAD and the page agree', async () => {
    const { ball, codeBySha } = candidateWith(['voice-slot', 'repo-forge', 'auma-cortex'])
    const body = await organSetBodyOf({ published, staged: ball, codeBySha })
    vi.stubGlobal('fetch', edge(body, ball, codeBySha))
    expect((await readOrganSet(new AbortController().signal)).kind).toBe('offer')
    const { container } = render(<OrganSetCell active round={0} ownerBound />)
    await waitFor(() => { expect(container.querySelector('[data-sovereignty-organ-set-approve]')).not.toBeNull() })
    for (const id of ['voice-slot', 'repo-forge', 'auma-cortex']) expect(container.textContent).toContain(id)
    for (const organ of (body as OrganSetBody).organs) expect(container.textContent).toContain(organ.sha256.slice(0, 12))
    expect(container.textContent).toContain('ONE TOUCH ID')
  })

  it('a list HEAD claims that the bytes do not support is shown, never offered', async () => {
    const { ball, codeBySha } = candidateWith(['voice-slot'])
    const body = await organSetBodyOf({ published, staged: ball, codeBySha }) as OrganSetBody
    const claimed = { ...body, organs: body.organs.map(o => ({ ...o, bytes: o.bytes + 1 })) }
    vi.stubGlobal('fetch', edge(claimed, ball, codeBySha))
    const { container } = render(<OrganSetCell active round={0} ownerBound />)
    await waitFor(() => { expect(container.querySelector('[data-sovereignty-organ-set-blocked]')).not.toBeNull() })
    expect(container.querySelector('[data-sovereignty-organ-set-approve]')).toBeNull()
  })

  it('A list that changed between display and click is shown anew; no passkey is asked', async () => {
    const first = candidateWith(['voice-slot'])
    const second = candidateWith(['voice-slot', 'adversary'])
    const bodyA = await organSetBodyOf({ published, staged: first.ball, codeBySha: first.codeBySha })
    const bodyB = await organSetBodyOf({ published, staged: second.ball, codeBySha: second.codeBySha })
    let current = { body: bodyA, ball: first.ball, code: first.codeBySha }
    const seen: string[] = []
    const inner = (path: string) => edge(current.body, current.ball, current.code)(path)
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : input.toString()
      seen.push(url)
      return inner(url)
    }))
    const { container } = render(<OrganSetCell active round={0} ownerBound />)
    await waitFor(() => { expect(container.querySelector('[data-sovereignty-organ-set-approve]')).not.toBeNull() })
    expect(container.textContent).not.toContain('adversary')
    // Auma restages a longer list after the card drew the first one, before the owner clicks.
    current = { body: bodyB, ball: second.ball, code: second.codeBySha }
    fireEvent.click(container.querySelector('[data-sovereignty-organ-set-approve]') as HTMLButtonElement)
    await waitFor(() => { expect(container.querySelector('[data-sovereignty-organ-set-said]')?.textContent).toContain('The list changed') })
    expect(container.textContent).toContain('adversary')
    expect(seen.some(url => url.includes('/_host/aumlok') || url.includes('/_head/promote'))).toBe(false)
  })

  it('draws nothing when HEAD holds no organ set', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, staged: null }))))
    const { container } = render(<OrganSetCell active round={0} ownerBound />)
    await new Promise((done) => { setTimeout(done, 20) })
    expect(container.querySelector('[data-sovereignty-portal="organ-set"]')).toBeNull()
  })
})
