// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The Aukora authors
/**
 * MIRROR COPY RULE: the only bytes `sync_head_to_github` (deploy/cloudflare/src/cloud-brokers.mjs) may commit to main
 * without a passkey (the broker-side confinement), plus the repository-alone integrity check CI runs before packaging.
 *
 * A head sync copies what the edge HEAD already judged (HEAD moves only through a Class 3 passkey promotion or the
 * owner's night grant). CI no longer treats a sync commit as anything special: every non-docs
 * push to main is a release and deploys like any other (deploy-x61.yml), so nothing here has to prove at build time that
 * the edge judged those bytes. The broker still refuses any byte outside this rule:
 *   mirror/home/balls/HEAD.json, mirror/home/auma/HEAD.json
 *       exactly serializeHead(ball) of a manifest whose ballId is the hash of its own content (the edge's own check);
 *   mirror/home/balls/<sha256>.js
 *       bytes whose sha256 is the file name, and the name is a module the synced HEAD references;
 *   mirror/home/auma/seed/organs/<id>.js
 *       bytes whose sha256 is the module the synced HEAD selects for that same organ id (so the build sees no candidate);
 *   mirror/home/auma/HANDOFF.md, mirror/home/auma/seed/receipts.v3.jsonl
 *       records, never code: server/build-preview.mjs packages neither (deploy/ci/mirror-copy.test.mjs locks that), and the
 *       broker publishes the receipts ledger only as a byte-exact append-only extension of main's copy.
 * Anything else is refused. Pure (WebCrypto only), so the Worker and the CI scripts share it. It lives under deploy/ (T2).
 * The authority preflight imports it (through cloud-brokers.mjs) and refuses to import anything outside deploy/ and
 * server/ball-transition.mjs, so the two manifest helpers below mirror server/ball-manifest.mjs; mirror-copy.test.mjs
 * proves they agree with it.
 */
import { canonicalJson } from '../../server/ball-transition.mjs'

export const MIRROR_HEAD_PATHS = Object.freeze(['mirror/home/balls/HEAD.json', 'mirror/home/auma/HEAD.json'])
export const MIRROR_RECORD_PATHS = Object.freeze(['mirror/home/auma/HANDOFF.md', 'mirror/home/auma/seed/receipts.v3.jsonl'])
const BALL_PATH = /^mirror\/home\/balls\/([0-9a-f]{64})\.js$/
const ORGAN_PATH = /^mirror\/home\/auma\/seed\/organs\/([a-z][a-z0-9-]{0,63})\.js$/
/** GitHub-glob form of every path a head sync may write (documentation; isMirrorCopyPath is the exact test). */
export const MIRROR_COPY_GLOBS = Object.freeze([...MIRROR_HEAD_PATHS, 'mirror/home/balls/*.js', 'mirror/home/auma/seed/organs/*.js', ...MIRROR_RECORD_PATHS])

/** Whether a repository path is one a head sync may write (by name only; the bytes are judged by mirrorCopyRefusals). */
export function isMirrorCopyPath(path) {
  return typeof path === 'string' && (MIRROR_HEAD_PATHS.includes(path) || MIRROR_RECORD_PATHS.includes(path) || BALL_PATH.test(path) || ORGAN_PATH.test(path))
}

/** The one serialization of a head manifest in the repository. */
export const serializeHead = ball => JSON.stringify(ball, null, 2) + '\n'

const encoder = new TextEncoder()
const bytesOf = value => typeof value === 'string' ? encoder.encode(value) : value
const sameBytes = (a, b) => a.length === b.length && a.every((byte, index) => byte === b[index])

/** Lower-case hex sha256 of bytes or UTF-8 text. */
export async function sha256Hex(value) {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytesOf(value))
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

const isSha = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const entryVersionValid = entry => isObject(entry) && typeof entry.specifier === 'string' && entry.specifier.length > 0 && typeof entry.disabled === 'boolean' && isObject(entry.config)

/** server/ball-manifest.mjs legacyManifestPreimage, byte for byte (the legacy ballId form). */
export const legacyManifestPreimage = ball => JSON.stringify({
  version: 'x6.1-ball/v1', parentBallId: ball.parentBallId, epoch: ball.epoch,
  entries: Object.keys(ball.entries).sort().map(key => ball.entries[key]),
  modules: Object.keys(ball.modules).sort().map(key => ball.modules[key]),
})

