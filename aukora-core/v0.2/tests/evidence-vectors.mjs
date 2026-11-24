import {vectorSession} from './vectors11.mjs';
import {cat,deliver,dual,keyFields,sha,text,u64} from './host.mjs';

function evidence(h) {
  const env = (code,body) => cat(Buffer.of(255,2,code),h.header(),body);
  const claim = (kind,value,refs=[],query=null) => cat(Buffer.of(kind,value,refs.length),...refs.map(u64),
    query ? cat(Buffer.of(1),query) : Buffer.of(0));
  const assessment = (i,claims) => env(40,cat(sha(i),Buffer.of(64,claims.length),...claims));
  const read = (q,a,b,empty,n) => env(41,cat(Buffer.of(0),q,u64(a),u64(b),Buffer.of(empty),sha(Buffer.from('result')),Buffer.of(n)));
  const source = (name,n) => env(41,cat(Buffer.of(1),text(name),sha(Buffer.from('statement')),Buffer.of(n)));
  const outcome = (i,result,corrected,n) => env(41,cat(Buffer.of(2),i,Buffer.of(result,corrected,n)));
  const premise = c => env(42,c);
  const ceiling = (n,ed=true,ml=true) => {
    const signed = dual(h.keys,cat(text('AUKORA/R9/R11/ceiling'),keyFields(h.keys),u64(0),h.header(),Buffer.of(n)),ed,ml);
    return env(43,cat(Buffer.of(n),signed.edSig,signed.mlSig));
  };
  const act = (i,wire) => cat(Buffer.of(23),sha(wire),h.header(),Buffer.of(4),i);
  return {env,claim,assessment,read,source,outcome,premise,ceiling,act};
}

