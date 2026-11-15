// @vitest-environment jsdom
/**
 * Round 25, Lane 4: Sovereignty, live only. Four cards (Keys and trust, Receipt chain, Published Pearl, Wake), a fifth only
 * while a governance Pearl is staged, the host in the header, and nothing whose only job is to say "not reported".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { CONTINUITY_SURFACE, ContinuitySurface, SOVEREIGNTY_SURFACE, SovereigntySurface } from '../src/client/spatial/portal/SovereigntySurface.tsx'
import { RECEIPTS_PATH } from '../src/client/spatial/portal/promotion-receipts.ts'
import { STAGED_PROMOTION_PATH } from '../src/client/spatial/aumlok/head-promotion.ts'
import type { FileRead } from '../src/client/spatial/work/WorkSurface.tsx'

class FakeChannel { onmessage = null; close() {} }
class FakeSocket { onopen = null; onmessage = null; onclose = null; close() {} }
beforeEach(() => {
  vi.stubGlobal('BroadcastChannel', FakeChannel)
  vi.stubGlobal('WebSocket', FakeSocket)
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const HEAD = '7c01cb98514e4ae7a6aaa0dc29653282d94bc4717b85a18968b47aa4310120a8'
const FACTS = {
  ok: true, runtime: 'cloudflare', epoch: 162, ballId: HEAD, organCount: 24, activeOrganCount: 24, receiptTotal: 120, receiptsVerified: 120,
  checkpointsTotal: 12, lastCheckpointSeq: 12, lastCheckpointReceiptCount: 119, dagReachable: 5, dagDeclared: 5, auraStatus: 'calm',
  receiptVerification: 'hash-and-chain', checkpointVerification: 'signature-and-receipt-prefix', checkpointSignerTrust: 'pinned',
  evidenceStatus: 'complete',
}
/** A synthetic edge answer, shaped as the edge answers: no /_head/runtime, no word on the owner's anchor, no pepper from main's host. */
const edge = (overrides: Record<string, unknown> = {}) => vi.fn(async (input: string) => {
  // Each reader gets its own copy: two screens read the same routes now, and a Response body can be read once.
  if (Object.hasOwn(overrides, input)) return (overrides[input] as Response).clone()
  if (input === '/__x6/status') return json({ ok: true, runtime: 'cloudflare' })
  if (input === '/api/health') return json({ ok: true, ready: true, runtime: 'cloudflare', buildSha: 'b'.repeat(40), capabilities: { providerDoors: { deepseek: true } }, unsupported: [] })
  if (input === '/__x6/facts') return json(FACTS)
  if (input === '/_host/checkpoint-policy') return json({ ok: true, schema: 'aukora.checkpoint-policy.v1', ranges: [{ firstSeq: 1, lastSeq: 12, envelope: 'v1', publicKeyHex: 'ab'.repeat(32) }] })
  if (input === '/_host/aumlok/status') return json({ ok: true, phase: 'BOUND', bound: true, passkeyVerified: true, nodePubkeyHex: 'ef'.repeat(32), blockers: [] })
  if (input === '/_head/ball') return json({ ok: true, buildSha: 'c'.repeat(40), head: { ballId: HEAD, parentBallId: 'aa'.repeat(32), epoch: 162, entries: {} }, modules: { x: {} }, peers: [] })
  if (input === '/_head/runtime') return json({ ok: false, code: 'CLOUD_CAPABILITY_UNAVAILABLE' }, 501)
  if (input === '/_host/wake') return json({ ok: true, enabled: false, intervalMs: 86_400_000, lastWakeAt: null, lastWakeOutcome: null, wakeCount: 0, nextWakeAt: null, receipts: [] })
  if (input === '/_head/lease') return json({ ok: true, lease: null, ballId: HEAD, epoch: 162 })
  return new Response('nope', { status: 404 })
})
const mount = (files: Record<string, string> = {}) => {
  const list = { ids: ['s1' as SessionId], byId: { ['s1' as SessionId]: { id: 's1' as SessionId, displayTitle: 'Test', running: false,
    retainedBy: { mainView: 1 }, blank: false, updatedAt: 1 } }, phase: 'ready', projectionsBySession: {} } as unknown as SessionListState
  const props = {
    activeSurface: SOVEREIGNTY_SURFACE,
    useSessions: bindSnapshotSelector(createSnapshotStore<SessionListState>(list)),
    reader: { whole: async (_session: unknown, path: string): Promise<FileRead> => (Object.hasOwn(files, path)
      ? { ok: true, text: files[path] ?? '' } : { ok: false, reason: 'not-found' }) },
  } as unknown as Parameters<typeof SovereigntySurface>[0]
  // BOTH SCREENS, each open as its own surface (Wave 5 split): Sovereignty holds the approvals, the keys and the chain;
  // Continuity holds the strip, the published Pearl, the wake schedule and the estate. What Round 25 pinned for the old
  // single screen is pinned across the two.
  return render(<><SovereigntySurface {...props} /><ContinuitySurface {...props} activeSurface={CONTINUITY_SURFACE} /></>)
}
const cards = (container: HTMLElement) => [...container.querySelectorAll('[data-sovereignty-portal]')].map(cell => cell.getAttribute('data-sovereignty-portal'))

