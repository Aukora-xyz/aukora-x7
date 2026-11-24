// Independent check by Mythos: only `say` envelopes, built from the format described in core/Stateful.lean.
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
const bytes = await readFile(new URL('../../core/Core3.wasm', import.meta.url))
const mod = new WebAssembly.Module(bytes)
console.log('imports', JSON.stringify(WebAssembly.Module.imports(mod)), 'exports', JSON.stringify(WebAssembly.Module.exports(mod).map(e => e.name + ':' + e.kind)))
const fresh = () => { const i = new WebAssembly.Instance(mod, {}).exports; i.init(); return i }
const head = i => Uint8Array.from({ length: 32 }, (_, k) => i.head(k))
const hex = u => Buffer.from(u).toString('hex')
const say = (parent, seq, text) => { const t = Buffer.from(text, 'utf8'); return Buffer.concat([Buffer.from(parent), Buffer.from([seq & 255, seq >> 8, 0, t.length & 255, t.length >> 8]), t]) }
const feed = (i, frame) => { for (const b of frame) i.input(b); return i.step() }
const run = () => {
  const i = fresh(), out = []
  const h0 = head(i); out.push(['genesis head', hex(h0).slice(0, 16)])
  const e1 = say(h0, 1, 'hello from mythos'); const v1 = feed(i, e1); const h1 = head(i)
  out.push(['say #1 verdict', v1], ['head == sha256(frame)', hex(h1) === createHash('sha256').update(e1).digest('hex')])
  out.push(['same bytes again (stale parent)', feed(i, e1)], ['head unchanged', hex(head(i)) === hex(h1)])
  out.push(['right parent, wrong sequence 5', feed(i, say(h1, 5, 'skip'))], ['head unchanged', hex(head(i)) === hex(h1)])
  out.push(['garbage 3 bytes', feed(i, Buffer.from([1, 2, 3]))])
  const e2 = say(h1, 2, 'second line'); out.push(['say #2 verdict', feed(i, e2)])
  out.push(['head == sha256(frame 2)', hex(head(i)) === createHash('sha256').update(e2).digest('hex')])
  return [out, hex(head(i))]
}
const [a, ha] = run(), [, hb] = run()
for (const [k, v] of a) console.log(String(v).padEnd(18), k)
console.log('two fresh instances, same final head:', ha === hb, ha.slice(0, 16))
