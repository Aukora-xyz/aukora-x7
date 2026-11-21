// ARK proof v0.1 receiver (reader 1 (Node)). Its own process, own TEST key, own state. Files only, no sockets.
import fs from 'node:fs';
import path from 'node:path';
import {
  ArkError, EXIT, ZERO64, parseStrict, checkShape, P, openEnvelope, verifySig, seal, keyid, sha256hex,
  writeFileAtomic, newTestKey, saveKey, loadKey, parseArgs, need, runMain, nowMs,
} from './lib/core.mjs';
import { REQ_ID } from './lib/wire.mjs';

const ACTION = 'append_line';
const RESOURCE = 'notes/demo.txt';

// ---------- home ----------
function openHome(home) {
  const cfgFile = path.join(home, 'config.json');
  if (!fs.existsSync(cfgFile)) throw new ArkError('USAGE', `no receiver at ${home}`);
  const cfg = parseStrict(fs.readFileSync(cfgFile));
  const key = loadKey(path.join(home, 'key.json'));
  const st = (...p) => path.join(home, 'state', ...p);
  return { home, cfg, key, st };
}

// ---------- lock ----------
const sab = new Int32Array(new SharedArrayBuffer(4));
const sleepSync = (ms) => Atomics.wait(sab, 0, 0, ms);
function alive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }
function withLock(H, fn) {
  const dir = path.join(H.home, 'lock');
  const deadline = Date.now() + 60000;
  for (;;) {
    try { fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, 'pid'), String(process.pid)); break; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let pid = 0; try { pid = Number(fs.readFileSync(path.join(dir, 'pid'), 'utf8')); } catch {}
      if (pid && !alive(pid)) { fs.rmSync(dir, { recursive: true, force: true }); continue; }
      if (!pid) { // pid file not written yet, or lost: break only if the lock dir is old
        try { if (Date.now() - fs.statSync(dir).mtimeMs > 5000) { fs.rmSync(dir, { recursive: true, force: true }); continue; } } catch {}
      }
      if (Date.now() > deadline) throw new ArkError('USAGE', 'lock timeout');
      sleepSync(20);
    }
  }
  try { return fn(); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// ---------- state helpers ----------
const readJsonIf = (f) => (fs.existsSync(f) ? parseStrict(fs.readFileSync(f)) : null);
function currentAuthority(H) {
  const env = readJsonIf(H.st('authority.env.json'));
  return env ? openEnvelope(env) : null;
}
const restoreInfo = (H) => readJsonIf(H.st('restore.json'));
function chainHead(H) {
  const dir = H.st('outcomes');
  let best = 0;
  if (fs.existsSync(dir)) for (const f of fs.readdirSync(dir)) { const m = /^(\d+)\.env\.json$/.exec(f); if (m) best = Math.max(best, Number(m[1])); }
  if (!best) return { seq: 0, hash: ZERO64 };
  return { seq: best, hash: openEnvelope(parseStrict(fs.readFileSync(path.join(dir, `${best}.env.json`)))).hash };
}
const opFile = (H, op, name) => H.st('ops', op, `${name}.env.json`);
function storedOutcome(H, op) {
  const f = opFile(H, op, 'outcome');
  return fs.existsSync(f) ? parseStrict(fs.readFileSync(f)) : null;
}
function authorityAt(H, epoch) { return readJsonIf(H.st('history', `authority-${epoch}.env.json`)); }

function commitOutcome(H, fields) {
  const head = chainHead(H);
  const obj = {
    v: '0.1', type: 'outcome', receiver_id: H.cfg.receiver_id, op_id: fields.op_id, proposal: fields.proposal,
    approval: fields.approval, epoch: fields.epoch, status: fields.status, reason: fields.reason, effect: fields.effect,
    seq: head.seq + 1, prev: head.hash, at: fields.at,
  };
  const env = seal(obj, H.key);
  // single commit point: the numbered outcome file
  writeFileAtomic(H.st('outcomes', `${obj.seq}.env.json`), JSON.stringify(env));
  writeFileAtomic(opFile(H, obj.op_id, 'outcome'), JSON.stringify(env));
  return env;
}

// ---------- effect ----------
const effectPath = (H) => path.join(H.cfg.effect_root, RESOURCE);
function effectHasOp(H, op) {
  const f = effectPath(H);
  if (!fs.existsSync(f)) return false;
  return fs.readFileSync(f, 'utf8').split('\n').some((l) => l.startsWith(`${op} `));
}
function appendDurable(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file, 'a');
  try { fs.writeSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

// ---------- recovery (R5) ----------
function recover(H) {
  const odir = H.st('outcomes');
  if (fs.existsSync(odir)) for (const f of fs.readdirSync(odir)) {
    if (!/^\d+\.env\.json$/.test(f)) continue;
    const env = parseStrict(fs.readFileSync(path.join(odir, f)));
    const o = openEnvelope(env).obj;
    if (!fs.existsSync(opFile(H, o.op_id, 'outcome'))) writeFileAtomic(opFile(H, o.op_id, 'outcome'), JSON.stringify(env));
  }
  const idir = H.st('intents');
  if (!fs.existsSync(idir)) return;
  for (const f of fs.readdirSync(idir)) {
    if (!f.endsWith('.json')) continue;
    const ifile = path.join(idir, f);
    const it = parseStrict(fs.readFileSync(ifile));
    if (!storedOutcome(H, it.op_id) && effectHasOp(H, it.op_id)) {
      commitOutcome(H, { op_id: it.op_id, proposal: it.proposal, approval: it.approval, epoch: it.epoch, status: 'DONE',
        reason: 'OK', effect: { resource: RESOURCE, before_sha256: it.before_sha256, after_sha256: it.after_sha256 }, at: it.at });
    }
    fs.rmSync(ifile, { force: true });
  }
}

// ---------- handlers ----------
const answer = (kind, status, reason, outcome = null, authority = null) => ({ kind, status, reason, outcome, authority });
const isEnvLike = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function ownerSigned(H, env, type) {
  let o; try { o = openEnvelope(env); } catch { return null; }
  if (o.type !== type || o.keyid !== keyid(H.cfg.owner_key) || !verifySig(o, H.cfg.owner_key)) return null;
  return o;
}

function handleSubmit(H, req, fault) {
  if (!checkShape(req, { v: P.lit('0.1'), kind: P.lit('submit'), grant: isEnvLike, proposal: isEnvLike,
    approval: (v) => v === null || isEnvLike(v), notes: Array.isArray })) return answer('submit', 'REJECTED', 'BAD_REQUEST');
  // R1: grant must be signed by the pinned owner
  const g = ownerSigned(H, req.grant, 'grant');
  if (!g || g.obj.owner_key !== H.cfg.owner_key) return answer('submit', 'REJECTED', 'BAD_GRANT');
  let p; try { p = openEnvelope(req.proposal); } catch { return answer('submit', 'REJECTED', 'BAD_PROPOSAL'); }
  if (p.type !== 'proposal') return answer('submit', 'REJECTED', 'BAD_PROPOSAL');
  // client key comes from the grant, never from the request
  if (p.keyid !== keyid(g.obj.client_key) || !verifySig(p, g.obj.client_key)) return answer('submit', 'REJECTED', 'WRONG_CLIENT');
  if (p.obj.grant !== g.hash) return answer('submit', 'REJECTED', 'GRANT_HASH_MISMATCH');
  const op = p.obj.op_id;
  // R4: first outcome is final
  const stored = storedOutcome(H, op);
  if (stored) {
    const so = openEnvelope(stored).obj;
    if (so.proposal !== p.hash) return answer('submit', 'REJECTED', 'OP_ID_REUSED');
    return answer('submit', so.status, so.reason, stored, authorityAt(H, so.epoch));
  }
  writeFileAtomic(opFile(H, op, 'grant'), JSON.stringify(req.grant));
  writeFileAtomic(opFile(H, op, 'proposal'), JSON.stringify(req.proposal));
  // notes are carried but never read (R: a note grants nothing)

  const at = nowMs();
  const auth = currentAuthority(H);
  const epoch = auth ? auth.obj.epoch : 0;
  const a = req.approval ? ownerSigned(H, req.approval, 'approval') : null;
  const refuse = (reason) => {
    if (a) writeFileAtomic(opFile(H, op, 'approval'), JSON.stringify(req.approval));
    const env = commitOutcome(H, { op_id: op, proposal: p.hash, approval: a ? a.hash : null, epoch, status: 'REFUSED', reason, effect: null, at });
    return answer('submit', 'REFUSED', reason, env, authorityAt(H, epoch));
  };
  if (restoreInfo(H)) return refuse('LOCKED_AFTER_RESTORE');
  if (!auth) return refuse('NO_AUTHORITY');
  if (!auth.obj.grants.includes(g.hash)) return refuse('GRANT_NOT_IN_AUTHORITY');
  if (g.obj.receiver_id !== H.cfg.receiver_id) return refuse('WRONG_RECEIVER');
  if (at > g.obj.not_after) return refuse('GRANT_EXPIRED');
  if (g.obj.scope.action !== p.obj.action.name || g.obj.scope.resource !== p.obj.action.resource) return refuse('SCOPE_MISMATCH');
  if (p.obj.action.name !== ACTION || p.obj.action.resource !== RESOURCE) return refuse('UNSUPPORTED_ACTION');
  if (!req.approval) return refuse('NO_APPROVAL');
  if (!a) return refuse('BAD_APPROVAL');
  if (a.obj.decision !== 'approve') return refuse('OWNER_REFUSED');
  if (a.obj.proposal !== p.hash) return refuse('APPROVAL_MISMATCH');
  if (a.obj.receiver_id !== H.cfg.receiver_id) return refuse('WRONG_RECEIVER');
  if (a.obj.epoch !== epoch) return refuse('STALE_EPOCH');
  if (at > a.obj.not_after) return refuse('APPROVAL_EXPIRED');

  // R5: intent before effect
  const file = effectPath(H);
  const before = fs.existsSync(file) ? fs.readFileSync(file) : Buffer.alloc(0);
  const line = Buffer.from(`${op} ${p.obj.action.text}\n`, 'utf8');
  const intent = { op_id: op, proposal: p.hash, approval: a.hash, epoch, at,
    before_sha256: sha256hex(before), after_sha256: sha256hex(Buffer.concat([before, line])) };
  writeFileAtomic(opFile(H, op, 'approval'), JSON.stringify(req.approval));
  writeFileAtomic(H.st('intents', `${op}.json`), JSON.stringify(intent));
  appendDurable(file, line);
  if (fault === 'die-after-effect') process.kill(process.pid, 'SIGKILL');
  const env = commitOutcome(H, { op_id: op, proposal: p.hash, approval: a.hash, epoch, status: 'DONE', reason: 'OK',
    effect: { resource: RESOURCE, before_sha256: intent.before_sha256, after_sha256: intent.after_sha256 }, at });
  fs.rmSync(H.st('intents', `${op}.json`), { force: true });
  return answer('submit', 'DONE', 'OK', env, authorityAt(H, epoch));
}

function handleAuthority(H, req) {
  if (!checkShape(req, { v: P.lit('0.1'), kind: P.lit('authority'), authority: isEnvLike })) return answer('authority', 'REJECTED', 'BAD_REQUEST');
  const cur = currentAuthority(H);
  const curEnv = cur ? cur.env : null;
  const o = ownerSigned(H, req.authority, 'authority');
  if (!o || o.obj.owner_key !== H.cfg.owner_key || o.obj.receiver_id !== H.cfg.receiver_id) return answer('authority', 'REJECTED', 'BAD_AUTHORITY', null, curEnv);
  const ri = restoreInfo(H);
  const floor = Math.max(cur ? cur.obj.epoch : 0, ri ? ri.floor : 0);
  if (o.obj.epoch <= floor) return answer('authority', 'REJECTED', 'STALE_AUTHORITY', null, curEnv);
  writeFileAtomic(H.st('history', `authority-${o.obj.epoch}.env.json`), JSON.stringify(req.authority));
  writeFileAtomic(H.st('authority.env.json'), JSON.stringify(req.authority));
  fs.rmSync(H.st('restore.json'), { force: true });
  return answer('authority', 'ACCEPTED', 'OK', null, req.authority);
}

function handleStatus(H, req) {
  if (!checkShape(req, { v: P.lit('0.1'), kind: P.lit('status'), op_id: P.hex32 })) return answer('status', 'REJECTED', 'BAD_REQUEST');
  const s = storedOutcome(H, req.op_id);
  if (!s) return answer('status', 'UNKNOWN', 'NO_OUTCOME');
  const so = openEnvelope(s).obj;
  return answer('status', so.status, so.reason, s, authorityAt(H, so.epoch));
}

function handle(H, raw, fault) {
  let req;
  try { req = parseStrict(raw); } catch { return answer('error', 'REJECTED', 'BAD_REQUEST'); }
  if (req.kind === 'submit') return handleSubmit(H, req, fault);
  if (req.kind === 'authority') return handleAuthority(H, req);
  if (req.kind === 'status') return handleStatus(H, req);
  return answer('error', 'REJECTED', 'BAD_REQUEST');
}

function runOnce(H, fault) {
  return withLock(H, () => {
    recover(H);
    const inbox = path.join(H.home, 'inbox');
    if (!fs.existsSync(inbox)) return 0;
    let n = 0;
    for (const f of fs.readdirSync(inbox).sort()) {
      const m = /^(.+)\.req\.json$/.exec(f);
      if (!m) continue;
      const reqFile = path.join(inbox, f);
      if (!REQ_ID.test(m[1])) { fs.rmSync(reqFile, { force: true }); continue; }
      if (fault === 'drop-request') { fs.rmSync(reqFile, { force: true }); continue; }
      const ans = handle(H, fs.readFileSync(reqFile), fault);
      const full = { v: '0.1', kind: ans.kind, request_id: m[1], status: ans.status, reason: ans.reason, outcome: ans.outcome, authority: ans.authority };
      if (fault !== 'drop-answer') writeFileAtomic(path.join(H.home, 'outbox', `${m[1]}.ans.json`), JSON.stringify(full));
      fs.rmSync(reqFile, { force: true });
      n++;
    }
    return n;
  });
}

// ---------- archive / restore ----------
function collectItems(H) {
  const seen = new Map();
  const add = (env) => { const k = JSON.stringify(env); if (!seen.has(k)) seen.set(k, env); };
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const f of fs.readdirSync(dir).sort()) {
      const p = path.join(dir, f);
      if (fs.statSync(p).isDirectory()) walk(p);
      else if (f.endsWith('.env.json')) add(parseStrict(fs.readFileSync(p)));
    }
  };
  walk(H.st('history')); walk(H.st('ops'));
  return [...seen.values()];
}

