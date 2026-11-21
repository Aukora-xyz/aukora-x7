// Test helpers for reader 1's self-tests. Worlds live under run/ (never /tmp) and are removed after.
import { spawnSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseStrict, openEnvelope } from '../lib/core.mjs';
import { selfcheck, checkPins } from '../lib/selfcheck.mjs';

export const PROOF = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BIN = path.join(PROOF, 'a', 'bin');

export function run(tool, args, input) {
  const r = spawnSync(path.join(BIN, tool), args, { encoding: 'utf8', input: input ?? '' });
  return { code: r.status, signal: r.signal, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}
export function runAsync(tool, args) {
  return new Promise((res) => {
    const c = spawn(path.join(BIN, tool), args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; c.stdout.on('data', (d) => { out += d; });
    c.on('close', (code, signal) => res({ code, signal, out: out.trim() }));
  });
}
const last = (s, i) => s.split(/\s+/)[i];

export function makeWorld(name) {
  const dir = path.join(PROOF, 'run', `test-${name}-${crypto.randomBytes(3).toString('hex')}`);
  fs.mkdirSync(dir, { recursive: true });
  const W = { dir, R: path.join(dir, 'recv'), O: path.join(dir, 'owner'), A: path.join(dir, 'ca'), B: path.join(dir, 'cb'), rid: 'recv-1' };
  const f = (n) => path.join(dir, n);
  W.f = f;
  W.ownerKey = last(run('owner', ['init', '--home', W.O]).out, 1);
  W.keyA = last(run('client-a', ['init', '--home', W.A]).out, 1);
  W.keyB = last(run('client-a', ['init', '--home', W.B]).out, 1);
  run('receiver', ['init', '--home', W.R, '--receiver-id', W.rid, '--owner-key', W.ownerKey, '--effect-root', dir]);
  W.grant = (clientKey, out, extra = []) => {
    const r = run('owner', ['grant', '--home', W.O, '--client-key', clientKey, '--receiver-id', W.rid, '--action', 'append_line',
      '--resource', 'notes/demo.txt', '--not-after', '+3600000', '--out', f(out), ...extra]);
    if (r.code !== 0) throw new Error(r.err);
    return f(out);
  };
  W.authority = (epoch, grants, out) => {
    run('owner', ['authority', '--home', W.O, '--receiver-id', W.rid, '--epoch', String(epoch), ...grants.flatMap((g) => ['--grant', g]), '--out', f(out)]);
    return f(out);
  };
  W.deliver = (authFile, fault = []) => {
    const id = `auth-${crypto.randomBytes(3).toString('hex')}`;
    run('owner', ['deliver', '--home', W.O, '--receiver-home', W.R, '--authority', authFile, '--request-id', id, '--wait-ms', '0']);
    run('receiver', ['run-once', '--home', W.R, ...fault]);
    return run('client-a', ['collect', '--home', W.A, '--receiver-home', W.R, '--request-id', id]).out.split(' ').slice(0, 2).join(' ');
  };
  W.propose = (home, grantFile, text, out, extra = []) => {
    const r = run('client-a', ['propose', '--home', home, '--grant', grantFile, '--text', text, '--out', f(out), ...extra]);
    if (r.code !== 0) throw new Error(r.err);
    return { file: f(out), op: last(r.out, 1), hash: last(r.out, 3) };
  };
  W.approve = (propFile, epoch, out, notAfter = '+600000', extra = []) => {
    const r = run('owner', ['approve', '--home', W.O, '--proposal', propFile, '--receiver-id', W.rid, '--epoch', String(epoch),
      '--not-after', notAfter, '--yes', '--out', f(out), ...extra]);
    if (r.code !== 0) throw new Error(r.err);
    return { file: f(out), shown: r.out };
  };
  let n = 0;
  W.sendOnly = (home, grantFile, propFile, approvalFile, extra = []) => {
    const id = `req-${++n}-${crypto.randomBytes(3).toString('hex')}`;
    run('client-a', ['send', '--home', home, '--receiver-home', W.R, '--grant', grantFile, '--proposal', propFile,
      ...(approvalFile ? ['--approval', approvalFile] : []), '--request-id', id, '--wait-ms', '0', ...extra]);
    return id;
  };
  W.collect = (home, id) => run('client-a', ['collect', '--home', home, '--receiver-home', W.R, '--request-id', id]);
  W.runOnce = (fault) => run('receiver', ['run-once', '--home', W.R, ...(fault ? ['--fault', fault] : [])]);
  W.send = (home, grantFile, propFile, approvalFile, extra = [], fault) => {
    const id = W.sendOnly(home, grantFile, propFile, approvalFile, extra);
    W.runOnce(fault);
    const c = W.collect(home, id);
    return { id, code: c.code, status: c.out.split(' ')[0], reason: c.out.split(' ')[1] };
  };
  W.answer = (id) => parseStrict(fs.readFileSync(path.join(W.R, 'outbox', `${id}.ans.json`)));
  W.lines = () => { const p = path.join(dir, 'notes', 'demo.txt'); return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').split('\n').filter(Boolean) : []; };
  W.linesFor = (op) => W.lines().filter((l) => l.startsWith(`${op} `));
  W.fileSha = () => crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, 'notes', 'demo.txt'))).digest('hex');
  W.pins = (out = 'pins.json') => { run('receiver', ['pins', '--home', W.R, '--supplied-by', 'reader 1 (Node) self-test', '--out', f(out)]); return f(out); };
  W.export = (home, out) => { run('client-a', ['export', '--home', home, '--receiver-id', W.rid, '--out', f(out)]); return f(out); };
  W.check = (bundleFile, pinsFile) => selfcheck(fs.readFileSync(bundleFile), checkPins(fs.readFileSync(pinsFile)));
  W.cleanup = () => fs.rmSync(dir, { recursive: true, force: true });
  // standard start: grant for A, epoch 1
  W.gA = W.grant(W.keyA, 'grant-a.json');
  W.auth1 = W.authority(1, [W.gA], 'auth1.json');
  W.deliver(W.auth1);
  return W;
}
export const outcomeOf = (ans) => (ans.outcome ? openEnvelope(ans.outcome).obj : null);
