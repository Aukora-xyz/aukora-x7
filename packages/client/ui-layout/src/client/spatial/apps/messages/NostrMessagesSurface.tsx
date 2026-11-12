// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The Aukora authors
/**
 * THE PREDECESSOR'S NOSTR MESSAGES IN THE CENTRE STAGE (an earlier repository `NostrMessagesSurface`),
 * on this node's own `/aukora-messages/*` routes (Round 11, `messages-client.ts`).
 *
 *   list     NOSTR MESSAGES / PERSON TO PERSON, Search conversations, the New message / Pin / Unread / Archive toolbar,
 *            68px portal rows, each with its tier pill: MICROVERSE, NIP-44 DM, MARMOT MLS (only with real MLS group
 *            state) or SAMPLE (only when the node's routes cannot be reached)
 *   thread   '‹ Back to Messages', the bubbles, each of yours saying where it went, the compose bar
 *   new      contact or Marmot group, inline in the Stage, never a sheet
 *
 * WHAT IS REAL. Rows, turns and sends come from the node. A turn the node only stored says "kept in the microverse
 * (this node)"; "delivered to a relay" needs the node's relay acknowledgement. Pin, unread and archive are this view's
 * filters (the routes carry no flag writes yet).
 *
 * SIGNING (Round 12). "This node's microverse" shows NIP-01 · BIP-340 SIGNED only when the node reports an npub and
 * `signing: 'bip340-schnorr'`. Each turn's signature is said in its tooltip and `data-signature`, never as text in the
 * bubble or the composer, and always as the node's word (this tab does not check Schnorr signatures).
 *
 * @module apps/messages/NostrMessagesSurface
 */
import { useEffect, useState, type KeyboardEvent } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { AppSurface, FieldTable, Lead, PortalButton, PortalCell, RecordList, RecordRow, StatusPill } from '../../primitives/index.ts'
import type { Tone } from '../../primitives/index.ts'
import { SurfaceFrame } from '../../x5/common.tsx'
import { checkAddContact, parseContactInput } from './add-contact.ts'
import { ArchiveIcon, PinIcon, PlusIcon, SendIcon, UnreadIcon } from './MessagesIcons.tsx'
import {
  addContact, readMessagesHost, readThreadTurns, sendTurn, signsWithBip340,
  type HostRead, type LiveConversation, type LiveTurn, type MessagesHost, type TurnDelivery, type TurnSignature,
} from './messages-client.ts'
import {
  clockLabel, MESSAGES_MISSING, MESSAGES_ROUTES_NEEDED, NOT_SENT_NOTE, SAMPLE_CONVERSATIONS, visibleConversations,
  type Conversation, type MessageTurn,
} from './sample-conversations.ts'
import css from './NostrMessages.module.css'

/** Surface id in the centre lane (the triangle menu's `messages` entry). */
export const MESSAGES_SURFACE = 'messages'

type Flag = 'pinned' | 'unread' | 'archived'
type View = { readonly kind: 'list' } | { readonly kind: 'thread'; readonly id: string } | { readonly kind: 'new' }
/** The node, as last read: still reading, live, unreachable (samples allowed) or refusing (no samples). */
type HostState =
  | { readonly kind: 'reading' }
  | { readonly kind: 'live'; readonly host: MessagesHost }
  | { readonly kind: 'unreachable'; readonly detail: string }
  | { readonly kind: 'refused'; readonly detail: string }
/** One conversation's read from the node. */
interface ThreadReadState { readonly id: string; readonly reading: boolean; readonly error: string | null }

const SAMPLE_TITLE = 'Maya, Rowan, Sora and Aster are sample conversations from the original design, not people you know'
function TierPill({ conversation }: { readonly conversation: Conversation }) {
  const pill = tierPill(conversation)
  return pill === null ? null : <StatusPill tone={pill.tone} title={pill.title}>{pill.text}</StatusPill>
}

