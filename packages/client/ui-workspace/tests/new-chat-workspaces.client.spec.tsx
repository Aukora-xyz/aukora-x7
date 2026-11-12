// @vitest-environment jsdom
/**
 * The new-chat workspace picker offers one workspace, `auma` (/dsh/home/auma). The
 * legacy `auma-one` workspace is hidden from the picker only; it stays registered with its threads.
 */
import { contextMenuHook, allowAllAccess, bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceId, WorkspaceSnapshot, WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import type { SessionStatusSnapshot } from '@deepseek-ai/dsh-client-ui-session/client'
import type { DirectoryFlowOwnerProps, WorkspacePickerProps } from '../src/client/contract/slots.ts'
import { WorkspacePicker } from '../src/client/WorkspacePicker.tsx'
import { zh } from '../src/client/locales.ts'
import { AUMA_ONE_WORKSPACE_PATH, AUMA_WORKSPACE_PATH, newChatWorkspaces } from '../src/client/new-chat-workspaces.ts'

afterEach(cleanup)

const useResource = (() => ({ status: 'none' as const, value: undefined, failure: undefined, reload: () => {} })) as GlobalStandardProps['useResource']
const usePanelInfo: GlobalStandardProps['usePanelInfo'] = selector => selector({ activePanelId: null })
const t: WorkspacePickerProps['t'] = makeTranslate(zh, commonZh)
const sessions: SessionListState = { ids: [], byId: {}, phase: 'ready', projectionsBySession: {} }
const noPendingInteraction: SessionStatusSnapshot = new Map()
const hook = <T,>(snapshot: T) => function select<S>(selector: (state: T) => S): S { return selector(snapshot) }
const workspaceState = (items: readonly WorkspaceView[]): WorkspaceSnapshot => ({
  items, archivedSessionIds: [], pinnedSessionIds: [], state: 'idle', phase: 'ready', error: null,
})
function workspace(id: string, path: string, title = id, sessionIds: string[] = []): WorkspaceView {
  return {
    workspaceId: id as WorkspaceId, path, title, sessionIds: sessionIds as never,
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

function mount(items: readonly WorkspaceView[]) {
  const onPick = vi.fn()
  const anchorRef = { current: document.createElement('button') }
  const flow: { owner: DirectoryFlowOwnerProps | undefined } = { owner: undefined }
  const renderSlot = ((_name: string, owner: DirectoryFlowOwnerProps) => {
    flow.owner = owner
    return owner.open ? <div /> : null
  }) as never
  const useDirectoryFlow = bindSnapshotSelector({ getSnapshot: () => true, subscribe: () => () => {} })
  render(
    <WorkspacePicker
      open
      anchorRef={anchorRef}
      useSessions={hook(sessions)}
      useSessionStatus={hook(noPendingInteraction)}
      useSessionRetainInfo={() => undefined}
      usePanelInfo={usePanelInfo} useContextMenu={contextMenuHook()} useResource={useResource}
      useWorkspaces={hook(workspaceState(items))}
      {...allowAllAccess}
      onPick={onPick}
      onClose={vi.fn()}
      createWorkspace={vi.fn()}
      useDirectoryFlow={useDirectoryFlow}
      renderSlot={renderSlot}
      t={t}
    />,
  )
  return { onPick, flow }
}

const AUMA = workspace('ws-auma', AUMA_WORKSPACE_PATH, 'auma')
const AUMA_ONE = workspace('ws-auma-one', AUMA_ONE_WORKSPACE_PATH, 'auma-one', ['s-old-1', 's-old-2'])
const OTHER = workspace('ws-other', '/projects/other', 'other')

describe('the new-chat workspace policy', () => {
  it('lists her root alone when it is registered', () => {
    expect(newChatWorkspaces([AUMA_ONE, OTHER, AUMA])).toEqual([AUMA])
    expect(newChatWorkspaces([{ ...AUMA, path: `${AUMA_WORKSPACE_PATH}/` }]).length).toBe(1)
  })

  it('without her root it hides only auma-one, never leaving an empty list when others exist', () => {
    expect(newChatWorkspaces([AUMA_ONE, OTHER])).toEqual([OTHER])
    expect(newChatWorkspaces([AUMA_ONE])).toEqual([])
  })

  it('does not change the workspace records themselves: auma-one keeps its sessions', () => {
    const all = [AUMA_ONE, AUMA]
    newChatWorkspaces(all)
    expect(all[0]?.sessionIds).toEqual(['s-old-1', 's-old-2'])
  })
})

describe('the new-chat WorkspacePicker', () => {
  it('offers only auma, plus the add action, and picks it', () => {
    const { onPick } = mount([AUMA_ONE, OTHER, AUMA])
    expect(screen.getAllByRole('menuitem').map(entry => entry.textContent)).toEqual(['auma', '添加工作区…'])
    fireEvent.click(screen.getByRole('menuitem', { name: 'auma' }))
    expect(onPick).toHaveBeenCalledWith('ws-auma')
  })

  // With auma-one the only workspace, the filtered menu was empty, the footer was computed from
  // the unfiltered list, and the empty menu closed, hiding Add too.
  it('when auma-one is the only workspace the picker is not inert: Add is offered, auma-one never is', () => {
    const { flow } = mount([AUMA_ONE])
    expect(screen.queryByRole('menuitem', { name: 'auma-one' })).toBeNull()
    // Add is the only entry, so the picker goes straight to the folder flow, as with no workspace at all.
    expect(flow.owner?.open).toBe(true)
  })

  it('never offers auma-one', () => {
    mount([AUMA_ONE, OTHER])
    expect(screen.queryByRole('menuitem', { name: 'auma-one' })).toBeNull()
    expect(screen.getByRole('menuitem', { name: 'other' })).toBeTruthy()
  })
})
