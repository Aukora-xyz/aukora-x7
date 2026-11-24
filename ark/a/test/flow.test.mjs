// Reader 1 (Node) self-tests: receiver rules R1-R8 through the black-box launchers. Small and fast.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeWorld, run, runAsync, outcomeOf } from './helpers.mjs';

test('1-3: one approval, one effect, DONE, self-check DONE, file hash = after_sha256', (t) => {
  const W = makeWorld('one'); t.after(W.cleanup);
  const p = W.propose(W.A, W.gA, 'first line', 'p1.json');
  const ap = W.approve(p.file, 1, 'a1.json');
  assert.match(ap.shown, /resource: notes\/demo\.txt/);
  assert.match(ap.shown, /text: {5}"first line"/);
  const r = W.send(W.A, W.gA, p.file, ap.file);
  assert.equal(r.status, 'DONE');
  assert.equal(W.linesFor(p.op).length, 1);
  const o = outcomeOf(W.answer(r.id));
  assert.equal(o.effect.after_sha256, W.fileSha());
  const v = W.check(W.export(W.A, 'bundle.json'), W.pins());
  assert.equal(v.bundle.verdict, 'OK');
  assert.deepEqual(v.ops[p.op], { verdict: 'DONE' });
});

test('5: same request 8 times at once, then after restart: one line, identical outcome bytes', async (t) => {
  const W = makeWorld('retry'); t.after(W.cleanup);
  const p = W.propose(W.A, W.gA, 'retry me', 'p.json');
  const ap = W.approve(p.file, 1, 'a.json');
  const ids = Array.from({ length: 8 }, () => W.sendOnly(W.A, W.gA, p.file, ap.file));
  await Promise.all(ids.map(() => runAsync('receiver', ['run-once', '--home', W.R])));
  const outs = ids.map((id) => JSON.stringify(W.answer(id).outcome));
  assert.equal(new Set(outs).size, 1);
  assert.equal(W.answer(ids[0]).status, 'DONE');
  const again = W.send(W.A, W.gA, p.file, ap.file);
  assert.equal(JSON.stringify(W.answer(again.id).outcome), outs[0]);
  assert.equal(W.linesFor(p.op).length, 1);
});

test('6: same op_id with different text: REJECTED OP_ID_REUSED, no effect', (t) => {
  const W = makeWorld('reuse'); t.after(W.cleanup);
  const p = W.propose(W.A, W.gA, 'original', 'p.json');
  W.send(W.A, W.gA, p.file, W.approve(p.file, 1, 'a.json').file);
  const p2 = W.propose(W.A, W.gA, 'changed', 'p2.json', ['--op-id', p.op]);
  const r = W.send(W.A, W.gA, p2.file, W.approve(p2.file, 1, 'a2.json').file);
  assert.deepEqual([r.status, r.reason, r.code], ['REJECTED', 'OP_ID_REUSED', 4]);
  assert.equal(W.linesFor(p.op).length, 1);
  assert.ok(!W.lines().some((l) => l.endsWith('changed')));
});

test('7: lost answer: UNKNOWN for client and self-check, status settles DONE, still one line', (t) => {
  const W = makeWorld('lostans'); t.after(W.cleanup);
  const p = W.propose(W.A, W.gA, 'lost answer', 'p.json');
  const r = W.send(W.A, W.gA, p.file, W.approve(p.file, 1, 'a.json').file, [], 'drop-answer');
  assert.deepEqual([r.status, r.code], ['UNKNOWN', 3]);
  assert.equal(W.linesFor(p.op).length, 1);
  assert.deepEqual(W.check(W.export(W.A, 'b1.json'), W.pins()).ops[p.op], { verdict: 'UNKNOWN' });
  const st = run('receiver', ['status', '--home', W.R, p.op]);
  assert.equal(st.code, 0);
  const sid = 'status-1';
  run('client-a', ['status', '--home', W.A, '--receiver-home', W.R, '--op-id', p.op, '--request-id', sid, '--wait-ms', '0']);
  W.runOnce();
  assert.match(W.collect(W.A, sid).out, /^DONE OK/);
  assert.deepEqual(W.check(W.export(W.A, 'b2.json'), W.pins()).ops[p.op], { verdict: 'DONE' });
  assert.equal(W.linesFor(p.op).length, 1);
});

