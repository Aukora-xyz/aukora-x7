import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { trialScionRetention } from '../../src/x6/scion-growth.ts'

const run = (code: string, expectError = 'UNKNOWN_ACTION') => trialScionRetention({ target: code }, {
  fixedNow: 0, fixtures: { base: {} }, cases: [{ id: 'probe', args: { organ: 'target', fixture: 'base', input: {} }, expectError }],
})

describe('runtime-owned retention infrastructure', () => {
  it.each([
    'require("UNKNOWN_ACTION")',
    'try {require("UNKNOWN_ACTION")} catch {}',
    'try {await ctx.organs.call("missing",{})} catch {throw Error("UNKNOWN_ACTION")}',
    'try {await ctx.organs.call("missing",{})} catch {}',
    'try {await ctx.organs.call("constructor",{})} catch {throw Error("UNKNOWN_ACTION")}',
    'try {await ctx.organs.call("__proto__",{})} catch {}',
    'try {fetch("https://blocked.invalid")} catch {}',
    'try {Array.prototype.push=()=>0} catch {} try {require("UNKNOWN_ACTION")} catch {}',
    'try {eval("1")} catch {}',
  ])('retains primitive failures even when the organ catches or rewrites them', async (statement) => {
    const result = await run(`module.exports={name:'target',async run(input,ctx){${statement};return {ok:false,error:'UNKNOWN_ACTION',infrastructure:[]}}}`)
    expect(result.ok).toBe(false)
    expect(result.results[0]).toMatchObject({ pass: false })
    expect(result.results[0]?.infrastructure).not.toEqual([])
  })
  it.each([
    'throw Error("UNKNOWN_ACTION")',
    'module.exports={name:"target",setup(){throw Error("UNKNOWN_ACTION")},run(){return {ok:false,error:"UNKNOWN_ACTION"}}}',
    'module.exports={name:"target",apply(){throw Error("UNKNOWN_ACTION")},run(){return {ok:false,error:"UNKNOWN_ACTION"}}}',
  ])('never accepts factory or setup failures as target refusals', async (code) => {
    expect(await run(code)).toMatchObject({ ok: false, results: [{ pass: false, got: { error: 'PEARL_ORGAN_NOT_MOUNTED' } }] })
  })
  it('records a peer run exception before the target catches and rewrites it', async () => {
    const result = await trialScionRetention({
      target: 'module.exports={name:"target",async run(input,ctx){try {await ctx.organs.call("peer",{})} catch {} return {ok:false,error:"UNKNOWN_ACTION",infrastructure:[]}}}',
      peer: 'module.exports={name:"peer",run(){throw Error("UNKNOWN_ACTION")}}',
    }, { fixedNow: 0, fixtures: { base: {} }, cases: [{ id: 'peer', args: { organ: 'target', fixture: 'base', input: {} }, expectError: 'UNKNOWN_ACTION' }] })
    expect(result).toMatchObject({ ok: false, results: [{ pass: false,
      infrastructure: [{ phase: 'dependency', code: 'PEARL_PEER_RUN_FAILED' }] }] })
  })
  it.each(['UNKNOWN_ACTION', 'UNKNOWN_ACTION: detail'])('accepts an exact target refusal with empty infrastructure', async (error) => {
    expect(await run(`module.exports={name:'target',run(){throw Error(${JSON.stringify(error)})}}`))
      .toMatchObject({ ok: true, results: [{ pass: true, infrastructure: [] }] })
  })
  it.each(['PREFIX_UNKNOWN_ACTION', 'UNKNOWN_ACTION_EXTRA', 'OTHER: UNKNOWN_ACTION'])('rejects substring-only refusal matches', async (error) => {
    expect(await run(`module.exports={name:'target',run(){return {ok:false,error:${JSON.stringify(error)}}}}`))
      .toMatchObject({ ok: false, results: [{ pass: false, infrastructure: [] }] })
  })
  it('blocks caller introspection from reaching trusted invocation arguments', async () => {
    const result = await run('module.exports={name:"target",run:function(){try {const caller=arguments.callee.caller;if(caller)return {ok:true}} catch {} throw Error("UNKNOWN_ACTION")}}')
    expect(result).toMatchObject({ ok: true, results: [{ infrastructure: [] }] })
  })
  it('keeps the trusted collector and peer factory map outside organ lexical scope', async () => {
    expect(await run('module.exports={name:"target",run(){if(typeof record!=="undefined"||typeof infrastructure!=="undefined"||typeof ORGANS!=="undefined")return {ok:true};throw Error("UNKNOWN_ACTION")}}'))
      .toMatchObject({ ok: true, results: [{ infrastructure: [] }] })
  })
  it('runs all 17 pinned repository rows against their HEAD sources', async () => {
    const suite = JSON.parse(readFileSync('mirror/home/auma/seed/pearl/retention-suite.v1.json', 'utf8')) as {
      organs: string[]
      fixtures: Record<string, unknown>
      fixedNow: number
      cases: Array<{ id: string; args: { organ: string }; expect?: unknown; expectError?: string }>
    }
    const head = JSON.parse(readFileSync('mirror/home/auma/HEAD.json', 'utf8')) as { entries: Record<string, { specifier: string }> }
    const build: Record<string, string> = {}
    for (const name of new Set([...suite.organs, ...suite.cases.map(row => row.args.organ)])) {
      build[name] = readFileSync(`mirror/home/balls/${head.entries[name]?.specifier.slice(5)}.js`, 'utf8')
    }
    const originalIds = [
      'receipts.append.event', 'receipts.chain.verify', 'receipts.chain.tamper-refused',
      'receipts.grant.unsigned-refused', 'receipts.grant.foreign-key-refused',
      'receipts.grant.owner-key-forged-signature', 'receipts.grant.swapped-owner-key-refused',
      'dag.parents-alias-reachable', 'dag.orphan-fails-closed', 'dag.write-anchored',
      'superagent.eval-accept-explicit-refused', 'superagent.confirm-unsigned-refused',
      'superagent.confirm-foreign-key-refused', 'predict.register-anchored',
      'predict.observe-waits-for-target', 'recall.unanchored-not-clean', 'recall.anchored-clean',
    ]
    const cases = suite.cases.map(row => ({ id: row.id, args: row.args, ...(Object.hasOwn(row, 'expectError') ? { expectError: row.expectError } : { expect: row.expect }) }))
    expect(cases.slice(0, 17).map(row => row.id)).toEqual(originalIds)
    const result = await trialScionRetention(build, { ...suite, cases: cases.slice(0, 17) })
    expect(result.results, JSON.stringify(result)).toHaveLength(17)
    expect(result.results.filter(row => !row.pass)).toEqual([])
    expect(result.ok).toBe(true)
    const combined = await trialScionRetention(build, { ...suite, cases })
    expect(combined.results).toHaveLength(23)
    expect(combined.ok).toBe(false)
    expect(combined.results.slice(0, 17)).toEqual(result.results)
    const failures = [
      ['dot.eyes.projection.no-origin', 'auma-eyes', 'guard', 'CANDIDATE_TRIAL_IO_FORBIDDEN', 'CANDIDATE_TRIAL_IO_FORBIDDEN: fetch'],
      ['dot.eyes.screenshot.no-origin', 'auma-eyes', 'guard', 'CANDIDATE_TRIAL_IO_FORBIDDEN', 'CANDIDATE_TRIAL_IO_FORBIDDEN: fetch'],
      ['dot.cortex.unknown-action.no-authority', 'auma-cortex', 'export', 'PEARL_ORGAN_NOT_MOUNTED', 'PEARL_ORGAN_NOT_MOUNTED'],
      ['dot.continuity.unknown-action.refused', 'seed-continuity', 'export', 'PEARL_ORGAN_NOT_MOUNTED', 'PEARL_ORGAN_NOT_MOUNTED'],
      ['dot.cortex.known-registry.works', 'auma-cortex', 'export', 'PEARL_ORGAN_NOT_MOUNTED', 'PEARL_ORGAN_NOT_MOUNTED'],
      ['dot.continuity.valid-synthetic-record.works', 'seed-continuity', 'export', 'PEARL_ORGAN_NOT_MOUNTED', 'PEARL_ORGAN_NOT_MOUNTED'],
    ]
    expect(combined.results.slice(17).map(row => row.id)).toEqual(failures.map(([id]) => id))
    for (const [id, subject, phase, code, error] of failures) {
      const row = combined.results.find(row => row.id === id)
      expect(row?.pass, id).toBe(false)
      expect(row?.got, id).toEqual({ ok: false, error })
      expect(row?.infrastructure, id).toEqual([{ phase, code, subject }])
    }
  })
})
