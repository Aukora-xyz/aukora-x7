import test from 'node:test';
import assert from 'node:assert/strict';
import {createRunnerBudget} from '../runner-budget.mjs';
const DAY=86400000,HASH='a'.repeat(64);
// Transactional durable-state FAKE. Recreated adapters share persisted state;
// serialized copy-on-write models atomicity/rollback, not a live Cloudflare run.
function fake(){let data=new Map(),tail=Promise.resolve();return {transaction(fn){const p=tail.then(async()=>{const draft=structuredClone(data);const tx={get:async k=>structuredClone(draft.get(k)),put:async(k,v)=>draft.set(k,structuredClone(v))};const result=await fn(tx);data=draft;return result;});tail=p.catch(()=>{});return p;}};}
const store=(db,pickId='pick',extra={})=>createRunnerBudget(db,{owner:'owner',world:'world',pickId},extra);
const req=(id,kind='runner',extra={})=>({requestId:`r${id}`,kind,...(kind==='runner'?{minutes:30}:{}),requestHash:HASH,now:0,...extra});
test('600 requested minutes daily durable across picks/restarts; exact UTC retry',async()=>{
 const db=fake();for(let i=0;i<20;i++)await store(db,`pick${i}`).reserve(req(i));
 await assert.rejects(store(db,'new').reserve(req(20)),e=>e.code==='EXEC_RATE_LIMITED'&&e.retryAt===DAY);
 assert.equal((await store(db,'new').reserve(req(20,'runner',{now:DAY}))).dispatch,true);
});
test('each per-pick cap is atomic and never reset by UTC rollover',async()=>{
 for(const [kind,limit,extra] of [['runner',8,{minutes:1}],['commit',12,{}],['card',1,{}],['wake-step',24,{}]]){
  const db=fake();for(let i=0;i<limit;i++)await store(db).reserve(req(i,kind,extra));
  await assert.rejects(store(db).reserve(req(limit,kind,{...extra,now:DAY})),/PICK_RATE_LIMITED/);
 }
 const db=fake();for(let i=0;i<4;i++)await store(db).reserve(req(i));
 await assert.rejects(store(db).reserve(req(4,'runner',{minutes:1})),/PICK_RATE_LIMITED/);
});
test('concurrent reservations cannot overspend single card or last daily minutes',async()=>{
 const db=fake();const outcomes=await Promise.allSettled([store(db).reserve(req(1,'card')),store(db).reserve(req(2,'card'))]);
 assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1);
 const db2=fake();for(let i=0;i<19;i++)await store(db2,`p${i}`).reserve(req(i));
 const last=await Promise.allSettled([store(db2,'p20').reserve(req(20)),store(db2,'p21').reserve(req(21))]);assert.equal(last.filter(x=>x.status==='fulfilled').length,1);
});
test('lost network response keeps reservation; replay never authorizes dispatch',async()=>{
 const db=fake();await store(db).reserve(req(1));
 assert.equal((await store(db).reserve(req(1))).dispatch,false);
 await assert.rejects(store(db).reserve(req(1,'runner',{minutes:1})),/IDEMPOTENCY_CONFLICT/);
 const usage=await store(db).read({action:'logs',now:0});assert.equal(usage.daily.runnerMinutes,30);assert.equal(usage.dispatch,false);
});
test('wake model hard cap note is atomic and once; no hook repeats signal',async()=>{
 const db=fake();for(let i=0;i<288;i++)await store(db).reserve(req(i,'wake-model'));
 for(let i=0;i<2;i++)await assert.rejects(store(db).reserve(req(288,'wake-model')),e=>e.reportNoteRequired===true);
 const hook=async(tx,{day})=>{await tx.put(`note:${day}`,'exhausted');};
 await assert.rejects(store(db,'pick',{onWakeExhausted:hook}).reserve(req(288,'wake-model')),e=>e.code==='WAKE_RATE_LIMITED'&&e.reportNoteRequired===true);
 assert.equal(await db.transaction(tx=>tx.get('note:0')),'exhausted');
 await assert.rejects(store(db,'pick',{onWakeExhausted:()=>{throw Error('must not run');}}).reserve(req(288,'wake-model')),e=>e.reportNoteRequired===false);
 assert.equal((await store(db).reserve(req(288,'wake-model',{now:DAY}))).dispatch,true);
});
test('note failure rolls back marker so retry can persist note',async()=>{
 const db=fake();for(let i=0;i<288;i++)await store(db).reserve(req(i,'wake-model'));
 await assert.rejects(store(db,'pick',{onWakeExhausted:()=>{throw Error('note failed');}}).reserve(req(288,'wake-model')),/note failed/);
 await assert.rejects(store(db).reserve(req(288,'wake-model')),e=>e.reportNoteRequired===true);
});
test('trusted scope isolation, strict input validation and clock rollback',async()=>{
 const db=fake(),s=store(db);await s.reserve(req(1,'runner',{now:100}));
 await assert.rejects(s.reserve(req(2)),/CLOCK_ROLLBACK/);
 for(const extra of [{minutes:0},{minutes:1.5},{minutes:31},{now:NaN},{pickId:'escape'},{owner:'escape'},{requestHash:'bad'}])await assert.rejects(s.reserve(req(2,'runner',extra)),/INVALID_INPUT/);
 await assert.rejects(s.reserve(req(2,'commit',{minutes:1})),/INVALID_INPUT/);
 const other=createRunnerBudget(db,{owner:'other',world:'world',pickId:'pick'});assert.equal((await other.reserve(req(1))).dispatch,true);
 assert.equal((await other.read({action:'status',now:0})).daily.runnerMinutes,30);
});
test('all read actions consume nothing and cannot authorize writes',async()=>{
 const s=store(fake());for(const action of ['status','logs','list','artifacts'])assert.equal((await s.read({action,now:0})).pick.runnerJobs,0);
 await assert.rejects(s.read({action:'runner',now:0}),/INVALID_INPUT/);
 await assert.rejects(s.reserve(req(1,'status')),/INVALID_INPUT/);
});
test('explicit no-pick scope enforces global budgets without phantom pick tally',async()=>{
 const db=fake(),s=store(db,null);
 for(let i=0;i<20;i++)await s.reserve(req(i));
 assert.equal((await s.read({action:'status',now:0})).pick.runnerJobs,0);
 await assert.rejects(s.reserve(req(20)),e=>e.code==='EXEC_RATE_LIMITED'&&e.retryAt===DAY);
 for(const kind of ['commit','card','wake-step'])await assert.rejects(s.reserve(req(30,kind)),/PICK_REQUIRED/);
 assert.equal((await s.reserve(req(31,'wake-model'))).dispatch,true);
});
