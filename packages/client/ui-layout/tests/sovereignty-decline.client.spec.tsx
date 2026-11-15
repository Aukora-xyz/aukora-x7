// @vitest-environment jsdom
/**
 * The owner's "Decline" on a card for a Pearl HEAD holds. It calls POST /_head/stage-withdraw once
 * with the card's exact ballId, asks for no passkey (no AUMLOK call, no approval header), and the card goes once HEAD holds
 * nothing; a refusal shows HEAD's closed code in the card's own line. Shown on a card HEAD holds that no passkey can approve
 * (head-blocked), on a staged Class 3 card awaiting him, and on the Add organs card. Local only: every answer is a stub.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { candidateDigestOf, headPromotionBinding, STAGED_PROMOTION_PATH } from '../src/client/spatial/aumlok/head-promotion.ts'
import { organSetBodyOf } from '../src/client/spatial/aumlok/organ-set.ts'
import { OrganSetCell } from '../src/client/spatial/portal/OrganSetCell.tsx'
import { SOVEREIGNTY_SURFACE, SovereigntySurface } from '../src/client/spatial/portal/SovereigntySurface.tsx'
import { resetApprovalsForTests } from '../src/client/spatial/portal/touch-id-timing.ts'
import type { FileRead } from '../src/client/spatial/work/WorkSurface.tsx'

class FakeChannel { onmessage = null; close() {} }
class FakeSocket { onopen = null; onmessage = null; onclose = null; close() {} }
beforeEach(() => {
  vi.stubGlobal('BroadcastChannel', FakeChannel)
  vi.stubGlobal('WebSocket', FakeSocket)
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); resetApprovalsForTests() })

const sha = (text: string) => createHash('sha256').update(text).digest('hex')
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const transitionPath = ['', '../../../'].map(prefix => resolve(process.cwd(), `${prefix}server/ball-transition.mjs`)).find(existsSync)
const transition = await import(pathToFileURL(transitionPath ?? 'server/ball-transition.mjs').href) as { canonicalJson: (value: unknown) => string }
const codeOf = (name: string, version: number) => `export default { organ: ${JSON.stringify(name)}, version: ${String(version)} }\n`
const ballOf = (parentBallId: string | null, epoch: number, codes: Record<string, string>) => {
  const entries = Object.fromEntries(Object.entries(codes).map(([id, code]) => [id,
    { id, specifier: `ball:${sha(code)}`, disabled: false, config: {}, previousSpecifiers: [] as string[] }]))
  const modules = Object.fromEntries(Object.values(codes).map(code => [sha(code), { sha256: sha(code), specifier: `ball:${sha(code)}` }]))
  const contents = { version: 'x6.1-ball/v1', parentBallId, epoch, authorPeerId: 'auma-writer', entries, modules }
  return { ...contents, ballId: sha(transition.canonicalJson(contents)) }
}
type Ball = ReturnType<typeof ballOf>
const V80 = { 'auma-body-map': codeOf('auma-body-map', 80), 'auma-kernel': codeOf('auma-kernel', 1) }
const E80 = ballOf(null, 80, V80)
// A governance change (body-map is a fixed governance organ): the staged Class 3 card awaiting him.
const V81G = { ...V80, 'auma-body-map': codeOf('auma-body-map', 81) }
const E81G = ballOf(E80.ballId, 81, V81G)
// An ordinary replacement (her epoch-80 fix): HEAD holds it, no passkey can approve it (head-blocked).
const V81K = { ...V80, 'auma-kernel': codeOf('auma-kernel', 2) }
const E81K = ballOf(E80.ballId, 81, V81K)

/** HEAD's record of `ball` staged on `parent`, as head-do.mjs `readStaged` serves it. */
const heldRecordOf = async (ball: Ball, parent: Ball, organ: string, codes: Record<string, string>, governance: boolean) => {
  const fields = { ballId: ball.ballId, epoch: ball.epoch, parentBallId: parent.ballId, changedEntries: [organ],
    t2Reasons: governance ? ['T2_PROTECTED_ORGAN'] : [] }
  const binding = governance
    ? await headPromotionBinding({ audience: globalThis.location.origin, ball, entryId: organ, previous: parent.entries }) : null
  const code = codes[organ] ?? ''
  return { schema: 'aukora.staged-head-promotion.v1', ...fields, authorPeerId: 'auma-writer', tier: governance ? 'T2' : 'T1',
    governanceClass: governance ? 3 : 1, binding, organSet: null,
    candidateDigest: await candidateDigestOf(fields), compactModuleShas: [sha(code)], stagedAt: Date.UTC(2026, 10, 14, 12),
    state: 'awaiting_owner', stagedForOwner: true,
    envelope: { schema: 'aukora.staged-head-promotion.v1', stagedAt: Date.UTC(2026, 10, 14, 12), body: { ball,
      codeBySha: { [sha(code)]: code }, expectedParentBallId: parent.ballId, expectedEpoch: parent.epoch } } }
}
const pathOf = (request: string | URL | Request) => (typeof request === 'string' ? request : request instanceof URL ? request.pathname
  : new URL(request.url).pathname)

