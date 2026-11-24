// @vitest-environment jsdom
/**
 * NOTHING FLOATS, PART TWO.
 * An approval that waits for his fingerprint is a ROW in Notices, never a card over the chat or a pill over
 * the surfaces: one row per thing HEAD holds (a merge, a Pearl), in his words, with one status line from what HEAD said and
 * one action, "Open Sovereignty". A row never approves and never asks for a fingerprint.
 * REVIEW (lead's ruling): Sovereignty's merge card disables its approval only when its checks FAILED. For checks still
 * running or none yet it stays enabled with one plain line: the host reads the checks again at approval and merges only
 * if they pass then; a refusal leaves his approval unspent.
 * What waits in her home (her staged outward request, a Pearl staged only there, an organ set) is a row too, read by the
 * page's existing reader of her files. Local stand-ins only: fetch, sockets, the layout store, her files.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import { useState } from 'react'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { class3Action } from '../src/client/spatial/aumlok/class3-approval.ts'
import { STAGED_PROMOTION_PATH } from '../src/client/spatial/aumlok/head-promotion.ts'
import { STAGED_OUTWARD_PATH, STAGED_OUTWARD_SCHEMA } from '../src/client/spatial/aumlok/outward-class3.ts'
import { ApprovalWaiting, homeApprovalFactsOf } from '../src/client/spatial/portal/ApprovalWaiting.tsx'
import { NoticesMenu, NoticesSurface } from '../src/client/spatial/portal/NoticesSurface.tsx'
import { RepoProposalCell } from '../src/client/spatial/portal/RepoProposalCell.tsx'
import {
  approvalNoticeEntries, checksLine, clockText, currentNotices, NO_HOME_APPROVALS, NOTICES_SURFACE, OPEN_SOVEREIGNTY_LABEL,
  resetNoticesForTests,
} from '../src/client/spatial/portal/notices.ts'
import { resetApprovalsForTests } from '../src/client/spatial/portal/touch-id-timing.ts'
import { createWorkReaderDoor } from '../src/client/spatial/work/index.ts'
import type { FileRead, WorkReader } from '../src/client/spatial/work/WorkSurface.tsx'
import { AppFrame, type AppFrameProps } from '../src/client/spatial/AppFrame.tsx'
import { createLayoutStore } from '../src/client/spatial/stores.ts'

vi.mock('../src/client/spatial/eyes/page-eyes.ts', () => ({ installPageEyes: () => () => {} }))
vi.mock('../src/client/spatial/portal/ThreadsLane.tsx', () => ({
  ThreadsLane: () => <div data-testid="threads">Threads</div>,
}))

class FakeChannel { onmessage = null; close() {} }
class FakeSocket {
  static open: FakeSocket[] = []
  onopen = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose = null
  closed = false
  constructor() { FakeSocket.open.push(this) }
  close() { this.closed = true }
}
const push = (message: unknown): void => {
  for (const socket of FakeSocket.open.filter(open => !open.closed)) socket.onmessage?.({ data: JSON.stringify(message) })
}

beforeEach(() => {
  vi.stubGlobal('BroadcastChannel', FakeChannel)
  vi.stubGlobal('WebSocket', FakeSocket)
})
afterEach(() => {
  cleanup()
  resetNoticesForTests()
  resetApprovalsForTests()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const ORIGIN = 'http://localhost:3000'
const BRANCH = 'auma/proposal/fractalien-lab-v2'
const sha = (c: string) => c.repeat(40)
const mergeBody = { action: 'merge_proposal', baseSha: sha('a'), branch: BRANCH, headSha: sha('b'), treeSha: sha('c') }
const STAGED_AT = new Date(2026, 10, 14, 9, 7).getTime()
type Checks = 'passed' | 'pending' | 'failed' | 'none'
const proposalValue = async (ciStatus: Checks = 'passed', stagedAt: number | null = STAGED_AT) => ({
  schema: 'aukora.staged-repo-proposal.v1', branch: BRANCH, title: 'Fractalien lab v2', summary: null,
  baseSha: sha('a'), headSha: sha('b'), treeSha: sha('c'),
  changedFiles: [{ path: 'apps/web/src/spatial/fractalien.ts', status: 'modified', additions: 3, deletions: 1, t2Protected: false }],
  ciStatus, stagedAt, mergeBody, binding: await class3Action({ audience: ORIGIN, method: 'POST', pathname: '/_host/repo', body: mergeBody }),
})
const PEARL = { ballId: 'e'.repeat(64), epoch: 174, stagedAt: STAGED_AT }
const statusBody = (stagedRepoProposal: unknown, staged: unknown = null) => ({ ok: true, ballId: 'd'.repeat(64), epoch: 173, staged,
  supersededStaged: null, stagedRepoProposal, lastPublishOutcome: null, peers: [] })
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const urlOf = (input: RequestInfo | URL): string => (typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
/** HEAD's promotion-status as the test sets it now; every other route is not served. */
function headSays(initial: { body: unknown; status?: number }) {
  let answer = initial
  const calls: string[] = []
  const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
    const url = urlOf(input)
    calls.push(url)
    return url === '/_head/promotion-status' ? json(answer.body, answer.status ?? 200) : json({ ok: false }, 404)
  }) as unknown as typeof fetch
  return { fetchImpl, calls, set: (next: { body: unknown; status?: number }) => { answer = next } }
}

