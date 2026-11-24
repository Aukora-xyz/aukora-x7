// Assemble detached public fixtures with independently specified verdicts and heads.
import {mkdirSync,writeFileSync} from 'node:fs';
import {gzipSync} from 'node:zlib';
import {cat,encoders,owner,sha,u64} from './host.mjs';

export function vectorSession(name) {
  if (!/^r11-[a-z0-9-]+$/.test(name)) throw Error('group name');
  const keys = owner(), frames = [], rows = [];
  let head = Buffer.alloc(32), position = 0;
  const header = () => cat(head,u64(position+1));
  function submit(label,wire,expected) {
    if (/[\t\n]/.test(label) || typeof expected !== 'boolean') throw Error(label);
    if (expected) { head = sha(wire); position++; }
    frames.push(wire);
    rows.push([label,wire.length,Number(expected),head.toString('hex')].join('\t'));
  }
  function finish() {
    const dir = 'v0.2/fixtures/'+name;
    mkdirSync(dir,{recursive:true});
    writeFileSync(dir+'/keys.bin',cat(keys.edRaw,keys.mlRaw));
    writeFileSync('v0.2/vectors/'+name+'.tsv',rows.join('\n')+'\n');
    writeFileSync('v0.2/vectors/'+name+'.bin.gz',gzipSync(cat(...frames),{level:9}));
    console.log(name,rows.length,'vectors,',position,'admissions');
  }
  return {keys,header,submit,historyLength:()=>position,finish,...encoders(header)};
}