function MessageActions({ conversation, onFlag }: { readonly conversation: Conversation; readonly onFlag: (flag: Flag) => void }) {
  const pin = conversation.pinned ? 'Unpin conversation' : 'Pin conversation'
  const unread = conversation.unread ? 'Mark read' : 'Mark unread'
  const archive = conversation.archived ? 'Unarchive conversation' : 'Archive conversation'
  return (
    <span
      className="x5-thread-card-actions"
      onClick={(event) => { event.stopPropagation() }}
      onKeyDown={(event) => { event.stopPropagation() }}
    >
      <button type="button" data-thread-action="pin" className={css.iconButton} title={pin} aria-label={pin}
        aria-pressed={conversation.pinned} onClick={() => { onFlag('pinned') }}><PinIcon /></button>
      <button type="button" data-thread-action="unread" className={css.iconButton} title={unread} aria-label={unread}
        aria-pressed={conversation.unread} onClick={() => { onFlag('unread') }}><UnreadIcon /></button>
      <button type="button" data-thread-action="archive" className={css.iconButton} title={archive} aria-label={archive}
        aria-pressed={conversation.archived} onClick={() => { onFlag('archived') }}><ArchiveIcon /></button>
    </span>
  )
}

/** The conversation's tier, said plainly. MARMOT MLS needs real group state; otherwise the pill says it is missing. */
export function tierPill(conversation: Conversation): { readonly text: string; readonly tone: Tone; readonly title: string } | null {
  if (conversation.sample) return { text: 'SAMPLE', tone: 'gold', title: SAMPLE_TITLE }
  if (conversation.tier === 'marmot-mls') {
    const mls = conversation.mls ?? null
    return mls === null
      ? { text: 'MARMOT · NO MLS STATE', tone: 'muted', title: 'The node gave no MLS group state, so nothing here is MLS-encrypted' }
      : { text: 'MARMOT MLS', tone: 'blue', title: `group ${mls.groupId} · epoch ${String(mls.epoch)} · ${mls.cipherSuite} · ${String(mls.memberPubkeys.length)} members` }
  }
  if (conversation.tier === 'macroverse-nip44-dm') return { text: 'NIP-44 DM', tone: 'violet', title: 'A direct message between nodes (NIP-44)' }
  if (conversation.tier === 'microverse-local') return { text: 'MICROVERSE', tone: 'mint', title: 'This node\'s own local event log' }
  return null
}

/** Where one of your turns went, in words; only a relay acknowledgement says "delivered to a relay". */
export function deliveryText(delivery: TurnDelivery | undefined): string | null {
  if (delivery === undefined) return null
  switch (delivery.kind) {
    case 'microverse-local': return 'kept in the microverse (this node); not sent to a relay'
    case 'relay-acknowledged': return `delivered to ${String(delivery.relays.length)} relay${delivery.relays.length === 1 ? '' : 's'}: ${delivery.relays.join(', ')}`
    case 'not-delivered': return `not delivered${delivery.detail === null ? '' : `: ${delivery.detail}`}`
    default: return 'delivery not reported by the node'
  }
}

/** One turn's signature in words: always the node's own word, since this tab does not check the Schnorr maths. */
export function signatureText(signature: TurnSignature | undefined): string | null {
  if (signature === undefined) return null
  switch (signature.status) {
    case 'signed': return 'NIP-01 id and BIP-340 signature, as the node reports (not checked in this tab)'
    case 'verified': return 'the node reports its BIP-340 signature verified (not checked in this tab)'
    case 'invalid': return 'the node reports this signature does not verify'
    case 'malformed': return 'claimed signed, but the id, pubkey or signature is missing or malformed'
    case 'unsigned': return 'not signed (the node says so)'
    default: return 'signature not reported by the node'
  }
}

/** A turn as this surface holds it: the predecessor's turn plus the node's signature word for live turns. */
type ShownTurn = MessageTurn & { readonly signature?: TurnSignature }
const turnSignature = (turn: MessageTurn): TurnSignature | undefined => (turn as ShownTurn).signature

function stateBadge(conversation: Conversation) {
  if (conversation.pinned) return <StatusPill tone="mint">PINNED</StatusPill>
  if (conversation.unread) return <StatusPill tone="gold">UNREAD</StatusPill>
  if (conversation.archived) return <StatusPill tone="muted">ARCHIVED</StatusPill>
  return null
}

function MessageCard({ conversation, onOpen, onFlag }: {
  readonly conversation: Conversation
  readonly onOpen: () => void
  readonly onFlag: (flag: Flag) => void
}) {
  const tone = conversation.archived ? 'muted' : conversation.unread ? 'blue' : 'mint'
  return (
    <PortalCell data-nostr-row={conversation.id} data-sample={conversation.sample ? 'yes' : undefined}>
      {/* The row actions are SIBLINGS of the card's button, never inside it (a button may not contain buttons). */}
      <div className={css.rowCard}>
        <PortalButton
          tone={tone}
          icon="thread"
          title={conversation.name}
          summary={`${conversation.at} · ${conversation.preview}`}
          showIndicator={false}
          badge={<span className={css.rowBadges}><TierPill conversation={conversation} />{stateBadge(conversation)}</span>}
          onClick={onOpen}
        />
        <span className={css.rowActions}><MessageActions conversation={conversation} onFlag={onFlag} /></span>
      </div>
    </PortalCell>
  )
}

