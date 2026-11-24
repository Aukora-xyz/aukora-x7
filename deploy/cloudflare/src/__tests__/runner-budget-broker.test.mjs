import assert from 'node:assert/strict'
import test from 'node:test'
import { createRunnerPickScope, reserveRunnerMinutesAtHead } from '../runner-budget-broker.mjs'

const seedId='a'.repeat(64), requestId='b'.repeat(24), requestHash='c'.repeat(64)
function fixture(reply) {
  const calls=[]
  return {
    calls,
    head:{
      idFromName(name){return name},
      get(id){return {async fetch(request){calls.push([id,request]);return reply()}}}
    }
  }
}
test('sends one bounded reservation to the internal HEAD binding before a caller can dispatch',async()=>{
  const f=fixture(()=>Response.json({ok:true,reservedMinutes:30,dispatch:true}))
  assert.deepEqual(await reserveRunnerMinutesAtHead({head:f.head,seedId,requestId,requestHash,minutes:30}),{ok:true})
  const [id,req]=f.calls[0]
  assert.equal(id,'node-main-v1')
  assert.equal(new URL(req.url).pathname,'/_head/runner-budget-v1')
  assert.equal(req.headers.get('x-x6-internal-authorized'),'1')
  assert.equal(req.headers.get('x-x6-bootstrap-seed'),seedId)
  assert.deepEqual(await req.json(),{minutes:30,requestId,requestHash})
})
test('known exhaustion keeps retryAt; missing/corrupt HEAD fails closed without fallback',async()=>{
  const f=fixture(()=>Response.json({code:'EXEC_RATE_LIMITED',retryAt:86400000},{status:429}))
  await assert.rejects(reserveRunnerMinutesAtHead({head:f.head,seedId,requestId,requestHash,minutes:1}),e=>e.code==='EXEC_RATE_LIMITED'&&e.retryAt===86400000)
  for(const g of [
    fixture(()=>Response.json({ok:true,reservedMinutes:0})),
    fixture(()=>Response.json({ok:true,reservedMinutes:1,dispatch:false})),
    fixture(()=>{throw Error('interrupted')}),
    fixture(()=>Response.json({code:'EXEC_RATE_LIMITED',retryAt:'guess'},{status:429})),
  ]) {
    await assert.rejects(reserveRunnerMinutesAtHead({head:g.head,seedId,requestId,requestHash,minutes:1}),/EXEC_BUDGET_UNAVAILABLE/)
    assert.equal(g.calls.length,1)
  }
  await assert.rejects(reserveRunnerMinutesAtHead({head:f.head,seedId:'bad',requestId,requestHash,minutes:1}),/EXEC_BUDGET_UNAVAILABLE/)
  assert.equal(f.calls.length,1)
})

test('the host-scoped runner reservation carries a PICK and preserves its terminal refusal',async()=>{
  const pickScope=createRunnerPickScope('fixture-pick')
  const f=fixture(()=>Response.json({code:'PICK_RATE_LIMITED'},{status:429}))
  await assert.rejects(reserveRunnerMinutesAtHead({head:f.head,seedId,requestId,requestHash,minutes:1,pickScope}),
    error=>error.code==='PICK_RATE_LIMITED'&&error.status===429)
  assert.deepEqual(await f.calls[0][1].json(),{minutes:1,requestId,requestHash,pickId:'fixture-pick'})
})
