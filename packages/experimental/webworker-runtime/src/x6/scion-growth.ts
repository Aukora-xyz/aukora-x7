/** One explicit typed-source growth operation through the existing live Seed cycle. */
import type { ScionInput } from './scion.ts'
import { sha256HexSync } from '../module-system/module-loader.ts'

export interface ScionGrowthInput extends ScionInput {
  readonly name: string
  readonly cases: readonly unknown[]
  readonly expectedBallId?: string
}
interface Prepared {
  readonly ok: boolean
  readonly compiled: boolean
  readonly prepared: boolean
  readonly activated: boolean
  readonly localSaved: boolean
  readonly code?: string
  readonly sha256: string
  readonly specifier: string
  readonly inputRoot: string
  readonly compiler: unknown
  readonly modules: number
  readonly warnings: readonly string[]
  readonly saveError?: string
}
export interface CandidateTrialResult {
  readonly ok: boolean
  readonly results: readonly Record<string, unknown>[]
  readonly durationMs: number
  readonly error?: string
  /** Recomputed by the parent runner; worker/caller attestations are ignored. */
  readonly graderControls?: GraderControls
  readonly routeEvidence?: RouteEvidence
  readonly negativeControlRejected?: boolean
}
/** Bounded observations, not a claim of execution containment or intended algorithm use. */
export interface RouteEvidence {
  readonly policyId: string
  readonly policyDigest: string
  readonly runnerDigest: string
  readonly candidateDigest: string
  readonly observedEventDigest: string
  readonly status: 'unsupported' | 'checked' | 'violated' | 'inconclusive'
  readonly checkedProperties: readonly string[]
  readonly unsupportedProperties: readonly string[]
}
/** Controls executed against the same comparator that grades the candidate's returned outputs. */
export interface GraderControls {
  readonly runnerDigest: string
  readonly graderDigest: string
  readonly caseSetDigest: string
  readonly controlSetDigest: string
  readonly knownGoodAccepted: boolean
  readonly knownBadRejected: boolean
  readonly acceptAllRejected: boolean
  readonly rejectAllRejected: boolean
  readonly allPassed: boolean
}
export interface CandidateTrialInput {
  readonly name: string
  readonly code: string
  readonly cases: readonly unknown[]
  readonly timeoutMs?: number
}
interface GrowthDependencies {
  readonly head: () => string
  readonly writable: () => boolean
  readonly active: (name: string, sha256: string) => boolean
  readonly prepare: (input: ScionInput & { name: string; includeCode: true }) => Promise<Prepared>
  readonly cycle: (input: { action: 'grow'; name: string; code: string; cases: readonly unknown[] }) => Promise<unknown>
  readonly trial?: (input: CandidateTrialInput) => Promise<CandidateTrialResult>
}
const object = (value: unknown): value is Record<string, unknown> => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
)
const ENTRY = '__scion_growth_entry__.ts'
const DEFAULT_TRIAL_TIMEOUT_MS = 5_000
const ALLOWLISTED_TRIAL_BUILTINS = [
  'crypto', 'node:crypto', 'buffer', 'node:buffer', 'path', 'node:path',
  'util', 'node:util', 'events', 'node:events', 'assert', 'node:assert',
] as const

const TRIAL_RUNNER_SOURCE = `
function canonicalJson(val) {
  if (val === null || typeof val !== 'object') return JSON.stringify(val);
  if (Array.isArray(val)) {
    return '[' + val.map(item => canonicalJson(item === undefined ? null : item)).join(',') + ']';
  }
  const keys = Object.keys(val).filter(k => val[k] !== undefined).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalJson(val[k])).join(',') + '}';
}
function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
// import() reaches the realm's module loader (the network in a browser, node:fs in Node), past safeRequire.
// Keywords cannot be spelled with escapes, so whitespace and comments are the only separators to allow.
const DYNAMIC_IMPORT = /(^|[^A-Za-z0-9_$.])import\\s*(?:\\/\\*[\\s\\S]*?\\*\\/\\s*|\\/\\/[^\\n]*(?:\\n|$)\\s*)*\\(/;
const INTRINSIC_NAMES = [
  'Object', 'Function', 'Array', 'String', 'Number', 'Boolean', 'Symbol', 'BigInt', 'Math', 'JSON', 'Reflect',
  'Promise', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Date', 'RegExp', 'Error', 'TypeError', 'RangeError',
  'SyntaxError', 'ReferenceError', 'EvalError', 'URIError', 'AggregateError', 'ArrayBuffer', 'DataView',
  'Uint8Array', 'Int8Array', 'Uint16Array', 'Int16Array', 'Uint32Array', 'Int32Array', 'Float32Array',
  'Float64Array', 'Uint8ClampedArray', 'BigInt64Array', 'BigUint64Array', 'Proxy',
];
// After the candidate is compiled and before any of its code runs: no further code can be generated from
// strings (so import() cannot be assembled at run time), and the intrinsics the verdict depends on are
// frozen and their global names pinned, so a candidate cannot make the comparison below lie.
function hardenTrialRealm() {
  const g = globalThis;
  const refuse = op => function () { throw new Error('CANDIDATE_TRIAL_EVAL_FORBIDDEN: ' + op); };
  const pin = (target, key, value) => {
    try { Object.defineProperty(target, key, { value, writable: false, configurable: false, enumerable: false }); } catch {}
  };
  const generators = [
    Function, Object.getPrototypeOf(async function () {}).constructor,
    Object.getPrototypeOf(function* () {}).constructor, Object.getPrototypeOf(async function* () {}).constructor,
  ];
  for (const ctor of generators) pin(ctor.prototype, 'constructor', refuse('Function'));
  pin(g, 'eval', refuse('eval'));
  pin(g, 'Function', refuse('Function'));
  for (const name of ['setTimeout', 'setInterval']) {
    const original = g[name];
    if (typeof original === 'function') {
      pin(g, name, function (handler, ...rest) {
        if (typeof handler !== 'function') throw new Error('CANDIDATE_TRIAL_EVAL_FORBIDDEN: ' + name + ' string');
        return original.call(g, handler, ...rest);
      });
    }
  }
  const seen = new Set();
  const freeze = value => {
    if (value === null || (typeof value !== 'object' && typeof value !== 'function') || seen.has(value)) return;
    seen.add(value);
    Object.freeze(value);
    if (typeof value === 'function' && value.prototype) freeze(value.prototype);
  };
  for (const name of INTRINSIC_NAMES) {
    const value = g[name];
    if (value !== undefined) { pin(g, name, value); freeze(value); }
  }
  for (const ctor of generators) freeze(ctor.prototype);
  freeze(Object.getPrototypeOf([][Symbol.iterator]()));
  freeze(Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]())));
  freeze(Object.getPrototypeOf(new Map().entries()));
  freeze(Object.getPrototypeOf(new Set().values()));
  freeze(Object.getPrototypeOf(''[Symbol.iterator]()));
  pin(g, 'globalThis', g);
}
async function evaluateCandidate(input, safeRequire) {
  const startedAt = Date.now();
  try {
    if (typeof input.code !== 'string' || DYNAMIC_IMPORT.test(input.code)) {
      return { ok: false, results: [], durationMs: Date.now() - startedAt, error: 'CANDIDATE_TRIAL_IMPORT_BLOCKED: dynamic import()' };
    }
    const moduleObj = { exports: {} };
    const forbidden = op => () => { throw new Error('CANDIDATE_TRIAL_MUTATION_FORBIDDEN: ' + op); };
    const fn = new Function('module', 'exports', 'require', input.code);
    hardenTrialRealm();
    fn(moduleObj, moduleObj.exports, safeRequire);
    const rawOrgan = moduleObj.exports;
    const organ = isObj(rawOrgan) && typeof rawOrgan.run === 'function' && typeof rawOrgan.name === 'string'
      ? rawOrgan
      : (isObj(rawOrgan) && isObj(rawOrgan.default) ? rawOrgan.default : null);
    if (!organ || typeof organ.run !== 'function' || organ.apply !== undefined || organ.name !== input.name) {
      return { ok: false, results: [], durationMs: Date.now() - startedAt, error: 'SCION_ORGAN_NAME_MISMATCH' };
    }
    const trialCtx = Object.freeze({
      trial: true,
      organs: Object.freeze({
        list: () => [],
        install: forbidden('organs.install'),
        undo: forbidden('organs.undo'),
        retire: forbidden('organs.retire'),
        call: forbidden('organs.call'),
      }),
      x6: Object.freeze({
        headAdopt: forbidden('x6.headAdopt'),
        ballPut: forbidden('x6.ballPut'),
        repo: forbidden('x6.repo'),
      }),
      fs: Object.freeze({
        readFile: forbidden('fs.readFile'),
        writeFile: forbidden('fs.writeFile'),
      }),
    });
    const results = [];
    for (const rawCase of input.cases) {
      const c = rawCase || {};
      const id = typeof c.id === 'string' ? c.id : 'case';
      const argsCopy = JSON.parse(JSON.stringify(c.args ?? {}));
      let got;
      try {
        got = await organ.run(argsCopy, trialCtx);
      } catch (err) {
        got = { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
      const gotErr = isObj(got)
        ? (typeof got.error === 'string' ? got.error : (typeof got.code === 'string' ? got.code : ''))
        : '';
      const expErr = typeof c.expectError === 'string' ? c.expectError : '';
      const pass = c.expectError !== undefined
        ? (isObj(got) && got.ok === false && gotErr.includes(expErr))
        : canonicalJson(got) === canonicalJson(c.expect);
      const output = JSON.stringify(got === undefined ? null : got);
      if (new TextEncoder().encode(output).byteLength > 128 * 1024) throw new Error('CANDIDATE_TRIAL_OUTPUT_LIMIT');
      results.push({ id, pass, got: JSON.parse(output) });
    }
    const allPassed = results.length > 0 && results.every(r => r.pass === true);
    const failedIds = results.filter(r => !r.pass).map(r => r.id).join(', ');
    return {
      ok: allPassed,
      results,
      durationMs: Date.now() - startedAt,
      ...(allPassed ? {} : { error: 'Candidate failed isolated trial (' + failedIds + ')' }),
    };
  } catch (error) {
    return {
      ok: false,
      results: [],
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
`

