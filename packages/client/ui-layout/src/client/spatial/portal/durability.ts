// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The Aukora authors
/**
 * THE DURABILITY AND CONTINUITY STRIP (Sovereignty): eight facts, each read from a field a host actually serves, each with an
 * honest state when that field did not answer. This module is the pure projection (the reads the Sovereignty surface
 * already makes, once per opening and on Refresh, into the strip's tiles); it fetches nothing and polls nothing.
 *
 *   Live HEAD      epoch and Pearl id of the published head: GET /_head/ball `head.epoch`, `head.ballId`
 *                  (edge: deploy/cloudflare/src/head-do.mjs read() and the `/_head/ball` GET; Mac: server/local-host.mjs)
 *                  GET /api/health `liveHead` (the edge's telemetry read of the same head) is a second witness, never a
 *                  replacement: when it names a NEWER epoch than the head read shows, or another Pearl at the same epoch,
 *                  the tile says so (gold) until Refresh;
 *                  when /_head/ball did not answer, it is shown only if it is provably not the edge's fallback (the worker
 *                  answers `bootstrap.head`, the head at seeding, under the same name when its telemetry read fails, so a
 *                  liveHead equal to `bootstrap.head` is never shown as live). `bootstrap.head` itself is never displayed.
 *   Passkey        AUMLOK binding: GET /_host/aumlok/status `phase`/`bound`, `passkeyVerified`, `blockers`
 *                  (deploy/cloudflare/src/aumlok.mjs publicStatus; parsed by ../aumlok/aumlok-ceremony.ts parseAumlokStatus)
 *   Receipts       her own seed_receipts verify (`receiptsVerified`, ../work/bridge.ts BridgeReceipts) when fresh, else the
 *   Checkpoints    host's re-verification, GET /__x6/facts `receiptsVerified`/`receiptTotal`/`checkpointsTotal`
 *                  (server/verified-facts.mjs; parsed by ../work/host-facts.ts). A count is never shown as good while the
 *                  Keys card on the same screen raises its alarm: her verifier REJECTED the chain (red), or the host or her
 *                  verifier says `chainSigned: false`, or the host's checkpoint signer trust is `mismatch`/`invalid-pin`
 *                  (gold "NOT VERIFIED"; the same rule as keysCardOf chainBroken and signerAlarm, ./sovereignty-cards.ts).
 *   Aura drift     GET /__x6/status `aura`, on either host, so the tile says "her Aura on this host" (edge:
 *                  deploy/cloudflare/src/head-do.mjs, the status route returns readCloudAuraInputs `.aura`; Mac:
 *                  server/local-host.mjs; scored by server/aura-rules.mjs). The status route does not return the `handOffEpochMismatch`
 *                  boolean itself, so the tile reads what it does return: a `handoff-drift`/`epoch-mismatch` salience entry
 *                  means HANDOFF.md disagrees with the live head (alarm); `recommendedFocus` 'escalate-to-owner' (wake
 *                  urgency >= 0.7) is an alarm; `vector.driftRisk` < 0.4 proves no mismatch, because a mismatch alone adds
 *                  0.4 under scorer rules-v1 (aura-rules.mjs scoreSignals); otherwise the match is "not determined". An
 *                  Aura computed for another head than the HEAD tile shows (`aura.epoch`/`aura.ballId`) is never a verdict
 *                  about it ("other head", until Refresh). Incomplete evidence shows unavailable with the host's own gaps.
 *                  When the host serves `aura.handOffEpochMismatch` as a boolean (Wave 3 edge seam), that is read first:
 *                  true is the alarm, false is "in step" in the host's own word; absent or null falls back to the above.
 *   R2 cold backup GET /api/health `unsupported` (deploy/cloudflare/src/worker.mjs, the `/api/health` answer). Today it
 *                  lists 'cold-r2-backup', so the tile says "not built yet". The day the edge stops listing it, the tile
 *                  says so; no other field is read for it, because none exists yet.
 *   Provider       GET /api/health `providerUsage` (deploy/cloudflare/src/provider-budget.mjs readProviderBudgetUsage): per
 *   window         provider, the requests and model tokens RESERVED in its fixed window, beside the edge's limits. They are
 *                  conservative reservations the provider door makes before each request it forwards ("not provider
 *                  billing or exact token metering", the module's own words), so the tile says "reserved", never "spent".
 *                  The edge's own wake steps call a provider without a reservation (SOURCE, head-do.mjs
 *                  executeCloudWakeStep: an edge seam, handed off) and are not in the count; the note says so.
 *                  The edge reads the rows without a
 *                  clock, so a row may be from a window that has ended: only a window whose `windowResetAt` was still ahead
 *                  WHEN THE ANSWER WAS READ counts (the response's own `Date`, so the page's clock is not in it, and the
 *                  tile does not change between reads). It shows the fullest one's share of its limit, EXHAUSTED when the
 *                  edge would refuse that provider's next request (the request count at its limit, or less room left than
 *                  the smallest request reserves), and "idle" when none is current. It counts what passes through the
 *                  provider door; `providerUsage: null` (the edge could not read its telemetry) and a missing field each say so.
 *   Edge source    GET /api/health `buildSha`, which is `env.SOURCE_REVISION || 'UNVERIFIED'` (deploy/cloudflare/src/worker.mjs,
 *   revision       the `/api/health` answer): a [vars] value hand-stamped in deploy/cloudflare/wrangler.toml by
 *                  "stamp SOURCE_REVISION" commits (deploy/cloudflare/README.md step 4). It is NOT set by the build and can lag
 *                  the code actually running, so it is named "stamped", in a neutral tone, never as the deployed commit. No
 *                  route serves the commit Workers Builds deployed (handed off as an edge seam). On the Mac host, which has
 *                  no /api/health, the tile is the Mac checkout's commit from GET /_head/ball `buildSha`
 *                  (server/local-host.mjs getGitBuildSha), named as such.
 *
 * A number is shown only from a read of this opening. A read that failed shows "unavailable" with no number. Tile values
 * are kept short, because the primitive draws them on one clipped line (primitives.css .ak-stat__value nowrap/ellipsis):
 * every qualifier (stale, incomplete, locked, not verified, why) goes in the one line under the strip, which wraps, and
 * in the value's title with the full text.
 * @module portal/durability
 */
