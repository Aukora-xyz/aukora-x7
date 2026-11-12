/**
 * Lane E5 task 4, NORTH-STAR §24.4 Milestone G1 item 2 (WO-3): the runtime storage write-set inventory, asserted.
 *
 * Static half: every VFS write site in src/x6 (and every seed-receipts append) maps to exactly one inventory entry, and
 * every entry still has a site, so an unanchored write path or a stale whitelist fails here. The derived report carries
 * the source SHA-256 per file and `file:line` per site.
 * Runtime half: the instrumented adapter runs the joined journey (stage, promote with a real seed-receipts append, invoke,
 * refusal, restart, next authorized mutation), recording operation ids, write sets, pre/post commitment roots and
 * refusal/effect counters; an injected out-of-context raw write is caught as unanchored, out-of-band drift is caught on
 * restart, and plain reads and receipt verification raise no false rollback.
 */
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { MemoryVfs } from '../../src/storage/memory.ts'
import { createTransitionContext, isTransitionKind } from '../../src/x6/transition-context.ts'
import {
  RUNTIME_WRITE_SET, WRITE_HELPERS, WRITE_SET_SCHEMA, authorityCommitmentRoot, classifyWritePath, createWriteSetRecorder,
} from '../../src/x6/write-set-inventory.ts'

const requireFromHere = createRequire(import.meta.url)
const X6_DIR = path.resolve(import.meta.dirname, '../../src/x6')
const REPO_ROOT = path.resolve(import.meta.dirname, '../../../../..')
const ADAPTER = 'write-set-inventory.ts'

/** The first call argument starting at `start` (just after the opening parenthesis), bracket- and string-aware. */
function firstArgument(source: string, start: number): string {
  let depth = 0, quote: string | null = null
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i]!
    if (quote) { if (ch === '\\') { i += 1; continue } if (ch === quote) quote = null; continue }
    if (ch === '\'' || ch === '"' || ch === '`') { quote = ch; continue }
    if (ch === '(' || ch === '[' || ch === '{') depth += 1
    else if (ch === ')' || ch === ']' || ch === '}') { if (depth === 0) return source.slice(start, i).trim(); depth -= 1 }
    else if (ch === ',' && depth === 0) return source.slice(start, i).trim()
  }
  throw new Error('unterminated call')
}

interface Site { file: string; line: number; target: string; entryId: string | null }