/** The node's side: identity, relay, and route reachability. */
function ConnectionRow({ state }: { readonly state: HostState }) {
  if (state.kind === 'live') {
    const { host } = state
    return (
      <div className={css.connection}>
        <RecordList>
          <RecordRow
            tone="mint"
            title="This node's microverse"
            summary={host.npub ?? host.pubkey ?? 'no node key reported'}
            status={(
              <>
                {signsWithBip340(host)
                  ? <StatusPill tone="mint" title="The node reports it signs each turn: NIP-01 id, BIP-340 Schnorr signature">NIP-01 · BIP-340 SIGNED</StatusPill>
                  : null}
                {host.relay.connected
                  ? <StatusPill tone="mint">RELAY CONNECTED</StatusPill>
                  : <StatusPill tone="muted">NO RELAY</StatusPill>}
              </>
            )}
          >
            <FieldTable rows={[
              ['npub', host.npub ?? '—'],
              ['pubkey', host.pubkey ?? '—'],
              ['signing', signsWithBip340(host)
                ? 'NIP-01 event ids, BIP-340 Schnorr signatures (as the node reports)'
                : host.signing === null ? 'not reported by the node' : `${host.signing} (not BIP-340 Schnorr)`],
              ['relay', host.relay.connected ? `connected (${host.relay.urls.join(', ') || 'unnamed'})` : 'not connected: messages stay on this node'],
              ['routes', MESSAGES_ROUTES_NEEDED.join(' · ')],
            ]}
            />
          </RecordRow>
        </RecordList>
      </div>
    )
  }
  const detail = state.kind === 'reading' ? 'reading the node…' : state.detail
  return (
    <div className={css.connection}>
      <RecordList>
        <RecordRow
          tone="muted"
          title="This node's message routes"
          summary={state.kind === 'unreachable' ? MESSAGES_MISSING : detail}
          status={<StatusPill tone="muted">{state.kind === 'reading' ? 'READING' : state.kind === 'refused' ? 'REFUSED' : 'NOT CONNECTED YET'}</StatusPill>}
          rowTitle={detail}
        >
          <FieldTable title="Routes" rows={MESSAGES_ROUTES_NEEDED.map(route => [route, detail] as const)} />
        </RecordRow>
      </RecordList>
    </div>
  )
}

