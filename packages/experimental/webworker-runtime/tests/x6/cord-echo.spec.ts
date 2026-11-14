/**
 * One ongoing Cord skill pauses in her browser, resumes on her edge, comes back, and gives the same next
 * outputs and the same state roots as an uninterrupted run, with evidence she can check herself (docs/auma/cord-echo.md).
 *
 * Her browser side is the real cell host (createCellHost on a Node worker, the pinned bytes served from
 * apps/web/public/cells) and the real `x6_cell cord` shelf (cord-run.ts) over a MemoryVfs; the edge side is the REAL Worker
 * route (deploy/cloudflare/src/worker.mjs, POST /_host/cell-run) running the same file, handed to it as a compiled module
 * by the mock below (wrangler's CompiledWasm shape). Local only: no network, no storage at the edge (its bindings are spies).
 */
import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { Worker } from 'node:worker_threads'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryVfs } from '../../src/storage/memory.ts'
import { classifyActionIrreversibility } from '../../src/x6/ball-loader.ts'
import { classifyToolMutation } from '../../src/x6/capability-index.ts'
import {
  CORD_CASE_SKILL, CORD_DIR, CORD_FIELD, CORD_KEEP, createCordShelf, cordChain, cordFifoOracle, cordGenesis, cordHead, cordRunOracle,
  cordStateSha256, cordTextSha256, type CordCheckpoint, type CordEvidence,
} from '../../src/x6/cord-run.ts'
import { voiceVerdict } from '../../src/x6/voice-read-only.ts'
import { CELL_BROWSER_FUEL_CAP, CELL_PINS, METERED_CELL_EXPORTS, admitCell, createCellHost, inspectWasmMemory, type CellHost, type CellWorker } from '../../src/x6/wasm-cells.ts'
import { RUNTIME_WRITE_SET } from '../../src/x6/write-set-inventory.ts'

vi.mock('../../../../../apps/web/public/cells/cord-echo.wasm', async () => {
  const { readFile: read } = await import('node:fs/promises')
  return { default: new WebAssembly.Module(await read(new URL('../../../../../apps/web/public/cells/cord-echo.wasm', import.meta.url))) }
})

type J = Record<string, unknown>
const REPO = new URL('../../../../../', import.meta.url)
const CELLS = new URL('apps/web/public/cells/', REPO)
const ORIGIN = 'https://cord-echo.example.invalid'
const PIN = CELL_PINS['cord-echo']!
const OWNER = { type: 'owner', email: 'owner@example.invalid', expires: Math.floor(Date.now() / 1000) + 3600 }
const P = CORD_FIELD
const sha = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex')
const text = (value: string | Uint8Array): string => typeof value === 'string' ? value : new TextDecoder().decode(value)

// ---------- her cell host on a Node worker ----------
const served = async (url: URL): Promise<Response> => {
  try { return new Response(new Uint8Array(await readFile(new URL(url.pathname.slice('/cells/'.length), CELLS)))) }
  catch { return new Response('no', { status: 404 }) }
}
const hosts = new Set<CellHost>()
const workers = new Set<Worker>()
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
const browserHost = (pins?: typeof CELL_PINS): CellHost => {
  const fetchImpl: typeof fetch = async input => served(new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url))
  const host = createCellHost({ origin: ORIGIN, fetchImpl, createWorker: nodeCellWorker, now: () => 0, ...(pins ? { pins } : {}) })
  hosts.add(host)
  return host
}
afterEach(async () => {
  vi.restoreAllMocks()
  try { await Promise.all([...hosts].map(host => host.dispose())) }
  finally {
    hosts.clear()
    await Promise.all([...workers].map(worker => worker.terminate()))
    workers.clear()
  }
})

// ---------- the real Worker route ----------
async function edge() {
  const { createWorker } = await import(new URL('deploy/cloudflare/src/worker.mjs', REPO).href) as {
    createWorker: (options: { verifyAccess: () => Promise<unknown> }) => { fetch: (request: Request, env: unknown) => Promise<Response> } }
  const touched: string[] = []
  const spy = (name: string): unknown => new Proxy({}, { get(_target, property) { touched.push(`${name}.${String(property)}`); return () => { throw new Error(`${name} called`) } } })
  const env = { PUBLIC_HOST: new URL(ORIGIN).host, OWNER_EMAIL: OWNER.email, OWNER_PUBLIC_KEY_HEX: 'e'.repeat(64),
    HEAD: spy('HEAD'), MIRROR: spy('MIRROR'), VOICE_BRIDGE: spy('VOICE_BRIDGE'), ARCHIVE_BUCKET: spy('ARCHIVE_BUCKET'), ASSETS: spy('ASSETS') }
  const worker = createWorker({ verifyAccess: async () => OWNER })
  const sent: J[] = []
  const bodies: number[] = []
  /** Her page's same-origin POST, as the browser sends it. */
  const post = async (body: Uint8Array | string): Promise<Response> => {
    const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body
    bodies.push(bytes.byteLength)
    sent.push(JSON.parse(new TextDecoder().decode(bytes)) as J)
    return await worker.fetch(new Request(`${ORIGIN}/_host/cell-run`, { method: 'POST', body: Uint8Array.from(bytes),
      headers: { 'content-type': 'application/json', origin: ORIGIN, 'sec-fetch-site': 'same-origin' } }), env)
  }
  return { post, sent, bodies, touched }
}
type Edge = Awaited<ReturnType<typeof edge>>
/** Rewrites one edge request or answer (a fake or tampering edge in front of the real one). */
type EdgeTamper = { request?: (body: J) => J; answer?: (body: J) => Promise<J> | J; never?: true }

