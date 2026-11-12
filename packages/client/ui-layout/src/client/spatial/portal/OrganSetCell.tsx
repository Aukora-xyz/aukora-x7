// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The Aukora authors
/**
 * THE "ADD ORGANS" CARD IN SOVEREIGNTY'S WAITING SECTION: a Pearl that only adds ordinary organs, every organ listed by id,
 * module sha and size, approved with ONE Touch ID bound to exactly that list (aumlok/organ-set.ts). Shown only while HEAD
 * holds such a Pearl; a list this page cannot confirm is shown with the reason and never offered.
 * @module portal/OrganSetCell
 */
import { useEffect, useRef, useState } from 'react'
import { FieldTable, Lead, PortalButton, PortalCell, StatusPill } from '../primitives/index.ts'
import { approveOrganSet, organWords, readOrganSet, sameOrganSet, type OrganSetBody, type OrganSetRead } from '../aumlok/organ-set.ts'
import { holdReload } from './build-notice.ts'

/** Words for what happened after the click; exported for the spec. */
export function organSetOutcomeWords(outcome: Awaited<ReturnType<typeof approveOrganSet>>, epoch: number): string {
  switch (outcome.kind) {
    case 'landed': return `HEAD took it: epoch ${String(epoch)}. The organs are mounted as ordinary organs.`
    case 'not-approved': return `Not approved: ${outcome.reason}`
    case 'refused': return `HEAD refused it (${outcome.code}) without using the approval.`
    case 'unclear': return `No clear answer (${outcome.detail}); Refresh reads HEAD again before anything is asked twice.`
    default: return 'Nothing was sent; the approval was not used.'
  }
}

export function OrganSetCell({ active, round, ownerBound, onShown }: {
  readonly active: boolean
  readonly round: number
  readonly ownerBound: boolean
  readonly onShown?: (shown: boolean) => void
}) {
  const [read, setRead] = useState<OrganSetRead>({ kind: 'none' })
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const [said, setSaid] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (!active) return undefined
    const controller = new AbortController()
    void readOrganSet(controller.signal).then((next) => { if (!controller.signal.aborted && !busyRef.current) setRead(next) })
    return () => { controller.abort() }
  }, [active, round, tick])
  const shown = read.kind === 'offer' || read.kind === 'blocked' || said !== null
  useEffect(() => { onShown?.(shown) }, [shown, onShown])
  if (!shown) return null
  const approve = async (shownBody: OrganSetBody): Promise<void> => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    // NO RELOAD OVER AN APPROVAL IN FLIGHT (build-notice.ts): held until this approval settles.
    const releaseReload = holdReload()
    const controller = new AbortController()
    try {
      // Read again at the click: Touch ID is asked only for the list HEAD holds now.
      const fresh = await readOrganSet(controller.signal)
      setRead(fresh)
      if (fresh.kind !== 'offer') { setSaid('Checked again just now: there is no list to approve, so no passkey was asked for.'); return }
      // THE LIST THE OWNER CLICKED, AND ONLY IT: any difference shows the new list and needs another click; no passkey is asked.
      if (!sameOrganSet(fresh.body, shownBody)) {
        setSaid('The list changed since this card showed it. Read the new list above; nothing was approved, and no passkey was asked for.')
        return
      }
      const outcome = await approveOrganSet(fresh.body, globalThis.location.origin, { signal: controller.signal })
      setSaid(organSetOutcomeWords(outcome, fresh.body.epoch))
    } finally {
      releaseReload()
      busyRef.current = false
      setBusy(false)
      setTick(value => value + 1)
    }
  }
  const body = read.kind === 'offer' ? read.body : null
  return (
    <PortalCell data-sovereignty-portal="organ-set">
      <PortalButton defaultExpanded tone="gold" icon="approvals" title="Add organs"
        summary={body === null ? (read.kind === 'blocked' ? 'HEAD holds organs to add that this page cannot confirm' : 'Refresh reads HEAD again')
          : `epoch ${String(body.epoch)} · adds ${String(body.organs.length)} ordinary organ${body.organs.length === 1 ? '' : 's'}`}
        badge={<StatusPill tone={body === null ? 'muted' : 'gold'}>{body === null ? 'CANNOT LAND' : 'ONE TOUCH ID'}</StatusPill>}>
        {body === null ? null : (
          <div data-sovereignty-organ-set={body.ballId}>
            <Lead>One Touch ID adds exactly these organs, as ordinary organs (none becomes governance), and nothing else:</Lead>
            <FieldTable rows={body.organs.map((organ, index): [string, string] => [`organ ${String(index + 1)}`, organWords(organ)])} />
            <FieldTable rows={[['Pearl', `${body.ballId} (epoch ${String(body.epoch)})`], ['builds on', body.parentBallId ?? 'nothing']]} />
            <button type="button" className="x5-field" data-sovereignty-organ-set-approve="" disabled={busy || !ownerBound}
              onClick={() => { void approve(body) }}>
              {ownerBound ? 'Approve with Touch ID' : 'No usable passkey on this host'}
            </button>
          </div>
        )}
        {read.kind === 'blocked' ? <Lead><span data-sovereignty-organ-set-blocked="">Not offered: {read.why}.</span></Lead> : null}
        {said === null ? null : <Lead><span role="status" data-sovereignty-organ-set-said="">{said}</span></Lead>}
      </PortalButton>
    </PortalCell>
  )
}