/** A contact (npub) or a Marmot group, added through the node. Without the node's routes nothing is saved. */
function NewMessageView({ live, onBack, onAdded }: {
  readonly live: boolean
  readonly onBack: () => void
  readonly onAdded: (row: LiveConversation | null) => void
}) {
  const [kind, setKind] = useState<'contact' | 'marmot-group'>('contact')
  const [name, setName] = useState('')
  const [npub, setNpub] = useState('')
  const [controller, setController] = useState('')
  const [members, setMembers] = useState('')
  const [busy, setBusy] = useState(false)
  const [outcome, setOutcome] = useState<string | null>(null)
  const parsed = npub.trim() === '' ? null : parseContactInput(npub)
  const whole = name.trim() === '' || npub.trim() === '' ? null : checkAddContact({ name, npub, controller })
  const check = kind === 'contact' ? whole ?? parsed : null
  const memberNpubs = members.split(/[\s,]+/).map(m => m.trim()).filter(m => m !== '')
  const ready = name.trim() !== '' && (kind === 'contact' ? whole?.ok === true : memberNpubs.length > 0)
  const submit = () => {
    if (!live || !ready || busy) return
    setBusy(true)
    setOutcome(null)
    const request = kind === 'contact'
      ? { kind: 'contact' as const, name: name.trim(), npub: npub.trim(), ...(controller.trim() === '' ? {} : { controller: controller.trim() }) }
      : { kind: 'marmot-group' as const, name: name.trim(), memberNpubs }
    void addContact(request).then((read) => {
      if (read.kind === 'ok') { onAdded(read.value); return }
      setOutcome(`${read.kind === 'unreachable' ? 'Not connected' : 'Refused'}: ${read.detail}`)
    }).finally(() => { setBusy(false) })
  }
  return (
    <SurfaceFrame active eyebrow="" title="New message" headerClassName="x5-app-header--nostr"
      headerCenter={<button type="button" className="x5-message-back" onClick={onBack}>‹ Back to Messages</button>}>
      <form className={css.form} autoComplete="off" onSubmit={(event) => { event.preventDefault(); submit() }} data-nostr-new="">
        <div className="x5-actions" role="radiogroup" aria-label="What to add">
          <button type="button" className="x5-field" aria-pressed={kind === 'contact'} onClick={() => { setKind('contact') }}>Contact</button>
          <button type="button" className="x5-field" aria-pressed={kind === 'marmot-group'} onClick={() => { setKind('marmot-group') }}>Marmot group</button>
        </div>
        <label className={css.field}>Name
          <input className="x5-field" value={name} maxLength={120} placeholder="Name" aria-label="Name"
            onChange={(event) => { setName(event.currentTarget.value) }} />
        </label>
        {kind === 'contact' ? (
          <>
            <label className={css.field}>npub or contact card
              <input className="x5-field" value={npub} placeholder="npub1…" aria-label="npub" spellCheck={false}
                onChange={(event) => { setNpub(event.currentTarget.value) }} />
            </label>
            <label className={css.field}>Controller key (optional)
              <input className="x5-field" value={controller} placeholder="64 hex characters" aria-label="Controller key (optional)"
                spellCheck={false} onChange={(event) => { setController(event.currentTarget.value) }} />
            </label>
          </>
        ) : (
          <label className={css.field}>Member npubs (space or comma separated)
            <input className="x5-field" value={members} placeholder="npub1… npub1…" aria-label="Member npubs" spellCheck={false}
              onChange={(event) => { setMembers(event.currentTarget.value) }} />
          </label>
        )}
        {check === null ? null : check.ok
          ? <p className={css.check} data-ok="yes">Syntax checks out. This does not prove who holds the key.</p>
          : <p className={css.check} data-ok="no">{check.reason}: {check.detail}</p>}
        {kind === 'marmot-group'
          ? <p className={css.check}>The node creates the group; it is MARMOT MLS only once the node reports its MLS group state.</p>
          : null}
        <div className={css.submitRow}>
          <button type="submit" className={css.submit} disabled={!live || !ready || busy}>
            {busy ? 'Adding…' : kind === 'contact' ? 'Add contact' : 'Create group'}
          </button>
          {live ? null : <p className={css.notConnected}>NOT CONNECTED YET: {MESSAGES_MISSING}</p>}
          {outcome === null ? null : <p className={css.notConnected} role="alert">{outcome}</p>}
        </div>
      </form>
    </SurfaceFrame>
  )
}

function ThreadView({ conversation, live, reading, readError, draft, sending, sendError, onDraft, onSend, onBack, onFlag }: {
  readonly conversation: Conversation
  readonly live: boolean
  readonly reading: boolean
  readonly readError: string | null
  readonly draft: string
  readonly sending: boolean
  readonly sendError: string | null
  readonly onDraft: (text: string) => void
  readonly onSend: () => void
  readonly onBack: () => void
  readonly onFlag: (flag: Flag) => void
}) {
  const send = draft.trim() !== '' && !sending
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
    event.preventDefault()
    if (send) onSend()
  }
  const note = live ? 'Sends to this node; each message says where it went.' : NOT_SENT_NOTE
  return (
    <SurfaceFrame active eyebrow="" title={conversation.name} headerClassName="x5-app-header--nostr"
      headerCenter={<button type="button" className="x5-message-back" onClick={onBack}>‹ Back to Messages</button>}
      headerActions={<MessageActions conversation={conversation} onFlag={onFlag} />}>
      <div className="x5-message-thread" data-nostr-conversation={conversation.id}
        aria-label={`${conversation.name} ${conversation.sample ? 'sample ' : ''}conversation`}>
        {reading ? <Lead>Reading the conversation from this node…</Lead> : null}
        {readError === null ? null : <p className="x5-error" role="alert">{readError}</p>}
        {conversation.turns.map((turn, index) => {
          const where = turn.from === 'you' ? deliveryText(turn.delivery) : null
          const signed = signatureText(turnSignature(turn))
          const tip = [where, signed].filter((line): line is string => line !== null).join(' · ')
          return (
            <div className="x5-message-turn" data-from={turn.from} key={`${turn.at}-${String(index)}`}
              data-delivery={turn.delivery?.kind} data-signature={turnSignature(turn)?.status} title={tip === '' ? undefined : tip}>
              <p>{turn.text}</p>
            </div>
          )
        })}
      </div>
      {sendError === null ? null : <p className="x5-error" role="alert">{sendError}</p>}
      <div className="x5-message-compose">
        <input value={draft} placeholder={`Message ${conversation.name}`} aria-label={`Message ${conversation.name}`}
          onChange={(event) => { onDraft(event.currentTarget.value) }} onKeyDown={onKeyDown} />
        <button type="button" disabled={!send} aria-label={live ? 'Send to this node' : 'Keep on this page (not sent)'}
          title={note} onClick={onSend}><SendIcon size={18} /></button>
      </div>
    </SurfaceFrame>
  )
}

