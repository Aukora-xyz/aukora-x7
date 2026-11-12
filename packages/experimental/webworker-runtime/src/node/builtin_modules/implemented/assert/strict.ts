/**
 * Strict assertions for Worker modules importing `node:assert/strict` (and, in the worker, `node:assert`).
 *
 * Aukora X6.1 Lane E3 widened this from `ok` alone to the strict-mode surface Node test files use: `equal`/`strictEqual`
 * (Object.is), `deepEqual`/`deepStrictEqual` (prototype-, tag- and key-exact, cycle-safe, Map/Set/Date/RegExp/Error/
 * typed-array aware), their negations, `throws`/`rejects` (class, validator, RegExp or object matcher),
 * `doesNotThrow`/`doesNotReject`, `match`/`doesNotMatch`, `fail` and `ifError`. Failures throw `AssertionError` with
 * Node's `code: 'ERR_ASSERTION'`, `actual`, `expected`, `operator` and `generatedMessage` fields. `node:assert` maps
 * here too, so its loose methods are strict in the worker: stricter than Node, never looser.
 */

/** Node's assertion error shape. */
export class AssertionError extends Error {
  readonly code = 'ERR_ASSERTION'
  actual: unknown
  expected: unknown
  operator: string
  generatedMessage: boolean

  constructor(options: { message?: string; actual?: unknown; expected?: unknown; operator?: string; generatedMessage?: boolean }) {
    super(options.message ?? 'Assertion failed')
    this.name = 'AssertionError'
    this.actual = options.actual
    this.expected = options.expected
    this.operator = options.operator ?? 'fail'
    this.generatedMessage = options.generatedMessage ?? options.message === undefined
  }
}

function raise(
  message: string | Error | undefined,
  generated: string,
  fields: { actual?: unknown; expected?: unknown; operator: string },
): never {
  if (message instanceof Error) throw message
  throw new AssertionError({ message: message ?? generated, generatedMessage: message === undefined, ...fields })
}

function show(value: unknown): string {
  if (typeof value === 'string') return `'${value}'`
  if (typeof value === 'bigint') return `${String(value)}n`
  if (typeof value === 'symbol' || typeof value === 'function' || value === undefined) return String(value)
  if (value instanceof Error) return `[${value.name}: ${value.message}]`
  try {
    const seen = new WeakSet<object>()
    const text = JSON.stringify(value, (_key, item: unknown) => {
      if (typeof item === 'bigint') return `${String(item)}n`
      if (item instanceof Map) return { '[Map]': [...item.entries()] }
      if (item instanceof Set) return { '[Set]': [...item.values()] }
      if (item !== null && typeof item === 'object') {
        if (seen.has(item)) return '[Circular]'
        seen.add(item)
      }
      return item
    }, 2)
    return (text ?? String(value)).slice(0, 4000)
  } catch {
    return String(value)
  }
}

/**
 * Require a truthy value; falsy values throw `ERR_ASSERTION` or the supplied Error.
 * @param value - Value to test.
 * @param message - Failure message or Error to throw unchanged; omitted messages use generic text.
 * @returns Nothing; successful completion narrows the value to a truthy value.
 */
export function ok(value: unknown, message?: string | Error): asserts value {
  if (value) return
  if (message instanceof Error) throw message
  throw Object.assign(new Error(message ?? 'The expression evaluated to a falsy value.'), {
    name: 'AssertionError',
    code: 'ERR_ASSERTION',
    actual: value,
    expected: true,
    operator: '==',
    generatedMessage: message === undefined,
  })
}

const tagOf = (value: object): string => Object.prototype.toString.call(value)

/**
 * Node's strict deep equality: same prototype and tag, same own enumerable string and symbol keys, deep-equal values;
 * Map/Set compare entries (object keys by deep equality); Date, RegExp, boxed primitives, Errors and typed arrays by value.
 * @param left - First value.
 * @param right - Second value.
 * @returns Whether the values are strictly deep-equal.
 */
export function isDeepStrictEqual(left: unknown, right: unknown): boolean {
  return deepEqualWith(left, right, new Map())
}

