/**
 * `x6_skill`, a skill she keeps, checks and runs, whose
 * behaviour is the cell's and not the model's.
 *  - the shipped countdown lists (verified), checks (all 16 cases agree when run again through the cell) and runs;
 *  - a record whose evidence differs from what the cell answers: `check` names the case, and repairs nothing;
 *  - `keep` never takes a claimed answer: the cell computes each case, and a later `check` agrees; it survives a reload;
 *  - a skill on a FORGED cell runs through run_forged's whole rebuild-and-admit path, and survives a reload;
 *  - every cap and closed code; look-only voice refuses the tool; the classifications; the write-set inventory lists the
 *    new writer; `x6_self_state` `skills`; organs never get `verifiedBytes`; the shipped files' build script is current.
 * Local only: real pinned cell bytes and the real shipped skill files from apps/web/public/cells, Node worker_threads, the
 * e4 fixture's `.invalid` origin.
 */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { Worker } from 'node:worker_threads'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryVfs } from '../../src/storage/memory.ts'
import { classifyActionIrreversibility, FORGED_CELLS_DIR, SKILL_INDEX_PATH, SKILLS_DIR, SKILLS_MAX, SKILLS_STORE_MAX_BYTES } from '../../src/x6/ball-loader.ts'
import { classifyToolMutation } from '../../src/x6/capability-index.ts'
import { projectSelfState, SELF_STATE_RESULT_BYTES, type SelfStateRegistry } from '../../src/x6/self-state.ts'
import { artifactDigest, canonicalBytes, encodeSkill, skillId, SKILL_MAX_CASES, type SkillRecord } from '../../src/x6/skill-record.ts'
import { VOICE_REFUSED_TOOLS, voiceVerdict } from '../../src/x6/voice-read-only.ts'
import * as wasmCells from '../../src/x6/wasm-cells.ts'
import { CELL_PINS, cellCanonicalJson, createCellHost, organCellHost, type CellHost, type CellWorker } from '../../src/x6/wasm-cells.ts'
import { classifyWritePath, liveWriteSet, RUNTIME_WRITE_SET } from '../../src/x6/write-set-inventory.ts'
import { FakeSocket, mountE4 } from './e4-fixture.ts'
import { isaRun, OP, word, type KyberRun } from './kyber-isa.ts'
// @ts-expect-error The build script is plain ESM without declarations; only its exports are read here.
import * as untypedBuild from '../../../../../server/kyber-skills.build.mjs'

/** The two exports this spec reads, as server/kyber-skills.build.mjs defines them. */
interface SkillsBuild {
  readonly buildKyberSkills: () => Promise<Array<{ path: string; bytes: Uint8Array; id: string | null }>>
  readonly checkKyberSkills: (readShipped?: (path: string) => Uint8Array) => Promise<Array<{ path: string; current: boolean }>>
}
const { buildKyberSkills, checkKyberSkills } = untypedBuild as SkillsBuild

type J = Record<string, unknown>
const REPO = new URL('../../../../../', import.meta.url)
const CELLS = new URL('apps/web/public/cells/', REPO)
const ORIGIN = 'https://lane-e4-fixture.invalid'
const sha = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex')
/** The shipped cord-echo record's id and its list row (server/kyber-skills.build.mjs). */
const CORD_ECHO_ID = '9aaa33f31231817afe657eb346bd1a6f1410fe8afdf55f042799676d2b213368'
const CORD_ECHO_ROW = { id: CORD_ECHO_ID, name: 'cord-echo', cell: { kind: 'pinned', name: 'cord-echo' }, cases: 3, source: 'shipped', verified: true }
/** The shipped countdown's id (server/kyber-skills.build.mjs; also pinned in kyber-cpu.spec.ts). */
const COUNTDOWN_ID = '1205ded1b88bba84abc4fd171529b7ae2fc35e1cd8890f68651e745d8e1fcada'
const COUNTDOWN_ROM = [5, 388, 6, 3, 0, 388, 6, 6]
/** A second small program: a = a + b, then halt. */
const ADD_ROM = [word(OP.ADD01), word(OP.HALT), word(OP.HALT), word(OP.HALT), word(OP.HALT), word(OP.HALT), word(OP.HALT), word(OP.HALT)]
const kyberState = (a: number, b: number) => ({ a, b, halted: 0, pc: 0 })
const ADD_CASES = [{ state: kyberState(2, 3), steps: 8 }, { state: kyberState(9, 9), steps: 8 }, { state: kyberState(15, 0), steps: 8 }]

