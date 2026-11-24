// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The Aukora authors
/**
 * THE ONE-RULE SCAN of docs/capsule/CONTRACT.md section 3.7 (stop condition S2), in the style of proof-failure-rule:
 * in every file under deploy/ and packages/experimental/webworker-runtime/src whose name starts with `capsule-` or
 * `world-act`, a platform JSON serialiser or parser, a node:crypto hash or a WebCrypto digest is refused unless it is in
 * deploy/cloudflare/src/capsule-canon.mjs, the one canonical file, or on the short allow-list below with its exact count.
 * The canonical file itself may use the WebCrypto digest only: never the platform JSON functions, never an import.
 * The patterns are assembled from pieces so this file does not match itself.
 */
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url))
const CANON = 'deploy/cloudflare/src/capsule-canon.mjs'
const SCANNED = ['deploy', 'packages/experimental/webworker-runtime/src']

const call = (object, name) => `${object}.${name}(`
const PATTERNS = Object.freeze({
  serialise: call('JSON', 'stringify'),
  parse: call('JSON', 'parse'),
  hash: 'create' + 'Hash(',
  digest: call('subtle', 'digest'),
})

/**
 * The allow-list: each entry is one file, one pattern and its EXACT count, so a second use is refused too.
 * Both entries are oracles in the canon's own test, never a verdict of record:
 */
const ALLOWED = Object.freeze([
  // The independent sha256 section 3.8 asks for ("six digests also anchored" outside the module): the test hashes the
  // vector bytes with node:crypto and compares the module's digest with it. One helper, `sha256`, used everywhere.
  { file: 'deploy/cloudflare/src/__tests__/capsule-canon.test.mjs', pattern: 'hash', count: 1 },
  // The platform JSON parser as an oracle: every text the canon accepts must be read by it to the same value. It never
  // decides a verdict; it can only fail the test. One helper, `platformParse`.
  { file: 'deploy/cloudflare/src/__tests__/capsule-canon.test.mjs', pattern: 'parse', count: 1 },
  // The act shapes' test recomputes every act digest with node:crypto, never with the module (brief the capsule canon). One
  // helper, `sha256`.
  { file: 'deploy/cloudflare/src/__tests__/capsule-act-shapes.test.mjs', pattern: 'hash', count: 1 },
  // Lead's classification at the landing of M2: the protocol model serialises ABSTRACT states for the explorer's visited
  // set and copies them; no capsule or act bytes pass through this file. One helper each (`stateKey`-style), counted exactly.
  { file: 'deploy/cloudflare/src/__tests__/capsule-once-model.mjs', pattern: 'serialise', count: 1 },
  { file: 'deploy/cloudflare/src/__tests__/capsule-once-model.mjs', pattern: 'parse', count: 1 },
])

const watched = name => name.startsWith('capsule-') || name.startsWith('world-act')

function walk(directory, found) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    const path = join(directory, entry.name)
    if (entry.isDirectory()) walk(path, found)
    else if (watched(entry.name)) found.push(relative(ROOT, path).split('\\').join('/'))
  }
  return found
}

const countOf = (text, needle) => text.split(needle).length - 1
const FILES = SCANNED.flatMap(directory => walk(join(ROOT, directory), [])).sort()

test('the scan sees every capsule file this work added (a walker that finds nothing proves nothing)', () => {
  for (const path of [CANON, 'deploy/cloudflare/src/capsule-envelope.mjs', 'deploy/cloudflare/src/capsule-act-shapes.mjs', 'deploy/cloudflare/src/capsule-canon.vectors.json',
    'deploy/cloudflare/src/__tests__/capsule-canon.test.mjs', 'deploy/cloudflare/src/__tests__/capsule-envelope.test.mjs',
    'deploy/cloudflare/src/__tests__/capsule-act-shapes.test.mjs', 'deploy/cloudflare/src/__tests__/capsule-rule.test.mjs']) assert.ok(FILES.includes(path), path)
})

