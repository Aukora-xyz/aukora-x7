/**
 * Frozen organ fixtures for repo CI.
 *
 * server/aura, pearl and verified-facts test the contracts those organs had at
 * MANIFEST.sourceCommit. They must not execute live mirror/home/auma/seed/organs/*.js: Auma evolves
 * those in-body, and repo greenness must not depend on organism state.
 *
 * Integrity: every fixture is verified at import (sha256, byte length, git blob id, manifest/disk set
 * equality), before any test body runs, so a corrupted fixture fails the whole file instead of
 * satisfying a negative test. This is a tripwire against accidental edits, not a defence against a
 * committer who rewrites both fixture and manifest: verifyPinnedProvenance() ties the bytes back to
 * git history when full history is present.
 *
 * Advisory live mode: AUKORA_ORGAN_SOURCE=live makes loadOrganUnderTest() return the live mirror
 * organ instead, to publish how far the live organism has drifted from the pinned contract. The
 * gating CI job must never set it.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'

const DIR = new URL('./', import.meta.url)
const NAME = /^seed-[a-z0-9-]+$/
const HEX64 = /^[0-9a-f]{64}$/
const HEX40 = /^[0-9a-f]{40}$/
const gitBlobOid = bytes => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
const sha256Hex = bytes => createHash('sha256').update(bytes).digest('hex')

function verifyAll() {
  const manifest = JSON.parse(readFileSync(new URL('MANIFEST.json', DIR), 'utf8'))
  if (manifest?.schema !== 'aukora.organ-fixtures.v1' || !HEX40.test(manifest.sourceCommit ?? '')
    || !manifest.organs || typeof manifest.organs !== 'object' || Array.isArray(manifest.organs)) {
    throw new Error('ORGAN_FIXTURE_MANIFEST_INVALID')
  }
  const names = Object.keys(manifest.organs).sort()
  const onDisk = readdirSync(DIR).filter(file => /^seed-[a-z0-9-]+\.js$/.test(file)).map(file => file.slice(0, -3)).sort()
  if (names.join() !== onDisk.join()) throw new Error(`ORGAN_FIXTURE_SET_MISMATCH: manifest [${names}] disk [${onDisk}]`)
  const organs = new Map()
  for (const name of names) {
    const entry = manifest.organs[name]
    if (!NAME.test(name) || !HEX64.test(entry?.sha256 ?? '') || !HEX40.test(entry.gitBlob ?? '')
      || !HEX40.test(entry.lastChangedAt ?? '') || !Number.isSafeInteger(entry.bytes)
      || entry.path !== `mirror/home/auma/seed/organs/${name}.js`) {
      throw new Error('ORGAN_FIXTURE_ENTRY_INVALID: ' + name)
    }
    const bytes = readFileSync(new URL(`${name}.js`, DIR))
    const sha256 = sha256Hex(bytes)
    if (bytes.length !== entry.bytes || sha256 !== entry.sha256 || gitBlobOid(bytes) !== entry.gitBlob) {
      throw new Error(`ORGAN_FIXTURE_DIGEST_MISMATCH: ${name}`)
    }
    organs.set(name, Object.freeze({ source: new TextDecoder('utf-8', { fatal: true }).decode(bytes), sha256, gitBlob: entry.gitBlob }))
  }
  return Object.freeze({ manifest, organs })
}

const PINNED = verifyAll()

export const pinnedManifest = () => PINNED.manifest
export const pinnedOrganNames = () => [...PINNED.organs.keys()]

export function pinnedOrganInfo(name) {
  const organ = typeof name === 'string' && NAME.test(name) ? PINNED.organs.get(name) : undefined
  if (!organ) throw new Error('ORGAN_FIXTURE_UNPINNED: ' + String(name))
  return organ
}

export const loadPinnedOrgan = name => pinnedOrganInfo(name).source

/** Pinned bytes by default; live mirror bytes only in the advisory AUKORA_ORGAN_SOURCE=live run. */
export function loadOrganUnderTest(name) {
  const pinned = loadPinnedOrgan(name)
  if (process.env.AUKORA_ORGAN_SOURCE !== 'live') return pinned
  process.stderr.write(`# ORGAN SOURCE = LIVE (${name}): advisory drift run, not the gating contract\n`)
  return readFileSync(new URL(`../../../mirror/home/auma/seed/organs/${name}.js`, import.meta.url), 'utf8')
}

