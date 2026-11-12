// @vitest-environment jsdom
/**
 * The Receipt chain verdict belongs to the read that produced it. After a Refresh (or a session
 * switch) whose read stalls, the card says Unknown, never the previous read's Append-only.
 */
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { SOVEREIGNTY_SURFACE, SovereigntySurface } from '../src/client/spatial/portal/SovereigntySurface.tsx'
import { RECEIPTS_PATH } from '../src/client/spatial/portal/promotion-receipts.ts'
import { CHECKPOINTS_PATH } from '../src/client/spatial/portal/receipt-chain-verdict.ts'
import { canonicalJson } from '../src/client/spatial/aumlok/class3-approval.ts'
import type { FileRead } from '../src/client/spatial/work/WorkSurface.tsx'

class FakeChannel { onmessage = null; close() {} }
class FakeSocket { onopen = null; onmessage = null; onclose = null; close() {} }
beforeEach(() => {
  vi.stubGlobal('BroadcastChannel', FakeChannel)
  vi.stubGlobal('WebSocket', FakeSocket)
  vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 404 })))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
const ledger = () => {
  const rows: string[] = []
  let prevHash = '0'.repeat(64)
  for (let seq = 1; seq <= 3; seq++) {
    const payload = { schema: 'aukora.receipt.v3', seq, prevHash, at: `t${String(seq)}`, kind: 'test', data: {} }
    const leafHash = sha(Buffer.concat([Buffer.from([0]), Buffer.from(canonicalJson(payload))]))
    rows.push(JSON.stringify({ ...payload, leafHash }))
    prevHash = leafHash
  }
  const leaves = rows.map(row => (JSON.parse(row) as { leafHash: string }).leafHash)
  const node = (l: string, r: string) => sha(Buffer.concat([Buffer.from([1]), Buffer.from(l, 'hex'), Buffer.from(r, 'hex')]))
  const root = node(node(leaves[0] ?? '', leaves[1] ?? ''), leaves[2] ?? '')
  return { receipts: rows.join('\n') + '\n', checkpoints: JSON.stringify({ body: { receiptCount: 3, merkleRoot: root } }) + '\n' }
}

describe('Receipt chain verdict, per read', () => {
  it('A Refresh whose read stalls shows Unknown, never the previous Append-only', async () => {
    const files = ledger()
    let stall = false
    const list = { ids: ['s1' as SessionId], byId: { ['s1' as SessionId]: { id: 's1' as SessionId, displayTitle: 'Test', running: false,
      retainedBy: { mainView: 1 }, blank: false, updatedAt: 1 } }, phase: 'ready', projectionsBySession: {} } as unknown as SessionListState
    const props = {
      activeSurface: SOVEREIGNTY_SURFACE,
      useSessions: bindSnapshotSelector(createSnapshotStore<SessionListState>(list)),
      reader: { whole: async (_session: unknown, path: string): Promise<FileRead> => {
        if (stall && (path === RECEIPTS_PATH || path === CHECKPOINTS_PATH)) return new Promise<FileRead>(() => {})
        if (path === RECEIPTS_PATH) return { ok: true, text: files.receipts }
        if (path === CHECKPOINTS_PATH) return { ok: true, text: files.checkpoints }
        return { ok: false, reason: 'not-found' }
      } },
    } as unknown as Parameters<typeof SovereigntySurface>[0]
    const { container } = render(<SovereigntySurface {...props} />)
    const verdict = () => container.querySelector('[data-sovereignty-chain-verdict]')
    // The Receipt chain card's body draws when it is open.
    await waitFor(() => { expect(container.querySelector('[data-sovereignty-portal="chain"] button.ak-portal__head')).not.toBeNull() })
    fireEvent.click(container.querySelector('[data-sovereignty-portal="chain"] button.ak-portal__head') as HTMLButtonElement)
    await waitFor(() => { expect(verdict()?.getAttribute('data-sovereignty-chain-verdict')).toBe('APPEND_ONLY') }, { timeout: 10_000 })
    stall = true
    const refresh = [...container.querySelectorAll('button')].find(button => button.textContent === 'Refresh')
    expect(refresh).toBeDefined()
    fireEvent.click(refresh as HTMLButtonElement)
    await waitFor(() => { expect(verdict()?.getAttribute('data-sovereignty-chain-verdict')).toBe('UNDETERMINED') })
    expect(verdict()?.textContent).toMatch(/^Unknown:/)
    await new Promise((done) => { setTimeout(done, 50) })
    expect(verdict()?.getAttribute('data-sovereignty-chain-verdict')).toBe('UNDETERMINED')
  }, 20_000)
})

