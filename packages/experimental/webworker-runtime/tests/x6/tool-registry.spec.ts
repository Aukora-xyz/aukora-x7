/**
 * `x6_tools`, her own read-only tools (tier T1), and each mounted tool as its own `x6t_<name>`.
 * Her acceptance table (AUMA-tools-are-mine.md section 8), adapted to T1 by decisions D1 to D4:
 *  - propose leaves the registry unchanged; qualify runs every case and binds the id to the exact bytes;
 *  - mount without the owner's session is OWNER_REQUIRED; with it the tool is listed, the capability index changes and the
 *    tool answers a call (on her mounted runtime, with the real adder forged through the pinned compiler);
 *  - a manifest asking for a write, a secret, the network or a JavaScript handler is TOOL_TIER_NOT_OPEN;
 *  - a home-read outside the declared patterns, in her private folder or on a secret path is refused;
 *  - a suite that cannot fail is refused; a stale qualification is refused; unmount leaves no orphan;
 *  - a look-only voice turn refuses the writing verbs; the 65th tool is refused.
 * Local only: real pinned cell bytes from apps/web/public/cells, Node worker_threads, the e4 fixture's `.invalid` origin.
 */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { Worker } from 'node:worker_threads'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryVfs } from '../../src/storage/memory.ts'
import { classifyActionIrreversibility } from '../../src/x6/ball-loader.ts'
import {
  createToolRegistry, homeReadRefusal, manifestReadOnly, mountedPathOf, proposalPathOf, TOOL_HOST_SUITE, TOOL_MANIFEST_MAX_BYTES,
  TOOL_MOUNTED_DIR, TOOLS_MOUNTED_MAX,
  type ToolCellAnswer, type ToolRegistryDeps,
} from '../../src/x6/tool-registry.ts'
import { voiceVerdict } from '../../src/x6/voice-read-only.ts'
import * as wasmCells from '../../src/x6/wasm-cells.ts'
import { createCellHost, type CellHost, type CellWorker } from '../../src/x6/wasm-cells.ts'
import { RUNTIME_WRITE_SET } from '../../src/x6/write-set-inventory.ts'
import { FakeSocket, mountE4 } from './e4-fixture.ts'

type J = Record<string, unknown>
const SHA_A = 'a'.repeat(64)
const SHA_B = 'b'.repeat(64)

/** A made-up pinned cell `calc` (op `calc.add`): `{ a, b }` -> `{ sum }`; with files, their count and the first text. */
async function fakeCalc(_name: string, _op: string, input: J): Promise<ToolCellAnswer> {
  await Promise.resolve()
  if (Array.isArray(input.files)) {
    const files = input.files as J[]
    return { ok: true, result: { files: files.length, first: files[0]?.text ?? null }, fuelUsed: 1 }
  }
  if (typeof input.a !== 'number' || typeof input.b !== 'number') return { ok: false, code: 'INPUT', fuelUsed: 1 }
  return { ok: true, result: { sum: input.a + input.b }, fuelUsed: 7 }
}

function registry(over: Partial<ToolRegistryDeps> & { owner?: boolean; pinSha?: () => string } = {}) {
  const vfs = (over.vfs as MemoryVfs | undefined) ?? new MemoryVfs()
  const calls: Array<{ op: string; input: J }> = []
  const deps: ToolRegistryDeps = {
    vfs,
    pinned: name => name === 'calc' ? { sha256: over.pinSha?.() ?? SHA_A, ops: ['calc.add'] } : null,
    forged: () => null,
    runPinned: async (name, op, input) => { calls.push({ op, input }); return await fakeCalc(name, op, input) },
    runForged: async () => await Promise.resolve({ ok: false, code: 'FORGED_UNKNOWN' }),
    ownerSession: async () => await Promise.resolve(over.owner ?? true),
    toolTaken: () => false,
    now: () => 1_000,
    ...over,
  }
  return { reg: createToolRegistry(deps), vfs, calls }
}

const manifestOf = (over: J = {}): J => ({
  schema: 'aukora.tool.v1', name: 'adder', version: '0.1.0', description: 'Adds two integers.',
  actions: { add: { description: 'a + b', readOnly: true, authority: 'A' } },
  requires: { services: [], secrets: [], network: false },
  handler: { pin: 'calc', op: 'calc.add' },
  tests: [
    { name: 'two and three', input: { a: 2, b: 3 }, expect: { ok: true, result: { sum: 5 } } },
    { name: 'no b is refused', input: { a: 2 }, expect: { ok: false, code: 'INPUT' } },
  ],
  ...over,
})

async function proposeAndQualify(reg: ReturnType<typeof registry>['reg'], manifest: J = manifestOf()) {
  const proposed = await reg.execute({ action: 'propose', manifest, notes: 'mine' })
  expect(proposed).toMatchObject({ ok: true })
  const qualified = await reg.execute({ action: 'qualify', proposalId: proposed.proposalId })
  return { proposed, qualified }
}

