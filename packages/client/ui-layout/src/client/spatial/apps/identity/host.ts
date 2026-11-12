// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The Aukora authors
/**
 * THE IDENTITY SURFACE'S HOST ROUTES, READ HONESTLY.
 *
 *   GET  /_host/owner-key                       { ok, publicKeyHex, keyId }   on main: the owner's PUBLIC Ed25519 key
 *   GET  /_host/passkey                         NOT ROUTED BY THE EDGE (it answers 501). Only the AUMLOK surface still asks it,
 *                                               when it has no AUMLOK status; the Identity cards read the bound passkey from
 *                                               `GET /_host/aumlok/status` and add devices through `/_host/aumlok/device-*`.
 *
 * Every call is same-origin with the session cookie. A route that is missing (404/405, or anything that is not JSON,
 * like the static fallback) reads as ABSENT and the surface says NOT CONNECTED YET naming that route; a JSON refusal
 * reads as REFUSED with the host's own code (a 404/405 the AUMLOK store answers with its own code, like
 * AUMLOK_INVITE_NOT_FOUND, is such a refusal). Nothing here fills a gap with a guess, and no private key is ever asked
 * for or shown: `/_host/owner-key` answers only the public half.
 * @module apps/identity/host
 */
import { asRecord, asString } from '../../x5/rpc.ts'

export const OWNER_KEY_ROUTE = '/_host/owner-key'
export const PASSKEY_ROUTE = '/_host/passkey'

/** One host read: live JSON, an absent route, or the host's refusal. */
export type HostAnswer =
  | { readonly kind: 'live'; readonly route: string; readonly body: Record<string, unknown> }
  | { readonly kind: 'absent'; readonly route: string; readonly detail: string }
  | {
    readonly kind: 'refused'
    readonly route: string
    readonly status: number
    readonly code: string
    readonly message: string
    /** A capacity refusal's wait, as the host sends it (`retryAfterSeconds`, whole seconds); absent when it sends none. */
    readonly retryAfterSeconds?: number
  }

/** The longest wait read from a host (an hour); a larger or malformed value is not read, and the words say no number. */
export const RETRY_AFTER_MAX_SECONDS = 3600

/**
 * The wait a refusal names: the body's `retryAfterSeconds` when it is a whole number of seconds from 1 to an hour.
 * @param record - the refusal's JSON body.
 * @returns `{ retryAfterSeconds }` to spread into the answer, or nothing.
 */
export function retryAfterOf(record: Record<string, unknown> | null | undefined): { readonly retryAfterSeconds?: number } {
  const seconds = record?.retryAfterSeconds
  return typeof seconds === 'number' && Number.isSafeInteger(seconds) && seconds >= 1 && seconds <= RETRY_AFTER_MAX_SECONDS
    ? { retryAfterSeconds: seconds } : {}
}

/**
 * THE TWO CAPACITY REFUSALS, IN WORDS. Neither is a failed try (the node counts nothing for them): too many Touch ID
 * requests are open, or too many approvals were made in five minutes. With the host's own wait, the words say it in
 * seconds; without one, they say the most it can be.
 * @param code - the host's code, bare (no `class3:` or `aumlok:` prefix).
 * @param retryAfterSeconds - the wait the host sent, if any.
 * @returns the sentence, or null for any other code.
 */
export function capacityWords(code: string, retryAfterSeconds?: number): string | null {
  const wait = retryAfterSeconds === undefined ? null
    : `Wait ${String(retryAfterSeconds)} ${retryAfterSeconds === 1 ? 'second' : 'seconds'}, then try again.`
  if (code === 'AUMLOK_CHALLENGE_CAPACITY') return `Too many Touch ID requests are open. ${wait ?? 'Wait two minutes.'} This is not counted as a failed try.`
  if (code === 'AUMLOK_APPROVAL_CAPACITY') {
    return `Too many Touch ID approvals were made in the last five minutes. ${wait ?? 'Wait up to five minutes, then try again.'} `
      + 'This is not counted as a failed try.'
  }
  return null
}

/** The AUMLOK ceremony route whose answer carries the browser's prompt timeout (`aumlok-ceremony.ts` AUMLOK_ROUTES.challenge). */
export const AUMLOK_CHALLENGE_ROUTE = '/_host/aumlok/challenge'

/** This page's monotonic clock (milliseconds). */
const monotonic = (): number => (typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now())

/**
 * THE PROMPT GETS WHAT IS LEFT, NEVER MORE. The node counts a ceremony's `publicKey.timeout` from when it answered, which
 * is no earlier than when this page sent the request; so the time the request took on this page's own monotonic clock is
 * taken off before any prompt opens (the add page's rule, for every owner prompt: approvals, invites, the AUMLOK
 * ceremonies). It can reach zero or less; `readChallenge` then never opens the prompt and says nothing was counted.
 * @param record - the live challenge answer.
 * @param elapsedMs - how long the request took.
 * @returns the answer with its timeout reduced (unchanged when it carries none).
 */
export function withRemainingTimeout(record: Record<string, unknown>, elapsedMs: number): Record<string, unknown> {
  const publicKey = record.publicKey
  if (publicKey === null || typeof publicKey !== 'object' || Array.isArray(publicKey)) return record
  const timeout = (publicKey as Record<string, unknown>).timeout
  if (typeof timeout !== 'number' || !Number.isFinite(timeout) || !Number.isFinite(elapsedMs) || elapsedMs <= 0) return record
  return { ...record, publicKey: { ...publicKey, timeout: Math.floor(timeout - elapsedMs) } }
}

/**
 * Call one host route and classify the answer.
 * @param route - the path (with any query).
 * @param signal - aborts the call.
 * @param body - a JSON body to POST; omit for GET.
 * @returns the classified answer; never throws except on abort.
 */
