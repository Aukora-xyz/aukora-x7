/**
 * Transient spatial-layout state for the root shell. Pane geometry is a
 * closed set of fractional presets rather than mutable pixel preferences;
 * surfaces and details share the same action set so every navigation gesture
 * produces one atomic shell state.
 */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'
import { panelIdOfSurface } from './service.ts'

/** Fractional lane arrangement: [threads, active surface, menu/details]. */
export type PanePreset =
  | 'balanced'
  | 'left-wide'
  | 'left-menu-wide'
  | 'left-focus'
  | 'center-left-wide'
  | 'center-right-wide'
  | 'center-focus'
  | 'right-wide'
  | 'right-threads-wide'
  | 'right-focus'

/** Whether a focused application owns the whole canvas or a centered content shell. */
export type SurfacePresentation = 'contained' | 'full-bleed'

/** Fractional track weights for every supported pane preset. */
export const PANE_WEIGHTS: Readonly<Record<PanePreset, readonly [number, number, number]>> = {
  balanced: [1, 1, 1],
  'left-wide': [2, 1, 0],
  'left-menu-wide': [2, 0, 1],
  'left-focus': [3, 0, 0],
  'center-left-wide': [0, 2, 1],
  'center-right-wide': [1, 2, 0],
  'center-focus': [0, 3, 0],
  'right-wide': [0, 1, 2],
  'right-threads-wide': [1, 0, 2],
  'right-focus': [0, 0, 3],
}

type PaneWeights = readonly [number, number, number]

const PRESET_BY_WEIGHTS = new Map<string, PanePreset>(
  Object.entries(PANE_WEIGHTS).map(([preset, weights]) => [weights.join(','), preset as PanePreset]),
)

/**
 * Resolve one of the ten integer compositions of three lane thirds.
 * @param weights - next [threads, surface, menu/details] weights.
 * @returns the named preset for those weights.
 */
function presetFor(weights: PaneWeights): PanePreset {
  const preset = PRESET_BY_WEIGHTS.get(weights.join(','))
  if (preset === undefined) throw new Error(`layout: unsupported pane weights ${weights.join('/')}`)
  return preset
}

/**
 * Grow an outer lane by one third, taking space from the far side first.
 * Full-screen outer lanes return one third to the adjacent center lane.
 * @param current - current pane preset.
 * @param side - outer lane whose only hot corner was activated.
 * @returns the next pane preset, or the current preset when that lane is hidden.
 */
function cycleOuterPane(current: PanePreset, side: 'left' | 'right'): PanePreset {
  const [left, center, right] = PANE_WEIGHTS[current]
  if (side === 'left') {
    if (left === 0) return current
    if (left === 3) return presetFor([2, 1, 0])
    if (right > 0) return presetFor([left + 1, center, right - 1])
    return presetFor([left + 1, center - 1, right])
  }
  if (right === 0) return current
  if (right === 3) return presetFor([0, 1, 2])
  if (left > 0) return presetFor([left - 1, center, right + 1])
  return presetFor([left, center - 1, right + 1])
}

/**
 * Transfer one third across a center-lane boundary. A boundary at the frame
 * edge pulls its adjacent outer lane in; an inset boundary expands center.
 * @param current - current pane preset.
 * @param side - center boundary whose hot corner was activated.
 * @returns the next pane preset, or the current preset when center is hidden.
 */
function cycleCenterBoundary(current: PanePreset, side: 'left' | 'right'): PanePreset {
  const [left, center, right] = PANE_WEIGHTS[current]
  if (center === 0) return current
  if (side === 'left') {
    if (left === 0) return presetFor([1, center - 1, right])
    return presetFor([left - 1, center + 1, right])
  }
  if (right === 0) return presetFor([left, center - 1, 1])
  return presetFor([left, center + 1, right - 1])
}

/**
 * The one lane a COMPACT frame shows (a window 1023px wide or narrower): the conversation or thread list, the active
 * application, or the menu. It is the compact frame's own horizontal location, kept apart from `panePreset` (the
 * desktop's thirds), so nothing a person does on a phone moves the desktop geometry they return to.
 */
