// @vitest-environment jsdom
/**
 * Wave 4, Lane B: the repo proposal card (Wall 2), the "Approval waiting" pill on the outer chrome, the live events they
 * listen for, and Auma Live's voice fences (a cancelled request never runs; a spoken turn is journaled as voice).
 * The run through the real Worker and a real passkey ceremony is in r29-edge-e2e.client.spec.tsx ("Wave 4").
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  AUMA_PROPOSAL_BRANCH, parseRepoProposal, readPromotionStatus, repoProposalOf, repoProposalProblems, touchesWorkflows, type RepoProposal,
} from '../src/client/spatial/aumlok/repo-proposal.ts'
import { canonicalJson, class3Action } from '../src/client/spatial/aumlok/class3-approval.ts'
import { RepoProposalCell } from '../src/client/spatial/portal/RepoProposalCell.tsx'
import { ApprovalWaiting, readWaiting, waitingWords } from '../src/client/spatial/portal/ApprovalWaiting.tsx'
import { parseLiveMessage } from '../src/client/spatial/work/autonomy.ts'
import { resetApprovalsForTests } from '../src/client/spatial/portal/touch-id-timing.ts'

/** The card's check is older than FRESH_CHECK_MS, so the click checks again first (Safari's fast path does not apply). */
const ageCards = (): void => { const real = Date.now.bind(Date); vi.spyOn(Date, 'now').mockImplementation(() => real() + 31_000) }


/** Open a portal card (approval cards now draw open: a click on an open one would close it). */
const openHead = (head: Element | null | undefined): void => { if (head instanceof HTMLButtonElement && head.getAttribute('aria-expanded') !== 'true') fireEvent.click(head) }


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
// The page's live hub is one per page and outlives a test by a second: pushes go to every socket still open.
beforeEach(() => { vi.stubGlobal('BroadcastChannel', FakeChannel); vi.stubGlobal('WebSocket', FakeSocket) })
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); resetApprovalsForTests() })

