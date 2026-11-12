// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The Aukora authors
/**
 * THE DRIVE FIXTURE PAGE: the real "Media and Documents" surface (`MediaSurface`, its real Spatial primitives, tokens and
 * stylesheets) inside the REAL Spatial frame (`AppFrame` on the real layout store and `LayoutController`), over a made-up
 * her (`world.ts`). The frame decides its own layout exactly as in her app: at 1023px and below (`COMPACT_QUERY`) it
 * shows one lane at a time at full width, and opening an app brings the centre lane to the front. No worker, no sign-in,
 * no host call, no POST: every byte comes from memory, and the page refuses every network attempt (`refuseNetwork`; the
 * frame's own fingerprint card asks for HEAD, and is refused). It is NOT part of the app bundle (the production build's
 * inputs are `index.html` and `src/preview.ts` only, `apps/web/vite.config.ts`). The page is
 * `apps/web/drive-fixture.html`, served by `node apps/web/drive-fixture.serve.mjs`; it lives beside the drive's specs so
 * the client type-check covers it.
 *
 *   /            her drive, open in the centre lane
 *   /?chat=1     a made-up message from her in the left lane (the open conversation), with each link form and inline
 *                images; a link to a file in the drive's places opens the drive in the centre lane, and a link to her own
 *                working files elsewhere opens where it always did: the right sidebar, here a labelled stand-in
 *
 * Only the lane occupants the drive does not need are left empty: the menus (the right lane shows its header and tabs)
 * and the right sidebar's real document viewer (a labelled stand-in names the file it would open).
 *
 * @module drive-fixture/fixture
 */
import { useCallback, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-ui-renderer/src/client/bind.ts'
import { MarkdownDelegateProvider } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MarkdownFileMentions } from '@deepseek-ai/dsh-client-ui-primitives'
import { resolveWorkspacePath } from '@deepseek-ai/dsh-util-workspace-path'
import { en as commonEn } from '../../../locale/src/locales/en.ts'
import '../../../ui-theme/src/styles/base.css'
import '../../../ui-theme/src/styles/design-platform.css'
import '../../../ui-theme/src/styles/focus.css'
import '../../../ui-theme/src/styles/scrollbar.css'
import '../../src/client/spatial/spatial-tokens.css'
import '../../src/client/spatial/portal/spatial-layer.css'
import '../../src/client/spatial/portal/spatial-layer-fit.css'
import { AppFrame, type AppFrameProps } from '../../src/client/spatial/AppFrame.tsx'
import { en as frameEn } from '../../src/client/spatial/locales.ts'
import { LayoutController } from '../../src/client/spatial/service.ts'
import { createLayoutStore } from '../../src/client/spatial/stores.ts'
import { MEDIA_SURFACE, MediaSurface } from '../../src/client/spatial/apps/media/MediaSurface.tsx'
import { createDriveFilesDoor } from '../../src/client/spatial/apps/media/drive-source.ts'
import { AssistantMarkdown } from '../../../ui-chat/src/client/chat/AssistantMarkdown.tsx'
import { en as chatEn } from '../../../ui-chat/src/client/locale.ts'
import {
  createDriveImageShelf, driveClaimsImage, openInDrive, OPEN_IN_DRIVE_LABEL,
} from '../../../ui-chat/src/client/drive-link.ts'
import { fixtureWorld, HOME } from './world.ts'

/** Her made-up message: each form she writes for a file, and inline images. */
export const FIXTURE_MESSAGE = [
  'Everything below is made up, for the drive fixture.',
  '',
  `- The plan, as a link with brackets: [PENTORA](<${HOME}/docs/PENTORA.v0.md>)`,
  `- The same file, as a plain link: [PENTORA.v0.md](${HOME}/docs/PENTORA.v0.md)`,
  `- A file she produced, as a bare path: \`${HOME}/docs/pentora/notes.txt\``,
  `- A file the drive keeps out: [credentials](${HOME}/docs/credentials.yaml)`,
  `- Her own working files, outside the drive's places, open where they always did (the right sidebar): [seed plan](${HOME}/seed/plan.md) and [HANDOFF.md](${HOME}/HANDOFF.md)`,
  `- A vector image, never shown inline: ![logo](${HOME}/docs/logo.svg)`,
  `- A photo in Private, never read inline: ![private photo](${HOME}/private/photo.png)`,
  '',
  'Her last screenshot:',
  '',
  `![her last screenshot](<${HOME}/captures/latest.png>)`,
  '',
  `The same screenshot again, with a query: ![her last screenshot again](<${HOME}/captures/latest.png?v=2>)`,
].join('\n')

/** The made-up thread the message is in (her home thread). */
const THREAD = 'made-up-home-thread'

