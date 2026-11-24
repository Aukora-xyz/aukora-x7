// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The Aukora authors
/**
 * THE NIGHT GRANT, ASKED FOR ONCE WITH TOUCH ID ON THE EXACT TERMS.
 *
 * HEAD (`deploy/cloudflare/src/night-grant.mjs`) owns the rules. This page only:
 *   1. builds the terms from the head HEAD reports now (12 hours at most, 12 uses at most, ordinary organs only);
 *   2. shows them in the same plain words HEAD uses;
 *   3. at the owner's click binds the exact request body (`class3Action`), asks the passkey, and sends exactly it;
 *   4. lets him revoke it at any time.
 * HEAD re-checks every term against its own clock and head; nothing here is trusted as authority.
 * @module aumlok/night-grant
 */
import { approveClass3, class3Action, sendApprovedClass3, type Class3Dependencies } from './class3-approval.ts'

export const NIGHT_GRANT_SCHEMA = 'aukora.night-grant.v1'
export const NIGHT_GRANT_SCOPE = 'add-or-update-non-governance-organs'
export const NIGHT_GRANT_ROUTE = '/_head/night-grant'
export const NIGHT_GRANT_MAX_LIFETIME_MS = 12 * 60 * 60 * 1000
/** HEAD refuses anything longer than 12 hours by its own clock; stay a little inside it. */
export const NIGHT_GRANT_DEFAULT_LIFETIME_MS = NIGHT_GRANT_MAX_LIFETIME_MS - 10 * 60 * 1000
export const NIGHT_GRANT_DEFAULT_USES = 12
export const NIGHT_GRANT_DEFAULT_ORGANS_PER_USE = 8

/** The exact terms the owner approves. Field order does not matter: the binding hashes canonical JSON. */
export interface NightGrantTerms {
  readonly schema: typeof NIGHT_GRANT_SCHEMA
  readonly grantId: string
  readonly audience: string
  readonly scope: typeof NIGHT_GRANT_SCOPE
  readonly issuedAtHead: { readonly ballId: string; readonly epoch: number }
  readonly notAfter: number
  readonly maxUses: number
  readonly maxOrgansPerUse: number
}

/** What HEAD reports about the current grant (`GET /_head/night-grant`). */
export interface NightGrantStatus {
  readonly state: 'active' | 'expired' | 'exhausted' | 'revoked'
  readonly terms: NightGrantTerms
  readonly usesLeft: number
  readonly plainWords: readonly string[]
}

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)

