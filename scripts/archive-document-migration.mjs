// The public snapshot's English edition is derived from its sealed parent. Every other seal stays append-only.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { basename } from 'node:path'
export const parent = '80e392d124f901ca4720ce2780afc0419e4c4358'
export const folder = '.agents/notes/archived/'
export const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const oldPin = 'e05ff8fd6e814f3b7062712df271803657d7a2ab2f39e32753a7ab4f5ae9e8cc'
const newPin = '4c6430092b60d8481b27410be2177ff33e43e801b342a15095253882cc595f26'
const recordPin = 'ee019dd041a5b2c55453c6af40b55550518fc4713364ee7d247f22f9b4b816e9'
export function deriveArchive(recordBytes, oldManifestBytes, oldPages) {
  assert.equal(sha(recordBytes), recordPin, 'migration record pin')
  assert.equal(sha(oldManifestBytes), oldPin, 'old manifest pin')
  const record = JSON.parse(recordBytes)
  assert.equal(record.parent, parent)
  assert.equal(record.old_manifest_sha256, oldPin)
  const manifest = JSON.parse(oldManifestBytes)
  const removed = Object.keys(manifest.files).filter(p => /\.(?:zh\.md|i18n\.yaml)$/.test(p)).sort()
  assert.deepEqual(record.removed_paths, removed)
  assert.equal(record.removed_count, removed.length)
  assert.equal(record.removed_path_list_sha256, sha(removed.join('\n') + '\n'))
  const pages = new Map()
  const seals = {}
  const expanded = []
  const changed = []
  for (const p of Object.keys(manifest.files)) {
    if (removed.includes(p)) continue
    const bytes = oldPages.get(p)
    assert.equal(manifest.files[p], 'sha256:' + sha(bytes), p)
    const old = bytes.toString('utf8')
    assert.ok(Buffer.from(old).equals(bytes), p)
    const line = 'English | [中文](' + basename(p, '.md') + '.zh.md)\n\n'
    const pos = old.indexOf(line)
    assert.ok(pos > 0 && old[pos-1] === '\n' && old.indexOf(line, pos + 1) < 0, p)
    const lines = old.replace(line, '').split('\n')
    for (const edit of record.substitutions.filter(row => row.path === p)) {
      const prior = lines[edit.line_after_switch_removal - 1]
      assert.equal(old.split('\n')[edit.line - 1], prior)
      assert.equal(edit.old_text.line, edit.line)
      assert.equal(sha(prior), edit.old_text.sha256)
      assert.equal(createHash('sha1').update('blob '+bytes.length+'\0').update(bytes).digest('hex'), edit.old_text.blob)
      assert.ok(!edit.new_text.includes('\n') && edit.new_text !== prior)
      lines[edit.line_after_switch_removal - 1] = edit.new_text
      expanded.push({...edit,old_text:prior})
    }
    const next = Buffer.from(lines.join('\n'))
    pages.set(p,next)
    seals[p] = 'sha256:' + sha(next)
    changed.push({path:p,old_sha256:sha(bytes),new_sha256:sha(next)})
  }
  changed.sort((a,b)=>a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  assert.deepEqual(record.resealed, changed)
  assert.equal(record.resealed_count, changed.length)
  assert.equal(expanded.length, 16)
  const current = Buffer.from(JSON.stringify({version:1,files:seals},null,2)+'\n')
  assert.equal(sha(current), newPin)
  assert.equal(record.new_manifest_sha256, newPin)
  return {pages, manifest:current, substitutions:expanded}
}
export function readArchiveParent(root) {
  const git = (args,input) => execFileSync('git',['-C',root,...args],{input,maxBuffer:32*1024*1024})
  const manifest = git(['show',parent+':'+folder+'manifest.json'])
  assert.equal(sha(manifest),oldPin)
  const names=Object.keys(JSON.parse(manifest).files).filter(p=>p.endsWith('.md') && !p.endsWith('.zh.md'))
  const all=git(['cat-file','--batch'], names.map(p=>parent+':'+folder+p+'\n').join(''))
  const pages=new Map()
  let at=0
  for(const p of names) {
    const end=all.indexOf(10,at)
    const header=all.subarray(at,end).toString('ascii').match(/^[\da-f]{40} blob (\d+)$/)
    assert.ok(header,p)
    const size=Number(header[1])
    pages.set(p,all.subarray(end+1,end+1+size))
    at=end+size+2
    assert.equal(all[at-1],10)
  }
  assert.equal(at,all.length)
  return {manifest,pages}
}
