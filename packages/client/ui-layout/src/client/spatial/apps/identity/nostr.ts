// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The Aukora authors
/**
 * THE IDENTITY SURFACE'S NOSTR AND VOUCHING READS, ONLY AS THE HOST ANSWERS THEM.
 *
 *   GET  /aukora-messages/contacts.json   { identity: { npub, pubkey, signing }, relay: { connected, urls } }
 *        (`deploy/cloudflare/src/messages-store.mjs` identityView + the list answer; the Mac host serves it too)
 *   POST /_head/transcript { action: 'nostr_provision' }   { ok: true, identity: { npub, pubkey, signing } }
 *        (`deploy/cloudflare/src/head-do.mjs`; one BIP-340 key for this node; a second call returns the same npub). Minting
 *        it is a Class 3 action: the owner's passkey approves exactly that request, once (`runProvision`).
 *   POST /_head/transcript { action: 'nostr_status' }      read-only; asked first so a host without the door shows none
 *   GET  /_host/aumlok/status   invite: { quotaMonth, issuedThisMonth, limit, revokedCount }  (aukora.invite.v1)
 *
 * HER HEAD ON NOSTR. One signed NIP-01 event, kind 30078 (NIP-78 application data, addressable), served
 * at a public address on this node. It is NOT a relay and nothing is sent to one: anyone fetches it over HTTPS and checks
 * the signature with their own tool.
 *   GET  /_head/nostr/anchor    (owner) the four facts the node will accept: { headBallId, epoch, receiptsLeafHash,
 *        nodePubkeyHex }, exactly the values the node re-derives and checks when the event arrives. A
 *        node without it answers 404/405, and then the card says so and offers nothing.
 *   POST /_head/nostr/anchor    (owner + Class 3 bound to this exact body) the body IS the UNSIGNED event, exactly the five
 *        keys { pubkey, created_at, kind, tags, content }, built with the seed-nostr-anchor organ's rule (`anchorEvent`);
 *        answers { ok, event } with the signed event, or { ok:false, code }
 *   GET  /api/nostr/head        (signed out) the latest signed event; GET /.well-known/nostr.json?name=auma maps the name
 *        to the key (NIP-05) once something has been published
 *
 * Nothing here signs, guesses or fills a gap: a missing field reads as missing, and no number is drawn from it.
 * @module apps/identity/nostr
 */
import { asRecord } from '../../x5/rpc.ts'
import { CONTACTS_ROUTE, parseContacts } from '../messages/messages-client.ts'
import { browserPlatform, parseAumlokStatus, type AumlokPlatform } from '../../aumlok/aumlok-ceremony.ts'
import {
  approveClass3, canonicalJson, class3Action, sendApprovedClass3,
  type Class3Action, type Class3Approval, type Class3Dependencies, type Class3Sent,
} from '../../aumlok/class3-approval.ts'
import { beginApproval, endApproval } from '../../portal/touch-id-timing.ts'
import { hostCall, type HostAnswer } from './host.ts'

export { CONTACTS_ROUTE }
export const PROVISION_ROUTE = '/_head/transcript'
export const AUMLOK_STATUS_ROUTE = '/_host/aumlok/status'
export const INVITE_SCHEMA = 'aukora.invite.v1'

/** A bech32 npub of a 32-byte key: `npub1` + 58 data characters. */
const NPUB = /^npub1[02-9ac-hj-np-z]{58}$/

export interface NostrRelay { readonly connected: boolean; readonly urls: readonly string[] }

/** The node's Nostr identity read: live, answered-without-one, or why there is nothing to show. */
export type NostrRead =
  | { readonly kind: 'reading' }
  | {
    readonly kind: 'live'
    readonly npub: string
    readonly signing: string | null
    readonly relay: NostrRelay
    /** The 64-hex x-only key the npub encodes, when the host reports it and it is that npub's key; else null. */
    readonly pubkey: string | null
  }
  | { readonly kind: 'none'; readonly relay: NostrRelay }
  | { readonly kind: 'absent'; readonly detail: string }
  | { readonly kind: 'refused'; readonly code: string }
  | { readonly kind: 'unreadable' }

/**
 * Classify a contacts.json answer. Only an `identity` object carrying `npub` (a valid npub, or null) is read.
 * @param answer - the host answer.
 * @returns the read.
 */
export function nostrOf(answer: HostAnswer): NostrRead {
  if (answer.kind === 'absent') return { kind: 'absent', detail: answer.detail }
  if (answer.kind === 'refused') return { kind: 'refused', code: answer.code }
  const identity = asRecord(answer.body.identity)
  const host = parseContacts(answer.body)
  if (host === null || !Object.hasOwn(identity, 'npub')) return { kind: 'unreadable' }
  if (identity.npub === null) return { kind: 'none', relay: host.relay }
  if (host.npub === null || !NPUB.test(host.npub)) return { kind: 'unreadable' }
  const pubkey = host.pubkey !== null && npubOf(host.pubkey) === host.npub ? host.pubkey : null
  return { kind: 'live', npub: host.npub, signing: host.signing, relay: host.relay, pubkey }
}

/** Read the node's Nostr identity. */
export async function readNostr(signal: AbortSignal): Promise<NostrRead> {
  return nostrOf(await hostCall(CONTACTS_ROUTE, signal))
}

/** The exact body that mints the node's Nostr key; the passkey approves these bytes and no others. */
export const PROVISION_BODY: Readonly<{ action: 'nostr_provision' }> = Object.freeze({ action: 'nostr_provision' })

/** What a provisioning press came to. */
export type ProvisionOutcome =
  | { readonly kind: 'provisioned'; readonly npub: string }
  | { readonly kind: 'refused'; readonly code: string }
  /** The passkey did not approve (cancelled, no passkey here, or the approval route refused): nothing was sent. */
  | { readonly kind: 'not-approved'; readonly reason: string }
  /** No clear answer: the key may or may not exist now; reading the card again says. */
  | { readonly kind: 'unclear'; readonly detail: string }

/** The Class 3 terms of a provisioning request on this origin. */
export function provisionTerms(audience: string): Promise<Class3Action> {
  return class3Action({ audience, method: 'POST', pathname: PROVISION_ROUTE, body: PROVISION_BODY })
}