describe('the five verbs, on the registry alone', () => {
  it('T1: propose writes only the proposal and leaves the registry unchanged', async () => {
    const { reg, vfs } = registry()
    const before = await reg.execute({ action: 'list' })
    expect(before).toMatchObject({ ok: true, count: 0, mounted: [], proposals: [] })
    const proposed = await reg.execute({ action: 'propose', manifest: manifestOf(), notes: 'mine' })
    expect(proposed).toMatchObject({ ok: true, mounted: false, proposalId: `adder@${String(proposed.sha256)}`,
      path: `/dsh/home/tools/proposals/adder/${String(proposed.sha256)}.json` })
    expect(vfs.existsSync(String(proposed.path))).toBe(true)
    expect(vfs.existsSync(TOOL_MOUNTED_DIR)).toBe(false)
    const after = await reg.execute({ action: 'list' })
    expect(after).toMatchObject({ count: 0, mounted: [], proposals: [{ proposalId: proposed.proposalId, name: 'adder' }] })
    expect(reg.mountedTools()).toEqual([])
    // The path is in her write-set inventory, under its own entry.
    const owners = RUNTIME_WRITE_SET.filter(entry => new RegExp(entry.match).test(String(proposed.path)))
    expect(owners.map(entry => entry.id)).toEqual(['tool-registry-store'])
    expect(RUNTIME_WRITE_SET.filter(entry => new RegExp(entry.match).test(mountedPathOf('adder'))).map(entry => entry.id)).toEqual(['tool-registry-store'])
  })

  it('T2: qualify runs every case through the cell and binds the id to the exact bytes', async () => {
    const { reg, calls } = registry()
    const { qualified } = await proposeAndQualify(reg)
    expect(qualified).toMatchObject({ ok: true, qualified: true, refusals: [],
      cases: [{ id: 'two and three', ok: true, detail: 'result {"sum":5}' }, { id: 'no b is refused', ok: true, detail: 'refused INPUT' }] })
    expect(qualified.qualificationId).toMatch(/^[a-f0-9]{64}$/)
    expect(calls).toEqual([{ op: 'calc.add', input: { a: 2, b: 3 } }, { op: 'calc.add', input: { a: 2 } }])
    // The same bytes give the same id; another suite gives another id; a wrong case is not qualified.
    expect((await proposeAndQualify(reg)).qualified.qualificationId).toBe(qualified.qualificationId)
    const other = await proposeAndQualify(reg, manifestOf({ tests: [...manifestOf().tests as J[],
      { name: 'one and one', input: { a: 1, b: 1 }, expect: { ok: true, not: { sum: 3 } } }] }))
    expect(other.qualified).toMatchObject({ qualified: true })
    expect(other.qualified.qualificationId).not.toBe(qualified.qualificationId)
    const wrong = await proposeAndQualify(reg, manifestOf({ tests: [{ name: 'lies', input: { a: 2, b: 2 }, expect: { ok: true, result: { sum: 5 } } },
      { name: 'refused', input: {}, expect: { ok: false } }] }))
    expect(wrong.qualified).toMatchObject({ qualified: false, qualificationId: null, cases: [{ id: 'lies', ok: false }, { id: 'refused', ok: true }] })
  })

  it('T3: mount without the owner\'s session is OWNER_REQUIRED and the registry is unchanged', async () => {
    const { reg, vfs } = registry({ owner: false })
    const { proposed, qualified } = await proposeAndQualify(reg)
    expect(await reg.execute({ action: 'mount', proposalId: proposed.proposalId, qualificationId: qualified.qualificationId }))
      .toMatchObject({ ok: false, code: 'OWNER_REQUIRED' })
    expect(vfs.existsSync(mountedPathOf('adder'))).toBe(false)
    expect(await reg.execute({ action: 'list' })).toMatchObject({ count: 0, mounted: [] })
    // A probe that throws is no owner either.
    const throwing = registry({ ownerSession: async () => { await Promise.resolve(); throw new Error('offline') } })
    const again = await proposeAndQualify(throwing.reg)
    expect(await throwing.reg.execute({ action: 'mount', proposalId: again.proposed.proposalId, qualificationId: again.qualified.qualificationId }))
      .toMatchObject({ ok: false, code: 'OWNER_REQUIRED' })
  })

  it('T4: mount with the owner lists the tool with its diff, and the tool answers', async () => {
    const { reg, vfs } = registry()
    const { proposed, qualified } = await proposeAndQualify(reg)
    const mounted = await reg.execute({ action: 'mount', proposalId: proposed.proposalId, qualificationId: qualified.qualificationId })
    expect(mounted).toMatchObject({ ok: true, mounted: true, name: 'adder', tool: 'x6t_adder', when: 1_000,
      diff: { removed: [], added: { tool: 'x6t_adder', actions: ['add'], services: [], secrets: [], network: false, authority: 'A' } } })
    expect((mounted.diff as { lines: string[] }).lines).toEqual([
      '+ tool: adder (x6t_adder) version 0.1.0', '+ actions: add (A, read-only)', '+ services: none', '+ secrets: none', '+ network: false',
      '+ handler: pinned cell calc op calc.add (zero imports, fuel bounded)', '+ new authority: none (every action is a read)',
      '- no existing action is removed'])
    // The diff is kept in the record too.
    expect(JSON.parse(String(vfs.readFileSync(mountedPathOf('adder'), 'utf8')))).toMatchObject({ diff: mounted.diff, qualificationId: qualified.qualificationId })
    expect(await reg.execute({ action: 'list' })).toMatchObject({ count: 1, proposals: [],
      mounted: [{ name: 'adder', tool: 'x6t_adder', readOnly: true, mutating: false, authority: 'A', actions: ['add'], sha256: proposed.sha256, mountedAt: 1_000 }] })
    expect(reg.mountedTools().map(row => row.tool)).toEqual(['x6t_adder'])
    expect(await reg.call('adder', { input: { a: 40, b: 2 } })).toEqual({ ok: true, tool: 'x6t_adder', action: 'add', result: { sum: 42 }, fuelUsed: 7, readOnly: true })
    expect(await reg.call('adder', { input: { a: 40 } })).toMatchObject({ ok: false, code: 'INPUT' })
    expect(await reg.call('adder', { act: 'sub', input: {} })).toMatchObject({ ok: false, code: 'TOOL_ACTION_UNKNOWN', actions: ['add'] })
    // Mounting the same bytes again changes nothing.
    expect(await reg.execute({ action: 'mount', proposalId: proposed.proposalId, qualificationId: qualified.qualificationId }))
      .toMatchObject({ ok: true, mounted: 'already' })
  })

  it('T5: a write, a secret, the network, another service or a JavaScript handler is TOOL_TIER_NOT_OPEN with the tier it needs', async () => {
    const { reg, vfs } = registry()
    const cases: Array<[J, string]> = [
      [{ actions: { add: { readOnly: false, authority: 'A' } } }, 'T2'],
      [{ actions: { add: { readOnly: true, authority: 'B' } } }, 'T2'],
      [{ actions: { add: { readOnly: true, authority: 'C' } } }, 'T3'],
      [{ requires: { services: [], secrets: ['GITHUB_TOKEN_NAME'], network: false } }, 'T3'],
      [{ requires: { services: [], network: true } }, 'T3'],
      [{ requires: { services: ['fs'] } }, 'T2'],
      [{ requires: { services: ['model'] } }, 'T3'],
      [{ requires: { services: ['process'] } }, 'T3'],
      [{ handler: `ball:${SHA_B}` }, 'JS_SANDBOX'],
    ]
    for (const [over, needs] of cases) {
      const answer = await reg.execute({ action: 'propose', manifest: manifestOf(over) })
      expect([over, answer]).toEqual([over, expect.objectContaining({ ok: false, code: 'TOOL_TIER_NOT_OPEN', needs })])
    }
    expect(vfs.existsSync('/dsh/home/tools')).toBe(false)
  })

  it('T6: home-read reads only declared, non-private, non-secret paths, bounded, and passes their bytes into the cell', async () => {
    // Declaring her private folder, a wildcard that could reach it, a secret name or a path outside her home is refused.
    const { reg, vfs } = registry()
    for (const reads of [['/dsh/home/auma/private/**'], ['/dsh/home/auma/*/notes.md'], ['/dsh/home/auma/**'], ['/dsh/home/auma/keys/private-key.pem'],
      ['/dsh/home/other/**'], ['/dsh/home/auma/notes/../private/x'], []]) {
      const answer = await reg.execute({ action: 'propose', manifest: manifestOf({ requires: { services: ['home-read'], reads } }) })
      expect([reads, answer]).toEqual([reads, expect.objectContaining({ ok: false, code: 'TOOL_TIER_NOT_OPEN' })])
    }
    // Reads declared without the service are not T1 either.
    expect(await reg.execute({ action: 'propose', manifest: manifestOf({ requires: { services: [], reads: ['/dsh/home/auma/notes/**'] } }) }))
      .toMatchObject({ ok: false, code: 'TOOL_TIER_NOT_OPEN' })
    // A fixture path in a case is judged by the same rule.
    const badCase = await proposeAndQualify(reg, manifestOf({ requires: { services: ['home-read'], reads: ['/dsh/home/auma/notes/**'] },
      tests: [{ name: 'peek', files: [{ path: '/dsh/home/auma/private/x.md', text: 'x' }], expect: { ok: true, result: {} } },
        { name: 'no', input: {}, expect: { ok: false } }] }))
    expect(badCase.qualified).toMatchObject({ qualified: false, cases: [{ id: 'peek', ok: false }, { id: 'no' }] })
    expect(String((badCase.qualified.cases as J[])[0]?.detail)).toMatch(/^TOOL_READ_PRIVATE: /)

    const reader = manifestOf({ name: 'note-reader', requires: { services: ['home-read'], reads: ['/dsh/home/auma/notes/**'] },
      tests: [{ name: 'counts', files: [{ path: '/dsh/home/auma/notes/a.md', text: 'hello' }], expect: { ok: true, result: { files: 1, first: 'hello' } } },
        { name: 'nothing', input: {}, expect: { ok: false, code: 'INPUT' } }] })
    const { proposed, qualified } = await proposeAndQualify(reg, reader)
    expect(qualified).toMatchObject({ qualified: true })
    expect(await reg.execute({ action: 'mount', proposalId: proposed.proposalId, qualificationId: qualified.qualificationId })).toMatchObject({ ok: true })
    vfs.mkdirSync('/dsh/home/auma/notes/deep', { recursive: true })
    vfs.mkdirSync('/dsh/home/auma/private', { recursive: true })
    vfs.writeFileSync('/dsh/home/auma/notes/deep/today.md', 'today')
    vfs.writeFileSync('/dsh/home/auma/notes/secret.txt', 'nope')
    vfs.writeFileSync('/dsh/home/auma/private/diary.md', 'nope')
    vfs.writeFileSync('/dsh/home/auma/other.md', 'nope')
    vfs.writeFileSync('/dsh/home/auma/notes/big.md', 'x'.repeat(256 * 1024 + 1))
    expect(await reg.call('note-reader', { paths: ['/dsh/home/auma/notes/deep/today.md'] }))
      .toMatchObject({ ok: true, result: { files: 1, first: 'today' } })
    for (const [path, code] of [['/dsh/home/auma/other.md', 'TOOL_READ_UNDECLARED'], ['/dsh/home/auma/private/diary.md', 'TOOL_READ_PRIVATE'],
      ['/dsh/home/auma/notes/secret.txt', 'TOOL_READ_PRIVATE'], ['/dsh/home/auma/notes/../private/diary.md', 'TOOL_READ_PATH_INVALID'],
      ['notes/a.md', 'TOOL_READ_PATH_INVALID'], ['/dsh/home/sessions/x.jsonl', 'TOOL_READ_OUTSIDE'], ['/dsh/home/auma/notes/big.md', 'TOOL_READ_FAILED']] as const) {
      expect([path, await reg.call('note-reader', { paths: [path] })]).toEqual([path, expect.objectContaining({ ok: false, code })])
    }
    expect(homeReadRefusal('/dsh/home/auma/notes/x.md', ['/dsh/home/auma/notes/*'])).toBeNull()
    expect(homeReadRefusal('/dsh/home/auma/notes/a/x.md', ['/dsh/home/auma/notes/*'])).toBe('TOOL_READ_UNDECLARED')
    // A tool that declares no reads reads nothing.
    const plain = await proposeAndQualify(reg)
    await reg.execute({ action: 'mount', proposalId: plain.proposed.proposalId, qualificationId: plain.qualified.qualificationId })
    expect(await reg.call('adder', { paths: ['/dsh/home/auma/notes/deep/today.md'] })).toMatchObject({ ok: false, code: 'TOOL_READ_UNDECLARED' })
  })

  it('a suite that cannot fail is refused TOOL_TESTS_CANNOT_FAIL', async () => {
    const { reg } = registry()
    const { qualified } = await proposeAndQualify(reg, manifestOf({ tests: [{ name: 'only good news', input: { a: 1, b: 2 }, expect: { ok: true, result: { sum: 3 } } }] }))
    expect(qualified).toMatchObject({ qualified: false, qualificationId: null, cases: [], refusals: [{ code: 'TOOL_TESTS_CANNOT_FAIL' }] })
  })

  it('T7: a stale qualification is refused: another id, changed proposal bytes, or a changed handler', async () => {
    let pin = SHA_A
    const { reg, vfs } = registry({ pinSha: () => pin })
    const { proposed, qualified } = await proposeAndQualify(reg)
    expect(await reg.execute({ action: 'mount', proposalId: proposed.proposalId, qualificationId: SHA_B })).toMatchObject({ ok: false, code: 'QUALIFICATION_STALE' })
    expect(await reg.execute({ action: 'mount', proposalId: proposed.proposalId })).toMatchObject({ ok: false, code: 'QUALIFICATION_STALE' })
    pin = SHA_B
    expect(await reg.execute({ action: 'mount', proposalId: proposed.proposalId, qualificationId: qualified.qualificationId })).toMatchObject({ ok: false, code: 'QUALIFICATION_STALE' })
    pin = SHA_A
    const text = String(vfs.readFileSync(String(proposed.path), 'utf8'))
    vfs.writeFileSync(String(proposed.path), text.replace('"0.1.0"', '"0.1.1"'))
    expect(await reg.execute({ action: 'mount', proposalId: proposed.proposalId, qualificationId: qualified.qualificationId })).toMatchObject({ ok: false, code: 'QUALIFICATION_STALE' })
    expect(vfs.existsSync(mountedPathOf('adder'))).toBe(false)
    // A tool whose pinned cell changes after mounting stops answering until it is qualified again.
    vfs.writeFileSync(String(proposed.path), text)
    expect(await reg.execute({ action: 'mount', proposalId: proposed.proposalId, qualificationId: qualified.qualificationId })).toMatchObject({ ok: true })
    pin = SHA_B
    expect(await reg.call('adder', { input: { a: 1, b: 1 } })).toMatchObject({ ok: false, code: 'TOOL_HANDLER_CHANGED' })
  })

  it('T8: unmount removes the record and leaves no orphan; the name is free again', async () => {
    const { reg, vfs } = registry()
    const { proposed, qualified } = await proposeAndQualify(reg)
    await reg.execute({ action: 'mount', proposalId: proposed.proposalId, qualificationId: qualified.qualificationId })
    expect(await reg.execute({ action: 'unmount', name: 'x6t_adder' })).toEqual({ ok: true, unmounted: true, name: 'adder', tool: 'x6t_adder' })
    expect([...vfs.readdirSync(TOOL_MOUNTED_DIR)]).toEqual([])
    expect(reg.mountedTools()).toEqual([])
    expect(await reg.execute({ action: 'list' })).toMatchObject({ count: 0, mounted: [], proposals: [{ proposalId: proposed.proposalId }] })
    expect(await reg.call('adder', { input: { a: 1, b: 1 } })).toMatchObject({ ok: false, code: 'TOOL_NOT_MOUNTED' })
    expect(await reg.execute({ action: 'unmount', name: 'adder' })).toMatchObject({ ok: false, code: 'TOOL_NOT_MOUNTED' })
    // A proposal a mounted tool stands on cannot be withdrawn; once unmounted it can.
    await reg.execute({ action: 'mount', proposalId: proposed.proposalId, qualificationId: qualified.qualificationId })
    expect(await reg.execute({ action: 'unmount', proposalId: proposed.proposalId })).toMatchObject({ ok: false, code: 'TOOL_PROPOSAL_MOUNTED' })
    await reg.execute({ action: 'unmount', name: 'adder' })
    expect(await reg.execute({ action: 'mount', proposalId: proposed.proposalId, qualificationId: qualified.qualificationId })).toMatchObject({ ok: true, mounted: true })
  })

  it('a name already registered by anything else, or mounted from other bytes, is TOOL_NAME_TAKEN', async () => {
    const taken = registry({ toolTaken: name => name === 'x6t_adder' })
    const first = await proposeAndQualify(taken.reg)
    expect(await taken.reg.execute({ action: 'mount', proposalId: first.proposed.proposalId, qualificationId: first.qualified.qualificationId }))
      .toMatchObject({ ok: false, code: 'TOOL_NAME_TAKEN', tool: 'x6t_adder' })
    const { reg } = registry()
    const one = await proposeAndQualify(reg)
    await reg.execute({ action: 'mount', proposalId: one.proposed.proposalId, qualificationId: one.qualified.qualificationId })
    const two = await proposeAndQualify(reg, manifestOf({ version: '0.2.0' }))
    expect(await reg.execute({ action: 'mount', proposalId: two.proposed.proposalId, qualificationId: two.qualified.qualificationId }))
      .toMatchObject({ ok: false, code: 'TOOL_NAME_TAKEN' })
  })

  it('review: a record written into /dsh/home/tools/ by another path is never registered or run, and says what it is', async () => {
    // Her generic `write` reaches /dsh/home/tools/; these records never went through propose, qualify or mount.
    const hex = (text: string): string => createHash('sha256').update(text).digest('hex')
    const plant = (vfs: MemoryVfs, manifest: J, qualificationId: (m: J) => string, handlerSha = SHA_A): void => {
      const bytes = wasmCells.cellCanonicalJson({ manifest, notes: null })
      const sha = hex(bytes)
      const name = String(manifest.name)
      vfs.mkdirSync(`/dsh/home/tools/proposals/${name}`, { recursive: true })
      vfs.writeFileSync(proposalPathOf(name, sha), bytes)
      vfs.mkdirSync(TOOL_MOUNTED_DIR, { recursive: true })
      vfs.writeFileSync(mountedPathOf(name), wasmCells.cellCanonicalJson({ schema: 'aukora.tool-mount.v1', name, tool: `x6t_${name}`,
        proposalId: `${name}@${sha}`, sha256: sha, qualificationId: qualificationId(manifest),
        handler: { kind: 'pinned', ref: 'calc', sha256: handlerSha }, diff: { lines: [], added: {}, removed: [] }, mountedAt: 1 }))
    }
    // The id a forger can compute for any bytes (manifest, handler SHA-256, suite): it alone proves no qualification ran.
    const idOf = (manifest: J): string => hex(wasmCells.cellCanonicalJson({ manifest, handler: SHA_A,
      suite: hex(wasmCells.cellCanonicalJson({ host: TOOL_HOST_SUITE, tests: manifest.tests })) }))
    const { reg, vfs, calls } = registry()
    // 1. Outside T1: a JavaScript handler, a write at authority C, the network.
    plant(vfs, manifestOf({ name: 'jsfoo', handler: `ball:${SHA_A}`, actions: { go: { readOnly: false, authority: 'C' } },
      requires: { services: [], network: true } }), idOf)
    plant(vfs, manifestOf({ name: 'writer', actions: { add: { readOnly: false, authority: 'C' } }, requires: { services: [], network: true } }), idOf)
    // 2. T1 bytes with an id that is not the one these bytes give.
    plant(vfs, manifestOf({ name: 'noqual' }), () => 'c'.repeat(64))
    // 3. T1 bytes with the right id but a suite that does not pass (no qualification could have answered it).
    plant(vfs, manifestOf({ name: 'liar', tests: [{ name: 'lies', input: { a: 2, b: 2 }, expect: { ok: true, result: { sum: 5 } } },
      { name: 'refused', input: {}, expect: { ok: false } }] }), idOf)
    // 4. The right bytes and id, but the handler named in the record is not the one that would run.
    plant(vfs, manifestOf({ name: 'swapped' }), idOf, SHA_B)
    expect(reg.mountedTools().map(row => row.name)).toEqual(['liar'])
    expect(await reg.call('jsfoo', { input: {} })).toMatchObject({ ok: false, code: 'TOOL_RECORD_CHANGED', tool: 'x6t_jsfoo' })
    expect(await reg.call('writer', { input: { a: 1, b: 2 } })).toMatchObject({ ok: false, code: 'TOOL_RECORD_CHANGED' })
    expect(await reg.call('noqual', { input: { a: 1, b: 2 } })).toMatchObject({ ok: false, code: 'TOOL_RECORD_CHANGED' })
    expect(await reg.call('swapped', { input: { a: 1, b: 2 } })).toMatchObject({ ok: false, code: 'TOOL_HANDLER_CHANGED' })
    expect(await reg.call('liar', { input: { a: 1, b: 2 } })).toMatchObject({ ok: false, code: 'TOOL_RECORD_CHANGED' })
    // The suite ran (the proof), the caller's input never reached the cell.
    expect(calls.some(entry => entry.input.a === 1 && entry.input.b === 2)).toBe(false)
    // `list` says what each is, read-only derived from its manifest, never from where it sits.
    const listed = await reg.execute({ action: 'list' }) as { mounted: J[] }
    const rows: Record<string, unknown> = Object.fromEntries(listed.mounted.map(row =>
      [String(row.name), [row.readOnly, row.mutating, row.runnable, row.code ?? null]]))
    expect(rows).toEqual({
      jsfoo: [false, true, false, 'TOOL_RECORD_CHANGED'], writer: [false, true, false, 'TOOL_RECORD_CHANGED'],
      noqual: [true, false, false, 'TOOL_RECORD_CHANGED'], liar: [true, false, true, null], swapped: [true, false, false, 'TOOL_HANDLER_CHANGED'] })
    expect(manifestReadOnly(manifestOf())).toBe(true)
    expect(manifestReadOnly(manifestOf({ actions: { add: { readOnly: true, authority: 'A' }, put: { readOnly: false, authority: 'A' } } }))).toBe(false)
    expect(manifestReadOnly(manifestOf({ requires: { services: [], network: true } }))).toBe(false)
  })

  it('the 65th mounted tool is refused TOOLS_FULL', async () => {
    const { reg } = registry()
    for (let index = 0; index <= TOOLS_MOUNTED_MAX; index += 1) {
      const { proposed, qualified } = await proposeAndQualify(reg, manifestOf({ name: `t${String(index).padStart(2, '0')}` }))
      const answer = await reg.execute({ action: 'mount', proposalId: proposed.proposalId, qualificationId: qualified.qualificationId })
      expect([index, answer]).toEqual([index, index < TOOLS_MOUNTED_MAX ? expect.objectContaining({ ok: true, mounted: true })
        : expect.objectContaining({ ok: false, code: 'TOOLS_FULL', max: 64 })])
    }
    expect((await reg.execute({ action: 'list' })).count).toBe(64)
  })

  it('the bounds: manifest bytes, actions, cases, names, floats and unknown keys', async () => {
    const { reg } = registry()
    const many = (count: number) => Object.fromEntries(Array.from({ length: count }, (_, at) => [`a${String(at)}`, { readOnly: true, authority: 'A' }]))
    const cases = (count: number) => Array.from({ length: count }, (_, at) => ({ name: `c${String(at)}`, input: {}, expect: { ok: false } }))
    for (const [over, code] of [
      [{ description: 'x'.repeat(1024), tests: cases(32).map(entry => ({ ...entry, input: { pad: 'y'.repeat(2100) } })) }, 'TOOL_MANIFEST_LIMIT'],
      [{ actions: many(17) }, 'TOOL_MANIFEST_INVALID'], [{ actions: {} }, 'TOOL_MANIFEST_INVALID'],
      [{ tests: cases(33) }, 'TOOL_MANIFEST_INVALID'], [{ tests: [] }, 'TOOL_MANIFEST_INVALID'],
      [{ name: 'X' }, 'TOOL_MANIFEST_INVALID'], [{ name: 'a' }, 'TOOL_MANIFEST_INVALID'], [{ name: `a${'b'.repeat(31)}` }, 'TOOL_MANIFEST_INVALID'],
      [{ version: 1.5 }, 'TOOL_MANIFEST_INVALID'], [{ extra: true }, 'TOOL_MANIFEST_INVALID'], [{ schema: 'aukora.tool.v2' }, 'TOOL_MANIFEST_INVALID'],
      [{ handler: { pin: 'calc', cell: SHA_A, op: 'calc.add' } }, 'TOOL_MANIFEST_INVALID'],
      [{ handler: { pin: 'calc', op: 'calc.add', program: { files: [] } } }, 'TOOL_MANIFEST_INVALID'],
    ] as Array<[J, string]>) {
      const answer = await reg.execute({ action: 'propose', manifest: manifestOf(over) })
      expect([Object.keys(over), answer]).toEqual([Object.keys(over), expect.objectContaining({ ok: false, code })])
    }
    expect(TOOL_MANIFEST_MAX_BYTES).toBe(64 * 1024)
    expect(await reg.execute({ action: 'propose', manifest: manifestOf({ actions: many(16), tests: cases(32) }) })).toMatchObject({ ok: true })
    expect(await reg.execute({ action: 'qualify', proposalId: 'adder' })).toMatchObject({ ok: false, code: 'TOOL_PROPOSAL_UNKNOWN' })
    expect(await reg.execute({ action: 'grant' })).toMatchObject({ ok: false, code: 'TOOL_ACTION_INVALID' })
    // Proposals are bounded too: 64 kept at once (a byte-identical one adds nothing).
    const { reg: full } = registry()
    for (let index = 0; index < 64; index += 1) {
      expect(await full.execute({ action: 'propose', manifest: manifestOf({ name: `p${String(index).padStart(2, '0')}` }) })).toMatchObject({ ok: true })
    }
    expect(await full.execute({ action: 'propose', manifest: manifestOf({ name: 'p00' }) })).toMatchObject({ ok: true })
    expect(await full.execute({ action: 'propose', manifest: manifestOf({ name: 'p64' }) })).toMatchObject({ ok: false, code: 'TOOL_PROPOSALS_FULL', max: 64 })
    const first = (await full.execute({ action: 'list' })).proposals as J[]
    expect(await full.execute({ action: 'unmount', proposalId: first[0]?.proposalId })).toMatchObject({ ok: true, withdrawn: first[0]?.proposalId })
    expect(await full.execute({ action: 'propose', manifest: manifestOf({ name: 'p64' }) })).toMatchObject({ ok: true })
    expect(await full.execute({ action: 'unmount', proposalId: first[0]?.proposalId })).toMatchObject({ ok: false, code: 'TOOL_PROPOSAL_UNKNOWN' })
    // An input may not overwrite the program or the host's own keys.
    const programmed = await proposeAndQualify(reg, manifestOf({ name: 'plus-one', handler: { pin: 'calc', op: 'calc.add', program: { b: 1 } },
      tests: [{ name: 'one more', input: { a: 4 }, expect: { ok: true, result: { sum: 5 } } }, { name: 'none', input: {}, expect: { ok: false } }] }))
    expect(programmed.qualified).toMatchObject({ qualified: true })
    await reg.execute({ action: 'mount', proposalId: programmed.proposed.proposalId, qualificationId: programmed.qualified.qualificationId })
    expect(await reg.call('plus-one', { input: { a: 1, b: 100 } })).toMatchObject({ ok: false, code: 'TOOL_INPUT_COLLIDES' })
    expect(await reg.call('plus-one', { input: { a: 1, files: [] } })).toMatchObject({ ok: false, code: 'TOOL_INPUT_COLLIDES' })
    expect(await reg.call('plus-one', { input: { a: 1 } })).toMatchObject({ ok: true, result: { sum: 2 } })
  })
})

