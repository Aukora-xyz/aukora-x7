/**
 * The one cross-engine shim (node/globals/disposal.ts) fills Promise.withResolvers and
 * AbortSignal.any where an engine lacks them (Safari before 17.4, Firefox before 121/124), and the page loads it before
 * anything else. The natives are removed here, the shim is evaluated fresh, and its answers are checked against the
 * behaviour the callers rely on.
 */
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const SHIM = '../../src/node/globals/disposal.ts'
const nativeWithResolvers = Object.getOwnPropertyDescriptor(Promise, 'withResolvers')
const nativeAny = Object.getOwnPropertyDescriptor(AbortSignal, 'any')

async function freshShim(): Promise<void> {
  vi.resetModules()
  await import(SHIM)
}

describe('the cross-engine shim on an engine without the ES2024 intrinsics', () => {
  beforeEach(() => {
    Reflect.deleteProperty(Promise, 'withResolvers')
    Reflect.deleteProperty(AbortSignal, 'any')
  })
  afterEach(() => {
    if (nativeWithResolvers !== undefined) Object.defineProperty(Promise, 'withResolvers', nativeWithResolvers)
    if (nativeAny !== undefined) Object.defineProperty(AbortSignal, 'any', nativeAny)
  })

  it('fills Promise.withResolvers with a working deferred', async () => {
    expect((Promise as { withResolvers?: unknown }).withResolvers).toBeUndefined()
    await freshShim()
    const resolved = Promise.withResolvers<number>()
    resolved.resolve(7)
    await expect(resolved.promise).resolves.toBe(7)
    const rejected = Promise.withResolvers<number>()
    rejected.reject(new Error('no'))
    await expect(rejected.promise).rejects.toThrow('no')
  })

  it('fills AbortSignal.any: the first source to abort aborts the result with its reason', async () => {
    expect((AbortSignal as { any?: unknown }).any).toBeUndefined()
    await freshShim()
    const a = new AbortController()
    const b = new AbortController()
    const any = AbortSignal.any([a.signal, b.signal])
    expect(any.aborted).toBe(false)
    b.abort('second wins')
    expect(any.aborted).toBe(true)
    expect(any.reason).toBe('second wins')
    a.abort('too late')
    expect(any.reason).toBe('second wins')
  })

  it('AbortSignal.any of an already-aborted source is aborted at once, with that reason', async () => {
    await freshShim()
    const live = new AbortController()
    const any = AbortSignal.any([live.signal, AbortSignal.abort('already')])
    expect(any.aborted).toBe(true)
    expect(any.reason).toBe('already')
  })

  it('composes with a timeout the way the turn path does (ball-loader: deps.signal + AbortSignal.timeout)', async () => {
    await freshShim()
    const turn = new AbortController()
    const any = AbortSignal.any([turn.signal, AbortSignal.timeout(5)])
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(any.aborted).toBe(true)
    expect((any.reason as DOMException).name).toBe('TimeoutError')
  })

  it('the page boot gate works on such an engine: client/index.ts loads the shim before its own code', async () => {
    vi.resetModules()
    const client = await import('../../src/client/index.ts')
    client.holdWorkerHostBoot()
    const gate = (globalThis as { __DSH_BOOT_READY__?: PromiseWithResolvers<void> }).__DSH_BOOT_READY__
    expect(typeof gate?.resolve).toBe('function')
    Reflect.deleteProperty(globalThis, '__DSH_BOOT_READY__')
  })
})

describe('the shim never replaces a native intrinsic', () => {
  it('leaves the engine\'s own Promise.withResolvers and AbortSignal.any in place', async () => {
    const own = (): unknown[] => [
      Object.getOwnPropertyDescriptor(Promise, 'withResolvers')?.value, Object.getOwnPropertyDescriptor(AbortSignal, 'any')?.value,
    ]
    const before = own()
    await freshShim()
    expect(own()).toEqual(before)
  })

  it('is the first import of the page entry, so no page module evaluates before it', () => {
    const source = readFileSync(new URL('../../src/client/index.ts', import.meta.url), 'utf8')
    const firstImport = source.split('\n').find(line => line.startsWith('import '))
    expect(firstImport).toBe("import '../node/globals/disposal.ts'")
  })
})
