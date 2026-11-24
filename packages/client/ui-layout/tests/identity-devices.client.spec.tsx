// @vitest-environment jsdom
/**
 * "Your devices" on the Identity surface (apps/identity/devices.ts + DevicesPortal.tsx): the strict read of the host's
 * devices answer, the exact bodies the passkey approves, the code shown once, and the refusals in plain words. The host
 * and the passkey are fakes here; the edge side is proven in deploy/cloudflare/src/__tests__/passkey-devices.test.mjs.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { createHash } from 'node:crypto'
import type { HostAnswer } from '../src/client/spatial/apps/identity/host.ts'
import {
  DEVICE_CODE_ROUTE, DEVICE_CONFIRM_ROUTE, DEVICE_DECLINE_ROUTE, DEVICE_OUTCOME_UNKNOWN, DEVICE_REMOVE_ROUTE, DEVICES_ROUTE,
  DEVICES_WAIT_READ_MS, DEVICES_WAIT_RETRIES, confirmDevice, declineDevice, deviceCodeBody, deviceLabelValid, devicePhrase,
  deviceRefusalWords, deviceRemoveBody, makeDeviceCode, readDevicesAnswer, removeDevice, type DevicesRead,
} from '../src/client/spatial/apps/identity/devices.ts'
import { DEVICE_ACTION_DEADLINE_MS, DevicesPortal } from '../src/client/spatial/apps/identity/DevicesPortal.tsx'
import { canonicalJson } from '../src/client/spatial/aumlok/class3-approval.ts'
import type { AumlokPlatform } from '../src/client/spatial/aumlok/aumlok-ceremony.ts'
import { beginApproval, endApproval, resetApprovalsForTests } from '../src/client/spatial/portal/touch-id-timing.ts'

const ORIGIN = 'https://devices.example.invalid'
const PRIMARY = 'cHJpbWFyeS1jcmVkZW50aWFsLWlk'
const PHONE = 'cGhvbmUtY3JlZGVudGlhbC1pZA'
const CODE = 'A'.repeat(42) + 'Q'
const live = (body: Record<string, unknown>): HostAnswer => ({ kind: 'live', route: DEVICES_ROUTE, body })
const answerBody = (extra: Record<string, unknown> = {}) => ({ ok: true, schema: 'aukora.aumlok.devices.v1', generation: 3, hostNow: 1_800_000_000_000, limit: 4,
  primary: { id: PRIMARY, boundAt: 1_790_000_000_000, lastVerifiedAt: 1_799_000_000_000 },
  devices: [{ id: PHONE, label: 'Phone', addedAt: 1_795_000_000_000, lastVerifiedAt: 1_796_000_000_000 }], pending: null, ...extra })
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')

/** A fake host for the approve ceremony, and a fake passkey: records what the passkey was asked to approve. */
function fakes(effect: (pathname: string, body: unknown) => { status: number; body: Record<string, unknown> }) {
  const approved: unknown[] = []
  const call = vi.fn(async (route: string, _signal: AbortSignal, body?: Record<string, unknown>): Promise<HostAnswer> => {
    if (route === '/_host/aumlok/challenge') {
      approved.push(body?.binding)
      return { kind: 'live', route, body: { challengeId: 'c'.repeat(43), binding: body?.binding, publicKey: { challenge: 'Y2hhbGxlbmdlLWJ5dGVzLTE2Kw', rpId: 'devices.example.invalid',
        allowCredentials: [{ type: 'public-key', id: PRIMARY }, { type: 'public-key', id: PHONE }], userVerification: 'required', timeout: 120000 } } }
    }
    const binding = approved.at(-1) as Record<string, unknown>
    return { kind: 'live', route, body: { approvalToken: Buffer.alloc(32, 7).toString('base64url'), expiresAt: Date.now() + 300000, approvedAt: Date.now(), binding } }
  })
  const platform: AumlokPlatform = {
    passkeyBlocker: () => null,
    passkey: async () => ({ id: PRIMARY, rawId: PRIMARY, type: 'public-key', authenticatorAttachment: 'platform', clientExtensionResults: {},
      response: { clientDataJSON: 'e30', authenticatorData: 'AA', signature: 'AA', userHandle: null } }),
    nodeKeys: async () => true,
  }
  const sent: { pathname: string; body: unknown; header: string | null }[] = []
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const pathname = input instanceof URL ? input.pathname : typeof input === 'string' ? input : input.url
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : 'null') as unknown
    sent.push({ pathname, body, header: new Headers(init?.headers).get('x-x6-class3-approval') })
    const answer = effect(pathname, body)
    return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
  const deps = { signal: new AbortController().signal, call, platform, fetchImpl, origin: ORIGIN }
  return { call, platform, fetchImpl, approved, sent, deps }
}

afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); resetApprovalsForTests() })

const KEY_HASH = '0001e240' + 'ab'.repeat(28)
const INSTANCE = 'aW5zdGFuY2Utb2YtdGhpcy1qb2luaW5nLTMyLWJ5dGU'
const JOINING = { id: 'bmV3LWRldmljZS1jcmVkZW50aWFs', label: 'Laptop', keyHash: KEY_HASH, instance: INSTANCE, phrase: '123 456', registeredAt: 1_800_000_000_000, expiresAt: 1_800_000_600_000 }
const liveRead = (extra: Record<string, unknown> = {}) => readDevicesAnswer(live(answerBody(extra)), performance.now()) as Extract<DevicesRead, { kind: 'live' }>

describe('a new device asks to join (the owner approves the exact key)', () => {
  it('derives the phrase from the key hash exactly as the edge does, and refuses an answer whose phrase does not match its key', () => {
    // The same vectors as deploy/cloudflare/src/__tests__/passkey-devices.test.mjs ('the confirmation phrase').
    expect([devicePhrase('0'.repeat(64)), devicePhrase('f'.repeat(64)), devicePhrase(KEY_HASH)]).toEqual(['000 000', '967 295', '123 456'])
    const read = liveRead({ joining: JOINING })
    expect(read.joining).toEqual(JOINING)
    expect(liveRead().joining).toBeNull()
    const { instance: _instance, ...noInstance } = JOINING
    for (const bent of [{ ...JOINING, phrase: '654 321' }, { ...JOINING, keyHash: 'X'.repeat(64) }, { ...JOINING, id: '+' }, { ...JOINING, expiresAt: -1 }, 'x',
      noInstance, { ...JOINING, instance: 'short' }, { ...JOINING, instance: 'A'.repeat(43) + 'B' }, { ...JOINING, instance: 'A'.repeat(42) + 'B' }]) {
      expect(readDevicesAnswer(live(answerBody({ joining: bent })), 0).kind, JSON.stringify(bent)).toBe('unread')
    }
  })

  it('confirm approves the exact id, key hash and joining instance, then sends it; decline names the instance and needs no passkey', async () => {
    const read = liveRead({ joining: JOINING })
    const host = fakes(() => ({ status: 200, body: { ok: true, deviceId: JOINING.id, label: 'Laptop', deviceCount: 2 } }))
    expect(await confirmDevice(read, JOINING, host.deps)).toEqual({ ok: true, value: 2 })
    expect(host.sent[0]).toMatchObject({ pathname: DEVICE_CONFIRM_ROUTE, body: { action: 'aumlok.device.confirm', deviceId: JOINING.id, keyHash: KEY_HASH, instance: INSTANCE, generation: 3 } })
    expect(host.approved[0]).toEqual({ schema: 'aukora.class3.action.v1', audience: ORIGIN, method: 'POST', pathname: DEVICE_CONFIRM_ROUTE,
      bodySha256: sha256(canonicalJson(host.sent[0]?.body)) })
    const routes: string[] = []
    const call = vi.fn(async (route: string, _signal: AbortSignal, body?: Record<string, unknown>): Promise<HostAnswer> => {
      routes.push(route)
      return { kind: 'live', route, body: { ok: true, deviceId: body?.deviceId } }
    })
    expect(await declineDevice(read, JOINING, { signal: new AbortController().signal, call })).toEqual({ ok: true, value: true })
    expect(routes).toEqual([DEVICE_DECLINE_ROUTE])
    expect(call).toHaveBeenCalledWith(DEVICE_DECLINE_ROUTE, expect.anything(), { action: 'aumlok.device.decline', deviceId: JOINING.id, instance: INSTANCE, generation: 3 })
  })

  it('the portal shows the phrase with Confirm and Decline', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(answerBody({ joining: JOINING })), { status: 200, headers: { 'content-type': 'application/json' } })))
    const view = render(<DevicesPortal active />)
    fireEvent.click(view.getByText('Your devices'))
    await waitFor(() => { expect(view.container.querySelector(`[data-identity-device-joining="${JOINING.id}"]`)).not.toBeNull() })
    expect(view.container.querySelector('[data-identity-device-phrase]')?.textContent).toBe('123 456')
    expect(view.getByText(/A new device asks to join/)).toBeTruthy()
    expect(view.container.querySelector('[data-identity-device-confirm]')).not.toBeNull()
    expect(view.container.querySelector('[data-identity-device-decline]')).not.toBeNull()
    expect(view.container.textContent ?? '').not.toMatch(/token/i)
  })
})

