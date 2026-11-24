// @vitest-environment jsdom
/**
 * MUST 4: a merge HEAD holds as unknown past its margin shows one sentence and one
 * "Release with Touch ID" control on the repo proposal card; the release asks the passkey for exactly
 * { action: 'release_attempt', attemptId, baseSha, headSha } and sends exactly that. A card read that finds a held or
 * released merge asks the host to reconcile from GitHub first, and says merged when it landed.
 * The passkey ceremony itself (approveClass3) is stood in for here; class3-approval's own specs and the real Worker run
 * in r29-edge-e2e.client.spec.tsx cover it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { canonicalJson, class3Action, type Class3Action } from '../src/client/spatial/aumlok/class3-approval.ts'

const approvals: Class3Action[] = []
vi.mock('../src/client/spatial/aumlok/class3-approval.ts', async (original) => {
  const real = await original<typeof import('../src/client/spatial/aumlok/class3-approval.ts')>()
  return { ...real, approveClass3: async (action: Class3Action) => {
    approvals.push(action)
    return { ok: true, token: 'stand-in-approval', expiresAt: Date.now() + 60_000, action, hostRemainingMs: 60_000, receivedAt: 0 }
  } }
})
const { HELD_ATTEMPT_WORDS, approveAndRelease, durableLanding, heldAttemptOf, needsReconcile, shownAttemptIds } = await import('../src/client/spatial/aumlok/repo-proposal.ts')
const { RepoProposalCell } = await import('../src/client/spatial/portal/RepoProposalCell.tsx')
const { resetApprovalsForTests } = await import('../src/client/spatial/portal/touch-id-timing.ts')

class FakeChannel { onmessage = null; close() {} }
class FakeSocket { onopen = null; onmessage = null; onclose = null; close() {} }
beforeEach(() => { vi.stubGlobal('BroadcastChannel', FakeChannel); vi.stubGlobal('WebSocket', FakeSocket); approvals.length = 0 })
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); resetApprovalsForTests() })

const ORIGIN = 'http://localhost:3000'
const sha = (c: string) => c.repeat(40)
const ATTEMPT_ID = '0f0e0d0c-0b0a-4908-8706-050403020100', OTHER_ID = '1f1e1d1c-1b1a-4918-8716-151413121110'
const mergeBody = { action: 'merge_proposal', baseSha: sha('a'), branch: 'auma/proposal/fix-receipts-signer-policy', headSha: sha('b'), treeSha: sha('c') }
const proposalValue = async () => ({
  schema: 'aukora.staged-repo-proposal.v1', branch: mergeBody.branch, title: 'Enforce the checkpoint signer policy', summary: null,
  baseSha: sha('a'), headSha: sha('b'), treeSha: sha('c'),
  changedFiles: [{ path: 'deploy/cloudflare/src/crew-relay-tool.mjs', status: 'modified', additions: 1, deletions: 1, t2Protected: false }],
  ciStatus: 'passed', stagedAt: Date.UTC(2026, 10, 13, 2), mergeBody, binding: await class3Action({ audience: ORIGIN, method: 'POST', pathname: '/_host/repo', body: mergeBody }),
})
const attempt = (over: Record<string, unknown> = {}) => ({ attemptId: ATTEMPT_ID, status: 'unknown', state: 'dispatched', branch: mergeBody.branch,
  baseSha: sha('a'), headSha: sha('b'), startedAt: Date.now() - 120_000, ageMs: 120_000, reconcileAfterMs: 60_000, ...over })
const statusBody = async (over: Record<string, unknown> = {}) => ({ ok: true, ballId: 'd'.repeat(64), epoch: 167, staged: null, supersededStaged: null,
  stagedRepoProposal: await proposalValue(), lastRepoMergeOutcome: null, repoMergeAttempt: null, repoMergeReleased: null, peers: [],
  ...over })
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** The host: promotion-status answers in turn (the last repeats), /_host/estate and /_host/repo answer as given. */
const host = (statuses: unknown[], answers: { estate?: unknown; repo?: unknown } = {}) => {
  const calls: Array<{ url: string; method: string; body: unknown; headers: Record<string, string> }> = []
  let index = 0
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? JSON.parse(init.body) : null, headers: { ...(init?.headers as Record<string, string> | undefined) } })
    if (url === '/_head/promotion-status') { const body = statuses[Math.min(index, statuses.length - 1)]; index += 1; return json(body) }
    if (url === '/_host/estate' && answers.estate !== undefined) return json(answers.estate)
    if (url === '/_host/repo' && answers.repo !== undefined) return json(answers.repo)
    return json({ ok: false, code: 'NOT_FOUND' }, 404)
  }) as unknown as typeof fetch
  return { calls, fetchImpl }
}
const ceremony = { platform: { passkeyBlocker: () => null, passkey: vi.fn(), nodeKeys: async () => true } } as unknown as NonNullable<Parameters<typeof RepoProposalCell>[0]['ceremony']>
const openCard = async (container: HTMLElement) => {
  await waitFor(() => { expect(container.querySelector('[data-sovereignty-portal="repo-proposal"]')).not.toBeNull() })
  return container.querySelector('[data-sovereignty-portal="repo-proposal"]') as HTMLElement
}

