/**
 * Lane E4 task 2: the open-tab wake loop. A scheduled (alarm) `wake:updated` frame on /_head/ws, with no turn running,
 * yields exactly one POST /_host/wake {action:'acknowledge', wakeId} (same-origin) and one bounded step, deduped per
 * wakeId; a host without the acknowledge action degrades to a typed status. Local fixture; the server side is not live.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { classifyWakeAck, createWakeLoop } from '../../src/x6/wake-loop.ts'
import { FakeSocket, mountE4, type Call } from './e4-fixture.ts'

afterEach(() => { FakeSocket.instances.length = 0; vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

const frame = (wakeId: string, extra: Record<string, unknown> = {}, wake: Record<string, unknown> = {}) => ({
  type: 'wake:updated',
  wake: { state: 'idle', ...wake, receipt: { wakeId, at: 1, trigger: 'alarm', headEpoch: 7, headBallId: 'a'.repeat(64), ...extra } },
})

describe('classifyWakeAck', () => {
  it('maps every answer to a typed status without throwing', () => {
    expect(classifyWakeAck(200, { ok: true })).toMatchObject({ status: 'acknowledged' })
    expect(classifyWakeAck(200, { ok: false })).toMatchObject({ status: 'refused', code: 'WAKE_ACK_NOT_CONFIRMED' })
    expect(classifyWakeAck(404, null)).toMatchObject({ status: 'unsupported', httpStatus: 404 })
    expect(classifyWakeAck(400, { code: 'WAKE_REQUEST_INVALID' })).toMatchObject({ status: 'unsupported' })
    expect(classifyWakeAck(405, null).status).toBe('unsupported')
    expect(classifyWakeAck(401, null).status).toBe('unauthorized')
    expect(classifyWakeAck(403, { code: 'OWNER_SESSION_REQUIRED' })).toMatchObject({ status: 'unauthorized', code: 'OWNER_SESSION_REQUIRED' })
    expect(classifyWakeAck(409, { code: 'WAKE_STALE' })).toMatchObject({ status: 'refused', code: 'WAKE_STALE' })
    expect(classifyWakeAck(503, null).status).toBe('unavailable')
    expect(classifyWakeAck(null, null).status).toBe('unreachable')
  })
})

describe('createWakeLoop', () => {
  const deps = (overrides: Partial<Parameters<typeof createWakeLoop>[0]> = {}) => {
    const acks: string[] = [], steps: string[] = []
    let running = false
    const loop = createWakeLoop({
      acknowledge: async (wakeId) => { acks.push(wakeId); return { status: 200, json: { ok: true } } },
      step: async ({ wakeId }) => { steps.push(wakeId); return { ok: true } },
      isTurnRunning: () => running,
      ...overrides,
    })
    return { loop, acks, steps, setRunning: (value: boolean) => { running = value } }
  }

  it('one ack and one step per wakeId; repeats are duplicates; never loops', async () => {
    const { loop, acks, steps } = deps()
    expect(await loop.onFrame(frame('wake-seed-1'))).toMatchObject({ outcome: 'handled', wakeId: 'wake-seed-1', ack: { status: 'acknowledged' } })
    expect(await loop.onFrame(frame('wake-seed-1'))).toMatchObject({ outcome: 'duplicate' })
    expect(await loop.onFrame(frame('wake-seed-1'))).toMatchObject({ outcome: 'duplicate' })
    expect(acks).toEqual(['wake-seed-1'])
    expect(steps).toEqual(['wake-seed-1'])
    expect(await loop.onFrame(frame('wake-seed-2'))).toMatchObject({ outcome: 'handled' })
    expect(steps).toEqual(['wake-seed-1', 'wake-seed-2'])
    expect(loop.snapshot()).toMatchObject({ handledTotal: 2, tracked: 2, inFlight: null })
  })

  it('Lane E5: while a foreground turn runs it still acknowledges, but skips the background step; idle wakes run it', async () => {
    const { loop, acks, steps, setRunning } = deps()
    setRunning(true)
    const out = await loop.onFrame(frame('wake-seed-3'))
    expect(out).toMatchObject({ outcome: 'acknowledged-step-skipped', wakeId: 'wake-seed-3', reason: 'FOREGROUND_TURN_RUNNING',
      ack: { status: 'acknowledged' }, operationId: expect.stringMatching(/^op-/) })
    expect(acks).toEqual(['wake-seed-3'])
    expect(steps).toEqual([])
    // The skipped wake is not replayed later: HEAD already counts it acknowledged.
    setRunning(false)
    expect(await loop.onFrame(frame('wake-seed-3'))).toMatchObject({ outcome: 'duplicate' })
    expect(await loop.onFrame(frame('wake-seed-3b'))).toMatchObject({ outcome: 'handled' })
    expect(acks).toEqual(['wake-seed-3', 'wake-seed-3b'])
    expect(steps).toEqual(['wake-seed-3b'])
    expect(loop.snapshot()).toMatchObject({ handledTotal: 1, skippedForForeground: 1 })
  })

  it('Lane E5: a turn that starts while the acknowledge is in flight also skips the step', async () => {
    let flip: (value: boolean) => void = () => {}
    const { loop, steps, setRunning } = deps({ acknowledge: async () => { flip(true); return { status: 200, json: { ok: true } } } })
    flip = setRunning
    expect(await loop.onFrame(frame('wake-seed-3c'))).toMatchObject({ outcome: 'acknowledged-step-skipped' })
    expect(steps).toEqual([])
  })

  it('ignores manual, idempotent replays, receipt-less frames, malformed ids, and treats wake.changed as a hint', async () => {
    const { loop, acks } = deps()
    expect(await loop.onFrame(frame('wake-seed-4', { trigger: 'manual' }))).toMatchObject({ outcome: 'ignored-manual' })
    expect(await loop.onFrame(frame('wake-seed-5', {}, { idempotent: true }))).toMatchObject({ outcome: 'ignored-idempotent' })
    expect(await loop.onFrame({ type: 'wake:updated', wake: { state: 'idle' } })).toMatchObject({ outcome: 'ignored-no-receipt' })
    expect(await loop.onFrame(frame('../../etc'))).toMatchObject({ outcome: 'invalid', code: 'WAKE_ID_INVALID' })
    expect(await loop.onFrame({ type: 'wake.changed', aura: { open: true } })).toMatchObject({ outcome: 'hint-only' })
    expect(await loop.onFrame({ type: 'ball:commit' })).toBeNull()
    expect(acks).toEqual([])
  })

  it('a second wake while a step runs is marked busy, not queued; a 404 ack is "unsupported" and the step still runs once', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const { loop, acks, steps } = deps({
      acknowledge: async (wakeId) => { acks.push(wakeId); return { status: 404, json: { ok: false, code: 'NOT_FOUND' } } },
      step: async ({ wakeId }) => { steps.push(wakeId); await gate; return { ok: true } },
    })
    const first = loop.onFrame(frame('wake-seed-6'))
    await Promise.resolve(); await Promise.resolve()
    expect(await loop.onFrame(frame('wake-seed-7'))).toMatchObject({ outcome: 'busy' })
    release()
    expect(await first).toMatchObject({ outcome: 'handled', ack: { status: 'unsupported', httpStatus: 404 } })
    expect(steps).toEqual(['wake-seed-6'])
    expect(await loop.onFrame(frame('wake-seed-7'))).toMatchObject({ outcome: 'duplicate' })
  })

  it('a hung step is bounded by its timeout and the step shares the ack operationId', async () => {
    let seen: { transitionKind: string; operationId: string } | null = null
    const { loop } = deps({ stepTimeoutMs: 100, step: async ({ context }) => { seen = context; return await new Promise(() => {}) } })
    const out = await loop.onFrame(frame('wake-seed-8'))
    expect(out).toMatchObject({ outcome: 'handled', step: { ok: false, code: 'WAKE_STEP_TIMEOUT' } })
    expect(seen).toMatchObject({ transitionKind: 'wake.step', operationId: (out as { operationId: string }).operationId })
  })

  it('a network failure on ack is "unreachable", never a throw', async () => {
    const { loop } = deps({ acknowledge: async () => { throw new TypeError('Failed to fetch') } })
    expect(await loop.onFrame(frame('wake-seed-9'))).toMatchObject({ outcome: 'handled', ack: { status: 'unreachable' } })
  })
})

describe('mounted runtime: /_head/ws wake frames', () => {
  const settle = async () => { for (let i = 0; i < 20; i += 1) await new Promise(resolve => setTimeout(resolve, 0)) }

  it('exactly one same-origin acknowledge plus one journaled step; duplicates and BroadcastChannel-free; status reports it', async () => {
    const { calls, vfs, status } = await mountE4({ respond: (call: Call) => call.path === '/_host/wake' ? Response.json({ ok: true, acknowledged: true }) : null })
    const socket = FakeSocket.instances.at(-1)!
    socket.open()
    calls.length = 0
    socket.receive(JSON.stringify(frame('wake-seed-42')))
    socket.receive(JSON.stringify(frame('wake-seed-42')))
    await settle()
    const acks = calls.filter(call => call.path === '/_host/wake')
    expect(acks).toHaveLength(1)
    expect(acks[0]).toMatchObject({ method: 'POST', credentials: 'same-origin', body: { action: 'acknowledge', wakeId: 'wake-seed-42' } })
    expect(Object.keys(acks[0]!.body as object).sort()).toEqual(['action', 'wakeId'])
    expect(acks[0]!.headers.get('x-x6-operation-id')).toMatch(/^op-/)
    const journal = (vfs.readFileSync('/dsh/home/auma/wake/steps.jsonl', 'utf8') as string).trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
    expect(journal).toHaveLength(1)
    expect(journal[0]).toMatchObject({ schema: 'aukora.wake-step.v1', wakeId: 'wake-seed-42', transitionKind: 'wake.step',
      operationId: acks[0]!.headers.get('x-x6-operation-id') })
    const wake = (await status()).wakeLoop as { handledTotal: number; recent: Array<Record<string, unknown>> }
    expect(wake.handledTotal).toBe(1)
    expect(wake.recent.map(item => item.outcome).sort()).toEqual(['duplicate', 'handled'])
  })

  it('a host without the acknowledge action (404) degrades to "unsupported"; manual wakes do nothing', async () => {
    const { calls, status } = await mountE4()
    const socket = FakeSocket.instances.at(-1)!
    socket.open()
    calls.length = 0
    socket.receive(JSON.stringify(frame('wake-seed-43', { trigger: 'manual' })))
    socket.receive(JSON.stringify(frame('wake-seed-44')))
    await settle()
    expect(calls.filter(call => call.path === '/_host/wake').map(call => (call.body as { wakeId: string }).wakeId)).toEqual(['wake-seed-44'])
    const wake = (await status()).wakeLoop as { recent: Array<Record<string, unknown>> }
    expect(wake.recent).toEqual([{ outcome: 'ignored-manual', wakeId: 'wake-seed-43' },
      expect.objectContaining({ outcome: 'handled', wakeId: 'wake-seed-44', ack: expect.objectContaining({ status: 'unsupported', httpStatus: 404 }) })])
  })

  it('Lane E5: while one of her tools is executing, the wake is acknowledged once and no step is journaled', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const { calls, tool, vfs, status } = await mountE4({ respond: (call: Call) => {
      if (call.path === '/_head/ball' && call.method === 'GET' && hold) return gate.then(() => null)
      if (call.path === '/_host/wake') return Response.json({ ok: true, acknowledgedWakeId: 'wake-seed-45' })
      return null
    } })
    let hold = true
    const socket = FakeSocket.instances.at(-1)!
    socket.open()
    // stage_organ_promotion parks on GET /_head/ball: a tool is in flight.
    const pending = tool('stage_organ_promotion').execute({ id: 'organ-a', specifier: 'ball:' + '1'.repeat(64) })
    await settle()
    socket.receive(JSON.stringify(frame('wake-seed-45')))
    await settle()
    const acks = calls.filter(call => call.path === '/_host/wake')
    expect(acks).toHaveLength(1)
    expect(acks[0]).toMatchObject({ method: 'POST', body: { action: 'acknowledge', wakeId: 'wake-seed-45' } })
    expect(vfs.existsSync('/dsh/home/auma/wake/steps.jsonl')).toBe(false)
    const wake = (await status()).wakeLoop as { recent: Array<Record<string, unknown>>; skippedForForeground: number }
    expect(wake.skippedForForeground).toBe(1)
    expect(wake.recent.at(-1)).toMatchObject({ outcome: 'acknowledged-step-skipped', wakeId: 'wake-seed-45' })
    hold = false
    release()
    await pending.catch(() => null)
  })
})
