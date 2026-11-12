/**
 * Cross-plugin navigation controller for the spatial shell. Viewing state
 * remains in the root entry store; the controller forwards feature gestures
 * into that store's declared actions.
 */
import type { BoundActions, HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { createLayoutStore, SurfacePresentation } from './stores.ts'

/** Identity shared by a sidebar panel entry and its main-slot occupant. */
export type MainPanelId = Branded<'MainPanelId'>

/**
 * Root-scoped navigation state every entry can read as `usePanelInfo`.
 *
 * The shape is the harness's, member for member: upstream declares the same
 * standard prop, and any program that sees both declarations requires them to
 * be identical. This shell has one panel — the Conversation — so the value is
 * permanently null, which is exactly what upstream occupants test for before
 * rendering Session-bound content.
 */
export interface PanelInfo {
  /** Selected global panel; null displays the current Conversation. */
  readonly activePanelId: MainPanelId | null
}

/** Centre-surface id prefix under which a harness `main` panel is shown in this shell. */
export const PANEL_SURFACE_PREFIX = 'panel:'

/**
 * The harness main-panel id a centre surface shows, or null when the surface is not a panel.
 * @param surface - the selected centre surface id.
 */
export function panelIdOfSurface(surface: string | undefined): string | null {
  return surface !== undefined && surface.startsWith(PANEL_SURFACE_PREFIX) ? surface.slice(PANEL_SURFACE_PREFIX.length) : null
}

/** Root layout store's framework-bound action set. */
export type PanelActions = BoundActions<ReturnType<typeof createLayoutStore>>

/** Cross-plugin layout actions available as `ctx.layout`. */
export interface ILayout {
  /**
   * The selected central panel as an observable source. DSH 0.2.1-alpha.5's `ILayout` carries it, and the right
   * Sidebar reads it (`layout.panelInfo`) to decide whether Session details may show; this shell has one panel, so
   * it is permanently the Conversation.
   */
  readonly panelInfo: HostObservable<PanelInfo>
  /** Select a center surface, an optional target, and its focused-canvas behavior. */
  openSurface(id: string, target?: string, presentation?: SurfacePresentation): void
  /** Return the center lane to its empty app canvas. */
  closeSurface(): void
  /**
   * Replace the left thread browser with the resident Conversation.
   *
   * A PERSON'S SELECTION CALLS THIS, EXPLICITLY. A selection change alone does not open the conversation: the
   * frame leaves the page's own load-time selection on the thread list (`conversation-opener.ts`), and choosing
   * the thread that is already current changes no selection at all. So a gesture that means "show me this
   * thread" says so here — `UiWorkspaceService` in the threads face does, for every thread gesture it owns.
   */
  openConversation(): void
  /** Return the left lane to its thread browser. */
  closeConversation(): void
  /**
   * Begin a navigation, cancelling any still in flight, and return its signal.
   *
   * The thread browser opens a session by awaiting host work and then applying the
   * result, so it needs a way to abandon a slower earlier click. This frame has no
   * panel model of its own, but the ability to cancel is not about panels: without
   * it the browser's own await never resolves and the click does nothing.
   */
  beginNavigation(): AbortSignal
  /**
   * Record the harness's main-panel selection. OPENS NOTHING.
   *
   * This frame declares the harness's keyed `main` slot but keeps exactly one key in
   * it — `conversation`, in the left lane — because the centre lane holds application
   * surfaces rather than panels. Upstream, `null` means "show the conversation"; here it
   * only names the one panel there is, and it does not open the conversation over the
   * thread list, because a caller passes it as bookkeeping and not as a person's choice.
   * A selection that should show the conversation calls {@link ILayout.openConversation}.
   * Any other id has no seat in this shell and is accepted and ignored rather than
   * throwing into a caller that cannot know which frame it is talking to.
   */
  selectPanel(panelId: string | null): void
  /** Toggle the thread lane between visible and hidden presets. */
  toggleSidebar(): void
  /** Show details for the current real Session and return to balanced panes. */
  openDetails(): void
  /** Return the right lane to its navigation menu. */
  closeDetails(): void
  /**
   * Show the right column, in the harness's own words.
   *
   * The right Sidebar asks for its panel through this name and no other. Its
   * two arguments describe an upstream geometry this frame does not have — the
   * right lane is one of three fixed lanes, never a track carved out of the
   * centre, and never a fullscreen cover — so they are accepted and ignored
   * rather than pretended to. What the caller actually wants is the panel
   * shown, and that it gets.
   * @param track - upstream column-reservation request; this frame reserves nothing.
   * @param fullscreen - upstream viewport-cover request; this frame covers nothing.
   */
  openRightbar(track: boolean, fullscreen: boolean): void
  /** Hide the right column, in the harness's own words. */
  closeRightbar(): void
}

/** `ctx.layout` controller backed by the mounted root entry's store actions. */
export class LayoutController implements ILayout {
  #panels: PanelActions | undefined

  readonly #hasMainPanel: ((id: string) => boolean) | undefined
  #activeSurface: (() => string | undefined) | undefined

  /**
   * @param panelInfo - the shell's central-panel source, derived from the selected centre surface.
   * @param hasMainPanel - checks the live `main` slot registry for a panel id.
   */
  constructor(readonly panelInfo: HostObservable<PanelInfo>, hasMainPanel?: (id: string) => boolean) {
    this.#hasMainPanel = hasMainPanel
  }

  /** Pending navigation, aborted when a later one begins or the owner unloads. */
  #navigation = new AbortController()

  /**
   * Begin a navigation and cancel any earlier one.
   * @returns the signal for this navigation.
   */
  beginNavigation(): AbortSignal {
    this.#navigation.abort()
    this.#navigation = new AbortController()
    return this.#navigation.signal
  }

  /**
   * Select a harness main panel, or show the conversation.
   *
   * X6.1 COMPOSITION, MEASURED: the stock sidebar's panel rows (Plugins, Schedules) and `pluginNavigation` call this
   * with a registered `main` key, and the stock threads face calls it with `null` on a person's "reveal" gestures
   * (choosing a thread, New Session). So a registered id opens that panel in the centre lane as a contained surface
   * (`panel:<id>`), and `null` closes such a panel and opens the resident conversation. An id with no registered
   * `main` entry is ignored, as the stock controller would refuse it.
   * @param panelId - registered main-panel id, or null for the conversation.
   */
  selectPanel(panelId: string | null): void {
    const panels = this.#panels
    if (panels === undefined) return
    if (panelId === null) {
      if (panelIdOfSurface(this.#activeSurface?.()) !== null) panels.closeSurface()
      panels.openConversation()
      return
    }
    if (this.#hasMainPanel !== undefined && !this.#hasMainPanel(panelId)) return
    panels.selectSurface(PANEL_SURFACE_PREFIX + panelId, undefined, 'contained')
  }

  /** Invalidate a pending navigation when the layout owner is unloaded. */
  dispose(): void {
    this.#navigation.abort()
  }

  /**
   * Attach the root entry's current action set. A replacement registration
   * overwrites actions captured from the prior entry instance.
   * @param actions - bound actions of the root spatial-layout store.
   */
  attachPanels(actions: PanelActions, activeSurface?: () => string | undefined): void {
    this.#panels = actions
    if (activeSurface !== undefined) this.#activeSurface = activeSurface
  }

  /** Select a center surface, an optional target, and its focused-canvas behavior. */
  openSurface(id: string, target?: string, presentation?: SurfacePresentation): void {
    if (presentation === undefined) this.#require().selectSurface(id, target)
    else this.#require().selectSurface(id, target, presentation)
  }

  /** Return the center lane to its empty app canvas. */
  closeSurface(): void {
    this.#require().closeSurface()
  }

  /** Replace the left thread browser with the resident Conversation. */
  openConversation(): void {
    this.#require().openConversation()
  }

  /** Return the left lane to its thread browser. */
  closeConversation(): void {
    this.#require().closeConversation()
  }

  /** Toggle the thread lane between visible and hidden presets. */
  toggleSidebar(): void {
    this.#require().toggleSidebar()
  }

  /** Show details for the current real Session and return to balanced panes. */
  openDetails(): void {
    this.#require().openDetails()
  }

  /** Return the right lane to its navigation menu. */
  closeDetails(): void {
    this.#require().closeDetails()
  }

  /**
   * Show the right column for the right Sidebar.
   * @param _track - upstream column reservation; this frame's lanes are fixed.
   * @param _fullscreen - upstream viewport cover; this frame has no such mode.
   */
  openRightbar(_track: boolean, _fullscreen: boolean): void {
    this.openDetails()
  }

  /** Hide the right column for the right Sidebar. */
  closeRightbar(): void {
    this.closeDetails()
  }

  /** @returns the attached store actions, or throws when root assembly has not completed. */
  #require(): PanelActions {
    if (this.#panels === undefined) throw new Error('layout: actions not wired (root entry not mounted)')
    return this.#panels
  }
}
