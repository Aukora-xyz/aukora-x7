// @vitest-environment jsdom
/**
 * Job 6: THE OWNER'S PROMPT GETS WHAT IS LEFT OF THE CEREMONY, NEVER MORE. The node counts `publicKey.timeout` from when it
 * answered; the real `hostCall` takes the request's own time (this page's monotonic clock) off it before any prompt opens,
 * for every owner prompt that reads the AUMLOK challenge (Class 3 approvals, invites, the AUMLOK ceremonies). With
 * nothing left the prompt never opens and the page says nothing was sent or counted. The host and the passkey are fakes;
 * `performance.now()` is a stub that only the fake fetch moves.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AUMLOK_CHALLENGE_ROUTE, hostCall, withRemainingTimeout } from '../src/client/spatial/apps/identity/host.ts'
import { passkeyRanOut, readChallenge } from '../src/client/spatial/apps/identity/webauthn.ts'
import { inviteRefusalWords } from '../src/client/spatial/apps/identity/invite.ts'
import { approveClass3, class3Action } from '../src/client/spatial/aumlok/class3-approval.ts'
import type { AumlokPlatform } from '../src/client/spatial/aumlok/aumlok-ceremony.ts'
import { resetApprovalsForTests } from '../src/client/spatial/portal/touch-id-timing.ts'

const PRIMARY = 'cHJpbWFyeS1jcmVkZW50aWFsLWlk'
const CHALLENGE_BYTES = 'Y2hhbGxlbmdlLWJ5dGVzLTE2Kw'
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const signal = () => new AbortController().signal

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); resetApprovalsForTests() })

/** A monotonic clock only the fake fetch moves, by `delay` per request. */
function slowHost(delay: number, timeout: number, answer: (path: string, body: unknown) => Response | null = () => null) {
  const clock = { now: 10_000 }
  vi.spyOn(performance, 'now').mockImplementation(() => clock.now)
  const fetchStub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = typeof input === 'string' ? input : input instanceof URL ? input.pathname : input.url
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : 'null') as Record<string, unknown> | null
    clock.now += delay
    const custom = answer(path, body)
    if (custom !== null) return custom
    return json({ ok: true, challengeId: 'c'.repeat(43), binding: body?.binding, expiresAt: 1_800_000_120_000,
      publicKey: { challenge: CHALLENGE_BYTES, rpId: location.hostname, allowCredentials: [{ type: 'public-key', id: PRIMARY }], userVerification: 'required', timeout } })
  })
  vi.stubGlobal('fetch', fetchStub)
  return { clock, fetchStub }
}

describe('the request\'s own time comes off the prompt', () => {
  it('a challenge answer that took 40 ms: 60 000 ms becomes 59 960 ms; other routes and bodies without a timeout are untouched', async () => {
    slowHost(40, 60000)
    const answer = await hostCall(AUMLOK_CHALLENGE_ROUTE, signal(), { purpose: 'approve' })
    expect(answer.kind).toBe('live')
    if (answer.kind !== 'live') return
    expect((answer.body.publicKey as { timeout: number }).timeout).toBe(59960)
    const other = await hostCall('/_host/aumlok/status', signal())
    expect(other.kind === 'live' && (other.body.publicKey as { timeout: number }).timeout).toBe(60000)
    expect(withRemainingTimeout({ ok: true }, 500)).toEqual({ ok: true })
    expect(withRemainingTimeout({ publicKey: { timeout: 'x' } }, 500)).toEqual({ publicKey: { timeout: 'x' } })
    expect(withRemainingTimeout({ publicKey: { timeout: 1000 } }, 0)).toEqual({ publicKey: { timeout: 1000 } })
  })

  it('a short remainder is kept as it is (never lengthened to a minute); nothing left refuses before any prompt', () => {
    const body = (timeout: unknown) => ({ challengeId: 'c'.repeat(43), publicKey: { challenge: CHALLENGE_BYTES, timeout } })
    expect(readChallenge('verify', body(500)).options.timeout).toBe(500)
    expect(readChallenge('verify', body(1)).options.timeout).toBe(1)
    expect(readChallenge('verify', body(120000)).options.timeout).toBe(120000)
    // A value that is not a whole number of milliseconds up to ten minutes still reads as one minute, as before.
    expect(readChallenge('verify', body(1.5)).options.timeout).toBe(60000)
    expect(readChallenge('verify', body(600001)).options.timeout).toBe(60000)
    expect(readChallenge('verify', body(undefined)).options.timeout).toBe(60000)
    for (const spent of [0, -40]) {
      let thrown: unknown = null
      try { readChallenge('verify', body(spent)) } catch (error) { thrown = error }
      expect(passkeyRanOut(thrown)).toBe(true)
    }
    expect(passkeyRanOut(new Error('other'))).toBe(false)
  })

  it('a Class 3 approval: the passkey is asked with what is left; with 40 ms left and a 100 ms trip it is never asked, and nothing is sent', async () => {
    const platform = (seen: number[]): AumlokPlatform => ({
      passkeyBlocker: () => null,
      passkey: async (step) => {
        seen.push(step.options.timeout ?? -1)
        return { id: PRIMARY, rawId: PRIMARY, type: 'public-key', authenticatorAttachment: 'platform', clientExtensionResults: {},
          response: { clientDataJSON: 'e30', authenticatorData: 'AA', signature: 'AA', userHandle: null } }
      },
      nodeKeys: async () => true,
    })
    const action = await class3Action({ audience: location.origin, method: 'POST', pathname: '/_host/aumlok/device-remove', body: { a: 1 } })
    const seen: number[] = []
    const { fetchStub } = slowHost(250, 120000, (path, body) => path === '/_host/aumlok/approve'
      ? json({ ok: true, approvalToken: Buffer.alloc(32, 7).toString('base64url'), expiresAt: 1_800_000_300_000, approvedAt: 1_800_000_000_000,
        binding: (body as { binding?: unknown } | null)?.binding ?? action })
      : null)
    const approved = await approveClass3(action, { signal: signal(), platform: platform(seen) })
    expect(seen).toEqual([119750])
    expect(approved.ok).toBe(true)
    expect(fetchStub).toHaveBeenCalledTimes(2)
    // The reviewer's case on the owner's page: 40 ms left when the node answered, the answer took 100 ms to arrive.
    const late: number[] = []
    const lateHost = slowHost(100, 40)
    const refused = await approveClass3(action, { signal: signal(), platform: platform(late) })
    expect(late).toEqual([])
    expect(refused.ok).toBe(false)
    expect(!refused.ok && refused.reason)
      .toMatch(/^class3:passkey The Touch ID request ran out of time before the prompt could open\. Nothing was sent or counted\./)
    expect(lateHost.fetchStub).toHaveBeenCalledTimes(1)
  })

  it('the invite words: a malformed commitment says nothing was counted; wrong words still say they count; a spent request says nothing was sent', () => {
    expect(inviteRefusalWords('aumlok:AUMLOK_COMMITMENT_INVALID')).toMatch(/Nothing was counted\./)
    expect(inviteRefusalWords('aumlok:AUMLOK_RECOVERY_COMMITMENT_MISMATCH')).toMatch(/^Those words did not match\. This counts against your lifetime limit\./)
    expect(inviteRefusalWords('invite:ran-out')).toMatch(/^That Touch ID request ran out of time before the prompt could open\. Nothing was sent or counted\./)
  })
})
