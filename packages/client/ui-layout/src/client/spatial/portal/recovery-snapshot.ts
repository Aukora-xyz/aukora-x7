// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The Aukora authors
/**
 * THE PORTABLE RECOVERY SNAPSHOT (Continuity): one JSON file a person can keep off this node (a phone, iCloud), made of
 * what this host answers on four read routes at one moment:
 *
 *   GET /_head/ball      the published Pearl and the module code it carries
 *   GET /__x6/facts      the host's own re-verification of her receipts and checkpoints
 *   GET /_host/estate    what the host says it holds (the edge's `aukora.edge-estate.v1`; secret-free by the host's design)
 *   GET /_mirror/export  the whole live mirror (the edge forwards it to the mirror snapshot v2; the Mac host has no such
 *                        route, so a file made there is INCOMPLETE and says so)
 *
 * ONLY RESPONSE BODIES GO IN. No cookie, no request or response header but the content type, nothing this page holds.
 * Each part carries the SHA-256 of the exact bytes the host sent, and `manifestSha256` covers the list of
 * [route, sha256, bytes] in canonical JSON, so a part swapped or cut later shows.
 *
 * A PART THAT DID NOT ANSWER 2xx IS RECORDED AS NOT CAPTURED: its status, `ok: false`, and NO body. A file missing the
 * Pearl or the mirror is INCOMPLETE and is still handed over, so what was read is not lost.
 *
 * WHAT THIS IS NOT. It is a capture. No restore from this file has been tested, and nothing here says one has. A JSON
 * body is kept parsed, so a part's `sha256` proves what the host sent then; it is re-computed from this file only when
 * the host's JSON was written the way `JSON.stringify` writes it.
 *
 * MEMORY IS BOUNDED: a part over 64 MiB is refused (read no further, recorded as not captured), and the parts are read one
 * at a time.
 * @module portal/recovery-snapshot
 */
import { canonicalJson } from '../aumlok/class3-approval.ts'

export const RECOVERY_SCHEMA = 'aukora.recovery-snapshot.v1'
/** The four parts, in the order they are read and written. */
export const RECOVERY_ROUTES = ['/_head/ball', '/__x6/facts', '/_host/estate', '/_mirror/export'] as const
export type RecoveryRoute = typeof RECOVERY_ROUTES[number]
/** Without either of these the file cannot bring her back: the published Pearl, and the mirror. */
export const RECOVERY_REQUIRED: readonly RecoveryRoute[] = ['/_head/ball', '/_mirror/export']
/** The most one part may weigh (64 MiB): the page never holds more of an answer than this. */
export const RECOVERY_PART_MAX_BYTES = 67_108_864
/**
 * The mirror alone may weigh what the edge may serve for it (96 MiB: `MIRROR_LIMITS.snapshotBytes`,
 * deploy/cloudflare/src/mirror-do.mjs), so a mirror the host allows is never refused by this page.
 */
export const RECOVERY_MIRROR_MAX_BYTES = 100_663_296
/** The bound for one route. */
export const recoveryMaxBytesFor = (route: string): number => (route === '/_mirror/export' ? RECOVERY_MIRROR_MAX_BYTES : RECOVERY_PART_MAX_BYTES)
/** What the file says about itself, so nobody reads it as more than it is. */
export const RECOVERY_NOTE = 'A capture of what this host answered, part by part, between startedAt and createdAt (not one instant). '
  + 'No restore from this file has been tested.'

/** One part as the file records it. A part that was not captured has no `body`. */
export type RecoveryPart =
  | {
    readonly route: string
    readonly status: number
    readonly ok: true
    /** Lowercase hex SHA-256 of the exact bytes the host sent. */
    readonly sha256: string
    readonly bytes: number
    readonly contentType: string | null
    /** How `body` is kept: the parsed JSON value, or base64 of the bytes when the answer was not JSON. */
    readonly encoding: 'json' | 'base64'
    readonly body: unknown
  }
  | {
    readonly route: string
    /** The status the host answered, or null when it did not answer at all. */
    readonly status: number | null
    readonly ok: false
    readonly sha256: null
    readonly bytes: null
    readonly contentType: null
    /** Why it is not here, in a few plain words ("answered 404", "over 64 MiB", "did not answer"). */
    readonly reason: string
  }