function restore(H, dir) {
  const sdir = H.st();
  if (fs.existsSync(sdir) && fs.readdirSync(sdir).length) throw new ArkError('USAGE', 'state is not empty; wipe <home>/state first');
  const b = parseStrict(fs.readFileSync(path.join(dir, 'archive.bundle.json')));
  if (!checkShape(b, { v: P.lit('0.1'), coverage: (v) => typeof v === 'string', items: Array.isArray })) throw new ArkError('USAGE', 'bad archive');
  const opened = [];
  for (const env of b.items) { try { opened.push(openEnvelope(env)); } catch {} }
  const byHash = new Map(opened.map((o) => [`${o.type}:${o.hash}`, o]));
  let floor = 0; let n = 0; const seqs = new Map();
  for (const o of opened) {
    if (o.type === 'authority' && o.keyid === keyid(H.cfg.owner_key) && verifySig(o, H.cfg.owner_key)) {
      floor = Math.max(floor, o.obj.epoch);
      // record only; never installed as current authority (R7)
      writeFileAtomic(H.st('history', `authority-${o.obj.epoch}.env.json`), JSON.stringify(o.env));
    }
  }
  for (const o of opened) {
    if (o.type !== 'outcome' || o.keyid !== keyid(H.key.pubHex) || !verifySig(o, H.key.pubHex) || o.obj.receiver_id !== H.cfg.receiver_id) continue;
    const prevSeq = seqs.get(o.obj.seq);
    if (prevSeq && prevSeq !== o.hash) throw new ArkError('USAGE', `two outcomes with seq ${o.obj.seq}`);
    seqs.set(o.obj.seq, o.hash);
    floor = Math.max(floor, o.obj.epoch);
    writeFileAtomic(H.st('outcomes', `${o.obj.seq}.env.json`), JSON.stringify(o.env));
    writeFileAtomic(opFile(H, o.obj.op_id, 'outcome'), JSON.stringify(o.env));
    const pr = byHash.get(`proposal:${o.obj.proposal}`);
    if (pr) {
      writeFileAtomic(opFile(H, o.obj.op_id, 'proposal'), JSON.stringify(pr.env));
      const gr = byHash.get(`grant:${pr.obj.grant}`);
      if (gr) writeFileAtomic(opFile(H, o.obj.op_id, 'grant'), JSON.stringify(gr.env));
    }
    const ap = o.obj.approval && byHash.get(`approval:${o.obj.approval}`);
    if (ap) writeFileAtomic(opFile(H, o.obj.op_id, 'approval'), JSON.stringify(ap.env));
    n++;
  }
  writeFileAtomic(H.st('restore.json'), JSON.stringify({ locked: true, floor }));
  return { n, floor };
}

