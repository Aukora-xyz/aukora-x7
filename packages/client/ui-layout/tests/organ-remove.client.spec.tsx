// @vitest-environment jsdom
/**
 * Removing ONE ordinary organ with one Touch ID (aumlok/organ-set.ts organRemoveBodyOf, portal/OrganSetCell.tsx),
 * and the words on the held ORDINARY card (portal/SovereigntySurface.tsx). The page's copy of HEAD's rule passes the shared
 * vectors; its body and binding equal HEAD's (ORGAN_REMOVE_PATH, never the add's); the card offers the approval only when it
 * re-derives HEAD's body byte for byte, and Decline is on it. Local only: every answer is a stub.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, waitFor } from '@testing-library/react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import { canonicalJson, class3Action } from '../src/client/spatial/aumlok/class3-approval.ts'
import { candidateDigestOf } from '../src/client/spatial/aumlok/head-promotion.ts'
import {
  approveOrganRemove, ORGAN_REMOVE_PATH, organRemoveBodyOf, readOrganChange, type OrganRemoveBody,
} from '../src/client/spatial/aumlok/organ-set.ts'
import { OrganSetCell } from '../src/client/spatial/portal/OrganSetCell.tsx'
import { ORDINARY_HELD_WORDS, SOVEREIGNTY_SURFACE, SovereigntySurface } from '../src/client/spatial/portal/SovereigntySurface.tsx'
import { readApprovalFacts } from '../src/client/spatial/portal/ApprovalWaiting.tsx'
import { readWaitingApprovals } from '../src/client/spatial/portal/FingerprintWaiting.tsx'
import { approvalNoticeEntries } from '../src/client/spatial/portal/notices.ts'
import { resetApprovalsForTests } from '../src/client/spatial/portal/touch-id-timing.ts'
import type { FileRead } from '../src/client/spatial/work/WorkSurface.tsx'

const ORIGIN = 'https://node.example.invalid'
const root = ['', '../../../'].map(prefix => resolve(process.cwd(), `${prefix}deploy/cloudflare/src`)).find(path => existsSync(`${path}/owner-grant-policy.mjs`))
const policy = await import(pathToFileURL(`${root ?? 'deploy/cloudflare/src'}/owner-grant-policy.mjs`).href) as {
  organRemoval: (previous: unknown, candidate: unknown) => { organId: string; sha256: string } | null
  organRemovePromotionBody: (ball: unknown, removal: unknown) => unknown
  ORGAN_REMOVE_PATH: string
  ORGAN_SET_PATH: string
}
const aumlok = await import(pathToFileURL(`${root ?? 'deploy/cloudflare/src'}/aumlok.mjs`).href) as {
  aumlokClass3Binding: (input: { audience: string; method: string; pathname: string; body: unknown }) => Promise<unknown>
}
const vectorsPath = ['', '../../../'].map(prefix => resolve(process.cwd(), `${prefix}server/organ-remove-rule.vectors.json`)).find(existsSync)
const vectors = JSON.parse(readFileSync(vectorsPath ?? 'server/organ-remove-rule.vectors.json', 'utf8')) as {
  previous: Record<string, unknown>
  cases: { name: string; candidate: Record<string, unknown>; expect: { organId: string; sha256: string } | null }[]
}

class FakeChannel { onmessage = null; close() {} }
class FakeSocket { onopen = null; onmessage = null; onclose = null; close() {} }
beforeEach(() => { vi.stubGlobal('BroadcastChannel', FakeChannel); vi.stubGlobal('WebSocket', FakeSocket) })
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); resetApprovalsForTests() })

const sha = (text: string) => createHash('sha256').update(text).digest('hex')
const organ = (name: string) => {
  const code = `export const organ = ${JSON.stringify(name)};`
  return { code, sha: sha(code), entry: { id: name, specifier: `ball:${sha(code)}`, disabled: false, config: {}, previousSpecifiers: [] as string[] } }
}
const a = organ('ordinary-a'), k = organ('ordinary-k')
const published = { version: 'x6.1-ball/v1', ballId: 'aa'.repeat(32), parentBallId: null, epoch: 177,
  entries: { 'ordinary-a': a.entry, 'ordinary-k': k.entry },
  modules: { [a.sha]: { sha256: a.sha, specifier: `ball:${a.sha}` }, [k.sha]: { sha256: k.sha, specifier: `ball:${k.sha}` } } }
const removalOf = (id: string) => {
  const ball = structuredClone(published)
  const entries = Object.fromEntries(Object.entries(ball.entries).filter(([key]) => key !== id))
  return { ...ball, entries, ballId: 'bb'.repeat(32), parentBallId: published.ballId, epoch: 178 }
}

describe('organ removal, the shared vectors (server/organ-remove-rule.vectors.json, also run by HEAD and her worker)', () => {
  for (const item of vectors.cases) {
    it(item.name, () => {
      const body = organRemoveBodyOf({ published: vectors.previous, staged: item.candidate })
      if (item.expect === null) expect(typeof body).toBe('string')
      else expect(typeof body === 'string' ? body : body.organ).toEqual(item.expect)
    })
  }
})

describe('organ removal, page side', () => {
  it('computes exactly the body HEAD records, and binds the hash HEAD binds, on ORGAN_REMOVE_PATH (never the add\'s)', async () => {
    const ball = removalOf('ordinary-k')
    const body = organRemoveBodyOf({ published, staged: ball }) as OrganRemoveBody
    const server = policy.organRemovePromotionBody(ball, policy.organRemoval(published, ball))
    expect(canonicalJson(body)).toBe(canonicalJson(server))
    expect(ORGAN_REMOVE_PATH).toBe(policy.ORGAN_REMOVE_PATH)
    expect(ORGAN_REMOVE_PATH).not.toBe(policy.ORGAN_SET_PATH)
    const page = await class3Action({ audience: ORIGIN, method: 'POST', pathname: ORGAN_REMOVE_PATH, body })
    expect(page).toEqual(await aumlok.aumlokClass3Binding({ audience: ORIGIN, method: 'POST', pathname: policy.ORGAN_REMOVE_PATH, body: server }))
    expect(page).not.toEqual(await aumlok.aumlokClass3Binding({ audience: ORIGIN, method: 'POST', pathname: policy.ORGAN_SET_PATH, body: server }))
  })

  it('the approval asks the passkey for exactly that binding, as the add card does', async () => {
    const body = organRemoveBodyOf({ published, staged: removalOf('ordinary-k') }) as OrganRemoveBody
    const asked: unknown[] = []
    const call = vi.fn(async (_route: string, _signal: AbortSignal, request: unknown) => { asked.push(request); return { kind: 'absent' } })
    const outcome = await approveOrganRemove(body, ORIGIN, { signal: new AbortController().signal, call: call as never,
      platform: { passkeyBlocker: () => null } as never })
    expect(outcome.kind).toBe('not-approved')
    expect((asked[0] as { binding: unknown }).binding).toEqual(await class3Action({ audience: ORIGIN, method: 'POST', pathname: ORGAN_REMOVE_PATH, body }))
  })

  const edge = (claimed: unknown, ball: unknown) => vi.fn(async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : input.toString()
    if (url.endsWith('/_head/promotion-status')) {
      return new Response(JSON.stringify({ ok: true, staged: { ballId: 'bb'.repeat(32), epoch: 178, parentBallId: published.ballId,
        changedEntries: ['ordinary-k'],
        t2Reasons: ['ORGAN_ADDED_OR_REMOVED'], governanceClass: 1, binding: null, organSet: null, organRemove: claimed,
        envelope: { schema: 'aukora.staged-head-promotion.v1', stagedAt: 1, body: { ball, codeBySha: {} } } } }))
    }
    if (url.endsWith('/_head/ball')) return new Response(JSON.stringify({ ball: published }))
    return new Response('{}', { status: 404 })
  })

  it('the card says which organ goes and its module, offers one Touch ID and Decline, when HEAD and the page agree', async () => {
    const ball = removalOf('ordinary-k')
    const body = organRemoveBodyOf({ published, staged: ball }) as OrganRemoveBody
    vi.stubGlobal('fetch', edge(body, ball))
    expect((await readOrganChange(new AbortController().signal)).remove.kind).toBe('offer')
    const { container } = render(<OrganSetCell active round={0} ownerBound />)
    await waitFor(() => { expect(container.querySelector('[data-sovereignty-organ-remove-approve]')).not.toBeNull() })
    expect(container.textContent).toContain('Remove an organ')
    expect(container.textContent).toContain('removes the ordinary organ ordinary-k')
    expect(container.textContent).toContain(k.sha.slice(0, 12))
    expect(container.textContent).toContain('ONE TOUCH ID')
    expect(container.querySelector('[data-sovereignty-decline]')?.getAttribute('data-sovereignty-decline')).toBe(ball.ballId)
    expect(container.querySelector('[data-sovereignty-organ-set-approve]')).toBeNull()
    expect(container.textContent?.toLowerCase()).not.toContain('token')
  })

  it.each([
    ['another organ than the bytes remove', (body: OrganRemoveBody) => ({ ...body, organ: { ...body.organ, organId: 'ordinary-a' } })],
    ['another module', (body: OrganRemoveBody) => ({ ...body, organ: { ...body.organ, sha256: 'ee'.repeat(32) } })],
    ['an extra field', (body: OrganRemoveBody) => ({ ...body, note: 'x' })],
  ])('a removal HEAD claims with %s is shown with the reason, never offered', async (_label, change) => {
    const ball = removalOf('ordinary-k')
    const body = organRemoveBodyOf({ published, staged: ball }) as OrganRemoveBody
    vi.stubGlobal('fetch', edge(change(body), ball))
    const { container } = render(<OrganSetCell active round={0} ownerBound />)
    await waitFor(() => { expect(container.querySelector('[data-sovereignty-organ-remove-blocked]')).not.toBeNull() })
    expect(container.querySelector('[data-sovereignty-organ-remove-approve]')).toBeNull()
    expect(container.textContent).toContain('CANNOT LAND')
  })

  it('a governance organ is never offered as a removal, whatever HEAD claims', async () => {
    const gov = { ...published, entries: { ...published.entries, 'seed-pearl': organ('seed-pearl').entry } }
    const ball = { ...structuredClone(gov), entries: { ...published.entries }, ballId: 'bb'.repeat(32), parentBallId: gov.ballId, epoch: 178 }
    expect(organRemoveBodyOf({ published: gov, staged: ball })).toMatch(/governance organ/)
  })
})

// ---- item 6: the held ORDINARY card's words (her epoch-80 shape: T1, no governance organ) ----
const codeOf = (name: string, version: number) => `export default { organ: ${JSON.stringify(name)}, version: ${String(version)} }\n`
const transitionPath = ['', '../../../'].map(prefix => resolve(process.cwd(), `${prefix}server/ball-transition.mjs`)).find(existsSync)
const transition = await import(pathToFileURL(transitionPath ?? 'server/ball-transition.mjs').href) as { canonicalJson: (value: unknown) => string }
const ballOf = (parentBallId: string | null, epoch: number, codes: Record<string, string>) => {
  const entries = Object.fromEntries(Object.entries(codes).map(([id, code]) => [id,
    { id, specifier: `ball:${sha(code)}`, disabled: false, config: {}, previousSpecifiers: [] as string[] }]))
  const modules = Object.fromEntries(Object.values(codes).map(code => [sha(code), { sha256: sha(code), specifier: `ball:${sha(code)}` }]))
  const contents = { version: 'x6.1-ball/v1', parentBallId, epoch, authorPeerId: 'auma-writer', entries, modules }
  return { ...contents, ballId: sha(transition.canonicalJson(contents)) }
}
const V80 = { 'auma-body-map': codeOf('auma-body-map', 80), 'ordinary-k': codeOf('ordinary-k', 1) }
const E80 = ballOf(null, 80, V80)
const V81K = { ...V80, 'ordinary-k': codeOf('ordinary-k', 2) }
const E81K = ballOf(E80.ballId, 81, V81K)
const heldOrdinary = async (governanceClass: number, tier: string) => {
  const fields = { ballId: E81K.ballId, epoch: 81, parentBallId: E80.ballId, changedEntries: ['ordinary-k'], t2Reasons: [] as string[] }
  const code = V81K['ordinary-k']
  return { schema: 'aukora.staged-head-promotion.v1', ...fields, authorPeerId: 'auma-writer', tier, governanceClass, binding: null, organSet: null,
    candidateDigest: await candidateDigestOf(fields), compactModuleShas: [sha(code)], stagedAt: Date.UTC(2026, 10, 14, 12),
    state: 'awaiting_owner', stagedForOwner: true,
    envelope: { schema: 'aukora.staged-head-promotion.v1', stagedAt: Date.UTC(2026, 10, 14, 12), body: { ball: E81K,
      codeBySha: { [sha(code)]: code }, expectedParentBallId: E80.ballId, expectedEpoch: 80 } } }
}
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
const hostWith = (record: unknown, lastPublishOutcome: unknown = null) => vi.fn(async (request: string | URL | Request) => {
  const path = typeof request === 'string' ? request : request instanceof URL ? request.pathname : new URL(request.url).pathname
  if (path === '/_head/promotion-status') {
    return json({ ok: true, lease: null, ballId: E80.ballId, epoch: 80, staged: record, supersededStaged: null, lastPublishOutcome,
      peers: [] })
  }
  if (path === '/_head/lease') return json({ ok: true, lease: null, ballId: E80.ballId, epoch: 80, governancePromotion: true,
    governancePromotionRequirements: { canonicalManifest: true, unchangedOtherEntries: true } })
  if (path === '/_head/ball') return json({ ok: true, buildSha: 'b'.repeat(40), head: E80, ball: E80, modules: {}, peers: [] })
  if (path === '/_host/aumlok/status') return json({ ok: true, phase: 'BOUND', bound: true, passkeyVerified: true, nodePubkeyHex: 'ef'.repeat(32), blockers: [] })
  if (path === '/__x6/status') return json({ ok: true, runtime: 'cloudflare' })
  return new Response('nope', { status: 404 })
})
const mountSovereignty = () => {
  const list = { ids: ['s1'], byId: { s1: { id: 's1', displayTitle: 'Test', running: false, retainedBy: { mainView: 1 }, blank: false, updatedAt: 1 } },
    phase: 'ready', projectionsBySession: {} } as unknown as SessionListState
  const useSessions = bindSnapshotSelector(createSnapshotStore<SessionListState>(list))
  const reader = { whole: async (): Promise<FileRead> => ({ ok: false, reason: 'not-found' }) as unknown as FileRead }
  const props = { activeSurface: SOVEREIGNTY_SURFACE, useSessions, reader } as unknown as Parameters<typeof SovereigntySurface>[0]
  const { container } = render(<SovereigntySurface {...props} />)
  return { container, card: () => container.querySelector('[data-sovereignty-portal="promotion"]'),
    header: () => container.querySelector('header')?.textContent ?? '',
    waitingLabel: () => container.querySelector('[data-sovereignty-waiting]')?.firstElementChild?.textContent ?? '' }
}
/** HEAD's own record of a refused publish of `ballId` (head-do.mjs, the outcome promotion-status serves). */
const refusedOutcome = (ballId: string, code: string) => ({ at: 1, ok: false, code, status: 429, candidateBallId: ballId,
  candidateEpoch: 81 })