// The bootstrap is one IIFE: parentPort, workerData and the real require are lexical locals that the
// candidate's Function body (which sees only globals) can never name. The eval worker also exposes
// require/module/exports as globals; those are replaced before any candidate code is compiled.
const NODE_TRIAL_WORKER_SCRIPT = `
'use strict';
(function bootstrapTrialWorker(nodeRequire) {
const { parentPort, workerData } = nodeRequire('node:worker_threads');
const require = nodeRequire;
const postToParent = parentPort.postMessage.bind(parentPort);
for (const key of ['require', 'module', 'exports', '__filename', '__dirname']) {
  try {
    Object.defineProperty(globalThis, key, {
      configurable: false,
      enumerable: false,
      get() { throw new Error('CANDIDATE_TRIAL_IMPORT_BLOCKED: ' + key); },
    });
  } catch {}
}
const allowed = new Map([
  ['crypto', require('node:crypto')],
  ['node:crypto', require('node:crypto')],
  ['buffer', require('node:buffer')],
  ['node:buffer', require('node:buffer')],
  ['path', require('node:path')],
  ['node:path', require('node:path')],
  ['util', require('node:util')],
  ['node:util', require('node:util')],
  ['events', require('node:events')],
  ['node:events', require('node:events')],
  ['assert', require('node:assert')],
  ['node:assert', require('node:assert')],
]);
for (const key of [
  'fetch', 'WebSocket', 'EventSource', 'XMLHttpRequest',
  'importScripts', 'indexedDB', 'caches', 'BroadcastChannel', 'SharedWorker', 'Worker',
]) {
  try {
    Object.defineProperty(globalThis, key, {
      configurable: false,
      enumerable: false,
      get() { throw new Error('CANDIDATE_TRIAL_IO_FORBIDDEN: ' + key); },
    });
  } catch {}
}
const denyProc = op => () => { throw new Error('CANDIDATE_TRIAL_PROCESS_FORBIDDEN: ' + op); };
try {
  process.env = Object.freeze({});
  for (const fn of [
    'exit', 'kill', 'abort', 'chdir', 'dlopen', 'binding',
    '_linkedBinding', 'getBuiltinModule', 'setuid', 'setgid',
  ]) {
    if (fn in process) process[fn] = denyProc(fn);
  }
} catch {}
const safeRequire = id => {
  if (allowed.has(id)) return allowed.get(id);
  throw new Error('CANDIDATE_TRIAL_IMPORT_BLOCKED: ' + String(id));
};
${TRIAL_RUNNER_SOURCE}
evaluateCandidate(workerData, safeRequire).then(
  res => postToParent(res),
  err => postToParent({
    ok: false,
    results: [],
    durationMs: 0,
    error: err instanceof Error ? err.message : String(err),
  })
);
})(require);
`

/** I/O globals plus the worker's own message channel, so a candidate cannot post a forged result frame. */
const BROWSER_TRIAL_LOCKED_GLOBALS = [
  'fetch', 'WebSocket', 'EventSource', 'XMLHttpRequest',
  'importScripts', 'indexedDB', 'caches', 'BroadcastChannel', 'SharedWorker', 'Worker',
  'postMessage', 'close', 'addEventListener', 'removeEventListener', 'onmessage', 'onmessageerror',
] as const
const CHANNEL_KEYS = new Set(['postMessage', 'close', 'addEventListener', 'removeEventListener', 'onmessage', 'onmessageerror'])

