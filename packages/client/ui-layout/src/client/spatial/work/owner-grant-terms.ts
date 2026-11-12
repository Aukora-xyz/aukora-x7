// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The Aukora authors
/**
 * WHETHER THE HOST WOULD REFUSE THESE OWNER-GRANT TERMS, CHECKED BEFORE ANY PASSKEY IS ASKED FOR (Round 22 review).
 *
 * The edge validates the seven terms (`normalizeOwnerGrantBinding` and its governance rule, deploy/cloudflare/src/
 * owner-grant-policy.mjs) only AFTER the passkey has approved their hash. A body it refuses would spend a Touch ID, a
 * challenge slot and, on some hosts, a counted failure for a certain refusal. This is the same pure check (term rules,
 * the bounded copy's size, depth and node limits, and the 16 KiB preimage cap), so the sheet can say why and offer no
 * approval. It decides nothing: the host still checks everything, and this only ever refuses earlier, never accepts on
 * the host's behalf. Its parity with the host's own function is a test.
 * @module work/owner-grant-terms
 */
import { canonicalJson } from '../aumlok/class3-approval.ts'
import { GOVERNANCE_ORGANS as HEAD_GOVERNANCE_ORGANS } from '../aumlok/head-promotion.ts'

/** The seven terms an owner grant covers, in the host's field order. */
export interface OwnerGrantTerms {
  readonly mandateId: string
  readonly ticketId: string | null
  readonly scope: Record<string, unknown> | null
  readonly ballId: string
  readonly epoch: number
  readonly expiresAt: number | null
  readonly identity: string
}

/**
 * Organs a standing grant may not cover without a candidate digest, a ticket and an expiry (`OWNER_GOVERNANCE_ORGANS`):
 * the one list HEAD uses for both, eight organs since Round 24 (F1).
 */
export const GOVERNANCE_ORGANS: readonly string[] = HEAD_GOVERNANCE_ORGANS
const REJECTED_IDENTITIES = new Set(['spatial-tab', 'agent', 'agent-self-unverified', 'person'])
const HEX_64 = /^[0-9a-f]{64}$/u
const label = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 200 && value.trim() === value && value.trim().length > 0
const plain = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}
/** The host's owner-grant body cap (`OWNER_GRANT_MAX_BODY_BYTES`). */
const MAX_BYTES = 16 * 1024
const utf8 = (text: string): number => new TextEncoder().encode(text).length

class Refused extends Error {
  constructor(readonly code: string) { super(code) }
}
const refuse = (code: string): never => { throw new Refused(code) }

/** The host's bounded copy (`boundedJsonCopy`): at most 1024 nodes, depth 16, 16 KiB of keys and strings, plain JSON. */
function bounded(value: unknown, budget: { nodes: number; bytes: number; readonly seen: Set<object> }, depth = 0): void {
  budget.nodes += 1
  if (budget.nodes > 1024 || depth > 16) refuse('OWNER_GRANT_TOO_COMPLEX')
  if (value === null || typeof value === 'boolean') return
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) refuse('OWNER_GRANT_INVALID_SCOPE')
    return
  }
  if (typeof value === 'string') {
    budget.bytes += utf8(value)
    if (budget.bytes > MAX_BYTES) refuse('REQUEST_BODY_TOO_LARGE')
    return
  }
  if (!Array.isArray(value) && !plain(value)) return refuse('OWNER_GRANT_INVALID_SCOPE')
  const node = value as object
  if (budget.seen.has(node)) refuse('OWNER_GRANT_INVALID_SCOPE')
  budget.seen.add(node)
  const descriptors = Object.getOwnPropertyDescriptors(node) as Record<string | symbol, PropertyDescriptor>
  const keys = Reflect.ownKeys(descriptors)
  if (keys.length > 1024 - budget.nodes) refuse('OWNER_GRANT_TOO_COMPLEX')
  if (Array.isArray(node) && (node.length > 1024 || keys.length !== node.length + 1)) refuse('OWNER_GRANT_INVALID_SCOPE')
  for (const key of keys) {
    if (Array.isArray(node) && key === 'length') continue
    if (typeof key !== 'string') return refuse('OWNER_GRANT_INVALID_SCOPE')
    const descriptor = descriptors[key]
    if (descriptor?.enumerable !== true || !Object.hasOwn(descriptor, 'value')) refuse('OWNER_GRANT_INVALID_SCOPE')
    budget.bytes += utf8(key)
    if (budget.bytes > MAX_BYTES) refuse('REQUEST_BODY_TOO_LARGE')
    if (Array.isArray(node) && (!/^(0|[1-9][0-9]*)$/u.test(key) || Number(key) >= node.length)) refuse('OWNER_GRANT_INVALID_SCOPE')
    bounded(descriptor?.value, budget, depth + 1)
  }
  budget.seen.delete(node)
}

