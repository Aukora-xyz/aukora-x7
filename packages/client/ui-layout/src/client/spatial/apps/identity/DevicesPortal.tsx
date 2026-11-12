// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The Aukora authors
/**
 * YOUR DEVICES, a portal on the Identity surface: the first passkey, each added device, and "Add another device".
 * Adding asks an enrolled passkey to approve the exact request, then shows the one-time code ONCE: as a link
 * (`https://<origin>/_auth/passkey/add#<code>`, the part after # is never sent to a server), as a QR of that link, and as text to
 * type on the other computer's sign-in page. The other computer's passkey only ASKS TO JOIN: this portal then shows "A new
 * device asks to join" with its six-digit phrase, and the owner's passkey confirms that exact key (or he declines it).
 * Removing a device is approved the same way. A lost answer is said as unknown and the list is read again. While a code
 * waits for its new device, the list is read again every few seconds, so "asks to join" appears without leaving the portal;
 * while a device asks to join, no new code is offered (the host refuses one too), so it is never turned away unseen.
 * A re-read that fails while a code waits keeps the last list and is tried again, a bounded number of times in a row;
 * then (and whenever the list cannot be read) the portal says so and offers a plain Retry.
 * ONE ACTION AT A TIME, NEVER STUCK: the running action is kept with its own abort controller and a deadline
 * (DEVICE_ACTION_DEADLINE_MS). Closing the portal (its own disclosure header too, job 11), leaving it, or the deadline
 * cancels it, lets go of its passkey-approval
 * hold and frees the buttons; its outcome is then said to be unknown and the list is read again (the node's list is the
 * truth). An answer that arrives after its action was let go changes nothing on the page.
 * `devices.ts` carries the calls.
 * @module apps/identity/DevicesPortal
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { PortalButton, PortalCell, RecordList, RecordRow, StatusPill } from '../../primitives/index.ts'
import css from '../../aumlok/AumlokFace.module.css'
import { beginApproval, endApproval } from '../../portal/touch-id-timing.ts'
import { qrSvgDataUrl } from './qr.ts'
import {
  DEVICES_ROUTE, DEVICES_WAIT_READ_MS, DEVICES_WAIT_RETRIES, DEVICE_LABEL_MAX, DEVICE_OUTCOME_UNKNOWN, confirmDevice, declineDevice,
  deviceLabelValid, makeDeviceCode, readDevices, removeDevice,
  type DeviceCodeMade, type DeviceJoining, type DeviceStep, type DevicesRead,
} from './devices.ts'

const READING: DevicesRead = { kind: 'reading' }
/** The longest one device action may run (the passkey prompt included) before it is let go and said to be unknown. */
export const DEVICE_ACTION_DEADLINE_MS = 180_000

/** The action running now: its identity, its controller, the approval hold it took (if any), and its deadline. */
interface DeviceAction {
  readonly controller: AbortController
  readonly hold: string | null
  timer: ReturnType<typeof setTimeout> | null
}
const day = (at: number): string => new Date(at).toISOString().slice(0, 10)
const clock = (at: number): string => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

/** The code, shown this once: link, QR of the link, and the text to type. */
function CodeMade({ made, onDone }: { readonly made: DeviceCodeMade; readonly onDone: () => void }) {
  const qr = useMemo(() => {
    try { return qrSvgDataUrl(made.link, 'Q') } catch { return null }
  }, [made.link])
  const [copied, setCopied] = useState<string | null>(null)
  const copy = (what: string, text: string): void => {
    navigator.clipboard.writeText(text).then(() => { setCopied(what) }, () => { setCopied(null) })
  }
  return (
    // THE CODE IS A SECRET FOR ONE OF THE OWNER'S OWN COMPUTERS: marked private, so the page's eyes never read it.
    <div data-identity-device-code="" data-private="">
      <p className="x6-identity__status" data-tone="mint">
        {`A code for “${made.label}” is ready until ${clock(made.expiresAt)}. It works once.`}
      </p>
      <p className="x6-identity__status">
        On the other computer, open this link (or scan it), or open this node, choose
        “Add this device with a one-time code” and type the code.
        It makes a passkey there with Touch ID, Face ID or the device lock, and shows six digits.
        Then press Done here: you confirm the new device only if it shows the same six digits.
      </p>
      {qr ? (
        <div className={css.identityQrHalo} data-ready="">
          <div className={css.identityQr} data-identity-device-qr="">
            <img src={qr} alt="QR code of the one-time link for adding a device" draggable={false} />
          </div>
        </div>
      ) : null}
      <code className="x6-identity__mono" data-identity-device-link="">{made.link}</code>
      <code className="x6-identity__mono" data-identity-device-code-value="">{made.code}</code>
      {made.sameUserHandle ? null : (
        <p className="x6-identity__status" data-identity-device-handle="">
          Your passkey did not name its account, so the new passkey is saved as its own entry.
        </p>
      )}
      <div className="x6-identity__actions">
        <button type="button" className="ak-action ak-tone-gold" data-identity-device-copy="link" onClick={() => { copy('link', made.link) }}>
          {copied === 'link' ? 'Link copied' : 'Copy link'}
        </button>
        <button type="button" className="ak-action ak-tone-gold" data-identity-device-copy="code" onClick={() => { copy('code', made.code) }}>
          {copied === 'code' ? 'Code copied' : 'Copy code'}
        </button>
        <button type="button" className="ak-action ak-tone-violet" data-identity-device-done="" onClick={onDone}>Done</button>
      </div>
    </div>
  )
}

