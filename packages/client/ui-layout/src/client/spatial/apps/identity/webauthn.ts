// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The Aukora authors
/**
 * THE PASSKEY (TOUCH ID) CEREMONY, IN THE PAGE, ON THE HOST'S OWN CHALLENGE.
 *
 * Ported from the predecessor's owner passkey pane (an earlier repository) without its owner
 * frame: x6.1 serves the Spatial page itself, so the ceremony runs here, and the only sheet is the browser's own OS
 * prompt. This module never invents a challenge, a user handle or a result: it decodes exactly what the host sent,
 * asks the browser, checks the browser's client data names that same challenge and this origin, and returns the
 * public credential material for the host to judge. It holds no private key and decides nothing.
 * @module apps/identity/webauthn
 */

import { asArray, asNumber, asRecord, asString } from '../../x5/rpc.ts'

/** The transports the node keeps from a registration (`PASSKEY_STORED_TRANSPORTS` in deploy/cloudflare/src/passkey-devices.mjs). */
const STORED_TRANSPORTS: readonly string[] = ['usb', 'nfc', 'ble', 'internal', 'hybrid']

/** RFC 4648 base64url without padding. */
export function base64url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Decode base64url (padding optional); `null` when it is not canonical base64url. */
export function fromBase64url(value: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) return null
  let binary: string
  try { binary = atob(value.replace(/-/g, '+').replace(/_/g, '/')) } catch { return null }
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0))
  return base64url(bytes) === value.replace(/=+$/, '') ? bytes : null
}

/** Why a ceremony cannot start in this page, or `null` when the browser can run one. */
export function passkeyBlocker(): string | null {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return 'no browser window'
  if (!window.isSecureContext) return 'this page is not a secure context (passkeys need https or localhost)'
  if (typeof PublicKeyCredential === 'undefined' || typeof (navigator.credentials as CredentialsContainer | undefined)?.create !== 'function'
    || typeof navigator.credentials.get !== 'function') return 'this browser has no WebAuthn (passkey) support'
  const host = location.hostname
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':') || host.startsWith('[')) {
    return `passkeys refuse an IP address origin (${host}); open this page as http://localhost:${location.port || '80'}`
  }
  return null
}

/** One ceremony the host asked for: its id (when it gave one) and the browser options decoded from its JSON. */
export type PasskeyChallenge =
  | {
    readonly kind: 'register'
    readonly ceremonyId: string | null
    readonly challenge: Uint8Array<ArrayBuffer>
    readonly options: PublicKeyCredentialCreationOptions
  }
  | {
    readonly kind: 'verify'
    readonly ceremonyId: string | null
    readonly challenge: Uint8Array<ArrayBuffer>
    readonly options: PublicKeyCredentialRequestOptions
  }

/** What the host sends back to judge: the standard WebAuthn response JSON, nothing derived on this side. */
export interface PasskeyResponseJson {
  readonly id: string
  readonly rawId: string
  readonly type: 'public-key'
  readonly authenticatorAttachment: string | null
  readonly response: Record<string, string | null | readonly string[]>
  readonly clientExtensionResults: Record<string, unknown>
}

class PasskeyError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'PasskeyError'
  }
}

const descriptor = (value: unknown): PublicKeyCredentialDescriptor | null => {
  const record = asRecord(value)
  const id = fromBase64url(asString(record.id) ?? asString(value) ?? '')
  if (id === null || id.byteLength === 0) return null
  const transports = asArray(record.transports).map(asString).filter((item): item is string => item !== null)
  return { type: 'public-key', id, ...(transports.length > 0 ? { transports: transports as AuthenticatorTransport[] } : {}) }
}

const descriptors = (value: unknown): PublicKeyCredentialDescriptor[] | null => {
  const list = asArray(value).map(descriptor)
  return list.some(item => item === null) ? null : list.filter((item): item is PublicKeyCredentialDescriptor => item !== null)
}

/**
 * The prompt's timeout: the host's, never longer. A host value that is not a whole number of milliseconds up to ten
 * minutes reads as one minute (as before); a whole number from 1 ms is kept as it is, because a SHORT one is what is left
 * of the node's ceremony (`hostCall` takes the request's own time off it): lengthening it would open a prompt that
 * outlives the node's deadline, whose answer is then refused as late. Nothing left: the prompt is never opened.
 * @throws PasskeyError 'challenge-ran-out' when the host's timeout is zero or less.
 */
