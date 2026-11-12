// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The Aukora authors
/**
 * THE OUTWARD REQUEST CARD (Round 36): Auma's staged GitHub issue or comment, shown in Sovereignty with every
 * byte that leaves, approved with Touch ID and sent from this page (`aumlok/outward-class3.ts`). The card shows only while
 * something is staged, or with the outcome of the owner's approval.
 * @module portal/OutwardApprovalCell
 */
import { useEffect, useRef, useState } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  approveAndSendOutward, outwardWords, readStagedOutward, STAGED_OUTWARD_CHANGE, STAGED_OUTWARD_PATH, type StagedOutwardRead,
} from '../aumlok/outward-class3.ts'
// Requests this browser has sent, by canonical body, so a post that has gone out is not offered again, by this card or
// the chat card, while the browser's record holds (one record for the page, `aumlok/outward-sent.ts`).
import { markSent, onSentChange, SENT_KEY, wasSent } from '../aumlok/outward-sent.ts'
import type { Class3Dependencies } from '../aumlok/class3-approval.ts'
import { FieldTable, Lead, PortalButton, PortalCell, StatusPill } from '../primitives/index.ts'
import { useLiveEvents } from '../work/autonomy.ts'
import type { WorkReader } from '../work/WorkSurface.tsx'
import { beginApproval, endApproval, freshFor, outwardApprovalKey, TAP_AGAIN } from './touch-id-timing.ts'

type Read = StagedOutwardRead

/** What the rows of a request say, over them, in every card that offers it (this one and the chat's Fingerprint card). */
export const OUTWARD_APPROVES_EXACTLY = 'Touch ID approves exactly these bytes, once. The page then sends them, and the host checks they are '
  + 'the same.'

/** The outcome of a tap. `lock`: another card on this page held the approval, said until the card next reads. */
type Outcome = { readonly state: 'working' | 'sent' | 'refused' | 'unknown'; readonly text: string; readonly lock?: true }

export interface OutwardApprovalCellProps {
  readonly active: boolean
  readonly round: number
  readonly reader: WorkReader
  readonly sessionId: SessionId | undefined
  readonly ownerBound: boolean
  /** Tests pass their own passkey and host call; the page uses the browser's. */
  readonly ceremony?: Omit<Class3Dependencies, 'signal'>
  readonly fetchImpl?: typeof fetch
  /** Told whether the card shows, so the waiting section above it shows only when something does. */
  readonly onShown?: (shown: boolean) => void
}