/** Files served under /cells/ (real ones by default; a test may replace any path with its own bytes, or null for a 404). */
type CellOverrides = Record<string, Uint8Array | null>
const cellFiles = (overrides: CellOverrides = {}) => async (path: string): Promise<Response | null> => {
  if (!path.startsWith('/cells/')) return null
  const rel = path.slice('/cells/'.length)
  if (Object.hasOwn(overrides, rel)) {
    const bytes = overrides[rel]
    return bytes === null || bytes === undefined ? new Response('no', { status: 404 }) : new Response(Uint8Array.from(bytes))
  }
  try { return new Response(Uint8Array.from(await readFile(new URL(rel, CELLS)))) } catch { return new Response('no', { status: 404 }) }
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
/** A real cell host over the shipped cells (a test may serve other bytes for one cell). */
const testHost = (overrides: Record<string, Uint8Array> = {}): CellHost => {
  const serve = cellFiles(overrides)
  const host = createCellHost({ origin: ORIGIN, createWorker: nodeCellWorker, now: () => 0,
    fetchImpl: async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
      return url.origin === ORIGIN ? await serve(url.pathname) ?? new Response('no', { status: 404 }) : new Response('no', { status: 404 })
    } })
  hosts.add(host)
  return host
}
afterEach(async () => {
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

/** Mount her runtime over `vfs` with `host` as this worker's cell host; the page serves /cells/ (with overrides). */
async function mount(host: CellHost, vfs = new MemoryVfs(), overrides: CellOverrides = {}) {
  vi.spyOn(wasmCells, 'workerCellHost').mockReturnValue(host)
  const serve = cellFiles(overrides)
  const m = await mountE4({ vfs, respond: async call => call.method === 'GET' && call.path === '/api/build'
    ? Response.json({ ok: true, schema: 'aukora.edge-build.v1', sourceRevision: null })
    : call.method === 'GET' ? await serve(call.path) : null })
  return { m, vfs, skill: m.tool('x6_skill'), cell: m.tool('x6_cell') }
}
const reload = async (vfs: MemoryVfs, overrides: CellOverrides = {}) => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  return await mount(testHost(), vfs, overrides)
}
const keptFiles = (vfs: MemoryVfs): string[] => {
  const out: string[] = []
  const walk = (dir: string) => {
    if (!vfs.existsSync(dir)) return
    for (const name of [...vfs.readdirSync(dir)].map(String).sort()) {
      const path = `${dir}/${name}`
      if (vfs.statSync(path).isDirectory()) walk(path)
      else out.push(path.slice(SKILLS_DIR.length + 1))
    }
  }
  walk(SKILLS_DIR)
  return out
}

describe('the shipped countdown: list, check, run', () => {
  it('lists it verified, checks all 16 cases again through the cell, and runs a new input', async () => {
    const { m, skill } = await mount(testHost())
    const listed = await skill.execute({ action: 'list' }) as J
    expect(listed).toEqual({ ok: true, count: 2, skills: [{ id: COUNTDOWN_ID, name: 'countdown', cell: { kind: 'pinned', name: 'kyber-cpu' },
      cases: 16, source: 'shipped', verified: true }, CORD_ECHO_ROW] })
    // The shipped cord-echo record's three cord.run cases from genesis agree with the pinned cell, byte for byte.
    expect(await skill.execute({ action: 'check', skill: 'cord-echo' })).toMatchObject({ ok: true, id: CORD_ECHO_ID, name: 'cord-echo', verified: true,
      cases: { total: 3, agree: 3, differ: [] } })
    const checked = await skill.execute({ action: 'check', skill: 'countdown' }) as J
    expect(checked).toMatchObject({ ok: true, id: COUNTDOWN_ID, name: 'countdown', verified: true,
      cases: { total: 16, agree: 16, differ: [] } })
    // The figure docs/auma/skills.md quotes: the cell's own fuel over the 16 cases.
    expect(checked.fuelUsed).toBe(15_181_553)
    // By id too.
    expect(await skill.execute({ action: 'check', skill: COUNTDOWN_ID })).toMatchObject({ ok: true, cases: { agree: 16 } })
    const ran = await skill.execute({ action: 'run', skill: 'countdown', input: { state: kyberState(0, 7), steps: 64 } }) as J
    expect(ran).toMatchObject({ ok: true, cell: 'kyber-cpu', op: 'cpu.run', result: { halted: 1, state: { a: 7, b: 0, halted: 1, pc: 6 }, stepsTaken: 24 },
      skill: { id: COUNTDOWN_ID, name: 'countdown' } })
    expect(ran.result).toEqual(isaRun(kyberState(0, 7), COUNTDOWN_ROM, 64))
    // The program is the skill's: an input that names it is refused, and nothing runs.
    expect(await skill.execute({ action: 'run', skill: 'countdown', input: { rom: ADD_ROM, state: kyberState(0, 7), steps: 64 } }))
      .toMatchObject({ ok: false, code: 'SKILL_INPUT_INVALID', program: ['rom'] })
    // Every call it made was a journal line labelled as her tool's; nothing left her origin but /cells/ reads.
    const journal = await m.tool('x6_cell').execute({ action: 'journal' }) as { lines: J[] }
    expect(journal.lines.every(line => line.cell === 'kyber-cpu' && line.caller === 'x6_cell')).toBe(true)
    expect(m.calls.filter(call => !call.path.startsWith('/cells/kyber/') && !call.path.startsWith('/_head/') && call.path !== '/api/build')).toEqual([])
  }, 60_000)

  it('check verifies against the bytes the cell host admitted: a cell served off its pin is SKILL_CELL_UNAVAILABLE', async () => {
    const real = new Uint8Array(await readFile(new URL('kyber-cpu.wasm', CELLS)))
    const changed = Uint8Array.from(real)
    changed[4000] = (changed[4000] ?? 0) ^ 1
    const { skill } = await mount(testHost({ 'kyber-cpu.wasm': changed }))
    expect(await skill.execute({ action: 'check', skill: 'countdown' })).toMatchObject({ ok: false, verified: false, code: 'SKILL_CELL_UNAVAILABLE' })
    expect(await skill.execute({ action: 'run', skill: 'countdown', input: { state: kyberState(0, 1), steps: 8 } })).toMatchObject({ ok: false, code: 'SKILL_CELL_UNAVAILABLE' })
    expect((await skill.execute({ action: 'list' }) as { skills: J[] }).skills[0]).toMatchObject({ verified: false, code: 'SKILL_CELL_UNAVAILABLE' })
  }, 60_000)

  it('a record with one evidence answer changed: check names the case that differs and repairs nothing', async () => {
    const shipped = new Uint8Array(await readFile(new URL('kyber/skills/countdown.json', CELLS)))
    const record = JSON.parse(new TextDecoder().decode(shipped)) as SkillRecord
    const cases = record.evidence.cases.map((entry, index) => index !== 3 ? entry
      : { ...entry, output: { ...(entry.output as KyberRun), stepsTaken: (entry.output as KyberRun).stepsTaken + 1 } })
    const bytes = encodeSkill({ ...record, evidence: { ...record.evidence, cases } })
    const id = await skillId(bytes)
    const index = canonicalBytes({ schema: 'aukora.skill-index.v1', skills: [{ id, name: 'countdown', program: 'kyber/skills/countdown.rom.json',
      record: 'kyber/skills/changed.json', weights: 'kyber/cpu-weights.json' }] })
    const overrides = { 'kyber/skills/index.json': index, 'kyber/skills/changed.json': bytes }
    const { skill } = await mount(testHost(), new MemoryVfs(), overrides)
    const checked = await skill.execute({ action: 'check', skill: 'countdown' }) as J
    expect(checked).toMatchObject({ ok: false, id, verified: true, cases: { total: 16, agree: 15, differ: [3] }, code: 'SKILL_CASES_DIFFER' })
    // The index naming the wrong id for the record is refused under that id, before anything runs.
    const wrong = canonicalBytes({ schema: 'aukora.skill-index.v1', skills: [{ id: COUNTDOWN_ID, name: 'countdown',
      program: 'kyber/skills/countdown.rom.json', record: 'kyber/skills/changed.json', weights: 'kyber/cpu-weights.json' }] })
    const second = await reload(new MemoryVfs(), { ...overrides, 'kyber/skills/index.json': wrong })
    expect(await second.skill.execute({ action: 'check', skill: 'countdown' })).toMatchObject({ ok: false, verified: false, code: 'SKILL_ID_MISMATCH' })
  }, 60_000)
})

describe('keep: the cell computes every answer, and it survives a reload', () => {
  it('keeps what the cell answered (never a claimed answer), checks it, runs it, and lists it after a reload', async () => {
    const first = await mount(testHost())
    const keep = { action: 'keep', name: 'add-ab', cell: 'kyber-cpu', program: { rom: ADD_ROM }, cases: ADD_CASES }
    const kept = await first.skill.execute(keep) as J
    const oracle = ADD_CASES.map(entry => isaRun(entry.state, ADD_ROM, entry.steps))
    expect(kept).toMatchObject({ ok: true, kept: 'new', name: 'add-ab', cell: { kind: 'pinned', name: 'kyber-cpu', sha256: CELL_PINS['kyber-cpu']!.sha256 },
      op: 'cpu.run', cases: 3, answers: oracle })
    const id = kept.id as string
    // The id docs/auma/skills.md quotes for this exact keep.
    expect(id).toBe('5dd36896bf1426eec9d16ff1fbe6e66757be3cafe887522bc1dd473c21055811')
    expect(kept.path).toBe(`${SKILLS_DIR}/${id}.json`)
    // The stored record: canonical bytes, its id, the cell as its oracle, each case's full input and the cell's answer.
    const bytes = first.vfs.readFileSync(`${SKILLS_DIR}/${id}.json`) as Uint8Array
    expect(sha(Buffer.concat([Buffer.from('aukora.skill.v1\n'), Buffer.from(bytes)]))).toBe(id)
    const record = JSON.parse(new TextDecoder().decode(bytes)) as SkillRecord
    expect(new TextDecoder().decode(bytes)).toBe(cellCanonicalJson(record))
    expect(record).toEqual({ schema: 'aukora.skill.v1', name: 'add-ab', op: 'cpu.run',
      cell: { kind: 'pinned', name: 'kyber-cpu', sha256: CELL_PINS['kyber-cpu']!.sha256, abi: 1, ops: ['cpu.step', 'cpu.run', 'cpu.resume'] },
      program: { digest: sha(`{"rom":[${ADD_ROM.join(',')}]}`) }, weights: null, state: { schema: 'aukora.kyber-cpu.state.v1' },
      evidence: { oracle: 'cell', cases: ADD_CASES.map((input, index) => ({ op: 'cpu.run', input: { rom: ADD_ROM, ...input }, output: oracle[index] })) } })
    expect(keptFiles(first.vfs)).toEqual([`${id}.json`, `programs/${record.program.digest}.json`])
    // A claimed answer is not an input: a case that carries `output` is just an input the cell refuses.
    expect(await first.skill.execute({ ...keep, name: 'claims', cases: [{ ...ADD_CASES[0], output: { a: 99 } }] }))
      .toMatchObject({ ok: false, code: 'SKILL_CASE_REFUSED', index: 0 })
    expect(await first.skill.execute({ action: 'check', skill: 'add-ab' })).toMatchObject({ ok: true, id, verified: true, cases: { total: 3, agree: 3, differ: [] } })
    expect(await first.skill.execute({ action: 'run', skill: 'add-ab', input: { state: kyberState(4, 5), steps: 8 } }))
      .toMatchObject({ ok: true, result: { state: { a: 9, b: 5 } }, skill: { id, name: 'add-ab' } })
    // The same keep again is kept already.
    expect(await first.skill.execute(keep)).toEqual({ ok: true, kept: 'already', id, name: 'add-ab' })

    const second = await reload(first.vfs)
    const listed = await second.skill.execute({ action: 'list' }) as { skills: J[] }
    expect(listed.skills).toEqual([
      { id: COUNTDOWN_ID, name: 'countdown', cell: { kind: 'pinned', name: 'kyber-cpu' }, cases: 16, source: 'shipped', verified: true },
      CORD_ECHO_ROW,
      { id, name: 'add-ab', cell: { kind: 'pinned', name: 'kyber-cpu' }, cases: 3, source: 'kept', verified: true },
    ])
    expect(await second.skill.execute({ action: 'check', skill: id })).toMatchObject({ ok: true, cases: { agree: 3 } })
    // A changed kept file is refused under its id; nothing is repaired.
    const flipped = Uint8Array.from(bytes)
    flipped[10] = (flipped[10] ?? 0) ^ 1
    second.vfs.writeFileSync(`${SKILLS_DIR}/${id}.json`, flipped)
    expect(await second.skill.execute({ action: 'check', skill: id })).toMatchObject({ ok: false, verified: false, code: 'SKILL_ID_MISMATCH' })
    second.vfs.writeFileSync(`${SKILLS_DIR}/${id}.json`, bytes)
    second.vfs.unlinkSync(`${SKILLS_DIR}/programs/${record.program.digest}.json`)
    expect(await second.skill.execute({ action: 'check', skill: id })).toMatchObject({ ok: false, code: 'SKILL_PROGRAM_MISSING' })
    // forget removes the record and the program it alone named; a shipped skill is not hers to forget.
    second.vfs.writeFileSync(`${SKILLS_DIR}/programs/${record.program.digest}.json`, canonicalBytes({ rom: ADD_ROM }))
    expect(await second.skill.execute({ action: 'forget', skill: 'add-ab' })).toEqual({ ok: true, forgot: { id, name: 'add-ab' } })
    expect(keptFiles(second.vfs)).toEqual([])
    expect(await second.skill.execute({ action: 'forget', skill: 'countdown' })).toMatchObject({ ok: false, code: 'SKILL_UNKNOWN' })
    expect(await second.skill.execute({ action: 'check', skill: 'add-ab' })).toMatchObject({ ok: false, code: 'SKILL_UNKNOWN' })
  }, 60_000)

  it('a skill on a FORGED cell: kept, checked, run, and checked again after a reload, always through run_forged', async () => {
    const adder = await readFile(new URL('docs/auma/cells/adder.wat', REPO), 'utf8')
    const first = await mount(testHost())
    const forged = await first.cell.execute({ action: 'forge', wat: adder, name: 'adder' }) as J
    const cell = forged.cell as J
    const keep = { action: 'keep', name: 'add-two', cell: 'adder', op: 'add', program: { a: 2 }, cases: [{ b: 3 }, { b: 40 }, { b: -9 }] }
    const kept = await first.skill.execute(keep) as J
    expect(kept).toMatchObject({ ok: true, kept: 'new', cell: { kind: 'forged', name: 'adder', sha256: cell.sha256 }, op: 'add',
      answers: [{ sum: 5 }, { sum: 42 }, { sum: -7 }] })
    const record = JSON.parse(new TextDecoder().decode(first.vfs.readFileSync(`${SKILLS_DIR}/${kept.id as string}.json`) as Uint8Array)) as SkillRecord
    expect(record.cell).toEqual({ kind: 'forged', name: 'adder', sha256: cell.sha256, watSha256: sha(adder), abi: 1, ops: ['add'] })
    expect(record.state).toEqual({ schema: 'aukora.cell-abi.v1' })
    const journalBefore = (await first.cell.execute({ action: 'journal' }) as { totals: { calls: number } }).totals.calls
    expect(await first.skill.execute({ action: 'check', skill: 'add-two' })).toMatchObject({ ok: true, verified: true, cases: { total: 3, agree: 3, differ: [] } })
    // Every case ran through run_forged: a rebuild (skillsmith build + meter) and one forged:adder line each.
    const journal = await first.cell.execute({ action: 'journal' }) as { totals: { calls: number }; lines: J[] }
    expect(journal.totals.calls - journalBefore).toBe(9)
    expect(journal.lines.slice(0, 9).map(line => line.cell)).toEqual(['forged:adder', 'skillsmith', 'skillsmith', 'forged:adder', 'skillsmith',
      'skillsmith', 'forged:adder', 'skillsmith', 'skillsmith'])
    expect(await first.skill.execute({ action: 'run', skill: 'add-two', input: { b: 100 } })).toMatchObject({ ok: true, result: { sum: 102 } })

    const second = await reload(first.vfs)
    expect(await second.skill.execute({ action: 'check', skill: 'add-two' })).toMatchObject({ ok: true, cases: { agree: 3 } })
    // Her WAT changed on disk: the cell is no longer the one the skill names; nothing runs.
    const watPath = `${FORGED_CELLS_DIR}/${cell.sha256 as string}.wat`
    second.vfs.writeFileSync(watPath, `${adder};; edited`)
    expect(await second.skill.execute({ action: 'check', skill: 'add-two' })).toMatchObject({ ok: false, verified: false, code: 'SKILL_CELL_MISMATCH' })
    second.vfs.writeFileSync(watPath, adder)
    // The forged cell forgotten: the skill names a cell she no longer keeps.
    expect(await second.cell.execute({ action: 'forget', cell: 'adder' })).toMatchObject({ ok: true })
    expect(await second.skill.execute({ action: 'check', skill: 'add-two' })).toMatchObject({ ok: false, code: 'SKILL_CELL_MISSING' })
    expect(await second.skill.execute({ action: 'run', skill: 'add-two', input: { b: 1 } })).toMatchObject({ ok: false, code: 'SKILL_CELL_MISSING' })
  }, 60_000)
})

describe('caps and closed codes', () => {
  it('names, cases, programs, cells, ops, inputs, the shipped name, a taken name, the record size and the count', async () => {
    const { skill, cell, vfs } = await mount(testHost())
    const base = { action: 'keep', name: 'add-ab', cell: 'kyber-cpu', program: { rom: ADD_ROM }, cases: ADD_CASES }
    for (const name of ['', 'Add', '1add', 'a'.repeat(33), 'add_ab']) expect(await skill.execute({ ...base, name })).toEqual({ ok: false, code: 'SKILL_NAME_INVALID' })
    expect(await skill.execute({ ...base, name: 'a'.repeat(32) })).toMatchObject({ ok: true })
    expect(await skill.execute({ ...base, cases: [] })).toEqual({ ok: false, code: 'SKILL_CASES_LIMIT', max: SKILL_MAX_CASES })
    expect(await skill.execute({ ...base, cases: Array.from({ length: 65 }, () => ADD_CASES[0]) })).toEqual({ ok: false, code: 'SKILL_CASES_LIMIT', max: 64 })
    expect(await skill.execute({ ...base, cases: 'x' })).toMatchObject({ code: 'SKILL_CASES_LIMIT' })
    for (const program of [[1, 2], 'rom', null, { rom: [1, 2] }, { rom: [...ADD_ROM.slice(0, 7), 1024] }, { rom: ADD_ROM, extra: 1 }, { rom: [0.5, 6, 6, 6, 6, 6, 6, 6] }]) {
      expect([program, await skill.execute({ ...base, program })]).toEqual([program, { ok: false, code: 'SKILL_PROGRAM_INVALID' }])
    }
    expect(await skill.execute({ ...base, cell: 'no-such-cell' })).toMatchObject({ ok: false, code: 'SKILL_CELL_UNKNOWN' })
    expect(await skill.execute({ ...base, op: 'cpu.nope' })).toMatchObject({ ok: false, code: 'SKILL_OP_INVALID', ops: ['cpu.step', 'cpu.run', 'cpu.resume'] })
    expect(await skill.execute({ ...base, op: 'NOT AN OP' })).toMatchObject({ ok: false, code: 'SKILL_OP_INVALID' })
    expect(await skill.execute({ ...base, cases: [ADD_CASES[0], { ...ADD_CASES[1], rom: ADD_ROM }] })).toMatchObject({ ok: false, code: 'SKILL_CASE_INVALID', index: 1 })
    expect(await skill.execute({ ...base, cases: [ADD_CASES[0], 7] })).toMatchObject({ ok: false, code: 'SKILL_CASE_INVALID', index: 1 })
    expect(await skill.execute({ ...base, cases: [{ state: kyberState(0, 0), steps: 99_999 }] })).toMatchObject({ ok: false, code: 'SKILL_CASE_REFUSED', index: 0 })
    expect(await skill.execute({ ...base, state: 'Bad State' })).toEqual({ ok: false, code: 'SKILL_STATE_INVALID' })
    expect(await skill.execute({ ...base, weights: 'heavy' })).toEqual({ ok: false, code: 'SKILL_WEIGHTS_INVALID' })
    expect(await skill.execute({ ...base, weights: { schema: 'other', nodes: [] } })).toMatchObject({ ok: false, code: 'SKILL_WEIGHTS_INVALID' })
    expect(await skill.execute({ ...base, name: 'countdown' })).toMatchObject({ ok: false, code: 'SKILL_NAME_SHIPPED' })
    const kept = await skill.execute(base) as J
    expect(kept).toMatchObject({ ok: true, kept: 'new' })
    expect(await skill.execute({ ...base, cases: ADD_CASES.slice(0, 2) })).toMatchObject({ ok: false, code: 'SKILL_NAME_TAKEN', id: kept.id })
    expect(await skill.execute({ action: 'check', skill: 'nothing' })).toEqual({ ok: false, code: 'SKILL_UNKNOWN', skill: 'nothing' })
    expect(await skill.execute({ action: 'check' })).toEqual({ ok: false, code: 'SKILL_UNKNOWN', skill: null })
    expect(await skill.execute({ action: 'forget', skill: 'nothing' })).toEqual({ ok: false, code: 'SKILL_UNKNOWN', skill: 'nothing' })
    expect(await skill.execute({ action: 'teach' })).toEqual({ ok: false, code: 'SKILL_ACTION_INVALID' })
    // The record cap: 64 cases whose inputs carry padding the adder ignores.
    const adder = await readFile(new URL('docs/auma/cells/adder.wat', REPO), 'utf8')
    expect(await cell.execute({ action: 'forge', wat: adder, name: 'adder' })).toMatchObject({ ok: true })
    // A record may be 256 KiB (was 64 KiB): about 100 KiB is kept, about 268 KiB is refused.
    const roomy = Array.from({ length: 64 }, (_v, n) => ({ b: n, pad: 'x'.repeat(1600) }))
    expect(await skill.execute({ action: 'keep', name: 'roomy', cell: 'adder', op: 'add', program: { a: 1 }, cases: roomy }))
      .toMatchObject({ ok: true, kept: 'new' })
    const padded = Array.from({ length: 64 }, (_v, n) => ({ b: n, pad: 'x'.repeat(4200) }))
    expect(await skill.execute({ action: 'keep', name: 'too-big', cell: 'adder', op: 'add', program: { a: 1 }, cases: padded }))
      .toMatchObject({ ok: false, code: 'SKILL_RECORD_LIMIT', max: 262_144 })
    // The count: at 256 kept (was 64), a new one is SKILL_FULL (an existing id is still kept already).
    expect(SKILLS_MAX).toBe(256)
    for (let n = keptCount(vfs); n < SKILLS_MAX; n += 1) vfs.writeFileSync(`${SKILLS_DIR}/${sha(`filler-${String(n)}`)}.json`, '{}')
    expect(await skill.execute({ ...base, name: 'one-more' })).toEqual({ ok: false, code: 'SKILL_FULL', count: 256, max: 256, next: 'forget one kept skill first' })
    expect(await skill.execute(base)).toMatchObject({ ok: true, kept: 'already' })
    // A filler that is not a record lists as unverified, and is never run.
    const listed = await skill.execute({ action: 'list' }) as { skills: J[] }
    expect(listed.skills.filter(row => row.source === 'kept' && row.verified === false).length).toBe(SKILLS_MAX - 3)
  }, 120_000)
  it('the codes no other test reaches: an unreadable or invalid index, two kept files under one name, a store that fails, evidence about another program, a pinned cell that is not the one named', async () => {
    const shipped = new Uint8Array(await readFile(new URL('kyber/skills/countdown.json', CELLS)))
    const countdown = JSON.parse(new TextDecoder().decode(shipped)) as SkillRecord
    const indexOf = async (bytes: Uint8Array, name = 'countdown') => canonicalBytes({ schema: 'aukora.skill-index.v1', skills: [{
      id: await skillId(bytes), name, program: 'kyber/skills/countdown.rom.json', record: 'kyber/skills/edited.json', weights: 'kyber/cpu-weights.json' }] })

    // SKILL_INDEX_UNAVAILABLE: the index is missing (404), or not canonical JSON. Her kept skills still list.
    const missing = await mount(testHost(), new MemoryVfs(), { 'kyber/skills/index.json': null })
    expect(await missing.skill.execute({ action: 'list' })).toEqual({ ok: true, count: 0, skills: [], shipped: { ok: false, code: 'SKILL_INDEX_UNAVAILABLE' } })
    expect(await missing.skill.execute({ action: 'check', skill: 'countdown' })).toEqual({ ok: false, code: 'SKILL_UNKNOWN', skill: 'countdown' })
    const garbled = await reload(new MemoryVfs(), { 'kyber/skills/index.json': new TextEncoder().encode('{"skills": [') })
    expect(await garbled.skill.execute({ action: 'list' })).toMatchObject({ count: 0, shipped: { ok: false, code: 'SKILL_INDEX_UNAVAILABLE' } })
    // SKILL_INDEX_INVALID: another schema, or an entry whose path leaves /cells/kyber/.
    const otherSchema = canonicalBytes({ schema: 'aukora.skill-index.v0', skills: [] })
    expect(await (await reload(new MemoryVfs(), { 'kyber/skills/index.json': otherSchema })).skill.execute({ action: 'list' }))
      .toMatchObject({ count: 0, shipped: { ok: false, code: 'SKILL_INDEX_INVALID' } })
    const escapes = canonicalBytes({ schema: 'aukora.skill-index.v1', skills: [{ id: COUNTDOWN_ID, name: 'countdown',
      program: 'kyber/skills/countdown.rom.json', record: 'kyber/../../api/head.json', weights: null }] })
    expect(await (await reload(new MemoryVfs(), { 'kyber/skills/index.json': escapes })).skill.execute({ action: 'list' }))
      .toMatchObject({ count: 0, shipped: { ok: false, code: 'SKILL_INDEX_INVALID' } })

    // SKILL_EVIDENCE_MISMATCH through the tool: a case whose input runs another ROM is not evidence about this program.
    const otherRomCases = countdown.evidence.cases.map((entry, index) => index !== 2 ? entry
      : { ...entry, input: { ...(entry.input as J), rom: ADD_ROM } })
    const aboutOther = encodeSkill({ ...countdown, evidence: { ...countdown.evidence, cases: otherRomCases } })
    const evidence = await reload(new MemoryVfs(), { 'kyber/skills/index.json': await indexOf(aboutOther), 'kyber/skills/edited.json': aboutOther })
    expect(await evidence.skill.execute({ action: 'check', skill: 'countdown' })).toEqual({ ok: false, id: await skillId(aboutOther), verified: false, code: 'SKILL_EVIDENCE_MISMATCH' })
    expect(await evidence.skill.execute({ action: 'run', skill: 'countdown', input: { state: kyberState(0, 1), steps: 8 } })).toMatchObject({ ok: false, code: 'SKILL_EVIDENCE_MISMATCH' })
    // SKILL_CELL_MISMATCH for a pinned cell: the record names other bytes than the ones the host admitted for kyber-cpu.
    const otherCell = encodeSkill({ ...countdown, cell: { ...countdown.cell, sha256: 'f'.repeat(64) } })
    const pinned = await reload(new MemoryVfs(), { 'kyber/skills/index.json': await indexOf(otherCell), 'kyber/skills/edited.json': otherCell })
    expect(await pinned.skill.execute({ action: 'check', skill: 'countdown' })).toEqual({ ok: false, id: await skillId(otherCell), verified: false, code: 'SKILL_CELL_MISMATCH' })
    expect((await pinned.skill.execute({ action: 'list' }) as { skills: J[] }).skills).toEqual([{ id: await skillId(otherCell), name: 'countdown',
      cell: { kind: 'pinned', name: 'kyber-cpu' }, cases: 16, source: 'shipped', verified: false, code: 'SKILL_CELL_MISMATCH' }])

    // SKILL_AMBIGUOUS: two kept files carry the name add-ab (a copy under another file name); by name she must use an id.
    const { skill, vfs } = await reload(new MemoryVfs())
    const base = { action: 'keep', name: 'add-ab', cell: 'kyber-cpu', program: { rom: ADD_ROM }, cases: ADD_CASES }
    const kept = await skill.execute(base) as J
    const copyId = sha('a copy of add-ab')
    vfs.writeFileSync(`${SKILLS_DIR}/${copyId}.json`, vfs.readFileSync(`${SKILLS_DIR}/${kept.id as string}.json`))
    const both = [kept.id as string, copyId].sort()
    for (const action of ['check', 'run']) {
      const answer = await skill.execute({ action, skill: 'add-ab', input: { state: kyberState(1, 1), steps: 8 } }) as J
      expect({ ...answer, ids: [...(answer.ids as string[])].sort() }).toEqual({ ok: false, code: 'SKILL_AMBIGUOUS', skill: 'add-ab', ids: both, next: 'name it by its id' })
    }
    expect(await skill.execute({ action: 'forget', skill: 'add-ab' })).toEqual({ ok: false, code: 'SKILL_AMBIGUOUS', skill: 'add-ab' })
    // By id each is distinct: the real one checks, the copy is refused under its own id; nothing was forgotten.
    expect(await skill.execute({ action: 'check', skill: kept.id })).toMatchObject({ ok: true, cases: { agree: 3 } })
    expect(await skill.execute({ action: 'check', skill: copyId })).toMatchObject({ ok: false, id: copyId, verified: false, code: 'SKILL_ID_MISMATCH' })
    expect(keptFiles(vfs)).toHaveLength(3)

    // SKILL_STORE_FAILED: her home refuses the record's write; the answer says so and no record is listed.
    const write = vfs.writeFileSync.bind(vfs)
    vi.spyOn(vfs, 'writeFileSync').mockImplementation(((path: unknown, ...rest: unknown[]) => {
      if (typeof path === 'string' && /^\/dsh\/home\/skills\/[a-f0-9]{64}\.json$/.test(path)) throw new Error('ENOSPC')
      return (write as (...args: unknown[]) => unknown)(path, ...rest)
    }))
    const failed = await skill.execute({ ...base, name: 'add-ab-two', cases: ADD_CASES.slice(0, 2) }) as J
    expect(failed).toMatchObject({ ok: false, code: 'SKILL_STORE_FAILED', name: 'add-ab-two' })
    expect(vfs.existsSync(`${SKILLS_DIR}/${failed.id as string}.json`)).toBe(false)
    expect((await skill.execute({ action: 'list' }) as { skills: J[] }).skills.map(row => row.name)).not.toContain('add-ab-two')
  }, 120_000)
})
const keptCount = (vfs: MemoryVfs): number => vfs.existsSync(SKILLS_DIR) ? [...vfs.readdirSync(SKILLS_DIR)].map(String).filter(name => name.endsWith('.json')).length : 0
const storeBytes = (vfs: MemoryVfs): number => keptFiles(vfs).reduce((total, file) => total + Number(vfs.statSync(`${SKILLS_DIR}/${file}`).size), 0)

describe('the kept-skill store has a total size (review fix: 256 skills x 1 MiB weights would outgrow her mirrored home)', () => {
  it('keeps a skill that brings the store exactly to its maximum, and refuses one byte more with SKILL_STORE_FULL', async () => {
    expect(SKILLS_STORE_MAX_BYTES).toBe(32 * 1024 * 1024)
    const { skill, vfs } = await mount(testHost())
    const base = { action: 'keep', name: 'add-ab', cell: 'kyber-cpu', program: { rom: ADD_ROM }, cases: ADD_CASES }
    const first = await skill.execute(base) as J
    expect(first).toMatchObject({ ok: true, kept: 'new' })
    const adds = storeBytes(vfs)
    expect(await skill.execute({ action: 'forget', skill: 'add-ab' })).toMatchObject({ ok: true })
    expect(storeBytes(vfs)).toBe(0)
    const filler = `${SKILLS_DIR}/weights/${sha('filler-weights')}.json`
    vfs.mkdirSync(`${SKILLS_DIR}/weights`, { recursive: true })
    vfs.writeFileSync(filler, new Uint8Array(SKILLS_STORE_MAX_BYTES - adds + 1))
    expect(await skill.execute(base)).toEqual({ ok: false, code: 'SKILL_STORE_FULL', bytes: SKILLS_STORE_MAX_BYTES - adds + 1, adding: adds,
      max: SKILLS_STORE_MAX_BYTES, next: 'forget one kept skill first' })
    expect(keptCount(vfs)).toBe(0)
    vfs.writeFileSync(filler, new Uint8Array(SKILLS_STORE_MAX_BYTES - adds))
    expect(await skill.execute(base)).toMatchObject({ ok: true, kept: 'new', id: first.id })
    expect(storeBytes(vfs)).toBe(SKILLS_STORE_MAX_BYTES)
    // The same skill again is still `already`, never refused for size.
    expect(await skill.execute(base)).toMatchObject({ ok: true, kept: 'already' })
  }, 120_000)
})

describe('voice, classifications, the write set, her self-state, organs', () => {
  it('look-only voice refuses the whole tool (keep and forget included); the actions are classified', () => {
    expect(VOICE_REFUSED_TOOLS).toContain('x6_skill')
    for (const action of ['keep', 'forget', 'list', 'check', 'run']) {
      expect(voiceVerdict({ tool: 'x6_skill', args: { action, skill: 'countdown', name: 'x' }, origin: { kind: 'builtin' } })).toContain('VOICE_LOOK_ONLY')
    }
    for (const action of ['list', 'check', 'run']) expect([action, classifyActionIrreversibility({ tool: 'x6_skill', action, skill: 'countdown' })]).toEqual([action, 0])
    for (const action of ['keep', 'forget']) expect([action, classifyActionIrreversibility({ tool: 'x6_skill', action, name: 'add-ab', skill: 'add-ab' })]).toEqual([action, 1])
    expect(classifyToolMutation('x6_skill', [{ name: 'action', type: 'string', required: true, enum: ['list', 'check', 'run', 'keep', 'forget'] }]))
      .toEqual({ readOnly: false, mutating: true, actions: { read: ['check', 'list'], write: ['forget', 'keep', 'run'] } })
  })

  it('the write-set inventory lists the new writer as content-addressed, and every write was classified so', async () => {
    const entry = RUNTIME_WRITE_SET.find(item => item.id === 'kept-skill-store')
    expect(entry).toMatchObject({ class: 'content-addressed', transitionKinds: [] })
    expect(entry!.writers.map(writer => writer.target)).toEqual(['keptProgramPath', 'keptWeightsPath', 'keptSkillPath', 'forgottenSkillPath', 'orphanArtifactPath'])
    const hex = 'a'.repeat(64)
    for (const path of [`${SKILLS_DIR}/${hex}.json`, `${SKILLS_DIR}/programs/${hex}.json`, `${SKILLS_DIR}/weights/${hex}.json`]) {
      expect(classifyWritePath(path)?.id).toBe('kept-skill-store')
    }
    for (const path of [`${SKILLS_DIR}/add-ab.json`, `${SKILLS_DIR}/${hex}.js`, `${SKILLS_DIR}/other/${hex}.json`]) expect(classifyWritePath(path)).toBeNull()
    const before = liveWriteSet.snapshot().counters.flagged
    const { skill } = await mount(testHost())
    expect(await skill.execute({ action: 'keep', name: 'add-ab', cell: 'kyber-cpu', program: { rom: ADD_ROM }, cases: ADD_CASES })).toMatchObject({ ok: true })
    expect(await skill.execute({ action: 'forget', skill: 'add-ab' })).toMatchObject({ ok: true })
    const live = liveWriteSet.snapshot()
    expect(live.counters.flagged).toBe(before)
    const ours = live.recent.filter(record => record.path.startsWith(`${SKILLS_DIR}/`))
    expect(ours.length).toBeGreaterThanOrEqual(3)
    expect(ours.every(record => record.entryId === 'kept-skill-store' && record.class === 'content-addressed')).toBe(true)
  }, 60_000)

  it('x6_self_state shows skills after forgedCells, newest first, count never cut', async () => {
    const { skill, m } = await mount(testHost())
    const one = await skill.execute({ action: 'keep', name: 'add-ab', cell: 'kyber-cpu', program: { rom: ADD_ROM }, cases: ADD_CASES }) as J
    // Newest first is by when each record file was written (millisecond time; equal times fall back to the id).
    await new Promise(resolve => setTimeout(resolve, 2))
    const two = await skill.execute({ action: 'keep', name: 'countdown-two', cell: 'kyber-cpu', program: { rom: COUNTDOWN_ROM },
      cases: [{ state: kyberState(0, 2), steps: 64 }] }) as J
    const state = await m.tool('x6_self_state').execute({}) as J
    expect(Object.keys(state).slice(-4)).toEqual(['cellJournal', 'forgedCells', 'skills', 'unknown'])
    expect(state.skills).toEqual({ count: 2, kept: [{ name: 'countdown-two', id: two.id }, { name: 'add-ab', id: one.id }] })
    expect(new TextEncoder().encode(JSON.stringify(state)).byteLength).toBeLessThanOrEqual(SELF_STATE_RESULT_BYTES)
  }, 60_000)

  it('cuts skill rows after forged rows and before any organ row; a bad shape is read-failed; an older registry shows no key', () => {
    const forged = Array.from({ length: 32 }, (_v, n) => ({ name: `forged-${String(n).padStart(2, '0')}`, sha256: sha(`f${String(n)}`), bytes: 600 }))
    const skills = Array.from({ length: 64 }, (_v, n) => ({ name: `skill-${String(n).padStart(2, '0')}`, id: sha(`s${String(n)}`) }))
    const organ = (n: number) => ({ id: `organ-${String(n).padStart(3, '0')}`, specifier: `ball:${sha(`o${String(n)}`)}`,
      loaded: { sha256: sha(`o${String(n)}`), bytes: 1000 + n }, state: 'running' })
    const registry = (organs: number, extra: Partial<SelfStateRegistry> = {}): SelfStateRegistry => ({
      sourceRevision: null, bootedAtMs: 1, head: null, organs: Array.from({ length: organs }, (_v, n) => organ(n)), staged: [], tools: [],
      cloudflareDoor: { registered: false, status: null }, cells: [], cellJournal: { calls: 0, rootSha256: 'd'.repeat(64) },
      forgedCells: forged, skills, ...extra })
    const project = (organs: number, extra: Partial<SelfStateRegistry> = {}) => projectSelfState({ registry: registry(organs, extra),
      store: Object.fromEntries(Array.from({ length: organs }, (_v, n) => [organ(n).id, organ(n).loaded.sha256])),
      edge: { sourceRevision: null, reason: 'unreachable' }, organFilter: null })
    const kept = (answer: J) => (answer.skills as J).kept as J[]
    const forgedRows = (answer: J) => (answer.forgedCells as J).cells as J[]
    expect(kept(project(2))).toHaveLength(64)
    // More organs: forged rows give way first, skills stay whole; then skills give way, the newest stay, organs never.
    let n = 2
    while (forgedRows(project(n)).length === 32) n += 1
    expect(kept(project(n))).toHaveLength(64)
    while (kept(project(n)).length === 64) n += 1
    const cut = project(n + 3)
    expect(new TextEncoder().encode(JSON.stringify(cut)).byteLength).toBeLessThanOrEqual(SELF_STATE_RESULT_BYTES)
    expect(forgedRows(cut)).toEqual([])
    expect(kept(cut).length).toBeLessThan(64)
    expect(kept(cut)).toEqual(skills.slice(0, kept(cut).length))
    expect((cut.skills as J).count).toBe(64)
    expect((cut.organs as J[]).length).toBe(n + 3)
    expect(cut.unknown).toContainEqual({ field: 'skills.kept', reason: 'too-many' })
    expect(cut.unknown).not.toContainEqual({ field: 'organs', reason: 'too-many' })
    expect(project(1, { skills: [{ name: 'Bad Name', id: sha('x') }] }).skills).toBeNull()
    expect(project(1, { skills: [{ name: 'Bad Name', id: sha('x') }] }).unknown).toContainEqual({ field: 'skills', reason: 'read-failed' })
    expect(project(1, { skills: null }).skills).toBeNull()
    const { skills: _omitted, ...older } = registry(1)
    expect(_omitted).toHaveLength(64)
    expect(Object.keys(projectSelfState({ registry: older, store: { [organ(0).id]: organ(0).loaded.sha256 },
      edge: { sourceRevision: null, reason: 'unreachable' }, organFilter: null }))).not.toContain('skills')
  })

  it('the cell host gives her the bytes it admitted; organs never get them', async () => {
    const host = testHost()
    const bytes = await host.verifiedBytes('kyber-cpu')
    expect(bytes).toBeInstanceOf(Uint8Array)
    expect(sha(bytes!)).toBe(CELL_PINS['kyber-cpu']!.sha256)
    expect(host.cellRows().find(row => row.cell === 'kyber-cpu')?.loaded).toBe('verified')
    // A private copy: changing it changes nothing the host holds.
    bytes![0] = 0xff
    expect(sha((await host.verifiedBytes('kyber-cpu'))!)).toBe(CELL_PINS['kyber-cpu']!.sha256)
    expect(await host.verifiedBytes('no-such-cell')).toBeNull()
    expect(await host.verifiedBytes('__proto__')).toBeNull()
    const refused = testHost({ 'kyber-cpu.wasm': new Uint8Array([0, 97, 115, 109]) })
    expect(await refused.verifiedBytes('kyber-cpu')).toBeNull()
    expect('verifiedBytes' in (organCellHost(host) as unknown as J)).toBe(false)
  }, 60_000)
})

describe('the shipped files are built by server/kyber-skills.build.mjs', () => {
  it('check mode: both files are current, and a changed byte makes one stale', async () => {
    expect(await checkKyberSkills()).toEqual([{ path: 'kyber/skills/countdown.json', current: true }, { path: 'kyber/skills/cord-echo.json', current: true },
      { path: 'kyber/skills/index.json', current: true }])
    const built = await buildKyberSkills()
    expect(built.map(file => file.id)).toEqual([COUNTDOWN_ID, CORD_ECHO_ID, null])
    expect(SKILL_INDEX_PATH).toBe(`/cells/${built[2]!.path}`)
    const stale = await checkKyberSkills((path: string) => {
      const real = built.find(file => file.path === path)!.bytes
      return path === 'kyber/skills/index.json' ? Uint8Array.from(real, (byte, at) => at === 5 ? byte ^ 1 : byte) : real
    })
    expect(stale).toEqual([{ path: 'kyber/skills/countdown.json', current: true }, { path: 'kyber/skills/cord-echo.json', current: true },
      { path: 'kyber/skills/index.json', current: false }])
    // The shipped record names the very artifacts beside it.
    const record = JSON.parse(new TextDecoder().decode(built[0]!.bytes)) as SkillRecord
    expect(record.program.digest).toBe(await artifactDigest(new Uint8Array(await readFile(new URL('kyber/skills/countdown.rom.json', CELLS)))))
    expect(record.weights?.digest).toBe(await artifactDigest(new Uint8Array(await readFile(new URL('kyber/cpu-weights.json', CELLS)))))
  })
})