function deepEqualWith(a: unknown, b: unknown, memo: Map<object, Set<object>>): boolean {
  if (Object.is(a, b)) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false
  if (tagOf(a) !== tagOf(b)) return false
  const pairs = memo.get(a)
  if (pairs?.has(b)) return true
  if (pairs) pairs.add(b)
  else memo.set(a, new Set([b]))

  if (a instanceof Date) { if (!Object.is((a).getTime(), (b as Date).getTime())) return false }
  else if (a instanceof RegExp) {
    const r = b as RegExp
    if (a.source !== r.source || a.flags !== r.flags || a.lastIndex !== r.lastIndex) return false
  } else if (a instanceof Error) {
    const e = b as Error
    if (a.message !== e.message || a.name !== e.name) return false
  } else if (ArrayBuffer.isView(a)) {
    const x = a as unknown as ArrayLike<unknown> & ArrayBufferView, y = b as unknown as ArrayLike<unknown> & ArrayBufferView
    if (x.byteLength !== y.byteLength) return false
    if (a instanceof DataView) {
      const bytesA = new Uint8Array(x.buffer, x.byteOffset, x.byteLength), bytesB = new Uint8Array(y.buffer, y.byteOffset, y.byteLength)
      for (let i = 0; i < bytesA.length; i += 1) if (bytesA[i] !== bytesB[i]) return false
    } else {
      if (x.length !== y.length) return false
      for (let i = 0; i < x.length; i += 1) if (!Object.is(x[i], y[i])) return false
    }
  } else if (a instanceof ArrayBuffer || (typeof SharedArrayBuffer !== 'undefined' && a instanceof SharedArrayBuffer)) {
    const x = new Uint8Array(a), y = new Uint8Array(b as ArrayBuffer)
    if (x.length !== y.length) return false
    for (let i = 0; i < x.length; i += 1) if (x[i] !== y[i]) return false
  } else if (a instanceof Number || a instanceof String || a instanceof Boolean || a instanceof BigInt || a instanceof Symbol) {
    if (!Object.is(a.valueOf(), (b as { valueOf(): unknown }).valueOf())) return false
  } else if (a instanceof WeakMap || a instanceof WeakSet || a instanceof Promise) {
    return false
  }

  if (Array.isArray(a) && a.length !== (b as unknown[]).length) return false

  if (a instanceof Map) {
    const m = b as Map<unknown, unknown>
    if (a.size !== m.size) return false
    const unmatched: unknown[] = []
    for (const [key, value] of a) {
      if (m.has(key)) { if (!deepEqualWith(value, m.get(key), memo)) return false }
      else if (key !== null && typeof key === 'object') unmatched.push(key)
      else return false
    }
    for (const key of unmatched) {
      let found = false
      for (const [otherKey, otherValue] of m) {
        if (otherKey !== null && typeof otherKey === 'object' && !a.has(otherKey)
          && deepEqualWith(key, otherKey, memo) && deepEqualWith(a.get(key), otherValue, memo)) { found = true; break }
      }
      if (!found) return false
    }
  } else if (a instanceof Set) {
    const s = b as Set<unknown>
    if (a.size !== s.size) return false
    const unmatched: unknown[] = []
    for (const value of a) {
      if (s.has(value)) continue
      if (value !== null && typeof value === 'object') unmatched.push(value)
      else return false
    }
    for (const value of unmatched) {
      let found = false
      for (const other of s) {
        if (other !== null && typeof other === 'object' && !a.has(other) && deepEqualWith(value, other, memo)) { found = true; break }
      }
      if (!found) return false
    }
  }

  const keysA = Object.keys(a), keysB = Object.keys(b)
  if (keysA.length !== keysB.length) return false
  for (const key of keysA) {
    if (!Object.prototype.hasOwnProperty.call(b, key)) return false
    if (!deepEqualWith((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key], memo)) return false
  }
  const symbolsA = Object.getOwnPropertySymbols(a).filter(s => Object.prototype.propertyIsEnumerable.call(a, s))
  const symbolsB = Object.getOwnPropertySymbols(b).filter(s => Object.prototype.propertyIsEnumerable.call(b, s))
  if (symbolsA.length !== symbolsB.length) return false
  for (const symbol of symbolsA) {
    if (!Object.prototype.propertyIsEnumerable.call(b, symbol)) return false
    if (!deepEqualWith((a as Record<symbol, unknown>)[symbol], (b as Record<symbol, unknown>)[symbol], memo)) return false
  }
  return true
}