const defaultRandom = (bytes: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> => {
  crypto.getRandomValues(bytes)
  return bytes
}

/** A fresh, unguessable grant id (HEAD refuses a reused one). */
export function newNightGrantId(random: (bytes: Uint8Array<ArrayBuffer>) => Uint8Array<ArrayBuffer> = defaultRandom): string {
  return 'night-' + [...random(new Uint8Array(12))].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

/** What default terms are built from. */
export interface NightGrantTermsInput {
  readonly origin: string
  readonly head: { readonly ballId: string; readonly epoch: number }
  readonly now: number
  readonly grantId: string
}

/**
 * Build default terms on the head HEAD reports now.
 * @param input - the page origin, the selected head, the clock and a grant id.
 * @returns terms HEAD will accept while that head is current.
 */
export function nightGrantTerms(input: NightGrantTermsInput): NightGrantTerms {
  return { schema: NIGHT_GRANT_SCHEMA, grantId: input.grantId, audience: input.origin, scope: NIGHT_GRANT_SCOPE,
    issuedAtHead: { ballId: input.head.ballId, epoch: input.head.epoch }, notAfter: input.now + NIGHT_GRANT_DEFAULT_LIFETIME_MS,
    maxUses: NIGHT_GRANT_DEFAULT_USES, maxOrgansPerUse: NIGHT_GRANT_DEFAULT_ORGANS_PER_USE }
}

/** The same plain words HEAD returns (`nightGrantPlainWords` in night-grant.mjs); a parity spec keeps them equal. */
export function nightGrantWords(terms: NightGrantTerms): readonly string[] {
  const until = new Date(terms.notAfter).toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
  return [
    `Let Auma add new ordinary organs, or replace an ordinary organ's code, where your Touch ID is asked today, without asking you, at most ${String(terms.maxUses)} times.`,
    'An organ\'s settings and undo history never change under this grant; new organs start with no settings.',
    `Each time she may change at most ${String(terms.maxOrgansPerUse)} organs, and each change must build on her current head.`,
    'Governance organs (her judge, receipts, Aura, AUMLOK, keys, scion, boot and memory) are never covered.',
    `It ends at ${until} or when the uses run out, whichever comes first. You can revoke it at any time.`,
    `Grant ${terms.grantId}, for ${terms.audience}, issued at epoch ${String(terms.issuedAtHead.epoch)}.`,
  ]
}

/** Read HEAD's answer strictly; anything unexpected is "no grant", never "active". */
export function parseNightGrantStatus(answer: unknown): NightGrantStatus | null {
  if (!record(answer) || answer.ok !== true || !record(answer.nightGrant)) return null
  const grant = answer.nightGrant
  const terms = grant.terms
  if (!record(terms) || terms.schema !== NIGHT_GRANT_SCHEMA || typeof terms.grantId !== 'string' || !Array.isArray(grant.plainWords)
    || !['active', 'expired', 'exhausted', 'revoked'].includes(String(grant.state)) || !Number.isSafeInteger(grant.usesLeft)) return null
  return { state: grant.state as NightGrantStatus['state'], terms: terms as unknown as NightGrantTerms, usesLeft: grant.usesLeft as number,
    plainWords: grant.plainWords.filter((line): line is string => typeof line === 'string') }
}

export type NightGrantOutcome =
  | { readonly kind: 'granted'; readonly words: string; readonly status: NightGrantStatus }
  | { readonly kind: 'refused'; readonly words: string }

/**
 * Ask the passkey for exactly these terms and send them.
 * @returns what happened, in words for the owner.
 */
export async function approveNightGrant(terms: NightGrantTerms, origin: string, deps: Class3Dependencies,
  fetchImpl: typeof fetch = globalThis.fetch): Promise<NightGrantOutcome> {
  const body = { action: 'issue', terms }
  const action = await class3Action({ audience: origin, method: 'POST', pathname: NIGHT_GRANT_ROUTE, body })
  const approval = await approveClass3(action, deps)
  if (!approval.ok) return { kind: 'refused', words: `Not granted: the passkey approval did not complete (${approval.reason}).` }
  const sent = await sendApprovedClass3(approval, body, deps.signal, fetchImpl)
  const status = parseNightGrantStatus(sent.body)
  if (sent.status === 200 && status?.state === 'active') return { kind: 'granted', words: 'Granted.', status }
  const code = typeof sent.body?.code === 'string' ? sent.body.code : `HTTP ${String(sent.status)}`
  return { kind: 'refused', words: `Not granted: HEAD refused it (${code}).` }
}

/** Revoke the grant now. Revoking only removes authority, so no passkey is asked. */
export async function revokeNightGrant(grantId: string, signal: AbortSignal, fetchImpl: typeof fetch = globalThis.fetch): Promise<boolean> {
  const response = await fetchImpl(NIGHT_GRANT_ROUTE, { method: 'POST', credentials: 'same-origin', cache: 'no-store',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'revoke', grantId }), signal })
  const answer: unknown = await response.json().catch(() => null)
  return response.status === 200 && record(answer) && answer.ok === true
}

/** Read the current grant: its status, 'none' when HEAD holds none, or null when unknown (never shown as fine). */
export async function readNightGrant(signal: AbortSignal, fetchImpl: typeof fetch = globalThis.fetch): Promise<NightGrantStatus | 'none' | null> {
  const response = await fetchImpl(NIGHT_GRANT_ROUTE, { method: 'GET', credentials: 'same-origin', cache: 'no-store', signal })
  if (response.status !== 200) return null
  const answer: unknown = await response.json().catch(() => null)
  if (record(answer) && answer.ok === true && answer.nightGrant === null) return 'none'
  return parseNightGrantStatus(answer)
}
