import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { trialScionRetention, retentionSuiteExtendsBaseline } from '../../src/x6/scion-growth.ts'
const root=process.cwd()
const path='mirror/home/auma/seed/pearl/retention-suite.v1.json'
const suite=JSON.parse(readFileSync(root+'/'+path,'utf8'))
const baseline=JSON.parse(readFileSync(new URL('./fixtures/retention-suite-approved.json', import.meta.url), 'utf8'))
// The two organs come from the FROZEN epoch-173 head (fixtures/frozen-head), never the live mirror: a head sync
// re-commits mirror/home/balls/HEAD.json on every published epoch, and her repair of these export names is exactly what
// the second test below must still see missing. Each source is checked against its sha.
const frozen=new URL('./fixtures/frozen-head/', import.meta.url)
const head=JSON.parse(readFileSync(new URL('HEAD.json',frozen),'utf8')) as { ballId: string; entries: Record<string, { specifier: string }> }
if(!head.ballId.startsWith('060c73c2'))throw new Error('not the frozen epoch-173 head')
const names=['auma-cortex','seed-continuity']
const frozenSource=(name:string)=>{
  const sha=head.entries[name]!.specifier.slice(5)
  const code=readFileSync(new URL('balls/'+sha+'.js',frozen),'utf8')
  if(createHash('sha256').update(code).digest('hex')!==sha)throw new Error('frozen organ '+name+' does not match its sha')
  return code
}
const sources=Object.fromEntries(names.map(name=>[name,frozenSource(name)]))
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
