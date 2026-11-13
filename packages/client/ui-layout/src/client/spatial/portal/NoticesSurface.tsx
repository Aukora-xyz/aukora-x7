// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The Aukora authors
/**
 * THE NOTICES LAUNCHER AND ITS SURFACE (model in `notices.ts`).
 *
 *   NoticesMenu     the FIRST entry of the system (square) menu, directly above Work: a `PortalLauncher` like its
 *                   neighbours. With nothing waiting it is drawn exactly like them (blue); with something waiting it is
 *                   gold (`ak-tone-gold`, the gold the old pill used) and carries the count. Its name says the count.
 *   NoticesSurface  opens in the centre like every system app (`AppSurface` + `AppHeader`): one plain list, newest
 *                   first, each row what it is in plain words, when it was first seen, and its one action as a
 *                   normal button. With nothing waiting it says one line.
 * Nothing here opens by itself, takes focus, plays a sound, or is positioned over anything.
 */
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  ActionControl, AppHeader, AppSurface, Lead, PortalFold, PortalLauncher, RecordList, StatusPill,
} from '../primitives/index.ts'
import { APPROVAL_FINISHING_WORDS, useReloadHeld } from './build-notice.ts'
import { firstSeenText, NOTHING_WAITING, NOTICES_SURFACE, noticesLabel, useNotices } from './notices.ts'

/** The launcher's donor-style copy. */
export const NOTICES_COPY = Object.freeze({
  title: 'Notices',
  summary: 'what is waiting for you',
  eyebrow: 'WHAT IS WAITING FOR YOU',
  heading: 'NOTICES',
})

/** The system menu's first entry. */
export function NoticesMenu({ activeSurface, openSurface, closeSurface }: PropsRuntime<'shell.menu.system'>) {
  const count = useNotices().length
  const waiting = count > 0
  return (
    <PortalLauncher
      menu
      tone={waiting ? 'gold' : 'blue'}
      icon="releases"
      iconTone={waiting ? 'gold' : 'blue'}
      data-notices-launcher=""
      data-waiting={String(count)}
      aria-label={noticesLabel(count)}
      title={NOTICES_COPY.title}
      summary={NOTICES_COPY.summary}
      badge={waiting ? <StatusPill tone="gold">{String(count)}</StatusPill> : null}
      current={activeSurface === NOTICES_SURFACE}
      onOpen={() => { openSurface(NOTICES_SURFACE, undefined, 'contained') }}
      onClose={closeSurface}
    />
  )
}

/** The centre surface: the list, newest first. Hidden and idle unless it is the selected surface. */
export function NoticesSurface({ activeSurface }: PropsRuntime<'shell.surface'>) {
  const active = activeSurface === NOTICES_SURFACE
  const notices = useNotices()
  // NO RELOAD OVER AN APPROVAL IN FLIGHT (build-notice.ts): the row's Reload waits, and the list says so, as the pill did.
  const held = useReloadHeld()
  const now = Date.now()
  return (
    <AppSurface active={active} tone="gold" data-notices-surface="">
      <AppHeader
        eyebrow={NOTICES_COPY.eyebrow}
        title={NOTICES_COPY.heading}
        tone="gold"
        badges={notices.length === 0 ? [] : [{ text: `${String(notices.length)} waiting`, tone: 'gold' }]}
      />
      {held && notices.length > 0
        ? <Lead><span role="status" data-reload-held="">{APPROVAL_FINISHING_WORDS}</span></Lead>
        : null}
      {notices.length === 0 ? <Lead><span data-notices-empty="">{NOTHING_WAITING}</span></Lead> : (
        <RecordList>
          {notices.map(notice => (
            <li key={notice.id} data-notice={notice.kind} data-notice-id={notice.id}>
              <PortalFold
                tone="gold"
                icon="releases"
                title={notice.what}
                summary={firstSeenText(notice.firstSeen, now)}
                badge={(
                  <ActionControl tone="gold" data-notice-action={notice.kind} onClick={notice.action.run}>
                    {notice.action.label}
                  </ActionControl>
                )}
              />
            </li>
          ))}
        </RecordList>
      )}
    </AppSurface>
  )
}
