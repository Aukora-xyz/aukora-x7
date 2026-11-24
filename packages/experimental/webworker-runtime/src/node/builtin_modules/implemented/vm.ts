/**
 * `node:vm` for the worker (Aukora X6.1 Lane E3), replacing the throwing mock. A context is the caller's own object;
 * code runs in this realm behind a `with (Proxy)` scope that answers identifiers from the context object first, then a
 * fixed allowlist of ECMAScript intrinsics (plus `console`, which Node contexts also carry), and answers `undefined` for
 * every other name the worker global holds: `self`, `fetch`, `WebSocket`, `indexedDB`, `caches`, `importScripts`,
 * `postMessage`, `process`, `Buffer`, `require`, timers, `crypto`, `WebAssembly` and the rest are unreachable by name
 * unless the context object supplies them. Assignments land on the context object, so `Object.keys(context)` shows
 * what the script defined, as in Node.
 *
 * Honest limits (node:vm is not a security boundary in Node either, and this is weaker):
 *  - One realm: the intrinsics are the worker's own, so `({}).constructor.constructor('return self')()` reaches the
 *    real global. It isolates names, not capabilities.
 *  - `timeout` cannot pre-empt synchronous code on the worker's single thread. A run that exceeds it throws
 *    ERR_SCRIPT_EXECUTION_TIMEOUT afterwards (side effects already happened); a synchronous infinite loop hangs the
 *    caller, exactly where Node would have interrupted it.
 *  - Sloppy-mode top-level `var`/function declarations whose names also exist on the worker global resolve to the
 *    context's (possibly undefined) value; strict scripts are unaffected. Sloppy implicit globals are moved from the
 *    worker global onto the context after the synchronous run.
 *  - `runInThisContext` evaluates in the worker's global scope with no sandbox, which is Node's meaning too.
 */

/** ECMAScript globals a fresh Node context also has. `WebAssembly` is deliberately absent (compiled code stays pinned). */
const INTRINSIC_NAMES = [
  'Object', 'Function', 'Array', 'Number', 'parseFloat', 'parseInt', 'Infinity', 'NaN', 'undefined', 'Boolean', 'String',
  'Symbol', 'Date', 'Promise', 'RegExp', 'Error', 'AggregateError', 'EvalError', 'RangeError', 'ReferenceError',
  'SyntaxError', 'TypeError', 'URIError', 'JSON', 'Math', 'Intl', 'ArrayBuffer', 'SharedArrayBuffer', 'Atomics',
  'Uint8Array', 'Int8Array', 'Uint16Array', 'Int16Array', 'Uint32Array', 'Int32Array', 'Float16Array', 'Float32Array',
  'Float64Array', 'Uint8ClampedArray', 'BigUint64Array', 'BigInt64Array', 'DataView', 'Map', 'BigInt', 'Set', 'WeakMap',
  'WeakSet', 'Proxy', 'Reflect', 'FinalizationRegistry', 'WeakRef', 'Iterator', 'decodeURI', 'decodeURIComponent',
  'encodeURI', 'encodeURIComponent', 'escape', 'unescape', 'eval', 'isFinite', 'isNaN', 'console',
] as const

const realGlobal = globalThis as unknown as Record<string, unknown>
/** Captured once at load, so later tampering with the worker global cannot change what a context sees. */
const INTRINSICS: ReadonlyMap<string, unknown> = new Map(
  INTRINSIC_NAMES.filter(name => name in realGlobal).map(name => [name, realGlobal[name]]),
)
const nativeEval = realGlobal.eval as (code: string) => unknown
const BOOT = '__x6_vm_boot__'

type Context = Record<PropertyKey, unknown>
const contexts = new WeakSet<object>()
const scopes = new WeakMap<object, { proxy: Context; arm: (code: string) => void }>()

interface RunOptions { filename?: string; timeout?: number; displayErrors?: boolean; breakOnSigint?: boolean }

function codeError(message: string, code: string, Ctor: ErrorConstructor = Error): Error {
  return Object.assign(new Ctor(message), { code })
}

