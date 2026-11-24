// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The Aukora authors
/**
 * AUMA'S OUTWARD CLASS 3 REQUESTS, APPROVED BY TOUCH ID ON THE EXACT BYTES.
 *
 * When the edge will not post Auma's GitHub issue or comment without the owner's passkey, her worker stages the exact
 * request at `STAGED_OUTWARD_PATH` (`ball-loader.ts` `stageOutward`). This page:
 *
 *   1. reads it strictly: one POST to `/_host/github` (or `/_host/repo`, or `/_host/cloudflare` with the reason the edge
 *      held it: the Cloudflare door, or `/_host/linear` for her Linear door's core: the Linear card), with a JSON body, nothing else;
 *   2. shows the owner what those bytes do, in words, with the full text;
 *   3. at his click reads the file again, and asks only if it is still the same request;
 *   4. binds exactly that request (`class3Action`), asks the passkey for it (`approveClass3`), and sends it
 *      (`sendApprovedClass3`), so the host checks the same path, method and body hash it approved. For Cloudflare the
 *      request approved and sent is her staged body with the edge's reason in it: the
 *      reason he read is inside the bytes his fingerprint covers, and the edge refuses it if its reason changed since.
 *
 * A GitHub post has no idempotency key, so a request this page has sent is remembered and not offered again.
 * @module aumlok/outward-class3
 */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkReader } from '../work/WorkSurface.tsx'
import { approveClass3, canonicalJson, class3Action, sendApprovedClass3, type Class3Dependencies, type Class3Sent } from './class3-approval.ts'

export const STAGED_OUTWARD_PATH = '/dsh/home/auma/staged/outward-class3.json'
export const STAGED_OUTWARD_SCHEMA = 'aukora.staged-outward-class3.v1'
export const STAGED_OUTWARD_MAX_BYTES = 256 * 1024
/** A live change to the staged file (`changedPaths` name it with or without the `/dsh` root). */
export const STAGED_OUTWARD_CHANGE = /(?:^|\/)home\/auma\/staged\/outward-class3\.json$/u

const REPOSITORY = 'repos/your_org_x/your-node'
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)

type CloudflareFamily = 'P1' | 'P2' | 'P3' | 'P4' | 'account-wide-unclassified'
/** One reason the edge gave: its family and its reason word. */
export interface CloudflareReason {
  readonly family: CloudflareFamily
  readonly reason: string
}
/** Why the edge held a Cloudflare write for the passkey (deploy/cloudflare/src/cloudflare-door.mjs families). */
export interface CloudflareProtection extends CloudflareReason {
  /** For `account-wide-unclassified`: the Cloudflare family it names (e.g. `load_balancers`, `workers/dispatch`). */
  readonly apiFamily?: string
  /** Every other reason that matched, 1 to 8, sorted, never the primary pair; absent when none. */
  readonly also?: readonly CloudflareReason[]
}

/** One staged request, as read. */
export interface StagedOutward {
  readonly tool: 'x6_github' | 'x6_repo' | 'x6_cloudflare' | 'x6_linear' // x6_linear
  readonly pathname: '/_host/github' | '/_host/repo' | '/_host/cloudflare' | '/_host/linear' // /_host/linear
  readonly method: 'POST'
  readonly body: Record<string, unknown>
  readonly stagedAt: number
  /**
   * The request the passkey approves and the page sends. GitHub, repo and Linear: `body` itself. Cloudflare (the door's contract section
   * 3): `{ ...body, expect: protection }`, so the reason he reads is part of the bytes he approves.
   */
  readonly approved: Record<string, unknown>
  /** `canonicalJson(approved)`: the text the host hashes. Two reads are the same request when this matches. */
  readonly canonical: string
  /** Cloudflare only: why it needs his fingerprint, exactly as staged (every member); it is `approved.expect`. */
  readonly protection?: CloudflareProtection
}

const ISSUE_POST = /^\/?repos\/your_org_x\/your-node\/issues(?:\/([1-9][0-9]{0,8})\/comments)?$/u
const said = (value: unknown, max: number): boolean => typeof value === 'string' && value.trim() !== '' && value.length <= max
/**
 * Only the one request this card describes: `x6_github` `api` POST opening an issue (`{ title, body }`) or commenting on
 * one (`{ body }`) in this repository, nothing else in it. Anything else is not offered, so the words the owner reads are
 * always what the request does.
 */
function postable(body: Record<string, unknown>): boolean {
  if (Object.keys(body).some(key => !['action', 'method', 'endpoint', 'body'].includes(key))) return false
  if (body.action !== 'api' || body.method !== 'POST' || typeof body.endpoint !== 'string' || !record(body.body)) return false
  const match = body.endpoint.match(ISSUE_POST)
  if (match === null) return false
  const post = body.body
  if (match[1] !== undefined) return Object.keys(post).length === 1 && said(post.body, 65_536)
  return Object.keys(post).every(key => key === 'title' || key === 'body') && said(post.title, 256) && !/[\r\n]/u.test(String(post.title))
    && said(post.body, 65_536)
}

