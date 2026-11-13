// @vitest-environment jsdom
/**
 * NOTHING FLOATS. Notices live behind one launcher, the FIRST entry of the system menu, above
 * Work: drawn like its neighbours with nothing waiting, gold with the count when something waits. It opens Notices in
 * the centre: a plain list, newest first, one row per notice with its words, when it was first seen and its Reload,
 * which is the same reload the frame's old pill pressed. Fed only by build-notice.ts's two kinds, through its own reads.
 * Local fetch and tunnel stand-ins only; nothing reaches a network.
 */
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { useState } from 'react'
import {
  BUILD_RELOAD_FOR_KEY, EDGE_BUILD_WORDS, headLagWords, holdReload, pageReload, resetReloadHoldsForTests,
  type BuildFetch, type BuildMemory, type PageTunnel, type ReloadNotice,
} from '../src/client/spatial/portal/build-notice.ts'
import {
  firstSeenText, noticeEntriesOf, NOTHING_WAITING, NOTICES_SURFACE, noticesLabel, publishNotices, currentNotices,
  resetNoticesForTests, useNoticeFeed, useReloadNoticeFeed,
} from '../src/client/spatial/portal/notices.ts'
import { NoticesMenu, NoticesSurface } from '../src/client/spatial/portal/NoticesSurface.tsx'
import { installPortal } from '../src/client/spatial/portal/index.ts'

const PAGE = 'a'.repeat(40)
const EDGE = 'b'.repeat(40)
const RUNNING = { ballId: 'c'.repeat(64), epoch: 171 }
const PUBLISHED = { ballId: 'd'.repeat(64), epoch: 172 }
const LAG = { published: PUBLISHED, running: RUNNING, newer: true }

function memoryOf(): BuildMemory & { readonly map: Map<string, string> } {
  const map = new Map<string, string>()
  return {
    map, getItem: key => map.get(key) ?? null, setItem: (key, value) => { map.set(key, value) }, removeItem: (key) => { map.delete(key) },
  }
}
const visibleDoc = { visibilityState: 'visible' as const, addEventListener: () => {}, removeEventListener: () => {} }

