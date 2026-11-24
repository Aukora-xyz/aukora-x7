// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The Aukora authors
/**
 * THE SOVEREIGNTY CARDS, LIVE ONLY (Round 25): each card shows what a host or her own organ actually said, and nothing
 * whose only job is to say "not reported". A state that is live and bad (a signer mismatch, a chain that does not
 * verify, a rejected verify, a tab that differs from the host) always shows, first. Diagnostic rows sit in one closed
 * fold ("details"); explanations of where a word comes from are in the code, not on the screen.
 *
 *   Keys and trust  the bound passkey (GET /_host/aumlok/status), who signs her checkpoints (GET /__x6/facts, GET
 *                   /_host/checkpoint-policy) and how far that key is anchored, and the AUMLOK pepper
 *   Receipt chain   her own seed_receipts verify beside the host's re-verification (GET /__x6/facts)
 * @module portal/sovereignty-cards
 */
import type { AumlokApprovalRecord, AumlokHostRead } from '../aumlok/aumlok-ceremony.ts'
import { signerAlarm, taskWords, forecastWords, organSourceWords, type FactsAgreement, type HostFactsRead } from '../work/host-facts.ts'
import { keyTableWords, organAnchoring, pepperWords, type KeyTableRead } from './sovereignty-panels.ts'

/** A pill's tone. */
export type CardTone = 'mint' | 'blue' | 'gold' | 'red' | 'muted'
/** One card: its one line, its badge, the rows a source said, and the rows kept in its closed details fold. */
export interface CardView {
  readonly summary: string
  readonly badge: string
  readonly tone: CardTone
  readonly rows: readonly (readonly [string, string])[]
  readonly details: readonly (readonly [string, string])[]
}

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)

/**
 * The host's durable passkey approvals in words: how many are live, and what the first binds.
 * @param records - the status's approvedGrants.
 * @param now - the time (ms).
 * @returns one line.
 */
export function approvalsWords(records: readonly AumlokApprovalRecord[], now: number): string {
  const live = records.filter(record => record.consumedAt === null && record.expiresAt > now)
  if (records.length === 0) return 'none held by this host'
  const first = records[0]
  const what = first === undefined ? '' : first.binding.action === 'head.promote'
    ? `head.promote ${String(first.binding.organId)} epoch ${String(first.binding.epoch)}`
    : `${String(first.binding.method)} ${String(first.binding.pathname)}`
  return `${String(live.length)} live of ${String(records.length)} · ${what}${first?.consumedAt === null ? '' : ' (used)'}`
}

/** What the passkey part of the Keys and trust card shows. */
export interface OwnerAuthority {
  readonly summary: string
  readonly badge: string
  readonly tone: 'mint' | 'muted'
  readonly bound: boolean
  /** Rows the host said (the passkey always; pepper and approvals only when it reports them). */
  readonly rows: [string, string][]
  /** Kept in the details fold. */
  readonly details: [string, string][]
}
/**
 * The passkey bound to this node, from its host's AUMLOK status.
 * @param read - the status read.
 * @returns its summary, badge, tone, rows, and whether a usable passkey is bound.
 */
export function ownerAuthorityOf(read: AumlokHostRead): OwnerAuthority {
  if (read.kind === 'live') {
    const status = read.status
    const verified = status.state === 'bound' && status.passkeyVerified
    // A host that refuses every ceremony (a lock) is bound but not usable: it is said, never shown as ready.
    const bound = verified && status.blockers.length === 0
    const passkey = bound ? 'bound and verified (user verification required)'
      : verified ? `bound; refused now (${status.blockers.join(', ')})` : status.state === 'bound' ? 'bound, not verified'
        : status.enrollmentAvailable ? 'none bound; first binding is open'
          : `none bound; first binding is not open on this host (${status.blockers.join(', ') || 'enrollment unavailable'})`
    return {
      summary: bound ? 'passkey bound' : verified ? 'passkey LOCKED' : 'no passkey bound',
      badge: bound ? 'PASSKEY BOUND' : verified ? 'LOCKED' : 'NOT BOUND',
      tone: bound ? 'mint' : 'muted',
      bound,
      rows: [
        ['passkey', passkey],
        ...(status.approvedGrants.length === 0 ? [] : [['passkey approvals', approvalsWords(status.approvedGrants, Date.now())] as [string, string]]),
        // Nothing sealed (an unbound host says false): no pepper to speak of, so no row.
        ...(status.pepperSeparated === null || status.state !== 'bound' ? [] : [['pepper', pepperWords(status.pepperSeparated, true)] as [string, string]]),
      ],
      details: status.nodePubkeyHex === null ? [] : [['node key', status.nodePubkeyHex]],
    }
  }
  const why = read.kind === 'reading' ? 'reading…' : read.kind === 'absent' ? 'this host serves no AUMLOK status'
    : read.kind === 'refused' ? `this host refused its AUMLOK status (${read.code})` : 'this host’s AUMLOK status is not the expected shape'
  return { summary: read.kind === 'reading' ? 'reading…' : 'AUMLOK status not read', badge: read.kind === 'reading' ? 'READING' : 'NOT CONNECTED YET',
    tone: 'muted', bound: false, rows: [['passkey', why]], details: [] }
}