import type { AumlokHostRead } from '../aumlok/aumlok-ceremony.ts'
import type { HostFactsRead } from '../work/host-facts.ts'
import type { HostMode } from '../../spatial-components.tsx'
import type { LayoutKey } from '../locales.ts'
import { en } from '../locales.ts'
import { signerAlarm } from '../work/host-facts.ts'
import { herVerifierOf } from './sovereignty-cards.ts'
import { organAnchoring } from './sovereignty-panels.ts'

/** The strip's locale keys (the `layout` namespace). */
export type DurabilityKey = Extract<LayoutKey, `sovereignty.durability.${string}`>
/** A translator for the strip's keys, with `{name}` template params (the slot's `t` seat is one). */
export type DurabilityTranslate = (key: DurabilityKey, params?: Record<string, unknown>) => string

/** A tile's tone (the primitives' palette). */
export type DurabilityTone = 'mint' | 'blue' | 'gold' | 'red' | 'muted'
/**
 * What a tile's value is.
 *   live         a field answered in this opening, and this is what it said
 *   alarm        a field answered, and what it said is bad (a rejected or unsigned chain, a signer alarm)
 *   not-built    the edge itself lists the feature as unsupported
 *   reading      the read of this opening has not answered yet
 *   unavailable  the read failed or the host serves no such field: no value is shown
 */
export type DurabilityState = 'live' | 'alarm' | 'not-built' | 'reading' | 'unavailable'
export type DurabilityTileId = 'head' | 'aura' | 'passkey' | 'receipts' | 'checkpoints' | 'cold-backup' | 'spend' | 'source'
/** One tile of the strip. */
export interface DurabilityTile {
  readonly id: DurabilityTileId
  readonly name: string
  /** The short value drawn on the tile's one clipped line. */
  readonly value: string
  readonly tone: DurabilityTone
  readonly state: DurabilityState
  /** Why a tile is unavailable, or the qualifier on what it shows, for the line under the strip; null when nothing to add. */
  readonly detail: string | null
  /** The whole text (the full value, then the detail), for the value's title: nothing the tile means is only on a clipped line. */
  readonly title: string
}

/** The published head as the surface holds it (its `/_head/ball` answer, or why not). */
export type DurabilityHeadRead =
  | { readonly kind: 'idle' }
  | { readonly kind: 'ok'; readonly value: { readonly epoch: string; readonly ballId: string; readonly buildSha: string } }
  | { readonly kind: 'failed'; readonly reason: string }

/**
 * A raw JSON body the host-mode read already fetched (GET /__x6/status, GET /api/health), kept as the surface received it:
 * reading until it answers, the body when it answered 2xx JSON, or why not.
 */
export type EdgeBodyRead =
  | { readonly kind: 'reading' }
  /** `readAt`: when the answer was read (ms): the host's own `Date` header when it sent one, else this page's clock then. */
  | { readonly kind: 'ok'; readonly body: unknown; readonly readAt?: number }
  | { readonly kind: 'failed'; readonly reason: string }

/** Everything the strip projects: the reads the Sovereignty surface already made. */
export interface DurabilityInput {
  readonly head: DurabilityHeadRead
  readonly aumlok: AumlokHostRead
  /** Her own seed_receipts verify as the bridge passed it (null while reading). */
  readonly receipts: unknown
  /** True when the bridge's phase is `stale-snapshot`: her counts are not from the latest read. */
  readonly receiptsStale: boolean
  readonly facts: HostFactsRead
  readonly host: HostMode
  /** The `/__x6/status` body of the host-mode read (its `aura`). */
  readonly status: EdgeBodyRead
  /** The `/api/health` body of the host-mode read (its `providerUsage` and `liveHead`, when the edge serves them). */
  readonly health: EdgeBodyRead
  /**
   * Overrides the time the provider windows are judged at (tests). Absent: the health read's own `readAt`, so the tile says
   * what was true when the edge answered and never changes between reads.
   */
  readonly now?: number
}