function scanSites(): { sites: Site[]; files: Record<string, string>; receiptKinds: string[] } {
  const sites: Site[] = [], files: Record<string, string> = {}, receiptKinds = new Set<string>()
  for (const file of readdirSync(X6_DIR).filter(name => name.endsWith('.ts')).sort()) {
    const source = readFileSync(path.join(X6_DIR, file), 'utf8')
    files[file] = createHash('sha256').update(source).digest('hex')
    if (file === ADAPTER) continue
    const lineOf = (index: number) => source.slice(0, index).split('\n').length
    const push = (index: number, target: string) => {
      const owners = RUNTIME_WRITE_SET.filter(entry => entry.writers.some(writer => writer.file === file && writer.target === target))
      sites.push({ file, line: lineOf(index), target, entryId: owners.length === 1 ? owners[0]!.id : null })
    }
    for (const match of source.matchAll(/\.(writeFileSync|appendFileSync|unlinkSync|rmSync|renameSync)\(/g)) {
      const target = firstArgument(source, match.index + match[0].length)
      const helper = WRITE_HELPERS.find(item => item.file === file && item.target === target)
      if (helper) continue
      push(match.index, target)
    }
    for (const helper of WRITE_HELPERS.filter(item => item.file === file)) {
      for (const match of source.matchAll(new RegExp(`\\b${helper.helper}\\(`, 'g'))) {
        if (source.slice(Math.max(0, match.index - 6), match.index).includes('const ')) continue
        push(match.index, `${helper.helper}:${firstArgument(source, match.index + match[0].length)}`)
      }
    }
    for (const match of source.matchAll(/organsService\.call\('seed-receipts',\s*\{/g)) {
      const window = source.slice(match.index, match.index + 240)
      const action = /action:\s*'([a-z_]+)'/.exec(window)?.[1]
      if (action !== 'append') continue
      push(match.index, 'seed-receipts:append')
      const kind = /kind:\s*'([a-z.]+)'/.exec(window)?.[1]
      if (kind) receiptKinds.add(kind)
    }
  }
  return { sites, files, receiptKinds: [...receiptKinds].sort() }
}

function seedReceipts() {
  const code = readFileSync(path.join(REPO_ROOT, 'mirror/home/auma/seed/organs/seed-receipts.js'), 'utf8')
  const mod = { exports: {} as Record<string, unknown> }
  new Function('require', 'module', 'exports', code)(requireFromHere, mod, mod.exports)
  return mod.exports as { run: (args: Record<string, unknown>, ctx: { fs: unknown }) => Promise<Record<string, unknown>> }
}

describe('runtime write-set inventory (static)', () => {
  it('is machine-readable and internally consistent', () => {
    const ids = RUNTIME_WRITE_SET.map(entry => entry.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const entry of RUNTIME_WRITE_SET) {
      expect(() => new RegExp(entry.match)).not.toThrow()
      expect(entry.transitionKinds.every(isTransitionKind)).toBe(true)
      if (entry.class === 'authority') expect(entry.transitionKinds.length).toBeGreaterThan(0)
      else expect(entry.transitionKinds).toEqual([])
      expect(entry.writers.length > 0 || typeof entry.via === 'string').toBe(true)
    }
    expect(JSON.parse(JSON.stringify(RUNTIME_WRITE_SET))).toEqual(RUNTIME_WRITE_SET)
    // Concrete paths classify to exactly one family.
    expect(classifyWritePath('/dsh/home/balls/HEAD.json')?.id).toBe('head-manifest')
    expect(classifyWritePath('/dsh/home/balls/history/fork-' + 'a'.repeat(64) + '.json')?.id).toBe('ball-history')
    expect(classifyWritePath('/dsh/home/balls/' + 'a'.repeat(64) + '.js')?.id).toBe('ball-code-store')
    expect(classifyWritePath('/dsh/home/auma/seed/receipts.v3.jsonl')?.id).toBe('receipt-chain')
    expect(classifyWritePath('/dsh/home/auma/staged/head-promotion.json')?.id).toBe('staged-head-promotion')
    expect(classifyWritePath('/dsh/home/auma/staged/outward-class3.json')?.id).toBe('staged-outward')
    expect(classifyWritePath('/dsh/home/auma/wake/steps.jsonl')?.id).toBe('wake-steps')
    expect(classifyWritePath('/dsh/home/auma/captures/ring/1-abc.png')?.id).toBe('page-eyes-captures')
    expect(classifyWritePath('/dsh/home/auma/private/anything')).toBeNull()
  })

  it('every write site in src/x6 maps to exactly one entry, and every entry still has a site', () => {
    const { sites, files, receiptKinds } = scanSites()
    const report = { schema: WRITE_SET_SCHEMA, files, sites, entries: RUNTIME_WRITE_SET.map(entry => entry.id) }
    expect(Object.keys(report.files)).toEqual(expect.arrayContaining(['ball-loader.ts', 'page-eyes-bridge.ts', 'wake-loop.ts', ADAPTER]))
    expect(Object.values(report.files).every(sha => /^[a-f0-9]{64}$/.test(sha))).toBe(true)
    expect(sites.length).toBeGreaterThan(40)
    const unanchoredSites = sites.filter(site => site.entryId === null).map(site => `${site.file}:${String(site.line)} ${site.target}`)
    expect(unanchoredSites).toEqual([])
    const used = new Set(sites.map(site => site.entryId))
    const stale = RUNTIME_WRITE_SET.filter(entry => entry.writers.length > 0 && !used.has(entry.id)).map(entry => entry.id)
    expect(stale).toEqual([])
    for (const entry of RUNTIME_WRITE_SET) {
      for (const writer of entry.writers) expect(sites.some(site => site.file === writer.file && site.target === writer.target), `${entry.id}: ${writer.target}`).toBe(true)
    }
    // Every literal receipt kind appended through seed-receipts is an admitted transition of the receipt chain.
    const chain = RUNTIME_WRITE_SET.find(entry => entry.id === 'receipt-chain')!
    expect(receiptKinds).toEqual(expect.arrayContaining(['aura.attest', 'head.stage', 'scion.compile']))
    expect(receiptKinds.filter(kind => !(chain.transitionKinds as readonly string[]).includes(kind))).toEqual([])
    expect(report.sites.filter(site => site.entryId === 'head-manifest').length).toBeGreaterThanOrEqual(4)
  })

  it('catches a new raw write path (the scan is not vacuous)', () => {
    const owners = (target: string) => RUNTIME_WRITE_SET.filter(entry => entry.writers.some(writer => writer.file === 'ball-loader.ts' && writer.target === target))
    expect(owners('HEAD_PATH')).toHaveLength(1)
    expect(owners('\'/dsh/home/auma/quarantine.json\'')).toHaveLength(0)
    expect(firstArgument('vfs.writeFileSync(join(BALLS_DIR, `${sha}.js`), code)', 'vfs.writeFileSync('.length)).toBe('join(BALLS_DIR, `${sha}.js`)')
  })
})

describe('instrumented storage adapter across the joined journey', () => {
  it('attributes every authority write, records roots and counters, and catches unanchored writes and drift', async () => {
    const base = new MemoryVfs()
    for (const dir of ['/dsh/home/balls/history', '/dsh/home/auma/seed', '/dsh/home/auma/staged', '/dsh/home/auma/wake']) base.mkdirSync(dir, { recursive: true })
    const organ = seedReceipts()
    const ballId = 'a'.repeat(64), parentBallId = 'b'.repeat(64)
    const recorder = createWriteSetRecorder(base)
    const fs = recorder.vfs
    // stage
    const stage = createTransitionContext('head.stage')
    recorder.run(stage, () => { fs.writeFileSync('/dsh/home/auma/staged/head-promotion.json', JSON.stringify({ ballId })) })
    // promote: HEAD, history and a real signed receipt append, one effect
    const promote = createTransitionContext('head.promote')
    await recorder.run(promote, async () => {
      fs.writeFileSync('/dsh/home/balls/HEAD.json', JSON.stringify({ epoch: 169, ballId }))
      fs.writeFileSync(`/dsh/home/balls/history/${ballId}.json`, JSON.stringify({ epoch: 169, ballId }))
      const appended = await organ.run({ action: 'append', kind: 'head.promote', data: { epoch: 169, ballId, parentBallId, tier: 'T2', hasApprovalToken: true, operationId: promote.operationId, transitionKind: 'head.promote' } }, { fs })
      expect(appended.ok).toBe(true)
      recorder.effect()
    })
    // invoke: content-addressed code needs no context
    fs.writeFileSync('/dsh/home/balls/' + 'c'.repeat(64) + '.js', 'module.exports = {}')
    // refusal inside an admitted operation: nothing written
    const refused = createTransitionContext('head.adopt')
    recorder.run(refused, () => { recorder.refuse('HEAD_LEASE_STALE') })
    // a wake step is the wrong kind for HEAD
    recorder.run(createTransitionContext('wake.step'), () => { fs.writeFileSync('/dsh/home/auma/wake/steps.jsonl', '{}\n') })
    const first = recorder.inventory()
    expect(first.schema).toBe(WRITE_SET_SCHEMA)
    expect(first.unanchored).toEqual([])
    expect(first.operations.map(op => [op.transitionKind, op.writes, op.refusals, op.effects])).toEqual([
      ['head.stage', 1, [], 0], ['head.promote', expect.any(Number), [], 1], ['head.adopt', 0, ['HEAD_LEASE_STALE'], 0], ['wake.step', 1, [], 0]])
    const promoteOp = first.operations[1]!
    expect(promoteOp.preRoot).not.toBe(promoteOp.postRoot)
    expect(first.operations[2]!.preRoot).toBe(first.operations[2]!.postRoot)
    const promoteWrites = first.writes.filter(record => record.operationId === promote.operationId)
    expect(promoteWrites.map(record => record.entryId)).toEqual(expect.arrayContaining(['head-manifest', 'ball-history', 'receipt-chain']))
    expect(promoteWrites.every(record => record.anchored && record.transitionKind === 'head.promote')).toBe(true)
    // The signing keypair is attributed but never hashed.
    const secret = first.writes.filter(record => record.class === 'secret-material')
    expect(secret.every(record => record.preSha256 === null && record.postSha256 === null)).toBe(true)
    expect(first.counters).toMatchObject({ unanchored: 0, refusals: 1, effects: 1 })
    expect(first.counters.writes).toBe(first.counters.anchored)

    // restart: reads and receipt verification change nothing, so there is no false rollback
    const restarted = createWriteSetRecorder(base, { previous: first })
    expect((await organ.run({ action: 'verify' }, { fs: restarted.vfs })).ok).toBe(true)
    restarted.vfs.readFileSync('/dsh/home/balls/HEAD.json', 'utf8')
    expect(restarted.inventory().resumed).toEqual({ previousFinalRoot: first.finalRoot, drift: false })
    expect(restarted.inventory().writes).toEqual([])
    // next authorized mutation
    const adopt = createTransitionContext('head.adopt')
    restarted.run(adopt, () => { restarted.vfs.writeFileSync('/dsh/home/balls/HEAD.json', JSON.stringify({ epoch: 170, ballId: 'd'.repeat(64) })) })
    // injected raw writes outside any admitted context, and with an unadmitted kind
    restarted.vfs.writeFileSync('/dsh/home/balls/HEAD.json', JSON.stringify({ epoch: 171, ballId: 'e'.repeat(64) }))
    restarted.run(createTransitionContext('wake.step'), () => { restarted.vfs.writeFileSync('/dsh/home/auma/staged/head-promotion.json', '{}') })
    restarted.vfs.writeFileSync('/dsh/home/auma/quarantine.json', '{}')
    const second = restarted.inventory()
    expect(second.unanchored.map(record => [record.path, record.reason])).toEqual([
      ['/dsh/home/balls/HEAD.json', 'NO_TRANSITION_CONTEXT'],
      ['/dsh/home/auma/staged/head-promotion.json', 'TRANSITION_KIND_NOT_ADMITTED'],
      ['/dsh/home/auma/quarantine.json', 'UNINVENTORIED_PATH'],
    ])
    expect(second.counters).toMatchObject({ writes: 4, anchored: 1, unanchored: 3 })

    // out-of-band drift (a write that bypasses the adapter) is caught on the next restart, a clean restart is not flagged
    expect(createWriteSetRecorder(base, { previous: second }).inventory().resumed)
      .toEqual({ previousFinalRoot: second.finalRoot, drift: false })
    base.writeFileSync('/dsh/home/auma/seed/receipts.v3.jsonl', '')
    expect(createWriteSetRecorder(base, { previous: second }).inventory().resumed?.drift).toBe(true)
    expect(authorityCommitmentRoot(base)).not.toBe(second.finalRoot)
    expect(() => restarted.run(adopt, () => restarted.run(adopt, () => undefined))).toThrow('WRITE_SET_NESTED_TRANSITION')
  })
})
