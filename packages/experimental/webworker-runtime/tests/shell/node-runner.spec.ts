/** Command lifetime tests use the real module loader and VFS with a fake clock. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as moduleLoader from '../../src/module-system/module-loader.ts'
import * as activeVfs from '../../src/storage/active.ts'
import { MemoryVfs } from '../../src/storage/memory.ts'
import { runNodeCommand } from '../../src/shell/process/node-runner.ts'
import type { NodeRunResult } from '../../src/shell/process/node-runner.ts'

const cwd = '/dsh/workspace'
let vfs: MemoryVfs
let scope: EventTarget
let finishExternal: (value?: unknown) => void
let externalTimer: ReturnType<typeof setTimeout> | number | undefined
let mark: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.useFakeTimers()
  // The worker's process shim has writable streams; native Node exposes getter-only streams.
  vi.stubGlobal('process', Object.create(process, {
    stdout: { value: process.stdout, writable: true },
    stderr: { value: process.stderr, writable: true },
  }))
  scope = new EventTarget()
  vi.stubGlobal('self', scope)
  vi.spyOn(scope, 'addEventListener')
  vi.spyOn(scope, 'removeEventListener')
  vfs = new MemoryVfs()
  vfs.seedDirectory(cwd)
  mark = vi.fn()
  externalTimer = undefined
  const pending = new Promise<unknown>((resolve) => { finishExternal = value => resolve(value) })
  const loader = new moduleLoader.WorkerModuleLoader({
    vfs,
    staticModules: { fixture: () => ({ pending, mark, externalTimer }) },
  })
  vi.spyOn(moduleLoader, 'requireActiveModuleLoader').mockReturnValue(loader)
  vi.spyOn(activeVfs, 'requireActiveVfs').mockReturnValue(vfs)
})

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

async function runFor(args: string[], elapsed: number, stdin = ''): Promise<NodeRunResult> {
  let result: NodeRunResult | undefined
  let rejected: { error: unknown } | undefined
  void runNodeCommand(args, cwd, stdin).then(
    (value) => { result = value },
    (error: unknown) => { rejected = { error } },
  )
  await vi.advanceTimersByTimeAsync(elapsed)
  if (rejected !== undefined) throw rejected.error
  if (result === undefined) throw new Error(`Command did not settle within ${elapsed} ms`)
  return result
}

it.each([
  ['eval', ['-e', 'console.log(process.argv[2])', 'argument'], '', 'argument\n'],
  ['print', ['-p', 'Promise.resolve(42)'], '', '42\n'],
  ['stdin', ['-'], 'console.log("stdin")', 'stdin\n'],
  ['file', ['script.js'], '', 'file\n'],
])('preserves %s execution and cleans up its listener', async (_name, args, stdin, stdout) => {
  vfs.writeFileSync(`${cwd}/script.js`, 'console.log("file")')
  expect(await runFor(args, 600, stdin)).toEqual({ exitCode: 0, stdout, stderr: '' })
  expect(scope.removeEventListener).toHaveBeenCalledWith('unhandledrejection', expect.any(Function))
  expect(vi.getTimerCount()).toBe(0)
})

it('waits for sequential timers in an unreturned async function beyond output silence', async () => {
  const result = await runFor(['-e', `
    (async () => {
      await new Promise(resolve => setTimeout(resolve, 800));
      await new Promise(resolve => setTimeout(resolve, 800));
      console.log('finished');
    })();
  `], 2_200)
  expect(result).toEqual({ exitCode: 0, stdout: 'finished\n', stderr: '' })
  expect(vi.getTimerCount()).toBe(0)
})

it('keeps an interval alive until the script clears its numeric handle', async () => {
  const result = await runFor(['-e', `
    let count = 0;
    const timer = setInterval(() => {
      console.log(++count);
      if (count === 2) clearTimeout(Number(timer));
    }, 800);
  `], 2_200)
  expect(result).toEqual({ exitCode: 0, stdout: '1\n2\n', stderr: '' })
  expect(vi.getTimerCount()).toBe(0)
})

it.each([
  ['setTimeout', 'clearTimeout'],
  ['setInterval', 'clearInterval'],
  ['setImmediate', 'clearImmediate'],
])('removes a cleared %s from pending work', async (schedule, clear) => {
  expect(await runFor(['-e', `
    const timer = ${schedule}(() => require('fixture').mark(), 1_000);
    ${clear}(timer);
  `], 600)).toEqual({ exitCode: 0, stdout: '', stderr: '' })
  expect(mark).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})

it('delivers immediate callback arguments', async () => {
  expect(await runFor(['-e', 'setImmediate(console.log, "immediate", 42)'], 600))
    .toEqual({ exitCode: 0, stdout: 'immediate 42\n', stderr: '' })
})

it('leaves an external timer running when command-owned timers are disposed', async () => {
  externalTimer = setTimeout(mark, 1_000)
  expect(await runFor(['-e', 'setTimeout(() => require("fixture").mark("owned"), 1_000); process.exit(0)'], 600))
    .toEqual({ exitCode: 0, stdout: '', stderr: '' })
  expect(vi.getTimerCount()).toBe(1)
  await vi.advanceTimersByTimeAsync(500)
  expect(mark).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(0)
})

it('preserves explicit clearing of a timer supplied by a required module', async () => {
  externalTimer = setTimeout(mark, 1_000)
  expect(await runFor(['-e', 'clearTimeout(require("fixture").externalTimer)'], 600))
    .toEqual({ exitCode: 0, stdout: '', stderr: '' })
  await vi.advanceTimersByTimeAsync(500)
  expect(mark).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})

it('reports print formatting failures without an unhandled rejection', async () => {
  const result = await runFor(['-p', `({
    toJSON() { throw new Error('json failed') },
    toString() { throw new Error('format failed') },
  })`], 100)
  expect(result.exitCode).toBe(1)
  expect(result.stdout).toBe('')
  expect(result.stderr).toContain('Error: format failed')
  expect(vi.getTimerCount()).toBe(0)
})

it.each([
  '{ toString() { throw new Error("format failed") } }',
  'new Proxy({}, { getPrototypeOf() { throw new Error("inspection failed") } })',
])('reports rejected promises when their error cannot be inspected or formatted: %s', async (reason) => {
  expect(await runFor(['-e', `return Promise.reject(${reason})`], 100))
    .toEqual({ exitCode: 1, stdout: '', stderr: 'node: command failed; error could not be formatted\n' })
  expect(vi.getTimerCount()).toBe(0)
})

it.each(['-e', '-p'])('bounds a never-settling returned promise in %s', async (mode) => {
  const code = mode === '-p' ? 'require("fixture").pending' : 'return require("fixture").pending'
  expect(await runFor([mode, code], 30_000)).toEqual({
    exitCode: 124, stdout: '', stderr: 'node: timed out after 30 s; output so far shown\n',
  })
  expect(vi.getTimerCount()).toBe(0)
  expect(scope.removeEventListener).toHaveBeenCalledWith('unhandledrejection', expect.any(Function))
})

it('waits for an explicitly returned external promise', async () => {
  const settled = vi.fn()
  const running = runNodeCommand(['-e', 'return require("fixture").pending.then(() => console.log("external"))'], cwd, '')
  void running.then(settled)
  await vi.advanceTimersByTimeAsync(800)
  expect(settled).not.toHaveBeenCalled()
  finishExternal()
  await vi.advanceTimersByTimeAsync(600)
  expect(await running).toEqual({ exitCode: 0, stdout: 'external\n', stderr: '' })
})

it('lets process.exit settle while the returned promise remains pending', async () => {
  expect(await runFor(['-e', `
    setTimeout(() => process.exit(7), 800);
    setInterval(() => require('fixture').mark(), 2_000);
    return require('fixture').pending;
  `], 900)).toEqual({ exitCode: 7, stdout: '', stderr: '' })
  expect(vi.getTimerCount()).toBe(0)
  await vi.advanceTimersByTimeAsync(4_000)
  expect(mark).not.toHaveBeenCalled()
})

it('times out a silent interval with a nonzero status and disposes its timer', async () => {
  const result = await runFor(['-e', 'setInterval(() => require("fixture").mark(), 1_000)'], 30_000)
  expect(result.exitCode).toBe(124)
  expect(result.stderr).toBe('node: timed out after 30 s; output so far shown\n')
  const calls = mark.mock.calls.length
  expect(vi.getTimerCount()).toBe(0)
  await vi.advanceTimersByTimeAsync(4_000)
  expect(mark).toHaveBeenCalledTimes(calls)
})

it.each([
  'throw new Error("failed")',
  'setTimeout(() => { throw new Error("failed") }, 800)',
  'return Promise.reject(new Error("failed"))',
])('disposes command timers after an error: %s', async (failure) => {
  const result = await runFor(['-e', `setTimeout(() => require('fixture').mark(), 2_000); ${failure}`], 900)
  expect(result.exitCode).toBe(1)
  expect(result.stderr).toContain('Error: failed')
  expect(vi.getTimerCount()).toBe(0)
  await vi.advanceTimersByTimeAsync(4_000)
  expect(mark).not.toHaveBeenCalled()
})

it('closes captured output and timer admission after a timed-out promise completes', async () => {
  const result = await runFor(['-e', `
    return require('fixture').pending.then(() => {
      console.log('late');
      setTimeout(() => require('fixture').mark(), 0);
    });
  `], 30_000)
  expect(result.exitCode).toBe(124)
  finishExternal()
  await vi.advanceTimersByTimeAsync(1_000)
  expect(result.stdout).toBe('')
  expect(mark).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})

it('does not format a print value that resolves after timeout', async () => {
  const result = await runFor(['-p', 'require("fixture").pending'], 30_000)
  expect(result.exitCode).toBe(124)
  finishExternal({ toJSON: mark })
  await vi.advanceTimersByTimeAsync(100)
  expect(mark).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})

it('does not claim ownership of an unreturned external promise', async () => {
  expect(await runFor(['-e', 'require("fixture").pending.then(() => console.log("late"))'], 600))
    .toEqual({ exitCode: 0, stdout: '', stderr: '' })
  finishExternal()
  await vi.advanceTimersByTimeAsync(100)
  expect(vi.getTimerCount()).toBe(0)
})

it('keeps timer cleanup local to each concurrent command', async () => {
  const short = runNodeCommand(['-e', 'setTimeout(() => process.exit(3), 100)'], cwd, '')
  const long = runNodeCommand(['-e', 'setTimeout(() => console.log("long"), 800)'], cwd, '')
  await vi.advanceTimersByTimeAsync(1_400)
  expect(await short).toEqual({ exitCode: 3, stdout: '', stderr: '' })
  expect(await long).toEqual({ exitCode: 0, stdout: 'long\n', stderr: '' })
  expect(vi.getTimerCount()).toBe(0)
})
