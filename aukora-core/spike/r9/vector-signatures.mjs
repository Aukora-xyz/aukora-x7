// Create the public signed trace once. Private keys exist only in this Node process.
// The Lean generator later computes every verdict and head from the saved inputs.
import {mkdirSync, writeFileSync} from 'node:fs';
import {cat, sha, u16, u64, blob, text, owner, keyFields, domain, deliver, dual} from '../r8/test-host.mjs';

const folder = process.argv[2];
if (!folder) throw Error('Supply a new output folder for public fixtures');
mkdirSync(folder);
const k = owner(), next = owner(), payload = Buffer.of(42);
writeFileSync(folder+'/keys.bin', cat(k.edRaw, k.mlRaw));
const frames = [], labels = [];
let head = Buffer.alloc(32), seq = 1;
const hdr = () => cat(head,u64(seq));
function add(label, bytes, extendsHeader = true) {
  frames.push(bytes); labels.push(label);
  if (extendsHeader) { head = sha(bytes); seq++; }
}
const b = n => Buffer.of(n);
function submission(label, fields, extendsHeader = true) {
  add(label, cat(b(0), hdr(), fields), extendsHeader);
}
function control(label, action) {
  const msg = cat(domain('control',k), Buffer.from('AUKORA/R5/control'), u64(0), hdr(), action);
  const {edSig,mlSig} = dual(k,msg);
  add(label, cat(b(19),mlSig,hdr(),action,edSig));
}
const i = deliver(payload,0,71), unused = deliver(payload,0,72), bundle = sha(Buffer.from('round-nine'));
submission('say',cat(b(0),text('evidence')));
submission('remember-first',cat(b(1),u16(1),u16(1),text('first')));
submission('remember-second',cat(b(1),u16(2),u16(1),text('second')));
submission('correct',cat(b(2),u16(1),u16(2),text('updated')));
submission('advise',cat(b(6),text('cell'),u16(5)));
control('retract',cat(b(9),u16(1)));
const mid = seq - 1;
control('mandate',cat(b(10),text('service'),blob(payload),u16(0),u16(2),u16(65535)));
const bid = seq - 1;
control('budget',cat(b(12),u16(0),u16(1)));
submission('spend',cat(b(13),u16(bid),u16(1)));
const pid = seq - 1;
control('pass',cat(b(14),text('reader'),text('scope'),u16(0),u16(65535)));
submission('read',cat(b(16),u16(pid),text('reader'),text('scope'),b(1)));
control('revoke-pass',cat(b(15),u16(pid)));
const level = b(99);
const threshold = dual(k,cat(text('AUKORA/R8/threshold'),keyFields(k),u64(0),hdr(),level));
add('threshold',cat(b(22),hdr(),level,threshold.edSig,threshold.mlSig));
add('assessment',cat(b(21),hdr(),sha(i),b(0),bundle));
add('act-mandate',cat(b(23),bundle,hdr(),b(11),u16(mid),b(4),i));
const grant = dual(k,cat(domain('grant',k),i));
add('grant',cat(b(19),grant.mlSig,hdr(),b(3),i,grant.edSig));
add('act-direct',cat(b(23),bundle,hdr(),b(4),i));
submission('outcome',cat(b(5),i,b(0)));
add('outcome-correction',cat(b(26),hdr(),b(5),i,b(1)));
function lifecycle(label,tag,role,fields) {
  const msg = cat(text('AUKORA/R9/'+role),keyFields(k),u64(0),hdr(),fields);
  const sig = dual(k,msg);
  add(label,cat(b(tag),hdr(),fields,sig.edSig,sig.mlSig));
}
lifecycle('grant-expiry',24,'grant',cat(u64(seq+5),unused));
lifecycle('revoke-intent',25,'revoke',sha(unused));
const rebind = dual(k,cat(domain('rebind',k),u64(0),keyFields(next)));
add('rebind',cat(b(20),next.mlRaw,rebind.mlSig,hdr(),b(8),next.edRaw,rebind.edSig));
writeFileSync(folder+'/frames.bin',cat(...frames));
writeFileSync(folder+'/index.tsv',labels.map((label,n) => label+'\t'+frames[n].length+'\n').join(''));
