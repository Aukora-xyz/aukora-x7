/**
 * Lane E6 task 1: normal-path settlement of the consult parent turn Lane E5 acquires. When the last consult or swarm
 * under an auto-acquired `chat-<uuid>` lease finishes without aborting, HEAD gets exactly one best-effort `turn_complete`
 * and the lease is evicted; abort still goes to `turn_abandon`; a caller-supplied parent is never settled by the runtime.
 * Local `.invalid` origin only: no provider, owner approval or live DO is reached.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FakeSocket, mountE4, type Call } from './e4-fixture.ts'

afterEach(() => { FakeSocket.instances.length = 0; vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

const consultInput = { provider: 'deepseek', model: 'deepseek-chat', prompt: 'synthetic', maxTokens: 64 }
const settle = async () => { for (let i = 0; i < 10; i += 1) await new Promise(resolve => setTimeout(resolve, 0)) }
interface Transcript { action: string; turn_id: string; tab_id: string }

async function harness(options: { door?: () => Promise<Response>; complete?: (input: Transcript) => Response | Promise<Response> } = {}) {
  let generation = 0
  const mounted = await mountE4({ respond: async (call: Call) => {
    if (call.path === '/_head/transcript') {
      const input = call.body as Transcript
      if (input.action === 'turn_start') {
        generation += 1
        return Response.json({ ok: true, turn: { turn_id: input.turn_id, tab_id: input.tab_id, generation, status: 'running' } })
      }
      if (input.action === 'turn_complete' && options.complete) return await options.complete(input)
      return Response.json({ ok: true, turn: { turn_id: input.turn_id, tab_id: input.tab_id, generation,
        status: input.action === 'turn_abandon' ? 'abandoned' : input.action === 'turn_complete' ? 'completed' : 'running' } })
    }
    if (call.path.startsWith('/door/')) return options.door ? await options.door() : Response.json({ choices: [{ message: { content: 'synthetic answer' } }] })
    return null
  } })
  const controller = new AbortController()
  const exec = { agent: {}, signal: controller.signal }
  const run = async (name: string, args: Record<string, unknown>, execution: unknown = exec) =>
    await mounted.tool(name).execute(args, execution)
  const of = (action: string) => mounted.calls.filter(call => call.path === '/_head/transcript')
    .map(call => call.body as Transcript).filter(call => call.action === action).map(call => call.turn_id)
  return { ...mounted, exec, controller, run, of }
}

describe('Lane E6: turn_complete settles a finished auto-acquired consult parent', () => {
  it('a normal consult sends exactly one turn_complete for its chat- turn, never turn_abandon, and evicts the lease', async () => {
    const h = await harness()
    expect(await h.run('x6_consult', consultInput)).toMatchObject({ ok: true })
    await settle()
    const [turnId] = h.of('turn_start')
    expect(turnId).toMatch(/^chat-[0-9a-f-]{36}$/)
    expect(h.of('turn_complete')).toEqual([turnId])
    expect(h.of('turn_abandon')).toEqual([])
    // Ending the caller turn afterwards cannot abandon an already completed parent (its listener was removed).
    h.controller.abort()
    await settle()
    expect(h.of('turn_abandon')).toEqual([])
    expect(h.of('turn_complete')).toEqual([turnId])
  })

  it('coalesced parallel consults and a swarm share one turn and settle once, only after the last one finishes', async () => {
    const gates: Array<PromiseWithResolvers<undefined>> = []
    const h = await harness({ door: async () => {
      const gate = Promise.withResolvers<undefined>(); gates.push(gate); await gate.promise
      return Response.json({ choices: [{ message: { content: 'ok' } }] })
    } })
    const pending = [
      h.run('x6_consult', consultInput), h.run('x6_consult', { ...consultInput, prompt: 'b' }),
      h.run('x6_swarm', { tasks: [{ ...consultInput, prompt: 'c' }] }),
    ]
    while (gates.length < 3) await settle()
    expect(h.of('turn_start')).toHaveLength(1)
    gates[0]!.resolve(undefined); await pending[0]; await settle()
    gates[1]!.resolve(undefined); await settle()
    expect(h.of('turn_complete')).toEqual([])
    gates[2]!.resolve(undefined)
    const results = await Promise.all(pending)
    expect(results.every(result => (result as { ok?: boolean }).ok === true)).toBe(true)
    await settle()
    expect(h.of('turn_complete')).toEqual(h.of('turn_start'))
    expect(h.of('turn_abandon')).toEqual([])
  })

  it('an aborted consult still abandons and never completes', async () => {
    const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
    const h = await harness({ door: async () => { entered.resolve(undefined); await release.promise; return Response.json({ choices: [{ message: { content: 'late' } }] }) } })
    const pending = h.run('x6_consult', consultInput)
    await entered.promise
    h.controller.abort()
    release.resolve(undefined)
    await pending
    await settle()
    expect(h.of('turn_abandon')).toEqual(h.of('turn_start'))
    expect(h.of('turn_complete')).toEqual([])
  })

  it('never settles a caller-supplied parent turn', async () => {
    const h = await harness()
    await h.run('x6_repo', { action: 'transcript', subAction: 'turn_start', turn_id: 'owned-A' })
    expect(await h.run('x6_consult', consultInput)).toMatchObject({ ok: true })
    expect(await h.run('x6_consult', { ...consultInput, prompt: 'again' })).toMatchObject({ ok: true })
    await settle()
    expect(h.of('turn_start')).toEqual(['owned-A'])
    expect(h.of('turn_complete')).toEqual([])
  })

  it('a failing turn_complete never changes the consult result; the next consult acquires a fresh parent', async () => {
    const h = await harness({ complete: () => { throw new Error('HEAD down') } })
    expect(await h.run('x6_consult', consultInput)).toMatchObject({ ok: true })
    await settle()
    expect(await h.run('x6_consult', consultInput)).toMatchObject({ ok: true })
    await settle()
    const starts = h.of('turn_start')
    expect(starts).toHaveLength(2)
    expect(starts[0]).not.toBe(starts[1])
    expect(h.of('turn_complete')).toEqual(starts)
  })
})
