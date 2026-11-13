// @vitest-environment jsdom
/**
 * THE COMPACT SPATIAL FRAME (Spatial design spec sections 6, 7, 9 and 12B). At 1023px and below the
 * real Spatial frame (`src/client/spatial/AppFrame.tsx` on `src/client/spatial/stores.ts`, not the stock harness frame)
 * shows one lane at a time at full width, navigated by its own corners; at 1024px and above NOTHING changes.
 *
 * jsdom does no layout, so geometry is pinned by what the stylesheet says, and behaviour by what the frame renders and
 * does when its real corners and its real menu launchers are pressed. Only the heavy lane occupants are stand-ins.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { useLayoutEffect, useState, type ReactNode } from 'react'
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { AppFrame, COMPACT_QUERY, visibleViewportOf, type AppFrameProps } from '../src/client/spatial/AppFrame.tsx'
import { LayoutController, panelIdOfSurface } from '../src/client/spatial/service.ts'
import { createLayoutStore, type PanePreset } from '../src/client/spatial/stores.ts'
import { SystemMenu } from '../src/client/spatial/portal/menus.tsx'
import { RightbarSeat, type RightbarSeatProps } from '../../ui-sidebar-right/src/client/shell/SidebarRight.tsx'
import { createSidebarRightStore } from '../../ui-sidebar-right/src/client/stores.ts'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import { WORK_SURFACE, WorkSurface } from '../src/client/spatial/work/WorkSurface.tsx'
import { en as workLabels } from '../src/client/spatial/work/labels.ts'
import { AuraPentoraSurface } from '../src/client/spatial/aura/AuraPentoraSurface.tsx'
import { AURA_SURFACE } from '../src/client/spatial/aura/model.ts'
import { HEAD_LAG_ROUTE } from '../src/client/spatial/portal/build-notice.ts'
import { NoticesMenu, NoticesSurface } from '../src/client/spatial/portal/NoticesSurface.tsx'
import { NOTICES_SURFACE, resetNoticesForTests } from '../src/client/spatial/portal/notices.ts'

// The lane occupants are not what this spec is about; each stand-in keeps the one door the frame hands it.
vi.mock('../src/client/spatial/eyes/page-eyes.ts', () => ({ installPageEyes: () => () => {} }))
vi.mock('../src/client/spatial/portal/ThreadsLane.tsx', () => ({
  ThreadsLane: (props: { openConversation: () => void }) => (
    <div data-thread-view="list">
      <header><h2 data-testid="threads-heading">Threads</h2></header>
      <button type="button" data-testid="open-thread" onClick={props.openConversation} />
    </div>
  ),
}))
vi.mock('../src/client/spatial/portal/FingerprintWaiting.tsx', () => ({
  FingerprintWaiting: (props: { openSovereignty: () => void }) => (
    <aside data-fingerprint-waiting="outcome" data-testid="fingerprint-card">
      <button type="button" data-testid="fingerprint-inspect" onClick={props.openSovereignty} />
    </aside>
  ),
}))

const read = (file: string): string => {
  const path = ['', '../../../'].map(prefix => resolve(process.cwd(), `${prefix}${file}`)).find(existsSync)
  if (path === undefined) throw new Error(`not found: ${file}`)
  return readFileSync(path, 'utf8')
}
const SHEET = read('packages/client/ui-layout/src/client/spatial/SpatialFrame.module.css')
const INDEX = read('apps/web/index.html')
const THREADS_SHEET = read('packages/client/ui-layout/src/client/spatial/portal/ThreadsLane.module.css')
const FINGERPRINT_SHEET = read('packages/client/ui-layout/src/client/spatial/portal/FingerprintWaiting.module.css')
const COMPACT_OPEN = '@media (max-width: 1023px) {'

/** The compact block (everything inside the one compact `@media`), and the sheet without it. */
function splitCompact(sheet: string): { compact: string; desktop: string } {
  const open = sheet.indexOf(COMPACT_OPEN)
  if (open === -1) throw new Error('no compact block')
  let depth = 0
  let end = -1
  for (let at = sheet.indexOf('{', open); at < sheet.length; at += 1) {
    if (sheet[at] === '{') depth += 1
    else if (sheet[at] === '}') {
      depth -= 1
      if (depth === 0) { end = at + 1; break }
    }
  }
  if (end === -1) throw new Error('unclosed compact block')
  if (sheet.indexOf('@media (max-width: 1023px)', end) !== -1) throw new Error('a second compact block')
  return { compact: sheet.slice(open, end), desktop: sheet.slice(0, open) + sheet.slice(end) }
}

const uncommented = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//gu, '')

/** Every rule body in the block whose selector list is exactly `selector`. */
function ruleBody(css: string, selector: string): string {
  const rules = [...uncommented(css).matchAll(/([^{}]+)\{([^{}]*)\}/gu)]
  return rules.filter(([, head = '']) => head.trim().replace(/\s+/gu, ' ') === selector).map(([, , body = '']) => body).join('\n')
}

/** Every `grid-template-*` declaration with the selector of its rule, in file order. */
function gridTemplates(sheet: string): string[] {
  const rules = [...uncommented(sheet).matchAll(/([^{}]+)\{([^{}]*)\}/gu)]
  return rules.flatMap(([, selector = '', body = '']) => [...body.matchAll(/(grid-template-(?:columns|rows)):\s*([^;]+);/gu)]
    .map(([, property, value]) => `${selector.trim().replace(/\s+/gu, ' ')} { ${property}: ${value?.trim()} }`))
}

// THE DESKTOP GRID, AS IT WAS AT AN EARLIER COMMIT, declaration for declaration.
const DESKTOP_GRID = [
  '.frame { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1fr) }',
  '.frame { grid-template-rows: minmax(0, 1fr) }',
  ".frame[data-pane-preset='left-wide'] { grid-template-columns: minmax(0, 2fr) minmax(0, 1fr) 0fr }",
  ".frame[data-pane-preset='left-menu-wide'] { grid-template-columns: minmax(0, 2fr) 0fr minmax(0, 1fr) }",
  ".frame[data-pane-preset='left-focus'] { grid-template-columns: minmax(0, 3fr) minmax(0, 0fr) minmax(0, 0fr) }",
  ".frame[data-pane-preset='center-left-wide'] { grid-template-columns: 0fr minmax(0, 2fr) minmax(0, 1fr) }",
  ".frame[data-pane-preset='center-right-wide'] { grid-template-columns: minmax(0, 1fr) minmax(0, 2fr) 0fr }",
  ".frame[data-pane-preset='center-focus'] { grid-template-columns: minmax(0, 0fr) minmax(0, 3fr) minmax(0, 0fr) }",
  ".frame[data-pane-preset='right-wide'] { grid-template-columns: 0fr minmax(0, 1fr) minmax(0, 2fr) }",
  ".frame[data-pane-preset='right-threads-wide'] { grid-template-columns: minmax(0, 1fr) 0fr minmax(0, 2fr) }",
  ".frame[data-pane-preset='right-focus'] { grid-template-columns: minmax(0, 0fr) minmax(0, 0fr) minmax(0, 3fr) }",
]

describe('the stylesheet: compact is one scoped block, and the desktop did not move', () => {
  it('outside the compact block the grid template is exactly the desktop one it was, and the corners are still 74px', () => {
    const { desktop } = splitCompact(SHEET)
    expect(gridTemplates(desktop)).toEqual(DESKTOP_GRID)
    expect(ruleBody(desktop, '.frame')).toContain('--dsh-hot-corner-size: 74px;')
    expect(ruleBody(desktop, '.cornerControl')).toContain('width: var(--dsh-hot-corner-size);')
  })

  it('opens at the query the frame reads, names nothing compact outside it, and scopes every rule to the compact frame', () => {
    const { compact, desktop } = splitCompact(SHEET)
    expect(COMPACT_QUERY).toBe('(max-width: 1023px)')
    expect(compact.startsWith(`@media ${COMPACT_QUERY} {`)).toBe(true)
    expect(uncommented(desktop)).not.toMatch(/data-compact|compact-next|compact-previous|dvh|--dsh-compact/u)
    const selectors = [...uncommented(compact.slice(compact.indexOf('{') + 1)).matchAll(/([^{}]+)\{/gu)]
      .flatMap(([, list = '']) => list.split(','))
      .map(selector => selector.trim())
    expect(selectors.length).toBeGreaterThan(10)
    for (const selector of selectors) expect(selector).toMatch(/^\.frame\[data-compact-lane\]/u)
    expect(compact).not.toContain('!important')
  })

  it('one full-width column; 100vh before 100dvh; every safe-area edge; the visible viewport while it is known', () => {
    const { compact } = splitCompact(SHEET)
    const frame = ruleBody(compact, '.frame[data-compact-lane]')
    expect(frame).toContain('grid-template-columns: minmax(0, 1fr);')
    expect(frame).toContain('gap: 0;')
    expect(frame).toContain('transition: none;')
    expect(frame.indexOf('height: 100vh;')).toBeGreaterThan(-1)
    expect(frame.indexOf('height: 100dvh;')).toBeGreaterThan(frame.indexOf('height: 100vh;'))
    for (const edge of ['top', 'right', 'bottom', 'left']) expect(frame).toContain(`env(safe-area-inset-${edge}, 0px)`)
    const visible = ruleBody(compact, '.frame[data-compact-lane][data-compact-viewport]')
    expect(visible).toContain('height: var(--dsh-compact-visible-height);')
    expect(visible).toContain('top: var(--dsh-compact-visible-top);')
    const lane = ruleBody(compact, '.frame[data-compact-lane] > .lane')
    expect(lane).toContain('grid-column: 1;')
    expect(lane).toContain('grid-row: 1;')
    expect(SHEET).toMatch(/\.frame\[data-compact-lane\] \.laneShell,[^{]*\{[^}]*width: 100%;/u)
  })

  it('corners keep their native glow on a 44px hit area, content keeps 52px clear, and focus is visible', () => {
    const { compact } = splitCompact(SHEET)
    expect(ruleBody(compact, '.frame[data-compact-lane]')).toMatch(/--dsh-compact-corner-hit: 44px;[\s\S]*--dsh-compact-corner-clearance: 52px;/u)
    const corner = ruleBody(compact, '.frame[data-compact-lane] .cornerControl')
    expect(corner).toContain('width: var(--dsh-compact-corner-hit);')
    expect(corner).toContain('height: var(--dsh-compact-corner-hit);')
    expect(ruleBody(compact, '.frame[data-compact-lane] .cornerControl::before')).toContain('width: var(--dsh-hot-corner-size);')
    expect(ruleBody(compact, '.frame[data-compact-lane] .cornerControl:focus-visible')).toContain('outline: 2px solid')
    expect(compact).toMatch(/\.frame\[data-compact-lane\] \.menuHeader \{[^}]*margin-inline: var\(--dsh-compact-corner-clearance\);/u)
    // The thread list's header takes the same clearance in its owner, not in the frame.
    expect(compact).not.toContain("data-thread-view='list'")
    expect(uncommented(THREADS_SHEET))
      .toMatch(/:global\(\[data-compact-lane\]\) \.head \{[^}]*margin-inline: var\(--dsh-compact-corner-clearance\);/u)
    expect(ruleBody(compact, '.frame[data-compact-lane] .threadConversationBody :global(header[data-window-drag])'))
      .toContain('padding-inline: var(--dsh-compact-corner-clearance);')
    expect(ruleBody(compact, '.frame[data-compact-lane] .menuTab')).toMatch(/width: 44px;[\s\S]*height: 44px;/u)
  })

  it('the Fingerprint card starts below the compact corner band, so both upper corners of its lane stay in reach', () => {
    const { compact } = splitCompact(SHEET)
    const px = (name: string): number => Number(new RegExp(`${name}: (\\d+)px;`, 'u').exec(ruleBody(compact, '.frame[data-compact-lane]'))?.[1])
    expect(px('--dsh-compact-corner-clearance')).toBeGreaterThanOrEqual(px('--dsh-compact-corner-hit'))
    // Where the card sits is its owner's now; the frame keeps no rule of its own for it.
    expect(compact).not.toContain('data-fingerprint-waiting')
    const card = ruleBody(FINGERPRINT_SHEET, 'aside.card[data-fingerprint-waiting]')
    expect(card).toContain('top: var(--dsh-compact-corner-clearance, 12px);')
    expect(card).toContain('max-height: calc(100% - var(--dsh-compact-corner-clearance, 12px) - 12px);')
  })

  it('wide, the frame keeps clear of a safe-area inset, and where the inset is zero every padding is what it was', () => {
    const { desktop } = splitCompact(SHEET)
    const rules = [...uncommented(desktop).matchAll(/([^{}]+)\{([^{}]*)\}/gu)]
    const safe = rules.flatMap(([, selector = '', body = '']) => [...body.matchAll(/(padding(?:-left|-right)?):\s*([^;]*safe-area[^;]*);/gu)]
      .map(([, property = '', value = '']) => ({ selector: selector.trim().replace(/\s+/gu, ' '), property, value: value.replace(/\s+/gu, ' ').trim() })))
    /** The value with each inset given, `max()` resolved: what the browser computes. */
    const at = (value: string, insets: Record<string, number>): string => value
      .replace(/env\(safe-area-inset-(\w+), 0px\)/gu, (_, edge: string) => `${String(insets[edge] ?? 0)}px`)
      .replace(/max\((\d+)px, (\d+)px\)/gu, (_, a: string, b: string) => `${String(Math.max(Number(a), Number(b)))}px`)
    // At an earlier commit: `.frame` 10px, the focused frame 0, the two edge-to-edge presets 0 on their open side.
    expect(safe.map(({ selector, property, value }) => `${selector} { ${property}: ${at(value, {})} }`)).toEqual([
      '.frame { padding: 10px 10px 10px 10px }',
      ".frame[data-single-measure='two-thirds'] { padding: 0px 0px 0px 0px }",
      ".frame[data-pane-preset='center-left-wide'] { padding-left: 0px }",
      ".frame[data-pane-preset='center-right-wide'] { padding-right: 0px }",
    ])
    // An iPad in landscape, installed to the home screen: the home indicator's 20px is kept clear on every preset.
    expect(safe.map(({ value }) => at(value, { bottom: 20, left: 0, right: 0, top: 24 }))).toEqual([
      '24px 10px 20px 10px', '24px 0px 20px 0px', '0px', '0px',
    ])
  })

  it('the page reaches the screen edges for the safe-area padding, and pinch zoom stays the browser\'s', () => {
    const viewport = /<meta name="viewport" content="([^"]*)" \/>/u.exec(INDEX)?.[1] ?? ''
    expect(viewport).toBe('width=device-width, initial-scale=1, viewport-fit=cover')
    expect(viewport).not.toMatch(/user-scalable|maximum-scale|minimum-scale/u)
  })
})

