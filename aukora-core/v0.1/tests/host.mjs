import assert from 'node:assert/strict';
import {createHash, generateKeyPairSync, sign, verify} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {performance} from 'node:perf_hooks';

const cat = (...xs) => Buffer.concat(xs);
const sha = bytes => createHash('sha256').update(bytes).digest();
const u16 = n => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const u64 = n => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const blob = b => cat(u16(b.length), b);
const text = s => blob(Buffer.from(s));
function owner() {
  const ed = generateKeyPairSync('ed25519'), ml = generateKeyPairSync('ml-dsa-65');
  const raw = (kp, width) => kp.publicKey.export({format: 'der', type: 'spki'}).subarray(-width);
  return {ed, ml, edRaw: raw(ed,32), mlRaw: raw(ml,1952)};
}
const keyFields = k => cat(blob(k.edRaw), blob(k.mlRaw));
const domain = (role, k) => cat(text('AUKORA/R7/hybrid/' + role), keyFields(k));
const install = (digest, gen, nonce) => cat(Buffer.of(1), digest, text('core'), u16(gen), u16(nonce));
const deliver = (body, gen, nonce) => cat(Buffer.of(0), blob(body), text('service'), u16(gen), u16(nonce));

function host(bytes = readFileSync('v0.1/aukora-core.wasm')) {
  const mod = new WebAssembly.Module(bytes);
  assert.deepEqual(WebAssembly.Module.imports(mod), []);
  const api = new WebAssembly.Instance(mod).exports;
  let head = Buffer.alloc(32), installed = Buffer.alloc(32), seq = 1;
  const header = () => cat(head, u64(seq));
  function load(bytes) { for (const b of bytes) assert.equal(api.input(b), 1); }
  function consume(bytes, name) { load(bytes); return api[name](); }
  function digest(f) {
    assert.equal(f(32), 256);
    return Buffer.from(Array.from({length: 32}, (_, i) => {
      const b = f(i);
      assert.ok(b >= 0 && b < 256);
      return b;
    }));
  }
  function submit(label, packed, expected, nextCore = installed) {
    load(packed);
    const t = performance.now();
    const verdict = api.step();
    const ms = performance.now() - t;
    assert.equal(verdict, Number(expected), label);
    if (expected) { head = sha(packed); seq++; installed = nextCore; }
    assert.deepEqual(digest(api.head), head, label + ' head');
    assert.deepEqual(digest(api.core), installed, label + ' installed core');
    console.log(expected ? 'ACCEPT' : 'REFUSE', label);
    return ms;
  }
  function stage(bytes) {
    assert.equal(api.reset(), 1);
    for (let i = 0; i < bytes.length; i += 8192)
      assert.equal(consume(bytes.subarray(i, i+8192), 'feed'), 1);
  }
  const unsigned = body => cat(Buffer.of(0), header(), body);
  function grant(active, intent, goodEd = true, goodMl = true, signer = active) {
    const msg = cat(domain('grant', active), intent);
    const {edSig, mlSig} = dual(signer, msg, goodEd, goodMl);
    return cat(Buffer.of(19), mlSig, header(), Buffer.of(3), intent, edSig);
  }
  function rebind(active, next, gen, goodEd = true, goodMl = true) {
    const msg = cat(domain('rebind', active), u64(gen), keyFields(next));
    const {edSig, mlSig} = dual(active, msg, goodEd, goodMl);
    return cat(Buffer.of(20), next.mlRaw, mlSig, header(), Buffer.of(8), next.edRaw, edSig);
  }
  function control(active, action, gen, goodEd = true, goodMl = true) {
    const msg = cat(domain('control', active), Buffer.from('AUKORA/R5/control'), u64(gen), header(), action);
    const {edSig, mlSig} = dual(active, msg, goodEd, goodMl);
    return cat(Buffer.of(19), mlSig, header(), action, edSig);
  }
  return {header, load, api, submit, stage, consume, historyLength: () => seq-1, unsigned, grant, rebind, control};
}

// Use genuine signatures of a different message to invalidate just one algorithm.
// OpenSSL independently verifies both components' intended status before submission.
function dual(k, msg, goodEd = true, goodMl = true) {
  const other = cat(msg, Buffer.of(1));
  const edSig = sign(null, goodEd ? msg : other, k.ed.privateKey);
  const mlSig = sign(null, goodMl ? msg : other, k.ml.privateKey);
  assert.equal(verify(null, msg, k.ed.publicKey, edSig), goodEd);
  assert.equal(verify(null, msg, k.ml.publicKey, mlSig), goodMl);
  return {edSig, mlSig};
}
// The host fixes a single evidence commitment with five length-delimited binary fields.
// The core receives the 32-byte digest, never the private reasoning/evidence materials.
function evidence(intent, observed, summary, verdict, versions) {
  const fields = [intent, Buffer.from(observed), Buffer.from(summary), Buffer.from(verdict), Buffer.from(versions)];
  return sha(cat(...fields.map(bytes => cat(u32(bytes.length), bytes))));
}

export {cat, sha, evidence, u16, u32, u64, blob, text, owner, keyFields, domain, install, deliver, dual, host};