/** The feed (as the frame mounts it), the Notices launcher and its surface, over HEAD's stand-in (and her files, when given). */
function mountNotices(fetchImpl: typeof fetch, reader?: WorkReader) {
  const openSovereignty = vi.fn()
  const home = reader === undefined ? undefined : { reader, sessionId: 's1' as SessionId }
  function Shell() {
    const [activeSurface, setActive] = useState<string | undefined>(NOTICES_SURFACE)
    const owner = { activeSurface, openSurface: (id: string) => { setActive(id) }, closeSurface: () => { setActive(undefined) } }
    return (
      <>
        <ApprovalWaiting openSovereignty={openSovereignty} fetchImpl={fetchImpl} {...(home === undefined ? {} : { home })} />
        <div data-testid="menu"><NoticesMenu {...(owner as unknown as Parameters<typeof NoticesMenu>[0])} /></div>
        <div data-testid="centre"><NoticesSurface {...(owner as unknown as Parameters<typeof NoticesSurface>[0])} /></div>
      </>
    )
  }
  const view = render(<Shell />)
  const launcher = (): HTMLButtonElement => view.container.querySelector<HTMLButtonElement>('button[data-notices-launcher]')!
  const row = (kind: string): HTMLElement | null => view.container.querySelector<HTMLElement>(`[data-notice="${kind}"]`)
  return { view, launcher, row, openSovereignty }
}
const settle = async (): Promise<void> => { await act(async () => { await new Promise((done) => { setTimeout(done, 20) }) }) }

/** A row holds exactly one control, its "Open Sovereignty", and nothing that approves or asks for a fingerprint. */
function expectOnlyOpenSovereignty(row: HTMLElement): void {
  const buttons = [...row.querySelectorAll('button')]
  expect(buttons.map(button => button.textContent)).toEqual([OPEN_SOVEREIGNTY_LABEL])
  expect(row.textContent).not.toMatch(/Touch ID|Approve/u)
  expect(row.querySelector('[data-fingerprint-approve], [data-repo-proposal-approve]')).toBeNull()
}