// ── ONE APPROVAL, BOUNDED AFTER THE FINGERPRINT ───────────────────────────────────────────────────────────────────────

/**
 * Once your fingerprint is done, the node has this long to finish the approval (`/_host/aumlok/approve`). After it, the
 * approval is given up and nothing is sent: the card never keeps saying "Waiting for Touch ID" for a fingerprint already given.
 */
export const APPROVAL_FINISH_DEADLINE_MS = 30_000
/** The reason when the fingerprint was done but the node's approval did not finish (the card closed, or the deadline). */
export const UNFINISHED_REASON = 'class3:unfinished'
export const UNFINISHED_LATE_REASON = 'class3:unfinished-late'

/**
 * `approveClass3` on exactly `terms`, with the step after the fingerprint told apart and bounded. `approvalSignal` (the card
 * closing) cancels it at any step: before the fingerprint the reason is `class3:closed`; after it, `class3:unfinished`. A
 * node that does not finish the approval within APPROVAL_FINISH_DEADLINE_MS of the fingerprint ends it with
 * `class3:unfinished-late`. In every one of those cases nothing is sent to the action, and an approval that comes back
 * after the end is dropped (it is single-use and expires unused).
 * @param terms - the binding.
 * @param approvalSignal - aborts the approval.
 * @param deps - the host call and the passkey (the page's own by default).
 * @param fingerprinted - told once, when the passkey has asserted.
 * @returns the approval, or why not.
 */
export async function approveBounded(terms: Class3Action, approvalSignal: AbortSignal, deps: Omit<Class3Dependencies, 'signal'>,
  fingerprinted: () => void): Promise<Class3Approval> {
  const platform = deps.platform ?? browserPlatform
  const stop = new AbortController()
  let asserted = false
  let ended: string | null = null
  /** Read through a call: `ended` moves in the callbacks, so it is never narrowed here. */
  const why = (): string | null => ended
  let timer: ReturnType<typeof setTimeout> | undefined
  let wake: () => void = () => {}
  const stopped = new Promise<null>((resolve) => { wake = () => { resolve(null) } })
  const end = (late: boolean): void => {
    if (ended !== null) return
    ended = late ? UNFINISHED_LATE_REASON : asserted ? UNFINISHED_REASON : 'class3:closed'
    stop.abort()
    wake()
  }
  const close = (): void => { end(false) }
  if (approvalSignal.aborted) close()
  else approvalSignal.addEventListener('abort', close, { once: true })
  const watched: AumlokPlatform = {
    ...platform,
    passkey: async (step, signal) => {
      const assertion = await platform.passkey(step, signal)
      if (!signal.aborted && why() === null) {
        asserted = true
        fingerprinted()
        timer = setTimeout(() => { end(true) }, APPROVAL_FINISH_DEADLINE_MS)
      }
      return assertion
    },
  }
  try {
    if (why() !== null) return { ok: false, reason: why() ?? 'class3:closed' }
    const approval = await Promise.race([approveClass3(terms, { ...deps, platform: watched, signal: stop.signal }), stopped])
    const reason = why()
    return reason !== null || approval === null ? { ok: false, reason: reason ?? 'class3:closed' } : approval
  } catch (error) {
    return { ok: false, reason: why() ?? `class3:${error instanceof Error ? error.message : String(error)}` }
  } finally {
    clearTimeout(timer)
    approvalSignal.removeEventListener('abort', close)
  }
}

/** Once your fingerprint has approved it, the page waits this long for the node's answer, then says it does not know. */
export const SEND_DEADLINE_MS = 60_000

/** Send an approved request with its own deadline: the card closing never cancels it. */
async function sendWithDeadline(approval: Extract<Class3Approval, { ok: true }>, body: unknown, fetchImpl: typeof fetch): Promise<
  { readonly ok: true; readonly sent: Class3Sent } | { readonly ok: false; readonly detail: string }> {
  const deadline = new AbortController()
  const timer = setTimeout(() => { deadline.abort() }, SEND_DEADLINE_MS)
  try {
    return { ok: true, sent: await sendApprovedClass3(approval, body, deadline.signal, fetchImpl) }
  } catch (error) {
    return { ok: false, detail: deadline.signal.aborted ? 'the node gave no answer within a minute'
      : `the node did not answer (${error instanceof Error ? error.message : String(error)})` }
  } finally {
    clearTimeout(timer)
  }
}

/** Where the approved request stands while it runs. */
export type RunPhase = 'approving' | 'finishing' | 'sending'

/**
 * Mint the node's npub on the owner's press, approved by the passkey on exactly that request (Class 3), once. The
 * approval comes first; without it nothing is sent. Never retried here. `approvalSignal` cancels only the approval; once
 * approved, the request is sent and its answer awaited (up to SEND_DEADLINE_MS) whatever happens to the card.
 * @param terms - `provisionTerms(origin)`, computed before the tap.
 * @param approvalSignal - aborts the approval step only.
 * @param fetchImpl - the page's fetch (tests pass their own).
 * @param deps - the passkey and host call (the page's own by default).
 * @param moved - told when the run moves on (fingerprint done, then sending).
 * @returns what happened.
 */
export async function provisionNostrApproved(terms: Class3Action, approvalSignal: AbortSignal, fetchImpl: typeof fetch = globalThis.fetch,
  deps: Omit<Class3Dependencies, 'signal'> = {}, moved: (phase: RunPhase) => void = () => {}): Promise<ProvisionOutcome> {
  const approval = await approveBounded(terms, approvalSignal, deps, () => { moved('finishing') })
  if (!approval.ok) return { kind: 'not-approved', reason: approval.reason }
  moved('sending')
  const result = await sendWithDeadline(approval, PROVISION_BODY, fetchImpl)
  if (!result.ok) return { kind: 'unclear', detail: result.detail }
  const { sent } = result
  const code = typeof sent.body?.code === 'string' ? sent.body.code : null
  if (sent.status === 200 && sent.body?.ok === true) {
    const npub = asRecord(sent.body.identity).npub
    return typeof npub === 'string' && NPUB.test(npub) ? { kind: 'provisioned', npub }
      : { kind: 'unclear', detail: 'the node said ok but named no npub' }
  }
  if (code !== null) return { kind: 'refused', code }
  return { kind: 'unclear', detail: `the node answered ${String(sent.status)} without a code` }
}

