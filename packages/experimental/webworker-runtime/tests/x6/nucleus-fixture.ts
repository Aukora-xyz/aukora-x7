/**
 * Her cell host on a
 * Node worker (the real pinned `nucleus` cell), a stand-in host whose `nucleus` answer the test chooses, the shipped
 * reflex bytes, a changed copy of them, and a shadow with the consult taken out. Local only: no network.
 */
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { Worker } from 'node:worker_threads'
import { TOUCH_ID_TIER_REFLEX_DIGEST, type NucleusShadow } from '../../src/x6/nucleus-shadow.ts'
import { NUCLEUS_TIER_T1, nucleusTierRow } from '../../src/x6/nucleus-tier.ts'
import { CELL_JOURNAL_ROOT_0 } from '../../src/x6/cell-journal.ts'
import { CELL_PINS, createCellHost, type CellAnswer, type CellHost, type CellWorker } from '../../src/x6/wasm-cells.ts'

export const CELLS = new URL('../../../../../apps/web/public/cells/', import.meta.url)
export const REFLEX_BYTES = new Uint8Array(readFileSync(new URL('reflexes/touch-id-tier.json', CELLS)))
/** The shipped reflex with one bit changed: not the pinned bytes. */
export const WRONG_REFLEX = (() => { const bytes = Uint8Array.from(REFLEX_BYTES); bytes[200] = bytes[200]! ^ 1; return bytes })()

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
const servedCells: typeof fetch = async (input) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
  if (!url.pathname.startsWith('/cells/')) return new Response('no', { status: 404 })
  return new Response(new Uint8Array(await readFile(new URL(url.pathname.slice('/cells/'.length), CELLS))), { headers: { 'content-type': 'application/wasm' } })
}

/** Her real cell host (the pinned cells, served from apps/web/public/cells) on a Node worker. */
export function realCellHost(origin: string): CellHost {
  const host = createCellHost({ origin, fetchImpl: servedCells, createWorker: nodeCellWorker })
  hosts.add(host)
  return host
}

/** Dispose every real host and worker this fixture made (call from afterEach / onTestFinished). */
export async function disposeCellHosts(): Promise<void> {
  try { await Promise.all([...hosts].map(host => host.dispose())) }
  finally {
    hosts.clear()
    await Promise.all([...workers].map(worker => worker.terminate()))
    workers.clear()
  }
}

export type Behaviour = 'T1' | 'escalation' | 'null' | 'throw' | 'hang'
/** A cell host whose `nucleus` answer is chosen by the test, whatever the facts (a valid answer for the row it was asked). */
export function standInHost(behaviour: Behaviour, seen: unknown[] = []): CellHost {
  const answer = (input: unknown): CellAnswer => {
    const row = nucleusTierRow((input as { input: number[] }).input)
    const base = { cell: 'nucleus', op: 'reflex.run', fuelUsed: 1, sha256: CELL_PINS.nucleus!.sha256 }
    if (behaviour === 'null') return { ...base, ok: false, code: 'FUEL' }
    const decision = behaviour === 'T1' ? NUCLEUS_TIER_T1 : 4
    return { ...base, ok: true, result: { decision, escalate: behaviour === 'T1' ? 0 : 1, reflex: TOUCH_ID_TIER_REFLEX_DIGEST, row } }
  }
  return {
    dispose: async () => {},
    list: () => [],
    compileAndRun: () => Promise.reject(new Error('not in this fixture')),
    // A stand-in keeps and re-runs nothing.
    forge: () => Promise.reject(new Error('not in this fixture')),
    runForged: () => Promise.reject(new Error('not in this fixture')),
    // SKILLS: a stand-in has admitted no bytes.
    verifiedBytes: () => Promise.resolve(null),
    // A stand-in has no cells of its own and journals nothing.
    cellRows: () => [],
    journal: () => Promise.reject(new Error('not in this fixture')),
    journalSummary: () => ({ calls: 0, rootSha256: CELL_JOURNAL_ROOT_0 }),
    // A stand-in hands nothing to the edge.
    noteEdgeCall: () => {},
    invoke(_cell, _op, input) {
      seen.push(input)
      if (behaviour === 'throw') throw new Error('synthetic cell host failure')
      if (behaviour === 'hang') return new Promise<CellAnswer>(() => {})
      return Promise.resolve(answer(input))
    },
  }
}

/** A shadow with the consult taken out: no read, no cell, no wait. */
export const removedShadow: NucleusShadow = {
  consult: () => Promise.resolve({ nucleus: { consult: null, reason: 'REMOVED' }, facts: null }),
  settle: () => 'unknown',
  snapshot: () => ({ reflex: TOUCH_ID_TIER_REFLEX_DIGEST, consulted: 0, agree: 0, mismatch: 0, unknown: 0, lastMismatches: [] }),
}

/** Every consult variant the authority tests run, and the `nucleus` answer each must show. */
export type Variant = 'removed' | Behaviour | 'reflex-missing' | 'reflex-wrong'
export const VARIANTS: readonly Variant[] = ['removed', 'T1', 'escalation', 'null', 'throw', 'hang', 'reflex-missing', 'reflex-wrong']