/** `Object.is` equality. */
export function strictEqual<T>(actual: unknown, expected: T, message?: string | Error): asserts actual is T {
  if (Object.is(actual, expected)) return
  raise(message, `Expected values to be strictly equal:\n\n${show(actual)} !== ${show(expected)}\n`, { actual, expected, operator: 'strictEqual' })
}

/** Negated `Object.is` equality. */
export function notStrictEqual(actual: unknown, expected: unknown, message?: string | Error): void {
  if (!Object.is(actual, expected)) return
  raise(message, `Expected "actual" to be strictly unequal to: ${show(expected)}`, { actual, expected, operator: 'notStrictEqual' })
}

/** Strict deep equality. */
export function deepStrictEqual<T>(actual: unknown, expected: T, message?: string | Error): asserts actual is T {
  if (isDeepStrictEqual(actual, expected)) return
  raise(message, `Expected values to be strictly deep-equal:\n+ actual - expected\n\n+ ${show(actual)}\n- ${show(expected)}\n`, { actual, expected, operator: 'deepStrictEqual' })
}

/** Negated strict deep equality. */
export function notDeepStrictEqual(actual: unknown, expected: unknown, message?: string | Error): void {
  if (!isDeepStrictEqual(actual, expected)) return
  raise(message, `Expected "actual" not to be strictly deep-equal to: ${show(expected)}`, { actual, expected, operator: 'notDeepStrictEqual' })
}

/** Strict mode: `equal` is `strictEqual`. */
export const equal = strictEqual
/** Strict mode: `notEqual` is `notStrictEqual`. */
export const notEqual = notStrictEqual
/** Strict mode: `deepEqual` is `deepStrictEqual`. */
export const deepEqual = deepStrictEqual
/** Strict mode: `notDeepEqual` is `notDeepStrictEqual`. */
export const notDeepEqual = notDeepStrictEqual

/** Throw unconditionally. */
export function fail(message?: string | Error): never {
  if (message instanceof Error) throw message
  throw new AssertionError({ message: message ?? 'Failed', operator: 'fail', generatedMessage: message === undefined })
}

/** Throw `value` when it is neither `null` nor `undefined`. */
export function ifError(value: unknown): void {
  if (value === null || value === undefined) return
  if (value instanceof Error) throw value
  throw new AssertionError({ message: `ifError got unwanted exception: ${show(value)}`, actual: value, expected: null, operator: 'ifError' })
}

type Matcher = RegExp | ((error: unknown) => unknown) | (new (...args: never[]) => unknown) | Record<string, unknown> | Error

function checkThrown(error: unknown, expected: Matcher | string | undefined, message: string | Error | undefined, operator: string): void {
  if (expected === undefined || typeof expected === 'string') return
  if (expected instanceof RegExp) {
    if (expected.test(String(error))) return
    raise(message, `The input did not match the regular expression ${String(expected)}. Input:\n\n${show(String(error))}\n`, { actual: error, expected, operator })
  }
  if (typeof expected === 'function') {
    const ctor = expected as { prototype?: unknown }
    if (ctor.prototype !== undefined && error instanceof (expected as new () => unknown)) return
    if (Error.isPrototypeOf(expected) || expected === Error) {
      raise(message, `The error is expected to be an instance of "${(expected as { name?: string }).name ?? 'Error'}". Received ${show(error)}`, { actual: error, expected, operator })
    }
    const verdict = (expected as (e: unknown) => unknown).call(undefined, error)
    if (verdict === true) return
    raise(message, `The ${(expected as { name?: string }).name ? `"${(expected as { name: string }).name}" ` : ''}validation function is expected to return "true". Received ${show(verdict)}`, { actual: error, expected, operator })
  }
  if (expected !== null && typeof expected === 'object') {
    const target = error as Record<string, unknown> | null
    const keys = expected instanceof Error ? ['name', 'message', ...Object.keys(expected)] : Object.keys(expected)
    for (const key of keys) {
      const want = (expected as Record<string, unknown>)[key]
      const got = target === null || target === undefined ? undefined : target[key]
      if (want instanceof RegExp && typeof got === 'string') { if (want.test(got)) continue }
      else if (isDeepStrictEqual(got, want)) continue
      raise(message, `Expected values to be strictly deep-equal at "${key}":\n+ actual - expected\n\n+ ${show(got)}\n- ${show(want)}\n`, { actual: error, expected, operator })
    }
  }
}

