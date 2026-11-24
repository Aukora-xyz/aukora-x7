// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The Aukora authors
/**
 * THE PREDECESSOR'S IDENTITY SURFACE IN THE CENTRE STAGE (an earlier repository).
 *
 * WHAT IS REAL. The owner's PUBLIC Ed25519 key comes from `GET /_host/owner-key` (on main): its keyId, and a QR of the
 * contact string `aukora:owner-public-key:v1:ed25519:<hex>`, folded under "Show my contact code" so the screen opens on its
 * cards (no icon tile and no "Owner" heading above it). The private half never reaches this page.
 * The node's Nostr identity comes from `GET /aukora-messages/contacts.json`; when it has an
 * npub, the QR adds a `nostr:<npub>` line. With none yet, the owner may provision one (`POST /_head/transcript`
 * `{ action: 'nostr_provision' }`). The human-vouching quota (aukora.invite.v1) is read from `/_host/aumlok/status`, and
 * an invite is issued or revoked here with the seven words and two Touch ID taps (`invite.ts` says every call).
 * Contact scanning still says NOT CONNECTED YET (the predecessor's camera sheet and verify route are not ported).
 *
 * THE PASSKEY. The passkey and AUMLOK cards read the edge's own `GET /_host/aumlok/status` (the edge has no separate
 * passkey route): the bound passkey signs the owner in and approves changes, and "Your devices" adds another computer's
 * passkey. A route that is not there reads NOT CONNECTED YET naming it. Everything opens inline; nothing is drawn over
 * the site.
 *
 * @module apps/identity/IdentitySurface
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { FieldTable, Lead, PortalButton, PortalCell, PortalFold, PortalGrid, RecordList, RecordRow, StatusPill } from '../../primitives/index.ts'
import type { Badge, Tone } from '../../primitives/index.ts'
import { SurfaceFrame } from '../../x5/common.tsx'
import { IdentityIcon, type IdentityIconName } from '../../aumlok/IdentityVisuals.tsx'
import css from '../../aumlok/AumlokFace.module.css'
import {
  OWNER_KEY_ROUTE, hostCall, ownerContact, readOwnerKey, statusRows,
  type HostAnswer, type OwnerPublicKey,
} from './host.ts'
import { qrSvgDataUrl } from './qr.ts'
import {
  AUMLOK_STATUS_ROUTE, INVITE_SCHEMA, PROVISION_ROUTE, cardText, inviteOf, provisionAvailable, readNostr,
  relayWords, type InviteRead, type NostrRead,
  ANCHOR_PREPARED_LIFE_MS, ANCHOR_ROUTE, ANCHOR_VISIBLE_POLL_MS, ANCHOR_VISIBLE_POLLS, NIP05_NAME, NIP05_ROUTE, PUBLIC_HEAD_ROUTE,
  forgetProvision, forgetPublication, npubOf, prepareAnchor, provisionRun, provisionTerms, provisionWords, publicationRun, publishWords,
  readAnchorFacts, readPublicHead, runProvision, runPublication, servedMatch, watchProvision, watchPublication,
  type AnchorFactsRead, type PreparedAnchor, type ProvisionRun, type PublicationRun, type PublicHeadRead, type ServedMatch,
} from './nostr.ts'
import { passkeyBlocker } from './webauthn.ts'
import {
  INVITE_CHALLENGE_LIFE_MS, INVITE_ISSUE_APPROVAL, INVITE_KEY_HOLD_MS, INVITE_TAP_AGAIN_MARGIN_MS, inviteReadiness, inviteRefusalWords,
  inviteRevokeApproval, issueInvite, newInviteeCode,
  checkGuestInvite, inviteFromText, INVITE_LINK_PREFIX, inviteShareLink, syncHostInvites, type GuestInviteCheck, type HostInvitesRead,
  normaliseInviteDomain, openNodeForInvite, readInviteBook, readInviteStatus, receiptJson, receiptLine, revocationLine, revokeInvite,
  verifyInviteReceipt, redeemInvite, redeemWords, type RedeemOutcome,
  type InviteBook, type InviteReceipt, type InviteStatus, type InviteStatusRead, type InviteStep, type InviteeCode, type SignedRevocation,
} from './invite.ts'
import { aumlokCommitment, aumlokRequestId, parseAumlokPhrase } from '../../aumlok/aumlok-ceremony.ts'
import type { AumlokNode } from '../../aumlok/aumlok-root.ts'
import { canonicalJson } from '../../aumlok/class3-approval.ts'
import { AumlokWordInput } from '../../aumlok/AumlokWordTiles.tsx'
import { en as aumlokEnglish, type AumlokKey } from '../../aumlok/locales.ts'
import { beginApproval, endApproval } from '../../portal/touch-id-timing.ts'
import './identity-surface.css'
import { isEditableTarget } from '../../aura/escape.ts'
import { DevicesPortal } from './DevicesPortal.tsx'

/** Surface id in the centre lane. */
export const IDENTITY_SURFACE = 'identity'

const NOT_CONNECTED = (title: string) => <StatusPill tone="muted" title={title}>NOT CONNECTED YET</StatusPill>
const LIVE = <StatusPill tone="mint">LIVE</StatusPill>

/** Read one host route while `active`; `reload` reads it again. */
function useHostRead(route: string, active: boolean): { answer: HostAnswer | null; reload: () => void } {
  const [answer, setAnswer] = useState<HostAnswer | null>(null)
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    if (!active) return
    const controller = new AbortController()
    hostCall(route, controller.signal).then((next) => { if (!controller.signal.aborted) setAnswer(next) }).catch(() => {})
    return () => { controller.abort() }
  }, [route, active, revision])
  return { answer, reload: () => { setRevision(value => value + 1) } }
}

/** One status line: what the route answered, in words. */
function answerPill(answer: HostAnswer | null): ReactNode {
  if (answer === null) return <StatusPill tone="muted">READING</StatusPill>
  if (answer.kind === 'live') return LIVE
  if (answer.kind === 'absent') return NOT_CONNECTED(`${answer.route}: ${answer.detail}`)
  return <StatusPill tone="red" title={answer.message}>REFUSED</StatusPill>
}

function AnswerBody({ answer, missing }: { readonly answer: HostAnswer | null; readonly missing: string }) {
  if (answer === null) return <Lead>Reading the host.</Lead>
  if (answer.kind === 'absent') {
    return <Lead>{`NOT CONNECTED YET: ${answer.route} is not on this host (${answer.detail}). Missing: ${missing}`}</Lead>
  }
  if (answer.kind === 'refused') {
    return <p className="x5-error" role="alert">{`${answer.route} refused (${String(answer.status)} ${answer.code}): ${answer.message}`}</p>
  }
  const rows = statusRows(answer.body)
  return rows.length > 0 ? <FieldTable rows={rows} /> : <Lead>{`${answer.route} answered with no status fields.`}</Lead>
}

/** The predecessor's identity action button: icon, label, a check or a cross for a moment after it runs. */
function CardAction({ icon, label, run, disabled = false }: {
  readonly icon: IdentityIconName
  readonly label: string
  readonly run: () => Promise<unknown>
  readonly disabled?: boolean
}) {
  const [result, setResult] = useState<'check' | 'error' | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => { clearTimeout(timer.current) }, [])
  return (
    <button type="button" className={css.identityAction} data-labeled="" data-result={result ?? undefined} disabled={disabled}
      aria-label={result === 'error' ? `${label}: failed` : label} title={result === 'error' ? 'Failed' : label}
      onClick={() => {
        setResult(null)
        void Promise.resolve().then(run).then(() => { setResult('check') }).catch(() => { setResult('error') }).finally(() => {
          clearTimeout(timer.current)
          timer.current = setTimeout(() => { setResult(value => (value === 'check' ? null : value)) }, 1800)
        })
      }}>
      <IdentityIcon name={result ?? icon} /><span>{label}</span>
    </button>
  )
}

const copyText = async (text: string): Promise<void> => {
  if (typeof (navigator.clipboard as Clipboard | undefined)?.writeText !== 'function') throw new Error('identity:clipboard-unavailable')
  await navigator.clipboard.writeText(text)
}

/**
 * "SHOW MY CONTACT CODE" (the icon tile and the word "Owner" above the QR are gone, and the QR folds
 * away, so the screen opens on its cards). Folded, it still holds the code: the owner public key (and the node's npub when
 * it has one) as a QR, what it carries, and the copy actions. "Verify a contact" needs this code from the other side.
 */
function ContactCode({ answer, ownerKey, npub, onRetry }: {
  readonly answer: HostAnswer | null
  readonly ownerKey: OwnerPublicKey | null
  readonly npub: string | null
  readonly onRetry: () => void
}) {
  const contact = ownerKey === null ? null : ownerContact(ownerKey)
  const carried = cardText(contact, npub)
  const qr = useMemo(() => {
    try { return carried === null ? null : qrSvgDataUrl(carried, 'Q') } catch { return null }
  }, [carried])
  const problem = answer === null ? null
    : answer.kind === 'absent' ? `NOT CONNECTED YET: ${answer.route} (${answer.detail})`
      : answer.kind === 'refused' ? `${answer.route} refused (${answer.code}): ${answer.message}`
        : ownerKey === null ? `${OWNER_KEY_ROUTE} answered a shape that is not { publicKeyHex, keyId }; nothing is drawn.` : null
  return (
    <PortalCell data-identity-portal="contact-code">
      <PortalFold tone="blue" icon="identity" title="Show my contact code"
        summary={npub ? 'a QR of your public key and her npub, for someone to scan' : 'a QR of your public key, for someone to scan'}
        data-identity-card="" data-state={ownerKey ? 'ready' : problem ? 'failed' : 'loading'}>
        <div className="x6-identity__code">
          <div className={css.identityQrHalo} data-ready={qr ? '' : undefined}>
            <div className={css.identityQr} data-identity-qr="" aria-busy={!qr && problem === null}>
              {qr ? <img src={qr} alt={npub ? 'QR code of the owner public key and the node npub' : 'QR code of the owner public key'} draggable={false} />
                : problem ? (
                  <button type="button" className={css.identityRetry} onClick={onRetry}>
                    <IdentityIcon name="rotate" /><span>Read again</span>
                  </button>
                ) : <span className={css.identityQrPending} role="status" aria-label="Reading the owner key" />}
            </div>
          </div>
          {ownerKey ? (
            <p className="x6-identity__caption">
              {npub ? 'This QR carries the owner public key (Ed25519): ' : 'This QR carries the owner public key (Ed25519) and nothing else: '}<code>{contact}</code>
              {'. Key id '}<code>{ownerKey.keyId}</code>
              {npub ? <>{'. It also carries the node’s Nostr identity '}<code data-identity-card-npub="">{`nostr:${npub}`}</code>
                {'. It carries no signature.'}</> : '. It is not a Nostr identity and carries no signature.'}
            </p>
          ) : problem ? <p className="x5-error" role="alert">{problem}</p> : null}
          <div className={css.identityActions}>
            <CardAction icon="copy" label="Copy contact" disabled={contact === null} run={() => copyText(contact ?? '')} />
            <CardAction icon="key" label="Copy public key" disabled={ownerKey === null} run={() => copyText(ownerKey?.publicKeyHex ?? '')} />
          </div>
        </div>
      </PortalFold>
    </PortalCell>
  )
}

interface Outcome { readonly tone: Tone; readonly text: string; readonly rows?: readonly [string, string][] }

