// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The Aukora authors
/**
 * LIVE REACTION: what Auma is doing right now, turned into pulses on the Pentora.
 *
 * X6.1 (SOURCE): the predecessor read a per-tool `auraActivity` projection that x6.1 never sets. This file reads what the
 * x6.1 client really holds for a root surface instead, and says exactly how fine it is:
 *
 *   useSessionStatus  per Session: `running` (the Agent's live running state) and `pendingInteraction`. An approval
 *                     request carries its `toolName`: that is the ONLY per-tool name a root surface can see.
 *   useSessions       per Session: `running`, `updatedAt` (advanced by durable messages) and, for Sessions this
 *                     client has opened, the `sessionStats` projection (closed model steps, summed tool wall time).
 *
 * So the real granularity is: a turn opening or closing; a model step closing (Body); some tool call finishing (its
 * name is not exposed, so it wakes the whole figure); a tool asking approval (its name, mapped to an organ); a question
 * waiting (Gate & Aura); a Session's durable activity time moving. A change becomes a pulse only when it is NEW since
 * this view first saw the Session, so opening the page never replays history. Nothing here is scripted.
 */
import type { OrganWire } from './tables.ts'

/** The organ an activity row belongs to; null wakes the whole figure. */
export type ActivityOrgan = OrganWire | null

/** Recent activity keeps the figure in its working state this long after the last real change. */
export const WORKING_WINDOW_MS = 45_000

/** One Session's live facts, read from the stores (see the module comment). */
export interface SessionFacts {
  readonly id: string
  readonly title: string
  /** The Agent is running a turn now. */
  readonly running: boolean
  /** Host `updatedAt` (ms), advanced by durable messages; null when absent. */
  readonly updatedAt: number | null
  /** `sessionStats.steps`: closed model steps; null when this client holds no stats for the Session. */
  readonly steps: number | null
  /** `sessionStats.toolMs`: summed tool wall time; null when absent. */
  readonly toolMs: number | null
  /** The highest-precedence request waiting on the user, or null. */
  readonly pending: { readonly key: string; readonly kind: string; readonly toolName: string | null } | null
}

export interface LivePulse {
  readonly id: string
  readonly organ: ActivityOrgan
  /** When this view saw it (client clock), for the decay. */
  readonly at: number
  /** 0.2 .. 1.0: how hard it lights its organ. */
  readonly energy: number
  readonly label: string
  readonly outcome?: 'ok' | 'error' | 'door-asked' | 'door-refused'
  readonly session: string
  readonly source: 'session-status' | 'session-list' | 'session-stats'
}

export interface LiveState {
  pulses: LivePulse[]
  /** A turn is open, a request is waiting, or a real change landed in the last 45 s. */
  working: boolean
  /** The newest real activity time seen (ms), or null before any. */
  lastActivityAt: number | null
}

export const EMPTY_LIVE: LiveState = { pulses: [], working: false, lastActivityAt: null }

const KEEP = 60
/** A pulse's energy halves in about 1.7 s. */
const DECAY_MS = 2500

const ORGAN_WORDS: readonly (readonly [OrganWire, RegExp])[] = [
  ['aumlok', /owner[-_ ]?grant|aumlok|passkey|webauthn|auth/u],
  ['gate-aura', /receipt|verify|mandate|confirm|gate|approv/u],
  ['kira', /kira|memory|recall|remember|dag/u],
  ['network', /github|cloudflare|connector|web|fetch|http|mcp/u],
  ['body', /tree[-_]?patch|pearl[-_]?put|ball[-_]?put|self[-_]?apply|repo|model|write|edit|patch|apply|bash|shell|exec/u],
]

/**
 * Which organ a tool or event name belongs to; the first matching organ wins, in canon order.
 * @param name - a tool name or event kind.
 * @returns the organ, or null when no organ claims it (it wakes the whole figure).
 */
export function organOfTool(name: string): ActivityOrgan {
  const lower = name.toLowerCase()
  for (const [organ, words] of ORGAN_WORDS) if (words.test(lower)) return organ
  return null
}

const clampEnergy = (value: number): number => Math.min(1, Math.max(0.2, value))

function pendingLabel(pending: NonNullable<SessionFacts['pending']>): { label: string; organ: ActivityOrgan } {
  if (pending.kind === 'approval') {
    const tool = pending.toolName ?? 'a tool'
    return { label: tool, organ: pending.toolName === null ? null : organOfTool(pending.toolName) }
  }
  if (pending.kind === 'question') return { label: 'a question', organ: 'gate-aura' }
  return { label: pending.kind, organ: organOfTool(pending.kind) }
}