describe('an approval waiting is a row in Notices', () => {
  const NOW = Date.now()
  // REVIEW: the status line follows the host's truth. It reads the checks again at approval, so a card made before they were
  // green says so and says approving checks them again; a failed one cannot be approved.
  const at = clockText(STAGED_AT, NOW)
  for (const [checks, line] of [
    ['passed', `Checks passed when this card was made, ${at}.`],
    ['pending', `Checks were still running when this card was made, ${at}. Approving checks them again.`],
    ['failed', `Checks failed when this card was made, ${at}. This card cannot be approved.`],
    ['none', `No checks had run yet when this card was made, ${at}. Approving checks them again.`],
  ] as const) {
    it(`a staged merge, checks ${checks}: one row with the branch and one status line, the count, and Open Sovereignty`, async () => {
      const head = headSays({ body: statusBody(await proposalValue(checks)) })
      const { launcher, row, openSovereignty } = mountNotices(head.fetchImpl)
      await waitFor(() => { expect(launcher().getAttribute('data-waiting')).toBe('1') })
      expect(launcher().getAttribute('aria-label')).toBe('Notices, 1 waiting')
      expect(launcher().closest('.ak-portal')?.classList.contains('ak-tone-gold')).toBe(true)
      const merge = row('merge')!
      expect(merge.textContent).toContain(`A merge is waiting for your fingerprint: ${BRANCH} → main.`)
      expect(merge.textContent).toContain(line)
      // His words: checks, never "CI"; never the other word for a key.
      expect(merge.textContent).not.toMatch(/\bCI\b|token/iu)
      expectOnlyOpenSovereignty(merge)
      fireEvent.click(within(merge).getByRole('button', { name: OPEN_SOVEREIGNTY_LABEL }))
      expect(openSovereignty).toHaveBeenCalledTimes(1)
      // Only HEAD's promotion route was read: no new route.
      expect(new Set(head.calls)).toEqual(new Set(['/_head/promotion-status']))
    })
  }

  it('the status line says no time when HEAD did not say when the card was made', () => {
    expect(checksLine('pending', null)).toBe('Checks were still running when this card was made. Approving checks them again.')
    expect(checksLine('none', null)).toBe('No checks had run yet when this card was made. Approving checks them again.')
    expect(checksLine('failed', null)).toBe('Checks failed when this card was made. This card cannot be approved.')
    expect(checksLine('passed', STAGED_AT, STAGED_AT)).toBe(`Checks passed when this card was made, ${clockText(STAGED_AT, STAGED_AT)}.`)
  })

  it('a staged Pearl likewise: one row, the count, Open Sovereignty, and nothing that approves', async () => {
    const head = headSays({ body: statusBody(null, PEARL) })
    const { launcher, row, openSovereignty } = mountNotices(head.fetchImpl)
    await waitFor(() => { expect(row('pearl')).not.toBeNull() })
    expect(launcher().getAttribute('aria-label')).toBe('Notices, 1 waiting')
    expect(row('pearl')!.textContent).toContain('A Pearl is waiting for your fingerprint: epoch 174.')
    expectOnlyOpenSovereignty(row('pearl')!)
    fireEvent.click(within(row('pearl')!).getByRole('button', { name: OPEN_SOVEREIGNTY_LABEL }))
    expect(openSovereignty).toHaveBeenCalledTimes(1)
  })

  it('a merge and a Pearl: two rows, "Notices, 2 waiting"; a push that one landed takes its row away', async () => {
    const head = headSays({ body: statusBody(await proposalValue('pending'), PEARL) })
    const { launcher, row } = mountNotices(head.fetchImpl)
    await waitFor(() => { expect(launcher().getAttribute('aria-label')).toBe('Notices, 2 waiting') })
    expect(row('merge')).not.toBeNull()
    expect(row('pearl')).not.toBeNull()
    head.set({ body: statusBody(null, PEARL) })
    push({ type: 'repo:merged', commitSha: sha('b') })
    await waitFor(() => { expect(row('merge')).toBeNull() })
    expect(launcher().getAttribute('aria-label')).toBe('Notices, 1 waiting')
  })

  it('nothing staged gives no row; a failed read gives no row; a host without the route gives none and is not asked again', async () => {
    for (const answer of [{ body: statusBody(null) }, { body: { ok: false }, status: 503 }, { body: { ok: false }, status: 401 }]) {
      cleanup()
      resetNoticesForTests()
      const head = headSays(answer)
      const { launcher, view } = mountNotices(head.fetchImpl)
      await waitFor(() => { expect(head.calls.length).toBeGreaterThan(0) })
      await settle()
      expect(launcher().getAttribute('aria-label')).toBe('Notices, nothing waiting')
      expect(view.container.querySelector('[data-notice]')).toBeNull()
      expect(view.container.querySelector('[data-notices-empty]')?.textContent).toBe('Nothing is waiting.')
    }
    cleanup()
    const head = headSays({ body: { ok: false }, status: 404 })
    const { launcher } = mountNotices(head.fetchImpl)
    await waitFor(() => { expect(head.calls).toHaveLength(1) })
    push({ type: 'repo:staged' })
    await settle()
    expect(head.calls).toHaveLength(1)
    expect(launcher().getAttribute('aria-label')).toBe('Notices, nothing waiting')
  })

  it('a read that fails after a row showed takes the row away (a row says only what HEAD said)', async () => {
    const head = headSays({ body: statusBody(await proposalValue('passed')) })
    const { row } = mountNotices(head.fetchImpl)
    await waitFor(() => { expect(row('merge')).not.toBeNull() })
    head.set({ body: { ok: false }, status: 503 })
    push({ type: 'repo:staged' })
    await waitFor(() => { expect(row('merge')).toBeNull() })
  })

  it('the old pill draws nothing at all, wherever it is mounted', async () => {
    const head = headSays({ body: statusBody(await proposalValue('pending'), PEARL) })
    const { container } = render(<ApprovalWaiting openSovereignty={() => {}} fetchImpl={head.fetchImpl} />)
    await waitFor(() => { expect(currentNotices()).toHaveLength(2) })
    expect(container.innerHTML).toBe('')
  })
})

// ── What waits in her home: nothing that waits goes silent (review, item 3) ────────────────────────────────────────
// The removed chat card was the only signal outside Sovereignty for her staged outward request, a Pearl staged only in her
// home, and an organ set. Each is a row now, read by the readers that card used, through the page's reader of her files.

const outwardFile = JSON.stringify({ schema: STAGED_OUTWARD_SCHEMA, stagedAt: Date.UTC(2026, 10, 14, 1), tool: 'x6_github', method: 'POST',
  pathname: '/_host/github', body: { action: 'api', method: 'POST', endpoint: 'repos/your_org_x/your-node/issues',
    body: { title: 'A note for the owner', body: 'One line.' } } })
const OUTWARD_WHAT = 'Auma is asking to send something outward. It waits for your fingerprint.'

/** Her files, by path (absent: not there). `failing`: every read answers unavailable, or (`reject`) throws. */
function homeFiles(files: Record<string, string>) {
  const home: { files: Record<string, string>; failing: boolean | 'reject' } = { files, failing: false }
  const reader: WorkReader = {
    whole: async (_session, path): Promise<FileRead> => {
      if (home.failing === 'reject') throw new Error('the files service went away')
      if (home.failing) return { ok: false, reason: 'unavailable' }
      const text = home.files[path]
      return text === undefined ? { ok: false, reason: 'not-found' } : { ok: true, text }
    },
  }
  return Object.assign(home, { reader })
}

