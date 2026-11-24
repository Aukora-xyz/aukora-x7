// @vitest-environment jsdom
/**
 * The merge card's design: one clear button instead of long text.
 *
 * The merge card's LOOK and its STATES, never what it approves: one button, labelled exactly "Approve with Touch ID", last in
 * the card's main block after the facts he approves; those facts (branch, main moves, tree, checks, files, staged on HEAD, the
 * binding sentence) all present with her long words closed; her title and summary whole once opened; one tap only while an
 * approval is in flight; a line of its own for each step after the tap (the fingerprint, the host merging, merged, a refusal);
 * and once it merged, nothing counts it as waiting: not Sovereignty's header, not Notices.
 * The passkey ceremony itself (approveClass3) is stood in for, as in repo-proposal-release.client.spec.tsx; what it is asked
 * for and what is sent are asserted exactly, as there.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import { canonicalJson, class3Action, type Class3Action } from '../src/client/spatial/aumlok/class3-approval.ts'

/** Every passkey request, and how the stand-in answers: at once, or when `passkeyGate` resolves; ok, or not completed. */
const approvals: Class3Action[] = []
let passkeyGate: Promise<void> | null = null
let passkeyRefuses = false
vi.mock('../src/client/spatial/aumlok/class3-approval.ts', async (original) => {
  const real = await original<typeof import('../src/client/spatial/aumlok/class3-approval.ts')>()
  return { ...real, approveClass3: async (action: Class3Action) => {
    approvals.push(action)
    if (passkeyGate !== null) await passkeyGate
    if (passkeyRefuses) return { ok: false, reason: 'class3:passkey NotAllowedError' }
    return { ok: true, token: 'stand-in-approval', expiresAt: Date.now() + 60_000, action, hostRemainingMs: 60_000, receivedAt: 0 }
  } }
})
const { RepoProposalCell } = await import('../src/client/spatial/portal/RepoProposalCell.tsx')
const { resetApprovalsForTests } = await import('../src/client/spatial/portal/touch-id-timing.ts')
const { ApprovalWaiting } = await import('../src/client/spatial/portal/ApprovalWaiting.tsx')
const { currentNotices, resetNoticesForTests } = await import('../src/client/spatial/portal/notices.ts')
const { SOVEREIGNTY_SURFACE, SovereigntySurface } = await import('../src/client/spatial/portal/SovereigntySurface.tsx')

class FakeChannel { onmessage = null; close() {} }
class FakeSocket { onopen = null; onmessage = null; onclose = null; close() {} }
beforeEach(() => {
  vi.stubGlobal('BroadcastChannel', FakeChannel); vi.stubGlobal('WebSocket', FakeSocket)
  approvals.length = 0; passkeyGate = null; passkeyRefuses = false
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); resetApprovalsForTests(); resetNoticesForTests() })

const ORIGIN = globalThis.location.origin
const sha = (c: string) => c.repeat(40)
const BRANCH = 'auma/proposal/thread-honest-reads'
const mergeBody = { action: 'merge_proposal', baseSha: sha('a'), branch: BRANCH, headSha: sha('b'), treeSha: sha('c') }
const TITLE = 'Threads read honestly: every thread the lane shows says where it was read from, when, and whether it is complete, '
  + 'and a thread that failed to read says so instead of showing an empty list'
const SUMMARY = [
  'What changes: the thread lane reads each thread through one reader that records where the read came from (her home, the edge, or this page), when it happened, and whether every entry arrived.',
  'Why: a thread that failed to read used to show as empty, which looked like a thread with nothing in it.',
  'How it was checked: the new specs read a thread that is complete, one that is partial and one that fails, and the old specs still pass unchanged.',
  'What is not changed: nothing is written, signed or sent; no route, no approval and no fence file is touched.',
].join('\n\n').repeat(3)
const STAGED_AT = Date.UTC(2026, 10, 15, 2, 41)
const FILES = ['packages/client/ui-layout/src/client/spatial/apps/threads/read.ts', 'packages/client/ui-layout/src/client/spatial/apps/threads/lane.tsx',
  'packages/client/ui-layout/tests/thread-honest-reads.client.spec.tsx', 'docs/auma/notes/thread-reads.md', 'apps/web/src/spatial/threads/reader.ts',
  'apps/web/src/spatial/threads/marks.ts', 'deploy/cloudflare/src/crew-relay-tool.mjs']