describe('a merge held past its margin', () => {
  it('reads as held only when marked or dispatched and past its margin; a held or released merge asks for a reconcile', () => {
    const body = (over: Record<string, unknown>) => ({ ok: true, repoMergeAttempt: attempt(over) })
    expect(heldAttemptOf(body({}))).toEqual({ attemptId: ATTEMPT_ID, baseSha: sha('a'), headSha: sha('b'), state: 'dispatched' })
    expect(heldAttemptOf(body({ state: 'marked', status: 'pending' }))).not.toBeNull()
    expect(heldAttemptOf(body({ state: 'claimed', status: 'pending' }))).toBeNull()
    expect(heldAttemptOf(body({ ageMs: 30_000 }))).toBeNull()
    expect(heldAttemptOf({ ok: true, repoMergeAttempt: null })).toBeNull()
    expect(needsReconcile(body({}))).toBe(true)
    expect(needsReconcile(body({ ageMs: 30_000 }))).toBe(false)
    expect(needsReconcile({ ok: true, repoMergeAttempt: null, repoMergeReleased: { state: 'void-by-owner' } })).toBe(true)
    expect(needsReconcile({ ok: true, repoMergeAttempt: null, repoMergeReleased: { state: 'merged-after-release' } })).toBe(false)
    // Review, MUST 2: any kept release still unresolved asks for a reconcile, not only the newest.
    const release = (attemptId: string, state: string) => ({ attemptId, branch: mergeBody.branch, baseSha: sha('a'), headSha: sha('b'), treeSha: sha('c'), releasedAt: 1, state })
    expect(needsReconcile({ ok: true, repoMergeAttempt: null, repoMergeReleased: release(OTHER_ID, 'merged-after-release'),
      repoMergeReleases: [release(ATTEMPT_ID, 'void-by-owner'), release(OTHER_ID, 'merged-after-release')] })).toBe(true)
  })

  it('shows the sentence and the Release control; the release asks the passkey for exactly its own terms and sends exactly them', async () => {
    const held = await statusBody({ repoMergeAttempt: attempt() })
    const released = await statusBody()
    const unknown = { ok: true, reconciled: false, outcome: { status: 'unknown', code: 'REPO_REF_OUTCOME_UNKNOWN' }, mainSha: sha('e') }
    const { calls, fetchImpl } = host([held, held, released], { estate: unknown,
      repo: { ok: true, reconciled: true, outcome: { status: 'failed', code: 'REPO_ATTEMPT_VOID_BY_OWNER', state: 'void-by-owner' }, action: 'release_attempt' } })
    const { container } = render(<RepoProposalCell active round={0} ownerBound fetchImpl={fetchImpl} ceremony={ceremony} />)
    const card = await openCard(container)
    await waitFor(() => { expect(card.querySelector('[data-repo-proposal-held]')?.textContent).toBe(HELD_ATTEMPT_WORDS.dispatched) })
    // The read asked the host to reconcile first (GitHub read again), then read the status again.
    expect(calls.slice(0, 3).map(call => `${call.method} ${call.url}`)).toEqual(['GET /_head/promotion-status', 'POST /_host/estate', 'GET /_head/promotion-status'])
    expect(calls[1]?.body).toEqual({ action: 'reconcile_proposal' })
    const button = card.querySelector<HTMLButtonElement>('[data-repo-proposal-release]')
    expect(button?.textContent).toBe('Release with Touch ID')
    fireEvent.click(button as HTMLButtonElement)
    await waitFor(() => { expect(container.querySelector('[data-repo-proposal-outcome]')?.getAttribute('data-repo-proposal-outcome')).toBe('released') })
    expect(container.querySelector('[data-repo-proposal-outcome]')?.textContent).toMatch(/^Released: the earlier merge is void by your hand/u)
    const terms = { action: 'release_attempt', attemptId: ATTEMPT_ID, baseSha: sha('a'), headSha: sha('b') }
    expect(approvals).toHaveLength(1)
    expect(canonicalJson(approvals[0])).toBe(canonicalJson(await class3Action({ audience: globalThis.location.origin, method: 'POST', pathname: '/_host/repo', body: terms })))
    const sent = calls.filter(call => call.url === '/_host/repo')
    expect(sent).toHaveLength(1)
    expect(sent[0]?.body).toEqual(terms)
    expect(Object.keys(sent[0]?.body as object)).toHaveLength(4)
    expect(sent[0]?.headers['x-x6-class3-approval']).toBe('stand-in-approval')
    // The next read holds nothing: the sentence and the control are gone, the approve button stays.
    await waitFor(() => { expect(container.querySelector('[data-repo-proposal-held]')).toBeNull() })
    expect(container.querySelector('[data-repo-proposal-approve]')).not.toBeNull()
  })

  it('a merge he released that GitHub now shows in main: the card\'s next read says merged, never void', async () => {
    const record = (state: string) => ({ attemptId: ATTEMPT_ID, branch: mergeBody.branch, baseSha: sha('a'), headSha: sha('b'), treeSha: sha('c'), releasedAt: 1, state,
      ...(state === 'merged-after-release' ? { mergedSeenAt: 2 } : {}) })
    const released = await statusBody({ repoMergeReleased: record('void-by-owner'), repoMergeReleases: [record('void-by-owner')] })
    // Review, MUST 3: the words come from HEAD's durable status after the reconcile, not from its answer.
    const after = { ...await statusBody(), stagedRepoProposal: null, repoMergeReleased: record('merged-after-release'), repoMergeReleases: [record('merged-after-release')] }
    const { calls, fetchImpl } = host([released, after], { estate: { ok: true, reconciled: false, action: 'reconcile_proposal' } })
    const { container } = render(<RepoProposalCell active round={0} ownerBound fetchImpl={fetchImpl} ceremony={ceremony} />)
    await waitFor(() => { expect(container.querySelector('[data-repo-proposal-outcome="merged"]')?.textContent).toBe(`Merged after all: GitHub now shows ${sha('b').slice(0, 12)} in main, the merge you released.`) })
    expect(calls.filter(call => call.url === '/_host/estate')).toHaveLength(1)
    expect(approvals).toHaveLength(0)
  })

  it('nothing held and nothing released: the read asks GitHub nothing and no Release control shows', async () => {
    const { calls, fetchImpl } = host([await statusBody({ repoMergeAttempt: attempt({ ageMs: 1_000 }) })])
    const { container } = render(<RepoProposalCell active round={0} ownerBound fetchImpl={fetchImpl} ceremony={ceremony} />)
    const card = await openCard(container)
    await waitFor(() => { expect(card.querySelector('[data-repo-proposal-approve]')).not.toBeNull() })
    expect(card.querySelector('[data-repo-proposal-release]')).toBeNull()
    expect(calls.every(call => call.url === '/_head/promotion-status')).toBe(true)
  })
})