/** The edge's own name for the cold backup in `/api/health` `unsupported` (deploy/cloudflare/src/worker.mjs). */
export const COLD_BACKUP_UNSUPPORTED = 'cold-r2-backup'

const HEX_COMMIT = /^[0-9a-f]{7,40}$/u
const BALL_ID = /^[0-9a-f]{64}$/u
const EPOCH = /^\d{1,15}$/u

/**
 * The English dictionary as a translator: used where the slot gave no `t` seat (a test render), never as a second copy.
 * @param key - a strip key.
 * @param params - `{name}` template params.
 * @returns the English text.
 */
export const englishDurability: DurabilityTranslate = (key, params) =>
  en[key].replace(/\{(\w+)\}/gu, (match, name: string) =>
    (params !== undefined && Object.hasOwn(params, name) ? String(params[name]) : match))

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

/** A tile before it is named; `full` is the untruncated value when the drawn one is shortened (a commit, a Pearl id). */
type Tile = Omit<DurabilityTile, 'id' | 'name' | 'title'> & { readonly full?: string }
const tileOf = (value: string, tone: DurabilityTone, state: DurabilityState, detail: string | null = null, full?: string): Tile =>
  (full === undefined ? { value, tone, state, detail } : { value, tone, state, detail, full })
const reading = (t: DurabilityTranslate): Tile => tileOf(t('sovereignty.durability.reading'), 'muted', 'reading')
const unavailable = (t: DurabilityTranslate, detail: string | null): Tile =>
  tileOf(t('sovereignty.durability.unavailable'), 'muted', 'unavailable', detail)

/** `/api/health` `liveHead` and `bootstrap.head`, as the edge names them (null when absent or not a head). */
export interface HealthHeads {
  readonly live: { readonly epoch: string; readonly ballId: string } | null
  readonly bootstrap: { readonly epoch: string; readonly ballId: string } | null
}
const headOf = (value: unknown): { readonly epoch: string; readonly ballId: string } | null => (isRecord(value)
  && typeof value.ballId === 'string' && BALL_ID.test(value.ballId) && typeof value.epoch === 'number' && Number.isSafeInteger(value.epoch)
  && value.epoch >= 0 ? { epoch: String(value.epoch), ballId: value.ballId } : null)
/**
 * Read the two heads an `/api/health` body names.
 * @param body - the health body.
 * @returns its `liveHead` and its `bootstrap.head`.
 */
export function healthHeadsOf(body: unknown): HealthHeads {
  if (!isRecord(body)) return { live: null, bootstrap: null }
  return { live: headOf(body.liveHead), bootstrap: headOf(isRecord(body.bootstrap) ? body.bootstrap.head : null) }
}

function headTile(read: DurabilityHeadRead, health: EdgeBodyRead, t: DurabilityTranslate): Tile {
  if (read.kind === 'idle') return reading(t)
  const heads = health.kind === 'ok' ? healthHeadsOf(health.body) : { live: null, bootstrap: null }
  const shown = (epoch: string, ballId: string, tone: DurabilityTone, detail: string | null): Tile =>
    tileOf(t('sovereignty.durability.head.value', { epoch, ball: ballId.slice(0, 8) }), tone, 'live', detail,
      t('sovereignty.durability.head.full', { epoch, ball: ballId }))
  const own = read.kind === 'ok' && EPOCH.test(read.value.epoch) && BALL_ID.test(read.value.ballId) ? read.value : null
  if (own === null) {
    const why = read.kind === 'failed' ? `/_head/ball ${read.reason}` : '/_head/ball named no epoch and Pearl id'
    // The edge's second witness, only when it is provably not its seeding-time fallback.
    return heads.live !== null && heads.live.ballId !== heads.bootstrap?.ballId
      ? shown(heads.live.epoch, heads.live.ballId, 'gold', t('sovereignty.durability.head.fromHealth', { why }))
      : unavailable(t, why)
  }
  // A newer head in the same opening's health read: the head shown is behind. (An older one is no news: the head is read
  // again on every live commit, the health body only on opening and Refresh; and the fallback is never newer.)
  if (heads.live !== null && Number(heads.live.epoch) > Number(own.epoch)) {
    return shown(own.epoch, own.ballId, 'gold', t('sovereignty.durability.head.behind', { epoch: heads.live.epoch }))
  }
  // The same epoch under another Pearl id: the two reads name different heads (never drawn as agreement).
  if (heads.live !== null && heads.live.epoch === own.epoch && heads.live.ballId !== own.ballId) {
    return shown(own.epoch, own.ballId, 'gold', t('sovereignty.durability.head.differs', { ball: heads.live.ballId.slice(0, 8) }))
  }
  return shown(own.epoch, own.ballId, 'mint', null)
}

