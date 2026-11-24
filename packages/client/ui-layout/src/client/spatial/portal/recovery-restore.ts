// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The Aukora authors
/**
 * CHECK A RECOVERY SNAPSHOT AGAINST THIS EDGE (Continuity). The page this runs in is a LIVE edge (an empty edge serves
 * its own Restore page instead, deploy/cloudflare/src/recovery-restore-page.mjs), so this WRITES NOTHING. It answers one
 * question: is she, here and now, the one in this file?
 *
 *   1. Every part of the file is checked against its SHA-256 and the manifest, the same rules as the edge's restore
 *      (`recoveryRestoreKit.verifySnapshot`; a parity test runs both on the same files). The first part that fails is
 *      named and nothing more is read.
 *   2. Only the edge is asked (`GET /__x6/status` must say `runtime: 'cloudflare'`). Then `GET /_head/ball` and
 *      `GET /_mirror/export` give her HEAD and her mirror now.
 *   3. Same Pearl, epoch, receipt high-water and whole-mirror digest: "she is already here". Anything else is shown
 *      side by side and NOTHING IS WRITTEN: a live edge is never overwritten from a file, newer or older.
 * @module portal/recovery-restore
 */
import { canonicalJson } from '../aumlok/class3-approval.ts'
import { RECOVERY_ROUTES, RECOVERY_REQUIRED, RECOVERY_SCHEMA } from './recovery-snapshot.ts'

const RECEIPTS_PATH = '/dsh/home/auma/seed/receipts.v3.jsonl'
const CHECKPOINTS_PATH = '/dsh/home/auma/seed/checkpoints.v1.jsonl'
const SHA = /^[0-9a-f]{64}$/u
const encoder = new TextEncoder()

type Json = Record<string, unknown>
type Entry = readonly [string, Json]
const isRecord = (value: unknown): value is Json => value !== null && typeof value === 'object' && !Array.isArray(value)
const isSha = (value: unknown): value is string => typeof value === 'string' && SHA.test(value)
const hexOf = (digest: ArrayBuffer): string => [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
const sha256 = async (bytes: Uint8Array<ArrayBuffer> | string): Promise<string> =>
  hexOf(await globalThis.crypto.subtle.digest('SHA-256', typeof bytes === 'string' ? encoder.encode(bytes) : bytes))

function base64Bytes(text: unknown): Uint8Array<ArrayBuffer> | null {
  if (typeof text !== 'string' || text.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(text)) return null
  const binary = atob(text)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
  return bytes
}

/** Base64 exactly as the edge writes it (re-encoding the bytes gives the same text), as the edge's seed import requires. */
function canonicalBase64(text: unknown): boolean {
  const bytes = base64Bytes(text)
  if (bytes === null) return false
  let binary = ''
  for (let at = 0; at < bytes.length; at += 32_768) binary += String.fromCharCode(...bytes.subarray(at, at + 32_768))
  return btoa(binary) === text
}

/** What a restore must bring back exactly: the receipt chain's length, its tip, and the receipts file's bytes. */
export interface ReceiptHighWater {
  readonly receiptCount: number
  readonly lastReceiptSeq: number | null
  readonly lastReceiptHash: string | null
  readonly receiptsSha256: string
  readonly receiptsBytes: number
  readonly checkpointCount: number
}

/** She, as a file or an edge holds her: HEAD, receipts, and one digest over the whole mirror. */
export interface RecoveryHeadline {
  readonly epoch: number
  readonly ballId: string
  readonly highWater: ReceiptHighWater
  readonly mirrorSha256: string
}

async function receiptHighWater(entries: readonly Entry[]): Promise<ReceiptHighWater | null> {
  const file = (path: string): Json | null => entries.find(([entry, wire]) => entry === path && wire.kind === 'file')?.[1] ?? null
  const text = (wire: Json | null): { bytes: Uint8Array<ArrayBuffer>; text: string } | null => {
    const bytes = wire === null ? new Uint8Array(0) : base64Bytes(wire.b64)
    if (bytes === null) return null
    try { return { bytes, text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) } } catch { return null }
  }
  const receipts = text(file(RECEIPTS_PATH)), checkpoints = text(file(CHECKPOINTS_PATH))
  if (receipts === null || checkpoints === null) return null
  const lines = (value: string): string[] => value.split('\n').map(line => line.trim()).filter(Boolean)
  const rows = lines(receipts.text)
  let last: unknown = null
  try { last = rows.length > 0 ? JSON.parse(rows[rows.length - 1] ?? 'null') : null } catch { last = null }
  const tip = isRecord(last) ? last : {}
  const hash = tip.leafHash ?? tip.hash
  return { receiptCount: rows.length, lastReceiptSeq: Number.isSafeInteger(tip.seq) ? tip.seq as number : null,
    lastReceiptHash: isSha(hash) ? hash : null, receiptsSha256: await sha256(receipts.bytes), receiptsBytes: receipts.bytes.length,
    checkpointCount: lines(checkpoints.text).length }
}

