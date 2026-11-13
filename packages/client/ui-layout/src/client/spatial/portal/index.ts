// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The Aukora authors
/**
 * THE PREDECESSOR'S SPATIAL, RESTORED ON X6.1: the three right-hand menus and the centre-lane surfaces of
 * the predecessor layout (an earlier repository), registered into the Spatial root's own
 * slots. Each entry below says where its facts come from; the ones x6.1 has no source for say "not connected yet".
 *
 *   AUKORA APPS (triangle)  Auma Live, Auma Lingwa, Zeta Harp, Nostr Messages, Media and Documents, Auma Canvas
 *   SYSTEM (square)         Notices, Work (its own module), Sovereignty, AUMLOK, Identity, Aura Coherence, the four Settings
 *                           sections
 *   MY APPS (circle)        Dakini Code
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-gateway/client'
import { AuraPentoraSurface, type AuraSurfaceInjected } from '../aura/AuraPentoraSurface.tsx'
import { AURA_SURFACE } from '../aura/model.ts'
import { en as aumlokEn, zh as aumlokZh, type AumlokKey } from '../aumlok/locales.ts'
import { NS } from '../locales.ts'
import { AUMLOK_NO_CONTROLLER, type AumlokControlProjectionState } from '../aumlok/control-state.ts'
import type { AumlokSurfaceInjected } from '../aumlok/AumlokSurface.tsx'
import { createWorkReader } from '../work/index.ts'
import { AumlokStructureSurface } from './HonestSurfaces.tsx'
import { SettingsSurfaces } from '../x5/SettingsSurfaces.tsx'
import { NostrMessagesSurface } from '../apps/messages/index.ts'
import { createDriveFilesDoor, MediaSurface, type MediaSurfaceInjected } from '../apps/media/index.ts'
import { IdentitySurface } from '../apps/identity/IdentitySurface.tsx'
import { AukoraAppsMenu, MyAppsMenu, SettingsMenu, SystemMenu } from './menus.tsx'
import {
  CONTINUITY_SURFACE, ContinuitySurface, SOVEREIGNTY_SURFACE, SovereigntySurface, type SovereigntySurfaceInjected,
} from './SovereigntySurface.tsx'
import { createScheduleDoor, type ScheduleActiveEdit } from './sovereignty-panels.ts'
import { StockAppFrames } from './StockAppFrames.tsx'
import { ApprovalWaiting, type ApprovalWaitingInjected } from './ApprovalWaiting.tsx'
import { NoticesMenu, NoticesSurface } from './NoticesSurface.tsx'
import { NOTICES_SURFACE } from './notices.ts'
import './spatial-layer.css'
import './spatial-layer-fit.css'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The predecessor's AUMLOK surface copy (an earlier repository). */
    aumlok: AumlokKey
  }
}

/** The AUMLOK locale namespace. */
const AUMLOK_NS = 'aumlok'


/** X6.1 has no AUMLOK controller and no ceremony bridge: one fixed state, and two verbs that refuse. */
const aumlokInjected = (): AumlokSurfaceInjected => ({
  hooks: {
    controlProjection: {
      getSnapshot: (): AumlokControlProjectionState => AUMLOK_NO_CONTROLLER,
      subscribe: () => () => {},
    },
  },
  ceremonyAvailable: false,
  drawPhrase: () => Promise.resolve({ ok: false, reason: 'aumlok:no-ceremony-bridge' }),
  submitPhrase: () => Promise.resolve({ ok: false, reason: 'aumlok:no-ceremony-bridge' }),
  refreshControlStatus: () => {},
})

/**
 * Register the predecessor's menus and surfaces into the Spatial root.
 * @param ctx - client root context.
 */