/** A new device asks to join: its phrase, and confirm (one passkey approval of this exact key) or decline. */
function Joining({ joining, busy, onConfirm, onDecline }: {
  readonly joining: DeviceJoining
  readonly busy: string | null
  readonly onConfirm: () => void
  readonly onDecline: () => void
}) {
  return (
    <div data-identity-device-joining={joining.id}>
      <p className="x6-identity__status" data-tone="gold">{`A new device asks to join: “${joining.label}”, until ${clock(joining.expiresAt)}.`}</p>
      <code className="x6-identity__mono" data-identity-device-phrase="">{joining.phrase}</code>
      <p className="x6-identity__status">
        Confirm only if the new device shows these same six digits. If it does not, or you did not just add a device, decline.
      </p>
      <div className="x6-identity__actions">
        <button type="button" className="ak-action ak-tone-gold" data-identity-device-confirm="" disabled={busy !== null} onClick={onConfirm}>
          {busy === 'confirm' ? 'Waiting for passkey' : 'Confirm this device'}
        </button>
        <button type="button" className="ak-action ak-tone-red" data-identity-device-decline="" disabled={busy !== null} onClick={onDecline}>
          {busy === 'decline' ? 'Declining' : 'Decline'}
        </button>
      </div>
    </div>
  )
}

