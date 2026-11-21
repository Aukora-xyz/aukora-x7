// ARK proof v0.1, reader 1 (Node) core. Node built-ins only. TEST keys only.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const PAYLOAD_TYPE = 'application/vnd.aukora.ark.v0.1+json';
export const ZERO64 = '0'.repeat(64);
export const MAX_PAYLOAD = 65536;

export class ArkError extends Error {
  constructor(code, msg) { super(msg ? `${code}: ${msg}` : code); this.code = code; }
}
const fail = (code, msg) => { throw new ArkError(code, msg); };

// ---------- hashing, hex, base64url ----------
export const sha256 = (b) => crypto.createHash('sha256').update(b).digest();
export const sha256hex = (b) => sha256(b).toString('hex');

export function b64uEncode(buf) { return Buffer.from(buf).toString('base64url'); }
export function b64uDecodeStrict(s) {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_-]*$/.test(s) || s.length % 4 === 1) fail('BAD_ENCODING');
  const b = Buffer.from(s, 'base64url');
  if (b.toString('base64url') !== s) fail('BAD_ENCODING', 'non-canonical');
  return b;
}

// ---------- keys ----------
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
export function privFromSeed(seed) {
  return crypto.createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, seed]), format: 'der', type: 'pkcs8' });
}
export function pubFromRaw(raw) {
  return crypto.createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
}
export function rawPub(privKey) {
  const der = crypto.createPublicKey(privKey).export({ format: 'der', type: 'spki' });
  return der.subarray(der.length - 32);
}
export function newTestKey() {
  const seed = crypto.randomBytes(32);
  const priv = privFromSeed(seed);
  return { seed, priv, pubHex: rawPub(priv).toString('hex') };
}
export function loadKey(file) {
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  const priv = privFromSeed(Buffer.from(j.test_seed_hex, 'hex'));
  return { priv, pubHex: rawPub(priv).toString('hex') };
}
export function saveKey(file, key) {
  writeFileAtomic(file, JSON.stringify({ note: 'TEST KEY for the ARK proof only. Synthetic, never real.', test_seed_hex: key.seed.toString('hex') }) + '\n', 0o600);
}
export const keyid = (pubHex) => sha256hex(Buffer.from(pubHex, 'hex'));

// ---------- DSSE PAE ----------
export function pae(payloadType, payloadBytes) {
  const t = Buffer.from(payloadType, 'utf8');
  return Buffer.concat([Buffer.from(`DSSEv1 ${t.length} `), t, Buffer.from(` ${payloadBytes.length} `), payloadBytes]);
}

// ---------- strict JSON ----------
// Returns values with objects as null-prototype plain objects. Throws ArkError('BAD_JSON').
export function parseStrict(input, maxDepth = 8) {
  let s;
  if (typeof input === 'string') s = input;
  else {
    const buf = Buffer.from(input);
    if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) fail('BAD_JSON', 'BOM');
    try { s = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buf); } catch { fail('BAD_JSON', 'utf8'); }
  }
  let i = 0;
  const ws = () => { while (i < s.length && (s[i] === ' ' || s[i] === '\t' || s[i] === '\n' || s[i] === '\r')) i++; };
  const value = (depth) => {
    ws();
    const c = s[i];
    if (c === '{') return obj(depth + 1);
    if (c === '[') return arr(depth + 1);
    if (c === '"') return str();
    if (c === 't' && s.startsWith('true', i)) { i += 4; return true; }
    if (c === 'f' && s.startsWith('false', i)) { i += 5; return false; }
    if (c === 'n' && s.startsWith('null', i)) { i += 4; return null; }
    return num();
  };
  const obj = (depth) => {
    if (depth > maxDepth) fail('BAD_JSON', 'depth');
    i++; const o = Object.create(null); ws();
    if (s[i] === '}') { i++; return o; }
    for (;;) {
      ws(); if (s[i] !== '"') fail('BAD_JSON', 'key');
      const k = str();
      if (Object.prototype.hasOwnProperty.call(o, k)) fail('BAD_JSON', `duplicate key ${k}`);
      ws(); if (s[i] !== ':') fail('BAD_JSON', 'colon'); i++;
      o[k] = value(depth);
      ws();
      if (s[i] === ',') { i++; continue; }
      if (s[i] === '}') { i++; return o; }
      fail('BAD_JSON', 'object');
    }
  };
  const arr = (depth) => {
    if (depth > maxDepth) fail('BAD_JSON', 'depth');
    i++; const a = []; ws();
    if (s[i] === ']') { i++; return a; }
    for (;;) {
      a.push(value(depth)); ws();
      if (s[i] === ',') { i++; continue; }
      if (s[i] === ']') { i++; return a; }
      fail('BAD_JSON', 'array');
    }
  };
  const str = () => {
    i++; let out = '';
    for (;;) {
      if (i >= s.length) fail('BAD_JSON', 'unterminated');
      const c = s[i];
      const code = c.charCodeAt(0);
      if (c === '"') { i++; break; }
      if (code < 0x20) fail('BAD_JSON', 'control char');
      if (c === '\\') {
        const e = s[i + 1];
        const map = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
        if (e in map) { out += map[e]; i += 2; continue; }
        if (e === 'u') {
          const h = s.slice(i + 2, i + 6);
          if (!/^[0-9a-fA-F]{4}$/.test(h)) fail('BAD_JSON', 'escape');
          out += String.fromCharCode(parseInt(h, 16)); i += 6; continue;
        }
        fail('BAD_JSON', 'escape');
      }
      out += c; i++;
    }
    // lone surrogate check
    for (let k = 0; k < out.length; k++) {
      const u = out.charCodeAt(k);
      if (u >= 0xd800 && u <= 0xdbff) {
        const n = out.charCodeAt(k + 1);
        if (!(n >= 0xdc00 && n <= 0xdfff)) fail('BAD_JSON', 'lone surrogate');
        k++;
      } else if (u >= 0xdc00 && u <= 0xdfff) fail('BAD_JSON', 'lone surrogate');
    }
    return out;
  };
  const num = () => {
    const m = /^(0|[1-9][0-9]*)/.exec(s.slice(i, i + 40));
    if (!m) fail('BAD_JSON', 'value');
    const nx = s[i + m[0].length];
    if (nx === '.' || nx === 'e' || nx === 'E' || (nx >= '0' && nx <= '9')) fail('BAD_JSON', 'integers only');
    const v = Number(m[0]);
    if (!Number.isSafeInteger(v)) fail('BAD_JSON', 'integer too large');
    i += m[0].length; return v;
  };
  const v = value(0);
  ws();
  if (i !== s.length) fail('BAD_JSON', 'trailing');
  if (v === null || typeof v !== 'object' || Array.isArray(v)) fail('BAD_JSON', 'top level must be object');
  return v;
}

