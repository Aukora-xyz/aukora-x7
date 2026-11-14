/**
 * The cord-echo cell on the edge, through the real Worker route (POST /_host/cell-run) with the real cell
 * bytes, beside kyber-cpu in an exact allow-list. The bundle hands the Worker a compiled module as the `.wasm` file's
 * default export (wrangler's CompiledWasm rule); Node is given exactly that shape by the module hook below, for exactly
 * that one file. Bindings are spies: the route must touch none of them. Local only: no network, no storage.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import test from 'node:test'

const CELL_FILE = new URL('../../../../apps/web/public/cells/cord-echo.wasm', import.meta.url)
const loadedWasm = []
registerHooks({
  load(url, context, nextLoad) {
    if (!url.endsWith('.wasm')) return nextLoad(url, context)
    loadedWasm.push(url)
    if (url !== CELL_FILE.href) throw new Error(`unexpected Wasm import ${url}`)
    return { format: 'module', shortCircuit: true,
      source: `import { readFileSync } from 'node:fs'\nexport default new WebAssembly.Module(readFileSync(new URL(${JSON.stringify(url)})))\n` }
  },
})

const { createWorker } = await import('../worker.mjs')
const { CELL_RUN_ROUTE, EDGE_CELLS, KYBER_CELL, admitKyberCellModule, loadCordEchoCell, runKyberCell } = await import('../kyber-cell.mjs')
const { CORD_ECHO_CELL, CORD_ECHO_CELL_SPECIFIER } = await import('../cord-echo-cell.mjs')

/** An independent fifo24 oracle in this file (node:crypto), written from docs/auma/cord-echo.md. */
const H = (...parts) => createHash('sha256').update(Buffer.concat(parts.map(part => Buffer.from(part)))).digest()
const u32 = value => { const b = Buffer.alloc(4); b.writeUInt32LE(value); return b }
const u16 = value => { const b = Buffer.alloc(2); b.writeUInt16LE(value); return b }
const stateSha = state => H(Buffer.concat(state.map(u16))).toString('hex')
const headOf = c => H(Buffer.from('aukora.cord.head.v1\n'), ...[c.cell, c.skill, c.profileSha256, c.parent].map(x => Buffer.from(x, 'hex')), u32(c.tick),
  ...[c.stateSha256, c.inputRoot, c.outputRoot].map(x => Buffer.from(x, 'hex'))).toString('hex')
async function cordGenesis(cell, skill, profileSha256) {
  const state = new Array(24).fill(0)
  const fields = { cell, skill, profileSha256, parent: '0'.repeat(64), tick: 0, stateSha256: stateSha(state),
    inputRoot: H(Buffer.from('aukora.cord.inputs.v1')).toString('hex'), outputRoot: H(Buffer.from('aukora.cord.outputs.v1')).toString('hex') }
  return { ...fields, head: headOf(fields), profile: 'fifo24', schema: 'aukora.cord.checkpoint.v1', state }
}
async function cordRunOracle(c, inputs) {
  let state = [...c.state], inr = Buffer.from(c.inputRoot, 'hex'), outr = Buffer.from(c.outputRoot, 'hex')
  const outputs = []
  inputs.forEach((u, i) => {
    state = [u, ...state.slice(0, 23)]
    const y = ((3 * state[7] - 2 * state[15] + state[23]) % 65521 + 65521) % 65521
    outputs.push(y)
    inr = H(inr, u32(c.tick + i + 1), u16(u)); outr = H(outr, u32(c.tick + i + 1), u16(y))
  })
  const fields = { cell: c.cell, skill: c.skill, profileSha256: c.profileSha256, parent: c.head, tick: c.tick + inputs.length,
    stateSha256: stateSha(state), inputRoot: inr.toString('hex'), outputRoot: outr.toString('hex') }
  return { checkpoint: { ...fields, head: headOf(fields), profile: c.profile, schema: 'aukora.cord.checkpoint.v1', state }, outputs }
}

const ORIGIN = 'https://cord-echo-cell.example.invalid'
const OWNER = { type: 'owner', email: 'owner@example.invalid', expires: Math.floor(Date.now() / 1000) + 3600 }
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const PROFILE_SHA = sha256(readFileSync(new URL('../../../../apps/web/public/cells/cord/fifo24.profile.json', import.meta.url)))
const SKILL = 'd'.repeat(64)