/** One digest over the whole mirror: every entry AND every deletion marker (the same rule as the edge's restore kit). */
const mirrorDigest = (entries: readonly Entry[], resetPaths: readonly string[]): Promise<string> => sha256(canonicalJson({
  entries: entries.map(([path, wire]) => [path,
    wire.kind === 'dir' ? { kind: 'dir', mode: wire.mode } : { kind: 'file', mode: wire.mode, mtimeMs: wire.mtimeMs, b64: wire.b64 }]),
  resetPaths: [...resetPaths].sort() }))

/**
 * THE SECRET-PATH RULE: a copy of deploy/cloudflare/src/mirror-secret-paths.mjs `MIRROR_SECRET_NAMES` /
 * `MIRROR_SECRET_PREFIXES` / `MIRROR_SECRET_SUFFIX` / `secretShapedPart` (packages/ may not import deploy/), as the edge's
 * restore kit (recovery-restore.mjs) applies them; deploy/cloudflare/src/__tests__/recovery-restore.test.mjs fails when
 * they differ. A part matches when it is a secret name, or that name with ONE extra leading dot, followed by zero or more
 * suffix segments from a closed list (6 to 64 hex characters, digits, or tmp, temp, lock, bak, backup, old, new, next,
 * prev, orig, swp, swo, part, partial, takeover, each after `.`, `~`, `-` or `_`) and then an optional single `~`; or a
 * part starting with `.env`, `.aukora-` or `pepper.v1.`. A file saved before that rule may name such a path (a credentials temp copy, or
 * its deletion marker). The edge neither takes nor exports one now, so this check leaves it out exactly as the restore
 * does, and an old file shows the same memory digest here as at the edge. Only what the older rule admitted is left out
 * (`withheld`).
 */
export const RECOVERY_SECRET_NAMES: readonly string[] = Object.freeze(['.credentials.yaml', 'credentials.yaml', 'session.cap',
  '.afferent-probe', 'ed25519-keypair.json', '.credentials', '.ssh', '.aws', '.transport', 'pepper.v1'])
export const RECOVERY_SECRET_PREFIXES: readonly string[] = Object.freeze(['.env', '.aukora-', 'pepper.v1.'])
// What may follow a stem: suffix segments, then at most one `~`. One way to match each token (digits 1 to 5 or 65 and more;
// 6 to 64 are hex) and a lone `~` cannot start a segment, so the time stays linear in the name.
export const RECOVERY_SECRET_SUFFIX = new RegExp('^(?:[.~_-](?:[0-9a-fA-F]{6,64}|[0-9]{1,5}|[0-9]{65,}|'
  + 'tmp|temp|lock|bak|backup|old|new|next|prev|orig|swp|swo|part|partial|takeover))*~?$')