// ── ONE KEY PROVISIONING, KEPT ABOVE THE CARD (the same kind of store as the publication below) ───────────────────────

/** Where the one key provisioning on this page stands. */
export type ProvisionRun =
  | { readonly phase: RunPhase; readonly seq: number }
  | { readonly phase: 'settled'; readonly seq: number; readonly outcome: ProvisionOutcome }

let provisioning: ProvisionRun | null = null
let provisionings = 0
const provisionWatchers = new Set<() => void>()
const setProvisioning = (next: ProvisionRun | null): void => {
  provisioning = next
  for (const watcher of [...provisionWatchers]) watcher()
}
/** The provisioning now (for `useSyncExternalStore`). */
export const provisionRun = (): ProvisionRun | null => provisioning
/** Be told when it moves. */
export function watchProvision(watcher: () => void): () => void {
  provisionWatchers.add(watcher)
  return () => { provisionWatchers.delete(watcher) }
}
/** Forget a settled provisioning. One still running is never forgotten. */
export function forgetProvision(): void {
  if (provisioning?.phase === 'settled') setProvisioning(null)
}

/**
 * Run one provisioning press: Touch ID on exactly `{ action: 'nostr_provision' }`, then the request. Closing the card
 * (`approvalSignal`) cancels the approval only; what the node answers an approved request is kept here and shown when the
 * card is shown again.
 * @returns the outcome, or null when one is already running on this page (nothing was asked).
 */
export async function runProvision(terms: Class3Action, approvalSignal: AbortSignal, fetchImpl: typeof fetch = globalThis.fetch,
  deps: Omit<Class3Dependencies, 'signal'> = {}): Promise<ProvisionOutcome | null> {
  if (provisioning !== null && provisioning.phase !== 'settled') return null
  const key = 'nostr-provision'
  if (!beginApproval(key)) return null
  const seq = ++provisionings
  setProvisioning({ phase: 'approving', seq })
  let outcome: ProvisionOutcome
  try {
    outcome = await provisionNostrApproved(terms, approvalSignal, fetchImpl, deps, (phase) => { setProvisioning({ phase, seq }) })
  } catch (error) {
    outcome = { kind: 'unclear', detail: error instanceof Error ? error.message : String(error) }
  } finally {
    endApproval(key)
  }
  setProvisioning({ phase: 'settled', seq, outcome })
  return outcome
}

/**
 * Whether this host takes a provisioning press, asked with the read-only `{ action: 'nostr_status' }`. Only HEAD on the
 * edge serves `/_head/transcript`; a host that answers 404/405/501 (the Mac host) has no provisioning door, so no
 * button is offered there. A refusal still means the door exists.
 */
export async function provisionAvailable(signal: AbortSignal): Promise<boolean> {
  return (await hostCall(PROVISION_ROUTE, signal, { action: 'nostr_status' })).kind !== 'absent'
}

/** The relay state in words, as the route reports it. */
export function relayWords(relay: NostrRelay, signing: string | null): string {
  const signed = signing === 'bip340-schnorr' ? 'local NIP-01 · BIP-340 signed' : `local only · signing ${signing ?? 'not reported'}`
  if (!relay.connected) return `${signed}; no relay connected yet`
  return relay.urls.length > 0 ? `${signed}; relay connected: ${relay.urls.join(', ')}` : `${signed}; relay connected (no url reported)`
}

/** Known refusal codes for a provisioning press, in words; anything else is named as the host said it. */
const REFUSALS: Readonly<Record<string, string>> = {
  SAME_ORIGIN_BROWSER_REQUIRED: 'the host only provisions from this page in the same browser origin',
  OWNER_ACCESS_REQUIRED: 'the host only provisions for the signed-in owner',
  MESSAGES_IDENTITY_PROVISIONING_REQUIRED: 'the host needs the owner’s approval to provision',
  MESSAGES_STORAGE_UNAVAILABLE: 'the host’s private store is not available',
  MESSAGES_SIGNING_UNAVAILABLE: 'the host could not make a signing key',
  METHOD_UNAVAILABLE: 'the host does not take this request',
  CLASS3_WEBAUTHN_REQUIRED: 'minting her key needs your fingerprint on exactly this request, and this approval was missing, '
    + 'already used, expired or for other bytes; no key was made',
  CLASS3_APPROVAL_EXPIRED: 'your approval expired before the request arrived; no key was made',
  CLASS3_ACTION_INVALID: 'the approval was not for this request; no key was made',
  CLASS3_ORIGIN_REQUIRED: 'the approval must come from this page’s own origin; no key was made',
}

/** A provisioning refusal in words, with the host's own code. */
export function refusalWords(code: string): string {
  const words = REFUSALS[code]
  return words === undefined ? `The host refused (${code}).` : `The host refused: ${words} (${code}).`
}

/**
 * Why the passkey approved nothing (`approveClass3`'s reason), in words. In every case nothing was sent to the action.
 * @param reason - `class3:…`.
 * @returns one sentence.
 */
export function approvalWords(reason: string): string {
  if (reason.startsWith('class3:no-passkey-here')) {
    return `Touch ID cannot run in this browser (${reason.slice('class3:no-passkey-here'.length).trim() || 'no reason given'}). Nothing was sent.`
  }
  if (reason.startsWith('class3:passkey')) return `Touch ID did not complete: ${reason.slice('class3:passkey'.length).trim()} Nothing was sent.`
  switch (reason) {
    case 'class3:closed': return 'The card closed before Touch ID finished. Nothing was sent.'
    case UNFINISHED_REASON: return 'Approval did not finish; nothing was sent.'
    case UNFINISHED_LATE_REASON: return `Touch ID was done, but the node did not finish the approval within ${String(APPROVAL_FINISH_DEADLINE_MS / 1000)} `
      + 'seconds. Approval did not finish; nothing was sent.'
    case 'class3:route-absent': return 'This node has no approval route (/_host/aumlok/challenge), so nothing can be approved here. Nothing was sent.'
    case 'class3:binding-mismatch': return 'The node offered to approve other bytes than this card holds, so Touch ID was not asked. Nothing was sent.'
    case 'class3:unexpected-answer': return 'The node’s approval was not for exactly these bytes, so it was not used. Nothing was sent.'
    default: return `The node would not start the approval (${reason.replace(/^class3:/, '')}). Nothing was sent.`
  }
}