describe('the held ordinary card (item 6)', () => {
  it('an ordinary T1 change HEAD holds: an ordinary change, nothing needed from him, Auma can publish it herself, Decline takes it back', async () => {
    vi.stubGlobal('fetch', hostWith(await heldOrdinary(1, 'T1')))
    const page = mountSovereignty()
    await waitFor(() => { expect(page.card()?.textContent).toContain(ORDINARY_HELD_WORDS) }, { timeout: 10_000 })
    const text = page.card()?.textContent ?? ''
    expect(text).toContain('Staged ordinary change')
    expect(text).toContain('NOTHING NEEDED FROM YOU')
    expect(text).toContain('an ordinary change: Auma can publish it herself')
    // The page does not contradict the card: nothing is counted or announced as waiting for him.
    expect(page.header()).toContain('0 WAITING')
    expect(page.header()).not.toContain('WAITING FOR TOUCH ID')
    expect(page.waitingLabel()).toBe('Staged by Auma: nothing is needed from you')
    expect(text).not.toContain('Staged governance Pearl')
    expect(text).not.toContain('CANNOT LAND')
    expect(text).not.toContain('Auma must stage it again')
    expect(page.card()?.querySelector('[data-sovereignty-decline]')?.getAttribute('data-sovereignty-decline')).toBe(E81K.ballId)
    expect(page.card()?.querySelector('[data-sovereignty-promote]')).toBeNull()
    expect(text.toLowerCase()).not.toContain('token')
  })

  it('S2: HEAD\'s last publish outcome refused THIS candidate: today\'s blocked words, counted, with the closed code', async () => {
    for (const code of ['ID_PROMOTION_AUTHORITY_MISSING', 'ID_PROMOTION_LIMIT_REACHED']) {
      vi.stubGlobal('fetch', hostWith(await heldOrdinary(1, 'T1'), refusedOutcome(E81K.ballId, code)))
      const page = mountSovereignty()
      await waitFor(() => { expect(page.card()?.textContent).toContain(`refused by HEAD (${code})`) }, { timeout: 10_000 })
      const text = page.card()?.textContent ?? ''
      expect(text).toContain('CANNOT LAND')
      expect(text).not.toContain(ORDINARY_HELD_WORDS)
      expect(page.header()).toContain('1 WAITING FOR TOUCH ID')
      cleanup()
    }
  })

  it('S2: a refusal HEAD names for ANOTHER candidate is not this one\'s: the ordinary words stay, nothing counted', async () => {
    vi.stubGlobal('fetch', hostWith(await heldOrdinary(1, 'T1'), refusedOutcome('cd'.repeat(32), 'ID_PROMOTION_LIMIT_REACHED')))
    const page = mountSovereignty()
    await waitFor(() => { expect(page.card()?.textContent).toContain(ORDINARY_HELD_WORDS) }, { timeout: 10_000 })
    expect(page.card()?.textContent).not.toContain('refused by HEAD')
    expect(page.header()).toContain('0 WAITING')
  })

  it('genuinely blocked: HEAD calls it class 3 while the page finds no governance change: today\'s words stay', async () => {
    vi.stubGlobal('fetch', hostWith(await heldOrdinary(3, 'T2')))
    const page = mountSovereignty()
    await waitFor(() => { expect(page.card()?.textContent).toContain('the two disagree') }, { timeout: 10_000 })
    const text = page.card()?.textContent ?? ''
    expect(text).toContain('Staged governance Pearl')
    expect(text).toContain('CANNOT LAND')
    expect(text).not.toContain(ORDINARY_HELD_WORDS)
    // It is counted and announced as before.
    expect(page.header()).toContain('1 WAITING FOR TOUCH ID')
    expect(page.waitingLabel()).toBe('Waiting for your Touch ID')
  })

  it('an ordinary change HEAD holds as T2 (it cannot publish itself): today\'s words stay', async () => {
    vi.stubGlobal('fetch', hostWith(await heldOrdinary(1, 'T2')))
    const page = mountSovereignty()
    await waitFor(() => { expect(page.card()?.textContent).toContain('Auma must stage it again') }, { timeout: 10_000 })
    expect(page.card()?.textContent).toContain('CANNOT LAND')
    expect(page.card()?.textContent).not.toContain(ORDINARY_HELD_WORDS)
  })
})