function OutcomeLine({ outcome }: { readonly outcome: Outcome | null }) {
  if (outcome === null) return null
  return (
    <>
      <p className="x6-identity__status" role="status" data-tone={outcome.tone}>{outcome.text}</p>
      {outcome.rows && outcome.rows.length > 0 ? <FieldTable rows={outcome.rows} /> : null}
    </>
  )
}

const dayOf = (value: unknown): string | null => typeof value === 'number' && Number.isSafeInteger(value) && value > 0
  ? new Date(value).toISOString().slice(0, 10) : null

/**
 * THE PASSKEY, AS THIS NODE KNOWS IT. The edge has no separate passkey route: the owner's passkey is the one AUMLOK bound,
 * read from `GET /_host/aumlok/status`. It signs the owner in (`/_auth/passkey`) and approves each change; another
 * computer gets its own passkey under "Your devices". This card makes no ceremony of its own.
 */
function PasskeyPortal({ answer }: { readonly answer: HostAnswer | null }) {
  const body = answer?.kind === 'live' ? answer.body : null
  const bound = body !== null && body.bound === true && body.passkeyVerified === true
  const blocker = passkeyBlocker()
  return (
    <PortalCell data-identity-portal="passkey">
      <PortalButton tone={bound ? 'gold' : 'muted'} icon="lock" iconTone="gold" title="Passkey (Touch ID)"
        summary={`${AUMLOK_STATUS_ROUTE} · ${body === null ? 'your device\'s own passkey sheet' : bound ? 'signs you in and approves changes' : 'none bound yet'}`}
        badge={answerPill(answer)}>
        {body === null ? <AnswerBody answer={answer} missing="the AUMLOK status route." /> : bound ? (
          <>
            <FieldTable rows={[
              ['passkey', 'bound to this node · user verification required'],
              ['bound', dayOf(body.boundAt) ?? 'not reported'],
              ['last used', dayOf(body.lastVerifiedAt) ?? 'not reported'],
            ]} />
            <Lead>
              This passkey signs you in to this node (Touch ID, Face ID or your device lock) and approves each change. To sign
              in from another computer, add it under “Your devices”.
            </Lead>
          </>
        ) : (
          <Lead>No passkey is bound to this node yet. Binding is the seven-word ceremony on the AUMLOK surface.</Lead>
        )}
        {blocker !== null ? <p className="x6-identity__status" data-tone="red">{`Passkeys cannot run in this browser: ${blocker}.`}</p> : null}
      </PortalButton>
    </PortalCell>
  )
}

/**
 * AUMLOK binding status only (`GET /_host/aumlok/status`). Binding is the seven-word ceremony on the AUMLOK surface
 * (The rule: only the seven words are remembered); this card never offers a second, passkey-only way to bind.
 */
function AumlokPortal({ answer }: { readonly answer: HostAnswer | null }) {
  const live = answer?.kind === 'live'
  const bound = answer?.kind === 'live' && answer.body.bound === true
  return (
    <PortalCell data-identity-portal="aumlok">
      <PortalButton tone={live ? 'violet' : 'muted'} icon="aumlok" iconTone="violet" title="AUMLOK binding"
        summary={`${AUMLOK_STATUS_ROUTE} · ${live ? (bound ? 'bound' : 'not bound') : 'status'}`} badge={answerPill(answer)}>
        <AnswerBody answer={answer} missing="the AUMLOK status route." />
        <Lead>Binding is the seven-word ceremony on the AUMLOK surface; this card only shows the host&apos;s status.</Lead>
      </PortalButton>
    </PortalCell>
  )
}

/** One read while `active`; `reload` reads it again. */
function useRead<T>(read: (signal: AbortSignal) => Promise<T>, active: boolean, reading: T): { value: T; reload: () => void } {
  const [value, setValue] = useState<T>(reading)
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    if (!active) return
    const controller = new AbortController()
    read(controller.signal).then((next) => { if (!controller.signal.aborted) setValue(next) }).catch(() => {})
    return () => { controller.abort() }
  }, [read, active, revision])
  return { value, reload: () => { setRevision(value => value + 1) } }
}

const NOSTR_READING: NostrRead = { kind: 'reading' }
const INVITE_READING: InviteRead = { kind: 'reading' }

/** The one line said when there is no npub to show and no button to offer. */
function nostrUnread(read: NostrRead): string | null {
  switch (read.kind) {
    case 'absent': return `This host does not serve a Nostr identity (${read.detail}).`
    case 'refused': return `This host refused to show its Nostr identity (${read.code}); you may be signed out.`
    case 'unreadable': return 'The host answered without a readable Nostr identity, so no npub is shown.'
    default: return null
  }
}

function nostrPill(read: NostrRead): ReactNode {
  switch (read.kind) {
    case 'reading': return <StatusPill tone="muted">READING</StatusPill>
    case 'live': return LIVE
    case 'none': return <StatusPill tone="gold">NO NPUB YET</StatusPill>
    case 'refused': return <StatusPill tone="red" title={read.code}>REFUSED</StatusPill>
    default: return NOT_CONNECTED(nostrUnread(read) ?? '')
  }
}

/** UTC, to the second, for a NIP-01 `created_at`. */
const utcOf = (seconds: number): string => `${new Date(seconds * 1000).toISOString().slice(0, 19).replace('T', ' ')} UTC`
/** This page's origin (the audience the passkey binds, and the public address's host), or null outside a browser. */
const originOf = (): string | null => {
  try {
    const origin = globalThis.location.origin
    return /^https?:\/\/[^/]+$/.test(origin) ? origin : null
  } catch { return null }
}

/** What the public address serves, in words, for the "now" row. */
function servedWords(published: PublicHeadRead): string {
  if (published.kind === 'none') return 'nothing is served at this address yet'
  if (published.kind === 'unreadable') return `not readable (${published.detail})`
  return `epoch ${published.event.tags.find(tag => tag[0] === 'epoch')?.[1] ?? '?'}, signed ${utcOf(published.event.created_at)}, id ${published.event.id}`
}

/** Which served fields are not the approved event's, in words. */
const DIFFERS: Readonly<Record<string, string>> = { time: 'its time', tags: 'its tags', content: 'its content', key: 'its key' }

