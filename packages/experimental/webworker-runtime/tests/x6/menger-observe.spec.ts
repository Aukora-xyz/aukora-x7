/**
 * the Menger hive observability, reachable 4-tick blind twin, and caller-supplied `seqs` check (src/x6/menger-observe.ts):
 * - Under the detuned wave law mod 65,521 on both 80-site wirings ("menger" and "plain"), 8 ticks of the 20 shared
 *   corners (160 readings) determine all 160 state words (`KNOWN`, `blindDimsAt8: 0`, `privacyClaim: false`).
 * - At 4 ticks (80 readings), `blindDimsAt4: 80`, and `mengerObserve` constructs the reachable Krylov twin matching
 *   `BLANKET.md` (`8859` vs `38200` on `blanket.py`'s `seed=5` trajectory), verified through the real pinned
 *   `menger-hive` Wasm cell (`hive.step_monolith`) and by replaying the 160 solved inputs from the zero state.
 * - Caller-supplied `seqs`: non-consecutive `seqs` (`seq !== prevSeq + 1`) are rejected `INCONSISTENT` (`reason: 'rewind'`);
 *   cell answers carry no `seq`, so this checks caller-passed `seqs` only, not standalone state rewinds.
 */
import { readFile } from 'node:fs/promises'
import { Worker } from 'node:worker_threads'
import { afterEach, describe, expect, it } from 'vitest'
import {
  analyzeMengerWiring,
  MENGER_FIELD,
  MENGER_WIRINGS_DOC,
  MENGER_WIRINGS_SHA256,
  mengerObserve,
  stepMengerWaveOracle,
} from '../../src/x6/menger-observe.ts'
import { cellCanonicalJson, createCellHost, type CellHost, type CellWorker } from '../../src/x6/wasm-cells.ts'

const CELLS = new URL('../../../../../apps/web/public/cells/', import.meta.url)
const ORIGIN = 'https://menger-observe.example.invalid'
const P = MENGER_FIELD
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
    listen(onMessage, onFailure) {
      worker.on('message', onMessage)
      worker.on('error', onFailure)
      worker.on('messageerror', onFailure)
    },
    postMessage: (message) => { worker.postMessage(message) },
    async terminate() {
      await worker.terminate()
      worker.removeAllListeners()
      workers.delete(worker)
    },
  }
}

afterEach(async () => {
  try { await Promise.all([...hosts].map(h => h.dispose())) }
  finally {
    hosts.clear()
    await Promise.all([...workers].map(w => w.terminate()))
    workers.clear()
  }
})

const createTestHost = (): CellHost => {
  const fetchImpl: typeof fetch = async (input) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    return new Response(new Uint8Array(await readFile(new URL(url.pathname.slice('/cells/'.length), CELLS))))
  }
  const cells = createCellHost({ origin: ORIGIN, fetchImpl, createWorker: nodeCellWorker, now: () => 0 })
  hosts.add(cells)
  return cells
}

/** Exact 300-step drive + 8 future inputs from `blanket.py` (`np.random.default_rng(5).integers(0, 65521)`). */
const BLANKET_SEED5_WARMUP_300: readonly number[] = [
  43950, 52744, 1484, 52937, 30719, 33764, 41293, 18725, 64179, 3533, 18209, 25118, 37424, 26763, 8587,
  2966, 66, 3194, 9750, 65467, 12513, 42743, 49157, 15365, 18492, 28498, 17247, 63829, 11644, 58816,
  52265, 55314, 7582, 25710, 41149, 32303, 43628, 44337, 43435, 3983, 62841, 36403, 59198, 17785, 23687,
  57635, 12246, 4207, 24498, 44500, 8009, 57009, 22346, 14894, 35672, 58670, 57916, 57147, 20080, 1213,
  50984, 46355, 50515, 78, 2480, 32980, 21959, 28610, 61019, 13317, 34593, 21290, 19326, 52824, 10039,
  20734, 7783, 9765, 18412, 45767, 37972, 29389, 11108, 52347, 52402, 15431, 3911, 20952, 9566, 52408,
  34041, 33223, 19037, 33178, 63388, 15475, 50324, 952, 20560, 61145, 57086, 5623, 55236, 55360, 29699,
  24103, 64235, 62311, 44372, 26170, 13773, 61356, 17611, 36440, 44203, 15733, 20649, 48578, 12934, 44186,
  61890, 44829, 42339, 30390, 63417, 14538, 23315, 41995, 42900, 7016, 10632, 45355, 55083, 41631, 61163,
  24669, 21603, 52320, 2692, 12712, 12638, 25583, 10279, 52281, 55467, 24929, 1921, 46733, 7059, 40132,
  11209, 61655, 44393, 64975, 40422, 47415, 24634, 52996, 7400, 10015, 23604, 46709, 31809, 55537, 61687,
  26288, 27778, 36249, 42291, 31416, 39451, 62803, 48092, 20788, 27868, 26344, 9853, 60, 51890, 27530,
  23048, 41372, 36956, 61259, 40324, 60520, 37917, 21448, 21144, 64791, 38396, 12296, 54432, 53940, 766,
  10303, 45362, 26542, 22347, 4814, 12467, 56219, 54516, 54303, 37461, 9159, 21127, 34536, 65260, 16913,
  35932, 32221, 32944, 36246, 46162, 6962, 64272, 56634, 50317, 18260, 28883, 29295, 20245, 3751, 48757,
  179, 49931, 12787, 42133, 22386, 15480, 60810, 31093, 58295, 12445, 31482, 22741, 29796, 780, 43702,
  22587, 56266, 13958, 22100, 2997, 52001, 34989, 26142, 60084, 38923, 63150, 48319, 38365, 32849, 13232,
  45260, 51822, 45688, 27033, 374, 48126, 2559, 52670, 9765, 20083, 13997, 35414, 13314, 16939, 3208,
  64283, 14231, 12547, 39374, 9257, 58056, 51256, 22899, 26232, 24007, 48167, 27305, 18703, 44576, 9010,
  51451, 27950, 61652, 17114, 24616, 57128, 46308, 2646, 22384, 1060, 53989, 27293, 15112, 47541, 57069,
]
const BLANKET_SEED5_FUTURE_8: readonly number[] = [6807, 33095, 23998, 47525, 60924, 35053, 49083, 20712]

