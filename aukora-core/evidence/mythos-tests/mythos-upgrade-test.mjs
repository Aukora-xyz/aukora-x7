// Independent check by Mythos, written from core/Wire4.lean only. Candidate = Core4.wasm itself.
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
const wasm = await readFile(new URL('../../core/Core4.wasm', import.meta.url))
const mod = new WebAssembly.Module(wasm)
console.log('imports', JSON.stringify(WebAssembly.Module.imports(mod)), 'exports', WebAssembly.Module.exports(mod).map(e => e.name + ':' + e.kind).join(' '))
const fresh = () => { const i = new WebAssembly.Instance(mod, {}).exports; i.init(); return i }
const read = (i, f) => Buffer.from(Uint8Array.from({ length: 32 }, (_, k) => i[f](k)))
const u16 = n => Buffer.from([n & 255, n >> 8]), u64 = n => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b }
const text = s => { const t = Buffer.from(s, 'utf8'); return Buffer.concat([u16(t.length), t]) }
const intent = digest => Buffer.concat([Buffer.from([1]), digest, text('core'), u16(0), u16(7)])   // install digest, audience, generation 0, nonce 7
const frame = (parent, seq, tag, body) => Buffer.concat([parent, u64(seq), Buffer.from([tag]), body])
const send = (i, f) => { for (const b of f) i.input(b); return i.step() }
const stage = (i, bytes) => { i.reset(); for (let o = 0; o < bytes.length; o += 60000) { for (const b of bytes.subarray(o, o + 60000)) i.input(b); if (i.feed() !== 1) return 0 } return 1 }
const good = wasm, D = createHash('sha256').update(good).digest()
const bad = Buffer.from(good); bad[bad.length >> 1] ^= 1
const zero = Buffer.alloc(32)
const i = fresh(), rows = []
const g = frame(read(i, 'head'), 1, 3, Buffer.concat([intent(D), Buffer.from([1])]))
rows.push(['grant for sha256(Core4.wasm)', send(i, g), 1]); const h1 = read(i, 'head')
const up = (parent, seq, proof) => frame(parent, seq, 7, Buffer.concat([D, Buffer.from([proof]), intent(D)]))
stage(i, bad); rows.push(['upgrade, one bit flipped in the candidate', send(i, up(h1, 2, 1)), 0])
rows.push(['  core still zero and head unchanged', Number(read(i, 'core').equals(zero) && read(i, 'head').equals(h1)), 1])
stage(i, good); rows.push(['upgrade, exact bytes, proofChecked = false', send(i, up(h1, 2, 0)), 0])
rows.push(['  core still zero', Number(read(i, 'core').equals(zero)), 1])
stage(i, good); rows.push(['upgrade, exact bytes, proofChecked = true', send(i, up(h1, 2, 1)), 1])
rows.push(['  core == sha256(Core4.wasm)', Number(read(i, 'core').equals(D)), 1]); const h2 = read(i, 'head')
stage(i, good); rows.push(['same grant used a second time', send(i, up(h2, 3, 1)), 0])
const j = fresh(); stage(j, good); rows.push(['fresh instance, exact bytes, no grant at all', send(j, up(read(j, 'head'), 1, 1)), 0])
let ok = true; for (const [k, got, want] of rows) { ok &&= got === want; console.log(String(got), got === want ? 'ok  ' : 'FAIL', k) }
console.log(ok ? 'ALL AS EXPECTED' : 'MISMATCH', 'core', read(i, 'core').toString('hex').slice(0, 16))
