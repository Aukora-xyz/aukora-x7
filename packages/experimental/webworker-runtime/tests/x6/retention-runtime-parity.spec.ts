import { describe, expect, it } from 'vitest'
import { trialScionCandidate, trialScionRetention } from '../../src/x6/scion-growth.ts'

const trial = (code: string, peers: Record<string, string> = {}) => trialScionRetention({ target: code, ...peers }, {
  fixedNow: 0, fixtures: { base: {} }, cases: [{ id: 'probe', args: { organ: 'target', fixture: 'base', input: {} }, expect: { ok: true } }],
})
const nonSeeds = [
  'module.exports={name:"target",apply(){},run(){return {ok:true}}}',
  'module.exports=Object.assign(function(){},{run(){return {ok:true}}})',
  'module.exports={default:{name:"target",apply(){},run(){return {ok:true}}}}',
  'module.exports={default:Object.assign(function(){},{run(){return {ok:true}}})}',
  'module.exports={apply(){},default:{name:"target",run(){return {ok:true}}},run(){return {ok:true}}}',
]

describe('retention runtime parity', () => {
  it.each(nonSeeds)('does not call a plugin-only export as a Seed organ', async (code) => {
    expect(await trial(code)).toMatchObject({ ok: false, results: [{ pass: false,
      infrastructure: [{ phase: 'export', code: 'PEARL_ORGAN_NOT_MOUNTED', subject: 'target' }] }] })
  })
  it.each(nonSeeds)('does not call a plugin-only peer as a Seed organ', async (code) => {
    const result = await trial('module.exports={name:"target",async run(_,ctx){try {await ctx.organs.call("peer",{})} catch {} return {ok:true}}}', {
      peer: code.replaceAll('target', 'peer'),
    })
    expect(result).toMatchObject({ ok: false, results: [{ infrastructure: [{ phase: 'export', subject: 'peer' }] }] })
  })
  it('preserves sloppy organ semantics while the harness caller remains private', async () => {
    const result = await trial('module.exports={name:"target",run(){const obj={};Object.freeze(obj);obj.x=1;return {ok:obj.x===undefined}}}')
    expect(result).toMatchObject({ ok: true, results: [{ infrastructure: [] }] })
  })
  it.each([
    'ctx.presence', 'ctx.web', 'ctx.systemPrompt', 'ctx.configEditor', 'ctx.agentPresets', 'ctx.scion', 'ctx.checkpointPolicy', 'ctx.wasm',
    '"presence" in ctx', 'Object.hasOwn(ctx,"presence")', 'Object.keys(ctx)',
    'globalThis.process.env', 'process.env', '"env" in process', 'Object.hasOwn(process,"env")', 'Object.keys(process)',
  ])('records missing environment/service reads: %s', async (access) => {
    const result = await trial(`module.exports={name:'target',run(_,ctx){void (${access});return {ok:true}}}`)
    expect(result).toMatchObject({ ok: false, results: [{ pass: false, infrastructure: [{ phase: 'dependency', subject: 'target' }] }] })
  })
  it('supplies getBuiltinModule through the guarded builtin/VFS adapter', async () => {
    expect(await trial('module.exports={name:"target",run(){const fs=globalThis.process.getBuiltinModule("fs");fs.writeFileSync("/probe","yes");return {ok:fs.readFileSync("/probe","utf8")==="yes"}}}'))
      .toMatchObject({ ok: true, results: [{ infrastructure: [] }] })
  })
  it('keeps getBuiltinModule refusals observable when caught', async () => {
    expect(await trial('module.exports={name:"target",run(){try {process.getBuiltinModule("unavailable")} catch {} return {ok:true}}}'))
      .toMatchObject({ ok: false, results: [{ infrastructure: [{ phase: 'import', subject: 'target' }] }] })
  })
  it.each([63, 64])('retains saturation evidence after %i guard failures and a missing peer', async (count) => {
    const result = await trial(`module.exports={name:'target',async run(_,ctx){for(let i=0;i<${String(count)};i++){try {fetch('https://fixture.invalid')} catch {}}try {await ctx.organs.call('missing',{})} catch {} return {ok:true}}}`)
    const records = result.results[0]?.infrastructure as Array<{ phase: string; subject: string | null }>
    expect(records).toHaveLength(64)
    expect(records[63]).toMatchObject({ phase: 'overflow', subject: null })
    expect(result.ok).toBe(false)
  })
  it('preserves peer subject on caught guard failures', async () => {
    const result = await trial('module.exports={name:"target",async run(_,ctx){await ctx.organs.call("peer",{});return {ok:true}}}', {
      peer: 'module.exports={name:"peer",run(){try {fetch("https://fixture.invalid")} catch {} return {ok:true}}}',
    })
    expect(result).toMatchObject({ ok: false, results: [{ infrastructure: [{ phase: 'guard', subject: 'peer' }] }] })
  })
  it('does not misattribute a detached peer guard to the target', async () => {
    const result = await trial('module.exports={name:"target",async run(_,ctx){await ctx.organs.call("peer",{});await new Promise(r=>setTimeout(r,15));return {ok:true}}}', {
      peer: 'module.exports={name:"peer",run(){setTimeout(()=>{try{fetch("https://fixture.invalid")}catch{}},0);return {ok:true}}}',
    })
    expect(result, JSON.stringify(result)).toMatchObject({ ok: false, results: [{ infrastructure: [{ phase: 'guard', subject: null }] }] })
  })
  it('marks overlapping subject scopes incomplete rather than guessing the owner', async () => {
    const result = await trial('module.exports={name:"target",async run(_,ctx){await Promise.all([ctx.organs.call("peer",{}),ctx.organs.call("other",{})]);return {ok:true}}}', {
      peer: 'module.exports={name:"peer",async run(){await Promise.resolve();return {ok:true}}}',
      other: 'module.exports={name:"other",async run(){await Promise.resolve();await Promise.resolve();return {ok:true}}}',
    })
    expect(result.ok).toBe(false)
    expect(result.results[0]?.infrastructure).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'PEARL_SUBJECT_AMBIGUOUS' })]))
  })
  it('does not claim observed framing for parent timeout rows', async () => {
    const result = await trialScionCandidate({ name: 'target', code: 'module.exports={name:"target",run(){while(true){}}}',
      cases: [{ id: 'timeout', args: {}, expect: { ok: true } }], timeoutMs: 50 })
    expect(result).toMatchObject({ ok: false, error: 'CANDIDATE_TRIAL_TIMEOUT', routeEvidence: { status: 'inconclusive' } })
    expect(result.routeEvidence?.checkedProperties).not.toContain('exact-case-result-framing')
  })
})