describe('while a code waits, and while a device asks to join', () => {
  it('reads the list again while a code waits, so "asks to join" appears without leaving the portal; then it stops', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    let lists = 0, joined = false
    vi.stubGlobal('fetch', vi.fn(async () => {
      lists++
      // The host names a waiting code until the new device registers; then the joining device, and no waiting code.
      const body = joined ? answerBody({ joining: JOINING }) : answerBody({ pending: { label: 'Laptop', expiresAt: 1_800_000_600_000 } })
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    }))
    const view = render(<DevicesPortal active />)
    fireEvent.click(view.getByText('Your devices'))
    await waitFor(() => { expect(view.container.querySelector('[data-identity-device-pending]')).not.toBeNull() })
    expect(lists).toBe(1)
    await vi.advanceTimersByTimeAsync(DEVICES_WAIT_READ_MS)
    await waitFor(() => { expect(lists).toBe(2) })
    expect(view.container.querySelector('[data-identity-device-joining]')).toBeNull()
    // The new computer registers (after Done, or without it): the next read shows the join card.
    joined = true
    await vi.advanceTimersByTimeAsync(DEVICES_WAIT_READ_MS)
    await waitFor(() => { expect(view.container.querySelector(`[data-identity-device-joining="${JOINING.id}"]`)).not.toBeNull() })
    expect(view.container.querySelector('[data-identity-device-phrase]')?.textContent).toBe('123 456')
    // Once the device asks to join, the reading stops.
    const settled = lists
    await vi.advanceTimersByTimeAsync(DEVICES_WAIT_READ_MS * 3)
    expect(lists).toBe(settled)
  })

  it('a failed re-read while a code waits keeps the list and keeps reading; past the bound it says so and offers Retry', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    let lists = 0, failing = false, joined = false
    vi.stubGlobal('fetch', vi.fn(async () => {
      lists++
      if (failing) return new Response('upstream', { status: 502 })
      const body = joined ? answerBody({ joining: JOINING }) : answerBody({ pending: { label: 'Laptop', expiresAt: 1_800_000_600_000 } })
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    }))
    const view = render(<DevicesPortal active />)
    fireEvent.click(view.getByText('Your devices'))
    await waitFor(() => { expect(view.container.querySelector('[data-identity-device-pending]')).not.toBeNull() })
    // One read fails (the reviewer's case): the list stays, and the next tick reads again.
    failing = true
    await vi.advanceTimersByTimeAsync(DEVICES_WAIT_READ_MS)
    await waitFor(() => { expect(lists).toBe(2) })
    expect(view.container.querySelector('[data-identity-device-pending]')).not.toBeNull()
    expect(view.container.querySelector('[data-identity-devices-retry]')).toBeNull()
    // The host answers again and the device has registered meanwhile: the join card appears without leaving the portal.
    failing = false; joined = true
    await vi.advanceTimersByTimeAsync(DEVICES_WAIT_READ_MS)
    await waitFor(() => { expect(view.container.querySelector(`[data-identity-device-joining="${JOINING.id}"]`)).not.toBeNull() })
    cleanup()
    // Failures in a row: bounded. After DEVICES_WAIT_RETRIES of them the portal says it cannot read, stops, and offers Retry.
    lists = 0; failing = false; joined = false
    const again = render(<DevicesPortal active />)
    fireEvent.click(again.getByText('Your devices'))
    await waitFor(() => { expect(again.container.querySelector('[data-identity-device-pending]')).not.toBeNull() })
    failing = true
    for (let tick = 1; tick <= DEVICES_WAIT_RETRIES; tick++) {
      await vi.advanceTimersByTimeAsync(DEVICES_WAIT_READ_MS)
      await waitFor(() => { expect(lists).toBe(1 + tick) })
    }
    await waitFor(() => { expect(again.container.querySelector('[data-identity-devices-retry]')).not.toBeNull() })
    expect(again.container.querySelector('[data-identity-devices-unread]')).not.toBeNull()
    const stopped = lists
    await vi.advanceTimersByTimeAsync(DEVICES_WAIT_READ_MS * 3)
    expect(lists).toBe(stopped)
    // Retry reads again, and the waiting resumes.
    failing = false; joined = true
    fireEvent.click(again.container.querySelector('[data-identity-devices-retry]') as Element)
    await waitFor(() => { expect(again.container.querySelector(`[data-identity-device-joining="${JOINING.id}"]`)).not.toBeNull() })
    expect(lists).toBe(stopped + 1)
  })

  it('reads nothing again when no code waits', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    let lists = 0
    vi.stubGlobal('fetch', vi.fn(async () => { lists++; return new Response(JSON.stringify(answerBody()), { status: 200, headers: { 'content-type': 'application/json' } }) }))
    const view = render(<DevicesPortal active />)
    fireEvent.click(view.getByText('Your devices'))
    await waitFor(() => { expect(view.getByText('First passkey')).toBeTruthy() })
    await vi.advanceTimersByTimeAsync(DEVICES_WAIT_READ_MS * 3)
    expect(lists).toBe(1)
  })

  it('while a device asks to join, no new code is offered and none is asked of the passkey', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(answerBody({ joining: JOINING })), { status: 200, headers: { 'content-type': 'application/json' } })))
    const view = render(<DevicesPortal active />)
    fireEvent.click(view.getByText('Your devices'))
    await waitFor(() => { expect(view.container.querySelector('[data-identity-device-join-first]')).not.toBeNull() })
    expect(view.container.querySelector('[data-identity-device-add]')).toBeNull()
    expect(view.container.querySelector('[data-identity-device-confirm]')).not.toBeNull()
    const host = fakes(() => ({ status: 200, body: {} }))
    expect(await makeDeviceCode(liveRead({ joining: JOINING }), 'Phone', host.deps)).toEqual({ ok: false, reason: deviceRefusalWords('AUMLOK_DEVICE_JOIN_WAITING') })
    expect([host.call.mock.calls.length, host.sent.length]).toEqual([0, 0])
    expect(deviceRefusalWords('AUMLOK_DEVICE_JOIN_WAITING')).toMatch(/Confirm or decline it first/)
  })
})