/** sha256 of a paired live production module at pin time vs now (e.g. server/aura-rules.mjs). */
export function pairedModuleDrift() {
  const paired = PINNED.manifest.pairedLiveModules ?? {}
  return Object.entries(paired).map(([path, { sha256 }]) => {
    const now = sha256Hex(readFileSync(new URL(`../../../${path}`, import.meta.url)))
    return { path, pinned: sha256, now, drifted: now !== sha256 }
  })
}

/** Reconstruct a unified patch strictly: every context/deletion byte must match its Git base. */
export function applyPinnedPatch(base, patch) {
  const input = base.split('\n'), output = []
  const lines = patch.split('\n')
  let cursor = 0, hunks = 0
  for (let i = 0; i < lines.length; i++) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(lines[i])
    if (!header) continue
    hunks++
    const start = Number(header[1]) - 1
    if (start < cursor || start > input.length) throw new Error('ORGAN_FIXTURE_PATCH_OFFSET')
    output.push(...input.slice(cursor, start)); cursor = start
    if (output.length !== Number(header[3]) - 1) throw new Error('ORGAN_FIXTURE_PATCH_OUTPUT_OFFSET')
    let removed = 0, added = 0
    while (++i < lines.length && !lines[i].startsWith('@@ ')) {
      const line = lines[i], kind = line[0], value = line.slice(1)
      if (line === '' && i === lines.length - 1) break
      if (![' ', '-', '+'].includes(kind)) throw new Error('ORGAN_FIXTURE_PATCH_FORMAT')
      if (kind !== '+') {
        if (input[cursor++] !== value) throw new Error('ORGAN_FIXTURE_PATCH_CONTEXT')
        removed++
      }
      if (kind !== '-') { output.push(value); added++ }
    }
    if (removed !== Number(header[2] ?? 1) || added !== Number(header[4] ?? 1)) throw new Error('ORGAN_FIXTURE_PATCH_COUNTS')
    i--
  }
  if (!hunks) throw new Error('ORGAN_FIXTURE_PATCH_EMPTY')
  return output.concat(input.slice(cursor)).join('\n')
}

/**
 * Tie fixtures to git history. Returns { checked: false } in a shallow clone (unless
 * AUKORA_REQUIRE_FIXTURE_PROVENANCE=1, which makes that a failure).
 */
export function verifyPinnedProvenance(cwd = new URL('../../../', import.meta.url)) {
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  const has = rev => { try { git('cat-file', '-e', `${rev}^{commit}`); return true } catch { return false } }
  const manifest = PINNED.manifest
  if (!has(manifest.sourceCommit) || !has(manifest.firstFailingCommit)) {
    if (process.env.AUKORA_REQUIRE_FIXTURE_PROVENANCE === '1') throw new Error('ORGAN_FIXTURE_HISTORY_UNAVAILABLE')
    return { checked: false }
  }
  const mismatches = []
  for (const [name, entry] of Object.entries(manifest.organs)) {
    if (entry.patchProvenance) {
      const p = entry.patchProvenance
      if (name !== 'seed-pearl' || !HEX40.test(p.baseCommit ?? '') || !HEX40.test(p.patchCommit ?? '')
        || p.patchCommit !== entry.lastChangedAt || p.patchPath !== 'docs/auma/pearl/pearl-truthful-verdict.patch'
        || !HEX64.test(p.baseSha256 ?? '') || !HEX64.test(p.patchSha256 ?? '')) throw new Error('ORGAN_FIXTURE_PATCH_PROVENANCE_INVALID')
      if (!has(p.baseCommit) || !has(p.patchCommit)) {
        if (process.env.AUKORA_REQUIRE_FIXTURE_PROVENANCE === '1') throw new Error('ORGAN_FIXTURE_HISTORY_UNAVAILABLE')
        return { checked: false }
      }
      const show = rev => execFileSync('git', ['show', rev], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      const base = show(`${p.baseCommit}:${entry.path}`), patch = show(`${p.patchCommit}:${p.patchPath}`)
      if (sha256Hex(base) !== p.baseSha256 || sha256Hex(patch) !== p.patchSha256
        || sha256Hex(applyPinnedPatch(base, patch)) !== entry.sha256) mismatches.push(`${name}@patch`)
      continue
    }
    for (const rev of [manifest.sourceCommit, entry.lastChangedAt]) {
      if (git('rev-parse', `${rev}:${entry.path}`) !== entry.gitBlob) mismatches.push(`${name}@${rev.slice(0, 8)}`)
    }
  }
  // sourceCommit is the first parent of firstFailingCommit: nothing else sits between them.
  if (git('rev-parse', `${manifest.firstFailingCommit}^1`) !== manifest.sourceCommit) mismatches.push('firstFailingCommit^1 != sourceCommit')
  return { checked: true, mismatches }
}