function passkeyTile(read: AumlokHostRead, t: DurabilityTranslate): Tile {
  switch (read.kind) {
    case 'reading': return reading(t)
    case 'absent': return unavailable(t, 'this host serves no AUMLOK status')
    case 'refused': return unavailable(t, `this host refused its AUMLOK status (${read.code})`)
    case 'unreadable': return unavailable(t, 'this host’s AUMLOK status is not the expected shape')
    case 'live': {
      const status = read.status
      if (status.state !== 'bound') return tileOf(t('sovereignty.durability.passkey.none'), 'muted', 'live')
      if (!status.passkeyVerified) {
        return tileOf(t('sovereignty.durability.passkey.unverified'), 'gold', 'live', t('sovereignty.durability.passkey.unverifiedWhy'))
      }
      if (status.blockers.length > 0) {
        return tileOf(t('sovereignty.durability.passkey.locked'), 'gold', 'live',
          t('sovereignty.durability.passkey.lockedWhy', { blockers: status.blockers.join(', ') }))
      }
      return tileOf(t('sovereignty.durability.passkey.bound'), 'mint', 'live')
    }
  }
}

function factsTrouble(facts: HostFactsRead): string | null {
  switch (facts.kind) {
    case 'unavailable': return `/__x6/facts ${facts.reason}`
    case 'absent': return 'this host serves no /__x6/facts'
    case 'signed-out': return '/__x6/facts wants the owner sign-in'
    default: return null
  }
}

/**
 * What the Keys card on the same screen raises against the chain (sovereignty-cards.ts keysCardOf: `chainBroken` beyond a
 * rejection, and the `signerAlarm` badge), each as a reason; empty when it raises nothing.
 */
function chainAlarms(input: DurabilityInput, t: DurabilityTranslate): string[] {
  const read = input.facts.kind === 'ok' || input.facts.kind === 'incomplete' ? input.facts.facts : null
  const reasons: string[] = []
  const alarm = signerAlarm(input.facts)
  if (alarm !== null) {
    const trust = read?.checkpointSignerTrust
    reasons.push(trust === 'mismatch' ? t('sovereignty.durability.chain.signerMismatch')
      : trust === 'invalid-pin' ? t('sovereignty.durability.chain.signerPinInvalid') : alarm)
  }
  if (read?.anchoring.chainSigned === false) reasons.push(t('sovereignty.durability.chain.hostUnsigned'))
  if (organAnchoring(input.receipts).chainSigned === false) reasons.push(t('sovereignty.durability.chain.herUnsigned'))
  return reasons
}

/**
 * Receipts or checkpoints: a chain alarm first (never a good-looking count beside it), then her fresh verify, else the host's
 * own count, else her stale count marked stale, else why not.
 */
function countTile(which: 'receipts' | 'checkpoints', input: DurabilityInput, t: DurabilityTranslate): Tile {
  const her = herVerifierOf(input.receipts)
  const alarms = chainAlarms(input, t)
  if (her.kind === 'rejected') {
    return tileOf(t('sovereignty.durability.rejected'), 'red', 'alarm', [t('sovereignty.durability.chain.rejected', { stage: her.stage }),
      ...alarms].join('; '))
  }
  if (alarms.length > 0) return tileOf(t('sovereignty.durability.notVerified'), 'gold', 'alarm', alarms.join('; '))
  const herCount = her.kind === 'verified' ? (which === 'receipts' ? her.receipts : her.checkpoints) : null
  if (herCount !== null && !input.receiptsStale) return tileOf(String(herCount), 'mint', 'live')
  const facts = input.facts.kind === 'ok' || input.facts.kind === 'incomplete' ? input.facts.facts : null
  const incomplete = input.facts.kind === 'incomplete' || (facts !== null && !facts.complete)
  if (facts !== null) {
    const hostCount = which === 'receipts' ? facts.receiptsVerified : facts.checkpointsTotal
    if (hostCount !== null) {
      if (incomplete) return tileOf(String(hostCount), 'gold', 'live', t('sovereignty.durability.count.incomplete'))
      if (which === 'receipts' && facts.receiptTotal !== null && facts.receiptTotal !== hostCount) {
        return tileOf(t('sovereignty.durability.count.partial', { count: hostCount, total: facts.receiptTotal }), 'gold', 'live',
          t('sovereignty.durability.count.partialWhy', { count: hostCount, total: facts.receiptTotal }))
      }
      return tileOf(String(hostCount), 'mint', 'live')
    }
  }
  if (herCount !== null) return tileOf(String(herCount), 'gold', 'live', t('sovereignty.durability.count.stale'))
  if (her.kind === 'reading' || input.facts.kind === 'reading') return reading(t)
  const why = [her.kind === 'unchecked' ? `her verifier could not check (${her.stage ?? 'no stage named'})`
    : her.kind === 'no-verdict' ? `her verifier gave no verdict (${her.why})` : null,
  factsTrouble(input.facts) ?? (incomplete ? 'the host gives no count while its evidence is incomplete' : null)]
    .filter((part): part is string => part !== null).join('; ')
  return unavailable(t, why === '' ? null : why)
}