describe('a lost answer is unknown, never "nothing changed"', () => {
  it('no answer, or a failure without the host\'s own words, reads as unknown; a worded refusal still reads as refused', async () => {
    const read = liveRead()
    const thrown = fakes(() => { throw new TypeError('Failed to fetch') })
    expect(await removeDevice(read, PHONE, thrown.deps)).toEqual({ ok: false, reason: DEVICE_OUTCOME_UNKNOWN, unknown: true })
    const gateway = fakes(() => ({ status: 502, body: {} }))
    expect(await removeDevice(read, PHONE, gateway.deps)).toEqual({ ok: false, reason: DEVICE_OUTCOME_UNKNOWN, unknown: true })
    const unavailable = fakes(() => ({ status: 503, body: { ok: false, code: 'AUMLOK_UNAVAILABLE' } }))
    expect((await removeDevice(read, PHONE, unavailable.deps)).ok).toBe(false)
    expect(await removeDevice(read, PHONE, unavailable.deps)).toMatchObject({ unknown: true })
    const unread = fakes(() => ({ status: 200, body: { ok: true } }))
    expect(await removeDevice(read, PHONE, unread.deps)).toMatchObject({ unknown: true })
    const refused = fakes(() => ({ status: 403, body: { ok: false, code: 'AUMLOK_DEVICE_REMOVE_NEEDS_OTHER_PASSKEY' } }))
    expect(await removeDevice(read, PHONE, refused.deps)).toEqual({ ok: false, reason: deviceRefusalWords('AUMLOK_DEVICE_REMOVE_NEEDS_OTHER_PASSKEY') })
    expect(DEVICE_OUTCOME_UNKNOWN).not.toMatch(/nothing (was )?(changed|removed|added)/i)
    const declineLost = vi.fn(async (route: string): Promise<HostAnswer> => ({ kind: 'absent', route, detail: 'the host did not answer' }))
    expect(await declineDevice(read, JOINING, { signal: new AbortController().signal, call: declineLost })).toMatchObject({ unknown: true })
  })

  it('the portal says the removal outcome is unknown and reads the list again', async () => {
    // A passkey in this page (jsdom has none): the browser platform's own get(), answered with fixed bytes.
    const bytes = (text: string) => new TextEncoder().encode(text).buffer
    vi.stubGlobal('isSecureContext', true)
    class FakeCredential { readonly kind = 'public-key-credential' }
    class FakeAssertion { readonly kind = 'assertion-response' }
    vi.stubGlobal('PublicKeyCredential', FakeCredential)
    vi.stubGlobal('AuthenticatorAssertionResponse', FakeAssertion)
    const clientData = JSON.stringify({ type: 'webauthn.get', challenge: 'Y2hhbGxlbmdlLWJ5dGVzLTE2Kw', origin: location.origin, crossOrigin: false })
    const credentials = { create: vi.fn(), get: vi.fn(async () => Object.assign(new FakeCredential(), { id: PRIMARY,
      rawId: Uint8Array.from(Buffer.from(PRIMARY, 'base64url')).buffer, type: 'public-key', authenticatorAttachment: 'platform',
      getClientExtensionResults: () => ({}), response: Object.assign(new FakeAssertion(), { clientDataJSON: bytes(clientData),
        authenticatorData: bytes('a'), signature: bytes('s'), userHandle: null }) })) }
    Object.defineProperty(navigator, 'credentials', { value: credentials, configurable: true })
    let lists = 0, binding: unknown = null
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    const fetchStub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = typeof input === 'string' ? input : input instanceof URL ? input.pathname : input.url
      if (path === DEVICES_ROUTE) { lists++; return json(answerBody()) }
      if (path === '/_host/aumlok/challenge') {
        binding = (JSON.parse(typeof init?.body === 'string' ? init.body : 'null') as { binding: unknown }).binding
        return json({ ok: true, challengeId: 'c'.repeat(43), binding, publicKey: { challenge: 'Y2hhbGxlbmdlLWJ5dGVzLTE2Kw', rpId: location.hostname,
          allowCredentials: [{ type: 'public-key', id: PRIMARY }], userVerification: 'required', timeout: 120000 } })
      }
      if (path === '/_host/aumlok/approve') return json({ ok: true, approvalToken: Buffer.alloc(32, 7).toString('base64url'), expiresAt: Date.now() + 300000, approvedAt: Date.now(), binding })
      // The removal itself: sent, and its answer lost.
      throw new TypeError('Failed to fetch')
    })
    vi.stubGlobal('fetch', fetchStub)
    try {
      const view = render(<DevicesPortal active />)
      fireEvent.click(view.getByText('Your devices'))
      await waitFor(() => { expect(view.container.querySelector(`[data-identity-device-remove="${PHONE}"]`)).not.toBeNull() })
      const before = lists
      fireEvent.click(view.container.querySelector(`[data-identity-device-remove="${PHONE}"]`) as Element)
      await waitFor(() => { expect(view.container.querySelector('[data-identity-device-notice]')).not.toBeNull() })
      expect(fetchStub.mock.calls.some(([input]) => input === DEVICE_REMOVE_ROUTE), 'the removal was sent').toBe(true)
      expect(view.container.querySelector('[data-identity-device-notice]')?.textContent).toBe(DEVICE_OUTCOME_UNKNOWN)
      await waitFor(() => { expect(lists).toBeGreaterThan(before) })
    } finally {
      Reflect.deleteProperty(navigator, 'credentials')
    }
  })
})