/** Her Cloudflare write the edge held for the passkey (`x6_cloudflare` `api`, deploy/cloudflare/src/cloudflare-door.mjs). */
const CLOUDFLARE_KEYS = ['action', 'method', 'path', 'query', 'body', 'bodyKind', 'contentType', 'parts']
function cloudflarePostable(body: Record<string, unknown>): boolean {
  return Object.keys(body).every(key => CLOUDFLARE_KEYS.includes(key)) && body.action === 'api'
    && typeof body.method === 'string' && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(body.method.toUpperCase())
    && typeof body.path === 'string' && body.path.startsWith('/')
    && (body.parts === undefined || (Array.isArray(body.parts) && body.parts.every(record)))
}
const FAMILIES: readonly string[] = ['P1', 'P2', 'P3', 'P4', 'account-wide-unclassified']
const REASON_WORD = /^[a-z-]{1,40}$/u
const pairOf = (value: Record<string, unknown>): CloudflareReason | null =>
  (typeof value.family === 'string' && FAMILIES.includes(value.family) && typeof value.reason === 'string' && REASON_WORD.test(value.reason)
    ? { family: value.family as CloudflareFamily, reason: value.reason } : null)
/** Code-unit order of two pairs: family, then reason. */
const pairOrder = (a: CloudflareReason, b: CloudflareReason): number =>
  (a.family !== b.family ? (a.family < b.family ? -1 : 1) : a.reason === b.reason ? 0 : a.reason < b.reason ? -1 : 1)
/**
 * The other reasons, exactly as the edge writes them: 1 to 8 pairs of exactly `family` and `reason`,
 * strictly ascending (so no duplicates), never the primary pair. Anything else is not offered.
 */
function alsoOf(value: unknown, primary: CloudflareReason): readonly CloudflareReason[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 8) return null
  const pairs: CloudflareReason[] = []
  for (const item of value) {
    if (!record(item) || Object.keys(item).length !== 2 || !('family' in item) || !('reason' in item)) return null
    const pair = pairOf(item)
    if (pair === null || pairOrder(pair, primary) === 0) return null
    const last = pairs.at(-1)
    if (last !== undefined && pairOrder(last, pair) >= 0) return null
    pairs.push(pair)
  }
  return pairs
}
/**
 * The five families, exactly as the edge names them; anything else is not offered (the card must say why). The object
 * returned has exactly the members staged, nothing added: it is what goes back to the edge as `expect`.
 */
function cloudflareProtection(value: unknown): CloudflareProtection | null {
  if (!record(value) || Object.keys(value).some(key => !['family', 'reason', 'apiFamily', 'also'].includes(key))) return null
  const primary = pairOf(value)
  if (primary === null) return null
  let also: readonly CloudflareReason[] | undefined
  if (value.also !== undefined) {
    const read = alsoOf(value.also, primary)
    if (read === null) return null
    also = read
  }
  if (value.apiFamily !== undefined && (primary.family !== 'account-wide-unclassified' || typeof value.apiFamily !== 'string'
    || !/^[a-z0-9._~@:-]{1,64}(?:\/[a-z0-9._~@:-]{1,64})?$/u.test(value.apiFamily))) return null
  return { ...primary, ...(typeof value.apiFamily === 'string' ? { apiFamily: value.apiFamily } : {}), ...(also === undefined ? {} : { also }) }
}

function repoPostable(body: Record<string, unknown>): boolean {
  if (typeof body.action !== 'string' || !['write', 'edit', 'commit'].includes(body.action)) return false
  if (typeof body.path === 'string' && body.path.trim() !== '') return true
  if (Array.isArray(body.changes) && body.changes.length > 0 && body.changes.every(c => record(c) && typeof c.path === 'string')) return true
  return false
}

/**
 * Her Linear write the edge held for the passkey (`x6_linear`, deploy/cloudflare/src/linear-door.mjs). Only the
 * door's dangerous core is offered here: archiving or deleting an issue, document, project or team; a project's or a
 * team's settings or members; and `issue_update` only as a move to another team (with `teamId`). Each takes exactly the
 * fields it takes at the edge, judged by the same rules (`LINEAR_ACTIONS` there; outward-linear.client.spec.ts fails when
 * the two drift), so every core write the edge holds can be shown, and nothing else is. An open write, a read, an unknown
 * action, an extra key or a value the edge would refuse is not offered. No `protection`: the action names the reason.
 */
type LinearRule = (value: unknown) => boolean
/** One core action as the card reads it: its exact fields, the ones it needs, and (settings) at least one change. */
export interface LinearCardAction {
  readonly fields: Readonly<Record<string, LinearRule>>
  readonly required: readonly string[]
  readonly atLeastOne?: readonly string[]
}
const LINEAR_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/u
const LINEAR_TEAM_KEY = /^[A-Z][A-Z0-9_]{0,9}$/u
const LINEAR_DATE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/u
/** The edge's `requestId` (linear-door.mjs REQUEST_ID). */
export const LINEAR_REQUEST_ID = /^[A-Za-z0-9_-]{16,64}$/u
const LINEAR_TEXT_MAX = 60 * 1024
const isLinearId: LinearRule = value => typeof value === 'string' && LINEAR_ID.test(value)
const isLinearNullableId: LinearRule = value => value === null || isLinearId(value)
const isLinearIds: LinearRule = value => Array.isArray(value) && value.length <= 25 && value.every(isLinearId)
  && new Set(value).size === value.length
const isLinearLine = (max: number): LinearRule => value => typeof value === 'string' && value.trim() !== '' && value.length <= max
  && !/[\r\n\u0000]/u.test(value)
