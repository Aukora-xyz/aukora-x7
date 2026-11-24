// @vitest-environment jsdom
/**
 * The two capacity refusals on the Identity surface (too many Touch ID requests open; too many approvals in five
 * minutes) say the wait the node now sends (`retryAfterSeconds`, deploy/cloudflare/src/aumlok.mjs), and say the most it
 * can be when it sends none. Neither is a failed try. Read through the real `hostCall`, the real Class 3 approval and the
 * devices and invite steps; the host and the passkey are fakes.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { capacityWords, hostCall, retryAfterOf, RETRY_AFTER_MAX_SECONDS, type HostAnswer } from '../src/client/spatial/apps/identity/host.ts'
import { DEVICE_REMOVE_ROUTE, DEVICES_ROUTE, deviceRefusalWords, readDevicesAnswer, removeDevice, type DevicesRead } from '../src/client/spatial/apps/identity/devices.ts'
import { DevicesPortal } from '../src/client/spatial/apps/identity/DevicesPortal.tsx'
import { inviteRefusalWords, revokeInvite, type InviteStatus } from '../src/client/spatial/apps/identity/invite.ts'
import type { AumlokPlatform } from '../src/client/spatial/aumlok/aumlok-ceremony.ts'
import { resetApprovalsForTests } from '../src/client/spatial/portal/touch-id-timing.ts'

const ORIGIN = 'https://capacity.example.invalid'
const PRIMARY = 'cHJpbWFyeS1jcmVkZW50aWFsLWlk'
const PHONE = 'cGhvbmUtY3JlZGVudGlhbC1pZA'
const CHALLENGE = '/_host/aumlok/challenge'
const APPROVE = '/_host/aumlok/approve'
const answerBody = () => ({ ok: true, schema: 'aukora.aumlok.devices.v1', generation: 3, hostNow: 1_800_000_000_000, limit: 4,
  primary: { id: PRIMARY, boundAt: 1_790_000_000_000, lastVerifiedAt: 1_799_000_000_000 },
  devices: [{ id: PHONE, label: 'Phone', addedAt: 1_795_000_000_000, lastVerifiedAt: 1_796_000_000_000 }], pending: null })
const liveRead = () => readDevicesAnswer({ kind: 'live', route: DEVICES_ROUTE, body: answerBody() }, performance.now()) as Extract<DevicesRead, { kind: 'live' }>
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const signal = () => new AbortController().signal
const platform: AumlokPlatform = {
  passkeyBlocker: () => null,
  passkey: async () => ({ id: PRIMARY, rawId: PRIMARY, type: 'public-key', authenticatorAttachment: 'platform', clientExtensionResults: {},
    response: { clientDataJSON: 'e30', authenticatorData: 'AA', signature: 'AA', userHandle: null } }),
  nodeKeys: async () => true,
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); resetApprovalsForTests() })

/** A fake host for the Class 3 approval: the challenge, then the approve step, each answered as the test says (real hostCall). */
function approvalHost(challenge: () => Response, approve: () => Response) {
  let binding: unknown = null
  const fetchStub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = typeof input === 'string' ? input : input instanceof URL ? input.pathname : input.url
    if (path === DEVICES_ROUTE) return json(answerBody())
    if (path === CHALLENGE) {
      binding = (JSON.parse(typeof init?.body === 'string' ? init.body : 'null') as { binding: unknown }).binding
      const made = challenge()
      if (made.status !== 200) return made
      return json({ ok: true, challengeId: 'c'.repeat(43), binding, publicKey: { challenge: 'Y2hhbGxlbmdlLWJ5dGVzLTE2Kw', rpId: location.hostname,
        allowCredentials: [{ type: 'public-key', id: PRIMARY }], userVerification: 'required', timeout: 120000 } })
    }
    if (path === APPROVE) {
      const made = approve()
      if (made.status !== 200) return made
      return json({ ok: true, approvalToken: Buffer.alloc(32, 7).toString('base64url'), expiresAt: Date.now() + 300000, approvedAt: Date.now(), binding })
    }
    return json({ ok: true, deviceCount: 0 })
  })
  return fetchStub
}

