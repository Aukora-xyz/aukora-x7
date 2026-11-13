/**
 * THE WORK SURFACE — what Auma's coordination state says is authorised, running, blocked and waiting on the owner.
 *
 * Two sources, never mixed silently:
 *   · VERIFIED, through the page-side SuperAgent reader (`work/bridge.ts` → the readout): her `auma_superagent`
 *     status projection and her own `seed_receipts verify`. Receipt facts on this surface come only from that verify.
 *   · HER FILES, through the stock `remote.workspaceFiles` service bound to the shown Session: the selected ball head,
 *     the memory DAG tip, and — only while the verified projection refuses her organ's answer — the raw superagent
 *     state file, labelled as unverified.
 *
 * ACTIONS. Stop sends the same `auma_superagent` tool call Auma can make herself, through the same worker route; her organ
 * ends the ticket and its running assignments in her records. A mandate is approved only by the bound passkey, over the
 * exact owner-grant terms, shown first. Nothing here signs with an owner key or confirms from a tab click.
 *
 * AUTONOMY (`autonomy.ts`): her memory DAG walked from HEAD with every node id recomputed, the high-surprise
 * lessons in her discovery corpus (her own scores, labelled so), and the host's wake timer with Wake now / timer on-off
 * buttons inline. The buttons ask the host; they do not decide what a wake does.
 *
 * LESS ON SCREEN: what Sovereignty or Aura already shows is not repeated here, empty sections are not drawn,
 * and long diagnostics sit in one closed "Details" fold at the end of a section. A bad state (a failed verify, a broken
 * memory DAG, a rejected prediction, a signer alarm, a refusal) is never folded away.
 */
import { useEffect, useRef, useState } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  BALL_HEAD_PATH, MEMORY_DAG_HEAD_PATH, parseDagHead, parseHead, parseWorkGraph, SUPERAGENT_STATE_PATH,
} from './work-model.ts'
import type { DagHeadView, HeadView, WorkGraph } from './work-model.ts'
import { workBridge } from './bridge.ts'
import {
  APPROVAL_FINISHING_WORDS, holdReload, reloadUnlessHeld, useReloadHeld, type ReloadNotice,
} from '../portal/build-notice.ts'
import { useReloadNoticeFeed } from '../portal/notices.ts'
import type { BridgePhase, BridgeRead, BridgeReceipts, BridgeSnapshot, BridgeToolBody } from './bridge.ts'
import css from './Work.module.css'
import { foldAttention, headingKey, type AttentionRow } from './attention.ts'
import {
  bootRelease, COMMIT_FOLLOW_UPS, corpusStatus, countCorpus, DISCOVERY_CORPUS_PATH, MEMORY_DAG_DIR, postWake, readWake, touchesHer,
  useDebounced, useLiveEvents,
  useNewBuild, verifyDag, wakeInterval,
  type CorpusCount, type DagCheck, type WakeRead, type WakeRequest,
} from './autonomy.ts'
import type { WorkLabels } from './labels.ts'
import { readAumlokStatus, type AumlokHostStatus } from '../aumlok/aumlok-ceremony.ts'
import { approveClass3, class3Action, sendApprovedClass3 } from '../aumlok/class3-approval.ts'
import { passkeyBlocker } from '../apps/identity/webauthn.ts'
import { ownerGrantRefusal, type OwnerGrantTerms } from './owner-grant-terms.ts'
import {
  AppHeader, AppSurface, Lead, PortalCell, PortalFold, PortalGrid, SectionLabel, StatusPill, type Tone,
} from '../primitives/index.ts'
import { EdgeOwnerSignIn, parsePearl, useHostMode } from '../../spatial-components.tsx'
import { compareTabToHost, hostFactsWords, hostRowSuffix, useHostFacts, type TabFacts } from './host-facts.ts'

/** Surface id in the centre lane. */
export const WORK_SURFACE = 'auma-work'

/** How often an open Work surface re-reads. Closed, it reads nothing. */
const POLL_MS = 10_000
/** The tool the actions call. */
const SUPERAGENT_TOOL = 'auma_superagent'

/** One file read: the text, or why it could not be read. */
export type FileRead = { ok: true; text: string } | { ok: false; reason: string }

/** The reader this surface is given: one complete small file. */
export interface WorkReader {
  readonly whole: (sessionId: SessionId, path: string, signal: AbortSignal) => Promise<FileRead>
}

/** Injected by the registration. */
export interface WorkSurfaceInjected {
  readonly reader: WorkReader
  /** The Work view's own words (`work.labels`): attention headings and the tab-click wording. */
  readonly labels: WorkLabels
}

export type WorkSurfaceProps = PropsRuntime<'shell.surface'> & PropsLocale<'layout'> & WorkSurfaceInjected

interface Files {
  readonly graph: WorkGraph | null
  readonly graphTrouble: string | null
  readonly head: HeadView | null
  readonly headTrouble: string | null
  readonly dag: DagHeadView | null
  readonly dagTrouble: string | null
  readonly readAt: number | null
}

const NO_FILES: Files = { graph: null, graphTrouble: null, head: null, headTrouble: null, dag: null, dagTrouble: null, readAt: null }

/** Rows as this surface renders them, from either source. */
interface Rows {
  readonly source: 'verified' | 'state-file'
  readonly mandates: readonly {
    id: string
    title: string
    strength: string
    scope: string
    expiry: string | null
    authorityLevel?: string | undefined
    authorityProvenance?: string | undefined
    authorityLineage?: string | undefined
    authorityIdentityClaim?: string | null | undefined
    authorityIdentitySource?: string | undefined
    authorityUserVerification?: string | undefined
    authorityReasons?: readonly string[] | undefined
    grantIdentity?: string | null | undefined
    grantSeq?: number | undefined
    grantBallId?: string | null | undefined
    grantEpoch?: number | null | undefined
  }[]
  readonly tickets: readonly { id: string; mandateId: string | null; title: string; state: string }[]
  readonly assignments: readonly {
    id: string
    ticketId: string | null
    state: string
    executor: string
    report: string | null
    heartbeat?: { availability: string; ageMs: number | null } | undefined
  }[]
  readonly attention: readonly AttentionRow[]
}

type Pending = { kind: 'confirm'; mandateId: string } | { kind: 'stop'; ticketId: string }
/** A tool call's or a passkey approval's result; `note` replaces the Stop wording (a passkey answer is the host's). */
type Outcome = { ok: true; note?: string } | { ok: false; reason: string }
/** The edge route a passkey-approved owner grant is sent to (Lanes 2-3, `worker.mjs`). */
const OWNER_GRANT_ROUTE = '/_host/owner-grant'
/** An approval with less than this left is not sent (the edge still reads the lease before it consumes the approval). */
const APPROVAL_MARGIN_MS = 10_000
/** How long an approval can take (the host's 120 s challenge, plus the send): a mandate expiring sooner is not offered. */
const APPROVAL_WINDOW_MS = 150_000
/**
 * The host's refusal for these terms if they were sent now, or once an approval had run its course.
 * @param terms - the seven terms.
 * @returns the code, or null.
 */
function termsRefusal(terms: OwnerGrantTerms): string | null {
  const now = Date.now()
  return ownerGrantRefusal(terms, now)
    ?? (ownerGrantRefusal(terms, now + APPROVAL_WINDOW_MS) === 'OWNER_GRANT_INVALID_EXPIRY' ? 'MANDATE_EXPIRES_DURING_APPROVAL' : null)
}

/** The Session the main view shows, else the newest live one; preview fixtures never qualify. */
/** The live Session the shell shows (never a preview fixture), whose worker files the surfaces read. */
export function sessionOf(sessions: {
  readonly ids: readonly SessionId[]
  readonly byId: Readonly<Record<string, { readonly id: SessionId; readonly retainedBy: { readonly mainView?: number } }>>
}): SessionId | undefined {
  const shown = Object.values(sessions.byId).find(s => (s.retainedBy.mainView ?? 0) > 0)?.id
  if (shown !== undefined && !String(shown).startsWith('preview-')) return shown
  return sessions.ids.find(id => !String(id).startsWith('preview-'))
}

/**
 * How the selected head relates to the ball a mandate's grant was issued at — said plainly. The readout's own
 * level and reasons stay beside it; this only explains them, it never raises a level.
 */
