import assert from 'node:assert/strict';
import {createHash, createPublicKey, generateKeyPairSync, randomBytes, sign, verify} from 'node:crypto';
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {performance} from 'node:perf_hooks';

const dir = process.argv[3] ?? 'logs/r8/build/vectors';
const hash = data => createHash('sha256').update(data).digest('hex');
const cat = (...parts) => Buffer.concat(parts);
const spkiPrefix = Buffer.from('308207b2300b0609608648016503040312038207a100', 'hex');
const lengths = [0, 1, 2, 7, 31, 32, 63, 64, 69, 70, 71, 135, 136, 137, 167, 168, 169, 270, 271, 272, 1024, 4096];
function rawPublic(key) {
  const der = key.export({format: 'der', type: 'spki'});
  assert.deepEqual(der.subarray(0, spkiPrefix.length), spkiPrefix);
  assert.equal(der.length, spkiPrefix.length + 1952);
  return der.subarray(spkiPrefix.length);
}
function flip(bytes, offset, bit) {
  assert.ok(offset < bytes.length);
  const copy = Buffer.from(bytes);
  copy[offset] ^= 1 << bit;
  return copy;
}

function generate() {
  mkdirSync(dir, {recursive: true});
  const rows = [], keys = new Set();
  const empty = Buffer.alloc(0), context = Buffer.from('round-eight');
  function add(label, expected, key, msg, sig) {
    // OpenSSL may refuse malformed signature lengths either by returning false or by throwing.
    let oracle = false;
    if (key.length === 1952) {
      const publicKey = createPublicKey({type: 'spki', format: 'der', key: cat(spkiPrefix, key)});
      try { oracle = verify(null, msg, publicKey, sig); }
      catch (err) {
        if (sig.length === 3309) throw err;
      }
    }
    assert.equal(oracle, expected, label + ' oracle');
    const files = [key, msg, sig].map(bytes => {
      const name = hash(bytes) + '.bin';
      writeFileSync(dir + '/' + name, bytes);
      return name;
    });
    rows.push([label, Number(expected), ...files].join('\t'));
  }

  for (const [i, length] of lengths.entries()) {
    const {publicKey, privateKey} = generateKeyPairSync('ml-dsa-65');
    const key = rawPublic(publicKey), msg = randomBytes(length);
    keys.add(hash(key));
    const sig = sign(null, msg, privateKey);
    assert.equal(sig.length, 3309);
    assert.equal(verify(null, msg, {key: publicKey, context: empty}, sig), true);
    assert.equal(verify(null, msg, {key: publicKey, context}, sig), false);
    add('valid-' + length, true, key, msg, sig);
    add('signature-bit-' + length, false, key, msg, flip(sig, (i * 191) % sig.length, i % 8));
    if (length) add('message-bit-' + length, false, key, flip(msg, (i * 13) % length, i % 8), sig);
    add('public-key-bit-' + length, false, flip(key, (i * 251) % key.length, i % 8), msg, sig);
    if (length !== 32) continue;

    const ctxSig = sign(null, msg, {key: privateKey, context});
    assert.equal(verify(null, msg, {key: publicKey, context}, ctxSig), true);
    add('valid-under-nonempty-context-only', false, key, msg, ctxSig);
    add('explicit-empty-context', true, key, msg, sign(null, msg, {key: privateKey, context: empty}));
    add('short-sig', false, key, msg, sig.subarray(0, -1));
    add('long-sig', false, key, msg, cat(sig, Buffer.of(0)));
    add('short-key', false, key.subarray(0, -1), msg, sig);
    add('long-key', false, cat(key, Buffer.of(0)), msg, sig);
    add('short-message', false, key, msg.subarray(0, -1), sig);
    add('long-message', false, key, cat(msg, Buffer.of(0)), sig);

    // FIPS 204: 48 challenge bytes, 5*640 z bytes, 55 hint indices, 6 end offsets.
    function hintCase(label, indices, ends) {
      const changed = Buffer.from(sig);
      changed.fill(0, 3248);
      changed.set(indices, 3248);
      changed.set(ends, 3303);
      add(label, false, key, msg, changed);
    }
    hintCase('hint-count-exceeds-55', [], [56,56,56,56,56,56]);
    hintCase('hint-count-decreases', [1,2], [2,1,2,2,2,2]);
    hintCase('hint-duplicate-index', [7,7], [2,2,2,2,2,2]);
    hintCase('hint-unordered-index', [8,7], [2,2,2,2,2,2]);
    hintCase('hint-nonzero-padding', [0,1], [1,1,1,1,1,1]);

    // Preserve the actual hint set of a valid signature. A decoder ignoring
    // canonical encoding would reconstruct exactly the signed polynomial.
    let source = sig;
    for (;;) {
      const ends = [...source.subarray(3303)];
      const row = ends.findIndex((end, j) => end - (j === 0 ? 0 : ends[j-1]) >= 2);
      const used = ends[5];
      if (used < 55 && row >= 0) {
        const start = row === 0 ? 0 : ends[row-1];
        const permuted = Buffer.from(source);
        const ix = 3248 + start;
        [permuted[ix], permuted[ix+1]] = [permuted[ix+1], permuted[ix]];
        add('same-hint-set-unordered', false, key, msg, permuted);
        const padding = Buffer.from(source);
        padding[3248+used] = 1;
        add('same-hint-set-nonzero-padding', false, key, msg, padding);
        const duplicate = Buffer.from(source);
        source.copy(duplicate, ix+1, ix, 3248+used);
        for (let j = row; j < 6; j++) duplicate[3303+j]++;
        add('same-hint-set-duplicate', false, key, msg, duplicate);
        break;
      }
      source = sign(null, msg, privateKey);
    }
    for (const z of [524092, -524092, 524093, -524093]) {
      const changed = Buffer.from(sig), packed = 524288 - z;
      changed[48] = packed & 255;
      changed[49] = (packed >>> 8) & 255;
      changed[50] = (changed[50] & 0xf0) | (packed >>> 16);
      add('z-norm-' + z, false, key, msg, changed);
    }
    add('challenge-last-byte', false, key, msg, flip(sig, 47, 7));
  }
  assert.equal(keys.size, lengths.length);
  const index = rows.join('\n') + '\n';
  writeFileSync(dir + '/index.tsv', index);
  console.log('Node', process.version, 'OpenSSL', process.versions.openssl, 'ml-dsa-65 stateless default');
  console.log('Default signatures verified with explicit empty context; nonempty context refused them. A nonempty-context signature verified with its own context only.');
  console.log(keys.size, 'distinct fresh key pairs, message lengths', lengths.join(', '));
  console.log(rows.length, 'cases; SHA-256 of index containing all public vector hashes', hash(index));
}

