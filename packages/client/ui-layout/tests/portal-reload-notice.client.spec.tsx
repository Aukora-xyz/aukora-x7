// @vitest-environment jsdom
/**
 * The owner sees, without asking, that a newer Auma is published or that a new build of the app is live,
 * on the Work and Aura surfaces' existing Reload button, and one press reloads. A reload already pressed for the same
 * edge revision that still differs shows nothing again. Local stand-ins only (fetch, page tunnel, sockets).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { LiveChannel, LiveSocket } from '../src/client/spatial/work/autonomy.ts'
import { WORK_SURFACE, WorkSurface, type FileRead } from '../src/client/spatial/work/WorkSurface.tsx'
import { en } from '../src/client/spatial/work/labels.ts'
import { AuraPentoraSurface } from '../src/client/spatial/aura/AuraPentoraSurface.tsx'
import { AURA_SURFACE } from '../src/client/spatial/aura/model.ts'
import {
  BUILD_MISMATCH_ROUTE, BUILD_RELOAD_FOR_KEY, BUILD_SUPPRESSED_KEY, EDGE_BUILD_ROUTE, HEAD_LAG_ROUTE, pageReload,
} from '../src/client/spatial/portal/build-notice.ts'

class FakeChannel implements LiveChannel {
  onmessage: LiveChannel['onmessage'] = null
  close() {}
}
class FakeSocket implements LiveSocket {
  onopen: LiveSocket['onopen'] = null
  onmessage: LiveSocket['onmessage'] = null
  onclose: LiveSocket['onclose'] = null
  close() {}
}

const PAGE = 'a'.repeat(40)
const EDGE = 'b'.repeat(40)
const RUNNING = { ballId: 'c'.repeat(64), epoch: 171 }
const PUBLISHED = { ballId: 'd'.repeat(64), epoch: 172 }
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** The edge: `/api/build` names `edge`; every other route is not served here (no host selection, no wake, no facts). */
function edgeServes(edge: string) {
  vi.stubGlobal('fetch', vi.fn(async (input: string) => (input === EDGE_BUILD_ROUTE
    ? json({ ok: true, schema: 'aukora.build.v1', sourceRevision: edge })
    : json({ ok: false }, 404))))
}
/** Her runtime, through this page's tunnel: its head-lag record, and the mismatch reports it receives. */
function runtimeSays(headLag: unknown) {
  const reports: string[] = []
  vi.stubGlobal('__DSH_TRANSPORT__', {
    fetch: async (path: string, init?: { method?: string; body?: string }) => {
      if (path === BUILD_MISMATCH_ROUTE && init?.method === 'POST') reports.push(init.body ?? '')
      const body = path === HEAD_LAG_ROUTE ? { ok: true, headLag, buildMismatch: null } : { ok: true }
      return { status: 200, text: async () => JSON.stringify(body) }
    },
  })
  return reports
}

beforeEach(() => {
  vi.stubGlobal('BroadcastChannel', FakeChannel)
  vi.stubGlobal('WebSocket', FakeSocket)
  vi.stubGlobal('__X6_BUILD_IDENTITY__', { sourceRevision: PAGE, sourceDirty: false })
  sessionStorage.clear()
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); sessionStorage.clear() })

const notFound = async (): Promise<FileRead> => ({ ok: false, reason: 'not-found' })
function sessionHooks() {
  type StatusSnapshot = Parameters<Parameters<Parameters<typeof AuraPentoraSurface>[0]['useSessionStatus']>[0]>[0]
  const list: SessionListState = { ids: ['s1' as SessionId], byId: { s1: { id: 's1' as SessionId, displayTitle: 'Test', running: false,
    retainedBy: { mainView: 1 }, blank: false, updatedAt: 1 } }, phase: 'ready', projectionsBySession: {} } as unknown as SessionListState
  return {
    useSessions: bindSnapshotSelector(createSnapshotStore<SessionListState>(list)),
    useSessionStatus: bindSnapshotSelector(createSnapshotStore<StatusSnapshot>(new Map())),
  }
}
const surfaces = {
  Work: () => render(<WorkSurface {...({ activeSurface: WORK_SURFACE, ...sessionHooks(), reader: { whole: notFound },
    labels: (key: string) => (en as Record<string, string>)[key] ?? key, t: (key: string) => key } as unknown as
    PropsRuntime<'shell.surface'> & PropsLocale<'layout'> & Parameters<typeof WorkSurface>[0])} />),
  Aura: () => render(<AuraPentoraSurface {...({ activeSurface: AURA_SURFACE, closeSurface: () => {}, ...sessionHooks(),
    reader: { whole: notFound } } as unknown as Parameters<typeof AuraPentoraSurface>[0])} />),
}

for (const [name, mount] of Object.entries(surfaces)) {
  describe(`${name} surface: the existing Reload button carries both notices`, () => {
    it('a newer Auma is published: one sentence, and a press reloads', async () => {
      edgeServes(PAGE)
      runtimeSays({ published: PUBLISHED, running: RUNNING, newer: true })
      const reload = vi.spyOn(pageReload, 'now').mockImplementation(() => {})
      const { container } = mount()
      const button = await waitFor(() => {
        const found = container.querySelector<HTMLButtonElement>(`[data-new-build="${PUBLISHED.ballId}"]`)
        expect(found).not.toBeNull()
        return found as HTMLButtonElement
      })
      expect(button.textContent).toBe('Newer Auma · epoch 172 · Reload')
      expect(button.title).toContain('A newer Auma is published (epoch 172); this tab runs epoch 171. One reload brings her.')
      fireEvent.click(button)
      expect(reload).toHaveBeenCalledTimes(1)
      expect(sessionStorage.getItem(BUILD_RELOAD_FOR_KEY)).toBeNull()
    })

    it('a new build of the app is live: one sentence, and a press remembers it and reloads', async () => {
      edgeServes(EDGE)
      runtimeSays(null)
      const reload = vi.spyOn(pageReload, 'now').mockImplementation(() => {})
      const { container } = mount()
      const button = await waitFor(() => {
        const found = container.querySelector<HTMLButtonElement>(`[data-new-build="${EDGE}"]`)
        expect(found).not.toBeNull()
        return found as HTMLButtonElement
      })
      expect(button.textContent).toBe('New build · Reload')
      expect(button.title).toContain('A new build of the app is live. One reload brings it.')
      fireEvent.click(button)
      expect(reload).toHaveBeenCalledTimes(1)
      expect(sessionStorage.getItem(BUILD_RELOAD_FOR_KEY)).toBe(EDGE)
    })

    it('after a reload pressed for that same edge build, nothing is shown again and the mismatch is reported', async () => {
      edgeServes(EDGE)
      const reports = runtimeSays(null)
      sessionStorage.setItem(BUILD_RELOAD_FOR_KEY, EDGE)
      const { container } = mount()
      await waitFor(() => { expect(reports).toEqual([JSON.stringify({ page: PAGE, edge: EDGE })]) })
      expect(sessionStorage.getItem(BUILD_SUPPRESSED_KEY)).toBe(EDGE)
      expect(container.querySelector('[data-new-build]')).toBeNull()
    })
  })
}
