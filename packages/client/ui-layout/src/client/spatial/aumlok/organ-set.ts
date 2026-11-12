// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The Aukora authors
/**
 * ADDING ORDINARY ORGANS WITH ONE TOUCH ID, ON THE EXACT LIST.
 *
 * When the Pearl HEAD holds only ADDS ordinary organs (no governance organ, no declaration, nothing else changed), HEAD
 * records the exact request body a passkey approves (`aukora.head-organ-set.v1`, owner-grant-policy.mjs
 * `organSetPromotionBody`). This page:
 *   1. recomputes that body itself, from the published head and the staged bytes HEAD serves (every module's SHA-256 and
 *      UTF-8 length checked here), and offers it only when it equals HEAD's record byte for byte;
 *   2. shows every organ it adds, by id, module sha and size;
 *   3. at the click binds exactly that body (`class3Action` on POST /_head/promote), asks the passkey, and sends it.
 * The organs stay ordinary: none is declared governance, so their later updates need no tap of their own.
 * @module aumlok/organ-set
 */
import { approveClass3, canonicalJson, class3Action, type Class3Dependencies } from './class3-approval.ts'
import {
  HEAD_PROMOTE_PATH, isGovernanceEntry, parseHeadStaged, promoteStagedOnHead, PROMOTION_STATUS_MAX_BYTES, PROMOTION_STATUS_PATH,
  verifiedModuleCode, type PromotionOutcome,
} from './head-promotion.ts'

export const ORGAN_SET_SCHEMA = 'aukora.head-organ-set.v1'
export const ORGAN_SET_MAX = 8
/** The only root fields of the manifest that may differ from the published Pearl's (deploy/cloudflare/src/organ-set-rule.mjs). */
export const ROOT_FIELDS_MAY_DIFFER: readonly string[] = ['entries', 'modules', 'epoch', 'parentBallId', 'ballId', 'createdAt', 'authorPeerId']

export interface OrganSetOrgan {
  readonly organId: string
  readonly sha256: string
  readonly bytes: number
}

/** The exact body a passkey approves (field names and order as HEAD builds it; the binding hashes canonical JSON). */
export interface OrganSetBody {
  readonly schema: typeof ORGAN_SET_SCHEMA
  readonly ballId: string
  readonly epoch: number
  readonly parentBallId: string | null
  readonly organs: readonly OrganSetOrgan[]
}

export type OrganSetRead =
  | { readonly kind: 'none' }
  | { readonly kind: 'offer'; readonly body: OrganSetBody }
  /** HEAD holds an organ set this page cannot confirm: shown with the reason, never offered. */
  | { readonly kind: 'blocked'; readonly why: string; readonly claimed: Readonly<Record<string, unknown>> | null }
  | { readonly kind: 'unread'; readonly why: string }

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const HEX_64 = /^[0-9a-f]{64}$/

/**
 * Recompute the organ-set body from the published manifest and the staged one, by HEAD's rule.
 * @returns the body, or why the Pearl is not a pure addition of ordinary organs this page can confirm.
 */
