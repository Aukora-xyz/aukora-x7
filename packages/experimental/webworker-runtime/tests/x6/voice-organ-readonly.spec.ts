/**
 * The organ tools her voice may call, each proven read-only on the
 * exact bytes HEAD mounts (mirror/home/balls/<sha256>.js, the repository's epoch-173 copy), and the pins that hold them.
 *
 * Each pinned (tool, value) runs through the tool the organ itself registers, on made-up homes (populated, empty,
 * legacy-only), once per value of every property of that tool's own schema, with all properties at once, with
 * write-shaped arguments it does not declare, and with its selector absent. After every call: the home's tree digest is
 * unchanged, the file system saw only read methods and no mutation event, nothing outward was attempted (fetch,
 * sockets, any module but fs, path, crypto), and the organ touched no other part of its context (no organs.call, no
 * ctx.tools, configEditor, scion, snapshots). Positive controls prove the probe sees a write, an outward request and
 * the loader's cache fill. Nothing here reads her live home: every byte of content is made up.
 */
import { createHash } from 'node:crypto'
import * as nodeCrypto from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { compileFunction } from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryVfs } from '../../src/storage/memory.ts'
import { syncCandidateBallsStore } from '../../src/x6/ball-loader.ts'
import { VOICE_ORGAN_PINS } from '../../src/x6/voice-organ-pins.ts'
import { VOICE_ORGAN_CHANGED_REFUSAL, voiceVerdict } from '../../src/x6/voice-read-only.ts'

type Json = Record<string, unknown>
type Execute = (input: unknown) => unknown

const REPO_ROOT = path.resolve(import.meta.dirname, '../../../../..')
const MIRROR = path.join(REPO_ROOT, 'mirror/home')
const HEAD = JSON.parse(readFileSync(path.join(MIRROR, 'auma/HEAD.json'), 'utf8')) as { entries: Record<string, { specifier?: string }> }
const sha256 = (bytes: string | Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
const R10 = 'that organ changed since it was checked for voice'
const LOOK = 'VOICE_LOOK_ONLY: I can look, I cannot change things from voice yet.'

const PROOF = {
  preset: 'T6 preset_inspect (auma-preset-inspector): document, inventory, roster change nothing',
  recall: 'T6 recall (auma-memory-domain): changes nothing whatever its arguments',
  dag: 'T6 auma_memory_dag (auma-memory-domain): dag_verify changes nothing',
  superagent: 'T6 auma_superagent (seed-superagent): status changes nothing',
} as const

/**
 * Proven read-only here, but held out of voice: recall answers with the words of every thread in this browser, verbatim,
 * and voice has no secret-shape filter around it yet. Its pin comes back once that filter wraps it.
 */
const HELD = [{ tool: 'recall', organId: 'auma-memory-domain', selector: 'whole', allowed: [] as string[], proof: PROOF.recall }] as const

/** The bytes HEAD mounts for an organ entry, checked against their own content address. */
function organSource(organId: string): { sha: string; code: string } {
  const specifier = HEAD.entries[organId]?.specifier
  if (typeof specifier !== 'string' || !/^ball:[a-f0-9]{64}$/.test(specifier)) throw new Error(`no ball for ${organId}`)
  const sha = specifier.slice(5)
  const bytes = readFileSync(path.join(MIRROR, 'balls', `${sha}.js`))
  if (sha256(bytes) !== sha) throw new Error(`the ball bytes of ${organId} do not match their name`)
  return { sha, code: bytes.toString('utf8') }
}

// ---------------------------------------------------------------- the probe
const READ_METHODS = new Set(['existsSync', 'readFileSync', 'statSync', 'lstatSync', 'readdirSync', 'realpathSync'])
const OUTWARD_GLOBALS = ['fetch', 'WebSocket', 'EventSource', 'XMLHttpRequest'] as const

interface Probe {
  readonly vfs: MemoryVfs
  /** What an organ is given: every method call is recorded by name. */
  readonly fs: MemoryVfs
  readonly fsCalls: string[]
  readonly mutations: unknown[]
  readonly outward: string[]
  /** Context properties and service members touched while a call runs. */
  readonly touched: string[]
  calling: boolean
}

function probeOf(vfs: MemoryVfs): Probe {
  const probe: Probe = { vfs, fs: vfs, fsCalls: [], mutations: [], outward: [], touched: [], calling: false }
  const fs = new Proxy(vfs, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target) as unknown
      if (typeof value !== 'function') {
        if (prop === 'promises') probe.fsCalls.push('promises')
        return value
      }
      return (...args: unknown[]) => {
        probe.fsCalls.push(String(prop))
        return (value as (...a: unknown[]) => unknown).apply(target, args)
      }
    },
  })
  vfs.subscribe((mutation) => { probe.mutations.push(mutation) })
  for (const name of OUTWARD_GLOBALS) {
    vi.stubGlobal(name, (...args: unknown[]) => {
      probe.outward.push(`${name}:${String(args[0]).slice(0, 80)}`)
      throw new Error(`T6: ${name} is outward`)
    })
  }
  return Object.assign(probe, { fs })
}

/** A service the organ may hold but must not touch during a voice read: every member access is recorded. */
function watchedService(probe: Probe, name: string, members: Json = {}): unknown {
  return new Proxy(members, {
    get(target, prop) {
      if (typeof prop === 'symbol' || prop === 'then') return undefined
      if (probe.calling) probe.touched.push(`${name}.${prop}`)
      return target[prop]
    },
  })
}

/** The organ's context. Only `tools.register` works, and only while mounting; anything touched in a call is recorded. */
function organContext(probe: Probe, registered: Map<string, { execute: Execute; inputSchema: Json }>, agentPresets?: Json): Json {
  const tools = {
    register(name: string, def: { execute: Execute; inputSchema: Json }) {
      if (probe.calling) throw new Error('T6: a tool was registered during a call')
      registered.set(name, def)
      return () => { registered.delete(name) }
    },
  }
  const services: Json = {
    fs: probe.fs,
    tools: watchedService(probe, 'tools', tools),
    organs: watchedService(probe, 'organs', { call: () => { throw new Error('T6: organs.call') } }),
    agentPresets: agentPresets === undefined ? undefined : watchedService(probe, 'agentPresets', agentPresets),
  }
  for (const name of ['configEditor', 'scion', 'snapshots', 'web', 'systemPrompt', 'presence', 'wasm', 'checkpointPolicy']) {
    services[name] = watchedService(probe, name)
  }
  return new Proxy(services, {
    get(target, prop) {
      if (typeof prop === 'symbol') return undefined
      if (probe.calling) probe.touched.push(`ctx.${prop}`)
      return target[prop]
    },
  })
}