const proposalValue = async () => ({
  schema: 'aukora.staged-repo-proposal.v1', branch: BRANCH, title: TITLE, summary: SUMMARY,
  baseSha: sha('a'), headSha: sha('b'), treeSha: sha('c'),
  changedFiles: FILES.map(path => ({ path, status: path.includes('/tests/') ? 'added' : 'modified', additions: 4, deletions: 1, t2Protected: false })),
  ciStatus: 'passed', stagedAt: STAGED_AT, mergeBody, binding: await class3Action({ audience: ORIGIN, method: 'POST', pathname: '/_host/repo', body: mergeBody }),
})
const statusBody = (stagedRepoProposal: unknown) => ({ ok: true, ballId: 'd'.repeat(64), epoch: 176, staged: null, supersededStaged: null,
  stagedRepoProposal, lastRepoMergeOutcome: null, repoMergeAttempt: null, repoMergeReleased: null, peers: [] })
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const pathOf = (request: string | URL | Request) => (typeof request === 'string' ? request : request instanceof URL ? request.pathname
  : new URL(request.url).pathname)

/**
 * HEAD and the host as the card meets them: promotion-status holds the proposal until the merge lands (then none, as
 * head-do.mjs deletes the staged record with the succeeded outcome; `holdStaged`: a read that has not seen the delete yet);
 * `/_host/repo` answers `repo` when `repoGate` resolves.
 */
const host = async (repo: { status: number; body: unknown } = { status: 200, body: { ok: true, commitSha: sha('b') } }) => {
  const staged = statusBody(await proposalValue())
  const state = { merged: false, holdStaged: false, repoGate: null as Promise<void> | null }
  const calls: Array<{ path: string; method: string; body: unknown; headers: Record<string, string> }> = []
  const fetchImpl = vi.fn(async (request: string | URL | Request, init?: RequestInit) => {
    const path = pathOf(request)
    calls.push({ path, method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
      headers: { ...(init?.headers as Record<string, string> | undefined) } })
    if (path === '/_head/promotion-status') return json(state.merged && !state.holdStaged ? statusBody(null) : staged)
    if (path === '/_host/repo') {
      if (state.repoGate !== null) await state.repoGate
      if (repo.status === 200) state.merged = true
      return json(repo.body, repo.status)
    }
    if (path === '/_host/aumlok/status') return json({ ok: true, phase: 'BOUND', bound: true, passkeyVerified: true, nodePubkeyHex: 'ef'.repeat(32), blockers: [] })
    return json({ ok: false, code: 'NOT_FOUND' }, 404)
  })
  return { state, calls, fetchImpl: fetchImpl as unknown as typeof fetch }
}
const gate = () => {
  let open = (): void => {}
  const promise = new Promise<void>((resolve) => { open = resolve })
  return { promise, open }
}
const cardOf = async (container: HTMLElement): Promise<HTMLElement> => {
  await waitFor(() => { expect(container.querySelector('[data-sovereignty-portal="repo-proposal"] [data-repo-proposal-approve]')).not.toBeNull() })
  return container.querySelector<HTMLElement>('[data-sovereignty-portal="repo-proposal"]')!
}
const approveOf = (card: HTMLElement) => card.querySelector<HTMLButtonElement>('[data-repo-proposal-approve]')!
const lineOf = (card: HTMLElement) => card.querySelector<HTMLElement>('[data-repo-proposal-outcome]')
const rowNamed = (card: HTMLElement, title: string) => [...card.querySelectorAll<HTMLElement>('.ak-row')]
  .find(row => row.querySelector('.ak-row__title')?.textContent === title) ?? null
const before = (a: Node, b: Node) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0

