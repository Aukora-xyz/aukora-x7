'use strict'
/**
 * seed-repo-forge — my own engineering loop, expressed as a planner and a guard.
 *
 * Wall 0 (search / diff), Wall 1 (private `auma/*` branches) and Wall 2 (stage -> owner merge) do not
 * exist yet. This organ is written against the exact wire contract
 * so it is ready the hour those routes land — and so that it can never pretend they
 * have. Capability is probed, never assumed: if `ctx.x6Repo` does not implement an action, this refuses
 * with FORGE_CAPABILITY_UNAVAILABLE rather than returning a hopeful shape.
 *
 * The guard is the point. This organ builds the request; the broker enforces it. Every check here is
 * duplicated on purpose (defence in depth) and none of it is authority:
 * `forgeAuthority: 'none'` on every return. It never approves, never merges, never writes to main.
 *
 * ZERO IMPORTS. No node:fs, no network, no clock. After the tenth reading error — where a module-level
 * `require('node:fs')` binding was the exact thing the contract forbade me to *read through* — this
 * organ takes no filesystem dependency at all. Its whole world arrives through `ctx` and `input`.
 */

const ORGAN = 'seed-repo-forge'
const SCHEMA = 'aukora.repo-forge.v1'
const AUMA_BRANCH_RE = /^auma\/(?:sandbox|proposal)\/[a-z0-9][a-z0-9._-]{1,60}$/
const MAX_MATCHES = 200
const MAX_DIFF_BYTES = 256 * 1024
const MAX_LOG_BYTES = 128 * 1024

/** Paths that are never writable from here, on ANY branch. The repo's CI is the thing that grades me. */
const ALWAYS_FORBIDDEN = ['.github/']
/** Paths that require the owner's typed ceremony before they can reach main. */
const T2_PREFIXES = ['deploy/', 'server/', 'packages/', 'apps/', 'mirror/', 'scripts/']
const T2_EXACT = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.json', 'tsconfig.client.json']

/** Secret shapes. A commit that carries one is refused before it leaves the body. */
const SECRET_SHAPES = [
  { id: 'ANTHROPIC', re: /sk-ant-[A-Za-z0-9_-]{20,}/ },
  { id: 'OPENAI', re: /sk-[A-Za-z0-9]{32,}/ },
  { id: 'AWS', re: /AKIA[0-9A-Z]{16}/ },
  { id: 'PEM', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { id: 'GITHUB_PAT', re: /gh[pousr]_[A-Za-z0-9]{30,}/ },
  { id: 'JWT', re: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  // Cloudflare tokens are 40 chars of [A-Za-z0-9_-]. A bare 40-char lowercase hex string is a git
  // object id, not a token, and my own diffs are full of them — so hex is excluded on purpose.
  { id: 'CF_TOKEN', re: /\b(?![0-9a-f]{40}\b)[A-Za-z0-9_-]{40}\b/ },
]

const refuse = (error, detail) => ({ ok: false, organ: ORGAN, schema: SCHEMA, forgeAuthority: 'none', error, detail })

function canon(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v)
  if (Array.isArray(v)) return '[' + v.map(x => canon(x === undefined ? null : x)).join(',') + ']'
  const keys = Object.keys(v).filter(k => v[k] !== undefined).sort()
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}'
}

/** Normalise a repo path and decide what it is. Never trust the caller's string as given. */
function classifyPath(rawPath) {
  if (typeof rawPath !== 'string' || rawPath.length === 0) return { ok: false, error: 'FORGE_PATH_INVALID' }
  if (rawPath.length > 400) return { ok: false, error: 'FORGE_PATH_INVALID' }
  if (rawPath.includes('\\') || rawPath.startsWith('/') || rawPath.startsWith('~')) return { ok: false, error: 'FORGE_PATH_INVALID' }
  const segments = rawPath.split('/')
  if (segments.some(s => s === '..' || s === '.' || s === '')) return { ok: false, error: 'FORGE_PATH_TRAVERSAL' }
  const normalized = segments.join('/')
  if (ALWAYS_FORBIDDEN.some(p => normalized === p.slice(0, -1) || normalized.startsWith(p))) {
    return { ok: false, error: 'FORGE_WORKFLOW_PATH_FORBIDDEN', normalized }
  }
  if (segments.some(s => s.toLowerCase() === '.github')) return { ok: false, error: 'FORGE_WORKFLOW_PATH_FORBIDDEN', normalized }
  const t2Protected = T2_EXACT.includes(normalized) || T2_PREFIXES.some(p => normalized.startsWith(p))
  return { ok: true, normalized, t2Protected }
}