describe('the wait, read from the host', () => {
  it('hostCall keeps a whole number of seconds from 1 to an hour from a refusal, and nothing else', async () => {
    for (const [sent, kept] of [[37, 37], [1, 1], [RETRY_AFTER_MAX_SECONDS, RETRY_AFTER_MAX_SECONDS], [0, undefined], [-5, undefined],
      [1.5, undefined], ['30', undefined], [RETRY_AFTER_MAX_SECONDS + 1, undefined], [null, undefined]] as const) {
      vi.stubGlobal('fetch', vi.fn(async () => json({ ok: false, code: 'AUMLOK_CHALLENGE_CAPACITY', retryAfterSeconds: sent }, 429)))
      const answer = await hostCall(CHALLENGE, signal(), {})
      expect(answer.kind).toBe('refused')
      expect(answer.kind === 'refused' ? answer.retryAfterSeconds : 'not refused', JSON.stringify(sent)).toBe(kept)
      expect(Object.hasOwn(answer, 'retryAfterSeconds'), JSON.stringify(sent)).toBe(kept !== undefined)
    }
    vi.stubGlobal('fetch', vi.fn(async () => json({ ok: false, code: 'AUMLOK_CHALLENGE_CAPACITY' }, 429)))
    expect(await hostCall(CHALLENGE, signal(), {}))
      .toEqual({ kind: 'refused', route: CHALLENGE, status: 429, code: 'AUMLOK_CHALLENGE_CAPACITY', message: 'refused' })
    // The AUMLOK store's own 404/405 refusal keeps it too.
    vi.stubGlobal('fetch', vi.fn(async () => json({ ok: false, code: 'AUMLOK_APPROVAL_CAPACITY', retryAfterSeconds: 12 }, 404)))
    expect(await hostCall(APPROVE, signal(), {})).toMatchObject({ kind: 'refused', code: 'AUMLOK_APPROVAL_CAPACITY', retryAfterSeconds: 12 })
    expect(retryAfterOf(null)).toEqual({})
  })

  it('says the wait in seconds for both codes, the most it can be without one, and never a failed try', () => {
    expect(capacityWords('AUMLOK_CHALLENGE_CAPACITY', 37)).toBe('Too many Touch ID requests are open. Wait 37 seconds, then try again. This is not counted as a failed try.')
    expect(capacityWords('AUMLOK_CHALLENGE_CAPACITY', 1)).toMatch(/Wait 1 second, then try again\./)
    expect(capacityWords('AUMLOK_CHALLENGE_CAPACITY')).toBe('Too many Touch ID requests are open. Wait two minutes. This is not counted as a failed try.')
    expect(capacityWords('AUMLOK_APPROVAL_CAPACITY', 240)).toBe('Too many Touch ID approvals were made in the last five minutes. Wait 240 seconds, then try again. '
      + 'This is not counted as a failed try.')
    expect(capacityWords('AUMLOK_APPROVAL_CAPACITY')).toBe('Too many Touch ID approvals were made in the last five minutes. Wait up to five minutes, then try again. '
      + 'This is not counted as a failed try.')
    expect(capacityWords('AUMLOK_RATE_LIMITED', 30)).toBeNull()
    for (const text of [capacityWords('AUMLOK_CHALLENGE_CAPACITY', 5), capacityWords('AUMLOK_APPROVAL_CAPACITY')]) expect(text).not.toMatch(/token/i)
  })
})