const isLinearOptionalText = (max: number): LinearRule => value => typeof value === 'string' && value.length <= max && !value.includes('\u0000')
const isLinearDate: LinearRule = value => typeof value === 'string' && LINEAR_DATE.test(value) && Number.isFinite(Date.parse(value + 'T00:00:00Z'))
const isLinearNullableDate: LinearRule = value => value === null || isLinearDate(value)
const isLinearPriority: LinearRule = value => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 4
const isLinearTeamKey: LinearRule = value => typeof value === 'string' && LINEAR_TEAM_KEY.test(value)
const isLinearBoolean: LinearRule = value => typeof value === 'boolean'
const LINEAR_BY_ID: LinearCardAction = { fields: { id: isLinearId }, required: ['id'] }
/** The core, as the edge takes it (linear-door.mjs LINEAR_CORE, plus `issue_update` as a move). */
export const LINEAR_CARD_ACTIONS: Readonly<Record<string, LinearCardAction>> = {
  issue_archive: LINEAR_BY_ID,
  issue_delete: LINEAR_BY_ID,
  document_delete: LINEAR_BY_ID,
  project_archive: LINEAR_BY_ID,
  project_delete: LINEAR_BY_ID,
  team_delete: LINEAR_BY_ID,
  project_settings: { required: ['id'], atLeastOne: ['name', 'description', 'leadId', 'memberIds', 'teamIds', 'startDate', 'targetDate', 'statusId'],
    fields: { id: isLinearId, name: isLinearLine(256), description: isLinearOptionalText(LINEAR_TEXT_MAX), leadId: isLinearNullableId,
      memberIds: isLinearIds, teamIds: isLinearIds, startDate: isLinearNullableDate, targetDate: isLinearNullableDate,
      statusId: isLinearId } },
  team_settings: { required: ['id'], atLeastOne: ['name', 'description', 'key', 'private'],
    fields: { id: isLinearId, name: isLinearLine(256), description: isLinearOptionalText(4096), key: isLinearTeamKey,
      private: isLinearBoolean } },
  team_member_add: { fields: { teamId: isLinearId, userId: isLinearId }, required: ['teamId', 'userId'] },
  team_member_remove: LINEAR_BY_ID,
  // A move to another team; the card offers `issue_update` only with `teamId` (the edge holds it for that reason alone).
  issue_update: { required: ['id'],
    atLeastOne: ['title', 'description', 'stateId', 'priority', 'assigneeId', 'labelIds', 'projectId', 'parentId', 'dueDate', 'teamId'],
    fields: { id: isLinearId, title: isLinearLine(512), description: isLinearOptionalText(LINEAR_TEXT_MAX), stateId: isLinearId,
      priority: isLinearPriority, assigneeId: isLinearNullableId, labelIds: isLinearIds, projectId: isLinearNullableId,
      parentId: isLinearNullableId, dueDate: isLinearNullableDate, teamId: isLinearId } },
}
function linearPostable(body: Record<string, unknown>): boolean {
  const name = body.action
  if (typeof name !== 'string' || !Object.hasOwn(LINEAR_CARD_ACTIONS, name)) return false
  const spec = LINEAR_CARD_ACTIONS[name]
  if (spec === undefined || typeof body.requestId !== 'string' || !LINEAR_REQUEST_ID.test(body.requestId)) return false
  for (const key of Object.keys(body)) {
    if (key === 'action' || key === 'requestId') continue
    const rule = Object.hasOwn(spec.fields, key) ? spec.fields[key] : undefined
    if (rule === undefined || !rule(body[key])) return false
  }
  if (spec.required.some(key => body[key] === undefined)) return false
  if (spec.atLeastOne !== undefined && !spec.atLeastOne.some(key => body[key] !== undefined)) return false
  return name !== 'issue_update' || body.teamId !== undefined
}

/**
 * Read a staged file strictly.
 * @param text - the file's text.
 * @returns the request, or null when it is anything else.
 */
export function parseStagedOutward(text: string): StagedOutward | null {
  if (new TextEncoder().encode(text).byteLength > STAGED_OUTWARD_MAX_BYTES) return null
  let value: unknown
  try { value = JSON.parse(text) } catch { return null }
  if (!record(value) || Object.keys(value).some(key => !['schema', 'stagedAt', 'tool', 'method', 'pathname', 'body', 'protection'].includes(key))) return null
  if (value.schema !== STAGED_OUTWARD_SCHEMA || value.method !== 'POST' || !record(value.body)
    || !Number.isSafeInteger(value.stagedAt) || (value.stagedAt as number) < 0) return null
  // Only a Cloudflare request carries `protection`, and it must: the card says why it needs his fingerprint.
  // Her body never carries `expect`: `cloudflarePostable` admits only the request's own keys.
  if (value.tool === 'x6_cloudflare' && value.pathname === '/_host/cloudflare' && cloudflarePostable(value.body)) {
    const protection = cloudflareProtection(value.protection)
    if (protection === null) return null
    const approved = { ...value.body, expect: protection }
    return { tool: 'x6_cloudflare', pathname: '/_host/cloudflare', method: 'POST',
      body: value.body, stagedAt: value.stagedAt as number, approved, canonical: canonicalJson(approved), protection }
  }
  if (value.protection !== undefined) return null
  // Her held Linear core write. The bytes approved and sent are her staged body itself.
  if (value.tool === 'x6_linear' && value.pathname === '/_host/linear' && linearPostable(value.body)) {
    return { tool: 'x6_linear', pathname: '/_host/linear', method: 'POST',
      body: value.body, stagedAt: value.stagedAt as number, approved: value.body, canonical: canonicalJson(value.body) }
  }
  if (value.tool === 'x6_repo' && value.pathname === '/_host/repo' && repoPostable(value.body)) {
    return { tool: 'x6_repo', pathname: '/_host/repo', method: 'POST',
      body: value.body, stagedAt: value.stagedAt as number, approved: value.body, canonical: canonicalJson(value.body) }
  }
  if (value.tool !== 'x6_github' || value.pathname !== '/_host/github' || !postable(value.body)) return null
  return { tool: 'x6_github', pathname: '/_host/github', method: 'POST',
    body: value.body, stagedAt: value.stagedAt as number, approved: value.body, canonical: canonicalJson(value.body) }
}

