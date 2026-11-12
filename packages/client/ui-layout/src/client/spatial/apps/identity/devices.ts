// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The Aukora authors
/**
 * YOUR DEVICES: more than one passkey for the one owner, so another computer can sign in (the edge's
 * `deploy/cloudflare/src/passkey-devices.mjs` says every rule; this page only carries them).
 *
 *   GET  /_host/aumlok/devices                         the first passkey, each added device, a code waiting (if any)
 *   POST /_host/aumlok/device-code {action, label, expiresAt, generation}   + the Class 3 approval header: a one-time
 *        code (ten minutes, single use) and its link `https://<origin>/_auth/passkey/add#<code>`
 *   POST /_host/aumlok/device-confirm {action, deviceId, keyHash, instance, generation} + the Class 3 approval header:
 *        the owner approves the EXACT key of a new device that registered with the code ("A new device asks to join"),
 *        and THIS joining of it (`instance`), so an approval made for an earlier joining confirms nothing later
 *   POST /_host/aumlok/device-decline {action, deviceId, instance, generation}   the owner's session only: deletes it
 *   POST /_host/aumlok/device-remove {action, deviceId, generation}         + the Class 3 approval header
 *
 * Adding takes two approvals on exact bytes (`approveClass3`): the code, then the new device's key, shown as the same
 * six-digit phrase the new device shows. A device cannot remove itself, and the first passkey is not removable here.
 * The code is shown once and never kept by this page. When an answer is lost, the outcome is UNKNOWN, never "nothing
 * changed": the portal says so and reads the list again.
 * @module apps/identity/devices
 */
import { capacityWords, hostCall, retryAfterOf, type HostAnswer } from './host.ts'
import { approveClass3, class3Action, sendApprovedClass3, type Class3Dependencies } from '../../aumlok/class3-approval.ts'

export const DEVICES_ROUTE = '/_host/aumlok/devices'
export const DEVICE_CODE_ROUTE = '/_host/aumlok/device-code'
export const DEVICE_REMOVE_ROUTE = '/_host/aumlok/device-remove'
export const DEVICE_CONFIRM_ROUTE = '/_host/aumlok/device-confirm'
export const DEVICE_DECLINE_ROUTE = '/_host/aumlok/device-decline'
/** The page the other computer opens (the code rides in the fragment, which no server receives). */
export const DEVICE_ADD_PAGE = '/_auth/passkey/add'
export const DEVICE_ADD_ACTION = 'aumlok.device.add'
export const DEVICE_REMOVE_ACTION = 'aumlok.device.remove'
export const DEVICE_CONFIRM_ACTION = 'aumlok.device.confirm'
export const DEVICE_DECLINE_ACTION = 'aumlok.device.decline'
export const DEVICE_CODE_LIFE_MS = 600_000
export const DEVICE_LABEL_MAX = 40
/** While a code waits for its new device, Your devices reads the list again this often, so "asks to join" appears. */
export const DEVICES_WAIT_READ_MS = 3000
/** While a code waits, this many failed re-reads in a row keep the last list and are tried again; then a plain Retry. */
export const DEVICES_WAIT_RETRIES = 5

/** One enrolled device beside the first passkey. */
export interface DeviceEntry {
  readonly id: string
  readonly label: string
  readonly addedAt: number
  readonly lastVerifiedAt: number
}

/** A new device that registered with a code and waits for an enrolled passkey to confirm its exact key. */
export interface DeviceJoining {
  readonly id: string
  readonly label: string
  /** SHA-256 (hex) of the new key's canonical bytes: what the confirm approval names. */
  readonly keyHash: string
  /** This joining's own nonce (the host mints it at the registration): the confirm and the decline name it. */
  readonly instance: string
  /** Six digits in two groups, derived HERE from `keyHash` (the same rule the edge and the new device use). */
  readonly phrase: string
  readonly registeredAt: number
  readonly expiresAt: number
}