const ORIGIN = 'http://localhost:3000'
const sha = (c: string) => c.repeat(40)
const mergeBody = { action: 'merge_proposal', baseSha: sha('a'), branch: 'auma/proposal/fix-receipts-signer-policy', headSha: sha('b'), treeSha: sha('c') }
const proposalValue = async (over: Record<string, unknown> = {}) => {
  const body = (over.mergeBody as typeof mergeBody | undefined) ?? mergeBody
  return {
    schema: 'aukora.staged-repo-proposal.v1', branch: mergeBody.branch, title: 'Enforce the checkpoint signer policy', summary: 'Ports the fixture rule.',
    baseSha: sha('a'), headSha: sha('b'), treeSha: sha('c'),
    changedFiles: [
      { path: 'mirror/home/auma/seed/organs/seed-receipts.js', status: 'modified', additions: 10, deletions: 2, t2Protected: true },
      { path: 'server/aura.test.mjs', status: 'modified', additions: 3, deletions: 0, t2Protected: false },
    ],
    ciStatus: 'passed', stagedAt: Date.UTC(2026, 10, 11, 4), mergeBody: body,
    binding: await class3Action({ audience: ORIGIN, method: 'POST', pathname: '/_host/repo', body }),
    ...over,
  }
}
const statusBody = (stagedRepoProposal: unknown, staged: unknown = null) => ({ ok: true, ballId: 'd'.repeat(64), epoch: 167, staged, supersededStaged: null,
  stagedRepoProposal, lastPublishOutcome: null, peers: [] })
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('Wall 2: a repo proposal is offered only when the page computed the same passkey terms HEAD recorded', () => {
  it('reads the contract\'s shape exactly, and checks out when every part agrees', async () => {
    const proposal = parseRepoProposal(await proposalValue())
    expect(proposal).toMatchObject({ branch: mergeBody.branch, ciStatus: 'passed', changedFiles: [{ t2Protected: true }, { t2Protected: false }] })
    const { problems, terms } = await repoProposalProblems(proposal as RepoProposal, ORIGIN)
    expect(problems).toEqual([])
    expect(terms).toEqual(await class3Action({ audience: ORIGIN, method: 'POST', pathname: '/_host/repo', body: mergeBody }))
    expect(AUMA_PROPOSAL_BRANCH.test('auma/sandbox/x1')).toBe(false)
  })

  it('anything not exactly the contract is not a proposal', async () => {
    const base = await proposalValue()
    for (const bad of [
      { ...base, schema: 'aukora.staged-repo-proposal.v2' }, { ...base, headSha: 'B'.repeat(40) }, { ...base, title: ' ' }, { ...base, ciStatus: 'green' },
      { ...base, mergeBody: { ...mergeBody, extra: 1 } }, { ...base, mergeBody: { ...mergeBody, action: 'merge' } },
      { ...base, binding: { ...base.binding, method: 'PUT' } }, { ...base, binding: { ...base.binding, schema: 'aukora.class3.head-promotion.v1' } },
      { ...base, binding: { ...base.binding, extra: 1 } }, { ...base, changedFiles: [{ path: '', status: 'added' }] }, null, 7,
    ]) expect(parseRepoProposal(bad), JSON.stringify(bad).slice(0, 80)).toBeNull()
  })

  it('no passkey for terms that differ, another origin, a request naming other commits, a non-proposal branch, or .github', async () => {
    const problemsOf = async (value: Record<string, unknown>) =>
      (await repoProposalProblems(parseRepoProposal(value) as RepoProposal, ORIGIN)).problems
    const base = await proposalValue()
    expect(await problemsOf({ ...base, binding: { ...base.binding, bodySha256: 'e'.repeat(64) } }))
      .toEqual(['the passkey terms HEAD recorded are not the hash of the merge request it serves, so nothing is asked'])
    expect((await problemsOf({ ...base, binding: { ...base.binding, audience: 'https://evil.example' } })).join(' | '))
      .toContain('its passkey terms are for https://evil.example, not this page')
    expect((await problemsOf({ ...base, binding: { ...base.binding, pathname: '/_host/github' } })).join(' | ')).toContain('not /_host/repo')
    // The request names another head than the proposal shows (terms computed over that request still "match" it).
    const moved = { ...mergeBody, headSha: sha('f') }
    expect(await problemsOf(await proposalValue({ mergeBody: moved }))).toEqual(['the merge request names other commits than the proposal it is shown with'])
    const sandbox = { ...mergeBody, branch: 'auma/sandbox/x' }
    expect((await problemsOf(await proposalValue({ branch: 'auma/sandbox/x', mergeBody: sandbox }))).join(' | ')).toContain('not one of her proposal branches')
    for (const path of ['.github/workflows/evil.yml', 'docs/../.github/workflows/ci.yml', './.GITHUB/actions/x.yml', 'a/./../.github/x']) {
      expect(touchesWorkflows(path), path).toBe(true)
      expect((await problemsOf({ ...base, changedFiles: [{ path, status: 'added' }] })).join(' | ')).toContain('under .github/')
    }
    expect(touchesWorkflows('docs/github-notes.md')).toBe(false)
  })

  it('reads promotion-status: none, staged, malformed, a host without the field or the route, and a failed read', async () => {
    const value = await proposalValue()
    expect(repoProposalOf(statusBody(null))).toEqual({ kind: 'none' })
    expect(repoProposalOf(statusBody(value))).toMatchObject({ kind: 'staged', canonical: canonicalJson(parseRepoProposal(value)) })
    expect(repoProposalOf(statusBody({ schema: 'x' }))).toEqual({ kind: 'malformed' })
    expect(repoProposalOf({ ok: true, staged: null })).toEqual({ kind: 'absent' })
    const signal = new AbortController().signal
    expect(await readPromotionStatus(signal, async () => json({ ok: false }, 404))).toEqual({ repo: { kind: 'absent' }, pearlStaged: null })
    expect(await readPromotionStatus(signal, async () => json({ ok: false }, 503))).toEqual({ repo: { kind: 'unread', why: 'it answered 503' }, pearlStaged: null })
    expect(await readPromotionStatus(signal, async () => json(statusBody(null, { ballId: 'e'.repeat(64) })))).toEqual({ repo: { kind: 'none' }, pearlStaged: true })
  })
})