export function OutwardApprovalCell(
  { active, round, reader, sessionId, ownerBound, ceremony, fetchImpl, onShown }: OutwardApprovalCellProps,
) {
  const [read, setRead] = useState<Read>({ kind: 'none' })
  const [tick, setTick] = useState(0)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const [outcome, setOutcome] = useState<Outcome | null>(null)
  /** When the card's read of her file began: a read this recent, with no change to the file since, is used as it is (Safari). */
  const [readAt, setReadAt] = useState(0)
  const changesSeen = useRef(0)
  const [changesChecked, setChangesChecked] = useState(0)
  const readFile = (signal: AbortSignal): Promise<Read> => readStagedOutward(reader, sessionId, signal)
  useEffect(() => {
    if (!active) return
    const controller = new AbortController()
    const startedAt = Date.now()
    const changesAtRead = changesSeen.current
    void readFile(controller.signal).then((next) => {
      // During an approval nothing replaces the card the owner is acting on.
      if (controller.signal.aborted || busyRef.current) return
      setRead(next)
      setReadAt(startedAt)
      setChangesChecked(changesAtRead)
      // A tap another card's approval refused is said only until this read: that approval may be over by now.
      setOutcome(prev => (prev?.lock === true ? null : prev))
    })
    return () => { controller.abort() }
  }, [active, round, tick, reader, sessionId])
  useEffect(() => { if (!active) setOutcome(null) }, [active])
  // Another tab that sends a request marks it sent: this card stops offering it too. So does another card on this page
  // (the chat card), which tells this one itself: a `storage` event never fires in the page that wrote it.
  useEffect(() => {
    if (!active) return
    const onStorage = (event: StorageEvent): void => { if (event.key === SENT_KEY) setTick(n => n + 1) }
    globalThis.addEventListener('storage', onStorage)
    // This card's own send reads again when it settles.
    const off = onSentChange(() => { if (!busyRef.current) setTick(n => n + 1) })
    return () => { globalThis.removeEventListener('storage', onStorage); off() }
  }, [active])
  useLiveEvents(active, (event) => {
    if (event.kind !== 'mirror-updated') return
    const paths = event.changedPaths
    if (paths === null || paths.length === 0 || paths.some(path => STAGED_OUTWARD_CHANGE.test(path))) {
      changesSeen.current += 1
      setTick(n => n + 1)
    }
  })

  const staged = read.kind === 'staged' && !wasSent(read.staged.canonical) ? read.staged : null
  const shows = !(staged === null && read.kind !== 'malformed' && outcome === null)
  useEffect(() => { onShown?.(shows) }, [shows, onShown])
  useEffect(() => () => { onShown?.(false) }, [onShown])
  if (!shows) return null
  const words = staged === null ? null : outwardWords(staged)
  const approve = async (): Promise<void> => {
    if (staged === null || busyRef.current) return
    // SAFARI: the passkey sheet opens only inside the tap. A card that read her file this recently, with no change to it
    // since, goes straight to the passkey challenge; the sent-here record is still checked first (it is local, no request).
    const approvalKey = outwardApprovalKey(staged.canonical)
    const fresh = freshFor(approvalKey, readAt) && changesChecked === changesSeen.current
    if (!beginApproval(approvalKey)) {
      setOutcome({ state: 'refused', lock: true, text: 'Another card on this page is approving this request right now; nothing more was asked.' })
      return
    }
    busyRef.current = true
    setBusy(true)
    setOutcome({ state: 'working', text: fresh ? 'Waiting for Touch ID…' : 'Reading her request again before asking for your passkey…' })
    const signal = new AbortController().signal
    try {
      // THE FILE, READ AGAIN AT THE CLICK (when the card's read is not fresh): the passkey is asked only for the request this
      // card shows.
      const recheckAt = Date.now()
      const now: Read = fresh ? { kind: 'staged', staged } : await readFile(signal)
      if (wasSent(staged.canonical)) {
        setOutcome({ state: 'refused', text: 'Not sent again: this exact request was already sent from this browser.' })
        return
      }
      if (now.kind !== 'staged' || now.staged.canonical !== staged.canonical || now.staged.pathname !== staged.pathname) {
        setOutcome({ state: 'refused', text: 'Not sent: her request changed since this card read it. The card shows the new one.' })
        setRead(now)
        return
      }
      if (!fresh) { setReadAt(recheckAt); setChangesChecked(changesSeen.current) }
      const result = await approveAndSendOutward(staged, globalThis.location.origin, { ...ceremony, signal }, fetchImpl)
      // Anything that may have gone out is not offered again by this browser while its record holds: a GitHub post has no
      // idempotency key.
      if (result.kind !== 'refused') markSent(staged.canonical)
      const tapAgain = !fresh && result.kind === 'refused' && result.sent === null && result.words.includes('(class3:passkey')
      setOutcome({ state: result.kind, text: tapAgain ? TAP_AGAIN : result.words })
    } catch (error) {
      // Whatever failed, the passkey may already have approved and the post may have gone out.
      markSent(staged.canonical)
      setOutcome({ state: 'unknown', text: `No clear answer (${error instanceof Error ? error.message : String(error)}). `
        + 'It may have gone out: check GitHub before approving it again.' })
    } finally {
      endApproval(approvalKey)
      busyRef.current = false
      setBusy(false)
      setTick(n => n + 1)
    }
  }
  return (
    <PortalCell data-sovereignty-portal="outward">
      <PortalButton
        defaultExpanded
        tone="gold"
        icon="approvals"
        title="Auma asks to send"
        summary={words?.summary ?? (read.kind === 'malformed' ? 'a staged request this page cannot read' : 'nothing waiting')}
        badge={<StatusPill tone={staged === null ? 'muted' : 'gold'}>{staged === null ? 'NOTHING TO APPROVE' : 'CLASS 3'}</StatusPill>}
      >
        {words === null ? null : (
          <>
            <button type="button" className="x5-field" data-outward-approve="" disabled={busy || !ownerBound}
              onClick={() => { void approve() }}>
              Approve with Touch ID and Send
            </button>
            <Lead>
              {ownerBound ? OUTWARD_APPROVES_EXACTLY : 'No usable passkey is bound on this host, so nothing can approve it here.'}
            </Lead>
            <FieldTable
              rows={words.rows.map(([name, value]) => [name,
                <span key={name} data-outward-field={name} style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{value}</span>] as const)}
            />
          </>
        )}
        {read.kind === 'malformed' && staged === null
          ? <Lead>{`There is a file at ${STAGED_OUTWARD_PATH}, but it is not a request this page can read, so nothing is offered.`}</Lead>
          : null}
        {outcome === null ? null : <Lead><span role="status" data-outward-outcome={outcome.state}>{outcome.text}</span></Lead>}
      </PortalButton>
    </PortalCell>
  )
}