describe('Receipt chain verdict, never resurrected', () => {
  const setup = () => {
    const files = ledger()
    const stalled = new Set<string>()
    const store = createSnapshotStore<SessionListState>({ ids: ['s1' as SessionId, 's2' as SessionId], byId: {
      ['s1' as SessionId]: { id: 's1' as SessionId, displayTitle: 'A', running: false, retainedBy: { mainView: 1 }, blank: false, updatedAt: 1 },
      ['s2' as SessionId]: { id: 's2' as SessionId, displayTitle: 'B', running: false, retainedBy: { mainView: 0 }, blank: false, updatedAt: 1 },
    }, phase: 'ready', projectionsBySession: {} } as unknown as SessionListState)
    const props = {
      activeSurface: SOVEREIGNTY_SURFACE,
      useSessions: bindSnapshotSelector(store),
      reader: { whole: async (session: unknown, path: string): Promise<FileRead> => {
        if (stalled.has(String(session)) && (path === RECEIPTS_PATH || path === CHECKPOINTS_PATH)) return new Promise<FileRead>(() => {})
        if (path === RECEIPTS_PATH) return { ok: true, text: files.receipts }
        if (path === CHECKPOINTS_PATH) return { ok: true, text: files.checkpoints }
        return { ok: false, reason: 'not-found' }
      } },
    } as unknown as Parameters<typeof SovereigntySurface>[0]
    const view = render(<SovereigntySurface {...props} />)
    const show = (id: 's1' | 's2') => {
      store.update((draft) => {
        const byId = draft.byId as Record<string, { retainedBy: { mainView: number } }>
        for (const key of Object.keys(byId)) { const row = byId[key]; if (row) row.retainedBy.mainView = key === id ? 1 : 0 }
      })
    }
    const verdict = () => view.container.querySelector('[data-sovereignty-chain-verdict]')?.getAttribute('data-sovereignty-chain-verdict')
    return { view, props, stalled, show, verdict }
  }
  const openChain = async (container: HTMLElement) => {
    await waitFor(() => { expect(container.querySelector('[data-sovereignty-portal="chain"] button.ak-portal__head')).not.toBeNull() })
    if (container.querySelector('[data-sovereignty-chain-verdict]') === null) {
      fireEvent.click(container.querySelector('[data-sovereignty-portal="chain"] button.ak-portal__head') as HTMLButtonElement)
    }
  }

  it('A: Append-only, switch to B (stalled), back to A (stalled): Unknown every time after A\'s first read', async () => {
    const t = setup()
    await openChain(t.view.container)
    await waitFor(() => { expect(t.verdict()).toBe('APPEND_ONLY') }, { timeout: 10_000 })
    t.stalled.add('s1').add('s2')
    t.show('s2')
    await waitFor(() => { expect(t.verdict()).toBe('UNDETERMINED') })
    t.show('s1')
    await new Promise((done) => { setTimeout(done, 80) })
    expect(t.verdict()).toBe('UNDETERMINED')
  }, 20_000)

  it('close and reopen with the new read stalled: Unknown, never the old Append-only', async () => {
    const t = setup()
    await openChain(t.view.container)
    await waitFor(() => { expect(t.verdict()).toBe('APPEND_ONLY') }, { timeout: 10_000 })
    t.stalled.add('s1')
    t.view.rerender(<SovereigntySurface {...{ ...t.props, activeSurface: 'elsewhere' }} />)
    t.view.rerender(<SovereigntySurface {...t.props} />)
    await openChain(t.view.container)
    await new Promise((done) => { setTimeout(done, 80) })
    expect(t.verdict()).toBe('UNDETERMINED')
  }, 20_000)
})