/** Open the card (it draws closed, as every portal card does) and every fold in it. */
const openCard = async (container: HTMLElement) => {
  await waitFor(() => { expect(container.querySelector('[data-sovereignty-portal="repo-proposal"]')).not.toBeNull() })
  const card = container.querySelector('[data-sovereignty-portal="repo-proposal"]') as HTMLElement
  openHead(card.querySelector('button.ak-portal__head'))
  for (const head of card.querySelectorAll<HTMLButtonElement>('.ak-row button, button.ak-row__head')) fireEvent.click(head)
  return card
}
const cellFetch = (bodies: unknown[]) => {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = []
  let index = 0
  return { calls, fetchImpl: (async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    if (url === '/_head/promotion-status') { const body = bodies[Math.min(index, bodies.length - 1)]; index += 1; return json(body) }
    return json({ ok: false, code: 'NOT_FOUND' }, 404)
  }) as unknown as typeof fetch }
}

describe('the repo proposal card', () => {
  it('shows the branch, the commits, CI and every changed file with its T2 mark, and offers Touch ID when checked', async () => {
    const { fetchImpl } = cellFetch([statusBody(await proposalValue())])
    const { container } = render(<RepoProposalCell active round={0} ownerBound fetchImpl={fetchImpl} />)
    const card = await openCard(container)
    expect(card.textContent).toContain('Enforce the checkpoint signer policy · auma/proposal/fix-receipts-signer-policy · 2 files · CI passed')
    expect(card.querySelector('[data-repo-proposal-move]')?.textContent).toBe(`${sha('a').slice(0, 12)} → ${sha('b').slice(0, 12)}`)
    expect(card.textContent).toContain('2 changed, 1 of them protected (T2)')
    expect(card.querySelector('[data-repo-proposal-file="mirror/home/auma/seed/organs/seed-receipts.js"]')?.textContent)
      .toBe('T2 · modified mirror/home/auma/seed/organs/seed-receipts.js +10 −2')
    expect(card.querySelector<HTMLButtonElement>('[data-repo-proposal-approve]')?.disabled).toBe(false)
    expect(card.querySelector('[data-repo-proposal-ci-warning]')).toBeNull()
    expect(container.querySelector('[role="dialog"]')).toBeNull()
  })

  it('warns plainly when CI did not pass, and offers nothing when the checks fail', async () => {
    for (const [ciStatus, words] of [['failed', 'CI FAILED on this exact commit'], ['pending', 'CI has not finished'], ['none', 'No CI ran']] as const) {
      cleanup()
      const { fetchImpl } = cellFetch([statusBody(await proposalValue({ ciStatus }))])
      const { container } = render(<RepoProposalCell active round={0} ownerBound fetchImpl={fetchImpl} />)
      await openCard(container)
      await waitFor(() => { expect(container.querySelector('[data-repo-proposal-ci-warning]')?.textContent).toContain(words) })
    }
    cleanup()
    const base = await proposalValue()
    const { fetchImpl } = cellFetch([statusBody({ ...base, changedFiles: [{ path: '.github/workflows/x.yml', status: 'added' }] })])
    const { container } = render(<RepoProposalCell active round={0} ownerBound fetchImpl={fetchImpl} />)
    await openCard(container)
    await waitFor(() => { expect(container.querySelector('[data-repo-proposal-problems]')?.textContent).toContain('under .github/') })
    expect(container.querySelector('[data-repo-proposal-approve]')).toBeNull()
    expect(container.textContent).toContain('CANNOT MERGE')
  })

  it('nothing staged, or a host without the route: no card at all', async () => {
    for (const body of [statusBody(null), { ok: true, staged: null }]) {
      cleanup()
      const { fetchImpl, calls } = cellFetch([body])
      const { container } = render(<RepoProposalCell active round={0} ownerBound fetchImpl={fetchImpl} />)
      await waitFor(() => { expect(calls).toHaveLength(1) })
      await new Promise((r) => { setTimeout(r, 20) })
      expect(container.querySelector('[data-sovereignty-portal="repo-proposal"]')).toBeNull()
    }
  })

  it('a proposal that changed since the card read it gets no passkey: read again at the click', async () => {
    const first = await proposalValue()
    const moved = { ...mergeBody, headSha: sha('9') }
    const second = await proposalValue({ headSha: sha('9'), mergeBody: moved })
    const { fetchImpl } = cellFetch([statusBody(first), statusBody(second)])
    const passkey = vi.fn()
    const platformStandIn = { passkeyBlocker: () => null, passkey, nodeKeys: async () => true }
    const ceremonyStandIn = { platform: platformStandIn } as unknown as NonNullable<Parameters<typeof RepoProposalCell>[0]['ceremony']>
    const { container } = render(<RepoProposalCell active round={0} ownerBound fetchImpl={fetchImpl}
      ceremony={ceremonyStandIn} />)
    await openCard(container)
    await waitFor(() => { expect(container.querySelector('[data-repo-proposal-approve]')).not.toBeNull() })
    ageCards()
    fireEvent.click(container.querySelector('[data-repo-proposal-approve]') as HTMLButtonElement)
    await waitFor(() => { expect(container.textContent).toContain('what HEAD holds changed since this card read it') })
    expect(passkey).not.toHaveBeenCalled()
    await waitFor(() => { expect(container.querySelector('[data-repo-proposal-move]')?.textContent).toContain(sha('9').slice(0, 12)) })
  })
})