// Pearls in HEAD's own canonical form (as sovereignty-published-pearl.client.spec.tsx builds them): 70 → 171 → 172 published,
// 73 the one she stages next on 172.
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const transitionPath = ['', '../../../'].map(prefix => resolve(process.cwd(), `${prefix}server/ball-transition.mjs`)).find(existsSync)
const transition = await import(pathToFileURL(transitionPath ?? 'server/ball-transition.mjs').href) as {
  canonicalJson: (value: unknown) => string
}
const codeOf = (name: string, version: number) => `export default { organ: ${JSON.stringify(name)}, version: ${String(version)} }\n`
const ballOf = (parentBallId: string | null, epoch: number, codes: Record<string, string>) => {
  const entries = Object.fromEntries(Object.entries(codes).map(([id, code]) => [id,
    { id, specifier: `ball:${hash(code)}`, disabled: false, config: {}, previousSpecifiers: [] as string[] }]))
  const modules = Object.fromEntries(Object.values(codes).map(code => [hash(code), { sha256: hash(code), specifier: `ball:${hash(code)}` }]))
  const contents = { version: 'x6.1-ball/v1', parentBallId, epoch, authorPeerId: 'auma-writer', entries, modules }
  return { ...contents, ballId: hash(transition.canonicalJson(contents)) }
}
type Ball = ReturnType<typeof ballOf>
const V70 = { 'auma-body-map': codeOf('auma-body-map', 70), 'auma-notes': codeOf('auma-notes', 1) }
const E70 = ballOf(null, 70, V70)
const V71 = { ...V70, 'auma-body-map': codeOf('auma-body-map', 171) }
const E71 = ballOf(E70.ballId, 171, V71)
const V72 = { ...V70, 'auma-body-map': codeOf('auma-body-map', 172) }
const E72 = ballOf(E71.ballId, 172, V72)
const V73 = { ...V72, 'auma-body-map': codeOf('auma-body-map', 173) }
const E73 = ballOf(E72.ballId, 173, V73)
const pearlFileOf = (ball: Ball, codes: Record<string, string>, parent: Ball) => JSON.stringify({
  schema: 'aukora.staged-head-promotion.v1', stagedAt: Date.UTC(2026, 10, 14, 0), body: { ball,
    codeBySha: { [hash(codes['auma-body-map'] ?? '')]: codes['auma-body-map'] }, expectedParentBallId: parent.ballId, expectedEpoch: parent.epoch } })
const E72_CHAIN = [E72.ballId, E71.ballId, E70.ballId]

/** HEAD at Epoch 172: promotion-status says `status()`, the lease names 172, `/_head/ball` serves 172. */
function headAt72(status: () => { body: unknown; status?: number }) {
  const calls: string[] = []
  const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
    const url = urlOf(input)
    calls.push(url)
    if (url === '/_head/promotion-status') { const answer = status(); return json(answer.body, answer.status ?? 200) }
    if (url === '/_head/lease') {
      return json({ ok: true, lease: null, ballId: E72.ballId, epoch: E72.epoch, governancePromotion: true,
        governancePromotionRequirements: { canonicalManifest: true, unchangedOtherEntries: true } })
    }
    if (url === '/_head/ball') return json({ ok: true, buildSha: 'b'.repeat(40), head: E72, modules: {}, peers: [] })
    return json({ ok: false }, 404)
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}
const at72 = (stagedRepoProposal: unknown = null, chain: readonly string[] | null = E72_CHAIN) => ({ body: { ok: true, lease: null,
  ballId: E72.ballId, epoch: E72.epoch, staged: null, supersededStaged: null, stagedRepoProposal, lastPublishOutcome: null, peers: [],
  ...(chain === null ? {} : { publishedBallIds: chain }) } })
const HOME_PEARL_WHAT = 'A Pearl Auma staged in her home is waiting for your fingerprint: epoch 173.'
const HOME_PEARL_BLOCKED = 'A Pearl Auma staged in her home is waiting, but cannot be approved as it stands.'

