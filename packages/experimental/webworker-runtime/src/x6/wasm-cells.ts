/**
 * Auma's Wasm cells in the browser. Twenty-five pinned cells (24 compiled from Rust in an earlier repository, and
 * aura-focus built here from WAT), each speaking Microverse ABI v1: zero imports, exports exactly `memory`,
 * `mv_abi_version`, `mv_alloc`, `mv_run`, `__mv_fuel_set`, `__mv_fuel_remaining`, canonical JSON in and out.
 *
 * The cells are served same-origin at `/cells/<name>.wasm` (apps/web/public/cells, Cloudflare static assets on the edge)
 * and admitted here, fail-closed and in this order:
 *   1. size: 0 < bytes <= the pinned size;
 *   2. the exact SHA-256 pin, on a private copy, BEFORE compiling (WebCrypto only: the same code runs in a browser
 *      worker and in Cloudflare workerd);
 *   3. the BINARY memory limits of those same pinned bytes, still before compiling (`inspectWasmMemory`: exactly one
 *      defined, unshared, 32-bit memory with a declared maximum at or under the ceiling, no imported memory);
 *   4. compile; 5. zero imports; 6. exactly the metered ABI v1 export set.
 * The declared maximum is what the engine's WebAssembly.Memory enforces on `memory.grow`; the execution worker also
 * re-checks the live buffer against it after instantiation and after every call (MEMORY_CEILING).
 * Every export call runs on a fresh fuel grant in a separate worker. The host terminates that worker after
 * 5000 ms of execution, including instance startup and ABI exports; a trap discards the affected instance.
 * A cell computes and returns; it has no imports, so it cannot reach the network, storage, or the host.
 * @module x6/wasm-cells
 */

/** One cell's pin: its exact bytes and its per-call fuel grant (from the predecessor's own pins). */
export interface CellPin {
  readonly sha256: string
  readonly bytes: number
  readonly fuel: number
  /** Verified operations implemented by this cell on Microverse ABI v1. */
  readonly ops?: readonly string[]
  /** A larger request bound than the default, where the predecessor's cell takes one (organism-tools: a 4 MiB edit in base64). */
  readonly maxRequestBytes?: number
}

export const CELL_BASE_PATH = '/cells/'
export const CELL_MAX_REQUEST_BYTES = 1024 * 1024
export const CELL_MAX_RESPONSE_BYTES = 12 * 1024 * 1024
/** Maximum instruction grant; the independent worker deadline also covers broken or absent metering. */
export const CELL_BROWSER_FUEL_CAP = 300_000_000
/** External execution deadline, including worker startup, instance startup and every ABI export. */
export const CELL_EXECUTION_TIMEOUT_MS = 5000
export const SKILL_EXPECTED_EXPORTS = Object.freeze(['memory', 'mv_abi_version', 'mv_alloc', 'mv_run'])
export const METERED_CELL_EXPORTS = Object.freeze(['__mv_fuel_remaining', '__mv_fuel_set', 'memory', 'mv_abi_version', 'mv_alloc', 'mv_run'])