/** Her staged file, as one window read it. */
export type StagedOutwardRead =
  /**
   * Nothing staged, or her home was not read, or the edge refused exactly this ask because its reason changed since she
   * asked (`CLOUDFLARE_REASON_CHANGED`): she must ask again, so nothing is offered.
   */
  | { readonly kind: 'none' }
  /** A file is there, but it is not a request this page can read. */
  | { readonly kind: 'malformed' }
  | { readonly kind: 'staged'; readonly staged: StagedOutward }

/**
 * Read her staged request from this window's copy of her home. Every card that offers it reads it this one way.
 * @param reader - the page's reader of her files.
 * @param sessionId - the Session whose home is read (undefined: none is open, so nothing is read).
 * @param signal - aborts the read.
 * @returns the request, `malformed`, or `none` (a file that is not there, or a read that failed).
 */
export async function readStagedOutward(reader: WorkReader, sessionId: SessionId | undefined, signal: AbortSignal)
  : Promise<StagedOutwardRead> {
  if (sessionId === undefined) return { kind: 'none' }
  const file = await reader.whole(sessionId, STAGED_OUTWARD_PATH, signal).catch(() => null)
  if (file === null || !file.ok) return { kind: 'none' }
  const staged = parseStagedOutward(file.text)
  if (staged !== null && reasonChangedFor(staged)) return { kind: 'none' }
  return staged === null ? { kind: 'malformed' } : { kind: 'staged', staged }
}

/**
 * The asks the edge refused with `CLOUDFLARE_REASON_CHANGED`, by when she staged them and their
 * bytes. The same bytes are never offered, nor sent, again: only a new ask from her (a new staged file) is.
 *
 * Kept as `outward-sent.ts` keeps what was sent: in this page's memory, which always works, and in `localStorage` under
 * `REASON_CHANGED_KEY` (the last 16), which a reload and other tabs read (a `storage` event under that key). A card on this
 * page is told by `onReasonChange` (a `storage` event never fires in the page that wrote it). Each ask is kept as a short
 * key (when, length, a 53-bit hash of the bytes), so a 256 KiB ask never fills the browser's storage; two different asks
 * sharing a key would only hide the second (she asks again), never offer one.
 */
export const REASON_CHANGED_KEY = 'aukora.outward-class3.reason-changed'
const reasonChanged = new Set<string>()
const reasonListeners = new Set<() => void>()
/** A 53-bit hash of a text (cyrb53), only to name an ask compactly. */
function hash53(value: string): string {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    h1 = Math.imul(h1 ^ code, 2654435761)
    h2 = Math.imul(h2 ^ code, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)
}
const askKeys = new WeakMap<StagedOutward, string>()
function askOf(staged: StagedOutward): string {
  const known = askKeys.get(staged)
  if (known !== undefined) return known
  const key = `${String(staged.stagedAt)}:${String(staged.canonical.length)}:${hash53(staged.canonical)}`
  askKeys.set(staged, key)
  return key
}
function storedAsks(): string[] {
  try {
    const list: unknown = JSON.parse(globalThis.localStorage.getItem(REASON_CHANGED_KEY) ?? '[]')
    return Array.isArray(list) ? list.filter((item): item is string => typeof item === 'string') : []
  } catch { return [] }
}
/**
 * Whether the edge refused this exact ask because its reason changed since she asked (here, after a reload, or in another tab).
 * @param staged - the request as read.
 * @returns true when it must not be offered or sent again.
 */
export function reasonChangedFor(staged: StagedOutward): boolean {
  const ask = askOf(staged)
  return reasonChanged.has(ask) || storedAsks().includes(ask)
}
function markReasonChanged(staged: StagedOutward): void {
  const ask = askOf(staged)
  reasonChanged.add(ask)
  try {
    globalThis.localStorage.setItem(REASON_CHANGED_KEY, JSON.stringify([...storedAsks().filter(item => item !== ask), ask].slice(-16)))
  } catch { /* the in-memory record still holds for this page */ }
  for (const listener of [...reasonListeners]) listener()
}
/**
 * Be told when an ask on this page is refused because its reason changed.
 * @param listener - called after each refusal is recorded.
 * @returns a function that stops telling it.
 */
export function onReasonChange(listener: () => void): () => void {
  reasonListeners.add(listener)
  return () => { reasonListeners.delete(listener) }
}
/** Tests only: forget every refused ask (this page's and the browser's record). */
export function resetReasonChangedForTests(): void {
  reasonChanged.clear()
  try { globalThis.localStorage.removeItem(REASON_CHANGED_KEY) } catch { /* nothing kept there */ }
}