export type DevicesRead =
  | { readonly kind: 'reading' }
  | {
    readonly kind: 'live'
    readonly generation: number
    /** The host's clock when it answered, and this page's `performance.now()` when the answer arrived. */
    readonly hostNow: number
    readonly receivedAt: number
    readonly limit: number
    readonly primary: { readonly id: string; readonly boundAt: number; readonly lastVerifiedAt: number }
    readonly devices: readonly DeviceEntry[]
    readonly pending: { readonly label: string; readonly expiresAt: number } | null
    readonly joining: DeviceJoining | null
  }
  | { readonly kind: 'unread'; readonly text: string }

const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const credentialId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,2048}$/u.test(value)
const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null

const sha256Hex = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value)
/** A joining instance: 32 bytes in base64url (43 characters, the last one of the canonical set). */
const instanceId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u.test(value)

/**
 * THE CONFIRMATION PHRASE: six digits from the first four bytes of the key hash, in two groups of three
 * (`deviceKeyPhrase` in deploy/cloudflare/src/passkey-devices.mjs, which the new device's page shows).
 * @param keyHash - 64 lowercase hex.
 * @returns for example '048 213'.
 */
export function devicePhrase(keyHash: string): string {
  const digits = String(Number.parseInt(keyHash.slice(0, 8), 16) % 1_000_000).padStart(6, '0')
  return `${digits.slice(0, 3)} ${digits.slice(3)}`
}

/** A device label the host accepts: letters, digits, spaces and a little punctuation, trimmed, 1-40 characters. */
export function deviceLabelValid(value: string): boolean {
  return value === value.trim() && value.length >= 1 && value.length <= DEVICE_LABEL_MAX && /^[\p{L}\p{N} .,'()_-]+$/u.test(value)
}

/**
 * Read the host's devices answer strictly; any other shape is unread, never guessed.
 * @param answer - the host's answer to GET /_host/aumlok/devices.
 * @param receivedAt - `performance.now()` when it arrived.
 * @returns the devices, or why they could not be read.
 */
export function readDevicesAnswer(answer: HostAnswer, receivedAt: number): DevicesRead {
  if (answer.kind === 'absent') return { kind: 'unread', text: `NOT CONNECTED YET: ${answer.detail}` }
  if (answer.kind === 'refused') return { kind: 'unread', text: deviceRefusalWords(answer.code, answer.retryAfterSeconds) }
  const body = answer.body
  const primary = record(body.primary)
  const pending = body.pending === null ? null : record(body.pending)
  const devices = Array.isArray(body.devices) ? body.devices.map(record) : null
  // `joining` is absent from a host before the confirm step; any present value must read exactly, phrase included.
  const joining = body.joining === undefined || body.joining === null ? null : record(body.joining)
  if (body.schema !== 'aukora.aumlok.devices.v1' || !count(body.generation) || body.generation < 1 || !count(body.hostNow) || !count(body.limit)
    || primary === null || !credentialId(primary.id) || !count(primary.boundAt) || !count(primary.lastVerifiedAt)
    || devices === null || devices.length > body.limit || devices.some(item => item === null || !credentialId(item.id) || typeof item.label !== 'string'
      || !count(item.addedAt) || !count(item.lastVerifiedAt))
    || (body.pending !== null && (pending === null || typeof pending.label !== 'string' || !count(pending.expiresAt)))
    || (body.joining !== undefined && body.joining !== null && (joining === null || !credentialId(joining.id) || typeof joining.label !== 'string'
      || !sha256Hex(joining.keyHash) || !instanceId(joining.instance) || joining.phrase !== devicePhrase(joining.keyHash)
      || !count(joining.registeredAt) || !count(joining.expiresAt)))) {
    return { kind: 'unread', text: `${DEVICES_ROUTE} answered a shape this page does not read.` }
  }
  return { kind: 'live', generation: body.generation, hostNow: body.hostNow, receivedAt, limit: body.limit,
    primary: { id: primary.id, boundAt: primary.boundAt, lastVerifiedAt: primary.lastVerifiedAt },
    devices: (devices as Record<string, unknown>[]).map(item => ({ id: item.id as string, label: item.label as string,
      addedAt: item.addedAt as number, lastVerifiedAt: item.lastVerifiedAt as number })),
    pending: pending === null ? null : { label: pending.label as string, expiresAt: pending.expiresAt as number },
    joining: joining === null ? null : { id: joining.id as string, label: joining.label as string, keyHash: joining.keyHash as string,
      instance: joining.instance as string, phrase: devicePhrase(joining.keyHash as string), registeredAt: joining.registeredAt as number,
      expiresAt: joining.expiresAt as number } }
}

/**
 * Ask the host for the enrolled devices.
 * @param signal - aborts the read.
 * @param call - the host call (tests pass their own).
 * @returns the devices, or why not.
 */
export async function readDevices(signal: AbortSignal, call: typeof hostCall = hostCall): Promise<DevicesRead> {
  return readDevicesAnswer(await call(DEVICES_ROUTE, signal), performance.now())
}

/** The host's clock now, from its answer plus the time since on this page's own clock. */
const hostNowOf = (read: Extract<DevicesRead, { kind: 'live' }>, now: number): number => read.hostNow + Math.max(0, Math.round(now - read.receivedAt))

/**
 * The exact body the passkey approves for a new code: action, label, expiry (ten minutes on the host's clock, less a
 * few seconds for the approval itself) and the identity generation.
 */
export function deviceCodeBody(read: Extract<DevicesRead, { kind: 'live' }>, label: string, now: number = performance.now()) {
  return { action: DEVICE_ADD_ACTION, label, expiresAt: hostNowOf(read, now) + DEVICE_CODE_LIFE_MS - 5_000, generation: read.generation }
}

/** The exact body the passkey approves to remove one device. */
export function deviceRemoveBody(read: Extract<DevicesRead, { kind: 'live' }>, deviceId: string) {
  return { action: DEVICE_REMOVE_ACTION, deviceId, generation: read.generation }
}

export interface DeviceCodeMade {
  readonly code: string
  readonly link: string
  readonly label: string
  readonly expiresAt: number
  readonly sameUserHandle: boolean
}

/**
 * One step's outcome. `unknown: true` means the answer was lost (no answer, no words, a server failure): the host may
 * or may not have done it, so the caller says so and reads the list again; it never says "nothing changed".
 */
export type DeviceStep<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: string; readonly unknown?: true }

