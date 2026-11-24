import assert from 'node:assert/strict'
import test from 'node:test'
import { X61HeadDurableObject } from '../head-do.mjs'
import { RUNNER_BUDGET_PATH } from '../runner-budget-broker.mjs'
import { createRunnerBudget } from '../runner-budget.mjs'

const SEED = 'a'.repeat(64), BALL = 'b'.repeat(64), SHA = 'c'.repeat(64)
const scope = { owner: 'owner', world: 'node-main-v1', pickId: null }
function fixture(t, options = {}) {
  let rows = new Map([['bootstrap:v1', {phase:'complete', seedId:SEED}], ['head:current',{ballId:BALL,epoch:2,entries:{}}]])
  if (options.wish) rows.set('head:wish:active', options.wish)
  let now = 1000, tail = Promise.resolve()
  const storage = {
    async get(key) { return structuredClone(rows.get(key)) },
    async put(key,value) { rows.set(key,structuredClone(value)) },
    transaction(operation) {
      const result = tail.then(async () => {
        const staged = structuredClone(rows)
        const value = await operation({
          get: async key => structuredClone(staged.get(key)),
          put: async (key, value) => staged.set(key, structuredClone(value)),
          delete: async key => staged.delete(key),
          list: async ({prefix='',limit=Infinity}={}) => new Map([...staged].filter(([key])=>key.startsWith(prefix)).slice(0,limit)),
        })
        rows = staged
        return value
      })
      tail = result.catch(()=>{})
      return result
    }
  }
  const create = () => {
    const head = new X61HeadDurableObject({storage,getWebSockets:()=>[]},
      options.wish ? { WAKE_EXECUTOR_ENABLED:'1', DEEPSEEK_API_KEY:'synthetic-provider',
        PROVIDER_BUDGET_WINDOW_MS:'3600000', PROVIDER_BUDGET_REQUESTS:'2', PROVIDER_BUDGET_TOKENS:'1000000',
        PROVIDER_MAX_OUTPUT_TOKENS:'400' } : {}, { now:()=>now })
    t.after(()=>head.wakeStore.dispose())
    return head
  }
  return {storage,create,now:()=>now,setNow:(v)=>{now=v}}
}
const body = (n,minutes) => ({minutes,requestHash:SHA,requestId:'a'.repeat(20)+n})
async function reserve(head,input,headers={}) {
  const response=await head.fetch(new Request('https://x61.internal'+RUNNER_BUDGET_PATH,{
    method:'POST',body:JSON.stringify(input),
    headers:{'content-type':'application/json','x-x6-internal-authorized':'1','x-x6-bootstrap-seed':SEED,...headers}
  }))
  return {status:response.status,value:await response.json()}
}
test('authenticated HEAD persists the 600-minute ceiling across object reconstruction',async t=>{
  const f=fixture(t)
  const before=f.create()
  for(let n=0;n<20;n++) assert.equal((await reserve(before,body(n,30))).value.dispatch,true)
  const after=f.create()
  const capped=await reserve(after,body(21,1))
  assert.equal(capped.status,429)
  assert.equal(capped.value.code,'EXEC_RATE_LIMITED')
  assert.equal(capped.value.retryAt,86400000)
  assert.equal((await reserve(after,body(0,30))).value.dispatch,false)
  f.setNow(capped.value.retryAt)
  assert.equal((await reserve(after,body(22,1))).value.dispatch,true)
})
test('HEAD refuses absent internal authority and wrong bootstrap without creating a reservation',async t=>{
  const f=fixture(t), head=f.create()
  assert.equal((await reserve(head,body(1,30),{'x-x6-internal-authorized':'0'})).status,401)
  assert.equal((await reserve(head,body(1,30),{'x-x6-bootstrap-seed':'d'.repeat(64)})).status,503)
  const counts=await createRunnerBudget(f.storage,scope).read({action:'status',now:f.now()})
  assert.equal(counts.daily.runnerMinutes,0)
})
test('288 wake calls blocks any further provider I/O and leaves a durable host note',async t=>{
  const f=fixture(t,{wish:{wish_id:'budget-wish',intent:'Inspect fixed facts',acceptance:'Record facts',status:'running',stepsCompleted:0,maxSteps:6}})
  const budget=createRunnerBudget(f.storage,scope)
  for(let n=0;n<288;n++) await budget.reserve({requestId:'wake-test-'+n,kind:'wake-model',requestHash:SHA,now:f.now()})
  t.mock.method(globalThis,'fetch',()=>assert.fail('provider must not be called'))
  const outcome=await f.create().executeCloudWakeStep({now:f.now()})
  assert.equal(outcome.reason,'wake_model_daily_limit')
  const wish=await f.storage.get('head:wish:active')
  assert.equal(wish.status,'day_limit')
  assert.match(JSON.stringify(wish.notes),/288 model calls/)
})

for (const [jobs, minutes] of [[8, 15], [4, 30]]) {
  test(`trusted internal PICK admits ${jobs} jobs at ${minutes} minutes across HEAD reconstruction`, async t => {
    const f = fixture(t), pickId = 'fixture-pick'
    const before = f.create()
    for (let n = 0; n < jobs; n++) {
      const result = await reserve(before, { ...body('pick-job-' + n, minutes), pickId })
      assert.equal(result.status, 200)
      assert.equal(result.value.reservedMinutes, minutes)
      assert.equal(result.value.dispatch, true)
    }
    const after = f.create()
    const capped = await reserve(after, { ...body('pick-next', 1), pickId })
    assert.deepEqual([capped.status, capped.value.code], [429, 'PICK_RATE_LIMITED'])
    assert.equal(Object.hasOwn(capped.value, 'retryAt'), false)
    assert.equal((await reserve(after, body('foreground', 1))).value.dispatch, true)
    const counts = await createRunnerBudget(f.storage, { ...scope, pickId }).read({ action: 'status', now: f.now() })
    assert.equal(counts.pick.runnerJobs, jobs)
    assert.equal(counts.pick.runnerMinutes, 120)
    assert.equal(counts.daily.runnerMinutes, 121)
  })
}

test('a normal wake admits one step, one quota reservation and the request row before the provider call', async t => {
  const f = fixture(t, { wish: { wish_id: 'budget-normal-wish', intent: 'Inspect fixed facts',
    acceptance: 'Leave a short observation', status: 'running', stepsCompleted: 0, maxSteps: 6 } })
  const head = f.create()
  let sent = 0
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    sent++
    assert.equal(await f.storage.get('head:wake:daily:1970-01-01'), 1)
    assert.equal((await createRunnerBudget(f.storage, scope).read({ action: 'status', now: f.now() })).daily.wakeModelCalls, 1)
    assert.equal((await f.storage.get('provider-budget:v1:deepseek')).requests, 1)
    const row = await f.storage.get('head:transcript:row:1')
    assert.equal(row.role, 'system')
    assert.deepEqual(JSON.parse(row.content).request, JSON.parse(init.body))
    return Response.json({ choices: [{ message: { content: 'Observed fixed facts.' } }] })
  })
  const outcome = await head.executeCloudWakeStep({ now: f.now() })
  assert.equal(outcome.status, 'success')
  assert.equal(sent, 1)
  assert.equal((await f.storage.get('head:wish:active')).stepsCompleted, 1)
})