function wasmChecks() {
  const index = readFileSync(dir + '/index.tsv', 'utf8');
  const cases = index.trimEnd().split('\n').map(row => row.split('\t'));
  const mod = new WebAssembly.Module(readFileSync('core/Mldsa8.wasm'));
  assert.deepEqual(WebAssembly.Module.imports(mod), []);
  assert.deepEqual(WebAssembly.Module.exports(mod).map(e => [e.name, e.kind]).sort(),
    ['clear','input','verify'].map(n => [n,'function']).sort());
  const api = new WebAssembly.Instance(mod).exports;
  function preload(api, row) {
    api.clear();
    for (const [field, name] of row.slice(2).entries()) {
      const bytes = readFileSync(dir + '/' + name);
      assert.equal(name, hash(bytes) + '.bin');
      for (const b of bytes) assert.equal(api.input(field, b), 1);
    }
  }
  // First verification on the first instantiated module, before any other Wasm call to verify.
  const timingCase = cases.find(row => row[0] === 'valid-32');
  preload(api, timingCase);
  function measure() {
    const t = performance.now();
    const ok = api.verify();
    const elapsed = performance.now() - t;
    assert.equal(ok, 1, timingCase[0]);
    return elapsed;
  }
  const cold = measure();
  for (let i = 0; i < 5; ++i) measure();
  const times = Array.from({length: 11}, measure).sort((a,b) => a-b);
  console.log('32-byte message, first verification on fresh instance', cold.toFixed(3), 'ms; warm median',
    times[5].toFixed(3), 'ms; 11 samples, min..max', times[0].toFixed(3), times[10].toFixed(3),
    '(includes first-call runtime startup and per-call internal copies, excludes module compilation, instantiation and JS byte transfer)');
  let accepted = 0;
  for (const row of cases) {
    preload(api, row);
    const ok = api.verify();
    assert.equal(ok, Number(row[1]), row[0]);
    accepted += ok;
  }
  console.log('PASS Wasm', cases.length, 'vectors:', accepted, 'accepted,', cases.length - accepted, 'refused; index SHA-256', hash(index));
}

if (process.argv[2] === 'generate') generate();
else if (process.argv[2] === 'wasm') wasmChecks();
else throw Error('Expected generate or wasm');