/** The whole file. */
export interface RecoverySnapshot {
  readonly schema: typeof RECOVERY_SCHEMA
  /** ISO 8601, UTC. */
  /** When the first part was asked for; the parts are read one after another, so the file spans startedAt..createdAt. */
  readonly startedAt: string
  readonly createdAt: string
  readonly origin: string
  /** The published Pearl's epoch from the `/_head/ball` answer in this file, or 'unknown' when that part was not read. */
  readonly epoch: string
  /** False when the Pearl or the mirror is not in the file. */
  readonly complete: boolean
  readonly note: typeof RECOVERY_NOTE
  readonly parts: readonly RecoveryPart[]
  /** Lowercase hex SHA-256 of the canonical JSON of every part's [route, sha256, bytes], in order. */
  readonly manifestSha256: string
}

const hexOf = (digest: ArrayBuffer): string => [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
const sha256Hex = async (bytes: Uint8Array<ArrayBuffer>): Promise<string> => hexOf(await globalThis.crypto.subtle.digest('SHA-256', bytes))
const isJsonType = (contentType: string | null): boolean => /^application\/(?:[a-z0-9.+-]*\+)?json\b/iu.test(contentType ?? '')
const mebibytes = (bytes: number): string => `${String(Math.round(bytes / 1_048_576))} MiB`

/** Base64 (standard alphabet, padded) of bytes, built in slices so a large part never becomes one argument list. */
function base64Of(bytes: Uint8Array): string {
  let binary = ''
  for (let at = 0; at < bytes.length; at += 32_768) binary += String.fromCharCode(...bytes.subarray(at, at + 32_768))
  return btoa(binary)
}

/**
 * A part that was not captured: the status the host gave (null when it gave none) and why, with no body.
 * @param route - the route asked.
 * @param status - the host's status, or null.
 * @param reason - why, in a few words.
 * @returns the part.
 */
export function missingPart(route: string, status: number | null, reason: string): RecoveryPart {
  return { route, status, ok: false, sha256: null, bytes: null, contentType: null, reason }
}

/**
 * One captured part from the exact bytes of a 2xx answer: their SHA-256, their length, and the body as parsed JSON when
 * the host said JSON and it parses, else as base64 of the bytes. Over the size bound it is refused (not captured).
 * @param route - the route asked.
 * @param status - the 2xx status.
 * @param contentType - the answer's content type, or null.
 * @param bytes - the exact response bytes.
 * @param maxBytes - the size bound (tests pass a small one).
 * @returns the part.
 */
export async function recoveryPartOf(route: string, status: number, contentType: string | null, bytes: Uint8Array<ArrayBuffer>,
  maxBytes: number = RECOVERY_PART_MAX_BYTES): Promise<RecoveryPart> {
  if (bytes.length > maxBytes) return missingPart(route, status, `over ${mebibytes(maxBytes)}`)
  const sha256 = await sha256Hex(bytes)
  const captured = { route, status, ok: true, sha256, bytes: bytes.length, contentType } as const
  if (isJsonType(contentType)) {
    // THE HOST SAID JSON AND IT DOES NOT PARSE: not captured. The edge cuts a mirror snapshot short on purpose when the
    // mirror is written while it streams ("truncates, never tears, JSON"), and relies on the reader to treat a body that
    // does not parse as a failed read. A cut body kept as bytes would be a backup that only looks whole.
    try {
      return { ...captured, encoding: 'json', body: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown }
    } catch { return missingPart(route, status, 'said JSON but does not parse (cut short, or not JSON)') }
  }
  return { ...captured, encoding: 'base64', body: base64Of(bytes) }
}

/**
 * The manifest digest: SHA-256 of the canonical JSON of [route, sha256, bytes] for every part, in order (a part that was
 * not captured counts as [route, null, null], so dropping it later also shows).
 * @param parts - the parts.
 * @returns 64 lowercase hex characters.
 */
export async function recoveryManifestSha256(parts: readonly RecoveryPart[]): Promise<string> {
  return sha256Hex(new TextEncoder().encode(canonicalJson(parts.map(part => [part.route, part.sha256, part.bytes]))))
}

/**
 * The epoch the `/_head/ball` part itself carries (`head.epoch`), digits only.
 * @param parts - the parts.
 * @returns the epoch, or 'unknown' when that part was not captured or names none.
 */
export function recoveryEpochOf(parts: readonly RecoveryPart[]): string {
  const ball = parts.find(part => part.route === '/_head/ball')
  if (ball?.ok !== true || ball.encoding !== 'json' || ball.body === null || typeof ball.body !== 'object') return 'unknown'
  const head = (ball.body as { head?: unknown }).head
  const epoch = head !== null && typeof head === 'object' ? (head as { epoch?: unknown }).epoch : undefined
  const text = typeof epoch === 'number' || typeof epoch === 'string' ? String(epoch) : ''
  return /^\d{1,12}$/u.test(text) ? text : 'unknown'
}

/**
 * The file's name: `auma-recovery-epoch-<epoch>-<YYYY-MM-DD>.json`, the date in UTC.
 * @param epoch - the epoch as read, or anything else for "unknown".
 * @param createdAt - when the capture was made (ms).
 * @returns the name (digits only in the epoch, else "unknown").
 */
export function recoveryFileName(epoch: string | number | null, createdAt: number): string {
  const text = epoch === null ? '' : String(epoch)
  return `auma-recovery-epoch-${/^\d{1,12}$/u.test(text) ? text : 'unknown'}-${new Date(createdAt).toISOString().slice(0, 10)}.json`
}

/**
 * Build the file from its parts. Nothing but the parts, the origin and the time goes in.
 * @param parts - the parts, in order.
 * @param origin - this page's origin.
 * @param createdAt - when the capture was made (ms).
 * @returns the snapshot.
 */
export async function buildRecoverySnapshot(
  parts: readonly RecoveryPart[], origin: string, createdAt: number, startedAt: number = createdAt,
): Promise<RecoverySnapshot> {
  // Complete means both required parts are there AS JSON (the Pearl and the mirror are JSON on every host that serves them).
  const held = (route: RecoveryRoute): boolean => parts.some(part => part.route === route && part.ok && part.encoding === 'json')
  const complete = RECOVERY_REQUIRED.every(held)
  return { schema: RECOVERY_SCHEMA, startedAt: new Date(startedAt).toISOString(), createdAt: new Date(createdAt).toISOString(), origin,
    epoch: recoveryEpochOf(parts), complete,
    note: RECOVERY_NOTE, parts, manifestSha256: await recoveryManifestSha256(parts) }
}

/** Read a body up to the bound: the bytes, or null once it is known to be over (the rest is not read). */
async function readBounded(response: Response, maxBytes: number): Promise<Uint8Array<ArrayBuffer> | null> {
  const declared = Number(response.headers.get('content-length') ?? 'NaN')
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => {})
    return null
  }
  const reader = response.body?.getReader()
  if (reader === undefined) {
    const all = new Uint8Array(await response.arrayBuffer())
    return all.length > maxBytes ? null : all
  }
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.length
    if (total > maxBytes) {
      await reader.cancel().catch(() => {})
      return null
    }
    chunks.push(value)
  }
  const all = new Uint8Array(total)
  let at = 0
  for (const chunk of chunks) { all.set(chunk, at); at += chunk.length }
  return all
}