// ---------- schema ----------
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const re = (r) => (v) => typeof v === 'string' && r.test(v);
const ctrlFree = (v) => !/[\u0000-\u001f\u007f]/.test(v);
const utf8len = (v) => Buffer.byteLength(v, 'utf8');
export const P = {
  hex64: re(/^[0-9a-f]{64}$/), hex32: re(/^[0-9a-f]{32}$/), rid: re(/^[a-z0-9-]{1,64}$/),
  aname: re(/^[a-z_]{1,32}$/), res: re(/^[a-z0-9._/-]{1,128}$/), code: re(/^[A-Z_]{1,40}$/),
  int: (v) => Number.isSafeInteger(v) && v >= 0,
  line: (v) => typeof v === 'string' && utf8len(v) >= 1 && utf8len(v) <= 200 && ctrlFree(v),
  ntext: (v) => typeof v === 'string' && utf8len(v) >= 1 && utf8len(v) <= 1000 && ctrlFree(v),
  str: (max) => (v) => typeof v === 'string' && utf8len(v) >= 1 && utf8len(v) <= max,
  lit: (x) => (v) => v === x, oneOf: (...xs) => (v) => xs.includes(v),
  orNull: (f) => (v) => v === null || f(v),
  shape: (spec) => (v) => checkShape(v, spec),
};
export function checkShape(v, spec) {
  if (!isObj(v)) return false;
  const keys = Object.keys(v); const want = Object.keys(spec);
  if (keys.length !== want.length) return false;
  for (const k of want) if (!Object.prototype.hasOwnProperty.call(v, k) || !spec[k](v[k])) return false;
  return true;
}
const base = (t) => ({ v: P.lit('0.1'), type: P.lit(t) });
export const SCHEMAS = {
  grant: { ...base('grant'), grant_id: P.hex32, owner_key: P.hex64, client_key: P.hex64, receiver_id: P.rid,
    scope: P.shape({ action: P.aname, resource: P.res }), not_after: P.int },
  authority: { ...base('authority'), owner_key: P.hex64, receiver_id: P.rid, epoch: (v) => P.int(v) && v >= 1,
    grants: (v) => Array.isArray(v) && v.length <= 64 && v.every(P.hex64) && new Set(v).size === v.length },
  proposal: { ...base('proposal'), op_id: P.hex32, grant: P.hex64,
    action: P.shape({ name: P.aname, resource: P.res, text: P.line }), created_at: P.int },
  approval: { ...base('approval'), proposal: P.hex64, receiver_id: P.rid, epoch: (v) => P.int(v) && v >= 1,
    decision: P.oneOf('approve', 'refuse'), not_after: P.int },
  outcome: { ...base('outcome'), receiver_id: P.rid, op_id: P.hex32, proposal: P.hex64, approval: P.orNull(P.hex64),
    epoch: P.int, status: P.oneOf('DONE', 'REFUSED'), reason: P.code,
    effect: P.orNull(P.shape({ resource: P.res, before_sha256: P.hex64, after_sha256: P.hex64 })),
    seq: (v) => P.int(v) && v >= 1, prev: P.hex64, at: P.int },
  note: { ...base('note'), about: P.hex64, label: P.oneOf('assessment', 'summary'), grants: P.lit('none'), text: P.ntext },
};
export function checkPayloadSchema(obj) {
  if (!isObj(obj) || typeof obj.type !== 'string' || !Object.prototype.hasOwnProperty.call(SCHEMAS, obj.type)) fail('BAD_SCHEMA', 'type');
  if (!checkShape(obj, SCHEMAS[obj.type])) fail('BAD_SCHEMA', obj.type);
  return obj;
}

