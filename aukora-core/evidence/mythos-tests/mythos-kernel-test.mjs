// Mythos: robustness run on Astra's checker cell. Not a soundness proof: any accepted term is, if the kernel is
// sound, a real proof of the goal. This checks the cell never traps and that plain damage is refused.
import { readFileSync } from 'node:fs'
const mod = new WebAssembly.Module(readFileSync('logs/repro6/Kernel6.astra.wasm'))
const proof = readFileSync('logs/r6/wrong_digest.proof.expr')
const api = new WebAssembly.Instance(mod).exports
console.log('imports', JSON.stringify(WebAssembly.Module.imports(mod)), 'exports', WebAssembly.Module.exports(mod).map(e => e.name).join(','), 'ready', api.ready(), 'proof bytes', proof.length)
const run = b => { for (const x of b) api.input(x); return api.check() }
let accepted = 0, refused = 0, trapped = 0
const t0 = performance.now(); console.log('original proof verdict', run(proof), `(${(performance.now() - t0).toFixed(1)} ms incl. input loop)`)
let seed = 12345; const rnd = n => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n }
for (let k = 0; k < 300; k++) { const m = Buffer.from(proof); const at = rnd(m.length); m[at] ^= 1 << rnd(8)
  try { run(m) === 1 ? accepted++ : refused++ } catch { trapped++; break } }
console.log('300 single-bit mutations: refused', refused, 'accepted', accepted, 'trapped', trapped)
console.log('random 500 bytes verdict', run(Buffer.from(Array.from({ length: 500 }, () => rnd(256)))), '| all zero 100 bytes verdict', run(Buffer.alloc(100)))
console.log('original proof again', run(proof))