describe('"merged after release" comes from the durable status, matched to the attempt the card shows', () => {
  const record = (attemptId: string, state: string) => ({ attemptId, branch: mergeBody.branch, baseSha: sha('a'), headSha: sha('b'), treeSha: sha('c'), releasedAt: 1, state,
    ...(state === 'merged-after-release' ? { mergedSeenAt: 2 } : {}) })
  /** Release a held attempt on a card; `then` are the statuses after it; `estate` answers each reconcile. */
  const releaseThen = async (then: unknown[], estate: unknown) => {
    const held = await statusBody({ repoMergeAttempt: attempt() })
    const { calls, fetchImpl } = host([held, held, ...then], { estate,
      repo: { ok: true, reconciled: true, outcome: { status: 'failed', code: 'REPO_ATTEMPT_VOID_BY_OWNER', state: 'void-by-owner' }, action: 'release_attempt' } })
    const view = render(<RepoProposalCell active round={0} ownerBound fetchImpl={fetchImpl} ceremony={ceremony} />)
    const card = await openCard(view.container)
    await waitFor(() => { expect(card.querySelector('[data-repo-proposal-release]')).not.toBeNull() })
    fireEvent.click(card.querySelector('[data-repo-proposal-release]') as HTMLButtonElement)
    await waitFor(() => { expect(view.container.querySelector('[data-repo-proposal-outcome]')?.getAttribute('data-repo-proposal-outcome')).toBe('released') })
    return { calls, view }
  }
  const mergedAfterAll = `Merged after all: GitHub now shows ${sha('b').slice(0, 12)} in main, the merge you released.`
  const landedStatus = async () => ({ ...await statusBody({ repoMergeReleased: record(ATTEMPT_ID, 'merged-after-release'), repoMergeReleases: [record(ATTEMPT_ID, 'merged-after-release')],
    lastRepoMergeOutcome: { attemptId: ATTEMPT_ID, status: 'succeeded', at: 3, branch: mergeBody.branch, baseSha: sha('a'), headSha: sha('b'), treeSha: sha('c'), commitSha: sha('b') } }), stagedRepoProposal: null })

  it('another tab reconciled it: the read after this card\'s release already says merged, nothing is left to reconcile, and the card says merged, never "Released"', async () => {
    // His example: stagedRepoProposal null, the release merged-after-release, the last outcome succeeded; needsReconcile is false.
    const landed = await landedStatus()
    expect(needsReconcile(landed)).toBe(false)
    const { calls, view } = await releaseThen([landed], { ok: true, reconciled: false, action: 'reconcile_proposal' })
    await waitFor(() => { expect(view.container.querySelector('[data-repo-proposal-outcome]')?.textContent).toBe(mergedAfterAll) })
    expect(view.container.querySelector('[data-repo-proposal-outcome]')?.getAttribute('data-repo-proposal-outcome')).toBe('merged')
    const afterRelease = calls.slice(calls.findIndex(call => call.url === '/_host/repo') + 1)
    expect(afterRelease.some(call => call.url === '/_host/estate'), 'this card reconciled nothing after its release').toBe(false)
  })

  it('this card\'s reconcile answer was lost: the status read after it says merged, so the card does', async () => {
    const releasedStill = await statusBody({ repoMergeReleased: record(ATTEMPT_ID, 'void-by-owner'), repoMergeReleases: [record(ATTEMPT_ID, 'void-by-owner')] })
    const { calls, view } = await releaseThen([releasedStill, await landedStatus()], { ok: false, code: 'LOST' })
    await waitFor(() => { expect(view.container.querySelector('[data-repo-proposal-outcome]')?.textContent).toBe(mergedAfterAll) })
    const afterRelease = calls.slice(calls.findIndex(call => call.url === '/_host/repo') + 1)
    expect(afterRelease.map(call => `${call.method} ${call.url}`)).toEqual(['GET /_head/promotion-status', 'POST /_host/estate', 'GET /_head/promotion-status'])
  })

  it('the match is by attempt: another attempt\'s merged release or outcome never stands for the one shown; the staged proposal\'s own releases are shown', async () => {
    const landed = { ok: true, repoMergeReleases: [record(OTHER_ID, 'merged-after-release')],
      lastRepoMergeOutcome: { attemptId: OTHER_ID, status: 'succeeded', commitSha: sha('b') } }
    expect(durableLanding(landed, [ATTEMPT_ID])).toBeNull()
    expect(durableLanding(landed, [OTHER_ID])).toEqual({ attemptId: OTHER_ID, text: mergedAfterAll })
    expect(durableLanding({ ok: true, repoMergeReleases: [], lastRepoMergeOutcome: { attemptId: ATTEMPT_ID, status: 'succeeded', commitSha: sha('b') } }, [ATTEMPT_ID]))
      .toEqual({ attemptId: ATTEMPT_ID, text: `Merged: GitHub shows ${sha('b').slice(0, 12)} in main, the merge approved earlier.` })
    expect(durableLanding({ ok: true, repoMergeReleases: [record(ATTEMPT_ID, 'void-by-owner')] }, [ATTEMPT_ID])).toBeNull()
    // Shown: the held attempt, and a release of the very proposal staged (not one of another proposal).
    const staged = await statusBody({ repoMergeAttempt: attempt({ attemptId: OTHER_ID }),
      repoMergeReleases: [record(ATTEMPT_ID, 'void-by-owner'), { ...record('2f2e2d2c-2b2a-4928-8726-252423222120', 'void-by-owner'), headSha: sha('e') }] })
    expect(shownAttemptIds(staged)).toEqual([OTHER_ID, ATTEMPT_ID])
  })
})