/** The stages of her receipts organ (seed-receipts verify) that are a verdict on the chain itself. */
const CHAIN_VERDICT_STAGES = new Set(['receipt-chain', 'checkpoint-fields', 'checkpoint-hash', 'checkpoint-signer', 'checkpoint-chain',
  'ed25519-signature', 'merkle-root'])
/**
 * Her checkpoint-policy stage (Round 26) judges the chain when the host's policy names no key for that checkpoint or another key:
 * a signer the owner's policy does not admit. A policy she could not read, or a signer kind she cannot check, is no verdict.
 */
const POLICY_VERDICT_CODES = new Set(['CHECKPOINT_SIGNER_POLICY_MISMATCH', 'CHECKPOINT_SIGNER_POLICY_EXPIRED'])
/** Her own seed_receipts verify, as this view receives it. */
export type HerVerifier =
  | { readonly kind: 'reading' }
  | { readonly kind: 'verified'; readonly receipts: number | null; readonly checkpoints: number | null; readonly merkleRoot: string | null }
  /** Rejected at a stage where it judged the chain. */
  | { readonly kind: 'rejected'; readonly stage: string }
  /** Answered not ok at a stage where it could not check (a key it could not read, no crypto): no verdict on the chain. */
  | { readonly kind: 'unchecked'; readonly stage: string | null }
  | { readonly kind: 'no-verdict'; readonly why: string }
/**
 * Read her verifier's answer as the bridge passed it.
 * @param receipts - the bridge's receipts read (null while reading).
 * @returns the verdict.
 */
export function herVerifierOf(receipts: unknown): HerVerifier {
  if (receipts === null) return { kind: 'reading' }
  if (!isRecord(receipts)) return { kind: 'no-verdict', why: 'no answer' }
  const count = (v: unknown): number | null => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null)
  if (receipts.kind === 'verified') {
    return { kind: 'verified', receipts: count(receipts.receiptsVerified), checkpoints: count(receipts.checkpointsVerified),
      merkleRoot: typeof receipts.merkleRoot === 'string' ? receipts.merkleRoot : null }
  }
  if (receipts.kind === 'rejected') {
    const named = typeof receipts.stage === 'string' ? receipts.stage : null
    const error = typeof receipts.error === 'string' && receipts.error !== '' ? receipts.error : null
    const stage = named === null ? error : error === null ? named : `${named}: ${error}`
    const verdict = named !== null && (CHAIN_VERDICT_STAGES.has(named) || (named === 'checkpoint-policy' && error !== null && POLICY_VERDICT_CODES.has(error)))
    return verdict && stage !== null ? { kind: 'rejected', stage } : { kind: 'unchecked', stage }
  }
  return { kind: 'no-verdict', why: typeof receipts.kind === 'string' ? receipts.kind : 'no answer' }
}

const signerPhrase = (trust: string | null): string | null => (trust === 'pinned' ? 'signer pinned' : trust === 'mismatch' ? 'signer MISMATCH'
  : trust === 'invalid-pin' ? 'signer pin INVALID' : trust === 'unpinned' ? 'signer not pinned' : null)
