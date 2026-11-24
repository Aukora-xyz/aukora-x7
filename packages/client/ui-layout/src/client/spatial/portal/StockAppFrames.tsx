// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The Aukora authors
/**
 * THE PREDECESSOR'S STOCK APPS IN THE CENTRE LANE (an earlier repository), one frame per app, each kept
 * mounted and hidden while another surface is shown, told by `postMessage` when it becomes the active surface.
 *
 * WHERE THEY LIVE (SOURCE, `server/local-host.mjs`): the host answers any HTML request outside `/assets/` and `/preview/`
 * with the AUKORA page itself whenever a runtime release is selected. A frame at the predecessor's `/stock-apps/…` would boot a
 * second copy of this app inside the first. So the HTML entries are served from `/assets/stock-apps/…` (copied from
 * `apps/web/public`), and their scripts stay at the predecessor's `/app/…` paths, which the host serves as plain files.
 *
 * WHAT THEY CAN REACH: the frames are same-origin (the predecessor's sandbox flags; their module scripts need it), so a frame
 * can reach this page exactly as the page itself can. They are first-party files from the predecessor and load nothing from
 * another origin. ROUND 10: Auma Live and Auma Canvas now speak through this page's own `__DSH_TRANSPORT__`
 * (`/app/genesis-live.js`) into the shell's SELECTED session (localStorage `dsh.sessions.current`) with the composer's
 * own `session/prompt`. Mounting only reads the selection; a turn is sent only when the owner speaks or types in Auma Live.
 * There is no second agent: the turn lands in her existing Cordis session.
 */
import { useEffect, useRef } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

/** The predecessor's five framed apps, with their entries moved under `/assets/stock-apps/`. */
export const STOCK_APPS = [
  { id: 'auma-live', title: 'Auma Live', src: '/assets/stock-apps/auma-live.html', allow: 'microphone; autoplay' },
  { id: 'auma-canvas', title: 'Auma Canvas', src: '/assets/stock-apps/auma-live.html?mode=canvas', allow: 'microphone; autoplay' },
  { id: 'auma-language', title: 'Auma Lingwa', src: '/assets/stock-apps/auma-lingwa.html', allow: 'autoplay' },
  { id: 'zeta-harp', title: 'Zeta Harp', src: '/assets/stock-apps/zeta-harp/index.html', allow: 'autoplay' },
  { id: 'dakini-code', title: 'Dakini Code', src: '/assets/stock-apps/dakini-code/index.html', allow: 'autoplay' },
] as const

const STOCK_IDS: ReadonlySet<string> = new Set(STOCK_APPS.map(app => app.id))

/** Whether a surface id is one of the framed stock apps. */
export function isStockApp(id: string | undefined): boolean {
  return id !== undefined && STOCK_IDS.has(id)
}

function tell(frame: HTMLIFrameElement | undefined, app: string, active: boolean): void {
  frame?.contentWindow?.postMessage({ source: 'aukora-shell', type: 'surface-active', app, active }, location.origin)
}

/**
 * Render every stock app's frame. A frame loads the first time its app is opened, then stays mounted.
 * @param props - the centre-lane owner share.
 * @returns the frames.
 */
export function StockAppFrames({ activeSurface }: PropsRuntime<'shell.surface'>) {
  const frames = useRef(new Map<string, HTMLIFrameElement>())
  const opened = useRef(new Set<string>())
  if (activeSurface !== undefined && STOCK_IDS.has(activeSurface)) opened.current.add(activeSurface)
  useEffect(() => {
    for (const app of STOCK_APPS) tell(frames.current.get(app.id), app.id, activeSurface === app.id)
  }, [activeSurface])
  return (
    <>
      {STOCK_APPS.map((app) => {
        const active = activeSurface === app.id
        // Loading on first open keeps a page that never opens Auma Live from asking for its microphone or its sockets.
        if (!opened.current.has(app.id)) return null
        return (
          <div
            key={app.id}
            className="x5-stock-app"
            data-stock-app={app.id}
            data-active={active || undefined}
            hidden={!active}
            // React 18 renders `inert` only as a string attribute; the empty string is "present".
            {...(active ? {} : { inert: '' } as Record<string, string>)}
          >
            <iframe
              className="x5-stock-frame"
              src={app.src}
              title={app.title}
              allow={app.allow}
              sandbox="allow-scripts allow-same-origin allow-forms allow-modals"
              data-stock-app-frame={app.id}
              ref={(frame) => { if (frame !== null) frames.current.set(app.id, frame) }}
              onLoad={(event) => { tell(event.currentTarget, app.id, activeSurface === app.id) }}
            />
          </div>
        )
      })}
    </>
  )
}
