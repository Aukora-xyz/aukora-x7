// @vitest-environment jsdom
/**
 * The app knows when the edge moved. `useEdgeBuild` compares the build this page was stamped
 * with against the edge's signed-out `GET /api/build`, at most once a minute, only while visible, and stops once they
 * differ. Unknown on either side is never shown as changed. A reload the owner pressed for an edge revision that still
 * differs afterwards is not shown again this session, and is reported to her runtime. `useHeadLag` reads her runtime's
 * own record of a newer published head. Local fetch and tunnel stand-ins only.
 */
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BUILD_MISMATCH_ROUTE, BUILD_RELOAD_FOR_KEY, BUILD_SUPPRESSED_KEY, EDGE_BUILD_POLL_MS, EDGE_BUILD_ROUTE, EDGE_BUILD_WORDS,
  HEAD_LAG_POLL_MS, HEAD_LAG_ROUTE, PAGE_BUILD_GLOBAL, edgeBuildChange, headLagWords, markBuildReload, pageBuildStamp, pageReload,
  pageSourceRevision, parseEdgeBuild,
  parseHeadLag, readEdgeBuild, readHeadLag, reloadNoticeOf, settleEdgeBuild, useEdgeBuild, useHeadLag,
  type BuildFetch, type BuildMemory, type PageTunnel,
} from '../src/client/spatial/portal/build-notice.ts'

const A = 'a'.repeat(40)
const B = 'b'.repeat(40)
const build = (sourceRevision: unknown, extra: Record<string, unknown> = {}) =>
  Response.json({ ok: true, schema: 'aukora.build.v1', sourceRevision, ...extra })

afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

/** A session memory stand-in. */
function memoryOf(seed: Record<string, string> = {}): BuildMemory & { readonly map: Map<string, string> } {
  const map = new Map(Object.entries(seed))
  return {
    map, getItem: key => map.get(key) ?? null, setItem: (key, value) => { map.set(key, value) }, removeItem: (key) => { map.delete(key) },
  }
}
/** A page tunnel stand-in that records each call and answers `answer(path, init)`. */
function tunnelOf(answer: (path: string, body: string | undefined) => unknown) {
  const calls: Array<{ path: string; method: string | undefined; body: string | undefined }> = []
  const tunnel: PageTunnel = async (path, init) => {
    calls.push({ path, method: init?.method, body: init?.body })
    const value = answer(path, init?.body)
    return { status: 200, text: async () => JSON.stringify(value) }
  }
  return { tunnel, calls }
}
const HEAD_A = { ballId: 'a'.repeat(64), epoch: 171 }
const HEAD_B = { ballId: 'b'.repeat(64), epoch: 172 }

/** A document stand-in whose visibility the test flips. */
function pageDoc(state: 'visible' | 'hidden') {
  const listeners = new Set<() => void>()
  return {
    visibilityState: state,
    addEventListener: (_type: string, listener: () => void) => { listeners.add(listener) },
    removeEventListener: (_type: string, listener: () => void) => { listeners.delete(listener) },
    show(next: 'visible' | 'hidden') { this.visibilityState = next; for (const listener of listeners) listener() },
  }
}