/** What the owner reads before he approves: a one-line summary and the rows of exactly what goes out. */
export interface OutwardWords {
  readonly summary: string
  readonly rows: readonly (readonly [string, string])[]
}

const text = (value: unknown): string => (typeof value === 'string' ? value : value === undefined ? '' : JSON.stringify(value))

/**
 * A JSON value laid out for reading, in the key order of `canonicalJson` (keys sorted, undefined
 * dropped, an undefined array item as null): the order of the bytes the edge sends and the approval covers. Walked from
 * the value itself, never via `JSON.parse` of the canonical text (that would put integer-like keys such as "2" and "10"
 * first, in number order). Without the line breaks and indentation it adds, it is exactly `canonicalJson(value)`.
 */
function canonicalPretty(value: unknown, indent: string): string {
  if (value === undefined) return ''
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  const inner = indent + '  '
  if (Array.isArray(value)) {
    return value.length === 0 ? '[]'
      : `[\n${value.map(item => inner + canonicalPretty(item === undefined ? null : item, inner)).join(',\n')}\n${indent}]`
  }
  const object = value as Record<string, unknown>
  const keys = Object.keys(object).filter(key => object[key] !== undefined).sort()
  return keys.length === 0 ? '{}'
    : `{\n${keys.map(key => `${inner}${JSON.stringify(key)}: ${canonicalPretty(object[key], inner)}`).join(',\n')}\n${indent}}`
}

/**
 * Why a Cloudflare write needs the owner's fingerprint, in his words. One sentence per family as its default (a reason
 * word the card does not know yet), then one per (family, reason) the edge emits (cloudflare-door.mjs
 * CLOUDFLARE_DOOR_LEVEL_TABLE, and the door's contract). Each says what the request does, never whether to do it.
 */
export const CLOUDFLARE_WHY = {
  P1: 'It can change your live home: its address, its code, or what it stores.',
  P2: 'It changes who holds keys to your Cloudflare account, or who can sign in to it.',
  P3: 'It deletes a whole zone or a whole account. That cannot be undone.',
  P4: 'It commits you to a charge on Cloudflare: a plan, a purchase, a renewal or a payment.',
  unclassified: 'It is an account-wide setting not yet classified, so it asks you first',
} as const
const UNCHECKED = 'The door could not check whether'
/** By `family/reason`. An `account-wide-unclassified` sentence ends with the Cloudflare family it names, when the edge named one. */
export const CLOUDFLARE_REASON_WHY: Readonly<Record<string, string>> = {
  // P1, the live home, by target: its address, its code, what it stores, an account-wide switch.
  'P1/live-worker': 'It changes your live home\'s code: the Worker that serves it.',
  'P1/live-worker-settings': 'It changes settings every Worker of your account uses, your live home\'s Worker included.',
  'P1/live-host': 'It changes what answers at your live home\'s address.',
  'P1/live-route': 'It changes which Worker answers at your live home\'s address.',
  'P1/live-dns': 'It changes the DNS records that point to your live home\'s address.',
  'P1/live-zone': 'It changes the zone that holds your live home\'s address: its records or its settings.',
  'P1/live-domain': 'It changes the registration of your live home\'s domain name, such as its renewal or its lock.',
  'P1/live-dependency': 'It changes a Worker or service your live home\'s code relies on.',
  'P1/bound-storage': 'It can change what your live home stores: its memory and its archive.',
  'P1/account-switch': 'It changes a setting that acts on every zone of your Cloudflare account, your live home\'s included.',
  // P1, what the door could not check: it asks.
  'P1/zone-unresolved': `${UNCHECKED} this zone holds your live home's address, so it asks you.`,
  'P1/bound-id-unresolved': `${UNCHECKED} this touches what your live home stores, so it asks you.`,
  'P1/live-dependency-unresolved': `${UNCHECKED} your live home's code relies on this, so it asks you.`,
  'P1/live-facts-unresolved': 'The door could not read your live home\'s settings to check whether this touches it, so it asks you.',
  'P1/host-unreadable': 'The door could not read the address this names to check whether it is your live home, so it asks you.',
  'P1/inspection-limit': 'Part of this request is wrapped too deeply for the door to read, so it asks you.',
  // P2: who holds keys to the Cloudflare account or can sign in; and an application's own secret.
  'P2/keys': 'It changes who holds keys to your Cloudflare account: what can act as you there.',
  'P2/members': 'It changes who can sign in to your Cloudflare account as a member, and with what role.',
  'P2/access': 'It changes who can sign in through Cloudflare Access or single sign-on.',
  'P2/account': 'It changes your Cloudflare account\'s own record, including whether signing in to it needs a second step.',
  'P2/user': 'It changes your own Cloudflare user, the one you sign in as, or a service tied to it.',
  'P2/app-secret': 'It sets or changes a secret or certificate that one of your applications uses.',
  // P3: what is deleted, and that it cannot be undone.
  'P3/zone-deletion': 'It deletes a whole zone: its address, records and settings. That cannot be undone.',
  'P3/account-deletion': 'It deletes a whole Cloudflare account and everything in it. That cannot be undone.',
  // P4: that it commits him to a charge, and which.
  'P4/paid-subscription': 'It commits you to a charge: a paid plan for your account, a zone or your user.',
  'P4/paid-subscription-bulk': 'It commits you to a charge: several paid subscriptions changed at once.',
  'P4/paid-subscription-action': 'It commits you to a charge: an action on a paid subscription that adds or keeps a paid plan.',
  'P4/registrar-purchase': 'It commits you to a charge: registering a domain name.',
  'P4/registrar-renewal': 'It commits you to a charge: a domain name\'s renewal or its settings, such as automatic renewal.',
  'P4/registrar-transfer': 'It commits you to a charge: moving a domain name to or from Cloudflare.',
  'P4/billing-payment': 'It commits you to a charge: paying an invoice or an outstanding debt.',
  'P4/paid-routing-enable': 'It commits you to a charge: Argo Smart Routing, billed by use once it is on.',
  'P4/paid-storage-enable': 'It commits you to a charge: Cache Reserve, billed storage once it is on.',
  'P4/paid-certificate-order': 'It commits you to a charge: ordering an advanced certificate.',
  'P4/credit-purchase': 'It commits you to a charge: buying credit, once or automatically.',
  'P4/billing': 'It commits you to a charge: a change to your Cloudflare billing.',
  // Not classified: it asks first.
  'account-wide-unclassified/unclassified': CLOUDFLARE_WHY.unclassified,
  'account-wide-unclassified/other-account': 'It acts on a Cloudflare account other than yours, so it asks you first',
  'account-wide-unclassified/root-unclassified': 'It addresses a part of Cloudflare the door does not classify, so it asks you first',
}
/** The sentence for one reason the edge gave. */
function reasonWhy(pair: CloudflareReason, apiFamily?: string): string {
  const said = CLOUDFLARE_REASON_WHY[`${pair.family}/${pair.reason}`]
  if (pair.family !== 'account-wide-unclassified') return said ?? CLOUDFLARE_WHY[pair.family]
  return `${said ?? CLOUDFLARE_WHY.unclassified}${apiFamily === undefined ? '' : ` (Cloudflare family: ${apiFamily})`}.`
}
/**
 * Every reason, in his words. The primary pair's sentence first, then one for each `also` pair whose
 * sentence differs from those already said, in the order given: a charge and a deletion are always said when they apply.
 * @param protection - the reason as staged.
 * @returns the sentences, in order.
 */
