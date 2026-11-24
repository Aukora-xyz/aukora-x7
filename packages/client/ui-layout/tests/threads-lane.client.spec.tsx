// @vitest-environment jsdom
/**
 * Round 23: the Threads lane's "How it works" card and in-place rename, and the Spatial thread chrome the open thread's
 * one-line header reads. Everything opens inline; nothing is drawn over the page.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, within } from '@testing-library/react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { ThreadsLane, type ThreadListState, type ThreadPinState, type ThreadSummary } from '../src/client/spatial/portal/ThreadsLane.tsx'
import css from '../src/client/spatial/portal/ThreadsLane.module.css'
import { installSpatialChrome, SPATIAL_CHROME_GLOBAL } from '../src/client/spatial/thread-chrome.ts'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

const sid = (value: string): SessionId => value as SessionId
const row = (id: string, displayTitle: string, extra: Partial<ThreadSummary> = {}): ThreadSummary => ({
  id: sid(id), displayTitle, running: false, blank: false, updatedAt: 1, retainedBy: {}, ...extra,
})

function mountLane(renameThread?: (sessionId: SessionId, title: string) => Promise<string>) {
  const store = createSnapshotStore<ThreadListState>({
    ids: [sid('t-1'), sid('t-2'), sid('t-blank')],
    byId: {
      [sid('t-1')]: row('t-1', 'hello', { title: 'hello', updatedAt: 3 }),
      [sid('t-2')]: row('t-2', 'x6.1', { updatedAt: 2 }),
      [sid('t-blank')]: row('t-blank', 'New', { blank: true, retainedBy: { mainView: 1 } }),
    },
    phase: 'ready',
  })
  const view = render(
    <ThreadsLane
      useSessions={bindSnapshotSelector(store)}
      openThread={() => {}}
      openConversation={() => {}}
      {...(renameThread === undefined ? {} : { renameThread })}
    />,
  )
  /** What the host does after a rename: the stored title comes back through the session store. */
  const retitle = (id: string, title: string) => {
    const snapshot = store.getSnapshot()
    const current = snapshot.byId[sid(id)]
    if (current === undefined) throw new Error('no row')
    act(() => { store.set({ ...snapshot, byId: { ...snapshot.byId, [sid(id)]: { ...current, title, displayTitle: title } } }) })
  }
  const card = (id: string): HTMLElement => {
    const element = view.container.querySelector<HTMLElement>(`[data-thread-id="${id}"]`)
    if (element === null) throw new Error(`no card ${id}`)
    return element
  }
  return { view, retitle, card }
}