test('8: hard kill after effect, before outcome saved: retry gives DONE once, one line', (t) => {
  const W = makeWorld('kill'); t.after(W.cleanup);
  const p = W.propose(W.A, W.gA, 'kill me', 'p.json');
  const ap = W.approve(p.file, 1, 'a.json');
  const id = W.sendOnly(W.A, W.gA, p.file, ap.file);
  const k = W.runOnce('die-after-effect');
  assert.equal(k.signal, 'SIGKILL');
  assert.equal(W.collect(W.A, id).code, 3);
  assert.equal(W.linesFor(p.op).length, 1);
  assert.ok(fs.existsSync(path.join(W.R, 'lock')), 'stale lock left by the killed process');
  const r = W.send(W.A, W.gA, p.file, ap.file);
  assert.equal(r.status, 'DONE');
  assert.equal(outcomeOf(W.answer(r.id)).effect.after_sha256, W.fileSha());
  assert.equal(W.linesFor(p.op).length, 1);
});

test('9: lost request: UNKNOWN, nothing done; retry with same op_id runs once', (t) => {
  const W = makeWorld('lostreq'); t.after(W.cleanup);
  const p = W.propose(W.A, W.gA, 'lost request', 'p.json');
  const ap = W.approve(p.file, 1, 'a.json');
  const r = W.send(W.A, W.gA, p.file, ap.file, [], 'drop-request');
  assert.equal(r.status, 'UNKNOWN');
  assert.equal(W.linesFor(p.op).length, 0);
  assert.equal(W.send(W.A, W.gA, p.file, ap.file).status, 'DONE');
  assert.equal(W.linesFor(p.op).length, 1);
});

test('10-12: replace client A at epoch 2, then restore the receiver: old authority refused', (t) => {
  const W = makeWorld('replace'); t.after(W.cleanup);
  const p1 = W.propose(W.A, W.gA, 'by A at epoch 1', 'p1.json');
  const a1 = W.approve(p1.file, 1, 'a1.json');
  assert.equal(W.send(W.A, W.gA, p1.file, a1.file).status, 'DONE');
  const pA = W.propose(W.A, W.gA, 'A again', 'pA.json');
  const aA1 = W.approve(pA.file, 1, 'aA1.json'); // approved at epoch 1, used after epoch 2
  const bundleA = W.export(W.A, 'archive-a.json');
  const gB = W.grant(W.keyB, 'grant-b.json');
  assert.equal(W.deliver(W.authority(2, [gB], 'auth2.json')), 'ACCEPTED OK');
  // (a) B keeps A's archive; the old receipt still verifies
  run('client-a', ['keep', '--home', W.B, bundleA]);
  assert.deepEqual(W.check(W.export(W.B, 'b-view.json'), W.pins()).ops[p1.op], { verdict: 'DONE' });
  // (b) valid-but-old authority
  const rb = W.send(W.A, W.gA, pA.file, aA1.file);
  assert.equal(rb.status, 'REFUSED');
  assert.equal(W.linesFor(pA.op).length, 0);
  // (c) B signs under A's grant
  const pBA = W.propose(W.B, W.gA, 'B under A grant', 'pBA.json');
  const rc = W.send(W.B, W.gA, pBA.file, W.approve(pBA.file, 2, 'aBA.json').file);
  assert.deepEqual([rc.status, rc.reason], ['REJECTED', 'WRONG_CLIENT']);
  // (d) replay epoch 1 authority
  assert.equal(W.deliver(W.auth1), 'REJECTED STALE_AUTHORITY');
  assert.match(run('receiver', ['epoch', '--home', W.R]).out, /^epoch 2$/);
  // (e) replay first op byte for byte
  const re = W.send(W.A, W.gA, p1.file, a1.file);
  assert.equal(re.status, 'DONE');
  assert.equal(W.linesFor(p1.op).length, 1);
  // (f) B with own grant and fresh approval
  const pB = W.propose(W.B, gB, 'by B at epoch 2', 'pB.json');
  assert.equal(W.send(W.B, gB, pB.file, W.approve(pB.file, 2, 'aB.json').file).status, 'DONE');
  assert.equal(W.linesFor(pB.op).length, 1);
  // 11: out of scope, even with an owner approval
  const pS = W.propose(W.B, gB, 'other file', 'pS.json', ['--resource', 'notes/other.txt']);
  const rs = W.send(W.B, gB, pS.file, W.approve(pS.file, 2, 'aS.json').file);
  assert.deepEqual([rs.status, rs.reason], ['REFUSED', 'SCOPE_MISMATCH']);
  // 12: wipe state, restore from archive
  const arch = path.join(W.dir, 'arch');
  run('receiver', ['archive', '--home', W.R, '--out-dir', arch]);
  fs.rmSync(path.join(W.R, 'state'), { recursive: true });
  assert.match(run('receiver', ['restore', '--home', W.R, arch]).out, /locked floor 2$/);
  assert.equal(run('receiver', ['status', '--home', W.R, p1.op]).code, 0);
  const pL = W.propose(W.B, gB, 'while locked', 'pL.json');
  const aL = W.approve(pL.file, 2, 'aL.json');
  assert.deepEqual(Object.values(W.send(W.B, gB, pL.file, aL.file)).slice(2), ['REFUSED', 'LOCKED_AFTER_RESTORE']);
  assert.equal(W.deliver(W.auth1), 'REJECTED STALE_AUTHORITY');
  assert.equal(W.deliver(path.join(W.dir, 'auth2.json')), 'REJECTED STALE_AUTHORITY');
  assert.equal(W.deliver(W.authority(3, [gB], 'auth3.json')), 'ACCEPTED OK');
  const pN = W.propose(W.B, gB, 'after epoch 3', 'pN.json');
  assert.equal(W.send(W.B, gB, pN.file, W.approve(pN.file, 3, 'aN.json').file).status, 'DONE');
  assert.equal(W.linesFor(pL.op).length, 0);
  assert.equal(W.lines().length, 3);
});