describe('one clear button, the facts he approves, her long words behind a disclosure', () => {
  it('the approve control is a button labelled exactly "Approve with Touch ID", the Spatial primary action, last in the main block', async () => {
    const { fetchImpl } = await host()
    const { container } = render(<RepoProposalCell active round={0} ownerBound fetchImpl={fetchImpl} />)
    const card = await cardOf(container)
    const button = approveOf(card)
    expect(button.tagName).toBe('BUTTON')
    expect(button.type).toBe('button')
    expect(button.textContent).toBe('Approve with Touch ID')
    expect(button.disabled).toBe(false)
    // MOVED (old pin `Approve and Merge ${branch} with Touch ID` in an outlined x5-field box): the primitives' action, filled.
    expect(button.classList.contains('ak-action')).toBe(true)
    expect(button.classList.contains('ak-action--primary')).toBe(true)
    expect(button.classList.contains('x5-field')).toBe(false)
    expect(card.querySelectorAll('[data-repo-proposal-approve]')).toHaveLength(1)
    // After every fact he approves and the binding sentence; before the disclosures.
    const facts = card.querySelector('[data-repo-proposal-facts] dl.ak-fields')!
    const binding = card.querySelector('[data-repo-proposal-binding]')!
    expect(before(facts, binding)).toBe(true)
    expect(before(binding, button)).toBe(true)
    expect(before(button, card.querySelector('ul.ak-rows')!)).toBe(true)
  })

  it('with her words closed, every binding fact is on the card: branch, main moves, tree, checks, files, staged on HEAD, the sentence', async () => {
    const { fetchImpl } = await host()
    const { container } = render(<RepoProposalCell active round={0} ownerBound fetchImpl={fetchImpl} />)
    const card = await cardOf(container)
    expect(card.querySelector('[data-repo-proposal-branch]')?.textContent).toBe(BRANCH)
    expect(card.querySelector('[data-repo-proposal-move]')?.textContent).toBe(`${sha('a').slice(0, 12)} → ${sha('b').slice(0, 12)}`)
    const tree = card.querySelector<HTMLElement>('[data-repo-proposal-tree]')!
    expect(tree.textContent).toBe(sha('c').slice(0, 12))
    expect(tree.title).toBe(sha('c'))
    expect(card.querySelector('[data-repo-proposal-ci="passed"]')?.textContent).toBe('checks passed')
    expect(card.textContent).toContain('7 changed')
    expect(card.textContent).toContain(new Date(STAGED_AT).toISOString())
    expect(card.querySelector('[data-repo-proposal-binding]')?.textContent).toBe(`Touch ID approves exactly this merge, once: main moves from ${sha('a').slice(0, 12)} `
      + `to ${sha('b').slice(0, 12)}. The host merges only if main and the branch are still exactly these commits.`)
    // Her words are closed: the summary is not in the page at all, and its row says it opens.
    const says = rowNamed(card, 'What she says it does')!
    expect(says.querySelector('button.ak-row__head')?.getAttribute('aria-expanded')).toBe('false')
    expect(card.textContent).not.toContain(SUMMARY.slice(0, 60))
    expect(card.querySelector('[data-repo-proposal-summary]')).toBeNull()
    // The head's one line is unchanged.
    expect(card.querySelector('.ak-portal__summary')?.textContent).toBe(`${TITLE} · ${BRANCH} · 7 files · checks passed`)
  })

  it('opened, her title and summary are all there, never cut, and the exact commits in full', async () => {
    const { fetchImpl } = await host()
    const { container } = render(<RepoProposalCell active round={0} ownerBound fetchImpl={fetchImpl} />)
    const card = await cardOf(container)
    fireEvent.click(rowNamed(card, 'What she says it does')!.querySelector('button.ak-row__head')!)
    expect(card.querySelector('[data-repo-proposal-title]')?.textContent).toBe(TITLE)
    expect(card.querySelector('[data-repo-proposal-summary]')?.textContent).toBe(SUMMARY.trim())
    fireEvent.click(rowNamed(card, 'Exact commits')!.querySelector('button.ak-row__head')!)
    const exact = card.querySelector('[data-repo-proposal-exact]')!
    for (const value of [sha('a'), sha('b'), sha('c')]) expect(exact.textContent).toContain(value)
    // The changed files stay their own disclosure, as they were.
    fireEvent.click(rowNamed(card, 'Changed files')!.querySelector('button.ak-row__head')!)
    expect(card.querySelectorAll('[data-repo-proposal-file]')).toHaveLength(7)
  })
})