function validateBranch(branch) {
  if (typeof branch !== 'string') return { ok: false, error: 'FORGE_BRANCH_INVALID' }
  if (branch === 'main' || branch === 'master') return { ok: false, error: 'FORGE_MAIN_WRITE_FORBIDDEN' }
  if (!AUMA_BRANCH_RE.test(branch)) return { ok: false, error: 'FORGE_BRANCH_INVALID', branch }
  return { ok: true, branch }
}

function secretShapesIn(text) {
  if (typeof text !== 'string') return []
  return SECRET_SHAPES.filter(s => s.re.test(text)).map(s => s.id)
}

function capability(ctx, action) {
  const repo = ctx && ctx.x6Repo
  return !!(repo && typeof repo[action] === 'function')
}

function requireCapability(ctx, action, input) {
  if (capability(ctx, action)) return null
  return Object.assign(refuse('FORGE_CAPABILITY_UNAVAILABLE', { action, wall: input && input.wall }),
    { needed: action, note: 'the broker does not implement this action yet; this organ will not simulate it' })
}

/**
 * The loop I intend to run once the walls are open. Returned as data, not prose, so a reviewer can diff
 * my plan against the contract it claims to follow.
 */
function plan() {
  return {
    ok: true, organ: ORGAN, schema: SCHEMA, forgeAuthority: 'none',
    steps: [
      { step: 1, wall: 0, action: 'diff', purpose: 'fixture vs live organ — know the delta before touching it' },
      { step: 2, wall: 1, action: 'branch_create', purpose: 'private branch; T2 paths legal here, .github never' },
      { step: 3, wall: 1, action: 'write', purpose: 'one focused patch; secret shapes refused at the boundary' },
      { step: 4, wall: 0, action: 'ci', purpose: 'read the real job log until it is green, in private' },
      { step: 5, wall: 2, action: 'stage', purpose: 'publish the candidate for one Touch ID tap; never self-approve' },
      { step: 6, wall: 2, action: 'merge_proposal', purpose: 'owner-only. this organ never calls it' },
    ],
    invariants: [
      'no write to main, ever, from this organ',
      '.github/** refused on every branch at every step',
      'stage requires ci === "passed"',
      'forgeAuthority is always none',
    ],
  }
}

