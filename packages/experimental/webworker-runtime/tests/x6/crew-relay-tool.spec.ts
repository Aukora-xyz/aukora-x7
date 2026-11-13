/**
 * job 3: Auma's `crew_relay` built-in, landed from her branch, on her REAL runtime with the REAL ToolsService and
 * `defineTool` (a schema key the DSL refuses would stop the tool registering; the stand-in host would not notice).
 * Every HTTP answer is local (the E4 fixture's `.invalid` origin); nothing reaches Linear or the edge.
 */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import SystemPrompt from '../../../../core/system-prompt/src/index.ts'
import ToolRuntime, * as dshTools from '../../../../core/tools/src/index.ts'
import { FakeSocket, ORIGIN, mountE4, type Call } from './e4-fixture.ts'

const contexts: Context[] = []
afterEach(async () => {
  for (const context of contexts.splice(0)) await context.fiber.dispose()
  FakeSocket.instances.length = 0
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

interface Fetched { url: string; method: string; credentials: RequestCredentials | undefined; contentType: string | null; body: unknown }

/** Mount her runtime on a real host; `relay` answers /_host/crew-relay. Every fetch the runtime makes is recorded. */
async function mount(relay: (call: Call) => Response) {
  const context = new Context()
  contexts.push(context)
  await context.plugin(SystemPrompt, {})
  await context.plugin(ToolRuntime)
  const m = await mountE4({ host: { context, dshTools }, nodeBuiltins: true,
    respond: call => (call.path === '/_host/crew-relay' ? relay(call) : null) })
  const fixtureFetch = globalThis.fetch
  const fetched: Fetched[] = []
  vi.stubGlobal('fetch', async (resource: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(resource, init)
    const text = request.method === 'GET' ? '' : await request.clone().text()
    fetched.push({ url: request.url, method: request.method, credentials: init?.credentials,
      contentType: request.headers.get('content-type'), body: text === '' ? null : JSON.parse(text) as unknown })
    return await fixtureFetch(resource, init)
  })
  return { ...m, context, fetched }
}

describe('crew_relay on her runtime', () => {
  it('registers through the real defineTool and is listed by x6_capability_index as a mutating tool', async () => {
    const m = await mount(() => Response.json({ ok: true }))
    const tool = m.tool('crew_relay')
    expect(m.context.tools.definitions().map(definition => definition.name)).toContain('crew_relay')
    type Parameter = { name: string; required: boolean; enum?: string[] }
    type Summary = { name: string; readOnly: boolean; mutating: boolean; parameters: Parameter[] }
    const index = await m.tool('x6_capability_index').execute({ action: 'snapshot' }) as { registeredTools: Summary[] }
    const entry = index.registeredTools.find(item => item.name === 'crew_relay')
    expect(entry).toMatchObject({ readOnly: false, mutating: true })
    expect(entry!.parameters).toEqual([
      { name: 'after', type: 'string', required: false },
      { name: 'body', type: 'string', required: false },
      { name: 'op', type: 'string', required: true, enum: ['read', 'say'] },
    ])
    expect(tool.description).toContain('the relay issue')
    // The reason for the one schema change: the DSL refuses `maxLength`, so her first spelling would never register.
    expect(() => dshTools.defineTool({ name: 'crew_relay_probe', description: 'probe', output: { schema: { type: 'json' }, render: () => [] },
      parameters: { body: { type: 'string', maxLength: 4000 } }, execute: async () => null } as never)).toThrow(/maxLength/)
  })

  it('a read is one same-origin GET of /_host/crew-relay with the cursor, and its body comes back as is', async () => {
    const page = { ok: true, schema: 'aukora.crew-relay.v1', issue: { identifier: 'YOUR_TEAM-0', title: 'Crew relay' },
      comments: [{ id: 'c-2', body: 'READY', createdAt: '2026-11-13T07:00:01.000Z', author: 'The owner' }], gap: false }
    const m = await mount(() => Response.json(page))
    const answer = await m.tool('crew_relay').execute({ op: 'read', after: '2026-11-13T07:00:00.000Z' })
    expect(answer).toEqual(page)
    expect(m.fetched).toEqual([{ url: `${ORIGIN}/_host/crew-relay?after=2026-11-13T07%3A00%3A00.000Z`, method: 'GET',
      credentials: 'same-origin', contentType: null, body: null }])
  })

  it('a say is one same-origin POST carrying exactly { body }', async () => {
    const created = { ok: true, schema: 'aukora.crew-relay.v1', comment: { id: 'c-3', createdAt: '2026-11-13T07:00:02.000Z' } }
    const m = await mount(() => Response.json(created, { status: 201 }))
    const answer = await m.tool('crew_relay').execute({ op: 'say', body: 'READY 9: Auma.', after: '2026-11-13T07:00:00.000Z' })
    expect(answer).toEqual(created)
    expect(m.fetched).toEqual([{ url: `${ORIGIN}/_host/crew-relay`, method: 'POST', credentials: 'same-origin',
      contentType: 'application/json', body: { body: 'READY 9: Auma.' } }])
  })

  it('a say with an @mention or a leading slash command is refused before any fetch; an email address is not a mention', async () => {
    const created = { ok: true, schema: 'aukora.crew-relay.v1', comment: { id: 'c-4', createdAt: '2026-11-13T07:00:03.000Z' } }
    const m = await mount(() => Response.json(created, { status: 201 }))
    for (const body of ['@dot please look', 'see this @grok-bot', '/delegate something', '  /close']) {
      expect(await m.tool('crew_relay').execute({ op: 'say', body })).toMatchObject({ ok: false, code: 'RELAY_SAY_NEEDS_OWNER' })
    }
    expect(m.fetched).toEqual([])
    expect(await m.tool('crew_relay').execute({ op: 'say', body: 'write to crew@example.org or use `@name` in code' })).toEqual(created)
    expect(m.fetched).toHaveLength(1)
  })

  it('a 502 refusal with code and check comes back unchanged', async () => {
    const refusal = { ok: false, code: 'RELAY_UPSTREAM_MALFORMED', check: 'outside-page' }
    const m = await mount(() => Response.json(refusal, { status: 502 }))
    expect(await m.tool('crew_relay').execute({ op: 'read' })).toEqual(refusal)
    expect(m.fetched.map(call => `${call.method} ${call.url}`)).toEqual([`GET ${ORIGIN}/_host/crew-relay`])
  })

  it('an answer that is not JSON is reported with its status; an unknown op fetches nothing', async () => {
    const m = await mount(() => new Response('<html>bad gateway</html>', { status: 502, headers: { 'content-type': 'text/html' } }))
    expect(await m.tool('crew_relay').execute({ op: 'read' })).toEqual({ ok: false, code: 'RELAY_ANSWER_NOT_JSON', status: 502 })
    // The real defineTool refuses an op outside the enum before her own RELAY_OPERATION_UNKNOWN check is reached.
    await expect(m.tool('crew_relay').execute({ op: 'graphql', query: '{ viewer { id } }' })).rejects.toThrow(/"op" must be one of/)
    expect(m.fetched).toHaveLength(1)
  })

  it('her description names the edge post interval code and the way out of an oversized read', async () => {
    const m = await mount(() => Response.json({ ok: true }))
    const description = m.tool('crew_relay').description
    // The edge's 5 s rule is between two posts and answers 429 RELAY_RATE_LIMITED (crew-relay.mjs MIN_POST_INTERVAL_MS).
    expect(description).toMatch(/Posts must be at least 5 s apart; a sooner one answers 429 `RELAY_RATE_LIMITED`/)
    expect(description).not.toMatch(/before `read`/)
    expect(description).toMatch(/`RELAY_ANSWER_TOO_LARGE`, read again with `after` set to a recent ISO time/)
  })

  it('an answer over 256 KiB is refused as RELAY_ANSWER_TOO_LARGE with its status, after one fetch', async () => {
    const big = { ok: true, comments: [{ id: 'c-1', body: 'x'.repeat(256 * 1024), createdAt: '2026-11-13T07:00:00.000Z' }] }
    const m = await mount(() => Response.json(big))
    expect(await m.tool('crew_relay').execute({ op: 'read' })).toEqual({ ok: false, code: 'RELAY_ANSWER_TOO_LARGE', status: 200 })
    expect(m.fetched).toHaveLength(1)
  })
})