export async function organSetBodyOf(input: {
  readonly published: Readonly<Record<string, unknown>>
  readonly staged: Readonly<Record<string, unknown>>
  readonly codeBySha: Readonly<Record<string, unknown>> | null
  /** The published Pearl's own module code (`GET /_head/ball` codeBySha): an added organ may reuse a published module. */
  readonly publishedCode?: Readonly<Record<string, unknown>> | null
}): Promise<OrganSetBody | string> {
  const { published, staged } = input
  if (!isRecord(published.entries) || !isRecord(published.modules) || !isRecord(staged.entries) || !isRecord(staged.modules)) return 'a manifest was not readable'
  // HEAD's shared rule (deploy/cloudflare/src/organ-set-rule.mjs), copied; the shared vectors keep the two equal (organ-set.client.spec).
  for (const key of new Set([...Object.keys(published), ...Object.keys(staged)])) {
    if (ROOT_FIELDS_MAY_DIFFER.includes(key)) continue
    if (Object.hasOwn(published, key) !== Object.hasOwn(staged, key) || canonicalJson(published[key]) !== canonicalJson(staged[key])) {
      return `it also changes the Pearl's ${key}`
    }
  }
  if (staged.parentBallId !== published.ballId || staged.epoch !== Number(published.epoch) + 1) return 'it does not extend the published Pearl'
  const before = published.entries, after = staged.entries
  for (const id of Object.keys(before)) {
    if (!Object.hasOwn(after, id) || canonicalJson(before[id]) !== canonicalJson(after[id])) return `it also changes or removes ${id}`
  }
  for (const sha of Object.keys(published.modules)) {
    if (!Object.hasOwn(staged.modules, sha) || canonicalJson(published.modules[sha]) !== canonicalJson(staged.modules[sha])) return 'it changes a published module'
  }
  const added = Object.keys(after).filter(id => !Object.hasOwn(before, id)).sort()
  if (added.length === 0) return 'it adds no organ'
  if (added.length > ORGAN_SET_MAX) return `it adds ${String(added.length)} organs; one approval covers at most ${String(ORGAN_SET_MAX)}`
  const organs: OrganSetOrgan[] = []
  for (const id of added) {
    const entry = after[id]
    if (!/^[a-z][a-z0-9-]{0,40}$/.test(id) || !isRecord(entry)) return `${id} is not an organ this page can read`
    if (isGovernanceEntry(id, entry)) return `${id} is a governance organ (one per approval, on the governance card)`
    if (entry.disabled !== false) return `${id} would be added disabled`
    // HEAD's add shape (owner-grant-policy.mjs ordinaryAddShapeOk): no settings, no undo history of its own.
    const fields = ['id', 'specifier', 'disabled', 'config', 'previousSpecifiers', 'previousVersions', 'updatedAt']
    if (Object.keys(entry).some(key => !fields.includes(key)) || entry.id !== id
      || !isRecord(entry.config) || Object.keys(entry.config).length > 0
      || !Array.isArray(entry.previousSpecifiers) || entry.previousSpecifiers.length > 0
      || (entry.previousVersions !== undefined && (!Array.isArray(entry.previousVersions) || entry.previousVersions.length > 0))
      || (entry.updatedAt !== undefined && !(typeof entry.updatedAt === 'number' && Number.isSafeInteger(entry.updatedAt) && entry.updatedAt >= 0))) {
      return `${id} would be added with settings or an undo history of its own`
    }
    const specifier = typeof entry.specifier === 'string' ? entry.specifier : ''
    if (!/^ball:[0-9a-f]{64}$/.test(specifier) || !Object.hasOwn(staged.modules, specifier.slice(5))) return `${id} names no module the Pearl carries`
    // Its bytes: staged code for a new module, else the published Pearl's own (both checked against the sha here).
    const code = await verifiedModuleCode(input.codeBySha, specifier.slice(5))
      ?? await verifiedModuleCode(input.publishedCode ?? null, specifier.slice(5))
    if (code === null) return `${id}'s module bytes were not served, or do not hash to its sha`
    organs.push({ organId: id, sha256: specifier.slice(5), bytes: new TextEncoder().encode(code).byteLength })
  }
  // Every new module is run by exactly one added organ, and names itself: no unlisted module rides along.
  const owners = new Map<string, number>()
  for (const organ of organs) {
    if (!Object.hasOwn(published.modules, organ.sha256)) owners.set(organ.sha256, (owners.get(organ.sha256) ?? 0) + 1)
  }
  for (const sha of Object.keys(staged.modules)) {
    if (Object.hasOwn(published.modules, sha)) continue
    const meta = staged.modules[sha]
    if (owners.get(sha) !== 1 || !isRecord(meta) || meta.sha256 !== sha || meta.specifier !== `ball:${sha}`) return 'it carries a module no listed organ runs'
    // A size is never trusted (shared rule): a declared size must equal the verified bytes counted above.
    const verified = organs.find(organ => organ.sha256 === sha)?.bytes
    if (Object.hasOwn(meta, 'size') && meta.size !== verified) return `a module declares ${String(meta.size)} bytes, but its verified code is ${String(verified)}`
  }
  if (typeof staged.ballId !== 'string' || !HEX_64.test(staged.ballId) || typeof staged.epoch !== 'number') return 'the Pearl has no id'
  return { schema: ORGAN_SET_SCHEMA, ballId: staged.ballId, epoch: staged.epoch,
    parentBallId: typeof staged.parentBallId === 'string' ? staged.parentBallId : null, organs }
}