const toTurn = (turn: LiveTurn): ShownTurn => ({
  from: turn.from, text: turn.text, at: turn.at, delivery: turn.delivery, signature: turn.signature,
})
const toConversation = (row: LiveConversation): Conversation => ({ ...row, sample: false, turns: [] })

/**
 * The predecessor's Nostr Messages, active while the centre lane shows `messages`.
 * @param props - the centre-lane owner share.
 * @returns the surface (empty while another surface is active).
 */
export function NostrMessagesSurface({ activeSurface }: PropsRuntime<'shell.surface'>) {
  const active = activeSurface === MESSAGES_SURFACE
  const [state, setState] = useState<HostState>({ kind: 'reading' })
  const [conversations, setConversations] = useState<readonly Conversation[]>([])
  const [view, setView] = useState<View>({ kind: 'list' })
  const [drafts, setDrafts] = useState<Readonly<Record<string, string>>>({})
  const [threadRead, setThreadRead] = useState<ThreadReadState | null>(null)
  const [sending, setSending] = useState<string | null>(null)
  const [sendError, setSendError] = useState<Readonly<Record<string, string>>>({})
  const [query, setQuery] = useState('')
  const [pinnedOnly, setPinnedOnly] = useState(false)
  const [unreadOnly, setUnreadOnly] = useState(false)
  const [archivedOnly, setArchivedOnly] = useState(false)
  const [round, setRound] = useState(0)

  // READ THE NODE when the surface opens (and on demand). Only an unreachable node shows the predecessor's samples.
  useEffect(() => {
    if (!active) return
    let cancelled = false
    void readMessagesHost().then((read: HostRead<MessagesHost>) => {
      if (cancelled) return
      if (read.kind === 'ok') {
        setState({ kind: 'live', host: read.value })
        setConversations(read.value.conversations.map(toConversation))
      } else if (read.kind === 'unreachable') {
        setState({ kind: 'unreachable', detail: read.detail })
        setConversations(SAMPLE_CONVERSATIONS)
      } else {
        setState({ kind: 'refused', detail: `${String(read.status)} ${read.detail}` })
        setConversations([])
      }
    })
    return () => { cancelled = true }
  }, [active, round])

  const live = state.kind === 'live'
  const mine = state.kind === 'live' ? state.host.pubkey : null

  const flag = (id: string, key: Flag) => {
    setConversations(current => current.map((item): Conversation => (item.id === id ? { ...item, [key]: !item[key] } : item)))
  }
  const open = (id: string) => {
    setConversations(current => current.map((item): Conversation => (item.id === id ? { ...item, unread: false } : item)))
    setView({ kind: 'thread', id })
    if (!live) return
    setThreadRead({ id, reading: true, error: null })
    void readThreadTurns(id, mine).then((read) => {
      if (read.kind === 'ok') {
        const turns = read.value.map(toTurn)
        setConversations(current => current.map((item): Conversation => (item.id === id ? { ...item, turns } : item)))
        setThreadRead({ id, reading: false, error: null })
      } else {
        setThreadRead({ id, reading: false, error: `Could not read this conversation: ${read.detail}` })
      }
    })
  }
  const send = (id: string) => {
    const content = (drafts[id] ?? '').trim()
    if (content === '' || sending !== null) return
    if (!live) {
      const at = clockLabel(new Date())
      const turn: MessageTurn = { from: 'you', text: content, at, unsent: true }
      setConversations(current => current.map((item): Conversation => (item.id === id
        ? { ...item, preview: content, at, turns: [...item.turns, turn] }
        : item)))
      setDrafts(current => ({ ...current, [id]: '' }))
      return
    }
    setSending(id)
    setSendError(current => ({ ...current, [id]: '' }))
    void sendTurn(id, content).then((read) => {
      if (read.kind === 'ok') {
        const turn = toTurn(read.value)
        setConversations(current => current.map((item): Conversation => (item.id === id
          ? { ...item, preview: turn.text, at: turn.at, turns: [...item.turns, turn] }
          : item)))
        setDrafts(current => ({ ...current, [id]: '' }))
      } else {
        setSendError(current => ({ ...current, [id]: `Not sent (${read.kind}): ${read.detail}` }))
      }
    }).finally(() => { setSending(null) })
  }
  const back = () => { setView({ kind: 'list' }) }

  if (!active) return <AppSurface active={false}>{null}</AppSurface>

  if (view.kind === 'new') {
    return (
      <NewMessageView
        live={live}
        onBack={back}
        onAdded={(row) => {
          if (row !== null) setConversations(current => [toConversation(row), ...current.filter(item => item.id !== row.id)])
          setRound(value => value + 1)
          back()
        }}
      />
    )
  }

  const openConversation = view.kind === 'thread' ? conversations.find(item => item.id === view.id) : undefined
  if (openConversation) {
    const read = threadRead?.id === openConversation.id ? threadRead : null
    return (
      <ThreadView
        conversation={openConversation}
        live={live}
        reading={read?.reading === true}
        readError={read?.error ?? null}
        draft={drafts[openConversation.id] ?? ''}
        sending={sending === openConversation.id}
        sendError={(sendError[openConversation.id] ?? '') === '' ? null : sendError[openConversation.id] ?? null}
        onDraft={(text) => { setDrafts(current => ({ ...current, [openConversation.id]: text })) }}
        onSend={() => { send(openConversation.id) }}
        onBack={back}
        onFlag={(key) => { flag(openConversation.id, key) }}
      />
    )
  }

  const visible = visibleConversations(conversations, { query, pinnedOnly, unreadOnly, archivedOnly })
  return (
    <SurfaceFrame active eyebrow="PERSON TO PERSON" title="Nostr Messages" headerClassName="x5-app-header--nostr"
      data-nostr-messages="" data-nostr-host={state.kind}
      headerActions={(
        <span className="x5-thread-card-actions">
          <button type="button" className={css.iconButton} title="New message" aria-label="New message"
            onClick={() => { setView({ kind: 'new' }) }}><PlusIcon /></button>
          <button type="button" data-thread-action="pin" className={css.iconButton}
            title={pinnedOnly ? 'Show all conversations' : 'Pinned only'} aria-label="Pinned only" aria-pressed={pinnedOnly}
            onClick={() => { setPinnedOnly(value => !value) }}><PinIcon /></button>
          <button type="button" data-thread-action="unread" className={css.iconButton}
            title={unreadOnly ? 'Show all conversations' : 'Unread only'} aria-label="Unread only" aria-pressed={unreadOnly}
            onClick={() => { setUnreadOnly(value => !value) }}><UnreadIcon /></button>
          <button type="button" data-thread-action="archive" className={css.iconButton}
            title={archivedOnly ? 'Show active conversations' : 'Archived only'} aria-label="Archived only" aria-pressed={archivedOnly}
            onClick={() => { setArchivedOnly(value => !value) }}><ArchiveIcon /></button>
        </span>
      )}>
      <div className="x5-nostr-search">
        <input className="x5-field" type="search" value={query} placeholder="Search conversations" aria-label="Search conversations"
          onChange={(event) => { setQuery(event.currentTarget.value) }} />
      </div>
      <ul className={`x5-nostr-list ${css.list}`} aria-label={state.kind === 'unreachable' ? 'Sample conversations' : 'Conversations'}>
        {visible.map(conversation => (
          <MessageCard key={conversation.id} conversation={conversation}
            onOpen={() => { open(conversation.id) }} onFlag={(key) => { flag(conversation.id, key) }} />
        ))}
      </ul>
      {visible.length === 0
        ? <Lead>{state.kind === 'live' && conversations.length === 0 ? 'No conversations on this node yet.' : state.kind === 'reading' ? 'Reading this node…' : 'No conversations match this view.'}</Lead>
        : null}
      <ConnectionRow state={state} />
    </SurfaceFrame>
  )
}
