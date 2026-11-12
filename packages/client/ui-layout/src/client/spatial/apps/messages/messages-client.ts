// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The Aukora authors
/**
 * THE MESSAGES CLIENT: this page's same-origin `/aukora-messages/*` routes (Round 11, served by the host and the edge),
 * and the three honesty rules the surface shows.
 *
 *   GET  /aukora-messages/contacts.json   the node's microverse identity, relay status, conversations and contacts
 *   POST /aukora-messages/thread          { conversationId } -> the conversation's turns
 *   POST /aukora-messages/send            { conversationId, content } -> the stored event and its delivery
 *   POST /aukora-messages/add-contact     { kind: 'contact', name, npub, controller? } | { kind: 'marmot-group', name, memberNpubs }
 *
 * HONESTY RULES (enforced here, rendered by the surface):
 *   1. A conversation is MARMOT MLS only when the host gives its MLS group state (group id, epoch, cipher suite and at
 *      least one member key). A Marmot conversation without that state says so; nothing implies MLS encryption.
 *   2. A turn is "delivered to a relay" only when the host's answer carries a relay acknowledgement. A turn stored by
 *      the node itself is "kept in the microverse (this node)", never "sent".
 *   3. SAMPLE conversations appear only when the host route cannot be reached. A reachable host with no conversations
 *      shows an empty list, never samples.
 *   4. (Round 12) A turn is SIGNED only when the node says so AND the turn carries what a signature needs: the
 *      `nip01-schnorr/v1` id scheme, a 64-hex NIP-01 id, a 64-hex x-only pubkey and a 128-hex BIP-340 `sig`. A claim
 *      without those is `malformed`. This tab does not check the Schnorr maths itself, so "verified" here is always the
 *      node's own word (the page verifier, `superagent/nostr-microverse.ts`, is the independent check).
 *
 * Parsing is tolerant of field names (the route contract is new) and strict about claims.
 *
 * @module apps/messages/messages-client
 */

/** Where a conversation lives: this node's local event log, a NIP-44 direct message, or a Marmot (MLS) group. */
export type MessageTier = 'microverse-local' | 'macroverse-nip44-dm' | 'marmot-mls' | 'unknown'

/** Marmot MLS group state, exactly as the host reported it. */
export interface MlsGroupState {
  readonly groupId: string
  readonly epoch: number
  readonly cipherSuite: string
  readonly memberPubkeys: readonly string[]
}

/** Where one turn actually went. */
export type TurnDelivery =
  | { readonly kind: 'microverse-local' }
  | { readonly kind: 'relay-acknowledged'; readonly relays: readonly string[] }
  | { readonly kind: 'not-delivered'; readonly detail: string | null }
  | { readonly kind: 'unknown' }

/** The NIP-01 id scheme of a node-signed turn. */
export const NIP01_SCHNORR = 'nip01-schnorr/v1'
/** The node identity's signing word when it signs turns with BIP-340 Schnorr. */
export const BIP340_SIGNING = 'bip340-schnorr'

/**
 * What the node says about one turn's NIP-01 id and BIP-340 signature.
 *   signed / verified  the node's word, with the id scheme, id, pubkey and sig all present and well formed
 *   invalid            the node says the signature does not verify
 *   malformed          the node claims a signature the turn does not carry in full
 *   unsigned           the node says there is none (`unsigned`, `unavailable`, `none`)
 *   unreported         the node said nothing this client knows: not read as unsigned, not read as signed
 */
export interface TurnSignature {
  readonly status: 'signed' | 'verified' | 'invalid' | 'malformed' | 'unsigned' | 'unreported'
  readonly idScheme: string | null
}

/** One turn from the host. */
export interface LiveTurn {
  readonly id: string | null
  readonly from: 'them' | 'you'
  readonly text: string
  readonly at: string
  readonly delivery: TurnDelivery
  readonly signature: TurnSignature
}

/** One conversation from the host. */
export interface LiveConversation {
  readonly id: string
  readonly name: string
  readonly preview: string
  readonly at: string
  readonly pinned: boolean
  readonly unread: boolean
  readonly archived: boolean
  readonly tier: MessageTier
  readonly mls: MlsGroupState | null
}

/** The node's side of the conversation list. */
export interface MessagesHost {
  readonly npub: string | null
  readonly pubkey: string | null
  /** The identity's signing word as the node reported it (`bip340-schnorr` when it signs turns), or null. */
  readonly signing: string | null
  readonly relay: { readonly connected: boolean; readonly urls: readonly string[] }
  readonly conversations: readonly LiveConversation[]
}

