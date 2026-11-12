// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The Aukora authors
/**
 * THE REPO PROPOSAL CARD (Wave 4, Wall 2): a branch Auma staged for merging into main, shown with every commit and file it
 * changes and its CI, merged on one Touch ID (`aumlok/repo-proposal.ts`). The card shows only while a proposal is staged,
 * or with the outcome of the owner's approval.
 * @module portal/RepoProposalCell
 */
import { useEffect, useRef, useState } from 'react'
import {
  approveAndMerge, CHANGED_FILES_SHOWN, mergeOutcomeWords, readPromotionStatus, repoProposalProblems,
  type RepoProposal, type RepoProposalRead,
} from '../aumlok/repo-proposal.ts'
import type { Class3Action, Class3Dependencies } from '../aumlok/class3-approval.ts'
import { FieldTable, Lead, PortalButton, PortalCell, RecordList, RecordRow, StatusPill, type Tone } from '../primitives/index.ts'
import { useDebounced, useLiveEvents } from '../work/autonomy.ts'
import { beginApproval, endApproval, freshFor, mergeApprovalKey, passkeyDidNotComplete, TAP_AGAIN } from './touch-id-timing.ts'

export interface RepoProposalCellProps {
  readonly active: boolean
  readonly round: number
  readonly ownerBound: boolean
  /** Tests pass their own passkey and host call; the page uses the browser's. */
  readonly ceremony?: Omit<Class3Dependencies, 'signal'>
  readonly fetchImpl?: typeof fetch
  /** Told whether the card shows, so the waiting section above it shows only when something does. */
  readonly onShown?: (shown: boolean) => void
}

interface Checked {
  readonly proposal: RepoProposal
  readonly canonical: string
  readonly problems: readonly string[]
  readonly terms: Class3Action
}
type CardRead = { readonly kind: 'quiet' } | { readonly kind: 'staged'; readonly checked: Checked } | { readonly kind: 'malformed' }
  | { readonly kind: 'unread'; readonly why: string }
/** `about`: the proposal the line is about; `carried`: a line that explains why the card now shows another one. */
type Outcome = { readonly state: 'working' | 'merged' | 'refused' | 'unclear'; readonly text: string; readonly about: string }

const CI_WORDS: Record<RepoProposal['ciStatus'], { readonly text: string; readonly tone: Tone; readonly note: string | null }> = {
  passed: { text: 'CI passed', tone: 'mint', note: null },
  pending: { text: 'CI running', tone: 'gold', note: 'CI has not finished on this exact commit as of staging. The host merges only once it has passed; she stages it again to show the result.' },
  failed: { text: 'CI FAILED', tone: 'red', note: 'CI FAILED on this exact commit. The host will not merge it; she needs a new commit on the branch.' },
  none: { text: 'no CI run', tone: 'gold', note: 'No CI ran on this exact commit before she staged it. The host merges only once it has passed; she stages it again to show the result.' },
}

const short = (sha: string): string => sha.slice(0, 12)

async function readCard(signal: AbortSignal, fetchImpl: typeof fetch | undefined): Promise<CardRead> {
  const { repo } = await readPromotionStatus(signal, fetchImpl)
  return checkedRead(repo)
}
async function checkedRead(repo: RepoProposalRead): Promise<CardRead> {
  if (repo.kind === 'malformed') return { kind: 'malformed' }
  if (repo.kind === 'unread') return { kind: 'unread', why: repo.why }
  if (repo.kind !== 'staged') return { kind: 'quiet' }
  const { problems, terms } = await repoProposalProblems(repo.proposal, globalThis.location.origin)
  return { kind: 'staged', checked: { proposal: repo.proposal, canonical: repo.canonical, problems, terms } }
}

