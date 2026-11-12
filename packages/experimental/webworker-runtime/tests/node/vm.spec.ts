/** Lane E3 `node:vm`: name-isolating contexts over the worker realm (not a security boundary, documented in vm.ts). */
import { afterEach, describe, expect, it, vi } from 'vitest'
import vmDefault, { Script, compileFunction, createContext, isContext, runInContext, runInNewContext, runInThisContext } from '../../src/node/builtin_modules/implemented/vm.ts'

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

const WORKER_GLOBALS = ['self', 'fetch', 'WebSocket', 'indexedDB', 'caches', 'importScripts', 'postMessage', 'process', 'Buffer',
  'require', 'setTimeout', 'setInterval', 'queueMicrotask', 'crypto', 'WebAssembly', 'TextEncoder', 'structuredClone', 'fs']

describe('node:vm contexts', () => {
  it('shadows every worker global unless the context supplies it', () => {
    for (const name of ['self', 'fetch', 'WebSocket', 'indexedDB', 'caches', 'importScripts', 'postMessage', 'fs']) {
      vi.stubGlobal(name, () => 'ambient')
    }
    const seen = runInNewContext(`[${WORKER_GLOBALS.map(name => `typeof ${name}`).join(', ')}]`, {}) as string[]
    expect(Object.fromEntries(WORKER_GLOBALS.map((name, i) => [name, seen[i]]))).toEqual(Object.fromEntries(WORKER_GLOBALS.map(name => [name, 'undefined'])))
    expect(runInNewContext('globalThis.fetch === undefined && this.self === undefined', {})).toBe(true)
    const supplied = () => 'supplied'
    expect(runInNewContext('fetch()', { fetch: supplied })).toBe('supplied')
  })

  it('exposes the ECMAScript intrinsics the round27 organ needs, plus context properties', () => {
    const types = runInNewContext('[Object, Array, Map, Set, Date, JSON, RegExp, Error, TypeError, Promise, Uint8Array, Math, Number, String, Boolean, Symbol].map(x => typeof x)', {}) as string[]
    expect(new Set(types)).toEqual(new Set(['function', 'object']))
    const module = { exports: {} as Record<string, unknown> }
    runInNewContext('\'use strict\'\nconst helper = require(\'dep\'); module.exports = { value: helper + Buffer.from(\'x\').length }',
      { module, Buffer, require: (name: string) => (name === 'dep' ? 41 : undefined) }, { timeout: 1000 })
    expect(module.exports.value).toBe(42)
  })

  it('cannot reach ambient fs or network through require unless the context passes one', () => {
    expect(() => runInNewContext('require(\'node:fs\')', {})).toThrow(/require is not (defined|a function)/)
    expect(runInNewContext('typeof require', {})).toBe('undefined')
  })

  it('assignments and declarations land on the context; nothing leaks to the worker global', () => {
    const context = createContext({ seed: 1 })
    runInContext('seed += 1; globalThis.added = \'yes\'; this.viaThis = true; leaked = 5', context)
    expect(context).toMatchObject({ seed: 2, added: 'yes', viaThis: true, leaked: 5 })
    expect('added' in globalThis || 'viaThis' in globalThis || 'leaked' in globalThis).toBe(false)
    const strict = createContext({})
    expect(() => runInContext('\'use strict\'; undeclaredStrict = 1', strict)).toThrow(ReferenceError)
    expect(Object.keys(strict)).toEqual([])
    expect('undeclaredStrict' in globalThis).toBe(false)
  })

  it('a Script wrapped like live-shape.mjs leaves no keys beyond the declared ones', () => {
    const module = { exports: {} as Record<string, unknown> }
    const globals: Record<string, unknown> = { module, require: () => ({}), Buffer, Date }
    const declared = Object.keys(globals)
    const context = createContext(globals)
    new Script('(function (module, exports, require) {\'use strict\'\nconst x = 1; module.exports = { name: \'seed-x\', run() { return x } }\n})(module, module.exports, require)', { filename: 'live/seed-x.js' })
      .runInContext(context, { timeout: 2000 })
    expect(Object.keys(context).filter(key => !declared.includes(key))).toEqual([])
    expect(module.exports.name).toBe('seed-x')
  })

  it('returns the completion value, keeps contexts distinct, and validates arguments', () => {
    expect(runInNewContext('1 + 2')).toBe(3)
    const a = createContext({ n: 1 }), b = createContext({ n: 2 })
    expect([runInContext('n', a), runInContext('n', b)]).toEqual([1, 2])
    expect(isContext(a)).toBe(true)
    expect(isContext({})).toBe(false)
    expect(() => runInContext('1', {})).toThrow(expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE' }))
    expect(() => runInNewContext('1', {}, { timeout: -1 })).toThrow(expect.objectContaining({ code: 'ERR_OUT_OF_RANGE' }))
    expect(() => new Script('let = ;')).toThrow(SyntaxError)
    expect(createContext(a)).toBe(a)
    expect(vmDefault.runInNewContext).toBe(runInNewContext)
  })

  it('reports a run that overran its timeout (it cannot pre-empt synchronous code)', () => {
    let now = 1000
    vi.spyOn(Date, 'now').mockImplementation(() => { now += 600; return now })
    expect(() => runInNewContext('1', {}, { timeout: 100 })).toThrow(expect.objectContaining({ code: 'ERR_SCRIPT_EXECUTION_TIMEOUT' }))
  })

  it('compileFunction and runInThisContext', () => {
    const add = compileFunction('return a + b + offset', ['a', 'b'], { contextExtensions: [{ offset: 10 }] })
    expect(add(1, 2)).toBe(13)
    expect(runInThisContext('typeof globalThis')).toBe('object')
  })
})