describe('what waits in her home is a row in Notices too', () => {
  it('her staged outward request: one row, where it goes, Open Sovereignty, counted; on a host without HEAD\'s route too', async () => {
    for (const answer of [{ body: statusBody(null) }, { body: { ok: false }, status: 404 }]) {
      cleanup()
      resetNoticesForTests()
      const head = headSays(answer)
      const { launcher, row, openSovereignty } = mountNotices(head.fetchImpl, homeFiles({ [STAGED_OUTWARD_PATH]: outwardFile }).reader)
      await waitFor(() => { expect(row('outward')).not.toBeNull() })
      expect(row('outward')!.textContent).toContain(OUTWARD_WHAT)
      expect(row('outward')!.textContent).toContain('It goes to GitHub.')
      expect(row('outward')!.textContent).not.toMatch(/token/iu)
      expect(launcher().getAttribute('aria-label')).toBe('Notices, 1 waiting')
      expectOnlyOpenSovereignty(row('outward')!)
      fireEvent.click(within(row('outward')!).getByRole('button', { name: OPEN_SOVEREIGNTY_LABEL }))
      expect(openSovereignty).toHaveBeenCalledTimes(1)
    }
  })

  it('her outward request: no row when nothing is staged, or when her files cannot be read; a row goes when a read fails', async () => {
    for (const failing of [false, true, 'reject'] as const) {
      cleanup()
      resetNoticesForTests()
      const files = homeFiles(failing === false ? {} : { [STAGED_OUTWARD_PATH]: outwardFile })
      files.failing = failing
      const head = headSays({ body: statusBody(null) })
      const { launcher, view } = mountNotices(head.fetchImpl, files.reader)
      await waitFor(() => { expect(head.calls.length).toBeGreaterThan(0) })
      await settle()
      expect(view.container.querySelector('[data-notice]')).toBeNull()
      expect(launcher().getAttribute('aria-label')).toBe('Notices, nothing waiting')
    }
    cleanup()
    resetNoticesForTests()
    const files = homeFiles({ [STAGED_OUTWARD_PATH]: outwardFile })
    const { row } = mountNotices(headSays({ body: statusBody(null) }).fetchImpl, files.reader)
    await waitFor(() => { expect(row('outward')).not.toBeNull() })
    files.failing = true
    push({ type: 'mirror:updated', changedPaths: ['home/auma/staged/outward-class3.json'] })
    await waitFor(() => { expect(row('outward')).toBeNull() })
  })

  it('a Pearl staged only in her home: one row with its epoch, Open Sovereignty, counted', async () => {
    const head = headAt72(() => at72())
    const { launcher, row, openSovereignty } = mountNotices(head.fetchImpl,
      homeFiles({ [STAGED_PROMOTION_PATH]: pearlFileOf(E73, V73, E72) }).reader)
    await waitFor(() => { expect(row('home-pearl')).not.toBeNull() }, { timeout: 10_000 })
    expect(row('home-pearl')!.textContent).toContain(HOME_PEARL_WHAT)
    expect(launcher().getAttribute('aria-label')).toBe('Notices, 1 waiting')
    expectOnlyOpenSovereignty(row('home-pearl')!)
    fireEvent.click(within(row('home-pearl')!).getByRole('button', { name: OPEN_SOVEREIGNTY_LABEL }))
    expect(openSovereignty).toHaveBeenCalledTimes(1)
    // No new route: HEAD's promotion route, its lease and its published Pearl, as the chat card read them.
    expect(new Set(head.calls)).toEqual(new Set(['/_head/promotion-status', '/_head/lease', '/_head/ball']))
  }, 20_000)

  it('a Pearl in her home that cannot be approved as it stands still has a row, and Sovereignty says why', async () => {
    // Her file still holds Epoch 171 and the edge names nothing as published (an older edge): Sovereignty counts it.
    const head = headAt72(() => at72(null, null))
    const { row } = mountNotices(head.fetchImpl, homeFiles({ [STAGED_PROMOTION_PATH]: pearlFileOf(E71, V71, E70) }).reader)
    await waitFor(() => { expect(row('home-pearl')).not.toBeNull() }, { timeout: 10_000 })
    expect(row('home-pearl')!.textContent).toContain(HOME_PEARL_BLOCKED)
    expect(row('home-pearl')!.textContent).toContain('Sovereignty says why.')
    expectOnlyOpenSovereignty(row('home-pearl')!)
  }, 20_000)

  it('no home-Pearl row when nothing is staged there, when her files cannot be read, or when HEAD did not answer', async () => {
    for (const [files, answer] of [
      [homeFiles({}), at72()],
      [Object.assign(homeFiles({ [STAGED_PROMOTION_PATH]: pearlFileOf(E73, V73, E72) }), { failing: true }), at72()],
      [homeFiles({ [STAGED_PROMOTION_PATH]: pearlFileOf(E73, V73, E72) }), { body: { ok: false }, status: 503 }],
    ] as const) {
      cleanup()
      resetNoticesForTests()
      const head = headAt72(() => answer)
      const { launcher, view } = mountNotices(head.fetchImpl, files.reader)
      await waitFor(() => { expect(head.calls.length).toBeGreaterThan(0) })
      await settle()
      await settle()
      expect(view.container.querySelector('[data-notice]')).toBeNull()
      expect(launcher().getAttribute('aria-label')).toBe('Notices, nothing waiting')
    }
  }, 20_000)

  it('a merge, a Pearl in her home and her outward request: three rows, "Notices, 3 waiting"', async () => {
    const merge = await proposalValue('pending')
    const head = headAt72(() => at72(merge))
    const { launcher, row } = mountNotices(head.fetchImpl,
      homeFiles({ [STAGED_PROMOTION_PATH]: pearlFileOf(E73, V73, E72), [STAGED_OUTWARD_PATH]: outwardFile }).reader)
    await waitFor(() => { expect(launcher().getAttribute('aria-label')).toBe('Notices, 3 waiting') }, { timeout: 10_000 })
    for (const kind of ['merge', 'home-pearl', 'outward']) expectOnlyOpenSovereignty(row(kind)!)
  }, 20_000)

  it('an organ set is its Pearl\'s row in its own words; one Pearl is one row, whichever source holds it', () => {
    const open = vi.fn()
    const ballId = 'e'.repeat(64)
    const facts = { merge: null, pearl: { ballId, epoch: 174, stagedAt: STAGED_AT } }
    const organs = (list: readonly string[], forBall = ballId) => ({ ...NO_HOME_APPROVALS, organSet: { ballId: forBall, organs: list } })
    const [both] = approvalNoticeEntries(facts, open, STAGED_AT, organs(['repo-forge', 'voice-slot']))
    expect(approvalNoticeEntries(facts, open, STAGED_AT, organs(['repo-forge', 'voice-slot']))).toHaveLength(1)
    expect(both).toMatchObject({ kind: 'pearl', what: 'Auma is asking to add organs: repo-forge, voice-slot. It waits for your fingerprint.',
      action: { label: OPEN_SOVEREIGNTY_LABEL } })
    expect(approvalNoticeEntries(facts, open, STAGED_AT, organs(['voice-slot']))[0]?.what)
      .toBe('Auma is asking to add an organ: voice-slot. It waits for your fingerprint.')
    // Another Pearl's list never renames this one; with no Pearl from HEAD (a failed read) there is no row for it.
    expect(approvalNoticeEntries(facts, open, STAGED_AT, organs(['voice-slot'], 'f'.repeat(64)))[0]?.what)
      .toBe('A Pearl is waiting for your fingerprint: epoch 174.')
    expect(approvalNoticeEntries(null, open, STAGED_AT, organs(['voice-slot']))).toEqual([])
    // Her home holding the Pearl HEAD holds: one row, HEAD's.
    const same = { ...NO_HOME_APPROVALS, homePearl: { ballId, epoch: 174 } }
    expect(approvalNoticeEntries(facts, open, STAGED_AT, same).map(entry => entry.kind)).toEqual(['pearl'])
    expect(approvalNoticeEntries({ merge: null, pearl: null }, open, STAGED_AT, same).map(entry => entry.kind)).toEqual(['home-pearl'])
  })

  it('reads the chat card\'s readers\' answers into rows: an organ set offered; a blocked Pearl counted only when HEAD holds none', () => {
    const ballId = 'e'.repeat(64)
    const organSet = { kind: 'organ-set', key: 'k', approval: 'a', line: '', checkedAt: 0, changesAtRead: 0,
      body: { schema: 'aukora.head-organ-set.v1', ballId, epoch: 174, parentBallId: null,
        organs: [{ organId: 'voice-slot', sha256: 'a'.repeat(64), bytes: 10 }] } }
    type Read = Parameters<typeof homeApprovalFactsOf>[0]
    const heldPearl = { merge: null, pearl: { ballId, epoch: 174, stagedAt: null } }
    expect(homeApprovalFactsOf({ ready: [organSet], blocked: 0 } as unknown as Read, null, heldPearl))
      .toEqual({ ...NO_HOME_APPROVALS, organSet: { ballId, organs: ['voice-slot'] } })
    // One blocked item while HEAD holds a Pearl is that Pearl (its row is there already); with none, it is the one in her home.
    expect(homeApprovalFactsOf({ ready: [], blocked: 1 }, null, heldPearl))
      .toEqual(NO_HOME_APPROVALS)
    expect(homeApprovalFactsOf({ ready: [], blocked: 1 }, null, { merge: null, pearl: null }).homePearl).toBe('blocked')
    expect(homeApprovalFactsOf(null, null, null)).toEqual(NO_HOME_APPROVALS)
    expect(homeApprovalFactsOf(null, { ready: [], blocked: 1 }, null).outward).toBe('unreadable')
  })
})