/** The words for an answer that was lost. */
export const DEVICE_OUTCOME_UNKNOWN = 'The answer was lost, so this page cannot tell whether it was done. The list below is read again and shows what the node holds now.'
/** The step for a lost answer. */
const lost = (): { readonly ok: false; readonly reason: string; readonly unknown: true } =>
  ({ ok: false, reason: DEVICE_OUTCOME_UNKNOWN, unknown: true })
/** A refusal the host answered in words (a 4xx, or 507 full, with its own code): the host's transaction changed nothing. */
const refusedInWords = (status: number, code: unknown): code is string =>
  ((status >= 400 && status < 500) || status === 507) && typeof code === 'string' && /^[A-Za-z0-9_:-]{1,80}$/u.test(code)

export interface DeviceDependencies extends Class3Dependencies {
  readonly origin?: string
  readonly fetchImpl?: typeof fetch
}

/** Approve one exact POST with an enrolled passkey, then send it with the approval. */
async function approvedPost(pathname: string, body: Record<string, unknown>,
  deps: DeviceDependencies): Promise<DeviceStep<Record<string, unknown>>> {
  const action = await class3Action({ audience: deps.origin ?? location.origin, method: 'POST', pathname, body })
  // The approval's own host calls are watched only for the wait a capacity refusal names (the words say it).
  const call = deps.call ?? hostCall
  let wait: number | undefined
  const watched: typeof hostCall = async (route, signal, sentBody) => {
    const answer = await call(route, signal, sentBody)
    wait = answer.kind === 'refused' ? answer.retryAfterSeconds : undefined
    return answer
  }
  const approval = await approveClass3(action, { ...deps, call: watched })
  if (!approval.ok) return { ok: false, reason: deviceRefusalWords(approval.reason, wait) }
  let sent: Awaited<ReturnType<typeof sendApprovedClass3>>
  try {
    sent = await sendApprovedClass3(approval, body, deps.signal, deps.fetchImpl)
  } catch (error) {
    if (deps.signal.aborted) throw error
    return lost()
  }
  if (sent.status === 200 && sent.body !== null && sent.body.ok === true) return { ok: true, value: sent.body }
  const code = sent.body?.code
  if (!refusedInWords(sent.status, code)) return lost()
  return { ok: false, reason: deviceRefusalWords(code, retryAfterOf(sent.body).retryAfterSeconds) }
}