export type CompactLane = 'left' | 'center' | 'right'

/** Root shell viewing state. */
export interface LayoutState {
  /** Application surface shown in the center lane; absent leaves the app canvas empty. */
  activeSurface?: string
  /** Optional feature-owned target within the active surface. */
  surfaceTarget?: string
  /** Focused-canvas behavior selected by the active application. */
  surfacePresentation?: SurfacePresentation
  /** Whether the left lane shows the resident Conversation instead of the thread browser. */
  conversationOpen: boolean
  /** Whether a real Session may replace the right menu with details. */
  detailsOpen: boolean
  /**
   * What the details seat last REPORTED: whether its panel is drawn. The seat reports through `openDetails` and
   * `closeDetails` (`ctx.layout.openRightbar` / `closeRightbar`) whenever its presentation changes, and a resize
   * changes only how the panel is presented; only a report that the panel became drawn is a reveal. The report a seat
   * makes when a harness panel switches it off does not reset it (see `closeDetails`).
   */
  detailsShown: boolean
  /** Current fractional lane arrangement. */
  panePreset: PanePreset
  /**
   * ACTIVATION PENDING: the session the frame has just made current, until a person's gesture or a `shown: false`
   * report settles it (`markActivation`). While it is set, a details seat's `shown: true` report is that session's
   * activation report, the seat restating what it draws for the session, and not a person's request to reveal details:
   * it gives the right lane the details face but moves no lane and no preset.
   */
  activationPending?: string
  /**
   * ACTIVATION REPORT OUTSTANDING (review ui3): the session whose activation report the details seat has not made
   * yet. Set with `activationPending` and cleared only when that report comes (`openDetails` or `closeDetails`) or is
   * cancelled (the next switch, which also cancels the departing seat's delayed report, or no session at all). A
   * person's gesture never clears it: a corner pressed while a fullscreen panel is still sliding in settles the
   * activation, and the late report that follows must still move no lane and no preset.
   */
  activationReport?: string
  /** Whether the frame is compact: one full-width lane at a time. The frame sets it from the viewport. */
  compact: boolean
  /** The lane a compact frame shows; kept while the frame is wide, for the next time it is compact. */
  compactLane: CompactLane
}

/** Complete mutation set exposed to the root component and ctx.layout. */
type LayoutActions = {
  cycleLeft: (draft: LayoutState) => void
  cycleCenterLeft: (draft: LayoutState) => void
  cycleCenterRight: (draft: LayoutState) => void
  cycleRight: (draft: LayoutState) => void
  selectSurface: (
    draft: LayoutState,
    id: string,
    target?: string,
    presentation?: SurfacePresentation,
  ) => void
  closeSurface: (draft: LayoutState) => void
  openConversation: (draft: LayoutState) => void
  closeConversation: (draft: LayoutState) => void
  toggleSidebar: (draft: LayoutState) => void
  openDetails: (draft: LayoutState) => void
  closeDetails: (draft: LayoutState) => void
  hideDetails: (draft: LayoutState) => void
  enterCompact: (draft: LayoutState, lane?: CompactLane) => void
  leaveCompact: (draft: LayoutState) => void
  showCompactLane: (draft: LayoutState, lane: CompactLane) => void
  markActivation: (draft: LayoutState, session: string | undefined) => void
}

/**
 * A person's gesture (a corner, a preset choice) or a `shown: false` report: the activation is over, and the details
 * seat's reports mean again what they meant before it.
 * @param d - the layout draft.
 */
function settleActivation(d: LayoutState): void {
  delete d.activationPending
}

/**
 * The seat's report for the session made current has come (or the switch it belonged to is over): from now on its
 * reports are a person's again.
 * @param d - the layout draft.
 * @returns whether that report was still outstanding.
 */
function takeActivationReport(d: LayoutState): boolean {
  const outstanding = d.activationReport !== undefined
  delete d.activationReport
  return outstanding
}

