// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The Aukora authors
/**
 * THE OWNER MANDATE, INSIDE SOVEREIGNTY'S KEYS AND TRUST CARD, beside the night grant and in its visual language:
 * "Let Auma work while I am away", until a date he picks (1 day, 7 days by default, 30 days), with the day bounds in plain
 * words. One button asks Touch ID for exactly those bytes. While a mandate is active it shows its end date and today's
 * counts, and a Stop button that asks no passkey (stopping only removes authority). An unread mandate is shown as
 * unknown, never as "none" or fine. It is a section of an existing card, not a new card or screen.
 * Nothing consumes a mandate yet: the card says so.
 * @module portal/MandateCell
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { FieldTable, Lead, SectionLabel, StatusPill } from '../primitives/index.ts'
import { holdReload } from './build-notice.ts'
import {
  MANDATE_DEFAULT_DAYS, MANDATE_LENGTHS_DAYS, approveMandate, mandateTerms, mandateUntil, mandateWords, readMandate, stopMandate,
  type MandateLengthDays, type MandateStatus, type MandateTerms,
} from '../aumlok/mandate.ts'

type Read = { readonly kind: 'reading' } | { readonly kind: 'unknown' } | { readonly kind: 'none' } | { readonly kind: 'mandate'; readonly status: MandateStatus }

/** Said wherever the mandate is described: today nothing she does reads it. */
export const NOTHING_USES_IT_YET = 'Nothing she does uses it yet: with your tab open your session decides, as before.'

/** Words for one read; exported for the spec. */
export function mandateSummary(read: Read): { badge: string; tone: 'gold' | 'blue' | 'muted'; summary: string } {
  if (read.kind === 'reading') return { badge: 'READING', tone: 'muted', summary: 'Reading the mandate…' }
  if (read.kind === 'unknown') return { badge: 'UNKNOWN', tone: 'gold', summary: 'HEAD did not answer, so whether a mandate is active is unknown.' }
  if (read.kind === 'none') return { badge: 'NONE', tone: 'blue', summary: `No mandate. ${NOTHING_USES_IT_YET}` }
  const { status } = read
  if (status.state === 'active') return { badge: 'ACTIVE', tone: 'gold', summary: `Active until ${mandateUntil(status.terms.expiresAt)}. ${NOTHING_USES_IT_YET}` }
  return { badge: status.state.toUpperCase(), tone: 'blue', summary: `The last mandate is ${status.state === 'revoked' ? 'stopped' : status.state}. ${NOTHING_USES_IT_YET}` }
}

/** Today's counts against the day bounds, as rows. */
export function mandateTodayRows(status: MandateStatus): readonly (readonly [string, string])[] {
  const used = status.today
  const row = (label: string, kind: keyof MandateTerms['perDay']): readonly [string, string] =>
    [label, `${used === null ? '?' : String(used[kind])} of ${String(status.terms.perDay[kind])}`]
  return [row('commits today', 'commits'), row('new branches today', 'branchCreates'), row('runner jobs today', 'execRuns'),
    row('runner minutes today', 'execMinutes'), row('proposal cards today', 'proposalStages'), row('comments today', 'linearComments'),
    row('relay posts today', 'relayPosts')]
}