const timeout = (value: unknown): number => {
  const ms = asNumber(value)
  if (ms !== null && Number.isFinite(ms) && ms <= 0) {
    throw new PasskeyError('challenge-ran-out', 'The Touch ID request ran out of time before the prompt could open. Nothing was sent or counted.')
  }
  return ms !== null && Number.isInteger(ms) && ms >= 1 && ms <= 600_000 ? ms : 60_000
}

/**
 * True when a ceremony was never asked because its time ran out on the way (nothing was sent, nothing counted).
 * @param error - what `readChallenge` threw.
 * @returns whether it is that.
 */
export const passkeyRanOut = (error: unknown): boolean => error instanceof PasskeyError && error.code === 'challenge-ran-out'

/**
 * Read the host's challenge answer into browser options. Accepts the options at `publicKey`, `options` or the top level
 * (WebAuthn's `PublicKeyCredential*OptionsJSON` shape: base64url strings for binary fields).
 * @param kind - which ceremony was asked for.
 * @param body - the host's JSON answer.
 * @returns the decoded challenge.
 * @throws PasskeyError when the challenge, or (to register) the user handle, is missing or not base64url.
 */
export function readChallenge(kind: 'register' | 'verify', body: unknown): PasskeyChallenge {
  const top = asRecord(body)
  const json = asRecord(top.publicKey ?? top.options ?? top)
  const ceremonyId = asString(top.ceremonyId) ?? asString(top.challengeId)
  const challenge = fromBase64url(asString(json.challenge) ?? '')
  if (challenge === null || challenge.byteLength < 16 || challenge.byteLength > 1024) {
    throw new PasskeyError('challenge-missing', 'The host answer carries no base64url challenge of 16 bytes or more.')
  }
  const allow = descriptors(json.allowCredentials)
  const exclude = descriptors(json.excludeCredentials)
  if (allow === null || exclude === null) throw new PasskeyError('credential-id', 'The host listed a credential id that is not base64url.')
  if (kind === 'verify') {
    const rpId = asString(json.rpId)
    const userVerification = asString(json.userVerification) ?? 'required'
    return {
      kind, ceremonyId, challenge, options: {
        challenge, timeout: timeout(json.timeout), userVerification: userVerification as UserVerificationRequirement,
        ...(rpId === null ? {} : { rpId }), ...(allow.length > 0 ? { allowCredentials: allow } : {}),
      },
    }
  }
  const user = asRecord(json.user)
  const userId = fromBase64url(asString(user.id) ?? '')
  const name = asString(user.name)
  const displayName = asString(user.displayName) ?? name
  if (userId === null || userId.byteLength < 1 || userId.byteLength > 64 || name === null || name === '' || displayName === null) {
    throw new PasskeyError('user-handle', 'The host answer carries no user handle (user.id, user.name) to register.')
  }
  const rp = asRecord(json.rp)
  const rpId = asString(rp.id)
  const algorithms = asArray(json.pubKeyCredParams).map(item => asNumber(asRecord(item).alg)).filter((alg): alg is number => alg !== null)
  const selection = asRecord(json.authenticatorSelection)
  const attachment = asString(selection.authenticatorAttachment)
  return {
    kind, ceremonyId, challenge, options: {
      challenge,
      rp: { name: asString(rp.name) ?? 'AUKORA', ...(rpId === null ? {} : { id: rpId }) },
      user: { id: userId, name, displayName },
      pubKeyCredParams: (algorithms.length > 0 ? algorithms : [-7, -8, -257]).map(alg => ({ type: 'public-key' as const, alg })),
      authenticatorSelection: {
        residentKey: (asString(selection.residentKey) ?? 'preferred') as ResidentKeyRequirement,
        userVerification: (asString(selection.userVerification) ?? 'required') as UserVerificationRequirement,
        ...(attachment === null ? {} : { authenticatorAttachment: attachment as AuthenticatorAttachment }),
      },
      attestation: (asString(json.attestation) ?? 'none') as AttestationConveyancePreference,
      timeout: timeout(json.timeout),
      ...(exclude.length > 0 ? { excludeCredentials: exclude } : {}),
    },
  }
}