function checkTimeout(options: unknown): number | undefined {
  if (options === null || typeof options !== 'object') return undefined
  const timeout = (options as RunOptions).timeout
  if (timeout === undefined) return undefined
  if (typeof timeout !== 'number' || !Number.isInteger(timeout) || timeout <= 0 || timeout > 0xFFFFFFFF) {
    throw codeError(`The value of "options.timeout" is out of range. It must be > 0 && <= 4294967295. Received ${String(timeout)}`, 'ERR_OUT_OF_RANGE', RangeError)
  }
  return timeout
}

function filenameOf(options: unknown, fallback: string): string {
  if (typeof options === 'string') return options
  const name = options !== null && typeof options === 'object' ? (options as RunOptions).filename : undefined
  return typeof name === 'string' && name ? name : fallback
}

function withSourceUrl(code: string, filename: string): string {
  return `${code}\n//# sourceURL=${filename.replace(/\s/g, '_')}`
}

function scopeFor(context: Context): { proxy: Context; arm: (code: string) => void } {
  const existing = scopes.get(context)
  if (existing) return existing
  let pending: string | undefined
  const handler: ProxyHandler<Context> = {
    has(target, key) {
      if (typeof key === 'symbol') return false
      if (key === BOOT) return pending !== undefined
      return key in target || INTRINSICS.has(key) || key === 'globalThis' || key in realGlobal
    },
    get(target, key) {
      if (key === Symbol.unscopables) return undefined
      if (key === BOOT && pending !== undefined) { const code = pending; pending = undefined; return code }
      if (typeof key === 'symbol' || key in target) return Reflect.get(target, key) as unknown
      if (key === 'globalThis') return proxy
      return INTRINSICS.get(key)
    },
    set(target, key, value) { return Reflect.set(target, key, value) },
    defineProperty(target, key, descriptor) { return Reflect.defineProperty(target, key, descriptor) },
    deleteProperty(target, key) { return Reflect.deleteProperty(target, key) },
    getOwnPropertyDescriptor(target, key) { return Reflect.getOwnPropertyDescriptor(target, key) },
    ownKeys(target) { return Reflect.ownKeys(target) },
  }
  const proxy = new Proxy(context, handler)
  const scope = { proxy, arm: (code: string) => { pending = code } }
  scopes.set(context, scope)
  return scope
}

// `this` is not an identifier, so it is not looked up through the scope; `eval` is (an allowlisted intrinsic), and a
// call through a reference that resolves to %eval% is a direct eval, which keeps the `with` scope for the script.
// The sandbox entry point is this module's purpose.
const enter = new Function(`with (this) { return eval(this[${JSON.stringify(BOOT)}]); }`) as (this: Context) => unknown

function runSandboxed(code: string, context: Context, options: unknown, fallbackName: string): unknown {
  const timeout = checkTimeout(options)
  const filename = filenameOf(options, fallbackName)
  const { proxy, arm } = scopeFor(context)
  const before = new Set(Reflect.ownKeys(realGlobal))
  const started = Date.now()
  arm(withSourceUrl(String(code), filename))
  try {
    return enter.call(proxy)
  } finally {
    // Sloppy implicit globals escaped to the worker global: move them onto the context, where Node would put them.
    for (const key of Reflect.ownKeys(realGlobal)) {
      if (before.has(key)) continue
      const descriptor = Reflect.getOwnPropertyDescriptor(realGlobal, key)
      Reflect.deleteProperty(realGlobal, key)
      if (descriptor) Reflect.defineProperty(context, key, descriptor)
    }
    if (timeout !== undefined && Date.now() - started > timeout) {
      throw codeError(`Script execution timed out after ${String(timeout)}ms`, 'ERR_SCRIPT_EXECUTION_TIMEOUT')
    }
  }
}

function requireContext(context: unknown): Context {
  if (context === null || typeof context !== 'object' || !contexts.has(context)) {
    throw codeError('The "contextifiedObject" argument must be an vm.Context', 'ERR_INVALID_ARG_TYPE', TypeError)
  }
  return context as Context
}

/**
 * Contextify an object (idempotent).
 * @param contextObject - the object whose properties become the script's globals; a new one when omitted.
 * @returns the same object, now a context.
 */
