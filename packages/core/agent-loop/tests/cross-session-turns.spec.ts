/**
 * voicelane1 (2026-11-16): her voice thread and her working thread are two Agents, each with its own inbox and driver.
 * A long turn in one never holds the other: a spoken prompt sent to an idle thread while another thread's model call is
 * still in flight starts its own turn at once, streams its first words and ends, and cancelling it leaves the working
 * turn running. This is the runtime fact Auma Live's spoken turns rely on (apps/web/public/app/genesis-live.js).
 * @module dsh-agent-loop/tests/cross-session-turns
 */
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { MockAdapter, textResponse } from './mock-adapter.ts'

const owned = new Set<Context>()
afterEach(async () => {
  await Promise.all([...owned].map(ctx => ctx.fiber.dispose()))
  owned.clear()
})

async function harness(adapter: MockAdapter): Promise<Context> {
  const ctx = new Context()
  owned.add(ctx)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
}

const send = (agent: Agent, text: string): void => {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
}

/** Resolve on the agent's next idle transition. */
const idle = (ctx: Context, agent: Agent): Promise<void> => new Promise((resolve) => {
  const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
    if (subject === agent && status === 'idle') { dispose(); resolve() }
  })
})

describe('a turn in one thread never holds another thread\'s turn', () => {
  it('a long working turn is in flight; a spoken prompt to the idle voice thread streams its first words and ends', async () => {
    // The working thread's model call hangs (a long round); the voice thread's call answers.
    const adapter = new MockAdapter(['hang', textResponse('Working on card four.')])
    const ctx = await harness(adapter)
    const work = await ctx.agentLoop.create(SessionId('working-thread'), { provider: 'mock', model: 'mock' })
    const voice = await ctx.agentLoop.create(SessionId('voice-thread'), { provider: 'mock', model: 'mock' })
    const firstWords: string[] = []
    ctx.on('agent/assistant-stream', ({ agent: subject, frame }) => {
      if (subject === voice && frame.type === 'chunk' && frame.chunk.type === 'text-delta') firstWords.push(frame.chunk.text)
    })

    send(work, 'run the long card')
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(work.status).toBe('running')
    expect(adapter.requests).toHaveLength(1)

    const voiceDone = idle(ctx, voice)
    send(voice, 'what are you doing right now')
    await voiceDone

    expect(firstWords.join('')).toBe('Working on card four.')
    expect(voice.session.snapshotEvents().some(event => event.type === 'turn/end')).toBe(true)
    // The working turn never ended or yielded while the spoken one ran.
    expect(work.status).toBe('running')
    expect(work.session.snapshotEvents().some(event => event.type === 'turn/end')).toBe(false)

    const workDone = idle(ctx, work)
    work.cancel({ kind: 'user' })
    await workDone
  })

  it('cancelling the spoken turn stops the voice thread only; the working turn runs on', async () => {
    const adapter = new MockAdapter(['hang', 'hang'])
    const ctx = await harness(adapter)
    const work = await ctx.agentLoop.create(SessionId('working-thread-2'), { provider: 'mock', model: 'mock' })
    const voice = await ctx.agentLoop.create(SessionId('voice-thread-2'), { provider: 'mock', model: 'mock' })
    send(work, 'long card')
    send(voice, 'stop that')
    await new Promise(resolve => setTimeout(resolve, 0))
    expect([work.status, voice.status]).toEqual(['running', 'running'])
    const voiceDone = idle(ctx, voice)
    voice.cancel({ kind: 'user' })
    await voiceDone
    expect(voice.status).toBe('idle')
    expect(work.status).toBe('running')
    expect(work.session.snapshotEvents().some(event => event.type === 'turn/end')).toBe(false)
    const workDone = idle(ctx, work)
    work.cancel({ kind: 'user' })
    await workDone
  })
})
