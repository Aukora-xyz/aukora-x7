/**
 * A tool she mounted must be callable after a reload (measured by Auma in her browser 2026-11-14:
 * after the reload `x6_tools list` said `adder -> x6t_adder, runnable: true`, the call said `unknown tool "x6t_adder"`
 * and `x6_capability_index lookup x6t_adder` said NO_SUCH_SURFACE).
 *
 * Built on the most real boot the repo has for this: her runtime mounted into a REAL Cordis Context with DSH's REAL
 * ToolsService and system prompt (as voice-read-only.spec.ts and loader-hardening.spec.ts do), the real adder forged
 * through the pinned compiler cell, mounted under the owner's session, then the whole Context torn down (its fiber
 * disposed, as `worker-host.ts` `stop` does) and a NEW Context booted over the SAME stored home. The model-facing list is
 * read the way a turn reads it: `tools.resolve({ agent, signal })` for a new agent, then that step's view.
 * Not covered: IndexedDB (the home is the same MemoryVfs object, not a store read back), the worker/page split, the edge.
 */
import { Context } from '@deepseek-ai/cordis'
import { readFile } from 'node:fs/promises'
import { Worker } from 'node:worker_threads'
import { afterEach, describe, expect, it, vi } from 'vitest'
import SystemPrompt from '../../../../core/system-prompt/src/index.ts'
import ToolRuntime, * as dshTools from '../../../../core/tools/src/index.ts'
import { MemoryVfs } from '../../src/storage/memory.ts'
import * as wasmCells from '../../src/x6/wasm-cells.ts'
import { createCellHost, type CellHost, type CellWorker } from '../../src/x6/wasm-cells.ts'
import { mountedToolParameters, TOOL_MOUNTED_DIR, type ToolManifest } from '../../src/x6/tool-registry.ts'
import { FakeSocket, mountE4 } from './e4-fixture.ts'

type J = Record<string, unknown>
type Tool = { execute: (args: J, exec?: unknown) => Promise<unknown> }
const CELLS = new URL('../../../../../apps/web/public/cells/', import.meta.url)
const ADDER = new URL('../../../../../docs/auma/cells/adder.wat', import.meta.url)
const ORIGIN = 'https://lane-e4-fixture.invalid'

const served = (): typeof fetch => async (input: RequestInfo | URL) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
  if (url.origin !== ORIGIN || !url.pathname.startsWith('/cells/')) return new Response('no', { status: 404 })
  const name = url.pathname.replace(/^\/cells\//, '').replace(/\.wasm$/, '')
  return new Response(Uint8Array.from(await readFile(new URL(`${name}.wasm`, CELLS))), { headers: { 'content-type': 'application/wasm' } })
}
const hosts = new Set<CellHost>()
const workers = new Set<Worker>()
const contexts = new Set<Context>()
const nodeCellWorker = (source: string): CellWorker => {
  const worker = new Worker(`
    const { parentPort } = require('node:worker_threads');
    globalThis.postMessage = value => parentPort.postMessage(value);
    parentPort.on('message', data => globalThis.onmessage({ data }));
    ${source}
  `, { eval: true, execArgv: [] })
  workers.add(worker)
  return {
    listen(onMessage, onFailure) { worker.on('message', onMessage); worker.on('error', onFailure); worker.on('messageerror', onFailure) },
    postMessage: (message) => { worker.postMessage(message) },
    async terminate() { await worker.terminate(); worker.removeAllListeners(); workers.delete(worker) },
  }
}
afterEach(async () => {
  FakeSocket.instances.length = 0
  try {
    for (const context of contexts) await context.fiber.dispose()
    await Promise.all([...hosts].map(host => host.dispose()))
  } finally {
    contexts.clear()
    hosts.clear()
    await Promise.all([...workers].map(worker => worker.terminate()))
    workers.clear()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  }
})

/** One boot of her runtime into a fresh real Context over `vfs`; the edge's owner-only cell door answers per `owner`. */
async function boot(owner: { value: boolean }, vfs: MemoryVfs) {
  const context = new Context()
  contexts.add(context)
  await context.plugin(SystemPrompt, {})
  await context.plugin(ToolRuntime)
  const host = createCellHost({ origin: ORIGIN, fetchImpl: served(), createWorker: nodeCellWorker, now: () => 0 })
  hosts.add(host)
  vi.spyOn(wasmCells, 'workerCellHost').mockReturnValue(host)
  const m = await mountE4({ vfs, host: { context, dshTools }, respond: (call) => {
    if (call.method === 'GET' && call.path === '/api/build') return Response.json({ ok: true, schema: 'aukora.edge-build.v1', sourceRevision: null })
    if (call.method === 'POST' && call.path === '/_host/cell-run') {
      return owner.value ? Response.json({ ok: false, code: 'CELL_RUN_MEDIA_TYPE' }, { status: 415 })
        : Response.json({ ok: false, code: 'OWNER_ACCESS_REQUIRED' }, { status: 403 })
    }
    return null
  } })
  const tools = context.tools
  /** What a NEW turn of a thread is offered: the step's own resolution, as the agent loop does before a model call. */
  const turnTools = async (agentId: string): Promise<Map<string, Tool>> => {
    const agent = { id: agentId }
    const set = await tools.resolve({ agent, signal: new AbortController().signal } as never)
    try { return new Map([...set.view(agent as never)].map(([name, definition]) => [name, definition as unknown as Tool])) }
    finally { set.dispose() }
  }
  const index = async (name: string) => await (tools.get('x6_capability_index') as unknown as Tool).execute({ action: 'lookup', name }) as J
  const call = async (name: string, args: J) => {
    const definition = tools.executable(name) as unknown as Tool | undefined
    if (definition === undefined) return { unknownTool: name }
    return await definition.execute(args)
  }
  return { context, m, tools, turnTools, index, call }
}