const signerRow = (trust: string | null): string | null => (trust === 'pinned' ? 'each checkpoint is signed by a key the host’s pin names'
  : trust === 'mismatch' ? 'MISMATCH: a checkpoint is signed by a key the host’s pin does not name'
    : trust === 'invalid-pin' ? 'the host’s pin is invalid, so no checkpoint key is checked'
      : trust === 'unpinned' ? 'not pinned on this host (or no checkpoint yet)' : null)

/**
 * KEYS AND TRUST: the bound passkey, who signs her checkpoints and how far that key is anchored, and the pepper.
 * @param aumlok - this host's AUMLOK status read.
 * @param facts - this host's facts read.
 * @param table - this host's checkpoint key table read.
 * @param receipts - her own seed_receipts verify answer (null while reading).
 * @returns the card, and whether a usable passkey is bound.
 */
export function keysCardOf(aumlok: AumlokHostRead, facts: HostFactsRead, table: KeyTableRead, receipts: unknown)
  : CardView & { readonly bound: boolean } {
  const owner = ownerAuthorityOf(aumlok)
  const read = facts.kind === 'ok' || facts.kind === 'incomplete' ? facts.facts : null
  const trust = read?.checkpointSignerTrust ?? null
  const host = read?.anchoring ?? { chainSigned: null, signerAnchored: null, signerStatus: null }
  const own = organAnchoring(receipts)
  const her = herVerifierOf(receipts)
  const anchored = host.signerAnchored ?? own.signerAnchored
  const status = host.signerStatus ?? own.signerStatus
  const chainBroken = host.chainSigned === false || own.chainSigned === false || her.kind === 'rejected'
  const rows: [string, string][] = [...owner.rows]
  const signer = signerRow(trust)
  if (signer !== null) rows.push(['checkpoint signer', signer])
  if (anchored !== null) {
    rows.push(['signer anchored', `${anchored ? 'yes, by the owner' : 'NO: not the owner’s key'}${status === null ? '' : ` (${status})`}`
      + ` · ${host.signerAnchored !== null ? 'the host says' : 'her verifier says'}`])
  }
  if (chainBroken) {
    rows.push(['chain', her.kind === 'rejected' && host.chainSigned !== false && own.chainSigned !== false
      ? `NOT verified: her verifier REJECTED it at ${her.stage}` : 'NOT verified: the signatures or roots over her receipt chain do not verify'])
  }
  const alarm = signerAlarm(facts)
  const badge = alarm !== null ? { badge: alarm, tone: 'gold' as const }
    : chainBroken ? { badge: 'CHAIN NOT VERIFIED', tone: 'gold' as const } : { badge: owner.badge, tone: owner.tone }
  const pepper = aumlok.kind === 'live' && aumlok.status.state === 'bound' && aumlok.status.pepperSeparated !== null
    ? (aumlok.status.pepperSeparated ? 'pepper separated' : 'pepper NOT separated') : null
  const summary = [owner.summary, chainBroken ? 'chain NOT verified' : null, signerPhrase(trust),
    anchored === null ? null : anchored ? 'owner-anchored' : 'NOT owner-anchored', pepper]
    .filter((phrase): phrase is string => phrase !== null).join(' · ')
  const details: [string, string][] = [...owner.details]
  if (table.kind === 'ok') details.push(['checkpoint keys', keyTableWords(table.ranges)])
  return { summary, ...badge, rows, details, bound: owner.bound }
}

/**
 * RECEIPT CHAIN: her own seed_receipts verify beside the host's re-verification of the same chain.
 * @param facts - this host's facts read.
 * @param agreement - this tab's numbers set beside the host's.
 * @param receipts - her own seed_receipts verify answer (null while reading).
 * @returns the card, and the notes on where the tab and host differ.
 */