describe('the visible viewport', () => {
  it('is the visual viewport\'s height and pan, never above the frame, and nothing while pinch-zoomed', () => {
    expect(visibleViewportOf({ height: 844, offsetTop: 0, scale: 1 }, 0)).toEqual({ height: 844, top: 0 })
    // The keyboard is up: the visible part is 508px tall and the frame keeps to it.
    expect(visibleViewportOf({ height: 508.6, offsetTop: 0, scale: 1 }, 0)).toEqual({ height: 508, top: 0 })
    // Safari panned the page 120px to the focused field: the frame moves down by the pan.
    expect(visibleViewportOf({ height: 508, offsetTop: 120, scale: 1 }, 0)).toEqual({ height: 508, top: 120 })
    expect(visibleViewportOf({ height: 508, offsetTop: 0, scale: 1 }, 40)).toEqual({ height: 508, top: 0 })
    expect(visibleViewportOf({ height: 400, offsetTop: 0, scale: 2 }, 0)).toBeNull()
    expect(visibleViewportOf({ height: 0, offsetTop: 0, scale: 1 }, 0)).toBeNull()
  })
})

describe('the layout store: compact state apart from the desktop preset', () => {
  const store = () => createLayoutStore().create()

  it('compact corners name lanes and never move the desktop preset', () => {
    const handle = store()
    const { actions } = handle
    const getSnapshot = () => handle.getSnapshot()
    act(() => { actions.cycleLeft() })
    expect(getSnapshot().panePreset).toBe('left-wide')
    actions.enterCompact()
    expect(getSnapshot()).toMatchObject({ compact: true, compactLane: 'left' })
    actions.cycleLeft()
    expect(getSnapshot().compactLane).toBe('center')
    actions.cycleCenterRight()
    expect(getSnapshot().compactLane).toBe('right')
    actions.cycleRight()
    expect(getSnapshot().compactLane).toBe('center')
    actions.cycleCenterLeft()
    expect(getSnapshot().compactLane).toBe('left')
    actions.toggleSidebar()
    expect(getSnapshot().compactLane).toBe('center')
    actions.showCompactLane('right')
    expect(getSnapshot().compactLane).toBe('right')
    expect(getSnapshot().panePreset).toBe('left-wide')
    actions.leaveCompact()
    expect(getSnapshot()).toMatchObject({ compact: false, panePreset: 'left-wide' })
  })

  it('what opens comes to the front: an app shows the centre, a thread or the list shows the left, details the right', () => {
    const handle = store()
    const { actions } = handle
    const getSnapshot = () => handle.getSnapshot()
    actions.enterCompact('right')
    actions.selectSurface('identity')
    expect(getSnapshot()).toMatchObject({ activeSurface: 'identity', compactLane: 'center' })
    actions.openConversation()
    expect(getSnapshot()).toMatchObject({ conversationOpen: true, compactLane: 'left' })
    actions.showCompactLane('center')
    actions.closeConversation()
    expect(getSnapshot()).toMatchObject({ conversationOpen: false, compactLane: 'left' })
    actions.openDetails()
    expect(getSnapshot()).toMatchObject({ detailsOpen: true, compactLane: 'right', panePreset: 'balanced' })
  })

  it('compact, opening an app or a thread does not rewrite a desktop preset that hides its lane', () => {
    const handle = store()
    const { actions } = handle
    const getSnapshot = () => handle.getSnapshot()
    actions.cycleRight()
    actions.cycleRight()
    expect(getSnapshot().panePreset).toBe('right-focus')
    actions.enterCompact()
    actions.selectSurface('sovereignty')
    actions.openConversation()
    actions.openDetails()
    expect(getSnapshot().panePreset).toBe('right-focus')
    actions.leaveCompact()
    // Wide again, the same actions keep their desktop meaning.
    actions.selectSurface('identity')
    expect(getSnapshot().panePreset).toBe('balanced')
  })

  it('wide, every action does exactly what it did before', () => {
    const handle = store()
    const { actions } = handle
    const getSnapshot = () => handle.getSnapshot()
    const seen: PanePreset[] = []
    for (const step of ['cycleLeft', 'cycleLeft', 'cycleCenterLeft', 'cycleCenterRight', 'cycleRight', 'cycleRight'] as const) {
      actions[step]()
      seen.push(getSnapshot().panePreset)
    }
    expect(seen).toEqual(['left-wide', 'left-focus', 'left-focus', 'left-focus', 'left-focus', 'left-focus'])
    actions.toggleSidebar()
    expect(getSnapshot().panePreset).toBe('center-left-wide')
    actions.openConversation()
    expect(getSnapshot().panePreset).toBe('balanced')
    actions.openDetails()
    expect(getSnapshot()).toMatchObject({ panePreset: 'balanced', detailsOpen: true, compact: false })
  })
})

// ── The frame itself ─────────────────────────────────────────────────────────────────────────────────────────────

type Listener = () => void
let compactMatches: boolean
let queryListeners: Set<Listener>
let viewport: EventTarget & { height: number; offsetTop: number; scale: number }
let frames: Map<number, FrameRequestCallback>
let nextFrame: number

/** Run the browser frames the page asked for. */
function flushFrames(): void {
  act(() => {
    for (const [id, callback] of [...frames]) {
      frames.delete(id)
      callback(0)
    }
  })
}

function crossTo(compact: boolean): void {
  compactMatches = compact
  act(() => { for (const listener of [...queryListeners]) listener() })
}

const SESSION = 's-compact' as SessionId

/** A surface with state of its own, to prove a running app is never remounted by navigation or resizing. */
function CountingSurface() {
  const [count, setCount] = useState(0)
  return <button type="button" data-testid="surface-count" onClick={() => { setCount(count + 1) }}>{count}</button>
}

interface SlotOwner { openSurface?: (id: string) => void; closeSurface?: () => void; activeSurface?: string }

/** What a spec puts in a slot in place of the default stand-in. */
interface MountOptions {
  /** The layout store instance, when the spec wires something to its actions before the frame mounts. */
  readonly instance?: ReturnType<ReturnType<typeof createLayoutStore>['create']>
  /** The current session is a real thread (details may show) rather than the blank boot session. */
  readonly realSession?: boolean
  readonly slots?: Partial<Record<string, (owner: never) => ReactNode>>
}

function mountFrame(options: MountOptions = {}) {
  const instance = options.instance ?? createLayoutStore().create()
  const sessions = {
    ids: [SESSION],
    // A fresh load: the boot session is blank, so the left lane opens on the thread list (conversation-opener.ts).
    byId: { [SESSION]: { id: SESSION, displayTitle: 'Compact', running: false, retainedBy: { mainView: 1 }, blank: options.realSession !== true } },
  }
  const owners: Record<string, SlotOwner> = {}
  const renderSlot = ((key: string, owner: SlotOwner, slotOptions?: { entryKey?: string }) => {
    owners[key] = owner
    const replaced = options.slots?.[key]
    if (replaced !== undefined) return replaced(owner as never)
    if (key === 'shell.menu.system') return <SystemMenu {...(owner as Parameters<typeof SystemMenu>[0])} />
    if (key === 'main' && slotOptions?.entryKey === 'conversation') return <textarea data-testid="composer" defaultValue="" />
    if (key === 'shell.surface') return <CountingSurface />
    return <div data-testid={`slot-${key}`} />
  }) as unknown as AppFrameProps['renderSlot']
  const props = {
    useStore: bindSnapshotSelector(instance),
    useSessions: ((selector: (value: typeof sessions) => unknown) => selector(sessions)) as unknown as AppFrameProps['useSessions'],
    renderSlot,
    actions: instance.actions,
    t: (key: string) => key,
  } as unknown as AppFrameProps
  const view = render(<AppFrame {...props} />)
  const frame = view.container.firstElementChild as HTMLElement
  const lane = (name: string): HTMLElement => frame.querySelector<HTMLElement>(`:scope > [data-lane="${name}"]`)!
  const active = (): string[] => ['left', 'center', 'right'].filter(name => lane(name).hasAttribute('data-pane-active'))
  const corner = (name: string): HTMLElement | null => frame.querySelector<HTMLElement>(`[data-corner="${name}"]`)
  const press = (name: string): void => { fireEvent.click(corner(name)!) }
  const launcher = (id: string): HTMLElement => frame.querySelector<HTMLElement>(`[data-launcher="${id}"]`)!
  return { ...view, instance, frame, lane, active, corner, press, launcher, owners }
}

