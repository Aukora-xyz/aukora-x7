// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The Aukora authors
/**
 * THE SOVEREIGNTY VIEW'S READERS AND WORDS (Rounds 24-25): the checkpoint key table, her verifier's anchoring words,
 * the AUMLOK pepper, and whether anything wakes her (the cards that show them: sovereignty-cards.ts, WakeCell.tsx).
 *
 *   Checkpoint signer  GET /__x6/facts (chainSigned, signerAnchored, signerStatus, the pin check), GET
 *                      /_host/checkpoint-policy (the key table), and her own seed_receipts verify when it says so
 *   Pepper             GET /_host/aumlok/status `pepperSeparated`
 *   Wake               GET/POST /_host/wake (the host's timer, its last wake receipt), and her own schedules through the
 *                      host's schedule service (`remote.schedule`: catalog, and `edit` with `active` false or true)
 *
 * A field a host does not send is never read as a pass; the cards show nothing for it.
 * @module portal/sovereignty-panels
 */
import type { SignerAnchoring } from '../work/host-facts.ts'
import type { WakeRead, WakeStatus } from '../work/autonomy.ts'

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const HEX_64 = /^[0-9a-f]{64}$/u

/** One range of the host's checkpoint key table (`aukora.checkpoint-policy.v1`). */
export interface CheckpointKeyRange {
  readonly firstSeq: number
  readonly lastSeq: number
  readonly envelope: string
  readonly publicKeyHex: string
}
/**
 * Read `/_host/checkpoint-policy`. Every range must be whole; one odd range refuses the answer.
 * @param body - the host's JSON answer.
 * @returns the ranges, or null when the answer is not the key table.
 */
export function parseCheckpointPolicy(body: unknown): readonly CheckpointKeyRange[] | null {
  if (!isRecord(body) || body.schema !== 'aukora.checkpoint-policy.v1' || !Array.isArray(body.ranges) || body.ranges.length > 32) return null
  const ranges: CheckpointKeyRange[] = []
  for (const range of body.ranges as unknown[]) {
    if (!isRecord(range) || !Number.isSafeInteger(range.firstSeq) || !Number.isSafeInteger(range.lastSeq)
      || Number(range.firstSeq) < 1 || Number(range.lastSeq) < Number(range.firstSeq)
      || typeof range.envelope !== 'string' || !/^v\d{1,2}$/u.test(range.envelope)
      || typeof range.publicKeyHex !== 'string' || !HEX_64.test(range.publicKeyHex)) return null
    ranges.push({ firstSeq: Number(range.firstSeq), lastSeq: Number(range.lastSeq), envelope: range.envelope,
      publicKeyHex: range.publicKeyHex })
  }
  return ranges
}

/** The key table in words: "seq 1 v1 baf94a77… · seq 2–6 v1 a2ddc722…". */
export function keyTableWords(ranges: readonly CheckpointKeyRange[]): string {
  if (ranges.length === 0) return 'empty: the host names no checkpoint key'
  return ranges.map(range => `seq ${range.firstSeq === range.lastSeq ? String(range.firstSeq) : `${String(range.firstSeq)}–${String(range.lastSeq)}`} `
    + `${range.envelope} ${range.publicKeyHex.slice(0, 8)}…`).join(' · ')
}

/** The key-table read, as the card holds it. */
export type KeyTableRead =
  | { readonly kind: 'reading' }
  | { readonly kind: 'ok'; readonly ranges: readonly CheckpointKeyRange[] }
  | { readonly kind: 'failed'; readonly reason: string }

/**
 * Her own verifier's anchoring words, when its answer carries them (the Round 23 organ, once promoted, says them).
 * @param receipts - her seed_receipts verify answer as the bridge reported it.
 * @returns the anchoring, all null when it says nothing.
 */
export function organAnchoring(receipts: unknown): SignerAnchoring {
  const root = isRecord(receipts) ? receipts : {}
  const flag = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null)
  return {
    chainSigned: flag(root.chainSigned),
    signerAnchored: flag(root.signerAnchored),
    signerStatus: typeof root.signerStatus === 'string' && /^[a-z][a-z0-9-]{0,47}$/u.test(root.signerStatus) ? root.signerStatus : null,
  }
}

/**
 * The AUMLOK pepper, as the host says it is kept.
 * @param separated - the status's `pepperSeparated` (null when the host does not say).
 * @param bound - whether a root is sealed here (an unbound host reports false: there is nothing to keep apart yet).
 * @returns one line.
 */
export function pepperWords(separated: boolean | null, bound = true): string {
  if (separated === null) return 'not reported by this host'
  if (!bound && !separated) return 'nothing is sealed on this host yet, so there is no pepper to keep apart'
  return separated
    ? 'separated: kept apart from the store that holds your sealed root (the host says), so that store alone cannot test your words'
    : 'NOT separated: kept in the same store as your sealed root (the host says), so a copy of it could test guesses at your words'
}

