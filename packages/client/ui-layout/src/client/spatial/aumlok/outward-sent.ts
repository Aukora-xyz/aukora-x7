// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The Aukora authors
/**
 * THE OUTWARD REQUESTS THIS BROWSER HAS SENT, ONE RECORD FOR EVERY CARD ON THE PAGE. A GitHub post has no idempotency key
 * (`outward-class3.ts`), so a request that went out, or may have, is not offered again by this browser while its record
 * holds: not by the card that sent it, and not by any other card on this page or in another tab.
 *
 * Two places hold it: this page's own memory, which always works, and `localStorage`, which other tabs see (a `storage`
 * event under `SENT_KEY`). A `storage` event never fires in the page that wrote it, so a card here that sends tells the
 * other cards here itself (`onSentChange`). With `localStorage` refused (a private window), the memory still holds for
 * this page.
 *
 * WHERE THE RECORD ENDS: it is this browser's alone, and only the last 16 sends are kept. A reload with `localStorage`
 * refused, a request pushed out by 16 newer sends, or another device does not know it: her staged file stays until she
 * clears it, so such a page offers the same request again, and only a second deliberate Touch ID would send it twice.
 * @module aumlok/outward-sent
 */

/** Where other tabs read the record (the last 16 requests, by canonical body). */
export const SENT_KEY = 'aukora.outward-class3.sent'

const sentHere = new Set<string>()
const listeners = new Set<() => void>()

/**
 * Whether this browser has sent this exact request (or may have).
 * @param canonical - the request's canonical body.
 * @returns true when this page or another tab marked it sent.
 */
export function wasSent(canonical: string): boolean {
  if (sentHere.has(canonical)) return true
  try { return (JSON.parse(globalThis.localStorage.getItem(SENT_KEY) ?? '[]') as unknown[]).includes(canonical) } catch { return false }
}

/**
 * Mark a request sent (or maybe sent), and tell every card on this page.
 * @param canonical - the request's canonical body.
 */
export function markSent(canonical: string): void {
  sentHere.add(canonical)
  try {
    const list = (JSON.parse(globalThis.localStorage.getItem(SENT_KEY) ?? '[]') as unknown[]).filter(item => typeof item === 'string')
    globalThis.localStorage.setItem(SENT_KEY, JSON.stringify([...list, canonical].slice(-16)))
  } catch { /* the in-memory record still holds for this page */ }
  for (const listener of [...listeners]) listener()
}

/**
 * Be told when a card on this page marks a request sent.
 * @param listener - called after each mark.
 * @returns a function that stops telling it.
 */
export function onSentChange(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