describe('"Approval waiting" on the outer chrome', () => {
  it('shows while HEAD holds a Pearl or a merge, opens Sovereignty, and says nothing when HEAD did not say', async () => {
    expect(waitingWords({ pearl: true, repo: false })).toBe('Approval waiting: a Pearl')
    expect(waitingWords({ pearl: false, repo: true })).toBe('Approval waiting: a merge')
    expect(waitingWords({ pearl: true, repo: true })).toBe('Approvals waiting: a Pearl and a merge')
    const signal = new AbortController().signal
    // A host with no such route is said once, and not asked again; a failed read says nothing.
    expect(await readWaiting(signal, async () => json({ ok: false }, 404))).toBe('no-route')
    expect(await readWaiting(signal, async () => json({ ok: false }, 401))).toBeNull()
    let body: unknown = statusBody(null)
    const fetchImpl = (async () => json(body)) as unknown as typeof fetch
    const openSovereignty = vi.fn()
    const { container } = render(<ApprovalWaiting openSovereignty={openSovereignty} fetchImpl={fetchImpl} />)
    await new Promise((r) => { setTimeout(r, 20) })
    expect(container.querySelector('[data-approval-waiting]')).toBeNull()
    // A push that a merge was staged: read again, and the pill shows above everything.
    body = statusBody(await proposalValue())
    for (const socket of FakeSocket.open.filter(open => !open.closed)) socket.onmessage?.({ data: JSON.stringify({ type: 'repo:staged', proposal: { branch: 'x' } }) })
    await waitFor(() => { expect(container.querySelector('[data-approval-waiting]')?.getAttribute('data-approval-waiting')).toBe('repo') })
    fireEvent.click(container.querySelector('[data-approval-waiting]') as HTMLButtonElement)
    expect(openSovereignty).toHaveBeenCalledTimes(1)
    body = statusBody(null, { ballId: 'e'.repeat(64) })
    for (const socket of FakeSocket.open.filter(open => !open.closed)) socket.onmessage?.({ data: JSON.stringify({ type: 'head:staged' }) })
    await waitFor(() => { expect(container.querySelector('[data-approval-waiting]')?.textContent).toContain('Approval waiting: a Pearl') })
    body = statusBody(null)
    for (const socket of FakeSocket.open.filter(open => !open.closed)) socket.onmessage?.({ data: JSON.stringify({ type: 'repo:merged', commitSha: sha('b') }) })
    await waitFor(() => { expect(container.querySelector('[data-approval-waiting]')).toBeNull() })
  })

  it('the pushes are only facts: nothing in a frame is read', () => {
    expect(parseLiveMessage({ type: 'repo:staged', proposal: { mergeBody: 'x' } })).toEqual({ kind: 'repo-staged' })
    expect(parseLiveMessage('{"type":"repo:merged","commitSha":')).toEqual({ kind: 'repo-merged' })
  })
})

