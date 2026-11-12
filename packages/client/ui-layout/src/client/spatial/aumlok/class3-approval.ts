// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The Aukora authors
/**
 * CLASS 3, APPROVED BY THE BOUND PASSKEY, ON THE EXACT BYTES (Round 22).
 *
 * A Class 3 action is approved here and nowhere else in the page (today only an owner grant for a mandate, from the Work
 * view; a governance-organ publish would need its own publish body, which the page does not hold):
 *
 *   1. the exact request is bound: {schema 'aukora.class3.action.v1', audience (this origin), method, pathname,
 *      bodySha256 = SHA-256 of the canonical JSON of the body}, the same binding the host recomputes from the request it
 *      receives (`aumlokClass3Binding`, deploy/cloudflare/src/aumlok.mjs);
 *   2. the host's AUMLOK `approve` challenge is asked for that binding, and must echo it exactly;
 *   3. the bound passkey asserts the challenge (Touch ID / Face ID, user verification required);
 *   4. the host answers a single-use approval for that binding only, which the request then carries in the
 *      `x-x6-class3-approval` header. Any other body, path, method or origin is refused by the host.
 *
 * No private key is used or held here, and none is needed in the Worker: the passkey is the owner's presence, and the
 * host checks it. What it proves: the bound passkey's holder approved these bytes on this origin, once. It is not an
 * owner signature a third party can check offline (that is the hybrid v2 envelope, Lanes 2-3).
 * @module aumlok/class3-approval
 */
import { hostCall, type HostAnswer } from '../apps/identity/host.ts'
import { fromBase64url, passkeyFailure, readChallenge } from '../apps/identity/webauthn.ts'
import { AUMLOK_ROUTES, aumlokRequestId, browserPlatform, type AumlokHostCall, type AumlokPlatform } from './aumlok-ceremony.ts'
import type { HeadPromotionBinding } from './head-promotion.ts'

export const CLASS3_ACTION_SCHEMA = 'aukora.class3.action.v1'
export const CLASS3_APPROVAL_HEADER = 'x-x6-class3-approval'

/** One exact request, as the host binds it. */
export interface Class3Action {
  readonly schema: typeof CLASS3_ACTION_SCHEMA
  readonly audience: string
  readonly method: 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  readonly pathname: string
  readonly bodySha256: string
}

/**
 * Canonical JSON exactly as the host writes it (`owner-grant-policy.mjs` canonicalJson): object keys sorted, undefined
 * members dropped, undefined array items as null, everything else as JSON.stringify writes it.
 * @param value - parsed JSON.
 * @returns the canonical text.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item === undefined ? null : item)).join(',')}]`
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).filter(key => record[key] !== undefined).sort()
  return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`
}

const sha256Hex = async (text: string): Promise<string> =>
  [...new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))]
    .map(byte => byte.toString(16).padStart(2, '0')).join('')

/** One request to bind: where it goes, how, and its parsed JSON body. */
export interface Class3Request {
  readonly audience: string
  readonly method: Class3Action['method']
  readonly pathname: string
  readonly body: unknown
}

/**
 * The binding of one request.
 * @param request - the origin it goes to, its method and path, and its parsed JSON body.
 * @returns the binding the host recomputes.
 */
export async function class3Action(request: Class3Request): Promise<Class3Action> {
  return { schema: CLASS3_ACTION_SCHEMA, audience: request.audience, method: request.method, pathname: request.pathname,
    bodySha256: await sha256Hex(canonicalJson(request.body)) }
}

/** What the passkey approves: one exact request (`class3Action`), or one exact HEAD promotion (`head-promotion.ts`). */
export type Class3Binding = Class3Action | HeadPromotionBinding

export type Class3Approval<B extends Class3Binding = Class3Action> =
  | {
    readonly ok: true
    readonly token: string
    readonly expiresAt: number
    readonly action: B
    /** Time left when the host answered, on the host's own clock (`approvedAt`, else the status's `lastVerifiedAt`). */
    readonly hostRemainingMs: number
    /** When this page received the answer (`performance.now()`), to subtract the time since on this page's own clock. */
    readonly receivedAt: number
  }
  | { readonly ok: false; readonly reason: string }