function hostTrouble(host: HostMode): string | null {
  switch (host.kind) {
    case 'signed-out': return 'the edge wants the owner sign-in'
    case 'unknown': return host.reason
    case 'cloudflare': return host.edge === null ? (host.edgeTrouble ?? '/api/health did not answer') : null
    default: return null
  }
}

const unit = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1

/** The `/__x6/status` `aura` fields the drift tile reads, or null when the body carries no `aukora.aura.v1`. */
export interface EdgeAuraRead {
  /** 'incomplete' when the edge could not complete its evidence (then no vector). */
  readonly status: string
  /** The scorer whose weights the in-step proof relies on ('rules-v1', server/aura-rules.mjs). */
  readonly scorer: string | null
  /** The head this Aura was computed for (head-do.mjs summary(): the same inspectLease as the status route's head). */
  readonly epoch: string | null
  readonly ballId: string | null
  readonly focus: string | null
  readonly driftRisk: number | null
  readonly wakeUrgency: number | null
  /** A `handoff-drift` salience entry with code `epoch-mismatch` (server/aura-rules.mjs rankSalience). */
  readonly handoffDrift: boolean
  /**
   * The host's own `aura.handOffEpochMismatch`, when it serves the boolean (Wave 3 edge seam): true or false as it says,
   * null when the field is absent or null (evidence incomplete), and then the tile infers as before.
   */
  readonly mismatchSaid: boolean | null
  readonly gaps: readonly string[]
}

/**
 * Read the edge Aura out of a `/__x6/status` body.
 * @param body - the status body.
 * @returns the fields, or null when there is no `aukora.aura.v1` there.
 */
export function edgeAuraOf(body: unknown): EdgeAuraRead | null {
  const aura = isRecord(body) ? body.aura : undefined
  if (!isRecord(aura) || aura.schema !== 'aukora.aura.v1' || typeof aura.status !== 'string') return null
  const vector = isRecord(aura.vector) ? aura.vector : null
  const salience = Array.isArray(aura.salience) ? aura.salience : []
  const epoch = typeof aura.epoch === 'number' && Number.isSafeInteger(aura.epoch) && aura.epoch >= 0 ? String(aura.epoch) : null
  return {
    status: aura.status,
    scorer: typeof aura.scorer === 'string' ? aura.scorer : null,
    epoch,
    ballId: typeof aura.ballId === 'string' && BALL_ID.test(aura.ballId) ? aura.ballId : null,
    focus: typeof aura.recommendedFocus === 'string' ? aura.recommendedFocus : null,
    driftRisk: vector !== null && unit(vector.driftRisk) ? vector.driftRisk : null,
    wakeUrgency: vector !== null && unit(vector.wakeUrgency) ? vector.wakeUrgency : null,
    handoffDrift: salience.some(item => isRecord(item) && item.kind === 'handoff-drift' && item.code === 'epoch-mismatch'),
    mismatchSaid: typeof aura.handOffEpochMismatch === 'boolean' ? aura.handOffEpochMismatch : null,
    gaps: (Array.isArray(aura.gaps) ? aura.gaps : []).filter((gap): gap is string => typeof gap === 'string'),
  }
}

const risk = (value: number): string => value.toFixed(2)

