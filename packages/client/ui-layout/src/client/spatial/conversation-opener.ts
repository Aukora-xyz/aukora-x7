/**
 * WHEN THE FRAME OPENS THE CONVERSATION BY ITSELF — one pure decision, so a court can drive it with the page's
 * real load sequence instead of reading a comment that says it is right.
 *
 * THE DEFECT THIS EXISTS FOR. The frame watched `sessions.current` and opened the resident Conversation every time
 * it changed to a session — and it starts out not knowing any session, so the FIRST session a page ever sees
 * opened it. That first session is never a person's choice: it is either the persisted `dsh.sessions.current`
 * restored by the Session Controller once the list loads, or the latest workspace's blank session that the
 * threads face's startup policy (`watchNavigation`) opens when nothing was restored. Either way, every app start
 * put the empty "Into the Unknown" composer over the thread list with nobody touching anything, and the owner read it
 * as his threads being gone.
 *
 * EVERY WRITER OF `sessions.current`, TRACED (the Session Controller's `current` is its selection while that
 * session is listed, else undefined — `manager.ts`, the list projection — and the selection moves only through
 * `open`, `openSubagent`, `clear` and the constructor's restore):
 *   · AT LOAD, NOBODY TOUCHING ANYTHING — the restore (undefined → the persisted session); the startup policy
 *     (undefined → the latest workspace's BLANK session); an archived restore cleared and replaced (persisted →
 *     undefined → a blank session); a reconnect re-pull masking the selection and resurfacing it (X → undefined
 *     → X). React may commit any of these with the undefined step batched away.
 *   · A PERSON'S GESTURE — a thread chosen, New Session, a fork, a workspace picked in the hero, Creator draft.
 *     Each of these calls `ctx.layout.openConversation()` itself, in the threads face's `UiWorkspaceService`,
 *     because only the gesture knows a person made it. Choosing the thread that is ALREADY current — the one the
 *     page just restored, which is the thread the owner clicks first — changes no selection at all, so nothing but
 *     that explicit call could open it.
 *   · IN-CONVERSATION GESTURES THE HARNESS OWNS — fork at a message (ui-chat), open a workflow run's session
 *     (ui-workflow-run), open a subagent child (ui-subagent). They call `sessions.open` / `openSubagent`
 *     directly, never `openConversation`, and they switch from one real thread to another. The frame keeps
 *     opening for exactly that shape, as the net under any selector that does not say so itself.
 *
 * THE RULE (X6.1, round 5): open the conversation when (a) the page's first observation is a live NON-BLANK
 * Session (not preview-*), so a reload restores the thread pane and a blank boot session leaves THREADS showing;
 * or (b) the selection SWITCHES from a session it was already showing to a DIFFERENT live Session, blank included,
 * because x6.1's stock threads face never calls
 * `openConversation` for New Session. Nothing selected, fixture preview Sessions on first
 * load, the same session again, and a blank session are not a person choosing a thread.
 *
 * @module conversation-opener
 */

/** One observation of the shell's live selection, exactly as the frame's session subscription delivers it. */
export interface SelectionObservation {
  /** The current session, or undefined when nothing is selected (not yet, cleared, or a reconnect gap). */
  readonly session: string | undefined
  /** Whether that session is blank — no conversation yet — or undefined when nothing is selected. */
  readonly blank: boolean | undefined
}

/**
 * Whether one observed change of the current session opens the conversation.
 *
 * @param previous - the session the frame observed last, or undefined when it has seen none since mount or a gap.
 * @param next - the selection now.
 * @returns true for the first live Session observed and for a switch to a different live Session.
 */
export function selectionOpensConversation(previous: string | undefined, next: SelectionObservation): boolean {
  // NOTHING SELECTED OPENS NOTHING: a clear, or a reconnect re-pull masking the selection.
  if (next.session === undefined) return false
  // FIRST OBSERVATION ON THIS PAGE: restore a live non-blank Session into the conversation pane so a reload
  // shows the same thread (marker, history) instead of "APPS OPEN HERE". Fixture preview-* Sessions (Showcase)
  // stay on the list — they must never replace a live Session after reload.
  if (previous === undefined) {
    // ROUND 5 (from the predecessor's design): the page's first look opens a restored REAL thread, never a blank one. The
    // startup policy's blank session would otherwise cover the THREADS list on every boot; with it left closed, the
    // list shows and New Session (or a thread) opens the composer. Preview fixtures stay on the list too.
    return next.blank === false && !next.session.startsWith('preview-')
  }
  // THE SAME SESSION AGAIN IS NOT A SELECTION — including a blank session getting its first message.
  if (next.session === previous) return false
  // X6.1: the stock threads face does not call `ctx.layout.openConversation()` for New Session, so a switch to a
  // DIFFERENT live Session opens the conversation even when it is blank; otherwise New Session would leave the
  // composer hidden behind the thread list. Fixture preview-* Sessions still never open by themselves.
  return !next.session.startsWith('preview-')
}

/** The frame's memory between renders: the last session it observed, fed through the decision above. */
export class ConversationOpener {
  #previous: string | undefined = undefined

  /**
   * Record one observation of the selection.
   * @param next - the selection the frame's subscription delivers now.
   * @returns whether the frame opens the conversation for it.
   */
  observe(next: SelectionObservation): boolean {
    // A first look that cannot yet say whether the session is blank decides nothing: it waits for the answer.
    if (this.#previous === undefined && next.session !== undefined && next.blank === undefined) return false
    const opens = selectionOpensConversation(this.#previous, next)
    this.#previous = next.session
    return opens
  }
}