/** Whether one path part is a secret name, a temp, lock, backup or swap sibling of one, or carries a secret prefix. */
export const secretShapedPart = (part: string): boolean => RECOVERY_SECRET_PREFIXES.some(prefix => part.startsWith(prefix))
  || RECOVERY_SECRET_NAMES.some(name => [name, `.${name}`].some(stem => part.startsWith(stem) && RECOVERY_SECRET_SUFFIX.test(part.slice(stem.length))))
// What the edge refused before the rule (an exact secret name, `pepper.v1` aside, or a `.env` / `.aukora-` name): never exported.
const refusedBefore = (part: string): boolean => (part !== 'pepper.v1' && RECOVERY_SECRET_NAMES.includes(part))
  || ['.env', '.aukora-'].some(prefix => part.startsWith(prefix))
const withheldPath = (path: string): boolean => {
  const parts = path.split('/')
  return parts.some(secretShapedPart) && !parts.some(refusedBefore)
}

/**
 * What a restore of this file leaves out, said in plain words with the counts and nothing but the rule (no path, no
 * content; the rule may also match an ordinary name); null when nothing is. The same words as the edge's restore kit
 * (recovery-restore.mjs `leftOutWords`).
 * @param entries - entries left out.
 * @param markers - deletion markers left out.
 * @returns the sentence, or null.
 */
export function leftOutWords(entries: number, markers: number): string | null {
  if (!entries && !markers) return null
  const counted = [entries ? `${String(entries)}${entries === 1 ? ' entry' : ' entries'}` : '',
    markers ? `${String(markers)}${markers === 1 ? ' deletion marker' : ' deletion markers'}` : ''].filter(Boolean).join(' and ')
  return `${counted} matching the secret-path rule in this recovery file ${entries + markers === 1 ? 'was' : 'were'} left out: the edge does not keep paths matching that rule`
}

/** Deletion markers as a host exports them: strings under /dsh/, strictly sorted. */
function resetsOf(body: unknown): string[] | null {
  const value = isRecord(body) ? body.resetPaths : null
  if (!Array.isArray(value) || value.length > 20_000) return null
  const paths = value as unknown[]
  if (!paths.every((path, index) => typeof path === 'string' && path.startsWith('/dsh/') && (index === 0 || String(paths[index - 1]) < path))) return null
  return paths as string[]
}

function mirrorEntries(body: unknown): Entry[] | null {
  if (!isRecord(body) || !Array.isArray(body.entries)) return null
  const entries: Entry[] = []
  let previous = ''
  for (const item of body.entries as unknown[]) {
    if (!Array.isArray(item) || item.length !== 2 || typeof item[0] !== 'string' || item[0] <= previous || !isRecord(item[1])) return null
    const [path, wire] = item as [string, Json]
    previous = path
    // The edge import's rules (validateMirrorEntries), as the restore kit applies them: mode 0..0o777; a real file time.
    const mode = Number.isInteger(wire.mode) && (wire.mode as number) >= 0 && (wire.mode as number) <= 0o777
    const time = typeof wire.mtimeMs === 'number' && Number.isFinite(wire.mtimeMs) && wire.mtimeMs >= 0 && Number.isFinite(new Date(wire.mtimeMs).getTime())
    if (wire.kind === 'dir' && mode) entries.push([path, wire])
    else if (wire.kind === 'file' && mode && time && canonicalBase64(wire.b64)) entries.push([path, wire])
    else return null
  }
  return entries
}

/** A refusal: which rule, and which part when one part is to blame. */
export interface RecoveryRefusal { readonly ok: false; readonly code: string; readonly part?: string }
export type VerifiedRecovery = RecoveryHeadline & {
  readonly ok: true
  readonly parts: readonly string[]
  readonly withheld: number
  /** What a restore of this file leaves out (`leftOutWords`), or null. */
  readonly leftOut: string | null
}

/**
 * Check a parsed recovery file completely. Never throws for a bad file.
 * @param snapshot - the parsed JSON.
 * @returns what she is in the file, or the first rule it breaks.
 */