/**
 * What HEAD holds, as an organ set this page can offer.
 * @param signal - aborts the reads.
 * @param fetchImpl - the page's fetch (tests pass their own).
 */
export async function readOrganSet(signal: AbortSignal, fetchImpl: typeof fetch = globalThis.fetch): Promise<OrganSetRead> {
  let raw: unknown
  try {
    const response = await fetchImpl(PROMOTION_STATUS_PATH, { credentials: 'same-origin', cache: 'no-store', signal })
    if (response.status === 404 || response.status === 501) return { kind: 'none' }
    if (!response.ok) return { kind: 'unread', why: `HEAD answered ${String(response.status)}` }
    const text = await response.text()
    if (text.length > PROMOTION_STATUS_MAX_BYTES) return { kind: 'unread', why: 'HEAD\'s answer was too large' }
    raw = JSON.parse(text)
  } catch {
    return { kind: 'unread', why: 'HEAD did not answer in a form this page reads' }
  }
  const parsed = await parseHeadStaged(raw)
  if (parsed.kind !== 'staged') return parsed.kind === 'unread' ? { kind: 'unread', why: parsed.why } : { kind: 'none' }
  const claimed = parsed.record.organSet ?? null
  if (claimed === null) return { kind: 'none' }
  const promotion = parsed.record.promotion
  if (promotion === null) return { kind: 'blocked', why: 'HEAD served no staged bytes for it, so its organs cannot be checked here', claimed }
  let published: unknown
  try {
    const response = await fetchImpl('/_head/ball', { credentials: 'same-origin', cache: 'no-store', signal })
    published = response.ok ? await response.json() : null
  } catch { published = null }
  const head = isRecord(published) && isRecord(published.ball) ? published.ball : published
  if (!isRecord(head)) return { kind: 'blocked', why: 'the published Pearl was not read, so the change cannot be checked', claimed }
  const stagedBall = promotion.body.ball
  const codeBySha = isRecord(promotion.body.codeBySha) ? promotion.body.codeBySha : null
  const publishedCode = isRecord(published) && isRecord(published.codeBySha) ? published.codeBySha : null
  const computed = isRecord(stagedBall) ? await organSetBodyOf({ published: head, staged: stagedBall, codeBySha, publishedCode })
    : 'the staged Pearl was not readable'
  if (typeof computed === 'string') return { kind: 'blocked', why: computed, claimed }
  if (canonicalJson(computed) !== canonicalJson(claimed)) {
    return { kind: 'blocked', why: 'HEAD\'s list differs from the list this page computes from the staged bytes, so nothing is asked', claimed }
  }
  return { kind: 'offer', body: computed }
}

/** Whether two organ-set bodies are the same request, byte for byte (canonical JSON): the card and the chat card both use it. */
export function sameOrganSet(a: OrganSetBody, b: OrganSetBody): boolean {
  return canonicalJson(a) === canonicalJson(b)
}

/** One organ as the owner reads it. */
export function organWords(organ: OrganSetOrgan): string {
  return `${organ.organId} · module ${organ.sha256.slice(0, 12)}… · ${String(organ.bytes)} bytes`
}

/**
 * Ask the passkey for exactly this body, then have HEAD promote the Pearl it holds with it.
 * @returns HEAD's outcome, or why nothing was sent.
 */
export async function approveOrganSet(body: OrganSetBody, origin: string, deps: Class3Dependencies,
  fetchImpl: typeof fetch = globalThis.fetch): Promise<PromotionOutcome | { readonly kind: 'not-approved'; readonly reason: string }> {
  const action = await class3Action({ audience: origin, method: 'POST', pathname: HEAD_PROMOTE_PATH, body })
  const approval = await approveClass3(action, deps)
  if (!approval.ok) return { kind: 'not-approved', reason: approval.reason }
  const sent: Readonly<Record<string, unknown>> = { ...body }
  return promoteStagedOnHead({ ballId: body.ballId, token: approval.token, body: sent, signal: deps.signal,
    approvalLeftMs: () => approval.hostRemainingMs - (performance.now() - approval.receivedAt), fetchImpl })
}
