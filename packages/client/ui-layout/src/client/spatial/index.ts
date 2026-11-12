/**
 * The predecessor's Spatial root shell, mounted natively as ui-layout's default root occupant.
 *
 * Source: an earlier native port, itself adapted from the predecessor layout (both live in earlier
 * repositories). One React root, the
 * stock Session/conversation occupants, no iframe and no second agent loop.
 *
 * The stock three-column frame stays reachable with `?layout=stock`; ui-layout's
 * `apply` chooses exactly one of the two, so only one root occupant ever registers.
 *
 * The stock package already declares `ctx.layout`, `usePanelInfo` and the shared
 * slots (`sidebar`, `main`, `rightbar`, `shell.overlay`). This module adds only the
 * slots the stock frame does not have, so one program sees one declaration of each.
 */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { MainPanelId, PanelInfo } from './service.ts'
import type { MenuItemOwnerProps, SurfaceOwnerProps } from './types.ts'
import { AppFrame } from './AppFrame.tsx'
import { AUMA_ROOT_PATH, newThreadTarget } from './meta-workspace.ts'
import { en, NS, zh, type LayoutKey } from './locales.ts'
import { LayoutController, panelIdOfSurface } from './service.ts'
import { createLayoutStore } from './stores.ts'
import { ThemePresenter } from './theme-presenter.ts'
import { installPortal } from './portal/index.ts'
import { createWorkReaderDoor, installWorkSurface } from './work/index.ts'
import { installSpatialChrome } from './thread-chrome.ts'
import './spatial-tokens.css'
// The predecessor's primitives stylesheets (primitives, face skin, tab colours, harness skin): the Spatial look on every surface.
import './primitives/index.ts'

export type { ILayout as ISpatialLayout } from './service.ts'
export type { MenuItemOwnerProps, SurfaceOwnerProps } from './types.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Spatial-shell lane, menu-tab, and pane-control copy. */
    layout: LayoutKey
  }

  interface SlotMap {
    /**
     * Additive center-lane application surfaces. Entries receive the selected
     * id, optional feature target, and navigation callbacks whose presentation
     * argument chooses a contained or full-bleed focused canvas. Each entry
     * keeps its own tree mounted and hides when inactive. Spatial root only.
     */
    'shell.surface': { kind: 'list'; scope: 'root'; owner: SurfaceOwnerProps }
    /** Bundled Aukora application entries in the triangle tab. Spatial root only. */
    'shell.menu.apps': { kind: 'list'; scope: 'root'; owner: MenuItemOwnerProps }
    /** System and settings entries in the square tab. Spatial root only. */
    'shell.menu.system': { kind: 'list'; scope: 'root'; owner: MenuItemOwnerProps }
    /** User-created application entries in the circle tab. Spatial root only. */
    'shell.menu.yours': { kind: 'list'; scope: 'root'; owner: MenuItemOwnerProps }
  }
}

/** The one panel this shell has: never a keyed global panel, always the Conversation. */
const CONVERSATION_PANEL: PanelInfo = Object.freeze({ activePanelId: null })

/** Services the Spatial root needs beyond the stock frame's. */
export const SPATIAL_INJECT = ['slots', 'theme', 'locale', 'sessions'] as const

/** True unless the page asked for the stock harness frame with `?layout=stock`. */
export function spatialRequested(): boolean {
  try {
    return new URL(globalThis.location?.href || 'http://local/').searchParams.get('layout') !== 'stock'
  } catch {
    return true
  }
}

/**
 * Register the Spatial root shell, its `ctx.layout` controller, the Work surface and the theme presenter.
 * @param ctx - client root context.
 */
