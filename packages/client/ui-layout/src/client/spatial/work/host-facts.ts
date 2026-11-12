// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The Aukora authors
/**
 * THE HOST'S OWN VERIFIED FACTS, BESIDE THIS TAB'S (Round 18).
 *
 * `GET /__x6/facts` (`server/verified-facts.mjs` `projectVerifiedFacts`) is the host's one-line truth: the
 * selected Pearl, its receipt chain re-verified on the host, the checkpoints it checked (signature and receipt prefix;
 * the signer is NOT pinned there), DAG reach and declared organs. Both hosts serve it: the Mac answers 200 when its
 * evidence is complete and 503 with null counts when not; the edge answers 401 until the owner signs in and 503
 * BOOTSTRAP_REQUIRED until it is seeded.
 *
 * This page reads it with one bounded same-origin GET (no store, an eight-second deadline, a 64 KiB body cap) and
 * sets it beside the tab's own recomputation from its VFS (her `seed_receipts verify` and the page reader's checkpoint
 * check). A tab that lags the host, or runs ahead of it, is said at once. The host's word is shown as the host's: it is
 * not re-verified here, and it grants nothing.
 *
 * COUNTS, NOT CONTENTS. `/__x6/facts` carries no chain anchor (no Merkle root or last receipt hash), so agreement here
 * means the counts agree; two chains of equal length that forked would also agree. It is worded that way on screen.
 * Only a tab whose own verify PASSED is counted; a tab whose verify was refused is said to be refused, never compared.
 *
 * @module host-facts
 */
import { useEffect, useState } from 'react'
import { touchesHer, useDebounced, useLiveEvents } from './autonomy.ts'

export const HOST_FACTS_PATH = '/__x6/facts'
export const HOST_FACTS_TIMEOUT_MS = 8_000
export const HOST_FACTS_MAX_BYTES = 64 * 1024
const POLL_MS = 30_000

/** The host's facts, checked field by field. Null: the host gave no usable value (never read as zero). */
export interface HostFacts {
  readonly runtime: 'local' | 'cloudflare'
  /** `ok: true` and `evidenceStatus: 'complete'`; anything else is the host saying its evidence is incomplete. */
  readonly complete: boolean
  readonly epoch: number | null
  readonly ballId: string | null
  readonly organCount: number | null
  readonly activeOrganCount: number | null
  readonly receiptTotal: number | null
  readonly receiptsVerified: number | null
  readonly checkpointsTotal: number | null
  readonly lastCheckpointSeq: number | null
  readonly lastCheckpointReceiptCount: number | null
  readonly dagReachable: number | null
  readonly dagDeclared: number | null
  readonly auraStatus: string | null
  readonly receiptVerification: string | null
  readonly checkpointVerification: string | null
  readonly checkpointSignerTrust: string | null
  /** The three Survivor series (NORTH-STAR §17.5), each read on its own: one odd series never blanks the others. */
  readonly survivor: SurvivorSeries
  /** The node (Round 21): the commit its organ sources came from, its AUMLOK state, and its passkey, as the host says. */
  readonly node: NodeFacts
  /** Round 24: how far the checkpoint signer is anchored, in the host's own words (each null where it says nothing). */
  readonly anchoring: SignerAnchoring
}
/**
 * The two checks kept apart (Round 24): the chain verifying is not the key being the owner's.
 *   chainSigned     signatures and roots over her receipt chain verify
 *   signerAnchored  the verifying key is in the pinned key table AND anchored by the owner (never inferred from a sequence)
 *   signerStatus    the key table's word for it, e.g. owner-anchored, historical-sandbox, unanchored
 */
export interface SignerAnchoring {
  readonly chainSigned: boolean | null
  readonly signerAnchored: boolean | null
  readonly signerStatus: string | null
}
/**
 * Read the anchoring words wherever the host puts them (top level or under `checkpointSigner`); an odd value is null
 * and never refuses the core facts.
 * @param value - the facts body (or a verifier's answer).
 * @returns the anchoring, all null when nothing is said.
 */
