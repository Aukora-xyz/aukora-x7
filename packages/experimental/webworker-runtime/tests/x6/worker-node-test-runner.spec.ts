/**
 * Lane E3 hard proof: Auma can run a real repository `node:test` suite inside her own worker with zero OS exec.
 *
 * The REAL, unmodified server/pearl.test.mjs, its fixture loader (server/fixtures/organs/pinned.mjs, every pinned
 * organ + MANIFEST.json) and the structural tripwire (live-shape.mjs over the repo's mirror/home/auma/seed/organs/
 * seed-pearl.js) are copied byte-for-byte from this checkout into a MemoryVfs and run with
 * `runNodeCommand(['--test', ...])` through the WorkerModuleLoader and the worker's own builtin table (node:test, node:vm,
 * node:assert/strict, node:crypto, node:fs over the VFS). Nothing under server/ or mirror/ is written; no private store
 * is read.
 *
 * Parity is calibrated against real Node in the same run: the set of passing test names the worker prints must equal
 * the set `node --test` prints for the same file at this commit. Two mutations prove the worker run can go red: a
 * behaviour change in the pinned seed-pearl (manifest re-pinned so the integrity tripwire passes) fails tests, and the
 * same change without re-pinning fails the whole file at import.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as moduleLoader from '../../src/module-system/module-loader.ts'
import * as activeVfs from '../../src/storage/active.ts'
import { MemoryVfs } from '../../src/storage/memory.ts'
import { createNodeBuiltins } from '../../src/node/builtins.ts'
import { runNodeCommand } from '../../src/shell/process/node-runner.ts'

const REPO = fileURLToPath(new URL('../../../../../', import.meta.url))
const SUITE = 'server/pearl.test.mjs'
const FIXTURES = 'server/fixtures/organs'
const LIVE_MIRROR = 'mirror/home/auma/seed/organs/seed-pearl.js'
const WORKSPACE = '/workspace'

const repoBytes = (path: string): Buffer => readFileSync(REPO + path)
const fixtureFiles = (): string[] => readdirSync(REPO + FIXTURES).filter(name => /\.(m?js|json)$/.test(name)).map(name => `${FIXTURES}/${name}`)

let vfs: MemoryVfs

function mount(overrides: Record<string, Buffer | string> = {}): void {
  vfs = new MemoryVfs()
  for (const path of [SUITE, ...fixtureFiles(), LIVE_MIRROR]) {
    const target = `${WORKSPACE}/${path}`
    vfs.mkdirSync(target.slice(0, target.lastIndexOf('/')), { recursive: true })
    vfs.writeFileSync(target, overrides[path] ?? repoBytes(path))
  }
  const loader = new moduleLoader.WorkerModuleLoader({ vfs, staticModules: createNodeBuiltins() })
  vi.spyOn(moduleLoader, 'requireActiveModuleLoader').mockReturnValue(loader)
  vi.spyOn(activeVfs, 'requireActiveVfs').mockReturnValue(vfs)
}

beforeEach(() => {
  // The worker's process shim has writable streams; native Node exposes getter-only streams (as tests/shell/node-runner.spec.ts).
  vi.stubGlobal('process', Object.create(process, {
    stdout: { value: process.stdout, writable: true },
    stderr: { value: process.stderr, writable: true },
  }))
  vi.stubGlobal('self', new EventTarget())
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const count = (stdout: string, key: string): number => Number(new RegExp(`^ℹ ${key} (\\d+)$`, 'm').exec(stdout)?.[1] ?? Number.NaN)
const passingNames = (stdout: string): string[] => stdout.split('\n')
  .filter(line => line.startsWith('✔ '))
  .map(line => line.slice(2).replace(/ \([\d.]+m?s\)$/, ''))
  .sort()

/** Real Node on the same file at this commit (gating mode: pinned fixtures, AUKORA_ORGAN_SOURCE unset). */
function realNode(): { status: number | null; stdout: string } {
  const env = { ...process.env }
  delete env.AUKORA_ORGAN_SOURCE
  delete env.NODE_OPTIONS
  const run = spawnSync(process.execPath, ['--test', '--test-reporter=spec', SUITE], { cwd: REPO, env, encoding: 'utf8', timeout: 60_000 })
  return { status: run.status, stdout: run.stdout }
}

/** Re-pin one organ in MANIFEST.json the way pinned.mjs verifies it (sha256, byte length, git blob id). */
function repinned(name: string, source: string): string {
  const manifest = JSON.parse(repoBytes(`${FIXTURES}/MANIFEST.json`).toString('utf8')) as { organs: Record<string, Record<string, unknown>> }
  const bytes = Buffer.from(source, 'utf8')
  const entry = manifest.organs[name]
  if (entry === undefined) throw new Error(`fixture ${name} is not pinned`)
  entry.sha256 = createHash('sha256').update(bytes).digest('hex')
  entry.bytes = bytes.length
  entry.gitBlob = createHash('sha1').update(`blob ${String(bytes.length)}\0`).update(bytes).digest('hex')
  return JSON.stringify(manifest, null, 2) + '\n'
}