export async function verifyRecoveryFile(snapshot: unknown): Promise<VerifiedRecovery | RecoveryRefusal> {
  if (!isRecord(snapshot) || snapshot.schema !== RECOVERY_SCHEMA || !Array.isArray(snapshot.parts)) return { ok: false, code: 'RECOVERY_SCHEMA_INVALID' }
  const parts = snapshot.parts as unknown[]
  if (parts.length !== RECOVERY_ROUTES.length || parts.some((part, index) => !isRecord(part) || part.route !== RECOVERY_ROUTES[index])) {
    return { ok: false, code: 'RECOVERY_PARTS_INVALID' }
  }
  const records = parts as Json[]
  const captured: string[] = []
  for (const part of records) {
    const route = String(part.route)
    if (part.ok !== true) {
      if ((RECOVERY_REQUIRED as readonly string[]).includes(route)) return { ok: false, code: 'RECOVERY_PART_MISSING', part: route }
      if (part.sha256 !== null || part.bytes !== null) return { ok: false, code: 'RECOVERY_PART_HASH_MISMATCH', part: route }
      continue
    }
    const json = part.encoding === 'json' ? JSON.stringify(part.body) : undefined
    const bytes = part.encoding === 'json' ? (typeof json === 'string' ? encoder.encode(json) : null) : part.encoding === 'base64' ? base64Bytes(part.body) : null
    if (bytes === null || !isSha(part.sha256) || bytes.length !== part.bytes || await sha256(bytes) !== part.sha256) {
      return { ok: false, code: 'RECOVERY_PART_HASH_MISMATCH', part: route }
    }
    captured.push(route)
  }
  if (!isSha(snapshot.manifestSha256)
    || await sha256(canonicalJson(records.map(part => [part.route, part.sha256, part.bytes]))) !== snapshot.manifestSha256) {
    return { ok: false, code: 'RECOVERY_MANIFEST_MISMATCH' }
  }
  const ballBody = records[0]?.encoding === 'json' ? records[0].body : null
  const head = isRecord(ballBody) ? ballBody.head : null
  if (!isRecord(head) || !isSha(head.ballId) || !Number.isSafeInteger(head.epoch) || (head.epoch as number) < 1) {
    return { ok: false, code: 'RECOVERY_PART_SHAPE_INVALID', part: '/_head/ball' }
  }
  const entries = records[3]?.encoding === 'json' ? mirrorEntries(records[3].body) : null
  const resets = records[3]?.encoding === 'json' ? resetsOf(records[3].body) : null
  const highWater = entries === null ? null : await receiptHighWater(entries)
  if (entries === null || resets === null || highWater === null) return { ok: false, code: 'RECOVERY_PART_SHAPE_INVALID', part: '/_mirror/export' }
  const kept = entries.filter(([path]) => !withheldPath(path)), keptResets = resets.filter(path => !withheldPath(path))
  const mirrorSha256 = await mirrorDigest(kept, keptResets)
  return { ok: true, epoch: head.epoch as number, ballId: head.ballId, highWater, mirrorSha256, parts: captured,
    withheld: entries.length - kept.length + resets.length - keptResets.length,
    leftOut: leftOutWords(entries.length - kept.length, resets.length - keptResets.length) }
}

/** The result of comparing a file with the edge, as the Estate card shows it. */
export type RecoveryCheck =
  | RecoveryRefusal & { readonly file?: RecoveryHeadline; readonly live?: RecoveryHeadline }
  | {
    readonly ok: true
    readonly verdict: 'already-here' | 'live-newer' | 'live-differs'
    readonly file: RecoveryHeadline
    readonly live: RecoveryHeadline
    /** What a restore of this file leaves out (`leftOutWords`), or null. */
    readonly leftOut: string | null
  }

const readJson = async (fetchImpl: typeof fetch, route: string, signal: AbortSignal): Promise<{ status: number; body: unknown }> => {
  const response = await fetchImpl(route, { credentials: 'same-origin', cache: 'no-store', signal })
  try {
    return { status: response.status, body: await response.json() as unknown }
  } catch { return { status: response.status, body: null } }
}