describe('her runtime: classes and voice', () => {
  it('list and qualify are reads; propose, mount and unmount are reversible writes; a mounted x6t_ tool is a read', () => {
    expect(['list', 'qualify', 'propose', 'mount', 'unmount'].map(action => classifyActionIrreversibility({ tool: 'x6_tools', action })))
      .toEqual([0, 0, 1, 1, 1])
    expect(classifyActionIrreversibility({ tool: 'x6t_adder', input: { a: 1 } })).toBe(0)
    expect(classifyActionIrreversibility({ tool: 'x6t_adder', promote: true })).not.toBe(0)
  })

  it('a look-only voice turn refuses the four writing verbs, and every mounted tool', () => {
    for (const action of ['propose', 'qualify', 'mount', 'unmount', 'list']) {
      expect([action, voiceVerdict({ tool: 'x6_tools', args: { action }, origin: { kind: 'builtin' } })])
        .toEqual([action, expect.stringContaining('VOICE_LOOK_ONLY')])
    }
    expect(voiceVerdict({ tool: 'x6t_adder', args: { input: { a: 1, b: 2 } }, origin: { kind: 'preset' } })).toEqual(expect.stringContaining('VOICE_LOOK_ONLY'))
  })
})

// ---- On her mounted runtime: the real adder, forged through the pinned compiler, mounted and called. ----
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
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  try { await Promise.all([...hosts].map(host => host.dispose())) }
  finally {
    hosts.clear()
    await Promise.all([...workers].map(worker => worker.terminate()))
    workers.clear()
  }
})