describe('in-worker node --test over the real pearl suite', () => {
  it('passes exactly the tests real Node passes, with zero failures and exit 0', async () => {
    const node = realNode()
    expect(node.status).toBe(0)
    const nodePassing = passingNames(node.stdout)
    expect(nodePassing.length).toBe(count(node.stdout, 'pass'))

    mount()
    const started = performance.now()
    const result = await runNodeCommand(['--test', `${WORKSPACE}/${SUITE}`], WORKSPACE, '')
    const elapsed = performance.now() - started
    console.info(`[lane-e3] in-worker node --test: tests=${String(count(result.stdout, 'tests'))} pass=${String(count(result.stdout, 'pass'))} fail=${String(count(result.stdout, 'fail'))} in ${elapsed.toFixed(0)} ms; real node pass=${String(nodePassing.length)}`)

    expect(result.stderr).toBe('')
    expect(count(result.stdout, 'fail')).toBe(0)
    expect(count(result.stdout, 'cancelled')).toBe(0)
    expect(count(result.stdout, 'pass')).toBe(count(node.stdout, 'pass'))
    expect(count(result.stdout, 'tests')).toBe(count(node.stdout, 'tests'))
    // 178 behavioural tests on the pinned seed-pearl + 1 structural tripwire over the live mirror organ.
    expect(count(result.stdout, 'pass')).toBe(179)
    expect(passingNames(result.stdout)).toEqual(nodePassing)
    expect(result.exitCode).toBe(0)
    // The repo files were read, never written: the VFS copy is byte-identical to the checkout.
    expect(Buffer.from(vfs.readFileSync(`${WORKSPACE}/${SUITE}`) as Uint8Array).equals(repoBytes(SUITE))).toBe(true)
  }, 120_000)

  it('a mutated (re-pinned) seed-pearl candidate fails tests and exits 1', async () => {
    const original = repoBytes(`${FIXTURES}/seed-pearl.js`).toString('utf8')
    const mutated = original.replaceAll('NO_GRANT_PRESENT', 'NO_GRANT_PRESENT_MUTATED')
    expect(mutated).not.toBe(original)
    mount({ [`${FIXTURES}/seed-pearl.js`]: mutated, [`${FIXTURES}/MANIFEST.json`]: repinned('seed-pearl', mutated) })
    const result = await runNodeCommand(['--test', `${WORKSPACE}/${SUITE}`], WORKSPACE, '')
    expect(result.exitCode).toBe(1)
    expect(count(result.stdout, 'fail')).toBeGreaterThan(0)
    expect(count(result.stdout, 'pass')).toBeLessThan(179)
    expect(result.stdout).toContain('NO_GRANT_PRESENT_MUTATED')
  }, 120_000)

  it('an unpinned byte change fails the whole file at import (integrity tripwire), exit 1', async () => {
    const original = repoBytes(`${FIXTURES}/seed-pearl.js`).toString('utf8')
    mount({ [`${FIXTURES}/seed-pearl.js`]: original.replace('seed-pearl', 'seed-pearX') })
    const result = await runNodeCommand(['--test', `${WORKSPACE}/${SUITE}`], WORKSPACE, '')
    expect(result.exitCode).toBe(1)
    expect(count(result.stdout, 'pass')).toBe(0)
    expect(count(result.stdout, 'fail')).toBeGreaterThan(0)
    expect(result.stderr).toContain('ORGAN_FIXTURE_DIGEST_MISMATCH: seed-pearl')
  }, 120_000)

  it('reruns re-evaluate the suite and its fixtures (no stale module cache), and an empty run is not green', async () => {
    mount()
    const first = await runNodeCommand(['--test', `${WORKSPACE}/${SUITE}`], WORKSPACE, '')
    const second = await runNodeCommand(['--test', `${WORKSPACE}/${SUITE}`], WORKSPACE, '')
    expect([first.exitCode, second.exitCode]).toEqual([0, 0])
    expect(count(second.stdout, 'pass')).toBe(count(first.stdout, 'pass'))
    vfs.writeFileSync(`${WORKSPACE}/empty.test.mjs`, "import test from 'node:test'\n")
    const empty = await runNodeCommand(['--test', `${WORKSPACE}/empty.test.mjs`], WORKSPACE, '')
    expect(empty.exitCode).toBe(1)
    expect(count(empty.stdout, 'tests')).toBe(0)
    const missing = await runNodeCommand(['--test', `${WORKSPACE}/missing.test.mjs`], WORKSPACE, '')
    expect(missing.exitCode).toBe(1)
  }, 120_000)
})