/** The admitted cells. Hashes, fuel grants, and op manifests from the cells' build records (an earlier repository). */
export const CELL_PINS: Readonly<Record<string, CellPin>> = Object.freeze({
  'aukora-kernel': {
    sha256: 'a543fa06b6c4a0d806627437ca766c55caf4be4ebd8e8f86ebee13b71ab6017a', bytes: 188414, fuel: 1500000000,
    ops: Object.freeze(['kernel.ping', 'risk.classify', 'path.verdict', 'merge.decision', 'contract.path', 'egress.classify', 'gate.settle', 'contract.validate', 'contract.digest']),
  },
  'aumlok-identity': {
    sha256: 'daf2b514917a673d53d9cd5d561c748914880f6267a3928011c87d4bdd6b89fc', bytes: 638574, fuel: 400000000,
    ops: Object.freeze(['phrase.parse', 'phrase.draw', 'phrase.fold', 'phrase.entropy', 'envelope.parse', 'envelope.header', 'envelope.encode', 'envelope.opened', 'envelope.policy', 'identity.layout', 'identity.public', 'nostr.npub', 'binding.gate', 'binding.step', 'binding.write_check']),
  },
  'aumlok-keys': {
    sha256: 'd4f9f3b435c26547f840e215d491102bf65dc71ffc92584c680c3637ba7d5735', bytes: 302458, fuel: 200000000,
    ops: Object.freeze(['keys.policy', 'keys.plan', 'keys.layout', 'keys.public', 'keys.epoch_next', 'keys.root', 'keys.principal', 'scope.ceiling', 'scope.narrow', 'nostr.npub', 'bind.compose', 'bind.drafts', 'bind.verify']),
  },
  // Hand-written integer WAT (aura-focus.wat beside it), built and metered by the pinned skillsmith cell
  // (server/aura-focus-cell.build.mjs). Shadow of computeAuraFocusShadow only: no authority.
  'aura-focus': {
    sha256: 'e3e617dcb04bb449908b019af607427383ef173356a000341c3fe3db4b9491a8', bytes: 12545, fuel: 1000000,
    ops: Object.freeze(['aura.focus', 'aura.focus_both', 'aura.decide_net', 'aura.decide_both']),
  },
  'aura-relay': {
    sha256: '4eee340aac9781c5b2d79f67ddaceaa12942cdf976ea4c00cd0e8062b4b0d5eb', bytes: 464665, fuel: 1000000000,
    ops: Object.freeze(['relay.ping', 'relay.genesis', 'relay.root', 'relay.id', 'relay.admit', 'relay.replay', 'relay.head', 'relay.check', 'relay.mirror', 'relay.query']),
  },
  'gate-judge': {
    sha256: '784f03150df3f9282bb4b2f66a4ae1ce90eaa559c781e197c932439583d17b7e', bytes: 126327, fuel: 1500000000,
    ops: Object.freeze(['gate.step']),
  },
  'goal-receipts': {
    sha256: 'b899e987b0aab0f0852e57268271b757c16495e30526288505fd8bcbc002c00a', bytes: 199380, fuel: 1500000000,
    ops: Object.freeze(['goal.bind', 'goal.derive', 'goal.read']),
  },
  'grant-ledger': {
    sha256: 'ed8e7c10b181c3019a6e850d99c02e0e198710402f9cc87bc6ac25c09776ccd6', bytes: 250384, fuel: 1500000000,
    ops: Object.freeze(['ledger.open_line', 'ledger.finish_open', 'ledger.checkpoint', 'ledger.poison', 'ledger.health', 'ledger.replay', 'ledger.create', 'ledger.active', 'ledger.consume', 'ledger.close']),
  },
  'kira-core': {
    sha256: '4d1be5b5eb8cb2ba943cac58aff3e5ad46f3c3e779af3cc3c1778282f32caa3e', bytes: 160671, fuel: 100000000,
    ops: Object.freeze(['kira.ping', 'kira.classify_note', 'kira.permissions', 'kira.recall_rank']),
  },
  'kira-membrane': {
    sha256: '09fb8324bdb537dbc986da7eaee5f72209235d2bef1f88e46c08ad5abf884c92', bytes: 228666, fuel: 400000000,
    ops: Object.freeze(['kira.membrane_ping', 'kira.membrane_defaults', 'kira.membrane_registry', 'kira.membrane_registry_change', 'kira.membrane_admit', 'kira.membrane_addressed', 'kira.membrane_wake', 'kira.membrane_canonical']),
  },
  'kira-nostr': {
    sha256: '3d9f71ddef4d3d91a2676269687283e092b0f8565fef772cfc8626bd446df767', bytes: 435590, fuel: 100000000,
    ops: Object.freeze(['kira.nostr_ping', 'kira.nostr_public_key', 'kira.nostr_sign', 'kira.nostr_verify', 'kira.nostr_check_key']),
  },
  'kira-resume': {
    sha256: '2ec1321ab07b4ceb33182dbd18cf8b7a5b162e07ce5a74d0b5aa750061874f45', bytes: 167716, fuel: 1500000000,
    ops: Object.freeze(['kira.ping', 'kira.resume_select']),
  },
  'kira-store-policy': {
    sha256: 'd8c1a74d4298b8f419934b2beefc50a6042cd0532945b2cd693bec08fa930e8c', bytes: 331409, fuel: 1500000000,
    ops: Object.freeze(['kira.store_ping', 'kira.store_default_permissions', 'kira.store_terms', 'kira.store_flags', 'kira.store_draft', 'kira.store_supersede', 'kira.store_quarantine', 'kira.store_slot_note', 'kira.store_get', 'kira.store_recent', 'kira.store_recall', 'kira.resume_candidates', 'kira.bridge_agent', 'kira.get_caller']),
  },
  'lane-contract': {
    sha256: 'd8f04fd101cb711ead3ce11dea06c21de016da527d1c9320ba4803a849302b28', bytes: 97854, fuel: 1500000000,
    ops: Object.freeze(['lane.contract']),
  },
  'lane-judge': {
    sha256: '5b998f76fc63daf964d4d1dd6f9d995cef8114fa1f9f30d312640357e5241aea', bytes: 144344, fuel: 1500000000,
    ops: Object.freeze(['lane.scope', 'lane.contract', 'lane.outcome']),
  },
  'lane-profile': {
    sha256: 'f6917e45ca0d8009be4bc3a7b4104f84926a5e66816270129acd39c6631c6109', bytes: 133392, fuel: 200000000,
    ops: Object.freeze(['profile.lane']),
  },
  'laya': {
    sha256: 'c3bf50eaf97a0f7f9eb7c3d56ab0be2b42062cb88c733bc6121ac21537643db5', bytes: 187260, fuel: 2000000000,
    ops: Object.freeze(['laya.manifest', 'laya.grant', 'laya.frame', 'laya.advise', 'laya.replay', 'laya.fatigue', 'laya.questions', 'laya.bakeoff']),
  },
  'nostr-core': {
    sha256: '1b00e08461e6c2e9a99e5d32a93389d633aeb776a5d3e4a3e2b173cd6ce82530', bytes: 757615, fuel: 400000000,
    ops: Object.freeze(['nostr.ping', 'nostr.public_key', 'nostr.key_valid', 'nostr.event_id', 'nostr.event_sign', 'nostr.event_verify', 'nostr.npub_encode', 'nostr.npub_decode', 'nostr.nsec_encode', 'nostr.nsec_decode', 'nostr.nip44_conversation_key', 'nostr.nip44_message_keys', 'nostr.nip44_padded_len', 'nostr.nip44_encrypt', 'nostr.nip44_decrypt', 'nostr.gift_wrap', 'nostr.unwrap', 'nostr.dm_seal', 'nostr.dm_open']),
  },
  'organism-tools': {
    sha256: 'e647338d059f57e78d8827249303b1552fdd7335f80ab13a122c170f2a0a7e96', bytes: 368213, fuel: 20000000000, maxRequestBytes: 12 * 1024 * 1024,
    ops: Object.freeze(['read.args', 'read.open', 'read.feed', 'edit.args', 'edit.intent', 'edit.apply', 'write.args', 'write.plan', 'grep.plan', 'glob.plan', 'search.outcome', 'grep.batch', 'grep.render', 'glob.batch', 'glob.render', 'bash.plan', 'bash.render', 'fetch.args', 'fetch.url', 'fetch.route', 'fetch.response', 'fetch.limits', 'fetch.body', 'fetch.render']),
  },
  'pair-judge': {
    sha256: 'b62500b472e9c2c5be185484541b3bea17c032c72feb2193555b96be2163959f', bytes: 164343, fuel: 100000000,
    ops: Object.freeze(['pair.confirm', 'pair.confirmed', 'pair.digest', 'pair.verify']),
  },
  'prompt-assembly': {
    sha256: '4cb8b80b04145cf12d5024ab4410f0b64d6d58e686f912890e22f5d0b3ca22e7', bytes: 122292, fuel: 50000000,
    ops: Object.freeze(['prompt.context']),
  },
  'risk-signature': {
    sha256: 'abd15946427dbb882f1f3706e403362606591361264ccc63832d2bc2b8e895fa', bytes: 177342, fuel: 1500000000,
    ops: Object.freeze(['risk.signature']),
  },
  'seed-judge': {
    sha256: '382edfbca89a2ae1959cb4b45449250ce01454c56af8fb2fdbe28eb9c3c0317b', bytes: 95688, fuel: 1500000000,
    ops: Object.freeze(['seed.identity', 'seed.merge', 'seed.platform']),
  },
  'skillsmith': {
    sha256: '35cd471bcf029cc1f437803f6799b5469e525e83f113e5c775f95935e5ed24fa',
    bytes: 592220,
    fuel: 2000000000,
    maxRequestBytes: 4 * 1024 * 1024,
    ops: Object.freeze(['build', 'meter']),
  },
  'spatial-layout': {
    sha256: '1ab74435ddfaf4beb0c517d12e5374989a5864541d08226be350f694579f7e45', bytes: 153348, fuel: 200000000,
    ops: Object.freeze(['layout.init', 'layout.step', 'layout.view', 'layout.presets']),
  },
})