describe('menger-observe: 8-tick horizon and 4-tick reachable twin (privacyClaim: false)', () => {
  it('both menger and plain match on detuned reach (160) and 8-tick horizon, while undetuned one-corner wave reach is 20 vs 80', async () => {
    const shippedBytes = await readFile(new URL('menger/wirings.v1.json', CELLS), 'utf8')
    expect(cellCanonicalJson(MENGER_WIRINGS_DOC)).toBe(shippedBytes)
    const shaHex = [...new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(shippedBytes)))]
      .map(b => b.toString(16).padStart(2, '0')).join('')
    expect(shaHex).toBe(MENGER_WIRINGS_SHA256)

    const menger = analyzeMengerWiring('menger')
    const plain = analyzeMengerWiring('plain')
    expect(menger).toEqual({
      wiring: 'menger',
      horizonTicks: 8,
      blindDimsAt4: 80,
      blindDimsAt8: 0,
      observedRankAt4: 80,
      observedRankAt8: 160,
      detunedWaveReach: 160,
      undetunedOneCornerWaveReach: 20,
      privacyClaim: false,
    })
    expect(plain).toEqual({
      wiring: 'plain',
      horizonTicks: 8,
      blindDimsAt4: 80,
      blindDimsAt8: 0,
      observedRankAt4: 80,
      observedRankAt8: 160,
      detunedWaveReach: 160,
      undetunedOneCornerWaveReach: 80,
      privacyClaim: false,
    })
  })

  it('reproduces BLANKET.md E3 exact integers (8859 vs 38200 at T=4, KNOWN at T=8), verifies 80 twin readings, and rejects non-consecutive caller seqs', async () => {
    const cells = createTestHost()

    for (const wiring of ['menger', 'plain'] as const) {
      let x0 = new Array<number>(160).fill(0)
      for (const u of BLANKET_SEED5_WARMUP_300) {
        x0 = stepMengerWaveOracle(wiring, x0, u, true).nextState
      }

      const readings8: number[][] = []
      let sim = [...x0]
      for (const u of BLANKET_SEED5_FUTURE_8) {
        readings8.push(sim.slice(0, 20))
        sim = stepMengerWaveOracle(wiring, sim, u, true).nextState
      }

      // 1. At T = 4: UNOBSERVABLE with reachable Krylov twin + monotonic seq
      const inputs4 = BLANKET_SEED5_FUTURE_8.slice(0, 4)
      const readings4 = readings8.slice(0, 4)
      const obs4 = mengerObserve({
        wiring,
        state: x0,
        inputs: inputs4,
        cornerReadings: readings4,
        seqs: [300, 301, 302, 303],
        targetCoord: 20,
      })
      if (obs4.status !== 'UNOBSERVABLE') throw new Error(JSON.stringify(obs4))
      expect(obs4.privacyClaim).toBe(false)
      expect(obs4.seq).toBe(303)
      expect(obs4.rank).toBe(80)
      expect(obs4.blindDims).toBe(80)
      if (wiring === 'menger') {
        expect(MENGER_WIRINGS_DOC.wirings.menger.globalSites?.[20]).toBe(11)
        expect(obs4.values).toEqual({ state: 8859, twin: 38200 })
      } else {
        expect(obs4.values.state).not.toBe(obs4.values.twin)
      }

      // Verify the twin is genuinely reachable from zero by replaying its 160 solved inputs:
      let replayed = new Array<number>(160).fill(0)
      for (const u of obs4.replayInputsFromZero) {
        replayed = stepMengerWaveOracle(wiring, replayed, u, true).nextState
      }
      expect(replayed).toEqual(obs4.twin)

      // Verify all 80 corner readings across the 4 ticks through the REAL pinned `menger-hive` Wasm cell:
      let curA = [...x0]
      let curB = [...obs4.twin]
      for (let t = 0; t < 4; t += 1) {
        expect(curA.slice(0, 20)).toEqual(readings4[t])
        expect(curB.slice(0, 20)).toEqual(readings4[t])
        if (t < 3) {
          const stepA = await cells.invoke('menger-hive', 'hive.step_monolith', { input: inputs4[t]!, state: curA, wiring })
          const stepB = await cells.invoke('menger-hive', 'hive.step_monolith', { input: inputs4[t]!, state: curB, wiring })
          if (!stepA.ok) throw new Error(stepA.code)
          if (!stepB.ok) throw new Error(stepB.code)
          curA = (stepA.result as { nextState: number[] }).nextState
          curB = (stepB.result as { nextState: number[] }).nextState
        }
      }

      // 2. At T = 8: KNOWN — solved from `cornerReadings` + `inputs` ALONE with `state` OMITTED (`undefined`),
      //    recovering both targetCoord 20 and arbitrary coordinates without passing `x0`:
      const obs8WithoutState = mengerObserve({
        wiring,
        inputs: BLANKET_SEED5_FUTURE_8,
        cornerReadings: readings8,
        seqs: [300, 301, 302, 303, 304, 305, 306, 307],
        targetCoord: 20,
      })
      expect(obs8WithoutState).toEqual({
        status: 'KNOWN',
        seq: 307,
        value: x0[20],
        rank: 160,
        blindDims: 0,
        privacyClaim: false,
      })
      for (const coord of [0, 19, 20, 31, 79, 80, 100, 159]) {
        expect(mengerObserve({ wiring, inputs: BLANKET_SEED5_FUTURE_8, cornerReadings: readings8, targetCoord: coord }))
          .toEqual({ status: 'KNOWN', seq: 7, value: x0[coord], rank: 160, blindDims: 0, privacyClaim: false })
      }
      // Also works when `state` is supplied (verifying simulated corners match `readings8` first):
      expect(mengerObserve({
        wiring,
        state: x0,
        inputs: BLANKET_SEED5_FUTURE_8,
        cornerReadings: readings8,
        seqs: [300, 301, 302, 303, 304, 305, 306, 307],
        targetCoord: 20,
      })).toEqual(obs8WithoutState)

      // At T = 4 with `state` OMITTED, `mengerObserve` still solves a consistent state and constructs a reachable blind twin:
      const obs4WithoutState = mengerObserve({
        wiring,
        inputs: inputs4,
        cornerReadings: readings4,
        targetCoord: 20,
      })
      if (obs4WithoutState.status !== 'UNOBSERVABLE') throw new Error(JSON.stringify(obs4WithoutState))
      expect(obs4WithoutState.values.state).not.toBe(obs4WithoutState.values.twin)

      // 3. Caller-supplied `seqs` check: non-consecutive caller `seqs` rejected on first offending entry
      for (const rewoundSeq of [300, 299, 250, 0]) {
        expect(mengerObserve({
          wiring,
          inputs: inputs4,
          cornerReadings: readings4,
          seqs: [300, rewoundSeq, rewoundSeq + 1, rewoundSeq + 2],
          targetCoord: 20,
        })).toEqual({ status: 'INCONSISTENT', reason: 'rewind', seq: rewoundSeq, privacyClaim: false })
      }

      // Tampered corner reading is refused as INCONSISTENT (both when `state` is passed and when `state` is omitted
      // on an overdetermined 9-tick window whose inconsistent residual fails `matchesObservations`):
      const tampered = readings8.map((row, idx) => (idx === 0 ? [(row[0]! + 1) % P, ...row.slice(1)] : row))
      expect(mengerObserve({ wiring, state: x0, inputs: BLANKET_SEED5_FUTURE_8, cornerReadings: tampered, targetCoord: 20 }))
        .toEqual({ status: 'INCONSISTENT', reason: 'readings', seq: 0, privacyClaim: false })
      const readings9 = [...readings8, sim.slice(0, 20)]
      const inputs9 = [...BLANKET_SEED5_FUTURE_8, 12345]
      const tampered9 = readings9.map((row, idx) => (idx === 8 ? [(row[0]! + 1) % P, ...row.slice(1)] : row))
      expect(mengerObserve({ wiring, inputs: inputs9, cornerReadings: tampered9, targetCoord: 20 }))
        .toEqual({ status: 'INCONSISTENT', reason: 'observations', seq: 8, privacyClaim: false })
    }
  })
})
