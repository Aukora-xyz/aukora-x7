/**
 * Spatial root shell: a persistent left thread/conversation stack, center app
 * canvas, and right menu/details. Every occupant remains mounted across lane
 * navigation; hot corners select one of the store's closed presets.
 */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { useCallback, useId, useLayoutEffect, useRef, useState, useEffect, useSyncExternalStore } from 'react'
import { installPageEyes } from './eyes/page-eyes.ts'
import type { CSSProperties, ReactNode } from 'react'
import type {
  PropsLocale, PropsRenderSlots, PropsRuntime, PropsStore,
} from '@deepseek-ai/dsh-client-ui-slots'
import type { MenuItemOwnerProps, SurfaceOwnerProps } from './types.ts'
import { NS } from './locales.ts'
import { PANE_WEIGHTS, type CompactLane, type PanePreset, type createLayoutStore } from './stores.ts'
import css from './SpatialFrame.module.css'
import { AUMA_LIVE_SURFACE, AUMA_MINDS_PATH, AUMA_STATUS_PATH, aumaStatusOf, lanesRunningOf } from './auma-status.ts'
import { waitingAgeText, waitingOf } from './waiting.ts'
import { ConversationOpener } from './conversation-opener.ts'
import { FingerprintWaiting } from './portal/FingerprintWaiting.tsx'
import { ThreadsLane, type ThreadsLaneProps } from './portal/ThreadsLane.tsx'
import { panelIdOfSurface } from './service.ts'
import type { WorkReaderDoor } from './work/index.ts'
import { sessionOf, WORK_SURFACE } from './work/WorkSurface.tsx'
import { NOTICES_SURFACE, useNoticeFeed } from './portal/notices.ts'
import { AURA_SURFACE } from './aura/model.ts'

/**
 * The Session the main view shows. DSH 0.2.1-alpha.5 removed `SessionListState.current` (the Session Controller no
 * longer owns a selection; "navigation belongs to view owners"). The harness's own frame reads the selection the way
 * `ui-layout/src/client/DocumentTitle.tsx` does: the listed Session that holds a `mainView` reference.
 * @param sessions - the live Session list snapshot.
 * @returns the main view's Session, or undefined when none is shown.
 */
function mainViewSessionOf(
  sessions: { readonly byId: Readonly<Record<string, { readonly id: SessionId; readonly retainedBy: { readonly mainView?: number } }>> },
): SessionId | undefined {
  return Object.values(sessions.byId).find(session => (session.retainedBy.mainView ?? 0) > 0)?.id
}

/** Full composed props of the root shell. */
export type AppFrameProps =
  & PropsRuntime<'root'>
  & PropsRenderSlots<
    | 'sidebar'
    | 'main'
    | 'rightbar'
    | 'shell.surface'
    | 'shell.menu.apps'
    | 'shell.menu.system'
    | 'shell.menu.yours'
    | 'shell.overlay'
  >
  & PropsStore<ReturnType<typeof createLayoutStore>>
  & PropsLocale<typeof NS>
  /** Opens a thread, injected by this plugin's registration from the client `sessions` service. */
  // **THE PARAMETER MUST BE THE BRANDED `SessionId`, AND `string` HERE IS WHAT FAILED THE WHOLE REGISTRATION.**
  // `index.ts` supplies `openThread: (sessionId: SessionId) => …` and this declares `(sessionId: string) => …`.
  // **A branded string is assignable TO `string`, but a FUNCTION taking the branded type is not assignable to one
  // taking the plain type** — parameters are contravariant, so the mismatch surfaced as `TS2769: No overload matches
  // this call` at the `register(...)` site rather than as an error here. **The message pointed at the callee; the
  // defect was in the contract.**
  & {
    readonly openThread?: (sessionId: SessionId) => void
    readonly newThread?: () => void
    readonly setPinned?: (sessionId: SessionId, pinned: boolean) => Promise<void>
    readonly setArchived?: (sessionId: SessionId, archived: boolean, stopActivity: boolean) => Promise<void>
    /** The host rename (Round 23): the durable title both the Threads card and the open thread's header read. */
    readonly renameThread?: (sessionId: SessionId, title: string) => Promise<string>
    /** Where the page's reader of her files is (Lane B3), for the chat lane's Fingerprint card. */
    readonly homeReader?: WorkReaderDoor
  }

const NO_DOOR = (): (() => void) => () => {}
const NO_READER = (): null => null

type Lane = CompactLane
type MenuTab = 'apps' | 'system' | 'yours'

/**
 * The lanes the host reported, with each one's waiting fact — or NULL when it did not report them at all.
 *
 * **NULL AND AN EMPTY LIST ARE DIFFERENT ANSWERS.** Null means the payload carried no `waiting` field, so nobody
 * knows; an empty list would mean every lane was read and none is waiting. The render keeps them apart for the same
 * reason the fact module does.
 */
function waitingLanesOf(
  answer: unknown,
  now: number,
): readonly { readonly lane: string; readonly sessionId: string; readonly fact: ReturnType<typeof waitingOf> }[] | null {
  if (answer === null || typeof answer !== 'object') return null
  const waiting = (answer as { waiting?: unknown }).waiting
  if (!Array.isArray(waiting)) return null
  return waiting.flatMap((entry) => {
    if (entry === null || typeof entry !== 'object') return []
    const { lane, sessionId, events } = entry as { lane?: unknown; sessionId?: unknown; events?: unknown }
    if (typeof lane !== 'string' || lane === '' || typeof sessionId !== 'string' || sessionId === '') return []
    if (!Array.isArray(events)) return []
    return [{ lane, sessionId, fact: waitingOf({ lane, now, events: events as Parameters<typeof waitingOf>[0]['events'] }) }]
  })
}

