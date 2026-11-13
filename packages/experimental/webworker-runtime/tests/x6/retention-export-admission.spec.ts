import { describe, expect, it } from 'vitest'
import { trialScionRetention } from '../../src/x6/scion-growth.ts'

const organ = 'dot-export-control'
const retained = (code: string, args: Record<string, unknown> = {}, expected: Record<string, unknown> = { expect: { ok: true } }) =>
  trialScionRetention({ [organ]: code }, { fixtures: { base: {} }, fixedNow: 0,
    cases: [{ id: 'export-control', args: { organ, fixture: 'base', input: {}, ...args }, ...expected }] })

describe('retention export admission', () => {
  it.each([
    `module.exports={name:'${organ}',run(){return {ok:true}}}`,
    `module.exports={default:{name:'${organ}',run(){return {ok:true}}}}`,
  ])('accepts a named seed export under its entry id', async (code) => {
    expect(await retained(code)).toMatchObject({ ok: true, results: [{ pass: true }] })
  })

  it.each([
    'module.exports={name:"wrong",run(){return {ok:false,error:"UNKNOWN_ACTION"}}}',
    'module.exports={default:{name:"wrong",run(){return {ok:false,error:"UNKNOWN_ACTION"}}}}',
    'module.exports={run(){return {ok:false,error:"UNKNOWN_ACTION"}}}',
    `module.exports={name:'wrong',run(){return {ok:false,error:'UNKNOWN_ACTION'}},default:{name:'${organ}',run(){return {ok:true}}}}`,
    'module.exports={}',
  ])('rejects inadmissible exports without echoing expected refusal text', async (code) => {
    expect(await retained(code, {}, { expectError: 'UNKNOWN_ACTION' })).toMatchObject({ ok: false,
      results: [{ pass: false, got: { ok: false, error: 'PEARL_ORGAN_NOT_MOUNTED' } }] })
  })

  it.each([
    'module.exports=function(ctx){ctx.tools.register("probe",{execute(){return {ok:true}}})}',
    'module.exports={default:function(ctx){ctx.tools.register("probe",{execute(){return {ok:true}}})}}',
    'module.exports={apply(ctx){ctx.tools.register("probe",{execute(){return {ok:true}}})}}',
    'module.exports={default:{apply(ctx){ctx.tools.register("probe",{execute(){return {ok:true}}})}}}',
  ])('retains apply-based tool fixtures in direct and default forms', async (code) => {
    expect(await retained(code, { tool: 'probe' })).toMatchObject({ ok: true, results: [{ pass: true }] })
  })

  it('makes a missing page origin explicit in the organ factory', async () => {
    expect(await retained(`module.exports={name:'${organ}',run(){return {ok: typeof location === 'undefined'}}}`))
      .toMatchObject({ ok: true, results: [{ pass: true }] })
  })


  it.each([
    'module.exports={get run(){throw new Error("UNKNOWN_ACTION")}}',
    'module.exports={get apply(){throw new Error("UNKNOWN_ACTION")}}',
    'module.exports={get default(){throw new Error("UNKNOWN_ACTION")}}',
    'module.exports={default:{get run(){throw new Error("UNKNOWN_ACTION")}}}',
    'module.exports={run(){return {ok:true}},get name(){throw new Error("UNKNOWN_ACTION")}}',
    'Object.defineProperty(module,"exports",{get(){throw new Error("UNKNOWN_ACTION")}})',
    `module.exports={name:'${organ}',run(){return {ok:false,error:'UNKNOWN_ACTION'}},get description(){throw new Error('UNKNOWN_ACTION')}}`,
    `module.exports={name:'${organ}',run(){return {ok:false,error:'UNKNOWN_ACTION'}},get setup(){throw new Error('UNKNOWN_ACTION')}}`,
    'module.exports={apply(){},get description(){throw new Error("UNKNOWN_ACTION")}}',
  ])('normalizes export accessor failures before refusal comparison', async (code) => {
    expect(await retained(code, {}, { expectError: 'UNKNOWN_ACTION' })).toMatchObject({ ok: false,
      results: [{ pass: false, got: { ok: false, error: 'PEARL_ORGAN_NOT_MOUNTED' } }] })
  })

  it('hides globalThis.location despite a browser-like ambient worker origin', async () => {
    // Node worker's ambient global stands in for a browser WorkerLocation; it is not the fixture facade.
    expect(await retained(`global.location={origin:'https://ambient.invalid'};
      module.exports={name:'${organ}',run(){return {ok:
        global.location.origin === 'https://ambient.invalid' && globalThis.location === undefined
        && typeof globalThis.URL === 'function'}}}`))
      .toMatchObject({ ok: true, results: [{ pass: true }] })
  })

  it('preserves descriptor-based global caches and native crypto receivers', async () => {
    expect(await retained(`module.exports={name:'${organ}',run(){
      const key=Symbol.for('dot.descriptor-cache');
      Object.defineProperty(globalThis,key,{value:7,configurable:true});
      const value=globalThis[key]; delete globalThis[key];
      return {ok:value===7 && globalThis[key]===undefined && !!globalThis.crypto};}}`))
      .toMatchObject({ ok: true, results: [{ pass: true, infrastructure: [] }] })
  })

  it('keeps facade I/O subject to the worker restrictions', async () => {
    expect(await retained(`module.exports={name:'${organ}',run(){return globalThis.fetch('https://dot.invalid')}}`))
      .toMatchObject({ ok: false, results: [{ pass: false }] })
  })

  it('keeps external I/O unavailable', async () => {
    expect(await retained(`module.exports={name:'${organ}',run(){return fetch('https://dot.invalid')}}`))
      .toMatchObject({ ok: false, results: [{ pass: false }] })
  })
})