export function cloudflareReasons(protection: CloudflareProtection | undefined): readonly string[] {
  if (protection === undefined) return [`${CLOUDFLARE_WHY.unclassified}.`]
  const said: string[] = [reasonWhy(protection, protection.family === 'account-wide-unclassified' ? protection.apiFamily ?? 'unnamed' : undefined)]
  for (const pair of protection.also ?? []) {
    const sentence = reasonWhy(pair)
    if (!said.includes(sentence)) said.push(sentence)
  }
  return said
}
const bytes = (value: unknown): number => new TextEncoder().encode(text(value)).byteLength

/**
 * What a held Linear write does, in plain words for the owner: one sentence per action, the thing named by the id or
 * identifier as staged (the edge takes ids, not names), a deletion always saying it cannot be undone. Bounded by
 * construction: every name in it passed the edge's id rule (at most 64 letters, digits and dashes) and is capped again
 * here; a setting is named by a fixed word, never by her text. React escapes it.
 */
const LINEAR_SETTING_WORDS: Readonly<Record<string, string>> = {
  name: 'name', description: 'description', leadId: 'lead', memberIds: 'members', teamIds: 'teams', startDate: 'start date',
  targetDate: 'target date', statusId: 'status', key: 'key', private: 'privacy', title: 'title', stateId: 'state', priority: 'priority',
  assigneeId: 'assignee', labelIds: 'labels', projectId: 'project', parentId: 'parent', dueDate: 'due date',
}
const LINEAR_UNDONE = 'This cannot be undone.'
const linearName = (value: unknown): string => (typeof value === 'string' ? value.slice(0, 64) : '')
/** The changed settings, in the order the request names them (sorted), as "a, b and c". */
function linearChanges(body: Record<string, unknown>, skip: readonly string[]): string {
  const words = Object.keys(body).sort().filter(key => !['action', 'requestId', ...skip].includes(key))
    .map(key => LINEAR_SETTING_WORDS[key] ?? 'another field')
  return words.length <= 1 ? words.join('') : `${words.slice(0, -1).join(', ')} and ${words.at(-1) ?? ''}`
}
/**
 * The sentence for one held Linear write (its `does` row), and its short label (the summary).
 * @param body - her staged body, as `parseStagedOutward` accepted it.
 * @returns the sentence and the label.
 */