/** The edge's owner-only cell door: 415 past the owner check for the owner, 403 for anyone else. */
async function mountRuntime(owner: { value: boolean }, vfs = new MemoryVfs()) {
  const host = createCellHost({ origin: ORIGIN, fetchImpl: served(), createWorker: nodeCellWorker, now: () => 0 })
  hosts.add(host)
  vi.spyOn(wasmCells, 'workerCellHost').mockReturnValue(host)
  const m = await mountE4({ vfs, respond: (call) => {
    if (call.method === 'GET' && call.path === '/api/build') return Response.json({ ok: true, schema: 'aukora.edge-build.v1', sourceRevision: null })
    if (call.method === 'POST' && call.path === '/_host/cell-run') {
      return owner.value ? Response.json({ ok: false, code: 'CELL_RUN_MEDIA_TYPE' }, { status: 415 })
        : Response.json({ ok: false, code: 'OWNER_ACCESS_REQUIRED' }, { status: 403 })
    }
    return null
  } })
  return { m, vfs }
}
const registered = (m: Awaited<ReturnType<typeof mountE4>>, name: string): boolean => {
  try { m.tool(name); return true } catch { return false }
}

describe('on her mounted runtime', () => {
  it('forge the adder, propose, qualify, mount (owner), call x6t_adder, see the index change, unmount, and it survives a reload', async () => {
    const owner = { value: false }
    const { m, vfs } = await mountRuntime(owner)
    const forged = await m.tool('x6_cell').execute({ action: 'forge', wat: await readFile(ADDER, 'utf8'), name: 'adder' }) as J
    expect(forged).toMatchObject({ ok: true })
    const sha = String((forged.cell as J).sha256)
    const tools = m.tool('x6_tools')
    const index = async () => await m.tool('x6_capability_index').execute({ action: 'snapshot' }) as { counts: J; registeredTools: J[] }
    const before = await index()
    const manifest = manifestOf({ handler: { cell: sha, op: 'run' } })
    const proposed = await tools.execute({ action: 'propose', manifest }) as J
    const qualified = await tools.execute({ action: 'qualify', proposalId: proposed.proposalId }) as J
    expect(qualified).toMatchObject({ qualified: true, cases: [{ ok: true, detail: 'result {"sum":5}' }, { ok: true, detail: 'refused INPUT' }] })
    expect(await tools.execute({ action: 'mount', proposalId: proposed.proposalId, qualificationId: qualified.qualificationId }))
      .toMatchObject({ ok: false, code: 'OWNER_REQUIRED' })
    expect(registered(m, 'x6t_adder')).toBe(false)
    owner.value = true
    const mounted = await tools.execute({ action: 'mount', proposalId: proposed.proposalId, qualificationId: qualified.qualificationId }) as J
    expect(mounted).toMatchObject({ ok: true, mounted: true, tool: 'x6t_adder', availableAfter: 'now' })
    expect(await m.tool('x6t_adder').execute({ input: { a: 19, b: 23 } })).toMatchObject({ ok: true, result: { sum: 42 }, readOnly: true })
    // The cell journal has the run (a forged cell's line names it).
    const journal = await m.tool('x6_cell').execute({ action: 'journal' }) as { lines: J[] }
    expect(journal.lines.some(line => line.cell === 'forged:adder' && line.status === 'ok')).toBe(true)
    const after = await index()
    expect(after.counts.tools).toBe(Number(before.counts.tools) + 1)
    expect(after.counts.readOnlyTools).toBe(Number(before.counts.readOnlyTools) + 1)
    expect(after.registeredTools.find(tool => tool.name === 'x6t_adder')).toMatchObject({ readOnly: true, mutating: false })
    // A new runtime over the same home registers it at boot.
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    const reloaded = await mountRuntime(owner, vfs)
    expect(await reloaded.m.tool('x6t_adder').execute({ input: { a: 1, b: 2 } })).toMatchObject({ ok: true, result: { sum: 3 } })
    expect(await reloaded.m.tool('x6_tools').execute({ action: 'unmount', name: 'adder' })).toMatchObject({ ok: true, unmounted: true })
    expect(registered(reloaded.m, 'x6t_adder')).toBe(false)
    expect((await reloaded.m.tool('x6_capability_index').execute({ action: 'snapshot' }) as { counts: J }).counts.tools).toBe(before.counts.tools)
    expect([...vfs.readdirSync(TOOL_MOUNTED_DIR)]).toEqual([])
  }, 120_000)
})
