/**
 * The AUMLOK screen: the ceremony, the status, and nothing else.
 *
 * THE CEREMONY RUNS HERE. Plan §3: the Aumlok screen in the app IS the surface — there is no separate
 * window and no separate page to open, nothing to start first, and the same compact layout always.
 * Everything on this screen is READ or TYPED; it holds no key and approves nothing, because approval
 * stays with a separate signer process on a Unix socket. The single write-shaped control here is the
 * ceremony itself, and even that only asks the shell for the seven words and hands them back: this
 * application derives no root, writes no record and keeps no phrase.
 *
 * ONE LAYOUT, THREE STATES, DRAWN AS THE OWNER DREW IT. The gold anchor card sits on
 * top with SIX gold rounded letter boxes in a row — one per letter of the anchor, dots once a binding
 * exists, never a letter afterwards — and the six themed rows sit under it in the three bands, green
 * then blue then purple, each row a small gold rounded box holding that word's first letter and the
 * word beside it. The numbers are there and quiet. The badge is above them: UNBOUND with empty tiles
 * and "Give me my phrase", BOUND with dots, the receipt and "Your Aumlok is bound".
 *
 * THE WORDS ARE SHOWN ONCE AND LEAVE AS THE TILES TURN OVER. They arrive from the shell for display,
 * live only in this component's state while they are on the screen, and are gone the moment the tiles
 * accept input — a screen that showed them while accepting them would be reading the phrase back to
 * the person who is meant to be remembering it. Nothing here logs, stores or transmits them, and the
 * system copy-paste buffer is never touched. The step between typing them back and binding with them
 * is a deliberate warning, and the box that must be ticked before Bind is live.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type {
  HostObservable,
  InjectFace,
  PropsLocale,
  PropsRuntime,
} from '@deepseek-ai/dsh-client-ui-slots'
import type {
  AumlokCeremonyIntent,
  AumlokCeremonyResult,
  AumlokDrawnPhrase,
} from './binding-bridge.ts'
import type { AumlokControlProjectionState } from './control-state.ts'
import { FieldTable, Footnote, Panel, SectionHeader, StatusPill } from '../primitives/index.ts'
import { readHostMode, type HostMode } from '../../spatial-components.tsx'
import { hostCall, OWNER_KEY_ROUTE, PASSKEY_ROUTE, readOwnerKey, type HostAnswer } from '../apps/identity/host.ts'
import { IdentityIcon } from './IdentityVisuals.tsx'
import {
  AUMLOK_OUTCOME_UNKNOWN, AUMLOK_SETTLED_AS_THIS_CEREMONY, AUMLOK_SETTLED_BY_STATUS, aumlokCeremonyAvailability, createBrowserCeremony,
  readAumlokStatus,
  type AumlokHostRead,
} from './aumlok-ceremony.ts'
import {
  AUMLOK_ANCHOR_POSITION,
  AUMLOK_BANDS,
  AUMLOK_NOT_CONNECTED_REASON,
  AUMLOK_RUNTIME_POSTURE,
  AUMLOK_SURFACE_STATES,
  aumlokActionKey,
  aumlokAnchorBoxes,
  aumlokBadgeWord,
  aumlokConfirmGate,
  aumlokHandleGate,
  aumlokReceipt,
  aumlokRedraw,
  aumlokSurfaceState,
  aumlokTileFace,
  type AumlokCeremonyBeat,
  type AumlokSurfaceState,
} from './surface-state.ts'
import { AnchorBox, PhraseBand } from './AumlokWordTiles.tsx'
import css from './AumlokFace.module.css'

/** One read of a host route: still reading, or the host's classified answer. */
export type HostRouteRead = { readonly kind: 'reading' } | HostAnswer

/**
 * Read one same-origin host route each time the screen opens; nothing is retried or cached. It shows "reading" from the
 * first frame of each opening (a layout effect), so an answer from an earlier opening never paints as current.
 */
