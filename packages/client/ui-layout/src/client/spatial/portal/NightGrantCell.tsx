// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The Aukora authors
/**
 * THE NIGHT GRANT, INSIDE SOVEREIGNTY'S KEYS AND TRUST CARD: whether Auma may add or update her ordinary organs without a tap each time, in
 * the plain words HEAD states, with how many uses are left. Asking for it is two clicks: the first shows the exact
 * terms in words, the second asks Touch ID for exactly those bytes. Revoking is one click and needs no passkey (it only
 * removes authority). An unread grant is shown as unknown, never as "none" or fine.
 * It is a section of an existing card, not a new card: Sovereignty keeps its two cards.
 * @module portal/NightGrantCell
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { FieldTable, Lead, SectionLabel, StatusPill } from '../primitives/index.ts'
import { holdReload } from './build-notice.ts'
import {
  approveNightGrant, newNightGrantId, nightGrantTerms, nightGrantWords, readNightGrant, revokeNightGrant,
  type NightGrantStatus, type NightGrantTerms,
} from '../aumlok/night-grant.ts'

type Read = { readonly kind: 'reading' } | { readonly kind: 'unknown' } | { readonly kind: 'none' } | { readonly kind: 'grant'; readonly status: NightGrantStatus }

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)

/** Read the selected head the grant must be issued on. */
async function readHead(signal: AbortSignal): Promise<{ ballId: string; epoch: number } | null> {
  const response = await fetch('/_head/status', { method: 'GET', credentials: 'same-origin', cache: 'no-store', signal })
  const answer: unknown = await response.json().catch(() => null)
  if (response.status !== 200 || !isRecord(answer) || typeof answer.ballId !== 'string' || !Number.isSafeInteger(answer.epoch)) return null
  return { ballId: answer.ballId, epoch: answer.epoch as number }
}

/**
 * Only the extra authority a grant gives: without one, adding an organ, or replacing an organ's code where your
 * Touch ID is asked today, keeps asking for it. What already needs no tap (an ordinary code update in your own session)
 * is unchanged either way, so it is not described as needing one.
 */
export const WITHOUT_GRANT = 'Adding an organ, and any code change that asks for your Touch ID today, keep asking for it.'

/** Words for one read; exported for the spec. */
export function nightGrantSummary(read: Read): { badge: string; tone: 'gold' | 'blue' | 'muted'; summary: string } {
  if (read.kind === 'reading') return { badge: 'READING', tone: 'muted', summary: 'Reading the night grant…' }
  if (read.kind === 'unknown') return { badge: 'UNKNOWN', tone: 'gold', summary: 'HEAD did not answer, so whether a night grant is active is unknown.' }
  if (read.kind === 'none') return { badge: 'NONE', tone: 'blue', summary: `No night grant. ${WITHOUT_GRANT}` }
  const { status } = read
  if (status.state === 'active') return { badge: `${String(status.usesLeft)} LEFT`, tone: 'gold', summary: `Active: Auma may promote ordinary organs ${String(status.usesLeft)} more times without a tap.` }
  return { badge: status.state.toUpperCase(), tone: 'blue', summary: `The last night grant is ${status.state}. ${WITHOUT_GRANT}` }
}