export function parseSignerAnchoring(value: unknown): SignerAnchoring {
  const root = isObject(value) ? value : {}
  const nested = isObject(root.checkpointSigner) ? root.checkpointSigner : {}
  const pick = (key: string): unknown => (Object.hasOwn(nested, key) ? nested[key] : root[key])
  const flag = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null)
  const status = pick('signerStatus')
  return {
    chainSigned: flag(pick('chainSigned')),
    signerAnchored: flag(pick('signerAnchored')),
    signerStatus: typeof status === 'string' && /^[a-z][a-z0-9-]{0,47}$/u.test(status) ? status : null,
  }
}
/** Read on their own like the Survivor series: a missing or odd value is null and never refuses the core facts. */
export interface NodeFacts {
  /** The commit BUILD_INFO.json records for the staged organ image; the host says it is not proof of the running organs. */
  readonly organSourceCommit: string | null
  readonly organSourceEvidence: 'recorded-build-info' | 'unavailable' | 'invalid' | null
  /** The host's AUMLOK projection (`aumlok.phase`): UNAVAILABLE and anything odd read as null. */
  readonly aumlok: 'unbound' | 'bound' | null
  readonly passkeyVerified: boolean | null
  readonly enrollmentAvailable: boolean | null
}
/** The node facts as `projectVerifiedFacts` sends them: `organSourceCommit` with `organSourceEvidence`, and `aumlok`. */
export function parseNodeFacts(value: Record<string, unknown>): NodeFacts {
  const evidence = value.organSourceEvidence
  const organSourceEvidence = evidence === 'recorded-build-info' || evidence === 'unavailable' || evidence === 'invalid' ? evidence : null
  const commit = organSourceEvidence === 'recorded-build-info' && typeof value.organSourceCommit === 'string'
    && /^[0-9a-f]{40}$/.test(value.organSourceCommit) ? value.organSourceCommit : null
  const aumlok = isObject(value.aumlok) ? value.aumlok : null
  const flag = (field: unknown): boolean | null => (typeof field === 'boolean' ? field : null)
  return {
    organSourceCommit: commit,
    organSourceEvidence,
    aumlok: aumlok?.phase === 'BOUND' ? 'bound' : aumlok?.phase === 'UNBOUND' ? 'unbound' : null,
    passkeyVerified: aumlok === null ? null : flag(aumlok.passkeyVerified),
    enrollmentAvailable: aumlok === null ? null : flag(aumlok.enrollmentAvailable),
  }
}
/**
 * The organ source as the host words it: a recorded build image, not proof of what runs. An incomplete facts read never
 * reached BUILD_INFO, so it says that rather than "none recorded".
 */
export function organSourceWords(node: NodeFacts, complete = true): string {
  if (node.organSourceCommit !== null) return `build image recorded at ${node.organSourceCommit.slice(0, 8)} (not proof the running organs came from it)`
  if (!complete) return 'not read (the host’s evidence is incomplete)'
  if (node.organSourceEvidence === 'invalid') return 'build info unreadable'
  if (node.organSourceEvidence === 'unavailable') return 'build info unavailable'
  return 'not reported by this host'
}
/** The AUMLOK binding as the host words it. */
export function aumlokFactWords(node: NodeFacts): string {
  if (node.aumlok === null) return 'not reported by this host'
  if (node.aumlok === 'bound') return `BOUND${node.passkeyVerified === true ? ' · passkey verified at binding' : ''}`
  return `UNBOUND${node.enrollmentAvailable === false ? ' · first binding needs a trusted owner approval this host does not have yet' : ''}`
}
/** The node in one line, only what the host reported. */
export function nodeWords(node: NodeFacts, complete = true): string {
  return `organ source: ${organSourceWords(node, complete)} · AUMLOK: ${aumlokFactWords(node)}`
}

/**
 * SURVIVOR READOUT (Round 19, NORTH-STAR §17.5): three behavioural series kept apart so none stands in for another.
 * Task accomplishment never comes from forecast calibration (`1 - surprise` is not success). A series the host does not
 * send is `absent` ("not reported"); one it sends in the wrong shape is `unreadable`. The field names follow NORTH-STAR
 * (`taskOutcome`, `predictionCalibration`, `gates`, `modelAttribution`), as `server/verified-facts.mjs` projects them
 * (Round 20, Lane 2): a task outcome is `self-attested` at most, a forecast is `observed` with no sample floor yet.
 */