describe('what each side says', () => {
  it('this page has a revision only from a clean, well-formed build stamp', () => {
    expect(pageSourceRevision({ sourceRevision: A, sourceDirty: false })).toBe(A)
    expect(pageSourceRevision({ sourceRevision: A, sourceDirty: true })).toBeNull()
    expect(pageSourceRevision({ sourceRevision: A, sourceDirty: null })).toBeNull()
    expect(pageSourceRevision({ sourceRevision: 'A'.repeat(40), sourceDirty: false })).toBeNull()
    expect(pageSourceRevision({ sourceRevision: null, sourceDirty: false })).toBeNull()
    expect(pageSourceRevision(undefined)).toBeNull()
    // The default reads the bundler-injected stamp; under test there is none until one is set.
    expect(pageSourceRevision()).toBeNull()
    vi.stubGlobal('__X6_BUILD_IDENTITY__', { sourceRevision: B, sourceDirty: false })
    expect(pageSourceRevision()).toBe(B)
  })

  it('in the deployed app, where the library is never bundled with the stamp, the page reads the one its bootstrap published', () => {
    // the library ships inside the app image, so the bundler define is a bare word there; apps/web/src/preview.ts
    // publishes the stamp as this global before the image loads (deploy/ci/built-notice-check.mjs proves it on a build).
    expect(PAGE_BUILD_GLOBAL).toBe('__X6_PAGE_BUILD__')
    expect(pageBuildStamp()).toBeUndefined()
    vi.stubGlobal(PAGE_BUILD_GLOBAL, Object.freeze({ sourceRevision: A, sourceDirty: false }))
    expect(pageSourceRevision()).toBe(A)
    // A bundle that does carry the define keeps its own stamp.
    vi.stubGlobal('__X6_BUILD_IDENTITY__', { sourceRevision: B, sourceDirty: false })
    expect(pageSourceRevision()).toBe(B)
    vi.unstubAllGlobals()
    // A dirty or unstamped build publishes nulls and names nothing; anything that is not a stamp names nothing.
    for (const published of [{ sourceRevision: A, sourceDirty: null }, { sourceRevision: null, sourceDirty: null },
      { sourceRevision: A, sourceDirty: true }, A, 1, null]) {
      vi.stubGlobal(PAGE_BUILD_GLOBAL, published)
      expect(pageSourceRevision()).toBeNull()
    }
  })

  it('the edge has a revision only from an ok build answer', () => {
    expect(parseEdgeBuild({ ok: true, schema: 'aukora.build.v1', sourceRevision: B })).toBe(B)
    expect(parseEdgeBuild({ ok: true, schema: 'aukora.build.v1', sourceRevision: 'c'.repeat(64) })).toBe('c'.repeat(64))
    for (const body of [null, [], 'x', { ok: false, schema: 's', sourceRevision: B }, { ok: true, sourceRevision: B },
      { ok: true, schema: 's', sourceRevision: 'UNVERIFIED' }, { ok: true, schema: 's', sourceRevision: B.slice(1) }]) {
      expect(parseEdgeBuild(body)).toBeNull()
    }
  })

  it('a change is only a difference between two known revisions', () => {
    expect(edgeBuildChange(A, B)).toBe(B)
    expect(edgeBuildChange(A, A)).toBeNull()
    expect(edgeBuildChange(null, B)).toBeNull()
    expect(edgeBuildChange(A, null)).toBeNull()
    expect(EDGE_BUILD_WORDS.what).toBe('A new build of the app is live. One reload brings it.')
  })
})

describe('one read of /api/build', () => {
  it('is a same-origin, uncached GET of the build route', async () => {
    const seen: Array<[string, RequestInit]> = []
    const fetchImpl: BuildFetch = async (input, init) => { seen.push([input, init]); return build(B) }
    expect(await readEdgeBuild(fetchImpl)).toBe(B)
    expect(seen).toHaveLength(1)
    expect(seen[0]![0]).toBe(EDGE_BUILD_ROUTE)
    expect(seen[0]![1]).toMatchObject({ method: 'GET', credentials: 'same-origin', cache: 'no-store' })
  })

  it('an error status, an oversized answer, a broken body or a silent edge reads as unknown', async () => {
    expect(await readEdgeBuild(async () => Response.json({ ok: false }, { status: 503 }))).toBeNull()
    expect(await readEdgeBuild(async () => build(B, { pad: 'x'.repeat(5000) }))).toBeNull()
    expect(await readEdgeBuild(async () => new Response('<html>sign in</html>', { status: 200 }))).toBeNull()
    expect(await readEdgeBuild(async () => { throw new TypeError('offline') })).toBeNull()
    const silent: BuildFetch = (_input, init) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => { reject(new DOMException('aborted', 'AbortError')) })
    })
    expect(await readEdgeBuild(silent, 20)).toBeNull()
  })
})

