// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The Aukora authors
/**
 * THE "ADD ORGANS" CARD IN SOVEREIGNTY'S WAITING SECTION: a Pearl that only adds ordinary organs, every organ listed by id,
 * module sha and size, approved with ONE Touch ID bound to exactly that list (aumlok/organ-set.ts). Shown only while HEAD
 * holds such a Pearl; a list this page cannot confirm is shown with the reason and never offered.
 * The same card, with removal words, when HEAD holds a Pearl that only REMOVES one ordinary organ: one Touch ID
 * bound to exactly that removal (ORGAN_REMOVE_PATH), offered only when this page re-derives HEAD's body byte for byte.
 * @module portal/OrganSetCell
 */
import { useEffect, useRef, useState } from 'react'
import { FieldTable, Lead, PortalButton, PortalCell, StatusPill } from '../primitives/index.ts'
import {
  approveOrganRemove, approveOrganSet, organWords, readOrganChange, readOrganSet, sameOrganRemove, sameOrganSet,
  type OrganRemoveBody, type OrganRemoveRead, type OrganSetBody, type OrganSetRead,
} from '../aumlok/organ-set.ts'
import { declinedButPublishedWords, declineStagedHead } from '../aumlok/head-promotion.ts'
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

/** Words for what happened after a removal click; exported for the spec. */
export function organRemoveOutcomeWords(outcome: Awaited<ReturnType<typeof approveOrganRemove>>, body: OrganRemoveBody): string {
  switch (outcome.kind) {
    case 'landed': return `HEAD took it: epoch ${String(body.epoch)}. ${body.organ.organId} is removed; one reload of Auma's tab runs her without it.`
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
  const [removal, setRemoval] = useState<OrganRemoveRead>({ kind: 'none' })
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const [said, setSaid] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (!active) return undefined
    const controller = new AbortController()
    void readOrganChange(controller.signal).then((next) => {
      if (controller.signal.aborted || busyRef.current) return
      setRead(next.set)
      setRemoval(next.remove)
    })
    return () => { controller.abort() }
  }, [active, round, tick])
  const addShown = read.kind === 'offer' || read.kind === 'blocked'
  const removalShown = !addShown && (removal.kind === 'offer' || removal.kind === 'blocked')
  const shown = addShown || removalShown || said !== null
  // Which card the last words belong to: an outcome line stays on the card it is about after HEAD's record goes.
  const [mode, setMode] = useState<'add' | 'remove'>('add')
  useEffect(() => { if (removalShown) setMode('remove'); else if (addShown) setMode('add') }, [removalShown, addShown])
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
  const approveRemoval = async (shownBody: OrganRemoveBody): Promise<void> => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    // NO RELOAD OVER AN APPROVAL IN FLIGHT (build-notice.ts): held until this approval settles.
    const releaseReload = holdReload()
    const controller = new AbortController()
    try {
      // Read again at the click: Touch ID is asked only for the removal HEAD holds now.
      const fresh = (await readOrganChange(controller.signal)).remove
      setRemoval(fresh)
      if (fresh.kind !== 'offer') { setSaid('Checked again just now: there is no removal to approve, so no passkey was asked for.'); return }
      if (!sameOrganRemove(fresh.body, shownBody)) {
        setSaid('The removal changed since this card showed it. Read it again above; nothing was approved, and no passkey was asked for.')
        return
      }
      const outcome = await approveOrganRemove(fresh.body, globalThis.location.origin, { signal: controller.signal })
      setSaid(organRemoveOutcomeWords(outcome, fresh.body))
    } finally {
      releaseReload()
      busyRef.current = false
      setBusy(false)
      setTick(value => value + 1)
    }
  }
  // DECLINE: take back the Pearl HEAD holds for this card by its exact ballId; no passkey (it only removes the
  // request). Taken back, the card reads again and goes; refused, HEAD's code shows in the card's own line.
  const decline = async (ballId: string): Promise<void> => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    try {
      const outcome = await declineStagedHead(ballId)
      const words = outcome.kind === 'declined' ? null
        : outcome.kind === 'published' ? declinedButPublishedWords(ballId)
          : outcome.kind === 'refused' ? `HEAD did not take it back (${outcome.code}); nothing changed.`
            : `${outcome.detail}: whether HEAD still holds it is unclear. Refresh reads HEAD again.`
      setSaid(words)
    } finally {
      busyRef.current = false
      setBusy(false)
      setTick(value => value + 1)
    }
  }
  const body = read.kind === 'offer' ? read.body : null
  const claimedId = read.kind === 'blocked' && read.claimed !== null ? read.claimed.ballId : null
  const declineBallId = body !== null ? body.ballId : typeof claimedId === 'string' && /^[0-9a-f]{64}$/u.test(claimedId) ? claimedId : null
  if (removalShown || (!addShown && said !== null && mode === 'remove')) {
    const gone = removal.kind === 'offer' ? removal.body : null
    const claimedGone = removal.kind === 'blocked' && removal.claimed !== null ? removal.claimed.ballId : null
    const declineGone = gone !== null ? gone.ballId : typeof claimedGone === 'string' && /^[0-9a-f]{64}$/u.test(claimedGone) ? claimedGone : null
    return (
      <PortalCell data-sovereignty-portal="organ-set">
        <PortalButton defaultExpanded tone="gold" icon="approvals" title="Remove an organ"
          summary={gone === null ? (removal.kind === 'blocked' ? 'HEAD holds an organ removal that this page cannot confirm' : 'Refresh reads HEAD again')
            : `epoch ${String(gone.epoch)} · removes the ordinary organ ${gone.organ.organId}`}
          badge={<StatusPill tone={gone === null ? 'muted' : 'gold'}>{gone === null ? 'CANNOT LAND' : 'ONE TOUCH ID'}</StatusPill>}>
          {gone === null ? null : (
            <div data-sovereignty-organ-remove={gone.ballId}>
              <Lead>
                One Touch ID removes exactly this ordinary organ, and nothing else. Its module stays in the Pearl, so it can be added back:
              </Lead>
              <FieldTable rows={[['organ', gone.organ.organId], ['module', `${gone.organ.sha256.slice(0, 12)}…`]]} />
              <FieldTable rows={[['Pearl', `${gone.ballId} (epoch ${String(gone.epoch)})`], ['builds on', gone.parentBallId ?? 'nothing']]} />
              <button type="button" className="x5-field" data-sovereignty-organ-remove-approve="" disabled={busy || !ownerBound}
                onClick={() => { void approveRemoval(gone) }}>
                {ownerBound ? 'Approve with Touch ID' : 'No usable passkey on this host'}
              </button>
            </div>
          )}
          {removal.kind === 'blocked' ? <Lead><span data-sovereignty-organ-remove-blocked="">Not offered: {removal.why}.</span></Lead> : null}
          {declineGone === null ? null : (
            <>
              <button type="button" className="x5-field" data-sovereignty-decline={declineGone} disabled={busy}
                onClick={() => { void decline(declineGone) }}>
                Decline
              </button>
              <Lead>Decline takes this Pearl back from HEAD. It asks for no passkey and publishes nothing; Auma can stage again.</Lead>
            </>
          )}
          {said === null ? null : <Lead><span role="status" data-sovereignty-organ-set-said="">{said}</span></Lead>}
        </PortalButton>
      </PortalCell>
    )
  }
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
        {declineBallId === null ? null : (
          <>
            <button type="button" className="x5-field" data-sovereignty-decline={declineBallId} disabled={busy}
              onClick={() => { void decline(declineBallId) }}>
              Decline
            </button>
            <Lead>Decline takes this Pearl back from HEAD. It asks for no passkey and publishes nothing; Auma can stage again.</Lead>
          </>
        )}
        {said === null ? null : <Lead><span role="status" data-sovereignty-organ-set-said="">{said}</span></Lead>}
      </PortalButton>
    </PortalCell>
  )
}
