/**
 * Red-Team Reproducers:
 * Exercises `x6_tools` T1 against the REAL Cordis `Context`, REAL `ToolsService`, and REAL `@deepseek-ai/dsh-tools`
 * `defineTool` (unlike `tool-registry.spec.ts`, which uses `mountE4()`'s pass-through stub `defineTool: v => v`).
 *
 * Root cause: `mountedToolParameters(manifest)` (`src/x6/tool-registry.ts:751`) sets `act.required = actions.length > 1`.
 * For any single-action tool (such as `adder`, `actions = ['add']`), `act.required` is `false`, which real `defineTool()`
 * (`packages/core/tools/src/schema.ts:293-295`) rejects with `JsonSchemaError: parameters.act.required must be true when present`
 * both at `mount` (`availableAfter: 'reload'`) and at reload/cold-boot (`unknown tool "x6t_adder"` + `NO_SUCH_SURFACE`).
 */
import { readFile } from 'node:fs/promises'
import { Worker } from 'node:worker_threads'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import SystemPrompt from '../../../../core/system-prompt/src/index.ts'
import ToolRuntime, * as dshTools from '../../../../core/tools/src/index.ts'
import { MemoryVfs } from '../../src/storage/memory.ts'
import * as wasmCells from '../../src/x6/wasm-cells.ts'
import { createCellHost, type CellHost, type CellWorker } from '../../src/x6/wasm-cells.ts'
import { FakeSocket, mountE4 } from './e4-fixture.ts'

type JsonRecord = Record<string, unknown>

const CELLS = new URL('../../../../../apps/web/public/cells/', import.meta.url)
const ADDER = new URL('../../../../../docs/auma/cells/adder.wat', import.meta.url)
const ORIGIN = 'https://lane-e4-fixture.invalid'

const contexts: Context[] = []
const hosts = new Set<CellHost>()
const workers = new Set<Worker>()

const served = (): typeof fetch => async (input: RequestInfo | URL) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
  if (url.origin !== ORIGIN || !url.pathname.startsWith('/cells/')) return new Response('no', { status: 404 })
  const name = url.pathname.replace(/^\/cells\//, '').replace(/\.wasm$/, '')
  return new Response(Uint8Array.from(await readFile(new URL(`${name}.wasm`, CELLS))), { headers: { 'content-type': 'application/wasm' } })
}

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
  for (const context of contexts.splice(0)) await context.fiber.dispose()
  FakeSocket.instances.length = 0
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  try { await Promise.all([...hosts].map(host => host.dispose())) }
  finally {
    hosts.clear()
    await Promise.all([...workers].map(worker => worker.terminate()))
    workers.clear()
  }
})

async function bootRealHost(vfs = new MemoryVfs()) {
  const context = new Context()
  contexts.push(context)
  await context.plugin(SystemPrompt, {})
  await context.plugin(ToolRuntime)
  const cellHost = createCellHost({ origin: ORIGIN, fetchImpl: served(), createWorker: nodeCellWorker, now: () => 0 })
  hosts.add(cellHost)
  vi.spyOn(wasmCells, 'workerCellHost').mockReturnValue(cellHost)
  const m = await mountE4({
    vfs,
    nodeBuiltins: true,
    host: { context, dshTools },
    respond: (call) => {
      if (call.method === 'GET' && call.path === '/api/build') return Response.json({ ok: true, schema: 'aukora.edge-build.v1', sourceRevision: null })
      if (call.method === 'POST' && call.path === '/_host/cell-run') return Response.json({ ok: false, code: 'CELL_RUN_MEDIA_TYPE' }, { status: 415 })
      return null
    },
  })
  return { m, vfs, context }
}

function adderManifest(cellSha: string): JsonRecord {
  return {
    schema: 'aukora.tool.v1',
    name: 'adder',
    version: '0.1.0',
    description: 'Adds two integers.',
    actions: { add: { description: 'a + b', readOnly: true, authority: 'A' } },
    requires: { services: [], secrets: [], network: false },
    handler: { cell: cellSha, op: 'run' },
    tests: [
      { name: 'two and three', input: { a: 2, b: 3 }, expect: { ok: true, result: { sum: 5 } } },
      { name: 'no b is refused', input: { a: 2 }, expect: { ok: false, code: 'INPUT' } },
    ],
  }
}

describe('Red-Team: x6_tools single-action mount & reload on the REAL ToolsService', () => {
  it('RT-453-REALHOST-1a: mounting single-action adder registers x6t_adder immediately on real defineTool (availableAfter: "now")', async () => {
    const { m, context } = await bootRealHost()
    const forged = await m.tool('x6_cell').execute({ action: 'forge', wat: await readFile(ADDER, 'utf8'), name: 'adder' }) as JsonRecord
    expect(forged).toMatchObject({ ok: true })
    const sha = String((forged.cell as JsonRecord).sha256)
    const tools = m.tool('x6_tools')
    const proposed = await tools.execute({ action: 'propose', manifest: adderManifest(sha) }) as JsonRecord
    const qualified = await tools.execute({ action: 'qualify', proposalId: proposed.proposalId }) as JsonRecord
    expect(qualified).toMatchObject({ qualified: true })
    const mounted = await tools.execute({ action: 'mount', proposalId: proposed.proposalId, qualificationId: qualified.qualificationId }) as JsonRecord
    expect(mounted).toMatchObject({ ok: true, mounted: true, tool: 'x6t_adder', availableAfter: 'now' })
    expect(context.tools.get('x6t_adder')).toBeDefined()
  }, 60_000)

  it('RT-453-REALHOST-1b: reloading over the same VFS admits single-action x6t_adder into ToolsService and x6_capability_index', async () => {
    const { m, vfs } = await bootRealHost()
    const forged = await m.tool('x6_cell').execute({ action: 'forge', wat: await readFile(ADDER, 'utf8'), name: 'adder' }) as JsonRecord
    const sha = String((forged.cell as JsonRecord).sha256)
    const tools = m.tool('x6_tools')
    const proposed = await tools.execute({ action: 'propose', manifest: adderManifest(sha) }) as JsonRecord
    const qualified = await tools.execute({ action: 'qualify', proposalId: proposed.proposalId }) as JsonRecord
    await tools.execute({ action: 'mount', proposalId: proposed.proposalId, qualificationId: qualified.qualificationId })

    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    const reloaded = await bootRealHost(vfs)
    const list = await reloaded.m.tool('x6_tools').execute({ action: 'list' }) as JsonRecord
    expect(list).toMatchObject({ ok: true, count: 1 })
    const lookup = await reloaded.m.tool('x6_capability_index').execute({ action: 'lookup', name: 'x6t_adder' }) as JsonRecord
    expect(lookup).toMatchObject({ ok: true })
    expect(reloaded.context.tools.get('x6t_adder')).toBeDefined()
    expect(await reloaded.m.tool('x6t_adder').execute({ input: { a: 19, b: 23 } })).toMatchObject({ ok: true, result: { sum: 42 } })
  }, 60_000)
})