// ---------------------------------------------------------------------------------------------------------------------
// WAKE
// ---------------------------------------------------------------------------------------------------------------------

/** A Remote answer, in the shape the host's typed Remote returns it. */
export type RemoteAnswer<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: { readonly code: string } }
/** The one edit this view makes to a schedule: pause or resume it, at the revision it was read at. */
export interface ScheduleActiveEdit {
  readonly id: string
  readonly action: 'update'
  readonly patch: { readonly active: boolean }
  readonly expectedUpdatedAt?: string | null
}
/** The host's schedule service, as far as this view uses it. */
export interface ScheduleApi {
  readonly catalog: () => Promise<RemoteAnswer<readonly unknown[]>>
  readonly edit: (request: ScheduleActiveEdit) => Promise<RemoteAnswer<unknown>>
}
/** Where the schedule service is, once the Remote provides it (it may never: then the card says so). */
export interface ScheduleDoor {
  readonly current: () => ScheduleApi | null
  readonly set: (api: ScheduleApi | null) => void
}
/** @returns an empty door. */
export function createScheduleDoor(): ScheduleDoor {
  let api: ScheduleApi | null = null
  return { current: () => api, set: (next) => { api = next } }
}

/** One of her schedules, as this view shows it. */
export interface ScheduleRow {
  readonly id: string
  readonly title: string
  readonly status: 'active' | 'paused' | 'ended'
  /** "every 24 h", "cron 0 9 * * *", or the kind. */
  readonly rule: string
  readonly nextAt: string | null
  readonly updatedAt: string | null
  readonly lastDeliveredAt: string | null
  readonly running: boolean
}
/**
 * Read the schedule catalog's entries; an entry this view cannot read is left out and counted.
 * @param entries - the catalog.
 * @returns the rows, and how many were left out.
 */
export function scheduleRowsOf(entries: readonly unknown[]): { readonly rows: readonly ScheduleRow[]; readonly unread: number } {
  const rows: ScheduleRow[] = []
  let unread = 0
  for (const entry of entries) {
    if (!isRecord(entry) || typeof entry.id !== 'string' || entry.id === '' || !['active', 'paused', 'ended'].includes(String(entry.status))) {
      unread += 1
      continue
    }
    const every = typeof entry.everySeconds === 'number' && Number.isSafeInteger(entry.everySeconds) && entry.everySeconds > 0 ? entry.everySeconds : null
    const rule = every !== null ? `every ${everyWords(every * 1000)}`
      : entry.kind === 'cron' && typeof entry.expression === 'string' ? `cron ${entry.expression.slice(0, 40)}`
        : typeof entry.kind === 'string' ? entry.kind : 'schedule'
    const text = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)
    rows.push({
      id: entry.id,
      title: (text(entry.title) ?? entry.id).slice(0, 80),
      status: entry.status as ScheduleRow['status'],
      rule,
      nextAt: text(entry.scheduledAt),
      updatedAt: text(entry.updatedAt),
      lastDeliveredAt: isRecord(entry.lastDelivery) ? text(entry.lastDelivery.deliveredAt) : null,
      running: entry.executionActive === true,
    })
  }
  return { rows, unread }
}

/** How long a call to the schedule service may take before the card says it got no answer. */
export const SCHEDULE_CALL_MS = 10_000
/**
 * A Remote call with a deadline (the schedule service's own calls have none), so a card never waits on one for good.
 * @param promise - the call.
 * @param ms - the deadline.
 * @returns the call's answer, or a rejection saying none came in time.
 */
export function withDeadline<T>(promise: Promise<T>, ms = SCHEDULE_CALL_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { reject(new Error(`no answer within ${String(ms / 1000)} s`)) }, ms) })
  return Promise.race([promise, late]).finally(() => { clearTimeout(timer) })
}

/** The schedule catalog read. */
export type ScheduleRead =
  | { readonly kind: 'reading' }
  | { readonly kind: 'ok'; readonly rows: readonly ScheduleRow[]; readonly unread: number }
  /** The page has no schedule service, or the host refused the catalog. */
  | { readonly kind: 'unavailable'; readonly reason: string }

/**
 * Read her schedules through the door.
 * @param door - the schedule service door.
 * @returns the read.
 */
export async function readSchedules(door: ScheduleDoor | undefined): Promise<ScheduleRead> {
  const api = door?.current() ?? null
  if (api === null) return { kind: 'unavailable', reason: 'this page has no schedule service on this host' }
  try {
    const answer = await withDeadline(api.catalog())
    if (!answer.ok) return { kind: 'unavailable', reason: `the host refused the schedule catalog (${answer.error.code})` }
    return { kind: 'ok', ...scheduleRowsOf(answer.value) }
  } catch (error) {
    return { kind: 'unavailable', reason: error instanceof Error ? error.message : String(error) }
  }
}

