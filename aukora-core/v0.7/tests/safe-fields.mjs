import {cat,dual,keyFields,text} from './host.mjs';

const decimal = n => cat(Buffer.from(String(n)), Buffer.of(0));
export function safeHeader(h,op,sequence = h.historyLength()+1,parent = h.header().subarray(0,32)) {
  return cat(Buffer.of(255,2,op),parent,decimal(sequence));
}
export function safeControl(h,op,active,generation,{newKeys,goodEd = true,goodMl = true,
    signer = active,prefix = safeHeader(h,op)} = {}) {
  const wire = newKeys ? cat(prefix,newKeys.edRaw,newKeys.mlRaw) : prefix;
  const msg = cat(text('AUKORA/R11/safe'),keyFields(active),decimal(generation),wire);
  const {edSig,mlSig} = dual(signer,msg,goodEd,goodMl);
  return cat(wire,edSig,mlSig);
}