// ── Auma Live's voice fences (apps/web/public/app/genesis-live.js) ───────────────────────────────────────────────────────
const livePath = ['', '../../../'].map(prefix => resolve(process.cwd(), `${prefix}apps/web/public/app/genesis-live.js`)).find(existsSync)
const live = await import(pathToFileURL(livePath ?? 'apps/web/public/app/genesis-live.js').href) as {
  createGenesisLive: (deps: Record<string, unknown>) => {
    streamTurn: (input: Record<string, unknown>) => Promise<{ reason: string; text: string; message?: string }>
  }
  VOICE_PROVENANCE: string
  VOICE_PROVENANCE_UNJOURNALED: string
}

/** Her session as the transport sees it: a follow stream the test drives, and the RPCs it records. */
const fakeSession = (options: { queueHolds?: boolean } = {}) => {
  const rpcs: Array<{ method: string; args: Record<string, unknown> }> = []
  const streams: Array<{ args: unknown; push: (frame: unknown) => void; end: () => void; signal: AbortSignal }> = []
  const transport = {
    fetch: async (path: string, init: { body: string }) => {
      const method = path.replace('/api/', '')
      const args = (JSON.parse(init.body) as { payload: { args: Record<string, unknown> } }).payload.args
      rpcs.push({ method, args })
      if (method === 'session/state') {
        const requestId = rpcs.find(call => call.method === 'session/prompt')?.args.request as { requestId?: string } | undefined
        return json({ result: { ok: true, value: { queue: options.queueHolds === true ? [{ id: 'item-7', placement: 'queued', rpcId: requestId?.requestId, content: [] }] : [] } } })
      }
      return json({ result: { ok: true, value: { accepted: true } } })
    },
    openStream: (_name: string, args: unknown, signal: AbortSignal) => {
      const queue: unknown[] = []
      let wake: (() => void) | null = null
      let done = false
      const stream = { args, signal, push: (frame: unknown) => { queue.push(frame); wake?.() }, end: () => { done = true; wake?.() } }
      streams.push(stream)
      signal.addEventListener('abort', () => { done = true; wake?.() })
      return { [Symbol.asyncIterator]: () => ({
        next: async () => {
          for (;;) {
            if (queue.length > 0) return { done: false, value: queue.shift() }
            if (done) { if (signal.aborted) throw new Error('aborted'); return { done: true, value: undefined } }
            await new Promise<void>((r) => { wake = r })
            wake = null
          }
        },
        return: async () => { done = true; return { done: true, value: undefined } },
      }) }
    },
  }
  return { transport, rpcs, streams }
}
const snapshot = { type: 'snapshot', records: [], cursor: 0, hasMore: false, projections: {} }
const settle = async () => { for (let i = 0; i < 20; i += 1) await new Promise((r) => { setTimeout(r, 0) }) }