describe('useEdgeBuild', () => {
  function mount(options: Parameters<typeof useEdgeBuild>[1], active = true) {
    options = { memory: memoryOf(), tunnel: null, ...options }
    const seen: Array<string | null> = []
    const Probe = ({ on }: { on: boolean }) => { seen.push(useEdgeBuild(on, options)); return null }
    const view = render(<Probe on={active} />)
    return { seen, last: () => seen.at(-1) ?? null, view, Probe }
  }

  it('reads at once, then no more than once a minute, and shows the edge revision when it differs; then stops', async () => {
    vi.useFakeTimers()
    const doc = pageDoc('visible')
    let edge = A
    const fetchImpl = vi.fn<BuildFetch>(async () => build(edge))
    const probe = mount({ fetchImpl, pageRevision: A, doc })
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(probe.last()).toBeNull()
    // Re-renders and a visibility flicker inside the minute buy no extra read.
    probe.view.rerender(<probe.Probe on />)
    await act(async () => { doc.show('hidden'); doc.show('visible'); await vi.advanceTimersByTimeAsync(EDGE_BUILD_POLL_MS - 1000) })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    edge = B
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(probe.last()).toBe(B)
    await act(async () => { await vi.advanceTimersByTimeAsync(5 * EDGE_BUILD_POLL_MS) })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(probe.last()).toBe(B)
  })

  it('reads nothing while the page is hidden, and reads when it is shown', async () => {
    vi.useFakeTimers()
    const doc = pageDoc('hidden')
    const fetchImpl = vi.fn<BuildFetch>(async () => build(B))
    const probe = mount({ fetchImpl, pageRevision: A, doc })
    await act(async () => { await vi.advanceTimersByTimeAsync(10 * EDGE_BUILD_POLL_MS) })
    expect(fetchImpl).not.toHaveBeenCalled()
    await act(async () => { doc.show('visible'); await vi.advanceTimersByTimeAsync(0) })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(probe.last()).toBe(B)
  })

  it('with no revision passed, the notice runs on the stamp the bootstrap published', async () => {
    vi.useFakeTimers()
    vi.stubGlobal(PAGE_BUILD_GLOBAL, Object.freeze({ sourceRevision: A, sourceDirty: false }))
    const fetchImpl = vi.fn<BuildFetch>(async () => build(B))
    const probe = mount({ fetchImpl, doc: pageDoc('visible') })
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(probe.last()).toBe(B)
  })

  it('a page that cannot name its own build, or an inactive surface, never asks', async () => {
    vi.useFakeTimers()
    const fetchImpl = vi.fn<BuildFetch>(async () => build(B))
    const unknown = mount({ fetchImpl, pageRevision: null, doc: pageDoc('visible') })
    const inactive = mount({ fetchImpl, pageRevision: A, doc: pageDoc('visible') }, false)
    await act(async () => { await vi.advanceTimersByTimeAsync(3 * EDGE_BUILD_POLL_MS) })
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(unknown.last()).toBeNull()
    expect(inactive.last()).toBeNull()
  })

  it('an unreadable edge is not a new build, and the next read waits the full minute', async () => {
    vi.useFakeTimers()
    const fetchImpl = vi.fn<BuildFetch>(async () => Response.json({ ok: false }, { status: 503 }))
    const probe = mount({ fetchImpl, pageRevision: A, doc: pageDoc('visible') })
    await act(async () => { await vi.advanceTimersByTimeAsync(EDGE_BUILD_POLL_MS - 1) })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(probe.last()).toBeNull()
  })
})

describe('no false notice survives a reload', () => {
  it('the press mark is consumed by the first known answer; the same revision still differing is suppressed and reported', () => {
    const memory = memoryOf()
    expect(settleEdgeBuild(A, B, memory)).toBe('show')
    markBuildReload(B, memory)
    expect(memory.map.get(BUILD_RELOAD_FOR_KEY)).toBe(B)
    // The page this press loaded still runs A while the edge names B: a hand-stamped deploy, not a new build.
    expect(settleEdgeBuild(A, B, memory)).toBe('mismatch')
    expect(memory.map.has(BUILD_RELOAD_FOR_KEY)).toBe(false)
    expect(memory.map.get(BUILD_SUPPRESSED_KEY)).toBe(B)
    expect(settleEdgeBuild(A, B, memory)).toBe('suppressed')
    // A later, different edge build is a real change again.
    expect(settleEdgeBuild(A, 'c'.repeat(40), memory)).toBe('show')
    // A press whose reload did bring the build leaves nothing behind.
    const fresh = memoryOf({ [BUILD_RELOAD_FOR_KEY]: B })
    expect(settleEdgeBuild(B, B, fresh)).toBe('same')
    expect(fresh.map.size).toBe(0)
  })

  it('after a reload pressed for the same edge revision the hook shows nothing, reports the mismatch, and keeps reading', async () => {
    vi.useFakeTimers()
    const memory = memoryOf({ [BUILD_RELOAD_FOR_KEY]: B })
    const { tunnel, calls } = tunnelOf(() => ({ ok: true }))
    let edge = B
    const fetchImpl = vi.fn<BuildFetch>(async () => build(edge))
    const seen: Array<string | null> = []
    const Probe = () => { seen.push(useEdgeBuild(true, { fetchImpl, pageRevision: A, doc: pageDoc('visible'), memory, tunnel })); return null }
    render(<Probe />)
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(seen.at(-1)).toBeNull()
    expect(calls).toEqual([{ path: BUILD_MISMATCH_ROUTE, method: 'POST', body: JSON.stringify({ page: A, edge: B }) }])
    await act(async () => { await vi.advanceTimersByTimeAsync(EDGE_BUILD_POLL_MS) })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(seen.at(-1)).toBeNull()
    expect(calls).toHaveLength(1)
    edge = 'c'.repeat(40)
    await act(async () => { await vi.advanceTimersByTimeAsync(EDGE_BUILD_POLL_MS) })
    expect(seen.at(-1)).toBe('c'.repeat(40))
  })
})

