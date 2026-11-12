/** Turns on the official endpoint report credential failures on the model request, after the prompt is recorded. */
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import * as DeepSeek from '@deepseek-ai/dsh-llm-deepseek-api-key'

const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

it('records the prompt and fails the request when the official endpoint has a malformed key', async () => {
  vi.stubEnv('DEEPSEEK_API_KEY', 'invalid\nheader')
  const fetch = vi.spyOn(globalThis, 'fetch')
  const ctx = new Context()
  contexts.push(ctx)
  for (const plugin of [LlmRuntime, SessionStore, SessionProjectionRegistry, SystemPrompt, ToolRuntime, AgentRegistry]) {
    await ctx.plugin(plugin)
  }
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(DeepSeek, {})
  const agent = await ctx.agentLoop.create(SessionId('malformed-official-key'), { provider: 'deepseek-official', model: 'deepseek-flash' })
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }))
  await agent.whenIdle()
  const events = agent.session.snapshotEvents()
  expect(events.map(event => event.type)).toContain('user/message')
  expect(events.find(event => event.type === 'assistant/attempt')?.data).toMatchObject({
    stream: [{ chunk: { type: 'finish', reason: { kind: 'error', failure: { code: 'INVALID_CREDENTIAL' } } } }],
  })
  expect(fetch).not.toHaveBeenCalled()
})


it('records a status-only non-JSON model failure without the response body in the Session', async () => {
  vi.stubEnv('DEEPSEEK_API_KEY', 'fixture-key')
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(
    '<!DOCTYPE html><html>PRIVATE_GATEWAY_BODY</html>', { status: 502, headers: { 'content-type': 'text/html' } },
  ))
  const ctx = new Context()
  contexts.push(ctx)
  for (const plugin of [LlmRuntime, SessionStore, SessionProjectionRegistry, SystemPrompt, ToolRuntime, AgentRegistry]) {
    await ctx.plugin(plugin)
  }
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(DeepSeek, { baseURL: 'https://fixture.invalid' })
  const agent = await ctx.agentLoop.create(SessionId('non-json-model-error'), { provider: 'deepseek-official', model: 'deepseek-flash' })
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }))
  await agent.whenIdle()
  const events = agent.session.snapshotEvents()
  const failure = { message: 'HTTP 502', code: 'SERVER', status: 502, httpStatus: 502 }
  expect(events.find(event => event.type === 'assistant/attempt')?.data).toMatchObject({
    stream: [{ chunk: { type: 'finish', reason: { kind: 'error', failure } } }],
  })
  expect(events.find(event => event.type === 'turn/end')?.data).toEqual({ turn: 1, reason: { kind: 'error', error: failure } })
  expect(JSON.stringify(events)).not.toMatch(/PRIVATE_GATEWAY_BODY|<!DOCTYPE|<html>/u)
  expect(events.filter(event => event.type === 'tool/call')).toHaveLength(0)
  expect(fetch).toHaveBeenCalledOnce()
})