export type Series<T> = T | 'absent' | 'unreadable'
export interface TaskSeries {
  readonly status: string
  readonly retentionPassed: number | null
  readonly retentionTotal: number | null
  readonly qualifiedForPromotion: boolean | null
  readonly graderControlsPassed: boolean | null
  readonly routeEvidenceStatus: string | null
}
export interface ForecastSeries {
  readonly status: string
  readonly version: string | null
  readonly samples: number | null
  readonly minSamples: number | null
  readonly receiptErrorMean: number | null
  readonly receiptErrorLast: number | null
}
export interface ProvenanceSeries {
  readonly signerTrust: string | null
  readonly gates: Series<{ readonly status: string }>
  readonly attribution: Series<{
    readonly evidenceQuality: string | null
    readonly requestedModel: string | null
    readonly providerReportedModel: string | null
    readonly immutableRevision: string | null
  }>
}
export interface SurvivorSeries {
  readonly task: Series<TaskSeries>
  readonly forecast: Series<ForecastSeries>
  readonly provenance: ProvenanceSeries
}

export type HostFactsRead =
  | { readonly kind: 'reading' }
  | { readonly kind: 'ok'; readonly facts: HostFacts }
  | { readonly kind: 'incomplete'; readonly facts: HostFacts }
  | { readonly kind: 'signed-out' }
  | { readonly kind: 'absent' }
  | { readonly kind: 'unavailable'; readonly reason: string }

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const count = (value: unknown): number | null | 'bad' => {
  if (value === null || value === undefined) return null
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0) ? value : 'bad'
}
const word = (value: unknown): string | null | 'bad' => {
  if (value === null || value === undefined) return null
  return typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(value) ? value : 'bad'
}
const token = (value: unknown): string | null | 'bad' => {
  if (value === null || value === undefined) return null
  return typeof value === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(value) ? value : 'bad'
}
const ratio = (value: unknown): number | null | 'bad' => {
  if (value === null || value === undefined) return null
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && !Object.is(value, -0) ? value : 'bad'
}
const flag = (value: unknown): boolean | null | 'bad' => (value === null || value === undefined ? null : typeof value === 'boolean' ? value : 'bad')
const label = (value: unknown): string | null | 'bad' => {
  if (value === null || value === undefined) return null
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/.test(value) ? value : 'bad'
}
/** Read one series object: every listed field must have its type or be missing; a required status token must be present. */
function series<T>(value: unknown, read: (record: Record<string, unknown>) => T | 'bad'): Series<T> {
  if (value === undefined || value === null) return 'absent'
  if (!isObject(value)) return 'unreadable'
  const parsed = read(value)
  return parsed === 'bad' ? 'unreadable' : parsed
}
const anyBad = (...values: unknown[]): boolean => values.includes('bad')
/** The three series from a facts body; never refuses the body (the core counts decide that). */
export function parseSurvivor(value: Record<string, unknown>): SurvivorSeries {
  const task = series(value.taskOutcome, (r): TaskSeries | 'bad' => {
    const status = token(r.status), passed = count(r.retentionPassed), total = count(r.retentionTotal)
    const qualified = flag(r.qualifiedForPromotion), graders = flag(r.graderControlsPassed), route = token(r.routeEvidenceStatus)
    if (status === null || anyBad(status, passed, total, qualified, graders, route)) return 'bad'
    const p = passed as number | null, t = total as number | null
    if (p !== null && t !== null && p > t) return 'bad'
    // Qualification needs every case passed and the grader controls passed (§17.4): a record saying otherwise is unreadable.
    if (qualified === true && ((p !== null && t !== null && p !== t) || graders === false)) return 'bad'
    return { status: status as string, retentionPassed: p, retentionTotal: t, qualifiedForPromotion: qualified as boolean | null,
      graderControlsPassed: graders as boolean | null, routeEvidenceStatus: route as string | null }
  })
  const forecast = series(value.predictionCalibration, (r): ForecastSeries | 'bad' => {
    const status = token(r.status), version = token(r.version), samples = count(r.samples), minSamples = count(r.minSamples)
    const mean = ratio(r.receiptErrorMean), last = ratio(r.receiptErrorLast)
    if (status === null || anyBad(status, version, samples, minSamples, mean, last)) return 'bad'
    return {
      status: status as string, version: version as string | null, samples: samples as number | null,
      minSamples: minSamples as number | null, receiptErrorMean: mean as number | null, receiptErrorLast: last as number | null,
    }
  })
  const gates = series(value.gates, (r): { readonly status: string } | 'bad' => {
    const status = token(r.status)
    return status === null || status === 'bad' ? 'bad' : { status }
  })
  const attribution = series(value.modelAttribution, (r) => {
    const quality = token(r.evidenceQuality), requested = label(r.requestedModel), reported = label(r.providerReportedModel)
    const revision = label(r.immutableRevision)
    if (anyBad(quality, requested, reported, revision)) return 'bad' as const
    return { evidenceQuality: quality as string | null, requestedModel: requested as string | null,
      providerReportedModel: reported as string | null, immutableRevision: revision as string | null }
  })
  const trust = token(value.checkpointSignerTrust)
  return { task, forecast, provenance: { signerTrust: trust === 'bad' ? null : trust, gates, attribution } }
}