function lockDownBrowserTrialGlobals(): void {
  const deny = (key: string): PropertyDescriptor => ({
    configurable: false,
    enumerable: false,
    get() { throw new Error(`CANDIDATE_TRIAL_IO_FORBIDDEN: ${key}`) },
    set() { throw new Error(`CANDIDATE_TRIAL_IO_FORBIDDEN: ${key}`) },
  })
  for (const key of BROWSER_TRIAL_LOCKED_GLOBALS) {
    try {
      Object.defineProperty(globalThis, key, deny(key))
    } catch {
      // Ignore non-configurable globals in restricted worker scopes.
    }
  }
  // The channel methods live on the scope's prototypes (DedicatedWorkerGlobalScope, WorkerGlobalScope,
  // EventTarget); deny them there too, or `Object.getPrototypeOf(self).postMessage.call(self, ...)` still posts.
  const parent = (value: object): object | null => Object.getPrototypeOf(value) as object | null
  for (let proto = parent(globalThis); proto && proto !== Object.prototype; proto = parent(proto)) {
    for (const key of Object.getOwnPropertyNames(proto)) {
      if (!CHANNEL_KEYS.has(key)) continue
      try { Object.defineProperty(proto, key, deny(key)) } catch { /* non-configurable: covered by the own-property lock */ }
    }
  }
}

/** Run one isolated candidate trial inside a fresh DedicatedWorkerGlobalScope and close. */
export async function runScionTrialWorker(
  data: unknown,
  builtins?: Readonly<Record<string, () => unknown>>,
): Promise<void> {
  let id = ''
  const startedAt = Date.now()
  // Captured before the lockdown: only this closure can answer the parent or end the worker.
  const postToParent = self.postMessage.bind(self)
  const closeWorker = self.close.bind(self)
  try {
    if (
      !object(data) || data.t !== 'scion-trial-start'
      || typeof data.id !== 'string' || !data.id || data.id.length > 128
      || !object(data.input)
    ) {
      throw new Error('Trial worker request needs id and input')
    }
    id = data.id
    const rawInput = data.input
    const name = typeof rawInput.name === 'string' ? rawInput.name : ''
    const code = typeof rawInput.code === 'string' ? rawInput.code : ''
    const suite = freezeCases(rawInput.cases)
    const allowed = new Map<string, () => unknown>()
    const proc = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process
    for (const modId of ALLOWLISTED_TRIAL_BUILTINS) {
      const bare = modId.startsWith('node:') ? modId.slice(5) : modId
      const factory = builtins?.[modId] ?? builtins?.[bare]
      if (typeof factory === 'function') {
        allowed.set(modId, factory)
      } else if (typeof proc?.getBuiltinModule === 'function') {
        const mod = proc.getBuiltinModule(modId)
        if (mod !== undefined) allowed.set(modId, () => mod)
      }
    }
    lockDownBrowserTrialGlobals()
    const safeRequire = (modId: string): unknown => {
      const factory = allowed.get(modId)
      if (factory) return factory()
      throw new Error(`CANDIDATE_TRIAL_IMPORT_BLOCKED: ${String(modId)}`)
    }
    const runner = new Function(
      'input',
      'safeRequire',
      `${TRIAL_RUNNER_SOURCE}\nreturn evaluateCandidate(input, safeRequire);`,
    ) as (
      input: { name: string; code: string; cases: readonly unknown[] },
      safeRequire: (id: string) => unknown,
    ) => Promise<CandidateTrialResult>
    const result = await runner({ name, code, cases: suite.cases }, safeRequire)
    postToParent({ t: 'scion-trial-result', id, result })
  } catch (error) {
    postToParent({
      t: 'scion-trial-result',
      id,
      result: {
        ok: false,
        results: [],
        durationMs: Date.now() - startedAt,
        error: (error instanceof Error ? error.message : String(error)).slice(0, 4000),
      },
    })
  } finally {
    closeWorker()
  }
}

let trialScript: { readonly href: string; readonly url: Promise<string | null> } | null = null
/** How long a trial waits for the boot copy before it starts from the served URL instead. */
const PRIME_WAIT_MS = 2000

/**
 * Keep a Blob copy of this worker's own bundle, read at boot while its hashed URL is still served. A live deploy
 * retires that URL, and a trial worker started from it then fails to load; the copy is the same self-contained
 * bundle. The host worker calls this on `init`; trials use the copy once it exists, else the served URL.
 * @returns A blob: URL for the copy, or null when it cannot be read here.
 */
export function primeScionTrialScript(): Promise<string | null> {
  if (typeof self === 'undefined' || typeof self.location?.href !== 'string') return Promise.resolve(null)
  const href = self.location.href
  if (trialScript?.href === href) return trialScript.url
  const url = (async () => {
    try {
      if (typeof fetch !== 'function' || typeof Blob !== 'function' || typeof URL.createObjectURL !== 'function') return null
      const response = await fetch(href, { credentials: 'same-origin', signal: AbortSignal.timeout(60_000) })
      if (!response.ok || !/javascript|ecmascript/i.test(response.headers.get('content-type') ?? '')) return null
      return URL.createObjectURL(new Blob([await response.text()], { type: 'text/javascript' }))
    } catch {
      return null
    }
  })()
  trialScript = { href, url }
  return url
}

/**
 * Evaluate a compiled CJS organ candidate in an isolated disposable worker realm ("imagination cell")
 * with copied JSON inputs and wall-clock termination. Worker shims are not proof of containment.
 */