/** server/ball-manifest.mjs validateManifestStructure: the same checks, the same first failure code. */
export const validateManifestStructure = ball => {
  if (!isObject(ball) || ball.version !== 'x6.1-ball/v1' || !isSha(ball.ballId) || (ball.parentBallId !== null && !isSha(ball.parentBallId)) || !Number.isSafeInteger(ball.epoch) || ball.epoch < 0 || !isObject(ball.entries) || !isObject(ball.modules)) return 'INVALID_MANIFEST'
  for (const [id, entry] of Object.entries(ball.entries)) {
    if (!entryVersionValid(entry) || entry.id !== id || !Array.isArray(entry.previousSpecifiers) || entry.previousSpecifiers.some(specifier => typeof specifier !== 'string' || !specifier) || (entry.previousVersions !== undefined && (!Array.isArray(entry.previousVersions) || entry.previousVersions.some(version => !entryVersionValid(version))))) return 'INVALID_ENTRY'
    for (const version of [entry, ...(entry.previousVersions ?? []), ...entry.previousSpecifiers.map(specifier => ({ specifier }))]) {
      if (version.specifier.startsWith('ball:') && (!isSha(version.specifier.slice(5)) || !Object.hasOwn(ball.modules, version.specifier.slice(5)))) return 'MODULE_MISSING'
    }
  }
  for (const [sha, meta] of Object.entries(ball.modules)) if (!isSha(sha) || !isObject(meta) || meta.sha256 !== sha || meta.specifier !== `ball:${sha}`) return 'INVALID_MODULE'
  return null
}

/**
 * The edge's own manifest check (head-do.mjs validateManifest): structure, then ballId equals the hash of the content
 * (legacy or canonical form). Returns null for a valid head, else a code.
 */
export async function headProblem(ball) {
  const structural = validateManifestStructure(ball)
  if (structural) return structural
  const { ballId: _ignored, ...rest } = ball
  if (await sha256Hex(canonicalJson(rest)) === ball.ballId || await sha256Hex(legacyManifestPreimage(ball)) === ball.ballId) return null
  return 'MANIFEST_HASH_MISMATCH'
}

/** Modules a head references: its module table (which, by validateManifestStructure, holds every entry's specifier). */
export function referencedModules(ball) {
  return new Set(Object.keys(ball?.modules ?? {}))
}

/**
 * Judge files a head sync would write against the head being synced. Empty array = every byte is a verified copy.
 * @param {{ path: string, bytes: Uint8Array|string }[]} files
 * @param {object} ball The edge HEAD manifest being synced.
 * @returns {Promise<{ path: string, reason: string }[]>}
 */
export async function mirrorCopyRefusals(files, ball) {
  const refused = []
  const headCode = await headProblem(ball)
  if (headCode) return (Array.isArray(files) ? files : []).map(file => ({ path: String(file?.path), reason: `HEAD_${headCode}` }))
  const expectedHead = encoder.encode(serializeHead(ball))
  const modules = referencedModules(ball)
  for (const file of files) {
    const path = file?.path, bytes = bytesOf(file?.bytes)
    if (typeof path !== 'string' || !(bytes instanceof Uint8Array)) { refused.push({ path: String(path), reason: 'NOT_A_FILE' }); continue }
    if (MIRROR_HEAD_PATHS.includes(path)) {
      if (!sameBytes(bytes, expectedHead)) refused.push({ path, reason: 'HEAD_NOT_THE_SYNCED_HEAD' })
      continue
    }
    if (MIRROR_RECORD_PATHS.includes(path)) continue
    const named = BALL_PATH.exec(path)
    if (named) {
      if (await sha256Hex(bytes) !== named[1]) refused.push({ path, reason: 'MODULE_NAME_NOT_ITS_HASH' })
      else if (!modules.has(named[1])) refused.push({ path, reason: 'MODULE_NOT_REFERENCED_BY_HEAD' })
      continue
    }
    const organ = ORGAN_PATH.exec(path)
    if (organ) {
      const specifier = Object.hasOwn(ball.entries, organ[1]) ? ball.entries[organ[1]]?.specifier : undefined
      if (typeof specifier !== 'string' || !/^ball:[0-9a-f]{64}$/.test(specifier)) refused.push({ path, reason: 'ORGAN_NOT_SELECTED_BY_HEAD' })
      else if (await sha256Hex(bytes) !== specifier.slice(5)) refused.push({ path, reason: 'ORGAN_NOT_THE_SELECTED_MODULE' })
      continue
    }
    refused.push({ path, reason: 'PATH_OUTSIDE_MIRROR_COPY_RULE' })
  }
  return refused
}