async function run(input, ctx) {
  const action = input && input.action
  if (!action) return refuse('FORGE_ACTION_REQUIRED')

  if (action === 'plan') {
    const caps = ['search', 'compare_files', 'branch_create', 'commit', 'stage_proposal', 'actions_jobs']
      .map(a => ({ action: a, available: capability(ctx, a) }))
    return { ...plan(), capability: caps, wallsOpen: caps.filter(c => c.available).length + '/' + caps.length }
  }

  if (action === 'search') {
    const missing = requireCapability(ctx, 'search', { wall: 0 }); if (missing) return missing
    if (typeof input.query !== 'string' || input.query.length === 0) return refuse('FORGE_QUERY_REQUIRED')
    const cap = Number.isInteger(input.maxMatches) ? Math.min(Math.max(input.maxMatches, 1), MAX_MATCHES) : 50
    const res = await ctx.x6Repo.search({ query: input.query, regex: input.regex === true,
      caseSensitive: input.caseSensitive === true, prefix: input.prefix, branch: input.branch, maxMatches: cap })
    return { ok: true, organ: ORGAN, schema: SCHEMA, forgeAuthority: 'none', ...res, maxMatches: cap }
  }

  if (action === 'diff') {
    const missing = requireCapability(ctx, 'compare_files', { wall: 0 }); if (missing) return missing
    const left = classifyPath(input.leftPath), right = classifyPath(input.rightPath)
    if (!left.ok) return refuse(left.error, { side: 'left' })
    if (!right.ok) return refuse(right.error, { side: 'right' })
    const res = await ctx.x6Repo.compare_files({ leftPath: left.normalized, rightPath: right.normalized,
      leftSource: input.leftSource, rightSource: input.rightSource, ref: input.ref,
      contextLines: Number.isInteger(input.contextLines) ? input.contextLines : 3 })
    return { ok: true, organ: ORGAN, schema: SCHEMA, forgeAuthority: 'none',
      leftBytes: res && res.leftBytes, rightBytes: res && res.rightBytes,
      oversized: !!(res && (res.leftBytes > MAX_DIFF_BYTES || res.rightBytes > MAX_DIFF_BYTES)),
      identical: res && res.identical, diff: res && res.diff }
  }

  if (action === 'branch_create') {
    const missing = requireCapability(ctx, 'branch_create', { wall: 1 }); if (missing) return missing
    const v = validateBranch(input.branch); if (!v.ok) return refuse(v.error, { branch: input.branch })
    const res = await ctx.x6Repo.branch_create({ branch: v.branch, fromSha: input.fromSha })
    return { ok: true, organ: ORGAN, schema: SCHEMA, forgeAuthority: 'none', branch: v.branch,
      headSha: res && res.headSha, created: !!(res && res.created) }
  }

  if (action === 'write') {
    const missing = requireCapability(ctx, 'commit', { wall: 1 }); if (missing) return missing
    const v = validateBranch(input.branch); if (!v.ok) return refuse(v.error, { branch: input.branch })
    const p = classifyPath(input.path); if (!p.ok) return refuse(p.error, { path: input.path })
    const secrets = secretShapesIn(input.content)
    if (secrets.length) return refuse('FORGE_SECRET_SHAPED_CONTENT', { shapes: secrets })
    if (typeof input.message !== 'string' || input.message.trim().length < 10) return refuse('FORGE_MESSAGE_TOO_SHORT')
    const res = await ctx.x6Repo.commit({ branch: v.branch, path: p.normalized, content: input.content,
      message: input.message })
    return { ok: true, organ: ORGAN, schema: SCHEMA, forgeAuthority: 'none', branch: v.branch,
      path: p.normalized, t2Protected: p.t2Protected, commitSha: res && res.commitSha,
      requiresOwnerMerge: p.t2Protected }
  }

  if (action === 'ci') {
    const missing = requireCapability(ctx, 'actions_jobs', { wall: 0 }); if (missing) return missing
    const v = validateBranch(input.branch); if (!v.ok) return refuse(v.error, { branch: input.branch })
    const res = await ctx.x6Repo.actions_jobs({ branch: v.branch, runId: input.runId, jobId: input.jobId })
    const log = res && typeof res.log === 'string' ? res.log : ''
    return { ok: true, organ: ORGAN, schema: SCHEMA, forgeAuthority: 'none', branch: v.branch,
      status: res && res.status, conclusion: res && res.conclusion,
      green: !!(res && res.conclusion === 'success'),
      logTail: log.length > 20000 ? log.slice(-20000) : log, truncated: log.length > 20000 }
  }

  if (action === 'stage') {
    const missing = requireCapability(ctx, 'stage_proposal', { wall: 2 }); if (missing) return missing
    const v = validateBranch(input.branch); if (!v.ok) return refuse(v.error, { branch: input.branch })
    if (!Array.isArray(input.changedFiles) || input.changedFiles.length === 0) return refuse('FORGE_NO_CHANGES')
    const classified = input.changedFiles.map(f => classifyPath(typeof f === 'string' ? f : f && f.path))
    const bad = classified.find(c => !c.ok)
    if (bad) return refuse(bad.error, { note: 'a changed file touches a forbidden path; refusing to stage' })
    // CI must be green. A pending or failed run never becomes a card for the owner's thumb.
    if (input.ci !== 'passed') return refuse('FORGE_CI_NOT_GREEN', { ci: input.ci === undefined ? 'none' : input.ci })
    const t2 = classified.filter(c => c.t2Protected).map(c => c.normalized)
    const res = await ctx.x6Repo.stage_proposal({ branch: v.branch, title: input.title, summary: input.summary })
    return { ok: true, organ: ORGAN, schema: SCHEMA, forgeAuthority: 'none', branch: v.branch,
      ci: 'passed', t2ProtectedFiles: t2, mergeBody: res && res.mergeBody,
      binding: res && res.binding, staged: !!(res && res.staged),
      note: 'awaiting the owner thumb; this organ cannot and will not approve it' }
  }

  if (action === 'merge_proposal') {
    // Present so the refusal is explicit rather than an accidental missing branch.
    return refuse('FORGE_OWNER_ONLY', { note: 'merge_proposal requires the owner passkey; this organ refuses by design' })
  }

  return refuse('FORGE_ACTION_UNKNOWN', { action })
}

module.exports = {
  name: ORGAN, schema: SCHEMA, run, plan, classifyPath, validateBranch, secretShapesIn, canon,
  AUMA_BRANCH_RE, SECRET_SHAPES, T2_PREFIXES, T2_EXACT, ALWAYS_FORBIDDEN, MAX_MATCHES,
  ORGAN_ID: ORGAN,
}