/** Frame padding plus the two fixed inter-lane gaps. */
const FRAME_FIXED_INLINE_SPACE = 32

/**
 * THE COMPACT LINE (spec section 7). At this width and below the frame shows ONE lane at a time at
 * full width; the same query opens the compact block at the end of SpatialFrame.module.css, so the page and the
 * stylesheet always agree about which frame is drawn. Above it nothing changes (tests/spatial-compact.client.spec.tsx).
 */
export const COMPACT_QUERY = '(max-width: 1023px)'

const LANES = ['left', 'center', 'right'] as const

/** The words each lane's region already carries; a compact corner is named by the lane it shows. */
const LANE_LABEL_KEYS = { left: 'lane.threads', center: 'lane.surface', right: 'lane.menu' } as const

/**
 * The compact query, or null where the page has no `matchMedia` (then the frame is the desktop frame).
 * @returns the live media query list.
 */
function compactQuery(): MediaQueryList | null {
  try {
    return typeof globalThis.matchMedia === 'function' ? globalThis.matchMedia(COMPACT_QUERY) : null
  } catch {
    return null
  }
}

/**
 * Follow the compact query as the window is resized or the device turns.
 * @param onChange - called when the answer may have changed.
 * @returns the unsubscribe.
 */
function subscribeCompact(onChange: () => void): () => void {
  // A page whose `matchMedia` answers without listeners (an old engine, a stand-in) is never told of a change.
  const query: Partial<Pick<MediaQueryList, 'addEventListener' | 'removeEventListener'>> | null = compactQuery()
  if (query?.addEventListener === undefined) return () => {}
  query.addEventListener('change', onChange)
  return () => { query.removeEventListener?.('change', onChange) }
}

/** @returns whether the viewport is at or under the compact line now. */
function isCompactViewport(): boolean {
  return compactQuery()?.matches === true
}

/** @returns false: a page rendered off-screen is never compact. */
function notCompact(): boolean {
  return false
}

/** The part of the layout the person can see, while compact: its height and how far the frame moves down into it. */
export interface VisibleViewport { readonly height: number; readonly top: number }

/**
 * Where the frame must sit to stay inside the visible viewport. Safari on iPhone (and Chrome on Android by default)
 * shrink only the VISUAL viewport when the software keyboard opens, and may pan the page to the focused field, so a
 * frame of `100dvh` would leave its foot, and the composer, under the keyboard. The frame takes the visible height and
 * moves down by the pan. A pinch zoom is the browser's: a zoomed page gets no answer, and the frame falls back to the
 * dynamic viewport height.
 * @param view - the page's visual viewport.
 * @param unshiftedTop - the frame's top edge, in viewport pixels, before any shift this function asked for.
 * @returns the visible height and shift, or null while zoomed or before the viewport has a height.
 */
export function visibleViewportOf(
  view: Pick<VisualViewport, 'height' | 'offsetTop' | 'scale'>,
  unshiftedTop: number,
): VisibleViewport | null {
  if (Math.abs(view.scale - 1) > 0.01 || view.height <= 0) return null
  return { height: Math.floor(view.height), top: Math.max(0, Math.round(view.offsetTop - unshiftedTop)) }
}

/**
 * Track the visible viewport while compact; null when wide, while zoomed, or where the engine has no visual viewport.
 * @param compact - whether the frame is compact.
 * @param frameRef - the frame element.
 * @returns the visible viewport the frame should fill.
 */
