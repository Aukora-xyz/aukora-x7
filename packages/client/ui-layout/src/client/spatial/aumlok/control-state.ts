// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The Aukora authors
/** The read-only state the AUMLOK surface renders (a file of an earlier repository, its state type only). */
import type { AumlokControlProjection, AumlokNotConnectedReason } from './control-model.ts'

/**
 * Complete read-only state consumed by the AUMLOK surface.
 *
 * `reason` is which absence this is, and `code` is the controller's own refusal string when it produced one. `detail`
 * is the sentence the controller wrote, carried to the screen rather than paraphrased.
 */
export type AumlokControlProjectionState =
  | {
    readonly status: 'not-connected'
    readonly reason?: AumlokNotConnectedReason
    readonly code?: string
    readonly detail?: string
  }
  | { readonly status: 'connected'; readonly control: Readonly<AumlokControlProjection> }

/** X6.1 has no AUMLOK controller: the one state this surface is given there. */
export const AUMLOK_NO_CONTROLLER: AumlokControlProjectionState = Object.freeze({
  status: 'not-connected',
  reason: 'no-controller-service',
} as const)