// ── The frame: nothing over the thread ───────────────────────────────────────────────────────────────────────────

const SESSION = 's-approvals' as SessionId

function mountFrame(reader?: WorkReader) {
  const instance = createLayoutStore().create()
  const sessions = { ids: [SESSION], byId: { [SESSION]: { id: SESSION, displayTitle: 'Chat', running: false, retainedBy: { mainView: 1 }, blank: false } } }
  const renderSlot = ((key: string, owner: Parameters<typeof NoticesSurface>[0]) => {
    if (key === 'shell.surface') return <NoticesSurface {...owner} />
    if (key === 'shell.menu.system') return <NoticesMenu {...owner} />
    if (key === 'main') return <textarea data-testid="composer" defaultValue="" />
    return <div data-testid={`slot-${key}`} />
  }) as unknown as AppFrameProps['renderSlot']
  // The page's reader of her files, as installWorkSurface fills it (absent: the door is there, empty).
  const homeReader = createWorkReaderDoor()
  if (reader !== undefined) homeReader.set(reader)
  const props = {
    useStore: bindSnapshotSelector(instance),
    useSessions: ((selector: (value: typeof sessions) => unknown) => selector(sessions)) as unknown as AppFrameProps['useSessions'],
    renderSlot,
    actions: instance.actions,
    t: (key: string) => key,
    homeReader,
  } as unknown as AppFrameProps
  const view = render(<AppFrame {...props} />)
  const frame = view.container.firstElementChild as HTMLElement
  const lane = (name: string): HTMLElement => frame.querySelector<HTMLElement>(`:scope > [data-lane="${name}"]`)!
  return { view, frame, lane, instance }
}