export function linearWords(body: Record<string, unknown>): { readonly sentence: string; readonly label: string } {
  const id = linearName(body.id)
  switch (body.action) {
    case 'issue_archive': return { sentence: `Archive issue ${id} in Linear.`, label: `archive issue ${id}` }
    case 'issue_delete': return { sentence: `Delete issue ${id} from Linear. ${LINEAR_UNDONE}`, label: `delete issue ${id}` }
    case 'document_delete': return { sentence: `Delete document ${id} from Linear. ${LINEAR_UNDONE}`, label: `delete document ${id}` }
    case 'project_archive': return { sentence: `Archive project ${id} in Linear.`, label: `archive project ${id}` }
    case 'project_delete': return { sentence: `Delete project ${id} from Linear. ${LINEAR_UNDONE}`, label: `delete project ${id}` }
    case 'team_delete': return { sentence: `Delete team ${id} from Linear. ${LINEAR_UNDONE}`, label: `delete team ${id}` }
    case 'project_settings':
      return { sentence: `Change project ${id}'s settings: ${linearChanges(body, ['id'])}.`, label: `change project ${id}'s settings` }
    case 'team_settings':
      return { sentence: `Change team ${id}'s settings: ${linearChanges(body, ['id'])}.`, label: `change team ${id}'s settings` }
    case 'team_member_add': {
      const [user, team] = [linearName(body.userId), linearName(body.teamId)]
      return { sentence: `Add person ${user} to team ${team}.`, label: `add person ${user} to team ${team}` }
    }
    case 'team_member_remove':
      return { sentence: `Remove a person from a team in Linear: membership ${id}.`, label: `remove membership ${id}` }
    case 'issue_update': {
      const team = linearName(body.teamId), also = linearChanges(body, ['id', 'teamId'])
      return { sentence: `Move issue ${id} to team ${team}.${also === '' ? '' : ` It also changes its ${also}.`}`,
        label: `move issue ${id} to team ${team}` }
    }
    default: return { sentence: 'A Linear request this card does not know.', label: 'a request this card does not know' }
  }
}

/**
 * Say what a staged request does.
 * @param staged - the request.
 * @returns its summary and rows (every byte that leaves is shown or counted).
 */
export function outwardWords(staged: StagedOutward): OutwardWords {
  const body = staged.body
  if (staged.tool === 'x6_cloudflare') {
    // Every field that leaves is a row: why, method, path, query, the readable body (or each part), its kind and type.
    const method = text(body.method).toUpperCase(), path = text(body.path)
    const pretty = (value: unknown): string => (typeof value === 'string' ? value : canonicalPretty(value, ''))
    const parts = Array.isArray(body.parts) ? body.parts : []
    const partRows = parts.flatMap((part, index): (readonly [string, string])[] => {
      const item = record(part) ? part : {}
      const label = `part ${String(index + 1)} (${text(item.name)})`
      return [
        [`${label} type`, `${text(item.contentType)}${typeof item.filename === 'string' ? ` · file ${item.filename}` : ''}`],
        [`${label} content`, item.json !== undefined ? pretty(item.json) : pretty(item.text)],
        ...Object.keys(item).sort().filter(key => !['name', 'filename', 'contentType', 'text', 'json'].includes(key))
          .map(key => [`${label} ${key}`, pretty(item[key])] as const),
      ]
    })
    return {
      summary: `Cloudflare: ${method} ${path}`,
      rows: [
        // Every reason the edge gave (the `expect` in the bytes he approves), one sentence each; never printed as raw JSON.
        ['why', cloudflareReasons(staged.protection).join('\n')],
        ['method', method],
        ['path', path],
        ...(body.query !== undefined ? [['query', pretty(body.query)] as const] : []),
        ...(body.body !== undefined ? [['body', pretty(body.body)] as const] : []),
        ...(body.bodyKind !== undefined ? [['bodyKind', text(body.bodyKind)] as const] : []),
        ...(body.contentType !== undefined ? [['contentType', text(body.contentType)] as const] : []),
        ...partRows,
        ['request', `POST /_host/cloudflare · ${String(bytes(staged.canonical))} bytes`],
      ],
    }
  }
  if (staged.tool === 'x6_linear') {
    // The sentence first, then every field that leaves as a row (action, requestId, each field in the canonical
    // key order of the bytes approved), then the request itself.
    const { sentence, label } = linearWords(body)
    const field = (value: unknown): string => (typeof value === 'string' ? value : canonicalPretty(value, ''))
    return {
      summary: `Linear: ${label}`,
      rows: [
        ['does', sentence],
        ['action', text(body.action)],
        ['requestId', text(body.requestId)],
        ...Object.keys(body).sort().filter(key => key !== 'action' && key !== 'requestId').map(key => [key, field(body[key])] as const),
        ['request', `POST /_host/linear · ${String(bytes(staged.canonical))} bytes`],
      ],
    }
  }
  if (staged.tool === 'x6_repo') {
    const action = text(body.action)
    const targetPath = typeof body.path === 'string'
      ? body.path
      : Array.isArray(body.changes)
        ? body.changes.map(c => (record(c) && typeof c.path === 'string' ? c.path : '')).filter(Boolean).join(', ')
        : 'repository'
    // EVERY FIELD THAT LEAVES IS A ROW: the file content of a write, the old and new text of an edit, each file of a commit,
    // and every other field the request carries (base sha, idempotency key, dry run), so Touch ID never approves a byte
    // the card did not show.
    const changes = Array.isArray(body.changes) ? body.changes : []
    const changeRows = changes.flatMap((change, index): (readonly [string, string])[] => {
      const file = record(change) ? change : {}
      const label = `file ${String(index + 1)} (${text(file.path)})`
      return Object.keys(file).sort().filter(key => key !== 'path').map(key => [`${label} ${key}`, text(file[key])] as const)
    })
    const named = new Set(['action', 'path', 'message', 'changes'])
    const rest = Object.keys(body).sort().filter(key => !named.has(key)).map(key => [key, text(body[key])] as const)
    return {
      summary: `T2 Gate: ${action} ${targetPath} in your_org_x/your-node`,
      rows: [
        ['action', `${action} (${targetPath})`],
        ...(typeof body.message === 'string' ? [['message', body.message] as const] : []),
        ...rest,
        ...changeRows,
        ['request', `POST /_host/repo · ${String(bytes(staged.canonical))} bytes`],
      ],
    }
  }
  const endpoint = text(body.endpoint).replace(/^\/+/u, '')
  const post = record(body.body) ? body.body : {}
  const comment = endpoint.match(/^repos\/your_org_x\/your-node\/issues\/(\d+)\/comments$/u)
  const where = comment !== null ? `a comment on issue #${comment[1] ?? ''}` : endpoint === `${REPOSITORY}/issues` ? 'a new issue' : `POST ${endpoint}`
  return {
    summary: `GitHub: ${where} in your_org_x/your-node`,
    rows: [
      ['posts', where],
      ...(typeof post.title === 'string' ? [['title', post.title] as const] : []),
      ['text', text(post.body)],
      ['request', `POST /_host/github · ${String(bytes(staged.canonical))} bytes`],
    ],
  }
}