describe('every sentence about main or about sending says only what its broker field established', () => {
  it('held: "was sent" only for dispatched; "may have been sent" for marked; never "does not show it in main"', async () => {
    const tail = ', and GitHub has not confirmed it in main; it may still land. '
    expect(HELD_ATTEMPT_WORDS.dispatched.startsWith(`A merge approved earlier was sent${tail}`)).toBe(true)
    expect(HELD_ATTEMPT_WORDS.marked.startsWith(`A merge approved earlier may have been sent${tail}`)).toBe(true)
    for (const words of Object.values(HELD_ATTEMPT_WORDS)) expect(words).not.toMatch(/does not show|main is now/u)
    // The card shows the sentence of HEAD's state.
    const { fetchImpl } = host([await statusBody({ repoMergeAttempt: attempt({ state: 'marked', status: 'pending' }) })], { estate: { ok: true, reconciled: false } })
    const { container } = render(<RepoProposalCell active round={0} ownerBound fetchImpl={fetchImpl} ceremony={ceremony} />)
    const card = await openCard(container)
    await waitFor(() => { expect(card.querySelector('[data-repo-proposal-held]')?.textContent).toBe(HELD_ATTEMPT_WORDS.marked) })
  })

  it('a release: void-by-owner, merged, the bound and an unclear answer each say only their own field', async () => {
    const held = { attemptId: ATTEMPT_ID, baseSha: sha('a'), headSha: sha('b'), state: 'dispatched' as const }
    const answer = async (status: number, body: unknown) => {
      const fetchImpl = (async () => json(body, status)) as unknown as typeof fetch
      return await approveAndRelease(held, { ...ceremony, signal: new AbortController().signal }, fetchImpl)
    }
    expect(await answer(200, { ok: true, outcome: { state: 'void-by-owner' } })).toEqual({ kind: 'released',
      text: 'Released: the earlier merge is void by your hand, and a new merge can begin. If GitHub later shows it in main, the next read records it as merged.' })
    expect(await answer(200, { ok: true, outcome: { state: 'merged' } })).toEqual({ kind: 'merged',
      text: `Not released: GitHub already shows ${sha('b').slice(0, 12)} in main, so it is merged, and no approval was spent.` })
    expect(await answer(409, { ok: false, code: 'REPO_RELEASE_LIMIT', limit: 4, unresolved: 4 })).toEqual({ kind: 'refused',
      text: 'Not released: 4 merges you released earlier are all still unresolved (GitHub has not shown them in main), and the host keeps every one until it does, so none is forgotten. '
        + 'This merge stays held until one of them shows up in main; your approval was not used.' })
    expect(await answer(503, { ok: false, code: 'REPO_PROPOSAL_STORAGE_FAILED' })).toEqual({ kind: 'unclear', text: 'Not released: the host answered 503 REPO_PROPOSAL_STORAGE_FAILED.' })
  })
})