test('no capsule or act file hashes, serialises or parses outside the one canonical file', () => {
  const offenders = []
  for (const path of FILES) {
    if (path === CANON) continue
    const text = readFileSync(join(ROOT, path), 'utf8')
    for (const [name, needle] of Object.entries(PATTERNS)) {
      const allowed = ALLOWED.find(entry => entry.file === path && entry.pattern === name)?.count ?? 0
      const found = countOf(text, needle)
      if (found !== allowed) offenders.push(`${path}: ${needle} x${found} (allowed ${allowed})`)
    }
  }
  assert.deepEqual(offenders, [])
  for (const entry of ALLOWED) assert.ok(FILES.includes(entry.file), `allow-list entry for a file that is gone: ${entry.file}`)
})

test('the canonical file imports nothing and never calls the platform JSON functions or node:crypto', () => {
  const text = readFileSync(join(ROOT, CANON), 'utf8')
  for (const needle of [PATTERNS.serialise, PATTERNS.parse, PATTERNS.hash, 'JSON.', 'node:', 'require(', 'process.', 'globalThis']) {
    assert.equal(countOf(text, needle), 0, needle)
  }
  assert.doesNotMatch(text, /^\s*(?:import|export\s+\*|export\s*\{[^}]*\}\s*from)\b/m)
  assert.doesNotMatch(text, /\bimport\s*\(/)
  assert.ok(countOf(text, PATTERNS.digest) >= 1, 'the canonical file is where hashing lives')
})

test('the record verifier and the act shapes import only the canonical file; the act shapes verify no signature', () => {
  for (const file of ['deploy/cloudflare/src/capsule-envelope.mjs', 'deploy/cloudflare/src/capsule-act-shapes.mjs']) {
    const text = readFileSync(join(ROOT, file), 'utf8')
    const imports = [...text.matchAll(/^\s*import\b[^\n]*?from\s+'([^']+)'/gm)].map(match => match[1])
    assert.deepEqual(imports, ['./capsule-canon.mjs'], file)
    assert.doesNotMatch(text, /\bimport\s*\(|require\(/, file)
  }
  // Section 5 of the brief: no signature verification here (M4's, in world-holder.mjs).
  const shapes = readFileSync(join(ROOT, 'deploy/cloudflare/src/capsule-act-shapes.mjs'), 'utf8')
  for (const needle of [call('subtle', 'verify'), 'verify(', 'importKey(', 'crypto.']) assert.equal(countOf(shapes, needle), 0, needle)
})

test('nothing outside the capsule files imports them yet (M1 changes nothing in her live body)', () => {
  const importers = []
  const visit = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      const path = join(directory, entry.name)
      if (entry.isDirectory()) { visit(path); continue }
      if (!/\.(?:mjs|js|ts|tsx|mts)$/.test(entry.name) || watched(entry.name)) continue
      const text = readFileSync(path, 'utf8')
      if (/(?:\bfrom\s*|\bimport\s*\(?\s*)['"`][^'"`]*capsule-(?:canon|envelope|act-shapes)/.test(text)) importers.push(relative(ROOT, path).split('\\').join('/'))
    }
  }
  for (const directory of ['deploy', 'server', 'apps/web/src', 'packages/experimental/webworker-runtime/src', 'packages/client/ui-layout/src']) visit(join(ROOT, directory))
  // deploy/ci/frozen-paths.mjs and its card copy name them as paths (they freeze them); neither imports them.
  // M3 (lead's change, 2026-11-13): Auma's gate and its court are the first importers the contract names (section 12:
  // the gate imports only the canonical file). They are listed by exact path; anything else still fails. Until her
  // proposal is merged the files are absent and the list of importers is empty.
  const M3 = ['deploy/cloudflare/src/__tests__/auma-capsule-court.test.mjs', 'deploy/cloudflare/src/auma/capsule-gate.mjs']
  assert.deepEqual(importers.filter(path => !M3.includes(path)), [])
})