describe('Sovereignty and Continuity, live only (Round 25)', () => {
  it('two cards on Sovereignty and three on Continuity, the host in the header, and no card, row or note whose only job is to say nothing is there', async () => {
    vi.stubGlobal('fetch', edge())
    const { container } = mount()
    await waitFor(() => { expect(container.querySelector('[data-sovereignty-portal="chain"]')?.textContent).toContain('120 receipts') }, { timeout: 10_000 })
    // Nothing staged: no Staged governance Pearl card at all. The host is the header's pill, not a card.
    expect(cards(container)).toEqual(['keys', 'chain', 'head', 'wake', 'estate'])
    expect([...container.querySelectorAll('[data-sovereignty-surface] [data-sovereignty-portal]')]).toHaveLength(2)
    expect([...container.querySelectorAll('[data-continuity-surface] [data-sovereignty-portal]')]).toHaveLength(3)
    expect(container.querySelector('.ak-header')?.textContent).toContain('CLOUDFLARE EDGE')
    expect(container.textContent).not.toContain('Where this page runs')
    expect(container.querySelector('.ak-footnote')).toBeNull()
    // Keys and trust in one line: what the host said, and no "not reported" for what it did not (no anchor, no pepper here).
    const keys = container.querySelector('[data-sovereignty-portal="keys"]')
    await waitFor(() => { expect(keys?.textContent).toContain('passkey bound · signer pinned') })
    fireEvent.click(keys?.querySelector('button') as Element)
    expect(keys?.textContent).not.toMatch(/not reported|pepper|signer anchored/u)
    // Published Pearl: the edge does not route /_head/runtime, so no release row and no "did not answer" line.
    const head = container.querySelector('[data-sovereignty-portal="head"]')
    fireEvent.click(head?.querySelector('button') as Element)
    expect(head?.textContent).toContain('Pearl ID')
    expect(head?.textContent).not.toMatch(/served release|runtime|501/u)
    expect(head?.querySelector('[data-sovereignty-snapshot]')).not.toBeNull()
    // Wake: one line when nothing is active, and no row that only says the tasks are not read.
    const wake = container.querySelector('[data-sovereignty-portal="wake"]')
    await waitFor(() => { expect(wake?.textContent).toContain('timer paused · tasks not read') })
    expect(container.textContent).not.toMatch(/not on the edge yet|edge node\.example\.invalid|evidence & provenance|model attribution/u)
  }, 30_000)

  it('a bad state that is live still shows first: a signer mismatch, and her verifier refused by the host', async () => {
    vi.stubGlobal('fetch', edge({ '/__x6/facts': json({ ...FACTS, checkpointSignerTrust: 'mismatch' }) }))
    const { container } = mount()
    await waitFor(() => { expect(container.querySelector('[data-sovereignty-portal="keys"]')?.textContent).toContain('CHECKPOINT SIGNER MISMATCH') },
      { timeout: 10_000 })
    expect(container.querySelector('[data-sovereignty-portal="keys"]')?.textContent).toContain('signer MISMATCH')
  }, 30_000)

  it('live trouble stays in sight: a failed Mac release selection, an edge whose health did not read (Round 25 review)', async () => {
    vi.stubGlobal('fetch', edge({
      '/__x6/status': json({ ok: true, runtime: 'local' }),
      '/_head/runtime': json({ ok: true, selected: null, selectionError: 'RUNTIME_JOURNAL_PENDING', latestCapturedRelease: null, candidates: [] }),
    }))
    const { container } = mount()
    const head = () => container.querySelector('[data-sovereignty-portal="head"]')
    await waitFor(() => { expect(head()?.textContent).toContain('served release NOT read') }, { timeout: 10_000 })
    fireEvent.click(head()?.querySelector('button') as Element)
    expect(head()?.textContent).toContain('selection FAILED (RUNTIME_JOURNAL_PENDING)')
    expect(container.querySelector('[data-sovereignty-host-trouble]')).toBeNull()
    cleanup()
    vi.stubGlobal('fetch', edge({ '/api/health': json({ ok: false }, 500) }))
    const again = mount()
    await waitFor(() => { expect(again.container.querySelector('[data-sovereignty-host-trouble]')?.textContent).toContain('answered 500') },
      { timeout: 10_000 })
    // The edge does not route /_head/runtime: its 501 is never said.
    const edgeHead = again.container.querySelector('[data-sovereignty-portal="head"]')
    fireEvent.click(edgeHead?.querySelector('button') as Element)
    expect(edgeHead?.textContent).not.toMatch(/served release|501/u)
  }, 30_000)

  it('rows that only say nothing is there stay out: a wake that never happened, the pepper of an unbound host (Round 25 review)', async () => {
    vi.stubGlobal('fetch', edge({ '/_host/aumlok/status': json({ ok: true, phase: 'UNBOUND', bound: false, passkeyVerified: false,
      nodePubkeyHex: null, blockers: [], enrollmentAvailable: true, pepperSeparated: false }) }))
    const { container } = mount()
    const wake = () => container.querySelector('[data-sovereignty-portal="wake"]')
    await waitFor(() => { expect(wake()?.textContent).toContain('timer paused') }, { timeout: 10_000 })
    fireEvent.click(wake()?.querySelector('button') as Element)
    expect(wake()?.textContent).toContain('host wake timer')
    expect(wake()?.textContent).not.toMatch(/last wake|never woken/u)
    const keys = () => container.querySelector('[data-sovereignty-portal="keys"]')
    await waitFor(() => { expect(keys()?.textContent).toContain('no passkey bound') })
    fireEvent.click(keys()?.querySelector('button') as Element)
    expect(keys()?.textContent).not.toMatch(/pepper|nothing is sealed/u)
  }, 30_000)

  it('the Mac serves its release: one row in Published Pearl; a staged Pearl brings its card back', async () => {
    vi.stubGlobal('fetch', edge({
      '/__x6/status': json({ ok: true, runtime: 'local' }),
      '/_head/runtime': json({ ok: true, selected: { epoch: 162, releaseId: 'rel-62' }, latestCapturedRelease: 'rel-62',
        candidates: [{}] }),
    }))
    const malformed = { [STAGED_PROMOTION_PATH]: '{"schema":"aukora.staged-head-promotion.v1","body":{}}' }
    const { container } = mount(malformed)
    await waitFor(() => { expect(cards(container)).toContain('promotion') }, { timeout: 10_000 })
    expect(container.querySelector('[data-sovereignty-portal="promotion"]')?.textContent).toContain('a staged file this page cannot read as a promotion')
    const head = container.querySelector('[data-sovereignty-portal="head"]')
    fireEvent.click(head?.querySelector('button') as Element)
    await waitFor(() => { expect(head?.textContent).toContain('served release') })
    expect(head?.textContent).toContain('rel-62 (epoch 162)')
    expect(container.querySelector('.ak-header')?.textContent).toContain('LOCAL MAC')
  }, 30_000)
  it('Wave 7: the Receipt chain card lists her promotions, a superseded provisional record folded into its Touch ID promotion', async () => {
    vi.stubGlobal('fetch', edge())
    const leaf = (seq: number, data: Record<string, unknown>) => JSON.stringify({ seq, kind: 'head.promote', data })
    const ball = '13'.repeat(32)
    const ledger = [leaf(137, { epoch: 168, ballId: ball, entryId: 'seed-continuity', tier: 'T1', hasApprovalToken: false }),
      leaf(139, { epoch: 168, ballId: ball, entryId: 'seed-continuity', tier: 'T2', hasApprovalToken: true }),
      leaf(150, { epoch: 170, ballId: 'bb'.repeat(32), entryId: 'seed-repo-forge', tier: 'T1', hasApprovalToken: false })].join('\n')
    const { container } = mount({ [RECEIPTS_PATH]: ledger })
    const chain = () => container.querySelector('[data-sovereignty-surface] [data-sovereignty-portal="chain"]')
    await waitFor(() => { expect(chain()?.textContent).toContain('120 receipts') }, { timeout: 10_000 })
    fireEvent.click(chain()?.querySelector('button') as Element)
    await waitFor(() => { expect(chain()?.querySelector('[data-sovereignty-promotion-receipts="listed"]')).not.toBeNull() })
    const rows = [...(chain()?.querySelectorAll('[data-sovereignty-promotion-receipt]') ?? [])]
    // Three leaves, two promotions: epoch 168 is one row (the Touch ID record), not two.
    expect(rows.map(row => [row.getAttribute('data-sovereignty-promotion-receipt'), row.getAttribute('data-authoritative'),
      row.getAttribute('data-supersedes')])).toEqual([['170', 'false', '0'], ['168', 'true', '1']])
    expect(rows[1]?.textContent).toBe('approved with Touch ID · T2 · supersedes 1 provisional record of the same promotion')
    // Continuity does not read or list the ledger.
    expect(container.querySelector('[data-continuity-surface] [data-sovereignty-promotion-receipts]')).toBeNull()
  }, 30_000)

})