/** `a`, `a and b`, `a, b and c`. */
const listed = (items: readonly string[]): string => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1) ?? ''}`)

/**
 * An event that names the approved id but is not the approved event, said plainly: what its own fields hash to, and which
 * fields differ. It never says "published as approved".
 */
function falseIdWords(match: Extract<ServedMatch, { kind: 'false' }>, approvedId: string): string {
  const parts = [
    ...(match.computedId === approvedId ? [] : [`its fields hash to the NIP-01 id ${match.computedId}, not to that id`]),
    ...(match.differs.length === 0 ? [] : [`${listed(match.differs.map(field => DIFFERS[field] ?? field))} ${match.differs.length === 1 ? 'is' : 'are'} `
      + 'not the approved event’s']),
  ]
  return `serves an event that names the id you approved (${approvedId}), but ${parts.join('; and ')}. It is not the event you approved, `
    + 'and this card does not call it published.'
}

/** The full line for a publication, from where it stands (kept above the card, so it is true when the card is shown again). */
function runLine(run: PublicationRun | null, seen: boolean): Outcome | null {
  if (run === null) return null
  switch (run.phase) {
    case 'approving': return { tone: 'muted', text: 'Waiting for Touch ID.' }
    case 'finishing': return { tone: 'muted', text: 'Touch ID is done. The node is finishing the approval; nothing is sent until it has.' }
    case 'sending': return { tone: 'muted', text: 'Touch ID approved this event. It is on its way to the node; this card waits for the node’s answer.' }
    case 'settled': {
      const { outcome } = run
      if (outcome.kind === 'unclear' && seen) {
        return { tone: 'mint', text: `The node’s answer was not clear (${outcome.detail}), but the public address now serves exactly the event you `
          + `approved (id ${run.prepared.id}; its own fields hash to that id, and each is the one you approved), so it was published.` }
      }
      return { tone: outcome.kind === 'published' ? 'mint' : outcome.kind === 'unclear' ? 'gold' : 'red', text: publishWords(outcome) }
    }
  }
}

/**
 * The one short line after the node accepted the event (the default view): accepted, and which of three things the public
 * address said on the latest read, in plain words (review SHOULD, job 5): it shows exactly that event; it was read and does
 * not show it yet; or it could not be read, so whether it shows it is not known. A read not yet answered says so too. The
 * full sentence, every id and the address's own answer stay under "See exactly what becomes public".
 */
function acceptedLine(published: PublicHeadRead | null, match: ServedMatch | null, seen: boolean, spent: boolean): Outcome {
  if (seen) return { tone: 'mint', text: 'Accepted, and the public address shows it.' }
  if (match?.kind === 'false') {
    return { tone: 'gold', text: 'Accepted, but the public address serves an event that is not the one you approved; this card does not call it published.' }
  }
  if (published === null) return { tone: 'muted', text: 'Accepted. Reading the public address to check whether it shows it.' }
  if (published.kind === 'unreadable') {
    return spent
      ? { tone: 'gold', text: 'Accepted. This card could not read the public address to check whether it shows it, after two minutes of trying; '
        + '“Check” reads it again.' }
      : { tone: 'muted', text: 'Accepted. This card could not read the public address to check whether it shows it; it tries again for up to two minutes.' }
  }
  if (spent) return { tone: 'gold', text: 'Accepted. The public address has not shown it after two minutes of reading; “Check” reads it again.' }
  if (match?.kind === 'other') return { tone: 'muted', text: 'Accepted. The public address still shows a different event; this card reads it again for up to two minutes.' }
  return { tone: 'muted', text: 'Accepted. The public address does not show it yet; this card reads it again for up to two minutes.' }
}

/** The automatic re-reads of the public address for one accepted publication. */
interface Polls { readonly id: string | null; readonly asked: number; readonly landed: number }
const freshPolls = (id: string | null): Polls => ({ id, asked: 0, landed: 0 })
const NO_POLLS = freshPolls(null)

/** Why nothing is offered, in plain words for the default view, and with its route for the details; null when Publish is offered. */
interface FactsLine { readonly plain: string; readonly detail: string | null }

/**
 * PUBLISH HER HEAD ON NOSTR. SIMPLE BY DEFAULT: the card opens on one sentence, her npub with
 * Copy, and one gold button; everything that becomes public, field by field, what stays private and the public address
 * are under ONE folded row, "See exactly what becomes public". The fold keeps them in the page: what it shows is exactly
 * what the press approves, whether or not it was opened. The press asks the passkey through the one Class 3 approval flow
 * (`approveClass3` on exactly this body) and sends the event to the node, which re-checks each fact and signs.
 *
 * WHAT IS APPROVED IS WHAT IS ON SCREEN (review MUST): Publish waits while a read of the facts is outstanding; the press
 * invalidates any read still out (its late answer is dropped); and while the publication runs, the card shows the event
 * it is approving, unchanged, whatever a later read says. The publication itself lives in nostr.ts, above this card.
 */
function HeadAnchor({ active, npub, pubkey, identityRows }: {
  readonly active: boolean
  readonly npub: string
  readonly pubkey: string | null
  /** The node identity's own rows (signing, relay), shown in the fold. */
  readonly identityRows: readonly (readonly [string, ReactNode])[]
}) {
  const [facts, setFacts] = useState<AnchorFactsRead | null>(null)
  const [published, setPublished] = useState<PublicHeadRead | null>(null)
  const [prepared, setPrepared] = useState<PreparedAnchor | null>(null)
  const [reading, setReading] = useState(false)
  const [note, setNote] = useState<Outcome | null>(null)
  const [round, setRound] = useState(0)
  const [publicRound, setPublicRound] = useState(0)
  const run = useSyncExternalStore(watchPublication, publicationRun, publicationRun)
  /** Every facts read (and every re-take of the time) has a number; only the latest may land, and a press bumps it. */
  const readSeq = useRef(0)
  const factsRead = useRef<AbortController | null>(null)
  const approval = useRef<AbortController | null>(null)
  /** The automatic re-reads of the public address for one accepted id: how many were asked, and how many have landed. */
  const [polls, setPolls] = useState<Polls>(NO_POLLS)
  const origin = originOf()
  // Closing the card cancels an approval still under way (then nothing is sent); an approved send is never cancelled here.
  useEffect(() => () => { approval.current?.abort() }, [])
  useEffect(() => { if (!active) approval.current?.abort() }, [active])
  useEffect(() => {
    if (!active || origin === null) return undefined
    const read = new AbortController()
    const seq = ++readSeq.current
    factsRead.current = read
    setReading(true)
    const current = () => !read.signal.aborted && seq === readSeq.current
    readAnchorFacts(read.signal).then(async (next) => {
      const nextPrepared = next.kind === 'live' ? await prepareAnchor(next.facts, origin) : null
      if (!current()) return
      setFacts(next)
      setPrepared(nextPrepared)
      setReading(false)
    }).catch(() => { if (current()) setReading(false) })
    return () => {
      read.abort()
      if (seq === readSeq.current) setReading(false)
    }
  }, [active, origin, round])
  const settledSeq = run?.phase === 'settled' ? run.seq : 0
  const busy = run !== null && run.phase !== 'settled'
  // THE CARD SHOWS THE EVENT BEING APPROVED until that publication settles; otherwise the latest read.
  const shown = busy ? run.prepared : prepared
  // The publication the public address is measured against (accepted, or not known).
  const settled = run?.phase === 'settled' ? run : null
  const approved = settled !== null && (settled.outcome.kind === 'published' || settled.outcome.kind === 'unclear') ? settled.prepared : null
  const approvedId = approved?.id ?? null
  const acceptedId = settled?.outcome.kind === 'published' ? settled.prepared.id : null
  const pollsNow = polls.id === acceptedId ? polls : freshPolls(acceptedId)
  useEffect(() => {
    if (!active || origin === null) return undefined
    const read = new AbortController()
    // A read counts as one of the automatic re-reads only once its answer has landed.
    const asked = pollsNow.asked
    const id = acceptedId
    const landed = (next: PublicHeadRead): void => {
      if (read.signal.aborted) return
      setPublished(next)
      if (id === null) return
      setPolls((now) => {
        const base = now.id === id ? now : freshPolls(id)
        return { ...base, landed: Math.max(base.landed, asked) }
      })
    }
    // A READ THAT FAILS IS AN UNREADABLE ANSWER, and it counts as one attempt: the card never keeps an earlier answer, or
    // "reading", in its place (review SHOULD). Only a read this card itself stopped is dropped.
    readPublicHead(read.signal).then(landed).catch((error: unknown) => {
      landed({ kind: 'unreadable', detail: `it could not be read (${error instanceof Error ? error.message : String(error)})` })
    })
    return () => { read.abort() }
  }, [active, origin, round, publicRound, settledSeq, acceptedId, pollsNow.asked])
  // SEEN means the address serves EXACTLY the approved event: its own fields hash to the approved id, and each equals the
  // approved one. The id string it carries is not enough.
  const match = approved === null || published === null ? null : servedMatch(published, approved)
  const seen = match?.kind === 'exact'
  /** Every automatic re-read has been asked and answered, and the address still does not serve it. */
  const spent = acceptedId !== null && !seen && pollsNow.landed >= ANCHOR_VISIBLE_POLLS
  // ACCEPTED BUT NOT SEEN YET: read the public address again, a bounded number of times, while the card is open. Another
  // event there, whatever its time, does not end the reads (review SHOULD: a later time is not "since then").
  useEffect(() => {
    if (!active || acceptedId === null || seen || pollsNow.asked >= ANCHOR_VISIBLE_POLLS) return undefined
    const timer = setTimeout(() => {
      setPolls((now) => {
        const base = now.id === acceptedId ? now : freshPolls(acceptedId)
        return { ...base, asked: base.asked + 1 }
      })
    }, ANCHOR_VISIBLE_POLL_MS)
    return () => { clearTimeout(timer) }
  }, [active, acceptedId, seen, pollsNow.asked, pollsNow.landed])
  // THE EVENT'S KEY MUST BE THIS CARD'S npub: computed here from the key the event carries, never taken on trust.
  const eventNpub = shown === null ? null : npubOf(shown.event.pubkey)
  const sameKey = shown !== null && eventNpub === npub && (pubkey === null || pubkey === shown.event.pubkey)
  const publish = async (): Promise<void> => {
    if (shown === null || !sameKey || busy || reading || origin === null) return
    // THE PRESS INVALIDATES EVERY READ STILL OUT: its answer, if it comes, is dropped; the event on screen is the one approved.
    readSeq.current += 1
    factsRead.current?.abort()
    setReading(false)
    setNote(null)
    // THE TIME IS PART OF WHAT BECOMES PUBLIC: an event prepared too long ago is prepared again and shown, not approved.
    if (Date.now() - shown.preparedAt > ANCHOR_PREPARED_LIFE_MS) {
      const seq = ++readSeq.current
      setReading(true)
      const again = await prepareAnchor(shown.facts, origin)
      if (seq !== readSeq.current) return
      setPrepared(again)
      setReading(false)
      // The time now sits in the closed fold, so the note itself says the new time and where the whole event is (review SHOULD).
      setNote({ tone: 'gold', text: `The time was taken again (now ${utcOf(again.event.created_at)}), because it is part of what becomes public. `
        + 'Open “See exactly what becomes public” to look at the event, then press again.' })
      return
    }
    const current = new AbortController()
    approval.current = current
    const outcome = await runPublication(shown, current.signal)
    if (approval.current === current) approval.current = null
    if (outcome === null) setNote({ tone: 'muted', text: 'A publication is already waiting for Touch ID or for the node.' })
  }
  const check = (): void => { setPublicRound(n => n + 1) }
  const factsLine: FactsLine | null = origin === null ? { plain: 'This page has no web origin to bind an approval to, so nothing is offered here.', detail: null }
    : facts === null ? { plain: 'Reading what the node would publish.', detail: null }
      : facts.kind === 'absent' ? { plain: 'This node does not yet tell this page what it would publish, so nothing is offered.',
        detail: `This node does not yet tell this page the four facts it checks an event against (GET ${ANCHOR_ROUTE}: `
          + `${facts.detail}), so the event cannot be built here and nothing is offered.` }
        : facts.kind === 'refused' ? { plain: `The node would not say what it would publish (${facts.code}); you may be signed out. Nothing is offered.`, detail: null }
          : facts.kind === 'unreadable' ? { plain: 'The node answered without the four facts in full, so nothing is offered.',
            detail: `${ANCHOR_ROUTE} answered without the four facts in full, so nothing is offered.` }
            : shown !== null && !sameKey ? { plain: 'The node names a different key for this event than the npub on this card, so nothing is offered.', detail: null }
              : null
  const publicUrl = origin === null ? PUBLIC_HEAD_ROUTE : `${origin}${PUBLIC_HEAD_ROUTE}`
  const nip05Url = origin === null ? NIP05_ROUTE : `${origin}${NIP05_ROUTE}`
  const nip05Name = origin === null ? null : `${NIP05_NAME}@${new URL(origin).host}`
  const now = published === null ? 'reading'
    : seen ? `serves the event you approved: ${servedWords(published)}`
      : match?.kind === 'false' && approvedId !== null ? falseIdWords(match, approvedId)
        : acceptedId !== null && published.kind === 'unreadable' ? `the node accepted the event you approved (id ${acceptedId}), but this card `
          + `could not read this address to check whether it serves it: ${published.detail}. ${spent ? 'This card has tried for two minutes; '
            + '“Check” reads it again.' : 'This card reads it again for up to two minutes.'}`
          : spent ? `the node accepted the event you approved (id ${acceptedId}), but this address has not served it after two minutes `
            + `of reading; it serves ${published.kind === 'none' ? 'nothing' : servedWords(published)}. “Check” reads it again.`
            : acceptedId !== null ? `the node accepted the event you approved (id ${acceptedId}), but this address does not show it yet; it shows`
              + `${match?.kind === 'other' ? ' a different event' : ''}: ${servedWords(published)}. A new event can take up to two minutes to appear `
              + 'here (the node and web caches each keep the last answer for up to a minute); this card reads it again.'
              : servedWords(published)
  const unsure = settled !== null && !seen && (settled.outcome.kind === 'unclear' || settled.outcome.kind === 'published')
  const full = runLine(run, seen)
  // The default view says one line; after an acceptance, the long sentence sits in the fold.
  const line = settled?.outcome.kind === 'published' ? acceptedLine(published, match, seen, spent) : full
  return (
    <div data-identity-anchor={facts?.kind ?? 'reading'} data-identity-anchor-run={run?.phase ?? 'none'}>
      {factsLine === null ? null : <p className="x6-identity__status" data-identity-anchor-line="">{factsLine.plain}</p>}
      {shown !== null && sameKey ? (
        <div className="x6-identity__actions">
          <button type="button" className="ak-action ak-tone-gold" disabled={busy || reading} data-identity-anchor-publish=""
            onClick={() => { void publish() }}>
            <IdentityIcon name="lock" />{run?.phase === 'approving' ? 'Waiting for Touch ID…' : run?.phase === 'finishing' ? 'Finishing the approval…'
              : run?.phase === 'sending' ? 'Sending to the node…' : 'Publish her head on Nostr'}
          </button>
        </div>
      ) : null}
      {shown !== null && sameKey && reading && !busy ? (
        <p className="x6-identity__status" data-identity-anchor-reading="">Reading what the node would publish again; Publish waits until it is read.</p>
      ) : null}
      <OutcomeLine outcome={note} />
      <div data-identity-anchor-result="">
        <OutcomeLine outcome={line} />
      </div>
      {unsure ? (
        <div className="x6-identity__actions">
          <button type="button" className="ak-action" data-identity-anchor-check="" onClick={check}>Check</button>
        </div>
      ) : null}
      {approved === null ? null : (
        <>
          <FieldTable rows={[['public address', <span key="a" className="x6-identity__mono" data-identity-anchor-address="">{publicUrl}</span>]]} />
          <div className="x6-identity__actions">
            <CardAction icon="copy" label="Copy address" run={() => copyText(publicUrl)} />
          </div>
        </>
      )}
      <PortalFold tone="blue" icon="general" title="See exactly what becomes public" data-identity-anchor-details="">
        <FieldTable rows={identityRows} />
        <FieldTable title="Publish her head on Nostr" rows={[
          ['what', 'one signed Nostr event (NIP-01), kind 30078: NIP-78 application data'],
          ['where', 'a public address on this node, read over HTTPS; this is not a relay, and nothing is sent to one'],
          ['replaces', 'the event is addressable (its d tag): a later publication replaces this one; only the latest is kept'],
        ]} />
        {factsLine === null || factsLine.detail === null ? null : <p className="x6-identity__status" data-identity-anchor-line-detail="">{factsLine.detail}</p>}
        {shown !== null && sameKey ? (
          <>
            <FieldTable title={busy ? 'Becomes public when you approve: the event you are approving' : 'Becomes public when you approve, exactly as written here'} rows={[
              ['epoch', <span key="e" className="x6-identity__mono" data-identity-anchor-epoch="">{String(shown.facts.epoch)}</span>],
              ['head id', <span key="h" className="x6-identity__mono" data-identity-anchor-head="">{shown.facts.headBallId}</span>],
              ['receipts chain head', <span key="r" className="x6-identity__mono" data-identity-anchor-receipts="">{shown.facts.receiptsLeafHash}</span>],
              ['time', <span key="t" className="x6-identity__mono" data-identity-anchor-time="">{`${utcOf(shown.event.created_at)} (created_at ${String(shown.event.created_at)})`}</span>],
              ['her npub', <span key="n" className="x6-identity__mono" data-identity-anchor-npub="">{eventNpub}</span>],
              ['key, hex', <span key="k" className="x6-identity__mono">{shown.event.pubkey}</span>],
              ['kind', '30078 (NIP-78 application data)'],
              ['tags', <code key="g" className="x6-identity__mono" data-identity-anchor-tags="">{JSON.stringify(shown.event.tags)}</code>],
              ['content', <code key="c" className="x6-identity__mono" data-identity-anchor-content="">{shown.event.content}</code>],
              ['signature', 'added by the node with its key, after your fingerprint; the event id is the NIP-01 hash of the fields above'],
            ]} />
            <FieldTable title="Stays private" rows={[
              ['never published', 'the node’s secret key; your Messages (turns, contacts, conversation names); her receipt rows; '
                + 'organ names; approval ids; passkey data; your email'],
            ]} />
            <Lead>
              {'What it shows: the holder of this npub says her head is this one, at this epoch, with this receipts chain head. '
                + 'It does not show that your fingerprint approved it (the passkey assertion is not published), and Nostr never '
                + 'decides which version of her is live.'}
            </Lead>
            <p className="x6-identity__status">Touch ID approves exactly this event, once. Nothing becomes public before that.</p>
            <div className="x6-identity__actions">
              <button type="button" className="ak-action" disabled={busy} data-identity-anchor-reread=""
                onClick={() => {
                  setNote(null)
                  // A run is forgotten once nothing more is waited for: not accepted, seen, or its reads spent.
                  if (acceptedId === null || seen || spent) forgetPublication()
                  setRound(n => n + 1)
                }}>
                Read again
              </button>
            </div>
          </>
        ) : null}
        {settled?.outcome.kind === 'published' ? <div data-identity-anchor-outcome=""><OutcomeLine outcome={full} /></div> : null}
        <FieldTable title="Public address" rows={[
          ['event', <span key="u" className="x6-identity__mono" data-identity-anchor-url="">{publicUrl}</span>],
          ['now', <span key="p" data-identity-anchor-published={published?.kind ?? 'reading'} data-identity-anchor-seen={seen ? 'yes' : 'no'}
            data-identity-anchor-match={match?.kind ?? 'none'}>{now}</span>],
          ['NIP-05', <span key="5" className="x6-identity__mono" data-identity-anchor-nip05="">
            {`${nip05Name ?? NIP05_NAME} → ${nip05Url} (served once something is published; NIP-05 maps a name to a key and proves nothing else)`}
          </span>],
          ['check it', 'anyone can fetch the event without signing in and verify its id and BIP-340 signature with any Nostr tool'],
        ]} />
      </PortalFold>
    </div>
  )
}

/** The one line for a key provisioning, from where it stands (kept above the card: closing Identity does not lose it). */
function provisionLine(run: ProvisionRun | null): Outcome | null {
  if (run === null) return null
  switch (run.phase) {
    case 'approving': return { tone: 'muted', text: 'Waiting for Touch ID to create this node’s npub.' }
    case 'finishing': return { tone: 'muted', text: 'Touch ID is done. The node is finishing the approval; nothing is sent until it has.' }
    case 'sending': return { tone: 'muted', text: 'Touch ID approved creating her key. The request is on its way to the node; this card waits for its answer.' }
    case 'settled': {
      const { outcome } = run
      return { tone: outcome.kind === 'provisioned' ? 'mint' : outcome.kind === 'unclear' ? 'gold' : 'red', text: provisionWords(outcome) }
    }
  }
}

/**
 * The node's Nostr identity: its npub when it has one, one plain press to make it when it has none. SIMPLE BY DEFAULT
 * One sentence, the npub or one button; the technical sentences are folded under "Details".
 */
function NostrPortal({ read, onReload, active }: { readonly read: NostrRead; readonly onReload: () => void; readonly active: boolean }) {
  const [note, setNote] = useState<Outcome | null>(null)
  const run = useSyncExternalStore(watchProvision, provisionRun, provisionRun)
  const controller = useRef<AbortController | null>(null)
  const pressing = useRef(false)
  const reload = useRef(onReload)
  useEffect(() => { reload.current = onReload })
  // Closing the card cancels an approval still under way (then nothing is sent); an approved request is never cancelled here.
  useEffect(() => () => { controller.current?.abort() }, [])
  useEffect(() => { if (!active) controller.current?.abort() }, [active])
  const busy = run !== null && run.phase !== 'settled'
  // Once the node may have made the key, read the card again (also when it is shown again after closing).
  const reloadAfter = run?.phase === 'settled' && (run.outcome.kind === 'provisioned' || run.outcome.kind === 'unclear') ? run.seq : 0
  useEffect(() => { if (reloadAfter !== 0) reload.current() }, [reloadAfter])
  // The key, read back and shown: the provisioning has nothing more to say. After an unclear answer too: the node did make
  // the key, and the npub on the card now says so (review SHOULD: "whether a key was made is not known" must not stay).
  const shownBack = read.kind === 'live' && run?.phase === 'settled' && (run.outcome.kind === 'provisioned' || run.outcome.kind === 'unclear')
  useEffect(() => { if (shownBack) forgetProvision() }, [shownBack])
  const none = read.kind === 'none'
  const [door, setDoor] = useState<'asking' | 'open' | 'closed'>('asking')
  useEffect(() => {
    if (!none) return undefined
    const probe = new AbortController()
    provisionAvailable(probe.signal).then((open) => { if (!probe.signal.aborted) setDoor(open ? 'open' : 'closed') }).catch(() => {})
    return () => { probe.abort() }
  }, [none])
  // MINTING HER PUBLIC KEY IS A CLASS 3 ACTION: the passkey approves exactly `{ action: 'nostr_provision' }`, once.
  const provision = async (): Promise<void> => {
    if (busy || pressing.current) return
    const origin = originOf()
    if (origin === null) { setNote({ tone: 'red', text: 'This page has no web origin to bind an approval to. Nothing was sent.' }); return }
    pressing.current = true
    setNote(null)
    const current = new AbortController()
    controller.current = current
    try {
      const outcome = await runProvision(await provisionTerms(origin), current.signal)
      if (outcome === null) setNote({ tone: 'muted', text: 'Creating her key is already waiting for Touch ID or for the node.' })
    } catch (error) {
      setNote({ tone: 'gold', text: `No clear answer (${error instanceof Error ? error.message : String(error)}); the card reads it again.` })
    } finally {
      pressing.current = false
      if (controller.current === current) controller.current = null
    }
  }
  const relay = read.kind === 'live' || read.kind === 'none' ? read.relay : null
  const summary = read.kind === 'live' ? read.npub : 'your npub for Messages'
  return (
    <PortalCell data-identity-portal="nostr">
      <PortalButton tone={read.kind === 'live' ? 'blue' : 'muted'} icon="identity" iconTone="blue" title="Nostr identity"
        summary={summary} badge={nostrPill(read)}>
        <div data-identity-nostr={read.kind}>
          {read.kind === 'reading' ? <Lead>Reading the host.</Lead> : null}
          {read.kind === 'live' ? (
            <>
              <Lead>Publish a signed public statement of her head. Nothing private.</Lead>
              <FieldTable rows={[['npub', <span key="n" className="x6-identity__mono" data-identity-npub="">{read.npub}</span>]]} />
              <div className="x6-identity__actions">
                <CardAction icon="copy" label="Copy npub" run={() => copyText(read.npub)} />
              </div>
              <HeadAnchor active={active} npub={read.npub} pubkey={read.pubkey} identityRows={[
                ['signing', read.signing ?? 'not reported'],
                ['relay', <span key="r" data-identity-relay="">{relayWords(read.relay, read.signing)}</span>],
              ]} />
            </>
          ) : null}
          {read.kind === 'none' ? (
            <>
              {door === 'open' ? (
                <>
                  <Lead>This node has no Nostr key yet: one key for this node; Touch ID approves it once.</Lead>
                  <div className="x6-identity__actions">
                    <button type="button" className="ak-action ak-tone-gold" disabled={busy} data-identity-provision="" onClick={() => { void provision() }}>
                      <IdentityIcon name="key" />{run?.phase === 'approving' ? 'Waiting for Touch ID…' : run?.phase === 'finishing' ? 'Finishing the approval…'
                        : run?.phase === 'sending' ? 'Creating her key…' : 'Create her Nostr key'}
                    </button>
                  </div>
                </>
              ) : null}
              {door === 'closed' ? (
                <p className="x6-identity__status" data-identity-provision-closed="">This host does not offer to create her Nostr key.</p>
              ) : null}
              {door === 'asking' ? <Lead>This node has no Nostr key yet.</Lead> : null}
            </>
          ) : null}
          {nostrUnread(read) === null ? null : <p className="x6-identity__status" data-identity-nostr-line="">{nostrUnread(read)}</p>}
          <OutcomeLine outcome={note} />
          {shownBack ? null : <OutcomeLine outcome={provisionLine(run)} />}
          {read.kind === 'none' ? (
            <PortalFold tone="muted" icon="general" title="Details" data-identity-nostr-details="">
              <p className="x6-identity__status">{`This node has no Nostr identity yet; ${relay?.connected === true ? 'a relay is connected' : 'no relay connected yet'}.`}</p>
              {door === 'open' ? (
                <>
                  <p className="x6-identity__status">{`One press asks ${PROVISION_ROUTE} for one BIP-340 key for this node; it is never retried.`}</p>
                  <p className="x6-identity__status" data-identity-provision-fingerprint="">
                    Touch ID approves exactly this request, once: the key becomes her npub, the one her head would be published under.
                  </p>
                </>
              ) : null}
              {door === 'closed' ? (
                <p className="x6-identity__status">{`This host does not serve ${PROVISION_ROUTE}, so it cannot create her key here.`}</p>
              ) : null}
            </PortalFold>
          ) : null}
        </div>
      </PortalButton>
    </PortalCell>
  )
}

/** The one line for an invite read with no numbers. */
function inviteUnread(read: InviteRead): string | null {
  switch (read.kind) {
    case 'reading': return 'Reading the host.'
    case 'absent': return `The AUMLOK status is not reachable on this host (${read.detail}), so no quota is shown.`
    case 'refused': return `This host refused its AUMLOK status (${read.code}), so no quota is shown.`
    case 'unreadable': return 'This host’s AUMLOK status is not the expected shape, so no quota is shown.'
    case 'unbound': return 'This node is not bound with AUMLOK yet, so it cannot vouch and no quota is shown.'
    case 'missing': return 'This host’s AUMLOK status does not report the invite quota, so no quota is shown.'
    default: return null
  }
}

/** The AUMLOK screen's own tile labels, in English (this screen's language). */
const aumlokText = (key: AumlokKey): string => aumlokEnglish[key]

/** Seven empty word tiles. */
const emptyWords = (): string[] => Array.from({ length: 7 }, () => '')

/** What the typed words are, before anything is asked. */
type WordsState = 'empty' | 'invalid' | 'checking' | 'ready'

function wordsLine(state: WordsState): string {
  switch (state) {
    case 'empty': return 'Type the seven words you use now, one in each tile. They are never shown back, kept or sent.'
    case 'invalid': return 'These seven words are not a phrase from the AUMLOK lists. Check them; nothing was sent.'
    case 'checking': return 'Checking your words…'
    case 'ready': return 'Your words are ready. Nothing has been sent yet.'
  }
}

/** An issue, or the revocation of one receipt this browser holds. */
type InviteMode = { readonly kind: 'issue' } | { readonly kind: 'revoke'; readonly receipt: InviteReceipt }
/** The open panel: typing the words, tap 1 running, the root open (tap 2 offered), or tap 2 running. */
interface InvitePanelState {
  readonly mode: InviteMode
  readonly step: 'words' | 'opening' | 'open' | 'signing'
  /** The fresh status read the panel started from (once the root is open, the one read just after the unseal). */
  readonly read: InviteStatus
}
/** What the host confirmed. The invite code is held here only until "Done" or the screen closes. */
type InviteResult =
  | { readonly kind: 'issued'; readonly receipt: InviteReceipt; readonly limit: number; readonly code: string }
  | { readonly kind: 'revoked'; readonly revocation: SignedRevocation }
interface InviteReadiness { readonly issue: string | null; readonly revoke: string | null }
/** What tap 1 needs from the words: the canonical phrase (it opens the root here) and its commitment for this node. */
interface PreparedWords { readonly canonical: string; readonly nodePubkeyHex: string; readonly commitment: string }

const OPEN_LABEL = 'Open with Touch ID'
const SIGN_LABEL = 'Sign invite with Touch ID'
const REVOKE_LABEL = 'Revoke with Touch ID'

/** Why the desk's own status read gives nothing to act on. */
function deskUnread(read: InviteStatusRead | null): string {
  if (read === null) return 'This host’s AUMLOK status could not be read just now, so nothing is asked.'
  switch (read.kind) {
    case 'absent': return `The AUMLOK status is not reachable on this host (${read.detail}), so nothing is asked.`
    case 'refused': return `This host refused its AUMLOK status (${read.code}), so nothing is asked.`
    case 'unreadable': return 'This host’s AUMLOK status is not the expected shape, so nothing is asked.'
    case 'live': return 'This host’s AUMLOK status was read.'
  }
}

/** Touch ID did not complete once: the same request may be tapped once more (Safari may refuse a sheet it was not tapped for). */
const tapAgainWords = (label: string, message: string): string =>
  'Touch ID did not complete: cancelled, timed out, or the browser would not open it. Nothing was sent past the request. '
  + `Tap “${label}” once more. (${message})`

/** How a tap that ended the flow ended, in words. Nothing here ever says "issued" or "revoked": only a result does. */
function endedWords(step: Exclude<InviteStep<unknown>, { readonly kind: 'done' }>, revoking: boolean): Outcome {
  switch (step.kind) {
    case 'passkey': return { tone: 'red', text: 'Touch ID did not complete again. Nothing was sent past the request, and the panel is '
      + `closed. Start again when you are ready. (${step.message})` }
    case 'refused': return { tone: 'red', text: `${inviteRefusalWords(step.code, step.retryAfterSeconds)} (${step.code})` }
    case 'unknown': return { tone: 'red', text: 'The node did not answer the last step, even when asked again, so this page cannot tell '
      + `whether ${revoking ? 'the invite was revoked' : 'an invite was issued'}. No receipt is shown and nothing new was started. `
      + (revoking ? 'Check the revoked count above before you revoke again.' : 'Check the count above before you invite again.')
      + ` (${step.code})` }
  }
}

/**
 * THE INVITE DESK: one issue or one revocation at a time, from this page, with the seven words and two Touch ID taps
 * (`invite.ts` names every call). The words live only in the tiles until tap 1 takes them; the node's signing key lives
 * only in a ref, from the unseal until the action ends, the panel or the screen closes, or two minutes pass.
 * @param active - whether the Identity screen is open.
 * @param open - whether the "Human vouching" card is open.
 * @param onReload - read the card's count again.
 * @returns the desk's state and its actions.
 */
function useInviteDesk(active: boolean, open: boolean, onReload: () => void) {
  const [round, setRound] = useState(0)
  const [readiness, setReadiness] = useState<InviteReadiness | null>(null)
  const [book, setBook] = useState<InviteBook>(() => readInviteBook())
  /** What the host's own invite list gave (null until read, or when the node key was not read). */
  const [hostList, setHostList] = useState<HostInvitesRead | null>(null)
  const [checks, setChecks] = useState<Readonly<Record<string, boolean>>>({})
  const [panel, setPanel] = useState<InvitePanelState | null>(null)
  const [typed, setTyped] = useState<readonly string[]>(emptyWords)
  const [words, setWords] = useState<WordsState>('empty')
  const [domain, setDomain] = useState('')
  const [busy, setBusy] = useState(false)
  const [tapAgain, setTapAgain] = useState<1 | 2 | null>(null)
  const [notice, setNotice] = useState<Outcome | null>(null)
  const [result, setResult] = useState<InviteResult | null>(null)
  const busyRef = useRef(false)
  const generation = useRef(0)
  const controller = useRef(new AbortController())
  const prepared = useRef<PreparedWords | null>(null)
  /** What tap 1 took from the tiles, kept only until its unseal settles (for one more tap after Touch ID did not complete). */
  const held = useRef<PreparedWords | null>(null)
  const key = useRef<{ readonly node: AumlokNode; readonly timer: ReturnType<typeof setTimeout> } | null>(null)
  const requests = useRef<{ tap1: string | null; tap2: string | null }>({ tap1: null, tap2: null })
  /** When tap 1's request was first sent; its challenge lives `INVITE_CHALLENGE_LIFE_MS` from then. */
  const tapOneAt = useRef(0)
  /** Ends a "tap once more" wait when tap 1's challenge expires, so its request id is never posted after that. */
  const tapOneExpiry = useRef<ReturnType<typeof setTimeout> | null>(null)
  const invitee = useRef<InviteeCode | null>(null)
  const chosenDomain = useRef<string | null>(null)
  const approval = useRef<string | null>(null)
  const working = (value: boolean): void => { busyRef.current = value; setBusy(value) }

  /** Everything the flow holds outside React state goes here: the key, the words, the code, the requests, the approval. */
  const release = useCallback((): void => {
    generation.current += 1
    controller.current.abort()
    controller.current = new AbortController()
    if (key.current !== null) clearTimeout(key.current.timer)
    key.current = null
    if (tapOneExpiry.current !== null) clearTimeout(tapOneExpiry.current)
    tapOneExpiry.current = null
    prepared.current = null
    held.current = null
    invitee.current = null
    chosenDomain.current = null
    requests.current = { tap1: null, tap2: null }
    if (approval.current !== null) endApproval(approval.current)
    approval.current = null
  }, [])
  const endFlow = useCallback((): void => {
    release()
    busyRef.current = false
    setBusy(false)
    setPanel(null)
    setTyped(emptyWords())
    setWords('empty')
    setDomain('')
    setTapAgain(null)
    // A notice about the flow goes with it ("Waiting for Touch ID…" must not outlive a Close); endWith sets its own after.
    setNotice(null)
  }, [release])
  const endWith = (outcome: Outcome): void => {
    endFlow()
    setNotice(outcome)
    setRound(value => value + 1)
    onReload()
  }

  // CLOSING THE CARD OR THE SCREEN ENDS THE FLOW: the key is dropped, the words leave, and the approval is released.
  useEffect(() => { if (!open || !active) endFlow() }, [open, active, endFlow])
  // The invite code goes with the screen: once it closes, this page holds the code nowhere.
  useEffect(() => { if (!active) { setResult(null); setNotice(null) } }, [active])
  useEffect(() => () => { release() }, [release])

  // THE DESK'S OWN READ, each time the card opens and after each action: a GET, which the host counts nothing for.
  useEffect(() => {
    if (!active || !open) return undefined
    const reading = new AbortController()
    const stale = (): boolean => reading.signal.aborted
    setReadiness(null)
    void (async () => {
      const read = await readInviteStatus(reading.signal).catch(() => null)
      if (stale()) return
      let kept = readInviteBook()
      setBook(kept)
      if (read?.kind !== 'live') {
        setChecks({})
        setReadiness({ issue: deskUnread(read), revoke: deskUnread(read) })
        return
      }
      const node = read.value.status.nodePubkeyHex
      // THE HOST'S OWN LIST, when it serves one: every invite this node signed, on any device, lands in this browser's
      // book once its signature verifies. A host without the list leaves the book as this browser made it.
      const listed = node === null ? null : await syncHostInvites(node, reading.signal).catch(() => null)
      if (stale()) return
      setHostList(listed)
      if (listed?.kind === 'live') { kept = readInviteBook(); setBook(kept) }
      const verify = async (receipt: InviteReceipt) =>
        [receipt.inviteId, node !== null && await verifyInviteReceipt(receipt, node)] as const
      const [issue, revoke, verified] = await Promise.all([inviteReadiness(read.value, 'issue'), inviteReadiness(read.value, 'revoke'),
        Promise.all(kept.receipts.map(verify))])
      if (stale()) return
      setChecks(Object.fromEntries(verified))
      setReadiness({ issue, revoke })
    })()
    return () => { reading.abort() }
  }, [active, open, round])

  // THE WORDS' COMMITMENT IS WORKED OUT BEFORE TAP 1 (600 000 PBKDF2 iterations), so the tap itself asks only for its
  // challenge: Safari opens a passkey sheet only inside the tap that asked for it.
  const step = panel?.step ?? null
  const startedFrom = panel?.read ?? null
  useEffect(() => {
    prepared.current = null
    if (step !== 'words' || startedFrom === null) return undefined
    const parsed = parseAumlokPhrase(typed)
    if (!parsed.ok) {
      setWords(typed.some(word => word.trim() === '') ? 'empty' : 'invalid')
      return undefined
    }
    const nodePubkeyHex = startedFrom.status.nodePubkeyHex
    if (nodePubkeyHex === null) return undefined
    let current = true
    setWords('checking')
    aumlokCommitment(parsed.canonical, nodePubkeyHex).then((commitment) => {
      if (!current) return
      prepared.current = { canonical: parsed.canonical, nodePubkeyHex, commitment }
      setWords('ready')
    }, () => { if (current) setWords('invalid') })
    return () => { current = false }
  }, [typed, step, startedFrom])

  /** Open the panel, after a fresh status read says nothing stands in the way. Nothing is asked of the host but a GET. */
  const start = (mode: InviteMode): void => {
    if (busyRef.current || panel !== null) return
    working(true)
    setResult(null)
    setNotice({ tone: 'muted', text: 'Reading this node’s AUMLOK status.' })
    const mine = generation.current
    const signal = controller.current.signal
    void (async () => {
      const read = await readInviteStatus(signal).catch(() => null)
      if (mine !== generation.current) return
      if (read?.kind !== 'live') { working(false); setNotice({ tone: 'red', text: deskUnread(read) }); return }
      const blocked = await inviteReadiness(read.value, mode.kind === 'issue' ? 'issue' : 'revoke')
      if (mine !== generation.current) return
      if (blocked !== null) { working(false); setNotice({ tone: 'red', text: blocked }); setRound(value => value + 1); return }
      if (mode.kind === 'revoke') {
        // THE STORED RECEIPT IS CHECKED AGAINST THE NODE KEY READ JUST NOW, and a revocation this browser holds is final.
        const kept = readInviteBook()
        const valid = await verifyInviteReceipt(mode.receipt, read.value.status.nodePubkeyHex ?? '')
        if (mine !== generation.current) return
        if (kept.revocations.some(item => item.inviteId === mode.receipt.inviteId) || !valid) {
          working(false)
          setNotice({ tone: 'red', text: valid ? 'This browser already revoked that invite; nothing was asked.'
            : 'That receipt does not verify against this node’s key, so it is not revoked from here and nothing was asked.' })
          setRound(value => value + 1)
          return
        }
      } else {
        invitee.current = await newInviteeCode()
        if (mine !== generation.current) return
      }
      setTyped(emptyWords())
      setWords('empty')
      setDomain('')
      setTapAgain(null)
      setPanel({ mode, step: 'words', read: read.value })
      setNotice(null)
      working(false)
    })()
  }

  /** Hold the node's signing key for at most two minutes; a tap 2 that finds it gone signs nothing. */
  const holdKey = (node: AumlokNode): void => {
    if (key.current !== null) clearTimeout(key.current.timer)
    const timer = setTimeout(() => {
      key.current = null
      if (!busyRef.current) endWith({ tone: 'gold', text: inviteRefusalWords('invite:root-closed') })
    }, INVITE_KEY_HOLD_MS)
    key.current = { node, timer }
  }

  /** TAP 1, "Open with Touch ID": the unseal challenge, the passkey, the unseal, and the root opened here and zeroed. */
  const tapOne = (): void => {
    if (busyRef.current || panel?.step !== 'words') return
    const again = tapAgain === 1
    const taken = again ? held.current : prepared.current
    const status = panel.read.status
    const domainRead = panel.mode.kind === 'issue' ? normaliseInviteDomain(domain) : { ok: true as const, value: null }
    if (taken?.nodePubkeyHex !== status.nodePubkeyHex || !domainRead.ok) return
    const approvalKey = panel.mode.kind === 'issue' ? INVITE_ISSUE_APPROVAL : inviteRevokeApproval(panel.mode.receipt.inviteId)
    if (approval.current === null) {
      if (!beginApproval(approvalKey)) {
        setNotice({ tone: 'gold', text: 'Another invite is being signed on this page. Finish or close it first; nothing was asked.' })
        return
      }
      approval.current = approvalKey
    }
    // THE WORDS LEAVE THE TILES HERE. Only this tap (and, for one more tap, `held`) keeps them, until the unseal settles.
    held.current = taken
    prepared.current = null
    if (!again) chosenDomain.current = domainRead.value
    setTyped(emptyWords())
    setWords('empty')
    if (requests.current.tap1 === null) tapOneAt.current = Date.now()
    const requestId = requests.current.tap1 ?? aumlokRequestId()
    requests.current.tap1 = requestId
    if (tapOneExpiry.current !== null) clearTimeout(tapOneExpiry.current)
    tapOneExpiry.current = null
    working(true)
    setTapAgain(null)
    setNotice({ tone: 'muted', text: 'Waiting for Touch ID to open your root.' })
    setPanel({ ...panel, step: 'opening' })
    const mine = generation.current
    const signal = controller.current.signal
    void openNodeForInvite(taken.canonical, taken.commitment, status, requestId, { signal }).then(async (opened) => {
      if (mine !== generation.current) return
      if (opened.kind === 'passkey' && !again) {
        setPanel({ ...panel, step: 'words' })
        setTapAgain(1)
        setNotice({ tone: 'gold', text: tapAgainWords(OPEN_LABEL, opened.message) })
        working(false)
        // ONE MORE TAP ONLY WHILE ITS CHALLENGE LIVES: then the held words and the request id go and the flow ends, so an
        // expired request is never posted (the host would count its refusal toward the lockout).
        tapOneExpiry.current = setTimeout(() => {
          tapOneExpiry.current = null
          if (mine === generation.current && !busyRef.current) endWith({ tone: 'gold', text: inviteRefusalWords('invite:tap-expired') })
        }, Math.max(0, tapOneAt.current + INVITE_CHALLENGE_LIFE_MS - INVITE_TAP_AGAIN_MARGIN_MS - Date.now()))
        return
      }
      held.current = null
      requests.current.tap1 = null
      if (opened.kind !== 'done') { endWith(endedWords(opened, panel.mode.kind === 'revoke')); return }
      holdKey(opened.value)
      // A FRESH STATUS AFTER THE UNSEAL (a GET): tap 2 is offered only while the quota and the node key still allow it.
      const fresh = await readInviteStatus(signal).catch(() => null)
      if (mine !== generation.current) return
      const blocked = fresh?.kind !== 'live' ? deskUnread(fresh)
        : fresh.value.status.nodePubkeyHex === opened.value.nodePubkeyHex
          ? await inviteReadiness(fresh.value, panel.mode.kind === 'issue' ? 'issue' : 'revoke')
          : 'This node’s key changed after your root was opened, so nothing is asked.'
      if (mine !== generation.current) return
      if (blocked !== null || fresh?.kind !== 'live') { endWith({ tone: 'red', text: blocked ?? deskUnread(fresh) }); return }
      setPanel({ mode: panel.mode, step: 'open', read: fresh.value })
      setNotice({ tone: 'mint', text: 'Your root is open on this page for up to two minutes. Nothing is signed until you tap again.' })
      working(false)
    })
  }

  /** TAP 2, "Sign invite with Touch ID" or "Revoke with Touch ID": the invite challenge, its echo, the passkey, the signature. */
  const tapTwo = (): void => {
    if (busyRef.current || panel?.step !== 'open') return
    const again = tapAgain === 2
    const signer = (): CryptoKey | null => key.current?.node.signingKey ?? null
    if (signer() === null) { endWith({ tone: 'gold', text: inviteRefusalWords('invite:root-closed') }); return }
    const requestId = requests.current.tap2 ?? aumlokRequestId()
    requests.current.tap2 = requestId
    working(true)
    setTapAgain(null)
    setNotice({ tone: 'muted', text: 'Waiting for Touch ID to sign.' })
    setPanel({ ...panel, step: 'signing' })
    const mine = generation.current
    const deps = { signal: controller.current.signal }
    const { mode, read } = panel
    /** True when this tap is over without ending the flow: closed meanwhile, or one more tap is allowed. */
    const continues = (ended: InviteStep<unknown>): boolean => {
      if (mine !== generation.current) {
        // Closed while the last step was out: what the host confirmed is still in this browser's book, and it is said.
        setBook(readInviteBook())
        if (ended.kind === 'done') {
          setNotice({ tone: 'gold', text: mode.kind === 'issue'
            ? 'The node confirmed an invite after this panel was closed. Its invite code cannot be shown, so that invite cannot '
              + 'be given to anyone; it is listed below. Revoking it does not give this month’s invite back.'
            : 'The node confirmed the revocation after this panel was closed; it is listed below.' })
          setRound(value => value + 1)
        } else if (ended.kind === 'unknown') setNotice(endedWords(ended, mode.kind === 'revoke'))
        onReload()
        return true
      }
      if (ended.kind !== 'passkey' || again || key.current === null) return false
      setPanel({ ...panel, step: 'open' })
      setTapAgain(2)
      setNotice({ tone: 'gold', text: tapAgainWords(mode.kind === 'issue' ? SIGN_LABEL : REVOKE_LABEL, ended.message) })
      working(false)
      return true
    }
    if (mode.kind === 'issue') {
      const code = invitee.current
      if (code === null) { endWith({ tone: 'red', text: inviteRefusalWords('invite:not-ready') }); return }
      void issueInvite({ requestId, inviteeCommitmentSha256: code.commitmentSha256, assignedDomainPointer: chosenDomain.current },
        signer, read, deps).then((issued) => {
        if (continues(issued)) return
        if (issued.kind !== 'done') { endWith(endedWords(issued, false)); return }
        endWith({ tone: 'mint', text: 'The node confirmed this invite.' })
        setResult({ kind: 'issued', receipt: issued.value, limit: read.quota?.limit ?? issued.value.monthlySequence, code: code.code })
      })
      return
    }
    void revokeInvite({ requestId, inviteId: mode.receipt.inviteId }, signer, read, deps).then((revoked) => {
      if (continues(revoked)) return
      if (revoked.kind !== 'done') { endWith(endedWords(revoked, true)); return }
      endWith({ tone: 'mint', text: 'The node confirmed this revocation.' })
      setResult({ kind: 'revoked', revocation: revoked.value })
    })
  }

  const onType = (position: number, value: string): void => {
    setTyped(current => current.map((word, index) => (index === position ? value : word)))
  }
  return {
    readiness, book, hostList, checks, panel, typed, words, domain, busy, tapAgain, notice, result,
    start, tapOne, tapTwo, onType, setDomain, close: endFlow, dismiss: () => { setResult(null); setNotice(null) },
  }
}
type InviteDesk = ReturnType<typeof useInviteDesk>

/** The confirmed invite: the line, the check, the receipt (copy and QR), and the invite code shown this once. */
function IssuedResult({ receipt, limit, code, onDone }: {
  readonly receipt: InviteReceipt
  readonly limit: number
  readonly code: string
  readonly onDone: () => void
}) {
  const json = receiptJson(receipt)
  // THE QR CARRIES THE PUBLIC RECEIPT ONLY, never the invite code.
  const qr = useMemo(() => {
    try { return qrSvgDataUrl(json, 'Q') } catch { return null }
  }, [json])
  return (
    <div data-identity-invite-receipt={receipt.inviteId}>
      <p className="x6-identity__status" data-tone="mint" data-identity-invite-line="">{receiptLine(receipt, limit)}</p>
      <p className="x6-identity__status" data-identity-invite-verified="">
        The node confirmed this invite, and this page checked the node’s Ed25519 signature on it against this node’s key: it verifies.
        Its revoked field is always false; a revocation is its own signed record.
      </p>
      {qr ? (
        <div className={css.identityQrHalo} data-ready="">
          <div className={css.identityQr} data-identity-invite-qr="">
            <img src={qr} alt="QR code of the signed invite receipt (public; it does not carry the invite code)" draggable={false} />
          </div>
        </div>
      ) : <p className="x6-identity__status" data-identity-invite-qr-missing="">This receipt is too long for one QR code; copy it instead.</p>}
      <div className={css.identityActions}>
        <CardAction icon="copy" label="Copy receipt" run={() => copyText(json)} />
        <CardAction icon="copy" label="Copy invite link" run={() => copyText(inviteShareLink(receipt))} />
      </div>
      {/* THE INVITE CODE, ONCE. It is a secret for the person invited: marked private, so the page's eyes never read it. */}
      <div data-identity-invite-code="" data-private="">
        <p className="x6-identity__status">Invite code</p>
        <code className="x6-identity__mono" data-identity-invite-code-value="">{code}</code>
        <p className={css.warning}>Give this code to the person privately. It is not in the receipt and this page does not keep it.</p>
        <div className={css.identityActions}>
          <CardAction icon="key" label="Copy invite code" run={() => copyText(code)} />
        </div>
      </div>
      <div className="x6-identity__actions">
        <button type="button" className="ak-action ak-tone-violet" data-identity-invite-done="" onClick={onDone}>Done</button>
      </div>
    </div>
  )
}

/** The confirmed revocation: the line, the check, and its signed record to copy. */
function RevokedResult({ revocation, onDone }: { readonly revocation: SignedRevocation; readonly onDone: () => void }) {
  return (
    <div data-identity-invite-revocation={revocation.inviteId}>
      <p className="x6-identity__status" data-tone="mint" data-identity-invite-line="">{revocationLine(revocation)}</p>
      <p className="x6-identity__status" data-identity-invite-verified="">
        The node confirmed this revocation, and this page checked the node’s Ed25519 signature on it against this node’s key: it
        verifies. Revoking does not give this month’s invite back.
      </p>
      <div className={css.identityActions}>
        <CardAction icon="copy" label="Copy revocation" run={() => copyText(canonicalJson(revocation))} />
      </div>
      <div className="x6-identity__actions">
        <button type="button" className="ak-action ak-tone-violet" data-identity-invite-done="" onClick={onDone}>Done</button>
      </div>
    </div>
  )
}

/** The open panel: "Their address" and the seven tiles before tap 1, then tap 2 while the root is open. */
function InvitePanel({ desk }: { readonly desk: InviteDesk }) {
  const domainId = useId()
  const { panel, typed, words, domain, busy, tapAgain } = desk
  if (panel === null) return null
  const issue = panel.mode.kind === 'issue'
  const domainRead = normaliseInviteDomain(domain)
  const before = panel.step === 'words' || panel.step === 'opening'
  return (
    <div data-identity-invite-panel={panel.mode.kind} data-identity-invite-step={panel.step}>
      {panel.mode.kind === 'revoke' ? (
        <p className="x6-identity__status" data-identity-invite-revoking="">
          {`Revoking: ${receiptLine(panel.mode.receipt, panel.read.quota?.limit ?? panel.mode.receipt.monthlySequence)}. `
            + 'Revoking does not give this month’s invite back.'}
        </p>
      ) : null}
      {before ? (
        <>
          {issue ? (
            <div className={css.handleField}>
              <label className={css.handleLabel} htmlFor={domainId}>Their address (optional)</label>
              <input id={domainId} className={css.handleInput} data-identity-invite-domain="" value={domain}
                disabled={panel.step !== 'words' || tapAgain === 1} placeholder="https://their-name.example"
                onChange={(event) => { desk.setDomain(event.target.value) }} autoComplete="off" autoCapitalize="none" spellCheck={false} />
              <p className={css.handleHint} data-identity-invite-domain-hint="">
                {!domainRead.ok ? 'That is not an https address the node takes (an origin like https://name.example: no path, no port). '
                  + 'Nothing is asked until it is.'
                  : domainRead.value === null ? 'No address yet: the invite will say so.' : `The invite will carry ${domainRead.value}.`}
              </p>
            </div>
          ) : null}
          {tapAgain === 1 ? null : <AumlokWordInput typed={typed} onType={desk.onType} t={aumlokText} />}
          <p className={css.warning} data-identity-invite-warning="">Wrong words count against a lifetime limit. Check them before you tap.</p>
          {tapAgain === 1 ? null : <p className="x6-identity__status" data-identity-invite-words={words}>{wordsLine(words)}</p>}
          <div className="x6-identity__actions">
            <button type="button" className="ak-action ak-tone-gold" data-identity-invite-open=""
              disabled={busy || (words !== 'ready' && tapAgain !== 1) || (issue && !domainRead.ok)} onClick={desk.tapOne}>
              <IdentityIcon name="lock" />{panel.step === 'opening' ? 'Waiting for Touch ID…' : OPEN_LABEL}
            </button>
            {/* Close waits while Touch ID is open: the tap is already out and its answer is what ends it. */}
            <button type="button" className="ak-action ak-tone-muted" data-identity-invite-close="" disabled={panel.step === 'opening'}
              onClick={desk.close}>Close</button>
          </div>
        </>
      ) : (
        <>
          <p className="x6-identity__status" data-identity-invite-ready="">
            {issue ? 'Your root is open. Tap once more: Touch ID confirms, and this node’s key signs one invite this page built and checked.'
              : 'Your root is open. Tap once more: Touch ID confirms, and this node’s key signs the revocation this page checked.'}
          </p>
          <div className="x6-identity__actions">
            <button type="button" className="ak-action ak-tone-gold" data-identity-invite-sign="" disabled={busy || panel.step !== 'open'}
              onClick={desk.tapTwo}>
              <IdentityIcon name="key" />{panel.step === 'signing' ? 'Waiting for Touch ID…' : issue ? SIGN_LABEL : REVOKE_LABEL}
            </button>
            {/* Close waits while signing: once Touch ID returns, the last step goes out and the host may record it. */}
            <button type="button" className="ak-action ak-tone-muted" data-identity-invite-close="" disabled={panel.step === 'signing'}
              onClick={desk.close}>Close</button>
          </div>
        </>
      )}
    </div>
  )
}

/**
 * The receipts this browser issued (the node lists none), each checked against the node key read when the card opened.
 * Revoke is offered only for one that verifies and that this browser has not revoked, and not while a result is on the
 * screen (its invite code is shown only once, and starting anything new would clear it).
 */
function IssuedList({ desk, limit }: { readonly desk: InviteDesk; readonly limit: number }) {
  const { book, hostList, checks, readiness, panel, busy, result } = desk
  if (book.receipts.length === 0) return null
  const source = hostList?.kind === 'live'
    ? `Invites this node signed, from the node's own list${hostList.dropped > 0 ? ` (${String(hostList.dropped)} listed records did not verify and are not shown)` : ''}:`
    : 'Invites this browser issued (kept in this browser only; the node lists none):'
  const revokeBlocked = readiness === null ? 'Checking this node before anything is offered…' : readiness.revoke
  return (
    <div data-identity-invite-issued="">
      <p className="x6-identity__status" data-identity-invite-source={hostList?.kind === 'live' ? 'host' : 'browser'}>{source}</p>
      <RecordList>
        {[...book.receipts].reverse().map((receipt) => {
          const revocation = book.revocations.find(item => item.inviteId === receipt.inviteId) ?? null
          const check = checks[receipt.inviteId]
          const state = revocation !== null ? 'revoked' : check === undefined ? 'checking' : check ? 'verifies' : 'fails'
          // ONLY A RECEIPT THAT VERIFIES IS SAID TO BE SIGNED BY THIS NODE'S KEY: one that fails, or is not checked yet, is
          // named by its invite id and month alone.
          const line = revocation !== null ? revocationLine(revocation) : state === 'verifies' ? receiptLine(receipt, limit)
            : `Invite ${receipt.inviteId.slice(0, 12)}… for ${receipt.quotaMonth}`
          return (
            <RecordRow key={receipt.inviteId} tone={state === 'fails' ? 'red' : state === 'revoked' ? 'muted' : 'violet'} rowTitle={line}
              title={<span data-identity-invite-row={receipt.inviteId} data-state={state}>
                {`Invite ${String(receipt.monthlySequence)} for ${receipt.quotaMonth} · ${receipt.inviteId.slice(0, 12)}…`}</span>}
              summary={state === 'fails' ? 'Its signature does not verify against this node’s key, so it is not offered for revoking.' : line}
              status={<StatusPill tone={state === 'fails' ? 'red' : state === 'revoked' ? 'muted' : 'mint'}>
                {state === 'revoked' ? 'REVOKED HERE' : state === 'checking' ? 'CHECKING' : state === 'fails' ? 'DOES NOT VERIFY' : 'SIGNED'}
              </StatusPill>}
              end={state === 'verifies' ? (
                <button type="button" className="ak-action ak-tone-red" data-identity-invite-revoke={receipt.inviteId}
                  disabled={busy || panel !== null || result !== null || revokeBlocked !== null}
                  onClick={() => { desk.start({ kind: 'revoke', receipt }) }}>
                  Revoke
                </button>
              ) : undefined} />
          )
        })}
      </RecordList>
      {revokeBlocked !== null && Object.values(checks).some(Boolean) && panel === null
        ? <p className="x6-identity__status" data-identity-invite-revoke-blocked="">{revokeBlocked}</p> : null}
    </div>
  )
}