/** Her shelf over one VFS, her cell host and the edge, every same-origin request routed as her page would see it. */
function shelfOf(cells: CellHost, e: Edge, vfs = new MemoryVfs(), tamper: EdgeTamper = {}, edgeTimeoutMs?: number) {
  const fetchImpl: typeof fetch = async (input, init) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    if (url.pathname.startsWith('/cells/')) return await served(url)
    if (url.pathname !== '/_host/cell-run') return new Response('no', { status: 404 })
    if (tamper.never) return await new Promise<Response>(() => undefined)
    let body = JSON.parse(await request.text()) as J
    if (tamper.request) body = tamper.request(body)
    const response = await e.post(JSON.stringify(body))
    if (!tamper.answer) return response
    return Response.json(await tamper.answer(await response.json() as J), { status: response.status })
  }
  const deadline = edgeTimeoutMs ? { edgeTimeoutMs } : {}
  return { vfs, shelf: createCordShelf({ vfs, cells: () => cells, origin: ORIGIN, fetchImpl, now: () => 0, ...deadline }) }
}

/** Every file under her cord shelf with the SHA-256 of its bytes. */
function storeDigest(vfs: MemoryVfs): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (dir: string): void => {
    if (!vfs.existsSync(dir)) return
    for (const name of [...vfs.readdirSync(dir)].map(String).sort()) {
      const path = `${dir}/${name}`
      if (vfs.statSync(path).isDirectory()) walk(path)
      else { const value = vfs.readFileSync(path); out[path] = sha(typeof value === 'string' ? value : Uint8Array.from(value)) }
    }
  }
  walk(CORD_DIR)
  return out
}

/** Seeded inputs (a 31-bit LCG), each 0..P-1. */
function seeded(seed: number, length: number): number[] {
  let state = seed >>> 0
  return Array.from({ length }, () => { state = (Math.imul(state, 1103515245) + 12345) >>> 0; return (state >>> 8) % P })
}
const INPUTS = seeded(20261114, 3300)

let skillIdCache: string | null = null
async function skillId(): Promise<string> {
  skillIdCache ??= ((JSON.parse(await readFile(new URL('kyber/skills/index.json', CELLS), 'utf8')) as { skills: Array<{ name: string; id: string }> })
    .skills.find(row => row.name === 'cord-echo')!).id
  return skillIdCache
}
const profileSha = async (): Promise<string> => sha(new Uint8Array(await readFile(new URL('cord/fifo24.profile.json', CELLS))))

/** The uninterrupted reference over INPUTS, tick by tick, from the TypeScript oracle: roots and state digest after each tick. */
async function referenceTrace(skill: string) {
  const genesis = await cordGenesis(PIN.sha256, skill, await profileSha())
  const { outputs } = cordFifoOracle(genesis.state, INPUTS)
  const inputRoot = [genesis.inputRoot], outputRoot = [genesis.outputRoot], stateSha = [genesis.stateSha256]
  let window = [...genesis.state]
  for (let t = 1; t <= INPUTS.length; t += 1) {
    inputRoot.push(await cordChain(inputRoot[t - 1]!, t - 1, [INPUTS[t - 1]!]))
    outputRoot.push(await cordChain(outputRoot[t - 1]!, t - 1, [outputs[t - 1]!]))
    window = [INPUTS[t - 1]!, ...window.slice(0, 23)]
    stateSha.push(await cordStateSha256(window))
  }
  return { genesis, outputs, inputRoot, outputRoot, stateSha }
}

/** Feed `inputs` in legs of at most 1,000 at one place. */
async function feedAll(shelf: ReturnType<typeof createCordShelf>, inputs: readonly number[], at: 'here' | 'edge'): Promise<J[]> {
  const answers: J[] = []
  for (let from = 0; from < inputs.length; from += 1000) {
    const answer = await shelf.execute({ action: 'cord', step: 'feed', inputs: inputs.slice(from, from + 1000), at })
    expect(answer, `feed ${at} at ${String(from)}`).toMatchObject({ ok: true, at })
    answers.push(answer)
  }
  return answers
}