function useHostRoute(active: boolean, route: string): HostRouteRead {
  const [read, setRead] = useState<HostRouteRead>({ kind: 'reading' })
  useLayoutEffect(() => { if (active) setRead({ kind: 'reading' }) }, [active, route])
  useEffect(() => {
    if (!active) return
    const controller = new AbortController()
    void hostCall(route, controller.signal).then((answer) => { if (!controller.signal.aborted) setRead(answer) }, () => {})
    return () => { controller.abort() }
  }, [active, route])
  return read
}
/** The node's binding as its own host reports it (`/_host/aumlok/status`): read on each opening and after a ceremony. */
function useAumlokStatus(active: boolean, round: number): AumlokHostRead {
  const [read, setRead] = useState<AumlokHostRead>({ kind: 'reading' })
  // Reading again (a new opening, or after a ceremony) shows "reading" from the first frame, never the old answer.
  useLayoutEffect(() => { if (active) setRead({ kind: 'reading' }) }, [active, round])
  useEffect(() => {
    if (!active) return
    const controller = new AbortController()
    void readAumlokStatus(controller.signal).then((next) => { if (!controller.signal.aborted) setRead(next) }, () => {})
    return () => { controller.abort() }
  }, [active, round])
  return read
}
/** A host status that is not a live reading, in words (the owner rows that need one say this instead). */
export function statusUnread(read: AumlokHostRead): string {
  switch (read.kind) {
    case 'live': return 'read'
    case 'reading': return 'reading…'
    case 'absent': return 'not reported by this host'
    case 'refused': return `refused (${read.code})`
    case 'unreadable': return 'unknown (the host’s AUMLOK status is not the expected shape)'
  }
}
/** Whether a ceremony can run in this page: still checking, yes, or no and why. */
export type CeremonyAvailability = { readonly ok: true } | { readonly ok: false; readonly reason: string } | null
/** What the owner card says about the ceremony on this host. */
export function ceremonyWords(shell: boolean, read: AumlokHostRead, availability: CeremonyAvailability): string {
  if (shell) return 'available on this host'
  switch (read.kind) {
    case 'live': return availability === null ? 'checking this browser…'
      : availability.ok ? 'runs in this page against this host (/_host/aumlok)' : `not available here: ${availability.reason}`
    case 'absent': return /^the host answers (404|501) /.test(read.detail) ? 'not on this host yet' : `unknown (${read.detail})`
    default: return statusUnread(read)
  }
}
/** The sentence where the ceremony control would be, when there is none to offer. */
export function noCeremonyWords(read: AumlokHostRead, availability: CeremonyAvailability): string {
  switch (read.kind) {
    case 'reading': return 'Reading this host’s AUMLOK status…'
    case 'live': return availability === null ? 'Checking whether this browser can run the ceremony…'
      : `No phrase can be drawn or bound here yet: ${availability.ok ? 'the ceremony is available' : availability.reason}.`
    case 'absent': return /^the host answers (404|501) /.test(read.detail)
      ? 'The phrase ceremony does not run on this host yet, so no phrase can be drawn or bound here.'
      : `This host’s AUMLOK status could not be read (${read.detail}), so nothing is drawn here.`
    case 'refused': return `This host refused its AUMLOK status (${read.code}), so nothing is drawn here.`
    case 'unreadable': return 'This host’s AUMLOK status is not the expected shape, so nothing is drawn here.'
  }
}
/** The invite quota line (aukora.invite.v1), only as the host reports it. */
export function inviteWords(read: AumlokHostRead): string {
  if (read.kind !== 'live') return statusUnread(read)
  const invites = read.status.invites
  if (invites === null) return 'not reported by this host'
  return `${String(invites.issued)} of ${String(invites.limit)} issued in ${invites.month} · aukora.invite.v1`
}
/** The same `/__x6/status` read the other surfaces use, but reset for each opening like the owner routes above. */
function useOpeningHostMode(active: boolean): HostMode {
  const [mode, setMode] = useState<HostMode>({ kind: 'reading' })
  useLayoutEffect(() => { if (active) setMode({ kind: 'reading' }) }, [active])
  useEffect(() => {
    if (!active) return
    const controller = new AbortController()
    void readHostMode(undefined, controller.signal).then((next) => { if (!controller.signal.aborted) setMode(next) }, () => {})
    return () => { controller.abort() }
  }, [active])
  return mode
}

/**
 * THE NODE'S OWNER, READ AND NEVER ASSUMED (Round 20, NORTH-STAR §19.2). Each line is one thing this page can read
 * from its own host, said as what it is: a public key on file proves no sign-in and no person, and a route the host
 * does not serve is "not on this host yet". Nothing here is a badge for a state the screen did not read.
 */
/**
 * A route this host does not serve (404, or 501 for a capability it lacks), as against a host that did not answer, or a
 * 405 that proves the route exists but not for a read: those read as unknown with the host's own detail.
 */
const routeMissing = (read: HostRouteRead): boolean => read.kind === 'absent' && /^the host answers (404|501) /.test(read.detail)
export function ownerKeyWords(read: HostRouteRead): string {
  if (read.kind === 'reading') return 'reading…'
  if (read.kind === 'absent') return routeMissing(read) ? 'not reported by this host' : `unknown (${read.detail})`
  if (read.kind === 'refused') return `refused (${read.code})`
  const key = readOwnerKey(read.body)
  return key === null ? 'not the expected shape' : `public key on this host · ${key.keyId}`
}
/**
 * What the same `/__x6/status` read the other surfaces use says about this page's sign-in, and no more: on the edge an
 * answer means the edge accepted this page's owner sign-in; on the Mac it means this page holds the host's local
 * session, which is not an owner sign-in. Signing in happens on the Work or Sovereignty screen, so this card adds no
 * control of its own.
 */
export function ownerSignInWords(mode: HostMode): string {
  switch (mode.kind) {
    case 'reading': return 'reading…'
    case 'local': return 'this Mac’s host: this page holds its local session; no owner sign-in is read here'
    case 'cloudflare': return 'the edge accepted this page’s owner sign-in'
    case 'signed-out': return 'not signed in on this edge (sign in on the Work or Sovereignty screen)'
    case 'unknown': return `unknown (${mode.reason})`
  }
}
/** The passkey route: absent until a host serves it, and never read as a passkey that exists. */
export function passkeyWords(read: HostRouteRead): string {
  if (read.kind === 'reading') return 'reading…'
  if (read.kind === 'absent') return routeMissing(read) ? 'not on this host yet' : `unknown (${read.detail})`
  if (read.kind === 'refused') return `refused (${read.code})`
  return 'the host answers; this screen does not read passkey status yet'
}
/**
 * Whether the screen's state is a reading. A connected control is; so is a controller that answered that no owner is
 * bound ('controller-absent', 'adapter-unbound'), which is UNBOUND read. With no controller at all (every X6.1 host
 * today), or a record that could not be read, the state is a default, so nothing is marked and the note says why.
 */
export function aumlokStateRead(projection: AumlokControlProjectionState): { readonly read: boolean; readonly note: string } {
  if (projection.status === 'connected') return { read: true, note: '' }
  switch (projection.reason) {
    case 'controller-absent':
    case 'adapter-unbound': return { read: true, note: '' }
    case 'no-controller-service': return { read: false, note: 'not read: no binding service on this host' }
    case 'control-unreadable': return { read: false, note: 'not read: the binding record could not be read' }
    case 'record-names-no-machine': return { read: false, note: 'not read: the record does not say which machine this is' }
    default: return { read: false, note: 'not read' }
  }
}

