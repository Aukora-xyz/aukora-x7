// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The Aukora authors
/**
 * Escape inside a text-entry control edits that control, never the surface (predecessor
 * an earlier repository `isEditableTarget`, verbatim). Duck-typed so a target from another realm
 * classifies the same way.
 *
 * @module apps/media/editable-target
 */
export function isEditableTarget(target: EventTarget | null): boolean {
  const el = target as { tagName?: unknown; isContentEditable?: unknown } | null
  const tag = typeof el?.tagName === 'string' ? el.tagName : ''
  return el?.isContentEditable === true || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}