describe('the devices read', () => {
  it('reads the host answer strictly and refuses any other shape', () => {
    const read = readDevicesAnswer(live(answerBody()), 10)
    expect(read.kind).toBe('live')
    if (read.kind !== 'live') return
    expect([read.primary.id, read.devices.map(item => item.label), read.generation, read.limit]).toEqual([PRIMARY, ['Phone'], 3, 4])
    for (const bent of [{ schema: 'other' }, { generation: 0 }, { devices: 'x' }, { primary: null }, { pending: { label: 1 } },
      { devices: [{ id: '+', label: 'x', addedAt: 1, lastVerifiedAt: 1 }] }, { limit: 0 }]) {
      expect(readDevicesAnswer(live(answerBody(bent)), 0).kind, JSON.stringify(bent)).toBe('unread')
    }
    expect(readDevicesAnswer({ kind: 'refused', route: DEVICES_ROUTE, status: 403, code: 'OWNER_ACCESS_REQUIRED', message: 'x' }, 0))
      .toEqual({ kind: 'unread', text: 'Sign in as the owner to manage devices.' })
  })

  it('builds the exact bodies the passkey approves, on the host clock', () => {
    const read = readDevicesAnswer(live(answerBody()), 1000) as Extract<DevicesRead, { kind: 'live' }>
    expect(deviceCodeBody(read, 'Laptop', 3000)).toEqual({ action: 'aumlok.device.add', label: 'Laptop', expiresAt: 1_800_000_000_000 + 2000 + 600_000 - 5000, generation: 3 })
    expect(deviceRemoveBody(read, PHONE)).toEqual({ action: 'aumlok.device.remove', deviceId: PHONE, generation: 3 })
    expect(['Laptop', "Studio Mac (2)", 'é'].every(deviceLabelValid)).toBe(true)
    expect(['', ' x', 'x'.repeat(41), '<b>', 'a\nb'].some(deviceLabelValid)).toBe(false)
    expect(deviceRefusalWords('AUMLOK_DEVICE_REMOVE_NEEDS_OTHER_PASSKEY')).toMatch(/cannot remove itself/)
    expect(deviceRefusalWords('SOMETHING_ELSE')).toBe('The host refused (SOMETHING_ELSE). Nothing changed.')
  })
})