/**
 * Make a one-time code for another device (one passkey approval on the exact body).
 * @param read - the live devices read (its generation and the host's clock).
 * @param label - the owner's name for the new device.
 * @param deps - the host call, the passkey, the abort signal.
 * @returns the code and its link, or why not.
 */
export async function makeDeviceCode(read: Extract<DevicesRead, { kind: 'live' }>, label: string, deps: DeviceDependencies): Promise<DeviceStep<DeviceCodeMade>> {
  if (!deviceLabelValid(label)) return { ok: false, reason: 'Name the device with 1 to 40 letters, digits or spaces.' }
  if (read.devices.length >= read.limit) return { ok: false, reason: deviceRefusalWords('AUMLOK_DEVICE_CAPACITY') }
  if (read.joining !== null) return { ok: false, reason: deviceRefusalWords('AUMLOK_DEVICE_JOIN_WAITING') }
  const sent = await approvedPost(DEVICE_CODE_ROUTE, deviceCodeBody(read, label), deps)
  if (!sent.ok) return sent
  const body = sent.value
  const origin = deps.origin ?? location.origin
  if (typeof body.code !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(body.code) || body.link !== `${origin}${DEVICE_ADD_PAGE}#${body.code}`
    || typeof body.label !== 'string' || !count(body.expiresAt)) return { ok: false, reason: 'The host answered a code this page does not read.' }
  return { ok: true, value: { code: body.code, link: body.link, label: body.label, expiresAt: body.expiresAt,
    sameUserHandle: body.sameUserHandle === true } }
}

/**
 * Remove one added device (one passkey approval, by the first passkey or a DIFFERENT device).
 * @param read - the live devices read.
 * @param deviceId - the device's credential id.
 * @param deps - the host call, the passkey, the abort signal.
 * @returns how many devices remain, or why not.
 */
export async function removeDevice(read: Extract<DevicesRead, { kind: 'live' }>, deviceId: string, deps: DeviceDependencies): Promise<DeviceStep<number>> {
  const sent = await approvedPost(DEVICE_REMOVE_ROUTE, deviceRemoveBody(read, deviceId), deps)
  if (!sent.ok) return sent
  return count(sent.value.deviceCount) ? { ok: true, value: sent.value.deviceCount } : lost()
}

/** The exact body the passkey approves to confirm THIS joining: its id, its key hash (the phrase) and its instance. */
export function deviceConfirmBody(read: Extract<DevicesRead, { kind: 'live' }>, joining: DeviceJoining) {
  return { action: DEVICE_CONFIRM_ACTION, deviceId: joining.id, keyHash: joining.keyHash, instance: joining.instance,
    generation: read.generation }
}

/** The exact body that declines THIS joining (no passkey: it was never enrolled). */
export function deviceDeclineBody(read: Extract<DevicesRead, { kind: 'live' }>, joining: DeviceJoining) {
  return { action: DEVICE_DECLINE_ACTION, deviceId: joining.id, instance: joining.instance, generation: read.generation }
}