describe('your devices', () => {
  it('a full challenge slot at the approval says its wait (and the most it can be without one); nothing is sent', async () => {
    for (const [body, words] of [[{ ok: false, code: 'AUMLOK_CHALLENGE_CAPACITY', retryAfterSeconds: 37 }, /Wait 37 seconds, then try again\./],
      [{ ok: false, code: 'AUMLOK_CHALLENGE_CAPACITY' }, /Wait two minutes\./]] as const) {
      const fetchStub = approvalHost(() => json(body, 429), () => json({}))
      vi.stubGlobal('fetch', fetchStub)
      const step = await removeDevice(liveRead(), PHONE, { signal: signal(), platform, origin: ORIGIN, fetchImpl: fetchStub })
      expect(step.ok).toBe(false)
      const reason = step.ok ? '' : step.reason
      expect(reason).toMatch(/^Too many Touch ID requests are open\. /)
      expect(reason).toMatch(words)
      expect(reason).toMatch(/This is not counted as a failed try\. Nothing changed\.$/)
      expect(fetchStub.mock.calls.some(([input]) => input === DEVICE_REMOVE_ROUTE)).toBe(false)
    }
  })

  it('a full approval record says its wait (and the most it can be without one)', async () => {
    for (const [body, words] of [[{ ok: false, code: 'AUMLOK_APPROVAL_CAPACITY', retryAfterSeconds: 240 }, /Wait 240 seconds, then try again\./],
      [{ ok: false, code: 'AUMLOK_APPROVAL_CAPACITY' }, /Wait up to five minutes, then try again\./]] as const) {
      const fetchStub = approvalHost(() => json({}), () => json(body, 429))
      vi.stubGlobal('fetch', fetchStub)
      const step = await removeDevice(liveRead(), PHONE, { signal: signal(), platform, origin: ORIGIN, fetchImpl: fetchStub })
      const reason = step.ok ? '' : step.reason
      expect(reason).toMatch(/^Too many Touch ID approvals were made in the last five minutes\. /)
      expect(reason).toMatch(words)
      expect(fetchStub.mock.calls.some(([input]) => input === DEVICE_REMOVE_ROUTE)).toBe(false)
    }
  })

  it('the words are the same whether the code carries the approval\'s prefix or not; other codes are unchanged', () => {
    expect(deviceRefusalWords('class3:AUMLOK_CHALLENGE_CAPACITY', 9)).toBe(deviceRefusalWords('AUMLOK_CHALLENGE_CAPACITY', 9))
    expect(deviceRefusalWords('class3:AUMLOK_APPROVAL_CAPACITY')).toMatch(/Wait up to five minutes/)
    expect(deviceRefusalWords('class3:AUMLOK_RATE_LIMITED', 9)).toBe('The passkey approval did not complete (AUMLOK_RATE_LIMITED). Nothing changed.')
    expect(deviceRefusalWords('AUMLOK_DEVICE_NOT_FOUND', 9)).toBe('That device is no longer on the list.')
  })

  it('the portal shows the wait in its notice when a removal meets a full challenge slot', async () => {
    vi.stubGlobal('isSecureContext', true)
    vi.stubGlobal('PublicKeyCredential', function FakeCredential() { /* only its presence is read */ })
    Object.defineProperty(navigator, 'credentials', { value: { create: vi.fn(), get: vi.fn() }, configurable: true })
    vi.stubGlobal('fetch', approvalHost(() => json({ ok: false, code: 'AUMLOK_CHALLENGE_CAPACITY', retryAfterSeconds: 58 }, 429), () => json({})))
    try {
      const view = render(<DevicesPortal active />)
      fireEvent.click(view.getByText('Your devices'))
      await waitFor(() => { expect(view.container.querySelector(`[data-identity-device-remove="${PHONE}"]`)).not.toBeNull() })
      fireEvent.click(view.container.querySelector(`[data-identity-device-remove="${PHONE}"]`) as Element)
      await waitFor(() => { expect(view.container.querySelector('[data-identity-device-notice]')).not.toBeNull() })
      expect(view.container.querySelector('[data-identity-device-notice]')?.textContent)
        .toBe('Too many Touch ID requests are open. Wait 58 seconds, then try again. This is not counted as a failed try. Nothing changed.')
    } finally {
      Reflect.deleteProperty(navigator, 'credentials')
    }
  })
})

describe('invites', () => {
  const status = { status: { nodePubkeyHex: 'a'.repeat(64) } } as unknown as InviteStatus
  const refusingCall = (answer: HostAnswer) => vi.fn(async (): Promise<HostAnswer> => answer)

  it('a challenge refusal for capacity keeps the wait on the step, and the words say it; without one, the most it can be', async () => {
    const withWait = await revokeInvite({ requestId: 'r'.repeat(22), inviteId: 'A'.repeat(43) }, () => null, status,
      { signal: signal(), platform, call: refusingCall({ kind: 'refused', route: CHALLENGE, status: 429, code: 'AUMLOK_CHALLENGE_CAPACITY', message: 'refused', retryAfterSeconds: 44 }) })
    expect(withWait).toEqual({ kind: 'refused', code: 'AUMLOK_CHALLENGE_CAPACITY', retryAfterSeconds: 44 })
    const without = await revokeInvite({ requestId: 'r'.repeat(22), inviteId: 'A'.repeat(43) }, () => null, status,
      { signal: signal(), platform, call: refusingCall({ kind: 'refused', route: CHALLENGE, status: 429, code: 'AUMLOK_CHALLENGE_CAPACITY', message: 'refused' }) })
    expect(without).toStrictEqual({ kind: 'refused', code: 'AUMLOK_CHALLENGE_CAPACITY' })
    expect(inviteRefusalWords('AUMLOK_CHALLENGE_CAPACITY', 44)).toBe('Too many Touch ID requests are open. Wait 44 seconds, then try again. This is not counted as a failed try.')
    expect(inviteRefusalWords('AUMLOK_CHALLENGE_CAPACITY')).toBe('Too many Touch ID requests are open. Wait two minutes. This is not counted as a failed try.')
    expect(inviteRefusalWords('aumlok:AUMLOK_APPROVAL_CAPACITY', 90)).toMatch(/^Too many Touch ID approvals were made in the last five minutes\. Wait 90 seconds, then try again\./)
    expect(inviteRefusalWords('AUMLOK_APPROVAL_CAPACITY')).toMatch(/Wait up to five minutes, then try again\./)
    // Every other refusal keeps its words.
    expect(inviteRefusalWords('AUMLOK_RATE_LIMITED', 30)).toBe('Too many refused attempts. Wait, then try again.')
  })
})
