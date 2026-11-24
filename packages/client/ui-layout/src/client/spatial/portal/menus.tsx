// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The Aukora authors
/**
 * THE PREDECESSOR'S THREE RIGHT-HAND MENUS ON X6.1: the launchers of the predecessor layout
 * (an earlier repository), one `<PortalLauncher menu>` each (the application launcher of
 * the Spatial design spec, 6: it opens an application, never content in place, and grants nothing), with the predecessor's
 * titles, summaries, tones and icons. A launcher opens its surface in the centre lane; while it is open it shows − and
 * closes it.
 *
 *   triangle  AUKORA APPS  Auma Live, Auma Lingwa, Zeta Harp, Nostr Messages, Media, Auma Canvas
 *   square    SYSTEM       (Work), Sovereignty, AUMLOK, Identity, Aura Coherence, General, Models, Built-in plugins, Agent presets
 *   circle    MY APPS      Dakini Code
 */
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { PortalLauncher, type IconName, type Tone } from '../primitives/index.ts'
import type { SurfacePresentation } from '../stores.ts'
import type { MenuItemOwnerProps } from '../types.ts'

/** One launcher's predecessor copy and the surface it opens. */
export interface Launcher {
  readonly id: string
  readonly title: string
  readonly summary: string
  readonly icon: IconName
  readonly iconTone: Tone
  readonly presentation?: SurfacePresentation
}

/** Triangle tab: the bundled Aukora apps, in the predecessor's order. */
export const AUKORA_APPS: readonly Launcher[] = [
  { id: 'auma-live', title: 'Auma Live', summary: 'local full-duplex voice and presence', icon: 'app', iconTone: 'mint', presentation: 'full-bleed' },
  { id: 'auma-language', title: 'Auma Lingwa', summary: 'language, memory and daily lessons', icon: 'app', iconTone: 'mint', presentation: 'full-bleed' },
  { id: 'zeta-harp', title: 'Zeta Harp', summary: 'the Riemann–Siegel instrument', icon: 'app', iconTone: 'violet', presentation: 'full-bleed' },
  { id: 'messages', title: 'Nostr Messages', summary: 'contacts and signed messages', icon: 'app', iconTone: 'blue' },
  { id: 'media', title: 'Media and Documents', summary: 'her screenshots, images and documents', icon: 'app', iconTone: 'gold' },
  { id: 'auma-canvas', title: 'Auma Canvas', summary: 'her living visual workspace', icon: 'app', iconTone: 'blue', presentation: 'full-bleed' },
]

/** Circle tab: apps of her own. */
export const MY_APPS: readonly Launcher[] = [
  { id: 'dakini-code', title: 'Dakini Code', summary: 'the original spatial code instrument', icon: 'app', iconTone: 'mint', presentation: 'full-bleed' },
]

interface LauncherButtonProps { readonly launcher: Launcher; readonly tone: Tone; readonly owner: MenuItemOwnerProps }

function LauncherButton({ launcher, tone, owner }: LauncherButtonProps) {
  const { activeSurface, openSurface, closeSurface } = owner
  return (
    <PortalLauncher
      menu
      tone={tone}
      icon={launcher.icon}
      iconTone={launcher.iconTone}
      data-launcher={launcher.id}
      title={launcher.title}
      summary={launcher.summary}
      current={activeSurface === launcher.id}
      onOpen={() => { openSurface(launcher.id, undefined, launcher.presentation ?? 'contained') }}
      onClose={closeSurface}
    />
  )
}

export function AukoraAppsMenu(props: PropsRuntime<'shell.menu.apps'>) {
  return <>{AUKORA_APPS.map(launcher => <LauncherButton key={launcher.id} launcher={launcher} tone="mint" owner={props} />)}</>
}

export function MyAppsMenu(props: PropsRuntime<'shell.menu.yours'>) {
  return <>{MY_APPS.map(launcher => <LauncherButton key={launcher.id} launcher={launcher} tone="mint" owner={props} />)}</>
}

/** Square tab, the predecessor's system launchers (Work registers its own, ahead of these). */
export const SYSTEM_LAUNCHERS: readonly Launcher[] = [
  { id: 'sovereignty', title: 'Sovereignty', summary: 'approvals, keys and receipts', icon: 'sovereignty', iconTone: 'gold' },
  { id: 'continuity', title: 'Continuity', summary: 'what keeps her alive, and where', icon: 'releases', iconTone: 'blue' },
  { id: 'aumlok', title: 'AUMLOK', summary: 'seven-word binding witness', icon: 'aumlok', iconTone: 'mint' },
  { id: 'identity', title: 'Identity', summary: 'your public contact card', icon: 'identity', iconTone: 'blue' },
  { id: 'aura-coherence', title: 'Aura Coherence', summary: 'living system state', icon: 'aura', iconTone: 'violet' },
]

export function SystemMenu(props: PropsRuntime<'shell.menu.system'>) {
  return <>{SYSTEM_LAUNCHERS.map(launcher => <LauncherButton key={launcher.id} launcher={launcher} tone="blue" owner={props} />)}</>
}

/** The stock settings sections the predecessor's menu lists, with the predecessor's glyphs, colours and one-line summaries. */
export const SETTINGS_LAUNCHERS: readonly (Launcher & { readonly section: string })[] = [
  { id: 'settings:general', section: 'general', title: 'General', summary: 'language, look and defaults', icon: 'general', iconTone: 'gold' },
  { id: 'settings:models', section: 'models', title: 'Models', summary: 'model providers and keys', icon: 'model', iconTone: 'mint' },
  { id: 'settings:plugins', section: 'plugins', title: 'Built-in plugins', summary: 'what the harness ships', icon: 'plugins', iconTone: 'blue' },
  { id: 'settings:agent-presets', section: 'agent-presets', title: 'Agent presets', summary: 'how the agent works', icon: 'presets', iconTone: 'violet' },
]

/**
 * The four Settings launchers. Each opens the predecessor's settings surface for its section in the centre Stage
 * (`../x5/SettingsSurfaces.tsx`), never the stock Settings popup.
 */
export function SettingsMenu({ activeSurface, surfaceTarget, openSurface, closeSurface }: PropsRuntime<'shell.menu.system'>) {
  return (
    <>
      {SETTINGS_LAUNCHERS.map((launcher) => {
        const open = activeSurface === 'settings' && (surfaceTarget ?? 'general') === launcher.section
        return (
          <PortalLauncher
            key={launcher.id}
            menu
            tone="blue"
            icon={launcher.icon}
            iconTone={launcher.iconTone}
            data-settings-section={launcher.section}
            title={launcher.title}
            summary={launcher.summary}
            current={open}
            onOpen={() => { openSurface('settings', launcher.section, 'contained') }}
            onClose={closeSurface}
          />
        )
      })}
    </>
  )
}