/** HEAD at E80 holding `record` until a withdraw takes it back (or refuses with `refuse`; `gate` holds the answer back). */
function hostOf(record: unknown, refuse: string | null = null, gate: Promise<void> = Promise.resolve()) {
  const held = { record, withdrawCalls: [] as { body: unknown; headers: Headers }[] }
  const fetchImpl = vi.fn(async (request: string | URL | Request, init?: RequestInit) => {
    const path = pathOf(request)
    if (path === '/_head/stage-withdraw') {
      const sent = JSON.parse(typeof init?.body === 'string' ? init.body : 'null') as { ballId: string }
      held.withdrawCalls.push({ body: sent, headers: new Headers(init?.headers) })
      await gate
      if (refuse === 'ALREADY_PUBLISHED') return json({ ok: false, code: refuse, status: 409, ballId: sent.ballId }, 409)
      if (refuse !== null) return json({ ok: false, code: refuse, status: 409 }, 409)
      held.record = null
      return json({ ok: true, withdrawn: true, ballId: sent.ballId })
    }
    if (path === '/_head/promotion-status') {
      return json({ ok: true, lease: null, ballId: E80.ballId, epoch: 80, staged: held.record, supersededStaged: null,
        lastPublishOutcome: null, peers: [] })
    }
    if (path === '/_head/lease') {
      return json({ ok: true, lease: null, ballId: E80.ballId, epoch: 80, governancePromotion: true,
        governancePromotionRequirements: { canonicalManifest: true, unchangedOtherEntries: true } })
    }
    if (path === '/_head/ball') return json({ ok: true, buildSha: 'b'.repeat(40), head: E80, ball: E80, modules: {}, peers: [] })
    if (path === '/_host/aumlok/status') return json({ ok: true, phase: 'BOUND', bound: true, passkeyVerified: true, nodePubkeyHex: 'ef'.repeat(32), blockers: [] })
    if (path === '/__x6/status') return json({ ok: true, runtime: 'cloudflare' })
    return new Response('nope', { status: 404 })
  })
  return Object.assign(held, { fetchImpl })
}
const noHome = { whole: async (_session: unknown, _path: string): Promise<FileRead> => ({ ok: false, reason: 'not-found' }) as unknown as FileRead }
/** Her home holding `ball` as her worker stages it (the common live shape): the page reads it and never writes it. */
const homeWith = (ball: Ball, organ: string, codes: Record<string, string>) => {
  const text = JSON.stringify({ schema: 'aukora.staged-head-promotion.v1', stagedAt: Date.UTC(2026, 10, 14, 12), body: { ball,
    codeBySha: { [sha(codes[organ] ?? '')]: codes[organ] }, expectedParentBallId: E80.ballId, expectedEpoch: 80 } })
  return { whole: async (_session: unknown, path: string): Promise<FileRead> => (path === STAGED_PROMOTION_PATH
    ? { ok: true, text } : { ok: false, reason: 'not-found' }) as unknown as FileRead }
}
const mountSovereignty = (reader: { whole: (session: unknown, path: string) => Promise<FileRead> } = noHome) => {
  const list = { ids: ['s1'], byId: { s1: { id: 's1', displayTitle: 'Test', running: false, retainedBy: { mainView: 1 }, blank: false, updatedAt: 1 } },
    phase: 'ready', projectionsBySession: {} } as unknown as SessionListState
  const useSessions = bindSnapshotSelector(createSnapshotStore<SessionListState>(list))
  const props = { activeSurface: SOVEREIGNTY_SURFACE, useSessions, reader } as unknown as Parameters<typeof SovereigntySurface>[0]
  const { container } = render(<SovereigntySurface {...props} />)
  return { container, card: () => container.querySelector('[data-sovereignty-portal="promotion"]'),
    decline: () => container.querySelector<HTMLButtonElement>('[data-sovereignty-decline]'),
    approve: () => container.querySelector<HTMLButtonElement>('[data-sovereignty-promote]'),
    declinedLine: () => container.querySelector('[data-sovereignty-declined]') }
}
const asksNoPasskey = (host: ReturnType<typeof hostOf>) => {
  const passkeyRoute = /\/_host\/aumlok\/(?:challenge|approve)|\/_head\/promote/
  expect(host.fetchImpl.mock.calls.some(([request]) => passkeyRoute.test(pathOf(request)))).toBe(false)
  for (const call of host.withdrawCalls) expect(call.headers.has('x-x6-class3-approval')).toBe(false)
}

