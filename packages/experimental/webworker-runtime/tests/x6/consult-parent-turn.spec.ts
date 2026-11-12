/**
 * Lane E5 task 1 (P0): `x6_consult` / `x6_swarm` acquire their parent transcript turn themselves. Before this, the
 * runtime answered CONSULT_PARENT_TURN_REQUIRED unless she had first called `x6_transcript turn_start` in the same agent
 * turn, which a normal chat turn never does. Proven on the mounted runtime against a local `.invalid` origin: the
 * provider door and /_head/transcript are local fixtures; no provider, owner approval or live DO is reached.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FakeSocket, mountE4, type Call } from './e4-fixture.ts'

afterEach(() => { FakeSocket.instances.length = 0; vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

const consultInput = { provider: 'deepseek', model: 'deepseek-chat', prompt: 'synthetic', maxTokens: 64 }
const settle = async () => { for (let i = 0; i < 10; i += 1) await new Promise(resolve => setTimeout(resolve, 0)) }

interface Transcript { action: string; turn_id: string; tab_id: string }

async function consultHarness(options: {
  start?: (input: Transcript, n: number) => Response | Promise<Response>
  door?: () => Promise<Response>
} = {}) {
  let generation = 0
  let starts = 0
  const transcript = (call: Call) => {
    const input = call.body as Transcript
    if (input.action === 'turn_start') {
      starts += 1
      if (options.start) return options.start(input, starts)
      generation += 1
      return Response.json({ ok: true, turn: { turn_id: input.turn_id, tab_id: input.tab_id, generation, status: 'running' } })
    }
    return Response.json({ ok: true, turn: { turn_id: input.turn_id, tab_id: input.tab_id, generation,
      status: input.action === 'turn_abandon' ? 'abandoned' : input.action === 'turn_complete' ? 'completed' : 'running' } })
  }
  const mounted = await mountE4({ respond: async (call) => {
    if (call.path === '/_head/transcript') return await transcript(call)
    if (call.path.startsWith('/door/')) return options.door ? await options.door() : Response.json({ choices: [{ message: { content: 'synthetic answer' } }] })
    return null
  } })
  // Keep each door request's signal, which the fixture's call log does not carry.
  const doorSignals: AbortSignal[] = []
  const inner = globalThis.fetch
  vi.stubGlobal('fetch', async (resource: RequestInfo | URL, init?: RequestInit) => {
    if (new URL(new Request(resource, init).url).pathname.startsWith('/door/') && init?.signal) doorSignals.push(init.signal)
    return await inner(resource, init)
  })
  const controller = new AbortController()
  const exec = { agent: {}, signal: controller.signal }
  const run = async (name: string, args: Record<string, unknown>, execution: unknown = exec) =>
    await mounted.tool(name).execute(args, execution)
  const transcriptCalls = () => mounted.calls.filter(call => call.path === '/_head/transcript').map(call => call.body as Transcript)
  const doors = () => mounted.calls.filter(call => call.path.startsWith('/door/'))
  return { ...mounted, exec, controller, run, transcriptCalls, doors, doorSignals, starts: () => starts }
}

describe('x6_consult / x6_swarm acquire their own parent turn', () => {
  it('needs no manual x6_transcript: each finished consult or swarm commits one turn_start and settles it (Lane E6)', async () => {
    const h = await consultHarness()
    expect(await h.run('x6_consult', consultInput)).toMatchObject({ ok: true })
    const starts = h.transcriptCalls().filter(call => call.action === 'turn_start')
    expect(starts).toHaveLength(1)
    expect(starts[0]!.turn_id).toMatch(/^chat-[0-9a-f-]{36}$/)
    expect(await h.run('x6_consult', { ...consultInput, prompt: 'second' })).toMatchObject({ ok: true })
    expect(await h.run('x6_swarm', { tasks: [{ ...consultInput }, { ...consultInput, prompt: 'worker two' }] })).toMatchObject({ ok: true })
    await settle()
    // Lane E6: a finished auto-acquired parent is settled with turn_complete and evicted, so the next call acquires anew.
    const all = h.transcriptCalls().filter(call => call.action === 'turn_start').map(call => call.turn_id)
    expect(all).toHaveLength(3)
    expect(h.transcriptCalls().filter(call => call.action === 'turn_complete').map(call => call.turn_id)).toEqual(all)
    expect(h.doors()).toHaveLength(4)
    expect(h.doors().map(call => call.headers.get('x-x6-turn-id'))).toEqual([all[0], all[1], all[2], all[2]])
    expect(new Set(h.doors().map(call => call.headers.get('x-x6-request-id'))).size).toBe(4)
    // Her status does not mistake the consult parent for a streaming foreground turn (the wake guard reads it).
    expect(h.calls.filter(call => call.path === '/_host/wake')).toHaveLength(0)
  })

  it('Promise.all of parallel consults and a swarm issues exactly one turn_start', async () => {
    const gate = Promise.withResolvers<undefined>()
    let generation = 0
    const h = await consultHarness({ start: async (input) => {
      await gate.promise
      generation += 1
      return Response.json({ ok: true, turn: { turn_id: input.turn_id, tab_id: input.tab_id, generation, status: 'running' } })
    } })
    const pending = Promise.all([
      h.run('x6_consult', consultInput), h.run('x6_consult', { ...consultInput, prompt: 'b' }),
      h.run('x6_consult', { ...consultInput, prompt: 'c' }), h.run('x6_swarm', { tasks: [{ ...consultInput, prompt: 'd' }] }),
    ])
    await settle()
    gate.resolve(undefined)
    const results = await pending
    expect(results.every(result => (result as { ok?: boolean }).ok === true)).toBe(true)
    expect(h.starts()).toBe(1)
    const turnId = h.transcriptCalls().find(call => call.action === 'turn_start')!.turn_id
    expect(h.doors()).toHaveLength(4)
    expect(h.doors().every(call => call.headers.get('x-x6-turn-id') === turnId)).toBe(true)
  })

  it('ending the caller turn (exec.signal) aborts the in-flight consult and abandons the acquired turn on HEAD', async () => {
    const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
    const h = await consultHarness({ door: async () => { entered.resolve(undefined); await release.promise; return Response.json({ choices: [{ message: { content: 'late' } }] }) } })
    const pending = h.run('x6_consult', consultInput)
    await entered.promise
    const turnId = h.transcriptCalls().find(call => call.action === 'turn_start')!.turn_id
    h.controller.abort()
    expect(h.doorSignals[0]!.aborted).toBe(true)
    release.resolve(undefined)
    expect(await pending).toMatchObject({ ok: false, answers: [{ ok: false, text: null, code: 'CONSULT_CANCELLED' }] })
    await settle()
    expect(h.transcriptCalls().filter(call => call.action === 'turn_abandon').map(call => call.turn_id)).toEqual([turnId])
    // The aborted caller cannot start another parent.
    expect(await h.run('x6_consult', consultInput)).toMatchObject({ code: 'CONSULT_PARENT_TURN_REQUIRED' })
    expect(h.starts()).toBe(1)
    // A new caller turn on the same agent acquires a fresh parent.
    const next = new AbortController()
    expect(await h.run('x6_consult', consultInput, { agent: h.exec.agent, signal: next.signal })).toMatchObject({ ok: true })
    const second = h.transcriptCalls().filter(call => call.action === 'turn_start').map(call => call.turn_id)
    expect(second).toHaveLength(2)
    expect(second[1]).not.toBe(turnId)
  })

  it('stays fail-closed without an agent or signal, with an aborted signal, and when HEAD refuses the start', async () => {
    const h = await consultHarness({ start: (input, n) => n === 1
      ? Response.json({ ok: false, code: 'TURN_ALREADY_RUNNING', status: 409, turn: { turn_id: 'other-tab-turn', tab_id: 'another-tab', generation: 4, status: 'running' } }, { status: 409 })
      : Response.json({ ok: true, turn: { turn_id: input.turn_id, tab_id: input.tab_id, generation: 5, status: 'completed' } }) })
    const aborted = new AbortController(); aborted.abort()
    const missing = [null, {}, { signal: h.exec.signal }, { agent: h.exec.agent }, { agent: h.exec.agent, signal: aborted.signal }]
    for (const execution of missing) {
      expect(await h.run('x6_consult', consultInput, execution)).toMatchObject({ ok: false, code: 'CONSULT_PARENT_TURN_REQUIRED' })
      expect(await h.run('x6_swarm', { tasks: [consultInput] }, execution)).toMatchObject({ ok: false, code: 'CONSULT_PARENT_TURN_REQUIRED' })
    }
    expect(h.starts()).toBe(0)
    // HEAD refuses (another tab holds the turn): parallel callers share the one refused start and all fail closed.
    const refused = await Promise.all([h.run('x6_consult', consultInput), h.run('x6_swarm', { tasks: [consultInput] })])
    expect(refused).toEqual([expect.objectContaining({ code: 'CONSULT_PARENT_TURN_REQUIRED' }), expect.objectContaining({ code: 'CONSULT_PARENT_TURN_REQUIRED' })])
    expect(h.starts()).toBe(1)
    // An acknowledgement that is not a running turn binds nothing either.
    expect(await h.run('x6_consult', consultInput)).toMatchObject({ code: 'CONSULT_PARENT_TURN_REQUIRED' })
    expect(h.starts()).toBe(2)
    expect(h.doors()).toHaveLength(0)
  })
})