/**
 * The outcome of one approval: what to tell the owner. `refused` only when the host's own answer proves nothing went out (a
 * parsed refusal code given before it posted); any other failure after the approval is `unknown`: it may have gone out.
 */
export type OutwardOutcome =
  | { readonly kind: 'sent'; readonly words: string; readonly sent: Class3Sent }
  | { readonly kind: 'refused'; readonly words: string; readonly sent: Class3Sent | null }
  | { readonly kind: 'unknown'; readonly words: string; readonly sent: Class3Sent | null }

const MAYBE_SENT = 'It may have gone out: check GitHub before approving it again.'
/** The edge refused his approval because why it needs his fingerprint changed since she asked. */
export const CLOUDFLARE_REASON_CHANGED_WORDS = 'Not sent: why this needs your fingerprint changed since she asked, so she must ask again.'
/** What to check when a request may have gone out: GitHub for her GitHub and repo requests, Cloudflare and Linear for hers there. */
export const outwardMaybeSent = (staged: StagedOutward): string => (staged.tool === 'x6_cloudflare'
  ? 'It may have gone out: check Cloudflare (read it with a GET) before approving it again.'
  : staged.tool === 'x6_linear' ? 'It may have gone out: check Linear before approving it again.' : MAYBE_SENT) // Linear

/**
 * Approve one staged request with the passkey and send exactly it.
 * @param staged - the request as read at the click.
 * @param origin - this page's origin (the audience the host binds).
 * @param deps - the passkey and host call (tests pass their own), and the abort signal.
 * @param fetchImpl - the page's fetch.
 * @returns what happened.
 */
export async function approveAndSendOutward(staged: StagedOutward, origin: string, deps: Class3Dependencies,
  fetchImpl: typeof fetch = globalThis.fetch): Promise<OutwardOutcome> {
  // An ask the edge already refused because its reason changed is refused here, before the passkey, whatever card holds
  // it and however fresh its read: she must ask again.
  if (reasonChangedFor(staged)) return { kind: 'refused', words: CLOUDFLARE_REASON_CHANGED_WORDS, sent: null }
  // ONE VALUE: the bytes the passkey covers are the bytes sent, `staged.approved` (its canonical text is `staged.canonical`).
  const action = await class3Action({ audience: origin, method: staged.method, pathname: staged.pathname, body: staged.approved })
  const approval = await approveClass3(action, deps)
  if (!approval.ok) return { kind: 'refused', words: `Not sent: the passkey approval did not complete (${approval.reason}).`, sent: null }
  let sent: Class3Sent
  try {
    sent = await sendApprovedClass3(approval, staged.approved, deps.signal, fetchImpl)
  } catch (error) {
    return { kind: 'unknown', words: `No answer came back (${error instanceof Error ? error.message : String(error)}). ${outwardMaybeSent(staged)}`, sent: null }
  }
  const answer = sent.body
  if (sent.status === 200 && answer?.ok === true) {
    const json = record(answer.json) ? answer.json : null
    const link = json !== null && typeof json.url === 'string' ? ` ${json.url}` : ''
    return { kind: 'sent', words: `Sent.${link}`, sent }
  }
  // The edge's own reason is not the one he read, so it sent nothing to Cloudflare. One sentence, none
  // of the edge's body, and never these bytes again: she must ask again.
  if (staged.tool === 'x6_cloudflare' && sent.status === 409 && answer?.code === 'CLOUDFLARE_REASON_CHANGED') {
    markReasonChanged(staged)
    return { kind: 'refused', words: CLOUDFLARE_REASON_CHANGED_WORDS, sent }
  }
  // The broker names every refusal it gives before posting with a code; an answer that is not one (no JSON, no code, or
  // ANY outcome of its own: "unknown", or "written" when a door withheld the answer to a write that did go out) does not
  // prove the post did not happen.
  if (answer !== null && typeof answer.code === 'string' && answer.outcome === undefined && sent.status >= 400 && sent.status < 600) {
    return { kind: 'refused', words: `Not sent: the host refused it (${answer.code}).`, sent }
  }
  const code = typeof answer?.code === 'string' ? answer.code : `HTTP ${String(sent.status)}`
  return { kind: 'unknown', words: `The host answered ${code}. ${outwardMaybeSent(staged)}`, sent }
}