describe('the Threads lane: "How it works" (Round 23)', () => {
  it('sits at the top of the list, closed, and opens in place to say what threads, presets and subagents mean', () => {
    const { view } = mountLane()
    const how = view.container.querySelector<HTMLElement>('[data-threads-how]')
    if (how === null) throw new Error('no How it works card')
    const head = within(how).getByRole('button', { name: /How it works/u })
    expect(head.getAttribute('aria-expanded')).toBe('false')
    expect(within(how).getByText('what threads, presets, and subagents mean')).toBeTruthy()
    expect(how.textContent).not.toContain('Presets.')
    fireEvent.click(head)
    expect(head.getAttribute('aria-expanded')).toBe('true')
    for (const title of ['Threads.', 'Open and return.', 'Names.', 'Presets.', 'Subagents.', 'Pin, unread, archive.']) {
      expect(how.textContent).toContain(title)
    }
    // It comes before the first card.
    const first = view.container.querySelector('[data-thread-id]')
    expect(first === null ? false : Boolean(how.compareDocumentPosition(first) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true)
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })
})

describe('the Threads lane: rename on the card (Round 23)', () => {
  it('the pencil opens a field under the card; Enter saves through the host, and the card shows the stored name', async () => {
    const renames: Array<[SessionId, string]> = []
    const lane = mountLane(async (sessionId, title) => { renames.push([sessionId, title]); return title })
    fireEvent.click(within(lane.card('t-1')).getByRole('button', { name: 'Rename thread' }))
    const field = within(lane.card('t-1')).getByRole('textbox', { name: 'Thread name' }) as HTMLInputElement
    expect(field.value).toBe('hello')
    fireEvent.change(field, { target: { value: '  Epoch 163 review ' } })
    await act(async () => { fireEvent.keyDown(field, { key: 'Enter' }) })
    expect(renames).toEqual([[sid('t-1'), 'Epoch 163 review']])
    expect(within(lane.card('t-1')).queryByRole('textbox', { name: 'Thread name' })).toBeNull()
    lane.retitle('t-1', 'Epoch 163 review')
    expect(lane.card('t-1').textContent).toContain('Epoch 163 review')
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })
  it('Escape or Cancel keeps the name; an empty name saves nothing; an unchanged one pins it; a refusal stays beside the field', async () => {
    let refuse = false
    const renames: string[] = []
    const lane = mountLane(async (_sessionId, title) => {
      renames.push(title)
      if (refuse) throw new Error('session/title-invalid')
      return title
    })
    const open = () => { fireEvent.click(within(lane.card('t-2')).getByRole('button', { name: 'Rename thread' })) }
    const field = () => within(lane.card('t-2')).getByRole('textbox', { name: 'Thread name' }) as HTMLInputElement
    open()
    // No stored title yet: the field starts from what the card shows.
    expect(field().value).toBe('x6.1')
    fireEvent.keyDown(field(), { key: 'Escape' })
    expect(within(lane.card('t-2')).queryByRole('textbox')).toBeNull()
    open()
    fireEvent.click(within(lane.card('t-2')).getByRole('button', { name: 'Cancel' }))
    expect(within(lane.card('t-2')).queryByRole('textbox')).toBeNull()
    open()
    fireEvent.change(field(), { target: { value: '   ' } })
    fireEvent.click(within(lane.card('t-2')).getByRole('button', { name: 'Save' }))
    expect(renames).toHaveLength(0)
    // Saving the name as it is pins it on the host (the automatic title then stops changing), as the classic shell does.
    open()
    await act(async () => { fireEvent.click(within(lane.card('t-2')).getByRole('button', { name: 'Save' })) })
    expect(renames).toEqual(['x6.1'])
    open()
    refuse = true
    fireEvent.change(field(), { target: { value: 'Refused' } })
    await act(async () => { fireEvent.click(within(lane.card('t-2')).getByRole('button', { name: 'Save' })) })
    expect(renames).toEqual(['x6.1', 'Refused'])
    expect(field().value).toBe('Refused')
    expect(within(lane.card('t-2')).getByRole('status').textContent).toBe('session/title-invalid')
  })
  it('a blank thread, or a host with no rename, offers no pencil', () => {
    const wired = mountLane(async (_sessionId, title) => title)
    expect(within(wired.card('t-blank')).queryByRole('button', { name: 'Rename thread' })).toBeNull()
    cleanup()
    const unwired = mountLane()
    expect(within(unwired.card('t-1')).queryByRole('button', { name: 'Rename thread' })).toBeNull()
  })
})

describe('the Spatial thread chrome the one-line header reads (Round 23)', () => {
  it('is published while the shell is mounted, frozen, and removed only by its own uninstall', async () => {
    const rename = vi.fn(async (_sessionId: string, title: string) => title)
    const off = installSpatialChrome(rename)
    const chrome = (globalThis as Record<string, unknown>)[SPATIAL_CHROME_GLOBAL] as { version: number; renameThread: typeof rename }
    expect(chrome.version).toBe(1)
    expect(Object.isFrozen(chrome)).toBe(true)
    expect(await chrome.renameThread('t-1', 'x')).toBe('x')
    const second = installSpatialChrome(rename)
    off()
    expect((globalThis as Record<string, unknown>)[SPATIAL_CHROME_GLOBAL]).not.toBeUndefined()
    second()
    expect((globalThis as Record<string, unknown>)[SPATIAL_CHROME_GLOBAL]).toBeUndefined()
  })
})

// ── One line under the source note saying where her conversation is (thread-sync-marks.ts) ─────────────

/** A stand-in for BroadcastChannel: records what the page posts and lets a test deliver her worker's messages. */
class FakeSyncChannel {
  static opened: FakeSyncChannel[] = []
  readonly posted: unknown[] = []
  closed = false
  private readonly listeners = new Set<(event: { readonly data: unknown }) => void>()
  constructor(readonly name: string) { FakeSyncChannel.opened.push(this) }
  postMessage(message: unknown): void { this.posted.push(message) }
  close(): void { this.closed = true }
  addEventListener(_type: 'message', listener: (event: { readonly data: unknown }) => void): void { this.listeners.add(listener) }
  removeEventListener(_type: 'message', listener: (event: { readonly data: unknown }) => void): void { this.listeners.delete(listener) }
  deliver(data: unknown): void { act(() => { for (const listener of this.listeners) listener({ data }) }) }
}

/** What main renders for the source note, for each `hostPins` value (ThreadsLane.tsx at an earlier commit). */
const MAIN_SOURCE_NOTE = {
  host: `<p class="${css.source}" data-threads-source-note="true">Pins and archive: saved on the DSH host · filters and unread marks: this browser</p>`,
  viewer: `<p class="${css.source}" data-threads-source-note="true">Pins, archive, filters and unread marks: this browser only (host pin/archive not wired)</p>`,
} as const

function mountMarksLane(hostPins: boolean) {
  const store = createSnapshotStore<ThreadListState>({
    ids: [sid('t-1')],
    byId: { [sid('t-1')]: row('t-1', 'hello', { title: 'hello', updatedAt: 3 }) },
    phase: 'ready',
  })
  const pins = createSnapshotStore<ThreadPinState>({ pinnedSessionIds: [], archivedSessionIds: [] })
  const view = render(
    <ThreadsLane
      useSessions={bindSnapshotSelector(store)}
      openThread={() => {}}
      openConversation={() => {}}
      {...(hostPins
        ? { useWorkspaces: bindSnapshotSelector(pins), setPinned: async () => {}, setArchived: async () => {} }
        : {})}
    />,
  )
  const note = (): HTMLElement => {
    const element = view.container.querySelector<HTMLElement>('[data-threads-source-note]')
    if (element === null) throw new Error('no source note')
    return element
  }
  const cloudNotes = (): HTMLElement[] => Array.from(view.container.querySelectorAll<HTMLElement>('[data-threads-cloud-note]'))
  return { view, note, cloudNotes }
}

/** The source note block exactly as main renders it: the same element, last in its block, with no line after it. */
function expectMainSourceNote(lane: ReturnType<typeof mountMarksLane>, hostPins: boolean): void {
  expect(lane.note().outerHTML).toBe(hostPins ? MAIN_SOURCE_NOTE.host : MAIN_SOURCE_NOTE.viewer)
  expect(lane.note().nextElementSibling).toBeNull()
  expect(lane.cloudNotes()).toHaveLength(0)
}

// The lane listens only on a page that has an id, which exists only while thread sync is on.
const SYNC_PAGE = 'cccccccccccccccc'
const state = (at: number, mode: string, role: string, footer: string) => ({ v: 1, kind: 'state', at, mode, role, footer, worker: SYNC_PAGE })
const READER_CLOUD = 'Reading her from her cloud, read at 14:05. She answers in Chrome on Mac. Nothing typed here is saved.'
const READER_OLDER = 'Reading the older copy kept in this browser. She answers in Chrome on Mac. Nothing typed here is saved.'

describe('the Threads lane: where her conversation is', () => {
  afterEach(() => { vi.unstubAllGlobals(); FakeSyncChannel.opened = [] })

  it('no state: the source note block renders exactly as main, for both hostPins values', () => {
    vi.stubGlobal('BroadcastChannel', FakeSyncChannel)
    for (const hostPins of [true, false]) {
      const lane = mountMarksLane(hostPins)
      expect(lane.view.container.querySelector('[data-threads-source]')?.getAttribute('data-threads-source')).toBe(hostPins ? 'host' : 'viewer')
      expectMainSourceNote(lane, hostPins)
      cleanup()
    }
    // With no page id (thread sync off) the lane opens no channel at all, as on main.
    expect(FakeSyncChannel.opened).toHaveLength(0)
    // No BroadcastChannel at all: the same.
    vi.stubGlobal('BroadcastChannel', undefined)
    for (const hostPins of [true, false]) {
      expectMainSourceNote(mountMarksLane(hostPins), hostPins)
      cleanup()
    }
  })

  it('writer state: one line under the note, the footer word for word, with its role', () => {
    vi.stubGlobal('__DSH_THREAD_SYNC_PAGE__', SYNC_PAGE)
    vi.stubGlobal('BroadcastChannel', FakeSyncChannel)
    const lane = mountMarksLane(true)
    const [channel] = FakeSyncChannel.opened
    if (channel === undefined) throw new Error('no channel')
    expect(channel.name).toBe('aukora-x6-thread-sync')
    channel.deliver(state(1_000, 'on', 'writer', 'In her cloud 14:05.'))
    const lines = lane.cloudNotes()
    expect(lines).toHaveLength(1)
    const [line] = lines
    if (line === undefined) throw new Error('no cloud line')
    expect(line.tagName).toBe('P')
    expect(line.className).toBe(css.source)
    expect(line.textContent).toBe('In her cloud 14:05.')
    expect(line.getAttribute('data-threads-cloud-role')).toBe('writer')
    // Directly under the source note, which is itself unchanged.
    expect(lane.note().nextElementSibling).toBe(line)
    expect(lane.note().outerHTML).toBe(MAIN_SOURCE_NOTE.host)
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })

  it('reader state: the long reader sentence shows whole; mode off still tells a reader; off with no footer is main', () => {
    vi.stubGlobal('__DSH_THREAD_SYNC_PAGE__', SYNC_PAGE)
    vi.stubGlobal('BroadcastChannel', FakeSyncChannel)
    const lane = mountMarksLane(false)
    const [channel] = FakeSyncChannel.opened
    if (channel === undefined) throw new Error('no channel')
    channel.deliver(state(1_000, 'pull', 'reader', READER_CLOUD))
    expect(lane.cloudNotes().map(line => line.textContent)).toEqual([READER_CLOUD])
    expect(lane.cloudNotes()[0]?.getAttribute('data-threads-cloud-role')).toBe('reader')
    // A reader is told nothing typed is saved in mode off too: the line follows the footer, never the mode.
    channel.deliver(state(2_000, 'off', 'reader', READER_OLDER))
    expect(lane.cloudNotes().map(line => line.textContent)).toEqual([READER_OLDER])
    expect(lane.cloudNotes()[0]?.getAttribute('data-threads-cloud-role')).toBe('reader')
    // Mode off with an empty footer: the lane renders as main again.
    channel.deliver(state(3_000, 'off', 'writer', ''))
    expectMainSourceNote(lane, false)
  })
})