/** What changed in one Session since the last look, as pulses. */
function diff(before: SessionFacts, after: SessionFacts, now: number): LivePulse[] {
  const out: LivePulse[] = []
  const add = (
    key: string, organ: ActivityOrgan, energy: number, label: string, source: LivePulse['source'], outcome?: LivePulse['outcome'],
  ) => {
    out.push({
      id: `${after.id}:${key}:${String(now)}`, organ, at: now, energy: clampEnergy(energy), label, session: after.title, source,
      ...(outcome === undefined ? {} : { outcome }),
    })
  }
  if (!before.running && after.running) add('turn-open', null, 0.8, 'turn opened', 'session-status')
  if (before.running && !after.running) add('turn-close', null, 0.3, 'turn closed', 'session-status')
  if (after.steps !== null && before.steps !== null && after.steps > before.steps) {
    const steps = after.steps - before.steps
    add(`steps-${String(after.steps)}`, 'body', 0.5 + 0.1 * (steps - 1),
      steps === 1 ? 'model step closed' : `${String(steps)} model steps closed`, 'session-stats')
  }
  if (after.toolMs !== null && before.toolMs !== null && after.toolMs > before.toolMs) {
    const ms = after.toolMs - before.toolMs
    add(`tool-${String(after.toolMs)}`, null, 0.2 + ms / 20_000,
      `tool call finished · ${(ms / 1000).toFixed(1)} s (name not exposed)`, 'session-stats')
  }
  if (after.pending !== null && after.pending.key !== before.pending?.key) {
    const { label, organ } = pendingLabel(after.pending)
    add(`ask-${after.pending.key}`, organ, 1, `${label} · waiting on you`, 'session-status', 'door-asked')
  }
  if (before.pending !== null && after.pending?.key !== before.pending.key) {
    const { label, organ } = pendingLabel(before.pending)
    add(`done-${before.pending.key}`, organ, 0.5, `${label} · answered`, 'session-status')
  }
  if (after.updatedAt !== null && before.updatedAt !== null && after.updatedAt > before.updatedAt && out.length === 0) {
    add(`updated-${String(after.updatedAt)}`, null, 0.4, 'session activity', 'session-list')
  }
  return out
}

/**
 * Fold the Sessions' live facts into the live state; `baselines` remembers what each Session looked like last time.
 * @param live - the previous live state (returned unchanged when nothing moved).
 * @param baselines - per-Session facts from the previous look; updated in place.
 * @param sessions - the current facts.
 * @param now - client clock (ms).
 * @returns the next live state.
 */
export function absorbSessions(
  live: LiveState,
  baselines: Map<string, SessionFacts>,
  sessions: readonly SessionFacts[],
  now: number,
): LiveState {
  const fresh: LivePulse[] = []
  let busy = false
  let lastActivityAt = live.lastActivityAt
  const later = (at: number | null) => {
    if (at !== null && at <= now && (lastActivityAt === null || at > lastActivityAt)) lastActivityAt = at
  }
  for (const session of sessions) {
    if (session.running || session.pending !== null) busy = true
    later(session.updatedAt)
    const before = baselines.get(session.id)
    baselines.set(session.id, session)
    if (before === undefined) continue
    fresh.push(...diff(before, session, now))
  }
  if (fresh.length > 0) later(now)
  const working = busy || (lastActivityAt !== null && now - lastActivityAt < WORKING_WINDOW_MS)
  if (fresh.length === 0 && working === live.working && lastActivityAt === live.lastActivityAt) return live
  return { pulses: fresh.length === 0 ? live.pulses : [...live.pulses, ...fresh].slice(-KEEP), working, lastActivityAt }
}

/** Each organ's energy now (and `null` for activity that belongs to no organ, which wakes the whole figure). */
export function energyOf(live: LiveState, now: number): Map<ActivityOrgan, number> {
  const energy = new Map<ActivityOrgan, number>()
  for (const pulse of live.pulses) {
    const age = now - pulse.at
    if (age < 0 || age > DECAY_MS * 6) continue
    energy.set(pulse.organ, Math.min(1.6, (energy.get(pulse.organ) ?? 0) + pulse.energy * Math.exp(-age / DECAY_MS)))
  }
  return energy
}
