/** Trusted HEAD admission accounting only; no route/provider dispatch.
 * Scope and time must be supplied by HEAD, never copied from tool arguments.
 * One durable HEAD storage authority per owner/world; async KV transactions required.
 * Reserve before dispatch. Uncertain outcomes remain charged; no refund API.
 * onWakeExhausted must write through its tx only: transaction callbacks may retry.
 * null pickId means foreground/global accounting, not an anonymous active pick.
 */
export const RUNNER_BUDGET_LIMITS = Object.freeze({runnerMinutesPerUtcDay:600,runnerJobsPerPick:8,runnerMinutesPerPick:120,commitsPerPick:12,cardsPerPick:1,wakeStepsPerPick:24,wakeModelCallsPerUtcDay:288});
const DAY=86400000;
const KEY=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const HASH=/^[a-f0-9]{64}$/;
const WRITES=new Set(['runner','commit','card','wake-step','wake-model']);
const READS=new Set(['status','logs','list','artifacts']);
function error(code,extra={}){return Object.assign(new Error(code),{code,...extra});}
function key(x){if(typeof x!=='string'||!KEY.test(x))throw error('BUDGET_INVALID_INPUT');return x;}
function exact(obj,allowed){if(!obj||typeof obj!=='object'||Array.isArray(obj)||Object.keys(obj).some(k=>!allowed.includes(k)))throw error('BUDGET_INVALID_INPUT');}
function clockValue(now){if(!Number.isSafeInteger(now)||now<0||now>Number.MAX_SAFE_INTEGER-DAY)throw error('BUDGET_INVALID_INPUT');return Math.floor(now/DAY)*DAY;}
export function createRunnerBudget(storage,scope,{onWakeExhausted}={}){
 exact(scope,['owner','world','pickId']);const owner=key(scope.owner),world=key(scope.world),pickId=scope.pickId===null?null:key(scope.pickId);
 if(onWakeExhausted!==undefined&&typeof onWakeExhausted!=='function')throw error('BUDGET_INVALID_INPUT');
 if(typeof storage?.transaction!=='function')throw error('BUDGET_STORAGE_UNAVAILABLE');
 const prefix=`aum456:budget:v1:${JSON.stringify([owner,world])}:`;
 const emptyDay=()=>({runnerMinutes:0,wakeModelCalls:0,wakeExhaustionNoted:false});
 const emptyPick=()=>({runnerMinutes:0,runnerJobs:0,commits:0,cards:0,wakeSteps:0});
 const validateCounters=(value,fields)=>{if(!value||fields.some(k=>!Number.isSafeInteger(value[k])||value[k]<0))throw error('BUDGET_STORAGE_CORRUPT');return value;};
 const usage=async(tx,pickId,day)=>{
  const daily=validateCounters(await tx.get(`${prefix}day:${day}`)??emptyDay(),['runnerMinutes','wakeModelCalls']);
  if(typeof daily.wakeExhaustionNoted!=='boolean')throw error('BUDGET_STORAGE_CORRUPT');
  const pick=validateCounters((pickId===null?undefined:await tx.get(`${prefix}pick:${pickId}`))??emptyPick(),['runnerMinutes','runnerJobs','commits','cards','wakeSteps']);
  return {daily,pick};
 };
 return {
  // Read does not grant dispatch authority and never spends or clears a budget.
  async read(input){
   exact(input,['action','now']);const {action,now}=input;
   if(!READS.has(action))throw error('BUDGET_INVALID_INPUT');const day=clockValue(now);
   return storage.transaction(async tx=>({dispatch:false,charged:false,...await usage(tx,pickId,day),retryAt:day+DAY}));
  },
  async reserve(input){
   exact(input,['requestId','kind','minutes','requestHash','now']);
   const {requestId,kind,requestHash,now}=input;
   key(requestId);const day=clockValue(now);
   if(!WRITES.has(kind)||typeof requestHash!=='string'||!HASH.test(requestHash))throw error('BUDGET_INVALID_INPUT');
   if(pickId===null&&['commit','card','wake-step'].includes(kind))throw error('BUDGET_PICK_REQUIRED');
   const minutes=kind==='runner'?input.minutes:0;
   if(kind==='runner' ? (!Number.isSafeInteger(minutes)||minutes<1||minutes>30) : input.minutes!==undefined)throw error('BUDGET_INVALID_INPUT');
   const result=await storage.transaction(async tx=>{
    const requestKey=`${prefix}request:${requestId}`;
    const prior=await tx.get(requestKey);
    if(prior){
     if(prior.pickId!==pickId||prior.kind!==kind||prior.minutes!==minutes||prior.requestHash!==requestHash)throw error('BUDGET_IDEMPOTENCY_CONFLICT');
     return {dispatch:false,charged:true,replayed:true};
    }
    const previous=await tx.get(`${prefix}clock`);
    if(previous!==undefined&&(!Number.isSafeInteger(previous)||previous<0))throw error('BUDGET_STORAGE_CORRUPT');
    if(previous!==undefined&&now<previous)throw error('BUDGET_CLOCK_ROLLBACK');
    const {pick,daily}=await usage(tx,pickId,day);
    if(kind==='runner'&&daily.runnerMinutes+minutes>600)return {denied:'EXEC_RATE_LIMITED',retryAt:day+DAY,limit:'daily-runner-minutes'};
    const pickLimit=pickId!==null&&((kind==='runner'&&(pick.runnerJobs>=8||pick.runnerMinutes+minutes>120))||(kind==='commit'&&pick.commits>=12)||(kind==='card'&&pick.cards>=1)||(kind==='wake-step'&&pick.wakeSteps>=24));
    if(pickLimit)return {denied:'PICK_RATE_LIMITED',pickId,limit:kind};
    if(kind==='wake-model'&&daily.wakeModelCalls>=288){
     const reportNoteRequired=!daily.wakeExhaustionNoted;
     if(reportNoteRequired&&onWakeExhausted){
      await onWakeExhausted(tx,{owner,world,pickId,day,retryAt:day+DAY});
      daily.wakeExhaustionNoted=true;
     }
     await tx.put(`${prefix}day:${day}`,daily);
     await tx.put(`${prefix}clock`,now);
     return {denied:'WAKE_RATE_LIMITED',retryAt:day+DAY,reportNoteRequired};
    }
    if(kind==='runner'){daily.runnerMinutes+=minutes;pick.runnerMinutes+=minutes;pick.runnerJobs++;}
    if(kind==='commit')pick.commits++;
    if(kind==='card')pick.cards++;
    if(kind==='wake-step')pick.wakeSteps++;
    if(kind==='wake-model')daily.wakeModelCalls++;
    await tx.put(requestKey,{pickId,kind,minutes,requestHash,at:now});
    await tx.put(`${prefix}day:${day}`,daily);
    if(pickId!==null)await tx.put(`${prefix}pick:${pickId}`,pick);
    await tx.put(`${prefix}clock`,now);
    return {dispatch:true,charged:true,replayed:false,reportNoteRequired:false};
   });
   // Denial is raised outside the transaction so the one-time exhaustion marker
   // survives. This signals a note, not proof that a separate note was delivered.
   if(result.denied){const {denied,...detail}=result;throw error(denied,detail);}
   return result;
  },
 };
}