describe('Auma Live: a request stopped before its turn started is taken back', () => {
  it('still queued: it is removed from her queue by this request\'s own id', async () => {
    const { transport, rpcs, streams } = fakeSession({ queueHolds: true })
    const fences: string[] = []
    const controller = new AbortController()
    const g = live.createGenesisLive({ transport: Promise.resolve(transport), nativeFetch: async () => json({}, 404) })
    const turn = g.streamTurn({ sessionId: 's1', text: 'delete the old branch', signal: controller.signal, onFence: (o: string) => { fences.push(o) } })
    await settle()
    streams[0]?.push(snapshot)
    await settle()
    expect(rpcs.map(call => call.method)).toEqual(['session/prompt'])
    // The owner says "no, wait, stop" while another turn is still running: this request's turn has not started.
    controller.abort()
    await expect(turn).rejects.toThrow()
    await settle()
    const prompt = rpcs[0]?.args.request as { requestId: string }
    expect(rpcs.map(call => call.method)).toEqual(['session/prompt', 'session/state', 'session/updateQueue'])
    expect(rpcs[2]?.args).toEqual({ request: { sessionId: 's1', itemId: 'item-7', action: { kind: 'remove' } } })
    expect(fences).toEqual(['removed'])
    // Nothing else is cancelled: another party's running turn is never touched.
    expect(rpcs.some(call => call.method === 'session/cancel')).toBe(false)
    expect(typeof prompt.requestId).toBe('string')
  })

  it('not in the queue yet (or just leaving it): watched, and cancelled the moment its own turn begins', async () => {
    const { transport, rpcs, streams } = fakeSession()
    const fences: string[] = []
    const controller = new AbortController()
    const g = live.createGenesisLive({ transport: Promise.resolve(transport), nativeFetch: async () => json({}, 404) })
    const turn = g.streamTurn({ sessionId: 's1', text: 'deploy it', signal: controller.signal, onFence: (o: string) => { fences.push(o) } })
    await settle()
    streams[0]?.push(snapshot)
    await settle()
    controller.abort()
    await expect(turn).rejects.toThrow()
    await settle()
    // The fence's own follow stream (not aborted with the turn).
    const watch = streams[1]
    expect(watch).toBeDefined()
    const requestId = (rpcs[0]?.args.request as { requestId: string }).requestId
    watch?.push(snapshot)
    await settle()
    // The fence's follow request is one the gateway takes (assistantStream accepts only true, so it is left out).
    expect(watch?.args).toEqual({ args: { request: { address: { kind: 'session', sessionId: 's1' }, activate: false, maxMessages: 40 } } })
    // Another party's turn starting is not this request's: nothing is cancelled. (A user message carries no turn number:
    // its turn is the one the latest turn/start opened, as in the real session log.)
    watch?.push({ type: 'event', event: { type: 'turn/start', data: { turn: 4 } } })
    watch?.push({ type: 'event', event: { type: 'user/message', data: { id: 'm1', role: 'user', source: { rpcId: 'someone-else' } } } })
    await settle()
    expect(rpcs.some(call => call.method === 'session/cancel')).toBe(false)
    watch?.push({ type: 'event', event: { type: 'turn/end', data: { turn: 4 } } })
    watch?.push({ type: 'event', event: { type: 'turn/start', data: { turn: 5 } } })
    watch?.push({ type: 'event', event: { type: 'user/message', data: { id: 'm2', role: 'user', source: { kind: 'user', rpcId: requestId } } } })
    await settle()
    expect(rpcs.filter(call => call.method === 'session/cancel')).toEqual([{ method: 'session/cancel', args: { request: { sessionId: 's1' } } }])
    expect(fences).toEqual(['cancelled'])
  })

  it('a turn that already started is cancelled as before, and no fence runs', async () => {
    const { transport, rpcs, streams } = fakeSession()
    const fences: string[] = []
    const controller = new AbortController()
    const g = live.createGenesisLive({ transport: Promise.resolve(transport), nativeFetch: async () => json({}, 404) })
    const turn = g.streamTurn({ sessionId: 's1', text: 'hello', signal: controller.signal, onFence: (o: string) => { fences.push(o) } })
    await settle()
    streams[0]?.push(snapshot)
    await settle()
    const requestId = (rpcs[0]?.args.request as { requestId: string }).requestId
    streams[0]?.push({ type: 'event', event: { type: 'user/message', data: { turn: 9, source: { rpcId: requestId } } } })
    await settle()
    controller.abort()
    await expect(turn).rejects.toThrow()
    await settle()
    expect(rpcs.map(call => call.method)).toEqual(['session/prompt', 'session/cancel'])
    expect(fences).toEqual([])
  })
})