/** Human vouching: the monthly aukora.invite.v1 quota from the host's own fields, and the desk that issues and revokes. */
function InvitePortal({ read, active, onReload }: { readonly read: InviteRead; readonly active: boolean; readonly onReload: () => void }) {
  const live = read.kind === 'live'
  const [open, setOpen] = useState(false)
  const desk = useInviteDesk(active, open, onReload)
  const issueBlocked = desk.readiness === null ? 'Checking this node and this browser before anything is offered…' : desk.readiness.issue
  return (
    <PortalCell data-identity-portal="invite">
      <PortalButton tone={live ? 'violet' : 'muted'} icon="aumlok" iconTone="violet" title="Human vouching"
        summary={live ? `${String(read.remaining)} of ${String(read.limit)} remaining in ${read.month}` : `${AUMLOK_STATUS_ROUTE} · ${INVITE_SCHEMA}`}
        badge={live ? LIVE : read.kind === 'reading' ? <StatusPill tone="muted">READING</StatusPill> : NOT_CONNECTED(inviteUnread(read) ?? '')}
        onToggle={setOpen}>
        <div data-identity-invite={read.kind}>
          {live ? (
            <>
              <p className="x6-identity__status" data-identity-invite-count="">
                {`${String(read.remaining)} of ${String(read.limit)} remaining in ${read.month} · ${INVITE_SCHEMA}`}
              </p>
              {read.revoked !== null && read.revoked > 0
                ? <p className="x6-identity__status" data-identity-invite-revoked="">{`${String(read.revoked)} revoked in total (revoking does not restore this month’s quota)`}</p> : null}
              <Lead>
                An invite is signed by this node&apos;s key: your seven words open it here, and Touch ID confirms each of the two steps. It
                lasts 7 days. Revoking one does not give this month&apos;s invite back.
              </Lead>
            </>
          ) : <p className="x6-identity__status">{inviteUnread(read)}</p>}
          {/* WHAT THE HOST CONFIRMED, AND THE FLOW ITSELF, DO NOT DEPEND ON THE CARD'S COUNT: a failed re-read of the count
              right after a confirmed invite must never hide its invite code, which is shown only this once. */}
          {desk.result?.kind === 'issued' ? (
            <IssuedResult receipt={desk.result.receipt} limit={desk.result.limit} code={desk.result.code} onDone={desk.dismiss} />
          ) : null}
          {desk.result?.kind === 'revoked' ? <RevokedResult revocation={desk.result.revocation} onDone={desk.dismiss} /> : null}
          {live && desk.panel === null && desk.result === null ? (
            <>
              <div className="x6-identity__actions">
                <button type="button" className="ak-action ak-tone-violet" data-identity-invite-issue=""
                  disabled={desk.busy || issueBlocked !== null} onClick={() => { desk.start({ kind: 'issue' }) }}>
                  <IdentityIcon name="person" />Invite someone
                </button>
              </div>
              {issueBlocked === null ? null : <p className="x6-identity__status" data-identity-invite-blocked="">{issueBlocked}</p>}
            </>
          ) : null}
          <InvitePanel desk={desk} />
          {desk.notice === null ? null : (
            <p className="x6-identity__status" role="status" data-tone={desk.notice.tone} data-identity-invite-notice="">{desk.notice.text}</p>
          )}
          {live ? <IssuedList desk={desk} limit={read.limit} /> : null}
        </div>
      </PortalButton>
    </PortalCell>
  )
}

