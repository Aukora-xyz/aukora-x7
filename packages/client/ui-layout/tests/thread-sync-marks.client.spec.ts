// @vitest-environment jsdom
/**
 * The listener behind the Threads lane's cloud line. It takes only her worker's valid state messages from
 * `aukora-x6-thread-sync`, keeps the newest by `at`, asks once, closes on unmount, and never throws.
 */
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, renderHook } from '@testing-library/react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  THREAD_SYNC_CHANNEL, THREAD_SYNC_FOOTER_MAX, parseThreadSyncState, useThreadSyncMarks,
} from '../src/client/spatial/portal/thread-sync-marks.ts'
import { ThreadsLane, type ThreadListState } from '../src/client/spatial/portal/ThreadsLane.tsx'

type Listener = (event: { readonly data: unknown }) => void

/** A stand-in for BroadcastChannel: records what the page posts and lets a test deliver her worker's messages. */
class FakeChannel {
  static opened: FakeChannel[] = []
  readonly posted: unknown[] = []
  closed = false
  readonly listeners = new Set<Listener>()
  constructor(readonly name: string) { FakeChannel.opened.push(this) }
  postMessage(message: unknown): void { this.posted.push(message) }
  close(): void { this.closed = true }
  addEventListener(_type: 'message', listener: Listener): void { this.listeners.add(listener) }
  removeEventListener(_type: 'message', listener: Listener): void { this.listeners.delete(listener) }
  deliver(data: unknown): void { act(() => { for (const listener of this.listeners) listener({ data }) }) }
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); FakeChannel.opened = [] })

/**
 * A page has an id only while thread sync is on (webworker-runtime client/reader-window.ts),
 * and only then does the lane listen. These tests are the on case: the page has an id and its own worker signs with it.
 */
const PAGE = 'aaaaaaaaaaaaaaaa'
const onPage = (): void => { vi.stubGlobal('__DSH_THREAD_SYNC_PAGE__', PAGE) }
const state = (at: number, footer = `In her cloud ${at}.`, mode = 'on', role = 'writer') => ({ v: 1, kind: 'state', at, mode, role, footer, worker: PAGE })

function mountHook() {
  onPage()
  vi.stubGlobal('BroadcastChannel', FakeChannel)
  const hook = renderHook(() => useThreadSyncMarks())
  const [channel] = FakeChannel.opened
  if (channel === undefined) throw new Error('no channel opened')
  return { hook, channel }
}

