// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The Aukora authors
/**
 * THE OWNER MANDATE, ASKED FOR ONCE WITH TOUCH ID ON THE EXACT TERMS. Copied from night-grant.ts.
 *
 * HEAD (`deploy/cloudflare/src/owner-mandate.mjs`) owns the rules. This page only:
 *   1. builds the terms (the closed scope set, the default day bounds, 1, 7 or 30 days);
 *   2. shows them in the same plain words HEAD uses (a parity spec holds the two copies equal);
 *   3. at the owner's click binds the exact request body (`class3Action`), asks the passkey, and sends exactly it;
 *   4. lets him stop it at any time, with no passkey (stopping only removes authority).
 * HEAD re-checks every term against its own clock; nothing here is trusted as authority. Nothing consumes a mandate yet.
 * @module aumlok/mandate
 */
import { approveClass3, class3Action, sendApprovedClass3, type Class3Dependencies } from './class3-approval.ts'

export const MANDATE_SCHEMA = 'aukora.owner-mandate.v1'
export const MANDATE_ROUTE = '/_head/mandate'
export const MANDATE_SCOPES = ['repo.read', 'repo.write.branch', 'exec.run', 'proposal.stage', 'linear.comment', 'relay.post', 'model.call'] as const
export type MandateScope = typeof MANDATE_SCOPES[number]
export const MANDATE_KINDS = ['commits', 'branchCreates', 'execRuns', 'execMinutes', 'proposalStages', 'linearComments', 'relayPosts'] as const
export type MandateKind = typeof MANDATE_KINDS[number]
export type MandatePerDay = { readonly [K in MandateKind]: number }
export const MANDATE_DEFAULT_PER_DAY: MandatePerDay = {
  commits: 24, branchCreates: 8, execRuns: 24, execMinutes: 240, proposalStages: 12, linearComments: 24, relayPosts: 24,
}
const DAY_MS = 24 * 60 * 60 * 1000
/** The three lengths the card offers; 7 days is the default. HEAD refuses more than 30 days. */
export const MANDATE_LENGTHS_DAYS = [1, 7, 30] as const
export type MandateLengthDays = typeof MANDATE_LENGTHS_DAYS[number]
export const MANDATE_DEFAULT_DAYS: MandateLengthDays = 7

/** The exact terms the owner approves. Field order does not matter: the binding hashes canonical JSON. */
export interface MandateTerms {
  readonly schema: typeof MANDATE_SCHEMA
  readonly id: string
  readonly principal: 'owner'
  readonly agent: 'auma'
  readonly scopes: readonly MandateScope[]
  readonly perDay: MandatePerDay
  readonly issuedAt: number
  readonly expiresAt: number
  readonly nonce: string
}

/** What HEAD reports (`GET /_head/mandate`). */
export interface MandateStatus {
  readonly state: 'active' | 'expired' | 'revoked'
  readonly terms: MandateTerms
  readonly plainWords: readonly string[]
  /** Today's counts per kind (UTC day); null when HEAD did not send them in the expected shape. */
  readonly today: MandatePerDay | null
}

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)