async function forgeAndMount(b: Awaited<ReturnType<typeof boot>>, owner: { value: boolean },
  ids?: { proposalId?: unknown; qualificationId?: unknown }) {
  const forged = await b.call('x6_cell', { action: 'forge', wat: await readFile(ADDER, 'utf8'), name: 'adder' }) as J
  expect(forged).toMatchObject({ ok: true })
  const sha = String((forged.cell as J).sha256)
  const manifest = {
    schema: 'aukora.tool.v1', name: 'adder', version: '0.1.0', description: 'Adds two integers.',
    actions: { add: { description: 'a + b', readOnly: true, authority: 'A' } },
    requires: { services: [], secrets: [], network: false },
    handler: { cell: sha, op: 'run' },
    tests: [
      { name: 'two and three', input: { a: 2, b: 3 }, expect: { ok: true, result: { sum: 5 } } },
      { name: 'no b is refused', input: { a: 2 }, expect: { ok: false, code: 'INPUT' } },
    ],
  }
  const proposed = await b.call('x6_tools', { action: 'propose', manifest }) as J
  const qualified = await b.call('x6_tools', { action: 'qualify', proposalId: proposed.proposalId }) as J
  expect(qualified).toMatchObject({ qualified: true })
  owner.value = true
  if (ids !== undefined) { ids.proposalId = proposed.proposalId; ids.qualificationId = qualified.qualificationId }
  return await b.call('x6_tools', { action: 'mount', proposalId: proposed.proposalId, qualificationId: qualified.qualificationId }) as J
}

