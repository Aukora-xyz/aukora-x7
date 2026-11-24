/**
 * A long consult is not cancelled by her own other calls. HEAD abandons a running turn whose
 * heartbeat is older than 30 s as soon as any transcript transaction runs, and cancels its provider dispatches
 * (deploy/cloudflare/src/head-do.mjs, the `head:turn:active` check before every transcript action). The fake HEAD below
 * models exactly that rule; the runtime is the real mounted one. While a consult lease has consults running, its parent
 * turn gets one `turn_heartbeat` every 10 s. Local `.invalid` origin only: no provider or live DO is reached.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FakeSocket, mountE4, type Call } from './e4-fixture.ts'

afterEach(() => { FakeSocket.instances.length = 0; vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

const consultInput = { provider: 'deepseek', model: 'deepseek-chat', prompt: 'synthetic', maxTokens: 64 }
const settle = async () => { for (let i = 0; i < 10; i += 1) await new Promise(resolve => setTimeout(resolve, 0)) }
interface Transcript { action: string; turn_id?: string; tab_id: string }

async function harness(options: { heartbeat?: (n: number) => Response | null } = {}) {
  let clock = 0, generation = 0, heartbeats = 0
  let active: { turn_id: string; tab_id: string; generation: number; heartbeat_at: number; status: string } | null = null
  const doors: Array<{ resolve: (response: Response) => void }> = []
  const cancelled: string[] = []
  const mounted = await mountE4({ respond: async (call: Call) => {
    if (call.path === '/_head/transcript') {
      const input = call.body as Transcript
      // HEAD's rule, modelled: any transcript transaction first abandons a running turn whose heartbeat is > 30 s old
      // and cancels its provider dispatches.
      if (active?.status === 'running' && clock - active.heartbeat_at > 30_000) {
        active = { ...active, status: 'abandoned' }
        cancelled.push(active.turn_id)
        for (const door of doors.splice(0)) door.resolve(Response.json({ error: { type: 'cancelled', message: 'turn abandoned' } }, { status: 409 }))
      }
      if (input.action === 'turn_start') {
        generation += 1
        active = { turn_id: input.turn_id!, tab_id: input.tab_id, generation, heartbeat_at: clock, status: 'running' }
        return Response.json({ ok: true, turn: active })
      }
      if (input.action === 'turn_heartbeat') {
        heartbeats += 1
        const forced = options.heartbeat?.(heartbeats)
        if (forced) return forced
        if (active === null || active.turn_id !== input.turn_id || active.status !== 'running') return Response.json({ ok: false, code: 'TURN_NOT_ACTIVE', turn: active }, { status: 409 })
        active = { ...active, heartbeat_at: clock }
        return Response.json({ ok: true, turn: active })
      }
      if (input.action === 'turn_complete' || input.action === 'turn_abandon') {
        if (active !== null && active.turn_id === input.turn_id) active = { ...active, status: input.action === 'turn_complete' ? 'completed' : 'abandoned' }
        return Response.json({ ok: true, turn: { ...active, turn_id: input.turn_id } })
      }
      return Response.json({ ok: true, seq: 0, rows: [], turn: active })
    }
    if (call.path.startsWith('/door/')) {
      return await new Promise<Response>((resolve) => { doors.push({ resolve }) })
    }
    return null
  } })
  const controller = new AbortController()
  const exec = { agent: {}, signal: controller.signal }
  const run = async (name: string, args: Record<string, unknown>) => await mounted.tool(name).execute(args, exec)
  const of = (action: string) => mounted.calls.filter(call => call.path === '/_head/transcript')
    .map(call => call.body as Transcript).filter(call => call.action === action)
  /** Move HEAD's clock and the runtime's interval timers forward together. */
  const advance = async (ms: number) => {
    for (let step = 0; step < ms; step += 5_000) {
      clock += 5_000
      await vi.advanceTimersByTimeAsync(5_000)
      await settle()
    }
  }
  const answerDoors = () => { for (const door of doors.splice(0)) door.resolve(Response.json({ choices: [{ finish_reason: 'stop', message: { content: 'long answer' } }] })) }
  const waitDoors = async (count: number) => { while (doors.length < count) await settle() }
  return { ...mounted, run, of, advance, answerDoors, waitDoors, cancelled, heartbeats: () => heartbeats }
}

describe('a long consult keeps its parent turn alive', () => {
  it('a transcript read at 45 s does not cancel a running consult; after it settles no heartbeat is sent', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const h = await harness()
    const pending = h.run('x6_consult', consultInput)
    await h.waitDoors(1)
    await h.advance(45_000)
    expect(await h.run('x6_repo', { action: 'transcript', subAction: 'read' })).toMatchObject({ ok: true })
    expect(h.cancelled).toEqual([])
    const turnId = h.of('turn_start')[0]!.turn_id
    expect(h.of('turn_heartbeat').map(call => call.turn_id)).toEqual([turnId, turnId, turnId, turnId])
    h.answerDoors()
    expect(await pending).toMatchObject({ ok: true, answers: [{ ok: true, text: 'long answer' }] })
    await settle()
    expect(h.of('turn_complete').map(call => call.turn_id)).toEqual([turnId])
    const sent = h.heartbeats()
    await h.advance(60_000)
    expect(h.heartbeats()).toBe(sent)
  })

  it('two consults in one lease send one heartbeat stream, until the last one settles', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const h = await harness()
    const pending = Promise.all([h.run('x6_consult', consultInput), h.run('x6_consult', { ...consultInput, prompt: 'second' })])
    await h.waitDoors(2)
    expect(h.of('turn_start')).toHaveLength(1)
    await h.advance(30_000)
    expect(h.heartbeats()).toBe(3)
    h.answerDoors()
    const results = await pending
    expect(results.every(result => (result as { ok?: boolean }).ok === true)).toBe(true)
    await settle()
    await h.advance(30_000)
    expect(h.heartbeats()).toBe(3)
  })

  it('a failed heartbeat is tried again on the next tick and never reaches the consult', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const h = await harness({ heartbeat: n => n === 1 ? Response.json({ ok: false, code: 'HEAD_BUSY' }, { status: 503 })
      : n === 2 ? new Response('not json', { status: 502 }) : null })
    const pending = h.run('x6_consult', consultInput)
    await h.waitDoors(1)
    await h.advance(40_000)
    expect(h.heartbeats()).toBe(4)
    // The last good heartbeat was at 40 s (the two at 10 s and 20 s failed, 30 s and 40 s landed): a read at 45 s is safe.
    await h.advance(5_000)
    expect(await h.run('x6_repo', { action: 'transcript', subAction: 'read' })).toMatchObject({ ok: true })
    expect(h.cancelled).toEqual([])
    h.answerDoors()
    expect(await pending).toMatchObject({ ok: true, answers: [{ ok: true, text: 'long answer' }] })
  })

  it('the modelled rule bites: a turn without heartbeats is abandoned by a read at 45 s and its consult is cancelled', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const h = await harness()
    // A caller-supplied parent (her own x6_transcript turn_start) is hers to keep alive: the runtime sends no heartbeat for it.
    await h.run('x6_repo', { action: 'transcript', subAction: 'turn_start', turn_id: 'owned-A' })
    const pending = h.run('x6_consult', consultInput)
    await h.waitDoors(1)
    await h.advance(45_000)
    expect(h.heartbeats()).toBe(0)
    await h.run('x6_repo', { action: 'transcript', subAction: 'read' })
    expect(h.cancelled).toEqual(['owned-A'])
    expect(await pending).toMatchObject({ ok: false, answers: [{ ok: false, status: 409, code: 'HTTP_409' }] })
  })
})
