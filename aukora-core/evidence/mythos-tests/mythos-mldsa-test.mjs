// Mythos: independent check of the Lean-written ML-DSA-65 verifier (as Wasm) against Node/OpenSSL on fresh keys.
import { readFileSync } from 'node:fs'
import { generateKeyPairSync, sign, randomBytes } from 'node:crypto'
const mod = new WebAssembly.Module(readFileSync('logs/repro8/Mldsa8.astra.wasm'))
console.log('imports', JSON.stringify(WebAssembly.Module.imports(mod)), 'exports', WebAssembly.Module.exports(mod).map(e => e.name).join(','))
const api = new WebAssembly.Instance(mod, {}).exports
const check = (key, msg, sig) => { api.clear(); [key, msg, sig].forEach((f, i) => { for (const b of f) api.input(i, b) }); return api.verify() }
const raw = k => k.export({ type: 'spki', format: 'der' }).subarray(-1952)
let good = 0, bad = 0, wrong = [], times = []
const keys = Array.from({ length: 6 }, () => generateKeyPairSync('ml-dsa-65'))
for (const [n, k] of keys.entries()) {
  const msg = randomBytes([0, 1, 33, 200, 1500, 5000][n]), sig = sign(null, msg, k.privateKey), pub = raw(k.publicKey)
  const t = performance.now(); const ok = check(pub, msg, sig); times.push(performance.now() - t)
  ok === 1 ? good++ : wrong.push(`key ${n}: valid signature refused`)
  const cases = { 'flipped signature bit': [pub, msg, Buffer.from(sig).fill(sig[100] ^ 4, 100, 101)], 'changed message': [pub, Buffer.concat([msg, Buffer.from([1])]), sig],
    'flipped key bit': [Buffer.from(pub).fill(pub[500] ^ 1, 500, 501), msg, sig], 'another key': [raw(keys[(n + 1) % keys.length].publicKey), msg, sig],
    'signature one byte short': [pub, msg, sig.subarray(0, -1)], 'signature one byte long': [pub, msg, Buffer.concat([sig, Buffer.from([0])])], 'key one byte short': [pub.subarray(0, -1), msg, sig] }
  for (const [label, c] of Object.entries(cases)) check(...c) === 0 ? bad++ : wrong.push(`key ${n}: ${label} ACCEPTED`)
}
console.log(`valid signatures accepted ${good}/6; damaged or mismatched cases refused ${bad}/42`)
console.log('ms per check incl. byte transfer:', times.map(t => t.toFixed(1)).join(' '))
console.log(wrong.length ? 'MISMATCH: ' + wrong.join('; ') : 'ALL AS EXPECTED')
