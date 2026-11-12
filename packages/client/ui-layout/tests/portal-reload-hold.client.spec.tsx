// @vitest-environment jsdom
/**
 * NO RELOAD OVER AN APPROVAL IN FLIGHT (review ui3, SHOULD). The owner approves an outward request,
 * finishes Touch ID, and presses Reload while the approved POST awaits its answer: the page must keep that answer. One
 * shared guard (portal/build-notice.ts) is held from the start of every approval until its request settles, checked
 * inside every Reload handler, released in a `finally`, and bounded so Reload is never dead for good. Local stand-ins
 * only: the passkey, the host's routes and the page's fetch are fakes; nothing leaves the test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  APPROVAL_FINISHING_WORDS, APPROVAL_RELOAD_HOLD_MAX_MS, BUILD_RELOAD_FOR_KEY, holdReload, pageReload, reloadHeld, reloadNoticeOf,
  resetReloadHoldsForTests,
} from '../src/client/spatial/portal/build-notice.ts'
import { beginApproval, endApproval, resetApprovalsForTests } from '../src/client/spatial/portal/touch-id-timing.ts'
import { NewBuildButton, type FileRead, type WorkReader } from '../src/client/spatial/work/WorkSurface.tsx'
import { OutwardApprovalCell } from '../src/client/spatial/portal/OutwardApprovalCell.tsx'
import { STAGED_OUTWARD_PATH, STAGED_OUTWARD_SCHEMA } from '../src/client/spatial/aumlok/outward-class3.ts'
import { base64url } from '../src/client/spatial/apps/identity/webauthn.ts'
import type { AumlokHostCall, AumlokPlatform } from '../src/client/spatial/aumlok/aumlok-ceremony.ts'
import type { LiveChannel, LiveSocket } from '../src/client/spatial/work/autonomy.ts'

class FakeChannel implements LiveChannel {
  onmessage: LiveChannel['onmessage'] = null
  close() {}
}
class FakeSocket implements LiveSocket {
  onopen: LiveSocket['onopen'] = null
  onmessage: LiveSocket['onmessage'] = null
  onclose: LiveSocket['onclose'] = null
  close() {}
}

const PAGE = 'a'.repeat(40)
const EDGE = 'b'.repeat(40)
const LAG = { published: { ballId: 'd'.repeat(64), epoch: 172 }, running: { ballId: 'c'.repeat(64), epoch: 171 }, newer: true }

/** Session memory the press writes its edge revision into. */
function memoryOf() {
  const map = new Map<string, string>()
  return { map, getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => { map.set(key, value) },
    removeItem: (key: string) => { map.delete(key) } }
}

let reload: ReturnType<typeof vi.fn<() => void>>
beforeEach(() => {
  vi.stubGlobal('BroadcastChannel', FakeChannel)
  vi.stubGlobal('WebSocket', FakeSocket)
  reload = vi.fn<() => void>()
  vi.spyOn(pageReload, 'now').mockImplementation(reload)
  localStorage.clear()
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  resetApprovalsForTests()
  resetReloadHoldsForTests()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  localStorage.clear()
})

