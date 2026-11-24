/** Managed voice status through the mounted builtin; every host answer is a local fixture. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { classifyActionIrreversibility } from '../../src/x6/ball-loader.ts'
import { voiceVerdict } from '../../src/x6/voice-read-only.ts'
import { FakeSocket, mountE4 } from './e4-fixture.ts'

afterEach(() => { FakeSocket.instances.length = 0; vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('x6_voice_status', () => {
  it('sends one same-origin managed_status read with no arguments and returns the JSON answer', async () => {
    const answer = { switch: 'off', names: { VOICE_MANAGED: 'missing' }, keyInUse: null, resourceKind: null, live: 0, failures: [] }
    const m = await mountE4({ respond: call => call.path === '/_host/voice' ? Response.json(answer) : null })
    const tool = m.tool('x6_voice_status')
    expect(tool.parameters).toEqual({})
    // VOICE LEVEL: the worker's own guard rides beside the edge's read (a fixture mount is look-only; her live worker is open).
    const RUNTIME = { level: 'look-only', state: 'unavailable', disabled: 'no-store', marked: 0, unsaved: 0, recent: [] }
    const got = await tool.execute({}) as { runtime: { state: string; disabled: string | null } }
    expect(got).toEqual({ ...answer, runtime: { ...RUNTIME, state: got.runtime.state, disabled: got.runtime.disabled } })
    expect(['ready', 'unavailable', 'loading', 'loading-late', 'store-failed']).toContain(got.runtime.state)
    const calls = m.calls.filter(call => call.path === '/_host/voice')
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ method: 'POST', path: '/_host/voice', credentials: 'same-origin', body: { action: 'managed_status' } })
    expect(calls[0]!.headers.get('content-type')).toBe('application/json')
  })

  it('returns JSON refusals and reports the HTTP status for a non-JSON answer', async () => {
    let response = Response.json({ ok: false, code: 'OWNER_ACCESS_REQUIRED' }, { status: 403 })
    const m = await mountE4({ respond: call => call.path === '/_host/voice' ? response : null })
    expect(await m.tool('x6_voice_status').execute({})).toMatchObject({ ok: false, code: 'OWNER_ACCESS_REQUIRED', runtime: { level: 'look-only' } })
    response = new Response('<html>unavailable</html>', { status: 503 })
    expect(await m.tool('x6_voice_status').execute({}))
      .toMatchObject({ ok: false, code: 'VOICE_STATUS_UNREADABLE', status: 503, runtime: { level: 'look-only' } })
  })

  it('is indexed as read-only and allowed from voice only as a builtin', async () => {
    const m = await mountE4()
    expect(await m.tool('x6_capability_index').execute({ action: 'lookup', name: 'x6_voice_status' }))
      .toMatchObject({ ok: true, tool: { readOnly: true, mutating: false } })
    expect(classifyActionIrreversibility({ tool: 'x6_voice_status' })).toBe(0)
    expect(voiceVerdict({ tool: 'x6_voice_status', args: {}, origin: { kind: 'builtin' } })).toBeUndefined()
    expect(voiceVerdict({ tool: 'x6_voice_status', args: {}, origin: { kind: 'preset' } })).toContain('VOICE_LOOK_ONLY')
  })
})