export const SKILL_MAX_MEMORY_PAGES = 16
export const SKILL_MAX_FUEL = 10_000_000
export const SKILL_MAX_WAT_BYTES = 1024 * 1024
export const SKILL_MAX_WASM_BYTES = 2 * 1024 * 1024
/** One WebAssembly page (64 KiB). */
export const WASM_PAGE_BYTES = 65_536
/**
 * Memory ceiling for a pinned cell, in pages (4096 pages = 256 MiB): the largest maximum any pinned cell declares
 * (organism-tools; every other pinned cell declares 256 or 1024). A cell whose binary declares no maximum, or a
 * maximum above this ceiling, is refused before compiling. Guest skills are held to SKILL_MAX_MEMORY_PAGES instead.
 */
export const CELL_MAX_MEMORY_PAGES = 4096

export interface CompileAndRunSpec {
  readonly wat: string
  readonly name?: string
  readonly version?: string
  readonly op?: string
  readonly input?: unknown
  readonly fuel?: number
  readonly inputSchema?: unknown
  readonly outputSchema?: unknown
}

export type CompileAndRunAnswer = CellAnswer & {
  readonly cellSha256?: string
  readonly codeSha256?: string
  readonly meteredSha256?: string
  readonly compilerFuelUsed?: number
  readonly expectedExports?: readonly string[]
  readonly gotExports?: readonly string[]
}

const normalizeWatSkillExports = (wat: string): string =>
  wat
    .replace(/\(\s*export\s+"aukora_abi_version"\s*\)/gu, '(export "mv_abi_version")')
    .replace(/\(\s*export\s+"aukora_alloc"\s*\)/gu, '(export "mv_alloc")')
    .replace(/\(\s*export\s+"aukora_call"\s*\)/gu, '(export "mv_run")')

const extractWatExports = (wat: string): string[] =>
  [...wat.matchAll(/\(\s*export\s+"([^"]+)"/gu)].map(m => m[1] ?? '').filter(Boolean).sort()

const fromBase64Bytes = (b64: string): Uint8Array<ArrayBuffer> => {
  const binary = globalThis.atob(b64)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i)
  return out
}

const hasBoundedWatMemory = (wat: string): boolean => {
  const matches = [...wat.matchAll(/\(memory(?:\s+\([^)]*\))*\s+(\d+)(?:\s+(\d+))?\s*\)/gu)]
  if (matches.length !== 1) return false
  const minPages = Number(matches[0]?.[1] ?? NaN)
  const maxPages = Number(matches[0]?.[2] ?? NaN)
  return Number.isSafeInteger(minPages)
    && Number.isSafeInteger(maxPages)
    && minPages >= 1
    && maxPages >= minPages
    && maxPages <= SKILL_MAX_MEMORY_PAGES
}

const OP = /^[a-z][a-z0-9_]{0,31}(?:\.[a-z][a-z0-9_.]{0,63})?$/u
const encoder = new TextEncoder()

/** A cell that could not be admitted or called (not a refusal by the cell itself). */
export class CellError extends Error {
  readonly code: string
  constructor(readonly cell: string, code: string, detail?: string) {
    super(`${cell}: ${code}${detail === undefined ? '' : ` (${detail})`}`)
    this.name = 'CellError'
    this.code = code
  }
}

const compareUtf8 = (left: string, right: string): number => {
  const a = encoder.encode(left), b = encoder.encode(right)
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) if (a[index] !== b[index]) return (a[index] ?? 0) - (b[index] ?? 0)
  return a.length - b.length
}
const encodeString = (value: string): string => {
  let out = '"'
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0
    if (code >= 0xd800 && code <= 0xdfff) throw new Error('canonical JSON rejects unpaired surrogates')
    if (char === '"') out += '\\"'
    else if (char === '\\') out += '\\\\'
    else if (code <= 0x1f) out += `\\u00${code.toString(16).padStart(2, '0')}`
    else out += char
  }
  return `${out}"`
}

/**
 * Microverse ABI v1 canonical JSON: keys sorted by UTF-8 bytes, integers only, control characters as lower-case u00xx escapes.
 * @param value - a JSON value.
 * @returns its canonical text.
 * @throws on a float, an unpaired surrogate, or a non-JSON value.
 */