const COUNT_KEYS = [
  'epoch', 'organCount', 'activeOrganCount', 'receiptTotal', 'receiptsVerified', 'checkpointsTotal', 'lastCheckpointSeq',
  'lastCheckpointReceiptCount', 'dagReachable', 'dagDeclared',
] as const
const WORD_KEYS = ['auraStatus', 'receiptVerification', 'checkpointVerification', 'checkpointSignerTrust'] as const

/**
 * Check a `/__x6/facts` body. A wrong type on any field, or counts that contradict each other (more verified than
 * total, a checkpoint covering more receipts than exist, more active organs than declared), refuse the whole body.
 * @returns the facts, or null when the body is not that shape.
 */
export function parseHostFacts(value: unknown): HostFacts | null {
  if (!isObject(value) || (value.runtime !== 'local' && value.runtime !== 'cloudflare') || typeof value.ok !== 'boolean') return null
  const counts: Partial<Record<(typeof COUNT_KEYS)[number], number | null>> = {}
  for (const key of COUNT_KEYS) {
    const parsed = count(value[key])
    if (parsed === 'bad') return null
    counts[key] = parsed
  }
  const words: Partial<Record<(typeof WORD_KEYS)[number], string | null>> = {}
  for (const key of WORD_KEYS) {
    const parsed = word(value[key])
    if (parsed === 'bad') return null
    words[key] = parsed
  }
  const ballId = value.ballId === null || value.ballId === undefined ? null
    : typeof value.ballId === 'string' && /^[0-9a-f]{64}$/.test(value.ballId) ? value.ballId : 'bad'
  if (ballId === 'bad') return null
  const at = (key: (typeof COUNT_KEYS)[number]): number | null => counts[key] ?? null
  const above = (small: number | null, large: number | null): boolean => small !== null && large !== null && small > large
  if (above(at('receiptsVerified'), at('receiptTotal')) || above(at('lastCheckpointReceiptCount'), at('receiptTotal'))
    || above(at('activeOrganCount'), at('organCount')) || above(at('lastCheckpointSeq'), at('checkpointsTotal'))) return null
  return {
    runtime: value.runtime,
    complete: value.ok && value.evidenceStatus === 'complete',
    epoch: at('epoch'), ballId,
    organCount: at('organCount'), activeOrganCount: at('activeOrganCount'),
    receiptTotal: at('receiptTotal'), receiptsVerified: at('receiptsVerified'),
    checkpointsTotal: at('checkpointsTotal'), lastCheckpointSeq: at('lastCheckpointSeq'),
    lastCheckpointReceiptCount: at('lastCheckpointReceiptCount'),
    dagReachable: at('dagReachable'), dagDeclared: at('dagDeclared'),
    auraStatus: words.auraStatus ?? null, receiptVerification: words.receiptVerification ?? null,
    checkpointVerification: words.checkpointVerification ?? null, checkpointSignerTrust: words.checkpointSignerTrust ?? null,
    survivor: parseSurvivor(value),
    node: parseNodeFacts(value),
    anchoring: parseSignerAnchoring(value),
  }
}