describe('Decline on the staged Pearl card (Sovereignty)', () => {
  it.each([
    ['a Pearl HEAD holds that no passkey can approve (head-blocked)', E81K, 'auma-kernel', V81K, false],
    ['a staged Class 3 Pearl awaiting him', E81G, 'auma-body-map', V81G, true],
  ] as const)('%s: one call with its exact ballId, no passkey, and the card goes', async (_name, ball, organ, codes, governance) => {
    const host = hostOf(await heldRecordOf(ball, E80, organ, codes, governance))
    vi.stubGlobal('fetch', host.fetchImpl)
    const page = mountSovereignty()
    await waitFor(() => { expect(page.decline()).not.toBeNull() }, { timeout: 10_000 })
    expect(page.decline()?.textContent).toBe('Decline')
    expect(page.decline()?.getAttribute('data-sovereignty-decline')).toBe(ball.ballId)
    fireEvent.click(page.decline()!)
    await waitFor(() => { expect(page.card()).toBeNull() }, { timeout: 10_000 })
    expect(host.withdrawCalls).toHaveLength(1)
    expect(host.withdrawCalls[0]!.body).toEqual({ ballId: ball.ballId })
    asksNoPasskey(host)
    expect(page.container.textContent).not.toMatch(/\btoken\b/iu)
  })

  it('a refusal shows HEAD\'s code in the card\'s own line and the card stays', async () => {
    const host = hostOf(await heldRecordOf(E81K, E80, 'auma-kernel', V81K, false), 'CANDIDATE_SUPERSEDED')
    vi.stubGlobal('fetch', host.fetchImpl)
    const page = mountSovereignty()
    await waitFor(() => { expect(page.decline()).not.toBeNull() }, { timeout: 10_000 })
    fireEvent.click(page.decline()!)
    await waitFor(() => {
      expect(page.container.querySelector('[data-sovereignty-promotion-outcome]')?.textContent).toContain('CANDIDATE_SUPERSEDED')
    }, { timeout: 10_000 })
    expect(page.card()).not.toBeNull()
    expect(host.withdrawCalls).toHaveLength(1)
    asksNoPasskey(host)
  })
})

describe('review fixes: her home copy, an already-live Pearl, a double tap', () => {
  it('B-S1: her home still holds the declined Pearl: the card goes anyway and one line says her copy stays', async () => {
    const host = hostOf(await heldRecordOf(E81G, E80, 'auma-body-map', V81G, true))
    vi.stubGlobal('fetch', host.fetchImpl)
    const page = mountSovereignty(homeWith(E81G, 'auma-body-map', V81G))
    await waitFor(() => { expect(page.decline()).not.toBeNull() }, { timeout: 10_000 })
    fireEvent.click(page.decline()!)
    await waitFor(() => { expect(page.card()).toBeNull() }, { timeout: 10_000 })
    expect(page.declinedLine()?.getAttribute('data-sovereignty-declined')).toBe(E81G.ballId)
    expect(page.declinedLine()?.textContent).toBe(`Declined: Pearl ${E81G.ballId.slice(0, 12)} is no longer held for you. `
      + 'Auma\'s copy stays in her home; she can stage it again.')
    expect(page.container.querySelectorAll('[data-sovereignty-declined]')).toHaveLength(1)
    expect(page.container.textContent).not.toContain('WAITING FOR TOUCH ID')
    expect(host.withdrawCalls).toHaveLength(1)
    asksNoPasskey(host)
  })

  it('B-M1: HEAD already published it: the card says it is live and does not vanish silently', async () => {
    const host = hostOf(await heldRecordOf(E81K, E80, 'auma-kernel', V81K, false), 'ALREADY_PUBLISHED')
    vi.stubGlobal('fetch', host.fetchImpl)
    const page = mountSovereignty()
    await waitFor(() => { expect(page.decline()).not.toBeNull() }, { timeout: 10_000 })
    fireEvent.click(page.decline()!)
    await waitFor(() => {
      expect(page.container.querySelector('[data-sovereignty-promotion-outcome]')?.textContent)
        .toBe(`HEAD already took it: Pearl ${E81K.ballId.slice(0, 12)} is live, so nothing was taken back. Refresh reads the new head.`)
    }, { timeout: 10_000 })
    expect(page.card()).not.toBeNull()
    expect(page.declinedLine()).toBeNull()
  })

  it('B-N5: while a Decline is in flight Approve is disabled, and a double tap sends one withdraw', async () => {
    let open = (): void => {}
    const gate = new Promise<void>((done) => { open = done })
    const host = hostOf(await heldRecordOf(E81G, E80, 'auma-body-map', V81G, true), null, gate)
    vi.stubGlobal('fetch', host.fetchImpl)
    const page = mountSovereignty()
    await waitFor(() => { expect(page.approve()?.disabled).toBe(false) }, { timeout: 10_000 })
    const button = page.decline()!
    fireEvent.click(button)
    fireEvent.click(button)
    await waitFor(() => { expect(page.approve()?.disabled).toBe(true) }, { timeout: 10_000 })
    expect(host.withdrawCalls).toHaveLength(1)
    open()
    await waitFor(() => { expect(page.card()).toBeNull() }, { timeout: 10_000 })
    expect(host.withdrawCalls).toHaveLength(1)
    asksNoPasskey(host)
  })
})