describe('the frame with a merge waiting: nothing over the chat, nothing over the surfaces', () => {
  beforeEach(() => {
    vi.stubGlobal('matchMedia', (query: string) => ({ media: query, matches: false, addEventListener: () => {}, removeEventListener: () => {} }))
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('cancelAnimationFrame', () => {})
  })

  it('the chat column holds no card and no pill; the row is in Notices; its Open Sovereignty shows Sovereignty', async () => {
    const head = headSays({ body: statusBody(await proposalValue('pending')) })
    vi.stubGlobal('fetch', head.fetchImpl)
    const { frame, lane, instance } = mountFrame()
    // The frame reads HEAD and publishes the row: the count is there on every screen.
    await waitFor(() => { expect(currentNotices().map(notice => notice.kind)).toEqual(['merge']) })
    await settle()
    // NOTHING OVER THE THREAD, by role and by text, and no overlay for an approval anywhere in the frame.
    const chat = lane('left')
    expect(within(chat).queryByRole('complementary', { name: /fingerprint/iu })).toBeNull()
    expect(within(chat).queryByRole('button', { name: /Touch ID|Approval waiting|Inspect in Sovereignty|Hide for now/iu })).toBeNull()
    expect(chat.textContent).not.toMatch(/FINGERPRINT WAITING|Approval waiting|waiting for your fingerprint/u)
    expect(frame.querySelector('[data-fingerprint-waiting], [data-approval-waiting], .aukora-approval-waiting')).toBeNull()
    expect(frame.textContent).not.toMatch(/FINGERPRINT WAITING|Approval waiting/u)
    // Nothing a notice or an approval says is inside an element positioned over content.
    for (const element of frame.querySelectorAll<HTMLElement>('*')) {
      const position = element.style.position
      if (position === 'fixed' || position === 'absolute' || position === 'sticky') {
        expect(element.textContent ?? '').not.toMatch(/fingerprint|approv|merge|Notices/iu)
      }
    }
    // The row: open Notices from the launcher, then its one action opens Sovereignty.
    fireEvent.click(frame.querySelector<HTMLButtonElement>('button[data-notices-launcher]')!)
    expect(instance.getSnapshot().activeSurface).toBe(NOTICES_SURFACE)
    const row = frame.querySelector<HTMLElement>('[data-notice="merge"]')!
    expect(row.textContent).toContain(`A merge is waiting for your fingerprint: ${BRANCH} → main.`)
    expect(row.textContent).toContain('Checks were still running when this card was made')
    expect(lane('center').contains(row)).toBe(true)
    expectOnlyOpenSovereignty(row)
    fireEvent.click(within(row).getByRole('button', { name: OPEN_SOVEREIGNTY_LABEL }))
    expect(instance.getSnapshot().activeSurface).toBe('sovereignty')
    expect(new Set(head.calls)).toEqual(new Set(['/_head/promotion-status']))
  })

  it('her staged outward request, read through the page\'s door to her files: a row in Notices, counted, nothing over the chat', async () => {
    const head = headSays({ body: statusBody(null) })
    vi.stubGlobal('fetch', head.fetchImpl)
    const { frame, lane } = mountFrame(homeFiles({ [STAGED_OUTWARD_PATH]: outwardFile }).reader)
    await waitFor(() => { expect(currentNotices().map(notice => notice.kind)).toEqual(['outward']) })
    expect(frame.querySelector('button[data-notices-launcher]')?.getAttribute('aria-label')).toBe('Notices, 1 waiting')
    expect(lane('left').textContent).not.toMatch(/outward|fingerprint|Touch ID/iu)
    expect(frame.querySelector('[data-fingerprint-waiting]')).toBeNull()
    expect(currentNotices()[0]?.what).toBe(OUTWARD_WHAT)
  })
})

// ── Sovereignty's merge card: no fingerprint it cannot use ──────────────────────────────────────────────────────────