type FactsFetch = (input: string, init?: RequestInit) => Promise<Response>

/** Read at most `max` bytes of a body; null when it is longer (the rest is cancelled, never buffered). */
async function cappedText(response: Response, max: number): Promise<string | null> {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > max) { await response.body?.cancel().catch(() => {}); return null }
  if (response.body === null) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > max) { await reader.cancel().catch(() => {}); return null }
    chunks.push(value)
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  return new TextDecoder().decode(bytes)
}

/**
 * One bounded, same-origin GET of `/__x6/facts`. Reads only; never retried here.
 * @returns ok (complete), incomplete (the host said so), signed-out (edge 401), absent (no such route), or unavailable.
 */
export async function readHostFacts(
  fetchImpl: FactsFetch = (input, init) => fetch(input, init), signal?: AbortSignal,
  timeoutMs: number = HOST_FACTS_TIMEOUT_MS, maxBytes: number = HOST_FACTS_MAX_BYTES,
): Promise<HostFactsRead> {
  const deadline = new AbortController()
  const timer = setTimeout(() => { deadline.abort() }, timeoutMs)
  const forward = (): void => { deadline.abort() }
  signal?.addEventListener('abort', forward, { once: true })
  try {
    const response = await fetchImpl(HOST_FACTS_PATH, { method: 'GET', credentials: 'same-origin', cache: 'no-store', signal: deadline.signal })
    if (response.status === 404) { await response.body?.cancel().catch(() => {}); return { kind: 'absent' } }
    const text = await cappedText(response, maxBytes)
    if (text === null) return { kind: 'unavailable', reason: `${HOST_FACTS_PATH} answered more than ${String(maxBytes)} bytes` }
    let body: unknown = null
    try { body = JSON.parse(text) } catch { /* shown below as the status alone */ }
    if (response.status === 401 && isObject(body) && body.code === 'OWNER_ACCESS_REQUIRED') return { kind: 'signed-out' }
    const facts = parseHostFacts(body)
    if (response.status === 200 && facts !== null) return facts.complete ? { kind: 'ok', facts } : { kind: 'incomplete', facts }
    if (response.status === 503 && facts !== null && !facts.complete) return { kind: 'incomplete', facts }
    const code = isObject(body) && typeof body.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(body.code) ? ` ${body.code}` : ''
    return { kind: 'unavailable', reason: facts === null && response.ok
      ? `${HOST_FACTS_PATH} is not the expected shape`
      : `${HOST_FACTS_PATH} answered ${String(response.status)}${code}` }
  } catch (error) {
    if (signal?.aborted === true) throw error
    return { kind: 'unavailable', reason: deadline.signal.aborted ? `${HOST_FACTS_PATH} did not answer in time` : `${HOST_FACTS_PATH} did not answer` }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', forward)
  }
}

/**
 * Read the host's facts while `active`, and whenever `round` changes (a Refresh). With `live` (the Work view, whose
 * own readout also follows her), also every 30 s after each read settles and on a ball commit or a mirror change to
 * her home. Without it (a view whose tab read happens once per opening), once per opening, so both sides are as old.
 */
export function useHostFacts(active: boolean, round = 0, fetchImpl?: FactsFetch, live = true): HostFactsRead {
  const [read, setRead] = useState<HostFactsRead>({ kind: 'reading' })
  const [tick, setTick] = useState(0)
  const reread = useDebounced(() => { setTick(n => n + 1) })
  useLiveEvents(active && live, (event) => {
    if (event.kind === 'ball-commit' || (event.kind === 'mirror-updated' && touchesHer(event.changedPaths))) reread.poke()
  })
  useEffect(() => {
    if (!active) return
    // A one-shot view compares this read with its own tab read of the same opening: never show the previous one.
    if (!live) setRead({ kind: 'reading' })
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const once = async (): Promise<void> => {
      try {
        const next = await readHostFacts(fetchImpl, controller.signal)
        if (controller.signal.aborted) return
        setRead(next)
        if (live) timer = setTimeout(() => { void once() }, POLL_MS)
      } catch { /* aborted on close */ }
    }
    void once()
    return () => { controller.abort(); if (timer !== undefined) clearTimeout(timer) }
  }, [active, round, tick, fetchImpl, live])
  return read
}

