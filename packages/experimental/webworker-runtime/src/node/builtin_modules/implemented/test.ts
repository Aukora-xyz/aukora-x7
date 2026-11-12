/**
 * `node:test` for the worker (Aukora X6.1 Lane E3). The registration face Node test files use, over the shared harness in
 * ../../internal_modules/test-harness.ts: `test` (+ `.skip`, `.todo`, `.only`), `it`, `describe`/`suite` (+ modifiers),
 * `before`, `after`, `beforeEach`, `afterEach`, subtests through `t.test()` and `t.diagnostic()`. `node --test` in the
 * worker shell drains the queue and prints the summary; outside it the queue drains after the loading turn.
 * `only` does not filter (there is no `--test-only`); `mock`, `snapshot` and the programmatic `run()` are absent.
 */
import { harness, type HookFn, type TestOptions } from '../../internal_modules/test-harness.ts'
import assertStrict from './assert/strict.ts'

harness.assertModule = assertStrict

type Register = (...args: unknown[]) => Promise<void>
interface Modifiers { skip: Register; todo: Register; only: Register }

function withModifiers(base: (args: unknown[], forced?: TestOptions) => Promise<void>): Register & Modifiers {
  const fn = ((...args: unknown[]) => base(args)) as Register & Modifiers
  fn.skip = (...args: unknown[]) => base(args, { skip: true })
  fn.todo = (...args: unknown[]) => base(args, { todo: true })
  fn.only = (...args: unknown[]) => base(args, { only: true })
  return fn
}

/** Register a test: `test(name?, options?, fn?)`. */
export const test = withModifiers((args, forced) => harness.test(args, forced))
/** Alias of {@link test}. */
export const it = test
/** Register a suite whose body runs now to collect its tests. */
export const describe = withModifiers((args, forced) => harness.describe(args, forced))
/** Alias of {@link describe}. */
export const suite = describe
/** Run once before the current suite's tests. */
export const before = (fn: HookFn, options?: { timeout?: number }): void => { harness.addHook('before', fn, options) }
/** Run once after the current suite's tests. */
export const after = (fn: HookFn, options?: { timeout?: number }): void => { harness.addHook('after', fn, options) }
/** Run before each test in the current suite and its descendants. */
export const beforeEach = (fn: HookFn, options?: { timeout?: number }): void => { harness.addHook('beforeEach', fn, options) }
/** Run after each test in the current suite and its descendants. */
export const afterEach = (fn: HookFn, options?: { timeout?: number }): void => { harness.addHook('afterEach', fn, options) }

/** CommonJS interop marker: the worker loader hands `default` to default imports. */
export const __esModule = true

/** The default export is `test` itself, carrying every named export, as Node's is. */
export default Object.assign(test, { test, it, describe, suite, before, after, beforeEach, afterEach })
