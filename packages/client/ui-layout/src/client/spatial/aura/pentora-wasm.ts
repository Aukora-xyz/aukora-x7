// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The Aukora authors
/**
 * PENTORA36 IN WASM: load the pinned `pentora36.wasm` (served at /seed-library/pentora/pentora36.wasm) and run its
 * invariants in this page, the way the seed library's core.mjs and fixtures/cases.json define them.
 *
 * Ported from the predecessor's x5/pentora-projection.ts and seed-library/pentora/core.mjs (SOURCE). What "verified" means
 * here, all of it executed by the Wasm module itself:
 *   1. the bytes hash to the pinned SHA-256 (needs Web Crypto; without it the check says "not run")
 *   2. the module imports nothing, exports exactly its six functions and no memory
 *   3. begin() refuses a wrong profile and a wrong denominator
 *   4. the zero frame (880 zero numerators) projects with flags 3 and every sample and coefficient zero
 *   5. the K-compatible, non-Q(phi) frame (3456 at every index = 2 mod 8) projects with flags 1 (true/false/false)
 *   6. a reused generation is refused (stale generation), and an incomplete frame (879 values) is refused
 * Each case runs on a fresh instance, except the stale-generation case, which needs one instance for its sequence.
 *
 * It is an arithmetic self-check of the module only: no authority, not a health verdict, not a pairing.
 */

export const PENTORA36_URL = '/seed-library/pentora/pentora36.wasm'
export const PENTORA36_MODULE_SHA256 = '6e74ab85c86ba952432fead3b9cf120eadeb33004e243aa3ea4330398092d036'
export const PENTORA36_PROFILE = 'pentora.research.wasm36.bounded-k.v1'
const PROFILE_ID = 0x50454e35
const DENOMINATOR = 3456
const INPUTS = 880
const COEFFICIENTS = 288
const MAX_BYTES = 1024 * 1024
const EXPORTS = ['begin', 'coefficient', 'flags', 'project', 'put', 'sample']

export type Pentora36State = 'verified' | 'failed' | 'not-run'

export interface Pentora36Check { readonly name: string; readonly ok: boolean; readonly detail: string }

export interface Pentora36Result {
  readonly state: Pentora36State
  /** One plain sentence: why it is verified, which check failed, or why it did not run. */
  readonly reason: string
  readonly checks: readonly Pentora36Check[]
  readonly sha256: string | null
  readonly bytes: number | null
  /** How the module was compiled: streaming from the response, or from the fetched bytes. */
  readonly loader: 'streaming' | 'bytes' | null
  readonly ms: number
}

type WasmCall = (...args: readonly (number | bigint)[]) => unknown

interface Core {
  readonly begin: WasmCall
  readonly put: WasmCall
  readonly project: WasmCall
  readonly sample: WasmCall
  readonly coefficient: WasmCall
}