/**
 * This tab's own numbers, from its VFS. `verify` is her `seed_receipts verify` on a fresh readout: only when it PASSED
 * are its receipt and checkpoint counts given; the page reader's last-checkpoint coverage only when that signature
 * verified too. The head is her selected head file.
 */
export interface TabFacts {
  readonly verify: 'verified' | 'rejected' | 'pending'
  readonly receipts: number | null
  readonly checkpoints: number | null
  readonly lastCheckpointReceiptCount: number | null
  readonly epoch: number | null
  readonly ballId: string | null
}

export type FactsAgreement =
  | { readonly kind: 'match'; readonly compared: number; readonly headCompared: boolean }
  | { readonly kind: 'lag'; readonly notes: readonly string[] }
  | { readonly kind: 'unknown'; readonly reason: string }

/**
 * Set this tab's numbers beside the host's. Only fields both sides know are compared. Agreement needs the receipt count
 * compared and every compared field equal; a differing head alone is still a difference. Receipts are append-only, so
 * a count difference names the side that is behind BY COUNT (contents are not compared; see the module note).
 */
export function compareTabToHost(tab: TabFacts, host: HostFactsRead): FactsAgreement {
  if (host.kind !== 'ok') return { kind: 'unknown', reason: host.kind === 'incomplete' ? 'the host reports incomplete evidence' : 'no host facts' }
  const facts = host.facts
  const notes: string[] = []
  let compared = 0
  const hostReceipts = facts.receiptsVerified
  if (tab.verify === 'rejected') {
    notes.push(`this tab's own receipt verify was REFUSED; the host verified ${hostReceipts === null ? 'its' : String(hostReceipts)} receipts`)
  }
  const receiptsCompared = tab.verify === 'verified' && tab.receipts !== null && hostReceipts !== null
  if (receiptsCompared) {
    compared += 1
    if (tab.receipts < hostReceipts) notes.push(`TAB BEHIND HOST by ${String(hostReceipts - tab.receipts)} receipts (tab ${String(tab.receipts)}, host ${String(hostReceipts)})`)
    if (tab.receipts > hostReceipts) {
      notes.push(`TAB AHEAD OF HOST by ${String(tab.receipts - hostReceipts)} receipts (tab ${String(tab.receipts)}, host ${String(hostReceipts)}; not yet delivered?)`)
    }
  }
  if (tab.verify === 'verified' && tab.checkpoints !== null && facts.checkpointsTotal !== null) {
    compared += 1
    if (tab.checkpoints !== facts.checkpointsTotal) notes.push(`checkpoints differ (tab ${String(tab.checkpoints)}, host ${String(facts.checkpointsTotal)})`)
  }
  if (tab.verify === 'verified' && tab.lastCheckpointReceiptCount !== null && facts.lastCheckpointReceiptCount !== null) {
    compared += 1
    if (tab.lastCheckpointReceiptCount !== facts.lastCheckpointReceiptCount) {
      notes.push(`last checkpoint covers ${String(tab.lastCheckpointReceiptCount)} receipts in the tab, ${String(facts.lastCheckpointReceiptCount)} on the host`)
    }
  }
  const headCompared = tab.epoch !== null && facts.epoch !== null
  if (headCompared) {
    compared += 1
    if (tab.epoch !== facts.epoch) notes.push(`tab on Pearl epoch ${String(tab.epoch)}, host on ${String(facts.epoch)}`)
  }
  if (tab.ballId !== null && facts.ballId !== null && tab.epoch === facts.epoch) {
    compared += 1
    if (tab.ballId !== facts.ballId) notes.push(`same epoch, different Pearl (tab ${tab.ballId.slice(0, 12)}, host ${facts.ballId.slice(0, 12)})`)
  }
  if (notes.length > 0) return { kind: 'lag', notes }
  if (!receiptsCompared) {
    return { kind: 'unknown', reason: `this tab has not verified its own receipts yet${compared > 0 ? ' (its Pearl head agrees)' : ''}` }
  }
  return { kind: 'match', compared, headCompared }
}