describe('a mounted tool after a reload, on the real ToolsService', () => {
  it('mount, tear the runtime down, boot again over the same home: x6t_adder is offered, indexed and callable', async () => {
    const owner = { value: false }
    const vfs = new MemoryVfs()
    const first = await boot(owner, vfs)
    const mounted = await forgeAndMount(first, owner)
    expect(mounted).toMatchObject({ ok: true, mounted: true, tool: 'x6t_adder' })
    // The first page tears down as a reload does: its whole tree is disposed.
    await first.context.fiber.dispose()
    contexts.delete(first.context)
    expect(first.tools.get('x6t_adder')).toBeUndefined()

    const second = await boot(owner, vfs)
    // The record survived and is vetted, as she saw.
    expect(await second.call('x6_tools', { action: 'list' })).toMatchObject({ count: 1, mounted: [{ name: 'adder', tool: 'x6t_adder', runnable: true }] })
    // (a) the next turn of a thread is offered it, (b) the index finds it, (c) a call returns the sum.
    expect((await second.turnTools('thread-after-reload')).has('x6t_adder')).toBe(true)
    expect(await second.index('x6t_adder')).toMatchObject({ ok: true })
    expect(await second.call('x6t_adder', { input: { a: 19, b: 23 } })).toMatchObject({ ok: true, result: { sum: 42 }, readOnly: true })
    // The self-check row that would have caught it is green.
    expect(await second.call('x6_self_check', { only: ['tools-callable'] })).toMatchObject({ ok: true,
      rows: [{ id: 'tools-callable', ok: true, detail: '1 of 1 runnable tools callable' }] })

    // (d) unmount takes it away for the next turn without a reload, and says so truthfully.
    expect(await second.call('x6_tools', { action: 'unmount', name: 'adder' })).toMatchObject({ ok: true, unmounted: true, availableAfter: 'now' })
    expect((await second.turnTools('thread-after-unmount')).has('x6t_adder')).toBe(false)
    expect(await second.index('x6t_adder')).toMatchObject({ ok: false })
    expect(await second.call('x6t_adder', { input: { a: 1, b: 1 } })).toEqual({ unknownTool: 'x6t_adder' })
    expect([...vfs.readdirSync(TOOL_MOUNTED_DIR)]).toEqual([])
  }, 180_000)

  it('mount answers availableAfter "now" only when a NEW turn of the same page is offered the tool and can call it', async () => {
    const owner = { value: false }
    const b = await boot(owner, new MemoryVfs())
    const mounted = await forgeAndMount(b, owner)
    expect(mounted).toMatchObject({ ok: true, mounted: true, tool: 'x6t_adder', availableAfter: 'now' })
    expect((await b.turnTools('thread-same-page')).has('x6t_adder')).toBe(true)
    expect(await b.index('x6t_adder')).toMatchObject({ ok: true })
    expect(await b.call('x6t_adder', { input: { a: 2, b: 40 } })).toMatchObject({ ok: true, result: { sum: 42 } })
  }, 180_000)

  it('a registration the tool registry refuses takes the record back and says TOOL_REGISTER_FAILED, never "reload"', async () => {
    const owner = { value: false }
    const vfs = new MemoryVfs()
    const b = await boot(owner, vfs)
    const proto = Object.getPrototypeOf(b.tools) as { register: (definition: { name: string }, options?: unknown) => () => void }
    const register = proto.register
    vi.spyOn(proto, 'register').mockImplementation(function (this: unknown, definition: { name: string }, options?: unknown) {
      if (definition.name.startsWith('x6t_')) throw new Error('refused by the registry\nsecond line')
      return register.call(this, definition, options)
    })
    expect(await forgeAndMount(b, owner)).toMatchObject({ ok: false, code: 'TOOL_REGISTER_FAILED', tool: 'x6t_adder',
      why: 'refused by the registry', recordRemoved: true })
    expect([...vfs.readdirSync(TOOL_MOUNTED_DIR)]).toEqual([])
    expect(await b.call('x6_tools', { action: 'list' })).toMatchObject({ count: 0, proposals: [{ name: 'adder' }] })
    expect(b.tools.get('x6t_adder')).toBeUndefined()
  }, 180_000)

  it('a mount answered "already" whose registration fails keeps the earlier record and says so, recordRemoved false', async () => {
    const owner = { value: false }
    const vfs = new MemoryVfs()
    const first = await boot(owner, vfs)
    const ids: { proposalId?: unknown; qualificationId?: unknown } = {}
    expect(await forgeAndMount(first, owner, ids)).toMatchObject({ ok: true, mounted: true, tool: 'x6t_adder' })
    const proto = Object.getPrototypeOf(first.tools) as { register: (definition: { name: string }, options?: unknown) => () => void }
    await first.context.fiber.dispose()
    contexts.delete(first.context)
    // The next boot's tool registry refuses every x6t_ tool: the record is there, the tool is not.
    const register = proto.register
    vi.spyOn(proto, 'register').mockImplementation(function (this: unknown, definition: { name: string }, options?: unknown) {
      if (definition.name.startsWith('x6t_')) throw new Error('refused by the registry\nsecond line')
      return register.call(this, definition, options)
    })
    const second = await boot(owner, vfs)
    expect(second.tools.get('x6t_adder')).toBeUndefined()
    expect(await second.call('x6_tools', { action: 'mount', proposalId: ids.proposalId, qualificationId: ids.qualificationId })).toEqual({
      ok: false, code: 'TOOL_REGISTER_FAILED', name: 'adder', tool: 'x6t_adder', why: 'refused by the registry',
      recordRemoved: false, next: 'the earlier record stays: unmount it, then mount again' })
    // Nothing was taken back: the earlier record is still mounted.
    expect([...vfs.readdirSync(TOOL_MOUNTED_DIR)]).toEqual(['adder.json'])
    expect(await second.call('x6_tools', { action: 'list' })).toMatchObject({ count: 1, mounted: [{ name: 'adder', tool: 'x6t_adder' }] })
  }, 180_000)
})

describe('the parameters of a mounted tool pass the real defineTool', () => {
  const manifest = (actions: string[], services: string[] = []): ToolManifest => ({
    schema: 'aukora.tool.v1', name: 'adder', version: '0.1.0', description: 'd',
    actions: Object.fromEntries(actions.map(name => [name, { readOnly: true, authority: 'A' }])),
    requires: { services, secrets: [], network: false, ...(services.length > 0 ? { reads: ['/dsh/home/auma/notes/*'] } : {}) },
    handler: { pin: 'calc', op: 'calc.add' }, tests: [],
  }) as unknown as ToolManifest
  it.each([[['add'], []], [['add', 'sub'], []], [['add'], ['home-read']]] as Array<[string[], string[]]>)('actions %j, services %j', (actions, services) => {
    const parameters = mountedToolParameters(manifest(actions, services))
    // The real defineTool throws on any schema the real registry would refuse (packages/core/tools/src/schema.ts).
    expect(() => dshTools.defineTool({ name: 'x6t_adder', description: 'd', parameters,
      output: { schema: { type: 'json' }, render: () => [] }, execute: async () => await Promise.resolve({}) } as never)).not.toThrow()
    // `act` is required exactly when there is more than one action to choose from.
    expect(Object.hasOwn(parameters.act ?? {}, 'required')).toBe(actions.length > 1)
    expect(Object.hasOwn(parameters, 'paths')).toBe(services.includes('home-read'))
  })
})