beforeEach(() => {
  compactMatches = false
  queryListeners = new Set()
  vi.stubGlobal('matchMedia', (query: string) => ({
    media: query,
    get matches() { return query === COMPACT_QUERY && compactMatches },
    addEventListener: (_type: string, listener: Listener) => { queryListeners.add(listener) },
    removeEventListener: (_type: string, listener: Listener) => { queryListeners.delete(listener) },
  }))
  vi.stubGlobal('fetch', () => new Promise(() => {}))
  frames = new Map()
  nextFrame = 1
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    nextFrame += 1
    frames.set(nextFrame, callback)
    return nextFrame
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id) })
  viewport = Object.assign(new EventTarget(), { height: 844, offsetTop: 0, scale: 1 })
  vi.stubGlobal('visualViewport', viewport)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('at 1024px and wider: the desktop frame, unchanged', () => {
  it('carries the preset attributes and nothing compact; the boot preset shows all three lanes', () => {
    const { frame, active, corner, lane } = mountFrame()
    expect(frame.getAttributeNames().sort()).toEqual([
      'class', 'data-details-collapsed', 'data-pane-preset', 'data-surface-presentation',
    ])
    expect(frame.getAttribute('data-pane-preset')).toBe('balanced')
    expect(corner('compact-next')).toBeNull()
    expect(corner('compact-previous')).toBeNull()
    for (const name of ['left', 'center', 'right']) expect(lane(name).hasAttribute('tabindex')).toBe(false)
    expect(active()).toEqual(['left', 'center', 'right'])
  })

  it('the corners still cycle the thirds, with their own names', () => {
    const { instance, corner, press } = mountFrame()
    expect(corner('left')?.getAttribute('aria-label')).toBe('corner.left')
    expect(corner('center-left')?.getAttribute('aria-label')).toBe('corner.centerLeft')
    expect(corner('center-right')?.getAttribute('aria-label')).toBe('corner.centerRight')
    expect(corner('right')?.getAttribute('aria-label')).toBe('corner.right')
    press('left')
    expect(instance.getSnapshot().panePreset).toBe('left-wide')
    press('right')
    expect(instance.getSnapshot().panePreset).toBe('left-wide')
    press('center-right')
    expect(instance.getSnapshot().panePreset).toBe('left-menu-wide')
  })

  it('a focused preset hides the other lanes, and the menu\'s launcher still closes the app that is open', () => {
    const { instance, frame, active, launcher } = mountFrame()
    act(() => { instance.actions.cycleLeft(); instance.actions.cycleLeft() })
    expect(frame.getAttribute('data-focused-lane')).toBe('left')
    expect(frame.getAttribute('data-single-measure')).toBe('two-thirds')
    expect(active()).toEqual(['left'])
    act(() => { instance.actions.cycleLeft() })
    fireEvent.click(launcher('sovereignty'))
    expect(instance.getSnapshot().activeSurface).toBe('sovereignty')
    fireEvent.click(launcher('sovereignty'))
    expect(instance.getSnapshot().activeSurface).toBeUndefined()
  })
})

describe('at 1023px and below: one full-width lane, navigated by the native corners', () => {
  it('opens on the thread list alone, the other lanes hidden and inert, none of the desktop preset attributes', () => {
    compactMatches = true
    const { frame, lane, active, instance } = mountFrame()
    expect(instance.getSnapshot()).toMatchObject({ compact: true, compactLane: 'left' })
    expect(frame.getAttribute('data-compact-lane')).toBe('left')
    for (const name of ['data-pane-preset', 'data-focused-lane', 'data-single-measure']) expect(frame.hasAttribute(name)).toBe(false)
    expect(active()).toEqual(['left'])
    for (const name of ['center', 'right']) {
      expect(lane(name).hasAttribute('inert')).toBe(true)
      expect(lane(name).getAttribute('aria-hidden')).toBe('true')
    }
    expect(lane('left').hasAttribute('inert')).toBe(false)
  })

  it('corners are the native empty buttons, each named by the lane it shows; no extra arrows', () => {
    compactMatches = true
    const { frame, corner } = mountFrame()
    expect(corner('left')?.getAttribute('aria-label')).toBe('lane.surface')
    expect(corner('compact-previous')?.getAttribute('aria-label')).toBe('lane.menu')
    expect(corner('center-left')?.getAttribute('aria-label')).toBe('lane.threads')
    expect(corner('center-right')?.getAttribute('aria-label')).toBe('lane.menu')
    expect(corner('right')?.getAttribute('aria-label')).toBe('lane.surface')
    expect(corner('compact-next')?.getAttribute('aria-label')).toBe('lane.threads')
    for (const button of frame.querySelectorAll('[data-corner]')) {
      expect(button.tagName).toBe('BUTTON')
      expect(button.childNodes.length).toBe(0)
    }
    // No navigation control was added outside the lanes' own corner sets.
    expect(frame.querySelectorAll(':scope > :not([data-lane]):not([data-shell-overlay])').length).toBe(0)
  })

  it('the spec\'s navigation table, row by row, keeps every selection', () => {
    compactMatches = true
    const { frame, instance, active, press, launcher, getByTestId } = mountFrame()
    // Select an app in the menu: the app shows at full width.
    press('compact-previous')
    expect(active()).toEqual(['right'])
    fireEvent.click(launcher('sovereignty'))
    expect(instance.getSnapshot().activeSurface).toBe('sovereignty')
    expect(active()).toEqual(['center'])
    // The app's upper-left corner shows the current conversation (or the thread list).
    act(() => { fireEvent.click(getByTestId('open-thread')) })
    press('left')
    press('center-left')
    expect(active()).toEqual(['left'])
    expect(frame.querySelector('[data-thread-layer="conversation"]')?.hasAttribute('hidden')).toBe(false)
    // An open conversation's upper-left corner returns to the thread list.
    press('conversation-close')
    expect(active()).toEqual(['left'])
    expect(frame.querySelector('[data-thread-layer="list"]')?.hasAttribute('hidden')).toBe(false)
    // The app's upper-right corner shows the menu; the menu's previous corner returns to the active app.
    press('left')
    press('center-right')
    expect(active()).toEqual(['right'])
    press('right')
    expect(active()).toEqual(['center'])
    // The outer cycle continues both ways between the outer lanes, losing no selection.
    press('center-right')
    press('compact-next')
    expect(active()).toEqual(['left'])
    press('compact-previous')
    expect(active()).toEqual(['right'])
    expect(instance.getSnapshot()).toMatchObject({ activeSurface: 'sovereignty', conversationOpen: false, panePreset: 'balanced' })
  })

  it('selecting the app that is already open reveals it; it never empties the centre', () => {
    compactMatches = true
    const { instance, active, press, launcher, owners } = mountFrame()
    press('compact-previous')
    fireEvent.click(launcher('identity'))
    press('center-right')
    expect(launcher('identity').getAttribute('aria-current')).toBe('page')
    fireEvent.click(launcher('identity'))
    expect(instance.getSnapshot().activeSurface).toBe('identity')
    expect(active()).toEqual(['center'])
    // The app's own close (its Escape) still closes it: only the menu's door reveals instead.
    act(() => { owners['shell.surface']?.closeSurface?.() })
    expect(instance.getSnapshot().activeSurface).toBeUndefined()
  })

  it('the Fingerprint card floats in the thread stack itself, the box its own compact rule places it in', () => {
    compactMatches = true
    const { getByTestId } = mountFrame()
    expect(getByTestId('fingerprint-card').parentElement?.hasAttribute('data-thread-view')).toBe(true)
  })

  it('an approval\'s Inspect shows Sovereignty, and her own navigation shows what she opened', () => {
    compactMatches = true
    const { instance, active, getByTestId } = mountFrame()
    fireEvent.click(getByTestId('fingerprint-inspect'))
    expect(instance.getSnapshot().activeSurface).toBe('sovereignty')
    expect(active()).toEqual(['center'])
    act(() => { instance.actions.showCompactLane('right') })
    act(() => { instance.actions.selectSurface('aumlok', undefined, 'contained') })
    expect(active()).toEqual(['center'])
    act(() => { instance.actions.openDetails() })
    expect(active()).toEqual(['right'])
  })

  it('focus moves to a meaningful visible target in the lane brought to the front', () => {
    compactMatches = true
    const { lane, press, getByTestId, corner } = mountFrame()
    corner('left')?.focus()
    press('left')
    // The centre's stand-in has no heading: the lane itself takes focus, outside the tab order.
    expect(document.activeElement).toBe(lane('center'))
    expect(lane('center').getAttribute('tabindex')).toBe('-1')
    press('center-right')
    expect(document.activeElement?.getAttribute('role')).toBe('tab')
    expect(document.activeElement?.getAttribute('aria-selected')).toBe('true')
    press('compact-next')
    expect(document.activeElement).toBe(getByTestId('threads-heading'))
    expect(getByTestId('threads-heading').getAttribute('tabindex')).toBe('-1')
  })

  it('a draft, the conversation face and a running app survive lane changes and crossing the line both ways', () => {
    const { frame, instance, press, getByTestId } = mountFrame()
    act(() => { fireEvent.click(getByTestId('open-thread')) })
    const composer = getByTestId('composer') as HTMLTextAreaElement
    fireEvent.change(composer, { target: { value: 'half a thought' } })
    const counter = getByTestId('surface-count')
    fireEvent.click(counter)
    fireEvent.click(counter)
    crossTo(true)
    press('left')
    press('center-right')
    press('compact-next')
    crossTo(false)
    crossTo(true)
    expect(getByTestId('composer')).toBe(composer)
    expect(composer.value).toBe('half a thought')
    expect(getByTestId('surface-count')).toBe(counter)
    expect(counter.textContent).toBe('2')
    expect(instance.getSnapshot().conversationOpen).toBe(true)
    expect(frame.querySelector('[data-thread-layer="conversation"]')?.hasAttribute('hidden')).toBe(false)
  })

  it('returning to desktop width restores the desktop geometry the owner left', () => {
    const { frame, instance, active, press } = mountFrame()
    press('left')
    expect(frame.getAttribute('data-pane-preset')).toBe('left-wide')
    crossTo(true)
    expect(frame.hasAttribute('data-pane-preset')).toBe(false)
    press('left')
    press('center-right')
    act(() => { instance.actions.selectSurface('identity'); instance.actions.openDetails() })
    crossTo(false)
    expect(frame.getAttribute('data-pane-preset')).toBe('left-wide')
    expect(frame.hasAttribute('data-compact-lane')).toBe(false)
    expect(frame.getAttribute('style') ?? '').toBe('')
    expect(active()).toEqual(['left', 'center'])
  })

  it('entering compact keeps the lane that holds focus in front; leaving it, focus on a vanished corner moves on', () => {
    const { frame, instance, lane, corner, press } = mountFrame()
    corner('center-right')?.focus()
    crossTo(true)
    expect(frame.getAttribute('data-compact-lane')).toBe('center')
    press('center-right')
    corner('compact-next')?.focus()
    expect(document.activeElement?.getAttribute('data-corner')).toBe('compact-next')
    crossTo(false)
    expect(instance.getSnapshot().compact).toBe(false)
    // Balanced: every lane is a third, so the first widest (the thread lane) takes the focus.
    expect(lane('left').contains(document.activeElement)).toBe(true)
  })

  it('keeps the frame inside the visible viewport as the keyboard opens, and leaves pinch zoom to the browser', () => {
    compactMatches = true
    const { frame } = mountFrame()
    expect(frame.hasAttribute('data-compact-viewport')).toBe(true)
    expect(frame.style.getPropertyValue('--dsh-compact-visible-height')).toBe('844px')
    act(() => {
      viewport.height = 508
      viewport.offsetTop = 0
      viewport.dispatchEvent(new Event('resize'))
    })
    flushFrames()
    expect(frame.style.getPropertyValue('--dsh-compact-visible-height')).toBe('508px')
    expect(frame.style.getPropertyValue('--dsh-compact-visible-top')).toBe('0px')
    act(() => {
      viewport.scale = 2
      viewport.dispatchEvent(new Event('resize'))
    })
    flushFrames()
    expect(frame.hasAttribute('data-compact-viewport')).toBe(false)
    expect(frame.style.getPropertyValue('--dsh-compact-visible-height')).toBe('')
    act(() => {
      viewport.scale = 1
      viewport.height = 844
      viewport.dispatchEvent(new Event('scroll'))
    })
    flushFrames()
    expect(frame.style.getPropertyValue('--dsh-compact-visible-height')).toBe('844px')
    crossTo(false)
    expect(frame.hasAttribute('data-compact-viewport')).toBe(false)
  })
})

