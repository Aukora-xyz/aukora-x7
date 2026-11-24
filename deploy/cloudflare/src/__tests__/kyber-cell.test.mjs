/**
 * The Kyber weight CPU cell on the edge, through the real Worker route (POST /_host/cell-run) with the real
 * cell bytes. The bundle hands the Worker a compiled module as the `.wasm` file's default export (wrangler's CompiledWasm
 * rule); Node is given exactly that shape by the module hook below, for exactly that one file, and nothing else.
 * Bindings are spies: the route must touch none of them. Local only: no network, no storage.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import test from 'node:test'

const CELL_FILE = new URL('../../../../apps/web/public/cells/kyber-cpu.wasm', import.meta.url)
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
const { CELL_RUN_ROUTE, KYBER_CELL, KYBER_CELL_EXPORTS, KYBER_CELL_SPECIFIER, admitKyberCellModule, loadKyberCell, runKyberCell } = await import('../kyber-cell.mjs')
const { COUNTDOWN_ROM, isaRun, kyberCheck } = await import('../../../../packages/experimental/webworker-runtime/tests/x6/kyber-isa.ts')

const ORIGIN = 'https://kyber-cell.example.invalid'
const OWNER = { type: 'owner', email: 'owner@example.invalid', expires: Math.floor(Date.now() / 1000) + 3600 }
const DOT_ROM = [260, 6, 0, 3, 260, 6, 101, 7] // the Kyber Kernel evidence's rom.json (as in tests/x6/kyber-cpu.spec.ts)
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

function fixture() {
  const touched = []
  const spy = name => new Proxy({}, { get(_target, property) { touched.push(`${name}.${String(property)}`); return () => { throw new Error(`${name} called`) } } })
  const env = { PUBLIC_HOST: new URL(ORIGIN).host, OWNER_EMAIL: OWNER.email, OWNER_PUBLIC_KEY_HEX: 'e'.repeat(64),
    HEAD: spy('HEAD'), MIRROR: spy('MIRROR'), VOICE_BRIDGE: spy('VOICE_BRIDGE'), ARCHIVE_BUCKET: spy('ARCHIVE_BUCKET'), ASSETS: spy('ASSETS') }
  let access = OWNER
  const worker = createWorker({ verifyAccess: async () => access, networkFetch: async () => { touched.push('network'); throw new Error('network') } })
  const call = async ({ path = CELL_RUN_ROUTE.path, method = 'POST', headers = {}, body, text } = {}) => {
    const init = { method, headers: Object.fromEntries(Object.entries({ origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', ...headers })
      .filter(([, value]) => value !== undefined)) }
    if (!['GET', 'HEAD'].includes(method)) init.body = text ?? JSON.stringify(body ?? {})
    const response = await worker.fetch(new Request(ORIGIN + path, init), env)
    return { status: response.status, body: await response.json() }
  }
  return { call, touched, setAccess: value => { access = value } }
}
const run = (op, input) => ({ cell: 'kyber-cpu', op, input })

test('the pin: the Worker imports the very file her browser fetches, and its bytes are CELL_PINS[kyber-cpu]', () => {
  const source = readFileSync(new URL('../kyber-cell.mjs', import.meta.url), 'utf8')
  const imports = [...source.matchAll(/\bimport\(\s*(['"])([^'"\n]+)\1\s*\)/g)].map(match => match[2])
  assert.deepEqual(imports, [KYBER_CELL_SPECIFIER], 'exactly one dynamic import, the pinned file')
  const file = new URL(KYBER_CELL_SPECIFIER, new URL('../kyber-cell.mjs', import.meta.url))
  assert.equal(file.href, CELL_FILE.href)
  assert.equal(file.pathname.endsWith('/apps/web/public/cells/kyber-cpu.wasm'), true, 'the file the browser fetches at /cells/kyber-cpu.wasm')
  const bytes = readFileSync(file)
  assert.deepEqual([bytes.byteLength, sha256(bytes)], [KYBER_CELL.bytes, KYBER_CELL.sha256])
  const pins = readFileSync(new URL('../../../../packages/experimental/webworker-runtime/src/x6/wasm-cells.ts', import.meta.url), 'utf8')
  const entry = pins.match(/'kyber-cpu': \{\n\s+sha256: '([0-9a-f]{64})', bytes: (\d+), fuel: (\d+),\n\s+ops: Object\.freeze\(\[([^\]]*)\]\)/)
  assert.ok(entry, 'kyber-cpu pin present')
  assert.deepEqual([entry[1], Number(entry[2]), Number(entry[3])], [KYBER_CELL.sha256, KYBER_CELL.bytes, KYBER_CELL.fuel])
  assert.deepEqual(entry[4].split(',').map(op => op.trim().replace(/'/g, '')), [...KYBER_CELL.ops])
  assert.deepEqual([...KYBER_CELL_EXPORTS], ['__mv_fuel_remaining', '__mv_fuel_set', 'memory', 'mv_abi_version', 'mv_alloc', 'mv_run'])
})

test('admission: only a compiled module with zero imports, the metered exports and a fixed 12-page memory', async () => {
  const kyber = await loadKyberCell()
  assert.equal(kyber.error, undefined)
  assert.equal(admitKyberCellModule(kyber.module).module, kyber.module)
  assert.deepEqual(loadedWasm, [CELL_FILE.href], 'the import loaded exactly the pinned file, once')
  assert.equal(admitKyberCellModule(readFileSync(CELL_FILE)).error, 'MODULE_UNAVAILABLE', 'bytes are not a module')
  assert.equal(admitKyberCellModule(undefined).error, 'MODULE_UNAVAILABLE')
  // Another pinned cell with the same exports but a one-page memory.
  const focus = new WebAssembly.Module(readFileSync(new URL('../../../../apps/web/public/cells/aura-focus.wasm', import.meta.url)))
  assert.equal(admitKyberCellModule(focus).error, 'MODULE_MEMORY_LIMIT')
  // A module with one import (an empty function type and one imported function).
  const imported = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 2, 7, 1, 1, 109, 1, 102, 0, 0]))
  assert.equal(admitKyberCellModule(imported).error, 'MODULE_IMPORTS')
  // Zero imports, no exports.
  assert.equal(admitKyberCellModule(new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]))).error, 'MODULE_EXPORTS')
})

test('the owner runs each op on the edge; the answer is the cell\'s plus host, pin and fuel; no binding is touched', async () => {
  const f = fixture()
  const state = { a: 0, b: 7, halted: 0, pc: 0 }
  const step = await f.call({ body: run('cpu.step', { rom: [...COUNTDOWN_ROM], state }) })
  assert.equal(step.status, 200)
  assert.deepEqual(Object.keys(step.body).sort(), ['cell', 'fuelUsed', 'host', 'ok', 'op', 'pin', 'result'])
  assert.deepEqual({ ...step.body, fuelUsed: 0 }, { ok: true, cell: 'kyber-cpu', op: 'cpu.step', result: { state: isaRun(state, COUNTDOWN_ROM, 1).state }, host: 'edge', pin: KYBER_CELL.sha256, fuelUsed: 0 })
  assert.ok(Number.isSafeInteger(step.body.fuelUsed) && step.body.fuelUsed > 0 && step.body.fuelUsed <= KYBER_CELL.fuel)
  const whole = await f.call({ body: run('cpu.run', { rom: [...COUNTDOWN_ROM], state, steps: 64 }) })
  assert.deepEqual(whole.body.result, isaRun(state, COUNTDOWN_ROM, 64))
  assert.deepEqual(whole.body.result, { halted: 1, state: { a: 7, b: 0, halted: 1, pc: 6 }, stepsTaken: 24 })
  // Every checkpoint the edge writes resumes, on the edge, to the uninterrupted end (countdown and the rom.json).
  let cuts = 0
  for (const rom of [[...COUNTDOWN_ROM], DOT_ROM]) {
    const start = { a: 3, b: 5, halted: 0, pc: 0 }
    const expected = isaRun(start, rom, 48)
    const marked = await f.call({ body: run('cpu.run', { rom, state: start, steps: 48, checkpointEvery: 1 }) })
    assert.equal(marked.body.result.checkpoints.length, expected.stepsTaken + 1)
    for (const checkpoint of marked.body.result.checkpoints) {
      assert.equal(checkpoint.check, kyberCheck(rom, checkpoint.state, 48, checkpoint.stepsTaken))
      const resumed = await f.call({ body: run('cpu.resume', { checkpoint }) })
      assert.deepEqual([resumed.status, resumed.body.result], [200, expected])
      cuts += 1
    }
  }
  assert.ok(cuts > 10)
  assert.deepEqual(f.touched, [], 'no binding and no network: no storage, no object, no lease, no receipt, no HEAD')
})

test('a checkpoint with one changed byte is refused with the cell\'s own refusal, never answered', async () => {
  const f = fixture()
  const marked = await f.call({ body: run('cpu.run', { rom: [...COUNTDOWN_ROM], state: { a: 0, b: 9, halted: 0, pc: 0 }, steps: 64, checkpointEvery: 3 }) })
  const cut = marked.body.result.checkpoints[2]
  const text = JSON.stringify(run('cpu.resume', { checkpoint: cut }))
  // Every digit of the checkpoint changed by one, one at a time (keys and punctuation stay valid JSON).
  const start = text.indexOf('"checkpoint"')
  let changed = 0
  const codes = new Set()
  for (let at = start; at < text.length; at += 1) {
    if (!/[0-9]/.test(text[at])) continue
    const edited = text.slice(0, at) + String((Number(text[at]) + 1) % 10) + text.slice(at + 1)
    try { JSON.parse(edited) } catch { continue } // a leading zero is not JSON: the route's 400, not a checkpoint
    const answer = await f.call({ text: edited })
    if (answer.status === 200) {
      // Only an edit that is still the same checkpoint may run (none exists: each field is in the check).
      assert.fail(`edit at ${at} answered: ${edited}`)
    }
    assert.deepEqual([answer.status, answer.body.source, answer.body.host, answer.body.pin], [422, 'cell', 'edge', KYBER_CELL.sha256], edited)
    codes.add(answer.body.code)
    changed += 1
  }
  assert.ok(changed > 10)
  assert.ok(codes.has('CHECKPOINT_INVALID'), [...codes].join())
  assert.ok([...codes].every(code => /^[A-Z_]{1,64}$/.test(code)))
  const flipped = { ...cut, check: (cut.check ^ 1) >>> 0 }
  const refused = await f.call({ body: run('cpu.resume', { checkpoint: flipped }) })
  assert.deepEqual([refused.status, refused.body.ok, refused.body.code, refused.body.source], [422, false, 'CHECKPOINT_INVALID', 'cell'])
  assert.equal(Object.hasOwn(refused.body, 'result'), false)
  assert.deepEqual(f.touched, [])
})

test('every route check, by name, before anything runs', async () => {
  const f = fixture()
  const good = run('cpu.step', { rom: [...COUNTDOWN_ROM], state: { a: 0, b: 1, halted: 0, pc: 0 } })
  const cases = [
    ['query', { path: `${CELL_RUN_ROUTE.path}?x=1`, body: good }, 404, 'NOT_FOUND'],
    ['wrong method GET', { method: 'GET' }, 405, 'METHOD_UNAVAILABLE'],
    ['wrong method PUT', { method: 'PUT', body: good }, 405, 'METHOD_UNAVAILABLE'],
    ['cross-site', { headers: { 'sec-fetch-site': 'cross-site' }, body: good }, 403, 'CROSS_SITE_REFUSED'],
    ['another origin', { headers: { origin: 'https://other.example.invalid' }, body: good }, 403, 'ORIGIN_REFUSED'],
    ['no Origin', { headers: { origin: undefined }, body: good }, 403, 'SAME_ORIGIN_BROWSER_REQUIRED'],
    ['same-site', { headers: { 'sec-fetch-site': 'same-site' }, body: good }, 403, 'SAME_ORIGIN_BROWSER_REQUIRED'],
    ['no fetch metadata', { headers: { 'sec-fetch-site': undefined }, body: good }, 403, 'SAME_ORIGIN_BROWSER_REQUIRED'],
    ['wrong media type', { headers: { 'content-type': 'text/plain' }, body: good }, 415, 'CELL_RUN_MEDIA_TYPE'],
    ['no media type', { headers: { 'content-type': undefined }, body: good }, 415, 'CELL_RUN_MEDIA_TYPE'],
    ['too large', { text: JSON.stringify({ ...good, input: { ...good.input, pad: 'x'.repeat(CELL_RUN_ROUTE.maxBytes) } }) }, 413, 'CELL_RUN_TOO_LARGE'],
    ['too large, declared', { headers: { 'content-length': String(CELL_RUN_ROUTE.maxBytes + 1) }, body: good }, 413, 'CELL_RUN_TOO_LARGE'],
    ['not JSON', { text: '{"cell":' }, 400, 'CELL_RUN_REQUEST_INVALID'],
    ['an array', { text: '[]' }, 400, 'CELL_RUN_REQUEST_INVALID'],
    ['extra key', { body: { ...good, fuel: 1 } }, 400, 'CELL_RUN_REQUEST_INVALID'],
    ['missing key', { body: { cell: good.cell, op: good.op } }, 400, 'CELL_RUN_REQUEST_INVALID'],
    ['input not an object', { body: { ...good, input: [1] } }, 400, 'CELL_RUN_REQUEST_INVALID'],
    ['another cell', { body: { ...good, cell: 'nucleus' } }, 400, 'CELL_RUN_CELL_REFUSED'],
    ['another cell, same ops', { body: { ...good, cell: 'kyber-cpu ' } }, 400, 'CELL_RUN_CELL_REFUSED'],
    ['another op', { body: { ...good, op: 'reflex.run' } }, 400, 'CELL_RUN_OP_REFUSED'],
    ['another op, near', { body: { ...good, op: 'cpu.halt' } }, 400, 'CELL_RUN_OP_REFUSED'],
  ]
  for (const [name, request, status, code] of cases) {
    const answer = await f.call(request)
    assert.deepEqual([answer.status, answer.body.code], [status, code], name)
    assert.equal(Object.hasOwn(answer.body, 'result'), false, name)
  }
  // No owner: no session at all is 401 before the route; a non-owner session is the route's own 403.
  f.setAccess(null)
  assert.deepEqual(Object.values(await f.call({ body: good })).map(value => value.code ?? value), [401, 'OWNER_ACCESS_REQUIRED'])
  f.setAccess({ type: 'access', email: 'guest@example.invalid', expires: OWNER.expires })
  assert.deepEqual(Object.values(await f.call({ body: good })).map(value => value.code ?? value), [403, 'OWNER_ACCESS_REQUIRED'])
  // The ORDER is depended on (review of tools1, 2026-11-14): her x6_tools mount proves the owner's session by sending an empty
  // text/plain POST here and reading 415 CELL_RUN_MEDIA_TYPE as "this session is the owner" (ball-loader.ts, the tool registry
  // ownerSession). So a session that is not the owner must be refused BEFORE the media type is judged, and no session at all
  // before that. If the media-type check ever moves above the owner check, a guest would pass her OWNER_REQUIRED gate.
  const wrongType = { headers: { 'content-type': 'text/plain' }, text: '' }
  assert.deepEqual(Object.values(await f.call(wrongType)).map(value => value.code ?? value), [403, 'OWNER_ACCESS_REQUIRED'])
  f.setAccess(null)
  assert.deepEqual(Object.values(await f.call(wrongType)).map(value => value.code ?? value), [401, 'OWNER_ACCESS_REQUIRED'])
  f.setAccess(OWNER)
  assert.deepEqual(Object.values(await f.call(wrongType)).map(value => value.code ?? value), [415, 'CELL_RUN_MEDIA_TYPE'])
  f.setAccess(OWNER)
  assert.equal((await f.call({ body: good })).status, 200, 'the same request from the owner runs')
  assert.deepEqual(f.touched, [])
})

test('the runner: a float input is unrepresentable, a missing field is the cell\'s own refusal, fuel is the pinned grant', async () => {
  const { module } = await loadKyberCell()
  assert.deepEqual(runKyberCell(module, 'cpu.step', { rom: [0.5], state: {} }), { ok: false, source: 'host', code: 'UNREPRESENTABLE', fuelUsed: null })
  const shape = runKyberCell(module, 'cpu.run', { rom: [...COUNTDOWN_ROM] })
  assert.deepEqual([shape.ok, shape.source, shape.code], [false, 'cell', 'MALFORMED'])
  // The worst call fits the pinned grant, as in her browser: 4,096 steps of a program that never halts, a checkpoint at each.
  const worst = runKyberCell(module, 'cpu.run', { checkpointEvery: 1, rom: [1023, 1023, 1023, 1023, 1023, 1023, 1023, 1023], state: { a: 15, b: 15, halted: 0, pc: 7 }, steps: 4096 })
  assert.equal(worst.ok, true)
  assert.equal(worst.result.checkpoints.length, 4097)
  assert.ok(worst.fuelUsed < KYBER_CELL.fuel)
})