/** The function must throw; the error is checked against `expected` when given. */
export function throws(fn: () => unknown, expected?: Matcher | string, message?: string | Error): void {
  if (typeof fn !== 'function') throw new TypeError('The "fn" argument must be of type function')
  let threw = false, error: unknown
  try { fn() } catch (reason) { threw = true; error = reason }
  if (!threw) {
    const note = typeof expected === 'string' ? `: ${expected}` : message !== undefined && !(message instanceof Error) ? `: ${message}` : '.'
    raise(message instanceof Error ? message : undefined, `Missing expected exception${note}`, { actual: undefined, expected, operator: 'throws' })
  }
  checkThrown(error, expected, message, 'throws')
}

/** The function must not throw. */
export function doesNotThrow(fn: () => unknown, expected?: Matcher | string, message?: string | Error): void {
  if (typeof fn !== 'function') throw new TypeError('The "fn" argument must be of type function')
  try { fn() } catch (error) {
    const note = typeof expected === 'string' ? expected : typeof message === 'string' ? message : undefined
    throw new AssertionError({ message: `Got unwanted exception${note ? `: ${note}` : '.'}\nActual message: "${error instanceof Error ? error.message : String(error)}"`,
      actual: error, expected, operator: 'doesNotThrow', generatedMessage: note === undefined })
  }
}

async function settle(input: unknown): Promise<{ rejected: boolean; reason: unknown }> {
  const promise = typeof input === 'function' ? (input as () => unknown)() : input
  if (promise === null || typeof promise !== 'object' || typeof (promise as { then?: unknown }).then !== 'function') {
    throw Object.assign(new TypeError('The "promiseFn" argument must be of type function or an instance of Promise'), { code: 'ERR_INVALID_RETURN_VALUE' })
  }
  try { await promise; return { rejected: false, reason: undefined } } catch (reason) { return { rejected: true, reason } }
}

/** The promise (or async function) must reject; the reason is checked against `expected` when given. */
export async function rejects(input: unknown, expected?: Matcher | string, message?: string | Error): Promise<void> {
  const { rejected, reason } = await settle(input)
  if (!rejected) {
    const note = typeof expected === 'string' ? `: ${expected}` : typeof message === 'string' ? `: ${message}` : '.'
    raise(message instanceof Error ? message : undefined, `Missing expected rejection${note}`, { actual: undefined, expected, operator: 'rejects' })
  }
  checkThrown(reason, expected, message, 'rejects')
}

/** The promise (or async function) must fulfil. */
export async function doesNotReject(input: unknown, expected?: Matcher | string, message?: string | Error): Promise<void> {
  const { rejected, reason } = await settle(input)
  if (!rejected) return
  const note = typeof expected === 'string' ? expected : typeof message === 'string' ? message : undefined
  throw new AssertionError({ message: `Got unwanted rejection${note ? `: ${note}` : '.'}\nActual message: "${reason instanceof Error ? reason.message : String(reason)}"`,
    actual: reason, expected, operator: 'doesNotReject', generatedMessage: note === undefined })
}

/** The string must match the RegExp. */
export function match(value: string, pattern: RegExp, message?: string | Error): void {
  if (typeof value === 'string' && pattern.test(value)) return
  raise(message, `The input did not match the regular expression ${String(pattern)}. Input:\n\n${show(value)}\n`, { actual: value, expected: pattern, operator: 'match' })
}

/** The string must not match the RegExp. */
export function doesNotMatch(value: string, pattern: RegExp, message?: string | Error): void {
  if (typeof value === 'string' && !pattern.test(value)) return
  raise(message, `The input was expected to not match the regular expression ${String(pattern)}. Input:\n\n${show(value)}\n`, { actual: value, expected: pattern, operator: 'doesNotMatch' })
}

/** CommonJS interop marker for lowered ESM default imports. */
export const __esModule = true

const members = {
  ok, equal, notEqual, strictEqual, notStrictEqual, deepEqual, notDeepEqual, deepStrictEqual, notDeepStrictEqual,
  throws, doesNotThrow, rejects, doesNotReject, match, doesNotMatch, fail, ifError, AssertionError,
}

/** Callable truthiness assertion carrying every strict method; `assert.strict` is itself. */
const assert = Object.assign(ok, members) as typeof ok & typeof members & { strict: unknown }
assert.strict = assert

/** Same object as the default export, for `import { strict } from 'node:assert'`. */
export const strict = assert

export default assert