async function executeTrial(input: CandidateTrialInput): Promise<CandidateTrialResult> {
  const startedAt = Date.now()
  try {
    if (!input || typeof input.name !== 'string' || !/^[a-z][a-z0-9-]{0,40}$/.test(input.name)) {
      throw new Error('SCION_ORGAN_NAME_MISMATCH')
    }
    if (typeof input.code !== 'string' || !input.code.trim()) {
      throw new Error('Candidate code must be a non-empty string')
    }
    if (new TextEncoder().encode(input.code).byteLength > 2 * 1024 * 1024) throw new Error('CANDIDATE_TRIAL_SOURCE_LIMIT')
    const suite = freezeCases(input.cases)
    const rawTimeout = input.timeoutMs ?? DEFAULT_TRIAL_TIMEOUT_MS
    const timeoutMs = typeof rawTimeout === 'number' && Number.isFinite(rawTimeout)
      ? Math.max(50, Math.min(15_000, Math.trunc(rawTimeout)))
      : DEFAULT_TRIAL_TIMEOUT_MS

    if (typeof Worker === 'function' && typeof self !== 'undefined' && typeof self.location?.href === 'string') {
      const href = self.location.href
      // The copy is waited for briefly at most, inside the trial's own time: a slow boot download never holds a trial.
      let primeTimer: ReturnType<typeof setTimeout> | undefined
      const copy = trialScript?.href === href ? await Promise.race([trialScript.url, new Promise<null>((resolve) => {
        primeTimer = setTimeout(() => { resolve(null) }, Math.min(PRIME_WAIT_MS, timeoutMs))
      })]) : null
      clearTimeout(primeTimer)
      const scriptUrl = copy ?? href
      return await new Promise<CandidateTrialResult>((resolve) => {
        const worker = new Worker(scriptUrl, { type: 'module', name: 'auma-scion-trial' })
        const id = sha256HexSync(`${String(Date.now())}-${String(Math.random())}`).slice(0, 32)
        let settled = false
        const finish = (result: CandidateTrialResult): void => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          worker.terminate()
          resolve(result)
        }
        const timer = setTimeout(() => {
          finish({
            ok: false,
            results: [],
            durationMs: Date.now() - startedAt,
            error: 'CANDIDATE_TRIAL_TIMEOUT',
          })
        }, timeoutMs)
        worker.addEventListener('error', (event) => {
          finish({
            ok: false,
            results: [],
            durationMs: Date.now() - startedAt,
            error: `CANDIDATE_TRIAL_WORKER_FAILED: ${event.message || 'the trial worker did not load or crashed'}`,
          })
        })
        worker.addEventListener('messageerror', () => {
          finish({
            ok: false,
            results: [],
            durationMs: Date.now() - startedAt,
            error: 'CANDIDATE_TRIAL_WORKER_FAILED: the trial result could not be decoded',
          })
        })
        worker.addEventListener('message', (event: MessageEvent) => {
          const reply = event.data as Record<string, unknown> | null
          if (!reply || reply.t !== 'scion-trial-result' || reply.id !== id || !object(reply.result)) return
          const res = reply.result
          finish({
            ok: res.ok === true,
            results: Array.isArray(res.results) ? (res.results as Record<string, unknown>[]) : [],
            durationMs: typeof res.durationMs === 'number' ? res.durationMs : Date.now() - startedAt,
            ...(typeof res.error === 'string' ? { error: res.error } : {}),
          })
        })
        worker.postMessage({
          t: 'scion-trial-start',
          id,
          input: { name: input.name, code: input.code, cases: suite.cases },
        })
      })
    }

    type NodeWorkerLike = {
      on(event: string, listener: (...args: unknown[]) => void): void
      terminate(): Promise<number>
    }
    type WorkerThreadsModule = {
      Worker: new (script: string, options: Record<string, unknown>) => NodeWorkerLike
    }
    const proc = (globalThis as { process?: { execPath?: string; getBuiltinModule?: (id: string) => unknown } }).process
    const wt = proc?.execPath !== '/dsh/bin/node' && typeof proc?.getBuiltinModule === 'function'
      ? (proc.getBuiltinModule('node:worker_threads') as WorkerThreadsModule | undefined)
      : undefined

    if (wt?.Worker) {
      return await new Promise<CandidateTrialResult>((resolve) => {
        const worker = new wt.Worker(NODE_TRIAL_WORKER_SCRIPT, {
          eval: true,
          workerData: { name: input.name, code: input.code, cases: suite.cases },
        })
        let settled = false
        const finish = (result: CandidateTrialResult): void => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          void worker.terminate()
          resolve(result)
        }
        const timer = setTimeout(() => {
          finish({
            ok: false,
            results: [],
            durationMs: Date.now() - startedAt,
            error: 'CANDIDATE_TRIAL_TIMEOUT',
          })
        }, timeoutMs)
        worker.on('message', (msg: unknown) => {
          if (!object(msg)) {
            finish({ ok: false, results: [], durationMs: Date.now() - startedAt, error: 'Invalid trial response' })
            return
          }
          finish({
            ok: msg.ok === true,
            results: Array.isArray(msg.results) ? (msg.results as Record<string, unknown>[]) : [],
            durationMs: typeof msg.durationMs === 'number' ? msg.durationMs : Date.now() - startedAt,
            ...(typeof msg.error === 'string' ? { error: msg.error } : {}),
          })
        })
        worker.on('error', (err: unknown) => {
          finish({
            ok: false,
            results: [],
            durationMs: Date.now() - startedAt,
            error: err instanceof Error ? err.message : String(err),
          })
        })
        worker.on('exit', (code: unknown) => {
          if (!settled) {
            finish({
              ok: false,
              results: [],
              durationMs: Date.now() - startedAt,
              error: `CANDIDATE_TRIAL_WORKER_FAILED: the trial worker exited unexpectedly (code ${String(code)})`,
            })
          }
        })
      })
    }

    return {
      ok: false,
      results: [],
      durationMs: Date.now() - startedAt,
      error: 'CANDIDATE_TRIAL_ISOLATION_UNAVAILABLE',
    }
  } catch (error) {
    return {
      ok: false,
      results: [],
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

function freezeCases(value: unknown): { cases: readonly unknown[]; suiteSha256: string } {
  let nodes = 0
  const copy = (input: unknown, depth = 0): unknown => {
    if (++nodes > 4096 || depth > 32) throw new Error('Acceptance cases exceed structural limits')
    if (input === null || typeof input === 'string' || typeof input === 'boolean') return input
    if (typeof input === 'number' && Number.isFinite(input)) return input
    if (Array.isArray(input)) return Object.freeze(input.map(item => copy(item, depth + 1)))
    if (!object(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw new Error('Acceptance cases must be finite JSON values')
    const result: Record<string, unknown> = Object.create(null)
    for (const key of Object.keys(input).sort()) result[key] = copy(input[key], depth + 1)
    return Object.freeze(result)
  }
  if (!Array.isArray(value) || value.length < 1 || value.length > 32) throw new Error('Supply 1 to 32 explicit live acceptance cases')
  const ids = new Set<string>()
  const cases = value.map((item, index) => {
    if (!object(item) || Object.keys(item).some(key => !['id', 'args', 'expect', 'expectError', 'routePolicy'].includes(key))) throw new Error('Invalid acceptance case fields')
    const id = item.id ?? `case-${String(index + 1)}`
    if (typeof id !== 'string' || !id.trim() || id.length > 128 || ids.has(id)) throw new Error('Acceptance case IDs must be unique short strings')
    ids.add(id)
    const errorCase = Object.hasOwn(item, 'expectError')
    if (errorCase === Object.hasOwn(item, 'expect')) throw new Error('Each case requires exactly one of expect or expectError')
    if (errorCase && (typeof item.expectError !== 'string' || !item.expectError.trim() || item.expectError.length > 512)) throw new Error('expectError must be a nonempty bounded string')
    if (item.args !== undefined && !object(item.args)) throw new Error('Acceptance args must be an object')
    if (item.routePolicy !== undefined) {
      if (!object(item.routePolicy) || Object.keys(item.routePolicy).some(key => !['policyId', 'requiredExports', 'allowedCapabilities', 'forbidEnvKeys', 'heldOutPerturbations'].includes(key))) throw new Error('Invalid route policy fields')
      if (item.routePolicy.policyId !== undefined && (typeof item.routePolicy.policyId !== 'string' || !/^[a-zA-Z0-9._/-]{1,128}$/.test(item.routePolicy.policyId))) throw new Error('Invalid route policy id')
      for (const key of ['requiredExports', 'allowedCapabilities', 'forbidEnvKeys']) {
        const list = item.routePolicy[key]
        if (list !== undefined && (!Array.isArray(list) || list.length > 32 || list.some(value => typeof value !== 'string' || !/^[a-zA-Z0-9._/-]{1,128}$/.test(value)))) throw new Error('Invalid route policy property list')
      }
      // Perturbations are accepted as declarations only; this runner cannot attest secrecy or coverage.
      if (item.routePolicy.heldOutPerturbations !== undefined && (!Array.isArray(item.routePolicy.heldOutPerturbations) || item.routePolicy.heldOutPerturbations.length > 16)) throw new Error('Invalid held-out perturbations')
    }
    return copy({
      id, args: item.args ?? {}, ...(errorCase ? { expectError: item.expectError } : { expect: item.expect }),
      ...(item.routePolicy === undefined ? {} : { routePolicy: item.routePolicy }),
    })
  })
  const serialized = JSON.stringify(cases)
  if (new TextEncoder().encode(serialized).byteLength > 64 * 1024) throw new Error('Acceptance cases exceed 64 KiB')
  return { cases: Object.freeze(cases), suiteSha256: sha256HexSync(serialized) }
}

function canonicalTrialJson(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonicalTrialJson).join(',') + ']'
  if (object(value)) return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonicalTrialJson(value[key])).join(',') + '}'
  return JSON.stringify(value)
}

/**
 * Bind a retention admission to executable suite inputs, not pending proposals or JSON formatting.
 * @param suite - Parsed retention suite from the bounded runtime read.
 * @returns SHA-256 of the six executable fields with stable object-key ordering.
 */
export function retentionSuiteDigest(suite: Record<string, unknown>): string {
  return sha256HexSync(canonicalTrialJson(Object.fromEntries(
    ['schema', 'harness', 'organs', 'fixedNow', 'cases', 'fixtures'].map(key => [key, suite[key] ?? null]),
  )))
}

/**
 * Admit additive cases, fixtures and organs without changing a build-pinned obligation.
 * @param suite - Current runtime-read suite; duplicate identities are refused.
 * @param baseline - Detached six-field suite snapshot authenticated by the build identity.
 * @returns Whether every baseline case, fixture and execution setting remains unchanged and ordered.
 */
export function retentionSuiteExtendsBaseline(suite: Record<string, unknown>, baseline: Record<string, unknown>): boolean {
  for (const key of ['schema', 'harness', 'fixedNow']) {
    if (canonicalTrialJson(suite[key] ?? null) !== canonicalTrialJson(baseline[key] ?? null)) return false
  }
  const organs = (value: unknown): value is string[] => Array.isArray(value)
    && value.every(name => typeof name === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(name))
    && new Set(value).size === value.length
  if (!organs(suite.organs) || !organs(baseline.organs)) return false
  const baselineOrgans = new Set(baseline.organs)
  if (canonicalTrialJson(suite.organs.filter(name => baselineOrgans.has(name))) !== canonicalTrialJson(baseline.organs)) return false
  const cases = (value: unknown): Map<string, Record<string, unknown>> | null => {
    if (!Array.isArray(value) || !value.length) return null
    const rows = new Map<string, Record<string, unknown>>()
    for (const row of value) {
      if (!object(row) || typeof row.id !== 'string' || !row.id || rows.has(row.id)) return null
      rows.set(row.id, row)
    }
    return rows
  }
  const currentCases = cases(suite.cases)
  const baselineCases = cases(baseline.cases)
  if (!currentCases || !baselineCases || !object(suite.fixtures) || !object(baseline.fixtures)) return false
  const retainedOrder = [...currentCases.keys()].filter(id => baselineCases.has(id))
  if (canonicalTrialJson(retainedOrder) !== canonicalTrialJson([...baselineCases.keys()])) return false
  for (const [id, row] of baselineCases) {
    if (!currentCases.has(id) || canonicalTrialJson(currentCases.get(id)) !== canonicalTrialJson(row)) return false
  }
  for (const [name, fixture] of Object.entries(baseline.fixtures)) {
    if (!Object.hasOwn(suite.fixtures, name) || canonicalTrialJson(suite.fixtures[name]) !== canonicalTrialJson(fixture)) return false
  }
  return true
}

/** The parent owns this comparator; worker pass flags and supplied digests never enter it. */
function gradeTrialOutput(test: Record<string, unknown>, got: unknown): boolean {
  if (Object.hasOwn(test, 'expectError')) {
    const error = object(got) ? (typeof got.error === 'string' ? got.error : got.code) : null
    return object(got) && got.ok === false && typeof error === 'string'
      && typeof test.expectError === 'string' && error.includes(test.expectError)
  }
  return canonicalTrialJson(got) === canonicalTrialJson(test.expect)
}

const GRADER_SPECIMENS = [
  { test: { expect: { ok: true, nested: [0, false, null, { value: 'retained' }] } }, good: { nested: [0, false, null, { value: 'retained' }], ok: true }, bad: { ok: true } },
  { test: { expectError: 'CONTROL_REFUSED' }, good: { ok: false, error: 'CONTROL_REFUSED: sentinel' }, bad: { ok: true, error: 'CONTROL_REFUSED' } },
  { test: { expect: null }, good: null, bad: false },
  { test: { expect: false }, good: false, bad: null },
] as const

function checkGrader(
  scorer: typeof gradeTrialOutput,
  specimens: readonly { test: Record<string, unknown>; good: unknown; bad: unknown }[],
): { knownGoodAccepted: boolean; knownBadRejected: boolean } {
  const knownGoodAccepted = specimens.every(({ test, good }) => scorer(test, good))
  const knownBadRejected = specimens.every(({ test, bad }) => !scorer(test, bad))
  return { knownGoodAccepted, knownBadRejected }
}

function graderControls(cases: readonly unknown[], caseSetDigest: string, runnerDigest: string): GraderControls {
  const specimens = [...GRADER_SPECIMENS, ...cases.map((value) => {
    const test = value as Record<string, unknown>
    const good = Object.hasOwn(test, 'expectError') ? { ok: false, error: test.expectError } : test.expect
    return { test, good, bad: good === null ? false : null }
  })]
  const controls = checkGrader(gradeTrialOutput, specimens)
  const acceptAll = checkGrader(() => true, specimens)
  const rejectAll = checkGrader(() => false, specimens)
  const acceptAllRejected = !(acceptAll.knownGoodAccepted && acceptAll.knownBadRejected)
  const rejectAllRejected = !(rejectAll.knownGoodAccepted && rejectAll.knownBadRejected)
  return {
    runnerDigest, graderDigest: sha256HexSync(canonicalTrialJson.toString() + gradeTrialOutput.toString()
      + checkGrader.toString() + graderControls.toString() + JSON.stringify(GRADER_SPECIMENS)),
    caseSetDigest, controlSetDigest: sha256HexSync(JSON.stringify(specimens)), ...controls,
    acceptAllRejected, rejectAllRejected,
    allPassed: controls.knownGoodAccepted && controls.knownBadRejected && acceptAllRejected && rejectAllRejected,
  }
}

/**
 * Independently grade one disposable-worker trial. Controls test the output scorer, not real-world
 * correctness. Route records cover source admission and result framing; capability use, held-out
 * coverage and execution containment remain unsupported even when every output matches.
 * @param input - Compiled candidate and bounded cases; caller evidence fields are ignored.
 * @returns Parent-computed verdict, control admission and bounded route observations.
 */
export async function trialScionCandidate(input: CandidateTrialInput): Promise<CandidateTrialResult> {
  const startedAt = Date.now()
  const candidateDigest = sha256HexSync(typeof input?.code === 'string' ? input.code : '')
  const runnerDigest = sha256HexSync(TRIAL_RUNNER_SOURCE + NODE_TRIAL_WORKER_SCRIPT + runScionTrialWorker.toString()
    + lockDownBrowserTrialGlobals.toString() + executeTrial.toString() + trialScionCandidate.toString() + freezeCases.toString()
    + RETENTION_HARNESS_SOURCE + trialScionRetention.toString() + canonicalTrialJson.toString() + object.toString()
    + JSON.stringify({
      allowed: ALLOWLISTED_TRIAL_BUILTINS, locked: BROWSER_TRIAL_LOCKED_GLOBALS,
      channel: [...CHANNEL_KEYS], timeout: DEFAULT_TRIAL_TIMEOUT_MS,
    }))
  let controls: GraderControls | undefined
  let policyDigest = sha256HexSync('scion-observed-results/v1')
  const evidence = (status: RouteEvidence['status'], events: unknown, checkedProperties: string[], unsupportedProperties: string[]): RouteEvidence => ({
    policyId: 'scion-observed-results/v1', policyDigest, runnerDigest, candidateDigest,
    observedEventDigest: sha256HexSync(canonicalTrialJson(events)), status, checkedProperties, unsupportedProperties,
  })
  try {
    const suite = freezeCases(input.cases)
    const cases = suite.cases
    controls = graderControls(cases, suite.suiteSha256, runnerDigest)
    const policies = cases.map(test => object(test) ? test.routePolicy ?? null : null)
    policyDigest = sha256HexSync(canonicalTrialJson({ policy: 'scion-observed-results/v1', policies }))
    const unsupportedProperties = ['execution-containment', ...new Set(policies.flatMap(policy => object(policy)
      ? Object.keys(policy).filter(key => key !== 'policyId') : []))]
    // Source-text admission is not an execution trace or a parser-based containment proof.
    if (typeof input.code === 'string' && /(^|[^A-Za-z0-9_$.])import\s*(?:\/\*[\s\S]*?\*\/\s*|\/\/[^\n]*(?:\n|$)\s*)*\(/.test(input.code)) {
      return { ok: false, results: [], durationMs: Date.now() - startedAt, error: 'CANDIDATE_TRIAL_IMPORT_BLOCKED: dynamic import()',
        graderControls: controls, negativeControlRejected: controls.knownBadRejected,
        routeEvidence: evidence('violated', ['source-dynamic-import-rejected'], ['source-dynamic-import-admission'], unsupportedProperties) }
    }
    const raw = await executeTrial({
      name: input.name, code: input.code, cases, ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    })
    const serialized = JSON.stringify(raw.results)
    const bounded = new TextEncoder().encode(serialized).byteLength <= 128 * 1024
    const results = bounded ? raw.results : []
    const complete = results.length === cases.length && results.every((row, index) => {
      const test = cases[index]
      return object(row) && object(test) && row.id === test.id && Object.hasOwn(row, 'got')
    })
    const graded = complete ? results.map((row, index) => ({
      id: row.id, pass: gradeTrialOutput(cases[index] as Record<string, unknown>, row.got), got: row.got,
    })) : []
    const checkedProperties = ['source-dynamic-import-admission', ...(complete ? ['exact-case-result-framing', 'parent-output-comparison'] : [])]
    const status: RouteEvidence['status'] = raw.error === 'CANDIDATE_TRIAL_ISOLATION_UNAVAILABLE' ? 'unsupported'
      : !complete ? 'inconclusive' : policies.some(policy => object(policy) && Object.keys(policy).some(key => key !== 'policyId')) ? 'unsupported' : 'checked'
    const passed = complete && graded.every(row => row.pass)
    // No case ran because the worker never answered: say so, so 0 of N never reads as a score to tie.
    const emptyTrial = cases.length > 0 && raw.results.length === 0 && (!raw.error || raw.error.startsWith('CANDIDATE_TRIAL_WORKER_FAILED'))
    let failure: string | null = null
    if (!bounded) failure = 'CANDIDATE_TRIAL_OUTPUT_LIMIT'
    else if (emptyTrial) failure = `CANDIDATE_TRIAL_EMPTY: ${(raw.error ?? 'the trial returned no case results').slice(0, 3900)}`
    else if (!complete && !raw.error) failure = 'CANDIDATE_TRIAL_RESULTS_INCOMPLETE'
    else if (raw.error) failure = raw.error.slice(0, 4000)
    else if (!passed) failure = 'Candidate failed parent output comparison'
    return { ok: raw.ok && passed && controls.allPassed, results: graded, durationMs: raw.durationMs,
      ...(failure === null ? {} : { error: failure }),
      graderControls: controls, negativeControlRejected: controls.knownBadRejected,
      routeEvidence: evidence(status, {
        complete, results: graded.map(row => ({ id: row.id, pass: row.pass, outputDigest: sha256HexSync(canonicalTrialJson(row.got)) })),
      }, checkedProperties, unsupportedProperties) }
  } catch (error) {
    return { ok: false, results: [], durationMs: Date.now() - startedAt,
      error: (error instanceof Error ? error.message : String(error)).slice(0, 4000),
      ...(controls ? { graderControls: controls, negativeControlRejected: controls.knownBadRejected } : {}),
      routeEvidence: evidence('inconclusive', ['trial-admission-failed'], [], ['execution-containment']) }
  }
}

/** Retention harness is runtime-owned; candidate-supplied harness text is never admitted for promotion. */
const RETENTION_HARNESS_SOURCE = String.raw`
function harnessMemfs(seed, Buffer) {
  const files = new Map()
  const dirs = new Set(['/'])
  const parentOf = (p) => p.slice(0, p.lastIndexOf('/')) || '/'
  const clean = (p) => { const s = String(p); return s.length > 1 ? s.replace(/\/+$/, '') : s }
  const mkdirs = (p) => { for (let d = p; !dirs.has(d); d = parentOf(d)) dirs.add(d) }
  const toBuffer = (data) => (Buffer.isBuffer(data) ? Buffer.from(data) : data instanceof Uint8Array ? Buffer.from(data) : Buffer.from(String(data), 'utf8'))
  const put = (p, data) => { mkdirs(parentOf(p)); files.set(p, toBuffer(data)) }
  const fail = (code, p) => { const e = new Error(code + ': ' + p); e.code = code; return e }
  for (const p of Object.keys(seed)) put(p, seed[p])
  const fs = {
    existsSync: (p) => files.has(clean(p)) || dirs.has(clean(p)),
    readFileSync(p, enc) {
      const k = clean(p)
      if (!files.has(k)) throw fail('ENOENT', k)
      const encoding = typeof enc === 'string' ? enc : enc && enc.encoding
      return encoding ? files.get(k).toString(encoding) : Buffer.from(files.get(k))
    },
    writeFileSync(p, data) { const k = clean(p); if (dirs.has(k)) throw fail('EISDIR', k); put(k, data) },
    appendFileSync(p, data) { const k = clean(p); put(k, Buffer.concat([files.get(k) || Buffer.alloc(0), toBuffer(data)])) },
    mkdirSync(p) { mkdirs(clean(p)) },
    readdirSync(p) {
      const k = clean(p)
      if (!dirs.has(k)) throw fail('ENOENT', k)
      const prefix = k === '/' ? '/' : k + '/'
      const names = new Set()
      for (const key of [...files.keys(), ...dirs]) if (key !== k && key.startsWith(prefix)) names.add(key.slice(prefix.length).split('/')[0])
      return [...names].sort()
    },
    statSync(p) {
      const k = clean(p)
      const isDir = dirs.has(k)
      if (!isDir && !files.has(k)) throw fail('ENOENT', k)
      return { isDirectory: () => isDir, isFile: () => !isDir, size: isDir ? 0 : files.get(k).length, mtimeMs: 0, mode: isDir ? 0o755 : 0o644 }
    },
    renameSync(a, b) { const ka = clean(a); if (!files.has(ka)) throw fail('ENOENT', ka); put(clean(b), files.get(ka)); files.delete(ka) },
    unlinkSync(p) { const k = clean(p); if (!files.delete(k)) throw fail('ENOENT', k) },
  }
  return fs
}

function harnessProject(result, pick, fs) {
  const out = { ok: Boolean(result) && result.ok === true }
  if (result && typeof result.error === 'string') out.error = result.error
  for (const path of pick) {
    if (path.startsWith('file:')) { out[path] = fs.existsSync(path.slice(5)); continue }
    if (path === 'errorCodes') { out.errorCodes = result && Array.isArray(result.errors) ? result.errors.map((e) => e && e.error).filter(Boolean) : null; continue }
    let value = result
    for (const key of path.split('.')) value = value === null || value === undefined ? undefined : value[key]
    out[path] = value === undefined ? null : value
  }
  return out
}

function harnessMain(ORGANS, FIXTURES, FIXED_NOW, safeRequire, memfs, project) {
  const Buffer = safeRequire('buffer').Buffer
  const RealDate = Date
  class PinnedDate extends RealDate {
    constructor(...args) { if (args.length === 0) super(FIXED_NOW); else super(...args) }
    static now() { return FIXED_NOW }
  }
  const load = (name, fs, cache) => {
    if (cache[name]) return cache[name]
    const factory = ORGANS[name]
    if (typeof factory !== 'function') throw new Error('PEARL_ORGAN_NOT_IN_BUILD: ' + name)
    const module = { exports: {} }
    const organRequire = (id) => (id === 'fs' || id === 'node:fs' ? fs : safeRequire(id))
    factory(module, module.exports, organRequire, PinnedDate, undefined, Buffer)
    cache[name] = module.exports
    return module.exports
  }
  return {
    name: 'pearl-retention',
    description: 'Pearl retention harness: runs one suite case against one organ of this candidate build.',
    async run(args) {
      const fixture = FIXTURES[args.fixture]
      if (!fixture) return { ok: false, error: 'PEARL_FIXTURE_UNKNOWN' }
      const fs = memfs(fixture, Buffer)
      const cache = {}
      const tools = {}
      const ctx = {
        fs,
        snapshots: { persistenceState: () => ({ writable: true }), flush: async () => ({ localSaved: true }) },
        tools: { register(name, def) { tools[name] = def; return () => { delete tools[name] } } },
        organs: { list: () => [], call: async (name, input) => load(name, fs, cache).run(input, ctx) },
      }
      const organ = load(args.organ, fs, cache)
      let result
      if (args.tool) {
        if (typeof organ.apply === 'function') organ.apply(ctx)
        else if (typeof organ.setup === 'function') organ.setup(ctx)
        const tool = tools[args.tool]
        if (!tool) return { ok: false, error: 'PEARL_TOOL_NOT_REGISTERED' }
        result = await tool.execute(args.input)
        if (result && typeof result.output === 'string') result = JSON.parse(result.output)
      } else {
        result = await organ.run(args.input, ctx)
      }
      return project(result, Array.isArray(args.pick) ? args.pick : [], fs)
    },
  }
}
`

/** A persisted retention suite uses only these fields; cases remain bounded by the trial parser. */
export interface RetentionSuite {
  readonly fixtures: Record<string, unknown>
  readonly fixedNow: number
  readonly cases: readonly unknown[]
}

/**
 * Run a complete retained case set with runtime-owned fixture adapters. These in-memory adapters are
 * behavioral test doubles, not a security sandbox or evidence of production-route coverage.
 * @param build - Exact named organ sources selected by the runtime.
 * @param suite - Runtime-read retention fixtures and acceptance cases.
 * @returns Parent-graded result and locally bound evidence.
 */
export async function trialScionRetention(build: Readonly<Record<string, string>>, suite: RetentionSuite): Promise<CandidateTrialResult> {
  const factories = Object.entries(build).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([name, source]) => {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(name)) throw new Error('PEARL_ORGAN_ID_INVALID')
    let body = source
    if (/^\s*export\s/m.test(body)) {
      const exported: string[] = []
      body = body.replace(/^export\s+((?:async\s+)?(?:const|let|function|class)\s+([A-Za-z_$][\w$]*))/gm,
        (_match, declaration: string, id: string) => {
          exported.push(id)
          return declaration
        })
      if (/^\s*export\s/m.test(body)) throw new Error('PEARL_UNSUPPORTED_EXPORT: ' + name)
      body += '\nmodule.exports = { ' + exported.join(', ') + ' };'
    }
    return JSON.stringify(name) + ': function (module, exports, require, Date, process, Buffer) {\n' + body + '\n}'
  })
  const code = 'const __ORGANS = {' + factories.join(',\n') + '};\n' + RETENTION_HARNESS_SOURCE
    + '\nmodule.exports = harnessMain(__ORGANS, ' + JSON.stringify(suite.fixtures) + ', ' + JSON.stringify(suite.fixedNow)
    + ', require, harnessMemfs, harnessProject);'
  return trialScionCandidate({ name: 'pearl-retention', code, cases: suite.cases, timeoutMs: 15_000 })
}

function cycleReport(value: Record<string, unknown>): { cycle: unknown; report: { nonJson: boolean; truncated: boolean } } {
  const report = { nonJson: false, truncated: false }
  const seen = new WeakSet<object>()
  let nodes = 0; let bytes = 0
  const omitted = '[output omitted]'
  const copy = (input: unknown, depth = 0): unknown => {
    try {
      if (++nodes > 4096 || depth > 24 || bytes > 128 * 1024) { report.truncated = true; return omitted }
      if (input === null || typeof input === 'boolean' || (typeof input === 'number' && Number.isFinite(input)) || typeof input === 'string') {
        if (typeof input === 'string' && input.length > 128 * 1024) { report.truncated = true; return omitted }
        bytes += new TextEncoder().encode(JSON.stringify(input)).byteLength + 2
        if (bytes > 128 * 1024) { report.truncated = true; return omitted }
        return input
      }
      if (!input || typeof input !== 'object' || seen.has(input)) { report.nonJson = true; return omitted }
      const array = Array.isArray(input)
      if (!array && ![Object.prototype, null].includes(Object.getPrototypeOf(input))) { report.nonJson = true; return omitted }
      seen.add(input)
      const result: Record<string, unknown> | unknown[] = array ? [] : Object.create(null)
      const keys = Object.keys(input)
      if (array && (keys.length !== input.length || keys.some((key, index) => key !== String(index)))) {
        report.nonJson = true
        return omitted
      }
      const ordered = depth === 0
        ? [...new Set(['ok', 'phase', 'mutation', 'refusal', ...keys])].filter(key => keys.includes(key))
        : keys
      for (const key of ordered) {
        bytes += new TextEncoder().encode(JSON.stringify(key)).byteLength + 2
        if (nodes >= 4096 || bytes > 128 * 1024) { report.truncated = true; break }
        const descriptor = Object.getOwnPropertyDescriptor(input, key)
        let item: unknown
        if (!descriptor || !('value' in descriptor)) { report.nonJson = true; item = omitted }
        else item = copy(descriptor.value, depth + 1)
        if (array) (result as unknown[]).push(item)
        else (result as Record<string, unknown>)[key] = item
      }
      return result
    } catch { report.nonJson = true; return omitted }
  }
  let cycle = copy(value)
  if (new TextEncoder().encode(JSON.stringify(cycle)).byteLength > 128 * 1024) {
    report.truncated = true
    const root = object(cycle) ? cycle : {}
    const ackKeys = ['ballId', 'prepared', 'activated', 'localSaved', 'remoteSaved', 'remoteTarget', 'receiptSaved', 'at']
    const ack = (input: unknown): unknown => {
      if (!object(input)) return null
      return Object.fromEntries(Object.entries(input).filter(([key, item]) => (
        ackKeys.includes(key)
        && (item === null || typeof item === 'boolean' || (typeof item === 'number' && Number.isFinite(item))
          || (typeof item === 'string' && item.length <= 512))
      )))
    }
    cycle = {
      ok: root.ok === true,
      phase: typeof root.phase === 'string' ? root.phase.slice(0, 128) : 'cycle-unconfirmed',
      mutation: ack(root.mutation),
      ...(object(root.refusal) ? { refusal: { ok: root.refusal.ok === true, mutation: ack(root.refusal.mutation) } } : {}),
      outputsOmitted: true,
    }
  }
  return { cycle, report }
}

/** Compilation is isolated; selected organ execution and acceptance calls are live, not sandboxed. */
export async function growScionOrgan(input: ScionGrowthInput, dependencies: GrowthDependencies): Promise<Record<string, unknown>> {
  let stage = 'preflight'
  let compilation: Record<string, unknown> | null = null
  try {
    if (!input || typeof input.name !== 'string' || !/^[a-z][a-z0-9-]{0,40}$/.test(input.name)) {
      throw new Error('name must be lower kebab-case')
    }
    if (!dependencies.writable()) throw new Error('Durable writable storage is required before growth')
    const invalidEntry = typeof input.entry !== 'string' || !input.entry || input.entry.startsWith('/') || /[\\:\0]/.test(input.entry)
    if (invalidEntry || !object(input.files) || Object.keys(input.files).length > 127 || Object.hasOwn(input.files, ENTRY)) {
      throw new Error('Supply a relative entry and at most 127 source files; reserved growth entry must be absent')
    }
    const name = input.name
    const suite = freezeCases(input.cases)
    const baseBallId = dependencies.head()
    if (input.expectedBallId !== undefined && input.expectedBallId !== baseBallId) {
      throw new Error('CAS_HEAD_MISMATCH: selected head differs from expectedBallId')
    }
    // This guard runs only on explicit activation, before a Seed export can register another organ name.
    const wrapper = [
      `import * as source from ${JSON.stringify('./' + input.entry)};`,
      'const organ = typeof source.run === "function" && typeof source.name === "string" ? source : source.default;',
      `if (!organ || typeof organ !== "object" || Array.isArray(organ) || organ.apply !== undefined || typeof organ.run !== "function" || organ.name !== ${JSON.stringify(name)}) throw new Error("SCION_ORGAN_NAME_MISMATCH");`,
      'module.exports = organ;',
      '',
    ].join('\n')
    stage = 'compile'
    const prepared = await dependencies.prepare({
      entry: ENTRY,
      files: { ...input.files, [ENTRY]: wrapper },
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
      name,
      includeCode: true,
    })
    compilation = {
      compiled: prepared.compiled,
      prepared: prepared.prepared,
      localSaved: prepared.localSaved,
      sha256: prepared.sha256,
      specifier: prepared.specifier,
      inputRoot: prepared.inputRoot,
      compiler: prepared.compiler,
      modules: prepared.modules,
      warnings: prepared.warnings,
      suiteSha256: suite.suiteSha256,
      baseBallId,
    }
    if (!prepared.ok || !prepared.compiled || !prepared.prepared || prepared.activated || !prepared.localSaved) {
      return {
        ok: false,
        phase: 'prepared-unconfirmed',
        stage: 'prepare',
        activationAttempted: false,
        compilation,
        error: prepared.saveError ?? 'Durable inert preparation was not acknowledged',
      }
    }
    if (typeof prepared.code !== 'string' || sha256HexSync(prepared.code) !== prepared.sha256 || prepared.specifier !== `ball:${prepared.sha256}`) {
      throw new Error('Prepared output integrity mismatch')
    }
    if (!dependencies.writable()) throw new Error('Storage became unavailable before growth')
    if (dependencies.head() !== baseBallId) {
      return {
        ok: false,
        phase: 'head-changed',
        stage: 'pre-activation',
        activationAttempted: false,
        compilation,
        error: 'Selected head changed during compilation; artifact retained, no growth was requested',
      }
    }
    const runTrial = dependencies.trial ?? (req => trialScionCandidate(req))
    stage = 'candidate-trial'
    const trial = await runTrial({
      name,
      code: prepared.code,
      cases: suite.cases,
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: Math.min(input.timeoutMs, 15_000) }),
    })
    if (!trial.ok) {
      return {
        ok: false,
        phase: 'refused',
        stage,
        activationAttempted: false,
        compilation,
        trial,
        error: trial.error ?? 'Candidate failed isolated pre-activation trial',
      }
    }
    stage = 'cycle'
    const cycle = await dependencies.cycle({ action: 'grow', name, code: prepared.code, cases: suite.cases })
    if (!object(cycle)) {
      return {
        ok: false,
        phase: 'cycle-unconfirmed',
        stage,
        activationUncertain: true,
        compilation,
        trial,
        error: 'Live growth returned no structured acknowledgement; inspect state before retrying',
      }
    }
    const captured = cycleReport(cycle)
    const outputActive = dependencies.active(name, prepared.sha256)
    const grown = cycle.ok === true && cycle.phase === 'grown'
    if (grown && !outputActive) {
      return {
        ok: false,
        phase: 'active-output-mismatch',
        stage,
        activationUncertain: true,
        outputActive,
        compilation,
        trial,
        ...captured,
        error: 'Passing cases did not leave this exact organ output active; inspect state before retrying',
      }
    }
    const phase = typeof cycle.phase === 'string' && cycle.phase.length <= 128 ? cycle.phase : null
    return {
      ok: grown && outputActive,
      phase: phase ?? 'cycle-unconfirmed',
      stage,
      outputActive,
      ...(phase === null ? { activationUncertain: true } : {}),
      compilation,
      trial,
      ...captured,
    }
  } catch (error) {
    return {
      ok: false,
      phase: stage === 'cycle' ? 'cycle-unconfirmed' : 'refused',
      stage,
      ...(stage === 'cycle' ? { activationUncertain: true } : { activationAttempted: false }),
      ...(compilation ? { compilation } : {}),
      error: error instanceof Error ? error.message : String(error),
    }
  }
}
