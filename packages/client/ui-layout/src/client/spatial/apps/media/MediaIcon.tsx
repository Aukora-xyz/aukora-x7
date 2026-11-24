// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The Aukora authors
/**
 * Media's own small outline glyphs (predecessor `MediaIcon`), shared by the studio and the drive; no remote media. The drive
 * adds folder, document, download, copy and refresh in the same stroke.
 *
 * @module apps/media/MediaIcon
 */

/** One glyph name. */
export type MediaIconKind =
  | 'image' | 'video' | 'settings' | 'close' | 'lock' | 'gallery' | 'folder' | 'document' | 'download' | 'copy' | 'refresh'

/** A 20px outline glyph in the current colour. */
export function MediaIcon({ kind }: { readonly kind: MediaIconKind }) {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"
      strokeLinejoin="round" aria-hidden="true">
      {kind === 'image' && <><rect x="3" y="3" width="18" height="18" rx="3" /><circle cx="8" cy="8" r="1.5" /><path d="m3 17 6-6 4 4 3-3 5 5" /></>}
      {kind === 'video' && <><rect x="3" y="4" width="18" height="16" rx="3" /><path d="m10 8 6 4-6 4Z" /></>}
      {kind === 'settings' && <><path d="M4 7h16M4 17h16" /><circle cx="9" cy="7" r="3" /><circle cx="15" cy="17" r="3" /></>}
      {kind === 'close' && <path d="m6 6 12 12M6 18 18 6" />}
      {kind === 'lock' && <><rect x="5" y="10" width="14" height="11" rx="3" /><path d="M8 10V7a4 4 0 0 1 8 0v3M12 15v2" /></>}
      {kind === 'gallery' && <><rect x="7" y="7" width="14" height="14" rx="3" /><path d="M17 3H6a3 3 0 0 0-3 3v11M11 16l3-3 3 3" /></>}
      {kind === 'folder' && <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />}
      {kind === 'document' && <><path d="M7 3h7l5 5v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z" /><path d="M14 3v5h5M9 13h6M9 17h6" /></>}
      {kind === 'download' && <path d="M12 4v11m-5-5 5 5 5-5M5 20h14" />}
      {kind === 'copy' && <><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></>}
      {kind === 'refresh' && <path d="M20 11a8 8 0 0 0-14.3-4.9L4 8m0-4v4h4M4 13a8 8 0 0 0 14.3 4.9L20 16m0 4v-4h-4" />}
    </svg>
  )
}