describe('compact, a session switch keeps the lane the person chose', () => {
  interface Seat { sessionId: string; expanded: boolean; actions: { openDetails: () => void; closeDetails: () => void } }
  /** The details seat's one habit that matters here (SidebarRight.tsx RightbarSeat): it re-reports after every switch. */
  function DetailsSeat({ sessionId, expanded, actions }: Seat) {
    useLayoutEffect(() => {
      if (expanded) actions.openDetails()
      else actions.closeDetails()
    }, [actions, sessionId, expanded])
    return null
  }

  function mountSessions(bootBlank: boolean) {
    const instance = createLayoutStore().create()
    const expanded = new Set<string>(['s-expanded', 'preview-showcase'])
    let current = 's-boot'
    const entry = (id: string, blank: boolean) => ({
      id, displayTitle: id, running: false, retainedBy: { mainView: current === id ? 1 : 0 }, blank,
    })
    const sessions = () => ({
      ids: ['s-boot', 's-expanded', 's-plain', 'preview-showcase'],
      byId: {
        's-boot': entry('s-boot', bootBlank),
        's-expanded': entry('s-expanded', false),
        's-plain': entry('s-plain', false),
        'preview-showcase': entry('preview-showcase', false),
      },
    })
    const renderSlot = ((key: string) => {
      if (key === 'rightbar') return <DetailsSeat sessionId={current} expanded={expanded.has(current)} actions={instance.actions} />
      if (key === 'main') return <textarea data-testid="composer" defaultValue="" />
      return <div data-testid={`slot-${key}`} />
    }) as unknown as AppFrameProps['renderSlot']
    const useStore = bindSnapshotSelector(instance)
    const props = (): AppFrameProps => ({
      useStore,
      useSessions: ((selector: (value: ReturnType<typeof sessions>) => unknown) => selector(sessions())) as unknown as AppFrameProps['useSessions'],
      renderSlot,
      actions: instance.actions,
      t: (key: string) => key,
    }) as unknown as AppFrameProps
    const view = render(<AppFrame {...props()} />)
    const frame = view.container.firstElementChild as HTMLElement
    const active = (): string[] => ['left', 'center', 'right']
      .filter(name => frame.querySelector(`:scope > [data-lane="${name}"]`)?.hasAttribute('data-pane-active') === true)
    /** A person taps a thread in the list: the thread becomes the main view and its conversation opens. */
    const tapThread = (id: string): void => {
      act(() => {
        instance.actions.openConversation()
        current = id
        view.rerender(<AppFrame {...props()} />)
      })
    }
    const expand = (id: string): void => {
      act(() => {
        expanded.add(id)
        view.rerender(<AppFrame {...props()} />)
      })
    }
    return { instance, active, tapThread, expand }
  }

  // For a live thread the frame's conversation opener (conversation-opener.ts) already reopens the conversation after
  // the seat's report; these two pin that. A Showcase thread (`preview-*`) is never opened by the opener, so for it
  // only the frame's own keep holds the lane: the third case failed on an earlier build.
  it('tapping a thread whose details were left expanded shows that conversation, not the menu', () => {
    compactMatches = true
    const { instance, active, tapThread } = mountSessions(false)
    expect(active()).toEqual(['left'])
    tapThread('s-expanded')
    expect(instance.getSnapshot()).toMatchObject({ compactLane: 'left', conversationOpen: true })
    expect(active()).toEqual(['left'])
  })

  it('the same from a fresh load on a blank session, the first tap of the day', () => {
    compactMatches = true
    const { instance, active, tapThread } = mountSessions(true)
    tapThread('s-expanded')
    expect(instance.getSnapshot().compactLane).toBe('left')
    expect(active()).toEqual(['left'])
  })

  it('tapping a Showcase thread whose details were left expanded shows that thread, not the menu', () => {
    compactMatches = true
    const { instance, active, tapThread } = mountSessions(false)
    tapThread('preview-showcase')
    expect(instance.getSnapshot()).toMatchObject({ compactLane: 'left', conversationOpen: true })
    expect(active()).toEqual(['left'])
  })

  it('a person\'s own expand, on the thread already open, still brings the details to the front', () => {
    compactMatches = true
    const { instance, active, tapThread, expand } = mountSessions(false)
    tapThread('s-plain')
    expect(active()).toEqual(['left'])
    expand('s-plain')
    expect(instance.getSnapshot()).toMatchObject({ compactLane: 'right', detailsOpen: true })
    expect(active()).toEqual(['right'])
  })

  it('wide, a session switch does exactly what it did before', () => {
    const { instance, tapThread } = mountSessions(false)
    tapThread('s-expanded')
    expect(instance.getSnapshot()).toMatchObject({ compact: false, compactLane: 'left', panePreset: 'balanced' })
  })
})

// ── The compact frame ─────────────────────────────────────

/** Give the window a width; the frame measures itself on the window's resize (jsdom has no ResizeObserver). */
function setWidth(width: number): void {
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: width })
}

/** Every ResizeObserver the page made, so a resize can be delivered the way a browser delivers it. */
const observers = new Set<{ callback: ResizeObserverCallback; targets: Set<Element>; observer: ResizeObserver }>()