/**
 * The repository-alone integrity check CI runs before packaging (deploy-guard.mjs verify-mirror). `read(path)` returns the bytes of a
 * repository file or null; `list(dir)` returns file names in a repository directory.
 * Fails on: a HEAD.json that is not the canonical serialization of a self-hashed manifest; an auma/HEAD.json that differs
 * from it; a selected organ whose module is missing or does not hash to its name; any ball module file that does not hash
 * to its name. Ball files the HEAD no longer references are the retained lineage store: listed, never failed and never
 * packaged (server/build-preview.mjs reads only the modules HEAD's entries select). They cannot fail the build: a head
 * sync writes the new head's modules but never deletes or indexes the old head's, so every epoch change leaves some.
 * Selected organs whose mirror/home/auma/seed/organs/<id>.js differs from the selected module are listed as candidates:
 * server/build-preview.mjs stages exactly those beside the selected organ. They are not failed, because a candidate is a
 * designed path that reaches main only through a proposal the owner approves by passkey (a head sync never writes one).
 * @returns {Promise<{ ok: boolean, problems: string[], unreferenced: string[], candidates: string[], checked: number }>}
 */
export async function verifyMirrorTree({ read, list }) {
  const problems = [], unreferenced = [], candidates = []
  const headBytes = read('mirror/home/balls/HEAD.json')
  if (!headBytes) return { ok: false, problems: ['HEAD_MISSING mirror/home/balls/HEAD.json'], unreferenced, candidates, checked: 0 }
  let ball = null
  try { ball = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(headBytes)) } catch { ball = null }
  const code = ball ? await headProblem(ball) : 'HEAD_UNPARSEABLE'
  if (code) problems.push(`HEAD_INVALID ${code}`)
  else if (!sameBytes(headBytes, encoder.encode(serializeHead(ball)))) problems.push('HEAD_NOT_CANONICAL mirror/home/balls/HEAD.json')
  const auma = read('mirror/home/auma/HEAD.json')
  if (auma && !sameBytes(auma, headBytes)) problems.push('HEAD_COPY_DIFFERS mirror/home/auma/HEAD.json')
  const modules = code ? new Set() : referencedModules(ball)
  let checked = 0
  for (const name of list('mirror/home/balls')) {
    const match = /^([0-9a-f]{64})\.js$/.exec(name)
    if (!match) continue
    checked += 1
    const bytes = read(`mirror/home/balls/${name}`)
    if (!bytes || await sha256Hex(bytes) !== match[1]) problems.push(`MODULE_NAME_NOT_ITS_HASH mirror/home/balls/${name}`)
    if (!code && !modules.has(match[1])) unreferenced.push(name)
  }
  if (!code) {
    for (const [id, entry] of Object.entries(ball.entries)) {
      const sha = typeof entry?.specifier === 'string' && /^ball:[0-9a-f]{64}$/.test(entry.specifier) ? entry.specifier.slice(5) : null
      if (!sha) { problems.push(`ORGAN_SPECIFIER_INVALID ${id}`); continue }
      const bytes = read(`mirror/home/balls/${sha}.js`)
      if (!bytes) problems.push(`SELECTED_MODULE_MISSING ${id} ${sha}`)
      else if (await sha256Hex(bytes) !== sha) problems.push(`SELECTED_MODULE_HASH_MISMATCH ${id}`)
      const organ = ORGAN_PATH.test(`mirror/home/auma/seed/organs/${id}.js`) ? read(`mirror/home/auma/seed/organs/${id}.js`) : null
      if (organ && await sha256Hex(organ) !== sha) candidates.push(`${id}.js`)
    }
  }
  candidates.sort()
  return { ok: problems.length === 0, problems, unreferenced, candidates, checked }
}