/**
 * Confirm the new device that asks to join: one passkey approval naming its id, its key hash (the phrase) and its instance.
 * @param read - the live devices read.
 * @param joining - the device that asks to join, as this page read it.
 * @param deps - the host call, the passkey, the abort signal.
 * @returns how many devices are now added, or why not.
 */
export async function confirmDevice(read: Extract<DevicesRead, { kind: 'live' }>, joining: DeviceJoining, deps: DeviceDependencies): Promise<DeviceStep<number>> {
  const sent = await approvedPost(DEVICE_CONFIRM_ROUTE, deviceConfirmBody(read, joining), deps)
  if (!sent.ok) return sent
  return count(sent.value.deviceCount) ? { ok: true, value: sent.value.deviceCount } : lost()
}

/**
 * Decline the new device that asks to join (the owner's session is enough: it was never enrolled).
 * @param read - the live devices read.
 * @param joining - the device to turn away.
 * @param deps - the host call and the abort signal.
 * @returns done, or why not.
 */
export async function declineDevice(read: Extract<DevicesRead, { kind: 'live' }>, joining: DeviceJoining, deps: DeviceDependencies): Promise<DeviceStep<true>> {
  const answer = await (deps.call ?? hostCall)(DEVICE_DECLINE_ROUTE, deps.signal, deviceDeclineBody(read, joining))
  if (answer.kind === 'live') return { ok: true, value: true }
  if (answer.kind === 'refused' && refusedInWords(answer.status, answer.code)) return { ok: false, reason: deviceRefusalWords(answer.code, answer.retryAfterSeconds) }
  return lost()
}

/**
 * Plain words for the host's device codes; anything else keeps its code.
 * @param code - the host's code (a passkey approval's own carries `class3:`).
 * @param retryAfterSeconds - the wait a capacity refusal named, if the host sent one.
 * @returns the sentence.
 */
export function deviceRefusalWords(code: string, retryAfterSeconds?: number): string {
  const capacity = capacityWords(code.replace(/^class3:/u, ''), retryAfterSeconds)
  if (capacity !== null) return `${capacity} Nothing changed.`
  const words: Record<string, string> = {
    AUMLOK_DEVICE_CAPACITY: 'This identity already holds the most devices it can. Remove one first.',
    AUMLOK_DEVICE_REMOVE_NEEDS_OTHER_PASSKEY: 'A device cannot remove itself. Approve with your first passkey or another device.',
    AUMLOK_DEVICE_PRIMARY_NOT_REMOVABLE: 'The first passkey cannot be removed here.',
    AUMLOK_DEVICE_GENERATION_STALE: 'Your identity changed since this list was read. Read it again and retry.',
    AUMLOK_DEVICE_EXPIRY_INVALID: 'The host and this page disagree about the time. Read the list again and retry.',
    AUMLOK_DEVICE_NOT_FOUND: 'That device is no longer on the list.',
    AUMLOK_DEVICE_JOIN_NOT_FOUND: 'That new device is no longer waiting (it expired, or was confirmed or declined). Nothing changed.',
    AUMLOK_DEVICE_KEY_ALREADY_ENROLLED: 'That passkey is already enrolled under another name. Nothing changed.',
    AUMLOK_DEVICE_ALREADY_ENROLLED: 'That passkey is already enrolled. Nothing changed.',
    AUMLOK_DEVICE_CODE_REVOKED: 'The device that made this code was removed, so its new device cannot join. Nothing changed.',
    AUMLOK_DEVICE_JOIN_WAITING: 'A new device is asking to join. Confirm or decline it first. Nothing changed.',
    AUMLOK_NOT_BOUND: 'This node has no bound passkey yet.',
    CLASS3_WEBAUTHN_REQUIRED: 'The passkey approval was not accepted. Nothing changed.',
    OWNER_ACCESS_REQUIRED: 'Sign in as the owner to manage devices.',
  }
  return words[code] ?? (code.startsWith('class3:') ? `The passkey approval did not complete (${code.slice(7)}). Nothing changed.` : `The host refused (${code}). Nothing changed.`)
}
