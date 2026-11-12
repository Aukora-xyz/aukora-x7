// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The Aukora authors
/**
 * SAFARI OPENS A PASSKEY SHEET ONLY INSIDE THE TAP THAT ASKED FOR IT (transient user activation). An approval card whose
 * check is this recent is used as it is at the tap, so the tap goes straight to the passkey challenge with no other request
 * first; the host checks everything again when the approved request arrives. An older check is read again first.
 *
 * ONE APPROVAL AT A TIME PER ITEM, ACROSS EVERY CARD ON THIS PAGE: the chat card and the Sovereignty cards can show the
 * same Pearl, merge or outward request. While one card runs an approval for an item, no other card starts one; and a card
 * whose check is older than the last approval started for its item is never "fresh", so its tap reads HEAD again first.
 * @module portal/touch-id-timing
 */
import { holdReload } from './build-notice.ts'

export const FRESH_CHECK_MS = 30_000

/** The approval key of a staged governance Pearl (its candidate ball). */
export const pearlApprovalKey = (ballId: string): string => `pearl:${ballId}`
/** The approval key of a repo merge proposal (HEAD's canonical record). */
export const mergeApprovalKey = (canonical: string): string => `merge:${canonical}`
/** The approval key of Auma's staged outward request (its canonical body). */
export const outwardApprovalKey = (canonical: string): string => `outward:${canonical}`

const running = new Set<string>()
const lastStarted = new Map<string, number>()
/** NO RELOAD OVER AN APPROVAL IN FLIGHT (build-notice.ts): each running approval holds Reload until it settles. */
const reloadReleases = new Map<string, () => void>()

/**
 * Start an approval for an item, unless one is already running for it on this page.
 * @param key - the item's approval key.
 * @param now - the clock.
 * @returns false when another card is approving it now (nothing may be asked).
 */
export function beginApproval(key: string, now: number = Date.now()): boolean {
  if (running.has(key)) return false
  running.add(key)
  lastStarted.set(key, now)
  reloadReleases.set(key, holdReload())
  return true
}

/** The approval for an item has settled (whatever its outcome). */
export function endApproval(key: string): void {
  running.delete(key)
  reloadReleases.get(key)?.()
  reloadReleases.delete(key)
}

/**
 * Whether a card's check of an item may be used as it is at the tap.
 * @param key - the item's approval key.
 * @param checkedAt - when the card's check of it began.
 * @param now - the clock.
 * @returns true only for a check under FRESH_CHECK_MS that began no earlier than the last approval started for the item.
 */
export function freshFor(key: string, checkedAt: number, now: number = Date.now()): boolean {
  return now - checkedAt < FRESH_CHECK_MS && !running.has(key) && (lastStarted.get(key) ?? -Infinity) <= checkedAt
}

/** The words for a passkey that did not complete after a re-check (Safari may refuse the sheet once the tap has aged). */
export const TAP_AGAIN = 'Touch ID did not complete: cancelled, timed out, or the browser would not open it after the re-check. '
  + 'The card is checked now: tap “Approve with Touch ID” once more.'

/**
 * Whether a refusal is the passkey itself not completing (as opposed to the host or a check refusing).
 * @param text - the outcome words (`Not approved: class3:passkey …`).
 */
export const passkeyDidNotComplete = (text: string): boolean => text.startsWith('Not approved: class3:passkey')

/** Tests only: forget every approval this page started. */
export function resetApprovalsForTests(): void {
  running.clear()
  lastStarted.clear()
  for (const release of reloadReleases.values()) release()
  reloadReleases.clear()
}