export interface Class3Dependencies {
  readonly call?: AumlokHostCall
  readonly platform?: AumlokPlatform
  readonly signal: AbortSignal
}
const codeOf = (answer: HostAnswer): string => (answer.kind === 'refused' ? `class3:${answer.code}` : 'class3:route-absent')

/**
 * Ask the bound passkey to approve one exact request.
 * @param action - the binding (`class3Action`).
 * @param deps - the host call, the passkey, and the abort signal.
 * @returns a single-use approval for exactly that binding, or why not.
 */
export async function approveClass3<B extends Class3Binding>(action: B, deps: Class3Dependencies): Promise<Class3Approval<B>> {
  const call = deps.call ?? hostCall
  const platform = deps.platform ?? browserPlatform
  const blocker = platform.passkeyBlocker()
  if (blocker !== null) return { ok: false, reason: `class3:no-passkey-here ${blocker}`.slice(0, 160) }
  const challenge = await call(AUMLOK_ROUTES.challenge, deps.signal, { purpose: 'approve', requestId: aumlokRequestId(), binding: action })
  if (challenge.kind !== 'live') return { ok: false, reason: codeOf(challenge) }
  // THE PASSKEY IS ASKED ONLY FOR THE BINDING THIS PAGE MADE: an echo that differs in any byte asks for nothing.
  if (canonicalJson(challenge.body.binding) !== canonicalJson(action)) return { ok: false, reason: 'class3:binding-mismatch' }
  try {
    const assert = readChallenge('verify', challenge.body)
    const asserted = await platform.passkey(assert, deps.signal)
    const done = await call(AUMLOK_ROUTES.approve, deps.signal, { challengeId: assert.ceremonyId, credential: {
      id: asserted.id, rawId: asserted.rawId, type: asserted.type, response: asserted.response, clientExtensionResults: {},
      ...(asserted.authenticatorAttachment === 'platform' || asserted.authenticatorAttachment === 'cross-platform'
        ? { authenticatorAttachment: asserted.authenticatorAttachment } : {}),
    } })
    if (done.kind !== 'live') return { ok: false, reason: codeOf(done) }
    const token = done.body.approvalToken
    const expiresAt = done.body.expiresAt
    if (typeof token !== 'string' || fromBase64url(token)?.length !== 32 || typeof expiresAt !== 'number' || !Number.isSafeInteger(expiresAt)
      || canonicalJson(done.body.binding) !== canonicalJson(action)) return { ok: false, reason: 'class3:unexpected-answer' }
    const hostNow = typeof done.body.approvedAt === 'number' ? done.body.approvedAt : done.body.lastVerifiedAt
    return { ok: true, token, expiresAt, action, receivedAt: performance.now(),
      hostRemainingMs: expiresAt - (typeof hostNow === 'number' && Number.isSafeInteger(hostNow) ? hostNow : Date.now()) }
  } catch (error) {
    return { ok: false, reason: deps.signal.aborted ? 'class3:closed' : `class3:passkey ${passkeyFailure(error)}`.slice(0, 160) }
  }
}

/** What the host answered the approved request: its HTTP status and JSON body (or null when it was not JSON). */
export interface Class3Sent {
  readonly status: number
  readonly body: Record<string, unknown> | null
}

/**
 * Send the approved request: the same method, path and body the approval binds, with the approval in its header.
 * @param approval - a successful approval.
 * @param body - the exact body the approval binds.
 * @param signal - aborts the request.
 * @param fetchImpl - the page's fetch (tests pass their own).
 * @returns the host's answer.
 */
export async function sendApprovedClass3(approval: Extract<Class3Approval, { ok: true }>, body: unknown, signal: AbortSignal,
  fetchImpl: typeof fetch = globalThis.fetch): Promise<Class3Sent> {
  const response = await fetchImpl(approval.action.pathname, {
    method: approval.action.method,
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { 'content-type': 'application/json', [CLASS3_APPROVAL_HEADER]: approval.token },
    body: JSON.stringify(body),
    signal,
  })
  const text = await response.text()
  let parsed: unknown = null
  try { parsed = JSON.parse(text) } catch { parsed = null }
  return { status: response.status, body: parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null }
}
