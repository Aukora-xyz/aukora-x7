// @vitest-environment jsdom
/**
 * Auma is the meta-workspace (North Star §24.2): where a thread lives, in words for its card; where a new thread starts;
 * and the law's first rule here, that no thread is hidden: a thread from the legacy `/dsh/home/auma-one` and a thread in a
 * sub-workspace are listed beside her root's threads, each named for where it lives.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { AUMA_LEGACY_PATH, AUMA_ROOT_PATH, newThreadTarget, threadPlaceOf } from '../src/client/spatial/meta-workspace.ts'
import { ThreadsLane, type ThreadListState, type ThreadSummary } from '../src/client/spatial/portal/ThreadsLane.tsx'

afterEach(() => { cleanup() })
const sid = (value: string): SessionId => value as SessionId
const row = (id: string, displayTitle: string, cwd?: string): ThreadSummary => ({
  id: sid(id), displayTitle, running: false, blank: false, updatedAt: 1, retainedBy: {}, ...(cwd === undefined ? {} : { cwd }),
})

describe('Auma is the meta-workspace', () => {
  it('names where a thread lives from its cwd: nothing for her root, the sub-workspace, or the legacy auma-one', () => {
    expect(AUMA_ROOT_PATH).toBe('/dsh/home/auma')
    expect(threadPlaceOf('/dsh/home/auma')).toBeNull()
    expect(threadPlaceOf('/dsh/home/auma/')).toBeNull()
    expect(threadPlaceOf('/dsh/home/auma/memory')).toBeNull()
    expect(threadPlaceOf('/dsh/home/auma/workspaces')).toBeNull()
    expect(threadPlaceOf('/dsh/home/auma/workspaces/garden')).toEqual({ kind: 'sub', name: 'garden' })
    expect(threadPlaceOf('/dsh/home/auma/workspaces/garden/src/deep/')).toEqual({ kind: 'sub', name: 'garden' })
    expect(threadPlaceOf(AUMA_LEGACY_PATH)).toEqual({ kind: 'legacy', name: 'auma-one' })
    expect(threadPlaceOf('/dsh/home/auma-one/docs')).toEqual({ kind: 'legacy', name: 'auma-one' })
    // A look-alike is not her legacy workspace, and a thread with no cwd claims nothing.
    expect(threadPlaceOf('/dsh/home/auma-one-more')).toBeNull()
    expect(threadPlaceOf('/dsh/home/auma-workspaces/x')).toBeNull()
    expect(threadPlaceOf(undefined)).toBeNull()
  })

  it('a new thread starts in her root: the registered one, the first-use default, or registered beside what exists', () => {
    expect(newThreadTarget([])).toEqual({ kind: 'first-use' })
    expect(newThreadTarget([{ workspaceId: 'w-legacy', path: AUMA_LEGACY_PATH }])).toEqual({ kind: 'register-root' })
    expect(newThreadTarget([{ workspaceId: 'w-legacy', path: AUMA_LEGACY_PATH }, { workspaceId: 'w-root', path: AUMA_ROOT_PATH }]))
      .toEqual({ kind: 'root', workspaceId: 'w-root' })
    // A workspace list that names no paths (an older client service) never claims the root.
    expect(newThreadTarget([{ workspaceId: 'w-1' }])).toEqual({ kind: 'register-root' })
  })

  it('no thread vanishes: legacy auma-one threads and sub-workspace threads are listed beside her root\'s, each with its name', () => {
    const store = createSnapshotStore<ThreadListState>({
      ids: [sid('t-hello'), sid('t-root'), sid('t-sub'), sid('t-none')],
      byId: {
        [sid('t-hello')]: row('t-hello', 'hello', AUMA_LEGACY_PATH),
        [sid('t-root')]: row('t-root', 'in her root', AUMA_ROOT_PATH),
        [sid('t-sub')]: row('t-sub', 'garden work', '/dsh/home/auma/workspaces/garden'),
        [sid('t-none')]: row('t-none', 'no cwd reported'),
      },
      phase: 'ready',
    })
    const { container } = render(
      <ThreadsLane useSessions={bindSnapshotSelector(store)} openThread={() => {}} openConversation={() => {}} />,
    )
    const cards = [...container.querySelectorAll('[data-thread-id]')]
    expect(cards.map(card => card.getAttribute('data-thread-id')).sort()).toEqual(['t-hello', 't-none', 't-root', 't-sub'])
    const place = (id: string) => container.querySelector(`[data-thread-id="${id}"] [data-thread-place]`)
    expect([place('t-hello')?.getAttribute('data-thread-place'), place('t-hello')?.textContent]).toEqual(['legacy', 'auma-one'])
    expect([place('t-sub')?.getAttribute('data-thread-place'), place('t-sub')?.textContent]).toEqual(['sub', 'garden'])
    expect(place('t-root')).toBeNull()
    expect(place('t-none')).toBeNull()
    expect(container.querySelector('[data-thread-id="t-hello"]')?.textContent).toContain('hello')
  })
})
