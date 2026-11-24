// Independent check by Mythos, written from core/Wire5.lean only. Keys and signatures come from Node's own Ed25519.
import { readFile } from 'node:fs/promises'
import { generateKeyPairSync, sign, createHash } from 'node:crypto'
const wasm = await readFile(new URL('../../core/Core5.wasm', import.meta.url))
const mod = new WebAssembly.Module(wasm)
console.log('imports', JSON.stringify(WebAssembly.Module.imports(mod)), 'exports', WebAssembly.Module.exports(mod).map(e => e.name + ':' + e.kind).join(' '))
const key = () => { const k = generateKeyPairSync('ed25519'); return { priv: k.privateKey, pub: k.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32) } }
const fresh = pub => { const i = new WebAssembly.Instance(mod, {}).exports; for (const b of pub) i.input(b); return [i, i.init()] }
const read = (i, f) => Buffer.from(Uint8Array.from({ length: 32 }, (_, k) => i[f](k)))
const u16 = n => Buffer.from([n & 255, n >> 8]), u64 = n => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b }
const text = s => { const t = Buffer.from(s, 'utf8'); return Buffer.concat([u16(t.length), t]) }
const intent = (payload, nonce, gen = 0) => Buffer.concat([Buffer.from([0]), u16(payload.length), payload, text('mythos-test'), u16(gen), u16(nonce)])
const grantFrame = (parent, seq, it, sig) => Buffer.concat([parent, u64(seq), Buffer.from([3]), it, sig])
const sigGrant = (k, it) => sign(null, Buffer.concat([Buffer.from('AUKORA/R5/grant'), it]), k.priv)
const send = (i, f) => { for (const b of f) i.input(b); return i.step() }
const owner = key(), stranger = key(), next = key()
const [i, ok] = fresh(owner.pub); const rows = [['genesis with a fresh Node-made owner key', ok, 1]]
const h0 = read(i, 'head'); const it1 = intent(Buffer.from('send one message'), 1)
const good = sigGrant(owner, it1); const flipped = Buffer.from(good); flipped[10] ^= 1
rows.push(['grant, signature with one bit flipped', send(i, grantFrame(h0, 1, it1, flipped)), 0])
rows.push(['grant, signed by a stranger key', send(i, grantFrame(h0, 1, it1, sigGrant(stranger, it1))), 0])
rows.push(['grant, right signature but a changed intent', send(i, grantFrame(h0, 1, intent(Buffer.from('send TWO messages'), 1), good)), 0])
rows.push(['  head unchanged after three refusals', Number(read(i, 'head').equals(h0)), 1])
const f1 = grantFrame(h0, 1, it1, good); rows.push(['grant, signed by the owner', send(i, f1), 1])
rows.push(['  head == sha256(whole signed frame)', Number(read(i, 'head').equals(createHash('sha256').update(f1).digest())), 1]); const h1 = read(i, 'head')
const reb = sign(null, Buffer.concat([Buffer.from('AUKORA/R5/rebind'), u64(0), next.pub]), owner.priv)
rows.push(['rebind to a new key, signed by a stranger', send(i, Buffer.concat([h1, u64(2), Buffer.from([8]), next.pub, sign(null, Buffer.concat([Buffer.from('AUKORA/R5/rebind'), u64(0), next.pub]), stranger.priv)])), 0])
rows.push(['rebind to a new key, signed by the current owner', send(i, Buffer.concat([h1, u64(2), Buffer.from([8]), next.pub, reb])), 1]); const h2 = read(i, 'head')
const it2 = intent(Buffer.from('after rebind'), 2, 1)
rows.push(['grant after rebind, signed by the OLD key', send(i, grantFrame(h2, 3, it2, sigGrant(owner, it2))), 0])
rows.push(['grant after rebind, signed by the NEW key', send(i, grantFrame(h2, 3, it2, sigGrant(next, it2))), 1])
let all = true; for (const [k, got, want] of rows) { all &&= got === want; console.log(String(got), got === want ? 'ok  ' : 'FAIL', k) }
console.log(all ? 'ALL AS EXPECTED' : 'MISMATCH')