describe('Decline on the Add organs card', () => {
  it('one call with the card\'s ballId, no passkey, and the card goes', async () => {
    const organ = (name: string) => { const code = `export const organ = ${JSON.stringify(name)};`; return { code, sha: sha(code) } }
    const base = organ('ordinary-a'), add = organ('eyes')
    const published = { version: 'x6.1-ball/v1', ballId: 'aa'.repeat(32), parentBallId: null, epoch: 170,
      entries: { 'ordinary-a': { id: 'ordinary-a', specifier: `ball:${base.sha}`, disabled: false, config: {}, previousSpecifiers: [] } },
      modules: { [base.sha]: { sha256: base.sha, specifier: `ball:${base.sha}` } } }
    const ball = { ...structuredClone(published), ballId: 'bb'.repeat(32), parentBallId: published.ballId, epoch: 171,
      entries: { ...published.entries, eyes: { id: 'eyes', specifier: `ball:${add.sha}`, disabled: false, config: {}, previousSpecifiers: [] } },
      modules: { ...published.modules, [add.sha]: { sha256: add.sha, specifier: `ball:${add.sha}` } } }
    const codeBySha = { [add.sha]: add.code }
    const body = await organSetBodyOf({ published, staged: ball, codeBySha })
    let staged: unknown = { ballId: ball.ballId, epoch: 171, parentBallId: published.ballId, changedEntries: [], t2Reasons: ['ORGAN_ADDED_OR_REMOVED'],
      governanceClass: 1, binding: null, organSet: body, envelope: { schema: 'aukora.staged-head-promotion.v1', stagedAt: 1, body: { ball, codeBySha } } }
    const calls: { path: string; init: RequestInit | undefined }[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString()
      calls.push({ path: url, init })
      if (url.endsWith('/_head/stage-withdraw')) { staged = null; return json({ ok: true, withdrawn: true, ballId: ball.ballId }) }
      if (url.endsWith('/_head/promotion-status')) return json({ ok: true, staged })
      if (url.endsWith('/_head/ball')) return json({ ball: published })
      return json({}, 404)
    }))
    const { container } = render(<OrganSetCell active round={0} ownerBound />)
    await waitFor(() => { expect(container.querySelector('[data-sovereignty-decline]')).not.toBeNull() })
    expect(container.querySelector('[data-sovereignty-decline]')?.getAttribute('data-sovereignty-decline')).toBe(ball.ballId)
    fireEvent.click(container.querySelector<HTMLButtonElement>('[data-sovereignty-decline]')!)
    await waitFor(() => { expect(container.querySelector('[data-sovereignty-portal="organ-set"]')).toBeNull() })
    const withdraws = calls.filter(call => call.path.endsWith('/_head/stage-withdraw'))
    expect(withdraws).toHaveLength(1)
    const sentBody = withdraws[0]!.init?.body
    expect(JSON.parse(typeof sentBody === 'string' ? sentBody : 'null')).toEqual({ ballId: ball.ballId })
    expect(new Headers(withdraws[0]!.init?.headers).has('x-x6-class3-approval')).toBe(false)
    expect(calls.some(call => call.path.includes('/_host/aumlok') || call.path.endsWith('/_head/promote'))).toBe(false)
    expect(STAGED_PROMOTION_PATH).toBe('/dsh/home/auma/staged/head-promotion.json')
  })
})