describe('thread-sync-marks: the listener', () => {
  it('opens the contract channel and posts exactly one ask on mount', () => {
    const { hook, channel } = mountHook()
    expect(FakeChannel.opened).toHaveLength(1)
    expect(channel.name).toBe(THREAD_SYNC_CHANNEL)
    expect(channel.name).toBe('aukora-x6-thread-sync')
    expect(channel.posted).toEqual([{ v: 1, kind: 'ask', worker: PAGE }])
    expect(hook.result.current).toBeNull()
    hook.rerender()
    expect(channel.posted).toHaveLength(1)
  })

  it('keeps the newest by at when messages arrive out of order', () => {
    const { hook, channel } = mountHook()
    channel.deliver(state(2_000, 'In her cloud 14:05.'))
    expect(hook.result.current).toEqual({ at: 2_000, mode: 'on', role: 'writer', footer: 'In her cloud 14:05.' })
    channel.deliver(state(1_000, 'In her cloud 14:01.'))
    expect(hook.result.current?.footer).toBe('In her cloud 14:05.')
    channel.deliver(state(3_000, 'In her cloud 14:09.'))
    expect(hook.result.current?.footer).toBe('In her cloud 14:09.')
  })

  it('ignores each malformed message and keeps the previous state, without a log line', () => {
    const log = vi.spyOn(console, 'log')
    const warn = vi.spyOn(console, 'warn')
    const error = vi.spyOn(console, 'error')
    const { hook, channel } = mountHook()
    const good = state(1_000, 'In her cloud 14:05.')
    channel.deliver(good)
    const malformed: unknown[] = [
      { ...state(2_000), v: 2 },
      { ...state(2_000), v: '1' },
      { ...state(2_000), kind: 'ask' },
      state(2_000, 'x', 'sometimes'),
      state(2_000, 'x', 'on', 'owner'),
      state(2_000, 'a'.repeat(THREAD_SYNC_FOOTER_MAX + 1)),
      state(2_000, 'In her cloud\n14:05.'),
      state(2_000, 'In her cloud\u0007 14:05.'),
      state(2_000, 'In her cloud\u009b 14:05.'),
      { ...state(2_000), footer: 42 },
      { ...state(2_000), at: 2_000.5 },
      { ...state(2_000), at: Number.MAX_SAFE_INTEGER + 1 },
      { ...state(2_000), at: '2000' },
      { v: 1, kind: 'state', at: 2_000, mode: 'on', role: 'writer', worker: PAGE },
      'In her cloud 14:05.',
      null,
      undefined,
      42,
      [state(2_000)],
    ]
    for (const message of malformed) {
      channel.deliver(message)
      expect(hook.result.current).toEqual({ at: 1_000, mode: 'on', role: 'writer', footer: 'In her cloud 14:05.' })
    }
    expect(log).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()
  })

  it('takes a footer of exactly 200 characters, and an empty one', () => {
    expect(parseThreadSyncState(state(1, 'a'.repeat(THREAD_SYNC_FOOTER_MAX)))?.footer).toHaveLength(200)
    expect(parseThreadSyncState(state(1, 'a'.repeat(THREAD_SYNC_FOOTER_MAX + 1)))).toBeNull()
    expect(parseThreadSyncState(state(1, '', 'off', 'none'))).toEqual({ at: 1, mode: 'off', role: 'none', footer: '' })
    for (const mode of ['off', 'pull', 'on']) {
      for (const role of ['reader', 'writer', 'none']) expect(parseThreadSyncState(state(1, 'x', mode, role))).not.toBeNull()
    }
  })

  it('a page that knows its own id shows only its own worker\'s line, never another tab\'s', () => {
    const { hook, channel } = mountHook()
    // Review SHOULD 1: its ask names this page, so only its own worker answers (another tab's worker stays silent).
    expect(channel.posted).toEqual([{ v: 1, kind: 'ask', worker: 'aaaaaaaaaaaaaaaa' }])
    channel.deliver({ ...state(1_000, 'In her cloud 14:05.'), worker: 'bbbbbbbbbbbbbbbb' })
    expect(hook.result.current).toBeNull()
    channel.deliver({ ...state(1_100, 'No id at all.'), worker: undefined })
    expect(hook.result.current).toBeNull()
    channel.deliver({ ...state(1_200, 'In her cloud 14:06.'), worker: 'aaaaaaaaaaaaaaaa' })
    expect(hook.result.current?.footer).toBe('In her cloud 14:06.')
    channel.deliver({ ...state(1_300, 'Only in this browser: 2 lines.'), worker: 'bbbbbbbbbbbbbbbb' })
    expect(hook.result.current?.footer).toBe('In her cloud 14:06.')
    // The pure check, both ways; a page with no id (an older client) takes any valid message, as before.
    expect(parseThreadSyncState({ ...state(1), worker: 'x' }, 'y')).toBeNull()
    expect(parseThreadSyncState({ ...state(1), worker: 'y' }, 'y')).not.toBeNull()
    expect(parseThreadSyncState(state(1), null)).not.toBeNull()
  })

  it('closes the channel on unmount, and a message after that changes nothing', () => {
    const { hook, channel } = mountHook()
    channel.deliver(state(1_000, 'In her cloud 14:05.'))
    hook.unmount()
    expect(channel.closed).toBe(true)
    expect(channel.listeners.size).toBe(0)
    channel.deliver(state(2_000, 'In her cloud 14:09.'))
    expect(hook.result.current?.footer).toBe('In her cloud 14:05.')
  })

  it('gives "no state" and does not throw when BroadcastChannel is missing or its constructor throws', () => {
    onPage()
    vi.stubGlobal('BroadcastChannel', undefined)
    const missing = renderHook(() => useThreadSyncMarks())
    expect(missing.result.current).toBeNull()
    missing.unmount()
    vi.stubGlobal('BroadcastChannel', function BlockedChannel(): never { throw new Error('blocked') })
    const throwing = renderHook(() => useThreadSyncMarks())
    expect(throwing.result.current).toBeNull()
    throwing.unmount()
    // A channel whose post throws: still no throw, and later valid states are taken.
    class PostThrows extends FakeChannel { override postMessage(): void { throw new Error('closed') } }
    vi.stubGlobal('BroadcastChannel', PostThrows)
    const postThrows = renderHook(() => useThreadSyncMarks())
    expect(postThrows.result.current).toBeNull()
    const [channel] = FakeChannel.opened
    if (channel === undefined) throw new Error('no channel opened')
    channel.deliver(state(1_000, 'In her cloud 14:05.'))
    expect(postThrows.result.current?.footer).toBe('In her cloud 14:05.')
  })

  it('a footer holding <b> renders in the lane as text, never as HTML', () => {
    onPage()
    vi.stubGlobal('BroadcastChannel', FakeChannel)
    const sid = (value: string): SessionId => value as SessionId
    const store = createSnapshotStore<ThreadListState>({
      ids: [sid('t-1')],
      byId: { [sid('t-1')]: { id: sid('t-1'), displayTitle: 'hello', running: false, blank: false, updatedAt: 1, retainedBy: {} } },
      phase: 'ready',
    })
    const view = render(createElement(ThreadsLane, {
      useSessions: bindSnapshotSelector(store), openThread: () => {}, openConversation: () => {},
    }))
    const [channel] = FakeChannel.opened
    if (channel === undefined) throw new Error('no channel opened')
    channel.deliver(state(1_000, '<b>In her cloud</b> 14:05.'))
    const line = view.container.querySelector<HTMLElement>('[data-threads-cloud-note]')
    expect(line?.textContent).toBe('<b>In her cloud</b> 14:05.')
    expect(line?.querySelector('b')).toBeNull()
    expect(view.container.querySelector('b')).toBeNull()
  })

  it('with no page id (thread sync off, or an old document) it opens no channel and posts nothing', () => {
    vi.stubGlobal('BroadcastChannel', FakeChannel)
    const hook = renderHook(() => useThreadSyncMarks())
    expect(FakeChannel.opened).toHaveLength(0)
    expect(hook.result.current).toBeNull()
    hook.rerender()
    expect(FakeChannel.opened).toHaveLength(0)
    hook.unmount()
    // The lane in a tab loaded off: another tab's reader footer can never reach it, because it never listens.
    const sid = (value: string): SessionId => value as SessionId
    const store = createSnapshotStore<ThreadListState>({
      ids: [sid('t-1')],
      byId: { [sid('t-1')]: { id: sid('t-1'), displayTitle: 'hello', running: false, blank: false, updatedAt: 1, retainedBy: {} } },
      phase: 'ready',
    })
    const view = render(createElement(ThreadsLane, {
      useSessions: bindSnapshotSelector(store), openThread: () => {}, openConversation: () => {},
    }))
    expect(FakeChannel.opened).toHaveLength(0)
    expect(view.container.querySelector('[data-threads-cloud-note]')).toBeNull()
  })
})