function useVisibleViewport(compact: boolean, frameRef: { readonly current: HTMLElement | null }): VisibleViewport | null {
  const [visible, setVisible] = useState<VisibleViewport | null>(null)
  const shifted = useRef(0)
  useLayoutEffect(() => {
    const frame = frameRef.current
    // An engine without the visual viewport leaves the frame at the dynamic viewport height.
    const view = (globalThis as { visualViewport?: VisualViewport | null }).visualViewport
    if (!compact || frame === null || view === undefined || view === null) return undefined
    let scheduled = 0
    const measure = (): void => {
      scheduled = 0
      const next = visibleViewportOf(view, frame.getBoundingClientRect().top - shifted.current)
      shifted.current = next?.top ?? 0
      setVisible(before => (before?.height === next?.height && before?.top === next?.top ? before : next))
    }
    const schedule = (): void => {
      if (typeof requestAnimationFrame !== 'function') { measure(); return }
      if (scheduled === 0) scheduled = requestAnimationFrame(measure)
    }
    measure()
    view.addEventListener('resize', schedule)
    view.addEventListener('scroll', schedule)
    window.addEventListener('resize', schedule)
    window.addEventListener('scroll', schedule, { passive: true })
    return () => {
      if (scheduled !== 0 && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(scheduled)
      view.removeEventListener('resize', schedule)
      view.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', schedule)
      window.removeEventListener('scroll', schedule)
      shifted.current = 0
      setVisible(null)
    }
  }, [compact, frameRef])
  return compact ? visible : null
}

/**
 * The frame lane that holds the page's focus, if any.
 * @param frame - the frame element.
 * @returns that lane's name.
 */
function laneHoldingFocus(frame: HTMLElement | null): Lane | undefined {
  const focused = document.activeElement
  if (frame === null || focused === null || !frame.contains(focused)) return undefined
  const lane = focused.closest<HTMLElement>('[data-lane]')?.dataset.lane
  return LANES.find(name => name === lane)
}

/**
 * Move focus to a meaningful visible target in a lane just brought to the front: the menu's selected tab, else the
 * first heading not inside a hidden part, else the lane itself. A heading that cannot take focus is given
 * `tabindex="-1"` so it can be focused without entering the tab order, and so is the lane itself when it is the
 * fallback: a desktop render drops the lane's compact `tabindex`, and a centre whose app draws no heading in this
 * document (an app in its own frame) would otherwise refuse the focus (review of the compact frame, SHOULD 5).
 * @param frame - the frame element.
 * @param lane - the lane now in front.
 */
function focusLane(frame: HTMLElement, lane: Lane): void {
  const section = frame.querySelector<HTMLElement>(`:scope > [data-lane="${lane}"]`)
  if (section === null) return
  const selectors = lane === 'right'
    ? '[role="tab"][aria-selected="true"], h1, h2, [role="heading"]'
    : 'h1, h2, [role="heading"]'
  const target = [...section.querySelectorAll<HTMLElement>(selectors)]
    .find(element => element.closest('[hidden], [inert], [aria-hidden="true"]') === null) ?? section
  if (!target.hasAttribute('tabindex') && !target.isContentEditable) target.tabIndex = -1
  target.focus({ preventScroll: true })
}

const MENU_TABS = ['apps', 'system', 'yours'] as const
const MENU_SLOTS = {
  apps: 'shell.menu.apps',
  system: 'shell.menu.system',
  yours: 'shell.menu.yours',
} as const

/**
 * Identify the single visible lane of a focused preset.
 * @param preset - current pane preset.
 * @returns the focused lane, or undefined for multi-lane presets.
 */
function focusedLane(preset: PanePreset): Lane | undefined {
  if (preset === 'left-focus') return 'left'
  if (preset === 'center-focus') return 'center'
  if (preset === 'right-focus') return 'right'
  return undefined
}

/** Inner measure used while one lane owns the complete frame rail. */
function singleMeasure(preset: PanePreset): 'two-thirds' | undefined {
  if (preset.endsWith('-focus')) return 'two-thirds'
  return undefined
}

/**
 * THE ACTIVATION MARK'S SEAT. It renders nothing; it exists for where it sits. React runs an
 * element's layout effects before those of the siblings after it, and a parent's after all of its children's, so the
 * frame's own effects run after the details seat has already reported for a session it just made current. This sits
 * ahead of the seat, so the frame marks the activation before the seat says anything about the new session.
 * @param props.session - the session the frame shows; `mark` runs whenever it changes.
 * @param props.mark - the frame's mark, which decides whether the change is a switch.
 * @returns nothing.
 */
function ActivationMark({ session, mark }: { session: SessionId | undefined; mark: (session: SessionId | undefined) => void }): null {
  useLayoutEffect(() => { mark(session) }, [mark, session])
  return null
}

/** One accessible pane-cycle control positioned on a lane corner. */
function CornerControl(props: {
  corner: 'conversation-close' | 'left' | 'center-left' | 'center-right' | 'right' | 'compact-next' | 'compact-previous'
  label: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      className={css.cornerControl}
      data-corner={props.corner}
      aria-label={props.label}
      onClick={props.onClick}
    />
  )
}

/** Compact geometric mark for one right-menu category. */
function MenuTabIcon({ tab }: { tab: MenuTab }) {
  return (
    <svg className={css.menuTabIcon} viewBox="0 0 16 16" aria-hidden="true">
      {tab === 'apps' && <path d="M8 2.25 13.5 13H2.5L8 2.25Z" />}
      {tab === 'system' && <rect x="3" y="3" width="10" height="10" rx="1.5" />}
      {tab === 'yours' && <circle cx="8" cy="8" r="5.25" />}
    </svg>
  )
}

/** Rounded lane wrapper shared by threads, center, and right-side content. */
function LaneShell(props: {
  lane: Lane
  label: string
  active: boolean
  /** Compact only: the lane can take focus itself, for when it has nothing better to focus. */
  focusable?: boolean
  controls: ReactNode
  children: ReactNode
}) {
  const laneClass = props.lane === 'left'
    ? css.laneLeft
    : props.lane === 'center' ? `${css.laneCenter} ${css.centerCol}` : css.laneRight
  return (
    <section
      className={`${css.lane} ${laneClass}`}
      data-lane={props.lane}
      data-pane-active={props.active || undefined}
      aria-label={props.label}
      aria-hidden={!props.active || undefined}
      tabIndex={props.focusable === true ? -1 : undefined}
      ref={(element) => { element?.toggleAttribute('inert', !props.active) }}
    >
      <div className={css.laneShell}>
        {props.controls}
        <div className={css.laneBody}>{props.children}</div>
      </div>
    </section>
  )
}

/**
 * Convert the left track weight into the pixel owner value expected by the
 * existing sidebar occupant. Single-pane modes follow their centered measure.
 * @param frameWidth - measured spatial-frame width.
 * @param leftWeight - left track's fractional weight.
 * @param measure - centered measure when the left lane owns the frame.
 * @returns rendered sidebar content width in pixels.
 */
function laneWidth(
  frameWidth: number,
  weight: number,
  measure: 'two-thirds' | undefined,
): number {
  if (weight === 0) return 0
  if (measure === 'two-thirds') return Math.round(frameWidth * 2 / 3)
  const available = Math.max(0, frameWidth - FRAME_FIXED_INLINE_SPACE)
  return Math.round(available * weight / 3)
}

/** Three-lane application frame. */
/** An invite link opens Identity once per page load, however often the frame mounts. */
let inviteLinkOpened = false

export function AppFrame({
  useStore,
  useSessions,
  actions,
  renderSlot,
  t,
  openThread,
  newThread,
  setPinned,
  setArchived,
  renameThread,
  homeReader,
  ...runtime
}: AppFrameProps) {
  const state = useStore(value => value)
  const currentSession = useSessions(sessions => mainViewSessionOf(sessions))
  // HER HOME, AS SOVEREIGNTY READS IT (Lane B3): the same reader, and the same Session (`sessionOf`, never a preview
  // fixture), so the chat card and Sovereignty read one copy of her staged files and agree on what waits.
  const homeSession = useSessions(sessionOf)
  const homeFiles = useSyncExternalStore(homeReader?.subscribe ?? NO_DOOR, homeReader?.current ?? NO_READER)
  // HER EYES WHERE THE HOST HAS NONE (Round 36): while this page is open, her worker can ask it what it shows.
  useEffect(() => installPageEyes(), [])
  // AN INVITE LINK OPENS ON THE INVITE: a guest who opens `…/#invite=<receipt>` lands on Identity, where the Redeem card
  // reads the fragment (a fragment is never sent to a server). Once, at load; nothing is asked of any host for it.
  useEffect(() => {
    if (inviteLinkOpened) return
    inviteLinkOpened = true
    let invited = false
    try { invited = globalThis.location.hash.startsWith('#invite=') } catch { invited = false }
    if (invited) actions.selectSurface('identity', undefined, 'contained')
  }, [actions])
  // THE NAME OF THE THREAD THE CORNER NAMES, LIVE: `displayTitle` is the session's human-facing label (durable
  // title, project basename, then id), so a thread the host has not titled yet is still named rather than blank.
  const currentThreadTitle = useSessions((sessions) => {
    const current = mainViewSessionOf(sessions)
    return current === undefined ? undefined : sessions.byId[current]?.displayTitle
  })
  // HOW MANY LANES ARE RUNNING, from the live session store — the same fact the board reads, counted here by the
  // rule `lanesRunningOf` documents. `null` when the store cannot answer, which the strip shows as unknown.
  const lanesRunning = useSessions(sessions => lanesRunningOf(sessions))
  // THE HOST'S ANSWER FOR THE FACTS ONLY IT KNOWS (CORE, hands, today's spend against the cap), read from the
  // route the panel already asks for at mount. READ-ONLY: one GET, no body, nothing written anywhere. A failed
  // or refused read leaves `null`, which the strip renders as unknown — never as a zero.
  const aumaLiveOpen = state.activeSurface === AUMA_LIVE_SURFACE
  const [aumaAnswer, setAumaAnswer] = useState<unknown>(null)
  useEffect(() => {
    if (!aumaLiveOpen) return undefined
    let cancelled = false
    const read = (): void => {
      void fetch(AUMA_STATUS_PATH, { credentials: 'same-origin' })
        .then(response => (response.ok ? response.json() : null))
        .then((body) => { if (!cancelled) setAumaAnswer(body) })
        .catch(() => { if (!cancelled) setAumaAnswer(null) })
    }
    read()
    // REFRESHED WHILE THE PANEL IS OPEN: spend and the CORE session move during a session, and a strip that shows
    // what she could do an hour ago is the guess this exists to remove.
    const timer = setInterval(read, 30_000)
    return () => { cancelled = true; clearInterval(timer) }
  }, [aumaLiveOpen])
  // **WHO IS WAITING ON THE OWNER.** The minds route carries the per-lane approval log; this panel turns it into the
  // badge and its age with the same courted module the strip's facts use. A payload WITHOUT a `waiting` field means
  // the host could not read the lanes, and that renders as unknown — never as "nobody is waiting", which is the one
  // reading that would send a person back to sleep on a lane that has been stopped for sixteen hours.
  const [lanesAnswer, setLanesAnswer] = useState<unknown>(null)
  useEffect(() => {
    if (!aumaLiveOpen) return undefined
    let cancelled = false
    const read = (): void => {
      void fetch(AUMA_MINDS_PATH, { credentials: 'same-origin' })
        .then(response => (response.ok ? response.json() : null))
        .then((body) => { if (!cancelled) setLanesAnswer(body) })
        .catch(() => { if (!cancelled) setLanesAnswer(null) })
    }
    read()
    const timer = setInterval(read, 30_000)
    return () => { cancelled = true; clearInterval(timer) }
  }, [aumaLiveOpen])

  // WHETHER THE CURRENT SESSION IS BLANK: a blank session is what the page opens for itself, so the conversation
  // opener below does not treat a switch to one as a person choosing a thread.
  const currentBlank = useSessions((sessions) => {
    const current = mainViewSessionOf(sessions)
    return current === undefined ? undefined : sessions.byId[current]?.blank
  })
  const detailsSession = useSessions((sessions) => {
    const current = mainViewSessionOf(sessions)
    return current !== undefined && sessions.byId[current]?.blank === false ? current : undefined
  })
  const [menuTab, setMenuTab] = useState<MenuTab>('system')
  const frameRef = useRef<HTMLDivElement>(null)
  const [frameWidth, setFrameWidth] = useState(() => window.innerWidth)
  const menuId = useId()
  // THE COMPACT FRAME: which lane shows is the layout store's `compactLane`, kept apart from the
  // desktop preset. The viewport decides `compact`; the store is told before anything paints. Entering, the lane that
  // holds focus stays in front, else the desktop's focused lane, else the lane the compact frame showed last.
  const compactViewport = useSyncExternalStore(subscribeCompact, isCompactViewport, notCompact)
  useLayoutEffect(() => {
    if (compactViewport === state.compact) return
    if (compactViewport) actions.enterCompact(laneHoldingFocus(frameRef.current) ?? focusedLane(state.panePreset))
    else actions.leaveCompact()
  }, [actions, compactViewport, state.compact, state.panePreset])
  const compact = state.compact
  const visibleViewport = useVisibleViewport(compact, frameRef)

  useLayoutEffect(() => {
    const frame = frameRef.current
    if (frame === null) return
    const measureFrame = (): void => {
      const width = frame.getBoundingClientRect().width
      setFrameWidth(width > 0 ? width : window.innerWidth)
    }
    measureFrame()
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measureFrame)
      return () => { window.removeEventListener('resize', measureFrame) }
    }
    const observer = new ResizeObserver(measureFrame)
    observer.observe(frame)
    return () => { observer.disconnect() }
  }, [])

  const lastDetailsSession = useRef(detailsSession)
  // **A FRESH LOAD LANDS ON THE THREAD LIST.** This effect used to open the conversation whenever the current
  // session changed, and the first session a page sees is the load's — the persisted one restored, or the latest
  // workspace's blank session — so every app start opened the empty composer over the list with nobody touching
  // anything. The decision now lives in `conversation-opener.ts`, where a court drives it with the real load
  // sequence; a person's own selection opens the conversation explicitly, in the threads face.
  const [conversationOpener] = useState(() => new ConversationOpener())
  useLayoutEffect(() => {
    if (conversationOpener.observe({ session: currentSession, blank: currentBlank })) actions.openConversation()
  }, [actions, conversationOpener, currentSession, currentBlank])

  useLayoutEffect(() => {
    if (detailsSession === undefined) return
    if (lastDetailsSession.current !== undefined && lastDetailsSession.current !== detailsSession) {
      // The frame's own close, not the seat's report: the seat already said what it draws for the new session.
      actions.hideDetails()
    }
    lastDetailsSession.current = detailsSession
  }, [actions, detailsSession])

  // A SESSION SWITCH KEEPS THE LANES THE PERSON CHOSE, AND THE DETAILS THEY SAVED (independent
  // reviews). Opening a thread is not a gesture on its details: the seat's report for the session made current is an
  // activation report, whether it comes in the switch commit or after a fullscreen slide, and it moves no lane and no
  // preset (the store's `markActivation`); it does give the right lane the details face, so a late report's saved
  // details stay reachable. `ActivationMark`, ahead of the seat, marks it before the seat reports.
  // A switch is a change of the session after the first one this frame drew.
  const markedSession = useRef(currentSession)
  const switching = markedSession.current !== currentSession
  const markActivation = useCallback((session: SessionId | undefined): void => {
    if (markedSession.current === session) return
    markedSession.current = session
    actions.markActivation(session)
  }, [actions])

  const weights = PANE_WEIGHTS[state.panePreset]
  const focused = focusedLane(state.panePreset)
  const measure = singleMeasure(state.panePreset)
  // Compact, the right lane has the whole frame when it is in front; it stays mounted while hidden, so its width is the
  // width it will have, and the details seat is not told it cannot show because another lane is in front.
  const rightWidth = compact
    ? Math.max(0, Math.round(frameWidth))
    : laneWidth(frameWidth, weights[2], focused === 'right' ? measure : undefined)
  const owner: SurfaceOwnerProps & MenuItemOwnerProps = {
    ...(state.activeSurface === undefined ? {} : { activeSurface: state.activeSurface }),
    ...(state.surfaceTarget === undefined ? {} : { surfaceTarget: state.surfaceTarget }),
    openSurface: actions.selectSurface,
    closeSurface: actions.closeSurface,
  }
  // THE MENU REVEALS, IT NEVER EMPTIES (spec section 6): compact, choosing the app that is already open closes nothing;
  // it shows that app. Only the menu's door changes; an app's own close (Escape) still closes it.
  const menuOwner: SurfaceOwnerProps & MenuItemOwnerProps = compact
    ? { ...owner, closeSurface: () => { actions.showCompactLane('center') } }
    : owner
  const showDetails = state.detailsOpen && detailsSession !== undefined
  /** Whether the session the frame shows is activating: switched to in this render, or marked and not yet settled. */
  const activating = currentSession !== undefined && (switching || state.activationPending === currentSession)
  /** Whether a lane is in front: compact, the one lane shown; wide, every lane its preset gives a third. */
  const laneActive = (lane: Lane, weight: number): boolean => (compact ? state.compactLane === lane : weight !== 0)
  const laneLabel = (lane: Lane): string => t(LANE_LABEL_KEYS[lane])

  // FOCUS FOLLOWS THE LANE (spec section 7). Compact, a lane brought to the front takes focus at a meaningful target
  // when the focus was the frame's (or nobody's): the lane it was in is now inert. Leaving compact, focus left behind
  // in a lane the desktop preset hides, or on a compact-only corner that is gone, moves to the widest lane.
  const focusWithin = useRef(false)
  const shown = useRef<{ compact: boolean; lane: Lane } | undefined>(undefined)
  useLayoutEffect(() => {
    const before = shown.current
    shown.current = { compact, lane: state.compactLane }
    const frame = frameRef.current
    if (before === undefined || frame === null) return
    const holder = document.activeElement
    const frameHadFocus = holder === null || holder === document.body || frame.contains(holder)
    if (holder?.closest('[data-shell-overlay]') != null) return
    if (compact && before.compact && before.lane !== state.compactLane) {
      if (frameHadFocus && laneHoldingFocus(frame) !== state.compactLane) focusLane(frame, state.compactLane)
      return
    }
    if (!compact && before.compact && focusWithin.current) {
      // A FOREGROUND ELEMENT OUTSIDE THE FRAME KEEPS THE FOCUS (review of the compact frame, MUST 3). A modal portals to
      // the body, yet its focus events bubble through React to this frame, so `focusWithin` holds while a dialog that
      // is still open has the focus. Only focus the frame really lost (a compact corner removed, which leaves the
      // body focused) or left in a lane the desktop hides is moved.
      if (holder !== null && holder !== document.body && holder.isConnected && !frame.contains(holder)) return
      const lane = laneHoldingFocus(frame)
      if (lane !== undefined && weights[LANES.indexOf(lane)] !== 0) return
      focusLane(frame, LANES[weights.indexOf(Math.max(...weights))] ?? 'center')
    }
  }, [compact, state.compactLane, weights])
  const activePanelId = panelIdOfSurface(state.activeSurface)
  // THE RELOAD NOTICE, WHICHEVER APP IS OPEN: "a newer Auma is published" or
  // "a new build is live" (portal/build-notice.ts). NOTHING FLOATS: the frame draws no notice of its
  // own; it feeds the page's notices (portal/notices.ts), which the gold Notices launcher, first in the system menu,
  // counts and its surface lists. Work and Aura read and show it themselves, through their own header button, while they
  // are the open app, and publish what they find into the same list; then the frame does not read for it, so it is never
  // read twice (a notice it already found stays). Nor does it read while Notices itself is open: opening Notices sends
  // no request; the list shows what was already found.
  const surfaceReadsNotice = state.activeSurface === WORK_SURFACE || state.activeSurface === AURA_SURFACE
    || state.activeSurface === NOTICES_SURFACE
  useNoticeFeed(!surfaceReadsNotice)
  const activeMenuSlot = MENU_SLOTS[menuTab]
  // EVERY FACT, EACH ONE MARKED KNOWN OR UNKNOWN. The strip never substitutes a number for a lookup that failed.
  const waitingLanes = waitingLanesOf(lanesAnswer, Date.now())
  // THE HOST SENDS THE SESSION ID AND THE PAGE KNOWS THE NAME. A row labelled `sess-9f3c…` is a row nobody can read,
  // so the label comes from the session store the frame already subscribes to, falling back to whatever the payload
  // called the lane when the store has not seen that thread.
  const laneTitles = useSessions(sessions => sessions.byId)
  const aumaStatus = aumaStatusOf({
    sessionId: currentSession, title: currentThreadTitle, lanesRunning, answer: aumaAnswer as never,
  })

  const chooseMenuTab = (tab: MenuTab, focus = false, tabList?: HTMLElement | null): void => {
    setMenuTab(tab)
    if (!focus) return
    const index = MENU_TABS.indexOf(tab)
    tabList?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[index]?.focus()
  }

  const onTabKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, index: number): void => {
    let next: number | undefined
    if (event.key === 'ArrowRight') next = (index + 1) % MENU_TABS.length
    else if (event.key === 'ArrowLeft') next = (index - 1 + MENU_TABS.length) % MENU_TABS.length
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = MENU_TABS.length - 1
    if (next === undefined) return
    const tab = MENU_TABS[next]
    if (tab === undefined) return
    event.preventDefault()
    chooseMenuTab(tab, true, event.currentTarget.parentElement)
  }

  return (
    <div
      ref={frameRef}
      className={css.frame}
      data-pane-preset={compact ? undefined : state.panePreset}
      data-focused-lane={compact ? undefined : focused}
      data-single-measure={compact ? undefined : measure}
      data-compact-lane={compact ? state.compactLane : undefined}
      data-compact-viewport={visibleViewport === null ? undefined : ''}
      style={visibleViewport === null ? undefined : ({
        '--dsh-compact-visible-height': `${visibleViewport.height}px`,
        '--dsh-compact-visible-top': `${visibleViewport.top}px`,
      } as CSSProperties)}
      onFocus={() => { focusWithin.current = true }}
      onBlur={(event) => {
        const next = event.relatedTarget
        if (!(next instanceof Node) || !event.currentTarget.contains(next)) focusWithin.current = false
      }}
      data-surface-presentation={state.surfacePresentation ?? 'contained'}
      data-conversation-open={state.conversationOpen || undefined}
      data-details-open={showDetails || undefined}
      data-details-collapsed={!showDetails || undefined}
      data-sidebar-collapsed={weights[0] === 0 || undefined}
    >
      <LaneShell
        lane="left"
        label={t('lane.threads')}
        active={laneActive('left', weights[0])}
        focusable={compact}
        controls={(
          <>
            {state.conversationOpen && (
              <CornerControl
                corner="conversation-close"
                label={t('thread.close')}
                onClick={actions.closeConversation}
              />
            )}
            {/* COMPACT, THE OUTER CYCLE CONTINUES: the thread list's upper left shows the menu, as the menu's upper
                right shows this lane. An open conversation's upper left is its way back to the list instead. */}
            {compact && !state.conversationOpen && (
              <CornerControl
                corner="compact-previous"
                label={laneLabel('right')}
                onClick={() => { actions.showCompactLane('right') }}
              />
            )}
            <CornerControl
              corner="left"
              label={compact ? laneLabel('center') : t('corner.left')}
              onClick={actions.cycleLeft}
            />
          </>
        )}
      >
        <div className={css.threadStack} data-thread-view={state.conversationOpen ? 'conversation' : 'list'} style={{ position: 'relative' }}>
          {/* FINGERPRINT WAITING (Lanes B2, B3): over the chat, whatever thread is open, while HEAD or her staged files hold
              something for the passkey. */}
          <FingerprintWaiting openSovereignty={() => { actions.selectSurface('sovereignty', undefined, 'contained') }}
            reader={homeFiles ?? undefined} sessionId={homeSession} />
          <div className={css.threadLayer} data-thread-layer="list" hidden={state.conversationOpen}>
            {/* THE PREDECESSOR'S THREADS LANE (x5/threads.tsx), on the live DSH sessions, in place of the stock sidebar. */}
            <ThreadsLane
              useSessions={useSessions}
              useSessionStatus={runtime.useSessionStatus}
              useWorkspaces={(runtime as unknown as { useWorkspaces?: ThreadsLaneProps['useWorkspaces'] }).useWorkspaces}
              currentSession={currentSession}
              openThread={(sessionId) => { openThread?.(sessionId) }}
              openConversation={actions.openConversation}
              newThread={newThread}
              setPinned={setPinned}
              setArchived={setArchived}
              renameThread={renameThread}
            />
          </div>
          <div className={css.threadLayer} data-thread-layer="conversation" hidden={!state.conversationOpen}>
            {/* ONE LINE AT THE TOP OF AN OPEN THREAD (Round 23, the owner): the conversation's own header carries the title
                (renamed in place), its mode and its subagents (see thread-chrome.ts). The frame adds no bar of its own:
                the lane's corner arrow goes back to Threads, and New chat is on the Threads lane. */}
            <div className={css.threadConversationBody}>
              {renderSlot('main', {}, { entryKey: 'conversation' })}
            </div>
          </div>
        </div>
      </LaneShell>

      <LaneShell
        lane="center"
        label={t('lane.surface')}
        active={laneActive('center', weights[1])}
        focusable={compact}
        controls={(
          <>
            <CornerControl
              corner="center-left"
              label={compact ? laneLabel('left') : t('corner.centerLeft')}
              onClick={actions.cycleCenterLeft}
            />
            <CornerControl
              corner="center-right"
              label={compact ? laneLabel('right') : t('corner.centerRight')}
              onClick={actions.cycleCenterRight}
            />
          </>
        )}
      >
        {/* ── WHAT SHE CAN DO RIGHT NOW ─────────────────────────────────────────────────────────────
            A read-only strip for the Auma Live panel: her thread, the lanes running, whether the CORE session
            exists, whether the subscription hands resolve, and today's spend against the cap. Every value is a
            host fact, and a fact the host did not answer is rendered as UNKNOWN rather than as a zero — a green
            0 would say she is idle and broke when the truth is that nobody asked. The strip writes nothing. */}
        {state.activeSurface === AUMA_LIVE_SURFACE ? (
          <p className={css.aumaStatus} data-auma-status={aumaStatus.anyUnknown ? 'unknown' : 'known'}>
            {([
              ['thread', t('status.thread'), aumaStatus.thread],
              ['lanes', t('status.lanes'), aumaStatus.lanes],
              ['waiting', t('status.waiting'), aumaStatus.waiting],
              ['core', t('status.core'), aumaStatus.core],
              ['hands', t('status.hands'), aumaStatus.hands],
              ['spend', t('status.spend'), aumaStatus.spend],
              ['wake', t('status.wake'), aumaStatus.wake],
            ] as const).map(([id, label, fact]) => (
              <span
                key={id}
                className={fact.known ? css.aumaStatusKnown : css.aumaStatusUnknown}
                data-auma-status-item={id}
                data-known={fact.known}
              >
                {label}: {fact.text}
              </span>
            ))}
          </p>
        ) : null}
        {/* ── EACH LANE THAT NEEDS HIM, WITH HOW LONG IT HAS BEEN WAITING ─────────────────────────────
            A lane that is waiting looks idle from the outside, which is how AK-UI sat sixteen hours on four
            unanswered approvals. Every lane the host reported gets a row: one that is waiting gets a badge with
            the age of its OLDEST open approval and opens that thread when clicked, one with nothing open says so,
            and a lane whose log could not be read says unknown — the three are never spelled the same way. */}
        {state.activeSurface === AUMA_LIVE_SURFACE ? (
          <div className={css.aumaWaiting} data-auma-waiting={waitingLanes === null ? 'unknown' : 'known'}>
            <span className={css.aumaWaitingTitle}>{t('waiting.title')}</span>
            {waitingLanes === null ? (
              <span className={css.aumaStatusUnknown} data-auma-waiting-item="unread">
                {t('waiting.unread')}
              </span>
            ) : waitingLanes.map(row => (
              <span
                key={row.lane}
                className={row.fact.text === 'none' ? css.aumaWaitingClear : css.aumaWaitingBadge}
                data-auma-waiting-item={row.lane}
                data-waiting={row.fact.known ? (row.fact.text === 'none' ? 'clear' : 'waiting') : 'unknown'}
                data-session={row.sessionId}
              >
                {row.fact.known
                  ? (row.fact.text === 'none'
                    ? `${laneTitles[row.sessionId as SessionId]?.displayTitle ?? row.lane}: ${t('waiting.clear')}`
                    : (
                      <button
                        type="button"
                        className={css.aumaWaitingOpen}
                        onClick={() => { openThread?.(row.sessionId as SessionId) }}
                      >
                        {`${laneTitles[row.sessionId as SessionId]?.displayTitle ?? row.lane}: ${t('waiting.badge')} ${row.fact.oldestMs === null ? '' : waitingAgeText(row.fact.oldestMs)}`.trim()}
                      </button>
                    ))
                  : `${laneTitles[row.sessionId as SessionId]?.displayTitle ?? row.lane}: ${t('waiting.unknown')}`}
              </span>
            ))}
          </div>
        ) : null}
        <div className={css.surfaceStack} data-surface-active={state.activeSurface}>
          <div className={css.surfaceEmpty} data-surface-empty hidden={state.activeSurface !== undefined}>
            <span>{t('surface.empty')}</span>
          </div>
          <div className={css.surfaceLayer} data-surface-layer="extension">
            {renderSlot('shell.surface', owner)}
          </div>
          {/* A HARNESS PANEL (Plugins, Schedules, …) chosen from the stock sidebar rows or `pluginNavigation`, shown in
              the centre lane as a contained surface. Only the selected key renders; see `LayoutController.selectPanel`. */}
          {activePanelId === null ? null : (
            <div className={css.surfaceLayer} data-surface-layer="panel" data-panel-id={activePanelId}>
              {renderSlot('main', {}, { entryKey: activePanelId })}
            </div>
          )}
        </div>
      </LaneShell>

      <LaneShell
        lane="right"
        label={t('lane.menu')}
        active={laneActive('right', weights[2])}
        focusable={compact}
        controls={(
          <>
            <CornerControl
              corner="right"
              label={compact ? laneLabel('center') : t('corner.right')}
              onClick={actions.cycleRight}
            />
            {compact && (
              <CornerControl
                corner="compact-next"
                label={laneLabel('left')}
                onClick={() => { actions.showCompactLane('left') }}
              />
            )}
          </>
        )}
      >
        <div className={css.rightStack} data-menu-tab={menuTab}>
          <div className={css.rightLayer} data-right-layer="menu" hidden={showDetails}>
            <div className={css.menuHeader}>
              <span className={css.menuHeading} data-menu-heading>{t(`menu.${menuTab}`)}</span>
              <div className={css.menuTabs} role="tablist" aria-label={t('menu.tabs')}>
                {MENU_TABS.map((tab, index) => (
                  <button
                    key={tab}
                    id={`${menuId}-${tab}`}
                    type="button"
                    role="tab"
                    className={css.menuTab}
                    data-menu-tab={tab}
                    aria-selected={menuTab === tab}
                    aria-controls={`${menuId}-panel`}
                    tabIndex={menuTab === tab ? 0 : -1}
                    onClick={() => { chooseMenuTab(tab) }}
                    onKeyDown={(event) => { onTabKeyDown(event, index) }}
                  >
                    <MenuTabIcon tab={tab} />
                    <span className={css.visuallyHidden}>{t(`menu.${tab}`)}</span>
                  </button>
                ))}
              </div>
            </div>
            <div
              id={`${menuId}-panel`}
              className={css.menuPanel}
              role="tabpanel"
              aria-labelledby={`${menuId}-${menuTab}`}
            >
              {/* X6.1: the predecessor's "Auma Live is speaking through <thread>" line is not shown — x6.1 registers no Auma
                  Live app, so the line would claim a live binding that does not exist. */}
              {/* THE PREDECESSOR'S STACK: the x5 layer zeroes launcher margins and expects a 14px column gap from the parent. The slot's
                  own wrapper is `display: contents`, so the stack is this element, never the slot wrapper. */}
              <div className={css.menuStack} data-menu-stack={activeMenuSlot}>
                {renderSlot(activeMenuSlot, menuOwner, {
                  fallback: menuTab === 'yours'
                    ? <p className={css.menuEmpty}>{t('menu.yours.empty')}</p>
                    : null,
                })}
              </div>
            </div>
          </div>
          <div className={css.rightLayer} data-right-layer="details" hidden={!showDetails}>
            <ActivationMark session={currentSession} mark={markActivation} />
            {renderSlot('rightbar', {
              width: rightWidth,
              viewportWidth: frameWidth,
              // A GEOMETRY ANSWER, as the stock contract defines it: whether the details panel could show. The seat's own
              // expanded state then drives `openRightbar` → `openDetails`. Passing the open state here made the seat
              // veto every expand (it collapses itself while `canShow` is false).
              // WHILE A SESSION ACTIVATES the answer is yes whatever the thirds: the seat collapses itself while it is no, and
              // that collapse is saved with the thread, so a preset that hides this lane (left-wide, left-focus, ...) would
              // erase the expanded details the owner saved merely because the thread was opened. Its activation report
              // moves nothing (above); a person's gesture or a collapse settles the mark, and the geometry answers again.
              canShow: detailsSession !== undefined && (rightWidth > 0 || activating),
            })}
          </div>
        </div>
      </LaneShell>

      <div className={css.overlayLayer} data-shell-overlay>
        {renderSlot('shell.overlay', {})}
      </div>
    </div>
  )
}