export function RepoProposalCell({ active, round, ownerBound, ceremony, fetchImpl, onShown }: RepoProposalCellProps) {
  const [read, setRead] = useState<CardRead>({ kind: 'quiet' })
  const [tick, setTick] = useState(0)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const [outcome, setOutcome] = useState<Outcome | null>(null)
  /** Why the last background read failed while a proposal stayed on screen (null when it read). */
  const [stale, setStale] = useState<string | null>(null)
  /** When the card last read HEAD: a check this recent is used as it is at the tap (Safari). */
  const [readAt, setReadAt] = useState(0)
  useEffect(() => {
    if (!active) return
    const controller = new AbortController()
    const startedAt = Date.now()
    void readCard(controller.signal, fetchImpl).then((next) => {
      // During an approval nothing replaces the card the owner is acting on; a read that failed keeps the proposal shown,
      // and says so on it.
      if (controller.signal.aborted || busyRef.current) return
      setStale(next.kind === 'unread' ? next.why : null)
      if (next.kind !== 'unread') setReadAt(startedAt)
      setRead(prev => (next.kind === 'unread' && prev.kind === 'staged' ? prev : next))
    })
    return () => { controller.abort() }
  }, [active, round, tick, fetchImpl])
  // An approval in progress stops when the owner leaves Sovereignty (the passkey sheet closes; nothing is sent).
  const approval = useRef<AbortController | null>(null)
  useEffect(() => {
    if (active) return
    setOutcome(null)
    approval.current?.abort()
  }, [active])
  useEffect(() => () => { approval.current?.abort() }, [])
  const reread = useDebounced(() => { setTick(n => n + 1) })
  useLiveEvents(active, (event) => {
    if (event.kind === 'repo-staged' || event.kind === 'repo-merged' || event.kind === 'ball-commit') reread.poke()
  })
  useEffect(() => { if (!active) reread.cancel() }, [active, reread])

  const checked = read.kind === 'staged' ? read.checked : null
  const shownOutcome = outcome !== null && (checked === null || outcome.about === checked.canonical) ? outcome : null
  // Nothing staged and nothing to say: no card. A route that failed is said only while a proposal was being shown.
  const shows = !(checked === null && read.kind !== 'malformed' && shownOutcome === null)
  useEffect(() => { onShown?.(shows) }, [shows, onShown])
  useEffect(() => () => { onShown?.(false) }, [onShown])
  if (!shows) return null

  const approve = async (): Promise<void> => {
    if (checked === null || checked.problems.length > 0 || busyRef.current) return
    // SAFARI: the passkey sheet opens only inside the tap. A check this recent (and newer than any approval another card
    // started for this proposal) is used as it is, so the tap goes straight to the passkey challenge; the host checks main
    // and the branch again when the approved request arrives.
    const approvalKey = mergeApprovalKey(checked.canonical)
    const fresh = freshFor(approvalKey, readAt) && stale === null
    if (!beginApproval(approvalKey)) {
      setOutcome({ state: 'refused', about: checked.canonical, text: 'Another card on this page is approving this merge right now; nothing more was asked.' })
      return
    }
    busyRef.current = true
    setBusy(true)
    const controller = new AbortController()
    approval.current = controller
    const signal = controller.signal
    setOutcome({ state: 'working', about: checked.canonical, text: fresh ? 'Waiting for Touch ID…' : 'Reading the proposal again before asking for your passkey…' })
    try {
      // READ AGAIN AT THE CLICK (when the card's check is not fresh): the passkey is asked only for the proposal HEAD holds now.
      const recheckAt = Date.now()
      const now: CardRead = fresh ? { kind: 'staged', checked } : await readCard(signal, fetchImpl)
      if (now.kind !== 'staged' || now.checked.canonical !== checked.canonical) {
        // The line goes with the proposal the card now shows (it explains why that one is there).
        setOutcome({ state: 'refused', about: now.kind === 'staged' ? now.checked.canonical : checked.canonical, text: 'Not approved: what HEAD '
          + 'holds changed since this card read it. The card shows what is staged now.' })
        setRead(now)
        return
      }
      if (now.checked.problems.length > 0) {
        setOutcome({ state: 'refused', about: checked.canonical, text: 'Not approved: checked again just now, it no longer passes this page’s checks.' })
        setRead(now)
        return
      }
      // The re-check is the card's check now, so one more tap after a passkey Safari would not open goes straight to it.
      if (!fresh) { setRead(now); setReadAt(recheckAt); setStale(null) }
      const result = await approveAndMerge(now.checked.proposal, now.checked.terms, { ...ceremony, signal }, fetchImpl)
      // After the passkey: the card's other facts (CI, files) are read once more; a change is said beside the outcome.
      const after = await readCard(signal, fetchImpl)
      const drifted = after.kind === 'staged' && after.checked.canonical !== now.checked.canonical && result.kind !== 'merged'
      const words = mergeOutcomeWords(result, now.checked.proposal)
      const tapAgain = !fresh && result.kind === 'not-approved' && passkeyDidNotComplete(words)
      setOutcome({ state: result.kind === 'merged' ? 'merged' : result.kind === 'unclear' ? 'unclear' : 'refused',
        text: tapAgain ? TAP_AGAIN : `${words}${drifted ? ' (The proposal changed meanwhile: read it again before approving.)' : ''}`,
        about: checked.canonical })
    } catch (error) {
      setOutcome({ state: 'unclear', about: checked.canonical, text: `No clear answer (${error instanceof Error ? error.message : String(error)}). `
        + 'Refresh reads it again; check GitHub before approving again.' })
    } finally {
      endApproval(approvalKey)
      if (approval.current === controller) approval.current = null
      busyRef.current = false
      setBusy(false)
      setTick(n => n + 1)
    }
  }

  const proposal = checked?.proposal ?? null
  const ci = proposal === null ? null : CI_WORDS[proposal.ciStatus]
  const t2 = proposal === null ? 0 : proposal.changedFiles.filter(file => file.t2Protected).length
  const ready = checked !== null && checked.problems.length === 0
  return (
    <PortalCell data-sovereignty-portal="repo-proposal">
      <PortalButton
        defaultExpanded
        tone="gold"
        icon="releases"
        title="Auma asks to merge"
        summary={proposal === null ? (read.kind === 'malformed' ? 'a staged proposal this page cannot read' : 'the last proposal')
          : `${proposal.title} · ${proposal.branch} · ${String(proposal.changedFiles.length)} files${ci === null ? '' : ` · ${ci.text}`}`}
        badge={<StatusPill tone={ready ? 'gold' : shownOutcome?.state === 'merged' ? 'mint' : 'muted'}>
          {ready ? 'CLASS 3' : proposal !== null || read.kind === 'malformed' ? 'CANNOT MERGE' : (shownOutcome?.state ?? '').toUpperCase()}
        </StatusPill>}
      >
        {proposal === null || checked === null ? (
          read.kind === 'malformed'
            ? <Lead>HEAD holds a staged repo proposal, but not in a form this page can check, so nothing is offered.</Lead>
            : null
        ) : (
          <>
            {ci?.note === null || ci === null ? null : <Lead><span role="status" data-repo-proposal-ci-warning="">{ci.note}</span></Lead>}
            {checked.problems.length > 0 ? (
              <Lead><span data-repo-proposal-problems="">{`No passkey is asked for: ${checked.problems.join(' · ')}`}</span></Lead>
            ) : (
              <>
                <button type="button" className="x5-field" data-repo-proposal-approve="" disabled={busy || !ownerBound}
                  onClick={() => { void approve() }}>
                  {`Approve and Merge ${proposal.branch} with Touch ID`}
                </button>
                <Lead>
                  {ownerBound
                    ? `Touch ID approves exactly this merge, once: main moves from ${short(proposal.baseSha)} to ${short(proposal.headSha)}. `
                      + 'The host merges only if main and the branch are still exactly these commits.'
                    : 'No usable passkey is bound on this host, so nothing can approve it here.'}
                </Lead>
              </>
            )}
            <FieldTable rows={[
              ['proposal', proposal.title],
              ...(proposal.summary === null ? [] : [['summary', proposal.summary] as const]),
              ['branch', <span key="branch" data-repo-proposal-branch="">{proposal.branch}</span>],
              ['main moves', <span key="move" data-repo-proposal-move="">{`${short(proposal.baseSha)} → ${short(proposal.headSha)}`}</span>],
              ['tree', proposal.treeSha],
              ['CI on this commit', <span key="ci" data-repo-proposal-ci={proposal.ciStatus}><StatusPill tone={ci?.tone ?? 'muted'}>{ci?.text ?? ''}</StatusPill></span>],
              ['files', `${String(proposal.changedFiles.length)} changed${t2 > 0 ? `, ${String(t2)} of them protected (T2)` : ''}`],
              ...(proposal.stagedAt === null ? [] : [['staged on HEAD', new Date(proposal.stagedAt).toISOString()] as const]),
            ]}
            />
            <RecordList>
              <RecordRow tone={t2 > 0 ? 'gold' : 'muted'} title="Changed files" summary={proposal.changedFiles.slice(0, 3).map(file => file.path).join(' · ')}>
                <ul data-repo-proposal-files="" style={{ margin: 0, paddingLeft: 18, fontSize: 12, lineHeight: 1.6, overflowWrap: 'anywhere' }}>
                  {proposal.changedFiles.slice(0, CHANGED_FILES_SHOWN).map(file => (
                    <li key={file.path} data-repo-proposal-file={file.path} data-t2={file.t2Protected || undefined}>
                      {`${file.t2Protected ? 'T2 · ' : ''}${file.status} ${file.previousPath === null ? '' : `${file.previousPath} → `}${file.path}`
                        + (file.additions === null ? '' : ` +${String(file.additions)}`)
                        + (file.deletions === null ? '' : ` −${String(file.deletions)}`)}
                    </li>
                  ))}
                </ul>
                {proposal.changedFiles.length > CHANGED_FILES_SHOWN
                  ? <Lead>{`and ${String(proposal.changedFiles.length - CHANGED_FILES_SHOWN)} more files (not listed here)`}</Lead> : null}
              </RecordRow>
            </RecordList>
          </>
        )}
        {stale === null || checked === null ? null
          : <Lead><span role="status" data-repo-proposal-stale="">{`Not read again just now (${stale}): this is the proposal as last read.`}</span></Lead>}
        {shownOutcome === null ? null : <Lead><span role="status" data-repo-proposal-outcome={shownOutcome.state}>{shownOutcome.text}</span></Lead>}
      </PortalButton>
    </PortalCell>
  )
}
