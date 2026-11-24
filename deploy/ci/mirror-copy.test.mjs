// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The Aukora authors
// node --test deploy/ci/mirror-copy.test.mjs  (no network; reads this checkout and synthetic trees)
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { canonicalJson } from '../../server/ball-transition.mjs'
import * as edgeManifest from '../../server/ball-manifest.mjs'
import { headProblem, legacyManifestPreimage, validateManifestStructure, isMirrorCopyPath, MIRROR_COPY_GLOBS, MIRROR_RECORD_PATHS, serializeHead, verifyMirrorTree } from './mirror-copy.mjs'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const sha256 = text => createHash('sha256').update(text).digest('hex')
const bytes = text => new TextEncoder().encode(text)

function headOf(code, extra = {}) {
  const sha = sha256(code)
  const body = { version: 'x6.1-ball/v1', parentBallId: null, epoch: 3, entries: { 'seed-a': { id: 'seed-a', specifier: `ball:${sha}`, config: {}, disabled: false, previousSpecifiers: [] } },
    modules: { [sha]: { sha256: sha, specifier: `ball:${sha}` } }, ...extra }
  return { ...body, ballId: sha256(canonicalJson(body)) }
}
function treeOf(files) {
  return {
    read: path => Object.hasOwn(files, path) ? bytes(files[path]) : null,
    list: dir => Object.keys(files).filter(path => path.startsWith(dir + '/') && !path.slice(dir.length + 1).includes('/')).map(path => path.slice(dir.length + 1)),
  }
}

test('this checkout: the mirror is a verified copy of its head (what CI runs before packaging)', async () => {
  const result = await verifyMirrorTree({
    read: path => { try { return new Uint8Array(readFileSync(join(ROOT, path))) } catch { return null } },
    list: path => { try { return readdirSync(join(ROOT, path)) } catch { return [] } },
  })
  assert.deepEqual(result.problems, [])
  assert.equal(result.ok, true)
  assert.ok(result.checked > 0)
})

test('a tree whose modules do not hash to their names, or whose head is not its own hash, fails the build', async () => {
  const code = 'export const a = 1\n', ball = headOf(code), name = `mirror/home/balls/${sha256(code)}.js`
  const good = { 'mirror/home/balls/HEAD.json': serializeHead(ball), 'mirror/home/auma/HEAD.json': serializeHead(ball), [name]: code }
  assert.equal((await verifyMirrorTree(treeOf(good))).ok, true)
  const cases = [
    [{ ...good, [name]: 'export const a = 2\n' }, /^MODULE_NAME_NOT_ITS_HASH|^SELECTED_MODULE_HASH_MISMATCH/],
    [{ ...good, [`mirror/home/balls/${'0'.repeat(64)}.js`]: code }, /^MODULE_NAME_NOT_ITS_HASH/],
    [{ ...good, 'mirror/home/balls/HEAD.json': serializeHead({ ...ball, epoch: 4 }), 'mirror/home/auma/HEAD.json': serializeHead({ ...ball, epoch: 4 }) }, /^HEAD_INVALID MANIFEST_HASH_MISMATCH/],
    [{ ...good, 'mirror/home/balls/HEAD.json': JSON.stringify(ball), 'mirror/home/auma/HEAD.json': JSON.stringify(ball) }, /^HEAD_NOT_CANONICAL/],
    [{ ...good, 'mirror/home/auma/HEAD.json': serializeHead(headOf('other\n')) }, /^HEAD_COPY_DIFFERS/],
    [{ 'mirror/home/balls/HEAD.json': serializeHead(ball) }, /^SELECTED_MODULE_MISSING/],
    [{ [name]: code }, /^HEAD_MISSING/],
  ]
  for (const [files, problem] of cases) {
    const result = await verifyMirrorTree(treeOf(files))
    assert.equal(result.ok, false)
    assert.ok(result.problems.some(item => problem.test(item)), JSON.stringify(result.problems))
  }
  // Retained lineage modules the head no longer references are listed, never packaged (the build reads only entries).
  const old = 'export const a = 0\n'
  const lineage = await verifyMirrorTree(treeOf({ ...good, [`mirror/home/balls/${sha256(old)}.js`]: old }))
  assert.equal(lineage.ok, true)
  assert.deepEqual(lineage.unreferenced, [`${sha256(old)}.js`])
})

test('organ files the build would ship as candidates are listed by name (they reach main only by a passkey proposal)', async () => {
  const code = 'export const a = 1\n', ball = headOf(code), name = `mirror/home/balls/${sha256(code)}.js`
  const good = { 'mirror/home/balls/HEAD.json': serializeHead(ball), 'mirror/home/auma/HEAD.json': serializeHead(ball), [name]: code }
  // A copy of the selected module is not a candidate; a different body for a selected organ is (server/build-preview.mjs
  // stages exactly those); an organ file the head does not select is never packaged, so it is not listed.
  const copy = await verifyMirrorTree(treeOf({ ...good, 'mirror/home/auma/seed/organs/seed-a.js': code }))
  assert.deepEqual([copy.ok, copy.candidates], [true, []])
  const staged = await verifyMirrorTree(treeOf({ ...good, 'mirror/home/auma/seed/organs/seed-a.js': 'export const a = 2\n', 'mirror/home/auma/seed/organs/seed-new.js': 'x\n', 'mirror/home/auma/seed/organs/README.txt': 'n\n' }))
  assert.equal(staged.ok, true)
  assert.deepEqual(staged.candidates, ['seed-a.js'])
})

