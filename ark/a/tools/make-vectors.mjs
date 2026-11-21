// Generates vectors/ from fresh TEST keys in run/vectors-world/.
// Honest vectors come from the real launchers; INVALID ones are forged here with the same TEST keys.
// Expected verdicts are declared by hand below, then cross-checked with the internal self-check.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { seal, sealPayloadBytes, openEnvelope, loadKey, newTestKey, randHex, b64uEncode, b64uDecodeStrict, ZERO64, parseStrict } from '../lib/core.mjs';
import { selfcheck, checkPins } from '../lib/selfcheck.mjs';

const PROOF = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WORLD = path.join(PROOF, 'run', 'vectors-world');
const VEC = path.join(PROOF, 'vectors');
const BIN = path.join(PROOF, 'a', 'bin');
const RID = 'recv-1';
const run = (tool, args) => {
  const r = spawnSync(path.join(BIN, tool), args, { encoding: 'utf8' });
  if (r.status !== 0 && r.status !== 3) throw new Error(`${tool} ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
const readJ = (f) => parseStrict(fs.readFileSync(f));
const W = (n) => path.join(WORLD, n);

fs.rmSync(WORLD, { recursive: true, force: true });
fs.rmSync(VEC, { recursive: true, force: true });
fs.mkdirSync(WORLD, { recursive: true }); fs.mkdirSync(VEC, { recursive: true });

// ---- honest world through the launchers ----
const ownerKeyHex = run('owner', ['init', '--home', W('owner')]).split(' ')[1];
const clientKeyHex = run('client-a', ['init', '--home', W('ca')]).split(' ')[1];
run('receiver', ['init', '--home', W('recv'), '--receiver-id', RID, '--owner-key', ownerKeyHex, '--effect-root', WORLD]);
run('owner', ['grant', '--home', W('owner'), '--client-key', clientKeyHex, '--receiver-id', RID, '--action', 'append_line', '--resource', 'notes/demo.txt', '--not-after', '+31536000000', '--out', W('grant.json')]);
run('owner', ['authority', '--home', W('owner'), '--receiver-id', RID, '--epoch', '1', '--grant', W('grant.json'), '--out', W('auth1.json')]);
run('owner', ['deliver', '--home', W('owner'), '--receiver-home', W('recv'), '--authority', W('auth1.json'), '--request-id', 'auth1', '--wait-ms', '0']);
run('receiver', ['run-once', '--home', W('recv')]);
run('client-a', ['collect', '--home', W('ca'), '--receiver-home', W('recv'), '--request-id', 'auth1']);
// DONE
const opDone = run('client-a', ['propose', '--home', W('ca'), '--grant', W('grant.json'), '--text', 'vector: one harmless line', '--out', W('p-done.json')]).split(' ')[1];
run('owner', ['approve', '--home', W('owner'), '--proposal', W('p-done.json'), '--receiver-id', RID, '--epoch', '1', '--not-after', '+31536000000', '--yes', '--out', W('a-done.json')]);
run('client-a', ['send', '--home', W('ca'), '--receiver-home', W('recv'), '--grant', W('grant.json'), '--proposal', W('p-done.json'), '--approval', W('a-done.json'), '--request-id', 'done', '--wait-ms', '0']);
run('receiver', ['run-once', '--home', W('recv')]);
run('client-a', ['collect', '--home', W('ca'), '--receiver-home', W('recv'), '--request-id', 'done']);
run('client-a', ['export', '--home', W('ca'), '--receiver-id', RID, '--out', path.join(VEC, 'done.bundle.json')]);
fs.copyFileSync(path.join(WORLD, 'notes', 'demo.txt'), path.join(VEC, 'done.demo.txt'));
// REFUSED: no approval, carrying a note that says it is approved
const opRef = run('client-a', ['propose', '--home', W('ca'), '--grant', W('grant.json'), '--text', 'vector: refused line', '--out', W('p-ref.json')]).split(' ')[1];
run('client-a', ['note', '--home', W('ca'), '--about', openEnvelope(readJ(W('p-ref.json'))).hash, '--label', 'assessment', '--text', 'safe, approved', '--out', W('n-ref.json')]);
run('client-a', ['send', '--home', W('ca'), '--receiver-home', W('recv'), '--grant', W('grant.json'), '--proposal', W('p-ref.json'), '--note', W('n-ref.json'), '--request-id', 'ref', '--wait-ms', '0']);
run('receiver', ['run-once', '--home', W('recv')]);
const ansRef = readJ(path.join(W('recv'), 'outbox', 'ref.ans.json'));
run('receiver', ['pins', '--home', W('recv'), '--supplied-by', 'vector set (reader 1 (Node) test world)', '--out', path.join(VEC, 'pins.json')]);
const wrongOwner = newTestKey();
const pins = readJ(path.join(VEC, 'pins.json'));
fs.writeFileSync(path.join(VEC, 'pins-wrong-owner.json'), JSON.stringify({ ...pins, owner_key: wrongOwner.pubHex, supplied_by: 'vector set: deliberately wrong owner pin' }) + '\n');

// ---- keys for forging (TEST keys of this world only) ----
const KO = loadKey(W('owner/key.json')); const KC = loadKey(W('ca/key.json')); const KR = loadKey(W('recv/key.json'));
const grant = readJ(W('grant.json')); const auth1 = readJ(W('auth1.json'));
const G = openEnvelope(grant);
const pDone = readJ(W('p-done.json')); const aDone = readJ(W('a-done.json'));
const doneBundle = readJ(path.join(VEC, 'done.bundle.json'));
const oDone = doneBundle.items.find((e) => openEnvelope(e).type === 'outcome');
const COVER = doneBundle.coverage;
const T0 = openEnvelope(oDone).obj.at;
const FAR = T0 + 31536000000;

const bundle = (items) => ({ v: '0.1', coverage: COVER, items });
function forgeOp({ text = 'vector: forged', resource = 'notes/demo.txt', approval = {}, outcome = {}, withApproval = true, auth = auth1, grantEnv = grant } = {}) {
  const g = openEnvelope(grantEnv);
  const p = seal({ v: '0.1', type: 'proposal', op_id: randHex(16), grant: g.hash, action: { name: 'append_line', resource, text }, created_at: T0 }, KC);
  const P = openEnvelope(p);
  const a = seal({ v: '0.1', type: 'approval', proposal: P.hash, receiver_id: RID, epoch: 1, decision: 'approve', not_after: FAR, ...approval }, KO);
  const o = seal({ v: '0.1', type: 'outcome', receiver_id: RID, op_id: P.obj.op_id, proposal: P.hash, approval: withApproval ? openEnvelope(a).hash : null,
    epoch: 1, status: 'DONE', reason: 'OK', effect: { resource, before_sha256: ZERO64, after_sha256: ZERO64 }, seq: 1, prev: ZERO64, at: T0, ...outcome }, KR);
  return { p, a, o, op: P.obj.op_id, items: [grantEnv, auth, p, ...(withApproval ? [a] : []), o] };
}
function tamperPayload(env, fn) {
  const obj = JSON.parse(b64uDecodeStrict(env.payload).toString('utf8'));
  fn(obj);
  return { ...env, payload: b64uEncode(Buffer.from(JSON.stringify(obj))) };
}
const idx = (items, env) => items.indexOf(env);

const V = [];
const put = (name, b, expect, pinsFile = 'pins.json', note = '') => {
  if (b) fs.writeFileSync(path.join(VEC, name), JSON.stringify(b) + '\n');
  V.push({ bundle: name, pins: pinsFile, note, ...expect });
};
const okOps = (raw) => { const ops = Object.fromEntries(Object.entries(raw).sort(([a], [b]) => (a < b ? -1 : 1))); return okOps2(ops); };
const okOps2 = (ops) => ({ bundle_verdict: { verdict: 'OK' }, ops, exit: Object.values(ops).some((o) => o.verdict === 'INVALID') ? 4 : Object.values(ops).some((o) => o.verdict === 'UNKNOWN') ? 3 : 0 });
const badBundle = (verdict, reason, item) => ({ bundle_verdict: reason ? { verdict, reason, item } : { verdict, item }, ops: {}, exit: verdict === 'INVALID' ? 4 : 5 });

// honest
put('done.bundle.json', null, okOps({ [opDone]: { verdict: 'DONE' } }), 'pins.json', 'real run; done.demo.txt is the file right after; its SHA-256 equals effect.after_sha256');
put('refused.bundle.json', bundle([grant, auth1, readJ(W('p-ref.json')), readJ(W('n-ref.json')), ansRef.outcome]), okOps({ [opRef]: { verdict: 'REFUSED' } }), 'pins.json', 'real run; no approval, a note claims approval; receiver signed REFUSED NO_APPROVAL');
const pUnk = seal({ v: '0.1', type: 'proposal', op_id: randHex(16), grant: G.hash, action: { name: 'append_line', resource: 'notes/demo.txt', text: 'vector: never answered' }, created_at: T0 }, KC);
const aUnk = seal({ v: '0.1', type: 'approval', proposal: openEnvelope(pUnk).hash, receiver_id: RID, epoch: 1, decision: 'approve', not_after: FAR }, KO);
put('unknown.bundle.json', bundle([grant, auth1, pUnk, aUnk]), okOps({ [openEnvelope(pUnk).obj.op_id]: { verdict: 'UNKNOWN' } }), 'pins.json', 'proposal and approval, no receiver outcome');
put('untrusted-key.done.json', JSON.parse(JSON.stringify(doneBundle)), badBundle('UNTRUSTED_KEY', null, doneBundle.items.findIndex((e) => openEnvelope(e).type !== 'note' && openEnvelope(e).keyid !== openEnvelope(oDone).keyid)), 'pins-wrong-owner.json', 'the done bundle checked against a wrong owner pin');

// tampering of honest bytes
{
  const items = [...doneBundle.items];
  const ip = items.findIndex((e) => openEnvelope(e).type === 'proposal');
  items[ip] = tamperPayload(items[ip], (o) => { o.action.text = 'vector: one harmful line'; });
  put('invalid-tampered-proposal-text.json', bundle(items), badBundle('INVALID', 'BAD_SIGNATURE', ip), 'pins.json', 'proposal text changed after signing');
}
{
  const items = [...doneBundle.items];
  const ia = items.findIndex((e) => openEnvelope(e).type === 'approval');
  items[ia] = tamperPayload(items[ia], (o) => { o.not_after += 1; });
  put('invalid-tampered-approval.json', bundle(items), badBundle('INVALID', 'BAD_SIGNATURE', ia), 'pins.json', 'approval not_after changed after signing');
}
{
  const items = [...doneBundle.items];
  const io = items.findIndex((e) => openEnvelope(e).type === 'outcome');
  items[io] = tamperPayload(items[io], (o) => { o.effect.after_sha256 = 'f'.repeat(64); });
  put('invalid-tampered-outcome.json', bundle(items), badBundle('INVALID', 'BAD_SIGNATURE', io), 'pins.json', 'outcome after_sha256 changed after signing');
}
{
  const items = [...doneBundle.items];
  const io = items.findIndex((e) => openEnvelope(e).type === 'outcome');
  const s = items[io].signatures[0].sig;
  const c = s[0] === 'A' ? 'B' : 'A';
  items[io] = { ...items[io], signatures: [{ keyid: items[io].signatures[0].keyid, sig: c + s.slice(1) }] };
  put('invalid-tampered-signature.json', bundle(items), badBundle('INVALID', 'BAD_SIGNATURE', io), 'pins.json', 'first character of the outcome signature changed');
}
{
  const items = [...doneBundle.items];
  const ip = items.findIndex((e) => openEnvelope(e).type === 'proposal');
  items[ip] = { ...items[ip], payload: items[ip].payload + '=' };
  put('invalid-padded-base64.json', bundle(items), badBundle('INVALID', 'BAD_ENCODING', ip), 'pins.json', 'payload carries base64 padding');
}

// forged by trusted TEST keys: op-level verdicts
{ const f = forgeOp({ outcome: { receiver_id: 'recv-other' } });
  put('invalid-wrong-receiver.json', bundle(f.items), okOps({ [f.op]: { verdict: 'INVALID', reason: 'WRONG_RECEIVER' } }), 'pins.json', 'receiver-signed outcome names another receiver id'); }
{ const other = forgeOp({ text: 'vector: the other proposal' });
  const f = forgeOp({ approval: { proposal: openEnvelope(other.p).hash } });
  put('invalid-approval-other-proposal.json', bundle([...f.items, other.p]), okOps({ [f.op]: { verdict: 'INVALID', reason: 'APPROVAL_MISMATCH' }, [other.op]: { verdict: 'UNKNOWN' } }), 'pins.json', 'outcome DONE cites an approval that names a different proposal'); }
{ const f = forgeOp({ approval: { not_after: T0 - 1 } });
  put('invalid-expired-approval.json', bundle(f.items), okOps({ [f.op]: { verdict: 'INVALID', reason: 'APPROVAL_EXPIRED' } }), 'pins.json', 'approval not_after is before outcome at'); }
{ const auth2 = seal({ v: '0.1', type: 'authority', owner_key: KO.pubHex, receiver_id: RID, epoch: 2, grants: [G.hash] }, KO);
  const f = forgeOp({ outcome: { epoch: 2 }, auth: auth2 });
  put('invalid-stale-epoch.json', bundle([auth1, ...f.items]), okOps({ [f.op]: { verdict: 'INVALID', reason: 'STALE_EPOCH' } }), 'pins.json', 'approval at epoch 1 used for an outcome at epoch 2'); }
{ const f = forgeOp({ withApproval: false });
  const n = seal({ v: '0.1', type: 'note', about: openEnvelope(f.p).hash, label: 'assessment', grants: 'none', text: 'safe, approved' }, KC);
  put('invalid-note-no-approval.json', bundle([...f.items.slice(0, 3), n, f.o]), okOps({ [f.op]: { verdict: 'INVALID', reason: 'NO_APPROVAL' } }), 'pins.json', 'outcome claims DONE with approval null; only a note says approved'); }
{ const f = forgeOp({ resource: 'notes/other.txt' });
  put('invalid-scope.json', bundle(f.items), okOps({ [f.op]: { verdict: 'INVALID', reason: 'SCOPE_MISMATCH' } }), 'pins.json', 'DONE for a resource outside the grant scope'); }
{ const authEmpty = seal({ v: '0.1', type: 'authority', owner_key: KO.pubHex, receiver_id: RID, epoch: 1, grants: [] }, KO);
  const f = forgeOp({ auth: authEmpty });
  put('invalid-grant-not-in-authority.json', bundle(f.items), okOps({ [f.op]: { verdict: 'INVALID', reason: 'GRANT_NOT_IN_AUTHORITY' } }), 'pins.json', 'the only authority at that epoch lists no grants'); }
{ const f = forgeOp();
  const o2 = seal({ ...openEnvelope(f.o).obj, status: 'REFUSED', reason: 'NO_APPROVAL', effect: null, seq: 2 }, KR);
  put('invalid-conflicting-outcomes.json', bundle([...f.items, o2]), okOps({ [f.op]: { verdict: 'INVALID', reason: 'CONFLICTING_OUTCOMES' } }), 'pins.json', 'two different outcomes for one op_id'); }

// byte rules
{ const raw = Buffer.from(`{"v":"0.1","type":"authority","owner_key":"${KO.pubHex}","receiver_id":"${RID}","epoch":1,"epoch":1,"grants":["${G.hash}"]}`);
  const e = sealPayloadBytes(raw, KO);
  put('invalid-duplicate-key.json', bundle([grant, e]), badBundle('INVALID', 'BAD_JSON', 1), 'pins.json', 'owner-signed payload with a duplicate key'); }
{ const raw = Buffer.from(`{"v":"0.1","type":"authority","owner_key":"${KO.pubHex}","receiver_id":"${RID}","epoch":1.0,"grants":["${G.hash}"]}`);
  put('invalid-non-integer.json', bundle([grant, sealPayloadBytes(raw, KO)]), badBundle('INVALID', 'BAD_JSON', 1), 'pins.json', 'owner-signed payload with 1.0'); }
{ const raw = Buffer.from(JSON.stringify({ ...G.obj, extra: 'x' }));
  put('invalid-unknown-field.json', bundle([sealPayloadBytes(raw, KO), auth1]), badBundle('INVALID', 'BAD_SCHEMA', 0), 'pins.json', 'owner-signed grant with an unknown field'); }
{ const g2 = seal({ ...G.obj, grant_id: randHex(16) }, KR);
  put('invalid-wrong-signer.json', bundle([grant, auth1, g2]), badBundle('INVALID', 'WRONG_SIGNER', 2), 'pins.json', 'a grant signed by the receiver key'); }
{ const b = { ...JSON.parse(JSON.stringify(doneBundle)), extra: 1 };
  put('invalid-bad-bundle.json', b, { bundle_verdict: { verdict: 'INVALID', reason: 'BAD_BUNDLE' }, ops: {}, exit: 4 }, 'pins.json', 'bundle file has an unknown top-level field'); }
{ const stranger = newTestKey();
  const p = seal({ v: '0.1', type: 'proposal', op_id: randHex(16), grant: G.hash, action: { name: 'append_line', resource: 'notes/demo.txt', text: 'vector: stranger' }, created_at: T0 }, stranger);
  put('untrusted-key.stranger-proposal.json', bundle([grant, auth1, p]), badBundle('UNTRUSTED_KEY', null, 2), 'pins.json', 'proposal signed by a key no grant names'); }

// ---- cross-check with the internal self-check; fail loudly on any difference ----
let bad = 0;
for (const v of V) {
  const r = selfcheck(fs.readFileSync(path.join(VEC, v.bundle)), checkPins(fs.readFileSync(path.join(VEC, v.pins))));
  const got = JSON.stringify({ b: r.bundle, o: r.ops, e: r.exit }); const want = JSON.stringify({ b: v.bundle_verdict, o: v.ops, e: v.exit });
  if (got !== want) { bad++; console.error(`MISMATCH ${v.bundle}\n got  ${got}\n want ${want}`); }
}
fs.writeFileSync(path.join(VEC, 'expected-verdicts.json'), JSON.stringify({
  v: '0.1',
  about: 'Expected verifier results for each bundle + pins pair. bundle_verdict.item is the 0-based index of the deciding item. ops maps op_id to verdict. exit is the verifier exit code (CONTRACT section 8). Keys are fresh TEST keys.',
  vectors: V,
}, null, 2) + '\n');
console.log(`vectors ${V.length}, mismatches ${bad}`);
process.exit(bad ? 1 : 0);