describe('adding and removing', () => {
  it('a code is approved on its exact bytes, then sent with the approval; the answer is checked', async () => {
    const read = readDevicesAnswer(live(answerBody()), performance.now()) as Extract<DevicesRead, { kind: 'live' }>
    const host = fakes(() => ({ status: 200, body: { ok: true, code: CODE, link: `${ORIGIN}/_auth/passkey/add#${CODE}`, label: 'Laptop', expiresAt: 1_800_000_600_000, sameUserHandle: true } }))
    const made = await makeDeviceCode(read, 'Laptop', host.deps)
    expect(made).toEqual({ ok: true, value: { code: CODE, link: `${ORIGIN}/_auth/passkey/add#${CODE}`, label: 'Laptop', expiresAt: 1_800_000_600_000, sameUserHandle: true } })
    const [sent] = host.sent
    expect(sent?.pathname).toBe(DEVICE_CODE_ROUTE)
    expect(sent?.header).toBe(Buffer.alloc(32, 7).toString('base64url'))
    expect(host.approved[0]).toEqual({ schema: 'aukora.class3.action.v1', audience: ORIGIN, method: 'POST', pathname: DEVICE_CODE_ROUTE, bodySha256: sha256(canonicalJson(sent?.body)) })
    // A link for another origin, or a malformed code, is never shown.
    const forged = fakes(() => ({ status: 200, body: { ok: true, code: CODE, link: `https://evil.example/_auth/passkey/add#${CODE}`, label: 'Laptop', expiresAt: 1 } }))
    expect((await makeDeviceCode(read, 'Laptop', forged.deps)).ok).toBe(false)
    expect((await makeDeviceCode(read, '<b>', host.deps)).ok).toBe(false)
  })

  it('a removal refusal reaches the owner in plain words', async () => {
    const read = readDevicesAnswer(live(answerBody()), performance.now()) as Extract<DevicesRead, { kind: 'live' }>
    const host = fakes(() => ({ status: 403, body: { ok: false, code: 'AUMLOK_DEVICE_REMOVE_NEEDS_OTHER_PASSKEY' } }))
    const removed = await removeDevice(read, PHONE, host.deps)
    expect(removed).toEqual({ ok: false, reason: deviceRefusalWords('AUMLOK_DEVICE_REMOVE_NEEDS_OTHER_PASSKEY') })
    expect(host.sent[0]?.pathname).toBe(DEVICE_REMOVE_ROUTE)
    const done = fakes(() => ({ status: 200, body: { ok: true, deviceId: PHONE, deviceCount: 0 } }))
    expect(await removeDevice(read, PHONE, done.deps))
      .toEqual({ ok: true, value: 0 })
  })
})

describe('the portal', () => {
  it('lists the first passkey and each device, and offers to add another', async () => {
    const fetchStub = vi.fn(async () => new Response(JSON.stringify(answerBody()), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchStub)
    const view = render(<DevicesPortal active />)
    fireEvent.click(view.getByText('Your devices'))
    await waitFor(() => { expect(view.getByText('First passkey')).toBeTruthy() })
    expect(view.getByText('Phone')).toBeTruthy()
    expect(view.container.querySelector(`[data-identity-device-remove="${PHONE}"]`)).not.toBeNull()
    expect(view.container.querySelector('[data-identity-device-add]')).not.toBeNull()
    expect(fetchStub).toHaveBeenCalledWith(DEVICES_ROUTE, expect.objectContaining({ method: 'GET' }))
    expect(view.container.textContent ?? '').not.toMatch(/token/i)
  })

  it('says when the host has no devices route yet, and says the limit when it is full', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('missing', { status: 404 })))
    const missing = render(<DevicesPortal active />)
    fireEvent.click(missing.getByText('Your devices'))
    await waitFor(() => { expect(missing.container.querySelector('[data-identity-devices-unread]')).not.toBeNull() })
    cleanup()
    const four = Array.from({ length: 4 }, (_, index) => ({ id: `ZGV2aWNl${String(index)}`, label: `Device ${String(index)}`, addedAt: 1, lastVerifiedAt: 1 }))
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(answerBody({ devices: four })), { status: 200, headers: { 'content-type': 'application/json' } })))
    const full = render(<DevicesPortal active />)
    fireEvent.click(full.getByText('Your devices'))
    await waitFor(() => { expect(full.container.querySelector('[data-identity-device-full]')).not.toBeNull() })
    expect(full.container.querySelector('[data-identity-device-add]')).toBeNull()
  })
})