/** A provisioning outcome in words. */
export function provisionWords(outcome: ProvisionOutcome): string {
  switch (outcome.kind) {
    case 'provisioned': return 'The node made her Nostr key with your approval; reading it back.'
    case 'refused': return refusalWords(outcome.code)
    case 'not-approved': return approvalWords(outcome.reason)
    case 'unclear': return `No clear answer (${outcome.detail}). Whether a key was made is not known; the card reads it again.`
  }
}

// ── HER HEAD ON NOSTR ──────────────────────────────────────────────────────────────────────────────────────────────────

export const ANCHOR_ROUTE = '/_head/nostr/anchor'
export const PUBLIC_HEAD_ROUTE = '/api/nostr/head'
export const NIP05_NAME = 'auma'
export const NIP05_ROUTE = `/.well-known/nostr.json?name=${NIP05_NAME}`
/** NIP-78 application data; 30000-39999 is the addressable range, so a later event with the same `d` replaces it. */
export const ANCHOR_KIND = 30078
export const ANCHOR_SCHEMA = 'aukora.nostr.head.v1'
/** The node takes an event whose `created_at` is within this many seconds of its own clock. */
export const ANCHOR_CLOCK_WINDOW_S = 600
/** A prepared event is offered for this long; after it the time is taken again and shown before any fingerprint. */
export const ANCHOR_PREPARED_LIFE_MS = 5 * 60_000
/** Once your fingerprint has approved it, the page waits this long for the node's answer, then says it does not know. */
export const ANCHOR_SEND_DEADLINE_MS = SEND_DEADLINE_MS
/**
 * The public address can keep its last answer for up to about two minutes after the node takes a new event: the node holds
 * it for 60 s in the isolate, and the response lets web caches keep it 60 s more (nostr-anchor.mjs). Until the new event is
 * seen there, the card reads it again every POLL_MS, at most POLLS times (a little over two minutes).
 */
export const ANCHOR_VISIBLE_POLL_MS = 20_000
export const ANCHOR_VISIBLE_POLLS = 7

const HEX_64 = /^[0-9a-f]{64}$/
const HEX_128 = /^[0-9a-f]{128}$/

/** The four facts that become public: her head, its epoch, her receipts chain head, and the node's key. */
export interface AnchorFacts {
  readonly headBallId: string
  readonly epoch: number
  readonly receiptsLeafHash: string
  readonly nodePubkeyHex: string
}

/** The NIP-01 event before signing: `id` and `sig` are the node's to add. */
export interface UnsignedAnchor {
  readonly pubkey: string
  readonly created_at: number
  readonly kind: typeof ANCHOR_KIND
  readonly tags: readonly (readonly [string, string])[]
  readonly content: string
}

/** The same event, signed by the node. */
export interface SignedAnchor extends UnsignedAnchor {
  readonly id: string
  readonly sig: string
}

/**
 * The facts, if each is exactly well formed (the organ's own refusals: 64 lowercase hex, a non-negative safe integer).
 * @param value - anything.
 * @returns the facts, or null.
 */
export function anchorFactsOf(value: unknown): AnchorFacts | null {
  const record = asRecord(value)
  const { headBallId, epoch, receiptsLeafHash, nodePubkeyHex } = record
  if (typeof headBallId !== 'string' || !HEX_64.test(headBallId)) return null
  if (typeof epoch !== 'number' || !Number.isSafeInteger(epoch) || epoch < 0) return null
  if (typeof receiptsLeafHash !== 'string' || !HEX_64.test(receiptsLeafHash)) return null
  if (typeof nodePubkeyHex !== 'string' || !HEX_64.test(nodePubkeyHex)) return null
  return { headBallId, epoch, receiptsLeafHash, nodePubkeyHex }
}

/**
 * THE SEED-NOSTR-ANCHOR ORGAN'S RULE, byte for byte (`mirror/home/balls/70a63fb5…js` `checkpointTags`; a spec runs both on
 * the same facts and compares): content is the canonical JSON of exactly these five fields, and the tags repeat them.
 * @param facts - the four facts.
 * @param createdAt - NIP-01 `created_at`, whole seconds.
 * @returns the unsigned event.
 */
export function anchorEvent(facts: AnchorFacts, createdAt: number): UnsignedAnchor {
  const content = canonicalJson({ schema: ANCHOR_SCHEMA, headBallId: facts.headBallId, epoch: facts.epoch,
    receiptsLeafHash: facts.receiptsLeafHash, nodePubkeyHex: facts.nodePubkeyHex })
  return {
    pubkey: facts.nodePubkeyHex,
    created_at: createdAt,
    kind: ANCHOR_KIND,
    tags: [
      ['d', `aukora-head:${facts.nodePubkeyHex}`],
      ['epoch', String(facts.epoch)],
      ['head', facts.headBallId],
      ['receipts', facts.receiptsLeafHash],
      ['schema', ANCHOR_SCHEMA],
    ],
    content,
  }
}

/**
 * The exact request body the passkey approves and the node receives: the unsigned event itself, its five NIP-01 keys and
 * nothing else (the edge takes exactly those keys: nostr-anchor.mjs `parseAnchorEvent`). A copy, so the bytes approved
 * cannot drift from the event shown.
 */
export function anchorBody(event: UnsignedAnchor): UnsignedAnchor {
  const tags = event.tags.map(([name, value]) => [name, value] as const)
  return { pubkey: event.pubkey, created_at: event.created_at, kind: event.kind, tags, content: event.content }
}