export function installPortal(ctx: ClientContext, openSurface?: (id: string) => void): void {
  ctx.effect(() => ctx.locale.register(AUMLOK_NS, { zh: aumlokZh, en: aumlokEn }), 'ui-layout: spatial aumlok dictionaries')

  ctx.slots.inject('shell.menu.apps', () => ctx.slots.register({ name: 'shell.menu.apps', id: 'aukora-apps' }, AukoraAppsMenu))
  ctx.slots.inject('shell.menu.yours', () => ctx.slots.register({ name: 'shell.menu.yours', id: 'aukora-yours' }, MyAppsMenu))
  // NOTHING FLOATS: Notices is the system menu's first entry, above Work (order 0); its surface lists them.
  ctx.slots.inject('shell.menu.system', () => ctx.slots.register(
    { name: 'shell.menu.system', id: NOTICES_SURFACE, order: -10 }, NoticesMenu))
  ctx.slots.inject('shell.menu.system', () => ctx.slots.register({ name: 'shell.menu.system', id: 'aukora-system', order: 10 }, SystemMenu))
  ctx.slots.inject('shell.menu.system', () => ctx.slots.register({ name: 'shell.menu.system', id: 'aukora-settings', order: 20 }, SettingsMenu))

  ctx.slots.inject('shell.surface', () => ctx.slots.register({ name: 'shell.surface', id: 'aukora-stock-apps' }, StockAppFrames))
  ctx.slots.inject('shell.surface', () => ctx.slots.register({ name: 'shell.surface', id: NOTICES_SURFACE }, NoticesSurface))
  // Wave 4 (AC1): "Approval waiting" on the outer chrome, above every surface, while HEAD holds something for the passkey.
  if (openSurface !== undefined) {
    ctx.slots.inject('shell.overlay', () => ctx.slots.register({
      name: 'shell.overlay', id: 'aukora-approval-waiting',
      inject: (): ApprovalWaitingInjected => ({ openSovereignty: () => { openSurface(SOVEREIGNTY_SURFACE) } }),
    }, ApprovalWaiting))
  }
  // The predecessor's real centre-Stage surfaces (Round 10): settings sections, Nostr Messages, Media, Identity. No popups.
  ctx.slots.inject('shell.surface', () => ctx.slots.register({ name: 'shell.surface', id: 'aukora-settings-surfaces' }, SettingsSurfaces))
  ctx.slots.inject('shell.surface', () => ctx.slots.register({ name: 'shell.surface', id: 'aukora-messages' }, NostrMessagesSurface))
  // Media and Documents reads her files through the files service, set and cleared by its scope below.
  const driveFiles = createDriveFilesDoor()
  ctx.slots.inject('shell.surface', () => ctx.slots.register({
    name: 'shell.surface', id: 'aukora-media', inject: (): MediaSurfaceInjected => ({ driveFiles }),
  }, MediaSurface))
  ctx.slots.inject('shell.surface', () => ctx.slots.register({ name: 'shell.surface', id: 'aukora-identity' }, IdentitySurface))
  ctx.slots.inject('shell.surface', () => ctx.slots.register({
    name: 'shell.surface', id: 'aumlok', locale: AUMLOK_NS, inject: aumlokInjected,
  }, AumlokStructureSurface))

  // THE HOST'S SCHEDULE SERVICE, for the Sovereignty wake card (Round 24). Its own inject: a host without it leaves the
  // door empty, and the card says so; it never holds back the rest of the view.
  const schedules = createScheduleDoor()
  ctx.inject(['remote', 'remote.schedule'], (scope) => {
    scope.effect(() => {
      const remote = scope.remote.schedule
      schedules.set({
        catalog: () => remote.catalog(),
        edit: (request: ScheduleActiveEdit) => remote.edit(request as Parameters<typeof remote.edit>[0]),
      })
      return () => { schedules.set(null) }
    }, 'ui-layout: sovereignty schedule door')
  })
  ctx.inject(['slots', 'remote', 'remote.workspaceFiles'], (scope) => {
    const reader = createWorkReader(scope.remote.workspaceFiles)
    scope.effect(() => {
      driveFiles.set(scope.remote.workspaceFiles)
      return () => { driveFiles.set(null) }
    }, 'ui-layout: media drive files door')
    scope.slots.inject('shell.surface', () => scope.slots.register({
      name: 'shell.surface', id: AURA_SURFACE, inject: (): AuraSurfaceInjected => ({ reader }),
    }, AuraPentoraSurface))
    scope.slots.inject('shell.surface', () => scope.slots.register({
      name: 'shell.surface', id: SOVEREIGNTY_SURFACE, locale: NS, inject: (): SovereigntySurfaceInjected => ({ reader, schedules }),
    }, SovereigntySurface))
    scope.slots.inject('shell.surface', () => scope.slots.register({
      name: 'shell.surface', id: CONTINUITY_SURFACE, locale: NS, inject: (): SovereigntySurfaceInjected => ({ reader, schedules }),
    }, ContinuitySurface))
  })
}