describe('a device action that stalls never leaves Identity busy', () => {
  afterEach(() => { Reflect.deleteProperty(navigator, 'credentials') })
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  /**
   * A host whose devices list answers at once (a device asks to join) and whose action routes STALL: each such request
   * waits for the test to answer it (it ignores its abort signal, as a stalled network can), and its signal is recorded.
   */
  function stallingHost(stalled: readonly string[]) {
    let lists = 0
    const waiting: { path: string; signal: AbortSignal | null | undefined; answer: (response: Response) => void }[] = []
    const fetchStub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = typeof input === 'string' ? input : input instanceof URL ? input.pathname : input.url
      if (path === DEVICES_ROUTE) { lists++; return json(answerBody({ joining: JOINING })) }
      if (stalled.includes(path)) {
        return new Promise<Response>((resolve) => { waiting.push({ path, signal: init?.signal, answer: resolve }) })
      }
      throw new TypeError('unexpected route ' + path)
    })
    vi.stubGlobal('fetch', fetchStub)
    // A page that can ask for a passkey (jsdom has none); the approval stalls at its challenge, before any prompt.
    vi.stubGlobal('isSecureContext', true)
    vi.stubGlobal('PublicKeyCredential', class FakeCredential { readonly kind = 'public-key-credential' })
    vi.stubGlobal('AuthenticatorAssertionResponse', class FakeAssertion { readonly kind = 'assertion-response' })
    Object.defineProperty(navigator, 'credentials', { value: { create: vi.fn(), get: vi.fn() }, configurable: true })
    return { waiting, lists: () => lists }
  }
  const declineButton = (view: ReturnType<typeof render>) => view.container.querySelector<HTMLButtonElement>('[data-identity-device-decline]')
  const opened = async (view: ReturnType<typeof render>) => {
    fireEvent.click(view.getByText('Your devices'))
    await waitFor(() => { expect(declineButton(view)).not.toBeNull() })
  }

  it('the portal is closed (deactivated) during a stalled action: it is cancelled, nothing stays busy, the outcome is said to be unknown and the list read again', async () => {
    const host = stallingHost([DEVICE_DECLINE_ROUTE])
    const view = render(<DevicesPortal active />)
    await opened(view)
    fireEvent.click(declineButton(view) as Element)
    await waitFor(() => { expect(host.waiting.length).toBe(1) })
    expect(declineButton(view)?.disabled).toBe(true)
    expect(declineButton(view)?.textContent).toBe('Declining')
    view.rerender(<DevicesPortal active={false} />)
    expect(host.waiting[0]?.signal?.aborted, 'the stalled request is cancelled').toBe(true)
    const before = host.lists()
    view.rerender(<DevicesPortal active />)
    await waitFor(() => { expect(host.lists()).toBeGreaterThan(before) })
    await waitFor(() => { expect(declineButton(view)?.disabled).toBe(false) })
    expect(view.container.querySelector('[data-identity-device-notice]')?.textContent).toBe(DEVICE_OUTCOME_UNKNOWN)
    expect(view.container.querySelector('[data-identity-device-confirm]')?.hasAttribute('disabled')).toBe(false)
  })

  it('closing the disclosure itself (its header, the real PortalButton) during a stalled passkey approval cancels it: signal aborted, hold let go, buttons free, outcome unknown, list read again', async () => {
    const host = stallingHost(['/_host/aumlok/challenge'])
    const view = render(<DevicesPortal active />)
    await opened(view)
    const head = view.getByText('Your devices').closest('button') as HTMLButtonElement
    expect(head.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(view.container.querySelector('[data-identity-device-confirm]') as Element)
    await waitFor(() => { expect(host.waiting.length).toBe(1) })
    expect(beginApproval('aumlok-device-confirm'), 'the hold is taken while the approval runs').toBe(false)
    const before = host.lists()
    // The owner closes the portal's disclosure (the component stays mounted and active).
    fireEvent.click(head)
    expect(head.getAttribute('aria-expanded')).toBe('false')
    expect(host.waiting[0]?.signal?.aborted, 'the stalled request is cancelled').toBe(true)
    expect(beginApproval('aumlok-device-confirm'), 'the hold is let go on close').toBe(true)
    endApproval('aumlok-device-confirm')
    await waitFor(() => { expect(host.lists()).toBeGreaterThan(before) })
    // Opened again: nothing busy, the outcome said to be unknown.
    fireEvent.click(head)
    await waitFor(() => { expect(declineButton(view)?.disabled).toBe(false) })
    expect(view.container.querySelector('[data-identity-device-confirm]')?.hasAttribute('disabled')).toBe(false)
    expect(view.container.querySelector('[data-identity-device-notice]')?.textContent).toBe(DEVICE_OUTCOME_UNKNOWN)
    // Its late answer changes nothing.
    host.waiting[0]?.answer(json({ ok: true, challengeId: 'c'.repeat(43), publicKey: {} }))
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(view.container.querySelector('[data-identity-device-notice]')?.textContent).toBe(DEVICE_OUTCOME_UNKNOWN)
    expect(declineButton(view)?.disabled).toBe(false)
  })

  it('unmounting during a stalled passkey approval cancels it and lets go of its approval hold', async () => {
    const host = stallingHost(['/_host/aumlok/challenge'])
    const view = render(<DevicesPortal active />)
    await opened(view)
    const add = view.container.querySelector('[data-identity-device-add]')
    // A device asks to join, so no code is offered; confirm takes the passkey-approval hold instead.
    expect(add).toBeNull()
    fireEvent.click(view.container.querySelector('[data-identity-device-confirm]') as Element)
    await waitFor(() => { expect(host.waiting.length).toBe(1) })
    expect(beginApproval('aumlok-device-confirm'), 'the hold is taken while the approval runs').toBe(false)
    view.unmount()
    expect(host.waiting[0]?.signal?.aborted).toBe(true)
    expect(beginApproval('aumlok-device-confirm'), 'the hold is let go on unmount').toBe(true)
    endApproval('aumlok-device-confirm')
  })

  it('a request past its deadline is let go: the hold is released, the outcome is said to be unknown and the list read again; its late answer changes nothing', async () => {
    expect(DEVICE_ACTION_DEADLINE_MS).toBeGreaterThan(60_000)
    const host = stallingHost([DEVICE_DECLINE_ROUTE, '/_host/aumlok/challenge'])
    const view = render(<DevicesPortal active actionDeadlineMs={40} />)
    await opened(view)
    // The passkey approval stalls past its deadline: its hold is let go, the page is free again.
    const before = host.lists()
    fireEvent.click(view.container.querySelector('[data-identity-device-confirm]') as Element)
    await waitFor(() => { expect(host.waiting.length).toBe(1) })
    await waitFor(() => { expect(view.container.querySelector('[data-identity-device-notice]')?.textContent).toBe(DEVICE_OUTCOME_UNKNOWN) })
    expect(host.waiting[0]?.signal?.aborted).toBe(true)
    expect(beginApproval('aumlok-device-confirm')).toBe(true)
    endApproval('aumlok-device-confirm')
    await waitFor(() => { expect(host.lists()).toBeGreaterThan(before) })
    await waitFor(() => { expect(declineButton(view)?.disabled).toBe(false) })
    // A decline now: the first action's late answer arrives while it runs, and changes nothing.
    fireEvent.click(declineButton(view) as Element)
    await waitFor(() => { expect(host.waiting.length).toBe(2) })
    host.waiting[0]?.answer(json({ ok: true, challengeId: 'c'.repeat(43), publicKey: {} }))
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(declineButton(view)?.textContent).toBe('Declining')
    expect(declineButton(view)?.disabled).toBe(true)
    // This decline also passes its deadline, then answers late: still unknown, never "turned away".
    await waitFor(() => { expect(declineButton(view)?.disabled).toBe(false) })
    host.waiting[1]?.answer(json({ ok: true, deviceId: JOINING.id }))
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(view.container.querySelector('[data-identity-device-notice]')?.textContent).toBe(DEVICE_OUTCOME_UNKNOWN)
    expect(view.container.textContent ?? '').not.toMatch(/was turned away/)
  })

  it('an action that answers within its deadline still reports its outcome (the guard lets the current answer through)', async () => {
    const host = stallingHost([DEVICE_DECLINE_ROUTE])
    const view = render(<DevicesPortal active />)
    await opened(view)
    fireEvent.click(declineButton(view) as Element)
    await waitFor(() => { expect(host.waiting.length).toBe(1) })
    host.waiting[0]?.answer(json({ ok: true, deviceId: JOINING.id }))
    await waitFor(() => { expect(view.container.querySelector('[data-identity-device-notice]')?.textContent).toMatch(/was turned away/) })
    expect(host.waiting[0]?.signal?.aborted).toBe(false)
  })
})