/** The host's checkpoint coverage in words: "checkpoint 5 covers 85 of 87 receipts · signature checked, signer unpinned". */
export function hostCheckpointWords(facts: HostFacts): string {
  if (facts.checkpointsTotal === null) return 'checkpoints not reported'
  if (facts.checkpointsTotal === 0) return 'no checkpoint yet'
  const seq = facts.lastCheckpointSeq === null ? '?' : String(facts.lastCheckpointSeq)
  const covers = facts.lastCheckpointReceiptCount === null ? 'coverage not reported'
    : `covers ${String(facts.lastCheckpointReceiptCount)} of ${facts.receiptTotal === null ? '?' : String(facts.receiptTotal)} receipts`
  const how = facts.checkpointVerification === 'signature-and-receipt-prefix' ? 'signature and receipt prefix checked' : 'check not named'
  return `checkpoint ${seq} ${covers} · ${how}, ${signerWords(facts.checkpointSignerTrust)}`
}
/** How the host trusts the checkpoint signer (Round 20 pin): pinned, a key that is not the pinned one, or no pin. */
export function signerWords(trust: string | null): string {
  if (trust === null) return 'signer trust not reported'
  if (trust === 'unpinned') return 'signer not pinned on the host'
  if (trust === 'pinned') return 'signer matches the pinned key'
  if (trust === 'mismatch') return 'signer MISMATCH: not the pinned key'
  if (trust === 'invalid-pin') return 'signer pin on the host is invalid, so the signer was not checked'
  return `signer ${trust}`
}
/**
 * What follows the host line on Work: a signer alarm outranks counts agreeing, so a tab that matches a host whose
 * checkpoints are signed by another key (or whose pin is unreadable) never reads as agreeing with it.
 */
export function hostRowSuffix(read: HostFactsRead, agreement: FactsAgreement): { readonly kind: 'alarm'; readonly text: string }
  | { readonly kind: 'match' } | null {
  const alarm = signerAlarm(read)
  if (alarm !== null) return { kind: 'alarm', text: alarm }
  return agreement.kind === 'match' ? { kind: 'match' } : null
}
/**
 * A signer state that outranks counts agreeing (Round 20): a checkpoint signed by a key other than the pinned one, or a
 * pin the host could not read. Null when the signer is pinned, unpinned or not reported.
 */
export function signerAlarm(read: HostFactsRead): string | null {
  if (read.kind !== 'ok' && read.kind !== 'incomplete') return null
  if (read.facts.checkpointSignerTrust === 'mismatch') return 'CHECKPOINT SIGNER MISMATCH'
  if (read.facts.checkpointSignerTrust === 'invalid-pin') return 'CHECKPOINT SIGNER PIN INVALID'
  return null
}

const SERIES_UNSAID = { absent: 'not reported by this host', unreadable: 'unreadable (not the expected shape)' } as const
const yesNo = (value: boolean | null, yes: string, no: string): string => (value === null ? 'not recorded' : value ? yes : no)

/** Task accomplishment: retention pass count and qualification, never a forecast score. */
export function taskWords(task: Series<TaskSeries>): string {
  if (task === 'absent' || task === 'unreadable') return SERIES_UNSAID[task]
  if (task.status === 'incomplete' || task.status === 'insufficient-samples') return `${task.status.toUpperCase()} · no pass count shown`
  // A status with nothing recorded under it ('not-recorded', 'unverified', 'unavailable') is that status alone.
  // The host leaves qualification empty on purpose for a self-attested outcome: it was not granted, not "not recorded".
  const nothing = task.retentionPassed === null && task.retentionTotal === null && task.qualifiedForPromotion === null
    && task.graderControlsPassed === null && task.routeEvidenceStatus === null
  if (nothing) return `${task.status.toUpperCase()} · no pass count shown`
  // Only 'complete' is a finished reading; any other status is printed as the host gave it, ahead of the numbers.
  const prefix = task.status === 'complete' ? '' : `${task.status.toUpperCase()} · `
  const retention = task.retentionPassed === null || task.retentionTotal === null
    ? 'retention not reported' : `retention ${String(task.retentionPassed)}/${String(task.retentionTotal)}`
  const qualified = task.qualifiedForPromotion === null && task.status === 'self-attested'
    ? 'not granted (self-attested)' : yesNo(task.qualifiedForPromotion, 'yes', 'no')
  return prefix + [retention, `qualified for promotion: ${qualified}`,
    `grader controls: ${yesNo(task.graderControlsPassed, 'passed', 'FAILED')}`,
    `route evidence: ${task.routeEvidenceStatus ?? 'not recorded'}`].join(' · ')
}