export function createContext<T extends object>(contextObject?: T): T & Context {
  const context = (contextObject ?? {}) as T & Context
  if (context === null || typeof context !== 'object') {
    throw codeError('The "contextObject" argument must be of type object', 'ERR_INVALID_ARG_TYPE', TypeError)
  }
  contexts.add(context)
  return context
}

/** Whether an object was contextified by {@link createContext}. */
export function isContext(object: unknown): boolean {
  if (object === null || typeof object !== 'object') {
    throw codeError('The "object" argument must be of type object', 'ERR_INVALID_ARG_TYPE', TypeError)
  }
  return contexts.has(object)
}

/** Run code with a contextified object as its global scope. */
export function runInContext(code: string, contextifiedObject: object, options?: RunOptions | string): unknown {
  return runSandboxed(code, requireContext(contextifiedObject), options, 'evalmachine.<anonymous>')
}

/** Contextify `contextObject` (or a new object) and run code in it. */
export function runInNewContext(code: string, contextObject?: object, options?: RunOptions | string): unknown {
  return runSandboxed(code, createContext(contextObject ?? {}), options, 'evalmachine.<anonymous>')
}

/** Run code in the worker's own global scope (no sandbox, as in Node). */
export function runInThisContext(code: string, options?: RunOptions | string): unknown {
  checkTimeout(options)
  return nativeEval(withSourceUrl(String(code), filenameOf(options, 'evalmachine.<anonymous>')))
}

/** Compile a function body with named parameters, optionally scoped to a context. */
export function compileFunction(
  code: string,
  params: readonly string[] = [],
  options: { contextExtensions?: object[]; parsingContext?: object; filename?: string } = {},
): (...args: unknown[]) => unknown {
  for (const param of params) {
    if (typeof param !== 'string' || !/^[A-Za-z_$][\w$]*$/.test(param)) throw codeError(`Invalid parameter ${String(param)}`, 'ERR_INVALID_ARG_VALUE', TypeError)
  }
  const context = options.parsingContext ? requireContext(options.parsingContext) : createContext({})
  if (options.contextExtensions?.length) {
    for (const extension of options.contextExtensions) Object.assign(context, extension)
  }
  return runSandboxed(`(function (${params.join(', ')}) {\n${code}\n})`, context, { filename: options.filename }, 'evalmachine.<anonymous>') as (...args: unknown[]) => unknown
}

/** A compiled script (syntax is checked at construction, as in Node). */
export class Script {
  private readonly code: string
  private readonly filename: string

  constructor(code: string, options?: RunOptions | string) {
    this.code = String(code)
    this.filename = filenameOf(options, 'evalmachine.<anonymous>')
    try {
      // Parse only: the body is never called. A script-only construct this rejects is not caught here, only at run.
      void new Function(this.code)
    } catch (error) {
      if (error instanceof SyntaxError && !/return|await|yield/.test(error.message)) throw error
    }
  }

  runInContext(contextifiedObject: object, options?: RunOptions): unknown {
    return runSandboxed(this.code, requireContext(contextifiedObject), { filename: this.filename, ...options }, this.filename)
  }

  runInNewContext(contextObject?: object, options?: RunOptions): unknown {
    return runSandboxed(this.code, createContext(contextObject ?? {}), { filename: this.filename, ...options }, this.filename)
  }

  runInThisContext(options?: RunOptions): unknown {
    return runInThisContext(this.code, { filename: this.filename, ...options })
  }

  createCachedData(): Uint8Array { return new Uint8Array(0) }
}

/** Node exposes these flags; the worker accepts and ignores them. */
export const constants = Object.freeze({ USE_MAIN_CONTEXT_DEFAULT_LOADER: Symbol('vm_dynamic_import_main_context_default'), DONT_CONTEXTIFY: Symbol('vm_context_no_contextify') })

/** CommonJS interop marker: the worker loader hands `default` to default imports (see ./builtins.ts). */
export const __esModule = true

/** CommonJS default export: the members `require()` hands a caller of this module. */
export default {
  Script, createContext, isContext, runInContext, runInNewContext, runInThisContext, compileFunction, constants,
}
