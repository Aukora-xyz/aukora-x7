import { useEffect } from 'react'
import type { ConversationSessionSlotProps } from '../contract/slots.ts'
import { conversationPhase } from '../contract/snapshot.ts'
import { resolveActiveView } from '../view-selection.ts'
import { FIXED_VIEW_ID } from '../view-pins.ts'
import { spatialChrome } from './spatial-chrome.ts'
import css from './ConversationRoot.module.css'

/**
 * Renders the active Session view inside the resident scrollport and keeps
 * the input draft persisted while blank Hero chrome is visible.
 * @param props - Strict Session input/store, view ledger, and render shares.
 * @returns the active view area, or null while the Session remains blank.
 */
export function DefaultConversationViews({
  view, useSession, useConversation, useConversationViews, inputActions, useStore, actions,
  renderSlot, bindDraftPersistence, openView, useInspectCall,
}: ConversationSessionSlotProps) {
  const tabs = useConversationViews(value => value)
  const inspectCall = useInspectCall(value => value)
  const selectedId = useStore(s => s.view)
  // The Spatial line has no view tabs (Round 23), so it always shows the conversation itself: a view remembered from the
  // classic shell (Trajectory, say) would otherwise strand the thread on a view with no way back.
  const compact = spatialChrome() !== null
  const active = compact ? tabs.find(tab => tab.id === FIXED_VIEW_ID) ?? resolveActiveView(tabs, selectedId)
    : resolveActiveView(tabs, selectedId)
  const session = useSession(s => s)
  const conversation = useConversation(s => s)
  const viewRequest = useStore(s => s.viewRequest ?? null)

  useEffect(() => {
    const unbindDraftPersistence = bindDraftPersistence(actions.setDraft)
    inputActions.persistDraft()
    return () => { unbindDraftPersistence() }
    // The Session input owns content before this persistence writer is attached.
  }, [inputActions])

  if (session.blank && conversationPhase(session, conversation) === 'blank') return null
  const viewId = view ?? active?.id
  return (
    <div className={css.viewArea}>
      {viewId !== undefined && renderSlot('conversation.view', {
        // No Inspect where no other view can be shown: it would only move the hidden view.
        inspectCall: compact ? undefined : inspectCall,
        viewRequest,
        openView,
        completeViewRequest: actions.completeViewRequest,
      }, { only: viewId })}
    </div>
  )
}