describe('a state for every step after the tap, and one tap only', () => {
  it('waiting for the fingerprint, then merging while the host has it, then merged: each said under the button; a second tap does nothing', async () => {
    const h = await host()
    const passkey = gate(), merge = gate()
    passkeyGate = passkey.promise
    h.state.repoGate = merge.promise
    const { container } = render(<RepoProposalCell active round={0} ownerBound fetchImpl={h.fetchImpl} />)
    const card = await cardOf(container)
    const button = approveOf(card)
    fireEvent.click(button)
    fireEvent.click(button)
    fireEvent.doubleClick(button)
    await waitFor(() => { expect(lineOf(card)?.getAttribute('data-repo-proposal-step')).toBe('fingerprint') })
    expect(lineOf(card)?.textContent).toBe('Waiting for Touch ID…')
    // Directly under the button, and the button cannot be pressed again.
    expect(button.nextElementSibling?.contains(lineOf(card))).toBe(true)
    expect(button.disabled).toBe(true)
    expect(button.getAttribute('aria-busy')).toBe('true')
    expect(button.textContent).toBe('Approve with Touch ID')
    expect(approvals).toHaveLength(1)
    // The fingerprint answered: the approved request is with the host, and the card says so while it merges.
    await act(async () => { passkey.open(); await Promise.resolve() })
    await waitFor(() => { expect(lineOf(card)?.getAttribute('data-repo-proposal-step')).toBe('merging') })
    expect(lineOf(card)?.textContent).toBe('Touch ID approved it. Merging: the host has the approved request and is merging it now…')
    fireEvent.click(button)
    expect(approvals).toHaveLength(1)
    await act(async () => { merge.open(); await Promise.resolve() })
    await waitFor(() => { expect(lineOf(card)?.getAttribute('data-repo-proposal-outcome')).toBe('merged') })
    expect(lineOf(card)?.textContent).toBe(`Merged: GitHub shows ${sha('b').slice(0, 12)} in main (${BRANCH}).`)
    // Exactly one approval, for exactly the terms this page computed, and exactly the approved body sent once.
    expect(approvals).toHaveLength(1)
    expect(canonicalJson(approvals[0])).toBe(canonicalJson(await class3Action({ audience: ORIGIN, method: 'POST', pathname: '/_host/repo', body: mergeBody })))
    const sent = h.calls.filter(call => call.path === '/_host/repo')
    expect(sent).toHaveLength(1)
    expect(sent[0]?.body).toEqual(mergeBody)
    expect(sent[0]?.headers['x-x6-class3-approval']).toBe('stand-in-approval')
  })

  it('merged, with the card still showing it before the next read: the button is not offered again', async () => {
    const h = await host()
    const { container } = render(<RepoProposalCell active round={0} ownerBound fetchImpl={h.fetchImpl} />)
    const card = await cardOf(container)
    // HEAD still holds it on the reads after the merge (its delete not seen yet).
    h.state.holdStaged = true
    fireEvent.click(approveOf(card))
    await waitFor(() => { expect(lineOf(card)?.getAttribute('data-repo-proposal-outcome')).toBe('merged') })
    await waitFor(() => { expect(approveOf(card).disabled).toBe(true) })
    fireEvent.click(approveOf(card))
    expect(approvals).toHaveLength(1)
  })

  it('a refusal says the host\'s words for its code, unchanged, under the button; the passkey not completing says so', async () => {
    const h = await host({ status: 409, body: { ok: false, code: 'REPO_BASE_MOVED' } })
    const { container } = render(<RepoProposalCell active round={0} ownerBound fetchImpl={h.fetchImpl} />)
    const card = await cardOf(container)
    fireEvent.click(approveOf(card))
    await waitFor(() => { expect(lineOf(card)?.getAttribute('data-repo-proposal-outcome')).toBe('refused') })
    expect(lineOf(card)?.textContent).toBe('The host refused the merge (REPO_BASE_MOVED) before sending it; this merge did not move main.')
    expect(approveOf(card).nextElementSibling?.contains(lineOf(card))).toBe(true)
    cleanup(); resetApprovalsForTests()
    passkeyRefuses = true
    const again = await host()
    const view = render(<RepoProposalCell active round={0} ownerBound fetchImpl={again.fetchImpl} />)
    const second = await cardOf(view.container)
    fireEvent.click(approveOf(second))
    await waitFor(() => { expect(lineOf(second)?.getAttribute('data-repo-proposal-outcome')).toBe('refused') })
    expect(lineOf(second)?.textContent).toBe('Not approved: class3:passkey NotAllowedError')
    expect(again.calls.some(call => call.path === '/_host/repo')).toBe(false)
  })
})