test('the head check is the edge\'s: structure, then the id is the hash of the content', async () => {
  const ball = headOf('x\n')
  assert.equal(await headProblem(ball), null)
  assert.equal(await headProblem({ ...ball, epoch: 9 }), 'MANIFEST_HASH_MISMATCH')
  assert.equal(await headProblem({ ...ball, extra: 'smuggled' }), 'MANIFEST_HASH_MISMATCH')
  assert.equal(await headProblem({ ...ball, modules: {} }), 'MODULE_MISSING')
  assert.equal(await headProblem(null), 'INVALID_MANIFEST')
})

test('copy paths are exactly the rule, and the two records are never packaged by the build', () => {
  assert.deepEqual([...MIRROR_COPY_GLOBS], ['mirror/home/balls/HEAD.json', 'mirror/home/auma/HEAD.json', 'mirror/home/balls/*.js', 'mirror/home/auma/seed/organs/*.js',
    'mirror/home/auma/HANDOFF.md', 'mirror/home/auma/seed/receipts.v3.jsonl'])
  for (const path of ['mirror/home/balls/HEAD.json', `mirror/home/balls/${'a'.repeat(64)}.js`, 'mirror/home/auma/seed/organs/seed-a.js', ...MIRROR_RECORD_PATHS]) assert.equal(isMirrorCopyPath(path), true, path)
  for (const path of [`mirror/home/balls/${'a'.repeat(64)}.meta.json`, 'mirror/home/balls/abc.js', 'mirror/home/auma/seed/candidates/seed-a.js', 'mirror/home/auma/COVENANT.md',
    'mirror/home/auma/seed/scars.jsonl', 'mirror/home/auma/seed/organs/Seed.js', 'mirror/home/auma/seed/organs/x/y.js', 'apps/web/src/main.ts', null]) assert.equal(isMirrorCopyPath(path), false, String(path))
  // The records ride along because the build never reads them; if server/build-preview.mjs ever does, they stop being
  // records and this rule must change first.
  const build = readFileSync(join(ROOT, 'server/build-preview.mjs'), 'utf8')
  for (const path of MIRROR_RECORD_PATHS) {
    const tail = path.slice('mirror/'.length)
    assert.equal(build.includes(tail) || build.includes(tail.split('/').at(-1)), false, `${path} is read by the build`)
  }
})

test('the manifest helpers agree with server/ball-manifest.mjs, the edge\'s own, case by case', () => {
  const ball = headOf('x\n')
  const sha = Object.keys(ball.modules)[0]
  const cases = [ball, null, [], { ...ball, version: 'v0' }, { ...ball, ballId: 'x' }, { ...ball, parentBallId: 'y' }, { ...ball, epoch: -1 }, { ...ball, epoch: 1.5 },
    { ...ball, entries: [] }, { ...ball, modules: null }, { ...ball, entries: { a: { ...ball.entries['seed-a'] } } },
    { ...ball, entries: { 'seed-a': { ...ball.entries['seed-a'], disabled: 'no' } } }, { ...ball, entries: { 'seed-a': { ...ball.entries['seed-a'], previousSpecifiers: [''] } } },
    { ...ball, entries: { 'seed-a': { ...ball.entries['seed-a'], previousSpecifiers: ['ball:' + 'f'.repeat(64)] } } },
    { ...ball, entries: { 'seed-a': { ...ball.entries['seed-a'], previousVersions: [{ specifier: 'ball:' + 'e'.repeat(64), disabled: false, config: {} }] } } },
    { ...ball, entries: { 'seed-a': { ...ball.entries['seed-a'], previousVersions: 'x' } } }, { ...ball, entries: { 'seed-a': { ...ball.entries['seed-a'], specifier: 'npm:x' } } },
    { ...ball, modules: { ...ball.modules, [sha]: { ...ball.modules[sha], sha256: 'z' } } }, { ...ball, modules: { ...ball.modules, abc: { sha256: 'abc', specifier: 'ball:abc' } } }]
  for (const value of cases) assert.equal(validateManifestStructure(value), edgeManifest.validateManifestStructure(value), JSON.stringify(value)?.slice(0, 120))
  for (const value of [ball, headOf('y\n', { parentBallId: 'a'.repeat(64) })]) assert.equal(legacyManifestPreimage(value), edgeManifest.legacyManifestPreimage(value))
})