function auraTile(read: EdgeBodyRead, head: DurabilityHeadRead, t: DurabilityTranslate): Tile {
  if (read.kind === 'reading') return reading(t)
  if (read.kind === 'failed') return unavailable(t, read.reason)
  const aura = edgeAuraOf(read.body)
  if (aura === null) return unavailable(t, '/__x6/status carries no aukora.aura.v1')
  if (aura.status === 'incomplete' || aura.driftRisk === null || aura.wakeUrgency === null) {
    return unavailable(t, t('sovereignty.durability.aura.incompleteWhy', { gaps: aura.gaps.join(', ') || 'none named' }))
  }
  if (aura.epoch === null || aura.ballId === null) return unavailable(t, 'the Aura names no head it was computed for')
  // The Aura is a verdict about one head. The HEAD tile is read again on every live commit, the Aura only on opening and
  // Refresh: an Aura for another head than the one shown is never shown as a verdict about it.
  if (head.kind === 'ok' && (head.value.epoch !== aura.epoch || head.value.ballId !== aura.ballId)) {
    return tileOf(t('sovereignty.durability.aura.otherHead'), 'gold', 'live',
      t('sovereignty.durability.aura.otherHeadWhy', { epoch: aura.epoch, ball: aura.ballId.slice(0, 8) }))
  }
  const escalate = aura.focus === 'escalate-to-owner'
  const why: string[] = []
  // Either witness of a mismatch is an alarm: the host's own boolean (when it serves one), or the salience entry.
  const drifted = aura.handoffDrift || aura.mismatchSaid === true
  if (drifted) why.push(t('sovereignty.durability.aura.mismatchWhy', { epoch: aura.epoch }))
  if (escalate) why.push(t('sovereignty.durability.aura.escalateWhy', { urgency: risk(aura.wakeUrgency) }))
  if (drifted) return tileOf(t('sovereignty.durability.aura.mismatch'), 'red', 'alarm', why.join('; '))
  if (escalate) return tileOf(t('sovereignty.durability.aura.escalate'), 'red', 'alarm', why.join('; '))
  // The host says it outright: no inference from the drift risk is needed, under any scorer.
  if (aura.mismatchSaid === false) {
    return tileOf(t('sovereignty.durability.aura.inStep'), 'mint', 'live', null,
      t('sovereignty.durability.aura.inStepSaid', { epoch: aura.epoch }))
  }
  // Under rules-v1 a handoff epoch mismatch alone adds 0.4 to driftRisk (server/aura-rules.mjs scoreSignals), so below 0.4
  // there is none. Another scorer's weights prove nothing here.
  if (aura.scorer === 'rules-v1' && aura.driftRisk < 0.4) {
    return tileOf(t('sovereignty.durability.aura.inStep'), 'mint', 'live', null,
      t('sovereignty.durability.aura.inStepFull', { risk: risk(aura.driftRisk), epoch: aura.epoch }))
  }
  return tileOf(t('sovereignty.durability.aura.undetermined', { risk: risk(aura.driftRisk) }), 'gold', 'live',
    aura.scorer === 'rules-v1' ? t('sovereignty.durability.aura.undeterminedWhy', { risk: risk(aura.driftRisk) })
      : t('sovereignty.durability.aura.otherScorerWhy', { scorer: aura.scorer ?? 'unnamed' }))
}

/** One provider's reservation row in `/api/health` `providerUsage.providers`. */
export interface ProviderWindow {
  readonly provider: string
  readonly requests: number
  readonly tokens: number
  /** When its fixed window ends, by the edge's clock (ms). */
  readonly resetAt: number
}
/** `/api/health` `providerUsage`, as provider-budget.mjs readProviderBudgetUsage answers it. */
export type ProviderUsageRead =
  /** The body has no such field (an older edge). */
  | { readonly kind: 'absent' }
  /** The edge answered `providerUsage: null`: its telemetry read failed. */
  | { readonly kind: 'null' }
  | { readonly kind: 'unreadable' }
  /** No budget is configured: the edge refuses every provider request. */
  | { readonly kind: 'unconfigured' }
  | {
    readonly kind: 'ok'
    readonly windowMs: number
    readonly requestLimit: number
    readonly tokenLimit: number
    readonly windows: readonly ProviderWindow[]
  }

const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

/**
 * Read `providerUsage` out of an `/api/health` body.
 * @param body - the health body.
 * @returns the usage, or which way it is not there.
 */
export function providerUsageOf(body: unknown): ProviderUsageRead {
  if (!isRecord(body) || !Object.hasOwn(body, 'providerUsage')) return { kind: 'absent' }
  const usage = body.providerUsage
  if (usage === null) return { kind: 'null' }
  if (!isRecord(usage) || typeof usage.configured !== 'boolean') return { kind: 'unreadable' }
  if (!usage.configured) return { kind: 'unconfigured' }
  const limits = isRecord(usage.limits) ? usage.limits : null
  if (limits === null || !count(usage.windowMs) || usage.windowMs === 0 || !count(limits.requests) || limits.requests === 0
    || !count(limits.tokens) || limits.tokens === 0 || !isRecord(usage.providers)) return { kind: 'unreadable' }
  const windows: ProviderWindow[] = []
  for (const provider of Object.keys(usage.providers).sort()) {
    const row = usage.providers[provider]
    // A row that is not the shape the edge writes makes the whole field unread: a partial list would under-report.
    if (!isRecord(row) || !count(row.requestsReserved) || !count(row.tokensReserved) || !count(row.windowResetAt)) return { kind: 'unreadable' }
    windows.push({ provider, requests: row.requestsReserved, tokens: row.tokensReserved, resetAt: row.windowResetAt })
  }
  return { kind: 'ok', windowMs: usage.windowMs, requestLimit: limits.requests, tokenLimit: limits.tokens, windows }
}

const grouped = (value: number): string => String(value).replace(/\B(?=(\d{3})+(?!\d))/gu, ',')
const clock = (ms: number): string => new Date(ms).toISOString().slice(11, 19) + ' UTC'

/**
 * The least a model request (a POST) reserves at the provider door (provider-budget.mjs providerRequestReservation: its
 * bytes, plus 1,024, plus 256 for at least one message, plus an output ceiling of at least 1). With less room than this
 * left, the edge refuses every model request to that provider (`tokens + request > limit`); a GET /models listing reserves
 * 0 and still passes while the request count has room.
 */