describe('once it merged, nothing counts it as waiting', () => {
  it('Sovereignty\'s header: "1 WAITING FOR TOUCH ID" while staged, "0 WAITING" once merged, with the merged line still shown', async () => {
    const h = await host()
    vi.stubGlobal('fetch', h.fetchImpl)
    const list = { ids: ['s1'], byId: { s1: { id: 's1', displayTitle: 'Test', running: false, retainedBy: { mainView: 1 }, blank: false, updatedAt: 1 } },
      phase: 'ready', projectionsBySession: {} } as unknown as SessionListState
    const reader = { whole: async () => ({ ok: false, reason: 'not-found' }) }
    const useSessions = bindSnapshotSelector(createSnapshotStore<SessionListState>(list))
    const props = { activeSurface: SOVEREIGNTY_SURFACE, useSessions, reader } as unknown as Parameters<typeof SovereigntySurface>[0]
    const { container } = render(<SovereigntySurface {...props} />)
    await waitFor(() => { expect(container.textContent).toContain('1 WAITING FOR TOUCH ID') }, { timeout: 10_000 })
    const card = await cardOf(container)
    await waitFor(() => { expect(approveOf(card).disabled).toBe(false) }, { timeout: 10_000 })
    fireEvent.click(approveOf(card))
    await waitFor(() => { expect(container.querySelector('[data-repo-proposal-outcome="merged"]')).not.toBeNull() }, { timeout: 10_000 })
    await waitFor(() => { expect(container.textContent).not.toContain('WAITING FOR TOUCH ID') }, { timeout: 10_000 })
    expect(container.textContent).toContain('0 WAITING')
    expect(container.textContent).not.toContain('Waiting for your Touch ID')
    expect(container.querySelector('[data-repo-proposal-outcome="merged"]')?.textContent).toBe(`Merged: GitHub shows ${sha('b').slice(0, 12)} in main (${BRANCH}).`)
  }, 30_000)

  it('Notices: the merge row goes as soon as the card on this page merged it, with no push from the host and no poll', async () => {
    const h = await host()
    const { container } = render(
      <>
        <ApprovalWaiting openSovereignty={() => {}} fetchImpl={h.fetchImpl} />
        <RepoProposalCell active round={0} ownerBound fetchImpl={h.fetchImpl} />
      </>,
    )
    await waitFor(() => { expect(currentNotices().map(notice => notice.kind)).toEqual(['merge']) })
    const card = await cardOf(container)
    fireEvent.click(approveOf(card))
    await waitFor(() => { expect(lineOf(card)?.getAttribute('data-repo-proposal-outcome')).toBe('merged') })
    await waitFor(() => { expect(currentNotices().map(notice => notice.kind)).toEqual([]) })
  })

  it('a card that cannot be read or is still staged keeps counting: the waiting report follows the card, not its visibility', async () => {
    const h = await host()
    const shown: boolean[] = [], waiting: boolean[] = []
    render(<RepoProposalCell active round={0} ownerBound fetchImpl={h.fetchImpl} onShown={(value) => { shown.push(value) }}
      onWaiting={(value) => { waiting.push(value) }} />)
    await waitFor(() => { expect(waiting.at(-1)).toBe(true) })
    expect(shown.at(-1)).toBe(true)
  })
})