/** NIP-01 id: lowercase hex SHA-256 of `[0, pubkey, created_at, kind, tags, content]`. */
export async function nip01Id(event: UnsignedAnchor): Promise<string> {
  const body = JSON.stringify([0, event.pubkey, event.created_at, event.kind, event.tags, event.content])
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(body))
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

/** One publication, ready for the passkey: the facts, the event, its body and its Class 3 terms, and when it was made. */
export interface PreparedAnchor {
  readonly facts: AnchorFacts
  readonly event: UnsignedAnchor
  readonly body: UnsignedAnchor
  readonly terms: Class3Action
  /** The NIP-01 id of `event`: the id the signed event must carry, here and at the public address. */
  readonly id: string
  /** `Date.now()` when it was made; `created_at` is the same instant in whole seconds. */
  readonly preparedAt: number
}

/**
 * Build the event and its terms before any tap, so the tap goes straight to the passkey.
 * @param facts - the four facts.
 * @param audience - this page's origin.
 * @param now - the clock (ms).
 * @returns the prepared publication.
 */
export async function prepareAnchor(facts: AnchorFacts, audience: string, now: number = Date.now()): Promise<PreparedAnchor> {
  const event = anchorEvent(facts, Math.floor(now / 1000))
  const body = anchorBody(event)
  return { facts, event, body, preparedAt: now, id: await nip01Id(event),
    terms: await class3Action({ audience, method: 'POST', pathname: ANCHOR_ROUTE, body }) }
}

/**
 * A signed event as the node or the public address serves it, read strictly: every NIP-01 field present and well formed,
 * kind 30078, and tags that say exactly what the content says (the organ's `checkpointVerify` rule).
 * @param value - anything.
 * @returns the event, or null.
 */
export function signedAnchorOf(value: unknown): SignedAnchor | null {
  const record = asRecord(value)
  const { id, sig, pubkey, created_at: createdAt, kind, tags, content } = record
  if (typeof id !== 'string' || !HEX_64.test(id) || typeof sig !== 'string' || !HEX_128.test(sig)) return null
  if (typeof pubkey !== 'string' || !HEX_64.test(pubkey) || kind !== ANCHOR_KIND || typeof content !== 'string') return null
  if (typeof createdAt !== 'number' || !Number.isSafeInteger(createdAt) || createdAt < 0) return null
  if (!Array.isArray(tags) || !tags.every(tag => Array.isArray(tag) && tag.length === 2 && tag.every(part => typeof part === 'string'))) return null
  const tagOf = (name: string): string | null => (tags as string[][]).find(tag => tag[0] === name)?.[1] ?? null
  const epochText = tagOf('epoch')
  const facts = anchorFactsOf({ headBallId: tagOf('head'), epoch: epochText !== null && /^(0|[1-9][0-9]*)$/.test(epochText) ? Number(epochText) : null,
    receiptsLeafHash: tagOf('receipts'), nodePubkeyHex: pubkey })
  if (facts === null || tagOf('d') !== `aukora-head:${pubkey}`) return null
  const expected = anchorEvent(facts, createdAt)
  if (canonicalJson(expected.tags) !== canonicalJson(tags) || expected.content !== content) return null
  return { id, sig, pubkey, created_at: createdAt, kind: ANCHOR_KIND, tags: expected.tags, content }
}

/** What the node says it will accept now, and whether that can be published from here. */
export type AnchorFactsRead =
  | { readonly kind: 'live'; readonly facts: AnchorFacts }
  | { readonly kind: 'absent'; readonly detail: string }
  | { readonly kind: 'refused'; readonly code: string }
  | { readonly kind: 'unreadable' }

/**
 * Read the facts the node will check the event against (`GET /_head/nostr/anchor`, owner only).
 * @param signal - aborts the read.
 * @param call - the host call (tests pass their own).
 * @returns the read.
 */
export async function readAnchorFacts(signal: AbortSignal, call: typeof hostCall = hostCall): Promise<AnchorFactsRead> {
  const answer = await call(ANCHOR_ROUTE, signal)
  if (answer.kind === 'absent') return { kind: 'absent', detail: answer.detail }
  if (answer.kind === 'refused') return { kind: 'refused', code: answer.code }
  const facts = anchorFactsOf(answer.body.facts ?? answer.body)
  return facts === null ? { kind: 'unreadable' } : { kind: 'live', facts }
}

/** What the public address serves now. */
export type PublicHeadRead =
  /**
   * A well-formed head event. `computedId` is the NIP-01 id recomputed here, once per read, from the fields it SERVES; the
   * `id` string it carries is only what it says of itself.
   */
  | { readonly kind: 'published'; readonly event: SignedAnchor; readonly computedId: string }
  /** Nothing is served there yet (the node answered 404: nothing published, or no such address on this node). */
  | { readonly kind: 'none' }
  | { readonly kind: 'unreadable'; readonly detail: string }

/**
 * Read the public address the way a stranger would: no cookie, no cache.
 * @param signal - aborts the read.
 * @param fetchImpl - the page's fetch.
 * @returns the read.
 */
export async function readPublicHead(signal: AbortSignal, fetchImpl: typeof fetch = globalThis.fetch): Promise<PublicHeadRead> {
  let response: Response
  try {
    response = await fetchImpl(PUBLIC_HEAD_ROUTE, { credentials: 'omit', cache: 'no-store', signal, headers: { accept: 'application/json' } })
  } catch (error) {
    if (signal.aborted) throw error
    return { kind: 'unreadable', detail: `it did not answer (${error instanceof Error ? error.message : String(error)})` }
  }
  if (response.status === 404) return { kind: 'none' }
  let text: string
  try { text = await response.text() } catch (error) {
    // A body that cannot be read is an unreadable answer (one attempt), never a stale one kept.
    if (signal.aborted) throw error
    return { kind: 'unreadable', detail: `its answer could not be read (${error instanceof Error ? error.message : String(error)})` }
  }
  if (!response.ok) return { kind: 'unreadable', detail: `it answered ${String(response.status)}` }
  if (text.length > 8 * 1024) return { kind: 'unreadable', detail: 'its answer is larger than one event can be' }
  let parsed: unknown = null
  try { parsed = JSON.parse(text) } catch { parsed = null }
  const record = asRecord(parsed)
  const event = signedAnchorOf(Object.hasOwn(record, 'event') ? record.event : parsed)
  if (event === null) return { kind: 'unreadable', detail: 'what it serves is not a well-formed head event' }
  return { kind: 'published', event, computedId: await nip01Id(event) }
}