test('13: note "safe, approved" with no approval: REFUSED NO_APPROVAL, no effect', (t) => {
  const W = makeWorld('note'); t.after(W.cleanup);
  const p = W.propose(W.A, W.gA, 'needs approval', 'p.json');
  run('client-a', ['note', '--home', W.A, '--about', p.hash, '--label', 'assessment', '--text', 'safe, approved', '--out', W.f('n.json')]);
  const r = W.send(W.A, W.gA, p.file, null, ['--note', W.f('n.json')]);
  assert.deepEqual([r.status, r.reason], ['REFUSED', 'NO_APPROVAL']);
  assert.equal(W.lines().length, 0);
  assert.deepEqual(W.check(W.export(W.A, 'b.json'), W.pins()).ops[p.op], { verdict: 'REFUSED' });
});

test('14: expired approval: REFUSED APPROVAL_EXPIRED', (t) => {
  const W = makeWorld('expired'); t.after(W.cleanup);
  const p = W.propose(W.A, W.gA, 'too late', 'p.json');
  const r = W.send(W.A, W.gA, p.file, W.approve(p.file, 1, 'a.json', '-1000').file);
  assert.deepEqual([r.status, r.reason], ['REFUSED', 'APPROVAL_EXPIRED']);
  assert.equal(W.lines().length, 0);
});

test('R8: forged grant (not owner-signed) gets a plain rejection, nothing recorded', (t) => {
  const W = makeWorld('forged'); t.after(W.cleanup);
  // client A pretends to be the owner by running the owner tool with its own key home
  const fake = W.f('fake-owner');
  fs.mkdirSync(fake); fs.copyFileSync(path.join(W.A, 'key.json'), path.join(fake, 'key.json'));
  run('owner', ['grant', '--home', fake, '--client-key', W.keyA, '--receiver-id', W.rid, '--action', 'append_line', '--resource', 'notes/demo.txt', '--not-after', '+60000', '--out', W.f('g-fake.json')]);
  const p = W.propose(W.A, W.f('g-fake.json'), 'forged', 'p.json');
  const r = W.send(W.A, W.f('g-fake.json'), p.file, W.approve(p.file, 1, 'a.json').file);
  assert.deepEqual([r.status, r.reason], ['REJECTED', 'BAD_GRANT']);
  assert.equal(run('receiver', ['status', '--home', W.R, p.op]).out, 'UNKNOWN');
  assert.equal(W.lines().length, 0);
});