const defaultRandom = (bytes: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> => {
  crypto.getRandomValues(bytes)
  return bytes
}
const hex = (bytes: Uint8Array): string => [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('')

/** What the terms are built from. */
export interface MandateTermsInput {
  readonly now: number
  readonly days: MandateLengthDays
  readonly random?: (bytes: Uint8Array<ArrayBuffer>) => Uint8Array<ArrayBuffer>
}

/**
 * Build the terms: every scope of the closed set, the default day bounds, a fresh id and nonce.
 * @param input - the clock, the chosen length and (for specs) a random source.
 * @returns terms HEAD accepts while its clock is near the page's.
 */
export function mandateTerms(input: MandateTermsInput): MandateTerms {
  const random = input.random ?? defaultRandom
  return { schema: MANDATE_SCHEMA, id: 'mandate-' + hex(random(new Uint8Array(12))), principal: 'owner', agent: 'auma', scopes: [...MANDATE_SCOPES],
    perDay: { ...MANDATE_DEFAULT_PER_DAY }, issuedAt: input.now, expiresAt: input.now + input.days * DAY_MS,
    nonce: hex(random(new Uint8Array(16))) }
}

const SCOPE_WORDS: { readonly [S in MandateScope]: string } = { 'repo.read': 'read her repository', 'repo.write.branch': 'write on her own branches',
  'exec.run': 'run jobs on the runner', 'proposal.stage': 'stage proposal cards for you', 'linear.comment': 'comment in Linear',
  'relay.post': 'post on the crew relay', 'model.call': 'call her model' }

/** The UTC date and minute a time stands for, as the card and HEAD both write it. */
export function mandateUntil(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
}

/** The same plain words HEAD returns (`ownerMandatePlainWords` in owner-mandate.mjs); a parity spec keeps them equal. */
export function mandateWords(terms: MandateTerms): readonly string[] {
  const d = terms.perDay
  return [
    'Let Auma work while I am away.',
    `Until ${mandateUntil(terms.expiresAt)}.`,
    `She may: ${MANDATE_SCOPES.filter(scope => terms.scopes.includes(scope)).map(scope => SCOPE_WORDS[scope]).join(', ')}.`,
    `Each day at most: ${String(d.commits)} commits on her own branches, ${String(d.branchCreates)} new branches, ${String(d.execRuns)} runner jobs (${String(d.execMinutes)} minutes), ${String(d.proposalStages)} proposal cards, ${String(d.linearComments)} comments, ${String(d.relayPosts)} relay posts.`,
    'Never without my fingerprint: merge, deploy, keys, deletes.',
    `Mandate ${terms.id}. You can stop it at any time; stopping needs no fingerprint.`,
  ]
}

const perDayOf = (value: unknown): MandatePerDay | null => {
  if (!record(value) || MANDATE_KINDS.some(kind => !Number.isSafeInteger(value[kind]) || (value[kind] as number) < 0)) return null
  return Object.fromEntries(MANDATE_KINDS.map(kind => [kind, value[kind] as number])) as unknown as MandatePerDay
}

/** Read HEAD's answer strictly; anything unexpected is "no mandate", never "active". */
export function parseMandateStatus(answer: unknown): MandateStatus | null {
  if (!record(answer) || answer.ok !== true || !record(answer.mandate)) return null
  const mandate = answer.mandate
  const terms = mandate.terms
  if (!record(terms) || terms.schema !== MANDATE_SCHEMA || typeof terms.id !== 'string' || !Number.isSafeInteger(terms.expiresAt)
    || !Array.isArray(terms.scopes) || perDayOf(terms.perDay) === null || !Array.isArray(mandate.plainWords)
    || !['active', 'expired', 'revoked'].includes(String(mandate.state))) return null
  return { state: mandate.state as MandateStatus['state'], terms: terms as unknown as MandateTerms,
    plainWords: mandate.plainWords.filter((line): line is string => typeof line === 'string'), today: perDayOf(answer.today) }
}

/** Said in one plain line when HEAD refuses the issue time (MANDATE_ISSUED_AT_REFUSED). */
export const MANDATE_CLOCK_OFF = 'Not given: the clock of this computer is more than 10 minutes off. Set it right, then approve again.'

export type MandateOutcome =
  | { readonly kind: 'granted'; readonly words: string; readonly status: MandateStatus }
  | { readonly kind: 'refused'; readonly words: string }

/**
 * Ask the passkey for exactly these terms and send them.
 * @returns what happened, in words for the owner.
 */
export async function approveMandate(terms: MandateTerms, origin: string, deps: Class3Dependencies,
  fetchImpl: typeof fetch = globalThis.fetch): Promise<MandateOutcome> {
  const body = { action: 'issue', terms }
  const action = await class3Action({ audience: origin, method: 'POST', pathname: MANDATE_ROUTE, body })
  const approval = await approveClass3(action, deps)
  if (!approval.ok) return { kind: 'refused', words: `Not given: the passkey approval did not complete (${approval.reason}).` }
  const sent = await sendApprovedClass3(approval, body, deps.signal, fetchImpl)
  const status = parseMandateStatus(sent.body)
  if (sent.status === 200 && status?.state === 'active') return { kind: 'granted', words: 'Given.', status }
  const code = typeof sent.body?.code === 'string' ? sent.body.code : `HTTP ${String(sent.status)}`
  // The terms are made at the tap, so this refusal means the page's clock and HEAD's differ by more than 10 minutes.
  if (code === 'MANDATE_ISSUED_AT_REFUSED') return { kind: 'refused', words: MANDATE_CLOCK_OFF }
  return { kind: 'refused', words: `Not given: HEAD refused it (${code}).` }
}

/** Stop the mandate now. Stopping only removes authority, so no passkey is asked. */
export async function stopMandate(id: string, signal: AbortSignal, fetchImpl: typeof fetch = globalThis.fetch): Promise<boolean> {
  const response = await fetchImpl(MANDATE_ROUTE, { method: 'POST', credentials: 'same-origin', cache: 'no-store',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'revoke', id }), signal })
  const answer: unknown = await response.json().catch(() => null)
  return response.status === 200 && record(answer) && answer.ok === true
}

/** Read the current mandate: its status, 'none' when HEAD holds none, or null when unknown (never shown as fine). */
export async function readMandate(signal: AbortSignal, fetchImpl: typeof fetch = globalThis.fetch): Promise<MandateStatus | 'none' | null> {
  const response = await fetchImpl(MANDATE_ROUTE, { method: 'GET', credentials: 'same-origin', cache: 'no-store', signal })
  if (response.status !== 200) return null
  const answer: unknown = await response.json().catch(() => null)
  if (record(answer) && answer.ok === true && answer.mandate === null) return 'none'
  return parseMandateStatus(answer)
}