/** What the public address serves, measured against the event your fingerprint approved. */
export type ServedMatch =
  /** Exactly the approved event: the id it carries is the approved id, its served fields hash to that id, and each field is equal. */
  | { readonly kind: 'exact' }
  /** It carries the approved id, but its served fields hash to another id, or a field is not the approved one: never "as approved". */
  | { readonly kind: 'false'; readonly computedId: string; readonly differs: readonly string[] }
  /**
   * Another event (another id). Nothing is inferred from its time: a computer with a fast clock can sign an OLDER event with
   * a later created_at, so a later time never means "since then" (review SHOULD).
   */
  | { readonly kind: 'other' }
  /** Nothing served, or nothing readable. */
  | { readonly kind: 'none' }

/**
 * Whether the public address serves exactly the approved event. The id string alone is not enough: the NIP-01 id is
 * recomputed from the served fields (`readPublicHead`, once per read) and must be the approved id, and created_at, tags and
 * content (and the key; the kind is always 30078) must be the approved event's, byte for byte.
 * @param published - one read of the public address.
 * @param approved - the publication your fingerprint approved.
 * @returns the match.
 */
export function servedMatch(published: PublicHeadRead, approved: PreparedAnchor): ServedMatch {
  if (published.kind !== 'published') return { kind: 'none' }
  const { event, computedId } = published
  if (event.id !== approved.id) return { kind: 'other' }
  const want = approved.event
  const differs = [
    ...(event.created_at === want.created_at ? [] : ['time']),
    ...(canonicalJson(event.tags) === canonicalJson(want.tags) ? [] : ['tags']),
    ...(event.content === want.content ? [] : ['content']),
    ...(event.pubkey === want.pubkey ? [] : ['key']),
  ]
  // The kind needs no comparison here: `signedAnchorOf` reads only kind 30078, the approved event's kind.
  return computedId === approved.id && differs.length === 0 ? { kind: 'exact' } : { kind: 'false', computedId, differs }
}

/** What a publish press came to. */
export type PublishOutcome =
  | { readonly kind: 'published'; readonly event: SignedAnchor }
  | { readonly kind: 'refused'; readonly code: string }
  | { readonly kind: 'not-approved'; readonly reason: string }
  | { readonly kind: 'unclear'; readonly detail: string }

/**
 * What the node's answer to an approved publication means. Published only when the node returns a signed event whose
 * every field is exactly the one approved, and whose id is the NIP-01 id of those fields (checked here). The signature
 * itself is checked by whoever fetches the public address; this page does not claim it.
 * @param sent - the node's status and JSON body.
 * @param approved - the unsigned event the passkey approved.
 * @returns the outcome.
 */
export async function publishOutcomeOf(sent: Class3Sent, approved: UnsignedAnchor): Promise<PublishOutcome> {
  const code = typeof sent.body?.code === 'string' ? sent.body.code : null
  if (sent.status === 200 && sent.body?.ok === true) {
    const event = signedAnchorOf(sent.body.event)
    if (event === null) return { kind: 'unclear', detail: 'the node said ok but returned no well-formed signed event' }
    const { id: _id, sig: _sig, ...fields } = event
    if (canonicalJson(fields) !== canonicalJson(approved)) {
      return { kind: 'unclear', detail: 'the node returned a signed event that is not the one you approved' }
    }
    if (await nip01Id(approved) !== event.id) return { kind: 'unclear', detail: 'the node returned an event id that is not the NIP-01 id of what you approved' }
    return { kind: 'published', event }
  }
  if (code !== null) return { kind: 'refused', code }
  return { kind: 'unclear', detail: `the node answered ${String(sent.status)} without a code` }
}

// ── ONE PUBLICATION, KEPT ABOVE THE CARD ──────────────────────────────────────────────────────────────────────────────
// Closing Identity or folding the Nostr card unmounts the card; the publication's state lives here, in this module, so the
// card says the truth when it is shown again: still asking Touch ID, sent and waiting, or what the node answered.

/** Where the one publication on this page stands. */
export type PublicationRun =
  /** Touch ID is being asked. Closing the card cancels it, and then nothing is sent. */
  | { readonly phase: 'approving'; readonly seq: number; readonly prepared: PreparedAnchor }
  /**
   * Your fingerprint is done; the node is finishing the approval (APPROVAL_FINISH_DEADLINE_MS at most). Nothing is sent yet,
   * and closing the card now ends it: "Approval did not finish; nothing was sent."
   */
  | { readonly phase: 'finishing'; readonly seq: number; readonly prepared: PreparedAnchor }
  /** Your fingerprint approved exactly `prepared.body`, and it is on its way to the node. Nothing on this page cancels it now. */
  | { readonly phase: 'sending'; readonly seq: number; readonly prepared: PreparedAnchor }
  | { readonly phase: 'settled'; readonly seq: number; readonly prepared: PreparedAnchor; readonly outcome: PublishOutcome }

let publication: PublicationRun | null = null
let publications = 0
const watchers = new Set<() => void>()
const setPublication = (next: PublicationRun | null): void => {
  publication = next
  for (const watcher of [...watchers]) watcher()
}

/** The publication now (for `useSyncExternalStore`). */
export const publicationRun = (): PublicationRun | null => publication
/** Be told when it moves. */
export function watchPublication(watcher: () => void): () => void {
  watchers.add(watcher)
  return () => { watchers.delete(watcher) }
}
/** Forget a settled publication. One still asking Touch ID or sending is never forgotten. */
export function forgetPublication(): void {
  if (publication?.phase === 'settled') setPublication(null)
}
/** Tests only: forgets the publication and the key provisioning. */
export function resetPublicationForTests(): void {
  setPublication(null)
  setProvisioning(null)
}

