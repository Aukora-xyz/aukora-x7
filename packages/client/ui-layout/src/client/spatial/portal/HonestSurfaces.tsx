// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The Aukora authors
/**
 * The AUMLOK wrapper: the predecessor's real AUMLOK surface (`../aumlok/AumlokSurface.tsx`) with its ceremony switched off, under
 * the predecessor's STRUCTURE badge — the seven tiles and their states render, no phrase is ever drawn or submitted on x6.1.
 */
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { StatusPill } from '../primitives/index.ts'
import { AumlokSurface, type AumlokSurfaceProps } from '../aumlok/AumlokSurface.tsx'

/** The predecessor's AUMLOK surface under the predecessor's STRUCTURE badge; the badge shows only while AUMLOK is open. */
export function AumlokStructureSurface(props: AumlokSurfaceProps & PropsLocale<'aumlok'>) {
  const active = props.activeSurface === 'aumlok'
  return (
    // `.x5-donor-surface` sets `display: flex`, which outranks the `hidden` attribute, so inactive is an inline `none`.
    <div className="x5-donor-surface" data-aumlok-structure="" style={active ? undefined : { display: 'none' }}>
      <div className="x5-structure-badge"><StatusPill tone="gold">STRUCTURE</StatusPill></div>
      <AumlokSurface {...props} />
    </div>
  )
}