export function applySpatial(ctx: ClientContext): void {
  // X6's composer Chat | Build toggle is not installed: it drives an `/aukora-mode` command x6.1 does not have,
  // and a control that cannot take effect would only misreport the mode. The stock composer stays as it is.
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-layout: spatial dictionaries')

  // ONE STORE INSTANCE, SHARED by the root entry and `panelInfo`, so upstream occupants (the right Sidebar among
  // them) see a harness panel selected exactly while one is shown in the centre lane, and the Conversation otherwise.
  const handle = createLayoutStore()
  const instance = handle.create()
  const store: typeof handle = { ...handle, create: () => instance }
  let lastPanel: PanelInfo = CONVERSATION_PANEL
  const panelInfo: HostObservable<PanelInfo> = {
    getSnapshot: () => {
      const id = panelIdOfSurface(instance.getSnapshot().activeSurface)
      if (id === null) return CONVERSATION_PANEL
      if (lastPanel.activePanelId !== id) lastPanel = Object.freeze({ activePanelId: id as MainPanelId })
      return lastPanel
    },
    subscribe: listener => instance.subscribe(listener),
  }
  const layout = new LayoutController(panelInfo, id =>
    ctx.slots.entries('main').some(entry => entry.options.key === id))
  layout.attachPanels(instance.actions, () => instance.getSnapshot().activeSurface)

  // THE PAGE'S READER OF HER FILES, FOR THE CHAT LANE (Lane B3): the Fingerprint card reads her staged Pearl and her staged
  // outward request through the same reader as Sovereignty, once the files service is there.
  const homeReader = createWorkReaderDoor()
  installWorkSurface(ctx, homeReader)
  // The approval pill opens Sovereignty the way its launcher does (a contained centre surface).
  installPortal(ctx, (id) => { layout.openSurface(id, undefined, 'contained') })

  // THE HOST'S OWN RENAME (Round 23), the call the classic sidebar makes (ui-workspace `sessions.using(...).rename`): the
  // durable title lives in the session's event log, so the Threads card and the open thread's header both read it from
  // the one session store, and it survives a reload. `using` opens the session's history, as the classic rename does.
  const renameThread = async (sessionId: SessionId, title: string): Promise<string> => {
    type Renamed =
      | { readonly ok: true; readonly value: { readonly title: string } }
      | { readonly ok: false; readonly error: { readonly message: string } }
    type RenameReference = { readonly binding: { readonly session: { rename(title: string): Promise<Renamed> } } }
    type Renamer = {
      using<T>(target: SessionId, options: { readonly source: string }, op: (reference: RenameReference) => T | Promise<T>): Promise<T>
    }
    const sessions = ctx.get('sessions') as unknown as Renamer | undefined
    if (sessions === undefined) throw new Error('the sessions service is not loaded')
    const result = await sessions.using(sessionId, { source: 'workspaceOperation' }, reference => reference.binding.session.rename(title))
    if (!result.ok) throw new Error(result.error.message)
    return result.value.title
  }
  ctx.effect(() => installSpatialChrome((sessionId, title) => renameThread(sessionId as SessionId, title)),
    'ui-layout: spatial thread chrome (one-line header, host rename)')

  ctx.effect(() => {
    const disposePanelInfo = ctx.slots.provideRoot({ hooks: { panelInfo } })
    // The Spatial controller is a superset of the stock `ILayout` every other plugin calls
    // (selectPanel, beginNavigation, toggleSidebar, openRightbar, closeRightbar, panelInfo).
    const disposeService = ctx.reflect.provide('layout', layout)
    const disposeRegistration = ctx.slots.register({
      name: 'root',
      locale: NS,
      children: {
        'sidebar': { kind: 'single', scope: 'root' },
        'main': { kind: 'keyed', scope: 'root' },
        'rightbar': { kind: 'single', scope: 'root' },
        'shell.surface': { kind: 'list', scope: 'root' },
        'shell.menu.apps': { kind: 'list', scope: 'root' },
        'shell.menu.system': { kind: 'list', scope: 'root' },
        'shell.menu.yours': { kind: 'list', scope: 'root' },
        'shell.overlay': { kind: 'list', scope: 'root' },
      },
      store,
      inject: () => {
        // The same call the shipped sidebar makes, so a badge opens the thread exactly as clicking its row would.
        // ui-workspace depends on ui-layout, so its service type cannot be imported here without a cycle.
        type Nav = {
          openSession(id: SessionId): void
          startSession(workspaceId?: string): void
          pinSession(id: SessionId): Promise<void>
          unpinSession(id: SessionId): Promise<void>
          archiveSession(id: SessionId, options?: { readonly stopActivity?: boolean }): Promise<void>
          unarchiveSession(id: SessionId): Promise<void>
        }
        type WorkspacesService = {
          readonly list: { getSnapshot(): { readonly items: readonly { readonly workspaceId: string; readonly path?: string }[] } }
          initializeDefault(): Promise<{ readonly workspaceId: string } | undefined>
          create?(input: { path: string }): Promise<{ readonly workspaceId: string } | undefined>
        }
        const nav = (): Nav | undefined => ctx.get('uiWorkspace') as unknown as Nav | undefined
        const need = (): Nav => {
          const found = nav()
          if (found === undefined) throw new Error('workspace navigation (ui-workspace) is not loaded')
          return found
        }
        return {
          openThread: (sessionId: SessionId) => { nav()?.openSession(sessionId) },
          // The predecessor's threads lane: New chat, pin and archive are the stock sidebar's own calls (ui-workspace).
          newThread: () => {
            const n = nav()
            if (n === undefined) return
            const ws = ctx.get('workspaces') as unknown as WorkspacesService | undefined
            if (ws === undefined) { n.startSession(); return }
            // AUMA IS THE META-WORKSPACE (North Star §24.2): a new thread starts in her root workspace, `/dsh/home/auma`.
            // A browser that has none yet gets it as its first-use default; one that already has other workspaces (the
            // legacy `/dsh/home/auma-one`) gets it registered beside them, so no existing workspace or thread is touched.
            // If the host cannot register it, the thread starts where it always did.
            const start = newThreadTarget(ws.list.getSnapshot().items)
            if (start.kind === 'root') { n.startSession(start.workspaceId); return }
            const made = start.kind === 'first-use' || ws.create === undefined ? ws.initializeDefault() : ws.create({ path: AUMA_ROOT_PATH })
            void made.then(
              // The host may decline to make one (a default the owner deleted): the thread then starts where it always did.
              (created) => { n.startSession(created?.workspaceId) },
              () => { n.startSession() },
            )
          },
          setPinned: async (sessionId: SessionId, pinned: boolean) => {
            const n = need()
            await (pinned ? n.pinSession(sessionId) : n.unpinSession(sessionId))
          },
          setArchived: async (sessionId: SessionId, archived: boolean, stopActivity: boolean) => {
            const n = need()
            await (archived ? n.archiveSession(sessionId, { stopActivity }) : n.unarchiveSession(sessionId))
          },
          renameThread,
          homeReader,
        }
      },
    }, AppFrame)
    return () => {
      layout.dispose()
      disposeRegistration()
      disposePanelInfo()
      void disposeService()
    }
  }, 'ui-layout: spatial service + root registration')

  ctx.effect(() => {
    const presenter = new ThemePresenter()
    presenter.apply(ctx.theme.getTheme())
    const off = ctx.on('theme/change', (snapshot) => { presenter.apply(snapshot) })
    return () => {
      off()
      presenter.dispose()
    }
  }, 'ui-layout: spatial theme presenter')
}