function selectors(scope: Record<string, unknown>, field: string): readonly string[] {
  if (!Object.hasOwn(scope, field)) return []
  const values = scope[field]
  if (!Array.isArray(values) || values.some(value => !label(value) || /[\u0000-\u001f\u007f]/u.test(value))) refuse('OWNER_GRANT_INVALID_SCOPE')
  const list = values as string[]
  if (list.some(value => /[*?[\]{}!]/u.test(value))) refuse('OWNER_GRANT_EXPLICIT_SCOPE_REQUIRED')
  return list
}
function organOfPath(value: string): string {
  const match = /^(?:\/dsh\/home\/auma\/seed\/organs\/|mirror\/home\/auma\/seed\/organs\/)([a-z][a-z0-9-]{0,40})\.js$/u.exec(value)
  return match?.[1] ?? refuse('OWNER_GRANT_EXPLICIT_SCOPE_REQUIRED')
}

/**
 * The host's refusal code for these terms, or null when the host's own checks would let them through.
 * @param terms - the seven terms exactly as they would be sent.
 * @param now - the time the host would check expiry against (ms).
 * @returns the code the host would answer, or null.
 */
export function ownerGrantRefusal(terms: OwnerGrantTerms, now: number): string | null {
  try {
    if (!label(terms.mandateId)) refuse('OWNER_GRANT_INVALID_MANDATE')
    if (terms.ticketId !== null && !label(terms.ticketId)) refuse('OWNER_GRANT_INVALID_TICKET')
    if (!HEX_64.test(terms.ballId)) refuse('OWNER_GRANT_INVALID_BALL')
    if (!Number.isSafeInteger(terms.epoch) || Object.is(terms.epoch, -0) || terms.epoch < 0) refuse('OWNER_GRANT_INVALID_EPOCH')
    if (terms.expiresAt !== null && (!Number.isFinite(terms.expiresAt) || Object.is(terms.expiresAt, -0) || terms.expiresAt <= now)) {
      refuse('OWNER_GRANT_INVALID_EXPIRY')
    }
    if (terms.identity.length > 200 || terms.identity.trim() === '' || REJECTED_IDENTITIES.has(terms.identity.trim().toLowerCase())) {
      refuse('OWNER_GRANT_IDENTITY_REJECTED')
    }
    const scope = terms.scope
    if (scope !== null && !plain(scope)) refuse('OWNER_GRANT_INVALID_SCOPE')
    if (scope !== null) bounded(scope, { nodes: 0, bytes: 0, seen: new Set() })
    if (scope !== null && Object.hasOwn(scope, 'expiresAt') && scope.expiresAt !== terms.expiresAt) refuse('OWNER_GRANT_INVALID_EXPIRY')
    if (scope === null) return refuse('OWNER_GRANT_EXPLICIT_SCOPE_REQUIRED')
    const organs = [...selectors(scope, 'organs')]
    // ONE NAMED ORGAN (`scope.organ`, host since an earlier commit): well-formed, the same as `organs` when both are given, and a
    // target of its own when `organs` is empty, in the host's own order.
    if (Object.hasOwn(scope, 'organ') && (typeof scope.organ !== 'string' || !/^[a-z][a-z0-9-]{0,40}$/u.test(scope.organ))) {
      refuse('OWNER_GRANT_INVALID_SCOPE')
    }
    if (typeof scope.organ === 'string' && organs.length > 0 && (organs.length !== 1 || organs[0] !== scope.organ)) refuse('OWNER_GRANT_INVALID_SCOPE')
    if (typeof scope.organ === 'string' && organs.length === 0) organs.push(scope.organ)
    const paths = selectors(scope, 'paths')
    selectors(scope, 'tools')
    if (organs.some(value => !/^[a-z][a-z0-9-]{0,40}$/u.test(value))) refuse('OWNER_GRANT_INVALID_SCOPE')
    const pathOrgans = paths.map(organOfPath)
    if (organs.length === 0 && pathOrgans.length === 0) refuse('OWNER_GRANT_EXPLICIT_SCOPE_REQUIRED')
    if (Object.hasOwn(scope, 'candidateSha256') && (typeof scope.candidateSha256 !== 'string' || !HEX_64.test(scope.candidateSha256))) {
      refuse('OWNER_GRANT_INVALID_CANDIDATE')
    }
    const targets = new Set([...organs, ...pathOrgans].filter(organ => GOVERNANCE_ORGANS.includes(organ)))
    if (targets.size > 0) {
      const [target] = targets
      if (targets.size !== 1 || organs.some(organ => organ !== target) || pathOrgans.some(organ => organ !== target)) {
        refuse('OWNER_GRANT_EXPLICIT_SCOPE_REQUIRED')
      }
      if (typeof scope.candidateSha256 !== 'string' || terms.ticketId === null || terms.expiresAt === null) refuse('OWNER_GRANT_GOVERNANCE_BINDING_REQUIRED')
    }
    // The signed preimage itself is capped (`ownerGrantCanonical`).
    const preimage = canonicalJson({ schema: 'aukora.x6.owner-grant.v1', mandateId: terms.mandateId, ticketId: terms.ticketId, scope,
      ballId: terms.ballId, epoch: terms.epoch, expiresAt: terms.expiresAt, identity: terms.identity })
    if (utf8(preimage) > MAX_BYTES) refuse('REQUEST_BODY_TOO_LARGE')
    return null
  } catch (error) {
    if (error instanceof Refused) return error.code
    throw error
  }
}