describe('the shared guard', () => {
  it('a press while an approval holds does not reload and marks nothing; after it settles, the press reloads', () => {
    const memory = memoryOf()
    const notice = reloadNoticeOf(EDGE, LAG, PAGE, memory)
    const release = holdReload()
    expect(reloadHeld()).toBe(true)
    notice?.reload()
    expect(reload).not.toHaveBeenCalled()
    expect(memory.map.has(BUILD_RELOAD_FOR_KEY)).toBe(false)
    release()
    expect(reloadHeld()).toBe(false)
    notice?.reload()
    expect(reload).toHaveBeenCalledTimes(1)
    expect(memory.map.get(BUILD_RELOAD_FOR_KEY)).toBe(EDGE)
  })

  it('two approvals: Reload waits for both; a release called twice releases only its own hold', () => {
    const first = holdReload()
    const second = holdReload()
    first()
    first()
    expect(reloadHeld()).toBe(true)
    second()
    expect(reloadHeld()).toBe(false)
  })

  it('the bound releases a hold nobody released, so Reload is never dead for good', () => {
    vi.useFakeTimers()
    const notice = reloadNoticeOf(null, LAG, PAGE, memoryOf())
    holdReload()
    vi.advanceTimersByTime(APPROVAL_RELOAD_HOLD_MAX_MS - 1)
    notice?.reload()
    expect(reload).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(reloadHeld()).toBe(false)
    notice?.reload()
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('every approval that takes the page\'s per-item lock holds Reload until it ends; a refused second start holds nothing', () => {
    expect(beginApproval('outward:x')).toBe(true)
    expect(reloadHeld()).toBe(true)
    expect(beginApproval('outward:x')).toBe(false)
    endApproval('outward:x')
    expect(reloadHeld()).toBe(false)
  })
})

describe('the Reload button, wherever it shows (the frame, Work, Aura)', () => {
  it('a notice press during an approval does not reload and says one sentence; after settle it reloads and the sentence goes', () => {
    const view = render(<NewBuildButton release={null} notice={reloadNoticeOf(EDGE, null, PAGE, memoryOf())} />)
    const button = () => view.container.querySelector<HTMLButtonElement>('[data-new-build]')!
    const sentence = () => view.container.querySelector('[data-reload-held]')
    expect(sentence()).toBeNull()
    let release = (): void => {}
    act(() => { release = holdReload() })
    expect(sentence()?.textContent?.trim()).toBe(APPROVAL_FINISHING_WORDS)
    fireEvent.click(button())
    expect(reload).not.toHaveBeenCalled()
    act(() => { release() })
    expect(sentence()).toBeNull()
    fireEvent.click(button())
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('the host\'s own release selection reloads through the same guard', () => {
    const view = render(<NewBuildButton release={'e'.repeat(64)} words={{ button: 'Reload', what: 'A different release.' }} />)
    const button = view.container.querySelector<HTMLButtonElement>('[data-new-build]')!
    let release = (): void => {}
    act(() => { release = holdReload() })
    fireEvent.click(button)
    expect(reload).not.toHaveBeenCalled()
    act(() => { release() })
    fireEvent.click(button)
    expect(reload).toHaveBeenCalledTimes(1)
  })
})

describe('the review\'s scenario: Sovereignty\'s outward request, Touch ID done, the approved POST awaiting its answer', () => {
  const body = { action: 'api', method: 'POST', endpoint: 'repos/your_org_x/your-node/issues', body: { title: 'T', body: 'B' } }
  const file = JSON.stringify({ schema: STAGED_OUTWARD_SCHEMA, stagedAt: 1, tool: 'x6_github', method: 'POST', pathname: '/_host/github', body })
  const reader: WorkReader = {
    whole: async (_session: unknown, path: string): Promise<FileRead> =>
      (path === STAGED_OUTWARD_PATH ? { ok: true, text: file } : { ok: false, reason: 'not-found' }),
  }
  const PASSKEY: Awaited<ReturnType<AumlokPlatform['passkey']>> = { id: 'Y3JlZGVudGlhbC1pZC0wMQ', rawId: 'Y3JlZGVudGlhbC1pZC0wMQ',
    type: 'public-key', authenticatorAttachment: 'platform',
    response: { clientDataJSON: 'e30', authenticatorData: 'AA', signature: 'AA', userHandle: null }, clientExtensionResults: {} }
  const platform: AumlokPlatform = { passkeyBlocker: () => null, passkey: async () => PASSKEY, nodeKeys: async () => true }

  it('Reload during the POST keeps the page; once the answer is recorded, Reload reloads', async () => {
    // The host's two passkey routes, as a bound host answers: the challenge echoes the binding, the approval carries it.
    let binding: unknown = null
    const call: AumlokHostCall = async (route, _signal, sent) => {
      if (route === '/_host/aumlok/challenge') {
        binding = sent?.binding
        return { kind: 'live', route, body: { ok: true, phase: 'PENDING_ASSERTION', challengeId: 'approve-0001', purpose: 'approve',
          binding, publicKey: { challenge: base64url(new Uint8Array(32).fill(6)), rpId: 'localhost', userVerification: 'required',
            allowCredentials: [{ type: 'public-key', id: PASSKEY.id }] } } }
      }
      return { kind: 'live', route, body: { ok: true, phase: 'BOUND', bound: true, approvalToken: base64url(new Uint8Array(32).fill(9)),
        expiresAt: 1_800_000_000_000, binding, lastVerifiedAt: 1_799_999_900_000 } }
    }
    // The approved POST: it waits for its answer until the test gives it one.
    let answer = (): void => {}
    const posted = vi.fn()
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      if (url === '/_host/github' && init?.method === 'POST') {
        posted()
        await new Promise<void>((resolve) => { answer = resolve })
        return new Response(JSON.stringify({ ok: true, json: { url: 'https://github.com/your_org_x/your-node/issues/1' } }), { status: 200 })
      }
      return new Response('{}', { status: 404 })
    }) as unknown as typeof fetch
    const view = render(
      <>
        <NewBuildButton release={null} notice={reloadNoticeOf(null, LAG, PAGE, memoryOf())} />
        <OutwardApprovalCell active round={0} reader={reader} sessionId={'s1' as SessionId} ownerBound
          ceremony={{ call, platform }} fetchImpl={fetchImpl} />
      </>,
    )
    const approve = await waitFor(() => {
      const button = view.container.querySelector<HTMLButtonElement>('[data-outward-approve]')
      expect(button).not.toBeNull()
      return button!
    })
    fireEvent.click(approve)
    await waitFor(() => { expect(posted).toHaveBeenCalledTimes(1) })
    // Touch ID is done and the POST is in flight: the owner presses Reload.
    fireEvent.click(view.container.querySelector<HTMLButtonElement>('[data-new-build]')!)
    expect(reload).not.toHaveBeenCalled()
    expect(view.container.querySelector('[data-reload-held]')?.textContent?.trim()).toBe(APPROVAL_FINISHING_WORDS)
    // The answer comes and the page records it.
    await act(async () => { answer() })
    await waitFor(() => { expect(view.container.querySelector('[data-outward-outcome="sent"]')).not.toBeNull() })
    expect(view.container.querySelector('[data-reload-held]')).toBeNull()
    fireEvent.click(view.container.querySelector<HTMLButtonElement>('[data-new-build]')!)
    expect(reload).toHaveBeenCalledTimes(1)
  })
})
