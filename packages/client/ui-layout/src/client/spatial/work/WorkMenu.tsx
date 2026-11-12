/**
 * The Work entry in the right-side square (system) menu: the predecessor's launcher portal, a `PortalLauncher` like every other menu
 * entry (`../portal/menus.tsx`). It opens the Work surface in the centre; while Work is shown it carries
 * `aria-current="page"` and selecting it again closes it (the menus' − ). It grants nothing.
 */
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { PortalLauncher } from '../primitives/index.ts'
import { WORK_SURFACE } from './WorkSurface.tsx'

export type WorkMenuProps = PropsRuntime<'shell.menu.system'> & PropsLocale<'layout'>

export function WorkMenu({ activeSurface, openSurface, closeSurface, t }: WorkMenuProps) {
  return (
    <PortalLauncher
      menu
      tone="blue"
      icon="agent"
      iconTone="mint"
      data-work-launcher=""
      title={t('menu.work')}
      summary={t('menu.work.tip')}
      current={activeSurface === WORK_SURFACE}
      onOpen={() => { openSurface(WORK_SURFACE, undefined, 'contained') }}
      onClose={closeSurface}
    />
  )
}
