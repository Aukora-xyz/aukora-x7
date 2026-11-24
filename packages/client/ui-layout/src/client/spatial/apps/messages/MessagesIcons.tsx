// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The Aukora authors
/**
 * The glyphs the predecessor's x5 Nostr Messages toolbar used, copied in so this app imports nothing from another package:
 * pin, unread and archive (an earlier repository), plus (`threads/icons.tsx`
 * `IconPlusOutline16`) and send (`ui-primitives` `IconSendOutline14`).
 *
 * @module apps/messages/MessagesIcons
 */

interface IconProps { readonly size?: number }

/** Pin outline, for the pinned filter and a conversation's pinned state. */
export function PinIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M9.5 1.5 14.5 6.5 11 8l-1.5 4.5L4 7 8.5 5.5Z" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M5 11l-3 3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** Unread ring, for the unread filter and a conversation's unread mark. */
export function UnreadIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="4.6" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  )
}

/** Archive outline, for the archived filter and a conversation's archived state. */
export function ArchiveIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="2" y="3" width="12" height="3.4" rx="0.8" stroke="currentColor" strokeWidth="1.4" />
      <path d="M3.4 6.4V13h9.2V6.4M6.4 9h3.2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** Plus, for New message. */
export function PlusIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M8.64453 1.5V7.34961H14.5V8.65039H8.64453V14.5H7.34473V8.65039H1.5V7.34961H7.34473V1.5H8.64453Z" fill="currentColor" />
    </svg>
  )
}

/** Thin upward send arrow, for the compose bar. */
export function SendIcon({ size = 14 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path
        d={'M7.24707 1.01771C7.52897 1.07653 7.77619 1.19694 8.00391 1.38001C8.19202 1.53136 8.39884 1.73784 8.61914 1.95814L12.6396 '
          + '5.9806L11.6299 6.99134L7.71484 3.0763V13.0001H6.28516V3.0763L2.36914 6.99134L1.35938 5.9806L5.38086 1.95814C5.60116 '
          + '1.73784 5.80798 1.53136 5.99609 1.38001C6.19476 1.22027 6.4385 1.06739 6.75195 1.01771C6.91296 0.992304 7.07471 '
          + '0.997504 7.24707 1.01771Z'}
        fill="currentColor"
      />
    </svg>
  )
}
