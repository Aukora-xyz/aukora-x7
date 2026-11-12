/** Lane E3 `node:test` + `node --test` in the worker shell: registration, ordering, hooks, subtests, skip/todo, timeouts. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as moduleLoader from '../../src/module-system/module-loader.ts'
import * as activeVfs from '../../src/storage/active.ts'
import { MemoryVfs } from '../../src/storage/memory.ts'
import { createNodeBuiltins } from '../../src/node/builtins.ts'
import { runNodeCommand } from '../../src/shell/process/node-runner.ts'
import nodeTest, * as named from '../../src/node/builtin_modules/implemented/test.ts'

const cwd = '/workspace'
let vfs: MemoryVfs

beforeEach(() => {
  vi.stubGlobal('process', Object.create(process, {
    stdout: { value: process.stdout, writable: true },
    stderr: { value: process.stderr, writable: true },
  }))
  vi.stubGlobal('self', new EventTarget())
  vfs = new MemoryVfs()
  vfs.seedDirectory(cwd)
  const loader = new moduleLoader.WorkerModuleLoader({ vfs, staticModules: createNodeBuiltins() })
  vi.spyOn(moduleLoader, 'requireActiveModuleLoader').mockReturnValue(loader)
  vi.spyOn(activeVfs, 'requireActiveVfs').mockReturnValue(vfs)
})

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

const count = (stdout: string, key: string): number => Number(new RegExp(`^ℹ ${key} (\\d+)$`, 'm').exec(stdout)?.[1] ?? Number.NaN)
async function runFile(source: string, name = 'case.test.mjs') {
  vfs.writeFileSync(`${cwd}/${name}`, source)
  return runNodeCommand(['--test', name], cwd, '')
}

describe('node:test module face', () => {
  it('default export is test carrying every named export, with __esModule', () => {
    expect(nodeTest).toBe(named.test)
    for (const key of ['test', 'it', 'describe', 'suite', 'before', 'after', 'beforeEach', 'afterEach'] as const) {
      expect((nodeTest as unknown as Record<string, unknown>)[key]).toBe(named[key])
    }
    expect(named.__esModule).toBe(true)
    expect(typeof named.test.skip).toBe('function')
    expect(createNodeBuiltins()['node:test']).toBeDefined()
    // node:test is scheme-only in Node; the bare name stays free for a VFS package.
    expect(createNodeBuiltins().test).toBeUndefined()
  })
})

describe('node --test in the worker', () => {
  it('runs tests in order with hooks, suites, subtests, diagnostics, skip and todo; exit 0', async () => {
    const result = await runFile(`
      import test, { describe, it, before, after, beforeEach, afterEach } from 'node:test'
      import assert from 'node:assert/strict'
      const order = []
      before(() => { order.push('before') })
      beforeEach(() => { order.push('beforeEach') })
      afterEach(() => { order.push('afterEach') })
      after(() => { order.push('after'); console.log('ORDER ' + order.join(',')) })
      test('sync', () => { order.push('sync'); assert.equal(1, 1) })
      test('async', async (t) => { await new Promise(r => setTimeout(r, 5)); order.push('async'); t.diagnostic('note here') })
      test('callback', (t, done) => { setTimeout(() => { order.push('callback'); done() }, 1) })
      test('subtests', async (t) => {
        await t.test('child one', () => { order.push('child1') })
        await t.test('child two', async () => { order.push('child2') })
      })
      test('skipped', { skip: 'not here' }, () => { throw new Error('never') })
      test.todo('later', () => { throw new Error('todo failures do not count') })
      describe('group', () => {
        it('inner', () => { order.push('inner') })
      })
    `)
    expect(result.stderr).toBe('')
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('ORDER before,beforeEach,sync,afterEach,beforeEach,async,afterEach,beforeEach,callback,afterEach,beforeEach,child1,child2,afterEach,beforeEach,afterEach,beforeEach,inner,afterEach,after')
    expect(result.stdout).toMatch(/^✔ sync \(/m)
    expect(result.stdout).toMatch(/^ {2}✔ child one \(/m)
    expect(result.stdout).toContain('ℹ note here')
    expect(result.stdout).toMatch(/# SKIP not here/)
    expect(result.stdout).toMatch(/# TODO/)
    expect(result.stdout).toMatch(/^▶ group$/m)
    expect([count(result.stdout, 'tests'), count(result.stdout, 'suites'), count(result.stdout, 'pass'), count(result.stdout, 'fail'),
      count(result.stdout, 'skipped'), count(result.stdout, 'todo')]).toEqual([9, 1, 7, 0, 1, 1])
  })

  it('a failed assertion, a failed subtest and a timeout each fail; exit 1 with the reasons printed', async () => {
    const result = await runFile(`
      const test = require('node:test')
      const assert = require('node:assert')
      test('equal', () => { assert.deepEqual({ a: 1 }, { a: 2 }) })
      test('parent', async (t) => { await t.test('bad child', () => { throw new Error('child broke') }) })
      test('slow', { timeout: 20 }, () => new Promise(() => {}))
      test('fine', () => {})
    `, 'cjs.test.js')
    expect(result.exitCode).toBe(1)
    expect(count(result.stdout, 'fail')).toBe(4) // equal, bad child, parent (1 subtest failed), slow
    expect(count(result.stdout, 'pass')).toBe(1)
    expect(result.stdout).toContain('Expected values to be strictly deep-equal')
    expect(result.stdout).toContain('1 subtest failed')
    expect(result.stdout).toContain('test timed out after 20ms')
  })

  it('a file that throws while loading is a failure, and so is a run with no tests', async () => {
    const broken = await runFile('import test from \'node:test\'\nthrow new Error(\'load boom\')')
    expect(broken.exitCode).toBe(1)
    expect(broken.stderr).toContain('load boom')
    expect(count(broken.stdout, 'fail')).toBe(1)
    expect((await runFile('import test from \'node:test\'')).exitCode).toBe(1)
    expect((await runNodeCommand(['--test'], cwd, '')).exitCode).toBe(1)
    expect((await runNodeCommand(['--test', '--watch', 'x.mjs'], cwd, '')).exitCode).toBe(9)
  })

  it('a failing before hook cancels its suite and fails the run', async () => {
    const result = await runFile(`
      import { describe, it, before } from 'node:test'
      describe('guarded', () => {
        before(() => { throw new Error('setup failed') })
        it('a', () => {})
        it('b', () => {})
      })
    `)
    expect(result.exitCode).toBe(1)
    expect(count(result.stdout, 'cancelled')).toBe(2)
    expect(result.stdout).toContain('setup failed')
  })

  it('runs several files into one summary and lowers ESM entry scripts outside --test too', async () => {
    vfs.writeFileSync(`${cwd}/a.test.mjs`, 'import test from \'node:test\'\ntest(\'a\', () => {})')
    vfs.writeFileSync(`${cwd}/b.test.mjs`, 'import test from \'node:test\'\ntest(\'b\', () => {})')
    const both = await runNodeCommand(['--test', 'a.test.mjs', 'b.test.mjs'], cwd, '')
    expect([both.exitCode, count(both.stdout, 'tests'), count(both.stdout, 'pass')]).toEqual([0, 2, 2])
    vfs.writeFileSync(`${cwd}/lib.mjs`, 'export const answer = 42\nexport function url() { return import.meta.url }')
    vfs.writeFileSync(`${cwd}/main.mjs`, 'import { answer, url } from \'./lib.mjs\'\nconsole.log(answer, url())')
    const esm = await runNodeCommand(['main.mjs'], cwd, '')
    expect(esm).toEqual({ exitCode: 0, stdout: '42 file:///workspace/lib.mjs\n', stderr: '' })
  })
})
