// Frozen public bytes and independently specified verdicts. --write creates the
// fixture with ephemeral signing keys; the regular replay uses only public bytes.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {gzipSync,gunzipSync} from 'node:zlib';
import {blob,cat,deliver,encoders,host,owner,sha,text,u64} from './host.mjs';
const out = new URL('../vectors/cell12/',import.meta.url);
const pin = sha(Buffer.from('shadow cell pin')), input = sha(Buffer.from('input')), output = sha(Buffer.from('output'));
const opt = d => d ? cat(Buffer.of(1),d) : Buffer.of(0);
function create() {
  const keys = owner(), rows=[], wires=[];
  let head=Buffer.alloc(32), n=0;
  const header = () => cat(head,u64(n+1)), {grant,unsigned} = encoders(header);
  function add(label,w,ok) {
    if (ok) {head=sha(w); n++;}
    rows.push([label,w.length,Number(ok),head.toString('hex')].join('\t'));
    wires.push(w);
    return n;
  }
  const body=(name='search',op='lookup',i=input,o=output,status='ok') => cat(text(name),pin,text(op),opt(i),opt(o),text(status));
  const framed=(tag,b,version=3)=>cat(Buffer.of(255,version,tag),header(),b);
  const cell=(...args)=>framed(1,body(...args));
  const say=s=>unsigned(cat(Buffer.of(0),text(s)));
  const canon=['cell','search',pin.toString('hex'),'lookup',input.toString('hex'),output.toString('hex'),'ok'].join(' ');
  const speech=add('canonical say '+canon,say(canon),true);
  const receipt=add('canonical cell '+canon,cell(),true);
  const noOutput=add('receipt without output',cell('search','lookup',null,null,'skipped'),true);
  const intent=deliver(Buffer.from('receipt acknowledgement'),0,19);
  add('hybrid grant for ordinary delivery',grant(keys,intent),true);
  const claim=(r,confidence=0)=>cat(sha(intent),Buffer.of(64,1,4,confidence,1),u64(r),Buffer.of(0));
  const act=a=>cat(Buffer.of(23),sha(a),header(),Buffer.of(4),intent);
  function cite(label,r,expected,confidence=0) {
    const a=framed(2,claim(r,confidence));
    add('assessment '+label,a,true);
    add('cited act '+label,act(a),expected);
  }
  cite('speech carrying identical text',speech,false);
  cite('receipt without output',noOutput,false);
  cite('self reference',n+1,false);
  cite('forward reference',n+2,false);
  cite('confidence above receipt bound',receipt,false,1);
  cite('prior committed output',receipt,true);
  add('v2 assessment rejects version-three claim',framed(40,claim(receipt),2),false);
  add('v2 has no cell tag',framed(1,body(),2),false);
  add('unknown version',framed(1,body(),4),false);
  const seed=cell();
  for (const cut of [0,1,2,3,5,11,41,42,45,59,66,99,110,seed.length-1])
    add('incomplete cell length '+cut,seed.subarray(0,cut),false);
  add('cell trailing byte',cat(seed,Buffer.of(0)),false);
  add('unregistered version-three opcode',framed(22,body()),false);
  const parent=Buffer.from(seed);parent[3]^=1;
  add('different parent',parent,false);
  const wrongSeq=Buffer.from(seed);wrongSeq[35]^=1;
  add('different sequence',wrongSeq,false);
  for (const [label, args] of [
    ['empty name',['']],['overlong name',['x'.repeat(65)]],['whitespace op',['search','bad op']],
    ['non-ascii status',['search','lookup',input,output,'ä']],['empty status',['search','lookup',input,output,'']]])
    add(label,cell(...args),false);
  const badOptional=cat(text('search'),pin,text('lookup'),Buffer.of(2),opt(output),text('ok'));
  add('bad optional digest discriminant',framed(1,badOptional),false);
  const states=['ok','error','skipped'];
  for(let k=0; rows.length<200; k++){
    const d=sha(Buffer.from('local call '+k));
    const name=k===0?'z'.repeat(64):'worker-'+k;
    add('typed cell '+k,cell(name,'op_'+(k%7),k%2?null:d,k%3?d:null,states[k%3]),true);
  }
  mkdirSync(out,{recursive:true});
  writeFileSync(new URL('keys.bin',out),cat(keys.edRaw,keys.mlRaw));
  writeFileSync(new URL('frames.bin.gz',out),gzipSync(cat(...wires),{level:9}));
  writeFileSync(new URL('cases.tsv',out),rows.join('\n')+'\n');
  console.log(rows.length,'vectors authored,',n,'expected admissions and head',head.toString('hex'));
}
if (process.argv.includes('--write')) {
  create();
} else {
  const keys=readFileSync(new URL('keys.bin',out));
  const bin=gunzipSync(readFileSync(new URL('frames.bin.gz',out)));
  const rows=readFileSync(new URL('cases.tsv',out),'utf8').trimEnd().split('\n');
  assert.equal(rows.length,200);
  let expectedHead;
  for(const profile of ['aukora-core.wasm','aukora-core-lite.wasm']) {
    const file=readFileSync(new URL('../'+profile,import.meta.url)), h=host(file);
    assert.equal(h.consume(keys,'init'),1);
    let pos=0, entry=0;const kept=[];
    for(const row of rows) {
      const [label,length,v,head]=row.split('\t');
      const w=bin.subarray(pos,pos+Number(length));pos+=w.length;
      assert.equal(h.consume(w,'step'),Number(v),profile+' '+label);
      if(v==='1') {
        const actual=Buffer.from(Array.from({length:w.length},(_,i)=>h.api.recordByte(entry,i)));
        assert.deepEqual(actual,w,label+' stored bytes');
        kept.push(actual);
        assert.equal(h.api.recordByte(entry,w.length),256);
        entry++;
      }
      assert.equal(Buffer.from(Array.from({length:32},(_,i)=>h.api.head(i))).toString('hex'),head,label);
    }
    assert.equal(pos,bin.length);
    const fresh=host(file);assert.equal(fresh.consume(keys,'init'),1);
    for(const w of kept)assert.equal(fresh.consume(w,'step'),1);
    const replayed=Buffer.from(Array.from({length:32},(_,i)=>fresh.api.head(i))).toString('hex');
    const head=rows.at(-1).split('\t').at(-1);
    assert.equal(replayed,head);
    if(expectedHead)assert.equal(replayed,expectedHead);
    expectedHead=head;
    console.log(profile,rows.length,'matched,',entry,'admitted; fresh instance replay head',head);
  }
}
