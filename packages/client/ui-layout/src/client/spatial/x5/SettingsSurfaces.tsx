// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The Aukora authors
/**
 * The four centre-Stage settings surfaces (the predecessor's `x5/surface.tsx` settings branch), as one `shell.surface` entry.
 *
 * Selected by `openSurface('settings', '<section>', 'contained')` with section `general` | `models` | `plugins` |
 * `agent-presets` (anything else opens General). All four stay mounted; only the selected one renders and reads.
 * Everything renders inline in the Stage: no popup, no overlay.
 * @module x5/SettingsSurfaces
 */
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { sessionOf } from '../work/WorkSurface.tsx'
import { GeneralSurface } from './general.tsx'
import { ModelsSurface } from './models.tsx'
import { PluginsSurface } from './plugins.tsx'
import { PresetsSurface } from './presets.tsx'

/** The surface id the four settings launchers open. */
export const SETTINGS_SURFACE = 'settings'

/** The settings sections, as `surfaceTarget` names them. */
export const SETTINGS_SECTIONS = ['general', 'models', 'plugins', 'agent-presets'] as const
export type SettingsSection = typeof SETTINGS_SECTIONS[number]

/**
 * The section a target names, General when it names none of them.
 * @param target - the `surfaceTarget` the launcher passed.
 * @returns the section to show.
 */
export function settingsSection(target: string | undefined): SettingsSection {
  return SETTINGS_SECTIONS.find(section => section === target) ?? 'general'
}

/** The session the main view holds right now, or undefined (no fallback to another session). */
function onScreenSession(sessions: Parameters<typeof sessionOf>[0]): SessionId | undefined {
  const shown = Object.values(sessions.byId).find(s => (s.retainedBy.mainView ?? 0) > 0)?.id
  return shown !== undefined && !String(shown).startsWith('preview-') ? shown : undefined
}

/**
 * The settings surfaces for slot `shell.surface`.
 * @param props - the slot's owner props (`activeSurface`, `surfaceTarget`, `useSessions`).
 * @returns the four surfaces, the selected one visible.
 */
export function SettingsSurfaces({ activeSurface, surfaceTarget, useSessions }: PropsRuntime<'shell.surface'>) {
  const open = activeSurface === SETTINGS_SURFACE
  const section = settingsSection(surfaceTarget)
  // Skills are listed for the conversation ON SCREEN only: never fall back to some other recent session.
  const sessionId: SessionId | undefined = useSessions(onScreenSession)
  return (
    <>
      <GeneralSurface active={open && section === 'general'} />
      <ModelsSurface active={open && section === 'models'} />
      <PluginsSurface active={open && section === 'plugins'} sessionId={sessionId} />
      <PresetsSurface active={open && section === 'agent-presets'} />
    </>
  )
}

export default SettingsSurfaces