type Translate = (key: string, params?: Record<string, string | number>) => string
const dictionary: Readonly<Record<string, string>> = { ...commonEn as Record<string, string>, ...chatEn as Record<string, string> }
const t: Translate = (key, params) => (dictionary[key] ?? key).replace(/\{(\w+)\}/gu, (_, name: string) => String(params?.[name] ?? ''))
const frameWords = frameEn as Readonly<Record<string, string>>
const frameT = (key: string): string => frameWords[key] ?? key

const fileDrag = { prepare: async () => ({ start: () => true, release: () => {} }), reportFailure: () => {} }
const IMAGE_LABELS = {
  open: 'Open image', loading: 'Loading image', failed: 'Image unavailable', dialog: 'Image preview', close: 'Close', dragFailed: 'Could not drag the image',
}
const NOTHING = { subscribe: () => () => {} }

/** One network attempt the fixture page refused. */
export interface RefusedAttempt { readonly kind: 'fetch' | 'xhr' | 'socket' | 'event-source' | 'beacon'; readonly url: string; readonly method: string }

/**
 * Refuse every network attempt on this page, and keep a list of them: the fixture calls no host and posts nothing. The
 * drive and the chat attempt nothing; the Spatial frame's own fingerprint card asks for HEAD and its live socket opens
 * one, and both are refused here.
 * @param scope - the page global (the spec passes its own).
 * @returns the refused attempts, in order.
 */
export function refuseNetwork(page: object = globalThis): readonly RefusedAttempt[] {
  const scope = page as Record<string, unknown>
  const refused: RefusedAttempt[] = []
  const urlOf = (input: unknown): string => {
    if (typeof input === 'string') return input
    if (input instanceof URL) return input.href
    const named = input !== null && typeof input === 'object' ? (input as { url?: unknown }).url : undefined
    return typeof named === 'string' ? named : String(input)
  }
  scope.fetch = (input: unknown, init?: { method?: string }): Promise<never> => {
    refused.push({ kind: 'fetch', url: urlOf(input), method: (init?.method ?? (input as { method?: string } | null)?.method ?? 'GET').toUpperCase() })
    return Promise.reject(new TypeError('drive fixture: no network'))
  }
  scope.XMLHttpRequest = class {
    open(method: string, url: string) { refused.push({ kind: 'xhr', url, method: method.toUpperCase() }) }
    send() { throw new TypeError('drive fixture: no network') }
  }
  // Called with `new`, each throws before anything connects.
  scope.WebSocket = function refusedSocket(url: unknown): never {
    refused.push({ kind: 'socket', url: urlOf(url), method: 'GET' })
    throw new TypeError('drive fixture: no network')
  }
  scope.EventSource = function refusedEvents(url: unknown): never {
    refused.push({ kind: 'event-source', url: urlOf(url), method: 'GET' })
    throw new TypeError('drive fixture: no network')
  }
  const navigatorRef = scope.navigator as { sendBeacon?: unknown } | undefined
  if (navigatorRef !== undefined) {
    Object.defineProperty(navigatorRef, 'sendBeacon', {
      configurable: true,
      value: (url: string) => { refused.push({ kind: 'beacon', url: urlOf(url), method: 'POST' }); return false },
    })
  }
  return refused
}