/**
 * Check a file, then compare it with this edge now. Writes nothing.
 * @param snapshot - the parsed file.
 * @param signal - aborts the reads.
 * @param fetchImpl - the page's fetch (tests pass their own).
 * @returns the comparison, or the refusal that stopped it.
 */
export async function checkRecoveryAgainstEdge(snapshot: unknown, signal: AbortSignal,
  fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis)): Promise<RecoveryCheck> {
  const verified = await verifyRecoveryFile(snapshot)
  if (!verified.ok) return verified
  const { epoch, ballId, highWater: fileHighWater, mirrorSha256 } = verified
  const file: RecoveryHeadline = { epoch, ballId, highWater: fileHighWater, mirrorSha256 }
  const status = await readJson(fetchImpl, '/__x6/status', signal)
  if (status.status !== 200 || !isRecord(status.body) || status.body.runtime !== 'cloudflare') return { ok: false, code: 'RECOVERY_EDGE_REQUIRED', file }
  const ball = await readJson(fetchImpl, '/_head/ball', signal)
  const exported = await readJson(fetchImpl, '/_mirror/export', signal)
  const head = isRecord(ball.body) ? ball.body.head : null
  const entries = mirrorEntries(exported.body)
  const resets = resetsOf(exported.body)
  const highWater = entries === null ? null : await receiptHighWater(entries)
  const headRead = isRecord(head) && isSha(head.ballId) && Number.isSafeInteger(head.epoch)
  if (!headRead || entries === null || resets === null || highWater === null) {
    return { ok: false, code: 'RECOVERY_EDGE_STATE_UNREADABLE', file }
  }
  const liveDigest = await mirrorDigest(entries, resets)
  const live: RecoveryHeadline = { epoch: head.epoch as number, ballId: head.ballId as string, highWater, mirrorSha256: liveDigest }
  const same = live.ballId === file.ballId && live.epoch === file.epoch && canonicalJson(live.highWater) === canonicalJson(file.highWater)
    && live.mirrorSha256 === file.mirrorSha256
  const newer = live.epoch > file.epoch || live.highWater.receiptCount > file.highWater.receiptCount
  return { ok: true, verdict: same ? 'already-here' : newer ? 'live-newer' : 'live-differs', file, live, leftOut: verified.leftOut }
}

const headline = (value: RecoveryHeadline): string => `epoch ${String(value.epoch)}, ${String(value.highWater.receiptCount)} receipts`
  + ` (last seq ${value.highWater.lastReceiptSeq === null ? 'none' : String(value.highWater.lastReceiptSeq)}), Pearl ${value.ballId.slice(0, 12)}…`

/**
 * One line for the card: what the file holds, what the edge holds, and that nothing was written.
 * @param check - the comparison.
 * @returns the line.
 */
export function recoveryCheckWords(check: RecoveryCheck): string {
  if (!check.ok) {
    const part = check.part === undefined ? '' : ` (part ${check.part})`
    if (check.code === 'RECOVERY_EDGE_REQUIRED') return 'Not checked: this page is not on the Cloudflare edge, and only the edge is compared. Nothing was written.'
    return `Refused: ${check.code}${part}. Nothing was written.`
  }
  const both = `File: ${headline(check.file)}. This edge now: ${headline(check.live)}.${check.leftOut === null ? '' : ` ${check.leftOut}.`}`
  if (check.verdict === 'already-here') return `She is already here: the same Pearl, epoch, receipts and memory as the file. ${both} Nothing to write.`
  if (check.verdict === 'live-newer') return `This edge is NEWER than the file. ${both} Nothing was written: a live edge is never overwritten from a file.`
  return `This edge DIFFERS from the file. ${both} Nothing was written: a file restores only into an empty edge, which then shows its own Restore page.`
}