// ---------- envelopes ----------
// Returns { env, payloadBytes, obj, hash, keyid, sigBytes } or throws ArkError with the E1..E5 code.
export function openEnvelope(env) {
  if (!checkShape(env, { payloadType: (v) => typeof v === 'string', payload: (v) => typeof v === 'string',
    signatures: (v) => Array.isArray(v) && v.length === 1 && checkShape(v[0], { keyid: P.hex64, sig: (x) => typeof x === 'string' }) }))
    fail('BAD_ENVELOPE');
  if (env.payloadType !== PAYLOAD_TYPE) fail('BAD_PAYLOAD_TYPE');
  const payloadBytes = b64uDecodeStrict(env.payload);
  const sigBytes = b64uDecodeStrict(env.signatures[0].sig);
  if (sigBytes.length !== 64) fail('BAD_ENCODING', 'sig length');
  if (payloadBytes.length > MAX_PAYLOAD) fail('BAD_SCHEMA', 'payload too large');
  const obj = parseStrict(payloadBytes);
  checkPayloadSchema(obj);
  return { env, payloadBytes, obj, type: obj.type, hash: sha256hex(payloadBytes), keyid: env.signatures[0].keyid, sigBytes };
}
export function verifySig(opened, pubHex) {
  return crypto.verify(null, pae(PAYLOAD_TYPE, opened.payloadBytes), pubFromRaw(Buffer.from(pubHex, 'hex')), opened.sigBytes);
}
export function sealPayloadBytes(payloadBytes, key) {
  const sig = crypto.sign(null, pae(PAYLOAD_TYPE, payloadBytes), key.priv);
  return { payloadType: PAYLOAD_TYPE, payload: b64uEncode(payloadBytes), signatures: [{ keyid: keyid(key.pubHex), sig: b64uEncode(sig) }] };
}
export function seal(obj, key) {
  checkPayloadSchema(parseStrict(JSON.stringify(obj)));
  return sealPayloadBytes(Buffer.from(JSON.stringify(obj), 'utf8'), key);
}
export const envJson = (env) => JSON.stringify(env);
export const itemHash = (env) => sha256hex(b64uDecodeStrict(env.payload));

// ---------- files ----------
export function writeFileAtomic(file, data, mode = 0o644) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  const fd = fs.openSync(tmp, 'w', mode);
  try { fs.writeSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
}
export function readEnvFile(file) {
  return parseStrict(fs.readFileSync(file));
}
export const nowMs = () => Date.now();
export function parseTime(t) {
  if (/^[+-]\d+$/.test(t)) return Date.now() + Number(t);
  if (/^\d+$/.test(t)) return Number(t);
  throw new ArkError('USAGE', `bad time ${t}`);
}
export const randHex = (n) => crypto.randomBytes(n).toString('hex');

// ---------- tiny argv parser ----------
export function parseArgs(argv, multi = []) {
  const flags = Object.create(null); const pos = [];
  for (let k = 0; k < argv.length; k++) {
    const a = argv[k];
    if (a.startsWith('--')) {
      const name = a.slice(2);
      const boolFlags = ['yes'];
      let val = true;
      if (!boolFlags.includes(name)) { val = argv[++k]; if (val === undefined) throw new ArkError('USAGE', `--${name} needs a value`); }
      if (multi.includes(name)) (flags[name] ||= []).push(val); else flags[name] = val;
    } else pos.push(a);
  }
  return { flags, pos };
}
export function need(flags, name) {
  if (flags[name] === undefined) throw new ArkError('USAGE', `missing --${name}`);
  return flags[name];
}
export const EXIT = { OK: 0, REFUSED: 1, USAGE: 2, UNKNOWN: 3, REJECTED: 4 };
export function runMain(fn) {
  Promise.resolve().then(fn).then((code) => process.exit(code ?? 0)).catch((e) => {
    process.stderr.write(`error: ${e.message}\n`);
    process.exit(EXIT.USAGE);
  });
}