export const PROVIDER_MIN_RESERVATION = 1024 + 256 + 1

function spendTile(host: HostMode, health: EdgeBodyRead, override: number | undefined, t: DurabilityTranslate): Tile {
  if (host.kind === 'reading') return reading(t)
  if (host.kind === 'local') return unavailable(t, 'the Mac host serves no /api/health')
  if (host.kind !== 'cloudflare' || host.edge === null) return unavailable(t, hostTrouble(host))
  if (health.kind === 'reading') return reading(t)
  if (health.kind === 'failed') return unavailable(t, health.reason)
  const usage = providerUsageOf(health.body)
  switch (usage.kind) {
    // Not a feature the edge lists as unsupported (that is 'not-built'): a field this host does not serve, so 'unavailable'.
    case 'absent': return tileOf(t('sovereignty.durability.spend.notServed'), 'muted', 'unavailable', t('sovereignty.durability.spend.notServedWhy'))
    case 'null': return unavailable(t, t('sovereignty.durability.spend.unreadWhy'))
    case 'unreadable': return unavailable(t, '/api/health providerUsage is not the shape this screen reads')
    case 'unconfigured': return tileOf(t('sovereignty.durability.spend.unconfigured'), 'gold', 'live', t('sovereignty.durability.spend.unconfiguredWhy'))
    case 'ok': break
  }
  // Judged at the time of the read, never at the time of drawing: the tile says what the edge's answer meant then.
  const now = override ?? health.readAt ?? Date.now()
  const limits = { requestLimit: grouped(usage.requestLimit), tokenLimit: grouped(usage.tokenLimit), read: clock(now) }
  // The edge reads the rows without a clock: a row whose window has ended no longer binds (the next request starts a new one).
  const share = (row: ProviderWindow): number => Math.max(row.requests / usage.requestLimit, row.tokens / usage.tokenLimit)
  const current = usage.windows.filter(row => row.resetAt > now).sort((a, b) => share(b) - share(a) || a.provider.localeCompare(b.provider))
  const [top, ...rest] = current
  if (top === undefined) {
    return tileOf(t('sovereignty.durability.spend.idle'), 'mint', 'live',
      t('sovereignty.durability.spend.idleWhy', { ...limits, minutes: Math.round(usage.windowMs / 60_000) }))
  }
  // The edge's own refusal rule (reserveProviderBudget): the request count at its limit, or no room for the request's tokens.
  const exhausted = (row: ProviderWindow): boolean => row.requests >= usage.requestLimit
    || usage.tokenLimit - row.tokens < PROVIDER_MIN_RESERVATION
  const words = (row: ProviderWindow): string => (exhausted(row) ? `${row.provider} ${t('sovereignty.durability.spend.exhausted')}`
    : `${row.provider} ${String(Math.floor(share(row) * 100))}%`)
  const others = rest.length === 0 ? '' : `; ${t('sovereignty.durability.spend.others', { list: rest.map(words).join(', ') })}`
  const full = current.find(exhausted)
  if (full !== undefined) {
    return tileOf(t('sovereignty.durability.spend.exhausted'), 'red', 'alarm',
      t('sovereignty.durability.spend.exhaustedWhy', { provider: full.provider, reset: clock(full.resetAt), read: clock(now) })
        + (current.length === 1 ? '' : `; ${t('sovereignty.durability.spend.others',
          { list: current.filter(row => row !== full).map(words).join(', ') })}`))
  }
  // Floored, so "100%" is only ever said by the exhausted tile above.
  const percent = Math.floor(share(top) * 100)
  return tileOf(t('sovereignty.durability.spend.reserved', { percent }), percent >= 80 ? 'gold' : 'mint', 'live',
    t('sovereignty.durability.spend.reservedWhy', { provider: top.provider, requests: grouped(top.requests), tokens: grouped(top.tokens),
      reset: clock(top.resetAt), ...limits }) + others)
}

function coldBackupTile(host: HostMode, t: DurabilityTranslate): Tile {
  if (host.kind === 'reading') return reading(t)
  if (host.kind === 'local') return unavailable(t, 'the Mac host serves no /api/health')
  if (host.kind !== 'cloudflare' || host.edge === null) return unavailable(t, hostTrouble(host))
  return host.edge.unsupported.includes(COLD_BACKUP_UNSUPPORTED)
    ? tileOf(t('sovereignty.durability.cold.notBuilt'), 'muted', 'not-built')
    // The edge no longer lists it as unsupported: that, and only that, is what it said (no field says it is built).
    : tileOf(t('sovereignty.durability.cold.unlisted'), 'blue', 'live', t('sovereignty.durability.cold.unlistedWhy',
      { name: COLD_BACKUP_UNSUPPORTED }))
}