export async function hostCall(route: string, signal: AbortSignal, body?: Record<string, unknown>): Promise<HostAnswer> {
  const path = route.split('?')[0] ?? route
  const began = monotonic()
  let response: Response
  try {
    response = await fetch(route, {
      method: body === undefined ? 'GET' : 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      signal,
      headers: body === undefined ? { accept: 'application/json' } : { 'accept': 'application/json', 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  } catch (error) {
    if (signal.aborted) throw error
    return { kind: 'absent', route: path, detail: `the host did not answer (${error instanceof Error ? error.message : String(error)})` }
  }
  if (response.status === 404 || response.status === 405 || response.status === 501) {
    const refused = response.status === 501 ? null : await aumlokRefusal(response, path)
    return refused ?? { kind: 'absent', route: path, detail: `the host answers ${String(response.status)} for ${path}` }
  }
  const type = response.headers.get('content-type') ?? ''
  let parsed: unknown = null
  if (type.includes('application/json')) {
    try { parsed = JSON.parse(await response.text()) } catch { parsed = null }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { kind: 'absent', route: path, detail: `${path} answered ${String(response.status)} without JSON` }
  }
  const record = asRecord(parsed)
  if (!response.ok || record.ok === false) {
    const error = asRecord(record.error)
    return {
      kind: 'refused', route: path, status: response.status,
      code: asString(record.code) ?? asString(error.code) ?? String(response.status),
      message: asString(record.error) ?? asString(error.message) ?? asString(record.message) ?? 'refused',
      ...retryAfterOf(record),
    }
  }
  return { kind: 'live', route: path, body: path === AUMLOK_CHALLENGE_ROUTE ? withRemainingTimeout(record, monotonic() - began) : record }
}

/** The two AUMLOK codes that DO mean the route is not there (the store's own route and method checks). */
const AUMLOK_ROUTE_CODES = new Set(['AUMLOK_ROUTE_NOT_FOUND', 'AUMLOK_METHOD_NOT_ALLOWED'])

/**
 * A 404 or 405 FROM THE AUMLOK STORE ITSELF IS A REFUSAL, NOT A MISSING ROUTE. The store answers a revocation of an
 * invite it does not hold with `404 AUMLOK_INVITE_NOT_FOUND` (`deploy/cloudflare/src/aumlok.mjs`), and reading that as
 * "not on this host" would lose the host's own code. Only a JSON answer whose `code` is an AUMLOK_ code other than the
 * store's route and method codes counts; every other 404 or 405 stays absent.
 * @param response - the 404 or 405 answer (its body is read here).
 * @param path - the route, for the answer.
 * @returns the refusal, or null when the answer means the route is absent.
 */
async function aumlokRefusal(response: Response, path: string): Promise<HostAnswer | null> {
  if (!(response.headers.get('content-type') ?? '').includes('application/json')) return null
  let record: Record<string, unknown>
  try { record = asRecord(JSON.parse(await response.text())) } catch { return null }
  const code = asString(record.code)
  if (code === null || !/^AUMLOK_[A-Z0-9_]{1,80}$/u.test(code) || AUMLOK_ROUTE_CODES.has(code)) return null
  return { kind: 'refused', route: path, status: response.status, code,
    message: asString(record.error) ?? asString(record.message) ?? 'refused', ...retryAfterOf(record) }
}

/** The owner's public key as `/_host/owner-key` serves it, checked against the host's own keyId rule. */
export interface OwnerPublicKey { readonly publicKeyHex: string; readonly keyId: string }

/**
 * Read `{ publicKeyHex, keyId }` and refuse any other shape (the keyId must be `owner-ed25519-` + the key's first 12 hex,
 * the rule `server/owner-grant.mjs` applies), so a wrong field can never be drawn as the owner's key.
 * @param body - the live answer's body.
 * @returns the key, or `null` when the shape is not exactly that.
 */
export function readOwnerKey(body: Record<string, unknown>): OwnerPublicKey | null {
  const publicKeyHex = asString(body.publicKeyHex)
  const keyId = asString(body.keyId)
  if (publicKeyHex === null || keyId === null || !/^[0-9a-f]{64}$/.test(publicKeyHex)) return null
  return keyId === `owner-ed25519-${publicKeyHex.slice(0, 12)}` ? { publicKeyHex, keyId } : null
}

/**
 * THE CONTACT STRING this card defines: the owner's public Ed25519 key, and nothing else.
 *   `aukora:owner-public-key:v1:ed25519:<64 lowercase hex>`
 * It is not a Nostr identity (the node's npub, when it has one, is a separate line the Identity card adds), carries no
 * signature, and proves nothing alone: it is the key a peer would check an owner grant against.
 * @param key - the owner's public key.
 * @returns the contact string the QR carries.
 */
export function ownerContact(key: OwnerPublicKey): string {
  return `aukora:owner-public-key:v1:ed25519:${key.publicKeyHex}`
}

/** Field names a host status may carry that must never be drawn, whatever a route answers. */
const SECRET = /secret|private|seed|password|token|cap(ability)?$|cookie|mnemonic|words?$/i

/**
 * A status answer's primitive fields, for a field table, with anything secret-shaped dropped.
 * @param body - the live body.
 * @returns `[name, value]` rows (without `ok`).
 */
export function statusRows(body: Record<string, unknown>): [string, string][] {
  return Object.entries(body).flatMap(([key, value]): [string, string][] => {
    if (key === 'ok' || SECRET.test(key)) return []
    if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return [[key, String(value)]]
    if (Array.isArray(value) && value.every(item => ['string', 'number'].includes(typeof item))) return [[key, value.join(' · ')]]
    if (Array.isArray(value)) return [[key, `${String(value.length)} entries`]]
    return []
  })
}