/** The devices portal. */
export function DevicesPortal({ active, actionDeadlineMs = DEVICE_ACTION_DEADLINE_MS }: {
  readonly active: boolean
  readonly actionDeadlineMs?: number
}) {
  const [read, setRead] = useState<DevicesRead>(READING)
  const [revision, setRevision] = useState(0)
  const [label, setLabel] = useState('Another computer')
  const [busy, setBusy] = useState<string | null>(null)
  const [made, setMade] = useState<DeviceCodeMade | null>(null)
  const [notice, setNotice] = useState<{ readonly tone: 'mint' | 'red'; readonly text: string } | null>(null)
  const labelId = useId()
  // Failed re-reads in a row while a code waits (the last list is kept meanwhile).
  const failedReads = useRef(0)
  useEffect(() => {
    if (!active) return
    const controller = new AbortController()
    const settle = (next: DevicesRead): void => {
      if (controller.signal.aborted) return
      if (next.kind === 'live') { failedReads.current = 0; setRead(next); return }
      failedReads.current += 1
      const failed = failedReads.current
      // While a known code waits, one failed read never stops the waiting: the last list stays and the next tick reads
      // again, up to DEVICES_WAIT_RETRIES in a row. Past that (or with no code waiting) the failure is shown, with Retry.
      setRead(current => current.kind === 'live' && current.pending !== null && current.joining === null && failed < DEVICES_WAIT_RETRIES ? current : next)
    }
    readDevices(controller.signal).then(settle).catch(() => { settle({ kind: 'unread', text: `${DEVICES_ROUTE} could not be read.` }) })
    return () => { controller.abort() }
  }, [active, revision])
  const reload = useCallback(() => { setRevision(value => value + 1) }, [])
  const retry = (): void => { failedReads.current = 0; setRead(READING); reload() }
  const live = read.kind === 'live' ? read : null
  const full = live !== null && live.devices.length >= live.limit
  // A code is waiting for its new device: read the list again on a short interval until the device asks to join, the
  // code ends (the host stops naming it), or the portal closes. Never during an action of its own.
  const waiting = active && busy === null && live !== null && live.pending !== null && live.joining === null
  useEffect(() => {
    if (!waiting) return
    const timer = setInterval(reload, DEVICES_WAIT_READ_MS)
    return () => { clearInterval(timer) }
  }, [waiting, reload])
  // The action running now (null when none). Its identity is the object itself: a late answer of an action that was let
  // go finds another (or none) here, and changes nothing.
  const action = useRef<DeviceAction | null>(null)
  /** Let go of `running` if it is still the current action: its deadline, its approval hold. True if it was current. */
  const release = useCallback((running: DeviceAction): boolean => {
    if (action.current !== running) return false
    action.current = null
    if (running.timer !== null) clearTimeout(running.timer)
    if (running.hold !== null) endApproval(running.hold)
    return true
  }, [])
  /** The action could not be followed to its end: cancel it, free the portal, say the outcome is unknown, read again. */
  const abandon = useCallback((running: DeviceAction, readAgain: boolean): void => {
    if (!release(running)) return
    running.controller.abort()
    setBusy(null)
    setNotice({ tone: 'red', text: DEVICE_OUTCOME_UNKNOWN })
    if (readAgain) reload()
  }, [release, reload])
  // Closing or leaving the portal (or the page) cancels the running action: nothing stays busy, no hold is kept. The
  // list is read again when the portal opens next (the read effect above).
  useEffect(() => {
    if (!active) return
    return () => { const running = action.current; if (running !== null) abandon(running, false) }
  }, [active, abandon])
  // Job 11 (review SHOULD 2): closing the portal's own disclosure (its header) cancels the running action exactly as
  // leaving does: the signal is aborted, the hold let go, the buttons freed, the outcome said to be unknown, the list read.
  const toggled = useCallback((open: boolean): void => {
    if (open) return
    const running = action.current
    if (running !== null) abandon(running, true)
  }, [abandon])
  /** Run one action: only when none runs, holding `hold` (a passkey approval key) while it runs, with its deadline. */
  const start = <T,>(kind: string, hold: string | null, step: (signal: AbortSignal) => Promise<DeviceStep<T>>,
    done: (result: DeviceStep<T>) => void): boolean => {
    if (live === null || busy !== null || action.current !== null) return false
    if (hold !== null && !beginApproval(hold)) return false
    const running: DeviceAction = { controller: new AbortController(), hold, timer: null }
    action.current = running
    running.timer = setTimeout(() => { abandon(running, true) }, actionDeadlineMs)
    setBusy(kind); setNotice(null)
    let pending: Promise<DeviceStep<T>>
    try { pending = step(running.controller.signal) }
    catch (error) { pending = Promise.reject(error instanceof Error ? error : new Error(String(error))) }
    pending.then((result) => {
      if (!release(running)) return
      done(result); setBusy(null); reload()
    }, () => {
      if (!release(running)) return
      setNotice({ tone: 'red', text: DEVICE_OUTCOME_UNKNOWN }); setBusy(null); reload()
    })
    return true
  }
  const add = (): void => {
    if (live === null) return
    const named = label.trim()
    const started = start('add', 'aumlok-device-code', signal => makeDeviceCode(live, named, { signal }), (step) => {
      if (step.ok) setMade(step.value)
      else setNotice({ tone: 'red', text: step.reason })
    })
    if (started) setMade(null)
  }
  const confirm = (joining: DeviceJoining): void => {
    if (live === null) return
    start('confirm', 'aumlok-device-confirm', signal => confirmDevice(live, joining, { signal }), (step) => {
      setNotice(step.ok ? { tone: 'mint', text: `“${joining.label}” is added. It can sign in with its own passkey now.` } : { tone: 'red', text: step.reason })
    })
  }
  const decline = (joining: DeviceJoining): void => {
    if (live === null) return
    start('decline', null, signal => declineDevice(live, joining, { signal }), (step) => {
      setNotice(step.ok ? { tone: 'mint', text: `“${joining.label}” was turned away. It was never added.` } : { tone: 'red', text: step.reason })
    })
  }
  const remove = (deviceId: string, name: string): void => {
    if (live === null) return
    start(deviceId, `aumlok-device-remove:${deviceId}`, signal => removeDevice(live, deviceId, { signal }), (step) => {
      setNotice(step.ok ? { tone: 'mint', text: `“${name}” is removed. It can no longer sign in, and its sign-ins have ended.` } : { tone: 'red', text: step.reason })
    })
  }
  const pill = read.kind === 'reading' ? <StatusPill tone="muted">READING</StatusPill>
    : live ? <StatusPill tone="mint">{`${String(live.devices.length + 1)} PASSKEY${live.devices.length === 0 ? '' : 'S'}`}</StatusPill>
      : <StatusPill tone="muted" title={read.kind === 'unread' ? read.text : DEVICES_ROUTE}>NOT CONNECTED YET</StatusPill>
  return (
    <PortalCell data-identity-portal="devices">
      <PortalButton tone={live ? 'gold' : 'muted'} icon="devices" iconTone="gold" title="Your devices"
        summary={`${DEVICES_ROUTE} · sign in from another computer`} badge={pill} onToggle={toggled}>
        {read.kind === 'unread' ? (
          <>
            <p className="x6-identity__status" data-identity-devices-unread="">{read.text}</p>
            <div className="x6-identity__actions">
              <button type="button" className="ak-action ak-tone-gold" data-identity-devices-retry="" onClick={retry}>Retry</button>
            </div>
          </>
        ) : null}
        {live ? (
          <>
            <RecordList>
              <RecordRow tone="gold" title="First passkey" summary={`bound ${day(live.primary.boundAt)} · last used ${day(live.primary.lastVerifiedAt)}`}
                status={<StatusPill tone="gold">PRIMARY</StatusPill>} />
              {live.devices.map(device => (
                <RecordRow key={device.id} tone="blue" title={device.label} summary={`added ${day(device.addedAt)} · last used ${day(device.lastVerifiedAt)}`}
                  end={(
                    <button type="button" className="ak-action ak-tone-red" data-identity-device-remove={device.id} disabled={busy !== null}
                      onClick={() => { remove(device.id, device.label) }}>
                      {busy === device.id ? 'Waiting for passkey' : 'Remove'}
                    </button>
                  )} />
              ))}
            </RecordList>
            {live.joining ? <Joining joining={live.joining} busy={busy} onConfirm={() => { if (live.joining) confirm(live.joining) }}
              onDecline={() => { if (live.joining) decline(live.joining) }} /> : null}
            {live.pending && made === null ? (
              <p className="x6-identity__status" data-identity-device-pending="">
                {`A code for “${live.pending.label}” is waiting until ${clock(live.pending.expiresAt)}. Making a new one replaces it.`}
              </p>
            ) : null}
            {made ? <CodeMade made={made} onDone={() => { setMade(null); reload() }} /> : full ? (
              <p className="x6-identity__status" data-identity-device-full="">
                {`This identity holds ${String(live.limit)} added devices, the most it can. Remove one to add another.`}
              </p>
            ) : live.joining ? (
              <p className="x6-identity__status" data-identity-device-join-first="">
                Confirm or decline the device asking to join before adding another.
              </p>
            ) : (
              <div className={css.handleField}>
                <label className={css.handleLabel} htmlFor={labelId}>Name the other device</label>
                <input id={labelId} className={css.handleInput} data-identity-device-label="" value={label} maxLength={DEVICE_LABEL_MAX}
                  autoComplete="off" spellCheck={false} onChange={(event) => { setLabel(event.target.value) }} />
                <div className="x6-identity__actions">
                  <button type="button" className="ak-action ak-tone-gold" data-identity-device-add="" disabled={busy !== null || !deviceLabelValid(label.trim())}
                    onClick={add}>
                    {busy === 'add' ? 'Waiting for passkey' : 'Add another device'}
                  </button>
                </div>
                <p className={css.handleHint}>
                  Your passkey approves the code, then the new device itself. The code works for ten minutes, on one device.
                </p>
              </div>
            )}
          </>
        ) : null}
        {notice ? <p className="x6-identity__status" role="status" data-tone={notice.tone} data-identity-device-notice="">{notice.text}</p> : null}
      </PortalButton>
    </PortalCell>
  )
}