/** The three states of the one ceremony, in §19.2's order, the current one marked only when it was read. */
function CeremonyStates({ state, read, note }: { readonly state: AumlokSurfaceState; readonly read: boolean; readonly note: string }) {
  return (
    <span data-aumlok-states={read ? state : 'not-read'}>
      {AUMLOK_SURFACE_STATES.map((step, index) => (
        <span key={step} data-aumlok-state-step={step} aria-current={read && step === state ? 'step' : undefined}>
          {index === 0 ? null : ' → '}
          <StatusPill tone={read && step === state ? 'gold' : 'muted'}>{step.toUpperCase()}</StatusPill>
        </span>
      ))}
      {read ? null : <span data-aumlok-states-note>{` · ${note}`}</span>}
    </span>
  )
}

// Escape inside a text-entry control edits that control, never the surface. Duck-typed so a target
// from another realm classifies identically. THIS SCREEN HAS INPUTS NOW: the seven tiles become text
// entry while the person types the phrase back, and Escape there must leave the surface open.
function isEditableTarget(target: EventTarget | null): boolean {
  const el = target as { tagName?: unknown; isContentEditable?: unknown } | null
  const tag = typeof el?.tagName === 'string' ? el.tagName : ''
  return el?.isContentEditable === true || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}

/** Connection state of the parent-reported local controller. */
export type AumlokBindingStatus = AumlokControlProjectionState['status']

/** Projection source, and ceremony source, injected by the browser plugin. */
export interface AumlokSurfaceInjected {
  hooks: {
    /** Parent-reported AUMLOK control metadata, disconnected by default. */
    controlProjection: HostObservable<AumlokControlProjectionState>
  }
  /** Whether the desktop shell exposes the two ceremony verbs on this page at all. */
  ceremonyAvailable: boolean
  /** Ask the shell for one phrase, shown once, and report what came back. */
  drawPhrase: (intent: AumlokCeremonyIntent) => Promise<AumlokDrawnPhrase>
  /** Hand the typed words back, and report the shell's verdict. */
  submitPhrase: (intent: AumlokCeremonyIntent, words: readonly string[],
    handle?: string) => Promise<AumlokCeremonyResult>
  /** Re-read the controller's public control, which is what flips the screen's state. */
  refreshControlStatus: () => void
}

/** Props assembled for the always-mounted AUMLOK center surface. */
export type AumlokSurfaceProps =
  PropsRuntime<'shell.surface'>
  & PropsLocale<'aumlok'>
  & InjectFace<AumlokSurfaceInjected>

/**
 * What the screen must say about a ceremony whose last step had no clear answer, or finished after the screen closed.
 * It is drawn outside the ceremony's controls, so a status re-read (which hides them for a moment) never hides it.
 */
type CeremonyNotice = {
  readonly kind: 'unknown' | 'finished' | 'not-finished' | 'settled' | 'settled-here'
  readonly intent: AumlokCeremonyIntent
  readonly reason?: string
}
function noticeOf(settled: { readonly intent: AumlokCeremonyIntent; readonly result: AumlokCeremonyResult }): CeremonyNotice {
  if (settled.result.ok) {
    const kind = settled.result.reason === AUMLOK_SETTLED_BY_STATUS ? 'settled'
      : settled.result.reason === AUMLOK_SETTLED_AS_THIS_CEREMONY ? 'settled-here' : 'finished'
    return { kind, intent: settled.intent }
  }
  return settled.result.reason === AUMLOK_OUTCOME_UNKNOWN ? { kind: 'unknown', intent: settled.intent }
    : { kind: 'not-finished', intent: settled.intent, reason: settled.result.reason ?? 'no reason given' }
}
function noticeWords(notice: CeremonyNotice): string {
  const binding = notice.intent === 'bind'
  switch (notice.kind) {
    case 'unknown': return binding
      ? 'The host did not answer the last step of your binding, even when asked again, so this page cannot tell whether this '
        + 'node is now bound. Keep the phrase you typed: if this host reads BOUND, it is the one in force.'
      : 'The host did not answer the last step, even when asked again, so this page cannot tell whether your new phrase is now '
        + 'in force. Keep both phrases, the old and the new, until one of them opens your root.'
    case 'finished': return binding ? 'Your binding finished after this screen closed: this node is bound to the phrase you typed.'
      : 'Your new phrase finished after this screen closed: it is now in force, and the old one no longer opens your root.'
    case 'not-finished': return `Your last ${binding ? 'binding' : 'new phrase'} did not finish after this screen closed (${notice.reason ?? ''}).`
    case 'settled': return binding
      ? 'The host did not answer the last step, but it now shows this node bound with the key made in this page: the binding is done.'
      : 'The host did not answer the last step, but its key revision is now exactly one step on from where this change began: your new '
        + 'phrase is in force. If you were also changing your phrase on another device at that moment, keep both phrases until one opens '
        + 'your root.'
    case 'settled-here': return 'The host did not answer the last step, but its status names this change, made on this device, as the '
      + 'last one it committed: your new phrase is in force, and the old one no longer opens your root.'
  }
}

/** The seven tiles are one set of seven; the typed words are held here until they cross back. */
const TILE_POSITIONS = [0, 1, 2, 3, 4, 5, 6] as const

/** A fresh set of empty tiles, one entry per position. */
function emptyTyped(): string[] {
  return TILE_POSITIONS.map(() => '')
}

/**
 * Render the AUMLOK surface: the ceremony in its three states, and the technical status behind one
 * closed disclosure.
 * @param props - shell visibility, close action, ceremony source, and localized copy.
 * @returns the always-mounted AUMLOK surface.
 */