// ---- The chat Fingerprint card and Notices decide by the same predicate ----
describe('the held ordinary change in the Fingerprint card and Notices (review S1)', () => {
  const signal = () => new AbortController().signal
  it('nothing needed: the Fingerprint card counts nothing and Notices has no Pearl row', async () => {
    const fetchImpl = hostWith(await heldOrdinary(1, 'T1'))
    expect(await readWaitingApprovals(signal(), fetchImpl as unknown as typeof fetch)).toEqual({ ready: [], blocked: 0 })
    const facts = await readApprovalFacts(signal(), fetchImpl)
    expect(facts).toEqual({ merge: null, pearl: null })
    const rows = approvalNoticeEntries(facts === 'no-route' ? null : facts, () => {})
    expect(rows.filter(row => row.kind === 'pearl' || row.kind === 'home-pearl')).toEqual([])
    expect(rows.some(row => row.what.includes('waiting for your fingerprint'))).toBe(false)
  })

  it.each([
    ['held as T2 (it cannot publish itself)', async () => hostWith(await heldOrdinary(1, 'T2'))],
    ['refused by HEAD for this candidate', async () => hostWith(await heldOrdinary(1, 'T1'), refusedOutcome(E81K.ballId, 'ID_PROMOTION_AUTHORITY_MISSING'))],
    ['claimed class 3 by HEAD', async () => hostWith(await heldOrdinary(3, 'T2'))],
  ])('needs him (%s): counted as before, and Notices says a Pearl waits for his fingerprint', async (_label, host) => {
    const fetchImpl = await host()
    expect(await readWaitingApprovals(signal(), fetchImpl as unknown as typeof fetch)).toEqual({ ready: [], blocked: 1 })
    const facts = await readApprovalFacts(signal(), fetchImpl)
    expect(facts).toMatchObject({ merge: null, pearl: { ballId: E81K.ballId, epoch: 81 } })
    const rows = approvalNoticeEntries(facts === 'no-route' ? null : facts, () => {})
    expect(rows.map(row => row.what)).toEqual(['A Pearl is waiting for your fingerprint: epoch 81.'])
  })
})
