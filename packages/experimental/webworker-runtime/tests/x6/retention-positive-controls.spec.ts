import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { trialScionRetention, retentionSuiteExtendsBaseline } from '../../src/x6/scion-growth.ts'
const root=process.cwd()
const path='mirror/home/auma/seed/pearl/retention-suite.v1.json'
const suite=JSON.parse(readFileSync(root+'/'+path,'utf8'))
const baseline=JSON.parse(readFileSync(new URL('./fixtures/retention-suite-approved.json', import.meta.url), 'utf8'))
const head=JSON.parse(readFileSync(root+'/mirror/home/balls/HEAD.json','utf8'))
const names=['auma-cortex','seed-continuity']
const sources=Object.fromEntries(names.map(name=>[name,readFileSync(root+'/mirror/home/balls/'+head.entries[name].specifier.slice(5)+'.js','utf8')]))
const cases=suite.cases.slice(21).map((row: { id: string; args: Record<string, unknown>; expect: unknown }) => ({
  id: row.id, args: row.args, expect: row.expect,
}))
it('preserves all prior rows and fixtures and unique ids',()=>{
  expect(suite.cases.slice(0,21)).toEqual(baseline.cases)
  for(const [name,value] of Object.entries(baseline.fixtures))expect(suite.fixtures[name]).toEqual(value)
  expect(retentionSuiteExtendsBaseline(suite,baseline)).toBe(true)
  expect(new Set(suite.cases.map((r:{ id:string })=>r.id)).size).toBe(23)
})
it('requires exact loader names before positive outputs count',async()=>{
  const result=await trialScionRetention(sources,{ fixtures:suite.fixtures,fixedNow:suite.fixedNow,cases })
  expect(result.results).toHaveLength(2)
  expect(result.results.every(r=>!r.pass)).toBe(true)
})
it('passes both positive rows after name-only corrections',async()=>{
  const renamed=Object.fromEntries(names.map(name=>[name,sources[name]!.replace("name: '"+name.replaceAll('-','_')+"'","name: '"+name+"'")]))
  const result=await trialScionRetention(renamed,{ fixtures:suite.fixtures,fixedNow:suite.fixedNow,cases })
  expect(result.results).toHaveLength(2)
  expect(result.results.every(r=>r.pass)).toBe(true)
})
it('rejects constant-refusal organs on each positive row',async()=>{
  const stubs=Object.fromEntries(names.map(name=>[name,`module.exports={name:${JSON.stringify(name)},run(){return {ok:false,error:'UNKNOWN_ACTION'}}}`]))
  const result=await trialScionRetention(stubs,{ fixtures:suite.fixtures,fixedNow:suite.fixedNow,cases })
  expect(result.results).toHaveLength(2)
  expect(result.results.every(r=>!r.pass)).toBe(true)
})