/** The section (inside the Keys and trust card). */
export function NightGrantCell({ active, round }: { readonly active: boolean; readonly round: number }) {
  // EVERY READ HAS ITS OWN IDENTITY (as the chain verdict): a never-reused number set before paint whenever
  // the card opens, Refresh runs or an action settles; only that read's answer is shown, so a stalled read says
  // "Reading", never the previous answer.
  const readCounter = useRef(0)
  const [readId, setReadId] = useState(0)
  const [answered, setAnswered] = useState<{ readonly id: number; readonly read: Read } | null>(null)
  const [proposal, setProposal] = useState<NightGrantTerms | null>(null)
  const [busy, setBusy] = useState(false)
  const [said, setSaid] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)

  useLayoutEffect(() => {
    readCounter.current += 1
    setReadId(readCounter.current)
  }, [active, round, nonce])
  useEffect(() => {
    const id = readId
    if (!active || id !== readCounter.current) return undefined
    const controller = new AbortController()
    const settle = (next: Read): void => { if (!controller.signal.aborted && id === readCounter.current) setAnswered({ id, read: next }) }
    readNightGrant(controller.signal)
      .then((answer) => { settle(answer === null ? { kind: 'unknown' } : answer === 'none' ? { kind: 'none' } : { kind: 'grant', status: answer }) })
      .catch(() => { settle({ kind: 'unknown' }) })
    return () => { controller.abort() }
  }, [active, round, nonce, readId])
  const read: Read = answered !== null && answered.id === readId ? answered.read : { kind: 'reading' }

  const run = (work: (signal: AbortSignal) => Promise<string>) => {
    const controller = new AbortController()
    setBusy(true)
    work(controller.signal)
      .then((words) => { setSaid(words) })
      .catch((error: unknown) => { setSaid(`No clear answer (${error instanceof Error ? error.message : String(error)}); read again.`) })
      .finally(() => { setBusy(false); setNonce(value => value + 1) })
  }
  const review = () => {
    run(async (signal) => {
      const head = await readHead(signal)
      if (head === null) return 'HEAD did not say which head she is on, so no grant was proposed.'
      setProposal(nightGrantTerms({ origin: window.location.origin, head, now: Date.now(), grantId: newNightGrantId() }))
      return 'Read the terms below. Nothing is granted until you approve with Touch ID.'
    })
  }
  const approve = (terms: NightGrantTerms) => {
    // NO RELOAD OVER AN APPROVAL IN FLIGHT (build-notice.ts): held until this approval settles.
    const releaseReload = holdReload()
    run(async (signal) => {
      try {
        const outcome = await approveNightGrant(terms, window.location.origin, { signal })
        setProposal(null)
        return outcome.words
      } finally {
        releaseReload()
      }
    })
  }
  const revoke = (grantId: string) => {
    run(async signal => ((await revokeNightGrant(grantId, signal))
      ? `Revoked. ${WITHOUT_GRANT}`
      : 'NOT revoked: HEAD did not confirm it; read again.'))
  }

  const view = nightGrantSummary(read)
  const grant = read.kind === 'grant' ? read.status : null
  const canAsk = read.kind === 'none' || (grant !== null && grant.state !== 'active')
  return (
    <div data-sovereignty-night-grant-section="">
      <SectionLabel>Night grant</SectionLabel>
      <Lead><StatusPill tone={view.tone}>{view.badge}</StatusPill>{' '}<span data-sovereignty-night-grant-summary="">{view.summary}</span></Lead>
      {grant === null ? null : (
        <div data-sovereignty-night-grant={grant.state}>
          {grant.plainWords.map(line => <Lead key={line}>{line}</Lead>)}
          <FieldTable rows={[['uses left', `${String(grant.usesLeft)} of ${String(grant.terms.maxUses)}`], ['state', grant.state]]} />
          {grant.state === 'active'
            ? <button type="button" className="x5-field" data-sovereignty-night-grant-revoke="" disabled={busy} onClick={() => { revoke(grant.terms.grantId) }}>Revoke now</button>
            : null}
        </div>
      )}
      {!canAsk || proposal !== null ? null
        : <button type="button" className="x5-field" data-sovereignty-night-grant-review="" disabled={busy} onClick={review}>Review a night grant…</button>}
      {proposal === null ? null : (
        <div className="x5-wake-confirm" data-sovereignty-night-grant-proposal="">
          {nightGrantWords(proposal).map(line => <Lead key={line}>{line}</Lead>)}
          <button type="button" className="x5-field" data-sovereignty-night-grant-approve="" disabled={busy} onClick={() => { approve(proposal) }}>Approve with Touch ID</button>
          <button type="button" className="x5-field" disabled={busy} onClick={() => { setProposal(null) }}>Cancel</button>
        </div>
      )}
      {said === null ? null : <Lead><span role="status" data-sovereignty-night-grant-said="">{said}</span></Lead>}
    </div>
  )
}