/** The feed, the launcher and the surface, as the frame and the portal mount them, over local stand-ins. */
function mount({ edge, lag }: { edge: string; lag: boolean }) {
  const memory = memoryOf()
  const fetchImpl = vi.fn<BuildFetch>(async () => Response.json({ ok: true, schema: 'aukora.build.v1', sourceRevision: edge }))
  const tunnelCalls: string[] = []
  const tunnel: PageTunnel = async (path) => {
    tunnelCalls.push(path)
    return { status: 200, text: async () => JSON.stringify(lag ? { ok: true, headLag: LAG } : { ok: true, headLag: null }) }
  }
  function Shell() {
    const [activeSurface, setActive] = useState<string | undefined>(undefined)
    useNoticeFeed(true, {
      edge: { fetchImpl, pageRevision: PAGE, memory, doc: visibleDoc, tunnel: null }, lag: { tunnel, doc: visibleDoc },
    })
    const owner = { activeSurface, openSurface: (id: string) => { setActive(id) }, closeSurface: () => { setActive(undefined) } }
    return (
      <>
        <div data-testid="menu"><NoticesMenu {...(owner as unknown as Parameters<typeof NoticesMenu>[0])} /></div>
        <div data-testid="centre"><NoticesSurface {...(owner as unknown as Parameters<typeof NoticesSurface>[0])} /></div>
      </>
    )
  }
  const view = render(<Shell />)
  // The launcher's data attributes sit on its head (the button); its tone sits on the portal frame around it.
  const head = (): HTMLButtonElement => view.container.querySelector<HTMLButtonElement>('button[data-notices-launcher]')!
  const launcher = (): HTMLElement => head().closest<HTMLElement>('.ak-portal')!
  const open = (): void => { fireEvent.click(head()) }
  const surface = (): HTMLElement | null => view.container.querySelector<HTMLElement>('[data-notices-surface]')
  return { view, memory, fetchImpl, tunnelCalls, launcher, head, open, surface }
}
const settle = async (): Promise<void> => { await act(async () => { await vi.advanceTimersByTimeAsync(0) }) }

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => {
  cleanup()
  resetNoticesForTests()
  resetReloadHoldsForTests()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('the model: one list, fed by build-notice.ts\'s two kinds', () => {
  it('nothing differs: no notice; each cause is one entry in its own words; both share the one reload', () => {
    expect(noticeEntriesOf(null, null, PAGE)).toEqual([])
    const [build] = noticeEntriesOf(EDGE, null, PAGE)
    expect(build).toMatchObject({ id: `build:${EDGE}`, kind: 'build', what: EDGE_BUILD_WORDS.what, action: { label: 'Reload' } })
    const both = noticeEntriesOf(EDGE, LAG, PAGE)
    expect(both.map(entry => [entry.kind, entry.what])).toEqual([['build', EDGE_BUILD_WORDS.what], ['auma', headLagWords(LAG).what]])
    expect(both[0]?.action.run).toBe(both[1]?.action.run)
  })

  it('a notice keeps when it was first seen while it stays, newest first, and is forgotten when it goes', () => {
    const [build] = noticeEntriesOf(EDGE, null, PAGE)
    const [, auma] = noticeEntriesOf(EDGE, LAG, PAGE)
    publishNotices('frame', [build!], 1_000)
    publishNotices('frame', [build!, auma!], 2_000)
    expect(currentNotices().map(notice => [notice.kind, notice.firstSeen])).toEqual([['auma', 2_000], ['build', 1_000]])
    publishNotices('frame', [auma!], 3_000)
    publishNotices('frame', [build!, auma!], 4_000)
    expect(currentNotices().map(notice => [notice.kind, notice.firstSeen])).toEqual([['build', 4_000], ['auma', 2_000]])
  })

  it('every reader publishes into the one list: merged by id, one row per kind, and a reader that goes takes its own', () => {
    const [build] = noticeEntriesOf(EDGE, null, PAGE)
    const [, auma] = noticeEntriesOf(EDGE, LAG, PAGE)
    // Aura (the boot app) found the lag; the frame found nothing yet: one row.
    publishNotices('aura', [auma!], 1_000)
    publishNotices('frame', [], 1_500)
    expect(currentNotices().map(notice => notice.id)).toEqual([auma!.id])
    // Work and the frame find the same lag later: still one row, first seen when Aura saw it.
    publishNotices('work', [auma!], 2_000)
    publishNotices('frame', [build!, auma!], 3_000)
    expect(currentNotices().map(notice => [notice.id, notice.firstSeen])).toEqual([[build!.id, 3_000], [auma!.id, 1_000]])
    // Aura and Work go; the frame still holds both.
    publishNotices('aura', [], 4_000)
    publishNotices('work', [], 4_000)
    expect(currentNotices()).toHaveLength(2)
    // Two readers that found different heads of one kind give one row: the one first seen last.
    const later = { ...LAG, published: { ballId: 'e'.repeat(64), epoch: 173 } }
    const [newer] = noticeEntriesOf(null, later, PAGE)
    publishNotices('work', [newer!], 5_000)
    expect(currentNotices().filter(notice => notice.kind === 'auma').map(notice => notice.id)).toEqual([newer!.id])
    expect(currentNotices()).toHaveLength(2)
    // Every reader gone: nothing is shown, and nothing is remembered.
    publishNotices('work', [], 6_000)
    publishNotices('frame', [], 6_000)
    expect(currentNotices()).toEqual([])
    publishNotices('frame', [auma!], 7_000)
    expect(currentNotices()[0]?.firstSeen).toBe(7_000)
  })

  it('first seen: the time today, the date and time before today; the name says the count', () => {
    const now = new Date(2026, 10, 13, 18, 30).getTime()
    expect(firstSeenText(new Date(2026, 10, 13, 9, 5).getTime(), now)).toBe('First seen at 09:05')
    expect(firstSeenText(new Date(2026, 10, 12, 23, 59).getTime(), now)).toBe('First seen 12 Nov at 23:59')
    expect(firstSeenText(new Date(2025, 11, 31, 7, 0).getTime(), now)).toBe('First seen 31 Dec 2025 at 07:00')
    expect(noticesLabel(0)).toBe('Notices, nothing waiting')
    expect(noticesLabel(2)).toBe('Notices, 2 waiting')
  })
})

describe('the launcher and the list', () => {
  it('with no notice: the launcher is there, not gold, no count; opened, the list says one line', async () => {
    const page = mount({ edge: PAGE, lag: false })
    await settle()
    expect(page.launcher()).not.toBeNull()
    expect(page.launcher().className).not.toContain('ak-tone-gold')
    expect(page.launcher().className).toContain('ak-tone-blue')
    expect(page.launcher().querySelector('.ak-pill')).toBeNull()
    expect(page.head().getAttribute('data-waiting')).toBe('0')
    expect(page.head().getAttribute('aria-label')).toBe('Notices, nothing waiting')
    expect(page.head().textContent).toContain('Notices')
    // Closed, the surface draws nothing.
    expect(page.surface()?.hidden).toBe(true)
    expect(page.surface()?.textContent).toBe('')
    page.open()
    expect(page.surface()?.hidden).toBe(false)
    expect(page.head().getAttribute('aria-current')).toBe('page')
    expect(page.surface()?.querySelector('.ak-header__title')?.textContent).toBe('NOTICES')
    expect(page.surface()?.querySelector('[data-notices-empty]')?.textContent).toBe(NOTHING_WAITING)
    expect(page.surface()?.querySelectorAll('[data-notice]')).toHaveLength(0)
  })

  it('a new build: gold with 1; its row says so, and its Reload is the pill\'s own reload', async () => {
    const reload = vi.spyOn(pageReload, 'now').mockImplementation(() => {})
    const page = mount({ edge: EDGE, lag: false })
    await settle()
    expect(page.head().getAttribute('data-waiting')).toBe('1')
    expect(page.launcher().className).toContain('ak-tone-gold')
    expect(page.launcher().querySelector('.ak-pill.ak-tone-gold')?.textContent).toBe('1')
    expect(page.head().getAttribute('aria-label')).toBe('Notices, 1 waiting')
    page.open()
    const rows = page.surface()!.querySelectorAll<HTMLElement>('[data-notice]')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.getAttribute('data-notice-id')).toBe(`build:${EDGE}`)
    expect(rows[0]?.textContent).toContain(EDGE_BUILD_WORDS.what)
    expect(rows[0]?.textContent).toMatch(/First seen at \d\d:\d\d/u)
    const button = rows[0]!.querySelector<HTMLButtonElement>('button[data-notice-action="build"]')!
    expect(button.textContent).toBe('Reload')
    // While an approval is in flight the press keeps the page, as the pill's did, and the list says why.
    const release = holdReload()
    await settle()
    expect(page.surface()?.querySelector('[data-reload-held]')).not.toBeNull()
    fireEvent.click(button)
    expect(reload).not.toHaveBeenCalled()
    expect(page.memory.map.has(BUILD_RELOAD_FOR_KEY)).toBe(false)
    act(() => { release() })
    // The same press as the pill: the edge build it reloads for is remembered, then the page reloads once.
    fireEvent.click(button)
    expect(page.memory.map.get(BUILD_RELOAD_FOR_KEY)).toBe(EDGE)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('both notices at once: 2, and two rows, newest first', async () => {
    const page = mount({ edge: EDGE, lag: true })
    await settle()
    expect(page.head().getAttribute('data-waiting')).toBe('2')
    expect(page.head().getAttribute('aria-label')).toBe('Notices, 2 waiting')
    page.open()
    const rows = [...page.surface()!.querySelectorAll<HTMLElement>('[data-notice]')]
    expect(rows.map(row => row.getAttribute('data-notice'))).toHaveLength(2)
    expect(new Set(rows.map(row => row.getAttribute('data-notice')))).toEqual(new Set(['build', 'auma']))
    expect(rows.map(row => row.querySelector('button')?.textContent)).toEqual(['Reload', 'Reload'])
    const seen = currentNotices().map(notice => notice.firstSeen)
    expect([...seen].sort((a, b) => b - a)).toEqual(seen)
    expect(rows.find(row => row.getAttribute('data-notice') === 'auma')?.textContent).toContain(headLagWords(LAG).what)
  })

  it('opening Notices changes no stored setting, sends no request, and moves no focus by itself', async () => {
    const page = mount({ edge: EDGE, lag: true })
    await settle()
    const fetches = page.fetchImpl.mock.calls.length
    const tunnels = page.tunnelCalls.length
    const local = vi.spyOn(Storage.prototype, 'setItem')
    const removed = vi.spyOn(Storage.prototype, 'removeItem')
    const globalFetch = vi.fn()
    vi.stubGlobal('fetch', globalFetch)
    const focused = document.activeElement
    // The notice arrived: nothing opened and nothing took the focus.
    expect(page.surface()?.hidden).toBe(true)
    expect(document.activeElement).toBe(focused)
    page.open()
    expect(page.surface()?.hidden).toBe(false)
    fireEvent.click(page.head())
    expect(page.surface()?.hidden).toBe(true)
    expect(local).not.toHaveBeenCalled()
    expect(removed).not.toHaveBeenCalled()
    expect(globalFetch).not.toHaveBeenCalled()
    expect(page.fetchImpl.mock.calls.length).toBe(fetches)
    expect(page.tunnelCalls.length).toBe(tunnels)
    expect(page.memory.map.size).toBe(0)
  })

  it('no element that carries a notice is fixed or absolutely positioned, by its own style or by any rule for its classes', async () => {
    const page = mount({ edge: EDGE, lag: true })
    await settle()
    page.open()
    const carriers = [page.launcher(), page.surface()!]
    const elements = carriers.flatMap(root => [root, ...root.querySelectorAll<HTMLElement>('*')])
    expect(elements.length).toBeGreaterThan(10)
    const classes = new Set<string>()
    for (const element of elements) {
      expect(element.style.position, element.outerHTML.slice(0, 80)).not.toMatch(/fixed|absolute|sticky/u)
      expect(getComputedStyle(element).position).not.toMatch(/fixed|absolute|sticky/u)
      for (const name of element.classList) classes.add(name)
    }
    // jsdom loads no stylesheet: read the sheets these classes come from, and every rule whose last compound selector
    // names one of them positions nothing out of the flow.
    const read = (file: string): string => {
      const path = ['', '../../../'].map(prefix => resolve(process.cwd(), `${prefix}packages/client/ui-layout/src/client/spatial/${file}`))
        .find(existsSync)
      if (path === undefined) throw new Error(`not found: ${file}`)
      return readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\//gu, '')
    }
    const sheets = ['primitives/primitives.css', 'primitives/skin-face.css', 'primitives/skin-tabs.css', 'portal/spatial-layer.css',
      'portal/spatial-layer-fit.css'].map(read).join('\n')
    let checked = 0
    for (const [, selectors = '', body = ''] of sheets.matchAll(/([^{}@]+)\{([^{}]*)\}/gu)) {
      for (const selector of selectors.split(',')) {
        const subject = selector.trim().split(/\s+|>|\+|~/u).filter(Boolean).at(-1) ?? ''
        const named = [...subject.matchAll(/\.([\w-]+)/gu)].map(([, name]) => name ?? '')
        if (!named.some(name => classes.has(name))) continue
        checked += 1
        expect(body, selector.trim()).not.toMatch(/position:\s*(fixed|absolute|sticky)/u)
      }
    }
    expect(checked).toBeGreaterThan(5)
  })
})

describe('an app that reads for itself (Work, Aura Coherence) feeds the same list', () => {
  it('its one read is its own header button and the gold count; it goes when the app goes', async () => {
    const memory = memoryOf()
    const fetchImpl = vi.fn<BuildFetch>(async () => Response.json({ ok: true, schema: 'aukora.build.v1', sourceRevision: EDGE }))
    const options = {
      edge: { fetchImpl, pageRevision: PAGE, memory, doc: visibleDoc, tunnel: null }, lag: { tunnel: null, doc: visibleDoc },
    }
    let header: ReloadNotice | null = null
    function App() {
      header = useReloadNoticeFeed(true, options)
      return null
    }
    function Shell({ app }: { app: boolean }) {
      const owner = { activeSurface: undefined, openSurface: () => {}, closeSurface: () => {} }
      // The frame's own feed is off while such an app is open: it neither reads nor finds anything.
      useNoticeFeed(false, options)
      return <>{app ? <App /> : null}<NoticesMenu {...(owner as unknown as Parameters<typeof NoticesMenu>[0])} /></>
    }
    const view = render(<Shell app />)
    await settle()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const head = view.container.querySelector<HTMLButtonElement>('button[data-notices-launcher]')!
    expect(head.getAttribute('data-waiting')).toBe('1')
    expect(head.getAttribute('aria-label')).toBe('Notices, 1 waiting')
    expect(header).not.toBeNull()
    expect(header!.words.button).toBe(EDGE_BUILD_WORDS.button)
    expect(currentNotices()[0]?.id).toBe(`build:${EDGE}`)
    view.rerender(<Shell app={false} />)
    expect(head.getAttribute('data-waiting')).toBe('0')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
})

describe('where it is registered', () => {
  it('Notices is the system menu\'s first entry (ahead of Work at order 0), and its surface is a centre app', () => {
    const registrations: { options: { name: string; id?: string; order?: number }; component: unknown }[] = []
    const ctx = {
      slots: {
        inject: (_name: string, register: () => unknown) => { register() },
        register: (options: { name: string; id?: string; order?: number }, component: unknown) => {
          registrations.push({ options, component })
          return () => {}
        },
      },
      locale: { register: () => () => {} },
      effect: (run: () => unknown) => run(),
      inject: () => {},
    }
    installPortal(ctx as never)
    const system = registrations.filter(entry => entry.options.name === 'shell.menu.system')
      .sort((a, b) => (a.options.order ?? 0) - (b.options.order ?? 0))
    expect(system[0]).toMatchObject({ options: { id: NOTICES_SURFACE, order: -10 }, component: NoticesMenu })
    expect(system[0]!.options.order!).toBeLessThan(0)
    expect(registrations.find(entry => entry.options.name === 'shell.surface' && entry.options.id === NOTICES_SURFACE)?.component)
      .toBe(NoticesSurface)
  })
})