type GrantLineage = 'same-ball' | 'advanced-one' | 'advanced-unlinked' | 'unknown'
function grantLineage(
  head: HeadView | null,
  grantBallId: string | null | undefined,
  verifiedLineage?: string | undefined,
): GrantLineage {
  if (verifiedLineage === 'same-ball') return 'same-ball'
  if (verifiedLineage === 'promoted') return 'advanced-one'
  if (verifiedLineage === 'head-claim-only' || verifiedLineage === 'unrelated') return 'advanced-unlinked'
  if (head === null || head.ballId === null || grantBallId == null) return 'unknown'
  if (grantBallId === head.ballId) return 'same-ball'
  return 'advanced-unlinked'
}

const ageText = (ms: number): string => (ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60_000)}m`)
const short = (hash: string | null | undefined): string => (hash == null ? '—' : hash.slice(0, 12))
const when = (at: number | string | null): string => {
  if (at === null) return '—'
  const d = new Date(at)
  return Number.isNaN(d.getTime()) ? String(at) : d.toLocaleString()
}

/**
 * This tab's own numbers for the host check. Counts come only from a FRESH readout whose `seed_receipts verify`
 * PASSED (a held, stale snapshot is not compared); the page reader's last-checkpoint coverage only when that
 * checkpoint's signature verified too. A refused verify, on any readout, is said as refused. The head is her head file.
 * `oneShot` (Sovereignty): the reader made exactly one read for this opening, so its receipts are that read's own even
 * when her status file is old (stale-snapshot) or her status call failed; the head and coverage need a snapshot.
 */
export function tabFactsOf(phase: BridgePhase | null, head: HeadView | null, oneShot = false): TabFacts {
  const receipts = receiptsOf(phase)
  const counted = phase === null ? null : phase.kind === 'snapshot' || (oneShot && (phase.kind === 'stale-snapshot' || phase.kind === 'failure')) ? phase : null
  const verified = counted?.receipts.kind === 'verified' ? counted.receipts as Extract<BridgeReceipts, { kind: 'verified' }> : null
  const snapshot = counted !== null && counted.kind !== 'failure' ? counted.snapshot : null
  const coverage = snapshot === null ? null : parsePearl((snapshot as { pearl?: unknown }).pearl)?.checkpoint ?? null
  return {
    verify: verified !== null ? 'verified' : receipts?.kind === 'rejected' ? 'rejected' : 'pending',
    receipts: verified?.receiptsVerified ?? null,
    checkpoints: verified?.checkpointsVerified ?? null,
    lastCheckpointReceiptCount: verified !== null && coverage?.lastSigned === true ? coverage.lastReceiptCount : null,
    epoch: head?.epoch ?? null,
    ballId: head?.ballId ?? null,
  }
}

function snapshotOf(phase: BridgePhase | null): BridgeSnapshot | null {
  if (phase === null) return null
  return phase.kind === 'snapshot' || phase.kind === 'stale-snapshot' ? phase.snapshot : null
}

function receiptsOf(phase: BridgePhase | null): BridgeReceipts | null {
  if (phase === null || phase.kind === 'loading' || phase.kind === 'stopped') return null
  return phase.receipts
}

/** Whether the reader has finished its current paired read. */
function readSettled(phase: BridgePhase): boolean {
  if (phase.kind === 'loading') return false
  if (phase.kind === 'stopped') return false
  return !phase.refreshing
}

/** A refusal's named code, as her organs write them. */
const REFUSAL_CODE = /^[A-Z][A-Z0-9_]{0,79}$/
/**
 * What the Work view says about a read that did not land: the failure's kind, or the code a refusal named.
 * @param phase - the bridge's phase.
 * @returns the words for the source row, or null when nothing failed.
 */
export function failureKind(phase: BridgePhase | null): string | null {
  if (phase === null) return null
  // A refusal that names a code is said by that code (Round 26: her organ's MANDATE_EXPIRY_INVALID, not "refused"). Free text
  // from a refusal never reaches this trust row: anything but a code is still said as "refused".
  const said = (failure: { kind: string; detail?: string | null }): string => (failure.kind === 'refused' && typeof failure.detail === 'string'
    && REFUSAL_CODE.test(failure.detail) ? failure.detail : failure.kind)
  if (phase.kind === 'failure') return said(phase.failure)
  if (phase.kind === 'stale-snapshot') return phase.failure ? said(phase.failure) : phase.aged ? 'aged' : null
  return null
}

function rowsFromSnapshot(s: BridgeSnapshot): Rows {
  return {
    source: 'verified',
    mandates: s.mandates.map(m => ({
      id: m.id,
      title: m.id,
      strength: m.strength,
      scope: m.scope,
      expiry: m.expiry,
      authorityLevel: m.authority?.level,
      authorityProvenance: m.authority?.provenance,
      authorityLineage: m.authority?.lineage,
      authorityIdentityClaim: m.authority?.identityClaim,
      authorityIdentitySource: m.authority?.identitySource,
      authorityUserVerification: m.authority?.userVerification,
      authorityReasons: m.authority?.reasons ?? (m.authority?.reason === undefined ? undefined : [m.authority.reason]),
      grantIdentity: m.grant?.identity,
      grantSeq: m.grant?.seq,
      grantBallId: m.grant?.ballId,
      grantEpoch: m.grant?.epoch,
    })),
    tickets: s.tickets.map(tk => ({
      id: tk.id, mandateId: tk.mandateId, title: tk.title, state: tk.outcome === null ? tk.state : `${tk.state} (${tk.outcome})`,
    })),
    assignments: s.assignments.map(a => ({
      id: a.id,
      ticketId: a.ticketId,
      state: a.state,
      executor: a.executor === null ? '?' : a.executor.unrecognized === true ? `? ${a.executor.token}` : a.executor.token,
      report: a.report === null ? null : `${a.report.state}${a.report.summary === '' ? '' : `: ${a.report.summary}`}`,
      heartbeat: a.heartbeat === undefined
        ? undefined
        : { availability: a.heartbeat.availability ?? a.heartbeat.state ?? 'unknown', ageMs: a.heartbeat.ageMs },
    })),
    attention: s.attention.map(a => ({ id: a.id, kind: a.kind, text: a.text, source: sourceOf(a.source) })),
  }
}

function rowsFromFile(g: WorkGraph): Rows {
  return {
    source: 'state-file',
    mandates: g.mandates.map(m => ({
      id: m.id,
      title: m.title,
      strength: m.strength,
      scope: JSON.stringify({ paths: m.paths, organs: m.organs, tools: m.tools, budgetSteps: m.budgetSteps }),
      expiry: m.expiresAt === null ? null : new Date(m.expiresAt).toISOString(),
    })),
    tickets: g.tickets.map(tk => ({ id: tk.id, mandateId: tk.mandateId, title: tk.title, state: tk.state })),
    assignments: g.assignments.map(a => ({
      id: a.id,
      ticketId: a.ticketId,
      state: a.state,
      executor: a.executorKnown ? a.executor : `? ${a.executor}`,
      report: a.lastReport === null ? null : `${a.lastReport}${a.lastNote === null ? '' : `: ${a.lastNote}`}`,
    })),
    attention: g.attention.map(a => ({ id: a.id, kind: a.kind, text: a.summary, source: 'state-file' as const })),
  }
}

async function readFiles(reader: WorkReader, sessionId: SessionId, signal: AbortSignal): Promise<Files> {
  const [state, head, dag] = await Promise.all([
    reader.whole(sessionId, SUPERAGENT_STATE_PATH, signal),
    reader.whole(sessionId, BALL_HEAD_PATH, signal),
    reader.whole(sessionId, MEMORY_DAG_HEAD_PATH, signal),
  ])
  const graph = state.ok ? parseWorkGraph(state.text) : null
  const headView = head.ok ? parseHead(head.text) : null
  const dagView = dag.ok ? parseDagHead(dag.text) : null
  return {
    graph,
    graphTrouble: state.ok ? (graph === null ? 'not-json' : null) : state.reason,
    head: headView,
    headTrouble: head.ok ? (headView === null ? 'not-json' : null) : head.reason,
    dag: dagView,
    dagTrouble: dag.ok ? (dagView === null ? 'not-json' : null) : dag.reason,
    readAt: Date.now(),
  }
}

/** Her memory DAG and surprise corpus, as this tab last checked them. */
interface RecallView {
  readonly dag: DagCheck | null
  readonly dagTrouble: string | null
  readonly corpus: CorpusCount | 'absent' | null
  readonly corpusTrouble: string | null
}
const NO_RECALL: RecallView = { dag: null, dagTrouble: null, corpus: null, corpusTrouble: null }
const isMissing = (reason: string): boolean => reason.includes('not-found') || reason === 'ENOENT'

/** Walk her DAG from the heads HEAD.json names, recomputing every node id it reads, against HEAD's own count. */
function walkDag(
  reader: WorkReader, sessionId: SessionId, heads: readonly string[], expected: number | null, signal: AbortSignal,
): Promise<DagCheck> {
  return verifyDag(heads, async (id) => {
    const file = await reader.whole(sessionId, `${MEMORY_DAG_DIR}/${id}.json`, signal)
    if (file.ok) return { kind: 'ok', text: file.text }
    return isMissing(file.reason) ? { kind: 'missing' } : { kind: 'unreadable', detail: file.reason }
  }, new Map(), undefined, expected)
}

/**
 * The host selected a different runtime release than this page booted from: one inline button that reloads the page.
 * Not a popup, and it reloads only when clicked. "Different", not "newer": a selection can be a rollback, and the host
 * says a selection is no health proof. With no host selection, the same button carries `notice`
 * (portal/build-notice.ts): a new build of the app is live on the edge, or a newer Auma is published than this tab runs.
 */
export function NewBuildButton({ release, words, notice }: {
  readonly release: string | null
  readonly words?: { readonly button: string; readonly what: string } | undefined
  readonly notice?: ReloadNotice | null | undefined
}): JSX.Element | null {
  // NO RELOAD OVER AN APPROVAL IN FLIGHT (portal/build-notice.ts): both reloads check the shared guard when pressed, and
  // while it holds the notice says so in one sentence.
  const held = useReloadHeld()
  const shown = release !== null ? { release, words, from: bootRelease(), reload: () => { reloadUnlessHeld() } } : notice ?? null
  if (shown === null) return null
  const boot = shown.from
  const what = shown.words?.what ?? 'The host now selects a different runtime release than this page runs. A selection is not a health check; '
    + 'reloading loads it.'
  return (
    <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '6px 16px 0' }}>
      {held ? <span role="status" data-reload-held="">{`${APPROVAL_FINISHING_WORDS}\u00a0`}</span> : null}
      <button type="button" className="ak-badge ak-tone-gold" data-new-build={shown.release} style={{ cursor: 'pointer' }}
        title={`${what} (${shown.release.slice(0, 12)} ← ${boot === null ? '?' : boot.slice(0, 12)})`}
        onClick={shown.reload}>
        {shown.words?.button ?? 'Build changed · Reload'}
      </button>
    </div>
  )
}

/** Count her corpus file: absent, counted, or why it could not be read. */
async function readCorpus(
  reader: WorkReader, sessionId: SessionId, signal: AbortSignal,
): Promise<Pick<RecallView, 'corpus' | 'corpusTrouble'>> {
  const file = await reader.whole(sessionId, DISCOVERY_CORPUS_PATH, signal)
  if (file.ok) return { corpus: countCorpus(file.text), corpusTrouble: null }
  return isMissing(file.reason) ? { corpus: 'absent', corpusTrouble: null } : { corpus: null, corpusTrouble: file.reason }
}

/** The readout's row origin, narrowed to the ones this view knows; anything else is treated as her organ's own row. */
function sourceOf(source: string): AttentionRow['source'] {
  return source === 'assignment-report' || source === 'heartbeat' ? source : 'status'
}

/** The tool answer's own `ok:false` error, when the call itself went through. */
function outcomeOf(body: BridgeToolBody): Outcome {
  if (body.kind !== 'ok') {
    const detail = 'detail' in body ? body.detail : null
    return { ok: false, reason: typeof detail === 'string' && detail !== '' ? `${body.kind}: ${detail}` : body.kind }
  }
  const value = (body as { value: unknown }).value
  if (value !== null && typeof value === 'object' && (value as { ok?: unknown }).ok === true) return { ok: true }
  const error = value !== null && typeof value === 'object' ? (value as { error?: unknown }).error : undefined
  return { ok: false, reason: typeof error === 'string' ? error : 'refused' }
}

/** The centre surface. Hidden and idle unless it is the selected surface. */
export function WorkSurface({ activeSurface, useSessions, reader, labels, t }: WorkSurfaceProps): JSX.Element | null {
  const active = activeSurface === WORK_SURFACE
  const sessionId = useSessions(sessionOf)
  const bridge = workBridge()
  const [phase, setPhase] = useState<BridgePhase | null>(null)
  const [files, setFiles] = useState<Files>(NO_FILES)
  const [pending, setPending] = useState<Pending | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [outcomes, setOutcomes] = useState<Readonly<Record<string, Outcome>>>({})
  const readRef = useRef<BridgeRead | null>(null)
  const filesRef = useRef<() => void>(() => {})
  const [recall, setRecall] = useState<RecallView>(NO_RECALL)
  const [wake, setWake] = useState<WakeRead | null>(null)
  const [wakeBusy, setWakeBusy] = useState<string | null>(null)
  const [wakeAnswer, setWakeAnswer] = useState<string | null>(null)
  /** Bumped by every wake POST: a poll that started before one is dropped, so it cannot overwrite the POST's answer. */
  const wakeGen = useRef(0)
  const wakeBusyRef = useRef<string | null>(null)
  wakeBusyRef.current = wakeBusy
  /** Asks the verified reader for a fresh read now, or as soon as the read in flight settles (never two at once). */
  const liveRefreshRef = useRef<() => void>(() => {})
  const newBuild = useNewBuild(active)
  // The edge's own build and her published head: the same Reload button, when the host selects nothing.
  // The same read also feeds the Notices launcher (portal/notices.ts), so it is gold while Work is open.
  const reloadNotice = useReloadNoticeFeed(active)
  // Read only to show the edge's owner sign-in when it asks for one; where the page runs is Sovereignty's to say.
  const hostMode = useHostMode(active)
  // THE HOST'S OWN FACTS (Round 18): `/__x6/facts`, set beside this tab's recomputation below.
  const hostFacts = useHostFacts(active)

  // THE VERIFIED READER: one per open surface, stopped when the surface closes.
  useEffect(() => {
    if (!active || bridge === null) return
    const read = bridge.createRead(sessionId === undefined ? {} : {
      sessionId: String(sessionId),
      readText: async (path, signal) => {
        const res = await reader.whole(sessionId, path, signal)
        if (res.ok) return { kind: 'ok', text: res.text }
        if (res.reason.includes('not-found') || res.reason === 'ENOENT') return { kind: 'missing' }
        return { kind: 'unavailable' }
      },
    })
    readRef.current = read
    // THE NEXT READ STARTS ONLY AFTER THIS ONE SETTLES. A fixed interval shorter than the reader's own deadline would
    // abort every slow read before it could publish, and leave her worker running each abandoned status + verify pair.
    let timer: ReturnType<typeof setTimeout> | undefined
    let pending = false
    const now = (): void => {
      if (timer !== undefined) { clearTimeout(timer); timer = undefined }
      read.refresh()
    }
    liveRefreshRef.current = () => {
      if (readSettled(read.current())) now()
      else pending = true
    }
    const off = read.subscribe((next) => {
      setPhase(next)
      if (!readSettled(next)) return
      if (pending) { pending = false; now(); return }
      if (timer === undefined) timer = setTimeout(() => { timer = undefined; read.refresh() }, POLL_MS)
    })
    return () => {
      if (timer !== undefined) clearTimeout(timer)
      liveRefreshRef.current = () => {}
      off()
      read.stop()
      readRef.current = null
    }
  }, [active, bridge, sessionId, reader])

  // HER FILES: head, memory DAG tip, and the raw state file (fallback rows and action eligibility).
  useEffect(() => {
    if (!active || sessionId === undefined) return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    // Only the newest read publishes: a live re-read can overtake a slower poll that started before it.
    let seq = 0
    const tick = (): void => {
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
      const mine = ++seq
      void readFiles(reader, sessionId, controller.signal)
        .then((next) => { if (!controller.signal.aborted && mine === seq) setFiles(next) })
        .catch((error: unknown) => {
          if (controller.signal.aborted || mine !== seq) return
          const reason = error instanceof Error ? error.message : String(error)
          setFiles({ ...NO_FILES, graphTrouble: reason, headTrouble: reason, dagTrouble: reason, readAt: Date.now() })
        })
        .finally(() => { if (!controller.signal.aborted && timer === undefined) timer = setTimeout(tick, POLL_MS) })
    }
    filesRef.current = tick
    tick()
    return () => {
      controller.abort()
      if (timer !== undefined) clearTimeout(timer)
      filesRef.current = () => {}
    }
  }, [active, sessionId, reader])

  // RECALL: walk her DAG again whenever HEAD names a different tip; count her corpus after each file read.
  const dagHeads = files.dag === null ? null : files.dag.heads
  const dagKey = dagHeads === null || dagHeads.length === 0 ? '' : dagHeads.join(',')
  const dagCount = files.dag?.count ?? null
  useEffect(() => {
    if (!active || sessionId === undefined || dagKey === '') return
    const controller = new AbortController()
    void walkDag(reader, sessionId, dagKey.split(','), dagCount, controller.signal)
      .then((dag) => { if (!controller.signal.aborted) setRecall(current => ({ ...current, dag, dagTrouble: null })) })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return
        setRecall(current => ({ ...current, dag: null, dagTrouble: error instanceof Error ? error.message : String(error) }))
      })
    return () => { controller.abort() }
  }, [active, sessionId, reader, dagKey, dagCount])

  // LIVE (Round 13): her commits and the host's pushes re-read at once (one read per 150 ms burst), no refresh needed.
  // The DAG is walked again when the re-read HEAD names a new tip or count.
  const reread = useDebounced(() => {
    filesRef.current()
    liveRefreshRef.current()
  })
  useLiveEvents(active, (event) => {
    if (event.kind === 'wake-updated') {
      // A pushed wake state replaces the readout unless a button's POST is in flight (its answer wins then).
      if (event.wake === null || wakeBusyRef.current !== null) return
      wakeGen.current += 1
      setWake({ kind: 'ok', status: event.wake })
      return
    }
    if (event.kind === 'runtime-updated' || event.kind === 'head-staged' || event.kind === 'repo-staged') return
    if (event.kind === 'mirror-updated' && !touchesHer(event.changedPaths)) return
    reread.poke()
    if (event.kind === 'ball-commit') reread.followUp(COMMIT_FOLLOW_UPS)
  })
  useEffect(() => { if (!active) reread.cancel() }, [active, reread])
  useEffect(() => {
    if (!active || sessionId === undefined || files.readAt === null) return
    const controller = new AbortController()
    void readCorpus(reader, sessionId, controller.signal)
      .then((next) => { if (!controller.signal.aborted) setRecall(current => ({ ...current, ...next })) })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return
        setRecall(current => ({ ...current, corpus: null, corpusTrouble: error instanceof Error ? error.message : String(error) }))
      })
    return () => { controller.abort() }
  }, [active, sessionId, reader, files.readAt])

  // WAKE: the host's timer, re-read while the surface is open (the next read starts after this one settles).
  useEffect(() => {
    if (!active) return
    let live = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const tick = (): void => {
      const gen = wakeGen.current
      void readWake().then((next) => {
        if (!live) return
        if (gen === wakeGen.current) setWake(next)
        timer = setTimeout(tick, POLL_MS)
      })
    }
    tick()
    return () => { live = false; if (timer !== undefined) clearTimeout(timer) }
  }, [active])

  // THE BOUND PASSKEY, READ FROM THIS HOST'S AUMLOK STATUS EACH TIME THE VIEW OPENS (Round 22): with one, a mandate is
  // approved by the passkey over the exact owner-grant bytes, and no owner key signs anything.
  // null: still reading; 'unread': this host gave no AUMLOK status this view can use.
  const [aumlok, setAumlok] = useState<AumlokHostStatus | 'unread' | null>(null)
  useEffect(() => {
    if (!active) return
    const controller = new AbortController()
    void readAumlokStatus(controller.signal)
      .then(
        (read) => { if (!controller.signal.aborted) setAumlok(read.kind === 'live' ? read.status : 'unread') },
        () => { if (!controller.signal.aborted) setAumlok('unread') },
      )
    return () => { controller.abort() }
  }, [active])

  if (!active) return null

  const snapshot = snapshotOf(phase)
  const receipts = receiptsOf(phase)
  const refused = failureKind(phase)
  const tabFacts = tabFactsOf(phase, files.head)
  const agreement = compareTabToHost(tabFacts, hostFacts)
  const suffix = hostRowSuffix(hostFacts, agreement)
  const rows: Rows | null = snapshot !== null ? rowsFromSnapshot(snapshot) : files.graph !== null ? rowsFromFile(files.graph) : null
  // EACH FACT ONCE: derived rows fold into her organ's row for the same assignment (see `attention.ts`).
  const waiting = rows === null ? [] : foldAttention(rows.attention)
  const headingOf = (a: AttentionRow): string => {
    const key = rows === null ? null : headingKey(a, rows.mandates)
    return key === null ? a.kind : labels(key)
  }
  const fileMandate = (id: string) => files.graph?.mandates.find(m => m.id === id)
  const host = aumlok === null || aumlok === 'unread' ? null : aumlok
  const browserBlocker = passkeyBlocker()
  /** True when this host has a bound, verified passkey it is not refusing (no blocker) and this browser can use one. */
  // The Mac host installs no owner-grant approver (server/local-host.mjs), so a passkey there would only be spent and refused.
  const onMac = hostMode.kind === 'local'
  const passkeyDoor = !onMac && host?.state === 'bound' && host.passkeyVerified && host.blockers.length === 0 && browserBlocker === null
  /**
   * Why no mandate can be approved from here, in a few words; null while the host's AUMLOK status is still being read,
   * or when the passkey door is open. The owner-key and tab-click confirms are gone (Round 25): both hosts refuse the
   * first (the Mac installs no approver, the edge wants a passkey approval) and her organ refuses the second.
   */
  const noPasskeyWhy = passkeyDoor || aumlok === null ? null
    : onMac ? labels('passkey.why.mac')
      : host === null ? labels('passkey.why.unread')
        : host.state !== 'bound' ? labels('passkey.why.unbound')
          : !host.passkeyVerified ? labels('passkey.why.unverified')
            : host.blockers.length > 0 ? `${labels('passkey.why.blocked')} (${host.blockers.join(', ')})`
              : browserBlocker
  const fileTicket = (id: string | null) => (id === null ? undefined : files.graph?.tickets.find(tk => tk.id === id))

  const act = (key: string, args: Record<string, unknown>): void => {
    if (bridge === null || busy !== null) return
    setBusy(key)
    setPending(null)
    void bridge.callTool(SUPERAGENT_TOOL, args, new AbortController().signal)
      .then((body) => { setOutcomes(prev => ({ ...prev, [key]: outcomeOf(body) })) })
      .catch((error: unknown) => {
        setOutcomes(prev => ({ ...prev, [key]: { ok: false, reason: error instanceof Error ? error.message : String(error) } }))
      })
      .finally(() => {
        setBusy(null)
        filesRef.current()
        const read = readRef.current
        if (read !== null && readSettled(read.current())) read.refresh()
      })
  }

  /** The exact owner-grant body a passkey approves: her stored scope and ticket, on the head the confirm lands on. */
  const ownerGrantBody = (mandateId: string): OwnerGrantTerms | null => {
    const stored = fileMandate(mandateId)
    const ticket = files.graph?.tickets.find(tk => tk.mandateId === mandateId)
    const head = files.head
    if (stored?.rawScope == null || ticket === undefined || head?.ballId == null || head.epoch === null) return null
    const expiry = stored.rawScope.expiresAt
    return { mandateId, ticketId: ticket.id, scope: stored.rawScope, ballId: head.ballId, epoch: head.epoch,
      expiresAt: typeof expiry === 'number' && Number.isFinite(expiry) ? expiry : null, identity: 'owner' }
  }
  // CLASS 3 BY PASSKEY: the bound passkey approves exactly this body for POST /_host/owner-grant, the host checks it,
  // and the answer is shown as it came. Her organ is not told (it takes only a signature it can check itself).
  const confirmByPasskey = (key: string, mandateId: string): void => {
    if (busy !== null) return
    const body = ownerGrantBody(mandateId)
    setPending(null)
    if (body === null) {
      setOutcomes(prev => ({ ...prev, [key]: { ok: false, reason: labels('noOwner.missingTerms') } }))
      return
    }
    setBusy(key)
    // NO RELOAD OVER AN APPROVAL IN FLIGHT (portal/build-notice.ts): held until this approval settles.
    const releaseReload = holdReload()
    const signal = new AbortController().signal
    void (async (): Promise<Outcome> => {
      // Terms the host would refuse are refused here, before any passkey is asked for.
      const refusal = termsRefusal(body)
      if (refusal !== null) return { ok: false, reason: refusal }
      const action = await class3Action({ audience: globalThis.location.origin, method: 'POST', pathname: OWNER_GRANT_ROUTE, body })
      const approval = await approveClass3(action, { signal })
      if (!approval.ok) return { ok: false, reason: approval.reason }
      // The approval lives only as long as its challenge: one about to expire is not sent (it would be a counted refusal).
      if (approval.hostRemainingMs - (performance.now() - approval.receivedAt) < APPROVAL_MARGIN_MS) {
        return { ok: false, reason: labels('passkey.expired') }
      }
      const sent = await sendApprovedClass3(approval, body, signal)
      if (sent.status === 200 && sent.body?.ok === true && sent.body.authorization === 'bound-passkey-exact-action') {
        return { ok: true, note: labels('passkey.approved') }
      }
      return { ok: false, reason: `${String(sent.status)} ${typeof sent.body?.code === 'string' ? sent.body.code : 'no code'}` }
    })()
      .then((outcome) => { setOutcomes(prev => ({ ...prev, [key]: outcome })) })
      .catch((error: unknown) => {
        setOutcomes(prev => ({ ...prev, [key]: { ok: false, reason: error instanceof Error ? error.message : String(error) } }))
      })
      .finally(() => {
        releaseReload()
        setBusy(null)
        filesRef.current()
      })
  }
  /** A refusal code in words (the host's, for terms it would refuse); a code with no words adds nothing beyond itself. */
  const refusalText = (reason: string): string => {
    const label = labels(`refused.${reason}`)
    return label === `refused.${reason}` ? '' : ` · ${label}`
  }
  const reasonText = (token: string): string => {
    const label = labels(`reason.${token}`)
    return label === `reason.${token}` ? token : label
  }

  const outcomeLine = (key: string) => {
    const o = outcomes[key]
    if (o === undefined) return null
    return (
      <div className={css.workQuiet} data-work-outcome={o.ok ? 'ok' : 'failed'}>
        {/* A note replaces the Stop wording: a passkey approval reaches the host only, never her organ. */}
        {o.ok ? (o.note ?? labels('stop.done')) : `${t('work.action.failed')}: ${o.reason}`}
        {o.ok ? '' : refusalText(o.reason)}
      </div>
    )
  }

  const receiptLine = (): string => {
    if (bridge === null) return t('work.bridge.absent')
    if (receipts === null) return t('work.reading')
    if (receipts.kind === 'verified') {
      const r = receipts as Extract<BridgeReceipts, { kind: 'verified' }>
      return `${t('work.receipts.verified')} · ${r.receiptsVerified ?? '?'} ${t('work.receipts.receipts')} · `
        + `${r.checkpointsVerified ?? '?'} ${t('work.receipts.checkpoints')} · root ${short(r.merkleRoot)}`
    }
    if (receipts.kind === 'rejected') {
      const { stage, error } = receipts as Extract<BridgeReceipts, { kind: 'rejected' }>
      const why = [stage, error].filter((part): part is string => typeof part === 'string' && part !== '').join(': ')
      return `${t('work.receipts.rejected')}${why === '' ? '' : ` (${why})`}`
    }
    return `${t('work.receipts.unverified')} (${receipts.kind})`
  }

  // PREDICTION AND SURPRISE (§13): the verifier on her receipt chain. A score is shown only for a verified
  // register -> promotion -> observe triple; a score field written on a receipt is never read here.
  const predictionLine = (): string => {
    const p = snapshot?.predictions
    if (snapshot === null) return '—'
    if (p === undefined) return labels('prediction.notEvaluated')
    if (p.status === 'verified') {
      const score = p.surpriseScore === null ? '?' : p.surpriseScore === 0 ? `0 — ${labels('prediction.exact')}` : String(p.surpriseScore)
      return `${labels('prediction.verified')} · ${labels('prediction.surprise')} ${score}`
    }
    if (p.status === 'rejected') return `${labels('prediction.rejected')} (${p.reason})`
    return labels('prediction.absent')
  }

  // MEMORY & SURPRISE RECALL: this tab's own walk of her DAG, and her corpus file.
  const recallLine = (): string => {
    const dagPart = (): string => {
      const dag = recall.dag
      if (dag === null) {
        const trouble = recall.dagTrouble ?? files.dagTrouble
        return trouble === null ? '—' : `${labels('recall.noDag')} (${trouble})`
      }
      if (dag.kind === 'verified') return `${String(dag.nodes)} ${labels('recall.nodes')} · tip ${short(dag.tip)}`
      if (dag.kind === 'forked') {
        return dag.nodes < dag.expected
          ? `${String(dag.nodes)} ${labels('recall.of')} ${String(dag.expected)} ${labels('recall.reachable')} (${String(dag.expected - dag.nodes)} `
            + `${labels('recall.orphaned')}) · tip ${short(dag.tip)}`
          : `${String(dag.nodes)} ${labels('recall.reachableOnly')} ${String(dag.expected)} · tip ${short(dag.tip)}`
      }
      if (dag.kind === 'bounded') return `${String(dag.nodes)} ${labels('recall.bounded')}`
      if (dag.kind === 'unread') return `${labels('recall.unread')}: ${short(dag.at)} (${dag.detail}) · ${String(dag.nodes)} ${labels('recall.beforeBreak')}`
      return `${labels('recall.broken')} ${short(dag.at)} (${dag.reason}) · ${String(dag.nodes)} ${labels('recall.beforeBreak')}`
    }
    const corpusPart = (): string => {
      const corpus = recall.corpus
      if (corpus === null) return recall.corpusTrouble === null ? '' : ` · ${t('work.unreadable')} (${recall.corpusTrouble})`
      if (corpus === 'absent') return ` · ${labels('recall.noCorpus')}`
      const unreadable = corpus.unreadableLines === 0 ? '' : `, ${String(corpus.unreadableLines)} ${labels('recall.unreadableLines')}`
      const status = corpusStatus(corpus)
      const said = status === 'mixed'
        ? [
          [corpus.unauthenticated, 'recall.status.someUnauthenticated'],
          [corpus.anchoredClaims, 'recall.status.someAnchored'],
          [corpus.unmarked, 'recall.status.someUnmarked'],
        ].filter(([n]) => n !== 0).map(([n, key]) => `${String(n)} ${labels(String(key))}`).join(', ')
        : labels(`recall.status.${status}`)
      return ` · ${String(corpus.highSurprise)} ${labels('recall.lessons')} (${String(corpus.trajectories)} `
        + `${labels('recall.trajectories')}${unreadable}) — ${said}; ${labels('recall.fromFile')}`
    }
    // A DAG head that failed to read after an earlier good walk: the walk shown is older than the head, and that is said.
    const headPart = recall.dag !== null && files.dagTrouble !== null ? ` · ${labels('recall.noDag')} (${files.dagTrouble})` : ''
    return `${dagPart()}${headPart}${corpusPart()}`
  }
  /**
   * A memory DAG that does not verify, cannot be read, or reaches fewer nodes than HEAD counts stays in sight; so does a
   * DAG head that fails to read after an earlier good walk, and a corpus that cannot be read (a refusal never folds away).
   */
  const recallBad = files.dagTrouble !== null || recall.corpusTrouble !== null
    || (recall.corpus !== null && recall.corpus !== 'absent' && recall.corpus.unreadableLines > 0)
    || (recall.dag === null ? recall.dagTrouble !== null : recall.dag.kind !== 'verified' && recall.dag.kind !== 'bounded')
  /** A prediction the verifier rejected stays in sight; anything else is a research reading and folds away. */
  const predictionBad = snapshot?.predictions?.status === 'rejected'

  // AUTONOMOUS WAKE: the host's timer as it reported it.
  const wakeLine = (): string => {
    if (wake === null) return t('work.reading')
    if (wake.kind === 'absent') return labels('wake.absent')
    if (wake.kind === 'refused') return `${labels('wake.refused')}: ${wake.detail}`
    const w = wake.status
    const every = w.intervalMs === null ? '?' : String(Math.round(w.intervalMs / 60_000))
    const state = w.enabled ? `${labels('wake.on')} ${every} ${labels('wake.minutes')}` : labels('wake.off')
    const outcome = w.lastWakeOutcome === null ? '' : ` (${w.lastWakeOutcome})`
    const last = w.lastWakeAt !== null ? `${labels('wake.last')} ${when(w.lastWakeAt)}${outcome}`
      : w.neverWoke ? labels('wake.never') : `${labels('wake.unknownLast')}${outcome}`
    const count = w.wakeCount === null ? '' : ` · ${String(w.wakeCount)} ${labels('wake.count')}`
    const next = w.enabled && w.nextWakeAt !== null ? ` · ${labels('wake.next')} ${when(w.nextWakeAt)}` : ''
    return `${state} · ${last}${count}${next}`
  }
  const wakeAct = (key: string, request: WakeRequest): void => {
    if (wakeBusy !== null) return
    setWakeBusy(key)
    setWakeAnswer(null)
    wakeGen.current += 1
    void postWake(request)
      .then((read) => {
        wakeGen.current += 1
        if (read.kind === 'ok') setWake(read)
        setWakeAnswer(read.kind === 'ok' ? `${labels('wake.answer')}: ok`
          : read.kind === 'absent' ? labels('wake.absent') : `${labels('wake.refused')}: ${read.detail}`)
      })
      .finally(() => { setWakeBusy(null) })
  }
  const wakeStatus = wake?.kind === 'ok' ? wake.status : null

  /** Where the rows come from. It has its own row only when it says more than the header badge: a stale or refused read. */
  const sourceLine = (): string => {
    if (rows === null) return '—'
    if (rows.source === 'verified') {
      const stale = refused === null ? '' : ` · ${t('work.source.stale')} (${refused})`
      return `${t('work.source.verified')} · ${when(snapshot?.observedAt ?? null)}${stale}`
    }
    return `${t('work.source.file')}${refused === null ? '' : ` (${t('work.source.refused')}: ${refused})`}`
  }
  const sourceInSight = rows !== null && (refused !== null || rows.source === 'state-file')

  const lineageRow = (
    <>
      <dt>{t('work.lineage')}</dt>
      <dd data-work-lineage>
        {files.head === null ? '—'
          : `${t('work.lineage.parent')} ${short(files.head.parentBallId)} → ${t('work.lineage.current')} `
            + `${short(files.head.ballId)} (${t('work.epoch')} ${files.head.epoch ?? '?'})`}
      </dd>
    </>
  )
  const predictionRow = (
    <>
      <dt>{labels('prediction.title')}</dt>
      <dd data-work-prediction={snapshot?.predictions?.status ?? 'none'}>{predictionLine()}</dd>
    </>
  )
  const recallRow = (
    <>
      <dt>{labels('recall.title')}</dt>
      <dd data-work-recall={recall.dag?.kind ?? 'none'}
        data-work-corpus-auth={recall.corpus !== null && recall.corpus !== 'absent' ? corpusStatus(recall.corpus) : undefined}>
        {recallLine()}
      </dd>
    </>
  )
  const sourceRow = (
    <>
      <dt>{t('work.source')}</dt>
      <dd data-work-source={rows?.source ?? 'none'}>{sourceLine()}</dd>
    </>
  )

  // A TICKET FOLDS INTO ITS MANDATE'S ROW (her organ opens one ticket per mandate, under the same title). A ticket whose
  // mandate is not listed keeps a row of its own, so nothing she records is dropped.
  const ticketsOf = (mandateId: string) => (rows === null ? [] : rows.tickets.filter(tk => tk.mandateId === mandateId))
  const looseTickets = rows === null ? []
    : rows.tickets.filter(tk => tk.mandateId === null || !rows.mandates.some(m => m.id === tk.mandateId))
  const ticketText = (tk: Rows['tickets'][number], mandateStopped: boolean): string => {
    const flagged = !mandateStopped && fileTicket(tk.id)?.stoppedFlag === true
    return `${labels('mandate.ticket')} ${tk.state}${flagged ? ` · ${t('work.stoppedFlag')}` : ''}`
  }
  /** True when the mandate's expiry has passed: her stored expiry, else the readout's. */
  const expired = (m: Rows['mandates'][number]): boolean => {
    const at = fileMandate(m.id)?.expiresAt ?? (m.expiry === null ? null : Date.parse(m.expiry))
    return at !== null && Number.isFinite(at) && at <= Date.now()
  }
  const nothingListed = rows !== null && waiting.length === 0 && rows.assignments.length === 0 && rows.mandates.length === 0
    && looseTickets.length === 0

  // IN SIGHT (Round 27): every live bad state is one line above the cards, and the cards themselves close to one line.
  // The rows behind these lines sit in Her records, a card that keeps its body in the page while closed.
  const hostBad = suffix?.kind === 'alarm' || hostFacts.kind === 'incomplete' || hostFacts.kind === 'unavailable'
  const receiptsBad = bridge === null || (receipts !== null && receipts.kind !== 'verified')
  const troubles: (readonly [string, string])[] = [
    ...(files.head === null && files.headTrouble !== null ? [['head', `${t('work.head')}: ${t('work.unreadable')} (${files.headTrouble})`] as const] : []),
    ...(receiptsBad ? [['receipts', `${t('work.receipt')}: ${receiptLine()}`] as const] : []),
    ...(hostBad ? [['host', `${labels('host.title')}: ${hostFactsWords(hostFacts)}${suffix?.kind === 'alarm' ? ` · ${suffix.text}` : ''}`] as const] : []),
    ...(predictionBad ? [['prediction', `${labels('prediction.title')}: ${predictionLine()}`] as const] : []),
    ...(recallBad ? [['recall', `${labels('recall.title')}: ${recallLine()}`] as const] : []),
    ...(sourceInSight ? [['source', `${t('work.source')}: ${sourceLine()}`] as const] : []),
    ...(wake?.kind === 'refused' ? [['wake', `${labels('wake.title')}: ${wakeLine()}`] as const] : []),
  ]
  // VERIFIED only when every row in the card is: receipts verified, the host agrees, and nothing is said above (Round 27 review).
  const recordsBadge: { readonly tone: Tone; readonly text: string } = receipts?.kind === 'rejected' || suffix?.kind === 'alarm'
    ? { tone: 'red', text: 'NOT VERIFIED' }
    : receipts?.kind === 'verified' && !hostBad && troubles.length === 0 && agreement.kind !== 'lag' ? { tone: 'mint', text: 'VERIFIED' }
      : bridge !== null && receipts === null && troubles.length === 0 ? { tone: 'muted', text: 'READING' } : { tone: 'gold', text: 'CHECK ABOVE' }
  const headWords = files.head === null ? null : `${t('work.epoch')} ${files.head.epoch ?? '?'} · ${short(files.head.ballId)}`
  const wakeState = wake === null ? 'reading' : wake.kind === 'ok' ? (wake.status.enabled ? 'on' : 'off') : wake.kind
  /** The wake outcomes that are not trouble: the probe answered, or she was resting and skipped it. */
  const lastOutcome = wake?.kind === 'ok' ? wake.status.lastWakeOutcome : null
  const wakeQuiet = lastOutcome === null || /^probe_(ready|skipped_rest)\b/u.test(lastOutcome)
  const wakeBadge: { readonly tone: Tone; readonly text: string } = wakeState === 'on' ? { tone: wakeQuiet ? 'mint' : 'gold', text: 'ON' }
    : wakeState === 'off' ? { tone: 'muted', text: 'PAUSED' } : wakeState === 'refused' ? { tone: 'red', text: 'REFUSED' }
      : wakeState === 'absent' ? { tone: 'muted', text: 'NOT HERE' } : { tone: 'muted', text: 'READING' }

  return (
    <AppSurface active={active} tone="blue" data-work-surface="">
      <AppHeader
        eyebrow="BACKGROUND MISSIONS · AUTONOMOUS WORK"
        title="WORK"
        tone="blue"
        badges={[rows === null
          ? { text: 'Reading', tone: 'muted' }
          : rows.source === 'verified' ? { text: 'Verified status', tone: 'mint' } : { text: 'File fallback', tone: 'gold' }]}
      />
      <NewBuildButton release={newBuild} words={{ button: labels('build.button'), what: labels('build.what') }} notice={reloadNotice} />
      <section className={css.work} data-auma-work aria-label={t('work.title')}>
        {hostMode.kind === 'signed-out' ? <EdgeOwnerSignIn host={hostMode.host} /> : null}

        {sessionId === undefined ? <p className={css.workTrouble}>{t('work.noSession')}</p> : null}

        {troubles.length === 0 && agreement.kind !== 'lag' ? null : (
          <div className={css.workTroubles} data-work-troubles="">
            {troubles.map(([key, text]) => <Lead key={key}><span role="status" data-work-trouble={key}>{text}</span></Lead>)}
            {agreement.kind === 'lag'
              ? agreement.notes.map(note => <Lead key={note}><span className={css.workLag} data-work-host-lag="" role="status">{note}</span></Lead>)
              : null}
          </div>
        )}

        {rows === null ? (
          <p className={css.workTrouble} data-work-graph-unreadable>
            {files.graphTrouble === null ? t('work.reading') : `${t('work.graphUnreadable')} (${files.graphTrouble})`}
          </p>
        ) : nothingListed ? <p className={css.workQuiet} data-work-empty>{labels('empty')}</p> : null}

        {rows === null || waiting.length === 0 ? null : (
          <div className={css.workGroup} data-work-attention="">
            <SectionLabel>{`${t('work.attention')} (${String(waiting.length)})`}</SectionLabel>
            <PortalGrid open={false}>
              {waiting.map(a => (
                <PortalCell key={a.id} data-work-attention-kind={a.kind} data-work-attention-source={a.source}>
                  <PortalFold tone="gold" icon="approvals" title={headingOf(a)}
                    summary={`${a.text}${a.alsoFrom.length === 0 ? ''
                      : ` · ${a.alsoFrom.map(from => labels(from === 'heartbeat' ? 'also.heartbeat' : 'also.report')).join(' · ')}`}`} />
                </PortalCell>
              ))}
            </PortalGrid>
          </div>
        )}

        {rows === null || rows.assignments.length === 0 ? null : (
          <div className={css.workGroup} data-work-assignments="">
            <SectionLabel>{`${t('work.assignments')} (${String(rows.assignments.length)})`}</SectionLabel>
            <PortalGrid open={false}>
              {rows.assignments.map((a) => {
                const ticket = fileTicket(a.ticketId)
                const ticketId = a.ticketId
                const canStop = a.state === 'running' && ticketId !== null && ticket !== undefined && !ticket.stoppedFlag
                const key = `stop:${ticketId ?? ''}`
                const beat = a.heartbeat
                return (
                  <PortalCell key={a.id} data-work-assignment={a.id}>
                    <div className={css.workCell}>
                      <PortalFold tone={a.state === 'running' ? 'mint' : 'blue'} icon="agent"
                        title={<><code>{a.id}</code> · {a.state} · <span data-executor={a.executor}>{a.executor}</span></>}
                        summary={`${a.report ?? t('work.noReport')}${beat?.ageMs == null ? '' : ` · ${t('work.heartbeat')} ${ageText(beat.ageMs)}`}`}
                        badge={beat === undefined ? undefined : (
                          <span data-work-heartbeat={beat.availability}>
                            <StatusPill tone={beat.availability === 'fresh' ? 'mint' : beat.availability === 'not-running' || beat.availability === 'not-evaluated' ? 'muted' : 'gold'}
                              title={`${t('work.heartbeat')} ${beat.availability}`}>
                              {`${t('work.heartbeat')} ${beat.availability}`}
                            </StatusPill>
                          </span>
                        )} />
                      {canStop ? (
                        <div className={css.workActions}>
                          {pending?.kind === 'stop' && pending.ticketId === ticketId ? (
                            <>
                              <span data-work-stop-ask={ticketId}><code>{ticketId}</code> · {labels('stop.ask')}</span>
                              <button type="button" className="x5-field" disabled={busy !== null}
                                onClick={() => { act(key, { action: 'stop', ticketId }) }}>
                                {t('work.stop.yes')}
                              </button>
                              <button type="button" className="x5-field" onClick={() => { setPending(null) }}>{t('work.cancel')}</button>
                            </>
                          ) : (
                            <button type="button" className="x5-field" data-work-stop={ticketId} disabled={bridge === null || busy !== null}
                              onClick={() => { setPending({ kind: 'stop', ticketId }) }}>
                              {t('work.stop')}
                            </button>
                          )}
                        </div>
                      ) : null}
                      {outcomeLine(key)}
                    </div>
                  </PortalCell>
                )
              })}
            </PortalGrid>
          </div>
        )}

        {rows === null || rows.mandates.length === 0 ? null : (
          <div className={css.workGroup} data-work-mandates="">
            <SectionLabel>{`${t('work.mandates')} (${String(rows.mandates.length)})`}</SectionLabel>
            <PortalGrid open={false}>
              {rows.mandates.map((m) => {
                const file = fileMandate(m.id)
                const confirmation = file?.confirmation ?? 'unknown'
                const stopped = file?.stopped === true
                const ran = expired(m)
                // Approval is by the bound passkey only. An open mandate with no passkey door says why, unless it expired.
                const open = confirmation === 'unconfirmed' && !stopped
                const canConfirm = open && passkeyDoor
                const passkeyBody = canConfirm ? ownerGrantBody(m.id) : null
                const passkeyRefusal = passkeyBody === null ? null : termsRefusal(passkeyBody)
                const key = `confirm:${m.id}`
                const claim = file?.confirmedByClaim
                const confirmText = confirmation === 'recorded'
                  ? `${t('work.confirmRecorded')}${claim == null ? '' : ` by="${claim}"`} (${t('work.claimUnverified')})`
                  : confirmation === 'self-declared' ? t('work.selfDeclared')
                    : confirmation === 'unconfirmed' ? t('work.unconfirmed') : t('work.confirmUnknown')
                const tickets = ticketsOf(m.id)
                const who = m.authorityIdentityClaim ?? m.grantIdentity ?? null
                // The badge says what the reader found, never more: mint only for an owner-confirmed grant (Round 27 review).
                const badge: { readonly tone: Tone; readonly text: string } = ran ? { tone: 'red', text: 'EXPIRED' }
                  : stopped ? { tone: 'muted', text: 'STOPPED' } : open ? { tone: 'gold', text: 'UNCONFIRMED' }
                    : m.authorityLevel === 'owner-confirmed' ? { tone: 'mint', text: 'OWNER CONFIRMED' }
                      : m.authorityLevel === undefined ? { tone: 'muted', text: 'NOT CHECKED' }
                        : { tone: 'gold', text: m.authorityLevel.toUpperCase() }
                return (
                  <PortalCell key={m.id} data-work-mandate={m.id}>
                    <div className={css.workCell}>
                      <PortalFold
                        tone={ran ? 'red' : open ? 'gold' : 'blue'}
                        icon="releases"
                        data-work-mandate-details={m.id}
                        title={(
                          <span data-work-mandate-head={m.id}>
                            <strong>{file?.title ?? m.title}</strong>
                            {ran ? <> · <strong data-work-expired="">{labels('mandate.expired')}</strong></> : null}
                            {stopped ? ` · ${t('work.stoppedFlag')}` : ''}
                          </span>
                        )}
                        summary={(
                          <>
                            {m.strength} · {confirmText}
                            {tickets.map(tk => <span key={tk.id} data-work-ticket={tk.id}>{` · ${ticketText(tk, stopped)}`}</span>)}
                          </>
                        )}
                        badge={<StatusPill tone={badge.tone}>{badge.text}</StatusPill>}
                      >
                        <div className={css.workQuiet}>
                          {m.authorityLevel === undefined ? null : (
                            <div data-work-authority-detail="">
                              {t('work.authorityLevel')}: {m.authorityLevel}
                              {m.authorityProvenance === undefined ? '' : ` (${m.authorityProvenance})`}
                              {m.authorityIdentitySource === undefined ? '' : ` [${m.authorityIdentitySource}]`}
                              {m.authorityUserVerification === undefined ? '' : ` · uv:${m.authorityUserVerification}`}
                            </div>
                          )}
                          {m.authorityLevel === 'owner-confirmed' && m.authorityUserVerification !== 'attested' ? (
                            <div data-work-owner-note={m.authorityProvenance ?? ''}>{labels('owner.note')}</div>
                          ) : null}
                          {m.grantSeq === undefined ? null : (() => {
                            const lineage = grantLineage(files.head, m.grantBallId, m.authorityLineage)
                            return (
                              <div data-work-grant-lineage={lineage}>
                                {t('work.grantAt')} {t('work.epoch')} {m.grantEpoch ?? '?'} · {short(m.grantBallId)}
                                {' — '}{t(`work.lineage.${lineage}`)}
                              </div>
                            )
                          })()}
                          <div data-work-scope="">
                            {t('work.scope')}: <code>{m.scope}</code> · {t('work.expires')} {m.expiry ?? '—'} · <code>{m.id}</code>
                            {tickets.map(tk => <span key={tk.id}>{' · '}{labels('mandate.ticket')} <code>{tk.id}</code></span>)}
                          </div>
                        </div>
                      </PortalFold>
                      {m.authorityLevel === undefined ? null : (
                        <div
                          data-work-authority-level={m.authorityLevel}
                          data-work-authority-provenance={m.authorityProvenance}
                          data-work-authority-reasons={m.authorityReasons?.join(',')}
                        >
                          {t('work.authorityLevel')}: <strong>{m.authorityLevel}</strong>
                          {m.grantSeq === undefined ? '' : ` · ${t('work.grant')} #${m.grantSeq}`}
                          {m.grantSeq === undefined && m.authorityIdentityClaim == null
                            ? ''
                            : ` by="${m.authorityIdentityClaim ?? m.grantIdentity ?? '?'}"`}
                          {m.authorityReasons === undefined || m.authorityReasons.length === 0
                            ? ''
                            : ` · ${m.authorityReasons.map(reasonText).join(', ')}`}
                        </div>
                      )}
                      {who === 'spatial-tab'
                        ? <p className={css.workQuiet} data-work-grant-origin="tab">{labels('grant.fromTab')}</p>
                        : null}
                      {who === 'agent-self-unverified'
                        ? <p className={css.workQuiet} data-work-grant-origin="self">{labels('grant.selfUnverified')}</p>
                        : null}
                      {canConfirm ? (
                        <div className={css.workActions}>
                          {pending?.kind === 'confirm' && pending.mandateId === m.id ? (
                            <div className={css.workConfirm} data-work-confirm-terms={m.id} data-work-confirm-path="passkey">
                              <p className={css.workQuiet}>{labels('confirm.passkeyTerms')}</p>
                              <pre className={css.workTerms}>
                                {passkeyBody === null ? labels('noOwner.missingTerms') : JSON.stringify(passkeyBody, null, 1)}
                              </pre>
                              <p className={css.workQuiet} data-work-confirm-what>{labels('confirm.passkeyWhat')}</p>
                              {passkeyRefusal === null ? null : (
                                <p className={css.workQuiet} data-work-confirm-refused={passkeyRefusal}>
                                  {labels('passkey.wouldRefuse')} {passkeyRefusal}{refusalText(passkeyRefusal)}
                                </p>
                              )}
                              <div className={css.workActions}>
                                <button
                                  type="button"
                                  className="x5-field"
                                  disabled={busy !== null || passkeyBody === null || passkeyRefusal !== null}
                                  onClick={() => { confirmByPasskey(key, m.id) }}
                                >
                                  {labels('confirm.passkeyYes')}
                                </button>
                                <button type="button" className="x5-field" onClick={() => { setPending(null) }}>{t('work.cancel')}</button>
                              </div>
                            </div>
                          ) : (
                            <button type="button" className="x5-field" data-work-confirm={m.id} disabled={busy !== null}
                              onClick={() => { setPending({ kind: 'confirm', mandateId: m.id }) }}>
                              {labels('confirm.open')}
                            </button>
                          )}
                        </div>
                      ) : null}
                      {open && !canConfirm && !ran && noPasskeyWhy !== null ? (
                        <p className={css.workQuiet} data-work-no-passkey="">{labels('passkey.none')}: {noPasskeyWhy}</p>
                      ) : null}
                      {outcomeLine(key)}
                    </div>
                  </PortalCell>
                )
              })}
            </PortalGrid>
          </div>
        )}

        {rows === null || looseTickets.length === 0 ? null : (
          <div className={css.workGroup} data-work-tickets="">
            <SectionLabel>{`${t('work.tickets')} (${String(looseTickets.length)})`}</SectionLabel>
            <PortalGrid open={false}>
              {looseTickets.map(tk => (
                <PortalCell key={tk.id} data-work-loose-ticket={tk.id}>
                  <PortalFold tone="blue" icon="thread"
                    title={<>{tk.title} · {tk.state}{fileTicket(tk.id)?.stoppedFlag === true ? ` · ${t('work.stoppedFlag')}` : ''} · <code>{tk.id}</code></>} />
                </PortalCell>
              ))}
            </PortalGrid>
          </div>
        )}

        <PortalGrid open={false}>
          <PortalCell data-work-card="wake">
            <div className={css.workCell}>
              <PortalFold tone="violet" icon="agent" title={labels('wake.title')}
                summary={<span data-work-wake={wakeState}>{wakeLine()}</span>}
                badge={<StatusPill tone={wakeBadge.tone}>{wakeBadge.text}</StatusPill>} />
              {wakeStatus === null ? null : (
                <div className={css.workActions} data-work-wake-actions>
                  <button type="button" className="x5-field" disabled={wakeBusy !== null}
                    onClick={() => { wakeAct('trigger', { action: 'trigger' }) }}>{labels('wake.now')}</button>
                  <button type="button" className="x5-field" disabled={wakeBusy !== null}
                    onClick={() => {
                      wakeAct('configure', { action: 'configure', enabled: !wakeStatus.enabled, intervalMs: wakeInterval(wakeStatus) })
                    }}>
                    {wakeStatus.enabled
                      ? labels('wake.disable')
                      : `${labels('wake.enable')} (${String(Math.round(wakeInterval(wakeStatus) / 60_000))} ${labels('wake.minutes')})`}
                  </button>
                  {wakeAnswer === null ? null : <span className={css.workQuiet} data-work-wake-answer>{wakeAnswer}</span>}
                </div>
              )}
            </div>
          </PortalCell>
          <PortalCell data-work-card="records">
            {/* ONE CLOSED CARD (Round 27): her records behind this view; every bad state above is also said in sight. */}
            <PortalFold
              tone={recordsBadge.tone === 'red' ? 'red' : recordsBadge.tone === 'gold' ? 'gold' : 'blue'}
              icon="approvals"
              data-work-details=""
              title={labels('records.title')}
              summary={[headWords, receiptLine()].filter((part): part is string => part !== null).join(' · ')}
              badge={<StatusPill tone={recordsBadge.tone}>{recordsBadge.text}</StatusPill>}
            >
              <dl className={css.workFacts} data-work-facts>
                <dt>{t('work.head')}</dt>
                <dd data-work-head>
                  {files.head === null
                    ? (files.headTrouble === null ? '—' : `${t('work.unreadable')} (${files.headTrouble})`)
                    : headWords}
                </dd>
                <dt>{t('work.receipt')}</dt>
                <dd data-work-receipts={receipts?.kind ?? 'none'}>{receiptLine()}</dd>
                <dt>{labels('host.title')}</dt>
                <dd data-work-host-facts={hostFacts.kind} data-work-host-agreement={agreement.kind}>
                  {hostFactsWords(hostFacts)}
                  {/* A signer that is not the pinned key, or an unreadable pin, outranks counts agreeing (Round 20). */}
                  {suffix === null ? null : ` · ${suffix.kind === 'alarm' ? suffix.text : labels('host.match')}`}
                </dd>
                {predictionRow}
                {recallRow}
                {rows === null ? null : sourceRow}
                {lineageRow}
                <dt>{t('work.readAt')}</dt>
                <dd>{when(files.readAt)}</dd>
              </dl>
              {wakeStatus === null ? null : <p className={css.workQuiet} data-work-wake-what>{labels('wake.what')}</p>}
            </PortalFold>
          </PortalCell>
        </PortalGrid>

        {files.graph === null || files.graph.skipped === 0 ? null : (
          <p className={css.workQuiet} data-work-skipped>{labels('stateFile.skipped')}: {files.graph.skipped}</p>
        )}
      </section>
    </AppSurface>
  )
}