/** The right sidebar's stand-in: names the file her chat sent there (the real viewer is not part of this page). */
function SidebarStandIn({ path, close }: { readonly path: string | null; readonly close: () => void }) {
  if (path === null) return null
  return (
    <aside data-fixture-sidebar="" style={{ padding: 24, color: 'var(--aukora-text)' }}>
      <p style={{ margin: '0 0 8px', fontSize: 11, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--aukora-text-muted)' }}>
        Right sidebar (stand-in on this page)
      </p>
      <p style={{ margin: '0 0 16px', fontSize: 13, lineHeight: '20px', overflowWrap: 'anywhere' }}>
        In her app this file opens here, in the document viewer, as it always did: <code>{path}</code>
      </p>
      <button type="button" className="ak-control" data-fixture-sidebar-close="" onClick={close}>Close</button>
    </aside>
  )
}

/** One fixture page. Installs the made-up bridge on the page global before anything reads it. */
export function DriveFixture({ chat, world }: { readonly chat: boolean; readonly world: ReturnType<typeof fixtureWorld> }): ReactNode {
  // THE REAL SHELL: the layout store, its `ctx.layout` controller, and the frame on them.
  const shell = useMemo(() => {
    const store = createLayoutStore().create()
    const controller = new LayoutController({ subscribe: NOTHING.subscribe, getSnapshot: () => ({ activePanelId: null }) })
    controller.attachPanels(store.actions, () => store.getSnapshot().activeSurface)
    if (chat) {
      store.actions.closeSurface()
      store.actions.openConversation()
    } else {
      store.actions.selectSurface(MEDIA_SURFACE, undefined, 'contained')
    }
    // Drive mode is a fresh load (her thread not yet chosen, so the frame does not open the conversation over the
    // drive); chat mode is her thread restored, open in the left lane.
    const sessions = {
      ...world.sessions,
      byId: Object.fromEntries(Object.entries(world.sessions.byId).map(([id, row]) => [id, { ...row, blank: !chat }])),
    }
    const sessionsSource = { subscribe: NOTHING.subscribe, getSnapshot: () => sessions }
    return { store, controller, useStore: bindSnapshotSelector(store), useSessions: bindSnapshotSelector(sessionsSource) }
  }, [chat, world])
  const door = useMemo(() => {
    const created = createDriveFilesDoor()
    created.set(world.files)
    return created
  }, [world])
  const [sidebarPath, setSidebarPath] = useState<string | null>(null)

  // Her chat's file opener under the Spatial shell (ui-chat apply.ts): the drive takes what it owns; every other path
  // goes to the right sidebar, as on main (here its stand-in, opened the way the sidebar opens itself: openRightbar).
  const openFile = useCallback((path: string) => {
    const absolute = resolveWorkspacePath(HOME, path)
    if (openInDrive(shell.controller, absolute)) return
    setSidebarPath(absolute)
    // A new file in the sidebar is a new reveal (as the sidebar reports a newly opened tab): it comes to the front.
    shell.controller.closeRightbar()
    shell.controller.openRightbar(false, false)
  }, [shell])
  // Her chat's image reader (ui-chat apply.ts driveImages + ChatView): one shelf for the thread, bytes into blob: URLs.
  const shelf = useMemo(() => createDriveImageShelf(() => world.files, THREAD), [world])
  const fileImages = useMemo(() => ({
    fileDrag,
    resolve: () => undefined,
    labels: IMAGE_LABELS,
    load: {
      claims: (path: string) => driveClaimsImage(shell.controller, resolveWorkspacePath(HOME, path)),
      read: (path: string, signal: AbortSignal) => shelf.read(resolveWorkspacePath(HOME, path), signal),
      openLabel: OPEN_IN_DRIVE_LABEL,
    },
  }), [shell, shelf])
  // A path she produced in this turn links as a file mention (ui-deliverables does this for her real produced files).
  const mentions = useMemo<MarkdownFileMentions>(() => ({
    resolve: value => (value.startsWith(`${HOME}/`) ? { open: () => { openFile(value) }, label: value, title: value } : undefined),
  }), [openFile])

  const renderSlot = ((key: string, owner: Record<string, unknown>, options?: { entryKey?: string }): ReactNode => {
    if (key === 'shell.surface') {
      const surface = { ...owner, useSessions: shell.useSessions, driveFiles: door } as unknown as Parameters<typeof MediaSurface>[0]
      return <MediaSurface {...surface} />
    }
    if (chat && key === 'main' && options?.entryKey === 'conversation') {
      return (
        <div data-fixture-chat="" style={{ height: '100%', overflow: 'auto', padding: '24px 20px', boxSizing: 'border-box' }}>
          <MarkdownDelegateProvider openFile={openFile} openExternalLink={(href) => { window.open(href, '_blank', 'noopener,noreferrer') }} fileImages={fileImages}>
            <AssistantMarkdown {...{
              blocks: [{ kind: 'text', text: FIXTURE_MESSAGE }], streaming: false, mentions, t,
              loadImage: () => Promise.reject(new Error('unused')), renderSlot: () => null,
              useDisclosure: () => [false, () => {}], useGroupAction: () => false, usePresentation: () => undefined,
            } as unknown as Parameters<typeof AssistantMarkdown>[0]} />
          </MarkdownDelegateProvider>
        </div>
      )
    }
    if (key === 'rightbar') {
      return <SidebarStandIn path={sidebarPath} close={() => { setSidebarPath(null); shell.controller.closeRightbar() }} />
    }
    return null
  }) as unknown as AppFrameProps['renderSlot']

  const props = {
    useStore: shell.useStore,
    useSessions: shell.useSessions,
    actions: shell.store.actions,
    renderSlot,
    t: frameT,
  } as unknown as AppFrameProps
  return (
    <div data-drive-fixture={chat ? 'chat' : 'drive'} style={{ height: '100%' }}>
      <AppFrame {...props} />
    </div>
  )
}

/**
 * Prepare the page before React mounts it (the entry, `apps/web/drive-fixture.entry.js`, renders `DriveFixture`).
 * @param search - the page's query: `?chat=1` adds her made-up message.
 * @returns the made-up her, whether the chat mode is on, and the network attempts the page refused.
 */
export function prepareFixture(search: string): {
  readonly world: ReturnType<typeof fixtureWorld>
  readonly chat: boolean
  readonly refused: readonly RefusedAttempt[]
} {
  const refused = refuseNetwork()
  const world = fixtureWorld()
  ;(globalThis as Record<string, unknown>).__AUKORA_SUPERAGENT__ = world.bridge
  document.body.setAttribute('data-ds-dark-theme', '')
  return { world, chat: new URLSearchParams(search).get('chat') === '1', refused }
}
