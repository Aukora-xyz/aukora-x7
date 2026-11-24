import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { probe, exitCode } from './probe.mjs'
test('checks local files, digests, runtime floor and containment', t => {
  const dir=mkdtempSync(join(tmpdir(),'aukora-probe-'))
  t.after(()=>rmSync(dir,{recursive:true,force:true}))
  const root=join(dir,'repo')
  for(const p of ['ark','docs']) mkdirSync(join(root,p),{recursive:true})
  const write=(p,data)=>writeFileSync(join(root,p),data)
  write('docs/KNOWN-RED-TESTS.md','known')
  write('ark/example','example')
  write('ark/MANIFEST.sha256',createHash('sha256').update('example').digest('hex')+'  example\n')
  const claims=where=>write('claims.json',JSON.stringify({schema:1,claims:[{where}]}))
  claims(['ark/example'])
  assert.equal(exitCode(probe(root,'24.9.0')),0)
  assert.equal(probe(root,'24.8.9').node.meets_minimum,false)
  assert.equal(probe(root,'24.9.0').node.meets_minimum,true)
  write('ark/example','changed')
  writeFileSync(join(dir,'outside'),'outside')
  symlinkSync(join(dir,'outside'),join(root,'external'))
  claims(['absent','../outside','external'])
  const failed=probe(root)
  assert.deepEqual(failed.claims.paths_missing,['../outside','absent','external'])
  assert.deepEqual(failed.ark_manifest.failed,['example'])
  assert.equal(exitCode(failed),1)
})