export interface RecoveryCaptureOptions {
  /** The page's fetch (tests pass their own). */
  readonly fetchImpl?: typeof fetch
  readonly origin?: string
  readonly now?: () => number
  readonly maxBytes?: number
  /** Told which route is being read, before each read. */
  readonly onRoute?: (route: RecoveryRoute) => void
}

/**
 * Read one route as this host serves it, once: same origin, the page's own cookie, never from a cache.
 * @param route - the route.
 * @param signal - aborts the read.
 * @param options - the fetch and the size bound.
 * @returns the part: captured, or not captured with its status and why. Throws only when aborted.
 */
export async function fetchRecoveryPart(route: string, signal: AbortSignal, options: RecoveryCaptureOptions = {}): Promise<RecoveryPart> {
  const maxBytes = options.maxBytes ?? recoveryMaxBytesFor(route)
  let response: Response
  try {
    response = await (options.fetchImpl ?? globalThis.fetch)(route, { credentials: 'same-origin', cache: 'no-store', signal })
  } catch (error) {
    if (signal.aborted) throw error
    return missingPart(route, null, 'did not answer')
  }
  if (!response.ok) {
    // A refusal's body is not read: nothing of it goes in the file.
    await response.body?.cancel().catch(() => {})
    return missingPart(route, response.status, `answered ${String(response.status)}`)
  }
  let bytes: Uint8Array<ArrayBuffer> | null
  try { bytes = await readBounded(response, maxBytes) } catch (error) {
    if (signal.aborted) throw error
    return missingPart(route, response.status, 'the answer broke off')
  }
  if (bytes === null) return missingPart(route, response.status, `over ${mebibytes(maxBytes)}`)
  return recoveryPartOf(route, response.status, response.headers.get('content-type'), bytes, maxBytes)
}