function fixture() {
  const touched = []
  const spy = name => new Proxy({}, { get(_target, property) { touched.push(`${name}.${String(property)}`); return () => { throw new Error(`${name} called`) } } })
  const env = { PUBLIC_HOST: new URL(ORIGIN).host, OWNER_EMAIL: OWNER.email, OWNER_PUBLIC_KEY_HEX: 'e'.repeat(64),
    HEAD: spy('HEAD'), MIRROR: spy('MIRROR'), VOICE_BRIDGE: spy('VOICE_BRIDGE'), ARCHIVE_BUCKET: spy('ARCHIVE_BUCKET'), ASSETS: spy('ASSETS') }
  const worker = createWorker({ verifyAccess: async () => OWNER, networkFetch: async () => { touched.push('network'); throw new Error('network') } })
  const call = async body => {
    const response = await worker.fetch(new Request(ORIGIN + CELL_RUN_ROUTE.path, { method: 'POST', body: JSON.stringify(body),
      headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' } }), env)
    return { status: response.status, body: await response.json() }
  }
  return { call, touched }
}
const run = (op, input) => ({ cell: 'cord-echo', op, input })

test('the pin: the Worker imports the very file her browser fetches, and its bytes are CELL_PINS[cord-echo]', () => {
  const source = readFileSync(new URL('../cord-echo-cell.mjs', import.meta.url), 'utf8')
  const imports = [...source.matchAll(/\bimport\(\s*(['"])([^'"\n]+)\1\s*\)/g)].map(match => match[2])
  assert.deepEqual(imports, [CORD_ECHO_CELL_SPECIFIER], 'exactly one dynamic import, the pinned file')
  const file = new URL(CORD_ECHO_CELL_SPECIFIER, new URL('../cord-echo-cell.mjs', import.meta.url))
  assert.equal(file.href, CELL_FILE.href)
  assert.equal(file.pathname.endsWith('/apps/web/public/cells/cord-echo.wasm'), true, 'the file the browser fetches at /cells/cord-echo.wasm')
  const bytes = readFileSync(file)
  assert.deepEqual([bytes.byteLength, sha256(bytes)], [CORD_ECHO_CELL.bytes, CORD_ECHO_CELL.sha256])
  const pins = readFileSync(new URL('../../../../packages/experimental/webworker-runtime/src/x6/wasm-cells.ts', import.meta.url), 'utf8')
  const entry = pins.match(/'cord-echo': \{\n\s+sha256: '([0-9a-f]{64})', bytes: (\d+), fuel: (\d+),\n\s+ops: Object\.freeze\(\[([^\]]*)\]\)/)
  assert.ok(entry, 'cord-echo pin present')
  assert.deepEqual([entry[1], Number(entry[2]), Number(entry[3])], [CORD_ECHO_CELL.sha256, CORD_ECHO_CELL.bytes, CORD_ECHO_CELL.fuel])
  assert.deepEqual(entry[4].split(',').map(op => op.trim().replace(/'/g, '')), [...CORD_ECHO_CELL.ops])
  // The exact allow-list: three cells, frozen; kyber-cpu's entry is the one its own test pins.
  assert.deepEqual(Object.keys(EDGE_CELLS), ['kyber-cpu', 'cord-echo', 'menger-hive'])
  assert.equal(Object.isFrozen(EDGE_CELLS), true)
  assert.equal(EDGE_CELLS['kyber-cpu'], KYBER_CELL)
  assert.equal(EDGE_CELLS['cord-echo'], CORD_ECHO_CELL)
  // kyber-cell.mjs keeps exactly its own one dynamic import.
  const kyber = readFileSync(new URL('../kyber-cell.mjs', import.meta.url), 'utf8')
  assert.equal([...kyber.matchAll(/\bimport\(/g)].length, 1)
})

test('admission: zero imports, the metered exports and a fixed 4-page memory; the kyber entry refuses this module', async () => {
  const cord = await loadCordEchoCell()
  assert.equal(cord.error, undefined)
  assert.equal(admitKyberCellModule(cord.module, CORD_ECHO_CELL).module, cord.module)
  assert.equal(admitKyberCellModule(cord.module).error, 'MODULE_MEMORY_LIMIT', 'admitted only under its own entry')
  assert.deepEqual(loadedWasm, [CELL_FILE.href], 'the import loaded exactly the pinned file, once')
})

test('the owner runs genesis, run and info on the edge; the answer is the oracle\'s; no binding is touched', async () => {
  const f = fixture()
  const info = await f.call(run('cord.info', {}))
  assert.deepEqual([info.status, info.body.result], [200, { field: 65521, maxInputs: 1000, profile: 'fifo24', profileSha256: PROFILE_SHA, stateWords: 24 }])
  const genesis = await f.call(run('cord.genesis', { cell: CORD_ECHO_CELL.sha256, profile: 'fifo24', skill: SKILL }))
  const expected = await cordGenesis(CORD_ECHO_CELL.sha256, SKILL, PROFILE_SHA)
  assert.deepEqual([genesis.status, genesis.body.result, genesis.body.pin, genesis.body.host], [200, { checkpoint: expected }, CORD_ECHO_CELL.sha256, 'edge'])
  const inputs = Array.from({ length: 200 }, (_, index) => (index * 977) % 65521)
  const answer = await f.call(run('cord.run', { checkpoint: expected, expect: { head: expected.head, tick: 0 }, inputs, profile: 'fifo24' }))
  assert.equal(answer.status, 200)
  assert.deepEqual(answer.body.result, await cordRunOracle(expected, inputs))
  assert.ok(answer.body.fuelUsed > 0 && answer.body.fuelUsed < CORD_ECHO_CELL.fuel)
  assert.deepEqual(f.touched, [], 'no binding and no network: no storage, no object, no lease, no receipt, no HEAD')
})

test('the pin a request claims must be this edge\'s own; other cells, ops and keys are refused before anything runs', async () => {
  const f = fixture()
  const genesis = await cordGenesis('1'.repeat(64), SKILL, PROFILE_SHA)
  const refused = await f.call(run('cord.run', { checkpoint: genesis, expect: { head: genesis.head, tick: 0 }, inputs: [1], profile: 'fifo24' }))
  assert.deepEqual([refused.status, refused.body.code, refused.body.pin], [422, 'CORD_PIN_MISMATCH', CORD_ECHO_CELL.sha256])
  assert.equal(Object.hasOwn(refused.body, 'result'), false)
  const other = await f.call(run('cord.genesis', { cell: '1'.repeat(64), profile: 'fifo24', skill: SKILL }))
  assert.deepEqual([other.status, other.body.code], [422, 'CORD_PIN_MISMATCH'])
  const cases = [
    [{ cell: 'cord-echo2', op: 'cord.info', input: {} }, 400, 'CELL_RUN_CELL_REFUSED'],
    [{ cell: '__proto__', op: 'cord.info', input: {} }, 400, 'CELL_RUN_CELL_REFUSED'],
    [{ cell: 'nucleus', op: 'reflex.run', input: {} }, 400, 'CELL_RUN_CELL_REFUSED'],
    [{ cell: 'cord-echo', op: 'cpu.run', input: {} }, 400, 'CELL_RUN_OP_REFUSED'],
    [{ cell: 'cord-echo', op: 'cord.shadow', input: {} }, 400, 'CELL_RUN_OP_REFUSED'],
    [{ cell: 'kyber-cpu', op: 'cord.run', input: {} }, 400, 'CELL_RUN_OP_REFUSED'],
    [{ cell: 'cord-echo', op: 'cord.info', input: {}, fuel: 1 }, 400, 'CELL_RUN_REQUEST_INVALID'],
    [{ cell: 'cord-echo', op: 'cord.info', input: [] }, 400, 'CELL_RUN_REQUEST_INVALID'],
  ]
  for (const [body, status, code] of cases) {
    const answer = await f.call(body)
    assert.deepEqual([answer.status, answer.body.code], [status, code], JSON.stringify(body))
    assert.equal(Object.hasOwn(answer.body, 'result'), false)
  }
  // The cell's own refusal passes through as a refusal: an extra key inside the input is CORD_SHAPE.
  const shape = await f.call(run('cord.info', { extra: 1 }))
  assert.deepEqual([shape.status, shape.body.code, shape.body.source], [422, 'CORD_SHAPE', 'cell'])
  assert.deepEqual(f.touched, [])
})

test('the runner: the route passes the pinned grant; a smaller grant is FUEL, a refusal, never a value', async () => {
  const { module } = await loadCordEchoCell()
  const genesis = await cordGenesis(CORD_ECHO_CELL.sha256, SKILL, PROFILE_SHA)
  const input = { checkpoint: genesis, expect: { head: genesis.head, tick: 0 }, inputs: new Array(1000).fill(65520), profile: 'fifo24' }
  const full = runKyberCell(module, 'cord.run', input, CORD_ECHO_CELL)
  assert.equal(full.ok, true)
  assert.ok(full.fuelUsed * 2 <= CORD_ECHO_CELL.fuel, `worst fuel ${full.fuelUsed} is at most half the pin`)
  const starved = runKyberCell(module, 'cord.run', input, CORD_ECHO_CELL, 100_000)
  assert.deepEqual([starved.ok, starved.source, starved.code], [false, 'host', 'FUEL'])
  assert.equal(Object.hasOwn(starved, 'result'), false)
})