describe('Auma Live: a spoken turn is journaled as voice before she sees it, and says so', () => {
  const voiceFetch = (answer: () => Response) => {
    const calls: Array<Record<string, unknown>> = []
    const nativeFetch = async (path: string, init: { body: string }) => {
      calls.push({ path, ...(JSON.parse(init.body) as object) })
      return answer()
    }
    return { calls, nativeFetch }
  }
  it('journaled on the edge: dispatch_turn first, then the prompt carries the voice marker ahead of the words as heard', async () => {
    const { transport, rpcs, streams } = fakeSession()
    const v = voiceFetch(() => json({}))
    const g = live.createGenesisLive({ transport: Promise.resolve(transport), nativeFetch: async (path: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as { action: string; turnId: string }
      v.calls.push({ path, ...body })
      return body.action === 'dispatch_turn' ? json({ ok: true, action: 'dispatch_turn', turnId: body.turnId, voiceAuthority: 'none', savedBeforeDispatch: true })
        : json({ ok: true, cancelled: true })
    } })
    const controller = new AbortController()
    const turn = g.streamTurn({ sessionId: 's1', text: 'stage epoch sixty eight', spoken: true, signal: controller.signal })
    await settle()
    streams[0]?.push(snapshot)
    await settle()
    expect(v.calls[0]).toMatchObject({ path: '/_host/voice', action: 'dispatch_turn', transcript: 'stage epoch sixty eight' })
    const turnId = String(v.calls[0]?.turnId)
    const requestId = (rpcs[0]?.args.request as { requestId: string }).requestId
    expect(turnId).toBe(`auma-live:${requestId}`)
    expect((rpcs[0]?.args.request as { content: unknown }).content).toEqual([
      { type: 'text', text: live.VOICE_PROVENANCE }, { type: 'text', text: 'stage epoch sixty eight' }])
    expect(live.VOICE_PROVENANCE).toContain('voice carries no owner authority')
    // The owner speaks over her: the journaled turn is marked cancelled on the edge too.
    streams[0]?.push({ type: 'event', event: { type: 'user/message', data: { turn: 3, source: { rpcId: requestId } } } })
    await settle()
    controller.abort()
    await expect(turn).rejects.toThrow()
    await settle()
    expect(v.calls.at(-1)).toMatchObject({ action: 'barge_in', turnId })
  })

  it('a host with no voice director: sent, and marked unjournaled; a director that refuses: not sent, said in words', async () => {
    const mac = fakeSession()
    const g = live.createGenesisLive({ transport: Promise.resolve(mac.transport), nativeFetch: async () => new Response('Not found', { status: 404 }) })
    void g.streamTurn({ sessionId: 's1', text: 'hello', spoken: true, signal: new AbortController().signal }).catch(() => {})
    await settle()
    mac.streams[0]?.push(snapshot)
    await settle()
    expect((mac.rpcs[0]?.args.request as { content: Array<{ text: string }> }).content[0]?.text).toBe(live.VOICE_PROVENANCE_UNJOURNALED)
    const edge = fakeSession()
    const refused = live.createGenesisLive({ transport: Promise.resolve(edge.transport), nativeFetch: async () => json({ ok: false, code: 'OWNER_ACCESS_REQUIRED' }, 403) })
    const result = refused.streamTurn({ sessionId: 's1', text: 'hello', spoken: true, signal: new AbortController().signal })
    await settle()
    edge.streams[0]?.push(snapshot)
    expect(await result).toEqual({ reason: 'voice-journal-refused', text: '', message: 'the voice journal refused this spoken turn (OWNER_ACCESS_REQUIRED), so it was not sent' })
    expect(edge.rpcs).toEqual([])
    // A typed turn is never journaled as voice and carries no marker.
    const typed = fakeSession()
    const calls: unknown[] = []
    const t = live.createGenesisLive({ transport: Promise.resolve(typed.transport),
      nativeFetch: async (...args: unknown[]) => { calls.push(args); return json({}) } })
    void t.streamTurn({ sessionId: 's1', text: 'typed words', signal: new AbortController().signal }).catch(() => {})
    await settle()
    typed.streams[0]?.push(snapshot)
    await settle()
    expect(calls).toEqual([])
    expect((typed.rpcs[0]?.args.request as { content: unknown }).content).toEqual([{ type: 'text', text: 'typed words' }])
  })
})

