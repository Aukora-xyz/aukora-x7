// Reach the conflicting frozen safety/availability conditions from real genesis.
import assert from 'node:assert/strict';
import {cat,host,owner,text} from './host.mjs';
import {safeControl} from './safe-fields.mjs';

const h = host(), first = owner(), second = owner();
assert.equal(h.consume(cat(first.edRaw,first.mlRaw),'init'),1);
h.submit('signed version-two halt from genesis',safeControl(h,50,first,0),true);
assert.equal(h.api.halted(),1);
h.submit('valid tag-zero speech while halted',h.unsigned(cat(Buffer.of(0),text('recorded while halted'))),true);
assert.equal(h.api.halted(),1);
h.submit('signed version-two clear under H5',safeControl(h,51,first,0),true);
assert.equal(h.api.halted(),0);
h.submit('version-two rebind to different keys',safeControl(h,53,first,0,{newKeys:second}),true);
h.submit('old key pair after rebind',safeControl(h,50,first,1),false);
h.submit('new key pair after rebind',safeControl(h,50,second,1),true);
assert.equal(h.api.halted(),1);
console.log('Reachable ff-prefixed admissions, changed current owner, and baseline speech during halt.');
