// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The Aukora authors
/**
 * "APPROVAL WAITING" ON THE OUTER SPATIAL CHROME (Wave 4, AC1): whenever HEAD holds something only the owner's passkey can
 * approve (a staged Pearl, or a repo proposal), one pill shows above every surface, whatever is open, and one click opens
 * Sovereignty, where the card is. It approves nothing itself.
 *
 * WHAT IT READS: `GET /_head/promotion-status` (`staged`, `stagedRepoProposal`): once when the page opens, again on every
 * push that can change it (`head:staged`, `repo:staged`, `repo:merged`, a ball commit), when the tab comes back into view,
 * and once a minute in case a push was missed. A host with no such route (the Mac host) or a read that fails shows no pill:
 * the pill says something only when HEAD said it.
 * @module portal/ApprovalWaiting
 */
import { useEffect, useState } from 'react'
import { readPromotionStatus } from '../aumlok/repo-proposal.ts'
import { useDebounced, useLiveEvents } from '../work/autonomy.ts'

/** How often the pill reads again when no push arrives. */
export const APPROVAL_POLL_MS = 60_000

export interface ApprovalWaitingInjected {
  /** Open the Sovereignty surface. */
  readonly openSovereignty: () => void
  readonly fetchImpl?: typeof fetch
}

/** What is waiting for the owner, as HEAD said it. */
export interface Waiting { readonly pearl: boolean; readonly repo: boolean }

/**
 * Read what HEAD holds for the owner.
 * @param signal - aborts the read.
 * @param fetchImpl - the page's fetch.
 * @returns what is waiting, or null when HEAD did not say (no route, a failed read).
 */
export async function readWaiting(signal: AbortSignal, fetchImpl?: typeof fetch): Promise<Waiting | 'no-route' | null> {
  const { repo, pearlStaged } = await readPromotionStatus(signal, fetchImpl)
  if (repo.kind === 'absent' && pearlStaged === null) return 'no-route'
  if (pearlStaged === null) return null
  // A proposal HEAD serves in a form the page cannot check still waits for the owner: Sovereignty says why it cannot merge.
  return { pearl: pearlStaged, repo: repo.kind === 'staged' || repo.kind === 'malformed' }
}

/** The pill's words. */
export function waitingWords(waiting: Waiting): string {
  if (waiting.pearl && waiting.repo) return 'Approvals waiting: a Pearl and a merge'
  return waiting.repo ? 'Approval waiting: a merge' : 'Approval waiting: a Pearl'
}

export function ApprovalWaiting({ openSovereignty, fetchImpl }: ApprovalWaitingInjected) {
  const [waiting, setWaiting] = useState<Waiting | null>(null)
  // A host with no such route (the Mac host) is not asked again: nothing there can wait for the passkey this way.
  const [noRoute, setNoRoute] = useState(false)
  const [visible, setVisible] = useState(() => document.visibilityState !== 'hidden')
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (noRoute) return
    const controller = new AbortController()
    void readWaiting(controller.signal, fetchImpl).then((next) => {
      if (controller.signal.aborted) return
      if (next === 'no-route') { setNoRoute(true); setWaiting(null) } else setWaiting(next)
    })
    return () => { controller.abort() }
  }, [tick, fetchImpl, noRoute])
  useEffect(() => {
    if (noRoute) return
    const timer = setInterval(() => { if (document.visibilityState !== 'hidden') setTick(n => n + 1) }, APPROVAL_POLL_MS)
    const onVisible = (): void => {
      setVisible(document.visibilityState !== 'hidden')
      if (document.visibilityState === 'visible') setTick(n => n + 1)
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', onVisible) }
  }, [noRoute])
  const reread = useDebounced(() => { setTick(n => n + 1) })
  // Listening holds the page's live socket open, so only while the tab is in view (a hidden tab reads again on return).
  useLiveEvents(visible && !noRoute, (event) => {
    if (event.kind === 'head-staged' || event.kind === 'repo-staged' || event.kind === 'repo-merged' || event.kind === 'ball-commit') reread.poke()
  })
  const show = waiting !== null && (waiting.pearl || waiting.repo)
  // The live region is always there, so a pill that appears is announced; the button is in it only while something waits.
  return (
    <div role="status" aria-live="polite" style={{ position: 'absolute', top: 'calc(var(--dsh-hot-corner-size, 28px) + 8px)', left: '50%',
      transform: 'translateX(-50%)', zIndex: 30, pointerEvents: show ? 'auto' : 'none' }}>
      {!show ? null : (
        <button
          type="button"
          className="aukora-approval-waiting"
          data-approval-waiting={waiting.pearl && waiting.repo ? 'both' : waiting.repo ? 'repo' : 'pearl'}
          onClick={openSovereignty}
          style={{
            display: 'inline-flex', alignItems: 'center', whiteSpace: 'nowrap', maxWidth: 'calc(100vw - 32px)', overflow: 'hidden', textOverflow: 'ellipsis',
            gap: 8, padding: '6px 14px', borderRadius: 999, border: '1px solid color-mix(in srgb, var(--ak-gold, #e0b76a) 75%, transparent)',
            background: 'rgba(14, 18, 28, 0.96)', backdropFilter: 'blur(16px)', WebkitBackdropFilter: 'blur(16px)', color: 'var(--ak-gold, #e0b76a)',
            font: 'inherit', fontSize: 12, letterSpacing: '0.04em', cursor: 'pointer', boxShadow: '0 8px 28px rgba(0, 0, 0, 0.5)',
          }}
        >
          <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: 999, background: 'currentColor' }} />
          {waitingWords(waiting)}
          <span style={{ opacity: 0.75 }}>· open Sovereignty</span>
        </button>
      )}
    </div>
  )
}