/**
 * Approve the prepared publication with the owner's passkey (Class 3, exactly this body, once), then send it. The passkey
 * step ends when `approvalSignal` aborts (the card closed): then nothing is sent. Once the passkey has approved, the send is
 * never cancelled by the card; it ends with the node's answer, or after ANCHOR_SEND_DEADLINE_MS as "not known".
 * @param prepared - from `prepareAnchor`: the exact event on screen at the press.
 * @param approvalSignal - aborts the passkey step only.
 * @param fetchImpl - the page's fetch (tests pass their own).
 * @param deps - the passkey and host call (the page's own by default).
 * @returns the outcome, or null when a publication is already running on this page (nothing was asked).
 */
export async function runPublication(prepared: PreparedAnchor, approvalSignal: AbortSignal, fetchImpl: typeof fetch = globalThis.fetch,
  deps: Omit<Class3Dependencies, 'signal'> = {}): Promise<PublishOutcome | null> {
  if (publication !== null && publication.phase !== 'settled') return null
  const key = `nostr-anchor:${canonicalJson(prepared.body)}`
  if (!beginApproval(key)) return null
  const seq = ++publications
  setPublication({ phase: 'approving', seq, prepared })
  let outcome: PublishOutcome
  try {
    outcome = await approveAndSend(prepared, approvalSignal, fetchImpl, deps, (phase) => { setPublication({ phase, seq, prepared }) })
  } catch (error) {
    outcome = { kind: 'unclear', detail: error instanceof Error ? error.message : String(error) }
  } finally {
    endApproval(key)
  }
  setPublication({ phase: 'settled', seq, prepared, outcome })
  return outcome
}

async function approveAndSend(prepared: PreparedAnchor, approvalSignal: AbortSignal, fetchImpl: typeof fetch,
  deps: Omit<Class3Dependencies, 'signal'>, moved: (phase: 'finishing' | 'sending') => void): Promise<PublishOutcome> {
  const approval = await approveBounded(prepared.terms, approvalSignal, deps, () => { moved('finishing') })
  if (!approval.ok) return { kind: 'not-approved', reason: approval.reason }
  moved('sending')
  const result = await sendWithDeadline(approval, prepared.body, fetchImpl)
  return result.ok ? await publishOutcomeOf(result.sent, prepared.event) : { kind: 'unclear', detail: result.detail }
}

/**
 * Every refusal the node may give a publication, in plain words: the edge (nostr-anchor.mjs
 * `handleNostrAnchorRoute` and `publishHeadAnchor`, the Worker's NOSTR hook, the Class 3 check and the node's signing path).
 */
const ANCHOR_REFUSALS: Readonly<Record<string, string>> = {
  CLASS3_WEBAUTHN_REQUIRED: 'publishing needs your fingerprint on exactly this event, and this approval was missing, already used, '
    + 'expired or for other bytes',
  CLASS3_APPROVAL_EXPIRED: 'your approval expired before the event arrived',
  CLASS3_ACTION_INVALID: 'the approval was not for this event',
  CLASS3_ORIGIN_REQUIRED: 'the approval must come from this page’s own origin',
  OWNER_ACCESS_REQUIRED: 'only the signed-in owner may publish; you may be signed out',
  OWNER_ACCESS_NOT_CONFIGURED: 'this node has no owner sign-in set up, so no one can publish from it',
  NOSTR_ANCHOR_OWNER_REQUIRED: 'the node did not see the signed-in owner on this request; you may be signed out',
  SAME_ORIGIN_BROWSER_REQUIRED: 'the node takes a publication only from this page in the same browser origin',
  ORIGIN_REFUSED: 'the request came from another web origin than the node’s own',
  CROSS_SITE_REFUSED: 'the browser marked the request as coming from another site',
  METHOD_UNAVAILABLE: 'the node does not take this request',
  NOT_FOUND: 'the node takes the publication only at its exact address, without a query',
  BOOTSTRAP_REQUIRED: 'the node has not finished starting up, so it takes no publication yet',
  NOSTR_ANCHOR_IDENTITY_REQUIRED: 'the node has no Nostr key yet; create it first',
  MESSAGES_IDENTITY_REQUIRED: 'the node has no Nostr key yet; create it first',
  MESSAGES_IDENTITY_PROVISIONING_REQUIRED: 'the node has no Nostr key yet; create it first',
  MESSAGES_STORAGE_UNAVAILABLE: 'the node’s private store is not available',
  MESSAGES_SIGNING_UNAVAILABLE: 'the node could not sign with its key',
  MESSAGES_EVENT_INVALID: 'the node’s signing path would not sign this event as it stands',
  MESSAGES_EVENT_PUBKEY_MISMATCH: 'the key in the event is not the key the node signs with',
  MESSAGES_STATE_CORRUPT: 'the node’s stored Nostr key did not pass its own check, so it signed nothing',
  NOSTR_ANCHOR_SIGNING_UNAVAILABLE: 'the node signed, but its own check of the signature failed, so it kept nothing',
  NOSTR_ANCHOR_JSON_REQUIRED: 'the request was not sent as JSON',
  NOSTR_ANCHOR_REQUEST_LIMIT: 'the request was larger than the node takes for one event (4 KiB)',
  NOSTR_ANCHOR_EVENT_INVALID: 'the event was not well formed: not exactly the five unsigned NIP-01 fields, or a field out of shape',
  NOSTR_ANCHOR_KIND_INVALID: 'the event was not kind 30078',
  NOSTR_ANCHOR_CONTENT_INVALID: 'the content was not the five head fields as JSON',
  NOSTR_ANCHOR_CONTENT_NOT_CANONICAL: 'the content held the right fields but not in the one canonical JSON spelling the node signs',
  NOSTR_ANCHOR_HEAD_MISMATCH: 'her head or its epoch changed since this card read them; read it again and look before approving',
  NOSTR_ANCHOR_PUBKEY_MISMATCH: 'the key in the event is not the node’s own key',
  NOSTR_ANCHOR_RECEIPTS_MISMATCH: 'her receipts chain head on the node is not the one shown (a new receipt may still be on its way); '
    + 'read it again and look before approving',
  NOSTR_ANCHOR_RECEIPTS_UNAVAILABLE: 'the node could not read her receipt chain in full, or it did not verify from the first row',
  NOSTR_ANCHOR_TAGS_MISMATCH: 'the tags do not say exactly what the content says',
  NOSTR_ANCHOR_CLOCK_SKEW: 'this computer’s clock and the node’s clock differ by more than ten minutes, and the time in the event '
    + 'comes from this computer; set this computer’s clock right, then read again',
  NOSTR_ANCHOR_CLOCK_UNAVAILABLE: 'the node could not read its own clock',
  NOSTR_ANCHOR_STATE_CORRUPT: 'the event the node holds did not pass its own check, so it serves none',
  NOSTR_ANCHOR_UNAVAILABLE: 'the node could not finish the publication for a reason it does not name',
  NOSTR_ANCHOR_UNPUBLISHED: 'nothing has been published yet',
}

