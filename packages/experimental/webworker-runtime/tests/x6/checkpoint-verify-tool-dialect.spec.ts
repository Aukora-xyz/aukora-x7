/**
 * The dialect test for `x6_checkpoint_verify` — the gap that shipped.
 *
 * Card 1 landed with `parameters` written as a JSON Schema object. Every built-in in ball-loader.ts
 * passes a FLAT map of descriptors instead, and `defineTool` throws on the other shape; `registerBuiltin`
 * catches that throw and logs one console line, so the whole suite stayed green while the tool did not
 * exist in the live body. The `tools` probe of x6_self_check is what finally said so, on a reload.
 *
 * These cases fail against the merged file and pass against the flat one. They pin the SHAPE, which is
 * the thing that broke, not a behaviour that was never wrong.
 */
import { describe, expect, it } from 'vitest'
import { checkpointVerifyToolSpec } from '../../src/x6/checkpoint-verify-tool.ts'

const spec = checkpointVerifyToolSpec(() => ({
  get: async () => ({ status: 200, body: {} }),
  nowMs: () => 0,
}))

/** Reserved words of the other dialect. Any of these at the top level means defineTool will throw. */
const JSON_SCHEMA_KEYS = ['type', 'properties', 'required', 'additionalProperties']

/** The only descriptor types ball-loader.ts uses. */
const ALLOWED_TYPES = ['string', 'number', 'json']

describe('x6_checkpoint_verify speaks the loader dialect', () => {
  it('registers under the name self-check reports', () => {
    expect(spec.name).toBe('x6_checkpoint_verify')
  })

  it('carries no JSON-Schema top level keys in parameters', () => {
    for (const key of JSON_SCHEMA_KEYS) {
      expect(Object.hasOwn(spec.parameters, key), `parameters.${key} belongs to the other dialect`).toBe(false)
    }
  })

  it('gives every parameter a flat descriptor with an allowed type', () => {
    const entries = Object.entries(spec.parameters)
    expect(entries.length).toBeGreaterThan(0)
    for (const [name, descriptor] of entries) {
      expect(descriptor, `parameter ${name}`).toBeTypeOf('object')
      expect(ALLOWED_TYPES, `parameter ${name} type`).toContain(descriptor.type)
      expect(descriptor.description, `parameter ${name} description`).toBeTypeOf('string')
    }
  })

  it('marks a required parameter inside its own descriptor', () => {
    expect(spec.parameters.id?.required).toBe(true)
  })

  it('offers both actions the card promises', () => {
    const description = spec.parameters.action?.description ?? ''
    expect(description).toContain('capture')
    expect(description).toContain('verify')
  })

  it('hands back an execute function', () => {
    expect(spec.execute).toBeTypeOf('function')
  })
})

describe('capture judges nothing and returns the edge answers verbatim', () => {
  const row = {
    id: 'a'.repeat(64),
    path: '/p/abc/session/session.v4.jsonl',
    bytes: 40,
    lineEnd: 40,
    chain: 'c'.repeat(32),
    tailSha: 'd'.repeat(64),
  }
  const stub = checkpointVerifyToolSpec(() => ({
    get: async (path: string) => {
      if (path === '/_thread/index') return { status: 200, body: { ok: true, threads: [row] } }
      if (path.startsWith('/_thread/manifest')) return { status: 200, body: { ok: true, parts: ['e'.repeat(64)], page: 0 } }
      if (path.startsWith('/_thread/tail')) return { status: 200, body: { ok: true, tail: '' } }
      if (path === '/_head/status') return { status: 200, body: { ok: true, lease: { generation: 3 } } }
      return { status: 403, body: null }
    },
    nowMs: () => 0,
  }))

  it('returns scrubbed shapes and no journal row', async () => {
    const answer = (await stub.execute({ action: 'capture', id: 'abc' })) as Record<string, unknown>
    expect(answer.ok).toBe(true)
    expect(answer.judged).toBe(false)
    expect(answer.threadId).toBe(row.id)
    expect(answer).not.toHaveProperty('verdict')
    const captured = answer.row as Record<string, unknown>
    // Only the shape leaves this tool. Her `title` and `preview` are hers and never travel.
    expect(Object.keys(captured).sort()).toEqual(['bytes', 'chain', 'id', 'lineEnd', 'tailSha'])
    const routes = answer.routes as Array<Record<string, unknown>>
    expect(routes.length).toBe(2)
    expect(routes.every((route) => typeof route.path === 'string' && typeof route.status === 'number')).toBe(true)
  })

  it('reads the manifest at page 0 and returns its shape, not its parts', async () => {
    const answer = (await stub.execute({ action: 'capture', id: 'abc' })) as Record<string, unknown>
    const paths = (answer.routes as Array<Record<string, unknown>>).map((route) => String(route.path))
    expect(paths.some((path) => path.includes('/_thread/manifest') && path.includes('page=0'))).toBe(true)
    const manifest = answer.manifest as Record<string, unknown>
    expect(manifest).not.toHaveProperty('parts')
    expect(manifest.partCount).toBe(1)
    expect(manifest.firstPartPrefix).toBe('eeeeeeee')
  })

  it('records a refused manifest as a status, never as an absence', async () => {
    const refused = checkpointVerifyToolSpec(() => ({
      get: async (path: string) => (path === '/_thread/index'
        ? { status: 200, body: { ok: true, threads: [row] } }
        : { status: 403, body: null }),
      nowMs: () => 0,
    }))
    const answer = (await refused.execute({ action: 'capture', id: 'abc' })) as Record<string, unknown>
    expect(answer.ok).toBe(true)
    expect(answer.threadId).toBe(row.id)
    expect((answer.manifest as Record<string, unknown>).page).toBeNull()
    expect((answer.routes as Array<Record<string, unknown>>).some((route) => route.status === 403)).toBe(true)
  })
})