describe('the cell: admission facts and the pin', () => {
  it('zero imports, the metered exports, a fixed 4-page memory, integer only, and a rebuild through skillsmith is byte-identical', async () => {
    const bytes = new Uint8Array(await readFile(new URL('cord-echo.wasm', CELLS)))
    expect([bytes.byteLength, sha(bytes)]).toEqual([PIN.bytes, PIN.sha256])
    expect(PIN.ops).toEqual(['cord.genesis', 'cord.run', 'cord.info'])
    const module = await admitCell('cord-echo', PIN, bytes)
    expect(WebAssembly.Module.imports(module)).toEqual([])
    expect(WebAssembly.Module.exports(module).map(entry => entry.name).sort()).toEqual([...METERED_CELL_EXPORTS])
    expect(inspectWasmMemory('cord-echo', bytes, 4096)).toMatchObject({ initial: 4, maximum: 4 })
    const wat = await readFile(new URL('cord-echo.wat', CELLS), 'utf8')
    expect(wat).not.toMatch(/\bf(?:32|64)\b/u)
    expect(wat).not.toMatch(/\(import\b/u)
    expect(wat).toMatch(/\(memory \(export "memory"\) 4 4\)/u)
    const { buildCordEchoCell } = await import(new URL('server/cord-echo-cell.build.mjs', REPO).href) as { buildCordEchoCell: () => {
      metered: Uint8Array
      profileSha256: string
      watCurrent: boolean
    } }
    const rebuilt = buildCordEchoCell()
    expect(rebuilt.watCurrent).toBe(true)
    expect(sha(rebuilt.metered)).toBe(PIN.sha256)
    expect(rebuilt.profileSha256).toBe(await profileSha())
    expect(PIN.fuel).toBeLessThanOrEqual(CELL_BROWSER_FUEL_CAP)
  }, 120_000)

  it('her x6_cell description counts her body: every pinned cell, and every hand-written WAT cell by name', async () => {
    const loader = await readFile(new URL('packages/experimental/webworker-runtime/src/x6/ball-loader.ts', REPO), 'utf8')
    const description = /name: 'x6_cell',\s+description:([\s\S]*?)\n      parameters:/u.exec(loader)?.[1] ?? ''
    const wat = (await readdir(CELLS)).filter(name => name.endsWith('.wat')).map(name => name.slice(0, -'.wat'.length)).sort()
    const words = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine']
    expect(wat).toEqual(['aura-focus', 'cord-echo', 'kyber-cpu', 'menger-hive', 'nucleus', 'pentora-codec'])
    for (const name of wat) expect(Object.hasOwn(CELL_PINS, name), name).toBe(true)
    expect(description).toContain(`${String(Object.keys(CELL_PINS).length)} pinned cells`)
    expect(description).toContain(`and ${words[wat.length]!} hand-written integer WAT`)
    for (const name of wat) expect(description).toContain(`\`${name}\``)
  })

  it('cord.info, cord.genesis and the worst call: the measured fuel is at most half the pin, the edge body under 8 KiB', async () => {
    const cells = browserHost()
    expect(await cells.invoke('cord-echo', 'cord.info', {})).toMatchObject({ ok: true,
      result: { field: P, maxInputs: 1000, profile: 'fifo24', profileSha256: await profileSha(), stateWords: 24 } })
    const skill = await skillId()
    const genesis = await cells.invoke('cord-echo', 'cord.genesis', { cell: PIN.sha256, profile: 'fifo24', skill })
    expect(genesis.ok && genesis.result).toEqual({ checkpoint: await cordGenesis(PIN.sha256, skill, await profileSha()) })
    expect((await cordGenesis(PIN.sha256, skill, await profileSha())).parent).toBe('0'.repeat(64))
    expect(await cordTextSha256('aukora.cord.case-skill.v1')).toBe(CORD_CASE_SKILL)
    // The worst call: a full window of the largest word, a tick near the limit, 1,000 of the largest inputs.
    const fields = { cell: PIN.sha256, skill, profileSha256: await profileSha(), parent: 'f'.repeat(64), tick: 2_147_483_647 - 1000,
      stateSha256: await cordStateSha256(new Array(24).fill(P - 1)), inputRoot: 'a'.repeat(64), outputRoot: 'b'.repeat(64) }
    const worst: CordCheckpoint = { ...fields, head: await cordHead(fields), profile: 'fifo24', schema: 'aukora.cord.checkpoint.v1', state: new Array(24).fill(P - 1) }
    const input = { checkpoint: worst, expect: { head: worst.head, tick: worst.tick }, inputs: new Array(1000).fill(P - 1), profile: 'fifo24' }
    const answer = await cells.invoke('cord-echo', 'cord.run', input)
    expect(answer).toMatchObject({ ok: true })
    expect(answer.ok && answer.result).toEqual(await cordRunOracle(worst, input.inputs))
    console.log(`cord-echo worst call fuel ${String(answer.fuelUsed)} (pin ${String(PIN.fuel)})`)
    expect(answer.fuelUsed).toBeGreaterThan(0)
    expect((answer.fuelUsed ?? Infinity) * 2).toBeLessThanOrEqual(PIN.fuel)
    const body = new TextEncoder().encode(JSON.stringify({ cell: 'cord-echo', input, op: 'cord.run' }))
    console.log(`cord-echo largest edge body ${String(body.byteLength)} bytes`)
    expect(body.byteLength).toBeLessThanOrEqual(8192)
    // One more input is the cell's CORD_LIMIT, and so is a tick that would pass 2^31-1.
    expect(await cells.invoke('cord-echo', 'cord.run', { ...input, inputs: new Array(1001).fill(0) })).toMatchObject({ ok: false, code: 'CORD_LIMIT' })
    const late = { ...fields, tick: 2_147_483_647 - 5 }
    const lateCheckpoint = { ...worst, ...late, head: await cordHead(late) }
    expect(await cells.invoke('cord-echo', 'cord.run', { ...input, checkpoint: lateCheckpoint, expect: { head: lateCheckpoint.head, tick: lateCheckpoint.tick },
      inputs: new Array(6).fill(0) })).toMatchObject({ ok: false, code: 'CORD_LIMIT' })
  }, 60_000)
})

describe('continuation: here, then the edge, then here, equals the uninterrupted run', () => {
  it('four fixed schedules and sixteen seeded ones: next 100 outputs, roots and state digests at every cut, heads by commit history, no prefix replay', async () => {
    const cells = browserHost()
    const e = await edge()
    const skill = await skillId()
    const ref = await referenceTrace(skill)
    // The cell's own uninterrupted run, in legs of 1,000, agrees with the oracle's trace at every leg end.
    let checkpoint = ref.genesis
    for (let from = 0; from < 3200; from += 1000) {
      const inputs = INPUTS.slice(from, Math.min(from + 1000, 3200))
      const answer = await cells.invoke('cord-echo', 'cord.run', { checkpoint, expect: { head: checkpoint.head, tick: checkpoint.tick }, inputs, profile: 'fifo24' })
      if (!answer.ok) throw new Error(answer.code)
      const result = answer.result as { checkpoint: CordCheckpoint; outputs: number[] }
      checkpoint = result.checkpoint
      expect(result.outputs).toEqual(ref.outputs.slice(from, from + inputs.length))
      expect([checkpoint.inputRoot, checkpoint.outputRoot, checkpoint.stateSha256])
        .toEqual([ref.inputRoot[checkpoint.tick], ref.outputRoot[checkpoint.tick], ref.stateSha[checkpoint.tick]])
    }
    expect(checkpoint.tick).toBe(3200)

    const random = seeded(7, 32)
    const schedules: Array<[number, number]> = [[1013, 2013], [7, 1007], [24, 1023], [500, 1499]]
    for (let index = 0; index < 16; index += 1) {
      const a = 1 + (random[2 * index]! % 2000)
      schedules.push([a, a + 100 + (random[2 * index + 1]! % 901)])
    }
    let compared = 0
    for (const [index, [cut, back]] of schedules.entries()) {
      const { shelf, vfs } = shelfOf(cells, e)
      expect(await shelf.execute({ action: 'cord', step: 'start' })).toMatchObject({ ok: true, head: ref.genesis.head, tick: 0 })
      const sentBefore = e.sent.length
      const here = await feedAll(shelf, INPUTS.slice(0, cut), 'here')
      const away = await shelf.execute({ action: 'cord', step: 'feed', inputs: INPUTS.slice(cut, back), at: 'edge' }) as J & { outputs: number[]; evidence: CordEvidence }
      expect(away).toMatchObject({ ok: true, at: 'edge', tick: back })
      const home = await shelf.execute({ action: 'cord', step: 'feed', inputs: INPUTS.slice(back, back + 100), at: 'here' }) as J & { outputs: number[]; evidence: CordEvidence }
      expect(home).toMatchObject({ ok: true, at: 'here', tick: back + 100 })
      // The next 100 outputs after each cut are the uninterrupted run's at those ticks.
      expect(away.outputs.slice(0, 100)).toEqual(ref.outputs.slice(cut, cut + 100))
      expect(home.outputs).toEqual(ref.outputs.slice(back, back + 100))
      // Roots and the state digest at each cut and each commit are the uninterrupted run's at the same tick.
      for (const answer of [...here, away, home] as Array<J & { evidence: CordEvidence; tick: number }>) {
        const evidence = answer.evidence
        const tick = answer.tick
        expect([evidence.inputRoot, evidence.outputRoot, evidence.stateSha256])
          .toEqual([ref.inputRoot[tick], ref.outputRoot[tick], ref.stateSha[tick]])
        expect(evidence.claims.filter(claim => claim.status === 'FAILED')).toEqual([])
        compared += 1
      }
      // No prefix replay: the edge got exactly its segment and a 24-word state.
      const legs = e.sent.slice(sentBefore)
      expect(legs).toHaveLength(1)
      const leg = legs[0]!.input as { inputs: number[]; checkpoint: CordCheckpoint }
      expect([leg.inputs.length, leg.checkpoint.state.length, leg.checkpoint.tick]).toEqual([back - cut, 24, cut])
      // Heads depend on commit history by design: the same boundaries computed by her own oracle give the same heads.
      let expected = ref.genesis
      const boundaries = [...here.map(answer => answer.tick as number), back, back + 100]
      let previous = 0
      for (const tick of boundaries) {
        expected = (await cordRunOracle(expected, INPUTS.slice(previous, tick))).checkpoint
        previous = tick
      }
      expect(home.head).toBe(expected.head)
      if (index < 4) {
        // The fixed schedules again, all in her browser with the same commit boundaries: the same heads.
        const all = shelfOf(cells, e)
        await all.shelf.execute({ action: 'cord', step: 'start' })
        await feedAll(all.shelf, INPUTS.slice(0, cut), 'here')
        await all.shelf.execute({ action: 'cord', step: 'feed', inputs: INPUTS.slice(cut, back), at: 'here' })
        expect(await all.shelf.execute({ action: 'cord', step: 'feed', inputs: INPUTS.slice(back, back + 100), at: 'here' })).toMatchObject({ ok: true, head: home.head })
        expect(e.sent.length).toBe(sentBefore + 1)
      }
      expect(Object.keys(storeDigest(vfs)).length).toBeLessThanOrEqual(CORD_KEEP + 1)
    }
    expect(schedules).toHaveLength(20)
    expect(compared).toBeGreaterThanOrEqual(60)
    expect(e.bodies.every(size => size <= 8192)).toBe(true)
    expect(e.touched).toEqual([])
    // The edge's fuel grows with the segment, not with the tick: 100 inputs at tick 7 and at tick 3,100 cost about the same.
    const at = async (tick: number, length: number): Promise<number> => {
      let point = ref.genesis
      if (tick > 0) point = (await cordRunOracle(ref.genesis, INPUTS.slice(0, Math.min(tick, 1000)))).checkpoint
      for (let from = 1000; from < tick; from += 1000) {
        point = (await cordRunOracle(point, INPUTS.slice(from, Math.min(from + 1000, tick)))).checkpoint
      }
      const response = await e.post(JSON.stringify({ cell: 'cord-echo', input: { checkpoint: point, expect: { head: point.head, tick: point.tick },
        inputs: INPUTS.slice(tick, tick + length), profile: 'fifo24' }, op: 'cord.run' }))
      const body = await response.json() as J
      expect(body).toMatchObject({ ok: true, pin: PIN.sha256 })
      return body.fuelUsed as number
    }
    const early = await at(7, 100), late = await at(3100, 100), long = await at(7, 1000)
    expect(Math.abs(late - early) / early).toBeLessThan(0.05)
    expect(long / early).toBeGreaterThan(8)
  }, 600_000)
})

describe('her commit decides: stale, wrong profile, corrupted, timeout and fuel write nothing', () => {
  async function started(tamper: EdgeTamper = {}, timeout?: number) {
    const cells = browserHost()
    const e = await edge()
    const { shelf, vfs } = shelfOf(cells, e, new MemoryVfs(), tamper, timeout)
    await shelf.execute({ action: 'cord', step: 'start' })
    return { cells, e, shelf, vfs }
  }
  const currentOf = async (vfs: MemoryVfs): Promise<CordCheckpoint> => {
    const skill = await skillId()
    const head = (JSON.parse(text(vfs.readFileSync(`${CORD_DIR}/${skill}/head.json`))) as { head: string }).head
    return JSON.parse(text(vfs.readFileSync(`${CORD_DIR}/${skill}/checkpoints/${head}.json`))) as CordCheckpoint
  }
  const runInput = (checkpoint: CordCheckpoint, inputs: number[], expectHead = checkpoint.head, expectTick = checkpoint.tick, profile = 'fifo24') =>
    ({ checkpoint, expect: { head: expectHead, tick: expectTick }, inputs, profile })
  const both = async (cells: CellHost, e: Edge, input: J): Promise<[string, string]> => {
    const here = await cells.invoke('cord-echo', 'cord.run', input)
    const response = await e.post(JSON.stringify({ cell: 'cord-echo', input, op: 'cord.run' }))
    const there = await response.json() as J
    expect(Object.hasOwn(there, 'result')).toBe(false)
    return [here.ok ? 'ok' : here.code, `${String(response.status)} ${String(there.code)}`]
  }

  it('stale: an authentic earlier checkpoint is refused by the edge against her head, and by her commit when expect is forged', async () => {
    let stale: CordCheckpoint | null = null
    const swap = { current: 'checkpoint' as 'checkpoint' | 'both' }
    const s = await started({ request: (body) => {
      const input = body.input as J
      return { ...body, input: { ...input, checkpoint: stale, ...(swap.current === 'both' ? { expect: { head: stale!.head, tick: stale!.tick } } : {}) } }
    } })
    stale = await currentOf(s.vfs)
    await s.shelf.execute({ action: 'cord', step: 'feed', inputs: INPUTS.slice(0, 50), at: 'here' })
    await s.shelf.execute({ action: 'cord', step: 'feed', inputs: INPUTS.slice(50, 90), at: 'here' })
    const current = await currentOf(s.vfs)
    // Directly: expect = her current head, the stale checkpoint: CORD_HEAD_STALE at the edge (and here).
    expect(await both(s.cells, s.e, runInput(stale, [1, 2, 3], current.head, current.tick))).toEqual(['CORD_HEAD_STALE', '422 CORD_HEAD_STALE'])
    const before = storeDigest(s.vfs)
    const refused = await s.shelf.execute({ action: 'cord', step: 'feed', inputs: [1, 2, 3], at: 'edge' }) as J & { evidence: CordEvidence }
    expect(refused).toMatchObject({ ok: false, code: 'CORD_HEAD_STALE', at: 'edge' })
    expect(refused.evidence.head).toBeNull()
    expect(storeDigest(s.vfs)).toEqual(before)
    // expect forged to the stale head: the edge computes; her commit refuses because the parent is not her head.
    swap.current = 'both'
    const forged = await s.shelf.execute({ action: 'cord', step: 'feed', inputs: [1, 2, 3], at: 'edge' }) as J & { evidence: CordEvidence }
    expect(forged).toMatchObject({ ok: false, code: 'CORD_PARENT_STALE', at: 'edge' })
    expect(forged.evidence.claims.find(claim => claim.claim === 'parent-is-my-head')).toMatchObject({ status: 'FAILED' })
    expect(storeDigest(s.vfs)).toEqual(before)
    expect(s.e.touched).toEqual([])
  }, 60_000)

  it('wrong profile with valid digests: unknown on both hosts, an altered digest is a mismatch, a fake edge answer naming another profile is refused', async () => {
    const s = await started({ answer: async (body) => {
      const result = body.result as { checkpoint: CordCheckpoint; outputs: number[] }
      const other = { ...result.checkpoint, profile: 'wave30' }
      return { ...body, result: { ...result, checkpoint: { ...other, head: await cordHead(other) } } }
    } })
    const current = await currentOf(s.vfs)
    expect(await both(s.cells, s.e, runInput(current, [5], current.head, current.tick, 'wave30'))).toEqual(['CORD_PROFILE_UNKNOWN', '422 CORD_PROFILE_UNKNOWN'])
    const named = { ...current, profile: 'wave30' }
    expect(await both(s.cells, s.e, runInput(named, [5], current.head, current.tick, 'wave30'))).toEqual(['CORD_PROFILE_UNKNOWN', '422 CORD_PROFILE_UNKNOWN'])
    const altered = { ...current, profileSha256: 'c'.repeat(64) }
    const rehashed = { ...altered, head: await cordHead(altered) }
    expect(await both(s.cells, s.e, runInput(rehashed, [5]))).toEqual(['CORD_PROFILE_MISMATCH', '422 CORD_PROFILE_MISMATCH'])
    const before = storeDigest(s.vfs)
    expect(await s.shelf.execute({ action: 'cord', step: 'feed', inputs: [5, 6], at: 'edge' })).toMatchObject({ ok: false, code: 'CORD_PROFILE_MISMATCH' })
    expect(storeDigest(s.vfs)).toEqual(before)
  }, 60_000)

  it('corrupted: state and head bytes are refused by the cell on both hosts; a fake edge answer with one word or one output changed is refused by name', async () => {
    let mode: 'state' | 'output' = 'state'
    const s = await started({ answer: async (body) => {
      const result = body.result as { checkpoint: CordCheckpoint; outputs: number[] }
      if (mode === 'output') return { ...body, result: { ...result, outputs: [(result.outputs[0]! + 1) % P, ...result.outputs.slice(1)] } }
      const state = [...result.checkpoint.state]
      state[3] = (state[3]! + 1) % P
      const changed = { ...result.checkpoint, state, stateSha256: await cordStateSha256(state) }
      return { ...body, result: { ...result, checkpoint: { ...changed, head: await cordHead(changed) } } }
    } })
    await s.shelf.execute({ action: 'cord', step: 'feed', inputs: INPUTS.slice(0, 30), at: 'here' })
    const current = await currentOf(s.vfs)
    const word = [...current.state]; word[0] = (word[0]! + 1) % P
    expect(await both(s.cells, s.e, runInput({ ...current, state: word }, [1]))).toEqual(['CORD_STATE_DIGEST', '422 CORD_STATE_DIGEST'])
    const range = [...current.state]; range[5] = P
    expect(await both(s.cells, s.e, runInput({ ...current, state: range }, [1]))).toEqual(['CORD_STATE_RANGE', '422 CORD_STATE_RANGE'])
    const head = (current.head[0] === '0' ? '1' : '0') + current.head.slice(1)
    expect(await both(s.cells, s.e, runInput({ ...current, head }, [1], head))).toEqual(['CORD_HEAD_DIGEST', '422 CORD_HEAD_DIGEST'])
    const before = storeDigest(s.vfs)
    const state = await s.shelf.execute({ action: 'cord', step: 'feed', inputs: [9, 8, 7], at: 'edge' }) as J & { evidence: CordEvidence }
    expect(state).toMatchObject({ ok: false, code: 'CORD_STATE_MISMATCH' })
    expect(state.evidence.claims.find(claim => claim.claim === 'state-is-my-last-24-inputs')).toMatchObject({ status: 'FAILED' })
    mode = 'output'
    const output = await s.shelf.execute({ action: 'cord', step: 'feed', inputs: [9, 8, 7], at: 'edge' }) as J & { evidence: CordEvidence }
    expect(output).toMatchObject({ ok: false, code: 'CORD_OUTPUTS_MISMATCH' })
    expect(output.evidence.claims.find(claim => claim.claim === 'outputs-match-my-oracle')).toMatchObject({ status: 'FAILED' })
    expect(storeDigest(s.vfs)).toEqual(before)
  }, 60_000)

  it('timeout and fuel: an edge that never answers is EDGE_UNREACHABLE at the deadline; a starved browser host is FUEL; nothing is written', async () => {
    const s = await started({ never: true }, 50)
    const before = storeDigest(s.vfs)
    const journal = (await s.cells.journal()).totals.calls
    expect(await s.shelf.execute({ action: 'cord', step: 'feed', inputs: [1, 2], at: 'edge' })).toMatchObject({ ok: false, code: 'EDGE_UNREACHABLE', at: 'edge' })
    expect(storeDigest(s.vfs)).toEqual(before)
    const lines = await s.cells.journal()
    expect(lines.totals.calls).toBe(journal + 1)
    expect(lines.lines[0]).toMatchObject({ caller: 'edge', cell: 'cord-echo', op: 'cord.run', pin: 'unanswered' })
    const starved = browserHost({ ...CELL_PINS, 'cord-echo': { ...PIN, fuel: 100_000 } })
    const e = await edge()
    const { shelf } = shelfOf(starved, e, s.vfs)
    const answer = await shelf.execute({ action: 'cord', step: 'feed', inputs: INPUTS.slice(0, 500), at: 'here' }) as J & { evidence: CordEvidence }
    expect(answer).toMatchObject({ ok: false, code: 'FUEL', at: 'here' })
    expect(answer.evidence.head).toBeNull()
    expect(storeDigest(s.vfs)).toEqual(before)
  }, 60_000)
})

describe('the shelf she holds', () => {
  it('a reload keeps the head; retention keeps 8 and never the head or its parent; a hand-edited head.json runs nothing; a race commits once', async () => {
    const cells = browserHost()
    const e = await edge()
    const first = shelfOf(cells, e)
    expect(await first.shelf.execute({ action: 'cord', step: 'status' })).toMatchObject({ ok: true, started: false, head: null })
    const startedAnswer = await first.shelf.execute({ action: 'cord', step: 'start' }) as J
    expect(await first.shelf.execute({ action: 'cord', step: 'start' })).toMatchObject({ ok: false, code: 'CORD_ALREADY_STARTED', head: startedAnswer.head })
    let last: J = startedAnswer
    for (let leg = 0; leg < 12; leg += 1) {
      last = await first.shelf.execute({ action: 'cord', step: 'feed', inputs: INPUTS.slice(leg * 10, leg * 10 + 10), at: leg % 3 === 1 ? 'edge' : 'here' })
      expect(last).toMatchObject({ ok: true, tick: (leg + 1) * 10 })
    }
    const skill = await skillId()
    const kept = Object.keys(storeDigest(first.vfs)).filter(path => path.includes('/checkpoints/')).map(path => path.slice(-69, -5))
    expect(kept).toHaveLength(CORD_KEEP)
    expect(kept).toContain(last.head)
    expect(kept).toContain(last.parent)
    // A reload: a new shelf over the same home reads the same head and continues from it.
    const reload = shelfOf(cells, e, first.vfs)
    expect(await reload.shelf.execute({ action: 'cord', step: 'status' })).toMatchObject({ ok: true, started: true, head: last.head, tick: 120,
      generation: 13, kept: CORD_KEEP, retention: { keep: 8 } })
    expect(await reload.shelf.execute({ action: 'cord', step: 'feed', inputs: [1], at: 'here' })).toMatchObject({ ok: true, parent: last.head, tick: 121 })
    // A race: two feeds read the same head; exactly one commits, the other is CORD_HEAD_MOVED and writes nothing more.
    const raced = await Promise.all([
      reload.shelf.execute({ action: 'cord', step: 'feed', inputs: INPUTS.slice(0, 1000), at: 'here' }),
      reload.shelf.execute({ action: 'cord', step: 'feed', inputs: INPUTS.slice(1000, 2000), at: 'here' }),
    ])
    expect(raced.map(answer => answer.ok).sort()).toEqual([false, true])
    expect(raced.find(answer => answer.ok !== true)).toMatchObject({ code: 'CORD_HEAD_MOVED' })
    expect(await reload.shelf.execute({ action: 'cord', step: 'status' })).toMatchObject({ tick: 1121, generation: 15 })
    // A hand-edited head.json: CORD_STORE_INVALID and nothing runs.
    const headPath = `${CORD_DIR}/${skill}/head.json`
    const edited = text(first.vfs.readFileSync(headPath))
    first.vfs.writeFileSync(headPath, edited.replace(/"tick":\d+/u, '"tick":5'))
    const calls = (await cells.journal()).totals.calls
    const before = storeDigest(first.vfs)
    expect(await reload.shelf.execute({ action: 'cord', step: 'feed', inputs: [1], at: 'edge' })).toMatchObject({ ok: false, code: 'CORD_STORE_INVALID' })
    expect(await reload.shelf.execute({ action: 'cord', step: 'feed', inputs: [1], at: 'here' })).toMatchObject({ ok: false, code: 'CORD_STORE_INVALID' })
    expect((await cells.journal()).totals.calls).toBe(calls)
    expect(storeDigest(first.vfs)).toEqual(before)
    first.vfs.writeFileSync(headPath, 'not json')
    expect(await reload.shelf.execute({ action: 'cord', step: 'status' })).toMatchObject({ ok: false, code: 'CORD_STORE_INVALID' })
    expect(e.touched).toEqual([])
  }, 120_000)

  it('one feed answer at the edge with its evidence; the write set, her classification, voice and the capability index say what it is', async () => {
    const cells = browserHost()
    const e = await edge()
    const { shelf, vfs } = shelfOf(cells, e)
    await shelf.execute({ action: 'cord', step: 'start' })
    const answer = await shelf.execute({ action: 'cord', step: 'feed', inputs: [3, 1, 4, 1, 5], at: 'edge' }) as J & { evidence: CordEvidence }
    console.log(`cord-echo feed at the edge: ${JSON.stringify(answer)}`)
    expect(answer).toMatchObject({ ok: true, at: 'edge', tick: 5, outputs: [0, 0, 0, 0, 0] })
    expect(answer.evidence).toMatchObject({ schema: 'aukora.cord-evidence.v1', at: 'edge', skill: await skillId(), profile: 'fifo24', head: answer.head,
      tick: 5, inputs: 5, pins: { here: PIN.sha256, edge: PIN.sha256 }, code: null })
    expect(answer.evidence.claims.map(claim => [claim.claim, claim.status])).toEqual([
      ['parent-is-my-head', 'KNOWN'], ['head-recomputed', 'KNOWN'], ['state-is-my-last-24-inputs', 'KNOWN'], ['outputs-match-my-oracle', 'KNOWN'],
      ['pin-equal', 'KNOWN'], ['bytes-that-ran-at-the-edge', 'UNOBSERVABLE'], ['edge-fuel', 'UNOBSERVABLE']])
    expect(answer.evidence.claims.find(claim => claim.claim === 'pin-equal')?.by).toMatch(/SAID/u)
    expect((await shelf.execute({ action: 'cord', step: 'status' }) as J).lastEvidence).toEqual(answer.evidence)
    expect((await cells.journal()).lines[0]).toMatchObject({ caller: 'edge', cell: 'cord-echo', op: 'cord.run', pin: PIN.sha256 })
    // One evidence record per feed, refused or not: a refusal of the call's own shape is recorded too, and status names it.
    const calls = (await cells.journal()).totals.calls
    const stored = storeDigest(vfs)
    const shapes: Array<[J, string, 'here' | 'edge' | null, number]> = [
      [{ action: 'cord', step: 'feed', inputs: [1], at: 'mars' }, 'CORD_AT_INVALID', null, 1],
      [{ action: 'cord', step: 'feed', inputs: [1.5], at: 'here' }, 'CORD_INPUTS_INVALID', 'here', 1],
      [{ action: 'cord', step: 'feed', inputs: 'many', at: 'edge' }, 'CORD_INPUTS_INVALID', 'edge', 0],
      [{ action: 'cord', step: 'feed', inputs: [1, 2], at: 'here', head: 'f'.repeat(64) }, 'CORD_ARGS_INVALID', 'here', 2],
    ]
    for (const [args, code, at, inputs] of shapes) {
      const refusal = await shelf.execute(args) as J & { evidence: CordEvidence }
      expect(refusal, code).toMatchObject({ ok: false, code, at, next: expect.any(String) as unknown })
      expect(refusal.evidence, code).toMatchObject({ schema: 'aukora.cord-evidence.v1', at, code, head: null, tick: null, inputs, pins: { here: null, edge: null } })
      expect(refusal.evidence.claims.map(claim => claim.status), code).toEqual(new Array(7).fill('UNOBSERVABLE'))
      expect((await shelf.execute({ action: 'cord', step: 'status' }) as J).lastEvidence, code).toEqual(refusal.evidence)
    }
    expect((await cells.journal()).totals.calls).toBe(calls)
    expect(storeDigest(vfs)).toEqual(stored)
    expect(await shelf.execute({ action: 'cord', step: 'status', extra: 1 })).toEqual({ ok: false, code: 'CORD_ARGS_INVALID' })
    expect(await shelf.execute({ action: 'cord', step: 'grow' })).toMatchObject({ ok: false, code: 'CORD_STEP_INVALID' })

    const entry = RUNTIME_WRITE_SET.find(row => row.id === 'cord-checkpoint-store')!
    expect(entry.class).toBe('continuity')
    const skill = await skillId()
    expect(new RegExp(entry.match).test(`${CORD_DIR}/${skill}/head.json`)).toBe(true)
    expect(new RegExp(entry.match).test(`${CORD_DIR}/${skill}/checkpoints/${'a'.repeat(64)}.json`)).toBe(true)
    expect(new RegExp(entry.match).test(`${CORD_DIR}/${skill}/elsewhere.json`)).toBe(false)
    expect(classifyActionIrreversibility({ tool: 'x6_cell', action: 'cord', step: 'status' })).toBe(0)
    expect(classifyActionIrreversibility({ tool: 'x6_cell', action: 'cord', step: 'feed' })).toBe(1)
    expect(classifyActionIrreversibility({ tool: 'x6_cell', action: 'cord', step: 'start' })).toBe(1)
    // Voice: `start` and `feed` are refused; `status` alone may be read (voice-read-only.ts, argEquals step).
    const voice = (args: J) => voiceVerdict({ tool: 'x6_cell', args, origin: { kind: 'builtin' } })
    for (const step of ['start', 'feed']) expect(voice({ action: 'cord', step, inputs: [1], at: 'here' })).toContain('VOICE_LOOK_ONLY')
    for (const args of [{ action: 'cord' }, { action: 'cord', step: 'Status' }, { action: 'cord', step: ['status'] }]) expect(voice(args)).toContain('VOICE_LOOK_ONLY')
    expect(voice({ action: 'cord', step: 'status' })).toBeUndefined()
    // voice may read status: what it sends is same-origin GETs of /cells/** only; it calls no cell and writes nothing.
    const requests: string[] = []
    const recording: typeof fetch = async (input, init) => {
      const request = new Request(input, init)
      const url = new URL(request.url)
      requests.push(`${request.method} ${url.origin === ORIGIN ? url.pathname : url.href}`)
      return url.pathname.startsWith('/cells/') ? await served(url) : new Response('no', { status: 404 })
    }
    const looking = createCordShelf({ vfs, cells: () => cells, origin: ORIGIN, fetchImpl: recording, now: () => 0 })
    const callsBefore = (await cells.journal()).totals.calls
    const storeBefore = storeDigest(vfs)
    expect(await looking.execute({ action: 'cord', step: 'status' })).toMatchObject({ ok: true, started: true, tick: 5 })
    expect(requests.length).toBeGreaterThan(0)
    for (const line of requests) expect(line).toMatch(/^GET \/cells\/(?:kyber\/skills\/|cord\/)[a-z0-9.-]+\.json$/u)
    expect((await cells.journal()).totals.calls).toBe(callsBefore)
    expect(storeDigest(vfs)).toEqual(storeBefore)
    const mutation = classifyToolMutation('x6_cell', [{ name: 'action', type: 'string', required: true, enum: ['list', 'journal', 'cord'] }])
    expect(mutation.actions).toEqual({ read: ['journal', 'list'], write: ['cord'] })
    // Her proposals cannot change the cell, its source, the profile or the edge's loader (deploy/ci/frozen-paths.mjs: closed by
    // default, as kyber-cpu and pentora-codec are). cord-run.ts sits in the open runtime folder like every x6 module; closing
    // it as cell-handoff.ts is closed is a REQUEST to the owner of deploy/ci (HANDOFF-1).
    const { isFrozenRepoPath, isOpenRepoPath } = await import(new URL('deploy/ci/frozen-paths.mjs', REPO).href) as {
      isFrozenRepoPath: (path: string) => boolean
      isOpenRepoPath: (path: string, status: string) => boolean
    }
    for (const path of ['apps/web/public/cells/cord-echo.wasm', 'apps/web/public/cells/cord-echo.wat', 'apps/web/public/cells/cord/fifo24.profile.json',
      'deploy/cloudflare/src/cord-echo-cell.mjs', 'deploy/cloudflare/src/kyber-cell.mjs']) {
      expect(isFrozenRepoPath(path) || !isOpenRepoPath(path, 'modified'), path).toBe(true)
    }
    expect(e.touched).toEqual([])
  }, 60_000)
})