// REVIEW (lead's ruling): the host reads the checks again at approval and merges only if they pass THEN; a refusal leaves
// his approval unspent (deploy/cloudflare/src/cloud-brokers.mjs, merge_proposal). Approve-after-green without a re-stage is
// a path he uses. So only `failed` disables the control; `pending` and `none` keep it, with one plain line above it.
describe('the merge card in Sovereignty disables Touch ID only when its checks failed', () => {
  const openCard = async (container: HTMLElement): Promise<HTMLElement> => {
    await waitFor(() => { expect(container.querySelector('[data-sovereignty-portal="repo-proposal"]')).not.toBeNull() })
    const card = container.querySelector<HTMLElement>('[data-sovereignty-portal="repo-proposal"]')!
    await waitFor(() => { expect(card.querySelector('[data-repo-proposal-approve]')).not.toBeNull() })
    return card
  }
  const TOUCH_ID_LINE = /Touch ID approves exactly this merge, once: main moves from/u
  const NO_PASSKEY = 'No usable passkey is bound on this host, so nothing can approve it here.'
  const notGreen = (at: string | null): string => `Checks were not green when this card was made${at === null ? '' : `, ${at}`}. `
    + 'Approving checks them again now; if they are not green, nothing is spent and nothing merges.'

  for (const checks of ['pending', 'none'] as const) {
    it(`checks ${checks}: the control stays enabled, the badge is the normal one, and one plain line says approving checks again`, async () => {
      const head = headSays({ body: statusBody(await proposalValue(checks)) })
      const { container } = render(<RepoProposalCell active round={0} ownerBound fetchImpl={head.fetchImpl} />)
      const card = await openCard(container)
      expect(card.querySelector<HTMLButtonElement>('[data-repo-proposal-approve]')?.disabled).toBe(false)
      expect(card.querySelector('[data-repo-proposal-ci-warning]')?.textContent).toBe(notGreen(clockText(STAGED_AT)))
      expect(card.textContent).toContain('CLASS 3')
      expect(card.textContent).not.toContain('CANNOT MERGE')
      expect(card.textContent).toMatch(TOUCH_ID_LINE)
      expect(card.textContent).not.toMatch(/\bCI\b|token/iu)
    })
  }

  it('checks not green and HEAD said no time: the line says no time', async () => {
    const head = headSays({ body: statusBody(await proposalValue('pending', null)) })
    const { container } = render(<RepoProposalCell active round={0} ownerBound fetchImpl={head.fetchImpl} />)
    const card = await openCard(container)
    expect(card.querySelector('[data-repo-proposal-ci-warning]')?.textContent).toBe(notGreen(null))
    expect(card.querySelector<HTMLButtonElement>('[data-repo-proposal-approve]')?.disabled).toBe(false)
  })

  it('checks failed: the control is disabled, the card says why in one line, and the Touch ID line is not said', async () => {
    const head = headSays({ body: statusBody(await proposalValue('failed')) })
    const { container } = render(<RepoProposalCell active round={0} ownerBound fetchImpl={head.fetchImpl} />)
    const card = await openCard(container)
    expect(card.querySelector<HTMLButtonElement>('[data-repo-proposal-approve]')?.disabled).toBe(true)
    expect(card.querySelector('[data-repo-proposal-ci-warning]')?.textContent).toBe('Checks failed. This card cannot be approved.')
    expect(card.textContent).toContain('CANNOT MERGE')
    expect(card.textContent).not.toMatch(TOUCH_ID_LINE)
    expect(card.textContent).not.toMatch(/\bCI\b/u)
  })

  it('checks passed: the control is enabled, no warning line, the Touch ID line is said', async () => {
    const head = headSays({ body: statusBody(await proposalValue('passed')) })
    const { container } = render(<RepoProposalCell active round={0} ownerBound fetchImpl={head.fetchImpl} />)
    const card = await openCard(container)
    expect(card.querySelector<HTMLButtonElement>('[data-repo-proposal-approve]')?.disabled).toBe(false)
    expect(card.querySelector('[data-repo-proposal-ci-warning]')).toBeNull()
    expect(card.textContent).toContain('CLASS 3')
    expect(card.textContent).toMatch(TOUCH_ID_LINE)
    expect(card.querySelector('[data-repo-proposal-ci="passed"]')?.textContent).toBe('checks passed')
  })

  it('an owner with no passkey bound: the no-passkey sentence still shows, for checks failed and for checks running', async () => {
    for (const checks of ['failed', 'pending'] as const) {
      cleanup()
      const head = headSays({ body: statusBody(await proposalValue(checks)) })
      const { container } = render(<RepoProposalCell active round={0} ownerBound={false} fetchImpl={head.fetchImpl} />)
      const card = await openCard(container)
      expect(card.textContent).toContain(NO_PASSKEY)
      expect(card.textContent).not.toMatch(TOUCH_ID_LINE)
      expect(card.querySelector<HTMLButtonElement>('[data-repo-proposal-approve]')?.disabled).toBe(true)
    }
  })
})