/** Forecast calibration: receipt_error = |observed - expected| / max(|expected|, 1); never read as task success. */
export function forecastWords(forecast: Series<ForecastSeries>): string {
  if (forecast === 'absent' || forecast === 'unreadable') return SERIES_UNSAID[forecast]
  const short = forecast.samples !== null && forecast.minSamples !== null && forecast.samples < forecast.minSamples
  const count = forecast.samples === null ? '?' : String(forecast.samples)
  if (forecast.status === 'insufficient-samples' || short) {
    return forecast.minSamples === null ? `INSUFFICIENT SAMPLES (${count} sample${count === '1' ? '' : 's'}, no floor set)`
      : `INSUFFICIENT SAMPLES (${count} of ${String(forecast.minSamples)})`
  }
  if (forecast.status === 'incomplete') return 'INCOMPLETE · no error shown'
  // Numbers are shown for 'complete' and for 'observed' (the host's word for errors it measured). 'observed' is not
  // settled, so it leads the line, and with no sample floor it says so: a mean over one sample never reads as final.
  if (forecast.status !== 'complete' && forecast.status !== 'observed') return `${forecast.status.toUpperCase()} · no error shown`
  const lead = forecast.status === 'complete' ? '' : `OBSERVED${forecast.minSamples === null ? ' (no sample floor)' : ''} · `
  const mean = forecast.receiptErrorMean === null ? 'mean not reported' : `receipt_error mean ${forecast.receiptErrorMean.toFixed(3)}`
  const last = forecast.receiptErrorLast === null ? '' : ` · last ${forecast.receiptErrorLast.toFixed(3)}`
  const samples = forecast.samples === null ? '' : ` · ${count} sample${forecast.samples === 1 ? '' : 's'}`
  return `${lead}${mean}${last}${samples}${forecast.version === null ? '' : ` · ${forecast.version}`}`
}

/** Evidence and provenance: checkpoint signer trust, gate coverage, and how the model's identity is known. */
export function provenanceWords(provenance: ProvenanceSeries): string {
  const signer = `checkpoint ${signerWords(provenance.signerTrust)}`
  const gates = typeof provenance.gates === 'string' ? `gates ${SERIES_UNSAID[provenance.gates]}` : `gates ${provenance.gates.status}`
  const a = provenance.attribution
  const model = typeof a === 'string' ? `model attribution ${SERIES_UNSAID[a]}`
    : `model attribution ${a.evidenceQuality ?? 'quality not stated'}${a.providerReportedModel === null ? '' : ` (${a.providerReportedModel})`}`
      + ` · revision ${a.immutableRevision ?? 'unknown'}`
  return `${signer} · ${gates} · ${model}`
}

/** The whole host read in one line (the Work row and the Sovereignty lead). */
export function hostFactsWords(read: HostFactsRead): string {
  switch (read.kind) {
    case 'reading': return 'reading the host’s facts…'
    case 'signed-out': return 'the host wants the owner pass before it shares its facts'
    case 'absent': return `this host does not serve ${HOST_FACTS_PATH} yet`
    case 'unavailable': return read.reason
    case 'incomplete': return 'the host reports its evidence is incomplete right now, so it gives no counts'
    case 'ok': {
      const f = read.facts
      const receipts = f.receiptsVerified === null || f.receiptTotal === null ? 'receipts not reported'
        : `${String(f.receiptsVerified)}/${String(f.receiptTotal)} receipts verified`
      const pearl = f.epoch === null ? '' : ` · Pearl ${String(f.epoch)}${f.ballId === null ? '' : ` · ${f.ballId.slice(0, 12)}`}`
      return `host ${f.runtime === 'local' ? '(Mac)' : '(edge)'}: ${receipts} · ${hostCheckpointWords(f)}${pearl}`
    }
  }
}