export function chainCardOf(facts: HostFactsRead, agreement: FactsAgreement, receipts: unknown)
  : CardView & { readonly notes: readonly string[] } {
  const her = herVerifierOf(receipts)
  const read = facts.kind === 'ok' || facts.kind === 'incomplete' ? facts.facts : null
  const n = (value: number | null): string => (value === null ? '?' : String(value))
  const rows: [string, string][] = []
  if (her.kind === 'verified') rows.push(['her verifier', `verified ${n(her.receipts)} receipts and ${n(her.checkpoints)} checkpoints`])
  else if (her.kind === 'rejected') rows.push(['her verifier', `REJECTED her receipt chain at ${her.stage}`])
  else if (her.kind === 'unchecked') rows.push(['her verifier', `could not check her chain (${her.stage ?? 'it named no stage'})`])
  else if (her.kind === 'no-verdict') rows.push(['her verifier', `gave no verdict here (${her.why})`])
  // THE HOST'S OWN CHECK: its counts when it gives them; its incomplete evidence or its refusal when it does not. A host that
  // refused or could not stand behind its counts is a live state, shown in the card's line, never only in the fold.
  const incomplete = facts.kind === 'incomplete' || (read !== null && !read.complete)
  if (read !== null && read.receiptsVerified !== null && read.receiptTotal !== null) {
    const coverage = read.checkpointsTotal === null || read.checkpointsTotal === 0 ? ''
      : ` · checkpoint ${n(read.lastCheckpointSeq)} covers ${n(read.lastCheckpointReceiptCount)}`
    rows.push(['host check', `${String(read.receiptsVerified)} of ${String(read.receiptTotal)} receipts verified${coverage}`
      + `${incomplete ? ' · its evidence is INCOMPLETE' : ''}`])
  } else if (incomplete) {
    rows.push(['host check', 'INCOMPLETE: the host says its evidence is incomplete right now, so it gives no counts'])
  } else if (facts.kind === 'unavailable') {
    rows.push(['host check', `did not answer here (${facts.reason})`])
  }
  const hostTrouble = incomplete ? 'host evidence INCOMPLETE' : facts.kind === 'unavailable' ? 'host check did not answer' : null
  const details: [string, string][] = []
  if (her.kind === 'verified' && her.merkleRoot !== null) details.push(['merkle root', her.merkleRoot])
  if (read !== null) {
    if (read.dagReachable !== null && read.dagDeclared !== null) details.push(['memory DAG reachable', `${String(read.dagReachable)} of ${String(read.dagDeclared)}`])
    if (read.organCount !== null) details.push(['organs declared', `${String(read.organCount)} (${n(read.activeOrganCount)} enabled)`])
    if (read.node.organSourceCommit !== null) details.push(['organ source', organSourceWords(read.node, read.complete)])
    const task = read.survivor.task
    if (task !== 'absent' && task !== 'unreadable') details.push(['task accomplishment', taskWords(task)])
    const forecast = read.survivor.forecast
    if (forecast !== 'absent' && forecast !== 'unreadable') details.push(['forecast calibration', forecastWords(forecast)])
  }
  const notes = agreement.kind === 'lag' ? agreement.notes : []
  const receiptsCount = her.kind === 'verified' ? her.receipts : read?.receiptsVerified ?? null
  const checkpoints = her.kind === 'verified' ? her.checkpoints : read?.checkpointsTotal ?? null
  const agree = agreement.kind === 'match' ? 'tab and host agree' : agreement.kind === 'lag' ? 'tab and host DIFFER' : null
  const summary = her.kind === 'reading' && read === null ? 'Reading…'
    : her.kind === 'rejected' ? `her verifier REJECTED the chain at ${her.stage}`
      : [receiptsCount === null ? null : `${String(receiptsCount)} receipts`, checkpoints === null ? null : `${String(checkpoints)} checkpoints`, agree,
        hostTrouble]
        .filter((phrase): phrase is string => phrase !== null).join(' · ') || 'not verified here'
  const badge = her.kind === 'rejected' ? { badge: 'REJECTED', tone: 'red' as const }
    : agreement.kind === 'lag' ? { badge: 'TAB AND HOST DIFFER', tone: 'gold' as const }
      : her.kind === 'verified' ? (hostTrouble === null ? { badge: agreement.kind === 'match' ? 'VERIFIED · AGREE' : 'VERIFIED', tone: 'mint' as const }
        : { badge: incomplete ? 'VERIFIED · HOST INCOMPLETE' : 'VERIFIED · HOST NOT READ', tone: 'gold' as const })
        : incomplete ? { badge: 'HOST INCOMPLETE', tone: 'gold' as const }
          : read !== null && read.receiptsVerified !== null && read.receiptsVerified === read.receiptTotal
            ? { badge: 'HOST VERIFIED', tone: 'blue' as const }
            : { badge: her.kind === 'reading' ? 'READING' : 'NOT VERIFIED', tone: 'muted' as const }
  return { summary, ...badge, rows, details, notes }
}
