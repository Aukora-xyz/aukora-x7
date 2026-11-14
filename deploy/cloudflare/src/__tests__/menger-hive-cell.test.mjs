/**
 * The menger-hive cell on the edge, through the real Worker route (POST /_host/cell-run) with the real cell
 * bytes, beside kyber-cpu and cord-echo in the frozen EDGE_CELLS allow-list. Wrangler's CompiledWasm shape is supplied
 * by the module hook below for apps/web/public/cells/menger-hive.wasm only. Bindings are spies: none may be touched.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import test from 'node:test'

const CELL_FILE = new URL('../../../../apps/web/public/cells/menger-hive.wasm', import.meta.url)
const WIRINGS_FILE = new URL('../../../../apps/web/public/cells/menger/wirings.v1.json', import.meta.url)
const loadedWasm = []
registerHooks({
  load(url, context, nextLoad) {
    if (!url.endsWith('.wasm')) return nextLoad(url, context)
    loadedWasm.push(url)
    if (url !== CELL_FILE.href) throw new Error(`unexpected Wasm import ${url}`)
    return {
      format: 'module', shortCircuit: true,
      source: `import { readFileSync } from 'node:fs'\nexport default new WebAssembly.Module(readFileSync(new URL(${JSON.stringify(url)})))\n`,
    }
  },
})

const { createWorker } = await import('../worker.mjs')
const { CELL_RUN_ROUTE, EDGE_CELLS, KYBER_CELL, admitKyberCellModule, loadMengerHiveCell, runKyberCell } = await import('../kyber-cell.mjs')
const { CORD_ECHO_CELL } = await import('../cord-echo-cell.mjs')
const { MENGER_HIVE_CELL, MENGER_HIVE_CELL_SPECIFIER } = await import('../menger-hive-cell.mjs')

const P = 65521
const ORIGIN = 'https://menger-hive-cell.example.invalid'
const OWNER = { type: 'owner', email: 'owner@example.invalid', expires: Math.floor(Date.now() / 1000) + 3600 }
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const WIRINGS_RAW = readFileSync(WIRINGS_FILE)
const WIRINGS_SHA = sha256(WIRINGS_RAW)
const WIRINGS = JSON.parse(WIRINGS_RAW.toString('utf8'))

function wordsShaHex(words) {
  const buf = Buffer.alloc(words.length * 2)
  words.forEach((w, idx) => buf.writeUInt16LE(w, 2 * idx))
  return sha256(buf)
}

function stepWaveOracle(wiringName, state, u) {
  const w = WIRINGS.wirings[wiringName]
  const q = state.slice(0, 80), p = state.slice(80, 160)
  const lq = new Array(80).fill(0)
  for (let i = 0; i < 80; i += 1) lq[i] = -((w.deg[i] + w.det[i]) * q[i])
  for (const [a, b] of w.edges) { lq[a] += q[b]; lq[b] += q[a] }
  const np = new Array(80), nq = new Array(80)
  for (let i = 0; i < 80; i += 1) {
    const rawP = (p[i] + lq[i] + (i === 0 ? u : 0)) % P
    np[i] = (rawP + P) % P
    nq[i] = (q[i] + np[i]) % P
  }
  const nextState = [...nq, ...np]
  return { corners: nq.slice(0, 20), nextState, stateSha256: wordsShaHex(nextState) }
}

function splitState(full, organ) {
  const s0 = 20 + 12 * organ
  const organState = [...full.slice(s0, s0 + 12), ...full.slice(80 + s0, 80 + s0 + 12)]
  const bodyQ = [], bodyP = []
  for (let s = 0; s < 80; s += 1) {
    if (s >= s0 && s < s0 + 12) continue
    bodyQ.push(full[s]); bodyP.push(full[80 + s])
  }
  return { organState, bodyState: [...bodyQ, ...bodyP] }
}

function joinState(organState, bodyState, organ) {
  const s0 = 20 + 12 * organ
  const full = new Array(160).fill(0)
  for (let j = 0; j < 12; j += 1) {
    full[s0 + j] = organState[j]
    full[80 + s0 + j] = organState[12 + j]
  }
  let idx = 0
  for (let s = 0; s < 80; s += 1) {
    if (s >= s0 && s < s0 + 12) continue
    full[s] = bodyState[idx]
    full[80 + s] = bodyState[68 + idx]
    idx += 1
  }
  return full
}

function fixture() {
  const touched = []
  const spy = name => new Proxy({}, { get(_target, property) { touched.push(`${name}.${String(property)}`); return () => { throw new Error(`${name} called`) } } })
  const env = {
    PUBLIC_HOST: new URL(ORIGIN).host, OWNER_EMAIL: OWNER.email, OWNER_PUBLIC_KEY_HEX: 'e'.repeat(64),
    HEAD: spy('HEAD'), MIRROR: spy('MIRROR'), VOICE_BRIDGE: spy('VOICE_BRIDGE'), ARCHIVE_BUCKET: spy('ARCHIVE_BUCKET'), ASSETS: spy('ASSETS'),
  }
  const worker = createWorker({ verifyAccess: async () => OWNER, networkFetch: async () => { touched.push('network'); throw new Error('network') } })
  const call = async body => {
    const response = await worker.fetch(new Request(ORIGIN + CELL_RUN_ROUTE.path, {
      method: 'POST', body: JSON.stringify(body),
      headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
    }), env)
    return { status: response.status, body: await response.json() }
  }
  return { call, touched }
}
const run = (op, input) => ({ cell: 'menger-hive', op, input })

test('the pin: the Worker imports the very file her browser fetches, and its bytes match CELL_PINS[menger-hive]', () => {
  const source = readFileSync(new URL('../menger-hive-cell.mjs', import.meta.url), 'utf8')
  const imports = [...source.matchAll(/\bimport\(\s*(['"])([^'"\n]+)\1\s*\)/g)].map(match => match[2])
  assert.deepEqual(imports, [MENGER_HIVE_CELL_SPECIFIER], 'exactly one dynamic import, the pinned file')
  const file = new URL(MENGER_HIVE_CELL_SPECIFIER, new URL('../menger-hive-cell.mjs', import.meta.url))
  assert.equal(file.href, CELL_FILE.href)
  assert.equal(file.pathname.endsWith('/apps/web/public/cells/menger-hive.wasm'), true)
  const bytes = readFileSync(file)
  assert.deepEqual([bytes.byteLength, sha256(bytes)], [MENGER_HIVE_CELL.bytes, MENGER_HIVE_CELL.sha256])
  const pins = readFileSync(new URL('../../../../packages/experimental/webworker-runtime/src/x6/wasm-cells.ts', import.meta.url), 'utf8')
  const entry = pins.match(/'menger-hive': \{\n\s+sha256: '([0-9a-f]{64})', bytes: (\d+), fuel: (\d+),\n\s+ops: Object\.freeze\(\[([^\]]*)\]\)/)
  assert.ok(entry, 'menger-hive pin present in wasm-cells.ts')
  assert.deepEqual([entry[1], Number(entry[2]), Number(entry[3])], [MENGER_HIVE_CELL.sha256, MENGER_HIVE_CELL.bytes, MENGER_HIVE_CELL.fuel])
  assert.deepEqual(entry[4].split(',').map(op => op.trim().replace(/'/g, '')), [...MENGER_HIVE_CELL.ops])
  assert.deepEqual(Object.keys(EDGE_CELLS), ['kyber-cpu', 'cord-echo', 'menger-hive'])
  assert.equal(Object.isFrozen(EDGE_CELLS), true)
  assert.equal(EDGE_CELLS['kyber-cpu'], KYBER_CELL)
  assert.equal(EDGE_CELLS['cord-echo'], CORD_ECHO_CELL)
  assert.equal(EDGE_CELLS['menger-hive'], MENGER_HIVE_CELL)
})

test('admission: zero imports, the metered exports and a fixed 4-page memory; the kyber entry refuses this module', async () => {
  const hive = await loadMengerHiveCell()
  assert.equal(hive.error, undefined)
  assert.equal(admitKyberCellModule(hive.module, MENGER_HIVE_CELL).module, hive.module)
  assert.equal(admitKyberCellModule(hive.module).error, 'MODULE_MEMORY_LIMIT')
  assert.deepEqual(loadedWasm, [CELL_FILE.href])
})

test('split-body co-simulation & mid-run organ handover on the edge match the wave oracle for both menger and plain; no binding is touched', async () => {
  const f = fixture()
  const info = await f.call(run('hive.info', {}))
  assert.equal(info.status, 200)
  assert.deepEqual(info.body.result, {
    boundaryWords: 7, corners: 20, cycleRank: 41, field: 65521, horizonTicks: 8, links: 120,
    organWords: 24, organs: 5, sites: 80, stateWords: 160,
    tableSha256: WIRINGS.tableSha256, wirings: ['menger', 'plain'], wiringsSha256: WIRINGS_SHA,
  })

  for (const wiring of ['menger', 'plain']) {
    let state = Array.from({ length: 160 }, (_, idx) => (idx * 3571 + 91) % P)
    let activeOrgan = 0
    let { organState, bodyState } = splitState(state, activeOrgan)
    for (let t = 0; t < 16; t += 1) {
      if (t === 8) {
        const reassembledAtCut = joinState(organState, bodyState, activeOrgan)
        activeOrgan = 2
        ;({ organState, bodyState } = splitState(reassembledAtCut, activeOrgan))
      }
      const input = (t * 8191 + 12345) % P
      const oracle = stepWaveOracle(wiring, state, input)
      const mono = await f.call(run('hive.step_monolith', { input, state, wiring }))
      assert.equal(mono.status, 200)
      assert.deepEqual(mono.body.result, oracle)

      const bnd = await f.call(run('hive.boundary', { bodyState, edgeOrgan: activeOrgan, wiring }))
      assert.equal(bnd.status, 200)
      assert.equal(bnd.body.result.msgToEdge.length, 7)

      const edgeStep = await f.call(run('hive.step_organ', {
        input, msgIn: bnd.body.result.msgToEdge, organ: activeOrgan, organState, wiring,
      }))
      assert.equal(edgeStep.status, 200)
      assert.equal(edgeStep.body.result.msgOut.length, 7)
      assert.equal(edgeStep.body.result.nextOrganState.length, 24)

      const bodyStep = await f.call(run('hive.step_body', {
        bodyState, edgeOrgan: activeOrgan, input, msgFromEdge: edgeStep.body.result.msgOut, wiring,
      }))
      assert.equal(bodyStep.status, 200)
      assert.deepEqual(bodyStep.body.result.corners, oracle.corners)

      organState = edgeStep.body.result.nextOrganState
      bodyState = bodyStep.body.result.nextBodyState
      const reassembled = joinState(organState, bodyState, activeOrgan)
      assert.deepEqual(reassembled, oracle.nextState)
      assert.equal(wordsShaHex(reassembled), oracle.stateSha256)
      state = oracle.nextState
    }
  }
  assert.deepEqual(f.touched, [], 'no binding and no network touched')
})

test('refusals and fuel: invalid ops, shapes, wirings, organ indices, words and starved grants refuse cleanly', async () => {
  const f = fixture()
  const badOp = await f.call(run('hive.unknown', {}))
  assert.deepEqual([badOp.status, badOp.body.code], [400, 'CELL_RUN_OP_REFUSED'])

  const badShape = await f.call(run('hive.info', { extra: 1 }))
  assert.deepEqual([badShape.status, badShape.body.code, badShape.body.source], [422, 'HIVE_SHAPE', 'cell'])

  const badWiring = await f.call(run('hive.step_monolith', { input: 0, state: new Array(160).fill(0), wiring: 'other' }))
  assert.deepEqual([badWiring.status, badWiring.body.code, badWiring.body.source], [422, 'HIVE_WIRING_UNKNOWN', 'cell'])

  const badOrgan = await f.call(run('hive.boundary', { bodyState: new Array(136).fill(0), edgeOrgan: 5, wiring: 'menger' }))
  assert.deepEqual([badOrgan.status, badOrgan.body.code, badOrgan.body.source], [422, 'HIVE_ORGAN_RANGE', 'cell'])

  const badWord = await f.call(run('hive.step_monolith', { input: 65521, state: new Array(160).fill(0), wiring: 'menger' }))
  assert.deepEqual([badWord.status, badWord.body.code, badWord.body.source], [422, 'HIVE_WORD_RANGE', 'cell'])

  const { module } = await loadMengerHiveCell()
  const full = runKyberCell(module, 'hive.step_monolith', { input: 65520, state: new Array(160).fill(65520), wiring: 'menger' }, MENGER_HIVE_CELL)
  assert.equal(full.ok, true)
  assert.ok(full.fuelUsed * 2 <= MENGER_HIVE_CELL.fuel, `worst fuel ${full.fuelUsed} <= half pin ${MENGER_HIVE_CELL.fuel}`)

  const starved = runKyberCell(module, 'hive.step_monolith', { input: 65520, state: new Array(160).fill(65520), wiring: 'menger' }, MENGER_HIVE_CELL, 10_000)
  assert.deepEqual([starved.ok, starved.source, starved.code], [false, 'host', 'FUEL'])
  assert.equal(Object.hasOwn(starved, 'result'), false)
  assert.deepEqual(f.touched, [])
})