function coreOf(instance: WebAssembly.Instance): Core | null {
  const call = (name: string): WasmCall | null => {
    const value: unknown = instance.exports[name]
    return typeof value === 'function' ? (value as WasmCall) : null
  }
  const begin = call('begin'), put = call('put'), project = call('project')
  const sample = call('sample'), coefficient = call('coefficient')
  if (begin === null || put === null || project === null || sample === null || coefficient === null) return null
  return { begin, put, project, sample, coefficient }
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string | null> {
  const subtle = typeof globalThis.crypto === 'object' ? globalThis.crypto.subtle : undefined
  if (subtle === undefined) return null
  const digest = new Uint8Array(await subtle.digest('SHA-256', bytes))
  return Array.from(digest, x => x.toString(16).padStart(2, '0')).join('')
}

/** Run one frame on a core: begin, put every numerator, project. Returns the project() flags or the refusal. */
function runFrame(core: Core, generation: bigint, numerators: readonly bigint[]): { flags: number } | { refused: string } {
  const start = core.begin(PROFILE_ID, DENOMINATOR, generation)
  if (start !== 0) return { refused: `begin refused: ${String(start)}` }
  for (let i = 0; i < numerators.length; i++) {
    const status = core.put(i, numerators[i] ?? 0n)
    if (status !== 0) return { refused: `put refused at ${String(i)}: ${String(status)}` }
  }
  const flags = core.project()
  if (typeof flags !== 'number' || flags < 0) return { refused: `project refused: ${String(flags)}` }
  return { flags }
}

const ZERO = Array.from({ length: INPUTS }, () => 0n)
const K_COMPATIBLE = Array.from({ length: INPUTS }, (_, i) => (i % 8 === 2 ? BigInt(DENOMINATOR) : 0n))

/**
 * Run the invariant cases on a compiled module.
 * @param module - the compiled pentora36 module.
 * @param first - an instance already made from it (the streaming loader's), used for the first case.
 * @returns the cases, in order.
 */
async function runCases(module: WebAssembly.Module, first?: WebAssembly.Instance): Promise<Pentora36Check[]> {
  const checks: Pentora36Check[] = []
  const check = (name: string, ok: boolean, detail: string) => { checks.push({ name, ok, detail }) }
  const imports = WebAssembly.Module.imports(module)
  const exports = WebAssembly.Module.exports(module)
  const names = exports.map(e => `${e.name}:${e.kind}`).sort()
  check('no imports', imports.length === 0, `${String(imports.length)} imports`)
  check('six function exports, no memory',
    names.join(',') === EXPORTS.map(n => `${n}:function`).join(','), names.join(', '))
  let spare = first
  const fresh = async (): Promise<Core | null> => {
    const instance = spare ?? await WebAssembly.instantiate(module, {})
    spare = undefined
    return coreOf(instance)
  }

  const refuse = await fresh()
  if (refuse === null) { check('exports callable', false, 'a required export is not a function'); return checks }
  const wrongProfile = refuse.begin(1, DENOMINATOR, 1n)
  const wrongDenominator = refuse.begin(PROFILE_ID, DENOMINATOR - 1, 1n)
  check('begin refuses a wrong profile and denominator', wrongProfile !== 0 && wrongDenominator !== 0,
    `wrong profile -> ${String(wrongProfile)}, wrong denominator -> ${String(wrongDenominator)}`)

  const zero = await fresh()
  if (zero !== null) {
    const result = runFrame(zero, 1n, ZERO)
    if ('refused' in result) check('zero frame flags 3', false, result.refused)
    else {
      const samples = Array.from({ length: INPUTS }, (_, i) => zero.sample(i, 1n)).filter(x => x !== 0n).length
      const coeffs = Array.from({ length: COEFFICIENTS }, (_, i) => zero.coefficient(i, 1n)).filter(x => x !== 0n).length
      check('zero frame flags 3', result.flags === 3, `flags ${String(result.flags)} (expected 3: sample-compatible, in Q(phi))`)
      check('zero frame projects to zero', samples === 0 && coeffs === 0,
        `${String(samples)} non-zero samples of ${String(INPUTS)}, ${String(coeffs)} non-zero coefficients of ${String(COEFFICIENTS)}`)
    }
  }

  const k = await fresh()
  if (k !== null) {
    const result = runFrame(k, 1n, K_COMPATIBLE)
    check('K-compatible, non-Q(phi) frame flags 1', !('refused' in result) && result.flags === 1,
      'refused' in result ? result.refused : `flags ${String(result.flags)} (expected 1: true/false/false)`)
    const again = k.begin(PROFILE_ID, DENOMINATOR, 1n)
    check('stale generation refused', again !== 0, `begin with the same generation -> ${String(again)}`)
  }

  const short = await fresh()
  if (short !== null) {
    const result = runFrame(short, 1n, ZERO.slice(0, INPUTS - 1))
    check('incomplete frame refused', 'refused' in result, 'refused' in result ? result.refused : `flags ${String(result.flags)}`)
  }
  return checks
}

function verdict(checks: readonly Pentora36Check[], extra: Omit<Pentora36Result, 'state' | 'reason' | 'checks'>): Pentora36Result {
  const failed = checks.find(c => !c.ok)
  if (failed !== undefined) return { ...extra, state: 'failed', reason: `${failed.name}: ${failed.detail}`, checks }
  return {
    ...extra, state: 'verified', checks,
    reason: `${String(checks.length)} checks passed in Wasm: pinned module, zero frame flags 3, K-compatible frame flags 1, refusals hold`,
  }
}

/**
 * Verify module bytes already in hand (the node check uses this directly).
 * @param input - the module bytes.
 * @returns the verdict with every check.
 */
export async function verifyPentora36Bytes(input: ArrayBuffer | Uint8Array): Promise<Pentora36Result> {
  const started = performance.now()
  // A copy, so the bytes hashed are exactly the bytes compiled (and always ArrayBuffer-backed).
  const bytes = new Uint8Array(input)
  const base = { sha256: null, bytes: bytes.byteLength, loader: 'bytes' as const }
  if (bytes.byteLength > MAX_BYTES) {
    return { ...base, state: 'failed', reason: `module is ${String(bytes.byteLength)} bytes, over the bound`, checks: [], ms: 0 }
  }
  const sha256 = await sha256Hex(bytes)
  if (sha256 === null) {
    return { ...base, state: 'not-run', reason: 'Web Crypto is unavailable here, so the module hash cannot be pinned', checks: [], ms: 0 }
  }
  if (sha256 !== PENTORA36_MODULE_SHA256) {
    return { ...base, sha256, state: 'failed', reason: `module hash ${sha256.slice(0, 12)}… is not the pinned one`, checks: [], ms: 0 }
  }
  const module = await WebAssembly.compile(bytes)
  const checks = [{ name: 'pinned SHA-256', ok: true, detail: sha256 }, ...await runCases(module)]
  return verdict(checks, { ...base, sha256, ms: Math.round(performance.now() - started) })
}

/**
 * Fetch the served module, pin its hash, compile it (WebAssembly.instantiateStreaming, falling back to the fetched
 * bytes) and run the invariant cases. Never throws: every failure comes back as a 'failed' or 'not-run' verdict.
 * @param signal - aborts the fetch.
 * @param fetcher - the fetch to use (the page's own by default).
 * @param url - where the module is served.
 * @returns the verdict.
 */
export async function loadPentora36(
  signal?: AbortSignal, fetcher: typeof fetch = fetch, url: string = PENTORA36_URL,
): Promise<Pentora36Result> {
  const started = performance.now()
  const none = { sha256: null, bytes: null, loader: null, checks: [], ms: 0 }
  let response: Response
  try {
    response = await fetcher(url, { signal: signal ?? null, cache: 'no-store', credentials: 'same-origin' })
  } catch (error) {
    return { ...none, state: 'not-run', reason: `could not fetch ${url}: ${error instanceof Error ? error.message : String(error)}` }
  }
  if (!response.ok) return { ...none, state: 'not-run', reason: `${url} answered HTTP ${String(response.status)}` }
  const type = response.headers.get('content-type') ?? ''
  if (type.includes('text/html')) return { ...none, state: 'not-run', reason: `${url} answered with a page, not the module` }
  try {
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength > MAX_BYTES) {
      return { ...none, bytes: bytes.byteLength, state: 'failed', reason: `module is ${String(bytes.byteLength)} bytes, over the bound` }
    }
    const sha256 = await sha256Hex(bytes)
    if (sha256 === null) {
      return { ...none, bytes: bytes.byteLength, state: 'not-run', reason: 'Web Crypto is unavailable here, so the module hash cannot be pinned' }
    }
    if (sha256 !== PENTORA36_MODULE_SHA256) {
      return { ...none, sha256, bytes: bytes.byteLength, state: 'failed', reason: `module hash ${sha256.slice(0, 12)}… is not the pinned one` }
    }
    // Compile EXACTLY the bytes whose hash was just pinned (never a second read of the response).
    const loaded: { module: WebAssembly.Module; instance?: WebAssembly.Instance; loader: 'streaming' | 'bytes' } =
      { module: await WebAssembly.compile(bytes), loader: 'bytes' }
    const checks = [{ name: 'pinned SHA-256', ok: true, detail: sha256 }, ...await runCases(loaded.module, loaded.instance)]
    return verdict(checks, { sha256, bytes: bytes.byteLength, loader: loaded.loader, ms: Math.round(performance.now() - started) })
  } catch (error) {
    return {
      ...none, ms: Math.round(performance.now() - started), state: 'failed',
      reason: `the module did not run: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

let shared: Promise<Pentora36Result> | null = null

/**
 * The page's one verdict: the first call fetches and runs the module, later calls share that result.
 * @returns the verdict.
 */
export function pentora36Once(): Promise<Pentora36Result> {
  shared ??= loadPentora36()
  return shared
}