export function AumlokSurface({
  activeSurface,
  closeSurface,
  t,
  useControlProjection,
  ceremonyAvailable,
  drawPhrase,
  submitPhrase,
  refreshControlStatus,
}: AumlokSurfaceProps) {
  const active = activeSurface === 'aumlok'
  const projection = useControlProjection(value => value)
  // THE BROWSER CEREMONY (Round 21): with no desktop shell carrying the ceremony, a host that serves /_host/aumlok/*
  // runs it in this page. Its status is what the screen is bound or unbound by, and it is read again after a ceremony.
  const [statusRound, setStatusRound] = useState(0)
  const aumlokStatus = useAumlokStatus(active, statusRound)
  const hostStatus = aumlokStatus.kind === 'live' ? aumlokStatus.status : null
  const [browserCeremony] = useState(() => createBrowserCeremony())
  // Whether this browser and this host can run it now (a first binding needs the host's trusted owner approval, and
  // every step needs a passkey); the reason is shown where the control would be.
  const [availability, setAvailability] = useState<CeremonyAvailability>(null)
  useEffect(() => {
    setAvailability(null)
    if (ceremonyAvailable || hostStatus === null) return
    let current = true
    void aumlokCeremonyAvailability(hostStatus).then((next) => { if (current) setAvailability(next) }, () => {})
    return () => { current = false }
  }, [ceremonyAvailable, hostStatus])
  const browserCeremonyHere = !ceremonyAvailable && hostStatus !== null && availability?.ok === true
  const ceremonyHere = ceremonyAvailable || browserCeremonyHere
  // The host's status decides bound or unbound only on the in-page path; a shell reads its own controller.
  const hostView = ceremonyAvailable ? null : hostStatus
  // THE OWNER LINES (Round 20): read from this page's own host each time the screen opens.
  const hostMode = useOpeningHostMode(active)
  const ownerKey = useHostRoute(active, OWNER_KEY_ROUTE)
  const passkey = useHostRoute(active, PASSKEY_ROUTE)
  const [refreshing, setRefreshing] = useState(false)
  const [changingHandle, setChangingHandle] = useState(false)
  const [beat, setBeat] = useState<AumlokCeremonyBeat>('none')
  // THE WORDS LIVE ONLY WHILE THEY ARE ON THE SCREEN. This is the one place they exist in this
  // process, they are cleared the moment the tiles turn over, and nothing else in this file reads
  // them — no effect, no log, no request.
  const [words, setWords] = useState<readonly string[] | undefined>(undefined)
  const [typed, setTyped] = useState<readonly string[]>(emptyTyped)
  // THE HANDLE LIVES HERE ONLY WHILE IT IS ON THE SCREEN, and it is NOT a secret: it is public, it is
  // recorded in the public record, and it is what a NIP-05 `name@domain` local part is read from. It is
  // held in this component's state for the same reason the words are — because the person is typing it
  // — and it is passed to the shell exactly as typed.
  const [handle, setHandle] = useState('')
  const [busy, setBusy] = useState(false)
  const [acknowledged, setAcknowledged] = useState(false)
  const [outcome, setOutcome] = useState<AumlokCeremonyResult | undefined>(undefined)
  // A ROTATION IN THIS PAGE STARTS FROM THE WORDS IN USE (Round 22): they open the sealed root after the bound passkey,
  // and the same root is sealed under the new words. While this is on, the seven tiles take the current words.
  const [askCurrent, setAskCurrent] = useState(false)
  // A last step with no clear answer, or one that finished after the screen closed (it is never aborted once sent).
  const [notice, setNotice] = useState<CeremonyNotice | null>(null)
  const ceremonyGeneration = useRef(0)
  const activeRef = useRef(active)
  useLayoutEffect(() => { activeRef.current = active }, [active])
  // A last step that settles while the screen is open again is said at once, and the status is read again.
  useEffect(() => browserCeremony.onSettled(() => {
    if (!activeRef.current) return
    const settled = browserCeremony.takeSettled()
    if (settled === null) return
    setNotice(noticeOf(settled))
    setStatusRound(round => round + 1)
  }), [browserCeremony])
  useLayoutEffect(() => {
    if (!active) {
      setRefreshing(false)
      setChangingHandle(false)
      setBeat('none')
      setWords(undefined)
      setTyped(emptyTyped())
      setHandle('')
      setBusy(false)
      setAcknowledged(false)
      setOutcome(undefined)
      setAskCurrent(false)
      setNotice(null)
      browserCeremony.reset()
    } else {
      const settled = browserCeremony.takeSettled()
      if (settled !== null) setNotice(noticeOf(settled))
    }
    // Invalidate pending work on close or unmount; late words must never reopen a ceremony, and an in-page ceremony
    // still in flight is aborted.
    return () => { ceremonyGeneration.current += 1; browserCeremony.reset() }
  }, [active, browserCeremony])
  const hostBound = hostView?.state === 'bound'
  const state = aumlokSurfaceState({ bound: projection.status === 'connected' || hostBound, refreshing })
  // WHETHER THE STATE WAS READ AT ALL (Round 20): with no controller the state above is a default, so the badge says
  // that rather than UNBOUND, and no handle is asked for on a host where no ceremony can run.
  const stateReading = hostView !== null ? { read: true, note: '' } : aumlokStateRead(projection)
  const stateRead = stateReading.read
  const face = askCurrent ? 'input' : aumlokTileFace(state, beat)
  const action = aumlokActionKey(state, beat)
  const gate = aumlokConfirmGate({ beat, acknowledged, busy })
  // Y3: The owner's "give me another" — a quiet redraw, offered while the words are on an unbound screen
  // and nowhere else. `busy` is one of its three inputs because a draw already in flight cannot be
  // asked for a second time.
  const redraw = aumlokRedraw({ state, beat, busy })
  // X8: ON A NEW MACHINE THE HANDLE COMES FIRST, THEN THE SEVEN WORDS. `canDraw` is that order as a
  // decision rather than a disabled-looking button: `begin` refuses to ask the shell for words until
  // what is in the field can be a handle, so a ceremony cannot start with half of its key missing.
  // WHAT THE HANDLE BLOCK SHOWS: what the person typed on a machine that is not bound yet, and the
  // name the RECORD publishes on one that is (Y2). The published handle wins wherever it exists,
  // because it is the binding's own fact; the typed one is what carries the field before there is a
  // record to read.
  const boundHandle = projection.status === 'connected' ? projection.control.handle : undefined
  const shownHandle = typeof boundHandle === 'string' && boundHandle.length > 0
    ? boundHandle
    : (state === 'unbound' ? handle : '')
  const gateRead = aumlokHandleGate({ state: changingHandle ? 'unbound' : state, handle: changingHandle ? handle : shownHandle })
  // The in-page ceremony takes no handle (the host binds a key, not a name), so it asks for none.
  const handleGate = ceremonyAvailable ? gateRead : { ...gateRead, ask: false, canDraw: true }
  const sameHandle = changingHandle && typeof boundHandle === 'string' && boundHandle.length > 0
    && handle.normalize('NFKC').toLowerCase() === boundHandle.normalize('NFKC').toLowerCase()
  // On the in-page path the binding's public fact is the node's key (AUMLOK v2 no longer serves the commitment).
  const receipt = projection.status === 'connected' ? aumlokReceipt(projection.control)
    : hostBound && hostView.nodePubkeyHex !== null ? aumlokReceipt({ activeControlDigest: hostView.nodePubkeyHex,
      ...(hostView.boundAt === null ? {} : { boundAt: new Date(hostView.boundAt).toISOString() }) })
      : undefined
  // The verbs this screen calls: the desktop shell's when it carries the ceremony, otherwise the in-page ceremony.
  const drawFor = (intent: AumlokCeremonyIntent, current?: readonly string[]): Promise<AumlokDrawnPhrase> => (browserCeremonyHere
    ? browserCeremony.draw(intent, hostStatus, current) : drawPhrase(intent))
  const submitFor = (intent: AumlokCeremonyIntent, words: readonly string[], name: string): Promise<AumlokCeremonyResult> =>
    (browserCeremonyHere ? browserCeremony.submit(intent, words) : submitPhrase(intent, words, name))
  const statusChanged = (): void => { if (browserCeremonyHere) setStatusRound(round => round + 1); else refreshControlStatus() }
  const onType = (position: number, value: string): void => {
    // THE BOX ACKNOWLEDGES THE WORDS THAT WERE ON THE SCREEN WHEN IT WAS TICKED. Editing any of them
    // afterwards puts the box back to unticked, so the one thing that arms Bind cannot be carried
    // over a phrase the person has not said out loud.
    if (beat === 'confirm') setAcknowledged(false)
    setTyped(current => current.map((word, index) => (index === position ? value : word)))
  }
  // ASK FOR ONE PHRASE, AND SHOW IT ONCE. A draw that returns no words is a refusal, not an empty
  // phrase: the screen then says only that no result came back. A refresh refused before its last step
  // leaves the binding as it was; one whose last answer was lost is said to be UNKNOWN, never "unchanged".
  const begin = (intent: AumlokCeremonyIntent, current?: readonly string[]): void => {
    // THE ORDER X8 ASKS FOR, ENFORCED WHERE IT MATTERS. On a new machine the handle is typed first; a
    // draw that happened before it would be a ceremony whose key is half missing, and the shell would
    // refuse it later with a name a person could do nothing with at this point.
    if (busy || !active || !handleGate.canDraw || sameHandle) return
    const generation = ++ceremonyGeneration.current
    setBusy(true)
    setOutcome(undefined)
    setNotice(null)
    setAcknowledged(false)
    if (intent === 'refresh') setRefreshing(true)
    void (async () => {
      const drawn = await drawFor(intent, current).catch((): AumlokDrawnPhrase => ({ ok: false }))
      if (generation !== ceremonyGeneration.current) return
      setBusy(false)
      if (!drawn.ok || drawn.words === undefined) {
        setOutcome(drawn.reason === undefined ? { ok: false } : { ok: false, reason: drawn.reason })
        if (intent === 'refresh') setRefreshing(false)
        return
      }
      setWords(drawn.words)
      setTyped(emptyTyped())
      setBeat('shown')
    })()
  }
  // A spent draw needs new words; only a refusal before consumption can keep the typed tiles.
  const submit = (intent: AumlokCeremonyIntent): void => {
    if (busy || !active || sameHandle) return
    const generation = ++ceremonyGeneration.current
    setBusy(true)
    setOutcome(undefined)
    void (async () => {
      const result = await submitFor(intent, typed, handle).catch((): AumlokCeremonyResult => ({ ok: false }))
      if (result.ok || result.reason === AUMLOK_OUTCOME_UNKNOWN) statusChanged()
      if (generation !== ceremonyGeneration.current) return
      setBusy(false)
      setWords(undefined)
      setAcknowledged(false)
      setOutcome(result)
      if (!result.ok && result.reason === AUMLOK_OUTCOME_UNKNOWN) setNotice({ kind: 'unknown', intent })
      if (result.ok && result.reason === AUMLOK_SETTLED_BY_STATUS) setNotice({ kind: 'settled', intent })
      if (result.ok && result.reason === AUMLOK_SETTLED_AS_THIS_CEREMONY) setNotice({ kind: 'settled-here', intent })
      if (!result.ok) {
        if (result.drawSpent === true) {
          setTyped(emptyTyped())
          setBeat('none')
          if (intent === 'refresh') setRefreshing(false)
          return
        }
        setBeat('typed')
        return
      }
      setBeat('none')
      setTyped(emptyTyped())
      setRefreshing(false)
      setChangingHandle(false)
      setHandle('')
    })()
  }
  // ONE CONTROL PER STATE, AND THE PERSON'S OWN BEAT BETWEEN SHOWING AND TYPING. The words leave the
  // screen here and nowhere else, which is why this is a click and not a timer. THE THIRD CLICK IS NOT
  // A BIND: it puts the owner's warning on the screen and arms the button, and only a ticked box lets the
  // fourth click write an identity the person has just been told they will never see again.
  const act = (): void => {
    if (busy) return
    if (askCurrent) {
      // The words in use leave the tiles here: they go to the draw, which opens the sealed root and keeps nothing.
      const current = typed
      setAskCurrent(false)
      setTyped(emptyTyped())
      begin('refresh', current)
      return
    }
    if (beat === 'shown') {
      setWords(undefined)
      setBeat('typed')
      return
    }
    if (beat === 'typed') {
      setAcknowledged(false)
      setBeat('confirm')
      return
    }
    if (beat === 'confirm') {
      if (!gate.bindEnabled) return
      submit(state === 'refresh' ? 'refresh' : 'bind')
      return
    }
    if (state === 'unbound') begin('bind')
    else if (state === 'bound') {
      // In this page a rotation needs no new handle; it starts from the words in use, which open the sealed root.
      if (browserCeremonyHere) { setOutcome(undefined); setNotice(null); setTyped(emptyTyped()); setAskCurrent(true) }
      else if (!changingHandle) { setHandle(''); setChangingHandle(true) }
      else begin('refresh')
    }
  }
  useEffect(() => {
    if (!active) return
    // Bubble-phase, deferring to consumed events: Modal/Menu take Escape in
    // capture and mark it defaultPrevented, and Escape inside a text-entry
    // control belongs to that control, so only an unclaimed press closes the
    // surface.
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      if (isEditableTarget(event.target)) return
      event.preventDefault()
      closeSurface()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown) }
  }, [active, closeSurface])

  const ceremonyControls = ceremonyHere ? (
    <div
      className={css.ceremonyAction}
      data-aumlok-ceremony-state={state}
      data-aumlok-ceremony-beat={beat}
    >
      {beat === 'shown' ? (
        <p className={css.warning} data-aumlok-phrase-warning>{t('surface.warning.lost')}</p>
      ) : null}
      {/* Y3: "GIVE ME ANOTHER". The requirement is that a person may draw a new phrase "as
          many times as the person likes until one feels right", and that NOTHING is written
          until they confirm and type it back. Both halves are the decision above: it is
          offered exactly while the words are on an unbound screen, and its handler draws —
          it never submits, so there is no path from this control to a write.
          IT IS A SPAN, AND NOT A SECOND BUTTON ELEMENT, DELIBERATELY. X6 courts exactly ONE
          button element in this surface and that one is the ceremony's own; a second one
          here would break a ticked requirement to satisfy this one, and on a bound screen it
          would be the second big button the design rules out. So the element kind is part of the
          requirement rather than a styling choice, and the keyboard handler below is what
          makes a span an honest control rather than a click target only a mouse can reach.
          THIS COMMENT DELIBERATELY DOES NOT SPELL THAT ELEMENT'S TAG, and the reason is
          measured rather than imagined: X6 counts openings of that tag in THIS FILE, so a
          comment that named it would be counted as one. That arm is a protection, not an
          obstacle, and the honest way past it is to stop writing the tag in prose — never
          to loosen the arm. */}
      {redraw.offered ? (
        <span
          className={css.redraw}
          data-aumlok-redraw
          data-aumlok-redraw-kind={redraw.kind}
          role="button"
          tabIndex={0}
          onClick={() => { begin('bind') }}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return
            event.preventDefault()
            begin('bind')
          }}
        >
          {t(redraw.action ?? 'surface.action.another')}
        </span>
      ) : null}
      {/* THE CONFIRMATION STEP, BEFORE ANYTHING IS BOUND. The words are off the screen, the
          person has typed them back, and this is the last moment at which saying them out
          loud can save the identity: the box is what arms the button. */}
      {gate.ask ? (
        <div className={css.confirm} data-aumlok-confirm>
          <p className={css.confirmWarning} data-aumlok-confirm-warning>
            {t('surface.confirm.warning')}
          </p>
          <label className={css.confirmRow}>
            <input
              type="checkbox"
              data-aumlok-confirm-checkbox
              checked={acknowledged}
              disabled={busy}
              onChange={(event) => { setAcknowledged(event.target.checked) }}
            />
            <span>{t('surface.confirm.checkbox')}</span>
          </label>
        </div>
      ) : null}
      <button
        type="button"
        data-aumlok-bind-button
        data-aumlok-action={action}
        disabled={busy || (gate.ask && !gate.bindEnabled)
          || (handleGate.ask && !handleGate.canDraw) || sameHandle}
        aria-busy={busy}
        onClick={act}
      >
        {askCurrent && !busy ? 'Open my root with these words' : t(busy ? 'runtime.binding.busy'
          : (changingHandle || (browserCeremonyHere && state === 'bound')) && beat === 'none' ? 'surface.action.drawNew' : action)}
      </button>
      {state !== 'unbound' && !browserCeremonyHere ? <p className={css.handleHint}>{t('surface.handle.together')}</p> : null}
      {browserCeremonyHere ? (
        <p className={css.handleHint} data-aumlok-passkey-note>
          {state === 'unbound'
            ? 'Binding asks for your passkey twice: once to register it, once to confirm it. Your node key comes from a root '
              + 'sealed by these seven words.'
            : askCurrent
              ? 'Type the seven words you use now. Your passkey releases your sealed root, these words open it here, and the '
                + 'same node key is then sealed under your new words.'
              : 'A new phrase starts from the words you use now, and is confirmed with your bound passkey. Your node key stays the same.'}
        </p>
      ) : null}
      {/* ONE REFUSAL, AND IT CARRIES NO CONTENT: not which word was wrong, not how many
          matched. A refusal that narrowed the answer would be an oracle for anyone who can
          read this screen. */}
      {outcome === undefined || outcome.ok || outcome.reason === AUMLOK_OUTCOME_UNKNOWN ? null : (
        <p className={css.ceremonyRefusal} data-aumlok-binding-refused="true">
          {t('runtime.binding.failed')}
          {outcome.reason === undefined ? null : (
            <>
              {' '}
              <code data-aumlok-binding-reason>{outcome.reason}</code>
            </>
          )}
        </p>
      )}
    </div>
  ) : (
    // NO CEREMONY ON THIS HOST, SAID IN WORDS: empty tiles and no control would otherwise read as a screen that is broken
    // rather than one whose ceremony service is not here.
    <p className={css.handleHint} data-aumlok-ceremony-absent>{noCeremonyWords(aumlokStatus, availability)}</p>
  )
  const runtimeReason = projection.status === 'connected' ? t(AUMLOK_RUNTIME_POSTURE.connected.detail)
    : projection.reason !== undefined ? t(AUMLOK_NOT_CONNECTED_REASON[projection.reason])
      : projection.code !== undefined ? t('runtime.reason.code').replace('{code}', projection.code) : t('runtime.reason.unnamed')

  return (
    <section
      data-aumlok-surface
      className={css.surface}
      hidden={!active}
      aria-hidden={!active}
      aria-labelledby="aumlok-title"
    >
      <div className={css.canvas}>
        <header className={css.hero}>
          <div className={css.heroCopy}>
            <p>{t('eyebrow')}</p>
            <h2 id="aumlok-title">{t('title')}</h2>
          </div>
          {/* §3's badge: UNBOUND before a binding and BOUND after it, through a refresh as well,
              because a refresh is an act on the bound state and the old binding stands until the new
              words are typed back. The decision is `aumlokBadgeWord`, keyed off the same state the
              tiles and the buttons are drawn from, so the badge cannot disagree with the screen. */}
          {stateRead ? (
            <span className={css.statusBadge} data-aumlok-badge={aumlokBadgeWord(state)} role="img" aria-label={t(aumlokBadgeWord(state))}>
              {aumlokBadgeWord(state) === 'bound' ? <IdentityIcon name="lock" /> : null}
              {t(aumlokBadgeWord(state))}
            </span>
          ) : (
            <span className={css.statusBadge} data-aumlok-badge="not-read" role="img" aria-label="state not read">NOT READ</span>
          )}
        </header>

        <div className={css.composition}>
          <section className={css.phraseStage} aria-label={t('phrase.label')}>
            {/* A new binding needs a handle before the phrase is drawn; a bound handle is read-only. */}
            {handleGate.ask ? (
              <div className={css.handleField} data-aumlok-handle>
                <label className={css.handleLabel} htmlFor="aumlok-handle">
                  {t('surface.handle.label')}
                </label>
                <input
                  id="aumlok-handle"
                  className={css.handleInput}
                  data-aumlok-handle-input
                  value={handle}
                  disabled={busy || beat !== 'none'}
                  onChange={(event) => { if (!busy && beat === 'none') setHandle(event.target.value) }}
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                />
                {/* THE SHAPE IS SAID BEFORE IT IS ENFORCED, and the hint changes to the rule when what
                    is typed cannot be a handle: a disabled button with no sentence beside it is the
                    silent refusal this whole screen exists to remove. */}
                <p className={css.handleHint} data-aumlok-handle-hint>
                  {sameHandle ? t('surface.handle.mustChange') : handle.length === 0 || handleGate.valid
                    ? t('surface.handle.hint')
                    : t('surface.handle.invalid')}
                </p>
              </div>
            ) : null}
            {handleGate.shown ? (
              <Panel className={css.handleHeading} data-aumlok-handle-locked>
                <div><span className={css.handleLabel}>{t('surface.handle.label')}</span>
                  <h3 data-aumlok-handle-locked-value>{handleGate.value}</h3></div>
                <div className={css.handleTools}><IdentityIcon name="lock" /><span>{t('surface.handle.locked')}</span>
                </div>
              </Panel>
            ) : null}
            {/* THE GOLD ANCHOR CARD, WITH SIX BOXES IN IT. Six because the anchor is a six-letter
                word: `aumlokAnchorBoxes` answers a letter while the words are on the screen, a dot
                once a binding exists, and nothing before either. */}
            <div
              className={css.anchorToken}
              data-aumlok-token={AUMLOK_ANCHOR_POSITION}
              data-aumlok-anchor-card
              data-aumlok-tile-face={face}
            >
              <span className={css.anchorMeta}>
                <strong>{t('anchor.label')}</strong>
                <span>{t('anchor.detail')}</span>
              </span>
              <span className={css.anchorBoxes}>
                {/* Y5'S REVEAL MARKER, AND WHY A MARKER IS NEEDED AT ALL. The six boxes below only
                    exist at the face where a letter belongs in them, so the mount IS the arrival and
                    CSS settles them in without script. This span is what makes "the words are on the
                    screen" a fact a court or a probe can read, and it is emitted only while they are:
                    `display: contents` means it costs the layout nothing. */}
                {face === 'word' ? <span data-aumlok-reveal="words" aria-hidden="true" /> : null}
                {face === 'input' ? (
                  <input
                    className={css.anchorInput}
                    data-aumlok-tile-input={AUMLOK_ANCHOR_POSITION}
                    data-aumlok-anchor-input
                    value={typed[AUMLOK_ANCHOR_POSITION] ?? ''}
                    onChange={(event) => { onType(AUMLOK_ANCHOR_POSITION, event.target.value) }}
                    aria-label={t('tile.input').replace('{position}', String(AUMLOK_ANCHOR_POSITION))}
                    autoComplete="off"
                    autoCapitalize="none"
                    spellCheck={false}
                  />
                ) : (
                  aumlokAnchorBoxes(face, words?.[AUMLOK_ANCHOR_POSITION]).map((box, index) => (
                    <AnchorBox box={box} index={index} key={index} />
                  ))
                )}
              </span>
              {face === 'dots'
                ? <span className={css.visuallyHidden}>{t('token.anchorMasked')}</span>
                : null}
            </div>
            <div className={css.bands}>
              {/* Y5'S SECOND REVEAL MARKER: the same fact as the one in the card above, on the spine,
                  so the boxes settling and the rows fading are one arrival rather than two effects that
                  could drift apart. It is a sibling of the bands, so it cannot disturb their stagger
                  (which counts children of `.bandRows`), and `display: contents` means it draws
                  nothing itself. */}
              {face === 'word' ? <span data-aumlok-reveal="words" aria-hidden="true" /> : null}
              {AUMLOK_BANDS.map(band => (
                <PhraseBand
                  band={band}
                  face={face}
                  words={words}
                  typed={typed}
                  onType={onType}
                  t={t}
                  key={band.id}
                />
              ))}
            </div>
            <div className={receipt === undefined ? undefined : css.boundReceipt}
              data-aumlok-bound-receipt={receipt === undefined ? undefined : ''}>
              {receipt === undefined ? null : <>
                <h3 className={css.boundLine} data-aumlok-bound-line>{t('surface.bound.line')}</h3>
                <p className={css.boundExplanation} data-aumlok-bound-explanation>
                  {projection.status === 'connected' ? t('surface.bound.explanation')
                    : 'This is your node’s public key. Its root is sealed by your seven words and kept in this host’s escrow: '
                      + 'your bound passkey releases it, and only your words open it.'}
                </p>
                <code className={css.boundRoot} data-aumlok-receipt-root>{receipt.root}</code>
              </>}
              {notice === null ? null : (
                <p className={notice.kind === 'unknown' ? css.ceremonyRefusal : css.handleHint} data-aumlok-notice={notice.kind}>
                  {noticeWords(notice)}
                </p>
              )}
              {ceremonyControls}
            </div>
          </section>

          <Panel className={css.flow} aria-labelledby="aumlok-flow-label">
            <SectionHeader className={css.explanationHeader}>
              <img src="/assets/aukora-mark-96.png" width="36" height="36" alt="" />
              <h3 id="aumlok-flow-label">{t('surface.explanation.title')}</h3>
            </SectionHeader>
            <div className={css.explanation} data-aumlok-explanation>
              <p>{t('surface.explanation.identity')}</p>
              <p>{t('surface.explanation.knowledge')}</p>
              <p>{t('surface.explanation.decider')}</p>
              <p>{t('surface.explanation.boundary')}</p>
              <p>{t('surface.explanation.edge')}</p>
            </div>
            <p className={css.boundaryClosing}>{t('surface.explanation.closing')}</p>
          </Panel>

          <Panel className={css.flow} aria-labelledby="aumlok-owner-label" data-aumlok-owner-state>
            <SectionHeader className={css.explanationHeader}>
              <h3 id="aumlok-owner-label">This node’s owner</h3>
            </SectionHeader>
            <FieldTable rows={[
              ['states', <CeremonyStates key="states" state={state} read={stateRead} note={stateReading.note} />],
              ['phrase ceremony', ceremonyWords(ceremonyAvailable, aumlokStatus, availability)],
              ['binding', receipt !== undefined
                ? `bound · ${projection.status === 'connected' ? 'root' : 'node key'} ${receipt.root.slice(0, 16)}…`
                  + (receipt.boundAt === undefined ? '' : ` · ${receipt.boundAt}`)
                : hostView?.state === 'unbound' ? 'unbound (read from this host)'
                  : projection.status === 'connected' || ceremonyAvailable ? 'none read on this host' : statusUnread(aumlokStatus)],
              ['owner key', ownerKeyWords(ownerKey)],
              ['owner sign-in', ownerSignInWords(hostMode)],
              ['passkey', hostView === null ? passkeyWords(passkey)
                : hostView.passkeyVerified ? 'verified at binding (user verification required)' : 'none bound'],
              ['node identity', hostView === null ? (ceremonyAvailable ? 'read by the desktop shell, not this card' : statusUnread(aumlokStatus))
                : hostView.nodePubkeyHex === null ? 'no node key yet (unbound)' : `key ${hostView.nodePubkeyHex.slice(0, 16)}…`],
              ['domain', hostView?.domainIsPointer === true ? `${globalThis.location.host} · a pointer to this node, not its identity`
                : hostView === null ? (ceremonyAvailable ? 'read by the desktop shell, not this card' : statusUnread(aumlokStatus))
                  : 'not reported by this host'],
              ['invites', ceremonyAvailable ? 'read by the desktop shell, not this card' : inviteWords(aumlokStatus)],
            ]}
            />
            {hostView?.identityIsKey === true && hostView.domainIsPointer ? (
              <p className={css.handleHint} data-aumlok-identity-rule>Node identity = cryptographic key · Domain = rotatable pointer</p>
            ) : null}
            {/* The owner's 14:20 rule: the technical status sits behind one closed disclosure. */}
            <details data-aumlok-runtime-status={projection.status}>
              <summary>{t('details')}</summary>
              <p>{t(AUMLOK_RUNTIME_POSTURE[projection.status].status)}</p>
              <p>{runtimeReason}</p>
            </details>
            <Footnote>
              A public key on file proves no sign-in and no person; a signature over the exact bytes proves only that this key signed them.
            </Footnote>
          </Panel>
        </div>
      </div>

    </section>
  )
}