describe('At the bound the owner has a passkey-bound way out', () => {
  const OLDEST = { attemptId: OTHER_ID, branch: 'auma/proposal/old-receipts', headSha: sha('e') }
  const held = { attemptId: ATTEMPT_ID, baseSha: sha('a'), headSha: sha('b'), state: 'dispatched' as const }
  const limit = { ok: false, code: 'REPO_RELEASE_LIMIT', limit: 4, unresolved: 4, oldest: OLDEST }
  const forgetWords = 'Not released: 4 merges you released earlier are all still unresolved (GitHub has not shown them in main), and the host keeps every one until it does. '
    + `This merge stays held; your approval was not used. To release it anyway, release it and forget the oldest one, ${sha('e').slice(0, 12)} on auma/proposal/old-receipts: `
    + 'the host then stops checking whether that one lands.'

  it('the refusal names the oldest release; a release that forgets it asks the passkey for terms that name it, and sends exactly them', async () => {
    const answers = [json(limit, 409), json({ ok: true, outcome: { state: 'void-by-owner' } })], sent: unknown[] = []
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      sent.push(typeof init?.body === 'string' ? JSON.parse(init.body) : null)
      return answers.shift() as Response
    }) as unknown as typeof fetch
    const deps = { ...ceremony, signal: new AbortController().signal }
    const first = await approveAndRelease(held, deps, fetchImpl)
    expect(first).toEqual({ kind: 'refused', text: forgetWords, forget: OLDEST })
    const second = await approveAndRelease(held, deps, fetchImpl, OLDEST)
    expect(second.kind).toBe('released')
    const terms = { action: 'release_attempt', attemptId: ATTEMPT_ID, baseSha: sha('a'), headSha: sha('b'), forgets: OTHER_ID }
    expect(sent[1]).toEqual(terms)
    expect(canonicalJson(approvals[1])).toBe(canonicalJson(await class3Action({ audience: globalThis.location.origin, method: 'POST', pathname: '/_host/repo', body: terms })))
  })

  it('the kept releases changed meanwhile: says so, nothing forgotten, approval unused', async () => {
    const fetchImpl = (async () => json({ ok: false, code: 'REPO_RELEASE_FORGET_STALE', limit: 4 }, 409)) as unknown as typeof fetch
    expect(await approveAndRelease(held, { ...ceremony, signal: new AbortController().signal }, fetchImpl, OLDEST)).toEqual({ kind: 'refused',
      text: 'Not released: the releases the host keeps changed since this card read them, so nothing was forgotten and your approval was not used. Release again to read them anew.' })
  })

  it('on the card: after the refusal a second control releases and forgets the oldest, with Touch ID, over terms that name it', async () => {
    const heldStatus = await statusBody({ repoMergeAttempt: attempt() })
    const repoAnswers = [json(limit, 409), json({ ok: true, reconciled: true, outcome: { status: 'failed', code: 'REPO_ATTEMPT_VOID_BY_OWNER', state: 'void-by-owner' } })]
    const calls: Array<{ url: string; body: unknown }> = []
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ url, body: typeof init?.body === 'string' ? JSON.parse(init.body) : null })
      if (url === '/_head/promotion-status') return json(heldStatus)
      if (url === '/_host/estate') return json({ ok: true, reconciled: false })
      if (url === '/_host/repo') return repoAnswers.shift() as Response
      return json({ ok: false }, 404)
    }) as unknown as typeof fetch
    const { container } = render(<RepoProposalCell active round={0} ownerBound fetchImpl={fetchImpl} ceremony={ceremony} />)
    const card = await openCard(container)
    await waitFor(() => { expect(card.querySelector('[data-repo-proposal-release]')).not.toBeNull() })
    expect(card.querySelector('[data-repo-proposal-release-forget]')).toBeNull()
    fireEvent.click(card.querySelector('[data-repo-proposal-release]') as HTMLButtonElement)
    await waitFor(() => { expect(container.querySelector('[data-repo-proposal-outcome]')?.textContent).toBe(forgetWords) })
    await waitFor(() => { expect(container.querySelector('[data-repo-proposal-release-forget]')).not.toBeNull() })
    const forget = container.querySelector<HTMLButtonElement>('[data-repo-proposal-release-forget]') as HTMLButtonElement
    expect(forget.textContent).toBe(`Release and forget ${sha('e').slice(0, 12)} with Touch ID`)
    fireEvent.click(forget)
    await waitFor(() => { expect(container.querySelector('[data-repo-proposal-outcome]')?.getAttribute('data-repo-proposal-outcome')).toBe('released') })
    const sent = calls.filter(call => call.url === '/_host/repo').map(call => call.body)
    expect(sent).toEqual([{ action: 'release_attempt', attemptId: ATTEMPT_ID, baseSha: sha('a'), headSha: sha('b') },
      { action: 'release_attempt', attemptId: ATTEMPT_ID, baseSha: sha('a'), headSha: sha('b'), forgets: OTHER_ID }])
    expect(approvals).toHaveLength(2)
  })
})
