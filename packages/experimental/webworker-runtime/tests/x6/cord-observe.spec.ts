/**
 * The blind twin (src/x6/cord-observe.ts): from 23 observed future outputs of fifo24, `u[c-10]` is KNOWN
 * with its value, and the current output `y[c]` is UNOBSERVABLE with the constructive twin s[23] + 1. The twin is verified
 * by the PINNED cell, not by the function: both checkpoints (valid digests; anyone can make them) run `cord.run` on her real
 * cell host and give the same 23 outputs, while the claimed values differ by exactly 1.
 */
import { readFile } from 'node:fs/promises'
import { Worker } from 'node:worker_threads'
import { afterEach, describe, expect, it } from 'vitest'
import { cordObserve } from '../../src/x6/cord-observe.ts'
import { CORD_FIELD, cordFifoOracle, cordGenesis, cordHead, cordRunOracle, cordStateSha256, type CordCheckpoint } from '../../src/x6/cord-run.ts'
import { CELL_PINS, createCellHost, type CellHost, type CellWorker } from '../../src/x6/wasm-cells.ts'

const CELLS = new URL('../../../../../apps/web/public/cells/', import.meta.url)
const ORIGIN = 'https://cord-observe.example.invalid'
const P = CORD_FIELD
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
afterEach(async () => {
  try { await Promise.all([...hosts].map(host => host.dispose())) }
  finally { hosts.clear(); await Promise.all([...workers].map(worker => worker.terminate())); workers.clear() }
})
const host = (): CellHost => {
  const fetchImpl: typeof fetch = async (input) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    return new Response(new Uint8Array(await readFile(new URL(url.pathname.slice('/cells/'.length), CELLS))))
  }
  const cells = createCellHost({ origin: ORIGIN, fetchImpl, createWorker: nodeCellWorker, now: () => 0 })
  hosts.add(cells)
  return cells
}
const seeded = (seed: number, length: number): number[] => {
  let state = seed >>> 0
  return Array.from({ length }, () => { state = (Math.imul(state, 1103515245) + 12345) >>> 0; return (state >>> 8) % P })
}
const currentOutput = (state: readonly number[]): number => ((3 * state[7]! - 2 * state[15]! + state[23]!) % P + P) % P

describe('the blind twin', () => {
  it('u[c-10] is KNOWN from 23 future outputs; y[c] is UNOBSERVABLE, and the pinned cell confirms its twin', async () => {
    const cells = host()
    const pin = CELL_PINS['cord-echo']!
    const profileSha256 = new Uint8Array(await readFile(new URL('cord/fifo24.profile.json', CELLS)))
    const digest = [...new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', profileSha256))].map(byte => byte.toString(16).padStart(2, '0')).join('')
    const genesis = await cordGenesis(pin.sha256, 'e'.repeat(64), digest)
    const history = seeded(42, 300)
    const { checkpoint } = await cordRunOracle(genesis, history)
    const future = seeded(43, 23)
    const outputs = cordFifoOracle(checkpoint.state, future).outputs

    const known = cordObserve({ state: checkpoint.state, inputs: future, outputs, claim: { kind: 'input', ago: 10 } })
    expect(known).toEqual({ status: 'KNOWN', value: history[history.length - 1 - 10], rank: 23 })
    // The value comes from the outputs, not from the state handed in: a wrong state that fits nothing is refused instead.
    expect(cordObserve({ state: checkpoint.state, inputs: future, outputs: outputs.map((y, i) => i === 0 ? (y + 1) % P : y), claim: { kind: 'input', ago: 10 } }))
      .toMatchObject({ status: 'INCONSISTENT' })

    const blind = cordObserve({ state: checkpoint.state, inputs: future, outputs, claim: { kind: 'current-output' } })
    if (blind.status !== 'UNOBSERVABLE') throw new Error(JSON.stringify(blind))
    expect(blind.rank).toBe(23)
    const expectedTwin = [...checkpoint.state]
    expectedTwin[23] = (expectedTwin[23]! + 1) % P
    expect(blind.twin).toEqual(expectedTwin)
    expect(blind.values).toEqual({ state: currentOutput(checkpoint.state), twin: (currentOutput(checkpoint.state) + 1) % P })

    // The pinned cell verifies the twin: a checkpoint with valid digests for each state, the same 23 inputs, the same outputs.
    const twinFields = { ...checkpoint, state: [...blind.twin], stateSha256: await cordStateSha256(blind.twin) }
    const twin: CordCheckpoint = { ...twinFields, head: await cordHead(twinFields) }
    const run = async (point: CordCheckpoint) => {
      const answer = await cells.invoke('cord-echo', 'cord.run', { checkpoint: point, expect: { head: point.head, tick: point.tick }, inputs: future, profile: 'fifo24' })
      if (!answer.ok) throw new Error(answer.code)
      return answer.result as { checkpoint: CordCheckpoint; outputs: number[] }
    }
    const [real, other] = [await run(checkpoint), await run(twin)]
    expect(real.outputs).toEqual(outputs)
    expect(other.outputs).toEqual(outputs)
    expect(other.outputs).toHaveLength(23)
    expect((currentOutput(twin.state) - currentOutput(checkpoint.state) + P) % P).toBe(1)
    // The oldest word enters no future output: forty observed outputs still cannot tell the twin apart (the cell says so too).
    const forty = [...future, ...seeded(44, 17)]
    const [far, farTwin] = [await run40(checkpoint, forty), await run40(twin, forty)]
    expect(far).toHaveLength(40)
    expect(farTwin).toEqual(far)
    expect(cordObserve({ state: checkpoint.state, inputs: forty, outputs: far, claim: { kind: 'current-output' } })).toMatchObject({ status: 'UNOBSERVABLE', rank: 23 })
    async function run40(point: CordCheckpoint, inputs: number[]): Promise<number[]> {
      const answer = await cells.invoke('cord-echo', 'cord.run', { checkpoint: point, expect: { head: point.head, tick: point.tick }, inputs, profile: 'fifo24' })
      if (!answer.ok) throw new Error(answer.code)
      return (answer.result as { outputs: number[] }).outputs
    }
  }, 60_000)
})