// ---------- CLI ----------
runMain(async () => {
  const [cmd, ...rest] = process.argv.slice(2);
  const { flags, pos } = parseArgs(rest);
  const out = (s) => process.stdout.write(s + '\n');
  if (cmd === 'init') {
    const home = path.resolve(need(flags, 'home'));
    const rid = need(flags, 'receiver-id'); const owner = need(flags, 'owner-key');
    if (!P.rid(rid) || !P.hex64(owner)) throw new ArkError('USAGE', 'bad receiver id or owner key');
    if (fs.existsSync(path.join(home, 'config.json'))) throw new ArkError('USAGE', 'already initialised');
    const k = newTestKey();
    fs.mkdirSync(home, { recursive: true });
    saveKey(path.join(home, 'key.json'), k);
    writeFileAtomic(path.join(home, 'config.json'), JSON.stringify({ v: '0.1', receiver_id: rid, receiver_key: k.pubHex,
      owner_key: owner, effect_root: path.resolve(need(flags, 'effect-root')) }) + '\n');
    for (const d of ['inbox', 'outbox']) fs.mkdirSync(path.join(home, d), { recursive: true });
    out(`receiver_key ${k.pubHex}`); return EXIT.OK;
  }
  const H = openHome(path.resolve(need(flags, 'home')));
  const fault = flags.fault;
  if (fault && !['drop-answer', 'drop-request', 'die-after-effect'].includes(fault)) throw new ArkError('USAGE', 'bad --fault');
  switch (cmd) {
    case 'pins': {
      const pins = { v: '0.1', owner_key: H.cfg.owner_key, receiver_key: H.cfg.receiver_key, receiver_id: H.cfg.receiver_id, supplied_by: need(flags, 'supplied-by') };
      writeFileAtomic(path.resolve(need(flags, 'out')), JSON.stringify(pins) + '\n'); return EXIT.OK;
    }
    case 'run-once': out(`handled ${runOnce(H, fault)}`); return EXIT.OK;
    case 'serve': {
      const poll = Number(flags['poll-ms'] || 50);
      const stop = path.join(H.home, 'STOP');
      for (;;) {
        if (fs.existsSync(stop)) { fs.rmSync(stop, { force: true }); return EXIT.OK; }
        runOnce(H, fault);
        await new Promise((r) => setTimeout(r, poll));
      }
    }
    case 'status': {
      const op = pos[0];
      if (!P.hex32(op)) throw new ArkError('USAGE', 'status <op_id>');
      const s = withLock(H, () => { recover(H); return storedOutcome(H, op); });
      if (!s) { out('UNKNOWN'); return EXIT.UNKNOWN; }
      out(JSON.stringify(s));
      return openEnvelope(s).obj.status === 'DONE' ? EXIT.OK : EXIT.REFUSED;
    }
    case 'epoch': {
      const a = currentAuthority(H); const ri = restoreInfo(H);
      out(`epoch ${a ? a.obj.epoch : 0}`); if (ri) out(`locked floor ${ri.floor}`); return EXIT.OK;
    }
    case 'archive': {
      const dir = path.resolve(need(flags, 'out-dir'));
      const items = withLock(H, () => { recover(H); return collectItems(H); });
      const bundle = { v: '0.1', coverage: `This bundle covers only actions mediated by receiver ${H.cfg.receiver_id}: appending one line to notes/demo.txt. Nothing else the client or its agent did is covered.`, items };
      writeFileAtomic(path.join(dir, 'archive.bundle.json'), JSON.stringify(bundle) + '\n');
      out(`archived ${items.length} items`); return EXIT.OK;
    }
    case 'restore': {
      if (!pos[0]) throw new ArkError('USAGE', 'restore <dir>');
      const r = withLock(H, () => restore(H, path.resolve(pos[0])));
      out(`restored ${r.n} outcomes, locked floor ${r.floor}`); return EXIT.OK;
    }
    default: throw new ArkError('USAGE', `unknown command ${cmd}`);
  }
});