{
  const h = vectorSession('r11-evidence');
  const {claim,assessment,read,source,outcome,premise,ceiling,act} = evidence(h);
  const q = sha(Buffer.from('query as submitted')), q2 = sha(Buffer.from('different scope'));
  const i = deliver(Buffer.from('result'),0,7);
  const record = (label,wire) => { h.submit(label,wire,true); return h.historyLength(); };
  record('grant authorizes exact delivery',h.grant(h.keys,i));
  h.submit('ceiling requires Ed25519',ceiling(80,false,true),false);
  h.submit('ceiling requires ML-DSA',ceiling(80,true,false),false);
  record('ceiling approved at 80',ceiling(80));
  h.submit('search window finishes after read position',read(q,1,8,1,210),false);
  h.submit('search window is reversed',read(q,2,1,1,210),false);
  const r = record('empty result records query and inclusive window',read(q,1,3,1,210));
  const nonempty = record('nonempty result with same query',read(q,1,3,0,210));
  h.submit('missing named source',source('',190),false);
  const src = record('statement by named source',source('Sam',190));
  const out = record('recorded outcome with value',outcome(i,0,0,120));
  h.submit('unlabelled change to recorded outcome',outcome(i,1,0,120),false);
  record('labelled outcome correction',outcome(i,1,1,100));
  const guess = record('earlier guessed claim',premise(claim(3,75)));
  const seen = record('earlier observed claim',premise(claim(0,205,[r],q)));
  const rep = record('earlier reported claim',premise(claim(1,180,[src])));
  const low = record('earlier inferred claim, weaker bound 80',premise(claim(2,79,[seen,guess,rep])));
  const chain = record('third level of inference',premise(claim(2,78,[low,seen])));
  const bad = record('invalid earlier premise recorded for audit',premise(claim(0,211,[r])));
  const wrongAbsence = record('invalid absence retained as a premise',premise(claim(0,100,[r],q2)));
  const badRef = record('unresolved historical premise',premise(claim(0,0,[99999])));

  function failed(label,c) {
    const wire = assessment(i,[c]);
    record('record assessment '+label,wire);
    h.submit(label,act(i,wire),false);
  }
  for (const [label,c] of [
    ['missing zero position',claim(0,0,[0])],['after act',claim(0,0,[1000])],
    ['observed on named source',claim(0,100,[src])],['reported on read',claim(1,100,[r])],
    ['inferred straight from read',claim(2,40,[r])],['observed on earlier claim',claim(0,0,[seen])],
    ['reported on outcome',claim(1,0,[out])],['guess with a reference',claim(3,1,[r])],
    ['observed without reference',claim(0,0)],['reported without reference',claim(1,0)],
    ['inference without premises',claim(2,0)],['two refs for a direct observation',claim(0,1,[r,r])],
    ['read recorded value exceeded',claim(0,211,[r])],['named source recorded value exceeded',claim(1,191,[src])],
    ['outcome recorded value exceeded',claim(0,121,[out])],['one higher than guessed ceiling',claim(3,81)],
    ['minimum of multiple premise bounds exceeded',claim(2,81,[seen,low])],
    ['computed bound along chain exceeded',claim(2,81,[chain])],['overstated ancestor',claim(2,1,[bad])],
    ['bad absence in ancestor',claim(2,1,[wrongAbsence])],['unresolved reference in ancestor',claim(2,0,[badRef])],
    ['quote different query',claim(0,0,[r],q2)],['searched but result nonempty',claim(0,0,[nonempty],q)],
    ['outcome cannot witness search',claim(0,0,[out],q)],['guess cannot witness search',claim(3,0,[],q)],
    ['reclassify seen as guess retaining reference',claim(3,0,[r])],
  ]) failed(label,c);
  failed('assessment refers to itself',claim(0,0,[h.historyLength()+1]));
  failed('assessment refers to act position',claim(0,0,[h.historyLength()+2]));
  const after = assessment(i,[claim(0,1,[h.historyLength()+2],q)]);
  record('assessment preceding claimed read',after);
  record('later read precedes act but follows its claim',read(q,1,h.historyLength(),1,210));
  h.submit('search must precede claim',act(i,after),false);
  const multi = assessment(i,[claim(0,209,[r],q),claim(1,191,[src])]);
  record('assessment with one good and one bad claim',multi);
  h.submit('every listed claim required',act(i,multi),false);
  const good = assessment(i,[claim(0,210,[r],q),claim(1,190,[src]),claim(2,80,[chain]),claim(3,80),claim(0,120,[out])]);
  record('all classes valid at inclusive bounds',good);
  record('lower current ceiling to 70',ceiling(70));
  h.submit('lower ceiling invalidates historical guess through inference',act(i,good),false);
  record('raise ceiling back to 90',ceiling(90));
  failed('raising ceiling cannot enlarge old premise',claim(2,81,[guess]));
  const final = assessment(i,[claim(0,208,[r],q),claim(1,186,[src]),claim(2,78,[chain]),claim(3,90)]);
  record('weakened confidence and current guess at ceiling',final);
  h.submit('eligible act names every admitted claim',act(i,final),true);
  h.finish();
}

{
  const h = vectorSession('r11-fields');
  const e = evidence(h), q = sha(Buffer.from('window'));
  const i = deliver(Buffer.from('payload'),0,4);
  const fields = [
    ['assessment',e.assessment(i,[e.claim(2,9,[1,2,3]),e.claim(0,77,[1],q)])],
    ['read',e.read(q,0,1,1,255)],['named-statement',e.source('Lab',255)],
    ['premise',e.premise(e.claim(0,120,[1],q))],['outcome',e.outcome(i,0,0,64)],
  ];
  for (const [name,wire] of fields) {
    // Every length has an incomplete mandatory field, including query/window/ref lengths.
    for (let width=3;width<wire.length;width++) {
      h.submit(name+' truncated at '+width,wire.subarray(0,width),false);
    }
    for (const value of [0,1,127,255]) h.submit(name+' trailing '+value,cat(wire,Buffer.of(value)),false);
  }
  const valid = e.read(q,0,1,1,255);
  h.submit('complete search after truncation probes',valid,true);
  h.finish();
}