/** A ResizeObserver whose callbacks run when the spec resizes the window (the frame measures itself through one). */
class WindowResizeObserver implements ResizeObserver {
  readonly #record: { callback: ResizeObserverCallback; targets: Set<Element>; observer: ResizeObserver }
  constructor(callback: ResizeObserverCallback) {
    this.#record = { callback, targets: new Set(), observer: this }
    observers.add(this.#record)
  }

  observe(target: Element): void { this.#record.targets.add(target) }
  unobserve(target: Element): void { this.#record.targets.delete(target) }
  disconnect(): void { observers.delete(this.#record) }
}

/** The window is now `width` wide: its resize event, then every observer's callback, as a browser runs them. */
function resizeTo(width: number): void {
  setWidth(width)
  act(() => {
    window.dispatchEvent(new Event('resize'))
    for (const { callback, targets, observer } of [...observers]) {
      const entries = [...targets].map((target) => {
        const size = [{ inlineSize: width, blockSize: 0 }]
        return {
          target, contentRect: new DOMRectReadOnly(0, 0, width, 0),
          borderBoxSize: size, contentBoxSize: size, devicePixelContentBoxSize: size,
        }
      })
      if (entries.length > 0) callback(entries, observer)
    }
  })
}

describe('a report of how details are presented is not a request to reveal them', () => {
  let getAnimations: PropertyDescriptor | undefined
  beforeEach(() => {
    // The seat waits for its own slide before a fullscreen report; jsdom runs no animations.
    getAnimations = Object.getOwnPropertyDescriptor(Element.prototype, 'getAnimations')
    Object.defineProperty(Element.prototype, 'getAnimations', { configurable: true, writable: true, value: () => [] })
    observers.clear()
    vi.stubGlobal('ResizeObserver', WindowResizeObserver)
  })
  afterEach(() => {
    if (getAnimations === undefined) Reflect.deleteProperty(Element.prototype, 'getAnimations')
    else Object.defineProperty(Element.prototype, 'getAnimations', getAnimations)
    setWidth(1024)
  })

  /**
   * The real Spatial frame with the REAL details seat (`ui-sidebar-right` RightbarSeat) in its right lane, reporting
   * through the real `ctx.layout` controller exactly as `ui-sidebar-right/src/client/index.ts` wires it.
   */
  function mountWithDetails() {
    const instance = createLayoutStore().create()
    // The centre's harness panel, read from the frame's own store as `spatial/index.ts` derives `panelInfo`.
    const panelOf = (): string | null => panelIdOfSurface(instance.getSnapshot().activeSurface)
    const controller = new LayoutController({
      subscribe: listener => instance.subscribe(listener),
      getSnapshot: () => ({ activePanelId: panelOf() as never }),
    })
    controller.attachPanels(instance.actions)
    const sidebar = createSidebarRightStore(() => ({ kind: 'guide', title: 'Start' })).create()
    const reports: string[] = []
    const occurrence = { id: 'occurrence', signal: new AbortController().signal, tabActions: {} }
    const seat = {
      sessionId: SESSION,
      active: true,
      retainTab: () => () => {},
      useStore: bindSnapshotSelector(sidebar),
      actions: sidebar.actions,
      t: (key: string) => key,
      renderSlot: () => null,
      syncPresentation: ({ shown, track, fullscreen }: { shown: boolean; track: boolean; fullscreen: boolean }) => {
        reports.push(`${String(shown)}/${String(track)}/${String(fullscreen)}`)
        if (shown) controller.openRightbar(track, fullscreen)
        else controller.closeRightbar()
      },
      measureRoom: () => {},
      reportAutoFullscreen: () => {},
      openTab: () => {},
      closeTab: () => {},
      splitPane: () => {},
      toggleFullscreen: () => {},
      useContextMenu: () => ({ getTriggerProps: () => ({}) }),
      useContextMenuTarget: (select: (target: null) => unknown) => select(null),
      useTabTypes: (select: (types: readonly never[]) => unknown) => select([]),
      useTabNavigation: () => undefined,
      useShortcuts: (select: (entries: readonly never[]) => unknown) => select([]),
      useFlash: (select: (flash: undefined) => unknown) => select(undefined),
      occurrence: () => occurrence,
    }
    const mounted = mountFrame({
      instance,
      realSession: true,
      slots: {
        // The seat is active exactly while no harness panel holds the centre, as `RightbarRoot` decides it.
        rightbar: (owner: { width: number; viewportWidth: number; canShow: boolean }) => (
          <RightbarSeat {...({ ...seat, ...owner, active: panelOf() === null } as unknown as RightbarSeatProps)} />
        ),
      },
    })
    const panel = (): HTMLElement => mounted.frame.querySelector<HTMLElement>('[data-sidebar-right-panel]')!
    /** A person's expand: what the conversation header's ExpandButton does. */
    const expand = (): void => { act(() => { sidebar.actions.setExpanded(SESSION, true) }) }
    return { ...mounted, panel, expand, reports, controller }
  }

  it('800px to 700px with details expanded: the draft, the caret and the lane it is in all stay', () => {
    setWidth(800)
    compactMatches = true
    const { instance, active, press, panel, expand, reports, getByTestId } = mountWithDetails()
    act(() => { fireEvent.click(getByTestId('open-thread')) })
    expect(active()).toEqual(['left'])
    // The person's own expand still brings the details to the front.
    expand()
    expect(instance.getSnapshot()).toMatchObject({ compactLane: 'right', detailsOpen: true })
    expect(active()).toEqual(['right'])
    expect(panel().getAttribute('data-sidebar-right-panel')).toBe('push')
    // Back to the conversation by its corner, and type.
    press('compact-next')
    expect(active()).toEqual(['left'])
    const composer = getByTestId('composer') as HTMLTextAreaElement
    act(() => { composer.focus() })
    fireEvent.change(composer, { target: { value: 'half a thought' } })
    const before = reports.length
    resizeTo(700)
    // The seat did re-report, now fullscreen: the report reached the frame's controller.
    expect(panel().getAttribute('data-sidebar-right-panel')).toBe('fullscreen')
    expect(reports.slice(before)).toEqual(['true/false/true'])
    expect(instance.getSnapshot()).toMatchObject({ compactLane: 'left', detailsOpen: true, conversationOpen: true })
    expect(active()).toEqual(['left'])
    expect(document.activeElement).toBe(composer)
    expect(composer.value).toBe('half a thought')
  })

  it('desktop left-wide, compact, expand, desktop again: the report after the return keeps left-wide', () => {
    setWidth(1280)
    const { frame, instance, active, press, panel, expand, reports, getByTestId } = mountWithDetails()
    press('left')
    expect(frame.getAttribute('data-pane-preset')).toBe('left-wide')
    setWidth(700)
    crossTo(true)
    resizeTo(700)
    act(() => { fireEvent.click(getByTestId('open-thread')) })
    const composer = getByTestId('composer') as HTMLTextAreaElement
    fireEvent.change(composer, { target: { value: 'half a thought' } })
    expand()
    expect(instance.getSnapshot()).toMatchObject({ compactLane: 'right', detailsOpen: true, panePreset: 'left-wide' })
    press('compact-next')
    act(() => { composer.focus() })
    // Wider again, in a browser's order: the media query reports first, the frame's own measure after it.
    setWidth(1280)
    crossTo(false)
    const before = reports.length
    resizeTo(1280)
    // The seat reported the shown panel once more, as a pushed column, then gave the hidden lane back.
    expect(reports.slice(before)).toEqual(['true/true/false', 'false/false/false'])
    expect(panel().hasAttribute('data-sidebar-right-open')).toBe(false)
    expect(instance.getSnapshot()).toMatchObject({ compact: false, panePreset: 'left-wide', conversationOpen: true, detailsOpen: false })
    expect(frame.getAttribute('data-pane-preset')).toBe('left-wide')
    expect(active()).toEqual(['left', 'center'])
    expect(document.activeElement).toBe(composer)
    expect(composer.value).toBe('half a thought')
  })

  // REVIEW: a harness panel in the centre switches the seat off, and switching off is the seat letting go
  // of its panel, not a person collapsing it. Opening an app after the panel draws the same expanded panel again: that
  // report moves nothing either.
  it('compact: expanded details, a thread, Plugins, then Aura from the menu: Aura is in front, not the details', () => {
    setWidth(390)
    compactMatches = true
    const { instance, active, press, expand, reports, launcher, controller, lane, getByTestId } = mountWithDetails()
    act(() => { fireEvent.click(getByTestId('open-thread')) })
    expand()
    expect(active()).toEqual(['right'])
    act(() => { fireEvent.click(getByTestId('open-thread')) })
    expect(instance.getSnapshot()).toMatchObject({ compactLane: 'left', detailsOpen: false })
    const before = reports.length
    act(() => { controller.selectPanel('plugins') })
    expect(instance.getSnapshot()).toMatchObject({ activeSurface: 'panel:plugins', compactLane: 'center' })
    press('center-right')
    expect(active()).toEqual(['right'])
    act(() => { fireEvent.click(launcher('aura-coherence')) })
    // The seat let go, then drew its expanded panel again: both reports reached the controller.
    expect(reports.slice(before)).toEqual(['false/false/false', 'true/false/true'])
    expect(instance.getSnapshot()).toMatchObject({ activeSurface: 'aura-coherence', compactLane: 'center', detailsOpen: false })
    expect(active()).toEqual(['center'])
    expect(lane('right').contains(document.activeElement)).toBe(false)
  })

  it('desktop right-wide: expanded details, Plugins, then Aura from the menu: right-wide stays', () => {
    setWidth(1280)
    const { frame, instance, press, expand, reports, launcher, controller, getByTestId } = mountWithDetails()
    act(() => { fireEvent.click(getByTestId('open-thread')) })
    expand()
    expect(instance.getSnapshot()).toMatchObject({ detailsOpen: true, panePreset: 'balanced' })
    press('right')
    expect(frame.getAttribute('data-pane-preset')).toBe('right-wide')
    const before = reports.length
    act(() => { controller.selectPanel('plugins') })
    act(() => { fireEvent.click(launcher('aura-coherence')) })
    expect(reports.slice(before)).toEqual(['false/false/false', 'true/true/false'])
    expect(instance.getSnapshot()).toMatchObject({ activeSurface: 'aura-coherence', panePreset: 'right-wide', detailsOpen: false })
    expect(frame.getAttribute('data-pane-preset')).toBe('right-wide')
  })

  it('the store: a repeated report of a drawn panel moves nothing; a panel that became drawn is a reveal', () => {
    const handle = createLayoutStore().create()
    const { actions } = handle
    const getSnapshot = () => handle.getSnapshot()
    actions.cycleLeft()
    actions.enterCompact()
    actions.openDetails()
    expect(getSnapshot()).toMatchObject({ detailsShown: true, detailsOpen: true, compactLane: 'right' })
    actions.showCompactLane('left')
    actions.openDetails()
    expect(getSnapshot()).toMatchObject({ compactLane: 'left', detailsOpen: true })
    // The frame's own way back to the menu leaves the seat's report standing.
    actions.hideDetails()
    actions.openDetails()
    expect(getSnapshot()).toMatchObject({ compactLane: 'left', detailsOpen: false, detailsShown: true })
    actions.leaveCompact()
    actions.openDetails()
    expect(getSnapshot().panePreset).toBe('left-wide')
    // The seat reports the panel gone, then drawn again: that is a reveal, with its desktop meaning.
    actions.closeDetails()
    expect(getSnapshot()).toMatchObject({ detailsShown: false, detailsOpen: false })
    actions.openDetails()
    expect(getSnapshot()).toMatchObject({ detailsShown: true, detailsOpen: true, panePreset: 'balanced' })
    // A harness panel in the centre switches the seat off: its report then is a release, not a collapse, and the same
    // panel drawn again when an app replaces the panel is not a reveal.
    actions.cycleRight()
    actions.selectSurface('panel:plugins')
    actions.closeDetails()
    expect(getSnapshot()).toMatchObject({ detailsShown: true, detailsOpen: false, panePreset: 'right-wide' })
    actions.selectSurface('aura-coherence')
    actions.openDetails()
    expect(getSnapshot()).toMatchObject({ detailsShown: true, detailsOpen: false, panePreset: 'right-wide' })
    // With no panel in the centre, the same report is a collapse again.
    actions.closeDetails()
    expect(getSnapshot()).toMatchObject({ detailsShown: false, detailsOpen: false })
  })

  it('compact details start below the corner band and are held to the lane; the corners are not raised', () => {
    setWidth(700)
    compactMatches = true
    const { frame, instance, active, panel, expand, corner } = mountWithDetails()
    expand()
    expect(active()).toEqual(['right'])
    const layer = frame.querySelector<HTMLElement>('[data-right-layer="details"]')!
    expect(layer.hasAttribute('hidden')).toBe(false)
    expect(panel().getAttribute('data-sidebar-right-panel')).toBe('fullscreen')
    // The panel sits in the details layer, and nothing positioned stands between them in the frame's markup.
    expect(panel().closest('[data-right-layer]')).toBe(layer)
    // Both of the menu lane's corners stay outside the panel, in the lane's own corner set.
    for (const name of ['right', 'compact-next']) {
      expect(layer.contains(corner(name))).toBe(false)
      expect(corner(name)?.closest('[data-lane]')?.getAttribute('data-lane')).toBe('right')
    }
    const { compact } = splitCompact(SHEET)
    const details = ruleBody(compact, ".frame[data-compact-lane] .rightLayer[data-right-layer='details']")
    expect(details).toContain('position: absolute;')
    expect(details).toContain('inset: var(--dsh-compact-corner-clearance) 0 0 0;')
    expect(ruleBody(compact, ".frame[data-compact-lane] .rightLayer[data-right-layer='details'] :global([data-sidebar-right-panel])"))
      .toContain('max-width: 100%;')
    // The band is the clearance the corners' hit area fits in, and no compact rule lifts a corner over the panel.
    expect(uncommented(compact)).not.toMatch(/z-index/u)
    expect(ruleBody(compact, '.frame[data-compact-lane] .cornerControl')).not.toContain('z-index')
    expect(instance.getSnapshot().detailsOpen).toBe(true)
  })
})

describe('focus when the frame returns to desktop', () => {
  it('a modal that is still open keeps the focus; the frame does not pull it behind the dialog', () => {
    compactMatches = true
    /** An app that has opened the shared Modal (as Plugins does): it portals to the body, outside the frame. */
    function AppWithDialog() {
      return (
        <>
          <CountingSurface />
          <Modal open onClose={() => {}} title="Plugins" headless>
            <button type="button" data-modal-autofocus data-testid="dialog-close" />
          </Modal>
        </>
      )
    }
    const { active, press, getByTestId } = mountFrame({ slots: { 'shell.surface': () => <AppWithDialog /> } })
    press('left')
    expect(active()).toEqual(['center'])
    const close = getByTestId('dialog-close')
    act(() => { close.focus() })
    expect(document.activeElement).toBe(close)
    expect(close.closest('[data-lane]')).toBeNull()
    crossTo(false)
    expect(document.activeElement).toBe(close)
  })

  it('desktop centre-focus with an app that draws no heading here: the centre lane itself takes the focus', () => {
    const { frame, lane, corner, press } = mountFrame()
    press('center-left')
    press('center-right')
    expect(frame.getAttribute('data-pane-preset')).toBe('center-focus')
    crossTo(true)
    expect(frame.getAttribute('data-compact-lane')).toBe('center')
    corner('center-right')?.focus()
    press('center-right')
    expect(document.activeElement?.getAttribute('role')).toBe('tab')
    crossTo(false)
    expect(frame.getAttribute('data-pane-preset')).toBe('center-focus')
    expect(document.activeElement).toBe(lane('center'))
    expect(lane('center').getAttribute('tabindex')).toBe('-1')
  })
})

describe('the shared modal layer keeps clear of the safe area', () => {
  const MODAL = read('packages/client/ui-primitives/src/Modal.module.css')

  /** Split a CSS value at the separator wherever it is not inside parentheses. */
  function splitTop(value: string, separator: RegExp): string[] {
    const parts: string[] = []
    let depth = 0
    let start = 0
    for (let at = 0; at < value.length; at += 1) {
      const char = value[at] ?? ''
      if (char === '(') depth += 1
      else if (char === ')') depth -= 1
      else if (depth === 0 && separator.test(char)) {
        parts.push(value.slice(start, at))
        start = at + 1
      }
    }
    parts.push(value.slice(start))
    return parts.map(part => part.trim()).filter(part => part !== '')
  }

  /** What a browser computes for one edge: env() from the insets, var() from the frame's published value or fallback. */
  function px(expression: string, insets: Record<string, number>, overlayTop?: number): number {
    const value = expression.trim()
    const plain = /^(\d+(?:\.\d+)?)px$/u.exec(value)
    if (plain !== null) return Number(plain[1])
    const call = /^([a-z-]+)\((.*)\)$/su.exec(value)
    if (call === null) throw new Error(`cannot evaluate ${value}`)
    const [, name, inner = ''] = call
    const args = splitTop(inner, /,/u)
    if (name === 'env') return insets[(args[0] ?? '').replace('safe-area-inset-', '')] ?? px(args[1] ?? '0px', insets, overlayTop)
    if (name === 'var') return args[0] === '--dsh-frame-overlay-top' && overlayTop !== undefined ? overlayTop : px(args[1] ?? '', insets, overlayTop)
    if (name === 'max') return Math.max(...args.map(arg => px(arg, insets, overlayTop)))
    if (name === 'calc') return splitTop(inner, /\+/u).reduce((sum, term) => sum + px(term, insets, overlayTop), 0)
    throw new Error(`cannot evaluate ${value}`)
  }

  // jsdom injects no module stylesheet and has no env(): a dialog's computed padding there is '0' whatever the sheet
  // says. So the frame is driven for what it decides (where the dialog lives) and the sheet is evaluated for the values.
  it('in the real compact frame, a dialog an app opens lives on the body, outside the frame\'s own safe-area padding', () => {
    compactMatches = true
    function AppWithDialog() {
      return (
        <Modal open onClose={() => {}} title="Plugins" headless>
          <button type="button" data-modal-autofocus data-testid="dialog-close" />
        </Modal>
      )
    }
    const { frame, active, press, getByTestId } = mountFrame({ slots: { 'shell.surface': () => <AppWithDialog /> } })
    press('left')
    expect(active()).toEqual(['center'])
    expect(frame.hasAttribute('data-compact-lane')).toBe(true)
    const layer = getByTestId('dialog-close').closest('[role="presentation"]')
    expect(layer?.parentElement).toBe(document.body)
    expect(frame.contains(layer)).toBe(false)
    // So the layer's own rule is the only thing between a tall card and the notch: it names every inset.
    const padding = /padding:\s*([^;]+);/u.exec(ruleBody(MODAL, '.root'))?.[1] ?? ''
    for (const edge of ['top', 'right', 'bottom', 'left']) expect(padding).toContain(`env(safe-area-inset-${edge}, 0px)`)
  })

  it('24px of air past every inset, and exactly the old padding where the insets are zero', () => {
    const padding = /padding:\s*([^;]+);/u.exec(ruleBody(MODAL, '.root'))?.[1] ?? ''
    const edges = splitTop(padding, /\s/u)
    expect(edges).toHaveLength(4)
    const at = (insets: Record<string, number>, overlayTop?: number): number[] => edges.map(edge => px(edge, insets, overlayTop))
    // As it was: `max(24px, var(--dsh-frame-overlay-top, 24px)) 24px`.
    expect(at({})).toEqual([24, 24, 24, 24])
    expect(at({ top: 0, right: 0, bottom: 0, left: 0 }, 64)).toEqual([64, 24, 64, 24])
    // An installed iPhone in portrait (59px top, 34px home indicator) and in landscape.
    expect(at({ top: 59, right: 0, bottom: 34, left: 0 })).toEqual([83, 24, 58, 24])
    expect(at({ top: 0, right: 59, bottom: 21, left: 59 })).toEqual([24, 83, 45, 83])
    // The frame's published overlay inset still wins where it is the larger.
    expect(at({ top: 20, right: 0, bottom: 0, left: 0 }, 64)).toEqual([64, 24, 64, 24])
  })
})

// ── A second look and the runtime's REQUEST ───────────────────

describe('A session\'s activation report is not navigation', () => {
  let getAnimations: PropertyDescriptor | undefined
  beforeEach(() => {
    getAnimations = Object.getOwnPropertyDescriptor(Element.prototype, 'getAnimations')
    Object.defineProperty(Element.prototype, 'getAnimations', { configurable: true, writable: true, value: () => [] })
  })
  afterEach(() => {
    if (getAnimations === undefined) Reflect.deleteProperty(Element.prototype, 'getAnimations')
    else Object.defineProperty(Element.prototype, 'getAnimations', getAnimations)
    setWidth(1024)
  })

  const SHUT = 's-shut' as SessionId
  const OPEN = 's-open' as SessionId

  /**
   * Two real threads, each with the REAL details seat (`ui-sidebar-right` RightbarSeat) kept per session and active only
   * while its session is the main view and no harness panel holds the centre, as `RightbarRoot` keeps them, reporting
   * through the real `ctx.layout` controller. `s-open` saved its details expanded; `s-shut` saved them collapsed.
   * @param width - the window's width.
   * @param boot - what the page opens on: `s-shut` as a real thread (the default), `s-shut` as the load's blank session,
   * or no main view yet (the sessions list has not arrived).
   */
  function mountTwoSessions(width: number, boot: 'thread' | 'blank' | 'none' = 'thread') {
    setWidth(width)
    const instance = createLayoutStore().create()
    const panelOf = (): string | null => panelIdOfSurface(instance.getSnapshot().activeSurface)
    const controller = new LayoutController({
      subscribe: listener => instance.subscribe(listener),
      getSnapshot: () => ({ activePanelId: panelOf() as never }),
    })
    controller.attachPanels(instance.actions)
    const sidebar = createSidebarRightStore(() => ({ kind: 'guide', title: 'Start' })).create()
    sidebar.actions.open(SHUT)
    sidebar.actions.open(OPEN)
    sidebar.actions.setExpanded(OPEN, true)
    const reports: string[] = []
    const occurrence = { id: 'occurrence', signal: new AbortController().signal, tabActions: {} }
    // One seat per session, made once, so its report door is stable across renders as the real one is.
    const seats = new Map([SHUT, OPEN].map(sessionId => [sessionId, {
      sessionId,
      retainTab: () => () => {},
      useStore: bindSnapshotSelector(sidebar),
      actions: sidebar.actions,
      t: (key: string) => key,
      renderSlot: () => null,
      syncPresentation: ({ shown, track, fullscreen }: { shown: boolean; track: boolean; fullscreen: boolean }) => {
        reports.push(`${sessionId}:${String(shown)}/${String(track)}/${String(fullscreen)}`)
        if (shown) controller.openRightbar(track, fullscreen)
        else controller.closeRightbar()
      },
      measureRoom: () => {},
      reportAutoFullscreen: () => {},
      openTab: () => {},
      closeTab: () => {},
      splitPane: () => {},
      toggleFullscreen: () => {},
      useContextMenu: () => ({ getTriggerProps: () => ({}) }),
      useContextMenuTarget: (select: (target: null) => unknown) => select(null),
      useTabTypes: (select: (types: readonly never[]) => unknown) => select([]),
      useTabNavigation: () => undefined,
      useShortcuts: (select: (entries: readonly never[]) => unknown) => select([]),
      useFlash: (select: (flash: undefined) => unknown) => select(undefined),
      occurrence: () => occurrence,
    }]))
    let current: SessionId | undefined = boot === 'none' ? undefined : SHUT
    const entry = (id: SessionId) => ({
      id, displayTitle: id, running: false, retainedBy: { mainView: current === id ? 1 : 0 }, blank: boot === 'blank' && id === SHUT,
    })
    const sessions = () => ({ ids: [SHUT, OPEN], byId: { [SHUT]: entry(SHUT), [OPEN]: entry(OPEN) } })
    const renderSlot = ((key: string, owner: { width: number; viewportWidth: number; canShow: boolean }) => {
      if (key === 'rightbar') {
        return [...seats.values()].map((seat) => {
          const seatActive = panelOf() === null && seat.sessionId === current
          return <RightbarSeat key={seat.sessionId} {...({ ...seat, ...owner, active: seatActive } as unknown as RightbarSeatProps)} />
        })
      }
      if (key === 'main') return <textarea data-testid="composer" defaultValue="" />
      return <div data-testid={`slot-${key}`} />
    }) as unknown as AppFrameProps['renderSlot']
    const props = (): AppFrameProps => ({
      useStore: bindSnapshotSelector(instance),
      useSessions: ((selector: (value: ReturnType<typeof sessions>) => unknown) => selector(sessions())) as unknown as AppFrameProps['useSessions'],
      renderSlot,
      actions: instance.actions,
      t: (key: string) => key,
    }) as unknown as AppFrameProps
    const view = render(<AppFrame {...props()} />)
    const frame = view.container.firstElementChild as HTMLElement
    const lane = (name: string): HTMLElement => frame.querySelector<HTMLElement>(`:scope > [data-lane="${name}"]`)!
    const active = (): string[] => ['left', 'center', 'right'].filter(name => lane(name).hasAttribute('data-pane-active'))
    const press = (name: string): void => { fireEvent.click(frame.querySelector<HTMLElement>(`[data-corner="${name}"]`)!) }
    const rightFace = (): string[] => ['menu', 'details']
      .filter(face => frame.querySelector(`[data-right-layer="${face}"]`)?.hasAttribute('hidden') === false)
    /** A person taps a thread in the list: its conversation opens and it becomes the main view. */
    const tapThread = (id: SessionId): void => {
      act(() => {
        fireEvent.click(view.getByTestId('open-thread'))
        current = id
        view.rerender(<AppFrame {...props()} />)
      })
    }
    /** The main view changes with no tap on the list (her own navigation, a waiting lane's badge). */
    const switchTo = (id: SessionId): void => {
      act(() => {
        current = id
        view.rerender(<AppFrame {...props()} />)
      })
    }
    return { instance, frame, active, press, rightFace, tapThread, switchTo, reports, sidebar }
  }

  it('1024px on left-menu-wide: opening a thread whose details were left expanded keeps left-menu-wide', () => {
    const { instance, frame, active, press, rightFace, tapThread, reports } = mountTwoSessions(1024)
    press('left')
    press('center-right')
    expect(frame.getAttribute('data-pane-preset')).toBe('left-menu-wide')
    const before = reports.length
    tapThread(OPEN)
    // The seat really did re-report: the thread left behind let go, and the one opened reported its expanded panel.
    expect(reports.slice(before)).toEqual([`${SHUT}:false/false/false`, `${OPEN}:true/true/false`])
    expect(instance.getSnapshot()).toMatchObject({ compact: false, panePreset: 'left-menu-wide', conversationOpen: true, detailsOpen: false })
    // The report was the opened thread's activation, and the frame marked it so before the seat spoke.
    expect(instance.getSnapshot().activationPending).toBe(OPEN)
    expect(frame.getAttribute('data-pane-preset')).toBe('left-menu-wide')
    expect(active()).toEqual(['left', 'right'])
    expect(rightFace()).toEqual(['menu'])
    // And back to the thread whose details are collapsed: still the owner's thirds.
    tapThread(SHUT)
    expect(instance.getSnapshot()).toMatchObject({ panePreset: 'left-menu-wide', detailsOpen: false })
  })

  it('1280px on right-threads-wide, expanded to expanded: the second thread\'s report keeps the owner\'s thirds too', () => {
    const { instance, frame, press, tapThread, sidebar } = mountTwoSessions(1280)
    press('right')
    press('center-left')
    expect(frame.getAttribute('data-pane-preset')).toBe('right-threads-wide')
    act(() => { sidebar.actions.setExpanded(SHUT, true) })
    // A person's own expand, on the thread already open, is a reveal with its desktop meaning, as before.
    expect(instance.getSnapshot()).toMatchObject({ detailsOpen: true, panePreset: 'balanced' })
    press('right')
    press('center-left')
    expect(frame.getAttribute('data-pane-preset')).toBe('right-threads-wide')
    tapThread(OPEN)
    expect(instance.getSnapshot()).toMatchObject({ panePreset: 'right-threads-wide', detailsOpen: false })
    expect(frame.getAttribute('data-pane-preset')).toBe('right-threads-wide')
  })

  it('800px compact: the same thread keeps the conversation in front and never touches the desktop preset', () => {
    compactMatches = true
    const { instance, active, tapThread } = mountTwoSessions(800)
    tapThread(OPEN)
    expect(instance.getSnapshot()).toMatchObject({ compact: true, compactLane: 'left', panePreset: 'balanced', conversationOpen: true })
    expect(active()).toEqual(['left'])
  })

  it('centre-focus, her own navigation to that thread: the conversation the frame opens still shows (balanced)', () => {
    const { instance, frame, active, press, switchTo } = mountTwoSessions(1280)
    press('center-left')
    press('center-right')
    expect(frame.getAttribute('data-pane-preset')).toBe('center-focus')
    switchTo(OPEN)
    // Opening the conversation brings a hidden left lane back as balanced, exactly as it did; the activation report's
    // own balanced is not undone into a preset that would hide that conversation.
    expect(instance.getSnapshot()).toMatchObject({ panePreset: 'balanced', conversationOpen: true })
    expect(active()).toEqual(['left', 'center', 'right'])
  })

  // ── Review: the activation is marked before the seat reports, so the commit order no longer decides ──

  it('1280px on left-wide: opening the thread whose details were saved expanded keeps left-wide AND that saved expansion', () => {
    const { instance, frame, press, rightFace, tapThread, reports, sidebar } = mountTwoSessions(1280)
    press('left')
    expect(frame.getAttribute('data-pane-preset')).toBe('left-wide')
    const before = reports.length
    tapThread(OPEN)
    // The seat reported its saved expanded panel; the lane it reports from is hidden, and nothing collapsed it.
    expect(reports.slice(before)).toEqual([`${SHUT}:false/false/false`, `${OPEN}:true/true/false`])
    expect(sidebar.getSnapshot().bySession[OPEN]?.layout.expanded).toBe(true)
    expect(instance.getSnapshot()).toMatchObject({ panePreset: 'left-wide', conversationOpen: true, detailsOpen: false, activationPending: OPEN })
    expect(frame.getAttribute('data-pane-preset')).toBe('left-wide')
    // Away and back again: still the owner's thirds, still the owner's saved details.
    tapThread(SHUT)
    expect(instance.getSnapshot().activationPending).toBeUndefined()
    tapThread(OPEN)
    expect(sidebar.getSnapshot().bySession[OPEN]?.layout.expanded).toBe(true)
    expect(instance.getSnapshot().panePreset).toBe('left-wide')
    // A person's corner settles the activation; this one gives the right lane back, the saved details are still there.
    press('center-right')
    expect(instance.getSnapshot()).toMatchObject({ panePreset: 'left-menu-wide', detailsOpen: false })
    expect(instance.getSnapshot().activationPending).toBeUndefined()
    expect(sidebar.getSnapshot().bySession[OPEN]?.layout.expanded).toBe(true)
    expect(rightFace()).toEqual(['menu'])
  })

  it('1280px on left-menu-wide: a thread saved fullscreen reports after its slide, and that late report keeps the thirds', async () => {
    const { instance, frame, press, rightFace, tapThread, reports, sidebar } = mountTwoSessions(1280)
    act(() => { sidebar.actions.setMode(OPEN, 'fullscreen') })
    press('left')
    press('center-right')
    expect(frame.getAttribute('data-pane-preset')).toBe('left-menu-wide')
    // One unfinished transform transition: the opened seat's fullscreen slide, which the seat waits for before it reports.
    let finish = (): void => {}
    const slide = {
      transitionProperty: 'transform',
      playState: 'running',
      finished: new Promise<void>((resolve) => { finish = resolve }),
    }
    Object.defineProperty(Element.prototype, 'getAnimations', { configurable: true, writable: true, value: () => [slide] })
    const before = reports.length
    tapThread(OPEN)
    expect(reports.slice(before)).toEqual([`${SHUT}:false/false/false`])
    expect(instance.getSnapshot()).toMatchObject({ panePreset: 'left-menu-wide', activationPending: OPEN })
    // The slide ends, in a later task: the seat reports now.
    await act(async () => {
      slide.playState = 'finished'
      finish()
      await slide.finished
    })
    expect(reports.slice(before)).toEqual([`${SHUT}:false/false/false`, `${OPEN}:true/true/true`])
    // The late report comes after the frame's own switch close, so the saved details take the right lane's face, as they
    // did before: the thirds stay the owner's, and the menu third shows those details.
    expect(instance.getSnapshot()).toMatchObject({ panePreset: 'left-menu-wide', detailsOpen: true, detailsShown: true })
    expect(frame.getAttribute('data-pane-preset')).toBe('left-menu-wide')
    expect(rightFace()).toEqual(['details'])
    expect(sidebar.getSnapshot().bySession[OPEN]?.layout).toMatchObject({ expanded: true, mode: 'fullscreen' })
  })

  // ── Review ui3, MUST: a gesture during the slide settles the mark, never the report still owed ──

  it('1280px on left-wide: the left corner pressed while a fullscreen thread slides in stays the owner\'s when its late report comes', async () => {
    const { instance, frame, press, tapThread, reports, sidebar } = mountTwoSessions(1280)
    act(() => { sidebar.actions.setMode(OPEN, 'fullscreen') })
    press('left')
    expect(frame.getAttribute('data-pane-preset')).toBe('left-wide')
    const { finish } = slowSlide()
    const before = reports.length
    tapThread(OPEN)
    expect(reports.slice(before)).toEqual([`${SHUT}:false/false/false`])
    // Between the activation and the end of the slide, the owner presses the left corner: his choice, left-focus.
    press('left')
    expect(frame.getAttribute('data-pane-preset')).toBe('left-focus')
    await finish()
    // The late report is the activation's, still: it keeps his left-focus and resets nothing to balanced.
    expect(reports.slice(before)).toEqual([`${SHUT}:false/false/false`, `${OPEN}:true/true/true`])
    expect(instance.getSnapshot()).toMatchObject({ panePreset: 'left-focus', detailsOpen: true, detailsShown: true })
    expect(instance.getSnapshot().activationReport).toBeUndefined()
    expect(frame.getAttribute('data-pane-preset')).toBe('left-focus')
    expect(sidebar.getSnapshot().bySession[OPEN]?.layout).toMatchObject({ expanded: true, mode: 'fullscreen' })
    // That report came: the person's own collapse and expand that follow are a reveal with their desktop meaning again.
    act(() => { sidebar.actions.setExpanded(OPEN, false) })
    act(() => { sidebar.actions.setExpanded(OPEN, true) })
    expect(instance.getSnapshot()).toMatchObject({ panePreset: 'balanced', detailsOpen: true })
  })

  it('800px compact: going to the app while a fullscreen thread slides in keeps the app in front when its late report comes', async () => {
    compactMatches = true
    const { instance, active, press, rightFace, tapThread, reports, sidebar } = mountTwoSessions(800)
    act(() => { sidebar.actions.setMode(OPEN, 'fullscreen') })
    const { finish } = slowSlide()
    const before = reports.length
    tapThread(OPEN)
    expect(instance.getSnapshot()).toMatchObject({ compact: true, compactLane: 'left' })
    // Between the activation and the end of the slide, the person goes to the app by the conversation's corner.
    press('left')
    expect(active()).toEqual(['center'])
    await finish()
    expect(reports.slice(before)).toContain(`${OPEN}:true/true/true`)
    // The late report does not switch the frame to the right lane: the app the person chose stays in front.
    expect(instance.getSnapshot()).toMatchObject({ compactLane: 'center', detailsOpen: true, panePreset: 'balanced' })
    expect(active()).toEqual(['center'])
    // The right lane, by its corner, shows the saved details.
    press('center-right')
    expect(active()).toEqual(['right'])
    expect(rightFace()).toEqual(['details'])
  })

  it('the store: a gesture between an activation and its report settles the mark; only the report or a new switch ends the report', () => {
    const handle = createLayoutStore().create()
    const { actions } = handle
    const getSnapshot = () => handle.getSnapshot()
    actions.cycleLeft()
    actions.markActivation('s-open')
    // A corner during the slide: the owner's preset, and the geometry answers again (the mark is settled).
    actions.cycleLeft()
    expect(getSnapshot().panePreset).toBe('left-focus')
    expect(getSnapshot().activationPending).toBeUndefined()
    // The late report: it moves nothing, and it is the last report the activation suppresses.
    actions.openDetails()
    expect(getSnapshot()).toMatchObject({ panePreset: 'left-focus', detailsShown: true, detailsOpen: true })
    expect(getSnapshot().activationReport).toBeUndefined()
    actions.closeDetails()
    actions.openDetails()
    expect(getSnapshot()).toMatchObject({ panePreset: 'balanced', detailsOpen: true })
    // Compact: the person's lane survives the late report.
    actions.closeDetails()
    actions.enterCompact('left')
    actions.markActivation('s-open')
    actions.showCompactLane('center')
    actions.openDetails()
    expect(getSnapshot()).toMatchObject({ compactLane: 'center', detailsOpen: true })
    // A second switch replaces the outstanding report; no session drops it; a `shown: false` report is the report.
    actions.closeDetails()
    actions.markActivation('s-open')
    actions.markActivation('s-shut')
    expect(getSnapshot().activationReport).toBe('s-shut')
    actions.markActivation(undefined)
    expect(getSnapshot().activationReport).toBeUndefined()
    actions.markActivation('s-open')
    actions.cycleCenterLeft()
    actions.closeDetails()
    expect(getSnapshot().activationReport).toBeUndefined()
  })

  it('after an activation, the person\'s own collapse and expand still reveal the details exactly as before', () => {
    const { instance, frame, press, rightFace, tapThread, sidebar } = mountTwoSessions(1280)
    press('left')
    press('center-right')
    tapThread(OPEN)
    expect(instance.getSnapshot()).toMatchObject({ panePreset: 'left-menu-wide', activationPending: OPEN })
    // The collapse is a `shown: false` report: it settles the mark.
    act(() => { sidebar.actions.setExpanded(OPEN, false) })
    expect(instance.getSnapshot().activationPending).toBeUndefined()
    act(() => { sidebar.actions.setExpanded(OPEN, true) })
    expect(instance.getSnapshot()).toMatchObject({ panePreset: 'balanced', detailsOpen: true })
    expect(frame.getAttribute('data-pane-preset')).toBe('balanced')
    expect(rightFace()).toEqual(['details'])
  })

  // ── Review: an activation report moves no lane and no preset, but the saved details stay reachable ──

  /**
   * The opened seat's fullscreen slide, unfinished: while `getAnimations` returns it the seat waits, and its activation
   * report comes only when `finish` runs, in a later task than the switch (after the frame's own effects).
   * @returns the slide and its finish.
   */
  function slowSlide(): { finish: () => Promise<void> } {
    let resolve = (): void => {}
    const slide = {
      transitionProperty: 'transform',
      playState: 'running',
      finished: new Promise<void>((done) => { resolve = done }),
    }
    Object.defineProperty(Element.prototype, 'getAnimations', { configurable: true, writable: true, value: () => [slide] })
    return {
      finish: async () => {
        await act(async () => {
          slide.playState = 'finished'
          resolve()
          await slide.finished
        })
      },
    }
  }

  it('800px compact, blank boot, a thread saved fullscreen: its late report keeps the conversation, and the right lane shows its details', async () => {
    compactMatches = true
    const { instance, active, press, rightFace, tapThread, reports, sidebar } = mountTwoSessions(800, 'blank')
    act(() => { sidebar.actions.setMode(OPEN, 'fullscreen') })
    const { finish } = slowSlide()
    const before = reports.length
    tapThread(OPEN)
    await finish()
    expect(reports.slice(before)).toContain(`${OPEN}:true/true/true`)
    expect(instance.getSnapshot()).toMatchObject({ compact: true, compactLane: 'left', conversationOpen: true, detailsOpen: true })
    expect(active()).toEqual(['left'])
    // The person goes to the right lane by its corners: the saved details are there, not the menu.
    press('left')
    press('center-right')
    expect(active()).toEqual(['right'])
    expect(rightFace()).toEqual(['details'])
    expect(sidebar.getSnapshot().bySession[OPEN]?.layout).toMatchObject({ expanded: true, mode: 'fullscreen' })
  })

  it('1280px left-wide, blank boot, a thread saved fullscreen: left-wide stays, and the corner that shows the right lane shows its details', async () => {
    const { instance, frame, press, rightFace, tapThread, sidebar } = mountTwoSessions(1280, 'blank')
    act(() => { sidebar.actions.setMode(OPEN, 'fullscreen') })
    press('left')
    expect(frame.getAttribute('data-pane-preset')).toBe('left-wide')
    const { finish } = slowSlide()
    tapThread(OPEN)
    await finish()
    expect(instance.getSnapshot()).toMatchObject({ panePreset: 'left-wide', detailsOpen: true, activationPending: OPEN })
    expect(frame.getAttribute('data-pane-preset')).toBe('left-wide')
    press('center-right')
    expect(frame.getAttribute('data-pane-preset')).toBe('left-menu-wide')
    expect(rightFace()).toEqual(['details'])
    expect(sidebar.getSnapshot().bySession[OPEN]?.layout.expanded).toBe(true)
  })

  it('the store: while an activation is marked a drawn report moves nothing; a gesture or a collapse settles it', () => {
    const handle = createLayoutStore().create()
    const { actions } = handle
    const getSnapshot = () => handle.getSnapshot()
    actions.cycleLeft()
    expect(getSnapshot().panePreset).toBe('left-wide')
    // Marked: the seat's report records that it draws and gives the right lane the details face (so
    // the owner can still reach them), and moves no preset and no lane.
    actions.markActivation('s-open')
    actions.openDetails()
    expect(getSnapshot()).toMatchObject({ panePreset: 'left-wide', detailsShown: true, detailsOpen: true, compactLane: 'left' })
    // A report of the same drawn panel in any presentation, and the frame's own opener, leave the mark standing.
    actions.openDetails()
    actions.openConversation()
    expect(getSnapshot().activationPending).toBe('s-open')
    // A person's corner settles it.
    actions.cycleCenterRight()
    expect(getSnapshot().activationPending).toBeUndefined()
    // A `shown: false` report settles it, and the next drawn report is a person's expand, with its desktop meaning.
    actions.markActivation('s-shut')
    actions.closeDetails()
    expect(getSnapshot().activationPending).toBeUndefined()
    actions.openDetails()
    expect(getSnapshot()).toMatchObject({ panePreset: 'balanced', detailsOpen: true })
    // Compact, the same: marked, the report leaves the lane the person is on; the corners settle it.
    actions.closeDetails()
    actions.enterCompact('left')
    actions.markActivation('s-open')
    actions.openDetails()
    expect(getSnapshot()).toMatchObject({ compactLane: 'left', detailsOpen: true, detailsShown: true })
    actions.showCompactLane('center')
    expect(getSnapshot().activationPending).toBeUndefined()
    // No session current: nothing to activate.
    actions.markActivation('s-open')
    actions.markActivation(undefined)
    expect(getSnapshot().activationPending).toBeUndefined()
  })
})

describe('An approval never scrolls under a compact corner', () => {
  it('the corner band is outside every centre app\'s scroller: what an app scrolls to its top stops below the band', () => {
    const { compact, desktop } = splitCompact(SHEET)
    const px = (name: string): number => Number(new RegExp(`${name}: (\\d+)px;`, 'u').exec(ruleBody(compact, '.frame[data-compact-lane]'))?.[1])
    const body = ruleBody(compact, '.frame[data-compact-lane] .laneCenter .laneBody')
    expect(body).toContain('padding-top: var(--dsh-compact-corner-clearance);')
    expect(body).toContain('box-sizing: border-box;')
    // Corners stand at the lane's top edge; the first pixel any app's scroller shows is the body's content top.
    const cornerFoot = px('--dsh-compact-corner-hit')
    const scrollerTop = px('--dsh-compact-corner-clearance')
    expect(scrollerTop).toBeGreaterThan(cornerFoot)
    // The band is not inside a scroller: no box between the lane and the app's own scroller scrolls.
    const boxes = ['lane', 'laneShell', 'laneBody', 'surfaceStack', 'surfaceLayer']
    let checked = 0
    for (const [, head = '', rule = ''] of uncommented(SHEET).matchAll(/([^{}]+)\{([^{}]*)\}/gu)) {
      // Every selector whose subject (its last compound) is one of those boxes.
      const subjects = head.split(',').map(selector => selector.trim().split(/[\s>+~]+/u).at(-1) ?? '')
      if (!subjects.some(subject => boxes.some(name => new RegExp(`\\.${name}(?![\\w-])`, 'u').test(subject)))) continue
      checked += 1
      expect(rule, head.trim()).not.toMatch(/overflow(?:-[xy])?:\s*(?:auto|scroll)/u)
    }
    expect(checked).toBeGreaterThan(5)
    // Wide, nothing moved: the lanes' corners sit over a 74px band as they always did.
    expect(ruleBody(desktop, '.frame[data-compact-lane] .laneCenter .laneBody')).toBe('')
  })

  it('in the real compact frame the app\'s scroller lives in the padded body, and the corners outside it', () => {
    compactMatches = true
    const { frame, lane, press, getByTestId } = mountFrame({
      slots: {
        'shell.surface': () => (
          <section className="ak-app" data-testid="app-scroller">
            <button type="button" data-testid="approve">Approve</button>
          </section>
        ),
      },
    })
    press('left')
    const centre = lane('center')
    const body = centre.querySelector('[data-corner="center-left"]')?.parentElement?.lastElementChild as HTMLElement
    expect(body.contains(getByTestId('app-scroller'))).toBe(true)
    expect(body.contains(getByTestId('approve'))).toBe(true)
    for (const name of ['center-left', 'center-right']) {
      const corner = frame.querySelector(`[data-corner="${name}"]`)!
      expect(body.contains(corner)).toBe(false)
      expect(getByTestId('app-scroller').contains(corner)).toBe(false)
    }
  })
})

describe('REQUEST from the runtime: the reload notice, whichever app is open', () => {
  const RUNNING = { ballId: 'c'.repeat(64), epoch: 171 }
  const PUBLISHED = { ballId: 'd'.repeat(64), epoch: 172 }
  let lagReads: number
  beforeEach(() => {
    lagReads = 0
    // Her runtime, through this page's tunnel, records a newer published head than this tab runs.
    vi.stubGlobal('__DSH_TRANSPORT__', {
      fetch: async (path: string) => {
        if (path === HEAD_LAG_ROUTE) lagReads += 1
        const body = path === HEAD_LAG_ROUTE ? { ok: true, headLag: { published: PUBLISHED, running: RUNNING, newer: true } } : { ok: true }
        return { status: 200, text: async () => JSON.stringify(body) }
      },
    })
    vi.stubGlobal('BroadcastChannel', class { onmessage = null; close() {} })
    vi.stubGlobal('WebSocket', class { onopen = null; onmessage = null; onclose = null; close() {} })
  })

  const shown = (root: ParentNode): HTMLElement[] => [...root.querySelectorAll<HTMLElement>('[data-new-build]')]
    .filter(button => button.closest('[hidden]') === null)
  const notFound = async (): Promise<{ ok: false; reason: string }> => ({ ok: false, reason: 'not-found' })
  const surfaceSessions = () => {
    const list = { ids: ['s1'], byId: { s1: { id: 's1', displayTitle: 'Test', running: false, retainedBy: { mainView: 1 }, blank: false,
      updatedAt: 1 } }, phase: 'ready', projectionsBySession: {} } as unknown as SessionListState
    return {
      useSessions: bindSnapshotSelector(createSnapshotStore<SessionListState>(list)),
      useSessionStatus: bindSnapshotSelector(createSnapshotStore(new Map())),
    }
  }
  /** The two surfaces that carry the notice themselves, as the shell mounts them: each draws only while it is open. */
  function RealSurfaces({ activeSurface }: { activeSurface: string | undefined }) {
    const [hooks] = useState(surfaceSessions)
    return (
      <>
        <WorkSurface {...({ activeSurface, ...hooks, reader: { whole: notFound },
          labels: (key: string) => (workLabels as Record<string, string>)[key] ?? key,
          t: (key: string) => key } as unknown as Parameters<typeof WorkSurface>[0])} />
        <AuraPentoraSurface {...({ activeSurface, closeSurface: () => {}, ...hooks, reader: { whole: notFound } } as unknown as
          Parameters<typeof AuraPentoraSurface>[0])} />
      </>
    )
  }

  /** The system menu as the portal registers it: Notices first (order -10), then the predecessor's launchers. */
  const systemMenu = (owner: SlotOwner) => (
    <>
      <NoticesMenu {...(owner as Parameters<typeof NoticesMenu>[0])} />
      <SystemMenu {...(owner as Parameters<typeof SystemMenu>[0])} />
    </>
  )
  const withNotices = (owner: SlotOwner) => (
    <>
      <RealSurfaces activeSurface={owner.activeSurface} />
      <NoticesSurface {...(owner as Parameters<typeof NoticesSurface>[0])} />
    </>
  )
  // The launcher's data attributes sit on its head (the button); its tone sits on the portal frame around it.
  const noticeButton = (root: ParentNode): HTMLButtonElement => root.querySelector<HTMLButtonElement>('button[data-notices-launcher]')!
  const noticesLauncher = (root: ParentNode): HTMLElement => noticeButton(root).closest<HTMLElement>('.ak-portal')!
  afterEach(() => { resetNoticesForTests() })

  // MOVED, NOT WEAKENED: every case that showed the frame's pill now shows the gold count on the
  // Notices launcher and the notice's row in its list; the frame itself draws no notice anywhere.
  it('over any other app, or none, the frame draws nothing; Notices is gold with 1, and its list has the one row', async () => {
    const { frame, instance, lane } = mountFrame({ slots: { 'shell.surface': withNotices, 'shell.menu.system': systemMenu } })
    act(() => { instance.actions.selectSurface('identity', undefined, 'contained') })
    await waitFor(() => { expect(noticeButton(frame).getAttribute('data-waiting')).toBe('1') })
    expect(noticesLauncher(frame).classList.contains('ak-tone-gold')).toBe(true)
    expect(noticeButton(frame).getAttribute('aria-label')).toBe('Notices, 1 waiting')
    expect(lane('right').contains(noticesLauncher(frame))).toBe(true)
    // The frame draws no notice of its own, in any lane.
    expect(frame.querySelector('[data-build-notice]')).toBeNull()
    expect(shown(frame)).toHaveLength(0)
    // Opening Notices lists the one notice, in her runtime's words, with its Reload.
    fireEvent.click(noticeButton(frame))
    expect(instance.getSnapshot().activeSurface).toBe(NOTICES_SURFACE)
    const row = frame.querySelector<HTMLElement>(`[data-notice-id="auma:${PUBLISHED.ballId}"]`)!
    expect(row).not.toBeNull()
    expect(row.textContent).toContain('A newer Auma is published (epoch 172); this tab runs epoch 171. One reload brings her.')
    expect(row.querySelector('[data-notice-action="auma"]')?.textContent).toBe('Reload')
    expect(lane('center').contains(row)).toBe(true)
    // With no app open, the same one notice.
    act(() => { instance.actions.closeSurface() })
    expect(noticeButton(frame).getAttribute('data-waiting')).toBe('1')
    expect(frame.querySelector('[data-build-notice]')).toBeNull()
  })

  it('compact, the same gold count in the menu lane, and nothing at the foot of the centre lane', async () => {
    compactMatches = true
    const { frame, instance, lane, active } = mountFrame({ slots: { 'shell.menu.system': systemMenu } })
    act(() => { instance.actions.selectSurface('identity', undefined, 'contained') })
    await waitFor(() => { expect(noticeButton(frame).getAttribute('data-waiting')).toBe('1') })
    expect(lane('right').contains(noticesLauncher(frame))).toBe(true)
    expect(lane('center').querySelector('[data-build-notice], [data-new-build]')).toBeNull()
    // The menu lane in front: the gold count is in the lane that is in front, live and not hidden.
    act(() => { instance.actions.showCompactLane('right') })
    expect(active()).toEqual(['right'])
    expect(lane('right').hasAttribute('inert')).toBe(false)
    expect(lane('right').getAttribute('aria-hidden')).not.toBe('true')
    expect(noticeButton(frame).closest('[hidden]')).toBeNull()
    expect(noticeButton(frame).getAttribute('aria-label')).toBe('Notices, 1 waiting')
    expect(noticesLauncher(frame).classList.contains('ak-tone-gold')).toBe(true)
  })

  it('Work or Aura open: only that app\'s own button, once, the frame does not read, and Notices counts that app\'s read', async () => {
    const { frame, instance, lane } = mountFrame({ slots: { 'shell.surface': withNotices, 'shell.menu.system': systemMenu } })
    // The boot app is Aura Coherence: its own Reload button carries the notice; the frame draws nothing and reads nothing.
    expect(instance.getSnapshot().activeSurface).toBe(AURA_SURFACE)
    await waitFor(() => { expect(shown(frame)).toHaveLength(1) })
    expect(frame.querySelector('[data-build-notice]')).toBeNull()
    expect(shown(frame)[0]?.closest('[data-aura-coherence-surface]')).not.toBeNull()
    // Aura read once at mount; the frame did not read at all. Aura's one read also makes Notices gold with 1, on the
    // boot screen, beside Aura's own button.
    expect(lagReads).toBe(1)
    await waitFor(() => { expect(noticeButton(frame).getAttribute('data-waiting')).toBe('1') })
    expect(noticesLauncher(frame).classList.contains('ak-tone-gold')).toBe(true)
    expect(noticeButton(frame).getAttribute('aria-label')).toBe('Notices, 1 waiting')
    // Opened from Aura: the row is there at once, and opening it reads nothing (the frame does not read while Notices is
    // open, and Aura no longer reads once it is not the open app).
    fireEvent.click(noticeButton(frame))
    expect(instance.getSnapshot().activeSurface).toBe(NOTICES_SURFACE)
    const row = frame.querySelector<HTMLElement>(`[data-notice-id="auma:${PUBLISHED.ballId}"]`)
    expect(row).not.toBeNull()
    expect(row?.textContent).toContain('A newer Auma is published (epoch 172); this tab runs epoch 171. One reload brings her.')
    expect(lane('center').contains(row)).toBe(true)
    expect(frame.querySelectorAll('[data-notice]')).toHaveLength(1)
    await act(async () => { await new Promise((done) => { setTimeout(done, 50) }) })
    expect(lagReads).toBe(1)
    act(() => { instance.actions.selectSurface(WORK_SURFACE, undefined, 'contained') })
    await waitFor(() => { expect(shown(frame)).toHaveLength(1) })
    expect(frame.querySelector('[data-build-notice]')).toBeNull()
    expect(lagReads).toBe(2)
    // Work's read of the same notice is the same row: still 1, never 2.
    expect(noticeButton(frame).getAttribute('data-waiting')).toBe('1')
    // Another app: Work's button is gone, the frame reads for it, and Notices stays gold with 1; no button is drawn for it.
    act(() => { instance.actions.selectSurface('identity', undefined, 'contained') })
    await waitFor(() => { expect(lagReads).toBe(3) })
    expect(noticeButton(frame).getAttribute('data-waiting')).toBe('1')
    expect(shown(frame)).toHaveLength(0)
    expect(frame.querySelector('[data-build-notice]')).toBeNull()
  })

  it('the centre lane holds only the apps\' stack: the sheet has no notice row, and the stack fills the lane', () => {
    const { desktop, compact } = splitCompact(SHEET)
    expect(uncommented(SHEET)).not.toContain('buildNotice')
    expect(ruleBody(desktop, '.laneCenter .laneBody')).toMatch(/display: flex;[\s\S]*flex-direction: column;/u)
    expect(ruleBody(desktop, '.laneCenter .surfaceStack')).toContain('flex: 1 1 0;')
    expect(uncommented(compact)).not.toContain('buildNotice')
  })
})