/**
 * Create an independent spatial-layout store. State is intentionally
 * transient: a reload returns to the balanced conversation shell.
 * @returns the store handle used by the root slot registration.
 */
export function createLayoutStore(): EngineStoreHandle<LayoutState, LayoutActions> {
  return defineStore({
    init: (): LayoutState => ({
      conversationOpen: false,
      detailsOpen: false,
      detailsShown: false,
      panePreset: 'balanced',
      // THE PREDECESSOR'S BOOT STATE: the centre lane opens on Aura Coherence (the Pentora), not on the empty app canvas.
      activeSurface: 'aura-coherence',
      surfacePresentation: 'contained',
      // A COMPACT FRAME OPENS ON THE THREAD LIST, the same face a wide frame's left lane opens on.
      compact: false,
      compactLane: 'left',
    }),
    actions: {
      // COMPACT, EVERY CORNER NAMES A LANE (spec section 7): the app's upper left shows the
      // conversation or thread list, its upper right the menu, and the outer lanes' inner corners return to the app.
      // On a desktop the same corners cycle the thirds exactly as before.
      cycleLeft: (d) => {
        settleActivation(d)
        if (d.compact) d.compactLane = 'center'
        else d.panePreset = cycleOuterPane(d.panePreset, 'left')
      },
      cycleCenterLeft: (d) => {
        settleActivation(d)
        if (d.compact) d.compactLane = 'left'
        else d.panePreset = cycleCenterBoundary(d.panePreset, 'left')
      },
      cycleCenterRight: (d) => {
        settleActivation(d)
        if (d.compact) d.compactLane = 'right'
        else d.panePreset = cycleCenterBoundary(d.panePreset, 'right')
      },
      cycleRight: (d) => {
        settleActivation(d)
        if (d.compact) d.compactLane = 'center'
        else d.panePreset = cycleOuterPane(d.panePreset, 'right')
      },
      selectSurface: (
        d,
        id: string,
        target?: string,
        presentation: SurfacePresentation = 'contained',
      ) => {
        d.activeSurface = id
        d.surfacePresentation = presentation
        if (target === undefined) delete d.surfaceTarget
        else d.surfaceTarget = target
        d.detailsOpen = false
        // AN APP OPENED IS AN APP SHOWN: compact, the centre lane comes to the front, whoever opened it (the menu, a
        // card's Inspect, an invite link, her own navigation).
        d.compactLane = 'center'
        // DESIGN RULE 3: picking an app changes only the centre lane; the lane widths stay the owner's.
        // Only a centre the owner has hidden entirely is brought back, as one third of a balanced frame.
        if (!d.compact && PANE_WEIGHTS[d.panePreset][1] === 0) d.panePreset = 'balanced'
      },
      closeSurface: (d) => {
        delete d.activeSurface
        delete d.surfaceTarget
        delete d.surfacePresentation
        d.detailsOpen = false
        // RULE 3, BOTH WAYS (sweep C9): closing an app leaves the lanes as the owner set them, as opening does.
      },
      openConversation: (d) => {
        d.conversationOpen = true
        d.detailsOpen = false
        d.compactLane = 'left'
        if (!d.compact && PANE_WEIGHTS[d.panePreset][0] === 0) d.panePreset = 'balanced'
      },
      closeConversation: (d) => {
        d.conversationOpen = false
        d.detailsOpen = false
        d.compactLane = 'left'
        if (!d.compact && PANE_WEIGHTS[d.panePreset][0] === 0) d.panePreset = 'balanced'
      },
      toggleSidebar: (d) => {
        settleActivation(d)
        if (d.compact) d.compactLane = d.compactLane === 'left' ? 'center' : 'left'
        else d.panePreset = PANE_WEIGHTS[d.panePreset][0] === 0 ? 'balanced' : 'center-left-wide'
      },
      // A REPORT IS NOT A REQUEST. The details seat reports its
      // presentation again whenever any part of it changes: crossing 768px switches it to fullscreen, and returning to a
      // desktop switches it back. Such a report repeats `shown`, and it moves nothing: not the compact lane (the caret
      // and the lane the person chose stay), not the desktop preset (a restored `left-wide` stays), not which face the
      // right lane shows. Only a report that the panel BECAME drawn, from a person's expand, brings the details forward,
      // as before. The seat switching off and on again around a harness panel is not that (see `closeDetails`), and
      // neither is a session's activation (see `markActivation`).
      openDetails: (d) => {
        // The activation report is this one whenever it is still outstanding, whatever a person did since the switch.
        const activation = takeActivationReport(d)
        if (d.detailsShown) return
        d.detailsShown = true
        d.detailsOpen = true
        if (activation || d.activationPending !== undefined) return
        if (d.compact) d.compactLane = 'right'
        else d.panePreset = 'balanced'
      },
      // A RELEASE IS NOT A COLLAPSE. While a harness panel holds the centre the seat is switched
      // off (`panelInfo` is derived from this store's `activeSurface`), and a seat switching off reports that it draws
      // nothing: that is the seat letting go of its panel, not a person collapsing it, and an inactive seat reports
      // nothing else. Its last report stands, so drawing the same expanded panel again when an app replaces the panel
      // is not a reveal: it moves neither the compact lane nor the desktop preset.
      // A `shown: false` report also settles an activation: the seat draws nothing for the session now, so its next
      // `shown: true` can only follow a person's expand.
      closeDetails: (d) => {
        settleActivation(d)
        takeActivationReport(d)
        if (panelIdOfSurface(d.activeSurface) === null) d.detailsShown = false
        d.detailsOpen = false
      },
      // THE FRAME'S OWN WAY BACK TO THE MENU (a session switch): the right lane shows its menu again, and the seat's last
      // report stands, so its next report of the same panel is still not a reveal.
      hideDetails: (d) => { d.detailsOpen = false },
      // THE FRAME CROSSES THE COMPACT LINE. Entering, it shows the lane it is told (the one holding focus, or the
      // desktop's focused lane), else the lane it showed last. Leaving touches nothing else: the desktop preset was
      // never moved while compact, so the desktop comes back exactly as the owner left it.
      enterCompact: (d, lane?: CompactLane) => {
        d.compact = true
        if (lane !== undefined) d.compactLane = lane
      },
      leaveCompact: (d) => { d.compact = false },
      showCompactLane: (d, lane: CompactLane) => {
        settleActivation(d)
        d.compactLane = lane
      },
      // A SESSION SWITCH IS NOT A GESTURE (compact and desktop). The
      // details seat restates its stored expanded state whenever a session becomes current, through the same
      // `openDetails` a person's expand uses: in the commit of the switch or, for a panel saved fullscreen, only after
      // its slide, in a later task. The frame marks the activation in the switch commit, before the seat's own effects
      // run (`ActivationMark` in AppFrame.tsx sits ahead of the seat), so every such report, whenever it arrives, is
      // known for what it is: it moves no lane and no preset. It still gives the right lane the details face (an independent
      // review): a report that comes after the frame's own effects (a fullscreen panel's, after its slide) must leave
      // the saved details there for the corner that shows that lane, since the expand control is gone while they are
      // expanded. A report in the switch commit is followed, as before job 2, by the frame's `hideDetails` (a
      // thread-to-thread switch) or its conversation opener's `openConversation` (a blank boot or a reload), which close
      // that face again. A person's gesture or a `shown: false` report settles the mark; a later `shown: true` is
      // then a person's expand again.
      // THE OUTSTANDING REPORT IS KEPT APART FROM THE GESTURES (review ui3, MUST). A corner settles the mark, so the
      // geometry answers again; it does not settle the report the seat still owes for this session. That report is
      // suppressed until it comes (`openDetails`, `closeDetails`) or is cancelled: a new switch replaces it here, as the
      // departing seat's delayed callback is cancelled, and no current session drops it.
      markActivation: (d, session: string | undefined) => {
        if (session === undefined) {
          settleActivation(d)
          takeActivationReport(d)
        } else {
          d.activationPending = session
          d.activationReport = session
        }
      },
    },
  })
}