const buffer = (value: ArrayBuffer): string => base64url(new Uint8Array(value))

/** The browser's own client data must name the host's exact challenge, this ceremony and this page's origin. */
function checkClientData(raw: ArrayBuffer, type: 'webauthn.create' | 'webauthn.get', challenge: Uint8Array): void {
  let data: Record<string, unknown>
  try { data = asRecord(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw))) } catch {
    throw new PasskeyError('client-data', 'The browser returned unreadable client data.')
  }
  if (data.type !== type || data.challenge !== base64url(challenge)) {
    throw new PasskeyError('challenge-mismatch', 'The browser signed a different challenge than the host sent.')
  }
  if (data.origin !== location.origin || data.crossOrigin === true) {
    throw new PasskeyError('origin-mismatch', `The browser bound the passkey to ${String(data.origin)}, not ${location.origin}.`)
  }
}

/**
 * Run one ceremony: the browser's own passkey sheet (Touch ID on a Mac) on exactly the host's challenge.
 * @param step - the decoded host challenge.
 * @param signal - aborts the browser prompt.
 * @returns the standard WebAuthn response JSON for the host to verify.
 * @throws PasskeyError or the browser's DOMException (NotAllowedError when cancelled or timed out).
 */
export async function runPasskey(step: PasskeyChallenge, signal: AbortSignal): Promise<PasskeyResponseJson> {
  const blocker = passkeyBlocker()
  if (blocker !== null) throw new PasskeyError('webauthn-unavailable', blocker)
  const credential = step.kind === 'register'
    ? await navigator.credentials.create({ publicKey: step.options, signal })
    : await navigator.credentials.get({ publicKey: step.options, signal })
  if (!(credential instanceof PublicKeyCredential) || credential.type !== 'public-key') {
    throw new PasskeyError('no-credential', 'The browser returned no passkey.')
  }
  const rawId = buffer(credential.rawId)
  if (credential.id !== rawId) throw new PasskeyError('credential-id', 'The browser returned an inconsistent credential id.')
  const response = credential.response
  checkClientData(response.clientDataJSON, step.kind === 'register' ? 'webauthn.create' : 'webauthn.get', step.challenge)
  const common = { id: rawId, rawId, type: 'public-key' as const, authenticatorAttachment: credential.authenticatorAttachment,
    clientExtensionResults: asRecord(credential.getClientExtensionResults()) }
  if (step.kind === 'register') {
    if (!(response instanceof AuthenticatorAttestationResponse)) throw new PasskeyError('no-attestation', 'The browser returned no attestation.')
    // Only the names the node's bind verifier keeps (aumlok.mjs); any other a browser reports is left out, so it can never
    // refuse a bind. The node stores these to tell a browser later how to reach this passkey.
    const transports = (typeof response.getTransports === 'function' ? response.getTransports() : [])
      .filter(item => STORED_TRANSPORTS.includes(item))
    return { ...common, response: {
      clientDataJSON: buffer(response.clientDataJSON), attestationObject: buffer(response.attestationObject), transports,
    } }
  }
  if (!(response instanceof AuthenticatorAssertionResponse)) throw new PasskeyError('no-assertion', 'The browser returned no assertion.')
  return { ...common, response: {
    clientDataJSON: buffer(response.clientDataJSON), authenticatorData: buffer(response.authenticatorData),
    signature: buffer(response.signature), userHandle: response.userHandle === null ? null : buffer(response.userHandle),
  } }
}

/** A plain sentence for a failed ceremony (the predecessor's `refusal`, plus the code when it is ours). */
export function passkeyFailure(error: unknown): string {
  if (error instanceof DOMException) {
    if (error.name === 'NotAllowedError' || error.name === 'AbortError') return 'Passkey cancelled or timed out. Nothing was sent.'
    if (error.name === 'InvalidStateError') return 'This device already holds a passkey for this owner.'
    if (error.name === 'SecurityError') return `The browser refused this origin for passkeys (${error.message}).`
    return `${error.name}: ${error.message}`
  }
  if (error instanceof PasskeyError) return `${error.message} (${error.code})`
  return error instanceof Error ? error.message : String(error)
}
