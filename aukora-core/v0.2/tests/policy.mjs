import assert from 'node:assert/strict';
import {blob, cat, deliver, dual, host, keyFields, owner, sha, text, u16, u64} from './host.mjs';

const h = host(), keys = owner(), next = owner();
assert.equal(h.consume(cat(keys.edRaw, keys.mlRaw), 'init'), 1);
const payload = Buffer.from('policy-nine'), bundle = Buffer.alloc(32, 9);
const intent = n => deliver(payload, 0, n);
const missing = i => sha(cat(text('AUKORA/R8/missing:request-intent-only;evidence=missing;reasoning=missing;witness=missing;versions=missing'), sha(i)));
const act = (i, id, named = missing(i)) => cat(Buffer.of(23), named, h.header(),
  id === null ? Buffer.of(4) : cat(Buffer.of(11), u16(id), Buffer.of(4)), i);
const current = () => h.historyLength() + 1;
function signed(tag, role, fields, active = keys, generation = 0, goodEd = true, goodMl = true) {
  const header = h.header();
  const msg = cat(text('AUKORA/R9/' + role), keyFields(active), u64(generation), header, fields);
  const {edSig, mlSig} = dual(active, msg, goodEd, goodMl);
  return cat(Buffer.of(tag), header, fields, edSig, mlSig);
}
const issue = (i, last, ...opts) => signed(24, 'grant', cat(u64(last), i), ...opts);
const revoke = (i, ...opts) => signed(25, 'revoke', sha(i), ...opts);
const result = (i, val, corrected = false) => cat(Buffer.of(corrected ? 26 : 0), h.header(), Buffer.of(5), i, Buffer.of(val));
function audit(index, wire) {
  for (let b = 0; b < wire.length; b++) assert.equal(h.api.recordByte(index, b), wire[b]);
  assert.equal(h.api.recordByte(index, wire.length), 256);
}
function view(i) { return h.consume(sha(i), 'outcome'); }

const a = intent(1), b = intent(2), c = intent(3), e = intent(4), f = intent(5);
h.submit('grant whose last eligible sequence equals its issue sequence', issue(a, current()), false);
h.submit('expiring grant with only Ed25519 valid', issue(a, 100, keys, 0, true, false), false);
h.submit('expiring grant with only ML-DSA-65 valid', issue(a, 100, keys, 0, false, true), false);
const onlyAt = current() + 1;
h.submit('short grant', issue(a, onlyAt), true);
h.submit('spend at inclusive last sequence', act(a,null), true);
h.submit('spent exact grant cannot recur', act(a,null), false);
const expiry = current() + 1;
const obsolete = issue(b, expiry);
h.submit('expiring unspent grant', obsolete, true);
h.submit('second independent signed grant', h.grant(keys, c), true);
h.submit('one sequence past expiry', act(b,null), false);
h.submit('spend independent grant after first expires', act(c,null), true);
h.submit('expired grant retains historical nonce against legacy grant', h.grant(keys,b), false);
h.submit('expired grant cannot renew with obsolete signed header', obsolete, false);
h.submit('same nonce with different payload after expiration',
  issue(deliver(Buffer.from('different'),0,2), current()+100), false);
h.submit('signed fresh renewal after expiry', issue(b, current()+2), true);
h.submit('spend fresh renewal', act(b,null), true);

h.submit('permanent grant to revoke', h.grant(keys,e), true);
h.submit('independent grant before revocation', issue(f, current()+50), true);
h.submit('unsigned revoke message with one invalid Ed25519 component', revoke(e,keys,0,false,true), false);
h.submit('revoke with one invalid ML-DSA component', revoke(e,keys,0,true,false), false);
h.submit('revoke nonexistent grant', revoke(intent(99)), false);
const revWire = revoke(e), revAt = h.historyLength();
h.submit('revoke exactly one digest', revWire, true);
h.submit('revoked grant refuses act', act(e,null), false);
h.submit('other grant kept; generation still zero', act(f,null), true);
h.submit('obsolete grant cannot resurrect cancelled intent', h.grant(keys,e), false);
const header = h.header();
const thresholdMsg = cat(text('AUKORA/R8/threshold'),keyFields(keys),u64(0),header,Buffer.of(64));
const ts = dual(keys,thresholdMsg);
h.submit('enable low-risk mandates', cat(Buffer.of(22),header,Buffer.of(64),ts.edSig,ts.mlSig), true);
h.submit('record low risk for revoked intent', cat(Buffer.of(21),h.header(),sha(e),Buffer.of(0),bundle), true);
const mid = h.historyLength();
h.submit('standing mandate for revoked intent payload', h.control(keys,
  cat(Buffer.of(10),text('service'),blob(payload),u16(0),u16(2),u16(65535)),0), true);
h.submit('mandate cannot bypass revoked exact intent at low risk', act(e,mid,bundle), false);
h.submit('reissue requires signature valid over current generation', issue(e,current()+20,keys,1), false);
h.submit('new owner-signed exact grant after cancellation', issue(e,current()+20), true);
h.submit('fresh grant re-admits formerly revoked exact intent', act(e,null,bundle), true);
audit(revAt,revWire);

const x = intent(10), y = intent(11);
assert.equal(view(x), 256);
h.submit('orphan correction', result(x,1,true), false);
const initial = result(x,0), firstAt = h.historyLength();
h.submit('original confirmation', initial, true);
assert.equal(view(x), 0);
h.submit('unlabelled replacement', result(x,1), false);
h.submit('bad correction result enumeration', result(x,3,true), false);
const corrected = result(x,1,true), correctionAt = h.historyLength();
h.submit('labelled correction from confirmed to failed', corrected, true);
assert.equal(view(x), 5);
h.submit('other intent initially failed', result(y,1), true);
assert.equal(view(y), 1);
assert.equal(view(x), 5);
h.submit('further labelled correction to unknown', result(x,2,true), true);
assert.equal(view(x), 6);
audit(firstAt,initial);
audit(correctionAt,corrected);

const old = intent(20);
h.submit('old generation still owns active grant',issue(old,current()+50),true);
h.submit('rebind old pair to replacement keys',h.rebind(keys,next,0),true);
h.submit('rebind clears old grant',act(old,null),false);
h.submit('old generation cannot renew',issue(old,current()+50,next,1),false);
assert.equal(view(x),6);
const after = deliver(payload,1,20);
h.submit('new generation may issue same payload and nonce',issue(after,current()+50,next,1),true);
h.submit('new-generation grant can be spent',act(after,null),true);
console.log('PASS grant expiry, revocation, independent grants, signed renewal, rebind and outcome correction in the release core');