function MissingPortal({ icon, title, summary, missing, ...data }: {
  readonly icon: 'identity' | 'devices'
  readonly title: string
  readonly summary: string
  readonly missing: string
} & Record<`data-${string}`, string | undefined>) {
  return (
    <PortalCell {...data}>
      <PortalButton tone="muted" icon={icon} iconTone="blue" title={title} summary={summary} badge={NOT_CONNECTED(missing)}>
        <Lead>{`NOT CONNECTED YET. Missing: ${missing}`}</Lead>
      </PortalButton>
    </PortalCell>
  )
}

/** The Identity surface: the owner's public contact card, the passkey, AUMLOK binding, and what x6.1 has not got yet. */
/**
 * REDEEM AN INVITE (Wave 5): what a vouched guest sees when they open an invite link, or paste the receipt they were
 * given. This page checks what it can without any host: the receipt's Ed25519 signature against the sponsor key it
 * names, its expiry, and the invite code against the commitment in the receipt. It does NOT say the sponsor is in the
 * network or that the invite was never revoked: only a host can.
 *
 * "CHECK WITH THIS NODE" ASKS THE HOST, ONCE PER PRESS (`redeemInvite`: POST /_host/aumlok/redeem with exactly the
 * receipt and the code). The button is live only while this page's own check passes for the code as it is typed now, so
 * a code the page already knows is wrong never leaves it. Nothing is sent on its own, and nothing is sent again. The
 * line under it says what the host said, and what the host did NOT do: a verified code grants nothing.
 */