describe('review fixes', () => {
  it('merged only as the approved head; an answer that does not know its own effect is unclear; a rename out of .github is refused', async () => {
    const { mergeOutcomeOf, mergeOutcomeWords } = await import('../src/client/spatial/aumlok/repo-proposal.ts')
    const proposal = parseRepoProposal(await proposalValue()) as RepoProposal
    expect(mergeOutcomeOf({ status: 200, body: { ok: true, commitSha: sha('b') } }, proposal)).toEqual({ kind: 'merged', commitSha: sha('b') })
    expect(mergeOutcomeWords({ kind: 'merged', commitSha: sha('b') }, proposal)).toBe(`Merged: main is now ${sha('b').slice(0, 12)} (${mergeBody.branch}).`)
    // An ok with no commit, or another commit (a merge or squash commit), is not taken as this merge.
    for (const body of [{ ok: true }, { ok: true, commitSha: sha('e') }]) {
      expect(mergeOutcomeOf({ status: 200, body }, proposal)).toEqual({ kind: 'unclear', detail: 'the host said ok but did not confirm main is at the approved head' })
    }
    // A deadline after the change was sent, or an answer that says its effect is unknown: unclear, never "main did not move".
    expect(mergeOutcomeOf({ status: 408, body: { ok: false, code: 'BROKER_TIMEOUT' } }, proposal).kind).toBe('unclear')
    expect(mergeOutcomeOf({ status: 409, body: { ok: false, code: 'X', outcome: 'unknown' } }, proposal).kind).toBe('unclear')
    expect(mergeOutcomeOf({ status: 409, body: { ok: false, code: 'REPO_HEAD_CONFLICT' } }, proposal)).toEqual({ kind: 'refused', code: 'REPO_HEAD_CONFLICT' })
    expect(mergeOutcomeWords({ kind: 'refused', code: 'REPO_HEAD_CONFLICT' }, proposal)).toBe('The host refused the merge (REPO_HEAD_CONFLICT); main did not move.')
    expect(mergeOutcomeOf({ status: 502, body: null }, proposal).kind).toBe('unclear')
    const renamed = { ...(await proposalValue()), changedFiles: [{ path: 'docs/gate.yml', previous_filename: '.github/workflows/gate.yml', status: 'renamed' }] }
    const problems = (await repoProposalProblems(parseRepoProposal(renamed) as RepoProposal, ORIGIN)).problems
    expect(problems.join(' | ')).toContain('.github/workflows/gate.yml → docs/gate.yml')
  })
})