/** The section (inside the Keys and trust card). */
export function MandateCell({ active, round }: { readonly active: boolean; readonly round: number }) {
  // EVERY READ HAS ITS OWN IDENTITY (as the night grant section): only the current read's answer is shown.
  const readCounter = useRef(0)
  const [readId, setReadId] = useState(0)
  const [answered, setAnswered] = useState<{ readonly id: number; readonly read: Read } | null>(null)
  const [days, setDays] = useState<MandateLengthDays>(MANDATE_DEFAULT_DAYS)
  const [busy, setBusy] = useState(false)
  const [said, setSaid] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)
  // The terms are fixed when shown, so the bytes he approves are the bytes he read; a new length makes new terms.
  const [proposal, setProposal] = useState<MandateTerms>(() => mandateTerms({ now: Date.now(), days: MANDATE_DEFAULT_DAYS }))

  useLayoutEffect(() => {
    readCounter.current += 1
    setReadId(readCounter.current)
  }, [active, round, nonce])
  useEffect(() => {
    const id = readId
    if (!active || id !== readCounter.current) return undefined
    const controller = new AbortController()
    const settle = (next: Read): void => { if (!controller.signal.aborted && id === readCounter.current) setAnswered({ id, read: next }) }
    readMandate(controller.signal)
      .then((answer) => { settle(answer === null ? { kind: 'unknown' } : answer === 'none' ? { kind: 'none' } : { kind: 'mandate', status: answer }) })
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
  const choose = (next: MandateLengthDays) => {
    setDays(next)
    setProposal(mandateTerms({ now: Date.now(), days: next }))
  }
  const approve = () => {
    // THE TERMS ARE MADE AT THE TAP: issuedAt, expiresAt, the id and the nonce come from this moment, so HEAD's 10-minute
    // window (MANDATE_ISSUED_AT_REFUSED) counts from the tap, not from when the section opened. The same terms are shown
    // at once and the passkey binds exactly their bytes; a refusal for the clock is said in one plain line.
    // NO RELOAD OVER AN APPROVAL IN FLIGHT (build-notice.ts): held until this approval settles.
    const terms = mandateTerms({ now: Date.now(), days })
    setProposal(terms)
    const releaseReload = holdReload()
    run(async (signal) => {
      try {
        return (await approveMandate(terms, window.location.origin, { signal })).words
      } finally {
        releaseReload()
        setProposal(mandateTerms({ now: Date.now(), days }))
      }
    })
  }
  const stop = (id: string) => {
    run(async signal => ((await stopMandate(id, signal)) ? 'Stopped.' : 'NOT stopped: HEAD did not confirm it; read again.'))
  }

  const view = mandateSummary(read)
  const mandate = read.kind === 'mandate' ? read.status : null
  const canAsk = read.kind === 'none' || (mandate !== null && mandate.state !== 'active')
  return (
    <div data-sovereignty-mandate-section="">
      <SectionLabel>Away mandate</SectionLabel>
      <Lead><StatusPill tone={view.tone}>{view.badge}</StatusPill>{' '}<span data-sovereignty-mandate-summary="">{view.summary}</span></Lead>
      {mandate === null ? null : (
        <div data-sovereignty-mandate={mandate.state}>
          {mandate.plainWords.map(line => <Lead key={line}>{line}</Lead>)}
          <FieldTable rows={[['ends', mandateUntil(mandate.terms.expiresAt)], ['state', mandate.state === 'revoked' ? 'stopped' : mandate.state],
            ...(mandate.state === 'active' ? mandateTodayRows(mandate) : [])]} />
          {mandate.state === 'active'
            ? <button type="button" className="x5-field" data-sovereignty-mandate-stop="" disabled={busy} onClick={() => { stop(mandate.terms.id) }}>Stop now</button>
            : null}
        </div>
      )}
      {!canAsk ? null : (
        <div className="x5-wake-confirm" data-sovereignty-mandate-proposal="">
          {mandateWords(proposal).map(line => <Lead key={line}>{line}</Lead>)}
          <div data-sovereignty-mandate-length="">
            {MANDATE_LENGTHS_DAYS.map(length => (
              <button key={length} type="button" className="x5-field" aria-pressed={days === length} disabled={busy}
                onClick={() => { choose(length) }}>{length === 1 ? '1 day' : `${String(length)} days`}</button>
            ))}
          </div>
          <button type="button" className="x5-field" data-sovereignty-mandate-approve="" disabled={busy} onClick={() => { approve() }}>Approve with Touch ID</button>
        </div>
      )}
      {said === null ? null : <Lead><span role="status" data-sovereignty-mandate-said="">{said}</span></Lead>}
    </div>
  )
}