function RedeemPortal({ active }: { readonly active: boolean }) {
  const [text, setText] = useState(() => {
    try { return globalThis.location.hash.startsWith(INVITE_LINK_PREFIX) ? globalThis.location.hash : '' } catch { return '' }
  })
  const [code, setCode] = useState('')
  const [check, setCheck] = useState<GuestInviteCheck | null>(null)
  // The code the check on screen was made for: a check of an earlier keystroke never enables the button.
  const [checkedCode, setCheckedCode] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [result, setResult] = useState<RedeemOutcome | null>(null)
  const inFlight = useRef<AbortController | null>(null)
  const receipt = useMemo(() => (text.trim() === '' ? null : inviteFromText(text)), [text])
  // A new receipt starts from no check; a keystroke in the code keeps the last one on screen until the next lands (the
  // code field is never unmounted while it is typed in).
  useEffect(() => { setCheck(null); setCheckedCode(null) }, [receipt])
  useEffect(() => {
    if (receipt === null) return undefined
    let stale = false
    checkGuestInvite(receipt, code).then((next) => { if (!stale) { setCheck(next); setCheckedCode(code) } }).catch(() => {})
    return () => { stale = true }
  }, [receipt, code])
  // What the host said was about one invite and one code: another invite, or another keystroke, takes the line away and
  // drops an answer still on its way.
  useEffect(() => {
    setResult(null)
    inFlight.current?.abort()
  }, [receipt, code])
  // The invite code goes with the screen: once Identity closes, this page holds it nowhere, and an answer still on its
  // way is dropped.
  useEffect(() => {
    if (active) return
    setCode('')
    setResult(null)
    inFlight.current?.abort()
  }, [active])
  useEffect(() => () => { inFlight.current?.abort() }, [])
  const sendable = receipt !== null && check !== null && checkedCode === code
    && check.signed && !check.expired && check.codeMatches === true
  const send = (): void => {
    // ONE PRESS, ONE REQUEST: nothing is sent while one is out, and nothing is ever sent again by the page.
    if (!sendable || inFlight.current !== null) return
    const controller = new AbortController()
    inFlight.current = controller
    setSending(true)
    setResult(null)
    redeemInvite(receipt, code, controller.signal)
      .then((outcome) => { if (!controller.signal.aborted) setResult(outcome) })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return
        const why = error instanceof Error ? error.message : String(error)
        setResult({ kind: 'unclear', detail: `The check did not finish (${why}), so what this node said is not known. It was not sent again.` })
      })
      .finally(() => {
        if (inFlight.current !== controller) return
        inFlight.current = null
        setSending(false)
      })
  }
  const arrived = text.startsWith(INVITE_LINK_PREFIX)
  const state = receipt === null ? (text.trim() === '' ? 'empty' : 'unreadable') : check === null ? 'checking'
    : !check.signed ? 'unsigned' : check.expired ? 'expired' : 'signed'
  return (
    <PortalCell data-identity-portal="redeem">
      <PortalButton tone={state === 'signed' ? 'violet' : 'muted'} icon="aumlok" iconTone="violet" title="Redeem an invite"
        defaultExpanded={arrived}
        summary={receipt === null ? 'open an invite link, or paste the receipt you were given' : `invite ${receipt.inviteId.slice(0, 12)}… for ${receipt.quotaMonth}`}
        badge={state === 'signed' ? <StatusPill tone="mint">SIGNATURE VERIFIES</StatusPill>
          : state === 'expired' ? <StatusPill tone="gold">EXPIRED</StatusPill>
            : state === 'unsigned' ? <StatusPill tone="red">DOES NOT VERIFY</StatusPill>
              : <StatusPill tone="muted">{state === 'checking' ? 'CHECKING' : state === 'unreadable' ? 'NOT AN INVITE' : 'NOTHING HERE YET'}</StatusPill>}>
        <div data-identity-redeem={state}>
          <label className="x6-identity__status" htmlFor="x6-redeem-receipt">Invite link or receipt</label>
          <textarea id="x6-redeem-receipt" className="x5-field" rows={3} value={text} spellCheck={false} autoComplete="off"
            data-identity-redeem-receipt="" onChange={(event) => { setText(event.target.value) }} />
          {state === 'unreadable' ? <p className="x6-identity__status" data-tone="red">This is not an aukora.invite.v1 link or receipt.</p> : null}
          {receipt === null || check === null ? null : (
            <>
              <FieldTable rows={[
                ['vouched by', <span key="s" className="x6-identity__mono" data-identity-redeem-sponsor="">{receipt.sponsorPubkeyHex}</span>],
                ['signature', check.signed ? 'verifies against that key (checked on this page)' : 'DOES NOT verify against that key'],
                ['expires', `${new Date(receipt.expiresAt).toISOString().slice(0, 16).replace('T', ' ')} UTC${check.expired ? ' (expired)' : ''}`],
                ['for', receipt.assignedDomainPointer ?? 'no address yet'],
              ]} />
              <label className="x6-identity__status" htmlFor="x6-redeem-code">Invite code (given to you privately)</label>
              <input id="x6-redeem-code" className="x5-field" type="password" value={code} spellCheck={false} autoComplete="one-time-code"
                data-identity-redeem-code="" data-private="" onChange={(event) => { setCode(event.target.value) }} />
              {check.codeMatches === null ? null : (
                <p className="x6-identity__status" data-tone={check.codeMatches ? 'mint' : 'red'} data-identity-redeem-code-check={String(check.codeMatches)}>
                  {check.codeMatches ? 'This code is the one this invite was made for.' : 'This code is not the one this invite was made for.'}
                </p>
              )}
              <button type="button" className="ak-action ak-tone-violet" data-identity-redeem-send="" disabled={!sendable || sending}
                onClick={send}>
                {sending ? 'Asking this node…' : 'Check with this node'}
              </button>
              {result === null ? null : (
                <p className="x6-identity__status" role="status" data-identity-redeem-result={result.kind}
                  data-tone={result.kind === 'verified' ? 'mint' : result.kind === 'refused' ? 'red' : undefined}>
                  {redeemWords(result)}
                </p>
              )}
              <Lead>
                This page checked the signature, the date and the code itself. Whether the person who vouched is in the network, and
                whether the invite was revoked, only a host can say. “Check with this node” sends the invite and the code to this
                node once, when this page’s own check passes. Its answer is a check only: it grants nothing, enrols no identity and
                does not use the invite up.
              </Lead>
            </>
          )}
        </div>
      </PortalButton>
    </PortalCell>
  )
}