/** A read: the value, or why there is none. `unreachable` is the only state that allows SAMPLE content. */
export type HostRead<T> =
  | { readonly kind: 'ok'; readonly value: T }
  | { readonly kind: 'unreachable'; readonly detail: string }
  | { readonly kind: 'refused'; readonly status: number; readonly detail: string }

export type MessagesFetch = (input: string, init: RequestInit) => Promise<Response>

export const CONTACTS_ROUTE = '/aukora-messages/contacts.json'
export const THREAD_ROUTE = '/aukora-messages/thread'
export const SEND_ROUTE = '/aukora-messages/send'
export const ADD_CONTACT_ROUTE = '/aukora-messages/add-contact'

type Json = Record<string, unknown>
const isJson = (v: unknown): v is Json => v !== null && typeof v === 'object' && !Array.isArray(v)
const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null)
const flag = (v: unknown): boolean => v === true
const HEX_64 = /^[0-9a-f]{64}$/
const HEX_128 = /^[0-9a-f]{128}$/

/** A clock label from seconds (Nostr `created_at`), milliseconds, or an ISO string; `''` when there is none. */
export function timeLabel(value: unknown, now: Date = new Date()): string {
  let ms: number | null = null
  if (typeof value === 'number' && Number.isFinite(value)) ms = value < 1e12 ? value * 1000 : value
  else if (typeof value === 'string' && value !== '') {
    const parsed = Date.parse(value)
    ms = Number.isFinite(parsed) ? parsed : null
  }
  if (ms === null) return typeof value === 'string' ? value : ''
  const at = new Date(ms)
  const sameDay = at.toDateString() === now.toDateString()
  return sameDay
    ? `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
    : at.toLocaleDateString(undefined, { weekday: 'long' })
}

/**
 * Marmot MLS state, only when complete: a group id, a non-negative integer epoch, a cipher suite and member keys.
 * @param value - the conversation's `mls`, `group` or `marmot` object.
 * @returns the state, or null when any part is missing (then nothing may claim MLS).
 */
export function mlsStateOf(value: unknown): MlsGroupState | null {
  if (!isJson(value)) return null
  const groupId = text(value.groupId)
  const epoch = value.epoch
  const cipherSuite = typeof value.cipherSuite === 'number' ? String(value.cipherSuite) : text(value.cipherSuite)
  const members = Array.isArray(value.memberPubkeys) ? value.memberPubkeys : Array.isArray(value.members) ? value.members : []
  const memberPubkeys = members.filter((m): m is string => typeof m === 'string' && m.trim() !== '')
  if (groupId === null || cipherSuite === null || memberPubkeys.length === 0) return null
  if (typeof epoch !== 'number' || !Number.isSafeInteger(epoch) || epoch < 0) return null
  return { groupId, epoch, cipherSuite, memberPubkeys }
}

/** The conversation's tier from the host's `tier` / `protocol` words; anything unrecognised is `unknown`. */
export function tierOf(value: Json): MessageTier {
  const words = [value.tier, value.protocol, value.kind].filter((w): w is string => typeof w === 'string').map(w => w.toLowerCase())
  if (words.some(w => w.includes('marmot') || w.includes('mls'))) return 'marmot-mls'
  if (words.some(w => w.includes('nip44') || w.includes('nip-44') || w.includes('macroverse') || w === 'dm')) return 'macroverse-nip44-dm'
  if (words.some(w => w.includes('microverse') || w === 'local')) return 'microverse-local'
  return 'unknown'
}

/**
 * Where a turn went, from the host's words. Only an explicit relay acknowledgement (a non-empty list of relays that
 * accepted it, or `relayAck: true` with relay names) counts as delivered to a relay.
 */
export function deliveryOf(value: Json): TurnDelivery {
  const delivery = isJson(value.delivery) ? value.delivery : null
  const word = (typeof value.delivery === 'string' ? value.delivery : text(delivery?.status) ?? text(delivery?.kind) ?? '').toLowerCase()
  const acks = [value.relayAcks, value.acceptedBy, delivery?.relayAcks, delivery?.acceptedBy, delivery?.relays]
    .find(Array.isArray) ?? []
  const relays = acks.filter((r): r is string => typeof r === 'string' && r !== '')
  const acked = value.relayAck === true || delivery?.relayAck === true || delivery?.acknowledged === true
  if (relays.length > 0 && (acked || word.includes('relay') || word.includes('macroverse'))) return { kind: 'relay-acknowledged', relays }
  if (word.includes('microverse') || word === 'local' || word === 'stored') return { kind: 'microverse-local' }
  if (word.includes('fail') || word.includes('refus') || word.includes('not')) {
    return { kind: 'not-delivered', detail: text(delivery?.detail) ?? text(value.error) ?? word }
  }
  return { kind: 'unknown' }
}

/**
 * A turn's signature, from the node's `signatureStatus` and `idScheme`. `signed` and `verified` stand only when the turn
 * carries the whole NIP-01 event shape a BIP-340 signature covers; otherwise the claim is `malformed`.
 * @param value - one stored event / turn object.
 */
export function signatureOf(value: Json): TurnSignature {
  const status = (text(value.signatureStatus) ?? '').toLowerCase()
  const idScheme = text(value.idScheme)
  if (status === 'signed' || status === 'verified') {
    const whole = idScheme === NIP01_SCHNORR
      && typeof value.id === 'string' && HEX_64.test(value.id)
      && typeof value.pubkey === 'string' && HEX_64.test(value.pubkey)
      && typeof value.sig === 'string' && HEX_128.test(value.sig)
    return { status: whole ? status : 'malformed', idScheme }
  }
  if (status === 'invalid') return { status: 'invalid', idScheme }
  if (status === 'unsigned' || status === 'unavailable' || status === 'none') return { status: 'unsigned', idScheme }
  return { status: 'unreported', idScheme }
}

/** True when the node reports an npub and BIP-340 Schnorr signing for its microverse identity. */
export function signsWithBip340(host: Pick<MessagesHost, 'npub' | 'signing'>): boolean {
  return host.npub !== null && host.signing === BIP340_SIGNING
}

function conversationOf(value: unknown, now: Date): LiveConversation | null {
  if (!isJson(value)) return null
  const id = text(value.id) ?? text(value.conversationId) ?? text(value.npub) ?? text(value.groupId)
  if (id === null) return null
  const tier = tierOf(value)
  const mls = mlsStateOf(value.mls ?? value.group ?? value.marmot)
  return {
    id,
    name: text(value.name) ?? text(value.title) ?? text(value.label) ?? id,
    preview: text(value.preview) ?? text(value.lastMessage) ?? text(value.last) ?? '',
    at: timeLabel(value.updatedAt ?? value.at ?? value.created_at ?? value.lastAt, now),
    pinned: flag(value.pinned),
    unread: flag(value.unread) || (typeof value.unread === 'number' && value.unread > 0),
    archived: flag(value.archived),
    tier: tier === 'unknown' && mls !== null ? 'marmot-mls' : tier,
    mls,
  }
}

/**
 * Read `contacts.json`. Conversations and contacts both become rows (a contact without its own conversation is a
 * microverse-local row named for it unless the host says otherwise).
 */
export function parseContacts(body: unknown, now: Date = new Date()): MessagesHost | null {
  if (!isJson(body) || body.ok === false) return null
  const identity = isJson(body.identity) ? body.identity : isJson(body.node) ? body.node : {}
  const relay = isJson(body.relay) ? body.relay : {}
  const urls = (Array.isArray(relay.urls) ? relay.urls : Array.isArray(relay.relays) ? relay.relays : [])
    .filter((u): u is string => typeof u === 'string')
  const rows: LiveConversation[] = []
  const listed = [...(Array.isArray(body.conversations) ? body.conversations : []), ...(Array.isArray(body.contacts) ? body.contacts : [])]
  for (const item of listed) {
    const row = conversationOf(item, now)
    if (row !== null && !rows.some(r => r.id === row.id)) rows.push(row)
  }
  const pubkey = text(identity.pubkey) ?? text(identity.publicKeyHex)
  return {
    npub: text(identity.npub),
    pubkey: pubkey !== null && HEX_64.test(pubkey) ? pubkey : null,
    signing: text(identity.signing),
    relay: { connected: relay.connected === true, urls },
    conversations: rows,
  }
}

/** Read a thread answer; `mine` is the node's own pubkey (a turn it authored is "you"). */
export function parseThread(body: unknown, mine: string | null, now: Date = new Date()): readonly LiveTurn[] | null {
  if (!isJson(body) || body.ok === false) return null
  const list = [body.turns, body.events, body.messages].find(Array.isArray)
  if (list === undefined) return null
  const turns: LiveTurn[] = []
  for (const item of list) {
    if (!isJson(item)) continue
    const content = typeof item.content === 'string' ? item.content : typeof item.text === 'string' ? item.text : null
    if (content === null) continue
    const author = text(item.from) ?? text(item.direction) ?? ''
    const fromYou = author === 'you' || author === 'out' || author === 'self' || (mine !== null && item.pubkey === mine)
    turns.push({
      id: text(item.id),
      from: fromYou ? 'you' : 'them',
      text: content,
      at: timeLabel(item.created_at ?? item.at ?? item.createdAt, now),
      delivery: fromYou ? deliveryOf(item) : { kind: 'unknown' },
      signature: signatureOf(item),
    })
  }
  return turns
}

/** Read a send answer: the stored turn, with where it went. */
export function parseSent(body: unknown, now: Date = new Date()): LiveTurn | null {
  if (!isJson(body) || body.ok === false) return null
  const event = isJson(body.event) ? body.event : isJson(body.turn) ? body.turn : body
  const content = typeof event.content === 'string' ? event.content : typeof event.text === 'string' ? event.text : null
  if (content === null) return null
  return {
    id: text(event.id),
    from: 'you',
    text: content,
    at: timeLabel(event.created_at ?? event.at, now),
    delivery: deliveryOf({ ...event, delivery: body.delivery ?? event.delivery, relayAcks: body.relayAcks ?? event.relayAcks }),
    signature: signatureOf(event),
  }
}

async function call(fetchImpl: MessagesFetch, route: string, init: RequestInit): Promise<HostRead<unknown>> {
  let response: Response
  try {
    response = await fetchImpl(route, { credentials: 'same-origin', cache: 'no-store', ...init })
  } catch (error) {
    return { kind: 'unreachable', detail: error instanceof Error ? error.message : String(error) }
  }
  const raw = await response.text().catch(() => '')
  // The host answers an unknown HTML path with its app page; a page is not this route.
  if (response.status === 404 || (response.headers.get('content-type') ?? '').includes('text/html')) {
    return { kind: 'unreachable', detail: `${route} is not served here (${String(response.status)})` }
  }
  let body: unknown
  try { body = JSON.parse(raw) } catch { return { kind: 'refused', status: response.status, detail: `${route} answered non-JSON` } }
  if (!response.ok) {
    const detail = isJson(body) ? text(body.error) ?? text(body.code) ?? `HTTP ${String(response.status)}` : `HTTP ${String(response.status)}`
    return { kind: 'refused', status: response.status, detail }
  }
  return { kind: 'ok', value: body }
}

const post = (body: Json): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

const pageFetch: MessagesFetch = (input, init) => globalThis.fetch(input, init)

/** GET the node's conversations and contacts. */
export async function readMessagesHost(fetchImpl: MessagesFetch = pageFetch): Promise<HostRead<MessagesHost>> {
  const read = await call(fetchImpl, CONTACTS_ROUTE, { method: 'GET' })
  if (read.kind !== 'ok') return read
  const host = parseContacts(read.value)
  return host === null ? { kind: 'refused', status: 200, detail: 'contacts.json is not the expected shape' } : { kind: 'ok', value: host }
}

/** POST for one conversation's turns. */
export async function readThreadTurns(
  conversationId: string, mine: string | null, fetchImpl: MessagesFetch = pageFetch,
): Promise<HostRead<readonly LiveTurn[]>> {
  const read = await call(fetchImpl, THREAD_ROUTE, post({ conversationId }))
  if (read.kind !== 'ok') return read
  const turns = parseThread(read.value, mine)
  return turns === null ? { kind: 'refused', status: 200, detail: 'thread answer is not the expected shape' } : { kind: 'ok', value: turns }
}

/** POST one message; the answer says where it went. */
export async function sendTurn(conversationId: string, content: string, fetchImpl: MessagesFetch = pageFetch): Promise<HostRead<LiveTurn>> {
  const requestId = globalThis.crypto?.randomUUID?.() ?? `req-${String(Date.now())}-${Math.random().toString(36).slice(2, 10)}`
  const read = await call(fetchImpl, SEND_ROUTE, post({ conversationId, content, requestId }))
  if (read.kind !== 'ok') return read
  const turn = parseSent(read.value)
  return turn === null ? { kind: 'refused', status: 200, detail: 'send answer is not the expected shape' } : { kind: 'ok', value: turn }
}

/** What the add-contact form sends. */
export type AddRequest =
  | { readonly kind: 'contact'; readonly name: string; readonly npub: string; readonly controller?: string }
  | { readonly kind: 'marmot-group'; readonly name: string; readonly memberNpubs: readonly string[] }

/** POST a contact or a Marmot group; the host validates and persists it. */
export async function addContact(request: AddRequest, fetchImpl: MessagesFetch = pageFetch): Promise<HostRead<LiveConversation | null>> {
  const read = await call(fetchImpl, ADD_CONTACT_ROUTE, post({ ...request }))
  if (read.kind !== 'ok') return read
  const body = read.value
  if (isJson(body) && body.ok === false) return { kind: 'refused', status: 200, detail: text(body.error) ?? 'refused' }
  const row = isJson(body) ? conversationOf(body.conversation ?? body.contact ?? body.group, new Date()) : null
  return { kind: 'ok', value: row }
}