const when = (value: number | string | null): string => {
  if (value === null) return '—'
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date.toISOString().replace('.000Z', 'Z') : String(value)
}

/**
 * Whether anything would wake her, said only as far as both sources were read: the host's timer, and the host's
 * scheduled tasks (hers and yours: each delivers a prompt that wakes an agent).
 *   active       the timer is on, or a task is active
 *   unconfirmed  nothing read is active, but a source was not read, or holds tasks this page cannot read
 *   paused       both read, and nothing is active
 */
export interface WakeState {
  readonly kind: 'reading' | 'active' | 'unconfirmed' | 'paused'
  readonly timer: 'reading' | 'on' | 'off' | 'none' | 'unread'
  readonly activeTasks: number
  readonly tasks: 'reading' | 'read' | 'partly-read' | 'unread'
}
/**
 * @param host - the host timer read (null while reading).
 * @param schedules - the scheduled tasks read.
 * @returns the state.
 */
export function wakeStateOf(host: WakeRead | null, schedules: ScheduleRead): WakeState {
  const timer = host === null ? 'reading' : host.kind === 'absent' ? 'none' : host.kind === 'refused' ? 'unread' : host.status.enabled ? 'on' : 'off'
  const activeTasks = schedules.kind === 'ok' ? schedules.rows.filter(row => row.status === 'active').length : 0
  const tasks = schedules.kind === 'reading' ? 'reading' : schedules.kind === 'unavailable' ? 'unread' : schedules.unread > 0 ? 'partly-read' : 'read'
  const kind = timer === 'on' || activeTasks > 0 ? 'active'
    : timer === 'reading' || tasks === 'reading' ? 'reading'
      : timer === 'unread' || tasks !== 'read' ? 'unconfirmed' : 'paused'
  return { kind, timer, activeTasks, tasks }
}
/** The card's one-line summary of the state. */
export function wakeSummaryWords(state: WakeState): string {
  if (state.kind === 'reading') return 'Reading…'
  const timer = { reading: 'timer reading', on: 'timer ON', off: 'timer paused', none: 'no host timer', unread: 'timer not read' }[state.timer]
  const tasks = state.tasks === 'reading' ? 'tasks reading…' : state.tasks === 'unread' ? 'tasks not read'
    : `${String(state.activeTasks)} active task${state.activeTasks === 1 ? '' : 's'}${state.tasks === 'partly-read' ? ' (some not read)' : ''}`
  return `${timer} · ${tasks}`
}

/** An interval in words: "24 h", "90 min". */
export function everyWords(ms: number): string {
  if (ms % 60_000 !== 0) return `${String(Math.round(ms / 1000))} s`
  const minutes = ms / 60_000
  return minutes % 60 === 0 ? `${String(minutes / 60)} h` : `${String(minutes)} min`
}

/** The host timer's line. */
export function hostTimerWords(host: WakeRead | null): string {
  if (host === null) return 'reading…'
  if (host.kind === 'absent') return 'this host serves no wake timer'
  if (host.kind === 'refused') return `not read (${host.detail})`
  const w: WakeStatus = host.status
  if (!w.enabled) return w.autoPaused === true ? 'PAUSED by the host itself, after wakes nobody acknowledged' : 'PAUSED (off)'
  const every = w.intervalMs === null ? 'at an interval it does not say' : `every ${everyWords(w.intervalMs)}`
  if (w.scheduleStatus === 'alarm_missing') return `ON, ${every}, but the host says no alarm is set (alarm_missing): it may not wake her`
  return `ACTIVE: ${every}${w.nextWakeAt === null ? '' : `, next ${when(w.nextWakeAt)}`}`
}

/** The last wake receipt the host keeps. */
export function lastWakeWords(host: WakeRead | null): string {
  if (host?.kind !== 'ok') return '—'
  const w = host.status
  const receipt = w.lastReceipt
  if (receipt !== null) {
    return [receipt.wakeId, when(receipt.at), receipt.trigger, receipt.headEpoch === null ? null : `Pearl epoch ${String(receipt.headEpoch)}`,
      receipt.status].filter((word): word is string => word !== null && word !== '—').join(' · ')
  }
  if (w.neverWoke) return 'none: it has never woken her'
  return w.lastWakeAt === null ? 'not reported' : `${when(w.lastWakeAt)}${w.lastWakeOutcome === null ? '' : ` · ${w.lastWakeOutcome}`}`
}

/** One schedule's line. */
export function scheduleWords(row: ScheduleRow): string {
  const state = row.status === 'active' ? 'ACTIVE' : row.status === 'paused' ? 'PAUSED' : 'ended'
  const next = row.status === 'active' && row.nextAt !== null ? `, next ${when(row.nextAt)}` : ''
  const last = row.lastDeliveredAt === null ? 'never delivered' : `last delivered ${when(row.lastDeliveredAt)}`
  return `${state} · ${row.rule}${next} · ${last}${row.running ? ' · running now' : ''}`
}