export function IdentitySurface({ activeSurface, closeSurface }: PropsRuntime<'shell.surface'>) {
  const active = activeSurface === IDENTITY_SURFACE
  const owner = useHostRead(OWNER_KEY_ROUTE, active)
  const ownerKey = owner.answer?.kind === 'live' ? readOwnerKey(owner.answer.body) : null
  const nostr = useRead(readNostr, active, NOSTR_READING)
  // ONE read of `/_host/aumlok/status` feeds the invite quota and the passkey and AUMLOK cards, so opening this screen
  // asks the node for its status once, as it did before those cards read it.
  const aumlokStatus = useHostRead(AUMLOK_STATUS_ROUTE, active)
  const invites = { value: aumlokStatus.answer === null ? INVITE_READING : inviteOf(aumlokStatus.answer), reload: aumlokStatus.reload }
  const npub = nostr.value.kind === 'live' ? nostr.value.npub : null
  useEffect(() => {
    if (!active) return
    const escape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented || isEditableTarget(event.target)) return
      event.preventDefault()
      closeSurface()
    }
    document.addEventListener('keydown', escape)
    return () => { document.removeEventListener('keydown', escape) }
  }, [active, closeSurface])
  const badges: readonly Badge[] = ownerKey
    ? [{ text: 'LIVE', tone: 'mint', title: OWNER_KEY_ROUTE }, { text: 'PUBLIC KEY ONLY', icon: 'lock' }]
    : [{ text: 'NOT CONNECTED YET', tone: 'muted', title: `${OWNER_KEY_ROUTE} gave no public key` }]
  return (
    <SurfaceFrame active={active} eyebrow="Your public contact card" title="Identity" badges={badges} data-identity-surface="">
      <div className="x6-identity">
        <PortalGrid open={false}>
          <ContactCode answer={owner.answer} ownerKey={ownerKey} npub={npub} onRetry={owner.reload} />
          <PortalCell data-identity-portal="owner-key">
            <PortalButton tone={ownerKey ? 'blue' : 'muted'} icon="identity" iconTone="blue" title="Owner public key"
              summary={`${OWNER_KEY_ROUTE} · Ed25519, the public half only`} badge={answerPill(owner.answer)}>
              {ownerKey ? (
                <FieldTable rows={[
                  ['key id', <span key="id" className="x6-identity__mono">{ownerKey.keyId}</span>],
                  ['algorithm', 'Ed25519'],
                  ['public key', <span key="hex" className="x6-identity__mono">{ownerKey.publicKeyHex}</span>],
                  ['contact string', <span key="c" className="x6-identity__mono">{ownerContact(ownerKey)}</span>],
                  ['private key', 'stays on the host; this page never asks for it'],
                ]} />
              ) : <AnswerBody answer={owner.answer} missing="the owner key route." />}
            </PortalButton>
          </PortalCell>
          <NostrPortal read={nostr.value} onReload={nostr.reload} active={active} />
          <InvitePortal read={invites.value} active={active} onReload={invites.reload} />
          <RedeemPortal active={active} />
          <PasskeyPortal answer={aumlokStatus.answer} />
          <DevicesPortal active={active} />
          <AumlokPortal answer={aumlokStatus.answer} />
          <MissingPortal data-identity-portal="scan" icon="devices" title="Verify a contact" summary="scan someone else's card"
            missing="the camera scanner and a contact verification route are not ported to x6.1." />
        </PortalGrid>
      </div>
    </SurfaceFrame>
  )
}