/** Evaluate a CommonJS organ with `fs` bound to the given file system; any other module but path and crypto is refused. */
function loadCommonJs(code: string, fs: unknown, outward: string[]): Json {
  const mod = { exports: {} as Json }
  const requireShim = (name: string): unknown => {
    if (name === 'fs' || name === 'node:fs') return fs
    if (name === 'path' || name === 'node:path') return path.posix
    if (name === 'crypto' || name === 'node:crypto') return nodeCrypto
    outward.push(`require:${name}`)
    throw new Error(`T6: ${name} is not given to an organ here`)
  }
  const body = compileFunction(code, ['require', 'module', 'exports']) as (...args: unknown[]) => unknown
  body(requireShim, mod, mod.exports)
  return mod.exports
}

/** seed-superagent and self/auma-x6-inspect are ES modules (`export const name`, `export function apply`): only those two
 * keywords are dropped. */
function loadSuperagent(code: string, fs: unknown, outward: string[]): { apply: (ctx: Json) => void } {
  const body = code.replace(/^(\s*)export const name = /m, '$1const name = ').replace(/^(\s*)export function apply\(/m, '$1function apply(')
  if (/^\s*(?:export|import)\s/m.test(body)) throw new Error('T6: an ES organ has another module statement')
  const processShim = {
    getBuiltinModule(name: string): unknown {
      if (name === 'node:fs') return fs
      if (name === 'node:crypto') return nodeCrypto
      outward.push(`builtin:${name}`)
      return null
    },
  }
  const evaluate = compileFunction(`${body}\nreturn { name, apply }`, ['process', 'require']) as (...args: unknown[]) => unknown
  return evaluate(processShim, undefined) as { apply: (ctx: Json) => void }
}

/** Digest of the whole tree: every directory, every file's path, size and SHA-256. */
function treeDigest(vfs: MemoryVfs): string {
  const hash = createHash('sha256')
  const walk = (dir: string): void => {
    for (const name of [...vfs.readdirSync(dir)].map(String).sort()) {
      const full = dir === '/' ? `/${name}` : `${dir}/${name}`
      if (vfs.lstatSync(full).isDirectory()) {
        hash.update(`d ${full}\n`)
        walk(full)
      } else {
        const bytes = vfs.readFileSync(full) as Uint8Array
        hash.update(`f ${full} ${bytes.length} ${sha256(bytes)}\n`)
      }
    }
  }
  walk('/')
  return hash.digest('hex')
}

/** Run one call and require that it changed nothing and reached nothing. Returns the tool's answer. */
async function provenRead(probe: Probe, label: string, run: () => unknown, mayTouch: readonly string[]): Promise<unknown> {
  const before = treeDigest(probe.vfs)
  probe.fsCalls.length = 0
  probe.mutations.length = 0
  probe.outward.length = 0
  probe.touched.length = 0
  probe.calling = true
  let answer: unknown
  try {
    answer = await run()
  } catch (error) {
    answer = { threw: String(error) }
  } finally {
    await new Promise(resolve => setTimeout(resolve, 0))
    probe.calling = false
  }
  const writes = probe.fsCalls.filter(name => !READ_METHODS.has(name))
  const touched = probe.touched.filter(name => !mayTouch.includes(name))
  expect({ label, digest: treeDigest(probe.vfs), writes, mutations: probe.mutations.length, outward: [...probe.outward], touched })
    .toEqual({ label, digest: before, writes: [], mutations: 0, outward: [], touched: [] })
  return answer
}

// ---------------------------------------------------------------- made-up homes
const SECRET = 'made-up-private-value-7f3a'

function sessionFile(id: string, lines: Array<{ role: 'user' | 'assistant'; text: string }>): string {
  const events = lines.map((line, seq) => line.role === 'user'
    ? { seq, time: 1_700_000_000_000 + seq, type: 'user/message', surfaceOp: 'append',
      data: { id: `${id}-m${seq}`, role: 'user', content: [{ type: 'text', text: line.text }], source: { kind: 'user' } } }
    : { seq, time: 1_700_000_000_000 + seq, type: 'assistant/message', surfaceOp: 'append',
      data: { message: { id: `${id}-m${seq}`, role: 'assistant', content: [{ type: 'text', text: line.text }] } } })
  events.push({ seq: events.length, time: 1_700_000_000_100, type: 'session/title', data: { title: 'made-up' } } as never)
  return [{ type: 'session', version: 4, id, cwd: '/dsh/home/auma' }, ...events].map(row => JSON.stringify(row)).join('\n') + '\n'
}

const LEGACY_STORE = JSON.stringify({ version: 1, lastIndexedAt: 0, sessionChunks: [],
  facts: [{ id: 'legacy-1', key: 'fern', fact: 'The ferns are watered on Tuesdays.', source: 'made-up', createdAt: 5 }] })

/** Three homes. The populated one is written by the organs' own writing actions (remember, a correction, receipts). */
async function makeHome(kind: 'populated' | 'empty' | 'legacy-only'): Promise<MemoryVfs> {
  const vfs = new MemoryVfs()
  vfs.mkdirSync('/dsh/home/auma/private', { recursive: true })
  vfs.writeFileSync('/dsh/home/auma/private/secret-note.json', JSON.stringify({ id: 'x', key: SECRET, kind: 'secret' }))
  if (kind === 'empty') return vfs
  vfs.writeFileSync('/dsh/home/auma/memory-store.json', LEGACY_STORE)
  if (kind === 'legacy-only') return vfs
  vfs.mkdirSync('/dsh/home/sessions/made-up/session-one', { recursive: true })
  vfs.mkdirSync('/dsh/home/sessions/made-up/session-two', { recursive: true })
  vfs.writeFileSync('/dsh/home/sessions/made-up/session-one/session.v4.jsonl', sessionFile('session-one', [
    { role: 'user', text: 'The lighthouse word is marigold.' }, { role: 'assistant', text: 'I will keep marigold in mind.' }]))
  vfs.writeFileSync('/dsh/home/sessions/made-up/session-two/session.v4.jsonl', sessionFile('session-two', [
    { role: 'user', text: 'What colour is the kite?' }, { role: 'assistant', text: 'The kite is orange.' }]))
  vfs.mkdirSync('/dsh/home/balls', { recursive: true })
  vfs.writeFileSync('/dsh/home/balls/HEAD.json', JSON.stringify({ ballId: 'f'.repeat(64), epoch: 7 }))
  vfs.mkdirSync('/dsh/home/auma/superagent', { recursive: true })
  vfs.writeFileSync('/dsh/home/auma/superagent/state.json', JSON.stringify({ version: 1, updatedAt: 9, triggers: [], threads: [],
    mandates: [{ id: 'mdt_made_up', title: 'Tidy the garden notes', strength: 'explicit', scope: {}, budgetSteps: 3 }],
    tickets: [{ id: 'tkt_made_up', title: 'Water the ferns', state: 'open', mandateId: 'mdt_made_up', stoppedByPerson: false }],
    assignments: [{ id: 'asg_made_up', ticketId: 'tkt_made_up', executor: 'browser-worker', state: 'running', startedAt: 4,
      reports: [{ status: 'progress', note: 'halfway', at: 5 }], lastReport: 'progress' }],
    attention: [{ id: 'att_made_up', kind: 'assignment-waiting', resolved: false, detail: { note: 'needs a look' } }],
    outbox: [{ id: 'obx_made_up', status: 'pending' }] }))
  const nobody: string[] = []
  const receipts = loadCommonJs(organSource('seed-receipts').code, vfs, nobody) as { run: (a: Json, c: Json) => Promise<Json> }
  const memory = loadCommonJs(organSource('auma-memory-domain').code, vfs, nobody) as { run: (a: Json, c: Json) => Promise<Json> }
  const writer = {
    fs: vfs,
    snapshots: { persistenceState: () => ({ writable: true }), flush: () => Promise.resolve({ localSaved: true }) },
    organs: { call: (_name: string, args: Json) => receipts.run(args, { fs: vfs }) },
  }
  for (const fact of [{ key: 'kite', fact: 'The kite is orange.' }, { key: 'lighthouse', fact: 'The lighthouse word is marigold.' },
    { key: 'kite', fact: 'The kite is orange with a green tail.' }]) {
    const out = await memory.run({ action: 'remember', source: 'made-up', tags: ['made-up'], ...fact }, writer)
    if (out.ok !== true) throw new Error(`fixture remember failed: ${JSON.stringify(out)}`)
  }
  if (nobody.length > 0) throw new Error(`fixture organs reached outward: ${nobody.join(', ')}`)
  return vfs
}
const HOMES = ['populated', 'empty', 'legacy-only'] as const

// ---------------------------------------------------------------- arguments: every schema property, the selector absent
const WRITE_SHAPED: Json = { action: 'remember', fact: 'made-up write', text: 'made-up write', key: 'made-up', memoryId: 'a'.repeat(64),
  corrects: 'a'.repeat(64), tombstones: 'a'.repeat(64), sessionId: 'session-one', facts: [{ fact: 'made-up' }], wish: 'made-up',
  note: 'made-up', approved: true, override: true, voiceAuthority: 'owner' }

function samples(schema: Json): unknown[] {
  if (Array.isArray(schema.enum)) return schema.enum
  switch (schema.type) {
    case 'string': return ['made-up', '', '../../private/secret-note', 'a'.repeat(64), 'marigold', 'auma-alien']
    case 'number': case 'integer': return [0, 1, typeof schema.maximum === 'number' ? schema.maximum : 25, -1]
    case 'boolean': return [true, false]
    case 'array': return [[], ['made-up'], ['a'.repeat(64)]]
    case 'object': return [{}, { made: 'up' }]
    default: return [null, 'made-up', {}]
  }
}

/** One set per value of every property of the tool's OWN schema, then all at once, then write-shaped extras. */
function argumentSets(inputSchema: Json, selector: string, value: string | undefined): Json[] {
  const properties = Object.entries((inputSchema.properties ?? {}) as Record<string, Json>).filter(([key]) => key !== selector)
  const base: Json = selector === 'whole' || value === undefined ? {} : { [selector]: value }
  const sets: Json[] = [base]
  for (const [key, schema] of properties) for (const sample of samples(schema)) sets.push({ ...base, [key]: sample })
  sets.push({ ...Object.fromEntries(properties.map(([key, schema]) => [key, samples(schema)[0]])), ...base })
  sets.push({ ...Object.fromEntries(properties.map(([key, schema]) => [key, samples(schema).at(-1)])), ...base })
  sets.push(selector === 'whole' ? { ...WRITE_SHAPED, query: 'marigold' } : { ...WRITE_SHAPED, ...base })
  // Coverage: every property of the schema appears in at least one set.
  for (const [key] of properties) expect(sets.some(set => Object.hasOwn(set, key)), key).toBe(true)
  return sets
}

interface Mounted { readonly probe: Probe; readonly tools: Map<string, { execute: Execute; inputSchema: Json }> }

async function mount(organId: string, kind: typeof HOMES[number], agentPresets?: Json): Promise<Mounted> {
  const probe = probeOf(await makeHome(kind))
  const tools = new Map<string, { execute: Execute; inputSchema: Json }>()
  const ctx = organContext(probe, tools, agentPresets)
  const { code } = organSource(organId)
  if (organId === 'seed-superagent') loadSuperagent(code, probe.fs, probe.outward).apply(ctx)
  else (loadCommonJs(code, probe.fs, probe.outward) as { setup: (c: Json) => unknown }).setup(ctx)
  expect(probe.outward).toEqual([])
  return { probe, tools }
}

/** Every pinned value and the selector absent, every argument set, on every home. */
async function proveRow(organId: string, tool: string, mayTouch: readonly string[],
  agentPresets?: () => Json): Promise<Map<string, unknown[]>> {
  const pin = [...VOICE_ORGAN_PINS, ...HELD].find(row => row.tool === tool && row.organId === organId)
  expect(pin, `${tool} is pinned or held`).toBeDefined()
  const answers = new Map<string, unknown[]>()
  for (const kind of HOMES) {
    const { probe, tools } = await mount(organId, kind, agentPresets?.())
    const def = tools.get(tool)
    expect(def, `${organId} registers ${tool}`).toBeDefined()
    const values: Array<string | undefined> = pin!.selector === 'whole' ? [undefined] : [...pin!.allowed, undefined]
    for (const value of values) {
      for (const args of argumentSets(def!.inputSchema, pin!.selector, value)) {
        const answer = await provenRead(probe, `${kind} ${tool} ${JSON.stringify(args)}`, () => def!.execute(args), mayTouch)
        const key = `${kind}:${value ?? 'absent'}`
        answers.set(key, [...answers.get(key) ?? [], answer])
      }
    }
  }
  return answers
}

const parsed = (answer: unknown): Json => {
  const out = answer as Json
  return typeof out?.output === 'string' ? JSON.parse(out.output) as Json : out
}

afterEach(() => { vi.unstubAllGlobals() })

describe('T6: each pinned or held organ action changes nothing (made-up homes, every schema property, selector absent)', () => {
  it(PROOF.preset, async () => {
    const presets = (): Json => ({
      list: () => Promise.resolve([{ id: 'auma-alien', name: 'Auma' }, { id: 'made-up' }]),
      readDocument: (id: string) => id === 'auma-alien' ? Promise.resolve({ agentPreset: id, content: '- made-up-plugin\n' })
        : Promise.reject(new Error(`Unknown agent preset: ${id}`)),
      compositionInventory: () => Promise.resolve([{ id: 'auma-alien', isDefault: true, rows: [] }]),
    })
    // The real service's three members are reads (agent-preset-registry/src/index.ts:193-205, 234-249, 403-414).
    const reads = ['ctx.agentPresets', 'agentPresets.list', 'agentPresets.readDocument', 'agentPresets.compositionInventory']
    const answers = await proveRow('auma-preset-inspector', 'preset_inspect', reads, presets)
    expect(answers.get('populated:roster')?.[0]).toMatchObject({ ok: true, mode: 'roster', roster: [{ id: 'auma-alien' }, { id: 'made-up' }] })
    expect(answers.get('populated:document')?.find(a => (a as Json).ok === true)).toMatchObject({ mode: 'document', id: 'auma-alien' })
    expect(answers.get('populated:inventory')?.[0]).toMatchObject({ ok: true, mode: 'inventory' })
    expect(answers.get('populated:absent')?.[0]).toMatchObject({ ok: true, mode: 'roster' })
  })

  it(PROOF.recall, async () => {
    const answers = await proveRow('auma-memory-domain', 'recall', ['ctx.fs'])
    const found = answers.get('populated:absent')!.map(parsed).filter(a => a.ok === true && Array.isArray(a.hits) && a.hits.length > 0)
    expect(found.length).toBeGreaterThan(0)
    expect(JSON.stringify(found)).toContain('marigold')
    // The write-shaped call (action remember, fact, facts...) still only recalled.
    expect(answers.get('populated:absent')!.map(parsed).every(a => a.action === undefined || a.action === 'recall')).toBe(true)
  })

  it(PROOF.dag, async () => {
    const answers = await proveRow('auma-memory-domain', 'auma_memory_dag', ['ctx.fs'])
    const verified = answers.get('populated:dag_verify')!.map(parsed)
    expect(verified.every(a => a.action === 'dag_verify')).toBe(true)
    expect(verified[0]).toMatchObject({ ok: true, errors: [] })
    expect(verified[0]!.reachableNodes).toBeGreaterThanOrEqual(3)
    expect(answers.get('populated:absent')!.map(parsed).every(a => a.error === 'UNKNOWN_ACTION' || a.action === 'dag_verify')).toBe(true)
  })

  it(PROOF.superagent, async () => {
    const answers = await proveRow('seed-superagent', 'auma_superagent', [])
    const status = answers.get('populated:status')!.map(parsed)
    expect(status.every(a => a.schema === 'auma.superagent.status.v1')).toBe(true)
    expect(status[0]).toMatchObject({ ok: true, counts: { tickets: 1, assignments: 1, outboxPending: 1 } })
    expect(answers.get('populated:absent')!.map(parsed).every(a => a.error === 'unknown-action')).toBe(true)
  })
})

describe('left out, and the probe sees what it must (positive controls)', () => {
  it('remember writes: the probe sees the write (control), and no pin lists it', async () => {
    const { probe, tools } = await mount('auma-memory-domain', 'populated')
    expect(tools.has('remember')).toBe(true)
    const before = treeDigest(probe.vfs)
    const memory = loadCommonJs(organSource('auma-memory-domain').code, probe.fs, probe.outward) as { run: (a: Json, c: Json) => Promise<Json> }
    const out = await memory.run({ action: 'remember', fact: 'made-up', key: 'made-up', source: 'made-up' },
      { fs: probe.fs, snapshots: { persistenceState: () => ({ writable: true }), flush: () => Promise.resolve({ localSaved: true }) } })
    expect(out.ok).toBe(true)
    expect(treeDigest(probe.vfs)).not.toBe(before)
    expect(probe.fsCalls).toContain('writeFileSync')
    expect(probe.mutations.length).toBeGreaterThan(0)
  })

  it('auma_memory_dag dag_lineage is left out: nodeId is joined into a path, so ../ reads outside the memory folder', async () => {
    const { probe, tools } = await mount('auma-memory-domain', 'populated')
    const out = parsed(await tools.get('auma_memory_dag')!.execute({ action: 'dag_lineage', nodeId: '../../private/secret-note' }))
    expect(JSON.stringify(out)).toContain(SECRET)
    expect(probe.outward).toEqual([])
  })

  it('a canonical-name organ call is left out: the loader first copies staged organ files into the balls store', async () => {
    const vfs = await makeHome('empty')
    const code = "module.exports = { name: 'made-up-candidate', run() { return {} } }\n"
    vfs.mkdirSync('/dsh/home/auma/seed/candidates', { recursive: true })
    vfs.writeFileSync('/dsh/home/auma/seed/candidates/made-up-candidate.js', code)
    const before = treeDigest(vfs)
    // ball-loader.ts wrapSeedOrganAsCordisPlugin: every canonical organ tool call runs this before the organ.
    expect(syncCandidateBallsStore(vfs)).toBe(1)
    expect(treeDigest(vfs)).not.toBe(before)
    expect(vfs.existsSync(`/dsh/home/balls/${sha256(code)}.js`)).toBe(true)
  })

  it('auma_eyes is left out: every action posts to the host (the probe sees the outward request)', async () => {
    const probe = probeOf(await makeHome('empty'))
    const eyes = loadCommonJs(organSource('auma-eyes').code, probe.fs, probe.outward) as { run: (a: Json, c: Json) => Promise<Json> }
    await expect(eyes.run({ action: 'projection' }, { fs: probe.fs })).rejects.toThrow('outward')
    expect(probe.outward.join()).toContain('/_host/eyes')
  })

  // Not pinned (the loader's cache fill above), but proven at organ level so a later pin is one row each.
  it('organ level only, not pinned: seed_memory recall/stats, seed_wish read/status, seed_receipts verify/list change nothing', async () => {
    for (const kind of HOMES) {
      const probe = probeOf(await makeHome(kind))
      probe.vfs.mkdirSync('/dsh/home/auma/seed', { recursive: true })
      const seedFiles = [['CONTEXT.md', 'Made-up context: the kite is orange.'], ['WISH.md', '# Wish\n\nMade-up.\n']] as const
      for (const [file, text] of seedFiles) {
        if (kind === 'populated') probe.vfs.writeFileSync(`/dsh/home/auma/seed/${file}`, text)
      }
      const rows: Array<[string, Json[]]> = [
        ['seed-memory', [{ action: 'recall', query: 'kite' }, { action: 'recall', query: 'kite', limit: 99, note: 'x' }, { action: 'stats' },
          { action: 'stats', query: 'x', note: 'x', limit: 1 }, { action: 'recall' }]],
        ['seed-wish', [{ action: 'read' }, { action: 'status' }, { action: 'read', wish: 'x', acceptance: 'y' }, { action: 'status', wish: 'x' }]],
        ['seed-receipts', [{ action: 'verify' }, { action: 'verify', expectedPublicKey: 'a'.repeat(64) }, { action: 'verify', expectedPublicKey: 'zz' },
          { action: 'list' }, { action: 'verify', kind: 'x', data: {}, envelope: {}, note: 'x' }]],
      ]
      for (const [organId, sets] of rows) {
        const organ = loadCommonJs(organSource(organId).code, probe.fs, probe.outward) as { run: (a: Json, c: Json) => unknown }
        for (const args of sets) await provenRead(probe, `${kind} ${organId} ${JSON.stringify(args)}`, () => organ.run(args, { fs: probe.fs }), [])
      }
    }
  })
})

describe('the pins', () => {
  it('the shipped rows are exactly the proven ones, on the bytes HEAD mounts in the mirror today', () => {
    expect(VOICE_ORGAN_PINS.map(pin => [pin.tool, pin.organId, pin.selector, [...pin.allowed]])).toEqual([
      ['preset_inspect', 'auma-preset-inspector', 'mode', ['document', 'inventory', 'roster']],
      ['auma_memory_dag', 'auma-memory-domain', 'action', ['dag_verify']],
      ['auma_superagent', 'seed-superagent', 'action', ['status']],
    ])
    for (const pin of VOICE_ORGAN_PINS) {
      expect(pin.sha256).toBe(organSource(pin.organId).sha)
      expect(Object.values(PROOF)).toContain(pin.proof)
      expect(Object.isFrozen(pin) && Object.isFrozen(pin.allowed)).toBe(true)
    }
    expect(Object.isFrozen(VOICE_ORGAN_PINS)).toBe(true)
  })

  it('recall is held out of voice: it hands back a pasted key-shaped string from any thread, verbatim', async () => {
    const pasted = 'sk-made-up-0123456789abcdefABCDEF'
    const { probe, tools } = await mount('auma-memory-domain', 'populated')
    probe.vfs.mkdirSync('/dsh/home/sessions/made-up/session-three', { recursive: true })
    probe.vfs.writeFileSync('/dsh/home/sessions/made-up/session-three/session.v4.jsonl', sessionFile('session-three', [
      { role: 'user', text: `Here is the garden key ${pasted} for later.` }, { role: 'assistant', text: 'Noted.' }]))
    const answer = parsed(await provenRead(probe, 'recall a pasted key', () => tools.get('recall')!.execute({ query: 'garden key' }), ['ctx.fs']))
    expect(JSON.stringify(answer.sessionHits)).toContain(pasted)
    // So no row lets it into voice, on its checked bytes or any other.
    expect(VOICE_ORGAN_PINS.some(pin => pin.tool === 'recall')).toBe(false)
    const memory = organSource('auma-memory-domain').sha
    expect(voiceVerdict({ tool: 'recall', args: { query: 'garden key' }, origin: { kind: 'organ', organId: 'auma-memory-domain', organSha: memory } }))
      .toContain(LOOK)
  })

  it('a pinned row passes only with its bytes and a listed value; a changed organ leaves voice with the R10 sentence', () => {
    const verdict = (tool: string, args: unknown, organId: string, organSha: string | null) =>
      voiceVerdict({ tool, args, origin: { kind: 'organ', organId, organSha } })
    for (const pin of VOICE_ORGAN_PINS) {
      const values = pin.selector === 'whole' ? [undefined] : pin.allowed
      for (const value of values) {
        const args = value === undefined ? { query: 'kite' } : { [pin.selector]: value }
        expect(verdict(pin.tool, args, pin.organId, pin.sha256)).toBeUndefined()
        expect(verdict(pin.tool, args, pin.organId, 'c'.repeat(64))).toBe(VOICE_ORGAN_CHANGED_REFUSAL)
        expect(verdict(pin.tool, args, pin.organId, null)).toBe(VOICE_ORGAN_CHANGED_REFUSAL)
        expect(VOICE_ORGAN_CHANGED_REFUSAL).toContain(R10)
        // The same tool name served by another organ is not pinned.
        expect(verdict(pin.tool, args, 'made-up-organ', pin.sha256)).toContain(LOOK)
      }
      if (pin.selector !== 'whole') {
        // A selector the executor would default must be explicit from voice.
        expect(verdict(pin.tool, {}, pin.organId, pin.sha256)).toContain(LOOK)
        expect(verdict(pin.tool, { [pin.selector]: ['status'] }, pin.organId, pin.sha256)).toContain(LOOK)
      }
    }
    const memory = organSource('auma-memory-domain').sha
    for (const action of ['dag_write', 'dag_lineage', 'remember']) expect(verdict('auma_memory_dag', { action }, 'auma-memory-domain', memory)).toContain(LOOK)
    expect(verdict('remember', { fact: 'made-up' }, 'auma-memory-domain', memory)).toContain(LOOK)
    const superagent = organSource('seed-superagent').sha
    for (const action of ['trigger', 'confirm', 'assign', 'report', 'stop', 'outbox_flush', 'heartbeat', 'check_heartbeats', 'constructor']) {
      expect(verdict('auma_superagent', { action }, 'seed-superagent', superagent)).toContain(LOOK)
    }
    expect(verdict('preset_inspect', { mode: 'install' }, 'auma-preset-inspector', organSource('auma-preset-inspector').sha)).toContain(LOOK)
    const unpinned = [['seed_memory', 'seed-memory'], ['seed_wish', 'seed-wish'], ['seed_receipts', 'seed-receipts'],
      ['seed_aura', 'seed-aura'], ['auma_eyes', 'auma-eyes'], ['seed_recall', 'seed-recall']] as const
    for (const [tool, organId] of unpinned) {
      expect(verdict(tool, { action: 'read' }, organId, organSource(organId).sha)).toContain(LOOK)
    }
  })
})

// ---------------------------------------------------------------- the switch table
/**
 * Every organ HEAD mounts in the mirror (epoch 173), on its ball bytes: the tools it registers, the argument that selects
 * the action, and for each value READ, CHANGES, OUTWARD or REFUSES with the lines that decide it (`b:` = that organ's
 * ball, mirror/home/balls/<sha>.js). The tool names, how they are registered and the selector values are checked
 * below against the bytes; the READ/CHANGES words are SOURCE (read), and only pinned or held rows were run under T6.
 * A tool served under the organ's canonical name (`via: 'canonical'`) is OUT whatever its actions do: the loader copies
 * staged organ files into the balls store before each such call (ball-loader.ts syncCandidateBallsStore, control above).
 */
interface SwitchRow {
  readonly tool: string
  readonly via: 'setup' | 'apply' | 'canonical'
  /** The argument that picks the action, with its default when absent; `whole` for a single-purpose tool. */
  readonly selector: string
  readonly absent?: string
  readonly actions: Readonly<Record<string, string>>
  /** PINNED, HELD: why, or OUT: why. */
  readonly voice: string
}
const CANON = 'OUT: canonical-name tool, the loader writes before each call'
const SWITCH_TABLE: Readonly<Record<string, readonly SwitchRow[]>> = {
  'auma-body-map': [{ tool: 'body_map', via: 'setup', selector: 'mode', absent: 'full (b:121)', actions: {
    full: 'CHANGES+OUTWARD: writes and unlinks /dsh/home/auma/.afferent-probe (b:176-182); ctx.web.fetch /_mirror/status (b:196-203)',
    afferent_probe: 'CHANGES+OUTWARD: as full (b:173)',
    summary: 'OUTWARD: every mode first awaits ctx.snapshots.checkHostHead (b:140-142), which fetches /_head/ball',
    effects: 'OUTWARD: checkHostHead (b:140-142), then returns the effect ledger (b:148-149)',
    motor_memory: 'OUTWARD: checkHostHead (b:140-142), then returns motor memory (b:151-152)' },
  voice: 'OUT: no mode is a pure read' }],
  'auma-eyes': [{ tool: 'auma_eyes', via: 'canonical', selector: 'action', absent: 'projection (b:56)', actions: {
    projection: 'OUTWARD: POST /_host/eyes (b:17, b:57)',
    screenshot: 'OUTWARD+CHANGES: POST /_host/eyes, then writes two latest.png captures (b:66-69)' }, voice: `${CANON}; posts to the host` }],
  'auma-memory-domain': [
    { tool: 'remember', via: 'setup', selector: 'whole', actions: { '*': 'CHANGES: forces action remember (b:691); saves the store (b:643)' }, voice: 'OUT: writes' },
    { tool: 'recall', via: 'setup', selector: 'whole', actions: { '*': 'READ: forces action recall (b:697); merges sessions in memory, never saves (b:397-446)' },
      voice: 'HELD: returns thread text verbatim with no secret-shape filter' },
    { tool: 'auma_memory_dag', via: 'setup', selector: 'action', absent: 'UNKNOWN_ACTION (b:562-569)', actions: {
      dag_verify: 'READ (b:566, b:522-550)', dag_lineage: 'READ, but nodeId is joined into a path: ../ escapes (b:567, RAN above)',
      dag_write: 'CHANGES (b:568-)' }, voice: 'PINNED: dag_verify only' }],
  'auma-preset-inspector': [{ tool: 'preset_inspect', via: 'setup', selector: 'mode', absent: 'roster (b:12)', actions: {
    roster: 'READ: agentPresets.list (b:29)', document: 'READ: agentPresets.readDocument (b:14-21)',
    inventory: 'READ: agentPresets.compositionInventory (b:24-26)' }, voice: 'PINNED' }],
  'auma-scion': [{ tool: 'auma_scion', via: 'canonical', selector: 'action', absent: 'UNAVAILABLE (b:19)', actions: {
    compile_organ: 'CHANGES: ctx.scion.compileOrgan prepares a ball (b:20-21)', compile_runtime: 'REFUSES: UNAVAILABLE, no effect (b:19)',
    stage_release: 'REFUSES: UNAVAILABLE, no effect (b:19)' }, voice: CANON }],
  'auma-text-metrics': [{ tool: 'auma_text_metrics', via: 'canonical', selector: 'whole', actions: { '*': 'READ: counts words in the given text (b:30-39)' }, voice: CANON }],
  'auma-web-eyes': [{ tool: 'auma_web_eyes', via: 'canonical', selector: 'action', absent: 'inferred: url fetch, query search, else status (b:119)', actions: {
    status: 'READ: reports the pinned providers (b:120-128)', fetch: 'OUTWARD: POST /_host/web-eyes (b:137-142, b:16)',
    search: 'OUTWARD: POST /_host/web-eyes (b:144-149, b:16)', web_service_fetch: 'OUTWARD: ctx.web.fetch (b:130-135)' }, voice: `${CANON}; three actions go outward` }],
  'auma-cortex': [{ tool: 'auma_cortex', via: 'canonical', selector: 'action', absent: 'CORTEX_ACTION_UNKNOWN (b:239)', actions: Object.fromEntries(
    ['resident', 'index', 'explain', 'search', 'threads', 'bitLedger'].map(a => [a, 'READ: no write verb, readFileSync only (b:1-8, b:57-62, b:227-240)'])), voice: CANON }],
  'seed': [{ tool: 'seed', via: 'canonical', selector: 'action', absent: 'unknown action (b:148)', actions: {
    status: 'READ: manifest and ledger (b:147)', init: 'CHANGES: writes manifest, WISH, CONTEXT (b:34-39)', put: 'CHANGES: writes an organ file, manifest, ledger (b:42-57)',
    install: 'CHANGES: ctx.organs.install (b:60-70)', undo: 'CHANGES: ctx.organs.undo (b:136-142)', retire: 'CHANGES: ctx.organs.retire (b:136-142)',
    test: 'CHANGES: organs.call, then a ledger row (b:73-89)', verify: 'CHANGES: test, then ctx.organs.undo (b:92-102)', pack: 'CHANGES: writes a pack and a ledger row (b:105-123)' }, voice: CANON }],
  'seed-audit': [{ tool: 'seed_audit', via: 'canonical', selector: 'action', absent: 'scan (b:49-55)', actions: {
    scan: 'READ (b:11-20, b:49-55)', lineage: 'READ: balls/HEAD.json (b:21-41, b:48)', fix: 'CHANGES: rewrites the manifest (b:56-59)' }, voice: CANON }],
  'seed-aura': [{ tool: 'seed_aura', via: 'canonical', selector: 'action', absent: 'UNKNOWN_ACTION (b:523)', actions: {
    read: 'READ at organ level (b:520-521)', dry_run: 'READ at organ level (b:538); the loader sends every seed_aura call through organs.call, which fetches and writes',
    compute: 'CHANGES: writes aura and a receipt through organs.call (b:543-552)' }, voice: `${CANON}; the loader path fetches and writes` }],
  'seed-boot': [{ tool: 'seed_boot', via: 'canonical', selector: 'action', absent: 'reads the pack, then unknown action (b:29-32)', actions: {
    verify: 'READ: any packPath (b:29-31)', extract: 'CHANGES: writes the pack out and runs its hello organ (b:33-45)' }, voice: CANON }],
  'seed-calc': [{ tool: 'seed_calc', via: 'canonical', selector: 'whole', actions: { '*': 'READ: pure sum (b:6-8)' }, voice: CANON }],
  'seed-continuity': [{ tool: 'seed_continuity', via: 'canonical', selector: 'action', absent: 'verify (b:335)', actions: {
    verify: 'READ (b:338)', selftest: 'READ: flips a byte of an in-memory copy (b:266-292)', seal: 'CHANGES: writes the baseline (b:317)' }, voice: CANON }],
  'seed-cycle': [{ tool: 'seed_cycle', via: 'canonical', selector: 'action', absent: 'unknown action (b:59)', actions: {
    status: 'READ: manifest (b:55-57)', grow: 'CHANGES: writes an organ, manifest and ledger, organs.call (b:59-133)' }, voice: CANON }],
  'seed-hello': [{ tool: 'seed_hello', via: 'canonical', selector: 'whole', actions: { '*': 'READ: pure (b:5)' }, voice: CANON }],
  'seed-memory': [{ tool: 'seed_memory', via: 'canonical', selector: 'action', absent: 'unknown action (b:81)', actions: {
    recall: 'READ (b:76-79, RAN at organ level above)', stats: 'READ (b:61-63, RAN at organ level above)', remember: 'CHANGES: appends to the ledger (b:65-74)' }, voice: CANON }],
  'seed-nostr-anchor': [{ tool: 'seed_nostr_anchor', via: 'canonical', selector: 'action', absent: 'UNKNOWN_ACTION (b:215)', actions: Object.fromEntries(
    ['checkpoint', 'verify_checkpoint', 'vouch', 'vouch_slots'].map(a => [a, 'READ: pure, zero imports (b:208-216)'])), voice: CANON }],
  'seed-pearl': [{ tool: 'seed_pearl', via: 'canonical', selector: 'action', absent: 'UNKNOWN_ACTION (b:517)', actions: {
    observe: 'READ (b:505, b:465-477)', remember: 'CHANGES: appends a scar and a receipt (b:506, b:240-241, b:214-215)',
    challenge: 'CHANGES: ctx.scion.trialRetentionCandidate and a receipt (b:507, b:376)', seed: 'CHANGES: writes the suite, receipts, scars (b:508-516)' }, voice: CANON }],
  'seed-predict': [{ tool: 'seed_predict', via: 'canonical', selector: 'action', absent: 'UNKNOWN_ACTION (b:405)', actions: {
    register: 'CHANGES: appends and seals a receipt (b:203-, b:44-45, b:128-130)', observe: 'CHANGES: appends and seals a receipt (b:256-323)',
    trajectory_export: 'READ (b:325-387)', status: 'READ (b:389-403)' }, voice: CANON }],
  'seed-recall': [{ tool: 'seed_recall', via: 'canonical', selector: 'action', absent: 'UNKNOWN_ACTION (b:484)', actions: {
    recall: 'READ (b:470-472)', status: 'READ (b:470-472)', context: 'CHANGES: writes CONTEXT files (b:474-478, b:410-423)',
    corpus: 'CHANGES: writes the corpus (b:480-482, b:428-439)' }, voice: CANON }],
  'seed-receipts': [{ tool: 'seed_receipts', via: 'canonical', selector: 'action', absent: 'list (b:218)', actions: {
    verify: 'READ (b:309-, RAN at organ level above)', list: 'READ (b:218, RAN at organ level above)',
    append: 'CHANGES: appends a signed receipt (b:491-, b:121-124)', checkpoint: 'CHANGES: signs and appends a checkpoint (b:269-308)' }, voice: CANON }],
  'seed-repo-forge': [{ tool: 'seed_repo_forge', via: 'canonical', selector: 'action', absent: 'FORGE_ACTION_REQUIRED (b:120)', actions: {
    plan: 'READ (b:122-126)', search: 'OUTWARD read through ctx.x6Repo (b:128-135)', diff: 'OUTWARD read through ctx.x6Repo (b:137-149)',
    ci: 'OUTWARD read through ctx.x6Repo (b:173-182)', branch_create: 'CHANGES through ctx.x6Repo (b:151-157)', write: 'CHANGES: commits through ctx.x6Repo (b:159-171)',
    stage: 'CHANGES: stages a proposal through ctx.x6Repo (b:184-199)', merge_proposal: 'REFUSES: owner only (b:201-204)' }, voice: CANON }],
  'seed-superagent': [{ tool: 'auma_superagent', via: 'apply', selector: 'action', absent: 'unknown-action (b:668)', actions: {
    status: 'READ: state, receipts, HEAD (b:574)', ...Object.fromEntries(['trigger', 'subscribe', 'eval_accept', 'confirm', 'assign', 'heartbeat',
      'check_heartbeats', 'report', 'stop', 'outbox_flush'].map(a => [a, 'CHANGES: save(state) (b:252-571); confirm also organs.call seed-receipts (b:190-192)'])) },
  voice: 'PINNED: status only' }],
  'seed-voice-slot': [],
  'seed-wish': [{ tool: 'seed_wish', via: 'canonical', selector: 'action', absent: 'unknown action (b:26)', actions: {
    read: 'READ (b:12-14)', status: 'READ (b:12-14)', write: 'CHANGES: rewrites WISH.md (b:16-24)' }, voice: CANON }],
  'self/auma-x6-inspect': [{ tool: 'auma_x6_self_inspect', via: 'apply', selector: 'whole', actions: { '*': 'READ: presence.self and list (b:7-15)' },
    voice: 'OUT: not run under T6 (not asked for); a pin needs that proof first' }],
}

/** What an organ's bytes register, found by mounting them the way the loader does (ball-loader.ts unwrapPluginExport). */
function registered(organId: string): Array<{ tool: string; via: SwitchRow['via']; inputSchema: Json }> {
  const { code } = organSource(organId)
  const probe = probeOf(new MemoryVfs())
  const tools = new Map<string, { execute: Execute; inputSchema: Json }>()
  const ctx = organContext(probe, tools)
  if (/^\s*export function apply\(/m.test(code)) {
    loadSuperagent(code, probe.fs, probe.outward).apply(ctx)
    return [...tools].map(([tool, def]) => ({ tool, via: 'apply' as const, inputSchema: def.inputSchema }))
  }
  if (/^\s*export\s/m.test(code)) return []
  type Exported = { name?: unknown; run?: unknown; setup?: (c: Json) => unknown; parameters?: Json }
  const exported = loadCommonJs(code, probe.fs, probe.outward) as Exported
  if (typeof exported.setup === 'function') exported.setup(ctx)
  expect(probe.outward, organId).toEqual([])
  if (tools.size > 0) return [...tools].map(([tool, def]) => ({ tool, via: 'setup' as const, inputSchema: def.inputSchema }))
  if (typeof exported.run !== 'function' || typeof exported.name !== 'string') return []
  return [{ tool: exported.name.replace(/[^a-zA-Z0-9_-]/g, '_').replace(/-/g, '_'), via: 'canonical',
    inputSchema: exported.parameters ?? { type: 'object', properties: {} } }]
}

describe('the switch table covers every organ in the mirror (brief step 1)', () => {
  it('names every HEAD entry and every seed organ file, with the tools each one actually registers', () => {
    const seedFiles = readdirSync(path.join(MIRROR, 'auma/seed/organs')).filter(name => name.endsWith('.js')).map(name => name.slice(0, -3))
    expect(seedFiles.length).toBe(21)
    expect(Object.keys(HEAD.entries).length).toBe(27)
    expect(Object.keys(SWITCH_TABLE).sort()).toEqual([...new Set([...Object.keys(HEAD.entries), ...seedFiles])].sort())
    for (const [organId, rows] of Object.entries(SWITCH_TABLE)) {
      const found = registered(organId)
      expect(rows.map(row => [row.tool, row.via]), organId).toEqual(found.map(row => [row.tool, row.via]))
      for (const row of rows) {
        const schema = found.find(f => f.tool === row.tool)!.inputSchema
        const properties = (schema.properties ?? {}) as Record<string, Json>
        if (row.selector === 'whole') {
          expect(Object.keys(row.actions), `${organId} ${row.tool}`).toEqual(['*'])
          continue
        }
        // The selector is a property of the tool's own schema, and every value it lists is classified (and no other).
        if (Object.keys(properties).length > 0) expect(Object.hasOwn(properties, row.selector), `${organId} ${row.tool}`).toBe(true)
        const values: unknown = properties[row.selector]?.enum
        if (Array.isArray(values)) expect(Object.keys(row.actions).sort(), `${organId} ${row.tool}`).toEqual(values.map(String).sort())
        expect(row.absent, `${organId} ${row.tool} says what happens with no selector`).toBeTruthy()
        for (const verdict of Object.values(row.actions)) expect(verdict).toMatch(/^(READ|CHANGES|OUTWARD|REFUSES)/)
      }
    }
  })

  it('agrees with the pins: pinned values are READ, held and canonical rows stay out of voice', () => {
    for (const [organId, rows] of Object.entries(SWITCH_TABLE)) {
      for (const row of rows) {
        const pin = VOICE_ORGAN_PINS.find(p => p.organId === organId && p.tool === row.tool)
        const held = HELD.find(h => h.organId === organId && h.tool === row.tool)
        expect(row.voice.startsWith('PINNED'), `${organId} ${row.tool}`).toBe(pin !== undefined)
        expect(row.voice.startsWith('HELD'), `${organId} ${row.tool}`).toBe(held !== undefined)
        if (row.via === 'canonical') expect(row.voice).toMatch(/^OUT: canonical-name tool/)
        if (pin) {
          expect(pin.selector).toBe(row.selector)
          for (const value of pin.selector === 'whole' ? ['*'] : pin.allowed) expect(row.actions[value], `${row.tool} ${value}`).toMatch(/^READ \(|^READ:/)
        }
      }
    }
    expect(VOICE_ORGAN_PINS.every(pin => SWITCH_TABLE[pin.organId]?.some(row => row.tool === pin.tool))).toBe(true)
  })
})