/** A finished capture: the file, its name, and its JSON text ready to hand to the browser. */
export interface RecoveryCapture {
  readonly snapshot: RecoverySnapshot
  readonly name: string
  readonly json: string
}

/**
 * Read the four routes, one at a time and once each, and build the file.
 * @param signal - aborts the reads.
 * @param options - the fetch, the origin, the clock and the size bound.
 * @returns the capture. Throws only when aborted.
 */
export async function captureRecoverySnapshot(signal: AbortSignal, options: RecoveryCaptureOptions = {}): Promise<RecoveryCapture> {
  const parts: RecoveryPart[] = []
  const startedAt = (options.now ?? Date.now)()
  for (const route of RECOVERY_ROUTES) {
    options.onRoute?.(route)
    parts.push(await fetchRecoveryPart(route, signal, options))
  }
  const createdAt = (options.now ?? Date.now)()
  const snapshot = await buildRecoverySnapshot(parts, options.origin ?? globalThis.location.origin, createdAt, startedAt)
  return { snapshot, name: recoveryFileName(snapshot.epoch, createdAt), json: JSON.stringify(snapshot) }
}

/** The recovery button's state (`data-continuity-recovery-state` is its `kind`). */
export type RecoveryState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'reading'; readonly route: string | null }
  /** The Pearl and the mirror are in the file, and it was handed to the browser's download. */
  | { readonly kind: 'saved'; readonly name: string; readonly bytes: number; readonly parts: readonly RecoveryPart[] }
  /** The Pearl or the mirror is NOT in the file; it was handed over all the same. */
  | { readonly kind: 'incomplete'; readonly name: string; readonly bytes: number; readonly parts: readonly RecoveryPart[] }
  /** Nothing was handed over. */
  | { readonly kind: 'failed'; readonly reason: string }

const capturedOf = (parts: readonly RecoveryPart[]): string[] => parts.filter(part => part.ok).map(part => part.route)
const missingOf = (parts: readonly RecoveryPart[]): string[] =>
  parts.flatMap(part => (part.ok ? [] : [`${part.route} (${part.reason})`]))

/**
 * The state a finished capture leaves, before anything is handed over: `failed` when no part at all was captured (there
 * is nothing to keep), else `incomplete` or `saved`.
 * @param capture - the capture.
 * @param bytes - the file's size.
 * @returns the state.
 */
export function recoveryStateOf(capture: RecoveryCapture, bytes: number): RecoveryState {
  const { parts } = capture.snapshot
  if (!parts.some(part => part.ok)) return { kind: 'failed', reason: `no part was captured: ${missingOf(parts).join(', ')}` }
  return { kind: capture.snapshot.complete ? 'saved' : 'incomplete', name: capture.name, bytes, parts }
}

/**
 * What the line under the button says: exactly which parts are in the file and which are not, that the file was handed to
 * the browser (never that it was saved), and that no restore was tested.
 * @param state - the button's state.
 * @returns one line.
 */
export function recoveryWords(state: RecoveryState): string {
  if (state.kind === 'idle') return 'Download the published Pearl, the host’s facts, its estate and the whole mirror as one JSON file'
  if (state.kind === 'reading') return state.route === null ? 'Reading from this host…' : `Reading ${state.route} from this host…`
  if (state.kind === 'failed') return `Not saved: ${state.reason}`
  const captured = capturedOf(state.parts)
  const missing = missingOf(state.parts)
  const handed = `${state.name} (${(state.bytes / 1_048_576).toFixed(1)} MB)`
  const tail = 'this page cannot see whether it was saved. No restore from this file has been tested.'
  if (state.kind === 'incomplete') {
    return `INCOMPLETE. NOT captured: ${missing.join(', ')}. Captured: ${captured.join(', ')}. `
      + `Handed ${handed} to this browser’s download all the same, so what was read is not lost; ${tail}`
  }
  return `Handed ${handed} to this browser’s download; ${tail} `
    + (missing.length === 0 ? `Captured all ${String(captured.length)} parts: ${captured.join(', ')}.`
      : `Captured: ${captured.join(', ')}. NOT captured: ${missing.join(', ')}.`)
}
