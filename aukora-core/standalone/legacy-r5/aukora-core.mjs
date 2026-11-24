// AUKORA Core, standalone adapter (lab, 22 Nov 2026). No dependencies beyond Node's standard library.
// It loads the proved core (round 5: state, SHA-256, byte-bound upgrade and owner-signature checks inside) and
// gives any agent system three things: append an event, read the head, replay a log to check it.
// The adapter decides nothing. Every accept or refuse comes from the Wasm core.
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

/** SHA-256 of the one core file this adapter will run. A different file is refused before it is instantiated. */
export const PINNED_CORE_SHA256 = 'd74a5e0170299d62e8349496b9c0e31b2a4091b51273ef8bf82204b39222350a'
export const CORE_FILE = new URL('./aukora-core.wasm', import.meta.url)

const u16 = n => Buffer.from([n & 255, (n >> 8) & 255])
const u64 = n => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b }
const text = s => { const t = Buffer.from(s, 'utf8'); if (t.length > 65535) throw new Error('text too long'); return Buffer.concat([u16(t.length), t]) }
const sha256 = b => createHash('sha256').update(b).digest()

/** Canonical bytes of a "deliver" intent: what the owner approves. Field order is the core's (core/Wire4.lean). */
export function intentBytes({ payload, audience, generation = 0, nonce }) {
  const p = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8')
  return Buffer.concat([Buffer.from([0]), u16(p.length), p, text(audience), u16(generation), u16(nonce)])
}
/** The exact message the owner's Ed25519 key signs for a grant (core/Wire5.lean `intentBytes`). */
export const grantMessage = intent => Buffer.concat([Buffer.from('AUKORA/R5/grant'), intentBytes(intent)])

export class Core {
  /** @param {Uint8Array} [wasm] the core file; defaults to the pinned copy beside this module. */
  constructor(wasm = readFileSync(CORE_FILE)) {
    const digest = sha256(wasm).toString('hex')
    if (digest !== PINNED_CORE_SHA256) throw new Error(`core file is not the pinned one (got ${digest})`)
    const module = new WebAssembly.Module(wasm)
    if (WebAssembly.Module.imports(module).length !== 0) throw new Error('core must import nothing')
    this.api = new WebAssembly.Instance(module, {}).exports
    this.seq = 0
    this.accepted = [] // every accepted frame, in order: the whole record
    this.owner = null
  }
  #feed(bytes) { for (const b of bytes) this.api.input(b) }
  #read(fn) { return Buffer.from(Uint8Array.from({ length: 32 }, (_, k) => this.api[fn](k))) }
  /** Start a new record owned by one Ed25519 public key (32 raw bytes). Once. */
  genesis(ownerPublicKey) {
    if (this.owner) throw new Error('genesis already done')
    this.#feed(ownerPublicKey)
    if (this.api.init() !== 1) throw new Error('core refused the owner key')
    this.owner = Buffer.from(ownerPublicKey)
    return this.head()
  }
  head() { return this.#read('head') }
  coreDigest() { return this.#read('core') }
  /** Send one raw frame. Returns true when the core accepted it. A refusal changes nothing. */
  send(frame) {
    this.#feed(frame)
    const ok = this.api.step() === 1
    if (ok) { this.seq += 1; this.accepted.push(Buffer.from(frame)) }
    return ok
  }
  #frame(tag, body) { return Buffer.concat([this.head(), u64(this.seq + 1), Buffer.from([tag]), body]) }
  /** Record one line. Needs no approval; it can never change authority (law L5). */
  say(line) { return this.send(this.#frame(0, text(line))) }
  /** Admit an owner approval. `signature` is 64 bytes by the owner key over `grantMessage(intent)`. */
  grant(intent, signature) { return this.send(this.#frame(3, Buffer.concat([intentBytes(intent), Buffer.from(signature)]))) }
  /** Use an approval once (law L4). Refused without a matching unspent grant. */
  act(intent) { return this.send(this.#frame(4, intentBytes(intent))) }
  /** Record what the destination reported: 'confirmed', 'failed' or 'unknown' (law L10). */
  outcome(intent, result) {
    const code = ['confirmed', 'failed', 'unknown'].indexOf(result)
    if (code < 0) throw new Error('result must be confirmed, failed or unknown')
    return this.send(this.#frame(5, Buffer.concat([intentBytes(intent), Buffer.from([code])])))
  }
  /** The record as plain lines: a header, then one hex frame per accepted event. */
  exportLog() {
    return [JSON.stringify({ v: 1, core: PINNED_CORE_SHA256, owner: this.owner.toString('hex') }),
      ...this.accepted.map(f => f.toString('hex'))].join('\n') + '\n'
  }
}

/**
 * Replay a log in a fresh core. Returns { ok, head, events, refusedAt }.
 * Anyone can run this: it needs no key. If any frame is refused the log is not a valid record.
 */
export function replay(logText) {
  const lines = logText.split('\n').filter(l => l.length > 0)
  const header = JSON.parse(lines[0])
  if (header.v !== 1 || header.core !== PINNED_CORE_SHA256) return { ok: false, head: null, events: 0, refusedAt: 0, why: 'unknown core' }
  const core = new Core()
  core.genesis(Buffer.from(header.owner, 'hex'))
  for (let k = 1; k < lines.length; k++) {
    if (!core.send(Buffer.from(lines[k], 'hex'))) return { ok: false, head: core.head().toString('hex'), events: k - 1, refusedAt: k }
  }
  return { ok: true, head: core.head().toString('hex'), events: lines.length - 1, refusedAt: null }
}