export function cellCanonicalJson(value: unknown): string {
  if (value === null) return 'null'
  if (value === true) return 'true'
  if (value === false) return 'false'
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error('canonical JSON accepts integers only')
    return String(value)
  }
  if (typeof value === 'string') return encodeString(value)
  if (Array.isArray(value)) return `[${value.map(cellCanonicalJson).join(',')}]`
  if (typeof value !== 'object') throw new Error('canonical JSON accepts JSON values only')
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).filter(key => record[key] !== undefined).sort(compareUtf8)
    .map(key => `${encodeString(key)}:${cellCanonicalJson(record[key])}`).join(',')}}`
}

/** The one linear memory a module declares, read from its binary. */
export interface WasmMemoryLimits {
  readonly initial: number
  readonly maximum: number
}

/**
 * Read a module's memory limits from its BINARY, never from WAT text: walk every section by its LEB128 length, parse the
 * import section (id 2) and every memory section (id 5), and require exactly one memory that is defined (not imported),
 * unshared, 32-bit, carries a declared maximum, and has initial <= maximum <= `maxPages`. Anything the walk cannot
 * account for byte-for-byte (bad header, truncated or over-long LEB128, a length that overruns its section, an unknown
 * section or import kind) is refused, so a module cannot hide a memory from this check.
 * @param name - the cell's name (for the error).
 * @param bytes - the exact bytes that will be compiled.
 * @param maxPages - the page ceiling.
 * @returns the declared limits.
 * @throws CellError MODULE_BINARY | MODULE_MEMORY_IMPORTED | MODULE_MEMORY_COUNT | MODULE_MEMORY_SHARED | MODULE_MEMORY64 |
 *   MODULE_MEMORY_FLAGS | MODULE_MEMORY_UNBOUNDED | MODULE_MEMORY_LIMIT.
 */
export function inspectWasmMemory(name: string, bytes: Uint8Array, maxPages: number): WasmMemoryLimits {
  const fail = (code: string, detail?: string): never => { throw new CellError(name, code, detail) }
  if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 65_536) fail('MODULE_MEMORY_LIMIT', 'invalid ceiling')
  const total = bytes.byteLength
  const header = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]
  if (total < 8 || header.some((value, index) => bytes[index] !== value)) fail('MODULE_BINARY', 'header')
  let pos = 8
  let limit = total
  const u8 = (): number => {
    if (pos >= limit) fail('MODULE_BINARY', `truncated at ${String(pos)}`)
    return bytes[pos++] ?? 0
  }
  const u32 = (): number => {
    let result = 0
    for (let shift = 0; shift <= 28; shift += 7) {
      const byte = u8()
      if (shift === 28 && (byte & 0xf0) !== 0) fail('MODULE_BINARY', 'LEB128 u32 overflow')
      result += (byte & 0x7f) * 2 ** shift
      if ((byte & 0x80) === 0) return result
    }
    return fail('MODULE_BINARY', 'LEB128 u32 overflow')
  }
  /** Skip one LEB128 of at most 10 bytes (u64 limits, s33 heap types). */
  const skipLeb = (): void => {
    for (let index = 0; index < 10; index += 1) if ((u8() & 0x80) === 0) return
    fail('MODULE_BINARY', 'LEB128 too long')
  }
  const skip = (length: number): void => {
    if (length > limit - pos) fail('MODULE_BINARY', 'length overruns its section')
    pos += length
  }
  /** A value or reference type; the typed-reference prefixes (0x63, 0x64) carry a heap type. */
  const valueType = (): void => { const type = u8(); if (type === 0x63 || type === 0x64) skipLeb() }
  const memories: Array<{ initial: number; maximum: number | null }> = []
  const memoryType = (imported: boolean): void => {
    const flags = u8()
    if (imported) fail('MODULE_MEMORY_IMPORTED')
    if ((flags & 0x02) !== 0) fail('MODULE_MEMORY_SHARED')
    if ((flags & 0x04) !== 0) fail('MODULE_MEMORY64')
    if ((flags & ~0x01) !== 0) fail('MODULE_MEMORY_FLAGS', `0x${flags.toString(16)}`)
    const initial = u32()
    memories.push({ initial, maximum: (flags & 0x01) !== 0 ? u32() : null })
  }
  const tableType = (): void => {
    valueType()
    const flags = u8()
    if ((flags & ~0x07) !== 0) fail('MODULE_BINARY', 'table limits')
    skipLeb()
    if ((flags & 0x01) !== 0) skipLeb()
  }
  while (pos < total) {
    limit = total
    const id = u8()
    const size = u32()
    if (size > total - pos) fail('MODULE_BINARY', `section ${String(id)} overruns the module`)
    const end = pos + size
    if (id > 13) fail('MODULE_BINARY', `unknown section ${String(id)}`)
    limit = end
    if (id === 2) {
      for (let count = u32(); count > 0; count -= 1) {
        skip(u32())
        skip(u32())
        const kind = u8()
        if (kind === 0x00) u32()
        else if (kind === 0x01) tableType()
        else if (kind === 0x02) memoryType(true)
        else if (kind === 0x03) { valueType(); u8() }
        else if (kind === 0x04) { u8(); u32() }
        else fail('MODULE_BINARY', `unknown import kind ${String(kind)}`)
      }
      if (pos !== end) fail('MODULE_BINARY', 'import section length')
    } else if (id === 5) {
      for (let count = u32(); count > 0; count -= 1) memoryType(false)
      if (pos !== end) fail('MODULE_BINARY', 'memory section length')
    }
    pos = end
  }
  if (memories.length !== 1) fail('MODULE_MEMORY_COUNT', String(memories.length))
  const { initial, maximum } = memories[0] as { initial: number; maximum: number | null }
  if (maximum === null) return fail('MODULE_MEMORY_UNBOUNDED', `initial ${String(initial)} pages, no maximum`)
  if (initial > maximum || maximum > maxPages) fail('MODULE_MEMORY_LIMIT', `${String(initial)}..${String(maximum)} pages, ceiling ${String(maxPages)}`)
  return { initial, maximum }
}

/** Memory limits of every module this file admitted, keyed by the compiled module (set only by admitCell). */
const admittedMemory = new WeakMap<WebAssembly.Module, WasmMemoryLimits>()

const sha256Hex = async (bytes: Uint8Array<ArrayBuffer>): Promise<string> =>
  [...new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('')

/**
 * Admit one cell: size, SHA-256 pin on a private copy, binary memory limits of that same copy (all before compiling),
 * then compile, zero imports, exact exports.
 * @param name - the cell's name.
 * @param pin - its pin.
 * @param bytes - the bytes that were fetched.
 * @param maxMemoryPages - the memory ceiling (pinned cells: CELL_MAX_MEMORY_PAGES; guest skills: SKILL_MAX_MEMORY_PAGES).
 * @returns the compiled module.
 * @throws CellError MODULE_BOUND | MODULE_HASH | MODULE_BINARY | MODULE_MEMORY_* | MODULE_IMPORTS | MODULE_EXPORTS.
 */
export async function admitCell(
  name: string,
  pin: CellPin,
  bytes: Uint8Array,
  maxMemoryPages: number = CELL_MAX_MEMORY_PAGES,
): Promise<WebAssembly.Module> {
  if (bytes.byteLength === 0 || bytes.byteLength > pin.bytes) throw new CellError(name, 'MODULE_BOUND', `${String(bytes.byteLength)} bytes`)
  const copy = Uint8Array.from(bytes)
  const sha256 = await sha256Hex(copy)
  if (sha256 !== pin.sha256) throw new CellError(name, 'MODULE_HASH', sha256)
  // The private copy is never written after hashing, so the limits read here belong to exactly the pinned bytes.
  const memory = inspectWasmMemory(name, copy, maxMemoryPages)
  const module = await WebAssembly.compile(copy)
  if (WebAssembly.Module.imports(module).length !== 0) throw new CellError(name, 'MODULE_IMPORTS')
  const names = WebAssembly.Module.exports(module).map(entry => entry.name).sort()
  if (names.length !== METERED_CELL_EXPORTS.length || names.some((entry, index) => entry !== METERED_CELL_EXPORTS[index])) {
    throw new CellError(name, 'MODULE_EXPORTS', names.join(','))
  }
  admittedMemory.set(module, memory)
  return module
}

interface MeteredExports {
  readonly memory: WebAssembly.Memory
  readonly mv_abi_version: () => number
  readonly mv_alloc: (length: number) => number
  readonly mv_run: (pointer: number, length: number) => bigint
  readonly __mv_fuel_set: (fuel: bigint) => void
  readonly __mv_fuel_remaining: () => bigint
}

/** One call's answer: the cell's result or its own refusal code, and the fuel it used. */
export interface CellResult {
  readonly ok: true
  readonly cell: string
  readonly op: string
  readonly result: unknown
  readonly fuelUsed: number
  readonly sha256: string
}
export interface CellRefusal {
  readonly ok: false
  readonly cell: string
  readonly op: string
  readonly code: string
  readonly fuelUsed: number | null
  readonly sha256: string | null
  readonly expected?: unknown
  readonly got?: unknown
}
export type CellAnswer = CellResult | CellRefusal

/** Dedicated execution transport. The factory must run source in a separate, terminable worker. */
export interface CellWorker {
  /** Install message and failure handlers before the first request. */
  listen(onMessage: (message: unknown) => void, onFailure: () => void): void
  /** Send one structured-cloneable request. */
  postMessage(message: unknown): void
  /** Stop execution and release listeners; async adapters resolve only after worker exit. */
  terminate(): void | Promise<void>
}

interface CellExecutionRequest {
  readonly id: number
  readonly key: string
  readonly module: WebAssembly.Module
  readonly request: Uint8Array
  readonly fuel: number
  readonly maxResponseBytes: number
  /** The admitted memory maximum in bytes; the live buffer may never exceed it. */
  readonly maxMemoryBytes: number
  readonly retain: boolean
}
type CellExecutionAnswer = { readonly ok: true; readonly text: string; readonly fuelUsed: number }
  | { readonly ok: false; readonly code: string; readonly fuelUsed: number | null }

// Serialized as worker source: this function must have no references to its enclosing module.
function cellWorkerMain(): void {
  const instances = new Map<string, MeteredExports>()
  globalThis.onmessage = (event: MessageEvent<CellExecutionRequest>): void => {
    const { id, key, module, request, fuel: grant, maxResponseBytes, maxMemoryBytes, retain } = event.data
    const fuel = BigInt(grant)
    let exports = instances.get(key)
    let code = 'TRAP'
    try {
      if (!Number.isSafeInteger(maxMemoryBytes) || maxMemoryBytes <= 0) { code = 'MEMORY_CEILING'; throw new Error(code) }
      if (exports === undefined) {
        const candidate = new WebAssembly.Instance(module, {}).exports
        if (!(candidate.memory instanceof WebAssembly.Memory)
          || typeof candidate.mv_abi_version !== 'function' || typeof candidate.mv_alloc !== 'function'
          || typeof candidate.mv_run !== 'function' || typeof candidate.__mv_fuel_set !== 'function'
          || typeof candidate.__mv_fuel_remaining !== 'function') throw new Error('MODULE_EXPORTS')
        exports = candidate as unknown as MeteredExports
        if (exports.memory.buffer.byteLength > maxMemoryBytes) { code = 'MEMORY_CEILING'; throw new Error(code) }
        exports.__mv_fuel_set(fuel)
        if (exports.mv_abi_version() !== 1) { code = 'ABI_VERSION'; throw new Error(code) }
        if (retain) instances.set(key, exports)
      }
      exports.__mv_fuel_set(fuel)
      const pointer = exports.mv_alloc(request.byteLength)
      if (pointer < 64) { code = 'ALLOC'; throw new Error(code) }
      new Uint8Array(exports.memory.buffer, pointer, request.byteLength).set(request)
      exports.__mv_fuel_set(fuel)
      const packed = exports.mv_run(pointer, request.byteLength)
      if (exports.memory.buffer.byteLength > maxMemoryBytes) { code = 'MEMORY_CEILING'; throw new Error(code) }
      const remaining = exports.__mv_fuel_remaining()
      if (remaining < 0n || remaining > fuel) { code = 'FUEL_INVALID'; throw new Error(code) }
      const fuelUsed = Number(fuel - remaining)
      const length = Number(packed >> 32n), offset = Number(packed & 0xffff_ffffn)
      if (length <= 0 || length > maxResponseBytes || offset < 64 || offset + length > exports.memory.buffer.byteLength) {
        code = 'RESPONSE_DESCRIPTOR'; throw new Error(code)
      }
      const text = new TextDecoder().decode(new Uint8Array(exports.memory.buffer, offset, length))
      globalThis.postMessage({ id, ok: true, text, fuelUsed })
    } catch (error) {
      instances.delete(key)
      let remaining: bigint | undefined
      try { remaining = exports?.__mv_fuel_remaining() } catch { /* The failed instance is discarded. */ }
      if (remaining !== undefined && remaining >= 0n && remaining <= fuel) {
        if (code === 'TRAP' && error instanceof WebAssembly.RuntimeError && remaining < 16n) code = 'FUEL'
        globalThis.postMessage({ id, ok: false, code, fuelUsed: Number(fuel - remaining) })
      } else {
        globalThis.postMessage({ id, ok: false, code, fuelUsed: null })
      }
    }
  }
}

interface NodeWorkerInstance {
  on(event: 'message', listener: (value: unknown) => void): void
  on(event: 'error' | 'messageerror', listener: () => void): void
  postMessage(message: unknown): void
  terminate(): Promise<number>
  removeAllListeners(): void
  unref?(): void
}

function browserCellWorker(source: string): CellWorker {
  if (typeof Worker !== 'undefined') {
    const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }))
    let worker: Worker
    try { worker = new Worker(url, { name: 'auma-wasm-cell' }) }
    catch (error) { URL.revokeObjectURL(url); throw error }
    return {
      listen(onMessage, onFailure) {
        worker.onmessage = event => onMessage(event.data)
        worker.onerror = onFailure
        worker.onmessageerror = onFailure
      },
      postMessage: message => worker.postMessage(message),
      terminate() {
        worker.onmessage = null
        worker.onerror = null
        worker.onmessageerror = null
        worker.terminate()
        URL.revokeObjectURL(url)
      },
    }
  }
  const getBuiltin = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process?.getBuiltinModule
  const wt = typeof getBuiltin === 'function'
    ? getBuiltin('node:worker_threads') as { Worker?: new (code: string, opts: { eval: boolean; execArgv: string[] }) => NodeWorkerInstance } | undefined
    : undefined
  if (typeof wt?.Worker === 'function') {
    const worker = new wt.Worker(
      'const { parentPort } = require(\'node:worker_threads\');'
      + 'globalThis.postMessage = value => parentPort.postMessage(value);'
      + 'parentPort.on(\'message\', data => globalThis.onmessage({ data }));'
      + source,
      { eval: true, execArgv: [] },
    )
    worker.unref?.()
    return {
      listen(onMessage, onFailure) {
        worker.on('message', onMessage)
        worker.on('error', onFailure)
        worker.on('messageerror', onFailure)
      },
      postMessage: message => worker.postMessage(message),
      async terminate() {
        await worker.terminate()
        worker.removeAllListeners()
      },
    }
  }
  throw new Error('CELL_WORKER_UNAVAILABLE')
}

/** One host owns one worker and serializes calls; terminating it discards all its cached instances. */
class CellExecutor {
  private worker: CellWorker | undefined
  private queue: Promise<unknown> = Promise.resolve()
  private pending: ((answer: CellExecutionAnswer, discard: boolean) => void) | undefined
  private serial = 0
  private disposed = false
  private stopping: Promise<void> = Promise.resolve()

  constructor(private readonly createWorker: (source: string) => CellWorker) {}

  schedule<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation)
    this.queue = next.catch(() => undefined)
    return next
  }

  private stop(): Promise<void> {
    const worker = this.worker
    this.worker = undefined
    if (worker) this.stopping = Promise.resolve().then(() => worker.terminate())
    return this.stopping
  }

  async dispose(): Promise<void> {
    this.disposed = true
    this.pending?.({ ok: false, code: 'CELL_HOST_DISPOSED', fuelUsed: null }, true)
    await this.stop()
    await this.queue
  }

  execute(request: Omit<CellExecutionRequest, 'id'>): Promise<CellExecutionAnswer> {
    if (this.disposed) return Promise.resolve({ ok: false, code: 'CELL_HOST_DISPOSED', fuelUsed: null })
    return new Promise((resolve) => {
      const id = ++this.serial
      let settled = false
      const finish = (answer: CellExecutionAnswer, discard: boolean): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.pending = undefined
        if (discard) void this.stop().then(() => resolve(answer), () => {
          this.disposed = true
          resolve({ ok: false, code: 'CELL_WORKER_TERMINATION_FAILED', fuelUsed: null })
        })
        else resolve(answer)
      }
      const timer = setTimeout(() => finish({ ok: false, code: 'TIMEOUT', fuelUsed: null }, true), CELL_EXECUTION_TIMEOUT_MS)
      this.pending = finish
      try {
        if (this.worker === undefined) {
          this.worker = this.createWorker(`(${cellWorkerMain.toString()})();`)
          this.worker.listen((message) => {
            const current = this.pending
            if (!current) return
            if (!message || typeof message !== 'object') {
              current({ ok: false, code: 'CELL_WORKER_RESPONSE', fuelUsed: null }, true)
              return
            }
            const reply = message as Record<string, unknown>
            const fuelValid = reply.fuelUsed === null || (typeof reply.fuelUsed === 'number'
              && Number.isSafeInteger(reply.fuelUsed) && reply.fuelUsed >= 0 && reply.fuelUsed <= CELL_BROWSER_FUEL_CAP)
            if (reply.id !== this.serial || !fuelValid
              || (reply.ok === true ? typeof reply.text !== 'string' || reply.text.length > CELL_MAX_RESPONSE_BYTES || reply.fuelUsed === null
                : reply.ok !== false || typeof reply.code !== 'string')) {
              current({ ok: false, code: 'CELL_WORKER_RESPONSE', fuelUsed: null }, true)
              return
            }
            current(reply.ok === true
              ? { ok: true, text: reply.text as string, fuelUsed: reply.fuelUsed as number }
              : { ok: false, code: reply.code as string, fuelUsed: reply.fuelUsed as number | null }, false)
          }, () => this.pending?.({ ok: false, code: 'CELL_WORKER_FAILED', fuelUsed: null }, true))
        }
        this.worker.postMessage({ ...request, id })
      } catch {
        finish({ ok: false, code: this.worker ? 'CELL_WORKER_FAILED' : 'CELL_WORKER_UNAVAILABLE', fuelUsed: null }, true)
      }
    })
  }
}

/** One admitted cell; the host serializes calls and owns the independently terminable execution worker. */
class MeteredCell {
  private seq = 0
  constructor(
    readonly name: string,
    private readonly pin: CellPin,
    private readonly module: WebAssembly.Module,
    private readonly executor: CellExecutor,
    private readonly options?: { readonly relaxSeq?: boolean; readonly detailedMalformed?: boolean },
  ) {}

  invoke(op: string, input: unknown): Promise<CellAnswer> {
    return this.executor.schedule(() => this.run(op, input))
  }

  private async run(op: string, input: unknown): Promise<CellAnswer> {
    const seq = this.seq + 1
    let request: Uint8Array
    try {
      request = encoder.encode(cellCanonicalJson({ abi: 1, input, op, seq }))
    } catch (error) {
      return { ok: false, cell: this.name, op, code: `UNREPRESENTABLE: ${error instanceof Error ? error.message : String(error)}`, fuelUsed: null, sha256: this.pin.sha256 }
    }
    if (request.byteLength > (this.pin.maxRequestBytes ?? CELL_MAX_REQUEST_BYTES)) return { ok: false, cell: this.name, op, code: 'REQUEST_BOUND', fuelUsed: null, sha256: this.pin.sha256 }
    // Only a module admitted by admitCell (pin + binary memory limits) ever reaches the execution worker.
    const memory = admittedMemory.get(this.module)
    if (memory === undefined) return { ok: false, cell: this.name, op, code: 'MODULE_MEMORY_UNADMITTED', fuelUsed: null, sha256: this.pin.sha256 }
    const execution = await this.executor.execute({
      key: `${this.name}:${this.pin.sha256}`, module: this.module, request,
      fuel: Math.min(this.pin.fuel, CELL_BROWSER_FUEL_CAP), maxResponseBytes: CELL_MAX_RESPONSE_BYTES,
      maxMemoryBytes: memory.maximum * WASM_PAGE_BYTES, retain: !this.options?.relaxSeq,
    })
    if (!execution.ok) return { ...execution, cell: this.name, op, sha256: this.pin.sha256 }
    this.seq = seq
    const { text, fuelUsed: used } = execution
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return {
        ok: false,
        cell: this.name,
        op,
        code: 'MALFORMED_RESPONSE',
        fuelUsed: used,
        sha256: this.pin.sha256,
        ...(this.options?.detailedMalformed
          ? {
            expected: { abi: 1, status: 'ok | refused', result: '<json>', seq: 'optional integer' },
            got: text.slice(0, 256),
          }
          : {}),
      }
    }
    const answer = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
    if (answer.status === 'refused') {
      return { ok: false, cell: this.name, op, code: typeof answer.code === 'string' ? answer.code : 'REFUSED', fuelUsed: used, sha256: this.pin.sha256 }
    }
    const seqValid = this.options?.relaxSeq
      ? (answer.seq === undefined || Number.isSafeInteger(answer.seq))
      : answer.seq === seq
    if (answer.abi !== 1 || !seqValid || answer.status !== 'ok' || !Object.hasOwn(answer, 'result')) {
      return {
        ok: false,
        cell: this.name,
        op,
        code: 'MALFORMED_RESPONSE',
        fuelUsed: used,
        sha256: this.pin.sha256,
        ...(this.options?.detailedMalformed
          ? {
            expected: { abi: 1, status: 'ok | refused', result: '<json>', seq: 'optional integer' },
            got: {
              abi: answer.abi ?? null,
              seq: answer.seq ?? null,
              status: answer.status ?? null,
              hasResult: Object.hasOwn(answer, 'result'),
            },
          }
          : {}),
      }
    }
    return { ok: true, cell: this.name, op, result: answer.result, fuelUsed: used, sha256: this.pin.sha256 }
  }
}

/** Admitted modules are cached by this host; their instances live only in its dedicated execution worker. */
export interface CellHost {
  /** Terminate execution, settle queued calls, and release modules. This host cannot execute again. */
  dispose(): Promise<void>
  /** The admitted cell names, pins, and verified op manifests. */
  list(): readonly {
    readonly cell: string
    readonly sha256: string
    readonly bytes: number
    readonly fuel: number
    readonly ops: readonly string[]
  }[]
  /** Run one op of one cell. Never throws: a refusal, a bad request or an unadmitted cell comes back as `ok: false`. */
  invoke(cell: string, op: string, input?: unknown): Promise<CellAnswer>
  /** Compile WAT via pinned `skillsmith` (`build` + `meter`), admit the metered Wasm (0 imports, binary max <= 16 pages), and run it. */
  compileAndRun(spec: CompileAndRunSpec): Promise<CompileAndRunAnswer>
}

/**
 * Hold the cells for this worker.
 * @param deps - this worker's origin and fetch (tests pass their own); `pins` defaults to `CELL_PINS`.
 * @returns the cell host.
 */
export function createCellHost(deps: {
  readonly origin: string | undefined
  readonly fetchImpl?: typeof fetch
  readonly pins?: Readonly<Record<string, CellPin>>
  /** Separate-worker transport; omitted in browsers. Other hosts must supply real worker isolation. */
  readonly createWorker?: (source: string) => CellWorker
}): CellHost {
  const pins = deps.pins ?? CELL_PINS
  const executor = new CellExecutor(deps.createWorker ?? browserCellWorker)
  const loaded = new Map<string, Promise<MeteredCell>>()
  const load = (name: string, pin: CellPin): Promise<MeteredCell> => {
    const existing = loaded.get(name)
    if (existing !== undefined) return existing
    const next = (async () => {
      if (!deps.origin || deps.origin === 'null') throw new CellError(name, 'ORIGIN_UNAVAILABLE')
      const response = await (deps.fetchImpl ?? globalThis.fetch)(new URL(`${CELL_BASE_PATH}${name}.wasm`, deps.origin).href,
        { credentials: 'same-origin', signal: AbortSignal.timeout(30_000) })
      if (!response.ok) throw new CellError(name, 'MODULE_UNAVAILABLE', `HTTP ${String(response.status)}`)
      return new MeteredCell(name, pin, await admitCell(name, pin, new Uint8Array(await response.arrayBuffer())), executor)
    })()
    loaded.set(name, next)
    // A failed load is not kept: the next call tries again.
    next.catch(() => { if (loaded.get(name) === next) loaded.delete(name) })
    return next
  }
  const invokeCell = async (cell: string, op: string, input: unknown = {}): Promise<CellAnswer> => {
    const pin = Object.hasOwn(pins, cell) ? pins[cell] : undefined
    if (pin === undefined) return { ok: false, cell, op, code: 'CELL_UNKNOWN', fuelUsed: null, sha256: null }
    if (typeof op !== 'string' || !OP.test(op)) return { ok: false, cell, op: String(op), code: 'OP_INVALID', fuelUsed: null, sha256: pin.sha256 }
    let resolvedOp = op
    if (!op.includes('.') && Array.isArray(pin.ops)) {
      const matches = pin.ops.filter(candidate => candidate === op || candidate.endsWith(`.${op}`))
      if (matches.length === 1 && matches[0]) resolvedOp = matches[0]
    }
    try {
      return (await load(cell, pin)).invoke(resolvedOp, input)
    } catch (error) {
      const detail = error instanceof CellError && error.message.includes('(')
        ? error.message.slice(error.message.indexOf(' ('))
        : ''
      const code = error instanceof CellError ? `${error.code}${detail}` : 'CELL_LOAD_FAILED'
      return { ok: false, cell, op: resolvedOp, code, fuelUsed: null, sha256: pin.sha256 }
    }
  }
  return {
    async dispose() {
      await executor.dispose()
      loaded.clear()
    },
    list: () => Object.entries(pins).map(([cell, pin]) => ({
      cell, sha256: pin.sha256, bytes: pin.bytes, fuel: Math.min(pin.fuel, CELL_BROWSER_FUEL_CAP), ops: pin.ops ?? [],
    })),
    invoke: invokeCell,
    async compileAndRun(spec) {
      const name = typeof spec.name === 'string' && /^[a-z][a-z0-9-]{0,31}$/u.test(spec.name) ? spec.name : 'skill'
      const version = typeof spec.version === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/u.test(spec.version)
        ? spec.version
        : 'v1'
      const op = typeof spec.op === 'string' && OP.test(spec.op) ? spec.op : 'run'
      const fuel = spec.fuel === undefined ? 1_000_000 : spec.fuel
      if (!Number.isSafeInteger(fuel) || fuel <= 0 || fuel > SKILL_MAX_FUEL) {
        return { ok: false, cell: name, op, code: 'SKILL_FUEL_LIMIT', fuelUsed: null, sha256: null }
      }
      if (typeof spec.wat !== 'string' || spec.wat.length === 0 || encoder.encode(spec.wat).byteLength > SKILL_MAX_WAT_BYTES) {
        return { ok: false, cell: name, op, code: 'SKILL_WAT_INVALID', fuelUsed: null, sha256: null }
      }
      if (!hasBoundedWatMemory(spec.wat)) {
        return { ok: false, cell: name, op, code: 'SKILL_MEMORY_LIMIT', fuelUsed: null, sha256: null }
      }
      const normalizedWat = normalizeWatSkillExports(spec.wat)
      const buildRes = await invokeCell('skillsmith', 'build', {
        wat: normalizedWat,
        name,
        version,
        input_schema: spec.inputSchema ?? { type: 'object' },
        output_schema: spec.outputSchema ?? { type: 'object' },
        fuel,
      })
      if (!buildRes.ok) {
        return {
          ...buildRes,
          cell: name,
          op,
          sha256: null,
          ...(buildRes.sha256 ? { cellSha256: buildRes.sha256 } : {}),
          ...(buildRes.code === 'EXPORTS' || buildRes.code === 'MODULE_EXPORTS'
            ? { expectedExports: SKILL_EXPECTED_EXPORTS, gotExports: extractWatExports(spec.wat) }
            : {}),
        }
      }
      const buildOut = buildRes.result !== null && typeof buildRes.result === 'object'
        ? buildRes.result as Record<string, unknown>
        : {}
      if (typeof buildOut.bytes !== 'string' || typeof buildOut.code_sha256 !== 'string') {
        return { ok: false, cell: name, op, code: 'SKILLSMITH_BUILD_INVALID', fuelUsed: buildRes.fuelUsed, sha256: null, cellSha256: buildRes.sha256 }
      }
      const rawBytes = fromBase64Bytes(buildOut.bytes)
      const rawSha = await sha256Hex(rawBytes)
      if (rawSha !== buildOut.code_sha256) {
        return { ok: false, cell: name, op, code: 'SKILLSMITH_HASH_MISMATCH', fuelUsed: buildRes.fuelUsed, sha256: rawSha, cellSha256: buildRes.sha256 }
      }
      const meterRes = await invokeCell('skillsmith', 'meter', { bytes: buildOut.bytes })
      if (!meterRes.ok) {
        return {
          ...meterRes,
          cell: name,
          op,
          sha256: null,
          ...(meterRes.sha256 ? { cellSha256: meterRes.sha256 } : {}),
          codeSha256: rawSha,
        }
      }
      const meterOut = meterRes.result !== null && typeof meterRes.result === 'object'
        ? meterRes.result as Record<string, unknown>
        : {}
      if (typeof meterOut.bytes !== 'string' || typeof meterOut.metered_sha256 !== 'string') {
        return { ok: false, cell: name, op, code: 'SKILLSMITH_METER_INVALID', fuelUsed: meterRes.fuelUsed, sha256: rawSha, cellSha256: meterRes.sha256 }
      }
      const meteredBytes = fromBase64Bytes(meterOut.bytes)
      const compilerFuelUsed = (buildRes.fuelUsed ?? 0) + (meterRes.fuelUsed ?? 0)
      try {
        const guestPin: CellPin = { sha256: meterOut.metered_sha256, bytes: SKILL_MAX_WASM_BYTES, fuel }
        // The binary check is authoritative: the WAT pre-check above is only an early, friendlier refusal.
        const module = await admitCell(name, guestPin, meteredBytes, SKILL_MAX_MEMORY_PAGES)
        const guestCell = new MeteredCell(name, guestPin, module, executor, { relaxSeq: true, detailedMalformed: true })
        const answer = await guestCell.invoke(op, spec.input ?? {})
        return { ...answer, cellSha256: buildRes.sha256, codeSha256: rawSha, meteredSha256: meterOut.metered_sha256, compilerFuelUsed }
      } catch (error) {
        const code = error instanceof CellError ? error.code : 'SKILL_ADMISSION_FAILED'
        return {
          ok: false,
          cell: name,
          op,
          code,
          fuelUsed: null,
          sha256: meterOut.metered_sha256,
          cellSha256: buildRes.sha256,
          codeSha256: rawSha,
          meteredSha256: meterOut.metered_sha256,
          compilerFuelUsed,
          ...(code === 'MODULE_EXPORTS' ? { expectedExports: SKILL_EXPECTED_EXPORTS, gotExports: extractWatExports(spec.wat) } : {}),
        }
      }
    },
  }
}

let workerHost: CellHost | null = null
/** This worker's one cell host, on its own origin: the `x6_cell` tool and every organ's `ctx.wasm` share it. */
export function workerCellHost(): CellHost {
  workerHost ??= createCellHost({ origin: (globalThis as { location?: { origin?: string } }).location?.origin })
  return workerHost
}
