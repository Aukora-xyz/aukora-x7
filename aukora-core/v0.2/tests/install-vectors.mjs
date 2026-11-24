// Run only to author new signed public vectors for a changed binary or certificate.
import {readFileSync,writeFileSync} from 'node:fs';
import {cat,dual,install,keyFields,sha,text,u32,u64} from './host.mjs';
import {vectorSession} from './vectors11.mjs';
import {candidate,part} from './install-cases.mjs';
const h = vectorSession('r11-install'), stages = [], reasons = [];
let nonce = 0;
function prepare(name) {
  const file = candidate(name), target = sha(file), intent = install(target,0,++nonce);
  const label = 'head-bound hybrid install grant for '+name+' '+nonce;
  stages.push(label+'\t'+name);
  const head = h.header(), fields = cat(u64(1000),intent);
  const msg = cat(text('AUKORA/R9/grant'),keyFields(h.keys),u64(0),head,fields);
  const sig = dual(h.keys,msg);
  h.submit(label,cat(Buffer.of(24),head,fields,sig.edSig,sig.mlSig),true);
  return {intent,target};
}
function attempt(p,model,proof,label,reason,accept) {
  const wire = cat(Buffer.of(27),h.header(),p.target,u32(model.length),model,u32(proof.length),proof,p.intent);
  reasons.push(label+'\t'+reason);
  h.submit(label,wire,accept);
}
attempt(prepare('archived'),readFileSync('logs/r9/honest.model'),readFileSync('logs/r9/honest.proof.expr'),
        'exact round-nine bytes model and proof',2,false);
attempt(prepare('weak'),part('weak','model'),part('weak','proof.expr'),
        'old 23-law model lacks successor obligation',8,false);
attempt(prepare('weak-claims-root'),part('weak-claims-root','model'),part('weak-claims-root','proof.expr'),
        'candidate with weaker gate claims current succession law',7,false);
attempt(prepare('bottom'),part('bottom','model'),part('bottom','proof.expr'),
        'unsatisfiable law set has entailment but no inhabitant',7,false);
const same = prepare('same');
attempt(same,part('same','model'),part('same','proof.expr'),'same set and checked entailment',0,true);
const strong = prepare('strong');
attempt(strong,part('strong','model'),part('strong','proof.expr'),'one additional law and checked entailment',0,true);
const again = prepare('same');
attempt(again,part('same','model'),part('same','proof.expr'),'previous root certificate after strengthening',4,false);
attempt(again,part('same','model'),part('same-on-strong','proof.expr'),
        'candidate satisfies root but fails entailment to stronger set',8,false);
const keep = prepare('strong');
attempt(keep,part('strong','model'),part('strong-on-strong','proof.expr'),'strong successor preserves accumulated law',0,true);
h.finish();
const dir = 'v0.2/fixtures/r11-install/';
writeFileSync(dir+'stages.tsv',stages.join('\n')+'\n');
writeFileSync(dir+'reasons.tsv',reasons.join('\n')+'\n');