function sourceTile(host: HostMode, head: DurabilityHeadRead, t: DurabilityTranslate): Tile & { readonly mac: boolean } {
  if (host.kind === 'reading') return { ...reading(t), mac: false }
  if (host.kind === 'local') {
    // The Mac's own checkout (git rev-parse at the host), not a GitHub fact: named as such.
    if (head.kind === 'idle') return { ...reading(t), mac: true }
    const sha = head.kind === 'ok' ? head.value.buildSha : ''
    return HEX_COMMIT.test(sha) ? { ...tileOf(sha.slice(0, 12), 'blue', 'live', null, sha), mac: true }
      : { ...unavailable(t, head.kind === 'failed' ? `/_head/ball ${head.reason}` : 'the Mac host named no checkout commit'), mac: true }
  }
  if (host.kind !== 'cloudflare' || host.edge === null) return { ...unavailable(t, hostTrouble(host)), mac: false }
  const sha = host.edge.buildSha ?? ''
  // A hand-stamped SOURCE_REVISION, not proof of the deployed commit: a neutral tone, and the title says so.
  const tile = HEX_COMMIT.test(sha) ? tileOf(sha.slice(0, 12), 'blue', 'live', null, t('sovereignty.durability.source.full', { sha }))
    // The edge answers 'UNVERIFIED' when it has no SOURCE_REVISION.
    : tileOf(t('sovereignty.durability.source.unstamped'), 'gold', 'live', t('sovereignty.durability.source.unstampedWhy'))
  return { ...tile, mac: false }
}

const titleOf = (tile: Tile): string => {
  const full = tile.full ?? tile.value
  return tile.detail === null ? full : `${full} — ${tile.detail}`
}
const named = (id: DurabilityTileId, name: string, tile: Tile): DurabilityTile =>
  ({ id, name, value: tile.value, tone: tile.tone, state: tile.state, detail: tile.detail, title: titleOf(tile) })

/**
 * Project the surface's reads into the strip's eight tiles.
 * @param input - the reads of this opening.
 * @param t - the translator (the slot's `t` seat).
 * @returns the tiles, in order.
 */
export function durabilityTilesOf(input: DurabilityInput, t: DurabilityTranslate): readonly DurabilityTile[] {
  const { mac, ...source } = sourceTile(input.host, input.head, t)
  return [
    named('head', t('sovereignty.durability.head'), headTile(input.head, input.health, t)),
    named('aura', t('sovereignty.durability.aura'), auraTile(input.status, input.head, t)),
    named('passkey', t('sovereignty.durability.passkey'), passkeyTile(input.aumlok, t)),
    named('receipts', t('sovereignty.durability.receipts'), countTile('receipts', input, t)),
    named('checkpoints', t('sovereignty.durability.checkpoints'), countTile('checkpoints', input, t)),
    named('cold-backup', t('sovereignty.durability.cold'), coldBackupTile(input.host, t)),
    named('spend', t('sovereignty.durability.spend'), spendTile(input.host, input.health, input.now, t)),
    named('source', t(mac ? 'sovereignty.durability.source.mac' : 'sovereignty.durability.source'), source),
  ]
}

/**
 * The one line under the strip (it wraps; the tiles do not): what each unavailable tile could not read, then the qualifier
 * on each tile that shows a value with one (stale, incomplete, locked, not verified). Null when no tile has anything to add.
 * @param tiles - the strip.
 * @param t - the translator.
 * @returns the line, or null.
 */
/**
 * The strip's two notes apart: what was not read (always shown), and the caveats (long; shown under a closed Details row).
 * @param tiles - the strip's tiles.
 * @param t - the translator.
 * @returns each note, or null when it has nothing to say.
 */
export function durabilityNotesOf(tiles: readonly DurabilityTile[], t: DurabilityTranslate)
  : { readonly notRead: string | null; readonly caveats: string | null } {
  const list = (want: (tile: DurabilityTile) => boolean): string =>
    tiles.filter(tile => tile.detail !== null && want(tile)).map(tile => `${tile.name}: ${String(tile.detail)}`).join(' · ')
  const notRead = list(tile => tile.state === 'unavailable')
  const caveats = list(tile => tile.state !== 'unavailable')
  return { notRead: notRead === '' ? null : t('sovereignty.durability.why', { list: notRead }),
    caveats: caveats === '' ? null : t('sovereignty.durability.caveats', { list: caveats }) }
}

export function durabilityNoteOf(tiles: readonly DurabilityTile[], t: DurabilityTranslate): string | null {
  const list = (want: (tile: DurabilityTile) => boolean): string =>
    tiles.filter(tile => tile.detail !== null && want(tile)).map(tile => `${tile.name}: ${String(tile.detail)}`).join(' · ')
  const notRead = list(tile => tile.state === 'unavailable')
  const caveats = list(tile => tile.state !== 'unavailable')
  const parts = [notRead === '' ? null : t('sovereignty.durability.why', { list: notRead }),
    caveats === '' ? null : t('sovereignty.durability.caveats', { list: caveats })].filter((part): part is string => part !== null)
  return parts.length === 0 ? null : parts.join(' — ')
}