/**
 * A publication refusal in words, with the node's own code. A code this page does not know is still said, by name.
 * @param code - the node's code.
 * @returns one sentence; it always says that nothing was published.
 */
export function anchorRefusalWords(code: string): string {
  const words = ANCHOR_REFUSALS[code]
  return words === undefined ? `The node refused (${code}). Nothing was published.` : `The node refused: ${words} (${code}). Nothing was published.`
}

/** A publish outcome in words. */
export function publishWords(outcome: PublishOutcome): string {
  switch (outcome.kind) {
    case 'published': return `Accepted. The node took it and returned exactly the event you approved (epoch ${outcome.event.tags[1]?.[1] ?? '?'}, `
      + `id ${outcome.event.id}) with a signature this page does not check; anyone can check it at the public address once it shows there.`
    case 'refused': return anchorRefusalWords(outcome.code)
    case 'not-approved': return approvalWords(outcome.reason)
    case 'unclear': return `No clear answer (${outcome.detail}). Whether it was published is not known: “Check” reads the public address.`
  }
}

// ── BECH32 (BIP-173) FOR AN npub, so the npub shown is computed here from the exact key in the event ────────────────────

const BECH32 = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'
const GENERATORS = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]

function polymod(values: readonly number[]): number {
  let chk = 1
  for (const value of values) {
    const top = chk >>> 25
    chk = ((chk & 0x1ffffff) << 5) ^ value
    for (let i = 0; i < 5; i += 1) if ((top >>> i) & 1) chk ^= GENERATORS[i] ?? 0
  }
  return chk >>> 0
}

/**
 * The NIP-19 npub of a 64-hex x-only key.
 * @param pubkeyHex - lowercase hex.
 * @returns `npub1…`, or null when the key is not 64 lowercase hex.
 */
export function npubOf(pubkeyHex: string): string | null {
  if (!HEX_64.test(pubkeyHex)) return null
  const words: number[] = []
  let acc = 0
  let bits = 0
  for (const pair of pubkeyHex.match(/../g) ?? []) {
    acc = ((acc << 8) | parseInt(pair, 16)) & 0xffff
    bits += 8
    while (bits >= 5) { bits -= 5; words.push((acc >>> bits) & 31) }
  }
  if (bits > 0) words.push((acc << (5 - bits)) & 31)
  const hrp = 'npub'
  const codes = Array.from({ length: hrp.length }, (_, i) => hrp.charCodeAt(i))
  const expanded = [...codes.map(c => c >> 5), 0, ...codes.map(c => c & 31)]
  const mod = polymod([...expanded, ...words, 0, 0, 0, 0, 0, 0]) ^ 1
  const checksum = Array.from({ length: 6 }, (_, i) => (mod >>> (5 * (5 - i))) & 31)
  return `${hrp}1${[...words, ...checksum].map(w => BECH32[w]).join('')}`
}

/**
 * The QR's text when a Nostr identity is live: the owner contact string, then a NIP-21 `nostr:` line for the npub.
 * @param contact - the owner contact string, or null when there is none.
 * @param npub - the node's npub, or null.
 * @returns the text, or null when there is no owner contact.
 */
export function cardText(contact: string | null, npub: string | null): string | null {
  if (contact === null) return null
  return npub === null ? contact : `${contact}\nnostr:${npub}`
}

/** The human-vouching quota read (aukora.invite.v1). */
export type InviteRead =
  | { readonly kind: 'reading' }
  | {
    readonly kind: 'live'
    readonly month: string
    readonly issued: number
    readonly limit: number
    readonly remaining: number
    readonly revoked: number | null
  }
  | { readonly kind: 'unbound' }
  | { readonly kind: 'missing' }
  | { readonly kind: 'absent'; readonly detail: string }
  | { readonly kind: 'refused'; readonly code: string }
  | { readonly kind: 'unreadable' }

const count = (value: unknown): number | null => (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null)

/**
 * Classify an AUMLOK status answer for its invite quota. A node that is not bound cannot vouch, so no number is shown.
 * @param answer - the host answer.
 * @returns the read; `live` only when quotaMonth, issuedThisMonth and limit are all present and well formed.
 */
export function inviteOf(answer: HostAnswer): InviteRead {
  if (answer.kind === 'absent') return { kind: 'absent', detail: answer.detail }
  if (answer.kind === 'refused') return { kind: 'refused', code: answer.code }
  const status = parseAumlokStatus(answer.body)
  if (status === null) return { kind: 'unreadable' }
  if (status.state !== 'bound') return { kind: 'unbound' }
  const invite = asRecord(answer.body.invite)
  const issued = count(invite.issuedThisMonth)
  const limit = count(invite.limit)
  const month = typeof invite.quotaMonth === 'string' && /^\d{4}-\d{2}$/.test(invite.quotaMonth) ? invite.quotaMonth : null
  if (issued === null || limit === null || month === null) return { kind: 'missing' }
  return { kind: 'live', month, issued, limit, remaining: Math.max(0, limit - issued), revoked: count(invite.revokedCount) }
}

/** Read the node's invite quota. */
export async function readInvites(signal: AbortSignal): Promise<InviteRead> {
  return inviteOf(await hostCall(AUMLOK_STATUS_ROUTE, signal))
}