describe('her published head, from her runtime\'s own record', () => {
  const lagBody = { ok: true, headLag: { published: HEAD_B, running: HEAD_A, newer: true, reloadBrings: true, say: 'x' } }
  it('a lag is two well-formed, different heads; anything else is none', () => {
    expect(parseHeadLag(lagBody)).toEqual({ published: HEAD_B, running: HEAD_A, newer: true })
    for (const body of [null, { ok: true, headLag: null }, { ok: false, headLag: lagBody.headLag },
      { ok: true, headLag: { published: HEAD_A, running: HEAD_A } }, { ok: true, headLag: { published: { ballId: 'x', epoch: 172 }, running: HEAD_A } },
      { ok: true, headLag: { published: { ...HEAD_B, epoch: -1 }, running: HEAD_A } }]) {
      expect(parseHeadLag(body)).toBeNull()
    }
    expect(headLagWords({ published: HEAD_B, running: HEAD_A, newer: true })).toEqual({ button: 'Newer Auma · epoch 172 · Reload',
      what: 'A newer Auma is published (epoch 172); this tab runs epoch 171. One reload brings her.' })
  })

  it('reads the tab\'s route through the page tunnel; no tunnel, a refusal or a silent tunnel is none', async () => {
    const { tunnel, calls } = tunnelOf(() => lagBody)
    expect(await readHeadLag(tunnel)).toEqual({ published: HEAD_B, running: HEAD_A, newer: true })
    expect(calls).toEqual([{ path: HEAD_LAG_ROUTE, method: 'GET', body: undefined }])
    expect(await readHeadLag(null)).toBeNull()
    expect(await readHeadLag(async () => ({ status: 404, text: async () => '{}' }))).toBeNull()
    expect(await readHeadLag(() => new Promise(() => {}), 20)).toBeNull()
  })

  it('useHeadLag reads at once and every 15 s while open and visible, and drops a lag that is gone', async () => {
    vi.useFakeTimers()
    let body: unknown = lagBody
    const { tunnel, calls } = tunnelOf(() => body)
    const seen: unknown[] = []
    const doc = pageDoc('visible')
    const Probe = ({ on }: { on: boolean }) => { seen.push(useHeadLag(on, { tunnel, doc })); return null }
    const view = render(<Probe on />)
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(seen.at(-1)).toMatchObject({ published: HEAD_B, newer: true })
    body = { ok: true, headLag: null }
    await act(async () => { await vi.advanceTimersByTimeAsync(HEAD_LAG_POLL_MS) })
    expect(calls).toHaveLength(2)
    expect(seen.at(-1)).toBeNull()
    view.rerender(<Probe on={false} />)
    await act(async () => { await vi.advanceTimersByTimeAsync(5 * HEAD_LAG_POLL_MS) })
    expect(calls).toHaveLength(2)
  })
})

describe('one notice, one press', () => {
  it('says each cause in one sentence, and a press for an edge build marks it before the reload', () => {
    const lag = { published: HEAD_B, running: HEAD_A, newer: true }
    expect(reloadNoticeOf(null, null, A)).toBeNull()
    const memory = memoryOf()
    const reload = vi.spyOn(pageReload, 'now').mockImplementation(() => {})
    const both = reloadNoticeOf(B, lag, A, memory)
    expect(both).toMatchObject({ release: B, from: A, words: { button: 'New build · Reload',
      what: 'A new build of the app is live. One reload brings it. A newer Auma is published (epoch 172); this tab runs epoch 171. One reload brings her.' } })
    both?.reload()
    expect(memory.map.get(BUILD_RELOAD_FOR_KEY)).toBe(B)
    expect(reload).toHaveBeenCalledTimes(1)
    const onlyLag = reloadNoticeOf(null, lag, A, memory)
    expect(onlyLag).toMatchObject({ release: HEAD_B.ballId, from: HEAD_A.ballId, words: headLagWords(lag) })
  })
})
